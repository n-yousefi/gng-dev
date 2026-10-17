const els = {
  refreshButton: document.getElementById("refreshButton"),
  selectedElementButton: document.getElementById("selectedElementButton"),
  inspectPickerButton: document.getElementById("inspectPickerButton"),
  searchInput: document.getElementById("searchInput"),
  indexRefreshButton: document.getElementById("indexRefreshButton"),
  indexMeta: document.getElementById("indexMeta"),
  filterButtons: Array.from(document.querySelectorAll(".filter-button")),
  highlightToggle: document.getElementById("highlightToggle"),
  statusText: document.getElementById("statusText"),
  toast: document.getElementById("toast"),
  componentCount: document.getElementById("componentCount"),
  changeSummary: document.getElementById("changeSummary"),
  clearFocusButton: document.getElementById("clearFocusButton"),
  treePaneTitle: document.getElementById("treePaneTitle"),
  sourceScopeButton: document.getElementById("sourceScopeButton"),
  sourceNotice: document.getElementById("sourceNotice"),
  pinnedPane: document.getElementById("pinnedPane"),
  pinnedList: document.getElementById("pinnedList"),
  treeRoot: document.getElementById("treeRoot"),
  detailsModalBackdrop: document.getElementById("detailsModalBackdrop"),
  closeDetailsButton: document.getElementById("closeDetailsButton"),
  emptyDetails: document.getElementById("emptyDetails"),
  detailsContent: document.getElementById("detailsContent"),
  detailsTitle: document.getElementById("detailsTitle"),
  detailsBadges: document.getElementById("detailsBadges"),
  detailsActions: document.getElementById("detailsActions"),
  tabs: Array.from(document.querySelectorAll(".tab")),
  tabPanels: Array.from(document.querySelectorAll(".tab-panel")),
  contextMenu: document.getElementById("contextMenu"),
};

const NATIVE_HOST_NAME = "com.gng.dev_indexer";
const LOCAL_INDEX_FILE = "component-index.json";
const INDEX_UPDATED_STORAGE_KEY = "gigComponentInspector.indexUpdatedAt";
const AUTO_REFRESH_DELAY_MS = 600;
const BRIDGE_VERSION = 6;
const FIELD_INDEX_SCHEMA_VERSION = 3;
const MUTATION_POLL_INTERVAL_MS = 1000;
const MIN_AUTO_SCAN_INTERVAL_MS = 2000;
const SEARCH_DEBOUNCE_MS = 120;
const DEFAULT_SCAN_PREFIXES = ["sl-", "sales-", "gsm-", "gig-", "gng-", "app-"];

const state = {
  bridgeInjected: false,
  scan: null,
  flatById: new Map(),
  selectedId: null,
  sourceIndex: new Map(),
  columnServices: [],
  indexSchemaVersion: 1,
  scanPrefixes: DEFAULT_SCAN_PREFIXES,
  scanSelectors: [],
  loadedIndexCount: 0,
  projectName: "",
  projectId: "",
  projectRoot: "",
  ownerFilter: "all",
  collapsedIds: new Set(),
  focusRootId: null,
  parentById: new Map(),
  sourceParentById: new Map(),
  rawFieldToVirtualId: new Map(),
  sourceTree: [],
  virtualIds: new Set(),
  activeModalId: null,
  activeModalSignature: "",
  sourceSuppressedModalId: null,
  sourceAutoSelectId: null,
  sourceOwnerId: null,
  pins: new Map(),
  scanDiff: null,
  highlightEnabled: true,
  indexUpdatedAt: localStorage.getItem(INDEX_UPDATED_STORAGE_KEY) || "",
  scanSummary: "",
  refreshInFlight: false,
  refreshQueued: false,
  autoRefreshTimeoutId: null,
  mutationPollTimeoutId: null,
  searchTimeoutId: null,
  panelVisible: !document.hidden,
  lastMutationVersion: null,
  lastModalSignature: "",
  lastScanStartedAt: 0,
  detailsInFlight: new Map(),
  activationInFlight: null,
  contextMenuNodeId: null,
  inspectPickerActive: false,
  detailsPopupOpen: false,
};

init();

async function init() {
  bindEvents();
  await loadLocalIndex();
  await loadPreferences();
  if (state.panelVisible) activatePanel();
}

async function activatePanel() {
  state.panelVisible = true;
  if (state.activationInFlight) return state.activationInFlight;

  state.activationInFlight = (async () => {
    try {
      await ensureBridge();
      if (!state.panelVisible) return;
      await evalInInspectedPage("window.__gigComponentInspector.setWatching(true)");
      if (!state.panelVisible) return;
      startMutationPoller();
      const pending = await getPendingContextInspect();
      if (pending) selectLastRightClickedComponent();
      else if (!state.scan) refresh();
      else scheduleRefresh(150);
    } catch (_error) {
      state.bridgeInjected = false;
    } finally {
      state.activationInFlight = null;
    }
  })();

  return state.activationInFlight;
}

async function deactivatePanel() {
  state.panelVisible = false;
  clearTimeout(state.mutationPollTimeoutId);
  clearTimeout(state.autoRefreshTimeoutId);
  state.mutationPollTimeoutId = null;
  state.autoRefreshTimeoutId = null;
  try {
    await evalInInspectedPage("window.__gigComponentInspector?.setWatching(false)");
  } catch (_error) {}
}

function startMutationPoller() {
  clearTimeout(state.mutationPollTimeoutId);
  state.mutationPollTimeoutId = setTimeout(pollMutationState, MUTATION_POLL_INTERVAL_MS);
}

async function pollMutationState() {
  if (!state.panelVisible || state.refreshInFlight) {
    if (state.panelVisible) startMutationPoller();
    return;
  }

  try {
    const mutationState = await evalInInspectedPage("window.__gigComponentInspector?.getMutationState()");
    if (!mutationState?.watching) {
      await evalInInspectedPage("window.__gigComponentInspector?.setWatching(true)");
    }
    if (state.lastMutationVersion == null) {
      state.lastMutationVersion = mutationState?.mutationVersion ?? 0;
      state.lastModalSignature = mutationState?.modalSignature || "";
    } else if (
      (mutationState?.mutationVersion ?? state.lastMutationVersion) !== state.lastMutationVersion ||
      (mutationState?.modalSignature || "") !== state.lastModalSignature
    ) {
      state.lastMutationVersion = mutationState.mutationVersion;
      state.lastModalSignature = mutationState?.modalSignature || "";
      const elapsed = performance.now() - state.lastScanStartedAt;
      scheduleRefresh(Math.max(150, MIN_AUTO_SCAN_INTERVAL_MS - elapsed));
    }
  } catch (_error) {
    state.bridgeInjected = false;
  } finally {
    if (state.panelVisible) startMutationPoller();
  }
}

function bindEvents() {
  window.addEventListener("message", event => {
    if (event.source !== window || event.data?.type !== "gig-panel-visibility") return;
    if (event.data.visible) activatePanel();
    else deactivatePanel();
  });
  window.addEventListener("unload", () => deactivatePanel());
  els.highlightToggle.checked = state.highlightEnabled;
  syncFilterButtons();
  els.refreshButton.addEventListener("click", () => refresh());
  els.inspectPickerButton?.addEventListener("click", () => toggleInspectPicker());
  els.searchInput.addEventListener("input", () => handleSearchChanged());
  els.indexRefreshButton.addEventListener("click", () => rebuildIndexWithNativeHost());
  els.clearFocusButton.addEventListener("click", () => clearTreeFocus());
  els.sourceScopeButton.addEventListener("click", toggleSourceScope);
  els.closeDetailsButton?.addEventListener("click", () => closeDetailsPopup());
  els.detailsModalBackdrop?.addEventListener("click", (event) => {
    if (event.target === els.detailsModalBackdrop) closeDetailsPopup();
  });
  document.addEventListener("keydown", (event) => {
    if (event.key === "Escape" && state.detailsPopupOpen) {
      closeDetailsPopup();
    }
  });
  els.highlightToggle.addEventListener("change", () => {
    setPageHighlightEnabled(els.highlightToggle.checked);
    savePreferences();
  });
  for (const button of els.filterButtons) {
    button.addEventListener("click", () => {
      state.ownerFilter = button.dataset.filter || "all";
      syncFilterButtons();
      if (state.ownerFilter === "components" && state.scan) {
        buildSourceTree();
      }
      renderTree(state.scan?.tree || []);
      syncSelectionWithActiveFilter();
      savePreferences();
    });
  }
  els.detailsContent.addEventListener("click", handleDetailsClick);
  els.treeRoot.addEventListener("click", handleTreeClick);
  els.treeRoot.addEventListener("dblclick", handleTreeDoubleClick);
  els.treeRoot.addEventListener("mouseover", handleTreeMouseOver);
  els.treeRoot.addEventListener("mouseout", handleTreeMouseOut);
  els.treeRoot.addEventListener("contextmenu", handleTreeContextMenu);
  document.addEventListener("click", hideContextMenu);
  els.contextMenu.addEventListener("click", async (event) => {
    const action = event.target.closest("[data-action]")?.dataset.action;
    const node = state.flatById.get(state.contextMenuNodeId);
    hideContextMenu();
    if (action !== "copySubTree" || !node) return;
    await copyText(buildNodeTreeText(node));
    setStatus(`Copied ${node.selector} subtree.`);
  });
  chrome.runtime?.onMessage?.addListener((message) => {
    if (message?.type === "gig-context-inspect") {
      getPendingContextInspect().finally(() => selectLastRightClickedComponent());
    }
  });
  // Navigation is relayed from background.js via tabs.onUpdated (replaces chrome.devtools.network.onNavigated).
  // The 'gig-tab-navigated' message is sent by background.js when the active tab finishes loading.
  chrome.runtime?.onMessage?.addListener((message) => {
    if (message?.type === "gig-tab-navigated") {
      state.bridgeInjected = false;
      state.lastMutationVersion = null;
      state.lastModalSignature = "";
      state.sourceSuppressedModalId = null;
      loadLocalIndex().then(() => loadPreferences()).then(() => scheduleRefresh(AUTO_REFRESH_DELAY_MS));
    }
  });
  document.addEventListener("visibilitychange", () => {
    if (document.hidden) deactivatePanel();
    else activatePanel();
  });

  for (const tab of els.tabs) {
    tab.addEventListener("click", () => activateTab(tab.dataset.tab));
  }
}

function getTreeNodeFromEvent(event) {
  const row = event.target.closest(".tree-node");
  if (!row || !els.treeRoot.contains(row)) return null;
  return state.flatById.get(row.dataset.id) || null;
}

function handleTreeClick(event) {
  const node = getTreeNodeFromEvent(event);
  if (!node) return;
  event.stopPropagation();

  const action = event.target.closest("[data-tree-action]")?.dataset.treeAction;
  if (action === "toggle") return toggleTreeNode(node.id);
  if (action === "copy-ai" || action === "copy-path") {
    const aiText = buildAiAgentCopyText(node);
    copyText(aiText);
    const summaryLabel = node.fieldInfo?.name || node.selector;
    showToast(`Copied AI context for ${summaryLabel}`);
    return setStatus(`Copied AI location context for ${summaryLabel}.`);
  }
  if (action === "copy-file") {
    const fileName = getComponentFileName(getNodeSource(node));
    copyText(fileName);
    return setStatus(`Copied ${fileName}.`);
  }
  selectNode(node.id, { keepHighlight: node.isVirtual && !getHighlightTargetId(node), openPopup: true });
}

function handleTreeDoubleClick(event) {
  const node = getTreeNodeFromEvent(event);
  const targetId = getHighlightTargetId(node);
  if (targetId) inspectNode(targetId);
}

function handleTreeContextMenu(event) {
  const node = getTreeNodeFromEvent(event);
  if (!node) return;
  event.preventDefault();
  event.stopPropagation();
  state.contextMenuNodeId = node.id;
  els.contextMenu.classList.remove("hidden");
  const bounds = els.contextMenu.getBoundingClientRect();
  const left = Math.min(event.clientX, Math.max(4, window.innerWidth - bounds.width - 4));
  const top = Math.min(event.clientY, Math.max(4, window.innerHeight - bounds.height - 4));
  els.contextMenu.style.left = `${left}px`;
  els.contextMenu.style.top = `${top}px`;
}

function hideContextMenu() {
  els.contextMenu.classList.add("hidden");
  state.contextMenuNodeId = null;
}

function buildNodeTreeText(node, depth = 0) {
  const source = getNodeSource(node);
  const label = [node.selector, node.componentClassName || source.className].filter(Boolean).join(" - ");
  const current = `${"  ".repeat(depth)}${label}`;
  const children = (node.children || []).map(child => buildNodeTreeText(child, depth + 1));
  return [current, ...children].join("\n");
}

function handleTreeMouseOver(event) {
  const row = event.target.closest(".tree-node");
  if (!row || row.contains(event.relatedTarget)) return;
  const node = state.flatById.get(row.dataset.id);
  const targetId = getHighlightTargetId(node);
  if (targetId) highlightNodeOnPage(targetId, { durationMs: 0 });
}

function handleTreeMouseOut(event) {
  const row = event.target.closest(".tree-node");
  if (!row || row.contains(event.relatedTarget)) return;
  const node = state.flatById.get(row.dataset.id);
  if (getHighlightTargetId(node)) clearPageHighlight();
}

function handleSearchChanged() {
  clearTimeout(state.searchTimeoutId);
  state.searchTimeoutId = setTimeout(applyTreeFilters, SEARCH_DEBOUNCE_MS);
}

function syncFilterButtons() {
  for (const button of els.filterButtons) {
    button.classList.toggle("active", button.dataset.filter === state.ownerFilter);
  }
}

async function loadLocalIndex() {
  try {
    setIndexButtonState("loading");
    setStatus("Loading component index...");
    const nativeManifest = await loadIndexFromNativeHost();
    const manifest = nativeManifest || await window.GIGSourceLoader.loadBundledManifest();
    const loaded = applyIndexManifest(manifest);
    if (!loaded) return false;

    refreshSourceDependentViews();
    return true;
  } catch (error) {
    clearIndexState();
    setIndexButtonState("missing");
    setStatus(`Could not load component index: ${error.message}`, true);
    return false;
  }
}

function clearIndexState() {
  state.sourceIndex = new Map();
  state.columnServices = [];
  state.indexSchemaVersion = 1;
  state.sourceTree = [];
  state.scanPrefixes = DEFAULT_SCAN_PREFIXES;
  state.scanSelectors = [];
  state.loadedIndexCount = 0;
  state.projectName = "";
  state.projectId = "";
  state.projectRoot = "";
  updateIndexMeta();
}

function normalizeIndexManifest(value, project = {}) {
  const source = value || {};
  const entries = Array.isArray(source) ? source : source.entries || source.components || [];
  return {
    entries,
    projectId: project.id || source.projectId || project.name || source.projectName || "",
    projectName: project.name || source.projectName || "",
    projectRoot: Array.isArray(source) ? "" : normalizePath(source.projectRoot || project.clientAppRoot || ""),
    generatedAt: Array.isArray(source) ? "" : source.generatedAt || "",
    schemaVersion: Array.isArray(source) ? 1 : Number(source.schemaVersion) || 1,
  };
}

function applyIndexManifest(value, project = {}) {
  const manifest = normalizeIndexManifest(value, project);
  if (!manifest.entries.length) {
    clearIndexState();
    setIndexButtonState("missing");
    setStatus("Component index is missing. Click refresh index to create it.", true);
    return false;
  }

  const indexResult = window.GIGSourceLoader.createIndex(manifest.entries);
  state.sourceIndex = indexResult instanceof Map ? indexResult : indexResult.bySelector;
  state.columnServices = indexResult.columnServices || [];
  state.indexSchemaVersion = manifest.schemaVersion;
  state.scanPrefixes = DEFAULT_SCAN_PREFIXES;
  state.scanSelectors = getScanSelectors(manifest.entries);
  state.loadedIndexCount = manifest.entries.filter(entry => entry?.selector).length;
  state.projectId = manifest.projectId;
  state.projectName = manifest.projectName;
  state.projectRoot = manifest.projectRoot;
  state.indexUpdatedAt = manifest.generatedAt || state.indexUpdatedAt || "";
  if (state.indexUpdatedAt) localStorage.setItem(INDEX_UPDATED_STORAGE_KEY, state.indexUpdatedAt);
  updateIndexMeta();
  setIndexButtonState("ready");
  setStatus(`Loaded ${state.loadedIndexCount} indexed components${manifest.projectName ? ` for ${manifest.projectName}` : ""}.`);
  if (state.bridgeInjected) configureBridge().catch(() => {
    state.bridgeInjected = false;
  });
  return true;
}

