import {
  CLI_PERMISSION_PRESETS,
  isLooserCliPermissionPreset,
  isMostPermissiveCliPermissionPreset,
  normalizeCliPermissionPreset,
  parseCliPermissionPreset,
  type CliPermissionPreset,
} from '../../shared/cli-permission-preset'
import type { McpConnectionContext } from '../../shared/modules/mcp-tools'

// What an agent whose own preset cannot be found or read is held to.
const STRICTEST_PRESET: CliPermissionPreset = CLI_PERMISSION_PRESETS[0]

// An agent can only start an agent with the permissions it has itself (owner
// ruling 2026-09-29). Without this, one gateway call — `agent.launch` with
// `permissionPreset: "bypass"` — lets an agent the person deliberately runs on
// `none` hand any prompt to a fresh agent that never asks, and a prompt
// injection in a README is enough to make that call.
//
// Only a connection that declared itself one of this app's agents is capped.
// The person's own scripts (no identity) and paired tailnet devices (a proven
// device identity, gated by their scopes) keep launching on any preset, as the
// person can from the launcher.
//
// The threat model is the agent, not the machine. The identity is declared by
// the bridge from the agent's environment, and anything that can open the
// socket could declare another agent's — but writing raw frames to a socket
// needs a shell, and an agent on `none` asks the person before it runs one. So
// a capped agent cannot shed its cap by tool calls alone, which is the path
// this closes; a connection that has declared an agent cannot re-declare
// itself as another one or as none at all (mcp-dispatch.ts).

/**
 * The preset an agent is running on right now, or null when no live session or
 * agent record names it.
 */
export type AgentPermissionResolver = (agent: { workspaceId?: string; agentId: string }) => CliPermissionPreset | null

export type LaunchPermissionRefusal = { code: 'permission_escalation'; message: string }

/**
 * The loosest preset a launch this connection asks for may run on, or null
 * when the connection is not capped. An agent that names itself and cannot be
 * found is capped at the strictest preset, `manual`: failing open there would
 * make "claim an id nobody holds" the way out of the cap.
 */
export function launchPermissionCeiling(
  context: McpConnectionContext | undefined,
  resolve: AgentPermissionResolver,
): CliPermissionPreset | null {
  const metadata = context?.metadata
  if (metadata?.kind !== 'studio-agent' || !metadata.agentId) return null
  return (
    resolve({ agentId: metadata.agentId, ...(metadata.workspaceId ? { workspaceId: metadata.workspaceId } : {}) }) ??
    STRICTEST_PRESET
  )
}

/**
 * The preset a gateway launch forwards under `ceiling`.
 *
 * A named preset at or below the ceiling goes through as named; a looser one
 * is refused rather than quietly lowered, so the caller learns its launch
 * would not have been what it asked for. An omitted preset is left to the
 * launch service, as before, when nothing could exceed the ceiling; otherwise
 * it is pinned to the ceiling, since the service's own default (the person's
 * choice for the CLI, else `auto`) could be looser than the caller.
 */
export function capLaunchPermissionPreset(
  requested: CliPermissionPreset | undefined,
  ceiling: CliPermissionPreset | null,
): { permissionPreset: CliPermissionPreset | undefined } | { refused: LaunchPermissionRefusal } {
  if (ceiling === null) return { permissionPreset: requested }
  if (requested === undefined) {
    return { permissionPreset: isMostPermissiveCliPermissionPreset(ceiling) ? undefined : ceiling }
  }
  if (isLooserCliPermissionPreset(requested, ceiling)) return { refused: escalation(requested, ceiling) }
  return { permissionPreset: requested }
}

/**
 * A scheduled agent's preset as an agent under `ceiling` may store it.
 *
 * A scheduled agent launches later, with nobody watching, so the preset it
 * stores is held to the same cap as a launch now. One that names no preset
 * runs on whatever the person chose for its CLI at run time, which may be
 * `bypass`; under a stricter ceiling it is given the ceiling explicitly.
 */
export function capScheduledAgentPreset(
  requested: CliPermissionPreset | null,
  ceiling: CliPermissionPreset | null,
): { permissionPreset: CliPermissionPreset | null } | { refused: LaunchPermissionRefusal } {
  if (ceiling === null || isMostPermissiveCliPermissionPreset(ceiling)) return { permissionPreset: requested }
  if (requested === null) return { permissionPreset: ceiling }
  if (isLooserCliPermissionPreset(requested, ceiling)) return { refused: escalation(requested, ceiling) }
  return { permissionPreset: requested }
}

/**
 * Whether an agent under `ceiling` may run a stored scheduled agent now:
 * refused when the run could launch looser than the caller. One that names no
 * preset follows the person's choice at run time, which the cap cannot see, so
 * it is treated as the loosest.
 */
export function refuseScheduledAgentRun(
  stored: CliPermissionPreset | null,
  ceiling: CliPermissionPreset | null,
): LaunchPermissionRefusal | null {
  if (ceiling === null || isMostPermissiveCliPermissionPreset(ceiling)) return null
  const effective = stored ?? 'bypass'
  return isLooserCliPermissionPreset(effective, ceiling) ? escalation(effective, ceiling) : null
}

