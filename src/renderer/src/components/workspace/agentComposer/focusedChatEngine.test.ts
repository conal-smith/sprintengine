import { expect, test } from 'vitest'

import { chatEngine } from './focusedChatEngine'
import { keyMayBeSet } from './useAgentComposer'

test("a chat's new tab stands on the chat's CLI and model", () => {
  expect(chatEngine({ conversation: { providerId: 'codex-agent', modelId: 'gpt-6.1-sol' } })).toEqual({
    cli: 'codex',
    model: 'gpt-6.1-sol',
    reasoning: null,
  })
})

test("the tab takes the chat's effort too, so it runs as the chat beside it does", () => {
  const chat = { conversation: { providerId: 'codex-agent', modelId: 'gpt-6.1-sol' } }
  expect(chatEngine({ ...chat, conversationReasoningEffort: 'high' })?.reasoning).toBe('high')
})

test("a chat on its CLI's default model names none", () => {
  expect(chatEngine({ conversation: { providerId: 'codex-agent', modelId: 'default' } })?.model).toBeNull()
})

test('a terminal agent stands on its own CLI, and a shell on nothing', () => {
  expect(chatEngine({ cli: 'codex' })?.cli).toBe('codex')
  expect(chatEngine({})).toBeNull()
  expect(chatEngine(undefined)).toBeNull()
})

test('a key store that cannot be read leaves a runtime in the pickers; only a clear "none" takes it out', () => {
  const status = (configured: boolean) => ({ ok: true, status: { configured } }) as never
  expect(keyMayBeSet(status(true))).toBe(true)
  expect(keyMayBeSet(status(false))).toBe(false)
  expect(keyMayBeSet({ ok: false, message: 'The keychain is locked.' })).toBe(true)
})
