import assert from 'node:assert/strict'
import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { delimiter, join } from 'node:path'
import type { SpawnOptions } from 'node:child_process'

import { beforeEach, test, vi } from 'vitest'

const spawn = vi.hoisted(() => vi.fn())
vi.mock('child_process', async (importOriginal) => ({
  ...(await importOriginal<typeof import('child_process')>()),
  spawn,
}))
// The macOS install locations are looked for first; a machine with Tailscale
// installed would otherwise run the real CLI instead of the stand-in on PATH.
vi.mock('fs', async (importOriginal) => ({
  ...(await importOriginal<typeof import('fs')>()),
  existsSync: () => false,
}))

import { runTailscale, runTailscaleResult } from './tailscale-cli'

const actual = await vi.importActual<typeof import('child_process')>('child_process')

// Whatever is asked for, a Node process that answers `{}` runs in its place,
// with the options the run was given.
beforeEach(() => {
  spawn.mockReset()
  spawn.mockImplementation((_file: string, _args: string[], options: SpawnOptions) =>
    actual.spawn(process.execPath, ['-e', "process.stdout.write('{}')"], options),
  )
})

function envOfLastRun(): NodeJS.ProcessEnv {
  const options = spawn.mock.calls.at(-1)?.[2] as { env?: NodeJS.ProcessEnv } | undefined
  assert.ok(options?.env, 'every Tailscale run passes an explicit environment')
  return options.env
}

// Launched from the Dock, the app has no TERM, and the macOS binary then tries
// to start its GUI and prints that failure to stdout with exit 0. The switch
// has to reach every run, reads and writes alike.
test('a read asks the binary to be the CLI', async () => {
  await runTailscale(['status', '--json'], 1000)
  assert.equal(envOfLastRun().TAILSCALE_BE_CLI, '1')
})

test('a write asks the binary to be the CLI', async () => {
  await runTailscaleResult(['serve', 'status'], 1000)
  assert.equal(envOfLastRun().TAILSCALE_BE_CLI, '1')
})

test('the rest of the environment is kept', async () => {
  process.env.SPRINTENGINE_TEST_CANARY = 'kept'
  try {
    await runTailscale(['status', '--json'], 1000)
    assert.equal(envOfLastRun().SPRINTENGINE_TEST_CANARY, 'kept')
  } finally {
    delete process.env.SPRINTENGINE_TEST_CANARY
  }
})

const isAlive = (pid: number): boolean => {
  try {
    process.kill(pid, 0)
    return true
  } catch {
    return false
  }
}

/**
 * Puts a stand-in `tailscale` first on PATH and runs `body` with real
 * processes. It is shaped like `/usr/local/bin/tailscale`: a shell wrapper
 * that runs the binary as its child rather than `exec`ing it. Each writes its
 * pid beside it; the wrapper then runs `wrapper` and the binary, the binary
 * what `binary` says.
 */
async function withStandIn(
  binary: string,
  body: (dir: string) => Promise<void>,
  wrapper: string[] = [],
): Promise<void> {
  spawn.mockImplementation(actual.spawn)
  const dir = mkdtempSync(join(tmpdir(), 'tailscale-cli-'))
  const script = (name: string, lines: string[]) => {
    writeFileSync(join(dir, name), ['#!/bin/sh', ...lines, ''].join('\n'))
    chmodSync(join(dir, name), 0o755)
  }
  script('tailscale', [
    'echo $$ > "$(dirname "$0")/wrapper.pid"',
    ...wrapper,
    '"$(dirname "$0")/tailscale-binary" "$@"',
  ])
  script('tailscale-binary', ['echo $$ > "$(dirname "$0")/binary.pid"', binary])
  const path = process.env.PATH
  process.env.PATH = `${dir}${delimiter}${path ?? ''}`
  try {
    await body(dir)
  } finally {
    process.env.PATH = path
    for (const name of ['wrapper.pid', 'binary.pid']) {
      try {
        const pid = Number(readFileSync(join(dir, name), 'utf8'))
        if (pid > 0 && isAlive(pid)) process.kill(pid, 'SIGKILL')
      } catch {
        // Never started.
      }
    }
    rmSync(dir, { recursive: true, force: true })
  }
}

test.skipIf(process.platform === 'win32')('a run that answers in time reads as it always did', async () => {
  await withStandIn(`echo '{"Self":{}}'`, async () => {
    assert.equal(await runTailscale(['status', '--json'], 5_000), '{"Self":{}}\n')
    assert.deepEqual(await runTailscaleResult(['serve', 'status'], 5_000), { ok: true, stdout: '{"Self":{}}\n' })
  })
})

/** Runs a write against a stand-in that outlives SIGTERM, and checks it was ended at the deadline. */
async function expectEndedAtDeadline(dir: string): Promise<void> {
  // Long enough for the wrapper to have started the binary on a busy machine.
  const deadlineMs = 1_000
  const started = Date.now()
  const settled = await Promise.race([
    runTailscaleResult(['serve', '--bg', '3000'], deadlineMs),
    new Promise<'pending'>((resolve) => setTimeout(() => resolve('pending'), deadlineMs + 4_000)),
  ])
  assert.notEqual(settled, 'pending', 'the run settled after its deadline')
  assert.ok(Date.now() - started < deadlineMs + 2_000, 'the run settled soon after its deadline')
  assert.deepEqual(settled, { ok: false, stdout: '', stderr: '', timedOut: true })
  for (const name of ['wrapper.pid', 'binary.pid']) {
    const pid = Number(readFileSync(join(dir, name), 'utf8'))
    // Killed, a process is reparented and reaped; give that a moment.
    const deadline = Date.now() + 2_000
    while (isAlive(pid) && Date.now() < deadline) await new Promise((resolve) => setTimeout(resolve, 25))
    assert.equal(isAlive(pid), false, `${name.replace('.pid', '')} was ended`)
  }
}

// A TERM to the wrapper ends the wrapper alone: the binary, which ignores it,
// would carry on with no parent.
test.skipIf(process.platform === 'win32')(
  'a run that misses its deadline ends the binary behind the wrapper too',
  () => withStandIn(`trap '' TERM\nexec sleep 30`, expectEndedAtDeadline),
  20_000,
)

// A TERM nobody acts on would leave the run waiting until the process ends on
// its own.
test.skipIf(process.platform === 'win32')(
  'a run that ignores SIGTERM still settles at its deadline',
  () => withStandIn('exec sleep 30', expectEndedAtDeadline, ["trap '' TERM"]),
  20_000,
)
