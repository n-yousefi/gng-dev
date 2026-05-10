(function createSourceLoader(global) {
  const FRAMEWORK_PREFIXES = ['gng-', 'gig-', 'gsm-'];
  const CREATED_PREFIXES = ['sl-', 'app-'];

  function normalizeSelector(selector) {
    return (selector || '').trim().toLowerCase();
  }

  function normalizePath(path) {
    return (path || '').replace(/\\/g, '/');
  }

  function templatePathFromComponent(componentTs) {
    const normalized = normalizePath(componentTs);
    return normalized ? normalized.replace(/\.ts$/i, '.html') : '';
  }

  function getSelectorFamily(selector) {
    const normalized = normalizeSelector(selector);
    if (FRAMEWORK_PREFIXES.some(prefix => normalized.startsWith(prefix))) return 'framework';
    if (CREATED_PREFIXES.some(prefix => normalized.startsWith(prefix))) return 'created';
    return 'unknown';
  }

  function enrichEntry(entry) {
    const componentTs = normalizePath(entry.componentTs);
    const templateUrl = templatePathFromComponent(componentTs);
    const family = entry.selectorFamily || getSelectorFamily(entry.selector);
    return {
      ...entry,
      selectorFamily: family,
      componentTs,
      templateUrl,
      componentFileName: entry.componentFileName || componentTs.split('/').pop() || '',
    };
  }

  function createIndex(entries) {
    const bySelector = new Map();
    for (const entry of entries || []) {
      if (!entry?.selector) continue;
      bySelector.set(normalizeSelector(entry.selector), enrichEntry(entry));
    }
    return bySelector;
  }

  function selectorToPossibleTemplate(selector) {
    const cleaned = normalizeSelector(selector)
      .replace(/^(sl|gsm|gig|gng|app)-/, '')
      .replace(/[^a-z0-9-]/g, '');
    return cleaned ? `${cleaned}.component.html` : null;
  }

  function findSource(node, index) {
    const selector = normalizeSelector(node?.selector);
    const indexed = index?.get(selector);
    if (indexed) {
      return {
        found: Boolean(indexed.templateUrl || indexed.componentTs),
        source: indexed,
        message: 'Component index found source paths.',
      };
    }

    const guessed = selectorToPossibleTemplate(selector);
    return {
      found: false,
      source: guessed ? { templateUrl: guessed, selectorFamily: getSelectorFamily(selector) } : null,
      message: guessed
        ? `No source index entry found. Possible template filename: ${guessed}`
        : 'No source index entry found.',
    };
  }

  function isCreatedComponent(node, index) {
    const source = findSource(node, index).source;
    const selectorFamily = source?.selectorFamily || getSelectorFamily(node?.selector);
    if (selectorFamily === 'created') return true;
    if (selectorFamily === 'framework') return false;
    return getSelectorFamily(node?.selector) === 'created';
  }

  async function loadBundledIndex() {
    const manifest = await loadBundledManifest();
    return manifest.entries;
  }

  async function loadBundledManifest() {
    try {
      const response = await fetch(chrome.runtime.getURL('component-index.json'), { cache: 'no-store' });
      if (!response.ok) return { entries: [], projectRoot: '' };
      const json = await response.json();
      return {
        entries: Array.isArray(json) ? json : json.components || [],
        projectRoot: Array.isArray(json) ? '' : normalizePath(json.projectRoot || ''),
        generatedAt: Array.isArray(json) ? '' : json.generatedAt || '',
      };
    } catch (_error) {
      return { entries: [], projectRoot: '' };
    }
  }

  global.GIGSourceLoader = {
    createIndex,
    findSource,
    getSelectorFamily,
    isCreatedComponent,
    loadBundledIndex,
    loadBundledManifest,
  };
})(window);
