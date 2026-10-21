import assert from 'node:assert/strict'
import { existsSync } from 'node:fs'
import { mkdtemp, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test, vi } from 'vitest'
import { ConversationRuntime } from '../../conversation-runtime'
import { createMockConversationProvider } from '../../providers/mock-conversation-provider'
import type { ConversationProviderAdapter } from '../../providers/conversation-provider-adapter'
import type { ConversationPermissionPreset } from '../../../shared/conversation-runtime'
import {
  createConversationGatewayHost,
  readBoundedConversationUpload,
  type AgentChoicePatch,
  type ConversationHeldMessages,
} from './tailnet-conversation-host'
import { MAX_ATTACHMENTS_PER_TURN, MAX_ATTACHMENT_BYTES } from '../../../shared/conversation-attachments'
import { CONVERSATION_MAX_IMAGES } from '../../../../packages/conversation-protocol/src'
import type { ConversationQueuedMessage } from '../../../../packages/conversation-protocol/src/public'
import type { ConversationModelCatalog } from '../../conversation-model-catalog'

type Preset = ConversationPermissionPreset

async function fixture(
  options: {
    preset?: Preset
    defaultPreset?: Preset
    workspaceRoot?: string
    adapter?: ConversationProviderAdapter
    agentName?: string | null
    modelCatalog?: (providerId: string) => Promise<ConversationModelCatalog | null>
    heldMessages?: ConversationHeldMessages
  } = {},
) {
  const workspaceRoot = options.workspaceRoot ?? (await mkdtemp(join(tmpdir(), 'conversation-gateway-')))
  const key = { workspaceRoot, workspaceId: 'workspace', agentId: 'agent' }
  // The mock provider has no live permission surface; the runtime needs one to
  // accept a preset switch.
  const adapter = options.adapter ?? {
    ...createMockConversationProvider(),
    setPermissionPreset: async () => ({ ok: true as const }),
  }
  const runtime = new ConversationRuntime({ adapters: [adapter], getProviderById: () => undefined })
  const defaults: Array<{ workspaceId: string; agentId: string }> = []
  const written: AgentChoicePatch[] = []
  const host = createConversationGatewayHost(
    runtime,
    (id) => (id === key.workspaceId ? workspaceRoot : null),
    () => [{ workspaceRoot, workspaceId: key.workspaceId }],
    (asked: { workspaceId: string; agentId: string }) => {
      if (options.defaultPreset) defaults.push(asked)
      return options.defaultPreset ?? 'bypass'
    },
    (asked) => (asked.agentId === key.agentId ? options.agentName : null),
    options.modelCatalog,
    undefined,
    {
      writeAgentChoice: (asked, patch) => {
        if (asked.workspaceId === key.workspaceId && asked.agentId === key.agentId) written.push(patch)
      },
      ...(options.heldMessages ? { heldMessages: options.heldMessages } : {}),
    },
  )
  const start = (permissionPreset: Preset = options.preset ?? 'bypass') =>
    runtime.startSession({
      ...key,
      providerId: adapter.id,
      modelId: adapter.listModels()[0],
      permissionPreset,
    })
  return {
    key,
    host,
    runtime,
    start,
    defaults,
    written,
    cleanup: async (keepFolder = false) => {
      await runtime.shutdown()
      if (!keepFolder) await rm(workspaceRoot, { recursive: true, force: true })
    },
  }
}

test('gateway lists closed history and resumes concurrent sends once, under the preset the chat was left on', async () => {
  const f = await fixture({ preset: 'none' })
  try {
    const started = await f.start()
    assert.ok(started.ok)
    await f.runtime.sendTurn({ sessionId: started.session.sessionId, message: '/tools' })
    await f.runtime.stopSession({ sessionId: started.session.sessionId })
    const closed = (await f.host.list())[0]
    assert.equal(closed.sessionId, undefined)
    assert.equal(closed.permissionPreset, 'none', 'a stopped session still names the preset it had')
    assert.equal(
      closed.capabilities?.images,
      true,
      'a chat at rest names what its provider can do, so a client takes a picture for it',
    )
    const start = vi.spyOn(f.runtime, 'startSession')
    const results = await Promise.all(
      ['one', 'two'].map((commandId) => f.host.command(f.key, 'phone', commandId, { kind: 'send', message: '/tools' })),
    )
    assert.equal(start.mock.calls.length, 1)
    assert.equal(start.mock.calls[0][0].permissionPreset, 'none', 'the resume keeps the last preset')
    assert.ok(results.some((result) => result.ok))
    const live = (await f.host.list())[0]
    assert.ok(live.sessionId)
    assert.equal(live.permissionPreset, 'none')
    assert.equal(live.capabilities?.images, true)
    assert.equal(f.host.resolveKey('missing', 'agent'), null)
    assert.deepEqual(f.host.resolveKey('workspace', 'agent'), f.key)
  } finally {
    await f.cleanup()
  }
})

