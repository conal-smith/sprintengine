import { AsyncLocalStorage } from 'node:async_hooks'
import { execFile } from 'child_process'
import type { GitCommandResult } from './git'
import { withGitExecutable } from './git-executable'
import { killProcessTree } from './process-tree-kill'
import type { ExecutionHost } from './hosts/execution-host'
import { isWslDriveMountPath, toWslPath } from '../shared/host-paths'

/**
 * The one place a git process is started for the app's own reads and writes.
 *
 * What a git invocation does decides how long it may run and whether it may
 * take git's optional locks:
 *
 * - `read` answers a question and changes nothing. It gets a short deadline,
 *   because every read here feeds a view, and a view waiting on a git that is
 *   stuck behind a spun-down volume or a network mount is better told "failed"
 *   than left spinning. It also runs with `GIT_OPTIONAL_LOCKS=0`: `git status`
 *   otherwise refreshes the index's stat cache and takes `index.lock` to do it,
 *   and a poll holding that lock for a moment is exactly what makes an agent's
 *   own `git commit` fail with "index.lock exists". Without the lock `git status`
 *   never rewrites `.git/index`. `git diff` against the working tree still
 *   does, lock or not, when a file's stat data moved without its content, so
 *   the reads that poll compare with `git diff-index`, which never writes it
 *   (git-branch-span.ts, `diffFlags`). The gitdir watcher that drives the
 *   views (git-repo-watch.ts) is then never woken by our own polling.
 * - `network` talks to a remote and changes only remote-tracking refs. It gets
 *   a long deadline: a fetch over a slow link is legitimate, a fetch that has
 *   sat stalled for two minutes is not.
 * - `write` changes the repository and gets NO deadline. A commit, merge,
 *   rebase, checkout, push or `worktree add` runs the repository's hooks, which
 *   can run a test suite for minutes, and killing a write part-way leaves an
 *   `index.lock` behind that blocks every later write until someone deletes it
 *   by hand. Waiting is the lesser harm.
 *
 * An unrecognised subcommand is a write: the safe default is the one that
 * never kills.
 */
export type GitCommandKind = 'read' | 'network' | 'write'

export const GIT_READ_TIMEOUT_MS = 15_000
export const GIT_NETWORK_TIMEOUT_MS = 120_000

const READ_SUBCOMMANDS = new Set([
  'blame',
  'cat-file',
  'check-attr',
  'check-ignore',
  'check-ref-format',
  'cherry',
  'describe',
  'diff',
  'diff-files',
  'diff-index',
  'diff-tree',
  'for-each-ref',
  'grep',
  'log',
  'ls-files',
  'ls-tree',
  'merge-base',
  // `--write-tree` stores the merged tree's objects and nothing else: no ref,
  // no index, no working tree moves, so it is a read for every purpose here.
  'merge-tree',
  'name-rev',
  'rev-list',
  'rev-parse',
  'shortlog',
  'show',
  'show-ref',
  'status',
  'var',
  'version',
])

const NETWORK_SUBCOMMANDS = new Set(['fetch', 'ls-remote'])

// `branch` and `tag` list when asked to and write otherwise. Any of these flags
// means git is listing, provided none of the write flags below sits beside it.
const LIST_FLAGS = new Set([
  '--list',
  '-l',
  '--format',
  '--sort',
  '-a',
  '--all',
  '-r',
  '--remotes',
  '-v',
  '-vv',
  '--show-current',
  '--contains',
  '--no-contains',
  '--merged',
  '--no-merged',
  '--points-at',
])
const LIST_WRITE_FLAGS = new Set([
  '-d',
  '-D',
  '--delete',
  '-m',
  '-M',
  '--move',
  '-c',
  '-C',
  '--copy',
  '-u',
  '--set-upstream-to',
  '--unset-upstream',
  '-f',
  '--force',
  '--edit-description',
  '-a',
  '-s',
  '--annotate',
  '--sign',
])

function flagName(arg: string): string {
  const equals = arg.indexOf('=')
  return equals === -1 ? arg : arg.slice(0, equals)
}

/** The subcommand and its arguments, past any global options (`-c k=v`, `-C dir`). */
export function splitSubcommand(args: readonly string[]): { subcommand: string | null; rest: readonly string[] } {
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index]
    if (arg === '-c' || arg === '-C') {
      index += 1
      continue
    }
    if (arg === '--version') return { subcommand: 'version', rest: [] }
    if (arg.startsWith('-')) continue
    return { subcommand: arg, rest: args.slice(index + 1) }
  }
  return { subcommand: null, rest: [] }
}

