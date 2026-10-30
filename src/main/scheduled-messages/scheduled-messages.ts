import { mkdir, readFile } from 'node:fs/promises'
import { dirname } from 'node:path'
import { randomUUID } from 'node:crypto'

import {
  CONVERSATION_MAX_SEND_MENTIONS,
  CONVERSATION_MAX_SEND_SKILLS,
  parseConversationWireMentions,
  type ConversationWireMention,
} from '../../../packages/conversation-protocol/src/public'
import type { ConversationEvent, ConversationSessionSummary } from '../../shared/conversation-runtime'
import { ATTACHABLE_IMAGE_TYPES, MAX_ATTACHMENTS_PER_TURN } from '../../shared/conversation-attachments'
import { conversationTurnInProgress } from '../../shared/conversation/phase'
import { isRecord } from '../../shared/records'
import { USAGE_LIMIT_PROVIDERS, type UsageLimitProvider } from '../../shared/usage-limits'
import {
  isId,
  isTime,
  LIMIT_RESET_SEND_BUFFER_MS,
  MAX_SCHEDULED_MESSAGE_LENGTH,
  type ScheduledMessage,
  type ScheduledMessageCarries,
  type ScheduledMessageChat,
  type ScheduledMessagesState,
  type ScheduledMessageUpdate,
} from '../../shared/scheduled-messages'
import { writeFileAtomically } from '../config-file-write'

// Messages a person scheduled into an open chat, sent when their time comes.
//
// A person types a message, picks a time from the composer's "+", and it waits
// here instead of going out: to be sent once a usage limit has reset, or to
// start a piece of work overnight in a chat that already knows the job. When
// its time comes it goes out through the chat's normal send path, the one a
// paired device's send takes, which resumes a chat whose agent is no longer
// running. It is the person's own message, so it is recorded as theirs.
//
// They are kept in a small file in the data directory, so one due while the
// app was closed goes out once it is open again: the person asked for it to
// be sent, and late is closer to that than never. One timer, armed for the
// soonest; never trusted for long, since a timer does not count the time a
// computer sleeps: waking, unlocking and starting all read the wall clock again.
//
// When one comes due:
//
// - the chat still exists. A deleted chat takes its scheduled messages with it;
// - the chat is not in a turn. A message sent into a running turn is refused
//   as busy (a chat takes one turn at a time), so it waits — the tray says so
//   — and goes out the moment the turn ends, as a message queued in the
//   composer does. Waiting has no limit: the person said "send this", and a
//   turn stopped on a question is theirs to answer first;
// - several due together go one after another, a few seconds apart.
//
// A send the chat refuses stays as a failure, in the chat's words, with Retry:
// a message the person wrote is never dropped without their saying so.
//
// A message queued on a paired machine is held here too (`hold`): typed into
// a chat that runs on this machine while its turn was running, it is handed
// over at once rather than kept on the machine that typed it, which would
// send it only if it were still awake when the turn ended (owner report
// 2026-10-08: "if I send that message and then I close my laptop, it's not
// gonna go through"). It is due from the moment it is held, so it takes the
// same wait on the turn a scheduled message that came due mid-turn takes,
// and several queued in one turn go as one message, as the composer's own
// queue sends them.
//
// A paired machine may schedule a message into a chat here too
// (`scheduleFrom`): the person picked a time in that machine's composer, and
// the message is kept and sent from here, as one scheduled in this machine's
// own composer is, so it goes at its time whether or not that machine is
// awake then. It is the same message as one scheduled here, and the tray here
// shows it beside them.
//
// A held message may carry what a message sent then would: pictures, files,
// skills and mentions (`carried`, `conversation-queued-attachments`). The
// machine that queued it handed them over with it, so it may sleep or close
// before the turn ends and the message still goes whole. A picture is a copy
// made on this disk when the message was held, since the upload it came in on
// is spent within the hour; a file stays where its upload put it, as a file
// sent at once does. Both are kept by their paths in the file, and let go
// (`release`) once the message has gone: sent, its pictures' copies go and its
// files stay the message's; deleted, both go. Several held in one turn join as
// one message only while what they carry together still fits one message.
//
// A held message keeps the commands it came in on (`sources`) in the file, and
// once it has gone (sent, deleted, or its chat with it) they are remembered a
// while longer (`heldSources`), so the same command arriving again is the same
// message and is never held, and sent, a second time: a device that lost the
// answer offers it again under its id, before or after a restart here. A
// message a paired machine scheduled keeps its command the same way.

