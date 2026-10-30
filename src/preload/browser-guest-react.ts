// The element picker's one look into the page's own world: which React
// components drew the picked element, and where in the source they live.
//
// The picker's preload runs in an isolated world, so the page can never reach
// the `ipcRenderer` it holds. The DOM is shared between the two worlds, but
// the properties a script hangs on a DOM node are not: React keeps its fiber
// on `__reactFiber$…` expandos that only the page's world can see. So the
// preload marks the picked element with an attribute carrying a one-off
// token, runs the short script below in the page's world
// (`webFrame.executeJavaScript`), and takes back nothing but a structured
// copy of plain data. Nothing in the isolated world is handed to the page.
//
// What comes back is the page's word: the page owns the world the script runs
// in and can make it answer anything, or nothing. So the answer is re-typed
// and capped here, and the preload waits only so long for it.

/** The attribute the picked element carries while the page's world reads it. */
export const REACT_READER_ATTRIBUTE = 'data-sprintengine-pick'

const MAX_COMPONENTS = 3
const MAX_COMPONENT_NAME = 80
const MAX_SOURCE = 500

export type ReactContext = { components: string[]; source: string | null }

export const NO_REACT_CONTEXT: ReactContext = { components: [], source: null }

/**
 * The script run in the page's world for one pick: it finds the element the
 * token marks and walks up its fiber, at most 40 hops, for the first three
 * component names and the nearest dev-build source location. React 16–18 put
 * that location on `_debugSource`; React 19 dropped it, so `source` is null on
 * a React 19 dev server — expected, not a bug to chase.
 */
export function reactReaderScript(token: string): string {
  const selector = JSON.stringify(`[${REACT_READER_ATTRIBUTE}="${token.replace(/[^a-zA-Z0-9-]/g, '')}"]`)
  return `(() => {
  const element = document.querySelector(${selector});
  const result = { components: [], source: null };
  if (!element) return result;
  let fiber = null;
  for (const key of Object.keys(element)) {
    if (key.startsWith('__reactFiber$')) { fiber = element[key] || null; break; }
  }
  const nameOf = (type) => {
    if (typeof type === 'function') return type.displayName || type.name || null;
    if (type && typeof type === 'object') {
      if (type.displayName) return type.displayName;
      if (type.render) return type.render.displayName || type.render.name || null;
      if (type.type) return nameOf(type.type);
    }
    return null;
  };
  let hops = 0;
  while (fiber && hops < 40 && result.components.length < ${MAX_COMPONENTS}) {
    const name = nameOf(fiber.type);
    if (typeof name === 'string' && name) result.components.push(name);
    const debug = fiber._debugSource;
    if (!result.source && debug && typeof debug.fileName === 'string' && debug.fileName) {
      result.source = debug.fileName + (debug.lineNumber ? ':' + debug.lineNumber : '') + (debug.columnNumber ? ':' + debug.columnNumber : '');
    }
    fiber = fiber.return || null;
    hops += 1;
  }
  return result;
})()`
}

/** The page world's answer, kept only as far as it is the shape asked for. */
export function reactContextFrom(raw: unknown): ReactContext {
  if (!raw || typeof raw !== 'object') return NO_REACT_CONTEXT
  const answer = raw as { components?: unknown; source?: unknown }
  const components = Array.isArray(answer.components)
    ? answer.components
        .filter((name): name is string => typeof name === 'string' && name.length > 0)
        .slice(0, MAX_COMPONENTS)
        .map((name) => name.slice(0, MAX_COMPONENT_NAME))
    : []
  const source = typeof answer.source === 'string' && answer.source ? answer.source.slice(0, MAX_SOURCE) : null
  return { components, source }
}

/**
 * Asks the page's world about `element` through `run` (`webFrame.executeJavaScript`
 * in the preload), marking it for the length of the question only. An answer
 * that throws, is malformed, or takes longer than `timeoutMs` is no answer:
 * the pick still goes through, without components.
 */
export async function readReactContext(
  element: Element,
  run: (code: string) => Promise<unknown>,
  token: string,
  timeoutMs = 500,
): Promise<ReactContext> {
  element.setAttribute(REACT_READER_ATTRIBUTE, token)
  let timer: ReturnType<typeof setTimeout> | undefined
  try {
    const answer = await Promise.race([
      run(reactReaderScript(token)).catch(() => null),
      new Promise<null>((resolve) => {
        timer = setTimeout(() => resolve(null), timeoutMs)
      }),
    ])
    return reactContextFrom(answer)
  } finally {
    if (timer !== undefined) clearTimeout(timer)
    element.removeAttribute(REACT_READER_ATTRIBUTE)
  }
}
