// Skill sources: the shapes the whole Skills surface is built on.
//
// A *source* is somewhere skills come from — a public GitHub repository
// (`github`), which includes the two every install has and nobody chose, our own
// marketplace and Anthropic's; the skills the connector catalogue ships
// (`connectors`); or a folder on this machine (`local`). Scanning a source turns
// it into a list of skills; a skill is a directory containing SKILL.md, taken
// whole.
//
// Renderer-safe on purpose (no node imports): the Extensions surface, the
// reader, and the main-process scanner all speak these types.

// `builtin` is gone: the app's own catalogue used to be a folder on disk, and
// since the studio-marketplace ruling (2026-09-06) it is the repository we
// publish, read like any other (STUDIO_SKILL_SOURCE_ID below). `connectors`
// went the same way in the frozen-snapshots retirement (2026-09-06): it was a
// folder scan of a snapshot of `anthropics/claude-plugins-official`, which is
// now an always-present source read live.
type SkillSourceKind = 'github' | 'local'

/**
 * An agent CLI that reads workspace skills. Which directory each one reads is
 * `SKILL_HARNESS_DIR` in src/shared/skill-harnesses.ts; this is the identity
 * alone, so renderer code can name a harness without importing a node module.
 */
/**
 * The plus-menu item that adds a folder on this machine as a skill source.
 *
 * The control opens a folder picker. The previous "Add from file…" copy named
 * the wrong object (owner ruling 2026-09-08).
 */
export const ADD_LOCAL_SKILL_SOURCE_LABEL = 'Add from folder…'

/** The skill-page accent that copies a catalogue skill into this workspace. */
export const INSTALL_SKILL_LABEL = 'Install skill'

export type SkillHarness = 'claude' | 'codex' | 'cursor' | 'gemini' | 'opencode' | 'grok' | 'agents'

/**
 * How this machine reads repositories: over git's own protocol, or over
 * GitHub's REST API (git-transport ruling, owner 2026-09-08).
 *
 * It lives here rather than beside the reader interface because the copy is
 * what most needs it — a cadence line and a shortfall clause both change
 * wording with the transport, and neither Settings nor the Extensions door can
 * import main. `src/main/skills/repo-reader.ts` re-exports it, so the reader
 * contract stays one file.
 */
export type SkillRepoTransport = 'git' | 'api'

// Where a repository source lives — its host, path and transport — is its own
// module; these are re-exported so the one import every caller already has
// keeps working.
export {
  DEFAULT_SKILL_REPO_HOST,
  isGithubDotComRepo,
  joinSkillRepo,
  normalizeSkillRepoHost,
  skillRepoCloneUrl,
  skillRepoLabel,
  skillRepoWebUrl,
  splitSkillRepo,
  type SkillRepoLocation,
} from './skill-repo'

/** A place skills come from. `repo` is where its repository lives (`./skill-repo.ts`), '' for any other kind. */
export type SkillSource = {
  id: string
  kind: SkillSourceKind
  name: string
  repo: string
  /**
   * Absolute folder path for a `local` source, '' for every other kind. A
   * folder on this machine is a source you can point at (the source-tabs
   * ruling, 2026-09-05: the plus offers "Add from folder…" beside "Add from
   * GitHub…"), and the path is the only identity it has — there is no
   * repository to name it by.
   */
  path?: string
  /** 1-2 character badge shown in the source rail. */
  monogram: string
  blurb: string
  /** Commit the cached scan was taken at; '' for sources with no git identity. */
  commitSha: string
  /** ISO timestamp of the cached scan; '' when never scanned. */
  scannedAt: string
  /**
   * The repository's head the last update check resolved, when it ran. A head
   * that differs from `commitSha` is an update the person can apply with Sync
   * (backlog/2026-09-05-plugin-sources.md, "Update notifications").
   */
  headSha?: string
  headCheckedAt?: string
}

/** True when a check has seen the source's repository move past the scanned commit. */
export function sourceHasUpdate(source: Pick<SkillSource, 'commitSha' | 'headSha'>): boolean {
  return Boolean(source.headSha) && source.commitSha !== '' && source.headSha !== source.commitSha
}

/**
 * One file inside a skill. `path` is skill-relative with forward slashes, so
 * `agents/openai.yaml` keeps its shape when installed. `blobSha` is the git
 * blob id from the tree listing, and is '' for sources with no git identity.
 */
export type SkillFileRef = {
  path: string
  size: number
  blobSha: string
  isEntry: boolean
}

export type ScannedSkill = {
  /** Source-relative directory path — the skill's identity within its source. */
  id: string
  name: string
  description: string
  /** Group name, or '' when the source carries no grouping signal. */
  group: string
  files: SkillFileRef[]
  allowedTools: string[]
  hasExecutables: boolean
  /**
   * The optional Agent Skills fields, read from the entry document alongside
   * the description (https://agentskills.io/specification, fetched
   * 2026-09-06). Optional on the type because a scan cached before 2026-09-06
   * carries none, and because most skills declare none.
   */
  license?: string
  compatibility?: string
  metadata?: Record<string, string>
}

export type SkillGroupingSignal = 'manifest' | 'folders' | 'none'

export type ScanResult = {
  skills: ScannedSkill[]
  groups: string[]
  groupingSignal: SkillGroupingSignal
  fileCount: number
  commitSha: string
  /**
   * Entry documents that were read and declared no `description`, and so are
   * not skills at all (https://agentskills.io/specification, fetched
   * 2026-09-06). They are dropped from `skills`, and counted here so the
   * surface can say a source held something it did not list. Absent on scans
   * cached before this was counted, which is not the same as zero.
   */
  skippedNoDescription?: number
  /**
   * What the repository turned out to be, and the plugins and MCP servers it
   * declares (backlog/2026-09-05-plugin-sources.md). Optional because scans
   * cached before plugins existed carry none; read them through
   * `scanPlugins()` / `scanMcpServers()` / `scanShape()`, never directly.
   */
  shape?: SourceShape
  /** The `name` a `.claude-plugin/marketplace.json` gives itself; '' without one. */
  marketplaceName?: string
  plugins?: ScannedPlugin[]
  mcpServers?: ScannedMcpServer[]
  /**
   * The marketplace's top-level `renames`: old plugin name → the name it is
   * listed under now. Read through `scanPluginRenames()`, never directly.
   */
  pluginRenames?: Record<string, string>
  /**
   * True when this scan is the copy that SHIPPED WITH THE APP rather than a
   * read of the repository — the seed our own marketplace falls back to when
   * the network is not there (studio-marketplace ruling, 2026-09-06), the same
   * bundled-or-remote distinction `registry-client.ts` draws for the signed
   * index. The surface says so, because "12 skills" read from a repository and
   * "12 skills" read from the build are different claims about how current the
   * list is. Never persisted: a seed cached as though it were a scan would
   * stop the next launch from going and getting the real one.
   */
  bundled?: boolean
}

// Plugins and MCP servers: the other two kinds a source can hold.
//
// A *plugin* is Claude Code's bundle shape — `.claude-plugin/plugin.json` over
// `skills/`, `commands/`, `agents/`, `hooks/hooks.json` and `.mcp.json` — or a
// registry entry projected into the same shape. A source lists its plugins
// from its `.claude-plugin/marketplace.json` when it has one (a marketplace),
// else from every plugin manifest in its tree.

export type SourceShape = 'claude-marketplace' | 'claude-plugin' | 'mcp-server' | 'skills' | 'mixed' | 'empty'

export const SOURCE_SHAPE_LABEL: Record<SourceShape, string> = {
  'claude-marketplace': 'Claude Code plugin marketplace',
  'claude-plugin': 'Claude Code plugin',
  'mcp-server': 'MCP server',
  skills: 'Skills',
  mixed: 'Skills and MCP servers',
  empty: 'Nothing installable',
}

