// The installed-extensions inventory, relocated from the (removed) Settings →
// Extensions tab into the Connectors surface (T3). It is the aggregated roll-up
// of everything installed across the extension primitives — MCP servers,
// skills and capability modules — so the Connectors "Installed" view has one
// honest "what do I have" surface. Agent CLIs are not among them: they live in
// Settings ▸ Agents (owner ruling 2026-09-25). Rows render the same
// ConnectorRow as Browse so the whole surface reads as one system. The
// list-building lives in the DOM-free `extensionsInstalled` view-model for unit
// coverage; this component owns the IPC loading and rendering, and its per-row
// actions (launch / remove) only delegate to handlers the host
// already owns — a primitive with no handler simply shows no action.

import { useCallback, useEffect, useMemo, useState, type ReactNode } from 'react'

import type { ModuleEnablementOverrides, ThirdPartyModuleListResult } from '../../../../../shared/modules/manifest'
import type {
  InstalledPluginRecord,
  MarketplaceUpdateStatesResult,
  WorkspaceSkill,
} from '../../../../../shared/electron-api'
import type { SkillSource } from '../../../../../shared/skills'
import type { MarketplacePluginEntry } from '../../../../../shared/marketplace/manifest'
import type { ExtensionTrustReviewData } from '../../extensions/ExtensionTrustReview'
import type { AgentComposerConnector } from '../../workspace/agentComposer/useAgentComposer'
import type { PluginRegistryListEntry } from '../../../../../shared/plugin-manifest'
import type { McpServerConfig, McpSettings } from '../../../types/workspace'
import {
  CloseIconButton,
  EmptyState,
  InlineNotice,
  Pager,
  PrimaryButton,
  SettingCard,
  Spinner,
  StatusDot,
  Tooltip,
  UseSkillInAgentMenu,
} from '../../ui'
import {
  NO_WORKSPACE_FOLDER_MESSAGE,
  resolveWorkspaceSkill,
  skillRestartToast,
  useSkillInAgent,
} from '../../../utils/useSkillInAgent'
import { showToast } from '../../../store/toastStore'
import { ExtensionIcon } from '../../ui/ExtensionIcon'
import { mcpIconSlug } from '../../ui/mcpIconSlug'
import { PluginIcon } from '../../settings/BrowseStorefront'
import { TRUST_PRESENTATION } from '../../settings/ThirdPartyModuleList'
import { classifyVerification, summarizeInstallResult } from '../../settings/installFlow'
import {
  deriveInstalledExtensions,
  NO_LONGER_IN_SOURCE,
  type ExtensionKind,
  type ExtensionsInstalledView,
  type InstalledExtension,
  type LoadedSource,
  type SourceNotice,
} from '../../settings/extensionsInstalled'
import {
  CATALOGUE_PAGE_SIZE,
  deriveCataloguePage,
  stepCataloguePage,
} from '../../workspace/globalSurface/extensions/catalogue/cataloguePaging'
import { groupInstalledBySource } from '../../workspace/globalSurface/extensions/catalogue/installedGroups'
import { ConnectorRow, ConnectorSectionHeading } from './ConnectorRow'
import { ModuleUpdateBanner, type ModuleUpdateFlow, type ModuleUpdateNotice } from './ExtensionUpdateBanner'
import { cliOnlyRegistryIds, deriveManageUpdateBanner } from './extensionUpdates'
import { errorMessage } from '../../../../../shared/errors'

// Per-row actions, all optional: the host wires only the handlers that exist
// today (no new IPC), and rows without a matching handler carry no affordance.
type InventoryActions = {
  onLaunchConnector?: (connector: AgentComposerConnector) => void
  onRemoveMcpServer?: (serverId: string) => void
  // A module-bundle update can carry MCP servers; reflecting them in the store
  // keeps the MCP group live without a re-list (the storefront install rule).
  onUpsertMcpServer?: (server: McpServerConfig) => void
  // Keyed by the skill's directory name (the inventory row id for skills).
  onRemoveSkill?: (dirName: string) => void
  // "Use in agent → New agent…": spawn a fresh agent with the skill attached
  // (ensure-installed, invocation prefilled). Running-agent inserts are handled
  // inside the row menu itself via the terminal APIs.
  onUseSkillInNewAgent?: (skill: WorkspaceSkill) => void
}

