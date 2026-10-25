import assert from 'node:assert/strict'
import { existsSync, readdirSync } from 'node:fs'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { test, vi } from 'vitest'

import {
  createStudioScheduledMessages,
  HELD_MESSAGE_PICTURES_DIRNAME,
  studioHeldMessages,
} from '../../../server/core/studio-scheduled-messages'
import { ConversationRuntime } from '../../conversation-runtime'
import { createMockConversationProvider } from '../../providers/mock-conversation-provider'
import type { ScheduledMessages } from '../../scheduled-messages/scheduled-messages'
import { createConversationGatewayHost } from './tailnet-conversation-host'
import { TAILNET_UPLOADS_DIRNAME } from './tailnet-file-uploads'

// A message a paired machine queued mid-turn carrying pictures, files, skills
// and mentions (`conversation-queued-attachments`): held here whole, its
// picture copied to this disk and its file kept where its upload put it, so
// the machine that queued it may close; sent with all of it when it goes, and
// what was kept for it let go once it has gone.

async function fixture() {
  const workspaceRoot = await mkdtemp(join(tmpdir(), 'queued-attachments-workspace-'))
  const dataDir = await mkdtemp(join(tmpdir(), 'queued-attachments-data-'))
  const key = { workspaceRoot, workspaceId: 'workspace', agentId: 'agent' }
  const adapter = createMockConversationProvider()
  const runtime = new ConversationRuntime({ adapters: [adapter], getProviderById: () => undefined })
  let scheduled: ScheduledMessages | null = null
  const host = createConversationGatewayHost(
    runtime,
    (id) => (id === key.workspaceId ? workspaceRoot : null),
    () => [{ workspaceRoot, workspaceId: key.workspaceId }],
    () => 'bypass',
    () => null,
    async () => null,
    {},
    { heldMessages: studioHeldMessages(() => scheduled!, dataDir) },
  )
  scheduled = createStudioScheduledMessages({
    dataDir,
    conversations: {
      listSessions: () => runtime.listSessions(),
      onEvent: (listener) => runtime.onEvent(listener),
    },
    workspaceRecord: (workspaceId) => (workspaceId === key.workspaceId ? { agents: { agent: {} } } : null),
    createHost: () => host,
    storage: { read: async () => null, write: async () => undefined },
  })
  await scheduled.start()
  const started = await runtime.startSession({
    ...key,
    providerId: adapter.id,
    modelId: adapter.listModels()[0]!,
    permissionPreset: 'bypass',
  })
  assert.ok(started.ok)
  const sessionId = started.session.sessionId
  // As the upload route stages them: a picture in a staging folder, gone with
  // its reference, and a file in Studio's store of a device's files.
  const upload = async (index: number) => {
    const picture = join(dataDir, 'staging', `picture-${index}`)
    await mkdir(dirname(picture), { recursive: true })
    await writeFile(picture, 'png-bytes')
    const file = join(dataDir, TAILNET_UPLOADS_DIRNAME, 'device', `upload-${index}`, 'notes.txt')
    await mkdir(dirname(file), { recursive: true })
    await writeFile(file, 'the notes')
    const pictureId = host.registerUpload!({
      deviceId: 'laptop',
      sessionId,
      path: picture,
      name: 'screenshot.png',
      mediaType: 'image/png',
      bytes: 9,
      dispose: () => void rm(picture, { force: true }),
    })
    const fileId = host.registerUpload!({
      deviceId: 'laptop',
      sessionId,
      path: file,
      name: 'notes.txt',
      mediaType: 'text/plain',
      bytes: 9,
      kind: 'file',
      dispose: () => void rm(dirname(file), { recursive: true, force: true }),
    })
    return { picture, file, ids: [pictureId, fileId] }
  }
  return {
    key,
    host,
    runtime,
    dataDir,
    scheduled,
    upload,
    pictures: () => {
      const root = join(dataDir, HELD_MESSAGE_PICTURES_DIRNAME)
      return existsSync(root) ? readdirSync(root) : []
    },
    cleanup: async () => {
      await scheduled.dispose()
      await runtime.shutdown()
      await rm(workspaceRoot, { recursive: true, force: true })
      await rm(dataDir, { recursive: true, force: true })
    },
  }
}

