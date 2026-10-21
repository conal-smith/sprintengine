// THE `gh` runner for the whole main process (epic `pull-request-marks`,
// decision 11). Every GitHub read and write this app makes goes through the
// GitHub CLI — never REST — so that gh's own credential store is the single
// auth source and GitHub Enterprise Server hosts come free.
//
// It lives here, in a neutral module, because it used to live inside the review
// provider while a second, weaker spawner sat in `automations/pull-request.ts`.
// The two were not equivalent: only this one looks gh up on the user's login
// shell PATH, and a GUI-launched app on macOS does not inherit the shell PATH, so a
// Homebrew or nvm `gh` was invisible to the weaker one — which reported "no
// pull request" for a pull request that was plainly there. One runner, one
// answer.
//
// THE `found` FLAG IS THE POINT. `found: false` means the binary itself is
// absent; anything else is gh having run and having an opinion. A caller that
// writes an answer down must tell those apart: "there is no pull request" and
// "I could not ask" are different facts, and only the first may be recorded.

import { execFile } from 'node:child_process'
import { delimiter } from 'node:path'
import { promisify } from 'node:util'

import { resolveWindowsProgramOnPath } from '../command-on-path'
import { gitSafetyEnv } from '../git-run'
import {
  createLoginShellPathResolver,
  findExecutable,
  searchDirectories,
  sharedLoginShellPath,
  type LoginShellPathResolver,
} from '../login-shell-path'

const execFileAsync = promisify(execFile)

/**
 * Cap on what one `gh` call may return. A pull request diff is the biggest
 * thing we ask for; the review provider rejects anything over its own
 * `MAX_PATCH_BYTES` after the fact, so this only has to be comfortably larger
 * than that (it matches the automations spawner's old buffer, so moving that
 * call site onto this runner cannot shrink what it could read).
 */
export const GH_MAX_BUFFER_BYTES = 20 * 1024 * 1024

export interface GhResult {
  found: boolean // false only when the gh binary itself is absent
  code: number
  stdout: string
  stderr: string
  /**
   * The child was killed because it outlived {@link GhRunOptions.timeoutMs}.
   * A caller that records answers must read this as "I could not ask" and never
   * as an empty result — it is the offline/hung case, not a fact about GitHub.
   */
  timedOut?: boolean
}

/** Per-call options. `cwd` is what lets a repository-scoped read (`gh pr list`
 *  in a checkout) share the runner with the repo-argument reads. */
export interface GhRunOptions {
  cwd?: string
  /**
   * How long the child may run before it is KILLED. Without it a caller that
   * merely stops waiting (a `Promise.race` against a timer) leaves a `gh`
   * running behind every abandoned read, so a hover on an unreachable host
   * leaks one process per probe. Passed straight to `execFile`'s own `timeout`/`killSignal`, so the
   * process table is what enforces it.
   */
  timeoutMs?: number
  /**
   * Variables gh must NOT see, removed from the child's environment. gh is
   * always spawned itself, never through a shell that would source the
   * person's rc files (exactly where a token export lives) and set them
   * again. Only fixed variable names belong here, never a value.
   */
  unsetEnv?: readonly string[]
  /**
   * Variables set for the child on top of its environment, such as a CLI's
   * own "never prompt" switch. Fixed names and fixed values only, never a
   * token: anything here is visible to every process the CLI starts.
   */
  setEnv?: Readonly<Record<string, string>>
}

export interface GhRunner {
  available(): Promise<boolean>
  run(args: string[], options?: GhRunOptions): Promise<GhResult>
}

/** The one spawn this module makes, behind a seam so tests never touch a real `gh`. */
export type GhSpawn = (
  file: string,
  args: string[],
  options: {
    cwd?: string
    maxBuffer: number
    windowsHide: boolean
    env: NodeJS.ProcessEnv
    /** `execFile`'s own timeout: the child is signalled, not merely abandoned. */
    timeout?: number
    killSignal?: NodeJS.Signals
  },
) => Promise<{ stdout: string; stderr: string }>

export type GhRunnerEnvironment = {
  /**
   * The host CLI this runner drives: `gh` by default. GitLab's `glab` and
   * Gitea's `tea` are found and spawned exactly as gh is (the login-shell
   * PATH on macOS and Linux, the resolved `.exe` on Windows), so the chat's
   * Create PR reaches them however they were installed.
   */
  binary?: string
  spawn?: GhSpawn
  /** `process.env.SHELL` by default; the person's shell, asked once for its PATH. */
  shell?: string | undefined
  platform?: NodeJS.Platform
  /** Where `gh` is on Windows; {@link resolveWindowsProgramOnPath} by default. */
  resolveWindowsProgram?: (name: string) => Promise<string | null>
  /** Where a binary is among directories; {@link findExecutable} by default. */
  findExecutable?: (binary: string, directories: string[]) => Promise<string | null>
}

