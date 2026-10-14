// The fixture is Claude Code 2.1.280's real `supportedModels()` answer, captured
// 2026-09-22 through the same no-turn query this probe makes.
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { test, vi } from 'vitest'

// The probe's own environment, as it would inherit it from a shell that exports
// an API key and a base URL. Only the probe's default env reads this; the
// tests below that inject `env` never do.
vi.mock('../cli-runtime-install', () => ({
  defaultProbeEnv: () => ({
    PATH: '/usr/bin',
    HOME: '/Users/dev',
    ANTHROPIC_API_KEY: 'sk-test-not-a-key',
    ANTHROPIC_AUTH_TOKEN: 'token-test',
    ANTHROPIC_BASE_URL: 'https://proxy.example.com',
  }),
}))
import type { ModelInfo } from '@anthropic-ai/claude-agent-sdk'

import { mapAgentSdkModels, probeAgentSdkModels, probeEnv, type AgentSdkProbeDeps } from './agent-sdk-probe'
import { CliModelProbeError } from './probe-types'

const ROWS = JSON.parse(
  readFileSync(
    join(process.cwd(), 'src', 'main', 'model-discovery', '__fixtures__', 'agent-sdk-supported-models.json'),
    'utf8',
  ),
) as ModelInfo[]

const CONTEXT = {
  binary: '/Users/dev/.local/bin/claude',
  timeoutMs: 20_000,
  displayName: 'Claude Code',
}

test('every row is kept as the CLI reported it, aliases included, in its order', () => {
  const models = mapAgentSdkModels(ROWS)
  assert.deepEqual(
    models.map((model) => model.id),
    ['default', 'opus[1m]', 'claude-fable-5-1[1m]', 'sonnet', 'haiku'],
  )
  assert.deepEqual(models[1], {
    id: 'opus[1m]',
    displayName: 'Opus (1M context)',
    description: 'Opus 5.5 with 1M context · Best for everyday, complex tasks',
    resolvedModel: 'claude-opus-5-5[1m]',
    effortLevels: ['low', 'medium', 'high', 'xhigh', 'max'],
    supportsFastMode: true,
  })
  assert.deepEqual(models[4], {
    id: 'haiku',
    displayName: 'Haiku',
    description: 'Haiku 4.5 · Fastest for quick answers',
    resolvedModel: 'claude-haiku-4-5-20251001',
  })
})

type FakeSession = { closed: number; options: unknown; prompt: AsyncIterable<unknown> | null }

function fakeSdk(answer: () => Promise<ModelInfo[]>): { deps: AgentSdkProbeDeps; session: FakeSession } {
  const session: FakeSession = { closed: 0, options: null, prompt: null }
  const deps: AgentSdkProbeDeps = {
    env: () => ({ PATH: '/usr/bin' }),
    loadQuery: async () => (input) => {
      session.options = input.options
      session.prompt = input.prompt
      return {
        supportedModels: answer,
        close: () => {
          session.closed += 1
        },
      }
    },
  }
  return { deps, session }
}

test('the query sends no turn, loads no settings or tools, and is closed once answered', async () => {
  const { deps, session } = fakeSdk(async () => ROWS)
  const models = await probeAgentSdkModels(CONTEXT, deps)
  assert.equal(models.length, 5)
  assert.equal(session.closed, 1)
  const options = session.options as Record<string, unknown>
  assert.deepEqual(options.tools, [])
  assert.deepEqual(options.settingSources, [])
  assert.equal(options.pathToClaudeCodeExecutable, '/Users/dev/.local/bin/claude')
  // No IDE lookup: a probe answers one question and exits.
  assert.deepEqual(options.env, {
    PATH: '/usr/bin',
    CLAUDE_CODE_AUTO_CONNECT_IDE: '0',
    CLAUDE_CODE_IDE_SKIP_AUTO_INSTALL: '1',
  })
  assert.equal((options.abortController as AbortController).signal.aborted, true, 'the backstop fired too')
  // The input stream ends once the probe is torn down, so nothing waits on it.
  const iterator = session.prompt![Symbol.asyncIterator]()
  assert.deepEqual(await iterator.next(), { done: true, value: undefined })
})

test('a CLI that never answers is closed at the deadline and reported in words', async () => {
  const { deps, session } = fakeSdk(() => new Promise<ModelInfo[]>(() => {}))
  await assert.rejects(
    probeAgentSdkModels({ ...CONTEXT, timeoutMs: 20 }, deps),
    (error: unknown) =>
      error instanceof CliModelProbeError && error.message === 'Claude Code did not list its models within 0 s.',
  )
  assert.equal(session.closed, 1)
  assert.equal((session.options as { abortController: AbortController }).abortController.signal.aborted, true)
})

test('an SDK failure, a WSL runtime and an unresolved path are sentences', async () => {
  const { deps, session } = fakeSdk(async () => {
    throw new Error('Claude Code process exited with code 1')
  })
  await assert.rejects(
    probeAgentSdkModels(CONTEXT, deps),
    (error: unknown) =>
      error instanceof CliModelProbeError &&
      error.message === 'Claude Code did not list its models: Claude Code process exited with code 1',
  )
  assert.equal(session.closed, 1)
  await assert.rejects(probeAgentSdkModels({ ...CONTEXT, hostId: 'wsl:Ubuntu' }, deps), CliModelProbeError)
  await assert.rejects(probeAgentSdkModels({ ...CONTEXT, binary: 'claude' }, deps), CliModelProbeError)
})

test('the probe runs on the CLI login: no API key, token or base URL reaches the child', async () => {
  const { deps, session } = fakeSdk(async () => ROWS)
  await probeAgentSdkModels(CONTEXT, { loadQuery: deps.loadQuery })
  assert.deepEqual((session.options as { env: Record<string, string> }).env, {
    PATH: '/usr/bin',
    HOME: '/Users/dev',
    CLAUDE_CODE_AUTO_CONNECT_IDE: '0',
    CLAUDE_CODE_IDE_SKIP_AUTO_INSTALL: '1',
  })
})

test('a probe drops the terminal override and turns the IDE lookup off', () => {
  assert.deepEqual(probeEnv({ PATH: '/usr/bin', FORCE_CODE_TERMINAL: '1', CLAUDE_CODE_AUTO_CONNECT_IDE: '1' }), {
    PATH: '/usr/bin',
    CLAUDE_CODE_AUTO_CONNECT_IDE: '0',
    CLAUDE_CODE_IDE_SKIP_AUTO_INSTALL: '1',
  })
})
