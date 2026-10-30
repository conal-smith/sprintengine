// Resuming a paused agent terminal without the view tearing.
//
// A paused (suspended) agent keeps its painted screen: the frozen snapshot is
// replayed into the xterm and stays readable while no process runs. Resuming
// relaunches the CLI under the same session with its own resume flag, and a CLI
// that resumes a conversation re-renders that conversation itself. Claude Code
// `--resume`, for one, prints its banner and the whole transcript inline, into
// the normal screen buffer, starting wherever the cursor happens to be.
//
// Appending that below the snapshot is what put the history on screen twice:
// once as the frozen copy, pushed up into scrollback, and once as the CLI's own
// render underneath it. Painting it chunk by chunk is what made the screen
// visibly empty and refill.
//
// So the relaunched CLI's output is held here, off screen, while the frozen
// view stays up. It is released once the CLI's first frame has landed: some
// visible text has arrived and the stream has then gone quiet for a moment.
// The caller then swaps the frozen view for that frame in one synchronized
// write (`composeResumeSwap`). The scrollback ends up holding the history once,
// as the CLI rendered it, and there is no frame in which the pane is blank.
//
// The timers exist for CLIs that do not behave like that:
//
//   - `firstFrameDeadlineMs` counts from the first byte, for a CLI that asks
//     the terminal something (a cursor-position report, a device-attributes
//     query) and waits for the answer before drawing. Nothing answers a held
//     query, so holding past the CLI's own timeout would break its start-up;
//     the deadline releases the query in time for xterm to answer it.
//   - `maxFrameMs` counts from the first visible text, for a CLI that never
//     goes quiet. The frame is shown by then whether or not it is finished.
//
// An exit releases what was held without swapping: a CLI that died during
// start-up leaves its error under the frozen view, not in place of it.
//
// A replay ends the hold too, and drops what it held: main repaints the whole
// pane from the resumed session's retained stream (the pane was hidden before
// the relaunched CLI was first sent anything, so there was nothing to catch up
// from), and that stream already holds every byte the hold did. Kept armed,
// the hold would swallow the next live chunk and release it as a swap whose
// clear erases the transcript the replay just painted.

/** Why the held output was let go. */
export type ResumeHoldReleaseReason = 'settled' | 'deadline' | 'max' | 'exit' | 'replaced'

export type ResumeHoldRelease = {
  /** Everything the relaunched CLI wrote while held, in arrival order. */
  data: string
  /**
   * Replace the frozen view with `data` (true), or write `data` after it
   * (false). False on an exit, for a relaunch that does not resume a
   * conversation (the frozen view is the only copy of that history), and
   * when nothing was held.
   */
  replaceFrozenView: boolean
  reason: ResumeHoldReleaseReason
}

export type ResumeHoldTiming = {
  settleQuietMs: number
  firstFrameDeadlineMs: number
  maxFrameMs: number
}

// Measured against Claude Code 2.1 resuming a conversation: its first bytes
// (mode sets and three terminal queries) arrive about 160ms after spawn, it
// waits roughly 300ms for answers it does not need, and its banner plus the
// transcript arrive in two writes about 60ms apart. A 150ms quiet window sits
// well clear of that gap. The 1s deadline sits under the 2s a CLI built on a
// cursor-position query typically allows before it gives up.
export const RESUME_HOLD_TIMING: ResumeHoldTiming = {
  settleQuietMs: 150,
  firstFrameDeadlineMs: 1000,
  maxFrameMs: 2000,
}

type TimerHandle = unknown

export type ResumeHoldTimers = {
  set: (callback: () => void, ms: number) => TimerHandle
  clear: (handle: TimerHandle) => void
}

const defaultTimers: ResumeHoldTimers = {
  set: (callback, ms) => setTimeout(callback, ms),
  clear: (handle) => clearTimeout(handle as ReturnType<typeof setTimeout>),
}

/**
 * Scan `text` from `from` for a character that paints something: anything
 * other than whitespace, C0/C1 controls and escape sequences.
 *
 * Returns `printable: true` at the first such character. Otherwise returns the
 * index to resume from on the next call — the start of an escape sequence the
 * text ends in the middle of, so a sequence split across two pty chunks is
 * never mistaken for text (`ESC[?10` + `49h` must not read as "49h").
 */
export function scanForPrintable(text: string, from = 0): { printable: boolean; resumeAt: number } {
  let index = from
  const length = text.length
  while (index < length) {
    const code = text.charCodeAt(index)
    if (code === 0x1b) {
      const kind = text[index + 1]
      if (kind === undefined) return { printable: false, resumeAt: index }
      if (kind === '[') {
        // CSI: parameters and intermediates, then one final byte in 0x40–0x7e,
        // unless CAN or SUB cancels it first.
        let cursor = index + 2
        while (cursor < length) {
          const byte = text.charCodeAt(cursor)
          if ((byte >= 0x40 && byte <= 0x7e) || byte === 0x18 || byte === 0x1a) break
          cursor += 1
        }
        if (cursor >= length) return { printable: false, resumeAt: index }
        index = cursor + 1
        continue
      }
      if (kind === ']' || kind === 'P' || kind === '_' || kind === '^' || kind === 'X') {
        // OSC / DCS / APC / PM / SOS: a string ended by BEL or ST (ESC \), or
        // cancelled by CAN or SUB, after which the text is painted again.
        const bell = text.indexOf('\x07', index + 2)
        const st = text.indexOf('\x1b\\', index + 2)
        const cancel = text.slice(index + 2).search(/[\x18\x1a]/)
        const ends = [
          bell === -1 ? -1 : bell + 1,
          st === -1 ? -1 : st + 2,
          cancel === -1 ? -1 : index + 2 + cancel + 1,
        ].filter((end) => end > 0)
        if (ends.length === 0) return { printable: false, resumeAt: index }
        index = Math.min(...ends)
        continue
      }
      if ('()*+-./#%'.includes(kind)) {
        // Charset designation and friends: one more byte.
        if (index + 2 >= length) return { printable: false, resumeAt: index }
        index += 3
        continue
      }
      index += 2
      continue
    }
    // Space, C0 controls, DEL and C1 controls paint nothing.
    if (code <= 0x20 || (code >= 0x7f && code <= 0x9f)) {
      index += 1
      continue
    }
    return { printable: true, resumeAt: index }
  }
  return { printable: false, resumeAt: length }
}

