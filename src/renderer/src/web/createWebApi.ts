import { apiModules } from '../../../preload/api-surface'
import type { ClientCapability } from '../../../shared/client-capabilities'
import type { ElectronApi } from '../../../shared/electron-api'
import type { SprintEngineAuthState } from '../../../shared/ipc/account'
import type { OpenExternalResult } from '../../../shared/ipc/window'
import { browserPlatform } from './browserPlatform'
import { WEB_BROWSE_FOLDERS_CHANNEL, type FolderBrowserListing } from '../../../shared/web-client'
import { pickServerFolder } from './FolderBrowserDialog'
import { refuse } from './unsupported'
import { ipc } from './webIpcRouter'
import { randomId } from '../../../shared/random-id'
import { createWebStudioPorts } from './webStudioPorts'
import { uploadFilesToServer } from './webUploads'
import { webCanvasPaneApi } from './canvas/webCanvasPane'

// A web tab's `window.api` (phase 9 spec, 3.2): typed `ElectronApi`, with no
// casts, so the compiler names any member nobody decided about.
//
// - The members the preload builds from its api modules are the very same
//   modules. In the web build their IPC is the web router
//   (`webIpcRouter.ts`): a channel the server owns reaches it over the tab's
//   socket; any other channel is the browser's to answer or refuse
//   (`webShellIpc.ts`).
// - The shell members a browser can do itself are replaced below: the
//   clipboard and links act on the person's machine, never the server's
//   (decision R56); the chat rides the Studio protocol over the tab's own
//   socket.
// - The four values the preload computes from its process come from the
//   browser instead: `platform` is the browser's OS, which decides the Primary
//   modifier and the keyboard's labels.

const EXTERNAL_PROTOCOLS = new Set(['http:', 'https:', 'mailto:'])

/** Open a URL in a new browser tab: http, https and mailto, and nothing else. */
export function openExternalInBrowser(url: string): OpenExternalResult {
  let parsed: URL
  try {
    parsed = new URL(url)
  } catch {
    return { ok: false, message: 'That link is not a web address.' }
  }
  if (!EXTERNAL_PROTOCOLS.has(parsed.protocol)) {
    return { ok: false, message: `A browser tab does not open ${parsed.protocol} links.` }
  }
  window.open(parsed.toString(), '_blank', 'noopener,noreferrer')
  return { ok: true }
}

/** Copy text with the browser's clipboard, or, outside a secure context, the older copy command. */
export async function writeClipboardText(text: string): Promise<void> {
  if (window.isSecureContext && navigator.clipboard?.writeText) {
    await navigator.clipboard.writeText(text)
    return
  }
  const field = document.createElement('textarea')
  field.value = text
  field.setAttribute('readonly', '')
  field.style.position = 'fixed'
  field.style.opacity = '0'
  document.body.append(field)
  field.select()
  try {
    if (!document.execCommand('copy')) throw new Error('The browser did not copy the text.')
  } finally {
    field.remove()
  }
}

/** Open an attachment's bytes in a new tab, as the desktop opens it in the OS viewer. */
function openAttachmentBytes(input: { mediaType: string; dataBase64: string; name?: string }): void {
  const bytes = Uint8Array.from(atob(input.dataBase64), (char) => char.charCodeAt(0))
  const url = URL.createObjectURL(new Blob([bytes], { type: input.mediaType }))
  window.open(url, '_blank', 'noopener,noreferrer')
  setTimeout(() => URL.revokeObjectURL(url), 60_000)
}

/** The server's OS, which the server writes into the page it serves (web-listener.ts). */
function servedHostPlatform(): string {
  const value = document.querySelector('meta[name="sprintengine-host-platform"]')?.getAttribute('content')
  return value && /^[a-z0-9]{2,16}$/u.test(value) ? value : browserPlatform()
}

/** What a browser tab can do (phase 9 spec, 3.4): its preview pane, and the clipboard and notifications where the browser allows them. */
export function browserCapabilities(): ClientCapability[] {
  const secure = window.isSecureContext
  return [
    'previews',
    'file-uploads',
    ...(secure && navigator.clipboard ? (['os-clipboard'] as const) : []),
    ...(secure && 'Notification' in window ? (['os-notifications'] as const) : []),
  ]
}

function diagnosticsOnLoopback(): boolean {
  const loopback = ['127.0.0.1', 'localhost', '[::1]'].includes(window.location.hostname)
  return loopback && new URLSearchParams(window.location.search).get('diagnostics') === '1'
}

const SIGNED_OUT: SprintEngineAuthState = {
  authenticated: false,
  user: null,
  selectedOrganization: null,
  status: 'signed_out',
  message: null,
}

/**
 * The empty state of each shell feature a web tab does not have, for the
 * calls the app makes as it boots: no terminals (ruling a), no window to place
 * or menu to label, no shell caches, no account signed in. Typed, so a shape
 * the app reads cannot drift from what it gets.
 */
