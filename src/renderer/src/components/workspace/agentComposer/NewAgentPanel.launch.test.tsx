import assert from 'node:assert/strict'

import { JSDOM } from 'jsdom'
import { composerField, typeIntoComposer } from '../../../../../../tests/composer-field'
import { test } from 'vitest'

test('NewAgentPanel launch paths', async () => {
  // Every kind New chat could start before the "+" menu replaced the ⋯ menu
  // and the Chat | Scheduled agent switch is still startable from it: a
  // conversation, a terminal agent, a plain terminal, a scheduled agent, and
  // a scheduled agent opened again to edit. The harness is the panel test's.

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
    const { resetRememberedMachineForTests } = await import('./NewAgentPanel')
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
    const pickKind = async (view: Harness, kind: 'conversation' | 'general' | 'terminal'): Promise<void> => {
      const menu = await openOptions(view)
      const tile = menu?.querySelector<HTMLElement>(`[data-start-as="${kind}"]`)
      assert.ok(tile, `the "+" offers ${kind}`)
      await act(async () => {
        tile!.dispatchEvent(new dom.window.MouseEvent('click', { bubbles: true }))
      })
    }

    const settle = async (): Promise<void> => {
      await act(async () => new Promise((resolve) => dom.window.setTimeout(resolve, 0)))
    }
    const click = async (el: Element): Promise<void> => {
      await act(async () => {
        el.dispatchEvent(new dom.window.MouseEvent('click', { bubbles: true }))
      })
    }
    const sendOf = (view: Harness): HTMLElement | undefined =>
      [...view.container.querySelectorAll<HTMLElement>('[data-new-chat-composer] button')].pop()
    const typePrompt = async (view: Harness, text: string): Promise<void> => {
      const field = composerField(view.container)
      await act(async () => {
        typeIntoComposer(field, text)
      })
    }

    await check('each kind the "+" offers starts that kind', async () => {
      for (const kind of ['conversation', 'general', 'terminal'] as const) {
        seedStore()
        const view = await render({ initialSelection: { kind: 'conversation' } })
        if (kind !== 'conversation') await pickKind(view, kind)
        if (kind !== 'terminal') await typePrompt(view, 'Fix the flaky test.')
        await click(sendOf(view)!)
        assert.equal(view.launches.length, 1, `${kind}: one launch`)
        assert.equal(view.launches[0]?.kind, kind, `${kind}: the launch is the kind picked`)
        view.unmount()
      }
    })

    // The scheduled agent's editor: its schedule is a tag with no ×, the tag
    // opens the picker, the send says Save, and a changed schedule is saved.
    const EDITING = {
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
    }
    const scheduleProps = (extra: Record<string, unknown> = {}) => ({
      initialSelection: { kind: 'conversation' },
      folderPath: '/proj',
      projectOptions: [],
      onSelectProject: () => {},
      onBrowseProject: () => {},
      ...extra,
    })

    await check('a scheduled agent being edited says Save, and its schedule can be changed and saved', async () => {
      seedStore()
      const api = (dom.window as unknown as { api: Record<string, unknown> }).api
      const updates: Array<{ id: string; draft: Record<string, unknown> }> = []
      api.updateScheduledAgent = async (id: string, draft: Record<string, unknown>) => {
        updates.push({ id, draft })
        return { ok: true, agent: { ...draft, id, nextRunAt: null } }
      }
      api.markScheduledAgentFailureSeen = async () => ({ ok: true })
      const view = await render(scheduleProps({ editingScheduledAgent: EDITING }))
      const send = sendOf(view)
      assert.equal(send?.textContent?.trim(), 'Save', 'the send says Save while editing')
      assert.equal(view.container.querySelector('[aria-label="Stop scheduling"]'), null, 'no × on the schedule tag')
      const tag = view.container.querySelector<HTMLElement>('[data-schedule-tag="true"]')
      assert.ok(tag?.textContent?.includes('Every Sunday at 9:00 PM'), 'the tag says the schedule')
      await click(tag!)
      const editor = dom.window.document.querySelector('[role="dialog"][aria-label="Schedule"]')
      assert.ok(editor, 'the tag opens the schedule editor')
      const monday = editor!.querySelector<HTMLElement>('[aria-label="Monday"]')
      assert.ok(monday, 'the editor offers the days of the week')
      await click(monday!)
      await act(async () => {
        dom.window.document.dispatchEvent(
          new dom.window.KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true }),
        )
      })
      await click(sendOf(view)!)
      await settle()
      assert.equal(updates.length, 1, 'Save saves')
      assert.equal(updates[0]?.id, 'sa-9')
      const cron = (updates[0]?.draft.schedule as { cron: string }).cron
      assert.notEqual(cron, '0 21 * * 0', 'with the schedule as changed')
      assert.match(cron, /\b0,1\b|\b1,0\b/u, 'Sunday and Monday')
      assert.equal(view.launches.length, 0, 'and starts nothing')
      view.unmount()
    })

    await check('a new scheduled agent is made from the "+" and its tag, and the send says Schedule', async () => {
      seedStore()
      const api = (dom.window as unknown as { api: Record<string, unknown> }).api
      const drafts: Array<Record<string, unknown>> = []
      api.createScheduledAgent = async (draft: Record<string, unknown>) => {
        drafts.push(draft)
        return { ok: true, agent: { ...draft, id: 'sa-1', nextRunAt: null } }
      }
      const view = await render(scheduleProps())
      const menu = await openOptions(view)
      await click(menu!.querySelector('[data-composer-schedule="true"]')!)
      assert.equal(sendOf(view)?.textContent?.trim(), 'Schedule')
      await typePrompt(view, 'Triage the new issues.')
      await click(sendOf(view)!)
      await settle()
      assert.equal(drafts.length, 1, 'a scheduled agent is made')
      assert.equal(view.launches.length, 0, 'and nothing starts now')
      view.unmount()
    })

    await check('the tab strip\'s "+" (a fixed project) starts in that project', async () => {
      seedStore()
      const view = await render({ initialSelection: { kind: 'conversation' }, folderPath: '/proj' })
      assert.ok(view.container.querySelector('[data-composer-strip] [data-project-line="true"]'), 'the project line')
      await typePrompt(view, 'Fix the flaky test.')
      await click(sendOf(view)!)
      assert.equal(view.launches.length, 1)
      assert.equal(view.launches[0]?.hostId, undefined, 'a fixed project names no machine')
      view.unmount()
    })

    await check('turning Schedule on drops a picked SSH machine, so the strip and the saved agent agree', async () => {
      seedStore()
      const api = (dom.window as unknown as { api: Record<string, unknown> }).api
      const drafts: Array<Record<string, unknown>> = []
      api.createScheduledAgent = async (draft: Record<string, unknown>) => {
        drafts.push(draft)
        return { ok: true, agent: { ...draft, id: 'sa-2', nextRunAt: null } }
      }
      api.sshMachinesEnabled = true
      api.sshEnvironmentsList = async () => [
        {
          id: 'ssh-1',
          label: 'build-box',
          destination: 'dev@build-box',
          resolved: { hostname: 'build-box', user: 'dev', port: 22, proxyJump: null },
          environmentId: null,
          settings: {},
          addedAt: 0,
          state: 'connected',
          stateText: 'Connected',
          working: false,
          action: null,
          server: null,
          notes: [],
        },
      ]
      try {
        const view = await render(scheduleProps())
        await settle()
        await click(view.container.querySelector('[data-machine-trigger="true"]')!)
        await click(dom.window.document.querySelector('[data-machine-ssh="ssh-1"]')!)
        await settle()
        assert.ok(
          view.container.querySelector('[aria-label="Folder on build-box"]') !== null,
          'the SSH machine is picked',
        )
        const menu = await openOptions(view)
        await click(menu!.querySelector('[data-composer-schedule="true"]')!)
        assert.ok(view.container.querySelector('[data-schedule-tag="true"]') !== null, 'scheduled')
        // A scheduled agent runs on this computer: the strip must not go on
        // asking for a folder on a machine the schedule will never use.
        assert.equal(
          view.container.querySelector('[aria-label="Folder on build-box"]') !== null,
          false,
          'no SSH folder field while scheduled',
        )
        await typePrompt(view, 'Triage the new issues.')
        await click(sendOf(view)!)
        await settle()
        assert.equal(drafts[0]?.folderPath, '/proj', 'the agent is saved for the project the strip shows')
        view.unmount()
      } finally {
        delete api.sshMachinesEnabled
        delete api.sshEnvironmentsList
        resetRememberedMachineForTests()
      }
    })

    await check(
      'an SSH machine picked before is dropped for an extension, which is made on this computer',
      async () => {
        seedStore()
        const api = (dom.window as unknown as { api: Record<string, unknown> }).api
        api.sshMachinesEnabled = true
        api.sshEnvironmentsList = async () => [
          {
            id: 'ssh-1',
            label: 'build-box',
            destination: 'dev@build-box',
            resolved: { hostname: 'build-box', user: 'dev', port: 22, proxyJump: null },
            environmentId: null,
            settings: {},
            addedAt: 0,
            state: 'connected',
            stateText: 'Connected',
            working: false,
            action: null,
            server: null,
            notes: [],
          },
        ]
        api.extensionScaffoldTarget = async (input: { parentDir: string; id: string }) => ({
          state: 'free',
          folder: `${input.parentDir}/${input.id}`,
        })
        try {
          // Picked in a chat door, and so remembered for the next one.
          const chat = await render(scheduleProps())
          await settle()
          await click(chat.container.querySelector('[data-machine-trigger="true"]')!)
          await click(dom.window.document.querySelector('[data-machine-ssh="ssh-1"]')!)
          await settle()
          assert.ok(chat.container.querySelector('[aria-label="Folder on build-box"]') !== null, 'picked')
          chat.unmount()

          const view = await render(scheduleProps({ initialMode: 'extension' }))
          await settle()
          assert.equal(
            view.container.querySelector('[aria-label="Folder on build-box"]') !== null,
            false,
            'no SSH folder field for an extension',
          )
          const trigger = view.container.querySelector('[data-machine-trigger="true"]')
          if (trigger) await click(trigger)
          assert.equal(
            dom.window.document.querySelector('[data-machine-ssh="ssh-1"]'),
            null,
            'nor an SSH machine to pick',
          )
          const name = view.container.querySelector('[aria-label="Extension name"]') as HTMLInputElement
          await act(async () => {
            Object.getOwnPropertyDescriptor(dom.window.HTMLInputElement.prototype, 'value')!.set!.call(name, 'pr-radar')
            name.dispatchEvent(new dom.window.Event('input', { bubbles: true }))
          })
          await act(async () => new Promise((resolve) => dom.window.setTimeout(resolve, 200)))
          await typePrompt(view, 'A badge counting open pull requests.')
          await click(sendOf(view)!)
          await settle()
          assert.equal(view.launches.length, 1)
          assert.deepEqual(view.launches[0]?.extension, { id: 'pr-radar' }, 'the extension is made here')
          assert.equal(view.launches[0]?.environment, undefined, 'not a chat on the SSH machine')
          view.unmount()
        } finally {
          delete api.sshMachinesEnabled
          delete api.sshEnvironmentsList
          delete api.extensionScaffoldTarget
          resetRememberedMachineForTests()
        }
      },
    )

    // The static New chat box the window booted with (public/boot-composer.js):
    // the panel's field takes over its words, and an Enter pressed in it
    // before the panel existed starts the chat with exactly those words.
    const standBootBox = (text: string, enterPending: boolean): HTMLElement => {
      const doc = dom.window.document
      const host = doc.createElement('div')
      host.setAttribute('data-static-composer', '')
      const input = doc.createElement('textarea')
      input.setAttribute('data-static-composer-input', '')
      host.appendChild(input)
      doc.body.appendChild(host)
      input.value = text
      input.setSelectionRange(text.length, text.length)
      input.focus()
      ;(dom.window as unknown as Record<string, unknown>).sprintengineBootComposer = {
        version: 1,
        storageKey: 'sprintengine-boot-composer',
        lookSignature: () => '',
        buildId: () => '',
        windowId: 'primary',
        live: { host, input, enterPending },
        seed: 7,
      }
      return host
    }
    const { composerText } = await import('../../../../../../tests/composer-field')

    await check('an Enter pressed in the static New chat box starts the chat with its words', async () => {
      seedStore()
      const box = standBootBox('Fix the flaky test.', true)
      const view = await render({ initialSelection: { kind: 'conversation' }, bootComposer: true })
      await settle()
      assert.equal(box.isConnected, false, 'the box is gone once the field has its words')
      assert.equal(view.launches.length, 1, 'the held Enter started one chat')
      assert.equal(view.launches[0]?.prompt, 'Fix the flaky test.')
      view.unmount()
    })

    await check('words typed in the static New chat box wait in the field when no Enter was pressed', async () => {
      seedStore()
      const box = standBootBox('Draft the release notes', false)
      const view = await render({ initialSelection: { kind: 'conversation' }, bootComposer: true })
      await settle()
      assert.equal(box.isConnected, false)
      assert.equal(composerText(composerField(view.container)), 'Draft the release notes')
      assert.equal(view.launches.length, 0, 'nothing starts without an Enter')
      view.unmount()
    })

    await check('a panel that is not the door leaves the static New chat box alone', async () => {
      seedStore()
      const box = standBootBox('not for this panel', true)
      const view = await render({ initialSelection: { kind: 'conversation' } })
      await settle()
      assert.equal(box.isConnected, true)
      assert.equal(view.launches.length, 0)
      view.unmount()
      box.remove()
      delete (dom.window as unknown as Record<string, unknown>).sprintengineBootComposer
    })

    // ⌘⏎ (`chat.new.launchInBackground`): the launch ⏎ makes, marked to stay,
    // and the box empty and ready for the next one with every choice kept.
    const pressEnter = async (view: Harness, init: Record<string, unknown> = {}): Promise<void> => {
      const field = composerField(view.container)
      await act(async () => {
        field.dispatchEvent(
          new dom.window.KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true, ...init }),
        )
      })
    }

    await check('⌘⏎ at the door starts the chat and stays, the box emptied with its choices kept', async () => {
      seedStore()
      const view = await render({ initialSelection: { kind: 'conversation' }, launchesInBackground: true })
      await act(async () => typeIntoComposer(composerField(view.container), 'Fix the flaky test.'))
      await pressEnter(view, { metaKey: true })
      assert.equal(view.launches.length, 1, 'one press, one launch')
      assert.equal(view.launches[0]?.stay, true, 'the host is told to keep the door up')
      assert.equal(view.launches[0]?.prompt, 'Fix the flaky test.')
      assert.equal(view.launches[0]?.cli, 'claude-code')
      await settle()
      assert.equal(composerText(composerField(view.container)), '', 'the box is empty for the next task')
      assert.equal(view.closed(), 0, 'nothing closed the panel')
      // The next one goes out on the same engine.
      await act(async () => typeIntoComposer(composerField(view.container), 'Write the release notes.'))
      await pressEnter(view, { metaKey: true })
      assert.equal(view.launches.length, 2)
      assert.equal(view.launches[1]?.cli, 'claude-code')
      assert.equal(view.launches[1]?.kind, 'conversation')
      view.unmount()
    })

    await check('plain ⏎ at the door still opens the chat it starts', async () => {
      seedStore()
      const view = await render({ initialSelection: { kind: 'conversation' }, launchesInBackground: true })
      await act(async () => typeIntoComposer(composerField(view.container), 'hi'))
      await pressEnter(view)
      assert.equal(view.launches.length, 1)
      assert.equal(view.launches[0]?.stay, undefined)
      view.unmount()
    })

    await check('⏎ on an empty box opens no chat, and New chat stays up', async () => {
      seedStore()
      const view = await render({ initialSelection: { kind: 'conversation' } })
      await pressEnter(view)
      assert.equal(view.launches.length, 0, 'a chat opens on the message that starts it')
      assert.equal(sendOf(view)?.hasAttribute('disabled'), true, 'the send waits for something to send')
      await act(async () => typeIntoComposer(composerField(view.container), 'hi'))
      assert.equal(sendOf(view)?.hasAttribute('disabled'), false)
      view.unmount()
    })

    await check('⌘⏎ where the panel cannot stay (a tab) is ⏎', async () => {
      seedStore()
      const view = await render({ initialSelection: { kind: 'conversation' } })
      await act(async () => typeIntoComposer(composerField(view.container), 'hi'))
      await pressEnter(view, { metaKey: true })
      assert.equal(view.launches.length, 1)
      assert.equal(view.launches[0]?.stay, undefined)
      view.unmount()
    })

    await check('⌘⏎ follows a rebind in the Shortcuts tab, and off it is ⏎', async () => {
      seedStore()
      const settings = useWorkspaceStore.getState().appSettings
      useWorkspaceStore.setState({
        appSettings: {
          ...settings,
          keybindings: { ...settings.keybindings, overrides: { 'chat.new.launchInBackground': ['Alt+Enter'] } },
        },
      } as never)
      const view = await render({ initialSelection: { kind: 'conversation' }, launchesInBackground: true })
      await act(async () => typeIntoComposer(composerField(view.container), 'one'))
      await pressEnter(view, { altKey: true })
      assert.equal(view.launches[0]?.stay, true, 'the rebound chord stays')
      await act(async () => typeIntoComposer(composerField(view.container), 'two'))
      await pressEnter(view, { metaKey: true })
      assert.equal(view.launches[1]?.stay, undefined, 'the old chord is plain ⏎ now')
      view.unmount()
      useWorkspaceStore.setState({ appSettings: settings } as never)
    })

    await check('a stay chord rebound to Alt and a letter matches the key, not the character it types', async () => {
      seedStore()
      const settings = useWorkspaceStore.getState().appSettings
      useWorkspaceStore.setState({
        appSettings: {
          ...settings,
          keybindings: { ...settings.keybindings, overrides: { 'chat.new.launchInBackground': ['Alt+K'] } },
        },
      } as never)
      const view = await render({ initialSelection: { kind: 'conversation' }, launchesInBackground: true })
      await act(async () => typeIntoComposer(composerField(view.container), 'one'))
      // Option+K on a Mac keyboard types "˚"; the key is still K.
      await act(async () => {
        composerField(view.container).dispatchEvent(
          new dom.window.KeyboardEvent('keydown', {
            key: '˚',
            code: 'KeyK',
            altKey: true,
            bubbles: true,
            cancelable: true,
          }),
        )
      })
      assert.equal(view.launches.length, 1, 'the rebound chord starts the chat')
      assert.equal(view.launches[0]?.stay, true)
      view.unmount()
      useWorkspaceStore.setState({ appSettings: settings } as never)
    })

    await check('a ⌘⏎ launch that started nothing hands the prompt back', async () => {
      seedStore()
      const launches: Array<Record<string, unknown>> = []
      const view = await render({
        initialSelection: { kind: 'conversation' },
        launchesInBackground: true,
        onLaunch: (launch: Record<string, unknown>) => {
          launches.push(launch)
          return Promise.resolve(false)
        },
      })
      await act(async () => typeIntoComposer(composerField(view.container), 'Cut a worktree for this.'))
      await pressEnter(view, { metaKey: true })
      await settle()
      assert.equal(launches.length, 1)
      assert.equal(composerText(composerField(view.container)), 'Cut a worktree for this.')
      view.unmount()
    })

    const nameWorktree = async (view: Harness, name: string): Promise<HTMLInputElement> => {
      const field = view.container.querySelector<HTMLInputElement>('input[aria-label^="Worktree name"]')
      assert.ok(field, 'the door offers the worktree name')
      await act(async () => {
        Object.getOwnPropertyDescriptor(dom.window.HTMLInputElement.prototype, 'value')!.set!.call(field, name)
        field!.dispatchEvent(new dom.window.Event('input', { bubbles: true }))
      })
      return field!
    }

    await check('⌘⏎ with a named worktree leaves the next chat to make up its own', async () => {
      seedStore()
      const { resetNewChatDraftsForTests } = await import('./newChatDraft')
      resetNewChatDraftsForTests()
      const view = await render({
        initialSelection: { kind: 'conversation' },
        launchesInBackground: true,
        draftKey: 'w',
      })
      const name = await nameWorktree(view, 'fix-login')
      await act(async () => typeIntoComposer(composerField(view.container), 'Fix the login.'))
      await pressEnter(view, { metaKey: true })
      await settle()
      assert.deepEqual(view.launches[0]?.worktree, { name: 'fix-login' })
      assert.equal(name.value, '', 'the name went with the chat it was typed for')
      await act(async () => typeIntoComposer(composerField(view.container), 'Write the notes.'))
      await pressEnter(view, { metaKey: true })
      assert.deepEqual(
        view.launches[1]?.worktree,
        { name: '' },
        'the next one is still in a worktree, made up at start',
      )
      view.unmount()
      resetNewChatDraftsForTests()
    })

    await check('a ⌘⏎ launch that started nothing hands the worktree name back too', async () => {
      seedStore()
      const { resetNewChatDraftsForTests } = await import('./newChatDraft')
      resetNewChatDraftsForTests()
      const view = await render({
        initialSelection: { kind: 'conversation' },
        launchesInBackground: true,
        draftKey: 'w',
        onLaunch: () => Promise.resolve(false),
      })
      const name = await nameWorktree(view, 'fix-login')
      await act(async () => typeIntoComposer(composerField(view.container), 'Fix the login.'))
      await pressEnter(view, { metaKey: true })
      await settle()
      assert.equal(name.isConnected ? name.value : null, 'fix-login')
      view.unmount()
      resetNewChatDraftsForTests()
    })

    if (failures > 0) {
      console.error(`NewAgentPanel.launch.test.tsx: ${failures} failing check(s)`)
      process.exit(1)
    }
    console.log('NewAgentPanel.launch.test.tsx: ok')
  }

  await main()
})
