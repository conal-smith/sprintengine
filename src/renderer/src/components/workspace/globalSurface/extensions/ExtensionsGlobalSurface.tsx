// The Extensions modal: two catalogues behind one surface id.
//
// A modal since 2026-11-03 (owner ruling): `openGlobalSurface` opens this id
// over whatever holds the card region, and a switch in the dialog's title bar
// moves between the two views the drawer's rows also open.
//
// Source-tabs ruling (2026-09-05). The door used to be a rail of seven rows —
// Featured, Plugins, MCP servers, Skills, Automations, Modules, Agent CLIs —
// over a canvas per row. It is two views now, each the same page:
//
//   Plugins · Skills
//
// and the things that left are each somewhere better: the Automations shelf
// went with automations themselves, which became scheduled agents, Modules are
// switches in Settings → Modules (they were offered in two shapes on two
// surfaces), the automation server is a Settings concern rather than a
// catalogue row, Featured ranked the catalogue by a fact about the machine,
// and Agent CLIs are Settings ▸ Agents (owner ruling 2026-09-25), which lists
// each machine's CLIs with their install, update and command override.
//
// What this file owns is what the views SHARE and nothing else: the reads (the
// MCP catalogue, the marketplace registry, the sources and their scans), the
// two ways a source is added and the one way an extension is installed from
// its own repository, which view the drawer is standing on, and the
// tab that view is on — because the ruling says the chosen source survives a
// switch between Plugins and Skills.

import React, { useCallback, useEffect, useMemo, useState, type JSX } from 'react'

import type { McpServerConfig, WorkspaceSkill } from '../../../../../../shared/electron-api'
import { LOCAL_SKILL_SOURCE_ID_PREFIX, type SkillHarness, type SkillSource } from '../../../../../../shared/skills'
import { SKILL_PACK_HARNESSES } from '../../../../../../shared/skill-harnesses'
import type { AgentComposerConnector } from '../../agentComposer/useAgentComposer'
import { useWorkspaceStore } from '../../../../store/workspaceStore'
import { useConnectorSources } from '../../../panels/ConnectorsPanel/useConnectorSources'
import { getExtensionsSurfaceHost } from './extensionsSurfaceHost'
import { PluginsCatalogue } from './plugins/PluginsCatalogue'
import { AddSkillSourceModal } from './skills/AddSkillSourceModal'
import { SkillsCatalogue } from './skills/SkillsCatalogue'
import { useSkillSources } from './skills/useSkillSources'
import { landingFromTarget, targetNamesPlace, targetTabId, type CatalogueLanding } from './catalogue/catalogueLanding'
import { CatalogueViewSwitchContext } from './catalogue/catalogueViewSwitch'
import {
  consumePendingExtensionsSurfaceTarget,
  peekPendingExtensionsSurfaceTarget,
  subscribeExtensionsSurfaceTarget,
  EXTENSIONS_DRAWER_VIEWS,
  type ExtensionsDrawerView,
  type ExtensionsSurfaceTarget,
} from './extensionsSurfaceTarget'
import { publishSurfaceView } from '../../surfaceView'
import { InstallFromGitHubDialog } from '../../../extensions/InstallFromGitHubDialog'

