import type { TranscriptEntry, TranscriptToolEntry } from './conversationProjection.js'
import { flattenToolEntries } from './conversationTimeline.js'
import { stepWentWrong } from './stepOutcome.js'
import { formatStepDuration } from './stepDuration.js'
import { proseShownToUser } from './shownProse.js'

// A turn's work rests folded behind one line, the turn now running included:
// the steps are how the reply was reached, and what is happening now is the
// working line's to say. Two things are never in it: the agents a turn sent
// off, which are cards of their own under it (`turnAgentLanes`), and whatever
// the agent made for the person to look at (`turnShownWork`), which a fold
// would hide from the one it was made for (owner ruling 2026-10-02).
export type TurnFold = { kind: 'turn-fold'; id: string; label: string }

type IntermediateText = { text: string; beforeToolUseId: string }

/**
 * A step whose result is for the person to look at, not for the agent to work
 * from: a picture it generated, or a plugin it offered them to install. A
 * picture it only read, or a screenshot it took to check its own work, is how
 * it got there and folds with the rest. A new kind of thing an agent shows (an
 * embedded page, a map) belongs here.
 */
export function stepShownToUser(tool: TranscriptToolEntry): boolean {
  if (tool.outputStatus === 'error') return false
  return tool.name === 'GenerateImage' || isPluginOffer(tool)
}

// The Studio MCP server's id (`STUDIO_MCP_SERVER_ID` in the app's
// product-identity.ts), spelled out because this package imports nothing of
// the app's.
const STUDIO_SERVER_ID = 'sprintengine-studio'

/**
 * Studio's `plugin.offer`, under any runtime's spelling of it:
 * `mcp__sprintengine-studio__plugin_offer`, `sprintengine-studio.plugin_offer`,
 * or `plugin_offer` with the server named beside it. Another server's tool of
 * the same name draws no card of ours.
 */
export function isPluginOffer(tool: Pick<TranscriptToolEntry, 'name' | 'serverName'>): boolean {
  const studio = tool.serverName === STUDIO_SERVER_ID || tool.name.includes(STUDIO_SERVER_ID)
  return studio && /(?:^|__|[./])plugin[._]offer$/u.test(tool.name)
}

export { proseShownToUser }

/** The agents a turn spawned, drawn as cards outside its fold. */
export function turnAgentLanes(tools: readonly TranscriptToolEntry[]): TranscriptToolEntry[] {
  return tools.filter((tool) => tool.subagentLane)
}

/** The turn's steps the fold holds: everything but its agents and what it showed. */
export function turnFoldedSteps(tools: readonly TranscriptToolEntry[]): TranscriptToolEntry[] {
  return tools.filter((tool) => !tool.subagentLane && !stepShownToUser(tool))
}

/** The prose between steps the fold holds: everything but what shows a picture. */
export function turnFoldedProse(parts: readonly IntermediateText[] | undefined): IntermediateText[] | undefined {
  return parts?.filter((part) => !proseShownToUser(part.text))
}

export type ShownWork =
  { kind: 'step'; id: string; tool: TranscriptToolEntry } | { kind: 'prose'; id: string; text: string }

/**
 * What the agent made for the person to see while it worked, drawn outside the
 * fold in the order it came: the pictures it generated, and the prose between
 * its steps that carries one.
 */
export function turnShownWork(
  tools: readonly TranscriptToolEntry[],
  parts: readonly IntermediateText[] | undefined,
): ShownWork[] {
  const shown: ShownWork[] = []
  for (const tool of tools) {
    parts?.forEach((part, index) => {
      if (part.beforeToolUseId === tool.id && proseShownToUser(part.text))
        shown.push({ kind: 'prose', id: `prose:${tool.id}:${index}`, text: part.text })
    })
    if (!tool.subagentLane && stepShownToUser(tool)) shown.push({ kind: 'step', id: tool.id, tool })
  }
  return shown
}

export function deriveTurnFold(
  entry: Extract<TranscriptEntry, { kind: 'assistant' }>,
  tools: TranscriptToolEntry[],
): TurnFold | null {
  const steps = turnFoldedSteps(tools)
  const rows =
    steps.length +
    (entry.reasoning.trim() ? 1 : 0) +
    (entry.reasoningSegments?.length ?? 0) +
    (turnFoldedProse(entry.intermediateText)?.length ?? 0)
  // Thinking alone is already one line that opens; folding it would only put a
  // second line in front of it.
  if (!steps.length && rows <= 1) return null
  // An entry without both ends has no honest duration; a missing start read as
  // 0 would claim the turn ran since 1970.
  const elapsedMs =
    entry.startedAt !== undefined && entry.completedAt !== undefined
      ? entry.completedAt - entry.startedAt
      : entry.durationMs
  const duration = elapsedMs === undefined ? '' : formatStepDuration(Math.max(0, elapsedMs))
  // A turn still running has the working line under it counting its time, so
  // its fold says only that it is working.
  const label =
    entry.status === 'streaming'
      ? 'Working'
      : entry.status === 'failed'
        ? duration
          ? `Failed after ${duration}`
          : 'Failed'
        : entry.status === 'interrupted'
          ? duration
            ? `You stopped after ${duration}`
            : 'You stopped'
          : duration
            ? `Worked for ${duration}`
            : 'Worked'
  return {
    kind: 'turn-fold',
    id: `fold:${entry.turnId}`,
    label: `${label}${steps.length ? ` · ${steps.length} ${steps.length === 1 ? 'step' : 'steps'}` : ''}`,
  }
}

/**
 * How many of the fold's steps went wrong, so a failure inside it still shows
 * on it. Apart from the label because it reads every step: the turn running
 * now is drawn on every token, and its steps change only when a step does.
 */
export function turnFoldFailures(tools: readonly TranscriptToolEntry[]): number {
  return flattenToolEntries(turnFoldedSteps(tools).filter((tool) => tool.status !== 'running')).filter(stepWentWrong)
    .length
}

/**
 * The turn that answers the latest message: the one a fork from the newest
 * reply starts from. A continuation turn (a background agent reporting after
 * its turn ended) has no message of its own, so it must not take that place.
 */
export function latestReplyTurnId(entries: readonly TranscriptEntry[]): string | undefined {
  let latest: string | undefined
  for (let index = entries.length - 1; index >= 0; index--) {
    const entry = entries[index]
    // A message still waiting for its reply leaves the previous reply open.
    if (entry.kind === 'user' && latest !== undefined) return latest
    if (entry.kind === 'assistant') latest = entry.turnId
  }
  return latest
}
