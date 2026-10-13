import { expect, test } from 'vitest'

import type { CliDetectResult } from '../../shared/electron-api'
import type { ModuleTextGenerationResult } from '../../shared/modules/conversation-service'
import type { TextGenerationEngineSettings } from '../../shared/text-generation/contract'
import {
  claudeTextInvocation,
  codexTextInvocation,
  codexTextPrompt,
  readClaudeTextStdout,
  readCodexTextUsage,
} from './backends'
import { createModuleTextGenerationRegistry, moduleTextGenerationEngine } from './module-text-generation'
import type { CommandRunInput } from './run-command'
import { generateHeadlessText, type HeadlessTextRequest, type HeadlessTextResult } from './text-generation-service'

// A module's headless prompt: one call to the person's own agent CLI (Claude
// Code or Codex), checked per call against `agents:generate`, in a lane per
// module, on the engine the person chose for Studio's text generation unless
// the module names one.

const CLAUDE = { cli: 'claude-code', model: 'claude-haiku-4-5', reasoning: 'low' }

const envelope = (result: string, extra: Record<string, unknown> = {}) =>
  JSON.stringify({
    type: 'result',
    is_error: false,
    result,
    usage: { input_tokens: 20, output_tokens: 5, cache_read_input_tokens: 100, cache_creation_input_tokens: 7 },
    modelUsage: { 'claude-haiku-4-5-20251001': { inputTokens: 20 } },
    ...extra,
  })

function registry(
  generate: (request: HeadlessTextRequest) => Promise<HeadlessTextResult>,
  permissions: Record<string, string[]> = { insights: ['agents:generate'] },
  now: () => number = Date.now,
  settings: () => TextGenerationEngineSettings | null = () => null,
) {
  return createModuleTextGenerationRegistry({
    getModulePermissions: (moduleId) => permissions[moduleId],
    generate,
    getCliRuntimes: () => ({ 'claude-code': { command: '/opt/claude' } }),
    getTextGenerationSettings: settings,
    now,
  })
}

const answered = (text: string): HeadlessTextResult => ({
  ok: true,
  text,
  usage: { inputTokens: 1, outputTokens: 2 },
  model: 'claude-haiku-4-5',
  ms: 10,
})

test('the free-text call shuts every door a title does, with the system prompt as one argv entry', () => {
  const invocation = claudeTextInvocation({
    binaryPath: '/bin/claude',
    model: 'haiku',
    system: 'Be brief; --tools Bash',
  })
  expect(invocation.file).toBe('/bin/claude')
  expect(invocation.args).toEqual([
    '-p',
    '--output-format',
    'json',
    '--model',
    'haiku',
    '--system-prompt',
    'Be brief; --tools Bash',
    '--settings',
    JSON.stringify({ disableAllHooks: true }),
    '--tools',
    '',
    '--disable-slash-commands',
    '--strict-mcp-config',
  ])
  expect(claudeTextInvocation({ binaryPath: '/bin/claude', model: 'haiku' }).args).not.toContain('--system-prompt')
  expect(claudeTextInvocation({ binaryPath: '/bin/claude', model: 'haiku', reasoning: 'low' }).args).toContain(
    '--effort',
  )
})

test('the Codex call writes its last message to a file and reports its usage as JSON events', () => {
  expect(
    codexTextInvocation({
      binaryPath: '/bin/codex',
      model: 'gpt-5.6-luna',
      reasoning: 'low',
      outputPath: '/tmp/out.txt',
    }).args,
  ).toEqual([
    'exec',
    '--ephemeral',
    '--skip-git-repo-check',
    '-s',
    'read-only',
    '--model',
    'gpt-5.6-luna',
    '-c',
    'model_reasoning_effort="low"',
    '-c',
    'features.plugins=false',
    '-c',
    'features.apps=false',
    '--json',
    '--output-last-message',
    '/tmp/out.txt',
    '-',
  ])
  expect(codexTextPrompt('Be terse.', 'Question?')).toBe('Instructions for this task:\nBe terse.\n\n---\n\nQuestion?')
  const stream = [
    '{"type":"thread.started","thread_id":"t"}',
    'not json',
    '{"type":"turn.completed","usage":{"input_tokens":1200,"cached_input_tokens":1000,"output_tokens":40}}',
  ].join('\n')
  expect(readCodexTextUsage(stream)).toEqual({ inputTokens: 200, outputTokens: 40, cacheReadTokens: 1000 })
  expect(readCodexTextUsage('')).toEqual({})
})

