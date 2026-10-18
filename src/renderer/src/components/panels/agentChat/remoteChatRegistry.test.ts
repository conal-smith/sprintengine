import assert from 'node:assert/strict'

import { afterEach, test } from 'vitest'

import type { ChatBinding } from './chatBinding'
import type { ConversationTransport } from './conversationTransport'
import { publishRemoteChat, readRemoteChat, resetRemoteChats } from './remoteChatRegistry'

const entry = (agentId: string) => ({
  agentId,
  transport: {} as ConversationTransport,
  binding: {} as ChatBinding,
})

afterEach(() => resetRemoteChats())

test('a remote chat open in a workspace is found there, by its agent or as the one open', () => {
  const one = entry('agent-1')
  publishRemoteChat('ws-1', one)
  assert.equal(readRemoteChat('ws-1', 'agent-1'), one)
  assert.equal(readRemoteChat('ws-1', null), one)
  assert.equal(readRemoteChat('ws-1', 'agent-2'), null)
  assert.equal(readRemoteChat('ws-2', null), null)
})

test('with no agent asked for, the chat published last is the one shown', () => {
  publishRemoteChat('ws-1', entry('agent-1'))
  const two = entry('agent-2')
  publishRemoteChat('ws-1', two)
  assert.equal(readRemoteChat('ws-1', null), two)
})

test('a pane that closes takes its chat back, and a stale take-back leaves the newer one', () => {
  const first = entry('agent-1')
  const unpublishFirst = publishRemoteChat('ws-1', first)
  const second = entry('agent-1')
  const unpublishSecond = publishRemoteChat('ws-1', second)
  unpublishFirst()
  assert.equal(readRemoteChat('ws-1', 'agent-1'), second)
  unpublishSecond()
  assert.equal(readRemoteChat('ws-1', null), null)
})
