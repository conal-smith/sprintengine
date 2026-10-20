// When a chat's current stretch of work began: the "working for" count its
// sidebar row shows, on this desktop and on every paired machine that lists
// the chat.
//
// A stretch begins when a person sends the chat a message. It carries on
// through every turn the chat opens by itself while it still has work in
// hand: a background agent's result waking it, a monitor reporting, an agent
// carrying on toward its goal, a message Studio sends it (a launched agent's
// notice, a resume after a usage limit). It ends once the chat settles with
// nothing working, not even in the background. A turn's own start
// (`turnStartedAt`) cannot say this: every turn the chat opens by itself
// restarts it, so a chat whose background agent woke it a dozen times read
// "5s" on a paired machine while its own desktop read "14m".
//
// Kept by the runtime, which sees every turn open and every event land, and
// reported on the session's summary as `workingSince`. The desktop's sidebar
// and the paired machines' lists both read that one value, so the two cannot
// count differently.

/** A stretch of work, as the runtime holds it between readings. */
export type WorkingStretch = {
  /** When the person's message that began it was sent, or the turn that began it opened. */
  since: number
  /** When the chat last stopped having anything in hand; absent while it does. */
  stoppedAt?: number
}

/**
 * How long a chat may sit with nothing in hand and the turn it opens next
 * still belong to the same stretch. A background agent's result is what wakes
 * the chat, so the last agent ending leaves it idle for the moment between
 * that and the model's next reply; that moment is not the work being done.
 */
export const WORKING_STRETCH_GAP_MS = 30_000

function carriesOn(held: WorkingStretch, at: number): boolean {
  return held.stoppedAt === undefined || at - held.stoppedAt <= WORKING_STRETCH_GAP_MS
}

/**
 * A turn opened. A person's message begins a new stretch; a turn the chat
 * opens by itself, or a message Studio sends it, carries on the one it is in,
 * if it is still in one.
 */
export function workingStretchOnTurn(
  held: WorkingStretch | undefined,
  turn: { at: number; byPerson: boolean },
): WorkingStretch {
  if (!turn.byPerson && held && carriesOn(held, turn.at)) return { since: held.since }
  return { since: turn.at }
}

/**
 * Whether the chat has anything in hand now (`busy`: a turn running or waiting
 * on the person, a background agent, a monitor that will wake it), read after
 * every change. A stretch that stops is kept for the gap, so a turn opened
 * straight after carries it on; one that comes back to work with no turn
 * opening (an answer to a card) carries on as well. `startedAt` begins one
 * when there is none: the turn now running, where there is one.
 */
export function workingStretchOnReading(
  held: WorkingStretch | undefined,
  reading: { busy: boolean; at: number; startedAt?: number },
): WorkingStretch | undefined {
  if (reading.busy) {
    if (held && held.stoppedAt === undefined) return held
    if (held && carriesOn(held, reading.at)) return { since: held.since }
    return { since: reading.startedAt ?? reading.at }
  }
  if (!held) return undefined
  if (held.stoppedAt === undefined) return { since: held.since, stoppedAt: reading.at }
  return carriesOn(held, reading.at) ? held : undefined
}

/** The start a stretch reports while it runs; none once it has stopped. */
export function workingStretchSince(held: WorkingStretch | undefined): number | undefined {
  return held && held.stoppedAt === undefined ? held.since : undefined
}
