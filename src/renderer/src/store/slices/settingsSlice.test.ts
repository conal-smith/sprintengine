import assert from 'node:assert/strict'

import type { AppSettings, CliRuntimeSettings } from '../../types/workspace'
import type { Workspace } from '../../types/workspace'
import { LEGACY_COMMAND_ID_ALIASES } from '../../commands/keybindings'
import { useWorkspaceStore } from '../workspaceStore'
import type { ChatListView, DiffViewMode, SettingsOverlayState, SidebarSection } from './settingsSlice'
import {
  createSettingsSlice,
  DEFAULT_DIFF_OPENS_IN_WINDOW,
  DEFAULT_DIFF_VIEW,
  defaultAppearanceSettings,
  defaultAppSettings,
  defaultKeybindingSettings,
  normalizeAppearanceSettings,
  normalizeAppSettings,
  normalizeCliModelCatalogs,
  normalizeSelectedCli,
  normalizeCliModelSelection,
  normalizeCliPermissionPreset,
  normalizeDesignSystemSeen,
  normalizeKeybindingSettings,
  normalizeModuleSettings,
  moduleSettingsNamespace,
  normalizeRecentWorkspaceFolders,
  normalizeNewChatAgentChoice,
  normalizeProjectColors,
} from './settingsSlice'
import { normalizeTextGenerationSettings } from '../../../../shared/text-generation/contract'
import type { ProjectColorSetting } from '../../utils/projectColor'
import { EXTENSIONS_BROWSE_DEEPLINK } from '../../components/settings/extensionsRoute'
import { consumePendingExtensionsSurfaceTarget } from '../../components/workspace/globalSurface/extensions/extensionsSurfaceTarget'
import { test } from 'vitest'

/** The writing style a profile from before the setting reads as. */
const MATCH_REPOSITORY = { mode: 'repository', instructions: '' }

