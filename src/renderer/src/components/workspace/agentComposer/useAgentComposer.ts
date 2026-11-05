import React from 'react'
import type { AgentCliAvailabilityMap } from '../../../../../shared/electron-api'
import type { AgentCli } from '../../../types/workspace'
import type { WorkspaceSkill } from '../../../../../shared/electron-api'
import {
  resolveAvailableAgentCli,
  resolveCliReasoning,
  resolveSurfaceModel,
  selectAgentCliCatalog,
  withoutUnkeyedRuntimes,
  type AgentCliCatalogOption,
} from '../newWorkspace/cliRuntimeOptions'
import { normalizeSelectedCli } from '../../../store/slices/settingsSlice'
import { conversationProviderForCli } from '../../../../../shared/conversation-harness'
import { useWorkspaceStore } from '../../../store/workspaceStore'
import { clientSupports } from '../../../clientCapabilities'

// The agent a composer surface picks. The engine (CLI/model) is bound to the
// selection and read from the store's remembered defaults, so a confirm only
// needs the agent identity plus the resolved CLI — the model round-trips
// through the defaults.
export type AgentComposerSelection = { kind: 'terminal' } | { kind: 'general' } | { kind: 'conversation' }

export type AgentComposerConfirm = (
  | { kind: 'terminal' }
  | { kind: 'general'; cli: AgentCli; model?: string | null }
  | {
      kind: 'conversation'
      // The CLI and model the shared picker stands on. A chat agent is that CLI
      // driven as a chat, so the launch names the same pair a terminal launch
      // would; `provider` is the conversation provider it maps onto.
      cli?: AgentCli
      model?: string | null
      provider?: { providerId: string; modelId: string; modelLabel: string }
    }
) & {
  // The Skills & MCPs picks (browser-pane epic, child 7). Skills were
  // installed on pick; the spawn prefills their invocations as the agent's
  // first input, in pick order, never auto-sent. Terminal confirms ignore them.
  skills?: WorkspaceSkill[]
  // The effort level the launch runs at. Always named for a General spawn
  // (null = the CLI's own default). The host must not re-read the remembered
  // defaults for this; the same-turn miss that dropped `--model` would drop
  // the effort flag the same way.
  reasoning?: string | null
  // Optional worktree (terminal agents and chats): the spawn creates a git
  // worktree off the workspace repo and the agent works in it. An empty name
  // means "make one up at spawn".
  worktree?: { name: string }
  // MCP servers picked for this launch. They were added to the app's MCP
  // settings and synced into the workspace's CLI config on pick, so the agent
  // finds them in place; the confirm names them for the record and the chips.
  mcpServers?: AgentComposerConnector[]
}

// One picked MCP server, as the confirm carries it: identity plus the display
// bits the chip shows. `icon` falls back to the brand mark keyed off the id.
export type AgentComposerConnector = { id: string; name: string; icon?: string }

// One roster row. Arrow keys rove this flat list so navigation is uniform.
export type ComposerRow =
  { key: string; kind: 'terminal' } | { key: string; kind: 'general' } | { key: string; kind: 'conversation' }

export function rowMatchesSelection(row: ComposerRow, selection: AgentComposerSelection): boolean {
  return selection.kind === row.kind
}

export function selectionForRow(row: ComposerRow): AgentComposerSelection {
  return { kind: row.kind }
}

// The roster every composer surface offers. Terminal (a plain shell) and
// Conversation (provider-backed) launch no CLI, so they survive a machine with
// none; the General row does launch one, so with none installed it is not built
// at all — a row that cannot run must not be reachable by click or Enter, and
// the surfaces render the install route instead.
export function composerRosterRows({
  showTerminal,
  conversationAvailable,
  noAgentCliInstalled,
  terminals = true,
}: {
  showTerminal: boolean
  conversationAvailable: boolean
  noAgentCliInstalled: boolean
  /** Whether this shell has terminals at all. A browser tab does not (ruling a): only the chat row is offered there. */
  terminals?: boolean
}): ComposerRow[] {
  const rows: ComposerRow[] = []
  if (showTerminal && terminals) rows.push({ key: 'terminal', kind: 'terminal' })
  if (!noAgentCliInstalled && terminals) rows.push({ key: 'general', kind: 'general' })
  if (conversationAvailable) rows.push({ key: 'conversation', kind: 'conversation' })
  return rows
}

