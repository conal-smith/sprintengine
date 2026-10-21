// @vitest-environment jsdom
import { afterEach, expect, test } from 'vitest'
import { paletteBackdropIsConversation } from './paletteBackdrop'

afterEach(() => {
  document.body.innerHTML = ''
})

// jsdom lays nothing out, so "drawn" is stood in for the way Chromium answers
// it: `checkVisibility`, false for an element that is display:none or inside one.
function pane(attribute: string, drawn = true): HTMLElement {
  const element = document.createElement('div')
  element.setAttribute(attribute, '')
  Object.assign(element, { checkVisibility: () => drawn })
  document.body.append(element)
  return element
}

test('a conversation with no terminal in view is blurred behind', () => {
  pane('data-chat-pane')
  expect(paletteBackdropIsConversation()).toBe(true)
})

test('a terminal in view keeps the plain scrim, even beside a conversation', () => {
  pane('data-chat-pane')
  pane('data-terminal-surface')
  expect(paletteBackdropIsConversation()).toBe(false)
})

test('a terminal in a background tab does not count, and nothing drawn is not a conversation', () => {
  pane('data-terminal-surface', false)
  expect(paletteBackdropIsConversation()).toBe(false)
  pane('data-chat-pane')
  expect(paletteBackdropIsConversation()).toBe(true)
  document.body.innerHTML = ''
  pane('data-chat-pane', false)
  expect(paletteBackdropIsConversation()).toBe(false)
})
