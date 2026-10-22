import { mkdir, readFile, rmdir, stat, unlink } from 'fs/promises'
import { homedir } from 'os'
import { dirname, join, resolve as resolvePath } from 'path'

import { codexMcpEnv, codexMcpServerFields, tomlInlineTable } from './codex-mcp-overrides'
import { withConfigFileLock, writeFileAtomically } from './config-file-write'
import { isLauncherMcpServer } from './integrations/launcher'
import { hostIdForPath, recordIntegrationWrite } from './integrations/ledger'
import { installedStudioPlatform } from '../server/platform/platform'
import { isPathStrictlyInside } from './path-containment'
import type {
  McpClientTarget,
  McpScope,
  McpServerConfig,
  McpSettings,
  McpSyncInput,
  McpSyncPreview,
  McpSyncResult,
  McpSyncTarget,
  McpValidationIssue,
} from '../shared/electron-api'
import type { PluginManifest, PluginMcpConfigSpec } from '../shared/plugin-manifest'
// MCP server-config normalization lives in shared/mcp so node-free consumers
// (the marketplace registry validator) apply identical rules; re-exported here
// to keep this module's public surface stable for existing callers.
import { normalizeMcpClients, normalizeMcpServerConfig, normalizeServer } from '../shared/mcp/normalize-server'
import { pluginIdForCli } from './agent-launch-render'
import { commandOnPathAsync } from './command-on-path'
import { getPluginById } from './plugin-registry-instance'
import { STUDIO_MCP_SERVER_ID } from '../shared/product-identity'

export { normalizeMcpClients, normalizeMcpServerConfig }

export const MANAGED_START = '# >>> sprintengine mcp managed'
export const MANAGED_END = '# <<< sprintengine mcp managed'

/**
 * The id the deleted in-tree Sprint Engine wrote its per-run HTTP server under.
 * Nothing serves it any more, so a workspace that ran a sprint keeps an entry
 * pointing at a dead hub and the CLI shows a failed server. The Studio sync
 * pass forgets it (`studio-mcp-sync.ts`) and the Claude settings writer keeps
 * it out of the enabled/disabled lists. A filter, not a migration: nothing is
 * carried forward.
 */
export const RETIRED_SPRINTENGINE_MCP_SERVER_ID = 'sprintengine-sprintengine'

export type PluginLookup = (id: string) => { manifest: PluginManifest } | undefined

/**
 * Every call is asynchronous and every write is conditional. A launch runs a
 * sync against the workspace each time, often with a root on a slow or remote
 * filesystem (`\\wsl$`, a network share), so none of it may block the main
 * thread; and a config whose bytes would not change is left alone, because an
 * unconditional rewrite of `.mcp.json` on every launch wakes every watcher on
 * the workspace for nothing.
 */
export type McpConfigService = {
  previewSync(input: McpSyncInput): Promise<McpSyncPreview>
  sync(input: McpSyncInput): Promise<McpSyncResult>
}

export type McpConfigServiceOptions = {
  lookupPlugin?: PluginLookup
  homeDir?: () => string
  userDataDir?: () => string
}

export function createMcpConfigService(options: McpConfigServiceOptions = {}): McpConfigService {
  const lookupPlugin: PluginLookup = options.lookupPlugin ?? ((id) => getPluginById(id))
  const homeDir = options.homeDir ?? (() => homedir())
  const userDataDir = options.userDataDir ?? (() => defaultUserDataDir(homeDir))
  return {
    previewSync: (input) => syncMcpConfig({ ...input, write: false }, { lookupPlugin, homeDir, userDataDir }),
    sync: (input) => syncMcpConfig({ ...input, write: true }, { lookupPlugin, homeDir, userDataDir }),
  }
}

type SyncContext = {
  lookupPlugin: PluginLookup
  homeDir: () => string
  userDataDir: () => string
}

async function syncMcpConfig(input: McpSyncInput, context: SyncContext): Promise<McpSyncResult> {
  const settings = normalizeSettings(input.settings)
  const clients = normalizeMcpClients(input.clients)
  const issues: McpValidationIssue[] = []
  if (!settings.syncEnabled) {
    return { ok: true, targets: [], issues }
  }
  if (!input.workspaceRoot || !(await pathExists(input.workspaceRoot))) {
    return { ok: false, message: 'Workspace root does not exist.', issues }
  }

  const activeServers = Object.values(settings.servers)
    .filter((server) => server.enabled)
    .filter((server) => clients.some((client) => server.clients.includes(client)))

  for (const server of activeServers) {
    issues.push(...(await validateServer(server)))
  }

  const blocking = issues.find((issue) => issue.level === 'error')
  if (blocking) {
    return { ok: false, message: blocking.message, issues }
  }

  // Ids the caller has already dropped from settings and wants out of the
  // configs. They belong to every client's known list, because a forgotten
  // server no longer says which clients it was written for.
  const forgottenServerIds = (input.forgetServerIds ?? [])
    .map((id) => String(id ?? '').trim())
    .filter((id) => id !== '' && !(id in settings.servers))

  const targets: McpSyncTarget[] = []
  for (const client of clients) {
    const clientServers = activeServers.filter((server) => server.clients.includes(client))
    const knownClientServerIds = [
      ...Object.values(settings.servers)
        .filter((server) => server.clients.includes(client))
        .map((server) => server.id),
      ...forgottenServerIds,
    ]
    if (clientServers.length === 0 && knownClientServerIds.length === 0) continue

    const pluginId = pluginIdForCli(client)
    const plugin = context.lookupPlugin(pluginId)
    if (!plugin || !plugin.manifest.mcpConfig) {
      const hasRequired = clientServers.some((server) => server.required)
      issues.push({
        level: hasRequired ? 'error' : 'warning',
        client,
        message: hasRequired
          ? `Plugin "${pluginId}" has no MCP config writer; Studio-launched agents require an mcpConfig block for the app-owned gateway.`
          : `Plugin "${pluginId}" does not declare an mcpConfig block; skipping MCP sync for this CLI.`,
      })
      continue
    }
    if (plugin.manifest.capabilities.mcpServers !== true) {
      const hasRequired = clientServers.some((server) => server.required)
      issues.push({
        level: hasRequired ? 'error' : 'warning',
        client,
        message: hasRequired
          ? `Plugin "${pluginId}" does not support managed MCP servers; Studio-launched agents require MCP support via capabilities.mcpServers.`
          : `Plugin "${pluginId}" does not declare MCP server support; skipping MCP sync for this CLI.`,
      })
      continue
    }

    const formatTargets = await syncForFormat({
      client,
      plugin: plugin.manifest,
      workspaceRoot: input.workspaceRoot,
      servers: clientServers,
      knownServerIds: knownClientServerIds,
      pruneUnlisted: input.pruneUnlistedServers === true,
      write: input.write === true,
      context,
    })
    targets.push(...formatTargets.targets)
    issues.push(...formatTargets.issues)
  }

  const syncBlocking = issues.find((issue) => issue.level === 'error')
  if (syncBlocking) {
    return { ok: false, message: syncBlocking.message, issues }
  }

  return { ok: true, targets, issues }
}

