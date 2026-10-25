import assert from 'node:assert/strict'
import { test } from 'vitest'

import { explainRejectedConversationMessage, parseConversationClientMessage } from '../src/clientFrames'
import { CONVERSATION_COMMAND_KINDS, CONVERSATION_MAX_REVERT_FILES } from '../src/commands'
import {
  CONVERSATION_CAPABILITIES,
  CONVERSATION_CHECKPOINT_REVERT_CAPABILITY,
  CONVERSATION_REWIND_CAPABILITY,
} from '../src/handshake'
import { parseConversationRevertAnswer, parseConversationServerFrame } from '../src/serverFrames'

const command = (body: Record<string, unknown>) => ({
  type: 'command',
  commandId: 'cmd-1',
  key: { workspaceId: 'ws', agentId: 'agent' },
  command: body,
})

const listed = (capabilities: Record<string, unknown>) =>
  parseConversationServerFrame({
    type: 'sessions',
    requestId: 'list-1',
    sessions: [
      {
        workspaceId: 'ws',
        agentId: 'agent',
        title: 'Restyle the design system',
        phase: 'idle',
        updatedAt: 2,
        createdAt: 1,
        providerId: 'claude-agent',
        modelId: 'default',
        turnCount: 1,
        lastSeq: 4,
        capabilities: {
          images: true,
          approvals: true,
          questions: true,
          planMode: false,
          interrupt: true,
          checkpoints: true,
          ...capabilities,
        },
      },
    ],
  })

const file = { path: 'src/app.ts', status: 'modified', addedLines: 3, removedLines: 1, binary: false }

test('the capabilities and the command kinds are listed', () => {
  assert.equal(CONVERSATION_REWIND_CAPABILITY, 'conversation-rewind')
  assert.equal(CONVERSATION_CHECKPOINT_REVERT_CAPABILITY, 'conversation-checkpoint-revert')
  for (const capability of [CONVERSATION_REWIND_CAPABILITY, CONVERSATION_CHECKPOINT_REVERT_CAPABILITY])
    assert.ok((CONVERSATION_CAPABILITIES as readonly string[]).includes(capability))
  assert.ok(CONVERSATION_COMMAND_KINDS.includes('rewind'))
  assert.ok(CONVERSATION_COMMAND_KINDS.includes('revert'))
})

test('a rewind names the message by its seq, and nothing else rides with it', () => {
  assert.deepEqual(parseConversationClientMessage(command({ kind: 'rewind', turnSeq: 7, extra: 'dropped' })), {
    type: 'command',
    commandId: 'cmd-1',
    command: { kind: 'rewind', turnSeq: 7 },
  })
})

test('a rewind that names no message is a bad frame, not one the desktop does not know', () => {
  for (const turnSeq of [undefined, 0, -1, 1.5, '7']) {
    const frame = command({ kind: 'rewind', turnSeq })
    assert.equal(parseConversationClientMessage(frame), null)
    assert.equal(explainRejectedConversationMessage(frame).code, 'invalid_frame')
  }
})

test('a revert previews without paths, and a confirmed one names the paths the preview listed', () => {
  assert.deepEqual(parseConversationClientMessage(command({ kind: 'revert', turnSeq: 3, undo: true })), {
    type: 'command',
    commandId: 'cmd-1',
    command: { kind: 'revert', turnSeq: 3, undo: true },
  })
  assert.deepEqual(
    parseConversationClientMessage(
      command({ kind: 'revert', turnSeq: 3, confirmed: true, files: ['src/app.ts', 'README.md'] }),
    ),
    {
      type: 'command',
      commandId: 'cmd-1',
      command: { kind: 'revert', turnSeq: 3, confirmed: true, files: ['src/app.ts', 'README.md'] },
    },
  )
  // A turn that changed nothing confirms an empty list, as the desktop's own does.
  assert.ok(parseConversationClientMessage(command({ kind: 'revert', turnSeq: 3, confirmed: true, files: [] })))
})

test('a revert that is not in that shape is a bad frame', () => {
  for (const body of [
    { turnSeq: 0 },
    { turnSeq: 3, undo: false },
    { turnSeq: 3, confirmed: 'yes', files: [] },
    // Confirmed without the list it confirms, or a preview that names one.
    { turnSeq: 3, confirmed: true },
    { turnSeq: 3, files: ['src/app.ts'] },
    { turnSeq: 3, confirmed: true, files: ['src/app.ts', ''] },
    { turnSeq: 3, confirmed: true, files: [7] },
    { turnSeq: 3, confirmed: true, files: ['x'.repeat(4097)] },
    { turnSeq: 3, confirmed: true, files: Array.from({ length: CONVERSATION_MAX_REVERT_FILES + 1 }, () => 'a') },
  ]) {
    const frame = command({ kind: 'revert', ...body })
    assert.equal(parseConversationClientMessage(frame), null, JSON.stringify(body).slice(0, 80))
    assert.equal(explainRejectedConversationMessage(frame).code, 'invalid_frame')
  }
})

test('a listed chat keeps whether it can go back, and leaves out a flag it cannot read', () => {
  const can = listed({ rewind: true })
  assert.ok(can?.type === 'sessions')
  assert.equal(can.sessions[0]!.capabilities?.rewind, true)
  const cannot = listed({ rewind: false })
  assert.ok(cannot?.type === 'sessions')
  assert.equal(cannot.sessions[0]!.capabilities?.rewind, false)
  const unread = listed({ rewind: 'sometimes' })
  assert.ok(unread?.type === 'sessions')
  assert.equal('rewind' in (unread.sessions[0]!.capabilities ?? {}), false)
  const older = listed({})
  assert.ok(older?.type === 'sessions')
  assert.equal('rewind' in (older.sessions[0]!.capabilities ?? {}), false, 'a desktop from before it says nothing')
})

test("a command's result keeps what it says beside yes or no, and a result without it reads as before", () => {
  const answered = parseConversationServerFrame({
    type: 'commandResult',
    commandId: 'cmd-1',
    ok: true,
    data: { files: [file], reverted: false },
  })
  assert.deepEqual(answered, {
    type: 'commandResult',
    commandId: 'cmd-1',
    ok: true,
    data: { files: [file], reverted: false },
  })
  const plain = parseConversationServerFrame({ type: 'commandResult', commandId: 'cmd-1', ok: true, data: 'odd' })
  assert.deepEqual(plain, { type: 'commandResult', commandId: 'cmd-1', ok: true })
})

test("a revert's answer is read whole, or not at all", () => {
  assert.deepEqual(parseConversationRevertAnswer({ files: [file], reverted: true, kept: ['.env.local', 7] }), {
    files: [file],
    reverted: true,
    kept: ['.env.local'],
  })
  assert.deepEqual(parseConversationRevertAnswer({ changed: true }), { changed: true })
  assert.deepEqual(parseConversationRevertAnswer({ files: [], reverted: false }), { files: [], reverted: false })
  // One file this build cannot read would make a confirmed revert name fewer
  // paths than the desktop listed, which it refuses: the answer is unreadable.
  for (const value of [
    undefined,
    { files: [file] },
    { files: [{ ...file, status: 'renamed' }], reverted: false },
    { files: [{ ...file, addedLines: -1 }], reverted: false },
    { files: [{ ...file, path: '' }], reverted: false },
  ])
    assert.equal(parseConversationRevertAnswer(value), null)
})
