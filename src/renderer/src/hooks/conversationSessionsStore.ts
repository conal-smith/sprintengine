// Live conversation-session summaries, shared by every consumer in a window.
//
// Conversation (chat) agents have no PTY snapshot, so their status comes from
// the main ConversationRuntime. The list is fetched once and refetched when a
// lifecycle event says something a surface draws may have moved. Streaming
// deltas and partial tool output are ignored: they are per-token, and the
// sidebar line reads `currentToolTitle`, which moves only when a tool starts
// or its final output lands. A user message counts: it starts the turn and
// changes what the person last said, and it lands before the provider's first
// event, which may take a while to arrive.
//
// Three things keep the list from re-rendering the shell for nothing, the
// shape `terminalSessionsStore` already has:
// - Refetches are coalesced onto one trailing timer, and never overlap: an
//   event that lands while a fetch is out asks for one more after it.
// - Each session keeps its object while its fields are unchanged, and the
//   list keeps its array while no session moved, so a refetch that changed
//   nothing notifies nobody and a memoized row holding one session's object
//   skips its render.
// - Nothing is fetched while the window cannot be seen; one fetch catches up
//   the moment it is shown.

import { useSyncExternalStore } from 'react'

import type {
  ConversationEvent,
  ConversationEventType,
  ConversationSessionSummary,
} from '../../../shared/conversation-runtime'
import { conversationPhaseWorking, conversationSummaryPhase } from '../../../shared/conversation/phase'
import { onWindowVisibilityChange, windowActivity, type WindowActivity } from '../utils/windowActivity'

/**
 * A summary as the renderer holds it: main's fields, plus when the work now
 * running started, which the sidebar's "working for" counter counts from:
 * main's `workingSince` where it says, else this window's own reading of the
 * turns. `updatedAt` is not that: the runtime also moves it when an approval
 * resolves or the model or permission preset changes, and the counter
 * restarted on each one.
 */
export type ConversationSessionEntry = ConversationSessionSummary & {
  /** Set only while the conversation is working. */
  turnStartedAt?: number
}

export type ConversationSessionsApi = {
  conversationSessionsList?: () => Promise<
    { ok: true; sessions: ConversationSessionSummary[] } | { ok: false; message?: string }
  >
  onConversationEvent?: (listener: (event: ConversationEvent) => void) => () => void
}

// Lifecycle events only. The all-conversations broadcast is not guaranteed to
// carry token deltas at all, so nothing here may depend on them.
const STATUS_EVENT_TYPES: ReadonlySet<ConversationEventType> = new Set<ConversationEventType>([
  'session_started',
  'session_ready',
  'session_updated',
  'session_closed',
  'user_message',
  'turn_started',
  'tool_started',
  'tool_output',
  'approval_requested',
  'approval_resolved',
  'turn_completed',
  'turn_failed',
])

const CONVERSATION_SESSIONS_REFRESH_MS = 300

const EMPTY: readonly ConversationSessionEntry[] = Object.freeze([])

/** Whether an event can move anything a summary carries. */
export function isConversationStatusEvent(event: Pick<ConversationEvent, 'type' | 'payload'>): boolean {
  if (!STATUS_EVENT_TYPES.has(event.type)) return false
  // A command's streamed output, chunk by chunk. The final output (no
  // `partial`) still refreshes: it is what ends the tool.
  if (event.type === 'tool_output' && event.payload?.partial === true) return false
  return true
}

function isWorking(summary: ConversationSessionSummary): boolean {
  return conversationPhaseWorking(conversationSummaryPhase(summary))
}

/**
 * Group sessions by workspace, keeping each workspace's previous array while
 * it holds the same session objects in the same order. Given a list whose
 * objects are stable (this store's), a workspace whose chats did not move
 * keeps its identity, so a memoized row or layout handed its slice holds.
 */
export function groupConversationSessionsByWorkspace<T extends { workspaceId: string }>(
  sessions: readonly T[],
  previous: ReadonlyMap<string, readonly T[]> | null,
): Map<string, readonly T[]> {
  const grouped = new Map<string, T[]>()
  for (const session of sessions) {
    const list = grouped.get(session.workspaceId)
    if (list) list.push(session)
    else grouped.set(session.workspaceId, [session])
  }
  const next = new Map<string, readonly T[]>()
  for (const [workspaceId, list] of grouped) {
    const prior = previous?.get(workspaceId)
    next.set(workspaceId, prior && sameItems(prior, list) ? prior : list)
  }
  return next
}

