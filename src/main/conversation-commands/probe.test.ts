import { expect, test, vi } from 'vitest'

const acp = vi.hoisted(() => ({
  probeAcpConversationCommands: vi.fn(async () => [{ name: 'plan', source: 'cli' as const }]),
}))
vi.mock('../providers/acp-conversation-provider', () => ({
  ACP_PROFILES: [{ cli: 'cursor' }, { cli: 'opencode' }, { cli: 'grok' }, { cli: 'kimi-code' }],
  probeAcpConversationCommands: acp.probeAcpConversationCommands,
}))

import { probeConversationCommands } from './probe'

test('a CLI that lists its commands only inside a session is not started to ask', async () => {
  for (const cli of ['cursor', 'opencode', 'kimi-code'])
    expect(await probeConversationCommands({ cli, cwd: '/Users/dev/app' })).toBeNull()
  expect(acp.probeAcpConversationCommands).not.toHaveBeenCalled()
})

test('a CLI whose handshake carries its commands is asked', async () => {
  expect(await probeConversationCommands({ cli: 'grok', cwd: '/Users/dev/app' })).toEqual([
    { name: 'plan', source: 'cli' },
  ])
  expect(acp.probeAcpConversationCommands).toHaveBeenCalledOnce()
})