test('a conversation this app has not run since it started lists and resumes on the injected default', async () => {
  const first = await fixture()
  const started = await first.start()
  assert.ok(started.ok)
  await first.runtime.sendTurn({ sessionId: started.session.sessionId, message: '/tools' })
  await first.cleanup(true)
  // A restart: the transcript is on disk, no session is in memory.
  const f = await fixture({ workspaceRoot: first.key.workspaceRoot, defaultPreset: 'none' })
  try {
    const listed = (await f.host.list())[0]
    assert.equal(listed.sessionId, undefined)
    assert.equal(listed.permissionPreset, 'none', 'the default answers for a conversation with no session on record')
    assert.equal(listed.capabilities?.images, true, 'and what its provider can do, with no session in memory')
    assert.deepEqual(f.defaults.at(-1), { workspaceId: 'workspace', agentId: 'agent' })
    const start = vi.spyOn(f.runtime, 'startSession')
    assert.equal((await f.host.command(f.key, 'phone', 'send', { kind: 'send', message: '/tools' })).ok, true)
    assert.equal(start.mock.calls[0][0].permissionPreset, 'none')
  } finally {
    await f.cleanup()
  }
})

test('with no default injected, a conversation with no session on record resumes on bypass', async () => {
  const first = await fixture()
  const started = await first.start()
  assert.ok(started.ok)
  await first.runtime.sendTurn({ sessionId: started.session.sessionId, message: '/tools' })
  await first.cleanup(true)
  const f = await fixture({ workspaceRoot: first.key.workspaceRoot })
  try {
    assert.equal((await f.host.list())[0].permissionPreset, 'bypass')
  } finally {
    await f.cleanup()
  }
})

test('a failed resume is answered with its own refusal and never retried', async () => {
  const f = await fixture()
  try {
    const started = await f.start()
    assert.ok(started.ok)
    await f.runtime.sendTurn({ sessionId: started.session.sessionId, message: '/tools' })
    await f.runtime.stopSession({ sessionId: started.session.sessionId })
    const start = vi.spyOn(f.runtime, 'startSession').mockResolvedValue({ ok: false, message: 'Provider unavailable.' })
    assert.deepEqual(await f.host.command(f.key, 'phone', 'send', { kind: 'send', message: 'hello' }), {
      ok: false,
      message: 'Provider unavailable.',
    })
    assert.equal(start.mock.calls.length, 1)
    assert.equal(start.mock.calls[0][0].permissionPreset, 'bypass')
  } finally {
    await f.cleanup()
  }
})

test('upload references are device/session bound, bounded and invalidated by size changes', async () => {
  const f = await fixture()
  try {
    assert.equal(CONVERSATION_MAX_IMAGES, MAX_ATTACHMENTS_PER_TURN)
    const started = await f.start()
    assert.ok(started.ok)
    const sessionId = started.session.sessionId
    const path = join(f.key.workspaceRoot, 'image.png')
    await writeFile(path, 'image')
    const upload = { deviceId: 'phone', sessionId, path, name: 'image.png', mediaType: 'image/png', bytes: 5 }
    const id = f.host.registerUpload!(upload)
    const send = vi.spyOn(f.runtime, 'sendTurn').mockResolvedValue({ ok: true, session: started.session })
    assert.equal(
      (await f.host.command(f.key, 'other-phone', 'wrong-device', { kind: 'send', message: '', uploadIds: [id] })).ok,
      false,
    )
    const otherSession = f.host.registerUpload!({ ...upload, sessionId: 'other-session' })
    assert.equal(
      (await f.host.command(f.key, 'phone', 'wrong-session', { kind: 'send', message: '', uploadIds: [otherSession] }))
        .ok,
      false,
    )
    assert.equal(send.mock.calls.length, 0)
    assert.equal(
      (await f.host.command(f.key, 'phone', 'valid', { kind: 'send', message: '', uploadIds: [id] })).ok,
      true,
    )
    assert.equal(send.mock.calls[0][0].attachments?.[0].dataBase64, Buffer.from('image').toString('base64'))
    await writeFile(path, 'larger image')
    assert.equal(
      (await f.host.command(f.key, 'phone', 'changed', { kind: 'send', message: '', uploadIds: [id] })).ok,
      false,
    )
    for (let index = 0; index < 32; index++) f.host.registerUpload!(upload)
    assert.equal(
      (await f.host.command(f.key, 'phone', 'evicted', { kind: 'send', message: '', uploadIds: [id] })).ok,
      false,
    )
    assert.equal(send.mock.calls.length, 1)
  } finally {
    await f.cleanup()
  }
})

