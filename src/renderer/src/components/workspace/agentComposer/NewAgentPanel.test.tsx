import assert from 'node:assert/strict'

import { JSDOM } from 'jsdom'
import { standInImageDecoding } from '../../../../../../tests/image-decoding'
import { bundledPermissionModes } from '../../../../../../tests/permission-modes'
import {
  composerDisabled,
  composerField,
  composerPlaceholder,
  composerText,
  typeIntoComposer,
} from '../../../../../../tests/composer-field'
import { test } from 'vitest'

test('NewAgentPanel', async () => {
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
  const imageDecoding = standInImageDecoding(dom.window)
  anyGlobal.getComputedStyle = dom.window.getComputedStyle
  // jsdom has no `CSS`; the skill type-ahead escapes a row id with it to keep
  // the highlighted row in view.
  anyGlobal.CSS = { escape: (value: string) => value.replace(/["\\]/gu, '\\$&') }
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
    getPathForFile: () => '/tmp/shot.png',
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
    const { resetRememberedMachineForTests, sortMachines } = await import('./NewAgentPanel')
    const { useWorkspaceStore } = await import('../../../store/workspaceStore')
    const { projectHue } = await import('../../../utils/projectColor')
    const { useToastStore } = await import('../../../store/toastStore')
    const { __resetCliPermissionPresetsForTest, storedCliPermissionPreset, resolveCliPermissionPreset } =
      await import('../../ui/cliPermissionPresets')

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

    const seedStore = (options: { plugins?: unknown[] } = {}): void => {
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
    // Is the skills picker offered: a row of the "+" menu.
    const skillsOffered = async (view: Harness): Promise<boolean> => {
      const menu = await openOptions(view)
      const offered = (menu?.textContent ?? '').includes('Skills, plugins & MCPs')
      await act(async () => {
        dom.window.document.dispatchEvent(
          new dom.window.KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true }),
        )
      })
      return offered
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

    // 1. The row carries the usual decisions; the rare ones are behind the "+".
    await check('the row shows engine and access, and hides the rest behind ⋯', async () => {
      seedStore()
      previewCalls.length = 0
      const view = await render()
      const text = view.text()

      // The PROJECT folder, not the workspace name: a solo-chat workspace is
      // called things like "new chat panel", which says nothing about where the
      // agent runs. The fixture names them differently on purpose.
      assert.ok(text.includes('proj'), 'the scope line names the folder the agent will run in')
      assert.ok(!text.includes('sprintengine'), 'and not the workspace’s own name')
      // Permissions used to stand beside the engine as their own chip. They are a
      // property of the runtime the row names, so they moved INSIDE the model
      // picker (owner, 2026-09-05) and are remembered per CLI — the row itself
      // no longer carries the value.
      assert.ok(!text.includes('No flag'), 'access is not a second chip on the row')
      assert.ok(
        [...view.container.querySelectorAll('button')].some((button) =>
          (button.getAttribute('aria-label') ?? '').startsWith('Engine: '),
        ),
        'the engine chip is the one control the row spends on the runtime',
      )
      assert.ok(
        view.container.querySelector('button[aria-label="Options"][aria-haspopup="menu"]'),
        'the "+" that opens the options is there',
      )
      assert.ok(!text.includes('⋯'), 'and the ⋯ menu it replaced is gone')

      // Worktree sits in the context strip under the box, off until turned on.
      const strip = view.container.querySelector('[data-composer-strip]')
      const worktreeChip = strip?.querySelector('[data-worktree-chip]')
      assert.equal(worktreeChip?.getAttribute('data-worktree-chip'), 'off', 'worktree is on the strip, and off')
      assert.ok((strip?.textContent ?? '').includes('No worktree'), 'and says so')
      assert.ok(!text.includes('+ Skill') && !text.includes('+ Connector'), 'the two old chips are gone')
      assert.ok(!/debug/i.test(text), 'and Debug Mode is gone entirely')

      // The command line is not printed under the box any more.
      assert.ok(!text.includes(PREVIEW_DISPLAY), 'the invocation is not a line of chrome')

      // It rides Start's hover, and it is main's answer verbatim.
      const start = [...view.container.querySelectorAll('button')].find(
        (button) => button.getAttribute('aria-label') === 'Start agent',
      )
      assert.ok(start, 'the launch control is there, named for what it does')
      assert.equal(start?.textContent?.trim(), '', 'a small round send with an arrow, and no word')
      assert.ok(start?.querySelector('svg'), 'its arrow')
      assert.match(start?.className ?? '', /radius-pill/, 'round')
      // Real focus, not a synthetic 'focus' event: React binds onFocus to focusin,
      // which is also what a Tab press produces — the path this must work on.
      await act(async () => {
        ;(start as HTMLElement).focus()
      })
      const tooltip = dom.window.document.querySelector('[role="tooltip"]')
      assert.ok(tooltip, 'focusing Start opens its tip — keyboard reaches it, not only the pointer')
      assert.ok(
        (tooltip?.textContent ?? '').includes(PREVIEW_DISPLAY),
        `the tip is main's own line; got: ${tooltip?.textContent}`,
      )

      assert.equal(previewCalls.length >= 1, true, 'the surface asked main rather than composing the line itself')
      assert.equal(previewCalls[0]?.cli, 'claude-code', 'it asked about the selected agent’s CLI')
      assert.equal(
        previewCalls[0]?.cliPermissionPreset,
        'none',
        'and forwarded the approval preset, so the line moves when the chip does',
      )

      view.unmount()

      // Bypass is the value that removes a safeguard, so it is the one that also
      // changes colour rather than only its text.
      const bypassed = await render({ permissionPreset: 'bypass' })
      // The presets are an inline strip on the picker's one trailing row now, so
      // opening the engine is what reveals them — all four, no menu to open.
      const engine = [...bypassed.container.querySelectorAll('button')].find((button) =>
        (button.getAttribute('aria-label') ?? '').startsWith('Engine: '),
      )
      await act(async () => {
        engine!.dispatchEvent(new dom.window.MouseEvent('click', { bubbles: true }))
      })
      const chip = [...dom.window.document.querySelectorAll('button')].find(
        (button) => button.getAttribute('aria-label') === 'Permissions: Bypass permissions',
      )
      assert.ok(chip, 'the permission chip is named for the preset it carries')
      assert.ok((chip?.textContent ?? '').includes('Bypass'), 'and reads Bypass when that is the preset')
      // Bypass is the value that removes a safeguard, so it is the one that also
      // changes colour rather than only its text. The chip carries that colour as
      // the kit's `tint` — an ink plus a 12%-of-the-same ground, applied inline so
      // it cannot meet the variant's own `bg-`/`hover:bg-` at equal specificity —
      // so the tone reads from the style attribute rather than the class list.
      assert.ok(
        (chip?.getAttribute('style') ?? '').includes('--tone-warn'),
        'and wears the warn tone, not the ordinary accent',
      )
      // The two settings about the row above are the same kind of control, on the
      // same line: effort first, permissions to its right (owner, 2026-09-05).
      const trailing = [...dom.window.document.querySelectorAll('button')].filter((button) => {
        const name = button.getAttribute('aria-label') ?? ''
        return name.startsWith('Permissions: ') || name.startsWith('Reasoning effort: ')
      })
      assert.deepEqual(
        trailing.map((button) => (button.getAttribute('aria-label') ?? '').split(':')[0]),
        ['Reasoning effort', 'Permissions'],
        'effort on the left, permissions on the right, in one row',
      )
      // Each chip is a Popover trigger, so it sits inside that Popover's own
      // wrapper; the row is the grandparent. Compared as a BOOLEAN, never as the
      // nodes themselves — a failed assert on two DOM elements makes Node
      // serialise both trees for its diff, which exhausts memory and kills the
      // runner instead of printing a failure.
      const rowOf = (button: Element | undefined) => button?.parentElement?.parentElement
      assert.ok(
        trailing.length === 2 && rowOf(trailing[0]) !== undefined && rowOf(trailing[0]) === rowOf(trailing[1]),
        'and they share one row, rather than sitting on two stacked bands',
      )
      bypassed.unmount()
    })

    // 1b. The "+" holds how the launch starts and what it starts with (owner
    //     ruling 2026-10-04), and replaces the ⋯ menu and the Chat | Scheduled
    //     agent switch above the box.
    await check('the "+" menu holds the start choice and the options', async () => {
      seedStore()
      const view = await render()
      const menu = await openOptions(view)
      assert.ok(menu, 'the "+" opens a menu')
      const kinds = [...(menu?.querySelectorAll<HTMLElement>('[data-start-as]') ?? [])].map((tile) =>
        tile.getAttribute('data-start-as'),
      )
      assert.deepEqual(kinds, ['conversation', 'general', 'terminal'], 'Conversation, Terminal agent, Terminal')
      const menuText = menu?.textContent ?? ''
      assert.ok(menuText.includes('Start as'))
      assert.ok(menuText.includes('Conversation') && menuText.includes('Terminal agent'))
      assert.ok(menuText.includes('Attach files'), 'attach files is an option')
      assert.ok(menuText.includes('Skills, plugins & MCPs'), 'the skills picker moved here from the row')
      assert.ok(!menuText.includes('Worktree'), 'worktree is the strip’s, not the menu’s')
      assert.ok(!/debug/i.test(menuText), 'Debug Mode is gone')
      view.unmount()
    })

    // 1c. Worktree is a switch that can be named: the glyph turns it on with a
    //     name made up at start, and typing a name turns it on with that name.
    await check('worktree is a switch on the strip, and can be named while on', async () => {
      seedStore()
      const view = await render()
      const chip = () => view.container.querySelector('[data-worktree-chip]')
      const glyph = () =>
        [...view.container.querySelectorAll('button')].find(
          (button) => button.getAttribute('aria-label') === 'Run in a worktree',
        )
      assert.equal(chip()?.getAttribute('data-worktree-chip'), 'off')
      await act(async () => {
        glyph()!.dispatchEvent(new dom.window.MouseEvent('click', { bubbles: true }))
      })
      assert.equal(chip()?.getAttribute('data-worktree-chip'), 'on', 'the glyph turns it on')
      const name = chip()!.querySelector('input')!
      assert.equal(name.getAttribute('placeholder'), 'auto-named', 'with a name made up at start')
      await act(async () => {
        Object.getOwnPropertyDescriptor(dom.window.HTMLInputElement.prototype, 'value')!.set!.call(name, 'fix-login')
        name.dispatchEvent(new dom.window.Event('input', { bubbles: true }))
      })
      assert.equal(chip()?.querySelector('input')?.value, 'fix-login', 'and takes a name of the person’s own')
      const strip = view.container.querySelector('[data-composer-strip]')
      assert.ok((strip?.textContent ?? '').includes('Worktree'), 'the switch reads Worktree while on')
      const on = [...view.container.querySelectorAll('button')].find(
        (button) => button.getAttribute('aria-label') === 'Run in a worktree',
      )
      assert.equal(on?.getAttribute('aria-pressed'), 'true', 'the same switch, pressed')
      await act(async () => {
        on!.dispatchEvent(new dom.window.MouseEvent('click', { bubbles: true }))
      })
      assert.equal(chip()?.getAttribute('data-worktree-chip'), 'off', 'pressed again, it is off')
      view.unmount()
    })

    // 1d. The New chat door (the surface with a parked draft) opens with the
    //     worktree on: a chat runs in a worktree of its own unless the person
    //     turns it off. The pane's "+" (no draft) still opens with it off,
    //     which 1c covers.
    await check('the New chat door opens with the worktree on, and the launch carries it', async () => {
      seedStore()
      const { writeNewChatDraft, resetNewChatDraftsForTests } = await import('./newChatDraft')
      resetNewChatDraftsForTests()
      writeNewChatDraft('win-1', { prompt: 'fix the login redirect', folderPath: '/w/app' })
      const view = await render({ draftKey: 'win-1' })
      const chip = view.container.querySelector('[data-worktree-chip]')
      assert.equal(chip?.getAttribute('data-worktree-chip'), 'on', 'the door starts in a worktree')
      const start = [...view.container.querySelectorAll('button')].find(
        (button) => button.getAttribute('aria-label') === 'Start agent',
      )
      await act(async () => {
        start!.dispatchEvent(new dom.window.MouseEvent('click', { bubbles: true }))
      })
      assert.deepEqual(view.launches[0]?.worktree, { name: '' }, 'with a name made up at start')
      view.unmount()
      resetNewChatDraftsForTests()
    })

    // 1e. Outside a git repository the chip is not offered, so the worktree the
    //     door starts with is dropped from the launch: carried, it would fail
    //     to be made and keep the chat from starting at all.
    await check('outside a git repository the door launches with no worktree', async () => {
      seedStore()
      const api = (dom.window as unknown as { api: Record<string, unknown> }).api
      const gitRepoRoot = api.getGitRepoRoot
      api.getGitRepoRoot = async () => null
      const { writeNewChatDraft, resetNewChatDraftsForTests } = await import('./newChatDraft')
      resetNewChatDraftsForTests()
      writeNewChatDraft('win-1', { prompt: 'tidy the notes', folderPath: '/w/notes' })
      try {
        const view = await render({ draftKey: 'win-1' })
        assert.equal(view.container.querySelector('[data-worktree-chip]'), null, 'no chip outside a repository')
        const start = [...view.container.querySelectorAll('button')].find(
          (button) => button.getAttribute('aria-label') === 'Start agent',
        )
        await act(async () => {
          start!.dispatchEvent(new dom.window.MouseEvent('click', { bubbles: true }))
        })
        assert.equal(view.launches.length, 1, 'the chat still starts')
        assert.equal('worktree' in view.launches[0]!, false, 'with no worktree on it')
        view.unmount()
      } finally {
        api.getGitRepoRoot = gitRepoRoot
        resetNewChatDraftsForTests()
      }
    })

    // 2b. Picking a plain Terminal drops every CLI-shaped control: a shell
    //     launches no CLI, so it shows no model, no permission flag and no
    //     command line.
    await check('a plain terminal launch shows no CLI chrome', async () => {
      seedStore()
      const view = await render()
      await pickKind(view, 'terminal')

      const text = view.text()
      // A shell launches nothing that reads a permission flag or a model, so it
      // shows neither — and the engine chip that opens the picker holding both
      // is gone with them.
      assert.ok(!text.includes('Opus'), 'no model')
      assert.ok(
        ![...view.container.querySelectorAll('button')].some((button) =>
          (button.getAttribute('aria-label') ?? '').startsWith('Engine: '),
        ),
        'and no engine chip, so no way to a permission preset a shell would ignore',
      )

      const start = [...view.container.querySelectorAll('button')].find(
        (button) => button.getAttribute('aria-label') === 'Open terminal',
      )
      // Tabbed to, as a keyboard user reaches it: a tooltip answers
      // `:focus-visible`, and focus with no key behind it is not that.
      await act(async () => {
        dom.window.document.body.dispatchEvent(new dom.window.KeyboardEvent('keydown', { key: 'Tab', bubbles: true }))
        ;(start as HTMLElement).focus()
      })
      const tip = dom.window.document.querySelector('[role="tooltip"]')
      assert.ok(
        (tip?.textContent ?? '').includes('shell'),
        `it says what it opens instead of a command; got: ${tip?.textContent}`,
      )

      // A shell runs nothing on your behalf: no suggested tasks, and a prompt
      // field that says so rather than dropping what was typed.
      const { SUGGESTION_BANK } = await import('./suggestionBank')
      assert.ok(!SUGGESTION_BANK.some((entry) => text.includes(entry.title)), 'no suggestion cards for a plain shell')
      const promptField = composerField(view.container)
      assert.equal(composerDisabled(promptField), true, 'and no prompt to type into')
      assert.ok(composerPlaceholder(promptField).includes('nothing typed'), 'which says why')

      // The choice is a tag beside the "+", and its × goes back to a conversation;
      // the "+" still offers the terminal agent.
      const tag = [...view.container.querySelectorAll('button')].find((button) =>
        (button.getAttribute('aria-label') ?? '').startsWith('Start as a conversation instead of terminal'),
      )
      assert.ok(tag, 'Terminal is a removable tag beside the "+"')
      await pickKind(view, 'general')
      assert.ok(
        [...view.container.querySelectorAll('button')].some((button) =>
          (button.getAttribute('aria-label') ?? '').startsWith('Engine: '),
        ),
        'picking Terminal agent brings the engine chip — and the permission control inside it — back',
      )
      const back = view.text()
      assert.equal(composerDisabled(composerField(view.container)), false, 'and the prompt is typeable again')
      assert.ok(
        SUGGESTION_BANK.some((entry) => back.includes(entry.title)),
        'and the suggested tasks return',
      )
      view.unmount()
    })

    // 2b-ii. The kind of launch is chosen in the "+" menu's Start as tiles.
    const chatEngineChip = (view: Harness): HTMLElement | undefined =>
      [...view.container.querySelectorAll<HTMLElement>('button')].find((button) =>
        (button.getAttribute('aria-label') ?? '').startsWith('Engine: '),
      )

    await check('the "+" is the one place the kind is chosen, and a non-default kind is a tag', async () => {
      seedStore()
      const view = await render({ initialSelection: { kind: 'conversation' } })
      assert.equal(view.container.querySelector('[role="radiogroup"]'), null, 'no switch above the box')
      assert.equal(view.container.querySelector('h1'), null, 'and no greeting or heading over it')
      assert.ok(!view.text().includes("What's up"), 'the greeting is gone')
      const menu = await openOptions(view)
      const checked = menu?.querySelector('[data-start-as][aria-checked="true"]')
      assert.equal(checked?.getAttribute('data-start-as'), 'conversation', 'Conversation is the default')
      assert.equal(checked?.getAttribute('role'), 'menuitemradio')
      await act(async () => {
        ;(menu?.querySelector('[data-start-as="general"]') as HTMLElement).click()
      })
      assert.ok(view.text().includes('Terminal agent'), 'the choice rises as a tag')
      assert.match(
        composerPlaceholder(composerField(view.container)) ?? '',
        /terminal you can take over/,
        'and the prompt says where it runs',
      )
      view.unmount()
    })

    await check(
      'Chat agent is the same launcher: the shared picker, narrowed to CLIs with a chat runtime',
      async () => {
        seedStore({
          plugins: [
            {
              id: 'claude-code',
              displayName: 'Claude Code',
              source: 'bundled',
              version: 1,
              binary: 'claude',
              modelSelection: {
                args: ['--model', '{{model}}'],
                options: [{ id: 'opus[1m]', label: 'Opus (latest, 1M context)' }],
              },
              reasoningSelection: { levels: [{ id: 'low' }, { id: 'high' }] },
            },
            { id: 'acme-cli', displayName: 'Acme CLI', source: 'bundled', version: 1, binary: 'acme' },
          ],
        })
        useWorkspaceStore.setState({
          appSettings: {
            ...useWorkspaceStore.getState().appSettings,
            lastSelectedCli: 'claude-code',
            lastSelectedAgentModel: { cli: 'claude-code', model: 'opus[1m]' },
          },
        } as never)
        const view = await render()
        await pickKind(view, 'conversation')
        assert.equal(view.container.querySelector('[aria-label="Chat models"]'), null, 'no model roster list')
        const chip = chatEngineChip(view)
        assert.ok(chip, 'the same engine chip the terminal agent wears')
        assert.equal(chip!.getAttribute('aria-label'), 'Engine: Opus (latest, 1M context)')
        await act(async () => {
          chip!.dispatchEvent(new dom.window.MouseEvent('click', { bubbles: true }))
        })
        const rail = dom.window.document.querySelector('[role="radiogroup"][aria-label="Provider"]')
        const railLabels = [...(rail?.querySelectorAll('[role="radio"]') ?? [])].map((radio) =>
          radio.getAttribute('aria-label'),
        )
        assert.deepEqual(railLabels, ['Claude Code'], 'a CLI with no chat runtime is not on the rail')
        assert.ok(
          dom.window.document.querySelector('[aria-label^="Permissions:"]'),
          'the permission control sits in the picker, as for a terminal agent',
        )
        view.unmount()

        // With the terminal Agent chosen, every installed CLI is on the rail.
        const agentView = await render()
        await act(async () => {
          chatEngineChip(agentView)!.dispatchEvent(new dom.window.MouseEvent('click', { bubbles: true }))
        })
        const agentRail = dom.window.document.querySelector('[role="radiogroup"][aria-label="Provider"]')
        assert.equal(agentRail?.querySelectorAll('[role="radio"]').length, 2)
        agentView.unmount()
      },
    )

    await check('Enter in the Chat agent launcher starts the chat on what was typed', async () => {
      seedStore()
      const view = await render({ initialSelection: { kind: 'conversation' } })
      const field = composerField(view.container)
      await act(async () => {
        typeIntoComposer(field, 'hi')
      })
      await act(async () => {
        field.dispatchEvent(new dom.window.KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true }))
      })
      assert.equal(view.launches.length, 1, 'one Enter, one launch')
      const launch = view.launches[0]!
      assert.equal(launch.kind, 'conversation')
      assert.equal(launch.prompt, 'hi', 'the typed text rides the launch as the first message')
      assert.equal(launch.cli, 'claude-code')
      assert.deepEqual(
        launch.provider,
        { providerId: 'claude-agent', modelId: 'default', modelLabel: 'Claude Code' },
        'the picked CLI maps onto its conversation provider; its own default model asks for none',
      )
      view.unmount()
    })

    await check('the prompt carries no caret, chat or CLI: the box is one composer', async () => {
      const caret = (view: Awaited<ReturnType<typeof render>>) =>
        composerField(view.container).closest('[data-composer-field]')!.parentElement!.querySelector(':scope > svg')
      seedStore()
      const cliView = await render({ initialSelection: { kind: 'general' } })
      assert.equal(caret(cliView), null)
      cliView.unmount()
    })

    await check('with no CLI that can run as a chat, Chat agent offers the install route', async () => {
      seedStore({
        plugins: [{ id: 'acme-cli', displayName: 'Acme CLI', source: 'bundled', version: 1, binary: 'acme' }],
      })
      const view = await render({ initialSelection: { kind: 'conversation' } })
      assert.ok(view.text().includes('No agent CLI on this machine can run as a chat.'))
      assert.ok(composerField(view.container).closest('.hidden'), 'and hides the prompt that cannot run')
      view.unmount()
    })

    await check('the feature flag and a workspace that cannot host a chat both drop Conversation', async () => {
      for (const props of [{ conversationModeEnabled: false }, { conversationWorkspaceSupported: false }]) {
        seedStore()
        const view = await render(props)
        const menu = await openOptions(view)
        assert.equal(menu?.querySelector('[data-start-as="conversation"]') ?? null, null, JSON.stringify(props))
        view.unmount()
      }
    })

    // 2c. There is always a way out. The tab host has its tab's ×; the door host
    //     has none, so the surface carries the control — and Escape cancels from
    //     anywhere on it, not only from the prompt field.
    await check('the surface can always be cancelled', async () => {
      seedStore()

      // Escape from a control that is not the prompt.
      const view = await render()
      const chip = [...view.container.querySelectorAll('button')].find(
        (button) => button.getAttribute('aria-label') === 'Options',
      )
      await act(async () => {
        ;(chip as HTMLElement).focus()
        // Where the browser sends a key: to whatever holds the focus.
        chip!.dispatchEvent(new dom.window.KeyboardEvent('keydown', { key: 'Escape', bubbles: true }))
      })
      assert.equal(view.closed(), 1, 'Escape cancels from anywhere on the surface')
      view.unmount()

      // The door host draws its own close control, because it has no tab.
      const withButton = await render({ showCloseButton: true })
      const close = [...withButton.container.querySelectorAll('button')].find(
        (button) => button.getAttribute('aria-label') === 'Cancel',
      )
      assert.ok(close, 'a hosted surface with no tab carries its own way out')
      await act(async () => {
        close!.dispatchEvent(new dom.window.MouseEvent('click', { bubbles: true }))
      })
      assert.equal(withButton.closed(), 1, 'and it cancels')
      withButton.unmount()

      // The tab host does NOT draw one — its tab already closes it.
      const tabHosted = await render()
      assert.ok(
        ![...tabHosted.container.querySelectorAll('button')].some(
          (button) => button.getAttribute('aria-label') === 'Cancel',
        ),
        'the tab host relies on its tab, and draws no second control',
      )
      tabHosted.unmount()
    })

    // 3. Start hands the host a confirm plus the prompt, and creates nothing.
    await check('Start reports the launch to the host with the typed prompt', async () => {
      seedStore()
      const view = await render()
      const textarea = composerField(view.container)

      await act(async () => {
        typeIntoComposer(textarea, 'review the auth flow')
      })

      const start = [...view.container.querySelectorAll('button')].find(
        (button) => button.getAttribute('aria-label') === 'Start agent',
      )
      assert.ok(start, 'the primary action is named for what it does')
      await act(async () => {
        start!.dispatchEvent(new dom.window.MouseEvent('click', { bubbles: true }))
      })

      assert.equal(view.launches.length, 1, 'exactly one launch was reported')
      assert.equal(view.launches[0]?.prompt, 'review the auth flow', 'carrying what was typed')
      assert.equal(view.launches[0]?.kind, 'general', 'and which agent was chosen')
      assert.equal(
        'model' in (view.launches[0] ?? {}),
        true,
        'the confirm always names the model, even when it is the CLI’s own default',
      )
      assert.equal(
        view.launches[0]?.model,
        null,
        'and with no pick that name is null — not an omitted field the host would re-read',
      )
      assert.equal('reasoning' in (view.launches[0] ?? {}), true, 'and it always names the effort, for the same reason')
      assert.equal(view.launches[0]?.reasoning, null, 'with no pick that is the CLI’s own default too')
      view.unmount()
    })

    // Codex with no `--model` launches Astra. The chip’s pick has to ride Start,
    // not a later re-read of the remembered defaults (which can miss in the same
    // turn and leave the flag off).
    await check('picking a catalog model puts that id on Start, not the CLI’s own default', async () => {
      seedStore({
        plugins: [
          {
            id: 'claude-code',
            displayName: 'Claude Code',
            source: 'bundled',
            version: 1,
            binary: 'claude',
            resumeSession: true,
            sessionIdFromCaller: true,
            modelSelection: { options: [{ id: 'claude-opus-5', label: 'Opus 5' }], allowCustomId: true },
            reasoningSelection: { levels: [{ id: 'low' }, { id: 'medium' }, { id: 'high' }] },
            skillIntegration: {
              support: 'native',
              harnessId: 'claude',
              installTargets: [],
              invocation: { explicitTemplate: '/{{skillId}}', nativeSlashCommand: true, mentionPrefix: '/' },
            },
            permissionModes: bundledPermissionModes('claude-code'),
          },
          {
            id: 'codex',
            displayName: 'Codex',
            source: 'bundled',
            version: 1,
            binary: 'codex',
            resumeSession: true,
            sessionIdFromCaller: true,
            permissionModes: bundledPermissionModes('codex'),
            modelSelection: {
              options: [
                { id: 'gpt-5.6-sol', label: 'GPT-5.6 Sol' },
                { id: 'gpt-6-astra', label: 'GPT-6-Astra' },
              ],
              allowCustomId: true,
            },
            reasoningSelection: { levels: [{ id: 'low' }, { id: 'medium' }, { id: 'high' }], default: 'medium' },
            skillIntegration: {
              support: 'native',
              harnessId: 'codex',
              installTargets: [],
              invocation: { explicitTemplate: '${{skillId}}', nativeSlashCommand: false },
            },
          },
        ],
      })
      const view = await render({ permissionPreset: 'bypass' })
      const engine = [...view.container.querySelectorAll('button')].find((button) =>
        (button.getAttribute('aria-label') ?? '').startsWith('Engine: '),
      )
      await act(async () => {
        engine!.dispatchEvent(new dom.window.MouseEvent('click', { bubbles: true }))
      })
      const codexTab = [...dom.window.document.querySelectorAll('button')].find(
        (button) => button.getAttribute('role') === 'radio' && button.getAttribute('aria-label') === 'Codex',
      )
      assert.ok(codexTab, 'Codex is on the runtime rail')
      assert.ok(
        dom.window.document.querySelector('[aria-label="Permissions: Bypass permissions"]'),
        'Claude names its bypass preset',
      )
      await act(async () => {
        codexTab!.dispatchEvent(new dom.window.MouseEvent('click', { bubbles: true }))
      })
      assert.ok(
        dom.window.document.querySelector('[aria-label="Permissions: YOLO"]'),
        'switching to Codex updates the permission chip',
      )
      assert.equal(
        dom.window.document.querySelector('[aria-label="Permissions: Bypass permissions"]'),
        null,
        'the previous runtime label is gone',
      )
      const sol = [...dom.window.document.querySelectorAll('[data-model-row="true"]')].find((row) =>
        (row.textContent ?? '').includes('GPT-5.6 Sol'),
      )
      assert.ok(sol, 'the Sol row is in the picker')
      await act(async () => {
        sol!.dispatchEvent(new dom.window.MouseEvent('pointerover', { bubbles: true }))
      })
      const permissions = dom.window.document.querySelector<HTMLButtonElement>('[aria-label="Permissions: YOLO"]')!
      await act(async () => permissions.click())
      const noFlag = [...dom.window.document.querySelectorAll<HTMLButtonElement>('[data-preset-option="true"]')].find(
        (row) => row.textContent?.startsWith('No flag'),
      )!
      await act(async () => noFlag.click())
      assert.equal(storedCliPermissionPreset('codex'), 'none', 'the highlighted model’s CLI owns the choice')
      assert.equal(storedCliPermissionPreset('claude-code'), undefined, 'the previous runtime is untouched')
      await act(async () => {
        sol!.dispatchEvent(new dom.window.MouseEvent('click', { bubbles: true }))
      })
      const start = [...view.container.querySelectorAll('button')].find(
        (button) => button.getAttribute('aria-label') === 'Start agent',
      )
      await act(async () => {
        start!.dispatchEvent(new dom.window.MouseEvent('click', { bubbles: true }))
      })
      assert.equal(view.launches.length, 1, 'exactly one launch')
      assert.equal(view.launches[0]?.cli, 'codex', 'on the runtime that owned the row')
      assert.equal(view.launches[0]?.model, 'gpt-5.6-sol', 'carrying the id the chip named, not the CLI’s own default')
      assert.equal(
        resolveCliPermissionPreset(String(view.launches[0]?.cli), 'bypass'),
        'none',
        'the launch host resolves the launched CLI’s permission choice',
      )
      assert.equal('reasoning' in (view.launches[0] ?? {}), true, 'and the effort rides the same confirm')
      view.unmount()
    })

    // 4. A card is a launch button, and it carries the bank's real prompt.
    await check('a suggestion card spawns on click with its full prompt', async () => {
      seedStore()
      const { SUGGESTION_BANK } = await import('./suggestionBank')
      const view = await render()

      const card = [...view.container.querySelectorAll('button')].find((button) =>
        SUGGESTION_BANK.some((entry) => (button.textContent ?? '').startsWith(entry.title)),
      )
      assert.ok(card, 'the surface drew cards')
      await act(async () => {
        card!.dispatchEvent(new dom.window.MouseEvent('click', { bubbles: true }))
      })

      assert.equal(view.launches.length, 1, 'one click, one launch')
      const prompt = String(view.launches[0]?.prompt ?? '')
      const matched = SUGGESTION_BANK.find((entry) => entry.prompt === prompt)
      assert.ok(matched, 'the card sent the bank’s real instruction, not its title')
      assert.notEqual(prompt, matched?.title, 'and never the label')
      view.unmount()
    })

    await check('the cards leave once the box holds words or attachments, and come back when it is empty', async () => {
      seedStore()
      const { SUGGESTION_BANK } = await import('./suggestionBank')
      const view = await render({ initialSelection: { kind: 'conversation' } })
      const cards = () =>
        [...view.container.querySelectorAll('button')].filter((button) =>
          SUGGESTION_BANK.some((entry) => (button.textContent ?? '').startsWith(entry.title)),
        )
      assert.ok(cards().length > 0, 'an empty box offers cards')
      const field = composerField(view.container)
      await act(async () => {
        typeIntoComposer(field, 'my own task')
      })
      assert.equal(cards().length, 0, 'a card would throw the typed words away')
      await act(async () => {
        typeIntoComposer(field, '')
      })
      assert.ok(cards().length > 0, 'cleared, the box offers them again')
      const input = view.container.querySelector<HTMLInputElement>('input[type="file"]')!
      const file = new dom.window.File([new Uint8Array([137, 80, 78, 71])], 'shot.png', { type: 'image/png' })
      Object.defineProperty(input, 'files', { value: [file], configurable: true })
      await act(async () => {
        input.dispatchEvent(new dom.window.Event('change', { bubbles: true }))
      })
      await act(async () => new Promise((resolve) => setTimeout(resolve, 20)))
      assert.equal(cards().length, 0, 'nor send a staged image with a card’s text')
      assert.equal(view.launches.length, 0)
      view.unmount()
    })

    // 5. Skills are offered by the picker whatever the CLI can type; the
    //    inline `/` route stays but is no longer the placeholder's job.
    await check('the picker is there for every CLI and the placeholder stops advertising the trigger', async () => {
      seedStore()
      const withPrefix = await render({ initialSelection: { kind: 'conversation' } })
      assert.equal(composerPlaceholder(composerField(withPrefix.container)), 'Describe the task…')
      assert.ok(await skillsOffered(withPrefix), 'a claude runtime gets the picker')
      withPrefix.unmount()

      seedStore({
        plugins: [
          {
            id: 'opencode',
            displayName: 'OpenCode',
            source: 'bundled',
            version: 1,
            binary: 'opencode',
            resumeSession: false,
            sessionIdFromCaller: false,
            skillIntegration: {
              support: 'native',
              harnessId: 'opencode',
              installTargets: [],
              invocation: { explicitTemplate: 'Use the {{skillId}} skill.', explicitMention: true },
            },
          },
        ],
      })
      const noPrefix = await render({ initialSelection: { kind: 'conversation' } })
      assert.equal(composerPlaceholder(composerField(noPrefix.container)), 'Describe the task…')
      assert.ok(await skillsOffered(noPrefix), 'and so does a CLI with no typed form')
      noPrefix.unmount()
    })

    // 5b. The picker itself: three groups, install and add on pick, chips,
    //     keyboard toggling, and the picks on the confirm in pick order.
    await check('the Skills & MCPs picker installs, adds and carries its picks onto the launch', async () => {
      seedStore()
      attachCalls.length = 0
      syncCalls.length = 0
      const view = await render()
      const settle = async () => {
        for (let i = 0; i < 3; i += 1) {
          await act(async () => {
            await new Promise((resolve) => dom.window.setTimeout(resolve, 0))
          })
        }
      }
      await openSkills(view)
      await settle()
      // The surface is portalled to the body; the chips stay in the panel.
      const surface = () =>
        dom.window.document.querySelector('[role="dialog"][aria-label="Skills and MCPs"]') as HTMLElement | null
      assert.ok(surface(), 'the picker opened')
      const text = surface()!.textContent ?? ''
      // It opens on Skills; the servers are the other tab.
      for (const label of ['Skills in this workspace', 'Available to install', 'Install']) {
        assert.ok(text.includes(label), `the open picker shows "${label}"`)
      }
      assert.ok(!text.includes('sprintengine-studio'), 'the servers wait behind their tab')
      const showServers = async () => {
        const tab = Array.from(surface()!.querySelectorAll('[role="radio"]')).find(
          (el) => el.textContent === 'MCP servers',
        ) as HTMLElement | undefined
        assert.ok(tab, 'the MCP servers tab is offered')
        await act(async () => {
          tab!.dispatchEvent(new dom.window.MouseEvent('click', { bubbles: true }))
        })
      }
      const listbox = surface()!.querySelector('[role="listbox"]')
      assert.equal(listbox?.getAttribute('aria-multiselectable'), 'true', 'the list is a multi-select listbox')
      const input = surface()!.querySelector('input[aria-controls]') as HTMLInputElement | null
      assert.ok(input, 'the search field names the list it drives')
      assert.equal(input!.getAttribute('aria-controls'), listbox?.id, 'through aria-controls')
      assert.equal(input!.getAttribute('role'), null, 'and is not a combobox: rows toggle, they do not commit')

      // Pointer: an installed skill toggles straight to a chip.
      const backlogRow = surface()!.querySelector('[data-picker-row="skill:backlog"]') as HTMLElement | null
      assert.ok(backlogRow, 'the reachable skill is listed')
      await act(async () => {
        backlogRow!.dispatchEvent(new dom.window.MouseEvent('click', { bubbles: true }))
      })
      assert.equal(
        surface()!.querySelector('[data-picker-row="skill:backlog"]')?.getAttribute('aria-selected'),
        'true',
        'the row is checked',
      )
      assert.ok(
        view.find((el) => el.getAttribute('aria-label') === 'Remove skill backlog'),
        'and a chip appears',
      )
      assert.equal(attachCalls.length, 0, 'an installed skill installs nothing')

      // Keyboard: ↓ to the installable skill, ⏎ installs it and checks it.
      await act(async () => {
        input!.dispatchEvent(new dom.window.KeyboardEvent('keydown', { key: 'ArrowDown', bubbles: true }))
      })
      const designRow = surface()!.querySelector('[data-picker-row="skill:design-system"]') as HTMLElement | null
      assert.equal(
        input!.getAttribute('aria-activedescendant'),
        designRow?.id,
        'the highlight moved to the Install row',
      )
      await act(async () => {
        input!.dispatchEvent(new dom.window.KeyboardEvent('keydown', { key: 'Enter', bubbles: true }))
      })
      await settle()
      assert.deepEqual(
        attachCalls.map((call) => call.skillId),
        ['design-system'],
        'Enter installed it before anything else',
      )
      assert.ok(
        view.find((el) => el.getAttribute('aria-label') === 'Remove skill design-system'),
        'and it became a chip',
      )

      // An installed MCP server whose clients do not yet reach the launch CLI:
      // the pick adds the CLI and syncs the workspace config before it counts.
      // No "Add": the picker's Add rows were the bundled catalogue's servers,
      // and the catalogue is gone. What is left is the studio gateway and the
      // servers this workspace installed.
      await showServers()
      assert.ok((surface()!.textContent ?? '').includes('sprintengine-studio'), 'the studio gateway is listed')
      const linearRow = surface()!.querySelector('[data-picker-row="mcp:linear"]') as HTMLElement | null
      assert.ok(linearRow, 'the installed server is listed')
      await act(async () => {
        linearRow!.dispatchEvent(new dom.window.MouseEvent('click', { bubbles: true }))
      })
      await settle()
      assert.equal(syncCalls.length, 1, 'the workspace config was synced once')
      const synced = syncCalls[0] as {
        workspaceRoot: string
        settings: { servers: Record<string, { clients: string[]; enabled: boolean }> }
        clients?: string[]
      }
      assert.equal(synced.workspaceRoot, '/proj')
      assert.ok(synced.settings.servers.linear?.enabled, 'with the server enabled')
      assert.ok(synced.settings.servers.linear?.clients.includes('claude-code'), 'reaching the launch CLI')
      assert.ok(
        view.find((el) => el.getAttribute('aria-label') === 'Remove MCP server Linear'),
        'and it became a chip',
      )
      assert.deepEqual(synced.clients, ['claude-code'], 'the sync is scoped to the launch CLI')

      // The picks ride the confirm in pick order.
      const start = view.find((el) => el.tagName === 'BUTTON' && el.getAttribute('aria-label') === 'Start agent')
      await act(async () => {
        start!.dispatchEvent(new dom.window.MouseEvent('click', { bubbles: true }))
      })
      const launch = view.launches[0] as
        { skills?: Array<{ id: string }>; mcpServers?: Array<{ id: string }> } | undefined
      assert.deepEqual(
        launch?.skills?.map((skill) => skill.id),
        ['backlog', 'design-system'],
      )
      assert.deepEqual(
        launch?.mcpServers?.map((server) => server.id),
        ['linear'],
      )
      view.unmount()
    })

    // 5c. A sync that fails leaves nothing behind: the app's MCP settings are
    //     put back and the row says why.
    await check('a failed MCP sync rolls the settings back and stays on the row', async () => {
      // seedStore puts Linear back as it started: installed, but not yet
      // reaching the launch CLI, which is what makes the pick attempt a sync.
      seedStore()
      syncCalls.length = 0
      syncFailure = 'EACCES: .mcp.json is read-only'
      const view = await render()
      await openSkills(view)
      for (let i = 0; i < 3; i += 1) {
        await act(async () => {
          await new Promise((resolve) => dom.window.setTimeout(resolve, 0))
        })
      }
      const surface = dom.window.document.querySelector('[role="dialog"][aria-label="Skills and MCPs"]') as HTMLElement
      const serversTab = Array.from(surface.querySelectorAll('[role="radio"]')).find(
        (el) => el.textContent === 'MCP servers',
      ) as HTMLElement
      await act(async () => {
        serversTab.dispatchEvent(new dom.window.MouseEvent('click', { bubbles: true }))
      })
      const linearRow = surface.querySelector('[data-picker-row="mcp:linear"]') as HTMLElement
      await act(async () => {
        linearRow.dispatchEvent(new dom.window.MouseEvent('click', { bubbles: true }))
      })
      for (let i = 0; i < 3; i += 1) {
        await act(async () => {
          await new Promise((resolve) => dom.window.setTimeout(resolve, 0))
        })
      }
      assert.equal(syncCalls.length, 1)
      assert.ok((surface.textContent ?? '').includes('EACCES'), 'the row carries the error')
      assert.equal(
        view.find((el) => el.getAttribute('aria-label') === 'Remove MCP server Linear'),
        undefined,
        'no chip',
      )
      assert.deepEqual(
        useWorkspaceStore.getState().appSettings.mcp?.servers?.linear?.clients,
        ['codex'],
        'the settings were put back — the launch CLI the failed pick added is gone again',
      )
      syncFailure = null
      view.unmount()
    })

    // 5d. The door's connector list is the union of what is installed and what
    //     the catalogue offers — so a server that arrived by installing a PLUGIN
    //     is listed here on its own — which is now the only way a server gets
    //     here at all, since the bundled catalogue was retired
    //     (2026-09-08; backlog/2026-09-06-shipped-mcp-servers-are-plugins.md).
    //     Checked against the row builder rather than through the render above,
    //     because the claim is about which rows exist, not about pressing one.
    await check('a server installed from a plugin is a row of its own', async () => {
      const { buildMcpRows } = await import('./SkillsAndMcpsPicker')
      const fromPlugin = {
        id: 'io-snyk-mcp',
        name: 'io-snyk-mcp',
        transport: 'stdio' as const,
        command: 'npx',
        args: ['-y', 'snyk@latest', 'mcp', '-t', 'stdio'],
        enabled: true,
        required: false,
        clients: ['claude-code'],
        scope: 'workspace' as const,
        source: 'source' as const,
        sourceRef: {
          sourceId: 'sprintengine-studio',
          itemId: 'io-snyk-mcp',
          commitSha: '4f2a91c0000',
          // Where the declaring plugin's own files landed — what makes this a
          // server that arrived by installing a plugin.
          pluginRoot: '/proj/.claude/plugins/snyk',
        },
        riskLevel: 'local-command' as const,
      }
      const rows = buildMcpRows({ 'io-snyk-mcp': fromPlugin })
      const row = rows.find((entry) => entry.id === 'io-snyk-mcp')
      assert.ok(row, 'the plugin-installed server is a row')
      assert.equal(row!.state, 'installed', 'and it is installed — there is no Add row left to confuse it with')
      assert.equal(rows.filter((entry) => entry.id === 'io-snyk-mcp').length, 1, 'exactly once')

      // A disabled server is listed as disabled, whatever a CLI last said
      // about it: picking it switches it back on for the launch.
      const off = buildMcpRows({ 'io-snyk-mcp': { ...fromPlugin, enabled: false } }, [
        {
          id: 'io-snyk-mcp',
          transport: 'stdio',
          scope: 'workspace',
          configPath: '/proj/.mcp.json',
          status: 'connected',
        },
      ])
      assert.equal(off.find((entry) => entry.id === 'io-snyk-mcp')?.status, 'disabled', 'a disabled server says so')

      // A server only the CLI knows (its own settings, a plugin, its account)
      // is listed with what it reported, and is not the picker's to add.
      const reported = buildMcpRows({}, [
        { id: 'notion', transport: '', scope: 'session', status: 'needs-auth' },
        { id: 'figma', transport: '', scope: 'session', status: 'failed', error: 'ECONNREFUSED 127.0.0.1:3845' },
      ])
      assert.deepEqual(
        reported.filter((entry) => entry.state === 'configured').map((entry) => [entry.id, entry.status, entry.error]),
        [
          ['notion', 'needs-auth', undefined],
          ['figma', 'failed', 'ECONNREFUSED 127.0.0.1:3845'],
        ],
      )
    })

    // 6. No greeting (owner ruling 2026-10-04): the composer is the page, and a
    //    signed-in name changes nothing on it.
    await check('there is no greeting, signed in or not', async () => {
      seedStore()
      useWorkspaceStore.setState({
        authState: {
          ...useWorkspaceStore.getState().authState,
          user: { id: 'u', email: 'dev@example.com', displayName: 'Sam Rivera', photoUrl: null },
        },
      } as never)
      const named = await render()
      assert.ok(!named.text().includes('Sam'), 'no name on the surface')
      assert.equal(named.container.querySelector('h1'), null, 'and no heading')
      named.unmount()
      useWorkspaceStore.setState({
        authState: { ...useWorkspaceStore.getState().authState, user: null },
      } as never)
    })

    // 7. Nothing installed: the install route, not live-looking controls.
    await check('with no agent CLI the surface offers the install route', async () => {
      seedStore({ plugins: [] })
      const view = await render({ initialSelection: { kind: 'general' } })
      const text = view.text()
      assert.ok(text.includes('No agent CLI is installed'), 'it says so plainly')
      assert.ok(composerField(view.container).closest('.hidden'), 'and hides the prompt that cannot run')
      view.unmount()
    })

    // 8. The project choice is offered because the HOST can change it, never
    // because a project already happens to be set or other workspaces happen to
    // be open. Both of those were the old condition, and both hid the picker —
    // and the Browse row inside it — at exactly the moment it was needed.
    await check('a project can be chosen with nothing open and nothing selected', async () => {
      seedStore()
      // No folder at all: what the New chat door looks like on a fresh app.
      const empty = await render({
        folderPath: null,
        projectOptions: [],
        onSelectProject: () => {},
        onBrowseProject: () => {},
      })
      const trigger = empty.find((el) => /choose a project/i.test(el.textContent ?? ''))
      assert.ok(trigger, 'with no project set the surface still offers to pick one')
      assert.equal(trigger?.tagName, 'BUTTON', 'and it is actionable, not a label')
      empty.unmount()

      // A folder, but no other workspace open — so no options to switch between.
      // Browse alone still has to be reachable.
      const soleProject = await render({
        folderPath: '/tmp/proj',
        projectOptions: [],
        onSelectProject: () => {},
        onBrowseProject: () => {},
      })
      const named = soleProject.find((el) => el.tagName === 'BUTTON' && /proj/.test(el.textContent ?? ''))
      assert.ok(named, 'the sole project is still a picker, because Browse is the point')
      soleProject.unmount()

      // The tab strip's "+": the project is a fact, not a choice, so no handlers
      // and no picker — the plain line is correct here and must not regress.
      const fixed = await render({ folderPath: '/tmp/proj' })
      assert.ok(fixed.text().includes('proj'), 'it still says where the agent will run')
      assert.equal(
        fixed.find((el) => el.tagName === 'BUTTON' && /choose a project/i.test(el.textContent ?? '')),
        undefined,
        'but offers no choice it cannot honour',
      )
      fixed.unmount()
    })

    // ── Remote machines (remote-sessions-ux / new-chat-on-a-remote-machine) ──

    const machine = (id: string, machineName: string): Record<string, unknown> => ({
      id,
      machineName,
      endpoint: `${id}.tail:7777`,
      deviceId: `d-${id}`,
      deviceName: 'this-mac',
      scopes: ['workspace:read', 'workspace:operate'],
    })
    const workspace = (id: string, name: string, folderPath: string | null = `/home/${name}`) => ({
      id,
      name,
      mode: 'standard',
      folderPath,
    })
    const settle = async () => {
      await act(async () => {
        await new Promise((resolve) => dom.window.setTimeout(resolve, 0))
      })
    }
    const click = async (el: Element | null | undefined) => {
      assert.ok(el, 'the element to click exists')
      await act(async () => {
        el!.dispatchEvent(new dom.window.MouseEvent('click', { bubbles: true }))
      })
    }
    const buttonWithText = (root: ParentNode, text: string) =>
      [...root.querySelectorAll('button')].find((button) => (button.textContent ?? '').trim().startsWith(text))
    // Permissions moved inside the model picker (owner, 2026-09-05), onto the one
    // trailing row beside the effort control, so reaching the rows is two clicks:
    // the engine chip on the panel, then the permission chip in the picker. The
    // picker is portaled, so both live on the document rather than in the panel's
    // own container.
    const engineChip = (view: Harness) =>
      [...view.container.querySelectorAll('button')].find((button) =>
        (button.getAttribute('aria-label') ?? '').startsWith('Engine: '),
      )
    const openPermissionsMenu = async (view: Harness, label: string): Promise<Element> => {
      await click(engineChip(view))
      const trigger = [...dom.window.document.querySelectorAll('button')].find(
        (button) => button.getAttribute('aria-label') === `Permissions: ${label}`,
      )
      await click(trigger)
      const menu = dom.window.document.querySelector(`[role="menu"][aria-label="Permissions: ${label}"]`)
      assert.ok(menu, `the permission menu opens inside the model picker; wanted "Permissions: ${label}"`)
      return menu!
    }
    const machineTrigger = (view: Harness) =>
      view.container.querySelector<HTMLButtonElement>('[data-machine-trigger="true"]') ?? undefined
    const openMachineMenu = async (view: Harness) => {
      await click(machineTrigger(view))
      const menu = dom.window.document.querySelector('[role="menu"][aria-label="Machine this chat runs on"]')
      assert.ok(menu, 'the machine menu opens on the popover surface')
      return menu!
    }
    const pickMachine = async (view: Harness, name: string) => {
      const menu = await openMachineMenu(view)
      await click(buttonWithText(menu, name))
      await settle()
    }
    const remoteRender = async (props: Record<string, unknown> = {}) =>
      render({
        folderPath: '/proj',
        projectOptions: [{ path: '/proj', label: 'proj' }],
        onSelectProject: () => {},
        onLaunchRemote: async () => {},
        ...props,
      })

    await check(
      'the machine dropdown lists This device first and default, paired machines alphabetically after',
      async () => {
        seedStore()
        resetRememberedMachineForTests()
        meshConnections = [machine('m2', 'Studio'), machine('m1', 'Air'), machine('m3', 'mini')]
        assert.deepEqual(
          sortMachines(meshConnections as never).map((m) => m.machineName),
          ['Air', 'mini', 'Studio'],
        )
        const view = await remoteRender()
        await settle()
        const trigger = machineTrigger(view)
        assert.ok(trigger, 'the dropdown is offered once a machine is paired')
        assert.equal(
          trigger?.textContent?.trim(),
          'This device',
          'and opens on This device — never a remote on first open',
        )
        assert.equal(
          trigger?.querySelector('svg.icon-xs.shrink-0'),
          null,
          'no machine glyph on the trigger while local',
        )
        const menu = await openMachineMenu(view)
        const rows = [...menu.querySelectorAll('[role="menuitemradio"]')].map((row) =>
          (row.querySelector('span.min-w-0')?.textContent ?? '').trim(),
        )
        assert.equal(rows[0], 'This device', 'This device heads the list')
        assert.deepEqual(rows.slice(1), ['Air', 'mini', 'Studio'], 'then the machines, sorted')
        assert.equal(menu.querySelectorAll('[role="menu"]').length, 0, 'one menu role: the surface, no nested menu')
        view.unmount()
      },
    )

    await check(
      'picking a remote machine shows the glyph, requires an explicit project unless there is exactly one, and is remembered for the session',
      async () => {
        seedStore()
        resetRememberedMachineForTests()
        meshConnections = [machine('m1', 'Air'), machine('m2', 'Mini')]
        meshBrowseAnswer = (id) => ({
          connectionId: id,
          reachable: true,
          unreachableReason: null,
          unauthorized: false,
          scopes: [],
          workspaces: id === 'm1' ? [workspace('w1', 'alpha'), workspace('w2', 'beta')] : [workspace('w9', 'solo')],
          gaps: [],
        })
        const view = await remoteRender()
        await settle()
        await pickMachine(view, 'Air')
        const trigger = machineTrigger(view)
        assert.ok(trigger?.textContent?.includes('Air'), 'the trigger names the machine')
        assert.ok(trigger?.querySelector('svg'), 'and wears the shared machine glyph only when remote')
        assert.ok(view.text().includes('Choose a project'), 'two projects → nobody picks for you')
        const projectTrigger = buttonWithText(view.container, 'Choose a project')
        await click(projectTrigger)
        const projects = dom.window.document.querySelector('[role="menu"][aria-label="Project on Air"]')
        assert.ok(projects, 'the remote project list opens')
        assert.equal(projects!.querySelectorAll('[role="menu"]').length, 0, 'no nested menu role')
        await click(buttonWithText(projects!, 'beta'))
        assert.ok(buttonWithText(view.container, 'beta'), 'an explicit pick is shown')
        view.unmount()

        // One project on the Mini: it is the only possible answer, so it is picked.
        const again = await remoteRender()
        await settle()
        assert.ok(machineTrigger(again)?.textContent?.includes('Air'), 'reopening keeps the session’s last machine')
        await pickMachine(again, 'Mini')
        assert.ok(buttonWithText(again.container, 'solo'), 'a lone project is chosen without a click')
        await pickMachine(again, 'This device')
        again.unmount()
        const fresh = await remoteRender()
        await settle()
        assert.equal(
          machineTrigger(fresh)?.textContent?.trim(),
          'This device',
          'choosing This device forgets the remote',
        )
        fresh.unmount()
      },
    )

    await check(
      "a remote machine's project list holds its projects, never the worktrees its chats run in",
      async () => {
        seedStore()
        resetRememberedMachineForTests()
        meshConnections = [machine('m1', 'Air')]
        meshBrowseAnswer = (id) => ({
          connectionId: id,
          reachable: true,
          unreachableReason: null,
          unauthorized: false,
          scopes: [],
          workspaces: [
            workspace('w1', 'alpha', '/Users/dev/alpha'),
            workspace('w2', 'slot', '/Users/dev/.sprintengine-worktrees/alpha/pool-01'),
            workspace('w3', 'cut', '/Users/dev/.sprintengine-worktrees/alpha/chat-k_iq'),
            // Open over there only through a worktree chat: still its project.
            workspace('w4', 'cut', '/Users/dev/.sprintengine-worktrees/beta/chat-3kmu'),
          ],
          gaps: [],
        })
        const view = await remoteRender()
        await settle()
        await pickMachine(view, 'Air')
        await click(buttonWithText(view.container, 'Choose a project'))
        const projects = dom.window.document.querySelector('[role="menu"][aria-label="Project on Air"]')
        assert.ok(projects, 'the remote project list opens')
        const rows = [...projects!.querySelectorAll('[role="menuitemradio"]')].map((row) =>
          [...row.querySelectorAll('span.block')].map((span) => span.textContent?.trim()),
        )
        assert.deepEqual(rows, [
          ['alpha', '/Users/dev/alpha'],
          ['beta', '/Users/dev/beta'],
        ])
        view.unmount()
      },
    )

    await check(
      "on Windows this computer's machines lead the dropdown, a pick rides the launch, and a WSL folder picks its distribution",
      async () => {
        seedStore()
        resetRememberedMachineForTests()
        meshConnections = []
        hostsAnswer = {
          hosts: [
            { id: 'local', kind: 'windows', label: 'This PC (Windows)', pathStyle: 'windows', state: 'ready' },
            {
              id: 'wsl:Ubuntu',
              kind: 'wsl',
              label: 'WSL: Ubuntu',
              pathStyle: 'wsl',
              state: 'ready',
              isDefaultDistro: true,
              enabled: true,
            },
            { id: 'wsl:Debian', kind: 'wsl', label: 'WSL: Debian', pathStyle: 'wsl', state: 'stopped', enabled: true },
          ],
          wsl: { available: true },
        }
        try {
          const view = await render({
            folderPath: 'C:\\Users\\dev\\repo',
            projectOptions: [{ path: 'C:\\Users\\dev\\repo', label: 'repo' }],
            onSelectProject: () => {},
          })
          await settle()
          assert.equal(
            machineTrigger(view)?.textContent?.trim(),
            'This PC (Windows)',
            'a Windows folder starts on This PC, with no remote paired at all',
          )
          const menu = await openMachineMenu(view)
          const rows = [...menu.querySelectorAll('[role="menuitemradio"]')].map((row) =>
            (row.querySelector('span.min-w-0')?.textContent ?? '').trim(),
          )
          assert.deepEqual(rows.slice(0, 3), ['This PC (Windows)', 'WSL: Ubuntu', 'WSL: Debian'])
          assert.match(
            menu.querySelector('[data-machine-host="wsl:Ubuntu"]')?.textContent ?? '',
            /default$/u,
            'the default distribution is marked',
          )
          await click(buttonWithText(menu, 'WSL: Debian'))
          await settle()
          assert.equal(machineTrigger(view)?.textContent?.trim(), 'WSL: Debian')
          assert.ok(detectCalls.some((call) => JSON.stringify(call).includes('"hostId":"wsl:Debian"')))
          const start = [...view.container.querySelectorAll('button')].find(
            (button) => button.getAttribute('aria-label') === 'Start agent',
          )
          await act(async () => {
            start!.dispatchEvent(new dom.window.MouseEvent('click', { bubbles: true }))
          })
          assert.equal(view.launches.at(-1)?.hostId, 'wsl:Debian', 'the machine rides the launch')
          view.unmount()

          // Debian is then turned off: the remembered pick no longer counts.
          const offered = hostsAnswer.hosts
          hostsAnswer = { ...hostsAnswer, hosts: offered.filter((host) => host.id !== 'wsl:Debian') }
          const afterOff = await render({
            folderPath: 'C:\\Users\\dev\\repo',
            projectOptions: [],
            onSelectProject: () => {},
          })
          await settle()
          assert.equal(
            machineTrigger(afterOff)?.textContent?.trim(),
            'This PC (Windows)',
            'a machine no longer offered',
          )
          afterOff.unmount()
          hostsAnswer = { ...hostsAnswer, hosts: offered }

          const inDistro = await render({
            folderPath: '\\\\wsl.localhost\\Ubuntu\\home\\dev\\repo',
            projectOptions: [],
            onSelectProject: () => {},
          })
          await settle()
          assert.equal(machineTrigger(inDistro)?.textContent?.trim(), 'WSL: Ubuntu', 'the folder names its machine')
          const distroMenu = await openMachineMenu(inDistro)
          const debian = [...distroMenu.querySelectorAll<HTMLButtonElement>('[data-machine-host="wsl:Debian"]')][0]
          assert.equal(debian?.disabled, true, 'another distribution cannot take a folder inside this one')
          assert.match(debian?.textContent ?? '', /cannot open a folder inside Ubuntu/u)
          // This PC can take it (owner ruling 2026-10-03): the pick wins over
          // the folder, rides the launch, and the line under the scope says
          // what it costs.
          const thisPc = [...distroMenu.querySelectorAll<HTMLButtonElement>('[data-machine-option="true"]')][0]
          assert.equal(thisPc?.textContent?.trim(), 'This PC (Windows)')
          assert.equal(thisPc?.disabled, false, 'This PC is never refused a folder inside a distribution')
          await click(thisPc!)
          await settle()
          assert.equal(machineTrigger(inDistro)?.textContent?.trim(), 'This PC (Windows)', 'the pick wins')
          assert.match(
            inDistro.container.textContent ?? '',
            /In Ubuntu — slow from Windows\. Run on WSL: Ubuntu for full speed\./u,
          )
          const startHere = [...inDistro.container.querySelectorAll('button')].find(
            (button) => button.getAttribute('aria-label') === 'Start agent',
          )
          await act(async () => {
            startHere!.dispatchEvent(new dom.window.MouseEvent('click', { bubbles: true }))
          })
          assert.equal(inDistro.launches.at(-1)?.hostId, 'local', 'This PC rides the launch')
          inDistro.unmount()
        } finally {
          hostsAnswer = { hosts: [], wsl: null }
          resetRememberedMachineForTests()
        }
      },
    )

    await check('a Claude Code chat runs on the WSL machine it was started on', async () => {
      seedStore()
      resetRememberedMachineForTests()
      meshConnections = []
      hostsAnswer = {
        hosts: [
          { id: 'local', kind: 'windows', label: 'This PC (Windows)', pathStyle: 'windows', state: 'ready' },
          { id: 'wsl:Ubuntu', kind: 'wsl', label: 'WSL: Ubuntu', pathStyle: 'wsl', state: 'ready', enabled: true },
        ],
        wsl: { available: true },
      }
      try {
        const view = await render({
          initialSelection: { kind: 'conversation' },
          folderPath: '\\\\wsl.localhost\\Ubuntu\\home\\dev\\repo',
          projectOptions: [],
          onSelectProject: () => {},
        })
        await settle()
        assert.equal(machineTrigger(view)?.textContent?.trim(), 'WSL: Ubuntu')
        const menu = await openMachineMenu(view)
        const ubuntu = menu.querySelector<HTMLButtonElement>('[data-machine-host="wsl:Ubuntu"]')
        assert.equal(ubuntu?.disabled, false, 'a chat may pick the distribution')
        assert.doesNotMatch(ubuntu?.textContent ?? '', /run on This PC/u)
        await act(async () => {
          dom.window.document.dispatchEvent(new dom.window.KeyboardEvent('keydown', { key: 'Escape', bubbles: true }))
        })
        const field = composerField(view.container)
        await act(async () => {
          typeIntoComposer(field, 'hi')
        })
        await act(async () => {
          field.dispatchEvent(
            new dom.window.KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true }),
          )
        })
        const launch = view.launches.at(-1)
        assert.equal(launch?.kind, 'conversation')
        assert.equal(launch?.hostId, 'wsl:Ubuntu', 'the chat runs where its folder is, not on This PC')
        view.unmount()
      } finally {
        hostsAnswer = { hosts: [], wsl: null }
        resetRememberedMachineForTests()
      }
    })

    // Every chat runtime runs on a WSL machine (owner ruling 2026-10-01): a
    // Codex chat there is neither stranded nor sent back to This PC.
    await check('a Codex chat runs on the WSL machine it was started on, like any other chat', async () => {
      seedStore({
        plugins: [
          {
            id: 'codex',
            displayName: 'Codex',
            source: 'bundled',
            version: 1,
            binary: 'codex',
            resumeSession: true,
            sessionIdFromCaller: true,
          },
        ],
      })
      resetRememberedMachineForTests()
      meshConnections = []
      detectAnswer = {
        codex: { cli: 'codex', installed: true, resolvedPath: '/home/dev/.local/bin/codex', version: '1' },
      }
      hostsAnswer = {
        hosts: [
          { id: 'local', kind: 'windows', label: 'This PC (Windows)', pathStyle: 'windows', state: 'ready' },
          { id: 'wsl:Ubuntu', kind: 'wsl', label: 'WSL: Ubuntu', pathStyle: 'wsl', state: 'ready', enabled: true },
        ],
        wsl: { available: true },
      }
      try {
        const view = await render({
          initialSelection: { kind: 'conversation' },
          folderPath: '\\\\wsl.localhost\\Ubuntu\\home\\dev\\repo',
          projectOptions: [],
          onSelectProject: () => {},
        })
        await settle()
        assert.equal(machineTrigger(view)?.textContent?.trim(), 'WSL: Ubuntu')
        assert.doesNotMatch(view.text(), /This PC only|Pick Claude Code/u, 'nothing says the chat cannot run there')
        const menu = await openMachineMenu(view)
        const ubuntu = menu.querySelector<HTMLButtonElement>('[data-machine-host="wsl:Ubuntu"]')
        assert.equal(ubuntu?.disabled, false, 'a Codex chat may pick the distribution')
        assert.doesNotMatch(ubuntu?.textContent ?? '', /run on This PC/u)
        await act(async () => {
          dom.window.document.dispatchEvent(new dom.window.KeyboardEvent('keydown', { key: 'Escape', bubbles: true }))
        })
        const field = composerField(view.container)
        await act(async () => {
          typeIntoComposer(field, 'hi')
        })
        await act(async () => {
          field.dispatchEvent(
            new dom.window.KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true }),
          )
        })
        const launch = view.launches.at(-1)
        assert.equal(launch?.kind, 'conversation')
        assert.equal(launch?.cli, 'codex')
        assert.equal(launch?.hostId, 'wsl:Ubuntu', 'the Codex chat runs where its folder is')
        view.unmount()
      } finally {
        detectAnswer = claudeOnly
        hostsAnswer = { hosts: [], wsl: null }
        resetRememberedMachineForTests()
      }
    })

    await check('unreachable, unauthorized and workspace-gap machines say their real reason', async () => {
      seedStore()
      resetRememberedMachineForTests()
      meshConnections = [machine('down', 'Down'), machine('revoked', 'Revoked'), machine('gap', 'Gap')]
      meshBrowseAnswer = (id) => ({
        connectionId: id,
        reachable: id !== 'down',
        unreachableReason: id === 'down' ? 'Down is asleep.' : null,
        unauthorized: id === 'revoked',
        scopes: [],
        workspaces: [],
        gaps:
          id === 'gap' ? [{ part: 'workspaces', code: 'scope', message: 'This pairing may not list workspaces.' }] : [],
      })
      const view = await remoteRender()
      await settle()
      const reasonFor = async (name: string) => {
        await pickMachine(view, name)
        await click(buttonWithText(view.container, 'Unavailable'))
        const menu = dom.window.document.querySelector(`[role="menu"][aria-label="Project on ${name}"]`)
        const text = menu?.textContent ?? ''
        await act(async () => {
          dom.window.document.dispatchEvent(new dom.window.KeyboardEvent('keydown', { key: 'Escape', bubbles: true }))
        })
        return text
      }
      assert.ok((await reasonFor('Down')).includes('Down is asleep.'), 'unreachable carries the machine’s reason')
      assert.ok(/refused this pairing/.test(await reasonFor('Revoked')), 'unauthorized says re-pair')
      assert.ok(
        (await reasonFor('Gap')).includes('may not list workspaces'),
        'a scope gap is the gap’s message, never "no workspaces"',
      )
      view.unmount()
    })

    await check(
      'a remote launch carries its attached images as bytes, and refuses a second submit while one is in flight',
      async () => {
        seedStore()
        resetRememberedMachineForTests()
        meshConnections = [machine('m1', 'Air')]
        meshBrowseAnswer = (id) => ({
          connectionId: id,
          reachable: true,
          unreachableReason: null,
          unauthorized: false,
          scopes: [],
          workspaces: [workspace('w1', 'alpha', '/srv/alpha')],
          gaps: [],
        })
        const remoteLaunches: Array<Record<string, unknown>> = []
        let release: () => void = () => {}
        const view = await remoteRender({
          onLaunchRemote: (launch: Record<string, unknown>) => {
            remoteLaunches.push(launch)
            return new Promise<void>((resolve) => {
              release = resolve
            })
          },
        })
        await settle()
        await pickMachine(view, 'Air')
        const textarea = composerField(view.container)
        await act(async () => {
          typeIntoComposer(textarea, 'fix the build')
        })

        // Drop an image: it goes with the launch, as the image it is, shrunk
        // the way the chat's composer shrinks one.
        useToastStore.setState({ toasts: [] })
        imageDecoding.decoded = { width: 3136, height: 2352 }
        imageDecoding.encodedBytes = 900
        imageDecoding.drawn.length = 0
        const file = new dom.window.File([new Uint8Array([137, 80, 78, 71])], 'shot.png', { type: 'image/png' })
        const box = textarea.closest('[class*="relative"]')!
        const dropEvent = new dom.window.Event('drop', { bubbles: true, cancelable: true })
        Object.defineProperty(dropEvent, 'dataTransfer', {
          value: { types: ['Files'], items: [{ kind: 'file', getAsFile: () => file }], files: [file] },
        })
        await act(async () => {
          box.dispatchEvent(dropEvent)
        })
        await settle()
        await settle()
        const enter = () =>
          act(async () => {
            textarea.dispatchEvent(
              new dom.window.KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true }),
            )
          })

        // One Enter starts, the second is refused while the first is still
        // in flight.
        await enter()
        await enter()
        assert.equal(remoteLaunches.length, 1, 'a second submit during an in-flight remote create is refused')
        assert.equal(
          useToastStore.getState().toasts.find((toast) => toast.title === 'That chat cannot travel yet'),
          undefined,
          'an attached image no longer stops a chat on a paired machine',
        )
        assert.equal(
          remoteLaunches[0]?.prompt,
          'fix the build',
          'the words are the words, with no path typed into them',
        )
        const images = remoteLaunches[0]?.images as Array<Record<string, unknown>> | undefined
        assert.equal(images?.length, 1, 'the image goes with the launch')
        assert.equal(images?.[0]?.mediaType, 'image/png')
        assert.equal(images?.[0]?.name, 'shot.png')
        assert.ok(typeof images?.[0]?.dataBase64 === 'string' && images[0].dataBase64.length > 0, 'as its bytes')
        assert.deepEqual(
          imageDecoding.drawn,
          [{ width: 1568, height: 1176 }],
          'drawn at the long edge a vision model uses, not the 3136px it was taken at',
        )
        assert.equal(images?.[0]?.byteLength, 900, 'and those are the bytes that go')
        assert.equal(
          Buffer.from(String(images?.[0]?.dataBase64), 'base64').length,
          900,
          'the shrunk image, not the file as dropped',
        )
        imageDecoding.decoded = { width: 400, height: 300 }
        assert.equal('path' in (images?.[0] ?? {}), false, 'and not as a path on this disk, which names nothing there')
        assert.equal(
          remoteLaunches[0]?.remoteWorkspaceRoot,
          '/srv/alpha',
          'the launch carries the remote folder for provenance',
        )
        assert.equal(remoteLaunches[0]?.remoteWorkspaceName, 'alpha')
        await act(async () => {
          release()
        })
        await settle()
        await enter()
        assert.equal(remoteLaunches.length, 2, 'and is accepted once the first settles')
        view.unmount()
      },
    )

    await check('a remote launch refuses attached files rather than typing this disk’s paths there', async () => {
      seedStore()
      resetRememberedMachineForTests()
      const { writeNewChatDraft, resetNewChatDraftsForTests } = await import('./newChatDraft')
      resetNewChatDraftsForTests()
      writeNewChatDraft('win-files', { prompt: 'summarise', files: ['/Users/dev/Desktop/Q3 budget.xlsx'] })
      meshConnections = [machine('m1', 'Air')]
      meshBrowseAnswer = (id) => ({
        connectionId: id,
        reachable: true,
        unreachableReason: null,
        unauthorized: false,
        scopes: [],
        workspaces: [workspace('w1', 'alpha', '/srv/alpha')],
        gaps: [],
      })
      const remoteLaunches: Array<Record<string, unknown>> = []
      const view = await remoteRender({
        initialSelection: { kind: 'conversation' },
        draftKey: 'win-files',
        onLaunchRemote: async (launch: Record<string, unknown>) => {
          remoteLaunches.push(launch)
        },
      })
      await settle()
      await pickMachine(view, 'Air')
      useToastStore.setState({ toasts: [] })
      const field = composerField(view.container)
      await act(async () => {
        field.dispatchEvent(new dom.window.KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true }))
      })
      assert.equal(remoteLaunches.length, 0, 'nothing launched with a file attached')
      const refusal = useToastStore.getState().toasts.find((toast) => toast.title === 'That chat cannot travel yet')
      assert.ok(
        refusal?.description?.includes('the attached files'),
        `it names the files; got: ${refusal?.description}`,
      )
      view.unmount()
      resetNewChatDraftsForTests()
    })

    await check(
      'a terminal agent on a WSL machine is typed its files as Linux spells this computer’s drives',
      async () => {
        seedStore()
        resetRememberedMachineForTests()
        meshConnections = []
        const { writeNewChatDraft, resetNewChatDraftsForTests } = await import('./newChatDraft')
        resetNewChatDraftsForTests()
        writeNewChatDraft('win-wsl', {
          prompt: 'summarise',
          files: ['C:\\Users\\dev\\Q3 budget.xlsx'],
          images: [{ id: 'i', mediaType: 'image/png', dataBase64: 'AAAA', byteLength: 4, path: 'C:\\Temp\\shot.png' }],
        })
        hostsAnswer = {
          hosts: [
            { id: 'local', kind: 'windows', label: 'This PC (Windows)', pathStyle: 'windows', state: 'ready' },
            { id: 'wsl:Ubuntu', kind: 'wsl', label: 'WSL: Ubuntu', pathStyle: 'wsl', state: 'ready', enabled: true },
          ],
          wsl: { available: true },
        }
        try {
          const view = await render({
            initialSelection: { kind: 'general' },
            draftKey: 'win-wsl',
            folderPath: '\\\\wsl.localhost\\Ubuntu\\home\\dev\\repo',
            projectOptions: [],
            onSelectProject: () => {},
          })
          await settle()
          const field = composerField(view.container)
          await act(async () => {
            field.dispatchEvent(
              new dom.window.KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true }),
            )
          })
          const launch = view.launches.at(-1)
          assert.equal(launch?.hostId, 'wsl:Ubuntu')
          assert.equal(launch?.prompt, "summarise /mnt/c/Temp/shot.png '/mnt/c/Users/dev/Q3 budget.xlsx'")
          view.unmount()
        } finally {
          hostsAnswer = { hosts: [], wsl: null }
          resetRememberedMachineForTests()
          resetNewChatDraftsForTests()
        }
      },
    )

    await check('a paired machine is sent the picked effort only where it keeps one', async () => {
      const { writeNewChatDraft, resetNewChatDraftsForTests } = await import('./newChatDraft')
      for (const keeps of [true, false]) {
        seedStore()
        resetRememberedMachineForTests()
        resetNewChatDraftsForTests()
        writeNewChatDraft('win-effort', { engine: { cli: 'claude-code', model: null, reasoning: 'high' } })
        meshConnections = [machine('m1', 'Air')]
        meshBrowseAnswer = (id) => ({
          connectionId: id,
          reachable: true,
          unreachableReason: null,
          unauthorized: false,
          scopes: [],
          workspaces: [workspace('w1', 'alpha', '/srv/alpha')],
          gaps: [],
          capabilities: keeps ? ['conversations', 'new-chat-effort'] : ['conversations'],
        })
        const remoteLaunches: Array<Record<string, unknown>> = []
        const view = await remoteRender({
          initialSelection: { kind: 'conversation' },
          draftKey: 'win-effort',
          onLaunchRemote: async (launch: Record<string, unknown>) => {
            remoteLaunches.push(launch)
          },
        })
        await settle()
        const engineChip = () =>
          [...view.container.querySelectorAll('button')].find((button) =>
            (button.getAttribute('aria-label') ?? '').startsWith('Engine:'),
          )
        assert.match(engineChip()?.textContent ?? '', /· high/, 'here, the chip names the level')
        await pickMachine(view, 'Air')
        assert.equal(
          /· high/.test(engineChip()?.textContent ?? ''),
          keeps,
          keeps ? 'a machine that keeps it shows the level' : 'one that does not names no level',
        )
        const field = composerField(view.container)
        await act(async () => {
          typeIntoComposer(field, 'fix the build')
        })
        await act(async () => {
          field.dispatchEvent(
            new dom.window.KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true }),
          )
        })
        assert.equal(remoteLaunches.length, 1)
        assert.equal(remoteLaunches[0]?.effort, keeps ? 'high' : undefined)
        view.unmount()
      }
      resetNewChatDraftsForTests()
    })

    await check('a chat agent can run on a paired machine, and launches there as a chat', async () => {
      seedStore()
      resetRememberedMachineForTests()
      meshConnections = [machine('m1', 'Air')]
      meshBrowseAnswer = (id) => ({
        connectionId: id,
        reachable: true,
        unreachableReason: null,
        unauthorized: false,
        scopes: [],
        workspaces: [workspace('w1', 'alpha', '/srv/alpha')],
        gaps: [],
      })
      const remoteLaunches: Array<Record<string, unknown>> = []
      const view = await remoteRender({
        initialSelection: { kind: 'conversation' },
        onLaunchRemote: async (launch: Record<string, unknown>) => {
          remoteLaunches.push(launch)
        },
      })
      await settle()
      assert.ok(machineTrigger(view), 'the machine dropdown is offered for a chat agent')
      await pickMachine(view, 'Air')
      assert.ok(machineTrigger(view)?.textContent?.includes('Air'), 'and a paired machine can be picked')
      const textarea = composerField(view.container)
      await act(async () => {
        typeIntoComposer(textarea, 'fix the build')
      })
      await act(async () => {
        textarea.dispatchEvent(
          new dom.window.KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true }),
        )
      })
      await settle()
      assert.equal(view.launches.length, 0, 'nothing starts on this machine')
      assert.equal(remoteLaunches.length, 1, 'the chat travels')
      const launch = remoteLaunches[0]!
      assert.equal(launch.cli, 'claude-code')
      assert.equal(launch.prompt, 'fix the build')
      assert.equal(launch.remoteWorkspaceId, 'w1')
      view.unmount()
    })

    await check(
      'a remote target offers every preset and launches on the one the launcher shows, bypass included',
      async () => {
        seedStore()
        resetRememberedMachineForTests()
        meshConnections = [machine('m1', 'Air')]
        meshBrowseAnswer = (id) => ({
          connectionId: id,
          reachable: true,
          unreachableReason: null,
          unauthorized: false,
          scopes: [],
          workspaces: [workspace('w1', 'alpha')],
          gaps: [],
        })
        const remoteLaunches: Array<Record<string, unknown>> = []
        const view = await remoteRender({
          permissionPreset: 'bypass',
          onLaunchRemote: async (launch: Record<string, unknown>) => {
            remoteLaunches.push(launch)
          },
        })
        await settle()
        await pickMachine(view, 'Air')
        // Picking a machine moves nothing: the chip still reads Bypass, and no
        // row is dimmed for the remote.
        assert.ok(!/Switched permissions/.test(view.text()), 'no narrowing note')
        const menu = await openPermissionsMenu(view, 'Bypass permissions')
        assert.ok(!/Not available/.test(menu.textContent ?? ''), 'no row carries a remote refusal')
        const rows = [...menu.querySelectorAll<HTMLButtonElement>('[data-preset-option="true"]')]
        assert.equal(rows.length, 4, 'the switcher lists the four presets')
        assert.deepEqual(
          rows.map((row) => row.disabled),
          [false, false, false, false],
          'every preset is open on a remote machine',
        )
        const checked = rows.find((row) => row.getAttribute('aria-checked') === 'true')!
        assert.equal(checked, rows[2], 'Bypass is the checked row')
        await act(async () => {
          dom.window.document.dispatchEvent(
            new dom.window.KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true }),
          )
        })
        await settle()

        const textarea = composerField(view.container)
        await act(async () => {
          typeIntoComposer(textarea, 'fix the build')
        })
        await act(async () => {
          textarea.dispatchEvent(
            new dom.window.KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true }),
          )
        })
        await settle()
        assert.equal(remoteLaunches.length, 1, 'the launch travels')
        assert.equal(
          remoteLaunches[0]?.permissionPreset,
          'bypass',
          'named explicitly, so the far end runs on what this launcher showed',
        )
        view.unmount()
      },
    )

    await check(
      'picking a paired machine makes the launch a chat, and choosing Agent or Terminal after it returns to This device',
      async () => {
        seedStore()
        resetRememberedMachineForTests()
        meshConnections = [machine('m1', 'Air')]
        meshBrowseAnswer = (id) => ({
          connectionId: id,
          reachable: true,
          unreachableReason: null,
          unauthorized: false,
          scopes: [],
          workspaces: [workspace('w1', 'alpha')],
          gaps: [],
        })
        const checkedKind = async (view: Harness): Promise<string | undefined> => {
          const menu = await openOptions(view)
          const kind = menu?.querySelector('[data-start-as][aria-checked="true"]')?.getAttribute('data-start-as')
          await act(async () => {
            dom.window.document.dispatchEvent(
              new dom.window.KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true }),
            )
          })
          return kind ?? undefined
        }
        const view = await remoteRender()
        await settle()
        assert.equal(await checkedKind(view), 'general', 'the door opens on Terminal agent, on This device')
        await pickMachine(view, 'Air')
        assert.ok(machineTrigger(view)?.textContent?.includes('Air'), 'the machine is picked')
        assert.equal(
          await checkedKind(view),
          'conversation',
          'and the launch becomes a chat, the one kind that travels',
        )

        await pickKind(view, 'general')
        await settle()
        assert.equal(machineTrigger(view)?.textContent?.trim(), 'This device', 'Agent runs here, so the target returns')

        await pickMachine(view, 'Air')
        assert.equal(await checkedKind(view), 'conversation')
        await pickKind(view, 'terminal')
        await settle()
        // A bare terminal offers no machine at all; back on Chat agent, the
        // target it left behind is This device, not the machine picked before.
        assert.ok(
          [undefined, 'This device'].includes(machineTrigger(view)?.textContent?.trim()),
          'no remote target survives a Terminal pick',
        )
        await pickKind(view, 'conversation')
        await settle()
        assert.equal(machineTrigger(view)?.textContent?.trim(), 'This device', 'and so does Terminal')
        view.unmount()
      },
    )

    // A paired machine that cuts worktrees for a chat started from here: the
    // strip offers the Worktree chip as it does for this device, and a picker
    // of the worktrees the project already has there.
    const worktreeMachineBrowse = (capabilities: string[]) => (id: string) => ({
      connectionId: id,
      reachable: true,
      unreachableReason: null,
      unauthorized: false,
      scopes: ['workspace:read', 'conversation:operate'],
      workspaces: [workspace('w1', 'alpha', '/srv/alpha')],
      gaps: [],
      capabilities,
    })
    const checkoutWithWorktrees = (_c: string, workspaceId: string) => ({
      ok: true,
      checkout: {
        workspaceId,
        git: true,
        branch: 'main',
        defaultBranch: 'main',
        branches: [
          { name: 'main', current: true },
          { name: 'feat/search', current: false },
        ],
        worktrees: [
          { path: '/srv/alpha', branch: 'main', isMain: true },
          { path: '/srv/.sprintengine-worktrees/alpha/search', branch: 'feat/search', isMain: false },
        ],
      },
    })
    const ALL_WORKTREE_CAPABILITIES = [
      'conversations',
      'new-chat-worktree',
      'new-chat-worktree-name',
      'new-chat-in-worktree',
    ]
    const sendWithEnter = async (view: Harness, text: string) => {
      const field = composerField(view.container)
      await act(async () => {
        typeIntoComposer(field, text)
      })
      await act(async () => {
        field.dispatchEvent(new dom.window.KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true }))
      })
      await settle()
    }

    await check(
      'a paired machine that cuts worktrees offers the Worktree chip, and a named one rides the launch',
      async () => {
        const { writeNewChatDraft, resetNewChatDraftsForTests } = await import('./newChatDraft')
        seedStore()
        resetRememberedMachineForTests()
        resetNewChatDraftsForTests()
        writeNewChatDraft('win-remote-wt', { prompt: '' })
        meshConnections = [machine('m1', 'Air')]
        meshBrowseAnswer = worktreeMachineBrowse(ALL_WORKTREE_CAPABILITIES)
        meshCheckoutAnswer = checkoutWithWorktrees
        const remoteLaunches: Array<Record<string, unknown>> = []
        const view = await remoteRender({
          draftKey: 'win-remote-wt',
          onLaunchRemote: async (launch: Record<string, unknown>) => {
            remoteLaunches.push(launch)
          },
        })
        await settle()
        await pickMachine(view, 'Air')
        await settle()
        const chip = view.container.querySelector('[data-worktree-chip]')
        assert.equal(chip?.getAttribute('data-worktree-chip'), 'on', 'the door starts the remote chat in a worktree')
        const nameField = chip?.querySelector<HTMLInputElement>('input')
        assert.ok(nameField, 'and the machine takes a name for it')
        await act(async () => {
          const setter = Object.getOwnPropertyDescriptor(dom.window.HTMLInputElement.prototype, 'value')!.set!
          setter.call(nameField, 'login-fix')
          nameField!.dispatchEvent(new dom.window.Event('input', { bubbles: true }))
        })
        assert.equal(
          view.container.querySelector('[data-remote-worktree-trigger="true"]'),
          null,
          'no picker of a branch or worktree to start from: a worktree is cut from the default branch on origin',
        )
        assert.equal(
          view.container.querySelector('[data-composer-branch]'),
          null,
          'nor a branch it is said to be cut from',
        )
        await sendWithEnter(view, 'fix the build')
        assert.equal(remoteLaunches.length, 1, 'the chat travels')
        assert.deepEqual(remoteLaunches[0]?.worktree, { kind: 'new', name: 'login-fix' })
        view.unmount()
        resetNewChatDraftsForTests()
      },
    )

    await check(
      'a paired machine that cuts worktrees but takes no name offers the chip without a name field, and sends none',
      async () => {
        const { writeNewChatDraft, resetNewChatDraftsForTests } = await import('./newChatDraft')
        seedStore()
        resetRememberedMachineForTests()
        resetNewChatDraftsForTests()
        writeNewChatDraft('win-remote-unnamed', { prompt: '', worktreeName: 'typed-earlier' })
        meshConnections = [machine('m1', 'Air')]
        meshBrowseAnswer = worktreeMachineBrowse(['conversations', 'new-chat-worktree'])
        meshCheckoutAnswer = checkoutWithWorktrees
        const remoteLaunches: Array<Record<string, unknown>> = []
        const view = await remoteRender({
          draftKey: 'win-remote-unnamed',
          onLaunchRemote: async (launch: Record<string, unknown>) => {
            remoteLaunches.push(launch)
          },
        })
        await settle()
        await pickMachine(view, 'Air')
        await settle()
        const chip = view.container.querySelector('[data-worktree-chip]')
        assert.equal(chip?.getAttribute('data-worktree-chip'), 'on')
        assert.equal(chip?.querySelector('input'), null, 'no name field')
        assert.equal(
          view.container.querySelector('[data-remote-worktree-trigger="true"]'),
          null,
          'and no picker of existing worktrees, which that machine cannot start a chat in',
        )
        await sendWithEnter(view, 'fix the build')
        assert.deepEqual(remoteLaunches[0]?.worktree, { kind: 'new', name: '' })
        view.unmount()
        resetNewChatDraftsForTests()
      },
    )

    await check(
      'a remote chat carries no checkout control: no worktree chip, and the branch the panel read rides the launch',
      async () => {
        seedStore()
        resetRememberedMachineForTests()
        meshConnections = [machine('m1', 'Air')]
        meshBrowseAnswer = (id) => ({
          connectionId: id,
          reachable: true,
          unreachableReason: null,
          unauthorized: false,
          scopes: ['workspace:operate', 'conversation:operate'],
          workspaces: [workspace('w1', 'alpha', '/srv/alpha')],
          gaps: [],
        })
        const checkoutReads: string[] = []
        meshCheckoutAnswer = (_c, workspaceId) => {
          checkoutReads.push(workspaceId)
          return {
            ok: true,
            checkout: {
              workspaceId,
              git: true,
              branch: 'main',
              defaultBranch: 'main',
              branches: [{ name: 'main', current: true }],
              worktrees: [{ path: '/srv/alpha', branch: 'main', isMain: true }],
            },
          }
        }
        const remoteLaunches: Array<Record<string, unknown>> = []
        const view = await remoteRender({
          onLaunchRemote: async (launch: Record<string, unknown>) => {
            remoteLaunches.push(launch)
          },
        })
        await settle()
        await pickMachine(view, 'Air')
        await settle()
        assert.deepEqual(checkoutReads, ['w1'], 'the lone project is picked, and its checkout read once')
        assert.equal(
          view.container.querySelector('[data-checkout-trigger="true"]'),
          null,
          'no checkout chip on the scope line',
        )
        assert.equal(view.container.querySelector('[data-branch-trigger="true"]'), null, 'and no branch picker')

        assert.equal(
          view.container.querySelector('[data-worktree-chip]'),
          null,
          'a machine that has not said it cuts worktrees for a chat from here offers no worktree chip',
        )

        const textarea = composerField(view.container)
        await act(async () => {
          typeIntoComposer(textarea, 'fix the build')
        })
        await act(async () => {
          textarea.dispatchEvent(
            new dom.window.KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true }),
          )
        })
        await settle()
        assert.equal(remoteLaunches.length, 1, 'the chat travels')
        assert.equal(remoteLaunches[0]?.branch, 'main', 'with the branch the panel read, for the row')
        assert.equal('checkout' in (remoteLaunches[0] ?? {}), false, 'and no checkout request')
        assert.equal('worktree' in (remoteLaunches[0] ?? {}), false, 'and no worktree')
        view.unmount()
      },
    )

    await check(
      'with a project in hand the machine list says which machines have it, picking one keeps the project, and This device returns to the local clone',
      async () => {
        seedStore()
        resetRememberedMachineForTests()
        const sprintengine = {
          canonicalKey: 'github.com/acme/sprintengine',
          remoteUrl: 'git@github.com:acme/sprintengine.git',
          name: 'sprintengine',
        }
        localIdentityAnswer = (folderPath) => (folderPath === '/proj' ? sprintengine : null)
        meshConnections = [machine('m1', 'Air'), machine('m2', 'Mini'), machine('m3', 'Down')]
        const browsed: string[] = []
        meshBrowseAnswer = (id) => {
          browsed.push(id)
          return {
            connectionId: id,
            reachable: id !== 'm3',
            unreachableReason: id === 'm3' ? 'Down is asleep.' : null,
            unauthorized: false,
            scopes: ['workspace:operate'],
            workspaces:
              id === 'm1'
                ? [
                    {
                      ...workspace('w1', 'other', '/srv/other'),
                      repository: { canonicalKey: 'github.com/acme/other', remoteUrl: '', name: 'other' },
                    },
                    { ...workspace('w2', 'sprintengine-air', '/srv/sprintengine'), repository: sprintengine },
                  ]
                : [{ ...workspace('w9', 'scratch', '/srv/scratch'), repository: null }],
            gaps: [],
          }
        }
        const selected: string[] = []
        const view = await remoteRender({
          folderPath: '/proj',
          projectOptions: [
            { path: '/proj', label: 'proj' },
            { path: '/other', label: 'other' },
          ],
          onSelectProject: (path: string) => selected.push(path),
        })
        await settle()
        await settle()
        assert.deepEqual(browsed, [], 'nothing is asked until the list is opened')
        const menu = await openMachineMenu(view)
        await settle()
        await settle()
        assert.deepEqual(browsed.sort(), ['m1', 'm2', 'm3'], 'opening the list asks every machine what it holds — once')
        const rowsByName = new Map(
          [...menu.querySelectorAll<HTMLButtonElement>('[data-machine-option="true"]')].map((row) => [
            (row.querySelector('span.block')?.textContent ?? row.textContent ?? '').trim(),
            row,
          ]),
        )
        const air = rowsByName.get('Air')!
        const mini = rowsByName.get('Mini')!
        const down = rowsByName.get('Down')!
        assert.equal(air.getAttribute('data-machine-availability'), 'has')
        assert.equal(air.disabled, false)
        assert.ok(air.textContent?.includes('Has sprintengine'), `the row names the copy; got: ${air.textContent}`)
        assert.equal(mini.getAttribute('data-machine-availability'), 'lacks')
        assert.equal(mini.disabled, true, 'a machine without the project is dimmed, not removed')
        assert.ok(
          mini.textContent?.includes('No copy of sprintengine on Mini'),
          `with the reason; got: ${mini.textContent}`,
        )
        assert.equal(down.disabled, true)
        assert.ok(down.textContent?.includes('Down is asleep.'), 'an unreachable machine carries its reason')
        assert.equal(rowsByName.get('This device')!.disabled, false, 'This device is always open')

        await click(air)
        await settle()
        await settle()
        // The chip names the FOLDER, not the chat standing in it: `w2` is a
        // conversation called "sprintengine-air" open in /srv/sprintengine, and the
        // project the launch is scoped to is /srv/sprintengine.
        assert.equal(
          view.container.querySelector('[data-project-trigger="true"]')?.textContent?.trim(),
          'sprintengine',
          'picking the machine keeps the project: its copy is chosen, not the first row',
        )
        assert.equal(browsed.filter((id) => id === 'm1').length, 2, 'the pick re-reads the machine for freshness')

        // Back to This device: the local clone of the same repository is the project.
        await pickMachine(view, 'This device')
        await settle()
        assert.equal(selected.length, 0, 'the door was already on /proj, the local clone, so nothing is re-selected')
        assert.equal(machineTrigger(view)?.textContent?.trim(), 'This device')
        view.unmount()

        // From a remote project to This device when the door is scoped elsewhere.
        resetRememberedMachineForTests()
        const elsewhere = await remoteRender({
          folderPath: '/other',
          projectOptions: [
            { path: '/proj', label: 'proj' },
            { path: '/other', label: 'other' },
          ],
          onSelectProject: (path: string) => selected.push(path),
        })
        await settle()
        await pickMachine(elsewhere, 'Air')
        await settle()
        // Two projects on the Air and none in hand (/other has no identity): an explicit pick.
        await click(buttonWithText(elsewhere.container, 'Choose a project'))
        const projects = dom.window.document.querySelector('[role="menu"][aria-label="Project on Air"]')!
        // The row is the folder /srv/sprintengine, whatever the chat standing in it
        // happens to be called over there.
        await click(
          [...projects.querySelectorAll<HTMLButtonElement>('[role="menuitemradio"]')].find((row) =>
            (row.textContent ?? '').includes('/srv/sprintengine'),
          ),
        )
        await settle()
        await pickMachine(elsewhere, 'This device')
        await settle()
        assert.deepEqual(selected, ['/proj'], 'This device keeps the project by selecting the open local clone of it')
        elsewhere.unmount()
        localIdentityAnswer = () => null
      },
    )

    // The chip and its menu were lifted out of this file into ProjectScopePicker
    // so the Design door can ask the same question with the same control. New chat
    // must be unchanged by the move: the chip is still here, and it still offers
    // BOTH sources — Browse… and Import from Git.
    await check('the lifted project chip still opens New chat’s own sources', async () => {
      seedStore()
      resetRememberedMachineForTests()
      meshConnections = []
      const view = await render({
        folderPath: '/proj',
        projectOptions: [
          { path: '/proj', label: 'proj' },
          { path: '/other', label: 'other' },
        ],
        onSelectProject: () => {},
        onBrowseProject: () => {},
      })
      await settle()
      const trigger = view.container.querySelector<HTMLButtonElement>('[data-project-trigger="true"]')
      assert.ok(trigger, 'the scope line still carries the project chip')
      await click(trigger)
      await settle()
      const menu = dom.window.document.querySelector('[role="menu"][aria-label="Project this agent runs in"]')
      assert.ok(menu, 'the chip opens the shared project menu')
      assert.ok(buttonWithText(menu!, 'Browse…'), 'Browse… is still offered')
      assert.ok(buttonWithText(menu!, 'Import from Git'), 'and so is the Git import')
      assert.ok(buttonWithText(menu!, 'other'), 'with the open projects under them')
      view.unmount()
    })

    // One list, the project used last first (owner, 2026-10-08): by the later
    // of the last new chat main recorded and the host's own clock, however
    // often the others were used. A project never used keeps the order it came
    // in, open ones before recents, and a recent folder that was a chat's
    // worktree offers its project.
    await check('the project menu is one list, the project used last first, open ones and recents alike', async () => {
      seedStore()
      resetRememberedMachineForTests()
      meshConnections = []
      const now = Date.now()
      const day = 24 * 60 * 60 * 1000
      const used = (score: number, ago: number) => ({
        score,
        scoredAt: now - ago,
        lastUsedAt: now - ago,
        useCount: Math.ceil(score),
      })
      useWorkspaceStore.setState(
        (state) =>
          ({
            appSettings: {
              ...state.appSettings,
              recentWorkspaceFolders: ['/w/.sprintengine-worktrees/old-a/pool-01', '/old-b'],
              projectUsage: {
                '/third': used(1, 0),
                '/second': used(9, day),
                '/old-b': used(1, 30 * day),
              },
            },
          }) as never,
      )
      const view = await render({
        folderPath: '/first',
        projectOptions: [
          { path: '/first', label: 'first', lastUsedAt: now - 2 * day },
          { path: '/second', label: 'second' },
          { path: '/third', label: 'third' },
        ],
        onSelectProject: () => {},
        onBrowseProject: () => {},
      })
      await settle()
      const trigger = view.container.querySelector<HTMLButtonElement>('[data-project-trigger="true"]')
      await click(trigger!)
      await settle()
      const menu = dom.window.document.querySelector('[role="menu"][aria-label="Project this agent runs in"]')!
      const paths = ['/third', '/second', '/first', '/old-b', '/w/old-a']
      const rows = [...menu.querySelectorAll('[role="menuitemradio"]')].map((row) =>
        paths.find((path) => (row.textContent ?? '').endsWith(path)),
      )
      assert.deepEqual(rows, paths, 'by last use; the never-used recent last')
      assert.doesNotMatch(menu.textContent ?? '', /Recent|pool-01/, 'no Recent section, and no worktree folder')
      view.unmount()
      useWorkspaceStore.setState(
        (state) =>
          ({
            appSettings: { ...state.appSettings, recentWorkspaceFolders: [], projectUsage: {} },
          }) as never,
      )
    })

    // A chat's worktree is how it is isolated, not a place the person chose:
    // the chip names the project it was cut from, never the slot.
    await check('the project chip names a worktree folder by its project, not the slot', async () => {
      seedStore()
      resetRememberedMachineForTests()
      meshConnections = []
      const view = await render({
        folderPath: '/w/.sprintengine-worktrees/app/pool-01',
        projectOptions: [{ path: '/w/app', label: 'app' }],
        onSelectProject: () => {},
        onBrowseProject: () => {},
      })
      await settle()
      const trigger = view.container.querySelector<HTMLButtonElement>('[data-project-trigger="true"]')
      assert.ok(trigger, 'the scope line carries the project chip')
      assert.match(trigger!.textContent ?? '', /\bapp\b/u)
      assert.doesNotMatch(trigger!.textContent ?? '', /pool-01/u)
      view.unmount()
    })

    // ── One colour per project, on the scope line ────────────────────────────
    // Owner ruling 2026-09-09, backlog item
    // `one-colour-per-project-on-the-folder-glyph`, decision 7: "I keep opening
    // up a new chat and forgetting to pick the project." The fix is that a chosen
    // project and no project stop LOOKING alike — a solid folder in the project's
    // own hue against a dashed, colourless one reading "Choose a project".

    // The glyph is the first svg inside the control; the chevron follows it. Its
    // hue is the angle it carries, or null when it wears none.
    const glyphMark = (el: Element | null | undefined): number | null => {
      const hue = el?.querySelector('svg')?.getAttribute('data-project-hue')
      return hue === null || hue === undefined ? null : Number(hue)
    }
    const glyphIsUnfiled = (el: Element | null | undefined): boolean => {
      const glyph = el?.querySelector('svg')
      return Boolean(glyph?.querySelector('path')?.getAttribute('stroke-dasharray'))
    }
    const seedColours = (): void => {
      useWorkspaceStore.setState(
        (state) =>
          ({
            appSettings: { ...state.appSettings, projectColors: {} },
          }) as never,
      )
    }

    await check(
      'the scope line wears the project’s colour, and no project at all wears the dashed folder',
      async () => {
        seedStore()
        seedColours()
        resetRememberedMachineForTests()
        meshConnections = []
        const sprintengine = {
          canonicalKey: 'github.com/acme/sprintengine',
          remoteUrl: 'git@github.com:acme/sprintengine.git',
          name: 'sprintengine',
        }
        localIdentityAnswer = (folderPath) => (folderPath === '/proj' ? sprintengine : null)

        const view = await render({
          folderPath: '/proj',
          projectOptions: [
            { path: '/proj', label: 'proj' },
            { path: '/other', label: 'other' },
          ],
          onSelectProject: () => {},
          onBrowseProject: () => {},
        })
        await settle()
        await settle()
        const trigger = view.container.querySelector<HTMLButtonElement>('[data-project-trigger="true"]')
        const mark = glyphMark(trigger)
        assert.ok(
          mark,
          `the chosen project’s chip carries a hue; got class ${trigger?.querySelector('svg')?.getAttribute('class')}`,
        )
        assert.equal(glyphIsUnfiled(trigger), false, 'and a solid folder, because this IS a project')
        // The hue is hashed from the REPOSITORY key, not the folder: two clones of
        // one repo are one project and one hue (decision 3). Derived, so nothing
        // is written — the map holds only what a person chose.
        assert.equal(
          mark,
          projectHue('repo:github.com/acme/sprintengine'),
          'the chip wears the hue hashed from the repository key',
        )
        assert.deepEqual(useWorkspaceStore.getState().appSettings.projectColors ?? {}, {}, 'and nothing is stored')
        // The list is where a person chooses BETWEEN projects, so the rows carry
        // their own colours rather than only the chip that opened them.
        await click(trigger)
        await settle()
        const menu = dom.window.document.querySelector('[role="menu"][aria-label="Project this agent runs in"]')
        assert.ok(menu, 'the chip opens the project menu')
        const chosenRow = [...menu!.querySelectorAll('[role="menuitemradio"]')].find((row) =>
          (row.textContent ?? '').includes('/proj'),
        )
        assert.equal(glyphMark(chosenRow), mark, 'the row for the chosen project wears the same hue as the chip')
        view.unmount()

        // No project at all: the dashed, colourless folder and the words that say
        // there is a choice to make. And no hint text under it — the owner cut that.
        seedColours()
        const empty = await render({
          folderPath: null,
          projectOptions: [],
          onSelectProject: () => {},
          onBrowseProject: () => {},
        })
        await settle()
        const emptyTrigger = empty.container.querySelector<HTMLButtonElement>('[data-project-trigger="true"]')
        assert.ok(emptyTrigger?.textContent?.includes('Choose a project'), 'it says there is a project to choose')
        assert.equal(glyphMark(emptyTrigger), null, 'no folder is not a project, so it has no hue')
        assert.equal(
          glyphIsUnfiled(emptyTrigger),
          true,
          'and the outline is dashed, not a solid folder waiting on a colour',
        )
        assert.deepEqual(
          useWorkspaceStore.getState().appSettings.projectColors,
          {},
          'and nothing was written: an unfiled chat is not a project',
        )
        empty.unmount()
        localIdentityAnswer = () => null
      },
    )

    await check('the same repository on a paired machine wears the same hue as the local clone', async () => {
      seedStore()
      seedColours()
      resetRememberedMachineForTests()
      const sprintengine = {
        canonicalKey: 'github.com/acme/sprintengine',
        remoteUrl: 'git@github.com:acme/sprintengine.git',
        name: 'sprintengine',
      }
      localIdentityAnswer = (folderPath) => (folderPath === '/proj' ? sprintengine : null)
      meshConnections = [machine('m1', 'Air')]
      meshBrowseAnswer = (id) => ({
        connectionId: id,
        reachable: true,
        unreachableReason: null,
        unauthorized: false,
        scopes: ['workspace:operate'],
        workspaces: [
          {
            ...workspace('w1', 'other', '/srv/other'),
            repository: { canonicalKey: 'github.com/acme/other', remoteUrl: '', name: 'other' },
          },
          { ...workspace('w2', 'sprintengine-air', '/srv/sprintengine'), repository: sprintengine },
        ],
        gaps: [],
      })
      const view = await remoteRender()
      await settle()
      await settle()
      const localMark = glyphMark(view.container.querySelector('[data-project-trigger="true"]'))
      assert.ok(localMark, 'the local clone has a hue to match')

      await pickMachine(view, 'Air')
      await settle()
      await settle()
      // Two projects on the Air, but one of them is the repository in hand, so
      // the machine pick keeps the project.
      const remoteTrigger = view.container.querySelector<HTMLButtonElement>('[data-project-trigger="true"]')
      assert.equal(
        remoteTrigger?.textContent?.trim(),
        'sprintengine',
        `the remote copy is the picked project; got ${remoteTrigger?.textContent}`,
      )
      assert.equal(
        glyphMark(remoteTrigger),
        localMark,
        'and it wears the SAME hue: the machine is a glyph on the line, never a second colour',
      )
      assert.equal(glyphIsUnfiled(remoteTrigger), false, 'a picked remote project is a project')

      // The machine's own list is where a person picks one project out of a
      // dozen, so its rows carry the hues too — and the row for the repository
      // open here is the colour it is here.
      await click(remoteTrigger)
      await settle()
      const remoteMenu = dom.window.document.querySelector('[role="menu"][aria-label="Project on Air"]')!
      const rows = [...remoteMenu.querySelectorAll('[role="menuitemradio"]')]
      // The rows are FOLDERS: /srv/sprintengine and /srv/other, not the chats
      // standing in them.
      const twinRow = rows.find((row) => (row.textContent ?? '').includes('/srv/sprintengine'))
      const strangerRow = rows.find((row) => (row.textContent ?? '').includes('/srv/other'))
      assert.equal(glyphMark(twinRow), localMark, 'the row for the repository open here wears the hue it wears here')
      assert.equal(
        glyphMark(strangerRow),
        projectHue('repo:github.com/acme/other'),
        'a repository this app has never opened still has its hue: it is hashed from the name, not handed out on sight',
      )
      view.unmount()
      localIdentityAnswer = () => null
      meshConnections = []
    })

    await check(
      'every state of the scope line wears the hue: the plain line, a folder with no remote, and a recent clone of the open project',
      async () => {
        seedStore()
        seedColours()
        resetRememberedMachineForTests()
        meshConnections = []
        const sprintengine = {
          canonicalKey: 'github.com/acme/sprintengine',
          remoteUrl: 'git@github.com:acme/sprintengine.git',
          name: 'sprintengine',
        }
        localIdentityAnswer = (folderPath) => (folderPath === '/proj' || folderPath === '/clone' ? sprintengine : null)

        // The tab strip's "+": the project is a fact rather than a choice, so the
        // strip names it as a line and not a control — and it still wears the
        // colour, or the hue stops being how you tell one project from another.
        const fixed = await render({ folderPath: '/proj' })
        await settle()
        await settle()
        const line = fixed.container.querySelector<HTMLElement>('[data-composer-strip] [data-project-line="true"]')
        assert.ok(line, 'the plain scope line is there')
        assert.equal(
          fixed.container.querySelector('[data-project-trigger="true"]'),
          null,
          'and it is a line, not a chip — this host offers no choice it cannot honour',
        )
        const fixedMark = glyphMark(line)
        assert.ok(
          fixedMark,
          `the plain line carries the hue too; got ${line?.querySelector('svg')?.getAttribute('class')}`,
        )
        assert.equal(glyphIsUnfiled(line), false, 'and a solid folder')
        fixed.unmount()

        // A folder with no remote is still a project — keyed by its path, because
        // that is the only identity it has. It must not stay colourless.
        seedColours()
        const noRemote = await render({
          folderPath: '/plain',
          projectOptions: [{ path: '/plain', label: 'plain' }],
          onSelectProject: () => {},
        })
        await settle()
        await settle()
        const noRemoteMark = glyphMark(noRemote.container.querySelector('[data-project-trigger="true"]'))
        assert.equal(
          noRemoteMark,
          projectHue('folder:/plain'),
          'a folder with no remote wears the hue of its folder key once its identity read has ANSWERED',
        )
        noRemote.unmount()

        // A recent clone of the OPEN project is the same project, so it is the same
        // hue — a grey row beside its blue twin is exactly the confusion the colour
        // exists to end. The recents are the picker's own rows, so it asks for
        // their identities itself.
        seedColours()
        useWorkspaceStore.setState(
          (state) =>
            ({
              appSettings: { ...state.appSettings, recentWorkspaceFolders: ['/clone'] },
            }) as never,
        )
        const view = await render({
          folderPath: '/proj',
          projectOptions: [{ path: '/proj', label: 'proj' }],
          onSelectProject: () => {},
          onBrowseProject: () => {},
        })
        await settle()
        await settle()
        const trigger = view.container.querySelector<HTMLButtonElement>('[data-project-trigger="true"]')
        const mark = glyphMark(trigger)
        assert.ok(mark, 'the open clone has a hue')
        await click(trigger)
        await settle()
        await settle()
        const menu = dom.window.document.querySelector('[role="menu"][aria-label="Project this agent runs in"]')!
        const recentRow = [...menu.querySelectorAll('[role="menuitemradio"]')].find((row) =>
          (row.textContent ?? '').includes('/clone'),
        )
        assert.ok(recentRow, 'the recent folder is offered')
        assert.equal(
          glyphMark(recentRow),
          mark,
          'and it wears the same hue as the open clone: one repository is one project',
        )
        assert.equal(
          mark,
          projectHue('repo:github.com/acme/sprintengine'),
          'because both clones read ONE key: the repository’s',
        )
        view.unmount()
        useWorkspaceStore.setState(
          (state) =>
            ({
              appSettings: { ...state.appSettings, recentWorkspaceFolders: [] },
            }) as never,
        )
        localIdentityAnswer = () => null
      },
    )

    await check('a remote project the machine could not identify takes no hue and no key', async () => {
      seedStore()
      seedColours()
      resetRememberedMachineForTests()
      // No identity on this disk either, so the machine list has no project to
      // filter by and the Air is pickable; the point of the check is what happens
      // to the REMOTE key, not to the local one.
      localIdentityAnswer = () => null
      meshConnections = [machine('m1', 'Air')]
      // One workspace, so it is picked without a click — and its machine reported
      // no repository, which is what an older peer and a non-repo folder both do.
      meshBrowseAnswer = (id) => ({
        connectionId: id,
        reachable: true,
        unreachableReason: null,
        unauthorized: false,
        scopes: ['workspace:operate'],
        workspaces: [{ ...workspace('w1', 'mystery', '/srv/mystery'), repository: null }],
        gaps: [],
      })
      const view = await remoteRender()
      await settle()
      await settle()
      const before = { ...useWorkspaceStore.getState().appSettings.projectColors }
      await pickMachine(view, 'Air')
      await settle()
      await settle()
      const trigger = view.container.querySelector<HTMLButtonElement>('[data-project-trigger="true"]')
      assert.ok(trigger?.textContent?.includes('mystery'), `the lone project is picked; got ${trigger?.textContent}`)
      assert.equal(
        glyphMark(trigger),
        null,
        'with no hue: its path is a path on ANOTHER disk, never a key this one can match',
      )
      assert.equal(
        glyphIsUnfiled(trigger),
        false,
        'and a solid glyph, not the dashed one — there IS a folder, we just cannot say which repository it is',
      )
      assert.deepEqual(
        useWorkspaceStore.getState().appSettings.projectColors,
        before,
        'and no hue was burned on a key nothing will ever resolve to again',
      )
      view.unmount()
      localIdentityAnswer = () => null
      meshConnections = []
    })

    await check('the local access menu walks with the arrows and selects on Enter', async () => {
      seedStore()
      resetRememberedMachineForTests()
      meshConnections = []
      const view = await render({ permissionPreset: 'none' })
      const menu = await openPermissionsMenu(view, 'No flag')
      const rows = [...menu.querySelectorAll<HTMLButtonElement>('[data-preset-option="true"]')]
      assert.equal(rows.length, 4, 'four presets: Manual, Auto, Bypass and No flag')
      assert.ok(rows[0]?.textContent?.startsWith('Manual'), 'the strictest leads')
      assert.ok(rows[1]?.textContent?.startsWith('Auto'), 'Auto follows')
      assert.ok(rows[2]?.textContent?.startsWith('Bypass permissions'), 'then Bypass')
      assert.ok(rows[3]?.textContent?.startsWith('No flag'), 'and the no-flag row closes the list')
      assert.equal(dom.window.document.activeElement, rows[3], 'focus opens on the checked row')
      const key = (el: Element, k: string) =>
        act(async () => {
          el.dispatchEvent(new dom.window.KeyboardEvent('keydown', { key: k, bubbles: true, cancelable: true }))
        })
      await key(rows[3]!, 'ArrowDown')
      assert.equal(dom.window.document.activeElement, rows[0], 'ArrowDown wraps to the start')
      await key(rows[0]!, 'ArrowUp')
      assert.equal(dom.window.document.activeElement, rows[3], 'ArrowUp wraps to the end')
      await key(rows[3]!, 'Home')
      await key(rows[0]!, 'Enter')
      assert.equal(
        storedCliPermissionPreset('claude-code'),
        'manual',
        'Enter selects the focused row, and the pick is remembered for the CLI it was made on',
      )
      view.unmount()
    })

    // One permission mode per CLI, not per model (owner ruling 2026-09-24):
    // choosing Bypass while one Claude model is highlighted is choosing it for
    // every Claude model, it outlives the app, and Codex keeps its own.
    await check(
      'a permission pick on one model applies to every model of that CLI, is read back by a fresh panel, and leaves Codex alone',
      async () => {
        const claude = {
          id: 'claude-code',
          displayName: 'Claude Code',
          source: 'bundled',
          version: 1,
          binary: 'claude',
          resumeSession: true,
          sessionIdFromCaller: true,
          modelSelection: {
            options: [
              { id: 'claude-opus-5', label: 'Opus 5' },
              { id: 'claude-sonnet-5', label: 'Sonnet 5' },
            ],
            allowCustomId: true,
          },
          reasoningSelection: { levels: [{ id: 'low' }, { id: 'medium' }, { id: 'high' }] },
        }
        const codex = {
          id: 'codex',
          displayName: 'Codex',
          source: 'bundled',
          version: 1,
          binary: 'codex',
          resumeSession: true,
          sessionIdFromCaller: true,
          modelSelection: {
            options: [
              { id: 'gpt-5.6-sol', label: 'GPT-5.6 Sol' },
              { id: 'gpt-6-astra', label: 'GPT-6-Astra' },
            ],
            allowCustomId: true,
          },
          reasoningSelection: { levels: [{ id: 'low' }, { id: 'medium' }, { id: 'high' }], default: 'medium' },
        }
        seedStore({ plugins: [claude, codex] })
        const modelRow = (label: string) =>
          [...dom.window.document.querySelectorAll('[data-model-row="true"]')].find((row) =>
            (row.textContent ?? '').includes(label),
          )
        const hover = async (label: string) => {
          const row = modelRow(label)
          assert.ok(row, `the ${label} row is in the picker`)
          await act(async () => {
            row!.dispatchEvent(new dom.window.MouseEvent('pointerover', { bubbles: true }))
          })
        }
        const chip = (label: string) => dom.window.document.querySelector(`[aria-label="Permissions: ${label}"]`)
        const tab = (name: string) =>
          [...dom.window.document.querySelectorAll('button')].find(
            (button) => button.getAttribute('role') === 'radio' && button.getAttribute('aria-label') === name,
          )

        const view = await render({ permissionPreset: 'none' })
        await click(engineChip(view))
        await hover('Opus 5')
        await click(chip('No flag') as HTMLElement)
        const bypass = [...dom.window.document.querySelectorAll<HTMLButtonElement>('[data-preset-option="true"]')].find(
          (row) => row.textContent?.startsWith('Bypass'),
        )
        await click(bypass)
        assert.equal(storedCliPermissionPreset('claude-code'), 'bypass', 'the pick is stored for Claude Code')

        await hover('Sonnet 5')
        assert.ok(chip('Bypass permissions'), 'Sonnet shows the Bypass that was chosen on Opus')
        await click(tab('Codex'))
        await hover('GPT-5.6 Sol')
        assert.ok(chip('No flag'), 'Codex keeps its own value, the app-wide default it never moved from')
        assert.equal(chip('YOLO'), null, 'and does not inherit Claude’s bypass')
        assert.equal(storedCliPermissionPreset('codex'), undefined)
        view.unmount()

        // A fresh panel reads the choice back from the launch-settings read
        // model, which is what main's record fills on every window's boot.
        const again = await render({ permissionPreset: 'none' })
        await click(engineChip(again))
        await click(tab('Claude Code'))
        await hover('Sonnet 5')
        assert.ok(chip('Bypass permissions'), 'the Claude Code choice survives the reload')
        const sonnet = modelRow('Sonnet 5')
        await act(async () => {
          sonnet!.dispatchEvent(new dom.window.MouseEvent('click', { bubbles: true }))
        })
        const start = [...again.container.querySelectorAll('button')].find(
          (button) => button.getAttribute('aria-label') === 'Start agent',
        )
        await click(start)
        assert.equal(again.launches[0]?.cli, 'claude-code')
        assert.equal(again.launches[0]?.model, 'claude-sonnet-5')
        assert.equal(
          resolveCliPermissionPreset('claude-code', 'none'),
          'bypass',
          'and the launch host resolves Bypass for a model it was never chosen on',
        )
        again.unmount()
      },
    )

    // ── The parked draft (new-chat-survives-back-and-forward) ─────────────────
    // The door's surface seeds from the draft parked under its key and writes
    // every change back, so an unmount from any direction loses nothing; the
    // host, not the surface, decides when the draft is forgotten.
    await check(
      'with a draft key the surface resumes the parked prompt and images, and writes changes through',
      async () => {
        const { readNewChatDraft, writeNewChatDraft, resetNewChatDraftsForTests } = await import('./newChatDraft')
        resetNewChatDraftsForTests()
        const shot = { id: 'img-1', mediaType: 'image/png', dataBase64: 'AAAA', byteLength: 4, path: '/tmp/shot.png' }
        writeNewChatDraft('win-1', { prompt: 'review the auth flow', images: [shot], folderPath: '/w/app' })
        const view = await render({ draftKey: 'win-1' })
        const textarea = composerField(view.container)
        assert.equal(composerText(textarea), 'review the auth flow', 'the parked words are back in the box')
        assert.ok(view.container.querySelector('img[src^="data:image/png"]'), 'and so is the pasted screenshot')
        await act(async () => {
          typeIntoComposer(textarea, 'review the auth flow, then the session store')
        })
        assert.equal(
          readNewChatDraft('win-1')?.prompt,
          'review the auth flow, then the session store',
          'typing is parked as it happens',
        )
        assert.equal(
          readNewChatDraft('win-1')?.folderPath,
          '/w/app',
          'the surface never touches the scope the host owns',
        )
        view.unmount()
        assert.equal(
          readNewChatDraft('win-1')?.prompt,
          'review the auth flow, then the session store',
          "unmounting forgets nothing — forgetting is the host's call",
        )
        resetNewChatDraftsForTests()
      },
    )

    // A draft can also carry the ENGINE its pick was made on, for the one caller
    // that picks a row and deliberately stores nothing: a card's `Go` picker
    // (item 2473, ruling R4b). Choosing how to run one card must not move the
    // engine of the next New chat, so the row travels in the draft instead — and
    // the door has to open standing on it and launch it, or the pick is lost
    // between the press and the composer.
    await check('a draft carrying an engine opens the door on that row and launches it, storing nothing', async () => {
      seedStore()
      const { writeNewChatDraft, resetNewChatDraftsForTests } = await import('./newChatDraft')
      const { useWorkspaceStore } = await import('../../../store/workspaceStore')
      resetNewChatDraftsForTests()
      writeNewChatDraft('win-1', {
        prompt: 'set up the design system',
        folderPath: '/w/app',
        selection: { kind: 'general' },
        engine: { cli: 'claude-code', model: 'a-parked-model', reasoning: 'high' },
      })
      const view = await render({ draftKey: 'win-1' })
      const engine = [...view.container.querySelectorAll('button')].find((button) =>
        (button.getAttribute('aria-label') ?? '').startsWith('Engine: '),
      )
      assert.ok(
        (engine?.getAttribute('aria-label') ?? '').includes('a-parked-model'),
        'the door opens standing on the row the draft carried',
      )
      const start = [...view.container.querySelectorAll('button')].find(
        (button) => button.getAttribute('aria-label') === 'Start agent',
      )
      await act(async () => {
        start!.dispatchEvent(new dom.window.MouseEvent('click', { bubbles: true }))
      })
      assert.equal(view.launches[0]?.model, 'a-parked-model', 'and launches on it')
      assert.equal(view.launches[0]?.reasoning, 'high', 'at the effort that was chosen with it')
      assert.equal(
        useWorkspaceStore.getState().appSettings.lastSelectedAgentModel,
        null,
        'and standing on a parked row writes no remembered engine of its own',
      )
      view.unmount()
      resetNewChatDraftsForTests()
    })

    await check('without a draft key the surface keeps its per-tab state and parks nothing', async () => {
      const { readNewChatDraft, resetNewChatDraftsForTests } = await import('./newChatDraft')
      resetNewChatDraftsForTests()
      const view = await render()
      const textarea = composerField(view.container)
      assert.equal(composerText(textarea), '')
      await act(async () => {
        typeIntoComposer(textarea, 'tab-local words')
      })
      assert.equal(readNewChatDraft('win-1'), null, 'the tab-strip host has no draft')
      view.unmount()
    })

    // ── Pasting an image's path ───────────────────────────────────────────────
    // A screenshot tool puts the file's path on the clipboard, and that file is
    // a temporary copy cleared minutes later: the paste reads the bytes then,
    // and only an unreadable one is left as the text it was.
    await check('an outside image path attaches; a project one or an unreadable one stays text', async () => {
      const api = (dom.window as unknown as { api: Record<string, unknown> }).api
      const readPaths: string[] = []
      api.readImageDataUrl = async (path: string) => {
        readPaths.push(path)
        if (path.includes('gone')) throw new Error('ENOENT: no such file or directory')
        return 'data:image/png;base64,iVBORw0K'
      }
      const view = await render()
      const textarea = composerField(view.container)
      const paste = async (text: string) => {
        const event = new dom.window.Event('paste', { bubbles: true, cancelable: true })
        Object.defineProperty(event, 'clipboardData', {
          value: { items: [], files: [], types: ['text/plain'], getData: () => text },
        })
        await act(async () => {
          textarea.dispatchEvent(event)
        })
        await act(async () => new Promise((resolve) => setTimeout(resolve, 10)))
        return event
      }
      const attached = await paste("'/var/folders/x1/T/TemporaryItems/Screenshot 2026-09-27 at 22.41.31.png'")
      assert.equal(attached.defaultPrevented, true)
      assert.deepEqual(readPaths, ['/var/folders/x1/T/TemporaryItems/Screenshot 2026-09-27 at 22.41.31.png'])
      assert.ok(view.container.querySelector('img[src^="data:image/png"]'), 'the image is on the box, not its path')
      assert.equal(composerText(textarea), '')

      await paste('/Users/dev/gone.png')
      assert.equal(composerText(textarea), '/Users/dev/gone.png', 'an unreadable path is typed after all')
      assert.match(view.container.textContent ?? '', /Could not attach gone\.png: the file no longer exists\./)

      // An image of the project itself is a file the agent can open: the path
      // is what the prompt is about, so it is typed like any other text.
      readPaths.length = 0
      await paste('/proj/public/logo.png')
      assert.equal(composerText(textarea), '/Users/dev/gone.png/proj/public/logo.png', 'a project path is typed')
      assert.deepEqual(readPaths, [])
      delete api.readImageDataUrl
      view.unmount()
    })

    // ── Scheduled agents ────────────────────────────────────────────────────
    // The door's switch makes the launch a scheduled agent: the same launch,
    // saved with the schedule in the tray, rather than started.

    const scheduleDoor = async (extra: Record<string, unknown> = {}) => {
      const api = (dom.window as unknown as { api: Record<string, unknown> }).api
      const drafts: Array<Record<string, unknown>> = []
      api.createScheduledAgent = async (draft: Record<string, unknown>) => {
        drafts.push(draft)
        return { ok: true, agent: { ...draft, id: 'sa-1', nextRunAt: null } }
      }
      const scheduled: unknown[] = []
      const view = await render({
        initialSelection: { kind: 'conversation' },
        folderPath: '/proj',
        projectOptions: [],
        onSelectProject: () => {},
        onBrowseProject: () => {},
        onScheduled: (agent: unknown) => scheduled.push(agent),
        ...extra,
      })
      const type = async (text: string) => {
        const field = composerField(view.container)
        await act(async () => {
          typeIntoComposer(field, text)
        })
        return field
      }
      const enter = async (field: HTMLElement) => {
        await act(async () => {
          field.dispatchEvent(
            new dom.window.KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true }),
          )
        })
        await act(async () => new Promise((resolve) => setTimeout(resolve, 0)))
      }
      return { view, drafts, scheduled, type, enter }
    }

    // The Schedule row of the "+" menu, and whether it can be picked.
    const scheduleRow = async (view: Harness): Promise<HTMLElement | null> => {
      const menu = await openOptions(view)
      return menu?.querySelector<HTMLElement>('[data-composer-schedule="true"]') ?? null
    }
    const sendButton = (view: Harness): HTMLElement | undefined =>
      [...view.container.querySelectorAll<HTMLElement>('[data-new-chat-composer] button')].pop()

    await check('Schedule saves the launch on screen, to send once at the tag’s time, and starts nothing', async () => {
      seedStore()
      const door = await scheduleDoor()
      assert.equal(door.view.container.querySelector('[role="radiogroup"]'), null, 'no Chat | Scheduled switch')
      const toggle = await scheduleRow(door.view)
      assert.ok(toggle, 'the "+" offers Schedule')
      assert.equal(toggle?.getAttribute('aria-checked'), 'false')
      assert.equal(toggle?.textContent?.trim(), 'Schedule', 'the row is its word, with no line under it')
      await act(async () => {
        toggle!.dispatchEvent(new dom.window.MouseEvent('click', { bubbles: true }))
      })
      assert.ok(
        door.view.container.querySelector('[data-schedule-tag="true"]')?.textContent?.startsWith('Once, '),
        'a new one is the prompt sent once, later, said on a tag beside the "+"',
      )
      assert.equal(sendButton(door.view)?.textContent?.trim(), 'Schedule', 'and the send says Schedule')
      const field = await door.type('Triage the new issues.')
      await door.enter(field)
      assert.equal(door.view.launches.length, 0, 'nothing is started')
      assert.equal(door.drafts.length, 1, 'one scheduled agent is made')
      const draft = door.drafts[0]!
      assert.equal(draft.prompt, 'Triage the new issues.')
      const once = (draft.schedule as { once?: number }).once
      assert.ok(typeof once === 'number' && once > Date.now(), 'once, at a time ahead')
      assert.equal(new Date(once).getMinutes(), 0, 'on the hour')
      assert.equal(draft.folderPath, '/proj')
      assert.equal(draft.hostId, null)
      assert.equal(draft.cli, 'claude-code')
      assert.equal(draft.worktree, null)
      assert.equal(door.scheduled.length, 1, 'and the host hears of it')
      door.view.unmount()
    })

    await check('Schedule is greyed for a terminal agent, and a terminal hides the model', async () => {
      seedStore()
      const door = await scheduleDoor({ initialSelection: { kind: 'general' } })
      const row = await scheduleRow(door.view)
      assert.ok(row, 'Schedule is listed for a terminal agent')
      assert.equal(row?.hasAttribute('disabled'), true, 'but cannot be picked')
      assert.ok(
        (row?.textContent ?? '').includes('Only a conversation can run on a schedule'),
        'and says why, as its hint',
      )
      await act(async () => {
        dom.window.document.dispatchEvent(
          new dom.window.KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true }),
        )
      })
      assert.ok(
        [...door.view.container.querySelectorAll('button')].some((button) =>
          (button.getAttribute('aria-label') ?? '').startsWith('Engine: '),
        ),
        'a terminal agent has a model',
      )
      await pickKind(door.view, 'terminal')
      assert.ok(
        ![...door.view.container.querySelectorAll('button')].some((button) =>
          (button.getAttribute('aria-label') ?? '').startsWith('Engine: '),
        ),
        'a plain terminal hides the model picker',
      )
      assert.equal(sendButton(door.view)?.getAttribute('aria-label'), 'Open terminal', 'and its send opens a terminal')
      // Picking Terminal while scheduled stops scheduling, rather than lying
      // about what each run would start.
      await pickKind(door.view, 'conversation')
      const again = await scheduleRow(door.view)
      await act(async () => {
        again!.dispatchEvent(new dom.window.MouseEvent('click', { bubbles: true }))
      })
      assert.ok(door.view.container.querySelector('[data-schedule-tag="true"]'), 'scheduled')
      await pickKind(door.view, 'terminal')
      assert.equal(door.view.container.querySelector('[data-schedule-tag="true"]'), null, 'a terminal unschedules')
      door.view.unmount()
    })

    await check('/schedule at the cursor picks the schedule and switches the door to it', async () => {
      seedStore()
      const door = await scheduleDoor()
      const field = await door.type('Sweep for dead code. /schedule sundays 9pm')
      const picker = dom.window.document.querySelector('[aria-label="Schedule this agent"]')
      assert.ok(picker?.textContent?.includes('Every Sunday at 9:00 PM'), 'the words are read as they are typed')
      await door.enter(field)
      assert.equal(composerText(field), 'Sweep for dead code.', 'the /schedule words leave the prompt')
      assert.equal(door.drafts.length, 0, 'picking a schedule schedules nothing yet')
      const toggle = await scheduleRow(door.view)
      assert.equal(toggle?.getAttribute('aria-checked'), 'true', 'the door is on Schedule')
      assert.ok(door.view.text().includes('Every Sunday at 9:00 PM'), 'on that schedule')
      door.view.unmount()
    })

    await check('a scheduled agent opened from its card saves rather than creates', async () => {
      seedStore()
      const api = (dom.window as unknown as { api: Record<string, unknown> }).api
      const updates: Array<{ id: string; draft: Record<string, unknown> }> = []
      api.updateScheduledAgent = async (id: string, draft: Record<string, unknown>) => {
        updates.push({ id, draft })
        return { ok: true, agent: { ...draft, id, nextRunAt: null } }
      }
      api.markScheduledAgentFailureSeen = async () => ({ ok: true })
      const door = await scheduleDoor({
        editingScheduledAgent: {
          id: 'sa-9',
          prompt: 'Refresh the forecast.',
          schedule: { cron: '0 21 * * 0', timezone: 'UTC' },
          folderPath: '/proj',
          hostId: null,
          cli: 'claude-code',
          cliModel: null,
          permissionPreset: null,
          skills: [],
          mcpServers: [],
          worktree: { name: '' },
          ownerModuleId: null,
          createdAt: 0,
          updatedAt: 0,
          lastRun: { at: 5, ok: false, message: 'gh: authentication required' },
          lastFailureSeenAt: null,
          nextRunAt: null,
        },
      })
      const text = door.view.text()
      assert.ok(!text.includes('Chat'), 'no switch: a scheduled agent stays one')
      assert.ok(text.includes('Every Sunday at 9:00 PM'), 'it opens on its schedule')
      assert.ok(text.includes('gh: authentication required'), 'and on why its last run did not start')
      assert.equal(
        door.view.container.querySelector('[data-worktree-chip]')?.getAttribute('data-worktree-chip'),
        'on',
        'with its worktree on',
      )
      const field = composerField(door.view.container)
      assert.equal(composerText(field), 'Refresh the forecast.')
      await door.enter(field)
      assert.equal(updates.length, 1)
      assert.equal(updates[0]?.id, 'sa-9')
      assert.deepEqual(updates[0]?.draft.worktree, { name: '' })
      door.view.unmount()
    })

    await check(
      'a scheduled agent’s editor lists its runs, each opening its chat, and Run now points there',
      async () => {
        seedStore()
        const api = (dom.window as unknown as { api: Record<string, unknown> }).api
        api.markScheduledAgentFailureSeen = async () => ({ ok: true })
        api.runScheduledAgentNow = async () => ({ ok: true, run: { at: 5, ok: true, workspaceId: 'w-run-3' } })
        const opened: string[] = []
        const now = Date.now()
        const door = await scheduleDoor({
          editingScheduledAgent: {
            id: 'sa-9',
            prompt: 'Refresh the forecast.',
            schedule: { cron: '0 21 * * 0', timezone: 'UTC' },
            folderPath: '/proj',
            hostId: null,
            cli: 'claude-code',
            cliModel: null,
            permissionPreset: null,
            skills: [],
            mcpServers: [],
            worktree: null,
            ownerModuleId: null,
            createdAt: 0,
            updatedAt: 0,
            lastRun: { at: 5, ok: true, workspaceId: 'w-run-2' },
            lastFailureSeenAt: null,
            nextRunAt: null,
          },
          scheduledRuns: [
            { workspaceId: 'w-run-2', title: 'Forecast for Sunday', startedAt: now - 5 * 60_000, activity: 'working' },
            {
              workspaceId: 'w-run-1',
              title: 'Forecast for last week',
              startedAt: now - 3 * 3_600_000,
              activity: 'idle',
            },
          ],
          onOpenScheduledRun: (workspaceId: string) => opened.push(workspaceId),
        })
        const rows = [...door.view.container.querySelectorAll<HTMLElement>('[data-scheduled-run-row]')]
        assert.deepEqual(
          rows.map((row) => row.dataset.scheduledRunRow),
          ['w-run-2', 'w-run-1'],
          'its runs, newest first',
        )
        assert.ok(door.view.text().includes('Recent runs'))
        assert.ok(rows[0]!.querySelector('[aria-label="Working"]'), 'the working run is marked as working')
        assert.equal(rows[1]!.querySelector('[aria-label="Working"]'), null)
        assert.match(rows[1]!.textContent ?? '', /3h ago/u)
        await act(async () => {
          rows[1]!.dispatchEvent(new dom.window.MouseEvent('click', { bubbles: true }))
        })
        assert.deepEqual(opened, ['w-run-1'], 'a run opens its chat')

        useToastStore.setState({ toasts: [] })
        const runNow = door.view.find((el) => el.tagName === 'BUTTON' && el.textContent === 'Run now')
        assert.ok(runNow)
        await act(async () => {
          runNow!.dispatchEvent(new dom.window.MouseEvent('click', { bubbles: true }))
        })
        await act(async () => new Promise((resolve) => setTimeout(resolve, 0)))
        const started = useToastStore.getState().toasts.find((toast) => toast.title === 'Started')
        assert.match(String(started?.description ?? ''), /Recent runs/u, 'the toast points at the run')
        door.view.unmount()
      },
    )

    await check('Run now says so when the last run is still working', async () => {
      seedStore()
      const api = (dom.window as unknown as { api: Record<string, unknown> }).api
      api.markScheduledAgentFailureSeen = async () => ({ ok: true })
      api.runScheduledAgentNow = async () => ({ ok: false, message: 'Its last run is still working.' })
      const door = await scheduleDoor({
        editingScheduledAgent: {
          id: 'sa-9',
          prompt: 'Refresh the forecast.',
          schedule: { cron: '0 21 * * 0', timezone: 'UTC' },
          folderPath: '/proj',
          hostId: null,
          cli: 'claude-code',
          cliModel: null,
          permissionPreset: null,
          skills: [],
          mcpServers: [],
          worktree: null,
          ownerModuleId: null,
          createdAt: 0,
          updatedAt: 0,
          lastRun: null,
          lastFailureSeenAt: null,
          nextRunAt: null,
        },
        onOpenScheduledRun: () => {},
      })
      assert.equal(door.view.container.querySelector('[data-scheduled-run-row]'), null, 'no runs, no list')
      useToastStore.setState({ toasts: [] })
      const runNow = door.view.find((el) => el.tagName === 'BUTTON' && el.textContent === 'Run now')
      await act(async () => {
        runNow!.dispatchEvent(new dom.window.MouseEvent('click', { bubbles: true }))
      })
      await act(async () => new Promise((resolve) => setTimeout(resolve, 0)))
      const refused = useToastStore.getState().toasts.find((toast) => toast.title === 'Did not run')
      assert.equal(refused?.description, 'Its last run is still working.')
      door.view.unmount()
    })

    // ── Extension mode ──────────────────────────────────────────────────────
    // "Build your own extension" is this door with the builder skill attached,
    // a required name chip where the worktree chip sits, and ideas that fill
    // the box rather than start anything.

    const EXTENSIONS_HOME = '/Users/dev/Documents/SprintEngine/Extensions'
    const extensionDoor = async (targets: Record<string, string> = {}, picks: Array<string | null> = []) => {
      const api = (dom.window as unknown as { api: Record<string, unknown> }).api
      const asked: Array<Record<string, unknown>> = []
      const opened: unknown[] = []
      api.extensionScaffoldHome = async () => EXTENSIONS_HOME
      api.openDir = async (options?: unknown) => {
        opened.push(options)
        return picks.shift() ?? null
      }
      api.extensionScaffoldTarget = async (input: { folder?: string; id: string }) => {
        asked.push(input)
        return { state: targets[input.id] ?? 'free', folder: input.folder ?? `${EXTENSIONS_HOME}/${input.id}` }
      }
      const view = await render({
        initialSelection: { kind: 'conversation' },
        initialMode: 'extension',
        folderPath: '/proj',
        projectOptions: [],
        onSelectProject: () => {},
        onBrowseProject: () => {},
      })
      const setValue = async (field: HTMLInputElement | HTMLElement, text: string) => {
        await act(async () => {
          if (!(field instanceof dom.window.HTMLInputElement)) return typeIntoComposer(field, text)
          Object.getOwnPropertyDescriptor(dom.window.HTMLInputElement.prototype, 'value')!.set!.call(field, text)
          field.dispatchEvent(new dom.window.Event('input', { bubbles: true }))
        })
      }
      const nameField = () => view.container.querySelector('[aria-label="Extension name"]') as HTMLInputElement | null
      const settle = async () => {
        await act(async () => new Promise((resolve) => dom.window.setTimeout(resolve, 200)))
      }
      const enter = async () => {
        const field = composerField(view.container)
        await act(async () => {
          field.dispatchEvent(
            new dom.window.KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true }),
          )
        })
        await act(async () => new Promise((resolve) => setTimeout(resolve, 0)))
      }
      const folderChip = () => view.container.querySelector('[data-extension-folder]')
      return { view, asked, opened, setValue, nameField, folderChip, settle, enter }
    }

    await check('extension mode: the builder skill, a name chip, and ideas that fill the box', async () => {
      seedStore()
      const door = await extensionDoor()
      const text = door.view.text()
      assert.ok(text.includes('What should your extension do?'))
      assert.ok(text.includes('extension-builder'), 'the builder skill is attached')
      assert.ok(!text.includes('Scheduled agent'), 'no Chat / Scheduled switch')
      assert.equal(
        door.view.container.querySelector('[data-extension-name-chip]')?.getAttribute('data-extension-name-chip'),
        'empty',
      )
      assert.equal(door.view.container.querySelector('[data-worktree-chip]'), null, 'no worktree chip')
      // Where it goes is the extensions home, not the project the door was on.
      assert.equal(door.folderChip()?.getAttribute('data-extension-folder'), 'home')
      assert.equal(door.view.container.querySelector('[data-project-trigger]'), null, 'no project picker')
      assert.ok(text.includes('Show all 10'))

      const idea = door.view.find((el) => el.tagName === 'BUTTON' && (el.textContent ?? '').includes('PR review badge'))
      assert.ok(idea, 'the first idea is offered')
      await act(async () => {
        idea!.dispatchEvent(new dom.window.MouseEvent('click', { bubbles: true }))
      })
      const field = composerField(door.view.container)
      assert.match(composerText(field), /^A top-bar badge counting the pull requests/, 'the idea is now the prompt')
      assert.equal(door.view.launches.length, 0, 'an idea starts nothing')

      await door.enter()
      assert.equal(door.view.launches.length, 0, 'nor does ⏎ without a name')

      await door.setValue(door.nameField()!, 'PR Radar')
      assert.equal(door.nameField()!.value, 'pr-radar', 'the name is kept to the id rule as it is typed')
      await door.settle()
      assert.deepEqual(door.asked.at(-1), { id: 'pr-radar' })
      assert.ok(
        door.folderChip()?.querySelector('button')?.getAttribute('aria-label')?.includes(`${EXTENSIONS_HOME}/pr-radar`),
        'the strip names the new folder',
      )
      await door.enter()
      assert.equal(door.view.launches.length, 1)
      const launch = door.view.launches[0]!
      assert.deepEqual(launch.extension, { id: 'pr-radar' })
      assert.equal(launch.kind, 'conversation')
      assert.match(String(launch.prompt), /^A top-bar badge counting the pull requests/)
      assert.deepEqual(
        (launch.skills as Array<{ id: string }>).map((skill) => skill.id),
        ['sprintengine-extension-builder'],
      )
      door.view.unmount()
    })

    await check('extension mode: a name taken by something else is said, and holds ⏎', async () => {
      seedStore()
      const door = await extensionDoor({ notes: 'taken', 'focus-timer': 'extension', 'weather-deck': 'installed' })
      await door.setValue(composerField(door.view.container), 'A notes panel.')
      await door.setValue(door.nameField()!, 'notes')
      await door.settle()
      assert.ok(door.view.text().includes('already has a notes folder'))
      assert.equal(
        door.view.container.querySelector('[data-extension-name-chip]')?.getAttribute('data-extension-name-chip'),
        'invalid',
      )
      await door.enter()
      assert.equal(door.view.launches.length, 0)

      // A name an installed extension holds: its dev install would replace it.
      await door.setValue(door.nameField()!, 'weather-deck')
      await door.settle()
      assert.ok(door.view.text().includes('weather-deck is already installed'))
      await door.enter()
      assert.equal(door.view.launches.length, 0)

      // An extension already there is carried on: no error, and ⏎ starts.
      await door.setValue(door.nameField()!, 'focus-timer')
      await door.settle()
      assert.ok(!door.view.text().includes('already has'))
      assert.ok(door.view.text().includes('focus-timer is already an extension'), 'carrying on is said')
      await door.enter()
      assert.deepEqual(door.view.launches[0]?.extension, { id: 'focus-timer' })
      door.view.unmount()
    })

    await check('extension mode: a folder picked is the extension’s own, and names it', async () => {
      seedStore()
      const door = await extensionDoor({}, ['/Users/dev/code/Weekly Summary'])
      await door.setValue(composerField(door.view.container), 'A weekly summary of my work.')
      await door.setValue(door.nameField()!, 'something-else')
      await act(async () => {
        door
          .folderChip()!
          .querySelector('button')!
          .dispatchEvent(new dom.window.MouseEvent('click', { bubbles: true }))
      })
      await door.settle()
      assert.deepEqual(door.opened, [{ defaultPath: EXTENSIONS_HOME }], 'the dialog opens on the extensions home')
      assert.equal(door.folderChip()?.getAttribute('data-extension-folder'), 'picked')
      assert.equal(door.nameField()!.value, 'weekly-summary', 'the name is the folder’s')
      assert.equal(door.nameField()!.readOnly, true, 'and is not typed over')
      assert.deepEqual(door.asked.at(-1), { id: 'weekly-summary', folder: '/Users/dev/code/Weekly Summary' })
      await door.enter()
      assert.deepEqual(door.view.launches[0]?.extension, {
        id: 'weekly-summary',
        folder: '/Users/dev/code/Weekly Summary',
      })
      // The × goes back to a new folder, under the name that was typed.
      const reset = door.view.container.querySelector('[aria-label="Make it in a new folder instead"]')
      await act(async () => {
        reset!.dispatchEvent(new dom.window.MouseEvent('click', { bubbles: true }))
      })
      assert.equal(door.folderChip()?.getAttribute('data-extension-folder'), 'home')
      assert.equal(door.nameField()!.value, 'something-else')
      assert.equal(door.nameField()!.readOnly, false)
      door.view.unmount()
    })

    await check('removing the builder chip leaves extension mode for a plain New chat', async () => {
      seedStore()
      const door = await extensionDoor()
      const remove = door.view.container.querySelector('[aria-label="Remove skill extension-builder"]')
      assert.ok(remove, 'the builder chip can be removed')
      await act(async () => {
        remove!.dispatchEvent(new dom.window.MouseEvent('click', { bubbles: true }))
      })
      const text = door.view.text()
      assert.ok(!text.includes('What should your extension do?'))
      assert.equal(door.view.container.querySelector('[data-extension-name-chip]'), null)
      door.view.unmount()
    })

    // `/` opens the skill picker wherever a token starts — the draft's start, a
    // later line, after a space — and never inside a word, a path or a URL. A
    // chat takes the pick as a chip, the "+" menu's, and loses only the token.
    const settlePicker = () => act(async () => new Promise((resolve) => setTimeout(resolve, 20)))
    const skillRow = (id: string) =>
      dom.window.document.querySelector<HTMLElement>(`[data-skill-row="${id}"]`) ?? undefined
    await check('a chat: / after text opens the skill picker, and a pick becomes a chip', async () => {
      seedStore()
      // A chat's picker lists the workspace-wide inventory, as its "+" does.
      const api = (dom.window as unknown as { api: Record<string, unknown> }).api
      const listed = api.workspaceSkillsList
      api.workspaceSkillsList = async () => ({
        ok: true,
        skills: [{ id: 'backlog', name: 'backlog', source: 'builtin', harnesses: [], installState: 'installed' }],
      })
      try {
        const view = await render({ initialSelection: { kind: 'conversation' } })
        const field = composerField(view.container)
        for (const draft of ['/', 'A paragraph of context.\n/', 'some text /', 'some text /back']) {
          await act(async () => typeIntoComposer(field, draft))
          await settlePicker()
          assert.ok(skillRow('backlog'), `the picker opens for ${JSON.stringify(draft)}`)
        }
        for (const draft of ['and/or', 'see src/foo', 'see https://example.com/', 'a/b']) {
          await act(async () => typeIntoComposer(field, draft))
          await settlePicker()
          assert.equal(skillRow('backlog'), undefined, `no picker for ${JSON.stringify(draft)}`)
        }

        await act(async () => typeIntoComposer(field, 'some text /'))
        await settlePicker()
        await act(async () => {
          field.dispatchEvent(
            new dom.window.KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true }),
          )
        })
        await settlePicker()
        assert.equal(skillRow('backlog'), undefined, 'Esc closes it')
        assert.equal(view.closed(), 0, 'and leaves the panel open')

        await act(async () => typeIntoComposer(field, 'Fix the flaky test.\n/back'))
        await settlePicker()
        await act(async () => {
          skillRow('backlog')!.dispatchEvent(new dom.window.MouseEvent('click', { bubbles: true }))
        })
        await settlePicker()
        assert.equal(composerText(field), 'Fix the flaky test.\n', 'the pick takes the token and nothing else')
        assert.ok(
          view.find((el) => el.getAttribute('aria-label') === 'Remove skill backlog'),
          'and attaches the skill as a chip',
        )
        view.unmount()
      } finally {
        api.workspaceSkillsList = listed
      }
    })

    await check('a terminal agent: / opens no picker here, its CLI has its own once it starts', async () => {
      seedStore()
      const view = await render({ initialSelection: { kind: 'general' } })
      const field = composerField(view.container)
      await act(async () => {
        typeIntoComposer(field, 'first line\n/back')
      })
      await settlePicker()
      assert.equal(skillRow('backlog'), undefined, 'no skill picker opens for a terminal launch')
      assert.equal(composerText(field), 'first line\n/back', 'the draft is left as typed')
      view.unmount()
    })

    if (failures > 0) {
      console.error(`NewAgentPanel.test.tsx: ${failures} failing check(s)`)
      process.exit(1)
    }
    console.log('NewAgentPanel.test.tsx: ok')
  }

  const suiteRun = main()

  await suiteRun
})
