import assert from 'node:assert/strict'

// The workspace pane's strip and the width a new tab arrives at.
//
// Two rules live here. A new Canvas tab opens docked, like every other kind
// (owner ruling 2026-09-22): it used to maximise the pane, which read as the
// pane opening full screen by default. And there is one close-pane control on
// screen, not two: docked, it is the strip's, and the WorkspaceHeader's pane
// switch steps aside (PanelSwitches.test.tsx); maximised, the strip sits
// directly under the header, whose switch is the same control one row up, and
// the header keeps the window's caption corner (paneStripOwnsCaptionCorner).
//
// The tab bodies are stubbed. What is under test is the strip and the store
// calls it makes, not the editors a tab mounts.
import { JSDOM } from 'jsdom'

import React, { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeAll, test, vi } from 'vitest'

import type { Workspace, WorkspacePaneState } from '../../../types/workspace'

vi.mock('./WorkspacePaneBody', () => ({
  WorkspacePaneBody: () => null,
}))

const WS = 'ws-pane-strip'

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
  class FakeResizeObserver {
    observe() {}
    unobserve() {}
    disconnect() {}
  }
  anyGlobal.ResizeObserver = FakeResizeObserver
  domWindow.ResizeObserver = FakeResizeObserver
  dom.window.matchMedia = ((q: string) => ({
    matches: false,
    media: q,
    addEventListener: () => {},
    removeEventListener: () => {},
    addListener: () => {},
    removeListener: () => {},
  })) as unknown as typeof dom.window.matchMedia
  // win32: the platform whose caption buttons float over the top-right corner.
  // Every bridge call the pane makes answers with nothing, but for opening a
  // pop-out window, which answers that it opened.
  domWindow.api = new Proxy(apiTarget, {
    get: (target, key: string) => (key in target ? target[key] : () => Promise.resolve(undefined)),
  })
})

const popOutRequests: unknown[] = []
const activeNotes: Array<string | null> = []
const apiTarget: Record<string, unknown> = {
  platform: 'win32',
  // A subscription answers with its unsubscribe, as the preload's do: the
  // agent pill reads the chats' file trail, which subscribes on mount.
  onConversationEvent: () => () => {},
  browserNoteActive: (_workspaceId: string, tabId: string | null) => {
    activeNotes.push(tabId)
    return Promise.resolve()
  },
  panePopOutOpen: (input: unknown) => {
    popOutRequests.push(input)
    return Promise.resolve({ ok: true })
  },
}

afterEach(() => {
  popOutRequests.length = 0
  activeNotes.length = 0
  if (root) act(() => root?.unmount())
  host?.remove()
  root = null
  host = null
})

async function renderPane(paneState: WorkspacePaneState, maximised: boolean): Promise<HTMLElement> {
  const { useWorkspaceStore } = await import('../../../store/workspaceStore')
  useWorkspaceStore.setState({
    workspaces: [
      { id: WS, name: 'Strip', folderPath: '/Users/dev/strip', agents: {}, paneState } as unknown as Workspace,
    ],
    workspacePaneMaximised: maximised,
  })
  const { default: WorkspacePane } = await import('./WorkspacePane')
  host = dom.window.document.createElement('div')
  dom.window.document.body.appendChild(host)
  root = createRoot(host as unknown as Element)
  act(() => {
    root?.render(React.createElement(WorkspacePane, { workspaceId: WS, active: true }))
  })
  return host
}

function button(container: HTMLElement, name: string): HTMLButtonElement | null {
  return (
    [...container.querySelectorAll('button')].find(
      (candidate) => candidate.getAttribute('aria-label') === name || candidate.textContent?.trim().startsWith(name),
    ) ?? null
  )
}

// The strip's trailing caption reserve: the one aria-hidden spacer with an
// inline width, rendered only while the strip owns the caption corner.
function captionReserveWidth(container: HTMLElement): number {
  const spacer = [...container.querySelectorAll<HTMLElement>('div[aria-hidden="true"]')].find(
    (element) => element.style.width !== '',
  )
  return spacer ? Number.parseFloat(spacer.style.width) : 0
}

test('a new Canvas tab opened from the launcher opens docked', async () => {
  const container = await renderPane({ open: true, activeTabId: null, tabs: [] }, false)
  const canvasCard = button(container, 'Canvas')
  assert.ok(canvasCard, 'the empty pane offers a Canvas card')
  act(() => canvasCard.click())

  const { useWorkspaceStore } = await import('../../../store/workspaceStore')
  const state = useWorkspaceStore.getState()
  const pane = state.workspaces.find((workspace) => workspace.id === WS)?.paneState
  assert.equal(pane?.tabs.filter((tab) => tab.kind === 'canvas').length, 1, 'the click made a Canvas tab')
  assert.equal(state.workspacePaneMaximised, false, 'a new Canvas tab leaves the pane docked')
})

