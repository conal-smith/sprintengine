import { ipcRenderer, webFrame } from 'electron'
import {
  BROWSER_MAX_OUTER_HTML,
  BROWSER_PICK_CANCELLED_CHANNEL,
  BROWSER_PICK_START_CHANNEL,
  BROWSER_PICK_STOP_CHANNEL,
  BROWSER_PICKED_CHANNEL,
  type BrowserPickTheme,
  type BrowserPickedElement,
} from '../shared/browser'
import { asReactContext, READ_REACT_CONTEXT_SCRIPT, type ReactContext } from './browser-guest-react'

// The browser guest's preload (browser-pane epic): the element picker. It
// runs sandboxed (no Node) and context-isolated: its own JavaScript world,
// sharing the page's DOM but none of its objects, so the page can neither
// reach `ipcRenderer` nor reshape anything this file calls. Nothing is put on
// `window`. The host renderer starts and stops it over the webview channel; a
// pick is reported back the same way.
//
// The one thing an isolated world cannot see is what the page's own scripts
// hung on a DOM node, which is where React keeps its fiber. That is read by a
// short script run in the page's world for the one element picked, found by a
// one-off attribute this world sets on it (`readReactContext`). What it
// answers is the page's word, re-typed and capped here and again by the host.

const STYLE_KEYS = [
  'display',
  'position',
  'width',
  'height',
  'margin',
  'padding',
  'font',
  'color',
  'background-color',
  'border-radius',
  'border',
  'opacity',
] as const

let overlay: { host: HTMLElement; box: HTMLElement; chip: HTMLElement } | null = null
let target: Element | null = null
let theme: BrowserPickTheme | null = null

function cssEscape(value: string): string {
  return typeof CSS !== 'undefined' && CSS.escape ? CSS.escape(value) : value.replace(/[^a-zA-Z0-9_-]/g, '\\$&')
}

// A stable selector: an id, a test id, a name, else a short nth-of-type path.
function selectorFor(element: Element): string {
  if (element.id) return `#${cssEscape(element.id)}`
  const testId = element.getAttribute('data-testid')
  if (testId) return `[data-testid="${testId.replace(/"/g, '\\"')}"]`
  const name = element.getAttribute('name')
  if (name && element.tagName !== 'META') return `${element.tagName.toLowerCase()}[name="${name.replace(/"/g, '\\"')}"]`
  const parts: string[] = []
  let node: Element | null = element
  while (node && node !== document.documentElement && parts.length < 8) {
    const tag = node.tagName.toLowerCase()
    const parent: Element | null = node.parentElement
    if (!parent) {
      parts.unshift(tag)
      break
    }
    const siblings = Array.from(parent.children).filter((child) => child.tagName === node!.tagName)
    parts.unshift(siblings.length > 1 ? `${tag}:nth-of-type(${siblings.indexOf(node) + 1})` : tag)
    if (parent.id) {
      parts.unshift(`#${cssEscape(parent.id)}`)
      break
    }
    node = parent
  }
  return parts.join(' > ')
}

const PICK_MARKER_ATTRIBUTE = 'data-sprintengine-pick'
const REACT_CONTEXT_TIMEOUT_MS = 1000

async function readReactContext(element: Element): Promise<ReactContext> {
  const marker = crypto.randomUUID()
  element.setAttribute(PICK_MARKER_ATTRIBUTE, marker)
  let timer: ReturnType<typeof setTimeout> | undefined
  try {
    const answer = await Promise.race([
      webFrame.executeJavaScript(
        `${READ_REACT_CONTEXT_SCRIPT}(${JSON.stringify(PICK_MARKER_ATTRIBUTE)}, ${JSON.stringify(marker)})`,
      ),
      new Promise<null>((settle) => {
        timer = setTimeout(() => settle(null), REACT_CONTEXT_TIMEOUT_MS)
      }),
    ])
    return asReactContext(answer)
  } catch {
    return { components: [], source: null }
  } finally {
    clearTimeout(timer)
    element.removeAttribute(PICK_MARKER_ATTRIBUTE)
  }
}

// Everything but the React context is read at once, as the click left the
// page; the context is asked of the page's world after.
async function serialize(element: Element): Promise<BrowserPickedElement> {
  const rect = element.getBoundingClientRect()
  const computed = getComputedStyle(element)
  const styles: Record<string, string> = {}
  for (const key of STYLE_KEYS) {
    const value = computed.getPropertyValue(key)
    if (value) styles[key] = value
  }
  const picked = {
    url: location.href,
    title: document.title,
    selector: selectorFor(element),
    tagName: element.tagName.toLowerCase(),
    text: (element.textContent ?? '').replace(/\s+/g, ' ').trim().slice(0, 200),
    outerHtml: element.outerHTML.slice(0, BROWSER_MAX_OUTER_HTML),
    rect: { x: rect.left, y: rect.top, width: rect.width, height: rect.height },
    viewport: { width: window.innerWidth, height: window.innerHeight },
    styles,
  }
  const { components, source } = await readReactContext(element)
  return { ...picked, components, source }
}

