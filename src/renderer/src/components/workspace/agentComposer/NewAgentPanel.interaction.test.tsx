import assert from 'node:assert/strict'

import { JSDOM } from 'jsdom'
import { standInImageDecoding } from '../../../../../../tests/image-decoding'
import { composerDisabled, composerField, composerText, typeIntoComposer } from '../../../../../../tests/composer-field'
import { test, vi } from 'vitest'

// The "+" menu as the panel renders it, counted: a pass-through behind the
// same memo, so a count that moves is a prop that changed identity.
const plusMenuRenders = vi.hoisted(() => ({ count: 0 }))
vi.mock('./ComposerPlusMenu', async (importOriginal) => {
  const actual = await importOriginal<typeof import('./ComposerPlusMenu')>()
  const React = (await import('react')).default
  return {
    ...actual,
    ComposerPlusMenu: React.memo(function CountedPlusMenu(props: React.ComponentProps<typeof actual.ComposerPlusMenu>) {
      plusMenuRenders.count += 1
      return React.createElement(actual.ComposerPlusMenu, props)
    }),
  }
})

test('NewAgentPanel interaction', async () => {
  // The launch surface behind the tab strip's "+". Rendered for real,
  // because the acceptance is about what a person sees and presses:
  //
  //   1. the row shows what a launch usually changes — the engine and its
  //      access — while how it starts and what it starts with are behind the
  //      "+", and where it runs is on the strip under the box;
  //   2. the invocation main renders rides Start's hover, not a line of chrome;
  //   3. Start hands the host a confirm plus the typed prompt — and creates
  //      nothing itself;
  //   4. a suggestion card spawns on click, carrying its own full prompt;
  //   5. the skill trigger is the CLI's declared one, and a CLI that declares
  //      none still gets the Skills & MCPs picker, which every launch has;
  //   6. there is no greeting, signed in or not;
  //   7. with no agent CLI installed the surface offers the install route rather
  //      than controls that would fail on click.

  const dom = new JSDOM('<!doctype html><html><body></body></html>', {
    url: 'http://localhost',
    pretendToBeVisual: true,
  })

  const anyGlobal = globalThis as unknown as Record<string, unknown>
  anyGlobal.window = dom.window
  anyGlobal.document = dom.window.document
  anyGlobal.navigator = dom.window.navigator
  anyGlobal.HTMLElement = dom.window.HTMLElement
  anyGlobal.HTMLInputElement = dom.window.HTMLInputElement
  anyGlobal.HTMLTextAreaElement = dom.window.HTMLTextAreaElement
  anyGlobal.MutationObserver = dom.window.MutationObserver
  anyGlobal.Node = dom.window.Node
  anyGlobal.MouseEvent = dom.window.MouseEvent
  anyGlobal.KeyboardEvent = dom.window.KeyboardEvent
  anyGlobal.FileReader = dom.window.FileReader
  anyGlobal.File = dom.window.File
  standInImageDecoding(dom.window)
  anyGlobal.getComputedStyle = dom.window.getComputedStyle
  anyGlobal.IS_REACT_ACT_ENVIRONMENT = true
  class ResizeObserverStub {
    observe(): void {}
    unobserve(): void {}
    disconnect(): void {}
  }
  anyGlobal.ResizeObserver = ResizeObserverStub
  ;(dom.window as unknown as Record<string, unknown>).ResizeObserver = ResizeObserverStub
  dom.window.HTMLElement.prototype.scrollIntoView = function scrollIntoView(): void {}
  dom.window.matchMedia = ((query: string) => ({
    matches: false,
    media: query,
    addEventListener: () => {},
    removeEventListener: () => {},
  })) as unknown as typeof dom.window.matchMedia
  anyGlobal.requestAnimationFrame = (cb: FrameRequestCallback) => dom.window.setTimeout(() => cb(0), 0)
  anyGlobal.cancelAnimationFrame = (id: number) => dom.window.clearTimeout(id)

  // What main answers for a preview. The real handler renders through the spawn's
  // own argv renderer; here it stands in so the test can assert the surface SHOWS
  // what main said, verbatim, rather than composing a line of its own.
  const previewCalls: Array<Record<string, unknown>> = []
  const registered: string[] = []
  const PREVIEW_DISPLAY = 'claude --model claude-opus-5'

  // The mesh the remote-machine tests drive (remote-sessions-ux /
  // new-chat-on-a-remote-machine). Reassigned per check.
  let meshConnections: Array<Record<string, unknown>> = []
  let meshBrowseAnswer: (connectionId: string) => Record<string, unknown> = () => ({
    connectionId: 'c',
    reachable: true,
    unreachableReason: null,
    unauthorized: false,
    scopes: [],
    workspaces: [],
    gaps: [],
  })

  // Which repository a local folder is (one-project-across-machines); null = no remote.
  let localIdentityAnswer: (folderPath: string) => Record<string, unknown> | null = () => null
  // The picked remote project's checkout facts (checkout-and-branch-on-remote-create).
  let meshCheckoutAnswer: (connectionId: string, workspaceId: string) => Record<string, unknown> = (
    _c,
    workspaceId,
  ) => ({
    ok: true,
    checkout: {
      workspaceId,
      git: true,
      branch: 'main',
      defaultBranch: 'main',
      branches: [{ name: 'main', current: true }],
      worktrees: [],
    },
  })

  // This computer's machines (Settings ▸ Machines). Empty reads as one
  // machine, which is every platform but a Windows with WSL turned on.
  let hostsAnswer: { hosts: Array<Record<string, unknown>>; wsl: unknown } = { hosts: [], wsl: null }
  const detectCalls: unknown[] = []
  // The CLIs a WSL machine's detection finds there.
  const claudeOnly = {
    'claude-code': { cli: 'claude-code', installed: true, resolvedPath: '/usr/bin/claude', version: '1' },
  }
  let detectAnswer: Record<string, unknown> = claudeOnly

  ;(dom.window as unknown as { api: Record<string, unknown> }).api = {
    platform: 'darwin',
    hostsList: async () => hostsAnswer,
    onHostsChanged: () => () => {},
    pluginsDetectAvailability: async (input: unknown) => {
      detectCalls.push(input)
      return { ok: true, availability: detectAnswer }
    },
    getGitRepoRoot: async () => '/proj',
    meshListConnections: async () => meshConnections,
    meshBrowse: async (connectionId: string) => meshBrowseAnswer(connectionId),
    meshWorkspaceCheckout: async (connectionId: string, workspaceId: string) =>
      meshCheckoutAnswer(connectionId, workspaceId),
    getGitRepositoryIdentity: async (folderPath: string) => localIdentityAnswer(folderPath),
    onMeshEvent: () => () => {},
    defaultWorkspaceParentDir: async () => '/w',
    getPathForFile: (file: { name?: string }) =>
      file?.name === 'Q3 budget.xlsx' ? '/Users/dev/Desktop/Q3 budget.xlsx' : '/tmp/shot.png',
    // A document from the system, by path; a picture or a paste has none here.
    // Each call is main being told the person attached it.
    attachFile: (file: { name?: string }) => {
      const path = file?.name === 'Q3 budget.xlsx' ? '/Users/dev/Desktop/Q3 budget.xlsx' : ''
      if (path) registered.push(path)
      return path
    },
    saveDroppedImage: async () => '/tmp/shot.png',
    agentLaunchPreview: async (input: Record<string, unknown>) => {
      previewCalls.push(input)
      return {
        ok: true,
        preview: { binary: 'claude', args: PREVIEW_DISPLAY.split(' ').slice(1), display: PREVIEW_DISPLAY },
      }
    },
    // The skill type-ahead reads the picker's inventory; an empty one is enough
    // to prove the trigger opens (and keeps this test off the capability service).
    agentCapabilities: async () => ({
      ok: true,
      support: 'native',
      harnessId: 'claude',
      skills: [{ id: 'backlog', name: 'backlog', description: 'Work a backlog item end to end', source: 'builtin' }],
      diagnostics: [],
    }),
    builtinSkillsList: async () => [
      {
        id: 'backlog',
        name: 'backlog',
        version: '1',
        description: 'Work a backlog item end to end',
        targetPolicy: 'all-native',
      },
      {
        id: 'design-system',
        name: 'design-system',
        version: '1',
        description: 'Build UI from the attached design system',
        targetPolicy: 'all-native',
      },
    ],
    workspaceSkillsList: async () => ({ ok: true, skills: [] }),
    // The Skills & MCPs picker's install-on-pick and add-on-pick paths.
    agentSkillAttach: async (input: Record<string, unknown>) => {
      attachCalls.push(input)
      return { ok: true, skillId: input.skillId, targets: [{ path: '.claude/skills/x', status: 'installed' }] }
    },
    mcpSync: async (input: Record<string, unknown>) => {
      syncCalls.push(input)
      if (syncFailure) return { ok: false, message: syncFailure }
      const settings = input.settings as { servers: Record<string, unknown> }
      return {
        ok: true,
        targets: [{ client: 'claude-code', path: '/proj/.mcp.json', serverIds: Object.keys(settings.servers) }],
        issues: [],
      }
    },
  }
  // The MCP server these checks pick. It is INSTALLED — since the third-party
  // retirement (2026-09-08) there is no catalogue to offer one from, so
  // the picker's rows are the workspace's own servers and nothing else. Its
  // `clients` deliberately do NOT include the launch CLI, because that is what
  // still makes picking it a real write: the pick adds the CLI and syncs the
  // workspace config before the server counts as picked.
  const LINEAR = {
    id: 'linear',
    name: 'Linear',
    description: 'Issues and projects',
    transport: 'http' as const,
    url: 'https://mcp.linear.app/sse',
    enabled: true,
    required: false,
    clients: ['codex'],
    scope: 'workspace' as const,
    source: 'custom' as const,
    riskLevel: 'network' as const,
  }

  const attachCalls: Array<Record<string, unknown>> = []
  const syncCalls: Array<Record<string, unknown>> = []
  let syncFailure: string | null = null

  async function main(): Promise<void> {
    const React = (await import('react')).default
    const { act } = await import('react')
    const { createRoot } = await import('react-dom/client')
    const NewAgentPanel = (await import('./NewAgentPanel')).default
    const { useWorkspaceStore } = await import('../../../store/workspaceStore')
    const { __resetCliPermissionPresetsForTest } = await import('../../ui/cliPermissionPresets')

    let failures = 0
    // Every mounted harness, so a check that throws before its own unmount
    // cannot leave a stale panel (and its open popovers) in the document for
    // the next check to query.
    const liveViews = new Set<{ unmount: () => void }>()
    const check = async (name: string, fn: () => Promise<void>): Promise<void> => {
      try {
        await fn()
        console.log(`ok - ${name}`)
      } catch (error) {
        failures += 1
        console.error(`not ok - ${name}`)
        console.error(error)
      } finally {
        for (const view of [...liveViews]) view.unmount()
      }
    }

    const seedStore = (options: { plugins?: unknown[]; workspace?: Record<string, unknown> } = {}): void => {
      // Permissions are remembered per CLI, in the store's launch-settings read
      // model, which would otherwise carry a preset from one check into the next.
      __resetCliPermissionPresetsForTest()
      const plugins = options.plugins ?? [
        {
          id: 'claude-code',
          displayName: 'Claude Code',
          source: 'bundled',
          version: 1,
          binary: 'claude',
          resumeSession: true,
          sessionIdFromCaller: true,
          reasoningSelection: { levels: [{ id: 'low' }, { id: 'medium' }, { id: 'high' }] },
          skillIntegration: {
            support: 'native',
            harnessId: 'claude',
            installTargets: [],
            invocation: { explicitTemplate: '/{{skillId}}', nativeSlashCommand: true, mentionPrefix: '/' },
          },
        },
      ]
      useWorkspaceStore.setState({
        workspaces: [
          {
            ...useWorkspaceStore.getState().workspaces[0],
            id: 'ws-1',
            name: 'sprintengine',
            folderPath: '/proj',
            mode: 'standard',
            agents: {},
            layoutModel: undefined,
            ...options.workspace,
          },
        ] as never,
        activeWorkspaceId: 'ws-1',
        pluginCatalogEntries: plugins as never,
        pluginCatalogStatus: 'ready' as never,
        appSettings: {
          ...useWorkspaceStore.getState().appSettings,
          mcp: { syncEnabled: true, servers: { linear: { ...LINEAR } } },
          // Engine picks persist on the store; a check that opens the picker
          // would otherwise leave its remembered engine for the next one.
          lastSelectedCli: 'claude-code',
          lastSelectedAgentModel: null,
        },
      } as never)
    }

    type Harness = {
      container: HTMLElement
      unmount: () => void
      launches: Array<Record<string, unknown>>
      closed: () => number
      text: () => string
      find: (predicate: (el: HTMLElement) => boolean) => HTMLElement | undefined
    }

    const render = async (props: Record<string, unknown> = {}): Promise<Harness> => {
      const container = dom.window.document.createElement('div')
      dom.window.document.body.appendChild(container)
      const root = createRoot(container)
      const launches: Array<Record<string, unknown>> = []
      let closes = 0
      await act(async () => {
        root.render(
          React.createElement(NewAgentPanel, {
            workspaceId: 'ws-1',
            initialSelection: { kind: 'general' },
            permissionPreset: 'none',
            onLaunch: (launch: Record<string, unknown>) => launches.push(launch),
            onClose: () => {
              closes += 1
            },
            ...props,
          } as never),
        )
      })
      // Let the preview IPC and the git-repo probe settle.
      await act(async () => {
        await new Promise((resolve) => dom.window.setTimeout(resolve, 0))
      })
      const harness: Harness = {
        container,
        unmount: () => {
          liveViews.delete(harness)
          act(() => root.unmount())
          container.remove()
        },
        launches,
        closed: () => closes,
        text: () => container.textContent ?? '',
        find: (predicate) =>
          [...container.querySelectorAll('button, span, p')].find((el) => predicate(el as HTMLElement)) as
            HTMLElement | undefined,
      }
      liveViews.add(harness)
      return harness
    }

    // The "+" menu, and a Start as choice picked from it.
    const openOptions = async (view: Harness): Promise<Element | null> => {
      const plus = view.container.querySelector<HTMLElement>('button[aria-label="Options"]')
      await act(async () => {
        plus!.dispatchEvent(new dom.window.MouseEvent('click', { bubbles: true }))
      })
      return dom.window.document.querySelector('[aria-label="Options"][role="menu"]')
    }
    // Open the skills picker from its row of the "+" menu; it opens on the "+".
    const openSkills = async (view: Harness): Promise<void> => {
      const menu = await openOptions(view)
      const row = [...(menu?.querySelectorAll<HTMLElement>('[data-menu-item="true"]') ?? [])].find((item) =>
        (item.textContent ?? '').includes('Skills, plugins & MCPs'),
      )
      assert.ok(row, 'the "+" offers skills, plugins and MCPs')
      await act(async () => {
        row!.dispatchEvent(new dom.window.MouseEvent('click', { bubbles: true }))
      })
      await act(async () => {
        await new Promise((resolve) => dom.window.setTimeout(resolve, 0))
      })
    }
    const pickKind = async (view: Harness, kind: 'conversation' | 'general' | 'terminal'): Promise<void> => {
      const menu = await openOptions(view)
      const tile = menu?.querySelector<HTMLElement>(`[data-start-as="${kind}"]`)
      assert.ok(tile, `the "+" offers ${kind}`)
      await act(async () => {
        tile!.dispatchEvent(new dom.window.MouseEvent('click', { bubbles: true }))
      })
    }

    // ── Keyboard and the "+" menu ─────────────────────────────────────────────
    const typeInto = async (view: Harness, text: string): Promise<HTMLElement> => {
      const field = composerField(view.container)
      await act(async () => {
        typeIntoComposer(field, text)
      })
      return field
    }
    const plusOf = (view: Harness): HTMLElement =>
      view.container.querySelector<HTMLElement>('button[aria-label="Options"]')!
    const pressEscape = async (target: EventTarget = dom.window.document.activeElement ?? dom.window.document) => {
      await act(async () => {
        target.dispatchEvent(
          new dom.window.KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true }),
        )
      })
    }
    const settle = async () => {
      await act(async () => {
        await new Promise((resolve) => dom.window.setTimeout(resolve, 0))
      })
    }

    await check('Enter sends; Shift+Enter and an IME composition do not', async () => {
      seedStore()
      const view = await render({ initialSelection: { kind: 'conversation' } })
      const field = await typeInto(view, 'hi')
      await act(async () => {
        field.dispatchEvent(
          new dom.window.KeyboardEvent('keydown', { key: 'Enter', shiftKey: true, bubbles: true, cancelable: true }),
        )
      })
      assert.equal(view.launches.length, 0, 'Shift+Enter is a new line')
      await act(async () => {
        field.dispatchEvent(
          new dom.window.KeyboardEvent('keydown', { key: 'Enter', isComposing: true, bubbles: true, cancelable: true }),
        )
      })
      assert.equal(view.launches.length, 0, 'Enter that commits an IME composition is not a send')
      // WebKit's committing Enter: the composition has already ended, but the
      // key is still the input method's.
      await act(async () => {
        field.dispatchEvent(
          new dom.window.KeyboardEvent('keydown', { key: 'Enter', keyCode: 229, bubbles: true, cancelable: true }),
        )
      })
      assert.equal(view.launches.length, 0, 'an Enter sent as keyCode 229 is not a send either')
      await act(async () => {
        field.dispatchEvent(new dom.window.KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true }))
      })
      assert.equal(view.launches.length, 1, 'a plain Enter sends')
      view.unmount()
    })

    await check('the "+" is a menu button, and the send is named', async () => {
      seedStore()
      const view = await render({ initialSelection: { kind: 'conversation' } })
      const plus = plusOf(view)
      assert.equal(plus.getAttribute('aria-haspopup'), 'menu')
      assert.equal(plus.getAttribute('aria-expanded'), 'false')
      const menu = await openOptions(view)
      assert.ok(menu, 'it opens a menu named Options')
      assert.equal(plus.getAttribute('aria-expanded'), 'true')
      assert.equal(plus.getAttribute('aria-controls'), menu!.id, 'the trigger points at its menu')
      for (const item of menu!.querySelectorAll('[data-menu-item="true"]')) {
        assert.match(item.getAttribute('role') ?? '', /^menuitem/, `${item.textContent} is a menu item`)
      }
      assert.equal(menu!.querySelectorAll('[data-start-as]').length, 3, 'every kind a launch can start as')
      assert.ok(menu!.querySelector('[data-start-as][aria-checked="true"]'), 'the current kind is checked')
      await pressEscape()
      const send = [...view.container.querySelectorAll('button')].find(
        (button) => button.getAttribute('aria-label') === 'Start agent',
      )
      assert.ok(send, 'the icon-only send has a name')
      view.unmount()
    })

    await check('Escape closes the "+" menu, keeps the panel, and returns focus to the "+"', async () => {
      seedStore()
      const view = await render({ initialSelection: { kind: 'conversation' } })
      const menu = await openOptions(view)
      await settle()
      assert.ok(menu?.contains(dom.window.document.activeElement), 'focus moves into the menu on open')
      await pressEscape()
      assert.equal(dom.window.document.querySelector('[aria-label="Options"][role="menu"]'), null, 'the menu closes')
      assert.equal(view.closed(), 0, 'and the panel stays: the menu took the Escape')
      assert.ok(dom.window.document.activeElement === plusOf(view), 'focus is back on the "+"')
      view.unmount()
    })

    await check('picking a kind from the "+" leaves focus on the "+", not on the page', async () => {
      seedStore()
      const view = await render({ initialSelection: { kind: 'conversation' } })
      const menu = await openOptions(view)
      await settle()
      const tile = menu!.querySelector<HTMLElement>('[data-start-as="general"]')!
      await act(async () => {
        tile.focus()
        tile.dispatchEvent(new dom.window.MouseEvent('click', { bubbles: true }))
      })
      await settle()
      assert.equal(dom.window.document.querySelector('[aria-label="Options"][role="menu"]'), null)
      assert.ok(
        dom.window.document.activeElement === plusOf(view),
        'a keyboard user is not dropped to the top of the document',
      )
      view.unmount()
    })

    await check('arrowing in the open "+" menu is not undone by a re-render', async () => {
      seedStore()
      const view = await render({ initialSelection: { kind: 'conversation' } })
      const menu = await openOptions(view)
      await settle()
      const checked = menu!.querySelector<HTMLElement>('[data-start-as="conversation"]')!
      assert.ok(dom.window.document.activeElement === checked, 'the checked kind takes focus on open')
      await act(async () => {
        checked.dispatchEvent(new dom.window.KeyboardEvent('keydown', { key: 'ArrowDown', bubbles: true }))
      })
      const moved = dom.window.document.activeElement
      assert.ok(moved !== checked, 'the arrow moved focus')
      // Anything that re-renders the panel while the menu is open: typing
      // elsewhere, a preview arriving, a store write.
      await act(async () => {
        useWorkspaceStore.setState({
          appSettings: { ...useWorkspaceStore.getState().appSettings, cliRuntimes: {} },
        } as never)
      })
      await settle()
      assert.ok(dom.window.document.activeElement === moved, 'focus stays where the person put it')
      await pressEscape()
      view.unmount()
    })

    await check('Escape in another pane leaves the "+" tab and its prompt alone', async () => {
      seedStore()
      const view = await render({ initialSelection: { kind: 'conversation' } })
      await typeInto(view, 'half a thought')
      const elsewhere = dom.window.document.createElement('input')
      dom.window.document.body.appendChild(elsewhere)
      try {
        await pressEscape(elsewhere)
        assert.equal(view.closed(), 0, 'an Escape in a field outside the panel is not a cancel')
        await pressEscape(dom.window.document.body)
        assert.equal(view.closed(), 0, 'nor one with nothing focused, beside other panes')
        await pressEscape(composerField(view.container))
        assert.equal(view.closed(), 1, 'an Escape on the panel still cancels')
      } finally {
        elsewhere.remove()
        view.unmount()
      }
    })

    await check('the door closes on an Escape with nothing focused', async () => {
      seedStore()
      const view = await render({ initialSelection: { kind: 'conversation' }, showCloseButton: true })
      view.container.setAttribute('data-new-chat-door', '')
      await pressEscape(dom.window.document.body)
      assert.equal(view.closed(), 1)
      view.unmount()
    })

    await check('an Escape that drops an input method’s candidates keeps New chat and its draft', async () => {
      seedStore()
      const view = await render({ initialSelection: { kind: 'conversation' } })
      const field = await typeInto(view, 'にほん')
      for (const init of [{ isComposing: true }, { keyCode: 229 }]) {
        await act(async () => {
          field.dispatchEvent(
            new dom.window.KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true, ...init }),
          )
        })
      }
      assert.equal(view.closed(), 0)
      assert.equal(composerText(field), 'にほん')
      view.unmount()
    })

    await check('the skills picker opened from the "+" closes on Escape back to the "+"', async () => {
      seedStore()
      const view = await render({ initialSelection: { kind: 'conversation' } })
      await openSkills(view)
      const dialog = dom.window.document.querySelector('[role="dialog"]')
      assert.ok(dialog, 'the picker opens')
      await pressEscape()
      assert.equal(dom.window.document.querySelector('[role="dialog"]'), null, 'Escape closes it')
      assert.equal(view.closed(), 0, 'and not the panel')
      assert.ok(dom.window.document.activeElement === plusOf(view), 'focus is back on the "+"')
      view.unmount()
    })

    await check('typing in the prompt does not redraw the "+" menu', async () => {
      seedStore()
      const view = await render({ initialSelection: { kind: 'conversation' }, draftKey: 'win-plus' })
      await settle()
      const before = plusMenuRenders.count
      for (const text of ['r', 're', 'rev', 'review the diff']) await typeInto(view, text)
      await settle()
      assert.equal(plusMenuRenders.count, before, 'its props held steady through every keystroke')
      view.unmount()
    })

    // ── Attachments ───────────────────────────────────────────────────────────
    await check('an image picked through Attach files is staged and rides the launch', async () => {
      seedStore()
      const view = await render({ initialSelection: { kind: 'conversation' } })
      const menu = await openOptions(view)
      const attach = [...menu!.querySelectorAll<HTMLElement>('[data-menu-item="true"]')].find((item) =>
        (item.textContent ?? '').includes('Attach files'),
      )
      assert.ok(attach, 'the "+" offers Attach files')
      const input = view.container.querySelector<HTMLInputElement>('input[type="file"]')!
      let opened = 0
      input.click = () => {
        opened += 1
      }
      await act(async () => {
        attach!.dispatchEvent(new dom.window.MouseEvent('click', { bubbles: true }))
      })
      assert.equal(opened, 1, 'it opens the system dialog')
      const file = new dom.window.File([new Uint8Array([137, 80, 78, 71])], 'shot.png', { type: 'image/png' })
      Object.defineProperty(input, 'files', { value: [file], configurable: true })
      await act(async () => {
        input.dispatchEvent(new dom.window.Event('change', { bubbles: true }))
      })
      await act(async () => new Promise((resolve) => setTimeout(resolve, 20)))
      assert.ok(view.container.querySelector('img[src^="data:image/png"]'), 'the image is staged on the box')
      const field = await typeInto(view, 'look')
      await act(async () => {
        field.dispatchEvent(new dom.window.KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true }))
      })
      assert.equal(view.launches.length, 1)
      assert.equal(view.launches[0]!.prompt, 'look', 'the prompt is only what was typed')
      assert.deepEqual(view.launches[0]!.images, ['/tmp/shot.png'], 'the image rides the launch as an image')
      view.unmount()
    })

    await check('staging stops at the images one message can carry, and says why', async () => {
      seedStore()
      const { writeNewChatDraft, resetNewChatDraftsForTests } = await import('./newChatDraft')
      const { MAX_ATTACHMENTS_PER_TURN } = await import('../../panels/agentChat/imageAttachments')
      resetNewChatDraftsForTests()
      writeNewChatDraft('win-full', {
        images: Array.from({ length: MAX_ATTACHMENTS_PER_TURN - 1 }, (_, index) => ({
          id: `img-${index}`,
          mediaType: 'image/png',
          dataBase64: 'iVBORw0K',
          byteLength: 4,
          path: `/tmp/${index}.png`,
        })),
      })
      const view = await render({ draftKey: 'win-full', initialSelection: { kind: 'conversation' } })
      const staged = () => view.container.querySelectorAll('img[src^="data:image/png"]').length
      assert.equal(staged(), MAX_ATTACHMENTS_PER_TURN - 1)
      const input = view.container.querySelector<HTMLInputElement>('input[type="file"]')!
      const png = (name: string) =>
        new dom.window.File([new Uint8Array([137, 80, 78, 71])], name, { type: 'image/png' })
      Object.defineProperty(input, 'files', { value: [png('a.png'), png('b.png')], configurable: true })
      await act(async () => {
        input.dispatchEvent(new dom.window.Event('change', { bubbles: true }))
      })
      await act(async () => new Promise((resolve) => setTimeout(resolve, 20)))
      assert.equal(staged(), MAX_ATTACHMENTS_PER_TURN, 'the one that fits is staged, the one past it is not')
      assert.match(view.text(), new RegExp(`at most ${MAX_ATTACHMENTS_PER_TURN} images`), 'and the box says why')
      view.unmount()
      resetNewChatDraftsForTests()
    })

    await check(
      'a document picked through Attach files is a card, and rides the launch beside the prompt',
      async () => {
        seedStore()
        const view = await render({ initialSelection: { kind: 'conversation' } })
        const input = view.container.querySelector<HTMLInputElement>('input[type="file"]')!
        const file = new dom.window.File(['a,b'], 'Q3 budget.xlsx', { type: 'application/vnd.ms-excel' })
        Object.defineProperty(input, 'files', { value: [file], configurable: true })
        await act(async () => {
          input.dispatchEvent(new dom.window.Event('change', { bubbles: true }))
        })
        const card = view.container.querySelector('button[aria-label="Open Q3 budget.xlsx"]')
        assert.ok(card, 'the file is a card on the box')
        assert.ok(card!.textContent?.includes('XLSX'), 'the card names its type')
        const field = await typeInto(view, 'summarise')
        assert.equal(field.textContent?.includes('/Users/dev'), false, 'the path is not typed into the prompt')
        await act(async () => {
          field.dispatchEvent(
            new dom.window.KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true }),
          )
        })
        assert.equal(view.launches[0]?.prompt, 'summarise', 'the words are the words alone')
        assert.deepEqual(view.launches[0]?.files, ['/Users/dev/Desktop/Q3 budget.xlsx'], 'the file rides beside them')
        assert.equal(view.launches[0]?.images, undefined, 'a document is not an image')
        view.unmount()
      },
    )

    await check('a file picked for a chat on another machine is typed as its path, and main is not told', async () => {
      seedStore({ workspace: { environment: { kind: 'ssh', id: 'build-box', label: 'build-box' } } })
      registered.length = 0
      const view = await render({ initialSelection: { kind: 'conversation' } })
      const input = view.container.querySelector<HTMLInputElement>('input[type="file"]')!
      const file = new dom.window.File(['a,b'], 'Q3 budget.xlsx', { type: 'application/vnd.ms-excel' })
      Object.defineProperty(input, 'files', { value: [file], configurable: true })
      await act(async () => {
        input.dispatchEvent(new dom.window.Event('change', { bubbles: true }))
      })
      assert.equal(view.container.querySelector('button[aria-label="Open Q3 budget.xlsx"]'), null, 'no card')
      assert.ok(composerField(view.container).textContent?.includes('Q3 budget.xlsx'), 'its path is typed')
      assert.deepEqual(registered, [], 'nothing was registered with main')
      view.unmount()
    })

    await check('a pasted screenshot is staged and rides the launch', async () => {
      seedStore()
      const view = await render({ initialSelection: { kind: 'conversation' } })
      const field = composerField(view.container)
      const file = new dom.window.File([new Uint8Array([137, 80, 78, 71])], 'pasted.png', { type: 'image/png' })
      const event = new dom.window.Event('paste', { bubbles: true, cancelable: true })
      Object.defineProperty(event, 'clipboardData', {
        value: {
          items: [{ kind: 'file', type: 'image/png', getAsFile: () => file }],
          files: [file],
          types: ['Files'],
          getData: () => '',
        },
      })
      await act(async () => {
        field.dispatchEvent(event)
      })
      await act(async () => new Promise((resolve) => setTimeout(resolve, 20)))
      assert.ok(view.container.querySelector('img[src^="data:image/png"]'), 'the screenshot is staged')
      await typeInto(view, 'see')
      await act(async () => {
        field.dispatchEvent(new dom.window.KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true }))
      })
      // A chat's first message carries the screenshot as an image, the way a
      // later message does; its path in the text would reach the agent as words.
      assert.equal(view.launches[0]?.prompt, 'see')
      assert.deepEqual(view.launches[0]?.images, ['/tmp/shot.png'])
      view.unmount()
    })

    // ── Drafts ────────────────────────────────────────────────────────────────
    await check('a parked draft comes back: prompt, kind and image', async () => {
      seedStore()
      const { readNewChatDraft, writeNewChatDraft, resetNewChatDraftsForTests } = await import('./newChatDraft')
      resetNewChatDraftsForTests()
      const first = await render({ draftKey: 'win-2', initialSelection: { kind: 'conversation' } })
      await typeInto(first, 'keep me')
      await pickKind(first, 'general')
      first.unmount()
      const parked = readNewChatDraft('win-2')
      assert.equal(parked?.prompt, 'keep me')
      assert.equal(parked?.selection?.kind, 'general')
      const second = await render({ draftKey: 'win-2', initialSelection: { kind: 'conversation' } })
      assert.equal(composerText(composerField(second.container)), 'keep me', 'the words come back')
      assert.ok(second.text().includes('Terminal agent'), 'and the kind, as its tag')
      second.unmount()
      writeNewChatDraft('win-2', {
        images: [
          {
            id: 'img-1',
            mediaType: 'image/png',
            dataBase64: 'iVBORw0K',
            byteLength: 4,
            name: 'a.png',
            path: '/tmp/a.png',
          },
        ],
      })
      const third = await render({ draftKey: 'win-2', initialSelection: { kind: 'conversation' } })
      assert.ok(third.container.querySelector('img[src^="data:image/png"]'), 'a staged image comes back on the box')
      const start = [...third.container.querySelectorAll('button')].find(
        (button) => button.getAttribute('aria-label') === 'Start agent',
      )
      await act(async () => {
        start!.dispatchEvent(new dom.window.MouseEvent('click', { bubbles: true }))
      })
      // A terminal agent's prompt is typed into its terminal, so there the
      // image is its path.
      assert.match(String(third.launches[0]?.prompt), /^keep me \/tmp\/a\.png$/, 'and rides the launch')
      assert.equal(third.launches[0]?.images, undefined, 'as a path, not an image')
      third.unmount()
      resetNewChatDraftsForTests()
    })

    await check('a parked draft keeps the worktree chip as it was left', async () => {
      seedStore()
      const { readNewChatDraft, resetNewChatDraftsForTests } = await import('./newChatDraft')
      resetNewChatDraftsForTests()
      const nameField = (view: Harness) =>
        view.container.querySelector<HTMLInputElement>('input[aria-label^="Worktree name"]')
      const first = await render({ draftKey: 'win-3', initialSelection: { kind: 'conversation' } })
      assert.ok(nameField(first), 'the door opens with the worktree on')
      await act(async () => {
        const setValue = Object.getOwnPropertyDescriptor(dom.window.HTMLInputElement.prototype, 'value')!.set!
        setValue.call(nameField(first), 'fix-login')
        nameField(first)!.dispatchEvent(new dom.window.Event('input', { bubbles: true }))
      })
      first.unmount()
      assert.equal(readNewChatDraft('win-3')?.worktreeName, 'fix-login')
      const second = await render({ draftKey: 'win-3', initialSelection: { kind: 'conversation' } })
      assert.equal(nameField(second)?.value, 'fix-login', 'the typed name comes back')
      const chip = second.container.querySelector<HTMLElement>('[data-worktree-chip] button')!
      await act(async () => {
        chip.dispatchEvent(new dom.window.MouseEvent('click', { bubbles: true }))
      })
      second.unmount()
      const third = await render({ draftKey: 'win-3', initialSelection: { kind: 'conversation' } })
      assert.equal(nameField(third), null, 'and a chip turned off stays off')
      assert.equal(third.container.querySelector('[data-worktree-chip]')?.getAttribute('data-worktree-chip'), 'off')
      third.unmount()
      resetNewChatDraftsForTests()
    })

    await check('on a narrow strip the project name gives way and the Worktree switch keeps its place', async () => {
      seedStore()
      const { resetNewChatDraftsForTests } = await import('./newChatDraft')
      resetNewChatDraftsForTests()
      const longName = 'a-project-with-a-name-long-enough-to-crowd-the-strip'
      const view = await render({
        initialSelection: { kind: 'conversation' },
        draftKey: 'win-narrow',
        folderPath: '/proj',
        projectOptions: [{ path: '/proj', label: longName }],
        onSelectProject: () => {},
      })
      // No layout engine here, so what is pinned is the flex contract the
      // strip relies on: the project may shrink and truncates its name; the
      // switch may not.
      const trigger = view.container.querySelector<HTMLElement>('[data-project-trigger="true"]')!
      assert.ok(trigger.parentElement?.classList.contains('min-w-0'), 'the chip’s box may shrink below its content')
      const name = [...trigger.querySelectorAll('span')].find((span) => span.textContent === longName)
      assert.ok(name?.classList.contains('truncate') && name.classList.contains('min-w-0'), 'and its name truncates')
      const worktree = view.container.querySelector<HTMLElement>('[data-worktree-chip]')!
      assert.ok(worktree.classList.contains('shrink-0'), 'the switch keeps its width')
      view.unmount()
      resetNewChatDraftsForTests()
    })

    // ── Tags ──────────────────────────────────────────────────────────────────
    await check('removing the kind tag returns to a conversation and the tag goes', async () => {
      seedStore()
      const view = await render({ initialSelection: { kind: 'conversation' } })
      await pickKind(view, 'terminal')
      const remove = view.container.querySelector<HTMLElement>(
        '[aria-label="Start as a conversation instead of terminal"]',
      )
      assert.ok(remove, 'the kind is a tag with a ×')
      assert.equal(composerDisabled(composerField(view.container)), true, 'a plain shell takes no prompt')
      await act(async () => {
        remove!.dispatchEvent(new dom.window.MouseEvent('click', { bubbles: true }))
      })
      assert.equal(
        view.container.querySelector('[aria-label^="Start as a conversation instead of"]'),
        null,
        'the tag is gone',
      )
      assert.equal(composerDisabled(composerField(view.container)), false, 'and the prompt takes words again')
      const field = await typeInto(view, 'go')
      await act(async () => {
        field.dispatchEvent(new dom.window.KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true }))
      })
      assert.equal(view.launches[0]?.kind, 'conversation', 'and the launch is a conversation again')
      view.unmount()
    })

    if (failures > 0) {
      console.error(`NewAgentPanel.interaction.test.tsx: ${failures} failing check(s)`)
      process.exit(1)
    }
    console.log('NewAgentPanel.interaction.test.tsx: ok')
  }

  await main()
})
