import {
  authorizeStudioAccess,
  studioAccessFor,
  studioPrincipal,
  type StudioAccess,
  type StudioPermission,
  type StudioPrincipal,
} from '../../packages/studio-protocol/src/permissions'
import type { ServerIpcChannelName } from './ipc-channel-owners'
import {
  WEB_BROWSE_FOLDERS_CHANNEL,
  WEB_DEVICES_APPROVE_CHANNEL,
  WEB_DEVICES_DECLINE_CHANNEL,
  WEB_DEVICES_LINK_CHANNEL,
  WEB_DEVICES_RENAME_CHANNEL,
  WEB_DEVICES_REVOKE_CHANNEL,
  WEB_DEVICES_STATUS_CHANNEL,
  WEB_EMBEDS_CREATE_CHANNEL,
  WEB_EMBEDS_LIST_CHANNEL,
  WEB_EMBEDS_REVOKE_CHANNEL,
  WEB_PREVIEWS_CLOSE_CHANNEL,
  WEB_PREVIEWS_LIST_CHANNEL,
  WEB_PREVIEWS_OPEN_CHANNEL,
  type WebTunnelChannelName,
} from './web-client'

// What a browser tab may reach over its tunnel (phase 9 spec, 14.8), channel
// by channel, in the permissions every remote method declares
// (packages/studio-protocol/src/permissions.ts).
//
// The tunnel is an owner's: a tab of a browser the owner paired drives the
// domains the web client draws, and nothing that acts beyond this server.
// Pairing apps and other machines, the tailnet's administration, and setting
// or clearing provider keys or the GitHub token stay with the desktop app;
// their reads that the web client shows (whether a key is set) do not. Two
// kinds of credential an owner's tab does hand out, as the owner it is: an
// MCP endpoint's bearer token for a client on this machine
// (`automation:mcp-http-create`), and the browsers and embeds it pairs
// (`web:devices:*`, `web:embeds:*`), each under `access:write`.
//
// Typed over every channel the server owns and the front door's own, so a
// channel added to either does not compile until it says here what it needs
// or that it is the desktop app's alone. A name in neither table is refused.
// The renderer routes only the channels this allows to the tunnel, and the
// server refuses any other there (`web-tunnel-guard.ts`), so the rule is held
// on both sides from this one table.

const owner = (...permissions: StudioPermission[]): StudioAccess => ({ permissions, owner: true })
const desktopOnly = (reason: string): StudioAccess => ({ localOnly: reason })

const READ_CHAT = owner('conversation:read')
const DRIVE_CHAT = owner('conversation:read', 'conversation:operate')

const ACCESS_ADMIN =
  'Who may reach this machine (paired apps, other machines, the tailnet) is administered in the desktop app.'
const CREDENTIALS = 'A provider key or the GitHub token is set and cleared in the desktop app.'
const TERMINAL = 'It opens a terminal, and there are none on the web.'
const WINDOW_STATE = 'Only a desktop window can say it: a tab would report defaults and blanks.'
const BEYOND = 'It acts beyond this server, on another machine or account.'
const MODULES = 'A browser tab loads no module, so it has no module to speak for.'
const DESKTOP = 'It is served to the desktop app only.'

