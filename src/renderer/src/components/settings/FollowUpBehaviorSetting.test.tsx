// @vitest-environment jsdom
import React, { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, expect, test } from 'vitest'

import { useWorkspaceStore } from '../../store/workspaceStore'
import { FollowUpBehaviorSetting } from './FollowUpBehaviorSetting'

let root: Root
let host: HTMLDivElement

beforeEach(() => {
  ;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true
  useWorkspaceStore.getState().setFollowUpBehavior('queue')
  host = document.createElement('div')
  document.body.append(host)
  root = createRoot(host)
  act(() => root.render(<FollowUpBehaviorSetting />))
})

afterEach(() => {
  act(() => root.unmount())
  host.remove()
})

const segment = (label: string) =>
  [...host.querySelectorAll<HTMLElement>('[role="radio"], button')].find((node) => node.textContent === label)!

test('the row offers Queue and Steer, and Queue is chosen on a new profile', () => {
  expect(host.textContent).toContain('When I send while an agent is working')
  expect(segment('Queue')).toBeTruthy()
  expect(segment('Steer')).toBeTruthy()
  expect(segment('Queue').getAttribute('aria-checked') ?? segment('Queue').getAttribute('aria-pressed')).toBe('true')
})

test('choosing Steer stores it', () => {
  act(() => segment('Steer').click())
  expect(useWorkspaceStore.getState().appSettings.followUpBehavior).toBe('steer')
})

test('the row names the chord that does the other for one message', () => {
  expect(host.textContent).toMatch(/does the other for one message/)
})
