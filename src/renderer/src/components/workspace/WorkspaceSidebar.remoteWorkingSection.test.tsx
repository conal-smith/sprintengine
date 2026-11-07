import assert from 'node:assert/strict'

import { JSDOM } from 'jsdom'
import { afterAll, beforeAll, test } from 'vitest'

import { meshConversationSessionId } from '../../../../shared/tailnet-mesh'

// The Working section with a paired machine in the list: a chat at work over
// there folds in with this computer's whether or not it is open here, under
// the same rules, and goes back when it stops. Its machine's list is the only
// thing that says so: this desktop's own sessions know nothing of it.

type Listed = Record<string, unknown>

const minute = 60_000
const now = Date.now()
const listed = (workspaceId: string, chatTitle: string, phase: string, minutesAgo: number, extra = {}): Listed => ({
  workspaceId,
  agentId: 'agent-1',
  title: 'Agent one',
  chatTitle,
  phase,
  updatedAt: now - minutesAgo * minute,
  createdAt: now - 300 * minute,
  providerId: 'claude-agent',
  modelId: 'opus',
  turnCount: 2,
  lastSeq: 8,
  lastUserMessageAt: now - minutesAgo * minute,
  recencyAt: now - minutesAgo * minute,
  ...extra,
})
const chatKey = (workspaceId: string) => `mac-mini:chat:${workspaceId}`

let harness: Awaited<ReturnType<typeof createHarness>>

