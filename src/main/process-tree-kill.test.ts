import assert from 'node:assert/strict'
import { test } from 'vitest'

import { killProcessTree } from './process-tree-kill'

function fakeChild(pid: number | undefined) {
  const signals: Array<NodeJS.Signals | number | undefined> = []
  return {
    child: {
      pid,
      kill(signal?: NodeJS.Signals | number) {
        signals.push(signal)
        return true
      },
    },
    signals,
  }
}

test('on Windows the whole tree is ended through taskkill, not only the wrapper', () => {
  const { child, signals } = fakeChild(4242)
  const killed: number[] = []
  killProcessTree(child, { platform: 'win32', runTaskkill: (pid) => killed.push(pid) })
  assert.deepEqual(killed, [4242])
  assert.deepEqual(signals, [], 'the single-process kill is not needed')
})

test('on Windows a taskkill that cannot start falls back to killing the one process', () => {
  const { child, signals } = fakeChild(4242)
  killProcessTree(child, {
    platform: 'win32',
    runTaskkill: () => {
      throw new Error('spawn taskkill ENOENT')
    },
  })
  assert.deepEqual(signals, ['SIGKILL'])
})

test('a child that never got a pid is killed directly, on any platform', () => {
  const { child, signals } = fakeChild(undefined)
  let taskkills = 0
  killProcessTree(child, { platform: 'win32', runTaskkill: () => (taskkills += 1) })
  assert.equal(taskkills, 0)
  assert.deepEqual(signals, ['SIGKILL'])
})

test('POSIX keeps the plain SIGKILL', () => {
  for (const platform of ['darwin', 'linux'] as const) {
    const { child, signals } = fakeChild(99)
    let taskkills = 0
    killProcessTree(child, { platform, runTaskkill: () => (taskkills += 1) })
    assert.equal(taskkills, 0)
    assert.deepEqual(signals, ['SIGKILL'])
  }
})

test('a child that is already gone does not throw', () => {
  const child = {
    pid: 7,
    kill(): boolean {
      throw new Error('ESRCH')
    },
  }
  assert.doesNotThrow(() => killProcessTree(child, { platform: 'darwin' }))
})

test('a detached POSIX child is ended with its whole process group', () => {
  const { child, signals } = fakeChild(4242)
  const groups: number[] = []
  killProcessTree(child, { platform: 'darwin', processGroup: true, killGroup: (pid) => groups.push(pid) })
  assert.deepEqual(groups, [4242])
  assert.deepEqual(signals, [], 'the group signal replaces the single kill')

  const fallback = fakeChild(4243)
  killProcessTree(fallback.child, {
    platform: 'linux',
    processGroup: true,
    killGroup: () => {
      throw new Error('ESRCH')
    },
  })
  assert.deepEqual(fallback.signals, ['SIGKILL'], 'a group that is already gone falls back to the child')
})

test('on Windows a child Node has already seen exit is not taskkilled, since its pid may be reused', () => {
  for (const ended of [
    { exitCode: 0, signalCode: null },
    { exitCode: null, signalCode: 'SIGTERM' as const },
  ]) {
    const { child, signals } = fakeChild(4242)
    const killed: number[] = []
    killProcessTree({ ...child, ...ended }, { platform: 'win32', runTaskkill: (pid) => killed.push(pid) })
    assert.deepEqual(killed, [], 'no taskkill on a pid that may now be another process')
    assert.deepEqual(signals, [], 'nothing left to kill')
  }
})

test('on Windows a child still running is taskkilled as before', () => {
  const { child } = fakeChild(4242)
  const killed: number[] = []
  killProcessTree(
    { ...child, exitCode: null, signalCode: null },
    { platform: 'win32', runTaskkill: (pid) => killed.push(pid) },
  )
  assert.deepEqual(killed, [4242])
})