export type DefaultGhRunner = GhRunner & {
  /** Forget where gh was found, and the login PATH it was found on: the next call looks again. */
  forgetLocation(): void
}

/** Where gh was found off the app's PATH, and the PATH to run it with. */
type GhLocation = { file: string; path: string }

// Default gh runner: a direct spawn, and — when the binary is not on the app's
// PATH — gh looked up on the PATH the person's own shell has. A GUI-launched
// app on macOS does not inherit that PATH, so a Homebrew or nvm `gh` is
// invisible to a bare spawn. The shell is asked for its PATH once (the same
// lookup CLI detection makes, login-shell-path.ts), gh's absolute path is
// remembered, and every call after spawns it directly: a `$SHELL -ilc 'gh …'`
// per call sourced the person's rc files on every pull request read.
export function createDefaultGhRunner(environment: GhRunnerEnvironment = {}): DefaultGhRunner {
  const spawn: GhSpawn =
    environment.spawn ??
    ((file, args, options) => execFileAsync(file, args, options) as Promise<{ stdout: string; stderr: string }>)
  const shell = environment.shell !== undefined ? environment.shell : process.env.SHELL
  const platform = environment.platform ?? process.platform
  const resolveWindowsProgram = environment.resolveWindowsProgram ?? ((name) => resolveWindowsProgramOnPath(name))
  const find = environment.findExecutable ?? findExecutable
  const binary = environment.binary ?? 'gh'
  // The process's one login-shell lookup, shared with CLI detection: a second
  // shell would only print the same PATH again. A runner given its own spawn or
  // shell asks that shell through that spawn instead, so a test sees every
  // process it starts.
  const loginShellPath =
    environment.spawn || environment.shell !== undefined ? ownLoginShellPath(spawn, shell) : sharedLoginShellPath()
  let located: Promise<GhLocation | null> | null = null

  const runFile = async (file: string, args: string[], options: GhRunOptions, path?: string): Promise<GhResult> => {
    try {
      const { stdout, stderr } = await spawn(file, args, {
        ...(options.cwd ? { cwd: options.cwd } : {}),
        ...spawnTimeout(options),
        maxBuffer: GH_MAX_BUFFER_BYTES,
        windowsHide: true,
        env: { ...ghEnv(options), ...(path ? { PATH: path } : {}) },
      })
      return { found: true, code: 0, stdout, stderr }
    } catch (error) {
      return resultFromSpawnError(error)
    }
  }
  // Where the binary is on Windows, with the PATH it was found on. The lookup
  // checks for a file in every PATH folder, so it is made once per PATH, not
  // once per call. "Not found" is never kept: a CLI installed since is seen on
  // the next call.
  let windowsProgram: { pathValue: string; file: string } | null = null
  const resolveOnWindowsPath = async (): Promise<{ file: string; remembered: boolean } | null> => {
    const pathValue = process.env.PATH ?? process.env.Path ?? ''
    if (windowsProgram?.pathValue === pathValue) return { file: windowsProgram.file, remembered: true }
    const file = await resolveWindowsProgram(binary)
    windowsProgram = file ? { pathValue, file } : null
    return file ? { file, remembered: false } : null
  }
  const runDirect = async (args: string[], options: GhRunOptions): Promise<GhResult> => {
    // On Windows a bare `gh` would be looked for in `cwd` — the repository —
    // before PATH, so a `gh.exe` a repository ships would run in its place. The
    // program is resolved on PATH and spawned by its full path instead, and a
    // PATH with no `gh` on it is "not installed" rather than a bare-name spawn.
    if (platform !== 'win32') return runFile(binary, args, options)
    const resolved = await resolveOnWindowsPath()
    if (!resolved) return { found: false, code: -1, stdout: '', stderr: '' }
    const result = await runFile(resolved.file, args, options)
    if (result.found || !resolved.remembered) return result
    // Uninstalled or moved since it was remembered. A process that never
    // started did nothing, so looking again and running once more is safe.
    windowsProgram = null
    const again = await resolveOnWindowsPath()
    return again ? runFile(again.file, args, options) : result
  }
  /**
   * gh on the person's shell PATH, looked up once and shared by every
   * concurrent caller. "Not found" is not kept, but the PATH it was looked
   * for on is (login-shell-path.ts), so looking again walks directories and
   * starts no shell.
   */
  const locate = (): Promise<GhLocation | null> => {
    if (located) return located
    const pending = (async (): Promise<GhLocation | null> => {
      const loginPath = await loginShellPath.resolve(process.env)
      const directories = searchDirectories(loginPath, process.env.PATH)
      const file = await find(binary, directories)
      // Run with the PATH it was found on, so the git and credential helpers
      // gh starts are the ones a terminal would give it.
      return file ? { file, path: directories.join(delimiter) } : null
    })().catch(() => null)
    located = pending
    void pending.then((found) => {
      if (!found && located === pending) located = null
    })
    return pending
  }
  const run = async (args: string[], options: GhRunOptions = {}): Promise<GhResult> => {
    const known = located ? await located : null
    if (known) {
      const result = await runFile(known.file, args, options, known.path)
      if (result.found) return result
      // Moved or uninstalled since: look again below.
      located = null
    }
    const direct = await runDirect(args, options)
    if (direct.found || (platform !== 'darwin' && platform !== 'linux')) return direct
    const found = await locate()
    return found ? runFile(found.file, args, options, found.path) : direct
  }
  return {
    run,
    async available() {
      const result = await run(['--version'])
      return result.found && result.code === 0
    },
    forgetLocation() {
      located = null
      windowsProgram = null
      loginShellPath.invalidate()
    },
  }
}

