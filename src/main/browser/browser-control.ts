import { AsyncLocalStorage } from 'node:async_hooks'

import type { WebContents } from 'electron'

import type { BrowserPointerEvent } from '../../shared/browser'
import type { BrowserDownload } from './browser-manager'

// The agent's hands on a browser tab (browser-pane epic, child 6). One
// in-process DevTools-protocol session per tab, shared with the appearance
// emulation in browser-manager: Chromium allows a single client per target, so
// this is the only place that talks CDP to a guest. The `browser.*` MCP tools
// (automation/browser-tools.ts) are thin wrappers over these methods.
//
// Two rules the whole file serves:
// - The person always wins. Every action records the tab's epoch when it
//   starts (browser-manager bumps it on any human chord or toolbar command)
//   and yields with `interrupted` if it moved under it.
// - Everything the agent reads is bounded: node counts, text lengths,
//   buffered console and network entries, image dimensions — the gateway
//   socket carries one JSON line per result.

const SNAPSHOT_MAX_NODES = 400
const SNAPSHOT_MAX_CHARS = 24_000
const SNAPSHOT_MAX_NAME_CHARS = 80
const ACTION_HISTORY_MAX = 50
// Consecutive human inputs closer than this are one takeover entry, not one per keystroke.
const HUMAN_ACTION_COALESCE_MS = 2_000
export const CONSOLE_BUFFER_MAX = 200
const NETWORK_BUFFER_MAX = 200
const EVALUATE_MAX_CHARS = 16_000
const SCREENSHOT_MAX_EDGE = 1024
const SCREENSHOT_JPEG_QUALITY = 80
const DEFAULT_WAIT_MS = 5_000
const MAX_WAIT_MS = 30_000
// An expression the page never settles must not hold the gateway call open.
const MAX_EVALUATE_MS = 30_000
// capturePage can hang on a guest mid-teardown (browser-manager has the same guard).
const CAPTURE_TIMEOUT_MS = 5_000
const WAIT_POLL_MS = 150
const REFS_GLOBAL = '__seBrowserRefs'

export type BrowserControlError = {
  ok: false
  code:
    'no_tab' | 'interrupted' | 'not_found' | 'not_visible' | 'cdp' | 'timeout' | 'invalid' | 'dialog_open' | 'no_dialog'
  message: string
}

/** A JavaScript dialog the page opened, which holds the page until someone answers it. */
export type BrowserDialog = {
  type: 'alert' | 'confirm' | 'prompt' | 'beforeunload'
  message: string
  /** A prompt's own default answer. */
  defaultPrompt?: string
  url: string
  openedAt: string
}
export type DialogResult = { ok: true; answered: BrowserDialog; accepted: boolean }

export type ConsoleEntry = {
  level: 'log' | 'info' | 'warn' | 'error' | 'debug'
  text: string
  /** `source:line` when the message carries a location. */
  location: string | null
  at: number
}

export type NetworkEntry = {
  requestId: string
  method: string
  url: string
  status: number | null
  /** `failed` carries the network error text; `pending` has not finished. */
  outcome: 'pending' | 'ok' | 'failed'
  errorText: string | null
  resourceType: string | null
  at: number
}

/** One thing that happened to a tab: an agent action, a file it downloaded, or the person taking it back. */
export type ActionEntry = {
  id: string
  /** The tool's verb (`click`, `type`, …), `download` for a file the page sent, or `human` for the person's own input. */
  action: string
  /** A short rendering of the arguments, never the full text typed; a download's URL. */
  args: string
  /** Where a download was saved. */
  path?: string
  status: 'running' | 'succeeded' | 'failed' | 'interrupted'
  startedAt: string
  completedAt?: string
  error?: string
}

export type SnapshotResult = {
  ok: true
  text: string
  nodeCount: number
  truncated: boolean
  url: string
  title: string
}
export type ScreenshotResult = { ok: true; data: string; mimeType: 'image/jpeg'; width: number; height: number }
export type EvaluateResult = { ok: true; value: unknown; truncated: boolean }
export type ActionResult = { ok: true }

export type BrowserControlManager = {
  webContentsOf(tabId: string): WebContents | null
  epochOf(tabId: string): number
  noteAgentActivity(tabId: string): void
  noteAgentInput(tabId: string, delta: 1 | -1): void
  /** Subscribe to the person's own input on any tab (the epoch bumps). */
  onHumanInput(listener: (tabId: string) => void): () => void
  /** Subscribe to the downloads a tab the agent drives saved, as each starts and ends. */
  onDownload(listener: (tabId: string, download: BrowserDownload) => void): () => void
  /** Where the agent's pointer is about to act, for the cursor overlay. */
  notePointer(event: BrowserPointerEvent): void
}

/** What a snapshot ref or selector resolves to inside the page. */
type Target = { ref?: string; selector?: string }

type Session = {
  tabId: string
  wc: WebContents
  /**
   * The tab's debugger, read once as the session opens. `wc.debugger` throws
   * once the contents are destroyed, which is where the session is disposed.
   */
  dbg: WebContents['debugger']
  console: ConsoleEntry[]
  network: NetworkEntry[]
  /** Newest last; agent actions and the person's takeovers, so an `interrupted` explains itself. */
  actions: ActionEntry[]
  attached: boolean
  /**
   * A dialog the page has open. It holds the page's script, so every action
   * but answering it would wait on a page that cannot answer.
   */
  dialog: BrowserDialog | null
  /** Told when a dialog opens, so an action already waiting on the page can stop. */
  onDialog: Set<(dialog: BrowserDialog) => void>
  /**
   * The viewport's CSS size when the last point was read, sent with each
   * pointer event so a recording can place the cursor on its frames.
   */
  viewport: { width: number; height: number } | null
  dispose: () => void
}

