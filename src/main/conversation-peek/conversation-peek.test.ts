import assert from 'node:assert/strict'

import type { ConversationPeek } from '../../shared/conversation-peek'
import type { ConversationEvent } from '../../shared/conversation-runtime'
import { MAX_PEEK_FIRST_CHARS, MAX_PEEK_MESSAGE_CHARS, MAX_PEEK_MESSAGES } from '../../shared/conversation-peek'
import { registerConversationPeekIpc } from '../ipc/conversation-peek-ipc'
import {
  appendLivePeekPrompt,
  createConversationPeekService,
  MAX_LIVE_PEEK_PROMPTS,
  type ConversationPeekSessionState,
} from './service'
import { capPeekText, collapsePeekText, MAX_COLLAPSE_INPUT_CHARS } from './text'
import { test } from 'vitest'
import { quoteToken } from '../../shared/chat-quotes'

function serviceFor(states: Record<string, ConversationPeekSessionState>) {
  const reads: string[] = []
  const service = createConversationPeekService({
    readSessionState: async (sessionId) => {
      reads.push(sessionId)
      return states[sessionId] ?? null
    },
  })
  return { service, reads }
}

// ── collapsing what was typed into the sentence the card quotes ──────────────

test('a fenced paste is dropped, the sentence around it kept', () => {
  const fenced = collapsePeekText('Fix the reducer.\n\n```ts\nconst x = 1\nconst y = 2\n```\n\nThat is all.')
  assert.ok(!fenced.text.includes('const x'), `fenced block survived: ${fenced.text}`)
  assert.ok(fenced.text.startsWith('Fix the reducer.'), fenced.text)
  assert.ok(fenced.text.endsWith('That is all.'), fenced.text)

  // A path inside a fence is part of the paste and goes with it.
  assert.equal(collapsePeekText('Look:\n```\nsrc/main/secret.ts\n```').text, 'Look:')
})

test('a huge paste is collapsed at the head and counted', () => {
  // Five megabytes are not run through half a dozen regexes in full on a hover.
  const huge = collapsePeekText(`Take a look.\n${'z'.repeat(MAX_COLLAPSE_INPUT_CHARS * 2)}`)
  assert.equal(huge.overflowChars, MAX_COLLAPSE_INPUT_CHARS + 'Take a look.\n'.length)
  assert.ok(huge.text.startsWith('Take a look.'), huge.text.slice(0, 40))
})

test('paths in a sentence shorten to their names; a path on its own line is dropped', () => {
  const dropped = collapsePeekText(
    'Read `design-system/USAGE.md` and conform.\n/home/dev/projects/sprintengine/src/main/app.ts\n@src/renderer/App.tsx',
  )
  assert.equal(dropped.text, 'Read USAGE.md and conform.', dropped.text)

  // A whole typed message naming several paths, inline and bare. Substituting
  // a bare space for each path rendered it as "attached at ; read USAGE.md + +
  // and conform", which reads as though the app corrupted what was written.
  const real = collapsePeekText(
    'Take a look at the reference repo on GitHub first.\n\n' +
      'A design system is attached at `design-system/`; read `USAGE.md` + `foundations/tokens.css`' +
      ' + `components/` and conform — do not invent styles.',
  )
  assert.equal(
    real.text,
    'Take a look at the reference repo on GitHub first.\n\n' +
      'A design system is attached at design-system; read USAGE.md + tokens.css + components' +
      ' and conform — do not invent styles.',
  )
})

test('prose, inline code and URLs that are not paths stay as written', () => {
  assert.ok(collapsePeekText('Decide whether it is and/or, then tell me.').text.includes('and/or'))
  assert.equal(collapsePeekText('Set `MAX_PEEK_MESSAGES` to fifty.').text, 'Set MAX_PEEK_MESSAGES to fifty.')
  assert.ok(
    collapsePeekText('Compare against https://example.com/a/b/c.png please.').text.includes(
      'https://example.com/a/b/c.png',
    ),
  )
})

test('an image placeholder is removed from the quote', () => {
  const placeholder = collapsePeekText('[Image #26] What happened? You removed the backdrops.')
  assert.equal(placeholder.text, 'What happened? You removed the backdrops.')
})

