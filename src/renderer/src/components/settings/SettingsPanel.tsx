import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import type { VersionControlProviderId, VersionControlProviderProbe } from '../../../../shared/version-control'
import { useWorkspaceStore } from '../../store/workspaceStore'
import { getRendererHost, selectModuleEnabled } from '../../modules'
import type { RegisteredSettingsSection } from '../../modules/renderer-host'
import { AgentBrowserSettings } from './AgentBrowserSettings'
import { AgentNotificationsSetting } from './AgentNotificationsSetting'
import { AutomationServerSettings } from './AutomationServerSettings'
import { UpdateEverythingCard } from './UpdateEverythingCard'
import { BrowsersSettings } from './BrowsersSettings'
import { LocalAppsSettings } from './LocalAppsSettings'
import { WslGhSection } from './MachineGhRow'
import { QuitConfirmationSetting } from './QuitConfirmationSetting'
import { KeepAwakeSetting } from './KeepAwakeSetting'
import { StudioServerSettings } from './StudioServerSettings'
import { ModuleSettingsSectionHost } from './ModuleSettingsSection'
import AppThemePicker from './AppThemePicker'
import { SystemThemeRows } from './SystemThemeRows'
import { ChatAppearanceRows } from './ChatAppearanceRows'
import { FontAppearanceRows } from './FontAppearanceRows'
import { effectiveWindowMaterial, type WindowMaterial } from '../../types/appTheme'
import { resolveProjectKnowledgeConfig } from '../../utils/projectKnowledge'
import { basename } from '../../utils/paths'
import { formatRelativeMsAgo } from '../../utils/relativeTime'
import { useRelativeNowFor } from '../../hooks/useRelativeNow'
import { WorkspacePanel } from '../ui/WorkspacePanel'
import {
  Badge,
  GhostButton,
  IconButton,
  InlineNotice,
  Input,
  OutlineButton,
  PrimaryButton,
  ProviderRow,
  ProviderStateId,
  RefreshIcon,
  RowButton,
  SegmentedControl,
  Spinner,
  Tooltip,
} from '../ui'
import { useConfirmDialog } from '../ui/ConfirmDialog'
import { KeyboardShortcutsTab } from './KeyboardShortcutsTab'
import { RemoteTailnetSettingsTab } from './RemoteTailnetSettingsTab'
import { TextGenerationSettingsSection } from './TextGenerationSettingsSection'
import { ModulesSettingsTab } from './ModulesSettingsTab'
import { ProviderSettingsTab } from './ProviderSettingsTab'
import { MachinesSettingsTab } from './MachinesSettingsTab'
import { SettledChatsSettingsTab } from './SettledChatsSettingsTab'
import { WorktreesSettingsTab } from './WorktreesSettingsTab'
import { ArtifactsSettingsTab } from './ArtifactsSettingsTab'
import { AgentClisSection, AgentsMachineSwitcher, useAgentCliRuns } from './AgentClisSection'
import { ConversationApprovalSettings } from './ConversationApprovalSettings'
import { FollowUpBehaviorSetting } from './FollowUpBehaviorSetting'
import { StudioSkillsSettings } from './StudioSkillsSettings'
import {
  agentsMachines,
  lastAgentsMachine,
  rememberAgentsMachine,
  resolveAgentsMachine,
  useMachineCliAvailability,
} from './agentsMachine'
import { useExecutionHosts } from '../../hooks/useExecutionHosts'
import { executionHostLabel, LOCAL_HOST_ID, type ExecutionHostId } from '../../../../shared/execution-host'
import {
  MetaCell,
  SettingCard,
  SettingsPageHeader,
  SettingsRow,
  SettingsSectionTitle,
  SettingToggle,
} from './SettingsAtoms'
import {
  resolveVersionControlRow,
  versionControlSections,
  type VersionControlProbeStatus,
  type VersionControlRowView,
} from './versionControlProviders'
import { ProjectKnowledgeList } from './ProjectKnowledgeList'
import { DesignSystemSettings } from './DesignSystemSettings'
import { orderInstalledPlugins } from '../workspace/newWorkspace/cliRuntimeOptions'
import { AgentConfigAdoptionStatus } from '../onboarding/agentConfigAdoption'
import { ConversationImportSettings } from './ConversationImportSettings'
import { UsageLimitResumeSettings } from './UsageLimitResumeSettings'
import {
  GeneralSettingsIcon,
  ProfileSettingsIcon,
  AppearanceSettingsIcon,
  ShortcutsSettingsIcon,
  AgentsSettingsIcon,
  ProvidersSettingsIcon,
  GithubSettingsIcon,
  TrackersSettingsIcon,
  KnowledgeGraphSettingsIcon,
  DesignSystemSettingsIcon,
  ModulesSettingsIcon,
  RemoteSettingsIcon,
  MachinesSettingsIcon,
  SettledChatsSettingsIcon,
  WorktreesSettingsIcon,
  ArtifactsSettingsIcon,
} from '../AppIcons'
import { AccountAvatar } from '../workspace/AccountAvatar'
import { GlobalSurfaceShell } from '../workspace/globalSurface/GlobalSurfaceShell'
import { useSurfaceBackNav } from '../workspace/globalSurface/surfaceBackNav'
import { getSettingDescriptor, type SettingDescriptor } from './settingsRegistry'
import { TicketTrackersTab } from './TicketTrackersTab'
import { UpdateChannelSettings } from './UpdateChannelSettings'
import { AppVersionRow } from './AppVersionRow'
import { useSettingsUpdateBadges } from './useSettingsUpdateBadges'
import { subscribeAppUpdateState, useAppUpdateStore } from '../../store/appUpdateStore'
import type { SettingsUpdateBadge } from '../../utils/settingsUpdateBadges'
import { sourceUpdateCadenceLine, type SkillRepoTransport } from '../../../../shared/skills'
import { clientSupports, hostPlatform } from '../../clientCapabilities'
import { isImeKey } from '../../utils/imeKey'

interface Props {
  onClose: () => void
  checkForUpdatesOnOpen?: boolean
  checkForUpdatesRequestId?: number
  initialTab?: string | null
  /**
   * Select this machine on the Agents tab — the opener's news is about it (a
   * CLI update is This PC's). A new `requestId` is a new request, so a panel
   * already open on another machine still moves.
   */
  agentsMachineRequest?: { hostId: ExecutionHostId; requestId: number }
  /**
   * `'panel'` (default) wraps the content in `WorkspacePanel` chrome.
   * `'overlay'` is how Settings actually opens (doors→modals, 2026-09-01): the
   * shared surface-shell anatomy inside the host's Modal — the same bar, rail
   * ground, and closing X as Plugins/Automations/Design.
   * `'door'` is the door-era full-page mount (owner, 2026-07-30), kept for a
   * host that routes the card region.
   */
  chrome?: 'panel' | 'overlay' | 'door'
}

type GitHubTokenUiStatus = Awaited<ReturnType<typeof window.api.getGitHubTokenStatus>>

const EMPTY_PROJECT_KNOWLEDGE_ROOTS: Record<string, string | null> = {}
const NO_UPDATE_BADGE_CLIS: ReadonlySet<string> = new Set()

type SettingsTabId =
  | 'general'
  | 'profile'
  | 'appearance'
  | 'shortcuts'
  | 'settled-chats'
  | 'modules'
  | 'github'
  | 'trackers'
  | 'agents'
  | 'providers'
  | 'machines'
  | 'worktrees'
  | 'artifacts'
  | 'knowledge-graph'
  | 'design-system'
  | 'remote'

// Line-weight rail glyph. Built-in tabs carry one from AppIcons; module sections
// reuse their own contributed `moduleSection.icon` (same shape).
type SettingsTabIcon = React.ComponentType<{ className?: string }>

// Declared in rail order: the flat order of this array (filtered to visible
// tabs, then module sections appended) drives index-based roving focus, so it
// must match the grouped visual order in `settingsTabGroups` below. Built-in
// tabs carry no description — the rail label + glyph orient, and each tab body
// self-titles via its own section headings; only module-contributed sections
// take a host-supplied page header (see `bodyContent`).
const settingsTabs: Array<{ id: SettingsTabId; label: string; icon: SettingsTabIcon }> = [
  { id: 'general', label: 'General', icon: GeneralSettingsIcon },
  { id: 'profile', label: 'Profile', icon: ProfileSettingsIcon },
  { id: 'appearance', label: 'Appearance', icon: AppearanceSettingsIcon },
  { id: 'shortcuts', label: 'Shortcuts', icon: ShortcutsSettingsIcon },
  // The chats the sidebar no longer draws once they come to rest (owner,
  // 2026-09-28): the Settled shelf moved here.
  { id: 'settled-chats', label: 'Settled chats', icon: SettledChatsSettingsIcon },
  { id: 'agents', label: 'Agents', icon: AgentsSettingsIcon },
  { id: 'providers', label: 'Providers', icon: ProvidersSettingsIcon },
  // Windows only: this PC and its WSL distributions, each a machine a
  // workspace can run on (shared/execution-host.ts). Elsewhere there is one.
  { id: 'machines', label: 'Machines', icon: MachinesSettingsIcon },
  // Every worktree the agents work in and the pool they come from (owner,
  // 2026-10-05): where each is, who has it, what it costs on disk.
  { id: 'worktrees', label: 'Worktrees', icon: WorktreesSettingsIcon },
  // Where agents publish the pages they make, to open from any device.
  { id: 'artifacts', label: 'Artifacts', icon: ArtifactsSettingsIcon },
  // Covers both groups on the page (the VCS itself, then the hosting provider),
  // so the label is the subject rather than one of the two rows. The tab *id*
  // stays 'github' — it is a persisted deep-link target (menus, module routes).
  { id: 'github', label: 'Version control', icon: GithubSettingsIcon },
  { id: 'trackers', label: 'Ticket trackers', icon: TrackersSettingsIcon },
  { id: 'knowledge-graph', label: 'Knowledge graph', icon: KnowledgeGraphSettingsIcon },
  { id: 'design-system', label: 'Design system', icon: DesignSystemSettingsIcon },
  // Titled for what a person installs; the id stays `modules`, a persisted
  // deep-link target (the Extensions drawer, a disabled door's explainer).
  { id: 'modules', label: 'Extensions', icon: ModulesSettingsIcon },
  { id: 'remote', label: 'Remote', icon: RemoteSettingsIcon },
]