test('a listed row carries whole-number times and counts, whatever its transcript gave', async () => {
  const f = await fixture()
  try {
    vi.spyOn(f.runtime, 'listThreads').mockResolvedValue({
      ok: true,
      threads: [
        {
          agentId: 'agent',
          title: 'Unreadable',
          providerId: 'mock',
          model: 'default',
          updatedAt: 1_700_000_000_123.456,
          createdAt: Number.NaN,
          turnCount: 2.5,
          lastSeq: -1,
        },
      ],
    } as never)
    const [row] = await f.host.list()
    assert.equal(row.updatedAt, 1_700_000_000_123)
    assert.equal(row.createdAt, 1_700_000_000_123)
    assert.equal(row.turnCount, 3)
    assert.equal(row.lastSeq, 0)
  } finally {
    await f.cleanup()
  }
})

test('a send behind another send to the same chat is busy, with a delay to retry after', async () => {
  const f = await fixture()
  try {
    const started = await f.start()
    assert.ok(started.ok)
    let release: () => void = () => undefined
    vi.spyOn(f.runtime, 'sendTurn').mockImplementation(
      () =>
        new Promise((resolve) => {
          release = () => resolve({ ok: true, session: started.session })
        }),
    )
    const first = f.host.command(f.key, 'phone', 'first', { kind: 'send', message: 'one' })
    const second = await f.host.command(f.key, 'phone', 'second', { kind: 'send', message: 'two' })
    assert.equal(second.ok, false)
    assert.equal(second.code, 'busy')
    assert.ok((second.retryAfterMs ?? 0) > 0)
    release()
    assert.equal((await first).ok, true)
  } finally {
    await f.cleanup()
  }
})

test('a send the runtime turns away behind a running turn reaches the phone as busy, with its delay', async () => {
  const f = await fixture()
  try {
    const started = await f.start()
    assert.ok(started.ok)
    vi.spyOn(f.runtime, 'sendTurn').mockResolvedValue({
      ok: false,
      code: 'busy',
      retryAfterMs: 1_000,
      message: 'Conversation turn is already in progress.',
    })
    const sent = await f.host.command(f.key, 'phone', 'during-a-turn', { kind: 'send', message: 'two' })
    assert.equal(sent.ok, false)
    assert.equal(sent.code, 'busy')
    assert.equal(sent.retryAfterMs, 1_000)
  } finally {
    await f.cleanup()
  }
})

/** Held messages kept in memory, with each chat's list set by the test. */
function memoryHeld() {
  const listeners = new Set<() => void>()
  const lists = new Map<string, ConversationQueuedMessage[]>()
  const holds: Array<{ chat: { workspaceId: string; agentId: string }; text: string; source: string }> = []
  const cancels: string[] = []
  const chatOf = (chat: { workspaceId: string; agentId: string }) => `${chat.workspaceId}/${chat.agentId}`
  const held: ConversationHeldMessages = {
    hold: (chat, text, source) => {
      holds.push({ chat: { workspaceId: chat.workspaceId, agentId: chat.agentId }, text, source })
      return { ok: true }
    },
    cancel: (_chat, id) => {
      cancels.push(id)
      return id === 'sm-1' ? { ok: true } : { ok: false, message: 'That message is already on its way into the chat.' }
    },
    list: (chat) => lists.get(chatOf(chat)) ?? [],
    onChanged: (listener) => {
      listeners.add(listener)
      return () => listeners.delete(listener)
    },
  }
  return {
    held,
    holds,
    cancels,
    listeners,
    set(chat: { workspaceId: string; agentId: string }, messages: ConversationQueuedMessage[]) {
      lists.set(chatOf(chat), messages)
      for (const listener of [...listeners]) listener()
    },
  }
}

