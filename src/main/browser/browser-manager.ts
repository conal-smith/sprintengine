import { execFile } from 'node:child_process'
import { writeFile } from 'node:fs/promises'
import { chmodSync, existsSync } from 'node:fs'
import { isAbsolute, join, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import {
  BrowserWindow,
  clipboard,
  ClipboardItem,
  Menu,
  session,
  shell,
  webContents,
  type ContextMenuParams,
  type Session,
  type WebContents,
} from 'electron'
import { guestContextMenuTemplate } from './guest-context-menu'
import {
  BROWSER_PARTITION,
  BROWSER_PICK_CROP_PADDING,
  isLoadableBrowserUrl,
  type BrowserCaptureInput,
  type BrowserClearResult,
  type BrowserController,
  type BrowserHostKey,
  type BrowserLoadError,
  type BrowserPointerEvent,
  type BrowserRecordingState,
  type BrowserRegisterInput,
  type BrowserRegisterResult,
  type BrowserScreenshotResult,
  type BrowserTabState,
  type LocalServer,
} from '../../shared/browser'
import {
  BROWSER_ZOOM_LEVELS,
  nextZoomLevel,
  type BrowserColorScheme,
  type BrowserViewport,
} from '../../shared/browser-devices'
import { listProcListeners } from '../../server/web/preview-ports'
import { safeExternalUrl } from '../ipc/external-url'
import { parsePsTree, type ProcRow } from '../terminal-subtree-probe'
import { ensureWorkspaceStoreDir, ensureWorkspaceStoreDirSync } from '../workspace-store'
import { createAgentDownloads, reportedDownloadUrl, type AgentDownloadItem } from './agent-downloads'

// The embedded browser's main-process half (browser-pane epic). The renderer
// owns the `<webview>` elements; this owns everything the renderer must not:
// the persistent partition and its permission policy, the listeners on each
// guest WebContents, the state pushed back to the hosting window, navigation
// commands, the popup policy, and local dev-server discovery. One instance
// per app; tabs are keyed by the renderer's pane tab id.

// The permissions a page may hold. Everything else — camera, microphone,
// MIDI, USB, local fonts, pointer lock — is denied without a prompt: this is
// a preview surface for the person's own dev server, not a general browser.
// Notifications are denied too: granted without a prompt, any page an agent
// or a link opened here could post system notifications under the app's own
// name and icon, indistinguishable from the app's.
export const ALLOWED_PERMISSIONS: ReadonlySet<string> = new Set([
  'clipboard-read',
  'clipboard-sanitized-write',
  'geolocation',
  // The Fullscreen API, so a video's fullscreen button works. Electron asks
  // this handler before it lets a page go fullscreen. The guest and every
  // window that hosts one turn off HTML fullscreen's window resize
  // (`disableHtmlFullscreenWindowResize`, guest-policy.ts and
  // window-factory.ts), so the page fills the app window's content and the
  // window itself stays where it is rather than going into the OS's full
  // screen. Esc brings the pane back.
  'fullscreen',
])

// A favicon past this is not a favicon. Mirrors the renderer's cap.
const MAX_FAVICON_BYTES = 8 * 1024
const FAVICON_TIMEOUT_MS = 3_000
// A dev server that has not answered a HEAD in this long is not one we list.
const SERVER_PROBE_TIMEOUT_MS = 1_200

// Chords the person expects to keep working while the guest has focus. The
// guest sees the keystroke first; exactly these are re-dispatched to the host
// window (`browser:host-key`) so the app's own bindings — close tab, palette,
// pane toggle, Files/Git, zoom — act, and the page never sees them. Anything
// not in this table stays the page's (Cmd+P prints, Cmd+G finds next).
type Chord = { key: string; shift: boolean; alt: boolean }
const HOST_FORWARDED_CHORDS: readonly Chord[] = [
  { key: 'w', shift: false, alt: false },
  { key: 'k', shift: false, alt: false },
  { key: 'p', shift: true, alt: false },
  { key: 'e', shift: true, alt: false },
  { key: 'g', shift: true, alt: false },
  { key: 'b', shift: false, alt: true },
  { key: '=', shift: false, alt: false },
  { key: '+', shift: true, alt: false },
  { key: '-', shift: false, alt: false },
  { key: '0', shift: false, alt: false },
]
const CAPTURE_TIMEOUT_MS = 5_000
// How long a controller claim (agent or human) outlives its last input.
const CONTROLLER_LINGER_MS = 1_500

/** A file the agent's tab downloaded, from the moment it was given a path to its end. */
export type BrowserDownload = {
  url: string
  path: string
  state: 'started' | 'completed' | 'cancelled' | 'interrupted'
}

type TerminalRootInfo = {
  sessionId: string
  rootPid: number
  workspaceId: string | null
  terminalId: string | null
}

export type BrowserManagerDeps = {
  /** Every live pty and the workspace it belongs to (terminal-runtime's listTerminalRoots). */
  listTerminalRoots: () => TerminalRootInfo[]
  /** Whether a WebContents is one of this app's own windows — the only hosts a guest may register from. */
  isHostWindow: (host: WebContents) => boolean
  /** Push an event to every workspace window (open requests from the agent tools). */
  broadcast: (channel: string, payload: unknown) => void
  /** A workspace's project folder from main's registry; null when it has none. */
  resolveWorkspaceRoot: (workspaceId: string) => string | null
  platform?: NodeJS.Platform
  runPs?: () => Promise<string | null>
  runLsofListening?: () => Promise<string | null>
  /** Linux without a working `lsof`: the listeners these pids hold, read from `/proc`. */
  listProcListeners?: (pids: readonly number[]) => Promise<Array<{ pid: number; port: number }>>
  probeServer?: (url: string) => Promise<boolean>
  /**
   * SSH machines' partitions (phase 8): a workspace on one gets that
   * machine's, behind its forward; null keeps this computer's.
   */
  machinePartitions?: {
    forWorkspace(workspaceId: string): Promise<{ partition: string; label: string } | null>
    isMachinePartition(partition: string): boolean
    tabOpened(partition: string, tabId: string): void
    tabClosed(tabId: string): void
  }
}

type BrowserTab = {
  tabId: string
  workspaceId: string
  /** The partition its guest runs in: this computer's, or an SSH machine's (phase 8). */
  partition: string
  wc: WebContents
  host: WebContents
  state: BrowserTabState
  dispose: () => void
  // Bumped on every human action (a chord in the guest, a toolbar command):
  // an agent action in flight compares its epoch and yields (browser-control).
  epoch: number
  // > 0 while the agent control layer is dispatching synthetic input: those
  // keystrokes reach `before-input-event` too and must not count as a human.
  agentInputDepth: number
  controllerTimer: NodeJS.Timeout | null
}

// Appearance emulation is a DevTools-protocol feature (there is no per-guest
// Electron API for prefers-color-scheme), so a tab whose scheme is not
// `system` holds an in-process debugger session. Chromium allows one client
// per target: while the person has DevTools open the session is released and
// the emulation lapses; it is re-applied when DevTools closes.
async function applyColorScheme(tab: BrowserTab): Promise<void> {
  const { wc } = tab
  if (wc.isDestroyed()) return
  const scheme = tab.state.colorScheme
  if (scheme === 'system') {
    // Reset only; the session stays attached — the agent control session
    // (browser-control.ts) shares it, and detaching under it would cut the
    // agent off mid-action.
    if (wc.debugger.isAttached()) {
      try {
        await wc.debugger.sendCommand('Emulation.setEmulatedMedia', {
          features: [{ name: 'prefers-color-scheme', value: '' }],
        })
      } catch {
        // The target may be mid-navigation; the reset is best-effort.
      }
    }
    return
  }
  if (wc.isDevToolsOpened()) return
  try {
    if (!wc.debugger.isAttached()) wc.debugger.attach('1.3')
    await wc.debugger.sendCommand('Emulation.setEmulatedMedia', {
      features: [{ name: 'prefers-color-scheme', value: scheme }],
    })
  } catch {
    // Another debugger owns the target (DevTools racing us); the scheme stays
    // recorded and is applied on the next re-attach.
  }
}

function execFileTextOrNull(command: string, args: string[]): Promise<string | null> {
  return new Promise((resolve) => {
    execFile(command, args, { timeout: 3_000, maxBuffer: 8 * 1024 * 1024 }, (error, stdout) =>
      resolve(error ? null : stdout),
    )
  })
}

/**
 * `lsof -nP -iTCP -sTCP:LISTEN -F pcn` prints field lines: `p<pid>`, `c<cmd>`,
 * then one `n<host:port>` per listening socket. Loopback and wildcard binds
 * are what a dev server offers; a bind to a specific LAN address is not
 * something the pane should reach for.
 */
export function parseListeningSockets(stdout: string): { pid: number; command: string; port: number }[] {
  const out: { pid: number; command: string; port: number }[] = []
  let pid = 0
  let command = ''
  for (const raw of stdout.split('\n')) {
    const line = raw.trim()
    if (!line) continue
    const tag = line[0]
    const value = line.slice(1)
    if (tag === 'p') {
      pid = Number(value)
      command = ''
    } else if (tag === 'c') {
      command = value
    } else if (tag === 'n' && pid > 0) {
      const match = value.match(/^(?:\*|127\.0\.0\.1|localhost|\[::1\]|\[::\]|0\.0\.0\.0):(\d+)$/)
      if (!match) continue
      const port = Number(match[1])
      if (!Number.isInteger(port) || port <= 0 || port > 65535) continue
      out.push({ pid, command, port })
    }
  }
  return out
}

/** The program a `ps args` line runs, without its path or arguments: `/usr/bin/node vite` → `node`. */
function programName(args: string): string {
  const program = args.trim().split(/\s+/u)[0] ?? ''
  return program.slice(program.lastIndexOf('/') + 1)
}

/** Every pid under `rootPid` (excluding the root — the pty shell itself). */
export function descendantPids(rootPid: number, procs: readonly ProcRow[]): Set<number> {
  const childrenByParent = new Map<number, number[]>()
  for (const proc of procs) {
    const list = childrenByParent.get(proc.ppid)
    if (list) list.push(proc.pid)
    else childrenByParent.set(proc.ppid, [proc.pid])
  }
  const seen = new Set<number>()
  const stack = [...(childrenByParent.get(rootPid) ?? [])]
  while (stack.length > 0) {
    const pid = stack.pop()!
    if (seen.has(pid)) continue
    seen.add(pid)
    stack.push(...(childrenByParent.get(pid) ?? []))
  }
  return seen
}

/**
 * The guest's user agent without the tokens that say "this is an Electron
 * app". Electron builds its default from `app.getName()` with the spaces taken
 * out, so a packaged build carries `SprintEngineStudio/<version>` (the
 * productName) and a dev build `sprintengine-studio/<version>` (the package
 * name). What is left is product tokens and comments separated by single
 * spaces, the shape RFC 9110 gives a User-Agent.
 */
export function stripUserAgent(userAgent: string): string {
  // A dev server that sniffs `Electron/` serves a different page than the
  // one the person will ship; so does one that sees the app's own token.
  return userAgent
    .replace(/(^|\s)(?:Electron|sprintengine(?:-?studio)?)\/\S+/gi, '$1')
    .replace(/\s+/g, ' ')
    .trim()
}

// Fetched on the browser's own session: the page's cookies (an auth-gated dev
// server) and the stripped user agent travel with it.
async function fetchFaviconDataUrl(browserSession: Session, url: string): Promise<string | null> {
  if (!/^https?:\/\//i.test(url)) return null
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), FAVICON_TIMEOUT_MS)
  try {
    const response = await browserSession.fetch(url, { signal: controller.signal })
    if (!response.ok) return null
    const type = response.headers.get('content-type')?.split(';')[0]?.trim() ?? ''
    if (!type.startsWith('image/')) return null
    const buffer = Buffer.from(await response.arrayBuffer())
    if (buffer.byteLength === 0 || buffer.byteLength > MAX_FAVICON_BYTES) return null
    return `data:${type};base64,${buffer.toString('base64')}`
  } catch {
    return null
  } finally {
    clearTimeout(timer)
  }
}