/** Where a plugin's bytes live, which is also where its skills are read from. */
export type ScannedPluginOrigin =
  /** A directory in the source's own tree, '' for the root. */
  | { kind: 'in-tree'; path: string }
  /**
   * A marketplace entry pointing at another repository. `sha` is the commit
   * the marketplace pinned ('' when it pinned none), `path` the directory
   * inside that repository ('' for the root). Its components are unknown until
   * the plugin is opened and that repository is read.
   */
  | { kind: 'linked'; repo: string; ref: string; sha: string; path: string; url: string }
  /** A marketplace-registry entry (the studio source). */
  | { kind: 'registry'; entryId: string; sourceUrl: string }

export type ScannedPluginHook = {
  /** `PreToolUse`, `Stop`, … — the event as the plugin names it. */
  event: string
  /** The tool matcher, '' when the hook fires on every tool. */
  matcher: string
  /** The shell command, verbatim. This is what the trust prompt shows. */
  command: string
}

/**
 * An MCP server a source declares, in the shape `McpServerConfig` takes once
 * installed. `declaredIn` is the repo-relative path of the file that declared
 * it; `declaredBy` the plugin id when a plugin ships it, '' otherwise.
 */
export type ScannedMcpServer = {
  id: string
  name: string
  description: string
  transport: 'stdio' | 'http' | 'sse'
  command: string
  args: string[]
  url: string
  env: Record<string, string>
  envVarNames: string[]
  headers: Record<string, string>
  declaredIn: string
  declaredBy: string
}

/**
 * A language server a plugin declares. Claude Code starts it for the file
 * extensions the manifest maps, so those are what the surface can honestly say
 * the plugin covers — the twelve `*-lsp` plugins in
 * `anthropics/claude-plugins-official` are nothing BUT this declaration, their
 * directories holding a LICENSE and a README and no manifest at all.
 * `startupTimeout` is milliseconds and 0 when the manifest states none.
 */
export type ScannedLspServer = {
  /** The key the declaration is filed under: `clangd`, `rust-analyzer`, … */
  id: string
  command: string
  args: string[]
  /** `.ts` → `typescript`, verbatim from the manifest. */
  extensionToLanguage: Record<string, string>
  startupTimeout: number
  /** Repo-relative path of the file that declared it. */
  declaredIn: string
  /** The plugin id, '' when nothing named one. */
  declaredBy: string
}

export type ScannedPluginComponents = {
  /** The plugin's skills, whole: read from wherever the plugin's bytes live. */
  skills: ScannedSkill[]
  /** Command names (`commands/<name>.md`). */
  commands: string[]
  /** Agent names (`agents/<name>.md`). */
  agents: string[]
  hooks: ScannedPluginHook[]
  mcpServers: ScannedMcpServer[]
  /**
   * Language servers, a component kind of its own rather than a footnote on the
   * MCP servers: an LSP server is started per file extension by the editor
   * integration and is not an MCP endpoint at all, and a plugin can consist of
   * nothing else.
   */
  lspServers: ScannedLspServer[]
  /** Skills the entry names but that shipped with no readable directory. */
  missingSkills: string[]
}

export type ScannedPlugin = {
  /** The marketplace name, or the manifest name, or the directory name. */
  id: string
  name: string
  description: string
  version: string
  category: string
  author: string
  homepage: string
  origin: ScannedPluginOrigin
  /**
   * Whether the marketplace requires this entry to validate strictly. Absent in
   * a manifest means true, which is the marketplace schema's own default, so
   * only `strict: false` is ever written — and it is written by fourteen of the
   * official marketplace's entries, which is why dropping it made those look
   * like every other entry.
   */
  strict: boolean
  /** Curation labels the marketplace applies, e.g. `community-managed`. */
  tags: string[]
  /** Search words the entry gives itself; distinct from `tags`, which curate. */
  keywords: string[]
  /**
   * False for a linked plugin whose repository has not been read yet: its
   * components are unknown, not empty, and the surface must say so.
   */
  componentsKnown: boolean
  components: ScannedPluginComponents
  /**
   * How completely this plugin has been read, and why not when it has not been
   * (linked-plugins ruling, 2026-09-06). Absent on a scan cached before the
   * scan followed anything — which is why `componentsKnown` stays the
   * authority on whether the components are known and this only ever explains
   * it.
   */
  readState?: PluginReadState
  /**
   * The commit a read of a LINKED plugin actually used. Distinct from
   * `origin.sha`, which is what the marketplace pinned and is '' when it
   * pinned nothing: writing a resolved commit back into `origin.sha` made an
   * entry the publisher deliberately left floating look pinned, and quietly
   * moved installs onto whatever commit a scan happened to see (linked-plugins
   * review, 2026-09-06).
   */
  readCommit?: string
  /**
   * The glyph the entry gives itself — an emoji, or one or two characters of
   * text. Optional twice over: most entries declare none, and every scan
   * cached before this was read carries none either.
   */
  icon?: string
  /** An https image URL the entry gives itself. Same two absences as `icon`. */
  logo?: string
}

/**
 * `icon` and `logo` on a marketplace entry: the glyph and the picture a plugin
 * publishes for itself.
 *
 * Neither is in the documented field table (code.claude.com/docs/en/
 * plugin-marketplaces, read 2026-09-10; anthropics/claude-code#28187 is the
 * open request to standardise them), but the marketplace schema says any field
 * valid in a plugin manifest may be written on an entry, and marketplaces in
 * the wild already write both. So they are read where they appear — the entry
 * first, the plugin's own manifest after it — and VALIDATED rather than
 * trusted, because a field nobody specified is a field publishers will put
 * anything in.
 *
 * A glyph is text this app prints inside a 36px chip: at most
 * `MAX_PLUGIN_ICON_CODE_POINTS` code points (a family emoji is seven) making
 * at most `MAX_PLUGIN_ICON_GRAPHEMES` things the eye sees, at least one of
 * them visible, no control or bidi characters, and nothing that is really a
 * path or a URL — `./icon.png` is the picture the open request proposes, and
 * printing it as text would put a filename in the slot.
 */
export const MAX_PLUGIN_ICON_CODE_POINTS = 8

/**
 * The most grapheme clusters a glyph may hold. Two: "an emoji, or a character
 * or two of text" is what the slot draws, and eight code points of plain
 * letters — inside the code-point cap — would spill past a 36px chip at any
 * size an emoji reads at.
 */
export const MAX_PLUGIN_ICON_GRAPHEMES = 2

/**
 * How many things the eye sees in a glyph: 👨‍👩‍👧‍👦 is one, `AI` is two. What the
 * chip must size its text by, since code points say nothing about width. Falls
 * back to code points where `Intl.Segmenter` is missing, which over-counts and
 * so only ever draws smaller.
 */
export function glyphGraphemeCount(text: string): number {
  if (typeof Intl.Segmenter === 'function') {
    let count = 0
    for (const _ of new Intl.Segmenter(undefined, { granularity: 'grapheme' }).segment(text)) count += 1
    return count
  }
  return [...text].length
}

