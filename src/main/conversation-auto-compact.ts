import type { ConversationSessionSummary } from '../shared/conversation-runtime'
import { cliForConversationProvider } from '../shared/conversation-harness'
import { conversationSessionWorking } from '../shared/conversation/phase'
import type { PromptCacheTtl } from '../shared/prompt-cache'

// Auto compact: a Claude chat that sits idle is compacted by Studio itself
// just before its prompt cache expires, so the person coming back later does
// not pay for the whole conversation re-read uncached. A compaction made then
// reads the conversation from the cache, at a tenth of the price; made after,
// it re-reads all of it at full price first, which is why a chat that has gone
// cold is offered a handoff instead (the composer's cache notice).
//
// It runs here, in the process that holds the chats, and not in a window: two
// windows (or a detached one) would each send the compaction. It is driven by
// the session summaries every chat's events update, which carry the prompt
// cache's reading (its lifetime and when it goes cold), and it sends through
// the same door a resume after a usage limit takes, marked as Studio's
// (`origin.reason` 'auto-compact'): the chat draws no message for it, only its
// compaction's divider, and its end does not mark the chat unread.
//
// Its timers live in memory. After a restart only the sessions running again
// are scheduled, and a chat that went cold while the app was closed simply
// offers its handoff. A machine waking from sleep is looked at again at once.

/** Below this a cold resume is cheaper than a warm compaction is worth: an absolute count, since windows are 1M. */
export const AUTO_COMPACT_MIN_TOKENS = 100_000

/**
 * How long before the cache expires a compaction is sent, by its lifetime. A
 * five-minute cache is compacted in its last minute; an hour's in its last
 * five, which leaves room for the child the idle sweep may have ended in the
 * meantime to start again (the send resumes it) before the request is made.
 */
export const AUTO_COMPACT_LEAD_MS: Readonly<Record<PromptCacheTtl, number>> = {
  '5m': 60_000,
  '1h': 5 * 60_000,
}

/** Never sent with less than this left: it would reach the API after the cache had gone. */
export const AUTO_COMPACT_MIN_REMAINING_MS = 20_000

/**
 * The reading's expiry is stamped when the provider saw the request start
 * (`message_start`), a few seconds after the API began caching it, so it runs
 * that much late. The cache is taken to go this much sooner.
 */
export const AUTO_COMPACT_EXPIRY_SKEW_MS = 5_000

/** The client a compaction is sent as, for the runtime's command receipts. */
export const AUTO_COMPACT_CLIENT_ID = 'studio-auto-compact'

/** What the scheduler needs to know about a chat besides its session: read from its workspace record. */
export type AutoCompactChat = {
  /** The chat's own choice, or null to follow the app-wide default. */
  autoCompactEnabled: boolean | null
  settled: boolean
  /** A paired machine's chat, shown here: that machine compacts it, if anyone does. */
  remote: boolean
}

export type AutoCompactDeps = {
  listSessions(): ConversationSessionSummary[]
  /** The chat's record, or null when it is no chat here. */
  chat(workspaceId: string, agentId: string): AutoCompactChat | null
  /** The app-wide default for chats that leave it unset. */
  enabledByDefault(): boolean
  /** Send `/compact` to the chat as Studio's own message. */
  send(session: ConversationSessionSummary, commandId: string): Promise<{ ok: boolean; message?: string }>
  now?: () => number
  setTimer?: (callback: () => void, ms: number) => unknown
  clearTimer?: (timer: unknown) => void
  log?: (message: string) => void
}

/**
 * When a session should be compacted, or why it should not be: the rule the
 * scheduler applies when it arms a timer and again when the timer fires.
 * `at` is when to send; a send due now or past is due as soon as the timer
 * can run, provided at least AUTO_COMPACT_MIN_REMAINING_MS of cache is left.
 */