async function probeLocalServer(browserSession: Session, url: string): Promise<boolean> {
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), SERVER_PROBE_TIMEOUT_MS)
  try {
    // Follow redirects: a root that redirects to /login is a web server
    // answering (Electron's fetch REJECTS a manual redirect rather than
    // returning an opaque response). Any resolved response — a 5xx from a dev
    // server mid-restart included — is a web server; only a refused or
    // non-HTTP socket is left out.
    await browserSession.fetch(url, { method: 'GET', signal: controller.signal, redirect: 'follow' })
    return true
  } catch {
    return false
  } finally {
    clearTimeout(timer)
  }
}

/** Local wall-clock stamp (`2026-09-04_08-18-02`): the file is named for the person's clock, not UTC. */
export function fileStamp(now = new Date()): string {
  const two = (n: number) => String(n).padStart(2, '0')
  return `${now.getFullYear()}-${two(now.getMonth() + 1)}-${two(now.getDate())}_${two(now.getHours())}-${two(now.getMinutes())}-${two(now.getSeconds())}`
}

/**
 * Write a capture as `<name>-<stamp>.png` in `directory`, never over another
 * file. The stamp is to the second, so a second capture within it (an agent
 * taking two in a row) is numbered `-2`, `-3`, … instead of replacing the
 * first, which an earlier message may already show. Returns the path written.
 */
