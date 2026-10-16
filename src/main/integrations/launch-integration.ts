// What a launch hands its CLI through the CLI's own per-launch channels, so
// nothing of the app's has to be written into the repository it runs in.
//
// Studio must not leave a file in a person's project that they would need to
// gitignore (owner ruling 2026-10-16). The MCP servers, the agent-state hook
// and the skills a launch needs reach the session instead from the launch's
// own command line or environment, naming files under this profile's userData
// directory — where the CLI has such a channel. Each route below says what it
// was measured against; a CLI with none keeps its user-level registration
// (Kimi Code, Cursor's and Grok's hooks), written while the app runs and taken
// back out when it quits.
//
//   claude   (Claude Code, Z.AI, Kimi Claude) — the gateway, the hook and the
//            app's skills already ride `--plugin-dir`; the person's synced
//            servers go as `--mcp-config <file>`, the knowledge-activity hook
//            joins the launch's one `--settings` document, and a module's
//            skill is a plugin of its own beside the app's.
//   codex    — `-c mcp_servers.<id>={…}` for the gateway and the synced
//            servers, `-c hooks.<Event>=[…]` for the agent-state hook.
//   opencode — `OPENCODE_CONFIG_CONTENT`: the agent-state plugin by `file://`
//            URL, the `mcp` table, and `skills.paths` for a launch skill.
//
// The files named here are content-addressed (the same document is the same
// file, so a resumed session finds what it was launched with) and owner-only,
// since a synced server's environment can hold a secret. Nothing is reaped per
// session: every agent dies with the app, so `pruneLaunchFiles` empties the
// directory at the next start.

