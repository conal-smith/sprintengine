import { expect, test } from 'vitest'

import { chatEngine } from './focusedChatEngine'

test("a chat's new tab stands on the chat's CLI and model", () => {
  expect(chatEngine({ conversation: { providerId: 'codex-agent', modelId: 'gpt-6.1-sol' } })).toEqual({
    cli: 'codex',
    model: 'gpt-6.1-sol',
    reasoning: null,
  })
})

test("a chat on its CLI's default model names none", () => {
  expect(chatEngine({ conversation: { providerId: 'codex-agent', modelId: 'default' } })?.model).toBeNull()
})

test('a terminal agent stands on its own CLI, and a shell on nothing', () => {
  expect(chatEngine({ cli: 'codex' })?.cli).toBe('codex')
  expect(chatEngine({})).toBeNull()
  expect(chatEngine(undefined)).toBeNull()
})
