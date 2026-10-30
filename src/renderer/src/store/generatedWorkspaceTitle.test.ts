import assert from 'node:assert/strict'

import {
  normalizeTextGenerationSettings,
  type ChatTitleRequest,
  type TextGenerationEngine,
  type TextGenerationEngineSettings,
  type TextGenerationResult,
} from '../../../shared/text-generation/contract'
import type { AgentCliAvailabilityMap } from '../../../shared/electron-api'
import type { PluginCatalogEntry, WorkspaceId } from '../types/workspace'
import {
  createGeneratedTitleRequester,
  regenerateWorkspaceTitle,
  resolveStoreTextGenerationEngine,
  type RegenerateTitleDeps,
} from './generatedWorkspaceTitle'
import { useWorkspaceStore } from './workspaceStore'
import { test } from 'vitest'

test('generatedWorkspaceTitle', async () => {
  function run(name: string, body: () => void | Promise<void>): Promise<void> {
    return Promise.resolve()
      .then(body)
      .then(() => {
        console.log(`ok - ${name}`)
      })
      .catch((error) => {
        console.error(`not ok - ${name}`)
        throw error
      })
  }

  /**
   * Let every queued promise callback run. The requester deliberately hands its
   * generate chain to `void`, so a test has nothing to await: draining a few
   * macrotasks is how we see what the chain did (and, with a `wait` that resolves
   * at once, covers the retry hop too).
   */
  async function settle(): Promise<void> {
    for (let i = 0; i < 5; i += 1) await new Promise<void>((resolve) => setImmediate(resolve))
  }

  const WS: WorkspaceId = 'ws-title'
  const ENGINE: TextGenerationEngine = { cli: 'codex', model: 'gpt-5.6-luna', reasoning: 'low' }

  type AppliedCall = [WorkspaceId, string, string | null]

  /**
   * A requester with every dependency injected: no store, no window, no timers.
   * `heuristic` is what the local half returns, `results` is the queue `generate`
   * answers from (one entry per call, so a retry consumes the second).
   */
  function harness(options: {
    heuristic?: string | null
    titleOpen?: boolean
    engine?: TextGenerationEngine | null
    results?: Array<TextGenerationResult | Error>
    cliRuntimes?: ChatTitleRequest['cliRuntimes']
  }) {
    const requests: ChatTitleRequest[] = []
    const applied: AppliedCall[] = []
    const waits: number[] = []
    const results = [...(options.results ?? [])]
    const requester = createGeneratedTitleRequester(
      {
        autoTitle: () => options.heuristic ?? null,
        applyGenerated: (id, title, replacing) => {
          applied.push([id, title, replacing])
          return true
        },
        isTitleOpen: () => options.titleOpen ?? true,
        resolveEngine: () => (options.engine === undefined ? ENGINE : options.engine),
        cliRuntimes: () => options.cliRuntimes,
        generate: (request) => {
          requests.push(request)
          const next = results.shift()
          if (next instanceof Error) return Promise.reject(next)
          return Promise.resolve(next ?? { ok: false, code: 'unavailable', message: 'no result queued' })
        },
      },
      { retryDelayMs: 0, wait: async (ms) => void waits.push(ms) },
    )
    return { requester, requests, applied, waits }
  }

  async function main(): Promise<void> {
    // --- the synchronous half -------------------------------------------------

    await run('the heuristic outcome comes back synchronously, before any call answers', () => {
      const { requester } = harness({ heuristic: 'Fix the stash panel', results: [{ ok: true, value: 'X', ms: 1 }] })
      assert.equal(requester.titleFromPrompt(WS, 'fix the stash panel'), 'Fix the stash panel')
    })

    await run('no engine means no call at all — the heuristic title is the whole answer', async () => {
      const { requester, requests, applied } = harness({ heuristic: 'Fix the stash panel', engine: null })
      assert.equal(requester.titleFromPrompt(WS, 'fix the stash panel'), 'Fix the stash panel')
      await settle()
      assert.deepEqual(requests, [], 'generate is never called when the setting resolves to nothing')
      assert.deepEqual(applied, [])
    })

    // A locked chat is not ours to rename, and a title nobody could apply is a
    // spend for nothing: the requester stops before the engine is even resolved.
    await run('a closed title with no heuristic result makes no call and returns null', async () => {
      let resolved = 0
      const requests: ChatTitleRequest[] = []
      const requester = createGeneratedTitleRequester(
        {
          autoTitle: () => null,
          applyGenerated: () => true,
          isTitleOpen: () => false,
          resolveEngine: () => {
            resolved += 1
            return ENGINE
          },
          cliRuntimes: () => undefined,
          generate: (request) => {
            requests.push(request)
            return Promise.resolve({ ok: true, value: 'Nope', ms: 1 })
          },
        },
        { retryDelayMs: 0, wait: async () => {} },
      )
      assert.equal(requester.titleFromPrompt(WS, '/backlog'), null)
      await settle()
      assert.deepEqual(requests, [])
      assert.equal(resolved, 0, 'the engine is not even resolved for a title that could not land')
    })

    // --- the late half --------------------------------------------------------

    await run('an ok result is applied against the interim heuristic title', async () => {
      const { requester, requests, applied } = harness({
        heuristic: 'Fix the stash panel',
        cliRuntimes: { codex: { command: '/opt/codex' } },
        results: [{ ok: true, value: 'Stash panel loses its hash', ms: 42 }],
      })
      requester.titleFromPrompt(WS, 'fix the stash panel dropping its hash')
      await settle()
      assert.deepEqual(requests, [
        {
          prompt: 'fix the stash panel dropping its hash',
          engine: ENGINE,
          cliRuntimes: { codex: { command: '/opt/codex' } },
        },
      ])
      assert.deepEqual(applied, [[WS, 'Stash panel loses its hash', 'Fix the stash panel']])
    })

    // The heuristic applied nothing but the name is still open, so the call is
    // worth making — and the answer must replace "whatever is there", not a name.
    await run('an open title with no heuristic result generates and applies with replacing = null', async () => {
      const { requester, requests, applied } = harness({
        heuristic: null,
        titleOpen: true,
        results: [{ ok: true, value: 'Backlog sweep', ms: 9 }],
      })
      assert.equal(requester.titleFromPrompt(WS, '/backlog'), null, 'the sync answer is still the heuristic outcome')
      await settle()
      assert.equal(requests.length, 1)
      assert.deepEqual(applied, [[WS, 'Backlog sweep', null]])
    })

    await run('a failed result applies nothing', async () => {
      const { requester, requests, applied } = harness({
        heuristic: 'Fix the stash panel',
        results: [{ ok: false, code: 'guardrail', message: 'the model wrote a paragraph' }],
      })
      requester.titleFromPrompt(WS, 'fix the stash panel')
      await settle()
      assert.equal(requests.length, 1)
      assert.deepEqual(applied, [], 'a failure is silence: the heuristic title stands')
    })

    await run('a rejected generate applies nothing and throws nothing', async () => {
      const { requester, applied } = harness({
        heuristic: 'Fix the stash panel',
        results: [new Error('the bridge blew up')],
      })
      assert.equal(requester.titleFromPrompt(WS, 'fix the stash panel'), 'Fix the stash panel')
      await settle()
      assert.deepEqual(applied, [], 'a rejection is swallowed, and never retried')
    })

    // --- the one retry --------------------------------------------------------

    for (const code of ['transport', 'timeout'] as const) {
      await run(`a ${code} failure is retried exactly once, and the second answer lands`, async () => {
        const { requester, requests, applied, waits } = harness({
          heuristic: 'Fix the stash panel',
          results: [
            { ok: false, code, message: 'first try' },
            { ok: true, value: 'Stash panel loses its hash', ms: 30 },
          ],
        })
        requester.titleFromPrompt(WS, 'fix the stash panel')
        await settle()
        assert.equal(requests.length, 2, 'exactly two attempts')
        assert.deepEqual(requests[0], requests[1], 'the retry sends the same request')
        assert.deepEqual(waits, [0], 'and waits the configured delay between them')
        assert.deepEqual(applied, [[WS, 'Stash panel loses its hash', 'Fix the stash panel']])
      })
    }

    await run('two transport failures in a row give up rather than retrying again', async () => {
      const { requester, requests, applied } = harness({
        heuristic: 'Fix the stash panel',
        results: [
          { ok: false, code: 'transport', message: 'first try' },
          { ok: false, code: 'transport', message: 'second try' },
          { ok: true, value: 'never reached', ms: 1 },
        ],
      })
      requester.titleFromPrompt(WS, 'fix the stash panel')
      await settle()
      assert.equal(requests.length, 2, 'one retry, not a loop')
      assert.deepEqual(applied, [])
    })

    // A missing CLI, an unimplemented backend or a model that answered badly are
    // all settled questions: trying again would cost the same and answer the same.
    for (const code of ['unavailable', 'unsupported', 'guardrail'] as const) {
      await run(`a ${code} failure is not retried`, async () => {
        const { requester, requests, applied, waits } = harness({
          heuristic: 'Fix the stash panel',
          results: [
            { ok: false, code, message: 'no' },
            { ok: true, value: 'never reached', ms: 1 },
          ],
        })
        requester.titleFromPrompt(WS, 'fix the stash panel')
        await settle()
        assert.equal(requests.length, 1)
        assert.deepEqual(waits, [], 'no delay is even waited')
        assert.deepEqual(applied, [])
      })
    }

    // --- the store-backed engine resolver ------------------------------------

    const catalogEntry = (id: string): PluginCatalogEntry =>
      ({
        id,
        displayName: id,
        source: 'bundled',
        version: 1,
        binary: id,
        resumeSession: false,
        sessionIdFromCaller: false,
        agentStateCapable: true,
      }) as PluginCatalogEntry

    const availabilityOf = (map: Record<string, boolean>): AgentCliAvailabilityMap => {
      const out: AgentCliAvailabilityMap = {}
      for (const [cli, installed] of Object.entries(map)) {
        out[cli] = { cli, installed, resolvedPath: installed ? `/usr/bin/${cli}` : null, version: null }
      }
      return out
    }

    const prime = (
      textGeneration: TextGenerationEngineSettings,
      catalog: string[],
      availability: Record<string, boolean>,
    ): void => {
      useWorkspaceStore.setState({
        appSettings: {
          ...useWorkspaceStore.getState().appSettings,
          textGeneration: normalizeTextGenerationSettings(textGeneration),
        },
        pluginCatalogEntries: catalog.map(catalogEntry),
        cliAvailability: availabilityOf(availability),
      } as never)
    }

    await run('the setting turned off resolves to no engine at all', () => {
      prime({ enabled: false, engine: { cli: 'codex', model: '' } }, ['codex'], { codex: true })
      assert.equal(resolveStoreTextGenerationEngine(), null)
    })

    await run('enabled with no chosen engine takes the first supported installed CLI at its default', () => {
      // `generic-shell` is first in the catalog and has no backend, so the pick
      // is about support rather than order alone.
      prime({ enabled: true, engine: null }, ['generic-shell', 'codex'], { codex: true })
      assert.deepEqual(resolveStoreTextGenerationEngine(), { cli: 'codex', model: 'gpt-5.6-luna', reasoning: 'low' })
    })

    await run('a chosen engine whose CLI is not installed falls through to the other supported CLI', () => {
      prime(
        { enabled: true, engine: { cli: 'codex', model: 'gpt-5.6-luna', reasoning: 'high' } },
        ['codex', 'claude-code'],
        {
          codex: false,
          'claude-code': true,
        },
      )
      assert.deepEqual(
        resolveStoreTextGenerationEngine(),
        { cli: 'claude-code', model: 'claude-haiku-5-5', reasoning: 'low' },
        'uninstalling the remembered CLI does not leave the setting pointing at nothing',
      )
    })

    await run('an un-probed CLI is trusted, and a chosen engine keeps its own model and effort', () => {
      prime({ enabled: true, engine: { cli: 'codex', model: 'gpt-5.6-luna', reasoning: 'high' } }, ['codex'], {})
      assert.deepEqual(resolveStoreTextGenerationEngine(), { cli: 'codex', model: 'gpt-5.6-luna', reasoning: 'high' })
    })

    await run('an empty catalog with no chosen engine resolves to nothing', () => {
      prime({ enabled: true, engine: null }, [], {})
      assert.equal(resolveStoreTextGenerationEngine(), null)
    })

    console.log('generatedWorkspaceTitle.test.ts: ok')
  }

  const suiteRun = main().catch((error) => {
    console.error(error)
    process.exitCode = 1
    throw error
  })

  await suiteRun
})

