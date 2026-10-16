// Installing a plugin into a workspace (backlog/2026-09-05-plugin-sources.md,
// "What install means, per kind and per harness"), corrected by
// backlog/2026-09-06-a-github-marketplace-plugin-installs-nothing-for-claude-code.md.
//
// A plugin is a catalogue. `skillIds` / `mcpServerIds` pick the items this
// call copies; omitting both is the remaining all-in path (a single-skill
// plugin with nothing else to choose). Every harness is served the same way:
// what this app can copy, it copies.
//
//  1. **The chosen skills are copied.** Through the existing skill installer, into
//     every harness's skill directory, each copy carrying a provenance marker
//     so Sync owns it afterwards. Claude Code included — see below.
//  2. **The chosen MCP servers are handed back.** MCP settings live in the renderer
//     store and sync into each CLI's own config from there (the workspace's
//     `.mcp.json` for Claude Code); the install returns the configs and the
//     surface adds them.
//  3. **The plugin's own directory is copied when a chosen server needs it.** A
//     server declared as `bun run --cwd ${CLAUDE_PLUGIN_ROOT} … start` cannot
//     start unless those files are on disk and that variable means something,
//     and only Claude Code's own loader sets it. So the plugin root lands under
//     `claude-plugins/<id>` in the workspace's store and the variable is resolved to where it
//     landed (plugin-directory.ts, shared/mcp/plugin-root.ts). A plugin whose
//     servers name no such directory copies nothing extra.
//  4. **Commands, agents, hooks and language servers are not installed.** They
//     are Claude Code's own formats and this app has no loader for them; the
//     outcome and the pane say so rather than implying they landed.
//
// Claude Code used to be the exception: a plugin from a GitHub marketplace was
// "enabled natively" by writing `extraKnownMarketplaces` and `enabledPlugins`
// into `<workspace>/.claude/settings.json`, and nothing was copied for it.
// Measured twice, independently, against Claude Code 2.1.263 on 2026-09-06:
// those two keys load NOTHING on their own. A `github` marketplace also needs
// `claude plugin marketplace add` AND `claude plugin install` — two writes to
// another product's user-global state, which this app will not make behind a
// person's back. So the keys stopped being the install (owner ruling,
// 2026-09-06) and became an extra: still written on an all-in install where
// they are harmless, so a person who runs `claude plugin install` themselves
// gets the native load too, and nothing here depends on them. A one-item
// install does not write them — naming the plugin would invite a native load
// of every skill it ships. A settings file that cannot be written is a warning
// beside a completed all-in install, never a failed one.
//
// The settings file is merged, never replaced: only the two keys are touched,
// only the entries this install adds, and uninstall removes only those.

