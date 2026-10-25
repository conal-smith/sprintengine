import assert from 'node:assert/strict'
import { test } from 'vitest'

import { parseConversationClientMessage } from '../src/clientFrames'
import { CONVERSATION_MAX_SEND_MENTIONS } from '../src/commands'
import {
  CONVERSATION_MAX_FILE_SEARCH_RESULTS,
  parseConversationCommandsAnswer,
  parseConversationFileSearchAnswer,
} from '../src/composerReads'
import {
  CONVERSATION_CAPABILITIES,
  CONVERSATION_COMMANDS_CAPABILITY,
  CONVERSATION_FILE_SEARCH_CAPABILITY,
  CONVERSATION_SEND_MENTIONS_CAPABILITY,
} from '../src/handshake'

const send = (command: Record<string, unknown>) =>
  parseConversationClientMessage({
    type: 'command',
    commandId: 'cmd-1',
    key: { workspaceId: 'ws', agentId: 'agent' },
    command: { kind: 'send', message: 'Read these', ...command },
  })

test('the three capabilities are listed', () => {
  assert.equal(CONVERSATION_SEND_MENTIONS_CAPABILITY, 'conversation-send-mentions')
  assert.equal(CONVERSATION_FILE_SEARCH_CAPABILITY, 'conversation-file-search')
  assert.equal(CONVERSATION_COMMANDS_CAPABILITY, 'conversation-commands')
  for (const capability of [
    CONVERSATION_SEND_MENTIONS_CAPABILITY,
    CONVERSATION_FILE_SEARCH_CAPABILITY,
    CONVERSATION_COMMANDS_CAPABILITY,
  ])
    assert.ok((CONVERSATION_CAPABILITIES as readonly string[]).includes(capability))
})

test('a send keeps the mentions it names, beside its skills, and nothing else of them', () => {
  const frame = send({
    mentions: [
      { path: 'src/app.ts', kind: 'file', line: 4, endLine: 9, extra: 'dropped' },
      { path: 'docs', kind: 'folder' },
    ],
    skills: ['review'],
  })
  assert.ok(frame && frame.type === 'command' && frame.command.kind === 'send')
  assert.deepEqual(frame.command.mentions, [
    { path: 'src/app.ts', kind: 'file', line: 4, endLine: 9 },
    { path: 'docs', kind: 'folder' },
  ])
  assert.deepEqual(frame.command.skills, ['review'])
  assert.equal(frame.command.message, 'Read these')
})

test('a mention that is not a path inside the chat folder refuses the frame', () => {
  for (const path of ['/etc/passwd', '\\\\server\\share', 'C:\\Users', '../secrets', 'a/../../b', 'bad\u0000name', ''])
    assert.equal(send({ mentions: [{ path, kind: 'file' }] }), null, path)
  assert.equal(send({ mentions: [{ path: 'a.ts', kind: 'symlink' }] }), null)
  assert.equal(send({ mentions: [{ path: 'a.ts', kind: 'file', line: 0 }] }), null)
  assert.equal(send({ mentions: [{ path: 'a.ts', kind: 'file', line: 9, endLine: 4 }] }), null)
  assert.equal(send({ mentions: 'a.ts' }), null)
  assert.equal(
    send({
      mentions: Array.from({ length: CONVERSATION_MAX_SEND_MENTIONS + 1 }, (_, i) => ({ path: `f${i}`, kind: 'file' })),
    }),
    null,
  )
})

test('mentions ride a queued message, for a desktop that holds them', () => {
  const frame = send({ mentions: [{ path: 'a.ts', kind: 'file' }], queue: true })
  assert.ok(frame && frame.type === 'command' && frame.command.kind === 'send')
  assert.deepEqual(frame.command.mentions, [{ path: 'a.ts', kind: 'file' }])
  assert.equal(frame.command.queue, true)
})

test('a send with no mentions is read as before', () => {
  for (const command of [{}, { mentions: [] }]) {
    const frame = send(command)
    assert.ok(frame && frame.type === 'command' && frame.command.kind === 'send')
    assert.equal('mentions' in frame.command, false)
  }
})

test('a file search answer keeps relative paths and drops anything else', () => {
  const answer = parseConversationFileSearchAnswer({
    entries: [
      { path: 'src/app.ts', kind: 'file' },
      { path: 'src', kind: 'folder' },
      { path: '/Users/me/secret', kind: 'file' },
      { path: '../up', kind: 'file' },
      { path: 'x', kind: 'device' },
      'nonsense',
    ],
    truncated: true,
  })
  assert.deepEqual(answer, {
    entries: [
      { path: 'src/app.ts', kind: 'file' },
      { path: 'src', kind: 'folder' },
    ],
    truncated: true,
  })
  const many = parseConversationFileSearchAnswer({
    entries: Array.from({ length: CONVERSATION_MAX_FILE_SEARCH_RESULTS + 5 }, (_, i) => ({
      path: `f${i}`,
      kind: 'file',
    })),
  })
  assert.equal(many?.entries.length, CONVERSATION_MAX_FILE_SEARCH_RESULTS)
  assert.equal(many?.truncated, false)
  assert.equal(parseConversationFileSearchAnswer({}), null)
})

test('a command list keeps the CLI commands it can read, and never one of Studio its own', () => {
  const answer = parseConversationCommandsAnswer({
    cli: 'claude',
    fetchedAt: 1_700_000_000_000,
    commands: [
      { name: 'review', description: 'Review a pull request', argumentHint: '[pr]', source: 'cli' },
      { name: 'acme:deploy', source: 'custom', aliases: ['ship', 7] },
      { name: 'model', source: 'app' },
      { name: '/slashed', source: 'cli' },
      { name: 'two words', source: 'cli' },
      { name: 'brainstorm', source: 'skill', insertText: '$brainstorm ' },
    ],
    error: 'The last ask timed out.',
  })
  assert.deepEqual(answer, {
    cli: 'claude',
    fetchedAt: 1_700_000_000_000,
    commands: [
      { name: 'review', description: 'Review a pull request', argumentHint: '[pr]', source: 'cli' },
      { name: 'acme:deploy', source: 'custom', aliases: ['ship'] },
      { name: 'brainstorm', source: 'skill', insertText: '$brainstorm ' },
    ],
    error: 'The last ask timed out.',
  })
  assert.equal(parseConversationCommandsAnswer({ cli: 'claude' }), null)
  assert.equal(parseConversationCommandsAnswer({ cli: 'claude', commands: [], fetchedAt: -1 })?.fetchedAt, 0)
})
