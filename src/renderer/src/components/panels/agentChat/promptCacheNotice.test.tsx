// @vitest-environment jsdom
import React, { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, expect, test } from 'vitest'

import type { PromptCacheReading } from '../../../../../shared/prompt-cache'
import { handoffTooltip, PromptCacheComposerNotice } from './promptCacheNotice'

// The cache notice above the composer: cold, Handoff is the default and
// Compact a deliberate choice in its menu, saying what it re-reads; still
// warm, Compact is the one action; either way the × sets it aside.

let root: Root
let host: HTMLDivElement
let calls: string[]

beforeEach(() => {
  ;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true
  calls = []
  host = document.createElement('div')
  document.body.append(host)
  root = createRoot(host)
})

afterEach(() => {
  act(() => root.unmount())
  host.remove()
  document.body.innerHTML = ''
})

const cold: PromptCacheReading = { ttl: '5m', expiresAt: Date.now() - 3 * 24 * 60 * 60_000, recacheTokens: 221_000 }
const expiring: PromptCacheReading = { ttl: '5m', expiresAt: Date.now() + 60_000, recacheTokens: 221_000 }

function render(reading: PromptCacheReading, handoff = true) {
  act(() =>
    root.render(
      <PromptCacheComposerNotice
        reading={reading}
        busy={false}
        onCompact={() => calls.push('compact')}
        onHandoff={handoff ? () => calls.push('handoff') : undefined}
      />,
    ),
  )
}

const buttons = () => Array.from(host.querySelectorAll('button'))
const named = (name: string) => buttons().find((button) => button.getAttribute('aria-label') === name)
const labelled = (text: string) => buttons().find((button) => button.textContent?.trim() === text)

test('a cold cache offers Handoff first, with Compact in its menu saying what it re-reads', () => {
  render(cold)
  expect(host.textContent).toContain('~221k tokens uncached')
  const handoff = named('Hand off to a new session')
  expect(handoff?.textContent).toBe('Handoff')
  // No plain Compact beside it, and no "Not now".
  expect(labelled('Compact')).toBeUndefined()
  expect(host.textContent).not.toContain('Not now')
  act(() => handoff!.click())
  expect(calls).toEqual(['handoff'])

  act(() => named('Other ways to make the next message smaller')!.click())
  const compact = Array.from(document.querySelectorAll('[role="menuitem"]')).find((item) =>
    item.textContent?.includes('Compact'),
  ) as HTMLElement | undefined
  expect(compact?.textContent).toContain('Re-reads ~221k tokens uncached')
  act(() => compact!.click())
  expect(calls).toEqual(['handoff', 'compact'])
})

test('Handoff says what it does on hover, with the real count', () => {
  expect(handoffTooltip(221_000)).toBe(
    'Start a fresh agent session instead of re-reading ~221k tokens uncached. Studio saves this chat’s messages (no tool calls) to a file and points the new session at it with your next message. Your history here stays; a divider marks the handoff.',
  )
})

test('a cache still warm offers the plain Compact', () => {
  render(expiring)
  expect(host.textContent).toContain('~221k tokens cached')
  expect(named('Hand off to a new session')).toBeUndefined()
  act(() => labelled('Compact')!.click())
  expect(calls).toEqual(['compact'])
})

test('a chat that cannot hand off is offered Compact even when cold', () => {
  render(cold, false)
  expect(named('Hand off to a new session')).toBeUndefined()
  expect(labelled('Compact')).toBeDefined()
})

test('the × sets the notice aside', () => {
  render(cold)
  act(() => named('Dismiss')!.click())
  expect(host.textContent).toBe('')
})
