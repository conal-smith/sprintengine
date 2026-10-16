// Part of the IPC contract: workspace skills, skill sources and skill plugins.
// ../electron-api.ts re-exports everything here.

import type {
  ScanResult,
  ScannedPlugin,
  SkillDiscoveryResult,
  SkillHarness,
  SkillRepoHit,
  SkillRepoTransport,
  SkillSearchHit,
  SkillSource,
} from '../skills'
import type { McpServerConfig } from './mcp'

// One entry in the unified workspace skill inventory: built-ins, skills
// installed from a source, and hand-dropped custom skill dirs, deduped by skill
// id across harness dirs. Name/description come from the installed SKILL.md
// frontmatter when present, falling back to BUILTIN_SKILLS metadata, then the
// directory name.
export type WorkspaceSkillSource = 'builtin' | 'custom' | 'plugin'
export type WorkspaceSkillInstallState = 'installed' | 'available' | 'update-available'

export type WorkspaceSkill = {
  id: string
  name: string
  description?: string
  source: WorkspaceSkillSource
  harnesses: SkillHarness[]
  installState: WorkspaceSkillInstallState
  version?: string
  /** The skill source a copy was installed from, by its provenance marker; it is how the skill wears its owner's face. */
  sourceId?: string
  /** That source's GitHub repository (`owner/name`), for a skill listed by another machine, whose sources are not here. */
  sourceRepo?: string
}

export type WorkspaceSkillsListInput = {
  workspaceRoot: string
}

export type WorkspaceSkillsListResult = { ok: true; skills: WorkspaceSkill[] } | { ok: false; message: string }

// Attaching a skill to the agents that can use it, and removing it again.
// src/main/agent-skill-installer.ts owns the behaviour; these are the IPC
// envelopes.

/**
 * What happened at one harness directory. Attach reaches several at once, so
 * three successes and one permission error must render as three successes and
 * one error — never as a bare "failed", and never as a success that quietly
 * wrote nothing.
 */
export type AgentSkillTargetStatus = 'written' | 'unchanged' | 'removed' | 'skipped' | 'failed'

/**
 * `not-ours` is a skill the user wrote by hand under that name: reported, never
 * overwritten or deleted. `absent` is a remove target that held nothing.
 */
export type AgentSkillSkipReason = 'not-ours' | 'absent'

export type AgentSkillTarget = {
  harnessId: string
  /** Every installed CLI that reads this directory — `.claude` serves three. */
  pluginIds: string[]
  /** Workspace-relative, e.g. `.claude/skills/backlog`. */
  path: string
  /** Whether the CLIs reading it pick the change up only after a restart. */
  restartRequired: boolean
  status: AgentSkillTargetStatus
  reason?: AgentSkillSkipReason
  /** Present on `failed`, naming what the filesystem said. */
  message?: string
}

export type AgentSkillWriteInput = {
  workspaceRoot: string
  skillId: string
}

/**
 * `ok: false` is reserved for a request that could not be attempted at all — no
 * workspace, an unusable skill id, no installed CLI that reads skills, or
 * nothing to copy. Anything that reached the directories reports per target.
 */
export type AgentSkillWriteResult =
  { ok: true; skillId: string; targets: AgentSkillTarget[] } | { ok: false; message: string }

// Skill sources (src/shared/skills.ts owns the shapes; these are the IPC
// envelopes). Sources are app-level; installing is workspace-level, so
// skillsInstall is the only call here that needs a workspace root.
export type SkillSourcesResult =
  | {
      ok: true
      sources: SkillSource[]
      /**
       * How this build reads repositories: 'git' when a git reader is wired,
       * 'api' on the GitHub-REST fallback (git-transport ruling, owner
       * 2026-09-08). The copy about cadences and unread plugins changes with
       * it, so it travels with the list rather than being guessed at.
       */
      transport: SkillRepoTransport
      /**
       * False only when this machine has no git at all, which is the one thing
       * an 'api' reader's shortfall can actually name as the remedy. Absent
       * means yes.
       */
      gitInstalled?: boolean
    }
  | { ok: false; message: string }

export type SkillAddSourceInput = {
  /** `owner/name`, a repository URL on github.com or a self-hosted GitHub, or a /tree/<ref> deep link. */
  repo: string
  /** Re-scan a source already in the list instead of refusing it. */
  replace?: boolean
}

