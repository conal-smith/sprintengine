import { expect, test } from 'vitest'

import {
  chatFindQuery,
  chatFindSegments,
  chatFindStatus,
  findInChat,
  firstMatchFrom,
  foldForFind,
  markdownSearchText,
  reconcileMatch,
  stepMatch,
} from './chatFind'
import type { ConversationTimelineRow } from './conversationTimeline'

type Row<K extends ConversationTimelineRow['kind']> = Extract<ConversationTimelineRow, { kind: K }>

function user(id: string, text: string, origin?: 'studio'): Row<'user'> {
  return {
    kind: 'user',
    id: `user:${id}`,
    entry: { kind: 'user', id, text, ...(origin ? { origin: { kind: origin } } : {}) } as Row<'user'>['entry'],
  }
}

function reply(turnId: string, text: string, plans: { requestId: string; plan: string }[] = []): Row<'assistant'> {
  return {
    kind: 'assistant',
    id: `assistant:${turnId}`,
    entry: { kind: 'assistant', turnId, text, reasoning: '', status: 'complete' },
    tools: [],
    decisions: plans.map(({ requestId, plan }) => ({
      kind: 'decision' as const,
      id: `approval:${requestId}`,
      entry: { kind: 'approval', requestId, summary: 'Plan', status: 'approved', requestKind: 'plan', plan },
    })),
  }
}

const query = (text: string) => chatFindQuery(text)

test('markdown is searched as the page draws it', () => {
  expect(markdownSearchText('Use **bold** and _em_ and `code_span`')).toBe('Use bold and em and code_span')
  expect(markdownSearchText('See [the docs](https://example.com/a) and ![a chart](chart.png)')).toBe(
    'See the docs and a chart',
  )
  expect(markdownSearchText('## Heading ##\n> quoted\n- item one\n1. item two\n- [x] done')).toBe(
    'Heading\nquoted\nitem one\nitem two\ndone',
  )
  // Words with an underscore or a star in them are text, not emphasis.
  expect(markdownSearchText('snake_case_name and 2 * 3')).toBe('snake_case_name and 2 * 3')
  // Escaped markup is the character it escapes.
  expect(markdownSearchText('a \\*literal\\* star')).toBe('a *literal* star')
  // A fence keeps its code verbatim and drops its markers.
  expect(markdownSearchText('```ts\nconst **x** = 1\n```\nafter')).toBe('const **x** = 1\nafter')
  expect(markdownSearchText('| a | b |\n|---|---|\n| 1 | 2 |')).toBe('  a   b  \n\n  1   2  ')
})

test('folding ignores case and collapses whitespace without changing what is matched', () => {
  expect(foldForFind('  Hello\n\n  World  ')).toBe('hello world')
  // A character whose lowercase is longer stays as it is, so offsets line up.
  expect(foldForFind('İstanbul').length).toBe('İstanbul'.length)
  expect(chatFindQuery('   ')).toBe('')
})

test('matches are found across rows in reading order, plans before the reply that follows them', () => {
  const rows: ConversationTimelineRow[] = [
    user('u1', 'Where is the **config** loaded?'),
    reply('t1', 'The config lives in `/Users/dev/app/config.ts`.', [
      { requestId: 'r1', plan: '# Config plan\n\nMove the config loader.' },
    ]),
    user('u2', 'Thanks'),
    reply('t2', 'Config done.'),
  ]
  const results = findInChat(rows, query('CONFIG'))
  expect(results.capped).toBe(false)
  expect(results.matches.map((match) => `${match.rowIndex}:${match.segment}:${match.ordinal}`)).toEqual([
    '0:user:u1:0',
    '1:plan:r1:0',
    '1:plan:r1:1',
    '1:reply:t1:0',
    '1:reply:t1:1',
    '3:reply:t2:0',
  ])
})

test("Studio's own notices, steps and reasoning are not searched", () => {
  const notice = user('n1', 'Studio: the agent finished', 'studio')
  const turn: Row<'assistant'> = {
    ...reply('t1', 'final words'),
    entry: {
      kind: 'assistant',
      turnId: 't1',
      text: 'final words',
      reasoning: 'secret thinking',
      intermediateText: [{ text: 'between steps', beforeToolUseId: 'tool-1' }],
      status: 'complete',
    },
  }
  expect(chatFindSegments(notice)).toEqual([])
  expect(findInChat([notice, turn], query('agent finished')).matches).toEqual([])
  expect(findInChat([turn], query('thinking')).matches).toEqual([])
  expect(findInChat([turn], query('between')).matches).toEqual([])
  expect(findInChat([turn], query('final')).matches).toHaveLength(1)
})

test('a plan is searched as its card shows it: the title once, then the body', () => {
  const [segment] = chatFindSegments(reply('t1', '', [{ requestId: 'r1', plan: '# Ship it\n\n1. Build\n2. Test' }]))
  expect(segment).toEqual({ key: 'plan:r1', text: 'ship it build test' })
})

