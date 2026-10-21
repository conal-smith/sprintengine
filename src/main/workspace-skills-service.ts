import { existsSync, readFileSync, readdirSync, statSync } from 'fs'
import { readdir, readFile, stat } from 'fs/promises'
import { homedir } from 'os'
import { join, resolve } from 'path'
import type {
  BuiltinSkill,
  SkillHarness,
  WorkspaceSkill,
  WorkspaceSkillsListInput,
  WorkspaceSkillsListResult,
} from '../shared/electron-api'
import { buildHarnessMap, type HarnessBinding } from '../shared/harness-map'
import type { CapabilityWatcher } from './capability-watcher'
import type { PluginManifest, PluginRegistryListEntry } from '../shared/plugin-manifest'
import type { McpServerResolver, ResolvedMcpServers } from './mcp-config-readers/resolve-servers'
import { mcpServerStatusFor, type McpServerReport } from './mcp-server-status/registry'
import { plainSkillInvocation, resolveSkillInvocation } from '../shared/skill-invocation'
import { SKILL_HARNESS_DIR, SKILL_PACK_HARNESSES } from '../shared/skill-harnesses'
import {
  parseSkillFrontmatter,
  SKILL_ENTRY_FILE,
  type AgentCapabilitiesInput,
  type AgentCapabilitiesResult,
  type AgentMcpServer,
  type AgentSkill,
  type AgentSkillSource,
  type CapabilityDiagnostic,
} from '../shared/skills'
import { BUILTIN_SKILLS } from './builtin-skills'

// The .sprintengine-skill.json manifest a builtin install writes next to SKILL.md;
// version drift against BUILTIN_SKILLS marks the entry update-available without
// re-hashing the directory.
const BUILTIN_MANIFEST_FILE = '.sprintengine-skill.json'

export type WorkspaceSkillsService = {
  listWorkspaceSkills(input: WorkspaceSkillsListInput): Promise<WorkspaceSkillsListResult>
}

type SkillFrontmatter = {
  name?: string
  description?: string
}

export function createWorkspaceSkillsService(options: { homeDir?: string } = {}): WorkspaceSkillsService {
  return {
    async listWorkspaceSkills(input): Promise<WorkspaceSkillsListResult> {
      const workspaceRoot = input.workspaceRoot?.trim() || null
      if (workspaceRoot && !existsSync(workspaceRoot)) {
        return { ok: false, message: 'Workspace root does not exist.' }
      }
      if (!workspaceRoot && !input.includeGlobal) {
        return { ok: false, message: 'Workspace root does not exist.' }
      }
      // The folder's copies first, then the ones every project reads: a skill
      // in both is one row, and the copy nearest the work is the one it shows.
      const roots = [workspaceRoot, input.includeGlobal ? (options.homeDir ?? homedir()) : null].filter(
        (root): root is string => root !== null,
      )
      return { ok: true, skills: listWorkspaceSkills(roots) }
    },
  }
}

// ---------------------------------------------------------------------------
// Agent capabilities: what the agent in one CLI can reach in one workspace.
// ---------------------------------------------------------------------------

/** One skill directory as it exists on disk, before it is attributed to a CLI. */
type RawSkill = {
  id: string
  name: string
  description: string
  source: AgentSkillSource
  sourceId?: string
}

export type ReadSkillsResult =
  { ok: true; skills: RawSkill[] } | { ok: false; reason: 'missing' | 'unreadable'; message: string }

/**
 * Reads a directory of skills. `missing` and `unreadable` are deliberately
 * different answers: a directory the CLI never created is normal, and a
 * permission error is a fault the surface must report rather than render as
 * "no skills".
 */
export interface SkillDirectoryReader {
  read(absoluteDir: string): Promise<ReadSkillsResult>
}

export type AgentCapabilityService = {
  resolve(input: AgentCapabilitiesInput): Promise<AgentCapabilitiesResult>
}

