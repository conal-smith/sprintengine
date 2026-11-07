import type { ConversationClientMessage } from '../../../../packages/conversation-protocol/src/public'
import type { StudioAccess } from '../../../../packages/studio-protocol/src/permissions'
import type { McpConnectionContext, McpToolRegistration } from '../../../shared/modules/mcp-tools'
import type { TailnetScope } from '../../../shared/tailnet'

// What everything a paired device can ask of this machine requires, in the
// permissions every remote method declares
// (packages/studio-protocol/src/permissions.ts): the gateway's tools, its
// authenticated routes, and the frames of the conversation lane. A device's
// scopes are translated to permissions where it asks
// (`tailnetDevicePrincipal`, src/shared/tailnet.ts), and the gateway judges
// every one of these with the same `authorizeStudioAccess`.
//
// Tools are a rule rather than a table, because they are registered at run
// time (modules and client tools add their own): the family comes from the
// name and read-or-operate from the gateway's own mutation classification. A
// tool name nobody registered is refused by the dispatcher before this is
// asked.

/**
 * Every route a paired device's token opens, and what it needs. Pairing and
 * health come before a token and are not here; a path not listed is not
 * found. `mcp` and `stream` carry tools, each judged by `tailnetToolAccess`;
 * `events` says only that something changed, and what a device may then read
 * is decided by what it reads with.
 */
export const TAILNET_ROUTE_ACCESS = {
  identity: { permissions: [] },
  'ws-ticket': { permissions: [] },
  mcp: { permissions: [] },
  stream: { permissions: [] },
  events: { permissions: [] },
  // Following a chat: the lane's frames are judged one by one below.
  conversation: { permissions: ['conversation:read'] },
  'conversation-image': { permissions: ['conversation:read'] },
  // The composer's reads, in the chat's own folder.
  'conversation-files': { permissions: ['conversation:read'] },
  'conversation-commands': { permissions: ['conversation:read'] },
  // Asking again starts the chat's CLI, which is driving it.
  'conversation-commands:refresh': { permissions: ['conversation:read', 'conversation:operate'] },
  // A picture or file staged for a message the device will send.
  upload: { permissions: ['conversation:read', 'conversation:operate'] },
} as const satisfies Readonly<Record<string, StudioAccess>>

export type TailnetDeviceRoute = keyof typeof TAILNET_ROUTE_ACCESS
/** The routes a ticket opens as a WebSocket upgrade; every other route is an HTTP request. */
export type TailnetUpgradeRoute = Extract<TailnetDeviceRoute, 'stream' | 'events' | 'conversation'>
export type TailnetHttpRoute = Exclude<TailnetDeviceRoute, TailnetUpgradeRoute>

const FOLLOW: StudioAccess = { permissions: ['conversation:read'] }
const DRIVE: StudioAccess = { permissions: ['conversation:read', 'conversation:operate'] }

/**
 * Every frame a device sends on the conversation lane, and what it needs:
 * reading what a chat shows is following it; a command, and a side question
 * (which runs the chat's agent as a send does), drive it. Typed over the
 * lane's frames, so a frame added to the contract does not compile here
 * until it says what it needs.
 */
export const CONVERSATION_LANE_ACCESS: { readonly [T in ConversationClientMessage['type']]: StudioAccess } = {
  hello: FOLLOW,
  list: FOLLOW,
  subscribe: FOLLOW,
  loadEarlier: FOLLOW,
  getToolDetail: FOLLOW,
  getTurnDiff: FOLLOW,
  getContextBreakdown: FOLLOW,
  watchQueued: FOLLOW,
  watchScheduled: FOLLOW,
  watchUsageLimits: FOLLOW,
  watchSubagents: FOLLOW,
  // A device cancels only a question it asked itself.
  cancelSideQuestion: FOLLOW,
  askSideQuestion: DRIVE,
  command: DRIVE,
}

/** What a tool call over the tailnet needs: nothing a grant can give for a local-only tool, else its family's permission. */
export function tailnetToolAccess(toolName: string, isMutation: boolean): StudioAccess {
  const localOnly = localOnlyGatewayToolReason(toolName)
  if (localOnly) return { localOnly }
  return { permissions: [requiredScopeForTool(toolName, isMutation)] }
}