/** The entry's `icon` as a glyph this app may print, or '' when it is not one. */
export function pluginIconGlyph(value: unknown): string {
  const text = typeof value === 'string' ? value.trim() : ''
  if (text === '') return ''
  if ([...text].length > MAX_PLUGIN_ICON_CODE_POINTS) return ''
  if (glyphGraphemeCount(text) > MAX_PLUGIN_ICON_GRAPHEMES) return ''
  // Control characters and line breaks, not every `\p{C}`: the zero-width
  // joiner is a format character, and rejecting it would reject 👩‍💻 and every
  // other emoji built by joining two. The bidi controls ARE rejected by name,
  // though they are format characters too: a right-to-left override in the
  // glyph slot reverses the plugin's name printed beside it, and nothing an
  // emoji is built from is one of them.
  if (/[\p{Cc}\p{Zl}\p{Zp}\p{Bidi_Control}]/u.test(text)) return ''
  // At least one character that draws. A lone joiner or variation selector
  // passes every test above and renders as an empty chip, which is the one
  // thing the slot must never show.
  if (!/[^\p{C}\p{M}\p{Z}]/u.test(text)) return ''
  if (/[/\\]/.test(text) || /^[A-Za-z][A-Za-z0-9+.-]*:/.test(text)) return ''
  return text
}

/**
 * The entry's `logo` as an https URL, or '' when it is not one. Only https: a
 * marketplace is read over the network and its logo is fetched by the
 * renderer, so http would be a downgrade and `data:`/`file:` a way to hand the
 * window bytes nobody fetched.
 */
export function pluginLogoUrl(value: unknown): string {
  const text = typeof value === 'string' ? value.trim() : ''
  if (text === '') return ''
  try {
    return new URL(text).protocol === 'https:' ? text : ''
  } catch {
    return ''
  }
}

/**
 * How completely a plugin has been read.
 *
 * A scan follows linked plugins within a budget (`MAX_LINKED_REPOSITORY_READS`
 * in src/main/skills/scan-plugins.ts), so "not read" is several very different
 * facts: one a later scan fixes by itself, one opening the plugin fixes, and
 * one no amount of either will. Saying which is the whole point — 238 rows
 * reading "Read when opened" told a person nothing about whether opening one
 * would work.
 */
export type PluginReadState =
  /** Components read, and every skill's entry document read with them. */
  | { status: 'read' }
  /**
   * Components read from the repository's tree, but the skills' entry
   * documents were not: the follow proves what a plugin ships without spending
   * a request per skill across 238 repositories. Opening the plugin reads
   * them. `componentsKnown` is true — the components really are known.
   */
  | { status: 'listed' }
  /**
   * Files the tree listed could not be fetched, so what was read is not the
   * whole plugin. `componentsKnown` is FALSE for this: a hooks file lost to
   * throttling would otherwise be cached as a plugin with no hooks, and the
   * install gate would wave through the very commands it exists to disclose.
   */
  | { status: 'partial'; unread: string[] }
  /**
   * Nothing was fetched for it, for a reason about this moment rather than
   * about the plugin: the pass's budget ran out, GitHub's rate limit did, or
   * the network was not there. The next scan resumes where this one stopped,
   * because every plugin already read is cached against its pinned sha and
   * costs nothing. `blocked` marks the one repository whose reply stopped the
   * pass, so the next pass can put it last instead of halting on it again.
   */
  | { status: 'pending'; reason: 'budget' | 'rate-limited' | 'offline'; blocked?: true }
  /** Reading it was refused or failed in a way a retry will not change. */
  | { status: 'unreadable'; message: string }

/** How much of a source's linked population is read, for the head line. */
export type LinkedPluginSummary = {
  total: number
  read: number
  pending: number
  unreadable: number
  /**
   * Why the pending ones are pending. The sentence branches on this: "add a
   * GitHub token" is the right advice for a budget or a rate limit and the
   * wrong advice for a machine with no network, and printing one line for all
   * three was the count and the rows disagreeing (linked-plugins review,
   * 2026-09-06).
   */
  pendingReasons: { budget: number; rateLimited: number; offline: number }
}

export function summariseLinkedPlugins(scan: Pick<ScanResult, 'plugins'>): LinkedPluginSummary {
  const summary: LinkedPluginSummary = {
    total: 0,
    read: 0,
    pending: 0,
    unreadable: 0,
    pendingReasons: { budget: 0, rateLimited: 0, offline: 0 },
  }
  for (const plugin of scanPlugins(scan)) {
    if (plugin.origin.kind !== 'linked') continue
    summary.total += 1
    const state = plugin.readState
    if (plugin.componentsKnown) {
      summary.read += 1
      continue
    }
    if (state?.status === 'unreadable' || state?.status === 'partial') {
      summary.unreadable += 1
      continue
    }
    summary.pending += 1
    // A scan cached before any of this existed carries no state at all; it is
    // counted as budget, which is the reason a re-scan will actually clear.
    if (state?.status === 'pending' && state.reason === 'rate-limited') summary.pendingReasons.rateLimited += 1
    else if (state?.status === 'pending' && state.reason === 'offline') summary.pendingReasons.offline += 1
    else summary.pendingReasons.budget += 1
  }
  return summary
}

/**
 * The head line's admission that a scan is partial, in the pieces a surface can
 * act on. Empty when there is nothing to admit: a source with no linked
 * plugins, and one whose linked plugins are all read, say nothing extra
 * because the counts beside them already stand.
 *
 * The token is named only when there is not one AND the API is what is doing
 * the reading: at 60 unauthenticated requests an hour the budget is 20
 * repositories a scan, and "add a GitHub token" is the action that turns twelve
 * scans into one (linked-plugins ruling, 2026-09-06). With a token in place the
 * honest next step is Sync, which resumes from what is already cached. That
 * clause carries `action`, so the head line can make those words the button
 * that opens the setting rather than telling a person to go and find it; the
 * clause about plugins that could not be read carries none, because no setting
 * fixes a repository that is gone.
 *
 * Over git none of that arithmetic applies (git-transport ruling, owner
 * 2026-09-08): git's protocol is not what the REST limit counts, there is no
 * per-scan repository budget left to spend, and a token buys nothing — so the
 * remedy is Sync and the token is never named. The one thing a person on the
 * API path may actually be missing is git itself, and `gitInstalled: false`
 * says so instead of selling them a token that only widens a limit they should
 * not be hitting at all.
 */
export type LinkedPluginShortfallPart = { text: string; action: 'github-settings' | null }

export function linkedPluginShortfall(
  summary: LinkedPluginSummary,
  tokenConfigured: boolean,
  transport: SkillRepoTransport = 'api',
  gitInstalled = true,
): LinkedPluginShortfallPart[] {
  const parts: LinkedPluginShortfallPart[] = []
  if (summary.pending > 0) {
    // The remedy is whatever is actually in the way, worst first. A machine
    // with no network is not helped by a token, and a spent rate limit is not
    // helped by pressing Sync again this minute — printing one line for all
    // three reasons was advice that was wrong exactly when it mattered
    // (linked-plugins review, 2026-09-06).
    const { offline, rateLimited } = summary.pendingReasons
    const remedy: LinkedPluginShortfallPart =
      offline > 0
        ? { text: 'GitHub could not be reached', action: null }
        : transport === 'git'
          ? // Nothing here is rationed by the API any more: whatever is left is
            // left because the pass stopped, and Sync is what resumes it.
            { text: 'Sync to read the rest', action: null }
          : !gitInstalled
            ? { text: 'install git', action: null }
            : !tokenConfigured
              ? { text: 'add a GitHub token', action: 'github-settings' }
              : rateLimited > 0
                ? { text: "Sync once GitHub's rate limit resets", action: null }
                : { text: 'Sync to read the rest', action: null }
    parts.push({
      text: `${summary.pending} of ${summary.total} linked plugins not yet read — ${remedy.text}`,
      action: remedy.action,
    })
  }
  if (summary.unreadable > 0) {
    // "in full" because this bucket holds both a repository nothing could read
    // and one whose read lost files along the way.
    parts.push({
      text: `${summary.unreadable} of ${summary.total} linked ${summary.unreadable === 1 ? 'plugin' : 'plugins'} could not be read in full`,
      action: null,
    })
  }
  return parts
}