export default function ExtensionsGlobalSurface(): JSX.Element {
  const activeWorkspaceRoot = useWorkspaceStore(
    (s) => s.workspaces.find((workspace) => workspace.id === s.activeWorkspaceId)?.folderPath ?? null,
  )
  const removeMcpServer = useWorkspaceStore((s) => s.removeMcpServer)
  const openSettingsOverlay = useWorkspaceStore((s) => s.openSettingsOverlay)
  const connectors = useConnectorSources(activeWorkspaceRoot)
  const sources = useSkillSources(activeWorkspaceRoot)

  // What this machine has, for the harness directories below.
  const cliAvailability = useWorkspaceStore((s) => s.cliAvailability)
  const pluginCatalogEntries = useWorkspaceStore((s) => s.pluginCatalogEntries)

  // The harness directories a plugin's skills fan out to: the shared `.agents`
  // dir plus every natively skill-capable CLI this machine has — the
  // main-process rule (skill-harness-targets.ts), read from the detection the
  // door already holds so the pane can say what will land where.
  const harnesses = useMemo<SkillHarness[]>(() => {
    const wanted = new Set<SkillHarness>(['agents'])
    for (const entry of pluginCatalogEntries) {
      if (entry.skillIntegration?.support !== 'native') continue
      if (cliAvailability[entry.id]?.installed !== true) continue
      const harness = entry.skillIntegration.harnessId as SkillHarness
      if (SKILL_PACK_HARNESSES.includes(harness)) wanted.add(harness)
    }
    return SKILL_PACK_HARNESSES.filter((harness) => wanted.has(harness))
  }, [pluginCatalogEntries, cliAvailability])

  // Seeded from the latch, not from the default: the first publish below is
  // what the host reads as "which row is on screen", and a default that was
  // corrected an effect later had already read the Plugins news on a click
  // that asked for Skills (review, 2026-09-09).
  const [view, setView] = useState<ExtensionsDrawerView>(
    () => peekPendingExtensionsSurfaceTarget()?.view ?? EXTENSIONS_DRAWER_VIEWS.plugins,
  )
  // The open tab, held ACROSS views: Installed, or a source id. The ruling asks
  // that the chosen source survive a switch between Plugins and Skills, and a
  // source id is what "the chosen source" is — so one piece of state answers
  // both "which tab" and "which source".
  //
  // Seeded from the latch for the same reason the view is, plus one of its
  // own: a catalogue reads the source of the tab it is standing on the moment
  // it mounts (ensureScan), and a default tab that was corrected an effect
  // later had already started a network read of the official marketplace on
  // a deep link that asked for a different source.
  const [tabId, setTabId] = useState<string | null>(() => {
    const pending = peekPendingExtensionsSurfaceTarget()
    return pending ? targetTabId(pending) : null
  })
  // The plugin or skill a deep link asked the open view to land on, until the
  // view reports it has (catalogueLanding.ts). Held here because the target
  // arrives here; resolved in the catalogue because the scan it needs is read
  // there.
  const [landing, setLanding] = useState<CatalogueLanding | null>(() => {
    const pending = peekPendingExtensionsSurfaceTarget()
    return pending ? landingFromTarget(pending) : null
  })
  // The search box's query, held ACROSS tabs and views (skills-everywhere,
  // 2026-09-10). A query reads every source at once now, so switching tab or
  // view under it changes nothing about what it means — and clearing it on
  // every switch was how a person typed the same word four times to look in
  // four places. It is cleared from the box itself (its cross, or Escape),
  // and by a deep link that names a place, below.
  const [query, setQuery] = useState('')
  // The repository the Add-from-GitHub modal opens on ('' for an empty field).
  const [addRepo, setAddRepo] = useState<string | null>(null)
  // Install extension from GitHub: open or not. The dialog owns its own URL.
  const [installFromGitHub, setInstallFromGitHub] = useState(false)
  const [addError, setAddError] = useState<string | null>(null)

  const applyTarget = useCallback((target: ExtensionsSurfaceTarget) => {
    setView(target.view)
    const tab = targetTabId(target)
    if (tab) setTabId(tab)
    // A newer target supersedes any landing still in flight, including with
    // nothing: a drawer click that asks only for a view is the person moving
    // on from wherever the last link was taking them.
    setLanding(landingFromTarget(target))
    // A bare view switch keeps the query; a target that names a tab, a plugin
    // or a skill clears it, because a results list would otherwise stand
    // between the person and the place they asked to be taken.
    if (targetNamesPlace(target)) setQuery('')
  }, [])
  const landed = useCallback(() => setLanding(null), [])

  // Deep-link: drain the latch on mount and subscribe live, so entry points
  // land on the right view whether the door was already open or just mounted.
  useEffect(() => {
    const pending = consumePendingExtensionsSurfaceTarget()
    if (pending) applyTarget(pending)
    return subscribeExtensionsSurfaceTarget((target) => {
      consumePendingExtensionsSurfaceTarget()
      applyTarget(target)
    })
  }, [applyTarget])

  // Say which of the Extensions drawer's rows this surface is standing on
  // (drawer ruling, 2026-09-05), so exactly one of Plugins / Skills reads
  // selected.
  useEffect(() => {
    publishSurfaceView('extensions', view)
  }, [view])
  // Closing takes the selection with it: a drawer row must not stay lit over a
  // card region the surface no longer owns. Deliberately its OWN effect with an
  // empty dep list — as the cleanup of the publish above it, it ran on every
  // in-surface move, publishing `null` and then the new view in one commit, and
  // the drawer's selected row blinked off and back on every time.
  useEffect(() => () => publishSurfaceView('extensions', null), [])

  // Host actions, read at call time from the seam WorkspaceManager fills. A
  // missing host (tests, detached mounts) no-ops rather than throwing.
  const launchConnector = useCallback((connector: AgentComposerConnector) => {
    getExtensionsSurfaceHost()?.onLaunchConnector(connector)
  }, [])
  const useSkillInNewAgent = useCallback((skill: WorkspaceSkill) => {
    getExtensionsSurfaceHost()?.onUseSkillInNewAgent(skill)
  }, [])

  const addMcpServers = useCallback(
    (servers: McpServerConfig[]) => {
      for (const server of servers) connectors.upsertMcpServer(server)
    },
    [connectors],
  )
  /**
   * Servers an uninstall takes back — and out of the workspace's own config.
   *
   * Forgetting them in settings is not enough: `mcp-config-service` prunes a
   * server from a CLI's config only while the settings still name it, so the
   * automatic sync that follows this change sees nothing to remove and the
   * entry sits in `.mcp.json` after the plugin that declared it is gone. The
   * explicit sync says which ids to forget, which is what actually deletes them
   * (backlog/2026-09-06-a-github-marketplace-plugin-installs-nothing-for-claude-code.md).
   */
  const removeMcpServers = useCallback(
    (serverIds: string[]) => {
      if (serverIds.length === 0) return
      const settings = connectors.mcpSettings
      const servers = { ...settings.servers }
      for (const id of serverIds) delete servers[id]
      for (const id of serverIds) removeMcpServer(id)
      if (!activeWorkspaceRoot || !settings.syncEnabled || typeof window.api.mcpSync !== 'function') return
      void window.api
        .mcpSync({
          workspaceRoot: activeWorkspaceRoot,
          settings: { ...settings, servers },
          forgetServerIds: [...serverIds],
        })
        .catch(() => {})
    },
    [activeWorkspaceRoot, connectors.mcpSettings, removeMcpServer],
  )

  // The query is deliberately KEPT: the tab is selected, which is what reads
  // the new source, and a search that was on when the person went and added a
  // source is a search they want the new source's answer to.
  const openAddedSource = useCallback(
    (source: SkillSource) => {
      sources.refreshSources()
      setTabId(source.id)
    },
    [sources],
  )

  /**
   * "Add from folder…": a folder on this machine. The picker is the app's own
   * open-folder dialog, and the scan is the same rule a repository gets — the
   * source kind differs, the reading does not. The default destination is the
   * user's skills folder (`~/.sprintengine/skills`), created lazily the first time
   * this control opens.
   */
  const addFromFile = useCallback(async (): Promise<void> => {
    setAddError(null)
    if (typeof window.api.skillsAddLocalSource !== 'function') {
      setAddError('Adding a folder needs a newer app build. Update and restart.')
      return
    }
    const defaultPath =
      typeof window.api.ensureDefaultUserSkillsDir === 'function'
        ? await window.api.ensureDefaultUserSkillsDir()
        : undefined
    const path = await window.api.openDir(defaultPath ? { defaultPath } : undefined)
    if (!path) return
    // No `replace`: a folder already in the list is not an error to report but
    // a tab to open — "you have this one, here it is" — and Sync on its head
    // line is what re-reads it. The id is the prefix plus the path, which is
    // the whole of a folder source's identity.
    const result = await window.api.skillsAddLocalSource({ path })
    if (!result.ok) {
      const id = `${LOCAL_SKILL_SOURCE_ID_PREFIX}${path}`
      if (sources.sources.some((source) => source.id === id)) {
        setTabId(id)
        return
      }
      setAddError(result.message)
      return
    }
    openAddedSource(result.source)
  }, [openAddedSource, sources.sources])

  const add = useMemo(
    () => ({
      onAddFromFile: () => void addFromFile(),
      onAddFromGitHub: () => setAddRepo(''),
      onInstallExtensionFromGitHub: () => setInstallFromGitHub(true),
    }),
    [addFromFile],
  )

  // A tab change and nothing else: the query survives it (see its declaration).
  const selectTab = useCallback((next: string) => {
    setTabId(next)
  }, [])

  // The modal's Plugins / Skills switch (owner ruling 2026-11-03). A bare
  // view change, as a drawer row is: the source and the query survive it.
  const viewSwitch = useMemo(
    () => ({
      view,
      onChange: (next: ExtensionsDrawerView) => {
        setView(next)
        setLanding(null)
      },
    }),
    [view],
  )

  return (
    <CatalogueViewSwitchContext.Provider value={viewSwitch}>
      {view === EXTENSIONS_DRAWER_VIEWS.skills ? (
        <SkillsCatalogue
          sources={sources}
          workspaceRoot={activeWorkspaceRoot}
          activeTabId={tabId}
          onSelectTab={selectTab}
          query={query}
          onQueryChange={setQuery}
          landing={landing}
          onLanded={landed}
          add={add}
          addNotice={addError}
          onDismissAddNotice={() => setAddError(null)}
          onUseSkillInNewAgent={useSkillInNewAgent}
        />
      ) : (
        <PluginsCatalogue
          sources={sources}
          connectors={connectors}
          workspaceRoot={activeWorkspaceRoot}
          harnesses={harnesses}
          activeTabId={tabId}
          onSelectTab={selectTab}
          query={query}
          onQueryChange={setQuery}
          landing={landing}
          onLanded={landed}
          add={add}
          addNotice={addError}
          onDismissAddNotice={() => setAddError(null)}
          onAddMcpServers={addMcpServers}
          onRemoveMcpServers={removeMcpServers}
          onLaunchConnector={launchConnector}
        />
      )}
      <AddSkillSourceModal
        open={addRepo !== null}
        initialRepo={addRepo ?? ''}
        addedRepos={sources.sources.map((source) => source.repo)}
        onClose={() => setAddRepo(null)}
        onAdded={openAddedSource}
        onRemoved={() => sources.refreshSources()}
        onConfigureGitHubToken={() => openSettingsOverlay({ initialTab: 'github' })}
      />
      <InstallFromGitHubDialog
        open={installFromGitHub}
        onClose={() => setInstallFromGitHub(false)}
        workspaceRoot={activeWorkspaceRoot}
        mcpSettings={connectors.mcpSettings}
        onInstalled={(result) => {
          // Servers the install wrote show up in the Installed tab without a reload.
          if (result.mcpSettings) addMcpServers(Object.values(result.mcpSettings.servers))
        }}
        // A repository of skills pasted here goes where skill sources are added,
        // with the URL carried over.
        onAddSkillSource={(url) => {
          setInstallFromGitHub(false)
          setAddRepo(url)
        }}
      />
    </CatalogueViewSwitchContext.Provider>
  )
}