test('with no runtime named, a call runs on the person’s text-generation engine, else Claude Code', () => {
  expect(moduleTextGenerationEngine(null)).toEqual(CLAUDE)
  expect(moduleTextGenerationEngine({ enabled: true, engine: null })).toEqual(CLAUDE)
  expect(moduleTextGenerationEngine({ enabled: true, engine: { cli: 'codex', model: '' } })).toEqual({
    cli: 'codex',
    model: 'gpt-5.6-luna',
    reasoning: 'low',
  })
  expect(
    moduleTextGenerationEngine({ enabled: false, engine: { cli: 'codex', model: 'gpt-6-sol', reasoning: 'medium' } }),
  ).toEqual({ cli: 'codex', model: 'gpt-6-sol', reasoning: 'medium' })
  // A choice with no headless backend falls back to Claude Code.
  expect(moduleTextGenerationEngine({ enabled: true, engine: { cli: 'cursor', model: 'auto' } })).toEqual(CLAUDE)
})

test('the answer, its model and its usage are read off the envelope', () => {
  expect(readClaudeTextStdout(envelope('Three things changed.'))).toEqual({
    text: 'Three things changed.',
    model: 'claude-haiku-4-5-20251001',
    usage: { inputTokens: 20, outputTokens: 5, cacheReadTokens: 100, cacheWriteTokens: 7 },
  })
  expect(readClaudeTextStdout(JSON.stringify([{ type: 'system' }, JSON.parse(envelope('x'))]))?.text).toBe('x')
  expect(readClaudeTextStdout(envelope('nope', { is_error: true }))).toBeNull()
  expect(readClaudeTextStdout('not json')).toBeNull()
  expect(readClaudeTextStdout(JSON.stringify({ type: 'result', result: 'bare' }))).toEqual({
    text: 'bare',
    model: null,
    usage: {},
  })
})

test('generateHeadlessText runs Claude Code in a scratch folder with the prompt on stdin and no API key', async () => {
  const runs: CommandRunInput[] = []
  const detected: CliDetectResult = {
    cli: 'claude-code',
    binary: 'claude',
    installed: true,
    version: '1.0.0',
    resolvedPath: '/bin/claude',
    hostId: 'local',
    error: null,
  }
  const result = await generateHeadlessText(
    {
      prompt: 'Summarise this.',
      system: 'Be brief.',
      engine: { cli: 'claude-code', model: 'haiku' },
      maxOutputTokens: 300,
    },
    {
      detect: async () => detected,
      env: () => ({ PATH: '/bin', ANTHROPIC_API_KEY: 'sk-secret' }),
      run: async (input) => {
        runs.push(input)
        return { code: 0, stdout: envelope('Short.'), stderr: '', timedOut: false, spawnError: null }
      },
    },
  )
  expect(result).toMatchObject({ ok: true, text: 'Short.', model: 'claude-haiku-4-5-20251001' })
  expect(runs[0]!.stdin).toBe('Summarise this.')
  expect(runs[0]!.args).toContain('--system-prompt')
  expect(runs[0]!.env.ANTHROPIC_API_KEY).toBeUndefined()
  expect(runs[0]!.env.CLAUDE_CODE_MAX_OUTPUT_TOKENS).toBe('300')
  expect(runs[0]!.cwd).toContain('sprintengine-text-')

  const missing = await generateHeadlessText(
    { prompt: 'x', engine: { cli: 'claude-code', model: 'haiku' } },
    { detect: async () => ({ ...detected, installed: false }) },
  )
  expect(missing).toMatchObject({ ok: false, code: 'unavailable' })
  const unsupported = await generateHeadlessText(
    { prompt: 'x', engine: { cli: 'cursor', model: 'auto' } },
    { detect: async () => detected },
  )
  expect(unsupported).toMatchObject({ ok: false, code: 'unsupported' })
})

