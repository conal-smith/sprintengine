import React, { useCallback, useDeferredValue, useEffect, useMemo, useRef, useState } from 'react'
import { useWorkspaceStore } from '../../../../store/workspaceStore'
import { EmptyState, GhostButton, InlineNotice, PanelHeader, RowButton, Spinner } from '../../../ui'
import { useLocalChatBinding, type ChatBinding } from '../../../panels/agentChat/chatBinding'
import { ConversationLinkProvider } from '../../../panels/agentChat/conversationLinks'
import {
  projectConversation,
  type TranscriptEntry,
  type TranscriptToolEntry,
} from '../../../panels/agentChat/conversationProjection'
import { flattenToolEntries, subagentLaneLabel } from '../../../panels/agentChat/conversationTimeline'
import { useLiveRowMotion } from '../../../panels/agentChat/liveVisibility'
import { SubagentLaneResult } from '../../../panels/agentChat/subagentResult'
import {
  AgentLaneSummary,
  formatTokens,
  LaneGlyph,
  LaneStatus,
  laneTask,
  SubagentTypesProvider,
  useSubagentTypeDescription,
} from '../../../panels/agentChat/subagentStatus'
import { TimedProse, WorkTimeline } from '../../../panels/agentChat/timelineRows'
import { useChatViewActive } from '../../../panels/agentChat/chatViewActivity'
import { useConversationSession } from '../../../panels/agentChat/useConversationSession'
import { ConversationTransportProvider } from '../../../panels/agentChat/conversationTransport'
import { useRemoteChat } from '../../../panels/agentChat/remoteChatRegistry'
import { useAgentFocusRequest } from './agentsPaneFocus'

// The Agents tab: every agent the focused chat sent off to work, the ones still
// working first, and each one's own thread — what it was asked, the steps it
// took, and what it came back with. It reads the chat's own session (the same
// subscription the chat holds, not a second one), so it is live while the
// agents are and complete for a finished chat.

/** Every agent a transcript spawned, nested ones included, in spawn order. */
export function collectAgentLanes(entries: TranscriptEntry[]): TranscriptToolEntry[] {
  const lanes: TranscriptToolEntry[] = []
  const walk = (tool: TranscriptToolEntry) => {
    if (tool.subagentLane) lanes.push(tool)
    for (const child of tool.children ?? []) walk(child)
  }
  for (const entry of entries) if (entry.kind === 'tool') walk(entry)
  return lanes
}

/**
 * Where an agent's own words go in its thread: each before the first step it
 * started after, as a turn's prose sits before the tools it explains, and the
 * rest after the last step. The last thing a finished agent says is its report,
 * which the thread shows as the report, so it is not said twice. Each keeps
 * when it was said, which the thread shows on hover.
 */
export function placeAgentMessages(lane: TranscriptToolEntry): {
  beforeSteps: { text: string; beforeToolUseId: string; at: number }[]
  afterSteps: { text: string; at: number }[]
} {
  const steps = lane.children ?? []
  const beforeSteps: { text: string; beforeToolUseId: string; at: number }[] = []
  const afterSteps: { text: string; at: number }[] = []
  for (const message of lane.messages ?? []) {
    const next = steps.find((step) => step.startedAt !== undefined && step.startedAt > message.at)
    if (next) beforeSteps.push({ text: message.text, beforeToolUseId: next.id, at: message.at })
    else afterSteps.push({ text: message.text, at: message.at })
  }
  const report = lane.output?.trim()
  const last = afterSteps.at(-1)?.text.trim()
  if (lane.status !== 'running' && report && last && report.startsWith(last.slice(0, 200))) afterSteps.pop()
  return { beforeSteps, afterSteps }
}

// How often the lanes may be refolded while the chat streams. The whole
// transcript is folded each time, and a lane's words and steps read the same a
// fraction of a second later.
const LANE_REFRESH_MS = 400

/**
 * `value`, following it at most once per `intervalMs` (the latest value lands
 * on the trailing edge), and not at all while `following` is false. Turned
 * back on, it catches up at once, as it does whenever `atOnce` says what is
 * shown cannot wait (nothing read yet).
 */
