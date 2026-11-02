import assert from 'node:assert/strict'
import { test } from 'vitest'

import type { WorkspaceLifecycleResult } from '../../../../../shared/workspace-lifecycle'
import { followRestAnswer, mainAgreed, restRefusalToast } from './restGesture'

const committed = { settledAt: 1, settledOverride: 'settled' as const, snoozedUntil: null, activityAt: 0 }

async function follow(answer: WorkspaceLifecycleResult | null) {
  const done: string[] = []
  await followRestAnswer(Promise.resolve(answer), {
    agreed: () => done.push('put away and handed on'),
    refused: (refusal) => done.push(`refused: ${refusal.code}`),
  })
  return done
}

test('a Settle main refused, or could not be asked about, puts nothing away and hands nobody on', async () => {
  assert.deepEqual(await follow({ ok: false, code: 'stale', message: 'changed' }), ['refused: stale'])
  assert.deepEqual(await follow({ ok: false, code: 'working', message: 'busy' }), ['refused: working'])
  assert.deepEqual(
    await follow({ ok: false, code: 'unreachable', message: 'no answer' }),
    ['refused: unreachable'],
    'a main that could not be reached is a no, not a yes',
  )
})

test('main’s yes, no main at all, or no record left goes ahead', async () => {
  assert.deepEqual(await follow({ ok: true, workspaceId: 'w', committed }), ['put away and handed on'])
  assert.deepEqual(await follow({ ok: false, code: 'unavailable', message: 'none' }), ['put away and handed on'])
  assert.deepEqual(await follow(null), ['put away and handed on'])
  assert.equal(mainAgreed({ ok: false, code: 'unreachable', message: '' }), false)
})

test('a refusal says why, in the gesture’s words', () => {
  assert.equal(
    restRefusalToast('Fix login', 'settle', { ok: false, code: 'stale', message: '' }).title,
    'Fix login was not settled',
  )
  assert.equal(
    restRefusalToast('Fix login', 'settle', { ok: false, code: 'stale', message: '' }).description,
    'It changed just now. Look at it again.',
  )
  assert.equal(
    restRefusalToast('Fix login', 'snooze', { ok: false, code: 'working', message: '' }).title,
    'Fix login is still working',
  )
  assert.equal(
    restRefusalToast('Fix login', 'snooze', { ok: false, code: 'unreachable', message: 'Studio could not be reached.' })
      .description,
    'Studio could not be reached.',
  )
})
