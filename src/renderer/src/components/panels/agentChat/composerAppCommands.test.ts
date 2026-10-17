import { expect, test } from 'vitest'

import { composerAppCommand } from './composerAppCommands'

const chat = {
  cli: 'claude-code',
  models: [
    { id: 'sonnet', label: 'Sonnet' },
    { id: 'opus', label: 'Opus' },
  ],
  efforts: ['low', 'medium', 'high'],
  attachments: 0,
}

test('/model opens the picker, or selects a model it names exactly', () => {
  expect(composerAppCommand('/model', chat)).toEqual({ kind: 'model' })
  expect(composerAppCommand('/model sonnet', chat)).toEqual({ kind: 'model', model: 'sonnet' })
  expect(composerAppCommand(' /model Opus ', chat)).toEqual({ kind: 'model', model: 'opus' })
  // A name that is not one of the chat's models opens the picker instead of reaching the CLI.
  expect(composerAppCommand('/model gpt', chat)).toEqual({ kind: 'model' })
})

test('/effort steps, sets a named level, or says which levels there are', () => {
  expect(composerAppCommand('/effort', chat)).toEqual({ kind: 'effort' })
  expect(composerAppCommand('/effort HIGH', chat)).toEqual({ kind: 'effort', effort: 'high' })
  expect(composerAppCommand('/effort ludicrous', chat)).toEqual({
    kind: 'refuse',
    notice: 'Effort is one of low, medium, high.',
  })
  // A chat with no effort control leaves `/effort` to the CLI.
  expect(composerAppCommand('/effort high', { ...chat, efforts: [] })).toBeNull()
})

test('/clear, /reset and /new are not sent, and say where a fresh conversation starts', () => {
  for (const text of ['/clear', '/reset', '/new now']) {
    const action = composerAppCommand(text, chat)
    expect(action?.kind, text).toBe('refuse')
    expect(action && 'notice' in action ? action.notice : '').toMatch(/Start a new chat/)
  }
})

test('Codex’s /compact is refused with anything riding along, and sent on its own', () => {
  const codex = { ...chat, cli: 'codex' }
  expect(composerAppCommand('/compact', codex)).toBeNull()
  expect(composerAppCommand('/compact\nfocus on the parser', codex)?.kind).toBe('refuse')
  expect(composerAppCommand('/compact', { ...codex, attachments: 1 })?.kind).toBe('refuse')
  // Claude Code's /compact takes instructions.
  expect(composerAppCommand('/compact keep the API notes', chat)).toBeNull()
})

test('prose, other commands and a chat with no CLI are sent as typed', () => {
  expect(composerAppCommand('model the data first', chat)).toBeNull()
  expect(composerAppCommand('/review 12', chat)).toBeNull()
  expect(composerAppCommand('/Users/dev/app', chat)).toBeNull()
  expect(composerAppCommand('/model', { ...chat, cli: null })).toBeNull()
})

test('/btw asks a side question where the chat answers them, and is the CLI’s elsewhere', () => {
  const answers = { ...chat, sideQuestion: true }
  expect(composerAppCommand('/btw which file is the parser in?', answers)).toEqual({
    kind: 'sideQuestion',
    question: 'which file is the parser in?',
  })
  expect(composerAppCommand('/btw', answers)).toEqual({ kind: 'sideQuestion' })
  expect(composerAppCommand('/BTW why?', answers)).toEqual({ kind: 'sideQuestion', question: 'why?' })
  expect(composerAppCommand('/btw why?', { ...answers, attachments: 1 })).toEqual({
    kind: 'refuse',
    notice: 'A side question takes words only. Remove the attachments to ask it.',
  })
  expect(composerAppCommand('/btw why?', chat)).toBeNull()
})
