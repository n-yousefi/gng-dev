(function createSourceLoader(global) {
  const FRAMEWORK_PREFIXES = ['gng-', 'gig-', 'gsm-'];
  const CREATED_PREFIXES = ['sl-', 'app-'];

  function normalizeSelector(selector) {
    return (selector || '').trim().toLowerCase();
  }

  function normalizePath(path) {
    return (path || '').replace(/\\/g, '/');
  }

  function getSelectorFamily(selector) {
    const normalized = normalizeSelector(selector);
    if (FRAMEWORK_PREFIXES.some(prefix => normalized.startsWith(prefix))) return 'framework';
    if (CREATED_PREFIXES.some(prefix => normalized.startsWith(prefix))) return 'created';
    return 'unknown';
  }

  function enrichEntry(entry) {
    const componentTs = normalizePath(entry.componentTs);
    const templateUrl = normalizePath(entry.templateUrl);
    const family = entry.selectorFamily || getSelectorFamily(entry.selector);
    return {
      ...entry,
      selectorFamily: family,
      ownerType: entry.ownerType || (family === 'framework' ? 'framework' : family === 'created' ? 'created' : 'unknown'),
      componentTs,
      templateUrl,
      styleUrls: (entry.styleUrls || []).map(normalizePath),
      componentFileName: entry.componentFileName || componentTs.split('/').pop() || '',
      templateFileName: entry.templateFileName || templateUrl.split('/').pop() || '',
      componentDir: entry.componentDir || componentTs.split('/').slice(0, -1).join('/'),
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
        found: Boolean(indexed.templateHtml || indexed.templateUrl || indexed.componentTs),
        source: indexed,
        message: indexed.templateHtml
          ? 'Template loaded from component index.'
          : 'Component index found source paths, but no templateHtml was included.',
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
    const ownerType = source?.ownerType || selectorFamily;
    if (ownerType === 'created' || selectorFamily === 'created') return true;
    if (ownerType === 'framework' || selectorFamily === 'framework') return false;
    return getSelectorFamily(node?.selector) === 'created';
  }

  async function loadBundledIndex() {
    try {
      const response = await fetch(chrome.runtime.getURL('component-index.json'));
      if (!response.ok) return [];
      const json = await response.json();
      return Array.isArray(json) ? json : json.components || [];
    } catch (_error) {
      return [];
    }
  }

  global.GIGSourceLoader = {
    createIndex,
    findSource,
    getSelectorFamily,
    isCreatedComponent,
    loadBundledIndex,
  };
})(window);
