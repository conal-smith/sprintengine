// Installing a skill: copy the whole skill directory into the harness skill
// directories under the active workspace root, preserving subdirectory shape,
// so `agents/`, `scripts/` and `reference/` land the way the skill expects to
// find them.
//
// Where skills go is unchanged from before sources existed — the harness dirs
// resolved by src/shared/skill-harnesses.ts. What changed is *what* is copied:
// the whole directory, not the entry document alone.
//
// Every copy carries a provenance marker naming the source that wrote it. Sync
// reads it to decide what it may overwrite; without it, two sources shipping a
// directory of the same name are indistinguishable on disk.

import { cp, lstat, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, isAbsolute, join, resolve } from 'node:path'

import { SKILL_HARNESS_DIR } from '../../shared/skill-harnesses'
import {
  SKILL_ENTRY_FILE,
  skillDirName,
  type ScannedSkill,
  type SkillFileRef,
  type SkillHarness,
} from '../../shared/skills'
import { listLocalTree } from './local-source'
import { isPathStrictlyInside } from '../path-containment'
import { skillDirStaysInRoot } from './skill-dir-containment'

/** Reads one file's bytes from whichever source the skill came from. */
type SkillFileReader = (file: SkillFileRef) => Promise<Buffer>

export const DEFAULT_SKILL_INSTALL_MAX_FILES = 1_000
export const DEFAULT_SKILL_INSTALL_MAX_TOTAL_BYTES = 50 * 1024 * 1024

/**
 * The provenance marker, written into each installed copy and never into the
 * source it was read from — so it cannot appear in the file list the skill
 * reader renders.
 *
 * Same filename as the manifest src/main/builtin-skills.ts writes for the
 * skills the app ships, deliberately: one convention for "the studio put this
 * here", not two. The shapes differ and each reader recognises only its own —
 * a bundled skill's manifest names no `sourceId`, so no sync claims it, and a
 * source's marker fails the built-in reader's `source: 'sprintengine-builtin'`
 * check, so the built-in installer treats that directory as local and refuses
 * to overwrite it.
 */
export const SKILL_PROVENANCE_FILE = '.sprintengine-skill.json'

/** Which source an installed copy was taken from, and at which commit. */
export type SkillInstallProvenance = {
  sourceId: string
  skillId: string
  /** '' for sources with no git identity. */
  commitSha: string
}

/** Provenance for a copy that came from a plugin bundle, not from a skill source. */
export const PLUGIN_BUNDLE_SKILL_SOURCE_ID = 'plugin-bundle'

type SkillProvenanceRecord = SkillInstallProvenance & { installedAt: string }

/**
 * What installed the copy in `skillDir`, or null when nothing did — a bundled
 * skill, a hand-made directory, or a copy installed before markers existed.
 * Absent means "not ours", which is the reading that never overwrites someone
 * else's bytes.
 */
export async function readSkillProvenance(skillDir: string): Promise<SkillInstallProvenance | null> {
  const raw = await readFile(join(skillDir, SKILL_PROVENANCE_FILE), 'utf8').catch(() => null)
  if (raw === null) return null
  let parsed: unknown
  try {
    parsed = JSON.parse(raw)
  } catch {
    return null
  }
  if (typeof parsed !== 'object' || parsed === null) return null
  const record = parsed as Partial<SkillProvenanceRecord>
  if (typeof record.sourceId !== 'string' || record.sourceId === '') return null
  return {
    sourceId: record.sourceId,
    skillId: typeof record.skillId === 'string' ? record.skillId : '',
    commitSha: typeof record.commitSha === 'string' ? record.commitSha : '',
  }
}

type SkillInstallTarget = { harness: SkillHarness; path: string }

type SkillInstallPlan = {
  dirName: string
  targets: SkillInstallTarget[]
  files: SkillFileRef[]
}

export type SkillInstallPlanResult = { ok: true; plan: SkillInstallPlan } | { ok: false; message: string }

export type SkillInstallResult =
  | { ok: true; dirName: string; harnesses: SkillHarness[]; paths: string[]; fileCount: number }
  | { ok: false; message: string }

/**
 * Resolve every destination up front and refuse the whole install if any of
 * them escapes its skill directory. Skills are third-party content: a tree
 * entry named `../../.claude/settings.json` is not a file to sanitise and carry
 * on with, it is a source to stop reading.
 */