export async function writeCaptureFile(
  directory: string,
  name: string,
  data: Uint8Array,
  now = new Date(),
): Promise<string> {
  const base = `${name}-${fileStamp(now)}`
  for (let n = 1; ; n += 1) {
    const file = join(directory, n === 1 ? `${base}.png` : `${base}-${n}.png`)
    try {
      await writeFile(file, data, { flag: 'wx' })
      return file
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST' || n >= 1000) throw error
    }
  }
}

/**
 * A guest-viewport CSS rect as a crop of the captured image: padded, scaled by
 * the zoom factor into DIP, clamped to the image; null when nothing of it is on
 * screen or the numbers are not sane.
 */
export function cropRect(
  rect: { x: number; y: number; width: number; height: number },
  zoomFactor: number,
  image: { width: number; height: number },
): Electron.Rectangle | null {
  const values = [rect.x, rect.y, rect.width, rect.height]
  if (!values.every((value) => Number.isFinite(value)) || rect.width < 0 || rect.height < 0) return null
  const zoom = Number.isFinite(zoomFactor) && zoomFactor > 0 ? zoomFactor : 1
  const pad = BROWSER_PICK_CROP_PADDING
  const left = Math.max(0, Math.floor((rect.x - pad) * zoom))
  const top = Math.max(0, Math.floor((rect.y - pad) * zoom))
  const right = Math.min(image.width, Math.ceil((rect.x + rect.width + pad) * zoom))
  const bottom = Math.min(image.height, Math.ceil((rect.y + rect.height + pad) * zoom))
  if (right - left < 1 || bottom - top < 1) return null
  return { x: left, y: top, width: right - left, height: bottom - top }
}

function hostSlug(url: string): string {
  try {
    return new URL(url).host.replace(/[^a-z0-9.-]/gi, '-') || 'page'
  } catch {
    return 'page'
  }
}

// The guest preload electron-vite emits beside the app's (out/preload/
// browser-guest.js). Absent in a build without it, in which case the tab
// simply has no element picker.
export function guestPreloadPath(): string | null {
  const candidate = join(__dirname, '../preload/browser-guest.js')
  return existsSync(candidate) ? candidate : null
}

function guestPreloadUrl(): string | null {
  const path = guestPreloadPath()
  return path ? pathToFileURL(path).toString() : null
}

// How long a tab that left one window has to register in the next and still
// find the agents that were driving it. A pop-out window boots a whole renderer
// before its guest registers; that is seconds, not minutes.
export const TAB_MOVE_GRACE_MS = 30_000

/**
 * Which tab each AGENT is driving, keyed `<workspaceId>\0<agentId>`.
 *
 * Separate from `activeTabByWorkspace`, which is what the PERSON is looking
 * at. Before this, an agent with no `tabId` resolved the person's active tab,
 * so two agents in one workspace drove the same page and stole it from each
 * other mid-interaction — and from the person.
 *
 * An assignment is sticky for the same reason a provider session is pinned
 * to one runtime: a multi-step interaction (open, type, click, wait) is
 * stateful in the page's cookies and DOM, and moving it between tabs halfway
 * through produces a failure nobody can read. It is dropped only when the tab
 * it names goes away — and a tab that only moved windows, unregistering from
 * one and registering under the same id in the other, has not gone away: what
 * its going released is given back when it comes, for `TAB_MOVE_GRACE_MS`, to
 * each agent that has not taken another tab since.
 */
export function createAgentTabAssignments(now: () => number = Date.now) {
  const assignments = new Map<string, string>()
  const released = new Map<string, { workspaceId: string; keys: string[]; at: number }>()
  const keyOf = (workspaceId: string, agentId: string): string => `${workspaceId}\u0000${agentId}`

  function forgetLapsed(): void {
    for (const [tabId, entry] of released) {
      if (now() - entry.at > TAB_MOVE_GRACE_MS) released.delete(tabId)
    }
  }

  return {
    get: (workspaceId: string, agentId: string): string | undefined => assignments.get(keyOf(workspaceId, agentId)),
    set: (workspaceId: string, agentId: string, tabId: string): void => {
      assignments.set(keyOf(workspaceId, agentId), tabId)
    },
    delete: (workspaceId: string, agentId: string): void => {
      assignments.delete(keyOf(workspaceId, agentId))
    },
    holding(workspaceId: string): Array<{ agentId: string; tabId: string }> {
      const held: Array<{ agentId: string; tabId: string }> = []
      for (const [key, tabId] of assignments) {
        const [keyWorkspace, agentId] = key.split('\u0000')
        if (keyWorkspace === workspaceId && agentId) held.push({ agentId, tabId })
      }
      return held
    },
    /** The tab went: every agent holding it lets go, and is remembered for a while. */
    release(tabId: string, workspaceId: string): void {
      forgetLapsed()
      const keys: string[] = []
      for (const [key, assigned] of assignments) {
        if (assigned !== tabId) continue
        assignments.delete(key)
        keys.push(key)
      }
      if (keys.length > 0) released.set(tabId, { workspaceId, keys, at: now() })
    },
    /** The tab registered again: it moved, so the agents it let go hold it again. */
    restore(tabId: string, workspaceId: string): void {
      forgetLapsed()
      const entry = released.get(tabId)
      if (!entry) return
      released.delete(tabId)
      if (entry.workspaceId !== workspaceId) return
      for (const key of entry.keys) {
        if (!assignments.has(key)) assignments.set(key, tabId)
      }
    },
    clear(): void {
      assignments.clear()
      released.clear()
    },
  }
}

