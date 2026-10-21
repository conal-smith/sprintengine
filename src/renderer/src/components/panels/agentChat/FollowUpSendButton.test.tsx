// @vitest-environment jsdom
import React, { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, expect, test, vi } from 'vitest'

import { followUpSendPresentation } from './followUpDispatch'
import { FollowUpSendButton } from './FollowUpSendButton'

let root: Root
let host: HTMLDivElement
const sends: boolean[] = []

beforeEach(() => {
  ;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true
  vi.useFakeTimers()
  sends.length = 0
  host = document.createElement('div')
  document.body.append(host)
  root = createRoot(host)
  const presentation = followUpSendPresentation({
    behavior: 'queue',
    canSteer: true,
    sendNowAvailable: true,
    clickModifier: 'Cmd',
    shortcutLabel: 'Cmd+Enter',
  })
  act(() =>
    root.render(
      <FollowUpSendButton
        presentation={presentation}
        platform="darwin"
        disabled={false}
        onSend={(alternate) => sends.push(alternate)}
      />,
    ),
  )
})

afterEach(() => {
  act(() => root.unmount())
  host.remove()
  vi.useRealTimers()
})

const button = () => host.querySelector('button')!
const tooltip = () => document.querySelector('[role="tooltip"]')?.textContent ?? null
const key = (type: 'keydown' | 'keyup', metaKey: boolean) =>
  act(() => {
    window.dispatchEvent(new KeyboardEvent(type, { key: 'Meta', metaKey }))
  })

test('the button names what a click does, and the other with the key held', () => {
  expect(button().getAttribute('aria-label')).toBe('Queue message')
  key('keydown', true)
  expect(button().getAttribute('aria-label')).toBe('Steer message')
  key('keyup', false)
  expect(button().getAttribute('aria-label')).toBe('Queue message')
})

test('an open tooltip follows the held key', () => {
  act(() => {
    button().dispatchEvent(new MouseEvent('mouseover', { bubbles: true }))
    vi.advanceTimersByTime(500)
  })
  expect(tooltip()).toBe('Click to queue, Cmd-click or Cmd+Enter to steer')
  key('keydown', true)
  expect(tooltip()).toBe('Cmd-click to steer, or let go of Cmd to queue')
  key('keyup', false)
  expect(tooltip()).toBe('Click to queue, Cmd-click or Cmd+Enter to steer')
})

test('a Primary-click sends as the alternate, a plain click as the choice', () => {
  act(() => button().dispatchEvent(new MouseEvent('click', { bubbles: true })))
  act(() => button().dispatchEvent(new MouseEvent('click', { bubbles: true, metaKey: true })))
  expect(sends).toEqual([false, true])
})

test('leaving the window with the key down lets it go', () => {
  key('keydown', true)
  act(() => {
    window.dispatchEvent(new Event('blur'))
  })
  expect(button().getAttribute('aria-label')).toBe('Queue message')
})
