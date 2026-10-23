// Which file to start when the app runs git.
//
// Everywhere but Windows and macOS that is `git`, and the OS finds it. On
// Windows the git that Git for Windows' installer puts on PATH is `<Git>\cmd\git.exe` (the
// portable build's is `<Git>\bin\git.exe`), and that is not git: it is a small
// launcher that sets up the environment and starts the real binary under
// `<Git>\<build>\bin\`. Every git command the app runs through it costs a
// second process, and the app runs a lot of them — every view that shows a
// branch, a diff or a status polls one. Starting the real binary directly
// skips that process. It loses nothing when MSYSTEM is unset: the real git.exe
// then sets HOME and puts its own folders on PATH itself, which is what hooks
// (`#!/bin/sh`), ssh and credential helpers need. When MSYSTEM is set (git
// started from a Git Bash or MSYS2 shell) it adds those folders only if they
// are already there, so the launcher stays.
//
// On a Mac without a git of its own first on PATH (Homebrew's, Nix's), `git`
// is /usr/bin/git, and that is not git either: it is a shim that asks xcrun
// for the active developer folder on every run and then starts the git in it,
// about 9 ms a spawn against 2.5 ms for that git started directly. The git
// behind the shim is asked of `xcrun --find git` once, in the background, which
// honours DEVELOPER_DIR and the `xcode-select` choice the way the shim does;
// until it answers, and whenever it cannot, the shim runs as before. That git
// finds its helpers, templates and system config relative to its own folder,
// so starting it directly changes none of them. What it does not do is add
// the variables the shim adds for its children (SDKROOT, CPATH, LIBRARY_PATH,
// MANPATH), which a hook only notices if it compiles against /usr/local with a
// compiler that is not itself an xcrun shim.

import { execFile } from 'node:child_process'
import { readlinkSync } from 'node:fs'
import { stat } from 'node:fs/promises'
import { posix, win32 } from 'node:path'

import { resolveWindowsProgramOnPath } from './command-on-path'

// Git for Windows 2.56 moved x64 builds from mingw64 to ucrt64; ARM64 builds
// live in clangarm64 and 32-bit ones in mingw32. The newest layout is asked
// first, since an upgrade that left an old folder behind runs the new build.
const GIT_FOR_WINDOWS_BUILDS = ['ucrt64', 'clangarm64', 'mingw64', 'mingw32'] as const

const MACOS_GIT_SHIM = '/usr/bin/git'
// Where `xcode-select -s` records its choice; the shim reads it on every run.
const XCODE_SELECT_LINK = '/var/db/xcode_select_link'
const XCRUN_TIMEOUT_MS = 5_000

export type GitExecutableDeps = {
  /** True when `path` is an existing regular file. */
  isFile?: (path: string) => Promise<boolean>
  /** What `xcrun --find git` prints for a child with `env`, or null when it fails. */
  findXcodeGit?: (env: NodeJS.ProcessEnv) => Promise<string | null>
  /** Where `xcode-select` points now, or null when it points nowhere. Read before every spawn on macOS. */
  xcodeSelection?: () => string | null
}

async function isFileOnDisk(path: string): Promise<boolean> {
  try {
    return (await stat(path)).isFile()
  } catch {
    return false
  }
}

/**
 * The PATH a child given `env` would search. A copy of `process.env` on
 * Windows keeps the variable's own spelling, which is usually `Path`.
 */
function pathValueOf(env: NodeJS.ProcessEnv): string {
  if (env.PATH !== undefined) return env.PATH
  if (env.Path !== undefined) return env.Path
  for (const [key, value] of Object.entries(env)) if (key.toUpperCase() === 'PATH' && value !== undefined) return value
  return ''
}

/**
 * The git a Windows child with `env` should start: the real git.exe behind Git
 * for Windows' launcher when the git found first on PATH is that launcher,
 * otherwise plain `git`, leaving the lookup to the OS as before.
 */
export async function resolveGitForWindows(env: NodeJS.ProcessEnv, deps: GitExecutableDeps = {}): Promise<string> {
  if (env.MSYSTEM) return 'git'
  const isFile = deps.isFile ?? isFileOnDisk
  const found = await resolveWindowsProgramOnPath('git', { pathValue: pathValueOf(env), exists: isFile })
  if (found === null || win32.basename(found).toLowerCase() !== 'git.exe') return 'git'
  const launcherDirectory = win32.dirname(found)
  const launcherFolder = win32.basename(launcherDirectory).toLowerCase()
  if (launcherFolder !== 'cmd' && launcherFolder !== 'bin') return 'git'
  const installRoot = win32.dirname(launcherDirectory)
  for (const build of GIT_FOR_WINDOWS_BUILDS) {
    const candidate = win32.join(installRoot, build, 'bin', 'git.exe')
    if (await isFile(candidate)) return candidate
  }
  return 'git'
}

function findXcodeGitWithXcrun(env: NodeJS.ProcessEnv): Promise<string | null> {
  return new Promise((resolve) => {
    execFile(
      '/usr/bin/xcrun',
      ['--find', 'git'],
      { encoding: 'utf8', env, timeout: XCRUN_TIMEOUT_MS },
      (error, stdout) => resolve(error ? null : stdout.trim() || null),
    )
  })
}

function readXcodeSelection(): string | null {
  try {
    return readlinkSync(XCODE_SELECT_LINK)
  } catch {
    return null
  }
}

/**
 * The first `git` a macOS child with `env` would find on PATH, or null when
 * that cannot be known here: an empty or relative entry is the child's
 * working directory, which differs from one command to the next.
 */