import { mkdir, readFile, rename, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'

import type { McpServerConfig, SkillHarness } from '../../shared/electron-api'
import { pluginNeedsOwnFiles, referencesPluginRoot, resolvePluginRoot } from '../../shared/mcp/plugin-root'
import { mcpServerConfigFromScanned } from '../../shared/mcp/server-from-scanned'
import {
  DEFAULT_SKILL_REPO_HOST,
  describeUnreadPlugin,
  skillRepoCloneUrl,
  splitSkillRepo,
  type ScannedMcpServer,
  type ScannedPlugin,
  type ScannedSkill,
  type SkillFileRef,
} from '../../shared/skills'
import { STUDIO_PLUGIN_ID } from '../../shared/studio-plugin'
import { commandOnPath } from '../command-on-path'
import { installSkill, uninstallSkill, type SkillInstallProvenance } from './install'
import { installPluginDirectory, uninstallPluginDirectory, type PluginDirectoryFile } from './plugin-directory'
import { isRecord } from '../../shared/records'

// The mapping is shared with the renderer's own "Add this server" row, so both
// stamp the same provenance; re-exported here because this module was where it
// lived and the install tests read it from here.
export { mcpServerConfigFromScanned }

export const CLAUDE_SETTINGS_RELATIVE_PATH = '.claude/settings.json'

/** What Claude Code's settings call a plugin: `name@marketplace`. */
export function claudePluginKey(pluginId: string, marketplaceName: string): string {
  return `${pluginId}@${marketplaceName}`
}

type PluginInstallHarnessOutcome = {
  harness: SkillHarness
  /** `skills` — skill directories copied; `nothing` — the plugin has nothing this harness reads. */
  mode: 'skills' | 'nothing'
  skillDirNames: string[]
  message: string
}

export type PluginInstallOptions = {
  workspaceRoot: string
  sourceId: string
  /** '' when the source is not a marketplace, which rules out native enablement. */
  marketplaceName: string
  /** `owner/name` of the source repository, '' for a non-GitHub source. */
  marketplaceRepo: string
  plugin: ScannedPlugin
  /**
   * Install only these skills. Omit both this and `mcpServerIds` to install
   * everything the plugin ships. Passing either field means the other kind is
   * not installed — a plugin is a catalogue, and one press takes one item.
   */
  skillIds?: readonly string[]
  mcpServerIds?: readonly string[]
  harnesses: readonly SkillHarness[]
  /** The commit the plugin's bytes are read at — the source's, or a linked plugin's own. */
  commitSha: string
  readSkillFile: (skill: ScannedSkill, file: SkillFileRef) => Promise<Buffer>
  /**
   * The plugin's own files, relative to the plugin's directory, and how to read
   * them. Required exactly when `pluginNeedsOwnFiles(plugin)` — the caller does
   * the listing because it is a network round trip and this is where it is
   * known whether one is needed at all.
   */
  pluginFiles?: readonly PluginDirectoryFile[]
  readPluginFile?: (file: PluginDirectoryFile) => Promise<Buffer>
  /** Which CLIs the returned MCP configs should target; the renderer may widen it. */
  mcpClients: readonly string[]
  /** Whether a command can be run on this machine; the PATH probe by default. */
  commandExists?: (command: string) => boolean
  /** Test seam. */
  now?: () => Date
}

export type PluginInstallResult =
  | {
      ok: true
      pluginId: string
      harnesses: PluginInstallHarnessOutcome[]
      /** Ready for the MCP settings store; empty when the plugin declares none. */
      mcpServers: McpServerConfig[]
      /**
       * The `name@marketplace` key written into the workspace's Claude
       * settings, or '' when none was (no marketplace, no Claude Code on this
       * machine, or the settings file refused the write). It is a courtesy for
       * `claude plugin install`, and a de-duplicator: `listInstalledPlugins`
       * matches it against the keys the settings enable so a plugin this app
       * installed is not also listed as one somebody enabled by hand. Nothing
       * about what landed on disk depends on it.
       */
      claudePluginKey: string
      /**
       * Where the plugin's own files landed, '' when the plugin needed none.
       * The MCP commands above point into it, and the uninstall receipt keeps
       * its directory name so a Remove can take it back.
       */
      pluginRoot: string
      /** The single path segment under `claude-plugins` in the workspace's store, '' when nothing was copied. */
      pluginDirName: string
      /** Files copied into `pluginRoot`; 0 when nothing was. */
      pluginFileCount: number
      /** Failures that did not stop the install (one skill of several). */
      warnings: string[]
    }
  | { ok: false; message: string }

/**
 * Pick the skills and MCP servers an install should copy. A plugin is a
 * catalogue: one press takes one item, and omitting both lists is the one
 * remaining all-in path (a single-skill plugin with nothing else to choose).
 */
export function selectPluginItems(
  plugin: ScannedPlugin,
  selection: { skillIds?: readonly string[]; mcpServerIds?: readonly string[] },
): { ok: true; plugin: ScannedPlugin; filtered: boolean } | { ok: false; message: string } {
  const skillIds = selection.skillIds
  const mcpServerIds = selection.mcpServerIds
  const filtered = skillIds !== undefined || mcpServerIds !== undefined
  if (!filtered) return { ok: true, plugin, filtered: false }

  const selectedSkills: ScannedSkill[] = []
  if (skillIds) {
    for (const id of skillIds) {
      const skill = plugin.components.skills.find((candidate) => candidate.id === id)
      if (!skill) return { ok: false, message: `${id} is not a skill in ${plugin.name}.` }
      selectedSkills.push(skill)
    }
  }
  const selectedServers: ScannedMcpServer[] = []
  if (mcpServerIds) {
    for (const id of mcpServerIds) {
      const server = plugin.components.mcpServers.find((candidate) => candidate.id === id)
      if (!server) return { ok: false, message: `${id} is not an MCP server in ${plugin.name}.` }
      selectedServers.push(server)
    }
  }
  if (selectedSkills.length === 0 && selectedServers.length === 0) {
    return { ok: false, message: `Select a skill or MCP server in ${plugin.name} to install.` }
  }
  return {
    ok: true,
    filtered: true,
    plugin: {
      ...plugin,
      components: {
        ...plugin.components,
        skills: selectedSkills,
        mcpServers: selectedServers,
      },
    },
  }
}

export async function installPlugin(options: PluginInstallOptions): Promise<PluginInstallResult> {
  const selected = selectPluginItems(options.plugin, {
    skillIds: options.skillIds,
    mcpServerIds: options.mcpServerIds,
  })
  if (!selected.ok) return selected
  const { plugin, filtered } = selected
  if (!plugin.componentsKnown) {
    // The last gate before anything is written, and it stays where it is: a
    // plugin nobody has seen whole may be hiding a hooks file that failed to
    // fetch, and installing it would slip past the hooks acknowledgement
    // (6803a703d). The service refuses first, in these same words.
    //
    // The words are `describeUnreadPlugin`'s, not this file's own. It used to
    // spell its own two cases, and once `incomplete` joined them a plugin whose
    // files could not be fetched was told the source "lists more plugins than
    // one scan reads" — a reason that had nothing to do with what happened.
    return {
      ok: false,
      message: `${plugin.name} has not been read whole, so it cannot be installed. ${describeUnreadPlugin(plugin)}`,
    }
  }
  if (plugin.id === STUDIO_PLUGIN_ID) {
    // The app installs its own plugin itself, by materialising the bundled
    // template into `.sprintengine/studio-plugin` and copying the skills from
    // there (studio-plugin.ts). A catalogue install would be a SECOND copy of
    // the same skills under a second provenance marker — and of the published
    // template, whose `.mcp.json` and hooks still carry `__SPRINTENGINE_*` tokens
    // only that materialise step can fill in. The catalogue draws it as the
    // built-in row with no Install; this refuses the same install reached any
    // other way, such as from a hand-added source pointing at our releases
    // repository (marketplace-plugin-install ruling, 2026-09-06).
    return {
      ok: false,
      message: `${plugin.name} is built in: the app installs and updates it in every workspace it opens, so it cannot be installed from a catalogue.`,
    }
  }
  const outcomes: PluginInstallHarnessOutcome[] = []
  const warnings: string[] = []
  const skillHarnesses: SkillHarness[] = []

  // The plugin's own files FIRST, and a failure here stops the install.
  //
  // Ordered first because nothing has been written yet at this point: a plugin
  // whose server cannot be given a directory to run from is not a plugin that
  // half-installed, it is one that was not installed. The alternative — copy
  // the skills, then hand back a server whose command expands to nothing — is
  // exactly the bug this file was corrected for.
  let pluginRoot = ''
  let pluginDirName = ''
  let pluginFileCount = 0
  if (pluginNeedsOwnFiles(plugin)) {
    const files = options.pluginFiles ?? []
    const readPluginFile = options.readPluginFile
    if (files.length === 0 || !readPluginFile) {
      return {
        ok: false,
        message: `${plugin.name} declares an MCP server that runs from the plugin's own directory, and that directory's files could not be read from ${describeOrigin(plugin)}.`,
      }
    }
    const copied = await installPluginDirectory({
      workspaceRoot: options.workspaceRoot,
      pluginId: plugin.id,
      files,
      readFile: readPluginFile,
      provenance: { sourceId: options.sourceId, pluginId: plugin.id, commitSha: options.commitSha },
    })
    if (!copied.ok) return copied
    pluginRoot = copied.root
    pluginDirName = copied.dirName
    pluginFileCount = copied.fileCount
  }

  for (const harness of options.harnesses) {
    if (plugin.components.skills.length === 0) {
      outcomes.push({ harness, mode: 'nothing', skillDirNames: [], message: nothingMessage(plugin, harness) })
      continue
    }
    skillHarnesses.push(harness)
  }

  // Skills: one copy per skill, into every harness that takes skills, through
  // the installer that stages, checks paths and writes provenance.
  const copiedByHarness = new Map<SkillHarness, string[]>()
  if (skillHarnesses.length > 0) {
    for (const skill of plugin.components.skills) {
      const provenance: SkillInstallProvenance = {
        sourceId: options.sourceId,
        skillId: skill.id,
        commitSha: options.commitSha,
      }
      const result = await installSkill({
        workspaceRoot: options.workspaceRoot,
        skill,
        harnesses: skillHarnesses,
        readFile: (file) => options.readSkillFile(skill, file),
        provenance,
      })
      if (!result.ok) {
        warnings.push(`${skill.name} did not install: ${result.message}`)
        continue
      }
      for (const harness of result.harnesses) {
        const dirs = copiedByHarness.get(harness) ?? []
        dirs.push(result.dirName)
        copiedByHarness.set(harness, dirs)
      }
    }
    for (const harness of skillHarnesses) {
      const dirs = copiedByHarness.get(harness) ?? []
      outcomes.push({
        harness,
        mode: 'skills',
        skillDirNames: dirs,
        message:
          dirs.length === 0
            ? 'No skill could be copied.'
            : `${dirs.length} ${dirs.length === 1 ? 'skill' : 'skills'} copied. ${unsupportedComponents(plugin, harness)}`.trim(),
      })
    }
  }

  if ([...copiedByHarness.values()].every((dirs) => dirs.length === 0)) {
    // A refusal from here on has to take the plugin's directory back out with
    // it. Copying it is the first thing this function does, so without the
    // sweep an install that failed on its skills would leave a plugin root
    // sitting in the workspace with no receipt naming it and nothing that would
    // ever remove it.
    if (plugin.components.skills.length > 0 && warnings.length > 0) {
      await sweepPluginDirectory(options.workspaceRoot, plugin.id, pluginDirName)
      return { ok: false, message: warnings[0] }
    }
    if (plugin.components.mcpServers.length === 0) {
      await sweepPluginDirectory(options.workspaceRoot, plugin.id, pluginDirName)
      return {
        ok: false,
        message: `${plugin.name} has nothing the agent CLIs on this machine can use. ${nothingMessage(plugin, options.harnesses[0] ?? 'codex')}`,
      }
    }
  }

  // The settings keys, last and by themselves: route 2 of the ruling, additive
  // to the copy above. They are written only when Claude Code is on this
  // machine and the plugin came from a marketplace Claude Code could fetch for
  // itself — a name and a GitHub repository. A plugin-only repository has
  // neither, and there is nothing to name.
  //
  // A filtered install does not write them. Naming the plugin in
  // enabledPlugins is an invitation to `claude plugin install`, which loads
  // every skill the plugin ships — the opposite of taking one item from a
  // catalogue.
  let nativeKey = ''
  const nativeEligible =
    !filtered && options.marketplaceName !== '' && options.marketplaceRepo !== '' && plugin.origin.kind !== 'registry'
  if (nativeEligible && options.harnesses.includes('claude')) {
    const key = claudePluginKey(plugin.id, options.marketplaceName)
    const enabled = await enableClaudePlugin({
      workspaceRoot: options.workspaceRoot,
      marketplaceName: options.marketplaceName,
      marketplaceRepo: options.marketplaceRepo,
      pluginKey: key,
    })
    // A refusal here loses nothing that was installed: the skills are on disk
    // and the MCP servers are about to be returned. Failing the install over an
    // extra would be depending on it, which is the bug this file was corrected
    // for.
    if (enabled.ok) nativeKey = key
    else warnings.push(enabled.message)
  }

  // Provenance, so a later Sync of this source can refresh exactly these
  // entries: the source, the server's id in that source's scan, the commit the
  // declaration was read at — and, for a server that runs out of the plugin's
  // own directory, where that directory landed, so the sync re-resolves the
  // variable instead of writing the literal token back over the real path.
  const mcpServers = plugin.components.mcpServers.map((server) => {
    const rooted = pluginRoot !== '' && referencesPluginRoot(server)
    return mcpServerConfigFromScanned(rooted ? resolvePluginRoot(server, pluginRoot) : server, options.mcpClients, {
      sourceId: options.sourceId,
      itemId: server.id,
      commitSha: options.commitSha,
      ...(rooted ? { pluginRoot } : {}),
    })
  })
  warnings.push(...missingRuntimeWarnings(mcpServers, options.commandExists ?? commandOnPath))

  return {
    ok: true,
    pluginId: plugin.id,
    harnesses: outcomes,
    mcpServers,
    claudePluginKey: nativeKey,
    pluginRoot,
    pluginDirName,
    pluginFileCount,
    warnings,
  }
}

/**
 * A stdio server whose command this machine cannot run, said plainly.
 *
 * Never a refusal. The files are correct, the entry is correct, and the person
 * may install `bun` in a minute — an entry that had been quietly dropped would
 * then have to be noticed and installed again. What is not acceptable is
 * silence: before this, `telegram` landed looking exactly like a server that
 * works and failed at launch with nothing on screen to explain it
 * (backlog/2026-09-06-a-plugins-own-files-must-land-before-its-server-can-start.md).
 *
 * This also catches the shapes plugin-root resolution deliberately does NOT
 * rewrite — a relative command like `./server`, or a runtime like `uvx` or
 * `docker` that simply is not installed — because they fail the same probe.
 */
function missingRuntimeWarnings(servers: readonly McpServerConfig[], exists: (command: string) => boolean): string[] {
  const warnings: string[] = []
  for (const server of servers) {
    const command = server.command?.trim() ?? ''
    if (server.transport !== 'stdio' || command === '') continue
    if (exists(command)) continue
    warnings.push(
      `${server.name} runs \`${command}\`, which is not on this machine's PATH, so it will not start until that is installed.`,
    )
  }
  return warnings
}

/** Undo the directory copy when a later step turns the install into a refusal. */
async function sweepPluginDirectory(workspaceRoot: string, pluginId: string, dirName: string): Promise<void> {
  if (dirName === '') return
  await uninstallPluginDirectory({ workspaceRoot, pluginId })
}

/** Where a plugin's bytes come from, for a sentence about not being able to read them. */
function describeOrigin(plugin: ScannedPlugin): string {
  const origin = plugin.origin
  if (origin.kind === 'linked') return origin.repo || origin.url || 'its repository'
  if (origin.kind === 'registry') return 'the SprintEngine marketplace, which ships no plugin directory'
  return 'its source'
}

export type PluginUninstallOptions = {
  workspaceRoot: string
  pluginId: string
  marketplaceName: string
  /** Skill directory names the install copied; swept from every harness dir. */
  skillDirNames: readonly string[]
  /**
   * The plugin's own directory under `claude-plugins` in the workspace's store, '' when the
   * install copied none. Absent on a receipt written before plugin directories
   * existed, which means the same thing: there is nothing of that kind to
   * remove.
   */
  pluginDirName?: string
  allHarnesses: readonly SkillHarness[]
}

export type PluginUninstallResult =
  | {
      ok: true
      removedPaths: string[]
      /** The `name@marketplace` key this uninstall took back out of the settings, '' when there was none. */
      disabledClaudePluginKey: string
      /** The settings file refused the edit; the copies still went. */
      warnings: string[]
    }
  | { ok: false; message: string }

export async function uninstallPlugin(options: PluginUninstallOptions): Promise<PluginUninstallResult> {
  const removedPaths: string[] = []
  const warnings: string[] = []
  for (const dirName of options.skillDirNames) {
    const result = await uninstallSkill({
      workspaceRoot: options.workspaceRoot,
      dirName,
      harnesses: options.allHarnesses,
    })
    if (!result.ok) return result
    removedPaths.push(...result.removedPaths)
  }
  // The plugin's own directory, when the install copied one. It goes before the
  // settings edit for the same reason it was copied first: it is the part an
  // agent would still be able to launch a server out of.
  if ((options.pluginDirName ?? '') !== '') {
    const removed = await uninstallPluginDirectory({
      workspaceRoot: options.workspaceRoot,
      pluginId: options.pluginId,
    })
    if (!removed.ok) return removed
    removedPaths.push(...removed.removedPaths)
    warnings.push(...removed.warnings)
  }
  let disabledKey = ''
  if (options.marketplaceName !== '') {
    const key = claudePluginKey(options.pluginId, options.marketplaceName)
    const disabled = await disableClaudePlugin({ workspaceRoot: options.workspaceRoot, pluginKey: key })
    // Symmetrical with install: the key is an extra, so a settings file nobody
    // can parse is reported beside a completed uninstall rather than leaving
    // the copies on disk with a Remove that failed.
    if (!disabled.ok) warnings.push(disabled.message)
    else if (disabled.removed) disabledKey = key
  }
  return { ok: true, removedPaths, disabledClaudePluginKey: disabledKey, warnings }
}

// ── Claude Code settings ────────────────────────────────────────────────────

type ClaudeSettings = Record<string, unknown> & {
  extraKnownMarketplaces?: Record<string, unknown>
  enabledPlugins?: Record<string, unknown>
}

/**
 * Register the marketplace and enable the plugin — the two keys Claude Code
 * documents for team-shared plugins. They are NOT sufficient on their own (see
 * this file's head: measured against 2.1.263, a github marketplace also needs
 * `claude plugin marketplace add` and `claude plugin install`), so this is the
 * half of the handshake the app can honestly do and the copy above is what
 * actually delivers the plugin.
 *
 * Merged into whatever the file already holds: a person's own hooks,
 * permissions and other marketplaces survive byte-for-byte in meaning, and an
 * existing marketplace entry of the same name is left as they wrote it.
 */
async function enableClaudePlugin(input: {
  workspaceRoot: string
  marketplaceName: string
  marketplaceRepo: string
  pluginKey: string
}): Promise<{ ok: true } | { ok: false; message: string }> {
  const path = join(input.workspaceRoot, CLAUDE_SETTINGS_RELATIVE_PATH)
  const read = await readClaudeSettings(path)
  if (!read.ok) return read
  const settings = read.settings
  const marketplaces = isRecord(settings.extraKnownMarketplaces) ? settings.extraKnownMarketplaces : {}
  if (!(input.marketplaceName in marketplaces)) {
    marketplaces[input.marketplaceName] = { source: claudeMarketplaceSource(input.marketplaceRepo) }
  }
  const enabled = isRecord(settings.enabledPlugins) ? settings.enabledPlugins : {}
  enabled[input.pluginKey] = true
  settings.extraKnownMarketplaces = marketplaces
  settings.enabledPlugins = enabled
  return writeClaudeSettings(path, settings)
}

/**
 * How Claude Code is told where a marketplace lives. Its `github` source means
 * github.com over https; a repository anywhere else, or one read over ssh, is
 * registered as a plain `git` source at the same address this app cloned,
 * which is the form Claude Code documents for any other host.
 */
export function claudeMarketplaceSource(repo: string): Record<string, string> {
  const location = splitSkillRepo(repo)
  const url = skillRepoCloneUrl(repo)
  if (!location || !url || (location.host === DEFAULT_SKILL_REPO_HOST && !location.ssh)) {
    return { source: 'github', repo }
  }
  return { source: 'git', url }
}

async function disableClaudePlugin(input: {
  workspaceRoot: string
  pluginKey: string
}): Promise<{ ok: true; removed: boolean } | { ok: false; message: string }> {
  const path = join(input.workspaceRoot, CLAUDE_SETTINGS_RELATIVE_PATH)
  const read = await readClaudeSettings(path)
  if (!read.ok) return read
  const enabled = read.settings.enabledPlugins
  if (!isRecord(enabled) || !(input.pluginKey in enabled)) return { ok: true, removed: false }
  delete enabled[input.pluginKey]
  // The marketplace registration stays: other plugins from it may be enabled,
  // a person may have written it themselves, and a registration on its own
  // loads nothing — which is the whole finding this file was corrected for.
  const written = await writeClaudeSettings(path, read.settings)
  return written.ok ? { ok: true, removed: true } : written
}

/** Which plugins the workspace's Claude settings enable, `name@marketplace` → true. */
export async function readEnabledClaudePlugins(workspaceRoot: string): Promise<Set<string>> {
  const read = await readClaudeSettings(join(workspaceRoot, CLAUDE_SETTINGS_RELATIVE_PATH))
  if (!read.ok || !isRecord(read.settings.enabledPlugins)) return new Set()
  return new Set(
    Object.entries(read.settings.enabledPlugins)
      .filter(([, value]) => value === true)
      .map(([key]) => key),
  )
}

async function readClaudeSettings(
  path: string,
): Promise<{ ok: true; settings: ClaudeSettings } | { ok: false; message: string }> {
  let raw: string
  try {
    raw = await readFile(path, 'utf8')
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return { ok: true, settings: {} }
    return { ok: false, message: `${CLAUDE_SETTINGS_RELATIVE_PATH} could not be read: ${describe(error)}` }
  }
  if (raw.trim() === '') return { ok: true, settings: {} }
  try {
    const parsed: unknown = JSON.parse(raw)
    if (!isRecord(parsed)) {
      return { ok: false, message: `${CLAUDE_SETTINGS_RELATIVE_PATH} is not a JSON object, so it was left alone.` }
    }
    return { ok: true, settings: parsed as ClaudeSettings }
  } catch (error) {
    // A file that does not parse is someone's work in progress; writing over
    // it would destroy whatever they were typing.
    return {
      ok: false,
      message: `${CLAUDE_SETTINGS_RELATIVE_PATH} is not valid JSON, so it was left alone: ${describe(error)}`,
    }
  }
}

async function writeClaudeSettings(
  path: string,
  settings: ClaudeSettings,
): Promise<{ ok: true } | { ok: false; message: string }> {
  try {
    await mkdir(dirname(path), { recursive: true })
    const temp = `${path}.${process.pid}.tmp`
    await writeFile(temp, `${JSON.stringify(settings, null, 2)}\n`, 'utf8')
    await rename(temp, path)
    return { ok: true }
  } catch (error) {
    return { ok: false, message: `${CLAUDE_SETTINGS_RELATIVE_PATH} could not be written: ${describe(error)}` }
  }
}

// ── Words ───────────────────────────────────────────────────────────────────

function nothingMessage(plugin: ScannedPlugin, harness: SkillHarness): string {
  const parts = claudeOnlyComponents(plugin)
  if (parts === '') return 'It declares no skills.'
  return harness === 'claude'
    ? `Its ${parts} are not installed: Claude Code loads those only from a plugin \`claude plugin install\` put in its own cache.`
    : `Its ${parts} are Claude Code-format and have no equivalent here.`
}

function unsupportedComponents(plugin: ScannedPlugin, harness: SkillHarness): string {
  const parts = claudeOnlyComponents(plugin)
  if (parts === '') return ''
  // "No equivalent here" is true of every harness but Claude Code, which has
  // all three — this app simply does not write them. Saying it has none would
  // be the same false implication, pointed the other way
  // (backlog/2026-09-06-a-github-marketplace-plugin-installs-nothing-for-claude-code.md).
  return harness === 'claude'
    ? `Its ${parts} are not installed: Claude Code loads those only from a plugin \`claude plugin install\` put in its own cache.`
    : `Its ${parts} have no equivalent here.`
}

/** The component kinds only Claude Code loads, named for a sentence. */
function claudeOnlyComponents(plugin: ScannedPlugin): string {
  const c = plugin.components
  const parts: string[] = []
  if (c.commands.length > 0) parts.push('commands')
  if (c.agents.length > 0) parts.push('agents')
  if (c.hooks.length > 0) parts.push('hooks')
  if (c.lspServers.length > 0) parts.push('LSP servers')
  return parts.join(', ')
}

function describe(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}
