import assert from 'node:assert/strict'

// The two renderer halves of a pane pop-out, against a stand-in for main.
//
// The owner window keeps the record: it pushes each pop-out window the tabs it
// holds (without the owner's mark), applies what the window sends back only to
// tabs that window holds, closes a window whose tabs are all gone, and takes
// the tabs back when a window closes. The pop-out window sends its pane writes
// to the owner instead of applying them to a copy nobody else reads.
import { JSDOM } from 'jsdom'

import React, { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeAll, test } from 'vitest'

import type {
  PanePopOutAction,
  PanePopOutActionEvent,
  PanePopOutClosedEvent,
  PanePopOutState,
} from '../../../../../../shared/ipc/pane-popout'
import type { Workspace, WorkspacePaneState } from '../../../../types/workspace'

const WS = 'ws-owner'
const OTHER = 'ws-other'

let dom: JSDOM
let root: Root | null = null

const opened: Array<{ popOutId: string; workspaceId: string }> = []
const pushes: Array<{ popOutId: string; state: PanePopOutState }> = []
const closed: string[] = []
const focused: string[] = []
let actionListener: ((event: PanePopOutActionEvent) => void) | null = null
let closedListener: ((event: PanePopOutClosedEvent) => void) | null = null

const apiTarget: Record<string, unknown> = {
  platform: 'darwin',
  panePopOutOpen: (input: { popOutId: string; workspaceId: string }) => {
    opened.push(input)
    return Promise.resolve({ ok: true })
  },
  panePopOutPush: (popOutId: string, state: PanePopOutState) => pushes.push({ popOutId, state }),
  panePopOutClose: (popOutId: string) => {
    closed.push(popOutId)
    return Promise.resolve()
  },
  panePopOutFocus: (popOutId: string) => {
    focused.push(popOutId)
    return Promise.resolve()
  },
  browserNavigate: () => Promise.resolve(true),
  onPanePopOutAction: (listener: (event: PanePopOutActionEvent) => void) => {
    actionListener = listener
    return () => {
      actionListener = null
    }
  },
  onPanePopOutClosed: (listener: (event: PanePopOutClosedEvent) => void) => {
    closedListener = listener
    return () => {
      closedListener = null
    }
  },
}

beforeAll(() => {
  dom = new JSDOM('<!doctype html><html><body></body></html>', { url: 'http://localhost', pretendToBeVisual: true })
  const anyGlobal = globalThis as unknown as Record<string, unknown>
  anyGlobal.window = dom.window
  anyGlobal.document = dom.window.document
  anyGlobal.navigator = dom.window.navigator
  anyGlobal.HTMLElement = dom.window.HTMLElement
  anyGlobal.Node = dom.window.Node
  anyGlobal.localStorage = dom.window.localStorage
  anyGlobal.IS_REACT_ACT_ENVIRONMENT = true
  ;(dom.window as unknown as Record<string, unknown>).api = new Proxy(apiTarget, {
    get: (target, key: string) => (key in target ? target[key] : () => Promise.resolve(undefined)),
  })
})

afterEach(() => {
  if (root) act(() => root?.unmount())
  root = null
  opened.length = 0
  pushes.length = 0
  closed.length = 0
  focused.length = 0
})

async function store() {
  return (await import('../../../../store/workspaceStore')).useWorkspaceStore
}

async function seed(paneState: WorkspacePaneState): Promise<void> {
  const useWorkspaceStore = await store()
  useWorkspaceStore.setState({
    workspaces: [
      { id: WS, name: 'Owner', agents: {}, paneState } as unknown as Workspace,
      {
        id: OTHER,
        name: 'Other',
        agents: {},
        paneState: { open: false, activeTabId: null, tabs: [] },
      } as unknown as Workspace,
    ],
  })
}

async function pane(workspaceId = WS): Promise<WorkspacePaneState | undefined> {
  return (await store()).getState().workspaces.find((workspace) => workspace.id === workspaceId)?.paneState
}