const settle = () => new Promise((resolve) => setTimeout(resolve, 20))

test('a queued message is held whole, says what it carries, and goes with all of it', async () => {
  const f = await fixture()
  try {
    const { picture, file, ids } = await f.upload(1)
    const command = {
      kind: 'send' as const,
      message: 'Look at these.',
      queue: true as const,
      uploadIds: ids,
      skills: ['review'],
      mentions: [{ path: 'docs/notes.md', kind: 'file' as const }],
    }
    assert.deepEqual(await f.host.command(f.key, 'laptop', 'queued-1', command), { ok: true })
    await settle()
    // Held here: the picture copied, its staged copy gone; the file where it was.
    assert.equal(existsSync(picture), false, 'the staged picture goes with its reference')
    assert.equal(f.pictures().length, 1)
    assert.equal(existsSync(file), true)
    assert.deepEqual(f.host.watchQueued ? await new Promise((resolve) => f.host.watchQueued!(f.key, resolve)) : null, [
      {
        id: f.scheduled.state().messages[0]!.id,
        text: 'Look at these.',
        createdAt: f.scheduled.state().messages[0]!.createdAt,
        images: ['screenshot.png'],
        files: ['notes.txt'],
        skills: ['review'],
        mentions: [{ path: 'docs/notes.md', kind: 'file' }],
      },
    ])
    // The same command again, its uploads spent, is the same message.
    assert.deepEqual(await f.host.command(f.key, 'laptop', 'queued-1', command), { ok: true })
    assert.equal(f.scheduled.state().messages.length, 1)
    assert.equal(f.pictures().length, 1)

    const send = vi.spyOn(f.runtime, 'sendTurn').mockResolvedValue({ ok: true } as never)
    f.scheduled.update({ kind: 'send-now', id: f.scheduled.state().messages[0]!.id })
    await vi.waitFor(() => assert.equal(f.scheduled.state().messages.length, 0))
    const sent = send.mock.calls[0]![0]
    assert.equal(sent.message, 'Look at these.')
    assert.equal(sent.attachments?.length, 1)
    assert.equal(sent.attachments?.[0]?.name, 'screenshot.png')
    assert.equal(sent.attachments?.[0]?.dataBase64, Buffer.from('png-bytes').toString('base64'))
    assert.deepEqual(sent.files, [{ path: file }])
    assert.deepEqual(
      sent.skills?.map((skill) => skill.id),
      ['review'],
    )
    assert.deepEqual(sent.mentions, [{ path: 'docs/notes.md', kind: 'file' }])
    await settle()
    // Gone: the picture's copy with it; the file is the message's now.
    assert.equal(f.pictures().length, 0)
    assert.equal(existsSync(file), true)
    assert.equal(existsSync(join(dirname(file), '.held')), false)
  } finally {
    await f.cleanup()
  }
})

test('a held message taken back lets go of its picture and its file', async () => {
  const f = await fixture()
  try {
    const { file, ids } = await f.upload(2)
    const held = await f.host.command(f.key, 'laptop', 'queued-2', {
      kind: 'send',
      message: '',
      queue: true,
      uploadIds: ids,
    })
    assert.deepEqual(held, { ok: true }, 'pictures and files are a message without words')
    assert.equal(existsSync(join(dirname(file), '.held')), true, 'the week’s pruning passes it by')
    const [message] = f.scheduled.state().messages
    assert.deepEqual(
      await f.host.command(f.key, 'laptop', 'cancel-2', { kind: 'cancelQueued', queuedId: message!.id }),
      {
        ok: true,
      },
    )
    await settle()
    assert.equal(f.pictures().length, 0)
    assert.equal(existsSync(file), false)
  } finally {
    await f.cleanup()
  }
})

test('an upload that is not this device’s is refused, and nothing is held', async () => {
  const f = await fixture()
  try {
    const { ids } = await f.upload(3)
    const refused = await f.host.command(f.key, 'phone', 'queued-3', {
      kind: 'send',
      message: 'Mine?',
      queue: true,
      uploadIds: ids,
    })
    assert.equal(refused.ok, false)
    assert.equal(f.scheduled.state().messages.length, 0)
    assert.equal(f.pictures().length, 0)
  } finally {
    await f.cleanup()
  }
})