export function planSkillInstall(
  workspaceRoot: string,
  skill: ScannedSkill,
  harnesses: readonly SkillHarness[],
): SkillInstallPlanResult {
  const root = resolve(workspaceRoot)
  const dirName = skillDirName(skill.id)
  if (dirName.length === 0 || !isSafeSegment(dirName)) {
    return { ok: false, message: `Skill "${skill.id}" does not have a usable directory name.` }
  }
  if (harnesses.length === 0) {
    return { ok: false, message: 'No agent CLI on this machine reads workspace skills.' }
  }
  if (skill.files.length === 0) {
    return { ok: false, message: `Skill "${skill.id}" lists no files to install.` }
  }
  if (skill.files.length > DEFAULT_SKILL_INSTALL_MAX_FILES) {
    return {
      ok: false,
      message: `Skill "${skill.id}" contains more than ${DEFAULT_SKILL_INSTALL_MAX_FILES} files.`,
    }
  }

  const targets: SkillInstallTarget[] = []
  for (const harness of harnesses) {
    const path = resolve(root, SKILL_HARNESS_DIR[harness], 'skills', dirName)
    if (!isPathStrictlyInside(root, path)) {
      return { ok: false, message: `Skill "${skill.id}" resolves outside the workspace.` }
    }
    targets.push({ harness, path })
  }

  for (const file of skill.files) {
    // Checked against the first target only because every target shares the
    // same skill-relative layout; a path that stays inside one stays inside all.
    const escape = resolveSkillFilePath(targets[0].path, file.path)
    if (escape === null) {
      return {
        ok: false,
        message: `Skill "${skill.id}" contains a file path that escapes its own directory: ${file.path}`,
      }
    }
  }

  return { ok: true, plan: { dirName, targets, files: [...skill.files] } }
}

/**
 * The absolute destination for a skill-relative path, or null when it does not
 * stay inside the skill directory. Backslashes are rejected outright rather
 * than normalised: a repository path is POSIX, so a backslash is either a
 * literal filename character (which cannot survive a Windows install anyway) or
 * an attempt to smuggle a separator past a POSIX-shaped check.
 */
export function resolveSkillFilePath(targetDir: string, relativePath: string): string | null {
  if (relativePath.length === 0) return null
  if (relativePath.includes('\\') || relativePath.includes('\0')) return null
  if (isAbsolute(relativePath) || relativePath.startsWith('/')) return null
  const segments = relativePath.split('/')
  if (segments.some((segment) => !isSafeSegment(segment))) return null
  const destination = resolve(targetDir, relativePath)
  return isPathStrictlyInside(targetDir, destination) ? destination : null
}

function isSafeSegment(segment: string): boolean {
  return segment.length > 0 && segment !== '.' && segment !== '..' && !segment.includes('\\')
}

export type InstallSkillOptions = {
  workspaceRoot: string
  skill: ScannedSkill
  harnesses: readonly SkillHarness[]
  readFile: SkillFileReader
  /** Recorded in the installed copy; what a later sync checks before overwriting it. */
  provenance: SkillInstallProvenance
  stagingRoot?: string
  maxTotalBytes?: number
}

/**
 * Stage the whole skill once, then copy the staged directory into each harness
 * target. Staging keeps a failed download from leaving a half-written skill
 * where an agent would read it, and keeps one install to one fetch per file no
 * matter how many harnesses are on this machine.
 */
export async function installSkill(options: InstallSkillOptions): Promise<SkillInstallResult> {
  const planned = planSkillInstall(options.workspaceRoot, options.skill, options.harnesses)
  if (!planned.ok) return planned
  const { plan } = planned
  const maxTotalBytes = options.maxTotalBytes ?? DEFAULT_SKILL_INSTALL_MAX_TOTAL_BYTES

  for (const target of plan.targets) {
    if (!(await skillDirStaysInRoot(options.workspaceRoot, target.path))) {
      return {
        ok: false,
        message: `Skill "${options.skill.id}" was not installed: ${target.path} is reached through a linked folder.`,
      }
    }
    // A folder another source installed is that source's, and is not
    // replaced by this one. (A folder with no marker at all is claimed by an
    // install the person asks for, the way out of a copy from before markers.)
    const standing = await lstat(target.path).catch(() => null)
    if (!standing) continue
    const owner = await readSkillProvenance(target.path)
    if (
      owner &&
      (owner.sourceId !== options.provenance.sourceId ||
        (owner.skillId !== '' && owner.skillId !== options.provenance.skillId))
    ) {
      return {
        ok: false,
        message: `${target.path} was installed from another source, so "${options.skill.id}" was not installed. Remove that folder first.`,
      }
    }
  }

  const stagingRoot = options.stagingRoot ?? join(tmpdir(), 'sprintengine-skill-install')
  let stage: string | null = null
  try {
    await mkdir(stagingRoot, { recursive: true })
    stage = await mkdtemp(join(stagingRoot, `${plan.dirName}-`))

    let total = 0
    for (const file of plan.files) {
      const destination = resolveSkillFilePath(stage, file.path)
      if (destination === null) {
        return {
          ok: false,
          message: `Skill "${options.skill.id}" contains a file path that escapes its own directory: ${file.path}`,
        }
      }
      const bytes = await options.readFile(file)
      total += bytes.byteLength
      if (total > maxTotalBytes) {
        return {
          ok: false,
          message: `Skill "${options.skill.id}" is larger than ${maxTotalBytes} bytes.`,
        }
      }
      await mkdir(dirname(destination), { recursive: true })
      await writeFile(destination, bytes)
    }

    // Written last, so a source shipping a file of this name cannot forge the
    // provenance of its own copy.
    const record: SkillProvenanceRecord = {
      ...options.provenance,
      installedAt: new Date().toISOString(),
    }
    await writeFile(join(stage, SKILL_PROVENANCE_FILE), `${JSON.stringify(record, null, 2)}\n`, 'utf8')

    for (const target of plan.targets) {
      await rm(target.path, { recursive: true, force: true })
      await mkdir(dirname(target.path), { recursive: true })
      await cp(stage, target.path, { recursive: true })
    }

    return {
      ok: true,
      dirName: plan.dirName,
      harnesses: plan.targets.map((target) => target.harness),
      paths: plan.targets.map((target) => target.path),
      fileCount: plan.files.length,
    }
  } catch (error) {
    return { ok: false, message: error instanceof Error ? error.message : String(error) }
  } finally {
    if (stage) await rm(stage, { recursive: true, force: true }).catch(() => undefined)
  }
}

