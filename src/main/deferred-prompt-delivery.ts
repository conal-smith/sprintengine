import { bracketedTerminalPaste } from '../shared/terminal-paste'

// Delivering a first message the launch's command line could not carry.
//
// `planAgentLaunch` moves a prompt that is too long for the platform's argv off
// the command line, and the CLI starts without it. This types it in: one
// bracketed paste and one Enter, written into the pty once the CLI is ready for
// input — exactly once, and never after the CLI has gone.
//
// "Ready" is read from the CLI's own output, because every agent CLI the app
// drives says so the same way: its line editor turns on bracketed paste
// (`ESC[?2004h`) when it starts reading. That is necessary but not sufficient —
// verified against the installed CLIs, Claude Code turns it on ~200 ms in but
// drops a paste that arrives before it has finished drawing its first screen,
// ~1 s in; a paste written once output had been quiet for half a second after
// the mode came on landed every time, in Claude Code, Codex and Cursor alike.
// So the paste waits for the mode AND a quiet screen. A lifecycle hook frame
// (SessionStart) counts as the mode for a CLI that reports one without drawing
// a line editor the mode test would recognise.
//
// Two ways out that are not a delivery: the CLI exits first (nothing is written;
// there is nobody left to read it), or the delivery is cancelled with the
// session. And one fallback: a CLI that never turns the mode on still gets the
// message once the fallback window has passed, because a prompt that never
// arrives is the failure this exists to prevent.
//
// Some CLIs turn the mode on for a dialog before their composer — Kimi Code's
// "Trust this folder?" does, with "Trust" selected, so the Enter would trust the
// folder. Their manifests declare an `output-match` readiness instead: the
// message waits for text only the composer screen prints, and a CLI that never
// prints it within the window gets nothing typed at all. That is abandoned as
// `not-ready`, and the caller hands the message back to the person rather than
// typing it blind into a screen nobody recognised.
//
// "The CLI exits" is not the pty exiting. An agent launch runs the CLI from a
// startup script that then execs an interactive shell, and a modern shell turns
// bracketed paste on too: a CLI that died at startup would hand the message to
// the shell, whose Enter runs it. So a launch whose prompt is typed in prints
// `CLI_EXITED_SENTINEL` (an OSC nothing renders) between the CLI and the shell,
// and seeing it abandons the delivery exactly as a pty exit does.

/** The sequence a line editor writes when it starts accepting bracketed pastes. */
const BRACKETED_PASTE_ON = '\x1b[?2004h'
/**
 * What a launch whose prompt is typed in prints once its CLI has exited, before
 * the shell the startup script ends in. An OSC with a private number: a
 * terminal that does not know it (xterm.js among them) shows nothing.
 */
export const CLI_EXITED_OSC = '6973;sprintengine-cli-exited'
export const CLI_EXITED_SENTINEL = `\x1b]${CLI_EXITED_OSC}\x07`
/**
 * The message as it is typed. A paste marker inside it would end the bracketed
 * block early and send the rest as keystrokes, and a carriage return (a pasted
 * progress bar, a CRLF log) reads as a submit to some line editors; other C0
 * controls (^C, ^D) are keys, not text. Tabs, newlines and ESC-led colour codes
 * are kept: inside the block they are text.
 *
 * The markers go last and until none is left: removing one marker, or a
 * control character, can join the text either side of it into another.
 */
