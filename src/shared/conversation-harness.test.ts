import { expect, test } from 'vitest'
import {
  cliForConversationProvider,
  conversationClis,
  conversationPermissionModes,
  conversationPermissionPresetRefusals,
  conversationProviderForCli,
} from './conversation-harness'

test('Kimi Code has a chat runtime, its own Kimi Code agent provider', () => {
  expect(conversationProviderForCli('kimi-code')).toBe('kimi-code-agent')
  expect(cliForConversationProvider('kimi-code-agent')).toBe('kimi-code')
  expect(conversationClis()).toEqual(['claude-code', 'codex', 'cursor', 'opencode', 'grok', 'kimi-code'])
})

test('the Kimi K3 runtime that rides Claude Code has no chat runtime of its own', () => {
  expect(conversationProviderForCli('kimi-claude')).toBeNull()
})

test('a Kimi Code chat refuses Manual with the reason, and runs no other mode of its own', () => {
  expect(conversationPermissionPresetRefusals('kimi-code')).toEqual({
    manual: 'Kimi Code edits files in a git project without asking, so it cannot ask before every change.',
  })
  expect(conversationPermissionModes('kimi-code')).toEqual([])
})
