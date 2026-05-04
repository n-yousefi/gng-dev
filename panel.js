const els = {
  refreshButton: document.getElementById('refreshButton'),
  searchInput: document.getElementById('searchInput'),
  customOnlyToggle: document.getElementById('customOnlyToggle'),
  showAppToggle: document.getElementById('showAppToggle'),
  showLibraryToggle: document.getElementById('showLibraryToggle'),
  indexFileInput: document.getElementById('indexFileInput'),
  statusText: document.getElementById('statusText'),
  componentCount: document.getElementById('componentCount'),
  treeRoot: document.getElementById('treeRoot'),
  emptyDetails: document.getElementById('emptyDetails'),
  detailsContent: document.getElementById('detailsContent'),
  detailsTitle: document.getElementById('detailsTitle'),
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
};

init();

async function init() {
  bindEvents();
  setStatus('Loading source index...');
  const bundledEntries = await window.GIGSourceLoader.loadBundledIndex();
  if (bundledEntries.length) {
    state.sourceIndex = window.GIGSourceLoader.createIndex(bundledEntries);
    state.loadedIndexCount = bundledEntries.length;
    setStatus(`Loaded ${bundledEntries.length} indexed components.`);
  } else {
    setStatus('Ready. Load an index for template source, then refresh.');
  }
}

function bindEvents() {
  els.refreshButton.addEventListener('click', () => refresh());
  els.searchInput.addEventListener('input', () => applyTreeFilters());
  els.customOnlyToggle.addEventListener('change', () => {
    els.showAppToggle.disabled = els.customOnlyToggle.checked;
    els.showLibraryToggle.disabled = els.customOnlyToggle.checked;
    applyTreeFilters();
  });
  els.showAppToggle.addEventListener('change', () => applyTreeFilters());
  els.showLibraryToggle.addEventListener('change', () => applyTreeFilters());
  els.indexFileInput.addEventListener('change', handleIndexFileSelected);

  for (const tab of els.tabs) {
    tab.addEventListener('click', () => activateTab(tab.dataset.tab));
  }
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
    setStatus(`Loaded ${entries.length} indexed components from ${file.name}.`);
    applyTreeFilters();
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
    state.scan = result;
    state.flatById = new Map(result.flatNodes.map(node => [node.id, node]));
    state.selectedId = null;
    renderTree(result.tree);
    showEmptyDetails();
    setStatus(`Found ${result.count} components${result.angularDebugApi ? ' with Angular debug API.' : '.'}`);
  } catch (error) {
    setStatus(error.message || String(error), true);
  }
}

async function ensureBridge() {
  if (state.bridgeInjected) return;
  const bridgeUrl = chrome.runtime.getURL('inspected-bridge.js');
  const bridgeCode = await fetch(bridgeUrl).then(response => response.text());
  await evalInInspectedPage(bridgeCode);
  state.bridgeInjected = true;
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
  els.componentCount.textContent = String(state.scan?.count || 0);
  if (!tree?.length) {
    els.treeRoot.className = 'tree-root empty';
    els.treeRoot.textContent = 'No matching component hosts found on this page.';
    return;
  }

  els.treeRoot.className = 'tree-root';
  els.treeRoot.innerHTML = '';
  els.treeRoot.appendChild(renderTreeList(tree));
  applyTreeFilters();
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

    const row = document.createElement('div');
    row.className = 'tree-node';
    row.dataset.id = node.id;
    row.dataset.kind = node.kind;
    row.dataset.owner = owner;

    const arrow = document.createElement('span');
    arrow.className = 'tree-arrow';
    arrow.textContent = node.children?.length ? 'v' : '';

    const label = document.createElement('span');
    label.className = 'tree-label';
    const secondary = source.componentTs || source.routeHint || node.componentClassName || source.className || '';
    label.innerHTML = `
      <span class="selector">${escapeHtml(node.selector)}</span>
      ${secondary ? `<span class="secondary">${escapeHtml(secondary)}</span>` : ''}
    `;

    const badges = document.createElement('span');
    badges.className = 'badges';
    badges.appendChild(createBadge(owner === 'created' ? 'created' : owner === 'framework' ? 'GNG' : node.kind, owner));
    if (source.componentTs) badges.appendChild(createBadge('ts', 'debug'));
    if (node.hasAngularDebugApi) badges.appendChild(createBadge('debug', 'debug'));

    row.append(arrow, label, badges);
    row.addEventListener('click', event => {
      event.stopPropagation();
      selectNode(node.id);
    });
    row.addEventListener('dblclick', event => {
      event.stopPropagation();
      inspectNode(node.id);
    });

    item.appendChild(row);
    if (node.children?.length) item.appendChild(renderTreeList(node.children));
    list.appendChild(item);
  }

  return list;
}