export function classifyGitCommand(args: readonly string[]): GitCommandKind {
  const { subcommand, rest } = splitSubcommand(args)
  if (!subcommand) return 'write'
  if (READ_SUBCOMMANDS.has(subcommand)) return 'read'
  if (NETWORK_SUBCOMMANDS.has(subcommand)) return 'network'
  const flags = rest.filter((arg) => arg.startsWith('-')).map(flagName)
  const positional = rest.filter((arg) => !arg.startsWith('-'))
  switch (subcommand) {
    case 'branch':
    case 'tag': {
      // `-a` lists all branches but annotates a tag; for a tag it is a write.
      const writes = flags.some((flag) => LIST_WRITE_FLAGS.has(flag) && !(subcommand === 'branch' && flag === '-a'))
      if (writes) return 'write'
      if (rest.length === 0) return 'read'
      return flags.some((flag) => LIST_FLAGS.has(flag)) ? 'read' : 'write'
    }
    case 'symbolic-ref':
      // `symbolic-ref HEAD` reads; `symbolic-ref HEAD refs/heads/x` and `-d` write.
      return positional.length <= 1 && !flags.includes('-d') && !flags.includes('--delete') ? 'read' : 'write'
    case 'stash':
      return positional[0] === 'list' || positional[0] === 'show' ? 'read' : 'write'
    case 'worktree':
      return positional[0] === 'list' ? 'read' : 'write'
    case 'remote':
      // Bare `remote`, `remote -v`, `remote get-url`. `remote update` fetches;
      // everything else edits config.
      if (positional.length === 0 || positional[0] === 'get-url') return 'read'
      if (positional[0] === 'update') return 'network'
      return 'write'
    case 'config':
      return flags.some((flag) => ['--get', '--get-all', '--get-regexp', '-l', '--list'].includes(flag))
        ? 'read'
        : 'write'
    default:
      return 'write'
  }
}

export function defaultGitTimeoutMs(kind: GitCommandKind): number | null {
  if (kind === 'read') return GIT_READ_TIMEOUT_MS
  if (kind === 'network') return GIT_NETWORK_TIMEOUT_MS
  return null
}

/**
 * The environment every git here runs with.
 *
 * LC_ALL=C pins git's messages to English: callers branch on stderr text
 * (e.g. "not fully merged" → force-delete escalation), which localized git
 * would silently break. Paths are bytes to git, so content is unaffected.
 *
 * GIT_TERMINAL_PROMPT=0 on every call: nothing here has a terminal, so a git
 * that decides to ask for a username (an https remote with no credential
 * helper) would otherwise wait on a prompt nobody can see, for ever. With it
 * set git fails at once with "terminal prompts disabled", which is the message
 * the person needs. A credential helper still runs; only the tty prompt is off.
 */
export function gitEnv(overrides?: NodeJS.ProcessEnv, kind: GitCommandKind = 'write'): NodeJS.ProcessEnv {
  return {
    ...process.env,
    LC_ALL: 'C',
    GIT_TERMINAL_PROMPT: '0',
    ...(kind === 'read' ? { GIT_OPTIONAL_LOCKS: '0' } : {}),
    ...overrides,
  }
}

export type GitRunOptions = {
  /**
   * Overrides the deadline the command's kind would get; `null` means none.
   * Leave it out unless the call is known to be unusual.
   */
  timeoutMs?: number | null
  /** Overrides the classification, for a subcommand the classifier cannot see into. */
  kind?: GitCommandKind
  /**
   * Bytes for git's stdin (`apply -`, `check-ignore --stdin`), written whole
   * and then closed. Left out, stdin is untouched.
   */
  stdin?: string
  /**
   * Whether this git runs the programs a repository's own config names
   * (filters, merge drivers, its hooks folder…) when the person has not
   * trusted it: `neutral` turns them off, `as-configured` leaves them as git
   * reads them. Left out, the {@link withNeutralRepoPrograms} scope decides,
   * and outside one they are as configured.
   */
  repoPrograms?: 'neutral' | 'as-configured'
}

