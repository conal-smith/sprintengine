// pluginsSurfaceModel — pure, DOM-free derivation for the Plugins surface, the
// skillsSurfaceModel idiom: the components own the IPC and the rendering, and
// everything that can be tested without a renderer lives here.
//
// The honesty rules it holds: a linked plugin's components are unknown until
// read, never empty; and what an install will do is stated per harness
// before it happens, in the same words the install reports afterwards.

import type { InstalledPluginRecord } from '../../../../../../../shared/electron-api'
import { pluginNeedsOwnFiles, referencesPluginRoot } from '../../../../../../../shared/mcp/plugin-root'
import {
  describePluginComponents,
  findScannedPlugin,
  pluginAliases,
  scanPluginRenames,
  scanPlugins,
  skillRepoWebUrl,
  unreadPluginChip,
  type ScanResult,
  type ScannedPlugin,
  type SkillHarness,
  type SkillSource,
  isGithubDotComRepo,
} from '../../../../../../../shared/skills'

const HARNESS_LABEL: Record<SkillHarness, string> = {
  claude: 'Claude Code',
  codex: 'Codex',
  cursor: 'Cursor',
  gemini: 'Gemini CLI',
  opencode: 'OpenCode',
  grok: 'Grok',
  agents: 'Shared agents directory',
}

// ── Rows ─────────────────────────────────────────────────────────────────────

export type PluginInstallState =
  | { kind: 'not-installed' }
  | { kind: 'installed'; record: InstalledPluginRecord }
  /** Installed from this source at another commit than the source now pins. */
  | { kind: 'update-available'; record: InstalledPluginRecord }

export type PluginListItem = {
  pluginId: string
  name: string
  description: string
  /** "4 skills · 2 commands · 1 MCP", or "Read when opened" for an unread linked plugin. */
  components: string
  /**
   * Known to run hooks. False also means "not read", never "runs none" — an
   * unread plugin's `unread` chip is what says which, and no surface may turn
   * this into a claim that a plugin is hook-free.
   */
  hasHooks: boolean
  linked: boolean
  /**
   * Two or three words for a plugin that has NOT been read, or null when it
   * has. A row shows the description when there is one, and every linked entry
   * in the official marketplace has one, so without this the plugin whose
   * repository could not be read looked exactly like the one that was read
   * (linked-plugins ruling, 2026-09-06).
   */
  unread: string | null
  install: PluginInstallState
}

/**
 * Which record says this plugin is installed. Our own receipt first; failing
 * that, a plugin the workspace's Claude settings enable under the same
 * `name@marketplace` key — enabled by hand, still installed.
 */
export function findInstalledRecord(
  records: readonly InstalledPluginRecord[],
  sourceId: string,
  plugin: Pick<ScannedPlugin, 'id'>,
  marketplaceName: string,
  /**
   * Names this plugin used to be listed under, from the marketplace's own
   * `renames` map. A receipt written before an upstream rename names the plugin
   * by the old name, and without them the plugin a person installed reads as
   * not installed and installing it again duplicates it.
   */
  aliases: readonly string[] = [],
): InstalledPluginRecord | null {
  // An exact id beats an alias, across ALL the records — not whichever comes
  // first in the list. Scanning the records once and asking "is this any of my
  // names" let a receipt for an old name outrank the receipt written under the
  // name the plugin goes by now, which is the wrong plugin's receipt whenever
  // both are installed.
  const older = aliases.filter((name) => name !== plugin.id)
  const own =
    records.find((record) => record.sourceId === sourceId && record.pluginId === plugin.id) ??
    records.find((record) => record.sourceId === sourceId && older.includes(record.pluginId))
  if (own) return own
  if (marketplaceName === '') return null
  const key = `${plugin.id}@${marketplaceName}`
  return (
    records.find((record) => record.claudePluginKey === key) ??
    records.find((record) => older.some((name) => record.claudePluginKey === `${name}@${marketplaceName}`)) ??
    null
  )
}

export function derivePluginInstallState(
  records: readonly InstalledPluginRecord[],
  sourceId: string,
  plugin: ScannedPlugin,
  marketplaceName: string,
  /** The commit the source (or the linked plugin) pins now. */
  currentCommit: string,
  /** Names this plugin used to be listed under — see findInstalledRecord. */
  aliases: readonly string[] = [],
): PluginInstallState {
  const record = findInstalledRecord(records, sourceId, plugin, marketplaceName, aliases)
  if (!record) return { kind: 'not-installed' }
  // Only our own receipts carry a commit to compare; a hand-enabled plugin has
  // no commit we wrote, and "update available" would be a guess.
  if (
    record.sourceId === sourceId &&
    record.commitSha !== '' &&
    currentCommit !== '' &&
    record.commitSha !== currentCommit
  ) {
    return { kind: 'update-available', record }
  }
  return { kind: 'installed', record }
}

