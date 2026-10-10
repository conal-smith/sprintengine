import assert from 'node:assert/strict'

// A closed pane with a floating player: the column is zero wide but stays
// interactive (the player paints outside it and has to be dragged), so it is
// not `inert`, and the docked layers under it need their own mark for the
// idle-animation pause in assets/index.css. The floating layer is on screen
// and must not carry it.
import { JSDOM } from 'jsdom'

import React, { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeAll, test, vi } from 'vitest'

import type { Workspace, WorkspacePaneTab } from '../../../types/workspace'

vi.mock('./FloatingPlayer', () => ({
  FloatingPlayerChrome: () => null,
  useFloatRect: (_workspaceId: string, tab: WorkspacePaneTab | null) =>
    tab ? { left: 10, top: 10, width: 320, height: 200 } : null,
}))
vi.mock('./browser/BrowserTab', () => ({ BrowserTab: () => null }))
// A tab body that mounts is visible by its marker; a popped-out tab's must not
// mount at all, retained kind or not.
vi.mock('../../panels/PlainTerminalPanel', () => ({
  default: ({ terminalId }: { terminalId: string }) => React.createElement('div', { 'data-terminal-body': terminalId }),
}))

let dom: JSDOM
let root: Root | null = null
let host: HTMLElement | null = null

beforeAll(() => {
  dom = new JSDOM('<!doctype html><html><body></body></html>', { url: 'http://localhost', pretendToBeVisual: true })
  const anyGlobal = globalThis as unknown as Record<string, unknown>
  anyGlobal.window = dom.window
  anyGlobal.document = dom.window.document
  anyGlobal.navigator = dom.window.navigator
  anyGlobal.HTMLElement = dom.window.HTMLElement
  anyGlobal.Node = dom.window.Node
  anyGlobal.MouseEvent = dom.window.MouseEvent
  anyGlobal.IS_REACT_ACT_ENVIRONMENT = true
  ;(dom.window as unknown as Record<string, unknown>).api = new Proxy(
    { platform: 'darwin' } as Record<string, unknown>,
    {
      get: (target, key: string) => (key in target ? target[key] : () => Promise.resolve(undefined)),
    },
  )
})

afterEach(() => {
  if (root) act(() => root?.unmount())
  host?.remove()
  root = null
  host = null
})

const tabs: WorkspacePaneTab[] = [
  // A terminal tab with no terminal renders its unavailable note: a real
  // layer, with nothing lazy under it.
  { id: 'docked', kind: 'terminal' } as WorkspacePaneTab,
  { id: 'player', kind: 'browser', floating: true } as WorkspacePaneTab,
]

async function layers(collapsed: boolean): Promise<Map<string, Element>> {
  const { WorkspacePaneBody } = await import('./WorkspacePaneBody')
  host = dom.window.document.createElement('div')
  dom.window.document.body.appendChild(host)
  root = createRoot(host as unknown as Element)
  act(() => {
    root?.render(
      React.createElement(WorkspacePaneBody, {
        workspaceId: 'ws',
        tabs,
        activeTabId: 'player',
        selectedTabId: 'docked',
        collapsed,
      }),
    )
  })
  return new Map([...host.querySelectorAll('[role="tabpanel"]')].map((layer) => [layer.id, layer] as const))
}

test('a closed pane marks its docked layers still, and leaves the floating player running', async () => {
  const closed = await layers(true)
  assert.equal(closed.get('pane-ws-panel-docked')?.hasAttribute('data-pane-collapsed'), true)
  assert.equal(closed.get('pane-ws-panel-player')?.hasAttribute('data-pane-collapsed'), false)
  assert.equal(closed.get('pane-ws-panel-docked')?.hasAttribute('inert'), false)
})

test('an open pane marks nothing', async () => {
  const open = await layers(false)
  for (const layer of open.values()) assert.equal(layer.hasAttribute('data-pane-collapsed'), false)
})

// A tab popped out into a window of its own: its body lives in that window, so
// the pane mounts none — not even the retained layer a terminal keeps when it
// is merely behind another tab, which would take the pty back from the window.
// Selected, the pane shows where the tab went and the way to bring it back.

async function renderBody(paneTabs: WorkspacePaneTab[], selectedTabId: string): Promise<HTMLElement> {
  const { WorkspacePaneBody } = await import('./WorkspacePaneBody')
  host = dom.window.document.createElement('div')
  dom.window.document.body.appendChild(host)
  root = createRoot(host as unknown as Element)
  await act(async () => {
    root?.render(
      React.createElement(WorkspacePaneBody, {
        workspaceId: 'ws-popped',
        tabs: paneTabs,
        activeTabId: selectedTabId,
        selectedTabId,
      }),
    )
  })
  return host
}

const POPPED: WorkspacePaneTab[] = [
  { id: 'docked', kind: 'terminal', terminalId: 'term-docked' },
  { id: 'away', kind: 'terminal', terminalId: 'term-away', poppedOut: 'pop-1' },
]

test('a popped-out tab, selected, shows the placeholder instead of its body', async () => {
  const container = await renderBody(POPPED, 'away')
  const panel = container.querySelector('#pane-ws-popped-panel-away')
  assert.ok(panel, 'the selected tab still has its panel')
  assert.equal(panel.querySelector('[data-terminal-body]'), null, 'its body is not mounted here')
  assert.match(panel.textContent ?? '', /Shown in a separate window/)
  const labels = [...panel.querySelectorAll('button')].map((button) => button.textContent?.trim())
  assert.deepEqual(labels, ['Show window', 'Bring back'])
  // The docked terminal behind it keeps its retained layer, as ever.
  assert.ok(container.querySelector('[data-terminal-body="term-docked"]'))
})

test('a popped-out tab behind another keeps no layer at all', async () => {
  const container = await renderBody(POPPED, 'docked')
  assert.equal(container.querySelector('#pane-ws-popped-panel-away'), null)
  assert.equal(container.querySelector('[data-terminal-body="term-away"]'), null)
})

test('"Bring back" docks the tab into the pane, on screen', async () => {
  const { useWorkspaceStore } = await import('../../../store/workspaceStore')
  useWorkspaceStore.setState({
    workspaces: [
      {
        id: 'ws-popped',
        name: 'Popped',
        agents: {},
        paneState: { open: true, activeTabId: 'away', tabs: POPPED },
      } as unknown as Workspace,
    ],
  })
  const container = await renderBody(POPPED, 'away')
  const bringBack = [...container.querySelectorAll('button')].find((button) => button.textContent === 'Bring back')
  assert.ok(bringBack)
  await act(async () => {
    bringBack.click()
  })
  const pane = useWorkspaceStore.getState().workspaces.find((workspace) => workspace.id === 'ws-popped')?.paneState
  assert.equal(pane?.tabs.find((tab) => tab.id === 'away')?.poppedOut, undefined)
  assert.equal(pane?.activeTabId, 'away')
})
