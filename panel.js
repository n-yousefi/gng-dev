const els = {
  refreshButton: document.getElementById('refreshButton'),
  searchInput: document.getElementById('searchInput'),
  filterButtons: Array.from(document.querySelectorAll('.filter-button')),
  highlightToggle: document.getElementById('highlightToggle'),
  indexFileInput: document.getElementById('indexFileInput'),
  statusText: document.getElementById('statusText'),
  componentCount: document.getElementById('componentCount'),
  changeSummary: document.getElementById('changeSummary'),
  clearFocusButton: document.getElementById('clearFocusButton'),
  pinnedPane: document.getElementById('pinnedPane'),
  pinnedList: document.getElementById('pinnedList'),
  treeRoot: document.getElementById('treeRoot'),
  emptyDetails: document.getElementById('emptyDetails'),
  detailsContent: document.getElementById('detailsContent'),
  detailsTitle: document.getElementById('detailsTitle'),
  detailsBreadcrumb: document.getElementById('detailsBreadcrumb'),
  detailsSubtitle: document.getElementById('detailsSubtitle'),
  detailsBadges: document.getElementById('detailsBadges'),
  tabs: Array.from(document.querySelectorAll('.tab')),
  tabPanels: Array.from(document.querySelectorAll('.tab-panel')),
};

const state = {
  bridgeInjected: false,
  scan: null,
  flatById: new Map(),
  selectedId: null,
  sourceIndex: new Map(),
  loadedIndexCount: 0,
  projectRoot: '',
  ownerFilter: 'app',
  collapsedIds: new Set(),
  focusRootId: null,
  parentById: new Map(),
  pins: new Map(),
  scanDiff: null,
  problems: [],
  highlightEnabled: true,
};

init();

async function init() {
  bindEvents();
  setStatus('Loading source index...');
  const bundledManifest = await window.GIGSourceLoader.loadBundledManifest();
  const bundledEntries = bundledManifest.entries;
  if (bundledEntries.length) {
    state.sourceIndex = window.GIGSourceLoader.createIndex(bundledEntries);
    state.loadedIndexCount = bundledEntries.length;
    state.projectRoot = bundledManifest.projectRoot || '';
    setStatus(`Loaded ${bundledEntries.length} indexed components.`);
  } else {
    setStatus('Ready. Load an index for template source, then refresh.');
  }

  try {
    await ensureBridge();
    const pending = await getPendingContextInspect();
    if (pending) selectLastRightClickedComponent();
  } catch (_error) {
    state.bridgeInjected = false;
  }
}

function bindEvents() {
  els.highlightToggle.checked = state.highlightEnabled;
  els.refreshButton.addEventListener('click', () => refresh());
  els.searchInput.addEventListener('input', () => handleSearchChanged());
  els.clearFocusButton.addEventListener('click', () => clearTreeFocus());
  els.highlightToggle.addEventListener('change', () => setPageHighlightEnabled(els.highlightToggle.checked));
  for (const button of els.filterButtons) {
    button.addEventListener('click', () => {
      state.ownerFilter = button.dataset.filter || 'all';
      syncFilterButtons();
      applyTreeFilters();
      if (state.ownerFilter === 'all' && state.selectedId) selectNode(state.selectedId, { reveal: true, keepHighlight: true });
    });
  }
  els.indexFileInput.addEventListener('change', handleIndexFileSelected);
  els.detailsContent.addEventListener('click', handleDetailsClick);
  chrome.runtime?.onMessage?.addListener(message => {
    if (message?.type === 'gig-context-inspect' && message.tabId === chrome.devtools.inspectedWindow.tabId) {
      getPendingContextInspect().finally(() => selectLastRightClickedComponent());
    }
  });

  for (const tab of els.tabs) {
    tab.addEventListener('click', () => activateTab(tab.dataset.tab));
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
    button.classList.toggle('active', button.dataset.filter === state.ownerFilter);
  }
}

