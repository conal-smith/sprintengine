// @vitest-environment jsdom
import React, { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, expect, test } from 'vitest'

import type { Workspace } from '../../../types/workspace'
import { autoCompactSwitchOf, WorkspaceContextMenu, type ContextMenuAction } from './contextMenus'

// The chat menu's Auto compact switch, beside Auto-settle: on by the chat's
// own choice or the app-wide default, off and saying why for a chat that is
// not Claude's, and absent for a row with no chat or a paired machine's.

let root: Root
let host: HTMLDivElement

beforeEach(() => {
  ;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true
  host = document.createElement('div')
  document.body.append(host)
  root = createRoot(host)
})

afterEach(() => {
  act(() => root.unmount())
  host.remove()
  document.body.innerHTML = ''
})

const chat = (providerId: string, overrides: Partial<Workspace> = {}) =>
  ({
    id: 'ws-1',
    name: 'Fix the parser',
    mode: 'standard',
    folderPath: '/Users/dev/parser',
    createdAt: 0,
    agents: { a1: { id: 'a1', runtimeKind: 'conversation', conversation: { providerId, modelId: 'default' } } },
    ...overrides,
  }) as unknown as Workspace

test('the switch follows the chat’s own choice, else the default, and knows a Claude chat', () => {
  expect(autoCompactSwitchOf(chat('claude-agent'), false)).toEqual({ on: false, claude: true })
  expect(autoCompactSwitchOf(chat('claude-agent'), true)).toEqual({ on: true, claude: true })
  expect(autoCompactSwitchOf(chat('claude-agent', { autoCompactEnabled: false }), true)).toEqual({
    on: false,
    claude: true,
  })
  expect(autoCompactSwitchOf(chat('codex-agent'), true)?.claude).toBe(false)
  expect(autoCompactSwitchOf(chat('claude-agent', { agents: {} } as Partial<Workspace>), true)).toBeNull()
  const remote = chat('claude-agent', { remoteOrigin: { connectionId: 'c', machineName: 'mac-mini' } } as never)
  expect(autoCompactSwitchOf(remote, true)).toBeNull()
})

function open(autoCompact: { on: boolean; claude: boolean }, picked: ContextMenuAction[]) {
  act(() =>
    root.render(
      <WorkspaceContextMenu
        x={0}
        y={0}
        workspace={chat('claude-agent')}
        moduleOverrides={{}}
        isDetachedWindow={false}
        now={0}
        working={false}
        autoCompact={autoCompact}
        onClose={() => undefined}
        onSelect={(action) => picked.push(action)}
        onPickColor={() => undefined}
      />,
    ),
  )
  return Array.from(document.querySelectorAll<HTMLButtonElement>('[data-menu-item="true"]')).find((item) =>
    item.textContent?.includes('Auto compact'),
  )
}

test('Auto compact sits right after Auto-settle and flips for a Claude chat', () => {
  const picked: ContextMenuAction[] = []
  const item = open({ on: true, claude: true }, picked)
  expect(item?.getAttribute('aria-checked')).toBe('true')
  expect(item?.getAttribute('data-menu-tooltip')).toBe('true')
  const rows = Array.from(document.querySelectorAll('[data-menu-item="true"]')).map((row) => row.textContent ?? '')
  const settleAt = rows.findIndex((text) => text.includes('Auto-settle'))
  expect(rows[settleAt + 1]).toContain('Auto compact')
  act(() => item!.click())
  expect(picked).toEqual(['toggle-auto-compact'])
})

test('a chat that is not Claude’s is offered it switched off, and says why', () => {
  const picked: ContextMenuAction[] = []
  const item = open({ on: false, claude: false }, picked)
  expect(item?.disabled).toBe(true)
  expect(item?.textContent).toContain('Claude only')
})