/**
 * A scan's plugins, with every field this build requires actually present.
 *
 * Scans are cached verbatim beside their source and are never migrated, so a
 * cache written before a field existed holds plugins without it. That is not a
 * cosmetic gap: `plugin.components.lspServers.length` on one of those throws
 * where the row is drawn, which takes the whole Plugins tab down — and Sync,
 * the only thing that would replace the cache, sits behind that render. Every
 * reader goes through here, so the gap is filled on the way out instead.
 *
 * A plugin that already has everything is returned as it is: a source scanned
 * by this build pays one shape check per plugin and allocates nothing.
 */
export function scanPlugins(scan: Pick<ScanResult, 'plugins'>): ScannedPlugin[] {
  const plugins = scan.plugins ?? []
  return plugins.every(isCompleteScannedPlugin) ? plugins : plugins.map(completeScannedPlugin)
}

function isCompleteScannedPlugin(plugin: ScannedPlugin): boolean {
  const components = plugin.components as Partial<ScannedPluginComponents> | undefined
  if (!components) return false
  return (
    typeof plugin.strict === 'boolean' &&
    Array.isArray(plugin.tags) &&
    Array.isArray(plugin.keywords) &&
    Array.isArray(components.skills) &&
    Array.isArray(components.commands) &&
    Array.isArray(components.agents) &&
    Array.isArray(components.hooks) &&
    Array.isArray(components.mcpServers) &&
    Array.isArray(components.lspServers) &&
    Array.isArray(components.missingSkills)
  )
}

/**
 * The defaults a missing field takes: empty for every list, and `strict: true`
 * for the flag, which is the marketplace schema's own default. Nothing is
 * invented — an absent list becomes an empty one, which is what an older scan
 * knowing nothing about a component kind actually means.
 */
function completeScannedPlugin(plugin: ScannedPlugin): ScannedPlugin {
  const stored = (plugin.components ?? {}) as Partial<ScannedPluginComponents>
  const empty = emptyPluginComponents()
  const list = <T>(value: T[] | undefined, fallback: T[]): T[] => (Array.isArray(value) ? value : fallback)
  return {
    ...plugin,
    strict: typeof plugin.strict === 'boolean' ? plugin.strict : true,
    tags: list(plugin.tags, []),
    keywords: list(plugin.keywords, []),
    components: {
      skills: list(stored.skills, empty.skills),
      commands: list(stored.commands, empty.commands),
      agents: list(stored.agents, empty.agents),
      hooks: list(stored.hooks, empty.hooks),
      mcpServers: list(stored.mcpServers, empty.mcpServers),
      lspServers: list(stored.lspServers, empty.lspServers),
      missingSkills: list(stored.missingSkills, empty.missingSkills),
    },
  }
}

export function scanMcpServers(scan: Pick<ScanResult, 'mcpServers'>): ScannedMcpServer[] {
  return scan.mcpServers ?? []
}

/** The shape, derived when the scan predates the field. */
export function scanShape(scan: ScanResult): SourceShape {
  if (scan.shape) return scan.shape
  return scan.skills.length > 0 ? 'skills' : 'empty'
}

export function emptyPluginComponents(): ScannedPluginComponents {
  return { skills: [], commands: [], agents: [], hooks: [], mcpServers: [], lspServers: [], missingSkills: [] }
}

/**
 * The marketplace's `renames` map, old name → the name it lists the plugin
 * under now. Carried whole rather than resolved at scan time: the map may name
 * a plugin the listing no longer holds, and a lookup that silently dropped
 * those would answer "no such plugin" for a name the marketplace explicitly
 * accounts for.
 */
export function scanPluginRenames(scan: Pick<ScanResult, 'pluginRenames'>): Record<string, string> {
  return scan.pluginRenames ?? {}
}

/**
 * Every name a plugin has answered to: the names `renames` points AT it, and
 * the id it goes by now. This is what a receipt written before an upstream
 * rename has to be matched against — `anthropics/claude-plugins-official`
 * renamed `adlc` to `agentforce-adlc`, and without the map the plugin a person
 * installed reads as not installed and installing it again duplicates it.
 */
export function pluginAliases(renames: Readonly<Record<string, string>>, pluginId: string): string[] {
  const aliases = new Set<string>([pluginId])
  for (const [was, now] of Object.entries(renames)) {
    if (now === pluginId) aliases.add(was)
  }
  return [...aliases]
}

/**
 * Whether opening this plugin would actually read anything new.
 *
 * True for a linked plugin the scan has not read, has read only partly, or has
 * `listed` — the follow proves a plugin's components from its repository's tree
 * without fetching one skill's entry document, so a listed plugin's skills
 * carry directory names and no descriptions until this returns true and
 * somebody opens it. It was not returning true for those, which left the
 * descriptions blank forever (linked-plugins review, 2026-09-06).
 */
export function pluginNeedsRead(plugin: Pick<ScannedPlugin, 'origin' | 'componentsKnown' | 'readState'>): boolean {
  if (plugin.origin.kind !== 'linked') return false
  return !plugin.componentsKnown || plugin.readState?.status !== 'read'
}

/** A plugin by the name it goes by now, or by any name `renames` points at it. */
export function findScannedPlugin(
  scan: Pick<ScanResult, 'plugins' | 'pluginRenames'>,
  pluginId: string,
): ScannedPlugin | null {
  const plugins = scanPlugins(scan)
  const direct = plugins.find((plugin) => plugin.id === pluginId)
  if (direct) return direct
  const renamed = scanPluginRenames(scan)[pluginId]
  if (!renamed) return null
  return plugins.find((plugin) => plugin.id === renamed) ?? null
}

/**
 * Why a plugin's components are unknown — the two reasons are not the same
 * promise.
 *
 * `unopened`: a linked plugin, whose bytes are in another repository and are
 * fetched the moment it is opened. `over-scan-limit`: an in-tree plugin the
 * scan did not read because the source lists more plugins than one scan reads.
 * Opening that one reads nothing, so telling a person to open it — which is
 * what this said until 2026-09-06 — sends them to press a button that cannot
 * work and leaves Install refusing with no reason given.
 */
export function unreadPluginReason(
  plugin: Pick<ScannedPlugin, 'componentsKnown' | 'origin' | 'readState'>,
): 'read' | 'unopened' | 'over-scan-limit' | 'incomplete' {
  if (plugin.componentsKnown) return 'read'
  // A read that lost files is its own case: it is not waiting to be opened and
  // it is not past a limit — some of it arrived and some of it did not, and
  // both an in-tree and a linked plugin can end up here.
  if (plugin.readState?.status === 'partial') return 'incomplete'
  return plugin.origin.kind === 'linked' ? 'unopened' : 'over-scan-limit'
}

/**
 * The two or three words a ROW wears when a plugin has not been read: short
 * enough to sit beside "Plugin" as a chip, and present at all only because a
 * row shows a plugin's description when it has one, which every one of the
 * official marketplace's 238 linked entries does. Without the chip a plugin
 * nothing could read looked exactly like one that was read (linked-plugins
 * ruling, 2026-09-06).
 */
export function unreadPluginChip(plugin: ScannedPlugin): string | null {
  if (plugin.componentsKnown) return null
  const state = plugin.readState
  if (state?.status === 'partial') return 'Partly read'
  if (unreadPluginReason(plugin) !== 'unopened') return 'Not scanned'
  if (state?.status === 'unreadable') return 'Could not be read'
  if (state?.status === 'pending' && state.reason === 'rate-limited') return 'Rate limited'
  if (state?.status === 'pending' && state.reason === 'offline') return 'GitHub unreachable'
  return 'Not read yet'
}