test('a follow-up Codex suggests is searched as its label, not the prompt behind it', () => {
  const [segment] = chatFindSegments(
    reply('t1', '- :codex-followup[Prepare print version]{prompt="Make a print-ready version of the report"}'),
  )
  expect(segment).toEqual({ key: 'reply:t1', text: 'prepare print version' })
})

test('the count stops at the cap and says there were more', () => {
  const rows = [reply('t1', 'x '.repeat(30)), reply('t2', 'x '.repeat(30))]
  const capped = findInChat(rows, query('x'), 40)
  expect(capped.matches).toHaveLength(40)
  expect(capped.capped).toBe(true)
  expect(chatFindStatus('x', 4, capped)).toBe('5 of 40+')
  const exact = findInChat(rows, query('x'), 60)
  expect(exact.matches).toHaveLength(60)
  expect(exact.capped).toBe(false)
})

test('a new search starts at the first match at or below the top of the view, wrapping', () => {
  const rows = [user('a', 'match'), user('b', 'none'), user('c', 'match'), user('d', 'none')]
  const { matches } = findInChat(rows, query('match'))
  expect(firstMatchFrom(matches, 0)).toBe(0)
  expect(firstMatchFrom(matches, 1)).toBe(1)
  expect(firstMatchFrom(matches, 2)).toBe(1)
  // Nothing at or below the view: back to the first match of all.
  expect(firstMatchFrom(matches, 3)).toBe(0)
  expect(firstMatchFrom([], 0)).toBe(-1)
})

test('stepping wraps at both ends', () => {
  expect(stepMatch(0, 3, 1)).toBe(1)
  expect(stepMatch(2, 3, 1)).toBe(0)
  expect(stepMatch(0, 3, -1)).toBe(2)
  expect(stepMatch(-1, 3, 1)).toBe(0)
  expect(stepMatch(-1, 3, -1)).toBe(2)
  expect(stepMatch(0, 0, 1)).toBe(-1)
})

test('a recount keeps the reader on the match they were on', () => {
  const before = [user('u1', 'deploy'), reply('t1', 'deploy now, deploy')]
  const first = findInChat(before, query('deploy'))
  const current = first.matches[2]!
  expect(current).toMatchObject({ segment: 'reply:t1', ordinal: 1 })

  // The reply streams on and a page of history loads above: every index
  // moves, the match does not.
  const after = [user('u0', 'deploy first'), ...before.slice(0, 1), reply('t1', 'deploy now, deploy, and deploy')]
  const second = findInChat(after, query('deploy'))
  const kept = reconcileMatch(current, 2, second.matches)
  expect(second.matches[kept]).toMatchObject({ segment: 'reply:t1', ordinal: 1, rowIndex: 2 })

  // The occurrence is gone (the text was rewritten): the nearest one left in
  // its segment.
  const rewritten = findInChat([before[0]!, reply('t1', 'deploy')], query('deploy'))
  expect(rewritten.matches[reconcileMatch(current, 2, rewritten.matches)]).toMatchObject({
    segment: 'reply:t1',
    ordinal: 0,
  })

  // The segment is gone: the same position, held inside the list.
  const gone = findInChat([before[0]!], query('deploy'))
  expect(reconcileMatch(current, 2, gone.matches)).toBe(0)
  expect(reconcileMatch(current, 2, [])).toBe(-1)
})

test('the count reads as a find bar says it', () => {
  const results = findInChat([user('a', 'one two one')], query('one'))
  expect(chatFindStatus('', 0, results)).toBe('')
  expect(chatFindStatus('one', 1, results)).toBe('2 of 2')
  expect(chatFindStatus('one', -1, results)).toBe('2')
  expect(chatFindStatus('zzz', -1, findInChat([user('a', 'one')], query('zzz')))).toBe('No results')
})

test('a row that has not changed is not read again', () => {
  const row = user('u1', 'cached text')
  expect(chatFindSegments(row)).toBe(chatFindSegments(row))
})

test('a link is read as its innermost bracket, as the page draws it', () => {
  expect(markdownSearchText('[a [b](https://example.com/b) c')).toBe('[a b c')
  expect(markdownSearchText('[ref][1] and [a [ref][2]')).toBe('ref and [a ref')
})

test('a long line of brackets that never close is read in one pass', () => {
  // A pasted test log: every colour code opens a bracket and none closes.
  const log = '\x1b[32m PASS \x1b[39m src/a.test.ts '.repeat(12_000)
  const unclosed = '[x](https://example.com/'.repeat(12_000)
  const started = performance.now()
  expect(markdownSearchText(log)).toBe(log)
  expect(markdownSearchText(unclosed)).toBe(unclosed)
  expect(performance.now() - started).toBeLessThan(1_000)
})
