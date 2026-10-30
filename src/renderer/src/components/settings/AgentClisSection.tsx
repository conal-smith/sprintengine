import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react'

import type { DiscoveredCliModelCatalog } from '../../../../shared/cli-model-catalog'
import { useAnsiPlainText } from '../../hooks/useAnsiPlainText'
import type { AgentCliAvailabilityMap } from '../../../../shared/electron-api'
import {
  emptyExecutionHostSettings,
  isWslHostId,
  LOCAL_HOST_ID,
  type ExecutionHostId,
  type ExecutionHostSettings,
} from '../../../../shared/execution-host'
import { useWorkspaceStore } from '../../store/workspaceStore'
import CliIcon from '../CliIcon'
import {
  Badge,
  CliProviderStateLine,
  EmptyState,
  GhostButton,
  InlineNotice,
  Input,
  LoadingOverlay,
  OutlineButton,
  PrimaryButton,
  ProviderRow,
  resolveCliProviderState,
  SegmentedControl,
  Spinner,
} from '../ui'
import {
  cliRuntimeForPlugin,
  cliRuntimeOnMachine,
  orderInstalledPlugins,
} from '../workspace/newWorkspace/cliRuntimeOptions'
import { orderInstalledFirst, type AgentsMachine, type MachineCliAvailability } from './agentsMachine'
import { CliInstallControl } from './CliInstallControl'
import { modelDiscoveryLine } from './modelDiscoveryLine'
import { SettingCard, SettingsRow, SettingsSectionTitle } from './SettingsAtoms'
import type { SettingsUpdateBadge } from '../../utils/settingsUpdateBadges'
import { isImeKey } from '../../utils/imeKey'
import { useRelativeNowFor } from '../../hooks/useRelativeNow'

// The bare shell runtime is the machine's own `sh`, not a CLI this app
// installs or updates. Asked `--version`, bash answers with its whole banner
// ("GNU bash, version 3.2.57(1)-release (arm64-apple-…") and other shells
// with whatever they print, so its row names the binary and leaves the
// version slot empty rather than showing a sentence in it.
const BARE_SHELL_CLI = 'generic-shell'

// Row inputs hold an identifier (a command, a model id, a key), so they are
// mono; sized to the standard 240px row measure rather than stretched to the
// panel. `fullWidth={false}` goes with it because Tailwind resolves two width
// utilities by stylesheet order, not string order.
const MONO_FIELD = 'font-mono'
const ROW_FIELD = 'w-60 max-w-full font-mono'
const EMPTY_USER_MODELS: string[] = []
const NO_AVAILABILITY: AgentCliAvailabilityMap = {}

const MACHINE_HELP_ID = 'settings-agents-machine-help'

/**
 * The machine switcher at the top of Settings ▸ Agents: the same segmented
 * control as General's update channel, because it is the same kind of choice —
 * one of a few named options, all worth seeing at once (owner ruling
 * 2026-09-24). Nothing at all with one machine, so macOS, Linux and a Windows
 * PC with no distribution turned on draw the tab exactly as before. Past two
 * machines the labels outgrow the row, so the control drops under its label
 * rather than squeezing it.
 */
export function AgentsMachineSwitcher({
  machines,
  value,
  onChange,
  badges,
}: {
  machines: readonly AgentsMachine[]
  value: ExecutionHostId
  onChange: (id: ExecutionHostId) => void
  /**
   * The CLI updates waiting on each machine (owner ruling 2026-09-25), worn on
   * that machine's segment only: main checks each WSL distribution's installed
   * CLIs against the registry as it does this machine's.
   */
  badges?: Readonly<Partial<Record<ExecutionHostId, SettingsUpdateBadge>>>
}): React.JSX.Element | null {
  if (machines.length < 2) return null
  return (
    <SettingCard>
      <SettingsRow
        label="Machine"
        help="Whose agent CLIs are listed below."
        helpId={MACHINE_HELP_ID}
        stacked={machines.length > 2}
      >
        <SegmentedControl<ExecutionHostId>
          ariaLabel="Machine"
          ariaDescribedBy={MACHINE_HELP_ID}
          items={machines.map((machine) => {
            const badge = badges?.[machine.id]
            return {
              value: machine.id,
              label: machine.label,
              badge: badge ? { count: badge.count, tone: badge.tone, label: badge.detail } : null,
            }
          })}
          value={value}
          onChange={onChange}
        />
      </SettingsRow>
    </SettingCard>
  )
}

type OpenCliRow = { machineId: string; cliId: string; install: boolean }
// `log` is what the update command has printed so far: shown while it runs, so
// a slow updater is visibly doing something, and kept when it fails, because
// what it printed last is the reason.
type CliUpdateRun = { running: boolean; notice: { tone: 'warn' | 'error'; text: string } | null; log: string }

