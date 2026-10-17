// Finding what this app wrote before it kept a ledger.
//
// Every build before the ledger wrote hooks, MCP entries, plugin copies and
// skill copies without recording them. On the first start of a build that
// keeps one, the workspaces the app knows (and their git worktrees) and the
// homes it writes into are read for this app's markers, and what is found is
// recorded as if it had been written just now. The removal then treats both
// alike: it reads the file again and takes out only what the marker names.
//
// Reading only. Nothing here writes, and a file that does not parse is simply
// not ours to describe.

import { existsSync } from 'node:fs'
import { readdir, readFile, realpath, stat } from 'node:fs/promises'
import { join, resolve } from 'node:path'

import { STUDIO_MCP_SERVER_ID } from '../../shared/product-identity'
import { isRecord } from '../../shared/records'
import { SKILL_HARNESS_DIR } from '../../shared/skill-harnesses'
import { agentWorktreeLockOwner } from '../agent-worktree-lock'
import {
  AGENT_STATE_TOML_START,
  isAgentStateReporterCommand,
  isStatusLineForwarderCommand,
  AGENT_STATE_HOOK_TAG,
} from '../agent-state'
import { resolveClaudeConfigDir } from '../claude-config-dir'
import type { GitCommandResult } from '../git'
import { runGitCommand } from '../git-utils'
import { runGitWorktreeListPorcelain } from '../git-worktree-list'
import {
  CLAUDE_GATEWAY_MARKER,
  CODEX_GATEWAY_MARKER,
  isManagedStudioGatewayEntry,
  MANAGED_START,
  MCP_APPROVAL_MARKER,
  OPENCODE_GATEWAY_MARKER,
} from '../mcp-config-service'
import { readSkillProvenance } from '../skills/install'
import {
  STUDIO_PLUGIN_MARKETPLACE_NAME,
  STUDIO_PLUGIN_SOURCE_ID,
  STUDIO_PLUGIN_WORKSPACE_DIR,
  studioClaudePluginKey,
} from '../skills/studio-plugin'
import { launcherDirForHome } from './launcher'
import type { IntegrationWrite } from './ledger'
import { withoutLegacySharedPair, WORKTREE_EXCLUDE_FILE } from './worktree-exclude'

export const KNOWLEDGE_ACTIVITY_HOOK_TAG = 'sprintengine-knowledge-activity'

type RunGit = (cwd: string, args: string[]) => Promise<GitCommandResult>

export type ScanRoot = { path: string; hostId: string }
export type ScanHome = { native: string; hostId: string }

async function readJson(path: string): Promise<Record<string, unknown> | null> {
  try {
    const parsed: unknown = JSON.parse(await readFile(path, 'utf8'))
    return isRecord(parsed) ? parsed : null
  } catch {
    return null
  }
}

async function readText(path: string): Promise<string | null> {
  return readFile(path, 'utf8').catch(() => null)
}

async function isDirectory(path: string): Promise<boolean> {
  return (await stat(path).catch(() => null))?.isDirectory() === true
}

/** Hook entries in a Claude-shaped `hooks` record whose command, or tag, `claim` accepts. */
function claudeHooksContain(hooks: unknown, claim: (entry: Record<string, unknown>) => boolean): boolean {
  if (!isRecord(hooks)) return false
  for (const blocks of Object.values(hooks)) {
    if (!Array.isArray(blocks)) continue
    for (const block of blocks) {
      const entries = isRecord(block) && Array.isArray(block.hooks) ? block.hooks : []
      if (entries.some((entry) => isRecord(entry) && claim(entry))) return true
    }
  }
  return false
}

function flatHooksContain(hooks: unknown): boolean {
  if (!isRecord(hooks)) return false
  return Object.values(hooks).some(
    (entries) =>
      Array.isArray(entries) && entries.some((entry) => isRecord(entry) && isAgentStateReporterCommand(entry.command)),
  )
}

