(function createSourceLoader(global) {
  const FRAMEWORK_PREFIXES = ['gng-', 'gig-', 'gsm-'];
  const CREATED_PREFIXES = ['sl-', 'app-'];
  const FRAMEWORK_APP_SELECTOR_PATTERNS = [
    /^app-modal(?:-|$)/,
    /^app-dynamic-form$/,
    /^app-form(?:-|$)/,
    /^app-(?:pagination|filter|string-filter|scroller|context-menu)$/,
  ];

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
    if (FRAMEWORK_APP_SELECTOR_PATTERNS.some(pattern => pattern.test(normalized))) return 'framework';
    if (FRAMEWORK_PREFIXES.some(prefix => normalized.startsWith(prefix))) return 'framework';
    if (CREATED_PREFIXES.some(prefix => normalized.startsWith(prefix))) return 'created';
    return 'created';
  }

  function getSelectorPrefix(selector) {
    const match = normalizeSelector(selector).match(/^([a-z][a-z0-9]*)-/);
    return match ? `${match[1]}-` : '';
  }

  function enrichEntry(entry) {
    const componentTs = normalizePath(entry.componentTs);
    const hasIndexedTemplate = Object.prototype.hasOwnProperty.call(entry, 'templateUrl');
    const templateUrl = entry.entryType === 'column-service'
      ? ''
      : normalizePath(hasIndexedTemplate ? entry.templateUrl : templatePathFromComponent(componentTs));
    const family = componentTs ? (entry.selectorFamily || 'created') : (entry.selectorFamily || getSelectorFamily(entry.selector));
    return {
      ...entry,
      selectorFamily: family,
      selectorPrefix: entry.selectorPrefix || getSelectorPrefix(entry.selector),
      componentTs,
      templateUrl,
      styleUrls: (entry.styleUrls || []).map(normalizePath),
      relatedColumnServices: (entry.relatedColumnServices || []).map(normalizePath),
      fields: (entry.fields || [])
        .map(field => ({ name: String(field?.name || '').trim(), line: Number(field?.line) || null }))
        .filter(field => field.name),
      componentFileName: entry.componentFileName || componentTs.split('/').pop() || '',
    };
  }

  function createIndex(entries) {
    const bySelector = new Map();
    const columnServices = [];
    for (const entry of entries || []) {
      if (entry?.entryType === 'column-service') {
        const enriched = enrichEntry(entry);
        columnServices.push(enriched);
      } else if (entry?.selector) {
        const selector = normalizeSelector(entry.selector);
        const candidates = bySelector.get(selector) || [];
        candidates.push(enrichEntry(entry));
        bySelector.set(selector, candidates);
      }
    }
    return { bySelector, columnServices };
  }

  function selectorToPossibleTemplate(selector) {
    const cleaned = normalizeSelector(selector)
      .replace(/^[a-z][a-z0-9]*-/, '')
      .replace(/[^a-z0-9-]/g, '');
    return cleaned ? `${cleaned}.component.html` : null;
  }

  function findSource(node, index) {
    const selector = normalizeSelector(node?.selector);
    const indexed = index?.get(selector);
    const candidates = Array.isArray(indexed) ? indexed : indexed ? [indexed] : [];
    if (candidates.length) {
      const runtimeClassName = String(node?.componentClassName || '').trim();
      const classMatches = runtimeClassName
        ? candidates.filter(candidate => candidate.className === runtimeClassName)
        : [];
      const resolvedCandidates = classMatches.length ? classMatches : candidates;
      if (resolvedCandidates.length === 1) {
        const source = resolvedCandidates[0];
        return {
          found: Boolean(source.templateUrl || source.componentTs),
          source,
          candidates,
          ambiguous: false,
          message: classMatches.length
            ? 'Component index matched selector and runtime class.'
            : 'Component index found one source candidate.',
        };
      }

      return {
        found: false,
        source: {
          selector,
          selectorFamily: 'created',
          className: runtimeClassName,
          componentTs: '',
          templateUrl: '',
        },
        candidates: resolvedCandidates,
        allCandidates: candidates,
        ambiguous: true,
        message: `Component index found ${resolvedCandidates.length} matching source candidates.`,
      };
    }

    return {
      found: false,
      source: {
        selector,
        selectorFamily: getSelectorFamily(selector),
        componentTs: '',
        templateUrl: '',
        possibleTemplate: selectorToPossibleTemplate(selector),
      },
      message: 'No source index entry found.',
    };
  }

  function findRelatedColumnServices(source, columnServices) {
    if (!source?.componentTs) return [];
    const componentPath = normalizePath(source.componentTs);
    const componentDirectory = componentPath.split('/').slice(0, -1).join('/');
    const configuredPaths = new Set((source.relatedColumnServices || []).map(normalizePath));
    const seen = new Set();
    const result = [];

    for (const service of columnServices || []) {
      const servicePath = normalizePath(service.componentTs);
      const serviceDirectory = servicePath.split('/').slice(0, -1).join('/');
      if (!configuredPaths.has(servicePath) && serviceDirectory !== componentDirectory) continue;
      if (seen.has(servicePath)) continue;
      seen.add(servicePath);
      result.push(service);
    }
    return result.sort((left, right) => left.componentTs.localeCompare(right.componentTs));
  }

  function findFieldSources(source, columnServices, fieldName) {
    const normalizedName = String(fieldName || '').trim();
    const services = findRelatedColumnServices(source, columnServices);
    if (!normalizedName) return { exact: [], services };

    const exact = [];
    for (const service of services) {
      for (const field of service.fields || []) {
        if (field.name !== normalizedName || !field.line) continue;
        exact.push({
          ...service,
          selectorLine: field.line,
          fieldName: normalizedName,
        });
      }
    }

    return { exact, services };
  }

  function isCreatedComponent(node, index) {
    const source = findSource(node, index).source;
    if (source?.componentTs) return true;
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
        schemaVersion: Array.isArray(json) ? 1 : Number(json.schemaVersion) || 1,
      };
    } catch (_error) {
      return { entries: [], projectRoot: '', schemaVersion: 1 };
    }
  }

  global.GIGSourceLoader = {
    createIndex,
    findFieldSources,
    findRelatedColumnServices,
    findSource,
    getSelectorFamily,
    isCreatedComponent,
    loadBundledIndex,
    loadBundledManifest,
  };
})(window);
