import { expect, test } from 'vitest'

import type { ConversationTimelineRow } from './conversationTimeline'
import { withRequestedTurn, type RequestedTurnRowCache } from './requestedTurnRow'

const user: ConversationTimelineRow = {
  kind: 'user',
  id: 'user:one',
  entry: { kind: 'user', id: 'one', text: 'fix the login', createdAt: 1_000 },
} as ConversationTimelineRow
const working = (startedAt: number): ConversationTimelineRow => ({
  kind: 'working',
  id: 'working-indicator-row',
  stage: 'thinking',
  label: 'Thinking…',
  startedAt,
})

test('a message being sent has a working line under it before the agent says anything', () => {
  const cache = { current: null as RequestedTurnRowCache }
  const rows = withRequestedTurn([user], 900, true, cache)
  expect(rows.at(-1)).toMatchObject({
    kind: 'working',
    id: 'working-indicator-row',
    label: 'Thinking…',
    startedAt: 900,
  })
  expect(withRequestedTurn([user], 900, true, cache).at(-1), 'the same row while nothing changes').toBe(rows.at(-1))
})

test('no line under a message that is not being sent', () => {
  const cache = { current: null as RequestedTurnRowCache }
  expect(withRequestedTurn([user], 900, false, cache)).toEqual([user])
  expect(withRequestedTurn([user], null, true, cache)).toEqual([user])
})

test('the turn’s own line counts on from when it was asked for', () => {
  const cache = { current: null as RequestedTurnRowCache }
  const own = working(4_000)
  const rows = withRequestedTurn([user, own], 900, false, cache)
  expect(rows.at(-1)).toMatchObject({ id: 'working-indicator-row', startedAt: 900 })
  expect(withRequestedTurn([user, own], 900, false, cache).at(-1)).toBe(rows.at(-1))
  // A line that began earlier than the request is not this request's.
  expect(withRequestedTurn([user, working(500)], 900, false, cache).at(-1)).toMatchObject({ startedAt: 500 })
})
