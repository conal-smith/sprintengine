import type {
  AgentCli,
  AgentCliAvailabilityMap,
  AgentCliModelSelection,
  CliRuntimeSettings,
  PluginCatalogEntry,
  PluginCatalogStatus,
} from '../../../types/workspace'
import type { PluginModelCatalog, PluginReasoningCatalog } from '../../../../../shared/plugin-manifest'
import {
  mergeCliModelCatalog,
  type DiscoveredCliModelCatalog,
  type MergedCliModelCatalog,
} from '../../../../../shared/cli-model-catalog'
import { isWslHostId, type ExecutionHostId, type ExecutionHostSettings } from '../../../../../shared/execution-host'
import { conversationCliRuntimesForHost } from '../../../../../shared/conversation-cli-runtimes'

// What each CLI reported about its own models, keyed by plugin id — the
// `cliModelCatalog` app setting, passed in rather than read from the store so
// this module stays store-free.
export type DiscoveredCliModelCatalogs = Partial<Record<AgentCli, DiscoveredCliModelCatalog>>

export type AgentCliCatalogOption = {
  value: AgentCli
  label: string
  source?: PluginCatalogEntry['source']
  // Model choices for this CLI: what the CLI reported about itself (the
  // manifest's seed options until it has), then the user-added ids from
  // `cliRuntimes[id].models`, each row tagged with where it came from.
  // Absent when the plugin declares no modelSelection — such CLIs show no model
  // UI at all.
  modelSelection?: MergedCliModelCatalog
  // Reasoning-effort levels the CLI accepts (manifest-declared). Absent when
  // the plugin declares no reasoningSelection — such CLIs show no effort UI.
  reasoningSelection?: PluginReasoningCatalog
  // Set when this runtime is a hosted model (another CLI's binary redirected at
  // a provider endpoint); pickers group these under "Models via Claude Code".
  hostedVia?: PluginCatalogEntry['hostedVia']
  // The runtime needs a credential of its own before it can start at all.
  needsCredential?: true
  // Detected install state, attached once availability is known. `undefined`
  // means "not probed yet"; deployment surfaces hide only options that are
  // explicitly `installed === false` (see filterCatalogByAvailability).
  installed?: boolean
  resolvedPath?: string | null
}

// Trust state of the detected-availability map. Mirrors the slice's
// CliAvailabilityStatus without importing the store (keeps this util store-free).
export type CliAvailabilityFilterStatus = 'loading' | 'ready' | 'error'

export type CliAvailabilityFilter = {
  map: AgentCliAvailabilityMap | null | undefined
  status: CliAvailabilityFilterStatus
}

const CLAUDE_CODE_PLUGIN_ID = 'claude-code'

// Plugin ids that exist in the main-process registry but must never appear as a
// selectable agent CLI in spawn pickers. The AUTHORITATIVE gate is the
// manifest-projected `agentStateCapable` flag on each registry entry (hooks are
// the only supported status mechanism — decision of record 2026-08-31; a CLI
// without an agentStateSpec cannot report agent state and is not offered as an
// agent), applied in `buildAgentCliCatalog`'s registry path and enforced again
// main-side at launch. This static set is the manifest-LESS fallback mirror of
// that rule for the two contexts that cannot read manifests — the
// loading/error fallback catalog in `legacyCliRuntimeOptions` (where a
// persisted `cliRuntimes` key could otherwise leak a hidden id) and the
// id-only `isSelectableAgentCli` — and must list exactly the bundled plugins
// that declare no agentStateSpec (pinned by test against the shipped
// manifests):
//   - `generic-shell`: a bare `sh` pipe with no tool use, resume, or hooks —
//     it duplicates the Terminal quick row and stays registry-available for
//     direct terminal launch.
//   - `muse`: Muse Code's beta ignores its own documented hooks config
//     (.muse/hooks.json is silently dropped as of 0.2.1), so it cannot report
//     agent state; it stays installable/detectable and returns to the picker
//     when its hooks GA and its manifest gains an agentStateSpec.
const AGENT_PICKER_HIDDEN_CLI_IDS = new Set<AgentCli>(['generic-shell', 'muse'])