// The page-side walker. Runs in the guest's main world via Runtime.evaluate
// and returns a compact role/name outline with `[ref=eN]` handles, storing the
// elements on a page global so a later action can resolve the handle. The
// page can tamper with that global; this is a preview of the person's own dev
// server, and the person sees every action the agent takes.
const SNAPSHOT_SCRIPT = `(() => {
  const MAX_NODES = ${SNAPSHOT_MAX_NODES};
  const MAX_NAME = ${SNAPSHOT_MAX_NAME_CHARS};
  const refs = {};
  let n = 0;
  const lines = [];
  let truncated = false;
  const clip = (s) => { s = (s || '').replace(/\\s+/g, ' ').trim(); return s.length > MAX_NAME ? s.slice(0, MAX_NAME - 1) + '…' : s; };
  const visible = (el) => {
    if (!(el instanceof Element)) return false;
    const cs = getComputedStyle(el);
    if (cs.display === 'none' || cs.visibility === 'hidden') return false;
    const r = el.getBoundingClientRect();
    return r.width > 0 || r.height > 0 || el.tagName === 'OPTION';
  };
  const roleOf = (el) => {
    const explicit = el.getAttribute('role');
    if (explicit) return explicit;
    const tag = el.tagName.toLowerCase();
    if (tag === 'a' && el.hasAttribute('href')) return 'link';
    if (tag === 'button') return 'button';
    if (tag === 'input') {
      const t = (el.getAttribute('type') || 'text').toLowerCase();
      if (t === 'checkbox' || t === 'radio') return t;
      if (t === 'submit' || t === 'button' || t === 'reset') return 'button';
      if (t === 'hidden') return null;
      return 'textbox';
    }
    if (tag === 'textarea') return 'textbox';
    if (tag === 'select') return 'combobox';
    if (tag === 'option') return 'option';
    if (/^h[1-6]$/.test(tag)) return 'heading';
    if (tag === 'img') return 'img';
    if (tag === 'li') return 'listitem';
    if (tag === 'nav') return 'navigation';
    if (tag === 'main') return 'main';
    if (tag === 'form') return 'form';
    if (tag === 'table') return 'table';
    if (tag === 'dialog' || el.getAttribute('aria-modal') === 'true') return 'dialog';
    if (tag === 'label') return 'label';
    if (tag === 'summary') return 'button';
    if (tag === 'p' || tag === 'span' || tag === 'div' || tag === 'td' || tag === 'th' || tag === 'legend' || tag === 'figcaption') return 'text';
    return null;
  };
  const nameOf = (el, role) => {
    const aria = el.getAttribute('aria-label');
    if (aria) return clip(aria);
    const labelled = el.getAttribute('aria-labelledby');
    if (labelled) {
      const t = labelled.split(/\\s+/).map((id) => { const x = document.getElementById(id); return x ? x.textContent : ''; }).join(' ');
      if (t.trim()) return clip(t);
    }
    if (el.tagName === 'IMG') return clip(el.getAttribute('alt') || '');
    if (el.tagName === 'INPUT' || el.tagName === 'TEXTAREA' || el.tagName === 'SELECT') {
      if (el.labels && el.labels.length) return clip(el.labels[0].textContent);
      return clip(el.getAttribute('placeholder') || el.getAttribute('name') || '');
    }
    if (role === 'text' || role === 'listitem' || role === 'label') {
      // Only a leaf-ish text node earns a line; containers are described by children.
      let direct = '';
      for (const c of el.childNodes) if (c.nodeType === 3) direct += c.textContent;
      return clip(direct);
    }
    return clip(el.innerText || el.textContent || '');
  };
  const walk = (el, depth) => {
    if (n >= MAX_NODES) { truncated = true; return; }
    if (!visible(el)) return;
    const tag = el.tagName.toLowerCase();
    if (tag === 'script' || tag === 'style' || tag === 'noscript' || tag === 'svg' || tag === 'template') return;
    const role = roleOf(el);
    let emitted = false;
    if (role) {
      const name = nameOf(el, role);
      const interactive = /^(link|button|textbox|checkbox|radio|combobox|option|menuitem|tab|switch|slider|searchbox)$/.test(role) || el.hasAttribute('onclick') || el.tabIndex >= 0 && tag !== 'div';
      if (name || interactive || role === 'dialog' || role === 'img') {
        n += 1;
        const ref = 'e' + n;
        refs[ref] = el;
        const bits = [role];
        if (name) bits.push(JSON.stringify(name));
        if (role === 'heading') bits.push('level=' + (tag[1] || el.getAttribute('aria-level') || '2'));
        if (el.tagName === 'INPUT' || el.tagName === 'TEXTAREA') { const v = el.value; if (v) bits.push('value=' + JSON.stringify(clip(v))); }
        if (el.tagName === 'SELECT' && el.selectedOptions && el.selectedOptions[0]) bits.push('value=' + JSON.stringify(clip(el.selectedOptions[0].textContent)));
        if (role === 'checkbox' || role === 'radio' || role === 'switch') bits.push(el.checked || el.getAttribute('aria-checked') === 'true' ? 'checked' : 'unchecked');
        if (el.disabled || el.getAttribute('aria-disabled') === 'true') bits.push('disabled');
        if (role === 'link') { const h = el.getAttribute('href'); if (h && h.length < 120) bits.push('href=' + JSON.stringify(h)); }
        bits.push('[ref=' + ref + ']');
        lines.push('  '.repeat(depth) + '- ' + bits.join(' '));
        emitted = true;
      }
    }
    if (role === 'text' && emitted && el.children.length === 0) return;
    const nextDepth = emitted ? depth + 1 : depth;
    for (const child of el.children) walk(child, nextDepth);
    if (el.shadowRoot) for (const child of el.shadowRoot.children) walk(child, nextDepth);
  };
  if (document.body) walk(document.body, 0);
  window['${REFS_GLOBAL}'] = refs;
  return { text: lines.join('\\n'), nodeCount: n, truncated, url: location.href, title: document.title };
})()`