test('a queued send is held for the turn and answered at once: no session is resumed and nothing is sent now', async () => {
  const memory = memoryHeld()
  const f = await fixture({ heldMessages: memory.held })
  try {
    const start = vi.spyOn(f.runtime, 'startSession')
    const send = vi.spyOn(f.runtime, 'sendTurn')
    const answer = await f.host.command(f.key, 'laptop', 'queued-1', {
      kind: 'send',
      message: 'Then the docs.',
      queue: true,
    })
    assert.deepEqual(answer, { ok: true })
    assert.deepEqual(memory.holds, [
      {
        chat: { workspaceId: 'workspace', agentId: 'agent' },
        text: 'Then the docs.',
        source: JSON.stringify(['laptop', 'queued-1']),
      },
    ])
    assert.equal(start.mock.calls.length, 0, 'no session started for a message that waits')
    assert.equal(send.mock.calls.length, 0, 'nothing sent into the running turn')
    // An ordinary send beside it is still the send it always was.
    const started = await f.start()
    assert.ok(started.ok)
    assert.equal((await f.host.command(f.key, 'laptop', 'now-1', { kind: 'send', message: '/tools' })).ok, true)
    assert.equal(memory.holds.length, 1)
  } finally {
    await f.cleanup()
  }
})

test('a send written long ago is refused stale, neither held nor sent, until the person confirms it', async () => {
  const memory = memoryHeld()
  const f = await fixture({ heldMessages: memory.held })
  try {
    const started = await f.start()
    assert.ok(started.ok)
    const composedAt = Date.now() - 23 * 3_600_000
    const held = await f.host.command(f.key, 'phone', 'held-1', {
      kind: 'send',
      message: 'Then the docs.',
      queue: true,
      composedAt,
    })
    assert.equal(held.ok, false)
    assert.equal(held.code, 'stale', 'the code reaches the device, for it to ask its person')
    assert.deepEqual(memory.holds, [], 'held messages go the moment the chat is free, so none is held')
    const sent = await f.host.command(f.key, 'phone', 'send-1', { kind: 'send', message: '/tools', composedAt })
    assert.equal(sent.ok, false)
    assert.equal(sent.code, 'stale')
    const transcript = await f.runtime.readTranscript(f.key)
    assert.ok(transcript.ok)
    assert.equal(transcript.events.filter((event) => event.type === 'user_message').length, 0)
    // Send now: the same id, confirmed, goes and says when it was written.
    const confirmed = await f.host.command(f.key, 'phone', 'send-1', {
      kind: 'send',
      message: '/tools',
      composedAt,
      confirmedStale: true,
    })
    assert.equal(confirmed.ok, true, confirmed.message ?? '')
    const after = await f.runtime.readTranscript(f.key)
    assert.ok(after.ok)
    const [message] = after.events.filter((event) => event.type === 'user_message')
    assert.equal(message?.payload?.composedAt, composedAt)
    assert.equal(message?.payload?.commandId, 'send-1')
  } finally {
    await f.cleanup()
  }
})

test('a host that holds nothing takes a queued send as an ordinary one, and refuses taking one back', async () => {
  const f = await fixture()
  try {
    const started = await f.start()
    assert.ok(started.ok)
    vi.spyOn(f.runtime, 'sendTurn').mockResolvedValue({
      ok: false,
      code: 'busy',
      retryAfterMs: 1_000,
      message: 'Conversation turn is already in progress.',
    })
    const sent = await f.host.command(f.key, 'laptop', 'queued-1', { kind: 'send', message: 'two', queue: true })
    assert.equal(sent.code, 'busy', 'refused busy behind the turn, as before the member')
    assert.equal(f.host.watchQueued, undefined)
    const cancel = await f.host.command(f.key, 'laptop', 'cancel-1', { kind: 'cancelQueued', queuedId: 'sm-1' })
    assert.equal(cancel.ok, false)
  } finally {
    await f.cleanup()
  }
})

test('a held message is taken back through the held messages, refused once it is on its way', async () => {
  const memory = memoryHeld()
  const f = await fixture({ heldMessages: memory.held })
  try {
    assert.deepEqual(await f.host.command(f.key, 'laptop', 'cancel-1', { kind: 'cancelQueued', queuedId: 'sm-1' }), {
      ok: true,
    })
    const late = await f.host.command(f.key, 'laptop', 'cancel-2', { kind: 'cancelQueued', queuedId: 'sm-2' })
    assert.equal(late.ok, false)
    assert.match(late.message ?? '', /on its way/)
    assert.deepEqual(memory.cancels, ['sm-1', 'sm-2'])
  } finally {
    await f.cleanup()
  }
})

