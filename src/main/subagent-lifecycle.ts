import type { AgentState } from '../shared/agent-state'
import type { ConversationEvent, ConversationSessionSummary } from '../shared/conversation-runtime'

/**
 * A sub-agent's life after `subagent.start` (subagent-tools.ts), in the core,
 * beside the runtime whose events it hears.
 *
 * A sub-agent runs for one task. When its first turn ends the outcome goes on
 * its record (`AgentState.subagentEnd`) and its session rests, as a settled
 * chat's does, keeping the transcript. The record is what every window and a
 * restart read, so nothing here has to survive on its own. The parent may send
 * it a follow-up, which resumes it as any resting chat, and the outcome and
 * result stay the first turn's.
 *
 * It also goes with its parent: a parent's interrupted turn stops the
 * sub-agents it has running, and a parent removed from its workspace takes its
 * sub-agents and their transcripts along. A parent settled or snoozed takes
 * nothing with it: its sub-agents work on, and their notices wait for it.
 */

export const SUBAGENT_RESULT_MAX_CHARS = 20_000
// A sub-agent's first turn is near the start of a short transcript. This only
// bounds how far a read looks once follow-ups have been sent to it.
const RESULT_READ_TURNS = 50

export type SubagentEnd = NonNullable<AgentState['subagentEnd']>

export type SubagentResult = { text: string; truncated: boolean }

type ChatRef = { workspaceId: string; agentId: string }

export type SubagentLifecycleDeps = {
  /** The agents of a workspace by id, or null when it is not on record here. */
  agentsOf(workspaceId: string): Readonly<Record<string, AgentState>> | null
  /** Every workspace on record, for what a restart has to tidy. */
  workspaceIds(): string[]
  writeEnd(chat: ChatRef, end: SubagentEnd): void
  removeAgent(chat: ChatRef): void
  session(chat: ChatRef): ConversationSessionSummary | undefined
  interrupt(sessionId: string): Promise<unknown>
  /** End the session's process and keep its transcript, as Settle does. */
  rest(sessionId: string): Promise<unknown>
  /** The chat's newest `turns` turns, oldest first. */
  readEvents(chat: ChatRef, turns: number): Promise<readonly ConversationEvent[]>
  deleteTranscript(chat: ChatRef): Promise<unknown>
  now?: () => number
  log?: (message: string) => void
}

export type SubagentLifecycle = {
  onConversationEvent(event: ConversationEvent): void
  onSessionIdle(summary: Pick<ConversationSessionSummary, 'sessionId' | 'workspaceId' | 'agentId'>): void
  /** A workspace's agents changed: a sub-agent whose parent left goes with it. */
  onAgentsChanged(workspaceId: string): void
  /** Read as the app starts: what was running when it last quit is over. */
  reconcile(): void
  /** Stop one, as `subagent.cancel` or its parent's stop does. Ended already, nothing changes. */
  stop(chat: ChatRef): Promise<void>
  /** Hear each sub-agent stopped on purpose: nothing about one is news to its parent (agent-launch-notices.ts). */
  onStopped(listener: (chat: ChatRef) => void): void
  /** Its first message never went: it failed before it began. */
  fail(chat: ChatRef, message: string): void
  /** Its final reply, read from its transcript. Null while it has none. */
  result(chat: ChatRef): Promise<SubagentResult | null>
}

// As a window refreshes its own list of sessions, so a paired machine's Agents
// tab is as current as this machine's.
const SUBAGENT_CHANGE_DELAY_MS = 300

/**
 * Hears that a chat's sub-agents may read differently, for a paired machine
 * following that chat (`conversation-subagents`): a record written (one
 * started or ended), or a session moved. A session says so by its events, whose
 * streamed words move nothing a sub-agent's row says. Once per burst, on a
 * trailing timer, since an event can land before the summary it changes.
 */
export function subagentChangesOf(
  sources: {
    onEvent(listener: (event: ConversationEvent) => void): () => void
    onRecords(listener: () => void): () => void
  },
  delayMs = SUBAGENT_CHANGE_DELAY_MS,
): (listener: () => void) => () => void {
  return (listener) => {
    let timer: ReturnType<typeof setTimeout> | null = null
    const soon = () => {
      if (timer) return
      timer = setTimeout(() => {
        timer = null
        listener()
      }, delayMs)
      timer.unref?.()
    }
    const stopEvents = sources.onEvent((event) => {
      if (event.type === 'content_delta' || event.type === 'reasoning_delta') return
      if (event.type === 'tool_output' && event.payload?.partial === true) return
      soon()
    })
    const stopRecords = sources.onRecords(soon)
    return () => {
      if (timer) clearTimeout(timer)
      timer = null
      stopEvents()
      stopRecords()
    }
  }
}

/** How each runtime says a turn was stopped, as `conversation-attention.ts` reads it. */
export function turnWasInterrupted(event: ConversationEvent): boolean {
  if (event.type === 'turn_completed') return event.payload?.interrupted === true
  return event.payload?.reason === 'interrupted' || event.payload?.message === 'interrupted'
}

