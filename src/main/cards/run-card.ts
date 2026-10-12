// What `Go` does. One press on a card on the Extensions home runs the card's
// ordered actions and the person lands in a chat that is already working
// (backlog/2026-09-06-go-runs-a-cards-actions.md, item 2469).
//
// **Go goes** (owner ruling R4, 2026-09-06). There is no consent screen here,
// no plan, no progress modal and no "are you sure": the card said what it was,
// the person pressed the button that said Go, and `open.chat` carries `send`
// because an unstated send would leave the reader guessing. So this module is
// deliberately quiet — it returns what happened, and the surface says it in a
// toast if anything went wrong.
//
// **It composes; it never re-implements.** Every install goes through the
// module that already owns that concern and already records provenance:
// `mcpConfigService` for a catalogue server, `skills/install.ts` (through the
// skills service) for a skill, `skills/install-plugin.ts` for a plugin,
// the marketplace plugin lifecycle for a module, `git-clone.ts` for a clone. Nothing here writes a file and nothing here
// spawns a process — the acceptance criterion is that no shell command is
// spawned *by this file*, and the way that is kept true is that this file has
// no `child_process` import and no `fs` write in it at all. What the installers
// it calls do inside themselves is their own contract, tested in their own
// suites.
//
// **Actions run in order, and the first failure stops the rest.** There is no
// `Promise.all` anywhere below, on purpose: a card that installs a server and
// then opens a chat against it has an ordering the person can see, and racing
// the two would open a chat against a server that is not there yet. Everything
// after a failure is reported as `skipped`, so the toast can say what did not
// run rather than only what broke.
//
// **An already-satisfied action is a no-op, not an error.** Pressing Go twice
// must not install twice: a server already in the settings, a skill directory
// already carrying this source's provenance marker, a plugin already in the
// install receipts, a CLI already on the machine and a clone target that is
// already a directory all report `already` and the run carries on. That is what
// makes the second press land the person in the chat again instead of in a
// toast about a duplicate.
//
// **Workspace scope is the app's, never the card's.** No `CardAction` carries a
// workspace, by design (`src/shared/hosted-card-feed.ts`): a card that could
// name one could reach into a project the person was not looking at. The
// executor is handed the workspace the person is in, and `clone.repo` is the
// one verb that makes a new one — everything after it in the same card runs in
// that clone, which is why `workspaceRoot` below is a `let` that only
// `clone.repo` reassigns and why the result hands the final value back.
//
// **Nothing a feed says is trusted as a path, a URL or an argument.** Every id
// is resolved against something this app already holds before it is used: a CLI
// against the registered agent-CLI plugin ids, an MCP server against the
// workspace's own installed MCP settings, a skill and a plugin against that
// source's own scan, a module against the app's own signed marketplace
// registry, and a
// repository against the `owner/name` shape re-checked here rather than taken
// on the parser's word. `clone.repo`'s URL is built from a fixed
// `https://github.com/` prefix and the two validated segments, so a card names
// a repository and can never name a host. The whole of what a card contributes
// to a filesystem path is one already-single-segment folder name, re-checked
// below and joined onto a parent directory the app chose.
//
// That sentence shipped on 2026-09-06 as an unqualified claim and it was not
// true, in two places, both closed here:
//
//  - **The prompt IS an argument.** `open.chat`'s prompt travels through
//    `cliStartupPrompt` to `renderAgentLaunchArgv` and comes out as the
//    `{{prompt}}` positional — the last argv token, with no `--` in front of
//    it. The shell never saw it unquoted, so nothing could be injected into a
//    command line; the CLI's own option parser is another matter, and a card
//    carrying `"prompt": "--permission-mode=bypassPermissions"` was accepted by
//    the parser and handed to `claude` as a flag. A prompt beginning with `-`
//    is now refused by the shared parser AND again in `openChat` below: the
//    parser keeps such a card out of the feed, and this file is the boundary
//    the value crosses last, so neither is allowed to be the only check.
//  - **An existing directory is not proof of a clone.** `clone.repo` adopted
//    any directory that already existed at its target path as the run's
//    workspace — and the parent directory is the parent of the person's own
//    projects, so a card naming `x/my-other-project` silently installed into
//    the project beside it and scoped the chat there. A directory is now only
//    "already there" when its `origin` remote is the repository the card named;
//    anything else fails the action by name rather than borrowing the folder.