test('a chat’s held messages are told now, and again only when its own list changes', async () => {
  const memory = memoryHeld()
  const f = await fixture({ heldMessages: memory.held })
  try {
    const told: ConversationQueuedMessage[][] = []
    const stop = f.host.watchQueued!({ workspaceId: 'workspace', agentId: 'agent' }, (messages) => told.push(messages))
    assert.deepEqual(told, [[]], 'told what is held at once, nothing included')
    const held = { id: 'sm-1', text: 'Then the docs.', createdAt: 1_700_000_000_000 }
    memory.set({ workspaceId: 'workspace', agentId: 'agent' }, [held])
    memory.set({ workspaceId: 'workspace', agentId: 'other' }, [{ ...held, id: 'sm-2' }])
    memory.set({ workspaceId: 'workspace', agentId: 'agent' }, [held])
    assert.deepEqual(told, [[], [held]], 'another chat’s change, or none, is not told')
    stop()
    assert.equal(memory.listeners.size, 0)
  } finally {
    await f.cleanup()
  }
})

test('an upload for a session that ended is sent on the session the send resumes the chat on', async () => {
  const f = await fixture()
  try {
    const started = await f.start()
    assert.ok(started.ok)
    const path = join(f.key.workspaceRoot, 'image.png')
    await writeFile(path, 'image')
    const id = f.host.registerUpload!({
      deviceId: 'phone',
      sessionId: started.session.sessionId,
      path,
      name: 'image.png',
      mediaType: 'image/png',
      bytes: 5,
    })
    // The session the phone uploaded against ends (a failed turn, a stop) before the send.
    await f.runtime.stopSession({ sessionId: started.session.sessionId })
    const send = vi.spyOn(f.runtime, 'sendTurn')
    const result = await f.host.command(f.key, 'phone', 'after-end', { kind: 'send', message: '', uploadIds: [id] })
    assert.equal(result.ok, true)
    assert.notEqual(send.mock.calls[0][0].sessionId, started.session.sessionId)
    assert.equal(send.mock.calls[0][0].attachments?.length, 1)
  } finally {
    await f.cleanup()
  }
})

test('an accepted send removes its staged images, and a retry of that send does not need them', async () => {
  const f = await fixture()
  try {
    const started = await f.start()
    assert.ok(started.ok)
    const path = join(f.key.workspaceRoot, 'staged.png')
    await writeFile(path, 'image')
    const id = f.host.registerUpload!({
      deviceId: 'phone',
      sessionId: started.session.sessionId,
      path,
      name: 'staged.png',
      mediaType: 'image/png',
      bytes: 5,
      dispose: () => void rm(path, { force: true }),
    })
    const send = vi
      .spyOn(f.runtime, 'sendTurn')
      .mockResolvedValueOnce({ ok: false, message: 'Busy.' })
      .mockResolvedValue({ ok: true, session: started.session })
    const command = { kind: 'send' as const, message: 'look', uploadIds: [id] }
    assert.equal((await f.host.command(f.key, 'phone', 'refused', command)).ok, false)
    assert.equal(existsSync(path), true, 'a refused send keeps its images for a retry')
    assert.equal((await f.host.command(f.key, 'phone', 'accepted', command)).ok, true)
    await new Promise((resolve) => setTimeout(resolve, 10))
    assert.equal(existsSync(path), false, 'an accepted send leaves no staged image behind')
    // The acknowledgement was lost: the same command again is answered, not refused for a missing image.
    assert.equal((await f.host.command(f.key, 'phone', 'accepted', command)).ok, true)
    assert.equal(send.mock.calls.at(-1)![0].commandId, 'accepted')
    assert.equal((await f.host.command(f.key, 'phone', 'another', command)).ok, false, 'a spent image is not reusable')
  } finally {
    await f.cleanup()
  }
})

test('bounded image reads refuse symlinks, directories and oversized input', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'conversation-upload-'))
  try {
    const path = join(directory, 'image.png'),
      link = join(directory, 'link.png')
    await writeFile(path, 'image')
    await symlink(path, link)
    assert.equal((await readBoundedConversationUpload(path, 5)).toString(), 'image')
    await assert.rejects(readBoundedConversationUpload(link, 5))
    await assert.rejects(readBoundedConversationUpload(directory, 5))
    await assert.rejects(readBoundedConversationUpload(path, MAX_ATTACHMENT_BYTES + 1))
    await assert.rejects(readBoundedConversationUpload(path, 4))
  } finally {
    await rm(directory, { recursive: true, force: true })
  }
})