export const WEB_TUNNEL_ACCESS: { readonly [C in ServerIpcChannelName | WebTunnelChannelName]: StudioAccess } = {
  'automation:get-status': owner('workspace:read'),
  'automation:mcp-http-create': owner('access:write'),
  'automation:mcp-http-revoke': owner('access:write'),
  'automation:mcp-http-status': owner('access:read'),
  'backlog:add-or-update-link': owner('backlog:operate'),
  'backlog:create-epic': owner('backlog:operate'),
  'backlog:ensure-item-ids': owner('backlog:operate'),
  'backlog:ensure-object-records': owner('backlog:operate'),
  'backlog:move-object-source': owner('backlog:operate'),
  'backlog:remove-link': owner('backlog:operate'),
  'backlog:remove-object-record': owner('backlog:operate'),
  'backlog:resolve-location': owner('backlog:read'),
  'backlog:set-root': owner('backlog:operate'),
  'backlog:update-dependencies': owner('backlog:operate'),
  'backlog:update-epic': owner('backlog:operate'),
  'backlog:update-epic-color': owner('backlog:operate'),
  'backlog:update-highlight': owner('backlog:operate'),
  'backlog:update-mockups': owner('backlog:operate'),
  'backlog:update-module-metadata': owner('backlog:operate'),
  'backlog:update-status': owner('backlog:operate'),
  'backlog:update-triage': owner('backlog:operate'),
  'cli-models:discover': owner('providers:read'),
  'conversation-commands:list': owner('conversation:read'),
  'conversation-import:import': desktopOnly(DESKTOP),
  'conversation-import:scan': desktopOnly(DESKTOP),
  'conversation:approval-rules:list': READ_CHAT,
  'conversation:approval-rules:revoke': DRIVE_CHAT,
  'conversation:attachment': READ_CHAT,
  'conversation:delete': DRIVE_CHAT,
  'conversation:events:subscribe': READ_CHAT,
  'conversation:events:unsubscribe': READ_CHAT,
  'conversation:handoff': DRIVE_CHAT,
  'conversation:plan-document': READ_CHAT,
  'conversation:providers:list': owner('providers:read'),
  'conversation:providers:models': owner('providers:read'),
  'conversation:providers:sign-in': desktopOnly(TERMINAL),
  'conversation:rename': DRIVE_CHAT,
  'conversation:search': READ_CHAT,
  'conversation:search:cancel': READ_CHAT,
  'conversation:secrets:clear': desktopOnly(CREDENTIALS),
  'conversation:secrets:set': desktopOnly(CREDENTIALS),
  'conversation:secrets:status': owner('providers:read'),
  'conversation:session:earlier': READ_CHAT,
  'conversation:session:subscribe': READ_CHAT,
  'conversation:session:unsubscribe': READ_CHAT,
  'conversation:sessions:interrupt': DRIVE_CHAT,
  'conversation:sessions:list': READ_CHAT,
  'conversation:sessions:respond-to-request': DRIVE_CHAT,
  'conversation:sessions:send-turn': DRIVE_CHAT,
  'conversation:sessions:set-model': DRIVE_CHAT,
  'conversation:sessions:mcp-action': DRIVE_CHAT,
  'conversation:sessions:stop-subagent': DRIVE_CHAT,
  'conversation:sessions:side-question': DRIVE_CHAT,
  'conversation:sessions:cancel-side-question': READ_CHAT,
  'conversation:sessions:context-breakdown': READ_CHAT,
  'conversation:sessions:set-permission': DRIVE_CHAT,
  'conversation:sessions:start': DRIVE_CHAT,
  'conversation:sessions:stop': DRIVE_CHAT,
  'conversation:sessions:suspend': DRIVE_CHAT,
  'conversation:sessions:terminal-handoff': desktopOnly(TERMINAL),
  'conversation:threads': READ_CHAT,
  'conversation:tool-detail': READ_CHAT,
  'conversation:transcript': READ_CHAT,
  'conversation:turn:diff': READ_CHAT,
  'conversation:turn:fork': owner('conversation:create'),
  'conversation:turn:revert': DRIVE_CHAT,
  'conversation:turn:rewind': DRIVE_CHAT,
  'credential:secrets:clear': desktopOnly(CREDENTIALS),
  'credential:secrets:set': desktopOnly(CREDENTIALS),
  'credential:secrets:status': owner('providers:read'),
  'github:clear-token': desktopOnly(CREDENTIALS),
  'github:clone': desktopOnly(BEYOND),
  'github:clone-cancel': desktopOnly(BEYOND),
  'github:list-owners': desktopOnly(BEYOND),
  'github:list-repos': owner('workspace:read'),
  'github:new-project': desktopOnly(BEYOND),
  'github:set-token': desktopOnly(CREDENTIALS),
  'github:token-status': owner('workspace:read'),
  'hosts:home': owner('workspace:read'),
  'hosts:list': owner('workspace:read'),
  'launch-settings:get': owner('workspace:read'),
  'launch-settings:migrate': owner('settings:write'),
  'launch-settings:update': owner('settings:write'),
  'mesh:browse': desktopOnly(BEYOND),
  'mesh:cancel-pairing': desktopOnly(BEYOND),
  'mesh:check-reachability': desktopOnly(BEYOND),
  'mesh:conversation-cancel-side-question': desktopOnly(BEYOND),
  'mesh:conversation-command': desktopOnly(BEYOND),
  'mesh:conversation-context-breakdown': desktopOnly(BEYOND),
  'mesh:conversation-commands': desktopOnly(BEYOND),
  'mesh:conversation-earlier': desktopOnly(BEYOND),
  'mesh:conversation-file-search': desktopOnly(BEYOND),
  'mesh:conversation-follow': desktopOnly(BEYOND),
  'mesh:conversation-list': desktopOnly(BEYOND),
  'mesh:conversation-pull-request-create': desktopOnly(BEYOND),
  'mesh:conversation-pull-request-draft': desktopOnly(BEYOND),
  'mesh:conversation-pull-request-draft-cancel': desktopOnly(BEYOND),
  'mesh:conversation-pull-request-push': desktopOnly(BEYOND),
  'mesh:conversation-pull-request-state': desktopOnly(BEYOND),
  'mesh:conversation-send': desktopOnly(BEYOND),
  'mesh:conversation-side-question': desktopOnly(BEYOND),
  'mesh:conversation-tool-detail': desktopOnly(BEYOND),
  'mesh:conversation-tool-image': desktopOnly(BEYOND),
  'mesh:conversation-attachment': desktopOnly(BEYOND),
  'mesh:conversation-turn-diff': desktopOnly(BEYOND),
  'mesh:conversation-unfollow': desktopOnly(BEYOND),
  'mesh:change-conversation': desktopOnly(BEYOND),
  'mesh:conversation-delete-plan': desktopOnly(BEYOND),
  'mesh:conversation-search': desktopOnly(BEYOND),
  'mesh:approval-rules': desktopOnly(BEYOND),
  'mesh:revoke-approval-rule': desktopOnly(BEYOND),
  'mesh:scheduled-agents': desktopOnly(BEYOND),
  'mesh:scheduled-agent-action': desktopOnly(BEYOND),
  'mesh:update-scheduled-agent': desktopOnly(BEYOND),
  'mesh:create-scheduled-agent': desktopOnly(BEYOND),
  'mesh:create-conversation': desktopOnly(BEYOND),
  'mesh:forget': desktopOnly(BEYOND),
  'mesh:get-live-state': desktopOnly(BEYOND),
  'mesh:list-connections': desktopOnly(BEYOND),
  'mesh:pair': desktopOnly(BEYOND),
  'mesh:request-pairing': desktopOnly(BEYOND),
  'mesh:settle-conversation': desktopOnly(BEYOND),
  'mesh:visit-conversation': desktopOnly(BEYOND),
  'mesh:workspace-checkout': desktopOnly(BEYOND),
  'mesh:workspace-extensions': desktopOnly(BEYOND),
  'modules:bridge:invoke': desktopOnly(MODULES),
  'modules:host-service:invoke': desktopOnly(MODULES),
  'modules:notifications:recent': desktopOnly(MODULES),
  'scheduled-agents:create': desktopOnly(DESKTOP),
  'scheduled-agents:list': owner('workspace:read'),
  'scheduled-agents:mark-seen': owner('workspace:operate'),
  'scheduled-agents:pause': desktopOnly(DESKTOP),
  'scheduled-agents:pause-all': desktopOnly(DESKTOP),
  'scheduled-agents:pause-state': owner('workspace:read'),
  'scheduled-agents:remove': desktopOnly(DESKTOP),
  'scheduled-agents:resume': desktopOnly(DESKTOP),
  'scheduled-agents:resume-all': desktopOnly(DESKTOP),
  'scheduled-agents:run-now': desktopOnly(DESKTOP),
  'scheduled-agents:update': desktopOnly(DESKTOP),
  'scheduled-messages:get': desktopOnly(DESKTOP),
  'scheduled-messages:hold': desktopOnly(DESKTOP),
  'scheduled-messages:update': desktopOnly(DESKTOP),
  'studio-local-apps:cancel-offer': desktopOnly(ACCESS_ADMIN),
  'studio-local-apps:offer': desktopOnly(ACCESS_ADMIN),
  'studio-local-apps:revoke': desktopOnly(ACCESS_ADMIN),
  'studio-local-apps:set-reach': desktopOnly(ACCESS_ADMIN),
  'studio-local-apps:status': desktopOnly(ACCESS_ADMIN),
  'tailnet:approve-pair-request': desktopOnly(ACCESS_ADMIN),
  'tailnet:cancel-pairing': desktopOnly(ACCESS_ADMIN),
  'tailnet:deny-pair-request': desktopOnly(ACCESS_ADMIN),
  'tailnet:forget-machine': desktopOnly(ACCESS_ADMIN),
  'tailnet:get-live-state': desktopOnly(ACCESS_ADMIN),
  'tailnet:get-status': desktopOnly(ACCESS_ADMIN),
  'tailnet:list-peers': desktopOnly(ACCESS_ADMIN),
  'tailnet:offer-pairing': desktopOnly(ACCESS_ADMIN),
  'tailnet:revoke-device': desktopOnly(ACCESS_ADMIN),
  'tailnet:set-enabled': desktopOnly(ACCESS_ADMIN),
  'tailnet:set-https': desktopOnly(ACCESS_ADMIN),
  'tailnet:share-port': desktopOnly(ACCESS_ADMIN),
  'tailnet:share-status': desktopOnly(ACCESS_ADMIN),
  'tailnet:unshare-port': desktopOnly(ACCESS_ADMIN),
  'tailnet:update-device-scopes': desktopOnly(ACCESS_ADMIN),
  'text-generation:set-settings': desktopOnly(DESKTOP),
  'usage-limit-resumes:get': desktopOnly(DESKTOP),
  'usage-limit-resumes:update': desktopOnly(DESKTOP),
  'usage-limits:get': desktopOnly(DESKTOP),
  'usage:report': desktopOnly(DESKTOP),
  'workspace-backup:read': owner('workspace:read'),
  'workspace-backup:write': owner('workspace:operate'),
  'workspace-registry:hydrate': owner('workspace:operate'),
  'workspace-registry:needs-hydration': owner('workspace:read'),
  'workspace-sync:dispatch': owner('workspace:operate'),
  'workspace-sync:get-events-after': owner('workspace:read'),
  'workspace-sync:get-snapshot': owner('workspace:read'),
  'workspace-sync:lifecycle': owner('workspace:operate'),
  'workspace-sync:mark-unread': owner('workspace:operate'),
  'workspace-sync:set-module-run-states': desktopOnly(WINDOW_STATE),
  'workspace-sync:set-settled-chats-settings': desktopOnly(WINDOW_STATE),
  // The front door's own channels.
  [WEB_BROWSE_FOLDERS_CHANNEL]: owner('filesystem:read'),
  [WEB_PREVIEWS_LIST_CHANNEL]: owner('workspace:read'),
  [WEB_PREVIEWS_OPEN_CHANNEL]: owner('preview:operate'),
  [WEB_PREVIEWS_CLOSE_CHANNEL]: owner('preview:operate'),
  // An embed lets another page frame a conversation: it is access to this machine.
  [WEB_EMBEDS_CREATE_CHANNEL]: owner('access:write'),
  [WEB_EMBEDS_LIST_CHANNEL]: owner('access:read'),
  [WEB_EMBEDS_REVOKE_CHANNEL]: owner('access:write'),
  [WEB_DEVICES_STATUS_CHANNEL]: owner('access:read'),
  [WEB_DEVICES_REVOKE_CHANNEL]: owner('access:write'),
  [WEB_DEVICES_RENAME_CHANNEL]: owner('access:write'),
  [WEB_DEVICES_LINK_CHANNEL]: owner('access:write'),
  [WEB_DEVICES_APPROVE_CHANNEL]: owner('access:write'),
  [WEB_DEVICES_DECLINE_CHANNEL]: owner('access:write'),
}

