// skillsSurfaceModel — pure, DOM-free derivation for the Skills surface, the
// `settings/extensionsInstalled.ts` idiom: the React components own the IPC and
// the rendering, and everything that can be unit-tested without a renderer
// lives here.
//
// A source's listing is derived from what the scan actually found, never from
// a template, and a total that is still loading or could not be read never
// renders as a zero count.

import {
  SKILL_UNLISTED_GROUP,
  skillDirName,
  skillNameWarning,
  skillRepoWebUrl,
  type ScanResult,
  type ScannedSkill,
  type SkillFileRef,
  type SkillSource,
  isGithubDotComRepo,
  skillRepoLabel,
} from '../../../../../../../shared/skills'

/**
 * What a source is called on screen. A repository source is named by its
 * repository, not by the repository's last path segment: `mattpocock/skills`,
 * `anthropics/skills` and `browser-act/skills` are three different sources, and
 * three rail rows all reading "skills" would be unnavigable.
 */
export function sourceDisplayName(source: SkillSource): string {
  return source.repo ? skillRepoLabel(source.repo) : source.name
}

/** Per-source scan read. Sources list first; each scan lands independently. */
export type SkillScanLoad =
  { status: 'loading' } | { status: 'error'; message: string } | { status: 'ready'; scan: ScanResult }

/** The source list read itself (one IPC call for every source). */
export type SkillSourcesLoad = { status: 'loading' } | { status: 'error'; message: string } | { status: 'ready' }

export function pluralSkills(count: number): string {
  return `${count} ${count === 1 ? 'skill' : 'skills'}`
}

/**
 * How many skills the app's sources hold, and whether that is knowable yet.
 *
 * One derivation, two readers: this state line and the Extensions home's
 * Skills tile. The tile used to re-implement the sum, which is the setup for
 * two places stating different totals of the same thing the day either rule
 * moves.
 */
export function skillsTotal(
  sourcesLoad: SkillSourcesLoad,
  sources: readonly SkillSource[],
  scans: Readonly<Record<string, SkillScanLoad>>,
): { state: 'loading' | 'error' | 'ready'; ready: boolean; sourceCount: number; skillCount: number } {
  if (sourcesLoad.status === 'loading') {
    return { state: 'loading', ready: false, sourceCount: sources.length, skillCount: 0 }
  }
  if (sourcesLoad.status === 'error') {
    return { state: 'error', ready: false, sourceCount: sources.length, skillCount: 0 }
  }
  const loads = sources.map((source) => scans[source.id])
  // A total is only a total once EVERY source has answered: a partial sum
  // presented as the total is a lie that settles into a different number a
  // second later.
  const ready = loads.every((load) => load && load.status === 'ready')
  return {
    state: 'ready',
    ready,
    sourceCount: sources.length,
    skillCount: loads.reduce((sum, load) => sum + (load && load.status === 'ready' ? load.scan.skills.length : 0), 0),
  }
}

// ── The source page ──────────────────────────────────────────────────────────

export type SkillListItem = {
  /** Source-relative directory path — the skill's identity within its source. */
  skillId: string
  name: string
  description: string
  /** '' when the source carries no grouping signal. */
  group: string
  /**
   * The plugin this skill ships inside — `discord` for
   * `external_plugins/discord/skills/access` — or '' when the source's skills
   * are not laid out as plugins, or all belong to the same one. Three rows
   * called "access" are indistinguishable without it; a source whose every
   * skill is under one plugin would only be repeating its own name.
   */
  plugin: string
  fileCount: number
  hasExecutables: boolean
  /** A skill directory of this name is already in the workspace. */
  installed: boolean
  /**
   * How the skill's declared `name` departs from the Agent Skills
   * specification, '' when it does not. Stated on the row rather than acted on:
   * the skill still lists and still installs.
   */
  nameWarning: string
}

function toListItem(skill: ScannedSkill, installedDirNames: ReadonlySet<string>): SkillListItem {
  return {
    skillId: skill.id,
    name: skill.name,
    description: skill.description,
    group: skill.group,
    plugin: skillPluginFolder(skill.id),
    fileCount: skill.files.length,
    hasExecutables: skill.hasExecutables,
    // Installs land in one directory per skill name, so a directory of that
    // name in the workspace is what "installed" means to the agent that reads
    // it — the same identity the installer writes and would overwrite.
    installed: installedDirNames.has(skillDirName(skill.id)),
    nameWarning: skillNameWarning(skill.name, skillDirName(skill.id)),
  }
}

