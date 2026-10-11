import type { TailnetScope } from '../../../shared/tailnet'

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
  if (toolName.startsWith('worktree.')) {
    return `"${toolName}" hands the calling agent a worktree on this machine and holds it for that agent, and a paired device is not an agent. Run it from an agent on that machine.`
  }
  if (toolName.startsWith('terminal.')) {
    return `"${toolName}" reads the terminals on this machine, and terminals are not served over the tailnet. A paired device follows this machine's chats instead; run it from an agent on that machine.`
  }
  return null
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
