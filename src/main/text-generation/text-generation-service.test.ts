import assert from 'node:assert/strict'
import { mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'

import type { CliDetectResult } from '../../shared/electron-api'
import type { CommandRun, CommandRunInput } from './run-command'
import { generateChatTitle, generateHeadlessText, type TextGenerationServiceDeps } from './text-generation-service'
import { test } from 'vitest'

test('text-generation-service', async () => {
  const tests: Array<{ name: string; body: () => Promise<void> }> = []
  function run(name: string, body: () => Promise<void>): void {
    tests.push({ name, body })
  }

  function detected(cli: string, overrides: Partial<CliDetectResult> = {}): CliDetectResult {
    return {
      cli,
      binary: cli === 'claude-code' ? 'claude' : cli,
      installed: true,
      version: '1.0.0',
      resolvedPath: cli === 'claude-code' ? '/bin/claude' : '/bin/codex',
      hostId: 'local',
      error: null,
      ...overrides,
    }
  }

  function ok(stdout: string, extra: Partial<CommandRun> = {}): CommandRun {
    return { code: 0, stdout, stderr: '', timedOut: false, spawnError: null, ...extra }
  }

  const claudeEnvelope = (title: string): string =>
    JSON.stringify({ type: 'result', is_error: false, structured_output: { title } })

  function deps(
    overrides: Partial<TextGenerationServiceDeps> & { runs?: CommandRunInput[] } = {},
  ): TextGenerationServiceDeps & { runs: CommandRunInput[] } {
    const runs: CommandRunInput[] = overrides.runs ?? []
    return {
      detect: async (cli) => detected(cli),
      env: () => ({ PATH: '/bin', ANTHROPIC_API_KEY: 'sk-secret', ANTHROPIC_BASE_URL: 'https://x', HOME: '/home' }),
      run: async (input) => {
        runs.push(input)
        return ok(claudeEnvelope('Sidebar flicker on switch'))
      },
      now: (() => {
        let tick = 0
        return () => (tick += 1000)
      })(),
      managedMcpConfig: () => false,
      ...overrides,
      runs,
    }
  }

  const claudeEngine = { cli: 'claude-code', model: 'claude-haiku-4-5', reasoning: 'low' }
  const codexEngine = { cli: 'codex', model: 'gpt-5.6-luna', reasoning: 'low' }

  run('a CLI with no backend is refused before anything is probed', async () => {
    let probed = false
    const result = await generateChatTitle(
      { prompt: 'hello', engine: { cli: 'cursor', model: 'auto' } },
      deps({
        detect: async (cli) => {
          probed = true
          return detected(cli)
        },
      }),
    )
    assert.deepEqual(result, { ok: false, code: 'unsupported', message: 'cursor has no text generation backend.' })
    assert.equal(probed, false)
  })

  run("a Claude title leaves strict MCP mode off beside an administrator's managed-mcp.json", async () => {
    const strict = deps()
    await generateChatTitle({ prompt: 'x', engine: claudeEngine }, strict)
    assert.ok(strict.runs[0]!.args.includes('--strict-mcp-config'))
    const managed = deps({ managedMcpConfig: () => true })
    const result = await generateChatTitle({ prompt: 'x', engine: claudeEngine }, managed)
    assert.equal(result.ok && result.value, 'Sidebar flicker on switch')
    assert.ok(!managed.runs[0]!.args.includes('--strict-mcp-config'))
  })

  run('an empty model is refused', async () => {
    const result = await generateChatTitle({ prompt: 'hello', engine: { cli: 'codex', model: '  ' } }, deps())
    assert.equal(result.ok, false)
    assert.equal(!result.ok && result.code, 'unsupported')
  })

  run('an uninstalled or unprobeable CLI is unavailable, and nothing runs', async () => {
    const d = deps({ detect: async (cli) => detected(cli, { installed: false, resolvedPath: null }) })
    const missing = await generateChatTitle({ prompt: 'hello', engine: claudeEngine }, d)
    assert.deepEqual(missing, {
      ok: false,
      code: 'unavailable',
      message: 'claude-code is not installed on this machine.',
    })
    assert.equal(d.runs.length, 0)

    const errored = await generateChatTitle(
      { prompt: 'hello', engine: claudeEngine },
      deps({ detect: async (cli) => detected(cli, { installed: false, error: 'shell spawn failed' }) }),
    )
    assert.equal(!errored.ok && errored.code, 'unavailable')
    assert.match(!errored.ok ? errored.message : '', /could not be probed/)
  })

  run('claude: probed path, scratch cwd, prompt on stdin, auth env stripped, title guarded', async () => {
    const d = deps()
    const result = await generateChatTitle(
      { prompt: 'so basically fix the sidebar', engine: claudeEngine, timeoutMs: 1234 },
      d,
    )
    assert.deepEqual(result, { ok: true, value: 'Sidebar flicker on switch', ms: 1000 })
    assert.equal(d.runs.length, 1)
    const call = d.runs[0]!
    assert.equal(call.file, '/bin/claude', 'the probe path is what runs')
    assert.ok(call.cwd.includes('sprintengine-text-'), 'runs in a scratch directory, not a checkout')
    assert.ok(call.stdin.endsWith('User message:\nso basically fix the sidebar'), 'the prompt rides stdin')
    assert.equal(call.timeoutMs, 1234)
    assert.equal(call.env.ANTHROPIC_API_KEY, undefined, 'no API key reaches claude')
    assert.equal(call.env.ANTHROPIC_BASE_URL, undefined)
    assert.equal(call.env.MAX_THINKING_TOKENS, '0', 'thinking is off: a title is not a reasoning task')
    assert.equal(call.env.PATH, '/bin')
    assert.equal(call.env.HOME, '/home')
    assert.equal(call.args[call.args.indexOf('--model') + 1], 'claude-haiku-4-5')
  })

  run('claude: a bare binary name is used when the probe resolved no path', async () => {
    const d = deps({ detect: async (cli) => detected(cli, { resolvedPath: null }) })
    await generateChatTitle({ prompt: 'x', engine: claudeEngine }, d)
    assert.equal(d.runs[0]!.file, 'claude')
  })

  run('codex: schema written to scratch, last message read back, env left alone', async () => {
    const d = deps({
      run: async (input) => {
        d.runs.push(input)
        if (input.args.includes('mcp')) return ok('[]')
        const outputPath = input.args[input.args.indexOf('--output-last-message') + 1]!
        const schemaPath = input.args[input.args.indexOf('--output-schema') + 1]!
        const schema = JSON.parse(await readFile(schemaPath, 'utf8')) as { required?: string[] }
        assert.deepEqual(schema.required, ['title'], 'the schema file is the chat-title schema')
        await writeFile(outputPath, '{"title":"Fix Mobile Sidebar Flicker"}\n', 'utf8')
        return ok('')
      },
    })
    const result = await generateChatTitle({ prompt: 'fix the flicker', engine: codexEngine }, d)
    // The clock that ticks a second per read is read once more after the MCP
    // listing, to take the listing out of the deadline.
    assert.deepEqual(result, { ok: true, value: 'Fix Mobile Sidebar Flicker', ms: 2000 })
    const call = d.runs[1]!
    assert.equal(call.file, '/bin/codex')
    assert.equal(call.args[0], 'exec')
    assert.equal(call.env.ANTHROPIC_API_KEY, 'sk-secret', 'codex has no subscription/API split to guard')
    assert.equal(call.env.MAX_THINKING_TOKENS, undefined, 'the claude-only thinking switch stays off codex')
    assert.ok(
      call.args[call.args.indexOf('--output-schema') + 1]!.startsWith(call.cwd),
      'schema lives in the scratch dir',
    )
  })

  run('the scratch directory is removed after every outcome', async () => {
    const scratchRoot = await mkdtemp(path.join(tmpdir(), 'tg-test-'))
    try {
      await generateChatTitle({ prompt: 'x', engine: claudeEngine }, deps({ scratchRoot }))
      await generateChatTitle(
        { prompt: 'x', engine: claudeEngine },
        deps({ scratchRoot, run: async () => ok('', { code: 2, stderr: 'boom' }) }),
      )
      await generateChatTitle(
        { prompt: 'x', engine: claudeEngine },
        deps({
          scratchRoot,
          run: async () => {
            throw new Error('exploded')
          },
        }),
      )
      assert.deepEqual(await readdir(scratchRoot), [], 'nothing left behind')
    } finally {
      await rm(scratchRoot, { recursive: true, force: true })
    }
  })

  run('failures are typed, never thrown', async () => {
    const timeout = await generateChatTitle(
      { prompt: 'x', engine: claudeEngine },
      deps({ run: async () => ok('', { timedOut: true, code: null }) }),
    )
    assert.deepEqual(timeout, { ok: false, code: 'timeout', message: 'claude-code did not answer in time.' })

    const spawn = await generateChatTitle(
      { prompt: 'x', engine: claudeEngine },
      deps({ run: async () => ok('', { code: null, spawnError: 'spawn claude ENOENT' }) }),
    )
    assert.equal(!spawn.ok && spawn.code, 'unavailable')

    const exit = await generateChatTitle(
      { prompt: 'x', engine: codexEngine },
      deps({ run: async () => ok('', { code: 1, stderr: 'warning: meta\nERROR: model not supported' }) }),
    )
    assert.deepEqual(exit, { ok: false, code: 'transport', message: 'codex exited 1: ERROR: model not supported' })

    // What codex-cli 0.155.1 prints when the API refuses the request: the
    // error body pretty-printed after `ERROR:`, so the last line is a lone `}`.
    // Captured from `codex exec ... --model gpt-5.6-luna -c
    // model_reasoning_effort="minimal"`; the reason has to survive into the
    // message, or a refused effort level reads as "codex exited 1: }".
    const refusal = [
      'OpenAI Codex v0.155.1',
      '--------',
      'model: gpt-5.6-luna',
      'reasoning effort: minimal',
      '--------',
      'ERROR: {',
      '  "type": "error",',
      '  "error": {',
      '    "type": "invalid_request_error",',
      '    "code": "unsupported_value",',
      `    "message": "Unsupported value: 'minimal' is not supported with the 'gpt-5.6-luna' model.",`,
      '    "param": "reasoning.effort"',
      '  },',
      '  "status": 400',
      '}',
      '',
    ].join('\n')
    const refused = await generateChatTitle(
      { prompt: 'x', engine: codexEngine },
      deps({ run: async () => ok('', { code: 1, stderr: `${refusal}${refusal}` }) }),
    )
    assert.deepEqual(refused, {
      ok: false,
      code: 'transport',
      message: "codex exited 1: Unsupported value: 'minimal' is not supported with the 'gpt-5.6-luna' model.",
    })

    const thrown = await generateChatTitle(
      { prompt: 'x', engine: claudeEngine },
      deps({
        run: async () => {
          throw new Error('exploded')
        },
      }),
    )
    assert.deepEqual(thrown, { ok: false, code: 'transport', message: 'exploded' })

    const noise = await generateChatTitle(
      { prompt: 'x', engine: claudeEngine },
      deps({ run: async () => ok(claudeEnvelope('ok')) }),
    )
    assert.deepEqual(noise, { ok: false, code: 'guardrail', message: 'claude-code returned no usable title.' })

    const errored = await generateChatTitle(
      { prompt: 'x', engine: claudeEngine },
      deps({ run: async () => ok(JSON.stringify({ type: 'result', is_error: true, result: 'rate limited' })) }),
    )
    assert.deepEqual(errored, {
      ok: false,
      code: 'guardrail',
      message: 'claude-code answered with an error: rate limited',
    })
  })

  run("a failed Claude call says the CLI's own reason, not a wrapper's notice or the raw envelope", async () => {
    const envelope = JSON.stringify({
      type: 'result',
      is_error: true,
      result: 'There is an issue with the selected model (claude-nope). It may not exist or you may not have access.',
    })
    const reason =
      'claude-code exited 1: There is an issue with the selected model (claude-nope). It may not exist or you may not have access.'
    const withNotice = await generateChatTitle(
      { prompt: 'x', engine: claudeEngine },
      deps({ run: async () => ok(envelope, { code: 1, stderr: 'npm notice: a new version is available' }) }),
    )
    assert.deepEqual(withNotice, { ok: false, code: 'transport', message: reason })
    const verbose = await generateChatTitle(
      { prompt: 'x', engine: claudeEngine },
      deps({ run: async () => ok(`[{"type":"system"},${envelope}]`, { code: 1 }) }),
    )
    assert.deepEqual(verbose, { ok: false, code: 'transport', message: reason })
  })

  async function main(): Promise<void> {
    let failed = 0
    for (const test of tests) {
      try {
        await test.body()
        console.log(`ok - ${test.name}`)
      } catch (error) {
        failed += 1
        console.error(`not ok - ${test.name}`)
        console.error(error)
      }
    }
    if (failed > 0) throw new Error(`${failed} text-generation-service test(s) failed`)
  }

  const suiteRun = main()

  await suiteRun
})

test('a pull request draft is the same headless call, asking for a title and a body', async () => {
  const { generatePullRequestText } = await import('./text-generation-service')
  const runs: CommandRunInput[] = []
  const result = await generatePullRequestText(
    {
      input: {
        base: 'main',
        head: 'feature/marks',
        commits: 'fix(sidebar): show the marks\n\n---',
        diffStat: ' src/a.ts | 2 +-',
        patch: '-old\n+new',
        template: '### What changed and why\n\n### How it was checked',
        conventionalCommits: true,
      },
      engine: { cli: 'claude-code', model: 'claude-haiku-4-5' },
    },
    {
      detect: async (cli) => ({
        cli,
        binary: 'claude',
        installed: true,
        version: '1.0.0',
        resolvedPath: '/bin/claude',
        hostId: 'local',
        error: null,
      }),
      env: () => ({ PATH: '/bin' }),
      run: async (input) => {
        runs.push(input)
        return {
          code: 0,
          stdout: JSON.stringify({
            type: 'result',
            is_error: false,
            structured_output: {
              title: 'fix(sidebar): show the marks.',
              body: '### What changed and why\n\nThe marks.',
            },
          }),
          stderr: '',
          timedOut: false,
          spawnError: null,
        }
      },
    },
  )
  assert.deepEqual(result.ok && result.value, {
    title: 'fix(sidebar): show the marks',
    body: '### What changed and why\n\nThe marks.',
  })
  const schema = runs[0].args[runs[0].args.indexOf('--json-schema') + 1]
  assert.deepEqual(JSON.parse(schema).required, ['title', 'body'])
  assert.match(runs[0].stdin ?? '', /Conventional Commits/)
  assert.match(runs[0].stdin ?? '', /Template:\n### What changed and why/)
})

function claudeAnswering(structured: unknown, runs: CommandRunInput[]): TextGenerationServiceDeps {
  return {
    detect: async (cli) => ({
      cli,
      binary: 'claude',
      installed: true,
      version: '1.0.0',
      resolvedPath: '/bin/claude',
      hostId: 'local',
      error: null,
    }),
    env: () => ({ PATH: '/bin' }),
    run: async (input) => {
      runs.push(input)
      return {
        code: 0,
        stdout: JSON.stringify({ type: 'result', is_error: false, structured_output: structured }),
        stderr: '',
        timedOut: false,
        spawnError: null,
      }
    },
  }
}

const COMMIT_INPUT = {
  branch: 'feature/marks',
  diffStat: ' src/sidebar.ts | 2 +-',
  patch: '-old\n+new',
  recentSubjects: ['fix(sidebar): show the marks'],
  conventionalCommits: false,
  style: { mode: 'conventional' as const, instructions: '' },
}

test('a commit message is the same headless call, asking for a subject and a body', async () => {
  const { generateCommitMessage } = await import('./text-generation-service')
  const runs: CommandRunInput[] = []
  const result = await generateCommitMessage(
    { input: COMMIT_INPUT, engine: { cli: 'claude-code', model: 'claude-haiku-4-5' } },
    claudeAnswering({ subject: 'Fix(sidebar): keep the marks.', body: 'They vanished on a switch.' }, runs),
  )
  assert.deepEqual(result.ok && result.value, {
    subject: 'fix(sidebar): keep the marks',
    body: 'They vanished on a switch.',
    message: 'fix(sidebar): keep the marks\n\nThey vanished on a switch.',
  })
  const schema = runs[0].args[runs[0].args.indexOf('--json-schema') + 1]
  assert.deepEqual(JSON.parse(schema).required, ['subject', 'body'])
  assert.match(runs[0].stdin ?? '', /The subject must be a Conventional Commit/)
  assert.match(runs[0].stdin ?? '', /Diff:\n-old\n\+new/)
  assert.match(runs[0].cwd, /sprintengine-text-/, 'the CLI runs in a scratch directory, never the checkout')
})

test('a commit message that breaks the convention it was asked for is a guardrail failure', async () => {
  const { generateCommitMessage } = await import('./text-generation-service')
  const result = await generateCommitMessage(
    { input: COMMIT_INPUT, engine: { cli: 'claude-code', model: 'claude-haiku-4-5' } },
    claudeAnswering({ subject: 'Keep the marks', body: '' }, []),
  )
  assert.deepEqual(result, {
    ok: false,
    code: 'guardrail',
    message: 'claude-code returned no usable Conventional Commits message.',
  })
})

// A Codex CLI that answers `codex mcp list --json` with `listing` and every
// other call with a title, recording each run.
function codexAnswering(
  listing: Partial<CommandRun> | (() => never),
  runs: CommandRunInput[],
): TextGenerationServiceDeps {
  return {
    detect: async (cli) => ({
      cli,
      binary: 'codex',
      installed: true,
      version: '1.0.0',
      resolvedPath: '/bin/codex',
      hostId: 'local',
      error: null,
    }),
    env: () => ({ PATH: '/bin', HOME: '/Users/dev' }),
    run: async (input) => {
      runs.push(input)
      const done = { code: 0, stdout: '', stderr: '', timedOut: false, spawnError: null }
      if (input.args.includes('mcp')) return typeof listing === 'function' ? listing() : { ...done, ...listing }
      const outputPath = input.args[input.args.indexOf('--output-last-message') + 1]!
      await writeFile(outputPath, '{"title":"Fix Mobile Sidebar Flicker"}\n', 'utf8')
      return done
    },
  }
}

const CODEX_TITLE = { prompt: 'fix the flicker', engine: { cli: 'codex', model: 'gpt-5.6-luna' } }

test('a Codex title runs with every MCP server its config would start turned off', async () => {
  const runs: CommandRunInput[] = []
  const listing = JSON.stringify([
    { name: 'docs', enabled: true },
    { name: 'my.server', enabled: true },
    { name: 'paused', enabled: false },
  ])
  const result = await generateChatTitle(CODEX_TITLE, codexAnswering({ stdout: listing }, runs))
  assert.equal(result.ok && result.value, 'Fix Mobile Sidebar Flicker')
  const [list, exec] = runs
  assert.deepEqual(list!.args, ['-c', 'features.plugins=false', '-c', 'features.apps=false', 'mcp', 'list', '--json'])
  assert.equal(list!.file, '/bin/codex')
  assert.equal(list!.cwd, exec!.cwd, 'the listing reads the same config the call does')
  assert.deepEqual(list!.env, exec!.env)
  assert.equal(list!.timeoutMs, 10_000)
  assert.ok(exec!.args.includes('features.plugins=false') && exec!.args.includes('features.apps=false'))
  assert.ok(exec!.args.includes('mcp_servers={"docs"={enabled=false},"my.server"={enabled=false}}'))
})

test.each([
  ['exits non-zero', { code: 2, stderr: "error: unrecognized subcommand 'mcp'" }],
  ['times out', { code: null, timedOut: true }],
  ['cannot be started', { code: null, spawnError: 'spawn /bin/codex EACCES' }],
  ['prints something that is not the list', { stdout: 'Warning: config\n[' }],
  [
    'throws',
    () => {
      throw new Error('exploded')
    },
  ],
] as const)('a Codex title still runs, with no MCP override, when the listing %s', async (_, listing) => {
  const runs: CommandRunInput[] = []
  const result = await generateChatTitle(CODEX_TITLE, codexAnswering(listing, runs))
  assert.equal(result.ok && result.value, 'Fix Mobile Sidebar Flicker')
  const exec = runs[runs.length - 1]!
  assert.equal(exec.args[0], 'exec')
  assert.ok(exec.args.includes('features.plugins=false'), 'plugins and apps are off whatever the listing did')
  assert.ok(!exec.args.some((arg) => arg.startsWith('mcp_servers=')))
})

// The caller's deadline is the whole call's: the MCP listing that comes first
// is taken out of it, not added to it.
function codexOnAClock(listingMs: number, runs: CommandRunInput[]): TextGenerationServiceDeps {
  let clock = 1_000_000
  const answering = codexAnswering({ stdout: '[]' }, runs)
  return {
    ...answering,
    now: () => clock,
    run: async (input) => {
      if (input.args.includes('mcp')) clock += listingMs
      return answering.run!(input)
    },
  }
}

test('a Codex title spends what is left of its deadline after the MCP listing, not the whole deadline again', async () => {
  const runs: CommandRunInput[] = []
  const result = await generateChatTitle({ ...CODEX_TITLE, timeoutMs: 30_000 }, codexOnAClock(4_000, runs))
  assert.equal(result.ok, true)
  const [list, exec] = runs
  assert.equal(list!.timeoutMs, 10_000)
  assert.equal(exec!.timeoutMs, 26_000)
})

test('a deadline shorter than the listing’s own bounds the listing too', async () => {
  const runs: CommandRunInput[] = []
  await generateChatTitle({ ...CODEX_TITLE, timeoutMs: 6_000 }, codexOnAClock(1_000, runs))
  assert.equal(runs[0]!.timeoutMs, 6_000)
  assert.equal(runs[1]!.timeoutMs, 5_000)
})

test('a listing that used the whole deadline leaves the call timed out without starting it', async () => {
  const runs: CommandRunInput[] = []
  const result = await generateChatTitle({ ...CODEX_TITLE, timeoutMs: 6_000 }, codexOnAClock(6_000, runs))
  assert.deepEqual(result, { ok: false, code: 'timeout', message: 'codex did not answer in time.' })
  assert.equal(runs.length, 1)
})

test('a headless Codex call keeps to its deadline across the listing as well', async () => {
  const runs: CommandRunInput[] = []
  const deps = codexOnAClock(4_000, runs)
  const answering = deps.run!
  await generateHeadlessText(
    { engine: { cli: 'codex', model: 'gpt-5.6-luna' }, prompt: 'say hi', timeoutMs: 30_000 },
    {
      ...deps,
      run: async (input) => {
        const done = await answering(input)
        const at = input.args.indexOf('--output-last-message')
        if (at >= 0) await writeFile(input.args[at + 1]!, 'hi\n', 'utf8')
        return done
      },
    },
  )
  assert.equal(runs[1]!.timeoutMs, 26_000)
})
