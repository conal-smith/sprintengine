import { expect, test } from 'vitest'
import { withoutDeepLinks } from './deep-link-scheme'

test('a relaunch drops the link the app was opened with and keeps every other argument', () => {
  expect(
    withoutDeepLinks(['/app/path', '--no-sandbox', 'sprintengine://auth/callback?code=x', 'SprintEngine://chat/1']),
  ).toEqual(['/app/path', '--no-sandbox'])
  expect(withoutDeepLinks(['https://example.com', 'sprintengine-notes.md'])).toEqual([
    'https://example.com',
    'sprintengine-notes.md',
  ])
})