test('settingsSlice', async () => {
  const workspaceWithMemoryRoot = {
    folderPath: '/Users/example/project',
    memory: {
      relativeRoot: 'knowledge',
    },
  } as Workspace

  const normalized = normalizeAppSettings(
    {
      cliRuntimes: {
        // A copy persisted before the per-CLI WSL switch was retired.
        codex: { command: 'codex-next', useWsl: true } as CliRuntimeSettings,
      },
      mcp: {
        syncEnabled: true,
        servers: {
          valid: {
            id: ' Valid Server ',
            name: ' Valid Server ',
            transport: 'stdio',
            command: ' npx ',
            args: [' package ', '', 123 as unknown as string],
            enabled: true,
            clients: ['codex', 'opencode', 'bad cli!'],
            scope: 'user',
            source: 'custom',
            riskLevel: 'secrets',
          },
          invalid: {
            id: 'broken',
            name: 'Broken',
            transport: 'stdio',
            clients: ['codex'],
            enabled: true,
          } as never,
        },
      },
      lastSelectedCli: ' ',
      lastAgentSpawnPermissionPreset: 'unsafe' as never,
      projectKnowledgeRoots: {
        '/Users/example/project/': ' docs/knowledge ',
        '/Users/example/bad': '/absolute',
      },
      recentWorkspaceFolders: [' /Users/example/project ', '/Users/example/project/', '', '/Users/example/other'],
    },
    [workspaceWithMemoryRoot],
  )

  assert.equal(normalized.cliRuntimes.codex.command, 'codex-next')
  assert.equal('useWsl' in normalized.cliRuntimes.codex, false, 'the retired WSL switch is dropped on read')
  assert.deepEqual(normalized.hosts, {}, 'no machine settings reads as none')
  assert.equal(normalized.cliRuntimes['claude-code'].command, defaultAppSettings().cliRuntimes['claude-code'].command)
  assert.equal(normalized.cliRuntimes.claude, undefined)
  assert.equal(normalized.lastSelectedCli, 'claude-code')
  assert.equal(normalized.mcp.syncEnabled, true)
  assert.deepEqual(Object.keys(normalized.mcp.servers), ['valid-server'])
  assert.deepEqual(normalized.mcp.servers['valid-server'].args, ['package'])
  assert.deepEqual(normalized.mcp.servers['valid-server'].clients, ['codex', 'opencode', 'bad-cli'])
  assert.equal(normalized.lastAgentSpawnPermissionPreset, 'auto', 'a value no version wrote takes the default')
  assert.deepEqual(normalized.projectKnowledgeRoots, {
    '/Users/example/project': 'docs/knowledge',
  })
  assert.deepEqual(normalized.recentWorkspaceFolders, ['/Users/example/project', '/Users/example/other'])
  assert.deepEqual(normalized.keybindings, defaultKeybindingSettings())

  // --- Keybinding settings --------------------------------------------------
  assert.deepEqual(
    normalizeAppSettings({}, []).keybindings,
    { overrides: {}, disabled: {} },
    'missing keybindings migrate to safe empty deltas',
  )

  const normalizedKeybindings = normalizeAppSettings(
    {
      keybindings: {
        overrides: {
          'commandPalette.open': [' CmdOrCtrl + K ', 'Primary+K', 'Ctrl + +', 'Hyper+Nope'],
          'app.settings.open': ['Primary+,'],
          'unknown.command': ['Primary+L'],
          'editor.save': 'Primary+S' as never,
        },
        disabled: {
          'retired.command': true,
          'app.settings.open': false,
          'unknown.command': true,
          'terminal.new': 'yes' as never,
        },
      },
    },
    [],
  )
  assert.deepEqual(
    normalizedKeybindings.keybindings.overrides,
    {
      'commandPalette.open': ['primary+k', 'ctrl++'],
      'app.settings.open': ['primary+,'],
      // Ids outside the static shell registry are kept on purpose: module
      // command deltas are stored by id and filtered at consumption, so they
      // survive module disable/enable (and uninstall/reinstall) cycles.
      'unknown.command': ['primary+l'],
    },
    'normalization keeps valid overrides (including unregistered ids), collapses duplicates, and drops malformed entries',
  )
  assert.deepEqual(
    normalizedKeybindings.keybindings.disabled,
    { 'retired.command': true, 'unknown.command': true },
    'normalization keeps true disabled flags by id; non-true and malformed flags are dropped',
  )

  assert.deepEqual(
    normalizeKeybindingSettings({
      overrides: { 'commandPalette.open': ['Primary+K', 'Primary+K', 'Ctrl+K then Ctrl+S then Ctrl+P'] },
      disabled: { 'commandPalette.open': true },
    }),
    {
      overrides: { 'commandPalette.open': ['primary+k'] },
      disabled: { 'commandPalette.open': true },
    },
    'standalone keybinding normalization rejects duplicates and invalid chords',
  )

  // The migration table. Each of the four presets reads as itself, and each
  // pre-rename spelling as the preset its label promised; none of them that
  // asked is ever widened into bypass. Only the pre-rename spelling of bypass
  // itself, an absent value, or one no version ever wrote reads as `bypass`,
  // the default.
  const migration: Array<[unknown, 'none' | 'manual' | 'auto' | 'bypass']> = [
    ['none', 'none'],
    ['bypass', 'bypass'],
    ['manual', 'manual'],
    ['auto', 'auto'],
    ['default', 'manual'],
    ['auto_workspace', 'auto'],
    ['bypass_all', 'bypass'],
    [undefined, 'auto'],
    [null, 'auto'],
    ['nonsense', 'auto'],
    [42, 'auto'],
  ]
  for (const [stored, expected] of migration) {
    assert.equal(normalizeCliPermissionPreset(stored), expected, `${String(stored)} reads as ${expected}`)
  }

  // New-chat agent choice: the three spawn kinds round-trip; only malformed
  // shapes and missing values use the first-run choice, which is Terminal.
  assert.deepEqual(normalizeNewChatAgentChoice({ kind: 'terminal' }), { kind: 'terminal' })
  assert.deepEqual(normalizeNewChatAgentChoice({ kind: 'conversation' }), { kind: 'conversation' })
  assert.deepEqual(normalizeNewChatAgentChoice({ kind: 'general' }), { kind: 'general' })
  assert.deepEqual(normalizeNewChatAgentChoice({ kind: 'bogus' }), { kind: 'terminal' })
  assert.deepEqual(normalizeNewChatAgentChoice(undefined), { kind: 'terminal' })
  assert.deepEqual(normalizeNewChatAgentChoice('conversation'), { kind: 'terminal' })
  assert.deepEqual(defaultAppSettings().lastNewChatAgent, { kind: 'terminal' })

  // A model override keeps only a well-formed { cli, model } pair.
  assert.deepEqual(normalizeCliModelSelection({ cli: 'claude-code', model: ' opus ' }), {
    cli: 'claude-code',
    model: 'opus',
  })
  assert.equal(normalizeCliModelSelection({ cli: '', model: 'opus' }), null)
  assert.equal(normalizeCliModelSelection({ cli: 'codex' } as never), null)
  // The reasoning-effort level rides the same selection. A level with no model is
  // a real choice ("the CLI's default model at high effort") and survives; a
  // selection with neither is not an override at all.
  assert.deepEqual(normalizeCliModelSelection({ cli: 'claude-code', model: 'opus', reasoning: ' high ' }), {
    cli: 'claude-code',
    model: 'opus',
    reasoning: 'high',
  })
  assert.deepEqual(normalizeCliModelSelection({ cli: 'codex', model: '', reasoning: 'xhigh' }), {
    cli: 'codex',
    model: '',
    reasoning: 'xhigh',
  })
  assert.equal(normalizeCliModelSelection({ cli: 'codex', model: '', reasoning: '   ' }), null)
  assert.deepEqual(normalizeCliModelSelection({ cli: 'codex', model: 'gpt-5.5', reasoning: 42 } as never), {
    cli: 'codex',
    model: 'gpt-5.5',
  })
  const modelNormalized = normalizeAppSettings(
    {
      cliRuntimes: {
        codex: { command: 'codex', models: [' gpt-5-codex ', '', 'gpt-5-codex', 'o4-mini'] },
      },
    },
    [],
  )
  assert.deepEqual(modelNormalized.cliRuntimes.codex.models, ['gpt-5-codex', 'o4-mini'])
  assert.equal(modelNormalized.cliRuntimes['claude-code'].models, undefined)
  assert.equal('cliModelDefaults' in modelNormalized, false)
  // cliModelCatalog: what each CLI reported about itself, app-owned and kept
  // strictly apart from the user's own ids in cliRuntimes[cli].models.
  assert.equal(normalizeCliModelCatalogs(undefined), undefined)
  assert.equal(normalizeCliModelCatalogs('not an object'), undefined)
  assert.equal(
    normalizeCliModelCatalogs({ codex: { models: [{ id: 'gpt-5.6' }], source: 'argv-probe' } }),
    undefined,
    'an entry with no fetch timestamp is dropped rather than repaired',
  )
  assert.equal(
    normalizeCliModelCatalogs({
      codex: { models: [{ id: 'gpt-5.6' }], fetchedAt: '2026-07-26T00:00:00Z', source: 'guessed' },
    }),
    undefined,
    'an entry whose source is not a known probe kind is dropped',
  )
  assert.equal(
    normalizeCliModelCatalogs({
      codex: { models: 'gpt-5.6', fetchedAt: '2026-07-26T00:00:00Z', source: 'argv-probe' },
    }),
    undefined,
    'an entry whose models is not an array is dropped',
  )
  assert.deepEqual(
    normalizeCliModelCatalogs({
      codex: {
        models: [
          {
            id: ' gpt-5.6 ',
            displayName: ' GPT-5.6 ',
            contextWindow: 272000,
            effortLevels: ['low', '', 'high'],
            supportsFastMode: true,
          },
          { id: 'gpt-5.6' },
          { id: '   ' },
          'not a model',
          { id: 'gpt-5.4', contextWindow: -1, effortLevels: [], displayName: '   ', supportsFastMode: 'yes' },
        ],
        fetchedAt: ' 2026-07-26T00:00:00Z ',
        source: 'argv-probe',
        cliVersion: ' 0.60.0 ',
      },
      '  ': { models: [], fetchedAt: '2026-07-26T00:00:00Z', source: 'argv-probe' },
    }),
    {
      codex: {
        models: [
          {
            id: 'gpt-5.6',
            displayName: 'GPT-5.6',
            contextWindow: 272000,
            effortLevels: ['low', 'high'],
            supportsFastMode: true,
          },
          { id: 'gpt-5.4' },
        ],
        fetchedAt: '2026-07-26T00:00:00Z',
        source: 'argv-probe',
        cliVersion: '0.60.0',
      },
    },
    'rows are trimmed and deduped by id; wrong-typed fields drop to absent, not to a coerced value',
  )
  assert.deepEqual(
    normalizeCliModelCatalogs({
      'claude-code': { models: [], fetchedAt: '2026-07-26T00:00:00Z', source: 'agent-sdk' },
    }),
    { 'claude-code': { models: [], fetchedAt: '2026-07-26T00:00:00Z', source: 'agent-sdk' } },
    'a CLI that answered with no models keeps its entry — "listed nothing" is not "never probed"',
  )
  const catalogNormalized = normalizeAppSettings(
    {
      cliRuntimes: { codex: { command: 'codex', models: ['o4-mini'] } },
      cliModelCatalog: {
        codex: { models: [{ id: 'gpt-5.6' }], fetchedAt: '2026-07-26T00:00:00Z', source: 'argv-probe' },
        grok: { models: [{ id: 'grok-4' }], source: 'argv-probe' },
      },
    } as never,
    [],
  )
  assert.deepEqual(
    catalogNormalized.cliModelCatalog,
    { codex: { models: [{ id: 'gpt-5.6' }], fetchedAt: '2026-07-26T00:00:00Z', source: 'argv-probe' } },
    'normalizeAppSettings carries a well-formed catalog and drops a malformed one',
  )
  assert.deepEqual(
    catalogNormalized.cliRuntimes.codex.models,
    ['o4-mini'],
    'the discovered catalog never leaks into the user list for the same CLI',
  )

  assert.deepEqual(normalizeRecentWorkspaceFolders(['/A', '/a/', '/B'], ['/C', '/b']), ['/A', '/B', '/C'])

  const carrier = {
    workspaces: [
      {
        folderPath: '/Users/example/project',
        memory: {
          relativeRoot: 'knowledge',
        },
      } as Workspace,
    ],
    appSettings: defaultAppSettings(),
    settingsOverlay: { initialTab: null, checkForUpdatesRequestId: null } as SettingsOverlayState,
    automationsOverlay: { open: false, projectPath: null, runTarget: null },
    activeGlobalSurface: null as string | null,
    activeModalSurface: null as string | null,
    activeModalSurfaceWorkspaceId: null as string | null,
    sidebarSection: 'home' as SidebarSection,
    chatListView: 'projects' as ChatListView,
    sidebarCollapsed: false,
    sidebarWidth: 280,
    workspacePaneWidth: 420,
    workspacePaneMaximised: false,
    openFilesInExternalWindow: true,
    diffOpensInWindow: true,
    diffView: 'side-by-side' as DiffViewMode,
    checkCliVersions: true,
    agentConfigAdoptionResult: null,
  }
  const slice = createSettingsSlice((mutator) => mutator(carrier))
  // Settings is a MODAL (doors→modals, 2026-09-01; a door before that): opening
  // it floats the modal over whatever owns the card region, and what stays in
  // `settingsOverlay` is only the REQUEST — which category, and whether an
  // update check was asked for.
  slice.openSettingsOverlay({ initialTab: 'integrations', checkForUpdates: true })
  assert.equal(carrier.activeModalSurface, 'settings', 'settings opens as a modal')
  assert.equal(carrier.activeGlobalSurface, null, 'settings never routes the card region')
  assert.equal(carrier.settingsOverlay.initialTab, 'integrations')
  assert.equal(typeof carrier.settingsOverlay.checkForUpdatesRequestId, 'number')
  slice.closeSettingsOverlay()
  assert.equal(carrier.activeModalSurface, null, 'closing settings closes the modal')
  assert.deepEqual(carrier.settingsOverlay, { initialTab: null, checkForUpdatesRequestId: null })

  // An opener that knows which machine its news is about (a CLI update is This
  // PC's) names it, and each open is a new request so an Agents tab already
  // showing another machine still moves. A plain open carries none.
  // Re-read through the declared type: the deepEqual above narrowed it.
  const overlay = (): SettingsOverlayState => carrier.settingsOverlay
  slice.openSettingsOverlay({ initialTab: 'agents', agentsMachine: 'local' })
  const first = overlay().agentsMachineRequest
  assert.equal(first?.hostId, 'local')
  slice.openSettingsOverlay({ initialTab: 'agents', agentsMachine: 'local' })
  assert.ok(
    (overlay().agentsMachineRequest?.requestId ?? 0) > (first?.requestId ?? 0),
    'a second open is a second request',
  )
  slice.openSettingsOverlay({ initialTab: 'agents' })
  assert.equal(overlay().agentsMachineRequest, undefined, 'a plain open names no machine')
  slice.openSettingsOverlay({ initialTab: 'agents', agentsMachine: 'local' })
  slice.closeSettingsOverlay()
  assert.deepEqual(
    carrier.settingsOverlay,
    { initialTab: null, checkForUpdatesRequestId: null },
    'closing clears it with the rest of the request',
  )

  // Where a diff opens (git-commit-window T3). The window is the out-of-the-box
  // answer, and the flip is a
  // plain setter, because the two band buttons that write it are the whole UI.
  assert.equal(DEFAULT_DIFF_OPENS_IN_WINDOW, true, 'a diff opens in its own window until the person says otherwise')
  assert.equal(slice.diffOpensInWindow, true, 'the slice starts on the default')
  slice.setDiffOpensInWindow(false)
  assert.equal(carrier.diffOpensInWindow, false, '"Show in the app" flips the diff home to the pane tab')
  slice.setDiffOpensInWindow(true)
  assert.equal(carrier.diffOpensInWindow, true, 'and "Open in separate window" flips it back')

  // How a diff is DRAWN (git-commit-window T4). Two panes is the default; the diff window's icon-only toggle is the only writer, and it is
  // app-wide because it is how this person reads a diff rather than a property of
  // one file.
  assert.equal(DEFAULT_DIFF_VIEW, 'side-by-side', 'a diff opens side by side until the person says otherwise')
  assert.equal(slice.diffView, 'side-by-side', 'the slice starts on the default')
  slice.setDiffView('unified')
  assert.equal(carrier.diffView, 'unified', 'the toggle persists the unified reading')
  slice.setDiffView('side-by-side')
  assert.equal(carrier.diffView, 'side-by-side', 'and back')

  // Closing settings never clears somebody ELSE's modal — and never touches a
  // door: the two are independent layers.
  carrier.activeModalSurface = 'notebooks'
  carrier.activeGlobalSurface = 'backlog'
  slice.closeSettingsOverlay()
  assert.equal(carrier.activeModalSurface, 'notebooks', 'another open modal survives a settings close')
  assert.equal(carrier.activeGlobalSurface, 'backlog', 'an open door survives a settings close')
  carrier.activeModalSurface = null
  carrier.activeGlobalSurface = null

  // openExtensionsSurface opens the Plugins DOOR (Extensions drawer ruling,
  // 2026-09-05; a modal from 2026-09-01 until then, the Extensions door before
  // that); closing is closeGlobalSurface. The caller can be inside the Settings
  // modal (Settings → Modules "Browse marketplace"): the door routes the region
  // the modal was floating over, so the modal closes and the settings request it
  // was carrying goes with it rather than surviving to re-open a category later.
  // The sidebar follows: Plugins is a drawer row, so leaving it lands on the
  // drawer rather than on the workspaces tree.
  carrier.activeModalSurface = 'settings'
  carrier.sidebarSection = 'home'
  carrier.settingsOverlay = { initialTab: 'modules', checkForUpdatesRequestId: null }
  slice.openExtensionsSurface()
  assert.equal(carrier.activeGlobalSurface, 'extensions', 'Browse marketplace lands on the Plugins door')
  assert.equal(carrier.activeModalSurface, null, 'and the Settings modal it was opened from is gone')
  assert.equal(carrier.sidebarSection, 'extensions', 'with the Extensions drawer beside it')
  assert.equal('connectorsSurface' in carrier, false, 'the modal-era store flag is gone')
  assert.equal(carrier.settingsOverlay.initialTab, null, 'the settings request does not outlive its modal')
  slice.closeGlobalSurface()
  assert.equal(carrier.activeGlobalSurface, null)
  assert.equal(carrier.sidebarSection, 'extensions', 'and leaving the door lands back on the drawer')

  // A door underneath survives a modal's open/close round-trip: the modal is a
  // float over the card region, not a routing of it.
  carrier.activeGlobalSurface = 'backlog'
  slice.openModalSurface('notebooks')
  assert.equal(carrier.activeModalSurface, 'notebooks')
  assert.equal(carrier.activeGlobalSurface, 'backlog', 'the door under the modal stays put')
  slice.closeModalSurface()
  assert.equal(carrier.activeGlobalSurface, 'backlog', 'closing the modal lands back on the door')

  // The opener's workspace rides with the modal (D5/WP-C): the pane strip passes
  // the workspace it was picked in, and the shell hands it to the surface body —
  // a modal floats over the window, so this is the only thing that says which
  // workspace it acts on. It is set, replaced and cleared with the modal itself,
  // never left behind for the next one to inherit.
  slice.openModalSurface('notebooks', { workspaceId: 'ws-7' })
  assert.equal(carrier.activeModalSurfaceWorkspaceId, 'ws-7', 'the opener records its workspace')
  slice.closeModalSurface()
  assert.equal(carrier.activeModalSurfaceWorkspaceId, null, 'and closing the modal takes it')
  slice.openModalSurface('notebooks', { workspaceId: 'ws-7' })
  slice.openModalSurface('notebooks')
  assert.equal(
    carrier.activeModalSurfaceWorkspaceId,
    null,
    'an opener with no workspace clears the last one — a stale id would act on a workspace nobody named',
  )
  slice.openModalSurface('notebooks', { workspaceId: 'ws-7' })
  slice.openSettingsOverlay()
  assert.equal(carrier.activeModalSurfaceWorkspaceId, null, "Settings is the app's, not a workspace's")
  slice.closeSettingsOverlay()
  slice.openModalSurface('notebooks', { workspaceId: 'ws-7' })
  slice.openGlobalSurface('backlog')
  assert.equal(carrier.activeModalSurfaceWorkspaceId, null, 'and a door open clears it with the modal it closes')
  slice.closeGlobalSurface()
  carrier.activeGlobalSurface = null

  // The reverse is NOT symmetric: opening a door closes the modal, or a history
  // step to a door would mount it invisibly behind the modal's scrim.
  slice.openModalSurface('notebooks')
  slice.openGlobalSurface('backlog')
  assert.equal(carrier.activeGlobalSurface, 'backlog')
  assert.equal(carrier.activeModalSurface, null, 'a door open closes the modal over it')
  slice.openModalSurface('settings')
  slice.openExtensionsSurface()
  assert.equal(carrier.activeModalSurface, null, 'a named door convenience closes the modal too')
  slice.closeGlobalSurface()
  carrier.activeGlobalSurface = null

  // Which SECTION a door open moves the sidebar to is the Extensions drawer
  // ruling (2026-09-05), and it is not "always Extensions" any more. A door that
  // is one of the drawer's rows flips the section, so leaving it lands back
  // on the drawer that opened it; Automations stands on the RAIL, so opening it
  // leaves the section exactly where the operator had it — flipping there swapped
  // the sidebar into a drawer nobody asked for and lit the Extensions glyph for a
  // surface that is not one of its rows.
  for (const drawerDoor of ['design', 'extensions', 'extensions-home']) {
    carrier.sidebarSection = 'home'
    slice.openGlobalSurface(drawerDoor)
    assert.equal(carrier.sidebarSection, 'extensions', `${drawerDoor} is a drawer door and moves the section`)
  }
  carrier.sidebarSection = 'home'
  slice.openGlobalSurface('automations')
  assert.equal(carrier.sidebarSection, 'home', 'Automations leaves the section alone — it stands on the rail')
  slice.closeGlobalSurface()
  carrier.activeGlobalSurface = null
  carrier.sidebarSection = 'home'

  // The door-routed full-page surface (global-surfaces epic 1704) is a mount kind,
  // not an overlay: openGlobalSurface sets the active surface id, closeGlobalSurface
  // clears it. Per-window and transient (unsynced/unpersisted — see
  // extractSettingsFields, which omits it), like the other per-window flags.
  slice.openGlobalSurface('roadmap')
  assert.equal(carrier.activeGlobalSurface, 'roadmap')
  slice.openGlobalSurface('backlog')
  assert.equal(carrier.activeGlobalSurface, 'backlog', 'opening another door replaces the active surface')
  slice.closeGlobalSurface()
  assert.equal(carrier.activeGlobalSurface, null)

  // `openRoadmapSurface` is gone with the Roadmap door it named: a named
  // convenience for a surface nothing registers any more is an action whose only
  // caller is its own test. `openGlobalSurface('roadmap')` above is the whole
  // mechanism, and it is what the convenience had been reduced to.
  assert.equal('openRoadmapSurface' in slice, false, 'the retired door takes its named opener with it')
  assert.equal('roadmapSurface' in carrier, false, 'the legacy overlay store flag is gone')

  // The workspace pane column (browser-pane epic) took over the aside column
  // the retired aside left vacant: the app-level width clamps to the column bounds and the
  // maximised flag is a plain transient toggle.
  assert.equal('workspaceAsideOpen' in carrier, false, 'open/closed is per workspace now, not app state')
  slice.setWorkspacePaneMaximised(true)
  assert.equal(carrier.workspacePaneMaximised, true)
  slice.setWorkspacePaneMaximised(false)
  assert.equal(carrier.workspacePaneMaximised, false)
  slice.setWorkspacePaneWidth(10_000)
  assert.equal(carrier.workspacePaneWidth, 720, 'width clamps to the column max')
  slice.setWorkspacePaneWidth(10)
  assert.equal(carrier.workspacePaneWidth, 240, 'width clamps to the column min')
  slice.setWorkspacePaneWidth(Number.NaN)
  assert.equal(carrier.workspacePaneWidth, 420, 'a non-finite width falls back to the default')

  // T3: the MCPs / Skill packs / Extensions settings tabs folded into the
  // connectors surface — the Plugins DOOR again since the Extensions drawer
  // ruling (2026-09-05; a modal from 2026-09-01, the Extensions door before that). A
  // deep-link that once opened one of those tabs (by tab id, or the legacy
  // Extensions browse deep-link) must open the surface, not a settings overlay on
  // a tab that no longer exists.
  for (const foldedTab of ['mcps', 'skill-packs', 'extensions', EXTENSIONS_BROWSE_DEEPLINK]) {
    carrier.activeModalSurface = null
    carrier.activeGlobalSurface = null
    carrier.settingsOverlay = { initialTab: null, checkForUpdatesRequestId: null }
    consumePendingExtensionsSurfaceTarget()
    slice.openSettingsOverlay({ initialTab: foldedTab })
    assert.equal(carrier.activeGlobalSurface, 'extensions', `${foldedTab} routes to the Plugins door`)
    assert.equal(carrier.activeModalSurface, null, `${foldedTab} leaves no modal floating over it`)
    assert.equal(carrier.settingsOverlay.initialTab, null, `${foldedTab} leaves no dangling settings tab`)
    // Skill packs are gone, so the tab that named them lands on Skills —
    // the surface's other deep-links land on the Plugins catalogue, which is
    // what `browse` used to mean before the views were named for themselves
    // (source-tabs ruling, 2026-09-05).
    assert.deepEqual(
      consumePendingExtensionsSurfaceTarget(),
      { view: foldedTab === 'skill-packs' ? 'skills' : 'plugins' },
      `${foldedTab} lands on the view it was asking for`,
    )
  }

  // The app-wide agent-spawn permission preset is an explicit user pick, so it is
  // stored exactly as chosen rather than snapping back to the app-wide bypass
  // default.
  slice.setLastAgentSpawnPermissionPreset('bypass')
  assert.equal(carrier.appSettings.lastAgentSpawnPermissionPreset, 'bypass')
  slice.setLastAgentSpawnPermissionPreset('none')
  assert.equal(carrier.appSettings.lastAgentSpawnPermissionPreset, 'none')
  slice.setLastAgentSpawnPermissionPreset('manual')
  assert.equal(carrier.appSettings.lastAgentSpawnPermissionPreset, 'manual')
  slice.setLastAgentSpawnPermissionPreset('auto_workspace' as never)
  assert.equal(
    carrier.appSettings.lastAgentSpawnPermissionPreset,
    'auto',
    'a pre-rename pick from an older window keeps what its label promised',
  )

  const store = useWorkspaceStore.getState()
  store.setLastSelectedCli('codex')
  assert.equal(useWorkspaceStore.getState().appSettings.lastSelectedCli, 'codex')

  store.setCliRuntime('codex', { command: 'codex', models: ['o4-mini'] })
  store.setCliModelCatalog('codex', {
    models: [{ id: 'gpt-5.6' }, { id: 'gpt-5.4' }],
    fetchedAt: '2026-07-26T00:00:00Z',
    source: 'argv-probe',
  })
  assert.deepEqual(
    useWorkspaceStore.getState().appSettings.cliModelCatalog?.codex?.models,
    [{ id: 'gpt-5.6' }, { id: 'gpt-5.4' }],
    'setCliModelCatalog records what the CLI reported',
  )
  assert.deepEqual(
    useWorkspaceStore.getState().appSettings.cliRuntimes.codex.models,
    ['o4-mini'],
    'writing the discovered catalog leaves the user list for that CLI untouched',
  )
  store.setCliModelCatalog('codex', {
    models: [{ id: 'gpt-5.6' }],
    fetchedAt: '2026-07-27T00:00:00Z',
    source: 'argv-probe',
  })
  assert.deepEqual(
    useWorkspaceStore.getState().appSettings.cliModelCatalog?.codex?.models,
    [{ id: 'gpt-5.6' }],
    'a second probe replaces that CLI entry wholesale — a model it stopped listing is gone',
  )
  store.setCliModelCatalog('codex', { models: [{ id: 'gpt-5.6' }], fetchedAt: '', source: 'argv-probe' })
  assert.deepEqual(
    useWorkspaceStore.getState().appSettings.cliModelCatalog?.codex?.models,
    [{ id: 'gpt-5.6' }],
    'an unusable payload leaves the last good catalog in place instead of wiping it',
  )
  store.setCliModelCatalog('codex', null)
  assert.equal(
    useWorkspaceStore.getState().appSettings.cliModelCatalog,
    undefined,
    'clearing the only entry leaves no empty catalog behind',
  )

  // The remembered agent-spawn model. Reasoning effort is per-CLI (owner ruling
  // 2026-07-26): it outlives a model change within the CLI — including a switch
  // to the CLI's own default model — and is dropped when the CLI changes,
  // because level sets do not transfer.
  const lastAgentModel = () => useWorkspaceStore.getState().appSettings.lastSelectedAgentModel
  store.setLastSelectedAgentModel({ cli: 'claude-code', model: 'opus' })
  assert.deepEqual(lastAgentModel(), { cli: 'claude-code', model: 'opus' })
  store.setLastSelectedAgentModel(null)
  assert.equal(lastAgentModel(), null)

  store.setLastSelectedAgentReasoning('codex', 'high')
  assert.deepEqual(
    lastAgentModel(),
    { cli: 'codex', model: '', reasoning: 'high' },
    'a level can be set before any model is chosen',
  )
  store.setLastSelectedAgentModel({ cli: 'codex', model: 'gpt-5.6-sol' })
  assert.deepEqual(
    lastAgentModel(),
    { cli: 'codex', model: 'gpt-5.6-sol', reasoning: 'high' },
    'choosing a model within the same CLI keeps the level',
  )
  store.setLastSelectedAgentModel({ cli: 'codex', model: '' })
  assert.deepEqual(
    lastAgentModel(),
    { cli: 'codex', model: '', reasoning: 'high' },
    'choosing the CLI default model keeps the level',
  )
  store.setLastSelectedAgentModel({ cli: 'claude-code', model: 'claude-opus-5' })
  assert.deepEqual(
    lastAgentModel(),
    { cli: 'claude-code', model: 'claude-opus-5' },
    'switching CLI drops a level chosen for the previous CLI',
  )
  store.setLastSelectedAgentReasoning('codex', 'ultra')
  assert.deepEqual(
    lastAgentModel(),
    { cli: 'codex', model: '', reasoning: 'ultra' },
    'a level for another CLI starts that CLI on its own default model',
  )
  store.setLastSelectedAgentReasoning('codex', null)
  assert.equal(lastAgentModel(), null, 'clearing the only remaining choice leaves no empty selection behind')
  store.setLastSelectedAgentModel({ cli: 'codex', model: 'gpt-5.5' })
  store.setLastSelectedAgentReasoning('codex', 'xhigh')
  store.setLastSelectedAgentReasoning('codex', '   ')
  assert.deepEqual(lastAgentModel(), { cli: 'codex', model: 'gpt-5.5' }, 'clearing the level keeps the model')
  store.setLastSelectedAgentReasoning('codex', 'high')
  store.setLastSelectedAgentModel(null)
  assert.equal(lastAgentModel(), null, 'an explicit null clears the whole selection, level included')
  // Retiring a custom model id must retire it as a remembered launch default too:
  // a surface still naming it would pass `--model <deleted id>` and the agent dies
  // on a model nothing offers.
  store.setLastSelectedAgentModel({ cli: 'claude-code', model: 'fable-5.1' })
  store.forgetCliModels('codex', ['fable-5.1'])
  assert.deepEqual(
    lastAgentModel(),
    { cli: 'claude-code', model: 'fable-5.1' },
    'retiring the id on another CLI leaves this default untouched',
  )
  store.forgetCliModels('claude-code', ['fable-5.1'])
  assert.equal(lastAgentModel(), null, 'a default naming the retired id for that CLI falls back to the CLI default')
  store.setLastSelectedAgentModel({ cli: 'claude-code', model: 'fable-5.1' })
  store.setLastSelectedAgentReasoning('claude-code', 'high')
  store.forgetCliModels('claude-code', ['  fable-5.1  '])
  assert.deepEqual(
    lastAgentModel(),
    { cli: 'claude-code', model: '', reasoning: 'high' },
    'the level survives — it was chosen for the CLI, not for the model that went away',
  )
  store.forgetCliModels('claude-code', ['', '   '])
  assert.deepEqual(lastAgentModel(), { cli: 'claude-code', model: '', reasoning: 'high' }, 'a blank id forgets nothing')
  store.setLastSelectedAgentModel(null)

  store.setCommandKeybindings('commandPalette.open', ['Primary+Shift+P', 'CmdOrCtrl+Shift+P', 'Ctrl + +', 'bad-key'])
  assert.deepEqual(
    useWorkspaceStore.getState().appSettings.keybindings.overrides['commandPalette.open'],
    ['primary+shift+p', 'ctrl++'],
    'setCommandKeybindings normalizes and deduplicates overrides',
  )
  store.setCommandKeybindingDisabled('commandPalette.open', true)
  assert.equal(
    useWorkspaceStore.getState().appSettings.keybindings.disabled['commandPalette.open'],
    true,
    'setCommandKeybindingDisabled persists true flags',
  )
  store.setCommandKeybindingDisabled('commandPalette.open', false)
  assert.equal(
    useWorkspaceStore.getState().appSettings.keybindings.disabled['commandPalette.open'],
    undefined,
    're-enabling deletes the disabled flag',
  )
  store.setCommandKeybindingDisabled('retired.command', true)
  store.resetCommandKeybindings('commandPalette.open')
  assert.equal(
    useWorkspaceStore.getState().appSettings.keybindings.overrides['commandPalette.open'],
    undefined,
    'resetCommandKeybindings removes one command override',
  )
  assert.equal(
    useWorkspaceStore.getState().appSettings.keybindings.disabled['retired.command'],
    true,
    'resetCommandKeybindings leaves other command disabled flags alone',
  )
  store.resetAllKeybindings()
  assert.deepEqual(
    useWorkspaceStore.getState().appSettings.keybindings,
    { overrides: {}, disabled: {} },
    'resetAllKeybindings clears all persisted keybinding deltas',
  )

  // Writes through a migrated command id must clear state persisted under its
  // legacy id (LEGACY_COMMAND_ID_ALIASES), or the legacy-honoring read paths
  // resurrect it and e.g. a pre-rename disable can never be undone. No command
  // is migrating today, so a fixture alias stands in for one.
  LEGACY_COMMAND_ID_ALIASES['fixture-module.toggle'] = 'fixture.toggle'
  try {
    store.setCommandKeybindingDisabled('fixture.toggle', true)
    store.setCommandKeybindingDisabled('fixture-module.toggle', false)
    assert.equal(
      useWorkspaceStore.getState().appSettings.keybindings.disabled['fixture.toggle'],
      undefined,
      're-enabling under the current id clears a legacy-id disabled flag',
    )
    store.setCommandKeybindings('fixture.toggle', ['Primary+R'])
    store.setCommandKeybindings('fixture-module.toggle', ['Primary+Shift+R'])
    assert.equal(
      useWorkspaceStore.getState().appSettings.keybindings.overrides['fixture.toggle'],
      undefined,
      'overriding under the current id drops the legacy-id override',
    )
    store.setCommandKeybindings('fixture-module.toggle', [])
    assert.equal(
      useWorkspaceStore.getState().appSettings.keybindings.overrides['fixture-module.toggle'],
      undefined,
      'clearing under the current id removes its override',
    )
    store.setCommandKeybindings('fixture.toggle', ['Primary+R'])
    store.setCommandKeybindingDisabled('fixture.toggle', true)
    store.resetCommandKeybindings('fixture-module.toggle')
    assert.deepEqual(
      [
        useWorkspaceStore.getState().appSettings.keybindings.overrides['fixture.toggle'],
        useWorkspaceStore.getState().appSettings.keybindings.disabled['fixture.toggle'],
      ],
      [undefined, undefined],
      'resetCommandKeybindings clears legacy-id override and disabled flag',
    )
  } finally {
    delete LEGACY_COMMAND_ID_ALIASES['fixture-module.toggle']
  }

  // setCliRuntime on a plugin-id key (no bundled default) must NOT pin the command
  // to the plugin id when only its models are set; a blank command resolves
  // to the manifest binary at launch.
  store.setCliRuntime('opencode', { models: ['big-pickle'] })
  assert.deepEqual(
    useWorkspaceStore.getState().appSettings.cliRuntimes.opencode,
    { command: '', models: ['big-pickle'] },
    'plugin-id row defaults to a blank command, not the plugin id',
  )
  // A bundled key keeps its existing command default behavior.
  store.setCliRuntime('codex', { command: 'codex-x' })
  assert.equal(useWorkspaceStore.getState().appSettings.cliRuntimes.codex.command, 'codex-x')

  store.setSidebarCollapsed(true)
  assert.equal(useWorkspaceStore.getState().sidebarCollapsed, true)

  // --- Module settings namespace (contributed settings sections) --------------
  // Values live under `module:<id>` in appSettings.moduleSettings: real
  // persistence through the existing app-settings path, keyed so module values
  // can never collide with shell settings keys.
  assert.equal(moduleSettingsNamespace('demo-module'), 'module:demo-module')
  assert.deepEqual(
    normalizeModuleSettings({
      'module:demo-module': { greeting: 'hello', count: 2 },
      'module:': { dropped: true },
      'not-namespaced': { dropped: true },
      'module:bad-entry': 'not-an-object',
      'module:array-entry': ['dropped'],
    }),
    { 'module:demo-module': { greeting: 'hello', count: 2 } },
    'normalization keeps only namespaced object entries',
  )

  store.setModuleSettingValue('demo-module', 'greeting', 'hello')
  store.setModuleSettingValue('demo-module', 'count', 2)
  assert.deepEqual(
    useWorkspaceStore.getState().appSettings.moduleSettings['module:demo-module'],
    { greeting: 'hello', count: 2 },
    'setModuleSettingValue writes into the module namespace',
  )
  store.setModuleSettingValue('demo-module', 'greeting', undefined)
  assert.deepEqual(
    useWorkspaceStore.getState().appSettings.moduleSettings['module:demo-module'],
    { count: 2 },
    'undefined deletes the key',
  )
  // Module enablement is orthogonal to the namespace: disabling and re-enabling
  // the module never touches stored values, so they survive the cycle.
  store.setModuleEnabled('demo-module', false)
  store.setModuleEnabled('demo-module', true)
  assert.deepEqual(
    useWorkspaceStore.getState().appSettings.moduleSettings['module:demo-module'],
    { count: 2 },
    'module settings survive a disable/enable cycle',
  )
  // Round-trip through the persistence normalizer (what app restart replays).
  assert.deepEqual(
    normalizeAppSettings({ moduleSettings: useWorkspaceStore.getState().appSettings.moduleSettings }, [])
      .moduleSettings,
    { 'module:demo-module': { count: 2 } },
    'module settings survive the persisted-settings normalization round trip',
  )

  // --- Retired Design Wizard transport setting --------------------------------
  // The Design Wizard was deleted 2026-09-08 and its `guidedBriefConversationSessions`
  // opt-in went with it. A profile written by an older build still carries the key;
  // normalizeAppSettings rebuilds the blob from known fields, so it is dropped
  // rather than carried forward — the same treatment every other retired key gets.
  const staleTransportProfile = normalizeAppSettings(
    { guidedBriefConversationSessions: true, guidedBriefConversationSessionsOptInReset: true } as never,
    [],
  )
  assert.equal(
    'guidedBriefConversationSessions' in staleTransportProfile,
    false,
    'the retired Design Wizard transport opt-in is dropped at hydration',
  )
  assert.equal(
    'guidedBriefConversationSessionsOptInReset' in staleTransportProfile,
    false,
    'its one-time reset stamp is dropped with it',
  )

  // Appearance: windowMaterial is a second axis beside theme. A new install
  // opens on the comfortable chat column (owner ruling 2026-10-04).
  assert.deepEqual(defaultAppearanceSettings(), {
    theme: 'system',
    systemLightTheme: 'light',
    systemDarkTheme: 'dark',
    windowMaterial: 'glass',
    chatContrast: 100,
    chatWidth: 'comfortable',
    clockFormat: 'system',
    replyStreaming: 'live',
    agentCharacters: true,
    usageLimits: true,
    interfaceFont: '',
    codeFont: '',
  })
  assert.deepEqual(normalizeAppearanceSettings(undefined), defaultAppearanceSettings())
  assert.deepEqual(normalizeAppearanceSettings({ theme: 'sage', windowMaterial: 'glass' }), {
    theme: 'sage',
    systemLightTheme: 'light',
    systemDarkTheme: 'dark',
    windowMaterial: 'glass',
    chatContrast: 100,
    chatWidth: 'full',
    clockFormat: 'system',
    replyStreaming: 'live',
    agentCharacters: true,
    usageLimits: true,
    interfaceFont: '',
    codeFont: '',
  })
  assert.deepEqual(
    normalizeAppearanceSettings({ theme: 'sage', windowMaterial: 'tinted' }),
    {
      theme: 'sage',
      systemLightTheme: 'light',
      systemDarkTheme: 'dark',
      windowMaterial: 'tinted',
      chatContrast: 100,
      chatWidth: 'full',
      clockFormat: 'system',
      replyStreaming: 'live',
      agentCharacters: true,
      usageLimits: true,
      interfaceFont: '',
      codeFont: '',
    },
    'tinted is a stored material in its own right',
  )
  assert.deepEqual(
    normalizeAppearanceSettings({ theme: 'sage' }),
    {
      theme: 'sage',
      systemLightTheme: 'light',
      systemDarkTheme: 'dark',
      windowMaterial: 'glass',
      chatContrast: 100,
      chatWidth: 'full',
      clockFormat: 'system',
      replyStreaming: 'live',
      agentCharacters: true,
      usageLimits: true,
      interfaceFont: '',
      codeFont: '',
    },
    'a persisted appearance predating the material axis hydrates to the glass default',
  )
  assert.equal(
    normalizeAppearanceSettings({ theme: 'sage', replyStreaming: 'paragraph' }).replyStreaming,
    'paragraph',
    'replies a paragraph at a time is kept',
  )
  assert.equal(
    normalizeAppearanceSettings({ theme: 'sage', replyStreaming: 'turn' }).replyStreaming,
    'live',
    'a mode no version wrote falls back to replies as they are written',
  )
  assert.equal(
    normalizeAppearanceSettings({ theme: 'sage', agentCharacters: false }).agentCharacters,
    false,
    'turning the characters off is kept',
  )
  assert.equal(
    normalizeAppearanceSettings({ theme: 'sage', agentCharacters: 'no' }).agentCharacters,
    true,
    'a malformed value falls back to characters on',
  )
  assert.equal(
    normalizeAppearanceSettings({ theme: 'sage', usageLimits: false }).usageLimits,
    false,
    'hiding the usage limits is kept',
  )
  assert.equal(
    normalizeAppearanceSettings({ theme: 'sage' }).usageLimits,
    true,
    'a stored appearance from before the setting shows them',
  )
  assert.deepEqual(
    normalizeAppearanceSettings({ theme: 'nope', windowMaterial: 'frosted' }),
    // A stored appearance with no width predates the setting: it reads as the
    // full width it had, not the new install's default.
    { ...defaultAppearanceSettings(), chatWidth: 'full' },
    'unknown theme and material values both fall back to defaults',
  )

  // --- Retired onboarding wizard: the migration off `onboardingStep` -----------
  // These are the acceptance guard for "an upgrade never sees the first-run card".
  // The wizard's two persisted signals are read here, once, and converted into one
  // boolean; getting this wrong asks a five-year user to set up their agent CLI.
  {
    const someWorkspace = [{ id: 'w1' } as unknown as Workspace]

    assert.equal(
      normalizeAppSettings(undefined, []).firstRunCliCardDismissed,
      false,
      'a genuinely fresh profile has not dismissed anything',
    )
    assert.equal(
      normalizeAppSettings({}, someWorkspace).firstRunCliCardDismissed,
      true,
      'a profile with workspaces was already in use — never ask it',
    )
    assert.equal(
      normalizeAppSettings({ modulesChosen: true }, []).firstRunCliCardDismissed,
      true,
      'the legacy modulesChosen signal marks a returning profile',
    )
    assert.equal(
      normalizeAppSettings({ onboardingStep: 'complete' } as never, []).firstRunCliCardDismissed,
      true,
      'a profile that finished the wizard is a returning profile',
    )
    assert.equal(
      normalizeAppSettings({ onboardingStep: 'modules' } as never, []).firstRunCliCardDismissed,
      true,
      'a profile part-way through the wizard was already in use',
    )
    // The deliberate exception: this profile installed the app, saw the very first
    // screen, quit, and upgraded. It never used anything — it is the fresh user
    // the card exists for, and treating it as returning would hide the card from
    // exactly the person who needs it.
    assert.equal(
      normalizeAppSettings({ onboardingStep: 'welcome' } as never, []).firstRunCliCardDismissed,
      false,
      'a profile parked at welcome with no workspaces is fresh, not returning',
    )
    // An explicit persisted value always wins, in both directions.
    assert.equal(normalizeAppSettings({ firstRunCliCardDismissed: true }, []).firstRunCliCardDismissed, true)
    assert.equal(
      normalizeAppSettings({ firstRunCliCardDismissed: false }, someWorkspace).firstRunCliCardDismissed,
      false,
      'a user who has not dismissed the card keeps not having dismissed it',
    )

    // Adoption is offered once. An existing install already had its chance through
    // the wizard's card, so it is never re-run against their project.
    assert.equal(normalizeAppSettings(undefined, []).hasAdoptedAgentConfig, false)
    assert.equal(normalizeAppSettings({}, someWorkspace).hasAdoptedAgentConfig, true)
    assert.equal(
      normalizeAppSettings({ hasAdoptedAgentConfig: false }, someWorkspace).hasAdoptedAgentConfig,
      false,
      'an explicit persisted value wins over the returning-profile default',
    )
  }

  // normalizeSelectedCli: hooks-only selectability at READ time — a persisted
  // selection naming a CLI that is not agent-selectable (muse, generic-shell)
  // normalizes to the fallback here, so every picker shows the real default
  // before any spawn instead of a spawn-time silent swap. Unknown ids pass
  // (a user plugin may be eligible; the catalog owns that question).
  assert.equal(normalizeSelectedCli('claude-code'), 'claude-code')
  assert.equal(normalizeSelectedCli('some-user-cli'), 'some-user-cli')
  assert.equal(normalizeSelectedCli('muse'), 'claude-code', 'a non-selectable persisted CLI normalizes to the default')
  assert.equal(normalizeSelectedCli('generic-shell'), 'claude-code')
  assert.equal(normalizeSelectedCli('muse', 'codex'), 'codex', 'the caller fallback wins when eligible')
  assert.equal(
    normalizeSelectedCli('muse', 'generic-shell'),
    'claude-code',
    'an ineligible fallback falls to the stock default',
  )
  assert.equal(normalizeSelectedCli(null), 'claude-code')

  // Sync's own writer. Adding a server is a person wiring something up, and
  // `upsertMcpServer` turns MCP config sync on for them; refreshing a server they
  // already have is not, so pressing Sync on a source must not re-enable a
  // setting they deliberately turned off
  // (backlog/2026-09-06-mcp-installs-carry-source-provenance.md).
  {
    const server = {
      id: 'context7',
      name: 'Context7',
      transport: 'stdio' as const,
      command: 'npx',
      args: ['-y', '@upstash/context7-mcp'],
      enabled: true,
      clients: ['codex'],
      scope: 'workspace' as const,
      source: 'source' as const,
      sourceRef: { sourceId: 'github:acme/plugins', itemId: 'context7', commitSha: 'b81f77a' },
      riskLevel: 'local-command' as const,
    }
    const mcpStore = useWorkspaceStore.getState()
    mcpStore.setMcpSyncEnabled(false)
    mcpStore.refreshMcpServersFromSource([server])
    const after = useWorkspaceStore.getState().appSettings.mcp
    assert.equal(after?.syncEnabled, false, 'a refresh leaves MCP config sync exactly as they set it')
    assert.equal(after?.servers.context7?.command, 'npx')
    assert.deepEqual(after?.servers.context7?.sourceRef, server.sourceRef, 'and the provenance survives the write')

    useWorkspaceStore.getState().upsertMcpServer({ ...server, id: 'added-by-hand' })
    assert.equal(
      useWorkspaceStore.getState().appSettings.mcp?.syncEnabled,
      true,
      'while adding one still means "wire this up"',
    )
  }

  // Model-written chat titles. The setting is on by default — the
  // heuristic title is the fallback for a person with this off or with no
  // supported CLI installed, so nothing is lost by starting it on — and the
  // engine choice is a separate axis that survives an off.
  {
    assert.deepEqual(normalizeTextGenerationSettings(undefined), {
      enabled: true,
      engine: null,
      writingStyle: MATCH_REPOSITORY,
    })
    assert.deepEqual(normalizeTextGenerationSettings(null), {
      enabled: true,
      engine: null,
      writingStyle: MATCH_REPOSITORY,
    })
    assert.deepEqual(normalizeTextGenerationSettings({}), {
      enabled: true,
      engine: null,
      writingStyle: MATCH_REPOSITORY,
    })
    assert.deepEqual(
      normalizeTextGenerationSettings({ enabled: false }),
      { enabled: false, engine: null, writingStyle: MATCH_REPOSITORY },
      'an explicit off is kept — only a missing value defaults to on',
    )
    assert.equal(
      normalizeTextGenerationSettings({ enabled: false, engine: { cli: 'codex', model: 'gpt-5.6-luna' } }).enabled,
      false,
    )

    // An engine with no CLI is nothing: a stray level or model without the CLI
    // that would run it cannot name an engine.
    assert.equal(normalizeTextGenerationSettings({ engine: { cli: '   ', model: 'gpt-5.6-luna' } }).engine, null)
    assert.equal(normalizeTextGenerationSettings({ engine: { model: 'gpt-5.6-luna' } as never }).engine, null)
    assert.equal(normalizeTextGenerationSettings({ engine: 'codex' as never }).engine, null)

    // A CLI with an empty model is a real setting: that CLI at its default model.
    assert.deepEqual(normalizeTextGenerationSettings({ engine: { cli: 'codex', model: '' } }).engine, {
      cli: 'codex',
      model: '',
    })

    assert.deepEqual(
      normalizeTextGenerationSettings({
        engine: { cli: '  codex  ', model: '  gpt-5.6-luna  ', reasoning: '  low  ' },
      }).engine,
      { cli: 'codex', model: 'gpt-5.6-luna', reasoning: 'low' },
      'every field is trimmed',
    )

    // Reasoning is optional, and an empty level is absent rather than stored as
    // an empty string — an empty string would be forwarded as a flag with no value.
    assert.deepEqual(
      normalizeTextGenerationSettings({ engine: { cli: 'codex', model: 'gpt-5.6-luna', reasoning: '   ' } }).engine,
      { cli: 'codex', model: 'gpt-5.6-luna' },
    )
    assert.equal(
      'reasoning' in
        (normalizeTextGenerationSettings({ engine: { cli: 'codex', model: 'gpt-5.6-luna', reasoning: '' } }).engine ??
          {}),
      false,
    )

    // And the key is always present after the whole-settings normalizer, so a
    // profile persisted before this shipped reads as "on, nothing chosen".
    assert.deepEqual(defaultAppSettings().textGeneration, {
      enabled: true,
      engine: null,
      writingStyle: MATCH_REPOSITORY,
    })
    assert.deepEqual(normalizeAppSettings(undefined, []).textGeneration, {
      enabled: true,
      engine: null,
      writingStyle: MATCH_REPOSITORY,
    })
    assert.deepEqual(normalizeAppSettings({}, []).textGeneration, {
      enabled: true,
      engine: null,
      writingStyle: MATCH_REPOSITORY,
    })
    assert.deepEqual(
      normalizeAppSettings({ textGeneration: { enabled: false, engine: { cli: 'codex', model: '' } } } as never, [])
        .textGeneration,
      { enabled: false, engine: { cli: 'codex', model: '' }, writingStyle: MATCH_REPOSITORY },
    )

    // --- the two writers -----------------------------------------------------

    const textGeneration = (): ReturnType<typeof defaultAppSettings>['textGeneration'] =>
      useWorkspaceStore.getState().appSettings.textGeneration

    useWorkspaceStore.getState().setTextGenerationEngine({ cli: 'codex', model: '  gpt-5.6-luna  ', reasoning: 'high' })
    assert.deepEqual(textGeneration()?.engine, { cli: 'codex', model: 'gpt-5.6-luna', reasoning: 'high' })

    // Turning titles off must not make them pick their CLI again when they
    // turn it back on.
    useWorkspaceStore.getState().setTextGenerationEnabled(false)
    assert.equal(textGeneration()?.enabled, false)
    assert.deepEqual(textGeneration()?.engine, { cli: 'codex', model: 'gpt-5.6-luna', reasoning: 'high' })
    useWorkspaceStore.getState().setTextGenerationEnabled(true)
    assert.equal(textGeneration()?.enabled, true)
    assert.deepEqual(
      textGeneration()?.engine,
      { cli: 'codex', model: 'gpt-5.6-luna', reasoning: 'high' },
      'the engine survives the round trip through off',
    )

    // The same effort rule as setLastSelectedAgentModel: a level outlives a model
    // change inside the CLI...
    useWorkspaceStore.getState().setTextGenerationEngine({ cli: 'codex', model: 'gpt-5.1-codex-mini' })
    assert.deepEqual(textGeneration()?.engine, { cli: 'codex', model: 'gpt-5.1-codex-mini', reasoning: 'high' })

    // ...and is dropped when the CLI changes, because levels do not carry across.
    useWorkspaceStore.getState().setTextGenerationEngine({ cli: 'claude-code', model: 'claude-haiku-4-5' })
    assert.deepEqual(textGeneration()?.engine, { cli: 'claude-code', model: 'claude-haiku-4-5' })

    // An explicit level always wins over whatever was stored.
    useWorkspaceStore
      .getState()
      .setTextGenerationEngine({ cli: 'claude-code', model: 'claude-haiku-4-5', reasoning: 'low' })
    assert.deepEqual(textGeneration()?.engine, { cli: 'claude-code', model: 'claude-haiku-4-5', reasoning: 'low' })
    useWorkspaceStore
      .getState()
      .setTextGenerationEngine({ cli: 'claude-code', model: 'claude-haiku-4-5', reasoning: 'medium' })
    assert.deepEqual(textGeneration()?.engine, { cli: 'claude-code', model: 'claude-haiku-4-5', reasoning: 'medium' })

    // null is "whichever supported CLI is installed, at its default" — not off.
    useWorkspaceStore.getState().setTextGenerationEngine(null)
    assert.deepEqual(textGeneration(), { enabled: true, engine: null, writingStyle: MATCH_REPOSITORY })
    useWorkspaceStore.getState().setTextGenerationEnabled(false)
    useWorkspaceStore.getState().setTextGenerationEngine(null)
    assert.deepEqual(
      textGeneration(),
      { enabled: false, engine: null, writingStyle: MATCH_REPOSITORY },
      'clearing the engine leaves enabled alone',
    )
    useWorkspaceStore.getState().setTextGenerationEnabled(true)
  }

  // ── The Design door's per-bundle visit stamps ───────────────────────────────
  //
  // `designSystemSeen` is what the door's "New" marker is measured against, so
  // every way this map can go wrong deletes or fabricates a marker the person
  // cannot check against anything.
  {
    // Absent, and every non-map shape, reads as "nothing opened yet" rather than
    // throwing or carrying a shape the door would index into.
    assert.deepEqual(defaultAppSettings().designSystemSeen, {})
    assert.deepEqual(normalizeAppSettings(undefined, []).designSystemSeen, {})
    assert.deepEqual(normalizeAppSettings({}, []).designSystemSeen, {})
    assert.deepEqual(normalizeDesignSystemSeen(undefined), {})
    assert.deepEqual(normalizeDesignSystemSeen(null), {})
    assert.deepEqual(normalizeDesignSystemSeen('2026-09-08T00:00:00.000Z'), {})
    assert.deepEqual(normalizeDesignSystemSeen([['lib:/a', '2026-09-08T00:00:00.000Z']]), {})

    // A stamp that is not a parseable date is DROPPED, not carried. Carrying it
    // would read as "seen at an unknown time", and the rule's fallback for an
    // unreadable stamp is "never seen" — which re-announces a whole system.
    assert.deepEqual(
      normalizeDesignSystemSeen({
        'lib:/work/brand': '2026-09-08T10:00:00.000Z',
        'lib:/work/broken': 'last Tuesday',
        'lib:/work/wrong-type': 1757000000000,
        '': '2026-09-08T10:00:00.000Z',
        '   ': '2026-09-08T10:00:00.000Z',
      }),
      { 'lib:/work/brand': '2026-09-08T10:00:00.000Z' },
    )

    // The map is bounded, and it is the OLDEST visits that go: the bundle nobody
    // has opened in years is the one whose stamp costs least to lose.
    const many: Record<string, string> = {}
    for (let index = 0; index < 260; index += 1) {
      many[`lib:/work/system-${index}`] = new Date(Date.UTC(2020, 0, 1) + index * 86_400_000).toISOString()
    }
    const trimmed = normalizeDesignSystemSeen(many)
    assert.equal(Object.keys(trimmed).length, 200, 'trimmed to the cap')
    assert.ok(trimmed['lib:/work/system-259'], 'the most recent visit survives')
    assert.equal(trimmed['lib:/work/system-0'], undefined, 'the oldest went first')
    assert.equal(Object.keys(normalizeAppSettings({ designSystemSeen: many }, []).designSystemSeen).length, 200)

    // --- the writer ----------------------------------------------------------

    const seen = (): Record<string, string> => useWorkspaceStore.getState().appSettings.designSystemSeen

    useWorkspaceStore.getState().markDesignSystemSeen('lib:/work/brand', '2026-09-08T10:00:00.000Z')
    assert.equal(seen()['lib:/work/brand'], '2026-09-08T10:00:00.000Z')

    // Re-visiting moves the stamp forward; it never accumulates a second key.
    useWorkspaceStore.getState().markDesignSystemSeen('lib:/work/brand', '2026-09-09T10:00:00.000Z')
    assert.deepEqual(seen(), { 'lib:/work/brand': '2026-09-09T10:00:00.000Z' })

    // No stamp given means now, and a bad one is treated the same rather than
    // being written through as an unreadable value.
    useWorkspaceStore.getState().markDesignSystemSeen('lib:/work/other')
    assert.ok(Date.now() - Date.parse(seen()['lib:/work/other']) < 60_000)
    useWorkspaceStore.getState().markDesignSystemSeen('lib:/work/other', 'whenever')
    assert.ok(Date.now() - Date.parse(seen()['lib:/work/other']) < 60_000)

    // An empty id is not a bundle, so it writes nothing at all.
    const before = seen()
    useWorkspaceStore.getState().markDesignSystemSeen('   ')
    assert.deepEqual(seen(), before)
  }

  // ── One colour per project ─────────────────────────────────────────────────
  //
  // `projectColors` holds only the overrides a person chose; the hue itself is
  // hashed from the project's key (utils/projectColor). So the ways it can go
  // wrong are a map that comes back wrong from disk, and a writer that stores
  // something the glyph cannot draw.
  {
    // --- the reader -----------------------------------------------------------

    // A profile that predates the setting has no overrides, not a crash and not a
    // shape the glyph would index into.
    assert.deepEqual(defaultAppSettings().projectColors, {})
    assert.deepEqual(normalizeAppSettings(undefined, []).projectColors, {})
    assert.deepEqual(normalizeAppSettings({}, []).projectColors, {})
    assert.deepEqual(normalizeProjectColors(undefined), {})
    assert.deepEqual(normalizeProjectColors(null), {})
    assert.deepEqual(normalizeProjectColors(120), {})
    assert.deepEqual(normalizeProjectColors([['repo:a', 120]]), {})

    // Every value that is not a whole-degree hue or `'none'` is DROPPED rather
    // than carried into the style the glyph draws with.
    const corrupt = {
      'repo:fraction': 12.5,
      'repo:negative': -1,
      'repo:full-turn': 360,
      'repo:nan': Number.NaN,
      'repo:string-number': '120',
      'repo:null': null,
      'repo:array': [120],
      'repo:object': { hue: 120 },
      '': 120,
      '   ': 'none',
      'repo:kept': 120,
      'repo:zero': 0,
      'repo:declined': 'none',
    }
    const kept = { 'repo:kept': 120, 'repo:zero': 0, 'repo:declined': 'none' }
    assert.deepEqual(normalizeProjectColors(corrupt), kept)
    assert.deepEqual(normalizeAppSettings({ projectColors: corrupt as never }, []).projectColors, kept)

    // A settings file from the 2026-09-09 build stored hue NAMES — first-come
    // picks, indistinguishable from a person's choice. They are dropped, so every
    // one of those projects returns to its hashed hue: the same colour on every
    // machine, which a kept pick never could be (owner, 2026-09-11). A "No
    // colour" from that build is still a choice, and survives.
    assert.deepEqual(
      normalizeAppSettings(
        {
          projectColors: {
            'repo:github.com/acme/sprintengine': 'blue',
            'folder:/notes': 'teal',
            'repo:logo': 'none',
          } as never,
        },
        [],
      ).projectColors,
      { 'repo:logo': 'none' },
    )

    // Unlike the knowledge roots beside it, the map is NOT pruned against the open
    // workspaces: a person's choice has to survive closing every chat in it.
    assert.deepEqual(normalizeAppSettings({ projectColors: { 'repo:closed': 300 } }, []).projectColors, {
      'repo:closed': 300,
    })

    // --- the writer -----------------------------------------------------------

    const colors = (): Record<string, ProjectColorSetting> => useWorkspaceStore.getState().appSettings.projectColors

    // The person picking a colour writes it through; picking the same one again
    // writes nothing — not an equal object, the same one.
    useWorkspaceStore.getState().setProjectColor('repo:picked', 300)
    assert.equal(colors()['repo:picked'], 300)
    const afterPick = colors()
    useWorkspaceStore.getState().setProjectColor('repo:picked', 300)
    assert.equal(colors(), afterPick, 'the same choice twice is one write')

    // "No colour" is stored as such; null ("Automatic") deletes the entry, which
    // returns the project to its hashed hue rather than to "none".
    useWorkspaceStore.getState().setProjectColor('repo:picked', 'none')
    assert.equal(colors()['repo:picked'], 'none')
    useWorkspaceStore.getState().setProjectColor('repo:picked', null)
    assert.equal(Object.hasOwn(colors(), 'repo:picked'), false, 'null deletes rather than storing none')

    // Nothing the glyph cannot draw gets in through the writer either.
    const beforeJunk = colors()
    useWorkspaceStore.getState().setProjectColor('repo:bad', 360 as never)
    useWorkspaceStore.getState().setProjectColor('repo:bad', 'blue' as never)
    assert.equal(colors(), beforeJunk, 'an out-of-range hue or a legacy name is not written')

    // An empty key is not a project, and deleting one that was never there is not
    // a write.
    const settled = colors()
    useWorkspaceStore.getState().setProjectColor('   ', 120)
    useWorkspaceStore.getState().setProjectColor('repo:never-seen', null)
    assert.equal(colors(), settled)
  }

  console.log('settingsSlice.test.ts: ok')
})