/** Mount the owner's hook, as the pane column does, for a window holding `held`. */
async function mountHost(held: ReadonlySet<string> | null): Promise<(next: ReadonlySet<string> | null) => void> {
  const { usePanePopOutHost } = await import('./panePopOutHost')
  let setHeld: (next: ReadonlySet<string> | null) => void = () => undefined
  function Host() {
    const [ids, setIds] = React.useState(held)
    setHeld = setIds
    usePanePopOutHost(ids)
    return null
  }
  const container = dom.window.document.createElement('div')
  root = createRoot(container as unknown as Element)
  await act(async () => {
    root?.render(React.createElement(Host))
  })
  return (next) => act(() => setHeld(next))
}

const TABS: WorkspacePaneState = {
  open: true,
  activeTabId: 'files',
  tabs: [
    { id: 'files', kind: 'files' },
    { id: 'term', kind: 'terminal', terminalId: 'term-1' },
    { id: 'git', kind: 'git' },
  ],
}

async function popOut(tabIds: string[]): Promise<string> {
  const { popOutPaneTabs } = await import('./panePopOutHost')
  let ok = false
  await act(async () => {
    ok = await popOutPaneTabs(WS, tabIds)
  })
  assert.equal(ok, true)
  return opened[opened.length - 1].popOutId
}

function send(popOutId: string, action: PanePopOutAction): void {
  act(() => actionListener?.({ popOutId, action }))
}

test('the window is pushed the tabs it holds, without the mark, in front the tab that was', async () => {
  await seed(structuredClone(TABS))
  await mountHost(new Set([WS, OTHER]))
  const popOutId = await popOut(['files', 'term'])
  const last = pushes.filter((push) => push.popOutId === popOutId).at(-1)
  assert.ok(last, 'marking the tabs pushed them')
  assert.deepEqual(last.state.tabs, [
    { id: 'files', kind: 'files' },
    { id: 'term', kind: 'terminal', terminalId: 'term-1' },
  ])
  assert.deepEqual(last.state.reveal, { tabId: 'files', key: 1 })
  assert.equal((await pane())?.activeTabId, 'git', 'the pane shows the tab it kept')
})

test("the window's actions reach only the tabs it holds", async () => {
  await seed(structuredClone(TABS))
  await mountHost(new Set([WS, OTHER]))
  const popOutId = await popOut(['term'])
  send(popOutId, { type: 'update', tabId: 'term', patch: { title: 'zsh', poppedOut: undefined } })
  send(popOutId, { type: 'close', tabId: 'git' })
  send(popOutId, { type: 'update', tabId: 'files', patch: { title: 'hijacked' } })
  const tabs = (await pane())?.tabs ?? []
  assert.equal(tabs.find((tab) => tab.id === 'term')?.title, 'zsh')
  assert.equal(tabs.find((tab) => tab.id === 'term')?.poppedOut, popOutId, 'a patch never moves a tab')
  assert.ok(
    tabs.some((tab) => tab.id === 'git'),
    'a docked tab is not the window’s to close',
  )
  assert.equal(tabs.find((tab) => tab.id === 'files')?.title, undefined)
})

test('a tab opened from the window joins it, in front', async () => {
  await seed(structuredClone(TABS))
  await mountHost(new Set([WS, OTHER]))
  const popOutId = await popOut(['git'])
  send(popOutId, { type: 'open', input: { kind: 'diff', diff: { focusPath: 'a.ts', focusKind: 'unstaged' } } })
  const diff = (await pane())?.tabs.find((tab) => tab.kind === 'diff')
  assert.equal(diff?.poppedOut, popOutId)
  const last = pushes.filter((push) => push.popOutId === popOutId).at(-1)
  assert.deepEqual(
    last?.state.tabs.map((tab) => tab.id),
    ['git', diff?.id],
  )
  assert.equal(last?.state.reveal?.tabId, diff?.id)
})