async function createHarness() {
  const dom = new JSDOM('<!doctype html><html><body></body></html>', {
    url: 'http://localhost',
    pretendToBeVisual: true,
  })
  const anyGlobal = globalThis as unknown as Record<string, unknown>
  const domWindow = dom.window as unknown as Record<string, unknown>
  anyGlobal.window = domWindow
  anyGlobal.document = dom.window.document
  anyGlobal.navigator = dom.window.navigator
  anyGlobal.HTMLElement = dom.window.HTMLElement
  anyGlobal.HTMLInputElement = dom.window.HTMLInputElement
  anyGlobal.HTMLTextAreaElement = dom.window.HTMLTextAreaElement
  anyGlobal.Node = dom.window.Node
  anyGlobal.MouseEvent = dom.window.MouseEvent
  anyGlobal.KeyboardEvent = dom.window.KeyboardEvent
  anyGlobal.getComputedStyle = dom.window.getComputedStyle
  anyGlobal.localStorage = dom.window.localStorage
  anyGlobal.IS_REACT_ACT_ENVIRONMENT = true
  dom.window.matchMedia = ((query: string) => ({
    matches: false,
    media: query,
    addEventListener: () => {},
    removeEventListener: () => {},
    addListener: () => {},
    removeListener: () => {},
  })) as unknown as typeof dom.window.matchMedia
  class NoopResizeObserver {
    observe(): void {}
    unobserve(): void {}
    disconnect(): void {}
  }
  anyGlobal.ResizeObserver = NoopResizeObserver
  dom.window.ResizeObserver = NoopResizeObserver as unknown as typeof dom.window.ResizeObserver

  const connection = {
    id: 'c1',
    machineName: 'mac-mini',
    endpoint: '100.64.0.9:8471',
    deviceId: 'tnd_1',
    deviceName: 'mini',
    scopes: ['workspace:read', 'conversation:read', 'conversation:operate'],
    pairedAt: '2026-10-08T00:00:00.000Z',
    lastConnectedAt: null,
    pairedVia: 'request',
  }
  // What the machine lists now; a push makes the sidebar read it again.
  let conversations: Listed[] = []
  let meshListener: ((event: unknown) => void) | null = null
  let revision = 10

  domWindow.api = {
    platform: 'darwin',
    detectProjectLogo: async () => null,
    getGitRepositoryIdentity: async () => null,
    getWorkspaceChangeSummary: async () => null,
    terminalList: async () => [],
    onTerminalSessionsDelta: () => () => {},
    onTailnetEvent: () => () => {},
    onMeshEvent: (listener: (event: unknown) => void) => {
      meshListener = listener
      return () => {
        meshListener = null
      }
    },
    tailnetGetStatus: async () => ({
      enabled: true,
      running: true,
      endpoint: null,
      port: 8471,
      tailnetAddress: '100.64.0.5',
      lastError: null,
      notifications: true,
      devices: [],
      pairing: null,
      pairRequests: [],
    }),
    tailnetGetLiveState: async () => ({ revision: 1, devices: [] }),
    meshListConnections: async () => [connection],
    meshGetLiveState: async () => ({ revision: 1, requests: [], reachability: [] }),
    meshBrowse: async () => ({
      connectionId: 'c1',
      reachable: true,
      unreachableReason: null,
      unauthorized: false,
      scopes: connection.scopes,
      workspaces: ['rw1', 'rw2', 'rw3', 'rw4'].map((id) => ({
        id,
        name: id,
        mode: 'standard',
        folderPath: id === 'rw4' ? '/Users/dev/quiet-project' : '/Users/dev/demo-app',
        repository: null,
      })),
      gaps: [],
    }),
    meshConversationList: async () => ({
      ok: true,
      conversations,
      access: 'operate',
      modelSwitch: false,
      lifecycle: true,
      rowMenu: true,
      markUnread: true,
    }),
    meshVisitConversation: async () => ({ ok: true, workspaceId: 'rw1', lastVisitedAt: Date.now() }),
  }

  const React = await import('react')
  const { act } = React
  const { createRoot } = await import('react-dom/client')
  const { default: WorkspaceSidebar } = await import('./WorkspaceSidebar')
  const { useWorkspaceStore } = await import('../../store/workspaceStore')
  type SidebarProps = Parameters<typeof WorkspaceSidebar>[0]
  const noop = () => {}

  const local = (id: string, name: string, minutesAgo: number) => ({
    id,
    name,
    mode: 'standard',
    folderPath: '/projA',
    createdAt: now - 300 * minute,
    lastUserMessageAt: now - minutesAgo * minute,
  })
  // Opened here: a workspace of this desktop following the chat over there.
  const opened = (id: string, name: string, remoteWorkspaceId: string) => ({
    id,
    name,
    mode: 'standard',
    folderPath: null,
    agents: {},
    createdAt: now - 300 * minute,
    remoteOrigin: {
      connectionId: 'c1',
      machineName: 'mac-mini',
      workspaceId: remoteWorkspaceId,
      workspaceName: remoteWorkspaceId,
      workspaceRoot: '/Users/dev/demo-app',
      sessionId: meshConversationSessionId(remoteWorkspaceId, 'agent-1'),
    },
  })
  const baseProps = {
    activeWorkspaceId: 'w-idle',
    workspaceWindowId: 'win1',
    isDetachedWindow: false,
    sidebarCollapsed: false,
    chromeSlot: null,
    residentWorkspaceIds: new Set<string>(),
    terminalRecencyByWorkspaceId: {},
    onSelectWorkspace: noop,
    onOpenRemoteSession: noop,
    onMoveWorkspaceToNewWindow: noop,
    onMoveWorkspaceToMainWindow: noop,
    onCloseWorkspace: noop,
    onForgetFolder: noop,
    onNewChat: noop,
    onNewChatInFolder: noop,
    onRevealFolder: noop,
    onSetSidebarCollapsed: noop,
    sidebarWidth: 260,
    onSetSidebarWidth: noop,
  }

  const container = dom.window.document.createElement('div')
  dom.window.document.body.appendChild(container)
  const root = createRoot(container)
  const settle = async (ms = 0): Promise<void> => {
    await act(async () => {
      await new Promise((resolve) => dom.window.setTimeout(resolve, ms))
    })
    for (let i = 0; i < 6; i += 1) {
      await act(async () => {
        await new Promise((resolve) => dom.window.setTimeout(resolve, 0))
      })
    }
  }

  /** The sidebar with these rows and the machine listing these chats. */
  const show = async (input: {
    view: 'all' | 'projects' | 'status'
    working?: boolean
    conversations: Listed[]
    workspaces?: ReturnType<typeof local | typeof opened>[]
    activeWorkspaceId?: string
  }): Promise<void> => {
    const workspaces = input.workspaces ?? [local('w-idle', 'Local idle', 30), local('w-busy', 'Local busy', 10)]
    conversations = input.conversations
    useWorkspaceStore.setState(
      (state) =>
        ({
          workspaces,
          chatListView: input.view,
          chatListViewOverride: null,
          recordWorkspaceVisit: () => undefined,
          appSettings: { ...state.appSettings, sidebarWorkingSection: input.working !== false },
        }) as never,
    )
    const props = {
      ...baseProps,
      workspaces,
      activeWorkspaceId: input.activeWorkspaceId ?? 'w-idle',
      // Nothing of the machine's runs here: only `w-busy` is at work on this computer.
      activityByWorkspaceId: { 'w-busy': 'working' },
    } as unknown as SidebarProps
    act(() => {
      root.render(React.createElement(WorkspaceSidebar, props))
    })
    await settle()
    await push()
  }
  /** The machine says its chats moved. Waits out the read's short settle. */
  const push = async (next?: Listed[]): Promise<void> => {
    if (next) conversations = next
    await act(async () => {
      meshListener?.({
        kind: 'remote-changed',
        revision: ++revision,
        connectionId: 'c1',
        machineName: 'mac-mini',
        what: 'conversations',
      })
    })
    await settle(300)
  }

  const section = () => container.querySelector<HTMLElement>('section[aria-label="Working"]')
  const rowsIn = (scope: Element | null) =>
    [...(scope?.querySelectorAll<HTMLElement>('[role="treeitem"]') ?? [])].map(
      (row) => row.dataset.workspaceId ?? row.dataset.remoteConversation,
    )
  const tree = () => container.querySelector('[role="tree"]')
  const outside = () => rowsIn(tree()).filter((id) => !rowsIn(section()).includes(id))
  const header = (name: string) =>
    [...container.querySelectorAll<HTMLElement>('section header')].find((candidate) =>
      candidate.textContent?.includes(name),
    )

  return { dom, act, root, useWorkspaceStore, settle, show, push, section, rowsIn, tree, outside, header, opened }
}

