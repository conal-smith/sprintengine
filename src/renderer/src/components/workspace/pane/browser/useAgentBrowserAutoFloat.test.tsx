import assert from 'node:assert/strict'

// The floating player coming up by itself, as the pane column wires it: an
// agent taking a page or drawing on a board in a closed pane, an agent's
// browser.open, and the person closing the pane on a page or board an agent is
// still working in. The pane itself
// is stubbed; what is under test is what the column does to the store.
import { JSDOM } from 'jsdom'

import React, { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeAll, test, vi } from 'vitest'

import type { BrowserTabState } from '../../../../../../shared/browser'
import type { Workspace, WorkspacePaneState } from '../../../../types/workspace'

vi.mock('../WorkspacePane', () => ({ default: () => null }))

const WS = 'ws-auto-float'

let dom: JSDOM
let root: Root | null = null
let host: HTMLElement | null = null
const listeners = new Map<string, (payload: unknown) => void>()
let tabCounter = 0

beforeAll(() => {
  dom = new JSDOM('<!doctype html><html><body></body></html>', { url: 'http://localhost', pretendToBeVisual: true })
  const anyGlobal = globalThis as unknown as Record<string, unknown>
  const domWindow = dom.window as unknown as Record<string, unknown>
  anyGlobal.window = domWindow
  anyGlobal.document = dom.window.document
  anyGlobal.navigator = dom.window.navigator
  anyGlobal.HTMLElement = dom.window.HTMLElement
  anyGlobal.Node = dom.window.Node
  anyGlobal.getComputedStyle = dom.window.getComputedStyle
  anyGlobal.localStorage = dom.window.localStorage
  anyGlobal.IS_REACT_ACT_ENVIRONMENT = true
  class FakeResizeObserver {
    observe() {}
    unobserve() {}
    disconnect() {}
  }
  anyGlobal.ResizeObserver = FakeResizeObserver
  domWindow.ResizeObserver = FakeResizeObserver
  // Subscriptions are kept so a test can play main's side; everything else
  // answers with nothing.
  domWindow.api = new Proxy({ platform: 'darwin' } as Record<string, unknown>, {
    get: (target, key: string) => {
      if (key in target) return target[key]
      if (key.startsWith('on'))
        return (callback: (payload: unknown) => void) => {
          listeners.set(key, callback)
          return () => listeners.delete(key)
        }
      return () => Promise.resolve(undefined)
    },
  })
})

afterEach(() => {
  if (root) act(() => root?.unmount())
  host?.remove()
  root = null
  host = null
  listeners.clear()
})

async function store() {
  return (await import('../../../../store/workspaceStore')).useWorkspaceStore
}

/** A fresh browser tab id per test: the tracker is the window's, and outlives a test. */
function freshTabId(): string {
  tabCounter += 1
  return `page-${tabCounter}`
}

async function renderColumn(paneState: WorkspacePaneState, options: { autoFloat?: boolean } = {}) {
  const useWorkspaceStore = await store()
  useWorkspaceStore.setState((state) => ({
    workspaces: [{ id: WS, name: 'Chat', folderPath: '/Users/dev/app', agents: {}, paneState } as unknown as Workspace],
    workspacePaneMaximised: false,
    appSettings: { ...state.appSettings, browserAutoFloatAgentPreview: options.autoFloat ?? true },
  }))
  const { WorkspacePaneColumn } = await import('../WorkspacePaneColumn')
  host = dom.window.document.createElement('div')
  dom.window.document.body.appendChild(host)
  root = createRoot(host as unknown as Element)
  act(() => {
    root?.render(
      React.createElement(WorkspacePaneColumn, {
        activeWorkspaceId: WS,
        renderedWorkspaceIds: [WS],
        windowWorkspaceIds: new Set([WS]),
      }),
    )
  })
}

function report(tabId: string, controller: BrowserTabState['controller']): void {
  const listener = listeners.get('onBrowserState')
  assert.ok(listener, 'the column listens to main’s browser reports')
  act(() => listener({ tabId, controller, url: 'http://localhost:5173/', title: 'Preview' } as BrowserTabState))
}

async function pane(): Promise<WorkspacePaneState> {
  const state = (await store()).getState().workspaces.find((w) => w.id === WS)?.paneState
  assert.ok(state)
  return state
}