/**
 * The pane's fuller answer to "why is nothing listed here": the row's few words
 * plus what to do about them.
 *
 * The three cases are three different next steps, which is exactly why they are
 * three sentences rather than one (linked-plugins ruling, 2026-09-06). Opening
 * the plugin reads it. Waiting for the rate limit to reset and syncing reads
 * it. Nothing reads a repository this app will not fetch from, and saying
 * "not read yet" there would send a person to press a button that cannot work.
 */
export function describeUnreadPlugin(plugin: ScannedPlugin): string {
  const reason = unreadPluginReason(plugin)
  if (reason === 'incomplete') {
    const unread = plugin.readState?.status === 'partial' ? plugin.readState.unread : []
    const files = unread.length === 1 ? unread[0] : `${unread.length} of its files`
    // Named, because WHICH file went missing decides what is unknown: a lost
    // hooks file means nobody can be shown the commands the plugin would run,
    // which is why this is not listed as a plugin that ships none.
    return `${files} could not be read, so this is not all of the plugin — its hooks and servers may be understated. Open it, or Sync the source, to read it again.`
  }
  if (reason !== 'unopened') {
    return 'This source lists more plugins than one scan reads, and this one was past the limit. Its components are unknown, and opening it reads nothing — Sync the source when it has fewer.'
  }
  const state = plugin.readState
  if (state?.status === 'unreadable') {
    return `${state.message} Its components cannot be listed from here.`
  }
  if (state?.status === 'pending' && state.reason === 'rate-limited') {
    return 'GitHub rate-limited the scan before this plugin was read. Open it to read it now, or Sync once the limit resets.'
  }
  if (state?.status === 'pending' && state.reason === 'offline') {
    return 'GitHub could not be reached while the scan was reading this plugin. Sync when the connection is back.'
  }
  return 'Not read yet. Its components are unknown until its repository is read.'
}

/**
 * The words a row uses for what a plugin ships: "4 skills · 2 commands · 1 MCP".
 *
 * An unread linked plugin says WHY it is unread rather than the flat "Read when
 * opened" it said before the scan followed any of them (linked-plugins ruling,
 * 2026-09-06): a repository off the allowlist and a repository this pass simply
 * had no budget left for are different promises, and 238 rows making the same
 * one said nothing about which.
 */
export function describePluginComponents(plugin: ScannedPlugin): string {
  if (!plugin.componentsKnown) {
    const state = plugin.readState
    if (state?.status === 'partial') {
      return `Partly read — ${state.unread.length} ${state.unread.length === 1 ? 'file' : 'files'} could not be read`
    }
    if (unreadPluginReason(plugin) !== 'unopened') return 'Not read by this scan'
    if (!state || state.status === 'read' || state.status === 'listed') return 'Read when opened'
    if (state.status === 'unreadable') return state.message
    if (state.reason === 'rate-limited') return 'Not read — GitHub rate limit reached'
    if (state.reason === 'offline') return 'Not read — GitHub could not be reached'
    return 'Not read yet — read when opened'
  }
  const c = plugin.components
  const parts: string[] = []
  const count = (n: number, one: string, many: string): void => {
    if (n > 0) parts.push(`${n} ${n === 1 ? one : many}`)
  }
  count(c.skills.length, 'skill', 'skills')
  count(c.commands.length, 'command', 'commands')
  count(c.agents.length, 'agent', 'agents')
  count(c.mcpServers.length, 'MCP', 'MCP')
  count(c.lspServers.length, 'LSP server', 'LSP servers')
  count(c.hooks.length, 'hook', 'hooks')
  return parts.length > 0 ? parts.join(' · ') : 'No components declared'
}

export const SKILL_ENTRY_FILE = 'SKILL.md'

/** Group name for skills that sit directly at a source's root. */
export const SKILL_REPO_ROOT_GROUP = '(repo root)'

/**
 * Group name for skills a `.claude-plugin/marketplace.json` does not list.
 *
 * The Agent Skills specification defines no collection manifest, so a manifest
 * is a source's own grouping and never its census: a directory with a SKILL.md
 * that the manifest forgot is still a skill, and must not vanish because a
 * plugin list omitted it (anthropics/skills' `template/` is the visible case).
 *
 * The renderer's own fallback heading for a group the scan did not list is this
 * same constant, so a source never shows two headings meaning the same thing. A
 * manifest that authors a group of this name absorbs the unlisted skills into
 * it: one heading, every skill reachable, which is the better of the two ways
 * that collision can go.
 */
export const SKILL_UNLISTED_GROUP = 'Everything else'

// Our own marketplace, an always-present source since the studio-marketplace
// ruling (2026-09-06). It was two backends behind one tab — a folder scan under
// Skills, the signed registry under Plugins — and it is now the repository we
// publish, in the Claude marketplace format, read like any other repository.
//
// Its id is the one `addSource` would mint for it, so someone who pastes
// `sprintengine/studio-releases` into "Add from GitHub…" is told they already
// have it rather than getting a second, removable tab of the same plugins.
export const STUDIO_SKILL_SOURCE_REPO = 'sprintengine/studio-releases'
export const STUDIO_SKILL_SOURCE_ID = `github:${STUDIO_SKILL_SOURCE_REPO}`
/** What that source is CALLED: the product, not the repository path. */
export const STUDIO_SKILL_SOURCE_NAME = 'SprintEngine Studio'

// Claude Code's own plugin marketplace, an always-present source since the
// official-plugins ruling (2026-09-06). Its id is the one `addSource` would
// have minted for it, so someone who pastes the repository into "Add from
// GitHub…" is told they already have it rather than getting a second tab of the
// same 292 plugins.
export const OFFICIAL_PLUGINS_SKILL_SOURCE_REPO = 'anthropics/claude-plugins-official'
export const OFFICIAL_PLUGINS_SKILL_SOURCE_ID = `github:${OFFICIAL_PLUGINS_SKILL_SOURCE_REPO}`
/** What that source is CALLED: the publisher, not the repository path. */
export const OFFICIAL_PLUGINS_SKILL_SOURCE_NAME = 'Anthropic'

/**
 * A source every install has and nobody can remove. The store is the authority
 * (`ALWAYS_PRESENT_SKILL_SOURCES` in main), but the renderer has to know too —
 * offering "Remove source" on a tab that refuses to go is an action that
 * reports a failure the person could not have avoided.
 */
export function isBundledSkillSource(id: string): boolean {
  return ALWAYS_PRESENT_SKILL_SOURCE_IDS.includes(id)
}

/**
 * The ids of those sources, as a list. `isBundledSkillSource` is the predicate;
 * this is what a de-duplication needs — the recommended-sources region in the
 * Extensions door subtracts these from the hosted feed so a source every
 * machine already ships is never offered as an Add.
 */
export const ALWAYS_PRESENT_SKILL_SOURCE_IDS: readonly string[] = [
  STUDIO_SKILL_SOURCE_ID,
  OFFICIAL_PLUGINS_SKILL_SOURCE_ID,
]

/** Every local source's id is this prefix plus its absolute path. */
export const LOCAL_SKILL_SOURCE_ID_PREFIX = 'local:'

/** The last path segment — what a folder source is called on screen. */
export function localSourceFolderName(path: string): string {
  const segments = path.split(/[\\/]/).filter((segment) => segment.length > 0)
  return segments.length > 0 ? segments[segments.length - 1] : path
}

// Discover: finding a skill you do not already have the repository for.
//
// Repository search matches a repo's name, description and README, so it finds
// repos that *mention* a capability. Code search matches inside `SKILL.md`, so
// it finds skills that *do* it — including skills vendored inside repos that are
// not skill collections at all. Discover produces candidates; scanning one is
// the existing add-a-source path.

