import { expect, test } from 'vitest'

import { isProjectIconSetting, normalizeMonogramText, normalizeProjectIcons, suggestedMonogram } from './project-icon'

test('the suggested monogram is the same for the same name, every time', () => {
  expect(suggestedMonogram('my-app')).toBe('MA')
  expect(suggestedMonogram('notes')).toBe('N')
  expect(suggestedMonogram('design_system v2')).toBe('DS')
  expect(suggestedMonogram('___')).toBe('?')
  expect(suggestedMonogram('my-app')).toBe(suggestedMonogram('my-app'))
})

test('monogram text is at most two characters, upper-cased, without spaces', () => {
  expect(normalizeMonogramText(' a b c ')).toBe('AB')
  expect(normalizeMonogramText('é')).toBe('É')
})

test('only well-formed overrides survive a settings read', () => {
  expect(isProjectIconSetting({ kind: 'file', path: '/Users/dev/art/mark.svg' })).toBe(true)
  expect(isProjectIconSetting({ kind: 'file', path: '' })).toBe(false)
  expect(isProjectIconSetting({ kind: 'monogram', text: 'MA', hue: 255 })).toBe(true)
  expect(isProjectIconSetting({ kind: 'monogram', text: 'abc', hue: 255 })).toBe(false)
  expect(isProjectIconSetting({ kind: 'monogram', text: 'MA', hue: 'blue' })).toBe(false)
  expect(isProjectIconSetting({ kind: 'emoji', text: 'x' })).toBe(false)

  expect(
    normalizeProjectIcons({
      '/users/dev/app': { kind: 'monogram', text: 'MA', hue: 255 },
      '/users/dev/site': { kind: 'file', path: '/Users/dev/art/mark.svg', extra: true },
      '/users/dev/bad': { kind: 'file' },
      '': { kind: 'monogram', text: 'X', hue: 25 },
    }),
  ).toEqual({
    '/users/dev/app': { kind: 'monogram', text: 'MA', hue: 255 },
    '/users/dev/site': { kind: 'file', path: '/Users/dev/art/mark.svg' },
  })
  expect(normalizeProjectIcons(['x'])).toEqual({})
})
