import assert from 'node:assert/strict'
import { beforeEach, test, vi } from 'vitest'

import type { CliInstallResult } from '../../shared/electron-api'

// An install or update the app ran ends by detecting its CLI again on the
// machine it ran on. That answer — and only that one CLI on that one machine —
// becomes what the version check compares, so the badge clears without a
// re-scan of every CLI.

const calls = vi.hoisted(() => ({
  noted: [] as unknown[][],
  recorded: [] as unknown[][],
  discovered: [] as unknown[],
  result: null as CliInstallResult | null,
  // Set to hold every install and update open until the test lets it go.
  gate: null as Promise<void> | null,
  runs: [] as string[],
  onData: [] as Array<(chunk: string) => void>,
}))

async function run(kind: string, onData?: (chunk: string) => void) {
  calls.runs.push(kind)
  if (onData) calls.onData.push(onData)
  await calls.gate
  return calls.result
}

vi.mock('../cli-runtime-install', () => ({
  cliInstallMethods: async () => [],
  detectCli: async (cli: string) => ({
    cli,
    binary: cli,
    installed: true,
    version: '1.0.0',
    resolvedPath: `/usr/local/bin/${cli}`,
    hostId: 'local',
    error: null,
  }),
  installCli: async (_input: unknown, _runtime: unknown, onData?: (chunk: string) => void) => run('install', onData),
  updateCli: async (_cli: unknown, _runtime: unknown, onData?: (chunk: string) => void) => run('update', onData),
}))
vi.mock('../cli-version-advisory-service', () => ({
  noteCliDetected: async (...args: unknown[]) => void calls.noted.push(args),
  outdatedCliTargets: async () => ({ ok: true, targets: [] }),
}))
vi.mock('../cli-availability', () => ({
  recordCliDetection: (...args: unknown[]) => void calls.recorded.push(args),
}))
vi.mock('./cli-model-discovery-ipc', () => ({
  discoverAndBroadcastCliModels: async (input: unknown) => void calls.discovered.push(input),
}))

const { registerCliRuntimeIpc } = await import('./cli-runtime-ipc')

type Handler = (event: unknown, input: unknown) => Promise<unknown>
const handlers = new Map<string, Handler>()
registerCliRuntimeIpc({ handle: (channel: string, handler: Handler) => handlers.set(channel, handler) } as never)
const event = { sender: { isDestroyed: () => false, send: () => undefined } }

function result(over: Partial<CliInstallResult> = {}): CliInstallResult {
  return {
    ok: true,
    cli: 'codex',
    installed: true,
    version: '0.41.0',
    resolvedPath: '/home/dev/.local/bin/codex',
    log: '',
    error: null,
    ...over,
  }
}

beforeEach(() => {
  calls.gate = null
  calls.runs.length = 0
  calls.onData.length = 0
  calls.noted.length = 0
  calls.recorded.length = 0
  calls.discovered.length = 0
})

test('an update on a WSL machine records that CLI there, with the version it now reports', async () => {
  calls.result = result()
  const runtime = { command: '', hostId: 'wsl:Ubuntu' }
  await handlers.get('cli-runtime:update')!(event, { cli: 'codex', runtime })
  assert.equal(calls.noted.length, 1)
  const [noteRuntime, detected] = calls.noted[0] as [unknown, Record<string, unknown>]
  assert.deepEqual(noteRuntime, runtime)
  assert.equal(detected.hostId, 'wsl:Ubuntu')
  assert.equal(detected.version, '0.41.0')
  assert.equal(detected.installed, true)
  assert.equal(detected.error, null)
  assert.equal(calls.discovered.length, 1, 'a new binary is a new model list')
})

test('an install that exited badly but left the CLI in place is still recorded', async () => {
  calls.result = result({ ok: false, error: 'Install command exited with code 1.' })
  await handlers.get('cli-runtime:install')!(event, { cli: 'codex', methodId: 'npm', runtime: { command: '' } })
  assert.equal(calls.noted.length, 1)
  assert.equal((calls.noted[0][1] as { hostId: string }).hostId, 'local')
  assert.equal(calls.discovered.length, 0, 'model discovery waits for a clean install')
})