/** Where one CLI's Update on one machine keeps its progress in `cliUpdateRuns`. */
export function cliUpdateRunKey(hostId: ExecutionHostId, cli: string): string {
  return hostId === LOCAL_HOST_ID ? cli : `${hostId}|${cli}`
}

export type CliUpdateRequest = {
  cli: AgentCli
  hostId: ExecutionHostId
  /** The version the machine's list shows now, to tell an update that did nothing. */
  before: string | null
  /** Reads the machine's list again once main has recorded the new version. */
  onSettled?: () => void
}

export type AgentCliRuns = {
  modelRefresh: { running: boolean; errors: Record<string, string> }
  refreshCliModels: () => Promise<void>
  cliUpdateRuns: Record<string, CliUpdateRun>
  runCliUpdate: (request: CliUpdateRequest) => Promise<void>
  open: OpenCliRow | null
  setOpen: (open: OpenCliRow | null) => void
}

/**
 * The Agents list's work in progress — a model refresh, each Update, the open
 * row. Called by the panel rather than the list, because the list unmounts with
 * its tab, and an Update still running must not come back with its button
 * enabled, able to start a second one beside it.
 */
export function useAgentCliRuns(): AgentCliRuns {
  const cliRuntimes = useWorkspaceStore((s) => s.appSettings.cliRuntimes)
  const hosts = useWorkspaceStore((s) => s.appSettings.hosts)
  const pluginCatalogEntries = useWorkspaceStore((s) => s.pluginCatalogEntries)
  const refreshCliAvailability = useWorkspaceStore((s) => s.refreshCliAvailability)
  const refreshCliVersionAdvisories = useWorkspaceStore((s) => s.refreshCliVersionAdvisories)
  const setCliModelCatalog = useWorkspaceStore((s) => s.setCliModelCatalog)

  // The last Refresh: whether one is running, and why each CLI's probe failed.
  // A failed probe keeps the last good list (the answer carries no catalog for
  // it), so only the line changes.
  const [modelRefresh, setModelRefresh] = useState<{ running: boolean; errors: Record<string, string> }>({
    running: false,
    errors: {},
  })
  const refreshCliModels = useCallback(async () => {
    const api = typeof window === 'undefined' ? null : window.api
    if (typeof api?.cliModelsDiscover !== 'function') return
    setModelRefresh((current) => ({ ...current, running: true }))
    try {
      const result = await api.cliModelsDiscover({
        force: true,
        cliRuntimes,
        previous: useWorkspaceStore.getState().appSettings.cliModelCatalog,
      })
      const errors: Record<string, string> = {}
      for (const entry of result.entries) {
        if (entry.catalog) setCliModelCatalog(entry.cli, entry.catalog)
        if (entry.error) errors[entry.cli] = entry.error
      }
      setModelRefresh({ running: false, errors })
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      const errors: Record<string, string> = {}
      for (const plugin of pluginCatalogEntries) errors[plugin.id] = message
      setModelRefresh({ running: false, errors })
    }
  }, [cliRuntimes, pluginCatalogEntries, setCliModelCatalog])

  // Per-CLI, per-machine Update runs (the version advisory's button).
  // `running` while the command is in flight; afterwards the notice says what
  // happened when the version did not move or the command failed. A clean
  // success needs no notice: the row's version changes and the advisory goes
  // away.
  const [cliUpdateRuns, setCliUpdateRuns] = useState<Record<string, CliUpdateRun>>({})
  const runCliUpdate = useCallback(
    async ({ cli, hostId, before, onSettled }: CliUpdateRequest) => {
      const api = window.api
      if (typeof api.cliUpdate !== 'function') return
      const runtime = cliRuntimeOnMachine(cli, hostId, { cliRuntimes, hosts })
      const key = cliUpdateRunKey(hostId, cli)
      setCliUpdateRuns((prev) => ({ ...prev, [key]: { running: true, notice: null, log: '' } }))
      // Updates stream on the channel installs use, one per CLI per machine,
      // so the same CLI updating on two machines at once keeps two logs.
      const unsubscribe =
        typeof api.onCliInstallOutput === 'function'
          ? api.onCliInstallOutput(
              cli,
              (chunk) =>
                setCliUpdateRuns((prev) => {
                  const run = prev[key]
                  return run?.running ? { ...prev, [key]: { ...run, log: run.log + chunk } } : prev
                }),
              hostId,
            )
          : () => undefined
      let notice: { tone: 'warn' | 'error'; text: string } | null = null
      try {
        const result = await api.cliUpdate(cli, runtime)
        if (!result.ok) {
          notice = { tone: 'error', text: result.error ?? 'The update did not finish.' }
        } else if (result.version && before && result.version.trim() === before.trim()) {
          notice = {
            tone: 'warn',
            text: `The update finished but the version is still ${before}. Run it in a terminal to see why.`,
          }
        }
      } catch (error) {
        notice = { tone: 'error', text: error instanceof Error ? error.message : String(error) }
      } finally {
        unsubscribe()
      }
      setCliUpdateRuns((prev) => ({ ...prev, [key]: { running: false, notice, log: prev[key]?.log ?? '' } }))
      // Main detected this CLI again on this machine when the update finished
      // and recorded it, so these reads pick the new version up without a
      // re-scan of every CLI.
      if (hostId === LOCAL_HOST_ID) await refreshCliAvailability({ cliRuntimes })
      onSettled?.()
      void refreshCliVersionAdvisories()
    },
    [cliRuntimes, hosts, refreshCliAvailability, refreshCliVersionAdvisories],
  )

  // The CLI row whose detail is open, and whether its Install button opened it
  // (its detail then opens straight into the install flow). It belongs to the
  // machine it was opened on, compared as the list renders: another machine's
  // list never mounts that row open, not even for the one commit an effect
  // would take to close it — its install control would already have probed
  // the new machine by then.
  const [open, setOpen] = useState<OpenCliRow | null>(null)

  return { modelRefresh, refreshCliModels, cliUpdateRuns, runCliUpdate, open, setOpen }
}