// The window's own "+" (owner ruling 2026-10-30): the picked kind comes to the
// window, and the pane's single tab of that kind moves over rather than being
// shown behind the person in the other window.
test("the window's + brings the kind into the window, moving the pane's own tab over", async () => {
  await seed(structuredClone(TABS))
  await mountHost(new Set([WS, OTHER]))
  const popOutId = await popOut(['git'])

  send(popOutId, { type: 'add', kind: 'files' })
  let tabs = (await pane())?.tabs ?? []
  assert.equal(tabs.filter((tab) => tab.kind === 'files').length, 1, 'still one Files tab')
  assert.equal(tabs.find((tab) => tab.id === 'files')?.poppedOut, popOutId, 'the pane’s Files moved to the window')
  let last = pushes.filter((push) => push.popOutId === popOutId).at(-1)
  assert.deepEqual(
    last?.state.tabs.map((tab) => tab.id),
    ['files', 'git'],
  )
  assert.equal(last?.state.reveal?.tabId, 'files', 'in front')

  send(popOutId, { type: 'add', kind: 'agents' })
  tabs = (await pane())?.tabs ?? []
  const agents = tabs.find((tab) => tab.kind === 'agents')
  assert.equal(agents?.poppedOut, popOutId, 'a kind the pane lacked is opened in the window')
  last = pushes.filter((push) => push.popOutId === popOutId).at(-1)
  assert.equal(last?.state.reveal?.tabId, agents?.id)

  const before = (await pane())?.tabs.length
  send(popOutId, { type: 'add', kind: 'terminal' })
  send(popOutId, { type: 'add', kind: 'document' })
  assert.equal((await pane())?.tabs.length, before, 'no terminal or empty document from a window')
})

test("the window's + offers the pane's kinds less a terminal and the modal rows", async () => {
  const { popOutAddKinds } = await import('./panePopOutHost')
  const glyph = () => null
  const kinds = popOutAddKinds([
    { kind: 'browser', label: 'Browser', letter: 'B', Glyph: glyph },
    { kind: 'terminal', label: 'Terminal', letter: 'T', Glyph: glyph },
    { kind: 'files', label: 'Files', letter: 'F', Glyph: glyph },
    { kind: 'agents', label: 'Agents', letter: 'A', Glyph: glyph },
    { kind: 'reviews', label: 'Reviews', letter: 'R', Glyph: glyph, modalSurfaceId: 'reviews' },
  ])
  assert.deepEqual(
    kinds.map((definition) => definition.kind),
    ['browser', 'files', 'agents'],
  )
})

test('closing its last tab closes the window; a closed window brings its tabs home', async () => {
  await seed(structuredClone(TABS))
  await mountHost(new Set([WS, OTHER]))
  const lone = await popOut(['git'])
  send(lone, { type: 'close', tabId: 'git' })
  assert.deepEqual(closed, [lone], 'a window with nothing to show is closed')

  const pair = await popOut(['files', 'term'])
  send(pair, { type: 'activate', tabId: 'term' })
  act(() => closedListener?.({ popOutId: pair }))
  const after = await pane()
  assert.deepEqual(
    after?.tabs.map((tab) => tab.poppedOut ?? null),
    [null, null],
  )
  assert.equal(after?.open, true)
  assert.equal(after?.activeTabId, 'term', 'the pane opens on the tab the window had in front')
  assert.equal(after?.tabs.find((tab) => tab.id === 'term')?.terminalId, 'term-1', 'docked, not closed')
})

test('a workspace that leaves the window takes its tabs back and closes its windows', async () => {
  await seed(structuredClone(TABS))
  const setHeld = await mountHost(new Set([WS, OTHER]))
  const popOutId = await popOut(['files'])
  setHeld(new Set([OTHER]))
  assert.deepEqual(closed, [popOutId])
  assert.equal((await pane())?.tabs.find((tab) => tab.id === 'files')?.poppedOut, undefined)
})