test('the cap breaks on a word and counts every character it removed', () => {
  assert.deepEqual(capPeekText('short enough', 400), { text: 'short enough', truncatedChars: 0 })

  const body = `${'word '.repeat(120)}end`
  const capped = capPeekText(body, 100)
  assert.ok(capped.text.length <= 100, String(capped.text.length))
  assert.equal(capped.text.length + capped.truncatedChars, body.length)
  assert.ok(!capped.text.endsWith(' '), capped.text)
  assert.ok(!capped.text.includes('…'), 'the ellipsis belongs to the renderer, next to the count')

  // One long token has no word boundary to break on; the hard cut still counts.
  const hard = capPeekText('x'.repeat(500), 100)
  assert.equal(hard.text.length, 100)
  assert.equal(hard.truncatedChars, 400)
})

// ── the captured-prompt list ─────────────────────────────────────────────────

test('the prompt list keeps the first message and the newest ones', () => {
  let prompts = appendLivePeekPrompt(undefined, 'first', 1)
  for (let index = 1; index < MAX_LIVE_PEEK_PROMPTS + 20; index += 1) {
    prompts = appendLivePeekPrompt(prompts, `message ${index}`, index + 1)
  }
  assert.equal(prompts.length, MAX_LIVE_PEEK_PROMPTS)
  assert.equal(prompts[0]?.text, 'first', 'the message that started the chat is never trimmed away')
  assert.equal(prompts[prompts.length - 1]?.text, `message ${MAX_LIVE_PEEK_PROMPTS + 19}`)
})

// ── the service ──────────────────────────────────────────────────────────────

test('captured prompts are the answer, collapsed and capped', async () => {
  const { service } = serviceFor({
    chat: {
      reportsMessages: true,
      prompts: [
        { text: 'Have a look at the reasoning picker', at: 1 },
        { text: '```\npasted\n```', at: 2 },
        { text: 'Now do the other one', at: 3 },
      ],
    },
  })
  const peek: ConversationPeek = await service.readConversationPeek('chat')
  assert.equal(peek.source, 'live')
  assert.equal(peek.sessionId, 'chat')
  assert.equal(peek.first?.text, 'Have a look at the reasoning picker')
  // The pasted-only prompt collapses to nothing and is dropped rather than
  // rendered as an empty row.
  assert.deepEqual(
    peek.since.map((message) => message.text),
    ['Now do the other one'],
  )
  assert.deepEqual(Object.keys(peek).sort(), ['first', 'sessionId', 'since', 'source'], 'text only, no images')
})

test('the first message and the thread take their own caps', async () => {
  const long = 'word '.repeat(1_000)
  const { service } = serviceFor({
    chat: {
      reportsMessages: true,
      prompts: [
        { text: long, at: 1 },
        { text: long, at: 2 },
      ],
    },
  })
  const peek = await service.readConversationPeek('chat')
  assert.ok(peek.first && peek.first.text.length <= MAX_PEEK_FIRST_CHARS)
  assert.ok(peek.first.truncatedChars > 0)
  assert.ok(peek.since[0] && peek.since[0].text.length <= MAX_PEEK_MESSAGE_CHARS)
})

test('the thread carries at most the newest messages after the first', async () => {
  const prompts = Array.from({ length: MAX_PEEK_MESSAGES + 10 }, (_, index) => ({ text: `m${index}`, at: index }))
  const { service } = serviceFor({ chat: { reportsMessages: true, prompts } })
  const peek = await service.readConversationPeek('chat')
  assert.equal(peek.first?.text, 'm0')
  assert.equal(peek.since.length, MAX_PEEK_MESSAGES)
  assert.equal(peek.since.at(-1)?.text, `m${MAX_PEEK_MESSAGES + 9}`)
})

