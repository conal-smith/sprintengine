import {
  BROWSER_MAX_OUTER_HTML,
  type BrowserPickTheme,
  type BrowserPickedElement,
} from '../../../../../../shared/browser'
import { useWorkspaceStore } from '../../../../store/workspaceStore'
import { focusedAgentTabInLayout } from '../../../../utils/modelRegistry'
import { bracketedPaste } from '../../../../utils/terminalDrop'

// What an element pick becomes for an agent (browser-pane epic, decision 8):
// a `<browser_element>` block with the page URL, a stable selector, the React
// component and source when the page exposes them, the element's HTML and the
// styles that decide how it looks — parked at the focused agent terminal's
// prompt, unsubmitted, the way a dragged skill is. Pure, so it is testable.

export function buildBrowserElementBlock(picked: BrowserPickedElement, screenshotPath: string | null): string {
  const attributes = [
    `url="${escapeAttribute(picked.url)}"`,
    `selector="${escapeAttribute(picked.selector)}"`,
    picked.components.length > 0 ? `component="${escapeAttribute(picked.components.join(' < '))}"` : null,
    picked.source ? `source="${escapeAttribute(picked.source)}"` : null,
  ].filter((part): part is string => part !== null)
  const styles = Object.entries(picked.styles)
    .map(([key, value]) => `${key}:${withoutBlockTags(value)}`)
    .join('; ')
  const lines = [
    `<browser_element ${attributes.join(' ')}>`,
    `<html>${withoutBlockTags(picked.outerHtml)}</html>`,
    styles ? `<styles>${styles}</styles>` : null,
    '</browser_element>',
    screenshotPath ? `Screenshot: ${screenshotPath}` : null,
  ].filter((line): line is string => line !== null)
  return lines.join('\n')
}

// The element's HTML and its computed styles are the page's text, set inside
// the block's own `<html>` and `<styles>` elements. A tag in that text naming
// one of the block's elements could end the block early and leave whatever
// the page wrote after it reading as the person's prompt, so its `<` is
// written as `&lt;`. Only those tags: the rest of the markup stays as the page
// has it, which is what an agent reads best. Matched however a parser would
// still call it a tag — any case, space before the name or the slash.
const BLOCK_TAG = /<(?=\s*\/?\s*(?:html|styles|browser_element)\b)/gi

function withoutBlockTags(value: string): string {
  return value.replace(BLOCK_TAG, '&lt;')
}

function escapeAttribute(value: string): string {
  return value.replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/\n/g, ' ')
}

// The page controls what the guest preload reports (it owns the DOM the
// preload reads, and the world its React context comes from), so the payload
// is untrusted: every field is re-typed and
// re-capped here before it reaches an agent's prompt or the clipboard.
const MAX_TEXT = 200
const MAX_SELECTOR = 1000
const MAX_URL = 2048
const MAX_TITLE = 300
const MAX_STYLE_VALUE = 200
const MAX_STYLES = 40
const MAX_COMPONENTS = 3
const MAX_COMPONENT_NAME = 80

// C0/C1 controls (and DEL) are stripped, keeping only tab and newline: the
// block is delivered as a bracketed paste, and an ESC sequence in an attribute
// could end the paste early and hand the rest to the CLI as keystrokes.
const CONTROL_CHARS = /[\u0000-\u0008\u000b-\u001f\u007f-\u009f]/g

function cappedString(value: unknown, max: number): string | null {
  return typeof value === 'string' ? value.replace(CONTROL_CHARS, '').slice(0, max) : null
}

function finiteRect(value: unknown): BrowserPickedElement['rect'] | null {
  if (!value || typeof value !== 'object') return null
  const raw = value as Record<string, unknown>
  const numbers = [raw.x, raw.y, raw.width, raw.height]
  if (!numbers.every((n) => typeof n === 'number' && Number.isFinite(n) && Math.abs(n) < 1e7)) return null
  return { x: raw.x as number, y: raw.y as number, width: raw.width as number, height: raw.height as number }
}

