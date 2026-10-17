import assert from 'node:assert/strict'

import { test } from 'vitest'

import { reuseUnchanged } from './reuseUnchanged'

test('an equal copy gives back the previous object', () => {
  const previous = { claude: { installed: true, version: '2.1.0', paths: ['/usr/local/bin/claude'] } }
  const next = structuredClone(previous)
  assert.equal(reuseUnchanged(previous, next), previous)
})

test('one entry moving replaces only that entry', () => {
  const previous = {
    claude: { installed: true, version: '2.1.0' },
    codex: { installed: false, version: null as string | null },
  }
  const next = { claude: { installed: true, version: '2.1.0' }, codex: { installed: true, version: '0.161.0' } }
  const merged = reuseUnchanged(previous, next)
  assert.notEqual(merged, previous)
  assert.equal(merged.claude, previous.claude)
  assert.deepEqual(merged.codex, next.codex)
})

test('a key added or removed is a change', () => {
  const previous: Record<string, number> = { a: 1, b: 2 }
  assert.deepEqual(reuseUnchanged(previous, { a: 1 }), { a: 1 })
  assert.deepEqual(reuseUnchanged(previous, { a: 1, b: 2, c: 3 }), { a: 1, b: 2, c: 3 })
  // A key whose value is undefined on one side only is still a difference.
  assert.notEqual(reuseUnchanged<Record<string, unknown>>({ a: 1 }, { a: 1, b: undefined }), undefined)
  assert.deepEqual(Object.keys(reuseUnchanged<Record<string, unknown>>({ a: 1 }, { a: 1, b: undefined })), ['a', 'b'])
})

test('arrays keep their unchanged entries and their own identity when equal', () => {
  const previous = [{ id: 'a' }, { id: 'b' }]
  assert.equal(reuseUnchanged(previous, [{ id: 'a' }, { id: 'b' }]), previous)
  const longer = reuseUnchanged(previous, [{ id: 'a' }, { id: 'b' }, { id: 'c' }])
  assert.notEqual(longer, previous)
  assert.equal(longer[0], previous[0])
  const reordered = reuseUnchanged(previous, [{ id: 'b' }, { id: 'a' }])
  assert.deepEqual(reordered, [{ id: 'b' }, { id: 'a' }])
})