async function firstGitOnPosixPath(
  pathValue: string,
  isFile: (path: string) => Promise<boolean>,
): Promise<string | null> {
  if (pathValue === '') return null
  for (const directory of pathValue.split(posix.delimiter)) {
    if (!posix.isAbsolute(directory)) return null
    const candidate = posix.join(directory, 'git')
    if (await isFile(candidate)) return candidate
  }
  return null
}

/**
 * The git a macOS child with `env` should start: the one behind the xcrun shim
 * when the git found first on PATH is the shim, otherwise plain `git`, leaving
 * the lookup to the OS as before. Any failure answers `git`.
 */
export async function resolveGitForMacos(env: NodeJS.ProcessEnv, deps: GitExecutableDeps = {}): Promise<string> {
  const isFile = deps.isFile ?? isFileOnDisk
  if ((await firstGitOnPosixPath(pathValueOf(env), isFile)) !== MACOS_GIT_SHIM) return 'git'
  const found = await (deps.findXcodeGit ?? findXcodeGitWithXcrun)(env)
  if (found === null || !posix.isAbsolute(found) || posix.basename(found) !== 'git' || found === MACOS_GIT_SHIM) {
    return 'git'
  }
  return (await isFile(found)) ? found : 'git'
}

// One lookup per PATH (and MSYSTEM) for the life of the process: the scan
// stats a file in every PATH folder, which would otherwise run before every
// git command. PATH rarely differs between callers, so the map stays tiny; the
// cap only bounds a caller that builds a new PATH per command.
const MAX_REMEMBERED_PATHS = 8
const remembered = new Map<string, Promise<string>>()

function rememberedGitForWindows(env: NodeJS.ProcessEnv, deps: GitExecutableDeps): Promise<string> {
  const key = `${env.MSYSTEM ? 'msystem' : ''}\0${pathValueOf(env)}`
  const known = remembered.get(key)
  if (known) return known
  if (remembered.size >= MAX_REMEMBERED_PATHS) remembered.clear()
  const lookup = resolveGitForWindows(env, deps)
  remembered.set(key, lookup)
  return lookup
}

// On macOS the answer is kept as a value rather than a promise, so a spawn
// never waits on xcrun: one made before the lookup is done runs the shim. It is
// kept per PATH and DEVELOPER_DIR, and dropped when `xcode-select` has since
// pointed elsewhere, which the shim would have followed at once.
type MacosGit = { file: string | null; selection: string | null }
const rememberedMacos = new Map<string, MacosGit>()

function rememberedGitForMacos(env: NodeJS.ProcessEnv, deps: GitExecutableDeps): string {
  const key = `${env.DEVELOPER_DIR ?? ''}\0${pathValueOf(env)}`
  const selection = (deps.xcodeSelection ?? readXcodeSelection)()
  const known = rememberedMacos.get(key)
  if (known && known.selection === selection) return known.file ?? 'git'
  if (rememberedMacos.size >= MAX_REMEMBERED_PATHS) rememberedMacos.clear()
  const entry: MacosGit = { file: null, selection }
  rememberedMacos.set(key, entry)
  void resolveGitForMacos(env, deps).then(
    (file) => {
      entry.file = file
    },
    () => {
      entry.file = 'git'
    },
  )
  return 'git'
}

/** Forgets every remembered lookup. For tests, and for a binary that went missing. */
export function forgetGitExecutable(): void {
  remembered.clear()
  rememberedMacos.clear()
}

/**
 * Runs `start` with the git file to spawn for a child with `env`. `start` is
 * called synchronously off Windows, so a caller that spawns there sees no
 * change in timing.
 *
 * The lookup is remembered, so a Git for Windows upgrade that moves the real
 * binary (2.56 moved mingw64 to ucrt64), or an Xcode update or removal, would
 * leave a path that no longer exists. When the remembered binary could not be
 * started, `start` runs once more — with the lookup made again on Windows, and
 * with the shim on macOS — since a process that never started has done
 * nothing that a second attempt could repeat. `didNotStart` reads that from a
 * result, for runners that report a failed spawn instead of throwing; a thrown
 * ENOENT always counts.
 */
export async function withGitExecutable<T>(
  env: NodeJS.ProcessEnv,
  start: (file: string) => Promise<T>,
  options: { didNotStart?: (result: T) => boolean; platform?: NodeJS.Platform } & GitExecutableDeps = {},
): Promise<T> {
  const platform = options.platform ?? process.platform
  if (platform === 'darwin')
    return startRemembered(rememberedGitForMacos(env, options), start, options, async () => 'git')
  if (platform !== 'win32') return start('git')
  return startRemembered(await rememberedGitForWindows(env, options), start, options, () =>
    rememberedGitForWindows(env, options),
  )
}

/** Starts the remembered `file`, and `fallback()`'s answer once more if it could not be started. */
async function startRemembered<T>(
  file: string,
  start: (file: string) => Promise<T>,
  options: { didNotStart?: (result: T) => boolean },
  fallback: () => Promise<string>,
): Promise<T> {
  if (file === 'git') return start(file)
  let result: T
  try {
    result = await start(file)
  } catch (error) {
    if ((error as NodeJS.ErrnoException | null)?.code !== 'ENOENT') throw error
    forgetGitExecutable()
    return start(await fallback())
  }
  if (!options.didNotStart?.(result)) return result
  forgetGitExecutable()
  return start(await fallback())
}