test('an install that left nothing behind records nothing', async () => {
  calls.result = result({ ok: false, installed: false, version: null, resolvedPath: null })
  await handlers.get('cli-runtime:install')!(event, { cli: 'codex', methodId: 'npm' })
  assert.deepEqual(calls.noted, [])
})

test('a row’s own detection becomes the shared answer for that CLI on that machine', async () => {
  const runtime = { command: '/opt/codex' }
  await handlers.get('cli-runtime:detect')!(event, { cli: 'codex', runtime })
  assert.equal(calls.recorded.length, 1)
  assert.deepEqual(calls.recorded[0][0], runtime)
})

function held(): () => void {
  let release = () => undefined as void
  calls.gate = new Promise<void>((resolve) => {
    release = resolve
  })
  return release
}

function sender() {
  const sent: Array<[string, string]> = []
  return {
    sent,
    event: {
      sender: { isDestroyed: () => false, send: (channel: string, chunk: string) => void sent.push([channel, chunk]) },
    },
  }
}

test('a second update of a CLI on the same machine joins the one running instead of starting another', async () => {
  calls.result = result()
  const release = held()
  const first = sender()
  const second = sender()
  const a = handlers.get('cli-runtime:update')!(first.event, { cli: 'codex', runtime: { command: '' } })
  const b = handlers.get('cli-runtime:update')!(second.event, { cli: 'codex', runtime: { command: '' } })
  await Promise.resolve()
  assert.deepEqual(calls.runs, ['update'], 'one updater runs')
  // Both windows read the one log.
  calls.onData[0]!('added 1 package\n')
  assert.deepEqual(first.sent, [['cli-runtime:install-output:codex', 'added 1 package\n']])
  assert.deepEqual(second.sent, first.sent)
  release()
  assert.deepEqual(await a, calls.result)
  assert.deepEqual(await b, calls.result)
  assert.equal(calls.noted.length, 1, 'the CLI is detected again once')
  // Done, the next update runs again.
  await handlers.get('cli-runtime:update')!(first.event, { cli: 'codex', runtime: { command: '' } })
  assert.deepEqual(calls.runs, ['update', 'update'])
})

test('an install while the same CLI updates on that machine is refused, and another machine is not held up', async () => {
  calls.result = result()
  const release = held()
  const update = handlers.get('cli-runtime:update')!(event, { cli: 'codex', runtime: { command: '' } })
  await Promise.resolve()
  const install = (await handlers.get('cli-runtime:install')!(event, {
    cli: 'codex',
    methodId: 'npm',
    runtime: { command: '' },
  })) as CliInstallResult
  assert.equal(install.ok, false)
  assert.match(install.error ?? '', /already being updated/)
  assert.deepEqual(calls.runs, ['update'])
  const elsewhere = sender()
  const wsl = handlers.get('cli-runtime:update')!(elsewhere.event, { cli: 'codex', runtime: { hostId: 'wsl:Ubuntu' } })
  await Promise.resolve()
  assert.deepEqual(calls.runs, ['update', 'update'], 'the WSL machine runs its own')
  calls.onData[1]!('done\n')
  assert.deepEqual(elsewhere.sent, [['cli-runtime:install-output:codex@wsl:Ubuntu', 'done\n']])
  release()
  await Promise.all([update, wsl])
})

test('a run that throws lets the next one start', async () => {
  calls.gate = Promise.reject(new Error('spawn failed'))
  calls.gate.catch(() => undefined)
  await assert.rejects(handlers.get('cli-runtime:update')!(event, { cli: 'codex' }) as Promise<unknown>)
  calls.gate = null
  calls.result = result()
  assert.deepEqual(await handlers.get('cli-runtime:update')!(event, { cli: 'codex' }), calls.result)
})
