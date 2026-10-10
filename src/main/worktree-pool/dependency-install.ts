import { execFile, spawn } from 'child_process'
import { createHash, randomUUID, type Hash } from 'crypto'
import { readdir, readFile, rm, stat, writeFile } from 'fs/promises'
import { join, resolve } from 'path'

import type {
  WorktreeDependencyInstallReason,
  WorktreeDependencyInstallSetting,
  WorktreeDependencyInstallView,
} from '../../shared/ipc/worktree-pool'
import { ansiPlainText } from '../../shared/conversation/ansi'
import { killProcessTree } from '../process-tree-kill'

/**
 * A leased pool worktree installs its dependencies when its lockfile changed
 * since it last did (owner ruling 2026-10-06, revising "no installs, ever").
 *
 * The pool itself stays install-free: it resets a slot and hands it out, and
 * this runs after, in the one place every agent worktree is made
 * (`createAgentWorktreeFromPool` in git.ts), so New chat, the tab strip's
 * worktree spawn, `agent.launch` and scheduled runs all wait for it the same
 * way. The agent starts once it ends, whether or not it worked: a failed
 * install is reported, never a reason to withhold the chat.
 *
 * Off unless the project opted in, because an install runs the repository's
 * own scripts (`postinstall` and the like) with the person's rights.
 *
 * What a slot last installed is recorded in its git admin directory
 * (`.git/worktrees/<slot>/`), not in the pool's record and not in the
 * worktree: `clean -fd` and "Clear ignored files" never reach it, git ignores
 * a file it does not know there, and it lives exactly as long as the slot is
 * registered — a slot removed and made again starts with no record, as it
 * starts with no `node_modules`. The record is a fingerprint of everything the
 * install's result depends on (`installFingerprint`); it is cleared before an
 * install starts and written only when one succeeds, so an install that
 * failed, timed out, was cancelled or was killed by the app quitting runs
 * again at the next lease.
 */

/** The lockfiles an install command is inferred from, in the order a tie is broken. */
const JS_LOCKFILES = ['pnpm-lock.yaml', 'bun.lock', 'bun.lockb', 'yarn.lock', 'package-lock.json'] as const

/**
 * Other ecosystems' lockfiles. Nothing is inferred from them, but a project's
 * own command may read any of them, so under one every lockfile present
 * counts toward whether it runs.
 */
const OTHER_LOCKFILES = ['Cargo.lock', 'uv.lock', 'poetry.lock', 'Gemfile.lock', 'composer.lock', 'go.sum'] as const

/** Where a slot's install record lives, in its git admin directory. */
export const DEPENDENCY_INSTALL_RECORD = 'sprintengine-dependencies.json'

/** Long enough for a cold native rebuild; a hung script is still let go of. */
export const DEPENDENCY_INSTALL_TIMEOUT_MS = 20 * 60_000

/** How often a running install's last line is sent to the windows. */
const PROGRESS_INTERVAL_MS = 750

/** The end of an install's output kept for a failure's report. */
const OUTPUT_TAIL_CHARS = 8_000

/** How long after the install exits its pipes may stay open (a daemon a script left behind). */
const PIPE_DRAIN_GRACE_MS = 2_000

/**
 * The files beside the lockfile that change what an install produces: the
 * registry and its credentials' configuration, Yarn's settings, pnpm's
 * workspace (catalogs, overrides, patched dependencies), and Yarn 1's rc.
 */
const INSTALL_CONFIG_FILES = ['.npmrc', '.yarnrc', '.yarnrc.yml', 'pnpm-workspace.yaml'] as const

/**
 * `patches/` (patch-package, pnpm's and Yarn's patch protocols) is read whole
 * into the fingerprint, within these bounds: a patch past them counts by its
 * name and size, so a pathological folder costs a listing, not a read.
 */
const PATCH_FILES_MAX = 500
const PATCH_BYTES_MAX = 8 * 1024 * 1024
const PATCH_DEPTH_MAX = 3

