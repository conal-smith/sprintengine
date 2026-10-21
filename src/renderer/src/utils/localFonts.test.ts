import { afterEach, expect, test, vi } from 'vitest'

import { advancesAreEqual, familyNamesOf, filterFontFamilies } from './localFonts'

afterEach(() => {
  vi.unstubAllGlobals()
  vi.resetModules()
})

// The module keeps the list for the session, so each case reads a fresh copy.
const freshModule = () => import('./localFonts')

test('a family listed once per style is offered once, sorted as a person reads', () => {
  const fonts = [
    { family: 'Menlo' },
    { family: 'Fira Code' },
    { family: 'menlo sans' },
    { family: 'Fira Code' },
    { family: 'Avenir' },
  ]
  expect(familyNamesOf(fonts)).toEqual(['Avenir', 'Fira Code', 'Menlo', 'menlo sans'])
})

test('macOS’s private system faces are left out', () => {
  expect(familyNamesOf([{ family: '.SF NS Mono' }, { family: 'SF Mono' }, { family: '  ' }])).toEqual(['SF Mono'])
})

test('search matches anywhere in the name, ignoring case', () => {
  const families = ['Fira Code', 'Fira Sans', 'Source Code Pro', 'Inter']
  expect(filterFontFamilies(families, 'code')).toEqual(['Fira Code', 'Source Code Pro'])
  expect(filterFontFamilies(families, '  FIRA ')).toEqual(['Fira Code', 'Fira Sans'])
  expect(filterFontFamilies(families, '')).toBe(families)
})

test('the name typed comes first, then names that start with it, then a word that does', () => {
  const families = ['SignPainter', 'Avenir Next', 'Inter Display', 'Inter', 'Noto Sans Inter-ish']
  expect(filterFontFamilies(families, 'inter')).toEqual([
    'Inter',
    'Inter Display',
    'Noto Sans Inter-ish',
    'SignPainter',
  ])
  expect(filterFontFamilies(['Fira Mono', 'Menlo', 'Mono Lisa'], 'mono')).toEqual(['Mono Lisa', 'Fira Mono'])
})

test('equal advances are monospace, unequal ones are not, and an unmeasurable face is let through', () => {
  expect(advancesAreEqual([7.8, 7.8, 7.805])).toBe(true)
  expect(advancesAreEqual([3.1, 9.4, 7.8])).toBe(false)
  expect(advancesAreEqual([])).toBe(true)
  expect(advancesAreEqual([0, 0])).toBe(true)
})

test('the installed families are read once a session, however many pickers open', async () => {
  const queryLocalFonts = vi.fn(async () => [{ family: 'Iosevka' }, { family: 'Inter' }])
  vi.stubGlobal('window', { queryLocalFonts })
  const { loadInstalledFontFamilies } = await freshModule()
  const first = await loadInstalledFontFamilies()
  const second = await loadInstalledFontFamilies()
  expect(first).toEqual({ status: 'granted', families: ['Inter', 'Iosevka'] })
  expect(second).toBe(first)
  expect(queryLocalFonts).toHaveBeenCalledTimes(1)
})

test('an engine without the API answers that the list is unavailable', async () => {
  vi.stubGlobal('window', {})
  const { loadInstalledFontFamilies } = await freshModule()
  expect(await loadInstalledFontFamilies()).toEqual({ status: 'unavailable' })
})

test('a refused list is unavailable, and the next open asks again', async () => {
  const queryLocalFonts = vi
    .fn<() => Promise<{ family: string }[]>>()
    .mockRejectedValueOnce(new DOMException('denied', 'NotAllowedError'))
    .mockResolvedValueOnce([])
    .mockResolvedValueOnce([{ family: 'Inter' }])
  vi.stubGlobal('window', { queryLocalFonts })
  const { loadInstalledFontFamilies } = await freshModule()
  expect(await loadInstalledFontFamilies()).toEqual({ status: 'unavailable' })
  // An empty list is how a refusal can arrive too: no machine has no fonts.
  expect(await loadInstalledFontFamilies()).toEqual({ status: 'unavailable' })
  expect(await loadInstalledFontFamilies()).toEqual({ status: 'granted', families: ['Inter'] })
})

test('with no canvas to measure on, a named family is taken at its word', async () => {
  vi.stubGlobal('document', { createElement: () => ({ getContext: () => null }) })
  const { isFontFamilyAvailable, isMonospaceFamily } = await freshModule()
  expect(isFontFamilyAvailable('Anything')).toBe(true)
  expect(isFontFamilyAvailable('')).toBe(false)
  expect(isMonospaceFamily('Anything')).toBe(true)
})

test('a family is monospace when its glyphs measure alike', async () => {
  const context = {
    font: '',
    measureText(glyph: string) {
      // The proportional face draws an `i` narrower than an `M`.
      return { width: this.font.includes('"Avenir"') && glyph === 'i' ? 4 : 10 }
    },
  }
  vi.stubGlobal('document', { createElement: () => ({ getContext: () => context }) })
  const { isMonospaceFamily } = await freshModule()
  expect(isMonospaceFamily('Fira Code')).toBe(true)
  expect(isMonospaceFamily('Avenir')).toBe(false)
})

test('a family is installed when it measures differently from the generic behind it', async () => {
  const context = {
    font: '',
    measureText() {
      return { width: this.font.includes('"Iosevka"') ? 120 : 100 }
    },
  }
  vi.stubGlobal('document', { createElement: () => ({ getContext: () => context }) })
  const { isFontFamilyAvailable } = await freshModule()
  expect(isFontFamilyAvailable('Iosevka')).toBe(true)
  expect(isFontFamilyAvailable('Not A Real Font')).toBe(false)
})