/** `social-listening` → `Social listening`; names the source already cased, or
 *  synthetic ones like `(repo root)`, are left exactly as the source wrote them. */
export function skillGroupLabel(name: string): string {
  const first = name.charAt(0)
  if (first === '' || first === '(' || first !== first.toLowerCase()) return name
  const spaced = name.replace(/-/g, ' ')
  return spaced.charAt(0).toUpperCase() + spaced.slice(1)
}

function matchSkills(items: readonly SkillListItem[], query: string): SkillListItem[] {
  const needle = query.toLowerCase()
  return items.filter((item) =>
    `${item.name} ${item.description} ${item.group} ${item.skillId}`.toLowerCase().includes(needle),
  )
}

/**
 * The plugin a skill's directory sits inside, read off its path: a marketplace
 * lays a plugin's skills out as `<plugin>/skills/<skill>`, so the segment
 * before `skills` names the plugin. '' for a skill not laid out that way.
 */
export function skillPluginFolder(skillId: string): string {
  const segments = skillId.split('/').filter(Boolean)
  const skillsAt = segments.lastIndexOf('skills')
  return skillsAt >= 1 && skillsAt === segments.length - 2 ? segments[skillsAt - 1] : ''
}

/**
 * A source's skills as the tab renders them: the repository's own folders as
 * groups, in the order the scan found them, filtered by the tab's search.
 *
 * Every source lists in full, twelve rows at a time, so the only question is
 * how the rows are grouped. A source that carries no grouping signal lists
 * under one heading rather than under a fake one.
 */
export function deriveSkillCatalogueGroups(input: {
  scan: ScanResult
  installedDirNames: ReadonlySet<string>
  query: string
}): { key: string; label: string; items: SkillListItem[] }[] {
  const listed = input.scan.skills.map((skill) => toListItem(skill, input.installedDirNames))
  // The plugin qualifier earns its place only when it tells rows apart: one
  // plugin's skills, or a source that is not laid out as plugins, say nothing.
  const plugins = new Set(listed.map((item) => item.plugin).filter(Boolean))
  const items = plugins.size > 1 ? listed : listed.map((item) => ({ ...item, plugin: '' }))
  const matched = input.query.trim() ? matchSkills(items, input.query.trim()) : items
  if (matched.length === 0) return []
  const groups = input.scan.groups.filter((name) => matched.some((item) => item.group === name))
  if (groups.length === 0) {
    return [{ key: '(all)', label: 'Skills', items: matched }]
  }
  const grouped = groups.map((name) => ({
    key: name,
    label: skillGroupLabel(name),
    items: matched.filter((item) => item.group === name),
  }))
  // A skill whose group the scan did not list still has to be reachable. It
  // reads under the scan's OWN name for that bucket rather than a second one of
  // this module's invention, so a source cannot show two headings meaning the
  // same thing (`SKILL_UNLISTED_GROUP`, shared/skills.ts).
  const ungrouped = matched.filter((item) => !groups.includes(item.group))
  return ungrouped.length > 0
    ? [...grouped, { key: '(ungrouped)', label: SKILL_UNLISTED_GROUP, items: ungrouped }]
    : grouped
}

/**
 * Said whenever a listing is the copy the app SHIPPED rather than a read of the
 * repository — our own marketplace with the network away (studio-marketplace
 * ruling, 2026-09-06). Null otherwise, because "read from the repository" is
 * the ordinary case and does not need announcing.
 *
 * It has to be said. The two listings look identical, and the difference is
 * whether what is on screen is as current as the repository or as current as
 * the last release; someone deciding whether a plugin exists yet needs to know
 * which question the answer came from.
 */
export function bundledScanLine(scan: Pick<ScanResult, 'bundled'> | null): string | null {
  // "The repository could not be read", not "the network was not reachable":
  // observed live on 2026-09-06, the fallback also fires on an anonymous rate
  // limit with the network perfectly fine, and a line that names a cause it
  // does not know sends someone to check their wifi. Sync says which it was.
  return scan?.bundled === true ? 'The bundled copy this build shipped — the repository could not be read' : null
}