function getPreferencesStorageKey() {
  const identity = state.projectId || state.projectName || state.projectRoot || "default";
  return `gigComponentInspector.preferences.${identity.toLowerCase().replace(/[^a-z0-9._-]+/g, "-")}`;
}

async function loadPreferences() {
  state.ownerFilter = "all";
  state.highlightEnabled = true;
  state.pins = new Map();
  try {
    const key = getPreferencesStorageKey();
    const values = await chrome.storage.local.get(key);
    const preferences = values[key] || {};
    if (["all", "components", "gng"].includes(preferences.ownerFilter)) {
      state.ownerFilter = preferences.ownerFilter;
    }
    if (typeof preferences.highlightEnabled === "boolean") {
      state.highlightEnabled = preferences.highlightEnabled;
    }
    for (const pin of preferences.pins || []) {
      if (pin?.key) state.pins.set(pin.key, pin);
    }
  } catch (_error) {
    // Storage is a convenience; the component finder remains usable if it is unavailable.
  }
  els.highlightToggle.checked = state.highlightEnabled;
  syncFilterButtons();
  renderPins();
  if (state.scan) {
    buildSourceTree();
    renderTree(state.scan.tree);
  }
  if (state.bridgeInjected) setPageHighlightEnabled(state.highlightEnabled);
}

async function savePreferences() {
  try {
    const key = getPreferencesStorageKey();
    await chrome.storage.local.set({
      [key]: {
        ownerFilter: state.ownerFilter,
        highlightEnabled: state.highlightEnabled,
        pins: Array.from(state.pins.values()),
      },
    });
  } catch (_error) {
    // Do not interrupt inspection for a preference-storage failure.
  }
}

async function loadIndexFromNativeHost() {
  try {
    const pageUrl = await getInspectedPageUrl();
    const result = await sendNativeMessage({ type: "getIndex", pageUrl });
    if (!result?.ok) throw new Error(result?.error || "Native host could not load the project index.");
    return normalizeIndexManifest(result.index, result.project);
  } catch (_error) {
    return null;
  }
}

function isNativeUnavailableError(error) {
  const message = String(error?.message || error || "").toLowerCase();
  return (
    message.includes("native messaging is not available") ||
    message.includes("native messaging host not found") ||
    message.includes("specified native messaging host not found") ||
    message.includes("error when communicating with the native messaging host")
  );
}

async function rebuildIndexWithNativeHost() {
  try {
    setIndexButtonState("loading");
    setStatus("Rebuilding index...");
    els.indexRefreshButton.disabled = true;
    const pageUrl = await getInspectedPageUrl();
    const result = await sendNativeMessage({ type: "rebuildIndex", pageUrl });
    if (!result?.ok) throw new Error(result?.error || "Native host failed to rebuild the index.");

    if (!applyIndexManifest(result.index, result.project)) {
      throw new Error(`Index was rebuilt but no components were loaded.`);
    }
    if (state.bridgeInjected) {
      await configureBridge().catch(() => { state.bridgeInjected = false; });
    }
    if (state.scan) {
      refreshSourceDependentViews();
    } else {
      await refresh();
    }
    showToast(`Index refreshed. Loaded ${state.loadedIndexCount} components${state.projectName ? ` for ${state.projectName}` : ""}.`);
  } catch (error) {
    setIndexButtonState("error");
    setStatus(`Could not rebuild index: ${error.message}`, true);
    showToast(`Could not refresh index: ${error.message}`, true);
  } finally {
    els.indexRefreshButton.disabled = false;
  }
}

function sendNativeMessage(message) {
  return new Promise((resolve, reject) => {
    if (!chrome.runtime?.sendNativeMessage) {
      reject(new Error("Native messaging is not available in this extension context."));
      return;
    }

    chrome.runtime.sendNativeMessage(NATIVE_HOST_NAME, message, (response) => {
      const error = chrome.runtime.lastError;
      if (error) {
        reject(new Error(error.message));
        return;
      }
      resolve(response);
    });
  });
}

function getActiveTabId() {
  return getWindowId().then((windowId) => new Promise((resolve) => {
    const query = windowId ? { active: true, windowId } : { active: true, lastFocusedWindow: true };
    chrome.tabs.query(query, (tabs) => resolve(tabs?.[0]?.id ?? null));
  }));
}

async function getPendingContextInspect() {
  const tabId = await getActiveTabId();
  if (!tabId || !chrome.runtime?.sendMessage) return false;
  return new Promise((resolve) => {
    chrome.runtime.sendMessage({ type: "gig-panel-ready", tabId }, (response) => {
      if (chrome.runtime.lastError) { resolve(false); return; }
      resolve(Boolean(response?.hasPendingContextInspect));
    });
  });
}

async function getInspectedPageUrl() {
  try {
    const windowId = await getWindowId();
    const query = windowId ? { active: true, windowId } : { active: true, lastFocusedWindow: true };
    const tabs = await new Promise((resolve) => chrome.tabs.query(query, resolve));
    const tabUrl = tabs?.[0]?.url || "";
    if (tabUrl && !tabUrl.startsWith("chrome://") && !tabUrl.startsWith("devtools://")) {
      return tabUrl;
    }
  } catch (_err) {}
  return evalInInspectedPage("location.href").catch(() => "");
}

async function setPageHighlightEnabled(enabled) {
  state.highlightEnabled = Boolean(enabled);
  try {
    await ensureBridge();
    await evalInInspectedPage(`window.__gigComponentInspector.setHighlightEnabled(${JSON.stringify(state.highlightEnabled)})`);
    if (state.highlightEnabled && state.selectedId) {
      highlightNodeOnPage(state.selectedId);
    }
  } catch (error) {
    setStatus(error.message || String(error), true);
  }
}

function getHighlightTargetId(nodeOrId) {
  const node = typeof nodeOrId === "object" ? nodeOrId : state.flatById.get(nodeOrId);
  if (!node) return typeof nodeOrId === "string" ? nodeOrId : null;
  if (!node.isVirtual) return node.id;
  return node.rawNodeId || node.sourceTrail?.contentId || node.sourceTrail?.modalId || null;
}

async function highlightNodeOnPage(id, options = {}) {
  const targetId = getHighlightTargetId(id);
  if (!state.highlightEnabled || !targetId) return;
  try {
    await ensureBridge();
    const result = await evalInInspectedPage(`window.__gigComponentInspector.highlightElementById(${JSON.stringify(targetId)}, ${JSON.stringify(options)})`);
    if (!result?.ok) throw new Error(result?.message || "Could not highlight element.");
  } catch (error) {
    setStatus(error.message || String(error), true);
  }
}

async function clearPageHighlight() {
  try {
    await ensureBridge();
    await evalInInspectedPage("window.__gigComponentInspector.clearHighlight()");
  } catch (_error) {
    // Losing the inspected-page overlay is non-critical while the user is moving through the tree.
  }
}

function buildTreeFromFlat(flatNodes) {
  const nodesById = new Map();
  const roots = [];

  for (const rawNode of flatNodes || []) {
    const previous = state.flatById.get(rawNode.id);
    const node = {
      ...rawNode,
      attributes: previous?.detailsLoaded ? previous.attributes : {},
      classes: previous?.detailsLoaded ? previous.classes : [],
      elementPath: previous?.detailsLoaded ? previous.elementPath : "",
      domPreview: previous?.detailsLoaded ? previous.domPreview : "",
      hasAngularDebugApi: previous?.detailsLoaded ? previous.hasAngularDebugApi : false,
      detailsLoaded: Boolean(previous?.detailsLoaded),
      childIds: [],
      children: [],
    };
    nodesById.set(node.id, node);
  }

  for (const node of nodesById.values()) {
    const parent = node.parentId ? nodesById.get(node.parentId) : null;
    if (parent) {
      parent.childIds.push(node.id);
      parent.children.push(node);
    } else {
      roots.push(node);
    }
  }

  return { roots, nodesById };
}

function clearVirtualNodes() {
  for (const id of state.virtualIds) {
    state.flatById.delete(id);
    state.parentById.delete(id);
  }
  state.virtualIds = new Set();
  state.sourceParentById = new Map();
  state.rawFieldToVirtualId = new Map();
  state.sourceAutoSelectId = null;
  state.sourceOwnerId = null;
}

function cloneSourceTreeNode(node) {
  return {
    ...node,
    childIds: [],
    children: [],
  };
}

function registerVirtualNode(node) {
  const virtualNode = {
    kind: "source",
    childIds: [],
    children: [],
    attributes: {},
    classes: [],
    detailsLoaded: true,
    ...node,
    isVirtual: true,
  };
  state.virtualIds.add(virtualNode.id);
  state.flatById.set(virtualNode.id, virtualNode);
  state.parentById.set(virtualNode.id, virtualNode.parentId || null);
  state.sourceParentById.set(virtualNode.id, virtualNode.parentId || null);
  prepareNodeSearchText(virtualNode);
  return virtualNode;
}

function findFirstDescendant(node, predicate) {
  const pending = [...(node?.children || [])];
  while (pending.length) {
    const current = pending.shift();
    if (predicate(current)) return current;
    pending.unshift(...(current.children || []));
  }
  return null;
}

function collectDescendants(node, predicate) {
  const result = [];
  const pending = [...(node?.children || [])];
  while (pending.length) {
    const current = pending.shift();
    if (predicate(current)) result.push(current);
    pending.push(...(current.children || []));
  }
  return result;
}

function buildCompactSourceTree() {
  const rawNodes = Array.from(state.flatById.values()).filter(node => !node.isVirtual && isIndexedComponent(node));
  const clones = new Map(rawNodes.map(node => [node.id, cloneSourceTreeNode(node)]));
  const roots = [];

  for (const node of rawNodes) {
    const clone = clones.get(node.id);
    let parentId = state.parentById.get(node.id);
    while (parentId && !clones.has(parentId)) parentId = state.parentById.get(parentId);
    const parent = parentId ? clones.get(parentId) : null;
    if (parent) {
      clone.parentId = parent.id;
      parent.children.push(clone);
      parent.childIds.push(clone.id);
      state.sourceParentById.set(clone.id, parent.id);
    } else {
      clone.parentId = null;
      roots.push(clone);
      state.sourceParentById.set(clone.id, null);
    }
  }

  return roots;
}

function findOwnDynamicForm(rootNode, activeModalId) {
  const pending = [...(rootNode?.children || [])];
  while (pending.length) {
    const current = pending.shift();
    if (current.selector === "app-dynamic-form") return current;
    if (
      current.id !== activeModalId &&
      (current.modalInfo || current.selector === "gig-crud-table" || current.selector === "app-modal-edit-form")
    ) {
      continue;
    }
    pending.unshift(...(current.children || []));
  }
  return null;
}

function getDynamicFormContext(activeModal) {
  const ancestors = getComponentAncestors(activeModal.id);
  const generatedWrapper = [...ancestors].reverse().find(node => node.selector === "app-modal-edit-form") || null;
  const ancestorDynamicForm = [...ancestors].reverse().find(node => node.selector === "app-dynamic-form") || null;
  const dynamicForm = ancestorDynamicForm || findOwnDynamicForm(
    generatedWrapper || activeModal,
    activeModal.id,
  );
  if (!generatedWrapper && !dynamicForm) return null;

  const owner = getNearestIndexedComponent((generatedWrapper || dynamicForm).id);
  if (!owner) return null;
  const activeField = [...ancestors].reverse().find(node => node.fieldInfo?.name) || null;
  return { generatedWrapper, dynamicForm, owner, activeField };
}

function mergeRenderedFieldLabels(dynamicForm, fields) {
  const renderedByName = new Map();
  const rawNodeByName = new Map();
  for (const node of collectDescendants(dynamicForm, item => Boolean(item.fieldInfo?.name))) {
    if (!renderedByName.has(node.fieldInfo.name) || node.fieldInfo.label) {
      renderedByName.set(node.fieldInfo.name, node.fieldInfo);
    }
    if (!rawNodeByName.has(node.fieldInfo.name)) {
      rawNodeByName.set(node.fieldInfo.name, node);
    }
  }
  return (fields || []).map(field => ({
    ...field,
    ...(renderedByName.get(field.name) || {}),
    rawNodeId: rawNodeByName.get(field.name)?.id || null,
  }));
}

function createSourceResult(source, candidates = []) {
  const usableCandidates = (candidates || []).filter(candidate => candidate?.componentTs || candidate?.templateUrl);
  if (source?.componentTs || source?.templateUrl) {
    return { found: true, source, candidates: usableCandidates, ambiguous: false };
  }
  return {
    found: false,
    source: source || { selectorFamily: "created", componentTs: "", templateUrl: "" },
    candidates: usableCandidates,
    ambiguous: usableCandidates.length > 1,
    message: usableCandidates.length ? `${usableCandidates.length} source candidates found.` : "No source index entry found.",
  };
}

function getPrimaryColumnService(ownerSource, services) {
  const configured = new Set((ownerSource?.relatedColumnServices || []).map(normalizePath));
  const explicit = (services || []).filter(service => configured.has(normalizePath(service.componentTs)));
  if (explicit.length === 1) return explicit[0];
  return services?.length === 1 ? services[0] : null;
}

function buildGeneratedModalSourceTree(activeModal, context) {
  const ownerClone = cloneSourceTreeNode(context.owner);
  ownerClone.parentId = null;
  state.sourceParentById.set(ownerClone.id, null);
  const ownerSource = getNodeSource(context.owner);
  const relatedServices = window.GIGSourceLoader.findRelatedColumnServices(ownerSource, state.columnServices);
  const modalTitle = activeModal.modalInfo?.title || activeModal.runtimeTitle || "Generated CRUD form";
  const mode = context.generatedWrapper?.generatedFormInfo?.mode || context.dynamicForm?.dynamicFormInfo?.mode || "Edit";
  const formId = `source-form:${activeModal.id}`;
  const formSource = getPrimaryColumnService(ownerSource, relatedServices);
  const formNode = registerVirtualNode({
    id: formId,
    parentId: ownerClone.id,
    rawNodeId: context.dynamicForm?.id || activeModal.id,
    selector: "Generated CRUD form",
    displayName: "Generated CRUD form",
    componentClassName: mode,
    runtimeTitle: modalTitle,
    runtimeTitleKey: activeModal.modalInfo?.titleKey || activeModal.runtimeTitleKey || "",
    virtualType: "generated-form",
    kind: "source-form",
    sourceResult: createSourceResult(formSource, relatedServices),
    sourceTrail: {
      type: "generated-form",
      ownerId: context.owner.id,
      modalId: activeModal.id,
      mode,
      title: modalTitle,
      titleKey: activeModal.modalInfo?.titleKey || activeModal.runtimeTitleKey || "",
      generationChain: ["gig-crud-table", "app-modal-edit-form", "app-dynamic-form"],
      services: relatedServices,
    },
  });

  ownerClone.children.push(formNode);
  ownerClone.childIds.push(formNode.id);
  state.sourceOwnerId = ownerClone.id;
  state.sourceAutoSelectId = formNode.id;

  const fields = mergeRenderedFieldLabels(
    context.dynamicForm,
    context.dynamicForm?.dynamicFormInfo?.fields || [],
  );
  const seenNames = new Set();
  for (const field of fields) {
    if (!field.name || seenNames.has(field.name)) continue;
    seenNames.add(field.name);
    const mapping = window.GIGSourceLoader.findFieldSources(ownerSource, state.columnServices, field.name);
    const exactSource = mapping.exact.length === 1 ? mapping.exact[0] : null;
    const fallbackSource = !mapping.exact.length ? getPrimaryColumnService(ownerSource, mapping.services) : null;
    const fieldId = `source-field:${activeModal.id}:${field.name}`;
    const fieldNode = registerVirtualNode({
      id: fieldId,
      parentId: formNode.id,
      rawNodeId: field.rawNodeId || null,
      selector: field.name,
      displayName: field.name,
      componentClassName: field.type || "field",
      runtimeTitle: field.label || field.i18nName || "",
      virtualType: "field",
      kind: "source-field",
      fieldInfo: field,
      sourceResult: createSourceResult(exactSource || fallbackSource, mapping.exact.length > 1 ? mapping.exact : mapping.services),
      sourceTrail: {
        type: "field",
        ownerId: context.owner.id,
        formId,
        field,
        exact: Boolean(exactSource),
        exactMatches: mapping.exact,
        services: mapping.services,
      },
    });
    if (field.rawNodeId) state.rawFieldToVirtualId.set(field.rawNodeId, fieldId);
    formNode.children.push(fieldNode);
    formNode.childIds.push(fieldNode.id);
    if (context.activeField?.fieldInfo?.name === field.name) state.sourceAutoSelectId = fieldNode.id;
  }

  return [ownerClone];
}