export function createFsSkillDirectoryReader(): SkillDirectoryReader {
  return {
    async read(absoluteDir): Promise<ReadSkillsResult> {
      let entries: string[]
      try {
        entries = await readdir(absoluteDir)
      } catch (error) {
        // Only "never created" is normal. A permission error, or a file sitting
        // where the directory should be (ENOTDIR), is a fault the surface must
        // name rather than render as "no skills".
        if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
          return { ok: false, reason: 'missing', message: 'No skills directory here yet.' }
        }
        return { ok: false, reason: 'unreadable', message: formatFsError(error) }
      }

      const skills: RawSkill[] = []
      for (const entry of entries) {
        const skillDir = join(absoluteDir, entry)
        try {
          // stat, not the readdir dirent: a skill directory reached through a
          // symlink is a real skill to the CLI reading it.
          if (!(await stat(skillDir)).isDirectory()) continue
        } catch {
          // A loose file or a dangling symlink in the skills directory is not a
          // skill to the CLI reading it either, so it is skipped, not reported.
          continue
        }
        const frontmatter = await readEntryFrontmatter(skillDir)
        const sourceId = sourceIdOf(skillDir)
        skills.push({
          id: entry,
          name: frontmatter.name || entry,
          description: frontmatter.description,
          source: await readSkillProvenance(skillDir),
          ...(sourceId ? { sourceId } : {}),
        })
      }
      return { ok: true, skills }
    },
  }
}

export function createAgentCapabilityService(options: {
  reader: SkillDirectoryReader
  listPlugins: () => PluginRegistryListEntry[]
  /** Manifests, not list entries: `mcpConfig` is not projected to the renderer. */
  lookupManifest: (pluginId: string) => PluginManifest | undefined
  mcpResolver: McpServerResolver
  /**
   * The freshness watcher, when one is running. It answers whether this list
   * can be kept true; a workspace it could not watch is stale-but-correct, and
   * the surface must be able to say so rather than present it as live.
   */
  freshness?: Pick<CapabilityWatcher, 'diagnosticsFor'>
  /** The home folder whose harness directories hold the skills every project reads. */
  homeDir?: string
}): AgentCapabilityService {
  return {
    async resolve({ workspaceRoot, pluginId, includeGlobal }): Promise<AgentCapabilitiesResult> {
      const root = workspaceRoot?.trim() || null
      if (root ? !existsSync(root) : !includeGlobal) {
        return { ok: false, message: 'Workspace root does not exist.' }
      }
      const home = includeGlobal ? (options.homeDir ?? homedir()) : null

      const plugins = options.listPlugins()
      const binding = buildHarnessMap(plugins).byPlugin.get(pluginId)
      // The two halves are independent declarations: cursor declares an MCP
      // config and no skill integration at all, so a CLI with nothing to read
      // for skills still has servers to answer for. Servers are a workspace's
      // configuration, so with no folder there are none to resolve.
      const [skills, mcp] = await Promise.all([
        resolveSkills(options, plugins, binding, pluginId, [root, home]),
        root ? resolveServers(options, pluginId, root) : Promise.resolve<ResolvedMcpServers>(NO_SERVERS),
      ])

      return {
        ok: true,
        support: binding?.support ?? 'unsupported',
        harnessId: binding?.harnessId ?? '',
        skills: skills.skills,
        servers: root ? withReportedStatus(mcp.servers, mcpServerStatusFor(pluginId, root)) : [],
        diagnostics: [
          ...skills.diagnostics,
          ...mcp.diagnostics,
          ...(root ? (options.freshness?.diagnosticsFor(root, pluginId) ?? []) : []),
        ],
      }
    },
  }
}

/**
 * The configured servers with what the CLI last reported about each, then any
 * server it reported that no config file of its names: those are real (its
 * own user settings, a plugin, its account) and the person is choosing among
 * them too.
 */
export function withReportedStatus(
  servers: readonly AgentMcpServer[],
  reported: ReadonlyMap<string, McpServerReport>,
): AgentMcpServer[] {
  const listed = servers.map((server) => {
    const report = reported.get(server.id)
    if (!report) return server
    return {
      ...server,
      status: report.status,
      ...(report.error ? { error: report.error } : {}),
      ...(server.toolCount === undefined && report.toolCount !== undefined ? { toolCount: report.toolCount } : {}),
    }
  })
  const known = new Set(servers.map((server) => server.id))
  for (const report of reported.values()) {
    if (known.has(report.id)) continue
    listed.push({
      id: report.id,
      transport: '',
      scope: 'session',
      status: report.status,
      ...(report.error ? { error: report.error } : {}),
      ...(report.toolCount !== undefined ? { toolCount: report.toolCount } : {}),
    })
  }
  return listed
}