export const SCHEDULED_MESSAGES_FILE = 'scheduled-messages.json'
const FORMAT_VERSION = 1

/** Between two messages going out, so several due together go one after another. */
const STAGGER_MS = 3_000
/** After start, before the first goes out: the app is still finding its chats. */
const STARTUP_GRACE_MS = 15_000
/** A chat busy when its message came due is looked at again after this, if its turn's end is not heard first. */
const BUSY_RETRY_MS = 30_000
/** After a chat's turn ends, before its waiting message goes: the runtime lets go of the turn just after it says so. */
const TURN_END_SETTLE_MS = 1_500
/** A message waiting on a limit that has not said when it resets is looked at again after this. */
const LIMIT_UNKNOWN_RETRY_MS = 5 * 60_000
/** A timer longer than this is armed again rather than trusted (sleep, a changed clock). */
const MAX_TIMER_MS = 15 * 60_000
/** A refusal's words, as the tray keeps them. */
const MAX_FAILURE_LENGTH = 300
/** Held messages one chat may wait on; a machine queueing past this is refused rather than kept without end. */
const MAX_HELD_PER_CHAT = 20
/**
 * Messages a paired machine may have scheduled for a time into one chat: the
 * most a `scheduled` frame names (CONVERSATION_MAX_SCHEDULED_MESSAGES), so
 * each one it scheduled is one its tray can draw.
 */
const MAX_SCHEDULED_FROM_AFAR_PER_CHAT = 50
/**
 * Commands a held message that has gone came in on, remembered so one arriving
 * again is not held a second time. A message still held keeps its own.
 */
const MAX_HELD_SOURCES = 500

/**
 * What a held message carries beside its words, by where it is on this disk:
 * kept with it in the file, and never in what a window is told (`carries`).
 */
export type ScheduledMessageCarried = {
  /** Pictures, each a copy made on this disk when the message was held. */
  images?: Array<{ path: string; name: string; mediaType: string; bytes: number }>
  /** Files, each where its upload put it on this disk. */
  files?: Array<{ path: string; name: string; bytes: number }>
  /** Ids of this machine's skills the chat runs with the message. */
  skills?: string[]
  /** Files and folders of the chat's folder, by their paths in it. */
  mentions?: ConversationWireMention[]
}

type Pending = ScheduledMessage & {
  /** What a held message carries beside its words. Kept in the file. */
  carried?: ScheduledMessageCarried
  /** When to look again at a message waiting on a busy chat; not kept in the file. */
  retryAt?: number
  /** How many times it was sent again after a refusal; each send needs a command id of its own. */
  attempt?: number
  /** A held message: the commands it came in on, several when queued ones were joined. Kept in the file. */
  sources?: string[]
}

export type ScheduledMessagesStorage = {
  /** The file's text, or null when there is none. */
  read(): Promise<string | null>
  write(body: string): Promise<void>
}

export type ScheduledMessageSendResult = { ok: boolean; code?: string; message?: string; retryAfterMs?: number }

export type ScheduledMessagesDeps = {
  storage: ScheduledMessagesStorage
  listSessions: () => ConversationSessionSummary[]
  onConversationEvent: (listener: (event: ConversationEvent) => void) => () => void
  /**
   * Where the provider's usage limit stands now, for a message to go once it
   * lifts: asked again when it comes due, since a window that resets later
   * may hold the provider back past the reset it was scheduled for.
   */
  rateLimit?: (provider: UsageLimitProvider, now: number) => { limited: boolean; resetsAt: number | null }
  /** Whether the chat is still there; false for one deleted. */
  chatExists: (chat: ScheduledMessageChat) => boolean
  /**
   * Send a turn through the chat's normal send path, resuming its session
   * when none is live, with what a held message carries beside its words.
   */
  send: (
    chat: ScheduledMessageChat,
    text: string,
    commandId: string,
    carried?: ScheduledMessageCarried,
  ) => Promise<ScheduledMessageSendResult>
  /**
   * A held message that carried pictures or files has gone: `sent` into its
   * chat, or not (deleted, its chat with it). Its pictures' copies are no
   * longer needed either way; its files are the message's once it was sent.
   */
  release?: (carried: ScheduledMessageCarried, sent: boolean) => void
  now?: () => number
  newId?: () => string
  setTimer?: (callback: () => void, ms: number) => unknown
  clearTimer?: (handle: unknown) => void
  log?: (message: string) => void
}