function isPathInside(root: string, path: string): boolean {
  return isPathStrictlyInside(resolvePath(root), resolvePath(path))
}

function defaultUserDataDir(homeDir: () => string): string {
  // Node-only tests install no platform.
  const userData = installedStudioPlatform()?.paths.dataDir()
  if (userData) return userData
  return join(homeDir(), '.sprintengine')
}

function normalizeSettings(settings: McpSettings | undefined): McpSettings {
  if (!settings || typeof settings !== 'object') {
    return { syncEnabled: false, servers: {} }
  }
  const servers: Record<string, McpServerConfig> = {}
  for (const value of Object.values(settings.servers ?? {})) {
    if (!value || typeof value !== 'object') continue
    const normalized = normalizeServer(value)
    if (normalized) servers[normalized.id] = normalized
  }
  return {
    syncEnabled: settings.syncEnabled === true,
    servers,
  }
}

async function validateServer(server: McpServerConfig): Promise<McpValidationIssue[]> {
  const issues: McpValidationIssue[] = []
  if (server.transport === 'stdio') {
    const command = server.command?.trim()
    if (!command) {
      issues.push({ level: 'error', serverId: server.id, message: `${server.name} is missing a command.` })
    } else if (!(await commandOnPathAsync(command))) {
      issues.push({
        level: server.required ? 'error' : 'warning',
        serverId: server.id,
        message: `${server.name} command was not found: ${command}`,
      })
    }
  }
  if ((server.transport === 'http' || server.transport === 'sse') && !server.url?.trim()) {
    issues.push({ level: 'error', serverId: server.id, message: `${server.name} is missing a URL.` })
  }
  for (const envVar of server.envVarNames ?? []) {
    if (!process.env[envVar]) {
      issues.push({
        level: server.required ? 'error' : 'warning',
        serverId: server.id,
        message: `${server.name} expects environment variable ${envVar}.`,
      })
    }
  }
  return issues
}

/**
 * The absolute path a plugin's declared MCP config template resolves to, or
 * null when the plugin declares none for that scope. The one place those
 * templates are substituted: the writers below and the read path
 * (src/main/mcp-config-readers/resolve-servers.ts) must agree byte for byte, or
 * the app would read a different file than it writes.
 */
export function resolveMcpConfigPath(
  spec: PluginMcpConfigSpec,
  scope: McpScope,
  workspaceRoot: string,
  homeDir: () => string,
): string | null {
  const template = scope === 'user' ? spec.userPath : spec.path
  if (!template) return null
  const substituted = template
    .replace(/\{\{\s*workspaceRoot\s*\}\}/g, workspaceRoot)
    .replace(/\{\{\s*home\s*\}\}/g, homeDir())
    .replace(/^~(?=\/|$)/, homeDir())
  return substituted
}

type SyncForFormatInput = {
  client: McpClientTarget
  plugin: PluginManifest
  workspaceRoot: string
  servers: McpServerConfig[]
  knownServerIds: string[]
  // Connector-scoped write: prune every server not in `servers` from the target
  // config so the worktree ends with exactly the connector set (see McpSyncInput).
  pruneUnlisted: boolean
  write: boolean
  context: SyncContext
}

async function syncForFormat(input: SyncForFormatInput): Promise<{
  targets: McpSyncTarget[]
  issues: McpValidationIssue[]
}> {
  const format = input.plugin.mcpConfig!.format
  switch (format) {
    case 'codex': {
      const result = await syncCodex(input)
      return { targets: [result.target], issues: result.issues }
    }
    case 'claude-code': {
      const result = await syncClaude(input)
      return { targets: [result.target], issues: result.issues }
    }
    case 'opencode': {
      const result = await syncOpencode(input)
      return { targets: [result.target], issues: result.issues }
    }
    case 'generic': {
      const hasRequired = input.servers.some((server) => server.required)
      return {
        targets: [],
        issues: [
          {
            level: hasRequired ? 'error' : 'warning',
            client: input.client,
            message: hasRequired
              ? `MCP sync writer for format "${format}" is not implemented yet; Studio-launched agents require a workspace stdio MCP config writer for plugin "${input.plugin.id}".`
              : `MCP sync writer for format "${format}" is not implemented yet; declared in plugin "${input.plugin.id}".`,
          },
        ],
      }
    }
  }
}

async function syncCodex(input: SyncForFormatInput): Promise<{
  target: McpSyncTarget
  issues: McpValidationIssue[]
}> {
  const { plugin, servers, knownServerIds, workspaceRoot, write, context, client } = input
  const scope: McpScope = servers.some((server) => server.scope === 'user') ? 'user' : 'workspace'
  const resolved = resolveMcpConfigPath(plugin.mcpConfig!, scope, workspaceRoot, context.homeDir)
  const serverIds = servers.map((server) => server.id)
  if (!resolved) {
    return { target: { client, path: '', serverIds }, issues: [] }
  }
  const target = { client, path: resolved, serverIds }
  if (write && (servers.length > 0 || knownServerIds.length > 0)) {
    return withConfigFileLock(resolved, () => writeCodexConfig(input, resolved, target))
  }
  return { target, issues: [] }
}