export function normalizePickedElement(input: unknown): BrowserPickedElement | null {
  if (!input || typeof input !== 'object') return null
  const raw = input as Record<string, unknown>
  const url = cappedString(raw.url, MAX_URL)
  const selector = cappedString(raw.selector, MAX_SELECTOR)
  const tagName = cappedString(raw.tagName, 40)
  const rect = finiteRect(raw.rect)
  if (url === null || selector === null || tagName === null || rect === null) return null
  const viewportRaw = raw.viewport as Record<string, unknown> | undefined
  const viewport =
    viewportRaw &&
    typeof viewportRaw.width === 'number' &&
    typeof viewportRaw.height === 'number' &&
    Number.isFinite(viewportRaw.width) &&
    Number.isFinite(viewportRaw.height)
      ? { width: viewportRaw.width, height: viewportRaw.height }
      : { width: 0, height: 0 }
  const styles: Record<string, string> = {}
  if (raw.styles && typeof raw.styles === 'object') {
    for (const [key, value] of Object.entries(raw.styles as Record<string, unknown>).slice(0, MAX_STYLES)) {
      if (typeof value === 'string' && /^[a-z-]+$/.test(key)) styles[key] = value.slice(0, MAX_STYLE_VALUE)
    }
  }
  const components = Array.isArray(raw.components)
    ? raw.components
        .filter((c): c is string => typeof c === 'string')
        .slice(0, MAX_COMPONENTS)
        .map((c) => c.slice(0, MAX_COMPONENT_NAME))
    : []
  return {
    url,
    title: cappedString(raw.title, MAX_TITLE) ?? '',
    selector,
    tagName,
    text: cappedString(raw.text, MAX_TEXT) ?? '',
    outerHtml: cappedString(raw.outerHtml, BROWSER_MAX_OUTER_HTML) ?? '',
    rect,
    viewport,
    styles,
    components,
    source: cappedString(raw.source, 500),
  }
}

export type SendToAgentResult = { ok: true } | { ok: false; reason: 'no_agent' | 'no_session' | 'write_failed' }

/**
 * Park text at the focused agent's prompt, unsubmitted: the agent the
 * workspace's layout says is on screen, through its live pty. Nothing is
 * submitted — a bracketed paste is text at the prompt, not a keypress.
 */
export async function sendTextToFocusedAgent(workspaceId: string, text: string): Promise<SendToAgentResult> {
  const workspace = useWorkspaceStore.getState().workspaces.find((w) => w.id === workspaceId)
  const focused = focusedAgentTabInLayout(workspace?.layoutModel)
  if (!focused) return { ok: false, reason: 'no_agent' }
  let sessionId = focused.sessionId
  try {
    const sessions = await window.api.terminalList()
    const live = sessions.find(
      (session) =>
        session.kind === 'agent' &&
        session.processAlive &&
        (session.sessionId === sessionId ||
          (session.workspaceId === workspaceId && session.agentId === focused.agentId)),
    )
    if (!live) return { ok: false, reason: 'no_session' }
    sessionId = live.sessionId
    // A trailing space, the convention every other prefill follows: the caret
    // sits after the block, and nothing submits even in a CLI without
    // bracketed-paste support (a literal newline would).
    await window.api.terminalWrite(sessionId, bracketedPaste(`${text} `))
    return { ok: true }
  } catch {
    return { ok: false, reason: 'write_failed' }
  }
}

/** The picker overlay's colours, read from the app's live tokens. */
export function readPickTheme(): BrowserPickTheme {
  const style = getComputedStyle(document.documentElement)
  // Fallbacks are CSS system colours, never literals of our own: a token that
  // failed to resolve is the theme's problem, not a second palette.
  const read = (name: string, fallback: string) => style.getPropertyValue(name).trim() || fallback
  return {
    accent: read('--accent-primary', 'Highlight'),
    accentSoft: read('--accent-primary-soft', 'transparent'),
    chipBackground: read('--bg-surface-raised', 'Canvas'),
    chipBorder: read('--border-strong', 'GrayText'),
    chipText: read('--text-strong', 'CanvasText'),
  }
}