beforeAll(async () => {
  harness = await createHarness()
})

afterAll(() => {
  const { act, root, useWorkspaceStore } = harness
  act(() => root.unmount())
  useWorkspaceStore.setState(
    (state) =>
      ({
        chatListView: 'projects',
        appSettings: { ...state.appSettings, sidebarWorkingSection: false },
      }) as never,
  )
})

test('switched off, a chat working over there stays in the list', async () => {
  const { show, section, outside } = harness
  await show({ view: 'all', working: false, conversations: [listed('rw1', 'Builds away', 'running', 2)] })
  assert.equal(section(), null)
  assert.ok(outside().includes(chatKey('rw1')))
})

test('a chat working over there and not open here folds into the section with the chats here', async () => {
  const { show, section, rowsIn, outside } = harness
  await show({
    view: 'all',
    conversations: [
      listed('rw1', 'Builds away', 'running', 2),
      listed('rw2', 'Older run', 'running', 20),
      listed('rw3', 'At rest', 'completed', 40),
    ],
  })
  assert.deepEqual(
    rowsIn(section()),
    [chatKey('rw1'), 'w-busy', chatKey('rw2')],
    'by when each was last written to, whichever machine it runs on',
  )
  assert.match(section()!.textContent ?? '', /Working\s*3/u, 'and counted')
  assert.deepEqual(outside(), ['w-idle', chatKey('rw3')], 'each left the stream, so no chat is drawn twice')
  assert.match(section()!.textContent ?? '', /demo-app/u, 'its project line says where it goes back to')
})

test('with nothing at work on this computer, a chat on a paired machine alone opens the section', async () => {
  const { show, section, rowsIn, opened } = harness
  await show({
    view: 'all',
    workspaces: [opened('w-open', 'Open here', 'rw2')],
    activeWorkspaceId: 'w-open',
    conversations: [listed('rw1', 'Builds away', 'running', 2), listed('rw2', 'Open here', 'completed', 5)],
  })
  assert.deepEqual(rowsIn(section()), [chatKey('rw1')])
})

test('by project, a chat working over there leaves its project, and a project with nothing else steps out', async () => {
  const { show, section, rowsIn, header } = harness
  await show({
    view: 'projects',
    conversations: [
      listed('rw1', 'Builds away', 'running', 2),
      listed('rw2', 'At rest', 'completed', 40),
      listed('rw4', 'Alone at work', 'running', 3),
    ],
  })
  assert.deepEqual(rowsIn(section()), [chatKey('rw1'), chatKey('rw4'), 'w-busy'])
  const project = header('demo-app')?.closest('section') ?? null
  assert.deepEqual(rowsIn(project), [chatKey('rw2')], 'its project keeps only the chat at rest')
  assert.equal(header('quiet-project'), undefined, 'a header over nothing is not drawn, as for a local chat')
})

