// Where a spawned agent stands, as its lane and the Agents panel show it: the
// glyph beside it and the words that say working, done, failed or stopped.

import { createContext, useContext, type JSX } from 'react'
import { AgentGlyph, TruncatedText, WorkingMark, type AgentGlyphState } from '../../ui'
import { useWorkspaceStore } from '../../../store/workspaceStore'
import { openAgentsPane } from '../../workspace/pane/agents/agentsPaneFocus'
import { useConversationLinkContext } from './conversationLinks'
import type { TranscriptToolEntry } from './conversationProjection'
import { flattenToolEntries, subagentLaneLabel, toolObject } from './conversationTimeline'
import { LiveElapsed } from './liveElapsed'
import { formatStepDuration } from './stepDuration'
import { subagentResultPreview, subagentRunsOn } from './subagentResult'
import { ToolKindGlyph } from './toolRows/ToolKindGlyph'
import { formatTokenCount } from '../../../utils/tokenFormat'

/** The glyph state of the agent a lane spawned. */
export function laneAgentState(tool: TranscriptToolEntry): AgentGlyphState {
  if (tool.status === 'running') return 'working'
  if (tool.agent?.state === 'failed' || tool.outputStatus === 'error') return 'failed'
  if (tool.agent?.state === 'stopped' || tool.outputStatus === 'stopped' || tool.outputStatus === 'declined')
    return 'stopped'
  if (tool.agent?.state === 'unknown') return 'unknown'
  return 'done'
}

/**
 * What the agent was sent to do: the spawning call's summary, else the short
 * description the call gave it (the model writes one for every agent), else
 * the one the agent reported when it started.
 */
export function laneTask(tool: TranscriptToolEntry): string {
  const summary = toolObject(tool)
  if (summary) return summary
  const input = tool.input
  const described =
    input && typeof input === 'object' && !Array.isArray(input) && typeof input.description === 'string'
      ? input.description.trim()
      : ''
  return described || tool.agent?.description || ''
}

/** How long the agent ran: from its spawn to its end, or what it reported. */
export function laneDurationMs(tool: TranscriptToolEntry): number | undefined {
  if (tool.startedAt !== undefined && tool.completedAt !== undefined)
    return Math.max(0, tool.completedAt - tool.startedAt)
  return tool.agent?.usage?.durationMs || undefined
}

/**
 * How a settled agent ended, in words: "Done in 1m 29s", "Failed after 9s",
 * "Stopped", or "Ran in the background" for one whose end was never recorded.
 * Undefined while it runs, when the caller shows the live elapsed time.
 */
export function laneOutcomeWords(tool: TranscriptToolEntry): string | undefined {
  const state = laneAgentState(tool)
  if (state === 'working') return undefined
  if (state === 'unknown') return 'Ran in the background'
  const duration = laneDurationMs(tool)
  const took = duration !== undefined ? formatStepDuration(duration) : undefined
  if (tool.outputStatus === 'declined') return 'Declined'
  if (state === 'failed') return took ? `Failed after ${took}` : 'Failed'
  if (state === 'stopped') return took ? `Stopped after ${took}` : 'Stopped'
  return took ? `Done in ${took}` : 'Done'
}

/**
 * The mark beside an agent: its character, or, with characters turned off in
 * Settings, the working mark while it runs and the agent kind glyph after.
 */
export function LaneGlyph({ tool, className }: { tool: TranscriptToolEntry; className?: string }): JSX.Element {
  const characters = useWorkspaceStore((state) => state.appSettings.appearance.agentCharacters)
  return <LaneMark tool={tool} characters={characters} className={className} />
}

export function LaneMark({
  tool,
  characters,
  className,
}: {
  tool: TranscriptToolEntry
  characters: boolean
  className?: string
}): JSX.Element {
  const state = laneAgentState(tool)
  if (characters) return <AgentGlyph agentId={tool.id} state={state} className={className} />
  if (state === 'working') return <WorkingMark label="Agent working" seed={tool.id} className={className} />
  const ink = state === 'failed' ? 'text-[color:var(--tone-error)]' : 'text-[color:var(--text-subtle)]'
  return (
    <span className={`flex shrink-0 ${ink} ${className ?? ''}`}>
      <ToolKindGlyph kind="subagent" />
    </span>
  )
}

// What each kind of agent is for, as the session's provider described them
// ('Explore' → "Fast agent specialized for exploring codebases…"). Provided
// by the chat around its timeline.
const SubagentTypesContext = createContext<Record<string, string>>({})
export const SubagentTypesProvider = SubagentTypesContext.Provider

// Stops one running agent of this chat by its lane, answering whether the chat
// took the stop (the lane itself ends when the agent reports it stopped). Null
// where a lane offers no Stop: a chat on another machine, a read-only view, a
// provider that can only stop the whole turn.
const SubagentStopContext = createContext<((laneId: string) => Promise<boolean>) | null>(null)
export const SubagentStopProvider = SubagentStopContext.Provider

export function useStopSubagent(): ((laneId: string) => Promise<boolean>) | null {
  return useContext(SubagentStopContext)
}

// Said for the agents every Claude session has, when the session has not (yet)
// described them itself.
const BUILT_IN_AGENT_TYPES: Record<string, string> = {
  Explore: 'A read-only helper that searches the code and reports back.',
  Plan: 'A read-only helper that works out an approach before anything changes.',
  'general-purpose': 'A helper that takes on part of the task in parallel, with the same tools as the main agent.',
}

