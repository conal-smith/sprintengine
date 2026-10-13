import assert from 'node:assert/strict'
import { test } from 'vitest'

import { mkdir, mkdtemp, realpath, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import type { ConversationSendTurnInput } from '../../shared/conversation-runtime'
import { createStudioChatBackend, type StudioChatBackendDeps } from './studio-chat-backend'

// The RPC's chat surface in main is the conversation IPC's own handlers behind
// the IPC's own input checks: a send the IPC would refuse is refused in the
// same words, one it would take reaches the same handler with the same input,
// and the client's command id rides through for the runtime's receipts.

const session = {
  sessionId: 's1',
  workspaceId: 'ws-1',
  agentId: 'agent-1',
  providerId: 'mock',
  modelId: 'mock',
  status: 'ready' as const,
  createdAt: 1,
  updatedAt: 1,
}

function deps(overrides: Partial<StudioChatBackendDeps['conversation']> = {}) {
  const sends: ConversationSendTurnInput[] = []
  const conversation = {
    startSession: async () => ({ ok: true as const, session }),
    sendTurn: async (input: ConversationSendTurnInput) => {
      sends.push(input)
      return { ok: true as const, session }
    },
    interrupt: async () => ({ ok: true as const, session }),
    respondToRequest: async () => ({ ok: true as const, session }),
    setPermission: async () => ({ ok: true as const, session }),
    listProviders: async () => {
      throw new Error('provider registry offline')
    },
    listProviderModels: async () => ({ ok: true as const, models: [] }),
    getSecretStatus: async () => ({ ok: false as const, message: 'No secret.' }),
    ...overrides,
  } as StudioChatBackendDeps['conversation']
  const value: StudioChatBackendDeps = {
    conversation,
    files: {
      searchFiles: async () => ({ ok: false, message: 'no', engine: null }),
      cancelActiveFileSearch: () => undefined,
      cancelAllFileSearches: () => undefined,
      statPath: async () => ({ isFile: true, isDirectory: false, sizeBytes: 0, modifiedAt: '', modifiedAtMs: 0 }),
      readImageDataUrl: async () => 'data:',
    },
    repoRoot: async () => null,
    hasReceipt: async () => false,
    readableRoots: () => [tmpdir()],
    commands: async (input) => ({ cli: input.cli, cwd: input.cwd, commands: [], fetchedAt: 0 }),
    onCommandsChanged: () => () => undefined,
    workspaces: () => [],
  }
  return { value, sends }
}

test('a send is checked as the IPC checks it, and reaches its handler with the client’s command id', async () => {
  const { value, sends } = deps()
  const chat = createStudioChatBackend(value)
  const ok = await chat.sendTurn({
    sessionId: 's1',
    message: 'look',
    commandId: 'owner:4b1d3c8e-0000-4000-8000-000000000001',
    mode: 'plan',
    attachments: [{ id: 'img', mediaType: 'image/png', dataBase64: 'iVBORw0KGgo=', byteLength: 8 }],
  })
  assert.equal(ok.ok, true)
  assert.deepEqual(sends[0], {
    sessionId: 's1',
    message: 'look',
    mode: 'plan',
    attachments: [{ id: 'img', mediaType: 'image/png', dataBase64: 'iVBORw0KGgo=', byteLength: 8 }],
    commandId: 'owner:4b1d3c8e-0000-4000-8000-000000000001',
  })
  // The IPC's own refusals, in its own words.
  const svg = await chat.sendTurn({
    sessionId: 's1',
    message: 'x',
    attachments: [{ id: 'img', mediaType: 'image/svg+xml', dataBase64: 'PHN2Zz4=', byteLength: 5 }],
  })
  assert.deepEqual(svg, { ok: false, message: 'Attachments must be PNG, JPEG, WebP, or GIF images.' })
  const mentions = await chat.sendTurn({ sessionId: 's1', message: 'x', mentions: [{ nope: true }] as never })
  assert.deepEqual(mentions, { ok: false, message: 'Mention references are invalid.' })
  assert.equal(sends.length, 1)
})

test('a throw below answers as the IPC answers it, and a handler that is not there says so', async () => {
  const chat = createStudioChatBackend(deps().value)
  assert.deepEqual(await chat.providers({}), { ok: false, message: 'provider registry offline' })
  assert.deepEqual(await chat.setModel({ sessionId: 's1', modelId: 'm' }), {
    ok: false,
    message: 'Changing models mid-conversation is unavailable.',
  })
  const key = { workspaceRoot: '/Users/dev/app', workspaceId: 'ws-1', agentId: 'agent-1' }
  assert.deepEqual(await chat.revert({ key, turnSeq: 1 }), { ok: false, message: 'Checkpoints are unavailable.' })
  assert.deepEqual(await chat.attachment('a/b.png'), { ok: false, message: 'Attachments are unavailable.' })
  assert.deepEqual(await chat.secretStatus({ providerId: 'mock' }), { ok: false, message: 'No secret.' })
})

test('a revert, rewind, fork or picture read that throws is answered as that one failing, not as an error', async () => {
  const thrown = async () => {
    throw new Error('checkpoint store offline')
  }
  const chat = createStudioChatBackend(
    deps({ revertToTurn: thrown, rewindToTurn: thrown, forkAtTurn: thrown, readAttachment: thrown }).value,
  )
  const key = { workspaceRoot: '/Users/dev/app', workspaceId: 'ws-1', agentId: 'agent-1' }
  const failure = { ok: false, message: 'checkpoint store offline' }
  assert.deepEqual(await chat.revert({ key, turnSeq: 1 }), failure)
  assert.deepEqual(await chat.rewind({ key, turnSeq: 1 }), failure)
  assert.deepEqual(await chat.fork({ key, side: 'user', turnSeq: 1, newAgentId: 'agent-2' }), failure)
  assert.deepEqual(await chat.attachment('a/b.png'), failure)
})

test('a file is stat’d or read only inside the folders a chat can read, and by its real path', async () => {
  const workspace = await realpath(await mkdtemp(join(tmpdir(), 'studio-chat-files-')))
  try {
    await writeFile(join(workspace, 'a.png'), 'png')
    const read: string[] = []
    const { value } = deps()
    const chat = createStudioChatBackend({
      ...value,
      readableRoots: () => [workspace],
      files: {
        ...value.files,
        statPath: async (path) => {
          read.push(path)
          return { isFile: true, isDirectory: false, sizeBytes: 3, modifiedAt: '', modifiedAtMs: 1 }
        },
        readImageDataUrl: async (path) => {
          read.push(path)
          return 'data:image/png;base64,cG5n'
        },
      },
    })
    assert.equal((await chat.stat(join(workspace, 'a.png'))).isFile, true)
    assert.equal(await chat.readImage(join(workspace, 'a.png')), 'data:image/png;base64,cG5n')
    await assert.rejects(chat.stat('/etc/hosts'), /outside the folders this chat can read/)
    await assert.rejects(chat.readImage(`${workspace}/../a.png`), /not written plainly/)
    assert.deepEqual(read, [join(workspace, 'a.png'), join(workspace, 'a.png')])
  } finally {
    await rm(workspace, { recursive: true, force: true })
  }
})

test('a command list is asked for with a chat CLI and an absolute folder, as over IPC', async () => {
  const chat = createStudioChatBackend(deps().value)
  await assert.rejects(chat.commands({ cli: 'not-a-cli', cwd: '/Users/dev/app' }), /chat CLI and an absolute folder/)
  await assert.rejects(chat.commands({ cli: 'codex', cwd: 'relative/path' }), /chat CLI and an absolute folder/)
  assert.deepEqual(await chat.commands({ cli: 'codex', cwd: '/Users/dev/app' }), {
    cli: 'codex',
    cwd: '/Users/dev/app',
    commands: [],
    fetchedAt: 0,
  })
})

test('a ~/ picture is read as the file in the home folder, and held to the same folders', async () => {
  const home = await realpath(await mkdtemp(join(tmpdir(), 'studio-chat-home-')))
  const saved = { HOME: process.env.HOME, USERPROFILE: process.env.USERPROFILE }
  process.env.HOME = home
  process.env.USERPROFILE = home
  try {
    await mkdir(join(home, 'Desktop'))
    await writeFile(join(home, 'Desktop', 'shot.png'), 'png')
    const read: string[] = []
    const { value } = deps()
    const chat = createStudioChatBackend({
      ...value,
      readableRoots: () => [join(home, 'Desktop')],
      files: {
        ...value.files,
        readImageDataUrl: async (path) => {
          read.push(path)
          return 'data:image/png;base64,cG5n'
        },
      },
    })
    assert.equal(await chat.readImage('~/Desktop/shot.png'), 'data:image/png;base64,cG5n')
    assert.deepEqual(read, [join(home, 'Desktop', 'shot.png')])
    await assert.rejects(chat.readImage('~/Desktop/../Desktop/shot.png'), /not written plainly/)
    await assert.rejects(chat.readImage('~/elsewhere.png'), /outside the folders this chat can read/)
  } finally {
    for (const [key, value] of Object.entries(saved)) {
      if (value === undefined) delete process.env[key]
      else process.env[key] = value
    }
    await rm(home, { recursive: true, force: true })
  }
})
