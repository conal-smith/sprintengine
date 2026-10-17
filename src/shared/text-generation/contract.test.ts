import assert from 'node:assert/strict'
import { resolveTextGenerationEngine, supportsTextGeneration } from './contract'
import { test } from 'vitest'

test('contract', async () => {
  const tests: Array<{ name: string; body: () => void }> = []
  function run(name: string, body: () => void): void {
    tests.push({ name, body })
  }

  const allInstalled = (): boolean | undefined => true

  run('only CLIs with a backend support text generation', () => {
    assert.equal(supportsTextGeneration('claude-code'), true)
    assert.equal(supportsTextGeneration('codex'), true)
    assert.equal(supportsTextGeneration('cursor'), false)
    assert.equal(supportsTextGeneration(null), false)
    assert.equal(supportsTextGeneration('constructor'), false, 'prototype keys are not backends')
  })

  run('disabled means no engine, whatever is installed', () => {
    assert.equal(
      resolveTextGenerationEngine(
        { enabled: false, engine: { cli: 'codex', model: 'gpt-6-astra' } },
        ['codex'],
        allInstalled,
      ),
      null,
    )
    assert.equal(resolveTextGenerationEngine(null, ['codex'], allInstalled), null)
  })

  run('a chosen engine is used as picked, with the cheap defaults filled in', () => {
    assert.deepEqual(
      resolveTextGenerationEngine(
        { enabled: true, engine: { cli: 'codex', model: 'gpt-6-astra', reasoning: 'high' } },
        [],
        allInstalled,
      ),
      { cli: 'codex', model: 'gpt-6-astra', reasoning: 'high' },
    )
    assert.deepEqual(
      resolveTextGenerationEngine({ enabled: true, engine: { cli: 'claude-code', model: '' } }, [], allInstalled),
      { cli: 'claude-code', model: 'claude-haiku-5-5', reasoning: 'low' },
      'an empty model means the backend default, and effort defaults to low',
    )
  })

  run('a chosen CLI that is gone falls through to the first supported installed one', () => {
    const installed = (cli: string): boolean | undefined => (cli === 'codex' ? false : true)
    assert.deepEqual(
      resolveTextGenerationEngine(
        { enabled: true, engine: { cli: 'codex', model: 'gpt-6-astra' } },
        ['cursor', 'codex', 'claude-code'],
        installed,
      ),
      { cli: 'claude-code', model: 'claude-haiku-5-5', reasoning: 'low' },
    )
  })

  run('no engine chosen picks the first supported candidate; none installed means null', () => {
    assert.deepEqual(resolveTextGenerationEngine({ enabled: true, engine: null }, ['cursor', 'codex'], allInstalled), {
      cli: 'codex',
      model: 'gpt-5.6-luna',
      reasoning: 'low',
    })
    assert.equal(
      resolveTextGenerationEngine({ enabled: true, engine: null }, ['codex', 'claude-code'], () => false),
      null,
    )
    assert.equal(resolveTextGenerationEngine({ enabled: true, engine: null }, ['cursor'], allInstalled), null)
  })

  run('an unprobed CLI still counts as usable', () => {
    assert.deepEqual(
      resolveTextGenerationEngine({ enabled: true, engine: null }, ['claude-code'], () => undefined),
      { cli: 'claude-code', model: 'claude-haiku-5-5', reasoning: 'low' },
    )
  })

  let failed = 0
  for (const test of tests) {
    try {
      test.body()
      console.log(`ok - ${test.name}`)
    } catch (error) {
      failed += 1
      console.error(`not ok - ${test.name}`)
      console.error(error)
    }
  }
  if (failed > 0) throw new Error(`${failed} contract test(s) failed`)
})