/** A login-shell lookup that starts its shells through `spawn`. */
function ownLoginShellPath(spawn: GhSpawn, shell: string | undefined): LoginShellPathResolver {
  return createLoginShellPathResolver({
    run: async (descriptor, env) => {
      try {
        const { stdout } = await spawn(descriptor.file, descriptor.args, {
          maxBuffer: GH_MAX_BUFFER_BYTES,
          windowsHide: true,
          env,
          timeout: descriptor.timeoutMs,
          killSignal: 'SIGTERM',
        })
        return { code: 0, stdout, timedOut: false }
      } catch (error) {
        const result = resultFromSpawnError(error)
        return { code: result.code, stdout: result.stdout, timedOut: result.timedOut === true }
      }
    },
    shell: () => shell,
  })
}

/** The child's environment: the git-safe one, less anything the caller unset. */
function ghEnv(options: GhRunOptions): NodeJS.ProcessEnv {
  const env = gitSafetyEnv(process.env, options.cwd)
  for (const name of options.unsetEnv ?? []) delete env[name]
  return { ...env, ...options.setEnv }
}

/** The kill terms for one call, or nothing at all when the caller set no bound. */
function spawnTimeout(options: GhRunOptions): { timeout?: number; killSignal?: NodeJS.Signals } {
  const timeoutMs = options.timeoutMs
  if (typeof timeoutMs !== 'number' || !Number.isFinite(timeoutMs) || timeoutMs <= 0) return {}
  return { timeout: Math.round(timeoutMs), killSignal: 'SIGTERM' }
}

function resultFromSpawnError(error: unknown): GhResult {
  const err = error as { code?: string | number; killed?: boolean; signal?: string; stdout?: string; stderr?: string }
  if (err.code === 'ENOENT') return { found: false, code: -1, stdout: '', stderr: '' }
  // `execFile` reports its own timeout as a killed child (`killed: true`, and a
  // signal rather than an exit code). The binary was found and run, so this is
  // never `found: false`; it is a read that did not happen.
  const timedOut = err.killed === true || (typeof err.signal === 'string' && err.signal.length > 0)
  return {
    found: true,
    code: typeof err.code === 'number' ? err.code : 1,
    stdout: err.stdout ?? '',
    stderr: err.stderr ?? '',
    ...(timedOut ? { timedOut: true } : {}),
  }
}

/**
 * The shared runner every main-process caller uses. One process-wide instance
 * per binary so "one runner" is literally true — a second
 * `createDefaultGhRunner()` in a call site would be a second spawner's worth
 * of drift waiting to happen.
 */
const shared = new Map<string, DefaultGhRunner>()

export function sharedGhRunner(): GhRunner {
  return sharedHostCliRunner('gh')
}

/**
 * The shared runner for another forge's CLI, `glab` or `tea`: found, cached
 * and spawned as gh is. Only these fixed names ever reach it.
 */
export function sharedHostCliRunner(binary: 'gh' | 'glab' | 'tea'): GhRunner {
  let runner = shared.get(binary)
  if (!runner) {
    runner = createDefaultGhRunner({ binary })
    shared.set(binary, runner)
  }
  return runner
}

/**
 * Forget where the shared runners found gh, glab and tea. Called with the
 * app's forced re-check of the CLIs (an install, an update, Settings'
 * refresh), which is when a CLI installed or moved from a terminal should be
 * seen.
 */
export function forgetSharedGhLocation(): void {
  for (const runner of shared.values()) runner.forgetLocation()
}