/** What an agent of this type is for, in a sentence, when anything says. */
export function useSubagentTypeDescription(type: string | undefined): string | undefined {
  const described = useContext(SubagentTypesContext)
  if (!type) return undefined
  const text = described[type] ?? BUILT_IN_AGENT_TYPES[type]
  if (!text) return undefined
  // A provider's description is written for the model choosing an agent and
  // runs long; its first sentence says what the agent is.
  const sentence = /^[\s\S]*?[.!?](?=\s|$)/u.exec(text.trim())?.[0] ?? text.trim()
  return sentence.length > 180 ? `${sentence.slice(0, 179).trimEnd()}…` : sentence
}

export function formatTokens(count: number): string {
  return `${formatTokenCount(count)} tokens`
}

/**
 * The card an agent's glyph and name open on hover: which agent, how it is
 * doing, what it was sent to do, what kind of helper it is, and what it is
 * doing right now or why it ended.
 */
export function AgentCardContent({ tool, running }: { tool: TranscriptToolEntry; running: boolean }): JSX.Element {
  const description = useSubagentTypeDescription(tool.subagentType)
  const task = laneTask(tool)
  const outcome = laneOutcomeWords(tool)
  const now = tool.agent?.progressSummary ?? (tool.agent?.lastToolName ? `Using ${tool.agent.lastToolName}` : undefined)
  const steps = tool.agent?.usage?.toolUses ?? flattenToolEntries(tool.children ?? []).length
  const tokens = tool.agent?.usage?.totalTokens
  // What it was asked to run on leads, when the call set it: the lane's own
  // line says it only once the agent has finished.
  const footer = [
    subagentRunsOn(tool),
    steps ? `${steps} ${steps === 1 ? 'step' : 'steps'}` : null,
    tokens ? formatTokens(tokens) : null,
  ]
    .filter(Boolean)
    .join(' · ')
  return (
    <>
      <span className="block font-medium text-[color:var(--text-strong)]">
        {subagentLaneLabel(tool)} · {running ? 'Working' : outcome}
      </span>
      {task ? <span className="block text-[color:var(--text-default)]">{task}</span> : null}
      {description ? <span className="block">{description}</span> : null}
      {running && now ? <span className="block">Now: {now}</span> : null}
      {!running && tool.agent?.error ? (
        <span className="block text-[color:var(--tone-error)]">{tool.agent.error}</span>
      ) : null}
      {footer ? <span className="block text-[color:var(--text-subtle)]">{footer}</span> : null}
    </>
  )
}

/** How an agent is doing: working and for how long, or how it ended. */
export function LaneStatus({ lane }: { lane: TranscriptToolEntry }): JSX.Element {
  if (lane.status === 'running')
    return (
      <span className="text-[color:var(--accent-primary)]">
        Working{lane.startedAt !== undefined ? ' · ' : ''}
        {lane.startedAt !== undefined ? <LiveElapsed startedAt={lane.startedAt} /> : null}
      </span>
    )
  return (
    <span className={lane.outputStatus === 'error' ? 'text-[color:var(--tone-error)]' : undefined}>
      {laneOutcomeWords(lane)}
    </span>
  )
}

/**
 * One agent at a glance, as the chat's agent cards and the Agents tab's list
 * draw it: who it is and what it was sent to do, how it is doing, and under
 * that what it is doing now or the first line of what it found. The caller
 * supplies the pressable box around it.
 */
export function AgentLaneSummary({ lane }: { lane: TranscriptToolEntry }): JSX.Element {
  const running = lane.status === 'running'
  const task = laneTask(lane)
  const now = lane.agent?.progressSummary ?? (lane.agent?.lastToolName ? `Using ${lane.agent.lastToolName}` : '')
  const detail = running ? now : lane.agent?.error || subagentResultPreview(lane.output)
  // What the agent has spent so far, live while it works, under its status so
  // agents can be compared down the list, after the model and effort the call
  // set it to run on, which explain most of the difference.
  const tokens = lane.agent?.usage?.totalTokens
  const spend = [subagentRunsOn(lane), tokens ? formatTokens(tokens) : null].filter(Boolean).join(' · ')
  return (
    <span className="flex min-w-0 flex-1 flex-col gap-0.5">
      <span className="flex min-w-0 items-center gap-2 text-meta">
        <LaneGlyph tool={lane} />
        <span className={`shrink-0 ${running ? 'font-medium text-[color:var(--text-default)]' : ''}`}>
          {subagentLaneLabel(lane)}
        </span>
        {task ? <TruncatedText as="span" text={task} className="min-w-0 text-[color:var(--text-muted)]" /> : null}
        <span className="ml-auto shrink-0 pl-2 text-micro tabular-nums text-[color:var(--text-subtle)]">
          <LaneStatus lane={lane} />
        </span>
      </span>
      {detail || spend ? (
        <span className="flex min-w-0 items-center gap-2 pl-6 text-micro">
          {detail ? (
            <TruncatedText
              as="span"
              text={detail}
              className={`min-w-0 ${lane.agent?.error && !running ? 'text-[color:var(--tone-error)]' : 'text-[color:var(--text-subtle)]'}`}
            />
          ) : null}
          {spend ? (
            <span className="ml-auto shrink-0 pl-2 tabular-nums text-[color:var(--text-subtle)]">{spend}</span>
          ) : null}
        </span>
      ) : null}
    </span>
  )
}

/**
 * Opens this chat's Agents tab, on one agent when given its lane. A chat on
 * another machine is opened there too: its pane says it is open in this
 * workspace (`publishRemoteChat`), by its agent id on that machine, which is
 * the id its links carry, and the tab reads it through the pane's transport.
 */
export function useOpenAgentsPane(): ((laneId: string | null) => void) | null {
  const context = useConversationLinkContext()
  if (!context?.workspaceId || !context.agentId) return null
  const { workspaceId, agentId } = context
  return (laneId) => openAgentsPane(workspaceId, agentId, laneId)
}