/**
 * Settings ▸ Agents' list of agent CLIs, for one machine.
 *
 * This machine's list is the one it always was: the store's availability, its
 * version advisories and Update, the command on `cliRuntimes`, and the
 * CLI-wide settings (model list, custom model ids, API key). A WSL machine's
 * list is that machine's own: its probe, its command overrides
 * (`hosts[id].cliCommands`), and install bound to it — the controls that sat
 * under each distribution on the Machines tab until 2026-09-24. The CLI-wide
 * settings are not repeated under it: they are not the machine's, and drawing
 * them there would say they were.
 */
export function AgentClisSection({
  machine,
  machineAvailability,
  onMachineReload,
  showMachine,
  runs,
  updateBadgeClis,
}: {
  machine: AgentsMachine
  /** Held by the panel, so a running Update or model refresh, and the open row, outlive a visit to another tab. */
  runs: AgentCliRuns
  /** The WSL machine's probe; null for this machine, whose answer is the store's. */
  machineAvailability: MachineCliAvailability | null
  /** Reads the WSL machine's list again, after main recorded a change to it. */
  onMachineReload: () => void
  /** A switcher is on screen, so a state line names the machine it found the CLI on. */
  showMachine: boolean
  /**
   * The CLIs on this machine whose update is still news — not installed, not
   * dismissed — and so wear a count beside their Update button
   * (useSettingsUpdateBadges). A CLI whose update was dismissed keeps its
   * Update; only the badge goes.
   */
  updateBadgeClis: ReadonlySet<string>
}): React.JSX.Element {
  const wsl = isWslHostId(machine.id) ? machine.id : null
  const cliRuntimes = useWorkspaceStore((s) => s.appSettings.cliRuntimes)
  const cliModelCatalog = useWorkspaceStore((s) => s.appSettings.cliModelCatalog)
  const hostSettings = useWorkspaceStore((s) => (wsl ? s.appSettings.hosts?.[wsl] : undefined))
  const setHostSettings = useWorkspaceStore((s) => s.setHostSettings)
  const pluginCatalogEntries = useWorkspaceStore((s) => s.pluginCatalogEntries)
  const pluginCatalogStatus = useWorkspaceStore((s) => s.pluginCatalogStatus)
  const pluginCatalogError = useWorkspaceStore((s) => s.pluginCatalogError)
  const refreshPluginCatalog = useWorkspaceStore((s) => s.refreshPluginCatalog)
  const refreshCliAvailability = useWorkspaceStore((s) => s.refreshCliAvailability)
  // Detection map shared with the deployment pickers — drives the at-a-glance
  // status on every CLI row without a per-row probe.
  const localAvailability = useWorkspaceStore((s) => s.cliAvailability)
  const localAvailabilityStatus = useWorkspaceStore((s) => s.cliAvailabilityStatus)
  const localAvailabilityError = useWorkspaceStore((s) => s.cliAvailabilityError)
  // Installed version against the registry's newest, per CLI, for the machine
  // shown. Main compares hourly, on Re-check and after an update it ran.
  const cliVersionAdvisories = useWorkspaceStore((s) => s.cliVersionAdvisories[machine.id])
  const checkCliVersions = useWorkspaceStore((s) => s.checkCliVersions)
  const setCliRuntime = useWorkspaceStore((s) => s.setCliRuntime)
  const forgetCliModels = useWorkspaceStore((s) => s.forgetCliModels)
  const installedPluginRows = useMemo(() => orderInstalledPlugins(pluginCatalogEntries), [pluginCatalogEntries])

  const cliAvailability = wsl ? (machineAvailability?.map ?? NO_AVAILABILITY) : localAvailability
  const cliAvailabilityStatus = wsl ? (machineAvailability?.status ?? 'loading') : localAvailabilityStatus
  const cliAvailabilityError = wsl ? (machineAvailability?.error ?? null) : localAvailabilityError
  const ownSettings: ExecutionHostSettings = hostSettings ?? emptyExecutionHostSettings()
  const writeHostCommands = (cliCommands: Record<string, string>): void => {
    if (wsl) setHostSettings(wsl, { ...ownSettings, cliCommands })
  }

  const { modelRefresh, refreshCliModels, cliUpdateRuns, runCliUpdate } = runs
  const selectedCliId = runs.open?.machineId === machine.id ? runs.open.cliId : null
  const installIntentId = selectedCliId !== null && runs.open?.install ? selectedCliId : null
  const openRow = (cliId: string | null, install = false): void =>
    runs.setOpen(cliId ? { machineId: machine.id, cliId, install } : null)

  // Installed first, then what this machine does not have — dimmed below it.
  // The order is taken again only while no row is open: a row the person is
  // working in (typing an override, installing) must not move under them when
  // a probe of the half-typed command answers "missing", or when the install
  // it is running succeeds.
  const heldOrder = useRef<{ machineId: string; ids: string[] } | null>(null)
  const rows = useMemo(() => {
    const fresh = orderInstalledFirst(
      installedPluginRows.map((plugin) => ({
        plugin,
        state: resolveCliProviderState(cliAvailability[plugin.id], cliAvailabilityStatus),
      })),
      (row) => row.state.health === 'missing',
    )
    const held = heldOrder.current
    if (
      selectedCliId !== null &&
      held?.machineId === machine.id &&
      held.ids.length === fresh.length &&
      fresh.every((row) => held.ids.includes(row.plugin.id))
    ) {
      return held.ids.map((id) => fresh.find((row) => row.plugin.id === id)!)
    }
    heldOrder.current = { machineId: machine.id, ids: fresh.map((row) => row.plugin.id) }
    return fresh
  }, [installedPluginRows, cliAvailability, cliAvailabilityStatus, selectedCliId, machine.id])

  return (
    <>
      {/* The batch availability probe failing is a different fact from a
          plugin registry failure, and until now it was surfaced nowhere at
          all: every row simply read "Not found". */}
      {cliAvailabilityStatus === 'error' && cliAvailabilityError ? (
        <InlineNotice tone="warn">
          {`Agent CLIs could not be checked${showMachine ? ` on ${machine.label}` : ''}: ${cliAvailabilityError}`}
        </InlineNotice>
      ) : null}

      {pluginCatalogStatus === 'loading' && installedPluginRows.length === 0 ? (
        <LoadingOverlay label="Loading agent CLIs…" className="py-8" />
      ) : pluginCatalogStatus === 'error' ? (
        // The failure carries its own recovery, per the notice contract —
        // a Retry parked below the message is a dead end with a button.
        <InlineNotice
          tone="error"
          title="The plugin registry could not be loaded."
          hint={pluginCatalogError ?? undefined}
          action={
            <OutlineButton size="md" onClick={() => void refreshPluginCatalog()}>
              Retry
            </OutlineButton>
          }
        />
      ) : installedPluginRows.length === 0 ? (
        <EmptyState
          density="list"
          title="No agent plugins are installed."
          action={
            <OutlineButton size="md" onClick={() => void refreshPluginCatalog()}>
              Refresh
            </OutlineButton>
          }
        />
      ) : (
        // The list card (setting-row → The list card, 2026-09-15): the
        // section band with the count outside, one bordered surface, the
        // rows full-bleed inside it — the shape the Remote tab's machines
        // drew first.
        <section className="space-y-2">
          <SettingsSectionTitle count={installedPluginRows.length}>Agent CLIs</SettingsSectionTitle>
          <SettingCard as="ul" ariaLabel={showMachine ? `Agent CLIs on ${machine.label}` : 'Agent CLIs'}>
            {rows.map(({ plugin, state }) => {
              const localCommand = cliRuntimeForPlugin(plugin.id, cliRuntimes).command
              const command = wsl ? (ownSettings.cliCommands[plugin.id] ?? '') : localCommand
              const declaredModels = plugin.modelSelection?.options ?? []
              // What the picker offers before the user's own ids: the CLI's
              // own list once it has answered, else the manifest seed
              // (mergeCliModelCatalog in src/shared/cli-model-catalog.ts).
              const discoveredCatalog = cliModelCatalog?.[plugin.id]
              const discoveredModels = discoveredCatalog?.models ?? []
              const listedModels =
                discoveredModels.length > 0
                  ? discoveredModels.map((model) => ({ id: model.id, label: model.displayName }))
                  : declaredModels
              const allowCustomModels = Boolean(plugin.modelSelection?.allowCustomId)
              const userModels = cliRuntimes?.[plugin.id]?.models ?? EMPTY_USER_MODELS
              // The registry advisory for this CLI on the machine shown: main
              // compares the version detection found there.
              const advisory = checkCliVersions ? cliVersionAdvisories?.[plugin.id] : undefined
              const behind = state.installed && advisory?.status === 'behind_latest' && !!advisory.latestVersion
              const updateRun = cliUpdateRuns[cliUpdateRunKey(machine.id, plugin.id)]
              const commandFieldId = wsl ? `machine-cli-${wsl}-${plugin.id}` : `cli-command-${plugin.id}`
              return (
                <ProviderRow
                  key={plugin.id}
                  as="li"
                  surface="card"
                  // A CLI this machine does not have takes the muted ink on its
                  // mark as well as its name (the row recedes the opacity).
                  icon={
                    <CliIcon
                      cli={plugin.id}
                      className={`size-icon-lg ${
                        state.health === 'missing'
                          ? 'text-[color:var(--text-muted)]'
                          : 'text-[color:var(--text-default)]'
                      }`}
                    />
                  }
                  // No health dot (owner, 2026-09-10): nine identical green
                  // dots down a column is a status idiom spent on a fact
                  // nobody is scanning for. What a person is scanning for is
                  // the one row that is behind, and that row's count sits
                  // beside its Update button (owner ruling 2026-09-25) —
                  // beside the thing that answers it, rather than on the
                  // mark, so the row wears one badge and not two.
                  // A CLI this machine does not have recedes, and sits below
                  // every one it does, so the list reads as what is here
                  // first. Only a DEFINITIVE absence: a probe that never
                  // answered is not absence, and must not push a
                  // likely-installed CLI into the background.
                  recessed={state.health === 'missing'}
                  name={plugin.displayName}
                  version={plugin.id === BARE_SHELL_CLI ? null : state.version}
                  stateLine={
                    <>
                      <CliProviderStateLine
                        state={state}
                        binary={plugin.binary}
                        machineLabel={showMachine && wsl ? machine.label : null}
                        // Deliberately not the reason: a failed batch probe
                        // wipes every entry, so the reason is one fact for the
                        // whole list and the section states it once above the
                        // list rather than nine times down the rows.
                        probeError={null}
                      />
                      {/* Provenance, only where it distinguishes: a plugin
                        the user installed from a folder is the one this list
                        cannot otherwise explain. */}
                      {plugin.source === 'bundled' ? null : ' · installed from a folder'}
                      {/* The version advisory: the newest the registry
                        publishes. Nothing here for a CLI that is current or
                        unknown. */}
                      {behind ? (
                        <>
                          {' · '}
                          <span className="font-mono text-[color:var(--text-default)]">{advisory.latestVersion}</span>
                          {updateRun?.running ? ' installing…' : ' available'}
                        </>
                      ) : null}
                    </>
                  }
                  expanded={selectedCliId === plugin.id}
                  onExpandedChange={(next) => openRow(next ? plugin.id : null)}
                  // Install is offered only on a definitive negative probe. A
                  // CLI whose probe never completed may well be installed, so
                  // offering to install it would be a fake affordance — those
                  // rows say so on their state line and route to Re-check.
                  actions={
                    state.health === 'missing' ? (
                      // The outline secondary, not the primary: nine accent
                      // Installs down the bottom of the list pulled the eye to
                      // exactly the rows the list recedes (owner, 2026-09-24).
                      // The accent stays for Update, on a CLI that is here.
                      <OutlineButton size="xs" onClick={() => openRow(plugin.id, true)}>
                        Install
                      </OutlineButton>
                    ) : behind ? (
                      <span className="inline-flex items-center gap-1.5">
                        {updateBadgeClis.has(plugin.id) ? (
                          <Badge
                            tone="accent"
                            count={1}
                            ariaLabel={`${plugin.displayName} — update available: ${advisory.latestVersion}`}
                          />
                        ) : null}
                        <PrimaryButton
                          size="xs"
                          disabled={updateRun?.running === true}
                          onClick={() => {
                            // Open, so what the command prints is on screen as
                            // it runs, and a failure lands where it is seen.
                            openRow(plugin.id)
                            void runCliUpdate({
                              cli: plugin.id,
                              hostId: machine.id,
                              before: state.version ?? null,
                              ...(wsl ? { onSettled: onMachineReload } : {}),
                            })
                          }}
                        >
                          {updateRun?.running ? <Spinner className="icon-sm" /> : null}
                          Update
                        </PrimaryButton>
                      </span>
                    ) : null
                  }
                >
                  {/* The per-instance form, in place: the install/detect
                    control, then how this CLI runs. The row above already
                    carries name, version, and state, so the control drops
                    its own name and status line rather than saying it
                    twice. */}
                  {updateRun?.notice ? (
                    <InlineNotice
                      tone={updateRun.notice.tone}
                      title={`${plugin.displayName} did not update.`}
                      hint={updateRun.notice.text}
                    >
                      {advisory?.updateCommand ? (
                        <span className="font-mono text-[color:var(--text-default)]">
                          {advisory.updateCommand.command}
                        </span>
                      ) : null}
                    </InlineNotice>
                  ) : null}
                  {/* The command's own words, the same well the install log
                    uses: live while it runs, and kept after a failure. A clean
                    update needs no log; its version line already moved. */}
                  {updateRun && (updateRun.running || updateRun.notice) ? (
                    <CliUpdateLog label={`${plugin.displayName} update output`} log={updateRun.log} />
                  ) : null}
                  <CliInstallControl
                    cli={plugin.id}
                    displayName={plugin.displayName}
                    binary={plugin.binary}
                    command={command}
                    {...(wsl ? { hostId: wsl } : {})}
                    showName={false}
                    showStatus={false}
                    autoOpenInstall={installIntentId === plugin.id}
                    onInstalled={(result) => {
                      if (wsl) {
                        if (result.resolvedPath && !command) {
                          writeHostCommands({ ...ownSettings.cliCommands, [plugin.id]: result.resolvedPath })
                        }
                        onMachineReload()
                        return
                      }
                      if (result.resolvedPath && !localCommand) {
                        setCliRuntime(plugin.id, { command: result.resolvedPath })
                      }
                      void refreshPluginCatalog()
                      // Main recorded what the install found for this CLI, so
                      // this read shows it on its row and in the deployment
                      // pickers without probing every other CLI again.
                      void refreshCliAvailability({ cliRuntimes })
                    }}
                  />

                  {!wsl && listedModels.length > 0 ? (
                    <div className="flex gap-2 text-body leading-5">
                      <span className="shrink-0 text-[color:var(--text-muted)]">Models</span>
                      <span className="min-w-0 font-mono text-[color:var(--text-default)]">
                        {listedModels.map((model) => model.label ?? model.id).join(' · ')}
                      </span>
                    </div>
                  ) : null}

                  <div className="mt-2 divide-y divide-[color:var(--border-subtle)]">
                    {!wsl && plugin.modelSelection ? (
                      <CliModelsRow
                        name={plugin.displayName}
                        catalog={discoveredCatalog}
                        error={modelRefresh.errors[plugin.id] ?? null}
                        refreshing={modelRefresh.running}
                        onRefresh={() => void refreshCliModels()}
                      />
                    ) : null}
                    <SettingsRow
                      label="Command override"
                      help={
                        <>
                          Runs <span className="font-mono text-[color:var(--text-default)]">{plugin.binary}</span>
                          {wsl ? ` in ${machine.label}` : ''} when blank.
                        </>
                      }
                      htmlFor={commandFieldId}
                    >
                      <Input
                        id={commandFieldId}
                        // Per-plugin accessible name so screen readers don't announce an
                        // identical "Command override" for every CLI.
                        aria-label={
                          wsl
                            ? `${plugin.displayName} command override on ${machine.label}`
                            : `${plugin.displayName} command override`
                        }
                        value={command}
                        onChange={(event) => {
                          if (!wsl) {
                            setCliRuntime(plugin.id, { command: event.target.value })
                            return
                          }
                          const next = { ...ownSettings.cliCommands }
                          if (event.target.value) next[plugin.id] = event.target.value
                          else delete next[plugin.id]
                          writeHostCommands(next)
                        }}
                        placeholder={plugin.binary}
                        size="md"
                        variant="well"
                        fullWidth={false}
                        className={ROW_FIELD}
                      />
                    </SettingsRow>

                    {!wsl && allowCustomModels ? (
                      <PluginModelSettings
                        displayName={plugin.displayName}
                        userModels={userModels}
                        onUserModelsChange={(models) => {
                          setCliRuntime(plugin.id, { models })
                          // Retiring an id must also retire it as a remembered
                          // launch default, or every spawn surface that named
                          // it keeps passing `--model <deleted id>` and the
                          // agent dies on a model nothing offers. Only ids the
                          // picker no longer lists are forgotten: an id the
                          // CLI reported (or, before it has, the manifest
                          // seeds) is still a real model, and the user only
                          // removed their own copy.
                          const remaining = new Set(models)
                          const stillOffered = new Set(listedModels.map((option) => option.id))
                          const retired = userModels.filter((id) => !remaining.has(id) && !stillOffered.has(id))
                          if (retired.length > 0) forgetCliModels(plugin.id, retired)
                        }}
                      />
                    ) : null}

                    {!wsl && plugin.auth ? (
                      <CliCredentialRow
                        pluginId={plugin.id}
                        displayName={plugin.displayName}
                        label={plugin.auth.label}
                      />
                    ) : null}
                  </div>
                </ProviderRow>
              )
            })}
          </SettingCard>
        </section>
      )}
    </>
  )
}