function findPageOwnerForDetachedModal(activeModal, contentComponent) {
  const modalDescendantIds = new Set([
    activeModal.id,
    ...collectDescendants(activeModal, () => true).map(node => node.id),
  ]);
  const contentSource = contentComponent ? getNodeSource(contentComponent) : {};
  const contentPath = contentSource.componentTs || "";

  let bestNode = null;
  let bestScore = -1;
  for (const node of state.flatById.values()) {
    if (node.isVirtual || modalDescendantIds.has(node.id)) continue;
    if (node.insideMatDialog) continue;
    if (!isIndexedComponent(node)) continue;
    const nodeSource = getNodeSource(node);
    if (!nodeSource.componentTs) continue;
    const shared = contentPath ? sharedDirectoryPrefixDepth(contentPath, nodeSource.componentTs) : 0;
    const depth = getComponentAncestors(node.id).length;
    const score = shared * 100 + depth;
    if (score > bestScore) {
      bestScore = score;
      bestNode = node;
    }
  }
  return bestNode;
}

function appendCustomModalSubtree(rawParent, targetParentClone, currentIndexedOwner, activeModalId) {
  for (const child of rawParent?.children || []) {
    if (
      child.id !== activeModalId &&
      ((child.modalInfo && !child.modalInfo.visible) || child.selector === "app-modal-edit-form")
    ) {
      continue;
    }

    if (isIndexedComponent(child)) {
      const childClone = cloneSourceTreeNode(child);
      childClone.parentId = targetParentClone.id;
      if (child.fieldInfo?.name && !childClone.runtimeTitle) {
        childClone.runtimeTitle = child.fieldInfo.label || child.fieldInfo.name;
      }
      targetParentClone.children.push(childClone);
      targetParentClone.childIds.push(childClone.id);
      state.sourceParentById.set(childClone.id, targetParentClone.id);
      appendCustomModalSubtree(child, childClone, child, activeModalId);
      continue;
    }

    if (
      child.fieldInfo?.isReactiveControl &&
      child.fieldInfo.name &&
      currentIndexedOwner &&
      currentIndexedOwner.fieldInfo?.name !== child.fieldInfo.name
    ) {
      const field = child.fieldInfo;
      const ownerSource = getNodeSource(currentIndexedOwner);
      const fieldId = `source-field:${currentIndexedOwner.id}:${field.name}`;
      if (!state.flatById.has(fieldId)) {
        const ownerFieldMatch = (ownerSource.fields || []).find(item => item.name === field.name);
        const mapping = window.GIGSourceLoader.findFieldSources(ownerSource, state.columnServices, field.name);
        const sameAreaExact = mapping.exact.filter(
          item => sharedDirectoryPrefixDepth(item.componentTs, ownerSource.componentTs) >= 5,
        );
        const exactColumnSource = sameAreaExact.length === 1
          ? sameAreaExact[0]
          : (!ownerFieldMatch && mapping.exact.length === 1 ? mapping.exact[0] : null);
        const resolvedSource = ownerFieldMatch
          ? { ...ownerSource, selectorLine: ownerFieldMatch.line }
          : exactColumnSource || (ownerSource.componentTs ? ownerSource : null);
        const exact = Boolean(ownerFieldMatch || exactColumnSource);
        const fieldNode = registerVirtualNode({
          id: fieldId,
          parentId: targetParentClone.id,
          rawNodeId: child.id,
          selector: field.name,
          displayName: field.name,
          componentClassName: field.type || child.selector || "field",
          runtimeTitle: field.label || child.runtimeTitle || "",
          virtualType: "field",
          kind: "source-field",
          fieldInfo: field,
          sourceResult: createSourceResult(
            resolvedSource,
            sameAreaExact.length > 1 ? sameAreaExact : mapping.services,
          ),
          sourceTrail: {
            type: "field",
            isReactiveControl: true,
            ownerId: currentIndexedOwner.id,
            modalId: activeModalId,
            field,
            exact,
            ownerFieldMatch: ownerFieldMatch || null,
            ownerFieldLine: ownerFieldMatch?.line || null,
            ownerHtmlLine: ownerFieldMatch?.htmlLine || null,
            ownerLovLine: ownerFieldMatch?.lovLine || null,
            columnServiceMatch: exactColumnSource,
            exactMatches: sameAreaExact,
            services: mapping.services,
          },
        });
        targetParentClone.children.push(fieldNode);
        targetParentClone.childIds.push(fieldNode.id);
        state.sourceParentById.set(fieldNode.id, targetParentClone.id);
      }
      state.rawFieldToVirtualId.set(child.id, fieldId);
      appendCustomModalSubtree(child, targetParentClone, currentIndexedOwner, activeModalId);
      continue;
    }

    if (child.selector === "gig-crud-table" && !hasIndexedDescendant(child)) {
      const tableClone = cloneSourceTreeNode(child);
      tableClone.parentId = targetParentClone.id;
      targetParentClone.children.push(tableClone);
      targetParentClone.childIds.push(tableClone.id);
      state.sourceParentById.set(tableClone.id, targetParentClone.id);
      continue;
    }

    appendCustomModalSubtree(child, targetParentClone, currentIndexedOwner, activeModalId);
  }
}

function buildCustomModalSourceTree(activeModal) {
  const contentComponent = findFirstDescendant(activeModal, node => isIndexedComponent(node));
  const declaringOwner = getNearestIndexedComponent(activeModal.id) || findPageOwnerForDetachedModal(activeModal, contentComponent);
  const primarySourceNode = contentComponent || declaringOwner;
  if (!primarySourceNode) return buildCompactSourceTree();

  const rootNode = declaringOwner && declaringOwner.id !== contentComponent?.id
    ? cloneSourceTreeNode(declaringOwner)
    : null;
  if (rootNode) {
    rootNode.parentId = null;
    state.sourceParentById.set(rootNode.id, null);
    state.sourceOwnerId = rootNode.id;
  }
  const primarySourceResult = getNodeSourceResult(primarySourceNode);
  const primarySource = primarySourceResult.source || {};
  const modalId = `source-modal:${activeModal.id}`;
  const modalNode = registerVirtualNode({
    id: modalId,
    parentId: rootNode?.id || null,
    rawNodeId: contentComponent?.id || activeModal.id,
    selector: "Active custom modal",
    displayName: "Active custom modal",
    componentClassName: primarySource.className || primarySourceNode.componentClassName || "",
    runtimeTitle: activeModal.modalInfo?.title || activeModal.runtimeTitle || contentComponent?.runtimeTitle || "",
    runtimeTitleKey: activeModal.modalInfo?.titleKey || activeModal.runtimeTitleKey || "",
    virtualType: "custom-modal",
    kind: "source-modal",
    sourceResult: createSourceResult(primarySource, primarySourceResult.candidates || []),
    sourceTrail: {
      type: "custom-modal",
      ownerId: declaringOwner?.id || null,
      contentId: contentComponent?.id || null,
      modalId: activeModal.id,
    },
  });
  state.sourceAutoSelectId = contentComponent?.id || modalNode.id;

  if (contentComponent && contentComponent.id !== rootNode?.id) {
    const contentClone = cloneSourceTreeNode(contentComponent);
    contentClone.parentId = modalNode.id;
    modalNode.children.push(contentClone);
    modalNode.childIds.push(contentClone.id);
    state.sourceParentById.set(contentClone.id, modalNode.id);
    appendCustomModalSubtree(contentComponent, contentClone, contentComponent, activeModal.id);
  } else {
    appendCustomModalSubtree(activeModal, modalNode, primarySourceNode, activeModal.id);
  }

  if (rootNode) {
    rootNode.children.push(modalNode);
    rootNode.childIds.push(modalNode.id);
    state.sourceParentById.set(modalNode.id, rootNode.id);
    return [rootNode];
  }
  return [modalNode];
}

function buildSourceTree() {
  clearVirtualNodes();
  const activeModal = state.activeModalId ? state.flatById.get(state.activeModalId) : null;
  if (!activeModal || state.sourceSuppressedModalId === activeModal.id) {
    state.sourceTree = buildCompactSourceTree();
    return;
  }

  const dynamicContext = getDynamicFormContext(activeModal);
  state.sourceTree = dynamicContext
    ? buildGeneratedModalSourceTree(activeModal, dynamicContext)
    : buildCustomModalSourceTree(activeModal);
}

function toggleSourceScope() {
  if (!state.activeModalId) return;
  const previousOwnerId = state.sourceOwnerId;
  state.sourceSuppressedModalId = state.sourceSuppressedModalId === state.activeModalId ? null : state.activeModalId;
  buildSourceTree();
  renderTree(state.scan?.tree || []);
  if (!state.sourceSuppressedModalId && state.sourceAutoSelectId) {
    selectNode(state.sourceAutoSelectId, { reveal: true, keepHighlight: true });
  } else if (previousOwnerId && state.flatById.has(previousOwnerId)) {
    selectNode(previousOwnerId, { reveal: true, keepHighlight: true });
  } else {
    showEmptyDetails();
  }
}

function getNodeSource(node) {
  return getNodeSourceResult(node).source || {};
}

function getScanSelectors(entries = []) {
  const selectors = new Set();
  for (const entry of entries) {
    const selector = String(entry?.selector || "").trim().toLowerCase();
    if (selector) selectors.add(selector);
  }
  return Array.from(selectors).sort();
}

function createScanExpression(methodName) {
  return `window.__gigComponentInspector.${methodName}()`;
}

function getNodeKey(node) {
  if (!node) return "";
  const sourceResult = getNodeSourceResult(node);
  const source = sourceResult.source || {};
  const candidatePaths = (sourceResult.candidates || [])
    .map(candidate => candidate.componentTs || candidate.templateUrl)
    .filter(Boolean)
    .sort()
    .join(",");
  return [node.selector, source.componentTs || source.templateUrl || candidatePaths || node.componentClassName || node.id].join("|");
}

function computeScanDiff(previousScan, currentScan) {
  if (!previousScan?.flatNodes?.length) return null;
  const previousByKey = new Map(previousScan.flatNodes.filter(node => !node.isVirtual).map((node) => [node.id, node]));
  const currentByKey = new Map(currentScan.flatNodes.filter(node => !node.isVirtual).map((node) => [node.id, node]));
  const added = [];
  const removed = [];

  for (const [key, node] of currentByKey) {
    if (!previousByKey.has(key)) added.push(node);
  }
  for (const [key, node] of previousByKey) {
    if (!currentByKey.has(key)) removed.push(node);
  }

  return { added, removed };
}

async function refresh() {
  if (state.refreshInFlight) {
    state.refreshQueued = true;
    return;
  }
  state.refreshInFlight = true;
  state.lastScanStartedAt = performance.now();
  try {
    state.refreshQueued = false;
    if (!state.loadedIndexCount) {
      await loadLocalIndex();
    }
    setStatus("Injecting bridge...");
    await ensureBridge();
    setStatus("Scanning inspected page...");
    const result = await evalInInspectedPage(createScanExpression("scan"));
    if (!result?.ok) {
      throw new Error(result?.message || "Scan failed.");
    }
    const previousScan = state.scan;
    const previousSelection = state.selectedId;
    const tree = buildTreeFromFlat(result.flatNodes);
    state.scan = { ...result, tree: tree.roots };
    state.flatById = tree.nodesById;
    state.scanDiff = computeScanDiff(previousScan, result);
    state.parentById = new Map(Array.from(state.flatById.values(), node => [node.id, node.parentId || null]));
    for (const node of state.flatById.values()) prepareNodeSearchText(node);
    state.lastMutationVersion = result.mutationVersion ?? state.lastMutationVersion ?? 0;
    state.lastModalSignature = result.activeModalSignature || "";
    state.activeModalId = result.activeModalId || null;
    state.activeModalSignature = result.activeModalSignature || "";
    if (state.sourceSuppressedModalId && state.sourceSuppressedModalId !== state.activeModalId) {
      state.sourceSuppressedModalId = null;
    }
    const previousSourceOwnerId = state.sourceOwnerId;
    buildSourceTree();
    state.selectedId = previousSelection && state.flatById.has(previousSelection) ? previousSelection : null;
    if (state.focusRootId && !state.flatById.has(state.focusRootId)) state.focusRootId = null;
    renderTree(state.scan.tree);
    renderPins();
    if (state.ownerFilter === "components" && state.sourceAutoSelectId && !state.sourceSuppressedModalId) {
      selectNode(state.sourceAutoSelectId, { reveal: true, keepHighlight: true });
    } else if (state.selectedId) selectNode(state.selectedId, { reveal: false, keepHighlight: true });
    else if (state.ownerFilter === "components" && previousSourceOwnerId && state.flatById.has(previousSourceOwnerId)) {
      selectNode(previousSourceOwnerId, { reveal: true, keepHighlight: true });
    }
    else showEmptyDetails();
    state.scanSummary = `Found ${result.count} components in ${result.scanMs ?? "?"} ms${result.angularDebugApi ? " with Angular debug API" : ""}`;
    updateIndexMeta();
    setStatus(`${state.scanSummary}.`);
  } catch (error) {
    setStatus(error.message || String(error), true);
  } finally {
    state.refreshInFlight = false;
    if (state.refreshQueued && state.panelVisible) {
      refresh();
    }
  }
}

function scheduleRefresh(delay = AUTO_REFRESH_DELAY_MS) {
  clearTimeout(state.autoRefreshTimeoutId);
  state.autoRefreshTimeoutId = setTimeout(() => {
    if (state.panelVisible) refresh();
  }, delay);
}

async function ensureBridge() {
  const existingVersion = await evalInInspectedPage("window.__gigComponentInspector?.version || 0").catch(() => 0);
  if (state.bridgeInjected && existingVersion === BRIDGE_VERSION) return;
  if (existingVersion !== BRIDGE_VERSION) {
    // Inject the bridge via the background using chrome.scripting.executeScript({ files }),
    // which avoids eval/new Function entirely and is not affected by page CSP.
    const windowId = await getWindowId();
    await new Promise((resolve, reject) => {
      chrome.runtime.sendMessage({ type: "gig-inject-bridge", windowId }, (response) => {
        if (chrome.runtime.lastError) { reject(new Error(chrome.runtime.lastError.message)); return; }
        if (response?.error) { reject(new Error(response.error)); return; }
        resolve();
      });
    });
  }
  state.bridgeInjected = true;
  await configureBridge();
  if (state.highlightEnabled) {
    await evalInInspectedPage("window.__gigComponentInspector.setHighlightEnabled(true)");
  }
}

function configureBridge() {
  const options = { prefixes: state.scanPrefixes, selectors: state.scanSelectors };
  return evalInInspectedPage(`window.__gigComponentInspector.configure(${JSON.stringify(options)})`);
}

// ─── Window ID cache ──────────────────────────────────────────────────────────
// The background needs the window ID to reliably find the active tab.
// chrome.windows requires the "windows" permission; we use tabs.query as fallback.
let _cachedWindowId = null;
function getWindowId() {
  if (_cachedWindowId !== null) return Promise.resolve(_cachedWindowId);
  return new Promise((resolve) => {
    if (chrome.windows?.getCurrent) {
      chrome.windows.getCurrent({}, (w) => {
        _cachedWindowId = w?.id ?? null;
        resolve(_cachedWindowId);
      });
    } else {
      resolve(null);
    }
  });
}

function evalInInspectedPage(expression) {
  // In v2 (Side Panel) we relay eval through the background service worker,
  // which uses chrome.scripting.executeScript({ world: "MAIN" }) instead of
  // the DevTools-only chrome.devtools.inspectedWindow.eval().
  return new Promise((resolve, reject) => {
    if (!chrome.runtime?.sendMessage) {
      reject(new Error("Extension runtime is not available."));
      return;
    }
    getWindowId().then((windowId) => {
      chrome.runtime.sendMessage({ type: "gig-eval", expression, windowId }, (response) => {
        if (chrome.runtime.lastError) {
          reject(new Error(chrome.runtime.lastError.message || "Runtime messaging failed."));
          return;
        }
        if (response?.error) {
          reject(new Error(response.error));
          return;
        }
        resolve(response?.result ?? null);
      });
    });
  });
}

