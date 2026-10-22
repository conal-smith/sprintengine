import assert from 'node:assert/strict'
import { test } from 'vitest'

import { openChatLink, type ChatLinkOpenerDeps } from './chatLinkOpener'

type Chat = { agents: Record<string, { name: string }> }

function harness(chats: Record<string, Chat>, holders: Record<string, string> = {}) {
  const calls: string[] = []
  const deps: ChatLinkOpenerDeps = {
    getChat: (chatId) => chats[chatId] ?? null,
    holderOf: (chatId) => holders[chatId] ?? null,
    windowId: 'primary',
    moveHere: (chatId, from) => void calls.push(`move ${chatId} from ${from ?? 'nowhere'}`),
    select: (chatId) => void calls.push(`select ${chatId}`),
    revealAgent: (chatId, agentId, name) => void calls.push(`reveal ${chatId}/${agentId} ${name}`),
    notOnThisMachine: () => void calls.push('not on this machine'),
  }
  return { deps, calls }
}

const chat: Chat = { agents: { 'agent-claude-1': { name: 'Otter' }, 'agent-codex-2': { name: 'Heron' } } }

test('a chat this window holds is selected, and nothing else happens', () => {
  const { deps, calls } = harness({ ws1: chat }, { ws1: 'primary' })
  assert.equal(openChatLink({ kind: 'chat', chatId: 'ws1', agentId: null }, deps), true)
  assert.deepEqual(calls, ['select ws1'])
})

test('the named agent of the chat comes forward after the chat is selected', () => {
  const { deps, calls } = harness({ ws1: chat }, { ws1: 'primary' })
  openChatLink({ kind: 'chat', chatId: 'ws1', agentId: 'agent-codex-2' }, deps)
  assert.deepEqual(calls, ['select ws1', 'reveal ws1/agent-codex-2 Heron'])
})

test('an agent the chat no longer has still opens the chat', () => {
  const { deps, calls } = harness({ ws1: chat }, { ws1: 'primary' })
  assert.equal(openChatLink({ kind: 'chat', chatId: 'ws1', agentId: 'agent-gone' }, deps), true)
  assert.deepEqual(calls, ['select ws1'])
})

test('a chat that is not here says so and selects nothing', () => {
  const { deps, calls } = harness({ ws1: chat })
  assert.equal(openChatLink({ kind: 'chat', chatId: 'ws-elsewhere', agentId: 'agent-claude-1' }, deps), false)
  assert.deepEqual(calls, ['not on this machine'])
})

test('a chat filed under a window that is not this one is moved here first', () => {
  const { deps, calls } = harness({ ws1: chat, ws2: chat }, { ws1: 'detached-a' })
  openChatLink({ kind: 'chat', chatId: 'ws1', agentId: null }, deps)
  openChatLink({ kind: 'chat', chatId: 'ws2', agentId: null }, deps)
  assert.deepEqual(calls, ['move ws1 from detached-a', 'select ws1', 'move ws2 from nowhere', 'select ws2'])
})

test('a chat a paired machine runs, linked by its id there, opens as its row does', () => {
  const { deps, calls } = harness({ ws1: chat })
  const remote: ChatLinkOpenerDeps = {
    ...deps,
    openRemote: (chatId) => {
      calls.push(`open ${chatId} from its machine`)
      return chatId === 'rw1'
    },
  }
  assert.equal(openChatLink({ kind: 'chat', chatId: 'rw1', agentId: null }, remote), true)
  assert.equal(openChatLink({ kind: 'chat', chatId: 'ws-gone', agentId: null }, remote), false)
  assert.deepEqual(calls, ['open rw1 from its machine', 'open ws-gone from its machine', 'not on this machine'])
})
