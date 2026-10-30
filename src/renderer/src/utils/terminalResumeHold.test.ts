import assert from 'node:assert/strict'
import { Terminal } from '@xterm/headless'
import { test } from 'vitest'
import {
  composeResumeSwap,
  createResumeHold,
  RESUME_HOLD_TIMING,
  resumeReleasePayload,
  scanForPrintable,
  type ResumeHoldRelease,
  type ResumeHoldTimers,
} from './terminalResumeHold'

// A clock the test advances by hand, so every release is a decision the test
// can name rather than a race it hopes to win.
function createManualClock() {
  let now = 0
  let nextId = 1
  const pending = new Map<number, { at: number; callback: () => void }>()
  const timers: ResumeHoldTimers = {
    set: (callback, ms) => {
      const id = nextId++
      pending.set(id, { at: now + ms, callback })
      return id
    },
    clear: (handle) => {
      pending.delete(handle as number)
    },
  }
  const advance = (ms: number) => {
    const until = now + ms
    for (;;) {
      const due = [...pending.entries()].filter(([, timer]) => timer.at <= until).sort((a, b) => a[1].at - b[1].at)[0]
      if (!due) break
      pending.delete(due[0])
      now = due[1].at
      due[1].callback()
    }
    now = until
  }
  return { timers, advance, pendingCount: () => pending.size }
}

function createHold() {
  const clock = createManualClock()
  const releases: ResumeHoldRelease[] = []
  const hold = createResumeHold({ onRelease: (release) => releases.push(release), timers: clock.timers })
  return { hold, clock, releases }
}

// The shape of a conversation resume as the CLI writes it to a fresh pty: mode
// sets and terminal queries first (no text), then the banner and the whole
// transcript in one burst, then the prompt a moment later.
const BOOT_PRELUDE = ['\x1b7\x1b[r\x1b8\x1b[?25h', '\x1b[?25l\x1b[?2004h\x1b[?1004h', '\x1b[>0q\x1b[?u\x1b[c']
function transcript(lines: number): string {
  return Array.from({ length: lines }, (_, index) => `history line ${index + 1}`).join('\r\r\n') + '\r\r\n'
}
const PROMPT = '\x1b[38;2;136;136;136m────────\x1b[39m\r\r\n❯ \r\r\n'

test('a printable scan skips controls and escapes and resumes inside a split sequence', () => {
  assert.equal(scanForPrintable('\x1b[?2004h\r\n \t').printable, false)
  assert.equal(scanForPrintable('\x1b]0;title\x07\x1b]8;;https://example.com\x1b\\').printable, false)
  assert.equal(scanForPrintable('\x1b(B\x1b7\x1b8').printable, false)
  assert.deepEqual(scanForPrintable('\x1b[2Jx'), { printable: true, resumeAt: 4 })
  // CAN and SUB cancel a sequence, and what follows them paints.
  assert.deepEqual(scanForPrintable('\x1b]0;title\x18x'), { printable: true, resumeAt: 10 })
  assert.deepEqual(scanForPrintable('\x1b[12\x1ax'), { printable: true, resumeAt: 5 })

  // An escape cut off at the end of a chunk is not text, and the next scan
  // starts at its ESC so the rest of it is read as part of the sequence.
  const first = scanForPrintable('\x1b[?10')
  assert.deepEqual(first, { printable: false, resumeAt: 0 })
  assert.equal(scanForPrintable('\x1b[?1049h', first.resumeAt).printable, false)
  const osc = scanForPrintable('\x1b]0;half a tit')
  assert.equal(osc.printable, false)
  assert.equal(osc.resumeAt, 0)
})

test('the first frame is released once, as a swap, after it goes quiet', () => {
  const { hold, clock, releases } = createHold()
  hold.arm({ replaceFrozenView: true })

  for (const chunk of BOOT_PRELUDE) assert.equal(hold.push(chunk), true)
  clock.advance(300)
  assert.equal(releases.length, 0, 'queries and mode sets alone are not a frame')

  hold.push(transcript(40))
  clock.advance(RESUME_HOLD_TIMING.settleQuietMs - 1)
  hold.push(PROMPT)
  clock.advance(RESUME_HOLD_TIMING.settleQuietMs - 1)
  assert.equal(releases.length, 0, 'still arriving: the quiet window restarts on every chunk')

  clock.advance(1)
  assert.equal(releases.length, 1)
  assert.equal(releases[0]!.reason, 'settled')
  assert.equal(releases[0]!.replaceFrozenView, true)
  assert.equal(releases[0]!.data, BOOT_PRELUDE.join('') + transcript(40) + PROMPT, 'every byte, in order')
  assert.equal(clock.pendingCount(), 0, 'no timer outlives the release')

  assert.equal(hold.isHolding(), false)
  assert.equal(hold.push('live'), false, 'after the release, output is live again')
  clock.advance(10_000)
  assert.equal(releases.length, 1)
})