// One CLI's model list: where the rows in its picker came from, with the one
// manual trigger. The words come from modelDiscoveryLine, and the row keeps
// its own clock so "checked 2m ago" ages without the tab re-rendering around
// it. Refresh re-asks every installed CLI
// past the freshness window, and the answer replaces each CLI's list.
function CliModelsRow({
  name,
  catalog,
  error,
  refreshing,
  onRefresh,
}: {
  name: string
  catalog: DiscoveredCliModelCatalog | undefined
  error: string | null
  refreshing: boolean
  onRefresh: () => void
}) {
  const line = (now: number) => modelDiscoveryLine({ name, catalog, error, now })
  const now = useRelativeNowFor(line)
  return (
    <SettingsRow label="Model list" help={line(now)}>
      <OutlineButton size="xs" disabled={refreshing} onClick={onRefresh}>
        {refreshing ? <Spinner className="icon-sm" /> : null}
        Refresh
      </OutlineButton>
    </SettingsRow>
  )
}

// API-key entry for a CLI whose manifest declares `auth` (e.g. Z.AI). Reads and
// writes through the shared credential store via the generic `credentialSecret*`
// IPC — the same store the chat Providers tab uses. Mirrors the Providers tab's
// masked/save/remove pattern; the value is write-only and never read back.
function CliCredentialRow({ pluginId, displayName, label }: { pluginId: string; displayName: string; label: string }) {
  const [status, setStatus] = useState<Awaited<ReturnType<typeof window.api.credentialSecretStatus>> | null>(null)
  const [draft, setDraft] = useState('')
  const [busy, setBusy] = useState(false)
  const [message, setMessage] = useState<string | null>(null)

  useEffect(() => {
    let active = true
    void window.api.credentialSecretStatus({ id: pluginId }).then((result) => {
      if (active) setStatus(result)
    })
    return () => {
      active = false
    }
  }, [pluginId])

  const configured = status?.ok === true && status.status.configured
  const source = status?.ok === true ? status.status.source : 'none'
  const persistence = status?.ok === true ? status.status.persistence : 'encrypted'
  // Environment-sourced keys are owned outside the app; don't offer Remove.
  const canClear = configured && source !== 'environment'
  const inputId = `cli-credential-${pluginId}`

  const save = async (): Promise<void> => {
    const value = draft.trim()
    if (!value || busy) return
    setBusy(true)
    setMessage(null)
    const result = await window.api.credentialSecretSet({ id: pluginId, value })
    setBusy(false)
    if (result.ok) {
      setStatus(result)
      setDraft('')
      setMessage('API key saved.')
    } else {
      setMessage(result.message)
    }
  }

  const clear = async (): Promise<void> => {
    if (busy) return
    setBusy(true)
    setMessage(null)
    const result = await window.api.credentialSecretClear({ id: pluginId })
    setBusy(false)
    if (result.ok) {
      setStatus(result)
      setMessage('API key removed.')
    } else {
      setMessage(result.message)
    }
  }

  return (
    <div className="py-2.5 first:pt-0 last:pb-0">
      <div className="text-body font-medium text-[color:var(--text-strong)]">{label}</div>
      <div className="mt-2 space-y-1.5">
        {configured ? (
          <div className="flex items-center gap-2">
            {/* The saved key is shown as the field it will be edited in, read-only
                — not as a div wearing a copy of the field's chrome. The value IS
                the mask, so the accessible name says what the dots mean. */}
            <Input
              readOnly
              value="••••••••••••"
              aria-label={`${displayName} API key is saved`}
              size="md"
              variant="well"
              fullWidth={false}
              className="min-w-0 flex-1 tracking-[0.3em] text-[color:var(--text-muted)]"
            />
            {canClear ? (
              <GhostButton size="md" onClick={() => void clear()} disabled={busy} className="shrink-0">
                {busy ? 'Removing…' : 'Remove'}
              </GhostButton>
            ) : null}
          </div>
        ) : (
          <div className="flex items-center gap-2">
            <label htmlFor={inputId} className="sr-only">
              {displayName} API key
            </label>
            <Input
              id={inputId}
              type="password"
              value={draft}
              onChange={(event) => setDraft(event.target.value)}
              onKeyDown={(event) => {
                if (isImeKey(event)) return
                if (event.key === 'Enter') {
                  event.preventDefault()
                  void save()
                }
              }}
              placeholder="Paste API key"
              autoComplete="off"
              disabled={busy}
              size="md"
              variant="well"
              fullWidth={false}
              className={`min-w-0 flex-1 ${MONO_FIELD}`}
            />
            <PrimaryButton size="md" onClick={() => void save()} disabled={busy || !draft.trim()} className="shrink-0">
              {busy ? 'Saving…' : 'Save'}
            </PrimaryButton>
          </div>
        )}
        {configured && source === 'environment' ? (
          <p className="text-meta leading-5 text-[color:var(--text-subtle)]">
            Set from the environment. Remove it there to change it.
          </p>
        ) : configured && persistence === 'session' ? (
          <p className="text-meta leading-5 text-[color:var(--tone-warn)]">
            Stored for this session only — clears when the app quits.
          </p>
        ) : null}
        <div aria-live="polite" className="text-meta leading-5 text-[color:var(--text-muted)] empty:hidden">
          {message}
        </div>
      </div>
    </div>
  )
}

