const els = {
  refreshButton: document.getElementById("refreshButton"),
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
  pinnedPane: document.getElementById("pinnedPane"),
  pinnedList: document.getElementById("pinnedList"),
  treeRoot: document.getElementById("treeRoot"),
  emptyDetails: document.getElementById("emptyDetails"),
  detailsContent: document.getElementById("detailsContent"),
  detailsTitle: document.getElementById("detailsTitle"),
  detailsBadges: document.getElementById("detailsBadges"),
  tabs: Array.from(document.querySelectorAll(".tab")),
  tabPanels: Array.from(document.querySelectorAll(".tab-panel")),
};

const NATIVE_HOST_NAME = "com.gng.dev_indexer";
const LOCAL_INDEX_FILE = "component-index.json";
const INDEX_UPDATED_STORAGE_KEY = "gigComponentInspector.indexUpdatedAt";
const AUTO_REFRESH_DELAY_MS = 600;

const state = {
  bridgeInjected: false,
  scan: null,
  flatById: new Map(),
  selectedId: null,
  sourceIndex: new Map(),
  loadedIndexCount: 0,
  projectRoot: "",
  ownerFilter: "all",
  collapsedIds: new Set(),
  focusRootId: null,
  parentById: new Map(),
  pins: new Map(),
  scanDiff: null,
  highlightEnabled: true,
  indexUpdatedAt: localStorage.getItem(INDEX_UPDATED_STORAGE_KEY) || "",
  scanSummary: "",
  refreshInFlight: false,
  refreshQueued: false,
  autoRefreshTimeoutId: null,
};

init();

async function init() {
  bindEvents();
  await loadLocalIndex();

  try {
    await ensureBridge();
    const pending = await getPendingContextInspect();
    if (pending) selectLastRightClickedComponent();
    else refresh();
  } catch (_error) {
    state.bridgeInjected = false;
  }
}

function bindEvents() {
  els.highlightToggle.checked = state.highlightEnabled;
  syncFilterButtons();
  els.refreshButton.addEventListener("click", () => refresh());
  els.searchInput.addEventListener("input", () => handleSearchChanged());
  els.indexRefreshButton.addEventListener("click", () => rebuildIndexWithNativeHost());
  els.clearFocusButton.addEventListener("click", () => clearTreeFocus());
  els.highlightToggle.addEventListener("change", () => setPageHighlightEnabled(els.highlightToggle.checked));
  for (const button of els.filterButtons) {
    button.addEventListener("click", () => {
      state.ownerFilter = button.dataset.filter || "all";
      syncFilterButtons();
      applyTreeFilters();
      if (state.ownerFilter === "all" && state.selectedId) selectNode(state.selectedId, { reveal: true, keepHighlight: true });
    });
  }
  els.detailsContent.addEventListener("click", handleDetailsClick);
  chrome.runtime?.onMessage?.addListener((message) => {
    if (message?.type === "gig-context-inspect" && message.tabId === chrome.devtools.inspectedWindow.tabId) {
      getPendingContextInspect().finally(() => selectLastRightClickedComponent());
    }
  });
  chrome.devtools?.network?.onNavigated?.addListener(() => {
    scheduleRefresh(AUTO_REFRESH_DELAY_MS);
  });
  document.addEventListener("visibilitychange", () => {
    if (!document.hidden) scheduleRefresh(300);
  });

  for (const tab of els.tabs) {
    tab.addEventListener("click", () => activateTab(tab.dataset.tab));
  }
}

