import type { ConversationEvent, ConversationSessionSummary } from '../../shared/conversation-runtime'
import { conversationTurnInProgress } from '../../shared/conversation/phase'
import { composePullRequestWake, type PullRequestWake } from './pull-request-watch'
import type { PullRequestConversationKey, PullRequestWatchNewsEvent } from './pull-request-record'

// Waking a chat about the pull request its agent asked Studio to watch.
//
// The watch (`pull-request-watch.ts`) decides what is news; this says it in
// the chat, through the chat's normal send path (the one a paired device's
// send and a resume after a usage limit take), which resumes a chat with no
// live session from its record. The message is recorded as Studio's, not the
// person's (`origin` on its `user_message`, reason `pull-request-watch`), so
// the chat draws it as Studio's row and nothing counts it as the person
// writing; its words open with Studio's name for the agent, which reads only
// words.
//
// When it goes, and when it does not:
//
// - Never into a settled or deleted chat. The person put it away, and waking
//   its agent would bring it back; the watch stops instead (`onChatGone`).
// - Never into a running turn, or over a question or an approval the person
//   has not answered. It waits for the turn to end and goes then; the chat
//   carries on with its work, and the news is the next thing it reads. A chat
//   send never touches the composer, so a draft the person is writing stays
//   theirs.
// - Not into a usage limit: a turn started then would fail. It waits until a
//   little after the limit resets.
// - One message per wake: everything every watch of the chat learned while
//   it waited is folded into one, newest news last.
//
// What is waiting lives in memory. A restart forgets news not yet said; the
// watch itself is stored, and its next read finds whatever is still true.

/** After a chat's turn ends, before the wake goes: the runtime lets go of the turn just after it says so. */
const TURN_END_SETTLE_MS = 1_500
/** A busy chat is looked at again after this, if its turn's end is not heard first. */
const BUSY_RETRY_MS = 60_000
/** After a usage limit resets, before the wake goes: past the chat's own resume, which is the better first message. */
const AFTER_RESET_MS = 2 * 60_000
/** A limit with no known reset is looked at again after this. */
const LIMIT_RETRY_MS = 5 * 60_000
/** A timer longer than this is armed again rather than trusted (sleep, a changed clock). */
const MAX_TIMER_MS = 15 * 60_000

export type PullRequestWakeSendResult = { ok: boolean; code?: string; message?: string; retryAfterMs?: number }

export type PullRequestWakesDeps = {
  listSessions(): ConversationSessionSummary[]
  onConversationEvent(listener: (event: ConversationEvent) => void): () => void
  /** The chat as its record says: null once deleted; `settled` once the person put it away. */
  chat(key: PullRequestConversationKey): { settled: boolean } | null
  /** Send a turn through the chat's normal send path, marked as Studio's. */
  send(key: PullRequestConversationKey, text: string, commandId: string): Promise<PullRequestWakeSendResult>
  /** Whether a chat provider is out of its plan's usage now, and when that lifts. Absent, nothing waits on a limit. */
  usageLimit?(providerId: string): { limited: boolean; resetsAt: number | null }
  /** The chat is deleted or put away: its watches stop, and nothing is said. */
  onChatGone(key: PullRequestConversationKey): void
  now?(): number
  setTimer?(callback: () => void, ms: number): unknown
  clearTimer?(handle: unknown): void
  log?(message: string): void
}

export type PullRequestWakes = {
  /** News for a chat: said now if it takes a message, else as soon as it does. */
  deliver(event: PullRequestWatchNewsEvent): void
  /** The computer woke or was unlocked: timers stood still while it slept. */
  wake(): void
  /** How many pull requests have news waiting for a chat. Exposed for tests. */
  pendingCount(key: PullRequestConversationKey): number
  dispose(): void
}

type Waiting = {
  key: PullRequestConversationKey
  /** URL → its news, folded. */
  wakes: Map<string, PullRequestWake>
  sending: boolean
  timer: unknown
  /** When the armed timer is due, so a sooner look replaces a later one and not the other way round. */
  timerAt: number
}

const idOf = (key: PullRequestConversationKey) => `${key.workspaceId}\0${key.agentId}`