//
// **`open.chat` and `open.surface` are not run here.** Main cannot open a chat
// or move a door; the renderer can. Both verbs are validated in the same switch
// as the rest and returned as a hand-off for the surface to perform once every
// install before them has succeeded. That is also why `open.chat` must be the
// last action or the card is refused outright: a chat attached to a server that
// failed to install is worse than no chat.
//
// **The chosen model row passes straight through** (owner ruling R4b,
// 2026-09-06, item 2473). Since Go opens the model picker and choosing a row is
// what starts the run, the request carries that row's model, reasoning effort
// and permission preset. This file reads none of them — they mean something to
// a launcher and nothing to an installer — and hands all three back on the chat
// hand-off, beside the cli a `require.cli` verified, so that one object on the
// far side describes the whole launch rather than half of it.

import type {
  CardActionOutcome,
  CardActionStatus,
  CardChatHandoff,
  CardRunInput,
  CardRunResult,
  CardSurfaceHandoff,
  RepositoryCloneResult,
  MarketplacePluginRegistryInstallResult,
  MarketplaceRegistryReadResult,
  McpServerConfig,
  McpSettings,
  McpSyncResult,
  SkillInstallOutcome,
  SkillInstalledPluginsOutcome,
  SkillPluginInstallOutcome,
  SkillScanOutcome,
} from '../../shared/electron-api'
import type { MarketplacePluginEntry } from '../../shared/marketplace'
import type { MarketplacePluginLifecycleInstallInput } from '../marketplace/plugin-lifecycle'
import type { CardAction, CardSurfaceView } from '../../shared/hosted-card-feed'
import { refuseCardActions } from '../../shared/hosted-card-feed'
import { scanPlugins, skillDirName } from '../../shared/skills'

/**
 * The whole-card rules — one chat and it goes last, a clone before any install,
 * a chat that only names servers the card installs — now live in the shared
 * parser beside the schema they are about, so a card that can never succeed is
 * dropped from the feed rather than rendered with a `Go` that cannot work. This
 * file calls the same function again because the action list has been to the
 * renderer and back since; re-exported under the name the executor's callers
 * already use.
 */
export { refuseCardActions as refuseCard } from '../../shared/hosted-card-feed'

/**
 * The installers the executor composes, injected so the test can watch the
 * order and stand in for machines it does not have. Production binds every one
 * of these to the real service in `src/main/ipc/cards-ipc.ts`.
 */
