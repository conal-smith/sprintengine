import { expect, test } from 'vitest'

import { isLetterKey } from './keyboard'

test('a letter typed on a Latin layout is that letter', () => {
  expect(isLetterKey({ key: 's', code: 'KeyS' }, 's')).toBe(true)
  expect(isLetterKey({ key: 'S', code: 'KeyS' }, 's')).toBe(true)
})

test('the key in the letter’s place on a Cyrillic layout is that letter', () => {
  expect(isLetterKey({ key: 'ы', code: 'KeyS' }, 's')).toBe(true)
  expect(isLetterKey({ key: 'ф', code: 'KeyA' }, 'a')).toBe(true)
})

test('the key in the letter’s place on a Greek layout is that letter', () => {
  expect(isLetterKey({ key: 'σ', code: 'KeyS' }, 's')).toBe(true)
  expect(isLetterKey({ key: 'α', code: 'KeyA' }, 'a')).toBe(true)
})

test('a layout that moves the letter is read by the character it types', () => {
  // AZERTY prints A on the key a QWERTY board calls Q.
  expect(isLetterKey({ key: 'a', code: 'KeyQ' }, 'a')).toBe(true)
  expect(isLetterKey({ key: 'q', code: 'KeyA' }, 'a')).toBe(false)
})

test('another key is not the letter', () => {
  expect(isLetterKey({ key: 'd', code: 'KeyD' }, 's')).toBe(false)
  expect(isLetterKey({ key: 'в', code: 'KeyD' }, 's')).toBe(false)
})