export function sanitizeTypedPrompt(text: string): string {
  let clean = text.replace(/\r\n?/g, '\n').replace(/[\x00-\x08\x0b\x0c\x0e-\x1a\x1c-\x1f\x7f]/g, '')
  for (let previous = ''; previous !== clean;) {
    previous = clean
    clean = clean.replace(/\x1b\[20[01]~/g, '')
  }
  return clean
}
/** How long output must have been quiet, once the CLI is reading, before the paste goes. */
export const DEFERRED_PROMPT_QUIET_MS = 500
/** From spawn: past this, the message goes whatever the CLI has or has not said. */
export const DEFERRED_PROMPT_FALLBACK_MS = 20_000
/** How much earlier output an `output-match` pattern can still see, so a match split across chunks is found. */
const OUTPUT_MATCH_CARRY = 1_024

/**
 * What counts as "the CLI is ready" (a manifest's `promptInjection.readiness`).
 * `bracketed-paste` — the mode sequence or a hook frame, and a send on timeout.
 * `output-match` — `pattern` in the output or a hook frame, and no send on
 * timeout.
 */
export type DeferredPromptReadiness =
  { type: 'bracketed-paste'; timeoutMs?: number } | { type: 'output-match'; pattern: RegExp; timeoutMs: number }
/**
 * Between the paste and the Enter. The Enter is a separate write because an
 * Enter inside the bracketed block is text, not a submit; the gap grows with the
 * paste so a CLI still consuming a large one sees the Enter after it, not in it.
 */
export function deferredPromptSubmitDelayMs(text: string): number {
  return Math.min(1_500, Math.max(150, Math.round(text.length / 1_000)))
}

const POLL_MS = 50

type Timers = {
  now(): number
  setTimeout(callback: () => void, ms: number): unknown
  clearTimeout(handle: unknown): void
}

const realTimers: Timers = {
  now: () => Date.now(),
  setTimeout: (callback, ms) => setTimeout(callback, ms),
  clearTimeout: (handle) => clearTimeout(handle as ReturnType<typeof setTimeout>),
}

export type DeferredPromptOutcome =
  | { kind: 'delivered'; via: 'ready' | 'fallback'; atMs: number }
  | { kind: 'abandoned'; reason: 'exited' | 'cancelled' | 'write-failed' | 'not-ready' }

export type DeferredPromptDelivery = {
  /** Every chunk the CLI writes, in order. */
  observeOutput(data: string): void
  /** A lifecycle hook frame arrived for this session. */
  observeHookFrame(): void
  /** The CLI exited: nothing more will be written. */
  observeExit(): void
  /** The session is being torn down. */
  cancel(): void
  /**
   * A paste someone else is writing into this session before the message has
   * gone (the composer's skill prefill, a person's paste). Held and written
   * after the message's Enter, so it neither joins the message nor is submitted
   * with it; dropped if the message is abandoned, since there is then no line
   * editor to take it (a paste into the shell the CLI left behind would run).
   * False when nothing is pending and the caller should write it itself.
   */
  holdPaste(data: string): boolean
  /** True once the message has been written or given up on. */
  readonly settled: boolean
}

export function createDeferredPromptDelivery(input: {
  text: string
  /** Writes into the session's pty. May throw when the pty is gone. */
  write(data: string): void
  /** Told once, when the delivery settles either way. */
  onSettled?(outcome: DeferredPromptOutcome): void
  /** Absent is `bracketed-paste` with the default window. */
  readiness?: DeferredPromptReadiness
  timers?: Timers
}): DeferredPromptDelivery {
  const timers = input.timers ?? realTimers
  const text = sanitizeTypedPrompt(input.text)
  const readiness: DeferredPromptReadiness = input.readiness ?? { type: 'bracketed-paste' }
  // A global or sticky regex carries `lastIndex` between tests; a copy without
  // those flags answers the same question statelessly.
  const readyPattern =
    readiness.type === 'output-match'
      ? new RegExp(readiness.pattern.source, readiness.pattern.flags.replace(/[gy]/g, ''))
      : null
  const startedAt = timers.now()
  const held: string[] = []
  let exitCarry = ''
  let lastOutputAt = startedAt
  let reading = false
  // The tail of the previous chunk, so the mode sequence split across two
  // chunks is still seen.
  let carry = ''
  let settled = false
  let pasted = false
  let readyPoll: unknown = null
  let submitTimer: unknown = null
  // `bracketed-paste` types the message on timeout. `output-match` does only if
  // the composer was recognised and the screen simply never went quiet;
  // otherwise it gives up, because what is on screen is not a screen its
  // manifest recognised.
  const fallbackTimer = timers.setTimeout(
    () => (readyPattern && !reading ? settle({ kind: 'abandoned', reason: 'not-ready' }) : deliver('fallback')),
    readiness.timeoutMs ?? DEFERRED_PROMPT_FALLBACK_MS,
  )

  const clearTimers = (): void => {
    timers.clearTimeout(fallbackTimer)
    if (readyPoll !== null) timers.clearTimeout(readyPoll)
    readyPoll = null
  }

  const settle = (outcome: DeferredPromptOutcome): void => {
    if (settled) return
    settled = true
    clearTimers()
    if (submitTimer !== null) timers.clearTimeout(submitTimer)
    submitTimer = null
    // Only after a delivery is there a line editor to take them; a CLI that
    // is gone, or a session being torn down, has none.
    const release = outcome.kind === 'delivered' ? held.splice(0) : []
    held.length = 0
    input.onSettled?.(outcome)
    for (const data of release) {
      try {
        input.write(data)
      } catch {
        break
      }
    }
  }

  const deliver = (via: 'ready' | 'fallback'): void => {
    if (settled || pasted) return
    pasted = true
    clearTimers()
    try {
      input.write(bracketedTerminalPaste(text))
    } catch {
      settle({ kind: 'abandoned', reason: 'write-failed' })
      return
    }
    submitTimer = timers.setTimeout(() => {
      submitTimer = null
      if (settled) return
      try {
        input.write('\r')
      } catch {
        settle({ kind: 'abandoned', reason: 'write-failed' })
        return
      }
      settle({ kind: 'delivered', via, atMs: timers.now() - startedAt })
    }, deferredPromptSubmitDelayMs(text))
  }

  const pollForQuiet = (): void => {
    readyPoll = null
    if (settled || pasted) return
    const quietFor = timers.now() - lastOutputAt
    if (quietFor >= DEFERRED_PROMPT_QUIET_MS) {
      deliver('ready')
      return
    }
    readyPoll = timers.setTimeout(pollForQuiet, Math.max(POLL_MS, DEFERRED_PROMPT_QUIET_MS - quietFor))
  }

  const markReading = (): void => {
    if (reading || settled || pasted) return
    reading = true
    readyPoll = timers.setTimeout(pollForQuiet, DEFERRED_PROMPT_QUIET_MS)
  }

  return {
    observeOutput(data: string): void {
      if (settled) return
      const exitWindow = exitCarry + data
      if (exitWindow.includes(CLI_EXITED_SENTINEL)) {
        settle({ kind: 'abandoned', reason: 'exited' })
        return
      }
      exitCarry = exitWindow.slice(-(CLI_EXITED_SENTINEL.length - 1))
      if (pasted) return
      lastOutputAt = timers.now()
      if (reading) return
      const window = carry + data
      if (readyPattern) {
        if (readyPattern.test(window)) markReading()
        else carry = window.slice(-OUTPUT_MATCH_CARRY)
        return
      }
      if (window.includes(BRACKETED_PASTE_ON)) markReading()
      else carry = window.slice(-(BRACKETED_PASTE_ON.length - 1))
    },
    observeHookFrame(): void {
      markReading()
    },
    observeExit(): void {
      // An exit after the paste but before its Enter still abandons: the text
      // went nowhere a person will see submitted.
      settle({ kind: 'abandoned', reason: 'exited' })
    },
    cancel(): void {
      settle({ kind: 'abandoned', reason: 'cancelled' })
    },
    holdPaste(data: string): boolean {
      if (settled) return false
      held.push(data)
      return true
    },
    get settled(): boolean {
      return settled
    },
  }
}