export function createPullRequestWakes(deps: PullRequestWakesDeps): PullRequestWakes {
  const now = deps.now ?? Date.now
  const setTimer =
    deps.setTimer ??
    ((callback: () => void, ms: number) => {
      const timer = setTimeout(callback, ms)
      timer.unref?.()
      return timer
    })
  const clearTimer = deps.clearTimer ?? ((handle: unknown) => clearTimeout(handle as ReturnType<typeof setTimeout>))
  const waiting = new Map<string, Waiting>()
  let sequence = 0
  let disposed = false

  const stopListening = deps.onConversationEvent((event) => {
    if (event.type !== 'turn_completed' && event.type !== 'turn_failed') return
    const entry = waiting.get(idOf(event))
    if (entry) lookAgainIn(entry, TURN_END_SETTLE_MS)
  })

  function deliver(event: PullRequestWatchNewsEvent): void {
    if (disposed) return
    const id = idOf(event.conversation)
    const entry = waiting.get(id) ?? {
      key: { ...event.conversation },
      wakes: new Map<string, PullRequestWake>(),
      sending: false,
      timer: null,
      timerAt: 0,
    }
    waiting.set(id, entry)
    const known = entry.wakes.get(event.wake.url)
    // Several reads' news for one pull request: in order, under what the
    // latest read says about it now.
    entry.wakes.set(event.wake.url, known ? { ...event.wake, news: [...known.news, ...event.wake.news] } : event.wake)
    void flush(entry)
  }

  function lookAgainIn(entry: Waiting, ms: number): void {
    const at = now() + ms
    if (entry.timer !== null && entry.timerAt <= at) return
    if (entry.timer !== null) clearTimer(entry.timer)
    entry.timerAt = at
    entry.timer = setTimer(
      () => {
        entry.timer = null
        if (now() < entry.timerAt) return lookAgainIn(entry, entry.timerAt - now())
        void flush(entry)
      },
      Math.max(0, Math.min(ms, MAX_TIMER_MS)),
    )
  }

  function drop(entry: Waiting): void {
    if (entry.timer !== null) clearTimer(entry.timer)
    entry.timer = null
    waiting.delete(idOf(entry.key))
  }

  async function flush(entry: Waiting): Promise<void> {
    if (disposed || entry.sending || waiting.get(idOf(entry.key)) !== entry || entry.wakes.size === 0) return
    const chat = deps.chat(entry.key)
    if (!chat || chat.settled) {
      drop(entry)
      deps.onChatGone(entry.key)
      return
    }
    const sessions = deps
      .listSessions()
      .filter((session) => session.workspaceId === entry.key.workspaceId && session.agentId === entry.key.agentId)
    // A turn running, or stopped on the person: the news is the next thing it reads.
    if (sessions.some((session) => session.status !== 'stopped' && conversationTurnInProgress(session))) {
      lookAgainIn(entry, BUSY_RETRY_MS)
      return
    }
    const latest = [...sessions].sort((a, b) => b.updatedAt - a.updatedAt)[0]
    const limit = latest && deps.usageLimit ? deps.usageLimit(latest.providerId) : null
    if (limit?.limited) {
      lookAgainIn(
        entry,
        limit.resetsAt === null ? LIMIT_RETRY_MS : Math.max(0, limit.resetsAt - now()) + AFTER_RESET_MS,
      )
      return
    }

    const batch = [...entry.wakes.values()]
    entry.wakes.clear()
    entry.sending = true
    let result: PullRequestWakeSendResult
    try {
      sequence += 1
      result = await deps.send(entry.key, composePullRequestWake(batch), `pull-request-watch:${now()}:${sequence}`)
    } catch (error) {
      result = { ok: false, message: error instanceof Error ? error.message : String(error) }
    } finally {
      entry.sending = false
    }
    if (disposed) return
    if (!result.ok && result.code === 'busy') {
      // A turn that started between the look and the send: back in front of
      // anything newer, for its end.
      for (const wake of batch) {
        const newer = entry.wakes.get(wake.url)
        entry.wakes.set(wake.url, newer ? { ...newer, news: [...wake.news, ...newer.news] } : wake)
      }
      waiting.set(idOf(entry.key), entry)
      lookAgainIn(entry, Math.max(BUSY_RETRY_MS, result.retryAfterMs ?? 0))
      return
    }
    if (!result.ok)
      deps.log?.(`A pull request watch could not wake its chat: ${result.message ?? 'the chat refused it'}`)
    // News that arrived while the send was out goes in a message of its own.
    if (entry.wakes.size > 0) void flush(entry)
    else drop(entry)
  }

  return {
    deliver,
    wake() {
      for (const entry of waiting.values()) {
        if (entry.timer === null) continue
        clearTimer(entry.timer)
        entry.timer = null
        void flush(entry)
      }
    },
    pendingCount: (key) => waiting.get(idOf(key))?.wakes.size ?? 0,
    dispose() {
      disposed = true
      stopListening()
      for (const entry of waiting.values()) if (entry.timer !== null) clearTimer(entry.timer)
      waiting.clear()
    },
  }
}