function sameItems<T>(a: readonly T[], b: readonly T[]): boolean {
  if (a.length !== b.length) return false
  for (let index = 0; index < a.length; index++) if (a[index] !== b[index]) return false
  return true
}

export type ConversationSessionsStore = {
  subscribe(listener: () => void): () => void
  getSnapshot(): readonly ConversationSessionEntry[]
  /** One workspace's sessions; the same array while they are unchanged. */
  getWorkspaceSnapshot(workspaceId: string): readonly ConversationSessionEntry[]
  /** Whether main has answered once (or this window cannot ask), so an empty list means none. */
  hasSnapshot(): boolean
}

export function createConversationSessionsStore({
  api = () => window.api as ConversationSessionsApi,
  activity = windowActivity,
  refreshMs = CONVERSATION_SESSIONS_REFRESH_MS,
}: {
  api?: () => ConversationSessionsApi
  activity?: () => WindowActivity
  refreshMs?: number
} = {}): ConversationSessionsStore {
  const listeners = new Set<() => void>()
  let sessions: readonly ConversationSessionEntry[] = EMPTY
  let byWorkspace = new Map<string, readonly ConversationSessionEntry[]>()
  let loaded = false
  // Each session's last published entry and the signature it was published
  // under, so an unchanged session keeps its object across refetches.
  let entries = new Map<string, { signature: string; entry: ConversationSessionEntry }>()
  // When each session's latest turn started, from its `turn_started` event.
  const turnStartedEvents = new Map<string, number>()
  // The start held for a session while it keeps working, so a refetch
  // mid-turn cannot move it.
  const workingSince = new Map<string, number>()

  let connected = false
  let unsubscribeEvents: (() => void) | null = null
  let unsubscribeVisibility: (() => void) | null = null
  let timer: ReturnType<typeof setTimeout> | null = null
  let inFlight = false
  // An event landed while a fetch was out, or while the window was hidden.
  let pending = false
  // Bumped on disconnect, so a fetch that answers afterwards is dropped.
  let generation = 0

  const notify = (): void => {
    for (const listener of [...listeners]) {
      try {
        listener()
      } catch (error) {
        setTimeout(() => {
          throw error
        }, 0)
      }
    }
  }

  const resolveTurnStart = (summary: ConversationSessionSummary): number | undefined => {
    if (!isWorking(summary)) {
      workingSince.delete(summary.sessionId)
      return undefined
    }
    // Main keeps the stretch of work itself (`workingSince`, conversation/
    // workingStretch.ts), seeing every turn open and every event land, and
    // lists the same number to every paired machine: read it, so this row and
    // theirs count alike. The reading below is for a server built before it.
    if (typeof summary.workingSince === 'number') {
      workingSince.set(summary.sessionId, summary.workingSince)
      return summary.workingSince
    }
    const fromEvent = turnStartedEvents.get(summary.sessionId)
    const held = workingSince.get(summary.sessionId)
    let start: number
    if (held !== undefined) {
      // Still working: hold the start, unless the person sent a message that
      // began a newer turn since. A turn the runtime opens by itself, when a
      // background agent finishes and wakes the chat, is the same stretch of
      // work, so it does not restart the count.
      const sentSince = (summary.lastUserMessageAt ?? 0) > held
      start = fromEvent !== undefined && fromEvent > held && sentSince ? fromEvent : held
    } else if (fromEvent !== undefined && fromEvent >= (summary.lastTurnEndedAt ?? 0)) {
      start = fromEvent
    } else {
      // Working since before this window listened (it opened mid-turn). The
      // best reading there is, held from here so later bumps cannot move it.
      start = summary.updatedAt
    }
    workingSince.set(summary.sessionId, start)
    return start
  }

  const apply = (list: readonly ConversationSessionSummary[]): void => {
    const nextEntries = new Map<string, { signature: string; entry: ConversationSessionEntry }>()
    let changed = !loaded || list.length !== sessions.length
    const next = list.map((summary, index) => {
      const turnStartedAt = resolveTurnStart(summary)
      const signature = `${turnStartedAt ?? ''}|${JSON.stringify(summary)}`
      const prior = entries.get(summary.sessionId)
      const entry =
        prior && prior.signature === signature
          ? prior.entry
          : turnStartedAt === undefined
            ? summary
            : { ...summary, turnStartedAt }
      nextEntries.set(summary.sessionId, { signature, entry })
      if (sessions[index] !== entry) changed = true
      return entry
    })
    entries = nextEntries
    for (const id of [...turnStartedEvents.keys()]) if (!nextEntries.has(id)) turnStartedEvents.delete(id)
    for (const id of [...workingSince.keys()]) if (!nextEntries.has(id)) workingSince.delete(id)
    loaded = true
    if (!changed) return
    sessions = next
    byWorkspace = groupConversationSessionsByWorkspace(next, byWorkspace)
    notify()
  }

  const visible = (): boolean => activity().get().visible

  const fetchNow = (): void => {
    const list = api().conversationSessionsList
    if (typeof list !== 'function') return
    if (inFlight) {
      pending = true
      return
    }
    inFlight = true
    pending = false
    const fetchGeneration = generation
    void list()
      .then((result) => {
        if (fetchGeneration === generation && result.ok) apply(result.sessions)
      })
      .catch(() => undefined)
      .finally(() => {
        if (fetchGeneration !== generation) return
        inFlight = false
        if (pending) schedule()
      })
  }

  function schedule(): void {
    if (!connected) return
    if (!visible()) {
      pending = true
      return
    }
    if (timer !== null) return
    timer = setTimeout(() => {
      timer = null
      if (!visible()) {
        pending = true
        return
      }
      fetchNow()
    }, refreshMs)
  }

  const onEvent = (event: ConversationEvent): void => {
    if (!isConversationStatusEvent(event)) return
    if (event.type === 'turn_started' && typeof event.createdAt === 'number') {
      turnStartedEvents.set(event.sessionId, event.createdAt)
    }
    schedule()
  }

  const connect = (): void => {
    connected = true
    const source = api()
    if (typeof source.conversationSessionsList !== 'function') {
      // Nothing to ask: an empty list is the answer, not a wait.
      if (!loaded) {
        loaded = true
        notify()
      }
      return
    }
    unsubscribeEvents = typeof source.onConversationEvent === 'function' ? source.onConversationEvent(onEvent) : null
    unsubscribeVisibility = onWindowVisibilityChange((isVisible) => {
      if (!isVisible) {
        if (timer !== null) {
          clearTimeout(timer)
          timer = null
          pending = true
        }
        return
      }
      if (pending) fetchNow()
    }, activity())
    // The first list is fetched even while hidden: until it lands, every
    // surface would read every chat as idle.
    fetchNow()
  }

  const disconnect = (): void => {
    connected = false
    generation += 1
    inFlight = false
    pending = false
    if (timer !== null) clearTimeout(timer)
    timer = null
    unsubscribeEvents?.()
    unsubscribeEvents = null
    unsubscribeVisibility?.()
    unsubscribeVisibility = null
  }

  return {
    subscribe(listener) {
      listeners.add(listener)
      if (!connected) connect()
      return () => {
        listeners.delete(listener)
        if (listeners.size === 0 && connected) disconnect()
      }
    },
    getSnapshot: () => sessions,
    getWorkspaceSnapshot: (workspaceId) => byWorkspace.get(workspaceId) ?? EMPTY,
    hasSnapshot: () => loaded,
  }
}

let sharedStore: ConversationSessionsStore | null = null

export function conversationSessionsStore(): ConversationSessionsStore {
  sharedStore ??= createConversationSessionsStore()
  return sharedStore
}

/** Every conversation session main knows of; the same array until one moves. */
export function useConversationSessions(): readonly ConversationSessionEntry[] {
  const store = conversationSessionsStore()
  return useSyncExternalStore(store.subscribe, store.getSnapshot, store.getSnapshot)
}