/**
 * Whether an agent under `ceiling` may send a message to a chat running on
 * `target`: refused when the chat runs looser than the caller, since its next
 * turn would then carry out the caller's words with permissions the caller
 * does not have (conversation-chat-tools.ts).
 */
export function refuseDrivingLooserChat(
  target: CliPermissionPreset,
  ceiling: CliPermissionPreset | null,
): LaunchPermissionRefusal | null {
  if (ceiling === null || !isLooserCliPermissionPreset(target, ceiling)) return null
  return {
    code: 'permission_escalation',
    message:
      `This agent runs on the "${ceiling}" permission preset, and that chat runs on "${target}", which lets its ` +
      'agent do more without asking. An agent may only message chats that run at its level or stricter.',
  }
}

function escalation(requested: CliPermissionPreset, ceiling: CliPermissionPreset): LaunchPermissionRefusal {
  return {
    code: 'permission_escalation',
    message:
      `This agent runs on the "${ceiling}" permission preset, so it may only launch agents at that level or ` +
      `stricter; "${requested}" would give the new agent permissions its launcher does not have. Omit ` +
      `"permissionPreset" or pass "${ceiling}".`,
  }
}

/**
 * The live preset of the agent behind a gateway connection, from main's own
 * state.
 *
 * A running chat answers first: its preset can change mid-conversation, and
 * the runtime records a change only once the provider has applied it. Then a
 * live terminal that main launched, whose launch record is the preset rendered
 * into its command line. Last the agent's record in the workspace, which is
 * what a window spawned its terminal agent with — read as the window reads it,
 * so an old record with no preset is `auto`, the default it would start on
 * now. When one id matches more than one session, the strictest wins.
 */
export function createAgentPermissionResolver(deps: {
  listConversationSessions(agentId: string): ReadonlyArray<{
    workspaceId: string
    agentId: string
    status: string
    permissionPreset?: string
  }>
  listTerminalSessions(): ReadonlyArray<{
    kind?: string
    workspaceId?: string
    launchWorkspaceId?: string
    agentId?: string
    processAlive: boolean
    agentRecord?: { cliPermissionPreset?: unknown }
  }>
  readAgentRecordPreset(workspaceId: string, agentId: string): { found: false } | { found: true; preset: unknown }
}): AgentPermissionResolver {
  return ({ workspaceId, agentId }) => {
    // An agent id is only unique within its workspace: nearly every chat's
    // first agent is `agent-1`. With the caller's workspace known, only its own
    // sessions answer, so another chat's `agent-1` on `bypass` lends it
    // nothing and one on `none` does not hold it back. A connection that names
    // no workspace could be any of them, so it is held to the strictest.
    const sameWorkspace = (candidate: string | undefined): boolean => !workspaceId || candidate === workspaceId

    const chats = deps
      .listConversationSessions(agentId)
      .filter((session) => session.agentId === agentId && sameWorkspace(session.workspaceId))
      .filter((session) => session.status !== 'stopped')
    // A running chat that never chose a preset passes no override, which is
    // what `none` means.
    if (chats.length > 0)
      return strictest(
        chats.map((session) =>
          session.permissionPreset === undefined ? 'none' : parseCliPermissionPreset(session.permissionPreset),
        ),
      )

    // A terminal agent moved to another chat keeps its process, which goes on
    // naming the workspace it was launched in; its session and record have
    // moved to the other chat. Either workspace is its own.
    const terminals = deps
      .listTerminalSessions()
      .filter(
        (session) =>
          session.kind === 'agent' &&
          session.processAlive &&
          session.agentId === agentId &&
          (sameWorkspace(session.workspaceId) || sameWorkspace(session.launchWorkspaceId)),
      )
    const launched = terminals.filter((session) => session.agentRecord !== undefined)
    if (launched.length > 0) {
      return strictest(launched.map((session) => parseCliPermissionPreset(session.agentRecord?.cliPermissionPreset)))
    }

    if (!workspaceId) return null
    const record = deps.readAgentRecordPreset(workspaceId, agentId)
    if (record.found) return normalizeCliPermissionPreset(record.preset)
    const moved = terminals.flatMap((session) => {
      if (!session.workspaceId || session.workspaceId === workspaceId) return []
      const found = deps.readAgentRecordPreset(session.workspaceId, agentId)
      return found.found ? [normalizeCliPermissionPreset(found.preset)] : []
    })
    return moved.length > 0 ? strictest(moved) : null
  }
}

// Unreadable counts as the strictest preset: a session whose preset cannot be
// read is not evidence that it may do more.
function strictest(presets: ReadonlyArray<CliPermissionPreset | null>): CliPermissionPreset {
  let lowest: CliPermissionPreset | undefined
  for (const preset of presets) {
    const read = preset ?? STRICTEST_PRESET
    if (lowest === undefined || isLooserCliPermissionPreset(lowest, read)) lowest = read
  }
  return lowest ?? STRICTEST_PRESET
}
