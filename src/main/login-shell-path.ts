import { constants } from 'node:fs'
import { access, stat } from 'node:fs/promises'
import { delimiter, isAbsolute, join, resolve } from 'node:path'

import type { PluginInstallPlatform } from '../shared/plugin-manifest'
import { runSpawnDescriptor } from './process-run'

/**
 * The PATH a person's own terminal would have, resolved once, and binary lookup
 * against it done in this process.
 *
 * Detecting whether an agent CLI is installed used to start a login shell per
 * CLI — `bash -lc`, then the person's own `$SHELL -ilc` for anything bash could
 * not see — and ask it `command -v`. With ten registered CLIs that is up to
 * twenty shells, each sourcing a `.zshrc` that may load nvm, on every refresh:
 * at boot, and again whenever the pickers asked after the cache ran out. The
 * only thing any of those shells contributed was their PATH, and a PATH does
 * not change between one CLI and the next. So one shell prints it, and every
 * lookup after that is a directory walk in this process.
 *
 * One resolver serves the whole process (`sharedLoginShellPath`). CLI
 * detection, the gh runner and the local-server runner each used to keep their
 * own, so one session started a shell per caller — three or four `$SHELL -ilc`
 * runs at boot, each loading the same `.zshrc` — to learn one PATH.
 *
 * The memo lives for the app session. It is dropped on a forced refresh (an
 * install or an explicit re-check in Settings), because an installer is exactly
 * the thing that appends a line to `~/.zshrc`, and the answer that follows it
 * must see the new directory. A failed resolution is never kept: the next
 * caller tries again rather than inheriting a PATH that is missing the person's
 * own entries for the rest of the session.
 *
 * Host POSIX only (macOS, Linux). WSL and Windows keep their shell probes.
 */

export type LoginShellPathDescriptor = { file: string; args: string[]; timeoutMs: number }

export type LoginShellPathOutcome = { code: number; stdout: string; timedOut: boolean }

/** Marks the line carrying the PATH, so rc-file chatter on stdout cannot be mistaken for it. */
export const LOGIN_PATH_SENTINEL = 'SPRINTENGINE_LOGIN_PATH:'

// A slow `.zshrc` must not wedge detection. The person's own interactive shell
// gets the shorter budget, because bash is still there behind it.
export const USER_SHELL_PATH_TIMEOUT_MS = 5_000
export const LOGIN_BASH_PATH_TIMEOUT_MS = 10_000

/** Marks a line carrying one of `LOGIN_SHELL_ENV_VARIABLES` as `NAME=value`. */
export const LOGIN_ENV_SENTINEL = 'SPRINTENGINE_LOGIN_ENV:'

/**
 * Certificate trust a person sets in their shell profile. Opened from Finder or
 * the Dock, the app never sees those exports, so an agent behind a proxy that
 * re-signs TLS, or a Node built against a shared OpenSSL with no roots of its
 * own, cannot verify its API or its registry, though the same CLI works in the
 * person's terminal. They are read from the same shell that answers for PATH.
 */
export const LOGIN_SHELL_TRUST_VARIABLES = ['SSL_CERT_FILE', 'SSL_CERT_DIR', 'NODE_EXTRA_CA_CERTS'] as const

/**
 * What a person exports in their shell profile to point an agent CLI at its
 * provider, lost the same way as the trust variables when the app is opened
 * from the Dock: Claude Code on Bedrock or Vertex and its model pins, the API
 * keys and endpoints of the other CLIs, the company proxy, the GitHub token an
 * agent's `gh` reads, and where Codex and OpenCode keep their config.
 *
 * A fixed list, not a pattern: nothing else in the profile is read. The values
 * are secrets as often as not, and are never logged.
 *
 * Left out on purpose: `ANTHROPIC_API_KEY`, `ANTHROPIC_AUTH_TOKEN` and
 * `ANTHROPIC_BASE_URL`. A Claude chat is subscription-auth by contract and its
 * provider strips all three from the child (`STRIPPED_ANTHROPIC_AUTH_ENV_KEYS`
 * in claude-agent-provider.ts); a base URL without the token that goes with it
 * would only send a terminal's `claude` to an endpoint it cannot sign in to.
 * A Codex chat strips `OPENAI_API_KEY` and `OPENAI_BASE_URL` the same way, so
 * those two reach terminals and the other CLIs, not a Codex chat.
 */
