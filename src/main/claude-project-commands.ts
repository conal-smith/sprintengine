import { createHash } from 'node:crypto'
import { lstat, mkdir, mkdtemp, readFile, readdir, realpath, rm, stat, writeFile } from 'node:fs/promises'
import { isAbsolute, join, relative, sep } from 'node:path'

/**
 * A project's own slash commands (`.claude/commands/**\/*.md`), for its Claude
 * chats. A chat loads the person's settings only, never the project's
 * (claude-agent-provider.ts says why), and Claude Code lists a project's
 * command files only with the project's settings. A local plugin's
 * `commands/` folder is read under the user source alone, so the files are
 * copied into one, staged outside the project, and handed to the chat's child
 * and to the command probe. Claude Code names a plugin's commands after the
 * plugin, so `deploy.md` is `/project:deploy` and `frontend/component.md` is
 * `/project:frontend:component`.
 *
 * Only the command files travel, never the settings, hooks, agents or MCP
 * servers beside them. Inside a command, the frontmatter keys that would
 * answer a permission are dropped too (see `FRONTMATTER_KEYS`), so what a
 * command does is asked about as anything else the chat does.
 */
export const PROJECT_COMMANDS_PLUGIN = 'project'

/**
 * Staged plugin folders are named for the process that made them, so a sweep
 * can tell one a running app still uses from one a dead process left behind
 * (sweepStaleSkillPlugins). Attached skills and project commands share it.
 */
export const STAGED_PLUGIN_PREFIX = 'sprintengine-claude-skills-'

/**
 * How much of a project is copied. A commands folder is a handful of short
 * files; these stop a folder that is something else (a vendored tree, a
 * generated dump) from being walked or copied in full before every turn.
 */
export const PROJECT_COMMAND_LIMITS = {
  /** Commands copied, in name order; the rest are left out. */
  files: 200,
  /** A file larger than this is left out. */
  fileBytes: 64 * 1024,
  /** Bytes copied in all; files past it are left out. */
  totalBytes: 1024 * 1024,
  /** Folder entries looked at, files and folders together. */
  entries: 2000,
  /** Subfolders below `commands/`, each one a namespace segment. */
  depth: 4,
}

export type ProjectCommandFile = {
  /** The path below `commands/`, one segment per folder, the file last. */
  segments: string[]
  text: string
}

// A segment Claude Code turns into a name the composer can insert: no space,
// no separator, nothing hidden.
const SEGMENT = /^[\w-][\w.-]*$/

/**
 * The project's command files, read from `<workspaceRoot>/.claude/commands`.
 * A link is followed only when it lands inside the project, so a command never
 * carries a file from elsewhere on this machine into a prompt; a linked folder
 * is walked once. Nothing is written to the project. An empty list when the
 * folder is missing or unreadable.
 */
export async function readProjectCommands(
  workspaceRoot: string,
  limits = PROJECT_COMMAND_LIMITS,
): Promise<ProjectCommandFile[]> {
  const root = await realpath(workspaceRoot).catch(() => null)
  if (!root) return []
  const commandsDir = await realpath(join(root, '.claude', 'commands')).catch(() => null)
  if (!commandsDir || !inside(root, commandsDir)) return []
  const found: Array<{ segments: string[]; path: string; size: number }> = []
  const visited = new Set<string>([commandsDir])
  let entries = 0
  const walk = async (dir: string, prefix: string[]): Promise<void> => {
    const names = await readdir(dir).catch(() => [] as string[])
    for (const name of names.sort()) {
      if (++entries > limits.entries) return
      const isMarkdown = name.endsWith('.md')
      const segment = isMarkdown ? name.slice(0, -3) : name
      if (!SEGMENT.test(segment)) continue
      const path = join(dir, name)
      const link = await lstat(path).catch(() => null)
      if (!link) continue
      const target = link.isSymbolicLink() ? await realpath(path).catch(() => null) : path
      if (!target || !inside(root, target)) continue
      const info = link.isSymbolicLink() ? await stat(target).catch(() => null) : link
      if (!info) continue
      if (info.isDirectory()) {
        if (prefix.length >= limits.depth || visited.has(target)) continue
        visited.add(target)
        await walk(target, [...prefix, name])
      } else if (info.isFile() && isMarkdown && info.size <= limits.fileBytes) {
        found.push({ segments: [...prefix, segment], path: target, size: info.size })
      }
    }
  }
  await walk(commandsDir, [])
  const files: ProjectCommandFile[] = []
  let total = 0
  for (const entry of found) {
    if (files.length >= limits.files) break
    if (total + entry.size > limits.totalBytes) continue
    const text = await readFile(entry.path, 'utf8').catch(() => null)
    if (text === null || Buffer.byteLength(text) > limits.fileBytes) continue
    total += Buffer.byteLength(text)
    files.push({ segments: entry.segments, text: withoutPermissionKeys(text) })
  }
  return files
}