// Resolve the opening selection to a row that actually exists. The remembered
// agent is preselected when present; otherwise it falls back to the General row
// (else the first quick row) — so a cold install lands on a real row rather
// than an unselectable phantom. Pure: the caller supplies the roster.
export function resolveInitialSelection(
  rows: ComposerRow[],
  preferred: AgentComposerSelection,
): AgentComposerSelection {
  if (rows.some((row) => rowMatchesSelection(row, preferred))) return preferred
  const first = rows.find((row) => row.kind === 'general') ?? rows[0]
  return first ? selectionForRow(first) : preferred
}

// What an agent's engine is called on screen: the runtime ("Claude Code") and
// the model picked on it ("Fable 5"), or null when the agent launches on that
// runtime's own default model.
export type EngineNames = { cliLabel: string; modelLabel: string | null }

// The engine's display names, from the catalog that produced the option. A
// model id with no catalog row keeps its id rather than borrowing a neighbour's
// label — an unlabelled model is shown as what it is, never renamed.
export function engineNames(
  options: ReadonlyArray<{
    value: AgentCli
    label: string
    modelSelection?: { options: ReadonlyArray<{ id: string; label?: string }> }
  }>,
  cli: AgentCli,
  model: string | undefined,
): EngineNames {
  const option = options.find((entry) => entry.value === cli)
  return {
    cliLabel: option?.label ?? cli,
    modelLabel: model ? (option?.modelSelection?.options.find((entry) => entry.id === model)?.label ?? model) : null,
  }
}

type UseAgentComposerOptions = {
  // Whether the Terminal quick row is offered.
  showTerminal: boolean
  // Whether the Conversation quick row is offered (bound to the active standard
  // workspace's provider load).
  conversationAvailable: boolean
  // The remembered agent, preselected on open. Absent → the General row.
  initialSelection: AgentComposerSelection
  // MCP servers to open with already picked (the connector "New chat" entry
  // points). Seeds the picks only; each stays removable like a hand-picked one.
  initialMcpServers?: AgentComposerConnector[] | null
  /** Skills a parked New chat draft carried; absent starts with none. */
  initialSkills?: WorkspaceSkill[] | null
  /**
   * The engine this surface OPENS on, when the pick that chose it was never
   * written to the remembered defaults (a card's `Go` picker, item 2473:
   * choosing how to run one card must not move the engine of the next New
   * chat). Absent everywhere else, and the defaults answer exactly as before.
   *
   * It is an opening position, not a lock: the first engine the person picks
   * here writes a default and retires it.
   */
  initialEngine?: { cli: AgentCli; model: string | null; reasoning: string | null } | null
  /** The worktree a surface opens with: null off, '' on with a made-up name. A scheduled agent being edited. */
  initialWorktreeName?: string | null
  /**
   * Which CLIs the launch's machine has, when it is not this one (a WSL
   * distribution picked in the New chat dropdown). Absent reads this machine's
   * availability from the store, exactly as before.
   */
  availability?: { map: AgentCliAvailabilityMap; status: 'loading' | 'ready' | 'error' }
}

/**
 * The runtimes needing a key that have one saved, or null until that has been
 * read. Read when a picker mounts, so a key saved in Settings counts the next
 * time one opens.
 */
function useCliIdsWithKey(ids: string): ReadonlySet<string> | null {
  const [withKey, setWithKey] = React.useState<ReadonlySet<string> | null>(null)
  React.useEffect(() => {
    const read = window.api?.credentialSecretStatus
    if (typeof read !== 'function') return
    let cancelled = false
    const wanted = ids ? ids.split('\u0000') : []
    void Promise.all(
      wanted.map((id) =>
        read({ id }).then(
          (result) => (result.ok && result.status.configured ? id : null),
          // Not known is not "no key": the launch still says so if there is none.
          () => id,
        ),
      ),
    ).then((answers) => {
      if (!cancelled) setWithKey(new Set(answers.filter((id): id is string => id !== null)))
    })
    return () => {
      cancelled = true
    }
  }, [ids])
  return withKey
}

/**
 * The agent CLIs this machine can launch, as every model picker lists them:
 * the plugin catalog, filtered to what is installed, with each CLI's own model
 * list merged over its manifest seed. One hook so the New agent launcher and a
 * chat agent's composer read the same rows for the same CLI.
 */