test('a window cannot repoint a tab at another pty, nor open a terminal tab of its own', async () => {
  await seed(structuredClone(TABS))
  await mountHost(new Set([WS, OTHER]))
  const popOutId = await popOut(['term'])
  send(popOutId, {
    type: 'update',
    tabId: 'term',
    patch: { title: 'zsh', terminalId: 'someone-elses', kind: 'browser' } as never,
  })
  const term = (await pane())?.tabs.find((tab) => tab.id === 'term')
  assert.equal(term?.title, 'zsh', 'what a body writes about itself lands')
  assert.equal(term?.terminalId, 'term-1')
  assert.equal(term?.kind, 'terminal')

  const before = (await pane())?.tabs.length
  send(popOutId, { type: 'open', input: { kind: 'terminal', terminalId: 'someone-elses' } })
  send(popOutId, { type: 'open', input: { kind: 'not-a-kind' } as never })
  assert.equal((await pane())?.tabs.length, before, 'neither opened a tab')
})

test("a brief gap in this window's membership closes nothing", async () => {
  await seed(structuredClone(TABS))
  const setHeld = await mountHost(new Set([WS, OTHER]))
  const popOutId = await popOut(['files'])
  setHeld(null)
  assert.deepEqual(closed, [], 'not known is not gone')
  assert.equal((await pane())?.tabs.find((tab) => tab.id === 'files')?.poppedOut, popOutId)
  setHeld(new Set([WS, OTHER]))
  assert.deepEqual(closed, [])
})

test("the window is told the owner's chat in focus and its requests for an agent lane", async () => {
  await seed(structuredClone(TABS))
  const useWorkspaceStore = await store()
  const { openAgentsPane } = await import('../agents/agentsPaneFocus')
  await mountHost(new Set([WS, OTHER]))
  act(() => useWorkspaceStore.getState().openPaneTab(WS, { kind: 'agents', activate: false }))
  const agentsTabId = (await pane())?.tabs.find((tab) => tab.kind === 'agents')?.id
  assert.ok(agentsTabId)
  const popOutId = await popOut([agentsTabId])
  act(() => useWorkspaceStore.getState().setFocusedAgent(WS, 'agent-1'))
  assert.equal(pushes.filter((push) => push.popOutId === popOutId).at(-1)?.state.focusedAgentId, 'agent-1')
  act(() => openAgentsPane(WS, 'agent-2', 'lane-7'))
  const last = pushes.filter((push) => push.popOutId === popOutId).at(-1)
  assert.equal(last?.state.agentFocus?.agentId, 'agent-2')
  assert.equal(last?.state.agentFocus?.laneId, 'lane-7')
})

test("the Diff tab's app-wide settings, changed in the window, are the owner's to write", async () => {
  await seed(structuredClone(TABS))
  const useWorkspaceStore = await store()
  const { redirectPaneWrites, paneOpensHandedOff } = await import('./panePopOutRedirect')
  const sent: PanePopOutAction[] = []
  assert.equal(paneOpensHandedOff(WS), false)
  const restore = redirectPaneWrites({ workspaceId: WS, act: (action) => sent.push(action), select: () => undefined })
  try {
    assert.equal(paneOpensHandedOff(WS), true, 'an open the owner takes is not one to hand the system browser')
    assert.equal(paneOpensHandedOff(OTHER), false)
    useWorkspaceStore.getState().setDiffOpensInWindow(true)
    useWorkspaceStore.getState().setDiffView('unified')
    assert.equal(useWorkspaceStore.getState().diffView, 'unified', 'shown here as picked')
    assert.deepEqual(sent, [
      { type: 'diff-opens-in-window', enabled: true },
      { type: 'diff-view', view: 'unified' },
    ])
  } finally {
    restore()
  }
  assert.equal(paneOpensHandedOff(WS), false)

  // The owner's half.
  useWorkspaceStore.getState().setDiffOpensInWindow(false)
  useWorkspaceStore.getState().setDiffView('side-by-side')
  await mountHost(new Set([WS, OTHER]))
  const popOutId = await popOut(['git'])
  send(popOutId, { type: 'diff-opens-in-window', enabled: true })
  send(popOutId, { type: 'diff-view', view: 'unified' })
  assert.equal(useWorkspaceStore.getState().diffOpensInWindow, true)
  assert.equal(useWorkspaceStore.getState().diffView, 'unified')
})