function closedPaneWith(tabId: string, open = false): WorkspacePaneState {
  return {
    open,
    activeTabId: tabId,
    tabs: [
      { id: 'term', kind: 'terminal', terminalId: 'term-1' },
      { id: tabId, kind: 'browser', url: 'http://localhost:5173/' },
    ],
  }
}

test('an agent taking a page in a closed pane floats it, and the pane stays closed', async () => {
  const tabId = freshTabId()
  await renderColumn(closedPaneWith(tabId))
  report(tabId, 'agent')
  const after = await pane()
  assert.equal(after.tabs.find((tab) => tab.id === tabId)?.floating, true)
  assert.equal(after.open, false)
})

test('an open pane is left alone when an agent takes its page', async () => {
  const tabId = freshTabId()
  await renderColumn(closedPaneWith(tabId, true))
  report(tabId, 'agent')
  const after = await pane()
  assert.equal(after.tabs.find((tab) => tab.id === tabId)?.floating, undefined)
  assert.equal(after.open, true)
})

test('with the setting off, nothing floats', async () => {
  const tabId = freshTabId()
  await renderColumn(closedPaneWith(tabId), { autoFloat: false })
  report(tabId, 'agent')
  assert.equal((await pane()).tabs.find((tab) => tab.id === tabId)?.floating, undefined)
})

test('a player the person closed stays down for the agent’s next step', async () => {
  const tabId = freshTabId()
  await renderColumn(closedPaneWith(tabId))
  report(tabId, 'agent')
  const { agentBrowserTracker } = await import('./agentBrowserFloat')
  // What the player's Close does.
  agentBrowserTracker.dismiss(tabId, Date.now())
  const useWorkspaceStore = await store()
  act(() => useWorkspaceStore.getState().dismissPaneTabFloat(WS, tabId))
  report(tabId, 'none')
  report(tabId, 'agent')
  assert.equal((await pane()).tabs.find((tab) => tab.id === tabId)?.floating, undefined)
})

test('closing the pane on a page an agent is driving hands it to the player', async () => {
  const tabId = freshTabId()
  await renderColumn(closedPaneWith(tabId, true))
  report(tabId, 'agent')
  const useWorkspaceStore = await store()
  act(() => useWorkspaceStore.getState().setPaneOpen(WS, false))
  const after = await pane()
  assert.equal(after.tabs.find((tab) => tab.id === tabId)?.floating, true)
  assert.equal(after.open, false)
})

test('closing the pane on a page no agent is driving just closes it', async () => {
  const tabId = freshTabId()
  await renderColumn(closedPaneWith(tabId, true))
  const useWorkspaceStore = await store()
  act(() => useWorkspaceStore.getState().setPaneOpen(WS, false))
  assert.equal((await pane()).tabs.find((tab) => tab.id === tabId)?.floating, undefined)
})

test('an agent opening a URL with the pane closed floats the new page instead of opening the pane', async () => {
  const tabId = freshTabId()
  await renderColumn(closedPaneWith(tabId))
  const listener = listeners.get('onBrowserOpenRequest')
  assert.ok(listener)
  act(() => listener({ workspaceId: WS, url: 'http://localhost:4000/', tabId: null }))
  const after = await pane()
  const opened = after.tabs.find((tab) => tab.url === 'http://localhost:4000/')
  assert.ok(opened, 'the page opens in a tab of its own')
  assert.equal(opened.floating, true)
  assert.equal(after.open, false)
})

test('an agent opening a URL with the pane open brings it to the front of the pane, as before', async () => {
  const tabId = freshTabId()
  await renderColumn(closedPaneWith(tabId, true))
  const listener = listeners.get('onBrowserOpenRequest')
  assert.ok(listener)
  act(() => listener({ workspaceId: WS, url: 'http://localhost:4000/', tabId: null }))
  const after = await pane()
  const opened = after.tabs.find((tab) => tab.url === 'http://localhost:4000/')
  assert.equal(opened?.floating, undefined)
  assert.equal(after.activeTabId, opened?.id)
  assert.equal(after.open, true)
})

test('with the setting off, an agent opening a URL opens the pane, as before', async () => {
  const tabId = freshTabId()
  await renderColumn(closedPaneWith(tabId), { autoFloat: false })
  const listener = listeners.get('onBrowserOpenRequest')
  assert.ok(listener)
  act(() => listener({ workspaceId: WS, url: 'http://localhost:4000/', tabId: null }))
  const after = await pane()
  assert.equal(after.open, true)
  assert.equal(
    after.tabs.some((tab) => tab.floating),
    false,
  )
})