export type SkillAddSourceResult =
  | {
      ok: true
      source: SkillSource
      scan: ScanResult
      /**
       * The pasted repository IS one of the always-present sources
       * (`anthropics/claude-plugins-official`, `sprintengine/studio-releases`),
       * so it was merged into that tab rather than added beside it. The add
       * succeeded — the tab's listing is freshly read — but nothing new
       * appeared in the list, and a surface that said "added" would be lying
       * about the one thing the person is looking for.
       */
      mergedIntoBuiltin?: boolean
    }
  | { ok: false; message: string }

/**
 * A folder on this machine, added as a source. Separate from
 * `skillsAddSource` because the two take different identities — a repository
 * reference and an absolute path — and a single field taking either would be
 * a string the caller has to hope is parsed the way it meant.
 */
export type SkillAddLocalSourceInput = {
  /** Absolute path to the folder to scan. */
  path: string
  /** Re-scan a folder already in the list instead of refusing it. */
  replace?: boolean
}

export type SkillRemoveSourceInput = { sourceId: string }

export type SkillRemoveSourceResult = { ok: true; sourceId: string } | { ok: false; message: string }

export type SkillScanInput = { sourceId: string }

export type SkillScanOutcome = { ok: true; source: SkillSource; scan: ScanResult } | { ok: false; message: string }

export type SkillReadFileInput = { sourceId: string; skillId: string; path: string }

export type SkillReadFileResult = { ok: true; path: string; content: string } | { ok: false; message: string }

export type SkillInstallInput = { sourceId: string; skillId: string; workspaceRoot: string }

export type SkillInstallOutcome =
  | { ok: true; dirName: string; harnesses: SkillHarness[]; paths: string[]; fileCount: number }
  | { ok: false; message: string }

/**
 * Uninstalling is by directory name, not by source: a skill installed from a
 * source that has since been removed is still a directory in the workspace, and
 * the user must still be able to take it back out.
 */
export type SkillUninstallInput = { workspaceRoot: string; dirName: string }

export type SkillUninstallOutcome =
  { ok: true; dirName: string; removedPaths: string[] } | { ok: false; message: string }

/** The workspace whose installed copies get re-copied; null with no workspace open. */
export type SkillSyncSourceInput = {
  sourceId: string
  workspaceRoot: string | null
  /**
   * The MCP servers this machine has configured. Sent in because MCP settings
   * live in the renderer's store, not on disk in main: the sync rewrites the
   * ones this source installed and hands them back for the surface to apply
   * (backlog/2026-09-06-mcp-installs-carry-source-provenance.md). Omitted by a
   * caller that has none, which refreshes skills and nothing else.
   */
  mcpServers?: McpServerConfig[]
}

export type SkillSyncFailure = { skillId: string; message: string }

/**
 * What a sync did, in counts. What changed *inside* a skill is not derivable
 * here and is not guessed at: the repository's own commit history answers that,
 * which is why the surface links to it instead of rendering a diff.
 */
export type SkillSyncSourceOutcome =
  | {
      ok: true
      source: SkillSource
      scan: ScanResult
      /** Skills the refreshed scan holds that the cached one did not. */
      added: number
      /** Skills the cached scan held that the repository no longer does. */
      removed: number
      /** Installed skills re-copied from the refreshed scan. */
      refreshed: number
      /** Installed skills whose re-copy failed; the list still refreshed. */
      failures: SkillSyncFailure[]
      /**
       * The source-installed MCP servers as they now stand: `updated` is what
       * to write back, `changed` the ones whose declaration really moved, and
       * `missing` the ones this source no longer declares (their entries stay,
       * marked, and go on working).
       */
      mcpServers: { updated: McpServerConfig[]; changed: string[]; missing: string[] }
    }
  | { ok: false; message: string }

/**
 * Discover. Both calls answer with `{ results, rateLimit, degraded }` and no
 * ok flag: a failed or limited query is a stated condition on the same shape,
 * so a caller can never mistake it for "GitHub had no match".
 */
export type SkillSearchInput = { query: string }

export type SkillSearchOutcome = SkillDiscoveryResult<SkillSearchHit>

export type SkillPopularReposOutcome = SkillDiscoveryResult<SkillRepoHit>

// Plugins from sources (backlog/2026-09-05-plugin-sources.md). A source's
// plugins ride in its scan; these are the calls that read a linked plugin,
// install one into a workspace, take it out again, and list what is in.

export type SkillPluginScanLinkedInput = { sourceId: string; pluginId: string }