async function resolveSkills(
  options: { reader: SkillDirectoryReader },
  plugins: PluginRegistryListEntry[],
  binding: HarnessBinding | undefined,
  pluginId: string,
  roots: ReadonlyArray<string | null>,
): Promise<{ skills: AgentSkill[]; diagnostics: CapabilityDiagnostic[] }> {
  // A CLI that declares no skill integration, one that declares `unsupported`,
  // and one with no workspace install target are all legitimate answers with
  // nothing to read and no path to report as failing.
  if (!binding || binding.support === 'unsupported' || !binding.skillsDir) {
    return { skills: [], diagnostics: [] }
  }
  const relativeDir = binding.skillsDir.split('/')

  const integration = plugins.find((plugin) => plugin.id === pluginId)?.skillIntegration
  // The workspace's directory first, then the home folder's: the CLI reads
  // both, a name in both is one skill, and the nearer copy is the one listed.
  // A workspace opened on the home folder is one directory, read once.
  const skillsDirs = roots
    .filter((root): root is string => root !== null)
    .map((root) => resolve(root, ...relativeDir))
    .filter((dir, index, all) => all.indexOf(dir) === index)
  const found = new Map<string, RawSkill>()
  const diagnostics: CapabilityDiagnostic[] = []
  for (const skillsDir of skillsDirs) {
    const read = await options.reader.read(skillsDir)
    if (!read.ok) {
      if (read.reason === 'unreadable') {
        diagnostics.push({ capability: 'skills', reason: 'unreadable', path: skillsDir, message: read.message })
      }
      continue
    }
    for (const skill of read.skills) if (!found.has(skill.id)) found.set(skill.id, skill)
  }

  return {
    skills: Array.from(found.values())
      .map((skill): AgentSkill => ({
        id: skill.id,
        name: skill.name,
        description: skill.description,
        invocation: resolveSkillInvocation(integration, skill.id) ?? plainSkillInvocation(skill.id),
        source: skill.source,
        ...(skill.sourceId ? { sourceId: skill.sourceId } : {}),
        pluginIds: binding.pluginIds,
      }))
      .sort((a, b) => a.name.localeCompare(b.name)),
    diagnostics,
  }
}

const NO_SERVERS: ResolvedMcpServers = { servers: [], diagnostics: [] }

async function resolveServers(
  options: {
    lookupManifest: (pluginId: string) => PluginManifest | undefined
    mcpResolver: McpServerResolver
  },
  pluginId: string,
  workspaceRoot: string,
): Promise<ResolvedMcpServers> {
  const spec = options.lookupManifest(pluginId)?.mcpConfig
  // No `mcpConfig` block: this CLI reads no MCP config the studio knows of, which
  // is an answer rather than a fault.
  if (!spec) return { servers: [], diagnostics: [] }
  const resolved = await options.mcpResolver.resolve({
    workspaceRoot,
    targets: [{ pluginId, spec }],
  })
  return resolved.get(pluginId) ?? { servers: [], diagnostics: [] }
}

async function readEntryFrontmatter(skillDir: string): Promise<{ name: string; description: string }> {
  try {
    const raw = await readFile(join(skillDir, SKILL_ENTRY_FILE), 'utf8')
    const frontmatter = parseSkillFrontmatter(raw)
    return { name: frontmatter.name, description: frontmatter.description }
  } catch {
    // A skill directory with no readable entry document still exists for the
    // CLI; its directory name is all we can honestly report.
    return { name: '', description: '' }
  }
}

// Provenance comes from the marker the installers write, so a hand-made
// directory reads as `local` rather than being claimed by anything. The marker
// shapes are documented in src/main/skills/install.ts; a copy the attach path
// made of an unmarked local skill carries a third one, which is neither
// built-in nor from a source and so reads as `local` — which is what it is.
async function readSkillProvenance(skillDir: string): Promise<AgentSkillSource> {
  let parsed: unknown
  try {
    parsed = JSON.parse(await readFile(join(skillDir, BUILTIN_MANIFEST_FILE), 'utf8'))
  } catch {
    return 'local'
  }
  if (typeof parsed !== 'object' || parsed === null) return 'local'
  const marker = parsed as { source?: unknown; sourceId?: unknown }
  if (marker.source === 'sprintengine-builtin') return 'builtin'
  if (typeof marker.sourceId === 'string' && marker.sourceId !== '') return 'source'
  return 'local'
}

