(function installGigComponentInspector() {
  const GLOBAL_KEY = '__gigComponentInspector';
  const VERSION = 1;
  const DEFAULT_PREFIXES = ['sl-', 'gsm-', 'gig-', 'gng-', 'app-'];
  const HIGHLIGHT_ID = '__gigComponentInspectorHighlight';
  const IVY_COMPONENT_DEFINITION_KEY = '\u0275cmp';

  function safeString(value, maxLength = 300) {
    if (value == null) return '';
    const text = String(value);
    return text.length > maxLength ? `${text.slice(0, maxLength)}...` : text;
  }

  function getAttributes(element) {
    const result = {};
    for (const attr of Array.from(element.attributes || [])) {
      result[attr.name] = attr.value;
    }
    return result;
  }

  function getElementPath(element) {
    const parts = [];
    let current = element;
    while (current && current.nodeType === Node.ELEMENT_NODE) {
      const tag = current.tagName.toLowerCase();
      let part = tag;
      if (current.id) {
        part += `#${current.id}`;
      } else {
        let sameTagCount = 0;
        let sameTagIndex = 0;
        for (const sibling of current.parentElement?.children || []) {
          if (sibling.tagName !== current.tagName) continue;
          sameTagCount++;
          if (sibling === current) sameTagIndex = sameTagCount;
        }
        if (sameTagCount > 1) {
          part += `:nth-of-type(${sameTagIndex})`;
        }
      }
      parts.unshift(part);
      current = current.parentElement;
      if (tag === 'html') break;
    }
    return parts.join(' > ');
  }

  function getDomPreview(element) {
    const clone = element.cloneNode(false);
    const attrs = Array.from(clone.attributes || [])
      .map(attr => `${attr.name}="${safeString(attr.value, 120).replace(/"/g, '&quot;')}"`)
      .join(' ');
    const tag = clone.tagName.toLowerCase();
    return attrs ? `<${tag} ${attrs}>...</${tag}>` : `<${tag}>...</${tag}>`;
  }

  function getKind(selector) {
    if (selector.startsWith('gig-') || selector.startsWith('gng-') || selector.startsWith('gsm-')) return 'library';
    if (selector.startsWith('sl-') || selector.startsWith('app-')) return 'app';
    return 'unknown';
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
      const selector = selectorGroup.find(part => typeof part === 'string' && part && /^[a-z][a-z0-9-]*$/i.test(part));
      if (selector) return selector.toLowerCase();
    }

    return null;
  }

  function getAngularMetadata(element) {
    const ownComponent = getOwnAngularComponent(element);
    const metadata = {
      hasAngularDebugApi: Boolean(window.ng),
      isComponentHost: Boolean(ownComponent),
      componentSelector: getComponentSelector(ownComponent),
      componentClassName: null,
      directiveNames: [],
      inputs: [],
      outputs: [],
      componentInstanceSummary: {},
      componentProperties: {},
    };

    try {
      const component = ownComponent || window.ng?.getOwningComponent?.(element);
      if (component) {
        metadata.componentSelector ||= getComponentSelector(component);
        metadata.componentClassName = component.constructor?.name || null;
        const ioMetadata = getComponentIoMetadata(component);
        metadata.inputs = ioMetadata.inputs;
        metadata.outputs = ioMetadata.outputs;
        metadata.componentInstanceSummary = summarizeInstance(component);
        metadata.componentProperties = summarizeProperties(component);
      }
    } catch (error) {
      metadata.componentError = safeString(error?.message || error);
    }

    try {
      const directives = window.ng?.getDirectives?.(element);
      if (Array.isArray(directives)) {
        metadata.directiveNames = directives
          .map(directive => directive?.constructor?.name)
          .filter(Boolean)
          .slice(0, 20);
      }
    } catch (error) {
      metadata.directiveError = safeString(error?.message || error);
    }

    return metadata;
  }

  function getComponentIoMetadata(component) {
    const definition = getAngularDefinition(component);
    return {
      inputs: normalizeIoDefinition(definition?.inputs),
      outputs: normalizeIoDefinition(definition?.outputs),
    };
  }

  function normalizeIoDefinition(definition) {
    if (!definition || typeof definition !== 'object') return [];
    return Object.entries(definition)
      .map(([publicName, value]) => {
        if (Array.isArray(value)) {
          return {
            publicName,
            propertyName: value[0] || publicName,
            declaredName: value[1] || '',
          };
        }
        return {
          publicName,
          propertyName: typeof value === 'string' ? value : publicName,
          declaredName: '',
        };
      })
      .sort((a, b) => a.publicName.localeCompare(b.publicName));
  }

  function summarizeProperties(instance) {
    const result = {};
    const seen = new Set();
    let current = instance;
    let depth = 0;

    while (current && current !== Object.prototype && depth < 3) {
      for (const key of Object.getOwnPropertyNames(current).slice(0, 160)) {
        if (seen.has(key) || key === 'constructor' || key.startsWith('_')) continue;
        seen.add(key);

        const descriptor = Object.getOwnPropertyDescriptor(current, key);
        if (!descriptor || typeof descriptor.value === 'function') continue;

        try {
          const value = descriptor.get ? instance[key] : descriptor.value;
          const summary = summarizeValue(value, 0);
          if (summary !== undefined) {
            result[key] = {
              source: current === instance ? 'instance' : 'prototype',
              value: summary,
            };
          }
        } catch (error) {
          result[key] = {
            source: current === instance ? 'instance' : 'prototype',
            error: safeString(error?.message || error),
          };
        }
      }

      current = Object.getPrototypeOf(current);
      depth++;
    }

    return result;
  }

  function summarizeInstance(instance) {
    const output = {};
    const keys = Object.keys(instance || {}).slice(0, 120);
    for (const key of keys) {
      if (key.startsWith('_') || key.includes('subscription') || key.includes('Subscription')) continue;
      const value = instance[key];
      const summary = summarizeValue(value, 0);
      if (summary !== undefined) output[key] = summary;
    }
    return output;
  }

  function summarizeValue(value, depth) {
    if (value == null) return value;
    const type = typeof value;
    if (type === 'string') return safeString(value, 300);
    if (type === 'number' || type === 'boolean') return value;
    if (type === 'function' || type === 'symbol') return undefined;
    if (value instanceof Node || value instanceof Window || value instanceof Document) return undefined;
    if (Array.isArray(value)) {
      return {
        type: 'Array',
        length: value.length,
        preview: value.slice(0, 5).map(item => summarizeValue(item, depth + 1)).filter(item => item !== undefined),
      };
    }
    if (type === 'object') {
      const ctor = value.constructor?.name;
      if (/Subject|Observable|Subscription|Service|Manager|Ref|Injector|Router/i.test(ctor || '')) {
        return { type: ctor || 'Object' };
      }
      if (depth > 0) return { type: ctor || 'Object' };
      const shallow = {};
      for (const key of Object.keys(value).slice(0, 12)) {
        const child = summarizeValue(value[key], depth + 1);
        if (child !== undefined) shallow[key] = child;
      }
      return { type: ctor || 'Object', value: shallow };
    }
    return undefined;
  }

  function matchesPrefixes(element, prefixes) {
    const tag = element.tagName.toLowerCase();
    return prefixes.some(prefix => tag.startsWith(prefix));
  }

  function normalizeSelectorSet(selectors) {
    if (!Array.isArray(selectors)) return new Set();
    return new Set(
      selectors
        .map(selector => String(selector || '').trim().toLowerCase())
        .filter(Boolean)
    );
  }

  function getComponentMatchSelector(element) {
    const tag = element.tagName.toLowerCase();
    if (matchesPrefixes(element, DEFAULT_PREFIXES)) return tag;

    const selector = getComponentSelector(getOwnAngularComponent(element));
    return selector || tag;
  }

  function isScannableComponentElement(element, prefixes, selectorSet = new Set()) {
    const tag = element.tagName.toLowerCase();
    if (selectorSet.has(tag)) return true;
    if (matchesPrefixes(element, prefixes)) return true;

    const selector = getComponentSelector(getOwnAngularComponent(element));
    return Boolean(selector && (selectorSet.has(selector) || prefixes.some(prefix => selector.startsWith(prefix))));
  }

  function createNode(element, id) {
    const rawSelector = element.tagName.toLowerCase();
    const angular = getAngularMetadata(element);
    const selector = angular.componentSelector || rawSelector;
    const className = angular.componentClassName;
    return {
      id,
      selector,
      rawSelector,
      displayName: className || selector,
      kind: getKind(selector),
      elementPath: getElementPath(element),
      attributes: getAttributes(element),
      classes: Array.from(element.classList || []),
      componentClassName: className,
      directiveNames: angular.directiveNames,
      inputs: angular.inputs,
      outputs: angular.outputs,
      hasAngularDebugApi: angular.hasAngularDebugApi,
      componentInstanceSummary: angular.componentInstanceSummary,
      componentProperties: angular.componentProperties,
      debugErrors: {
        component: angular.componentError,
        directives: angular.directiveError,
      },
      domPreview: getDomPreview(element),
      childIds: [],
      children: [],
    };
  }

  function buildTree(nodes, elementById, idByElement) {
    const roots = [];
    const nodeById = new Map(nodes.map(node => [node.id, node]));
    for (const node of nodes) {
      const element = elementById.get(node.id);
      let parent = element.parentElement;
      let parentNode = null;

      while (parent) {
        const parentId = idByElement.get(parent);
        if (parentId) {
          parentNode = nodeById.get(parentId);
          break;
        }
        parent = parent.parentElement;
      }

      if (parentNode) {
        parentNode.children.push(node);
        parentNode.childIds.push(node.id);
      } else {
        roots.push(node);
      }
    }
    return roots;
  }

  function scan(options = {}) {
    const prefixes = options.prefixes || DEFAULT_PREFIXES;
    const selectorSet = normalizeSelectorSet(options.selectors);
    const elements = new Map();
    const idByElement = new WeakMap();
    const flatNodes = [];
    const scanId = Date.now();

    for (const element of document.querySelectorAll('*')) {
      if (!isScannableComponentElement(element, prefixes, selectorSet)) continue;
      const id = `cmp-${scanId}-${flatNodes.length}`;
      elements.set(id, element);
      idByElement.set(element, id);
      flatNodes.push(createNode(element, id));
    }

    const tree = buildTree(flatNodes, elements, idByElement);
    window[GLOBAL_KEY].elements = elements;
    window[GLOBAL_KEY].lastScan = { scannedAt: new Date().toISOString(), count: flatNodes.length };

    return {
      ok: true,
      version: VERSION,
      url: location.href,
      userAgent: navigator.userAgent,
      angularDebugApi: Boolean(window.ng),
      count: flatNodes.length,
      flatNodes,
      tree,
    };
  }

  function inspectElementById(id) {
    const element = window[GLOBAL_KEY].elements?.get(id);
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
      overlay.style.border = '1px solid rgba(44, 136, 255, 0.95)';
      overlay.style.background = 'rgba(65, 141, 255, 0.22)';
      overlay.style.boxShadow = 'inset 0 0 0 1px rgba(255, 255, 255, 0.35), 0 0 0 1px rgba(44, 136, 255, 0.45)';
      overlay.style.borderRadius = '2px';
      overlay.style.display = 'none';
      document.documentElement.appendChild(overlay);
    }
    return overlay;
  }

  function setHighlightEnabled(enabled) {
    window[GLOBAL_KEY].highlightEnabled = Boolean(enabled);
    if (!enabled) clearHighlight();
    return { ok: true, enabled: window[GLOBAL_KEY].highlightEnabled };
  }

  function highlightElementById(id, options = {}) {
    if (!window[GLOBAL_KEY].highlightEnabled) return { ok: true, skipped: true };
    const element = window[GLOBAL_KEY].elements?.get(id);
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
    clearTimeout(window[GLOBAL_KEY].highlightTimer);
    window[GLOBAL_KEY].highlightTimer = null;
    if (options.durationMs !== 0) {
      window[GLOBAL_KEY].highlightTimer = setTimeout(clearHighlight, options.durationMs || 1400);
    }
    return { ok: true };
  }

  function clearHighlight() {
    const overlay = document.getElementById(HIGHLIGHT_ID);
    if (overlay) overlay.style.display = 'none';
    clearTimeout(window[GLOBAL_KEY].highlightTimer);
    window[GLOBAL_KEY].highlightTimer = null;
    return { ok: true };
  }

  function rememberContextElement(event) {
    window[GLOBAL_KEY].lastContextElement = event.target instanceof Element ? event.target : null;
  }

  function findNearestComponentElement(start, prefixes = DEFAULT_PREFIXES, selectorSet = new Set()) {
    let current = start instanceof Element ? start : null;
    while (current) {
      if (isScannableComponentElement(current, prefixes, selectorSet)) return current;
      current = current.parentElement;
    }
    return null;
  }

  function getIdForElement(element) {
    for (const [id, candidate] of window[GLOBAL_KEY].elements || []) {
      if (candidate === element) return id;
    }
    return null;
  }

  function selectLastContextComponent(options = {}) {
    const preferredPrefixes = Array.isArray(options.preferredPrefixes) ? options.preferredPrefixes : [];
    const fallbackPrefixes = options.prefixes || DEFAULT_PREFIXES;
    const selectorSet = normalizeSelectorSet(options.selectors);
    const preferredElement = preferredPrefixes.length
      ? findNearestComponentElement(window[GLOBAL_KEY].lastContextElement, preferredPrefixes, selectorSet)
      : null;
    const componentElement = preferredElement || findNearestComponentElement(window[GLOBAL_KEY].lastContextElement, fallbackPrefixes, selectorSet);
    if (!componentElement) {
      return { ok: false, message: 'No component host was found for the last right-clicked element.' };
    }

    const id = getIdForElement(componentElement);
    if (!id) {
      return {
        ok: false,
        needsRefresh: true,
        selector: getComponentMatchSelector(componentElement),
        elementPath: getElementPath(componentElement),
        message: 'Component exists, but it is not in the current scan. Refreshing can link it.',
      };
    }

    return {
      ok: true,
      id,
      selector: getComponentMatchSelector(componentElement),
      elementPath: getElementPath(componentElement),
    };
  }

  window[GLOBAL_KEY] = {
    version: VERSION,
    elements: new Map(),
    lastContextElement: null,
    highlightEnabled: false,
    highlightTimer: null,
    scan,
    inspectElementById,
    selectLastContextComponent,
    setHighlightEnabled,
    highlightElementById,
    clearHighlight,
  };

  document.removeEventListener('contextmenu', rememberContextElement, true);
  document.addEventListener('contextmenu', rememberContextElement, true);

  return window[GLOBAL_KEY];
})();