/** How long `node -v` may take before the fingerprint goes without it. */
const NODE_VERSION_TIMEOUT_MS = 5_000

/** How long the quit waits for the installs it stopped to let go of their worktrees. */
const SHUTDOWN_WAIT_MS = 3_000

/** The settled installs kept for a caller that asks how one ended after it did. */
const SETTLED_KEPT = 64

type PackageManager = 'npm' | 'pnpm' | 'yarn' | 'bun'

const MANAGER_OF: Record<(typeof JS_LOCKFILES)[number], PackageManager> = {
  'pnpm-lock.yaml': 'pnpm',
  'bun.lock': 'bun',
  'bun.lockb': 'bun',
  'yarn.lock': 'yarn',
  'package-lock.json': 'npm',
}

/**
 * The install a JavaScript project's lockfile implies, never one that rewrites
 * the lockfile: a slot's tracked files must stay as the reset left them.
 *
 * Several lockfiles at once happen (a stale `package-lock.json` beside the
 * `yarn.lock` in use); `packageManager` in package.json settles it when it
 * names a manager whose lockfile is there, else the order above does. Yarn 2
 * and later (`packageManager: yarn@2+`, or a `.yarnrc.yml`) spell the frozen
 * install `--immutable`.
 */
export function inferInstallCommand(input: {
  files: ReadonlySet<string>
  packageManager?: string | null
}): { lockfile: string; command: string } | null {
  const present = JS_LOCKFILES.filter((name) => input.files.has(name))
  if (present.length === 0) return null
  const declared = /^(npm|pnpm|yarn|bun)@(\d+)?/u.exec(input.packageManager?.trim() ?? '')
  const lockfile = present.find((name) => MANAGER_OF[name] === declared?.[1]) ?? present[0]
  switch (MANAGER_OF[lockfile]) {
    case 'pnpm':
      return { lockfile, command: 'pnpm install --frozen-lockfile' }
    case 'bun':
      return { lockfile, command: 'bun install --frozen-lockfile' }
    case 'yarn': {
      const major = declared?.[1] === 'yarn' && declared[2] ? Number(declared[2]) : null
      const berry = major !== null ? major >= 2 : input.files.has('.yarnrc.yml')
      return { lockfile, command: berry ? 'yarn install --immutable' : 'yarn install --frozen-lockfile' }
    }
    case 'npm':
      return { lockfile, command: 'npm ci' }
  }
}

export type DependencyInstallPlan =
  | { run: false; why: 'off' | 'nothing-to-install' | 'up-to-date' }
  | { run: true; command: string; fingerprint: string; reason: WorktreeDependencyInstallReason }

type InstallRecord = { fingerprint: string; command: string; installedAt: number }

/**
 * The git admin directory of a worktree, read from its `.git` file
 * (`gitdir: …`, relative under `worktree.useRelativePaths`), or null.
 */
export async function worktreeGitDir(worktreePath: string): Promise<string | null> {
  const dotGit = join(worktreePath, '.git')
  const info = await stat(dotGit).catch(() => null)
  if (!info) return null
  if (info.isDirectory()) return dotGit
  const text = await readFile(dotGit, 'utf8').catch(() => '')
  const match = /^gitdir:\s*(.+?)\s*$/mu.exec(text)
  return match ? resolve(worktreePath, match[1]) : null
}

async function readRecord(recordPath: string | null): Promise<InstallRecord | null> {
  if (!recordPath) return null
  const text = await readFile(recordPath, 'utf8').catch(() => null)
  if (text === null) return null
  try {
    const value = JSON.parse(text) as Partial<InstallRecord>
    return typeof value.fingerprint === 'string'
      ? { fingerprint: value.fingerprint, command: String(value.command ?? ''), installedAt: Number(value.installedAt) }
      : null
  } catch {
    return null
  }
}

/**
 * Whether a leased worktree should install, and with what. Runs when the
 * project opted in, there is something to run, and the worktree never
 * installed, installed with something else (`installFingerprint`), or lost
 * what it installed — a JavaScript project with neither `node_modules` nor
 * Yarn's Plug'n'Play map.
 */