test('a discovered row keeps its firstSeenAt only as a parseable timestamp', () => {
  assert.deepEqual(
    normalizeCliModelCatalogs({
      codex: {
        models: [
          { id: 'gpt-6-astra', firstSeenAt: '2026-09-22T10:00:00.000Z' },
          { id: 'gpt-6-sol', firstSeenAt: 'last tuesday' },
          { id: 'gpt-6-luna', firstSeenAt: 1_790_000_000_000 },
          { id: 'gpt-5.5' },
        ],
        fetchedAt: '2026-09-22T10:00:00.000Z',
        source: 'argv-probe',
      },
    }),
    {
      codex: {
        models: [
          { id: 'gpt-6-astra', firstSeenAt: '2026-09-22T10:00:00.000Z' },
          { id: 'gpt-6-sol' },
          { id: 'gpt-6-luna' },
          { id: 'gpt-5.5' },
        ],
        fetchedAt: '2026-09-22T10:00:00.000Z',
        source: 'argv-probe',
      },
    },
  )
})

test('a remembered model survives a refresh that stops listing it', () => {
  // The CLI's list is the picker's list, but a choice the person already made
  // keeps launching: a CLI may accept an id it does not advertise. Only an
  // explicit removal of their own id forgets it (forgetCliModels, above).
  const store = useWorkspaceStore.getState()
  store.setCliModelCatalog('codex', {
    models: [{ id: 'gpt-5.5' }, { id: 'gpt-5.6' }],
    fetchedAt: '2026-09-21T00:00:00Z',
    source: 'argv-probe',
  })
  store.setLastSelectedAgentModel({ cli: 'codex', model: 'gpt-5.5', reasoning: 'high' })
  store.setCliModelCatalog('codex', {
    models: [{ id: 'gpt-5.6' }],
    fetchedAt: '2026-09-22T00:00:00Z',
    source: 'argv-probe',
  })
  assert.deepEqual(useWorkspaceStore.getState().appSettings.lastSelectedAgentModel, {
    cli: 'codex',
    model: 'gpt-5.5',
    reasoning: 'high',
  })
  store.setLastSelectedAgentModel(null)
  store.setCliModelCatalog('codex', null)
})

