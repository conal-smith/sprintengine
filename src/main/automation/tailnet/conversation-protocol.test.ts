import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { test } from 'vitest'
import {
  CONVERSATION_CAPABILITY,
  CONVERSATION_DEFAULT_MODEL_ID,
  CONVERSATION_MAX_MODEL_OPTIONS,
  CONVERSATION_MODELS_CAPABILITY,
  CONVERSATION_MAX_CLIENT_FRAME_BYTES,
  CONVERSATION_MAX_MESSAGE_CHARS,
  CONVERSATION_MAX_IMAGES,
  conversationCloseReason,
  explainRejectedConversationFrame,
  conversationCloseRetryAfterMs,
  CONVERSATION_PERMISSION_MODES_CAPABILITY,
  parseConversationClientFrame,
  parseConversationWireModels,
} from '../../../../packages/conversation-protocol/src'
import { CONVERSATION_CAPABILITIES } from '../../../../packages/conversation-protocol/src/handshake'
import { TAILNET_CAPABILITIES } from './tailnet-routes'
import {
  isKnownConversationServerFrameType,
  parseConversationServerFrame,
} from '../../../../packages/conversation-protocol/src/serverFrames'

test('portable protocol source stays byte-identical to the companion source mirror', () => {
  const hash = createHash('sha256')
  for (const name of ['index.ts', 'presentation.ts', 'tool-types.ts', 'toolKind.ts', 'commandLabel.ts']) {
    hash.update(name)
    hash.update('\0')
    hash.update(readFileSync(join(process.cwd(), 'packages/conversation-protocol/src', name)))
  }
  // Update this pin and the companion's pin together only after comparing both
  // source trees. A local digest alone cannot detect a stale peer mirror.
  assert.equal(hash.digest('hex'), 'a1313dd4c44024e14956b1fb461ca30d0d65851ec28162453ffa888af66c5c3c')
})

test('conversation protocol accepts bounded frames and refuses a permanent rule', () => {
  assert.equal(CONVERSATION_CAPABILITY, 'conversations')
  assert.deepEqual(
    parseConversationClientFrame({ type: 'subscribe', key: { workspaceId: 'w', agentId: 'a' }, afterSeq: 8 }),
    { type: 'subscribe', key: { workspaceId: 'w', agentId: 'a' }, afterSeq: 8 },
  )
  assert.equal(
    parseConversationClientFrame({ type: 'subscribe', key: { workspaceId: 'w', agentId: 'a' }, afterSeq: -1 }),
    null,
  )
  // A resume cursor is a sequence plus the log generation it was read from.
  assert.deepEqual(
    parseConversationClientFrame({
      type: 'subscribe',
      key: { workspaceId: 'w', agentId: 'a' },
      afterSeq: 8,
      generation: 'log-1',
      unknown: true,
    }),
    { type: 'subscribe', key: { workspaceId: 'w', agentId: 'a' }, afterSeq: 8, generation: 'log-1' },
  )
  for (const generation of ['', 7, 'g'.repeat(201)])
    assert.equal(
      parseConversationClientFrame({ type: 'subscribe', key: { workspaceId: 'w', agentId: 'a' }, generation }),
      null,
    )
  assert.equal(
    parseConversationClientFrame({
      type: 'command',
      commandId: 'c',
      command: {
        kind: 'resolveApproval',
        requestId: 'r',
        decision: 'always',
      },
    }),
    null,
  )
  // A device that may operate a chat switches it between the presets the
  // desktop offers, each read as itself: a client built before the two-mode
  // change meant Manual and Auto as much as one that sees
  // `conversation-permission-modes` does.
  const presetFrame = (preset: unknown) => ({
    type: 'command',
    commandId: 'c',
    command: { kind: 'setPermissionPreset', preset },
  })
  for (const [sent, read] of [
    ['bypass', 'bypass'],
    ['none', 'none'],
    ['manual', 'manual'],
    ['auto', 'auto'],
  ] as const)
    assert.deepEqual(parseConversationClientFrame(presetFrame(sent)), {
      type: 'command',
      commandId: 'c',
      command: { kind: 'setPermissionPreset', preset: read },
    })
  assert.equal(CONVERSATION_PERMISSION_MODES_CAPABILITY, 'conversation-permission-modes')
  for (const preset of ['bypass_all', 'yolo', 7, undefined])
    assert.equal(parseConversationClientFrame(presetFrame(preset)), null)
  assert.equal(parseConversationClientFrame({ type: 'command', command: { kind: 'send', message: 'hello' } }), null)
})