function clampWait(timeoutMs: unknown): number {
  const n = typeof timeoutMs === 'number' && Number.isFinite(timeoutMs) ? timeoutMs : DEFAULT_WAIT_MS
  return Math.max(0, Math.min(MAX_WAIT_MS, Math.floor(n)))
}

function targetExpression(target: Target): string {
  if (target.ref) return `(window[${JSON.stringify(REFS_GLOBAL)}] || {})[${JSON.stringify(target.ref)}]`
  return `document.querySelector(${JSON.stringify(target.selector ?? '')})`
}

// Key names the agent may press, as the CDP key events Chromium expects. Text
// keys go through Input.insertText instead (see `type`).
const KEY_TABLE: Record<string, { key: string; code: string; keyCode: number }> = {
  Enter: { key: 'Enter', code: 'Enter', keyCode: 13 },
  Tab: { key: 'Tab', code: 'Tab', keyCode: 9 },
  Escape: { key: 'Escape', code: 'Escape', keyCode: 27 },
  Backspace: { key: 'Backspace', code: 'Backspace', keyCode: 8 },
  Delete: { key: 'Delete', code: 'Delete', keyCode: 46 },
  ArrowUp: { key: 'ArrowUp', code: 'ArrowUp', keyCode: 38 },
  ArrowDown: { key: 'ArrowDown', code: 'ArrowDown', keyCode: 40 },
  ArrowLeft: { key: 'ArrowLeft', code: 'ArrowLeft', keyCode: 37 },
  ArrowRight: { key: 'ArrowRight', code: 'ArrowRight', keyCode: 39 },
  Home: { key: 'Home', code: 'Home', keyCode: 36 },
  End: { key: 'End', code: 'End', keyCode: 35 },
  PageUp: { key: 'PageUp', code: 'PageUp', keyCode: 33 },
  PageDown: { key: 'PageDown', code: 'PageDown', keyCode: 34 },
  Space: { key: ' ', code: 'Space', keyCode: 32 },
}

/** `Shift+Tab`, `Meta+a`, `Enter` → the CDP key descriptor plus a modifier mask. */
export function parseKeyChord(chord: string): { key: string; code: string; keyCode: number; modifiers: number } | null {
  const parts = chord
    .split('+')
    .map((p) => p.trim())
    .filter(Boolean)
  if (parts.length === 0) return null
  let modifiers = 0
  let main: string | null = null
  for (const part of parts) {
    const lower = part.toLowerCase()
    if (lower === 'alt' || lower === 'option') modifiers |= 1
    else if (lower === 'ctrl' || lower === 'control') modifiers |= 2
    else if (lower === 'meta' || lower === 'cmd' || lower === 'command') modifiers |= 4
    else if (lower === 'shift') modifiers |= 8
    else if (main === null) main = part
    else return null
  }
  if (main === null) return null
  const capitalised = main.charAt(0).toUpperCase() + main.slice(1)
  const named = Object.hasOwn(KEY_TABLE, main)
    ? KEY_TABLE[main]
    : Object.hasOwn(KEY_TABLE, capitalised)
      ? KEY_TABLE[capitalised]
      : undefined
  if (named) return { ...named, modifiers }
  if (main.length === 1) {
    const upper = main.toUpperCase()
    const isLetter = /[A-Z]/.test(upper)
    return {
      key: modifiers & 8 ? upper : main,
      code: isLetter ? `Key${upper}` : /[0-9]/.test(main) ? `Digit${main}` : '',
      keyCode: upper.charCodeAt(0),
      modifiers,
    }
  }
  return null
}