/**
 * Config every git here runs under, ahead of the caller's arguments.
 *
 * `core.fsmonitor` names a program git runs whenever it refreshes the index —
 * which `git status`, the sidebar's poll, does on its own. The setting is read
 * from the repository's `.git/config`, so a repository that arrives as a folder
 * or an archive with its `.git` included, or one an agent has edited, would
 * have the app run that program with nobody asking for anything. A `-c` on the
 * command line outranks every config file. The price is the speed a real
 * filesystem monitor buys on a very large repository, and the app's reads are
 * not where that matters.
 *
 * `safe.bareRepository=explicit` keeps git from working in a bare repository
 * it finds on its own by walking up from the folder it was started in. A
 * project can carry a bare repository inside its tree, with a config and
 * hooks of its own, and a git started in that subfolder would otherwise take
 * them as the repository it was asked about. A folder that really is a bare
 * repository is named with `--git-dir` ({@link explicitGitDir}). A checkout,
 * a linked worktree and a folder whose `.git` file points at a bare
 * repository are found as before.
 */
const GIT_SAFETY_PAIRS: ReadonlyArray<readonly [string, string]> = [
  ['core.fsmonitor', 'false'],
  ['safe.bareRepository', 'explicit'],
]
export const GIT_SAFETY_CONFIG: readonly string[] = GIT_SAFETY_PAIRS.flatMap(([key, value]) => [
  '-c',
  `${key}=${value}`,
])

/**
 * `args` with {@link GIT_SAFETY_CONFIG} in front, unless it is already there:
 * for a runner that may be handed arguments the shared runner has prefixed.
 */
export function withGitSafetyConfig(args: readonly string[]): string[] {
  const prefixed = GIT_SAFETY_CONFIG.every((arg, index) => args[index] === arg)
  return prefixed ? [...args] : [...GIT_SAFETY_CONFIG, ...args]
}

/**
 * The global option that names a bare repository's directory to git
 * explicitly. Under `safe.bareRepository=explicit` git will not work in a bare
 * repository it merely finds by walking up from its working directory: a
 * repository cloned with a bare one committed inside it (its config and hooks
 * included) cannot have those picked up by a git the app starts in that
 * subfolder. A caller that knows the folder it holds IS a bare repository —
 * a bare clone opened as a project, the skills cache's own clones — says so
 * with this, and git works there as before.
 */
export function explicitGitDir(gitDir: string): string {
  return `--git-dir=${gitDir}`
}

/**
 * `[--git-dir=<path>]` when `path` is itself a bare repository's directory,
 * and `[]` otherwise (a checkout, a folder whose `.git` file points at a bare
 * repository, not a repository at all, or git unavailable). One read-only
 * `rev-parse`; never throws.
 */
export async function bareRepositoryGitDirArgs(path: string): Promise<string[]> {
  const flag = explicitGitDir(path)
  const result = await runGitCommand(path, [flag, 'rev-parse', '--is-bare-repository'])
  return result.ok && result.stdout.trim() === 'true' ? [flag] : []
}

/**
 * {@link GIT_SAFETY_CONFIG} for a git the app does not start itself — the ones
 * `gh` runs inside a repository to read its remotes and branch. Git reads
 * `GIT_CONFIG_COUNT`/`KEY_n`/`VALUE_n` from its environment with the same
 * precedence as `-c`. Pairs already in the environment are kept, and these
 * are appended after them. `cwd`, the repository, adds its
 * {@link wslShareSafeDirectories}.
 */
export function gitSafetyEnv(
  base: NodeJS.ProcessEnv = process.env,
  cwd?: string,
  platform: NodeJS.Platform = process.platform,
): NodeJS.ProcessEnv {
  return withGitConfigEnv(base, [
    ...GIT_SAFETY_PAIRS.map(([key, value]): [string, string] => [key, value]),
    ...(cwd ? wslShareSafeDirectories(cwd, platform) : []).map((dir): [string, string] => ['safe.directory', dir]),
  ])
}

/**
 * The {@link wslShareSafeDirectories} of `cwd` for an agent's own git: the
 * environment a chat's CLI starts with on This PC in a folder inside a WSL
 * distribution, reached over its share. Without it every `git` the agent runs
 * there stops at "dubious ownership", as the app's own git did before it was
 * given these. Appended after any `GIT_CONFIG_COUNT` pairs the person's
 * environment already sets, which keep their places. Any other folder, or off
 * Windows, returns `base` unchanged; nothing is written to a config file.
 */
export function wslShareSafeDirectoryEnv(
  base: NodeJS.ProcessEnv,
  cwd: string | null | undefined,
  platform: NodeJS.Platform = process.platform,
): NodeJS.ProcessEnv {
  const dirs = cwd ? wslShareSafeDirectories(cwd, platform) : []
  if (dirs.length === 0) return base
  return withGitConfigEnv(
    base,
    dirs.map((dir): [string, string] => ['safe.directory', dir]),
  )
}

