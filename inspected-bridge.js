(function installGigComponentInspector() {
  const GLOBAL_KEY = '__gigComponentInspector';
  const VERSION = 1;

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
    };

    try {
      const component = window.ng?.getComponent?.(element) || window.ng?.getOwningComponent?.(element);
      if (component) {
        metadata.componentClassName = component.constructor?.name || null;
        metadata.componentInstanceSummary = summarizeInstance(component);
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
    const prefixes = options.prefixes || ['sl-', 'gsm-', 'gig-', 'gng-', 'app-'];
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

  window[GLOBAL_KEY] = {
    version: VERSION,
    elements: new Map(),
    scan,
    inspectElementById,
  };

  return window[GLOBAL_KEY];
})();