test('a stored appearance from before the chat settings hydrates to the chat as it was', () => {
  assert.deepEqual(normalizeAppearanceSettings({ theme: 'light', windowMaterial: 'solid' }), {
    theme: 'light',
    systemLightTheme: 'light',
    systemDarkTheme: 'dark',
    windowMaterial: 'solid',
    chatContrast: 100,
    chatWidth: 'full',
    clockFormat: 'system',
    replyStreaming: 'live',
    agentCharacters: true,
    usageLimits: true,
    interfaceFont: '',
    codeFont: '',
  })
})

test('chat contrast is clamped to its ramp and snapped to a step', () => {
  const contrast = (value: unknown) => normalizeAppearanceSettings({ chatContrast: value }).chatContrast
  assert.equal(contrast(135), 135)
  assert.equal(contrast(132), 130)
  assert.equal(contrast(10), 85)
  assert.equal(contrast(500), 200)
  assert.equal(contrast(Number.NaN), 100)
  assert.equal(contrast('140'), 100)
})

test('an unknown chat width falls back to full', () => {
  assert.equal(normalizeAppearanceSettings({ chatWidth: 'wide' }).chatWidth, 'wide')
  assert.equal(normalizeAppearanceSettings({ chatWidth: 'narrow' }).chatWidth, 'full')
})

