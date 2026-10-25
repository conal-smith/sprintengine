import assert from 'node:assert/strict'
import { test } from 'vitest'

import {
  CONVERSATION_CAPABILITY,
  CONVERSATION_MODELS_CAPABILITY,
  CONVERSATION_PERMISSION_MODES_CAPABILITY,
  explainRejectedConversationFrame,
  parseConversationClientFrame,
} from '../src/index'
import {
  CONVERSATION_COMMAND_KINDS,
  CONVERSATION_MAX_ALLOWED_TOOLS,
  isConversationAllowedTools,
  parseConversationCreateRequest,
} from '../src/commands'
import {
  CONVERSATION_CAPABILITIES,
  CONVERSATION_CLI_PERMISSION_MODES_CAPABILITY,
  CONVERSATION_PROTOCOL_VERSION,
  checkConversationProtocolVersion,
  conversationPeerSupports,
  parseConversationHelloAnswer,
} from '../src/handshake'
import { explainRejectedConversationMessage, parseConversationClientMessage } from '../src/clientFrames'
import { parseConversationServerFrame } from '../src/serverFrames'

const key = { workspaceId: 'ws-1', agentId: 'agent-1' }
const command = (body: Record<string, unknown>, commandId = 'cmd-1') => ({ type: 'command', commandId, command: body })

// Every frame a client built against the first version sends. The full
// contract reads each exactly as the first version's parser does, so no
// existing client is read differently by a desktop that adopts it.
const FIRST_VERSION_FRAMES: unknown[] = [
  { type: 'subscribe', key, afterSeq: 8, generation: 'log-1', turnLimit: 20 },
  { type: 'subscribe', key },
  { type: 'list', requestId: 'list-1' },
  { type: 'loadEarlier', requestId: 'r', beforeCursor: 40, turnLimit: 5 },
  { type: 'getToolDetail', requestId: 'r', toolUseId: 'tool-1' },
  { type: 'getTurnDiff', requestId: 'r', turnSeq: 3, path: 'src/a.ts' },
  command({ kind: 'send', message: 'hello', uploadIds: ['u-1'] }),
  command({ kind: 'interrupt' }),
  command({ kind: 'resolveApproval', requestId: 'req-1', decision: 'conversation' }),
  command({ kind: 'answerQuestion', requestId: 'req-1', answers: { 'Which file?': 'a.ts' } }),
  command({ kind: 'setPermissionPreset', preset: 'auto' }),
  command({ kind: 'setModel', modelId: 'default' }),
  // Refused by both. (A permanent rule is read by the full contract alone,
  // for a desktop that takes one: permanent-approvals.test.ts.)
  command({ kind: 'send', message: 7 }),
  { type: 'subscribe', key, afterSeq: -1 },
  { type: 'unknown' },
  null,
]

test('the full contract reads every first-version frame as the first version does', () => {
  for (const frame of FIRST_VERSION_FRAMES)
    assert.deepEqual(parseConversationClientMessage(frame), parseConversationClientFrame(frame), JSON.stringify(frame))
})

test('hello asks the desktop for its version and capabilities', () => {
  assert.deepEqual(parseConversationClientMessage({ type: 'hello', requestId: 'h-1', protocolVersion: 1, extra: 1 }), {
    type: 'hello',
    requestId: 'h-1',
    protocolVersion: 1,
  })
  assert.deepEqual(parseConversationClientMessage({ type: 'hello', requestId: 'h-1' }), {
    type: 'hello',
    requestId: 'h-1',
  })
  for (const protocolVersion of [0, 1.5, '1', -2])
    assert.equal(parseConversationClientMessage({ type: 'hello', requestId: 'h-1', protocolVersion }), null)
  assert.equal(parseConversationClientMessage({ type: 'hello' }), null)
  // A desktop from before hello answers it under its request id, which is
  // how a client tells an old desktop from a broken one.
  assert.equal(parseConversationClientFrame({ type: 'hello', requestId: 'h-1' }), null)
  assert.deepEqual(explainRejectedConversationFrame({ type: 'hello', requestId: 'h-1' }), {
    code: 'invalid_frame',
    message: 'Unsupported conversation frame.',
    requestId: 'h-1',
  })
})