// Rail groups. Labels are internal keys only — the rail separates groups by
// whitespace rather than printing a header — a printed group label would
// restate the rail's own grouping. Module-contributed
// sections render after these under the trailing 'extensions' group.
const settingsTabGroups: Array<{ label: string; ids: SettingsTabId[] }> = [
  { label: 'app', ids: ['general', 'profile', 'appearance', 'shortcuts', 'settled-chats'] },
  { label: 'agents', ids: ['agents', 'providers', 'machines', 'worktrees', 'artifacts'] },
  { label: 'workspace', ids: ['github', 'trackers', 'knowledge-graph', 'design-system', 'modules'] },
  { label: 'companion', ids: ['remote'] },
]

// A rail entry: a built-in tab, or a module-contributed section rendered after
// the built-ins. Contributed tab ids carry a prefix so they can never collide
// with (or spoof) a built-in tab id.
type SettingsTabDescriptor = {
  id: string
  label: string
  // Rail glyph: built-in tabs carry one directly; module sections fall back to
  // their contributed `moduleSection.icon` at render time.
  icon?: SettingsTabIcon
  // Only module-contributed sections carry a description; the host renders it in
  // the section's page header (built-in tabs self-title and take no header).
  description?: string
  moduleSection?: RegisteredSettingsSection
}

const MODULE_SECTION_TAB_PREFIX = 'module-section:'

function moduleSectionTabId(sectionId: string): string {
  return `${MODULE_SECTION_TAB_PREFIX}${sectionId}`
}

function isSettingsTabId(value: unknown): value is SettingsTabId {
  return (
    value === 'general' ||
    value === 'profile' ||
    value === 'appearance' ||
    value === 'shortcuts' ||
    value === 'settled-chats' ||
    value === 'modules' ||
    value === 'github' ||
    value === 'trackers' ||
    value === 'agents' ||
    value === 'providers' ||
    value === 'machines' ||
    value === 'worktrees' ||
    value === 'artifacts' ||
    value === 'knowledge-graph' ||
    value === 'design-system' ||
    value === 'remote'
  )
}

// The 'updates' tab folded into 'general' (its content now renders as a section
// on the General page). Map any legacy deep-link that named the old tab onto
// its new home so bookmarked/menu routes still land correctly.
//
// 'telemetry' was listed here too until 2026-09-08. It named a tab
// this app never shipped a route to — no menu item, no deep-link, no caller
// anywhere in the tree — so it aliased nothing to nothing.
function resolveInitialSettingsTab(initialTab: string | null | undefined): string | null {
  if (initialTab === 'updates') return 'general'
  // The Mobile tab paired a phone through the hosted relay, which was removed
  // (owner ruling 2026-09-27). A phone pairs over the tailnet now, from Remote.
  if (initialTab === 'mobile') return 'remote'
  // Voice dictation was removed (2026-10-09). A persisted route to its tab, in
  // either the built-in or the module-section spelling, lands on General.
  if (initialTab === 'voice-dictation' || initialTab === moduleSectionTabId('voice-dictation')) return 'general'
  return initialTab ?? null
}

// This module used to declare `INPUT_CLASS` and `ROW_INPUT_CLASS` — and so did
// `ProviderSettingsTab` (a copy of the first) and `ProjectKnowledgeList` (a
// DIFFERENT field under the second's name: `--bg-surface` and full-width against
// this one's `--bg-app` and content-sized). All four are `ui/Input` now: the
// well recipe is the kit's `variant="well"`, and the settings inset is its `md`
// step.
//
// What stays here is per-field CONTENT, not chrome. `font-mono` because a row
// input holds an identifier (a command, a model id, a token) rather than prose,
// and the two textarea shapes below, which differ by what the author is writing.
const MONO_FIELD = 'font-mono'
// Row controls are sized to their expected content, never stretched to the panel
// — 240px is the standard row measure. Passed with `fullWidth={false}` because
// Tailwind resolves two width utilities by stylesheet order, not string order.
const ROW_FIELD = 'w-60 max-w-full font-mono'

function RegistrySwitchRow({
  descriptor,
  checked,
  onChange,
  disabled,
}: {
  descriptor: SettingDescriptor
  checked: boolean
  onChange: (next: boolean) => void
  disabled?: boolean
}) {
  if (descriptor.field.type !== 'switch') return null
  return (
    <SettingToggle
      label={descriptor.label}
      description={descriptor.help}
      enabled={checked}
      onChange={onChange}
      disabled={disabled}
    />
  )
}

// Number input for terminal-memory settings ("Pause idle terminals after",
// "Always keep running"). Edits live in local string state so a half-typed or
// briefly-empty value isn't clamped/rounded out from under the user; the store
// (which clamps to the field's min/max) is written on blur or Enter. A
// blank/invalid commit reverts to the persisted value.
function CommittedNumberField({
  descriptor,
  value,
  onCommit,
}: {
  descriptor: SettingDescriptor
  value: number
  onCommit: (value: number) => void
}) {
  const [draft, setDraft] = useState<string>(String(value))
  useEffect(() => {
    setDraft(String(value))
  }, [value])
  if (descriptor.field.type !== 'number') return null
  const { min, max, step } = descriptor.field
  const commit = (): void => {
    // Revert a blank/whitespace field to the persisted value — `Number('')` is 0
    // (finite), which would otherwise clamp to the field floor rather than
    // restore what the user had.
    const parsed = draft.trim() === '' ? NaN : Number(draft)
    if (!Number.isFinite(parsed)) {
      setDraft(String(value))
      return
    }
    // Clamp locally with the field's own bounds (they mirror the store
    // normalizer): when the clamped result equals the stored value the store
    // write is a no-op — no re-render, no sync effect — so the draft must be
    // corrected here or it keeps displaying the out-of-range text.
    const clamped = Math.max(min ?? -Infinity, Math.min(max ?? Infinity, Math.round(parsed)))
    onCommit(clamped)
    setDraft(String(clamped))
  }
  return (
    <SettingsRow label={descriptor.label} help={descriptor.help} htmlFor={descriptor.id}>
      <Input
        id={descriptor.id}
        type="number"
        inputMode="numeric"
        min={min}
        max={max}
        step={step}
        value={draft}
        onChange={(event) => setDraft(event.target.value)}
        onBlur={commit}
        onKeyDown={(event) => {
          if (isImeKey(event)) return
          if (event.key === 'Enter') event.currentTarget.blur()
        }}
        size="md"
        variant="well"
        fullWidth={false}
        className={`w-20 text-right ${MONO_FIELD}`}
      />
    </SettingsRow>
  )
}

function IdleSuspendField({ descriptor }: { descriptor: SettingDescriptor }) {
  const minutes = useWorkspaceStore((s) => s.appSettings.terminalIdleSuspendMinutes)
  const setMinutes = useWorkspaceStore((s) => s.setTerminalIdleSuspendMinutes)
  return <CommittedNumberField descriptor={descriptor} value={minutes} onCommit={setMinutes} />
}

function KeepRecentAliveField({ descriptor }: { descriptor: SettingDescriptor }) {
  const count = useWorkspaceStore((s) => s.appSettings.terminalKeepRecentAlive)
  const setCount = useWorkspaceStore((s) => s.setTerminalKeepRecentAlive)
  return <CommittedNumberField descriptor={descriptor} value={count} onCommit={setCount} />
}

// The Agents page header: the name on the left, the freshness fact and the two
// page controls on the right. The one chrome row for this page — the fact and
// the control that refreshes it share a band rather than stacking a toolbar on
// a status line. The count is not here: it sits on the Agent CLIs section band
// over the list it counts, and the same number in two places is two chances to
// disagree.
function AgentCliBand({
  checkedAt,
  rechecking,
  onRecheck,
}: {
  checkedAt: number | null
  rechecking: boolean
  onRecheck: () => void
}) {
  // The meta has to age or it lies: "checked just now" would stay on screen
  // for an hour. The band reads the shared clock itself and draws again only
  // when the words change, so the minute stays honest without the whole
  // Agents tab re-rendering on every tick to draw "checked 3h ago" again.
  const now = useRelativeNowFor((at) => formatRelativeMsAgo(checkedAt, at))
  const freshness = formatRelativeMsAgo(checkedAt, now)
  const meta = freshness ? `checked ${freshness}` : undefined
  return (
    <SettingsPageHeader
      title="Agents"
      meta={meta}
      actions={
        <>
          <Tooltip content="Re-check every CLI now">
            <IconButton
              aria-label={rechecking ? 'Re-checking every CLI' : 'Re-check every CLI now'}
              disabled={rechecking}
              onClick={onRecheck}
            >
              {/* Detection on every machine can take a few seconds, so the
                  glyph says it is running rather than the button going quiet. */}
              {rechecking ? <Spinner className="icon-sm" /> : <RefreshIcon />}
            </IconButton>
          </Tooltip>
        </>
      }
    />
  )
}

// The mono mark for a version-control provider. The repo ships no brand logo for
// either of these — `git` and `gh` are command-line binaries whose identity IS
// their name — so the mark is the binary's name in the same 22px monogram box
// the tracker connections list uses, sized by ProviderRow's slot.
function VersionControlMark({ monogram }: { monogram: string }) {
  return (
    <span
      aria-hidden="true"
      className="flex size-icon-lg items-center justify-center rounded-[var(--radius-xs)] border border-[color:var(--border-subtle)] bg-[color:var(--bg-app)] font-mono text-micro font-semibold text-[color:var(--text-muted)]"
    >
      {monogram}
    </span>
  )
}