test("the pop-out window's pane writes go to the owner, and other workspaces' do not", async () => {
  await seed(structuredClone(TABS))
  const useWorkspaceStore = await store()
  const { redirectPaneWrites } = await import('./panePopOutRedirect')
  const { openFileSurface } = await import('../../../../utils/openFileSurface')
  const sent: PanePopOutAction[] = []
  const selected: string[] = []
  const restore = redirectPaneWrites({
    workspaceId: WS,
    act: (action) => sent.push(action),
    select: (tabId) => selected.push(tabId),
  })
  try {
    const before = await pane()
    const state = useWorkspaceStore.getState()
    state.updatePaneTab(WS, 'files', { title: 'Explorer' })
    state.closePaneTab(WS, 'git')
    state.setActivePaneTab(WS, 'term')
    assert.equal(state.openPaneTab(WS, { kind: 'backlog' }), null, 'the owner decides, and answers with a push')
    openFileSurface({ workspaceId: WS, path: '/Users/dev/app/a.ts', name: 'a.ts', lineNumber: 3 })
    assert.equal(await pane(), before, 'nothing is applied to this window’s copy')
    assert.deepEqual(sent, [
      { type: 'update', tabId: 'files', patch: { title: 'Explorer' } },
      { type: 'close', tabId: 'git' },
      { type: 'activate', tabId: 'term' },
      { type: 'open', input: { kind: 'backlog' } },
      { type: 'open-file', path: '/Users/dev/app/a.ts', name: 'a.ts', lineNumber: 3 },
    ])
    assert.deepEqual(selected, ['term'])

    state.openPaneTab(OTHER, { kind: 'git' })
    assert.equal((await pane(OTHER))?.tabs.length, 1, 'another workspace is written as ever')
  } finally {
    restore()
  }
  useWorkspaceStore.getState().closePaneTab(WS, 'git')
  assert.equal(
    (await pane())?.tabs.some((tab) => tab.id === 'git'),
    false,
    'restored, the store writes its own pane again',
  )
})

test('a popped-out tab asked for from elsewhere comes forward in its window, and the pane stays as it is', async () => {
  await seed({
    open: true,
    activeTabId: 'files',
    tabs: [
      { id: 'files', kind: 'files' },
      { id: 'web', kind: 'browser', url: 'http://localhost:3000/' },
      { id: 'agents', kind: 'agents' },
      { id: 'board', kind: 'canvas', canvas: { path: '/Users/dev/app/plan.canvas' } },
    ],
  })
  const useWorkspaceStore = await store()
  const { showPaneTab } = await import('./panePopOutHost')
  const { openAgentsPane } = await import('../agents/agentsPaneFocus')
  const { openUrlInPane } = await import('../browser/openInPane')
  await mountHost(new Set([WS, OTHER]))
  const popOutId = await popOut(['web', 'agents', 'board'])
  act(() => useWorkspaceStore.getState().setPaneOpen(WS, false))
  const reveal = () => pushes.filter((push) => push.popOutId === popOutId).at(-1)?.state.reveal?.tabId

  // An agent's canvas.open: forward in the window, which is not raised.
  act(() => showPaneTab(WS, 'board'))
  assert.equal(reveal(), 'board')
  assert.deepEqual(focused, [], 'an agent never raises a window')

  // The person's clicks: forward, and the window raised.
  act(() => openAgentsPane(WS, 'agent-1', null))
  assert.equal(reveal(), 'agents')
  act(() => {
    assert.equal(openUrlInPane(WS, 'http://localhost:3000/docs'), true)
  })
  assert.equal(reveal(), 'web')
  assert.deepEqual(focused, [popOutId, popOutId])

  const after = await pane()
  assert.equal(after?.open, false, 'the pane is not opened on a placeholder')
  assert.equal(after?.activeTabId, 'files')
  assert.equal(after?.tabs.length, 4, 'nothing was opened a second time')

  // A docked tab is shown the usual way.
  act(() => showPaneTab(WS, 'files'))
  assert.equal((await pane())?.open, true)
})
