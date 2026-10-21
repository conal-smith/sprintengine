import { JSDOM } from 'jsdom'
import { expect, test } from 'vitest'

import { replayGuestFocusAsPress } from './guestPress'

// A click into the guest, as the host document sees it: the `<webview>`
// becomes the active element and the window blurs. Nothing else arrives.
function page() {
  const dom = new JSDOM(
    '<!doctype html><html><body><div id="menu"></div><webview tabindex="0"></webview><input></body></html>',
  )
  const { document } = dom.window
  const guest = document.querySelector('webview') as HTMLElement
  const heard: string[] = []
  // How every menu in the app listens for a press outside itself.
  for (const type of ['pointerdown', 'mousedown']) {
    dom.window.addEventListener(type, (event) => {
      if (!document.getElementById('menu')?.contains(event.target as Node)) heard.push(`${type} outside`)
    })
  }
  const focusLeavesFor = (element: HTMLElement) => {
    element.focus()
    dom.window.dispatchEvent(new dom.window.FocusEvent('blur'))
  }
  return { guest, heard, focusLeavesFor, field: document.querySelector('input') as HTMLElement }
}

test('a click into the page is heard as a press outside any open menu', () => {
  const { guest, heard, focusLeavesFor } = page()
  replayGuestFocusAsPress(guest)
  focusLeavesFor(guest)
  expect(heard).toEqual(['pointerdown outside', 'mousedown outside'])
})

test('the window losing focus with anything else active is not a press', () => {
  const { guest, heard, focusLeavesFor, field } = page()
  replayGuestFocusAsPress(guest)
  focusLeavesFor(field)
  expect(heard).toEqual([])
})

test('no press is replayed once the tab lets go of the page', () => {
  const { guest, heard, focusLeavesFor } = page()
  const release = replayGuestFocusAsPress(guest)
  release()
  focusLeavesFor(guest)
  expect(heard).toEqual([])
})