// Per-plugin custom model ids. The studio does not persist an app-level default
// model (the CLI's own default is used when no per-surface override is set), so
// this is purely the user-extended id list. Rendered only when the plugin
// declares modelSelection with `allowCustomId` — without declared launch args a
// model could not be passed, and terminal CLIs expose no live model catalog, so
// this list is how new models are adopted between plugin updates. Rendered
// inline inside the per-plugin configuration disclosure.
function PluginModelSettings({
  displayName,
  userModels,
  onUserModelsChange,
}: {
  displayName: string
  userModels: string[]
  onUserModelsChange: (models: string[]) => void
}) {
  const [draftModel, setDraftModel] = useState('')
  const addDraftModel = (): void => {
    const model = draftModel.trim()
    if (!model) return
    if (!userModels.includes(model)) onUserModelsChange([...userModels, model])
    setDraftModel('')
  }
  return (
    <div className="py-2.5 first:pt-0 last:pb-0">
      <div className="text-body font-medium text-[color:var(--text-strong)]">Custom model ids</div>
      <div className="mt-2 space-y-1">
        {userModels.map((model) => (
          <div key={model} className="group -mx-1 flex h-control-md items-center gap-2 rounded-sm px-1">
            <span className="min-w-0 flex-1 truncate font-mono text-body text-[color:var(--text-default)]">
              {model}
            </span>
            <GhostButton
              size="xs"
              onClick={() => onUserModelsChange(userModels.filter((id) => id !== model))}
              className="invisible focus-visible:visible group-focus-within:visible group-hover:visible"
            >
              Remove
              <span className="sr-only">
                {' '}
                {model} from {displayName} models
              </span>
            </GhostButton>
          </div>
        ))}
        <Input
          value={draftModel}
          aria-label={`Add a model id for ${displayName}`}
          placeholder="Add model id and press Enter"
          onChange={(event) => setDraftModel(event.target.value)}
          onKeyDown={(event) => {
            if (isImeKey(event)) return
            if (event.key === 'Enter') {
              event.preventDefault()
              addDraftModel()
            }
          }}
          size="md"
          variant="well"
          className={MONO_FIELD}
        />
      </div>
    </div>
  )
}

// One CLI's update output, read a chunk at a time as it streams in rather than
// parsed whole again for every chunk (`useAnsiPlainText`).
function CliUpdateLog({ label, log }: { label: string; log: string }) {
  const text = useAnsiPlainText(log)
  return (
    <pre
      aria-label={label}
      className="max-h-48 overflow-auto whitespace-pre-wrap rounded-[var(--radius-sm)] bg-[color:var(--bg-app)] px-2.5 py-1.5 font-mono text-meta leading-[1.5] text-[color:var(--text-muted)]"
    >
      {text || 'Starting…'}
    </pre>
  )
}