async function writeCodexConfig(
  input: SyncForFormatInput,
  resolved: string,
  target: McpSyncTarget,
): Promise<{ target: McpSyncTarget; issues: McpValidationIssue[] }> {
  const { servers, knownServerIds, client } = input
  // Pruning is for a connector worktree's own copy. A CLI whose config lives in
  // the home (Grok's `~/.grok/config.toml`) holds the person's own servers
  // there, which no connector launch may strip.
  const pruneUnlisted = input.pruneUnlisted && isPathInside(input.workspaceRoot, resolved)
  const prepared = await prepareWritableConfigFile(resolved, client)
  if (!prepared.ok) return { target, issues: [prepared.issue] }
  // Connector-scoped write: drop every [mcp_servers.*] table the repo committed
  // outside our managed block (renderCodexManagedBlock only rewrites the managed
  // block, which is the sole source of truth for the connector set). Keep none —
  // even a bare table sharing the connector id, to avoid a duplicate section.
  // Other codex config (model, profiles, …) is preserved.
  const base = pruneUnlisted
    ? removeCommittedCodexMcpServers(replaceManagedBlock(prepared.previous, ''))
    : prepared.previous
  const written = await writeIfChanged(
    resolved,
    prepared,
    servers.length
      ? replaceManagedBlock(base, renderCodexManagedBlock(servers))
      : removeCodexManagedServers(base, knownServerIds),
    client,
  )
  if (!written) recordGatewayWrite(input, resolved, CODEX_GATEWAY_MARKER, servers, prepared.existed)
  return { target, issues: written ? [written] : [] }
}

async function syncClaude(input: SyncForFormatInput): Promise<{
  target: McpSyncTarget
  issues: McpValidationIssue[]
}> {
  const { plugin, servers, knownServerIds, workspaceRoot, write, context, client } = input
  const workspaceServers = servers.filter((server) => server.scope === 'workspace')
  const userServers = servers.filter((server) => server.scope === 'user')
  const issues = userServers.map((server): McpValidationIssue => ({
    level: server.required ? 'error' : 'warning',
    client,
    serverId: server.id,
    message: `Claude user-scoped MCP sync is not implemented yet for ${server.name}; use workspace scope or claude mcp add.`,
  }))
  const path = resolveMcpConfigPath(plugin.mcpConfig!, 'workspace', workspaceRoot, context.homeDir)
  if (!path) {
    return {
      target: { client, path: '', serverIds: workspaceServers.map((server) => server.id) },
      issues,
    }
  }
  const target = { client, path, serverIds: workspaceServers.map((server) => server.id) }
  if (write && (workspaceServers.length > 0 || knownServerIds.length > 0)) {
    // Held across the write, the read-back and the approval so no other sync of
    // this `.mcp.json` lands between writing the entry and verifying it.
    const writeIssues = await withConfigFileLock(path, () => writeClaudeConfig(input, path, workspaceServers))
    issues.push(...writeIssues)
  }
  return { target, issues }
}

async function writeClaudeConfig(
  input: SyncForFormatInput,
  path: string,
  workspaceServers: McpServerConfig[],
): Promise<McpValidationIssue[]> {
  const { plugin, knownServerIds, pruneUnlisted, workspaceRoot, client } = input
  const prepared = await prepareWritableConfigFile(path, client)
  if (!prepared.ok) return [prepared.issue]
  let existing: Record<string, unknown> = {}
  if (prepared.existed) {
    const parsed = parseJsonObject(prepared.previous)
    if (!parsed) {
      return [
        {
          level: 'error',
          client,
          message: `${path} is not valid JSON. Fix it before syncing Claude MCPs.`,
        },
      ]
    }
    existing = parsed
  }
  const currentServers =
    existing.mcpServers && typeof existing.mcpServers === 'object'
      ? (existing.mcpServers as Record<string, unknown>)
      : {}
  // Connector-scoped write starts empty so any server the repo committed into
  // the worktree .mcp.json is dropped, not merged; the normal path preserves
  // the user's other servers and only replaces the ones we manage.
  const nextServers: Record<string, unknown> = pruneUnlisted ? {} : { ...currentServers }
  if (!pruneUnlisted) {
    for (const serverId of knownServerIds) {
      delete nextServers[serverId]
    }
  }
  for (const server of workspaceServers) {
    nextServers[server.id] = toClaudeServer(server)
  }
  const writeIssue = await writeIfChanged(
    path,
    prepared,
    `${JSON.stringify({ ...existing, mcpServers: nextServers }, null, 2)}\n`,
    client,
  )
  if (writeIssue) return [writeIssue]
  recordGatewayWrite(input, path, CLAUDE_GATEWAY_MARKER, workspaceServers, prepared.existed)
  if (plugin.binary === 'claude' && workspaceServers.some((server) => server.id === STUDIO_MCP_SERVER_ID)) {
    const approvalIssue = await enableStudioMcpForClaudeWorkspace(
      workspaceRoot,
      client,
      path,
      nextServers[STUDIO_MCP_SERVER_ID],
    )
    if (approvalIssue) return [approvalIssue]
  }
  return []
}

// Claude records project MCP approval separately from `.mcp.json`. The Studio
// gateway is app-owned, so add only that one id to the allow-list;
// custom MCPs retain Claude's normal consent flow and every unrelated setting
// is preserved. Z.AI and Kimi Claude use the same Claude binary/config shape.
//
// Claude's approval is keyed by server ID only, so approval must never be
// granted against content we did not just write: a repo-committed `.mcp.json`
// squatting on our id would otherwise run an arbitrary command with no consent
// prompt. Verify the on-disk entry byte-matches the managed config at grant
// time; the sync path re-renders the entry on every launch and writes it back
// whenever the file drifted from it, so drift is healed and re-verified per
// launch (installer command-shape rule, not id-trust).
async function enableStudioMcpForClaudeWorkspace(
  workspaceRoot: string,
  client: McpClientTarget,
  mcpJsonPath: string,
  expectedServer: unknown,
): Promise<McpValidationIssue | null> {
  try {
    const parsed = JSON.parse(await readFile(mcpJsonPath, 'utf8')) as Record<string, unknown> | null
    const servers = (parsed?.mcpServers ?? {}) as Record<string, unknown>
    const onDisk = servers[STUDIO_MCP_SERVER_ID]
    if (JSON.stringify(onDisk) !== JSON.stringify(expectedServer)) {
      return {
        level: 'error',
        client,
        serverId: STUDIO_MCP_SERVER_ID,
        message: `${mcpJsonPath} does not contain the managed Studio MCP entry that was just written; refusing to pre-approve the server id.`,
      }
    }
  } catch (error) {
    return {
      level: 'error',
      client,
      serverId: STUDIO_MCP_SERVER_ID,
      message: `Could not verify ${mcpJsonPath} before approving the Studio MCP server: ${error instanceof Error ? error.message : String(error)}`,
    }
  }
  const settingsPath = join(workspaceRoot, '.claude', 'settings.local.json')
  return withConfigFileLock(settingsPath, () => approveStudioMcpInClaudeSettings(settingsPath, client))
}