function renderTree(tree) {
  const displayTree = getDisplayTree(tree);
  updateSourceViewChrome();
  els.clearFocusButton.classList.toggle("hidden", !state.focusRootId || state.ownerFilter === "components");
  renderChangeSummary();
  els.componentCount.textContent = String(countTreeNodes(displayTree));
  if (!displayTree?.length) {
    els.treeRoot.className = "tree-root empty";
    els.treeRoot.textContent = state.ownerFilter === "components"
      ? "No indexed application sources were found on this page."
      : "No matching component hosts found on this page.";
    return;
  }

  els.treeRoot.className = "tree-root";
  els.treeRoot.innerHTML = "";
  els.treeRoot.appendChild(renderTreeList(displayTree));
  applyTreeFilters();
}

function updateSourceViewChrome() {
  const sourceMode = state.ownerFilter === "components";
  els.treePaneTitle.textContent = sourceMode ? "Source" : "Components";
  const hasActiveModal = Boolean(state.activeModalId);
  els.sourceScopeButton.classList.toggle("hidden", !sourceMode || !hasActiveModal);
  els.sourceScopeButton.textContent = state.sourceSuppressedModalId === state.activeModalId ? "Show modal" : "Show page";
  els.sourceScopeButton.title = state.sourceSuppressedModalId === state.activeModalId
    ? "Return to the active modal source trail"
    : "Show all page application sources until this modal closes";

  const oldIndex = sourceMode && state.loadedIndexCount > 0 && state.indexSchemaVersion < FIELD_INDEX_SCHEMA_VERSION;
  els.sourceNotice.classList.toggle("hidden", !oldIndex);
  els.sourceNotice.textContent = oldIndex
    ? "Refresh the component index to enable exact generated-field line links."
    : "";
}

function renderChangeSummary() {
  const added = state.scanDiff?.added?.length || 0;
  const removed = state.scanDiff?.removed?.length || 0;
  els.changeSummary.classList.toggle("hidden", !state.scanDiff);
  els.changeSummary.classList.toggle("has-changes", Boolean(added || removed));
  els.changeSummary.textContent = state.scanDiff ? `+${added} -${removed}` : "";
}

function getDisplayTree(tree) {
  if (state.ownerFilter === "components") return state.sourceTree || [];
  if (!state.focusRootId) return tree || [];
  const focused = state.flatById.get(state.focusRootId);
  return focused ? [focused] : tree || [];
}

function countTreeNodes(nodes) {
  return (nodes || []).reduce((count, node) => count + 1 + countTreeNodes(node.children), 0);
}

function renderTreeList(nodes) {
  const list = document.createElement("ul");
  list.className = "tree-list";

  for (const node of nodes) {
    const sourceResult = getNodeSourceResult(node);
    const source = sourceResult.source || {};
    const owner = getNodeOwner(node, sourceResult);
    const item = document.createElement("li");
    item.className = "tree-item";
    item.dataset.id = node.id;
    item.classList.toggle("collapsed", state.collapsedIds.has(node.id));

    const row = document.createElement("div");
    row.className = "tree-node";
    row.dataset.id = node.id;
    row.dataset.kind = node.kind;
    row.dataset.owner = owner;

    const arrow = document.createElement("button");
    arrow.className = "tree-arrow";
    arrow.type = "button";
    arrow.title = node.children?.length ? "Collapse or expand children" : "";
    arrow.disabled = !node.children?.length;
    arrow.dataset.treeAction = "toggle";
    arrow.innerHTML = node.children?.length ? iconSvg("chevron") : "";

    const label = document.createElement("span");
    label.className = "tree-label";
    const baseSecondary = node.componentClassName || source.className || "";
    const primaryLabel = node.displayName || node.selector;
    const controlFieldName = !node.isVirtual && node.fieldInfo?.name && node.fieldInfo.name !== primaryLabel
      ? node.fieldInfo.name
      : "";
    const secondary = controlFieldName && baseSecondary && controlFieldName !== baseSecondary
      ? `${controlFieldName} · ${baseSecondary}`
      : (controlFieldName || baseSecondary);
    label.innerHTML = `
      <span class="selector">${highlightText(primaryLabel)}</span>
      ${secondary ? `<span class="secondary">${highlightText(secondary)}</span>` : ""}
      ${node.runtimeTitle ? `<span class="runtime-title">${highlightText(node.runtimeTitle)}</span>` : ""}
    `;

    const badges = document.createElement("span");
    badges.className = "badges";
    const virtualBadge = node.virtualType === "field"
      ? "Field"
      : node.virtualType === "generated-form"
        ? "Generated"
        : node.virtualType === "custom-modal"
          ? "Modal"
          : "";
    badges.appendChild(createBadge(virtualBadge || (owner === "created" ? "App" : owner === "framework" ? "GNG" : node.kind), owner));
    if (source.componentTs) badges.appendChild(createBadge("ts", "debug"));
    if (sourceResult.ambiguous) badges.appendChild(createBadge(`${sourceResult.candidates?.length || 0} sources`, "debug"));

    const actions = document.createElement("span");
    actions.className = "tree-actions";
    const copyAiButton = document.createElement("button");
    copyAiButton.className = "icon-button icon-button-copy tree-action-button";
    copyAiButton.type = "button";
    const copyTargetName = node.fieldInfo?.name || getComponentFileName(source) || node.selector;
    copyAiButton.title = `Copy AI context for ${copyTargetName}`;
    copyAiButton.setAttribute("aria-label", `Copy AI context for ${copyTargetName}`);
    copyAiButton.dataset.treeAction = "copy-ai";
    copyAiButton.innerHTML = iconSvg("copy");
    actions.appendChild(copyAiButton);

    row.append(arrow, label, actions, badges);

    item.appendChild(row);
    if (node.children?.length) item.appendChild(renderTreeList(node.children));
    list.appendChild(item);
  }

  return list;
}

function toggleTreeNode(id) {
  if (state.collapsedIds.has(id)) {
    state.collapsedIds.delete(id);
  } else {
    state.collapsedIds.add(id);
  }
  const item = document.querySelector(`.tree-item[data-id="${cssEscape(id)}"]`);
  item?.classList.toggle("collapsed", state.collapsedIds.has(id));
}

function focusTreeOn(id) {
  state.focusRootId = id;
  state.collapsedIds.delete(id);
  renderTree(state.scan?.tree || []);
  selectNode(id, { reveal: true });
  setStatus("Focused component subtree.");
}

function clearTreeFocus() {
  const previousSelection = state.selectedId;
  state.focusRootId = null;
  renderTree(state.scan?.tree || []);
  if (previousSelection) selectNode(previousSelection, { reveal: true });
  setStatus("Showing full component tree.");
}

function getComponentAncestors(id) {
  const nodes = [];
  let currentId = id;
  while (currentId) {
    const node = state.flatById.get(currentId);
    if (!node) break;
    nodes.unshift(node);
    currentId = state.parentById.get(currentId);
  }
  return nodes;
}

function getComponentPath(id) {
  return getComponentAncestors(id)
    .map((node) => node.selector)
    .join(" > ");
}

function formatPathWithLine(filePath, line = null) {
  if (!filePath) return "";
  return line ? `${filePath}:${line}` : filePath;
}

function resolveLovColumnServiceLine(servicePath, methodName) {
  if (!servicePath) return null;
  const normalized = normalizePath(servicePath);
  const service = (state.columnServices || []).find(item => normalizePath(item.componentTs) === normalized);
  if (!service?.fields?.length) return null;
  if (methodName) {
    const direct = service.fields.find(item => item.name === methodName);
    if (direct?.line) return direct.line;
  }
  const fallbackGrid = service.fields.find(item => item.name === "getGridColumns" || item.name === "getLovColumns");
  return fallbackGrid?.line || null;
}

function resolveNodeAiContext(node) {
  if (!node) return null;
  const rawNode = (node.isVirtual && node.rawNodeId ? state.flatById.get(node.rawNodeId) : null) || node;
  const ancestors = getComponentAncestors(rawNode.id);
  const selectorPath = getComponentPath(rawNode.id);
  const trail = node.sourceTrail || {};

  const formFieldAncestor = [...ancestors].reverse().find(item => item.selector?.startsWith("app-form-") && item.fieldInfo?.name) || null;
  const dynamicFormAncestor = [...ancestors].reverse().find(item => item.selector === "app-dynamic-form" || item.selector === "app-modal-edit-form") || null;
  const isGeneratedField = (trail.type === "field" && !trail.isReactiveControl) || Boolean(formFieldAncestor && dynamicFormAncestor);

  if (isGeneratedField) {
    const field = trail.field || formFieldAncestor?.fieldInfo || rawNode.fieldInfo || {};
    const fieldName = field.name || (node.virtualType === "field" ? node.selector : "");
    const label = field.label || rawNode.runtimeTitle || formFieldAncestor?.runtimeTitle || node.runtimeTitle || "";
    const i18nKey = field.i18nName || rawNode.runtimeTitleKey || formFieldAncestor?.runtimeTitleKey || "";
    const ownerNode = (trail.ownerId && state.flatById.get(trail.ownerId)) ||
      (dynamicFormAncestor ? getNearestIndexedComponent(dynamicFormAncestor.id) : getNearestIndexedComponent(rawNode.id));
    const ownerSource = ownerNode ? getNodeSource(ownerNode) : {};
    const mapping = window.GIGSourceLoader.findFieldSources(ownerSource, state.columnServices, fieldName);

    return {
      scenario: "generated-field",
      targetSelector: rawNode.selector,
      wrapperSelector: formFieldAncestor && formFieldAncestor.selector !== rawNode.selector ? formFieldAncestor.selector : "",
      fieldName,
      label,
      i18nKey,
      selectorPath,
      ownerNode,
      ownerSource,
      exactColumnMatches: mapping.exact || [],
      relatedColumnServices: mapping.services || [],
      lovInfo: rawNode.lovInfo || null,
    };
  }

  const controlAncestorWithField = [...ancestors].reverse().find(item => item.fieldInfo?.name) || (node.fieldInfo?.name ? node : null);
  const field = trail.field || controlAncestorWithField?.fieldInfo || rawNode.fieldInfo || null;
  const isCrudTable = rawNode.selector === "gig-crud-table";
  const isLovOrControl = Boolean(
    (trail.type === "field" && trail.isReactiveControl) ||
    field?.name ||
    isCrudTable ||
    rawNode.selector === "gig-lov" ||
    rawNode.selector?.endsWith("-lov") ||
    rawNode.lovInfo,
  );

  if (isLovOrControl) {
    const fieldName = field?.name || (isCrudTable ? "gig-crud-table" : "");
    const indexedAncestors = ancestors.filter(item => isIndexedComponent(item));
    let hostOwnerNode = (trail.ownerId && state.flatById.get(trail.ownerId)) || indexedAncestors[indexedAncestors.length - 1] || null;
    let wrapperNode = null;

    if (!trail.ownerId && indexedAncestors.length >= 2) {
      const deepestIndexed = indexedAncestors[indexedAncestors.length - 1];
      const parentIndexed = indexedAncestors[indexedAncestors.length - 2];
      const parentSource = getNodeSource(parentIndexed);
      const parentHasField = fieldName && (parentSource.fields || []).some(item => item.name === fieldName);
      const deepestIsWrapper = Boolean(deepestIndexed.fieldInfo?.name || deepestIndexed.selector?.endsWith("-lov"));
      if (parentHasField || deepestIsWrapper) {
        hostOwnerNode = parentIndexed;
        wrapperNode = deepestIndexed;
      }
    }

    const hostOwnerSource = hostOwnerNode ? getNodeSource(hostOwnerNode) : {};
    const wrapperSource = wrapperNode ? getNodeSource(wrapperNode) : null;
    let indexedField = trail.ownerFieldMatch ||
      (fieldName ? (hostOwnerSource.fields || []).find(item => item.name === fieldName) : null) ||
      null;

    if (!indexedField && !fieldName && rawNode.selector === "gig-lov" && hostOwnerNode) {
      const allLovNodesInOwner = collectDescendants(hostOwnerNode, item => item.selector === "gig-lov" && !item.fieldInfo?.name);
      const lovFieldsWithoutControl = (hostOwnerSource.fields || []).filter(item => !item.line && (item.lovLine || item.ref));
      const lovIndex = allLovNodesInOwner.findIndex(item => item.id === rawNode.id);
      if (lovIndex >= 0 && lovIndex < lovFieldsWithoutControl.length) {
        indexedField = lovFieldsWithoutControl[lovIndex];
      }
    }

    const resolvedFieldName = fieldName || indexedField?.name || "";
    const label = field?.label || rawNode.runtimeTitle || controlAncestorWithField?.runtimeTitle || node.runtimeTitle || "";
    const i18nKey = field?.i18nName || rawNode.runtimeTitleKey || controlAncestorWithField?.runtimeTitleKey || "";
    const htmlLine = indexedField?.htmlLine || trail.ownerHtmlLine || null;
    const tsLine = indexedField?.line || trail.ownerFieldLine || null;
    const lovLine = indexedField?.lovLine || trail.ownerLovLine || null;
    const ref = indexedField?.ref || "";
    const configProp = indexedField?.configProp || "";
    const lovService = indexedField?.lovService || "";
    const lovMethod = indexedField?.lovMethod || "";
    const lovServiceLine = resolveLovColumnServiceLine(lovService, lovMethod);

    const mapping = resolvedFieldName && resolvedFieldName !== "gig-crud-table"
      ? window.GIGSourceLoader.findFieldSources(hostOwnerSource, state.columnServices, resolvedFieldName)
      : { exact: [], services: window.GIGSourceLoader.findRelatedColumnServices(hostOwnerSource, state.columnServices) };
    const sameAreaExact = (mapping.exact || []).filter(
      item => sharedDirectoryPrefixDepth(item.componentTs, hostOwnerSource.componentTs) >= 5,
    );
    const ownerColumnMatches = sameAreaExact.length ? sameAreaExact : (mapping.exact || []);

    return {
      scenario: isCrudTable ? "crud-table" : "form-control",
      targetSelector: rawNode.selector,
      wrapperNode,
      wrapperSource,
      fieldName: resolvedFieldName,
      label,
      i18nKey,
      ref,
      configProp,
      htmlLine,
      tsLine,
      lovLine,
      lovService,
      lovMethod,
      lovServiceLine,
      selectorPath,
      ownerNode: hostOwnerNode,
      ownerSource: hostOwnerSource,
      ownerColumnMatches,
      relatedColumnServices: mapping.services || [],
      lovInfo: rawNode.lovInfo || controlAncestorWithField?.lovInfo || null,
    };
  }

  const nodeSourceResult = getNodeSourceResult(node);
  const nodeSource = nodeSourceResult.source || {};
  const ownerNode = nodeSource.componentTs ? rawNode : getNearestIndexedComponent(rawNode.id);
  const ownerSource = nodeSource.componentTs ? nodeSource : (ownerNode ? getNodeSource(ownerNode) : {});
  const relatedServices = window.GIGSourceLoader.findRelatedColumnServices(ownerSource, state.columnServices);

  return {
    scenario: "component",
    targetSelector: rawNode.selector,
    label: node.runtimeTitle || rawNode.runtimeTitle || "",
    i18nKey: node.runtimeTitleKey || rawNode.runtimeTitleKey || "",
    selectorPath,
    ownerNode,
    ownerSource,
    relatedColumnServices: relatedServices,
  };
}

