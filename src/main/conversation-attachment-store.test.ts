import assert from 'node:assert/strict'
import { mkdir, mkdtemp, readFile, readdir, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'vitest'
import { ConversationAttachmentStore } from './conversation-attachment-store'
import { ConversationRuntime } from './conversation-runtime'
import { createMockConversationProvider } from './providers/mock-conversation-provider'
import type { ConversationStoredImageAttachment } from '../shared/conversation-runtime'

const PNG = Buffer.from('89504e470d0a1a0a0000000d49484452', 'hex').toString('base64')
const key = { workspaceRoot: '/Users/dev/app', workspaceId: 'workspace', agentId: 'agent' }

test('an image is kept under its conversation and read back only by its own reference', async () => {
  const userData = await mkdtemp(join(tmpdir(), 'conversation-attachment-store-'))
  try {
    const store = new ConversationAttachmentStore(userData)
    const [stored, ...rest] = await store.save(key, [
      { id: 'img-1', mediaType: 'image/png', dataBase64: PNG, name: 'Screenshot.png', byteLength: 16 },
      // Outside the attachable set: never written, never referenced.
      { id: 'img-2', mediaType: 'image/svg+xml', dataBase64: PNG, byteLength: 16 },
    ])
    assert.equal(rest.length, 0)
    assert.equal(stored.id, 'img-1')
    assert.equal(stored.name, 'Screenshot.png')
    assert.equal(stored.byteLength, 16)
    assert.match(stored.ref, /^[0-9a-f]{32}\/[0-9a-f-]{36}\.png$/)
    assert.equal(stored.ref.split('/')[0], ConversationAttachmentStore.folderFor(key))
    assert.deepEqual(await store.read(stored.ref), { ok: true, mediaType: 'image/png', dataBase64: PNG })

    // A reference is a name this store chose, never a path the caller picks.
    for (const ref of [
      '../secret.png',
      `${stored.ref.split('/')[0]}/../../escape.png`,
      '/etc/hosts',
      `${stored.ref}.txt`,
      stored.ref.replace('.png', '.svg'),
      42,
    ])
      assert.equal((await store.read(ref)).ok, false, `refused: ${String(ref)}`)

    // A link planted where a file would be is not followed.
    const planted = `${stored.ref.split('/')[0]}/00000000-0000-0000-0000-000000000000.png`
    await writeFile(join(userData, 'outside.png'), 'outside')
    await symlink(join(userData, 'outside.png'), join(userData, 'conversation-attachments', planted))
    assert.equal((await store.read(planted)).ok, false)

    // Another conversation's folder survives this one's deletion.
    const [other] = await store.save({ ...key, agentId: 'other' }, [
      { id: 'img-3', mediaType: 'image/png', dataBase64: PNG, byteLength: 16 },
    ])
    await store.deleteConversation(key)
    assert.deepEqual(await store.read(stored.ref), {
      ok: false,
      message: 'That attachment is no longer on this machine.',
    })
    assert.equal((await store.read(other.ref)).ok, true)
  } finally {
    await rm(userData, { recursive: true, force: true })
  }
})

test('without an app-data directory nothing is kept', async () => {
  const store = new ConversationAttachmentStore()
  assert.deepEqual(await store.save(key, [{ id: 'a', mediaType: 'image/png', dataBase64: PNG, byteLength: 16 }]), [])
  assert.equal((await store.read('0'.repeat(32) + '/00000000-0000-0000-0000-000000000000.png')).ok, false)
})

test('a sent image is recorded by reference, replays after a restart, and goes with the conversation', async () => {
  const workspaceRoot = await mkdtemp(join(tmpdir(), 'conversation-attachment-runtime-'))
  const userData = await mkdtemp(join(tmpdir(), 'conversation-attachment-userdata-'))
  const conversation = { workspaceRoot, workspaceId: 'workspace', agentId: 'agent' }
  const create = () =>
    new ConversationRuntime({
      adapters: [createMockConversationProvider()],
      getProviderById: () => undefined,
      attachmentStore: new ConversationAttachmentStore(userData),
    })
  let runtime = create()
  try {
    const started = await runtime.startSession({ ...conversation, providerId: 'mock-provider', modelId: 'mock-model' })
    assert.ok(started.ok)
    const sent = await runtime.sendTurn({
      sessionId: started.session.sessionId,
      message: 'what is this?',
      attachments: [{ id: 'img-1', mediaType: 'image/png', dataBase64: PNG, name: 'cat.png', byteLength: 16 }],
    })
    assert.equal(sent.ok, true)
    await runtime.shutdown()

    runtime = create()
    const transcript = await runtime.readTranscript(conversation)
    assert.ok(transcript.ok)
    assert.equal(JSON.stringify(transcript.events).includes(PNG), false, 'the bytes stay out of the transcript')
    const recorded = transcript.events.find((event) => event.type === 'user_message')?.payload
      ?.attachments as ConversationStoredImageAttachment[]
    assert.equal(recorded.length, 1)
    assert.equal(recorded[0].name, 'cat.png')
    assert.deepEqual(await runtime.readAttachment(recorded[0].ref), {
      ok: true,
      mediaType: 'image/png',
      dataBase64: PNG,
    })

    assert.equal((await runtime.deleteTranscript(conversation)).ok, true)
    assert.equal((await runtime.readAttachment(recorded[0].ref)).ok, false)
    const folders = await readdir(join(userData, 'conversation-attachments')).catch(() => [])
    assert.deepEqual(folders, [])
  } finally {
    await runtime.shutdown()
    await rm(workspaceRoot, { recursive: true, force: true })
    await rm(userData, { recursive: true, force: true })
  }
})

test('an attachment store that cannot write leaves the turn to go ahead without references', async () => {
  const workspaceRoot = await mkdtemp(join(tmpdir(), 'conversation-attachment-unwritable-'))
  const userData = await mkdtemp(join(tmpdir(), 'conversation-attachment-blocked-'))
  // A file where the store's directory would go: every write fails.
  await writeFile(join(userData, 'conversation-attachments'), 'not a directory')
  const runtime = new ConversationRuntime({
    adapters: [createMockConversationProvider()],
    getProviderById: () => undefined,
    attachmentStore: new ConversationAttachmentStore(userData),
  })
  const conversation = { workspaceRoot, workspaceId: 'workspace', agentId: 'agent' }
  try {
    const started = await runtime.startSession({ ...conversation, providerId: 'mock-provider', modelId: 'mock-model' })
    assert.ok(started.ok)
    const sent = await runtime.sendTurn({
      sessionId: started.session.sessionId,
      message: 'look',
      attachments: [{ id: 'img-1', mediaType: 'image/png', dataBase64: PNG, byteLength: 16 }],
    })
    assert.equal(sent.ok, true)
    const transcript = await runtime.readTranscript(conversation)
    assert.ok(transcript.ok)
    const message = transcript.events.find((event) => event.type === 'user_message')
    assert.equal(message?.payload?.text, 'look')
    assert.equal(message?.payload?.attachments, undefined)
  } finally {
    await runtime.shutdown()
    await rm(workspaceRoot, { recursive: true, force: true })
    await rm(userData, { recursive: true, force: true })
  }
})

test('a fork keeps its own copies of the images its messages carried', async () => {
  const userData = await mkdtemp(join(tmpdir(), 'conversation-attachment-store-'))
  try {
    const store = new ConversationAttachmentStore(userData)
    const [stored] = await store.save(key, [{ id: 'img-1', mediaType: 'image/png', dataBase64: PNG, byteLength: 16 }])
    const fork = { ...key, agentId: 'fork' }
    const [copied, foreign] = (await store.copy(
      [stored, { id: 'x', ref: '../elsewhere.png' }],
      fork,
    )) as Array<ConversationStoredImageAttachment>
    assert.equal(copied.ref.split('/')[0], ConversationAttachmentStore.folderFor(fork))
    assert.equal(copied.id, 'img-1')
    // A reference this store did not write is passed on untouched, never followed.
    assert.equal(foreign.ref, '../elsewhere.png')
    await store.deleteConversation(key)
    assert.deepEqual(await store.read(copied.ref), { ok: true, mediaType: 'image/png', dataBase64: PNG })
  } finally {
    await rm(userData, { recursive: true, force: true })
  }
})

test('a fork whose image could not be kept never shares the source conversation’s folder', async () => {
  const userData = await mkdtemp(join(tmpdir(), 'conversation-attachment-store-'))
  try {
    const store = new ConversationAttachmentStore(userData)
    const [stored] = await store.save(key, [{ id: 'img-1', mediaType: 'image/png', dataBase64: PNG, byteLength: 16 }])
    const fork = { ...key, agentId: 'fork' }
    // Something already stands where the fork's copy would go, so neither a
    // copy nor a link can be made.
    const file = stored.ref.split('/')[1]!
    await mkdir(join(userData, 'conversation-attachments', ConversationAttachmentStore.folderFor(fork), file), {
      recursive: true,
    })
    const [copied] = (await store.copy([stored], fork)) as Array<ConversationStoredImageAttachment>
    assert.equal(copied.ref.split('/')[0], ConversationAttachmentStore.folderFor(fork))
    assert.notEqual(copied.ref, stored.ref)
    assert.equal((await store.read(copied.ref)).ok, false, 'the fork says it is gone')
    assert.equal((await store.read(stored.ref)).ok, true, 'the source keeps its own')
  } finally {
    await rm(userData, { recursive: true, force: true })
  }
})

test('the agent is told where an image is kept, inside the conversation’s own folder', async () => {
  const userData = await mkdtemp(join(tmpdir(), 'conversation-attachment-store-'))
  try {
    const store = new ConversationAttachmentStore(userData)
    const [stored] = await store.save(key, [{ id: 'img-1', mediaType: 'image/png', dataBase64: PNG, byteLength: 16 }])
    const path = store.pathFor(stored.ref)
    assert.ok(path)
    assert.ok(path.startsWith(`${store.directoryFor(key)!}/`) || path.startsWith(`${store.directoryFor(key)!}\\`))
    assert.equal((await readFile(path)).toString('base64'), PNG)
    assert.equal(store.pathFor('../elsewhere.png'), null, 'a reference this store did not write names no file')
    assert.equal(new ConversationAttachmentStore().pathFor(stored.ref), null)
  } finally {
    await rm(userData, { recursive: true, force: true })
  }
})

test('a sent image’s saved file is named to the agent, and its folder is one the agent may read', async () => {
  const workspaceRoot = await mkdtemp(join(tmpdir(), 'conversation-attachment-path-'))
  const userData = await mkdtemp(join(tmpdir(), 'conversation-attachment-path-data-'))
  const conversation = { workspaceRoot, workspaceId: 'workspace', agentId: 'agent' }
  const mock = createMockConversationProvider()
  const starts: Array<{ readableDirectories?: string[] }> = []
  const turns: Array<{ message: string }> = []
  const store = new ConversationAttachmentStore(userData)
  const runtime = new ConversationRuntime({
    adapters: [
      {
        ...mock,
        startSession: (input) => {
          starts.push(input)
          return mock.startSession(input)
        },
        sendTurn: (input) => {
          turns.push(input)
          return mock.sendTurn(input)
        },
      },
    ],
    getProviderById: () => undefined,
    attachmentStore: store,
  })
  try {
    const started = await runtime.startSession({ ...conversation, providerId: 'mock-provider', modelId: 'mock-model' })
    assert.ok(started.ok)
    assert.deepEqual(starts[0]?.readableDirectories, [store.directoryFor(conversation)])
    const sent = await runtime.sendTurn({
      sessionId: started.session.sessionId,
      message: 'put this on the pull request',
      attachments: [{ id: 'img-1', mediaType: 'image/png', dataBase64: PNG, name: 'cat.png', byteLength: 16 }],
    })
    assert.equal(sent.ok, true)
    const said = turns[0]?.message ?? ''
    const named = /Attached image "cat\.png" \(shown above\), saved at: (.+)$/m.exec(said)
    assert.ok(named, said)
    assert.ok(named[1]!.startsWith(store.directoryFor(conversation)!))
    assert.equal((await readFile(named[1]!)).toString('base64'), PNG, 'the bytes the agent was shown')
    const transcript = await runtime.readTranscript(conversation)
    assert.ok(transcript.ok)
    assert.equal(
      transcript.events.find((event) => event.type === 'user_message')?.payload?.text,
      'put this on the pull request',
      'the person’s words are kept as they wrote them',
    )
  } finally {
    await runtime.shutdown()
    await rm(workspaceRoot, { recursive: true, force: true })
    await rm(userData, { recursive: true, force: true })
  }
})
