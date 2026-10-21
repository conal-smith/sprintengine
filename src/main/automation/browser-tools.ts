import type { BrowserTabState } from '../../shared/browser'
import { normalizeBrowserUrlInput } from '../../shared/browser'
import {
  BROWSER_DEVICE_PRESETS,
  normalizeBrowserViewport,
  presetViewport,
  type BrowserViewport,
} from '../../shared/browser-devices'
import type { McpConnectionContext, McpToolRegistration, McpToolResult } from '../../shared/modules/mcp-tools'
import type { ActionEntry, BrowserControl, BrowserControlError } from '../browser/browser-control'
import type { BrowserRecorder, FinishedRecording } from '../browser/browser-recorder'

// The `browser.*` gateway tools (browser-pane epic, child 6): an agent's view
// of the workspace pane's browser tabs — the SAME tabs the person sees, not a
// headless copy. Every action lands on a real guest with the person watching,
// which is the whole point: the agent fixes the page, the person sees it fix.
//
// Targeting: a tool acts on `tabId` when given, else on the tab the person has
// active in the calling agent's workspace (main is told by the renderer via
// `browser:note-active`). The workspace is the connection's own, as stamped by
// the gateway, or an explicit `workspaceId` for connections without one.

export const BROWSER_MUTATION_TOOL_NAMES: readonly string[] = [
  'browser.open',
  'browser.navigate',
  'browser.click',
  'browser.hover',
  'browser.type',
  'browser.press',
  'browser.scroll',
  'browser.evaluate',
  'browser.resize',
  'browser.set_appearance',
  // Answering a page's dialog presses OK or Cancel on the person's page.
  'browser.dialog',
  // Recording captures the person's page and writes a file into their
  // workspace: audited, and on the operate scope for a paired device.
  'browser.record_start',
  'browser.record_stop',
]

const OPEN_WAIT_MS = 8_000
const LOAD_WAIT_MS = 15_000
const POLL_MS = 100
// A result is one line on the gateway socket (MAX_LINE_BYTES 1MiB) and is
// serialised twice (text block + structuredContent); the entry lists are
// trimmed from the oldest until the JSON fits well inside that.
const MAX_ENTRIES_JSON_BYTES = 200_000

export type BrowserToolsManager = {
  listTabs(workspaceId: string): BrowserTabState[]
  state(tabId: string): BrowserTabState | null
  activeTab(workspaceId: string): { tabId: string } | null
  /** The tab this agent drives, sticky until the tab closes. */
  assignedTab(workspaceId: string, agentId: string): { tabId: string } | null
  assignTab(workspaceId: string, agentId: string, tabId: string): void
  requestOpen(workspaceId: string, url: string | null, tabId?: string | null): void
  requestViewport(tabId: string, viewport: BrowserViewport): void
  navigate(tabId: string, url: string): boolean
  back(tabId: string): boolean
  forward(tabId: string): boolean
  reload(tabId: string, ignoreCache?: boolean): boolean
  setColorScheme(tabId: string, scheme: 'system' | 'light' | 'dark'): boolean
  noteAgentActivity(tabId: string): void
}

export type BrowserToolsDeps = {
  manager: BrowserToolsManager
  control: Pick<
    BrowserControl,
    | 'snapshot'
    | 'screenshot'
    | 'click'
    | 'hover'
    | 'type'
    | 'press'
    | 'scroll'
    | 'evaluate'
    | 'waitFor'
    | 'console'
    | 'network'
    | 'actionsOf'
    | 'dialog'
  >
  /** Recording a tab to video (`browser.record_start` / `record_stop`). */
  recorder: Pick<BrowserRecorder, 'start' | 'stop' | 'lastOutcome'>
  /** Whether a workspace id names an open workspace. */
  hasWorkspace: (workspaceId: string) => boolean
  now?: () => number
  sleep?: (ms: number) => Promise<void>
}

function success(structured: Record<string, unknown>, image?: { data: string; mimeType: string }): McpToolResult {
  return {
    content: [
      { type: 'text', text: JSON.stringify(structured, null, 2) },
      ...(image ? [{ type: 'image' as const, data: image.data, mimeType: image.mimeType }] : []),
    ],
    structuredContent: structured,
  }
}

function failure(code: string, message: string): McpToolResult {
  const structured = { error: { code, message } }
  return {
    content: [{ type: 'text', text: JSON.stringify(structured, null, 2) }],
    structuredContent: structured,
    isError: true,
  }
}