test('a docked strip keeps its close-pane control and reserves the caption corner', async () => {
  const container = await renderPane({ open: true, activeTabId: 't1', tabs: [{ id: 't1', kind: 'files' }] }, false)
  assert.ok(button(container, 'Close pane'), 'docked, the strip closes the pane itself')
  assert.ok(button(container, 'Maximise pane'))
  assert.equal(captionReserveWidth(container), 120, 'docked, the strip owns the caption corner on win32')
})

test('a maximised strip shows one close-pane control and leaves the corner to the header', async () => {
  const container = await renderPane({ open: true, activeTabId: 't1', tabs: [{ id: 't1', kind: 'files' }] }, true)
  // A boolean, not the element: a failing assertion that has to print a JSDOM
  // node walks the whole document and runs the worker out of memory.
  assert.equal(button(container, 'Close pane') !== null, false, 'the header pane switch above is the one control')
  assert.ok(button(container, 'Restore pane'), 'restore stays in the strip beside "+"')
  assert.equal(captionReserveWidth(container), 0, 'maximised, the strip sits below the caption buttons')
})

test('exactly one strip owns the caption corner', async () => {
  const { paneStripOwnsCaptionCorner } = await import('../WindowControls')
  assert.equal(paneStripOwnsCaptionCorner({ open: true, maximised: false }), true, 'docked pane: its strip')
  assert.equal(paneStripOwnsCaptionCorner({ open: true, maximised: true }), false, 'maximised pane: the header')
  assert.equal(paneStripOwnsCaptionCorner({ open: false, maximised: false }), false, 'closed pane: the header')
  assert.equal(paneStripOwnsCaptionCorner({ open: false, maximised: true }), false, 'closed pane: the header')
})

test('the "+" sits right after the last tab, ahead of the empty run and the pane controls', async () => {
  const container = await renderPane(
    {
      open: true,
      activeTabId: 't1',
      tabs: [
        { id: 't1', kind: 'files' },
        { id: 't2', kind: 'git' },
      ],
    },
    false,
  )
  const tablist = container.querySelector('[role="tablist"]')
  const scroller = tablist?.closest('.strip-scroll')
  const add = button(container, 'Open in the pane')
  const maximise = button(container, 'Maximise pane')
  assert.ok(scroller && add && maximise, 'the strip renders its tabs, "+" and controls')
  // The scroller must not grow: a growing scroller is what pushed "+" to the
  // far edge. It still shrinks, so overflowing tabs scroll and "+" stays put.
  assert.equal(scroller.classList.contains('flex-1'), false, 'the tab scroller takes only its tabs’ width')
  assert.ok(scroller.classList.contains('min-w-0'), 'the tab scroller can shrink below its tabs and scroll')
  const order = (a: Node, b: Node) =>
    Boolean(a.compareDocumentPosition(b) & dom.window.Node.DOCUMENT_POSITION_FOLLOWING)
  assert.ok(order(scroller, add), '"+" follows the tabs')
  assert.ok(order(add, maximise), 'the pane controls stay after "+"')
  const spacer = container.querySelector('div.flex-1[aria-hidden="true"]')
  assert.ok(spacer, 'the strip has an empty run that takes the free width')
  assert.ok(order(add, spacer) && order(spacer, maximise), 'the empty run sits between "+" and the pane controls')
})

// The pane, or one tab, out into a window of its own. The strip's control
// takes every tab still docked; a tab's context menu takes that tab; a tab
// already out offers the way back instead. What is under test is the strip's
// side of it — the window is opened, then the tabs are marked — not the window.

async function paneOf() {
  const { useWorkspaceStore } = await import('../../../store/workspaceStore')
  return useWorkspaceStore.getState().workspaces.find((workspace) => workspace.id === WS)?.paneState
}

function menuItem(name: string): HTMLButtonElement | null {
  return (
    [...dom.window.document.querySelectorAll<HTMLButtonElement>('[role="menuitem"]')].find(
      (item) => item.textContent?.trim() === name,
    ) ?? null
  )
}

async function openTabMenu(container: HTMLElement, tabId: string): Promise<void> {
  const tab = container.querySelector<HTMLElement>(`[data-tab-id="${tabId}"]`)
  assert.ok(tab, `the strip draws tab ${tabId}`)
  await act(async () => {
    tab.dispatchEvent(new dom.window.MouseEvent('contextmenu', { bubbles: true, clientX: 20, clientY: 20 }))
  })
}