export function createSubagentLifecycle(deps: SubagentLifecycleDeps): SubagentLifecycle {
  const now = deps.now ?? Date.now
  const log = deps.log ?? (() => undefined)
  const quietly = (work: Promise<unknown>, what: string) =>
    void work.catch((error: unknown) => {
      log(`${what}: ${error instanceof Error ? error.message : String(error)}`)
    })

  const agentOf = (chat: ChatRef) => deps.agentsOf(chat.workspaceId)?.[chat.agentId]
  const stoppedListeners = new Set<(chat: ChatRef) => void>()

  function childrenOf(chat: ChatRef): ChatRef[] {
    return Object.entries(deps.agentsOf(chat.workspaceId) ?? {})
      .filter(([, agent]) => agent?.subagentOf?.agentId === chat.agentId)
      .map(([agentId]) => ({ workspaceId: chat.workspaceId, agentId }))
  }

  function end(chat: ChatRef, status: SubagentEnd['status'], at: number, error?: string): void {
    const agent = agentOf(chat)
    if (!agent?.subagentOf || agent.subagentEnd) return
    deps.writeEnd(chat, { at, status, ...(error ? { error } : {}) })
  }

  async function stop(chat: ChatRef): Promise<void> {
    const agent = agentOf(chat)
    if (!agent?.subagentOf || agent.subagentEnd) return
    // Before the interrupt, so the turn it ends reads as stopped, not failed.
    end(chat, 'stopped', now())
    for (const listener of stoppedListeners) listener(chat)
    const session = deps.session(chat)
    if (!session || session.status === 'stopped') return
    if (session.status !== 'ready' || session.turnStartedAt !== undefined) {
      await deps.interrupt(session.sessionId).catch(() => undefined)
    }
    await deps.rest(session.sessionId)
  }

  function stopChildren(parent: ChatRef): void {
    for (const child of childrenOf(parent)) quietly(stop(child), `Sub-agent ${child.agentId} was not stopped`)
  }

  function onConversationEvent(event: ConversationEvent): void {
    const chat = { workspaceId: event.workspaceId, agentId: event.agentId }
    const agent = agentOf(chat)
    if (!agent) return
    const turnEnded = (event.type === 'turn_completed' || event.type === 'turn_failed') && !event.payload?.steered
    if (agent.subagentOf) {
      if (turnEnded) {
        if (turnWasInterrupted(event)) end(chat, 'stopped', event.createdAt)
        else if (event.type === 'turn_completed') end(chat, 'completed', event.createdAt)
        else {
          const message = typeof event.payload?.message === 'string' ? event.payload.message : undefined
          end(chat, 'failed', event.createdAt, message)
        }
      } else if (event.type === 'session_closed') end(chat, 'stopped', event.createdAt)
      return
    }
    if ((turnEnded && turnWasInterrupted(event)) || event.type === 'session_closed') stopChildren(chat)
  }

  function onSessionIdle(summary: Pick<ConversationSessionSummary, 'sessionId' | 'workspaceId' | 'agentId'>): void {
    const agent = agentOf(summary)
    if (!agent?.subagentOf || !agent.subagentEnd) return
    quietly(deps.rest(summary.sessionId), `Sub-agent ${summary.agentId} did not rest`)
  }

  function onAgentsChanged(workspaceId: string): void {
    const agents = deps.agentsOf(workspaceId)
    if (!agents) return
    for (const [agentId, agent] of Object.entries(agents)) {
      if (!agent?.subagentOf || agents[agent.subagentOf.agentId]) continue
      const chat = { workspaceId, agentId }
      quietly(
        stop(chat).then(async () => {
          await deps.deleteTranscript(chat)
          deps.removeAgent(chat)
        }),
        `Sub-agent ${agentId} outlived its parent`,
      )
    }
  }

  function reconcile(): void {
    for (const workspaceId of deps.workspaceIds()) {
      for (const [agentId, agent] of Object.entries(deps.agentsOf(workspaceId) ?? {})) {
        if (!agent?.subagentOf || agent.subagentEnd) continue
        const chat = { workspaceId, agentId }
        const session = deps.session(chat)
        if (!session || session.status === 'stopped') end(chat, 'stopped', now())
      }
      onAgentsChanged(workspaceId)
    }
  }

  async function result(chat: ChatRef): Promise<SubagentResult | null> {
    const agent = agentOf(chat)
    const events = await deps.readEvents(chat, RESULT_READ_TURNS)
    // The result is the task's, not a later follow-up's.
    const until = agent?.subagentEnd?.at ?? Number.POSITIVE_INFINITY
    // Loaded with a read, as conversation.read loads it: it brings the export's
    // Markdown parser, which the server bundle checks for at start.
    const { chatMessagesOf } = await import('./automation/conversation-chat-read')
    const { messages } = chatMessagesOf(
      events.filter((event) => event.createdAt <= until),
      SUBAGENT_RESULT_MAX_CHARS,
    )
    const last = messages[messages.length - 1]
    if (!last || last.from !== 'agent') return null
    return { text: last.text, truncated: last.cut === true }
  }

  return {
    onConversationEvent,
    onSessionIdle,
    onAgentsChanged,
    reconcile,
    stop,
    onStopped: (listener) => void stoppedListeners.add(listener),
    fail: (chat, message) => end(chat, 'failed', now(), message),
    result,
  }
}