export type SkillPluginScanLinkedOutcome =
  { ok: true; source: SkillSource; scan: ScanResult; plugin: ScannedPlugin } | { ok: false; message: string }

export type SkillPluginInstallInput = {
  sourceId: string
  pluginId: string
  workspaceRoot: string
  /** Required true when the plugin declares hooks — they run shell commands. */
  acknowledgedHooks?: boolean
  /**
   * Install only these skills. Omit both this and `mcpServerIds` to install
   * everything the plugin ships (the palette's single-skill shortcut). Passing
   * either field means the other kind is not installed — a plugin is a
   * catalogue, and one press takes one item.
   */
  skillIds?: string[]
  /** Install only these MCP servers. Same rule as `skillIds`. */
  mcpServerIds?: string[]
}

export type SkillPluginInstallHarness = {
  harness: SkillHarness
  /** `skills` — skill directories copied; `nothing` — the plugin has nothing this harness reads. */
  mode: 'skills' | 'nothing'
  skillDirNames: string[]
  message: string
}

export type SkillPluginInstallOutcome =
  | {
      ok: true
      plugin: ScannedPlugin
      harnesses: SkillPluginInstallHarness[]
      /** MCP servers the plugin declares, shaped for the MCP settings store. */
      mcpServers: McpServerConfig[]
      /**
       * `name@marketplace` written into the workspace's Claude settings, '' when
       * none was. An extra for `claude plugin install`, never what delivered the
       * plugin — see src/main/skills/install-plugin.ts.
       */
      claudePluginKey: string
      /** Where the plugin's own files landed, '' when it needed none. */
      pluginRoot: string
      /** Files copied there; 0 when nothing was. */
      pluginFileCount: number
      warnings: string[]
    }
  | { ok: false; message: string; needsHookAcknowledgement?: boolean }

export type SkillPluginUninstallInput = {
  sourceId: string
  pluginId: string
  workspaceRoot: string
  /**
   * Drop only this MCP server from the plugin's receipt. Skills stay. Omit it
   * to take the whole plugin back — every copied skill, every server it added,
   * and the plugin's own files.
   */
  mcpServerId?: string
}

export type SkillPluginUninstallOutcome =
  | {
      ok: true
      removedPaths: string[]
      disabledClaudePluginKey: string
      mcpServerIds: string[]
      /** The copies went; the Claude settings file refused its edit. */
      warnings: string[]
    }
  | { ok: false; message: string }

/** One installed plugin, as this app recorded it. */
export type InstalledPluginRecord = {
  workspaceRoot: string
  sourceId: string
  pluginId: string
  pluginName: string
  marketplaceName: string
  claudePluginKey: string
  skillDirNames: string[]
  /**
   * The plugin's own directory under `claude-plugins` in the workspace's store, when its MCP
   * server runs out of one. Absent on a receipt from before plugin directories
   * existed, and on every plugin that needs none.
   */
  pluginDirName?: string
  mcpServerIds: string[]
  /** The commit the bytes were read at; '' for a registry plugin. */
  commitSha: string
  installedAt: string
}

export type SkillInstalledPluginsInput = { workspaceRoot: string }

export type SkillInstalledPluginsOutcome =
  { ok: true; plugins: InstalledPluginRecord[] } | { ok: false; message: string }

/** One repository source, as the hourly update check saw it. */
export type SkillSourceUpdateEntry = {
  sourceId: string
  /** `owner/name`. */
  name: string
  headSha: string
  /** The head differs from the commit the source was scanned at. */
  changed: boolean
  /**
   * False when this check did not ask GitHub, because the source was checked
   * inside its cadence window. `headSha` and `changed` then repeat
   * what the last real check recorded, so the rails keep their mark.
   */
  checked: boolean
}

/**
 * What an update check found. `newlyChanged` is the drift THIS check
 * discovered (worth a toast); `changed` is every source currently behind its
 * head (what the rails mark). Broadcast on `skills:sources-updated`.
 *
 * `skipped` names the sources this check left alone because their cadence
 * window had not elapsed, each with the sentence to show a person who pressed
 * Check now — a manual check counts against the same window as the scheduled
 * one, and has to say so rather than look like it did nothing.
 */
export type SkillSourceUpdateCheck = {
  checkedAt: string
  sources: SkillSourceUpdateEntry[]
  changed: string[]
  newlyChanged: string[]
  failures: { sourceId: string; message: string }[]
  skipped: { sourceId: string; message: string }[]
}
