import assert from 'node:assert/strict'
import { test } from 'vitest'

import type { McpConnectionContext } from '../../shared/modules/mcp-tools'
import { CHAT_SEARCH_CHAT_LIMIT, CHAT_SEARCH_HIT_LIMIT, searchChatsHere } from './conversation-search'
import { createConversationTools } from './conversation-tools'

// A paired desktop's palette finds what was said in this machine's chats as
// this machine's own palette does: chat by chat, in the sidebar's order, in
// one bounded answer.

const chat = (workspaceId: string) => ({
  workspaceId,
  workspaceRoot: `/r/${workspaceId}`,
  chatTitle: `Chat ${workspaceId}`,
})
const hit = (seq: number, from?: 'person' | 'agent') => ({
  agentId: 'agent-1',
  seq,
  snippet: `match ${seq}`,
  ...(from ? { from } : {}),
})

test('chats with a match are named in order, each with its matches and how many', async () => {
  const asked: string[] = []
  const answer = await searchChatsHere('parser', {
    chats: () => [chat('a'), chat('b'), chat('c')],
    search: async (input) => {
      asked.push(input.workspaceId)
      if (input.workspaceId === 'b') return { ok: false, message: 'unreadable' }
      if (input.workspaceId === 'c') return { ok: true, hits: [] }
      return { ok: true, hits: Array.from({ length: CHAT_SEARCH_HIT_LIMIT + 5 }, (_, index) => hit(index, 'person')) }
    },
  })
  assert.deepEqual(asked, ['a', 'b', 'c'], 'a chat that cannot be read costs its own matches only')
  assert.equal(answer.truncated, false)
  assert.equal(answer.chats.length, 1)
  assert.equal(answer.chats[0]?.chatTitle, 'Chat a')
  assert.equal(answer.chats[0]?.hits.length, CHAT_SEARCH_HIT_LIMIT)
  assert.equal(answer.chats[0]?.count, CHAT_SEARCH_HIT_LIMIT + 5)
})

test('the answer stops at its limit, and at its time, and says so', async () => {
  const many = Array.from({ length: CHAT_SEARCH_CHAT_LIMIT + 3 }, (_, index) => chat(`w${index}`))
  const full = await searchChatsHere('x', { chats: () => many, search: async () => ({ ok: true, hits: [hit(1)] }) })
  assert.equal(full.chats.length, CHAT_SEARCH_CHAT_LIMIT)
  assert.equal(full.truncated, true)
  let clock = 0
  const slow = await searchChatsHere('x', {
    chats: () => many,
    now: () => clock,
    budgetMs: 10,
    search: async () => {
      clock += 6
      return { ok: true, hits: [hit(1)] }
    },
  })
  assert.equal(slow.chats.length, 2)
  assert.equal(slow.truncated, true)
})

test('conversation.search refuses a question too short, and answers through the search it is given', async () => {
  const TAILNET: McpConnectionContext = { metadata: { kind: 'remote-tailnet', deviceId: 'device-1' } }
  const tools = createConversationTools({
    launch: async () => assert.fail('no chat is started here'),
    resolveAgentPermissionPreset: () => 'bypass',
    lifecycle: {} as never,
    searchChats: async (query) => ({
      chats: [{ workspaceId: 'a', chatTitle: query, hits: [hit(3)], count: 1 }],
      truncated: false,
    }),
  })
  const search = tools.find((tool) => tool.name === 'conversation.search')!
  const short = await search.handler({ query: ' p ' }, TAILNET)
  assert.equal((short.structuredContent as { error: { code: string } }).error.code, 'invalid_arguments')
  const found = await search.handler({ query: ' parser ' }, TAILNET)
  assert.deepEqual(found.structuredContent, {
    ok: true,
    chats: [{ workspaceId: 'a', chatTitle: 'parser', hits: [hit(3)], count: 1 }],
    truncated: false,
  })
})