export function pluginCommit(plugin: ScannedPlugin, source: SkillSource): string {
  return plugin.origin.kind === 'linked' ? plugin.origin.sha : source.commitSha
}

export function derivePluginRows(input: {
  source: SkillSource
  scan: ScanResult
  installed: readonly InstalledPluginRecord[]
  query: string
}): PluginListItem[] {
  const marketplaceName = input.scan.marketplaceName ?? ''
  const renames = scanPluginRenames(input.scan)
  const needle = input.query.trim().toLowerCase()
  return scanPlugins(input.scan)
    .filter(
      (plugin) =>
        needle === '' ||
        `${plugin.name} ${plugin.description} ${plugin.category} ${plugin.author}`.toLowerCase().includes(needle),
    )
    .map((plugin) => ({
      pluginId: plugin.id,
      name: plugin.name,
      description: plugin.description,
      components: describePluginComponents(plugin),
      hasHooks: plugin.components.hooks.length > 0,
      linked: plugin.origin.kind === 'linked',
      unread: unreadPluginChip(plugin),
      install: derivePluginInstallState(
        input.installed,
        input.source.id,
        plugin,
        marketplaceName,
        pluginCommit(plugin, input.source),
        pluginAliases(renames, plugin.id),
      ),
    }))
}

/**
 * How many plugins in this source are installed at a commit the source has
 * moved past — the number its tab wears, and the number of corner pips a person
 * will find under it.
 *
 * It runs the SAME derivation the rows do, unfiltered by the search box: the
 * count is about the source, not about what is currently typed, and a count
 * derived a second way is a count that can disagree with the list it labels.
 */
export function countPluginUpdates(input: {
  source: SkillSource
  scan: ScanResult
  installed: readonly InstalledPluginRecord[]
}): number {
  return derivePluginRows({ ...input, query: '' }).filter((row) => row.install.kind === 'update-available').length
}

/** A plugin by the name it goes by now, or any name the marketplace renamed onto it. */
export function findPlugin(scan: ScanResult, pluginId: string): ScannedPlugin | null {
  return findScannedPlugin(scan, pluginId)
}