function handleSearchChanged() {
  if (state.scan) {
    const selectedId = state.selectedId;
    renderTree(state.scan.tree);
    if (selectedId) selectNode(selectedId, { reveal: false, keepHighlight: true });
  } else {
    applyTreeFilters();
  }
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
    const manifest = await window.GIGSourceLoader.loadBundledManifest();
    if (!manifest.entries.length) {
      state.sourceIndex = new Map();
      state.loadedIndexCount = 0;
      state.projectRoot = "";
      updateIndexMeta();
      setIndexButtonState("missing");
      setStatus("Component index is missing. Click refresh index to create it.", true);
      return false;
    }

    state.sourceIndex = window.GIGSourceLoader.createIndex(manifest.entries);
    state.loadedIndexCount = manifest.entries.length;
    state.projectRoot = manifest.projectRoot || "";
    state.indexUpdatedAt = manifest.generatedAt || state.indexUpdatedAt || "";
    if (state.indexUpdatedAt) localStorage.setItem(INDEX_UPDATED_STORAGE_KEY, state.indexUpdatedAt);
    updateIndexMeta();
    setIndexButtonState("ready");
    setStatus(`Loaded ${manifest.entries.length} indexed components.`);
    refreshSourceDependentViews();
    return true;
  } catch (error) {
    state.sourceIndex = new Map();
    state.loadedIndexCount = 0;
    updateIndexMeta();
    setIndexButtonState("error");
    setStatus(`Could not load component index: ${error.message}`, true);
    return false;
  }
}