async function approveStudioMcpInClaudeSettings(
  settingsPath: string,
  client: McpClientTarget,
): Promise<McpValidationIssue | null> {
  const prepared = await prepareWritableConfigFile(settingsPath, client)
  if (!prepared.ok) return prepared.issue
  let existing: Record<string, unknown> = {}
  if (prepared.existed) {
    const parsed = parseJsonObject(prepared.previous)
    if (!parsed) {
      return {
        level: 'error',
        client,
        message: `${settingsPath} is not valid JSON. Fix it before syncing the required Studio MCP server.`,
      }
    }
    existing = parsed
  }
  const strings = (value: unknown): string[] =>
    Array.isArray(value) ? value.filter((entry): entry is string => typeof entry === 'string') : []
  const withoutManagedIds = (values: string[]): string[] =>
    values.filter((id) => id !== STUDIO_MCP_SERVER_ID && id !== RETIRED_SPRINTENGINE_MCP_SERVER_ID)
  const enabled = [...withoutManagedIds(strings(existing.enabledMcpjsonServers)), STUDIO_MCP_SERVER_ID]
  const disabled = withoutManagedIds(strings(existing.disabledMcpjsonServers))
  const next: Record<string, unknown> = {
    ...existing,
    enabledMcpjsonServers: enabled,
  }
  if (disabled.length > 0) next.disabledMcpjsonServers = disabled
  else delete next.disabledMcpjsonServers
  const issue = await writeIfChanged(settingsPath, prepared, `${JSON.stringify(next, null, 2)}\n`, client)
  if (!issue) {
    recordIntegrationWrite({
      kind: 'mcp-approval',
      path: settingsPath,
      marker: MCP_APPROVAL_MARKER,
      hostId: hostIdForPath(settingsPath),
      cli: client,
      repo: dirname(dirname(settingsPath)),
      createdFile: !prepared.existed,
    })
  }
  return issue
}

/** How the gateway is recognised in each format's file (see `isManagedStudioGatewayEntry`). */
export const CLAUDE_GATEWAY_MARKER = `mcpServers.${STUDIO_MCP_SERVER_ID}`
export const OPENCODE_GATEWAY_MARKER = `mcp.${STUDIO_MCP_SERVER_ID}`
export const CODEX_GATEWAY_MARKER = `${MANAGED_START}#${STUDIO_MCP_SERVER_ID}`
export const MCP_APPROVAL_MARKER = `enabledMcpjsonServers.${STUDIO_MCP_SERVER_ID}`

/** Record the gateway in the integration ledger when this write carried it. */
function recordGatewayWrite(
  input: SyncForFormatInput,
  path: string,
  marker: string,
  servers: readonly McpServerConfig[],
  existed: boolean,
): void {
  if (!servers.some((server) => server.id === STUDIO_MCP_SERVER_ID)) return
  recordIntegrationWrite({
    kind: 'mcp-gateway',
    path,
    marker,
    hostId: hostIdForPath(path),
    cli: input.client,
    repo: input.workspaceRoot,
    createdFile: !existed,
  })
}

async function syncOpencode(input: SyncForFormatInput): Promise<{
  target: McpSyncTarget
  issues: McpValidationIssue[]
}> {
  const { plugin, servers, knownServerIds, workspaceRoot, write, context, client } = input
  const issues: McpValidationIssue[] = []
  // OpenCode's `mcp` schema expresses local (stdio) and remote (HTTP) servers
  // only. Surface anything it cannot represent instead of writing a fake entry.
  const writableServers: McpServerConfig[] = []
  for (const server of servers) {
    if (server.transport === 'sse') {
      issues.push({
        level: server.required ? 'error' : 'warning',
        client,
        serverId: server.id,
        message: `OpenCode MCP config supports local (stdio) and remote (HTTP) servers only; SSE server ${server.name} cannot be synced. Use an HTTP endpoint instead.`,
      })
      continue
    }
    writableServers.push(server)
  }

  const serverIds = writableServers.map((server) => server.id)
  const scope: McpScope = writableServers.some((server) => server.scope === 'user') ? 'user' : 'workspace'
  const path = resolveMcpConfigPath(plugin.mcpConfig!, scope, workspaceRoot, context.homeDir)
  if (!path) return { target: { client, path: '', serverIds }, issues }
  if (issues.some((issue) => issue.level === 'error')) {
    return { target: { client, path, serverIds }, issues }
  }

  if (write && (writableServers.length > 0 || knownServerIds.length > 0)) {
    const writeIssues = await withConfigFileLock(path, () => writeOpencodeConfig(input, path, writableServers))
    issues.push(...writeIssues)
  }
  return { target: { client, path, serverIds }, issues }
}