/** What this app wrote into one checkout (a workspace folder or a worktree). */
export async function scanRepositoryIntegrations(root: ScanRoot): Promise<IntegrationWrite[]> {
  const found: IntegrationWrite[] = []
  const base = { hostId: root.hostId, repo: root.path, source: 'scan' as const }
  const at = (...parts: string[]) => resolve(root.path, ...parts)

  // Claude settings, the gitignored half.
  const localPath = at('.claude', 'settings.local.json')
  const local = await readJson(localPath)
  if (local) {
    if (
      claudeHooksContain(
        local.hooks,
        (entry) => entry._sprintengine === AGENT_STATE_HOOK_TAG || isAgentStateReporterCommand(entry.command),
      )
    ) {
      found.push({ kind: 'agent-state-hooks', path: localPath, marker: 'settings-json', cli: 'claude-code', ...base })
    }
    if (
      isRecord(local.statusLine) &&
      (local.statusLine._sprintengine === true || isStatusLineForwarderCommand(local.statusLine.command))
    ) {
      found.push({ kind: 'status-line', path: localPath, marker: 'statusLine', cli: 'claude-code', ...base })
    }
    if (claudeHooksContain(local.hooks, (entry) => entry._sprintengine === KNOWLEDGE_ACTIVITY_HOOK_TAG)) {
      found.push({
        kind: 'knowledge-activity-hook',
        path: localPath,
        marker: KNOWLEDGE_ACTIVITY_HOOK_TAG,
        cli: 'claude-code',
        detail: { record: at('.sprintengine', 'hooks', 'installed.json') },
        ...base,
      })
    }
    if (Array.isArray(local.enabledMcpjsonServers) && local.enabledMcpjsonServers.includes(STUDIO_MCP_SERVER_ID)) {
      found.push({ kind: 'mcp-approval', path: localPath, marker: MCP_APPROVAL_MARKER, cli: 'claude-code', ...base })
    }
    if (isRecord(local.extraKnownMarketplaces) && STUDIO_PLUGIN_MARKETPLACE_NAME in local.extraKnownMarketplaces) {
      found.push({
        kind: 'claude-plugin-setting',
        path: localPath,
        marker: `extraKnownMarketplaces.${STUDIO_PLUGIN_MARKETPLACE_NAME}`,
        cli: 'claude-code',
        ...base,
      })
    }
    if (isRecord(local.enabledPlugins) && studioClaudePluginKey() in local.enabledPlugins) {
      found.push({
        kind: 'claude-plugin-setting',
        path: localPath,
        marker: `enabledPlugins.${studioClaudePluginKey()}`,
        cli: 'claude-code',
        ...base,
      })
    }
  }

  // Claude settings, the tracked half: only the plugin key an earlier build wrote.
  const projectPath = at('.claude', 'settings.json')
  const project = await readJson(projectPath)
  if (project && isRecord(project.enabledPlugins) && studioClaudePluginKey() in project.enabledPlugins) {
    found.push({
      kind: 'claude-plugin-setting',
      path: projectPath,
      marker: `enabledPlugins.${studioClaudePluginKey()}`,
      cli: 'claude-code',
      ...base,
    })
  }

  // MCP gateway entries in the Claude-format files.
  for (const [rel, cli] of [
    [['.mcp.json'], 'claude-code'],
    [['.cursor', 'mcp.json'], 'cursor'],
  ] as const) {
    const path = at(...rel)
    const json = await readJson(path)
    if (json && isRecord(json.mcpServers) && isManagedStudioGatewayEntry(json.mcpServers[STUDIO_MCP_SERVER_ID])) {
      found.push({ kind: 'mcp-gateway', path, marker: CLAUDE_GATEWAY_MARKER, cli, ...base })
    }
  }

  // OpenCode.
  const opencodePath = at('opencode.json')
  const opencode = await readJson(opencodePath)
  if (opencode && isRecord(opencode.mcp) && isOpencodeGateway(opencode.mcp[STUDIO_MCP_SERVER_ID])) {
    found.push({ kind: 'mcp-gateway', path: opencodePath, marker: OPENCODE_GATEWAY_MARKER, cli: 'opencode', ...base })
  }

  // Codex: both managed blocks share one file.
  const codexPath = at('.codex', 'config.toml')
  const codex = await readText(codexPath)
  if (codex !== null) {
    if (codex.includes(AGENT_STATE_TOML_START)) {
      found.push({ kind: 'agent-state-hooks', path: codexPath, marker: 'toml-block', cli: 'codex', ...base })
    }
    if (codex.includes(MANAGED_START) && codex.includes(`[mcp_servers.${STUDIO_MCP_SERVER_ID}]`)) {
      found.push({ kind: 'mcp-gateway', path: codexPath, marker: CODEX_GATEWAY_MARKER, cli: 'codex', ...base })
    }
  }

  // Cursor hooks, Grok's owned hook file, OpenCode's plugin file.
  const cursorHooksPath = at('.cursor', 'hooks.json')
  const cursorHooks = await readJson(cursorHooksPath)
  if (cursorHooks && flatHooksContain(cursorHooks.hooks)) {
    found.push({ kind: 'agent-state-hooks', path: cursorHooksPath, marker: 'flat-hooks-json', cli: 'cursor', ...base })
  }
  const grokPath = at('.grok', 'hooks', 'sprintengine-agent-state.json')
  if (existsSync(grokPath)) {
    found.push({
      kind: 'agent-state-hooks',
      path: grokPath,
      marker: 'owned-json',
      cli: 'grok',
      createdFile: true,
      ...base,
    })
  }
  const opencodePluginPath = at('.opencode', 'plugin', 'sprintengine-agent-state.js')
  const opencodePlugin = await readText(opencodePluginPath)
  if (opencodePlugin?.includes('SPRINTENGINE_AGENT_STATE')) {
    found.push({
      kind: 'agent-state-hooks',
      path: opencodePluginPath,
      marker: 'plugin-file',
      cli: 'opencode',
      createdFile: true,
      ...base,
    })
  }

  // The app's own directory in the checkout.
  const pluginCopy = at(STUDIO_PLUGIN_WORKSPACE_DIR)
  if (await isDirectory(pluginCopy)) {
    found.push({
      kind: 'studio-plugin-copy',
      path: pluginCopy,
      marker: 'owned',
      cli: 'claude-code',
      createdFile: true,
      ...base,
    })
  }
  for (const name of ['agent-state.mjs', 'status-line.mjs', 'knowledge-activity.mjs']) {
    const path = at('.sprintengine', 'hooks', name)
    if (existsSync(path)) found.push({ kind: 'hook-script', path, marker: 'owned', createdFile: true, ...base })
  }

  // Studio skill copies, by their provenance marker.
  for (const harnessDir of new Set(Object.values(SKILL_HARNESS_DIR))) {
    const skillsRoot = at(harnessDir, 'skills')
    const entries = await readdir(skillsRoot, { withFileTypes: true }).catch(() => [])
    for (const entry of entries) {
      if (!entry.isDirectory()) continue
      const path = join(skillsRoot, entry.name)
      if ((await readSkillProvenance(path))?.sourceId !== STUDIO_PLUGIN_SOURCE_ID) continue
      found.push({
        kind: 'skill-copy',
        path,
        marker: `provenance:${STUDIO_PLUGIN_SOURCE_ID}`,
        createdFile: true,
        ...base,
      })
    }
  }
  return found
}