test('a plan is answered as a plan, with its own two decisions', () => {
  assert.deepEqual(
    parseConversationClientMessage(command({ kind: 'resolvePlan', requestId: 'req-2', decision: 'approve', note: 1 })),
    { type: 'command', commandId: 'cmd-1', command: { kind: 'resolvePlan', requestId: 'req-2', decision: 'approve' } },
  )
  for (const decision of ['once', 'always', 'deny', undefined])
    assert.equal(parseConversationClientMessage(command({ kind: 'resolvePlan', requestId: 'req-2', decision })), null)
  // A malformed plan answer is a bad frame on a desktop that knows the kind,
  // and an unknown command on one that does not: both settle the command.
  const malformed = command({ kind: 'resolvePlan', requestId: 'req-2', decision: 'maybe' })
  assert.deepEqual(explainRejectedConversationMessage(malformed), {
    code: 'invalid_frame',
    message: 'Unsupported conversation frame.',
    commandId: 'cmd-1',
    commandKind: 'resolvePlan',
  })
  assert.equal(explainRejectedConversationFrame(malformed).code, 'unsupported_command')
  assert.equal(explainRejectedConversationMessage(command({ kind: 'reboot' })).code, 'unsupported_command')
  assert.ok(CONVERSATION_COMMAND_KINDS.includes('resolvePlan'))
})

test('a preset switch carries the CLI’s own mode, which an older desktop drops', () => {
  const frame = command({ kind: 'setPermissionPreset', preset: 'auto', permissionMode: 'acceptEdits' })
  assert.deepEqual(parseConversationClientMessage(frame), {
    type: 'command',
    commandId: 'cmd-1',
    command: { kind: 'setPermissionPreset', preset: 'auto', permissionMode: 'acceptEdits' },
  })
  // The fallback the extension is shaped for: the first version strips the
  // member and runs the preset's own mode.
  assert.deepEqual(parseConversationClientFrame(frame), {
    type: 'command',
    commandId: 'cmd-1',
    command: { kind: 'setPermissionPreset', preset: 'auto' },
  })
  for (const permissionMode of ['', 'accept edits', '--yolo', 'a'.repeat(41), 7])
    assert.equal(
      parseConversationClientMessage(command({ kind: 'setPermissionPreset', preset: 'auto', permissionMode })),
      null,
      String(permissionMode),
    )
  assert.equal(
    parseConversationClientMessage(command({ kind: 'setPermissionPreset', preset: 'loose', permissionMode: 'x' })),
    null,
  )
})

test('a create request keeps only what the contract defines', () => {
  assert.deepEqual(
    parseConversationCreateRequest({
      workspaceId: ' ws-1 ',
      cli: 'claude-code',
      prompt: 'Draft the notes.',
      permissionPreset: 'manual',
      permissionMode: 'acceptEdits',
      allowedTools: ['Write', 'Edit', 'Bash(npm test:*)'],
      skills: ['notes'],
      ownerModuleId: 'someone-else',
    }),
    {
      ok: true,
      request: {
        workspaceId: 'ws-1',
        cli: 'claude-code',
        prompt: 'Draft the notes.',
        skills: ['notes'],
        permissionPreset: 'manual',
        permissionMode: 'acceptEdits',
        allowedTools: ['Write', 'Edit', 'Bash(npm test:*)'],
      },
    },
  )
  // A mode means something only beside its preset.
  const modeAlone = parseConversationCreateRequest({ workspaceId: 'ws-1', permissionMode: 'acceptEdits' })
  assert.deepEqual(modeAlone, { ok: true, request: { workspaceId: 'ws-1' } })
  const refusals: [unknown, string][] = [
    [null, ''],
    [{}, 'workspaceId'],
    [{ workspaceId: 'ws-1', cli: 3 }, 'cli'],
    [{ workspaceId: 'ws-1', permissionPreset: 'yolo' }, 'permissionPreset'],
    [{ workspaceId: 'ws-1', permissionPreset: 'auto', permissionMode: '../x' }, 'permissionMode'],
    [{ workspaceId: 'ws-1', allowedTools: 'Write' }, 'allowedTools'],
    [{ workspaceId: 'ws-1', allowedTools: ['Write\nBash'] }, 'allowedTools'],
    [{ workspaceId: 'ws-1', allowedTools: [' Write'] }, 'allowedTools'],
    [{ workspaceId: 'ws-1', allowedTools: [''] }, 'allowedTools'],
    [{ workspaceId: 'ws-1', skills: [''] }, 'skills'],
  ]
  for (const [input, field] of refusals) {
    const parsed = parseConversationCreateRequest(input)
    assert.equal(parsed.ok, false, JSON.stringify(input))
    if (!parsed.ok) assert.equal(parsed.field, field)
  }
  assert.equal(
    isConversationAllowedTools(Array.from({ length: CONVERSATION_MAX_ALLOWED_TOOLS }, (_, i) => `T${i}`)),
    true,
  )
  assert.equal(
    isConversationAllowedTools(Array.from({ length: CONVERSATION_MAX_ALLOWED_TOOLS + 1 }, (_, i) => `T${i}`)),
    false,
  )
})