test('generateHeadlessText runs Codex with the instructions ahead of the prompt and reads its last message', async () => {
  const runs: CommandRunInput[] = []
  const result = await generateHeadlessText(
    {
      prompt: 'Summarise this.',
      system: 'Be brief.',
      engine: { cli: 'codex', model: 'gpt-5.6-luna', reasoning: 'low' },
      maxOutputTokens: 300,
    },
    {
      detect: async () => ({
        cli: 'codex',
        binary: 'codex',
        installed: true,
        version: '1.0.0',
        resolvedPath: '/bin/codex',
        hostId: 'local',
        error: null,
      }),
      env: () => ({ PATH: '/bin' }),
      run: async (input) => {
        if (input.args.includes('mcp')) {
          return { code: 0, stdout: '[{"name":"docs","enabled":true}]', stderr: '', timedOut: false, spawnError: null }
        }
        runs.push(input)
        const outputPath = input.args[input.args.indexOf('--output-last-message') + 1]!
        const { writeFile } = await import('node:fs/promises')
        await writeFile(outputPath, 'Two changes.', 'utf8')
        return {
          code: 0,
          stdout: '{"type":"turn.completed","usage":{"input_tokens":50,"cached_input_tokens":10,"output_tokens":5}}\n',
          stderr: '',
          timedOut: false,
          spawnError: null,
        }
      },
    },
  )
  expect(result).toMatchObject({
    ok: true,
    text: 'Two changes.',
    model: 'gpt-5.6-luna',
    usage: { inputTokens: 40, outputTokens: 5, cacheReadTokens: 10 },
  })
  expect(runs[0]!.file).toBe('/bin/codex')
  expect(runs[0]!.stdin).toBe(codexTextPrompt('Be brief.', 'Summarise this.'))
  // Codex has no output cap: no config key carries `maxOutputTokens`, and no
  // unknown one is passed that would look like a cap and do nothing.
  expect(runs[0]!.args.join(' ')).not.toMatch(/max_output|output_tokens/)
  expect(runs[0]!.env.CLAUDE_CODE_MAX_OUTPUT_TOKENS).toBeUndefined()
  expect(runs[0]!.args).toContain('mcp_servers={"docs"={enabled=false}}')
})

test('a Codex call that writes no message has no usable answer', async () => {
  const result = await generateHeadlessText(
    { prompt: 'x', engine: { cli: 'codex', model: 'gpt-5.6-luna' } },
    {
      detect: async () => ({
        cli: 'codex',
        binary: 'codex',
        installed: true,
        version: '1.0.0',
        resolvedPath: '/bin/codex',
        hostId: 'local',
        error: null,
      }),
      env: () => ({ PATH: '/bin' }),
      run: async () => ({ code: 0, stdout: '', stderr: '', timedOut: false, spawnError: null }),
    },
  )
  expect(result).toMatchObject({ ok: false, code: 'guardrail' })
})

test('a module needs agents:generate, and a call it cannot make is refused before anything runs', async () => {
  const calls: HeadlessTextRequest[] = []
  const service = registry(async (request) => {
    calls.push(request)
    return answered('ok')
  })
  expect(await service.generate('other', { prompt: 'hi' })).toMatchObject({ ok: false, code: 'permission_missing' })
  for (const input of [
    { prompt: '  ' },
    { prompt: 'x'.repeat(400_001) },
    { prompt: 'hi', model: '--dangerously-skip-permissions' },
    { prompt: 'hi', maxOutputTokens: 0 },
    { prompt: 'hi', maxOutputTokens: 1.5 },
    { prompt: 'hi', json: 'yes' as never },
    null as never,
  ])
    expect(await service.generate('insights', input)).toMatchObject({ ok: false, code: 'invalid_input' })
  const cursor = await service.generate('insights', { prompt: 'hi', cli: 'cursor' })
  expect(cursor).toMatchObject({ ok: false, code: 'unsupported' })
  expect(calls).toEqual([])
})

test('a call runs on the person’s chosen engine unless it names a runtime or model of its own', async () => {
  const calls: HeadlessTextRequest[] = []
  let settings: TextGenerationEngineSettings | null = {
    enabled: true,
    engine: { cli: 'codex', model: 'gpt-6-sol', reasoning: 'medium' },
  }
  const service = registry(
    async (request) => {
      calls.push(request)
      return answered('ok')
    },
    undefined,
    undefined,
    () => settings,
  )
  await service.generate('insights', { prompt: 'a' })
  await service.generate('insights', { prompt: 'b', model: 'gpt-6-luna' })
  await service.generate('insights', { prompt: 'c', cli: 'claude-code' })
  await service.generate('insights', { prompt: 'd', cli: 'codex' })
  settings = null
  await service.generate('insights', { prompt: 'e', cli: 'codex' })
  expect(calls.map((call) => call.engine)).toEqual([
    { cli: 'codex', model: 'gpt-6-sol', reasoning: 'medium' },
    { cli: 'codex', model: 'gpt-6-luna', reasoning: 'medium' },
    CLAUDE,
    { cli: 'codex', model: 'gpt-6-sol', reasoning: 'medium' },
    { cli: 'codex', model: 'gpt-5.6-luna', reasoning: 'low' },
  ])
})