export function createBrowserControl(manager: BrowserControlManager) {
  const sessions = new Map<string, Session>()
  let actionSequence = 0

  // The person's input on a tab this layer knows becomes a `human` entry in
  // that tab's history; a burst of keystrokes is one entry, extended.
  manager.onHumanInput((tabId) => {
    const s = sessions.get(tabId)
    if (!s) return
    const now = new Date()
    const last = s.actions[s.actions.length - 1]
    if (
      last &&
      last.action === 'human' &&
      last.completedAt &&
      now.getTime() - Date.parse(last.completedAt) <= HUMAN_ACTION_COALESCE_MS
    ) {
      last.completedAt = now.toISOString()
      return
    }
    pushBounded(s.actions, ACTION_HISTORY_MAX, {
      id: nextActionId(),
      action: 'human',
      args: '',
      status: 'succeeded',
      startedAt: now.toISOString(),
      completedAt: now.toISOString(),
    })
  })

  // A download the agent's action set off is saved without a dialog
  // (browser-manager); its entry says where, and whether it finished.
  manager.onDownload((tabId, download) => {
    const s = sessions.get(tabId)
    if (!s) return
    if (download.state === 'started') {
      pushBounded(s.actions, ACTION_HISTORY_MAX, {
        id: nextActionId(),
        action: 'download',
        args: download.url.slice(0, 200),
        path: download.path,
        status: 'running',
        startedAt: new Date().toISOString(),
      })
      return
    }
    const entry = s.actions.findLast((candidate) => candidate.action === 'download' && candidate.path === download.path)
    if (!entry) return
    entry.status = download.state === 'completed' ? 'succeeded' : 'failed'
    entry.completedAt = new Date().toISOString()
    if (download.state !== 'completed') entry.error = `The download was ${download.state}.`
  })

  function nextActionId(): string {
    actionSequence += 1
    return `a${Date.now().toString(36)}-${actionSequence.toString(36)}`
  }

  function fail(code: BrowserControlError['code'], message: string): BrowserControlError {
    return { ok: false, code, message }
  }

  async function session(tabId: string): Promise<Session | BrowserControlError> {
    const wc = manager.webContentsOf(tabId)
    if (!wc || wc.isDestroyed()) return fail('no_tab', `Browser tab "${tabId}" is not open.`)
    let existing = sessions.get(tabId)
    if (existing && existing.wc !== wc) {
      existing.dispose()
      existing = undefined
    }
    if (!existing) {
      const dbg = wc.debugger
      const created: Session = {
        tabId,
        wc,
        dbg,
        console: [],
        network: [],
        actions: [],
        attached: false,
        dialog: null,
        onDialog: new Set(),
        viewport: null,
        dispose: () => {},
      }
      const onMessage = (_event: unknown, method: string, params: Record<string, unknown>) =>
        onCdpEvent(created, method, params)
      const onDetach = () => {
        created.attached = false
      }
      const onDestroyed = () => {
        if (sessions.get(tabId) === created) sessions.delete(tabId)
        created.dispose()
      }
      dbg.on('message', onMessage)
      dbg.on('detach', onDetach)
      wc.once('destroyed', onDestroyed)
      created.dispose = () => {
        // Also run as the contents are destroyed, when what is left of them
        // may throw: nothing here may stop the rest of a teardown.
        try {
          dbg.removeListener('message', onMessage)
          dbg.removeListener('detach', onDetach)
          wc.removeListener('destroyed', onDestroyed)
        } catch {
          // Gone with the contents.
        }
      }
      sessions.set(tabId, created)
      existing = created
    }
    const { dbg } = existing
    if (!existing.attached || !dbg.isAttached()) {
      if (wc.isDevToolsOpened()) {
        return fail('cdp', 'DevTools is open on this tab; close it to let the agent drive the page.')
      }
      try {
        if (!dbg.isAttached()) dbg.attach('1.3')
        await dbg.sendCommand('Runtime.enable')
        await dbg.sendCommand('Log.enable')
        await dbg.sendCommand('Network.enable', { maxPostDataSize: 0 })
        await dbg.sendCommand('Page.enable')
        existing.attached = true
      } catch (error) {
        return fail('cdp', `Could not attach to the page: ${error instanceof Error ? error.message : String(error)}`)
      }
    }
    return existing
  }

  function onCdpEvent(s: Session, method: string, params: Record<string, unknown>): void {
    const at = Date.now()
    if (method === 'Runtime.consoleAPICalled') {
      const type = String(params.type ?? 'log')
      const level: ConsoleEntry['level'] =
        type === 'error' || type === 'assert'
          ? 'error'
          : type === 'warning'
            ? 'warn'
            : type === 'info'
              ? 'info'
              : type === 'debug'
                ? 'debug'
                : 'log'
      const args = Array.isArray(params.args) ? (params.args as Array<Record<string, unknown>>) : []
      const text = args.map(describeRemoteObject).join(' ')
      const trace = params.stackTrace as { callFrames?: Array<{ url?: string; lineNumber?: number }> } | undefined
      const frame = trace?.callFrames?.[0]
      pushBounded(s.console, CONSOLE_BUFFER_MAX, {
        level,
        text: text.slice(0, 2000),
        location: frame?.url ? `${frame.url}:${(frame.lineNumber ?? 0) + 1}` : null,
        at,
      })
    } else if (method === 'Runtime.exceptionThrown') {
      const details = params.exceptionDetails as
        { text?: string; exception?: Record<string, unknown>; url?: string; lineNumber?: number } | undefined
      const text = details?.exception
        ? describeRemoteObject(details.exception)
        : (details?.text ?? 'Uncaught exception')
      pushBounded(s.console, CONSOLE_BUFFER_MAX, {
        level: 'error',
        text: `Uncaught ${text}`.slice(0, 2000),
        location: details?.url ? `${details.url}:${(details.lineNumber ?? 0) + 1}` : null,
        at,
      })
    } else if (method === 'Log.entryAdded') {
      const entry = params.entry as
        { level?: string; text?: string; url?: string; lineNumber?: number; source?: string } | undefined
      if (!entry) return
      const level: ConsoleEntry['level'] =
        entry.level === 'error'
          ? 'error'
          : entry.level === 'warning'
            ? 'warn'
            : entry.level === 'verbose'
              ? 'debug'
              : 'info'
      pushBounded(s.console, CONSOLE_BUFFER_MAX, {
        level,
        text: `[${entry.source ?? 'browser'}] ${entry.text ?? ''}`.slice(0, 2000),
        location: entry.url ? `${entry.url}:${(entry.lineNumber ?? 0) + 1}` : null,
        at,
      })
    } else if (method === 'Network.requestWillBeSent') {
      const request = params.request as { method?: string; url?: string } | undefined
      const url = request?.url ?? ''
      if (url.startsWith('data:')) return
      pushBounded(s.network, NETWORK_BUFFER_MAX, {
        requestId: String(params.requestId ?? ''),
        method: request?.method ?? 'GET',
        url: url.slice(0, 500),
        status: null,
        outcome: 'pending',
        errorText: null,
        resourceType: typeof params.type === 'string' ? params.type : null,
        at,
      })
    } else if (method === 'Network.responseReceived') {
      const entry = s.network.find((candidate) => candidate.requestId === params.requestId)
      const response = params.response as { status?: number } | undefined
      if (entry && response) entry.status = response.status ?? null
    } else if (method === 'Network.loadingFinished') {
      const entry = s.network.find((candidate) => candidate.requestId === params.requestId)
      if (entry) entry.outcome = 'ok'
    } else if (method === 'Network.loadingFailed') {
      const entry = s.network.find((candidate) => candidate.requestId === params.requestId)
      if (entry) {
        entry.outcome = 'failed'
        entry.errorText = typeof params.errorText === 'string' ? params.errorText : 'failed'
      }
    } else if (method === 'Page.frameNavigated') {
      const frame = params.frame as { parentId?: string } | undefined
      // A new document: the page's console is what the person would see after
      // the navigation, and the refs from the last snapshot are gone.
      if (frame && !frame.parentId) {
        s.console.length = 0
        s.network.length = 0
        s.dialog = null
      }
    } else if (method === 'Page.javascriptDialogOpening') {
      const type = ['alert', 'confirm', 'prompt', 'beforeunload'].includes(String(params.type))
        ? (params.type as BrowserDialog['type'])
        : 'alert'
      const dialog: BrowserDialog = {
        type,
        message: String(params.message ?? '').slice(0, 2_000),
        ...(typeof params.defaultPrompt === 'string' && params.defaultPrompt
          ? { defaultPrompt: params.defaultPrompt.slice(0, 2_000) }
          : {}),
        url: String(params.url ?? '').slice(0, 500),
        openedAt: new Date(at).toISOString(),
      }
      s.dialog = dialog
      for (const listener of [...s.onDialog]) listener(dialog)
    } else if (method === 'Page.javascriptDialogClosed') {
      // Answered: by the agent, or by the person in the pane.
      s.dialog = null
    }
  }

  async function evaluateRaw(
    s: Session,
    expression: string,
    awaitPromise = true,
    timeoutMs = MAX_EVALUATE_MS,
  ): Promise<{ value: unknown; exception: string | null }> {
    stopIfAbandoned()
    const result = (await withDeadline(
      s.dbg.sendCommand('Runtime.evaluate', {
        expression,
        returnByValue: true,
        awaitPromise,
        userGesture: true,
        timeout: timeoutMs,
      }),
      timeoutMs,
      `The page did not answer within ${timeoutMs}ms.`,
    )) as {
      result: { value?: unknown; type?: string; description?: string }
      exceptionDetails?: { text?: string; exception?: Record<string, unknown> }
    }
    // The page may have answered only because a dialog it held for was closed.
    stopIfAbandoned()
    if (result.exceptionDetails) {
      const ex = result.exceptionDetails
      return {
        value: undefined,
        exception: ex.exception ? describeRemoteObject(ex.exception) : (ex.text ?? 'Evaluation failed'),
      }
    }
    return { value: result.result.value, exception: null }
  }

  /**
   * Runs `fn` with the tab's session, refusing to finish if a human touched the
   * tab while it ran. The badge lights for the duration.
   */
  async function act<T extends { ok: true }>(
    tabId: string,
    action: string,
    args: string,
    fn: (s: Session, checkpoint: () => BrowserControlError | null) => Promise<T | BrowserControlError>,
  ): Promise<T | BrowserControlError> {
    const s = await session(tabId)
    if ('ok' in s) return s
    if (s.dialog) return dialogOpen(s.dialog)
    const epoch = manager.epochOf(tabId)
    const checkpoint = () =>
      manager.epochOf(tabId) !== epoch
        ? fail('interrupted', 'The person took over the browser; the action was abandoned.')
        : null
    const entry: ActionEntry = {
      id: nextActionId(),
      action,
      args: args.slice(0, 200),
      status: 'running',
      startedAt: new Date().toISOString(),
    }
    pushBounded(s.actions, ACTION_HISTORY_MAX, entry)
    const finish = (status: ActionEntry['status'], error?: string) => {
      entry.status = status
      entry.completedAt = new Date().toISOString()
      if (error) entry.error = error.slice(0, 300)
    }
    // The badge lingers a moment past each call; a long action re-lights it
    // while it runs so it never goes dark mid-wait.
    manager.noteAgentActivity(tabId)
    const keepLit = setInterval(() => manager.noteAgentActivity(tabId), 1_000)
    // A dialog the action makes the page open holds the page, and the action
    // with it: the agent is told at once rather than at the action's deadline.
    // The action itself keeps running past that report, parked on a page call
    // the dialog holds; once it is answered the call returns, and without the
    // token the old action would go on typing or submitting under the next one.
    const token: ActToken = { abandoned: false }
    let stopWaiting: ((dialog: BrowserDialog) => void) | null = null
    const opened = new Promise<BrowserControlError>((resolve) => {
      stopWaiting = (dialog) => {
        token.abandoned = true
        resolve(dialogOpen(dialog, true))
      }
      s.onDialog.add(stopWaiting)
    })
    try {
      const out = await Promise.race([acting.run(token, () => fn(s, checkpoint)), opened])
      if (out.ok) {
        // A yielded action does not re-light the badge: the person has the page.
        manager.noteAgentActivity(tabId)
        finish('succeeded')
      } else {
        finish(out.code === 'interrupted' ? 'interrupted' : 'failed', out.message)
      }
      return out
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      finish('failed', message)
      return fail(error instanceof DeadlineError ? 'timeout' : 'cdp', message)
    } finally {
      clearInterval(keepLit)
      if (stopWaiting) s.onDialog.delete(stopWaiting)
    }
  }

  function dialogOpen(dialog: BrowserDialog, justOpened = false): BrowserControlError {
    const what = dialog.type === 'beforeunload' ? 'leave-page' : dialog.type
    return fail(
      'dialog_open',
      `${justOpened ? 'The page opened' : 'The page has'} a ${what} dialog${dialog.message ? `: "${dialog.message}"` : ''}. ` +
        'It holds the page until it is answered: answer it with browser.dialog (accept or dismiss).',
    )
  }

  /** Synthetic input, bracketed so the manager's human-epoch does not count it. */
  async function input(s: Session, method: string, params: Record<string, unknown>): Promise<void> {
    stopIfAbandoned()
    manager.noteAgentInput(s.tabId, 1)
    try {
      await s.dbg.sendCommand(method, params)
    } finally {
      manager.noteAgentInput(s.tabId, -1)
    }
  }

  /** Scrolls the target into view and returns its viewport-centre point. */
  async function locate(s: Session, target: Target): Promise<{ x: number; y: number } | BrowserControlError> {
    if (!target.ref && !target.selector) return fail('invalid', 'Give a snapshot ref (e.g. "e12") or a CSS selector.')
    const { value, exception } = await evaluateRaw(
      s,
      `(() => {
        const el = ${targetExpression(target)};
        if (!el) return { missing: true };
        el.scrollIntoView({ block: 'center', inline: 'center', behavior: 'instant' });
        const r = el.getBoundingClientRect();
        const cs = getComputedStyle(el);
        if (cs.visibility === 'hidden' || cs.display === 'none' || (r.width === 0 && r.height === 0)) return { hidden: true };
        return { x: r.left + r.width / 2, y: r.top + r.height / 2, vw: innerWidth, vh: innerHeight };
      })()`,
      false,
    )
    if (exception) return fail('cdp', exception)
    const found = value as { missing?: boolean; hidden?: boolean; x?: number; y?: number; vw?: number; vh?: number }
    if (found.missing) {
      return fail(
        'not_found',
        target.ref
          ? `Ref "${target.ref}" is not in the last snapshot; take a new one.`
          : `No element matches "${target.selector}".`,
      )
    }
    if (found.hidden || typeof found.x !== 'number' || typeof found.y !== 'number')
      return fail('not_visible', 'The element is not visible.')
    noteViewport(s, found.vw, found.vh)
    return { x: found.x, y: found.y }
  }

  function noteViewport(s: Session, width: unknown, height: unknown): void {
    if (typeof width === 'number' && typeof height === 'number' && width > 0 && height > 0)
      s.viewport = { width, height }
  }

  async function mouse(
    s: Session,
    type: string,
    x: number,
    y: number,
    extra: Record<string, unknown> = {},
  ): Promise<void> {
    stopIfAbandoned()
    // The overlay hears where the pointer is going BEFORE the page does, so the
    // cursor is already there when the click lands.
    const kind =
      type === 'mousePressed' ? 'click' : type === 'mouseWheel' ? 'wheel' : type === 'mouseMoved' ? 'move' : null
    if (kind) manager.notePointer({ tabId: s.tabId, x, y, kind, ...(s.viewport ? { viewport: s.viewport } : {}) })
    await input(s, 'Input.dispatchMouseEvent', { type, x, y, button: 'left', clickCount: 1, ...extra })
  }

  return {
    async snapshot(tabId: string): Promise<SnapshotResult | BrowserControlError> {
      return act(tabId, 'snapshot', '', async (s) => {
        const { value, exception } = await evaluateRaw(s, SNAPSHOT_SCRIPT, false)
        if (exception) return fail('cdp', exception)
        const out = value as { text: string; nodeCount: number; truncated: boolean; url: string; title: string }
        let text = out.text
        let truncated = out.truncated
        if (text.length > SNAPSHOT_MAX_CHARS) {
          text = `${text.slice(0, SNAPSHOT_MAX_CHARS)}\n…`
          truncated = true
        }
        return { ok: true, text, nodeCount: out.nodeCount, truncated, url: out.url, title: out.title }
      })
    },

    async screenshot(tabId: string): Promise<ScreenshotResult | BrowserControlError> {
      return act(tabId, 'screenshot', '', async (s) => {
        const image = await withDeadline(
          s.wc.capturePage(),
          CAPTURE_TIMEOUT_MS,
          'The page did not render a capture in time.',
        )
        const size = image.getSize()
        if (size.width === 0 || size.height === 0) return fail('cdp', 'The page has no visible area to capture.')
        const scale = Math.min(1, SCREENSHOT_MAX_EDGE / Math.max(size.width, size.height))
        const resized =
          scale < 1
            ? image.resize({ width: Math.round(size.width * scale), height: Math.round(size.height * scale) })
            : image
        const final = resized.getSize()
        return {
          ok: true,
          data: resized.toJPEG(SCREENSHOT_JPEG_QUALITY).toString('base64'),
          mimeType: 'image/jpeg',
          width: final.width,
          height: final.height,
        }
      })
    },

    async click(
      tabId: string,
      target: Target,
      options: { button?: 'left' | 'right'; double?: boolean } = {},
    ): Promise<ActionResult | BrowserControlError> {
      return act(
        tabId,
        'click',
        describeTarget(target) + (options.double ? ' double' : '') + (options.button === 'right' ? ' right' : ''),
        async (s, checkpoint) => {
          const point = await locate(s, target)
          if ('ok' in point) return point
          const interrupted = checkpoint()
          if (interrupted) return interrupted
          const button = options.button ?? 'left'
          const clicks = options.double ? 2 : 1
          await mouse(s, 'mouseMoved', point.x, point.y, { button: 'none' })
          for (let i = 1; i <= clicks; i += 1) {
            await mouse(s, 'mousePressed', point.x, point.y, { button, clickCount: i })
            await mouse(s, 'mouseReleased', point.x, point.y, { button, clickCount: i })
          }
          return { ok: true }
        },
      )
    },

    async hover(tabId: string, target: Target): Promise<ActionResult | BrowserControlError> {
      return act(tabId, 'hover', describeTarget(target), async (s, checkpoint) => {
        const point = await locate(s, target)
        if ('ok' in point) return point
        const interrupted = checkpoint()
        if (interrupted) return interrupted
        await mouse(s, 'mouseMoved', point.x, point.y, { button: 'none' })
        return { ok: true }
      })
    },

    async type(
      tabId: string,
      target: Target | null,
      text: string,
      options: { clear?: boolean; submit?: boolean } = {},
    ): Promise<ActionResult | BrowserControlError> {
      return act(
        tabId,
        'type',
        `${target ? describeTarget(target) + ' ' : ''}${text.length} chars${options.clear ? ' clear' : ''}${options.submit ? ' submit' : ''}`,
        async (s, checkpoint) => {
          let point: { x: number; y: number } | null = null
          if (target) {
            const located = await locate(s, target)
            if ('ok' in located) return located
            point = located
          }
          // Nothing has changed on the page yet: this is the last moment an
          // interruption still means "abandoned" rather than "half done".
          const interrupted = checkpoint()
          if (interrupted) return interrupted
          if (point) {
            await mouse(s, 'mouseMoved', point.x, point.y, { button: 'none' })
            await mouse(s, 'mousePressed', point.x, point.y)
            await mouse(s, 'mouseReleased', point.x, point.y)
            if (options.clear) {
              const { exception } = await evaluateRaw(
                s,
                `(() => { const el = document.activeElement; if (el && ('value' in el)) { el.select && el.select(); } })()`,
                false,
              )
              if (exception) return fail('cdp', exception)
              await input(s, 'Input.dispatchKeyEvent', {
                type: 'keyDown',
                key: 'Backspace',
                code: 'Backspace',
                windowsVirtualKeyCode: 8,
              })
              await input(s, 'Input.dispatchKeyEvent', {
                type: 'keyUp',
                key: 'Backspace',
                code: 'Backspace',
                windowsVirtualKeyCode: 8,
              })
            }
          }
          // insertText is what an IME commit does: the page's input events fire,
          // React's controlled inputs update, and there is no per-character race.
          if (text) await input(s, 'Input.insertText', { text })
          if (options.submit) {
            const enter = KEY_TABLE.Enter
            await input(s, 'Input.dispatchKeyEvent', {
              type: 'keyDown',
              key: enter.key,
              code: enter.code,
              windowsVirtualKeyCode: enter.keyCode,
              text: '\r',
            })
            await input(s, 'Input.dispatchKeyEvent', {
              type: 'keyUp',
              key: enter.key,
              code: enter.code,
              windowsVirtualKeyCode: enter.keyCode,
            })
          }
          return { ok: true }
        },
      )
    },

    async press(tabId: string, chord: string): Promise<ActionResult | BrowserControlError> {
      const parsed = parseKeyChord(chord)
      if (!parsed)
        return fail(
          'invalid',
          `"${chord}" is not a key I can press. Use names like Enter, Tab, Escape, ArrowDown, Shift+Tab, Meta+a.`,
        )
      return act(tabId, 'press', chord, async (s, checkpoint) => {
        const interrupted = checkpoint()
        if (interrupted) return interrupted
        const base = {
          key: parsed.key,
          code: parsed.code,
          windowsVirtualKeyCode: parsed.keyCode,
          modifiers: parsed.modifiers,
        }
        const printable = parsed.key.length === 1 && !(parsed.modifiers & ~8)
        await input(s, 'Input.dispatchKeyEvent', {
          type: printable ? 'keyDown' : 'rawKeyDown',
          ...base,
          ...(printable ? { text: parsed.key } : parsed.key === 'Enter' ? { text: '\r' } : {}),
        })
        await input(s, 'Input.dispatchKeyEvent', { type: 'keyUp', ...base })
        return { ok: true }
      })
    },

    async scroll(
      tabId: string,
      target: Target | null,
      deltaX: number,
      deltaY: number,
    ): Promise<ActionResult | BrowserControlError> {
      return act(
        tabId,
        'scroll',
        `${target && (target.ref || target.selector) ? describeTarget(target) + ' ' : ''}dx=${deltaX} dy=${deltaY}`,
        async (s, checkpoint) => {
          let point: { x: number; y: number }
          if (target && (target.ref || target.selector)) {
            const located = await locate(s, target)
            if ('ok' in located) return located
            point = located
          } else {
            const { value } = await evaluateRaw(
              s,
              '({ x: innerWidth / 2, y: innerHeight / 2, vw: innerWidth, vh: innerHeight })',
              false,
            )
            const centre = value as { x: number; y: number; vw?: number; vh?: number } | null
            if (centre) noteViewport(s, centre.vw, centre.vh)
            point = centre ? { x: centre.x, y: centre.y } : { x: 100, y: 100 }
          }
          const interrupted = checkpoint()
          if (interrupted) return interrupted
          await mouse(s, 'mouseWheel', point.x, point.y, { button: 'none', deltaX, deltaY })
          return { ok: true }
        },
      )
    },

    async evaluate(tabId: string, expression: string): Promise<EvaluateResult | BrowserControlError> {
      return act(tabId, 'evaluate', expression, async (s, checkpoint) => {
        const interrupted = checkpoint()
        if (interrupted) return interrupted
        let evaluation: { value: unknown; exception: string | null }
        try {
          evaluation = await evaluateRaw(s, expression, true)
        } catch (error) {
          return fail(
            error instanceof DeadlineError ? 'timeout' : 'cdp',
            error instanceof Error ? error.message : String(error),
          )
        }
        const { value, exception } = evaluation
        if (exception) return fail('cdp', exception)
        // A long expression may have run while the person took the page back;
        // the value is theirs to see, but the tool reports the takeover.
        const tookOver = checkpoint()
        if (tookOver) return tookOver
        let serialised: string
        try {
          serialised = JSON.stringify(value) ?? 'undefined'
        } catch {
          serialised = String(value)
        }
        if (serialised.length > EVALUATE_MAX_CHARS)
          return { ok: true, value: `${serialised.slice(0, EVALUATE_MAX_CHARS)}…`, truncated: true }
        return { ok: true, value, truncated: false }
      })
    },

    /** Waits for text or a selector to appear (or, with `gone`, disappear). */
    async waitFor(
      tabId: string,
      condition: { text?: string; selector?: string; gone?: boolean; timeoutMs?: number },
    ): Promise<ActionResult | BrowserControlError> {
      if (!condition.text && !condition.selector) return fail('invalid', 'Give `text` or `selector` to wait for.')
      const timeoutMs = clampWait(condition.timeoutMs)
      return act(
        tabId,
        'wait_for',
        condition.selector ? `selector ${condition.selector}` : `text ${condition.text ?? ''}`,
        async (s, checkpoint) => {
          const probe = condition.selector
            ? `!!document.querySelector(${JSON.stringify(condition.selector)})`
            : `(document.body ? document.body.innerText : '').includes(${JSON.stringify(condition.text)})`
          const deadline = Date.now() + timeoutMs
          for (;;) {
            const { value, exception } = await evaluateRaw(s, probe, false)
            if (exception) return fail('cdp', exception)
            const present = value === true
            if (condition.gone ? !present : present) return { ok: true }
            const interrupted = checkpoint()
            if (interrupted) return interrupted
            if (Date.now() >= deadline) {
              const what = condition.selector
                ? `an element matching "${condition.selector}"`
                : `the text "${condition.text}"`
              return fail('timeout', `Waited ${timeoutMs}ms for ${what} to ${condition.gone ? 'disappear' : 'appear'}.`)
            }
            await new Promise((resolve) => setTimeout(resolve, WAIT_POLL_MS))
          }
        },
      )
    },

    /** Answer the dialog the page has open: OK (with a prompt's text) or Cancel. */
    async dialog(
      tabId: string,
      answer: { accept: boolean; promptText?: string },
    ): Promise<DialogResult | BrowserControlError> {
      const s = await session(tabId)
      if ('ok' in s) return s
      const open = s.dialog
      if (!open) return fail('no_dialog', 'No dialog is open on this tab.')
      try {
        await withDeadline(
          s.dbg.sendCommand('Page.handleJavaScriptDialog', {
            accept: answer.accept,
            ...(answer.promptText !== undefined ? { promptText: answer.promptText } : {}),
          }),
          CAPTURE_TIMEOUT_MS,
          'The page did not take the answer in time.',
        )
      } catch (error) {
        return fail(
          error instanceof DeadlineError ? 'timeout' : 'cdp',
          error instanceof Error ? error.message : String(error),
        )
      }
      s.dialog = null
      pushBounded(s.actions, ACTION_HISTORY_MAX, {
        id: nextActionId(),
        action: 'dialog',
        args: answer.accept ? 'accept' : 'dismiss',
        status: 'succeeded',
        startedAt: new Date().toISOString(),
        completedAt: new Date().toISOString(),
      })
      manager.noteAgentActivity(tabId)
      return { ok: true, answered: open, accepted: answer.accept }
    },

    /** Buffered console output since the last navigation (or since `clear`). */
    async console(
      tabId: string,
      options: { clear?: boolean; level?: ConsoleEntry['level'] } = {},
    ): Promise<{ ok: true; entries: ConsoleEntry[] } | BrowserControlError> {
      const s = await session(tabId)
      if ('ok' in s) return s
      const entries = options.level ? s.console.filter((entry) => entry.level === options.level) : [...s.console]
      if (options.clear) s.console.length = 0
      return { ok: true, entries }
    },

    async network(
      tabId: string,
      options: { clear?: boolean; failedOnly?: boolean } = {},
    ): Promise<{ ok: true; entries: NetworkEntry[] } | BrowserControlError> {
      const s = await session(tabId)
      if ('ok' in s) return s
      const entries = options.failedOnly
        ? s.network.filter((entry) => entry.outcome === 'failed' || (entry.status !== null && entry.status >= 400))
        : [...s.network]
      if (options.clear) s.network.length = 0
      return { ok: true, entries }
    },

    /** A tab's history, newest last, without attaching to it; empty for a tab this layer never touched. */
    actionsOf(tabId: string): ActionEntry[] {
      return sessions.get(tabId)?.actions.map((entry) => ({ ...entry })) ?? []
    },

    /** Forget a tab's session (the manager calls this when the tab is unregistered). */
    forget(tabId: string): void {
      const s = sessions.get(tabId)
      if (!s) return
      s.dispose()
      sessions.delete(tabId)
    },

    disposeAll(): void {
      for (const s of sessions.values()) s.dispose()
      sessions.clear()
    },
  }
}