test('the handshake names versions and capabilities, and a refusal names both numbers', () => {
  assert.equal(CONVERSATION_PROTOCOL_VERSION, 1)
  for (const shipped of [
    CONVERSATION_CAPABILITY,
    CONVERSATION_MODELS_CAPABILITY,
    CONVERSATION_PERMISSION_MODES_CAPABILITY,
  ])
    assert.ok((CONVERSATION_CAPABILITIES as readonly string[]).includes(shipped), shipped)
  assert.deepEqual(
    parseConversationHelloAnswer({
      protocolVersion: 1,
      minProtocolVersion: 1,
      capabilities: ['conversations', 'conversation-plans', 'NOT A NAME', 4],
      extra: true,
    }),
    { protocolVersion: 1, minProtocolVersion: 1, capabilities: ['conversations', 'conversation-plans'] },
  )
  assert.equal(parseConversationHelloAnswer({ protocolVersion: 0, minProtocolVersion: 1, capabilities: [] }), null)
  assert.equal(parseConversationHelloAnswer({ protocolVersion: 1, capabilities: [] }), null)
  assert.deepEqual(checkConversationProtocolVersion(1), { ok: true })
  const tooNew = checkConversationProtocolVersion(3, 3)
  assert.equal(tooNew.ok, false)
  if (!tooNew.ok) assert.match(tooNew.message, /needs conversation protocol 3 or newer.*speaks 1\. Update this end/)
  // Unknown versus denied: no list is not a list without the name.
  assert.equal(conversationPeerSupports(null, CONVERSATION_CLI_PERMISSION_MODES_CAPABILITY), false)
  assert.equal(
    conversationPeerSupports(['conversation-cli-permission-modes'], 'conversation-cli-permission-modes'),
    true,
  )
})

test('a listed chat names its CLI mode only beside its preset', () => {
  const thread = (extra: Record<string, unknown>) => ({
    ...key,
    title: 'Notes',
    phase: 'idle',
    updatedAt: 2,
    createdAt: 1,
    providerId: 'claude-agent',
    modelId: 'default',
    turnCount: 1,
    lastSeq: 4,
    ...extra,
  })
  const listed = parseConversationServerFrame({
    type: 'sessions',
    requestId: 'list-1',
    sessions: [
      thread({
        permissionPreset: 'auto',
        permissionMode: 'acceptEdits',
        capabilities: { approvals: true, permissionModes: ['acceptEdits', 'dontAsk', '<b>'] },
      }),
      thread({ agentId: 'agent-2', permissionMode: 'acceptEdits' }),
    ],
  })
  assert.ok(listed?.type === 'sessions')
  assert.equal(listed.sessions[0]?.permissionMode, 'acceptEdits')
  assert.deepEqual(listed.sessions[0]?.capabilities?.permissionModes, ['acceptEdits', 'dontAsk'])
  assert.equal(listed.sessions[1]?.permissionMode, undefined)
})

test('an answer is keyed by its whole question, however long the question is', () => {
  const long = `${'Which of these should happen to the old history? '.repeat(6)}Pick one.`
  assert.ok(long.length > 200)
  const answers = { [long]: 'Rewrite now, make this repo public', 'And the PRs?': 'Leave them, Other words' }
  assert.deepEqual(parseConversationClientMessage(command({ kind: 'answerQuestion', requestId: 'req-2', answers })), {
    type: 'command',
    commandId: 'cmd-1',
    command: { kind: 'answerQuestion', requestId: 'req-2', answers },
  })
  // The first version's own reader still refuses it, as an older desktop does.
  assert.equal(parseConversationClientFrame(command({ kind: 'answerQuestion', requestId: 'req-2', answers })), null)
  // Past a question's own limit it is too large, answered under its id.
  const huge = command({ kind: 'answerQuestion', requestId: 'req-2', answers: { ['Q'.repeat(20_001)]: 'yes' } })
  assert.equal(parseConversationClientMessage(huge), null)
  assert.deepEqual(explainRejectedConversationMessage(huge), {
    code: 'too_large',
    message: 'A question and its answer may each hold at most 20000 characters.',
    commandId: 'cmd-1',
    commandKind: 'answerQuestion',
  })
  // Still at most 64 answers, each a string.
  const many = Object.fromEntries(Array.from({ length: 65 }, (_, index) => [`q${index}`, 'a']))
  assert.equal(parseConversationClientMessage(command({ kind: 'answerQuestion', requestId: 'r', answers: many })), null)
  assert.equal(
    parseConversationClientMessage(command({ kind: 'answerQuestion', requestId: 'r', answers: { q: 1 } })),
    null,
  )
})