// The state line for one provider row: the words from the view model, with the
// identifiers inside them mono. Every branch is a state the probe can actually
// report — there is no "unknown version" placeholder and no caption explaining
// what the provider is for.
//
// The install and auth lines are the only sentences on this page that carry more
// than a state, and they earn it: the one command that fixes the row is a
// consequence the screen cannot otherwise show.
function VersionControlStateLine({ view }: { view: VersionControlRowView }) {
  switch (view.kind) {
    case 'checking':
      return <>Checking…</>
    case 'available':
      return <>Available</>
    case 'authenticated':
      return (
        <>
          {'Authenticated as '}
          <ProviderStateId>{view.login}</ProviderStateId>
        </>
      )
    case 'unauthenticated':
      return (
        <>
          {'Not authenticated — '}
          <ProviderStateId>{view.command}</ProviderStateId>
        </>
      )
    case 'not-installed':
      return view.command ? (
        <>
          {'Not installed — '}
          <ProviderStateId>{view.command}</ProviderStateId>
          {view.thenAuthenticate ? ', then authenticate' : null}
        </>
      ) : (
        <>
          {'Not installed — no '}
          <ProviderStateId>{view.binary}</ProviderStateId>
          {' on PATH'}
        </>
      )
    case 'probe-failed':
      return <>Availability unknown — the check did not complete</>
  }
}

// The version-control tab body: two spaced sections of provider rows over the
// read-only probe, and the GitHub access token behind the GitHub row's own
// disclosure.
//
// Its own component so the probe runs when the tab mounts, not when the Settings
// dialog opens: the channel spawns a login shell per provider plus `gh auth
// status` and has no cache in front of it, so it is called on mount and on an
// explicit re-check, never per render.
//
// **No enablement switch, deliberately.** The mockup draws one per row, but this
// product has no git or GitHub enablement to write to: git's backend is
// foundational (always registered, because editor and explorer decorations call
// it unconditionally), the `git` module override governs the Git *panel* — a
// different fact, already owned by the Modules tab — and GitHub has no module at
// all. ProviderRow's contract is explicit that a host with no real enablement
// state passes no switch rather than rendering a dead one, and a switch that
// only looks like it does something is worse than the absence of one. The dot
// and the state line carry health; nothing here pretends to carry enablement.
export function VersionControlSections({ githubToken }: { githubToken: React.ReactNode }) {
  const [probes, setProbes] = useState<Partial<Record<VersionControlProviderId, VersionControlProviderProbe>>>({})
  // Git on the other machines of this computer (the WSL machines turned on in
  // Settings ▸ Machines), each its own row: a WSL workspace's git is its
  // distribution's (owner decision 2026-09-24). Empty on macOS and Linux.
  const [machineProbes, setMachineProbes] = useState<VersionControlProviderProbe[]>([])
  const [probeStatus, setProbeStatus] = useState<VersionControlProbeStatus>('loading')
  const [probeError, setProbeError] = useState<string | null>(null)
  const [checking, setChecking] = useState(false)
  const [expandedId, setExpandedId] = useState<VersionControlProviderId | null>(null)
  const sections = useMemo(() => versionControlSections(), [])
  const platform = hostPlatform()

  const runProbe = useCallback(async () => {
    if (typeof window.api.probeVersionControlProviders !== 'function') {
      // An older preload than this renderer. Named as the missing capability it
      // is, rather than letting the call throw a TypeError whose message would
      // reach the screen as "… is not a function".
      setProbeStatus('error')
      setProbeError(null)
      return
    }
    setChecking(true)
    try {
      const results = await window.api.probeVersionControlProviders()
      // Replace rather than merge: a re-check is a fresh reading of the machine,
      // so a provider that disappeared must not keep its old version line.
      setProbes(Object.fromEntries(results.filter((result) => !result.machine).map((result) => [result.id, result])))
      setMachineProbes(results.filter((result) => result.machine))
      setProbeStatus('ready')
      setProbeError(null)
    } catch (error) {
      // The whole round-trip failed, which is one fact about the list — stated
      // once under the first band rather than repeated down every row. The rows
      // keep whatever they had already resolved; only the ones with no answer
      // read as unknown.
      setProbeStatus('error')
      setProbeError(error instanceof Error ? error.message : String(error))
    } finally {
      setChecking(false)
    }
  }, [])

  useEffect(() => {
    void runProbe()
  }, [runProbe])

  return (
    <div>
      {/* The page header every other tab draws. The first band IS the page —
          its title would only repeat the header — so it is labelled by the
          header and draws no title of its own; the later bands keep theirs.
          One chrome row for the whole page: both sections read from the same
          round-trip, so the control that refreshes it sits in the header. */}
      <SettingsPageHeader
        id="version-control-page"
        title="Version control"
        actions={
          <Tooltip content="Re-check now">
            <IconButton aria-label="Re-check now" disabled={checking} onClick={() => void runProbe()}>
              {checking ? <Spinner className="icon-sm" /> : <RefreshIcon />}
            </IconButton>
          </Tooltip>
        }
      />
      <div className="space-y-6">
        {sections.map((section, index) => (
          <section
            key={section.id}
            aria-labelledby={index === 0 ? 'version-control-page' : `version-control-${section.id}`}
            className="space-y-2"
          >
            {index === 0 ? null : (
              <SettingsSectionTitle id={`version-control-${section.id}`}>{section.title}</SettingsSectionTitle>
            )}

            {/* The app's one error card, not a tone-bar: a 1px hairline, the soft
              tint, and the tone glyph, with the raw message behind "Show
              details" rather than inline. No action of its own — the re-check
              control that would retry it sits in the page header above. */}
            {index === 0 && probeStatus === 'error' ? (
              <InlineNotice
                tone="warn"
                title="Version control could not be checked."
                detail={probeError ?? undefined}
              />
            ) : null}

            {/* The list card (setting-row → The list card, 2026-09-15): the band
              above names the group, the card is its one edge, and the rows sit
              full-bleed inside it — as the Remote tab's machines do. */}
            <SettingCard as="ul" ariaLabel={section.title}>
              {section.providers.map((spec) => {
                const view = resolveVersionControlRow(spec, probes[spec.id], probeStatus, platform)
                // Only GitHub has per-instance configuration to reveal (the app's own
                // access token). ProviderRow draws no chevron for a row with nothing
                // behind it, so git renders as a plain row rather than an empty
                // disclosure.
                const detail = spec.id === 'gh' ? githubToken : null
                // One row per machine for git: this one, then each WSL machine.
                const others = spec.id === 'git' ? machineProbes : []
                return (
                  <React.Fragment key={spec.id}>
                    <ProviderRow
                      as="li"
                      surface="card"
                      icon={<VersionControlMark monogram={spec.monogram} />}
                      health={view.tone}
                      name={others.length > 0 ? `${spec.label} — This PC (Windows)` : spec.label}
                      version={view.version}
                      stateLine={<VersionControlStateLine view={view} />}
                      expanded={expandedId === spec.id}
                      onExpandedChange={(next) => setExpandedId(next ? spec.id : null)}
                    >
                      {detail}
                    </ProviderRow>
                    {others.map((probe) => {
                      // A distribution has no install command this app can name
                      // (apt, dnf, pacman…), so a missing git names the binary.
                      const machineView = resolveVersionControlRow(spec, probe, probeStatus, 'linux')
                      return (
                        <ProviderRow
                          key={`${spec.id}:${probe.machine?.hostId}`}
                          as="li"
                          surface="card"
                          icon={<VersionControlMark monogram={spec.monogram} />}
                          health={machineView.tone}
                          name={`${spec.label} — ${probe.machine?.label ?? ''}`}
                          version={machineView.version}
                          stateLine={<VersionControlStateLine view={machineView} />}
                        />
                      )
                    })}
                  </React.Fragment>
                )
              })}
            </SettingCard>
          </section>
        ))}
      </div>
    </div>
  )
}