const ENGINE: ChatTitleRequest['engine'] = { cli: 'claude-code' } as ChatTitleRequest['engine']

function regenerateDeps(overrides: Partial<RegenerateTitleDeps> = {}) {
  const renamed: Array<[string, string]> = []
  const asked: ChatTitleRequest[] = []
  const deps: RegenerateTitleDeps = {
    firstPrompt: async () => 'Fix the flaky login test on CI',
    resolveEngine: () => ENGINE,
    cliRuntimes: () => ({}),
    generate: async (request) => {
      asked.push(request)
      return { ok: true, value: '  Flaky login test  ', ms: 5 }
    },
    rename: (id, name) => renamed.push([id, name]),
    ...overrides,
  }
  return { deps, renamed, asked }
}

test('regenerating a title asks the model from the first message and renames the chat', async () => {
  const { deps, renamed, asked } = regenerateDeps()
  const result = await regenerateWorkspaceTitle('ws-1' as WorkspaceId, deps)
  assert.deepEqual(result, { ok: true, title: 'Flaky login test' })
  assert.equal(asked[0]?.prompt, 'Fix the flaky login test on CI')
  assert.deepEqual(renamed, [['ws-1', 'Flaky login test']])
})

test('regenerating a title says why when it cannot, and leaves the name alone', async () => {
  const off = regenerateDeps({ resolveEngine: () => null })
  assert.equal((await regenerateWorkspaceTitle('ws-1' as WorkspaceId, off.deps)).ok, false)
  const empty = regenerateDeps({ firstPrompt: async () => '   ' })
  const noPrompt = await regenerateWorkspaceTitle('ws-1' as WorkspaceId, empty.deps)
  assert.equal(noPrompt.ok, false)
  assert.equal(empty.asked.length, 0, 'no call without a message to title from')
  const failed = regenerateDeps({
    generate: async (): Promise<TextGenerationResult> => ({ ok: false, code: 'transport', message: 'exited 1' }),
  })
  assert.deepEqual(await regenerateWorkspaceTitle('ws-1' as WorkspaceId, failed.deps), {
    ok: false,
    message: 'exited 1',
  })
  for (const run of [off, empty, failed]) assert.deepEqual(run.renamed, [])
})