function useThrottledValue<T>(value: T, intervalMs: number, following: boolean, atOnce: (shown: T) => boolean): T {
  const [shown, setShown] = useState(value)
  const shownAt = useRef(0)
  useEffect(() => {
    if (!following || Object.is(value, shown)) return undefined
    const show = () => {
      shownAt.current = Date.now()
      setShown(() => value)
    }
    const wait = atOnce(shown) ? 0 : shownAt.current + intervalMs - Date.now()
    if (wait <= 0) {
      show()
      return undefined
    }
    const timer = setTimeout(show, wait)
    return () => clearTimeout(timer)
  }, [value, shown, intervalMs, following, atOnce])
  return shown
}

export function AgentsTab({ workspaceId, active }: { workspaceId: string; active: boolean }) {
  const focusedAgentId = useWorkspaceStore((s) => s.focusedAgentByWorkspaceId[workspaceId] ?? null)
  const request = useAgentFocusRequest(workspaceId)
  // A chat that asked for this tab (from one of its agent lanes) is shown until
  // another chat takes focus; otherwise the tab follows the focused chat.
  const [target, setTarget] = useState<{ agentId: string; laneId: string | null; serial: number } | null>(null)
  useEffect(() => {
    if (request) setTarget({ agentId: request.agentId, laneId: request.laneId, serial: request.serial })
  }, [request])
  // Only a change of focus lets go of the request: on the first mount both
  // effects run, and the request that opened this tab, from a chat that was
  // not the focused one, was dropped before it was ever shown.
  const previousFocusedAgentIdRef = useRef(focusedAgentId)
  useEffect(() => {
    if (previousFocusedAgentIdRef.current === focusedAgentId) return
    previousFocusedAgentIdRef.current = focusedAgentId
    setTarget((previous) => (previous && focusedAgentId && previous.agentId !== focusedAgentId ? null : previous))
  }, [focusedAgentId])
  const askedAgentId = target?.agentId ?? focusedAgentId
  const local = useLocalChatBinding(workspaceId, askedAgentId ?? '')
  // A chat on a paired machine has no record here: its pane says it is open
  // in this workspace, and the tab reads it through the pane's transport.
  // The focus a local chat's tab records is not recorded for it, so with no
  // chat asked for, the one open here is shown.
  const remote = useRemoteChat(workspaceId, local ? null : askedAgentId)
  const remoteShown = !local && remote !== null
  const agentId = remoteShown ? remote.agentId : askedAgentId
  const binding = local ?? (remoteShown ? remote.binding : null)
  const root = binding ? (binding.sessionRoot ?? binding.workspaceRoot) : null

  if (!agentId || !binding || !root) {
    return (
      <div className="flex h-full min-h-0 flex-col bg-[color:var(--bg-app)]">
        <PanelHeader title="Agents" />
        <EmptyState
          title="No chat in focus"
          body="Open a chat, and the agents it sends off to work show up here: the ones still working, the ones that finished, and what each one did."
        />
      </div>
    )
  }
  const agents = (
    <ChatAgents
      key={`${workspaceId}:${agentId}`}
      workspaceId={workspaceId}
      agentId={agentId}
      root={root}
      binding={binding}
      initialLaneId={target?.laneId ?? null}
      requestSerial={target?.serial ?? 0}
      active={active}
    />
  )
  return remoteShown ? (
    <ConversationTransportProvider value={remote.transport}>{agents}</ConversationTransportProvider>
  ) : (
    agents
  )
}

const isEmpty = (events: readonly unknown[]): boolean => events.length === 0