export function findSkill(scan: ScanResult, skillId: string): ScannedSkill | null {
  return scan.skills.find((skill) => skill.id === skillId) ?? null
}

// ── Installing ───────────────────────────────────────────────────────────────

export type SkillInstallAvailability = {
  enabled: boolean
  /** Shown beside the disabled control. Null when the reason is self-evident. */
  reason: string | null
}

/**
 * Sources are app-level, and so is a default install: it lands in the home
 * folder, where every agent reads it in every chat and project. Nothing about
 * the open folder can withhold Install — only having nothing picked.
 */
export function deriveInstallAvailability(selectedCount: number): SkillInstallAvailability {
  if (selectedCount === 0) return { enabled: false, reason: null }
  return { enabled: true, reason: null }
}

export type SkillInstallFailure = { skillId: string; message: string }

/** One sentence for what a batch install actually did, failures named. */
export function summarizeInstallRun(installed: number, failures: readonly SkillInstallFailure[]): string {
  const total = installed + failures.length
  if (failures.length === 0) return `Installed ${pluralSkills(installed)}.`
  if (installed === 0) {
    return failures.length === 1
      ? `${skillDirName(failures[0].skillId)} did not install: ${failures[0].message}`
      : `None of the ${total} skills installed. ${failures[0].message}`
  }
  return `Installed ${installed} of ${total}. ${skillDirName(failures[0].skillId)} did not install: ${failures[0].message}`
}

// ── Syncing ──────────────────────────────────────────────────────────────────

export type SkillSyncReport = {
  added: number
  removed: number
  refreshed: number
  failures: readonly SkillInstallFailure[]
  /** Source-installed MCP servers the sync rewrote; absent where a surface has none. */
  mcpChanged?: number
  /** Source-installed MCP servers the source has stopped declaring. */
  mcpMissing?: number
}

/**
 * One line for what a sync actually did, in counts.
 *
 * Counts are the whole of it, deliberately. Describing what changed *inside* a
 * skill needs a human or a model guess, and a guess about someone else's diff
 * presented as fact is the thing this design ruled out — the repository's own
 * commit history answers that question better than anything rendered here.
 */
export function summarizeSyncRun(report: SkillSyncReport): string {
  const parts: string[] = []
  if (report.added > 0) parts.push(`${report.added} new ${report.added === 1 ? 'skill' : 'skills'}`)
  if (report.removed > 0) parts.push(`${report.removed} removed upstream`)
  if (parts.length === 0) parts.push('no new skills')
  if (report.refreshed > 0) {
    parts.push(`${report.refreshed} installed ${report.refreshed === 1 ? 'skill' : 'skills'} updated`)
  }
  // An MCP server a source installed is refreshed by the same press, so the
  // line says so; silence would leave the person to discover a rewritten
  // command by running an agent against it.
  const mcpChanged = report.mcpChanged ?? 0
  const mcpMissing = report.mcpMissing ?? 0
  if (mcpChanged > 0) parts.push(`${mcpChanged} MCP ${mcpChanged === 1 ? 'server' : 'servers'} updated`)
  if (mcpMissing > 0) {
    parts.push(`${mcpMissing} MCP ${mcpMissing === 1 ? 'server is' : 'servers are'} no longer in this source`)
  }
  const line = `Synced · ${parts.join(' · ')}`
  if (report.failures.length === 0) return line
  const first = report.failures[0]
  return `${line} · ${skillDirName(first.skillId)} did not update: ${first.message}`
}

/** The repository's own commit history — the answer to "what changed?". */
export function skillSourceCommitsUrl(source: SkillSource): string | null {
  if (source.kind !== 'github' || !source.repo) return null
  const page = skillRepoWebUrl(source.repo)
  // github.com's history page is `/commits/<sha>`; other hosts spell it their
  // own way, and their repository page is where its history is one click away.
  if (!page || !isGithubDotComRepo(source.repo)) return page
  return `${page}/commits/${source.commitSha || 'HEAD'}`
}

// ── Header facts ─────────────────────────────────────────────────────────────

/** The pinned commit, short. '' for a source with no git identity. */
export function shortCommit(sha: string): string {
  return sha.length > 7 ? sha.slice(0, 7) : sha
}