/**
 * `repeat`: the command was held already, so nothing it carried this time was
 * kept, and the caller lets go of what it made for it.
 */
export type ScheduledMessageHoldResult = { ok: true; id: string; repeat?: true } | { ok: false; reason: string }

export type ScheduledMessages = {
  /** Read the file, follow the chats, and arm for what is due. */
  start(): Promise<void>
  /**
   * Hold a message for the end of the chat's turn (at once, when none is
   * running): one a paired machine queued. It joins the chat's held message
   * that has not gone yet, a line of its own, as the composer's queue joins
   * them. `source` names the command it came in on; the same one again is
   * the same message, held once. `carried` is what it brings beside its words,
   * its pictures already copied to this disk.
   */
  hold(
    chat: ScheduledMessageChat,
    text: string,
    source: string,
    carried?: ScheduledMessageCarried,
  ): ScheduledMessageHoldResult
  /** The held message the command `source` went into, still held or gone; null for a command never held. */
  heldFrom(source: string): string | null
  /**
   * Schedule a message a paired machine asked for, to go at `sendAt` as one
   * scheduled here does. `source` names the command it came in on; the same
   * one again is the same message, scheduled once.
   */
  scheduleFrom(chat: ScheduledMessageChat, text: string, sendAt: number, source: string): ScheduledMessageHoldResult
  /** The computer woke or was unlocked: timers stood still while it slept, so read the clock again. */
  wake(): void
  /** Chats may have been deleted: forget their messages. */
  prune(): void
  state(): ScheduledMessagesState
  update(update: ScheduledMessageUpdate): ScheduledMessagesState
  onChanged(listener: (state: ScheduledMessagesState) => void): () => void
  /** Stop the timer and the listeners, and let the last write land. */
  dispose(): Promise<void>
}

const sameChat = (a: ScheduledMessageChat, b: ScheduledMessageChat): boolean =>
  a.workspaceId === b.workspaceId && a.agentId === b.agentId

