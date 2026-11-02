import { expect, test } from 'vitest'
import { quoteToken } from '../../../shared/chat-quotes'
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

test('a frame with no quote in it is passed on as the same object', () => {
  const frame = { events: [{ type: 'user_message', payload: { text: 'plain' } }, { type: 'content_delta' }] }
  expect(quotesForWire(frame)).toBe(frame)
  // Only a person's message is read: a reply that echoes a token is the agent's words.
  const reply = { type: 'content_delta', payload: { text: token } }
  expect(quotesForWire(reply)).toBe(reply)
})