test('a model switch names one model id and nothing else', () => {
  assert.equal(CONVERSATION_MODELS_CAPABILITY, 'conversation-models')
  const modelFrame = (command: Record<string, unknown>) => ({ type: 'command', commandId: 'c', command })
  for (const modelId of ['opus', CONVERSATION_DEFAULT_MODEL_ID, 'm'.repeat(200)])
    assert.deepEqual(parseConversationClientFrame(modelFrame({ kind: 'setModel', modelId })), {
      type: 'command',
      commandId: 'c',
      command: { kind: 'setModel', modelId },
    })
  // A CLI is not something a switch can name: the extra member is stripped,
  // not carried to the host.
  assert.deepEqual(parseConversationClientFrame(modelFrame({ kind: 'setModel', modelId: 'opus', cli: 'codex' })), {
    type: 'command',
    commandId: 'c',
    command: { kind: 'setModel', modelId: 'opus' },
  })
  for (const modelId of ['', 7, null, undefined, 'm'.repeat(201)]) {
    const frame = modelFrame({ kind: 'setModel', modelId })
    assert.equal(parseConversationClientFrame(frame), null)
    // A malformed switch is a bad frame, not an unknown command.
    assert.deepEqual(explainRejectedConversationFrame(frame), {
      code: 'invalid_frame',
      message: 'Unsupported conversation frame.',
      commandId: 'c',
      commandKind: 'setModel',
    })
  }
})

test('a listed model catalog is validated, bounded and never lists the default row', () => {
  const catalog = {
    cli: 'claude-code',
    cliLabel: 'Claude Code',
    liveModelSwitch: true,
    options: [
      { id: 'opus', label: ' Opus ' },
      { id: 'sonnet' },
      { id: CONVERSATION_DEFAULT_MODEL_ID, label: 'Default' },
      { id: '' },
      { label: 'no id' },
      { id: 'haiku', label: 'l'.repeat(201) },
    ],
  }
  assert.deepEqual(parseConversationWireModels(catalog), {
    cli: 'claude-code',
    cliLabel: 'Claude Code',
    liveModelSwitch: true,
    options: [{ id: 'opus', label: 'Opus' }, { id: 'sonnet' }, { id: 'haiku' }],
  })
  const long = parseConversationWireModels({
    ...catalog,
    options: Array.from({ length: CONVERSATION_MAX_MODEL_OPTIONS + 5 }, (_, index) => ({ id: `m${index}` })),
  })
  assert.equal(long?.options.length, CONVERSATION_MAX_MODEL_OPTIONS)
  for (const broken of [
    null,
    [],
    { ...catalog, cli: '' },
    { ...catalog, cliLabel: 7 },
    { ...catalog, liveModelSwitch: 'yes' },
    { ...catalog, options: {} },
  ])
    assert.equal(parseConversationWireModels(broken), null)
})

test('a resync close reason carries the retry delay any client can read', () => {
  const reason = conversationCloseReason('resync_required', 2_000.4)
  assert.equal(reason, 'resync_required;retryAfterMs=2000')
  assert.ok(Buffer.byteLength(reason) <= 123, 'fits a WebSocket close frame')
  assert.equal(conversationCloseRetryAfterMs(reason), 2_000)
  assert.equal(conversationCloseRetryAfterMs('resync_required'), null)
  assert.equal(conversationCloseRetryAfterMs('This device has been revoked.'), null)
})