export function createScheduledMessages(deps: ScheduledMessagesDeps): ScheduledMessages {
  const now = deps.now ?? Date.now
  const newId = deps.newId ?? (() => `sm-${randomUUID().replace(/-/g, '').slice(0, 12)}`)
  const setTimer =
    deps.setTimer ??
    ((callback: () => void, ms: number) => {
      const timer = setTimeout(callback, ms)
      timer.unref?.()
      return timer
    })
  const clearTimer = deps.clearTimer ?? ((handle: unknown) => clearTimeout(handle as ReturnType<typeof setTimeout>))
  const log = deps.log ?? (() => undefined)

  let messages: Pending[] = []
  // Source command → the held message it went into, for messages that have
  // gone; one still held answers from its own `sources`.
  let heldSources = new Map<string, string>()
  const listeners = new Set<(state: ScheduledMessagesState) => void>()
  const unsubscribers: Array<() => void> = []
  let timer: unknown = null
  let running = false
  // Nothing goes out before this: the start's grace, then the stagger.
  let quietUntil = 0
  let writing: Promise<void> = Promise.resolve()

  // ── Keeping ──────────────────────────────────────────────────────────────

  function persist(): void {
    // One on its way is kept as it was before it left: should the app stop
    // mid-send, it is sent again rather than lost.
    const kept = messages.map(({ retryAt: _retryAt, sending: _sending, ...entry }) => entry)
    const body = JSON.stringify({ version: FORMAT_VERSION, messages: kept, heldSources: [...heldSources] })
    writing = writing
      .then(() => deps.storage.write(body))
      .catch((error: unknown) => {
        log(`Could not save the scheduled messages: ${error instanceof Error ? error.message : String(error)}`)
      })
  }

  function state(): ScheduledMessagesState {
    return {
      messages: messages.map(({ retryAt: _retryAt, attempt: _attempt, sources: _sources, carried, ...entry }) => {
        const carries = carriesOf(carried)
        return { ...entry, ...(carries ? { carries } : {}) }
      }),
    }
  }

  function changed(): void {
    persist()
    const next = state()
    for (const listener of [...listeners]) listener(next)
    arm()
  }

  /**
   * Take messages out, remembering the commands the held ones came in on, and
   * letting go of what they carried: `sent` says the message went into its chat.
   */
  function remove(leaving: (entry: Pending) => boolean, sent = false): boolean {
    const before = messages.length
    const gone: Pending[] = []
    messages = messages.filter((entry) => {
      if (!leaving(entry)) return true
      remember(entry.id, entry.sources ?? [])
      gone.push(entry)
      return false
    })
    for (const entry of gone) if (entry.carried) release(entry.carried, sent)
    return messages.length !== before
  }

  function release(carried: ScheduledMessageCarried, sent: boolean): void {
    if (!carried.images?.length && !carried.files?.length) return
    try {
      deps.release?.(carried, sent)
    } catch (error) {
      log(`Could not let go of a held message's files: ${error instanceof Error ? error.message : String(error)}`)
    }
  }

  function remember(id: string, sources: readonly string[]): void {
    for (const source of sources) {
      heldSources.delete(source)
      heldSources.set(source, id)
    }
    while (heldSources.size > MAX_HELD_SOURCES) heldSources.delete(heldSources.keys().next().value!)
  }

  /** Drop the messages of chats that are gone. True when something went. */
  function dropStale(): boolean {
    return remove((entry) => !entry.sending && !deps.chatExists(entry))
  }

  // ── When one comes due ───────────────────────────────────────────────────

  /** When a message is next looked at; null for one that waits on the person (failed) or is on its way. */
  const dueAt = (entry: Pending): number | null =>
    entry.failure !== undefined || entry.sending ? null : Math.max(entry.sendAt, entry.retryAt ?? 0)

  function arm(): void {
    if (timer !== null) clearTimer(timer)
    timer = null
    if (!running) return
    let soonest: number | null = null
    for (const entry of messages) {
      const at = dueAt(entry)
      if (at !== null && (soonest === null || at < soonest)) soonest = at
    }
    if (soonest === null) return
    const delay = Math.max(0, Math.min(Math.max(soonest, quietUntil) - now(), MAX_TIMER_MS))
    timer = setTimer(tick, delay)
  }

  function tick(): void {
    timer = null
    if (!running) return
    const at = now()
    const dropped = dropStale()
    if (at >= quietUntil) {
      let due: Pending | null = null
      for (const entry of messages) {
        const when = dueAt(entry)
        if (when !== null && when <= at && (due === null || when < dueAt(due)!)) due = entry
      }
      if (due) {
        // Every way out of `fire` says what changed, and arms again.
        fire(due, at)
        return
      }
    }
    if (dropped) changed()
    else arm()
  }

  function fire(entry: Pending, at: number): void {
    if (!deps.chatExists(entry)) {
      remove((candidate) => candidate === entry)
      log('A scheduled message was not sent: its chat was deleted.')
      return changed()
    }
    const busy = deps
      .listSessions()
      .some(
        (session) =>
          sameChat(session, entry) &&
          session.status !== 'stopped' &&
          session.status !== 'failed' &&
          conversationTurnInProgress(session),
      )
    if (busy) return wait(entry, at, BUSY_RETRY_MS)
    // To go once the limit lifts: still held back by a window that resets
    // later, it moves to that reset, as a resume after a limit does.
    if (entry.untilLimitReset && deps.rateLimit) {
      const limit = deps.rateLimit(entry.untilLimitReset, at)
      if (limit.limited) {
        if (limit.resetsAt !== null && limit.resetsAt > at) entry.sendAt = limit.resetsAt + LIMIT_RESET_SEND_BUFFER_MS
        else entry.retryAt = at + LIMIT_UNKNOWN_RETRY_MS
        return changed()
      }
    }
    // Only a send holds the next one back: a look that found the chat busy
    // sent nothing.
    quietUntil = Math.max(quietUntil, at + STAGGER_MS)
    entry.sending = true
    entry.retryAt = undefined
    changed()
    void send(entry)
  }

  function wait(entry: Pending, at: number, retryMs: number): void {
    entry.retryAt = at + retryMs
    // Only the first look says anything new; the next ones just arm again.
    if (entry.waitingSince !== undefined) return arm()
    entry.waitingSince = at
    changed()
  }

  async function send(entry: Pending): Promise<void> {
    let result: ScheduledMessageSendResult
    try {
      result = await deps.send(
        { workspaceId: entry.workspaceId, agentId: entry.agentId },
        entry.text,
        // A retry is a new command: the first one's receipt answers its own id
        // with its refusal.
        `scheduled-message:${entry.id}${entry.attempt ? `:${entry.attempt}` : ''}`,
        ...(entry.carried ? [entry.carried] : []),
      )
    } catch (error) {
      result = { ok: false, message: error instanceof Error ? error.message : String(error) }
    }
    entry.sending = undefined
    // Deleted while it was on its way: it went or it did not, and either way
    // the person has let go of it.
    if (!messages.includes(entry)) return
    if (!running) return
    if (result.ok) {
      remove((candidate) => candidate === entry, true)
      return changed()
    }
    // A turn that started between the look and the send: the same wait as a
    // busy chat.
    if (result.code === 'busy') {
      const at = now()
      entry.waitingSince ??= at
      entry.retryAt = at + Math.max(BUSY_RETRY_MS, result.retryAfterMs ?? 0)
      // It was on its way: say it is waiting again.
      return changed()
    }
    // Refused: the chat says so, with Retry, rather than a line in a log
    // nobody reads.
    const reason = failureWords(result.message)
    log(`A scheduled message was not sent: ${reason}.`)
    entry.failure = reason
    entry.waitingSince = undefined
    changed()
  }

  // A turn ended in a chat with a message waiting on it: look again shortly,
  // rather than at the next half-minute poll.
  function onConversationEvent(event: ConversationEvent): void {
    if (event.type !== 'turn_completed' && event.type !== 'turn_failed') return
    let moved = false
    const at = now()
    for (const entry of messages) {
      if (entry.waitingSince === undefined || entry.sending || !sameChat(entry, event)) continue
      entry.retryAt = Math.min(entry.retryAt ?? Infinity, at + TURN_END_SETTLE_MS)
      moved = true
    }
    if (moved) arm()
  }

  // ── What a window asks ───────────────────────────────────────────────────

  function update(input: ScheduledMessageUpdate): ScheduledMessagesState {
    if (input.kind === 'schedule') {
      messages = [
        ...messages,
        {
          id: newId(),
          workspaceId: input.workspaceId,
          agentId: input.agentId,
          text: input.text,
          sendAt: input.sendAt,
          createdAt: now(),
          ...(input.untilLimitReset ? { untilLimitReset: input.untilLimitReset } : {}),
        },
      ]
      changed()
      return state()
    }
    const entry = messages.find((candidate) => candidate.id === input.id)
    if (!entry) return state()
    if (input.kind === 'delete') {
      remove((candidate) => candidate === entry)
      changed()
      return state()
    }
    // One already on its way cannot be moved or sent again.
    if (entry.sending) return state()
    if (entry.failure !== undefined) entry.attempt = (entry.attempt ?? 0) + 1
    entry.failure = undefined
    entry.waitingSince = undefined
    entry.retryAt = undefined
    if (input.kind === 'reschedule') {
      // A time the person picked: no longer waiting on the limit.
      entry.untilLimitReset = undefined
      entry.sendAt = input.sendAt
      changed()
      return state()
    }
    // Send now: asked for, so not held back by the start's grace or the
    // stagger, nor by the limit it was waiting on.
    entry.untilLimitReset = undefined
    const at = now()
    entry.sendAt = Math.min(entry.sendAt, at)
    if (running) fire(entry, at)
    else changed()
    return state()
  }

  function heldFrom(source: string): string | null {
    return messages.find((entry) => entry.sources?.includes(source))?.id ?? heldSources.get(source) ?? null
  }

  function hold(
    chat: ScheduledMessageChat,
    input: string,
    source: string,
    carrying?: ScheduledMessageCarried,
  ): ScheduledMessageHoldResult {
    const text = input.trim()
    const carried = carrying && carriesOf(carrying) ? carrying : undefined
    // Pictures, files, skills or mentions are a message without words, as a
    // send takes one.
    if (!text && !carried) return { ok: false, reason: 'A queued message needs words.' }
    // The same command again is the same message: still held, or gone
    // already. Either way it is not held again.
    const known = heldFrom(source)
    if (known !== null) return { ok: true, id: known, repeat: true }
    if (!deps.chatExists(chat)) return { ok: false, reason: 'The chat is not on this machine any more.' }
    const at = now()
    // Only one that has not gone yet takes more: one on its way has been read,
    // and one refused waits on the person. And only while the two together
    // are still one message a chat takes.
    const joined = messages.find(
      (entry) =>
        entry.queued &&
        sameChat(entry, chat) &&
        !entry.sending &&
        entry.failure === undefined &&
        entry.text.length + 1 + text.length <= MAX_SCHEDULED_MESSAGE_LENGTH &&
        joinCarried(entry.carried, carried) !== null,
    )
    let id: string
    if (joined) {
      joined.text = [joined.text, text].filter(Boolean).join('\n')
      if (carried) joined.carried = joinCarried(joined.carried, carried) ?? joined.carried
      joined.sources = [...(joined.sources ?? []), source]
      id = joined.id
    } else {
      if (text.length > MAX_SCHEDULED_MESSAGE_LENGTH)
        return { ok: false, reason: `A queued message holds at most ${MAX_SCHEDULED_MESSAGE_LENGTH} characters.` }
      if (messages.filter((entry) => entry.queued && sameChat(entry, chat)).length >= MAX_HELD_PER_CHAT)
        return { ok: false, reason: 'This chat already holds as many queued messages as it can.' }
      id = newId()
      messages = [
        ...messages,
        {
          id,
          workspaceId: chat.workspaceId,
          agentId: chat.agentId,
          text,
          sendAt: at,
          createdAt: at,
          // Due now and, as far as the machine that queued it knew, behind a
          // running turn: the tray says it waits on the turn from the start.
          waitingSince: at,
          queued: true,
          sources: [source],
          ...(carried ? { carried } : {}),
        },
      ]
    }
    changed()
    return { ok: true, id }
  }

  function scheduleFrom(
    chat: ScheduledMessageChat,
    input: string,
    sendAt: number,
    source: string,
  ): ScheduledMessageHoldResult {
    // The same command again is the same message, still waiting or gone.
    const scheduled = messages.find((entry) => entry.sources?.includes(source))
    if (scheduled) return { ok: true, id: scheduled.id }
    const gone = heldSources.get(source)
    if (gone !== undefined) return { ok: true, id: gone }
    const text = input.trim()
    if (!text) return { ok: false, reason: 'A scheduled message needs words.' }
    if (text.length > MAX_SCHEDULED_MESSAGE_LENGTH)
      return { ok: false, reason: `A scheduled message holds at most ${MAX_SCHEDULED_MESSAGE_LENGTH} characters.` }
    if (!isTime(sendAt)) return { ok: false, reason: 'A scheduled message needs a time to go.' }
    if (!deps.chatExists(chat)) return { ok: false, reason: 'The chat is not on this machine any more.' }
    if (messages.filter((entry) => !entry.queued && sameChat(entry, chat)).length >= MAX_SCHEDULED_FROM_AFAR_PER_CHAT)
      return { ok: false, reason: 'This chat already has as many scheduled messages as it can.' }
    const id = newId()
    messages = [
      ...messages,
      {
        id,
        workspaceId: chat.workspaceId,
        agentId: chat.agentId,
        text,
        sendAt,
        createdAt: now(),
        sources: [source],
      },
    ]
    changed()
    return { ok: true, id }
  }

  // ── Life ─────────────────────────────────────────────────────────────────

  async function start(): Promise<void> {
    if (running) return
    running = true
    quietUntil = now() + STARTUP_GRACE_MS
    unsubscribers.push(deps.onConversationEvent(onConversationEvent))
    const saved = readSaved(await deps.storage.read().catch(() => null))
    if (!running) return
    // One scheduled while the file was being read is newer than the file.
    const known = new Set(messages.map((entry) => entry.id))
    // The file's commands are older than any held while it was read: a
    // command held then that the file already knew is the same message
    // twice, and the file's copy stands.
    const savedSources = new Set([
      ...saved.messages.flatMap((entry) => entry.sources ?? []),
      ...saved.heldSources.keys(),
    ])
    const fresh = messages.filter((entry) => {
      if (!entry.sources?.length) return true
      entry.sources = entry.sources.filter((source) => !savedSources.has(source))
      if (entry.sources.length > 0) return true
      // The file's copy carries its own.
      if (entry.carried) release(entry.carried, false)
      return false
    })
    const repeated = fresh.length !== messages.length
    messages = [...saved.messages.filter((entry) => !known.has(entry.id)), ...fresh]
    heldSources = new Map([...saved.heldSources, ...heldSources])
    while (heldSources.size > MAX_HELD_SOURCES) heldSources.delete(heldSources.keys().next().value!)
    if (dropStale() || repeated) persist()
    const next = state()
    for (const listener of [...listeners]) listener(next)
    arm()
  }

  return {
    start,
    hold,
    heldFrom,
    scheduleFrom,
    wake() {
      if (!running) return
      if (timer !== null) clearTimer(timer)
      timer = null
      tick()
    },
    prune() {
      if (messages.length === 0) return
      if (dropStale()) changed()
    },
    state,
    update,
    onChanged(listener) {
      listeners.add(listener)
      return () => listeners.delete(listener)
    },
    async dispose() {
      running = false
      if (timer !== null) clearTimer(timer)
      timer = null
      for (const unsubscribe of unsubscribers.splice(0)) unsubscribe()
      listeners.clear()
      await writing
    },
  }
}

