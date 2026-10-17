// Skills: Installed, then one tab per source, the repository's folders as the
// groups inside it.
//
// Source-tabs ruling (2026-09-05). What went with the nested Sources rail:
//
//   - The per-source layout shapes (solo / flat / grouped / search-first).
//     Deciding how much of a source to put on screen at once is the pager's
//     job now. Grouping by the folders the repository actually keeps its
//     skills in survives, in `deriveSkillCatalogueGroups`.
//   - Batch selection. The row idiom the ruling names carries ONE control, so
//     a row installs itself; a checkbox column and a footer "Install 6" is a
//     second interaction model on the same rows.
//
// Reading a skill: the row opens `SkillPage` as a dialog over the list, which
// is where Install lives for the skill in hand.

import React, { useCallback, useEffect, useMemo, useState, type JSX } from 'react'

import {
  scanPlugins,
  skillDirName,
  type ScanResult,
  type ScannedPlugin,
  type SkillSource,
} from '../../../../../../../shared/skills'
import { GhostButton, InlineNotice, Spinner, StatusDot, Tooltip, TruncatedText } from '../../../../ui'
import { ExtensionIcon } from '../../../../ui/ExtensionIcon'
import { ConnectorRow } from '../../../../panels/ConnectorsPanel/ConnectorRow'
import { InstalledExtensionsInventory } from '../../../../panels/ConnectorsPanel/InstalledExtensionsInventory'
import { useWorkspaceStore } from '../../../../../store/workspaceStore'
import type { SkillInstallScope, WorkspaceSkill } from '../../../../../../../shared/electron-api'
import {
  CatalogueHead,
  CatalogueSurface,
  type CatalogueAddMenu,
  type CatalogueSection,
} from '../catalogue/CatalogueSurface'
import {
  catalogueMonogram,
  catalogueTabLabel,
  deriveCatalogueTabs,
  resolveCatalogueTab,
  INSTALLED_TAB_ID,
  type CatalogueCount,
} from '../catalogue/catalogueTabs'
import { RecommendedSources } from '../catalogue/RecommendedSources'
import { SourceAvatar } from '../catalogue/SourceAvatar'
import { extensionIconProps, pluginsByFolder, skillArtwork } from '../catalogue/pluginArtwork'
import { SourceTabActions } from '../catalogue/SourceTabActions'
import { resolveCatalogueLanding, type CatalogueLanding } from '../catalogue/catalogueLanding'
import {
  crossSourceStateLine,
  isCrossSourceQuery,
  searchAcrossSources,
  unreadSourcesLine,
} from '../catalogue/catalogueSearch'
import { SkillPage } from './SkillPage'
import type { SkillSourcesState } from './useSkillSources'
import {
  bundledScanLine,
  deriveInstallAvailability,
  deriveSkillCatalogueGroups,
  findSkill,
  sourceDisplayName,
  summarizeInstallRun,
  summarizeSyncRun,
  type SkillListItem,
} from './skillsSurfaceModel'

const MISSING_API_MESSAGE = 'Skills need an app restart before they are available.'

/** The row's icon slot, in one place: the artwork ladder asks for its size. */
const ROW_ICON_SIZE = 36

/** The source's mark before a section heading, when the sections are sources. */
const SECTION_AVATAR_SIZE = 22

/**
 * A row names its SOURCE: with a query on, the rows come from every source at
 * once, and the one that opens or installs has to be the one the row came
 * from, not the tab that happens to be selected. '' is a skill the workspace
 * holds that no source in the list accounts for — written by hand, or from a
 * source since removed — which under a search lists as installed and nothing
 * more, because there is no scan to read it from.
 */
type SkillRow = { sourceId: string; item: SkillListItem }

/** What names a row to React, for the list item the surface wraps it in. */
function skillRowKey(row: SkillRow): string {
  return `${row.sourceId} ${row.item.skillId}`
}

/** The Installed section's source id: no source at all. */
const NO_SOURCE = ''