function controlFailure(error: BrowserControlError): McpToolResult {
  return failure(error.code, error.message)
}

/** The newest entries whose JSON fits the budget; `dropped` says how many older ones did not. */
export function boundedEntries<T>(entries: T[], maxBytes = MAX_ENTRIES_JSON_BYTES): { entries: T[]; dropped: number } {
  let kept = entries
  while (kept.length > 0 && Buffer.byteLength(JSON.stringify(kept), 'utf8') > maxBytes) {
    kept = kept.slice(Math.max(1, Math.floor(kept.length / 4)))
  }
  return { entries: kept, dropped: entries.length - kept.length }
}

function str(args: Record<string, unknown>, key: string): string | null {
  const value = args[key]
  return typeof value === 'string' && value.trim() ? value : null
}

function bool(args: Record<string, unknown>, key: string): boolean {
  return args[key] === true
}

function num(args: Record<string, unknown>, key: string): number | null {
  const value = args[key]
  return typeof value === 'number' && Number.isFinite(value) ? value : null
}

function target(args: Record<string, unknown>): { ref?: string; selector?: string } | null {
  const ref = str(args, 'ref')
  const selector = str(args, 'selector')
  if (!ref && !selector) return null
  return ref ? { ref } : { selector: selector! }
}

const TARGET_PROPERTIES = {
  ref: { type: 'string', description: 'A ref from the last browser.snapshot, e.g. "e12". Preferred over selector.' },
  selector: { type: 'string', description: 'CSS selector, when no snapshot ref fits.' },
  tabId: { type: 'string', description: 'The browser tab to act on; the active tab of your workspace when omitted.' },
  workspaceId: { type: 'string', description: 'Only for connections not bound to a workspace.' },
} as const

/** What a tool result says about a tab: the fields an agent acts on, nothing internal. */
function describeTab(
  tab: BrowserTabState,
  active: boolean,
  lastAction: ActionEntry | null = null,
): Record<string, unknown> {
  return {
    tabId: tab.tabId,
    url: tab.url,
    title: tab.title,
    loading: tab.loading,
    active,
    // Who holds the page right now: `human` means wait, `agent` means another
    // action of yours (or another agent's) is on it.
    controller: tab.controller,
    error: tab.error ? { code: tab.error.code, description: tab.error.description } : null,
    zoomFactor: tab.zoomFactor,
    colorScheme: tab.colorScheme,
    ...(tab.recording
      ? {
          recording: {
            recordingId: tab.recording.recordingId,
            startedAt: new Date(tab.recording.startedAt).toISOString(),
            maxDurationMs: tab.recording.maxDurationMs,
          },
        }
      : {}),
    ...(lastAction ? { lastAction } : {}),
  }
}

/** Who may stop a recording besides the person: the agent, device or connection that started it. */
function recordingOwner(context?: McpConnectionContext): string {
  const metadata = context?.metadata
  if (metadata?.agentId) return `agent:${metadata.workspaceId ?? ''}:${metadata.agentId}`
  if (metadata?.deviceId) return `device:${metadata.deviceId}`
  return `connection:${metadata?.kind ?? 'unknown'}`
}

/** A finished recording as the agent reads it. */
function describeRecording(recording: FinishedRecording): Record<string, unknown> {
  return {
    recordingId: recording.recordingId,
    tabId: recording.tabId,
    ...(recording.path ? { path: recording.path } : {}),
    mimeType: recording.mimeType,
    bytes: recording.bytes,
    durationMs: recording.durationMs,
    width: recording.width,
    height: recording.height,
    cursor: recording.cursor,
    stopReason: recording.stopReason,
    ...(recording.error ? { error: recording.error } : {}),
    startedAt: recording.startedAt,
    endedAt: recording.endedAt,
  }
}

const SNAPSHOT_ACTIONS = 10