test('a runtime that reports prompts but has none yet is live and empty, not none', async () => {
  // A brand-new Claude Code chat hovered before its first prompt used to be
  // told its runtime could not report messages.
  const { service } = serviceFor({
    fresh: { reportsMessages: true, prompts: [] },
    opencode: { reportsMessages: false, prompts: [] },
  })
  const fresh = await service.readConversationPeek('fresh')
  assert.equal(fresh.source, 'live')
  assert.equal(fresh.first, null)
  assert.deepEqual(fresh.since, [])

  const opencode = await service.readConversationPeek('opencode')
  assert.equal(opencode.source, 'none', 'only a runtime that cannot report at all is `none`')
})

test('no record of a session is unknown, never none', async () => {
  const { service, reads } = serviceFor({})
  const unknown = await service.readConversationPeek('no-such-session')
  assert.equal(unknown.source, 'unknown')
  assert.equal(unknown.sessionId, 'no-such-session')
  assert.deepEqual(reads, ['no-such-session'])

  const blank = await service.readConversationPeek('')
  assert.equal(blank.source, 'unknown')
  assert.deepEqual(reads, ['no-such-session'], 'an empty id is not looked up')
})

test('a conversation peek reads its persisted first message and last exchange', async () => {
  const event = (id: string, type: ConversationEvent['type'], text?: string): ConversationEvent => ({
    id,
    sessionId: 'conversation-1',
    workspaceId: 'workspace-1',
    agentId: 'agent-1',
    providerId: 'provider-1',
    modelId: 'model-1',
    type,
    createdAt: Number(id),
    ...(text ? { payload: { text } } : {}),
  })
  let terminalReads = 0
  const service = createConversationPeekService({
    readSessionState: async () => {
      terminalReads += 1
      return null
    },
    readConversationEvents: async (sessionId) =>
      sessionId === 'conversation-1'
        ? [
            event('1', 'user_message', 'First request'),
            event('2', 'content_delta', 'First answer'),
            event('3', 'turn_completed'),
            event('4', 'user_message', 'Follow up'),
            event('5', 'content_delta', 'Final answer'),
            event('6', 'turn_completed'),
          ]
        : null,
  })
  const peek = await service.readConversationPeek('conversation-1')
  assert.equal(peek.source, 'live')
  assert.equal(peek.first?.text, 'First request')
  assert.deepEqual(
    peek.since.map((message) => message.text),
    ['Follow up', 'Final answer'],
  )
  assert.equal(terminalReads, 0)
})

// ── the IPC boundary ─────────────────────────────────────────────────────────

test('the IPC reads by session id, answers a malformed payload as unknown, and opens nothing', async () => {
  const handlers = new Map<string, (event: unknown, payload: unknown) => unknown>()
  const calls: string[] = []
  registerConversationPeekIpc(
    {
      handle: (channel: string, handler: (event: unknown, payload: unknown) => unknown) =>
        handlers.set(channel, handler),
    } as unknown as Parameters<typeof registerConversationPeekIpc>[0],
    {
      readConversationPeek: async (sessionId) => {
        calls.push(`read:${sessionId}`)
        return { sessionId, source: 'none', first: null, since: [] }
      },
    },
  )

  assert.deepEqual([...handlers.keys()], ['conversation-peek:read'])
  const read = handlers.get('conversation-peek:read')
  assert.ok(read)
  assert.equal(((await read({}, 'session-1')) as ConversationPeek).sessionId, 'session-1')

  // A hover must never surface an error.
  assert.equal(((await read({}, 42)) as ConversationPeek).source, 'unknown')
  assert.equal(((await read({}, 'a'.repeat(600))) as ConversationPeek).source, 'unknown')
  assert.equal(((await read({}, 'a\u0000b')) as ConversationPeek).source, 'unknown')
  assert.deepEqual(calls, ['read:session-1'], 'no malformed payload reached the service')
})

test('a quote in a message reads as its passage and comment, never as its address', () => {
  const token = quoteToken({
    turnId: 't1',
    n: 1,
    quote: 'Keep the cache warm.',
    exact: 'Keep the cache warm.',
    prefix: '',
    suffix: '',
    comment: 'Still true?',
  })
  const text = collapsePeekText(`Is this right? ${token} Thanks.`).text
  assert.equal(text.includes('sprintengine-quote'), false)
  assert.match(text, /Is this right\? “Keep the cache warm\.” \(Still true\?\) Thanks\./)
})