import { createHash } from 'node:crypto'
import { existsSync } from 'node:fs'
import { mkdir, readdir, readFile, rename, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'

import type { McpClientTarget, McpServerConfig, McpSettings } from '../../shared/electron-api'
import type { PluginAgentStateSpec, PluginLaunchIntegrationSpec } from '../../shared/plugin-manifest'
import { STUDIO_MCP_SERVER_ID, STUDIO_MCP_SERVER_NAME } from '../../shared/product-identity'
import { MCP_CHANNEL_TOKEN_ENV } from '../../shared/studio-env'
import { writeFileAtomic } from '../../server/platform/atomic-file'
import { registeredAgentStateEvents, renderAgentStatePluginTemplate } from '../agent-state'
import { writeSkillPlugin } from '../agent-integration-home'
import {
  copySkillDirectory,
  hashSkillDirectory,
  MANAGED_SKILL_MANIFEST_FILE,
  readManagedSkillManifest,
  writeManagedSkillManifest,
} from '../builtin-skills'
import type { HostAgentIntegration } from '../hosts/execution-host'
import {
  claudeMcpConfigDocument,
  codexMcpOverrideArgs,
  opencodeMcpEntries,
  removeCodexManagedBlockFromWorkspace,
  removeCursorWorkspaceMcp,
  removeManagedStudioGatewayFromClaudeWorkspace,
  removeOpencodeGatewayFromWorkspace,
  resolveLaunchMcpServers,
} from '../mcp-config-service'
import { recordIntegrationWrite } from './ledger'

/** Which per-launch channels a CLI's manifest says it takes (`launchIntegration.route`). */
export type LaunchIntegrationRoute = PluginLaunchIntegrationSpec['route']

/** Under userData: the files a launch's flags and environment name. */
export const LAUNCH_FILES_DIR = join('agent-integration', 'launch')

/** What one launch carries, and so what no workspace writer may write for it. */
export type LaunchIntegration = {
  args: string[]
  env: Record<string, string>
  /** Joins the launch's one `--settings` document (Claude Code). */
  settings?: Record<string, unknown>
  /** Plugin directories beside the app's own (Claude Code). */
  pluginDirs?: string[]
  carries: {
    /** The gateway and the person's synced servers. */
    mcp: boolean
    /** The agent-state hook. */
    agentState: boolean
    /** Skill ids this launch is handed itself. */
    skills: readonly string[]
  }
  /** Synced servers this CLI cannot be handed, for a diagnostic. */
  skippedServers: string[]
}

// What the bridge's connect frame reads from its environment (the CLI is baked
// into the entry itself).
const GATEWAY_IDENTITY_ENV = ['SPRINTENGINE_WORKSPACE_ID', 'SPRINTENGINE_AGENT_ID', 'SPRINTENGINE_AGENT_NAME'] as const

/** The app's gateway as a stdio server on this machine (see `studioGatewayFor`). */
export type LaunchGateway = { command: string; args: string[]; env: Record<string, string> }

/** A skill a launch is handed: its id, and the directory holding its SKILL.md. */
export type LaunchSkill = { id: string; sourceDir: string }

/**
 * The gateway as a server entry for `cli`. Its identity rides in the entry
 * (`SPRINTENGINE_AGENT_CLI`), and for a CLI that passes a server only the
 * variables it names (Codex), the agent's ids and its launch token are named
 * too, so the bridge can still prove which launch it belongs to.
 */
export function launchGatewayServer(
  gateway: LaunchGateway,
  cli: string,
  options: { passIdentityByName?: boolean } = {},
): McpServerConfig {
  return {
    id: STUDIO_MCP_SERVER_ID,
    name: STUDIO_MCP_SERVER_NAME,
    transport: 'stdio',
    command: gateway.command,
    args: gateway.args,
    env: { ...gateway.env, SPRINTENGINE_AGENT_CLI: cli },
    ...(options.passIdentityByName ? { envVarNames: [...GATEWAY_IDENTITY_ENV, MCP_CHANNEL_TOKEN_ENV] } : {}),
    enabled: true,
    required: false,
    clients: [cli],
    scope: 'workspace',
    source: 'bundled',
    riskLevel: 'local-command',
    capabilities: ['studio'],
  }
}

/**
 * Write `content` under `dir` as `<prefix>-<hash><ext>`, owner-only, unless
 * that file is already there. Returns its path.
 */
export async function writeLaunchFile(dir: string, prefix: string, ext: string, content: string): Promise<string> {
  const hash = createHash('sha256').update(content).digest('hex').slice(0, 20)
  const path = join(dir, `${prefix}-${hash}${ext}`)
  if (existsSync(path) && (await readFile(path, 'utf8').catch(() => null)) === content) return path
  await mkdir(dir, { recursive: true, mode: 0o700 })
  await writeFileAtomic(path, content, { mode: 0o600, exactMode: true })
  return path
}

/** Empty the launch-files directory. Safe at startup only: no session the app launched outlives it. */
export async function pruneLaunchFiles(dir: string): Promise<void> {
  const names = await readdir(dir).catch(() => null)
  if (names === null) return
  await Promise.all(names.map((name) => rm(join(dir, name), { recursive: true, force: true }).catch(() => undefined)))
}

// ── Claude Code ─────────────────────────────────────────────────────────────

export type ClaudeLaunchInput = {
  dir: string
  /** The person's synced servers for this CLI; the gateway rides the app's plugin. */
  servers: readonly McpServerConfig[]
  /** The knowledge-activity hook command, when this workspace opted in. */
  knowledgeActivityCommand?: string | null
  /** One-skill plugin directories (a module's skill the prompt invokes). */
  skillPluginDirs?: ReadonlyArray<{ id: string; dir: string }>
  /** Skills the launch already carries as the app's own one-skill plugins. */
  bundledSkills?: readonly string[]
}

/**
 * `--mcp-config <file>` and the settings fragment, for a launch that also
 * carries the app's plugin directory. Measured against Claude Code 2.1.296 on
 * 2026-10-16: a server from `--mcp-config` starts with no approval prompt,
 * merges with the project's and the person's own servers, and wins over a
 * same-named one; hooks in `--settings` fire beside the project's and every
 * plugin's.
 */
export async function buildClaudeLaunchIntegration(input: ClaudeLaunchInput): Promise<LaunchIntegration> {
  const args: string[] = []
  if (input.servers.length > 0) {
    const document = `${JSON.stringify(claudeMcpConfigDocument(input.servers), null, 2)}\n`
    args.push('--mcp-config', await writeLaunchFile(input.dir, 'claude-mcp', '.json', document))
  }
  const settings = input.knowledgeActivityCommand
    ? { hooks: knowledgeActivityHooks(input.knowledgeActivityCommand) }
    : undefined
  const skillPluginDirs = input.skillPluginDirs ?? []
  return {
    args,
    env: {},
    ...(settings ? { settings } : {}),
    ...(skillPluginDirs.length > 0 ? { pluginDirs: skillPluginDirs.map((plugin) => plugin.dir) } : {}),
    carries: {
      mcp: true,
      agentState: true,
      skills: [...(input.bundledSkills ?? []), ...skillPluginDirs.map((plugin) => plugin.id)],
    },
    skippedServers: [],
  }
}

/** The PostToolUse block the knowledge-activity hook has always registered. */
export function knowledgeActivityHooks(command: string): Record<string, unknown> {
  return { PostToolUse: [{ matcher: 'Read|Edit|Write', hooks: [{ type: 'command', command }] }] }
}

// ── Codex ───────────────────────────────────────────────────────────────────

export type CodexLaunchInput = {
  gateway: McpServerConfig | null
  servers: readonly McpServerConfig[]
  /** The agent-state hook: the command every registered event runs. */
  agentState?: { spec: PluginAgentStateSpec; command: string } | null
}

/**
 * Codex's `-c` overrides. The gateway and the synced servers as
 * `mcp_servers.<id>` tables (verified against codex-cli 0.161.0: an override
 * merges into a configured table of the same name, and `codex mcp list` shows
 * it); the hook as one `hooks.<Event>` array per registered event, the shape a
 * `[[hooks.<Event>]]` table in `config.toml` parses to.
 */
export function buildCodexLaunchIntegration(input: CodexLaunchInput): LaunchIntegration {
  const servers = [
    ...(input.gateway ? [input.gateway] : []),
    ...input.servers.filter((server) => server.id !== STUDIO_MCP_SERVER_ID),
  ]
  const mcp = codexMcpOverrideArgs(servers)
  const hookArgs = input.agentState ? codexAgentStateHookArgs(input.agentState.spec, input.agentState.command) : []
  return {
    args: [...mcp.args, ...hookArgs],
    env: {},
    carries: { mcp: true, agentState: hookArgs.length > 0, skills: [] },
    skippedServers: mcp.skipped.map((server) => server.id),
  }
}

export function codexAgentStateHookArgs(spec: PluginAgentStateSpec, command: string): string[] {
  const str = (value: string) => JSON.stringify(value)
  const byEvent = new Map<string, string[]>()
  for (const { event, matcher } of registeredAgentStateEvents(spec)) {
    const fields = [
      ...(matcher !== undefined ? [`matcher = ${str(matcher)}`] : []),
      `hooks = [{ type = "command", command = ${str(command)} }]`,
    ]
    byEvent.set(event, [...(byEvent.get(event) ?? []), `{ ${fields.join(', ')} }`])
  }
  return [...byEvent].flatMap(([event, blocks]) => ['-c', `hooks.${event}=[${blocks.join(', ')}]`])
}

// ── OpenCode ────────────────────────────────────────────────────────────────

export type OpencodeLaunchInput = {
  dir: string
  gateway: McpServerConfig | null
  servers: readonly McpServerConfig[]
  /** The bundled plugin template and the socket to bake into it, or null for no hook. */
  agentState?: { templatePath: string; socketPath: string } | null
  skills?: readonly LaunchSkill[]
}

/**
 * One `OPENCODE_CONFIG_CONTENT` document, merged with the host context's
 * `instructions` by the launch (`mergeProviderLaunchEnv`). Verified against
 * opencode 1.18.32 on 2026-10-16: a `plugin` entry naming a `file://` URL is
 * loaded beside the person's own plugins with nothing installed next to it;
 * `mcp` merges field by field with the project's and the person's tables and
 * wins on the same id; `skills.paths` adds folders it scans for SKILL.md.
 */
export async function buildOpencodeLaunchIntegration(input: OpencodeLaunchInput): Promise<LaunchIntegration> {
  const content: Record<string, unknown> = {}
  let agentState = false
  if (input.agentState) {
    const template = await readFile(input.agentState.templatePath, 'utf8').catch(() => null)
    if (template !== null) {
      // `.js`: OpenCode's loader does not pick up `.mjs`.
      const path = await writeLaunchFile(
        input.dir,
        'opencode-agent-state',
        '.js',
        renderAgentStatePluginTemplate(template, input.agentState.socketPath),
      )
      content.plugin = [pathToFileURL(path).href]
      agentState = true
    }
  }
  const servers = [
    ...(input.gateway ? [input.gateway] : []),
    ...input.servers.filter((server) => server.id !== STUDIO_MCP_SERVER_ID),
  ]
  const mcp = opencodeMcpEntries(servers)
  if (Object.keys(mcp.entries).length > 0) content.mcp = mcp.entries
  const skills = input.skills ?? []
  if (skills.length > 0) content.skills = { paths: skills.map((skill) => skill.sourceDir) }
  return {
    args: [],
    env: Object.keys(content).length > 0 ? { OPENCODE_CONFIG_CONTENT: JSON.stringify(content) } : {},
    carries: { mcp: true, agentState, skills: skills.map((skill) => skill.id) },
    skippedServers: mcp.skipped.map((server) => server.id),
  }
}

// ── Cursor ──────────────────────────────────────────────────────────────────

export type CursorLaunchInput = {
  dir: string
  gateway: McpServerConfig | null
  servers: readonly McpServerConfig[]
  skills?: readonly LaunchSkill[]
}

/** The plugin's directory name, which Cursor builds a server's name from (`plugin-<dir>-<server>`). */
const CURSOR_PLUGIN_DIR_NAME = 'sprintengine-studio'

/**
 * One more `--plugin-dir`, holding the gateway, the synced servers and the
 * launch skill. Measured against cursor-agent 2026.10.14 on 2026-10-16: a
 * plugin's `.mcp.json` server starts with no server-approval dialog (a
 * project `.cursor/mcp.json` one stops the start at one), and its
 * `skills/<id>/SKILL.md` loads. The hook is not here: a plugin's `stop` and
 * `beforeSubmitPrompt` hooks run only when the person's or the project's own
 * hooks file names the same event, so it stays in the user-level file.
 */
export async function buildCursorLaunchIntegration(input: CursorLaunchInput): Promise<LaunchIntegration> {
  const servers = [
    ...(input.gateway ? [input.gateway] : []),
    ...input.servers.filter((server) => server.id !== STUDIO_MCP_SERVER_ID),
  ]
  const skills = input.skills ?? []
  if (servers.length === 0 && skills.length === 0) {
    return { args: [], env: {}, carries: { mcp: true, agentState: false, skills: [] }, skippedServers: [] }
  }
  const mcpJson = `${JSON.stringify(claudeMcpConfigDocument(servers), null, 2)}\n`
  const skillHashes = await Promise.all(
    skills.map(async (skill) => `${skill.id}:${await hashSkillDirectory(skill.sourceDir)}`),
  )
  const key = createHash('sha256').update(mcpJson).update(skillHashes.join('\n')).digest('hex').slice(0, 20)
  const root = join(input.dir, `cursor-${key}`, CURSOR_PLUGIN_DIR_NAME)
  if (!existsSync(join(root, '.cursor-plugin', 'plugin.json'))) {
    const staging = `${root}.${process.pid}.tmp`
    await rm(staging, { recursive: true, force: true })
    await mkdir(join(staging, '.cursor-plugin'), { recursive: true, mode: 0o700 })
    await writeFileAtomic(join(staging, '.mcp.json'), mcpJson, { mode: 0o600, exactMode: true })
    for (const skill of skills) await copySkillDirectory(skill.sourceDir, join(staging, 'skills', skill.id))
    // Last, so a half-written directory is never taken for a finished one.
    await writeFileAtomic(
      join(staging, '.cursor-plugin', 'plugin.json'),
      `${JSON.stringify({ name: CURSOR_PLUGIN_DIR_NAME, description: 'SprintEngine Studio, for this launch.', version: '1.0.0' }, null, 2)}\n`,
      { mode: 0o600, exactMode: true },
    )
    await rm(root, { recursive: true, force: true })
    await rename(staging, root)
  }
  return {
    args: ['--plugin-dir', root],
    env: {},
    carries: { mcp: true, agentState: false, skills: skills.map((skill) => skill.id) },
    skippedServers: [],
  }
}

// ── Deciding, per launch ────────────────────────────────────────────────────

export type PrepareLaunchIntegrationInput = {
  workspaceRoot: string
  cli: string
  settings: McpSettings
  /** The skills the launch's prompt invokes. */
  skillIds: readonly string[]
  hostId?: string
  integration?: HostAgentIntegration | null
  connectorLaunch: boolean
}

export type PrepareLaunchIntegrationDeps = {
  /** The manifest's `launchIntegration`, or null for a CLI that declares none. */
  spec: (cli: string) => PluginLaunchIntegrationSpec | null
  /** The home a user-level skill copy goes under. */
  homeDir: () => string
  /** A skill's id and version as the managed manifest records them, or null for an unknown id. */
  skill: (skillId: string) => { id: string; version: string } | null
  /** Whether `hostId` is this machine. A WSL launch is built from what its helper holds instead. */
  isThisMachine: (hostId: string | undefined) => boolean
  /** Whether the launch carries the app's plugin directory (`launchCarriesAppPlugins`). */
  carriesAppPlugins: (
    cli: string,
    hostId: string | undefined,
    integration: HostAgentIntegration | null | undefined,
  ) => boolean
  launchFilesDir: () => string
  gateway: (hostId: string | undefined) => LaunchGateway | null
  agentStateSpec: (cli: string) => PluginAgentStateSpec | null
  /** The command a command-hook registration runs on this machine, or null when the reporter is missing. */
  agentStateHookCommand: () => string | null
  /** A plugin-file registration's bundled template, by the name the manifest gives it. */
  agentStateTemplatePath: (template: string) => string | null
  socketPath: () => string
  /** The app's own one-skill plugin for a bundled skill, when this build's copy holds it. */
  bundledSkillPluginDir: (skillId: string) => string | null
  /** The directory holding a skill's SKILL.md (bundled, or a module's), or null for an unknown id. */
  skillSourceDir: (skillId: string) => string | null
  /** The knowledge-activity hook command for this workspace, when it opted in. */
  knowledgeActivityCommand: (workspaceRoot: string) => Promise<string | null>
  /** Whether git tracks a file, so a tidy never deletes a committed one. */
  gitTracks: (path: string) => Promise<boolean>
  warn?: (message: string) => void
}

export type PreparedLaunchIntegration =
  { ok: true; integration: LaunchIntegration | null } | { ok: false; message: string }

/**
 * What this launch is handed through its CLI's own channels, or null when it
 * has no such route and the workspace writers carry it as before: another
 * machine (WSL), a connector launch (its worktree config is the isolation the
 * connector promises, and is kept out of git by the worktree's own exclude),
 * a CLI whose manifest declares no route, or a Claude-family launch whose
 * plugin copy is not there. What an earlier build wrote into the workspace for
 * what the launch now carries is taken out on the way.
 */
export async function prepareLaunchIntegration(
  input: PrepareLaunchIntegrationInput,
  deps: PrepareLaunchIntegrationDeps,
): Promise<PreparedLaunchIntegration> {
  const spec = deps.spec(input.cli)
  if (!spec || input.connectorLaunch || !deps.isThisMachine(input.hostId)) return { ok: true, integration: null }
  const route = spec.route
  if (route === 'claude' && !deps.carriesAppPlugins(input.cli, input.hostId, input.integration)) {
    return { ok: true, integration: null }
  }
  if (!route) {
    // No channel of its own: only the launch skill, copied where the CLI reads
    // the person's own skills while the app runs.
    const skills = await userLevelLaunchSkills(input, spec, deps)
    if (skills.length === 0) return { ok: true, integration: null }
    return {
      ok: true,
      integration: { args: [], env: {}, carries: { mcp: false, agentState: false, skills }, skippedServers: [] },
    }
  }
  const resolved = await resolveLaunchMcpServers({ settings: input.settings, client: input.cli as McpClientTarget })
  if (!resolved.ok) return { ok: false, message: resolved.message }
  for (const issue of resolved.issues) deps.warn?.(issue.message)
  const dir = deps.launchFilesDir()
  const gatewayEntry = deps.gateway(input.hostId)
  const mayDelete = async (path: string) => !(await deps.gitTracks(path))

  let integration: LaunchIntegration
  if (route === 'claude') {
    const bundledSkills: string[] = []
    const skillPluginDirs: Array<{ id: string; dir: string }> = []
    for (const skillId of new Set(input.skillIds)) {
      if (deps.bundledSkillPluginDir(skillId)) {
        bundledSkills.push(skillId)
        continue
      }
      const source = deps.skillSourceDir(skillId)
      if (!source) continue
      const pluginDir = await writeModuleSkillPlugin(dir, skillId, source).catch(() => null)
      if (pluginDir) skillPluginDirs.push({ id: skillId, dir: pluginDir })
    }
    integration = await buildClaudeLaunchIntegration({
      dir,
      servers: resolved.servers,
      knowledgeActivityCommand: await deps.knowledgeActivityCommand(input.workspaceRoot).catch(() => null),
      skillPluginDirs,
      bundledSkills,
    })
    await removeManagedStudioGatewayFromClaudeWorkspace(input.workspaceRoot).catch(() => [])
  } else if (route === 'codex') {
    const stateSpec = deps.agentStateSpec(input.cli)
    const command = stateSpec?.registration.kind === 'toml-block' ? deps.agentStateHookCommand() : null
    integration = buildCodexLaunchIntegration({
      gateway: gatewayEntry ? launchGatewayServer(gatewayEntry, input.cli, { passIdentityByName: true }) : null,
      servers: resolved.servers,
      agentState: stateSpec && command ? { spec: stateSpec, command } : null,
    })
    await removeCodexManagedBlockFromWorkspace(input.workspaceRoot, mayDelete).catch(() => false)
    const skills = await userLevelLaunchSkills(input, spec, deps)
    if (skills.length > 0) integration = { ...integration, carries: { ...integration.carries, skills } }
  } else if (route === 'cursor') {
    integration = await buildCursorLaunchIntegration({
      dir,
      gateway: gatewayEntry ? launchGatewayServer(gatewayEntry, input.cli) : null,
      servers: resolved.servers,
      skills: launchSkillSources(input, deps),
    })
    await removeCursorWorkspaceMcp(input.workspaceRoot, mayDelete).catch(() => false)
  } else {
    const stateSpec = deps.agentStateSpec(input.cli)
    const templatePath =
      stateSpec?.registration.kind === 'plugin-file'
        ? deps.agentStateTemplatePath(stateSpec.registration.template)
        : null
    const skills = launchSkillSources(input, deps)
    integration = await buildOpencodeLaunchIntegration({
      dir,
      gateway: gatewayEntry ? launchGatewayServer(gatewayEntry, input.cli) : null,
      servers: resolved.servers,
      agentState: templatePath ? { templatePath, socketPath: deps.socketPath() } : null,
      skills,
    })
    await removeOpencodeGatewayFromWorkspace(input.workspaceRoot).catch(() => false)
  }
  for (const id of integration.skippedServers) {
    deps.warn?.(`MCP server "${id}" cannot be handed to ${input.cli} at launch, so this session starts without it.`)
  }
  return { ok: true, integration }
}

function launchSkillSources(input: PrepareLaunchIntegrationInput, deps: PrepareLaunchIntegrationDeps): LaunchSkill[] {
  const skills: LaunchSkill[] = []
  for (const skillId of new Set(input.skillIds)) {
    const source = deps.skillSourceDir(skillId)
    if (source) skills.push({ id: skillId, sourceDir: source })
  }
  return skills
}

/** A module skill as a one-skill plugin under `dir`, keyed by its content so an edit makes a new one. */
async function writeModuleSkillPlugin(dir: string, skillId: string, sourceDir: string): Promise<string> {
  const hash = (await hashSkillDirectory(sourceDir)).slice(0, 16)
  const pluginDir = join(dir, `skill-${skillId}-${hash}`)
  if (existsSync(join(pluginDir, 'skills', skillId, 'SKILL.md'))) return pluginDir
  await writeSkillPlugin(pluginDir, skillId, sourceDir)
  return pluginDir
}

/**
 * Copy each launch skill into `<home>/<userSkillsDir>/<id>`, for a CLI with no
 * launch-time skill folder (Codex measured on 2026-10-16: no flag, no `-c` key
 * adds one). The copy carries the managed manifest and is listed in the
 * ledger, so the quit takes it back out; a skill of that name the person keeps
 * there is theirs, and is what the launch then runs. Returns the ids present.
 */
async function userLevelLaunchSkills(
  input: PrepareLaunchIntegrationInput,
  spec: PluginLaunchIntegrationSpec,
  deps: PrepareLaunchIntegrationDeps,
): Promise<string[]> {
  if (!spec.userSkillsDir) return []
  const present: string[] = []
  for (const skillId of new Set(input.skillIds)) {
    const skill = deps.skill(skillId)
    const source = deps.skillSourceDir(skillId)
    if (!skill || !source) continue
    const result = await ensureUserLevelSkillCopy({
      skillsDir: join(deps.homeDir(), ...spec.userSkillsDir.split('/')),
      skill,
      sourceDir: source,
      cli: input.cli,
    }).catch(() => null)
    if (result) present.push(skillId)
  }
  return present
}

/** The ledger marker of a user-level launch skill copy: recognised by its managed manifest. */
export const LAUNCH_SKILL_COPY_MARKER = 'managed-manifest'

/**
 * Make `<skillsDir>/<id>` this skill: written when absent, refreshed when it is
 * the app's untouched copy of older bytes, left alone when it is anyone
 * else's. Returns the directory, or null when nothing usable is there.
 */
export async function ensureUserLevelSkillCopy(input: {
  skillsDir: string
  skill: { id: string; version: string }
  sourceDir: string
  cli: string
}): Promise<string | null> {
  const destination = join(input.skillsDir, input.skill.id)
  const sourceHash = await hashSkillDirectory(input.sourceDir)
  if (existsSync(destination)) {
    const manifest = await readManagedSkillManifest(destination)
    if (!manifest || manifest.id !== input.skill.id) return destination
    const current = await hashSkillDirectory(destination, new Set([MANAGED_SKILL_MANIFEST_FILE]))
    if (current !== manifest.installedSkillHash) return destination
    if (manifest.sourceHash === sourceHash && manifest.version === input.skill.version) return destination
  }
  await copySkillDirectory(input.sourceDir, destination)
  await writeManagedSkillManifest({ destinationDir: destination, skill: input.skill, sourceHash })
  recordIntegrationWrite({
    kind: 'skill-copy',
    path: destination,
    marker: LAUNCH_SKILL_COPY_MARKER,
    hostId: 'local',
    cli: input.cli,
    createdFile: true,
  })
  return destination
}
