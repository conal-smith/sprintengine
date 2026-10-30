import { expect, test } from 'vitest'
import { SEALED_VISUAL_CHANNEL } from '../../../../shared/sealed-visual'
import {
  clampVisualHeight,
  externalVisualLink,
  LINK_OPEN_COOLDOWN_MS,
  linkToOpen,
  readSealedVisualMessage,
  type LinkGate,
} from './sealedVisualMessages'

const channel = SEALED_VISUAL_CHANNEL

test('only the two messages a sealed visual may send are read', () => {
  expect(readSealedVisualMessage({ channel, type: 'height', height: 240 })).toEqual({ type: 'height', height: 240 })
  expect(readSealedVisualMessage({ channel, type: 'open-link', href: 'https://example.com/' })).toEqual({
    type: 'open-link',
    href: 'https://example.com/',
  })
  for (const wrong of [
    null,
    'height',
    42,
    { type: 'height', height: 240 },
    { channel: 'other', type: 'height', height: 240 },
    { channel, type: 'height', height: '240' },
    { channel, type: 'height', height: Number.NaN },
    { channel, type: 'height', height: Number.POSITIVE_INFINITY },
    { channel, type: 'open-link', href: 42 },
    { channel, type: 'open-link', href: '' },
    { channel, type: 'open-link', href: `https://example.com/${'a'.repeat(2048)}` },
    { channel, type: 'theme', variables: {} },
    { channel, type: 'eval', code: 'alert(1)' },
  ])
    expect(readSealedVisualMessage(wrong), JSON.stringify(wrong) ?? String(wrong)).toBeNull()
})

test('a reported height is rounded up and held to the cap', () => {
  expect(clampVisualHeight(120.2, 900)).toBe(121)
  expect(clampVisualHeight(5_000_000, 900)).toBe(900)
  expect(clampVisualHeight(0, 900)).toBeNull()
  expect(clampVisualHeight(-40, 900)).toBeNull()
  expect(clampVisualHeight(Number.NaN, 900)).toBeNull()
})

test('only a web address, without credentials, is ever handed out', () => {
  expect(externalVisualLink('https://example.com/a?b=1')).toBe('https://example.com/a?b=1')
  expect(externalVisualLink('http://example.com')).toBe('http://example.com/')
  for (const refused of [
    'javascript:alert(1)',
    'file:///Users/dev/.ssh/id_rsa',
    'data:text/html,<p>x</p>',
    'sprintengine://chat/abc',
    'vscode://file/x',
    'mailto:dev@example.com',
    'https://user:secret@example.com/',
    '/relative/path',
    '#section',
  ])
    expect(externalVisualLink(refused), refused).toBeNull()
})

function gate(overrides: Partial<LinkGate> = {}): LinkGate {
  const frame = {} as HTMLIFrameElement
  return {
    frame,
    document: { activeElement: frame as unknown as Element },
    userActivation: { isActive: true },
    now: 10_000,
    lastOpenedAt: null,
    ...overrides,
  }
}

test('a link opens only just after a click inside its own frame', () => {
  expect(linkToOpen('https://example.com/', gate())).toBe('https://example.com/')
  // No activation: the script asked on its own.
  expect(linkToOpen('https://example.com/', gate({ userActivation: { isActive: false } }))).toBeNull()
  // A browser that cannot say: nothing opens.
  expect(linkToOpen('https://example.com/', gate({ userActivation: undefined }))).toBeNull()
  // The click was somewhere else in the app (the focus is not on this frame).
  expect(linkToOpen('https://example.com/', gate({ document: { activeElement: null } }))).toBeNull()
  // A scheme outside the allowlist, even after a click.
  expect(linkToOpen('javascript:alert(1)', gate())).toBeNull()
})

test('one click opens one link, not a burst', () => {
  expect(linkToOpen('https://example.com/', gate({ lastOpenedAt: 10_000 - 10 }))).toBeNull()
  expect(linkToOpen('https://example.com/', gate({ lastOpenedAt: 10_000 - LINK_OPEN_COOLDOWN_MS }))).toBe(
    'https://example.com/',
  )
})