test('every frame the validator accepts fits the client frame cap', () => {
  // The worst case: every unit of the longest message escaped, the longest ids,
  // every image reference.
  const frame = {
    type: 'command',
    commandId: 'c'.repeat(200),
    command: {
      kind: 'send',
      message: '\u0001'.repeat(CONVERSATION_MAX_MESSAGE_CHARS),
      uploadIds: Array.from({ length: CONVERSATION_MAX_IMAGES }, () => 'u'.repeat(200)),
    },
  }
  assert.ok(parseConversationClientFrame(frame))
  assert.ok(Buffer.byteLength(JSON.stringify(frame)) <= CONVERSATION_MAX_CLIENT_FRAME_BYTES)
  const answers = Object.fromEntries(
    Array.from({ length: 64 }, (_, index) => [`q${index}`.padEnd(200, '?'), '\u0001'.repeat(2_900)]),
  )
  const answer = {
    type: 'command',
    commandId: 'c'.repeat(200),
    command: { kind: 'answerQuestion', requestId: 'r', answers },
  }
  assert.ok(parseConversationClientFrame(answer))
  assert.ok(Buffer.byteLength(JSON.stringify(answer)) <= CONVERSATION_MAX_CLIENT_FRAME_BYTES)
  const tooMany = Object.fromEntries(Array.from({ length: 65 }, (_, index) => [`q${index}`, 'a']))
  assert.equal(parseConversationClientFrame({ ...answer, command: { ...answer.command, answers: tooMany } }), null)
})

test('a refused frame is explained under the id it carries', () => {
  const send = (message: string) => ({ type: 'command', commandId: 'c', command: { kind: 'send', message } })
  assert.deepEqual(explainRejectedConversationFrame(send('x'.repeat(CONVERSATION_MAX_MESSAGE_CHARS + 1))), {
    code: 'too_large',
    message: `A message may hold at most ${CONVERSATION_MAX_MESSAGE_CHARS} characters.`,
    commandId: 'c',
    commandKind: 'send',
  })
  assert.equal(
    explainRejectedConversationFrame({
      type: 'command',
      commandId: 'c',
      command: { kind: 'resolveApproval', requestId: 'r', decision: 'always' },
    }).code,
    'unsafe_remote_decision',
  )
  assert.equal(
    explainRejectedConversationFrame({ type: 'command', commandId: 'c', command: { kind: 'format_disk' } }).code,
    'unsupported_command',
  )
  assert.deepEqual(explainRejectedConversationFrame({ type: 'loadEarlier', requestId: 'r', beforeCursor: -1 }), {
    code: 'invalid_frame',
    message: 'Unsupported conversation frame.',
    requestId: 'r',
  })
  assert.deepEqual(explainRejectedConversationFrame('nonsense'), {
    code: 'invalid_frame',
    message: 'Unsupported conversation frame.',
  })
})

test('server frames are validated before a client applies them, and unknown types stay distinguishable', () => {
  const event = {
    id: 'e1',
    seq: 4,
    sessionId: 's',
    workspaceId: 'w',
    agentId: 'a',
    providerId: 'p',
    modelId: 'm',
    type: 'content_delta',
    createdAt: 1,
    payload: { text: 'hi' },
    extra: true,
  }
  const { extra: _extra, ...kept } = event
  assert.deepEqual(parseConversationServerFrame({ type: 'event', event }), { type: 'event', event: kept })
  assert.equal(parseConversationServerFrame({ type: 'event', event: { ...event, seq: -1 } }), null)
  assert.deepEqual(
    parseConversationServerFrame({
      type: 'snapshot',
      page: { events: [event], hasMore: true, beforeCursor: 4 },
      reset: true,
      generation: 'g',
      part: { index: 0, total: 2 },
    }),
    {
      type: 'snapshot',
      page: { events: [kept], hasMore: true, beforeCursor: 4 },
      reset: true,
      generation: 'g',
      part: { index: 0, total: 2 },
    },
  )
  assert.equal(
    parseConversationServerFrame({
      type: 'snapshot',
      page: { events: [], hasMore: false, beforeCursor: null },
      part: { index: 2, total: 2 },
    }),
    null,
    'a part outside its total',
  )
  assert.equal(parseConversationServerFrame({ type: 'synchronized', seq: 3, generation: '' }), null)
  assert.deepEqual(
    parseConversationServerFrame({ type: 'commandResult', commandId: 'c', ok: false, code: 'busy', retryAfterMs: 250 }),
    {
      type: 'commandResult',
      commandId: 'c',
      ok: false,
      code: 'busy',
      retryAfterMs: 250,
    },
  )
  assert.equal(parseConversationServerFrame({ type: 'chunk', frameId: 'f', index: 3, total: 3, json: '' }), null)
  // One unreadable row does not hide the rest of a list.
  const listed = parseConversationServerFrame({
    type: 'sessions',
    requestId: 'list',
    sessions: [
      {
        workspaceId: 'w',
        agentId: 'a',
        title: 'T',
        phase: 'running',
        updatedAt: 2,
        createdAt: 1,
        providerId: 'p',
        modelId: 'm',
        turnCount: 1,
        lastSeq: 9,
        permissionPreset: 'bypass',
        capabilities: { images: true, permissionPresets: ['none', 'auto', 'yolo', 'bypass'] },
      },
      { workspaceId: 'w', agentId: 'b', phase: 'dancing' },
      // A preset this client does not know is left out, not guessed at.
      {
        workspaceId: 'w',
        agentId: 'c',
        title: 'T',
        phase: 'idle',
        updatedAt: 2,
        createdAt: 1,
        providerId: 'p',
        modelId: 'm',
        turnCount: 0,
        lastSeq: 0,
        permissionPreset: 'yolo',
      },
    ],
  })
  assert.equal(listed?.type === 'sessions' && listed.sessions.length, 2)
  assert.equal(listed?.type === 'sessions' && listed.sessions[0].capabilities?.checkpoints, false)
  assert.equal(listed?.type === 'sessions' && listed.sessions[0].permissionPreset, 'bypass')
  // The presets a chat's provider runs: the ones this client knows.
  assert.deepEqual(listed?.type === 'sessions' && listed.sessions[0].capabilities?.permissionPresets, [
    'none',
    'auto',
    'bypass',
  ])
  assert.equal(listed?.type === 'sessions' && 'permissionPreset' in listed.sessions[1], false)
  assert.equal(parseConversationServerFrame({ type: 'presence' }), null)
  assert.equal(isKnownConversationServerFrameType({ type: 'presence' }), false)
  assert.equal(isKnownConversationServerFrameType({ type: 'event' }), true)
})