/** `pairs` as `GIT_CONFIG_KEY_n`/`VALUE_n`, numbered after any the environment already holds. */
function withGitConfigEnv(base: NodeJS.ProcessEnv, pairs: ReadonlyArray<[string, string]>): NodeJS.ProcessEnv {
  const existing = Number.parseInt(base.GIT_CONFIG_COUNT ?? '0', 10)
  const index = Number.isInteger(existing) && existing > 0 ? existing : 0
  const env: NodeJS.ProcessEnv = { ...base, GIT_CONFIG_COUNT: String(index + pairs.length) }
  pairs.forEach(([key, value], offset) => {
    env[`GIT_CONFIG_KEY_${index + offset}`] = key
    env[`GIT_CONFIG_VALUE_${index + offset}`] = value
  })
  return env
}

/**
 * The `safe.directory` entries Git for Windows needs for a repository inside a
 * WSL distribution, reached over its share (`\\wsl.localhost\Ubuntu\…`): a
 * chat on This PC in such a folder (owner ruling 2026-10-03). Its files are
 * owned by the Linux user, whom Windows cannot map to the person, so git
 * refuses the repository as one of "dubious ownership" until it is listed.
 * Listed here, for the app's own git only, by `-c`: the person's global config
 * is never written. Git compares the entry with the repository's top level,
 * which may sit above `cwd`, so `cwd` and each folder above it inside the
 * distribution are listed. Spelled the way Git for Windows itself suggests,
 * `%(prefix)///wsl.localhost/…`: it reads a value that starts with one `/` as
 * relative to its own install, and `%(prefix)/` before an absolute path leaves
 * the path as it is. Nothing on any other path, or off Windows.
 */