/**
 * Why a Discover query could not answer in full. Always stated: an empty list
 * with no condition means "GitHub has no match", and nothing else may borrow
 * that meaning.
 */
export type SkillDiscoveryCondition = {
  reason: 'needs_token' | 'rate_limited' | 'query_too_short' | 'unavailable'
  message: string
  /** Seconds until the limit resets; 0 when GitHub did not say, or not a limit. */
  retryAfterSeconds: number
}

/** What GitHub reported about the budget the query spent from. */
export type SkillRateLimit = {
  limit: number
  remaining: number
  /** ISO timestamp the window resets at; '' when GitHub did not say. */
  resetAt: string
}

/** One skill found inside a repository — a candidate to scan, not a source. */
export type SkillSearchHit = {
  /** `owner/name`. */
  repo: string
  /** Repo-relative path of the matched SKILL.md. */
  path: string
  /** Directory holding the skill — its id once the repo is scanned; '' at the root. */
  skillId: string
  /** From the matched frontmatter, falling back to the directory name. */
  name: string
  /** From the matched frontmatter; '' when the fragment carried none. */
  description: string
  htmlUrl: string
}

/**
 * A repository Discover offers to scan. It carries no skill count on purpose:
 * the count is unknown until the repo is scanned, and stars do not predict it —
 * one 52k-star repo holds a single skill while a 4.9k-star one holds 103.
 */
export type SkillRepoHit = {
  repo: string
  description: string
  /** null when the result did not come with a star count — never shown as 0. */
  stars: number | null
  htmlUrl: string
  /** Carries `.claude-plugin/marketplace.json`: someone curated the contents. */
  curated: boolean
}

export type SkillDiscoveryResult<T> = {
  results: T[]
  rateLimit: SkillRateLimit | null
  degraded: SkillDiscoveryCondition | null
}

/** Shortest query code search is asked to run; below it GitHub matches everything. */
export const MIN_SKILL_SEARCH_QUERY_LENGTH = 3

// Agent capabilities: what the agent in one terminal can actually reach.
//
// Derived on demand from the harness directories and CLI config files, never
// from a record of what we intended to install — someone who hand-edits
// `.claude/skills` or `.mcp.json` sees the result here. One query answers the
// whole question so no surface joins several calls and drifts from the next.

/** Where an installed skill directory came from, read from its provenance marker. */
export type AgentSkillSource = 'builtin' | 'source' | 'local'

export type AgentSkill = {
  /** Directory name, which is the skill's identity to every CLI that reads it. */
  id: string
  name: string
  /** '' when the SKILL.md carries no description; never invented copy. */
  description: string
  /** How to invoke it in this CLI, rendered from the plugin's own template. */
  invocation: string
  source: AgentSkillSource
  /** The skill source it was installed from, when a source installed it. */
  sourceId?: string
  /**
   * Every CLI bound to this harness. The skill lives in one directory, and each
   * of these can read it — this is the attribution that stops a shared skill
   * being counted once per CLI.
   */
  pluginIds: string[]
}

/**
 * An MCP server a CLI is configured with, read from that CLI's own config file
 * by the format adapter its manifest declares. Configured, not necessarily
 * loaded: a config that marks a server disabled still declares it, and both
 * CLIs that express that state list it as disabled rather than omitting it, so
 * dropping it here would hide something the user wrote.
 */
/** A server's connection as the running CLI last reported it. */
export type AgentMcpServerStatus = 'connected' | 'failed' | 'needs-auth' | 'pending' | 'disabled'

export type AgentMcpServer = {
  id: string
  transport: string
  /** Absent unless the config states it — a count is never guessed. */
  toolCount?: number
  /**
   * Which of the CLI's two declared config files this entry won from, or
   * `session` for a server only a running CLI reported (one from its own user
   * settings, a plugin, or its account), which has no file of ours to name.
   */
  scope: 'workspace' | 'user' | 'session'
  /** Absent for a `session` server. */
  configPath?: string
  /** Absent until a chat on this CLI in this folder has reported it. */
  status?: AgentMcpServerStatus
  /** Why it failed, in the CLI's words, when it did. */
  error?: string
}

/**
 * Why one path could not be read, or could not be kept true. A union, not a
 * boolean: `malformed` (a file that opened but could not be parsed) is a
 * different fault from one that could not be opened at all, and the likeliest
 * real-world one for a config file. `watch_unavailable` is not a read failure
 * at all — the answer is correct as of the read and may go stale.
 */
type CapabilityDiagnosticReason = 'unreadable' | 'malformed' | 'watch_unavailable'

/**
 * Which half of the answer a fault belongs to, or `freshness` for one that
 * belongs to neither: a path that could not be watched leaves both halves
 * readable but possibly stale, which a surface must say differently from a
 * half that failed to read.
 */
type CapabilityKind = 'skills' | 'servers' | 'freshness'

export type CapabilityDiagnostic = {
  /**
   * A surface that renders one half must not be blanked by the other half's
   * fault: an unparseable `.mcp.json` is not a reason to stop listing skills.
   */
  capability: CapabilityKind
  reason: CapabilityDiagnosticReason
  /** The path that failed, so the surface can name it. */
  path: string
  message: string
}

/**
 * Whether installing a bundled skill would actually put it where this harness
 * reads: `all-native` covers every natively-supported CLI, a static list covers
 * the harnesses it names, and the default target (`.agents`, prompt-injected)
 * reaches no CLI's own directory.
 *
 * One rule, because two surfaces ask it — the Skills pane's search-only
 * catalogue and `SkillPickerPopover`'s "available" rows. Offering a skill the
 * attach path will route into some *other* CLI's directory is an Add that
 * reports success and changes nothing for the agent the user is looking at —
 * the picker applied that rule privately, the pane did not apply it at all.
 * It lives here rather than beside either of them because it is a fact about a
 * bundled skill's declared targets, not about how a surface draws them.
 */
export function builtinInstallsIntoHarness(
  skill: { harnesses?: readonly string[]; targetPolicy?: string },
  harnessId: string,
): boolean {
  if (skill.targetPolicy === 'all-native') return true
  return (skill.harnesses ?? []).some((harness) => harness === harnessId)
}

export type AgentCapabilitiesInput = {
  /** Null asks only about what the CLI reads from the home folder (needs `includeGlobal`). */
  workspaceRoot: string | null
  pluginId: string
  /**
   * Also list the skills in this CLI's home-folder skills directory — what it
   * reads in every project. Servers are still the workspace's alone.
   */
  includeGlobal?: boolean
}

/**
 * `ok: false` is reserved for a question that could not be asked (no workspace).
 * A CLI with no skill support, and a harness directory that was never created,
 * are both `ok: true` with a stated `support` — an unavailable capability is a
 * result, never an empty list.
 */
export type AgentCapabilitiesResult =
  | {
      ok: true
      support: 'native' | 'prompt-shim' | 'unsupported'
      /** '' when the plugin declares no skill integration at all. */
      harnessId: string
      skills: AgentSkill[]
      servers: AgentMcpServer[]
      diagnostics: CapabilityDiagnostic[]
    }
  | { ok: false; message: string }

/**
 * "Ask again" — never the new answer. One per `(workspaceRoot, harnessId)`
 * after the watcher's debounce, so a ten-file install moves the surface once.
 *
 * `harnessId` is the coalescing identity; `pluginIds` says which CLIs' queries
 * it covers, because a CLI can declare an MCP config and no skill integration
 * at all (cursor) and so has no harness id to be addressed by.
 */
export type AgentCapabilitiesInvalidation = {
  workspaceRoot: string
  /** '' when the group is a CLI that declares no skill integration. */
  harnessId: string
  pluginIds: string[]
}