// Synchronized output (DEC mode 2026): xterm stops rendering at BSU and paints
// the finished buffer at ESU, so the clear and the new frame reach the screen
// together. Any pair the CLI wrote itself is taken out of the held text first,
// because its ESU would end ours early and paint the half-written swap.
const BEGIN_SYNCHRONIZED_UPDATE = '\x1b[?2026h'
const END_SYNCHRONIZED_UPDATE = '\x1b[?2026l'
const SYNCHRONIZED_UPDATE_RE = /\x1b\[\?2026[hl]/g
// Reset attributes first (an erase paints in the current background), home the
// cursor, erase the screen, then erase the scrollback: the relaunched CLI
// starts from the top-left of an empty terminal, which is where it believes it
// is, and the frozen copy of the history is gone before the new one lands.
const CLEAR_FROZEN_VIEW = '\x1b[0m\x1b[H\x1b[2J\x1b[3J'

/** The single write that swaps the frozen view for the resumed CLI's frame. */
export function composeResumeSwap(held: string): string {
  return (
    BEGIN_SYNCHRONIZED_UPDATE + CLEAR_FROZEN_VIEW + held.replace(SYNCHRONIZED_UPDATE_RE, '') + END_SYNCHRONIZED_UPDATE
  )
}

/** The text to write for a release: the swap, or the held output as-is. */
export function resumeReleasePayload(release: ResumeHoldRelease): string {
  return release.replaceFrozenView ? composeResumeSwap(release.data) : release.data
}

export function createResumeHold({
  onRelease,
  timing = RESUME_HOLD_TIMING,
  timers = defaultTimers,
}: {
  onRelease: (release: ResumeHoldRelease) => void
  timing?: ResumeHoldTiming
  timers?: ResumeHoldTimers
}) {
  let holding = false
  let replaceFrozenView = false
  let held = ''
  let scanFrom = 0
  let sawPrintable = false
  let deadlineTimer: TimerHandle | null = null
  let maxTimer: TimerHandle | null = null
  let quietTimer: TimerHandle | null = null

  const clearTimer = (handle: TimerHandle | null): null => {
    if (handle !== null) timers.clear(handle)
    return null
  }

  const clearAllTimers = () => {
    deadlineTimer = clearTimer(deadlineTimer)
    maxTimer = clearTimer(maxTimer)
    quietTimer = clearTimer(quietTimer)
  }

  const release = (reason: ResumeHoldReleaseReason) => {
    if (!holding) return
    holding = false
    clearAllTimers()
    const data = reason === 'replaced' ? '' : held
    held = ''
    scanFrom = 0
    sawPrintable = false
    onRelease({ data, replaceFrozenView: reason !== 'exit' && replaceFrozenView && data.length > 0, reason })
  }

  return {
    /** Start holding. Call before the relaunch, so its first byte is caught. */
    arm: (options: { replaceFrozenView: boolean }) => {
      clearAllTimers()
      holding = true
      replaceFrozenView = options.replaceFrozenView
      held = ''
      scanFrom = 0
      sawPrintable = false
    },
    isHolding: () => holding,
    /** Take a chunk of the relaunched CLI's output. False when not holding. */
    push: (data: string): boolean => {
      if (!holding) return false
      if (!data) return true
      if (held.length === 0) {
        deadlineTimer = timers.set(() => release('deadline'), timing.firstFrameDeadlineMs)
      }
      held += data
      if (!sawPrintable) {
        const scan = scanForPrintable(held, scanFrom)
        scanFrom = scan.resumeAt
        if (scan.printable) {
          sawPrintable = true
          deadlineTimer = clearTimer(deadlineTimer)
          maxTimer = timers.set(() => release('max'), timing.maxFrameMs)
        }
      }
      if (sawPrintable) {
        quietTimer = clearTimer(quietTimer)
        quietTimer = timers.set(() => release('settled'), timing.settleQuietMs)
      }
      return true
    },
    /** Let go of whatever is held without swapping (the process exited). */
    releaseForExit: () => release('exit'),
    /** End the hold and drop what it held: a replay carrying all of it is being painted. */
    releaseForReplay: () => release('replaced'),
    dispose: () => {
      holding = false
      held = ''
      clearAllTimers()
    },
  }
}

export type ResumeHold = ReturnType<typeof createResumeHold>