// Mapping the gateway's tool surface onto the shared scope vocabulary
// (src/shared/tailnet.ts). The vocabulary is shared because Settings shows it;
// this mapping is not, because it is about gateway tool NAMES, which only the
// gateway knows.

/**
 * Tools that start an agent in a terminal on this machine.
 *
 * Terminals stopped crossing the tailnet on 2026-09-29: a paired device can
 * neither watch nor type into one, so a terminal it started would be a process
 * it could not see, answer or stop. What a paired device starts is a chat
 * (`conversation.create`), which it can follow. These stay on the local
 * socket, where the agents that call them can see the
 * terminals they start. The rest of the `terminal.*` family is local-only by
 * its prefix, below.
 */
const TERMINAL_LAUNCH_TOOLS: ReadonlySet<string> = new Set(['terminal.create', 'agent.launch', 'backlog.work'])

/**
 * One chat's agent driving another chat here (conversation-chat-tools.ts). A
 * paired device follows and drives this machine's chats over its own
 * conversation lane, which has its own commands for the same, so these are
 * for the agents on this machine alone.
 */
const CHAT_TO_CHAT_TOOLS: ReadonlySet<string> = new Set([
  'conversation.send',
  'conversation.read',
  'conversation.wait',
  'conversation.interrupt',
  // A sub-agent belongs to a chat here, and only a chat here starts one.
  'subagent.start',
  'subagent.status',
  'subagent.cancel',
])

/**
 * Why a tool is served on the local socket only and never to a paired device,
 * whatever its scopes — or null for a tool the tailnet may serve.
 *
 * The `tailnet.*` family configures who may drive this machine. A device that
 * could call it could mint a pairing code granting scopes wider than its own,
 * and revoking the device it came in on would not take those away — one grant
 * manufacturing the next is not something a scope can express, so the family
 * sits outside the scope vocabulary entirely rather than behind a very wide one.
 * A prefix rule rather than a list: a tool added to the family later is
 * local-only by default, which is the direction a mistake here should fail.
 *
 * The terminal tools are the other kind: not dangerous to name in a grant,
 * just of no use to anyone who cannot see a terminal. The `terminal.*` family
 * is a prefix rule for the same reason the `tailnet.*` one is; the launchers
 * outside it are named.
 *
 * The `pull_request.*` family records a pull request as the calling agent's
 * conversation's, or watches one for it and wakes its chat, and a paired
 * device has no conversation to record it under or chat to wake.
 * The `local_server.*` family is the same, for a server the agent started.
 *
 * Publishing, changing or removing an artifact reads a page from this
 * machine's disk at a path the caller names and writes it to the person's
 * artifacts site with this machine's credentials, so a paired device could
 * use it to send any file it can name off the machine. Those three stay local;
 * `artifacts.setup` changes where this machine publishes and waits for the
 * person at it to confirm, so it stays local as well. `artifacts.list`,
 * `search` and `get` only read the site, and are served on the read scope
 * like any other read.
 *
 * The `visual.*` family draws an agent's markup, scripts and all, in a hidden
 * window on this machine; it is for an agent writing a reply here.
 *
 * The `extension.*` family makes an extension project in a folder on this
 * machine that the caller names, and teaches an agent about to work in it; a
 * paired device has neither the folder nor the agent.
 *
 * The `plugin.*` family finds a plugin and draws it as a card in the calling
 * agent's chat, for the person at this machine to install or not.
 */
