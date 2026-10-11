import assert from 'node:assert/strict'

// The header's pane switch and the pane's own Close-pane control draw the same
// glyph and do the same thing, so only one of them is on screen at a time.
// Docked open, the pane's strip has the control and the switch steps aside;
// closed, the switch is the way back in; maximised, the strip drops its close
// and the switch takes it back (WorkspacePane.test.tsx covers the strip's half).
import { JSDOM } from 'jsdom'

import React, { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeAll, test } from 'vitest'

import type { Workspace, WorkspacePaneState } from '../../types/workspace'

const WS = 'ws-pane-switch'

let dom: JSDOM
let root: Root | null = null
let host: HTMLElement | null = null

beforeAll(() => {
  dom = new JSDOM('<!doctype html><html><body></body></html>', {
    url: 'http://localhost',
    pretendToBeVisual: true,
  })
  const anyGlobal = globalThis as unknown as Record<string, unknown>
  const domWindow = dom.window as unknown as Record<string, unknown>
  anyGlobal.window = domWindow
  anyGlobal.document = dom.window.document
  anyGlobal.navigator = dom.window.navigator
  anyGlobal.HTMLElement = dom.window.HTMLElement
  anyGlobal.HTMLButtonElement = dom.window.HTMLButtonElement
  anyGlobal.Node = dom.window.Node
  anyGlobal.MouseEvent = dom.window.MouseEvent
  anyGlobal.KeyboardEvent = dom.window.KeyboardEvent
  anyGlobal.CustomEvent = dom.window.CustomEvent
  anyGlobal.getComputedStyle = dom.window.getComputedStyle
  anyGlobal.localStorage = dom.window.localStorage
  anyGlobal.IS_REACT_ACT_ENVIRONMENT = true
  dom.window.matchMedia = ((q: string) => ({
    matches: false,
    media: q,
    addEventListener: () => {},
    removeEventListener: () => {},
    addListener: () => {},
    removeListener: () => {},
  })) as unknown as typeof dom.window.matchMedia
  domWindow.api = new Proxy({ platform: 'darwin' } as Record<string, unknown>, {
    get: (target, key: string) => (key in target ? target[key] : () => Promise.resolve(undefined)),
  })
})

afterEach(() => {
  if (root) act(() => root?.unmount())
  host?.remove()
  root = null
  host = null
})

async function renderSwitches(paneState: WorkspacePaneState, maximised: boolean): Promise<HTMLElement> {
  const { useWorkspaceStore } = await import('../../store/workspaceStore')
  useWorkspaceStore.setState({
    workspaces: [
      { id: WS, name: 'Switch', folderPath: '/Users/dev/switch', agents: {}, paneState } as unknown as Workspace,
    ],
    workspacePaneMaximised: maximised,
  })
  const { PanelSwitches } = await import('./PanelSwitches')
  host = dom.window.document.createElement('div')
  dom.window.document.body.appendChild(host)
  root = createRoot(host as unknown as Element)
  act(() => {
    root?.render(React.createElement(PanelSwitches, { activeWorkspaceId: WS, cluster: 'right' }))
  })
  return host
}

function paneSwitch(container: HTMLElement): HTMLButtonElement | null {
  return container.querySelector<HTMLButtonElement>('button[data-pane-switch]')
}

const FILES_TAB: WorkspacePaneState = { open: true, activeTabId: 't1', tabs: [{ id: 't1', kind: 'files' }] }

test('a closed pane keeps the header switch, which opens it', async () => {
  const container = await renderSwitches({ ...FILES_TAB, open: false }, false)
  const toggle = paneSwitch(container)
  assert.ok(toggle, 'closed, the switch is the way back in')
  assert.equal(toggle.getAttribute('aria-label'), 'Open pane')
  act(() => toggle.click())

  const { useWorkspaceStore } = await import('../../store/workspaceStore')
  const pane = useWorkspaceStore.getState().workspaces.find((workspace) => workspace.id === WS)?.paneState
  assert.equal(pane?.open, true, 'the click opened the pane')
  assert.equal(paneSwitch(container), null, 'once docked open, the switch steps aside for the strip’s own close')
})

test('a docked open pane leaves its close to the strip', async () => {
  const container = await renderSwitches(FILES_TAB, false)
  assert.equal(paneSwitch(container), null, 'one close-pane control on screen, and it is the strip’s')
})

test('a maximised pane gets the header switch back as its one close', async () => {
  const container = await renderSwitches(FILES_TAB, true)
  const toggle = paneSwitch(container)
  assert.ok(toggle, 'maximised, the strip has no close of its own')
  assert.equal(toggle.getAttribute('aria-label'), 'Close pane')
})