test("a listed chat's catalog reaches a client whole or not at all, and a notice rides only an accepted command", () => {
  const row = {
    workspaceId: 'w',
    agentId: 'a',
    title: 'T',
    phase: 'idle',
    updatedAt: 2,
    createdAt: 1,
    providerId: 'claude-agent',
    modelId: 'opus',
    turnCount: 1,
    lastSeq: 9,
  }
  const models = { cli: 'claude-code', cliLabel: 'Claude Code', liveModelSwitch: true, options: [{ id: 'opus' }] }
  const listed = parseConversationServerFrame({
    type: 'sessions',
    requestId: 'list',
    sessions: [
      { ...row, models },
      // A catalog in the wrong shape leaves the row listed without one.
      { ...row, agentId: 'b', models: { ...models, liveModelSwitch: 'sometimes' } },
      // A desktop that does not offer switching lists none.
      { ...row, agentId: 'c' },
    ],
  })
  assert.ok(listed?.type === 'sessions')
  assert.deepEqual(listed.sessions[0].models, models)
  assert.equal('models' in listed.sessions[1], false)
  assert.equal('models' in listed.sessions[2], false)

  const notice = 'The new model starts with your next message.'
  assert.deepEqual(parseConversationServerFrame({ type: 'commandResult', commandId: 'c', ok: true, notice }), {
    type: 'commandResult',
    commandId: 'c',
    ok: true,
    notice,
  })
  assert.deepEqual(
    parseConversationServerFrame({ type: 'commandResult', commandId: 'c', ok: false, code: 'x', notice }),
    { type: 'commandResult', commandId: 'c', ok: false, code: 'x' },
  )
  assert.deepEqual(parseConversationServerFrame({ type: 'commandResult', commandId: 'c', ok: true, notice: 7 }), {
    type: 'commandResult',
    commandId: 'c',
    ok: true,
  })
})

test('every conversation capability this machine advertises is one the protocol package names', () => {
  // A capability string is wire vocabulary: one minted here and not in the
  // package is one no client built from the package can ask for.
  const advertised = TAILNET_CAPABILITIES.filter((name) => name === 'conversations' || name.startsWith('conversation-'))
  for (const name of advertised) assert.ok((CONVERSATION_CAPABILITIES as readonly string[]).includes(name), name)
  for (const name of CONVERSATION_CAPABILITIES)
    assert.ok((TAILNET_CAPABILITIES as readonly string[]).includes(name), `${name} is named but not served`)
})