test('send preparation coalesces retries, refuses parallel turns and leaves interrupts available', async () => {
  const f = await fixture()
  try {
    const started = await f.start()
    assert.ok(started.ok)
    let complete!: () => void
    const send = vi.spyOn(f.runtime, 'sendTurn').mockImplementation(async () => {
      await new Promise<void>((resolve) => {
        complete = resolve
      })
      return { ok: true, session: started.session }
    })
    const interrupt = vi.spyOn(f.runtime, 'interrupt').mockResolvedValue({ ok: true, session: started.session })
    const first = f.host.command(f.key, 'phone', 'stable-id', { kind: 'send', message: 'hello' })
    const retry = f.host.command(f.key, 'phone', 'stable-id', { kind: 'send', message: 'hello' })
    assert.equal(first, retry)
    assert.equal((await f.host.command(f.key, 'phone', 'another-id', { kind: 'send', message: 'other' })).ok, false)
    assert.equal((await f.host.command(f.key, 'phone', 'interrupt', { kind: 'interrupt' })).ok, true)
    assert.equal(send.mock.calls.length, 1)
    assert.equal(interrupt.mock.calls.length, 1)
    complete()
    assert.equal((await first).ok, true)
  } finally {
    await f.cleanup()
  }
})

test('a remote send reaches a chat in bypass, as a send from this machine does', async () => {
  const f = await fixture({ preset: 'bypass' })
  try {
    const started = await f.start()
    assert.ok(started.ok)
    const result = await f.host.command(f.key, 'phone', 'send-bypass', { kind: 'send', message: 'hello' })
    assert.equal(result.ok, true, result.message ?? '')
    const transcript = await f.runtime.readTranscript(f.key)
    assert.ok(transcript.ok)
    assert.equal(
      transcript.events.some((entry) => entry.type === 'user_message'),
      true,
    )
  } finally {
    await f.cleanup()
  }
})

test('the list names the live preset of each conversation, and a remote switch moves it both ways', async () => {
  const f = await fixture({ preset: 'bypass' })
  try {
    const started = await f.start()
    assert.ok(started.ok)
    assert.equal((await f.host.list())[0].permissionPreset, 'bypass')
    for (const preset of ['none', 'bypass'] as const) {
      const switched = await f.host.command(f.key, 'phone', `to-${preset}`, { kind: 'setPermissionPreset', preset })
      assert.equal(switched.ok, true, switched.message ?? '')
      assert.equal((await f.host.list())[0].permissionPreset, preset)
    }
  } finally {
    await f.cleanup()
  }
})

test('a remote switch carries the CLI’s own mode, the list names it, and a preset name posing as a mode is dropped', async () => {
  const f = await fixture({ preset: 'bypass' })
  try {
    const started = await f.start()
    assert.ok(started.ok)
    const setPermission = vi.spyOn(f.runtime, 'setPermission')
    const switched = await f.host.command(f.key, 'phone', 'to-accept-edits', {
      kind: 'setPermissionPreset',
      preset: 'auto',
      permissionMode: 'acceptEdits',
    })
    assert.equal(switched.ok, true, switched.message ?? '')
    const listed = (await f.host.list())[0]
    assert.equal(listed.permissionPreset, 'auto')
    assert.equal(listed.permissionMode, 'acceptEdits')
    await f.host.command(f.key, 'phone', 'to-manual', {
      kind: 'setPermissionPreset',
      preset: 'manual',
      permissionMode: 'none',
    })
    assert.equal(setPermission.mock.calls.at(-1)?.[0].permissionMode, undefined)
    assert.equal((await f.host.list())[0].permissionMode, undefined)
    // Each switch is written to the chat's record too, so it outlives the
    // session: a remount or a restart starts on it, not on the old one.
    assert.deepEqual(f.written, [
      { cliPermissionPreset: 'auto', cliPermissionMode: 'acceptEdits' },
      { cliPermissionPreset: 'manual', cliPermissionMode: undefined },
    ])
  } finally {
    await f.cleanup()
  }
})

