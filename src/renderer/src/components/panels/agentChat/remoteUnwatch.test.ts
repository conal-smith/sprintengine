// @vitest-environment jsdom
import { expect, test } from 'vitest'

import { createRemoteConversationTransport } from './conversationTransport'

// Stop watching on a paired machine's chat's strip ends that machine's watch,
// named by the chat's agent there and the pull request's address, and says a
// refusal in the machine's words.

test('Stop watching asks the machine the chat runs on', async () => {
  const asked: unknown[] = []
  let answer: { ok: true; workspaceId: string } | { ok: false; code: string; message: string } = {
    ok: true,
    workspaceId: 'rw1',
  }
  ;(window as unknown as { api: unknown }).api = {
    meshChangeConversation: async (input: unknown) => {
      asked.push(input)
      return answer
    },
  }
  const transport = createRemoteConversationTransport({
    key: { connectionId: 'c1', workspaceId: 'rw1', agentId: 'agent-there' },
    machineName: 'mac-mini',
    access: 'operate',
  })
  const url = 'https://github.com/acme/app/pull/7'
  expect(await transport.unwatchPullRequest!({ url })).toEqual({ ok: true })
  expect(asked).toEqual([
    { connectionId: 'c1', workspaceId: 'rw1', change: { kind: 'unwatch-pull-request', agentId: 'agent-there', url } },
  ])
  answer = { ok: false, code: 'row_menu_unsupported', message: 'mac-mini cannot do it yet.' }
  expect(await transport.unwatchPullRequest!({ url })).toEqual({ ok: false, message: 'mac-mini cannot do it yet.' })
})