export function SkillsCatalogue({
  sources,
  workspaceRoot,
  activeTabId,
  onSelectTab,
  query,
  onQueryChange,
  landing = null,
  onLanded,
  add,
  addNotice,
  onDismissAddNotice,
  onUseSkillInNewAgent,
}: {
  sources: SkillSourcesState
  workspaceRoot: string | null
  activeTabId: string | null
  onSelectTab: (tabId: string) => void
  query: string
  onQueryChange: (value: string) => void
  /**
   * A deep link's skill to open once its source's scan is in hand
   * (catalogueLanding.ts). The door holds it; this view resolves it and calls
   * `onLanded` when it has, landed or missed.
   */
  landing?: CatalogueLanding | null
  onLanded?: () => void
  add: CatalogueAddMenu
  /** A source that could not be added — stated where the person is looking. */
  addNotice: string | null
  onDismissAddNotice: () => void
  onUseSkillInNewAgent: (skill: WorkspaceSkill) => void
}): JSX.Element {
  // The open skill, by the source it came from and its id within it.
  const [openSkill, setOpenSkill] = useState<{ sourceId: string; skillId: string } | null>(null)
  const [installing, setInstalling] = useState<string | null>(null)
  const [report, setReport] = useState<{ sourceId: string; outcome: string | null; error: string | null } | null>(null)
  const [inventoryNonce, setInventoryNonce] = useState(0)
  const [skillMessage, setSkillMessage] = useState<string | null>(null)
  // A deep link that could not be honoured in full, said once where the
  // person landed instead.
  const [landingNotice, setLandingNotice] = useState<string | null>(null)
  const moduleOverrides = useWorkspaceStore((s) => s.appSettings.modules)

  const counts = useMemo<Record<string, CatalogueCount>>(() => {
    const map: Record<string, CatalogueCount> = {}
    for (const source of sources.sources) {
      const load = sources.scans[source.id]
      map[source.id] =
        !load || load.status === 'loading'
          ? { status: 'loading' }
          : load.status === 'error'
            ? { status: 'error', message: load.message }
            : { status: 'ready', count: load.scan.skills.length }
    }
    return map
  }, [sources.scans, sources.sources])

  const tabs = deriveCatalogueTabs({
    kind: 'skills',
    sources: sources.sources,
    // Installed skills are workspace-scoped and read over IPC by the inventory
    // below; this is the count the same read already gave the door.
    installedCount: sources.installedRead.status === 'ready' ? sources.installedDirNames.size : null,
    counts,
  })
  const tabId = resolveCatalogueTab(tabs, activeTabId)
  const activeSource = tabs.find((tab) => tab.id === tabId)?.source ?? null
  const activeScan = activeSource ? sources.scans[activeSource.id] : undefined
  const scan = activeScan && activeScan.status === 'ready' ? activeScan.scan : null
  // A query reads every source at once (catalogueSearch.ts); an empty box is
  // the tab, as before.
  const searching = isCrossSourceQuery(query)

  // Every source and every ready scan by id: a row names its source, and the
  // open page, the install and the artwork are all looked up from the row's
  // source rather than the tab's.
  const sourceById = useMemo(() => new Map(sources.sources.map((source) => [source.id, source])), [sources.sources])
  const readyScan = useCallback(
    (sourceId: string): ScanResult | null => {
      const load = sources.scans[sourceId]
      return load && load.status === 'ready' ? load.scan : null
    },
    [sources.scans],
  )

  // The tab being looked at is the one whose source is read. A repository that
  // has never been scanned is a network read, so it waits for this rather than
  // firing on mount for every source in the list (useSkillSources).
  const ensureScan = sources.ensureScan
  useEffect(() => {
    if (activeSource) ensureScan(activeSource.id)
  }, [activeSource, ensureScan])

  // A deep link's skill: opened the moment its source's scan is in hand,
  // which may be now, or after the read the tab selection just started. What
  // cannot be opened is said under the head, and the person stays on the
  // source's tab (or the view) rather than a blank (catalogueLanding.ts).
  useEffect(() => {
    if (!landing) return
    const outcome = resolveCatalogueLanding({
      landing,
      sourcesLoad: sources.sourcesLoad,
      sources: sources.sources,
      scans: sources.scans,
      noun: 'skill',
      has: (candidate, id) => findSkill(candidate, id) !== null,
    })
    if (outcome.status === 'waiting') return
    if (outcome.status === 'landed') {
      if (outcome.source.id !== tabId) onSelectTab(outcome.source.id)
      if (outcome.itemId) setOpenSkill({ sourceId: outcome.source.id, skillId: outcome.itemId })
      // A link that landed retires the notice an earlier one left: it named
      // what could not be opened THEN, and standing over the page that just
      // opened it would read as a warning about this skill (review, 2026-09-10).
      setLandingNotice(null)
    } else {
      setLandingNotice(outcome.notice)
    }
    onLanded?.()
  }, [landing, onLanded, onSelectTab, sources.scans, sources.sources, sources.sourcesLoad, tabId])

  const installSkill = useCallback(
    // Reports whether the skill landed, so the page's one "Install and use"
    // action can go on to hand it to an agent — and stop when it did not.
    // `global` (the default) installs for every agent in every chat and
    // project; `workspace` installs into the open folder only.
    async (source: SkillSource, skillId: string, scope: SkillInstallScope = 'global'): Promise<boolean> => {
      if (scope === 'workspace' && !workspaceRoot) return false
      if (typeof window.api.skillsInstall !== 'function') {
        setReport({ sourceId: source.id, outcome: null, error: MISSING_API_MESSAGE })
        return false
      }
      setInstalling(skillId)
      setReport(null)
      try {
        const result = await window.api.skillsInstall({ sourceId: source.id, skillId, workspaceRoot, scope })
        setReport(
          result.ok
            ? { sourceId: source.id, outcome: summarizeInstallRun(1, []), error: null }
            : {
                sourceId: source.id,
                outcome: null,
                error: summarizeInstallRun(0, [{ skillId, message: result.message }]),
              },
        )
        return result.ok
      } catch (error) {
        setReport({
          sourceId: source.id,
          outcome: null,
          error: summarizeInstallRun(0, [{ skillId, message: describe(error) }]),
        })
        return false
      } finally {
        setInstalling(null)
        sources.refreshInstalled()
      }
    },
    [sources, workspaceRoot],
  )

  // Removing an installed skill takes its directory back out of every harness
  // dir that holds a copy. The outcome is stated: a removal that failed must
  // never leave the row looking gone.
  const removeSkill = useCallback(
    async (dirName: string): Promise<void> => {
      setSkillMessage(null)
      try {
        const result = await window.api.skillsUninstall({ workspaceRoot, dirName })
        setSkillMessage(result.ok ? `${dirName} removed.` : result.message)
        if (result.ok) {
          setInventoryNonce((count) => count + 1)
          sources.refreshInstalled()
        }
      } catch (error) {
        setSkillMessage(describe(error))
      }
    },
    [sources, workspaceRoot],
  )

  // With a query on, every source the door holds a scan for, grouped by
  // source and flat within it (the folder groups are a source's own shape,
  // and across sources the source IS the group). The Installed tab's own
  // rows lead: the skill directories the workspace holds that no source's
  // hit already accounts for, by name — a scan is where a description comes
  // from, and these have none.
  const crossSearch = useMemo(() => {
    if (!searching) return null
    const needle = query.trim().toLowerCase()
    return searchAcrossSources<SkillRow>({
      query,
      sources: sources.sources,
      scans: sources.scans,
      match: (source, sourceScan, q) =>
        deriveSkillCatalogueGroups({ scan: sourceScan, installedDirNames: sources.installedDirNames, query: q })
          .flatMap((group) => group.items)
          .map((item) => ({ sourceId: source.id, item })),
      installed: (hits) => {
        const listed = new Set(hits.map((hit) => skillDirName(hit.item.skillId)))
        return [...sources.installedDirNames]
          .filter((dirName) => !listed.has(dirName) && dirName.toLowerCase().includes(needle))
          .sort()
          .map((dirName) => ({
            sourceId: NO_SOURCE,
            item: {
              skillId: dirName,
              name: dirName,
              description: '',
              group: '',
              plugin: '',
              fileCount: 0,
              hasExecutables: false,
              installed: true,
              nameWarning: '',
            },
          }))
      },
    })
  }, [query, searching, sources.installedDirNames, sources.scans, sources.sources])

  const sections = useMemo<CatalogueSection<SkillRow>[]>(() => {
    if (crossSearch) {
      return crossSearch.sections.map((section) => ({
        key: section.key,
        label: section.label,
        items: section.items,
        leading: section.source ? (
          <SourceAvatar
            source={section.source}
            monogram={catalogueMonogram(section.source)}
            size={SECTION_AVATAR_SIZE}
          />
        ) : undefined,
      }))
    }
    if (!activeSource || !scan) return []
    return deriveSkillCatalogueGroups({ scan, installedDirNames: sources.installedDirNames, query }).map((group) => ({
      key: group.key,
      label: group.label,
      items: group.items.map((item) => ({ sourceId: activeSource.id, item })),
    }))
  }, [activeSource, crossSearch, query, scan, sources.installedDirNames])

  // A skill wears its plugin's mark when it ships inside one, so the plugins
  // are indexed by the folder name `skillPluginFolder()` reads off a skill's
  // id — once per scan, not once per row, and per source because under a
  // search the rows come from every scan at once.
  const pluginsBySource = useMemo(() => {
    const bySource = new Map<string, Map<string, ScannedPlugin>>()
    for (const source of sources.sources) {
      const load = sources.scans[source.id]
      if (load && load.status === 'ready') bySource.set(source.id, pluginsByFolder(scanPlugins(load.scan)))
    }
    return bySource
  }, [sources.scans, sources.sources])

  const renderRow = useCallback(
    (row: SkillRow): React.ReactNode => {
      const { item } = row
      const rowSource = sourceById.get(row.sourceId)
      // Installed and unaccounted for: a name, and the fact. No page to open —
      // there is no scan to read it from — and no Install, because it is.
      const orphan = row.sourceId === NO_SOURCE
      return (
        <ConnectorRow
          surface="card"
          icon={
            <ExtensionIcon
              name={item.name}
              size={ROW_ICON_SIZE}
              {...extensionIconProps(
                skillArtwork(item, rowSource, ROW_ICON_SIZE, pluginsBySource.get(row.sourceId)?.get(item.plugin)),
              )}
            />
          }
          name={item.name}
          // The plugin it ships inside, when that is what tells it apart from
          // the row above it: "access · discord", "access · telegram".
          meta={item.plugin || undefined}
          summary={
            orphan
              ? 'Installed in this workspace'
              : item.description || `${item.fileCount} file${item.fileCount === 1 ? '' : 's'}`
          }
          // Not "Skill": every row in the Skills door is one. What a chip is for
          // is a fact the name does not carry.
          chips={item.hasExecutables ? ['Runs scripts'] : []}
          // A name the Agent Skills specification would reject is stated on the
          // row: the skill still lists, and still installs. Truncated like the
          // summary above it, because a row is one line per fact — the detail
          // pane has the room to say it in full.
          status={
            item.nameWarning ? (
              <>
                <StatusDot tone="warn" />
                <TruncatedText as="span" text={item.nameWarning} className="min-w-0 flex-1" />
              </>
            ) : undefined
          }
          selected={openSkill?.sourceId === row.sourceId && openSkill.skillId === item.skillId}
          onOpen={orphan ? undefined : () => setOpenSkill({ sourceId: row.sourceId, skillId: item.skillId })}
          actions={
            item.installed ? (
              <span className="pr-1 text-meta font-medium text-[color:var(--accent-primary)]">Installed</span>
            ) : installing !== null && installing !== item.skillId ? (
              // A disabled Install says why rather than leaving a blocked cursor to guess at.
              <Tooltip content="Another skill is installing — this one can install when it finishes.">
                <GhostButton
                  size="sm"
                  disabled
                  className="border border-[color:var(--border-default)]"
                  aria-label={`Install ${item.name}`}
                >
                  Install
                </GhostButton>
              </Tooltip>
            ) : (
              <GhostButton
                size="sm"
                disabled={installing !== null}
                onClick={() => rowSource && void installSkill(rowSource, item.skillId)}
                className="border border-[color:var(--border-default)]"
                aria-label={`Install ${item.name}`}
              >
                {installing === item.skillId ? 'Installing…' : 'Install'}
              </GhostButton>
            )
          }
        />
      )
    },
    [installSkill, installing, openSkill, pluginsBySource, sourceById],
  )

  // A report belongs to the source it happened on. Under a search the rows of
  // every source are on screen, so every source's report is too.
  const thisReport = report && (searching || report.sourceId === activeSource?.id) ? report : null

  const head = crossSearch ? (
    <CatalogueHead name="All sources" stateLine={crossSourceStateLine(crossSearch)} />
  ) : tabId === INSTALLED_TAB_ID ? (
    <CatalogueHead
      name="Installed"
      stateLine={
        workspaceRoot
          ? 'The skills installed for every project and in this one, grouped by where they came from.'
          : 'The skills installed for every project, grouped by where they came from.'
      }
    />
  ) : activeSource ? (
    <CatalogueHead
      monogram={<SourceAvatar source={activeSource} monogram={catalogueMonogram(activeSource)} />}
      name={catalogueTabLabel(activeSource)}
      // Where it comes from, and nothing else: the repository, or the folder
      // on this machine. What it holds is on the tab and the section heading;
      // what happened to it last is a notice below.
      stateLine={activeSource.path || sourceDisplayName(activeSource)}
      actions={
        <SourceTabActions
          source={activeSource}
          workspaceRoot={workspaceRoot}
          onSynced={(source, result) => {
            sources.applySync(source, result.scan)
            sources.refreshInstalled()
            setReport({ sourceId: source.id, outcome: summarizeSyncRun(result), error: null })
          }}
          // The manual update check reports into the same head line a sync
          // reports into: one place the source says what just happened to it.
          onCheckReport={(source, message) => setReport({ sourceId: source.id, outcome: message, error: null })}
          onSyncFailed={(source, message) => setReport({ sourceId: source.id, outcome: null, error: message })}
          onRemoved={() => {
            sources.refreshSources()
            onSelectTab(INSTALLED_TAB_ID)
          }}
        />
      }
    />
  ) : null

  const bundled = searching ? null : bundledScanLine(scan)
  const unreadLine = crossSearch ? unreadSourcesLine(crossSearch.unread) : null
  const notices = (
    <>
      {landingNotice ? (
        <InlineNotice tone="warn" action={<GhostButton onClick={() => setLandingNotice(null)}>Dismiss</GhostButton>}>
          {landingNotice}
        </InlineNotice>
      ) : null}
      {thisReport?.error ? <InlineNotice tone="error" title="That did not complete." hint={thisReport.error} /> : null}
      {/* What the last Sync or update check on this source reported, and
          whether this listing is the copy the build shipped rather than a
          read of the repository: each a fact about the listing, stated once
          under the head rather than folded into it. */}
      {thisReport?.outcome ? <InlineNotice tone="warn">{thisReport.outcome}</InlineNotice> : null}
      {bundled ? <InlineNotice tone="warn">{bundled}</InlineNotice> : null}
      {/* A search that did not cover every source says which it left out and
          why, rather than reading as a complete answer. */}
      {unreadLine ? <InlineNotice tone="warn">{unreadLine}</InlineNotice> : null}
      {addNotice ? (
        <InlineNotice
          tone="error"
          title="That source was not added."
          hint={addNotice}
          action={<GhostButton onClick={onDismissAddNotice}>Dismiss</GhostButton>}
        />
      ) : null}
      {skillMessage ? <InlineNotice tone="warn">{skillMessage}</InlineNotice> : null}
    </>
  )

  const body = ((): React.ReactNode => {
    if (sources.sourcesLoad.status === 'error') {
      return (
        <InlineNotice
          tone="error"
          title="Your skill sources could not be read."
          hint="Nothing was changed. Try again, or add a source to start a fresh list."
          detail={sources.sourcesLoad.message}
          action={<GhostButton onClick={sources.refreshSources}>Try again</GhostButton>}
        />
      )
    }
    // Under a search the sections ARE the body, whatever tab is selected; the
    // only state that is not a list is the source list itself still loading.
    if (searching) {
      return sources.sourcesLoad.status === 'loading' ? <LoadingLine label="Loading skill sources…" /> : null
    }
    if (tabId === INSTALLED_TAB_ID) {
      return (
        <div className="space-y-6">
          <InstalledExtensionsInventory
            key={inventoryNonce}
            mcpServers={[]}
            moduleOverrides={moduleOverrides}
            workspaceRoot={workspaceRoot}
            kinds={['skill']}
            sourceGrouping={{ sources: sources.sources, records: sources.installedPlugins }}
            paging={{ noun: 'skill', query }}
            onRemoveSkill={(dirName) => void removeSkill(dirName)}
            onUseSkillInNewAgent={onUseSkillInNewAgent}
          />
          {/* Where somebody stands when they have run out of skills to install:
              under what they have, the places to get more. */}
          <RecommendedSources
            existingSources={sources.sources}
            onAdded={(sourceId) => {
              sources.refreshSources()
              onSelectTab(sourceId)
            }}
          />
        </div>
      )
    }
    if (!activeSource) return <LoadingLine label="Loading skill sources…" />
    if (!activeScan || activeScan.status === 'loading') {
      return <LoadingLine label={`Reading ${catalogueTabLabel(activeSource)}…`} />
    }
    if (activeScan.status === 'error') {
      return (
        <InlineNotice
          tone="error"
          title={`${catalogueTabLabel(activeSource)} could not be read.`}
          hint="Its skills are not listed below — this is not an empty source."
          detail={activeScan.message}
          action={<GhostButton onClick={() => sources.refreshScan(activeSource.id)}>Try again</GhostButton>}
        />
      )
    }
    return null
  })()

  // The open skill's OWN source and scan — the row's, which under a search
  // need not be the tab's.
  const openSource = openSkill ? (sourceById.get(openSkill.sourceId) ?? null) : null
  const openScan = openSkill ? readyScan(openSkill.sourceId) : null
  const opened = openScan && openSkill ? findSkill(openScan, openSkill.skillId) : null
  const detail =
    openSource && opened ? (
      <SkillPage
        key={`${openSource.id}::${opened.id}`}
        source={openSource}
        skill={opened}
        installed={sources.installedDirNames.has(skillDirName(opened.id))}
        installing={installing !== null}
        availability={deriveInstallAvailability(1)}
        workspaceRoot={workspaceRoot}
        onInstall={() => void installSkill(openSource, opened.id)}
        onInstallInWorkspace={workspaceRoot ? () => void installSkill(openSource, opened.id, 'workspace') : undefined}
        onInstallForUse={() => installSkill(openSource, opened.id)}
        onRemove={
          sources.installedDirNames.has(skillDirName(opened.id))
            ? () => void removeSkill(skillDirName(opened.id))
            : undefined
        }
        onClose={() => setOpenSkill(null)}
      />
    ) : null

  return (
    <CatalogueSurface<SkillRow>
      title="Skills"
      tabs={tabs}
      activeTabId={tabId}
      onSelectTab={(next) => {
        setOpenSkill(null)
        onSelectTab(next)
      }}
      search={{ query, onQueryChange, placeholder: 'Search all sources', scope: 'sources' }}
      add={add}
      head={head}
      notices={notices}
      body={body}
      sections={sections}
      renderRow={renderRow}
      rowKey={skillRowKey}
      noun="skill"
      detail={detail}
    />
  )
}

function LoadingLine({ label }: { label: string }): JSX.Element {
  return (
    <div className="flex items-center gap-2 py-8 text-body text-[color:var(--text-muted)]">
      <Spinner size={14} />
      {label}
    </div>
  )
}

function describe(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}