/**
 * Install a skill that is already a directory on this machine — a plugin
 * bundle's skill component. It goes through the same plan/stage/copy path as a
 * repository skill so a bundle cannot reach outside its own directory either;
 * only where the bytes are read from differs.
 */
export async function installSkillDirectory(options: {
  workspaceRoot: string
  sourceDir: string
  dirName: string
  harnesses: readonly SkillHarness[]
  /**
   * Who owns the copy. Omitted means the plugin-bundle marker, which no sync
   * claims. A bundle the app itself ships and refreshes names itself instead,
   * so a later sync can tell an app-shipped copy from someone's own edit
   * (backlog/2026-09-06-sprintengine-studio-ships-as-a-plugin.md).
   */
  provenance?: SkillInstallProvenance
}): Promise<SkillInstallResult> {
  const entries = await listLocalTree(options.sourceDir)
  if (entries.length === 0) {
    return { ok: false, message: `${options.dirName} contains no files to install.` }
  }
  const skill: ScannedSkill = {
    id: options.dirName,
    name: options.dirName,
    description: '',
    group: '',
    files: entries.map((entry) => ({
      path: entry.path,
      size: entry.size ?? 0,
      blobSha: '',
      isEntry: entry.path === SKILL_ENTRY_FILE,
    })),
    allowedTools: [],
    hasExecutables: false,
  }
  return installSkill({
    workspaceRoot: options.workspaceRoot,
    skill,
    harnesses: options.harnesses,
    readFile: (file) => readFile(join(options.sourceDir, ...file.path.split('/'))),
    // A bundle is not a skill source, so no source sync ever owns this copy —
    // unless the caller names one that does.
    provenance: options.provenance ?? {
      sourceId: PLUGIN_BUNDLE_SKILL_SOURCE_ID,
      skillId: options.dirName,
      commitSha: '',
    },
  })
}

export type SkillUninstallResult =
  { ok: true; dirName: string; removedPaths: string[] } | { ok: false; message: string }

/**
 * Take an installed skill back out of a workspace. Removal is by directory
 * name across every harness that could hold a copy, because that is how the
 * install wrote it — and a copy left behind in one harness dir is a skill the
 * user believes they removed and an agent still reads.
 *
 * The whole directory goes, provenance marker included: a marker outliving its
 * skill would claim a source still owns a directory that is no longer there.
 *
 * Removing nothing is not a failure here: `removedPaths` says what went, and
 * each caller decides what an empty sweep means to it. A plugin uninstall wants
 * "already gone" to be success; a user pressing Remove on a row wants to be
 * told the row was stale.
 */
export async function uninstallSkill(options: {
  workspaceRoot: string
  dirName: string
  harnesses: readonly SkillHarness[]
}): Promise<SkillUninstallResult> {
  const root = resolve(options.workspaceRoot)
  const dirName = options.dirName.trim()
  // One path segment, or nothing: a name carrying a separator is refused
  // outright rather than resolved and then found to point outside the
  // workspace, so the refusal is stated instead of looking like a sweep that
  // happened to remove nothing.
  if (dirName.length === 0 || dirName.includes('/') || !isSafeSegment(dirName)) {
    return { ok: false, message: `"${options.dirName}" is not a skill directory name.` }
  }

  const removedPaths: string[] = []
  for (const harness of options.harnesses) {
    const path = resolve(root, SKILL_HARNESS_DIR[harness], 'skills', dirName)
    if (!isPathStrictlyInside(root, path) || !(await skillDirStaysInRoot(root, path))) continue
    try {
      // Not `force`: a harness that never held this skill must not be reported
      // as one this call cleaned up.
      await rm(path, { recursive: true })
      removedPaths.push(path)
    } catch (error) {
      if ((error as NodeJS.ErrnoException)?.code === 'ENOENT') continue
      return { ok: false, message: error instanceof Error ? error.message : String(error) }
    }
  }
  return { ok: true, dirName, removedPaths }
}