export function wslShareSafeDirectories(cwd: string, platform: NodeJS.Platform = process.platform): string[] {
  if (platform !== 'win32') return []
  const share = /^\/\/(wsl\$|wsl\.localhost)\/([^/]+)((?:\/[^/]+)*)\/*$/iu.exec(cwd.replace(/\\/gu, '/'))
  if (!share) return []
  const root = `//${share[1]}/${share[2]}`
  const parts = share[3].split('/').filter(Boolean)
  const dirs: string[] = []
  for (let depth = parts.length; depth >= 0; depth -= 1) {
    dirs.push(`%(prefix)/${root}${depth > 0 ? `/${parts.slice(0, depth).join('/')}` : ''}`)
  }
  return dirs
}

/**
 * Config for Linux git working on a Windows drive through WSL's mount
 * (`/mnt/c/…`): compare only an entry's size and whole-second mtime when
 * deciding whether a file changed. The index of such a repository is mostly
 * written by Git for Windows, whose inode, owner, ctime and sub-second
 * fields never match what the drive mount reports, so Linux git with the
 * default `core.checkStat` re-reads every tracked file across the mount on
 * every status: measured at 20 of 30 s for a 3,875-file repository, against
 * 0.1 s from Windows. Size and mtime are the same number on both sides, so
 * with this the index is trusted again; a file changed within the second the
 * index was written is still read, by git's racy-entry check. Studio's own
 * git keeps running where the chat's agents run theirs (one git per
 * repository), so checkpoints and revert see the files as the agent does.
 * A checkpoint snapshot sets `core.checkStat=default` after this, and so
 * re-reads: there a trusted entry would be Git for Windows' blob, after a
 * line-ending conversion Linux git does not make (conversation-checkpoints.ts).
 */
export const DRIVE_MOUNT_GIT_CONFIG: readonly string[] = ['-c', 'core.checkStat=minimal']

/** {@link DRIVE_MOUNT_GIT_CONFIG} when Linux git runs in `cwd` on a Windows drive. */
function driveMountConfig(cwd: string, linuxGit: boolean): readonly string[] {
  if (!linuxGit) return []
  return /^[A-Za-z]:(?:[\\/]|$)/u.test(cwd) || isWslDriveMountPath(cwd) ? DRIVE_MOUNT_GIT_CONFIG : []
}

function safeDirectoryConfig(cwd: string): string[] {
  return wslShareSafeDirectories(cwd).flatMap((dir) => ['-c', `safe.directory=${dir}`])
}

// ── Repositories whose own config names programs ───────────────────────────
//
// A repository's own git config can name programs for git to run: a filter, a
// merge driver, a diff converter, a hooks folder, an ssh command, a shell
// credential helper (git-repo-programs.ts). Whether the person trusts the ones
// a repository names is theirs to say, once, on its project's banner
// (git-repo-trust.ts); the answer is installed here for the runner.

/** One config entry, as `git config --show-scope` names it. */
export type GitRepoConfigEntry = { scope: string; key: string; value: string }

/** A repository's program settings, and whether the person trusts them. */
export type GitRepoTrustAnswer = {
  /** True when the repository names no program, or the person trusted the ones it names. */
  trusted: boolean
  /** The repository's own entries that name a program. */
  settings: readonly GitRepoConfigEntry[]
  /** Every entry of those kinds git read, the person's own (global, system) included. */
  entries: readonly GitRepoConfigEntry[]
}

let repoTrustResolver: ((cwd: string) => Promise<GitRepoTrustAnswer | null>) | null = null
let neutralHooksDir: string | null = null

/**
 * Installed by each process's services once the trust store exists; null
 * uninstalls. `emptyHooksDir` is an empty folder the app owns, which an
 * untrusted repository's own hooks folder is swapped for.
 */
export function installGitRepoTrust(
  resolver: ((cwd: string) => Promise<GitRepoTrustAnswer | null>) | null,
  options: { emptyHooksDir?: string } = {},
): void {
  repoTrustResolver = resolver
  if (options.emptyHooksDir !== undefined) neutralHooksDir = options.emptyHooksDir
}

/** The trust answer for the repository `cwd` is in; null when none is installed or it could not be read. */
export async function gitRepoTrustFor(cwd: string): Promise<GitRepoTrustAnswer | null> {
  if (!repoTrustResolver) return null
  return repoTrustResolver(cwd).catch(() => null)
}

const neutralScope = new AsyncLocalStorage<true>()

/**
 * Runs `work` with every git it starts by the app's own choice (the status
 * poll, diff stats, checkpoints, the pool's checkouts) under
 * {@link neutralRepoPrograms} in a repository the person has not trusted. A
 * call's own `repoPrograms` still wins.
 */
export function withNeutralRepoPrograms<T>(work: () => Promise<T>): Promise<T> {
  return neutralScope.run(true, work)
}

/** What a git in an untrusted repository is given so that the programs its config names do not run. */
export type NeutralRepoPrograms = {
  /** `-c` pairs, ahead of the caller's arguments. */
  config: string[]
  /** Variables for git's environment. */
  env: Record<string, string>
  /** The repository names a diff converter or external diff: `diff`, `log`, `show` and `blame` are told not to use them. */
  noDiffPrograms: boolean
  /** The filters whose commands were emptied (`lfs`, …). */
  filters: string[]
}

const FILTER_KEY = /^filter\.(.+)\.(clean|smudge|process)$/u
const MERGE_DRIVER_KEY = /^merge\.(.+)\.driver$/u
const DIFF_PROGRAM_KEY = /^diff\..+\.(textconv|command)$/u
const CREDENTIAL_HELPER_KEY = /^credential(\..+)?\.helper$/u
const PERSON_SCOPES = new Set(['global', 'system', 'command'])

/**
 * The overrides that keep git from running the programs an untrusted
 * repository's config names, one per setting it names, or null when there is
 * nothing to turn off (no such setting, or the person trusts them). A `-c` on
 * the command line outranks every config file:
 *
 * - a filter's clean, smudge and process commands are emptied and the filter
 *   is marked not required, so git stores and checks out the bytes as they are
 *   rather than failing for a filter that did not run;
 * - a merge driver is emptied: git cannot run it, and the file is a conflict
 *   rather than taken as merged;
 * - the hooks folder is an empty folder the app owns;
 * - an ssh command is the person's own (global) one, or git's own `ssh`: an
 *   empty one makes git fail to run anything at all;
 * - a proxy command is emptied through `GIT_PROXY_COMMAND`, because git keeps
 *   the first `core.gitProxy` it reads and a `-c` is read last;
 * - an askpass program is emptied (git falls back to `GIT_ASKPASS`, then to no
 *   prompt at all), a pager emptied, an editor made `:`, git's no-op editor;
 * - a shell-command credential helper is dropped by resetting the helper list
 *   and naming again every other helper, in order, with its own key;
 * - a diff converter or external diff is refused by flag
 *   ({@link NeutralRepoPrograms.noDiffPrograms}): git has no empty value for
 *   either that does not fail the diff.
 */
export function neutralRepoPrograms(
  answer: GitRepoTrustAnswer | null,
  options: { emptyHooksDir: string | null; env?: NodeJS.ProcessEnv } = { emptyHooksDir: neutralHooksDir },
): NeutralRepoPrograms | null {
  if (!answer || answer.trusted || answer.settings.length === 0) return null
  const env = options.env ?? process.env
  const pairs: Array<[string, string]> = []
  const extraEnv: Record<string, string> = {}
  const filters = new Set<string>()
  let noDiffPrograms = false
  let credentialsReset = false
  const named = new Set(answer.settings.map((entry) => entry.key))
  for (const key of named) {
    const filter = FILTER_KEY.exec(key)
    if (filter) {
      filters.add(filter[1])
      continue
    }
    const driver = MERGE_DRIVER_KEY.exec(key)
    if (driver) {
      pairs.push([`merge.${driver[1]}.driver`, ''])
      continue
    }
    if (DIFF_PROGRAM_KEY.test(key)) {
      noDiffPrograms = true
      continue
    }
    if (CREDENTIAL_HELPER_KEY.test(key)) {
      credentialsReset = true
      continue
    }
    switch (key) {
      case 'core.hookspath':
        // No folder to swap in: one that cannot exist holds no hooks either.
        pairs.push(['core.hooksPath', options.emptyHooksDir ?? '/dev/null/sprintengine-no-hooks'])
        break
      case 'core.sshcommand': {
        const own = answer.entries.filter((entry) => entry.key === key && PERSON_SCOPES.has(entry.scope)).at(-1)
        pairs.push(['core.sshCommand', own?.value || 'ssh'])
        break
      }
      case 'core.gitproxy':
        if (env.GIT_PROXY_COMMAND === undefined) extraEnv.GIT_PROXY_COMMAND = ''
        break
      case 'core.askpass':
        pairs.push(['core.askPass', ''])
        break
      case 'core.pager':
        pairs.push(['core.pager', ''])
        break
      case 'core.editor':
        pairs.push(['core.editor', ':'])
        break
    }
  }
  for (const name of filters) {
    pairs.push(
      [`filter.${name}.clean`, ''],
      [`filter.${name}.smudge`, ''],
      [`filter.${name}.process`, ''],
      [`filter.${name}.required`, 'false'],
    )
  }
  if (credentialsReset) {
    pairs.push(['credential.helper', ''])
    const dropped = new Set(answer.settings.filter((entry) => CREDENTIAL_HELPER_KEY.test(entry.key)))
    for (const entry of answer.entries) {
      if (CREDENTIAL_HELPER_KEY.test(entry.key) && !dropped.has(entry) && entry.value) {
        pairs.push([entry.key, entry.value])
      }
    }
  }
  return {
    config: pairs.flatMap(([key, value]) => ['-c', `${key}=${value}`]),
    env: extraEnv,
    noDiffPrograms,
    filters: [...filters],
  }
}

/** The overrides for a git in `cwd`, when the call asks for them and the repository is untrusted. */
async function neutralProgramsFor(
  cwd: string,
  options: GitRunOptions,
  linuxGitOnWindows = false,
): Promise<NeutralRepoPrograms | null> {
  const wanted = options.repoPrograms ?? (neutralScope.getStore() ? 'neutral' : 'as-configured')
  if (wanted !== 'neutral' || !repoTrustResolver) return null
  // A distribution's git reaches the app's empty folder through the drive mount.
  const emptyHooksDir = linuxGitOnWindows && neutralHooksDir ? toWslPath(neutralHooksDir) : neutralHooksDir
  return neutralRepoPrograms(await gitRepoTrustFor(cwd), { emptyHooksDir })
}

/**
 * The filters whose programs the app's own git turns off in `cwd`: an
 * untrusted repository's that its config names. Empty when it is trusted.
 */
export async function neutralizedGitFilters(cwd: string): Promise<string[]> {
  return (await neutralProgramsFor(cwd, { repoPrograms: 'neutral' }))?.filters ?? []
}

const DIFF_PROGRAM_FLAGS: Readonly<Record<string, readonly string[]>> = {
  diff: ['--no-ext-diff', '--no-textconv'],
  log: ['--no-ext-diff', '--no-textconv'],
  show: ['--no-ext-diff', '--no-textconv'],
  blame: ['--no-textconv'],
}

/** `args` with the overrides in front and, for a diff that would use them, the flags that refuse diff programs. */
function withNeutralPrograms(args: string[], programs: NeutralRepoPrograms | null): string[] {
  if (!programs) return args
  let out = args
  if (programs.noDiffPrograms) {
    const { subcommand, rest } = splitSubcommand(args)
    const flags = subcommand ? DIFF_PROGRAM_FLAGS[subcommand] : undefined
    if (flags) {
      const at = args.length - rest.length
      out = [...args.slice(0, at), ...flags, ...args.slice(at)]
    }
  }
  return [...programs.config, ...out]
}

type ExecGitResult = { stdout: string; stderr: string }
type ExecGitError = Error & { stdout?: string; stderr?: string; timedOut?: boolean }

/**
 * Counts every git process this module starts, by kind. Read by the spawn-rate
 * test and by nothing else; it costs an increment.
 */
export const gitSpawnCounter = { read: 0, network: 0, write: 0 }

// ── Repositories on another machine ─────────────────────────────────────────
//
// A repository that belongs to a WSL workspace is run by that distribution's
// git (owner decision 2026-09-24): its agents commit, branch and add worktrees
// with Linux git, and two gits on one repository disagree about worktree
// links, line endings and the index. The resolver says which host a folder is
// on; a WSL host runs the command inside the distribution under the same kind,
// deadline and environment rules as everything here. Everything else — every
// path on macOS and Linux, and a plain Windows folder — keeps the `execFile`
// below, untouched.

type GitHost = Pick<ExecutionHost, 'kind' | 'runGit'>
let gitHostResolver: ((cwd: string) => GitHost | null) | null = null

/** Installed by app-services once the host registry exists. */
export function installGitHostResolver(resolver: ((cwd: string) => GitHost | null) | null): void {
  gitHostResolver = resolver
}

// A machine named by the caller for one piece of work, which wins over the
// resolver: a New chat on a WSL machine makes its worktree before the
// workspace that would tell the resolver about it exists.
const gitHostScope = new AsyncLocalStorage<GitHost>()

/** Runs `work` with every git it starts on `host`; null leaves the resolver to decide. */
export function withGitHost<T>(host: GitHost | null, work: () => Promise<T>): Promise<T> {
  return host ? gitHostScope.run(host, work) : work()
}

/**
 * The variables `gitEnv` adds for git's own sake, plus the caller's, without
 * this process's whole environment: a git in WSL gets its environment from
 * its own login, and only what the runner decides crosses.
 */
function gitEnvDelta(overrides: NodeJS.ProcessEnv | undefined, kind: GitCommandKind): Record<string, string> {
  const delta: Record<string, string> = {
    LC_ALL: 'C',
    GIT_TERMINAL_PROMPT: '0',
    ...(kind === 'read' ? { GIT_OPTIONAL_LOCKS: '0' } : {}),
  }
  for (const [key, value] of Object.entries(overrides ?? {})) if (typeof value === 'string') delta[key] = value
  return delta
}

async function execGitOnHost(
  host: GitHost,
  cwd: string,
  args: string[],
  envOverrides: NodeJS.ProcessEnv | undefined,
  kind: GitCommandKind,
  timeoutMs: number | null,
  stdin: string | undefined,
): Promise<ExecGitResult> {
  const outcome = await host.runGit(cwd, [...GIT_SAFETY_CONFIG, ...driveMountConfig(cwd, true), ...args], {
    timeoutMs,
    env: gitEnvDelta(envOverrides, kind),
    ...(stdin !== undefined ? { stdin } : {}),
  })
  if (outcome.code === 0 && !outcome.timedOut && !outcome.spawnFailed) {
    return { stdout: outcome.stdout, stderr: outcome.stderr }
  }
  const failure = new Error(
    outcome.timedOut
      ? `git ${splitSubcommand(args).subcommand ?? ''} did not finish within ${Math.round((timeoutMs ?? 0) / 1000)} s and was stopped.`
      : outcome.stderr.trim() || `git exited with code ${outcome.code}.`,
  ) as ExecGitError
  failure.stdout = outcome.stdout
  failure.stderr = outcome.timedOut ? '' : outcome.stderr
  if (outcome.timedOut) failure.timedOut = true
  throw failure
}

/**
 * One git process, with its kind's deadline. On POSIX a timed child is started
 * in its own process group so the deadline ends git and whatever it started (a
 * transport helper, a hook) together; see `killProcessTree`.
 */
async function execGit(
  cwd: string,
  callerArgs: string[],
  callerEnv: NodeJS.ProcessEnv | undefined,
  options: GitRunOptions,
): Promise<ExecGitResult> {
  const kind = options.kind ?? classifyGitCommand(callerArgs)
  const timeoutMs = options.timeoutMs === undefined ? defaultGitTimeoutMs(kind) : options.timeoutMs
  const grouped = timeoutMs !== null && process.platform !== 'win32'
  // Read before git starts, so a host scope set by the caller is still the one asked.
  const host = gitHostScope.getStore() ?? gitHostResolver?.(cwd) ?? null

  // An untrusted repository's own programs, off for the git the app starts by
  // itself. The caller's own `-c` pairs come after, and win.
  const programs = await neutralProgramsFor(cwd, options, host?.kind === 'wsl')
  const args = withNeutralPrograms(callerArgs, programs)
  const envOverrides = programs && Object.keys(programs.env).length > 0 ? { ...programs.env, ...callerEnv } : callerEnv
  gitSpawnCounter[kind] += 1

  if (host && host.kind === 'wsl') {
    return execGitOnHost(host, cwd, args, envOverrides, kind, timeoutMs, options.stdin)
  }

  // On Windows, the real git.exe rather than Git for Windows' launcher; see
  // git-executable.ts.
  const env = gitEnv(envOverrides, kind)
  return withGitExecutable(env, (file) => execGitFile(file, cwd, args, env, timeoutMs, grouped, options.stdin))
}

function execGitFile(
  file: string,
  cwd: string,
  args: string[],
  env: NodeJS.ProcessEnv,
  timeoutMs: number | null,
  grouped: boolean,
  stdin: string | undefined,
): Promise<ExecGitResult> {
  return new Promise((resolvePromise, reject) => {
    let timedOut = false
    let timer: NodeJS.Timeout | null = null
    const child = execFile(
      file,
      [
        '-C',
        cwd,
        ...GIT_SAFETY_CONFIG,
        ...safeDirectoryConfig(cwd),
        ...driveMountConfig(cwd, process.platform === 'linux'),
        ...args,
      ],
      {
        encoding: 'utf8',
        maxBuffer: 20 * 1024 * 1024,
        windowsHide: true,
        env,
        ...(grouped ? { detached: true } : {}),
      },
      (error, stdout, stderr) => {
        if (timer) clearTimeout(timer)
        if (!error && !timedOut) {
          resolvePromise({ stdout, stderr })
          return
        }
        const failure = (error ?? new Error('git was stopped.')) as ExecGitError
        failure.stdout = stdout
        failure.stderr = stderr
        if (timedOut) {
          const seconds = Math.round((timeoutMs ?? 0) / 1000)
          failure.timedOut = true
          failure.message = `git ${splitSubcommand(args).subcommand ?? ''} did not finish within ${seconds} s and was stopped.`
          failure.stderr = ''
        }
        reject(failure)
      },
    )
    if (timeoutMs !== null) {
      timer = setTimeout(() => {
        timedOut = true
        killProcessTree(child, { processGroup: grouped })
      }, timeoutMs)
    }
    if (stdin !== undefined) {
      // git can exit before it has read everything (`apply` refusing a patch);
      // the EPIPE that follows is not the failure and must not go unhandled.
      child.stdin?.on('error', () => {})
      child.stdin?.end(stdin)
    }
  })
}

export async function runGit(cwd: string, args: string[], options: GitRunOptions = {}): Promise<string> {
  const { stdout } = await execGit(cwd, args, undefined, options)
  return stdout
}

function removeLineEndingWarnings(output: string): string {
  return output
    .split(/\r?\n/)
    .filter(
      (line) =>
        !/^warning: in the working copy of '.+', (?:LF|CRLF) will be replaced by (?:LF|CRLF) the next time Git touches it$/.test(
          line.trim(),
        ),
    )
    .join('\n')
    .trim()
}

export async function runGitCommand(
  cwd: string,
  args: string[],
  envOverrides?: NodeJS.ProcessEnv,
  options: GitRunOptions = {},
): Promise<GitCommandResult> {
  try {
    const { stdout, stderr } = await execGit(cwd, args, envOverrides, options)
    return { ok: true, stdout, stderr: removeLineEndingWarnings(stderr), message: null }
  } catch (error) {
    const execError = error as ExecGitError
    const stderr = removeLineEndingWarnings(execError.stderr ?? '')
    return {
      ok: false,
      stdout: execError.stdout ?? '',
      stderr,
      message: execError.timedOut
        ? execError.message
        : stderr || removeLineEndingWarnings(execError.message ?? '') || 'Git command failed.',
      ...(execError.timedOut ? { timedOut: true as const } : {}),
    }
  }
}
