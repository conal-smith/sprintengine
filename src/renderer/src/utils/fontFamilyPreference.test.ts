import { expect, test } from 'vitest'

import {
  FONT_FAMILY_PREFERENCE_MAX_LENGTH,
  cssFontFamilyList,
  fontStackFor,
  normalizeFontFamilyPreference,
} from './fontFamilyPreference'

const DEFAULT_STACK = '"JetBrains Mono", monospace'

test('a stored family keeps its name, with its white space folded', () => {
  expect(normalizeFontFamilyPreference('  IBM   Plex\tMono ')).toBe('IBM Plex Mono')
})

test('anything that is not a string is the default', () => {
  expect(normalizeFontFamilyPreference(undefined)).toBe('')
  expect(normalizeFontFamilyPreference(42)).toBe('')
  expect(normalizeFontFamilyPreference({ family: 'Inter' })).toBe('')
})

test('characters that could end a string, a declaration or a tag are dropped', () => {
  expect(normalizeFontFamilyPreference('Fira"; } html { background: url(x) } <b>')).toBe(
    'Fira html background: url(x) b',
  )
  expect(normalizeFontFamilyPreference("O'Brien\\22 Sans`")).toBe('OBrien22 Sans')
  expect(normalizeFontFamilyPreference('Line\nBreak\u0000Sans')).toBe('Line BreakSans')
})

test('a stored family is capped at its length', () => {
  expect(normalizeFontFamilyPreference('a'.repeat(FONT_FAMILY_PREFERENCE_MAX_LENGTH + 50))).toHaveLength(
    FONT_FAMILY_PREFERENCE_MAX_LENGTH,
  )
})

test('every name is quoted in the CSS list', () => {
  expect(cssFontFamilyList('Fira Code')).toBe('"Fira Code"')
  expect(cssFontFamilyList('Iosevka')).toBe('"Iosevka"')
})

test('a comma-separated preference is a list in the order typed', () => {
  expect(cssFontFamilyList('Fira Code, , Menlo')).toBe('"Fira Code", "Menlo"')
})

test('a generic family stays bare, or it would name a font nobody has', () => {
  expect(cssFontFamilyList('Fira Code, Monospace')).toBe('"Fira Code", monospace')
  expect(cssFontFamilyList('system-ui')).toBe('system-ui')
})

test('a quote typed around a name cannot break out of the quotes put around it', () => {
  expect(cssFontFamilyList('"Fira Code"')).toBe('"Fira Code"')
  expect(cssFontFamilyList('x"; color: red; "')).toBe('"x color: red"')
})

test('an empty or all-unsafe preference names nothing', () => {
  expect(cssFontFamilyList('')).toBeNull()
  expect(cssFontFamilyList(' ; {} <> ')).toBeNull()
  expect(cssFontFamilyList(' , ')).toBeNull()
})

test('the stack keeps the whole default behind the chosen family', () => {
  expect(fontStackFor('Fira Code', DEFAULT_STACK)).toBe(`"Fira Code", ${DEFAULT_STACK}`)
})

test('no choice is the default stack itself', () => {
  expect(fontStackFor('', DEFAULT_STACK)).toBe(DEFAULT_STACK)
  expect(fontStackFor('"";', DEFAULT_STACK)).toBe(DEFAULT_STACK)
})