test('the same rules as a local chat: starred, snoozed and waiting chats stay out', async () => {
  const { show, section, rowsIn, outside } = harness
  await show({
    view: 'all',
    conversations: [
      listed('rw1', 'Builds, starred', 'running', 2, { highlight: { starred: true, color: null } }),
      listed('rw2', 'Builds, snoozed', 'running', 3, { snoozedUntil: now + 60 * minute }),
      listed('rw3', 'Asks approval', 'waiting_for_approval', 4),
      listed('rw4', 'Stopped by an error', 'failed', 5),
    ],
  })
  assert.deepEqual(rowsIn(section()), ['w-busy'])
  assert.ok(outside().includes(chatKey('rw1')), 'a starred chat stays in Starred')
  assert.ok(outside().includes(chatKey('rw3')), 'a wait goes back to its seat')
  assert.ok(outside().includes(chatKey('rw4')), 'and so does a failed turn')
})

test('background work over there keeps a chat in the section, and stopping puts it back', async () => {
  const { show, push, section, rowsIn, outside } = harness
  const quiet = listed('rw1', 'Builds away', 'completed', 2)
  await show({ view: 'all', conversations: [{ ...quiet, backgroundWork: true }] })
  assert.ok(rowsIn(section()).includes(chatKey('rw1')), 'a monitor or sub-agent still at work is work')

  await push([listed('rw1', 'Builds away', 'waiting_for_input', 2)])
  assert.deepEqual(rowsIn(section()), ['w-busy'], 'it stopped on the person')
  assert.ok(outside().includes(chatKey('rw1')), 'and went back')

  await push([listed('rw1', 'Builds away', 'running', 2)])
  assert.ok(rowsIn(section()).includes(chatKey('rw1')), 'back at work, back in the section')

  await push([quiet])
  assert.deepEqual(rowsIn(section()), ['w-busy'], 'it finished')
  assert.ok(outside().includes(chatKey('rw1')), 'and went back')
})

test('a chat open here reads the same whether in front or not', async () => {
  const { show, section, rowsIn, outside, opened } = harness
  const workspaces = [opened('w-open', 'Builds away', 'rw1'), opened('w-other', 'Other', 'rw2')]
  const conversations = [listed('rw1', 'Builds away', 'running', 2), listed('rw2', 'Other', 'completed', 5)]
  await show({ view: 'all', workspaces, activeWorkspaceId: 'w-other', conversations })
  assert.deepEqual(rowsIn(section()), ['w-open'], 'open behind another chat, it is in the section')

  await show({ view: 'all', workspaces, activeWorkspaceId: 'w-open', conversations })
  assert.equal(section(), null, 'the chat in front stays where it is')
  assert.ok(outside().includes('w-open'))
})

test('by status, the switch changes nothing: the shelf at the foot holds them, and no section', async () => {
  const { show, section, tree, dom } = harness
  await show({ view: 'status', conversations: [listed('rw1', 'Builds away', 'running', 2)] })
  assert.equal(section(), null)
  const fold = [...tree()!.querySelectorAll<HTMLButtonElement>('button[aria-expanded]')].find((button) =>
    button.textContent?.startsWith('Working'),
  )
  assert.match(fold?.textContent ?? '', /Working\s*2/u, 'the chat here and the one over there')
  assert.ok(dom.window.document.querySelector('[role="group"][aria-label="Chats by status"]'))
})

test('a folded project counts a chat a failed turn stopped over there as waiting, as it does a local one', async () => {
  const { act, dom, settle, show, header } = harness
  await show({
    view: 'projects',
    working: false,
    conversations: [
      listed('rw1', 'Asks approval', 'waiting_for_approval', 2),
      listed('rw2', 'Stopped by an error', 'failed', 3),
      listed('rw3', 'At rest', 'completed', 4),
    ],
  })
  const fold = () => header('demo-app')!.querySelector<HTMLButtonElement>('button[aria-expanded]')!
  act(() => fold().dispatchEvent(new dom.window.MouseEvent('click', { bubbles: true })))
  await settle()
  assert.equal(header('demo-app')!.querySelector('[data-project-waiting]')?.textContent, '2 waiting')
  act(() => fold().dispatchEvent(new dom.window.MouseEvent('click', { bubbles: true })))
  await settle()
})