// The banner's update run: what is being verified/updated now, what is queued
// behind it ("Update all"), and the trust re-classification pause. Internal —
// the banner renders the derived ModuleUpdateFlow.
type ModuleUpdateRun =
  | { status: 'idle' }
  | { status: 'busy'; label: string }
  | {
      status: 'needs-trust'
      entry: MarketplacePluginEntry
      queue: string[]
      review: ExtensionTrustReviewData
      trustToken: string
    }

export function InstalledExtensionsInventory({
  mcpServers,
  moduleOverrides,
  workspaceRoot,
  registryPlugins,
  mcpSettings,
  kinds,
  sourceGrouping,
  paging,
  ...actions
}: {
  // MCP servers reflect the store live, so the inventory's MCP group updates
  // without a re-list when a server is added or removed elsewhere on the surface.
  mcpServers: McpServerConfig[]
  moduleOverrides: ModuleEnablementOverrides
  workspaceRoot: string | null
  // The marketplace registry entries the surface already loaded: the update
  // action needs the full entry (updateFromRegistry input), and cli-only
  // entries are excluded from the banner's delta claims.
  registryPlugins?: MarketplacePluginEntry[]
  // Forwarded into the update input so a bundle's MCP servers merge the same
  // way the storefront install merges them.
  mcpSettings?: McpSettings
  /**
   * Which primitives this mount is the inventory OF. The Extensions door's
   * catalogues each show one — the Plugins view's Installed tab lists MCP
   * servers, Skills lists skills — because a tab that says "Installed" beside
   * "Plugins" must not answer with skills.
   * Omitted, every group renders, which is the whole-inventory mount.
   */
  kinds?: readonly ExtensionKind[]
  /**
   * Group by SOURCE rather than by kind (source-tabs ruling, 2026-09-05). The
   * receipts say which source installed what; `sources` gives each one its tab
   * name so the heading and the tab beside it read the same.
   */
  sourceGrouping?: { sources: readonly SkillSource[]; records: readonly InstalledPluginRecord[] }
  /** Walk the rows a page at a time, with the shared pager at the foot. */
  paging?: { noun: string; query?: string }
} & InventoryActions) {
  const [modules, setModules] = useState<LoadedSource<ThirdPartyModuleListResult>>({ status: 'loading' })
  const [skills, setSkills] = useState<LoadedSource<WorkspaceSkill[]>>({ status: 'loading' })
  // The CLI plugin list is not a group of rows: it is what a skill row's "Use
  // in agent" reads to render each CLI's own skill invocation.
  const [clis, setClis] = useState<LoadedSource<PluginRegistryListEntry[]>>({ status: 'loading' })
  // null until the first read lands (or forever on a build predating the API):
  // no update claim either way. Never rendered as "up to date".
  const [updateStates, setUpdateStates] = useState<MarketplaceUpdateStatesResult | null>(null)
  const [updateRun, setUpdateRun] = useState<ModuleUpdateRun>({ status: 'idle' })
  const [updateNotice, setUpdateNotice] = useState<ModuleUpdateNotice | null>(null)

  const loadModules = useCallback(async () => {
    if (typeof window.api.listThirdPartyModules !== 'function') {
      setModules({ status: 'unsupported' })
      return
    }
    try {
      const result = await window.api.listThirdPartyModules()
      // Guard the shape, not just the rejection: a malformed IPC result must
      // degrade to the error notice like every other source, never crash the
      // derive step (the state-matrix rule).
      setModules(
        result && Array.isArray(result.modules) && Array.isArray(result.rejected)
          ? { status: 'ok', value: result }
          : { status: 'error', message: 'Could not list installed modules.' },
      )
    } catch (error) {
      setModules({ status: 'error', message: errorMessage(error, 'Could not list installed modules.') })
    }
  }, [])

  const loadClis = useCallback(async () => {
    if (typeof window.api.pluginsList !== 'function') {
      setClis({ status: 'unsupported' })
      return
    }
    try {
      const result = await window.api.pluginsList()
      setClis(result.ok ? { status: 'ok', value: result.plugins } : { status: 'error', message: result.message })
    } catch (error) {
      setClis({ status: 'error', message: errorMessage(error, 'Could not list installed agent CLIs.') })
    }
  }, [])

  const loadSkills = useCallback(async () => {
    if (typeof window.api.workspaceSkillsList !== 'function') {
      setSkills({ status: 'unsupported' })
      return
    }
    try {
      // The skills installed for every project are as much "installed" as the
      // folder's: every agent reads them, with or without a folder open.
      const result = await window.api.workspaceSkillsList({ workspaceRoot, includeGlobal: true })
      setSkills(result.ok ? { status: 'ok', value: result.skills } : { status: 'error', message: result.message })
    } catch (error) {
      setSkills({ status: 'error', message: errorMessage(error, 'Could not list installed skills.') })
    }
  }, [workspaceRoot])

  // Update detection. A thrown read is a failed check and renders
  // couldn't-check — never silence that reads as "up to date".
  const loadUpdateStates = useCallback(async (forceRefresh = false) => {
    if (typeof window.api.readMarketplacePluginUpdateStates !== 'function') return
    try {
      setUpdateStates(
        await window.api.readMarketplacePluginUpdateStates(forceRefresh ? { forceRefresh: true } : undefined),
      )
    } catch (error) {
      setUpdateStates({ ok: false, message: errorMessage(error, 'Could not check for updates.') })
    }
  }, [])

  useEffect(() => {
    void loadModules()
    void loadClis()
    void loadUpdateStates()
  }, [loadModules, loadClis, loadUpdateStates])

  // Skills are workspace-scoped, so re-list when the active workspace changes
  // (loadSkills closes over workspaceRoot).
  useEffect(() => {
    setSkills({ status: 'loading' })
    void loadSkills()
  }, [loadSkills])

  // After any update lands, the module list and the detection re-read together
  // so the banner and the row settle to current in one pass, no app restart.
  const settleAfterUpdate = useCallback(async () => {
    await Promise.all([loadModules(), loadUpdateStates(true)])
  }, [loadModules, loadUpdateStates])

  // Walk the pending updates one at a time. The pre-update verify re-runs
  // trust classification: a version now signed by a different key (or
  // unsigned where it was signed) pauses on the disclosure prompt or blocks —
  // never a silent grant. A block or error stops the walk; the banner still
  // names what remains. A trust grant re-enters the walk with `grant` set for
  // the entry the user just approved — the token its verify issued — skipping
  // a second verify.
  const processUpdateQueue = useCallback(
    async (ids: string[], grant?: { id: string; trustToken: string }) => {
      let updated = false
      let pending = ids
      while (pending.length > 0) {
        const [id, ...rest] = pending
        pending = rest
        const entry = registryPlugins?.find((plugin) => plugin.id === id)
        if (
          !entry ||
          typeof window.api.verifyMarketplacePlugin !== 'function' ||
          typeof window.api.updateMarketplacePluginFromRegistry !== 'function'
        ) {
          setUpdateRun({ status: 'idle' })
          setUpdateNotice({
            tone: 'error',
            message: entry
              ? 'Updating extensions needs a newer app build. Update and restart.'
              : 'The marketplace entry for this update is not available right now.',
          })
          if (updated) await settleAfterUpdate()
          return
        }

        let trustToken: string | undefined
        if (grant?.id === id) {
          trustToken = grant.trustToken
          grant = undefined
        } else {
          setUpdateRun({ status: 'busy', label: `Checking ${entry.name}…` })
          let verify
          try {
            verify = await window.api.verifyMarketplacePlugin({ id: entry.id })
          } catch (error) {
            setUpdateRun({ status: 'idle' })
            setUpdateNotice({ tone: 'error', message: errorMessage(error, 'Could not verify this update.') })
            if (updated) await settleAfterUpdate()
            return
          }
          const outcome = classifyVerification(verify, entry.provides)
          if (outcome.kind === 'blocked') {
            setUpdateRun({ status: 'idle' })
            setUpdateNotice({
              tone: outcome.classification === 'invalid' ? 'error' : 'warn',
              message: outcome.message,
            })
            if (updated) await settleAfterUpdate()
            return
          }
          if (outcome.kind === 'needs-trust') {
            setUpdateRun({
              status: 'needs-trust',
              entry,
              queue: pending,
              review: outcome.review,
              trustToken: outcome.trustToken,
            })
            if (updated) await settleAfterUpdate()
            return
          }
          trustToken = outcome.trustToken
        }

        setUpdateRun({ status: 'busy', label: `Updating ${entry.name}…` })
        try {
          const result = await window.api.updateMarketplacePluginFromRegistry({
            id: entry.id,
            ...(trustToken ? { trustToken } : {}),
            workspaceRoot: workspaceRoot ?? undefined,
            mcpSettings,
          })
          if (!result.ok) {
            const summary = summarizeInstallResult(result)
            setUpdateRun({ status: 'idle' })
            setUpdateNotice({
              tone: summary.status === 'blocked' && summary.classification === 'unsigned' ? 'warn' : 'error',
              message:
                summary.status === 'blocked' || summary.status === 'error'
                  ? summary.message
                  : 'The update could not be completed.',
            })
            await settleAfterUpdate()
            return
          }
          updated = true
          if (result.mcpSettings && actions.onUpsertMcpServer) {
            for (const server of Object.values(result.mcpSettings.servers)) actions.onUpsertMcpServer(server)
          }
          setUpdateNotice({ tone: 'good', message: `${entry.name} updated to v${result.version}.` })
        } catch (error) {
          setUpdateRun({ status: 'idle' })
          setUpdateNotice({ tone: 'error', message: errorMessage(error, 'The update could not be completed.') })
          await settleAfterUpdate()
          return
        }
      }
      setUpdateRun({ status: 'idle' })
      if (updated) await settleAfterUpdate()
    },
    [registryPlugins, workspaceRoot, mcpSettings, actions, settleAfterUpdate],
  )

  const startBannerUpdate = useCallback(
    (ids: string[]) => {
      setUpdateNotice(null)
      void processUpdateQueue(ids)
    },
    [processUpdateQueue],
  )

  const banner = useMemo(
    () => deriveManageUpdateBanner(updateStates, cliOnlyRegistryIds(registryPlugins ?? [])),
    [updateStates, registryPlugins],
  )
  const updateFlow: ModuleUpdateFlow =
    updateRun.status === 'needs-trust'
      ? { status: 'needs-trust', review: updateRun.review, publisher: updateRun.entry.publisher }
      : updateRun

  const view = deriveInstalledExtensions({
    mcpServers,
    modules,
    moduleOverrides,
    skills,
  })

  return (
    <InstalledView
      view={view}
      kinds={kinds}
      sourceGrouping={sourceGrouping}
      paging={paging}
      actions={actions}
      skillUse={{ workspaceRoot, clis: clis.status === 'ok' ? clis.value : [] }}
      moduleUpdateSlot={
        <ModuleUpdateBanner
          banner={banner}
          flow={updateFlow}
          notice={updateNotice}
          onUpdate={() => {
            if (banner.kind === 'updates') startBannerUpdate(banner.updates.map((update) => update.id))
          }}
          onTrustConfirm={() => {
            if (updateRun.status === 'needs-trust') {
              void processUpdateQueue([updateRun.entry.id, ...updateRun.queue], {
                id: updateRun.entry.id,
                trustToken: updateRun.trustToken,
              })
            }
          }}
          onCancelTrust={() => setUpdateRun({ status: 'idle' })}
        />
      }
    />
  )
}

