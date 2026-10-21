import assert from 'node:assert/strict'
import { test } from 'vitest'

import { CONVERSATION_MAX_MODEL_OPTIONS } from '../../packages/conversation-protocol/src'
import type { DiscoveredCliModelCatalog } from '../shared/cli-model-catalog'
import { createConversationModelCatalog, type ConversationModelCatalogDeps } from './conversation-model-catalog'

const claude = {
  id: 'claude-code',
  displayName: 'Claude Code',
  modelSelection: {
    options: [
      { id: 'seed-a', label: 'Seed A' },
      { id: 'seed-b', label: 'Seed B' },
    ],
    allowCustomId: true,
  },
}

function catalogWith(overrides: Partial<ConversationModelCatalogDeps> = {}) {
  return createConversationModelCatalog({
    listClis: () => [claude, { id: 'codex', displayName: 'Codex' }],
    readDiscovered: async () => ({}),
    userModels: () => undefined,
    now: () => Date.parse('2026-09-27T12:00:00Z'),
    ...overrides,
  })
}

const discovered = (ids: Array<{ id: string; displayName?: string }>): DiscoveredCliModelCatalog => ({
  models: ids,
  fetchedAt: '2026-09-27T10:00:00Z',
  source: 'agent-sdk',
})

test("a chat's catalog is its CLI's manifest seed until the CLI has reported, then the ids the person added", async () => {
  const catalog = catalogWith({ userModels: (cli) => (cli === 'claude-code' ? ['my-model', 'seed-a'] : undefined) })
  assert.deepEqual(await catalog('claude-agent'), {
    cli: 'claude-code',
    cliLabel: 'Claude Code',
    options: [{ id: 'seed-a', label: 'Seed A' }, { id: 'seed-b', label: 'Seed B' }, { id: 'my-model' }],
  })
})

test("once the CLI has reported its models they replace the seed, as this machine's picker shows them", async () => {
  const catalog = catalogWith({
    readDiscovered: async () => ({
      'claude-code': discovered([
        { id: 'default', displayName: 'Default (recommended)' },
        { id: 'opus', displayName: 'Opus' },
        { id: 'sonnet' },
      ]),
    }),
  })
  assert.deepEqual(await catalog('claude-agent'), {
    cli: 'claude-code',
    cliLabel: 'Claude Code',
    // The CLI's own default is the CLI's row, never a listed model.
    options: [{ id: 'opus', label: 'Opus' }, { id: 'sonnet' }],
  })
})

test('a provider that is not a CLI, a CLI this app does not hold, or one with no model choice has no catalog', async () => {
  const catalog = catalogWith({ listClis: () => [{ id: 'codex', displayName: 'Codex' }] })
  assert.equal(await catalog('openrouter'), null)
  assert.equal(await catalog('claude-agent'), null)
  assert.equal(await catalog('codex-agent'), null)
})

test('an unreadable discovery cache reads as none, and a long catalog is cut to the wire bound', async () => {
  const unreadable = catalogWith({ readDiscovered: async () => Promise.reject(new Error('EACCES')) })
  assert.equal((await unreadable('claude-agent'))?.options.length, 2)
  const long = catalogWith({
    readDiscovered: async () => ({
      'claude-code': discovered([
        { id: 'x'.repeat(201) },
        ...Array.from({ length: CONVERSATION_MAX_MODEL_OPTIONS + 10 }, (_, index) => ({ id: `m${index}` })),
      ]),
    }),
  })
  const options = (await long('claude-agent'))?.options ?? []
  assert.equal(options.length, CONVERSATION_MAX_MODEL_OPTIONS)
  assert.equal(options[0]?.id, 'm0', 'an id longer than the wire takes is dropped, not cut')
})

test('past the wire bound the ids the person added are kept, and the CLI fills the rest in its order', async () => {
  const long = catalogWith({
    readDiscovered: async () => ({
      'claude-code': discovered(
        Array.from({ length: CONVERSATION_MAX_MODEL_OPTIONS + 50 }, (_, index) => ({ id: `m${index}` })),
      ),
    }),
    userModels: (cli) => (cli === 'claude-code' ? ['acme/my-model', 'm3'] : undefined),
  })
  const ids = ((await long('claude-agent'))?.options ?? []).map((option) => option.id)
  assert.equal(ids.length, CONVERSATION_MAX_MODEL_OPTIONS)
  assert.equal(ids[ids.length - 1], 'acme/my-model', 'the added id is kept, where the merge puts it')
  assert.deepEqual(ids.slice(0, 3), ['m0', 'm1', 'm2'])
  // `m3` was reported by the CLI as well; it is one row, in the CLI's place.
  assert.equal(ids.filter((id) => id === 'm3').length, 1)
  assert.equal(ids[ids.length - 2], `m${CONVERSATION_MAX_MODEL_OPTIONS - 2}`)
})
