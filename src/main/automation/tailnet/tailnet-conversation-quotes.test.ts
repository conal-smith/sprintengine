import { expect, test } from 'vitest'
import { collectQuotes, quoteToken } from '../../../shared/chat-quotes'
import { quotesForWire, redactHostPaths } from './tailnet-conversation-stream'

// A quote rides in a message's text as a token the desktop keeps
// (shared/chat-quotes.ts). A device reads the message as words: older phones
// and paired Studios show `text` as the person's words alone.

const token = quoteToken({
  turnId: 'turn_1',
  n: 2,
  quote: 'Edit /Users/dev/proj/src/app.ts first.',
  exact: 'Edit src/app.ts first.',
  prefix: '',
  suffix: '',
  comment: 'Why this file?',
})

test("a message's quote leaves as its passage and comment, never as its token", () => {
  const frame = {
    type: 'event',
    event: { type: 'user_message', payload: { turnId: 't', text: `Look ${token} please` } },
  }
  const sent = quotesForWire(frame)
  expect(sent.event.payload.text).toBe(
    'Look\n\n> Edit /Users/dev/proj/src/app.ts first.\nComment: Why this file?\n\nplease',
  )
  expect(sent.event.payload.turnId).toBe('t')
  // The frame the stream was handed is not changed under it.
  expect(frame.event.payload.text).toContain('sprintengine-quote:')
})

test('a path inside a quoted passage is rewritten like any other once it is words', () => {
  const frame = quotesForWire({ events: [{ type: 'user_message', payload: { text: token } }] })
  const redacted = redactHostPaths(frame, { home: '/Users/dev', workspaceRoot: '/Users/dev/proj' })
  expect(redacted.events[0]!.payload.text).toContain('> Edit src/app.ts first.')
})

test('a frame with no quote in it is passed on as the same object, all the way down', () => {
  const frame = { events: [{ type: 'user_message', payload: { text: 'plain' } }, { type: 'content_delta' }] }
  expect(quotesForWire(frame)).toBe(frame)
  // A frame with one quoted message copies only the path to it.
  const delta = { type: 'content_delta', payload: { text: 'reply' } }
  const quoted = { type: 'user_message', payload: { text: token } }
  const mixed = { events: [delta, quoted], cursor: { seq: 4 } }
  const sent = quotesForWire(mixed)
  expect(sent).not.toBe(mixed)
  expect(sent.events[0]).toBe(delta)
  expect(sent.cursor).toBe(mixed.cursor)
  expect(sent.events[1]).not.toBe(quoted)
  // Only a person's message is read: a reply that echoes a token is the agent's words.
  const reply = { type: 'content_delta', payload: { text: token } }
  expect(quotesForWire(reply)).toBe(reply)
})

const rewrite = (words: string) => redactHostPaths(words, { home: '/Users/dev', workspaceRoot: '/Users/dev/proj' })

test('a held or scheduled message reads as words too, and a frame of them with no quote is left alone', () => {
  for (const type of ['queued', 'scheduled']) {
    const plain = { id: 'sm-1', text: 'Then the docs.', createdAt: 1 }
    const frame = {
      type,
      key: { workspaceId: 'w', agentId: 'a' },
      messages: [plain, { id: 'sm-2', text: `See ${token}`, createdAt: 2 }],
    }
    const sent = quotesForWire(frame)
    expect(sent.messages[0]).toBe(plain)
    expect(sent.messages[1]!.text).toBe('See\n\n> Edit /Users/dev/proj/src/app.ts first.\nComment: Why this file?')
    expect(sent.messages[1]!.id).toBe('sm-2')
    expect(frame.messages[1]!.text).toContain('sprintengine-quote:')
    const none = { type, key: frame.key, messages: [plain] }
    expect(quotesForWire(none)).toBe(none)
  }
})

test('for a client that reads tokens the token goes, and the words inside it are rewritten', () => {
  const sent = quotesForWire({ type: 'user_message', payload: { text: `Look ${token} please` } }, rewrite)
  const text = redactHostPaths(sent, { home: '/Users/dev', workspaceRoot: '/Users/dev/proj' }).payload.text
  const [quote] = collectQuotes(text)
  expect(text.startsWith('Look [Quote 2](sprintengine-quote:?')).toBe(true)
  expect(text.endsWith(') please')).toBe(true)
  expect(quote).toMatchObject({
    turnId: 'turn_1',
    n: 2,
    quote: 'Edit src/app.ts first.',
    exact: 'Edit src/app.ts first.',
    comment: 'Why this file?',
  })
  expect(text).not.toContain('Users')
  const held = { type: 'queued', messages: [{ id: 'sm-1', text: token, createdAt: 1 }] }
  expect(collectQuotes(quotesForWire(held, rewrite).messages[0]!.text)[0]?.quote).toBe('Edit src/app.ts first.')
})

test('context cut at its cap loses the word at the cut, which may be a stretch of a path', () => {
  const cut = quoteToken({
    turnId: 'turn_1',
    n: 1,
    quote: 'Keep it warm.',
    exact: 'Keep it warm.',
    prefix: 'sers/dev/proj/src/app.ts is the ',
    suffix: ' and see /Users/dev/proj/README.',
    comment: '',
  })
  const short = quoteToken({
    turnId: 'turn_1',
    n: 2,
    quote: 'Keep it warm.',
    exact: 'Keep it warm.',
    prefix: 'first file ',
    suffix: ' last word',
    comment: '',
  })
  const sent = quotesForWire({ type: 'user_message', payload: { text: `${cut} ${short}` } }, rewrite).payload.text
  const [first, second] = collectQuotes(sent)
  expect(first).toMatchObject({ prefix: 'is the ', suffix: ' and see' })
  // Context short of its cap reaches the edge of the reply: nothing was cut.
  expect(second).toMatchObject({ prefix: 'first file ', suffix: ' last word' })
})