function buildAiAgentCopyText(node) {
  const ctx = resolveNodeAiContext(node);
  if (!ctx) return getComponentPath(node?.id);
  const lines = [];

  if (ctx.scenario === "generated-field") {
    const elementDesc = ctx.wrapperSelector
      ? `<${ctx.targetSelector}> inside <${ctx.wrapperSelector}>`
      : `<${ctx.targetSelector}>`;
    lines.push(`Target: ${elementDesc} (Generated CRUD Form Field: ${ctx.fieldName || "unknown"})`);
    if (ctx.label || ctx.i18nKey) {
      lines.push(`Label: ${ctx.label ? `"${ctx.label}"` : ""}${ctx.i18nKey ? `${ctx.label ? " " : ""}(i18n: ${ctx.i18nKey})` : ""}`);
    }
    if (ctx.selectorPath) lines.push(`DOM Path: ${ctx.selectorPath}`);
    if (ctx.ownerSource?.componentTs) {
      lines.push(`Page Component (${ctx.ownerSource.className || ctx.ownerNode?.selector}): ${formatPathWithLine(ctx.ownerSource.componentTs, ctx.ownerSource.selectorLine)}`);
    }
    for (const match of ctx.exactColumnMatches) {
      lines.push(`Column Service Field (${match.fieldName || ctx.fieldName}): ${formatPathWithLine(match.componentTs, match.selectorLine)}`);
    }
    if (!ctx.exactColumnMatches.length && ctx.relatedColumnServices.length) {
      for (const svc of ctx.relatedColumnServices) {
        lines.push(`Column Service: ${svc.componentTs}`);
      }
    }
    return lines.join("\n");
  }

  if (ctx.scenario === "crud-table" || ctx.scenario === "form-control") {
    const metaParts = [];
    if (ctx.fieldName && ctx.fieldName !== ctx.targetSelector) metaParts.push(`formControlName="${ctx.fieldName}"`);
    if (ctx.ref) metaParts.push(`#${ctx.ref}`);
    const wrapperDesc = ctx.wrapperNode && ctx.wrapperNode.selector !== ctx.targetSelector
      ? ` inside <${ctx.wrapperNode.selector}>`
      : "";
    lines.push(`Target: <${ctx.targetSelector}>${wrapperDesc}${metaParts.length ? ` (${metaParts.join(" | ")})` : ""}`);
    if (ctx.label || ctx.i18nKey) {
      lines.push(`Label: ${ctx.label ? `"${ctx.label}"` : ""}${ctx.i18nKey ? `${ctx.label ? " " : ""}(i18n: ${ctx.i18nKey})` : ""}`);
    }
    if (ctx.selectorPath) lines.push(`DOM Path: ${ctx.selectorPath}`);
    if (ctx.ownerNode || ctx.ownerSource?.componentTs) {
      const ownerTitle = [ctx.ownerSource?.className, ctx.ownerNode?.selector ? `<${ctx.ownerNode.selector}>` : ""].filter(Boolean).join(" ");
      if (ownerTitle) lines.push(`Owner Component: ${ownerTitle}`);
    }
    if (ctx.ownerSource?.templateUrl) {
      lines.push(`Template HTML: ${formatPathWithLine(ctx.ownerSource.templateUrl, ctx.htmlLine)}`);
    }
    if (ctx.ownerSource?.componentTs) {
      const tsLabel = ctx.scenario === "crud-table"
        ? "DataManager TS"
        : (ctx.tsLine ? `Form Control TS (${ctx.fieldName})` : "Component TS");
      lines.push(`${tsLabel}: ${formatPathWithLine(ctx.ownerSource.componentTs, ctx.tsLine || ctx.ownerSource.selectorLine)}`);
    }
    if (ctx.lovLine && ctx.ownerSource?.componentTs) {
      const lovLabel = ctx.configProp || (ctx.ref ? `#${ctx.ref}` : ctx.fieldName);
      lines.push(`LOV Config TS${lovLabel ? ` (${lovLabel})` : ""}: ${formatPathWithLine(ctx.ownerSource.componentTs, ctx.lovLine)}`);
    }
    if (ctx.lovService) {
      lines.push(`LOV Column Service${ctx.lovMethod ? ` (${ctx.lovMethod})` : ""}: ${formatPathWithLine(ctx.lovService, ctx.lovServiceLine)}`);
    }
    for (const match of ctx.ownerColumnMatches) {
      if (ctx.lovService && normalizePath(match.componentTs) === normalizePath(ctx.lovService) && match.selectorLine === ctx.lovServiceLine) {
        continue;
      }
      lines.push(`Owner Column Service (${match.fieldName || ctx.fieldName}): ${formatPathWithLine(match.componentTs, match.selectorLine)}`);
    }
    if (!ctx.lovService && !ctx.ownerColumnMatches.length && ctx.relatedColumnServices.length === 1) {
      lines.push(`Owner Column Service: ${ctx.relatedColumnServices[0].componentTs}`);
    }
    if (ctx.wrapperSource?.componentTs) {
      lines.push(`Wrapper Component (<${ctx.wrapperNode.selector}>): ${formatPathWithLine(ctx.wrapperSource.componentTs, ctx.wrapperSource.selectorLine)}`);
      if (ctx.wrapperSource.templateUrl) {
        lines.push(`Wrapper Template HTML: ${ctx.wrapperSource.templateUrl}`);
      }
    }
    if (ctx.lovInfo?.serverUrl) {
      const endpointExtra = [ctx.lovInfo.getAllAction, ctx.lovInfo.keyValue ? `key=${ctx.lovInfo.keyValue}` : ""].filter(Boolean).join(", ");
      lines.push(`LOV API: ${ctx.lovInfo.serverUrl}${endpointExtra ? ` (${endpointExtra})` : ""}`);
    }
    return lines.join("\n");
  }

  const compTitle = [ctx.ownerSource?.className, ctx.targetSelector ? `<${ctx.targetSelector}>` : ""].filter(Boolean).join(" ");
  lines.push(`Component: ${compTitle || ctx.targetSelector}`);
  if (ctx.label) lines.push(`Title: "${ctx.label}"`);
  if (ctx.selectorPath) lines.push(`DOM Path: ${ctx.selectorPath}`);
  if (ctx.ownerSource?.componentTs) {
    lines.push(`Component TS: ${formatPathWithLine(ctx.ownerSource.componentTs, ctx.ownerSource.selectorLine)}`);
  }
  if (ctx.ownerSource?.templateUrl) {
    lines.push(`Template HTML: ${ctx.ownerSource.templateUrl}`);
  }
  if (ctx.relatedColumnServices?.length) {
    for (const svc of ctx.relatedColumnServices.slice(0, 4)) {
      lines.push(`Column Service: ${svc.componentTs}`);
    }
  }
  return lines.join("\n");
}

function sharedDirectoryPrefixDepth(pathA, pathB) {
  if (!pathA || !pathB) return 0;
  const partsA = normalizePath(pathA).split("/").slice(0, -1);
  const partsB = normalizePath(pathB).split("/").slice(0, -1);
  const limit = Math.min(partsA.length, partsB.length);
  let shared = 0;
  for (let index = 0; index < limit; index++) {
    if (partsA[index] !== partsB[index]) break;
    shared++;
  }
  return shared;
}

function disambiguateSourceCandidates(node, rawResult) {
  const candidates = rawResult?.candidates || [];
  if (!rawResult?.ambiguous || candidates.length < 2 || !node) return rawResult;

  let ancestorPath = "";
  let currentParentId = state.parentById.get(node.id) || node.parentId;
  while (currentParentId) {
    const ancestor = state.flatById.get(currentParentId);
    if (!ancestor) break;
    const ancestorResult = window.GIGSourceLoader.findSource(ancestor, state.sourceIndex);
    if (!ancestorResult.ambiguous && ancestorResult.source?.componentTs) {
      ancestorPath = ancestorResult.source.componentTs;
      break;
    }
    currentParentId = state.parentById.get(currentParentId) || ancestor.parentId;
  }

  const rawNode = state.flatById.get(node.id) || node;
  const descendantPaths = [];
  for (const desc of collectDescendants(rawNode, () => true)) {
    const descResult = window.GIGSourceLoader.findSource(desc, state.sourceIndex);
    if (!descResult.ambiguous && descResult.source?.componentTs) {
      descendantPaths.push(descResult.source.componentTs);
    }
  }

  const pagePaths = [];
  for (const other of state.flatById.values()) {
    if (other.isVirtual || other.id === node.id || other.insideMatDialog) continue;
    const otherResult = window.GIGSourceLoader.findSource(other, state.sourceIndex);
    if (!otherResult.ambiguous && otherResult.source?.componentTs) {
      pagePaths.push(otherResult.source.componentTs);
    }
  }

  let bestCandidate = null;
  let bestScore = -1;
  let secondBestScore = -1;

  for (const candidate of candidates) {
    const candidatePath = candidate.componentTs || candidate.templateUrl || "";
    if (!candidatePath) continue;

    let score = 0;
    if (ancestorPath) {
      score += sharedDirectoryPrefixDepth(candidatePath, ancestorPath) * 1000;
    }
    if (descendantPaths.length) {
      const maxDescShared = Math.max(...descendantPaths.map(path => sharedDirectoryPrefixDepth(candidatePath, path)));
      score += maxDescShared * 500;
    }
    if (pagePaths.length) {
      const maxPageShared = Math.max(...pagePaths.map(path => sharedDirectoryPrefixDepth(candidatePath, path)));
      score += maxPageShared * 100;
    }
    if (rawNode.hasFormGroup || rawNode.insideMatDialog) {
      score += (candidate.relatedColumnServices?.length || 0) * 10 + (candidate.styleUrls?.length || 0) * 2;
    }

    if (score > bestScore) {
      secondBestScore = bestScore;
      bestScore = score;
      bestCandidate = candidate;
    } else if (score > secondBestScore) {
      secondBestScore = score;
    }
  }

  if (bestCandidate && bestScore > secondBestScore) {
    return {
      ...rawResult,
      found: Boolean(bestCandidate.templateUrl || bestCandidate.componentTs),
      source: bestCandidate,
      ambiguous: false,
      disambiguated: true,
    };
  }

  return rawResult;
}

function getNodeSourceResult(node) {
  if (!node) return window.GIGSourceLoader.findSource(node, state.sourceIndex);
  if (node.sourceResult) return node.sourceResult;
  const rawNode = state.flatById.get(node.id) || node;
  if (rawNode._resolvedSourceResult) return rawNode._resolvedSourceResult;
  const rawResult = window.GIGSourceLoader.findSource(rawNode, state.sourceIndex);
  const resolved = rawResult.ambiguous ? disambiguateSourceCandidates(rawNode, rawResult) : rawResult;
  rawNode._resolvedSourceResult = resolved;
  return resolved;
}

function isIndexedComponent(node) {
  if (!node) return false;
  const sourceResult = getNodeSourceResult(node);
  const source = sourceResult.source || {};
  return getNodeOwner(node, sourceResult) === "created" && Boolean(source.componentTs || sourceResult.candidates?.length);
}

function getNearestResolvedAncestor(id) {
  const ancestors = getComponentAncestors(id);
  for (let index = ancestors.length - 2; index >= 0; index--) {
    const source = getNodeSource(ancestors[index]);
    if (source.componentTs) return ancestors[index];
  }
  return null;
}

function getNearestIndexedComponent(id) {
  const ancestors = getComponentAncestors(id);
  for (let index = ancestors.length - 1; index >= 0; index--) {
    if (isIndexedComponent(ancestors[index])) return ancestors[index];
  }
  return null;
}

function syncSelectionWithActiveFilter() {
  if (state.ownerFilter === "components") {
    if (state.sourceAutoSelectId && !state.sourceSuppressedModalId) {
      selectNode(state.sourceAutoSelectId, { reveal: true, keepHighlight: true });
      return;
    }
    const selectedNode = state.selectedId ? state.flatById.get(state.selectedId) : null;
    if (selectedNode && document.querySelector(`.tree-node[data-id="${cssEscape(selectedNode.id)}"]`)) {
      ensureTreeNodeRendered(selectedNode.id);
      selectNode(selectedNode.id, { reveal: true, keepHighlight: true });
      return;
    }
    const indexedNode = state.sourceOwnerId
      ? state.flatById.get(state.sourceOwnerId)
      : state.selectedId
        ? getNearestIndexedComponent(state.selectedId)
        : null;
    if (indexedNode) {
      ensureTreeNodeRendered(indexedNode.id);
      selectNode(indexedNode.id, { reveal: true, keepHighlight: indexedNode.id === state.selectedId });
    } else {
      showEmptyDetails();
    }
    return;
  }
  if (!state.selectedId) return;
  if (state.ownerFilter === "all") selectNode(state.selectedId, { reveal: true, keepHighlight: true });
}

function ensureTreeNodeRendered(id) {
  if (document.querySelector(`.tree-node[data-id="${cssEscape(id)}"]`) || !state.focusRootId) return;
  state.focusRootId = null;
  renderTree(state.scan?.tree || []);
}

function isPinned(node) {
  return state.pins.has(getNodeKey(node));
}

function togglePin(id) {
  const node = state.flatById.get(id);
  if (!node) return;
  const key = getNodeKey(node);
  if (state.pins.has(key)) {
    state.pins.delete(key);
    setStatus("Unpinned component.");
  } else {
    const source = getNodeSource(node);
    state.pins.set(key, {
      key,
      selector: node.selector,
      label: node.componentClassName || source.className || node.selector,
      sourcePath: source.componentTs || source.templateUrl || "",
    });
    setStatus("Pinned component.");
  }
  renderPins();
  renderTree(state.scan?.tree || []);
  if (state.selectedId) selectNode(state.selectedId, { reveal: false, keepHighlight: true });
  savePreferences();
}

function renderPins() {
  const pins = Array.from(state.pins.values());
  els.pinnedPane.classList.toggle("hidden", !pins.length);
  els.pinnedList.innerHTML = "";
  for (const pin of pins) {
    const button = document.createElement("button");
    button.className = "pinned-chip";
    button.type = "button";
    button.title = pin.sourcePath || pin.selector;
    button.innerHTML = `${iconSvg("pinFilled")}<span>${escapeHtml(pin.selector)}</span>`;
    button.addEventListener("click", () => {
      const node = findPinnedNode(pin);
      if (!node) {
        setStatus("Pinned component is not present in the current scan.", true);
        return;
      }
      selectNode(node.id, { reveal: true, openPopup: true });
    });
    els.pinnedList.appendChild(button);
  }
}

function findPinnedNode(pin) {
  return Array.from(state.flatById.values()).find((node) => getNodeKey(node) === pin.key);
}

function createBadge(text, className = "") {
  const badge = document.createElement("span");
  badge.className = `badge ${className || ""}`.trim();
  badge.textContent = text;
  return badge;
}

function openDetailsPopup() {
  state.detailsPopupOpen = true;
  els.detailsModalBackdrop?.classList.remove("hidden");
}

function closeDetailsPopup() {
  state.detailsPopupOpen = false;
  els.detailsModalBackdrop?.classList.add("hidden");
}

function selectNode(id, options = {}) {
  state.selectedId = id;
  document.querySelectorAll(".tree-node.selected").forEach((node) => node.classList.remove("selected"));
  const row = document.querySelector(`.tree-node[data-id="${cssEscape(id)}"]`);
  row?.classList.add("selected");
  if (options.reveal) revealTreeNode(row);
  const node = state.flatById.get(id);
  renderDetails(node);
  if (options.openPopup && node) openDetailsPopup();
  if (node && !node.isVirtual && !node.detailsLoaded) loadNodeDetails(node);
  if (!options.keepHighlight) highlightNodeOnPage(id);
}

async function loadNodeDetails(node) {
  if (!node?.id || node.detailsLoaded) return;
  if (state.detailsInFlight.has(node.id)) return state.detailsInFlight.get(node.id);

  const request = (async () => {
    try {
      await ensureBridge();
      const result = await evalInInspectedPage(
        `window.__gigComponentInspector.getNodeDetails(${JSON.stringify(node.id)})`,
      );
      if (!result?.ok) return;
      const current = state.flatById.get(node.id);
      if (!current) return;
      Object.assign(current, result, { detailsLoaded: true });
      prepareNodeSearchText(current);
      if (state.selectedId === current.id) renderDetails(current);
    } catch (_error) {
      // Details are optional; the source mapping and component tree stay usable.
    } finally {
      state.detailsInFlight.delete(node.id);
    }
  })();

  state.detailsInFlight.set(node.id, request);
  return request;
}

function revealTreeNode(row) {
  if (!row) return;
  let current = row.closest(".tree-item");
  while (current) {
    current.classList.remove("hidden-by-filter");
    current.classList.remove("collapsed");
    if (current.dataset.id) state.collapsedIds.delete(current.dataset.id);
    const parentList = current.parentElement?.closest(".tree-item");
    current = parentList;
  }
  row.classList.remove("hidden-by-filter");
  row.scrollIntoView({ block: "center", inline: "nearest" });
}