test('a page the person floated stays up when the agent opens another: the new one waits in the strip', async () => {
  const mine = freshTabId()
  const theirs = freshTabId()
  await renderColumn({
    open: false,
    activeTabId: mine,
    tabs: [
      { id: mine, kind: 'browser', url: 'http://localhost:5173/', floating: true },
      { id: theirs, kind: 'browser', url: 'http://localhost:4000/' },
    ],
  })
  const listener = listeners.get('onBrowserOpenRequest')
  assert.ok(listener)
  act(() => listener({ workspaceId: WS, url: 'http://localhost:6006/', tabId: null }))
  act(() => listener({ workspaceId: WS, url: null, tabId: theirs }))
  const after = await pane()
  assert.equal(after.tabs.find((tab) => tab.id === mine)?.floating, true, 'the person’s player is untouched')
  assert.equal(after.tabs.filter((tab) => tab.floating).length, 1)
  assert.ok(
    after.tabs.some((tab) => tab.url === 'http://localhost:6006/'),
    'the agent’s page is opened behind it',
  )
  assert.equal(after.open, false)
})

test('a player the person closed stays closed when the agent opens without naming a tab', async () => {
  const tabId = freshTabId()
  await renderColumn(closedPaneWith(tabId))
  report(tabId, 'agent')
  const { agentBrowserTracker } = await import('./agentBrowserFloat')
  const useWorkspaceStore = await store()
  agentBrowserTracker.dismiss(tabId, Date.now())
  act(() => useWorkspaceStore.getState().dismissPaneTabFloat(WS, tabId))
  const listener = listeners.get('onBrowserOpenRequest')
  assert.ok(listener)
  act(() => listener({ workspaceId: WS, url: null, tabId: null }))
  act(() => listener({ workspaceId: WS, url: null, tabId }))
  const after = await pane()
  assert.equal(
    after.tabs.some((tab) => tab.floating),
    false,
  )
  assert.equal(after.open, false, 'nor does the pane open in its place')
})

function closedPaneWithBoard(tabId: string, path: string, open = false): WorkspacePaneState {
  return {
    open,
    activeTabId: tabId,
    tabs: [
      { id: 'term', kind: 'terminal', terminalId: 'term-1' },
      { id: tabId, kind: 'canvas', canvas: { path } },
    ],
  }
}

function drawing(workspaceId: string, path: string, controller: 'agent' | 'human' | 'none'): void {
  const listener = listeners.get('onCanvasPresence')
  assert.ok(listener, 'the column listens to main’s canvas presence')
  act(() => listener({ workspaceId, path, controller }))
}

test('an agent drawing on a board in a closed pane floats the board, and the pane stays closed', async () => {
  const tabId = freshTabId()
  await renderColumn(closedPaneWithBoard(tabId, 'plan.excalidraw'))
  drawing(WS, 'plan.excalidraw', 'agent')
  const after = await pane()
  assert.equal(after.tabs.find((tab) => tab.id === tabId)?.floating, true)
  assert.equal(after.open, false)
})

test('the person drawing on a board does not float it, nor does another workspace’s board', async () => {
  const tabId = freshTabId()
  await renderColumn(closedPaneWithBoard(tabId, 'plan.excalidraw'))
  drawing(WS, 'plan.excalidraw', 'human')
  drawing('ws-elsewhere', 'plan.excalidraw', 'agent')
  drawing(WS, 'other.excalidraw', 'agent')
  assert.equal((await pane()).tabs.find((tab) => tab.id === tabId)?.floating, undefined)
})

test('with the setting off, a board an agent draws on does not float', async () => {
  const tabId = freshTabId()
  await renderColumn(closedPaneWithBoard(tabId, 'plan.excalidraw'), { autoFloat: false })
  drawing(WS, 'plan.excalidraw', 'agent')
  assert.equal((await pane()).tabs.find((tab) => tab.id === tabId)?.floating, undefined)
})

test('closing the pane on a board an agent is drawing on hands it to the player', async () => {
  const tabId = freshTabId()
  await renderColumn(closedPaneWithBoard(tabId, 'plan.excalidraw', true))
  drawing(WS, 'plan.excalidraw', 'agent')
  const useWorkspaceStore = await store()
  act(() => useWorkspaceStore.getState().setPaneOpen(WS, false))
  const after = await pane()
  assert.equal(after.tabs.find((tab) => tab.id === tabId)?.floating, true)
  assert.equal(after.open, false)
})