export const LOGIN_SHELL_PROVIDER_VARIABLES = [
  'ANTHROPIC_MODEL',
  'ANTHROPIC_DEFAULT_OPUS_MODEL',
  'ANTHROPIC_DEFAULT_SONNET_MODEL',
  'ANTHROPIC_DEFAULT_HAIKU_MODEL',
  'ANTHROPIC_DEFAULT_FABLE_MODEL',
  'CLAUDE_CODE_USE_BEDROCK',
  'CLAUDE_CODE_USE_VERTEX',
  'AWS_PROFILE',
  'AWS_REGION',
  'AWS_DEFAULT_REGION',
  'CLOUD_ML_REGION',
  'ANTHROPIC_VERTEX_PROJECT_ID',
  'GOOGLE_CLOUD_PROJECT',
  'GOOGLE_APPLICATION_CREDENTIALS',
  'OPENAI_BASE_URL',
  'OPENAI_API_KEY',
  'GEMINI_API_KEY',
  'GOOGLE_API_KEY',
  'XAI_API_KEY',
  'OPENROUTER_API_KEY',
  'HTTPS_PROXY',
  'HTTP_PROXY',
  'NO_PROXY',
  'https_proxy',
  'http_proxy',
  'no_proxy',
  'GH_TOKEN',
  'GITHUB_TOKEN',
  'CODEX_HOME',
  'OPENCODE_CONFIG',
] as const

/** Every variable the login shell is asked for besides PATH. */
export const LOGIN_SHELL_ENV_VARIABLES = [...LOGIN_SHELL_TRUST_VARIABLES, ...LOGIN_SHELL_PROVIDER_VARIABLES] as const

const PRINT_PATH_SCRIPT = [
  `printf '\\n%s%s\\n' '${LOGIN_PATH_SENTINEL}' "$PATH"`,
  ...LOGIN_SHELL_ENV_VARIABLES.map(
    (name) => `if [ -n "$${name}" ]; then printf '\\n%s%s=%s\\n' '${LOGIN_ENV_SENTINEL}' '${name}' "$${name}"; fi`,
  ),
].join('; ')

/**
 * True when `shell` is one whose own config can be asked for its PATH: a zsh or
 * bash on a host POSIX target. fish is left out because the script is POSIX sh
 * and fish would misparse it; Windows and WSL have no host user shell to ask.
 *
 * Exported because callers acting on a "not installed" verdict need to know
 * whether the person's own shell was consulted: without it, an absent binary may
 * simply be one a plain login bash cannot see.
 */
export function userShellProbeSupported(target: PluginInstallPlatform, shell: string | undefined): shell is string {
  if (target !== 'darwin' && target !== 'linux') return false
  const shellPath = shell?.trim()
  if (!shellPath) return false
  const shellName = shellPath.split('/').pop()
  return shellName === 'zsh' || shellName === 'bash'
}

/**
 * The shells to ask, in order. The person's own zsh/bash as an interactive
 * login shell first — `-i` so `~/.zshrc`, where PATH edits usually live, is
 * sourced exactly as a terminal tab sources it — then a plain login bash, which
 * is what every setup has.
 */
export function loginShellPathDescriptors(shell: string | undefined): LoginShellPathDescriptor[] {
  const plain: LoginShellPathDescriptor = {
    file: 'bash',
    args: ['-lc', PRINT_PATH_SCRIPT],
    timeoutMs: LOGIN_BASH_PATH_TIMEOUT_MS,
  }
  // The target is the host's by construction: this is never asked for WSL.
  if (!userShellProbeSupported('darwin', shell)) return [plain]
  return [{ file: shell.trim(), args: ['-ilc', PRINT_PATH_SCRIPT], timeoutMs: USER_SHELL_PATH_TIMEOUT_MS }, plain]
}

/** The PATH a shell printed, or null when it printed none. The LAST marked line wins. */
export function parseLoginShellPath(stdout: string): string | null {
  let found: string | null = null
  for (const rawLine of stdout.split(/\r?\n/)) {
    const line = rawLine.trim()
    if (line.startsWith(LOGIN_PATH_SENTINEL)) found = line.slice(LOGIN_PATH_SENTINEL.length).trim()
  }
  return found ? found : null
}

/**
 * The variables a shell printed, by name. The LAST marked line for a name wins,
 * as for PATH; a name outside `LOGIN_SHELL_ENV_VARIABLES` or an empty value is
 * ignored.
 */