test('a new install opens on the comfortable chat column, and a stored width is kept', () => {
  assert.equal(normalizeAppearanceSettings(undefined).chatWidth, 'comfortable', 'nothing stored is a new install')
  assert.equal(normalizeAppearanceSettings({ chatWidth: 'full' }).chatWidth, 'full', 'a width the person holds stays')
  assert.equal(normalizeAppearanceSettings({ chatWidth: 'wide' }).chatWidth, 'wide')
})

test('the chat appearance setters store normalised values', () => {
  const store = useWorkspaceStore.getState()
  store.setAppearanceChatContrast(163)
  assert.equal(useWorkspaceStore.getState().appSettings.appearance.chatContrast, 165)
  store.setAppearanceChatWidth('comfortable')
  assert.equal(useWorkspaceStore.getState().appSettings.appearance.chatWidth, 'comfortable')
  store.setAppearanceChatContrast(100)
  store.setAppearanceChatWidth('full')
})

test('a stored appearance from before the font settings reads as the bundled faces', () => {
  const appearance = normalizeAppearanceSettings({ theme: 'light', windowMaterial: 'solid', chatWidth: 'wide' })
  assert.equal(appearance.interfaceFont, '')
  assert.equal(appearance.codeFont, '')
})

test('a stored font family is kept, and one that is not a string is the default', () => {
  const appearance = normalizeAppearanceSettings({ interfaceFont: 'IBM Plex Sans', codeFont: 'Fira Code, Menlo' })
  assert.equal(appearance.interfaceFont, 'IBM Plex Sans')
  assert.equal(appearance.codeFont, 'Fira Code, Menlo')
  assert.equal(normalizeAppearanceSettings({ interfaceFont: 42, codeFont: null }).interfaceFont, '')
  assert.equal(normalizeAppearanceSettings({ interfaceFont: 42, codeFont: null }).codeFont, '')
})