async function writeOpencodeConfig(
  input: SyncForFormatInput,
  path: string,
  writableServers: McpServerConfig[],
): Promise<McpValidationIssue[]> {
  const { knownServerIds, pruneUnlisted, client } = input
  const prepared = await prepareWritableConfigFile(path, client)
  if (!prepared.ok) return [prepared.issue]
  // Nothing to add and no file to prune from: do not create an empty config.
  if (!prepared.existed && writableServers.length === 0) return []
  let existing: Record<string, unknown> = {}
  if (prepared.existed) {
    const parsed = parseJsonObject(prepared.previous)
    if (!parsed) {
      return [
        {
          level: 'error',
          client,
          message: `opencode.json is not valid JSON. Fix it before syncing OpenCode MCPs.`,
        },
      ]
    }
    existing = parsed
  }
  const currentServers =
    existing.mcp && typeof existing.mcp === 'object' && !Array.isArray(existing.mcp)
      ? (existing.mcp as Record<string, unknown>)
      : {}
  // Connector-scoped write drops any repo-committed server (start empty); the
  // normal path keeps the user's servers and only replaces the managed ones.
  const nextServers: Record<string, unknown> = pruneUnlisted ? {} : { ...currentServers }
  if (!pruneUnlisted) {
    for (const serverId of knownServerIds) {
      delete nextServers[serverId]
    }
  }
  for (const server of writableServers) {
    nextServers[server.id] = toOpencodeServer(server)
  }
  const next: Record<string, unknown> = { ...existing }
  if (Object.keys(nextServers).length) {
    next.mcp = nextServers
  } else {
    delete next.mcp
  }
  const writeIssue = await writeIfChanged(path, prepared, `${JSON.stringify(next, null, 2)}\n`, client)
  if (!writeIssue) recordGatewayWrite(input, path, OPENCODE_GATEWAY_MARKER, writableServers, prepared.existed)
  return writeIssue ? [writeIssue] : []
}

function toOpencodeServer(server: McpServerConfig): Record<string, unknown> {
  if (server.transport === 'stdio') {
    const entry: Record<string, unknown> = {
      type: 'local',
      command: opencodeLocalCommand(server),
    }
    if (server.env && Object.keys(server.env).length) entry.environment = server.env
    return entry
  }
  const entry: Record<string, unknown> = { type: 'remote', url: server.url ?? '' }
  const headers = opencodeRemoteHeaders(server)
  if (Object.keys(headers).length) entry.headers = headers
  return entry
}

function opencodeLocalCommand(server: McpServerConfig): string[] {
  const command = server.command ?? ''
  const args = server.args ?? []
  if (process.platform === 'win32' && command === 'npx') {
    return ['cmd', '/c', 'npx', ...args]
  }
  return [command, ...args]
}

function opencodeRemoteHeaders(server: McpServerConfig): Record<string, string> {
  // OpenCode interpolates `{env:VAR}` in string fields; an env-backed bearer
  // token replaces any caller-supplied Authorization header so the literal
  // secret is never written to disk.
  const headers: Record<string, string> = server.envVarNames?.length
    ? Object.fromEntries(Object.entries(server.headers ?? {}).filter(([key]) => key.toLowerCase() !== 'authorization'))
    : { ...server.headers }
  if (server.envVarNames?.[0]) {
    headers.Authorization = `Bearer {env:${server.envVarNames[0]}}`
  }
  return headers
}

type PreparedConfigFile = { ok: true; previous: string; existed: boolean }
type WritableConfigFileResult = PreparedConfigFile | { ok: false; issue: McpValidationIssue }

async function pathExists(path: string): Promise<boolean> {
  try {
    await stat(path)
    return true
  } catch {
    return false
  }
}

/** `stat`, or null when nothing is there. Any other failure propagates. */
async function statOrNull(path: string): Promise<Awaited<ReturnType<typeof stat>> | null> {
  try {
    return await stat(path)
  } catch (error) {
    if ((error as NodeJS.ErrnoException | undefined)?.code === 'ENOENT') return null
    throw error
  }
}

// Every write below goes through `withConfigFileLock` and `writeFileAtomically`
// (config-file-write.ts): see there for why.

/**
 * The file's JSON object, `{}` for a file with nothing in it, or null for
 * anything else — a caller must refuse to write over what it cannot read.
 */
function parseJsonObject(text: string): Record<string, unknown> | null {
  if (text.trim() === '') return {}
  try {
    const parsed: unknown = JSON.parse(text)
    return isPlainRecord(parsed) ? parsed : null
  } catch {
    return null
  }
}

/**
 * Write `content` unless the file already holds exactly those bytes. The
 * comparison is against the text `prepareWritableConfigFile` just read, so it
 * costs no second read. A failed write is reported, not thrown.
 */
async function writeIfChanged(
  path: string,
  prepared: PreparedConfigFile,
  content: string,
  client: McpClientTarget,
): Promise<McpValidationIssue | null> {
  if (prepared.existed && prepared.previous === content) return null
  try {
    await writeFileAtomically(path, content)
    return null
  } catch (error) {
    return {
      level: 'error',
      client,
      message: `Cannot write MCP config for ${client} at ${path}: ${error instanceof Error ? error.message : 'Unknown filesystem error.'}`,
    }
  }
}

/**
 * How long to wait before reading an empty config a second time. A file that
 * is empty on disk is most often one another program is rewriting in place
 * right now; treating that moment as "no settings" and writing back would drop
 * everything in it. A file still empty after the pause really is empty.
 */
const EMPTY_CONFIG_REREAD_MS = 50

async function prepareWritableConfigFile(path: string, client: McpClientTarget): Promise<WritableConfigFileResult> {
  const directory = dirname(path)
  try {
    const directoryStat = await statOrNull(directory)
    if (directoryStat && !directoryStat.isDirectory()) {
      return {
        ok: false,
        issue: {
          level: 'error',
          client,
          message: `Cannot sync MCP config for ${client}: expected ${directory} to be a directory, but it is a file. Rename or remove that file, or disable MCP sync for this CLI.`,
        },
      }
    }
    if (!directoryStat) await mkdir(directory, { recursive: true })
    const fileStat = await statOrNull(path)
    if (!fileStat) return { ok: true, previous: '', existed: false }
    if (fileStat.isDirectory()) {
      return {
        ok: false,
        issue: {
          level: 'error',
          client,
          message: `Cannot sync MCP config for ${client}: expected ${path} to be a config file, but it is a directory. Rename or remove that directory, or disable MCP sync for this CLI.`,
        },
      }
    }
    let previous = await readFile(path, 'utf8')
    if (previous.trim() === '') {
      await new Promise((resolveDelay) => setTimeout(resolveDelay, EMPTY_CONFIG_REREAD_MS))
      previous = await readFile(path, 'utf8')
    }
    return { ok: true, previous, existed: true }
  } catch (error) {
    return {
      ok: false,
      issue: {
        level: 'error',
        client,
        message: `Cannot sync MCP config for ${client} at ${path}: ${error instanceof Error ? error.message : 'Unknown filesystem error.'}`,
      },
    }
  }
}