export default function SettingsPanel({
  onClose,
  checkForUpdatesOnOpen = false,
  checkForUpdatesRequestId,
  initialTab = null,
  agentsMachineRequest,
  chrome = 'panel',
}: Props) {
  const activeWorkspace = useWorkspaceStore(
    (s) => s.workspaces.find((workspace) => workspace.id === s.activeWorkspaceId) ?? null,
  )
  // The door chrome's back chevron. Closes by Settings' own route — the generic
  // one clears the active surface but not the request that opened this door, so
  // the next cog press would reopen on the tab you left rather than the one you
  // asked for. Harmless in the other chromes, which never read it.
  const doorBack = useSurfaceBackNav(onClose)
  // Settled chats' Open: the chat becomes the active one and Settings gets out
  // of the way. `setActiveWorkspace` clears the routed surfaces itself; the
  // explicit close is what clears the request that opened this modal, so the
  // next cog press does not reopen on this tab.
  const setActiveWorkspace = useWorkspaceStore((s) => s.setActiveWorkspace)
  const openSettledChat = useCallback(
    (id: string) => {
      setActiveWorkspace(id)
      onClose()
    },
    [setActiveWorkspace, onClose],
  )
  const dialog = useConfirmDialog()
  const cliRuntimes = useWorkspaceStore((s) => s.appSettings.cliRuntimes)
  const pluginCatalogEntries = useWorkspaceStore((s) => s.pluginCatalogEntries)
  const refreshCliAvailability = useWorkspaceStore((s) => s.refreshCliAvailability)
  // Session-scoped: adoption runs at the first workspace creation, and this is
  // where its outcome is reported. Null (and so silent) in every later session.
  const agentConfigAdoptionResult = useWorkspaceStore((s) => s.agentConfigAdoptionResult)
  const cliAvailabilityCheckedAt = useWorkspaceStore((s) => s.cliAvailabilityCheckedAt)
  const refreshCliVersionAdvisories = useWorkspaceStore((s) => s.refreshCliVersionAdvisories)
  const checkCliVersions = useWorkspaceStore((s) => s.checkCliVersions)
  const setCheckCliVersions = useWorkspaceStore((s) => s.setCheckCliVersions)
  const installedPluginRows = useMemo(() => orderInstalledPlugins(pluginCatalogEntries), [pluginCatalogEntries])
  const projectKnowledgeRoots = useWorkspaceStore(
    (s) => s.appSettings.projectKnowledgeRoots ?? EMPTY_PROJECT_KNOWLEDGE_ROOTS,
  )
  // Profile tab reads the shared auth projection and drives the same auth IPC as
  // the sidebar account popover — no new state, just a fuller management surface.
  const authState = useWorkspaceStore((s) => s.authState)
  const setAuthState = useWorkspaceStore((s) => s.setAuthState)
  const [profileMessage, setProfileMessage] = useState<string | null>(null)
  const [profilePending, setProfilePending] = useState(false)
  const moduleEnablement = useWorkspaceStore((s) => s.appSettings.modules)
  // Module-contributed sections render after every built-in tab, in the
  // registry's stable order (order hint, then id). Disabling a module drops
  // its section reactively; persisted values stay in the module namespace.
  const moduleSections = useMemo(
    () => getRendererHost().getSettingsSections((moduleId) => selectModuleEnabled(moduleEnablement, moduleId)),
    [moduleEnablement],
  )
  const visibleSettingsTabs = useMemo(
    (): SettingsTabDescriptor[] => [
      // The server's machine on Windows: its WSL distributions. Any platform
      // with the SSH machines preview on: the SSH machines (phase 8).
      ...settingsTabs.filter(
        (tab) => tab.id !== 'machines' || hostPlatform() === 'win32' || window.api.sshMachinesEnabled === true,
      ),
      ...moduleSections.map((section) => ({
        id: moduleSectionTabId(section.id),
        label: section.label,
        description: section.description ?? `From the ${section.moduleId} module`,
        moduleSection: section,
      })),
    ],
    [moduleSections],
  )
  const appearanceTheme = useWorkspaceStore((s) => s.appSettings.appearance.theme)
  const setAppearanceTheme = useWorkspaceStore((s) => s.setAppearanceTheme)
  const appearanceWindowMaterial = useWorkspaceStore((s) => s.appSettings.appearance.windowMaterial)
  const setAppearanceWindowMaterial = useWorkspaceStore((s) => s.setAppearanceWindowMaterial)
  const agentCharacters = useWorkspaceStore((s) => s.appSettings.appearance.agentCharacters)
  const setAppearanceAgentCharacters = useWorkspaceStore((s) => s.setAppearanceAgentCharacters)
  const usageLimits = useWorkspaceStore((s) => s.appSettings.appearance.usageLimits)
  const setAppearanceUsageLimits = useWorkspaceStore((s) => s.setAppearanceUsageLimits)
  const isMac = window.api.platform === 'darwin'
  const chatListView = useWorkspaceStore((s) => s.chatListView)
  const sidebarWorkingSection = useWorkspaceStore((s) => s.appSettings.sidebarWorkingSection)
  const setSidebarWorkingSection = useWorkspaceStore((s) => s.setSidebarWorkingSection)
  const openFilesInExternalWindow = useWorkspaceStore((s) => s.openFilesInExternalWindow)
  const setOpenFilesInExternalWindow = useWorkspaceStore((s) => s.setOpenFilesInExternalWindow)
  const setChatListView = useWorkspaceStore((s) => s.setChatListView)
  const keepRunningInBackground = useWorkspaceStore((s) => s.appSettings.keepRunningInBackground)
  const telemetryEnabled = useWorkspaceStore((s) => s.appSettings.telemetryEnabled)
  const setKeepRunningInBackground = useWorkspaceStore((s) => s.setKeepRunningInBackground)
  const setTelemetryEnabled = useWorkspaceStore((s) => s.setTelemetryEnabled)
  const activeKnowledgeConfig = resolveProjectKnowledgeConfig(
    activeWorkspace?.folderPath,
    projectKnowledgeRoots,
    activeWorkspace?.memory.relativeRoot,
  )
  const activeProjectRoot = activeKnowledgeConfig?.projectRoot ?? activeWorkspace?.folderPath ?? null
  const activeDesignSystemRoot = activeWorkspace?.folderPath ?? null
  // The app update as main reports it, shared with the Settings badges
  // (appUpdateStore) so the version row and the badge on General are one answer.
  const updateState = useAppUpdateStore((s) => s.state)
  const setUpdateState = useAppUpdateStore((s) => s.setState)
  const updateBadges = useSettingsUpdateBadges()
  const [updateActionPending, setUpdateActionPending] = useState(false)
  const [githubTokenStatus, setGithubTokenStatus] = useState<GitHubTokenUiStatus | null>(null)
  // Which transport the skills service reads repositories over, because the
  // cadence line below is a different sentence on each (git-transport ruling,
  // owner 2026-09-08). Null until the answer lands: guessing 'api' told a
  // machine with git that it checks once a day, which was simply false
  // (review, 2026-09-09) — the line waits for the fact instead.
  const [skillRepoTransport, setSkillRepoTransport] = useState<SkillRepoTransport | null>(null)
  const [githubTokenDraft, setGithubTokenDraft] = useState('')
  const [githubTokenMessage, setGithubTokenMessage] = useState('')
  const [githubTokenPending, setGithubTokenPending] = useState(false)
  // True while the user is replacing an already-saved token; the write-only
  // input only renders when there is nothing saved or a replace is underway.
  const [githubTokenEditing, setGithubTokenEditing] = useState(false)
  const [activityInstalled, setActivityInstalled] = useState(false)
  const [activityPending, setActivityPending] = useState(false)
  const [activityMessage, setActivityMessage] = useState<string | null>(null)
  // Built-in tab ids plus `module-section:<id>` for contributed sections. An
  // initialTab may name either; unknown values fall back to the default tab.
  // (Deep-links to the folded MCPs / Skill packs / Extensions tabs are routed to
  // the Connectors surface upstream in the store, so they never reach here.)
  const [activeSettingsTab, setActiveSettingsTab] = useState<string>(() => {
    const resolved = resolveInitialSettingsTab(initialTab)
    if (isSettingsTabId(resolved)) return resolved
    // A deep-link may land on a contributed section; a section that isn't
    // actually visible falls back to the first visible tab via the effect below.
    if (typeof resolved === 'string' && resolved.startsWith(MODULE_SECTION_TAB_PREFIX)) return resolved
    return 'general'
  })

  useEffect(() => {
    const resolved = resolveInitialSettingsTab(initialTab)
    if (isSettingsTabId(resolved) || (typeof resolved === 'string' && resolved.startsWith(MODULE_SECTION_TAB_PREFIX))) {
      setActiveSettingsTab(resolved)
      window.requestAnimationFrame(() => tabRefs.current[resolved]?.focus())
    }
  }, [initialTab])

  // Refresh CLI detection when the Agents tab opens so every row shows current
  // status. Cache-respecting (no force), so it's a cheap no-op when fresh.
  useEffect(() => {
    if (activeSettingsTab !== 'agents') return
    void refreshCliAvailability({ cliRuntimes })
  }, [activeSettingsTab, refreshCliAvailability, cliRuntimes])

  // Which machine's agent CLIs the Agents tab lists (owner ruling 2026-09-24):
  // this one, and each WSL distribution turned on in Settings ▸ Machines. One
  // machine — every macOS and Linux install, and Windows with no distribution
  // on — draws no switcher, and the tab is the one it always was. The pick is
  // the window's last one while that machine is still offered, else this one.
  // Listed only once the Agents tab is shown: on Windows the first listing can
  // start WSL, and opening Settings on General should not.
  const { listing: agentsHostListing } = useExecutionHosts({ enabled: activeSettingsTab === 'agents' })
  const agentsMachineOptions = useMemo(
    () => agentsMachines(agentsHostListing, executionHostLabel(LOCAL_HOST_ID, hostPlatform())),
    [agentsHostListing],
  )
  const [pickedAgentsMachine, setPickedAgentsMachine] = useState<ExecutionHostId | null>(
    () => agentsMachineRequest?.hostId ?? lastAgentsMachine(),
  )
  const agentsMachine = resolveAgentsMachine(agentsMachineOptions, pickedAgentsMachine)
  const selectAgentsMachine = useCallback((id: ExecutionHostId) => {
    rememberAgentsMachine(id)
    setPickedAgentsMachine(id)
  }, [])
  // An opener that knows which machine its news is about (a CLI update toast,
  // its bell row, a card that named the retired Agent CLIs view) selects it —
  // on first mount through the state above, and on every later request here.
  const agentsMachineRequestId = agentsMachineRequest?.requestId
  const agentsMachineRequestHost = agentsMachineRequest?.hostId
  useEffect(() => {
    if (agentsMachineRequestId === undefined || !agentsMachineRequestHost) return
    selectAgentsMachine(agentsMachineRequestHost)
    // A machine request is always about the Agents tab, even when the panel was
    // already open on the same `initialTab` and the person has since moved on.
    setActiveSettingsTab('agents')
  }, [agentsMachineRequestId, agentsMachineRequestHost, selectAgentsMachine])
  const agentsCliIds = useMemo(() => installedPluginRows.map((plugin) => plugin.id), [installedPluginRows])
  // A WSL machine is probed only while its list is on screen: asking starts a
  // process inside the distribution.
  const agentsMachineCli = useMachineCliAvailability(
    activeSettingsTab === 'agents' ? agentsMachine.id : LOCAL_HOST_ID,
    agentsCliIds,
  )
  const agentsOnWsl = agentsMachine.id !== LOCAL_HOST_ID
  const agentCliRuns = useAgentCliRuns()
  // Re-check is the one time after startup that detection runs again: main
  // detects every CLI on every machine the switcher offers, then compares
  // against the registry, and both lists read that answer back. The hourly
  // check never detects, so a CLI installed or removed outside the app shows
  // here once this is pressed.
  const [agentsRechecking, setAgentsRechecking] = useState(false)
  // Re-check asks a WSL machine's `gh` again too.
  const [agentsGhRecheck, setAgentsGhRecheck] = useState(0)
  const reloadAgentsMachine = agentsMachineCli.reload
  const recheckAgentClis = useCallback(async () => {
    setAgentsRechecking(true)
    setAgentsGhRecheck((count) => count + 1)
    try {
      await refreshCliVersionAdvisories({ detect: true, ...(checkCliVersions ? { force: true } : {}) })
      await refreshCliAvailability({ cliRuntimes })
      reloadAgentsMachine()
    } finally {
      setAgentsRechecking(false)
    }
  }, [checkCliVersions, cliRuntimes, refreshCliAvailability, refreshCliVersionAdvisories, reloadAgentsMachine])

  // If the active tab is no longer visible (e.g. the Mobile module was disabled
  // while its tab was active), fall back to the first visible tab so the panel
  // body never goes blank on a hidden tab.
  useEffect(() => {
    if (!visibleSettingsTabs.some((tab) => tab.id === activeSettingsTab)) {
      setActiveSettingsTab(visibleSettingsTabs[0]?.id ?? 'general')
    }
  }, [visibleSettingsTabs, activeSettingsTab])
  // Keyed by tab id; contributed `module-section:*` ids join the built-ins, so
  // the map is open-keyed rather than a closed SettingsTabId record.
  const tabRefs = useRef<Record<string, HTMLButtonElement | null>>({})
  const autoCheckStartedRef = useRef(false)
  const lastUpdateRequestIdRef = useRef<number | null>(null)

  // Knowledge-graph activity tracking is workspace-scoped: probe install state
  // when a workspace is open, and reset it otherwise. (Built-in skills moved to
  // the Connectors surface with the folded MCPs/Skill packs/Extensions tabs.)
  useEffect(() => {
    let cancelled = false
    setActivityMessage(null)
    if (!activeProjectRoot) {
      setActivityInstalled(false)
      return
    }
    void window.api.memoryActivityIsInstalled({ workspaceRoot: activeProjectRoot }).then((installed) => {
      if (!cancelled) setActivityInstalled(installed)
    })
    return () => {
      cancelled = true
    }
  }, [activeProjectRoot])

  const toggleActivityTracking = useCallback(
    async (next: boolean) => {
      if (!activeProjectRoot) return
      const memoryRoot = activeKnowledgeConfig?.relativeRoot ?? null
      if (next && !memoryRoot) {
        setActivityMessage('Configure a knowledge folder before enabling activity tracking.')
        return
      }
      if (next) {
        const confirmed = await dialog.confirm({
          title: 'Enable activity tracking?',
          body: (
            <>
              <div>What happens:</div>
              <ul className="mt-1 list-disc pl-5">
                <li>Claude Code agents you start here get a hook that notes each knowledge file they read or edit</li>
                <li>
                  The notes are kept in this project’s folder under{' '}
                  <span className="font-mono">~/.sprintengine/workspaces/</span>
                </li>
              </ul>
              <div className="mt-2">
                Only files under your knowledge folder are recorded. Nothing is written into the project folder.
              </div>
            </>
          ),
          confirmLabel: 'Enable tracking',
        })
        if (!confirmed) return
      }
      setActivityPending(true)
      setActivityMessage(null)
      try {
        if (next) {
          const result = await window.api.memoryActivityInstall({
            workspaceRoot: activeProjectRoot,
            memoryRelativeRoot: memoryRoot,
          })
          if (result.ok) {
            setActivityInstalled(true)
          } else {
            setActivityMessage(result.message)
          }
        } else {
          const result = await window.api.memoryActivityUninstall({
            workspaceRoot: activeProjectRoot,
          })
          if (result.ok) {
            setActivityInstalled(false)
          } else {
            setActivityMessage(result.message)
          }
        }
      } catch (error) {
        setActivityMessage(error instanceof Error ? error.message : 'Failed to update activity tracking.')
      } finally {
        setActivityPending(false)
      }
    },
    [activeKnowledgeConfig?.relativeRoot, activeProjectRoot],
  )

  useEffect(() => {
    let cancelled = false
    void window.api.getGitHubTokenStatus().then((status) => {
      if (!cancelled) setGithubTokenStatus(status)
    })
    return () => {
      cancelled = true
    }
  }, [])

  useEffect(() => {
    if (typeof window.api.skillsListSources !== 'function') return
    let cancelled = false
    void window.api
      .skillsListSources()
      .then((result) => {
        if (!cancelled && result.ok) setSkillRepoTransport(result.transport ?? 'api')
      })
      .catch(() => undefined)
    return () => {
      cancelled = true
    }
  }, [])

  // The window's shell keeps the store current too; subscribing here as well is
  // what a panel mounted on its own (tests, the door chrome) needs.
  useEffect(() => subscribeAppUpdateState(), [])

  const checkForUpdates = useCallback(async () => {
    setUpdateActionPending(true)
    try {
      const result = await window.api.updateCheck()
      setUpdateState(result.state)
    } finally {
      setUpdateActionPending(false)
    }
  }, [setUpdateState])

  // Profile actions — thin wrappers over the same auth IPC the sidebar account
  // menu uses, kept local so the Settings panel needs no auth props threaded in.
  const onProfileSignIn = useCallback(async () => {
    setProfileMessage('Opening sign-in.')
    setProfilePending(true)
    try {
      await window.api.authLogin(authState.selectedOrganization?.id ?? null)
      setProfileMessage(null)
    } catch (error) {
      setProfileMessage(error instanceof Error ? error.message : String(error))
    } finally {
      setProfilePending(false)
    }
  }, [authState.selectedOrganization?.id])

  const onProfileRefresh = useCallback(async () => {
    setProfileMessage('Checking account.')
    setProfilePending(true)
    try {
      setAuthState(await window.api.authRefreshAccount())
      setProfileMessage(null)
    } catch (error) {
      setProfileMessage(error instanceof Error ? error.message : String(error))
    } finally {
      setProfilePending(false)
    }
  }, [setAuthState])

  const onProfileSignOut = useCallback(async () => {
    setProfilePending(true)
    try {
      await window.api.authLogout()
      setProfileMessage(null)
    } finally {
      setProfilePending(false)
    }
  }, [])

  useEffect(() => {
    if (typeof checkForUpdatesRequestId === 'number') {
      if (lastUpdateRequestIdRef.current === checkForUpdatesRequestId) return
      lastUpdateRequestIdRef.current = checkForUpdatesRequestId
      void checkForUpdates()
      return
    }

    if (!checkForUpdatesOnOpen || autoCheckStartedRef.current) return
    autoCheckStartedRef.current = true
    void checkForUpdates()
  }, [checkForUpdates, checkForUpdatesOnOpen, checkForUpdatesRequestId])

  const onUpdateChannelResult = useCallback(
    (result: { state: AppUpdateState }) => setUpdateState(result.state),
    [setUpdateState],
  )

  const downloadUpdate = useCallback(async () => {
    setUpdateActionPending(true)
    try {
      const result = await window.api.updateDownload()
      setUpdateState(result.state)
    } finally {
      setUpdateActionPending(false)
    }
  }, [setUpdateState])

  // The press shows at once (the button goes busy before main is asked), and
  // main's `installing` state keeps it busy until the app hands over.
  const restartToInstall = useCallback(async () => {
    setUpdateActionPending(true)
    try {
      const result = await window.api.updateQuitAndInstall()
      setUpdateState(result.state)
    } finally {
      setUpdateActionPending(false)
    }
  }, [setUpdateState])

  const setAutoDownload = useCallback(
    async (enabled: boolean) => {
      setUpdateState(await window.api.updateSetAutoDownload(enabled))
    },
    [setUpdateState],
  )

  const saveGitHubToken = useCallback(async () => {
    const token = githubTokenDraft.trim()
    if (!token) {
      setGithubTokenMessage('Paste a token before saving.')
      return
    }

    setGithubTokenPending(true)
    setGithubTokenMessage('')
    try {
      const status = await window.api.setGitHubToken(token)
      setGithubTokenStatus(status)
      setGithubTokenDraft('')
      setGithubTokenEditing(false)
      setGithubTokenMessage('Saved. Studio can now read private GitHub repositories.')
    } catch (error) {
      setGithubTokenMessage(error instanceof Error ? error.message : 'Could not save the GitHub token.')
    } finally {
      setGithubTokenPending(false)
    }
  }, [githubTokenDraft])

  const clearGitHubToken = useCallback(async () => {
    setGithubTokenPending(true)
    setGithubTokenMessage('')
    try {
      const status = await window.api.clearGitHubToken()
      setGithubTokenStatus(status)
      setGithubTokenDraft('')
      setGithubTokenEditing(false)
      setGithubTokenMessage(
        status.configured && status.source === 'environment'
          ? 'Saved token cleared. GitHub imports are still using a token from the environment.'
          : 'GitHub token cleared.',
      )
    } catch (error) {
      setGithubTokenMessage(error instanceof Error ? error.message : 'Could not clear the GitHub token.')
    } finally {
      setGithubTokenPending(false)
    }
  }, [])

  // Write-only token entry: render the input only when nothing is saved or the
  // user is replacing; a saved token reads as meta text plus Replace/Clear.
  const githubTokenInputVisible = githubTokenStatus !== null && (githubTokenEditing || !githubTokenStatus.configured)

  const activeTab = visibleSettingsTabs.find((tab) => tab.id === activeSettingsTab) ?? visibleSettingsTabs[0]

  const idleSuspendDescriptor = getSettingDescriptor('terminal-idle-suspend-minutes')
  const keepRecentAliveDescriptor = getSettingDescriptor('terminal-keep-recent-alive')
  const backgroundModeDescriptor = getSettingDescriptor('keep-running-in-background')
  const telemetryDescriptor = getSettingDescriptor('telemetry-enabled')

  const selectSettingsTab = useCallback((tabId: string) => {
    setActiveSettingsTab(tabId)
  }, [])

  const onSettingsTabKeyDown = useCallback(
    (event: React.KeyboardEvent<HTMLButtonElement>, index: number) => {
      const keyToIndex: Record<string, number> = {
        ArrowDown: (index + 1) % visibleSettingsTabs.length,
        ArrowRight: (index + 1) % visibleSettingsTabs.length,
        ArrowUp: (index - 1 + visibleSettingsTabs.length) % visibleSettingsTabs.length,
        ArrowLeft: (index - 1 + visibleSettingsTabs.length) % visibleSettingsTabs.length,
        Home: 0,
        End: visibleSettingsTabs.length - 1,
      }
      const nextIndex = keyToIndex[event.key]
      if (nextIndex === undefined) return
      event.preventDefault()
      const nextTab = visibleSettingsTabs[nextIndex]
      setActiveSettingsTab(nextTab.id)
      window.requestAnimationFrame(() => tabRefs.current[nextTab.id]?.focus())
    },
    [visibleSettingsTabs],
  )

  // Flat index into visibleSettingsTabs for roving focus; the grouped rail
  // renders in the same order, so arrow keys move in visual order.
  const tabIndexById = new Map(visibleSettingsTabs.map((tab, index) => [tab.id, index] as const))
  // Module-contributed sections trail the built-in groups as one final group.
  // (The built-in Extensions tab folded into the Connectors surface — T3.)
  const moduleSectionTabs = visibleSettingsTabs.filter((tab) => tab.moduleSection)
  const railGroups = [
    ...settingsTabGroups
      .map((group) => ({
        label: group.label,
        tabs: group.ids
          .map((id) => visibleSettingsTabs.find((tab) => tab.id === id))
          .filter((tab): tab is SettingsTabDescriptor => tab !== undefined),
      }))
      .filter((group) => group.tabs.length > 0),
    ...(moduleSectionTabs.length > 0 ? [{ label: 'extensions', tabs: moduleSectionTabs }] : []),
  ]

  // Groups carry no printed header — they read as one list separated by a
  // whitespace gap. `label` stays as the React key only.
  //
  // The column is a rail, so it takes the rail's scrollport inset
  // (`--sem-space-2xs`, 4px — design-system/patterns/context-rail.html) rather
  // than sitting flush against the modal's edge: 4 + 8 (row padding) + 16 (icon
  // slot) + 8 (gap) is the 36px title line every other rail in the product puts
  // its labels on, and the inset is what keeps a row's hover fill off the edge.
  // It scrolls here too — the category list outgrows a short window, and the
  // shell's aside does not scroll for it.
  const sidebarNode = (
    <div
      role="tablist"
      aria-label="Settings categories"
      aria-orientation="vertical"
      className="min-h-0 flex-1 overflow-y-auto px-1 py-2"
    >
      {railGroups.map((group) => (
        <div key={group.label} className="mt-3 first:mt-0">
          <div className="grid grid-cols-2 gap-0.5 md:grid-cols-1">
            {group.tabs.map((tab) => (
              <SettingsTabButton
                key={tab.id}
                ref={(node) => {
                  tabRefs.current[tab.id] = node
                }}
                tab={tab}
                active={activeSettingsTab === tab.id}
                badge={tab.id === 'general' ? updateBadges.general : tab.id === 'agents' ? updateBadges.agents : null}
                onClick={() => selectSettingsTab(tab.id)}
                onKeyDown={(event) => onSettingsTabKeyDown(event, tabIndexById.get(tab.id) ?? 0)}
              />
            ))}
          </div>
        </div>
      ))}
    </div>
  )

  // Form tabs read in a capped measure; catalog/table tabs (tile grids, the
  // shortcuts editor) keep the full panel width. Worktrees is a form over a
  // table of five columns, which the form's measure cut to a word or two each:
  // it takes a wider one, still capped so its settings rows stay readable.
  const fullWidthTab = activeTab.id === 'shortcuts'
  const measure = fullWidthTab
    ? undefined
    : activeTab.id === 'worktrees'
      ? 'mx-auto max-w-[960px]'
      : 'mx-auto max-w-[720px]'

  const bodyContent = (
    <div className={measure}>
      {/* Built-in tabs self-title via their own section headings and the rail
          orientation, so they take no page header. Module-contributed sections
          render a third-party component with no title of its own, so the host
          supplies the section's heading (icon + label) here. */}
      {activeTab.moduleSection ? <SettingsPageHeader title={activeTab.label} /> : null}

      {activeSettingsTab === 'appearance' ? (
        <div
          role="tabpanel"
          id="settings-panel-appearance"
          aria-labelledby="settings-tab-appearance"
          className="space-y-5"
        >
          <SettingsPageHeader title="Appearance" />
          <AppThemePicker value={appearanceTheme} onChange={setAppearanceTheme} />
          <SystemThemeRows />
          {/* How the chat rail lists conversations (all-chats-view). It lives
              here rather than over the list itself (owner, 2026-09-07): it is
              how this person reads their work — set once, lived with — and the
              rail's one control at the top is New chat.

              Appearance and not General: it changes the shape of a list, not
              what the app does — the same question as the theme and the window
              material it sits under. */}
          {/* One card, not a rule between each row: these were two one-row
              groups divided by top borders, which spent two rules to say what
              one card's edge says. */}
          <section className="space-y-3">
            <SettingsSectionTitle>Interface</SettingsSectionTitle>
            <SettingCard>
              <SettingsRow
                label="Chat list"
                help="Group chats under their project, or list them all together, most recently messaged first."
              >
                <SegmentedControl<'projects' | 'all'>
                  ariaLabel="Chat list"
                  items={[
                    { value: 'projects', label: 'By project' },
                    { value: 'all', label: 'All chats' },
                  ]}
                  value={chatListView}
                  onChange={setChatListView}
                />
              </SettingsRow>
              {/* The one way a row moves on its own (owner ruling 2026-09-09
                  keeps them still), so it is the person's to turn on. */}
              <SettingToggle
                label="Working section"
                description="While an agent works in a chat, fold it into a Working section at the top of the list, and put it back when the agent finishes or needs you. Starred chats and the chat you are in stay where they are."
                enabled={sidebarWorkingSection}
                onChange={setSidebarWorkingSection}
              />
              <ChatAppearanceRows />
              {/* Where a file opens (owner ruling 2026-09-25). The editor
                  window is the default: the file on its own, with a tree
                  beside it that says where it lives. The in-app tab stays a
                  choice, and this row is the only thing that changes it. */}
              <SettingsRow
                label="Open files in"
                help="The editor window shows the file on its own, beside a file tree. In the app opens it as a tab next to your terminals."
              >
                <SegmentedControl<'window' | 'app'>
                  ariaLabel="Open files in"
                  items={[
                    { value: 'window', label: 'Editor window' },
                    { value: 'app', label: 'In the app' },
                  ]}
                  value={openFilesInExternalWindow ? 'window' : 'app'}
                  onChange={(value) => setOpenFilesInExternalWindow(value === 'window')}
                />
              </SettingsRow>
              <SettingsRow
                label="Window material"
                help={
                  isMac
                    ? 'Glass frosts the sidebar and title bar. Tinted gives them a faint wash of colour.'
                    : 'Tinted gives the sidebar and title bar a faint wash of colour.'
                }
              >
                {/* A value choice, so the kit's segmented control: one tab stop,
                    arrow keys, and a neutral selected segment — not an
                    aria-pressed pair painted with the accent. Glass needs the
                    OS's vibrancy, so it is offered on macOS only, and the value
                    shown is the material the window actually wears (a stored
                    glass reads as tinted elsewhere). */}
                <SegmentedControl<WindowMaterial>
                  ariaLabel="Window material"
                  items={[
                    ...(isMac ? [{ value: 'glass' as const, label: 'Glass' }] : []),
                    { value: 'tinted', label: 'Tinted' },
                    { value: 'solid', label: 'Solid' },
                  ]}
                  value={effectiveWindowMaterial(appearanceWindowMaterial, window.api.platform)}
                  onChange={setAppearanceWindowMaterial}
                />
              </SettingsRow>
              <SettingToggle
                label="Agent characters"
                description="Draw each agent Claude sends off as a little character that moves while it works, and changes with the seasons."
                enabled={agentCharacters}
                onChange={setAppearanceAgentCharacters}
              />
              <SettingToggle
                label="Show subscription usage limits"
                description="A small bar on a Claude or Codex chat's composer for how much of your plan's five-hour and weekly limits you have used, read from what the agent reports. Never shown for an API key."
                enabled={usageLimits}
                onChange={setAppearanceUsageLimits}
              />
            </SettingCard>
          </section>
          <section className="space-y-3">
            <SettingsSectionTitle>Fonts</SettingsSectionTitle>
            <SettingCard>
              <FontAppearanceRows />
            </SettingCard>
          </section>
        </div>
      ) : null}

      {activeSettingsTab === 'profile' ? (
        <div role="tabpanel" id="settings-panel-profile" aria-labelledby="settings-tab-profile">
          <SettingsPageHeader title="Profile" />
          <ProfileSection
            authState={authState}
            message={profileMessage}
            pending={profilePending}
            onSignIn={() => void onProfileSignIn()}
            onSignOut={() => void onProfileSignOut()}
            onRefresh={() => void onProfileRefresh()}
          />
        </div>
      ) : null}

      {activeSettingsTab === 'general' ? (
        <div role="tabpanel" id="settings-panel-general" aria-labelledby="settings-tab-general">
          <SettingsPageHeader title="General" />
          {/* The version row: identity on the left, the one state-driven action
              on the right — check, then Download, then Restart to update —
              with the download's progress under it (AppVersionRow). */}
          <AppVersionRow
            state={updateState}
            pending={updateActionPending}
            onCheck={() => void checkForUpdates()}
            onDownload={() => void downloadUpdate()}
            onRestart={() => void restartToInstall()}
            onOpenReleaseNotes={() => void window.api.updateOpenReleaseNotes()}
          />

          <SettingCard className="mt-5">
            <UpdateChannelSettings onResult={onUpdateChannelResult} />
            {updateState ? (
              <SettingToggle
                label="Download updates automatically"
                description="Off: Studio says when an update is out, and downloads it when you press Download."
                enabled={updateState.autoDownload}
                onChange={(enabled) => void setAutoDownload(enabled)}
              />
            ) : null}
            {backgroundModeDescriptor ? (
              <RegistrySwitchRow
                descriptor={backgroundModeDescriptor}
                checked={keepRunningInBackground}
                onChange={(enabled) => setKeepRunningInBackground(enabled)}
              />
            ) : null}
            <QuitConfirmationSetting />
            <AgentNotificationsSetting />
            <KeepAwakeSetting />
            {telemetryDescriptor ? (
              <RegistrySwitchRow
                descriptor={telemetryDescriptor}
                checked={telemetryEnabled}
                onChange={(enabled) => setTelemetryEnabled(enabled)}
              />
            ) : null}
          </SettingCard>
        </div>
      ) : null}

      {activeSettingsTab === 'github' ? (
        <div role="tabpanel" id="settings-panel-github" aria-labelledby="settings-tab-github">
          <VersionControlSections
            githubToken={
              <div className="space-y-2">
                <SettingsRow
                  label="Access token"
                  // No caption: the row above already names the provider and its
                  // state, and what a GitHub token is needs no explaining. The
                  // one line that survives is a consequence the screen cannot
                  // show — that without secure storage the token does not
                  // outlive the session — and it appears only when true.
                  help={
                    githubTokenStatus && !githubTokenStatus.encryptionAvailable
                      ? 'Secure storage is unavailable, so this is kept for the current session only.'
                      : undefined
                  }
                  htmlFor={githubTokenInputVisible ? 'github-token-input' : undefined}
                >
                  {githubTokenInputVisible ? (
                    <>
                      <Input
                        id="github-token-input"
                        type="password"
                        value={githubTokenDraft}
                        onChange={(event) => setGithubTokenDraft(event.target.value)}
                        placeholder="Fine-grained GitHub token"
                        autoComplete="off"
                        size="md"
                        variant="well"
                        fullWidth={false}
                        className={ROW_FIELD}
                      />
                      {/* Cancel before Save — the shared order every other
                          dialog and editor in the app uses (`Modal.Footer`,
                          `ConfirmDialog`). This row was
                          the one place that flipped it, so the confirming
                          button moved under the pointer depending on which
                          surface you were on. */}
                      {githubTokenStatus?.configured ? (
                        <GhostButton
                          size="md"
                          onClick={() => {
                            setGithubTokenEditing(false)
                            setGithubTokenDraft('')
                          }}
                        >
                          Cancel
                        </GhostButton>
                      ) : null}
                      <PrimaryButton
                        size="md"
                        onClick={() => void saveGitHubToken()}
                        disabled={githubTokenPending || !githubTokenDraft.trim()}
                      >
                        Save
                      </PrimaryButton>
                    </>
                  ) : (
                    <>
                      <span className="text-body font-medium text-[color:var(--text-default)]">
                        {formatGitHubTokenStatus(githubTokenStatus)}
                      </span>
                      <OutlineButton
                        size="md"
                        onClick={() => setGithubTokenEditing(true)}
                        disabled={githubTokenStatus === null}
                      >
                        Replace
                      </OutlineButton>
                      <OutlineButton
                        size="md"
                        onClick={() => void clearGitHubToken()}
                        disabled={githubTokenPending || githubTokenStatus?.source !== 'settings'}
                      >
                        Clear
                      </OutlineButton>
                    </>
                  )}
                </SettingsRow>

                {githubTokenMessage ? (
                  <p role="status" className="text-body leading-5 text-[color:var(--text-muted)]">
                    {githubTokenMessage}
                  </p>
                ) : null}

                {/* The cadence, said where the token that used to decide it
                    lives. On the API fallback, without a token,
                    GitHub allows 60 requests an hour for the whole machine, so
                    plugin sources are checked once a day rather than hourly.
                    Over git the check is a `ls-remote` the limit does not
                    count, so it is hourly whatever this field says (owner
                    ruling, 2026-09-08) — a person who finds updates slow to
                    appear should read why here, not guess. */}
                {skillRepoTransport ? (
                  <p className="text-meta leading-4 text-[color:var(--text-subtle)]">
                    {sourceUpdateCadenceLine(githubTokenStatus?.configured === true, skillRepoTransport)}
                  </p>
                ) : null}
              </div>
            }
          />
        </div>
      ) : null}

      {activeSettingsTab === 'trackers' ? <TicketTrackersTab /> : null}

      {activeSettingsTab === 'agents' ? (
        <div role="tabpanel" id="settings-panel-agents" aria-labelledby="settings-tab-agents" className="space-y-3">
          <AgentCliBand
            checkedAt={agentsOnWsl ? (agentsMachineCli.availability?.checkedAt ?? null) : cliAvailabilityCheckedAt}
            rechecking={agentsRechecking}
            onRecheck={() => void recheckAgentClis()}
          />
          <AgentsMachineSwitcher
            machines={agentsMachineOptions}
            value={agentsMachine.id}
            onChange={selectAgentsMachine}
            badges={updateBadges.machines}
          />
          {/* One switch for every machine: main compares each machine's
              installed CLIs against the registry, and this turns all of it
              off. */}
          <SettingCard>
            <SettingToggle
              label="Check for CLI updates"
              description="Offers Update when a newer version is published."
              enabled={checkCliVersions}
              onChange={setCheckCliVersions}
            />
          </SettingCard>
          {/* First-run agent-config adoption. It runs silently at the first
              workspace creation — the user is never asked — so this line is the
              only place it is ever reported. Renders nothing unless an adoption
              actually ran this session, and says so plainly when it failed. */}
          <AgentConfigAdoptionStatus adoption={agentConfigAdoptionResult} />
          <ConversationImportSettings />
          {/* A chat a usage limit stopped, carried on when the limit resets. */}
          <UsageLimitResumeSettings />
          {/* What Enter does while a chat's agent works: queue, or steer. */}
          <FollowUpBehaviorSetting />
          {/* Every outdated CLI on every machine here, in one press. */}
          <UpdateEverythingCard />
          <AgentClisSection
            runs={agentCliRuns}
            machine={agentsMachine}
            machineAvailability={agentsMachineCli.availability}
            onMachineReload={agentsMachineCli.reload}
            showMachine={agentsMachineOptions.length > 1}
            updateBadgeClis={updateBadges.clis[agentsMachine.id] ?? NO_UPDATE_BADGE_CLIS}
          />
          {/* A WSL machine's own `gh`, beside its agent CLIs: its chats open
              pull requests with it. This machine's is under Version control. */}
          {agentsOnWsl ? (
            <WslGhSection hostId={agentsMachine.id} label={agentsMachine.label} recheck={agentsGhRecheck} />
          ) : null}

          <StudioSkillsSettings />
          <TextGenerationSettingsSection />
          <ConversationApprovalSettings />
          <AgentBrowserSettings />

          {idleSuspendDescriptor ? (
            // No top rule on the section: the card draws its own edge, and a
            // section rule above it doubled the boundary.
            <section className="space-y-3 pt-2">
              <SettingsSectionTitle>Memory</SettingsSectionTitle>
              <SettingCard>
                <IdleSuspendField descriptor={idleSuspendDescriptor} />
                {keepRecentAliveDescriptor ? <KeepRecentAliveField descriptor={keepRecentAliveDescriptor} /> : null}
              </SettingCard>
            </section>
          ) : null}
          {/* The MCP gateway every Studio-launched agent receives. It was a rail
              row of the Plugins door until the source-tabs ruling (2026-09-05):
              a catalogue is a list of things you can add, and this is a
              read-only diagnostic about a service that is always on — so it
              belongs beside the agents it serves rather than in a shelf of
              things to install. There is no Automations settings tab to put it
              in; if one is ever added, this is the section that moves. */}
          <AutomationServerSettings />
          {/* The applications paired with Studio's owner socket sit beside
              the gateway: both are doors onto this machine's agents. */}
          {clientSupports('tailnet-admin') ? <LocalAppsSettings /> : null}
          {/* Where the server behind both of them runs (phase 6): inside the
              app, or in a process of its own. */}
          <StudioServerSettings />
        </div>
      ) : null}

      {activeSettingsTab === 'providers' ? <ProviderSettingsTab /> : null}
      {activeSettingsTab === 'machines' ? (
        <MachinesSettingsTab
          onShowAgentClis={(id) => {
            selectAgentsMachine(id)
            setActiveSettingsTab('agents')
            window.requestAnimationFrame(() => tabRefs.current.agents?.focus())
          }}
        />
      ) : null}

      {activeSettingsTab === 'knowledge-graph' ? (
        <div
          role="tabpanel"
          id="settings-panel-knowledge-graph"
          aria-labelledby="settings-tab-knowledge-graph"
          className="space-y-4"
        >
          <SettingsPageHeader
            title="Knowledge graph"
            meta={
              activeProjectRoot ? (
                <span className="inline-block max-w-[260px] truncate align-bottom font-mono" title={activeProjectRoot}>
                  {basename(activeProjectRoot)}
                </span>
              ) : undefined
            }
          />

          <ProjectKnowledgeList activeProjectRoot={activeProjectRoot} />

          {/* No top rule: the card draws its own edge. */}
          <div className="pt-2">
            <SettingCard>
              <SettingToggle
                label="Activity tracking"
                description="Record which knowledge files Claude Code reads."
                enabled={activityInstalled}
                disabled={activityPending || !activeProjectRoot || !activeKnowledgeConfig?.relativeRoot}
                onChange={(next) => void toggleActivityTracking(next)}
              />
            </SettingCard>
            {activityMessage ? (
              <div className="mt-2">
                <InlineNotice tone="warn">{activityMessage}</InlineNotice>
              </div>
            ) : null}
          </div>
        </div>
      ) : null}

      {activeSettingsTab === 'design-system' ? (
        <div
          role="tabpanel"
          id="settings-panel-design-system"
          aria-labelledby="settings-tab-design-system"
          className="space-y-4"
        >
          <SettingsPageHeader
            title="Design system"
            meta={
              activeDesignSystemRoot ? (
                <span
                  className="inline-block max-w-[260px] truncate align-bottom font-mono"
                  title={activeDesignSystemRoot}
                >
                  {basename(activeDesignSystemRoot)}
                </span>
              ) : undefined
            }
          />

          <DesignSystemSettings workspaceRoot={activeDesignSystemRoot} />
        </div>
      ) : null}

      {activeSettingsTab === 'shortcuts' ? <KeyboardShortcutsTab /> : null}

      {activeSettingsTab === 'settled-chats' ? <SettledChatsSettingsTab onOpenChat={openSettledChat} /> : null}

      {activeSettingsTab === 'worktrees' ? <WorktreesSettingsTab onOpenChat={openSettledChat} /> : null}

      {activeSettingsTab === 'artifacts' ? <ArtifactsSettingsTab /> : null}

      {activeSettingsTab === 'modules' ? <ModulesSettingsTab /> : null}

      {activeSettingsTab === 'remote' ? (
        <>
          {/* The browsers paired with a web listener: only a web tab's server
              answers for them, and a desktop window has the tailnet's own
              Settings instead, so it does not ask a channel main never serves. */}
          {clientSupports('tailnet-admin') ? null : <BrowsersSettings />}
          {clientSupports('tailnet-admin') ? <RemoteTailnetSettingsTab /> : null}
        </>
      ) : null}

      {activeTab.moduleSection ? (
        <div
          role="tabpanel"
          id={`settings-panel-${activeTab.id}`}
          aria-labelledby={`settings-tab-${activeTab.id}`}
          className="space-y-4"
        >
          <ModuleSettingsSectionHost section={activeTab.moduleSection} />
        </div>
      ) : null}

      {chrome === 'panel' ? (
        <div className="mt-6 flex justify-end border-t border-[color:var(--border-subtle)] pt-4">
          <GhostButton size="md" onClick={onClose}>
            Done
          </GhostButton>
        </div>
      ) : null}
    </div>
  )

  if (chrome === 'door') {
    // The door owns the bar (its name rides the app strip) and the rail column;
    // this contributes the categories and the body, and nothing else. No Close
    // control of its own: leaving is the bar's back chevron, Escape, or opening
    // any other door — the one way out every door already has.
    return (
      <GlobalSurfaceShell
        ariaLabel="Settings"
        bar={{ title: 'Settings' }}
        rail={sidebarNode}
        onBack={doorBack.onBack}
        canGoBack={doorBack.canGoBack}
      >
        <div className="h-full min-h-0 overflow-y-auto px-5 py-4 [scrollbar-gutter:stable]">{bodyContent}</div>
      </GlobalSurfaceShell>
    )
  }

  if (chrome === 'overlay') {
    // The modal-host layout (doors→modals, 2026-09-01): the SAME shell anatomy
    // the door branch above renders — one 36px title bar, the categories in
    // the shell's raised-ground rail, the body beside it — so Settings inside
    // the Modal reads identically to Plugins/Automations/Design. The host's
    // ModalSurfaceChromeContext puts the closing X in the bar; the shell
    // suppresses the chevron there, so no onBack is passed.
    return (
      <GlobalSurfaceShell ariaLabel="Settings" bar={{ title: 'Settings' }} rail={sidebarNode}>
        <div className="h-full min-h-0 overflow-y-auto px-5 py-4 [scrollbar-gutter:stable]">{bodyContent}</div>
      </GlobalSurfaceShell>
    )
  }

  return (
    <WorkspacePanel
      title="Settings"
      titleId="settings-panel-title"
      onClose={onClose}
      closeLabel="Close settings"
      sidebar={sidebarNode}
    >
      {bodyContent}
    </WorkspacePanel>
  )
}