async function planDependencyInstall(input: {
  worktreePath: string
  setting: WorktreeDependencyInstallSetting | null
  recordPath: string | null
  /**
   * The Node version the install would run under (`node -v` in its
   * environment); asked only once there is something to install, and only of
   * a JavaScript project. Absent, or null, the fingerprint goes without it.
   */
  nodeVersion?: () => Promise<string | null>
}): Promise<DependencyInstallPlan> {
  if (!input.setting?.enabled) return { run: false, why: 'off' }
  const files = new Set(await readdir(input.worktreePath).catch(() => [] as string[]))
  const packageManager = files.has('package.json')
    ? await readFile(join(input.worktreePath, 'package.json'), 'utf8')
        .then((text) => {
          const value = JSON.parse(text) as { packageManager?: unknown }
          return typeof value.packageManager === 'string' ? value.packageManager : null
        })
        .catch(() => null)
    : null
  const inferred = inferInstallCommand({ files, packageManager })
  const own = input.setting.command?.trim() || null
  const command = own ?? inferred?.command ?? null
  if (!command) return { run: false, why: 'nothing-to-install' }

  const javascript = files.has('package.json') || JS_LOCKFILES.some((name) => files.has(name))
  const fingerprint = await installFingerprint({
    worktreePath: input.worktreePath,
    files,
    command,
    // The lockfile the inferred command reads; under a command of the
    // project's own, every lockfile there, since nothing says which it reads.
    lockfiles: own
      ? [...JS_LOCKFILES, ...OTHER_LOCKFILES].filter((name) => files.has(name)).sort()
      : [inferred!.lockfile],
    packageManager,
    nodeVersion: javascript && input.nodeVersion ? await input.nodeVersion().catch(() => null) : null,
  })

  const record = await readRecord(input.recordPath)
  const installed = !JS_LOCKFILES.some((name) => files.has(name)) || files.has('node_modules') || files.has('.pnp.cjs')
  if (!record) return { run: true, command, fingerprint, reason: 'first' }
  if (record.fingerprint !== fingerprint) return { run: true, command, fingerprint, reason: 'changed' }
  if (!installed) return { run: true, command, fingerprint, reason: 'missing' }
  return { run: false, why: 'up-to-date' }
}

/**
 * What an install's result depends on, hashed: the command, the lockfiles it
 * reads, the package manager and its version as package.json declares it
 * (`packageManager`, which Corepack runs; read from the file, not by starting
 * the manager), the Node version it runs under (a native module built for one
 * ABI does not load in another), the registry and manager configuration
 * beside the lockfile, and `patches/`. A change to any of them installs again.
 */
async function installFingerprint(input: {
  worktreePath: string
  files: ReadonlySet<string>
  command: string
  lockfiles: readonly string[]
  packageManager: string | null
  nodeVersion: string | null
}): Promise<string> {
  const hash = createHash('sha256').update(`${input.command}\0`)
  const part = (name: string, content: Buffer | string | null) => {
    hash.update(`${name}\0`)
    hash.update(content ?? '\0missing')
    hash.update('\0')
  }
  for (const name of input.lockfiles) part(name, await readFile(join(input.worktreePath, name)).catch(() => null))
  if (input.packageManager) part('packageManager', input.packageManager.trim())
  if (input.nodeVersion) part('node', input.nodeVersion.trim())
  for (const name of INSTALL_CONFIG_FILES) {
    if (input.files.has(name)) part(name, await readFile(join(input.worktreePath, name)).catch(() => null))
  }
  if (input.files.has('patches')) await hashPatches(join(input.worktreePath, 'patches'), hash)
  return hash.digest('hex')
}