async function inspectNode(id) {
  try {
    await ensureBridge();
    const result = await evalInInspectedPage(`window.__gigComponentInspector.inspectElementById(${JSON.stringify(id)})`);
    if (!result?.ok) throw new Error(result?.message || "Could not inspect element.");
    setStatus("Selected component host in Elements.");
  } catch (error) {
    setStatus(error.message || String(error), true);
  }
}

function renderDetails(node) {
  if (!node) {
    showEmptyDetails();
    return;
  }

  const source = getNodeSourceResult(node);
  const sourceInfo = source.source || {};
  const owner = getNodeOwner(node, source);

  els.emptyDetails.classList.add("hidden");
  els.detailsContent.classList.remove("hidden");
  els.detailsTitle.textContent = node.displayName || node.selector;
  els.detailsBadges.innerHTML = "";
  const virtualBadge = node.virtualType === "field"
    ? "Field"
    : node.virtualType === "generated-form"
      ? "Generated form"
      : node.virtualType === "custom-modal"
        ? "Active modal"
        : "";
  els.detailsBadges.appendChild(createBadge(virtualBadge || (owner === "created" ? "App" : owner === "framework" ? "GNG/framework" : node.kind), owner));
  if (sourceInfo.className || node.componentClassName) els.detailsBadges.appendChild(createBadge(sourceInfo.className || node.componentClassName));
  if (sourceInfo.componentTs) els.detailsBadges.appendChild(createBadge("indexed", "debug"));
  if (source.ambiguous) els.detailsBadges.appendChild(createBadge(`${source.candidates?.length || 0} source candidates`, "debug"));
  if (node.hasAngularDebugApi) els.detailsBadges.appendChild(createBadge("Angular debug", "debug"));

  if (els.detailsActions) {
    els.detailsActions.innerHTML = "";
    const aiCtx = resolveNodeAiContext(node);

    els.detailsActions.appendChild(
      createDetailsActionPill(
        "copy",
        "Copy for AI",
        "Copy full file & line context for AI coding agents",
        () => {
          copyText(buildAiAgentCopyText(node));
          showToast(`Copied AI context for ${aiCtx?.fieldName || node.displayName || node.selector}`);
          setStatus("Copied rich AI agent context to clipboard.");
        },
        "primary",
      ),
    );

    if (sourceInfo.componentTs) {
      const componentPath = resolveProjectPath(sourceInfo.componentTs);
      els.detailsActions.appendChild(
        createDetailsActionPill(
          "code",
          "Open .ts",
          node.virtualType === "field" ? "Open field definition in VS Code" : "Open component in VS Code",
          () => {
            if (sourceInfo.selectorLine) {
              openVsCodeLocation(componentPath, Number(sourceInfo.selectorLine), 1);
            } else {
              openVsCodePath(componentPath);
            }
            setStatus("Opening file in VS Code.");
          },
        ),
      );
    } else if (aiCtx?.ownerSource?.componentTs && (aiCtx.lovLine || aiCtx.tsLine)) {
      const ownerTsPath = resolveProjectPath(aiCtx.ownerSource.componentTs);
      const targetLine = aiCtx.lovLine || aiCtx.tsLine;
      els.detailsActions.appendChild(
        createDetailsActionPill(
          "code",
          aiCtx.lovLine ? "LOV .ts" : "Control .ts",
          `Open ${aiCtx.ownerSource.className || "owner"} .ts at line ${targetLine}`,
          () => {
            openVsCodeLocation(ownerTsPath, Number(targetLine), 1);
            setStatus("Opening control definition in VS Code.");
          },
        ),
      );
    }

    if (aiCtx?.lovService) {
      const lovServicePath = resolveProjectPath(aiCtx.lovService);
      els.detailsActions.appendChild(
        createDetailsActionPill(
          "code",
          "LOV Columns",
          `Open ${aiCtx.lovService.split("/").pop()}${aiCtx.lovServiceLine ? `:${aiCtx.lovServiceLine}` : ""}`,
          () => {
            if (aiCtx.lovServiceLine) {
              openVsCodeLocation(lovServicePath, Number(aiCtx.lovServiceLine), 1);
            } else {
              openVsCodePath(lovServicePath);
            }
            setStatus("Opening LOV column service in VS Code.");
          },
        ),
      );
    }

    if (sourceInfo.templateUrl) {
      const templatePath = resolveProjectPath(sourceInfo.templateUrl);
      els.detailsActions.appendChild(
        createDetailsActionPill(
          "template",
          "Open .html",
          "Open template in VS Code",
          () => {
            if (aiCtx?.htmlLine && sourceInfo.templateUrl === aiCtx?.ownerSource?.templateUrl) {
              openVsCodeLocation(templatePath, Number(aiCtx.htmlLine), 1);
            } else {
              openVsCodePath(templatePath);
            }
            setStatus("Opening template in VS Code.");
          },
        ),
      );
    } else if (node.isVirtual && node.sourceTrail?.ownerId) {
      const ownerNode = state.flatById.get(node.sourceTrail.ownerId);
      const ownerTemplate = ownerNode ? getNodeSource(ownerNode).templateUrl : "";
      if (ownerTemplate) {
        els.detailsActions.appendChild(
          createDetailsActionPill(
            "template",
            aiCtx?.htmlLine ? `Owner .html:${aiCtx.htmlLine}` : "Owner .html",
            "Open the owning component template in VS Code",
            () => {
              const resolvedHtml = resolveProjectPath(ownerTemplate);
              if (aiCtx?.htmlLine) {
                openVsCodeLocation(resolvedHtml, Number(aiCtx.htmlLine), 1);
              } else {
                openVsCodePath(resolvedHtml);
              }
              setStatus("Opening the owning component template in VS Code.");
            },
          ),
        );
      }
    } else if (!node.isVirtual && isMeaningfulFrameworkNode(node)) {
      const ownerTemplate = aiCtx?.ownerSource?.templateUrl || (() => {
        const ownerAncestor = getNearestResolvedAncestor(node.id);
        return ownerAncestor ? getNodeSource(ownerAncestor).templateUrl : "";
      })();
      if (ownerTemplate) {
        els.detailsActions.appendChild(
          createDetailsActionPill(
            "template",
            aiCtx?.htmlLine ? `Owner .html:${aiCtx.htmlLine}` : "Owner .html",
            "Open the app template that declares this framework component",
            () => {
              const resolvedHtml = resolveProjectPath(ownerTemplate);
              if (aiCtx?.htmlLine) {
                openVsCodeLocation(resolvedHtml, Number(aiCtx.htmlLine), 1);
              } else {
                openVsCodePath(resolvedHtml);
              }
              setStatus("Opening the owning app template in VS Code.");
            },
          ),
        );
      }
    }

    const componentFileName = getComponentFileName(sourceInfo);
    if (componentFileName) {
      els.detailsActions.appendChild(
        createDetailsActionPill(
          "copy",
          "Copy .ts",
          `Copy ${componentFileName}`,
          () => {
            copyText(componentFileName);
            setStatus(`Copied ${componentFileName}.`);
          },
        ),
      );
    }

    els.detailsActions.appendChild(
      createDetailsActionPill(
        "path",
        "Copy Path",
        "Copy DOM selector path",
        () => {
          copyText(getComponentPath(node.id));
          setStatus("Copied component path.");
        },
      ),
    );

    const pinned = isPinned(node);
    els.detailsActions.appendChild(
      createDetailsActionPill(
        pinned ? "pinFilled" : "pin",
        pinned ? "Pinned" : "Pin",
        pinned ? "Unpin component" : "Pin component",
        () => togglePin(node.id),
        pinned ? "active-pin" : "",
      ),
    );

    if (!node.isVirtual) {
      els.detailsActions.appendChild(
        createDetailsActionPill(
          "focus",
          "Focus Tree",
          "Focus this component and its children in the tree",
          () => {
            focusTreeOn(node.id);
            closeDetailsPopup();
          },
        ),
      );
    }
  }

  document.getElementById("tab-overview").innerHTML = renderOverview(node, source);
  document.getElementById("tab-changes").innerHTML = renderChanges();
}

function getComponentFileName(source) {
  if (source.componentFileName) return source.componentFileName;
  const componentPath = normalizePath(source.componentTs || "");
  return componentPath ? componentPath.split("/").pop() : "";
}

function createDetailsActionPill(iconName, label, title, onClick, variantClass = "") {
  const button = document.createElement("button");
  button.className = `details-action-pill ${variantClass || ""}`.trim();
  button.type = "button";
  button.title = title;
  button.setAttribute("aria-label", title);
  button.innerHTML = `${iconSvg(iconName)}<span>${escapeHtml(label)}</span>`;
  button.addEventListener("click", (event) => {
    event.stopPropagation();
    onClick();
  });
  return button;
}

function createHeaderActionButton(iconName, title, onClick, className = iconName) {
  const button = document.createElement("button");
  button.className = `icon-button icon-button-${className}`;
  button.type = "button";
  button.title = title;
  button.setAttribute("aria-label", title);
  button.innerHTML = iconSvg(iconName);
  button.addEventListener("click", (event) => {
    event.stopPropagation();
    onClick();
  });
  return button;
}

function showEmptyDetails() {
  els.emptyDetails.classList.remove("hidden");
  els.detailsContent.classList.add("hidden");
  closeDetailsPopup();
}

function renderOverview(node, sourceResult) {
  if (node.sourceTrail) return renderSourceTrailOverview(node, sourceResult);
  const source = sourceResult.source || {};
  const aiCtx = resolveNodeAiContext(node);
  const parentComponent = aiCtx?.ownerNode && aiCtx.ownerNode.id !== node.id
    ? aiCtx.ownerNode
    : (source.componentTs ? null : getNearestResolvedAncestor(node.id));
  const candidates = sourceResult.ambiguous ? sourceResult.candidates || [] : [];
  const styles = source.styleUrls || [];
  const relatedServices = window.GIGSourceLoader.findRelatedColumnServices(
    source.componentTs ? source : (aiCtx?.ownerSource || source),
    state.columnServices,
  );
  const isControlScenario = aiCtx && (aiCtx.scenario === "form-control" || aiCtx.scenario === "crud-table" || aiCtx.scenario === "generated-field");

  return `
    <table class="kv">
      ${row("Selector", node.selector)}
      ${aiCtx?.fieldName && aiCtx.fieldName !== node.selector ? row("Field / Control", `${aiCtx.fieldName}${aiCtx.ref ? ` (#${aiCtx.ref})` : ""}`) : ""}
      ${(node.runtimeTitle || aiCtx?.label) ? row("Runtime title", node.runtimeTitle || aiCtx.label) : ""}
      ${aiCtx?.i18nKey ? row("Translation key", aiCtx.i18nKey) : ""}
      ${row("Source class", source.className || (aiCtx?.ownerSource?.className ? `${aiCtx.ownerSource.className} (Owner)` : "Not indexed"))}
      ${parentComponent ? parentComponentRow(parentComponent) : ""}
      ${source.componentTs ? pathRow("Component .ts", source.componentTs, source.selectorLine) : ""}
      ${source.templateUrl ? pathRow("Template .html", source.templateUrl) : ""}
      ${!source.templateUrl && isControlScenario && aiCtx.ownerSource?.templateUrl ? pathRow("Owner template .html", aiCtx.ownerSource.templateUrl, aiCtx.htmlLine) : ""}
      ${!source.componentTs && isControlScenario && aiCtx.ownerSource?.componentTs ? pathRow(aiCtx.tsLine ? `Form control .ts (${aiCtx.fieldName})` : "Owner component .ts", aiCtx.ownerSource.componentTs, aiCtx.tsLine || aiCtx.ownerSource.selectorLine) : ""}
      ${isControlScenario && aiCtx.lovLine && aiCtx.ownerSource?.componentTs ? pathRow(`LOV config .ts${aiCtx.configProp ? ` (${aiCtx.configProp})` : ""}`, aiCtx.ownerSource.componentTs, aiCtx.lovLine) : ""}
      ${isControlScenario && aiCtx.lovService ? pathRow(`LOV column service${aiCtx.lovMethod ? ` (${aiCtx.lovMethod})` : ""}`, aiCtx.lovService, aiCtx.lovServiceLine) : ""}
      ${isControlScenario && (aiCtx.ownerColumnMatches || []).map(match => pathRow(`Owner column (${match.fieldName || aiCtx.fieldName})`, match.componentTs, match.selectorLine)).join("")}
      ${isControlScenario && (aiCtx.exactColumnMatches || []).map(match => pathRow(`Column field (${match.fieldName || aiCtx.fieldName})`, match.componentTs, match.selectorLine)).join("")}
      ${isControlScenario && aiCtx.wrapperSource?.componentTs && aiCtx.wrapperSource.componentTs !== source.componentTs ? pathRow(`Wrapper (<${aiCtx.wrapperNode.selector}>)`, aiCtx.wrapperSource.componentTs, aiCtx.wrapperSource.selectorLine) : ""}
      ${aiCtx?.lovInfo?.serverUrl ? row("LOV API", `${aiCtx.lovInfo.serverUrl}${aiCtx.lovInfo.getAllAction ? ` (${aiCtx.lovInfo.getAllAction})` : ""}`) : ""}
      ${row("Children", String(node.childIds?.length || 0))}
    </table>
    ${candidates.length > 1 ? renderSourceCandidates(candidates) : ""}
    ${styles.length ? renderRelatedPaths("Styles", styles) : ""}
    ${relatedServices.length ? renderRelatedPaths("Related column services", relatedServices.map(service => service.componentTs)) : ""}
    <h2 class="section-title">Attributes</h2>
    ${renderObjectTable(node.attributes, "No host attributes.")}
  `;
}

function parentComponentRow(node) {
  const source = getNodeSource(node);
  const label = [node.selector, source.className || node.componentClassName].filter(Boolean).join(" - ");
  return `
    <tr>
      <th>${escapeHtml("Owning app component")}</th>
      <td>
        <span class="cell-value">${highlightText(label || node.selector)}</span>
        <span class="row-actions">
          ${copyButton(label || node.selector)}
          ${iconButton("focus", "Jump to owning app component", `data-jump-node="${escapeHtml(node.id)}"`)}
          ${pathActionButtons(source.componentTs)}
          ${pathActionButtons(source.templateUrl)}
        </span>
      </td>
    </tr>
  `;
}

function renderIoTable(items, emptyText) {
  if (!items?.length) return `<div class="notice">${escapeHtml(emptyText)}</div>`;
  return `
    <table class="kv">
      ${items.map((item) => row(item.publicName, item.propertyName === item.publicName ? item.publicName : `${item.propertyName}${item.declaredName ? ` (${item.declaredName})` : ""}`)).join("")}
    </table>
  `;
}

function renderChanges() {
  if (!state.scanDiff) return '<div class="notice">Refresh again to compare changes with the previous scan.</div>';
  const added = state.scanDiff.added || [];
  const removed = state.scanDiff.removed || [];
  if (!added.length && !removed.length) return '<div class="notice">No component changes since the previous scan.</div>';
  return `
    <div class="summary-list">
      ${added.map((node) => renderSummaryItem(node, "added")).join("")}
      ${removed.map((node) => renderSummaryItem(node, "removed")).join("")}
    </div>
  `;
}

function renderSummaryItem(node, type) {
  return `
    <div class="summary-item ${type}">
      <strong>${type === "added" ? "Added" : "Removed"}:</strong>
      <span>${highlightText(node.selector)}</span>
      ${node.componentClassName ? `<span class="secondary">${highlightText(node.componentClassName)}</span>` : ""}
    </div>
  `;
}

function renderObjectTable(object, emptyText) {
  const entries = Object.entries(object || {}).filter(([, value]) => value !== undefined && value !== "" && value !== null);
  if (!entries.length) return `<div class="notice">${escapeHtml(emptyText)}</div>`;
  return `
    <table class="kv">
      ${entries.map(([key, value]) => row(key, formatValue(value))).join("")}
    </table>
  `;
}

function renderArray(items, emptyText) {
  if (!items?.length) return `<div class="notice">${escapeHtml(emptyText)}</div>`;
  return `<table class="kv">${items.map((item, index) => row(String(index + 1), item)).join("")}</table>`;
}

function formatValue(value) {
  if (value == null) return "";
  if (Array.isArray(value)) return value.join("\n");
  if (typeof value === "string") return value;
  return JSON.stringify(value, null, 2);
}