// Profile tab body: a fuller account-management surface over the shared auth
// projection. Drives the same auth IPC as the sidebar account popover; the two
// coexist (quick glance vs. full management).
function ProfileSection({
  authState,
  message,
  pending,
  onSignIn,
  onSignOut,
  onRefresh,
}: {
  authState: SprintEngineAuthState
  message: string | null
  pending: boolean
  onSignIn: () => void
  onSignOut: () => void
  onRefresh: () => void
}) {
  if (!authState.authenticated) {
    return (
      <div className="space-y-2">
        <SettingsRow label="Not signed in" help="Signing in is optional. Every feature works without an account.">
          <PrimaryButton size="md" onClick={onSignIn} disabled={pending || authState.status === 'checking'}>
            Sign in
          </PrimaryButton>
        </SettingsRow>
        {message ? <p className="text-body leading-5 text-[color:var(--text-muted)]">{message}</p> : null}
      </div>
    )
  }

  const name = authState.user?.displayName ?? authState.user?.email ?? 'Your account'
  const email = authState.user?.displayName ? authState.user?.email : null
  const orgName = authState.selectedOrganization?.name ?? null

  return (
    <div className="space-y-5">
      <div className="flex items-center gap-3">
        <AccountAvatar
          user={authState.user}
          className="h-11 w-11 border-[color:var(--border-default)] bg-[color:var(--bg-surface)] text-title text-[color:var(--text-strong)]"
          glyphClassName="icon-lg"
        />
        <div className="min-w-0">
          <div className="truncate text-body font-medium text-[color:var(--text-strong)]">{name}</div>
          {email ? <div className="truncate text-body text-[color:var(--text-muted)]">{email}</div> : null}
        </div>
      </div>

      {orgName ? (
        <div className="grid gap-x-6 gap-y-3 border-t border-[color:var(--border-subtle)] pt-4 text-body sm:grid-cols-2">
          <MetaCell label="Organization" value={orgName} />
        </div>
      ) : null}

      {message ? <p className="text-body leading-5 text-[color:var(--text-muted)]">{message}</p> : null}

      <div className="flex flex-wrap items-center gap-3 border-t border-[color:var(--border-subtle)] pt-4">
        <OutlineButton size="md" onClick={onRefresh} disabled={pending}>
          Refresh account
        </OutlineButton>
        <GhostButton size="md" onClick={onSignOut} disabled={pending} className="ml-auto">
          Sign out
        </GhostButton>
      </div>
    </div>
  )
}