/** The messages kept in `file`: a missing or unreadable one is an empty one. */
export function scheduledMessagesFileStorage(file: string): ScheduledMessagesStorage {
  return {
    async read() {
      try {
        return await readFile(file, 'utf8')
      } catch {
        return null
      }
    },
    async write(body) {
      await mkdir(dirname(file), { recursive: true })
      await writeFileAtomically(file, body)
    },
  }
}

// ── The file ──────────────────────────────────────────────────────────────

function readSaved(text: string | null): { messages: Pending[]; heldSources: Map<string, string> } {
  const none = { messages: [], heldSources: new Map<string, string>() }
  if (!text) return none
  let parsed: unknown
  try {
    parsed = JSON.parse(text)
  } catch {
    return none
  }
  if (!isRecord(parsed) || parsed.version !== FORMAT_VERSION || !Array.isArray(parsed.messages)) return none
  // Written by a build before it, the file has no `heldSources`: nothing gone
  // is remembered, as nothing was then.
  const heldSources = new Map<string, string>()
  if (Array.isArray(parsed.heldSources))
    for (const pair of parsed.heldSources.slice(-MAX_HELD_SOURCES))
      if (Array.isArray(pair) && isSource(pair[0]) && isId(pair[1])) heldSources.set(pair[0], pair[1])
  return { messages: parsed.messages.flatMap(readPending), heldSources }
}