/** Every file under `patches/`, by its path and contents, within the bounds above. */
async function hashPatches(dir: string, hash: Hash): Promise<void> {
  const found: string[] = []
  const walk = async (relative: string, depth: number): Promise<void> => {
    if (depth > PATCH_DEPTH_MAX || found.length >= PATCH_FILES_MAX) return
    const entries = await readdir(join(dir, relative), { withFileTypes: true }).catch(() => [])
    for (const entry of entries.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0))) {
      if (found.length >= PATCH_FILES_MAX) return
      const path = relative ? `${relative}/${entry.name}` : entry.name
      if (entry.isDirectory()) await walk(path, depth + 1)
      else if (entry.isFile()) found.push(path)
    }
  }
  await walk('', 0)
  let budget = PATCH_BYTES_MAX
  for (const path of found) {
    const size = (await stat(join(dir, path)).catch(() => null))?.size ?? -1
    hash.update(`patches/${path}\0${size}\0`)
    if (size < 0 || size > budget) continue
    budget -= size
    const content = await readFile(join(dir, path)).catch(() => null)
    if (content) hash.update(content)
    hash.update('\0')
  }
}

/**
 * `node -v` as the install would see it: resolved on the environment's PATH,
 * so a version manager's node is the one asked. Null when there is none, or it
 * does not answer in time.
 */
function readNodeVersion(env: NodeJS.ProcessEnv): Promise<string | null> {
  return new Promise((done) => {
    execFile(
      'node',
      ['-v'],
      { env, timeout: NODE_VERSION_TIMEOUT_MS, windowsHide: true, shell: process.platform === 'win32' },
      (error, stdout) => {
        const version = String(stdout ?? '').trim()
        done(!error && /^v?\d+\./u.test(version) ? version : null)
      },
    )
  })
}

export type InstallRunOutcome = {
  code: number | null
  timedOut: boolean
  cancelled: boolean
  /** Set when the command could not be started at all. */
  error?: string
}

export type InstallCommandRunner = (input: {
  command: string
  cwd: string
  env: NodeJS.ProcessEnv
  timeoutMs: number
  signal: AbortSignal
  onOutput: (chunk: string) => void
}) => Promise<InstallRunOutcome>

/**
 * The command through the platform's shell (`/bin/sh`, `cmd.exe`), so a
 * project's own command may chain steps and `npm` resolves as the `.cmd` shim
 * it is on Windows. Detached on POSIX so a timeout, a cancel or the app
 * quitting ends the scripts the manager started, not only the manager: the
 * group is killed whole, and on Windows `taskkill /T` walks the tree. Being
 * detached is also what would let it outlive the app, which is why the quit
 * stops every one still running (`shutdown` below).
 */
export const runInstallCommand: InstallCommandRunner = ({ command, cwd, env, timeoutMs, signal, onOutput }) =>
  new Promise((done) => {
    let settled = false
    let timedOut = false
    let cancelled = false
    let drain: ReturnType<typeof setTimeout> | null = null
    const child = spawn(command, {
      cwd,
      env,
      shell: true,
      detached: process.platform !== 'win32',
      windowsHide: true,
      stdio: ['ignore', 'pipe', 'pipe'],
    })
    const stop = () => killProcessTree(child, { processGroup: true })
    const timer = setTimeout(() => {
      timedOut = true
      stop()
    }, timeoutMs)
    const onAbort = () => {
      cancelled = true
      stop()
    }
    signal.addEventListener('abort', onAbort, { once: true })
    const settle = (outcome: InstallRunOutcome) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      if (drain) clearTimeout(drain)
      signal.removeEventListener('abort', onAbort)
      done(outcome)
    }
    child.stdout?.on('data', (chunk: Buffer) => onOutput(chunk.toString()))
    child.stderr?.on('data', (chunk: Buffer) => onOutput(chunk.toString()))
    child.on('error', (error) => settle({ code: null, timedOut, cancelled, error: error.message }))
    child.on('exit', (code) => {
      drain = setTimeout(() => settle({ code, timedOut, cancelled }), PIPE_DRAIN_GRACE_MS)
    })
    child.on('close', (code) => settle({ code, timedOut, cancelled }))
    if (signal.aborted) onAbort()
  })

