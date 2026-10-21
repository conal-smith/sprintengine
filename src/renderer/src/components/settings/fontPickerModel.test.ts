import { expect, test } from 'vitest'

import { DEFAULT_FONT_OPTION_KEY, fontPickerOptions, selectedFontOptionKey } from './fontPickerModel'

const FAMILIES = ['Fira Code', 'Fira Sans', 'Iosevka', 'Source Code Pro']

test('with nothing typed, Default leads the whole list', () => {
  expect(fontPickerOptions(FAMILIES, '').map((option) => option.key)).toEqual([
    DEFAULT_FONT_OPTION_KEY,
    'family:Fira Code',
    'family:Fira Sans',
    'family:Iosevka',
    'family:Source Code Pro',
  ])
})

test('a query narrows the families and drops Default', () => {
  expect(fontPickerOptions(FAMILIES, 'code').map((option) => option.key)).toEqual([
    'family:Fira Code',
    'family:Source Code Pro',
    'typed:code',
  ])
})

test('a name the list does not hold is offered as typed, last', () => {
  const options = fontPickerOptions(FAMILIES, 'Berkeley Mono')
  expect(options).toEqual([{ key: 'typed:Berkeley Mono', kind: 'typed', family: 'Berkeley Mono' }])
})

test('a name the list holds exactly is not offered twice', () => {
  expect(fontPickerOptions(FAMILIES, 'iosevka').map((option) => option.key)).toEqual(['family:Iosevka'])
})

test('a typed name is cleaned before it is offered', () => {
  expect(fontPickerOptions([], ' Fira"; Code ')).toEqual([
    { key: 'typed:Fira Code', kind: 'typed', family: 'Fira Code' },
  ])
})

test('without a family list, the picker is Default and whatever is typed', () => {
  expect(fontPickerOptions([], '').map((option) => option.key)).toEqual([DEFAULT_FONT_OPTION_KEY])
  expect(fontPickerOptions([], 'Inter').map((option) => option.key)).toEqual(['typed:Inter'])
})

test('typing the bundled face offers Default first, never as a typed name', () => {
  const families = ['SignPainter', 'Inter Display']
  expect(fontPickerOptions(families, 'Inter', 'Inter').map((option) => option.key)).toEqual([
    DEFAULT_FONT_OPTION_KEY,
    'family:Inter Display',
    'family:SignPainter',
  ])
  expect(fontPickerOptions(families, 'int', 'Inter')[0].key).toBe(DEFAULT_FONT_OPTION_KEY)
  expect(fontPickerOptions(families, 'sign', 'Inter').map((option) => option.key)).toEqual([
    'family:SignPainter',
    'typed:sign',
  ])
})

test('the stored value names the row that carries the check', () => {
  expect(selectedFontOptionKey('')).toBe(DEFAULT_FONT_OPTION_KEY)
  expect(selectedFontOptionKey(' Iosevka ')).toBe('family:Iosevka')
})
