import { expect, test } from 'vitest'

import type { SupervisorClock } from '../../../../packages/connection-supervisor/src/connectionSupervisor'
import { superviseTabSocket, WEB_CLOSE_REVOKED, type TabSocket } from './webReconnect'

// The web tab's socket on the connection supervisor, with the browser's
// WebSocket and its timers stood in for.

type Listener = (event: { code?: number }) => void

class FakeSocket implements TabSocket {
  readonly listeners: Record<string, Listener[]> = {}
  closedByTab = false
  addEventListener(type: 'open' | 'close', listener: Listener): void {
    ;(this.listeners[type] ??= []).push(listener)
  }
  close(): void {
    this.closedByTab = true
    this.emit('close', { code: 1000 })
  }
  emit(type: 'open' | 'close', event: { code?: number } = {}): void {
    for (const listener of this.listeners[type] ?? []) listener(event)
  }
}

function harness() {
  let now = 0
  const timers: Array<{ at: number; run: () => void; id: number }> = []
  let ids = 0
  const clock: SupervisorClock = {
    now: () => now,
    setTimeout: (run, ms) => {
      timers.push({ at: now + ms, run, id: ++ids })
      return ids
    },
    clearTimeout: (id) => {
      const index = timers.findIndex((timer) => timer.id === id)
      if (index >= 0) timers.splice(index, 1)
    },
  }
  const advance = async (ms: number) => {
    const end = now + ms
    for (;;) {
      await Promise.resolve()
      const due = timers.filter((timer) => timer.at <= end).sort((a, b) => a.at - b.at)[0]
      if (!due) break
      timers.splice(timers.indexOf(due), 1)
      now = due.at
      due.run()
    }
    now = end
    for (let i = 0; i < 10; i++) await Promise.resolve()
  }
  const sockets: FakeSocket[] = []
  const opened: Array<{ socket: FakeSocket; reopened: boolean }> = []
  const seen = { revoked: 0, refused: 0 }
  const tab = superviseTabSocket<FakeSocket>({
    open: () => {
      const socket = new FakeSocket()
      sockets.push(socket)
      return socket
    },
    onOpen: (socket, reopened) => opened.push({ socket, reopened }),
    onRevoked: () => (seen.revoked += 1),
    onRefused: () => (seen.refused += 1),
    clock,
    random: () => 1,
  })
  return { tab, sockets, opened, seen, advance }
}

test('the tab opens its socket, and after a drop reopens it on a jittered backoff, saying it was reopened', async () => {
  const { tab, sockets, opened, advance } = harness()
  tab.start()
  sockets[0]!.emit('open')
  await advance(0)
  expect(opened).toEqual([{ socket: sockets[0], reopened: false }])
  expect(tab.state().phase).toBe('up')
  // The server restarts: refused twice, then back.
  sockets[0]!.emit('close', { code: 1006 })
  await advance(250)
  expect(sockets).toHaveLength(2)
  sockets[1]!.emit('close', { code: 1006 })
  await advance(499)
  expect(sockets).toHaveLength(2)
  await advance(1)
  expect(sockets).toHaveLength(3)
  sockets[2]!.emit('open')
  await advance(0)
  expect(opened.at(-1)).toEqual({ socket: sockets[2], reopened: true })
})

test('a socket refused before it opened asks whether the browser is still paired', async () => {
  const { tab, sockets, seen, advance } = harness()
  tab.start()
  sockets[0]!.emit('close', { code: 1006 })
  await advance(0)
  expect(seen.refused).toBe(1)
  expect(tab.state().phase).toBe('backoff')
})

test('a removed browser goes back to pairing and stops trying', async () => {
  const { tab, sockets, seen, advance } = harness()
  tab.start()
  sockets[0]!.emit('open')
  await advance(0)
  sockets[0]!.emit('close', { code: WEB_CLOSE_REVOKED })
  await advance(60_000)
  expect(seen.revoked).toBe(1)
  expect(tab.state().phase).toBe('needs-sign-in')
  tab.wake()
  await advance(60_000)
  expect(sockets).toHaveLength(1)
})

test('back in front, a waiting tab tries at once, and an open one is left as it is', async () => {
  const { tab, sockets, advance } = harness()
  tab.start()
  sockets[0]!.emit('open')
  await advance(0)
  tab.wake()
  await advance(0)
  expect(sockets).toHaveLength(1)
  expect(sockets[0]!.closedByTab).toBe(false)
  sockets[0]!.emit('close', { code: 1006 })
  await advance(0)
  expect(tab.state().phase).toBe('backoff')
  const before = sockets.length
  tab.wake()
  expect(sockets).toHaveLength(before + 1)
})

test('a link slow to open is waited for, however slow, and attached when it opens', async () => {
  const { tab, sockets, opened, advance } = harness()
  tab.start()
  await advance(60_000)
  expect(tab.state().phase).toBe('connecting')
  expect(sockets).toHaveLength(1)
  sockets[0]!.emit('open')
  await advance(0)
  expect(opened).toEqual([{ socket: sockets[0], reopened: false }])
  expect(tab.state().phase).toBe('up')
})

test('a socket still opening when the tab stops trying is closed, and never attached', async () => {
  const { tab, sockets, opened, advance } = harness()
  tab.start()
  tab.stop('The page is going away.')
  expect(sockets[0]!.closedByTab).toBe(true)
  sockets[0]!.emit('open')
  await advance(0)
  expect(opened).toEqual([])
  expect(tab.state().phase).toBe('stopped')
})