// Whether this plugin id is one the agent surfaces offer at all. Exported
// because "does this machine have an agent CLI?" is a question about these ids
// and only these: `generic-shell` ships with `binary: "sh"`, which every machine
// resolves, so a reader that counts the raw availability map answers "yes" on a
// machine with no agent CLI installed — and the first-run CLI card, which exists
// for exactly that machine, never appears while every picker stands empty.
export function isSelectableAgentCli(cli: AgentCli): boolean {
  return !AGENT_PICKER_HIDDEN_CLI_IDS.has(cli)
}

// Fallback model catalogs for the bundled CLIs, used only while the plugin
// registry is loading or errored (legacyCliRuntimeOptions / the `null`-plugins
// path). The registry path reads each plugin manifest's own `modelSelection`.
//
// Policy: ship NO seeded model ids. Any baked-in list is a guess about the
// user's entitlements — offering a model the account can't run turns selection
// into a trap (the user picks it and the launch fails or silently falls back).
// The rows come from what the installed CLI reports (see mergeCliModelCatalog);
// until it has, the bare CLI row launches with the CLI's own default (no
// `--model` flag) and the user adds the ids they actually have access to via
// Settings → the model list persists per CLI in `cliRuntimes[id].models`.
// `allowCustomId` stays true so that add-your-own flow (and the picker
// passthrough) keeps working.
const BUNDLED_AGENT_MODEL_CATALOGS: Record<AgentCli, PluginModelCatalog> = {
  codex: {
    options: [],
    allowCustomId: true,
  },
  [CLAUDE_CODE_PLUGIN_ID]: {
    options: [],
    allowCustomId: true,
  },
  opencode: {
    options: [],
    allowCustomId: true,
  },
  // Z.AI runs the claude binary against Z.AI's endpoint; model tier is driven by
  // the manifest's ANTHROPIC_DEFAULT_*_MODEL env, so the picker seeds no models.
  zai: {
    options: [],
    allowCustomId: true,
  },
  grok: {
    options: [],
    allowCustomId: true,
  },
  'kimi-code': {
    options: [],
    allowCustomId: true,
  },
  // Kimi K3 via Claude Code runs the claude binary against Moonshot's endpoint;
  // model tier is driven by the manifest's ANTHROPIC_DEFAULT_*_MODEL env, so
  // the picker seeds no models (same as zai).
  'kimi-claude': {
    options: [],
    allowCustomId: true,
  },
  cursor: {
    options: [],
    allowCustomId: true,
  },
}

export function labelForCliRuntime(cli: AgentCli): string {
  if (cli === 'codex') return 'Codex'
  if (cli === 'claude-code') return 'Claude Code'
  if (cli === 'opencode') return 'OpenCode'
  // Title-casing would render this id as "Kimi Claude"; keep the registry
  // displayName so the loading/error fallback catalog reads the same.
  if (cli === 'kimi-claude') return 'Kimi K3'
  return (
    cli
      .split(/[-_\s]+/u)
      .filter(Boolean)
      .map((part) => part.slice(0, 1).toUpperCase() + part.slice(1))
      .join(' ') || cli
  )
}

function legacyCliRuntimeOptions(
  cliRuntimes: Partial<Record<AgentCli, Partial<CliRuntimeSettings>>> | undefined,
  discovered: DiscoveredCliModelCatalogs | undefined,
  now: number,
): AgentCliCatalogOption[] {
  const seen = new Set<AgentCli>()
  const orderedIds: AgentCli[] = []
  for (const id of ['codex', CLAUDE_CODE_PLUGIN_ID, 'opencode', ...Object.keys(cliRuntimes ?? {})]) {
    const trimmed = id.trim()
    const canonical = pluginRegistryIdForCli(trimmed)
    if (!canonical || seen.has(canonical) || AGENT_PICKER_HIDDEN_CLI_IDS.has(canonical)) continue
    seen.add(canonical)
    orderedIds.push(canonical)
  }
  return orderedIds.map((value) => {
    const modelSelection = mergeCliModelCatalog(
      BUNDLED_AGENT_MODEL_CATALOGS[value],
      cliRuntimes?.[value]?.models,
      discovered?.[value],
      now,
    )
    return {
      value,
      label: labelForCliRuntime(value),
      ...(modelSelection ? { modelSelection } : {}),
    }
  })
}