async function rebuildIndexWithNativeHost() {
  try {
    setIndexButtonState("loading");
    setStatus("Rebuilding index...");
    els.indexRefreshButton.disabled = true;
    const result = await sendNativeMessage({ type: "rebuildIndex" });
    if (!result?.ok) throw new Error(result?.error || "Native host failed to rebuild the index.");

    state.indexUpdatedAt = result.generatedAt || new Date().toISOString();
    localStorage.setItem(INDEX_UPDATED_STORAGE_KEY, state.indexUpdatedAt);
    const loaded = await loadLocalIndex();
    if (!loaded) throw new Error(`Index was rebuilt but ${LOCAL_INDEX_FILE} could not be loaded.`);
    showToast(`Index refreshed. Loaded ${state.loadedIndexCount} components.`);
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

function getPendingContextInspect() {
  return new Promise((resolve) => {
    if (!chrome.runtime?.sendMessage || typeof chrome.devtools?.inspectedWindow?.tabId !== "number") {
      resolve(false);
      return;
    }

    chrome.runtime.sendMessage(
      {
        type: "gig-panel-ready",
        tabId: chrome.devtools.inspectedWindow.tabId,
      },
      (response) => {
        if (chrome.runtime.lastError) {
          resolve(false);
          return;
        }
        resolve(Boolean(response?.hasPendingContextInspect));
      },
    );
  });
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

async function highlightNodeOnPage(id, options = {}) {
  if (!state.highlightEnabled || !id) return;
  try {
    await ensureBridge();
    const result = await evalInInspectedPage(`window.__gigComponentInspector.highlightElementById(${JSON.stringify(id)}, ${JSON.stringify(options)})`);
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

function buildParentMap(nodes, parentId = null, map = new Map()) {
  for (const node of nodes || []) {
    map.set(node.id, parentId);
    buildParentMap(node.children || [], node.id, map);
  }
  return map;
}

function getNodeSource(node) {
  return window.GIGSourceLoader.findSource(node, state.sourceIndex).source || {};
}

function getNodeKey(node) {
  if (!node) return "";
  const source = getNodeSource(node);
  return [node.selector, source.componentTs || source.templateUrl || node.elementPath].join("|");
}

function computeScanDiff(previousScan, currentScan) {
  if (!previousScan?.flatNodes?.length) return null;
  const previousByKey = new Map(previousScan.flatNodes.map((node) => [getNodeKey(node), node]));
  const currentByKey = new Map(currentScan.flatNodes.map((node) => [getNodeKey(node), node]));
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
  try {
    state.refreshQueued = false;
    setStatus("Injecting bridge...");
    await ensureBridge();
    setStatus("Scanning inspected page...");
    const result = await evalInInspectedPage(`window.__gigComponentInspector.scan({ prefixes: ['sl-', 'gsm-', 'gig-', 'gng-', 'app-'] })`);
    if (!result?.ok) {
      throw new Error(result?.message || "Scan failed.");
    }
    const previousScan = state.scan;
    state.scan = result;
    state.flatById = new Map(result.flatNodes.map((node) => [node.id, node]));
    state.parentById = buildParentMap(result.tree);
    state.scanDiff = computeScanDiff(previousScan, result);
    state.selectedId = null;
    state.collapsedIds.clear();
    state.focusRootId = null;
    renderTree(result.tree);
    renderPins();
    showEmptyDetails();
    state.scanSummary = `Found ${result.count} components${result.angularDebugApi ? " with Angular debug API" : ""}`;
    updateIndexMeta();
    setStatus(`${state.scanSummary}.`);
  } catch (error) {
    setStatus(error.message || String(error), true);
  } finally {
    state.refreshInFlight = false;
    if (state.refreshQueued && !document.hidden) {
      refresh();
    }
  }
}

function scheduleRefresh(delay = AUTO_REFRESH_DELAY_MS) {
  clearTimeout(state.autoRefreshTimeoutId);
  state.autoRefreshTimeoutId = setTimeout(() => {
    if (!document.hidden) refresh();
  }, delay);
}

async function ensureBridge() {
  if (state.bridgeInjected) {
    const existing = await evalInInspectedPage("Boolean(window.__gigComponentInspector?.scan)");
    if (existing) return;
    state.bridgeInjected = false;
  }
  const bridgeUrl = chrome.runtime.getURL("inspected-bridge.js");
  const bridgeCode = await fetch(bridgeUrl).then((response) => response.text());
  await evalInInspectedPage(bridgeCode);
  state.bridgeInjected = true;
  if (state.highlightEnabled) {
    await evalInInspectedPage("window.__gigComponentInspector.setHighlightEnabled(true)");
  }
}

function evalInInspectedPage(expression) {
  return new Promise((resolve, reject) => {
    chrome.devtools.inspectedWindow.eval(expression, { useContentScriptContext: false }, (result, exceptionInfo) => {
      if (exceptionInfo?.isException || exceptionInfo?.code) {
        reject(new Error(exceptionInfo.description || exceptionInfo.value || "DevTools eval failed."));
        return;
      }
      resolve(result);
    });
  });
}

function renderTree(tree) {
  const displayTree = getDisplayTree(tree);
  els.clearFocusButton.classList.toggle("hidden", !state.focusRootId);
  renderChangeSummary();
  els.componentCount.textContent = String(countTreeNodes(displayTree));
  if (!displayTree?.length) {
    els.treeRoot.className = "tree-root empty";
    els.treeRoot.textContent = "No matching component hosts found on this page.";
    return;
  }

  els.treeRoot.className = "tree-root";
  els.treeRoot.innerHTML = "";
  els.treeRoot.appendChild(renderTreeList(displayTree));
  applyTreeFilters();
}

function renderChangeSummary() {
  const added = state.scanDiff?.added?.length || 0;
  const removed = state.scanDiff?.removed?.length || 0;
  els.changeSummary.classList.toggle("hidden", !state.scanDiff);
  els.changeSummary.classList.toggle("has-changes", Boolean(added || removed));
  els.changeSummary.textContent = state.scanDiff ? `+${added} -${removed}` : "";
}

function getDisplayTree(tree) {
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
    const sourceResult = window.GIGSourceLoader.findSource(node, state.sourceIndex);
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
    arrow.innerHTML = node.children?.length ? iconSvg("chevron") : "";
    arrow.addEventListener("click", (event) => {
      event.stopPropagation();
      toggleTreeNode(node.id);
    });

    const label = document.createElement("span");
    label.className = "tree-label";
    const secondary = node.componentClassName || source.className || "";
    label.innerHTML = `
      <span class="selector">${highlightText(node.selector)}</span>
      ${secondary ? `<span class="secondary">${highlightText(secondary)}</span>` : ""}
    `;

    const badges = document.createElement("span");
    badges.className = "badges";
    badges.appendChild(createBadge(owner === "created" ? "App" : owner === "framework" ? "GNG" : node.kind, owner));
    if (source.componentTs) badges.appendChild(createBadge("ts", "debug"));

    const actions = document.createElement("span");
    actions.className = "tree-actions";
    if (source.componentTs) {
      const openFileButton = document.createElement("button");
      openFileButton.className = "icon-button icon-button-code tree-action-button";
      openFileButton.type = "button";
      openFileButton.title = "Open component in VS Code";
      openFileButton.setAttribute("aria-label", "Open component in VS Code");
      openFileButton.innerHTML = iconSvg("code");
      openFileButton.addEventListener("click", (event) => {
        event.stopPropagation();
        openVsCodePath(resolveProjectPath(source.componentTs));
      });
      actions.appendChild(openFileButton);
    }
    const componentFileName = getComponentFileName(source);
    if (componentFileName) {
      const copyFileNameButton = document.createElement("button");
      copyFileNameButton.className = "icon-button icon-button-copy tree-action-button";
      copyFileNameButton.type = "button";
      copyFileNameButton.title = "Copy component .ts filename";
      copyFileNameButton.setAttribute("aria-label", "Copy component .ts filename");
      copyFileNameButton.innerHTML = iconSvg("copy");
      copyFileNameButton.addEventListener("click", (event) => {
        event.stopPropagation();
        copyText(componentFileName);
        setStatus(`Copied ${componentFileName}.`);
      });
      actions.appendChild(copyFileNameButton);
    }
    const copyPathButton = document.createElement("button");
    copyPathButton.className = "icon-button icon-button-path tree-action-button";
    copyPathButton.type = "button";
    copyPathButton.title = "Copy component path";
    copyPathButton.setAttribute("aria-label", "Copy component path");
    copyPathButton.innerHTML = iconSvg("path");
    copyPathButton.addEventListener("click", (event) => {
      event.stopPropagation();
      copyText(getComponentPath(node.id));
      setStatus("Copied component path.");
    });
    actions.appendChild(copyPathButton);

    const pinButton = document.createElement("button");
    pinButton.className = "icon-button icon-button-pin tree-action-button";
    pinButton.type = "button";
    pinButton.title = "Pin component";
    pinButton.setAttribute("aria-label", "Pin component");
    pinButton.innerHTML = iconSvg(isPinned(node) ? "pinFilled" : "pin");
    pinButton.addEventListener("click", (event) => {
      event.stopPropagation();
      togglePin(node.id);
    });
    actions.appendChild(pinButton);

    const focusButton = document.createElement("button");
    focusButton.className = "icon-button icon-button-focus tree-action-button";
    focusButton.type = "button";
    focusButton.title = "Focus this component and children";
    focusButton.setAttribute("aria-label", "Focus this component and children");
    focusButton.innerHTML = iconSvg("focus");
    focusButton.addEventListener("click", (event) => {
      event.stopPropagation();
      focusTreeOn(node.id);
    });
    actions.appendChild(focusButton);

    row.append(arrow, label, actions, badges);
    row.addEventListener("click", (event) => {
      event.stopPropagation();
      selectNode(node.id);
    });
    row.addEventListener("dblclick", (event) => {
      event.stopPropagation();
      inspectNode(node.id);
    });
    row.addEventListener("mouseenter", () => highlightNodeOnPage(node.id, { durationMs: 0 }));
    row.addEventListener("mouseleave", () => clearPageHighlight());

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
      selectNode(node.id, { reveal: true });
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

function selectNode(id, options = {}) {
  state.selectedId = id;
  document.querySelectorAll(".tree-node.selected").forEach((node) => node.classList.remove("selected"));
  const row = document.querySelector(`.tree-node[data-id="${cssEscape(id)}"]`);
  row?.classList.add("selected");
  if (options.reveal) revealTreeNode(row);
  renderDetails(state.flatById.get(id));
  if (!options.keepHighlight) highlightNodeOnPage(id);
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

  const source = window.GIGSourceLoader.findSource(node, state.sourceIndex);
  const sourceInfo = source.source || {};
  const owner = getNodeOwner(node, source);

  els.emptyDetails.classList.add("hidden");
  els.detailsContent.classList.remove("hidden");
  els.detailsTitle.textContent = node.selector;
  els.detailsBadges.innerHTML = "";
  els.detailsBadges.appendChild(createBadge(owner === "created" ? "App" : owner === "framework" ? "GNG/framework" : node.kind, owner));
  if (sourceInfo.className || node.componentClassName) els.detailsBadges.appendChild(createBadge(sourceInfo.className || node.componentClassName));
  if (sourceInfo.componentTs) els.detailsBadges.appendChild(createBadge("indexed", "debug"));
  if (node.hasAngularDebugApi) els.detailsBadges.appendChild(createBadge("Angular debug", "debug"));
  if (sourceInfo.componentTs) {
    const openFileButton = document.createElement("button");
    openFileButton.className = "icon-button icon-button-code";
    openFileButton.type = "button";
    openFileButton.title = "Open component in VS Code";
    openFileButton.setAttribute("aria-label", "Open component in VS Code");
    openFileButton.dataset.openVscode = resolveProjectPath(sourceInfo.componentTs);
    openFileButton.innerHTML = iconSvg("code");
    els.detailsBadges.appendChild(openFileButton);
  }
  const componentFileName = getComponentFileName(sourceInfo);
  if (componentFileName) {
    els.detailsBadges.appendChild(
      createHeaderActionButton(
        "copy",
        "Copy component .ts filename",
        () => {
          copyText(componentFileName);
          setStatus(`Copied ${componentFileName}.`);
        },
        "copy",
      ),
    );
  }
  els.detailsBadges.appendChild(
    createHeaderActionButton("path", "Copy component path", () => {
      copyText(getComponentPath(node.id));
      setStatus("Copied component path.");
    }),
  );
  els.detailsBadges.appendChild(createHeaderActionButton(isPinned(node) ? "pinFilled" : "pin", "Pin component", () => togglePin(node.id), "pin"));

  document.getElementById("tab-overview").innerHTML = renderOverview(node, source);
  document.getElementById("tab-changes").innerHTML = renderChanges();
}

function getComponentFileName(source) {
  if (source.componentFileName) return source.componentFileName;
  const componentPath = normalizePath(source.componentTs || "");
  return componentPath ? componentPath.split("/").pop() : "";
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
}

function renderOverview(node, sourceResult) {
  const source = sourceResult.source || {};

  return `
    <table class="kv">
      ${row("Selector", node.selector)}
      ${row("Source class", source.className || "Not indexed")}
      ${pathRow("Component .ts", source.componentTs)}
      ${pathRow("Template .html", source.templateUrl)}
      ${row("Children", String(node.childIds?.length || 0))}
    </table>
    <h2 class="section-title">Attributes</h2>
    ${renderObjectTable(node.attributes, "No host attributes.")}
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

function pathRow(key, value) {
  const text = value || "Not indexed";
  return `
    <tr>
      <th>${escapeHtml(key)}</th>
      <td>
        <span class="cell-value">${highlightText(text)}</span>
        <span class="row-actions">
          ${copyButton(text)}
          ${pathActionButtons(value)}
        </span>
      </td>
    </tr>
  `;
}

function copyButton(value) {
  if (!value) return "";
  return iconButton("copy", "Copy value", `data-copy-value="${escapeHtml(value)}"`);
}

function pathActionButtons(path) {
  if (!path) return "";
  const filePath = resolveProjectPath(path);
  if (!filePath) return "";
  const folderPath = getDirectoryPath(filePath);
  return `
    ${iconButton("folder", "Open directory in VS Code", `data-open-folder="${escapeHtml(folderPath)}"`)}
    ${iconButton("code", "Open file in VS Code", `data-open-vscode="${escapeHtml(filePath)}"`)}
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

  if (target.dataset.openFolder) {
    openVsCodePath(target.dataset.openFolder);
    setStatus("Opening component directory in VS Code.");
    return;
  }

  if (target.dataset.openVscode) {
    openVsCodePath(target.dataset.openVscode);
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

async function selectLastRightClickedComponent() {
  try {
    await ensureBridge();
    let result = await evalInInspectedPage(`window.__gigComponentInspector.selectLastContextComponent({ prefixes: ['sl-', 'gsm-', 'gig-', 'gng-', 'app-'] })`);

    if (!result?.ok && result?.needsRefresh) {
      await refresh();
      result = await evalInInspectedPage(`window.__gigComponentInspector.selectLastContextComponent({ prefixes: ['sl-', 'gsm-', 'gig-', 'gng-', 'app-'] })`);
    }

    if (!result?.ok) throw new Error(result?.message || "Could not find a component for the right-clicked element.");
    makeNodeSelectableInCurrentView(result.id);
    selectNode(result.id, { reveal: true });
    activateTab("overview");
    setStatus(`Opened ${result.selector} from page right-click.`);
  } catch (error) {
    setStatus(error.message || String(error), true);
  }
}

function makeNodeSelectableInCurrentView(id) {
  if (!isNodeHiddenInTree(id)) return;

  if (state.focusRootId) {
    state.focusRootId = null;
    renderTree(state.scan?.tree || []);
  }

  if (state.ownerFilter !== "all") {
    state.ownerFilter = "all";
    syncFilterButtons();
    applyTreeFilters();
  }

  if (isNodeHiddenInTree(id) && els.searchInput.value) {
    els.searchInput.value = "";
    applyTreeFilters();
  }
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
  let visibleCount = 0;

  document.querySelectorAll(".tree-node").forEach((row) => {
    const id = row.dataset.id;
    const node = state.flatById.get(id);
    if (!node) return;
    const sourceResult = window.GIGSourceLoader.findSource(node, state.sourceIndex);
    const source = sourceResult.source || {};
    const owner = getNodeOwner(node, sourceResult);
    const kindVisible =
      state.ownerFilter === "all" ||
      (state.ownerFilter === "app" && owner === "created") ||
      (state.ownerFilter === "components" && owner === "created" && Boolean(source.componentTs)) ||
      (state.ownerFilter === "gng" && owner === "framework");
    const haystack = [
      node.selector,
      node.componentClassName,
      node.elementPath,
      source.className,
      source.componentTs,
      source.componentFileName,
      source.templateUrl,
      source.selectorFamily,
      Object.entries(node.attributes || {})
        .map(([key, value]) => `${key}=${value}`)
        .join(" "),
    ]
      .filter(Boolean)
      .join(" ")
      .toLowerCase();
    const searchVisible = !query || haystack.includes(query);
    const visible = kindVisible && searchVisible;
    row.classList.toggle("hidden-by-filter", !visible);
    if (visible) visibleCount++;
  });

  document.querySelectorAll(".tree-item").forEach((item) => {
    const ownRowVisible = !item.querySelector(":scope > .tree-node")?.classList.contains("hidden-by-filter");
    const childVisible = Boolean(item.querySelector(":scope > .tree-list .tree-node:not(.hidden-by-filter)"));
    item.classList.toggle("hidden-by-filter", !ownRowVisible && !childVisible);
  });

  const totalCount = document.querySelectorAll(".tree-node").length;
  const modeLabels = {
    all: "visible",
    app: "app",
    components: "Components",
    gng: "gng",
  };
  els.componentCount.textContent = `${visibleCount}/${totalCount} ${modeLabels[state.ownerFilter] || "visible"}`;
}

function getNodeOwner(node, sourceResult) {
  const source = sourceResult?.source || window.GIGSourceLoader.findSource(node, state.sourceIndex).source || {};
  const selectorFamily = source.selectorFamily || window.GIGSourceLoader.getSelectorFamily(node?.selector);
  if (selectorFamily === "created") return "created";
  if (selectorFamily === "framework") return "framework";
  if (node.kind === "library") return "framework";
  if (node.kind === "app") return "created";
  return "unknown";
}

function refreshSourceDependentViews() {
  if (state.scan) {
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
