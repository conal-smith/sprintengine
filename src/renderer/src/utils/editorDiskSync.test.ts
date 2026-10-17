import assert from 'node:assert/strict'
import { test } from 'vitest'

import { applyDiskContentToEditor, changedSpan, classifyDiskChange, oneAtATime, readFileOnDisk } from './editorDiskSync'

test('the tab’s own save reads as in sync', () => {
  assert.equal(classifyDiskChange({ disk: 'b', buffer: 'b', baseline: 'b', dirty: false }), 'in-sync')
  assert.equal(classifyDiskChange({ disk: 'b', buffer: 'b', baseline: 'a', dirty: true }), 'in-sync')
})

test('a clean buffer reloads whatever disk now holds', () => {
  assert.equal(classifyDiskChange({ disk: 'agent', buffer: 'old', baseline: 'old', dirty: false }), 'reload')
  assert.equal(classifyDiskChange({ disk: 'agent', buffer: 'old', baseline: undefined, dirty: false }), 'reload')
})

test('a dirty buffer is left alone while disk still holds the baseline', () => {
  assert.equal(classifyDiskChange({ disk: 'saved', buffer: 'typing', baseline: 'saved', dirty: true }), 'unchanged')
})

test('a dirty buffer whose file moved on disk is a conflict', () => {
  assert.equal(classifyDiskChange({ disk: 'agent', buffer: 'mine', baseline: 'old', dirty: true }), 'conflict')
  assert.equal(classifyDiskChange({ disk: 'agent', buffer: 'mine', baseline: undefined, dirty: true }), 'conflict')
})

test('the changed span covers only what differs', () => {
  assert.equal(changedSpan('same', 'same'), null)
  assert.deepEqual(changedSpan('abcdef', 'abXdef'), { start: 2, currentEnd: 3, nextEnd: 3 })
  assert.deepEqual(changedSpan('abc', 'abcabc'), { start: 3, currentEnd: 3, nextEnd: 6 })
  assert.deepEqual(changedSpan('aaaa', 'aa'), { start: 2, currentEnd: 4, nextEnd: 2 })
})

test('the changed span never cuts a CRLF or a surrogate pair', () => {
  // "a\r\n" → "a\r\r\n": a naive prefix stops between \r and \n.
  const crlf = changedSpan('a\r\nb', 'a\r\r\nb')
  assert.ok(crlf)
  assert.notEqual(crlf.start, 2, 'not between \\r and \\n')
  const smile = '\u{1F600}'
  const wink = '\u{1F609}'
  const pair = changedSpan(`x${smile}y`, `x${wink}y`)
  assert.deepEqual(pair, { start: 1, currentEnd: 3, nextEnd: 3 }, 'the whole emoji, both halves')
})

test('a reload is one undoable edit, and keeps the scroll', () => {
  let text = 'one\ntwo\nthree\n'
  let scrollTop = 120
  const stack: string[] = []
  const editor = {
    getModel: () => ({
      getValue: () => text,
      getPositionAt: (offset: number) => {
        const lines = text.slice(0, offset).split('\n')
        return { lineNumber: lines.length, column: lines[lines.length - 1].length + 1 }
      },
      pushStackElement: () => stack.push('stop'),
      pushEditOperations: (
        _selections: unknown,
        edits: Array<{ range: { startLineNumber: number; startColumn: number }; text: string }>,
      ) => {
        stack.push(`edit ${edits[0].range.startLineNumber}:${edits[0].range.startColumn} ${edits[0].text}`)
        text = 'one\n2\nthree\n'
        scrollTop = 0
        return null
      },
    }),
    getSelections: () => null,
    getScrollTop: () => scrollTop,
    getScrollLeft: () => 0,
    setScrollTop: (value: number) => {
      scrollTop = value
    },
    setScrollLeft: () => {},
  }
  assert.equal(applyDiskContentToEditor(editor as never, 'one\n2\nthree\n'), true)
  assert.deepEqual(stack, ['stop', 'edit 2:1 2', 'stop'])
  assert.equal(scrollTop, 120)
  assert.equal(applyDiskContentToEditor(editor as never, 'one\n2\nthree\n'), false, 'nothing to do the second time')
})

test('a read tells a deleted file from one that is only unreadable', async () => {
  const gone = await readFileOnDisk(
    { readfile: async () => Promise.reject(new Error('ENOENT')), pathExists: async () => false },
    '/Users/dev/acme/a.ts',
  )
  assert.deepEqual(gone, { kind: 'missing' })
  const busy = await readFileOnDisk(
    { readfile: async () => Promise.reject(new Error('EBUSY')), pathExists: async () => true },
    '/Users/dev/acme/a.ts',
  )
  assert.deepEqual(busy, { kind: 'unreadable' })
  const read = await readFileOnDisk({ readfile: async () => 'text' }, '/Users/dev/acme/a.ts')
  assert.deepEqual(read, { kind: 'content', content: 'text' })
})

test('checks run one at a time, with one more after for anything asked meanwhile', async () => {
  let inFlight = 0
  let most = 0
  let runs = 0
  let release: (() => void) | null = null
  const check = oneAtATime(async () => {
    runs++
    inFlight++
    most = Math.max(most, inFlight)
    await new Promise<void>((resolve) => {
      release = resolve
    })
    inFlight--
  })
  check()
  check()
  check()
  await Promise.resolve()
  assert.equal(runs, 1)
  release!()
  await new Promise((resolve) => setTimeout(resolve, 0))
  assert.equal(runs, 2, 'the two asked while the first ran fold into one')
  release!()
  await new Promise((resolve) => setTimeout(resolve, 0))
  assert.equal(runs, 2)
  assert.equal(most, 1, 'never two at once')
})
