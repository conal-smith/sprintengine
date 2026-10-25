import { afterEach, expect, test, vi } from 'vitest'

import { createRemoteConversationTransport } from './conversationTransport'

// The calls a chat on a paired machine makes, as the transport puts them to
// main: what each carries over, and what it leaves for that machine to say.

const key = { connectionId: 'connection', workspaceId: 'remote-workspace', agentId: 'remote-agent' }

function transportWith(api: Record<string, unknown>) {
  vi.stubGlobal('window', { api })
  return createRemoteConversationTransport({ key, machineName: 'mac-mini', access: 'operate' })
}

afterEach(() => {
  vi.unstubAllGlobals()
})

test('a send carries the mode its turn runs in, and leaves the default one unsaid', async () => {
  const meshConversationSend = vi.fn(async () => ({ ok: true as const }))
  const transport = transportWith({ meshConversationSend })
  await transport.send({ sessionId: 'remote-session', message: 'Why does it flake?', mode: 'ask' })
  await transport.send({ sessionId: 'remote-session', message: 'Fix it', mode: 'default' })
  expect(meshConversationSend.mock.calls).toEqual([
    [{ key, message: 'Why does it flake?', mode: 'ask' }],
    [{ key, message: 'Fix it' }],
  ])
})