test('a stored font family that could break out of CSS is cleaned on the way in', () => {
  assert.equal(
    normalizeAppearanceSettings({ codeFont: 'Fira"; } body { color: red; } /*' }).codeFont,
    'Fira body color: red /*',
  )
  assert.equal(normalizeAppearanceSettings({ interfaceFont: 'x'.repeat(500) }).interfaceFont.length, 200)
})

test('the font setters store cleaned values, and the empty string restores the default', () => {
  const store = useWorkspaceStore.getState()
  const appearance = () => useWorkspaceStore.getState().appSettings.appearance
  store.setAppearanceInterfaceFont('  Source   Sans 3 ')
  assert.equal(appearance().interfaceFont, 'Source Sans 3')
  store.setAppearanceCodeFont('<Iosevka>')
  assert.equal(appearance().codeFont, 'Iosevka')
  store.setAppearanceInterfaceFont('')
  store.setAppearanceCodeFont('')
  assert.equal(appearance().interfaceFont, '')
  assert.equal(appearance().codeFont, '')
})

test('the writing style for drafted commits and pull requests is set one part at a time', () => {
  const store = useWorkspaceStore.getState()
  const style = () => useWorkspaceStore.getState().appSettings.textGeneration.writingStyle
  store.setTextGenerationWritingStyle({ mode: 'custom', instructions: 'Past tense.' })
  assert.deepEqual(style(), { mode: 'custom', instructions: 'Past tense.' })
  // Switching away keeps the guide, so switching back finds it.
  store.setTextGenerationWritingStyle({ mode: 'conventional' })
  assert.deepEqual(style(), { mode: 'conventional', instructions: 'Past tense.' })
  store.setTextGenerationWritingStyle({ mode: 'nonsense' as never, instructions: 'x'.repeat(2_100) })
  assert.equal(style().mode, 'repository', 'an unknown mode is the default')
  assert.equal(style().instructions.length, 2_000, 'an oversized guide is cut to its bound')
  store.setTextGenerationWritingStyle({ instructions: '' })
  assert.deepEqual(style(), MATCH_REPOSITORY)
})