function inside(root: string, path: string): boolean {
  const suffix = relative(root, path)
  return suffix === '' || (!suffix.startsWith(`..${sep}`) && suffix !== '..' && !isAbsolute(suffix))
}

/**
 * The frontmatter keys a copied command keeps: the ones that describe it and
 * choose how it runs. `allowed-tools` is the one that matters by its absence:
 * Claude Code approves the tools it names while the command runs, its `!`
 * lines included, without asking the app — the same allow rules a project's
 * settings carry and that a chat never loads. Without it a `!` line runs only
 * when Claude Code's own checks pass it as read-only (`git status` does, a
 * redirect or a `git commit` does not), and every tool call the command leads
 * to is asked about under the chat's mode. A key not listed here (`hooks`,
 * anything added later) is dropped as well.
 */
const FRONTMATTER_KEYS = new Set([
  'description',
  'argument-hint',
  'model',
  'effort',
  'disable-model-invocation',
  'when_to_use',
])

/** A command file's text with only `FRONTMATTER_KEYS` left in its frontmatter. */
export function withoutPermissionKeys(text: string): string {
  const open = /^---[ \t]*\r?\n/.exec(text)
  if (!open) return text
  const rest = text.slice(open[0].length)
  const close = /^---[ \t]*(?:\r?\n|$)/m.exec(rest)
  if (!close) return text
  const kept: string[] = []
  let keep = false
  for (const line of rest
    .slice(0, close.index)
    .replace(/\r?\n$/, '')
    .split(/\r?\n/)) {
    // An indented line, a list item or a blank one goes with the key above it.
    if (!line.trim() || /^\s/.test(line) || line.startsWith('-')) {
      if (keep) kept.push(line)
      continue
    }
    const key = /^([^#:]+?)\s*:/.exec(line)?.[1]
    keep = key !== undefined && FRONTMATTER_KEYS.has(key)
    if (keep) kept.push(line)
  }
  return `${open[0]}${kept.length ? `${kept.join('\n')}\n` : ''}${rest.slice(close.index)}`
}

/** One string per set of files, equal when the same commands would be staged. */
export function projectCommandsFingerprint(files: readonly ProjectCommandFile[]): string {
  const hash = createHash('sha256')
  for (const file of files) hash.update(`${file.segments.join('/')}\u0000${file.text}\u0000`)
  return hash.digest('hex')
}

/**
 * Write `files` as the plugin at `dir`: its manifest, and `commands/` holding
 * exactly these files (what was there before goes).
 */
export async function writeProjectCommandsPlugin(dir: string, files: readonly ProjectCommandFile[]): Promise<void> {
  await mkdir(join(dir, '.claude-plugin'), { recursive: true })
  await writeFile(
    join(dir, '.claude-plugin', 'plugin.json'),
    JSON.stringify({
      name: PROJECT_COMMANDS_PLUGIN,
      description: 'The slash commands in this project’s .claude/commands.',
    }),
  )
  const commands = join(dir, 'commands')
  await rm(commands, { recursive: true, force: true })
  await mkdir(commands)
  for (const file of files) {
    const folders = file.segments.slice(0, -1)
    if (folders.length) await mkdir(join(commands, ...folders), { recursive: true })
    await writeFile(join(commands, ...folders, `${file.segments.at(-1)}.md`), file.text)
  }
}

export type StagedProjectCommands = { dir: string; fingerprint: string }

/**
 * The project's commands staged as a plugin in a folder of its own under
 * `tempDir`, or null when the project has none. The caller removes `dir`.
 */
export async function stageProjectCommands(
  tempDir: string,
  workspaceRoot: string,
): Promise<StagedProjectCommands | null> {
  const files = await readProjectCommands(workspaceRoot)
  if (!files.length) return null
  const dir = await mkdtemp(join(tempDir, `${STAGED_PLUGIN_PREFIX}${process.pid}-`))
  try {
    await writeProjectCommandsPlugin(dir, files)
    return { dir, fingerprint: projectCommandsFingerprint(files) }
  } catch (error) {
    await rm(dir, { recursive: true, force: true }).catch(() => undefined)
    throw error
  }
}