export function localOnlyGatewayToolReason(toolName: string): string | null {
  if (toolName.startsWith('tailnet.')) {
    return `"${toolName}" configures who may drive this machine and is served only on its owner-only local socket, never over the tailnet. Run it from an agent on that machine.`
  }
  if (TERMINAL_LAUNCH_TOOLS.has(toolName)) {
    return `"${toolName}" starts an agent in a terminal on this machine, and terminals are not served over the tailnet. Start a chat agent with conversation.create instead, or run it from an agent on that machine.`
  }
  if (toolName.startsWith('pull_request.')) {
    return `"${toolName}" acts on a pull request as the calling agent's conversation's, and a paired device is not an agent. Run it from an agent on that machine.`
  }
  if (toolName.startsWith('local_server.')) {
    return `"${toolName}" records a local server as the calling agent's conversation's, and a paired device is not an agent. Run it from an agent on that machine.`
  }
  if (toolName === 'artifacts.setup') {
    return `"${toolName}" changes where this machine publishes, and asks the person at it to confirm; it is served only on its local socket. Run it from an agent on that machine.`
  }
  if (toolName === 'artifacts.publish' || toolName === 'artifacts.update' || toolName === 'artifacts.delete') {
    return `"${toolName}" publishes files from this machine's disk with its credentials, and is served only on its local socket. Run it from an agent on that machine.`
  }
  if (toolName.startsWith('extension.')) {
    return `"${toolName}" makes and explains an extension project on this machine's disk, for an agent working there. Run it from an agent on that machine.`
  }
  if (toolName.startsWith('plugin.')) {
    return `"${toolName}" offers the person at this machine a plugin to install, in the calling agent's chat, and a paired device is not an agent. Run it from an agent on that machine.`
  }
  if (toolName.startsWith('worktree.')) {
    return `"${toolName}" hands the calling agent a worktree on this machine and holds it for that agent, and a paired device is not an agent. Run it from an agent on that machine.`
  }
  if (CHAT_TO_CHAT_TOOLS.has(toolName)) {
    return `"${toolName}" lets an agent on this machine drive another chat here. A paired device follows and drives this machine's chats over its conversation lane instead.`
  }
  if (toolName.startsWith('visual.')) {
    return `"${toolName}" draws an agent's visual in a hidden window on this machine, for a reply it is writing here. Run it from an agent on that machine.`
  }
  if (toolName.startsWith('terminal.')) {
    return `"${toolName}" reads the terminals on this machine, and terminals are not served over the tailnet. A paired device follows this machine's chats instead; run it from an agent on that machine.`
  }
  return null
}

/**
 * Tools served to paired devices and left out of the local socket's list: the
 * other side of `localOnlyGatewayToolReason`. `usage.report` answers another
 * desktop's usage dashboard with counts by hashed session, which no agent
 * here has a use for, and every tool an agent is listed costs it context.
 * The chat management tools below answer a paired desktop's menus on a chat
 * here, which an agent here has its own ways to.
 */
const PAIRED_DEVICE_ONLY_TOOLS: ReadonlySet<string> = new Set([
  'usage.report',
  // ── A paired desktop's chat management ──
  'conversation.rename',
  'conversation.auto_compact',
  'conversation.pull_request_unwatch',
  'conversation.delete_plan',
  'conversation.delete',
  'conversation.search',
  'conversation.approval_rules',
  'conversation.approval_rule_revoke',
])

export function servedOnlyToPairedDevices(toolName: string): boolean {
  return PAIRED_DEVICE_ONLY_TOOLS.has(toolName)
}

/** The gateway's own tools as one caller is listed them: without those served only to paired devices, unless it is one. */
export function gatewayToolsForCaller(
  tools: McpToolRegistration[],
  context: McpConnectionContext | undefined,
): McpToolRegistration[] {
  if (context?.metadata.kind === 'remote-tailnet') return tools
  return tools.filter((tool) => !servedOnlyToPairedDevices(tool.name))
}

/**
 * The scope a tool call requires.
 *
 * Family comes from the tool's dot-namespace (the gateway's naming rule,
 * Decision 8); read-vs-operate comes from the gateway's own mutation
 * classification, so the two lists cannot drift — a tool newly classified as a
 * mutation immediately needs the operate grant here too.
 *
 * `workspace` is the deliberate catch-all for the app-wide families
 * (`workspace.*`, `agent.*`, `cli.*`, `module.*`, `marketplace.*`,
 * `schedule.*`, `editor.*`, `review_*`) and for any tool this mapping has not
 * been taught. `editor.open` and `editor.open_diff` change what is on the
 * person's screen, so they are mutations and need `workspace:operate`.
 * Unknown does not mean unrestricted: an unmapped mutation still requires
 * `workspace:operate`, so a device without it is refused rather than served.
 *
 * A local-only tool never reaches this function: it is refused first.
 */
export function requiredScopeForTool(toolName: string, isMutation: boolean): TailnetScope {
  if (toolName.startsWith('conversation.')) return isMutation ? 'conversation:operate' : 'conversation:read'
  return `${toolFamily(toolName)}:${isMutation ? 'operate' : 'read'}` as TailnetScope
}

function toolFamily(toolName: string): 'workspace' | 'backlog' {
  if (toolName.startsWith('backlog.')) return 'backlog'
  return 'workspace'
}