function ChatAgents({
  workspaceId,
  agentId,
  root,
  binding,
  initialLaneId,
  requestSerial,
  active,
}: {
  workspaceId: string
  agentId: string
  root: string
  binding: ChatBinding
  initialLaneId: string | null
  requestSerial: number
  /** The pane is open on this tab and its workspace is on screen. */
  active: boolean
}) {
  // Nobody can see a collapsed pane, another tab's, or a background
  // workspace's: `active` says the first two, and the view's own placement
  // (its workspace layer, whether it is in the viewport) the rest. The
  // subscription then rests as a hidden chat's does, rendering no streamed
  // token until the tab is seen again.
  const rootRef = useRef<HTMLDivElement | null>(null)
  const placed = useChatViewActive(rootRef)
  const seen = active && placed
  const session = useConversationSession(root, workspaceId, agentId, { active: seen })
  // Tokens stream into the same session; the list only needs to keep up, not to
  // refold on every one of them. Where nobody can see it, it holds what it last
  // showed and catches up when it is shown again.
  const events = useDeferredValue(useThrottledValue(session.events, LANE_REFRESH_MS, seen, isEmpty))
  const projection = useMemo(() => projectConversation(events), [events])
  const lanes = useMemo(() => collectAgentLanes(projection.entries), [projection.entries])
  const [selected, setSelected] = useState<string | null>(initialLaneId)
  useEffect(() => setSelected(initialLaneId), [initialLaneId, requestSerial])
  const lane = selected ? lanes.find((candidate) => candidate.id === selected) : undefined

  // Kept while the lanes are, so a session frame that moved nothing drawn here
  // (every frame, while the tab is hidden) re-renders no section or thread.
  const working = useMemo(() => lanes.filter((candidate) => candidate.status === 'running'), [lanes])
  const finished = useMemo(() => lanes.filter((candidate) => candidate.status !== 'running').reverse(), [lanes])
  const tokens = lanes.reduce((sum, candidate) => sum + (candidate.agent?.usage?.totalTokens ?? 0), 0)
  const showList = useCallback(() => setSelected(null), [])

  return (
    <ConversationLinkProvider
      workspaceId={workspaceId}
      agentId={agentId}
      // A chat on a paired machine is keyed by its link, which is no folder
      // here to resolve a file link against.
      cwd={binding.workspaceRoot ?? ''}
      workspaceRoot={binding.workspaceRoot ?? ''}
    >
      <SubagentTypesProvider value={projection.agentTypes}>
        <div ref={rootRef} className="flex h-full min-h-0 flex-col bg-[color:var(--bg-app)]">
          <PanelHeader title="Agents" subtitle={binding.agent.name} count={lanes.length || undefined} />
          {lane ? (
            <AgentThread lane={lane} onBack={showList} />
          ) : (
            <div className="min-h-0 flex-1 overflow-y-auto px-2 pb-4 pt-2">
              {!session.hydrated && !session.error ? (
                <div className="flex items-center gap-2 px-2 py-3 text-meta text-[color:var(--text-muted)]">
                  <Spinner />
                  <span role="status">Reading the chat…</span>
                </div>
              ) : null}
              {session.error ? (
                <InlineNotice tone="error" title="Couldn't read this chat." detail={session.error} />
              ) : null}
              {session.hydrated && lanes.length === 0 ? (
                <EmptyState
                  title="No agents yet"
                  body="When this chat sends agents off to work — to search the code, plan, or take on part of a task — they show up here."
                />
              ) : null}
              {working.length > 0 ? <AgentSection title="Working" lanes={working} onOpen={setSelected} /> : null}
              {finished.length > 0 ? <AgentSection title="Finished" lanes={finished} onOpen={setSelected} /> : null}
              {session.hasMore ? (
                <GhostButton
                  size="inline"
                  tone="subtle"
                  align="start"
                  disabled={session.loadingEarlier}
                  onClick={() => void session.loadEarlier().catch(() => undefined)}
                  className="mx-2 mt-2"
                >
                  {session.loadingEarlier ? 'Loading earlier turns…' : 'Load earlier turns to see older agents'}
                </GhostButton>
              ) : null}
            </div>
          )}
          {lanes.length > 0 && !lane ? (
            <footer className="border-t border-[color:var(--border-subtle)] px-4 py-2 text-micro tabular-nums text-[color:var(--text-subtle)]">
              {[
                working.length ? `${working.length} working` : null,
                finished.length ? `${finished.length} finished` : null,
                tokens ? formatTokens(tokens) : null,
              ]
                .filter(Boolean)
                .join(' · ')}
            </footer>
          ) : null}
        </div>
      </SubagentTypesProvider>
    </ConversationLinkProvider>
  )
}

const AgentSection = React.memo(function AgentSection({
  title,
  lanes,
  onOpen,
}: {
  title: string
  lanes: TranscriptToolEntry[]
  onOpen: (laneId: string) => void
}) {
  return (
    <section aria-label={title} className="mb-3">
      <h3 className="px-2 pb-1 pt-2 text-micro font-medium text-[color:var(--text-subtle)]">
        {title} · {lanes.length}
      </h3>
      <ul className="flex flex-col gap-0.5">
        {lanes.map((lane) => (
          <li key={lane.id}>
            <AgentRow lane={lane} onOpen={() => onOpen(lane.id)} />
          </li>
        ))}
      </ul>
    </section>
  )
})

