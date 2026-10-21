import assert from 'node:assert/strict'

import { JSDOM } from 'jsdom'
import { test } from 'vitest'

test('WorkspaceSidebar.worktreeGroup', async () => {
  // A worktree chat files under the project it was cut from. New chat on a
  // worktree lands the checkout at `<parent>/.sprintengine-worktrees/<repo>/<slug>`
  // and points the chat's folderPath at it, so grouping by path alone gave the
  // chat a top-level header named after the slug — the person branched one
  // project, and the sidebar showed them two. The header is the parent's now,
  // and the row says what it is on its own line, via the branch chip.
  //
  // This mounts the real sidebar because headers, their actions and the row's
  // second line are what the ruling is about, and nothing below the component
  // draws them.

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

  // Which folder each header asked about on this disk — the header's own
  // account of what project it is.
  const detected: string[] = []
  domWindow.api = {
    platform: 'darwin',
    // A module's nav entry may subscribe to its own index on mount; a silent
    // subscription keeps the sidebar's later renders from throwing inside a
    // passive effect.
    detectProjectLogo: async (folderPath: string) => {
      detected.push(folderPath)
      return null
    },
    getGitRepositoryIdentity: async () => null,
  }

  // Every folder "New chat in project" was fired into.
  const newChatCalls: string[] = []

  let failures = 0
  function check(name: string, fn: () => void): void {
    try {
      fn()
      console.log(`ok - ${name}`)
    } catch (error) {
      failures += 1
      console.error(`not ok - ${name}`)
      console.error(error)
    }
  }

  const PARENT = '/home/dev/projects/sprintengine'
  const WORKTREE = '/home/dev/projects/.sprintengine-worktrees/sprintengine/perf-review-wholesale'

  async function main(): Promise<void> {
    const React = await import('react')
    const { act } = React
    const { createRoot } = await import('react-dom/client')
    const { default: WorkspaceSidebar } = await import('./WorkspaceSidebar')
    const { useWorkspaceStore } = await import('../../store/workspaceStore')
    // This suite walks the per-project tree, which is not the rail's default shape.
    useWorkspaceStore.setState({ chatListView: 'projects' })
    const { getRendererHost } = await import('../../modules')
    const { deriveWorkspaceRunGlyph } = await import('../../utils/workspaceRunGlyph')
    getRendererHost()
      .hostFor('scheduled-agents')
      .registerWorkspaceType({
        id: 'worktree-glyph-probe',
        label: 'Glyph probe',
        description: 'Test-only workspace type that always reports a running glyph.',
        icon: () => null,
        hiddenFromPicker: true,
        createTemplate: () => ({
          id: 'worktree-glyph-probe',
          name: 'Glyph probe',
          model: { global: {}, layout: { type: 'row', children: [] } },
        }),
        deriveRunGlyph: () => ({ state: 'running', live: true, label: 'Run in progress' }),
      } as never)

    type SidebarProps = Parameters<typeof WorkspaceSidebar>[0]
    const workspace = (id: string, name: string, folderPath: string | null, extra?: Record<string, unknown>) =>
      ({
        id,
        name,
        mode: 'standard',
        folderPath,
        layoutModel: { layout: { type: 'row', children: [] } },
        ...extra,
      }) as unknown

    assert.equal(
      deriveWorkspaceRunGlyph({ mode: 'worktree-glyph-probe' } as never)?.label,
      'Run in progress',
      'the probe type really is registered and enabled — otherwise the case below proves nothing',
    )

    const noop = () => {}
    const baseProps = {
      activeWorkspaceId: 'w1',
      workspaceWindowId: 'win1',
      isDetachedWindow: false,
      sidebarCollapsed: false,
      chromeSlot: null,
      activityByWorkspaceId: {},
      residentWorkspaceIds: new Set<string>(),
      terminalRecencyByWorkspaceId: {},
      onSelectWorkspace: noop,
      onMoveWorkspaceToNewWindow: noop,
      onMoveWorkspaceToMainWindow: noop,
      onForgetFolder: noop,
      onNewChat: noop,
      onNewChatInFolder: (folderPath: string) => newChatCalls.push(folderPath),
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
    }

    // Each case mounts its own tree: the grouping question is "what does the
    // sidebar show for THIS set of rows", and a shared mount would answer it
    // once.
    const mount = async (workspaces: unknown[]) => {
      const container = dom.window.document.createElement('div')
      dom.window.document.body.appendChild(container)
      const root = createRoot(container)
      const props = { ...baseProps, workspaces } as unknown as SidebarProps
      act(() => {
        root.render(React.createElement(WorkspaceSidebar, props))
      })
      for (let i = 0; i < 12; i += 1) await Promise.resolve()
      // The identity reads resolve off the event loop and their setState lands
      // through the scheduler, so the wait has to yield a macrotask inside act
      // for the grouping to settle.
      for (let i = 0; i < 3; i += 1) {
        await act(async () => {
          await new Promise((resolve) => dom.window.setTimeout(resolve, 0))
        })
      }
      const headers = () => [...container.querySelectorAll('button[aria-expanded]')]
      // The header's actions live behind its overflow button, in a menu that
      // portals out of the section — so open it and read it off the document.
      const folderMenuItems = (header: Element) => {
        const overflow = [...header.closest('header')!.querySelectorAll('button')].find((button) =>
          (button.getAttribute('aria-label') ?? '').startsWith('Folder actions'),
        )!
        act(() => {
          overflow.dispatchEvent(new dom.window.MouseEvent('click', { bubbles: true }))
        })
        const menu = dom.window.document.querySelector('[role="menu"]')
        const items = [...(menu?.querySelectorAll('[role="menuitem"]') ?? [])].map(
          (item) => item.textContent?.trim() ?? '',
        )
        act(() => {
          dom.window.document.dispatchEvent(new dom.window.KeyboardEvent('keydown', { key: 'Escape', bubbles: true }))
        })
        return items
      }
      // A row's own menu, opened from the actions button its seat reveals.
      const openRowMenu = (row: Element) => {
        const actions = [...row.querySelectorAll('button')].find(
          (button) => button.getAttribute('aria-label') === 'Workspace actions',
        )!
        act(() => {
          actions.dispatchEvent(new dom.window.MouseEvent('click', { bubbles: true }))
        })
        const menu = dom.window.document.querySelector('[role="menu"]')!
        const items = [...menu.querySelectorAll('[role="menuitem"]')]
        return {
          labels: items.map((item) => item.textContent?.trim() ?? ''),
          click: (label: string) => {
            const item = items.find((candidate) => (candidate.textContent?.trim() ?? '') === label)!
            act(() => {
              item.dispatchEvent(new dom.window.MouseEvent('click', { bubbles: true }))
            })
          },
        }
      }
      return {
        container,
        headers,
        folderMenuItems,
        openRowMenu,
        unmount: () => act(() => root.unmount()),
      }
    }

    {
      const view = await mount([
        workspace('w1', 'Alpha', PARENT),
        workspace('w2', 'Perf review', WORKTREE, {
          worktree: { branch: 'wt/perf-review-wholesale', repoRoot: PARENT },
        }),
      ])
      const headers = view.headers()
      check('a worktree chat and its parent share one header, named after the parent', () => {
        assert.deepEqual(
          headers.map((header) => header.textContent?.trim() ?? ''),
          ['sprintengine'],
          'one header, the project — not a second one named after the slug',
        )
        const rows = [...headers[0]!.closest('section')!.querySelectorAll('[role="treeitem"]')].map(
          (row) => row.textContent ?? '',
        )
        assert.equal(rows.length, 2, 'both chats are rows of the project')
        assert.ok(rows.some((text) => text.includes('Alpha')) && rows.some((text) => text.includes('Perf review')))
      })
      view.unmount()
    }

    {
      // The parent project is not open at all: the worktree row is the only
      // thing here, and the header still has to be the project's — its name,
      // its full path, and its actions live.
      const view = await mount([
        workspace('w1', 'Perf review', WORKTREE, {
          worktree: { branch: 'wt/perf-review-wholesale', repoRoot: PARENT },
        }),
      ])
      const headers = view.headers()
      check('a worktree chat alone still heads its project, with live actions', () => {
        assert.deepEqual(
          headers.map((header) => header.textContent?.trim() ?? ''),
          ['sprintengine'],
        )
        assert.ok(detected.includes(PARENT), 'the header asks the disk about the project')
        assert.ok(!detected.includes(WORKTREE), 'never about the worktree it was cut into')
        const items = view.folderMenuItems(headers[0]!)
        assert.ok(items.includes('New chat in project'), 'a project with no plain row open is still a live project')
        assert.ok(items.includes('Reveal folder'), 'and it can still be revealed')
      })
      view.unmount()
    }

    {
      // The worktree was pruned under the chat. That is the worktree's loss,
      // not the project's: painting the project missing would also take away
      // the header's New chat and Reveal.
      const view = await mount([
        workspace('w1', 'Alpha', PARENT),
        workspace('w2', 'Perf review', WORKTREE, {
          folderMissing: true,
          worktree: { branch: 'wt/perf-review-wholesale', repoRoot: PARENT },
        }),
      ])
      const headers = view.headers()
      check('a pruned worktree row does not mark its project missing', () => {
        const header = headers[0]!
        assert.ok(
          !(header.closest('header')!.textContent ?? '').includes('Missing'),
          'the project is right where it was',
        )
        const items = view.folderMenuItems(header)
        assert.ok(items.includes('New chat in project'), 'so the header keeps its New chat')
        assert.ok(items.includes('Reveal folder'))
        const section = header.closest('section')!
        const worktreeRow = [...section.querySelectorAll('[role="treeitem"]')].find((row) =>
          (row.textContent ?? '').includes('Perf review'),
        )!
        assert.ok(
          worktreeRow.querySelector('[aria-label="Folder missing"]'),
          'the row itself still says its folder is gone',
        )
        // And the row's own menu keeps New chat, because what went missing is
        // the worktree, not the project the item would create into.
        newChatCalls.length = 0
        const rowMenu = view.openRowMenu(worktreeRow)
        assert.ok(rowMenu.labels.includes('New chat in project'), 'a pruned worktree still has a project to chat in')
        assert.ok(!rowMenu.labels.includes('Reveal folder'), 'but nothing of its own left to reveal')
        rowMenu.click('New chat in project')
        assert.deepEqual(newChatCalls, [PARENT], 'and it fires into the project, not the worktree that is gone')
      })
      view.unmount()
    }

    {
      // Orchestrator ruling 2026-09-07: a parked chat says nothing about the
      // checkout's live state, but a worktree workspace's branch is a fact
      // about the workspace itself and survives having nothing running.
      const view = await mount([
        workspace('w1', 'Alpha', PARENT),
        workspace('w2', 'Perf review', WORKTREE, {
          worktree: { branch: 'wt/perf-review-wholesale', repoRoot: PARENT },
        }),
      ])
      check('a parked worktree row wears its branch chip', () => {
        const section = view.headers()[0]!.closest('section')!
        const rows = [...section.querySelectorAll('[role="treeitem"]')]
        const worktreeRow = rows.find((row) => (row.textContent ?? '').includes('Perf review'))!
        const text = worktreeRow.textContent ?? ''
        assert.ok(text.includes('wt/perf-review-wholesale'), 'the branch the app minted for it')
        assert.ok(text.includes('(worktree)'), 'and the sr-only word, since weight alone carries no meaning')
        assert.ok(!/[+−]\d/u.test(text), 'but no ± diff — that is live state a parked chat has no claim on')
        const plainRow = rows.find((row) => (row.textContent ?? '').includes('Alpha'))!
        assert.ok(!(plainRow.textContent ?? '').includes('(worktree)'), 'a plain parked row still says nothing')
      })
      view.unmount()
    }

    {
      // The row's status seat moved to line 2 when the branch chip gave a parked
      // row one, and the seat draws the run glyph itself — so line 1 must stop
      // drawing it, or a row whose module reports a run wears the glyph twice.
      const view = await mount([
        workspace('w1', 'Perf review', WORKTREE, {
          mode: 'worktree-glyph-probe',
          worktree: { branch: 'wt/perf-review-wholesale', repoRoot: PARENT },
        }),
      ])
      check('a parked worktree row with a run glyph draws it once', () => {
        const row = [...view.container.querySelectorAll('[role="treeitem"]')].find((candidate) =>
          (candidate.textContent ?? '').includes('Perf review'),
        )!
        assert.equal(
          row.querySelectorAll('[role="img"][aria-label^="Run in progress"]').length,
          1,
          'one run glyph, on the seat that line 2 now carries',
        )
      })
      view.unmount()
    }
  }

  const suiteRun = main()
    .then(() => {
      // Only a suite with nothing broken gets to say so: an unconditional line
      // here read as a pass over a run whose assertions had already failed.
      if (failures > 0) {
        process.exitCode = 1
        console.error(`workspace sidebar worktree group tests failed (${failures})`)
        return
      }
      console.log('workspace sidebar worktree group tests passed')
    })
    .catch((error) => {
      console.error(error)
      process.exitCode = 1
    })

  await suiteRun
})