export function createBrowserManager(deps: BrowserManagerDeps) {
  const tabs = new Map<string, BrowserTab>()
  const activeTabByWorkspace = new Map<string, string>()
  const agentAssignments = createAgentTabAssignments()
  const unregisterListeners = new Set<(tabId: string) => void>()
  const humanInputListeners = new Set<(tabId: string) => void>()
  const downloadListeners = new Set<(tabId: string, download: BrowserDownload) => void>()
  const agentDownloads = createAgentDownloads()

  /** A claim on the page that lapses CONTROLLER_LINGER_MS after the last input. */
  function claim(tab: BrowserTab, controller: BrowserController): void {
    if (tab.state.controller !== controller) patch(tab, { controller })
    if (tab.controllerTimer) clearTimeout(tab.controllerTimer)
    tab.controllerTimer = setTimeout(() => {
      tab.controllerTimer = null
      if (tabs.get(tab.tabId) === tab && !tab.wc.isDestroyed()) patch(tab, { controller: 'none' })
    }, CONTROLLER_LINGER_MS)
  }

  /** The person acted on the page: the epoch moves, the page is theirs, the control layer hears it. */
  function humanTookOver(tab: BrowserTab): void {
    tab.epoch += 1
    claim(tab, 'human')
    for (const listener of humanInputListeners) listener(tab.tabId)
  }
  const browserSessions = new Map<string, Session>()

  /** A partition's session, with the pane's permission policy and user agent; this computer's by default. */
  function ensureSession(partition: string = BROWSER_PARTITION): Session {
    const known = browserSessions.get(partition)
    if (known) return known
    const created = session.fromPartition(partition)
    created.setUserAgent(stripUserAgent(created.getUserAgent()))
    created.setPermissionRequestHandler((_wc, permission, callback) => {
      callback(ALLOWED_PERMISSIONS.has(permission))
    })
    created.setPermissionCheckHandler((_wc, permission) => ALLOWED_PERMISSIONS.has(permission))
    created.on('will-download', (_event, item, wc) => saveAgentDownload(item, wc))
    browserSessions.set(partition, created)
    return created
  }

  /**
   * A download from a tab the agent is driving is saved to the workspace's
   * store (`browser/downloads/`, workspace-store.ts) without a dialog
   * (agent-downloads.ts). Anything else — the person's own download, a tab
   * with no workspace folder, a folder that cannot be made — returns without
   * a path, and Chromium asks.
   */
  function saveAgentDownload(item: AgentDownloadItem, wc: WebContents | undefined): void {
    const tab = [...tabs.values()].find((candidate) => candidate.wc === wc)
    if (!tab || tab.state.controller !== 'agent') return
    const workspaceRoot = deps.resolveWorkspaceRoot(tab.workspaceId)
    if (!workspaceRoot || !isAbsolute(workspaceRoot) || !existsSync(workspaceRoot)) return
    let directory: string
    try {
      directory = ensureWorkspaceStoreDirSync(resolve(workspaceRoot), 'browser', 'downloads')
      // What a page hands over is the person's business: the folder is theirs alone.
      if (process.platform !== 'win32') chmodSync(directory, 0o700)
    } catch {
      return
    }
    const url = reportedDownloadUrl(item.getURL())
    const path = agentDownloads.save(item, directory)
    const tell = (state: BrowserDownload['state']) => {
      for (const listener of downloadListeners) listener(tab.tabId, { url, path, state })
    }
    item.once('done', (_event, state) => tell(state))
    tell('started')
  }

  /** The partition a guest's session is, by asking each one this manager made. */
  function partitionOf(wc: WebContents): string {
    for (const [partition, known] of browserSessions) if (known === wc.session) return partition
    return BROWSER_PARTITION
  }

  function publish(tab: BrowserTab): void {
    if (tab.host.isDestroyed()) return
    tab.host.send('browser:state', tab.state)
  }

  function patch(tab: BrowserTab, next: Partial<BrowserTabState>): void {
    tab.state = { ...tab.state, ...next }
    publish(tab)
  }

  function capturePage(wc: WebContents, rect?: Electron.Rectangle): Promise<Electron.NativeImage> {
    // capturePage can hang on a guest that is mid-teardown; a bounded wait
    // turns that into a reported failure instead of a stuck toolbar.
    return new Promise((resolvePromise, reject) => {
      const timer = setTimeout(
        () => reject(new Error('The page did not answer the capture in time.')),
        CAPTURE_TIMEOUT_MS,
      )
      ;(rect ? wc.capturePage(rect) : wc.capturePage()).then(
        (image) => {
          clearTimeout(timer)
          resolvePromise(image)
        },
        (error) => {
          clearTimeout(timer)
          reject(error)
        },
      )
    })
  }

  function readNavigation(wc: WebContents): Pick<BrowserTabState, 'url' | 'title' | 'canGoBack' | 'canGoForward'> {
    const history = wc.navigationHistory
    return {
      url: wc.getURL(),
      title: wc.getTitle(),
      canGoBack: history.canGoBack(),
      canGoForward: history.canGoForward(),
    }
  }

  /**
   * The page's own right-click menu (`guest-context-menu.ts`). The page is
   * focused first: Cut, Copy and Paste act on whichever contents has focus,
   * and a right-click on a page you had not clicked into leaves the app's.
   */
  function showGuestMenu(contents: WebContents, params: ContextMenuParams, window: BrowserWindow | null): void {
    if (contents.isDestroyed()) return
    contents.focus()
    const template = guestContextMenuTemplate(params, contents, (text) => clipboard.writeText(text))
    Menu.buildFromTemplate(template).popup({
      ...(window && !window.isDestroyed() ? { window } : {}),
      // The frame that was clicked, so a menu over an iframe acts on it.
      ...(params.frame ? { frame: params.frame } : {}),
    })
  }

  function attach(tab: BrowserTab): () => void {
    const { wc } = tab
    const disposers: (() => void)[] = []
    const on = <K extends string>(event: K, handler: (...args: never[]) => void) => {
      // WebContents extends EventEmitter; the per-event typings are stricter
      // than a generic subscription needs.
      ;(wc as unknown as NodeJS.EventEmitter).on(event, handler as (...args: unknown[]) => void)
      disposers.push(() => {
        if (!wc.isDestroyed())
          (wc as unknown as NodeJS.EventEmitter).off(event, handler as (...args: unknown[]) => void)
      })
    }

    on('did-start-loading', () => patch(tab, { loading: true }))
    on('did-stop-loading', () => patch(tab, { loading: false, ...readNavigation(wc) }))
    on('did-start-navigation', (details: { isMainFrame: boolean; isSameDocument: boolean; url: string }) => {
      if (!details.isMainFrame) return
      // A fresh document: the old title, favicon and error no longer describe
      // what is on screen. Same-document (hash/pushState) keeps them.
      if (details.isSameDocument) {
        patch(tab, { ...readNavigation(wc) })
        return
      }
      patch(tab, { url: details.url, title: '', faviconUrl: null, error: null, loading: true })
    })
    on('did-navigate', () => {
      const navigation = readNavigation(wc)
      patch(tab, { ...navigation, documentUrl: navigation.url, error: null })
      // A new document loses the emulated media; re-assert the scheme.
      if (tab.state.colorScheme !== 'system') void applyColorScheme(tab)
    })
    // The scheme rule, enforced where it matters: whatever a link, a script or
    // a caller asks for, the guest only ever loads http(s) or a blank tab.
    on('will-navigate', (event: { preventDefault: () => void }, url: string) => {
      if (!isLoadableBrowserUrl(url)) event.preventDefault()
    })
    on('devtools-opened', () => {
      // DevTools takes the debugger slot; let go of ours and say so. This is
      // the one place the session is detached: the agent control layer hears
      // the `detach` event, marks its session gone, and re-attaches on its
      // next command (refusing while DevTools is open).
      if (wc.debugger.isAttached()) wc.debugger.detach()
      patch(tab, { devToolsOpen: true })
    })
    on('devtools-closed', () => {
      patch(tab, { devToolsOpen: false })
      void applyColorScheme(tab)
    })
    on('zoom-changed', () => patch(tab, { zoomFactor: wc.getZoomFactor() }))
    on('did-navigate-in-page', () => patch(tab, { ...readNavigation(wc) }))
    on('page-title-updated', (_event: unknown, title: string) => patch(tab, { title }))
    on('page-favicon-updated', (_event: unknown, favicons: string[]) => {
      const [first] = favicons
      if (!first) return
      const at = wc.getURL()
      // On the tab's own session, whichever partition it is in: the icon is
      // fetched as the page itself would fetch it.
      void fetchFaviconDataUrl(wc.session, first).then((dataUrl) => {
        // Only if the page has not moved on meanwhile.
        if (!wc.isDestroyed() && tabs.get(tab.tabId) === tab && wc.getURL() === at) {
          patch(tab, { faviconUrl: dataUrl })
        }
      })
    })
    on('did-fail-load', (_event: unknown, code: number, description: string, url: string, isMainFrame: boolean) => {
      // -3 is ERR_ABORTED: a navigation replaced by another, never an error the
      // person needs to see. Subframe failures are the page's business.
      if (!isMainFrame || code === -3) return
      const error: BrowserLoadError = { code, description, url }
      patch(tab, { loading: false, error, url })
    })
    on('render-process-gone', (_event: unknown, details: { reason: string }) => {
      patch(tab, {
        loading: false,
        error: { code: 0, description: `RENDERER_${details.reason.toUpperCase()}`, url: tab.state.url },
      })
    })
    on(
      'before-input-event',
      (
        event: { preventDefault: () => void },
        input: {
          type: string
          key: string
          meta: boolean
          control: boolean
          alt: boolean
          shift: boolean
        },
      ) => {
        if (input.type !== 'keyDown') return
        // A key the agent sent (browser_press) is the page's, chords included:
        // its Cmd+W is meant for the page under test, and as the app's own it
        // would close a tab of the app's or reload the page under the agent.
        if (tab.agentInputDepth > 0) return
        humanTookOver(tab)
        const primary = process.platform === 'darwin' ? input.meta : input.control
        if (!primary) return
        const key = input.key.toLowerCase()
        if (key === 'r' && !input.alt) {
          event.preventDefault()
          if (input.shift) wc.reloadIgnoringCache()
          else wc.reload()
          return
        }
        if (key === 'l' && !input.shift && !input.alt) {
          event.preventDefault()
          if (!tab.host.isDestroyed()) tab.host.send('browser:focus-url', { tabId: tab.tabId })
          return
        }
        const forwarded = HOST_FORWARDED_CHORDS.some(
          (chord) => chord.key === key && chord.shift === input.shift && chord.alt === input.alt,
        )
        if (forwarded) {
          event.preventDefault()
          const hostKey: BrowserHostKey = {
            key: input.key,
            meta: input.meta,
            ctrl: input.control,
            alt: input.alt,
            shift: input.shift,
          }
          if (!tab.host.isDestroyed()) tab.host.send('browser:host-key', { tabId: tab.tabId, key: hostKey })
        }
      },
    )

    // The popup policy (epic decision 2): a real `window.open` with the
    // new-window disposition and an http(s) URL — an OAuth flow — gets a
    // sandboxed popup that may not open windows of its own; everything else
    // (`target=_blank` links included) navigates the tab in place. Nothing
    // here reaches the system browser: that is the explicit action only.
    wc.setWindowOpenHandler((details) => {
      const isHttp = /^https?:\/\//i.test(details.url)
      if (isHttp && details.disposition === 'new-window') {
        return {
          action: 'allow',
          overrideBrowserWindowOptions: {
            webPreferences: {
              contextIsolation: true,
              nodeIntegration: false,
              sandbox: true,
              partition: tab.partition,
              // A webview embedder's popups inherit its last webPreferences,
              // picker preload included; only the pane's guest runs the picker.
              preload: undefined,
            },
          },
        }
      }
      if (isHttp) void wc.loadURL(details.url)
      return { action: 'deny' }
    })
    on('did-create-window', (child: BrowserWindow) => {
      child.webContents.setWindowOpenHandler(() => ({ action: 'deny' }))
      // A sign-in popup is a page too: right-click there gets the same menu.
      child.webContents.on('context-menu', (_event, params) => showGuestMenu(child.webContents, params, child))
    })
    on('context-menu', (_event: unknown, params: ContextMenuParams) =>
      showGuestMenu(wc, params, BrowserWindow.fromWebContents(tab.host)),
    )
    on('destroyed', () => {
      tabs.delete(tab.tabId)
      deps.machinePartitions?.tabClosed(tab.tabId)
    })

    return () => {
      for (const dispose of disposers) dispose()
    }
  }

  function requireTab(tabId: string): BrowserTab | null {
    const tab = tabs.get(tabId)
    if (!tab || tab.wc.isDestroyed()) {
      if (tab) tabs.delete(tabId)
      return null
    }
    return tab
  }

  return {
    async getConfig(workspaceId?: string) {
      // A workspace on an SSH machine: that machine's partition, its forward
      // open and its proxy set before the guest is made (phase 8 spec, 6.8).
      const machine = workspaceId ? await deps.machinePartitions?.forWorkspace(workspaceId) : null
      if (machine) {
        ensureSession(machine.partition)
        return {
          partition: machine.partition,
          preloadUrl: guestPreloadUrl(),
          network: 'remote' as const,
          machine: machine.label,
        }
      }
      ensureSession()
      return { partition: BROWSER_PARTITION, preloadUrl: guestPreloadUrl() }
    },

    /**
     * Adopt a guest the renderer attached. The host must be one of our windows
     * and the WebContents a `<webview>` guest of that host — a renderer cannot
     * hand main some other WebContents id and have it driven.
     */
    register(input: BrowserRegisterInput, host: WebContents): BrowserRegisterResult {
      if (!deps.isHostWindow(host)) return { ok: false, reason: 'foreign_host' }
      const wc = webContents.fromId(input.webContentsId)
      if (!wc || wc.isDestroyed()) return { ok: false, reason: 'unknown_webcontents' }
      if (wc.getType() !== 'webview') return { ok: false, reason: 'not_a_webview' }
      if (wc.hostWebContents?.id !== host.id) return { ok: false, reason: 'foreign_host' }
      // One guest, one tab: a second tab id on the same WebContents would
      // double every listener and let two records fight over one page.
      for (const [otherId, other] of tabs) {
        if (otherId !== input.tabId && other.wc === wc) return { ok: false, reason: 'already_registered' }
      }
      const existing = tabs.get(input.tabId)
      if (existing) {
        if (existing.wc === wc) return { ok: true, state: existing.state }
        // The renderer remounted the guest (a crash recovery); the old one is
        // gone or going.
        existing.dispose()
        tabs.delete(input.tabId)
      }
      ensureSession()
      const partition = partitionOf(wc)
      const remote = partition !== BROWSER_PARTITION && (deps.machinePartitions?.isMachinePartition(partition) ?? false)
      if (remote) {
        // UDP cannot ride the forward: a page neither leaks this computer's
        // addresses nor goes around the machine (spec 6.8).
        wc.setWebRTCIPHandlingPolicy('disable_non_proxied_udp')
        deps.machinePartitions?.tabOpened(partition, input.tabId)
      }
      const tab: BrowserTab = {
        tabId: input.tabId,
        workspaceId: input.workspaceId,
        partition,
        wc,
        host,
        state: {
          tabId: input.tabId,
          ...readNavigation(wc),
          documentUrl: wc.getURL(),
          faviconUrl: null,
          loading: wc.isLoading(),
          error: null,
          zoomFactor: 1,
          colorScheme: 'system',
          devToolsOpen: wc.isDevToolsOpened(),
          controller: 'none',
          network: remote ? 'remote' : 'local',
          recording: null,
        },
        dispose: () => {},
        epoch: 0,
        agentInputDepth: 0,
        controllerTimer: null,
      }
      tab.dispose = attach(tab)
      // Guests inherit the embedder's zoom; a tab is its own document.
      wc.setZoomFactor(1)
      tabs.set(input.tabId, tab)
      // A tab moving between windows — popped out of its pane, docked back —
      // unregisters from the one it left and registers here under the same
      // id, a new guest on the same page. The agents that were driving it
      // still are.
      agentAssignments.restore(input.tabId, input.workspaceId)
      return { ok: true, state: tab.state }
    },

    unregister(tabId: string): void {
      const tab = tabs.get(tabId)
      if (!tab) return
      if (tab.controllerTimer) clearTimeout(tab.controllerTimer)
      tab.dispose()
      tabs.delete(tabId)
      deps.machinePartitions?.tabClosed(tabId)
      if (activeTabByWorkspace.get(tab.workspaceId) === tabId) activeTabByWorkspace.delete(tab.workspaceId)
      // A closed tab releases every agent holding it, so the next call resolves
      // afresh rather than failing against a tab that is gone — unless the
      // tab is only moving windows and registers again (`restore` above).
      agentAssignments.release(tabId, tab.workspaceId)
      for (const listener of unregisterListeners) listener(tabId)
    },

    /** Called with a tab id after it is unregistered (the control layer drops its session). */
    onUnregister(listener: (tabId: string) => void): () => void {
      unregisterListeners.add(listener)
      return () => unregisterListeners.delete(listener)
    },

    state(tabId: string): BrowserTabState | null {
      return requireTab(tabId)?.state ?? null
    },

    /**
     * The tab the person is looking at in a workspace's pane, as the renderer
     * reports it; what a `browser.*` tool acts on when the agent names none.
     */
    noteActive(workspaceId: string, tabId: string | null): void {
      if (tabId) activeTabByWorkspace.set(workspaceId, tabId)
      else activeTabByWorkspace.delete(workspaceId)
    },

    /** The tab last noted as the one the person is looking at, as noted. */
    notedActive(workspaceId: string): string | null {
      return activeTabByWorkspace.get(workspaceId) ?? null
    },

    activeTab(workspaceId: string): BrowserTab | null {
      const preferred = activeTabByWorkspace.get(workspaceId)
      const tab = preferred ? requireTab(preferred) : null
      if (tab && tab.workspaceId === workspaceId) return tab
      return (
        [...tabs.values()].find((candidate) => candidate.workspaceId === workspaceId && !candidate.wc.isDestroyed()) ??
        null
      )
    },

    /** The tab this agent is driving, or null when it holds none that still exists. */
    assignedTab(workspaceId: string, agentId: string): BrowserTab | null {
      const tabId = agentAssignments.get(workspaceId, agentId)
      if (!tabId) return null
      const tab = requireTab(tabId)
      if (tab && tab.workspaceId === workspaceId) return tab
      agentAssignments.delete(workspaceId, agentId)
      return null
    },

    /** Bind an agent to a tab; every later tool call with no `tabId` lands here. */
    assignTab(workspaceId: string, agentId: string, tabId: string): void {
      const tab = requireTab(tabId)
      if (!tab || tab.workspaceId !== workspaceId) return
      agentAssignments.set(workspaceId, agentId, tabId)
    },

    /** Which agents hold a tab, for `browser.status` and the tests. */
    agentsHolding(workspaceId: string): Array<{ agentId: string; tabId: string }> {
      return agentAssignments.holding(workspaceId)
    },

    /**
     * Ask the windows hosting a workspace to show the agent's work: with a
     * `tabId`, reveal the pane and select that tab; with a `url`, open a new
     * tab on it; with neither, make sure a browser tab exists and the pane is
     * open.
     */
    requestOpen(workspaceId: string, url: string | null, tabId: string | null = null): void {
      deps.broadcast('browser:open-request', { workspaceId, url, tabId })
    },

    /** Ask the renderer to change a tab's device viewport (renderer-owned state). */
    requestViewport(tabId: string, viewport: BrowserViewport): void {
      const tab = requireTab(tabId)
      if (!tab || tab.host.isDestroyed()) return
      tab.host.send('browser:viewport-request', { tabId, viewport })
    },

    /** The agent holds the page for a moment; the toolbar badge and the cursor overlay show it. */
    noteAgentActivity(tabId: string): void {
      const tab = requireTab(tabId)
      if (tab) claim(tab, 'agent')
    },

    /** Called with the tab id whenever the person's own input moves the epoch. */
    onHumanInput(listener: (tabId: string) => void): () => void {
      humanInputListeners.add(listener)
      return () => humanInputListeners.delete(listener)
    },

    /** Called as a download the agent's tab set off is saved, and again when it ends. */
    onDownload(listener: (tabId: string, download: BrowserDownload) => void): () => void {
      downloadListeners.add(listener)
      return () => downloadListeners.delete(listener)
    },

    /** A recording started or ended on a tab: the toolbar shows it while it runs. */
    setRecording(tabId: string, recording: BrowserRecordingState | null): void {
      const tab = requireTab(tabId)
      if (tab) patch(tab, { recording })
    },

    /** Where the agent's pointer is about to act, for the host window's cursor overlay. */
    notePointer(event: BrowserPointerEvent): void {
      const tab = requireTab(event.tabId)
      if (tab && !tab.host.isDestroyed()) tab.host.send('browser:pointer', event)
    },

    epochOf(tabId: string): number {
      return requireTab(tabId)?.epoch ?? -1
    },

    /** Bracket the agent's synthetic input so it does not read as a human taking over. */
    noteAgentInput(tabId: string, delta: 1 | -1): void {
      const tab = requireTab(tabId)
      if (!tab) return
      const wasDriving = tab.agentInputDepth > 0
      tab.agentInputDepth = Math.max(0, tab.agentInputDepth + delta)
      // The app menu's accelerators answer a guest's keys before the page
      // does; while the agent types they stay out of it, as the chords above do.
      const driving = tab.agentInputDepth > 0
      if (driving !== wasDriving && !tab.wc.isDestroyed()) tab.wc.setIgnoreMenuShortcuts(driving)
    },

    /** Tabs a workspace owns, for the agent tools (browser-tools child). */
    listTabs(workspaceId: string): BrowserTabState[] {
      return [...tabs.values()]
        .filter((tab) => tab.workspaceId === workspaceId && !tab.wc.isDestroyed())
        .map((tab) => tab.state)
    },

    /** The window WebContents hosting a tab, for sender checks in IPC. */
    hostOf(tabId: string): WebContents | null {
      const tab = requireTab(tabId)
      return tab && !tab.host.isDestroyed() ? tab.host : null
    },

    webContentsOf(tabId: string): WebContents | null {
      return requireTab(tabId)?.wc ?? null
    },

    navigate(tabId: string, url: string): boolean {
      const tab = requireTab(tabId)
      if (!tab || !isLoadableBrowserUrl(url)) return false
      humanTookOver(tab)
      patch(tab, { error: null, loading: true, url })
      void tab.wc.loadURL(url).catch((error: unknown) => {
        // did-fail-load reports most failures with their code; a load the
        // guest never started (an immediate rejection that is not an abort)
        // would otherwise leave the optimistic loading state stuck.
        const code = error && typeof error === 'object' ? (error as { errno?: number; code?: string }) : null
        if (code?.code === 'ERR_ABORTED' || code?.errno === -3) return
        if (tab.state.loading && tab.state.url === url) {
          patch(tab, {
            loading: false,
            error: { code: code?.errno ?? 0, description: code?.code ?? 'ERR_FAILED', url },
          })
        }
      })
      return true
    },

    /** PNG of the page (or a crop of it) into the workspace store's `browser/`. */
    async captureScreenshot(input: BrowserCaptureInput): Promise<BrowserScreenshotResult> {
      const tab = requireTab(input.tabId)
      if (!tab) return { ok: false, message: 'This browser tab is gone.' }
      // The folder comes from main's own registry, keyed by the tab's
      // workspace — never from the renderer, which could name any directory.
      const workspaceRoot = deps.resolveWorkspaceRoot(tab.workspaceId)
      if (!workspaceRoot || !isAbsolute(workspaceRoot) || !existsSync(workspaceRoot)) {
        return { ok: false, message: 'The workspace folder is not available.' }
      }
      try {
        const full = await capturePage(tab.wc)
        const fullSize = full.getSize()
        if (fullSize.width === 0 || fullSize.height === 0)
          return { ok: false, message: 'The page had nothing to capture.' }
        let image = full
        if (input.rect) {
          // The guest reports CSS px; the capture is in the view's DIP, which
          // differ by the zoom factor. Pad, then clamp to what was captured.
          const crop = cropRect(input.rect, tab.wc.getZoomFactor(), fullSize)
          if (!crop) return { ok: false, message: 'The element is outside the visible page.' }
          image = full.crop(crop)
        }
        const size = image.getSize()
        // In the store in the person's home, never in the project: a capture
        // is the app's, and in the project it was one more file to ignore.
        const directory = await ensureWorkspaceStoreDir(resolve(workspaceRoot), 'browser')
        const file = await writeCaptureFile(directory, `${input.kind}-${hostSlug(tab.state.url)}`, image.toPNG())
        return { ok: true, path: file, width: size.width, height: size.height }
      } catch (error) {
        return { ok: false, message: error instanceof Error ? error.message : 'The capture failed.' }
      }
    },

    async copyScreenshot(tabId: string): Promise<BrowserClearResult> {
      const tab = requireTab(tabId)
      if (!tab) return { ok: false, message: 'This browser tab is gone.' }
      try {
        const image = await capturePage(tab.wc)
        await clipboard.write([
          new ClipboardItem({ 'image/png': new Blob([new Uint8Array(image.toPNG())], { type: 'image/png' }) }),
        ])
        return { ok: true }
      } catch (error) {
        return { ok: false, message: error instanceof Error ? error.message : 'The capture failed.' }
      }
    },

    back(tabId: string): boolean {
      const tab = requireTab(tabId)
      if (!tab || !tab.wc.navigationHistory.canGoBack()) return false
      humanTookOver(tab)
      tab.wc.navigationHistory.goBack()
      return true
    },

    forward(tabId: string): boolean {
      const tab = requireTab(tabId)
      if (!tab || !tab.wc.navigationHistory.canGoForward()) return false
      humanTookOver(tab)
      tab.wc.navigationHistory.goForward()
      return true
    },

    reload(tabId: string, ignoreCache = false): boolean {
      const tab = requireTab(tabId)
      if (!tab) return false
      humanTookOver(tab)
      patch(tab, { error: null })
      if (ignoreCache) tab.wc.reloadIgnoringCache()
      else tab.wc.reload()
      return true
    },

    stop(tabId: string): boolean {
      const tab = requireTab(tabId)
      if (!tab) return false
      humanTookOver(tab)
      tab.wc.stop()
      patch(tab, { loading: false })
      return true
    },

    setZoom(tabId: string, factor: number): boolean {
      const tab = requireTab(tabId)
      if (!tab) return false
      const clamped = BROWSER_ZOOM_LEVELS.includes(factor) ? factor : 1
      tab.wc.setZoomFactor(clamped)
      patch(tab, { zoomFactor: clamped })
      return true
    },

    /**
     * Put each tab hosted by `host` back at its own zoom. Electron carries a
     * change to the embedding window's zoom into every guest it hosts, so the
     * app's View ▸ Zoom would zoom the pages too, and leave each tab's zoom
     * reading what it no longer is; the app menu calls this after each one.
     */
    reapplyGuestZoom(host: WebContents): void {
      for (const tab of tabs.values()) {
        if (tab.host !== host || tab.wc.isDestroyed()) continue
        tab.wc.setZoomFactor(tab.state.zoomFactor)
      }
    },

    zoomStep(tabId: string, direction: 1 | -1 | 0): boolean {
      const tab = requireTab(tabId)
      if (!tab) return false
      const next = direction === 0 ? 1 : nextZoomLevel(tab.wc.getZoomFactor(), direction)
      tab.wc.setZoomFactor(next)
      patch(tab, { zoomFactor: next })
      return true
    },

    setColorScheme(tabId: string, scheme: BrowserColorScheme): boolean {
      const tab = requireTab(tabId)
      if (!tab) return false
      patch(tab, { colorScheme: scheme })
      void applyColorScheme(tab)
      return true
    },

    openDevTools(tabId: string): boolean {
      const tab = requireTab(tabId)
      if (!tab) return false
      if (tab.wc.isDevToolsOpened()) {
        tab.wc.devToolsWebContents?.focus()
        return true
      }
      tab.wc.openDevTools({ mode: 'detach' })
      return true
    },

    /**
     * The page in its own window: a plain Chromium window on the same
     * partition, so a sign-in in one is a sign-in in both. Not a mirror of the
     * pane's guest — a second, independent view of the same URL.
     */
    openWindow(tabId: string): boolean {
      const tab = requireTab(tabId)
      if (!tab) return false
      const url = tab.state.url
      if (!/^https?:\/\//i.test(url)) return false
      const win = new BrowserWindow({
        width: 1100,
        height: 760,
        minWidth: 320,
        minHeight: 240,
        title: tab.state.title || url,
        webPreferences: {
          partition: tab.partition,
          sandbox: true,
          contextIsolation: true,
          nodeIntegration: false,
        },
      })
      win.webContents.setWindowOpenHandler((details) => {
        if (/^https?:\/\//i.test(details.url)) void win.webContents.loadURL(details.url)
        return { action: 'deny' }
      })
      void win.loadURL(url)
      return true
    },

    async clearCookies(): Promise<BrowserClearResult> {
      try {
        await ensureSession().clearStorageData({
          storages: ['cookies', 'localstorage', 'indexdb', 'serviceworkers'],
        })
        return { ok: true }
      } catch (error) {
        return { ok: false, message: error instanceof Error ? error.message : 'Could not clear cookies.' }
      }
    },

    async clearCache(): Promise<BrowserClearResult> {
      try {
        await ensureSession().clearCache()
        return { ok: true }
      } catch (error) {
        return { ok: false, message: error instanceof Error ? error.message : 'Could not clear the cache.' }
      }
    },

    /** The one route from the pane to the system browser: the explicit action. */
    openExternal(tabId: string): { ok: true } | { ok: false; message: string } {
      const tab = requireTab(tabId)
      if (!tab) return { ok: false, message: 'This browser tab is gone.' }
      const safe = safeExternalUrl(tab.state.url)
      if (!safe.ok) return safe
      void shell.openExternal(safe.url)
      return { ok: true }
    },

    /**
     * Dev servers this workspace's terminals are running: listening TCP ports
     * whose owning process descends from one of the workspace's ptys, kept
     * only if they answer HTTP. Polled by the browser tab's empty state, so
     * the cost (a `ps`, an `lsof` or on Linux a read of `/proc`, a HEAD per
     * port) is paid only while a person is looking at it.
     */
    async listLocalServers(workspaceId: string): Promise<LocalServer[]> {
      const platform = deps.platform ?? process.platform
      if (platform !== 'darwin' && platform !== 'linux') return []
      const roots = deps.listTerminalRoots().filter((root) => root.workspaceId === workspaceId)
      if (roots.length === 0) return []
      const runPs = deps.runPs ?? (() => execFileTextOrNull('ps', ['-axo', 'pid=,ppid=,pcpu=,args=']))
      const psOut = await runPs()
      if (psOut === null) return []
      const procs = parsePsTree(psOut)
      const ownedByRoot = roots.map((root) => ({ root, owned: descendantPids(root.rootPid, procs) }))
      const candidatePids = [...new Set(ownedByRoot.flatMap(({ owned }) => [...owned]))]
      if (candidatePids.length === 0) return []
      // `-a -p <pids>` scopes lsof to the terminals' own subtrees: a full
      // `-iTCP` walk of every process on the machine takes seconds on macOS.
      const runLsof =
        deps.runLsofListening ??
        (() =>
          execFileTextOrNull('lsof', [
            '-nP',
            '-iTCP',
            '-sTCP:LISTEN',
            '-a',
            '-p',
            candidatePids.join(','),
            '-F',
            'pcn',
          ]))
      const lsofOut = await runLsof()
      let sockets: { pid: number; command: string; port: number }[]
      if (lsofOut !== null) {
        sockets = parseListeningSockets(lsofOut)
      } else if (platform === 'linux') {
        // A slim image or a container often ships no `lsof`, and Linux can say
        // the same from `/proc` (also the answer when lsof ran and found
        // nothing, since it exits 1 for that). The command is the program's
        // name, as lsof's own column gives it.
        const readProc = deps.listProcListeners ?? ((pids: readonly number[]) => listProcListeners(pids))
        const commands = new Map(procs.map((proc) => [proc.pid, programName(proc.command)]))
        sockets = (await readProc(candidatePids)).map(({ pid, port }) => ({
          pid,
          port,
          command: commands.get(pid) ?? '',
        }))
      } else {
        return []
      }
      const byPort = new Map<number, LocalServer>()
      for (const { root, owned } of ownedByRoot) {
        for (const socket of sockets) {
          if (!owned.has(socket.pid) || byPort.has(socket.port)) continue
          byPort.set(socket.port, {
            url: `http://localhost:${socket.port}/`,
            port: socket.port,
            pid: socket.pid,
            command: socket.command,
            sessionId: root.sessionId,
            terminalId: root.terminalId,
          })
        }
      }
      const probe = deps.probeServer ?? ((url: string) => probeLocalServer(ensureSession(), url))
      const candidates = [...byPort.values()].sort((a, b) => a.port - b.port)
      const answers = await Promise.all(candidates.map((server) => probe(server.url)))
      return candidates.filter((_server, index) => answers[index])
    },

    /** For tests and shutdown. */
    disposeAll(): void {
      const ids = [...tabs.keys()]
      for (const tab of tabs.values()) {
        if (tab.controllerTimer) clearTimeout(tab.controllerTimer)
        tab.dispose()
      }
      tabs.clear()
      activeTabByWorkspace.clear()
      agentAssignments.clear()
      for (const tabId of ids) for (const listener of unregisterListeners) listener(tabId)
    },
  }
}

export type BrowserManager = ReturnType<typeof createBrowserManager>