test('a remote plan answer reaches the runtime as a plan answer, approve or reject', async () => {
  const f = await fixture({ preset: 'none' })
  try {
    const started = await f.start()
    assert.ok(started.ok)
    const respond = vi.spyOn(f.runtime, 'respondToRequest').mockResolvedValue({ ok: true, session: started.session })
    for (const decision of ['approve', 'reject'] as const)
      await f.host.command(f.key, 'phone', `plan-${decision}`, { kind: 'resolvePlan', requestId: 'req-1', decision })
    assert.deepEqual(
      respond.mock.calls.map(([input]) => [input.commandId, input.requestId, input.approved, input.requestKind]),
      [
        ['plan-approve', 'req-1', true, 'plan'],
        ['plan-reject', 'req-1', false, 'plan'],
      ],
    )
  } finally {
    await f.cleanup()
  }
})

test('a remote preset switch on a conversation with no live session resumes it on the new preset', async () => {
  const f = await fixture({ preset: 'bypass' })
  try {
    const started = await f.start()
    assert.ok(started.ok)
    await f.runtime.sendTurn({ sessionId: started.session.sessionId, message: '/tools' })
    await f.runtime.stopSession({ sessionId: started.session.sessionId })
    const switched = await f.host.command(f.key, 'phone', 'switch', { kind: 'setPermissionPreset', preset: 'none' })
    assert.equal(switched.ok, true, switched.message ?? '')
    const live = (await f.host.list())[0]
    assert.ok(live.sessionId, 'the switch resumed a session')
    assert.equal(live.permissionPreset, 'none')
  } finally {
    await f.cleanup()
  }
})

test('a remote lists a conversation by its agent’s name, falling back to the thread title only without one', async () => {
  for (const [agentName, expected] of [
    ['Fionn', 'Fionn'],
    [null, undefined],
    ['Agent 2', undefined],
  ] as const) {
    const f = await fixture({ agentName })
    try {
      const started = await f.start()
      assert.ok(started.ok)
      await f.runtime.sendTurn({ sessionId: started.session.sessionId, message: 'Check the upload test' })
      const listed = (await f.host.list())[0]
      if (expected) assert.equal(listed.title, expected, 'the name this desktop’s tab shows')
      else assert.notEqual(listed.title, agentName, 'no name, or a slot placeholder, falls back to the thread title')
    } finally {
      await f.cleanup()
    }
  }
})

// A provider that takes a new model mid-conversation, as the CLI chat providers
// do. `switched` records what reached it; `notice` is what it says back.
function liveModelProvider(notice?: string) {
  const switched: string[] = []
  const adapter: ConversationProviderAdapter = {
    ...createMockConversationProvider({ liveModelSwitch: true }),
    listModels: () => ['mock-model', 'mock-large'],
    setModel: async (input) => {
      switched.push(input.nextModelId)
      return { ok: true, ...(notice ? { notice } : {}) }
    },
  }
  return { adapter, switched }
}

const mockCatalog = async (providerId: string): Promise<ConversationModelCatalog | null> =>
  providerId === 'mock-provider'
    ? {
        cli: 'mock-cli',
        cliLabel: 'Mock CLI',
        options: [
          { id: 'mock-model', label: 'Mock' },
          { id: 'mock-large', label: 'Mock Large' },
        ],
      }
    : null

test("the list names each chat's CLI catalog and whether its provider switches models mid-conversation", async () => {
  const { adapter } = liveModelProvider()
  const f = await fixture({ adapter, modelCatalog: mockCatalog })
  try {
    const started = await f.start()
    assert.ok(started.ok)
    assert.deepEqual((await f.host.list())[0].models, {
      cli: 'mock-cli',
      cliLabel: 'Mock CLI',
      liveModelSwitch: true,
      options: [
        { id: 'mock-model', label: 'Mock' },
        { id: 'mock-large', label: 'Mock Large' },
      ],
    })
    // A stopped chat still names its catalog: the provider's own declaration
    // answers for the session a switch would resume.
    await f.runtime.sendTurn({ sessionId: started.session.sessionId, message: '/tools' })
    await f.runtime.stopSession({ sessionId: started.session.sessionId })
    assert.equal((await f.host.list())[0].models?.liveModelSwitch, true)
  } finally {
    await f.cleanup()
  }
  // A provider with no catalog (not a CLI) lists none.
  const plain = await fixture({ modelCatalog: async () => null })
  try {
    assert.ok((await plain.start()).ok)
    assert.equal('models' in (await plain.host.list())[0], false)
  } finally {
    await plain.cleanup()
  }
})