test('a persisted style is read back, and an unreadable one is the default', () => {
  assert.deepEqual(
    normalizeAppSettings({ textGeneration: { writingStyle: { mode: 'custom', instructions: 'Short.' } } } as never, [])
      .textGeneration.writingStyle,
    { mode: 'custom', instructions: 'Short.' },
  )
  assert.deepEqual(
    normalizeAppSettings({ textGeneration: { writingStyle: { mode: 'yaml' } } } as never, []).textGeneration
      .writingStyle,
    MATCH_REPOSITORY,
  )
})

test('a new install queues a message sent mid-turn', () => {
  assert.equal(defaultAppSettings().followUpBehavior, 'queue')
  assert.equal(normalizeAppSettings(undefined, []).followUpBehavior, 'queue')
})

test('a profile from before the follow-up choice keeps queueing, and a stored choice is kept', () => {
  const stored = (followUpBehavior: unknown) =>
    normalizeAppSettings({ followUpBehavior } as unknown as Partial<AppSettings>, []).followUpBehavior
  assert.equal(stored(undefined), 'queue', 'a profile without the key queues, as its Enter always did')
  assert.equal(stored('steer'), 'steer')
  assert.equal(stored('queue'), 'queue')
  assert.equal(stored('interrupt'), 'queue', 'an unknown choice queues rather than steers')
  assert.equal(stored(true), 'queue')
})