/** A command a held message came in on, as the conversation host names one. */
function isSource(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0 && value.length <= 1_000
}

function readPending(raw: unknown): Pending[] {
  if (!isRecord(raw) || !isId(raw.id) || !isId(raw.workspaceId) || !isId(raw.agentId)) return []
  // Written by a build before it, a message carries nothing.
  const carried = raw.queued === true ? readCarried(raw.carried) : undefined
  if (typeof raw.text !== 'string' || raw.text.length > MAX_SCHEDULED_MESSAGE_LENGTH) return []
  if (!raw.text.trim() && !carried) return []
  if (!isTime(raw.sendAt) || !isTime(raw.createdAt)) return []
  return [
    {
      id: raw.id,
      workspaceId: raw.workspaceId,
      agentId: raw.agentId,
      text: raw.text,
      sendAt: raw.sendAt,
      createdAt: raw.createdAt,
      ...(isTime(raw.waitingSince) ? { waitingSince: raw.waitingSince } : {}),
      ...(raw.queued === true ? { queued: true as const } : {}),
      ...(USAGE_LIMIT_PROVIDERS.includes(raw.untilLimitReset as UsageLimitProvider)
        ? { untilLimitReset: raw.untilLimitReset as UsageLimitProvider }
        : {}),
      ...(typeof raw.failure === 'string' && raw.failure ? { failure: failureWords(raw.failure) } : {}),
      ...(typeof raw.attempt === 'number' && Number.isInteger(raw.attempt) && raw.attempt > 0
        ? { attempt: raw.attempt }
        : {}),
      ...(Array.isArray(raw.sources) && raw.sources.every(isSource) && raw.sources.length
        ? { sources: [...raw.sources] }
        : {}),
      ...(carried ? { carried } : {}),
    },
  ]
}