export function createBrowserTools(deps: BrowserToolsDeps): McpToolRegistration[] {
  const { manager, control, recorder } = deps
  const now = deps.now ?? Date.now
  const sleep = deps.sleep ?? ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)))

  function resolveWorkspace(args: Record<string, unknown>, context?: McpConnectionContext): string | McpToolResult {
    const bound = context?.metadata.workspaceId
    const explicit = str(args, 'workspaceId')
    if (bound && explicit && explicit !== bound) {
      return failure('forbidden', 'This connection is bound to its own workspace; drop `workspaceId`.')
    }
    const workspaceId = bound ?? explicit
    if (!workspaceId) return failure('no_workspace', 'This connection is not bound to a workspace; pass `workspaceId`.')
    if (!deps.hasWorkspace(workspaceId))
      return failure('unknown_workspace', `Workspace "${workspaceId}" is not known to the running app.`)
    return workspaceId
  }

  /**
   * The tab a tool acts on: named, or this agent's own.
   *
   * The order matters. An agent's own assignment wins over the person's active
   * tab, so two agents in one workspace do not drive the same page — and
   * neither steals the tab the person is reading. Only an agent holding
   * nothing falls back to the active tab, and doing so CLAIMS it, so the rest
   * of that interaction stays on the page it started on.
   *
   * A connection with no `agentId` (an external local client) keeps the old
   * behaviour exactly: the person's active tab, claimed by nobody.
   */
  function resolveTab(
    args: Record<string, unknown>,
    context?: McpConnectionContext,
  ): { tabId: string; workspaceId: string } | McpToolResult {
    const workspaceId = resolveWorkspace(args, context)
    if (typeof workspaceId !== 'string') return workspaceId
    const agentId = context?.metadata.agentId
    const named = str(args, 'tabId')
    if (named) {
      const owned = manager.listTabs(workspaceId).some((tab) => tab.tabId === named)
      if (!owned)
        return failure(
          'no_tab',
          `Browser tab "${named}" is not open in this workspace. browser.status lists the open tabs.`,
        )
      // Naming a tab is a deliberate move to it, and the agent stays there.
      if (agentId) manager.assignTab(workspaceId, agentId, named)
      return { tabId: named, workspaceId }
    }
    const held = agentId ? manager.assignedTab(workspaceId, agentId) : null
    if (held) return { tabId: held.tabId, workspaceId }
    const active = manager.activeTab(workspaceId)
    if (!active) {
      return failure(
        'no_tab',
        'No browser tab is open in this workspace. browser.open starts one (the workspace must be showing in a window).',
      )
    }
    if (agentId) manager.assignTab(workspaceId, agentId, active.tabId)
    return { tabId: active.tabId, workspaceId }
  }

  async function waitUntil(timeoutMs: number, probe: () => boolean): Promise<boolean> {
    const deadline = now() + timeoutMs
    for (;;) {
      if (probe()) return true
      if (now() >= deadline) return false
      await sleep(POLL_MS)
    }
  }

  /** Waits for a navigation the manager just started to settle (loading → false). */
  async function settle(tabId: string, workspaceId: string): Promise<McpToolResult> {
    // The guest flips `loading` on within a tick; give it a moment so a fast
    // page that has already finished is not mistaken for one that never started.
    await sleep(POLL_MS)
    const loaded = await waitUntil(LOAD_WAIT_MS, () => manager.state(tabId)?.loading === false)
    const state = manager.state(tabId)
    if (!state) return failure('no_tab', 'The browser tab closed while loading.')
    if (state.error) return failure('load_failed', `${state.error.description} (${state.error.url})`)
    if (!loaded) return failure('timeout', `The page was still loading after ${LOAD_WAIT_MS}ms.`)
    // `active` is what the person is looking at, not what the tool touched.
    return success({ tab: describeTab(state, manager.activeTab(workspaceId)?.tabId === tabId) })
  }

  const tools: McpToolRegistration[] = [
    {
      name: 'browser.status',
      description:
        'List the browser tabs open in the workspace pane, with the one the person is looking at marked active. Read-only.',
      inputSchema: {
        type: 'object',
        properties: { workspaceId: TARGET_PROPERTIES.workspaceId },
        additionalProperties: false,
      },
      handler: async (args, context) => {
        const workspaceId = resolveWorkspace(args, context)
        if (typeof workspaceId !== 'string') return workspaceId
        const active = manager.activeTab(workspaceId)?.tabId ?? null
        const tabs = manager.listTabs(workspaceId).map((tab) => {
          const history = control.actionsOf(tab.tabId)
          return describeTab(tab, tab.tabId === active, history[history.length - 1] ?? null)
        })
        return success({ tabs, activeTabId: active })
      },
    },
    {
      name: 'browser.open',
      description:
        "Open a URL in the workspace pane's browser: navigates the active tab, or opens a new tab when the pane has none (or `newTab` is set). Waits for the page to load. Use localhost URLs for the dev server this workspace runs.",
      inputSchema: {
        type: 'object',
        properties: {
          url: { type: 'string', description: 'http(s) URL; "localhost:5173" is accepted.' },
          newTab: { type: 'boolean', description: 'Open a new tab even when one is active.' },
          workspaceId: TARGET_PROPERTIES.workspaceId,
        },
        required: ['url'],
        additionalProperties: false,
      },
      handler: async (args, context) => {
        const workspaceId = resolveWorkspace(args, context)
        if (typeof workspaceId !== 'string') return workspaceId
        const url = normalizeBrowserUrlInput(str(args, 'url') ?? '')
        if (!url) return failure('invalid_url', 'Only http(s) URLs can be opened in the pane.')
        const agentId = context?.metadata.agentId
        // Reuse this agent's OWN tab before the person's active one. Without
        // this, a second agent's `browser.open` navigated whatever the person
        // was reading, and two agents shared one page.
        const held = agentId ? manager.assignedTab(workspaceId, agentId) : null
        const reusable = held ?? manager.activeTab(workspaceId)
        if (reusable && !bool(args, 'newTab')) {
          if (!manager.navigate(reusable.tabId, url))
            return failure('no_tab', 'The active browser tab could not navigate.')
          manager.noteAgentActivity(reusable.tabId)
          if (agentId) manager.assignTab(workspaceId, agentId, reusable.tabId)
          // The person should see what the agent opened: a collapsed pane is
          // revealed and the tab selected, in whichever window shows the workspace.
          manager.requestOpen(workspaceId, null, reusable.tabId)
          return settle(reusable.tabId, workspaceId)
        }
        const before = new Set(manager.listTabs(workspaceId).map((tab) => tab.tabId))
        manager.requestOpen(workspaceId, url)
        // The renderer creates the tab and attaches the guest; it registers with
        // the manager on dom-ready. Until then there is nothing to wait on.
        const appeared = await waitUntil(OPEN_WAIT_MS, () =>
          manager.listTabs(workspaceId).some((tab) => !before.has(tab.tabId)),
        )
        if (!appeared) {
          return failure(
            'pane_unavailable',
            'No window is showing this workspace, so no browser tab could open. Switch to it in the app first.',
          )
        }
        const tab = manager.listTabs(workspaceId).find((candidate) => !before.has(candidate.tabId))!
        manager.noteAgentActivity(tab.tabId)
        // The tab this agent just caused to exist is the tab it now drives.
        if (agentId) manager.assignTab(workspaceId, agentId, tab.tabId)
        return settle(tab.tabId, workspaceId)
      },
    },
    {
      name: 'browser.navigate',
      description:
        'Navigate a browser tab: to a URL, or back / forward / reload / hard reload. Waits for the load to finish.',
      inputSchema: {
        type: 'object',
        properties: {
          url: { type: 'string', description: 'Where to go. Omit when using `action`.' },
          action: { type: 'string', enum: ['back', 'forward', 'reload', 'hard_reload'] },
          tabId: TARGET_PROPERTIES.tabId,
          workspaceId: TARGET_PROPERTIES.workspaceId,
        },
        additionalProperties: false,
      },
      handler: async (args, context) => {
        const resolved = resolveTab(args, context)
        if ('content' in resolved) return resolved
        const action = str(args, 'action')
        const rawUrl = str(args, 'url')
        let ok: boolean
        if (rawUrl) {
          const url = normalizeBrowserUrlInput(rawUrl)
          if (!url) return failure('invalid_url', 'Only http(s) URLs can be opened in the pane.')
          ok = manager.navigate(resolved.tabId, url)
        } else if (action === 'back') ok = manager.back(resolved.tabId)
        else if (action === 'forward') ok = manager.forward(resolved.tabId)
        else if (action === 'reload') ok = manager.reload(resolved.tabId, false)
        else if (action === 'hard_reload') ok = manager.reload(resolved.tabId, true)
        else return failure('invalid', 'Give `url` or one of the actions.')
        if (!ok)
          return failure(
            'unavailable',
            action === 'back' || action === 'forward' ? `Nothing to go ${action} to.` : 'The tab could not navigate.',
          )
        manager.noteAgentActivity(resolved.tabId)
        return settle(resolved.tabId, resolved.workspaceId)
      },
    },
    {
      name: 'browser.snapshot',
      description:
        'The page as an outline of roles and names with [ref=eN] handles for browser.click / browser.type. Cheaper and more precise than a screenshot; take one after every navigation or change. Read-only.',
      inputSchema: {
        type: 'object',
        properties: {
          includeScreenshot: { type: 'boolean', description: 'Also attach a JPEG of the viewport.' },
          tabId: TARGET_PROPERTIES.tabId,
          workspaceId: TARGET_PROPERTIES.workspaceId,
        },
        additionalProperties: false,
      },
      handler: async (args, context) => {
        const resolved = resolveTab(args, context)
        if ('content' in resolved) return resolved
        const snap = await control.snapshot(resolved.tabId)
        if (!snap.ok) return controlFailure(snap)
        // What happened to this tab lately — yours and the person's — so a model
        // that lost the thread (compaction, a second agent) sees it before acting.
        const actions = control.actionsOf(resolved.tabId).slice(-SNAPSHOT_ACTIONS)
        const structured = {
          url: snap.url,
          title: snap.title,
          nodeCount: snap.nodeCount,
          truncated: snap.truncated,
          actions,
          snapshot: snap.text,
        }
        if (!bool(args, 'includeScreenshot')) return success(structured)
        const shot = await control.screenshot(resolved.tabId)
        if (!shot.ok) return success({ ...structured, screenshot: { error: shot.message } })
        return success(
          { ...structured, screenshot: { width: shot.width, height: shot.height } },
          { data: shot.data, mimeType: shot.mimeType },
        )
      },
    },
    {
      name: 'browser.screenshot',
      description: "A JPEG of the tab's viewport as the person sees it (device frame scale excluded). Read-only.",
      inputSchema: {
        type: 'object',
        properties: { tabId: TARGET_PROPERTIES.tabId, workspaceId: TARGET_PROPERTIES.workspaceId },
        additionalProperties: false,
      },
      handler: async (args, context) => {
        const resolved = resolveTab(args, context)
        if ('content' in resolved) return resolved
        const shot = await control.screenshot(resolved.tabId)
        if (!shot.ok) return controlFailure(shot)
        return success({ width: shot.width, height: shot.height }, { data: shot.data, mimeType: shot.mimeType })
      },
    },
    {
      name: 'browser.click',
      description: 'Click an element by snapshot ref or CSS selector. Scrolls it into view first.',
      inputSchema: {
        type: 'object',
        properties: {
          ...TARGET_PROPERTIES,
          button: { type: 'string', enum: ['left', 'right'] },
          double: { type: 'boolean' },
        },
        additionalProperties: false,
      },
      handler: async (args, context) => {
        const resolved = resolveTab(args, context)
        if ('content' in resolved) return resolved
        const where = target(args)
        if (!where) return failure('invalid', 'Give `ref` or `selector`.')
        const button = str(args, 'button')
        const result = await control.click(resolved.tabId, where, {
          button: button === 'right' ? 'right' : 'left',
          double: bool(args, 'double'),
        })
        return result.ok ? success({ clicked: where }) : controlFailure(result)
      },
    },
    {
      name: 'browser.hover',
      description: 'Move the pointer over an element (for hover states and tooltips).',
      inputSchema: { type: 'object', properties: { ...TARGET_PROPERTIES }, additionalProperties: false },
      handler: async (args, context) => {
        const resolved = resolveTab(args, context)
        if ('content' in resolved) return resolved
        const where = target(args)
        if (!where) return failure('invalid', 'Give `ref` or `selector`.')
        const result = await control.hover(resolved.tabId, where)
        return result.ok ? success({ hovered: where }) : controlFailure(result)
      },
    },
    {
      name: 'browser.type',
      description:
        'Type text. With `ref`/`selector` the element is clicked first; without, text goes to whatever has focus. `clear` empties the field first; `submit` presses Enter after.',
      inputSchema: {
        type: 'object',
        properties: {
          ...TARGET_PROPERTIES,
          text: { type: 'string' },
          clear: { type: 'boolean' },
          submit: { type: 'boolean' },
        },
        required: ['text'],
        additionalProperties: false,
      },
      handler: async (args, context) => {
        const resolved = resolveTab(args, context)
        if ('content' in resolved) return resolved
        const text = typeof args.text === 'string' ? args.text : null
        if (text === null) return failure('invalid', '`text` must be a string.')
        const result = await control.type(resolved.tabId, target(args), text, {
          clear: bool(args, 'clear'),
          submit: bool(args, 'submit'),
        })
        return result.ok ? success({ typed: text.length }) : controlFailure(result)
      },
    },
    {
      name: 'browser.press',
      description: 'Press a key or chord on the focused element: Enter, Tab, Escape, ArrowDown, Shift+Tab, Meta+a…',
      inputSchema: {
        type: 'object',
        properties: {
          key: { type: 'string' },
          tabId: TARGET_PROPERTIES.tabId,
          workspaceId: TARGET_PROPERTIES.workspaceId,
        },
        required: ['key'],
        additionalProperties: false,
      },
      handler: async (args, context) => {
        const resolved = resolveTab(args, context)
        if ('content' in resolved) return resolved
        const key = str(args, 'key')
        if (!key) return failure('invalid', '`key` is required.')
        const result = await control.press(resolved.tabId, key)
        return result.ok ? success({ pressed: key }) : controlFailure(result)
      },
    },
    {
      name: 'browser.scroll',
      description:
        'Scroll the page (or a scrollable element by ref/selector) by a pixel delta. Positive deltaY scrolls down.',
      inputSchema: {
        type: 'object',
        properties: {
          ...TARGET_PROPERTIES,
          deltaY: { type: 'number', description: 'Pixels; default 600.' },
          deltaX: { type: 'number' },
        },
        additionalProperties: false,
      },
      handler: async (args, context) => {
        const resolved = resolveTab(args, context)
        if ('content' in resolved) return resolved
        const deltaY = num(args, 'deltaY') ?? 600
        const deltaX = num(args, 'deltaX') ?? 0
        const result = await control.scroll(resolved.tabId, target(args), deltaX, deltaY)
        return result.ok ? success({ scrolled: { deltaX, deltaY } }) : controlFailure(result)
      },
    },
    {
      name: 'browser.evaluate',
      description:
        'Run a JavaScript expression in the page and return its JSON value (promises are awaited). For reading state the snapshot does not show; prefer the other tools for interaction.',
      inputSchema: {
        type: 'object',
        properties: {
          expression: { type: 'string' },
          tabId: TARGET_PROPERTIES.tabId,
          workspaceId: TARGET_PROPERTIES.workspaceId,
        },
        required: ['expression'],
        additionalProperties: false,
      },
      handler: async (args, context) => {
        const resolved = resolveTab(args, context)
        if ('content' in resolved) return resolved
        const expression = str(args, 'expression')
        if (!expression) return failure('invalid', '`expression` is required.')
        const result = await control.evaluate(resolved.tabId, expression)
        return result.ok ? success({ value: result.value, truncated: result.truncated }) : controlFailure(result)
      },
    },
    {
      name: 'browser.wait_for',
      description:
        'Wait until text or a CSS selector appears on the page (or disappears with `gone`). Up to 30s. Read-only.',
      inputSchema: {
        type: 'object',
        properties: {
          text: { type: 'string' },
          selector: { type: 'string' },
          gone: { type: 'boolean' },
          timeoutMs: { type: 'number' },
          tabId: TARGET_PROPERTIES.tabId,
          workspaceId: TARGET_PROPERTIES.workspaceId,
        },
        additionalProperties: false,
      },
      handler: async (args, context) => {
        const resolved = resolveTab(args, context)
        if ('content' in resolved) return resolved
        const result = await control.waitFor(resolved.tabId, {
          text: str(args, 'text') ?? undefined,
          selector: str(args, 'selector') ?? undefined,
          gone: bool(args, 'gone'),
          timeoutMs: num(args, 'timeoutMs') ?? undefined,
        })
        return result.ok ? success({ satisfied: true }) : controlFailure(result)
      },
    },
    {
      name: 'browser.console',
      description:
        'Console messages and uncaught errors since the page last loaded. `level` filters; `clear` empties the buffer after reading. Read-only.',
      inputSchema: {
        type: 'object',
        properties: {
          level: { type: 'string', enum: ['log', 'info', 'warn', 'error', 'debug'] },
          clear: { type: 'boolean' },
          tabId: TARGET_PROPERTIES.tabId,
          workspaceId: TARGET_PROPERTIES.workspaceId,
        },
        additionalProperties: false,
      },
      handler: async (args, context) => {
        const resolved = resolveTab(args, context)
        if ('content' in resolved) return resolved
        const level = str(args, 'level') as 'log' | 'info' | 'warn' | 'error' | 'debug' | null
        const result = await control.console(resolved.tabId, { clear: bool(args, 'clear'), level: level ?? undefined })
        if (!result.ok) return controlFailure(result)
        const bounded = boundedEntries(result.entries)
        return success({
          entries: bounded.entries,
          ...(bounded.dropped > 0 ? { olderEntriesDropped: bounded.dropped } : {}),
        })
      },
    },
    {
      name: 'browser.actions',
      description:
        'What happened to a browser tab lately: your actions with their outcome (succeeded / failed / interrupted), the files the page downloaded while you drove it (`download`, with the `path` each was saved to), and the moments the person took the page back. Newest last. Read-only.',
      inputSchema: {
        type: 'object',
        properties: { tabId: TARGET_PROPERTIES.tabId, workspaceId: TARGET_PROPERTIES.workspaceId },
        additionalProperties: false,
      },
      handler: async (args, context) => {
        const resolved = resolveTab(args, context)
        if ('content' in resolved) return resolved
        const bounded = boundedEntries(control.actionsOf(resolved.tabId))
        return success({
          actions: bounded.entries,
          ...(bounded.dropped > 0 ? { olderEntriesDropped: bounded.dropped } : {}),
        })
      },
    },
    {
      name: 'browser.network',
      description:
        'Requests the page made since it last loaded, with status and failures. `failedOnly` keeps errors and 4xx/5xx. Read-only.',
      inputSchema: {
        type: 'object',
        properties: {
          failedOnly: { type: 'boolean' },
          clear: { type: 'boolean' },
          tabId: TARGET_PROPERTIES.tabId,
          workspaceId: TARGET_PROPERTIES.workspaceId,
        },
        additionalProperties: false,
      },
      handler: async (args, context) => {
        const resolved = resolveTab(args, context)
        if ('content' in resolved) return resolved
        const result = await control.network(resolved.tabId, {
          clear: bool(args, 'clear'),
          failedOnly: bool(args, 'failedOnly'),
        })
        if (!result.ok) return controlFailure(result)
        const bounded = boundedEntries(result.entries)
        return success({
          entries: bounded.entries,
          ...(bounded.dropped > 0 ? { olderEntriesDropped: bounded.dropped } : {}),
        })
      },
    },
    {
      name: 'browser.resize',
      description:
        'Set the tab\'s device viewport: a preset name (e.g. "iPhone 12 Pro", "iPad Mini") or explicit width/height in CSS px. `responsive` or omitted dimensions turn the device frame off.',
      inputSchema: {
        type: 'object',
        properties: {
          preset: {
            type: 'string',
            description: `One of: ${BROWSER_DEVICE_PRESETS.map((p) => p.label).join(', ')}, responsive.`,
          },
          width: { type: 'number' },
          height: { type: 'number' },
          tabId: TARGET_PROPERTIES.tabId,
          workspaceId: TARGET_PROPERTIES.workspaceId,
        },
        additionalProperties: false,
      },
      handler: async (args, context) => {
        const resolved = resolveTab(args, context)
        if ('content' in resolved) return resolved
        const preset = str(args, 'preset')
        const width = num(args, 'width')
        const height = num(args, 'height')
        let viewport: BrowserViewport
        if (preset && preset.toLowerCase() === 'responsive') viewport = { mode: 'fill' }
        else if (preset) {
          const match = BROWSER_DEVICE_PRESETS.find(
            (p) => p.label.toLowerCase() === preset.toLowerCase() || p.id === preset,
          )
          if (!match)
            return failure(
              'invalid',
              `Unknown preset "${preset}". Known: ${BROWSER_DEVICE_PRESETS.map((p) => p.label).join(', ')}.`,
            )
          viewport = presetViewport(match.id)
        } else if (width !== null && height !== null) {
          viewport = normalizeBrowserViewport({ mode: 'freeform', width, height }) ?? { mode: 'fill' }
        } else viewport = { mode: 'fill' }
        manager.requestViewport(resolved.tabId, viewport)
        manager.noteAgentActivity(resolved.tabId)
        return success({ viewport })
      },
    },
    {
      name: 'browser.set_appearance',
      description: 'Emulate prefers-color-scheme for the page: light, dark, or system.',
      inputSchema: {
        type: 'object',
        properties: {
          scheme: { type: 'string', enum: ['system', 'light', 'dark'] },
          tabId: TARGET_PROPERTIES.tabId,
          workspaceId: TARGET_PROPERTIES.workspaceId,
        },
        required: ['scheme'],
        additionalProperties: false,
      },
      handler: async (args, context) => {
        const resolved = resolveTab(args, context)
        if ('content' in resolved) return resolved
        const scheme = str(args, 'scheme')
        if (scheme !== 'system' && scheme !== 'light' && scheme !== 'dark')
          return failure('invalid', '`scheme` must be system, light or dark.')
        if (!manager.setColorScheme(resolved.tabId, scheme)) return failure('no_tab', 'The tab is gone.')
        manager.noteAgentActivity(resolved.tabId)
        return success({ scheme })
      },
    },
    {
      name: 'browser.dialog',
      description:
        'Answer the JavaScript dialog (alert, confirm, prompt, or leave-page confirmation) a page has open. While one is open, the other browser tools on that tab answer `dialog_open` with its text. `accept` presses OK, with `text` as a prompt’s answer; `dismiss` presses Cancel.',
      inputSchema: {
        type: 'object',
        properties: {
          action: { type: 'string', enum: ['accept', 'dismiss'] },
          text: { type: 'string', description: 'A prompt’s answer, with `accept`.' },
          tabId: TARGET_PROPERTIES.tabId,
          workspaceId: TARGET_PROPERTIES.workspaceId,
        },
        required: ['action'],
        additionalProperties: false,
      },
      handler: async (args, context) => {
        const resolved = resolveTab(args, context)
        if ('content' in resolved) return resolved
        const action = str(args, 'action')
        if (action !== 'accept' && action !== 'dismiss')
          return failure('invalid', '`action` must be accept or dismiss.')
        const text = typeof args.text === 'string' ? args.text : undefined
        const result = await control.dialog(resolved.tabId, {
          accept: action === 'accept',
          ...(action === 'accept' && text !== undefined ? { promptText: text } : {}),
        })
        return result.ok ? success({ answered: result.answered, accepted: result.accepted }) : controlFailure(result)
      },
    },
    {
      name: 'browser.record_start',
      description:
        'Start recording the tab to a video (WebM) as the person sees it, with your cursor drawn in, until browser.record_stop or `maxSeconds`. ' +
        'The person is shown that the tab is being recorded and can stop it. The pane is brought forward: a tab that is hidden records no new frames. ' +
        "The video is saved in Studio's store for the project, in the person's home folder (~/.sprintengine/workspaces/<project>/browser/recordings/), not in the project or your worktree; browser.record_stop answers its absolute path.",
      inputSchema: {
        type: 'object',
        properties: {
          maxSeconds: { type: 'number', description: 'Stop by itself after this long. Default 60, at most 300.' },
          cursor: { type: 'boolean', description: 'Draw your cursor in the video. Default true.' },
          tabId: TARGET_PROPERTIES.tabId,
          workspaceId: TARGET_PROPERTIES.workspaceId,
        },
        additionalProperties: false,
      },
      handler: async (args, context) => {
        const resolved = resolveTab(args, context)
        if ('content' in resolved) return resolved
        const started = await recorder.start({
          tabId: resolved.tabId,
          workspaceId: resolved.workspaceId,
          owner: recordingOwner(context),
          maxSeconds: num(args, 'maxSeconds'),
          cursor: args.cursor !== false,
          // Before capture, so its first frame can come: a tab only paints
          // while it is on screen. And the person should see what is being
          // recorded. Not for a start that is refused.
          beforeCapture: () => manager.requestOpen(resolved.workspaceId, null, resolved.tabId),
        })
        if (!started.ok) return failure(started.code, started.message)
        const { recording } = started
        return success({
          recording: {
            recordingId: recording.recordingId,
            tabId: recording.tabId,
            startedAt: recording.startedAt,
            maxDurationMs: recording.maxDurationMs,
            ...(recording.path ? { path: recording.path } : {}),
          },
        })
      },
    },
    {
      name: 'browser.record_stop',
      description:
        'Stop recording the tab and save the video. Answers the file (`path`, absolute as your machine spells it: open it from there, it is not in the project), ' +
        'its length, size and why it stopped. A recording that already ended at its limit, or that the person stopped, is answered the same way.',
      inputSchema: {
        type: 'object',
        properties: { tabId: TARGET_PROPERTIES.tabId, workspaceId: TARGET_PROPERTIES.workspaceId },
        additionalProperties: false,
      },
      handler: async (args, context) => {
        const resolved = resolveTab(args, context)
        if ('content' in resolved) return resolved
        const owner = recordingOwner(context)
        const stopped = await recorder.stop({ tabId: resolved.tabId, owner, reason: 'stopped' })
        if (stopped.ok) return success({ recording: describeRecording(stopped) })
        if (stopped.code === 'not_recording') {
          // It already ended: at a limit, by the person, or with nothing saved.
          const ended = recorder.lastOutcome(resolved.tabId, owner)
          if (ended?.ok) return success({ recording: describeRecording(ended) })
          if (ended) return failure(ended.code, ended.message)
        }
        return failure(stopped.code, stopped.message)
      },
    },
  ]
  return tools
}