function highlightText(value) {
  const text = String(value ?? "");
  const query = els.searchInput.value.trim();
  if (!query) return escapeHtml(text);
  const lowerText = text.toLowerCase();
  const lowerQuery = query.toLowerCase();
  let index = 0;
  let output = "";
  while (index < text.length) {
    const matchIndex = lowerText.indexOf(lowerQuery, index);
    if (matchIndex === -1) {
      output += escapeHtml(text.slice(index));
      break;
    }
    output += escapeHtml(text.slice(index, matchIndex));
    output += `<mark class="match">${escapeHtml(text.slice(matchIndex, matchIndex + query.length))}</mark>`;
    index = matchIndex + query.length;
  }
  return output;
}

function row(key, value) {
  const text = formatValue(value);
  return `
    <tr>
      <th>${highlightText(key)}</th>
      <td>
        <span class="cell-value">${highlightText(text)}</span>
        ${copyButton(text)}
      </td>
    </tr>
  `;
}

function pathRow(key, value, line = null) {
  const text = value || "Not indexed";
  const displayText = value && line ? `${text}:${line}` : text;
  return `
    <tr>
      <th>${escapeHtml(key)}</th>
      <td>
        <span class="cell-value">${highlightText(displayText)}</span>
        <span class="row-actions">
          ${copyButton(displayText)}
          ${pathActionButtons(value, line)}
        </span>
      </td>
    </tr>
  `;
}

function copyButton(value) {
  if (!value) return "";
  return iconButton("copy", "Copy value", `data-copy-value="${escapeHtml(value)}"`);
}

function pathActionButtons(path, line = null) {
  if (!path) return "";
  const filePath = resolveProjectPath(path);
  if (!filePath) return "";
  const folderPath = getDirectoryPath(filePath);
  return `
    ${iconButton("folder", "Open directory in VS Code", `data-open-folder="${escapeHtml(folderPath)}"`)}
    ${iconButton("code", line ? `Open line ${line} in VS Code` : "Open file in VS Code", `data-open-vscode="${escapeHtml(filePath)}"${line ? ` data-open-line="${escapeHtml(line)}"` : ""}`)}
  `;
}

function iconButton(name, title, attrs) {
  return `
    <button class="icon-button icon-button-${escapeHtml(name)}" type="button" ${attrs} title="${escapeHtml(title)}" aria-label="${escapeHtml(title)}">
      ${iconSvg(name)}
    </button>
  `;
}

function iconSvg(name) {
  const icons = {
    copy: '<svg viewBox="0 0 16 16" aria-hidden="true"><rect x="6" y="5" width="7" height="8" rx="1.2"></rect><path d="M3 10.5V3.8C3 3.4 3.4 3 3.8 3h6.7"></path></svg>',
    folder:
      '<svg viewBox="0 0 16 16" aria-hidden="true"><path d="M2.5 5.5h4l1.2 1.5h5.8v5.2c0 .7-.4 1.1-1.1 1.1H3.6c-.7 0-1.1-.4-1.1-1.1V5.5Z"></path><path d="M2.5 5.5V4.2c0-.7.4-1.1 1.1-1.1h2.5l1.1 1.2h5.2c.7 0 1.1.4 1.1 1.1V7"></path></svg>',
    code: '<svg viewBox="0 0 16 16" aria-hidden="true"><path d="m6.3 4-3.5 4 3.5 4"></path><path d="m9.7 4 3.5 4-3.5 4"></path></svg>',
    focus:
      '<svg viewBox="0 0 16 16" aria-hidden="true"><circle cx="8" cy="8" r="2.2"></circle><path d="M2.5 6V3.5h2.5"></path><path d="M11 3.5h2.5V6"></path><path d="M13.5 10v2.5H11"></path><path d="M5 12.5H2.5V10"></path></svg>',
    pin: '<svg viewBox="0 0 16 16" aria-hidden="true"><path d="M9.8 2.7 13.3 6.2"></path><path d="m6.6 9.4-3.1 3.1"></path><path d="M5.1 8.1 8.1 3.7l4.2 4.2-4.4 3-2.8-2.8Z"></path></svg>',
    pinFilled:
      '<svg viewBox="0 0 16 16" aria-hidden="true"><path d="M9.8 2.7 13.3 6.2"></path><path d="m6.6 9.4-3.1 3.1"></path><path d="M5.1 8.1 8.1 3.7l4.2 4.2-4.4 3-2.8-2.8Z"></path></svg>',
    path: '<svg viewBox="0 0 16 16" aria-hidden="true"><circle cx="4" cy="4" r="1.5"></circle><circle cx="12" cy="12" r="1.5"></circle><path d="M5.5 4h2.8A3.7 3.7 0 0 1 12 7.7V10.5"></path></svg>',
    template:
      '<svg viewBox="0 0 16 16" aria-hidden="true"><path d="M3 2.5h10v11H3z"></path><path d="M5 5h6"></path><path d="M5 8h6"></path><path d="M5 11h3"></path></svg>',
    chevron: '<svg viewBox="0 0 16 16" aria-hidden="true"><path d="m6 4 4 4-4 4"></path></svg>',
  };
  return icons[name] || icons.copy;
}

async function handleDetailsClick(event) {
  const target = event.target.closest("button");
  if (!target) return;

  if (target.dataset.copyValue !== undefined) {
    await copyText(target.dataset.copyValue);
    setStatus("Copied value.");
    return;
  }

  if (target.dataset.jumpNode) {
    makeNodeSelectableInCurrentView(target.dataset.jumpNode);
    selectNode(target.dataset.jumpNode, { reveal: true, openPopup: true });
    setStatus("Opened owning app component.");
    return;
  }

  if (target.dataset.openFolder) {
    openVsCodePath(target.dataset.openFolder);
    setStatus("Opening component directory in VS Code.");
    return;
  }

  if (target.dataset.openVscode) {
    if (target.dataset.openLine) {
      openVsCodeLocation(target.dataset.openVscode, Number(target.dataset.openLine), 1);
    } else {
      openVsCodePath(target.dataset.openVscode);
    }
    setStatus("Opening file in VS Code.");
  }
}

async function copyText(text) {
  if (navigator.clipboard?.writeText) {
    await navigator.clipboard.writeText(text);
    return;
  }

  const textarea = document.createElement("textarea");
  textarea.value = text;
  textarea.style.position = "fixed";
  textarea.style.opacity = "0";
  document.body.appendChild(textarea);
  textarea.select();
  document.execCommand("copy");
  textarea.remove();
}

function openExternalUrl(url) {
  if (chrome.tabs?.create) {
    chrome.tabs.create({ url });
    return;
  }
  window.open(url, "_blank", "noopener");
}

function openVsCodePath(path) {
  openExternalUrl(pathToVsCodeUrl(path));
}

function openVsCodeLocation(path, line, column) {
  openExternalUrl(`${pathToVsCodeUrl(path)}:${line}:${column}`);
}

async function ensureFreshScanIfMutated() {
  if (!state.scan) {
    await refresh();
    return;
  }
  try {
    const mutationState = await evalInInspectedPage("window.__gigComponentInspector?.getMutationState()");
    if (
      (mutationState?.mutationVersion ?? state.lastMutationVersion) !== state.lastMutationVersion ||
      (mutationState?.modalSignature || "") !== state.lastModalSignature
    ) {
      await refresh();
    }
  } catch (_error) {}
}

async function selectLastRightClickedComponent(sourceLabel = "page right-click") {
  try {
    await ensureBridge();
    await ensureFreshScanIfMutated();
    let result = await evalInInspectedPage(createScanExpression("selectLastContextComponent"));

    if (!result?.ok && result?.needsRefresh) {
      await refresh();
      result = await evalInInspectedPage(createScanExpression("selectLastContextComponent"));
    }

    if (!result?.ok) throw new Error(result?.message || "Could not find a component for the selected element.");
    const targetId = mapRawNodeToSourceNode(result.id);
    makeNodeSelectableInCurrentView(targetId);
    selectNode(targetId, { reveal: true, keepHighlight: targetId !== result.id && !getHighlightTargetId(targetId), openPopup: true });
    activateTab("overview");
    setStatus(`Opened ${result.selector} from ${sourceLabel}.`);
  } catch (error) {
    setStatus(error.message || String(error), true);
  }
}

function makeNodeSelectableInCurrentView(id) {
  if (!isNodeHiddenInTree(id)) return;

  if (state.ownerFilter === "components" && state.flatById.get(id)?.isVirtual) {
    if (els.searchInput.value) els.searchInput.value = "";
    renderTree(state.scan?.tree || []);
    return;
  }

  if (state.focusRootId) {
    state.focusRootId = null;
    renderTree(state.scan?.tree || []);
  }

  if (state.ownerFilter !== "all") {
    state.ownerFilter = "all";
    syncFilterButtons();
    renderTree(state.scan?.tree || []);
  }

  if (isNodeHiddenInTree(id) && els.searchInput.value) {
    els.searchInput.value = "";
    applyTreeFilters();
  }
}

function mapRawNodeToSourceNode(id) {
  const ancestors = getComponentAncestors(id);
  if (!ancestors.length) return id;

  if (state.ownerFilter === "app") {
    for (let index = ancestors.length - 1; index >= 0; index--) {
      const candidate = ancestors[index];
      if (getNodeOwner(candidate, getNodeSourceResult(candidate)) === "created") {
        return candidate.id;
      }
    }
    return id;
  }

  if (state.ownerFilter !== "components") return id;

  const sourceTreeIds = collectTreeIds(state.sourceTree);
  for (let index = ancestors.length - 1; index >= 0; index--) {
    const ancestor = ancestors[index];
    const mappedFieldId = state.rawFieldToVirtualId.get(ancestor.id);
    if (mappedFieldId && state.flatById.has(mappedFieldId)) return mappedFieldId;

    if (ancestor.fieldInfo?.name && state.activeModalId) {
      const modalFieldId = `source-field:${state.activeModalId}:${ancestor.fieldInfo.name}`;
      if (state.flatById.has(modalFieldId)) return modalFieldId;
    }

    if (sourceTreeIds.has(ancestor.id)) return ancestor.id;
  }

  if (state.sourceAutoSelectId && ancestors.some(ancestor => ancestor.id === state.activeModalId)) {
    return state.sourceAutoSelectId;
  }
  const indexedNode = getNearestIndexedComponent(id);
  return indexedNode && sourceTreeIds.has(indexedNode.id) ? indexedNode.id : id;
}

function isNodeHiddenInTree(id) {
  const row = document.querySelector(`.tree-node[data-id="${cssEscape(id)}"]`);
  return !row || row.classList.contains("hidden-by-filter") || Boolean(row.closest(".tree-item.hidden-by-filter"));
}