export type CardRunDeps = {
  /** `mcpConfigService.sync()` — writes the merged settings into every CLI's config. */
  syncMcp: (input: { workspaceRoot: string; settings: McpSettings }) => McpSyncResult | Promise<McpSyncResult>
  /** `skillsService.getScan()` — how a source id resolves to what that source holds. */
  getSkillScan: (input: { sourceId: string }) => Promise<SkillScanOutcome>
  /** `skillsService.install()`. */
  installSkill: (input: { sourceId: string; skillId: string; workspaceRoot: string }) => Promise<SkillInstallOutcome>
  /**
   * `skillsService.installPlugin()`. `marketplaceName`, `marketplaceRepo` and
   * `commitSha` are resolved from the scan inside it, at run time, which is why
   * the card carries none of them: a commitSha on a card goes stale the moment
   * the marketplace is republished, and a stale one installs the wrong bytes.
   */
  installPlugin: (input: {
    sourceId: string
    pluginId: string
    workspaceRoot: string
  }) => Promise<SkillPluginInstallOutcome>
  /** `skillsService.listInstalledPlugins()` — the receipts that make a second Go a no-op. */
  listInstalledPlugins: (input: { workspaceRoot: string }) => Promise<SkillInstalledPluginsOutcome>
  /** `skills/sync.ts` `installedSkillCopies()`, keyed by directory name. */
  installedSkillCopies: (workspaceRoot: string) => Promise<Map<string, readonly { sourceId: string }[]>>
  /** The plugin ids of the agent CLIs this build registers — the only legal `require.cli` values. */
  listAgentCliIds: () => string[] | Promise<string[]>
  /** The CLI availability probe (`cli-availability.ts`). */
  detectCli: (cli: string) => Promise<{ installed: boolean }>
  /** `git-clone.ts` `cloneRepository()`, with the token already resolved on the main side. */
  cloneRepo: (input: { url: string; parentDir: string; folderName: string }) => Promise<RepositoryCloneResult>
  /** Whether a path is already there. Only used to make a repeated clone a no-op. */
  pathExists: (path: string) => boolean | Promise<boolean>
  /**
   * The `owner/name` this directory's `origin` remote points at, or null when
   * there is no origin, it is not GitHub, or the directory is not a repository
   * at all. This is the whole of what makes a repeated `clone.repo` safe: an
   * existing directory is only the card's clone if it IS the card's repository,
   * and everything else is somebody else's project sitting at the same path.
   */
  repoOriginName: (dir: string) => Promise<string | null>
  /** `path.join`, injected so the test can assert the join without a platform in it. */
  joinPath: (...segments: string[]) => string
  /**
   * The app's own signed marketplace registry — what `install.module` resolves
   * an id against. One registry, shipped with the app; a card names an entry in
   * it and can never name where this machine's code comes from.
   */
  readMarketplaceRegistry: () => Promise<MarketplaceRegistryReadResult>
  /**
   * The marketplace install receipts, which are what make a second Go a no-op
   * for a module the way `listInstalledPlugins` does for a plugin.
   */
  listMarketplaceReceipts: () => Promise<
    { ok: true; receipts: ReadonlyArray<{ id: string }> } | { ok: false; message: string }
  >
  /**
   * `marketplacePluginLifecycle.install()` — the one install path. Called with
   * the registry's own entry and no trust grant, so only an entry that needs no
   * approval installs.
   */
  installMarketplaceEntry: (
    input: MarketplacePluginLifecycleInstallInput,
  ) => Promise<MarketplacePluginRegistryInstallResult>
}

/**
 * The trust tier a registry entry declares about itself, read the same way the
 * storefront's `pluginTrust` reads it. Only `verified` — signed by a publisher
 * listed in `trusted-publishers.json` — installs from a card: everything else
 * ends in a trust prompt, and a prompt is a disclosure a person reads and
 * answers, not something a hosted feed may answer on their behalf.
 */
function marketplaceEntryTier(entry: MarketplacePluginEntry): 'verified' | 'community' | 'unsigned' | 'inline' {
  if (entry.mcp) return 'inline'
  if (!entry.signature) return 'unsigned'
  return entry.publisher.verified ? 'verified' : 'community'
}

/** `owner/name` and nothing else, re-checked here rather than taken on the parser's word. */
const REPO_NAME = /^[A-Za-z0-9._-]+\/[A-Za-z0-9._-]+$/

const SURFACE_VIEWS: readonly CardSurfaceView[] = ['home', 'plugins', 'skills', 'agent-clis']