export function useAgentCliCatalogOptions(availability?: {
  map: AgentCliAvailabilityMap
  status: 'loading' | 'ready' | 'error'
}): AgentCliCatalogOption[] {
  const cliRuntimes = useWorkspaceStore((s) => s.appSettings.cliRuntimes)
  const pluginCatalogEntries = useWorkspaceStore((s) => s.pluginCatalogEntries)
  const pluginCatalogStatus = useWorkspaceStore((s) => s.pluginCatalogStatus)
  const storeCliAvailability = useWorkspaceStore((s) => s.cliAvailability)
  const storeCliAvailabilityStatus = useWorkspaceStore((s) => s.cliAvailabilityStatus)
  const cliAvailability = availability?.map ?? storeCliAvailability
  const cliAvailabilityStatus = availability?.status ?? storeCliAvailabilityStatus
  // What each installed CLI reported about its models. Without it this surface
  // would offer only the manifest seed while every other picker offers the
  // CLI's own list.
  const cliModelCatalog = useWorkspaceStore((s) => s.appSettings.cliModelCatalog)
  const keyedIds = React.useMemo(
    () => (pluginCatalogEntries ?? []).flatMap((entry) => (entry.auth ? [entry.id] : [])).join('\u0000'),
    [pluginCatalogEntries],
  )
  const withKey = useCliIdsWithKey(keyedIds)
  return React.useMemo(
    () =>
      withoutUnkeyedRuntimes(
        selectAgentCliCatalog(
          pluginCatalogStatus,
          pluginCatalogEntries,
          cliRuntimes,
          { map: cliAvailability, status: cliAvailabilityStatus },
          cliModelCatalog,
        ),
        withKey,
      ),
    [
      pluginCatalogStatus,
      pluginCatalogEntries,
      cliRuntimes,
      cliAvailability,
      cliAvailabilityStatus,
      cliModelCatalog,
      withKey,
    ],
  )
}