// Single-line rail item — a leading glyph + label, no subtitle. The rail
// orients; tab bodies carry their own section headings. Built-in tabs pass an
// `icon`; module sections fall back to their contributed `moduleSection.icon`.
const SettingsTabButton = React.forwardRef<
  HTMLButtonElement,
  {
    tab: SettingsTabDescriptor
    active: boolean
    /** An update waiting on this tab (owner ruling 2026-09-25): General's app
     *  update, Agents' CLI updates. Null or 0 draws nothing. */
    badge?: SettingsUpdateBadge | null
    onClick: () => void
    onKeyDown: (event: React.KeyboardEvent<HTMLButtonElement>) => void
  }
>(function SettingsTabButton({ tab, active, badge, onClick, onKeyDown }, ref) {
  const Icon = tab.icon ?? tab.moduleSection?.icon
  const shownBadge = badge && badge.count > 0 ? badge : null
  return (
    <RowButton
      ref={ref}
      // `nav`: the rail's navigation rhythm — a `size.control.sm` floor so a
      // one-line door row matches the controls above it.
      density="nav"
      selected={active}
      role="tab"
      id={`settings-tab-${tab.id}`}
      aria-selected={active}
      // The row's own `selected` would also emit `aria-current`; a tab states
      // its state as `aria-selected`, and two would be announced twice.
      aria-current={undefined}
      aria-controls={`settings-panel-${tab.id}`}
      // A badged tab names itself, the way a badged tab in the strip does: the
      // count is a named live region, and inside the button it would land in
      // the name-from-contents as well. The explicit name says it once.
      aria-label={shownBadge ? `${tab.label}, ${shownBadge.detail}` : undefined}
      tabIndex={active ? 0 : -1}
      onClick={onClick}
      onKeyDown={onKeyDown}
      className="text-body leading-5"
    >
      {Icon ? (
        <Icon
          className={`icon-sm shrink-0 ${active ? 'text-[color:var(--text-strong)]' : 'text-[color:var(--text-subtle)]'}`}
        />
      ) : null}
      <span className="min-w-0 truncate">{tab.label}</span>
      {shownBadge ? (
        // Trailing the label, as an Extensions drawer row wears its count.
        <span className="ml-auto flex shrink-0 pl-1">
          <Badge tone={shownBadge.tone} count={shownBadge.count} max={99} ariaLabel={shownBadge.detail} />
        </span>
      ) : null}
    </RowButton>
  )
})

function formatGitHubTokenStatus(status: GitHubTokenUiStatus | null): string {
  if (!status) return 'Checking'
  if (status.source === 'settings') return 'Saved'
  if (status.source === 'environment') return 'Environment'
  return 'Not set'
}