function ensureOverlay(): { host: HTMLElement; box: HTMLElement; chip: HTMLElement } {
  if (overlay) return overlay
  const host = document.createElement('div')
  host.setAttribute('data-sprintengine-picker', '')
  host.style.cssText = 'position:fixed;inset:0;z-index:2147483647;pointer-events:none;'
  // Closed shadow root: the page can neither see nor restyle the overlay.
  const shadow = host.attachShadow({ mode: 'closed' })
  const box = document.createElement('div')
  box.style.cssText = 'position:fixed;box-sizing:border-box;pointer-events:none;border:1px solid transparent;'
  const chip = document.createElement('div')
  chip.style.cssText =
    'position:fixed;pointer-events:none;font:11px ui-monospace,SFMono-Regular,Menlo,monospace;' +
    'padding:2px 6px;border-radius:3px;border:1px solid transparent;white-space:nowrap;max-width:60vw;overflow:hidden;text-overflow:ellipsis;'
  shadow.append(box, chip)
  document.documentElement.append(host)
  overlay = { host, box, chip }
  return overlay
}

function paint(element: Element | null): void {
  if (!overlay || !theme) return
  const { box, chip } = overlay
  if (!element) {
    box.style.display = 'none'
    chip.style.display = 'none'
    return
  }
  const rect = element.getBoundingClientRect()
  box.style.display = 'block'
  box.style.left = `${rect.left}px`
  box.style.top = `${rect.top}px`
  box.style.width = `${rect.width}px`
  box.style.height = `${rect.height}px`
  box.style.borderColor = theme.accent
  box.style.background = theme.accentSoft
  const id = element.id ? `#${element.id}` : ''
  const classes = Array.from(element.classList)
    .slice(0, 2)
    .map((name) => `.${name}`)
    .join('')
  chip.textContent = `${element.tagName.toLowerCase()}${id}${classes} · ${Math.round(rect.width)} × ${Math.round(rect.height)}`
  chip.style.display = 'block'
  chip.style.background = theme.chipBackground
  chip.style.borderColor = theme.chipBorder
  chip.style.color = theme.chipText
  const chipTop = rect.top - 24 >= 0 ? rect.top - 24 : rect.bottom + 4
  chip.style.left = `${Math.max(0, rect.left)}px`
  chip.style.top = `${chipTop}px`
}

function elementAt(event: MouseEvent): Element | null {
  const found = document.elementFromPoint(event.clientX, event.clientY)
  if (!found || found === document.documentElement || found === document.body) return null
  if (overlay && (found === overlay.host || overlay.host.contains(found))) return null
  return found
}

function onMove(event: MouseEvent): void {
  target = elementAt(event)
  paint(target)
}

function onClick(event: MouseEvent): void {
  event.preventDefault()
  event.stopPropagation()
  // A click the page's own script made is not the person picking.
  if (!event.isTrusted) return
  const picked = elementAt(event) ?? target
  if (!picked) return
  stop()
  void serialize(picked).then((payload) => ipcRenderer.sendToHost(BROWSER_PICKED_CHANNEL, payload))
}

function swallow(event: Event): void {
  event.preventDefault()
  event.stopPropagation()
}

function onKey(event: KeyboardEvent): void {
  if (event.key === 'Escape' && event.isTrusted) {
    event.preventDefault()
    event.stopPropagation()
    stop()
    ipcRenderer.sendToHost(BROWSER_PICK_CANCELLED_CHANNEL)
  }
}

let listening = false

function start(nextTheme: BrowserPickTheme): void {
  theme = nextTheme
  ensureOverlay()
  if (listening) return
  listening = true
  document.addEventListener('mousemove', onMove, true)
  document.addEventListener('click', onClick, true)
  document.addEventListener('mousedown', swallow, true)
  document.addEventListener('mouseup', swallow, true)
  document.addEventListener('keydown', onKey, true)
  document.documentElement.style.cursor = 'crosshair'
}

function stop(): void {
  if (!listening) return
  listening = false
  document.removeEventListener('mousemove', onMove, true)
  document.removeEventListener('click', onClick, true)
  document.removeEventListener('mousedown', swallow, true)
  document.removeEventListener('mouseup', swallow, true)
  document.removeEventListener('keydown', onKey, true)
  document.documentElement.style.cursor = ''
  target = null
  paint(null)
}

ipcRenderer.on(BROWSER_PICK_START_CHANNEL, (_event, nextTheme: BrowserPickTheme) => start(nextTheme))
ipcRenderer.on(BROWSER_PICK_STOP_CHANNEL, () => stop())

// A navigation tears the picker down with the document; the host learns of
// it through the tab's own state, so nothing to report here.
window.addEventListener('pagehide', () => stop())
