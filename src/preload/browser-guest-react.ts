// The element picker's read of a page's React fiber (browser-guest.ts), apart
// from the preload so it can be tested without Electron.

// Run in the page's world, as source text: it may use nothing from this file.
// `_debugSource` is React 16–18's dev-only source location. React 19 removed
// it (the info moved to the component stack), so `source` is null on a React
// 19 dev server — expected, not a bug to chase.
export const READ_REACT_CONTEXT_SCRIPT = `(function (attribute, marker) {
  var element = document.querySelector('[' + attribute + '="' + marker + '"]');
  var answer = { components: [], source: null };
  if (!element) return answer;
  var fiber = null;
  var keys = Object.keys(element);
  for (var i = 0; i < keys.length; i++) {
    if (keys[i].indexOf('__reactFiber$') === 0) { fiber = element[keys[i]] || null; break; }
  }
  function nameOf(type, depth) {
    if (!type || depth > 3) return null;
    if (typeof type === 'function') return type.displayName || type.name || null;
    if (typeof type === 'object') {
      if (type.displayName) return type.displayName;
      if (type.render) return type.render.displayName || type.render.name || null;
      if (type.type) return nameOf(type.type, depth + 1);
    }
    return null;
  }
  var hops = 0;
  while (fiber && hops < 40 && answer.components.length < 3) {
    var name = nameOf(fiber.type, 0);
    if (typeof name === 'string' && name) answer.components.push(name);
    var debug = fiber._debugSource;
    if (!answer.source && debug && typeof debug.fileName === 'string') {
      answer.source = debug.fileName + (debug.lineNumber ? ':' + debug.lineNumber : '') + (debug.columnNumber ? ':' + debug.columnNumber : '');
    }
    fiber = fiber.return || null;
    hops += 1;
  }
  return answer;
})`

export type ReactContext = { components: string[]; source: string | null }

/** What the page's world answered, re-typed: whatever came back is the page's word. */
export function asReactContext(value: unknown): ReactContext {
  const raw = value && typeof value === 'object' ? (value as Record<string, unknown>) : {}
  const components = Array.isArray(raw.components)
    ? raw.components
        .filter((entry): entry is string => typeof entry === 'string')
        .slice(0, 3)
        .map((entry) => entry.slice(0, 80))
    : []
  return { components, source: typeof raw.source === 'string' ? raw.source.slice(0, 500) : null }
}