test('the follow-up setter stores the choice, and only a steer steers', () => {
  const store = useWorkspaceStore.getState()
  store.setFollowUpBehavior('steer')
  assert.equal(useWorkspaceStore.getState().appSettings.followUpBehavior, 'steer')
  store.setFollowUpBehavior('sometimes' as unknown as 'queue')
  assert.equal(useWorkspaceStore.getState().appSettings.followUpBehavior, 'queue')
})

test('chats with an open pull request are kept from the idle rule unless the person turned it off', () => {
  assert.equal(normalizeAppSettings(undefined, []).keepChatsWithOpenPullRequest, true, 'a new install keeps them')
  assert.equal(
    normalizeAppSettings({ settleOnPullRequestMerge: false } as Partial<AppSettings>, []).keepChatsWithOpenPullRequest,
    true,
    'a profile from before the setting keeps them',
  )
  assert.equal(
    normalizeAppSettings({ keepChatsWithOpenPullRequest: false } as Partial<AppSettings>, [])
      .keepChatsWithOpenPullRequest,
    false,
  )
})

test('a project icon is stored by folder, validated, and null returns it to detection', () => {
  const icons = () => useWorkspaceStore.getState().appSettings.projectIcons ?? {}
  const { setProjectIcon } = useWorkspaceStore.getState()

  setProjectIcon('/Users/dev/app/', { kind: 'monogram', text: 'MA', hue: 255 })
  const key = Object.keys(icons()).find((k) => icons()[k].kind === 'monogram')
  assert.ok(key, 'the monogram was stored')
  // Keyed by the normalised folder, so a trailing slash is the same project.
  setProjectIcon('/Users/dev/app', { kind: 'file', path: '/Users/dev/art/mark.svg' })
  assert.deepEqual(icons()[key], { kind: 'file', path: '/Users/dev/art/mark.svg' })

  const before = icons()
  setProjectIcon('/Users/dev/app', { kind: 'monogram', text: 'abc', hue: 255 } as never)
  setProjectIcon('   ', { kind: 'monogram', text: 'X', hue: 25 })
  assert.equal(icons(), before, 'a malformed icon or an empty folder is not written')

  setProjectIcon('/Users/dev/app', null)
  assert.equal(Object.hasOwn(icons(), key), false)
})