test('a remote model switch runs through the runtime, and the list and transcript name the new model', async () => {
  const notice = 'The new model starts with your next message.'
  const { adapter, switched } = liveModelProvider(notice)
  const f = await fixture({ adapter, modelCatalog: mockCatalog })
  try {
    const started = await f.start()
    assert.ok(started.ok)
    const result = await f.host.command(f.key, 'phone', 'model-1', { kind: 'setModel', modelId: 'mock-large' })
    assert.deepEqual(result, { ok: true, notice })
    assert.deepEqual(switched, ['mock-large'])
    const listed = (await f.host.list())[0]
    assert.equal(listed.modelId, 'mock-large')
    assert.equal(listed.providerId, 'mock-provider', 'the CLI never changes')
    assert.deepEqual(f.written, [{ conversation: { providerId: 'mock-provider', modelId: 'mock-large' } }])
    const transcript = await f.runtime.readTranscript(f.key)
    assert.ok(transcript.ok)
    assert.equal(transcript.events.at(-1)?.type, 'session_updated')
    // The same command id again is the same switch, not a second one.
    assert.deepEqual(await f.host.command(f.key, 'phone', 'model-1', { kind: 'setModel', modelId: 'mock-large' }), {
      ok: true,
      notice,
    })
    assert.deepEqual(switched, ['mock-large'])
    // The CLI's own default is always on offer.
    assert.equal((await f.host.command(f.key, 'phone', 'model-2', { kind: 'setModel', modelId: 'default' })).ok, true)
    assert.deepEqual(switched, ['mock-large', 'default'])
  } finally {
    await f.cleanup()
  }
})

test("a remote model switch outside the chat's CLI catalog is refused before the runtime sees it", async () => {
  const { adapter, switched } = liveModelProvider()
  const f = await fixture({ adapter, modelCatalog: mockCatalog })
  try {
    const started = await f.start()
    assert.ok(started.ok)
    const setModel = vi.spyOn(f.runtime, 'setModel')
    for (const modelId of ['other-cli-model', 'gpt-large', 'Mock'])
      assert.deepEqual(await f.host.command(f.key, 'phone', `m-${modelId}`, { kind: 'setModel', modelId }), {
        ok: false,
        code: 'unsupported_model',
        message: 'Mock CLI does not offer that model.',
      })
    assert.equal(setModel.mock.calls.length, 0)
    assert.deepEqual(switched, [])
    assert.equal((await f.host.list())[0].modelId, 'mock-model')
  } finally {
    await f.cleanup()
  }
  // A chat with no catalog at all offers nothing to switch to.
  const bare = await fixture({ adapter: liveModelProvider().adapter })
  try {
    assert.ok((await bare.start()).ok)
    const refused = await bare.host.command(bare.key, 'phone', 'm', { kind: 'setModel', modelId: 'mock-large' })
    assert.equal(refused.ok, false)
    assert.equal(refused.code, 'unsupported_model')
  } finally {
    await bare.cleanup()
  }
})

test('a provider that binds a session to its model refuses a remote switch without resuming anything', async () => {
  const f = await fixture({ modelCatalog: mockCatalog })
  try {
    const started = await f.start()
    assert.ok(started.ok)
    await f.runtime.sendTurn({ sessionId: started.session.sessionId, message: '/tools' })
    await f.runtime.stopSession({ sessionId: started.session.sessionId })
    assert.equal((await f.host.list())[0].models?.liveModelSwitch, false)
    const start = vi.spyOn(f.runtime, 'startSession')
    assert.deepEqual(await f.host.command(f.key, 'phone', 'm', { kind: 'setModel', modelId: 'mock-large' }), {
      ok: false,
      message: 'This conversation provider cannot change models mid-conversation.',
    })
    assert.equal(start.mock.calls.length, 0)
  } finally {
    await f.cleanup()
  }
})

test('a remote model switch on a chat with no live session resumes it and switches that session', async () => {
  const { adapter, switched } = liveModelProvider()
  const f = await fixture({ adapter, modelCatalog: mockCatalog })
  try {
    const started = await f.start()
    assert.ok(started.ok)
    await f.runtime.sendTurn({ sessionId: started.session.sessionId, message: '/tools' })
    await f.runtime.stopSession({ sessionId: started.session.sessionId })
    const result = await f.host.command(f.key, 'phone', 'm', { kind: 'setModel', modelId: 'mock-large' })
    assert.equal(result.ok, true, result.message ?? '')
    assert.deepEqual(switched, ['mock-large'])
    const live = (await f.host.list())[0]
    assert.ok(live.sessionId, 'the switch resumed a session')
    assert.equal(live.modelId, 'mock-large')
  } finally {
    await f.cleanup()
  }
})