export function parseLoginShellEnv(stdout: string): Record<string, string> {
  const found: Record<string, string> = {}
  const names: readonly string[] = LOGIN_SHELL_ENV_VARIABLES
  for (const rawLine of stdout.split(/\r?\n/)) {
    const line = rawLine.trim()
    if (!line.startsWith(LOGIN_ENV_SENTINEL)) continue
    const entry = line.slice(LOGIN_ENV_SENTINEL.length)
    const separator = entry.indexOf('=')
    if (separator <= 0) continue
    const name = entry.slice(0, separator)
    const value = entry.slice(separator + 1).trim()
    if (names.includes(name) && value) found[name] = value
  }
  return found
}

/**
 * `env` with each of `LOGIN_SHELL_ENV_VARIABLES` the login shell set and `env`
 * lacks. One the app was started with is the person's choice for this session
 * and is never replaced.
 */
export function withLoginShellEnv(
  env: Record<string, string>,
  loginEnv: Readonly<Record<string, string>>,
): Record<string, string> {
  let next = env
  for (const name of LOGIN_SHELL_ENV_VARIABLES) {
    const value = loginEnv[name]
    if (!value || env[name]) continue
    if (next === env) next = { ...env }
    next[name] = value
  }
  return next
}

/**
 * The directories to search, in order: the login shell's PATH, then anything on
 * the caller's own PATH it left out. The caller's PATH is the one the app hands
 * a probe (the managed runtime shims in front of the process PATH); a login
 * shell normally keeps it and prepends, but a profile that assigns PATH outright
 * would otherwise make a managed install invisible. Empty and relative entries
 * are dropped — POSIX reads an empty one as "the current directory", which for
 * this process is `/`, and nothing a person installed lives there.
 */
export function searchDirectories(loginPath: string | null, basePath: string | undefined): string[] {
  const directories: string[] = []
  const seen = new Set<string>()
  for (const source of [loginPath, basePath]) {
    for (const entry of (source ?? '').split(delimiter)) {
      if (!entry || !isAbsolute(entry) || seen.has(entry)) continue
      seen.add(entry)
      directories.push(entry)
    }
  }
  return directories
}

/**
 * Where a person's own package managers put binaries, by host: Homebrew on
 * Apple silicon and Intel Macs (and Linuxbrew), and the conventional local
 * prefix. A Mac app opened from Finder or the Dock inherits launchd's PATH,
 * `/usr/bin:/bin:/usr/sbin:/sbin`, which has none of them — so an agent's shell
 * could not find `npx`, `gh` or `brew` itself, though the person's terminal
 * could. These stand in for the login shell's PATH until one has answered, and
 * for a session where none ever does.
 */
export const USER_BIN_DIRECTORY_FALLBACKS: Readonly<Partial<Record<NodeJS.Platform, readonly string[]>>> = {
  darwin: ['/opt/homebrew/bin', '/opt/homebrew/sbin', '/usr/local/bin', '/usr/local/sbin'],
  linux: ['/home/linuxbrew/.linuxbrew/bin', '/home/linuxbrew/.linuxbrew/sbin', '/usr/local/bin', '/usr/local/sbin'],
}

/**
 * `env` with the PATH a person's own terminal would have: the login shell's
 * PATH when one has answered (`lastKnownLoginShellPath`), then whatever only
 * the app's own PATH has, then any of `USER_BIN_DIRECTORY_FALLBACKS` that
 * exists and is still missing. This is what every terminal and agent the app
 * starts inherits, so an agent's shell can run what the person's can.
 *
 * Host macOS and Linux only; Windows and WSL keep the PATH they were given.
 * Nothing is removed: an entry the app's PATH has and the login shell's lacks
 * (the managed runtime's shims) keeps its place after the login entries.
 */
export function withUserShellPath(
  env: Record<string, string>,
  options: { platform: NodeJS.Platform; loginPath: string | null; exists: (directory: string) => boolean },
): Record<string, string> {
  const fallbacks = USER_BIN_DIRECTORY_FALLBACKS[options.platform]
  if (!fallbacks) return env
  const directories = searchDirectories(options.loginPath, env.PATH)
  for (const directory of fallbacks) {
    if (!directories.includes(directory) && options.exists(directory)) directories.push(directory)
  }
  const path = directories.join(delimiter)
  return path === env.PATH ? env : { ...env, PATH: path }
}