export async function runCard(input: CardRunInput, deps: CardRunDeps): Promise<CardRunResult> {
  const actions = [...input.actions]
  const outcomes: CardActionOutcome[] = actions.map((action, index) => ({
    index,
    verb: action.verb,
    status: 'skipped' as CardActionStatus,
    message: 'Did not run.',
  }))

  const refusal = refuseCardActions(actions)
  if (refusal) {
    return {
      ok: false,
      outcomes,
      workspaceRoot: input.workspaceRoot,
      mcpServers: [],
      chat: null,
      surface: null,
      message: refusal,
    }
  }

  // The one mutable piece of scope in this file, and only `clone.repo` moves
  // it: everything after a clone in the same card runs in that clone.
  let workspaceRoot = input.workspaceRoot
  // The settings as this run has them so far. Started from what the renderer
  // sent, added to by `install.mcp` and by the servers a plugin declares, and
  // synced from as a whole, because a sync writes the merged settings and a
  // partial one would prune every server it was not told about.
  let servers: Record<string, McpServerConfig> = {}
  for (const server of input.mcpServers) servers[server.id] = server
  // The servers this run ADDED, and only those. The store is handed these
  // rather than the whole merged map: `upsertMcpServer` turns MCP sync back on
  // for every server it is given, and doing that to servers the person already
  // had — because a card added a different one — would undo a setting they
  // chose (settingsSlice.ts says exactly this about `refreshMcpServersFromSource`).
  const added: Record<string, McpServerConfig> = {}
  // The app's own MCP sync switch, carried in rather than assumed. It flips to
  // true only when this run adds a server, because that is what the store will
  // do with that same server a moment later — adding one IS the person saying
  // "wire this up". A run that adds nothing syncs under the setting as it
  // stands, so a person who turned sync off keeps it off.
  let syncEnabled = input.mcpSyncEnabled

  // The CLI a `require.cli` in this card verified, handed back so the chat
  // launches on the SAME one. It did not, until 2026-09-06: `require.cli`
  // checked `claude-code` and the renderer then launched on whatever
  // `resolveTemplateAgentCli` returned, which could be a different harness —
  // one the skill this card just installed was never copied into.
  let requiredCli: string | null = null
  let chat: CardChatHandoff | null = null
  let surface: CardSurfaceHandoff | null = null
  let failure: string | null = null

  for (const [index, action] of actions.entries()) {
    const step = await runAction(action)
    outcomes[index] = { index, verb: action.verb, ...step }
    if (step.status === 'failed') {
      failure = step.message
      break
    }
  }

  return {
    ok: failure === null,
    outcomes,
    workspaceRoot,
    mcpServers: Object.values(added),
    chat: failure === null ? chat : null,
    surface: failure === null ? surface : null,
    ...(failure === null ? {} : { message: failure }),
  }

  /**
   * One action. The switch is CLOSED: every arm returns, and there is no
   * `default` — `exhausted()` below takes a `never`, so adding a verb to the
   * shared union without an arm here is a compile error rather than a runtime
   * surprise.
   */
  async function runAction(action: CardAction): Promise<Omit<CardActionOutcome, 'index' | 'verb'>> {
    switch (action.verb) {
      case 'require.cli':
        return requireCli(action)
      case 'install.mcp':
        return installMcp(action)
      case 'install.module':
        return installModule(action)
      case 'install.skill':
        return installSkill(action)
      case 'install.plugin':
        return installPlugin(action)
      case 'open.chat':
        return openChat(action)
      case 'open.surface':
        return openSurface(action)
      case 'clone.repo':
        return cloneRepo(action)
    }
    return exhausted(action)
  }

  async function requireCli(
    action: Extract<CardAction, { verb: 'require.cli' }>,
  ): Promise<Omit<CardActionOutcome, 'index' | 'verb'>> {
    // The id is resolved against the plugin ids this build registers before it
    // is passed anywhere: a `cli` is a plugin id under `resources/plugins/`,
    // never a vendor name and never a binary path, and a value that is not one
    // of them never reaches the probe.
    const known = await deps.listAgentCliIds()
    if (!known.includes(action.cli)) {
      return { status: 'failed', message: `${action.cli} is not an agent CLI this build knows.` }
    }
    const detected = await deps.detectCli(action.cli)
    if (detected.installed) {
      requiredCli = action.cli
      return { status: 'already', message: `${action.cli} is already installed.` }
    }
    // Deliberately a refusal and not an install. Installing a CLI runs a shell
    // command on the person's machine, and `CliInstallMethodInfo` says in its
    // own type why that command is shown first: it is "surfaced to the UI for
    // transparency before the user consents to run it". R4 removes the consent
    // screen the CARD would otherwise need; it does not repeal a gate another
    // module states in its own contract, and picking an install method on
    // somebody's behalf from a hosted feed is exactly the thing that gate is
    // there to stop. So Go says which CLI is missing and where to get it.
    //
    // And where it names is **Settings → Agents** (decided 2026-09-06,
    // backlog/2026-09-06-the-seams-that-lead-nowhere.md §3). The
    // single-destination rule is that every "there is no agent CLI here" state
    // ends in one place, and `cliInstallRoute.tsx` is that place — the empty
    // launcher, the agent pickers, and the CLI install row in the card's own Go
    // picker all open Settings → Agents. This message is the backstop behind
    // that same picker, so naming a second door would mean the row a person just
    // clicked and the sentence they get if they press on anyway disagree about
    // where CLIs come from. Since 2026-09-25 it is also the only place agent
    // CLIs are listed at all: the Extensions door's Agent CLIs view is gone.
    return {
      status: 'failed',
      message: `${action.cli} is not installed. Install it from Settings → Agents, then press Go again.`,
    }
  }

  async function installMcp(
    action: Extract<CardAction, { verb: 'install.mcp' }>,
  ): Promise<Omit<CardActionOutcome, 'index' | 'verb'>> {
    if (!workspaceRoot) return { status: 'failed', message: noWorkspace('an MCP server') }
    // The settings row and the sync are two different facts, and conflating
    // them was a bug: the row lives in the app's settings (one list, all
    // projects) while the sync writes `{{workspaceRoot}}/.mcp.json` (one
    // project). Until 2026-09-06 this returned `already` on the row alone and
    // skipped the sync — so a person who installed Playwright in project A,
    // opened project B and pressed Go got `already`, no `.mcp.json`, and a chat
    // with no tools and no message. It bit hardest right after a `clone.repo`,
    // since a fresh clone has never been synced to anything.
    //
    // So the row is what makes this a no-op, and the sync runs either way: the
    // question a person is asking with a second press is "does THIS project
    // have it", and running the sync is what makes the answer yes. A sync of
    // settings that already hold the server rewrites the same bytes, so the
    // repeat costs a file write and changes nothing.
    const existing = servers[action.id]
    // The bundled MCP catalogue is gone (2026-09-08): it listed
    // sixteen servers nobody here wrote, and the studio stopped shipping other
    // people's software. There is no longer any list this build can turn a bare
    // catalogue id into a server config from — an MCP server now arrives inside
    // a plugin, which `install.plugin` installs and whose own `.mcp.json` the
    // install writes. A card that already has the server in this workspace's
    // settings is still honoured, because that is a server the person installed.
    if (!existing) {
      return {
        status: 'failed',
        message: `${action.id} is not a server this build can install. MCP servers arrive inside plugins now.`,
      }
    }
    const next = { ...servers, [existing.id]: existing }
    const synced = await deps.syncMcp({ workspaceRoot, settings: { syncEnabled, servers: next } })
    if (!synced.ok) return { status: 'failed', message: synced.message }
    servers = next
    return { status: 'already', message: `${existing.name} was already installed, and this project now has it.` }
  }

  async function installSkill(
    action: Extract<CardAction, { verb: 'install.skill' }>,
  ): Promise<Omit<CardActionOutcome, 'index' | 'verb'>> {
    if (!workspaceRoot) return { status: 'failed', message: noWorkspace('a skill') }
    // The source has to be one the app already holds: `getScan` answers from
    // the source store, so an id nobody added resolves to nothing and the
    // install is never attempted.
    const scan = await deps.getSkillScan({ sourceId: action.source })
    if (!scan.ok) return { status: 'failed', message: scan.message }
    const skill = scan.scan.skills.find((candidate) => candidate.id === action.id)
    if (!skill) return { status: 'failed', message: `${action.id} is not in ${action.source}.` }
    const dirName = skillDirName(skill.id)
    const copies = await deps.installedSkillCopies(workspaceRoot)
    if ((copies.get(dirName) ?? []).some((copy) => copy.sourceId === action.source)) {
      return { status: 'already', message: `${skill.name} is already installed.` }
    }
    const installed = await deps.installSkill({
      sourceId: action.source,
      skillId: skill.id,
      workspaceRoot,
    })
    if (!installed.ok) return { status: 'failed', message: installed.message }
    return { status: 'done', message: `${skill.name} installed.` }
  }

  async function installPlugin(
    action: Extract<CardAction, { verb: 'install.plugin' }>,
  ): Promise<Omit<CardActionOutcome, 'index' | 'verb'>> {
    if (!workspaceRoot) return { status: 'failed', message: noWorkspace('a plugin') }
    const receipts = await deps.listInstalledPlugins({ workspaceRoot })
    if (receipts.ok && receipts.plugins.some((row) => row.sourceId === action.source && row.pluginId === action.id)) {
      return { status: 'already', message: `${action.id} is already installed.` }
    }
    const scan = await deps.getSkillScan({ sourceId: action.source })
    if (!scan.ok) return { status: 'failed', message: scan.message }
    const plugin = scanPlugins(scan.scan).find((candidate) => candidate.id === action.id)
    if (!plugin) return { status: 'failed', message: `${action.id} is not in ${action.source}.` }
    // `acknowledgedHooks` is not passed, and never will be from here. A plugin
    // that declares hooks runs shell commands on this machine, and the skills
    // service refuses one until a person has seen them. R4 is about the card's
    // own ceremony; it does not hand a hosted feed the answer to somebody
    // else's disclosure.
    const installed = await deps.installPlugin({
      sourceId: action.source,
      pluginId: plugin.id,
      workspaceRoot,
    })
    if (!installed.ok) {
      return {
        status: 'failed',
        message: installed.needsHookAcknowledgement
          ? `${plugin.name} runs hook commands, so it installs from Extensions → Plugins where you can read them first.`
          : installed.message,
      }
    }
    // The servers a plugin declares are shaped for the settings store and go
    // back the same way `install.mcp`'s do — through one sync, so the CLI
    // configs and the store agree.
    if (installed.mcpServers.length > 0) {
      const next = { ...servers }
      const fresh: McpServerConfig[] = []
      for (const server of installed.mcpServers) {
        if (!servers[server.id]) fresh.push(server)
        next[server.id] = server
      }
      if (fresh.length > 0) syncEnabled = true
      const synced = await deps.syncMcp({ workspaceRoot, settings: { syncEnabled, servers: next } })
      if (!synced.ok) return { status: 'failed', message: synced.message }
      servers = next
      for (const server of fresh) added[server.id] = server
    }
    return { status: 'done', message: `${plugin.name} installed.` }
  }

  async function installModule(
    action: Extract<CardAction, { verb: 'install.module' }>,
  ): Promise<Omit<CardActionOutcome, 'index' | 'verb'>> {
    // Resolved against the registry this build reads before anything is
    // downloaded — the same rule every other id in this file follows.
    const registry = await deps.readMarketplaceRegistry()
    if (!registry.ok) {
      return {
        status: 'failed',
        message: registry.message || 'The marketplace could not be read, so nothing was installed.',
      }
    }
    const entry = registry.marketplace.plugins.find((plugin) => plugin.id === action.id)
    if (!entry) return { status: 'failed', message: `${action.id} is not in this build's marketplace.` }
    if (!entry.provides.includes('module')) {
      return { status: 'failed', message: `${entry.name} is not a module, so install.module cannot install it.` }
    }

    // A receipt for this entry is what makes a second Go a no-op, exactly as
    // the plugin receipts do — and it is checked BEFORE the tier, so pressing
    // Go again on an installed module lands the person in the rest of the card
    // rather than in a refusal about trust.
    const receipts = await deps.listMarketplaceReceipts()
    if (receipts.ok && receipts.receipts.some((receipt) => receipt.id === entry.id)) {
      return { status: 'already', message: `${entry.name} is already installed.` }
    }

    const tier = marketplaceEntryTier(entry)
    if (tier !== 'verified') {
      // Named rather than silently skipped, and pointing at the one surface
      // that can show the disclosure this install needs.
      return {
        status: 'failed',
        message: `${entry.name} asks you to trust it before it installs. Add it from Extensions → Plugins, where you can read what it wants first.`,
      }
    }

    // No trust grant: a verified entry never asks for one, and only a prompt
    // the person answered can issue one — this file cannot answer on their
    // behalf. The workspace
    // is the app's, as everywhere else here — a module bundle does not need
    // one, and a bundle that also carries an mcp/skills component says so
    // itself if there is none.
    const installed = await deps.installMarketplaceEntry({
      entry,
      ...(workspaceRoot ? { workspaceRoot } : {}),
    })
    if (!installed.ok) {
      return { status: 'failed', message: installed.message || `${entry.name} could not be installed.` }
    }
    return {
      status: 'done',
      // A module's code loads at app launch, so the outcome says what is left
      // to do rather than implying the door is already there.
      message: installed.restartRequired
        ? `${entry.name} installed. Restart SprintEngine Studio to use it.`
        : `${entry.name} installed.`,
    }
  }

  function openChat(action: Extract<CardAction, { verb: 'open.chat' }>): Omit<CardActionOutcome, 'index' | 'verb'> {
    const prompt = action.prompt.trim()
    if (prompt.length === 0) return { status: 'failed', message: 'This card has no prompt to send.' }
    // The executor boundary for the argv hole described at the top of this
    // file. The shared parser refuses a leading `-` too, and deliberately so:
    // this value has been to the renderer and back since that parse, and the
    // next thing that happens to it is that it becomes the last token on an
    // agent CLI's command line with no `--` in front of it. Neither check is
    // allowed to be the only one.
    if (prompt.startsWith('-')) {
      return {
        status: 'failed',
        message:
          'This card’s prompt begins with a dash, which an agent CLI would read as an option, so it was not sent.',
      }
    }
    // Names, not paths: `skills` are installed skill directory names, and the
    // renderer attaches them by matching what the workspace already has —
    // nothing is joined onto anything here or there, which is why a name this
    // build does not recognise is a chat with one fewer chip rather than a
    // refusal.
    //
    // `mcpServers` is not carried across. The card's servers reach the chat by
    // being in the `{{workspaceRoot}}/.mcp.json` that `install.mcp` wrote on
    // the way past, so there is nothing left to hand over; and a card may only
    // name a server it installs itself (`refuseCardActions`), which is what
    // makes that true rather than accidental. The field the first cut of this
    // hand-off carried was read by nothing on either renderer path.
    chat = {
      prompt,
      send: action.send,
      skills: [...(action.skills ?? [])],
      // The CLI the card required, so the chat opens on the harness the skills
      // were installed into; null when the card required none and the row the
      // person picked in the picker stands.
      cli: requiredCli,
      // The rest of that row, handed straight back (item 2473). This file does
      // not read them and must not: a model id, an effort level and a
      // permission preset mean something to a launcher and nothing to an
      // installer, and the executor's whole job is the installs. They travel
      // through it so that ONE object on the far side says what is about to be
      // launched — the cli above came from `require.cli` and the three below
      // came from the picker, and splitting them across two sources is how the
      // pair drifts.
      model: input.model ?? null,
      reasoning: input.reasoning ?? null,
      permissionPreset: input.permissionPreset ?? null,
    }
    return { status: 'done', message: action.send ? 'Chat opened, prompt sent.' : 'Chat opened.' }
  }

  function openSurface(
    action: Extract<CardAction, { verb: 'open.surface' }>,
  ): Omit<CardActionOutcome, 'index' | 'verb'> {
    // Re-checked against the same four views the shared parser knows, because
    // this value ends up selecting a door and a value from outside that set
    // would open nothing at all.
    if (!SURFACE_VIEWS.includes(action.view)) {
      return { status: 'failed', message: `${action.view} is not a view this build knows.` }
    }
    surface = { view: action.view, installed: action.installed === true }
    return { status: 'done', message: `Opened ${action.view}.` }
  }

  async function cloneRepo(
    action: Extract<CardAction, { verb: 'clone.repo' }>,
  ): Promise<Omit<CardActionOutcome, 'index' | 'verb'>> {
    // The parser already applied this rule; it is applied again here because
    // the value crossed a process boundary in between and this is the last
    // place before it becomes a path and a URL.
    const repo = action.repo.trim()
    if (!REPO_NAME.test(repo) || repo.split('/').some((segment) => segment === '.' || segment === '..')) {
      return { status: 'failed', message: `${action.repo} is not a repository name.` }
    }
    const [, repoName = ''] = repo.split('/')
    const folderName = (action.folderName ?? repoName).trim()
    if (
      folderName.length === 0 ||
      folderName === '.' ||
      folderName === '..' ||
      /[/\\]/.test(folderName) ||
      folderName.includes('\0')
    ) {
      return { status: 'failed', message: 'That card asks to clone into a folder name this app will not use.' }
    }
    const parentDir = input.cloneParentDir?.trim() ?? ''
    if (parentDir.length === 0) {
      return { status: 'failed', message: 'There is nowhere to clone into yet — open a project first.' }
    }
    const target = deps.joinPath(parentDir, folderName)
    // A second Go finds the clone it made the first time and adopts it as the
    // workspace rather than failing on an occupied path — but ONLY if it is
    // genuinely that repository. `parentDir` is the parent of the person's own
    // projects and the folder name defaults to the repository's leaf, so until
    // 2026-09-06 a card naming `x/my-other-project` adopted the project sitting
    // beside the open one: it installed into it, scoped the chat to it, and
    // overrode `cloneRepository`'s own refusal on an occupied path. The schema
    // says a card cannot reach into a project the person was not looking at;
    // this is what makes that sentence true.
    if (await deps.pathExists(target)) {
      const origin = await deps.repoOriginName(target)
      if (origin?.toLowerCase() !== repo.toLowerCase()) {
        return {
          status: 'failed',
          message: `${folderName} is already a folder here and it is not ${repo}, so nothing was cloned or opened.`,
        }
      }
      workspaceRoot = target
      return { status: 'already', message: `${folderName} is already here.` }
    }
    // The URL is built, never carried. A card names `owner/name`; the host is
    // this line.
    const cloned = await deps.cloneRepo({
      url: `https://github.com/${repo}.git`,
      parentDir,
      folderName,
    })
    if (!cloned.ok) return { status: 'failed', message: cloned.message }
    // Everything after this in the same card runs in the clone.
    workspaceRoot = cloned.path
    return { status: 'done', message: `Cloned ${repo}.` }
  }
}

function noWorkspace(what: string): string {
  return `Open a project first — ${what} installs into a project, not into the app.`
}

/**
 * The closed end of the switch. It takes `never`, so a verb added to
 * `CardAction` without an arm above fails to compile here; it still throws at
 * runtime because a build that got past the type check has been fed something
 * the type says cannot exist.
 */
function exhausted(action: never): never {
  throw new Error(`Unhandled card action: ${JSON.stringify(action)}`)
}