function resolveProjectPath(path) {
  const normalized = normalizePath(path);
  if (!normalized || normalized === "Not indexed") return "";
  if (/^[a-zA-Z]:\//.test(normalized) || normalized.startsWith("/")) return normalized;
  if (!state.projectRoot) return normalized;
  return `${state.projectRoot.replace(/\/$/, "")}/${normalized}`;
}

function getDirectoryPath(path) {
  return normalizePath(path).split("/").slice(0, -1).join("/");
}

function pathToVsCodeUrl(path) {
  const normalized = normalizePath(path);
  const parts = normalized.split("/").map((part, index) => {
    if (index === 0 && /^[a-zA-Z]:$/.test(part)) return part;
    return encodeURIComponent(part);
  });
  return `vscode://file/${parts.join("/")}`;
}

function normalizePath(path) {
  return (path || "").replace(/\\/g, "/");
}

function activateTab(name) {
  for (const tab of els.tabs) tab.classList.toggle("active", tab.dataset.tab === name);
  for (const panel of els.tabPanels) panel.classList.toggle("active", panel.id === `tab-${name}`);
}

function applyTreeFilters() {
  const query = els.searchInput.value.trim().toLowerCase();
  const matchingIds = new Set();
  const visibleItemIds = new Set();
  const ancestorIds = new Set();
  const sourceTreeIds = collectTreeIds(state.sourceTree);

  for (const node of state.flatById.values()) {
    const sourceResult = getNodeSourceResult(node);
    const owner = getNodeOwner(node, sourceResult);
    const kindVisible =
      state.ownerFilter === "all" ||
      (state.ownerFilter === "app" && owner === "created") ||
      (state.ownerFilter === "components" && sourceTreeIds.has(node.id)) ||
      (state.ownerFilter === "gng" && owner === "framework");
    if (!kindVisible || (query && !node.searchText?.includes(query))) continue;

    matchingIds.add(node.id);
    let currentId = node.id;
    while (currentId) {
      visibleItemIds.add(currentId);
      const parentId = state.ownerFilter === "components" && state.sourceParentById.has(currentId)
        ? state.sourceParentById.get(currentId)
        : state.parentById.get(currentId);
      if (parentId) ancestorIds.add(parentId);
      currentId = parentId;
    }
  }

  if (state.ownerFilter === "components") {
    for (const id of Array.from(ancestorIds)) {
      if (sourceTreeIds.has(id)) {
        matchingIds.add(id);
        continue;
      }
      const ancestor = state.flatById.get(id);
      if (!ancestor) continue;
      const sourceResult = getNodeSourceResult(ancestor);
      if (isIndexedComponent(ancestor) || isMeaningfulFrameworkNode(ancestor, sourceResult)) matchingIds.add(id);
    }
  }

  for (const row of els.treeRoot.querySelectorAll(".tree-node")) {
    row.classList.toggle("hidden-by-filter", !matchingIds.has(row.dataset.id));
  }
  for (const item of els.treeRoot.querySelectorAll(".tree-item")) {
    const id = item.dataset.id;
    item.classList.toggle("hidden-by-filter", !visibleItemIds.has(id));
    const forceExpanded = (Boolean(query) || state.ownerFilter !== "all") && ancestorIds.has(id);
    item.classList.toggle("collapsed", state.collapsedIds.has(id) && !forceExpanded);
  }

  const totalCount = document.querySelectorAll(".tree-node").length;
  const modeLabels = {
    all: "visible",
    app: "app",
    components: "Source",
    gng: "gng",
  };
  els.componentCount.textContent = `${matchingIds.size}/${totalCount} ${modeLabels[state.ownerFilter] || "visible"}`;
}

function collectTreeIds(nodes, result = new Set()) {
  for (const node of nodes || []) {
    result.add(node.id);
    collectTreeIds(node.children, result);
  }
  return result;
}

function isSourceVisibleInComponents(node, sourceResult = getNodeSourceResult(node)) {
  if (isIndexedComponent(node)) return true;
  if (!isMeaningfulFrameworkNode(node, sourceResult)) return false;
  if (getNearestResolvedAncestor(node.id)) return true;
  return hasIndexedDescendant(node);
}

function isMeaningfulFrameworkNode(node, sourceResult = getNodeSourceResult(node)) {
  if (getNodeOwner(node, sourceResult) !== "framework") return false;
  return /(?:^|-)(?:modal|dialog|drawer|popup|popover|sheet|tab-group|accordion|panel|card|grid|table|form)(?:-|$)/i.test(node.selector || "");
}

function hasIndexedDescendant(node) {
  const pending = [...(node.children || [])];
  while (pending.length) {
    const current = pending.pop();
    if (isIndexedComponent(current)) return true;
    pending.push(...(current.children || []));
  }
  return false;
}

async function selectInspectedElement() {
  try {
    await ensureBridge();
    await ensureFreshScanIfMutated();
    const expression = `window.__gigComponentInspector.selectElement(typeof $0 === "undefined" ? null : $0)`;
    let result = await evalInInspectedPage(expression);

    if (!result?.ok && result?.needsRefresh) {
      await refresh();
      result = await evalInInspectedPage(expression);
    }

    if (!result?.ok) throw new Error(result?.message || "Could not find a component for the selected element.");
    const targetId = mapRawNodeToSourceNode(result.id);
    makeNodeSelectableInCurrentView(targetId);
    selectNode(targetId, { reveal: true, keepHighlight: targetId !== result.id && !getHighlightTargetId(targetId), openPopup: true });
    activateTab("overview");
    setStatus(`Opened ${result.selector} from the selected Elements node.`);
  } catch (error) {
    setStatus(error.message || String(error), true);
  }
}

// ─── Click-to-Inspect Picker (v2 replacement for "Find $0") ─────────────────
// Activates capture-phase listeners on the inspected page. Hovering outlines
// the nearest component; clicking records it as lastContextElement and
// triggers the same selection pipeline as "Find Component in GNG DevTools".

const PICKER_BRIDGE_EXPRESSION = `
(function() {
  const inspector = window.__gigComponentInspector;
  if (!inspector) return { ok: false, message: 'Bridge not ready.' };

  if (window.__gigPickerCleanup) { window.__gigPickerCleanup(); }

  const prevCursor = document.documentElement.style.cursor;
  document.documentElement.style.cursor = 'crosshair';
  inspector.setHighlightEnabled?.(true);

  const badge = document.createElement('div');
  badge.id = '__gigPickerBadge';
  badge.style.cssText = [
    'position:fixed','z-index:2147483647','pointer-events:none',
    'background:#0f172a','color:#f8fafc','font:600 12px/1.4 Consolas,monospace',
    'padding:3px 8px','border-radius:4px','box-shadow:0 2px 8px rgba(0,0,0,0.35)',
    'border:1px solid #38bdf8','display:none','white-space:nowrap'
  ].join(';');
  document.documentElement.appendChild(badge);

  let lastHighlight = null;

  function swallowEvent(e) {
    e.preventDefault();
    e.stopPropagation();
    e.stopImmediatePropagation();
  }

  function onMouseMove(e) {
    const el = e.target instanceof Element ? e.target : document.elementFromPoint(e.clientX, e.clientY);
    if (!el) return;
    const found = inspector.selectElement(el);
    if (found?.ok) {
      if (found.id !== lastHighlight) {
        lastHighlight = found.id;
        inspector.highlightElementById?.(found.id, { durationMs: 0 });
      }
      badge.textContent = '<' + found.selector + '>';
      badge.style.display = 'block';
      badge.style.left = Math.min(window.innerWidth - badge.offsetWidth - 12, Math.max(8, e.clientX + 12)) + 'px';
      badge.style.top = Math.max(8, e.clientY - 30) + 'px';
    } else if (found?.selector) {
      badge.textContent = '<' + found.selector + '>';
      badge.style.display = 'block';
      badge.style.left = Math.min(window.innerWidth - badge.offsetWidth - 12, Math.max(8, e.clientX + 12)) + 'px';
      badge.style.top = Math.max(8, e.clientY - 30) + 'px';
    } else {
      badge.style.display = 'none';
    }
  }

  function onClick(e) {
    swallowEvent(e);
    const el = e.target instanceof Element ? e.target : document.elementFromPoint(e.clientX, e.clientY);
    const result = el ? inspector.selectElement(el) : { ok: false, message: 'No element clicked.' };
    cleanup();
    window.__gigPickerResult = { picked: true, result };
  }

  function onKeyDown(e) {
    if (e.key === 'Escape') {
      swallowEvent(e);
      cleanup();
      window.__gigPickerResult = { cancelled: true };
    }
  }

  function cleanup() {
    window.removeEventListener('mousemove', onMouseMove, true);
    window.removeEventListener('mousedown', swallowEvent, true);
    window.removeEventListener('mouseup', swallowEvent, true);
    window.removeEventListener('pointerdown', swallowEvent, true);
    window.removeEventListener('pointerup', swallowEvent, true);
    window.removeEventListener('click', onClick, true);
    window.removeEventListener('keydown', onKeyDown, true);
    document.documentElement.style.cursor = prevCursor;
    badge.remove();
    inspector.clearHighlight?.();
    window.__gigPickerCleanup = null;
  }

  window.__gigPickerCleanup = cleanup;
  window.__gigPickerResult = null;

  window.addEventListener('mousemove', onMouseMove, true);
  window.addEventListener('mousedown', swallowEvent, true);
  window.addEventListener('mouseup', swallowEvent, true);
  window.addEventListener('pointerdown', swallowEvent, true);
  window.addEventListener('pointerup', swallowEvent, true);
  window.addEventListener('click', onClick, true);
  window.addEventListener('keydown', onKeyDown, true);

  return { ok: true };
})()
`;

const PICKER_POLL_EXPRESSION = `
(window.__gigPickerResult !== undefined && window.__gigPickerResult !== null)
  ? (function() { const r = window.__gigPickerResult; window.__gigPickerResult = null; return r; })()
  : 'pending'
`;

const PICKER_CANCEL_EXPRESSION = `
(function() { if (window.__gigPickerCleanup) window.__gigPickerCleanup(); window.__gigPickerResult = null; return true; })()
`;

let pickerPollTimer = null;

async function toggleInspectPicker() {
  if (state.inspectPickerActive) {
    await cancelInspectPicker();
    return;
  }
  try {
    await ensureBridge();
    await ensureFreshScanIfMutated();
    const result = await evalInInspectedPage(PICKER_BRIDGE_EXPRESSION);
    if (!result?.ok) throw new Error(result?.message || "Could not activate picker.");
    state.inspectPickerActive = true;
    els.inspectPickerButton?.classList.add("active");
    setStatus("Hover and click any element on the page to inspect its component (Esc to cancel).");
    pollPickerResult();
  } catch (error) {
    state.inspectPickerActive = false;
    els.inspectPickerButton?.classList.remove("active");
    setStatus(error.message || String(error), true);
  }
}

function pollPickerResult() {
  clearTimeout(pickerPollTimer);
  pickerPollTimer = setTimeout(async () => {
    if (!state.inspectPickerActive) return;
    try {
      const outcome = await evalInInspectedPage(PICKER_POLL_EXPRESSION);
      if (outcome === "pending") {
        pollPickerResult();
        return;
      }
      state.inspectPickerActive = false;
      els.inspectPickerButton?.classList.remove("active");
      await evalInInspectedPage(`window.__gigComponentInspector?.setHighlightEnabled(${JSON.stringify(state.highlightEnabled)})`).catch(() => {});

      if (outcome?.cancelled) {
        setStatus("Picker cancelled.");
        return;
      }
      await selectLastRightClickedComponent("page picker");
    } catch (_err) {
      state.inspectPickerActive = false;
      els.inspectPickerButton?.classList.remove("active");
    }
  }, 120);
}

async function cancelInspectPicker() {
  clearTimeout(pickerPollTimer);
  state.inspectPickerActive = false;
  els.inspectPickerButton?.classList.remove("active");
  try {
    await evalInInspectedPage(PICKER_CANCEL_EXPRESSION);
    await evalInInspectedPage(`window.__gigComponentInspector?.setHighlightEnabled(${JSON.stringify(state.highlightEnabled)})`);
  } catch (_err) {}
  setStatus("Picker cancelled.");
}

function renderSourceCandidates(candidates) {
  const uniqueCandidates = Array.from(
    new Map(candidates.map(candidate => [`${candidate.componentTs || candidate.templateUrl}:${candidate.selectorLine || ""}`, candidate])).values(),
  ).filter(candidate => candidate.componentTs || candidate.templateUrl);
  if (!uniqueCandidates.length) return "";
  return `
    <h2 class="section-title">Source candidates</h2>
    <table class="kv">
      ${uniqueCandidates.map(candidate => {
        const candidatePath = candidate.componentTs || candidate.templateUrl;
        const candidateDisplay = candidate.selectorLine ? `${candidatePath}:${candidate.selectorLine}` : candidatePath;
        return `
          <tr>
            <th>${highlightText(candidate.className || "Candidate")}</th>
            <td>
              <span class="cell-value">${highlightText(candidateDisplay)}</span>
              <span class="row-actions">${copyButton(candidateDisplay)}${pathActionButtons(candidatePath, candidate.selectorLine)}</span>
            </td>
          </tr>
        `;
      }).join("")}
    </table>
  `;
}

function renderSourceTrailOverview(node, sourceResult) {
  const trail = node.sourceTrail || {};
  const source = sourceResult.source || {};
  const ownerNode = trail.ownerId ? state.flatById.get(trail.ownerId) : null;
  const ownerSource = ownerNode ? getNodeSource(ownerNode) : {};

  if (trail.type === "generated-form") {
    return `
      <div class="notice">This modal is generated by GIG from the page column metadata. Edit the page component for orchestration and the column service for fields, layout, LOVs, and validation.</div>
      <table class="kv">
        ${row("Runtime title", trail.title || "Not available")}
        ${trail.titleKey ? row("Title key", trail.titleKey) : ""}
        ${row("Mode", trail.mode || "Unknown")}
        ${ownerNode ? parentComponentRow(ownerNode) : ""}
        ${pathRow("Page component", ownerSource.componentTs)}
        ${pathRow("Page template", ownerSource.templateUrl)}
        ${row("Generated by", (trail.generationChain || []).join(" → "))}
      </table>
      ${trail.services?.length ? renderRelatedPaths("Column service", trail.services.map(service => service.componentTs)) : '<div class="notice">No related column service was resolved for this page.</div>'}
      ${state.indexSchemaVersion < FIELD_INDEX_SCHEMA_VERSION ? '<div class="notice">Refresh the component index to add exact field line links.</div>' : ""}
    `;
  }

  if (trail.type === "field") {
    const field = trail.field || {};
    const isReactive = Boolean(trail.isReactiveControl);
    const aiCtx = resolveNodeAiContext(node);
    const exactNotice = isReactive
      ? (trail.ownerFieldLine
        ? `Reactive form control (formControlName) resolved to line ${trail.ownerFieldLine} of ${ownerSource.componentFileName || "owning component"}.`
        : "Reactive form control (formControlName) inside the owning component template.")
      : (trail.exact
        ? "Exact literal field definition resolved from the runtime dynElement name."
        : trail.exactMatches?.length > 1
          ? "The field name occurs more than once. Choose a source candidate; no line was guessed."
          : "The runtime field was resolved to its related column service, but no unique literal name line was found. No line was guessed.");
    return `
      <div class="notice">${escapeHtml(exactNotice)}</div>
      <table class="kv">
        ${row("Field name", `${field.name || node.selector}${aiCtx?.ref ? ` (#${aiCtx.ref})` : ""}`)}
        ${field.label ? row("Runtime label", field.label) : ""}
        ${field.i18nName ? row("Translation key", field.i18nName) : ""}
        ${field.type ? row("Control type", field.type) : ""}
        ${ownerNode ? parentComponentRow(ownerNode) : ""}
        ${isReactive && ownerSource.templateUrl ? pathRow("Form template .html", ownerSource.templateUrl, aiCtx?.htmlLine || trail.ownerHtmlLine || null) : ""}
        ${isReactive ? pathRow("Form component .ts", ownerSource.componentTs, aiCtx?.tsLine || trail.ownerFieldLine || ownerSource.selectorLine || null) : ""}
        ${isReactive && (aiCtx?.lovLine || trail.ownerLovLine) ? pathRow(`LOV config .ts${aiCtx?.configProp ? ` (${aiCtx.configProp})` : ""}`, ownerSource.componentTs, aiCtx?.lovLine || trail.ownerLovLine) : ""}
        ${isReactive && aiCtx?.lovService ? pathRow(`LOV column service${aiCtx?.lovMethod ? ` (${aiCtx.lovMethod})` : ""}`, aiCtx.lovService, aiCtx.lovServiceLine) : ""}
        ${!isReactive ? pathRow("Column service", source.componentTs, trail.exact ? source.selectorLine : null) : ""}
        ${isReactive && trail.columnServiceMatch ? pathRow("Owner column service", trail.columnServiceMatch.componentTs, trail.columnServiceMatch.selectorLine) : ""}
      </table>
      ${sourceResult.ambiguous ? renderSourceCandidates(sourceResult.candidates || []) : ""}
      ${!isReactive && !source.componentTs && trail.services?.length ? renderRelatedPaths("Related column services", trail.services.map(service => service.componentTs)) : ""}
    `;
  }

  const contentNode = trail.contentId ? state.flatById.get(trail.contentId) : null;
  const contentSource = contentNode ? getNodeSource(contentNode) : source;
  return `
    <div class="notice">This is a custom modal. Its application component and template are the primary editable sources.</div>
    <table class="kv">
      ${node.runtimeTitle ? row("Runtime title", node.runtimeTitle) : ""}
      ${node.runtimeTitleKey ? row("Title key", node.runtimeTitleKey) : ""}
      ${ownerNode ? parentComponentRow(ownerNode) : ""}
      ${pathRow("Modal component", contentSource.componentTs || source.componentTs)}
      ${pathRow("Modal template", contentSource.templateUrl || source.templateUrl)}
    </table>
  `;
}

function renderRelatedPaths(title, paths) {
  const uniquePaths = Array.from(new Set(paths.filter(Boolean)));
  if (!uniquePaths.length) return "";
  return `
    <h2 class="section-title">${escapeHtml(title)}</h2>
    <table class="kv">
      ${uniquePaths.map(path => pathRow(path.split("/").pop() || title, path)).join("")}
    </table>
  `;
}

function prepareNodeSearchText(node) {
  if (!node) return;
  const sourceResult = getNodeSourceResult(node);
  const source = sourceResult.source || {};
  const candidates = [...(sourceResult.candidates || []), ...(sourceResult.allCandidates || [])];
  node.searchText = [
    node.selector,
    node.displayName,
    node.componentClassName,
    node.runtimeTitle,
    node.runtimeTitleKey,
    node.fieldInfo && Object.values(node.fieldInfo).join(" "),
    node.elementPath,
    source.className,
    source.componentTs,
    source.componentFileName,
    source.templateUrl,
    source.selectorFamily,
    source.styleUrls,
    source.relatedColumnServices,
    source.fields?.map(field => `${field.name}:${field.line}`).join(" "),
    node.sourceTrail?.services?.map(service => service.componentTs).join(" "),
    candidates.map(candidate => [candidate.className, candidate.componentTs, candidate.templateUrl].filter(Boolean).join(" ")).join(" "),
    Object.entries(node.attributes || {}).map(([key, value]) => `${key}=${value}`).join(" "),
  ]
    .filter(Boolean)
    .join(" ")
    .toLowerCase();
}

function getNodeOwner(node, sourceResult) {
  const source = sourceResult?.source || window.GIGSourceLoader.findSource(node, state.sourceIndex).source || {};
  if (source.componentTs || sourceResult?.candidates?.length) return "created";
  const selectorFamily = source.selectorFamily || window.GIGSourceLoader.getSelectorFamily(node?.selector);
  if (selectorFamily === "created") return "created";
  if (selectorFamily === "framework") return "framework";
  if (node.kind === "library") return "framework";
  if (node.kind === "app") return "created";
  return "unknown";
}

function refreshSourceDependentViews() {
  for (const node of state.flatById.values()) {
    delete node._resolvedSourceResult;
    prepareNodeSearchText(node);
  }
  if (state.scan) {
    buildSourceTree();
    renderTree(state.scan.tree);
    renderPins();
  } else {
    applyTreeFilters();
  }
  if (state.selectedId) renderDetails(state.flatById.get(state.selectedId));
}

function setIndexButtonState(status) {
  els.indexRefreshButton.classList.toggle("is-ready", status === "ready");
  els.indexRefreshButton.classList.toggle("is-missing", status === "missing");
  els.indexRefreshButton.classList.toggle("is-error", status === "error");
  els.indexRefreshButton.classList.toggle("is-loading", status === "loading");
}

function updateIndexMeta() {
  const summary = state.loadedIndexCount ? `Index: ${state.loadedIndexCount} components` : "No index";
  const updated = formatIndexUpdatedAt(state.indexUpdatedAt);
  const parts = [summary];
  if (state.projectName) parts.push(state.projectName);
  if (updated) parts.push(`Updated ${updated}`);
  if (state.scanSummary) parts.push(state.scanSummary);
  els.indexMeta.textContent = parts.join(" · ");
}

function formatIndexUpdatedAt(value) {
  if (!value) return "";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return value;
  return new Intl.DateTimeFormat(undefined, {
    month: "short",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
  }).format(date);
}

function showToast(message, isError = false) {
  els.toast.textContent = message;
  els.toast.classList.toggle("error", isError);
  els.toast.classList.remove("hidden");
  clearTimeout(showToast.timeoutId);
  showToast.timeoutId = setTimeout(() => {
    els.toast.classList.add("hidden");
  }, 3600);
}

function setStatus(text, isError = false) {
  els.statusText.textContent = text;
  els.statusText.classList.toggle("error", isError);
}

function escapeHtml(value) {
  return String(value ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#039;");
}

function cssEscape(value) {
  if (window.CSS?.escape) return CSS.escape(value);
  return value.replace(/["\\]/g, "\\$&");
}