export function pluginRegistryIdForCli(cli: AgentCli): AgentCli {
  return cli
}

// What the install route offers, named from the registry rather than a
// hardcoded list, so the line on the install surfaces cannot drift from the
// plugins that actually ship. Empty string when there is nothing to name.
export function installableCliSummary(labels: string[]): string {
  const named = labels.slice(0, 3)
  if (named.length === 0) return ''
  const rest = labels.length - named.length
  return rest > 0 ? `${named.join(', ')}, and ${rest} more.` : `${named.join(', ')}.`
}

// Bundled entries first, then user entries, deduped by id — the row order for
// the Agents settings tab. Unlike buildAgentCliCatalog this keeps the full
// PluginCatalogEntry (binary, version, source) the settings rows need.
export function orderInstalledPlugins(entries: PluginCatalogEntry[] | null | undefined): PluginCatalogEntry[] {
  if (!entries) return []
  const seen = new Set<string>()
  const ordered: PluginCatalogEntry[] = []
  for (const entry of [...entries].sort((a, b) => (a.source === b.source ? 0 : a.source === 'bundled' ? -1 : 1))) {
    const id = entry.id.trim()
    if (!id || seen.has(id)) continue
    seen.add(id)
    ordered.push(entry)
  }
  return ordered
}

// Effective invocation override shown on a plugin's settings row: its command
// on this machine. Uses the plugin-id key only; a blank command means "use the
// manifest binary" at launch.
export function cliRuntimeForPlugin(
  pluginId: AgentCli,
  cliRuntimes: Partial<Record<AgentCli, Partial<CliRuntimeSettings>>> | undefined,
): { command: string } {
  const direct = cliRuntimes?.[pluginId]
  const command = (typeof direct?.command === 'string' ? direct.command : undefined) ?? ''
  return { command }
}

// A CLI's runtime on one machine, as an install, a detection or an update run
// there is given it: this machine's command from `cliRuntimes`, a WSL
// distribution's from its own `hosts[id].cliCommands`, with the machine named.
export function cliRuntimeOnMachine(
  pluginId: AgentCli,
  hostId: ExecutionHostId,
  settings: {
    cliRuntimes?: Partial<Record<AgentCli, Partial<CliRuntimeSettings>>>
    hosts?: Partial<Record<ExecutionHostId, ExecutionHostSettings>>
  },
): { command: string; hostId?: ExecutionHostId } {
  if (!isWslHostId(hostId)) return cliRuntimeForPlugin(pluginId, settings.cliRuntimes)
  return { command: settings.hosts?.[hostId]?.cliCommands[pluginId] ?? '', hostId }
}

/**
 * The CLI runtimes a chat in a workspace runs with — the shared rule main's
 * own chat launches follow too (`conversationCliRuntimesForHost`).
 */
export function conversationCliRuntimesFor(
  cliRuntimes: Partial<Record<AgentCli, Partial<CliRuntimeSettings>>> | undefined,
  hostId: ExecutionHostId | null | undefined,
  hosts: Partial<Record<ExecutionHostId, ExecutionHostSettings>> | undefined,
): Partial<Record<AgentCli, Partial<CliRuntimeSettings>>> | undefined {
  return conversationCliRuntimesForHost<CliRuntimeSettings>(cliRuntimes, hostId, hosts)
}

export function isAgentCliAvailable(cli: AgentCli, catalog: AgentCliCatalogOption[]): boolean {
  const registryId = pluginRegistryIdForCli(cli)
  return catalog.some((option) => option.value === cli || option.value === registryId)
}

export function resolveAvailableAgentCli(
  cli: AgentCli | null | undefined,
  catalog: AgentCliCatalogOption[],
  fallback: AgentCli = CLAUDE_CODE_PLUGIN_ID,
): AgentCli {
  if (cli && isAgentCliAvailable(cli, catalog)) return pluginRegistryIdForCli(cli)
  if (isAgentCliAvailable(fallback, catalog)) return fallback
  return catalog[0]?.value ?? fallback
}