/** The last non-empty line of some output, as a terminal would leave it. */
function lastLineOf(text: string): string | null {
  const lines = ansiPlainText(text)
    .split('\n')
    .map((line) => line.trim())
    .filter(Boolean)
  const last = lines[lines.length - 1]
  return last ? last.slice(0, 300) : null
}

export type DependencyInstallerDeps = {
  /**
   * The environment an install runs with: the person's login environment (so
   * a token or a proxy their shell profile exports reaches a private
   * registry), none of the app's own variables. Asked at most once a lease,
   * and only when the plan needs it: a JavaScript project's Node version, or
   * an install. The caller keeps a login shell's answer for a few minutes
   * (`cachedDependencyInstallEnvironment`), so the leases that install
   * nothing do not start a shell each.
   */
  env: () => Promise<NodeJS.ProcessEnv>
  /**
   * Drop the environment `env` kept: an install failed, and what it lacked (a
   * token, a proxy) may be in the profile by the next lease.
   */
  forgetEnv?: () => void
  run?: InstallCommandRunner
  /** The Node version in that environment, for the fingerprint; `readNodeVersion` unless a test stands in. */
  nodeVersion?: (env: NodeJS.ProcessEnv) => Promise<string | null>
  /** Sent as an install starts, while it runs, and as it ends. */
  onChange?: (view: WorktreeDependencyInstallView) => void
  gitDir?: (worktreePath: string) => Promise<string | null>
  /** Clears a slot's record before its install; `rm` unless a test stands in. */
  clearRecord?: (recordPath: string) => Promise<void>
  now?: () => number
  timeoutMs?: number
  log?: (line: string) => void
}

export type DependencyInstallInput = {
  repoRoot: string
  path: string
  branch: string
  setting: WorktreeDependencyInstallSetting | null
  /** Shown by its caller rather than toasted (`WorktreeDependencyInstallView.quiet`). */
  quiet?: boolean
}

export type DependencyInstaller = ReturnType<typeof createDependencyInstaller>

type RunningInstall = {
  view: WorktreeDependencyInstallView
  abort: AbortController
  settled: Promise<WorktreeDependencyInstallView>
}

