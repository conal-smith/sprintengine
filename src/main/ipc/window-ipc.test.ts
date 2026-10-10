import assert from 'node:assert/strict'

import { offerDockDiff, type DockDiffRequest, type DockDiffTarget } from './dock-diff'
import { test } from 'vitest'

test('window-ipc', async () => {
  // The diff window's "Show in the app" hand-off (`window:dock-diff`).
  //
  // The protocol is tested rather than the Electron glue around it: this is where
  // the three review findings were. It used to broadcast — so two windows holding
  // the same workspace both opened a Diff tab and both flipped the sticky
  // preference — the request id was a process-wide counter any window could
  // guess, and an ack was believed whoever sent it.

  async function main(): Promise<void> {
    await assertNobodyTakesIt()
    await assertOnlyOneWindowIsAsked()
    await assertASecondWindowIsAskedWhenTheFirstDeclines()
    await assertAForgedAckIsIgnored()
    await assertIdsAreUnguessable()
    await assertTheWholeHandOffIsBudgeted()
    console.log('window-ipc.test.ts: ok')
  }

  /* ── harness ──────────────────────────────────────────────────────────────── */

  type FakeWindow = DockDiffTarget & { sent: DockDiffRequest[] }

  /** A window that records what it was asked, and answers however told to. */
  function fakeWindow(
    id: string,
    behaviour: (request: DockDiffRequest, ack: (from: unknown, requestId: unknown) => void) => void = () => {},
  ): FakeWindow {
    const win: FakeWindow = {
      id,
      sent: [],
      isDestroyed: () => false,
      send: (request) => {
        win.sent.push(request)
        behaviour(request, (from, requestId) => emit(from, requestId))
      },
    }
    return win
  }

  /** The ack bus: one set of listeners, exactly as `ipcMain.on` is. */
  const listeners = new Set<(from: unknown, requestId: unknown) => void>()
  function emit(from: unknown, requestId: unknown): void {
    for (const listener of [...listeners]) listener(from, requestId)
  }
  const subscribe = (listener: (from: unknown, requestId: unknown) => void): (() => void) => {
    listeners.add(listener)
    return () => listeners.delete(listener)
  }

  const PAYLOAD = {
    workspaceId: 'ws-1',
    repoRoot: '/repo',
    focusPath: '/repo/src/a.ts',
    focusKind: 'unstaged' as const,
  }

  function offer(targets: DockDiffTarget[], patch: Partial<Parameters<typeof offerDockDiff>[0]> = {}) {
    return offerDockDiff({ targets, payload: PAYLOAD, subscribe, waitMs: 20, totalMs: 200, ...patch })
  }

  /* ── the findings ─────────────────────────────────────────────────────────── */

  async function assertNobodyTakesIt(): Promise<void> {
    // No window holds this workspace. Every one is asked, none answers, and the
    // diff window is told so rather than closing itself over a tab that is not
    // there.
    const first = fakeWindow('a')
    const second = fakeWindow('b')
    assert.equal(await offer([first, second]), false)
    assert.equal(first.sent.length, 1)
    assert.equal(second.sent.length, 1)
    assert.equal(listeners.size, 0, 'and nothing is left subscribed to the ack channel')
    console.log('ok - silence from every window is an answer, not a hang')
  }

  async function assertOnlyOneWindowIsAsked(): Promise<void> {
    // The finding: a broadcast meant every holder opened a tab. The first window
    // takes it, and the second is never asked at all — so it cannot open a
    // second tab, and cannot flip the preference a second time.
    const taker = fakeWindow('a', (request, ack) => ack('a', request.requestId))
    const other = fakeWindow('b')
    assert.equal(await offer([taker, other]), true)
    assert.equal(taker.sent.length, 1)
    assert.deepEqual(other.sent, [], 'the second window never heard about it')
    console.log('ok - the diff is handed to one window, not broadcast to all of them')
  }

  async function assertASecondWindowIsAskedWhenTheFirstDeclines(): Promise<void> {
    // "Most likely holder first" is a guess, so a wrong guess must not lose the
    // hand-off: silence from the first window moves on to the next.
    const quiet = fakeWindow('a')
    const holder = fakeWindow('b', (request, ack) => ack('b', request.requestId))
    assert.equal(await offer([quiet, holder]), true)
    assert.equal(quiet.sent.length, 1)
    assert.equal(holder.sent.length, 1)
    console.log('ok - a window that stays quiet passes the offer along')
  }

  async function assertAForgedAckIsIgnored(): Promise<void> {
    // Two ways to ack something that was never asked of you, and both are
    // refused: the wrong sender with the right id, and the right sender with the
    // wrong id.
    const asked = fakeWindow('a', (request, ack) => {
      ack('impostor', request.requestId)
      ack('a', 'dock-diff:1')
    })
    assert.equal(await offer([asked]), false)
    console.log('ok - an ack is believed only from the window it was asked of, for the id it was sent')
  }

  async function assertIdsAreUnguessable(): Promise<void> {
    // The id was `dock-diff:<counter>`. Any window could ack the next one by
    // counting; `randomUUID` is what ends that, so the ids must not be a
    // sequence and must not repeat.
    const seen: string[] = []
    const win = fakeWindow('a', (request) => seen.push(request.requestId))
    await offer([win])
    await offer([win])
    assert.equal(seen.length, 2)
    assert.notEqual(seen[0], seen[1])
    for (const id of seen) {
      assert.match(id, /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/, 'a uuid, not a counter')
    }
    console.log('ok - every offer carries an id nobody can guess')
  }

  async function assertTheWholeHandOffIsBudgeted(): Promise<void> {
    // Per-window patience must not multiply into a hang: eight silent windows at
    // 20ms each stop at the total budget, whichever comes first.
    const windows = Array.from({ length: 8 }, (_, at) => fakeWindow(`w${at}`))
    const started = Date.now()
    assert.equal(await offer(windows, { waitMs: 20, totalMs: 60 }), false)
    assert.ok(Date.now() - started < 200, 'the offer stops at its budget rather than walking every window')
    assert.ok(
      windows.some((win) => win.sent.length === 0),
      'and the later windows were never reached',
    )
    console.log('ok - the hand-off has a budget for the whole walk, not only per window')
  }

  const suiteRun = main()

  await suiteRun
})