export type BrowserControl = ReturnType<typeof createBrowserControl>

class DeadlineError extends Error {}

/** One `act` call. Abandoned when a dialog ended it while its work was still in flight. */
type ActToken = { abandoned: boolean }

// The token of the act whose work is running, carried through its awaits so
// the page calls it makes can tell they belong to an action already reported.
const acting = new AsyncLocalStorage<ActToken>()

/** Thrown into an abandoned action's own chain; nobody is waiting on it any more. */
class AbandonedError extends Error {}

function stopIfAbandoned(): void {
  if (acting.getStore()?.abandoned) throw new AbandonedError('The action was abandoned when the page opened a dialog.')
}

function withDeadline<T>(promise: Promise<T>, ms: number, message: string): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(new DeadlineError(message)), ms)
    promise.then(
      (value) => {
        clearTimeout(timer)
        resolve(value)
      },
      (error) => {
        clearTimeout(timer)
        reject(error)
      },
    )
  })
}

function describeTarget(target: Target): string {
  return target.ref ? `ref ${target.ref}` : `selector ${target.selector ?? ''}`
}

function pushBounded<T>(list: T[], max: number, item: T): void {
  list.push(item)
  if (list.length > max) list.splice(0, list.length - max)
}

function describeRemoteObject(obj: Record<string, unknown>): string {
  if ('value' in obj && obj.value !== undefined) {
    const value = obj.value
    return typeof value === 'string' ? value : (JSON.stringify(value) ?? String(value))
  }
  if (typeof obj.description === 'string') return obj.description
  if (obj.type === 'undefined') return 'undefined'
  return String(obj.type ?? '')
}