function formatFsError(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

// ---------------------------------------------------------------------------
// Workspace-wide inventory (every harness, no CLI): the picker's fallback when
// no CLI is in play, and the Extensions inventory.
// ---------------------------------------------------------------------------

function listWorkspaceSkills(roots: readonly string[]): WorkspaceSkill[] {
  const builtinById = new Map<string, BuiltinSkill>(BUILTIN_SKILLS.map((skill) => [skill.id, skill]))

  // A workspace opened on the home folder itself is both roots; reading it
  // twice would only re-find every skill.
  const distinctRoots = roots.map((root) => resolve(root)).filter((root, index, all) => all.indexOf(root) === index)
  const installed = new Map<string, WorkspaceSkill>()
  for (const root of distinctRoots) collectInstalledSkills(root, builtinById, installed)

  const skills = Array.from(installed.values())

  for (const builtin of BUILTIN_SKILLS) {
    if (installed.has(builtin.id)) continue
    skills.push({
      id: builtin.id,
      name: builtin.name,
      description: builtin.description,
      source: 'builtin',
      harnesses: [],
      installState: 'available',
      version: builtin.version,
    })
  }

  return skills.sort((a, b) => a.name.localeCompare(b.name))
}

function collectInstalledSkills(
  workspaceRoot: string,
  builtinById: ReadonlyMap<string, BuiltinSkill>,
  installed: Map<string, WorkspaceSkill>,
): void {
  for (const harness of SKILL_PACK_HARNESSES) {
    const skillsDir = join(workspaceRoot, SKILL_HARNESS_DIR[harness], 'skills')
    for (const dirName of listSkillDirs(skillsDir)) {
      const existing = installed.get(dirName)
      if (existing) {
        if (!existing.harnesses.includes(harness)) existing.harnesses.push(harness)
        // A later harness copy still refines missing metadata (the first copy
        // may predate frontmatter or be a bare directory).
        if (!existing.description || !existing.name || existing.name === dirName) {
          const frontmatter = readSkillFrontmatter(join(skillsDir, dirName))
          if (!existing.description && frontmatter.description) existing.description = frontmatter.description
          if ((!existing.name || existing.name === dirName) && frontmatter.name) existing.name = frontmatter.name
        }
        continue
      }
      installed.set(
        dirName,
        buildInstalledSkill({
          dirName,
          skillDir: join(skillsDir, dirName),
          harness,
          builtin: builtinById.get(dirName),
        }),
      )
    }
  }
}

function buildInstalledSkill(input: {
  dirName: string
  skillDir: string
  harness: SkillHarness
  builtin?: BuiltinSkill
}): WorkspaceSkill {
  const { dirName, skillDir, harness, builtin } = input
  const frontmatter = readSkillFrontmatter(skillDir)
  const name = frontmatter.name ?? builtin?.name ?? dirName
  const description = frontmatter.description ?? builtin?.description

  if (builtin) {
    return {
      id: builtin.id,
      name,
      description,
      source: 'builtin',
      harnesses: [harness],
      installState: builtinInstallState(skillDir, builtin),
      version: builtin.version,
    }
  }
  const sourceId = sourceIdOf(skillDir)
  return {
    id: dirName,
    name,
    description,
    source: 'custom',
    harnesses: [harness],
    installState: 'installed',
    ...(sourceId ? { sourceId } : {}),
  }
}

// The source a skill was installed from, read off the marker the installer
// leaves beside it (skills/install.ts). A hand-made skill has none.
function sourceIdOf(skillDir: string): string | undefined {
  try {
    const marker = JSON.parse(readFileSync(join(skillDir, BUILTIN_MANIFEST_FILE), 'utf8')) as { sourceId?: unknown }
    return typeof marker.sourceId === 'string' && marker.sourceId ? marker.sourceId : undefined
  } catch {
    return undefined
  }
}

function builtinInstallState(skillDir: string, builtin: BuiltinSkill): 'installed' | 'update-available' {
  try {
    const manifest = JSON.parse(readFileSync(join(skillDir, BUILTIN_MANIFEST_FILE), 'utf8')) as {
      version?: unknown
    }
    if (typeof manifest.version === 'string' && manifest.version !== builtin.version) {
      return 'update-available'
    }
  } catch {
    // Unmanaged or unreadable copy: treat as installed; overwrite safety lives
    // in the builtin skill manager, not the inventory.
  }
  return 'installed'
}

function listSkillDirs(skillsDir: string): string[] {
  if (!existsSync(skillsDir)) return []
  try {
    return readdirSync(skillsDir).filter((name) => {
      try {
        return statSync(join(skillsDir, name)).isDirectory()
      } catch {
        return false
      }
    })
  } catch {
    return []
  }
}

// One frontmatter reader for the whole app (src/shared/skills.ts); this keeps
// the inventory's "absent means fall back to builtin metadata" contract, which
// an empty string would not express.
function readSkillFrontmatter(skillDir: string): SkillFrontmatter {
  let raw: string
  try {
    raw = readFileSync(join(skillDir, SKILL_ENTRY_FILE), 'utf8')
  } catch {
    return {}
  }
  const frontmatter = parseSkillFrontmatter(raw)
  return {
    ...(frontmatter.name ? { name: frontmatter.name } : {}),
    ...(frontmatter.description ? { description: frontmatter.description } : {}),
  }
}