/** Where a plugin's bytes can be read by a person: its homepage, else its repository. */
export function pluginExternalUrl(plugin: ScannedPlugin, source: SkillSource): string | null {
  if (plugin.homepage) return plugin.homepage
  if (plugin.origin.kind === 'linked') {
    // An ssh clone address is not something a browser opens; the repository's
    // page is.
    if (/^https?:\/\//i.test(plugin.origin.url)) return plugin.origin.url
    return plugin.origin.repo ? skillRepoWebUrl(plugin.origin.repo) : null
  }
  const page = plugin.origin.kind === 'in-tree' && source.repo ? skillRepoWebUrl(source.repo) : null
  if (plugin.origin.kind === 'in-tree' && page) {
    // A deep link only where its spelling is known; every other host gets the
    // repository's page, which is always right.
    if (!isGithubDotComRepo(source.repo)) return page
    const path = plugin.origin.path ? `/tree/${source.commitSha || 'HEAD'}/${plugin.origin.path}` : ''
    return `${page}${path}`
  }
  if (plugin.origin.kind === 'registry') return plugin.origin.sourceUrl || null
  return null
}

/** Whether a plugin-pane row survives the in-pane filter. */
export function pluginComponentMatchesQuery(name: string, description: string, query: string): boolean {
  const needle = query.trim().toLowerCase()
  if (needle === '') return true
  return `${name} ${description}`.toLowerCase().includes(needle)
}

// ── What installs where ──────────────────────────────────────────────────────

export type HarnessPlanLine = { harness: SkillHarness; label: string; line: string }

/**
 * The per-harness sentence the pane shows BEFORE anyone installs an item, from
 * the same rule the installer applies: each skill you pick is copied into
 * every harness, each MCP server you pick is added to MCP settings, and a
 * harness with nothing to receive is told so rather than shown a blank.
 *
 * Claude Code's row says the same thing as the others, plus the components
 * this app does not write for it. It does not claim a settings key will be
 * written — a one-item install does not enable the whole plugin.
 */
export function describeInstallPlan(input: {
  plugin: ScannedPlugin
  marketplaceName: string
  marketplaceRepo: string
  harnesses: readonly SkillHarness[]
}): HarnessPlanLine[] {
  const { plugin } = input
  if (!plugin.componentsKnown) {
    return input.harnesses.map((harness) => ({
      harness,
      label: HARNESS_LABEL[harness],
      line: 'Known once the plugin has been read.',
    }))
  }
  const skills = plugin.components.skills.length
  const claudeOnly = claudeOnlyComponents(plugin)
  return input.harnesses.map((harness) => {
    const claude = harness === 'claude'
    const parts: string[] = []
    if (skills > 0) {
      parts.push(`Skills you install are copied into ${harnessDir(harness)}/skills`)
    }
    if (plugin.components.mcpServers.length > 0) {
      parts.push('MCP servers you add are written to MCP settings')
    }
    const unsupported = claudeOnly
      ? claude
        ? ` Its ${claudeOnly} are not installed — Claude Code loads those only from a plugin \`claude plugin install\` put in its own cache.`
        : ` Its ${claudeOnly} have no equivalent here.`
      : ''
    if (parts.length === 0) {
      const nothing = claude
        ? `Nothing is copied.${unsupported}`
        : claudeOnly
          ? `Nothing to install. Its ${claudeOnly} are Claude Code-format and have no equivalent here.`
          : 'Nothing to install.'
      return { harness, label: HARNESS_LABEL[harness], line: nothing }
    }
    return { harness, label: HARNESS_LABEL[harness], line: `${parts.join('; ')}.${unsupported}` }
  })
}

/**
 * The plugin's OWN files, when a server it declares runs out of them, in the
 * pane's words — one sentence above the per-harness lines, because the copy is
 * harness-independent: every CLI's MCP config points at the same directory.
 *
 * Null when nothing extra is copied, which is the common case and must stay
 * visibly so
 * (backlog/2026-09-06-a-plugins-own-files-must-land-before-its-server-can-start.md).
 */
export function describePluginFilesPlan(plugin: ScannedPlugin): string | null {
  if (!plugin.componentsKnown || !pluginNeedsOwnFiles(plugin)) return null
  const servers = plugin.components.mcpServers.filter(referencesPluginRoot).map((server) => server.id)
  const named = servers.length === 1 ? servers[0] : servers.join(', ')
  return `The plugin's own files are copied into this project's folder under ~/.sprintengine/workspaces (claude-plugins/${plugin.id}), not into the project, because ${named} ${
    servers.length === 1 ? 'runs' : 'run'
  } from the plugin's directory. \${CLAUDE_PLUGIN_ROOT} is resolved to where they land; Remove deletes them again.`
}

function claudeOnlyComponents(plugin: ScannedPlugin): string {
  const parts: string[] = []
  if (plugin.components.commands.length > 0) parts.push('commands')
  if (plugin.components.agents.length > 0) parts.push('agents')
  if (plugin.components.hooks.length > 0) parts.push('hooks')
  // A language server is started by Claude Code's own editor integration and
  // has no equivalent in the other harnesses. Left out, the twelve `*-lsp`
  // plugins read "Nothing to install." under Codex with no reason given, which
  // is the blank this sentence exists to avoid.
  if (plugin.components.lspServers.length > 0) parts.push('LSP servers')
  return parts.join(', ')
}

function harnessDir(harness: SkillHarness): string {
  return `.${harness}`
}

// ── Availability and outcomes ────────────────────────────────────────────────

export type PluginInstallAvailability = { enabled: boolean; reason: string | null }

export function derivePluginInstallAvailability(
  workspaceRoot: string | null,
  plugin: ScannedPlugin | null,
  harnesses: readonly SkillHarness[],
): PluginInstallAvailability {
  if (!workspaceRoot) {
    return {
      enabled: false,
      reason: 'Open a workspace to install a plugin — a plugin installs into a workspace, not into the app.',
    }
  }
  if (!plugin) return { enabled: false, reason: null }
  if (harnesses.length === 0) return { enabled: false, reason: 'No agent CLI on this machine reads plugins or skills.' }
  if (!plugin.componentsKnown) {
    return { enabled: false, reason: 'Read this plugin before installing from it.' }
  }
  return { enabled: true, reason: null }
}

/** One line for what an install did, per harness, in the installer's own words. */
export function summarizePluginInstall(outcome: {
  harnesses: readonly { harness: SkillHarness; mode: 'skills' | 'nothing'; skillDirNames: string[] }[]
  mcpServers: readonly unknown[]
  warnings: readonly string[]
}): string {
  const parts: string[] = []
  const skills = outcome.harnesses.filter((h) => h.mode === 'skills' && h.skillDirNames.length > 0)
  if (skills.length > 0) {
    const count = Math.max(...skills.map((h) => h.skillDirNames.length))
    parts.push(
      `${count} ${count === 1 ? 'skill' : 'skills'} copied for ${skills.map((h) => HARNESS_LABEL[h.harness]).join(', ')}`,
    )
  }
  if (outcome.mcpServers.length > 0) {
    parts.push(`${outcome.mcpServers.length} MCP ${outcome.mcpServers.length === 1 ? 'server' : 'servers'} added`)
  }
  const line = parts.length > 0 ? `Installed: ${parts.join('; ')}.` : 'Installed.'
  return outcome.warnings.length > 0 ? `${line} ${outcome.warnings[0]}` : line
}