// Context the per-row "Use in agent" menu needs: the workspace whose skill
// inventory resolves the row, and the CLI plugin list whose skillIntegration
// templates render the per-CLI invocation.
type SkillUseContext = {
  workspaceRoot: string | null
  clis: PluginRegistryListEntry[]
}

function NoticeList({ notices }: { notices: SourceNotice[] }) {
  return (
    <div className="space-y-2">
      {notices.map((notice) => (
        <InlineNotice key={`${notice.kind}:${notice.message}`} tone={notice.tone}>
          {notice.message}
        </InlineNotice>
      ))}
    </div>
  )
}

function InstalledView({
  view,
  kinds,
  sourceGrouping,
  paging,
  actions,
  skillUse,
  moduleUpdateSlot,
}: {
  view: ExtensionsInstalledView
  kinds?: readonly ExtensionKind[]
  sourceGrouping?: { sources: readonly SkillSource[]; records: readonly InstalledPluginRecord[] }
  paging?: { noun: string; query?: string }
  actions: InventoryActions
  skillUse: SkillUseContext
  // The update banner: one calm line above the Capability modules
  // group — per the owner ruling it lives here and only here, never on rows,
  // never on the Skills surface.
  moduleUpdateSlot?: ReactNode
}) {
  // The page of a paged mount. Held here rather than by the caller because the
  // rows arrive here — over IPC, after the caller has already rendered — and a
  // page number owned by something that cannot see the rows is a number that
  // outlives them.
  const [position, setPosition] = useState({ key: '', page: 1 })
  if (view.status === 'loading') {
    return (
      <div className="flex items-center gap-2 py-6 text-body text-[color:var(--text-muted)]">
        <Spinner size={14} />
        Loading installed extensions…
      </div>
    )
  }

  if (view.status === 'unsupported') {
    return (
      <InlineNotice tone="warn">
        Installed extensions need a newer app build. Update and restart to see them here.
      </InlineNotice>
    )
  }

  // Degraded: zero rows but a source failed/was unavailable. Show only the
  // notices that explain why — never the "nothing installed" copy beneath them.
  if (view.status === 'degraded') {
    return <NoticeList notices={view.notices} />
  }

  const allGroups = view.status === 'ready' ? view.groups : []
  const kinded = kinds ? allGroups.filter((group) => kinds.includes(group.kind)) : allGroups
  // The search field in the chrome row says it filters the open tab, and
  // Installed is a tab: a field that visibly narrowed every other tab and left
  // this one alone would be the one place its own label is untrue.
  const needle = (paging?.query ?? '').trim().toLowerCase()
  const kindGroups = needle
    ? kinded
        .map((group) => ({
          ...group,
          items: group.items.filter((item) =>
            `${item.name} ${item.summary ?? ''} ${item.chips.join(' ')}`.toLowerCase().includes(needle),
          ),
        }))
        .filter((group) => group.items.length > 0)
    : kinded
  // Rows carry their kind, so a source-grouped mount still knows where the
  // module banner belongs.
  const kindsPresent = new Set(kindGroups.map((group) => group.kind))
  const groups = sourceGrouping
    ? groupInstalledBySource({
        rows: kindGroups.flatMap((group) => group.items),
        sources: sourceGrouping.sources,
        records: sourceGrouping.records,
      }).map((group) => ({ key: group.key, label: group.label, items: group.items }))
    : kindGroups.map((group) => ({ key: group.kind, label: group.label, items: group.items }))

  if (groups.length === 0) {
    return needle ? (
      <EmptyState density="list" title={`Nothing installed matches “${paging?.query?.trim() ?? ''}”.`} />
    ) : (
      <EmptyState
        density="list"
        title="Nothing installed yet."
        body="Get MCP servers, skills and plugins from a source tab and they appear here."
      />
    )
  }

  const page = paging
    ? deriveCataloguePage({
        groups: groups.map((group) => ({ key: group.key, label: group.label, count: group.items.length })),
        page: stepCataloguePage(position, paging.query ?? '').page,
        pageSize: CATALOGUE_PAGE_SIZE,
        query: paging.query,
        noun: paging.noun,
      })
    : null
  const visible = page
    ? page.groups.map((slice) => {
        const group = groups.find((candidate) => candidate.key === slice.key)
        return {
          key: slice.key,
          label: slice.continued ? `${slice.label} (continued)` : slice.label,
          count: slice.total,
          kind: group?.items[0]?.kind,
          items: (group?.items ?? []).slice(slice.start, slice.end),
        }
      })
    : groups.map((group) => ({
        key: group.key,
        label: group.label,
        count: group.items.length,
        kind: group.items[0]?.kind,
        items: group.items,
      }))

  return (
    <div className="space-y-5">
      {view.status === 'ready' && view.notices.length > 0 ? <NoticeList notices={view.notices} /> : null}
      <div className="space-y-5">
        {visible.map((group) => (
          <section key={group.key} className="space-y-2">
            <ConnectorSectionHeading label={group.label} count={group.count} />
            {!sourceGrouping && group.kind === 'module' ? moduleUpdateSlot : null}
            {/* The Browse card, row for row: one two-column list card of the
                same row the marketplace renders, so Installed reads as the
                same surface turned to face what is already here. */}
            <SettingCard as="ul" ariaLabel={group.label} columns={2}>
              {group.items.map((item) => (
                <li key={item.key}>
                  <InstalledRow item={item} actions={actions} skillUse={skillUse} />
                </li>
              ))}
            </SettingCard>
          </section>
        ))}
      </div>
      {/* One banner for the whole list, not one per group: the module update
          banner is a fact about the mount, and a source-grouped list has no
          single group to hang it on. */}
      {sourceGrouping && kindsPresent.has('module') ? moduleUpdateSlot : null}
      {page ? (
        <Pager
          page={page.page}
          pageCount={page.pageCount}
          rangeLabel={page.rangeLabel}
          onPageChange={(next) => setPosition({ key: paging?.query ?? '', page: next })}
          ariaLabel={`Installed ${paging?.noun ?? 'item'}s`}
        />
      ) : null}
    </div>
  )
}