test('a CLI waiting on a query is released by the deadline, counted from its first byte', () => {
  const { hold, clock, releases } = createHold()
  hold.arm({ replaceFrozenView: true })
  clock.advance(5_000)
  assert.equal(releases.length, 0, 'nothing held yet: the deadline has not started')

  hold.push('\x1b[?2004h\x1b[6n')
  clock.advance(RESUME_HOLD_TIMING.firstFrameDeadlineMs - 1)
  assert.equal(releases.length, 0)
  clock.advance(1)
  assert.equal(releases.length, 1)
  assert.equal(releases[0]!.reason, 'deadline')
  assert.equal(releases[0]!.replaceFrozenView, true)
  assert.equal(releases[0]!.data, '\x1b[?2004h\x1b[6n')
})

test('a stream that never goes quiet is shown at the frame ceiling', () => {
  const { hold, clock, releases } = createHold()
  hold.arm({ replaceFrozenView: true })
  hold.push('frame')
  for (let elapsed = 0; elapsed < RESUME_HOLD_TIMING.maxFrameMs - 100; elapsed += 100) {
    clock.advance(100)
    hold.push('.')
  }
  assert.equal(releases.length, 0)
  clock.advance(100)
  assert.equal(releases.length, 1)
  assert.equal(releases[0]!.reason, 'max')
})

test('an exit lets go without swapping, and a failed relaunch clears the hold', () => {
  const { hold, clock, releases } = createHold()
  hold.arm({ replaceFrozenView: true })
  hold.push('error: could not resume\r\n')
  hold.releaseForExit()
  assert.deepEqual(releases, [{ data: 'error: could not resume\r\n', replaceFrozenView: false, reason: 'exit' }])
  hold.releaseForExit()
  assert.equal(releases.length, 1, 'idempotent')

  hold.arm({ replaceFrozenView: true })
  hold.releaseForExit()
  assert.deepEqual(releases[1], { data: '', replaceFrozenView: false, reason: 'exit' }, 'nothing held: no swap')
  clock.advance(10_000)
  assert.equal(releases.length, 2)
})

test('a relaunch that does not resume a conversation keeps the frozen view', () => {
  const { hold, clock, releases } = createHold()
  hold.arm({ replaceFrozenView: false })
  hold.push('fresh session\r\n')
  clock.advance(RESUME_HOLD_TIMING.settleQuietMs)
  assert.equal(releases[0]!.replaceFrozenView, false)
  assert.equal(resumeReleasePayload(releases[0]!), 'fresh session\r\n', 'written after the frozen view as-is')
})

test('the swap is one synchronized update, and the CLI cannot end it early', () => {
  const swap = composeResumeSwap('a\x1b[?2026hb\x1b[?2026lc')
  assert.ok(swap.startsWith('\x1b[?2026h'))
  assert.ok(swap.endsWith('\x1b[?2026l'))
  assert.equal(swap.split('\x1b[?2026h').length - 1, 1)
  assert.equal(swap.split('\x1b[?2026l').length - 1, 1)
  assert.ok(swap.includes('abc'))
})

// End to end on a real xterm buffer: the frozen snapshot, then the resumed
// CLI's re-render of the same conversation.
test('after a resume the scrollback holds the history exactly once', async () => {
  const cols = 80
  const rows = 12
  const write = (term: Terminal, data: string) => new Promise<void>((resolve) => term.write(data, resolve))
  const count = (term: Terminal, needle: RegExp) => {
    const buffer = term.buffer.active
    let hits = 0
    for (let index = 0; index < buffer.length; index += 1) {
      if (needle.test(buffer.getLine(index)?.translateToString(true) ?? '')) hits += 1
    }
    return hits
  }
  const frozen = transcript(40) + PROMPT
  const resumed = BOOT_PRELUDE.join('') + transcript(40) + PROMPT

  // What appending did: the transcript lands below its own frozen copy.
  const appended = new Terminal({ cols, rows, scrollback: 5_000, allowProposedApi: true })
  await write(appended, frozen)
  await write(appended, resumed)
  assert.equal(count(appended, /^history line 7$/), 2, 'appending shows the history twice')

  // The swap: the frozen copy is gone and the CLI's own render is all there is.
  const swapped = new Terminal({ cols, rows, scrollback: 5_000, allowProposedApi: true })
  await write(swapped, frozen)
  await write(swapped, composeResumeSwap(resumed))
  assert.equal(count(swapped, /^history line 7$/), 1)
  assert.equal(count(swapped, /^history line 40$/), 1)
  assert.equal(count(swapped, /^❯/), 1, 'one prompt, not the frozen one as well')
  assert.equal(swapped.buffer.active.getLine(0)?.translateToString(true), 'history line 1', 'from the top')
  appended.dispose()
  swapped.dispose()
})
