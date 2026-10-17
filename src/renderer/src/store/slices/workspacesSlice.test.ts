import assert from 'node:assert/strict'

import type { LayoutTemplate, Workspace, WorkspaceWindowState } from '../../types/workspace'
import { getEditorBuffer } from '../../utils/editorBuffers'
import { useWorkspaceStore } from '../workspaceStore'
import { applySoloChatSeed, normalizeWorkspaceMode, workspaceFolderKey } from './workspacesSlice'
import { test } from 'vitest'

/** Every agent id a layout's tabs name, in layout order. */
function layoutAgentIds(layout: unknown): string[] {
  return [...JSON.stringify(layout).matchAll(/"agentId":"([^"]+)"/g)].map((match) => match[1]!)
}

test('workspacesSlice', async () => {
  const standardTemplate: LayoutTemplate = {
    id: 'standard-test',
    name: 'Standard',
    description: 'Standard workspace test template',
    previewSlots: [],
    layout: {
      global: { tabSetEnableDrop: true, tabEnableClose: false },
      borders: [],
      layout: {
        type: 'row',
        children: [
          {
            type: 'tabset',
            weight: 100,
            children: [{ type: 'tab', name: 'Editor', component: 'editor' }],
          },
        ],
      },
    },
  }

  const soloDevTemplate: LayoutTemplate = {
    ...standardTemplate,
    id: 'solo-dev-test',
    name: 'Solo Dev',
    layout: {
      global: { tabSetEnableDrop: true, tabEnableClose: true },
      borders: [],
      layout: {
        type: 'row',
        children: [
          {
            type: 'tabset',
            weight: 100,
            children: [{ type: 'tab', name: 'Agent', component: 'agent', config: { agentId: 'agent-1' } }],
          },
        ],
      },
    },
  }

  assert.equal(workspaceFolderKey(' /Users/example/project/ '), '/users/example/project')
  const legacyPersistedWorkspace = {
    id: 'workspace-with-plugin-mode',
    mode: 'future-plugin-mode',
  }
  assert.equal(normalizeWorkspaceMode(legacyPersistedWorkspace.mode), 'future-plugin-mode')
  assert.equal(normalizeWorkspaceMode('  future-plugin-mode  '), '  future-plugin-mode  ')
  assert.equal(normalizeWorkspaceMode('weather-deck'), 'weather-deck')
  assert.equal(normalizeWorkspaceMode(''), 'standard')
  assert.equal(normalizeWorkspaceMode('   '), 'standard')
  assert.equal(normalizeWorkspaceMode(null), 'standard')
  assert.equal(normalizeWorkspaceMode(undefined), 'standard')

  const store = useWorkspaceStore.getState()
  const firstId = store.addWorkspace(standardTemplate, {
    name: ' First Workspace ',
    folderPath: '/Users/example/project',
  })
  const secondId = useWorkspaceStore.getState().addWorkspace(standardTemplate, {
    name: 'Second Workspace',
    folderPath: '/Users/example/other',
  })
  const soloDevId = useWorkspaceStore.getState().addWorkspace(soloDevTemplate, {
    name: 'Solo Dev Workspace',
    folderPath: '/Users/example/solo-dev',
  })

  let state = useWorkspaceStore.getState()
  assert.equal(state.activeWorkspaceId, soloDevId)
  // New workspaces insert at the head of their folder block; each of these three
  // lives in a distinct folder, so the newest-created sorts to the top.
  assert.deepEqual(
    state.workspaces.map((workspace) => workspace.id),
    [soloDevId, secondId, firstId],
  )
  assert.equal(state.workspaces.find((workspace) => workspace.id === firstId)?.name, 'First Workspace')
  assert.deepEqual(
    state.workspaces.find((workspace) => workspace.id === firstId)?.fileExplorerState,
    { expandedPaths: [], selectedPath: null },
    'new workspaces start with empty File Explorer expansion state',
  )
  assert.deepEqual(state.appSettings.recentWorkspaceFolders, [
    '/Users/example/solo-dev',
    '/Users/example/other',
    '/Users/example/project',
  ])
  // The template's `agent-1` is a placeholder: the workspace's agent takes an
  // id of its own, and the layout's tab names that id.
  const soloDev = state.workspaces.find((workspace) => workspace.id === soloDevId)!
  const [soloDevAgentId] = Object.keys(soloDev.agents)
  assert.match(soloDevAgentId ?? '', /^agent-[0-9a-z]{16}$/)
  assert.deepEqual(layoutAgentIds(soloDev.layoutModel), [soloDevAgentId])
  assert.equal(soloDev.agents[soloDevAgentId!]?.id, soloDevAgentId)
  assert.equal(soloDev.agents[soloDevAgentId!]?.cli, 'claude-code')
  assert.deepEqual(layoutAgentIds(soloDevTemplate.layout), ['agent-1'], 'the shared template itself is never rewritten')
  // A generic template tab label ("Agent") is a slot placeholder, never an
  // identity: the seeded general agent gets a real picked name, like a
  // picked name. The layout tab renames itself to agent.name on render.
  const soloDevAgentName = soloDev.agents[soloDevAgentId!]?.name ?? ''
  assert.notEqual(soloDevAgentName, 'Agent')
  assert.match(soloDevAgentName, /^[A-Z][a-z]+ [A-Z][a-z]+( \d+)?$/)

  state.reorderWorkspaces([secondId, 'missing', firstId, soloDevId])
  assert.deepEqual(
    useWorkspaceStore.getState().workspaces.map((workspace) => workspace.id),
    [secondId, firstId, soloDevId],
  )

  useWorkspaceStore.getState().renameWorkspace(firstId, ' Renamed Workspace ')
  assert.equal(
    useWorkspaceStore.getState().workspaces.find((workspace) => workspace.id === firstId)?.name,
    'Renamed Workspace',
  )
  useWorkspaceStore.getState().renameWorkspace(firstId, '   ')
  assert.equal(
    useWorkspaceStore.getState().workspaces.find((workspace) => workspace.id === firstId)?.name,
    'Renamed Workspace',
  )

  useWorkspaceStore.getState().setWorkspaceHighlight(firstId, { starred: true, color: 'blue' })
  assert.deepEqual(useWorkspaceStore.getState().workspaces.find((workspace) => workspace.id === firstId)?.highlight, {
    starred: true,
    color: 'blue',
  })
  useWorkspaceStore.getState().clearWorkspaceHighlight(firstId)
  assert.equal(
    useWorkspaceStore.getState().workspaces.find((workspace) => workspace.id === firstId)?.highlight,
    undefined,
  )

  useWorkspaceStore.getState().setActiveWorkspace(firstId)
  assert.equal(useWorkspaceStore.getState().activeWorkspaceId, firstId)
  state = useWorkspaceStore.getState()
  assert.equal(state.workspaceWindows.length, 1)
  assert.deepEqual(state.workspaceWindows[0]?.workspaceIds, [secondId, firstId, soloDevId])

  // Selection invariant (global-surfaces epic 1704): opening a door-routed
  // full-page surface must not touch workspace state, and activating a workspace
  // must clear the surface — so the sidebar shows exactly one selected thing (a
  // door XOR a project) and the workspace layers behind stay intact on return.
  useWorkspaceStore.getState().openGlobalSurface('roadmap')
  assert.equal(useWorkspaceStore.getState().activeGlobalSurface, 'roadmap')
  assert.equal(
    useWorkspaceStore.getState().activeWorkspaceId,
    firstId,
    'opening a surface leaves the active workspace (and its layers) untouched',
  )
  useWorkspaceStore.getState().setActiveWorkspace(secondId)
  assert.equal(useWorkspaceStore.getState().activeWorkspaceId, secondId)
  assert.equal(
    useWorkspaceStore.getState().activeGlobalSurface,
    null,
    'activating a workspace clears the active surface (door XOR project)',
  )
  // The per-window activation path clears it too.
  useWorkspaceStore.getState().openGlobalSurface('roadmap')
  useWorkspaceStore
    .getState()
    .setActiveWorkspaceForWindow(useWorkspaceStore.getState().primaryWorkspaceWindowId, firstId)
  assert.equal(
    useWorkspaceStore.getState().activeGlobalSurface,
    null,
    'setActiveWorkspaceForWindow clears the active surface as well',
  )

  // An open modal surface (doors→modals, 2026-09-01) closes on activation the
  // same way, on both paths: a reveal must land on a visible workspace, not one
  // behind the modal's scrim. A module-registered id and `settings` because those
  // are what a modal IS now — Automations, Design and Plugins went back to being
  // doors (Extensions drawer ruling, 2026-09-05) and are covered by the door path
  // above.
  useWorkspaceStore.getState().openModalSurface('notebooks', { workspaceId: secondId })
  useWorkspaceStore.getState().setActiveWorkspace(firstId)
  assert.equal(
    useWorkspaceStore.getState().activeModalSurface,
    null,
    'activating a workspace closes an open modal surface',
  )
  assert.equal(
    useWorkspaceStore.getState().activeModalSurfaceWorkspaceId,
    null,
    'and the workspace it was opened from goes with it — a stale opener would outlive its modal',
  )
  useWorkspaceStore.getState().openModalSurface('settings')
  useWorkspaceStore
    .getState()
    .setActiveWorkspaceForWindow(useWorkspaceStore.getState().primaryWorkspaceWindowId, secondId)
  assert.equal(
    useWorkspaceStore.getState().activeModalSurface,
    null,
    'setActiveWorkspaceForWindow closes an open modal surface as well',
  )

  useWorkspaceStore
    .getState()
    .setFileExplorerExpandedPaths(firstId, ['/Users/example/project/src', '/Users/example/project/src', ''])
  assert.deepEqual(
    useWorkspaceStore.getState().workspaces.find((workspace) => workspace.id === firstId)?.fileExplorerState,
    { expandedPaths: ['/Users/example/project/src'], selectedPath: null },
    'File Explorer expansion paths are normalized and stored per workspace',
  )

  // setFileExplorerSelectedPath records the focused selection without clobbering
  // the expanded set, and setFileExplorerExpandedPaths preserves the selection.
  useWorkspaceStore.getState().setFileExplorerSelectedPath(firstId, '/Users/example/project/src/index.ts')
  assert.deepEqual(
    useWorkspaceStore.getState().workspaces.find((workspace) => workspace.id === firstId)?.fileExplorerState,
    { expandedPaths: ['/Users/example/project/src'], selectedPath: '/Users/example/project/src/index.ts' },
    'Selecting a file keeps the expanded set',
  )
  useWorkspaceStore
    .getState()
    .setFileExplorerExpandedPaths(firstId, ['/Users/example/project/src', '/Users/example/project/lib'])
  assert.equal(
    useWorkspaceStore.getState().workspaces.find((workspace) => workspace.id === firstId)?.fileExplorerState
      ?.selectedPath,
    '/Users/example/project/src/index.ts',
    'Toggling folders preserves the persisted selection',
  )
  useWorkspaceStore.getState().setFileExplorerSelectedPath(firstId, null)
  assert.equal(
    useWorkspaceStore.getState().workspaces.find((workspace) => workspace.id === firstId)?.fileExplorerState
      ?.selectedPath,
    null,
    'Clearing selection persists null',
  )

  // Backlog view state merges partial patches and coerces invalid enums.
  useWorkspaceStore.getState().setBacklogViewState(firstId, { view: 'quick_wins', sort: 'priority' })
  useWorkspaceStore.getState().setBacklogViewState(firstId, { selectedRelativePath: 'backlog/x.md', search: 'auth' })
  assert.deepEqual(
    useWorkspaceStore.getState().workspaces.find((workspace) => workspace.id === firstId)?.backlogState,
    { selectedRelativePath: 'backlog/x.md', view: 'quick_wins', sort: 'priority', group: 'none', search: 'auth' },
    'Backlog view state accumulates partial patches',
  )
  useWorkspaceStore.getState().setBacklogViewState(firstId, { view: 'bogus' as never })
  assert.equal(
    useWorkspaceStore.getState().workspaces.find((workspace) => workspace.id === firstId)?.backlogState?.view,
    'active',
    'An unknown lens is coerced to the default Active lens',
  )

  // Git panel: per-scope drafts set/clear independently and never bleed.
  useWorkspaceStore.getState().setGitPanelState(firstId, { activeView: 'log', activeScopeId: 'worktree-a' })
  useWorkspaceStore.getState().setGitCommitDraft(firstId, 'worktree-a', 'WIP a')
  useWorkspaceStore.getState().setGitCommitDraft(firstId, 'main', 'WIP main')
  assert.deepEqual(
    useWorkspaceStore.getState().workspaces.find((workspace) => workspace.id === firstId)?.gitPanelState,
    {
      activeView: 'log',
      activeScopeId: 'worktree-a',
      commitDraftsByScopeId: { 'worktree-a': 'WIP a', main: 'WIP main' },
    },
    'Git panel keeps a draft per scope alongside the active view/scope',
  )
  useWorkspaceStore.getState().setGitCommitDraft(firstId, 'worktree-a', '   ')
  assert.deepEqual(
    useWorkspaceStore.getState().workspaces.find((workspace) => workspace.id === firstId)?.gitPanelState
      ?.commitDraftsByScopeId,
    { main: 'WIP main' },
    'A blank draft is dropped, leaving other scopes untouched',
  )
  useWorkspaceStore.getState().clearGitCommitDraft(firstId, 'main')
  assert.deepEqual(
    useWorkspaceStore.getState().workspaces.find((workspace) => workspace.id === firstId)?.gitPanelState
      ?.commitDraftsByScopeId,
    {},
    'Clearing a draft on commit removes it',
  )
  // setGitPanelState must not disturb existing drafts.
  useWorkspaceStore.getState().setGitCommitDraft(firstId, 'main', 'keep me')
  useWorkspaceStore.getState().setGitPanelState(firstId, { activeView: 'changes' })
  assert.deepEqual(
    useWorkspaceStore.getState().workspaces.find((workspace) => workspace.id === firstId)?.gitPanelState
      ?.commitDraftsByScopeId,
    { main: 'keep me' },
    'Changing the active view preserves per-scope drafts',
  )

  useWorkspaceStore.getState().registerWorkspaceWindow('detached-test', 'detached')
  useWorkspaceStore.getState().moveWorkspaceToWindow(firstId, 'detached-test', state.primaryWorkspaceWindowId)
  state = useWorkspaceStore.getState()
  assert.deepEqual(state.workspaceWindows.find((windowState) => windowState.id === 'detached-test')?.workspaceIds, [
    firstId,
  ])
  assert.equal(
    state.workspaceWindows.find((windowState) => windowState.id === 'detached-test')?.activeWorkspaceId,
    firstId,
  )
  assert.equal(
    state.workspaceWindows
      .find((windowState) => windowState.id === state.primaryWorkspaceWindowId)
      ?.workspaceIds.includes(firstId),
    false,
  )
  useWorkspaceStore.getState().updateWorkspaceWindowPlacement('detached-test', {
    bounds: { x: 120.4, y: 80.8, width: 720, height: 540 },
    isMaximized: true,
    displayId: 3,
  })
  state = useWorkspaceStore.getState()
  assert.deepEqual(state.workspaceWindows.find((windowState) => windowState.id === 'detached-test')?.bounds, {
    x: 120,
    y: 81,
    width: 800,
    height: 600,
  })
  assert.equal(state.workspaceWindows.find((windowState) => windowState.id === 'detached-test')?.isMaximized, true)
  assert.equal(state.workspaceWindows.find((windowState) => windowState.id === 'detached-test')?.displayId, 3)
  useWorkspaceStore.getState().moveWorkspaceToWindow(firstId, state.primaryWorkspaceWindowId, 'detached-test')
  state = useWorkspaceStore.getState()
  assert.equal(
    state.workspaceWindows.find((windowState) => windowState.id === state.primaryWorkspaceWindowId)?.activeWorkspaceId,
    firstId,
  )
  assert.equal(
    state.workspaceWindows.find((windowState) => windowState.id === 'detached-test'),
    undefined,
  )
  useWorkspaceStore.getState().moveWorkspaceToWindow(firstId, 'detached-test', state.primaryWorkspaceWindowId)
  useWorkspaceStore.getState().closeWorkspaceWindow('detached-test')
  state = useWorkspaceStore.getState()
  assert.equal(
    state.workspaceWindows.find((windowState) => windowState.id === 'detached-test'),
    undefined,
  )
  assert.equal(
    state.workspaceWindows
      .find((windowState) => windowState.id === state.primaryWorkspaceWindowId)
      ?.workspaceIds.includes(firstId),
    true,
  )
  useWorkspaceStore.getState().setFolderPath(firstId, '/Users/example/renamed')
  state = useWorkspaceStore.getState()
  assert.equal(state.workspaces.find((workspace) => workspace.id === firstId)?.folderPath, '/Users/example/renamed')
  assert.deepEqual(
    state.workspaces.find((workspace) => workspace.id === firstId)?.fileExplorerState,
    { expandedPaths: [], selectedPath: null },
    'changing the workspace folder clears stale File Explorer expansion state',
  )
  assert.equal(
    state.workspaces.find((workspace) => workspace.id === firstId)?.backlogState,
    undefined,
    'changing the workspace folder clears the folder-scoped Backlog selection',
  )
  assert.equal(
    state.workspaces.find((workspace) => workspace.id === firstId)?.gitPanelState,
    undefined,
    'changing the workspace folder clears the repo-scoped Git panel state',
  )
  assert.deepEqual(state.appSettings.recentWorkspaceFolders.slice(0, 2), [
    '/Users/example/renamed',
    '/Users/example/solo-dev',
  ])

  useWorkspaceStore.getState().updateAgent(firstId, 'agent-1', { name: 'Agent One' })
  assert.equal(useWorkspaceStore.getState().moveAgentToWorkspace(firstId, secondId, 'agent-1'), true)
  state = useWorkspaceStore.getState()
  assert.equal(state.workspaces.find((workspace) => workspace.id === firstId)?.agents['agent-1'], undefined)
  assert.equal(state.workspaces.find((workspace) => workspace.id === secondId)?.agents['agent-1']?.name, 'Agent One')

  // A chat made before ids were minted still has its `agent-1`, as may the chat
  // it is dragged into. The move is refused rather than writing over the
  // destination's own agent, and neither record changes.
  useWorkspaceStore.getState().updateAgent(firstId, 'agent-1', { name: 'Other Agent One' })
  assert.equal(useWorkspaceStore.getState().moveAgentToWorkspace(firstId, secondId, 'agent-1'), false)
  state = useWorkspaceStore.getState()
  assert.equal(
    state.workspaces.find((workspace) => workspace.id === firstId)?.agents['agent-1']?.name,
    'Other Agent One',
  )
  assert.equal(state.workspaces.find((workspace) => workspace.id === secondId)?.agents['agent-1']?.name, 'Agent One')
  assert.equal(useWorkspaceStore.getState().moveAgentToWorkspace(firstId, firstId, 'agent-1'), false)
  assert.equal(useWorkspaceStore.getState().moveAgentToWorkspace(firstId, secondId, 'no-such-agent'), false)
  useWorkspaceStore.getState().removeAgent(firstId, 'agent-1')

  // removeAgent deletes the record entirely (used by automation run-finalize dispose).
  useWorkspaceStore.getState().removeAgent(secondId, 'agent-1')
  state = useWorkspaceStore.getState()
  assert.equal(
    state.workspaces.find((workspace) => workspace.id === secondId)?.agents['agent-1'],
    undefined,
    'removeAgent deletes the agent record from the workspace',
  )
  // Idempotent: a repeat call and a missing-workspace call are silent no-ops.
  useWorkspaceStore.getState().removeAgent(secondId, 'agent-1')
  useWorkspaceStore.getState().removeAgent('no-such-workspace', 'agent-1')

  useWorkspaceStore.getState().openFile(firstId, '/tmp/example.ts', 'example.ts', 'const value = 1')
  useWorkspaceStore.getState().openFile(firstId, '/tmp/other.ts', 'other.ts', 'const other = 2')
  useWorkspaceStore.getState().moveOpenFileToWorkspace(firstId, secondId, '/tmp/example.ts')
  state = useWorkspaceStore.getState()
  const firstEditor = state.workspaces.find((workspace) => workspace.id === firstId)?.editorState
  const secondEditor = state.workspaces.find((workspace) => workspace.id === secondId)?.editorState
  assert.deepEqual(
    firstEditor?.openFiles.map((file) => file.path),
    ['/tmp/other.ts'],
  )
  assert.equal(firstEditor?.activeFilePath, '/tmp/other.ts')
  assert.deepEqual(
    secondEditor?.openFiles.map((file) => file.path),
    ['/tmp/example.ts'],
  )
  assert.equal(secondEditor?.activeFilePath, '/tmp/example.ts')
  assert.equal(getEditorBuffer(secondId, '/tmp/example.ts'), 'const value = 1')

  useWorkspaceStore.getState().removeWorkspace(secondId)
  state = useWorkspaceStore.getState()
  assert.deepEqual(
    state.workspaces.map((workspace) => workspace.id),
    [firstId, soloDevId],
  )
  // Moving the active workspace (firstId) out of the primary window above fell the
  // store's global active back to the primary window's remaining workspace
  // (secondId) — a cross-window move no longer leaves global active pointing at a
  // workspace that now lives in another window. Removing that fallback active
  // (secondId) then reassigns to the last remaining workspace (soloDevId).
  assert.equal(state.activeWorkspaceId, soloDevId)

  // forgetFolder drops the folder's workspaces and its recent-folders entry.
  const forgettableId = useWorkspaceStore.getState().addWorkspace(standardTemplate, {
    folderPath: '/Users/example/forgettable',
  })
  useWorkspaceStore.getState().forgetFolder('/Users/example/forgettable')
  state = useWorkspaceStore.getState()
  assert.equal(
    state.workspaces.find((workspace) => workspace.id === forgettableId),
    undefined,
  )
  assert.equal(
    state.appSettings.recentWorkspaceFolders.some((folder) => folder.includes('forgettable')),
    false,
  )

  // A second workspace in the same folder inserts directly above the first
  // (top of that folder's block), not at the global head and not at the tail.
  const blockFolder = '/Users/example/insert-order'
  const olderInBlock = useWorkspaceStore.getState().addWorkspace(standardTemplate, {
    name: 'Older In Block',
    folderPath: blockFolder,
  })
  const newerInBlock = useWorkspaceStore.getState().addWorkspace(standardTemplate, {
    name: 'Newer In Block',
    folderPath: blockFolder,
  })
  state = useWorkspaceStore.getState()
  const blockIds = state.workspaces
    .filter((workspace) => workspace.folderPath === blockFolder)
    .map((workspace) => workspace.id)
  assert.deepEqual(blockIds, [newerInBlock, olderInBlock])

  // Regression: a workspace_window.closed event can reach a renderer that never
  // held the closing window record (routing drift). The movedWorkspaceIds payload
  // must still route those workspaces to the fallback window, and a foreign-window
  // close must not flip this renderer's global active workspace.
  const driftWorkspace = (id: string, folderPath: string | null = null): Workspace =>
    ({ id, name: id, folderPath, agents: {} }) as unknown as Workspace
  const driftWindow = (id: string, workspaceIds: string[], active: string | null): WorkspaceWindowState => ({
    id,
    kind: id === 'A' ? 'primary' : 'detached',
    workspaceIds,
    activeWorkspaceId: active,
    bounds: null,
    isMaximized: false,
    displayId: null,
    createdAt: 1,
    lastFocusedAt: 1,
  })
  useWorkspaceStore.setState({
    workspaces: [driftWorkspace('drift-a'), driftWorkspace('drift-b')],
    activeWorkspaceId: 'drift-a',
    primaryWorkspaceWindowId: 'A',
    // This renderer only knows window A; the closing window 'B' is absent locally.
    workspaceWindows: [driftWindow('A', ['drift-a'], 'drift-a')],
    workspaceRegistryEmptyState: null,
  })
  useWorkspaceStore.getState().applyWorkspaceClosedEvent({
    windowId: 'B',
    fallbackWindowId: 'A',
    movedWorkspaceIds: ['drift-b'],
    createdAt: 2000,
  })
  state = useWorkspaceStore.getState()
  assert.deepEqual(
    state.workspaceWindows.find((windowState) => windowState.id === 'A')?.workspaceIds,
    ['drift-a', 'drift-b'],
    'movedWorkspaceIds route to the fallback window even when the closing window record is absent locally',
  )
  assert.equal(
    state.workspaceWindows.find((windowState) => windowState.id === 'A')?.activeWorkspaceId,
    'drift-a',
    'a foreign-window close does not flip the fallback window active workspace',
  )
  assert.equal(state.activeWorkspaceId, 'drift-a', 'a foreign-window close does not flip the global active workspace')

  // Regression: a user move of the active workspace from the current/source window
  // ('primary' — the id the slice derives for this renderer in the test env) to
  // another window transfers exactly one-window membership and falls this
  // renderer's global active back to its own window's remaining workspace, so
  // global active never points at a workspace that now lives in another window.
  useWorkspaceStore.setState({
    workspaces: [driftWorkspace('move-1'), driftWorkspace('move-2')],
    activeWorkspaceId: 'move-1',
    primaryWorkspaceWindowId: 'primary',
    workspaceWindows: [driftWindow('primary', ['move-1', 'move-2'], 'move-1')],
    workspaceRegistryEmptyState: null,
  })
  useWorkspaceStore.getState().moveWorkspaceToWindow('move-1', 'detached-b', 'primary')
  state = useWorkspaceStore.getState()
  assert.deepEqual(
    state.workspaceWindows.find((windowState) => windowState.id === 'primary')?.workspaceIds,
    ['move-2'],
    'source window keeps only its remaining workspace after the move',
  )
  assert.deepEqual(
    state.workspaceWindows.find((windowState) => windowState.id === 'detached-b')?.workspaceIds,
    ['move-1'],
    'target window owns exactly the moved workspace (one-window membership)',
  )
  assert.equal(
    state.workspaceWindows.find((windowState) => windowState.id === 'primary')?.activeWorkspaceId,
    'move-2',
    'source window active falls back deterministically',
  )
  assert.equal(
    state.workspaceWindows.find((windowState) => windowState.id === 'detached-b')?.activeWorkspaceId,
    'move-1',
    'target window focuses the moved workspace',
  )
  assert.equal(
    state.activeWorkspaceId,
    'move-2',
    'global active follows this renderer window fallback, not the moved-away workspace',
  )
  // The source renderer applying its own accepted moved event (target is the other
  // window, not this renderer's window) stays idempotent and must not flip global
  // active back to the moved-away workspace.
  useWorkspaceStore.getState().applyWorkspaceMovedEvent({
    workspaceId: 'move-1',
    fromWindowId: 'primary',
    toWindowId: 'detached-b',
    makeActive: true,
    createdAt: 3000,
    isCurrentWindowTarget: false,
  })
  state = useWorkspaceStore.getState()
  assert.deepEqual(
    state.workspaceWindows.find((windowState) => windowState.id === 'primary')?.workspaceIds,
    ['move-2'],
    'accepted event re-application is idempotent for source membership',
  )
  assert.equal(
    state.activeWorkspaceId,
    'move-2',
    'an accepted move event for another window does not flip the source renderer global active',
  )

  // Regression: the failed createWorkspaceWindow rollback path moves the workspace
  // back INTO the current window ('primary') using the failed target ('detached-b')
  // as sourceWindowId. Because the move target is this renderer's own window, the
  // restored workspace must be refocused as the global active, while real move-out
  // operations (above) keep the source-window fallback.
  useWorkspaceStore.getState().moveWorkspaceToWindow('move-1', 'primary', 'detached-b')
  state = useWorkspaceStore.getState()
  assert.deepEqual(
    state.workspaceWindows.find((windowState) => windowState.id === 'primary')?.workspaceIds,
    ['move-1', 'move-2'],
    'the restored workspace returns to the current window (one-window membership)',
  )
  assert.equal(
    state.workspaceWindows.find((windowState) => windowState.id === 'detached-b'),
    undefined,
    'the emptied target window is dropped after the rollback move',
  )
  assert.equal(
    state.workspaceWindows.find((windowState) => windowState.id === 'primary')?.activeWorkspaceId,
    'move-1',
    'the current window refocuses the restored workspace',
  )
  assert.equal(state.activeWorkspaceId, 'move-1', 'the rollback restores global active to the returned workspace')

  // Regression: applying a broadcast workspace.created event inserts the workspace
  // at its folder head (deterministic) and assigns it to the target window. When
  // the target is ANOTHER window, this renderer's global active is not flipped;
  // when the target is this renderer's own window, the creation is focused.
  useWorkspaceStore.setState({
    workspaces: [driftWorkspace('repo-a-1', '/repo/a'), driftWorkspace('repo-b-1', '/repo/b')],
    activeWorkspaceId: 'repo-a-1',
    primaryWorkspaceWindowId: 'primary',
    workspaceWindows: [driftWindow('primary', ['repo-a-1', 'repo-b-1'], 'repo-a-1')],
    workspaceRegistryEmptyState: null,
  })
  useWorkspaceStore.getState().applyWorkspaceCreatedEvent({
    workspace: driftWorkspace('repo-a-2', '/repo/a'),
    windowId: 'detached-z',
    folderPath: '/repo/a',
    createdAt: 4000,
    isCurrentWindowTarget: false,
    activate: true,
  })
  state = useWorkspaceStore.getState()
  assert.deepEqual(
    state.workspaces.map((workspace) => workspace.id),
    ['repo-a-2', 'repo-a-1', 'repo-b-1'],
    'a created event inserts the workspace at the head of its folder block',
  )
  assert.deepEqual(
    state.workspaceWindows.find((windowState) => windowState.id === 'detached-z')?.workspaceIds,
    ['repo-a-2'],
    'the created workspace is assigned to the target window',
  )
  assert.equal(
    state.workspaceWindows.find((windowState) => windowState.id === 'detached-z')?.activeWorkspaceId,
    'repo-a-2',
    'the target window focuses the created workspace',
  )
  assert.equal(
    state.activeWorkspaceId,
    'repo-a-1',
    'a creation targeting another window does not flip this renderer global active',
  )
  // A creation targeting THIS renderer's own window ('primary') focuses it globally.
  useWorkspaceStore.getState().applyWorkspaceCreatedEvent({
    workspace: driftWorkspace('repo-a-3', '/repo/a'),
    windowId: 'primary',
    folderPath: '/repo/a',
    createdAt: 4100,
    isCurrentWindowTarget: true,
    activate: true,
  })
  state = useWorkspaceStore.getState()
  assert.equal(
    state.workspaceWindows.find((windowState) => windowState.id === 'primary')?.workspaceIds[0],
    'repo-a-3',
    'a creation into this window is assigned at its head',
  )
  assert.equal(state.activeWorkspaceId, 'repo-a-3', 'a creation into this renderer window is focused as global active')

  // A worktree chat's created event carries the worktree as its folderPath; the
  // block it joins is the project the marker names, so it lands at the head of
  // that project rather than at the registry head.
  useWorkspaceStore.getState().applyWorkspaceCreatedEvent({
    workspace: {
      ...driftWorkspace('repo-b-worktree', '/repo/.sprintengine-worktrees/b/chat-a1b2'),
      worktree: { branch: 'agent/chat-a1b2', repoRoot: '/repo/b' },
    } as Workspace,
    windowId: 'primary',
    folderPath: '/repo/.sprintengine-worktrees/b/chat-a1b2',
    createdAt: 4200,
    isCurrentWindowTarget: true,
    activate: true,
  })
  state = useWorkspaceStore.getState()
  assert.deepEqual(
    state.workspaces.map((workspace) => workspace.id),
    ['repo-a-3', 'repo-a-2', 'repo-a-1', 'repo-b-worktree', 'repo-b-1'],
    'a created worktree chat inserts at the head of the project it was cut from',
  )

  // A scheduled run's chat is created in the background: it joins this
  // window's list without taking the window from what the person is looking at.
  useWorkspaceStore.getState().applyWorkspaceCreatedEvent({
    workspace: driftWorkspace('repo-a-run', '/repo/a'),
    windowId: 'primary',
    folderPath: '/repo/a',
    createdAt: 4300,
    isCurrentWindowTarget: true,
    activate: false,
  })
  state = useWorkspaceStore.getState()
  const primaryAfterRun = state.workspaceWindows.find((windowState) => windowState.id === 'primary')
  assert.ok(primaryAfterRun?.workspaceIds.includes('repo-a-run'), 'a background creation joins the window')
  assert.equal(primaryAfterRun?.activeWorkspaceId, 'repo-b-worktree', 'the window keeps showing what it showed')
  assert.equal(state.activeWorkspaceId, 'repo-b-worktree', 'the global active does not move to a background creation')

  // --- Open-in-new-chat seeding (addWorkspace `seedAgent`) ---------------------

  type SeededTab = { component?: unknown; name?: unknown; config?: Record<string, unknown> }
  const firstTab = (ws: Workspace | undefined): SeededTab | undefined => {
    let found: SeededTab | undefined
    const visit = (node: { component?: unknown; children?: unknown[] } | undefined) => {
      if (!node || found) return
      if (node.component === 'agent' || node.component === 'terminal' || node.component === 'mesh-conversation') {
        found = node as SeededTab
        return
      }
      ;(node.children as Array<typeof node> | undefined)?.forEach(visit)
    }
    visit(ws?.layoutModel.layout as never)
    return found
  }

  // Named seed: the lone agent record takes the patch and the lone layout tab is
  // renamed, all at creation time.
  const namedChatId = useWorkspaceStore.getState().addWorkspace(soloDevTemplate, {
    folderPath: '/Users/example/seed',
    templateAgentCli: 'codex',
    seedAgent: {
      tabName: 'Ada',
      agentPatch: {
        name: 'Ada',
        cli: 'codex',
        cliStartupPrompt: 'START_PROMPT',
      },
    },
  })
  state = useWorkspaceStore.getState()
  const namedChat = state.workspaces.find((workspace) => workspace.id === namedChatId)
  // The seeded record is the one the lone tab names, under the id it was minted.
  const namedChatAgentId = firstTab(namedChat)?.config?.agentId as string
  assert.deepEqual(Object.keys(namedChat?.agents ?? {}), [namedChatAgentId])
  assert.equal(namedChat?.agents[namedChatAgentId]?.cli, 'codex')
  assert.equal(namedChat?.agents[namedChatAgentId]?.name, 'Ada')
  assert.equal(namedChat?.agents[namedChatAgentId]?.cliStartupPrompt, 'START_PROMPT')
  assert.equal(firstTab(namedChat)?.component, 'agent')
  assert.equal(firstTab(namedChat)?.name, 'Ada')

  // Conversation seed: runtime patch lands on the lone agent record.
  const conversationChatId = useWorkspaceStore.getState().addWorkspace(soloDevTemplate, {
    folderPath: '/Users/example/seed',
    seedAgent: {
      tabName: 'GPT-5',
      agentPatch: {
        name: 'GPT-5',
        runtimeKind: 'conversation',
        conversation: { providerId: 'openai', modelId: 'gpt-5' },
      },
    },
  })
  state = useWorkspaceStore.getState()
  const conversationChat = state.workspaces.find((workspace) => workspace.id === conversationChatId)
  const conversationChatAgentId = firstTab(conversationChat)?.config?.agentId as string
  assert.notEqual(conversationChatAgentId, namedChatAgentId, 'two chats from one template share no agent id')
  assert.equal(conversationChat?.agents[conversationChatAgentId]?.runtimeKind, 'conversation')
  assert.deepEqual(conversationChat?.agents[conversationChatAgentId]?.conversation, {
    providerId: 'openai',
    modelId: 'gpt-5',
  })
  assert.equal(firstTab(conversationChat)?.name, 'GPT-5')

  // Terminal seed: the lone agent tab is swapped for a terminal tab and no agent
  // record is created.
  const terminalChatId = useWorkspaceStore.getState().addWorkspace(soloDevTemplate, {
    folderPath: '/Users/example/seed',
    seedAgent: { terminal: { terminalId: 'terminal-seed-1' }, tabName: 'Terminal' },
  })
  state = useWorkspaceStore.getState()
  const terminalChat = state.workspaces.find((workspace) => workspace.id === terminalChatId)
  assert.deepEqual(terminalChat?.agents, {})
  const terminalTab = firstTab(terminalChat)
  assert.equal(terminalTab?.component, 'terminal')
  assert.equal(terminalTab?.name, 'Terminal')
  assert.deepEqual(terminalTab?.config, { terminalId: 'terminal-seed-1' })

  // applySoloChatSeed is pure: it clones, never mutating the source template.
  const seedSource = {
    global: {},
    borders: [],
    layout: {
      type: 'row',
      children: [
        {
          type: 'tabset',
          children: [{ type: 'tab', name: 'Agent', component: 'agent', config: { agentId: 'agent-1' } }],
        },
      ],
    },
  } as never
  const renamed = applySoloChatSeed(seedSource, { tabName: 'Renamed' })
  assert.notEqual(renamed, seedSource)
  assert.equal(firstTab({ layoutModel: renamed } as never)?.name, 'Renamed')
  assert.equal(firstTab({ layoutModel: seedSource } as never)?.name, 'Agent')
  const swapped = applySoloChatSeed(seedSource, { terminal: { terminalId: 't-9' }, tabName: 'Terminal' })
  assert.equal(firstTab({ layoutModel: swapped } as never)?.component, 'terminal')
  assert.equal(firstTab({ layoutModel: seedSource } as never)?.component, 'agent')

  // The remote conversation seed (remote-sessions-ux / new-chat-on-a-remote-machine):
  // the lone agent tab becomes a chat pane onto a conversation on another
  // machine — no local agent, and an id keyed on the remote workspace and agent
  // so a later open focuses this pane instead of opening a second one.
  const remote = applySoloChatSeed(seedSource, {
    tabName: 'Air · Rook',
    meshConversation: {
      connectionId: 'conn-1',
      machineName: 'Air',
      remoteWorkspaceId: 'ws two',
      remoteAgentId: 'agent-2',
      title: 'Rook',
    },
  })
  const remoteTab = firstTab({ layoutModel: remote } as never) as
    { component?: string; id?: string; name?: string; config?: Record<string, unknown> } | undefined
  assert.equal(remoteTab?.component, 'mesh-conversation')
  assert.equal(remoteTab?.id, 'mesh-conversation:conn-1:ws%20two:agent-2')
  assert.equal(remoteTab?.name, 'Air · Rook')
  assert.deepEqual(remoteTab?.config, {
    connectionId: 'conn-1',
    machineName: 'Air',
    remoteWorkspaceId: 'ws two',
    remoteAgentId: 'agent-2',
    remoteSessionId: 'conversation:ws two:agent-2',
    title: 'Rook',
  })
  assert.equal(
    firstTab({ layoutModel: seedSource } as never)?.component,
    'agent',
    'the source template is never mutated',
  )

  // --- Explicit module-registered mode ----------------------------------------
  // An explicit non-standard `mode` is honored at creation: it is the identity
  // every mode-derived surface keys on.
  const moduleTypeId = useWorkspaceStore.getState().addWorkspace(standardTemplate, {
    name: 'Weather deck',
    folderPath: '/Users/example/project',
    mode: 'weather-deck',
  })
  state = useWorkspaceStore.getState()
  assert.equal(
    state.workspaces.find((workspace) => workspace.id === moduleTypeId)?.mode,
    'weather-deck',
    'an explicit module mode wins over standard-derivation',
  )

  // Omitting mode behaves exactly as today: standard-derivation is unchanged.
  const derivedStandardId = useWorkspaceStore.getState().addWorkspace(standardTemplate, {
    name: 'Plain Standard',
    folderPath: '/Users/example/project',
  })
  state = useWorkspaceStore.getState()
  assert.equal(
    state.workspaces.find((workspace) => workspace.id === derivedStandardId)?.mode,
    'standard',
    'an omitted mode still derives standard',
  )

  // addWorkspace plumbs the optional `worktree` marker onto the created workspace
  // (set by the Worktree manager's "Open as workspace"), and omits it otherwise so
  // existing/non-worktree workspaces stay a true no-op.
  const worktreeWsId = useWorkspaceStore.getState().addWorkspace(standardTemplate, {
    name: 'Worktree: spike',
    folderPath: '/Users/example/wt/spike',
    worktree: { branch: 'spike/parser' },
  })
  const plainWsId = useWorkspaceStore.getState().addWorkspace(standardTemplate, {
    name: 'Plain',
    folderPath: '/Users/example/plain',
  })
  state = useWorkspaceStore.getState()
  assert.deepEqual(
    state.workspaces.find((workspace) => workspace.id === worktreeWsId)?.worktree,
    { branch: 'spike/parser' },
    'addWorkspace sets the worktree marker',
  )
  assert.equal(
    state.workspaces.find((workspace) => workspace.id === plainWsId)?.worktree,
    undefined,
    'addWorkspace omits the worktree marker when not provided',
  )

  // A worktree-backed chat files under the project it was cut from. It inserts at
  // the head of THAT project's block rather than at the registry head (which would
  // yank the project's group to the top of the sidebar), whether the parent is
  // recorded on the marker or only derivable from the container path. Forgetting
  // the parent then takes the worktree rows with it — the forget dialog counts the
  // group's rows and promises to close them.
  const worktreeParent = '/Users/example/worktree-parent'
  const parentChatId = useWorkspaceStore.getState().addWorkspace(standardTemplate, {
    name: 'Parent chat',
    folderPath: worktreeParent,
  })
  const elsewhereChatId = useWorkspaceStore.getState().addWorkspace(standardTemplate, {
    name: 'Elsewhere',
    folderPath: '/Users/example/worktree-elsewhere',
  })
  const worktreeChatId = useWorkspaceStore.getState().addWorkspace(standardTemplate, {
    name: 'Worktree chat',
    folderPath: '/Users/example/.sprintengine-worktrees/worktree-parent/chat-a1b2',
    worktree: { branch: 'agent/chat-a1b2', baseRef: 'HEAD', repoRoot: worktreeParent },
  })
  const legacyWorktreeChatId = useWorkspaceStore.getState().addWorkspace(standardTemplate, {
    name: 'Legacy worktree chat',
    folderPath: '/Users/example/.sprintengine-worktrees/worktree-parent/chat-c3d4',
    worktree: { branch: 'agent/chat-c3d4' },
  })
  state = useWorkspaceStore.getState()
  const worktreeBlockIds = [parentChatId, elsewhereChatId, worktreeChatId, legacyWorktreeChatId]
  assert.deepEqual(
    state.workspaces.filter((workspace) => worktreeBlockIds.includes(workspace.id)).map((workspace) => workspace.id),
    [elsewhereChatId, legacyWorktreeChatId, worktreeChatId, parentChatId],
    'a worktree chat inserts at the head of its parent project block, not the registry head',
  )
  assert.deepEqual(
    state.appSettings.recentWorkspaceFolders.filter((folder) => folder.includes('worktree-parent')),
    [worktreeParent],
    'a worktree chat contributes its PROJECT to recents, never the worktree path',
  )
  // A stale worktree path from before that rule still has to go when the project
  // is forgotten, or it comes back in New chat's picker named after the slug.
  useWorkspaceStore.setState({
    appSettings: {
      ...state.appSettings,
      recentWorkspaceFolders: [
        '/Users/example/.sprintengine-worktrees/worktree-parent/chat-legacy',
        ...state.appSettings.recentWorkspaceFolders,
      ],
    },
  })
  assert.ok(
    useWorkspaceStore
      .getState()
      .appSettings.recentWorkspaceFolders.includes(
        '/Users/example/.sprintengine-worktrees/worktree-parent/chat-legacy',
      ),
    'the stale worktree recent is actually in place before forgetting',
  )
  useWorkspaceStore.getState().forgetFolder(worktreeParent)
  state = useWorkspaceStore.getState()
  assert.deepEqual(
    state.workspaces.filter((workspace) => worktreeBlockIds.includes(workspace.id)).map((workspace) => workspace.id),
    [elsewhereChatId],
    'forgetting the parent removes its worktree rows too, recorded or derived',
  )
  assert.deepEqual(
    state.appSettings.recentWorkspaceFolders.filter((folder) => folder.includes('worktree-parent')),
    [],
    'forgetting a project also drops worktree paths under it from recents',
  )

  // Creation activates too, so it must clear the door as well (item 1833: the
  // New-chat-behind-the-door lock-in) — including the reuse early-returns.
  useWorkspaceStore.getState().openGlobalSurface('roadmap')
  const doorChatId = useWorkspaceStore.getState().addWorkspace(standardTemplate, {
    name: 'Chat created at a door',
    folderPath: '/Users/example/door-chat',
  })
  assert.equal(useWorkspaceStore.getState().activeWorkspaceId, doorChatId)
  assert.equal(
    useWorkspaceStore.getState().activeGlobalSurface,
    null,
    'addWorkspace clears the active surface (new-workspace path)',
  )
  // A BACKGROUND create (one made by code rather than a person) must leave an
  // open door alone — only operator-initiated creation dismisses the surface.
  useWorkspaceStore.getState().openGlobalSurface('roadmap')
  useWorkspaceStore.getState().addWorkspace(standardTemplate, {
    name: 'Background create',
    folderPath: '/Users/example/background',
    background: true,
  })
  assert.equal(
    useWorkspaceStore.getState().activeGlobalSurface,
    'roadmap',
    'a background create leaves the door the operator is reading untouched',
  )
  useWorkspaceStore.getState().closeGlobalSurface()

  // --- auto-titling a new chat from its first real prompt ---------------------

  const nameOf = (id: string): string | undefined =>
    useWorkspaceStore.getState().workspaces.find((workspace) => workspace.id === id)?.name
  const lockedOf = (id: string): boolean | undefined =>
    useWorkspaceStore.getState().workspaces.find((workspace) => workspace.id === id)?.titleLocked

  // No explicit name: the workspace lands on the generic "<template> <n>" fallback
  // and is the only kind auto-titling may touch.
  const autoId = useWorkspaceStore.getState().addWorkspace(standardTemplate, {
    folderPath: '/Users/example/auto-title',
    background: true,
  })
  assert.match(nameOf(autoId) ?? '', /^Standard \d+$/, 'an unnamed workspace starts on the fallback name')
  assert.notEqual(lockedOf(autoId), true, 'a fallback-named workspace starts unlocked')

  // A prompt with no usable topic leaves the name alone AND leaves it unlocked, so
  // the next prompt still gets its chance.
  useWorkspaceStore.getState().autoTitleWorkspaceFromPrompt(autoId, '/backlog')
  assert.match(nameOf(autoId) ?? '', /^Standard \d+$/, 'an app-injected skill drop does not title the chat')
  assert.notEqual(lockedOf(autoId), true, 'a rejected prompt leaves the workspace open to the next one')

  useWorkspaceStore
    .getState()
    .autoTitleWorkspaceFromPrompt(autoId, 'so can you fix the git stash panel dropping its hash')
  assert.equal(nameOf(autoId), 'Fix the git stash panel dropping')
  assert.equal(lockedOf(autoId), true, 'auto-titling locks the name')

  // Frozen: a second prompt — from this terminal or a newly added one — never
  // renames the workspace again.
  useWorkspaceStore.getState().autoTitleWorkspaceFromPrompt(autoId, 'now migrate the settings store')
  assert.equal(nameOf(autoId), 'Fix the git stash panel dropping', 'a later prompt never retitles')

  // The New chat button names the workspace itself, with a per-folder ordinal
  // that never matches the store's own global fallback. That name is still the
  // app's, not the person's, so it must stay open for the first prompt — this is
  // the path the sidebar actually takes, and the one that shipped locked.
  const buttonNamedId = useWorkspaceStore.getState().addWorkspace(standardTemplate, {
    name: 'Chat 63',
    folderPath: '/Users/example/button-named',
    background: true,
  })
  assert.equal(nameOf(buttonNamedId), 'Chat 63')
  assert.notEqual(lockedOf(buttonNamedId), true, 'an app-minted "Chat N" name starts unlocked')
  useWorkspaceStore.getState().autoTitleWorkspaceFromPrompt(buttonNamedId, 'have a look at all the chat titles')
  assert.equal(nameOf(buttonNamedId), 'Have a look at all the', 'the first prompt names a button-created chat')
  assert.equal(lockedOf(buttonNamedId), true)

  // A workspace created WITH a name is locked from birth.
  const namedId = useWorkspaceStore.getState().addWorkspace(standardTemplate, {
    name: 'Release prep',
    folderPath: '/Users/example/named-title',
    background: true,
  })
  assert.equal(lockedOf(namedId), true, 'an explicitly named workspace is locked at creation')
  useWorkspaceStore.getState().autoTitleWorkspaceFromPrompt(namedId, 'rewrite the changelog generator')
  assert.equal(nameOf(namedId), 'Release prep', 'auto-titling never overwrites a chosen name')

  // A hand rename locks a workspace that was still on its fallback name.
  const renamedId = useWorkspaceStore.getState().addWorkspace(standardTemplate, {
    folderPath: '/Users/example/hand-renamed',
    background: true,
  })
  useWorkspaceStore.getState().renameWorkspace(renamedId, 'My own name')
  assert.equal(lockedOf(renamedId), true, 'a manual rename locks the name')
  useWorkspaceStore.getState().autoTitleWorkspaceFromPrompt(renamedId, 'add a retry to the uploader')
  assert.equal(nameOf(renamedId), 'My own name', 'auto-titling never overwrites a hand-typed name')

  // --- a model-written title landing on top of the heuristic --------
  //
  // The two halves of titling meet here: `autoTitleWorkspaceFromPrompt` reports
  // the name it applied, and `applyGeneratedWorkspaceTitle` is only allowed to
  // replace exactly that name. Everything in this block is about the window
  // between the two — the person renaming by hand, a second answer arriving, a
  // workspace that is gone by the time the model answers.
  {
    const genId = useWorkspaceStore.getState().addWorkspace(standardTemplate, {
      folderPath: '/Users/example/generated-title',
      background: true,
    })

    // The heuristic reports what it did, so the late half knows what it may
    // replace: null when it applied nothing, the title itself when it did.
    assert.equal(
      useWorkspaceStore.getState().autoTitleWorkspaceFromPrompt(genId, '/backlog'),
      null,
      'a prompt with no usable topic reports that it applied no title',
    )
    const interim = useWorkspaceStore
      .getState()
      .autoTitleWorkspaceFromPrompt(genId, 'so can you fix the git stash panel dropping its hash')
    assert.equal(interim, 'Fix the git stash panel dropping', 'the heuristic returns the title it applied')
    assert.equal(nameOf(genId), interim)
    assert.equal(
      useWorkspaceStore.getState().autoTitleWorkspaceFromPrompt(genId, 'now migrate the settings store'),
      null,
      'a locked workspace reports that it applied nothing',
    )

    // The model's answer replaces the heuristic's name, and locks it in turn.
    assert.equal(
      useWorkspaceStore.getState().applyGeneratedWorkspaceTitle(genId, 'Stash panel loses its hash', interim),
      true,
      'a generated title lands on the name it was asked to replace',
    )
    assert.equal(nameOf(genId), 'Stash panel loses its hash')
    assert.equal(lockedOf(genId), true, 'and the generated name is locked like any other')

    // A second answer for the same request has nothing left to replace.
    assert.equal(
      useWorkspaceStore.getState().applyGeneratedWorkspaceTitle(genId, 'A later answer', interim),
      false,
      'a second answer naming the same stale name is dropped',
    )
    assert.equal(nameOf(genId), 'Stash panel loses its hash')

    // A hand rename in the window between request and answer wins.
    const racedId = useWorkspaceStore.getState().addWorkspace(standardTemplate, {
      folderPath: '/Users/example/generated-title-raced',
      background: true,
    })
    const racedInterim = useWorkspaceStore
      .getState()
      .autoTitleWorkspaceFromPrompt(racedId, 'add a retry to the uploader')
    assert.equal(racedInterim, 'Add a retry to the uploader')
    useWorkspaceStore.getState().renameWorkspace(racedId, 'Uploader retries')
    assert.equal(
      useWorkspaceStore.getState().applyGeneratedWorkspaceTitle(racedId, 'Uploader gains a retry', racedInterim),
      false,
      'a late answer never overwrites a name typed by hand in the meantime',
    )
    assert.equal(nameOf(racedId), 'Uploader retries', 'the hand-typed name stands')

    // replacing === null — the heuristic applied nothing — so the gate is the
    // lock rather than the name: it lands while the workspace is still on its
    // app-minted name, and never after something has locked it.
    const unlockedId = useWorkspaceStore.getState().addWorkspace(standardTemplate, {
      folderPath: '/Users/example/generated-title-unlocked',
      background: true,
    })
    assert.equal(useWorkspaceStore.getState().autoTitleWorkspaceFromPrompt(unlockedId, '/backlog'), null)
    assert.notEqual(lockedOf(unlockedId), true, 'the rejected prompt left it unlocked')
    assert.equal(
      useWorkspaceStore.getState().applyGeneratedWorkspaceTitle(unlockedId, 'Backlog sweep', null),
      true,
      'with nothing to replace, an unlocked workspace takes the generated title',
    )
    assert.equal(nameOf(unlockedId), 'Backlog sweep')
    assert.equal(lockedOf(unlockedId), true)
    assert.equal(
      useWorkspaceStore.getState().applyGeneratedWorkspaceTitle(unlockedId, 'A second sweep', null),
      false,
      'and never again once the name is locked',
    )
    assert.equal(nameOf(unlockedId), 'Backlog sweep')

    // The model answered with the name already showing: nothing to do, and the
    // caller is told nothing happened rather than that a rename occurred.
    assert.equal(
      useWorkspaceStore.getState().applyGeneratedWorkspaceTitle(unlockedId, 'Backlog sweep', 'Backlog sweep'),
      false,
      'a generated title equal to the current name is a no-op',
    )
    assert.equal(nameOf(unlockedId), 'Backlog sweep')

    // An empty answer is refused here too, not only by the service's guardrail.
    const blankId = useWorkspaceStore.getState().addWorkspace(standardTemplate, {
      folderPath: '/Users/example/generated-title-blank',
      background: true,
    })
    assert.equal(useWorkspaceStore.getState().applyGeneratedWorkspaceTitle(blankId, '   ', null), false)
    assert.notEqual(lockedOf(blankId), true, 'a blank answer neither renames nor locks')

    // The workspace was closed while the model was thinking.
    assert.equal(
      useWorkspaceStore.getState().applyGeneratedWorkspaceTitle('workspace-that-is-gone', 'Anything', null),
      false,
      'an unknown workspace id is refused, not fatal',
    )
  }

  // Settled chats (2026-09-07): the hand decisions, the sweep, and the wake.
  {
    const DAY = 24 * 60 * 60 * 1000
    const settleId = useWorkspaceStore.getState().addWorkspace(standardTemplate, {
      folderPath: '/Users/example/settle',
      background: true,
    })
    // Adding activates, so hand the selection to a second row: the sweep's
    // active-row exemption is asserted separately below.
    const lookedAtId = useWorkspaceStore.getState().addWorkspace(standardTemplate, {
      folderPath: '/Users/example/settle-looked-at',
      background: true,
    })
    useWorkspaceStore.getState().setActiveWorkspace(lookedAtId)
    const rowOf = (id: string) => useWorkspaceStore.getState().workspaces.find((w) => w.id === id)!
    // The pull request list has been read and holds none: absent, it is not
    // yet read, and the keep for open pull requests holds every row.
    const reconcile = (now: number, busyIds: string[] = [], heldIds: string[] = []) =>
      useWorkspaceStore.getState().reconcileWorkspaceSettlement({
        now,
        busyIds: new Set(busyIds),
        heldIds: new Set(heldIds),
        pullRequestsByWorkspaceId: {},
      })
    const activeIds = () =>
      new Set([
        useWorkspaceStore.getState().activeWorkspaceId,
        ...useWorkspaceStore.getState().workspaceWindows.map((w) => w.activeWorkspaceId),
      ])
    assert.equal(activeIds().has(settleId), false, 'the fixture row is not the active row of any window')
    const bornAt = rowOf(settleId).createdAt

    // Auto-settle is off until the person switches it on from the row menu.
    reconcile(bornAt + 30 * DAY)
    assert.equal(rowOf(settleId).settledAt ?? null, null, 'a chat nobody switched Auto-settle on for never settles')
    useWorkspaceStore.getState().setWorkspaceAutoSettle(settleId, true)
    assert.equal(rowOf(settleId).autoSettleEnabled, true, 'the switch records the opt-in')

    // Too recent: the sweep leaves it.
    reconcile(bornAt + DAY)
    assert.equal(rowOf(settleId).settledAt ?? null, null, 'a day-old row does not settle')

    // Old enough, but wearing the unseen finished mark: held, not settled.
    reconcile(bornAt + 4 * DAY, [], [settleId])
    assert.equal(rowOf(settleId).settledAt ?? null, null, 'the unseen mark holds a row out of the shelf')

    // Idle three days, but the pull requests not read yet: an open one may be
    // among them, so the keep holds it…
    useWorkspaceStore
      .getState()
      .reconcileWorkspaceSettlement({ now: bornAt + 4 * DAY, busyIds: new Set(), heldIds: new Set() })
    assert.equal(rowOf(settleId).settledAt ?? null, null, 'an unread pull request list holds a row with the keep on')
    // …and an open one, once read, holds it too.
    const openPullRequest = {
      url: 'https://github.com/acme/app/pull/1',
      repoKey: 'github.com/acme/app',
      repoName: 'app',
      number: 1,
      title: 'Fix it',
      state: 'open' as const,
      isDraft: false,
      openedAt: bornAt,
      stateAt: bornAt,
    }
    useWorkspaceStore.getState().reconcileWorkspaceSettlement({
      now: bornAt + 4 * DAY,
      busyIds: new Set(),
      heldIds: new Set(),
      pullRequestsByWorkspaceId: { [settleId]: [openPullRequest] },
    })
    assert.equal(rowOf(settleId).settledAt ?? null, null, 'an open pull request holds a quiet row')
    useWorkspaceStore.getState().setKeepChatsWithOpenPullRequest(false)
    useWorkspaceStore.getState().reconcileWorkspaceSettlement({
      now: bornAt + 4 * DAY,
      busyIds: new Set(),
      heldIds: new Set(),
      pullRequestsByWorkspaceId: { [settleId]: [openPullRequest] },
    })
    // With the keep off, idle three days settles it all the same, quietly.
    assert.equal(rowOf(settleId).settledAt, bornAt + 4 * DAY, 'the sweep stamps settledAt')
    useWorkspaceStore.getState().setKeepChatsWithOpenPullRequest(true)
    assert.equal(useWorkspaceStore.getState().appSettings.keepChatsWithOpenPullRequest, true)
    assert.equal(rowOf(settleId).settledOverride ?? null, null, 'the sweep records no hand decision')

    // Wanting the person (a prompt landed after the sweep's reading): a
    // sweep-settled row wakes for it.
    reconcile(bornAt + 5 * DAY, [], [settleId])
    assert.equal(rowOf(settleId).settledAt ?? null, null, 'a sweep-settled row that wants the person wakes')
    reconcile(bornAt + 5 * DAY)
    assert.equal(typeof rowOf(settleId).settledAt, 'number', 'and settles again once nothing wants them')

    // Busy again: it wakes.
    reconcile(bornAt + 5 * DAY, [settleId])
    assert.equal(rowOf(settleId).settledAt ?? null, null, 'a busy resting row wakes')

    // A hand Un-settle holds against the sweep until real activity.
    useWorkspaceStore.getState().setWorkspaceSettled(settleId, true)
    assert.equal(typeof rowOf(settleId).settledAt, 'number', 'Settle stamps')
    assert.equal(rowOf(settleId).settledOverride, 'settled', 'and records the decision')
    useWorkspaceStore.getState().setWorkspaceSettled(settleId, false)
    assert.equal(rowOf(settleId).settledAt ?? null, null, 'Un-settle clears the stamp')
    assert.equal(rowOf(settleId).settledOverride, 'active', 'and holds the row active')
    reconcile(bornAt + 30 * DAY)
    assert.equal(rowOf(settleId).settledAt ?? null, null, 'the sweep honours the hold, however old the row')
    useWorkspaceStore.getState().setWorkspaceSettled(settleId, true)
    reconcile(bornAt + 30 * DAY, [], [settleId])
    assert.equal(typeof rowOf(settleId).settledAt, 'number', 'a hand Settle survives a row that wants the person')
    useWorkspaceStore.getState().setWorkspaceSettled(settleId, false)

    // Typing spends the hold, and the next sweep applies the usual rule.
    useWorkspaceStore.getState().recordWorkspaceTerminalActivity(settleId, bornAt + 30 * DAY)
    assert.equal(rowOf(settleId).settledOverride ?? null, null, 'a keystroke clears the hand decision')
    reconcile(bornAt + 34 * DAY)
    assert.equal(typeof rowOf(settleId).settledAt, 'number', 'three idle days after the keystroke, it settles again')

    // A replayed keystroke — the same stamp the store already holds — is not
    // input: the sessions are re-listed on every window mount with the stamps
    // they had, and that must not wake a row settled after the person typed.
    useWorkspaceStore.getState().recordWorkspaceTerminalActivity(settleId, bornAt + 30 * DAY)
    assert.equal(typeof rowOf(settleId).settledAt, 'number', 'a replayed input stamp does not wake a settled row')

    // Typing into a settled row wakes it.
    useWorkspaceStore.getState().recordWorkspaceTerminalActivity(settleId, bornAt + 34 * DAY + 1)
    assert.equal(rowOf(settleId).settledAt ?? null, null, 'typing wakes a settled row')
    assert.equal(rowOf(settleId).settledOverride ?? null, null, 'and leaves no hand decision behind')

    // The message clock — what the sidebar orders by — only ever advances, so a
    // re-listed session replaying a prompt it already reported cannot deal the
    // list a different order than the one the person left.
    useWorkspaceStore.getState().recordWorkspaceUserMessage(settleId, bornAt + 34 * DAY)
    assert.equal(rowOf(settleId).lastUserMessageAt, bornAt + 34 * DAY, 'the message is recorded')
    useWorkspaceStore.getState().recordWorkspaceUserMessage(settleId, bornAt + 30 * DAY)
    assert.equal(rowOf(settleId).lastUserMessageAt, bornAt + 34 * DAY, 'an older reading never rolls it back')

    // A message is the person returning, so it wakes a resting row the way a
    // keystroke does — and a replayed stamp, which is not a new message, does not.
    useWorkspaceStore.getState().setWorkspaceSettled(settleId, true)
    useWorkspaceStore.getState().recordWorkspaceUserMessage(settleId, bornAt + 34 * DAY)
    assert.equal(typeof rowOf(settleId).settledAt, 'number', 'a replayed message stamp does not wake a settled row')
    useWorkspaceStore.getState().recordWorkspaceUserMessage(settleId, bornAt + 34 * DAY + 1)
    assert.equal(rowOf(settleId).settledAt ?? null, null, 'saying something wakes a settled row')
    assert.equal(rowOf(settleId).settledOverride ?? null, null, 'and leaves no hand decision behind')

    // The agent's turn end is activity for the idle clock, but never a wake.
    useWorkspaceStore.getState().setWorkspaceSettled(settleId, true)
    useWorkspaceStore.getState().recordWorkspaceTurnEnd(settleId, bornAt + 35 * DAY)
    assert.equal(rowOf(settleId).lastTurnEndedAt, bornAt + 35 * DAY, 'the turn end is recorded')
    assert.equal(typeof rowOf(settleId).settledAt, 'number', 'an agent finishing is not the person returning')
    useWorkspaceStore.getState().setWorkspaceSettled(settleId, false)

    // The active row of a window never settles under the person.
    const activeId = useWorkspaceStore.getState().activeWorkspaceId
    assert.ok(activeId, 'the fixture store has an active row')
    const activeBornAt = rowOf(activeId!).createdAt
    useWorkspaceStore.getState().setWorkspaceAutoSettle(activeId!, true)
    reconcile(activeBornAt + 30 * DAY)
    assert.equal(rowOf(activeId!).settledAt ?? null, null, 'the active row is exempt from the sweep')
  }

  // --- snooze: the store's half of "not now" (snooze, 2026-09-10) -------------
  {
    const HOUR = 60 * 60 * 1000
    const snoozeId = useWorkspaceStore.getState().addWorkspace(standardTemplate, { name: 'Snoozer' })
    const row = (): Workspace => useWorkspaceStore.getState().workspaces.find((w) => w.id === snoozeId)!
    const wakeAt = Date.now() + 2 * HOUR

    assert.equal(row().snoozedUntil ?? null, null, 'a new chat carries no snooze')

    useWorkspaceStore.getState().setWorkspaceSnoozed(snoozeId, wakeAt)
    assert.equal(row().snoozedUntil, wakeAt, 'Snooze stamps the wake time, and that is the whole record of it')

    // The record only. Suspending the chat's terminals is the sidebar's half.
    assert.equal(row().settledAt ?? null, null, 'sleeping is not resting')

    useWorkspaceStore.getState().setWorkspaceSnoozed(snoozeId, null)
    assert.equal(row().snoozedUntil ?? null, null, 'Wake clears the stamp')

    // Waking a row that never slept is a no-op, not a write: the menu only
    // offers it on a sleeping row, but nothing stops a caller asking twice.
    const untouched = row()
    useWorkspaceStore.getState().setWorkspaceSnoozed(snoozeId, null)
    assert.equal(row(), untouched, 'a second Wake leaves the row alone')

    // Opening the chat spends the snooze — a running one, because you are here
    // now, and a spent one, because the Woke mark has nothing left to say.
    useWorkspaceStore.getState().setWorkspaceSnoozed(snoozeId, wakeAt)
    useWorkspaceStore.getState().setActiveWorkspace(snoozeId)
    assert.equal(row().snoozedUntil ?? null, null, 'opening a sleeping chat wakes it')
    assert.equal(useWorkspaceStore.getState().activeWorkspaceId, snoozeId, 'and it is the active chat')

    // Rest supersedes sleep: settling a sleeping row tombstones the snooze, so
    // it cannot expire into a Woke mark on a row nobody woke.
    useWorkspaceStore.getState().setWorkspaceSnoozed(snoozeId, wakeAt)
    useWorkspaceStore.getState().setWorkspaceSettled(snoozeId, true)
    assert.equal(typeof row().settledAt, 'number', 'Settle stamps rest')
    assert.equal(row().snoozedUntil ?? null, null, 'and clears the sleep underneath it')
    useWorkspaceStore.getState().setWorkspaceSettled(snoozeId, false)

    useWorkspaceStore.getState().setWorkspaceSnoozed('no-such-workspace', wakeAt)
  }

  // --- lastActiveAgentId: the Diff surfaces' default (agent changelists) -------
  {
    const workspaceId = useWorkspaceStore.getState().addWorkspace(standardTemplate, {
      name: 'Last active agent',
    })
    const row = (): Workspace => useWorkspaceStore.getState().workspaces.find((w) => w.id === workspaceId)!

    assert.equal(row().lastActiveAgentId ?? null, null, 'a new workspace remembers no agent')

    useWorkspaceStore.getState().setLastActiveAgent(workspaceId, 'agent-1')
    assert.equal(row().lastActiveAgentId, 'agent-1')

    // Idempotent: the layout calls this on every selection change and on mount,
    // so the same id twice must not be a second write.
    const before = row()
    useWorkspaceStore.getState().setLastActiveAgent(workspaceId, 'agent-1')
    assert.equal(row(), before, 'a repeat of the same agent leaves the row untouched')

    useWorkspaceStore.getState().setLastActiveAgent(workspaceId, '  agent-2  ')
    assert.equal(row().lastActiveAgentId, 'agent-2', 'ids are trimmed')

    useWorkspaceStore.getState().setLastActiveAgent(workspaceId, '   ')
    assert.equal(row().lastActiveAgentId, null, 'a blank id is no agent, not an agent named blank')

    useWorkspaceStore.getState().setLastActiveAgent(workspaceId, 'agent-3')
    useWorkspaceStore.getState().setLastActiveAgent(workspaceId, null)
    assert.equal(row().lastActiveAgentId, null, 'and it can be cleared outright')

    useWorkspaceStore.getState().setLastActiveAgent('no-such-workspace', 'agent-1')
  }

  console.log('workspacesSlice.test.ts: ok')
})

test('a chat worktree given back is marked on its marker, and the mark comes off when it is back', () => {
  const id = 'worktree-reclaim-chat'
  const marker = { branch: 'agent/chat-ab12', baseRef: 'HEAD', repoRoot: '/Users/dev/app' }
  useWorkspaceStore.setState((state) => ({
    workspaces: [
      ...state.workspaces,
      { id, folderPath: '/Users/dev/.sprintengine-worktrees/app/chat-ab12', worktree: marker } as unknown as Workspace,
    ],
  }))
  const markerOf = () => useWorkspaceStore.getState().workspaces.find((workspace) => workspace.id === id)?.worktree
  useWorkspaceStore.getState().setWorkspaceWorktreeReclaimed(id, 42)
  assert.deepEqual(markerOf(), { ...marker, reclaimedAt: 42 }, 'the branch and project are kept beside the stamp')
  useWorkspaceStore.getState().setWorkspaceWorktreeReclaimed(id, null)
  assert.deepEqual(markerOf(), marker, 'cleared, not set to null, so the marker reads as before')
  useWorkspaceStore.setState((state) => ({ workspaces: state.workspaces.filter((workspace) => workspace.id !== id) }))
})