// One inventory row on the shared ConnectorRow, exactly as Browse renders its
// entries: 36px icon chip · name + kind chip · human summary · plain-language
// status · actions. The forward actions (New chat, Use in agent) are
// visible, as Browse's Add is; Remove is an icon action withheld until the row
// is pointed at or focused, so a card of installed things does not read as a
// card of delete buttons, and its reserved slot is one control wide rather
// than a word. Actions exist only where a real handler does.
function InstalledRow({
  item,
  actions,
  skillUse,
}: {
  item: InstalledExtension
  actions: InventoryActions
  skillUse: SkillUseContext
}) {
  const launchable = item.kind === 'mcp' && item.enabled === true

  const rowActions: ReactNode[] = []
  if (item.kind === 'mcp') {
    if (launchable && actions.onLaunchConnector) {
      rowActions.push(
        <PrimaryButton
          key="launch"
          size="sm"
          onClick={() => actions.onLaunchConnector!({ id: item.id, name: item.name })}
        >
          New chat
        </PrimaryButton>,
      )
    }
    if (actions.onRemoveMcpServer) {
      rowActions.push(
        <RevealedAction key="remove">
          <Tooltip content="Remove" placement="top">
            <CloseIconButton onClick={() => actions.onRemoveMcpServer!(item.id)} aria-label={`Remove ${item.name}`} />
          </Tooltip>
        </RevealedAction>,
      )
    }
  } else if (item.kind === 'skill') {
    if (skillUse.workspaceRoot) {
      rowActions.push(
        <UseSkillMenu
          key="use"
          skillId={item.id}
          name={item.name}
          skillUse={skillUse}
          onNewAgent={actions.onUseSkillInNewAgent}
        />,
      )
    }
    if (actions.onRemoveSkill) {
      rowActions.push(
        <RevealedAction key="remove">
          <Tooltip content="Remove" placement="top">
            <CloseIconButton onClick={() => actions.onRemoveSkill!(item.id)} aria-label={`Remove ${item.name}`} />
          </Tooltip>
        </RevealedAction>,
      )
    }
  }

  return (
    <ConnectorRow
      surface="card"
      icon={
        item.kind === 'mcp' ? (
          <ExtensionIcon slug={mcpIconSlug(item.id)} name={item.name} size={36} />
        ) : (
          <PluginIcon iconUrl={null} name={item.name} size={36} />
        )
      }
      name={item.name}
      summary={item.summary}
      chips={item.chips}
      status={item.kind === 'mcp' || (item.kind === 'module' && item.trust) ? <RowStatus item={item} /> : undefined}
      actions={rowActions.length > 0 ? rowActions : undefined}
    />
  )
}