function replaceManagedBlock(previous: string, block: string): string {
  const pattern = new RegExp(`${escapeRegExp(MANAGED_START)}[\\s\\S]*?${escapeRegExp(MANAGED_END)}\\n?`, 'm')
  const trimmed = previous.replace(pattern, '').trimEnd()
  if (!block) return trimmed ? `${trimmed}\n` : ''
  return `${trimmed}${trimmed ? '\n\n' : ''}${block}\n`
}

export function removeCodexManagedServers(previous: string, serverIds: string[]): string {
  const ids = new Set(serverIds)
  if (ids.size === 0) return previous
  const pattern = new RegExp(`${escapeRegExp(MANAGED_START)}[\\s\\S]*?${escapeRegExp(MANAGED_END)}\\n?`, 'm')
  const match = previous.match(pattern)
  if (!match) return previous

  const block = match[0].replace(/\n?$/, '')
  const lines = block.split(/\r?\n/)
  const inner = lines.slice(1, -1)
  const preamble: string[] = []
  const sections: Array<{ id: string; lines: string[] }> = []
  let current: { id: string; lines: string[] } | null = null

  for (const line of inner) {
    const section = line.match(/^\[mcp_servers\.([a-z0-9_-]+)\]$/)
    if (section) {
      current = { id: section[1]!, lines: [line] }
      sections.push(current)
      continue
    }
    if (current) {
      current.lines.push(line)
    } else {
      preamble.push(line)
    }
  }

  const remaining = sections.filter((section) => !ids.has(section.id))
  if (remaining.length === 0) return replaceManagedBlock(previous, '')

  while (preamble.length > 0 && preamble[preamble.length - 1] === '') preamble.pop()
  const nextBlock = [
    MANAGED_START,
    ...preamble,
    ...remaining.flatMap((section) => ['', ...section.lines]),
    MANAGED_END,
  ].join('\n')
  return replaceManagedBlock(previous, nextBlock)
}