// Shared state + store-derived data for every agent composer surface (the New
// Chat panel and the popover picker). Owns roster building, selection, and
// engine (CLI/model) resolution + persistence, so each
// layout component stays presentational. Selection is the durable highlight;
// the engine controls always reflect the selected agent's remembered pair and
// persist edits as that agent's default.
export function useAgentComposer({
  showTerminal,
  conversationAvailable,
  initialSelection,
  initialMcpServers,
  initialSkills,
  initialEngine,
  initialWorktreeName,
  availability,
}: UseAgentComposerOptions) {
  const lastSelectedCli = useWorkspaceStore((s) => normalizeSelectedCli(s.appSettings.lastSelectedCli))
  const setLastSelectedCli = useWorkspaceStore((s) => s.setLastSelectedCli)
  const lastSelectedAgentModel = useWorkspaceStore((s) => s.appSettings.lastSelectedAgentModel ?? null)
  const setLastSelectedAgentModel = useWorkspaceStore((s) => s.setLastSelectedAgentModel)
  const setLastSelectedAgentReasoning = useWorkspaceStore((s) => s.setLastSelectedAgentReasoning)
  const pluginCatalogStatus = useWorkspaceStore((s) => s.pluginCatalogStatus)
  const pluginCatalogError = useWorkspaceStore((s) => s.pluginCatalogError)
  const agentCliOptions = useAgentCliCatalogOptions(availability)
  // The CLIs a chat agent can run on: the installed ones with a conversation
  // runtime. The picker's rail offers only these while Chat agent is chosen,
  // because a chat on any other CLI would have nothing to drive it.
  const chatCliOptions = React.useMemo(
    () => agentCliOptions.filter((option) => conversationProviderForCli(option.value) !== null),
    [agentCliOptions],
  )
  const optionsFor = React.useCallback(
    (target: AgentComposerSelection): AgentCliCatalogOption[] =>
      target.kind === 'conversation' ? chatCliOptions : agentCliOptions,
    [agentCliOptions, chatCliOptions],
  )
  // This machine has no agent CLI. The catalog is availability-
  // filtered, so an empty one on a READY registry is the honest answer — a
  // pending or failed probe leaves the annotated catalog in place and never
  // reaches here, which is what keeps a transient probe failure from emptying
  // the roster on a machine that has CLIs.
  const noAgentCliInstalled = pluginCatalogStatus === 'ready' && agentCliOptions.length === 0

  const allRows = React.useMemo<ComposerRow[]>(
    () =>
      composerRosterRows({
        showTerminal,
        conversationAvailable,
        noAgentCliInstalled,
        terminals: clientSupports('terminals'),
      }),
    [showTerminal, conversationAvailable, noAgentCliInstalled],
  )

  const [selection, setSelection] = React.useState<AgentComposerSelection>(() =>
    resolveInitialSelection(allRows, initialSelection),
  )
  // The Skills & MCPs picks, carried onto the confirm in pick order; state
  // dies with the composer when the surface closes.
  const [skills, setSkills] = React.useState<WorkspaceSkill[]>(() => initialSkills ?? [])
  // Worktree: null = off; a string (possibly empty = a made-up name) means the
  // spawn creates a worktree and the agent works there.
  const [worktreeName, setWorktreeName] = React.useState<string | null>(initialWorktreeName ?? null)
  // A surface that opened with a server in hand (the connector "New chat"
  // buttons) seeds it here; from then on it is an ordinary pick.
  const [mcpServers, setMcpServers] = React.useState<AgentComposerConnector[]>(() => initialMcpServers ?? [])

  // The parked engine, until the person picks one. Held here rather than written
  // to the store on the way in: a default the person did not choose is a default
  // they cannot see they are carrying. Every engine write below retires it,
  // because from then on the store holds the answer.
  const [openingEngine, setOpeningEngine] = React.useState(() => initialEngine ?? null)

  const resolvePickerCli = React.useCallback(
    (cli: AgentCli, options: AgentCliCatalogOption[] = agentCliOptions): AgentCli =>
      resolveAvailableAgentCli(cli, options, options[0]?.value ?? cli),
    [agentCliOptions],
  )

  // The engine CLI bound to a selection: the app-wide remembered CLI, or the
  // engine this surface was opened on — a pick that happened somewhere else and
  // was deliberately not stored. A chat agent resolves within the CLIs that
  // have a chat runtime, so a remembered CLI without one lands on the first
  // that does rather than on a chat nothing can run.
  const cliForSelection = React.useCallback(
    (target: AgentComposerSelection): AgentCli => {
      const options = optionsFor(target)
      if (openingEngine) return resolvePickerCli(openingEngine.cli, options)
      return resolvePickerCli(lastSelectedCli, options)
    },
    [resolvePickerCli, lastSelectedCli, openingEngine, optionsFor],
  )
  const selectionCli = cliForSelection(selection)

  const modelForSelection = React.useCallback(
    (target: AgentComposerSelection, cli: AgentCli): string | undefined => {
      if (target.kind === 'terminal') return undefined
      // The opening engine answers for ITS OWN runtime only, exactly as a
      // stored pair does: a model chosen for one CLI must never surface on
      // another.
      if (openingEngine && resolvePickerCli(openingEngine.cli) === cli) return openingEngine.model ?? undefined
      return resolveSurfaceModel(cli, lastSelectedAgentModel ?? undefined)
    },
    [lastSelectedAgentModel, openingEngine, resolvePickerCli],
  )

  // Display names for a selection's remembered engine. Resolved from the
  // TARGET's engine, so a caller naming one row never picks up another row's.
  const engineNamesFor = React.useCallback(
    (target: AgentComposerSelection): EngineNames => {
      const cli = cliForSelection(target)
      return engineNames(optionsFor(target), cli, modelForSelection(target, cli))
    },
    [cliForSelection, optionsFor, modelForSelection],
  )

  // Keep the selection pointed at a row the roster still offers: a roster that
  // drops the current pick moves selection to its first row, so Enter always
  // has a target.
  React.useEffect(() => {
    if (allRows.length === 0) return
    if (!allRows.some((row) => rowMatchesSelection(row, selection))) {
      setSelection(selectionForRow(allRows[0]))
    }
  }, [allRows, selection])

  // Effort reads through the same per-surface selection the model does, guarded
  // per-CLI by resolveCliReasoning so a level chosen for one CLI never surfaces
  // on another.
  const reasoningForSelection = React.useCallback(
    (target: AgentComposerSelection, cli: AgentCli): string | undefined => {
      if (target.kind === 'terminal') return undefined
      if (openingEngine && resolvePickerCli(openingEngine.cli) === cli) return openingEngine.reasoning ?? undefined
      return resolveCliReasoning(cli, lastSelectedAgentModel ?? undefined)
    },
    [lastSelectedAgentModel, openingEngine, resolvePickerCli],
  )

  // The confirm names the runtime the surface is standing on. `engine` is the
  // same-event override for a click that picks a row and launches in one
  // gesture. Without it the confirm still carries the resolved model and
  // effort — a spawn that omitted them used to re-read the remembered
  // defaults, and a write and a read in the same turn can miss, so Codex
  // launched its own default (Astra) instead of the chip the person chose.
  // `null` is the CLI's own default (no `--model` / no effort flag).
  const buildConfirm = React.useCallback(
    (target: AgentComposerSelection, engine?: { cli: AgentCli; model: string | null }): AgentComposerConfirm => {
      const picked = skills.length > 0 ? { skills } : {}
      // A worktree is where the agent works, terminal or chat: the chat starts
      // in it the way a terminal agent does. A plain shell has none.
      const worktree = worktreeName !== null ? { worktree: { name: worktreeName } } : {}
      // MCP servers reach CLI agents through their workspace config, so only
      // the General confirm carries the picks.
      const servers = mcpServers.length > 0 ? { mcpServers } : {}
      if (target.kind === 'terminal') return { kind: 'terminal' }
      const cli = engine?.cli ?? cliForSelection(target)
      const model = engine ? engine.model : (modelForSelection(target, cli) ?? null)
      const reasoning = reasoningForSelection(target, cli) ?? null
      // A chat carries the same engine and worktree a terminal launch would,
      // and reads MCP servers from the workspace config it runs in, as the CLI
      // does.
      if (target.kind === 'conversation') return { kind: 'conversation', cli, model, reasoning, ...picked, ...worktree }
      return { kind: 'general', cli, model, reasoning, ...picked, ...worktree, ...servers }
    },
    [cliForSelection, modelForSelection, reasoningForSelection, skills, worktreeName, mcpServers],
  )

  // Engine persistence. `appSettings.lastSelectedCli` is what every surface
  // without a CLI of its own falls back to: an automation whose runtime is
  // unset, the review guide, a module asking for the default CLI, and an
  // `agent_launch` over MCP that names none. A pick here is what writes it.
  const setEngineCli = React.useCallback(
    (_target: AgentComposerSelection, cli: AgentCli) => {
      setLastSelectedCli(cli)
      setOpeningEngine(null)
    },
    [setLastSelectedCli],
  )
  const setEngineModel = React.useCallback(
    (_target: AgentComposerSelection, cli: AgentCli, model: string | null) => {
      // A null model is the CLI's own default model, not "forget this CLI", so
      // it is written as an empty model rather than a cleared selection — the
      // setter then keeps a reasoning-effort level already chosen for this CLI.
      setLastSelectedAgentModel({ cli, model: model ?? '' })
      setOpeningEngine(null)
      // Picking a model picks its CLI, so it moves the app-wide default on the
      // same terms the CLI picker does.
      setLastSelectedCli(cli)
    },
    [setLastSelectedAgentModel, setLastSelectedCli],
  )
  // `null` clears the level back to the CLI's own default effort. The setter
  // keeps the model already chosen for that CLI, so clearing effort never
  // silently changes which model launches.
  const setEngineReasoning = React.useCallback(
    (_target: AgentComposerSelection, cli: AgentCli, reasoning: string | null) => {
      setLastSelectedCli(cli)
      setLastSelectedAgentReasoning(cli, reasoning)
      // Effort is an axis OF the opening engine, not a replacement for it: a
      // level chosen here moves that level and leaves the parked model standing,
      // where picking a row retires the whole thing.
      setOpeningEngine((held) => (held && resolvePickerCli(held.cli) === cli ? { ...held, reasoning } : held))
    },
    [setLastSelectedCli, setLastSelectedAgentReasoning, resolvePickerCli],
  )

  return {
    skills,
    setSkills,
    worktreeName,
    setWorktreeName,
    mcpServers,
    setMcpServers,
    visibleRows: allRows,
    selection,
    setSelection,
    selectionCli,
    cliForSelection,
    modelForSelection,
    engineNamesFor,
    reasoningForSelection,
    buildConfirm,
    setEngineCli,
    setEngineModel,
    setEngineReasoning,
    // The engine this surface opened on and has not been overruled on yet, so a
    // host parking its state can park that too rather than lose it.
    openingEngine,
    agentCliOptions,
    // The CLIs a chat agent can run on, for the picker's rail while Chat agent
    // is chosen (see `optionsFor`).
    chatCliOptions,
    optionsFor,
    // True when this machine has no agent CLI installed: the surfaces render
    // the install route in place of the agent rows the hook withheld.
    noAgentCliInstalled,
    // Catalog load state, so pickers can say "loading" / "no plugins" instead
    // of rendering a silently thin roster.
    catalogStatus: pluginCatalogStatus,
    catalogError: pluginCatalogError,
  }
}
