// @vitest-environment jsdom
import { expect, test, vi } from 'vitest'
import { openAltClickedLink } from './altClickLinks'

function link(href: string, target = '_blank'): HTMLElement {
  document.body.innerHTML = `<p><a href="${href}" target="${target}"><span>the docs</span></a></p>`
  return document.querySelector('span')!
}

const click = (init: MouseEventInit) => new MouseEvent('click', { bubbles: true, cancelable: true, ...init })

test('an Option-click on a web link opens it in the browser instead of saving it', () => {
  const open = vi.fn()
  const event = click({ altKey: true })
  link('https://example.com/docs').dispatchEvent(event)
  expect(openAltClickedLink(event, open)).toBe(true)
  expect(open).toHaveBeenCalledWith('https://example.com/docs')
  expect(event.defaultPrevented).toBe(true)
})

test('a mail link is opened the same way', () => {
  const open = vi.fn()
  const event = click({ altKey: true })
  link('mailto:dev@example.com').dispatchEvent(event)
  expect(openAltClickedLink(event, open)).toBe(true)
  expect(open).toHaveBeenCalledWith('mailto:dev@example.com')
})

test('a plain click is left to the browser handler it always reached', () => {
  const open = vi.fn()
  const event = click({})
  link('https://example.com/docs').dispatchEvent(event)
  expect(openAltClickedLink(event, open)).toBe(false)
  expect(open).not.toHaveBeenCalled()
  expect(event.defaultPrevented).toBe(false)
})

test('links the app does not send to the browser, and handled clicks, are left alone', () => {
  const open = vi.fn()
  const inPage = click({ altKey: true })
  link('#section', '_self').dispatchEvent(inPage)
  expect(openAltClickedLink(inPage, open)).toBe(false)
  const file = click({ altKey: true })
  link('file:///Users/dev/notes.md').dispatchEvent(file)
  expect(openAltClickedLink(file, open)).toBe(false)
  const handled = click({ altKey: true })
  handled.preventDefault()
  link('https://example.com/docs').dispatchEvent(handled)
  expect(openAltClickedLink(handled, open)).toBe(false)
  const secondary = click({ altKey: true, button: 1 })
  link('https://example.com/docs').dispatchEvent(secondary)
  expect(openAltClickedLink(secondary, open)).toBe(false)
  expect(open).not.toHaveBeenCalled()
})