// One agent in the list: who it is and what it was sent to do, how it is doing,
// and underneath, what it is doing now or the first line of what it found.
function AgentRow({ lane, onOpen }: { lane: TranscriptToolEntry; onOpen: () => void }) {
  // A working agent's character loops; scrolled out of the list (or with the
  // window idle) it holds still, as a transcript's lanes do.
  const rowRef = useRef<HTMLButtonElement>(null)
  useLiveRowMotion(rowRef, lane.status === 'running')
  return (
    <RowButton
      ref={rowRef}
      density="row"
      onClick={onOpen}
      aria-label={`${subagentLaneLabel(lane)}: ${laneTask(lane) || 'agent'}`}
    >
      <AgentLaneSummary lane={lane} />
    </RowButton>
  )
}

// One agent's own thread: what it was asked and what kind of helper it is, the
// steps it took (each one opens onto its input and output, as in the chat),
// and the report it came back with.
const AgentThread = React.memo(function AgentThread({
  lane,
  onBack,
}: {
  lane: TranscriptToolEntry
  onBack: () => void
}) {
  const running = lane.status === 'running'
  const description = useSubagentTypeDescription(lane.subagentType)
  const task = laneTask(lane)
  const steps = lane.children ?? []
  const tokens = lane.agent?.usage?.totalTokens
  const stepCount = lane.agent?.usage?.toolUses ?? flattenToolEntries(steps).length
  const now = lane.agent?.progressSummary ?? (lane.agent?.lastToolName ? `Using ${lane.agent.lastToolName}` : '')
  const { beforeSteps, afterSteps } = placeAgentMessages(lane)
  const headRef = useRef<HTMLDivElement>(null)
  useLiveRowMotion(headRef, running)
  return (
    <div className="min-h-0 flex-1 overflow-y-auto px-3 pb-6 pt-2">
      <GhostButton size="inline" tone="subtle" align="start" onClick={onBack}>
        ‹ All agents
      </GhostButton>
      <div ref={headRef} className="mt-2 flex items-center gap-2 px-2 text-body">
        <LaneGlyph tool={lane} />
        <span className="font-medium text-[color:var(--text-strong)]">{subagentLaneLabel(lane)}</span>
        <span className="ml-auto shrink-0 text-meta tabular-nums text-[color:var(--text-subtle)]">
          <LaneStatus lane={lane} />
        </span>
      </div>
      <dl className="mt-2 flex flex-col gap-1 px-2 text-meta">
        {task ? (
          <div>
            <dt className="sr-only">Task</dt>
            <dd className="text-[color:var(--text-default)]">{task}</dd>
          </div>
        ) : null}
        {description ? (
          <div>
            <dt className="sr-only">Kind of agent</dt>
            <dd className="text-[color:var(--text-muted)]">{description}</dd>
          </div>
        ) : null}
        {running && now ? (
          <div>
            <dt className="sr-only">Now</dt>
            <dd className="text-[color:var(--text-muted)]">Now: {now}</dd>
          </div>
        ) : null}
        {!running && lane.agent?.error ? (
          <div>
            <dt className="sr-only">Why it ended</dt>
            <dd className="text-[color:var(--tone-error)]">{lane.agent.error}</dd>
          </div>
        ) : null}
        {stepCount || tokens ? (
          <div>
            <dt className="sr-only">Usage</dt>
            <dd className="text-micro text-[color:var(--text-subtle)]">
              {[
                stepCount ? `${stepCount} ${stepCount === 1 ? 'step' : 'steps'}` : null,
                tokens ? formatTokens(tokens) : null,
              ]
                .filter(Boolean)
                .join(' · ')}
            </dd>
          </div>
        ) : null}
      </dl>
      <h3 className="mt-4 px-2 pb-1 text-micro font-medium text-[color:var(--text-subtle)]">Steps</h3>
      {steps.length > 0 ? (
        <div className="px-1">
          <WorkTimeline tools={steps} live={running} intermediateText={beforeSteps} />
        </div>
      ) : afterSteps.length === 0 ? (
        <p className="px-2 text-meta text-[color:var(--text-subtle)]">
          {running ? 'No steps yet — it is still getting started.' : 'It took no steps of its own.'}
        </p>
      ) : null}
      {afterSteps.map((message, index) => (
        <TimedProse key={index} text={message.text} at={message.at} className="mb-2 min-w-0 px-2 text-body" />
      ))}
      {!running ? (
        <>
          <h3 className="mt-4 px-2 pb-1 text-micro font-medium text-[color:var(--text-subtle)]">Report</h3>
          <SubagentLaneResult tool={lane} />
        </>
      ) : null}
    </div>
  )
})