// The diff window's "Add to chat" (`window:diff-to-chat`): the same walk as
// the dock, and the input main refuses before any window is asked.

test('Add to chat is offered one window at a time, and answers the window that took it', async () => {
  const { offerToFirstTaker } = await import('./dock-diff')
  type Request = { requestId: string; workspaceId: string; text: string }
  const listeners = new Set<(from: unknown, requestId: unknown) => void>()
  const asked: string[] = []
  const target = (id: string, takes: boolean) => ({
    id,
    isDestroyed: () => false,
    send: (request: Request) => {
      asked.push(`${id}:${request.text}`)
      // A window that holds no chat for the workspace stays silent.
      if (takes) queueMicrotask(() => [...listeners].forEach((listener) => listener(id, request.requestId)))
    },
  })
  const taker = await offerToFirstTaker<Request>({
    targets: [target('front', false), target('back', true), target('third', true)],
    payload: { workspaceId: 'ws-1', text: '> `src/a.ts:L3`' },
    subscribe: (listener) => {
      listeners.add(listener)
      return () => listeners.delete(listener)
    },
    waitMs: 20,
    totalMs: 200,
  })
  assert.equal(taker?.id, 'back', 'the window that set it into its chat, which main brings forward')
  assert.deepEqual(asked, ['front:> `src/a.ts:L3`', 'back:> `src/a.ts:L3`'], 'and nobody after it')
})

test('Add to chat takes a workspace and bounded text, and nothing else', async () => {
  const { readDiffToChatInput } = await import('./dock-diff')
  assert.deepEqual(readDiffToChatInput({ workspaceId: 'ws-1', text: 'quote' }, 100), {
    workspaceId: 'ws-1',
    text: 'quote',
  })
  assert.equal(readDiffToChatInput({ workspaceId: 'ws-1', text: 'x'.repeat(101) }, 100), null, 'past the ceiling')
  assert.equal(readDiffToChatInput({ workspaceId: 'ws-1', text: '   ' }, 100), null, 'nothing to say')
  assert.equal(readDiffToChatInput({ workspaceId: '', text: 'quote' }, 100), null)
  assert.equal(readDiffToChatInput({ workspaceId: 7, text: 'quote' }, 100), null)
  assert.equal(readDiffToChatInput({ workspaceId: 'ws-1', text: { evil: true } }, 100), null)
  assert.equal(readDiffToChatInput(null, 100), null)
})