// The CLI a spawn should actually launch, or `null` when this machine has none.
//
// `resolveAvailableAgentCli` always answers with something — a picker needs a
// default to render even before its catalog resolves — and its last resort is
// `catalog[0] ?? fallback`. Against an availability-filtered catalog that is
// empty because nothing is installed, that answer is a guess: it hands a spawn a
// binary the machine does not have. Launch surfaces ask this instead, and render
// their install route on `null` rather than spawning against the guess.
export function resolveLaunchableAgentCli(
  cli: AgentCli | null | undefined,
  catalog: AgentCliCatalogOption[],
): AgentCli | null {
  const first = catalog[0]
  if (!first) return null
  return resolveAvailableAgentCli(cli, catalog, first.value)
}

export function isAgentCliMissing(cli: AgentCli | null | undefined, catalog: AgentCliCatalogOption[]): boolean {
  return Boolean(cli && !isAgentCliAvailable(cli, catalog))
}

// CLI a New chat / template agent should spawn with.
//
// It NORMALISES; it does not verify. An explicit selection is answered with its
// registry id and nothing else is asked of it — this function never checks that
// the machine has that runtime, and callers must not read it as if it had. The
// check a spawn needs is `resolveLaunchableAgentCli`, which the spawn paths run
// on their way in and which answers null when the machine has nothing to launch.
// Only the REMEMBERED `lastSelectedCli` is clamped to an installed catalog entry
// here, so a stale default cannot seed a new agent with an uninstalled plugin
// id. With an empty catalog (registry still loading) it returns lastSelectedCli
// unchanged rather than throwing.
export function resolveTemplateAgentCli(
  explicitCli: AgentCli | null | undefined,
  lastSelectedCli: AgentCli,
  catalog: AgentCliCatalogOption[],
): AgentCli {
  const explicit = explicitCli?.trim()
  if (explicit) return pluginRegistryIdForCli(explicit)
  return resolveAvailableAgentCli(lastSelectedCli, catalog, catalog[0]?.value ?? lastSelectedCli)
}

export function buildAgentCliCatalog(
  plugins: PluginCatalogEntry[] | null | undefined,
  cliRuntimes?: Partial<Record<AgentCli, Partial<CliRuntimeSettings>>>,
  discovered?: DiscoveredCliModelCatalogs,
  now: number = Date.now(),
): AgentCliCatalogOption[] {
  if (!plugins) return legacyCliRuntimeOptions(cliRuntimes, discovered, now)

  const seen = new Set<AgentCli>()
  const ordered = [...plugins].sort((a, b) => {
    if (a.source === b.source) return 0
    return a.source === 'bundled' ? -1 : 1
  })
  const options: AgentCliCatalogOption[] = []
  for (const plugin of ordered) {
    const id = plugin.id.trim()
    if (!id || seen.has(id) || AGENT_PICKER_HIDDEN_CLI_IDS.has(id)) continue
    // The manifest-driven gate: a plugin whose manifest declares no
    // agentStateSpec cannot report authoritative agent state and is not
    // offered as an agent. `=== false` (not `!== true`) so a stale persisted
    // snapshot from an older main process — which lacks the field — keeps its
    // catalog until the live registry refreshes it, rather than emptying.
    if (plugin.agentStateCapable === false) continue
    seen.add(id)
    const modelSelection = mergeCliModelCatalog(
      plugin.modelSelection ?? BUNDLED_AGENT_MODEL_CATALOGS[id],
      cliRuntimes?.[id]?.models,
      discovered?.[id],
      now,
    )
    options.push({
      value: id,
      label: plugin.displayName,
      source: plugin.source,
      ...(modelSelection ? { modelSelection } : {}),
      ...(plugin.reasoningSelection ? { reasoningSelection: plugin.reasoningSelection } : {}),
      ...(plugin.hostedVia ? { hostedVia: plugin.hostedVia } : {}),
      ...(plugin.auth ? { needsCredential: true as const } : {}),
    })
  }
  return options
}

/**
 * The options a launch can actually start. A runtime that needs a key rides
 * another CLI's binary, so it reads as installed the moment that CLI is, and
 * offering it would put a provider nobody set up in every picker, to fail at
 * launch. It joins the picker once its key is saved in Settings. `withKey` is
 * null until that is known, and a picker then leaves every option in.
 */
export function withoutUnkeyedRuntimes(
  options: AgentCliCatalogOption[],
  withKey: ReadonlySet<string> | null,
): AgentCliCatalogOption[] {
  if (!withKey) return options
  return options.filter((option) => !option.needsCredential || withKey.has(option.value))
}