function isOpencodeGateway(entry: unknown): boolean {
  if (!isRecord(entry) || !Array.isArray(entry.command)) return false
  const [command, ...args] = entry.command as unknown[]
  return isManagedStudioGatewayEntry({
    command,
    args,
    env: isRecord(entry.environment) ? entry.environment : {},
  })
}

/** What this app wrote into a home: the user-scoped hook, the launcher, and Claude's marketplace entry. */
export async function scanHomeIntegrations(
  home: ScanHome,
  env: NodeJS.ProcessEnv = process.env,
): Promise<IntegrationWrite[]> {
  const found: IntegrationWrite[] = []
  const base = { hostId: home.hostId, source: 'scan' as const }
  const kimiPath = join(home.native, '.kimi-code', 'config.toml')
  if ((await readText(kimiPath))?.includes(AGENT_STATE_TOML_START)) {
    found.push({ kind: 'agent-state-hooks', path: kimiPath, marker: 'toml-array-block', cli: 'kimi-code', ...base })
  }
  const homeReporter = join(home.native, '.sprintengine', 'hooks', 'agent-state.mjs')
  if (existsSync(homeReporter)) {
    found.push({ kind: 'hook-script', path: homeReporter, marker: 'owned', createdFile: true, ...base })
  }
  const launcherDir = launcherDirForHome(home.native)
  if (await isDirectory(launcherDir)) {
    found.push({ kind: 'launcher', path: launcherDir, marker: 'owned', createdFile: true, ...base })
  }
  if (home.hostId === 'local') {
    const knownPath = join(resolveClaudeConfigDir(home.native, env), 'plugins', 'known_marketplaces.json')
    const known = await readJson(knownPath)
    if (known && STUDIO_PLUGIN_MARKETPLACE_NAME in known) {
      found.push({
        kind: 'claude-known-marketplace',
        path: knownPath,
        marker: STUDIO_PLUGIN_MARKETPLACE_NAME,
        cli: 'claude-code',
        ...base,
      })
    }
  }
  return found
}

