import { expect, test } from 'vitest'
import {
  bestConversationHit,
  matchSegments,
  shapeSnippet,
  snippetContains,
  snippetSpeaker,
  SNIPPET_LEAD_CHARS,
} from './conversationSnippet'

test('a snippet starts near its match, on a word, and says where it was cut', () => {
  const before = 'So we have a bunch of pull requests open and I think we should look at them first before'
  const shaped = shapeSnippet(`…${before} the wave model\n\nchanges land.…`, 'WAVE')!
  expect(shaped.startsWith('…')).toBe(true)
  expect(shaped.endsWith('…')).toBe(true)
  // The match sits within the lead, so it is on screen in a truncated line.
  expect(shaped.toLowerCase().indexOf('wave')).toBeLessThanOrEqual(SNIPPET_LEAD_CHARS + 2)
  // Whole words, one space between them.
  expect(shaped).toBe('…should look at them first before the wave model changes land.…')
})

test('a short message is shown whole, and a message without the query is no snippet at all', () => {
  expect(shapeSnippet('Is the wave model wired up?', 'wave')).toBe('Is the wave model wired up?')
  expect(shapeSnippet('You can use Opus subagents for this work.', 'wave')).toBeNull()
  expect(shapeSnippet('anything', '  ')).toBeNull()
})

test('every occurrence of the query is marked, whatever its case', () => {
  expect(matchSegments('Wave after wave', 'wave')).toEqual([
    { text: 'Wave', match: true },
    { text: ' after ', match: false },
    { text: 'wave', match: true },
  ])
  expect(matchSegments('no match here', 'wave')).toEqual([{ text: 'no match here', match: false }])
  expect(matchSegments('text', '')).toEqual([{ text: 'text', match: false }])
})

test('a kept row is still an answer only while its snippet holds the query', () => {
  expect(snippetContains('the wave model', 'wav')).toBe(true)
  expect(snippetContains('the wave model', 'waves')).toBe(false)
  expect(snippetContains('work', 'w')).toBe(true)
})

test('the message a chat shows is the person’s own, then the newest', () => {
  const hits = [
    { seq: 3, from: 'agent' as const },
    { seq: 9, from: 'person' as const },
    { seq: 2, from: 'person' as const },
    { seq: 40, from: 'studio' as const },
  ]
  expect(bestConversationHit(hits)).toEqual({ seq: 9, from: 'person' })
  expect(
    bestConversationHit([
      { seq: 3, from: 'agent' as const },
      { seq: 7, from: 'agent' as const },
    ])?.seq,
  ).toBe(7)
  // A host that predates `from` still gets a row.
  expect(bestConversationHit([{ seq: 1 }])).toEqual({ seq: 1 })
  expect(bestConversationHit([])).toBeNull()
  expect([snippetSpeaker('person'), snippetSpeaker('agent'), snippetSpeaker(undefined)]).toEqual(['You', 'Agent', null])
})