const browserEmptyStates = {
  terminalList: async () => [],
  terminalTakeUndeliveredPrompts: async () => [],
  setTerminalIdleSuspendMs: async () => undefined,
  setTerminalKeepRecentAliveCount: async () => undefined,
  setTerminalReapExempt: async () => undefined,
  getWindowState: async () => null,
  getWindowPlacement: async () => null,
  updateAppMenuAccelerators: async () => ({ ok: true as const }),
  authGetState: async () => SIGNED_OUT,
  listDesignSystemArrivals: async () => ({ bundles: [] }),
  cliVersionChecksSetEnabled: async () => ({ enabled: false }),
  cliVersionAdvisories: async () => ({ ok: false as const, message: 'Version checks run in the desktop app.' }),
  editorRevealClaim: async () => null,
  // The desktop's browser pane; a tab shows previews instead, and has no pane to note.
  browserNoteActive: async () => undefined,
  editorRevealListPending: async () => [],
  listFolderOpenTargets: async () => [],
  setBackgroundMode: async () => undefined,
  setTelemetryEnabled: async () => undefined,
  // The titles setting the server titles chats by is the desktop window's to
  // push: a tab's own settings start at the defaults, and its mount push would
  // overwrite a choice the person made on the desktop.
  setTextGenerationSettings: async () => undefined,
  // A browser tab has no quit to ask about, and no app to relaunch.
  restartApp: undefined,
  // Nor a file manager on the server's disk to open a module's folder in.
  revealThirdPartyModule: undefined,
  getQuitConfirmation: async () => null,
  setQuitConfirmation: async () => null,
  getAgentBrowserTools: async () => null,
  setAgentBrowserTools: async () => null,
  getAgentNotifications: async () => null,
  setAgentNotifications: async () => null,
  // Nor a machine of its own to keep awake: the desktop's agents are the desktop's.
  getKeepAwake: async () => null,
  setKeepAwake: async () => null,
  // Nor the desktop's disk and credentials to publish an artifact with.
  getArtifactsSettings: async () => null,
  setArtifactsSettings: async () => null,
  testArtifactsSettings: async () => null,
  // Third-party renderer modules are off on the web unless the owner turns
  // them on for this server (R61); bundled modules load from the bundle.
  listThirdPartyRendererEntries: async () => ({ entries: [], failures: {} }),
  // The shell's copies of module state, which a tab has no shell to keep.
  setModuleEnablement: async () => ({ ok: true }),
  setModuleRegistrySnapshot: async () => ({ ok: true }),
  // The tab's own console is its diagnostics log.
  logDiagnostic: async (input) => {
    console.info('[diagnostics]', input)
    return { ...input, id: randomId(), timestamp: new Date().toISOString() }
  },
} satisfies Partial<ElectronApi>

export function createWebApi(): ElectronApi {
  return {
    ...apiModules,
    platform: browserPlatform(),
    hostPlatform: servedHostPlatform(),
    clientCapabilities: browserCapabilities(),
    // SSH machines are the desktop's: it holds their sessions and asks their
    // questions, so a tab neither lists them nor offers them in New chat.
    sshMachinesEnabled: false,
    isDevelopment: import.meta.env.DEV,
    isDiagnosticsEnabled: diagnosticsOnLoopback(),
    diagnosticsGetIpcStats: () => ({ sampledAt: Date.now(), channels: [] }),

    // The chat over the Studio protocol, on the tab's own socket.
    studioChatTransport: 'studio',
    ...createWebStudioPorts(),

    // The Canvas pane, over the canvas service the tab runs in the page.
    ...webCanvasPaneApi(),

    // The person's machine, never the server's (R56).
    clipboardWriteText: (text) => writeClipboardText(text),
    clipboardReadText: () =>
      window.isSecureContext && navigator.clipboard?.readText
        ? navigator.clipboard.readText()
        : Promise.reject(refuse('clipboard:read-text')),
    openExternal: async (url) => openExternalInBrowser(url),
    openImageAttachment: async (input) => openAttachmentBytes(input),

    // A browser has no path for a dropped file; its bytes are what crosses.
    getPathForFile: () => '',
    uploadFiles: (files) => uploadFilesToServer(files),
    // The server's folders, in an in-app dialog, where the desktop shows the OS picker.
    openDir: (options) =>
      pickServerFolder(
        (input) => ipc.invoke(WEB_BROWSE_FOLDERS_CHANNEL, input) as Promise<FolderBrowserListing>,
        options?.defaultPath,
      ),

    // "New window" is a new tab on a window of its own (phase 9 spec, 4.1 #24).
    createWorkspaceWindow: async (input) => {
      const url = new URL(window.location.href)
      url.search = ''
      url.hash = ''
      url.searchParams.set('windowId', input.windowId)
      // `noopener` makes `open` answer null whether or not a tab opened.
      window.open(url.toString(), '_blank', 'noopener')
      return { ok: true, windowId: input.windowId }
    },

    // Nothing of a window to report to, or to dress.
    notifyBootComplete: () => undefined,
    reportBuildStamp: () => undefined,
    startupTimelineEnabled: false,
    reportStartupMark: () => undefined,
    setColorScheme: async () => undefined,
    setWindowMaterial: async () => undefined,
    ...browserEmptyStates,
  } satisfies ElectronApi
}