/**
 * The front door's HTTP routes beside the tunnel that a session opens, judged
 * by the same principal: staging a picture or a file for a message the
 * owner's composer will send.
 */
export const WEB_HTTP_ACCESS = {
  upload: owner('conversation:read', 'conversation:operate'),
} as const satisfies Readonly<Record<string, StudioAccess>>

/**
 * What an owner's browser holds on its tunnel: the permissions the channels
 * above name, listed rather than derived, so a channel that comes to need one
 * no tab held before is refused until it is given here on purpose. No
 * terminal, no upkeep of this machine, and no tools of its own.
 */
export const WEB_OWNER_TUNNEL_PERMISSIONS: readonly StudioPermission[] = [
  'conversation:read',
  'conversation:operate',
  'conversation:create',
  'workspace:read',
  'workspace:operate',
  'backlog:read',
  'backlog:operate',
  'providers:read',
  'filesystem:read',
  'settings:write',
  'preview:operate',
  'access:read',
  'access:write',
]

/** The principal a browser is on its tunnel: an owner's holds the list above; anyone else's, nothing. */
export function webTunnelPrincipal(session: { owner: boolean }): StudioPrincipal {
  return studioPrincipal({ owner: session.owner, permissions: session.owner ? WEB_OWNER_TUNNEL_PERMISSIONS : [] })
}

const OWNER_TAB = webTunnelPrincipal({ owner: true })

/** Whether an owner's web tab may use a tunnel channel: what the renderer routes there. */
export function webTunnelAllows(channel: string): boolean {
  return webTunnelAuthorizes(OWNER_TAB, channel)
}

/** Whether a browser may use a tunnel channel: the one decision, from the table above. */
export function webTunnelAuthorizes(principal: StudioPrincipal, channel: string): boolean {
  return authorizeStudioAccess(principal, studioAccessFor(WEB_TUNNEL_ACCESS, channel)).ok
}