// A row action withheld until the row is pointed at or focused (list-row): the
// slot keeps its width at rest so revealing never reflows, and it appears on
// keyboard focus as well as hover.
function RevealedAction({ children }: { children: ReactNode }) {
  return (
    <span className="flex items-center transition-opacity focus-within:opacity-100 group-hover:opacity-100 opacity-0">
      {children}
    </span>
  )
}

// The row's decision-relevant status — trust for capability modules,
// active/inactive for MCP servers — as a StatusDot always paired with its text
// label, so status is never colour-only. Skills have no such axis
// (presence is the only state), so they carry no dot.
function RowStatus({ item }: { item: InstalledExtension }) {
  if (item.kind === 'module' && item.trust) {
    const trust = TRUST_PRESENTATION[item.trust]
    return (
      <>
        {/* Decorative: the adjacent label already names the trust state. */}
        <StatusDot tone={trust.tone} />
        {trust.label}
      </>
    )
  }
  if (item.kind === 'mcp') {
    return (
      <>
        <StatusDot tone={item.enabled ? 'good' : 'neutral'} />
        {item.enabled ? 'Active' : 'Not active'}
        {/* A server its source has stopped declaring keeps working, so the
            active state still leads; the sentence after it is why Sync will not
            be refreshing it any more
            (backlog/2026-09-06-mcp-installs-carry-source-provenance.md). */}
        {item.missingFromSource ? ` · ${NO_LONGER_IN_SOURCE}` : null}
      </>
    )
  }
  return null
}

