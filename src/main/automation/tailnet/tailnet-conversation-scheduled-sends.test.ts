import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'vitest'

import type { ConversationScheduledMessage } from '../../../../packages/conversation-protocol/src/public'
import { studioHeldMessages, studioScheduledSends } from '../../../server/core/studio-scheduled-messages'
import { ConversationRuntime } from '../../conversation-runtime'
import { createMockConversationProvider } from '../../providers/mock-conversation-provider'
import { createScheduledMessages } from '../../scheduled-messages/scheduled-messages'
import { createConversationGatewayHost } from './tailnet-conversation-host'

// A paired device's Schedule on a chat here (`conversation-scheduled-sends`):
// the message is kept among this machine's scheduled messages, named to the
// device that follows the chat, and sent early or deleted from there. The
// same command arriving again is answered as it was the first time.

const HOUR = 60 * 60_000

async function fixture(options: { scheduled?: boolean } = {}) {
  const workspaceRoot = await mkdtemp(join(tmpdir(), 'conversation-scheduled-sends-'))
  const key = { workspaceRoot, workspaceId: 'workspace', agentId: 'agent' }
  const adapter = createMockConversationProvider()
  const runtime = new ConversationRuntime({ adapters: [adapter], getProviderById: () => undefined })
  const sent: string[] = []
  let ids = 0
  const scheduled = createScheduledMessages({
    storage: { read: async () => null, write: async () => undefined },
    listSessions: () => [],
    onConversationEvent: () => () => undefined,
    chatExists: (chat) => chat.workspaceId === key.workspaceId && chat.agentId === key.agentId,
    send: async (_chat, text) => {
      sent.push(text)
      return { ok: true }
    },
    newId: () => `sm-${++ids}`,
  })
  const host = createConversationGatewayHost(
    runtime,
    (id) => (id === key.workspaceId ? workspaceRoot : null),
    () => [{ workspaceRoot, workspaceId: key.workspaceId }],
    () => 'bypass',
    () => null,
    async () => null,
    {},
    options.scheduled === false
      ? {}
      : {
          heldMessages: studioHeldMessages(() => scheduled, workspaceRoot),
          scheduledSends: studioScheduledSends(() => scheduled),
        },
  )
  return {
    key,
    host,
    runtime,
    scheduled,
    sent,
    cleanup: async () => {
      await scheduled.dispose()
      await runtime.shutdown()
      await rm(workspaceRoot, { recursive: true, force: true })
    },
  }
}

test("a device's Schedule is kept here once, and the device following the chat is told", async () => {
  const f = await fixture()
  try {
    const told: ConversationScheduledMessage[][] = []
    const stop = f.host.watchScheduled!(f.key, (messages) => told.push(messages))
    assert.deepEqual(told, [[]], 'told at once, nothing yet')
    const sendAt = Date.now() + HOUR
    const command = { kind: 'scheduleSend' as const, message: 'Start the migration.', sendAt }
    assert.deepEqual(await f.host.command(f.key, 'laptop', 'cmd-1', command), { ok: true })
    // Offered again under its id after a dropped link: the same message.
    assert.deepEqual(await f.host.command(f.key, 'laptop', 'cmd-1', command), { ok: true })
    assert.equal(f.scheduled.state().messages.length, 1)
    assert.deepEqual(told.at(-1), [
      { id: 'sm-1', text: 'Start the migration.', sendAt, createdAt: f.scheduled.state().messages[0]!.createdAt },
    ])
    const listed = f.runtime.listSessions()
    assert.ok(listed.ok)
    assert.equal(listed.sessions.length, 0, 'no session is started')
    stop()
  } finally {
    await f.cleanup()
  }
})

test('a message held for the turn is not among the scheduled ones, which have their own frame', async () => {
  const f = await fixture()
  try {
    f.scheduled.hold(f.key, 'After this turn.', 'held-1')
    await f.host.command(f.key, 'laptop', 'cmd-1', {
      kind: 'scheduleSend',
      message: 'At seven.',
      sendAt: Date.now() + HOUR,
    })
    let told: ConversationScheduledMessage[] = []
    f.host.watchScheduled!(f.key, (messages) => (told = messages))()
    assert.deepEqual(
      told.map((message) => message.text),
      ['At seven.'],
    )
  } finally {
    await f.cleanup()
  }
})

test('Delete and Send now name the message, and a repeat under the same id is answered as the first', async () => {
  const f = await fixture()
  try {
    const later = Date.now() + HOUR
    await f.host.command(f.key, 'laptop', 'cmd-1', { kind: 'scheduleSend', message: 'One.', sendAt: later })
    await f.host.command(f.key, 'laptop', 'cmd-2', { kind: 'scheduleSend', message: 'Two.', sendAt: later })
    const remove = { kind: 'cancelScheduled' as const, scheduledId: 'sm-1' }
    assert.deepEqual(await f.host.command(f.key, 'laptop', 'cmd-3', remove), { ok: true })
    assert.deepEqual(await f.host.command(f.key, 'laptop', 'cmd-3', remove), { ok: true }, 'the same command again')
    const fresh = await f.host.command(f.key, 'laptop', 'cmd-4', remove)
    assert.equal(fresh.ok, false, 'a new Delete of a message already gone')
    assert.match(fresh.message ?? '', /no longer scheduled/)
    // Another chat's message is not this chat's to send.
    const elsewhere = await f.host.command({ ...f.key, agentId: 'other' }, 'laptop', 'cmd-5', {
      kind: 'sendScheduledNow',
      scheduledId: 'sm-2',
    })
    assert.equal(elsewhere.ok, false)
    assert.deepEqual(
      f.scheduled.state().messages.map((message) => message.text),
      ['Two.'],
    )
  } finally {
    await f.cleanup()
  }
})

test('a desktop that keeps no scheduled messages says so, and watches none', async () => {
  const f = await fixture({ scheduled: false })
  try {
    assert.equal(f.host.watchScheduled, undefined)
    const refused = await f.host.command(f.key, 'laptop', 'cmd-1', {
      kind: 'scheduleSend',
      message: 'Later.',
      sendAt: Date.now() + HOUR,
    })
    assert.equal(refused.ok, false)
    assert.match(refused.message ?? '', /does not schedule messages/)
  } finally {
    await f.cleanup()
  }
})
