// What a web tab and the server's web front door agree on beyond the
// protocol: the tunnelled channels only a web tab uses, and their shapes.

import type { ServerIpcChannel } from './ipc-channel-owners'

/** The server-side folder browser that stands in for the native folder picker (phase 9 spec, 6.5). */
export const WEB_BROWSE_FOLDERS_CHANNEL = 'web:browse-folders'

/** Previews of an agent's dev server, each on an origin of its own (phase 9 spec, 3.6; R77). */
export const WEB_PREVIEWS_LIST_CHANNEL = 'web:previews:list'
export const WEB_PREVIEWS_OPEN_CHANNEL = 'web:previews:open'
export const WEB_PREVIEWS_CLOSE_CHANNEL = 'web:previews:close'
/** Pushed to a session's tabs: its open previews, whole, on every change. */
export const WEB_PREVIEWS_CHANGED_CHANNEL = 'web:previews:changed'

/** Embeds of one conversation, read-only, for another page to frame (phase 9 spec, 5.4; R58, R59). */
export const WEB_EMBEDS_CREATE_CHANNEL = 'web:embeds:create'
export const WEB_EMBEDS_LIST_CHANNEL = 'web:embeds:list'
export const WEB_EMBEDS_REVOKE_CHANNEL = 'web:embeds:revoke'

/** The browsers paired with this server, and the ones asking to be (phase 9 spec, 6.2). */
export const WEB_DEVICES_STATUS_CHANNEL = 'web:devices:status'
export const WEB_DEVICES_REVOKE_CHANNEL = 'web:devices:revoke'
export const WEB_DEVICES_RENAME_CHANNEL = 'web:devices:rename'
export const WEB_DEVICES_LINK_CHANNEL = 'web:devices:link'
export const WEB_DEVICES_APPROVE_CHANNEL = 'web:devices:approve'
export const WEB_DEVICES_DECLINE_CHANNEL = 'web:devices:decline'
/** Pushed to every owner tab when a browser is paired, removed, or asks. */
export const WEB_DEVICES_CHANGED_CHANNEL = 'web:devices:changed'

export type WebDevice = {
  id: string
  name: string
  route: 'loopback' | 'tailnet'
  createdAt: string
  expiresAt: string
  lastSeenAt: string | null
  /** The browser asking: the one whose Settings this is. */
  current: boolean
}

export type WebPairRequest = {
  requestId: string
  name: string
  route: 'loopback' | 'tailnet'
  createdAt: string
  expiresAt: string
}

export type WebDevicesStatus = { devices: WebDevice[]; requests: WebPairRequest[]; origins: string[] }

/** The channels the web front door adds to a tab's tunnel, beside the server's own (SERVER_IPC_CHANNELS). */
export const WEB_TUNNEL_CHANNELS: Readonly<Record<string, ServerIpcChannel>> = {
  [WEB_BROWSE_FOLDERS_CHANNEL]: { retry: 'once' },
  [WEB_PREVIEWS_LIST_CHANNEL]: { retry: 'once' },
  [WEB_PREVIEWS_OPEN_CHANNEL]: {},
  [WEB_PREVIEWS_CLOSE_CHANNEL]: {},
  [WEB_EMBEDS_CREATE_CHANNEL]: {},
  [WEB_EMBEDS_LIST_CHANNEL]: { retry: 'once' },
  [WEB_EMBEDS_REVOKE_CHANNEL]: {},
  [WEB_DEVICES_STATUS_CHANNEL]: { retry: 'once' },
  [WEB_DEVICES_REVOKE_CHANNEL]: {},
  [WEB_DEVICES_RENAME_CHANNEL]: {},
  [WEB_DEVICES_LINK_CHANNEL]: {},
  [WEB_DEVICES_APPROVE_CHANNEL]: {},
  [WEB_DEVICES_DECLINE_CHANNEL]: {},
}

/** A port an agent of the server listens on, offered for a preview. */
export type PreviewPort = { port: number; pid: number; command: string }

/** An open preview, as the tab that opened it sees it. */
export type PreviewSummary = { previewId: string; port: number; origin: string; openedAt: number; lastUsedAt: number }

export type PreviewOpenAnswer =
  { ok: true; previewId: string; origin: string; enterUrl: string } | { ok: false; message: string }

export type FolderBrowserEntry = { name: string; path: string; project: boolean; hint: 'not-a-project' | null }

export type FolderBrowserListing =
  | {
      ok: true
      path: string
      parent: string | null
      home: string
      entries: FolderBrowserEntry[]
      truncated: boolean
    }
  | { ok: false; message: string }

// What an owner's web tab may reach over its tunnel (phase 9 spec, 14.8): the
// domains the web client draws, and not the ones that act beyond this server
// or hand out credentials. Pairing local apps and other machines, the tailnet
// lane's administration, and setting or clearing provider keys and the GitHub
// token stay with the desktop app; their reads that the web client shows
// (whether a key is set) do not. The renderer routes only these channels to
// the tunnel, and the server refuses any other there, so the list is held on
// both sides.
const WEB_TUNNEL_DOMAINS = new Set([
  'automation',
  'backlog',
  'cli-models',
  'conversation-commands',
  'hosts',
  'launch-settings',
  'workspace-backup',
  'workspace-registry',
  'workspace-sync',
])
const WEB_TUNNEL_EXCLUDED = new Set([
  // A provider's key, set or cleared, and the CLI's own sign-in, which opens a terminal.
  'conversation:secrets:set',
  'conversation:secrets:clear',
  'conversation:providers:sign-in',
  // A chat handed to a terminal: there are none on the web (ruling a).
  'conversation:sessions:terminal-handoff',
])
const WEB_TUNNEL_SINGLE = new Set([
  'credential:secrets:status',
  'github:token-status',
  'github:list-repos',
  'scheduled-agents:list',
  'scheduled-agents:mark-seen',
  'scheduled-agents:pause-state',
])

/** Whether an owner's web tab may use a server-owned tunnel channel. */
export function webTunnelAllows(channel: string): boolean {
  if (Object.hasOwn(WEB_TUNNEL_CHANNELS, channel)) return true
  if (WEB_TUNNEL_SINGLE.has(channel)) return true
  const domain = channel.split(':')[0]
  if (domain === 'conversation') return !WEB_TUNNEL_EXCLUDED.has(channel)
  return WEB_TUNNEL_DOMAINS.has(domain)
}

/** The answer a web tab gets for a tunnel channel it may not use. */
export const WEB_TUNNEL_REFUSED = 'DesktopOnly'

// Which web bundle a page is (phase 9 spec, 3.5 and 14.11). The web build
// writes one id into every page it makes, as this meta; the server answers the
// id of the bundle it serves now in `/api/session`. A tab whose own id differs
// was loaded from a bundle the server no longer has: its next lazy chunk may
// be gone, so it offers a reload.
export const WEB_BUILD_META = 'sprintengine-web-build'

/** The build id a page carries, read from its HTML; null when it carries none. */
export function webBuildIdOf(html: string): string | null {
  const match = new RegExp(`<meta name="${WEB_BUILD_META}" content="([A-Za-z0-9._-]{1,80})"`, 'u').exec(html)
  return match ? match[1] : null
}