export function autoCompactPlan(
  session: ConversationSessionSummary,
  chat: AutoCompactChat | null,
  enabledByDefault: boolean,
  now: number,
): { kind: 'at'; at: number; expiresAt: number } | { kind: 'skip'; reason: string } {
  if (!chat) return { kind: 'skip', reason: 'no chat' }
  if (!(chat.autoCompactEnabled ?? enabledByDefault)) return { kind: 'skip', reason: 'off' }
  if (cliForConversationProvider(session.providerId) !== 'claude-code') return { kind: 'skip', reason: 'not Claude' }
  if (chat.settled) return { kind: 'skip', reason: 'settled' }
  if (chat.remote) return { kind: 'skip', reason: 'remote' }
  // Idle as the idle sweep reads it: no turn starting, running or waiting on
  // the person, no agent, shell or monitor still running in its child.
  if (session.status !== 'ready' && session.status !== 'failed') return { kind: 'skip', reason: 'busy' }
  if (conversationSessionWorking(session) || (session.backgroundTasks?.length ?? 0) > 0)
    return { kind: 'skip', reason: 'busy' }
  const reading = session.promptCache
  if (!reading?.ttl || reading.expiresAt === null) return { kind: 'skip', reason: 'nothing cached' }
  if ((reading.recacheTokens ?? 0) < AUTO_COMPACT_MIN_TOKENS) return { kind: 'skip', reason: 'small' }
  const expiresAt = reading.expiresAt - AUTO_COMPACT_EXPIRY_SKEW_MS
  if (expiresAt - now < AUTO_COMPACT_MIN_REMAINING_MS) return { kind: 'skip', reason: 'too late' }
  return { kind: 'at', at: expiresAt - AUTO_COMPACT_LEAD_MS[reading.ttl], expiresAt: reading.expiresAt }
}

export type AutoCompactScheduler = {
  /** Look at every session again: a chat's events, its record or the default changed, or the machine woke. */
  recompute(): void
  /** How many sessions have a compaction armed. For tests and diagnostics. */
  armed(): number
  dispose(): void
}

export function createAutoCompactScheduler(deps: AutoCompactDeps): AutoCompactScheduler {
  const now = deps.now ?? Date.now
  const setTimer = deps.setTimer ?? ((callback: () => void, ms: number) => setTimeout(callback, ms))
  const clearTimer = deps.clearTimer ?? ((timer: unknown) => clearTimeout(timer as ReturnType<typeof setTimeout>))
  // One timer per session, for the reading it was armed for.
  const timers = new Map<string, { at: number; expiresAt: number; timer: unknown }>()
  // The reading each session was compacted for, so the same one is never sent twice.
  const sent = new Map<string, number>()
  let disposed = false

  const disarm = (sessionId: string) => {
    const armed = timers.get(sessionId)
    if (!armed) return
    clearTimer(armed.timer)
    timers.delete(sessionId)
  }

  const plan = (session: ConversationSessionSummary) =>
    autoCompactPlan(session, deps.chat(session.workspaceId, session.agentId), deps.enabledByDefault(), now())

  const fire = (sessionId: string, expiresAt: number) => {
    timers.delete(sessionId)
    if (disposed) return
    // Everything is read again: the chat may have started working, been
    // settled or switched off, or its cache refreshed, since the timer was set.
    const session = deps.listSessions().find((candidate) => candidate.sessionId === sessionId)
    if (!session) return
    const decided = plan(session)
    if (decided.kind === 'skip' || decided.expiresAt !== expiresAt) {
      recompute()
      return
    }
    if (decided.at > now()) {
      arm(session, decided.at, decided.expiresAt)
      return
    }
    sent.set(sessionId, expiresAt)
    void deps
      .send(session, `auto-compact:${sessionId}:${expiresAt}`)
      .then((answer) => {
        if (!answer.ok) deps.log?.(`A chat was not compacted before its cache expired: ${answer.message ?? 'refused'}`)
      })
      .catch((error: unknown) => {
        deps.log?.(`A chat was not compacted before its cache expired: ${String(error)}`)
      })
  }

  const arm = (session: ConversationSessionSummary, at: number, expiresAt: number) => {
    const armed = timers.get(session.sessionId)
    if (armed && armed.at === at && armed.expiresAt === expiresAt) return
    disarm(session.sessionId)
    const timer = setTimer(() => fire(session.sessionId, expiresAt), Math.max(0, at - now()))
    ;(timer as { unref?: () => void } | null)?.unref?.()
    timers.set(session.sessionId, { at, expiresAt, timer })
  }

  function recompute(): void {
    if (disposed) return
    const sessions = deps.listSessions()
    const live = new Set(sessions.map((session) => session.sessionId))
    for (const sessionId of [...timers.keys()]) if (!live.has(sessionId)) disarm(sessionId)
    for (const sessionId of [...sent.keys()]) if (!live.has(sessionId)) sent.delete(sessionId)
    for (const session of sessions) {
      const decided = plan(session)
      if (decided.kind === 'skip' || sent.get(session.sessionId) === decided.expiresAt) disarm(session.sessionId)
      else arm(session, decided.at, decided.expiresAt)
    }
  }

  return {
    recompute,
    armed: () => timers.size,
    dispose() {
      disposed = true
      for (const sessionId of [...timers.keys()]) disarm(sessionId)
    },
  }
}