function createBadge(text, className = '') {
  const badge = document.createElement('span');
  badge.className = `badge ${className || ''}`.trim();
  badge.textContent = text;
  return badge;
}

function selectNode(id) {
  state.selectedId = id;
  document.querySelectorAll('.tree-node.selected').forEach(node => node.classList.remove('selected'));
  document.querySelector(`.tree-node[data-id="${cssEscape(id)}"]`)?.classList.add('selected');
  renderDetails(state.flatById.get(id));
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
  els.detailsSubtitle.textContent = sourceInfo.componentTs || sourceInfo.routeHint || node.elementPath;
  els.detailsBadges.innerHTML = '';
  els.detailsBadges.appendChild(createBadge(owner === 'created' ? 'created/app' : owner === 'framework' ? 'GNG/framework' : node.kind, owner));
  if (sourceInfo.className || node.componentClassName) els.detailsBadges.appendChild(createBadge(sourceInfo.className || node.componentClassName));
  if (sourceInfo.componentTs) els.detailsBadges.appendChild(createBadge('indexed', 'debug'));
  if (node.hasAngularDebugApi) els.detailsBadges.appendChild(createBadge('Angular debug', 'debug'));

  document.getElementById('tab-overview').innerHTML = renderOverview(node, source);
  document.getElementById('tab-attributes').innerHTML = renderObjectTable(node.attributes, 'No host attributes.');
  document.getElementById('tab-component').innerHTML = renderComponentInfo(node, source);
  document.getElementById('tab-template').innerHTML = renderTemplate(source);
  document.getElementById('tab-dom').innerHTML = `<pre class="code-block">${escapeHtml(node.domPreview || '')}</pre>`;
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
      ${row('Owner', owner === 'created' ? 'Created/app component' : owner === 'framework' ? 'GNG/GIG/GSM framework component' : 'Unknown')}
      ${row('Runtime kind', node.kind)}
      ${row('Source class', source.className || 'Not indexed')}
      ${row('Runtime class', node.componentClassName || 'Not available')}
      ${row('Component .ts', source.componentTs || 'Not indexed')}
      ${row('Template .html', source.templateUrl || 'Not indexed')}
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
  parts.push('<h2 class="section-title">Safe Component Instance Summary</h2>');
  parts.push(renderObjectTable(node.componentInstanceSummary, 'No component instance summary available.'));
  if (node.debugErrors?.component || node.debugErrors?.directives) {
    parts.push('<h2 class="section-title">Debug API Errors</h2>');
    parts.push(renderObjectTable(node.debugErrors, 'No errors.'));
  }
  return parts.join('');
}

function renderTemplate(sourceResult) {
  const source = sourceResult.source || {};
  const path = source.templateUrl || 'Unknown template path';
  const componentPath = source.componentTs || '';
  const header = `
    <table class="kv source-summary">
      ${row('Component .ts', componentPath || 'Not indexed')}
      ${row('Template .html', path)}
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

function row(key, value) {
  return `<tr><th>${escapeHtml(key)}</th><td>${escapeHtml(value)}</td></tr>`;
}

function activateTab(name) {
  for (const tab of els.tabs) tab.classList.toggle('active', tab.dataset.tab === name);
  for (const panel of els.tabPanels) panel.classList.toggle('active', panel.id === `tab-${name}`);
}

function applyTreeFilters() {
  const query = els.searchInput.value.trim().toLowerCase();
  const customOnly = els.customOnlyToggle.checked;
  const showApp = els.showAppToggle.checked;
  const showLibrary = els.showLibraryToggle.checked;
  let visibleCount = 0;

  document.querySelectorAll('.tree-node').forEach(row => {
    const id = row.dataset.id;
    const node = state.flatById.get(id);
    if (!node) return;
    const sourceResult = window.GIGSourceLoader.findSource(node, state.sourceIndex);
    const source = sourceResult.source || {};
    const owner = getNodeOwner(node, sourceResult);
    const kindVisible = customOnly
      ? owner === 'created'
      : (node.kind === 'app' && showApp) || (node.kind === 'library' && showLibrary) || node.kind === 'unknown';
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

  const mode = customOnly ? 'created' : 'visible';
  els.componentCount.textContent = `${visibleCount}/${state.scan?.count || 0} ${mode}`;
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