export type SkillFrontmatter = {
  name: string
  description: string
  allowedTools: string[]
  /** The spec's optional `license`; '' when the skill declares none. */
  license: string
  /** The spec's optional `compatibility`; '' when the skill declares none. */
  compatibility: string
  /** The spec's optional `metadata` map; empty when the skill declares none. */
  metadata: Record<string, string>
}

/** Every field blank — what an unreadable or frontmatter-less entry yields. */
function emptySkillFrontmatter(): SkillFrontmatter {
  return { name: '', description: '', allowedTools: [], license: '', compatibility: '', metadata: {} }
}

/**
 * Read the SKILL.md frontmatter fields the surface discloses — every field the
 * Agent Skills specification defines (https://agentskills.io/specification,
 * fetched 2026-09-06): `name`, `description`, and the optional `license`,
 * `compatibility`, `metadata` and `allowed-tools`.
 *
 * Deliberately not a YAML parser: skill frontmatter is a flat block of scalars
 * plus one map and one tool list, and a real YAML dependency would buy nothing
 * but a larger parse surface for third-party bytes.
 */
export function parseSkillFrontmatter(raw: string): SkillFrontmatter {
  // A byte-order mark sits BEFORE the opening fence, so `^---` never matches a
  // SKILL.md saved by a Windows editor. That used to cost the row its
  // description; since a skill with no description is skipped (2026-09-06) it
  // would cost the skill its row, which is a repository's file deleted from a
  // listing over three invisible bytes.
  const block = stripByteOrderMark(raw).match(/^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/)
  const result: SkillFrontmatter = emptySkillFrontmatter()
  if (!block) return result

  const lines = block[1].split(/\r?\n/)
  for (let index = 0; index < lines.length; index += 1) {
    const scalar = lines[index].match(/^(name|description|license|compatibility):\s*(.*)$/)
    if (scalar) {
      const inline = unquoteYamlScalar(scalar[2])
      // A folded or literal block (`description: >`) carries its text on the
      // indented lines below. Reading the marker as the value is how a row came
      // to show ">" where its description belongs — `parseSkillFragment` has
      // always folded these, and now both sides of the same file agree.
      const value = isYamlBlockMarker(inline) ? foldedBlockValue(lines, index + 1) : inline
      const key = scalar[1] as 'name' | 'description' | 'license' | 'compatibility'
      // First occurrence wins, as YAML itself would take it.
      if (!result[key]) result[key] = value
      continue
    }
    const meta = lines[index].match(/^metadata:\s*(.*)$/)
    if (meta) {
      if (Object.keys(result.metadata).length === 0) {
        result.metadata = readMetadataMap(lines, index, unquoteYamlScalar(meta[1]))
      }
      continue
    }
    const tools = lines[index].match(/^allowed-tools:\s*(.*)$/)
    if (!tools || result.allowedTools.length > 0) continue
    const inline = unquoteYamlScalar(tools[1])
    if (inline) {
      result.allowedTools = splitToolList(inline)
      continue
    }
    // Block sequence: `allowed-tools:` followed by indented `- ` items.
    for (let cursor = index + 1; cursor < lines.length; cursor += 1) {
      const item = lines[cursor].match(/^\s+-\s*(.+?)\s*$/)
      if (!item) break
      const value = unquoteYamlScalar(item[1])
      if (value) result.allowedTools.push(value)
    }
  }
  return result
}

/**
 * Name and description out of a code-search text-match fragment.
 *
 * The fragment is a window into SKILL.md rather than the whole file, so the
 * `---` fences are usually missing and `parseSkillFrontmatter` would return
 * nothing. Fields it cannot find come back empty: the row then shows the path
 * it did find, never invented copy.
 */
export function parseSkillFragment(fragment: string): { name: string; description: string } {
  const lines = stripByteOrderMark(fragment).split(/\r?\n/)
  const found = { name: '', description: '' }
  for (let index = 0; index < lines.length; index += 1) {
    const field = lines[index].match(/^(name|description):\s*(.*)$/)
    if (!field) continue
    const key = field[1] as 'name' | 'description'
    if (found[key]) continue
    const inline = unquoteYamlScalar(field[2])
    found[key] = isYamlBlockMarker(inline) ? foldedBlockValue(lines, index + 1) : inline
  }
  return found
}

function isYamlBlockMarker(value: string): boolean {
  return value === '' || /^[|>][+-]?$/.test(value)
}

/** The indented lines under a folded or empty scalar, joined the way YAML folds them. */
function foldedBlockValue(lines: readonly string[], start: number): string {
  const collected: string[] = []
  for (let cursor = start; cursor < lines.length; cursor += 1) {
    const line = lines[cursor]
    if (!/^\s+\S/.test(line)) break
    collected.push(line.trim())
  }
  return collected.join(' ')
}

/**
 * The `metadata` map: a block of indented `key: value` lines under the field,
 * or a flow map on the field's own line. Values are strings, which is all the
 * specification defines the map to hold.
 */
function readMetadataMap(lines: readonly string[], index: number, inline: string): Record<string, string> {
  const found: Record<string, string> = {}
  if (inline.startsWith('{') && inline.endsWith('}')) {
    for (const pair of inline.slice(1, -1).split(',')) {
      const cut = pair.indexOf(':')
      if (cut === -1) continue
      const key = unquoteYamlScalar(pair.slice(0, cut))
      if (key && !(key in found)) found[key] = unquoteYamlScalar(pair.slice(cut + 1))
    }
    return found
  }
  // A scalar where a map belongs is not a map; reading it as one would invent
  // a key nobody wrote.
  if (inline !== '') return found
  // The map's own indent, taken from its first entry: a deeper line belongs to
  // a nested structure, and reading it here would invent a key at the top level
  // — usually one whose value is the empty string, which then renders as a row
  // stating nothing. The specification's map is string to string.
  let indent = -1
  for (let cursor = index + 1; cursor < lines.length; cursor += 1) {
    const entry = lines[cursor].match(/^(\s+)([^\s:][^:]*):\s*(.*)$/)
    if (!entry) break
    if (indent === -1) indent = entry[1].length
    if (entry[1].length > indent) continue
    if (entry[1].length < indent) break
    const key = unquoteYamlScalar(entry[2])
    if (key && !(key in found)) found[key] = unquoteYamlScalar(entry[3])
  }
  return found
}

/**
 * The tools an `allowed-tools` scalar names.
 *
 * The Agent Skills specification (https://agentskills.io/specification, fetched
 * 2026-09-06) writes this field as a SPACE-separated string, and its own
 * example — `Bash(git:*) Bash(jq:*) Read` — is three tools. Splitting on commas
 * alone, which is what this did until 2026-09-06, read that example as one
 * bogus tool name. Commas still separate too, because the YAML flow form
 * (`[Read, Write]`) and the comma-separated form Claude Code's own
 * documentation used are both in the wild and neither is ambiguous.
 *
 * A separator inside parentheses or quotes belongs to the tool's own argument
 * pattern (`Bash(npx impeccable *)`), so those do not split.
 */
function splitToolList(value: string): string[] {
  const inner = value.startsWith('[') && value.endsWith(']') ? value.slice(1, -1) : value
  const tokens: string[] = []
  let current = ''
  let depth = 0
  let quote = ''
  for (const char of inner) {
    if (quote !== '') {
      if (char === quote) quote = ''
    } else if ((char === '"' || char === "'") && depth === 0 && current === '') {
      // A quote only QUOTES at the start of a token: the apostrophe in
      // `Bash(don't:*)` is part of a command, and reading it as an opening quote
      // swallowed the rest of the line into one bogus tool name.
      quote = char
    } else if (char === '(') {
      depth += 1
    } else if (char === ')') {
      depth = Math.max(0, depth - 1)
    } else if (depth === 0 && (char === ',' || /\s/.test(char))) {
      tokens.push(current)
      current = ''
      continue
    }
    current += char
  }
  tokens.push(current)
  return tokens.map((token) => unquoteYamlScalar(token)).filter((token) => token.length > 0)
}

