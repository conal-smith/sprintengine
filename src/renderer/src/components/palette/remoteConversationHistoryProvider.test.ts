// @vitest-environment jsdom
import { afterEach, expect, test, vi } from 'vitest'

import { createRemoteConversationHistoryProvider } from './remoteConversationHistoryProvider'
import { registerRemoteChatOpener } from '../workspace/remoteBand/remoteChatSearch'
import { clearConversationJump, usePendingConversationJump } from '../../utils/conversationHistoryNavigation'
import React, { act } from 'react'
import { createRoot } from 'react-dom/client'

// The palette finds what was said in a paired machine's chats as in this
// computer's: one row per chat, wearing its best match and the machine's
// name, and a row opens the chat here at that message.

const context = { workspaceRoot: null, workspaceId: null, scope: 'all' as const, close: vi.fn() }

afterEach(() => {
  clearConversationJump('w-here', 'agent-1')
})

test('each machine is asked once, and its chats are rows that open at the match', async () => {
  const asked: unknown[] = []
  ;(window as unknown as { api: unknown }).api = {
    meshConversationSearch: async (input: { connectionId: string }) => {
      asked.push(input)
      return input.connectionId === 'c1'
        ? {
            ok: true,
            chats: [
              {
                workspaceId: 'rw1',
                chatTitle: 'Parser review',
                hits: [
                  { agentId: 'agent-1', seq: 9, snippet: 'agent said parser', from: 'agent' },
                  { agentId: 'agent-1', seq: 4, snippet: 'you said parser', from: 'person' },
                ],
                count: 5,
              },
            ],
            truncated: false,
          }
        : { ok: false, code: 'search_unsupported', message: 'build-box cannot search its chats from here yet.' }
    },
  }
  const provider = createRemoteConversationHistoryProvider({
    getMachines: () => [
      { connectionId: 'c1', machineName: 'mac-mini' },
      { connectionId: 'c2', machineName: 'build-box' },
    ],
  })
  const rows = await provider.load('parser', context, undefined)
  expect(asked).toEqual([
    { connectionId: 'c1', query: 'parser' },
    { connectionId: 'c2', query: 'parser' },
  ])
  expect(rows).toHaveLength(1)
  expect(rows[0]).toMatchObject({
    label: 'Parser review',
    badge: 'mac-mini',
    mark: { kind: 'remote' },
    conversationMatch: { snippet: 'you said parser', from: 'person', count: 5 },
  })

  const opened: unknown[] = []
  const unregister = registerRemoteChatOpener((target) => {
    opened.push(target)
    return 'w-here'
  })
  try {
    rows[0]!.run()
    expect(context.close).toHaveBeenCalled()
    expect(opened).toEqual([{ connectionId: 'c1', workspaceId: 'rw1', agentId: 'agent-1', seq: 4 }])
    // The chat view here reads the jump as it reads a local match's.
    let pending: number | null = null
    function Probe() {
      pending = usePendingConversationJump('w-here', 'agent-1')
      return null
    }
    const root = createRoot(document.createElement('div'))
    ;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true
    await act(async () => root.render(React.createElement(Probe)))
    expect(pending).toBe(4)
    await act(async () => root.unmount())
  } finally {
    unregister()
  }
})

test('no machine able to answer is said as the palette says a failed search', async () => {
  ;(window as unknown as { api: unknown }).api = {
    meshConversationSearch: async () => ({ ok: false, code: 'unreachable', message: 'mac-mini is not answering.' }),
  }
  const provider = createRemoteConversationHistoryProvider({
    getMachines: () => [{ connectionId: 'c1', machineName: 'mac-mini' }],
  })
  await expect(provider.load('parser', context, undefined)).rejects.toThrow('mac-mini is not answering.')
  const none = createRemoteConversationHistoryProvider({ getMachines: () => [] })
  expect(await none.load('parser', context, undefined)).toEqual([])
})