// Strip every top-level `[mcp_servers.<id>]` table (and its sub-tables) from a
// codex config, leaving all other config intact. Used only on the connector-
// scoped write, after the managed block has been removed, so a server the base
// repo committed into the worktree config.toml cannot survive into a connector
// chat; the managed block re-added afterwards is the sole source of the connector.
function removeCommittedCodexMcpServers(text: string): string {
  const out: string[] = []
  let dropping = false
  for (const line of text.split(/\r?\n/)) {
    const header = line.match(/^\s*\[\[?\s*([^\]]+?)\s*\]\]?\s*$/)
    if (header) {
      dropping =
        header[1]!
          .trim()
          .replace(/^["']|["']$/g, '')
          .split('.')[0] === 'mcp_servers'
    }
    if (!dropping) out.push(line)
  }
  return out.join('\n')
}

function renderCodexManagedBlock(servers: McpServerConfig[]): string {
  return [
    MANAGED_START,
    '# This section is generated by SprintEngine Settings. Edit MCPs in SprintEngine or remove this block.',
    ...servers.flatMap(renderCodexServer),
    MANAGED_END,
  ].join('\n')
}

function renderCodexServer(server: McpServerConfig): string[] {
  const lines = [`[mcp_servers.${server.id}]`]
  if (server.transport === 'stdio') {
    lines.push(`command = ${tomlString(server.command ?? '')}`)
    if (server.args?.length) lines.push(`args = [${server.args.map(tomlString).join(', ')}]`)
    if (server.envVarNames?.length) lines.push(`env_vars = [${server.envVarNames.map(tomlString).join(', ')}]`)
    if (server.env)
      lines.push(
        `env = { ${Object.entries(server.env)
          .map(([key, value]) => `${tomlString(key)} = ${tomlString(value)}`)
          .join(', ')} }`,
      )
  } else {
    lines.push(`url = ${tomlString(server.url ?? '')}`)
    if (server.envVarNames?.length) lines.push(`bearer_token_env_var = ${tomlString(server.envVarNames[0])}`)
    const headers = server.envVarNames?.length
      ? Object.fromEntries(
          Object.entries(server.headers ?? {}).filter(([key]) => key.toLowerCase() !== 'authorization'),
        )
      : server.headers
    if (headers && Object.keys(headers).length)
      lines.push(
        `http_headers = { ${Object.entries(headers)
          .map(([key, value]) => `${tomlString(key)} = ${tomlString(value)}`)
          .join(', ')} }`,
      )
  }
  lines.push(`enabled = ${server.enabled ? 'true' : 'false'}`)
  if (server.required) lines.push('required = true')
  return ['', ...lines]
}

function toClaudeServer(server: McpServerConfig): Record<string, unknown> {
  if (server.transport === 'stdio') {
    return {
      type: 'stdio',
      command: process.platform === 'win32' && server.command === 'npx' ? 'cmd' : server.command,
      args:
        process.platform === 'win32' && server.command === 'npx'
          ? ['/c', 'npx', ...(server.args ?? [])]
          : (server.args ?? []),
      ...(server.env ? { env: server.env } : {}),
    }
  }
  return {
    type: server.transport === 'sse' ? 'sse' : 'http',
    url: server.url,
    ...httpHeadersForClaude(server),
  }
}

function httpHeadersForClaude(server: McpServerConfig): { headers?: Record<string, string> } {
  const headers = { ...server.headers }
  if (!headers.Authorization && server.envVarNames?.[0]) {
    headers.Authorization = `Bearer \${${server.envVarNames[0]}}`
  }
  return Object.keys(headers).length ? { headers } : {}
}

function tomlString(value: string): string {
  return JSON.stringify(value)
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

// ── Servers a launch hands its CLI itself ───────────────────────────────────
//
// A CLI that takes its MCP servers on its own command line or environment is
// handed the person's synced servers there, for that session (see
// `integrations/launch-integration.ts`), instead of having them merged into a
// file in the repository. The same validation the sync runs decides what goes:
// a required server whose command is missing still stops the launch.

export type LaunchMcpServers =
  | { ok: true; servers: McpServerConfig[]; issues: McpValidationIssue[] }
  | { ok: false; message: string; issues: McpValidationIssue[] }

/**
 * The person's servers for one launch of `client`: enabled, synced, and listed
 * for that CLI. Scope does not narrow it — a launch-scoped server reaches that
 * one session whichever config file the sync would have written it to.
 */
export async function resolveLaunchMcpServers(input: {
  settings: McpSettings | undefined
  client: McpClientTarget
}): Promise<LaunchMcpServers> {
  const settings = normalizeSettings(input.settings)
  const issues: McpValidationIssue[] = []
  if (!settings.syncEnabled) return { ok: true, servers: [], issues }
  const servers = Object.values(settings.servers).filter(
    (server) => server.enabled && server.clients.includes(input.client),
  )
  for (const server of servers) issues.push(...(await validateServer(server)))
  const blocking = issues.find((issue) => issue.level === 'error')
  if (blocking) return { ok: false, message: blocking.message, issues }
  return { ok: true, servers, issues }
}

/** A Claude-format `{ "mcpServers": … }` document, as `--mcp-config` reads it. */
export function claudeMcpConfigDocument(servers: readonly McpServerConfig[]): Record<string, unknown> {
  return { mcpServers: Object.fromEntries(servers.map((server) => [server.id, toClaudeServer(server)])) }
}

/** OpenCode's `mcp` table entries, and what it cannot represent (an SSE server). */
export function opencodeMcpEntries(servers: readonly McpServerConfig[]): {
  entries: Record<string, unknown>
  skipped: McpServerConfig[]
} {
  const entries: Record<string, unknown> = {}
  const skipped: McpServerConfig[] = []
  for (const server of servers) {
    if (server.transport === 'sse') skipped.push(server)
    else entries[server.id] = toOpencodeServer(server)
  }
  return { entries, skipped }
}

/**
 * Servers as Codex `-c mcp_servers.<id>=<table>` overrides: one inline TOML
 * table each, with the fields `renderCodexServer` writes into a config file.
 * Their env values and header values are not in the tables but in `env`, for
 * the launch's environment, and the tables name the variables
 * (codex-mcp-overrides.ts). `base` is the environment the launch starts from.
 * Codex reads an override's key as a dotted path, so an id with a dot in it
 * cannot be named; it is left out and returned in `skipped`.
 */
export function codexMcpOverrideArgs(
  servers: readonly McpServerConfig[],
  base: Readonly<Record<string, string | undefined>> = process.env,
): {
  args: string[]
  env: Record<string, string>
  skipped: McpServerConfig[]
} {
  const args: string[] = []
  const skipped: McpServerConfig[] = []
  const carrier = codexMcpEnv(base)
  for (const server of servers) {
    if (!/^[A-Za-z0-9_-]+$/.test(server.id)) {
      skipped.push(server)
      continue
    }
    const fields = codexMcpServerFields(server, carrier)
    fields.push(['enabled', server.enabled ? 'true' : 'false'])
    if (server.required) fields.push(['required', 'true'])
    args.push('-c', `mcp_servers.${server.id}=${tomlInlineTable(fields)}`)
  }
  return { args, env: carrier.env, skipped }
}

// ── The gateway a launch carries itself ─────────────────────────────────────

/** The bridge every managed gateway entry runs, whichever build wrote it. */
const STUDIO_BRIDGE_SCRIPT_NAME = 'mcp-stdio-bridge.mjs'

/**
 * Take the app's own gateway back out of a Claude-format workspace config.
 *
 * A Claude Code launch that carries the app's plugin directory gets the gateway
 * from that plugin's `.mcp.json`, for that session only. The entry the
 * per-launch sync used to pin into the repository's `.mcp.json` — an absolute
 * path to this build's executable and bridge, in a file projects commit — is
 * then a second copy of the same server, and one a `claude` started from a
 * plain terminal in that checkout would load too. So it comes out, together
 * with the approval `enableStudioMcpForClaudeWorkspace` granted it in
 * `.claude/settings.local.json`.
 *
 * Narrow about what counts as ours, because `.mcp.json` is the person's file:
 * only an entry under the gateway's id that runs the bundled bridge with
 * `ELECTRON_RUN_AS_NODE` is removed — a repository that put something else
 * under that id keeps it (and never gets it approved, the rule the approval
 * writer already follows). The retired Sprint Engine id is dropped
 * unconditionally, exactly as every gateway sync pass has always done.
 *
 * Never creates a file. A config left with nothing in it is deleted rather than
 * left behind as `{ "mcpServers": {} }`, since the app is the only thing that
 * would have created it. Best-effort: an unreadable or unparseable file is left
 * exactly as it is, and the returned list says what was changed.
 */
export async function removeManagedStudioGatewayFromClaudeWorkspace(workspaceRoot: string): Promise<string[]> {
  const changed: string[] = []
  const root = workspaceRoot.trim()
  if (root === '') return changed

  // Each file under its own lock, `.mcp.json` first: the order a sync takes
  // them in, so this pass and a concurrent sync never interleave on either.
  const mcpJsonPath = join(root, '.mcp.json')
  const mcpJsonChanged = await withConfigFileLock(mcpJsonPath, async () => {
    const mcpJson = await readJsonObject(mcpJsonPath)
    if (!mcpJson || !isPlainRecord(mcpJson.mcpServers)) return false
    const servers = { ...mcpJson.mcpServers }
    let touched = false
    if (isManagedStudioGatewayEntry(servers[STUDIO_MCP_SERVER_ID])) {
      delete servers[STUDIO_MCP_SERVER_ID]
      touched = true
    }
    if (RETIRED_SPRINTENGINE_MCP_SERVER_ID in servers) {
      delete servers[RETIRED_SPRINTENGINE_MCP_SERVER_ID]
      touched = true
    }
    return touched && (await writeOrRemoveJsonObject(mcpJsonPath, { ...mcpJson, mcpServers: servers }, ['mcpServers']))
  })
  if (mcpJsonChanged) changed.push('.mcp.json')

  const settingsPath = join(root, '.claude', 'settings.local.json')
  const settingsChanged = await withConfigFileLock(settingsPath, async () => {
    const settings = await readJsonObject(settingsPath)
    if (!settings || !Array.isArray(settings.enabledMcpjsonServers)) return false
    const enabled = settings.enabledMcpjsonServers as unknown[]
    const kept = enabled.filter((id) => id !== STUDIO_MCP_SERVER_ID && id !== RETIRED_SPRINTENGINE_MCP_SERVER_ID)
    if (kept.length === enabled.length) return false
    const next: Record<string, unknown> = { ...settings }
    if (kept.length > 0) next.enabledMcpjsonServers = kept
    else delete next.enabledMcpjsonServers
    if (!(await writeOrRemoveJsonObject(settingsPath, next, []))) return false
    // The directory too, when the app's file was all it held.
    try {
      await rmdir(join(root, '.claude'))
    } catch {
      // Not empty, or not ours to remove: either way it stays.
    }
    return true
  })
  if (settingsChanged) changed.push('.claude/settings.local.json')
  return changed
}

/**
 * Take the sync's managed block back out of a workspace's `.codex/config.toml`,
 * for a launch that hands Codex its servers as `-c` overrides. The whole block
 * goes, not just the gateway: everything between its markers is what the sync
 * rendered from the person's settings, and the launch now carries all of it.
 * A file left empty is deleted when `mayDelete` allows it (git does not track
 * it), with `.codex/` when nothing else is in it.
 */
export async function removeCodexManagedBlockFromWorkspace(
  workspaceRoot: string,
  mayDelete: (path: string) => Promise<boolean>,
): Promise<boolean> {
  const path = join(workspaceRoot, '.codex', 'config.toml')
  return withConfigFileLock(path, async () => {
    const raw = await readFile(path, 'utf8').catch(() => null)
    if (raw === null || !raw.includes(MANAGED_START)) return false
    const next = replaceManagedBlock(raw, '')
    if (next === raw) return false
    if (next.trim() === '' && (await mayDelete(path))) {
      await unlink(path).catch(() => undefined)
      await rmdir(dirname(path)).catch(() => undefined)
    } else {
      await writeFileAtomically(path, next)
    }
    return true
  })
}

/**
 * Take the gateway an earlier launch pinned out of a workspace's
 * `.cursor/mcp.json`, for a launch that hands Cursor its servers in a plugin
 * directory. Only an entry that runs the app's bridge; a file left with
 * nothing in it is deleted when `mayDelete` allows, with `.cursor/` when empty.
 */
export async function removeCursorWorkspaceMcp(
  workspaceRoot: string,
  mayDelete: (path: string) => Promise<boolean>,
): Promise<boolean> {
  const path = join(workspaceRoot, '.cursor', 'mcp.json')
  return withConfigFileLock(path, async () => {
    const config = await readJsonObject(path)
    if (!config || !isPlainRecord(config.mcpServers)) return false
    if (!isManagedStudioGatewayEntry(config.mcpServers[STUDIO_MCP_SERVER_ID])) return false
    const servers = { ...config.mcpServers }
    delete servers[STUDIO_MCP_SERVER_ID]
    const next = { ...config, mcpServers: servers }
    const empty = Object.keys(servers).length === 0 && Object.keys(config).length === 1
    if (empty && (await mayDelete(path))) {
      await unlink(path).catch(() => undefined)
      await rmdir(dirname(path)).catch(() => undefined)
      return true
    }
    await writeFileAtomically(path, `${JSON.stringify(next, null, 2)}\n`)
    return true
  })
}

/**
 * Take the gateway an earlier launch pinned out of a workspace's
 * `opencode.json`, for a launch that hands OpenCode its servers in its config
 * content. Only an entry that runs the app's bridge; a file left with nothing
 * in it is deleted.
 */
export async function removeOpencodeGatewayFromWorkspace(workspaceRoot: string): Promise<boolean> {
  const path = join(workspaceRoot, 'opencode.json')
  return withConfigFileLock(path, async () => {
    const config = await readJsonObject(path)
    if (!config || !isPlainRecord(config.mcp)) return false
    const entry = config.mcp[STUDIO_MCP_SERVER_ID]
    if (!isPlainRecord(entry) || !Array.isArray(entry.command)) return false
    const [command, ...args] = entry.command as unknown[]
    const env = isPlainRecord(entry.environment) ? entry.environment : {}
    if (!isManagedStudioGatewayEntry({ command, args, env })) return false
    const servers = { ...config.mcp }
    delete servers[STUDIO_MCP_SERVER_ID]
    const next: Record<string, unknown> = { ...config, mcp: servers }
    if (Object.keys(servers).length === 0) delete next.mcp
    return writeOrRemoveJsonObject(path, next, [])
  })
}

/**
 * Whether an MCP server entry is the app's gateway: the launcher's `mcp`
 * target, or the older shape — the bundled bridge run by the app's own binary
 * (`ELECTRON_RUN_AS_NODE`) or a distribution's pinned Node.
 */
export function isManagedStudioGatewayEntry(entry: unknown): boolean {
  if (!isPlainRecord(entry)) return false
  if (isLauncherMcpServer(entry)) return true
  const args = Array.isArray(entry.args) ? entry.args : []
  const script = typeof args[0] === 'string' ? args[0].replace(/\\/g, '/') : ''
  const env = isPlainRecord(entry.env) ? entry.env : {}
  return args.length === 1 && script.endsWith(`/${STUDIO_BRIDGE_SCRIPT_NAME}`) && env.ELECTRON_RUN_AS_NODE === '1'
}

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

async function readJsonObject(path: string): Promise<Record<string, unknown> | null> {
  try {
    const parsed: unknown = JSON.parse(await readFile(path, 'utf8'))
    return isPlainRecord(parsed) ? parsed : null
  } catch {
    return null
  }
}

/**
 * Write `value`, or delete the file when nothing is left in it: no keys at all,
 * or only `emptyRecordKeys` holding empty objects. Returns whether it succeeded.
 */
async function writeOrRemoveJsonObject(
  path: string,
  value: Record<string, unknown>,
  emptyRecordKeys: readonly string[],
): Promise<boolean> {
  const meaningful = Object.entries(value).filter(
    ([key, entry]) => !(emptyRecordKeys.includes(key) && isPlainRecord(entry) && Object.keys(entry).length === 0),
  )
  try {
    if (meaningful.length === 0) await unlink(path)
    else await writeFileAtomically(path, `${JSON.stringify(value, null, 2)}\n`)
    return true
  } catch {
    return false
  }
}
