// @vitest-environment jsdom
import React, { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, expect, test, vi } from 'vitest'

import type { Workspace } from '../../../types/workspace'
import { CHAT_JUMP_HINT_DELAY_MS } from './chatJumpHints'
import { ChatJumpHint } from './rowParts'
import { useChatJumpHints } from './useChatJumpHints'

const workspaces = ['ws-a', 'ws-b', 'ws-c'].map((id) => ({ id, name: id }) as Workspace)
const renders = new Map<string, number>()

// A row the way the sidebar draws one: memoized, with its hint read inside it.
// Each row sits in a profiler, which counts every commit inside it — the row's
// own and its hint's.
const Row = React.memo(function Row({ rowKey, id }: { rowKey: string; id: string }) {
  return (
    <React.Profiler id={rowKey} onRender={() => renders.set(rowKey, (renders.get(rowKey) ?? 0) + 1)}>
      <div role="treeitem" data-row-key={rowKey} data-workspace-id={id}>
        <ChatJumpHint rowKey={rowKey} />
      </div>
    </React.Profiler>
  )
})

function Sidebar({ keybindings }: { keybindings?: { overrides?: Record<string, string[]> } }) {
  useChatJumpHints({ enabled: true, workspaces, keybindings, platform: 'linux' })
  return (
    <nav role="tree" data-workspace-tree>
      <Row rowKey="starred-ws-c" id="ws-c" />
      <Row rowKey="ws-a" id="ws-a" />
      <Row rowKey="ws-b" id="ws-b" />
      <Row rowKey="ws-c" id="ws-c" />
    </nav>
  )
}

let root: Root
let host: HTMLDivElement

function mount(element: React.ReactElement): void {
  act(() => root.render(element))
}

const press = (type: 'keydown' | 'keyup', key: string, ctrlKey: boolean) =>
  act(() => {
    window.dispatchEvent(new KeyboardEvent(type, { key, ctrlKey }))
  })
const hold = (ms: number) =>
  act(() => {
    vi.advanceTimersByTime(ms)
  })
const hints = () =>
  Object.fromEntries(
    Array.from(host.querySelectorAll<HTMLElement>('[role="treeitem"]')).flatMap((row) => {
      const hint = row.querySelector<HTMLElement>('[data-chat-jump-hint]')
      return hint ? [[row.dataset.rowKey, hint.dataset.chatJumpHint?.toLowerCase()]] : []
    }),
  )

beforeEach(() => {
  ;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true
  vi.useFakeTimers()
  renders.clear()
  host = document.createElement('div')
  document.body.append(host)
  root = createRoot(host)
})

afterEach(() => {
  act(() => root.unmount())
  host.remove()
  vi.useRealTimers()
})

test('holding Ctrl labels each numbered row with the chord that opens it', () => {
  mount(<Sidebar />)
  press('keydown', 'Control', true)
  hold(CHAT_JUMP_HINT_DELAY_MS)
  // The starred row carries ws-c's number; its second row under the project does not.
  expect(hints()).toEqual({ 'starred-ws-c': 'primary+1', 'ws-a': 'primary+2', 'ws-b': 'primary+3' })
  expect(host.querySelector('[data-chat-jump-hint] kbd')?.textContent).toBe('Ctrl')
  press('keyup', 'Control', false)
  expect(hints()).toEqual({})
})

test('a rebound command shows the chord it is bound to', () => {
  mount(<Sidebar keybindings={{ overrides: { 'workspace.switch.2': ['Primary+Shift+2'] } }} />)
  press('keydown', 'Control', true)
  hold(CHAT_JUMP_HINT_DELAY_MS)
  expect(hints()['ws-a']).toBe('primary+shift+2')
})

test('Ctrl+C on the way never flashes the hints', () => {
  mount(<Sidebar />)
  press('keydown', 'Control', true)
  press('keydown', 'c', true)
  hold(CHAT_JUMP_HINT_DELAY_MS * 3)
  expect(hints()).toEqual({})
})

test('the window losing focus puts them away', () => {
  mount(<Sidebar />)
  press('keydown', 'Control', true)
  hold(CHAT_JUMP_HINT_DELAY_MS)
  act(() => {
    window.dispatchEvent(new Event('blur'))
  })
  expect(hints()).toEqual({})
})

test('only the rows that carry a hint re-render, and a held key’s repeat re-renders none', () => {
  mount(<Sidebar />)
  const before = new Map(renders)
  press('keydown', 'Control', true)
  hold(CHAT_JUMP_HINT_DELAY_MS)
  press('keydown', 'Control', true)
  press('keydown', 'Control', true)
  const rerendered = [...renders].filter(([rowKey, count]) => count !== before.get(rowKey)).map(([rowKey]) => rowKey)
  expect(rerendered).toEqual(['starred-ws-c', 'ws-a', 'ws-b'])
  for (const rowKey of rerendered) expect(renders.get(rowKey)).toBe((before.get(rowKey) ?? 0) + 1)
})
