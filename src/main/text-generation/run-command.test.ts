import assert from 'node:assert/strict'
import { tmpdir } from 'node:os'

import { test } from 'vitest'

import { runCommand } from './run-command'

// A cancelled draft stops its CLI at once, rather than leaving it to run to
// the deadline for an answer nobody will read.

const SLEEPER = { file: process.execPath, args: ['-e', 'setTimeout(() => {}, 20000)'], cwd: tmpdir() }

test('aborting the signal kills the process and says it was cancelled', async () => {
  const controller = new AbortController()
  const started = Date.now()
  const running = runCommand({
    ...SLEEPER,
    env: { ...process.env } as Record<string, string>,
    stdin: '',
    timeoutMs: 20_000,
    signal: controller.signal,
  })
  setTimeout(() => controller.abort(), 100)
  const outcome = await running
  assert.equal(outcome.cancelled, true)
  assert.equal(outcome.timedOut, false)
  assert.ok(Date.now() - started < 10_000, 'stopped long before its deadline')
})

test('a signal already aborted stops the process as it starts', async () => {
  const controller = new AbortController()
  controller.abort()
  const outcome = await runCommand({
    ...SLEEPER,
    env: { ...process.env } as Record<string, string>,
    stdin: '',
    timeoutMs: 20_000,
    signal: controller.signal,
  })
  assert.equal(outcome.cancelled, true)
})

const quietEnv = () => ({ ...process.env }) as Record<string, string>

test('a character split across two writes reads back whole', async () => {
  // The euro sign is three bytes; the first write ends after one of them.
  const script =
    "const b = Buffer.from('€ ok', 'utf8'); process.stdout.write(b.subarray(0, 1)); " +
    'setTimeout(() => { process.stdout.write(b.subarray(1)); process.stderr.write(b.subarray(0, 1)); ' +
    'setTimeout(() => process.stderr.write(b.subarray(1)), 50) }, 50)'
  const outcome = await runCommand({
    file: process.execPath,
    args: ['-e', script],
    cwd: tmpdir(),
    env: quietEnv(),
    stdin: '',
    timeoutMs: 20_000,
  })
  assert.equal(outcome.code, 0)
  assert.equal(outcome.stdout, '€ ok')
  assert.equal(outcome.stderr, '€ ok')
})

test('a CLI that prints past the cap is stopped, and says so', async () => {
  const started = Date.now()
  const outcome = await runCommand({
    file: process.execPath,
    args: ['-e', "setInterval(() => process.stdout.write('x'.repeat(4096)), 1)"],
    cwd: tmpdir(),
    env: quietEnv(),
    stdin: '',
    timeoutMs: 20_000,
    maxOutputChars: 64 * 1024,
  })
  assert.equal(outcome.overflowed, true)
  assert.equal(outcome.timedOut, false)
  assert.ok(outcome.stdout.length <= 64 * 1024)
  assert.ok(Date.now() - started < 10_000, 'stopped long before its deadline')
})

test('stderr keeps its newest end, whatever the CLI says before it', async () => {
  const outcome = await runCommand({
    file: process.execPath,
    args: ['-e', "process.stderr.write('a'.repeat(200000)); process.stderr.write('the reason')"],
    cwd: tmpdir(),
    env: quietEnv(),
    stdin: '',
    timeoutMs: 20_000,
    maxOutputChars: 64 * 1024,
  })
  assert.equal(outcome.code, 0)
  assert.equal(outcome.overflowed, undefined)
  assert.ok(outcome.stderr.length <= 64 * 1024)
  assert.ok(outcome.stderr.endsWith('the reason'))
})
