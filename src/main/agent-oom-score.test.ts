import assert from 'node:assert/strict'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'

import { test } from 'vitest'

import { AGENT_OOM_SCORE_ADJ, RAISE_OOM_SCORE_SHELL_LINE, raiseChildOomScore } from './agent-oom-score'

// Agents and terminals are marked for the kernel's out-of-memory killer
// before the app: on Linux only, never lowering a score, never failing.

function fakeProc(current: string | Error) {
  const writes: Array<[string, string]> = []
  return {
    writes,
    deps: {
      platform: 'linux' as const,
      readText: async () => {
        if (current instanceof Error) throw current
        return current
      },
      writeText: async (path: string, text: string) => {
        writes.push([path, text])
      },
    },
  }
}

test('a child on Linux has its score raised through its own /proc entry', async () => {
  const proc = fakeProc('0\n')
  await raiseChildOomScore(4242, proc.deps)
  assert.deepEqual(proc.writes, [['/proc/4242/oom_score_adj', `${AGENT_OOM_SCORE_ADJ}\n`]])
})

test('nothing is written off Linux', async () => {
  for (const platform of ['darwin', 'win32'] as const) {
    const proc = fakeProc('0\n')
    await raiseChildOomScore(4242, { ...proc.deps, platform })
    assert.deepEqual(proc.writes, [], platform)
  }
})

test('a score already as high or higher is left alone', async () => {
  for (const current of [`${AGENT_OOM_SCORE_ADJ}`, '1000']) {
    const proc = fakeProc(current)
    await raiseChildOomScore(4242, proc.deps)
    assert.deepEqual(proc.writes, [], current)
  }
})

test('a child with no pid (it failed to start) is skipped', async () => {
  for (const pid of [undefined, 0, -1, 1.5]) {
    const proc = fakeProc('0')
    await raiseChildOomScore(pid, proc.deps)
    assert.deepEqual(proc.writes, [], String(pid))
  }
})

test('a process already gone, or a write refused, never throws', async () => {
  await raiseChildOomScore(4242, fakeProc(new Error('ENOENT')).deps)
  await raiseChildOomScore(4242, {
    platform: 'linux',
    readText: async () => '0',
    writeText: async () => {
      throw new Error('EACCES')
    },
  })
})

test('the shell line is valid POSIX shell that says nothing where /proc has no score', async () => {
  // Run under the system shell: where /proc is absent (macOS) the line must be
  // silent and leave the script running; on Linux it raises the shell's score.
  const { stdout, stderr } = await promisify(execFile)('/bin/sh', [
    '-c',
    `${RAISE_OOM_SCORE_SHELL_LINE}; cat /proc/self/oom_score_adj 2>/dev/null; echo done`,
  ])
  assert.equal(stderr, '')
  assert.match(stdout, /done\n$/u)
  if (process.platform === 'linux') assert.match(stdout, new RegExp(`^${AGENT_OOM_SCORE_ADJ}\\n`, 'u'))
})