export function createDependencyInstaller(deps: DependencyInstallerDeps) {
  const run = deps.run ?? runInstallCommand
  const nodeVersion = deps.nodeVersion ?? readNodeVersion
  const gitDir = deps.gitDir ?? worktreeGitDir
  const clearRecord = deps.clearRecord ?? ((recordPath: string) => rm(recordPath, { force: true }))
  const now = deps.now ?? Date.now
  const timeoutMs = deps.timeoutMs ?? DEPENDENCY_INSTALL_TIMEOUT_MS
  const log = deps.log ?? ((line: string) => console.info(`[worktree-install] ${line}`))
  const running = new Map<string, RunningInstall>()
  // How the last few ended, for a caller that started one without waiting
  // (`start`) and asks after it ended (`settled`).
  const ended = new Map<string, WorktreeDependencyInstallView>()
  let quitting = false

  /**
   * Plan an install for a just-leased worktree and, when it needs one, start
   * it. Answers once it is running (or once it is clear that nothing runs),
   * with how it ends as a promise beside it. Never throws.
   */
  async function start(
    input: DependencyInstallInput,
  ): Promise<{ view: WorktreeDependencyInstallView; settled: Promise<WorktreeDependencyInstallView> } | null> {
    if (quitting) return null
    const adminDir = await gitDir(input.path).catch(() => null)
    const recordPath = adminDir ? join(adminDir, DEPENDENCY_INSTALL_RECORD) : null
    // Asked once, and only when the plan gets as far as needing it: the
    // environment is a login shell's, which costs a process start unless
    // `deps.env` still keeps one from a lease a moment ago.
    let env: Promise<NodeJS.ProcessEnv> | null = null
    const installEnv = () => (env ??= deps.env())
    const plan = await planDependencyInstall({
      worktreePath: input.path,
      setting: input.setting,
      recordPath,
      nodeVersion: async () => nodeVersion(await installEnv()),
    }).catch((error: unknown) => {
      log(`${input.path}: could not tell whether to install: ${error instanceof Error ? error.message : error}`)
      return { run: false, why: 'nothing-to-install' } as const
    })
    if (!plan.run) {
      if (plan.why !== 'off') log(`${input.path}: no install (${plan.why})`)
      return null
    }
    if (quitting) return null

    // Cleared first: from here until it succeeds, the slot has not installed.
    // A record that cannot be cleared would vouch for whatever half an install
    // left behind if this one is stopped, so then nothing runs at all.
    if (recordPath) {
      const cleared = await clearRecord(recordPath).then(
        () => true,
        (error: unknown) => {
          log(`${input.path}: not installing, the last install's record could not be cleared: ${String(error)}`)
          return false
        },
      )
      if (!cleared) return null
      // The quit began while the record was being cleared: nothing starts on
      // the way out. The record is gone, so the next lease installs.
      if (quitting) return null
    }

    const view: WorktreeDependencyInstallView = {
      id: randomUUID(),
      repoRoot: input.repoRoot,
      path: input.path,
      branch: input.branch,
      command: plan.command,
      reason: plan.reason,
      state: 'running',
      startedAt: now(),
      endedAt: null,
      lastLine: null,
      output: null,
      exitCode: null,
      ...(input.quiet ? { quiet: true } : {}),
    }
    const abort = new AbortController()
    const emit = () => deps.onChange?.({ ...view })
    log(`${input.path}: ${plan.command} (${plan.reason})`)
    emit()
    const settled = runPlanned(input, plan, view, abort, recordPath, installEnv, emit)
    running.set(view.id, { view, abort, settled })
    return { view: { ...view }, settled }
  }

  async function runPlanned(
    input: DependencyInstallInput,
    plan: Extract<DependencyInstallPlan, { run: true }>,
    view: WorktreeDependencyInstallView,
    abort: AbortController,
    recordPath: string | null,
    installEnv: () => Promise<NodeJS.ProcessEnv>,
    emit: () => void,
  ): Promise<WorktreeDependencyInstallView> {
    let output = ''
    let pending: ReturnType<typeof setTimeout> | null = null
    const onOutput = (chunk: string) => {
      output = (output + chunk).slice(-OUTPUT_TAIL_CHARS)
      view.lastLine = lastLineOf(output) ?? view.lastLine
      pending ??= setTimeout(() => {
        pending = null
        if (view.state === 'running' && !quitting) emit()
      }, PROGRESS_INTERVAL_MS)
    }

    let outcome: InstallRunOutcome
    try {
      outcome = await run({
        command: plan.command,
        cwd: input.path,
        env: await installEnv(),
        timeoutMs,
        signal: abort.signal,
        onOutput,
      })
    } catch (error) {
      outcome = {
        code: null,
        timedOut: false,
        cancelled: abort.signal.aborted,
        error: error instanceof Error ? error.message : String(error),
      }
    } finally {
      if (pending) clearTimeout(pending)
    }

    view.endedAt = now()
    view.exitCode = outcome.code
    view.state =
      outcome.cancelled || abort.signal.aborted
        ? 'cancelled'
        : outcome.timedOut
          ? 'timed-out'
          : outcome.code === 0 && !outcome.error
            ? 'succeeded'
            : 'failed'
    // Only a finished install is written down. One the quit stopped is not,
    // even when its manager happened to exit 0 on the way out: what it left
    // is not known to be whole, and the next lease installs again.
    if (view.state === 'succeeded') {
      if (recordPath) {
        const record: InstallRecord = { fingerprint: plan.fingerprint, command: plan.command, installedAt: now() }
        await writeFile(recordPath, `${JSON.stringify(record)}\n`).catch((error: unknown) =>
          log(`${input.path}: installed, but could not record it: ${error instanceof Error ? error.message : error}`),
        )
      }
    } else {
      view.output = [ansiPlainText(output).trim(), outcome.error].filter(Boolean).join('\n') || null
      if (view.state === 'failed' || view.state === 'timed-out') deps.forgetEnv?.()
    }
    running.delete(view.id)
    ended.set(view.id, { ...view })
    while (ended.size > SETTLED_KEPT) ended.delete(ended.keys().next().value!)
    log(`${input.path}: ${plan.command} ${view.state} in ${Math.round((view.endedAt - view.startedAt) / 1000)} s`)
    // The windows are closing with the app: a "cancelled, the agent started
    // without it" toast would be the last thing they say, and untrue.
    if (!quitting) emit()
    return { ...view }
  }

  /**
   * Install in a just-leased worktree if it needs it, and wait for it. Null
   * when nothing ran. Never throws: whatever happens here, the lease stands.
   */
  async function prepare(input: DependencyInstallInput): Promise<WorktreeDependencyInstallView | null> {
    const started = await start(input)
    return started ? started.settled : null
  }

  /**
   * How an install `start` began ends: its last view once it has, null for an
   * id this installer does not know, and null while the app quits, when
   * nothing should start because of it.
   */
  async function settled(id: string): Promise<WorktreeDependencyInstallView | null> {
    const view = (await running.get(id)?.settled) ?? ended.get(id) ?? null
    return quitting ? null : view
  }

  /** Stop a running install; the agent then starts as after a failed one. */
  function cancel(id: string): boolean {
    const entry = running.get(id)
    if (!entry) return false
    entry.abort.abort()
    return true
  }

  /** The installs running now, for a window that opens while one does. */
  function list(): WorktreeDependencyInstallView[] {
    return [...running.values()].map((entry) => ({ ...entry.view }))
  }

  /** One install as it is now: running, with its last line, or as it ended; null when unknown. */
  function find(id: string): WorktreeDependencyInstallView | null {
    const live = running.get(id)?.view ?? ended.get(id)
    return live ? { ...live } : null
  }

  /**
   * The app is quitting: start nothing more, and stop every install running,
   * the whole process tree of each (`runInstallCommand` starts it as a group
   * of its own, and on Windows `taskkill /T` walks it), so no package manager
   * outlives the app. None of them is recorded, so each runs again at its
   * worktree's next lease. Waits a moment for them to let go.
   */
  async function shutdown(options: { waitMs?: number } = {}): Promise<void> {
    quitting = true
    const stopping = [...running.values()]
    for (const entry of stopping) entry.abort.abort()
    if (stopping.length === 0) return
    log(`stopping ${stopping.length} install(s) for the quit`)
    let timer: ReturnType<typeof setTimeout> | undefined
    await Promise.race([
      Promise.allSettled(stopping.map((entry) => entry.settled)),
      new Promise<void>((resolve) => {
        timer = setTimeout(resolve, options.waitMs ?? SHUTDOWN_WAIT_MS)
      }),
    ])
    clearTimeout(timer)
  }

  return { start, prepare, settled, cancel, list, find, shutdown }
}

let active: DependencyInstaller | null = null

/** The installer leased worktrees go through (the desktop's main); none elsewhere. */
export function installDependencyInstaller(installer: DependencyInstaller | null): void {
  active = installer
}

export function activeDependencyInstaller(): DependencyInstaller | null {
  return active
}

/**
 * An install a caller in main started without waiting for it
 * (`createGitWorktree` with `dependencyInstall: 'start'`), as that caller
 * follows it: where it is now, and how it ends.
 */
export type StartedDependencyInstall = {
  /** The install as it started. */
  view: WorktreeDependencyInstallView
  /** The install as it is now: its last line while it runs, its end once it has. */
  current: () => WorktreeDependencyInstallView
  /** How it ended; null when the app is quitting, and nothing should start because of it. */
  settled: Promise<WorktreeDependencyInstallView | null>
}

/** The started install behind a worktree's running view, followed through the active installer; null when none runs. */
export function startedDependencyInstall(
  view: WorktreeDependencyInstallView | null | undefined,
): StartedDependencyInstall | null {
  const installer = active
  if (!view || view.state !== 'running' || !installer) return null
  return { view, current: () => installer.find(view.id) ?? view, settled: installer.settled(view.id) }
}