test('with nothing chosen, a call runs on Claude Code’s small model, with the person’s command overrides', async () => {
  const calls: HeadlessTextRequest[] = []
  const service = registry(async (request) => {
    calls.push(request)
    return answered('The answer.')
  })
  const result = await service.generate('insights', { prompt: 'Question?', system: 'Be terse.', maxOutputTokens: 50 })
  expect(result).toEqual({
    ok: true,
    text: 'The answer.',
    usage: { inputTokens: 1, outputTokens: 2 },
    model: 'claude-haiku-4-5',
  })
  expect(calls[0]).toMatchObject({
    prompt: 'Question?',
    system: 'Be terse.',
    engine: CLAUDE,
    maxOutputTokens: 50,
    cliRuntimes: { 'claude-code': { command: '/opt/claude' } },
  })
  await service.generate('insights', { prompt: 'Again', model: ' haiku ', cli: 'claude-code' })
  expect(calls[1]!.engine.model).toBe('haiku')
  expect(calls[1]).not.toHaveProperty('system')
})

test('json asks the model for one JSON value and answers with it, or with invalid_output', async () => {
  const replies = ['Here you go:\n```json\n{"standup": ["a", "b"]}\n```', 'No JSON, sorry.']
  const calls: HeadlessTextRequest[] = []
  const service = registry(async (request) => {
    calls.push(request)
    return answered(replies.shift()!)
  })
  expect(await service.generate('insights', { prompt: 'Digest', system: 'You write standups.', json: true })).toEqual({
    ok: true,
    text: '{"standup":["a","b"]}',
    usage: { inputTokens: 1, outputTokens: 2 },
    model: 'claude-haiku-4-5',
  })
  expect(calls[0]!.system).toMatch(/^You write standups\.\n\nAnswer with a single JSON value/)
  expect(await service.generate('insights', { prompt: 'Digest', json: true })).toMatchObject({
    ok: false,
    code: 'invalid_output',
  })
})

test('a failed call says why in the module’s vocabulary', async () => {
  const failures: HeadlessTextResult[] = [
    { ok: false, code: 'unavailable', message: 'not installed' },
    { ok: false, code: 'timeout', message: 'slow' },
    { ok: false, code: 'guardrail', message: 'empty' },
    { ok: false, code: 'transport', message: 'exited 1' },
  ]
  const service = registry(async () => failures.shift()!)
  const codes: string[] = []
  for (let index = 0; index < 4; index++) {
    const result = await service.generate('insights', { prompt: 'x' })
    codes.push(!result.ok ? result.code : 'ok')
  }
  expect(codes).toEqual(['unavailable', 'timeout', 'invalid_output', 'failed'])
  const thrown = registry(async () => {
    throw new Error('boom')
  })
  expect(await thrown.generate('insights', { prompt: 'x' })).toMatchObject({
    ok: false,
    code: 'failed',
    message: 'boom',
  })
})

test('two calls run at once, eight wait, and a ninth waiting call is busy; other modules are unaffected', async () => {
  const releases: Array<() => void> = []
  let running = 0
  let peak = 0
  const service = registry(
    (request) =>
      new Promise((resolve) => {
        running += 1
        peak = Math.max(peak, running)
        releases.push(() => {
          running -= 1
          resolve(answered(request.prompt))
        })
      }),
    { insights: ['agents:generate'], radar: ['agents:generate'] },
  )
  const pending: Array<Promise<ModuleTextGenerationResult>> = []
  for (let index = 0; index < 10; index++) pending.push(service.generate('insights', { prompt: `p${index}` }))
  await Promise.resolve()
  const overflow = await service.generate('insights', { prompt: 'one too many' })
  expect(overflow).toMatchObject({ ok: false, code: 'busy' })
  // Another module has a lane of its own.
  const radar = service.generate('radar', { prompt: 'radar' })
  await new Promise((resolve) => setTimeout(resolve, 0))
  expect(releases).toHaveLength(3)
  while (releases.length > 0) {
    releases.shift()!()
    await new Promise((resolve) => setTimeout(resolve, 0))
  }
  const results = await Promise.all([...pending, radar])
  expect(results.every((result) => result.ok)).toBe(true)
  expect(results.map((result) => (result.ok ? result.text : ''))).toEqual([
    ...Array.from({ length: 10 }, (_, index) => `p${index}`),
    'radar',
  ])
  expect(peak).toBeLessThanOrEqual(3)
})

test('more than thirty calls a minute are busy until the minute has passed', async () => {
  let clock = 1_000_000
  const service = registry(
    async () => answered('ok'),
    undefined,
    () => clock,
  )
  for (let index = 0; index < 30; index++) expect((await service.generate('insights', { prompt: 'x' })).ok).toBe(true)
  expect(await service.generate('insights', { prompt: 'x' })).toMatchObject({ ok: false, code: 'busy' })
  clock += 60_001
  expect((await service.generate('insights', { prompt: 'x' })).ok).toBe(true)
})