// ── What a held message carries ───────────────────────────────────────────

const MAX_CARRIED_PATH = 4096
const MAX_CARRIED_NAME = 255

/** Names, as a window and a paired machine are told them; null when it carries nothing. */
function carriesOf(carried: ScheduledMessageCarried | undefined): ScheduledMessageCarries | null {
  if (!carried) return null
  const carries: ScheduledMessageCarries = {
    ...(carried.images?.length ? { images: carried.images.map((image) => image.name) } : {}),
    ...(carried.files?.length ? { files: carried.files.map((file) => file.name) } : {}),
    ...(carried.skills?.length ? { skills: [...carried.skills] } : {}),
    ...(carried.mentions?.length ? { mentions: carried.mentions.map((mention) => ({ ...mention })) } : {}),
  }
  return Object.keys(carries).length ? carries : null
}

/**
 * What two held messages carry as one, or null when that is more than one
 * message takes: pictures and files together as a send's attachments are
 * bounded, skills and mentions as a send's are.
 */
function joinCarried(
  held: ScheduledMessageCarried | undefined,
  more: ScheduledMessageCarried | undefined,
): ScheduledMessageCarried | null {
  if (!more) return held ?? {}
  const images = [...(held?.images ?? []), ...(more.images ?? [])]
  const files = [...(held?.files ?? []), ...(more.files ?? [])]
  const skills = [...new Set([...(held?.skills ?? []), ...(more.skills ?? [])])]
  const seen = new Set<string>()
  const mentions = [...(held?.mentions ?? []), ...(more.mentions ?? [])].filter((mention) => {
    const named = JSON.stringify([mention.path, mention.kind, mention.line, mention.endLine])
    if (seen.has(named)) return false
    seen.add(named)
    return true
  })
  if (images.length + files.length > MAX_ATTACHMENTS_PER_TURN) return null
  if (skills.length > CONVERSATION_MAX_SEND_SKILLS || mentions.length > CONVERSATION_MAX_SEND_MENTIONS) return null
  return {
    ...(images.length ? { images } : {}),
    ...(files.length ? { files } : {}),
    ...(skills.length ? { skills } : {}),
    ...(mentions.length ? { mentions } : {}),
  }
}