// Effective model for a launch surface: the surface's own override only when
// it was picked for this CLI. Otherwise undefined means the CLI's own default,
// with no model flag passed.
export function resolveCliModel(
  cli: AgentCli,
  override: AgentCliModelSelection | null | undefined,
): string | undefined {
  const overrideModel = override && override.cli === cli ? override.model.trim() : ''
  return overrideModel || undefined
}

// Effective reasoning-effort level for a launch surface. Same guard as
// resolveCliModel, and for the same reason: levels are per-CLI manifest
// knowledge, so a level picked for Codex must never reach a Claude launch (the
// two CLIs do not even share a level set). Undefined means the CLI's own
// default effort, with no flag passed — and the render boundary drops a level
// the manifest does not declare, so this is not the only guard.
export function resolveCliReasoning(
  cli: AgentCli,
  override: AgentCliModelSelection | null | undefined,
): string | undefined {
  const overrideReasoning = override && override.cli === cli ? override.reasoning?.trim() : ''
  return overrideReasoning || undefined
}

// Effective model for a per-surface picker: the
// surface's own (cli, model) override when it matches the bound CLI, else no
// model — the CLI's own default, no flag.
export function resolveSurfaceModel(
  cli: AgentCli,
  override: AgentCliModelSelection | null | undefined,
): string | undefined {
  return resolveCliModel(cli, override)
}

export function buildCliRuntimeOptions(
  cliRuntimes: Partial<Record<AgentCli, Partial<CliRuntimeSettings>>> | undefined,
): AgentCliCatalogOption[] {
  return buildAgentCliCatalog(null, cliRuntimes)
}

// Renderer picker entry point: turns the non-persisted plugin catalog slice
// (status + entries from T2) into selectable options. Registry entries are only
// trusted once `status` is `ready`; while `loading` or after an `error` we fall
// back to the legacy bundled options so every picker stays populated and never
// throws. A `ready` registry with zero entries returns an empty list on purpose
// so callers can render a real "no agent plugins" state instead of inventing
// fallback agents.
export function selectAgentCliCatalog(
  status: PluginCatalogStatus,
  entries: PluginCatalogEntry[] | null | undefined,
  cliRuntimes?: Partial<Record<AgentCli, Partial<CliRuntimeSettings>>>,
  availability?: CliAvailabilityFilter,
  discovered?: DiscoveredCliModelCatalogs,
  now: number = Date.now(),
): AgentCliCatalogOption[] {
  const catalog = buildAgentCliCatalog(status === 'ready' ? (entries ?? []) : null, cliRuntimes, discovered, now)
  if (!availability) return catalog
  return filterCatalogByAvailability(catalog, availability.map, availability.status)
}

// Annotate each option with its detected install state and hide the agent CLIs
// whose binary is not installed, so deployment pickers never offer (or default
// to) an uninstalled agent.
//
// Detection that is not trustworthy yet is a different answer from "nothing is
// installed", and only the first one earns a fallback:
//   - status is not `ready` (still loading, or detection errored), or the map is
//     absent → we do not know, so the unfiltered (annotated) catalog stands and
//     a transient probe failure never empties a picker on a machine that has CLIs.
//   - status is `ready` and every entry says not-installed → that IS the answer
//     on a fresh machine, so the result is empty and the surfaces render their
//     install state. The old escape hatch returned the whole catalog
//     here, and every downstream membership guard then read eight uninstalled
//     CLIs as launchable.
// Only options explicitly detected as `installed === false` are removed; an
// option with no availability entry (e.g. probed-after-add) stays visible.
export function filterCatalogByAvailability(
  catalog: AgentCliCatalogOption[],
  availabilityMap: AgentCliAvailabilityMap | null | undefined,
  status: CliAvailabilityFilterStatus,
): AgentCliCatalogOption[] {
  const annotated = catalog.map((option) => {
    const entry = availabilityMap?.[option.value]
    return entry ? { ...option, installed: entry.installed, resolvedPath: entry.resolvedPath } : option
  })

  if (status !== 'ready' || !availabilityMap) return annotated

  return annotated.filter((option) => availabilityMap[option.value]?.installed !== false)
}
