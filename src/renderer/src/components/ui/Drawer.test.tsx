// @vitest-environment jsdom
import React, { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, expect, test, vi } from 'vitest'

import { Drawer } from './Drawer'

let root: Root | null = null
let host: HTMLElement | null = null

beforeEach(() => {
  ;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true
  vi.useFakeTimers()
  host = document.createElement('div')
  document.body.appendChild(host)
  root = createRoot(host)
})

afterEach(async () => {
  await act(async () => root?.unmount())
  host?.remove()
  root = null
  host = null
  vi.useRealTimers()
})

async function render(open: boolean, body: string): Promise<void> {
  await act(async () => {
    root!.render(
      <Drawer open={open} onClose={() => {}} title="Side question" ariaLabel="Side question about this chat">
        <Drawer.Body>{body}</Drawer.Body>
      </Drawer>,
    )
  })
}

const panel = () => document.querySelector<HTMLElement>('[role="dialog"]')

// A consumer clears what the drawer shows in the same update that closes it.
// The slide out has to keep drawing what was there, not the cleared state.
test('a closing drawer keeps the content it had open until the exit lands', async () => {
  await render(true, 'The answer so far')
  await act(async () => vi.advanceTimersByTime(50))
  expect(panel()?.dataset.state).toBe('open')

  await render(false, 'Ask about this chat')
  expect(panel()?.dataset.state).toBe('closing')
  expect(panel()?.textContent).toContain('The answer so far')
  expect(panel()?.textContent).not.toContain('Ask about this chat')

  await act(async () => vi.advanceTimersByTime(320))
  expect(panel()).toBeNull()
  expect(host!.innerHTML).toBe('')
})

test('opened again before the exit lands, the drawer shows what it is given now', async () => {
  await render(true, 'First question')
  await act(async () => vi.advanceTimersByTime(50))
  await render(false, '')
  await render(true, 'Second question')
  expect(panel()?.dataset.state).toBe('open')
  expect(panel()?.textContent).toContain('Second question')

  // What changes while it is open is drawn live, and that is what an exit keeps.
  await render(true, 'Second question, answered')
  await render(false, '')
  expect(panel()?.textContent).toContain('Second question, answered')
})