test('"Pop out pane" sits with the pane controls and takes every docked tab into one window', async () => {
  const container = await renderPane(
    {
      open: true,
      activeTabId: 't2',
      tabs: [
        { id: 't1', kind: 'files' },
        { id: 't2', kind: 'terminal', terminalId: 'term-2' },
      ],
    },
    false,
  )
  const popOut = button(container, 'Pop out pane')
  const maximise = button(container, 'Maximise pane')
  assert.ok(popOut && maximise, 'the strip offers the control, labelled')
  assert.ok(
    popOut.compareDocumentPosition(maximise) & dom.window.Node.DOCUMENT_POSITION_FOLLOWING,
    'it leads the trailing control group',
  )
  await act(async () => {
    popOut.click()
  })
  assert.equal(popOutRequests.length, 1, 'one window is asked for')
  const request = popOutRequests[0] as { popOutId: string; workspaceId: string }
  assert.equal(request.workspaceId, WS)
  const pane = await paneOf()
  assert.deepEqual(
    pane?.tabs.map((tab) => tab.poppedOut),
    [request.popOutId, request.popOutId],
    'both tabs are marked as in that window',
  )
  assert.equal(pane?.open, false, 'nothing is left docked, so the pane gives its width back')
  assert.equal(button(container, 'Pop out pane')?.disabled, true, 'with nothing docked there is nothing to pop out')
})

test("a tab's context menu pops out just that tab", async () => {
  const container = await renderPane(
    {
      open: true,
      activeTabId: 't1',
      tabs: [
        { id: 't1', kind: 'files' },
        { id: 't2', kind: 'git' },
      ],
    },
    false,
  )
  await openTabMenu(container, 't2')
  const item = menuItem('Pop out')
  assert.ok(item, 'the menu offers "Pop out" beside the close actions')
  assert.ok(menuItem('Close') && menuItem('Close others'), 'the close actions are still there')
  await act(async () => {
    item.click()
  })
  const pane = await paneOf()
  assert.equal(
    pane?.tabs.find((tab) => tab.id === 't2')?.poppedOut,
    (popOutRequests[0] as { popOutId: string }).popOutId,
  )
  assert.equal(pane?.tabs.find((tab) => tab.id === 't1')?.poppedOut, undefined)
  assert.equal(pane?.activeTabId, 't1')
  assert.equal(pane?.open, true)
})

test('a popped-out tab wears the pop-out mark, and its menu brings it back instead', async () => {
  const container = await renderPane(
    {
      open: true,
      activeTabId: 't1',
      tabs: [
        { id: 't1', kind: 'files' },
        { id: 't2', kind: 'git', poppedOut: 'pop-elsewhere' },
      ],
    },
    false,
  )
  const tab = container.querySelector<HTMLElement>('[data-tab-id="t2"]')
  assert.equal(tab?.getAttribute('aria-label'), 'Git: shown in a separate window', 'its name says where it is')
  await openTabMenu(container, 't2')
  assert.equal(menuItem('Pop out'), null)
  assert.ok(menuItem('Show window'))
  const bringBack = menuItem('Bring back')
  assert.ok(bringBack)
  await act(async () => {
    bringBack.click()
  })
  const pane = await paneOf()
  assert.equal(pane?.tabs.find((candidate) => candidate.id === 't2')?.poppedOut, undefined)
  assert.equal(pane?.activeTabId, 't2', 'back, it is the tab on screen')
  assert.equal(popOutRequests.length, 0, 'bringing a tab back opens no window')
})

test('a pane never names a browser tab that is out in a window of its own', async () => {
  await renderPane(
    {
      open: true,
      activeTabId: 'web',
      tabs: [
        { id: 'files', kind: 'files' },
        { id: 'web', kind: 'browser', url: 'http://localhost:3000/', poppedOut: 'pop-1' },
      ],
    },
    false,
  )
  // Main keeps this "none" from clearing the pop-out's word (browser-ipc).
  assert.deepEqual(activeNotes, [null], 'the window holding the page names it, not the pane')
})

// ⌘T: the window routes `pane.add` to the pane on screen, which opens its "+"
// menu as a click on "+" would. Another workspace's command is not this pane's.
test('the "+" menu opens from the keyboard command for this workspace only', async () => {
  const { dispatchPanelCommandEvent } = await import('../../../utils/panelCommands')
  const container = await renderPane({ open: true, activeTabId: 't1', tabs: [{ id: 't1', kind: 'files' }] }, false)
  const browserRow = () =>
    [...dom.window.document.querySelectorAll<HTMLButtonElement>('[role="menuitem"]')].find((item) =>
      item.textContent?.startsWith('Browser'),
    ) ?? null
  act(() => dispatchPanelCommandEvent('pane.add', 'ws-another'))
  assert.equal(browserRow(), null, 'a command for another workspace leaves this menu shut')
  act(() => dispatchPanelCommandEvent('pane.add', WS))
  assert.ok(browserRow(), 'the menu lists what can be opened')
  assert.equal(button(container, 'Open in the pane')?.getAttribute('aria-expanded'), 'true')
  act(() => browserRow()!.click())
  assert.equal(browserRow(), null, 'picking a row closes the menu')
  assert.ok(
    (await paneOf())?.tabs.some((tab) => tab.kind === 'browser'),
    'and opens what was picked',
  )
})