/**
 * One character of a conformant `name`. The specification says "unicode
 * lowercase alphanumeric characters (`a-z`, `0-9`) and hyphens", so the test is
 * alphanumeric-and-already-lowercase rather than ASCII: `café-export` is a name
 * a repository may legitimately ship, `PDF-Processing` is the one the spec's own
 * invalid example rejects, and a script without case (`日本語`) is its own
 * lowercase.
 */
function isSpecNameCharacter(char: string): boolean {
  if (char === '-') return true
  if (!/[\p{L}\p{N}]/u.test(char)) return false
  return char === char.toLowerCase()
}

/** The longest `name` the specification allows. */
const SKILL_NAME_MAX_LENGTH = 64

/**
 * How a skill's declared `name` departs from the Agent Skills specification —
 * '' when it does not.
 *
 * The specification (https://agentskills.io/specification, fetched 2026-09-06)
 * requires 1-64 characters of `a-z`, `0-9` and `-`, no leading, trailing or
 * doubled hyphen, and equality with the parent directory name. This states the
 * departure rather than rejecting the skill: the file is still readable and
 * still installable, and a repository we do not own is not ours to refuse.
 */
export function skillNameWarning(name: string, dirName: string): string {
  // Nothing declared is nothing to warn about — an unread entry keeps its
  // directory name, which is not a claim about the skill's own frontmatter.
  if (name === '') return ''
  if (name.length > SKILL_NAME_MAX_LENGTH) {
    return `Its name is ${name.length} characters; the Agent Skills specification allows ${SKILL_NAME_MAX_LENGTH}.`
  }
  if (![...name].every(isSpecNameCharacter)) {
    return `Its name “${name}” uses characters the Agent Skills specification does not allow — lowercase letters, numbers and hyphens only.`
  }
  if (name.startsWith('-') || name.endsWith('-')) {
    return `Its name “${name}” starts or ends with a hyphen, which the Agent Skills specification does not allow.`
  }
  if (name.includes('--')) {
    return `Its name “${name}” has a doubled hyphen, which the Agent Skills specification does not allow.`
  }
  if (dirName !== '' && name !== dirName) {
    return `Its name “${name}” is not its directory name “${dirName}”, which the Agent Skills specification requires.`
  }
  return ''
}

/** The three bytes a Windows editor writes before the first character. */
function stripByteOrderMark(raw: string): string {
  return raw.charCodeAt(0) === 0xfeff ? raw.slice(1) : raw
}

function unquoteYamlScalar(value: string): string {
  const trimmed = value.trim()
  if (
    trimmed.length >= 2 &&
    ((trimmed.startsWith('"') && trimmed.endsWith('"')) || (trimmed.startsWith("'") && trimmed.endsWith("'")))
  ) {
    return trimmed.slice(1, -1).trim()
  }
  return trimmed
}

/** Directory name a skill installs under — the last segment of its id. */
export function skillDirName(skillId: string): string {
  const segments = skillId.split('/').filter((segment) => segment.length > 0)
  return segments.length > 0 ? segments[segments.length - 1] : ''
}

/** Up to two uppercase letters for the source rail badge. */
export function skillSourceMonogram(name: string): string {
  const words = name.split(/[^A-Za-z0-9]+/).filter((word) => word.length > 0)
  if (words.length === 0) return '?'
  if (words.length === 1) return words[0].slice(0, 2).toUpperCase()
  return `${words[0][0]}${words[1][0]}`.toUpperCase()
}

// ── Update-check cadence (owner ruling 2026-09-08) ──────────────────
//
// Over git the cadence is hourly for everyone (git-transport ruling, owner
// 2026-09-08): a head check is `git ls-remote`, which GitHub's REST limit does
// not count at all, so there is nothing for a token to buy and nothing to
// ration. The rest of this block is the API fallback — the machine with no git
// — where the arithmetic below still holds.
//
// On the API path, how often a repository source is asked for its head depends
// on whether a GitHub token is configured. Anonymous GitHub allows 60 requests
// an hour for the whole machine, shared with every other read the app makes and
// with anything else on the same IP; a source checked hourly spends 24 of those
// a day on a question whose answer changes far less often, and a person with
// several sources can exhaust the budget on update checks alone and then find a
// scan or an install refused. With a token the limit is 5,000 an hour, where
// hourly costs nothing.
//
// The window is enforced per source in `src/main/skills/source-updates.ts`, so
// it holds for every caller — the scheduled check and a manual "Check now"
// alike. The sentences live here because Settings and the Extensions door both
// say them, and neither can import main.

const HOUR_MS = 60 * 60 * 1000

/** With a token: GitHub allows 5,000 requests an hour, so hourly costs nothing. */
export const SOURCE_UPDATE_INTERVAL_WITH_TOKEN_MS = HOUR_MS
/** Without one: 60 an hour for the whole machine, so once a day per source. */
export const SOURCE_UPDATE_INTERVAL_ANONYMOUS_MS = 24 * HOUR_MS

export function sourceUpdateIntervalMs(hasToken: boolean, transport: SkillRepoTransport = 'api'): number {
  // `ls-remote` costs the REST limit nothing, so the token stops deciding.
  if (transport === 'git') return SOURCE_UPDATE_INTERVAL_WITH_TOKEN_MS
  return hasToken ? SOURCE_UPDATE_INTERVAL_WITH_TOKEN_MS : SOURCE_UPDATE_INTERVAL_ANONYMOUS_MS
}

/** "3 hours", "12 minutes", "just now" — the age of a check, said plainly. */
export function describeCheckAge(ageMs: number): string {
  const minutes = Math.floor(ageMs / 60_000)
  if (minutes < 1) return 'just now'
  if (minutes < 60) return `${minutes} minute${minutes === 1 ? '' : 's'} ago`
  const hours = Math.floor(minutes / 60)
  if (hours < 24) return `${hours} hour${hours === 1 ? '' : 's'} ago`
  const days = Math.floor(hours / 24)
  return `${days} day${days === 1 ? '' : 's'} ago`
}

/**
 * Why a source was not checked, for the person who asked for one. It names the
 * token, because configuring one is the thing that changes the answer.
 */
export function sourceUpdateSkipMessage(
  ageMs: number,
  hasToken: boolean,
  transport: SkillRepoTransport = 'api',
): string {
  const age = describeCheckAge(ageMs)
  if (transport === 'git') return `Checked ${age}; the studio checks each source once an hour over git.`
  return hasToken
    ? `Checked ${age}; the studio checks each source once an hour.`
    : `Checked ${age}; without a GitHub token the studio checks each source once a day.`
}

/** The cadence in force, for the line beside the token field in Settings. */
export function sourceUpdateCadenceLine(hasToken: boolean, transport: SkillRepoTransport = 'api'): string {
  if (transport === 'git') {
    return "Plugin sources are checked for updates once an hour, over git. A head check is one git ls-remote, which GitHub's API rate limit does not count, so a GitHub token is not what decides the cadence."
  }
  return hasToken
    ? 'Plugin sources are checked for updates once an hour, because this GitHub token raises the rate limit to 5,000 requests an hour. Without one the studio checks once a day.'
    : 'No GitHub token: plugin sources are checked for updates once a day. Anonymous GitHub allows 60 requests an hour for this whole machine, which an hourly check would spend on one question. With a token the studio checks hourly.'
}
