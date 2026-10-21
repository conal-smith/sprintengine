// A plugin's OWN files, in the workspace, so the server it declares can start
// (backlog/2026-09-06-a-plugins-own-files-must-land-before-its-server-can-start.md).
//
// The app already does exactly this for its own plugin: `studio-plugin.ts`
// materialises the bundled tree into `<workspace>/.sprintengine/studio-plugin` and
// substitutes the tokens, so the command it writes points at real files. A
// plugin from a source needs the same treatment, and this is it — the copy;
// `src/shared/mcp/plugin-root.ts` is the substitution.
//
// Three decisions, recorded because the item asked for them:
//
// **What is copied: the whole plugin directory.** Not "what the command needs",
// because that is not knowable. Telegram's command is
// `bun run --cwd ${CLAUDE_PLUGIN_ROOT} --shell=bun --silent start`, and `start`
// is a package.json script — `bun install --no-summary && bun server.ts`. Which
// files that touches is the publisher's business and changes between commits;
// the plugin root is the unit the declaration names, so the plugin root is what
// lands. It is small in practice: telegram is 11 files and 89 KB at
// 85cce0381e7860082641b59d961a2b8c368b8b79.
//
// **Where it lands: `claude-plugins/<plugin id>` in the workspace's store**
// (`~/.sprintengine/workspaces/<slug>-<hash>/`, `workspace-store.ts`): per
// workspace because installs are, writable because `bun install` writes
// `node_modules` into it, and outside the repository, which keeps nothing of
// the app's that a person would have to ignore (owner ruling 2026-10-16). It
// used to be `<workspace>/.sprintengine/claude-plugins/<plugin id>`; a plugin
// installed there stays there, because the MCP settings name its folder
// (`sourceRef.pluginRoot`), and is still found by the uninstall.
//
// **What happens when the runtime is missing.** Nothing here: the copy is the
// same either way. `installPlugin` probes the command and says so on the row,
// because a server that says "bun is not installed" is worth more than one that
// looks installed and dies at launch. See its `runtimeWarnings`.
//
// The caps are the skill installer's own constants, not new numbers: a plugin
// directory is third-party bytes arriving over the same wire as a skill, and it
// gets the same 1,000 files and 50 MB. Every destination goes through
// `resolveSkillFilePath`, so a tree entry named `../../.claude/settings.json`
// stops the install rather than being sanitised and carried on with.

