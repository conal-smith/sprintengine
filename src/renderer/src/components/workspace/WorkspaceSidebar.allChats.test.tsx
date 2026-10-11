import assert from 'node:assert/strict'

import { JSDOM } from 'jsdom'
import { test } from 'vitest'

import type { StudioPullRequest } from '../../../../../packages/studio-protocol/src/public'
import type { PullRequestsChanged, StudioPullRequests } from '../../../../server/pull-requests/pull-request-domain'
import { installStudioLoopback } from '../../../../../tests/studio-chat-loopback'

test('WorkspaceSidebar.allChats', async () => {
  // The flat stream (all-chats-view, 2026-09-07). "All chats" drops the folder
  // headers and lists every chat in one list, most recently active first with an
  // agent's turn counted as activity, each row naming the project it files
  // under. Which shape it draws is a persisted setting (Settings → Appearance),
  // so this drives it through the store the way that panel does.
  // `workspaceRecency.test.ts` holds the order; this holds the rail.

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
  anyGlobal.requestAnimationFrame = (callback: FrameRequestCallback) =>
    dom.window.setTimeout(() => callback(Date.now()), 0) as unknown as number
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

  let terminalAnswer: unknown[] = []
  domWindow.api = {
    platform: 'darwin',
    detectProjectLogo: async () => null,
    terminalList: async () => terminalAnswer,
    onTerminalSessionsDelta: () => () => {},
    getWorkspaceChangeSummary: async () => null,
    terminalKill: async () => {},
  }
  // The pull request record is the Studio server's, read over the window's
  // own client: a table the test fills, and a push naming what moved.
  const pullRequestAnswers: Record<string, StudioPullRequest[]> = {}
  /** By conversation, `workspaceId\0agentId`: what each chat's own agent opened. */
  const conversationPullRequestAnswers: Record<string, StudioPullRequest[]> = {}
  const pullRequestListeners = new Set<(change: PullRequestsChanged) => void>()
  const pullRequests: StudioPullRequests = {
    list: async (target) => {
      const workspaces: Record<string, StudioPullRequest[]> = {}
      for (const id of target.workspaceIds ?? []) if (pullRequestAnswers[id]) workspaces[id] = pullRequestAnswers[id]
      const conversations = (target.conversations ?? []).flatMap((key) => {
        const found = conversationPullRequestAnswers[`${key.workspaceId}\0${key.agentId}`]
        return found ? [{ ...key, pullRequests: found }] : []
      })
      return { workspaces, conversations }
    },
    refresh: async () => ({ asked: true }),
    noteWork: async () => undefined,
    noteToolCall: async () => undefined,
    link: async () => ({ ok: false, code: 'not_a_pull_request', message: 'not here' }),
    onChanged: (listener) => {
      pullRequestListeners.add(listener)
      return () => pullRequestListeners.delete(listener)
    },
  }
  installStudioLoopback(domWindow as { api?: Record<string, unknown> }, { pullRequests })

  async function main(): Promise<void> {
    const React = await import('react')
    const { act } = React
    const { createRoot } = await import('react-dom/client')
    const { default: WorkspaceSidebar } = await import('./WorkspaceSidebar')
    const { refreshTerminalSessions } = await import('../../hooks/useTerminalSessions')
    const { useWorkspaceStore } = await import('../../store/workspaceStore')
    type SidebarProps = Parameters<typeof WorkspaceSidebar>[0]
    type Workspace = SidebarProps['workspaces'][number]

    const MINUTE = 60 * 1000
    const HOUR = 60 * MINUTE
    const now = Date.now()
    const workspace = (id: string, name: string, folderPath: string, fields: Partial<Workspace> = {}): Workspace =>
      ({ id, name, mode: 'standard', folderPath, createdAt: now - 2 * HOUR, ...fields }) as unknown as Workspace

    // Three projects, ordered by when the PERSON last messaged each. Bravo is the
    // control: its agent finished a minute ago and a keystroke landed in it a
    // minute ago, but the person has not said anything there since yesterday, so
    // it must stay at the bottom rather than jump the row you were reaching for.
    const workspaces = [
      workspace('w1', 'Alpha', '/repo/apples', {
        lastUserMessageAt: now - 3 * HOUR,
        // The chat tab the conversation line further down stands for.
        layoutModel: {
          global: {},
          layout: {
            type: 'row',
            children: [
              {
                type: 'tabset',
                children: [{ type: 'tab', component: 'agent', config: { agentId: 'conversation-agent' } }],
              },
            ],
          },
        },
      }),
      workspace('w2', 'Bravo', '/repo/pears', {
        createdAt: now - 30 * HOUR,
        lastUserMessageAt: now - 26 * HOUR,
        lastTerminalActivityAt: now - MINUTE,
        lastTurnEndedAt: now - MINUTE,
      }),
      workspace('w3', 'Charlie', '/repo/apples', { lastUserMessageAt: now - 20 * MINUTE }),
      workspace('w4', 'Delta', '/repo/pears', {
        lastUserMessageAt: now - 10 * HOUR,
        settledAt: now - HOUR,
      }),
      // Echo is more recent than Charlie, so without the move-to-Starred rule it
      // would lead both lists. It must appear once, in Starred, in either shape.
      workspace('w5', 'Echo', '/repo/apples', {
        lastUserMessageAt: now - MINUTE,
        highlight: { starred: true, color: null },
      }),
    ]

    const noop = () => {}
    const props = {
      workspaces,
      workspaceWindowId: 'win1',
      isDetachedWindow: false,
      sidebarCollapsed: false,
      chromeSlot: null,
      residentWorkspaceIds: new Set<string>(),
      activeWorkspaceId: 'w1',
      activityByWorkspaceId: { w1: 'idle', w2: 'idle', w3: 'idle', w4: 'idle' },
      terminalRecencyByWorkspaceId: {},
      onSelectWorkspace: noop,
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
      authState: { authenticated: false },
      authMessage: null,
      accountOpen: false,
      setAccountOpen: noop,
      startLogin: noop,
      refreshAuthState: noop,
      logout: noop,
      openSettings: noop,
      settingsOpen: false,
    } as unknown as SidebarProps

    const container = dom.window.document.createElement('div')
    dom.window.document.body.appendChild(container)
    const root = createRoot(container)

    const settle = async (): Promise<void> => {
      for (let round = 0; round < 6; round += 1) {
        for (let i = 0; i < 12; i += 1) await Promise.resolve()
        await new Promise((resolve) => setTimeout(resolve, 0))
        act(() => {})
      }
    }

    const NAMES = ['Alpha', 'Bravo', 'Charlie', 'Delta', 'Echo']
    const rowNames = (): string[] =>
      [...container.querySelectorAll('[role="treeitem"]')]
        .map((row) => NAMES.find((name) => row.textContent?.includes(name)))
        .filter((name): name is string => name !== undefined)

    const starredNames = (): string[] =>
      [...(container.querySelector('#ws-starred-body')?.querySelectorAll('[role="treeitem"]') ?? [])]
        .map((row) => NAMES.find((name) => row.textContent?.includes(name)))
        .filter((name): name is string => name !== undefined)

    const streamOrFolderNames = (): string[] => {
      const starred = new Set(
        container.querySelector('#ws-starred-body')
          ? [...container.querySelector('#ws-starred-body')!.querySelectorAll('[role="treeitem"]')]
          : [],
      )
      return [...container.querySelectorAll('[role="treeitem"]')]
        .filter((row) => !starred.has(row))
        .map((row) => NAMES.find((name) => row.textContent?.includes(name)))
        .filter((name): name is string => name !== undefined)
    }

    const rowFor = (name: string): HTMLElement => {
      const row = [...container.querySelectorAll<HTMLElement>('[role="treeitem"]')].find((el) =>
        el.textContent?.includes(name),
      )
      assert.ok(row, `row ${name} is rendered`)
      return row
    }

    // The setting the Appearance panel writes. The rail reads it and draws the
    // shape; it has no control of its own to click (owner, 2026-09-07).
    const chooseView = (view: 'projects' | 'all') => {
      act(() => {
        useWorkspaceStore.getState().setChatListView(view)
      })
    }

    const folderHeadings = (): string[] =>
      [...container.querySelectorAll<HTMLElement>('nav header')].map((el) => el.textContent?.trim() ?? '')

    try {
      act(() => {
        root.render(React.createElement(WorkspaceSidebar, props))
      })
      await settle()

      // The stream is what the rail opens on; the walk below starts from the
      // tree so it can watch the switch in both directions.
      assert.equal(useWorkspaceStore.getState().chatListView, 'all', 'the stream is the default shape')
      chooseView('projects')
      await settle()
      assert.ok(
        folderHeadings().some((heading) => heading.includes('apples')),
        `the tree draws a header per project (got ${folderHeadings().join(' | ')})`,
      )
      assert.equal(
        container.querySelector('[role="radio"]'),
        null,
        'and the rail carries no view control of its own — the switch lives in Settings',
      )
      assert.deepEqual(starredNames(), ['Echo'], 'a starred chat sits in Starred')
      assert.equal(
        streamOrFolderNames().includes('Echo'),
        false,
        'and not also under its project — starring moves the row, it does not copy it',
      )
      assert.equal(rowNames().filter((name) => name === 'Echo').length, 1, 'so it is drawn once')

      chooseView('all')
      await settle()

      assert.equal(useWorkspaceStore.getState().chatListView, 'all')
      assert.deepEqual(folderHeadings(), [], 'the stream has no folder headers')
      assert.deepEqual(starredNames(), ['Echo'], 'Starred is the same section in the stream')
      assert.equal(streamOrFolderNames().includes('Echo'), false, 'and Echo is not also a stream row')
      assert.equal(rowNames().filter((name) => name === 'Echo').length, 1, 'once in this shape too')

      // Order: the chat the person messaged twenty minutes ago leads. Bravo's
      // agent finishing and the keystroke in it move nothing. Delta is resting
      // and is not in the stream. Echo is more recent than all of them and still
      // does not lead: it lives in Starred.
      assert.deepEqual(
        streamOrFolderNames(),
        ['Charlie', 'Alpha', 'Bravo'],
        'most recently messaged first; an agent turn and a keystroke are not the person speaking',
      )

      // Each row names the project it files under — the same name its folder
      // header carried a moment ago.
      assert.ok(rowFor('Bravo').textContent?.includes('pears'), 'a stream row names its project')
      assert.ok(rowFor('Charlie').textContent?.includes('apples'))

      // And gives back the indent it had under that header.
      assert.ok(rowFor('Bravo').className.includes('pl-1.5'), 'a stream row starts on the column edge')
      assert.equal(rowFor('Bravo').className.includes('pl-[26px]'), false)

      // Order is the clock's here, so there is no order to drag a row into.
      assert.equal(rowFor('Bravo').getAttribute('draggable'), 'false', 'no drag-to-reorder in the stream')

      // Resting chats are off the stream entirely (owner, 2026-09-28): no
      // Settled shelf at its foot, and Delta is nowhere on the rail —
      // Settings ▸ Settled chats is where it is found.
      const shelf = [...container.querySelectorAll<HTMLButtonElement>('button[aria-expanded]')].filter((button) =>
        button.textContent?.startsWith('Settled'),
      )
      assert.equal(shelf.length, 0, 'no Settled shelf at the foot of the stream')
      assert.equal(rowNames().includes('Delta'), false, 'and the resting chat is not drawn')

      // Back to the tree, and the headers come back.
      chooseView('projects')
      await settle()
      assert.equal(useWorkspaceStore.getState().chatListView, 'projects')
      assert.ok(
        folderHeadings().some((heading) => heading.includes('pears')),
        'the headers come back',
      )
      assert.deepEqual(starredNames(), ['Echo'], 'and Echo is still only in Starred')
      assert.equal(streamOrFolderNames().includes('Echo'), false, 'not under apples')

      // One chat can hold both a terminal agent and a conversation agent.
      // Each has its own head and the conversation's line carries its phase.
      terminalAnswer = [
        {
          sessionId: 'terminal-agent-1',
          workspaceId: 'w1',
          agentId: 'terminal-agent',
          agentName: 'CLI agent',
          kind: 'agent',
          processAlive: true,
          visible: true,
          suspended: false,
          reapExempt: false,
          startedAt: now - MINUTE,
          lastInputAt: now - MINUTE,
          lastOutputAt: now - MINUTE,
          lastVisibleAt: now,
          exitedAt: null,
          activity: { kind: 'working', since: now - MINUTE },
          fileChanges: [],
        },
      ]
      await act(async () => {
        await refreshTerminalSessions()
      })
      act(() => {
        root.render(
          React.createElement(WorkspaceSidebar, {
            ...props,
            conversationSessions: [
              {
                sessionId: 'conversation-1',
                workspaceId: 'w1',
                agentId: 'conversation-agent',
                providerId: 'claude-agent',
                modelId: 'model-1',
                status: 'awaiting_approval',
                createdAt: now - MINUTE,
                updatedAt: now,
              },
            ],
            activityByWorkspaceId: { ...props.activityByWorkspaceId, w1: 'needs-input' },
          }),
        )
      })
      await settle()
      const alpha = rowFor('Alpha')
      assert.equal(alpha.querySelectorAll('[data-peek-session]').length, 2, 'one terminal and one chat head')
      assert.ok(alpha.textContent?.includes('Needs approval'), 'the chat line states what is pending')
      assert.ok(
        alpha.querySelector('[aria-label="Claude Code chat"]'),
        'the chat head wears the mark of the CLI it rides',
      )

      // A chat's pull request sits on its chat's line, just after the agent's
      // mark, not on a line of its own above it. One an agent that is gone
      // opened in the same chat is not this line's, and keeps a line of its own.
      terminalAnswer = []
      const opened = (number: number, title: string): StudioPullRequest => ({
        url: `https://github.com/acme/apples/pull/${number}`,
        repoKey: 'github.com/acme/apples',
        repoName: 'apples',
        number,
        title,
        state: 'open',
        isDraft: false,
        openedAt: now - MINUTE - number,
        stateAt: now,
      })
      pullRequestAnswers.w1 = [opened(144, 'Agent tokens'), opened(90, 'An earlier agent’s')]
      conversationPullRequestAnswers['w1\0conversation-agent'] = [opened(144, 'Agent tokens')]
      await act(async () => {
        await refreshTerminalSessions()
      })
      act(() => {
        root.render(
          React.createElement(WorkspaceSidebar, {
            ...props,
            conversationSessions: [
              {
                sessionId: 'conversation-1',
                workspaceId: 'w1',
                agentId: 'conversation-agent',
                providerId: 'claude-agent',
                modelId: 'model-1',
                status: 'ready',
                createdAt: now - MINUTE,
                updatedAt: now,
              },
            ],
          }),
        )
      })
      await settle()
      // The server says the record moved; the sidebar asks again once the burst settles.
      for (const listener of pullRequestListeners) listener({ workspaceIds: ['w1'], conversations: [] })
      await act(async () => {
        await new Promise((resolve) => setTimeout(resolve, 300))
      })
      await settle()
      const chatLine = rowFor('Alpha').querySelector('[data-peek-session="conversation-1"]')
      const mark = chatLine?.querySelector('[data-pull-request-mark]')
      assert.ok(mark, 'the mark is on the chat line')
      assert.equal(mark?.getAttribute('data-pull-request-mark'), 'https://github.com/acme/apples/pull/144', 'its own')
      const agentMark = chatLine?.querySelector('[aria-label="Claude Code chat"]')
      assert.ok(
        agentMark && agentMark.compareDocumentPosition(mark!) & dom.window.Node.DOCUMENT_POSITION_FOLLOWING,
        'just after the agent that opened it',
      )
      const marks = [...rowFor('Alpha').querySelectorAll('[data-pull-request-mark]')].map((node) =>
        node.getAttribute('data-pull-request-mark'),
      )
      assert.deepEqual(
        marks.sort(),
        ['https://github.com/acme/apples/pull/144', 'https://github.com/acme/apples/pull/90'],
        'each drawn once: the chat’s on its line, the earlier agent’s on the row’s own',
      )

      // A chat babysitting its pull request: between turns its line says what
      // the pull request waits on, in words, and the row reads as working.
      const watched = { ...opened(144, 'Agent tokens'), watch: { since: now, waitingOn: 'checks-failed' as const } }
      pullRequestAnswers.w1 = [watched, opened(90, 'An earlier agent’s')]
      conversationPullRequestAnswers['w1\0conversation-agent'] = [watched]
      for (const listener of pullRequestListeners) listener({ workspaceIds: ['w1'], conversations: [] })
      await act(async () => {
        await new Promise((resolve) => setTimeout(resolve, 300))
      })
      await settle()
      const watchedLine = rowFor('Alpha').querySelector('[data-peek-session="conversation-1"]')
      const words = watchedLine?.querySelector('[data-pull-request-watch]')
      assert.equal(words?.textContent, 'Check failed', 'the words, not a dot')
      assert.equal(words?.getAttribute('data-pull-request-watch'), 'checks-failed')
      const seat = rowFor('Alpha').querySelector('[role="img"][aria-label^="Watching pull request"]')
      assert.match(seat?.getAttribute('aria-label') ?? '', /144$/, 'the working mark, named for the watch')
    } finally {
      act(() => {
        root.unmount()
      })
      useWorkspaceStore.setState({ chatListView: 'all' })
    }
  }

  const suiteRun = main()
    .then(() => console.log('workspace sidebar all-chats view tests passed'))
    .catch((error) => {
      console.error(error)
      process.exitCode = 1
    })

  await suiteRun
})
