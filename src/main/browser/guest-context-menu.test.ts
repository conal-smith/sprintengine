import assert from 'node:assert/strict'

import type { MenuItemConstructorOptions } from 'electron'
import { test } from 'vitest'

import { guestContextMenuTemplate } from './guest-context-menu'

const EDITABLE = { canCut: true, canCopy: true, canPaste: true, canSelectAll: true }
const READ_ONLY = { canCut: false, canCopy: true, canPaste: false, canSelectAll: true }
const PLAIN = {
  x: 12,
  y: 34,
  misspelledWord: '',
  dictionarySuggestions: [],
  linkURL: '',
  mediaType: 'none' as const,
  editFlags: { ...READ_ONLY, canUndo: false, canRedo: false, canDelete: false, canEditRichly: false },
}

function fakeTarget() {
  const calls: string[] = []
  return {
    calls,
    target: {
      replaceMisspelling: (word: string) => calls.push(`replace:${word}`),
      copyImageAt: (x: number, y: number) => calls.push(`image:${x},${y}`),
    },
  }
}

const shape = (items: MenuItemConstructorOptions[]) =>
  items.map((item) => item.role ?? item.label ?? item.type).join(' | ')

test('a page offers the edit commands its selection allows', () => {
  const { target } = fakeTarget()
  const items = guestContextMenuTemplate(PLAIN, target, () => {})
  assert.equal(shape(items), 'cut | copy | paste | selectAll')
  assert.deepEqual(
    items.map((item) => item.enabled),
    [false, true, false, true],
  )
})

test('a misspelt word in a field leads with its suggestions, which replace it', () => {
  const { target, calls } = fakeTarget()
  const items = guestContextMenuTemplate(
    {
      ...PLAIN,
      misspelledWord: 'helo',
      dictionarySuggestions: ['hello', 'help', 'hell', 'helot', 'halo', 'hero'],
      editFlags: { ...PLAIN.editFlags, ...EDITABLE },
    },
    target,
    () => {},
  )
  assert.equal(shape(items), 'hello | help | hell | helot | halo | separator | cut | copy | paste | selectAll')
  items[0]!.click!({} as never, undefined, {} as never)
  assert.deepEqual(calls, ['replace:hello'])

  const none = guestContextMenuTemplate({ ...PLAIN, misspelledWord: 'qzx' }, target, () => {})
  assert.equal(none[0]!.label, 'No Guesses Found')
  assert.equal(none[0]!.enabled, false)
})

test('an image and a web link can be copied', () => {
  const { target, calls } = fakeTarget()
  const copied: string[] = []
  const items = guestContextMenuTemplate(
    { ...PLAIN, mediaType: 'image', linkURL: 'https://example.com/a.png' },
    target,
    (text) => copied.push(text),
  )
  assert.equal(shape(items), 'Copy Image | Copy Link | separator | cut | copy | paste | selectAll')
  items[0]!.click!({} as never, undefined, {} as never)
  items[1]!.click!({} as never, undefined, {} as never)
  assert.deepEqual(calls, ['image:12,34'])
  assert.deepEqual(copied, ['https://example.com/a.png'])
})

test('a link that is not a web address is not offered for copying', () => {
  const { target } = fakeTarget()
  const items = guestContextMenuTemplate({ ...PLAIN, linkURL: 'javascript:alert(1)' }, target, () => {})
  assert.equal(shape(items), 'cut | copy | paste | selectAll')
})