import { access, cp, mkdir, mkdtemp, readFile, rename, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'

import { DEFAULT_SKILL_INSTALL_MAX_FILES, DEFAULT_SKILL_INSTALL_MAX_TOTAL_BYTES, resolveSkillFilePath } from './install'
import { isPathStrictlyInside } from '../path-containment'
import { workspaceStorePath } from '../workspace-store'

/** Where a source's plugins land inside a workspace's store. */
export const PLUGIN_STORE_DIR = 'claude-plugins'

/** Where an earlier build put them, inside the workspace itself. */
export const LEGACY_PLUGIN_WORKSPACE_DIR = join('.sprintengine', 'claude-plugins')

/**
 * The provenance marker, written last into each copied plugin directory so a
 * plugin shipping a file of this name cannot forge its own provenance.
 *
 * Its own name rather than the skill installer's `.sprintengine-skill.json`: a
 * plugin directory is not a skill directory, no skill sync may claim it, and
 * one reader recognising both shapes is how a marker ends up meaning the wrong
 * thing. It is also the guard on the destination — a directory carrying no
 * marker of ours is somebody else's and is never written over.
 */
export const PLUGIN_PROVENANCE_FILE = '.sprintengine-plugin.json'

/** One file of a plugin's own directory, relative to that directory. */
export type PluginDirectoryFile = { path: string; size: number }

/** Which source a copied plugin directory came from, and at which commit. */
export type PluginDirectoryProvenance = {
  sourceId: string
  pluginId: string
  /** '' for a source with no git identity. */
  commitSha: string
}

type ProvenanceRecord = PluginDirectoryProvenance & { installedAt: string }

/**
 * The single path segment a plugin's directory takes, or '' when the id cannot
 * make one. Plugin ids come from third-party manifests, so the last segment is
 * taken (as the skill installer does with skill ids) and then checked, never
 * repaired.
 */
export function pluginDirectoryName(pluginId: string): string {
  const segments = pluginId.split('/').filter((segment) => segment.length > 0)
  const name = segments.length > 0 ? segments[segments.length - 1] : ''
  if (name === '' || name === '.' || name === '..' || name.includes('\\') || name.includes('\0')) return ''
  return name
}

/** Where this plugin's files live for this workspace, or '' when the id has no usable name. */
export function pluginDirectoryPath(workspaceRoot: string, pluginId: string): string {
  const name = pluginDirectoryName(pluginId)
  if (name === '') return ''
  const root = workspaceStorePath(workspaceRoot, PLUGIN_STORE_DIR)
  const path = resolve(root, name)
  return isPathStrictlyInside(root, path) ? path : ''
}

/** Where an earlier build installed it, inside the workspace. */
function legacyPluginDirectoryPath(workspaceRoot: string, pluginId: string): string {
  const name = pluginDirectoryName(pluginId)
  if (name === '') return ''
  const root = resolve(workspaceRoot)
  const path = resolve(root, LEGACY_PLUGIN_WORKSPACE_DIR, name)
  return isPathStrictlyInside(root, path) ? path : ''
}

/** What put this directory here, or null when nothing this app wrote did. */
export async function readPluginDirectoryProvenance(root: string): Promise<PluginDirectoryProvenance | null> {
  const raw = await readFile(join(root, PLUGIN_PROVENANCE_FILE), 'utf8').catch(() => null)
  if (raw === null) return null
  let parsed: unknown
  try {
    parsed = JSON.parse(raw)
  } catch {
    return null
  }
  if (typeof parsed !== 'object' || parsed === null) return null
  const record = parsed as Partial<ProvenanceRecord>
  if (typeof record.sourceId !== 'string' || record.sourceId === '') return null
  if (typeof record.pluginId !== 'string' || record.pluginId === '') return null
  return {
    sourceId: record.sourceId,
    pluginId: record.pluginId,
    commitSha: typeof record.commitSha === 'string' ? record.commitSha : '',
  }
}

export type PluginDirectoryInstallOptions = {
  workspaceRoot: string
  pluginId: string
  files: readonly PluginDirectoryFile[]
  readFile: (file: PluginDirectoryFile) => Promise<Buffer>
  provenance: PluginDirectoryProvenance
  stagingRoot?: string
  maxFiles?: number
  maxTotalBytes?: number
}

export type PluginDirectoryInstallResult =
  { ok: true; dirName: string; root: string; fileCount: number } | { ok: false; message: string }

/**
 * Stage the whole directory, then swap it into place.
 *
 * Staged for the same reason a skill is: a download that fails halfway must not
 * leave a plugin root an agent would launch a server out of. Swapped by rename
 * so the directory is never half-written, which is what
 * `materialiseStudioPlugin` does with the app's own plugin.
 */
export async function installPluginDirectory(
  options: PluginDirectoryInstallOptions,
): Promise<PluginDirectoryInstallResult> {
  const dirName = pluginDirectoryName(options.pluginId)
  if (dirName === '') {
    return { ok: false, message: `Plugin "${options.pluginId}" does not have a usable directory name.` }
  }
  const destination = pluginDirectoryPath(options.workspaceRoot, options.pluginId)
  if (destination === '') {
    return { ok: false, message: `Plugin "${options.pluginId}" resolves outside the workspace's store.` }
  }
  if (options.files.length === 0) {
    return { ok: false, message: `Plugin "${options.pluginId}" lists no files to install.` }
  }
  const maxFiles = options.maxFiles ?? DEFAULT_SKILL_INSTALL_MAX_FILES
  if (options.files.length > maxFiles) {
    return { ok: false, message: `Plugin "${options.pluginId}" contains more than ${maxFiles} files.` }
  }
  for (const file of options.files) {
    if (resolveSkillFilePath(destination, file.path) === null) {
      return {
        ok: false,
        message: `Plugin "${options.pluginId}" contains a file path that escapes its own directory: ${file.path}`,
      }
    }
  }
  // Whatever is already there decides whether this may proceed. A copy of this
  // same plugin from this same source is an update and is replaced; anything
  // else — another source's plugin of the same name, or a directory a person
  // made — is left standing and the install says so, because overwriting it
  // would be this app deleting files it did not write.
  const standing = await readPluginDirectoryProvenance(destination)
  if (
    standing &&
    (standing.sourceId !== options.provenance.sourceId || standing.pluginId !== options.provenance.pluginId)
  ) {
    return {
      ok: false,
      message: `${destination} already holds ${standing.pluginId} from another source, so ${options.pluginId} was not installed. Remove that plugin first.`,
    }
  }
  if (!standing && (await exists(destination))) {
    return {
      ok: false,
      message: `${destination} already exists and was not written by SprintEngine, so ${options.pluginId} was not installed.`,
    }
  }

  const maxTotalBytes = options.maxTotalBytes ?? DEFAULT_SKILL_INSTALL_MAX_TOTAL_BYTES
  const stagingRoot = options.stagingRoot ?? join(tmpdir(), 'sprintengine-plugin-install')
  let stage: string | null = null
  try {
    await mkdir(stagingRoot, { recursive: true })
    stage = await mkdtemp(join(stagingRoot, `${dirName}-`))
    let total = 0
    for (const file of options.files) {
      const target = resolveSkillFilePath(stage, file.path)
      if (target === null) {
        return {
          ok: false,
          message: `Plugin "${options.pluginId}" contains a file path that escapes its own directory: ${file.path}`,
        }
      }
      const bytes = await options.readFile(file)
      total += bytes.byteLength
      if (total > maxTotalBytes) {
        return { ok: false, message: `Plugin "${options.pluginId}" is larger than ${maxTotalBytes} bytes.` }
      }
      await mkdir(dirname(target), { recursive: true })
      await writeFile(target, bytes)
    }
    const record: ProvenanceRecord = { ...options.provenance, installedAt: new Date().toISOString() }
    await writeFile(join(stage, PLUGIN_PROVENANCE_FILE), `${JSON.stringify(record, null, 2)}\n`, 'utf8')

    // Copied into a sibling and renamed rather than renamed from the staging
    // directory: staging is in the OS temp dir, which is routinely a different
    // filesystem, and `rename` across devices fails.
    const swap = `${destination}.${process.pid}.tmp`
    await rm(swap, { recursive: true, force: true })
    await mkdir(dirname(destination), { recursive: true })
    await cp(stage, swap, { recursive: true })
    await rm(destination, { recursive: true, force: true })
    await rename(swap, destination)
    return { ok: true, dirName, root: destination, fileCount: options.files.length }
  } catch (error) {
    await rm(`${destination}.${process.pid}.tmp`, { recursive: true, force: true }).catch(() => undefined)
    return { ok: false, message: error instanceof Error ? error.message : String(error) }
  } finally {
    if (stage) await rm(stage, { recursive: true, force: true }).catch(() => undefined)
  }
}

export type PluginDirectoryUninstallResult =
  { ok: true; removedPaths: string[]; warnings: string[] } | { ok: false; message: string }

/**
 * Take a plugin's copied directory back out, by the name the install receipt
 * recorded.
 *
 * A directory whose marker names a different plugin is left alone and reported:
 * the receipt is this app's memory and the marker is the disk's, and when they
 * disagree the disk wins. A directory with no marker at all is removed — that
 * is a copy somebody edited the marker out of, still in the place this receipt
 * put it, and leaving it behind is a plugin the person believes they removed
 * and whose server still starts.
 */
export async function uninstallPluginDirectory(options: {
  workspaceRoot: string
  pluginId: string
}): Promise<PluginDirectoryUninstallResult> {
  const stored = pluginDirectoryPath(options.workspaceRoot, options.pluginId)
  if (stored === '') {
    return { ok: false, message: `"${options.pluginId}" is not a plugin directory name.` }
  }
  const legacy = legacyPluginDirectoryPath(options.workspaceRoot, options.pluginId)
  const destination = !(await exists(stored)) && legacy !== '' && (await exists(legacy)) ? legacy : stored
  const standing = await readPluginDirectoryProvenance(destination)
  if (standing && standing.pluginId !== options.pluginId) {
    return {
      ok: true,
      removedPaths: [],
      warnings: [`${destination} now holds ${standing.pluginId}, so it was left alone.`],
    }
  }
  try {
    await rm(destination, { recursive: true })
    return { ok: true, removedPaths: [destination], warnings: [] }
  } catch (error) {
    if ((error as NodeJS.ErrnoException)?.code === 'ENOENT') return { ok: true, removedPaths: [], warnings: [] }
    return { ok: false, message: error instanceof Error ? error.message : String(error) }
  }
}

async function exists(path: string): Promise<boolean> {
  return access(path).then(
    () => true,
    () => false,
  )
}