// The last PATH any resolver in this process heard from a login shell. A
// resolver is async and a spawn's environment is built synchronously, so the
// spawn reads the answer the session already has (CLI detection asks at boot)
// rather than waiting for one.
let lastResolvedLoginPath: string | null = null
let lastResolvedLoginEnv: Readonly<Record<string, string>> = {}

/** The login shell's PATH as last resolved this session, or null before any shell has answered. */
export function lastKnownLoginShellPath(): string | null {
  return lastResolvedLoginPath
}

/** The `LOGIN_SHELL_ENV_VARIABLES` the shell that last answered for PATH set; empty before any has. */
export function lastKnownLoginShellEnv(): Readonly<Record<string, string>> {
  return lastResolvedLoginEnv
}

async function isExecutableFile(candidate: string): Promise<boolean> {
  try {
    const info = await stat(candidate)
    if (!info.isFile()) return false
    await access(candidate, constants.X_OK)
    return true
  } catch {
    return false
  }
}

/**
 * The absolute path `binary` would run as, or null. A name is looked up in
 * `directories` in order, as a shell would; a command override that is already
 * a path is checked where it points. Only an executable regular file counts —
 * an alias or a function in the person's shell cannot be started without that
 * shell, which is the same line the interactive probe drew.
 */
export async function findExecutable(binary: string, directories: string[]): Promise<string | null> {
  const name = binary.trim()
  if (!name) return null
  if (name.includes('/')) {
    const candidate = isAbsolute(name) ? name : resolve(name)
    return (await isExecutableFile(candidate)) ? candidate : null
  }
  for (const directory of directories) {
    const candidate = join(directory, name)
    if (await isExecutableFile(candidate)) return candidate
  }
  return null
}

export type LoginShellPathResolver = {
  /** The login PATH, or null when no shell answered. Shared by every concurrent caller. */
  resolve(env: NodeJS.ProcessEnv): Promise<string | null>
  /** Forget the answer, so the next caller asks a shell again. */
  invalidate(): void
}

export function createLoginShellPathResolver(deps: {
  run(descriptor: LoginShellPathDescriptor, env: NodeJS.ProcessEnv): Promise<LoginShellPathOutcome>
  shell(): string | undefined
}): LoginShellPathResolver {
  let memo: Promise<string | null> | null = null

  async function ask(env: NodeJS.ProcessEnv): Promise<{ path: string; env: Record<string, string> } | null> {
    for (const descriptor of loginShellPathDescriptors(deps.shell())) {
      try {
        const outcome = await deps.run(descriptor, env)
        if (outcome.timedOut) continue
        const path = parseLoginShellPath(outcome.stdout)
        if (path) return { path, env: parseLoginShellEnv(outcome.stdout) }
      } catch {
        // A shell that will not start is one fewer place to ask, not a failure.
      }
    }
    return null
  }

  return {
    resolve(env) {
      if (memo) return memo
      const pending = ask(env).then((answer) => {
        // The variables come from the same shell as the PATH, so they are
        // replaced together: a profile that dropped one drops it here too.
        if (answer) {
          lastResolvedLoginPath = answer.path
          lastResolvedLoginEnv = answer.env
        }
        return answer?.path ?? null
      })
      memo = pending
      void pending.then((path) => {
        // Kept only when it answered. Dropping a failure lets the next refresh
        // try again instead of living with the process PATH all session.
        if (path === null && memo === pending) memo = null
      })
      return pending
    },
    invalidate() {
      memo = null
    },
  }
}

let sharedResolver: LoginShellPathResolver | null = null

/**
 * The process's one login-shell PATH lookup. Every caller gets the same answer
 * and every concurrent first caller waits on the same shell; `invalidate()`
 * drops it for all of them, which is what each caller wants anyway — they all
 * invalidate after something that may have changed the shell config, and the
 * PATH that follows is everyone's. The first caller's environment starts the
 * shell; callers merge their own PATH after its answer (`searchDirectories`),
 * so none depends on its entries being in the shell's.
 *
 * Per process: a server running apart from the desktop asks its own shell.
 */
export function sharedLoginShellPath(): LoginShellPathResolver {
  sharedResolver ??= createLoginShellPathResolver({
    run: (descriptor, env) => runSpawnDescriptor(descriptor, { env, timeoutMs: descriptor.timeoutMs }),
    shell: () => process.env.SHELL,
  })
  return sharedResolver
}