// "Use in agent" on a skill row: the shared kit menu over the shared flow
// (`utils/useSkillInAgent.ts`, `ui/UseSkillInAgentMenu`). What used to be a
// hundred lines of round trip here is now the same round trip every other door
// runs — list the live agents, ensure-install, render the per-CLI invocation,
// bracket-paste it unsubmitted. Worktree agents are excluded by the flow (they
// do not read the main checkout's harness dirs), and a CLI that only re-reads
// its skills directory on restart says so in a toast.
function UseSkillMenu({
  skillId,
  name,
  skillUse,
  onNewAgent,
}: {
  skillId: string
  name: string
  skillUse: SkillUseContext
  onNewAgent?: (skill: WorkspaceSkill) => void
}) {
  // The row is a projection of the inventory record; the invocation machinery
  // needs the record itself (source, harnesses), re-read at click time so a
  // skill installed since the list loaded still resolves.
  const resolve = () => resolveWorkspaceSkill({ workspaceRoot: skillUse.workspaceRoot, skillId })

  return (
    <UseSkillInAgentMenu
      skillName={name}
      unavailableReason={skillUse.workspaceRoot ? null : NO_WORKSPACE_FOLDER_MESSAGE}
      onUse={async (session) => {
        const resolved = await resolve()
        if (!resolved.ok) return resolved.message
        const used = await useSkillInAgent({
          workspaceRoot: skillUse.workspaceRoot,
          skill: resolved.skill,
          session,
          clis: skillUse.clis,
        })
        if (!used.ok) return used.message
        const toast = skillRestartToast(used, resolved.skill.name)
        if (toast) showToast(toast)
        return null
      }}
      onNewAgent={
        onNewAgent
          ? async () => {
              const resolved = await resolve()
              if (!resolved.ok) return resolved.message
              onNewAgent(resolved.skill)
              return null
            }
          : undefined
      }
    />
  )
}
