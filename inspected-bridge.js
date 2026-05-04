(function installGigComponentInspector() {
  const GLOBAL_KEY = '__gigComponentInspector';
  const VERSION = 1;
  const DEFAULT_PREFIXES = ['sl-', 'gsm-', 'gig-', 'gng-', 'app-'];

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
        const sameTagSiblings = Array.from(current.parentElement?.children || []).filter(
          sibling => sibling.tagName === current.tagName
        );
        if (sameTagSiblings.length > 1) {
          part += `:nth-of-type(${sameTagSiblings.indexOf(current) + 1})`;
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

  function getAngularMetadata(element) {
    const metadata = {
      hasAngularDebugApi: Boolean(window.ng),
      componentClassName: null,
      directiveNames: [],
      inputs: {},
      componentInstanceSummary: {},
      componentProperties: {},
    };

    try {
      const component = window.ng?.getComponent?.(element) || window.ng?.getOwningComponent?.(element);
      if (component) {
        metadata.componentClassName = component.constructor?.name || null;
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

  function createNode(element, id) {
    const selector = element.tagName.toLowerCase();
    const angular = getAngularMetadata(element);
    const className = angular.componentClassName;
    return {
      id,
      selector,
      displayName: className || selector,
      kind: getKind(selector),
      elementPath: getElementPath(element),
      attributes: getAttributes(element),
      classes: Array.from(element.classList || []),
      componentClassName: className,
      directiveNames: angular.directiveNames,
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
    for (const node of nodes) {
      const element = elementById.get(node.id);
      let parent = element.parentElement;
      let parentNode = null;

      while (parent) {
        const parentId = idByElement.get(parent);
        if (parentId) {
          parentNode = nodes.find(candidate => candidate.id === parentId);
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
    const elements = new Map();
    const idByElement = new WeakMap();
    const candidates = Array.from(document.querySelectorAll('*')).filter(element => matchesPrefixes(element, prefixes));
    const flatNodes = [];

    candidates.forEach((element, index) => {
      const id = `cmp-${Date.now()}-${index}`;
      elements.set(id, element);
      idByElement.set(element, id);
      flatNodes.push(createNode(element, id));
    });

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

  function rememberContextElement(event) {
    window[GLOBAL_KEY].lastContextElement = event.target instanceof Element ? event.target : null;
  }

  function findNearestComponentElement(start, prefixes = DEFAULT_PREFIXES) {
    let current = start instanceof Element ? start : null;
    while (current) {
      if (matchesPrefixes(current, prefixes)) return current;
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
    const preferredPrefixes = options.preferredPrefixes || ['sl-', 'app-'];
    const fallbackPrefixes = options.prefixes || DEFAULT_PREFIXES;
    const componentElement =
      findNearestComponentElement(window[GLOBAL_KEY].lastContextElement, preferredPrefixes) ||
      findNearestComponentElement(window[GLOBAL_KEY].lastContextElement, fallbackPrefixes);
    if (!componentElement) {
      return { ok: false, message: 'No component host was found for the last right-clicked element.' };
    }

    const id = getIdForElement(componentElement);
    if (!id) {
      return {
        ok: false,
        needsRefresh: true,
        selector: componentElement.tagName.toLowerCase(),
        elementPath: getElementPath(componentElement),
        message: 'Component exists, but it is not in the current scan. Refreshing can link it.',
      };
    }

    return {
      ok: true,
      id,
      selector: componentElement.tagName.toLowerCase(),
      elementPath: getElementPath(componentElement),
    };
  }

  window[GLOBAL_KEY] = {
    version: VERSION,
    elements: new Map(),
    lastContextElement: null,
    scan,
    inspectElementById,
    selectLastContextComponent,
  };

  document.removeEventListener('contextmenu', rememberContextElement, true);
  document.addEventListener('contextmenu', rememberContextElement, true);

  return window[GLOBAL_KEY];
})();