/** File size for the reader's file list. Bytes below 1 KiB stay bytes. */
export function formatSkillFileSize(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes <= 0) return '0 B'
  if (bytes < 1024) return `${Math.round(bytes)} B`
  const kib = bytes / 1024
  if (kib < 1024) return `${kib < 100 ? kib.toFixed(1) : Math.round(kib)} KB`
  const mib = kib / 1024
  return `${mib < 100 ? mib.toFixed(1) : Math.round(mib)} MB`
}

// ── The reader ───────────────────────────────────────────────────────────────

/**
 * Reading order: the entry first, then the skill's own documents, then what
 * sits in its subdirectories (`agents/`, `scripts/`). A skill is read from
 * SKILL.md outwards, and the files it ships to be run are the tail of that
 * read, not the head of it.
 */
export function orderSkillFiles(files: readonly SkillFileRef[]): SkillFileRef[] {
  return [...files].sort((a, b) => {
    if (a.isEntry !== b.isEntry) return a.isEntry ? -1 : 1
    const depthA = a.path.includes('/') ? 1 : 0
    const depthB = b.path.includes('/') ? 1 : 0
    if (depthA !== depthB) return depthA - depthB
    return a.path < b.path ? -1 : a.path > b.path ? 1 : 0
  })
}

/** The file the reader opens on: the declared entry, else the first file. */
export function defaultSkillFilePath(files: readonly SkillFileRef[]): string {
  const ordered = orderSkillFiles(files)
  return ordered.length > 0 ? ordered[0].path : ''
}

export function isMarkdownSkillFile(path: string): boolean {
  return /\.(md|markdown|mdx)$/i.test(path)
}

/**
 * Frontmatter is the briefing, and the page already states its `description`
 * above the document, so the document itself starts at its first heading
 * rather than at a block of YAML.
 */
export function stripSkillFrontmatter(content: string): string {
  // The byte-order mark a Windows editor writes sits before the fence, so
  // without dropping it the reader renders the frontmatter as prose.
  const document = content.charCodeAt(0) === 0xfeff ? content.slice(1) : content
  const block = document.match(/^---\r?\n[\s\S]*?\r?\n---(?:\r?\n|$)/)
  return block ? document.slice(block[0].length) : document
}

export type SkillLinkTarget = { kind: 'file'; path: string } | { kind: 'dead'; target: string }

/**
 * Resolve one markdown href against the skill's own manifest.
 *
 * A relative href in a SKILL.md points at a sibling file of the same skill, so
 * it is resolved against what the scan actually carried — never fetched, and
 * never guessed. Anything carrying a scheme (`https:`, and equally
 * `javascript:`) or a bare fragment is not this skill's to own: null hands it
 * back to the renderer's protocol guard.
 */
export function resolveSkillLink(
  files: readonly SkillFileRef[],
  currentPath: string,
  href: string,
): SkillLinkTarget | null {
  const raw = href.trim()
  if (!raw || raw.startsWith('#')) return null
  if (/^[a-z][a-z0-9+.-]*:/i.test(raw)) return null

  const target = raw.split('#')[0].split('?')[0].replace(/^\.\//, '')
  if (!target) return null
  const bare = target.replace(/^\/+/, '')
  const dir = currentPath.includes('/') ? currentPath.slice(0, currentPath.lastIndexOf('/') + 1) : ''
  const relative = normalizeSkillPath(target.startsWith('/') ? bare : dir + target)

  const hit =
    files.find((file) => file.path === relative) ??
    files.find((file) => file.path === bare) ??
    files.find((file) => file.path.endsWith(`/${bare}`))
  return hit ? { kind: 'file', path: hit.path } : { kind: 'dead', target: bare }
}

/** What a dead link says on hover. States the fact, not a failure. */
export function describeDeadSkillLink(target: string): string {
  return `${target} is not one of this skill's files.`
}

/** Collapse `.` and `..` so `../scripts/run.sh` resolves the way a reader reads it. */
function normalizeSkillPath(path: string): string {
  const out: string[] = []
  for (const segment of path.split('/')) {
    if (segment === '' || segment === '.') continue
    if (segment === '..') out.pop()
    else out.push(segment)
  }
  return out.join('/')
}