function carriedPath(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0 && value.length <= MAX_CARRIED_PATH
}
function carriedName(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0 && value.length <= MAX_CARRIED_NAME
}
function carriedBytes(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value > 0
}

/** What a held message carries, as the file kept it; an entry it cannot read is left out. */
function readCarried(raw: unknown): ScheduledMessageCarried | undefined {
  if (!isRecord(raw)) return undefined
  const images = (Array.isArray(raw.images) ? raw.images : []).flatMap((image: unknown) =>
    isRecord(image) &&
    carriedPath(image.path) &&
    carriedName(image.name) &&
    ATTACHABLE_IMAGE_TYPES.includes(image.mediaType as (typeof ATTACHABLE_IMAGE_TYPES)[number]) &&
    carriedBytes(image.bytes)
      ? [{ path: image.path, name: image.name, mediaType: image.mediaType as string, bytes: image.bytes }]
      : [],
  )
  const files = (Array.isArray(raw.files) ? raw.files : []).flatMap((file: unknown) =>
    isRecord(file) && carriedPath(file.path) && carriedName(file.name) && carriedBytes(file.bytes)
      ? [{ path: file.path, name: file.name, bytes: file.bytes }]
      : [],
  )
  const skills = (Array.isArray(raw.skills) ? raw.skills : []).filter(
    (skill: unknown): skill is string => typeof skill === 'string' && isId(skill),
  )
  const mentions = raw.mentions === undefined ? [] : (parseConversationWireMentions(raw.mentions) ?? [])
  const carried = joinCarried(undefined, { images, files, skills, mentions })
  return carried && carriesOf(carried) ? carried : undefined
}

/** A refusal in a few words, one line, as the tray shows it. */
function failureWords(message: string | undefined): string {
  const flat = (message ?? '').replace(/\s+/gu, ' ').trim().replace(/\.$/u, '')
  if (!flat) return 'the chat refused it'
  return flat.length > MAX_FAILURE_LENGTH ? `${flat.slice(0, MAX_FAILURE_LENGTH - 1).trimEnd()}…` : flat
}