/**
 * What this app left in a repository's git: the earlier build's unmarked pair
 * in the shared exclude file, per-worktree excludes files, and this profile's
 * worktree locks. Returns the repository's worktrees too, so the caller can
 * scan each checkout.
 */
export async function scanGitIntegrations(
  root: ScanRoot,
  runGit: RunGit = runGitCommand,
): Promise<{ found: IntegrationWrite[]; worktrees: string[] }> {
  const found: IntegrationWrite[] = []
  const common = await runGit(root.path, ['rev-parse', '--git-common-dir'])
  if (!common.ok) return { found, worktrees: [] }
  const commonDir = resolve(root.path, common.stdout.trim())
  const base = { hostId: root.hostId, source: 'scan' as const }
  const sharedExclude = join(commonDir, 'info', 'exclude')
  const sharedText = await readText(sharedExclude)
  if (sharedText !== null && withoutLegacySharedPair(sharedText) !== null) {
    found.push({ kind: 'git-exclude', path: sharedExclude, marker: 'legacy-shared-pair', repo: root.path, ...base })
  }
  const listing = await runGitWorktreeListPorcelain(runGit, root.path)
  const worktrees: string[] = []
  if (listing.ok) {
    let current: string | null = null
    for (const line of listing.stdout.split('\0').flatMap((record) => record.split(/\r?\n/u))) {
      if (line.startsWith('worktree ')) {
        current = line.slice('worktree '.length)
        worktrees.push(current)
      } else if (current && line.startsWith('locked ')) {
        const reason = line.slice('locked '.length)
        if (agentWorktreeLockOwner(reason) === 'this-profile') {
          found.push({ kind: 'worktree-lock', path: resolve(current), marker: reason, repo: root.path, ...base })
        }
      }
    }
  }
  const worktreeDirs = await readdir(join(commonDir, 'worktrees'), { withFileTypes: true }).catch(() => [])
  for (const entry of worktreeDirs) {
    const file = join(commonDir, 'worktrees', entry.name, WORKTREE_EXCLUDE_FILE)
    if (existsSync(file)) {
      found.push({ kind: 'git-exclude', path: file, marker: 'owned', repo: root.path, createdFile: true, ...base })
    }
  }
  return { found, worktrees }
}

/**
 * The whole first-run scan: every root, every worktree of each root's
 * repository, and every home. Each root is read once however many ways it was
 * reached; a root that is gone is skipped.
 */
export async function scanForIntegrations(input: {
  roots: readonly ScanRoot[]
  homes: readonly ScanHome[]
  runGit?: RunGit
  env?: NodeJS.ProcessEnv
}): Promise<IntegrationWrite[]> {
  const found: IntegrationWrite[] = []
  const seen = new Set<string>()
  const queue: ScanRoot[] = [...input.roots]
  while (queue.length > 0) {
    const root = queue.shift()!
    // By the real path: git lists worktrees resolved, and the same checkout
    // reached through a symlink (macOS's /var is one) must be read once.
    const key = await realpath(root.path).catch(() => resolve(root.path))
    if (seen.has(key) || !(await isDirectory(root.path))) continue
    seen.add(key)
    found.push(...(await scanRepositoryIntegrations(root)))
    // Git is asked only on this machine: a distribution's repositories are
    // read through its files, and its git runs inside it.
    if (root.hostId === 'local') {
      const git = await scanGitIntegrations(root, input.runGit).catch(() => ({ found: [], worktrees: [] }))
      found.push(...git.found)
      for (const worktree of git.worktrees) queue.push({ path: worktree, hostId: root.hostId })
    }
  }
  for (const home of input.homes) found.push(...(await scanHomeIntegrations(home, input.env)))
  return dedupe(found)
}

function dedupe(writes: IntegrationWrite[]): IntegrationWrite[] {
  const byKey = new Map<string, IntegrationWrite>()
  for (const write of writes)
    byKey.set(`${write.kind}\u0000${write.hostId}\u0000${write.path}\u0000${write.marker}`, write)
  return [...byKey.values()]
}
