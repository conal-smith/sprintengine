import assert from 'node:assert/strict'
import { test } from 'vitest'

import {
  STUDIO_COMMAND_METHODS,
  STUDIO_METHODS,
  STUDIO_TOPICS,
  isStudioMethod,
  parseStudioMethodParams,
  parseStudioTopicParams,
  type StudioMethod,
} from '../src/methods'
import { CONVERSATION_COMMAND_KINDS, CONVERSATION_MAX_MESSAGE_CHARS } from '../src/conversation'
import { STUDIO_CAPABILITIES } from '../src/handshake'
import { STUDIO_SCOPES } from '../src/scopes'

const key = { workspaceId: 'ws-1', agentId: 'agent-1' }

test('every method and topic names its scope and a capability this package defines', () => {
  // The type makes a missing entry a compile error; this makes a wrong one a
  // test failure, since a method with no scope would be open to every client.
  const methods = Object.keys(STUDIO_METHODS) as StudioMethod[]
  for (const method of methods) {
    const spec = STUDIO_METHODS[method]
    if (method === 'server.info' || method === 'server.ping') assert.equal(spec.scope, null, method)
    else assert.ok(spec.scope && (STUDIO_SCOPES as readonly string[]).includes(spec.scope), method)
    if (spec.capability) assert.ok((STUDIO_CAPABILITIES as readonly string[]).includes(spec.capability), method)
    assert.equal(isStudioMethod(method), true)
  }
  for (const [topic, spec] of Object.entries(STUDIO_TOPICS)) assert.ok(STUDIO_SCOPES.includes(spec.scope), topic)
  assert.equal(isStudioMethod('constructor'), false)
  assert.equal(isStudioMethod('conversation.compact'), false)
})

test('every mutation is a method that carries a commandId, and every reader is not', () => {
  for (const [method, spec] of Object.entries(STUDIO_METHODS)) {
    const withoutId = parseStudioMethodParams(method as StudioMethod, { key, message: 'hi', workspaceId: 'ws-1' })
    if (spec.mutation) assert.equal(withoutId.ok, false, method)
  }
})

test('every conversation command kind has its method, so the socket drives a chat as fully as the tailnet', () => {
  const carried = new Set<string>(Object.values(STUDIO_COMMAND_METHODS))
  // A kind the socket carried by a method of its own before the lane had the
  // command: `conversation.handoff` came with the window's Handoff, the lane's
  // `handoff` later, for a paired device.
  const ownMethods: Record<string, StudioMethod> = { handoff: 'conversation.handoff' }
  for (const kind of CONVERSATION_COMMAND_KINDS)
    if (ownMethods[kind]) assert.ok(isStudioMethod(ownMethods[kind]), kind)
    else assert.ok(carried.has(kind), kind)
  for (const method of Object.keys(STUDIO_COMMAND_METHODS))
    assert.equal(STUDIO_METHODS[method as StudioMethod].mutation, true)
})

test('a command’s params are read by the conversation lane’s own validator, and refused in its words', () => {
  assert.deepEqual(parseStudioMethodParams('conversation.send', { key, commandId: 'c1', message: 'hi', junk: 1 }), {
    ok: true,
    params: { key, commandId: 'c1', message: 'hi' },
  })
  assert.deepEqual(
    parseStudioMethodParams('conversation.setPermissionPreset', {
      key,
      commandId: 'c2',
      preset: 'auto',
      permissionMode: 'acceptEdits',
    }),
    { ok: true, params: { key, commandId: 'c2', preset: 'auto', permissionMode: 'acceptEdits' } },
  )
  assert.deepEqual(
    parseStudioMethodParams('conversation.resolvePlan', { key, commandId: 'c3', requestId: 'p1', decision: 'approve' }),
    { ok: true, params: { key, commandId: 'c3', requestId: 'p1', decision: 'approve' } },
  )
  // A permanent rule is the person's to make, on the desktop.
  const always = parseStudioMethodParams('conversation.resolveApproval', {
    key,
    commandId: 'c4',
    requestId: 'r1',
    decision: 'always',
  })
  assert.deepEqual(always.ok ? null : always.code, 'unsafe_remote_decision')
  const long = parseStudioMethodParams('conversation.send', {
    key,
    commandId: 'c5',
    message: 'x'.repeat(CONVERSATION_MAX_MESSAGE_CHARS + 1),
  })
  assert.deepEqual(long.ok ? null : long.code, 'too_large')
  const unknownPreset = parseStudioMethodParams('conversation.setPermissionPreset', {
    key,
    commandId: 'c6',
    preset: 'yolo',
  })
  assert.deepEqual(unknownPreset.ok ? null : unknownPreset.code, 'invalid_params')
  // Pictures are refused rather than dropped from a send.
  const pictures = parseStudioMethodParams('conversation.send', {
    key,
    commandId: 'c7',
    message: 'see',
    uploadIds: ['u1'],
  })
  assert.deepEqual(pictures.ok ? null : pictures.code, 'invalid_params')
  const noKey = parseStudioMethodParams('conversation.interrupt', { commandId: 'c8' })
  assert.deepEqual(noKey.ok ? null : noKey.code, 'invalid_params')
})

test('a create is the conversation create request plus the client’s commandId', () => {
  assert.deepEqual(
    parseStudioMethodParams('conversation.create', {
      commandId: 'create-1',
      workspaceId: ' ws-1 ',
      prompt: 'Hello',
      permissionPreset: 'auto',
      allowedTools: ['Write'],
      ownerModuleId: 'not-yours',
    }),
    {
      ok: true,
      params: {
        workspaceId: 'ws-1',
        prompt: 'Hello',
        permissionPreset: 'auto',
        allowedTools: ['Write'],
        commandId: 'create-1',
      },
    },
  )
  const bad = parseStudioMethodParams('conversation.create', {
    commandId: 'c',
    workspaceId: 'ws',
    allowedTools: 'Write',
  })
  assert.match(bad.ok ? '' : bad.message, /allowedTools/)
})

test('reads and the session stream take a key and their own bounds', () => {
  assert.deepEqual(parseStudioMethodParams('conversation.loadEarlier', { key, beforeCursor: 40, turnLimit: 5 }), {
    ok: true,
    params: { key, beforeCursor: 40, turnLimit: 5 },
  })
  assert.equal(parseStudioMethodParams('conversation.loadEarlier', { key, beforeCursor: -1 }).ok, false)
  assert.equal(parseStudioMethodParams('conversation.turnDiff', { key, turnSeq: 3, path: 'src/a.ts' }).ok, true)
  assert.deepEqual(parseStudioTopicParams('conversation.session', { key, turnLimit: 20 }), {
    ok: true,
    params: { key, turnLimit: 20 },
  })
  assert.equal(parseStudioTopicParams('conversation.session', { key, turnLimit: 101 }).ok, false)
  assert.equal(parseStudioMethodParams('conversation.list', 'nope').ok, false)
})