function getPendingContextInspect() {
  return new Promise(resolve => {
    chrome.runtime?.sendMessage?.(
      {
        type: 'gig-panel-ready',
        tabId: chrome.devtools.inspectedWindow.tabId,
      },
      response => resolve(Boolean(response?.hasPendingContextInspect))
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
    const result = await evalInInspectedPage(
      `window.__gigComponentInspector.highlightElementById(${JSON.stringify(id)}, ${JSON.stringify(options)})`
    );
    if (!result?.ok) throw new Error(result?.message || 'Could not highlight element.');
  } catch (error) {
    setStatus(error.message || String(error), true);
  }
}

async function clearPageHighlight() {
  try {
    await ensureBridge();
    await evalInInspectedPage('window.__gigComponentInspector.clearHighlight()');
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
  if (!node) return '';
  const source = getNodeSource(node);
  return [node.selector, source.componentTs || source.templateUrl || node.elementPath].join('|');
}

function computeScanDiff(previousScan, currentScan) {
  if (!previousScan?.flatNodes?.length) return null;
  const previousByKey = new Map(previousScan.flatNodes.map(node => [getNodeKey(node), node]));
  const currentByKey = new Map(currentScan.flatNodes.map(node => [getNodeKey(node), node]));
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

function computeProblems(scan, previousSelectedKey) {
  const problems = [];
  if (!scan?.angularDebugApi) {
    problems.push({ severity: 'warning', title: 'Angular debug API unavailable', detail: 'Runtime component instance metadata may be limited.' });
  }

  const selectorCounts = new Map();
  for (const node of scan?.flatNodes || []) {
    selectorCounts.set(node.selector, (selectorCounts.get(node.selector) || 0) + 1);
    const sourceResult = window.GIGSourceLoader.findSource(node, state.sourceIndex);
    const source = sourceResult.source || {};
    const owner = getNodeOwner(node, sourceResult);
    if (!sourceResult.found) problems.push({ severity: 'info', title: 'Missing source index', detail: node.selector });
    if (sourceResult.found && !source.templateUrl) problems.push({ severity: 'warning', title: 'Missing template path', detail: node.selector });
    if (owner === 'unknown') problems.push({ severity: 'info', title: 'Unknown owner', detail: node.selector });
  }

  for (const [selector, count] of selectorCounts) {
    if (count > 1) problems.push({ severity: 'info', title: 'Duplicate selector', detail: `${selector} appears ${count} times.` });
  }

  if (previousSelectedKey && !Array.from(state.flatById.values()).some(node => getNodeKey(node) === previousSelectedKey)) {
    problems.push({ severity: 'warning', title: 'Selected component changed', detail: 'The previously selected component is no longer present after refresh.' });
  }

  return problems;
}

async function handleIndexFileSelected(event) {
  const file = event.target.files?.[0];
  if (!file) return;
  try {
    const text = await file.text();
    const json = JSON.parse(text);
    const entries = Array.isArray(json) ? json : json.components || [];
    state.sourceIndex = window.GIGSourceLoader.createIndex(entries);
    state.loadedIndexCount = entries.length;
    state.projectRoot = Array.isArray(json) ? '' : normalizePath(json.projectRoot || '');
    setStatus(`Loaded ${entries.length} indexed components from ${file.name}.`);
    if (state.scan) {
      state.problems = computeProblems(state.scan, '');
      renderTree(state.scan.tree);
      renderPins();
    } else {
      applyTreeFilters();
    }
    if (state.selectedId) renderDetails(state.flatById.get(state.selectedId));
  } catch (error) {
    setStatus(`Could not load index: ${error.message}`, true);
  } finally {
    event.target.value = '';
  }
}

async function refresh() {
  try {
    setStatus('Injecting bridge...');
    await ensureBridge();
    setStatus('Scanning inspected page...');
    const result = await evalInInspectedPage(
      `window.__gigComponentInspector.scan({ prefixes: ['sl-', 'gsm-', 'gig-', 'gng-', 'app-'] })`
    );
    if (!result?.ok) {
      throw new Error(result?.message || 'Scan failed.');
    }
    const previousScan = state.scan;
    const previousSelectedKey = state.selectedId ? getNodeKey(state.flatById.get(state.selectedId)) : '';
    state.scan = result;
    state.flatById = new Map(result.flatNodes.map(node => [node.id, node]));
    state.parentById = buildParentMap(result.tree);
    state.scanDiff = computeScanDiff(previousScan, result);
    state.problems = computeProblems(result, previousSelectedKey);
    state.selectedId = null;
    state.collapsedIds.clear();
    state.focusRootId = null;
    renderTree(result.tree);
    renderPins();
    showEmptyDetails();
    setStatus(`Found ${result.count} components${result.angularDebugApi ? ' with Angular debug API.' : '.'}`);
  } catch (error) {
    setStatus(error.message || String(error), true);
  }
}

async function ensureBridge() {
  if (state.bridgeInjected) {
    const existing = await evalInInspectedPage('Boolean(window.__gigComponentInspector?.scan)');
    if (existing) return;
    state.bridgeInjected = false;
  }
  const bridgeUrl = chrome.runtime.getURL('inspected-bridge.js');
  const bridgeCode = await fetch(bridgeUrl).then(response => response.text());
  await evalInInspectedPage(bridgeCode);
  state.bridgeInjected = true;
  if (state.highlightEnabled) {
    await evalInInspectedPage('window.__gigComponentInspector.setHighlightEnabled(true)');
  }
}

function evalInInspectedPage(expression) {
  return new Promise((resolve, reject) => {
    chrome.devtools.inspectedWindow.eval(expression, { useContentScriptContext: false }, (result, exceptionInfo) => {
      if (exceptionInfo?.isException || exceptionInfo?.code) {
        reject(new Error(exceptionInfo.description || exceptionInfo.value || 'DevTools eval failed.'));
        return;
      }
      resolve(result);
    });
  });
}

function renderTree(tree) {
  const displayTree = getDisplayTree(tree);
  els.clearFocusButton.classList.toggle('hidden', !state.focusRootId);
  renderChangeSummary();
  els.componentCount.textContent = String(countTreeNodes(displayTree));
  if (!displayTree?.length) {
    els.treeRoot.className = 'tree-root empty';
    els.treeRoot.textContent = 'No matching component hosts found on this page.';
    return;
  }

  els.treeRoot.className = 'tree-root';
  els.treeRoot.innerHTML = '';
  els.treeRoot.appendChild(renderTreeList(displayTree));
  applyTreeFilters();
}

function renderChangeSummary() {
  const added = state.scanDiff?.added?.length || 0;
  const removed = state.scanDiff?.removed?.length || 0;
  els.changeSummary.classList.toggle('hidden', !state.scanDiff);
  els.changeSummary.classList.toggle('has-changes', Boolean(added || removed));
  els.changeSummary.textContent = state.scanDiff ? `+${added} -${removed}` : '';
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
  const list = document.createElement('ul');
  list.className = 'tree-list';

  for (const node of nodes) {
    const sourceResult = window.GIGSourceLoader.findSource(node, state.sourceIndex);
    const source = sourceResult.source || {};
    const owner = getNodeOwner(node, sourceResult);
    const item = document.createElement('li');
    item.className = 'tree-item';
    item.dataset.id = node.id;
    item.classList.toggle('collapsed', state.collapsedIds.has(node.id));

    const row = document.createElement('div');
    row.className = 'tree-node';
    row.dataset.id = node.id;
    row.dataset.kind = node.kind;
    row.dataset.owner = owner;

    const arrow = document.createElement('button');
    arrow.className = 'tree-arrow';
    arrow.type = 'button';
    arrow.title = node.children?.length ? 'Collapse or expand children' : '';
    arrow.disabled = !node.children?.length;
    arrow.innerHTML = node.children?.length ? iconSvg('chevron') : '';
    arrow.addEventListener('click', event => {
      event.stopPropagation();
      toggleTreeNode(node.id);
    });

    const label = document.createElement('span');
    label.className = 'tree-label';
    const secondary = node.componentClassName || source.className || '';
    label.innerHTML = `
      <span class="selector">${highlightText(node.selector)}</span>
      ${secondary ? `<span class="secondary">${highlightText(secondary)}</span>` : ''}
    `;

    const badges = document.createElement('span');
    badges.className = 'badges';
    badges.appendChild(createBadge(owner === 'created' ? 'App' : owner === 'framework' ? 'GNG' : node.kind, owner));
    if (source.componentTs) badges.appendChild(createBadge('ts', 'debug'));

    const actions = document.createElement('span');
    actions.className = 'tree-actions';
    if (source.componentTs) {
      const openFileButton = document.createElement('button');
      openFileButton.className = 'icon-button icon-button-code tree-action-button';
      openFileButton.type = 'button';
      openFileButton.title = 'Open component in VS Code';
      openFileButton.setAttribute('aria-label', 'Open component in VS Code');
      openFileButton.innerHTML = iconSvg('code');
      openFileButton.addEventListener('click', event => {
        event.stopPropagation();
        openVsCodePath(resolveProjectPath(source.componentTs));
      });
      actions.appendChild(openFileButton);
    }
    const copyPathButton = document.createElement('button');
    copyPathButton.className = 'icon-button icon-button-path tree-action-button';
    copyPathButton.type = 'button';
    copyPathButton.title = 'Copy component path';
    copyPathButton.setAttribute('aria-label', 'Copy component path');
    copyPathButton.innerHTML = iconSvg('path');
    copyPathButton.addEventListener('click', event => {
      event.stopPropagation();
      copyText(getComponentPath(node.id));
      setStatus('Copied component path.');
    });
    actions.appendChild(copyPathButton);

    const pinButton = document.createElement('button');
    pinButton.className = 'icon-button icon-button-pin tree-action-button';
    pinButton.type = 'button';
    pinButton.title = 'Pin component';
    pinButton.setAttribute('aria-label', 'Pin component');
    pinButton.innerHTML = iconSvg(isPinned(node) ? 'pinFilled' : 'pin');
    pinButton.addEventListener('click', event => {
      event.stopPropagation();
      togglePin(node.id);
    });
    actions.appendChild(pinButton);

    const focusButton = document.createElement('button');
    focusButton.className = 'icon-button icon-button-focus tree-action-button';
    focusButton.type = 'button';
    focusButton.title = 'Focus this component and children';
    focusButton.setAttribute('aria-label', 'Focus this component and children');
    focusButton.innerHTML = iconSvg('focus');
    focusButton.addEventListener('click', event => {
      event.stopPropagation();
      focusTreeOn(node.id);
    });
    actions.appendChild(focusButton);

    row.append(arrow, label, actions, badges);
    row.addEventListener('click', event => {
      event.stopPropagation();
      selectNode(node.id);
    });
    row.addEventListener('dblclick', event => {
      event.stopPropagation();
      inspectNode(node.id);
    });
    row.addEventListener('mouseenter', () => highlightNodeOnPage(node.id, { durationMs: 0 }));
    row.addEventListener('mouseleave', () => clearPageHighlight());

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
  item?.classList.toggle('collapsed', state.collapsedIds.has(id));
}

function focusTreeOn(id) {
  state.focusRootId = id;
  state.collapsedIds.delete(id);
  renderTree(state.scan?.tree || []);
  selectNode(id, { reveal: true });
  setStatus('Focused component subtree.');
}

function clearTreeFocus() {
  const previousSelection = state.selectedId;
  state.focusRootId = null;
  renderTree(state.scan?.tree || []);
  if (previousSelection) selectNode(previousSelection, { reveal: true });
  setStatus('Showing full component tree.');
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
  return getComponentAncestors(id).map(node => node.selector).join(' > ');
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
    setStatus('Unpinned component.');
  } else {
    const source = getNodeSource(node);
    state.pins.set(key, {
      key,
      selector: node.selector,
      label: node.componentClassName || source.className || node.selector,
      sourcePath: source.componentTs || source.templateUrl || '',
    });
    setStatus('Pinned component.');
  }
  renderPins();
  renderTree(state.scan?.tree || []);
  if (state.selectedId) selectNode(state.selectedId, { reveal: false, keepHighlight: true });
}

function renderPins() {
  const pins = Array.from(state.pins.values());
  els.pinnedPane.classList.toggle('hidden', !pins.length);
  els.pinnedList.innerHTML = '';
  for (const pin of pins) {
    const button = document.createElement('button');
    button.className = 'pinned-chip';
    button.type = 'button';
    button.title = pin.sourcePath || pin.selector;
    button.innerHTML = `${iconSvg('pinFilled')}<span>${escapeHtml(pin.selector)}</span>`;
    button.addEventListener('click', () => {
      const node = findPinnedNode(pin);
      if (!node) {
        setStatus('Pinned component is not present in the current scan.', true);
        return;
      }
      selectNode(node.id, { reveal: true });
    });
    els.pinnedList.appendChild(button);
  }
}

function findPinnedNode(pin) {
  return Array.from(state.flatById.values()).find(node => getNodeKey(node) === pin.key);
}

function createBadge(text, className = '') {
  const badge = document.createElement('span');
  badge.className = `badge ${className || ''}`.trim();
  badge.textContent = text;
  return badge;
}

function selectNode(id, options = {}) {
  state.selectedId = id;
  document.querySelectorAll('.tree-node.selected').forEach(node => node.classList.remove('selected'));
  const row = document.querySelector(`.tree-node[data-id="${cssEscape(id)}"]`);
  row?.classList.add('selected');
  if (options.reveal) revealTreeNode(row);
  renderDetails(state.flatById.get(id));
  if (!options.keepHighlight) highlightNodeOnPage(id);
}

function revealTreeNode(row) {
  if (!row) return;
  let current = row.closest('.tree-item');
  while (current) {
    current.classList.remove('hidden-by-filter');
    current.classList.remove('collapsed');
    if (current.dataset.id) state.collapsedIds.delete(current.dataset.id);
    const parentList = current.parentElement?.closest('.tree-item');
    current = parentList;
  }
  row.classList.remove('hidden-by-filter');
  row.scrollIntoView({ block: 'center', inline: 'nearest' });
}

async function inspectNode(id) {
  try {
    await ensureBridge();
    const result = await evalInInspectedPage(
      `window.__gigComponentInspector.inspectElementById(${JSON.stringify(id)})`
    );
    if (!result?.ok) throw new Error(result?.message || 'Could not inspect element.');
    setStatus('Selected component host in Elements.');
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

  els.emptyDetails.classList.add('hidden');
  els.detailsContent.classList.remove('hidden');
  els.detailsTitle.textContent = node.selector;
  els.detailsBreadcrumb.innerHTML = highlightText(getComponentPath(node.id));
  els.detailsSubtitle.textContent = sourceInfo.componentTs || sourceInfo.routeHint || node.elementPath;
  els.detailsBadges.innerHTML = '';
  els.detailsBadges.appendChild(createBadge(owner === 'created' ? 'App' : owner === 'framework' ? 'GNG/framework' : node.kind, owner));
  if (sourceInfo.className || node.componentClassName) els.detailsBadges.appendChild(createBadge(sourceInfo.className || node.componentClassName));
  if (sourceInfo.componentTs) els.detailsBadges.appendChild(createBadge('indexed', 'debug'));
  if (node.hasAngularDebugApi) els.detailsBadges.appendChild(createBadge('Angular debug', 'debug'));
  if (sourceInfo.componentTs) {
    const openFileButton = document.createElement('button');
    openFileButton.className = 'icon-button icon-button-code';
    openFileButton.type = 'button';
    openFileButton.title = 'Open component in VS Code';
    openFileButton.setAttribute('aria-label', 'Open component in VS Code');
    openFileButton.dataset.openVscode = resolveProjectPath(sourceInfo.componentTs);
    openFileButton.innerHTML = iconSvg('code');
    els.detailsBadges.appendChild(openFileButton);
  }
  els.detailsBadges.appendChild(createHeaderActionButton('path', 'Copy component path', () => {
    copyText(getComponentPath(node.id));
    setStatus('Copied component path.');
  }));
  els.detailsBadges.appendChild(createHeaderActionButton(isPinned(node) ? 'pinFilled' : 'pin', 'Pin component', () => togglePin(node.id), 'pin'));
  els.detailsBadges.appendChild(createHeaderActionButton('template', 'Open parent template at tag', () => openParentTemplateAtTag(node.id), 'template'));

  document.getElementById('tab-overview').innerHTML = renderOverview(node, source);
  document.getElementById('tab-attributes').innerHTML = renderObjectTable(node.attributes, 'No host attributes.');
  document.getElementById('tab-component').innerHTML = renderComponentInfo(node, source);
  document.getElementById('tab-template').innerHTML = renderTemplate(source);
  document.getElementById('tab-changes').innerHTML = renderChanges();
  document.getElementById('tab-problems').innerHTML = renderProblems();
  document.getElementById('tab-dom').innerHTML = `<pre class="code-block">${escapeHtml(node.domPreview || '')}</pre>`;
}

function createHeaderActionButton(iconName, title, onClick, className = iconName) {
  const button = document.createElement('button');
  button.className = `icon-button icon-button-${className}`;
  button.type = 'button';
  button.title = title;
  button.setAttribute('aria-label', title);
  button.innerHTML = iconSvg(iconName);
  button.addEventListener('click', event => {
    event.stopPropagation();
    onClick();
  });
  return button;
}

function showEmptyDetails() {
  els.emptyDetails.classList.remove('hidden');
  els.detailsContent.classList.add('hidden');
}

function renderOverview(node, sourceResult) {
  const source = sourceResult.source || {};
  const owner = getNodeOwner(node, sourceResult);
  const searchHint = [source.className, node.selector, source.componentFileName, source.routeHint]
    .filter(Boolean)
    .join(' ');

  return `
    <table class="kv">
      ${row('Selector', node.selector)}
      ${row('Owner', owner === 'created' ? 'App component' : owner === 'framework' ? 'GNG/GIG/GSM framework component' : 'Unknown')}
      ${row('Runtime kind', node.kind)}
      ${row('Source class', source.className || 'Not indexed')}
      ${row('Runtime class', node.componentClassName || 'Not available')}
      ${pathRow('Component .ts', source.componentTs)}
      ${pathRow('Template .html', source.templateUrl)}
      ${row('Component folder', source.componentDir || 'Not indexed')}
      ${row('Route/page hint', source.routeHint || 'Not indexed')}
      ${row('Search hint', searchHint || node.selector)}
      ${row('Element path', node.elementPath)}
      ${row('Children', String(node.childIds?.length || 0))}
      ${row('Angular debug API', node.hasAngularDebugApi ? 'Available' : 'Not available')}
      ${row('Template source', sourceResult.message)}
      ${row('Loaded index entries', String(state.loadedIndexCount))}
    </table>
  `;
}

function renderComponentInfo(node, sourceResult) {
  const source = sourceResult.source || {};
  const parts = [];
  parts.push('<h2 class="section-title">Source Metadata</h2>');
  parts.push(renderObjectTable({
    selector: source.selector,
    ownerType: source.ownerType,
    selectorFamily: source.selectorFamily,
    className: source.className,
    componentTs: source.componentTs,
    componentFileName: source.componentFileName,
    componentDir: source.componentDir,
    routeHint: source.routeHint,
    templateUrl: source.templateUrl,
    templateFileName: source.templateFileName,
    styleUrls: source.styleUrls,
  }, 'No source metadata found. Regenerate or load component-index.json.'));
  parts.push('<h2 class="section-title">Directives</h2>');
  parts.push(renderArray(node.directiveNames, 'No directive metadata available.'));
  parts.push('<h2 class="section-title">Inputs</h2>');
  parts.push(renderIoTable(node.inputs, 'No Angular input metadata available.'));
  parts.push('<h2 class="section-title">Outputs</h2>');
  parts.push(renderIoTable(node.outputs, 'No Angular output metadata available.'));
  parts.push('<h2 class="section-title">Safe Component Instance Summary</h2>');
  parts.push(renderObjectTable(node.componentInstanceSummary, 'No component instance summary available.'));
  parts.push('<h2 class="section-title">Component Properties</h2>');
  parts.push(renderObjectTable(node.componentProperties, 'No component properties available.'));
  if (node.debugErrors?.component || node.debugErrors?.directives) {
    parts.push('<h2 class="section-title">Debug API Errors</h2>');
    parts.push(renderObjectTable(node.debugErrors, 'No errors.'));
  }
  return parts.join('');
}

function renderIoTable(items, emptyText) {
  if (!items?.length) return `<div class="notice">${escapeHtml(emptyText)}</div>`;
  return `
    <table class="kv">
      ${items.map(item => row(item.publicName, item.propertyName === item.publicName ? item.publicName : `${item.propertyName}${item.declaredName ? ` (${item.declaredName})` : ''}`)).join('')}
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
      ${added.map(node => renderSummaryItem(node, 'added')).join('')}
      ${removed.map(node => renderSummaryItem(node, 'removed')).join('')}
    </div>
  `;
}

function renderSummaryItem(node, type) {
  return `
    <div class="summary-item ${type}">
      <strong>${type === 'added' ? 'Added' : 'Removed'}:</strong>
      <span>${highlightText(node.selector)}</span>
      ${node.componentClassName ? `<span class="secondary">${highlightText(node.componentClassName)}</span>` : ''}
    </div>
  `;
}

function renderProblems() {
  if (!state.problems.length) return '<div class="notice">No scan problems found.</div>';
  return `
    <table class="kv">
      ${state.problems.map(problem => row(problem.title, problem.detail || problem.severity)).join('')}
    </table>
  `;
}

function renderTemplate(sourceResult) {
  const source = sourceResult.source || {};
  const componentPath = source.componentTs || '';
  const header = `
    <table class="kv source-summary">
      ${pathRow('Component .ts', componentPath)}
      ${pathRow('Template .html', source.templateUrl)}
    </table>
  `;
  if (source.templateHtml) {
    return `
      ${header}
      <pre class="code-block">${escapeHtml(source.templateHtml)}</pre>
    `;
  }
  return `
    <div class="notice">${escapeHtml(sourceResult.message)}</div>
    ${header}
  `;
}

function renderObjectTable(object, emptyText) {
  const entries = Object.entries(object || {}).filter(([, value]) => value !== undefined && value !== '' && value !== null);
  if (!entries.length) return `<div class="notice">${escapeHtml(emptyText)}</div>`;
  return `
    <table class="kv">
      ${entries.map(([key, value]) => row(key, formatValue(value))).join('')}
    </table>
  `;
}

function renderArray(items, emptyText) {
  if (!items?.length) return `<div class="notice">${escapeHtml(emptyText)}</div>`;
  return `<table class="kv">${items.map((item, index) => row(String(index + 1), item)).join('')}</table>`;
}

function formatValue(value) {
  if (value == null) return '';
  if (Array.isArray(value)) return value.join('\n');
  if (typeof value === 'string') return value;
  return JSON.stringify(value, null, 2);
}

function highlightText(value) {
  const text = String(value ?? '');
  const query = els.searchInput.value.trim();
  if (!query) return escapeHtml(text);
  const lowerText = text.toLowerCase();
  const lowerQuery = query.toLowerCase();
  let index = 0;
  let output = '';
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
  const text = value || 'Not indexed';
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
  if (!value) return '';
  return iconButton('copy', 'Copy value', `data-copy-value="${escapeHtml(value)}"`);
}

function pathActionButtons(path) {
  if (!path) return '';
  const filePath = resolveProjectPath(path);
  if (!filePath) return '';
  const folderPath = getDirectoryPath(filePath);
  return `
    ${iconButton('folder', 'Open directory in VS Code', `data-open-folder="${escapeHtml(folderPath)}"`)}
    ${iconButton('code', 'Open file in VS Code', `data-open-vscode="${escapeHtml(filePath)}"`)}
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
    folder: '<svg viewBox="0 0 16 16" aria-hidden="true"><path d="M2.5 5.5h4l1.2 1.5h5.8v5.2c0 .7-.4 1.1-1.1 1.1H3.6c-.7 0-1.1-.4-1.1-1.1V5.5Z"></path><path d="M2.5 5.5V4.2c0-.7.4-1.1 1.1-1.1h2.5l1.1 1.2h5.2c.7 0 1.1.4 1.1 1.1V7"></path></svg>',
    code: '<svg viewBox="0 0 16 16" aria-hidden="true"><path d="m6.3 4-3.5 4 3.5 4"></path><path d="m9.7 4 3.5 4-3.5 4"></path></svg>',
    focus: '<svg viewBox="0 0 16 16" aria-hidden="true"><circle cx="8" cy="8" r="2.2"></circle><path d="M2.5 6V3.5h2.5"></path><path d="M11 3.5h2.5V6"></path><path d="M13.5 10v2.5H11"></path><path d="M5 12.5H2.5V10"></path></svg>',
    pin: '<svg viewBox="0 0 16 16" aria-hidden="true"><path d="M9.8 2.7 13.3 6.2"></path><path d="m6.6 9.4-3.1 3.1"></path><path d="M5.1 8.1 8.1 3.7l4.2 4.2-4.4 3-2.8-2.8Z"></path></svg>',
    pinFilled: '<svg viewBox="0 0 16 16" aria-hidden="true"><path d="M9.8 2.7 13.3 6.2"></path><path d="m6.6 9.4-3.1 3.1"></path><path d="M5.1 8.1 8.1 3.7l4.2 4.2-4.4 3-2.8-2.8Z"></path></svg>',
    path: '<svg viewBox="0 0 16 16" aria-hidden="true"><circle cx="4" cy="4" r="1.5"></circle><circle cx="12" cy="12" r="1.5"></circle><path d="M5.5 4h2.8A3.7 3.7 0 0 1 12 7.7V10.5"></path></svg>',
    template: '<svg viewBox="0 0 16 16" aria-hidden="true"><path d="M3 2.5h10v11H3z"></path><path d="M5 5h6"></path><path d="M5 8h6"></path><path d="M5 11h3"></path></svg>',
    chevron: '<svg viewBox="0 0 16 16" aria-hidden="true"><path d="m6 4 4 4-4 4"></path></svg>',
  };
  return icons[name] || icons.copy;
}

async function handleDetailsClick(event) {
  const target = event.target.closest('button');
  if (!target) return;

  if (target.dataset.copyValue !== undefined) {
    await copyText(target.dataset.copyValue);
    setStatus('Copied value.');
    return;
  }

  if (target.dataset.openFolder) {
    openVsCodePath(target.dataset.openFolder);
    setStatus('Opening component directory in VS Code.');
    return;
  }

  if (target.dataset.openVscode) {
    openVsCodePath(target.dataset.openVscode);
    setStatus('Opening file in VS Code.');
  }
}

function openParentTemplateAtTag(id) {
  const selected = state.flatById.get(id);
  if (!selected) return;
  let parentId = state.parentById.get(id);
  while (parentId) {
    const parent = state.flatById.get(parentId);
    const sourceResult = window.GIGSourceLoader.findSource(parent, state.sourceIndex);
    const source = sourceResult.source || {};
    if (source.templateUrl) {
      const path = resolveProjectPath(source.templateUrl);
      const match = source.templateHtml ? findSelectorInTemplate(source.templateHtml, selected.selector) : null;
      if (match) {
        openVsCodeLocation(path, match.line, match.column);
        setStatus(`Opening parent template at ${selected.selector}.`);
      } else {
        openVsCodePath(path);
        setStatus('Opening parent template. Selector tag was not found in indexed HTML.');
      }
      return;
    }
    parentId = state.parentById.get(parentId);
  }
  setStatus('No indexed parent template found.', true);
}

function findSelectorInTemplate(templateHtml, selector) {
  const pattern = new RegExp(`<\\s*${escapeRegExp(selector)}(?:\\s|>|/)`, 'i');
  const match = pattern.exec(templateHtml);
  if (!match) return null;
  const before = templateHtml.slice(0, match.index);
  const lines = before.split(/\r\n|\r|\n/);
  return {
    line: lines.length,
    column: lines[lines.length - 1].length + 1,
  };
}

function escapeRegExp(value) {
  return String(value).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

async function copyText(text) {
  if (navigator.clipboard?.writeText) {
    await navigator.clipboard.writeText(text);
    return;
  }

  const textarea = document.createElement('textarea');
  textarea.value = text;
  textarea.style.position = 'fixed';
  textarea.style.opacity = '0';
  document.body.appendChild(textarea);
  textarea.select();
  document.execCommand('copy');
  textarea.remove();
}

function openExternalUrl(url) {
  if (chrome.tabs?.create) {
    chrome.tabs.create({ url });
    return;
  }
  window.open(url, '_blank', 'noopener');
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
    let result = await evalInInspectedPage(
      `window.__gigComponentInspector.selectLastContextComponent({ prefixes: ['sl-', 'gsm-', 'gig-', 'gng-', 'app-'] })`
    );

    if (!result?.ok && result?.needsRefresh) {
      await refresh();
      result = await evalInInspectedPage(
        `window.__gigComponentInspector.selectLastContextComponent({ prefixes: ['sl-', 'gsm-', 'gig-', 'gng-', 'app-'] })`
      );
    }

    if (!result?.ok) throw new Error(result?.message || 'Could not find a component for the right-clicked element.');
    selectNode(result.id, { reveal: true });
    activateTab('overview');
    setStatus(`Opened ${result.selector} from page right-click.`);
  } catch (error) {
    setStatus(error.message || String(error), true);
  }
}

function resolveProjectPath(path) {
  const normalized = normalizePath(path);
  if (!normalized || normalized === 'Not indexed') return '';
  if (/^[a-zA-Z]:\//.test(normalized) || normalized.startsWith('/')) return normalized;
  if (!state.projectRoot) return normalized;
  return `${state.projectRoot.replace(/\/$/, '')}/${normalized}`;
}

function getDirectoryPath(path) {
  return normalizePath(path).split('/').slice(0, -1).join('/');
}

function pathToVsCodeUrl(path) {
  const normalized = normalizePath(path);
  const parts = normalized.split('/').map((part, index) => {
    if (index === 0 && /^[a-zA-Z]:$/.test(part)) return part;
    return encodeURIComponent(part);
  });
  return `vscode://file/${parts.join('/')}`;
}

function normalizePath(path) {
  return (path || '').replace(/\\/g, '/');
}

function activateTab(name) {
  for (const tab of els.tabs) tab.classList.toggle('active', tab.dataset.tab === name);
  for (const panel of els.tabPanels) panel.classList.toggle('active', panel.id === `tab-${name}`);
}

function applyTreeFilters() {
  const query = els.searchInput.value.trim().toLowerCase();
  let visibleCount = 0;

  document.querySelectorAll('.tree-node').forEach(row => {
    const id = row.dataset.id;
    const node = state.flatById.get(id);
    if (!node) return;
    const sourceResult = window.GIGSourceLoader.findSource(node, state.sourceIndex);
    const source = sourceResult.source || {};
    const owner = getNodeOwner(node, sourceResult);
    const kindVisible =
      state.ownerFilter === 'all' ||
      (state.ownerFilter === 'app' && owner === 'created') ||
      (state.ownerFilter === 'indexed-app' && owner === 'created' && Boolean(source.componentTs)) ||
      (state.ownerFilter === 'gng' && owner === 'framework');
    const haystack = [
      node.selector,
      node.componentClassName,
      node.elementPath,
      source.className,
      source.componentTs,
      source.componentFileName,
      source.componentDir,
      source.routeHint,
      source.templateUrl,
      source.templateFileName,
      source.ownerType,
      source.selectorFamily,
      Object.entries(node.attributes || {}).map(([key, value]) => `${key}=${value}`).join(' '),
    ]
      .filter(Boolean)
      .join(' ')
      .toLowerCase();
    const searchVisible = !query || haystack.includes(query);
    const visible = kindVisible && searchVisible;
    row.classList.toggle('hidden-by-filter', !visible);
    if (visible) visibleCount++;
  });

  document.querySelectorAll('.tree-item').forEach(item => {
    const ownRowVisible = !item.querySelector(':scope > .tree-node')?.classList.contains('hidden-by-filter');
    const childVisible = Boolean(item.querySelector(':scope > .tree-list .tree-node:not(.hidden-by-filter)'));
    item.classList.toggle('hidden-by-filter', !ownRowVisible && !childVisible);
  });

  const totalCount = document.querySelectorAll('.tree-node').length;
  const modeLabels = {
    all: 'visible',
    app: 'app',
    'indexed-app': 'indexed app',
    gng: 'gng',
  };
  els.componentCount.textContent = `${visibleCount}/${totalCount} ${modeLabels[state.ownerFilter] || 'visible'}`;
}

function getNodeOwner(node, sourceResult) {
  if (window.GIGSourceLoader.isCreatedComponent(node, state.sourceIndex)) return 'created';
  const source = sourceResult?.source || window.GIGSourceLoader.findSource(node, state.sourceIndex).source || {};
  const ownerType = source.ownerType || source.selectorFamily;
  if (ownerType === 'framework') return 'framework';
  if (node.kind === 'library') return 'framework';
  if (node.kind === 'app') return 'created';
  return 'unknown';
}

function setStatus(text, isError = false) {
  els.statusText.textContent = text;
  els.statusText.classList.toggle('error', isError);
}

function escapeHtml(value) {
  return String(value ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#039;');
}

function cssEscape(value) {
  if (window.CSS?.escape) return CSS.escape(value);
  return value.replace(/["\\]/g, '\\$&');
}
