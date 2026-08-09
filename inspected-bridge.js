(function installGigComponentInspector() {
  const GLOBAL_KEY = '__gigComponentInspector';
  const VERSION = 3;
  const DEFAULT_PREFIXES = ['sl-', 'gsm-', 'gig-', 'gng-', 'app-'];
  const HIGHLIGHT_ID = '__gigComponentInspectorHighlight';
  const IVY_COMPONENT_DEFINITION_KEY = '\u0275cmp';
  const WATCH_LEASE_MS = 4000;

  const existing = window[GLOBAL_KEY];
  if (existing?.version === VERSION) return existing;
  try {
    existing?.destroy?.();
  } catch (_error) {}

  let scanPrefixes = DEFAULT_PREFIXES;
  let scanSelectors = new Set();
  let elements = new Map();
  let elementIds = new WeakMap();
  let nextElementId = 1;
  let mutationVersion = 0;
  let observer = null;
  let watcherLeaseTimer = null;
  let lastContextElement = null;
  let highlightEnabled = false;
  let highlightTimer = null;

  function safeString(value, maxLength = 300) {
    if (value == null) return '';
    const text = String(value);
    return text.length > maxLength ? `${text.slice(0, maxLength)}...` : text;
  }

  function normalizeRuntimeTitle(value) {
    if (typeof value !== 'string' && typeof value !== 'number') return '';
    const title = safeString(value, 120).replace(/\s+/g, ' ').trim();
    return title.length > 1 ? title : '';
  }

  function getRuntimeTitle(element, component, selector) {
    const attributeNames = [
      'aria-label',
      'title',
      'data-title',
      'modal-title',
      'dialog-title',
      'label',
      'placeholder',
      'ng-reflect-modal-title',
      'ng-reflect-dialog-title',
      'ng-reflect-title',
      'ng-reflect-label',
    ];
    for (const attributeName of attributeNames) {
      const title = normalizeRuntimeTitle(element.getAttribute(attributeName));
      if (title) return title;
    }

    const propertyNames = ['modalTitle', 'dialogTitle', 'title', 'label', 'header', 'caption', 'placeholder'];
    for (const propertyName of propertyNames) {
      try {
        const title = normalizeRuntimeTitle(component?.[propertyName]);
        if (title) return title;
      } catch (_error) {}
    }

    if (!/(?:^|-)(?:modal|dialog|drawer|popup|popover)(?:-|$)/i.test(selector)) return '';
    try {
      const titleElement = element.querySelector(
        '.modal-title, .dialog-title, .mat-dialog-title, .mat-mdc-dialog-title, [class*="modal-header"] h1, [class*="modal-header"] h2, [class*="dialog-header"] h1, [class*="dialog-header"] h2',
      );
      return normalizeRuntimeTitle(titleElement?.textContent);
    } catch (_error) {
      return '';
    }
  }

  function normalizeSelectors(selectors) {
    if (!Array.isArray(selectors)) return new Set();
    return new Set(
      selectors
        .map(selector => String(selector || '').trim().toLowerCase())
        .filter(Boolean),
    );
  }

  function configure(options = {}) {
    scanPrefixes = Array.isArray(options.prefixes) && options.prefixes.length
      ? options.prefixes.map(prefix => String(prefix).toLowerCase())
      : DEFAULT_PREFIXES;
    scanSelectors = normalizeSelectors(options.selectors);
    return {
      ok: true,
      prefixes: scanPrefixes.length,
      selectors: scanSelectors.size,
    };
  }

  function getOwnAngularComponent(element) {
    try {
      return window.ng?.getComponent?.(element) || null;
    } catch (_error) {
      return null;
    }
  }

  function getAngularDefinition(component) {
    return component?.constructor?.[IVY_COMPONENT_DEFINITION_KEY] || null;
  }

  function getComponentSelector(component) {
    const selectors = getAngularDefinition(component)?.selectors;
    if (!Array.isArray(selectors)) return null;
    for (const selectorGroup of selectors) {
      if (!Array.isArray(selectorGroup)) continue;
      const selector = selectorGroup.find(part => typeof part === 'string' && /^[a-z][a-z0-9-]*$/i.test(part));
      if (selector) return selector.toLowerCase();
    }
    return null;
  }

  function getAngularClassName(component) {
    const directName = component?.constructor?.name;
    if (directName && directName.length > 1) return directName;
    const definitionName = getAngularDefinition(component)?.type?.name;
    return definitionName && definitionName.length > 1 ? definitionName : null;
  }

  function readableNameFromSelector(selector) {
    if (!selector || !selector.includes('-')) return selector || '';
    const parts = selector.split('-').filter(Boolean);
    const prefixes = new Set(['sl', 'app', 'gig', 'gng', 'gsm']);
    const startIndex = prefixes.has(parts[0]) ? 1 : 0;
    return parts.slice(startIndex).map(part => part.charAt(0).toUpperCase() + part.slice(1)).join('');
  }

  function getKind(selector) {
    if (/^(gig|gng|gsm)-/.test(selector)) return 'library';
    return 'app';
  }

  function isConfiguredComponentTag(element) {
    if (!(element instanceof Element)) return false;
    const tag = element.localName;
    if (!tag || !tag.includes('-')) return false;
    return scanSelectors.has(tag) || scanPrefixes.some(prefix => tag.startsWith(prefix));
  }

  function getOrCreateElementId(element) {
    let id = elementIds.get(element);
    if (!id) {
      id = `cmp-${nextElementId++}`;
      elementIds.set(element, id);
    }
    return id;
  }

  function findParentId(element, idByElement, componentToElement, ownId) {
    let parent = element.parentElement;
    while (parent) {
      const parentId = idByElement.get(parent);
      if (parentId) return parentId;
      parent = parent.parentElement;
    }

    try {
      const owningComponent = window.ng?.getOwningComponent?.(element);
      const owningElement = owningComponent ? componentToElement.get(owningComponent) : null;
      const owningId = owningElement ? idByElement.get(owningElement) : null;
      return owningId && owningId !== ownId ? owningId : null;
    } catch (_error) {
      return null;
    }
  }

  function scan() {
    if (observer) renewWatcherLease();
    const startedAt = performance.now();
    const candidates = [];

    for (const element of document.querySelectorAll('*')) {
      const tag = element.localName;
      if (!tag || !tag.includes('-')) continue;

      let component = null;
      if (!isConfiguredComponentTag(element)) {
        component = getOwnAngularComponent(element);
        if (!component) continue;
      }
      candidates.push({ element, component });
    }

    const nextElements = new Map();
    const idByElement = new WeakMap();
    const componentToElement = new WeakMap();
    const flatNodes = [];

    for (const candidate of candidates) {
      const { element } = candidate;
      const component = candidate.component || getOwnAngularComponent(element);
      const id = getOrCreateElementId(element);
      const rawSelector = element.localName;
      const selector = getComponentSelector(component) || rawSelector;
      const componentClassName = getAngularClassName(component);
      const kind = getKind(selector);
      const runtimeTitle = kind === 'library' ? getRuntimeTitle(element, component, selector) : '';

      nextElements.set(id, element);
      idByElement.set(element, id);
      if (component) componentToElement.set(component, element);
      flatNodes.push({
        id,
        parentId: null,
        selector,
        rawSelector,
        displayName: componentClassName || readableNameFromSelector(selector),
        runtimeTitle,
        componentClassName,
        kind,
      });
    }

    for (let index = 0; index < flatNodes.length; index++) {
      flatNodes[index].parentId = findParentId(
        candidates[index].element,
        idByElement,
        componentToElement,
        flatNodes[index].id,
      );
    }

    elements = nextElements;
    return {
      ok: true,
      version: VERSION,
      url: location.href,
      angularDebugApi: Boolean(window.ng),
      count: flatNodes.length,
      mutationVersion,
      scanMs: Math.round((performance.now() - startedAt) * 100) / 100,
      flatNodes,
    };
  }

  function getAttributes(element) {
    const result = {};
    for (const attribute of element.attributes || []) result[attribute.name] = attribute.value;
    return result;
  }

  function getElementPath(element) {
    const parts = [];
    let current = element;
    while (current && current.nodeType === Node.ELEMENT_NODE) {
      const tag = current.localName;
      let part = tag;
      if (current.id) {
        part += `#${current.id}`;
      } else if (current.parentElement) {
        const sameTagSiblings = Array.from(current.parentElement.children).filter(sibling => sibling.localName === tag);
        if (sameTagSiblings.length > 1) part += `:nth-of-type(${sameTagSiblings.indexOf(current) + 1})`;
      }
      parts.unshift(part);
      current = current.parentElement;
      if (tag === 'html') break;
    }
    return parts.join(' > ');
  }

  function getDomPreview(element) {
    const attributes = Array.from(element.attributes || [])
      .map(attribute => `${attribute.name}="${safeString(attribute.value, 120).replace(/"/g, '&quot;')}"`)
      .join(' ');
    const tag = element.localName;
    return attributes ? `<${tag} ${attributes}>...</${tag}>` : `<${tag}>...</${tag}>`;
  }

  function getNodeDetails(id) {
    const startedAt = performance.now();
    const element = elements.get(id);
    if (!element || !document.documentElement.contains(element)) {
      return { ok: false, message: 'Element no longer exists. Refresh the component tree.' };
    }

    return {
      ok: true,
      id,
      elementPath: getElementPath(element),
      attributes: getAttributes(element),
      classes: Array.from(element.classList || []),
      domPreview: getDomPreview(element),
      hasAngularDebugApi: Boolean(window.ng),
      detailsMs: Math.round((performance.now() - startedAt) * 100) / 100,
    };
  }

  function nodeContainsConfiguredComponent(node) {
    if (!(node instanceof Element)) return false;
    if (isConfiguredComponentTag(node)) return true;
    for (const descendant of node.querySelectorAll('*')) {
      if (isConfiguredComponentTag(descendant)) return true;
    }
    return false;
  }

  function mutationsContainComponentChange(records) {
    for (const record of records) {
      if (record.type !== 'childList') continue;
      for (const node of record.addedNodes) {
        if (nodeContainsConfiguredComponent(node)) return true;
      }
      for (const node of record.removedNodes) {
        if (nodeContainsConfiguredComponent(node)) return true;
      }
    }
    return false;
  }

  function startWatcher() {
    if (observer || !document.documentElement) return;
    observer = new MutationObserver(records => {
      if (mutationsContainComponentChange(records)) mutationVersion++;
    });
    observer.observe(document.documentElement, { childList: true, subtree: true });
  }

  function stopWatcher() {
    observer?.disconnect();
    observer = null;
    clearTimeout(watcherLeaseTimer);
    watcherLeaseTimer = null;
  }

  function renewWatcherLease() {
    if (!observer) return;
    clearTimeout(watcherLeaseTimer);
    watcherLeaseTimer = setTimeout(stopWatcher, WATCH_LEASE_MS);
  }

  function setWatching(enabled) {
    if (!enabled) {
      stopWatcher();
      return { ok: true, watching: false, mutationVersion };
    }
    startWatcher();
    renewWatcherLease();
    return { ok: true, watching: Boolean(observer), mutationVersion };
  }

  function getMutationState() {
    if (observer) renewWatcherLease();
    return { ok: true, watching: Boolean(observer), mutationVersion };
  }

  function inspectElementById(id) {
    const element = elements.get(id);
    if (!element || !document.documentElement.contains(element)) {
      return { ok: false, message: 'Element no longer exists. Refresh the component tree.' };
    }
    inspect(element);
    return { ok: true };
  }

  function getHighlightElement() {
    let overlay = document.getElementById(HIGHLIGHT_ID);
    if (!overlay) {
      overlay = document.createElement('div');
      overlay.id = HIGHLIGHT_ID;
      overlay.style.position = 'fixed';
      overlay.style.zIndex = '2147483647';
      overlay.style.pointerEvents = 'none';
      overlay.style.background = 'rgba(34, 197, 94, 0.12)';
      overlay.style.border = '2px solid #22c55e';
      overlay.style.borderRadius = '2px';
      overlay.style.display = 'none';
      document.documentElement.appendChild(overlay);
    }
    return overlay;
  }

  function setHighlightEnabled(enabled) {
    highlightEnabled = Boolean(enabled);
    if (!highlightEnabled) clearHighlight();
    return { ok: true, enabled: highlightEnabled };
  }

  function highlightElementById(id, options = {}) {
    if (!highlightEnabled) return { ok: true, skipped: true };
    const element = elements.get(id);
    if (!element || !document.documentElement.contains(element)) {
      return { ok: false, message: 'Element no longer exists. Refresh the component tree.' };
    }
    const rect = element.getBoundingClientRect();
    const overlay = getHighlightElement();
    overlay.style.left = `${Math.max(0, rect.left)}px`;
    overlay.style.top = `${Math.max(0, rect.top)}px`;
    overlay.style.width = `${Math.max(0, rect.width)}px`;
    overlay.style.height = `${Math.max(0, rect.height)}px`;
    overlay.style.display = rect.width && rect.height ? 'block' : 'none';
    clearTimeout(highlightTimer);
    highlightTimer = null;
    if (options.durationMs !== 0) highlightTimer = setTimeout(clearHighlight, options.durationMs || 1400);
    return { ok: true };
  }

  function clearHighlight() {
    const overlay = document.getElementById(HIGHLIGHT_ID);
    if (overlay) overlay.style.display = 'none';
    clearTimeout(highlightTimer);
    highlightTimer = null;
    return { ok: true };
  }

  function rememberContextElement(event) {
    lastContextElement = event.target instanceof Element ? event.target : null;
  }

  function findNearestComponentElement(start, preferredPrefixes = []) {
    let current = start instanceof Element ? start : null;
    while (current) {
      const tag = current.localName;
      if (preferredPrefixes.length && preferredPrefixes.some(prefix => tag.startsWith(prefix))) return current;
      if (!preferredPrefixes.length && isConfiguredComponentTag(current)) return current;
      current = current.parentElement;
    }
    return null;
  }

  function selectLastContextComponent(options = {}) {
    const preferredPrefixes = Array.isArray(options.preferredPrefixes) ? options.preferredPrefixes : [];
    const preferred = preferredPrefixes.length ? findNearestComponentElement(lastContextElement, preferredPrefixes) : null;
    const componentElement = preferred || findNearestComponentElement(lastContextElement);
    if (!componentElement) return { ok: false, message: 'No component host was found for the last right-clicked element.' };

    const id = elementIds.get(componentElement);
    if (!id || !elements.has(id)) {
      return {
        ok: false,
        needsRefresh: true,
        selector: componentElement.localName,
        message: 'Component exists, but it is not in the current scan. Refreshing can link it.',
      };
    }
    return { ok: true, id, selector: componentElement.localName };
  }

  function selectElement(element, options = {}) {
    if (!(element instanceof Element)) {
      return { ok: false, message: 'Select an element in the Elements panel first.' };
    }
    lastContextElement = element;
    return selectLastContextComponent(options);
  }

  function destroy() {
    stopWatcher();
    clearHighlight();
    document.removeEventListener('contextmenu', rememberContextElement, true);
    document.getElementById(HIGHLIGHT_ID)?.remove();
    elements = new Map();
    elementIds = new WeakMap();
  }

  const api = {
    version: VERSION,
    configure,
    scan,
    getNodeDetails,
    setWatching,
    getMutationState,
    inspectElementById,
    selectElement,
    selectLastContextComponent,
    setHighlightEnabled,
    highlightElementById,
    clearHighlight,
    destroy,
  };

  document.addEventListener('contextmenu', rememberContextElement, true);
  window[GLOBAL_KEY] = api;
  return api;
})();
