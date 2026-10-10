import { createHash, randomUUID } from 'crypto'
import { existsSync, mkdirSync, readFileSync, renameSync, statSync, unlinkSync, writeFileSync } from 'fs'
import { rm, stat, unlink } from 'fs/promises'
import { homedir } from 'os'
import { dirname, join } from 'path'
import type { AgentCli, CliRuntimeSettings, TerminalPathStyle } from '../shared/electron-api'
import type { CliPermissionSetting } from '../shared/cli-permission-mode'
import type { PluginContextInjectionMode } from '../shared/plugin-manifest'
import { DESIGN_SYSTEM_BUNDLE_DIRECTORY_NAME } from '../shared/design-system/bundle-scaffold'
import {
  buildCursorHostContextPluginManifest,
  buildCursorHostContextRuleFile,
  buildHostContextDocument,
  CURSOR_HOST_CONTEXT_PLUGIN_MANIFEST_REL,
  CURSOR_HOST_CONTEXT_PLUGIN_RULE_REL,
  wrapHostContextForPrompt,
} from '../shared/host-context/document'
import {
  cliTakesLaunchPlugins,
  planAgentLaunch,
  planAgentShellCommand,
  pluginIdForCli,
  renderAgentLaunchArgv,
  renderCliLaunchEnv,
  resolveCliRuntimeSettings,
  type AgentLaunchPlanOptions,
  type AgentPromptDelivery,
  type PlannedAgentLaunch,
} from './agent-launch-render'
import { launchArgBudgetFor, quoteWindowsCommandLineArg } from './launch-arg-budget'
import { RAISE_OOM_SCORE_SHELL_LINE } from './agent-oom-score'
import { CLI_EXITED_OSC } from './deferred-prompt-delivery'
import { buildLaunchStatusLineSetting } from './agent-state'
import { resolveAgentStateSocketPath } from './agent-state-service'
import { installedStudioPlatform, studioPlatform } from '../server/platform/platform'
import { getPluginManifest } from './plugin-registry-instance'
import { getColorScheme } from './color-scheme-store'
import { ensureManagedRuntimeShims, withManagedRuntimePath } from './managed-runtime'
import { AGENT_IDENTITY_ENV_KEYS, MCP_CHANNEL_TOKEN_ENV, studioEnvEntry, withoutStudioEnv } from '../shared/studio-env'
import { withoutInheritedSessionEnv } from './inherited-session-env'
import { lastKnownLoginShellPath, withUserShellPath } from './login-shell-path'
import { isWindowsPath, toWslPath, wslToWindowsPath } from '../shared/host-paths'
import { wslDistroArgs, wslDistroForPath, wslSessionPidFileCommand, wslSessionPidKey } from './hosts/wsl-distro'
import type { HostLaunchFile, HostLaunchTarget } from './hosts/execution-host'

export type ShellLaunchConfig = {
  command: string
  args: string[]
  cwd?: string
  pathStyle: TerminalPathStyle
  initialInput?: string
  env?: Record<string, string>
  startupScriptPath?: string
  /**
   * Where this launch's host-context document was written, when one was. The
   * caller keeps it on the session so the file is reaped at teardown alongside
   * the startup script; see `cleanupHostContextFile`.
   */
  hostContextPath?: string
  /**
   * The first message, when the CLI takes it as typed input: because it was too
   * long for this platform's command line, or because the manifest is
   * `send-after-ready` (`planAgentLaunch`). The launch carries none of it; the
   * caller owes the CLI exactly this text, once, as a bracketed paste and an
   * Enter, when the CLI is ready for input.
   */
  deferredPrompt?: string
  /**
   * Where an overflowed first message was written for a CLI that reads it from
   * a file. Reaped at teardown like the host-context document.
   */
  launchPromptPath?: string
  /**
   * Files the launch needs on its host, which the caller has the host write
   * before it starts the terminal (`ExecutionHost.writeLaunchFiles`). Only a
   * WSL launch has any: its startup script and host-context file live inside
   * the distribution, and `startupScriptPath`/`hostContextPath` name them as
   * Linux does.
   */
  hostFiles?: HostLaunchFile[]
}

/**
 * What the pane can draw, said in the variables CLIs probe for. Each is a
 * default: a value the person already exported is left alone.
 */
export function applyTerminalCapabilityDefaults(env: Record<string, string>): void {
  env.TERM = env.TERM || 'xterm-256color'
  // The pane renders 24-bit colour, and TERM cannot say so: `xterm-256color`
  // is a 256-colour terminfo entry, and CLIs that pick their palette by probing
  // (chalk's `supports-color`, bat, delta) read COLORTERM for the rest.
  // Without it they quantise every theme colour to the nearest of 256. An
  // empty value is as good as missing — it is how a parent shell that had none
  // passes one on.
  env.COLORTERM = env.COLORTERM || 'truecolor'
  // Put us on the hyperlink allowlist. Claude Code (and every other CLI using
  // `supports-hyperlinks`) only emits the OSC 8 escape when its probe passes,
  // and that probe is a list of terminal identities — FORCE_HYPERLINK first,
  // then TERM_PROGRAM against a fixed set of emulator names, then
  // TERMINAL_EMULATOR, then WT_SESSION. TERM alone fails every branch, so a
  // `[file] …` line arrived as inert text no matter what the renderer did.
  // FORCE_HYPERLINK is the honest branch to take: we DO render them (see
  // `terminalOscLinks.ts`), and claiming to be iTerm by setting TERM_PROGRAM
  // would tell every other CLI a lie about a dozen unrelated capabilities.
  // Left alone when the user already exported it, so `FORCE_HYPERLINK=0`
  // remains a way to turn the escapes off.
  env.FORCE_HYPERLINK = env.FORCE_HYPERLINK || '1'
}

export function getTerminalEnv(): Record<string, string> {
  // Without the markers of a Claude Code session the app itself may have been
  // started from: inherited, they make every `claude` this app launches (or a
  // person types into a plain terminal) a nested session that saves no
  // transcript and cannot be resumed. See inherited-session-env.ts.
  const env = withoutInheritedSessionEnv(
    Object.fromEntries(
      Object.entries(process.env).filter((entry): entry is [string, string] => typeof entry[1] === 'string'),
    ),
  )

  delete env.ELECTRON_RUN_AS_NODE
  applyTerminalCapabilityDefaults(env)

  // The person's own PATH, not the one the app was started with: opened from
  // Finder or the Dock, that is launchd's `/usr/bin:/bin:/usr/sbin:/sbin`, and
  // an agent's shell then has no Homebrew, no `/usr/local/bin` and no `npx`.
  const userEnv = withUserShellPath(env, {
    platform: process.platform,
    loginPath: lastKnownLoginShellPath(),
    exists: existsSync,
  })

  // Surface CLIs installed into the managed npm prefix (e.g. Codex) on PATH so
  // launched agent sessions can find them. The shims themselves stay out of the
  // user shell — they exist for our install commands, not interactive use.
  const shims = ensureManagedRuntimeShims()
  return shims ? withManagedRuntimePath(userEnv, shims.prefixBinDir, process.platform) : userEnv
}

// Per-agent identity exposed to the launched session so a typed handoff ("work
// on backlog/foo.md") can record the same Backlog item ↔ agent link the
// drag-drop path writes. The durable key is workspaceId + agentId (never the
// PTY/CLI session id, which is reaped or changes across relaunch); the name is
// for the link label. Only non-empty values are emitted, so a plain terminal or
// an identity-less launch adds nothing. Identity env is a core concern, written
// onto the session record the same way a module contribution writes its own.
//
// Agent launches also carry THIS instance's agent-state socket address. The
// reporter hook prefers the env address over the `--socket` arg baked into the
// repo's shared `.claude/settings.local.json`, because that file is
// last-writer-wins across app instances (a second dev instance or E2E profile
// rewrites it and every other instance's agents then report phases to a dead
// socket — the 2026-07-07 parked-agents incident). Env is per-process, so an
// agent always reports to the instance that launched it.
//
// And the CLI, for the MCP gateway's connect frame. The gateway entry the
// launch used to pin into the workspace's `.mcp.json` baked
// `SPRINTENGINE_AGENT_CLI` into that file; a launch that carries the app's
// plugin directory gets the gateway from a plugin copy shared by every
// Claude-family CLI, which cannot bake one. The bridge inherits the session's
// env either way, so the CLI travels here, the same road the workspace and
// agent ids already take.
export function agentIdentityEnv(input: {
  workspaceId?: string
  agentId?: string
  agentName?: string
  cli?: string
}): Record<string, string> {
  const workspaceId = input.workspaceId?.trim()
  const agentId = input.agentId?.trim()
  const agentName = input.agentName?.trim()
  const cli = input.cli?.trim()
  const agentStateSocketPath = agentId ? agentStateSocketPathForLaunch() : null
  return {
    ...studioEnvEntry('SPRINTENGINE_WORKSPACE_ID', workspaceId),
    ...studioEnvEntry('SPRINTENGINE_AGENT_ID', agentId),
    ...studioEnvEntry('SPRINTENGINE_AGENT_NAME', agentName),
    ...studioEnvEntry('SPRINTENGINE_AGENT_STATE_SOCKET', agentStateSocketPath),
    ...studioEnvEntry('SPRINTENGINE_AGENT_CLI', cli || undefined),
  }
}

// Same resolution the agent-state service uses (deterministic from the profile
// dir), so the launch env and the live listener always agree. Lazy + guarded:
// with no platform installed (unit tests bundling this module) there is no
// profile dir — identity env then simply omits the socket address.
function agentStateSocketPathForLaunch(): string | null {
  try {
    const dataDir = installedStudioPlatform()?.paths.dataDir()
    return dataDir ? resolveAgentStateSocketPath(dataDir) : null
  } catch {
    return null
  }
}

// The app's data directory, for the files a launch writes beside it.
function userDataDir(): string {
  return studioPlatform().paths.dataDir()
}

// The app-owned plugin directories a launch hands a CLI that declares
// `launchPlugins` — this app's skills, its agent-state hook and its MCP server,
// for that session only, instead of installed into the person's repository.
//
// Published by app-services once the copy has been materialised rather than
// resolved here, because materialising is async and a launch must not wait for
// it. Until then (and for a build whose plugin did not ship) this resolves to
// nothing: the launch renders exactly the argv it always did, and the workspace
// installer stays responsible for agent state — see `resolveLaunchInjectsPlugins`.
let launchPluginDirsResolver: (() => string[]) | null = null

export function setLaunchPluginDirsResolver(resolver: (() => string[]) | null): void {
  launchPluginDirsResolver = resolver
}

/**
 * This launch's plugin directories, in the path style the launched shell reads.
 *
 * On this machine they are the copy app-services materialised under userData.
 * A WSL launch gets the copy its helper wrote inside the distribution, with
 * Linux paths substituted into it (the pinned Node, the helper's bridge and
 * socket): converting this machine's directory would not convert the paths
 * inside its files, and a Linux `claude` would run `node "C:/…"` for every
 * hook. Until the helper has written it, a WSL launch passes none, and the
 * workspace installer (which asks the same host) carries agent state instead.
 *
 * Native Windows is still left on the workspace install, and the predicate in
 * app-services agrees, so the two can never each think the other registers the
 * hook.
 */
function pluginDirsForLaunch(cli: AgentCli, target: HostLaunchTarget, skills: readonly string[] = []): string[] {
  if (target.kind === 'wsl') {
    const dirs = target.integration?.pluginDirs ?? []
    if (dirs.length === 0 || !cliTakesLaunchPlugins(cli)) return []
    return [...dirs, ...skillDirsFor(skills, target.integration?.skillPluginDirs ?? {})]
  }
  let dirs: string[]
  let skillDirs: Record<string, string>
  try {
    dirs = launchPluginDirsResolver?.() ?? []
    skillDirs = launchSkillPluginDirsResolver?.() ?? {}
  } catch {
    return []
  }
  if (!launchCarriesAppPluginsFor(cli, dirs)) return []
  const all = [...dirs, ...skillDirsFor(skills, skillDirs)]
  return target.kind === 'posix' ? all : all.map((dir) => wslToWindowsPath(dir))
}

/** The one-skill plugins a launch that invokes `skills` adds, in the order asked, each once. */
function skillDirsFor(skills: readonly string[], available: Record<string, string>): string[] {
  const dirs: string[] = []
  for (const skill of new Set(skills)) {
    const dir = Object.hasOwn(available, skill) ? available[skill] : undefined
    if (dir) dirs.push(dir)
  }
  return dirs
}

// The one-skill plugins in this machine's copy, by skill id (see
// `launchSkillPluginDir`). Published beside the plugin directories, and empty
// until that copy lands — a launch then falls back to the workspace install.
let launchSkillPluginDirsResolver: (() => Record<string, string>) | null = null

export function setLaunchSkillPluginDirsResolver(resolver: (() => Record<string, string>) | null): void {
  launchSkillPluginDirsResolver = resolver
}

/**
 * Whether this platform takes the app's plugin directories at launch.
 *
 * Exported so the workspace installer asks the same question: one answer, or
 * both halves write the hook and every event is reported twice.
 */
// The status-line forwarder inside the app's own plugin copy. Published by
// app-services alongside the plugin directories; empty until that copy lands.
let launchStatusLineScriptResolver: (() => string) | null = null

export function setLaunchStatusLineScriptResolver(resolver: (() => string) | null): void {
  launchStatusLineScriptResolver = resolver
}

/**
 * The settings document this launch passes, or undefined for none.
 *
 * Gated on the plugin directories deliberately: the status line is only sent
 * where the workspace install is being SKIPPED. A launch that still writes the
 * workspace's own settings registers the status line there, exactly as before,
 * and sending it here as well would put two of them in front of one session.
 */
function launchSettingsForLaunch(
  cli: AgentCli,
  cwd: string,
  target: HostLaunchTarget,
): Record<string, unknown> | undefined {
  if (pluginDirsForLaunch(cli, target).length === 0) return undefined
  if (target.kind === 'wsl') {
    // The forwarder, socket, Node and home are the distribution's own. The
    // status line it wraps is the person's Linux one, run by Linux Node.
    const integration = target.integration
    if (!integration?.statusLineScriptPath) return undefined
    const statusLine = buildLaunchStatusLineSetting({
      workspaceRoot: cwd,
      scriptPath: integration.statusLineScriptPath,
      socketPath: integration.agentStateSocketPath,
      homeDir: integration.home.native,
      // The person's Linux CLAUDE_CONFIG_DIR, as this process opens it.
      env: { ...integration.home.env },
      runtime: integration.commandRuntime,
    })
    return statusLine ? { statusLine } : undefined
  }
  let scriptPath: string
  try {
    scriptPath = launchStatusLineScriptResolver?.() ?? ''
  } catch {
    return undefined
  }
  if (!scriptPath) return undefined
  const socketPath = agentStateSocketPathForLaunch()
  if (!socketPath) return undefined
  // Read against the NATIVE cwd: the settings files being consulted are this
  // machine's, whatever path style the launched shell speaks.
  const statusLine = buildLaunchStatusLineSetting({
    workspaceRoot: cwd,
    scriptPath,
    socketPath,
    homeDir: homedir(),
    env: process.env,
  })
  return statusLine ? { statusLine } : undefined
}

export function launchPluginsSupportedOnThisPlatform(platform: NodeJS.Platform = process.platform): boolean {
  return platform !== 'win32'
}

/**
 * Whether launches carry the app's plugin copy at all: the platform takes it
 * and the copy has landed. The workspace installer skips its Claude half on
 * exactly this answer, so it must be the same one the launch flag reads — on
 * Windows the copy materialises but no launch passes it, and a workspace
 * installer that only looked at the copy removed the hook the launch was never
 * going to register, leaving Claude there with no agent state.
 */
export function appLaunchPluginsActive(
  pluginDirs: readonly string[],
  platform: NodeJS.Platform = process.platform,
): boolean {
  return launchPluginsSupportedOnThisPlatform(platform) && pluginDirs.length > 0
}

/** `appLaunchPluginsActive`, narrowed to one CLI: does THIS launch pass `--plugin-dir`. */
export function launchCarriesAppPluginsFor(
  cli: string,
  pluginDirs: readonly string[],
  platform: NodeJS.Platform = process.platform,
): boolean {
  return appLaunchPluginsActive(pluginDirs, platform) && cliTakesLaunchPlugins(cli)
}

// Apply this session's agent identity onto a base env: strip any inherited
// identity first (no leak), then set this session's values. A non-agent launch
// passes no ids, so the result simply carries no identity.
export function applyAgentIdentityEnv(
  baseEnv: Record<string, string>,
  input: { workspaceId?: string; agentId?: string; agentName?: string; cli?: string; launchToken?: string },
): Record<string, string> {
  // Stripped under BOTH names: the app's own process may have inherited a
  // legacy-named identity from the shell that started it, and clearing only the
  // new name would leave that to be read as this session's agent. A launch
  // token it inherited is stripped too: it is that other launch's, and only
  // this launch's own (`launchToken`) may ride here.
  return {
    ...withoutStudioEnv(baseEnv, [...AGENT_IDENTITY_ENV_KEYS, MCP_CHANNEL_TOKEN_ENV]),
    ...agentIdentityEnv(input),
    ...studioEnvEntry(MCP_CHANNEL_TOKEN_ENV, input.launchToken),
  }
}

// Identity/terminal keys a CLI manifest's `launch.env` must never override.
// The agent-identity vars are owned by `applyAgentIdentityEnv` (applied at spawn
// time, so they already win); TERM/COLORTERM are the terminal's own identity.
// Listed here so the provider-env merge refuses to clobber them even if a
// manifest declared one. The set is the boundary between what the app knows
// about a session and what a manifest may configure: a manifest describes its
// PROVIDER, and every key in here is a fact about the pane or about which agent
// this is — neither of which a manifest is in a position to restate.
const PROTECTED_LAUNCH_ENV_KEYS = new Set<string>([
  ...AGENT_IDENTITY_ENV_KEYS,
  MCP_CHANNEL_TOKEN_ENV,
  'TERM',
  'COLORTERM',
  // Same reasoning as TERM: whether this terminal renders OSC 8 hyperlinks is a
  // fact about the pane, which a CLI manifest is in no position to know. A
  // manifest that set it to '0' would silently un-click every `[file] …` line;
  // one that set it to '1' for a pane that could not render them would print
  // raw escapes.
  'FORCE_HYPERLINK',
])

// True when the provider env redirects the Anthropic endpoint (a different
// base URL, or our own auth token). On a redirect, an inherited ANTHROPIC_API_KEY
// belongs to the DEFAULT Anthropic endpoint — NOT the redirect target — so it
// must never travel: leaving it set would transmit the user's real Anthropic key
// to the third-party endpoint (e.g. api.z.ai) on the auth header. This is the
// critical case to cover even when no token is configured (endpoint redirected,
// key inherited): the launch should fail closed (401), not leak the key.
function redirectsAnthropicEndpoint(providerEnv: Record<string, string>): boolean {
  return Boolean(providerEnv.ANTHROPIC_BASE_URL || providerEnv.ANTHROPIC_AUTH_TOKEN)
}

// Merge a CLI manifest's rendered `launch.env` (and its `contextInjection.env`,
// which rides the same record) onto a base session env. The provider env wins on
// collision (it is the whole point — e.g. pointing ANTHROPIC_BASE_URL at Z.AI)
// except for the protected identity keys above. No-op (returns the base
// unchanged) for the common case of a manifest with no env at all.
//
// ONE exception to "wins on collision": when both sides are JSON objects, they
// are merged rather than replaced. This is the host-context env channel
// (OpenCode's OPENCODE_CONFIG_CONTENT, a whole config document): a user who
// exports their own config content must not lose it because we wanted to add one
// `instructions` entry, and they must not lose our entry either. The rule is
// stated in terms of JSON, not of any CLI — no manifest is named here.
export function mergeProviderLaunchEnv(
  base: Record<string, string>,
  providerEnv: Record<string, string> | undefined,
): Record<string, string> {
  if (!providerEnv || Object.keys(providerEnv).length === 0) return base
  const next = { ...base }
  if (redirectsAnthropicEndpoint(providerEnv)) {
    delete next.ANTHROPIC_API_KEY
  }
  for (const [key, value] of Object.entries(providerEnv)) {
    if (PROTECTED_LAUNCH_ENV_KEYS.has(key)) continue
    next[key] = mergeJsonEnvValue(next[key], value)
  }
  return next
}

/**
 * `next` merged over `existing` when both are JSON objects, else `next`.
 *
 * Shallow on objects and concatenating on arrays, which is what "add my entry to
 * your list" needs and all this channel is for. Anything that does not parse —
 * the overwhelming majority of env values — takes the plain replacement path, so
 * this is invisible to every other manifest.
 */
function mergeJsonEnvValue(existing: string | undefined, next: string): string {
  if (!existing) return next
  const left = parseJsonObject(existing)
  const right = parseJsonObject(next)
  if (!left || !right) return next
  const merged: Record<string, unknown> = { ...left }
  for (const [key, value] of Object.entries(right)) {
    const previous = merged[key]
    merged[key] = Array.isArray(previous) && Array.isArray(value) ? [...previous, ...value] : value
  }
  return JSON.stringify(merged)
}

function parseJsonObject(value: string): Record<string, unknown> | null {
  try {
    const parsed: unknown = JSON.parse(value)
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? (parsed as Record<string, unknown>) : null
  } catch {
    return null
  }
}

/**
 * POSIX bootstrap fragment: managed-MCP env, then the CLI manifest's
 * `launch.env`. Empty when neither has anything to say.
 */
export function buildLaunchShellBootstrap(
  managedMcpEnv?: Record<string, string>,
  providerLaunchEnv?: Record<string, string>,
): string {
  const lines: string[] = []
  for (const [key, value] of Object.entries(managedMcpEnv ?? {})) {
    if (/^[A-Za-z_][A-Za-z0-9_]*$/.test(key)) {
      lines.push(`export ${key}=${quotePosix(value)}`)
    }
  }
  if (providerLaunchEnv && redirectsAnthropicEndpoint(providerLaunchEnv)) {
    lines.push('unset ANTHROPIC_API_KEY')
  }
  for (const [key, value] of Object.entries(providerLaunchEnv ?? {})) {
    if (PROTECTED_LAUNCH_ENV_KEYS.has(key)) continue
    if (/^[A-Za-z_][A-Za-z0-9_]*$/.test(key)) {
      lines.push(`export ${key}=${quotePosix(value)}`)
    }
  }
  return lines.join('; ')
}

function replaceAllLiteral(value: string, search: string, replacement: string): string {
  return search && search !== replacement ? value.split(search).join(replacement) : value
}

/**
 * Rewrite every absolute path this launch knows about into the path style the
 * launched shell speaks. Applied to the initial prompt and to the host-context
 * document alike — both name the workspace, the knowledge root and the context
 * file itself, and a Windows path handed to a CLI running under WSL points at
 * nothing.
 */
function normalizeTextPaths(
  text: string | undefined,
  target: 'windows' | 'wsl',
  paths: Array<string | undefined>,
): string | undefined {
  if (!text) return text

  let normalizedPrompt = text
  for (const pathValue of paths) {
    if (!pathValue) continue

    const targetPath = target === 'wsl' ? toWslPath(pathValue) : wslToWindowsPath(pathValue)
    const candidates = Array.from(new Set([pathValue, wslToWindowsPath(pathValue), toWslPath(pathValue)]))
    for (const candidate of candidates) {
      normalizedPrompt = replaceAllLiteral(normalizedPrompt, candidate, targetPath)
    }
  }

  return normalizedPrompt
}

function quotePosix(value: string): string {
  return `'${value.replace(/'/g, `'"'"'`)}'`
}

function quotePosixCommand(value: string): string {
  return /^[A-Za-z0-9._/-]+$/.test(value) ? value : quotePosix(value)
}

function quotePowerShell(value: string): string {
  return `'${value.replace(/'/g, "''")}'`
}

function powerShellBase64Literal(value: string): string {
  return `[Text.Encoding]::UTF8.GetString([Convert]::FromBase64String(${quotePowerShell(Buffer.from(value, 'utf8').toString('base64'))}))`
}

// Exported for terminal-launch.test.ts. The tail of the native Windows launch
// script: run `$command` with `$arguments` (set by the caller).
//
// Windows PowerShell 5.1 — which powershell.exe always is — does not escape
// embedded double quotes when it builds a native exe's command line, so
// `& claude.exe @arguments` handed Claude Code `--settings {theme:dark}` for
// the argument `{"theme":"dark"}`, and Claude Code rejected it as invalid
// settings on every launch. Any prompt with a quote in it was mangled the same
// way. So for an .exe the command line is built here, escaped exactly, and
// passed through the stop-parsing token, which hands the rest of the line to
// the exe verbatim (expanding only %VAR%). A .ps1/.cmd shim keeps the old
// splat: --% means something else to a script, and cmd.exe re-parses quotes
// by its own rules.
export function buildNativeWindowsInvocation(args: string[]): string[] {
  if (args.length === 0) return ['& $command']
  return [
    `$env:SPRINTENGINE_LAUNCH_ARGS = ${powerShellBase64Literal(args.map(quoteWindowsCommandLineArg).join(' '))}`,
    `$resolvedCommand = Get-Command $command -ErrorAction SilentlyContinue | Select-Object -First 1`,
    `if ($resolvedCommand -and $resolvedCommand.CommandType -eq 'Application' -and $resolvedCommand.Source -match '\\.(exe|com)$') {`,
    // Nothing may follow --% on this line: it would be passed to the exe too.
    `  & $resolvedCommand.Source --% %SPRINTENGINE_LAUNCH_ARGS%`,
    `} else {`,
    `  & $command @arguments`,
    `}`,
    `Remove-Item Env:SPRINTENGINE_LAUNCH_ARGS -ErrorAction SilentlyContinue`,
  ]
}

function getCliRuntimeSettings(
  cli: AgentCli,
  cliRuntimes?: Partial<Record<AgentCli, Partial<CliRuntimeSettings>>>,
): CliRuntimeSettings {
  // Delegates to the shared resolver so blank commands fall back to the plugin
  // manifest binary at render time.
  return resolveCliRuntimeSettings(cli, cliRuntimes)
}

function buildUserShellStartup(): string {
  return [
    'for profile in "$HOME/.bash_profile" "$HOME/.bash_login" "$HOME/.profile"; do [ -r "$profile" ] && . "$profile" && break; done',
    '[ -r "$HOME/.bashrc" ] && . "$HOME/.bashrc"',
    '[ -d "$HOME/.npm-global/bin" ] && export PATH="$HOME/.npm-global/bin:$PATH"',
  ].join('; ')
}

// ── Shell integration: OSC 7 (cwd) and OSC 133 (prompt marks) ───────────────
//
// A pane's `executionRoot` is the directory it was LAUNCHED in, so the moment a
// user types `cd` every relative path printed afterwards resolves against the
// wrong tree — silently, because the wrong tree usually holds a file by that
// name too. OSC 7 (`ESC ] 7 ; file://<host>/<path> ST`) is the standard way a
// shell keeps its terminal up to date, and xterm registers no handler for it,
// so both halves are ours: emit it here, read it in
// `terminalOscLinks.ts`/`PlainTerminalPanel`.
//
// Neither macOS shell emits it unprompted. The awkward part is that our startup
// script does its work and then `exec`s the user's real interactive shell —
// which is the right thing to do, and it means a function or a hook defined in
// the script is gone by the time there is a prompt to hook. Only the
// ENVIRONMENT survives the exec, so each shell is reached the one way it can be
// reached through env alone:
//
// - **bash** imports `PROMPT_COMMAND` from the environment and runs it before
//   every prompt, so the whole emitter travels as one exported string.
// - **zsh** has no such variable (`precmd_functions` is an array, and arrays do
//   not travel in env), but it does read its startup files from `$ZDOTDIR`. So
//   we point that at a generated directory whose files hand straight back to
//   the user's own and then add the hook. The user's files still see their own
//   `$ZDOTDIR` while they run, and the shell is left holding it afterwards.
//
// A user who has already set `PROMPT_COMMAND` or `ZDOTDIR` keeps it: both are
// captured into a `SPRINTENGINE_USER_…` variable before they are replaced, and
// theirs is run behind ours (`PROMPT_COMMAND`) or handed back to them
// (`ZDOTDIR`). Both captures are guarded against a relaunch inside one of our
// own terminals, where the inherited value is already ours. A rc file that
// appends to `PROMPT_COMMAND` (the common case) keeps ours as well. A rc that
// ASSIGNS `PROMPT_COMMAND` outright wins and no OSC 7 arrives — which is the
// same as any other shell that does not emit it, and the renderer falls back
// to the launch directory rather than breaking.
//
// The host is deliberately empty (`file:///Users/…`, not `file://mymac/…`):
// the renderer refuses any `file:` URI that names a host, because a pane
// attached to another machine must never resolve a local path, and a payload
// carrying THIS machine's hostname is indistinguishable from one carrying
// someone else's.
//
// OSC 133 rides the SAME two mechanisms — one exported `PROMPT_COMMAND`, one
// generated `$ZDOTDIR` — because a second injection would be a second thing to
// keep working. Four marks: `133;A` prompt start, `133;B` prompt end, `133;C`
// pre-execution, `133;D;<status>` command finished. A and D come from the
// pre-prompt hook (which is why the hook now captures `$?` before it does
// anything else, and restores it afterwards so a prompt that shows the last
// exit status still sees the real one). B is appended to `PS1` and C to bash's
// `PS0`/zsh's `preexec`, both idempotently and both re-checked every prompt, so
// a theme that rebuilds `PS1` costs at most one prompt's mark rather than
// stacking copies.
//
// Three honest limitations, each degrading to "fewer marks", never to
// breakage. `PS0` arrived in bash 4.4, so macOS's system bash 3.2 emits no C
// and the renderer therefore attributes no exit status to it (see
// `terminalShellMarks.ts`: a D with no C before it is ignored, which is also
// what an empty Enter and the very first prompt emit). A prompt theme that
// regenerates `PS1` AFTER our hook runs — powerlevel10k, or a user
// `PROMPT_COMMAND` appended behind ours — drops B for as long as it keeps
// doing so. And a zsh with `PROMPT_PERCENT` off has no zero-width prompt
// escape at all, so it is given no B rather than a literal `%{` in its
// prompt.
//
// Nothing here reaches agent state. Agent phase comes from `agent-state.ts`
// over the state socket (decision of record 2026-08-31, hooks only), and these
// marks are armed for `shell` panes alone — an agent pane runs a CLI, not a
// prompt, and never sees this setup.

/** The path characters that would change what the URI means if left raw. */
const OSC7_PATH_ESCAPES: Array<[string, string]> = [
  // `%` first: every replacement below introduces one, and re-escaping those
  // would turn `%5C` into `%255C`.
  ['%', '%25'],
  // `#` starts a fragment and `?` a query — either would TRUNCATE the path at
  // that point rather than corrupt it, which is the failure that looks like a
  // working link to the wrong directory.
  ['#', '%23'],
  ['?', '%3F'],
  // The URL parser folds `\` to `/` for file URIs, so a directory named with
  // one would come back as an extra path segment.
  ['\\', '%5C'],
]

/**
 * One OSC sequence (`ESC ] <payload> ESC \`) as the literal text a shell needs
 * in a `printf` format or in `PS1`/`PS0`.
 *
 * Written once because the escaping is three layers deep — a TypeScript string
 * literal, a single-quoted shell word, then the shell's own `\nnn` decoding —
 * and a hand-copied version that got one layer wrong would read correctly in
 * the source and put garbage on the wire.
 */
function oscSequenceLiteral(payload: string): string {
  return `\\033]${payload}\\033\\\\`
}

/**
 * bash's emitter, as one self-contained line.
 *
 * It has to be self-contained because it travels as an environment variable
 * through an `exec` — there is no function definition on the far side to call.
 */
export const OSC7_BASH_PROMPT_COMMAND: string = [
  '__sprintengine_osc7=${PWD}',
  ...OSC7_PATH_ESCAPES.map(([from, to]) => `__sprintengine_osc7=\${__sprintengine_osc7//\\${from}/${to}}`),
  `printf '\\033]7;file://%s\\033\\\\' "$__sprintengine_osc7"`,
].join('; ')

/**
 * The first thing the exported `PROMPT_COMMAND` does, and it has to be first.
 *
 * `$?` is the status of the command the user just ran, and ANY command replaces
 * it — a plain assignment included, which is exactly what the OSC 7 emitter
 * opens with.
 */
export const OSC133_BASH_STATUS_CAPTURE: string = '__sprintengine_status=$?'

/**
 * The variable name above, on its own: `buildShellIntegrationSetup` matches on
 * it to tell an inherited `PROMPT_COMMAND` that is ALREADY ours from a user's.
 * Named here so the two cannot drift.
 */
export const OSC133_BASH_STATUS_CAPTURE_VARIABLE: string = '__sprintengine_status'

/**
 * bash's OSC 133 marks, appended to the same exported `PROMPT_COMMAND`.
 *
 * Four lines, in the order they have to run:
 *
 * 1. `133;D;<status>` for the command that just finished, then `133;A` for the
 *    prompt about to be drawn. One `printf`, because two would let a slow pipe
 *    interleave something between them.
 * 2. `133;B` (prompt end) appended to `PS1`, guarded so it lands once. The
 *    guard is re-run every prompt rather than once at setup: a theme that
 *    rebuilds `PS1` per prompt would otherwise lose the mark permanently, and
 *    one that does not would otherwise gain a copy per prompt. `\[`…`\]` is
 *    what stops readline counting the escape as columns — without it the shell
 *    mis-measures the prompt and wraps the user's typing in the wrong place.
 * 3. `133;C` (pre-execution) appended to `PS0`, which bash expands after
 *    reading a command and before running it. bash 4.4+; on macOS's system
 *    bash 3.2 the variable is simply unused, so no C is emitted and the
 *    renderer attributes no exit status. Fewer marks, never a broken prompt.
 * 4. `$?` put back, so a user `PROMPT_COMMAND` appended behind ours — or a
 *    `PS1` that reads `$?` through `promptvars` — still sees the real status.
 *    The subshell is skipped on success, which is the common case.
 */
export const OSC133_BASH_PROMPT_COMMAND: string = [
  `printf '${oscSequenceLiteral('133;D;%s')}${oscSequenceLiteral('133;A')}' "$__sprintengine_status"`,
  `case \${PS1-} in *'${oscSequenceLiteral('133;B')}'*) ;; *) PS1=\${PS1-}'\\[${oscSequenceLiteral('133;B')}\\]' ;; esac`,
  `case \${PS0-} in *'${oscSequenceLiteral('133;C')}'*) ;; *) PS0=\${PS0-}'${oscSequenceLiteral('133;C')}' ;; esac`,
  'case $__sprintengine_status in 0) ;; *) ( exit $__sprintengine_status ) ;; esac',
].join('; ')

/**
 * Everything bash's `PROMPT_COMMAND` carries: capture the status, report the
 * directory, emit the marks. One variable because only one survives the `exec`.
 */
export const SHELL_INTEGRATION_BASH_PROMPT_COMMAND: string = [
  OSC133_BASH_STATUS_CAPTURE,
  OSC7_BASH_PROMPT_COMMAND,
  OSC133_BASH_PROMPT_COMMAND,
].join('; ')

/** zsh's emitter plus the `precmd` hook that runs it, appended to our `.zshrc`. */
const OSC7_ZSH_HOOK: string = [
  '__sprintengine_osc7_cwd() {',
  // The user's option set is theirs; this function should not depend on it.
  '  emulate -L zsh',
  '  local d=$PWD',
  ...OSC7_PATH_ESCAPES.map(([from, to]) => `  d=\${d//\\${from}/${to}}`),
  `  printf '\\033]7;file://%s\\033\\\\' "$d"`,
  '}',
  'typeset -ag precmd_functions',
  // Idempotent: a nested zsh reads this file again and must not stack the hook.
  'if (( ! ${precmd_functions[(I)__sprintengine_osc7_cwd]} )); then',
  '  precmd_functions+=(__sprintengine_osc7_cwd)',
  'fi',
  // The first prompt has no `cd` before it, so report the launch directory too.
  '__sprintengine_osc7_cwd',
].join('\n')

/**
 * zsh's OSC 133 marks: one `precmd` hook, one `preexec` hook, appended to the
 * same generated `.zshrc` OSC 7's hook lives in.
 *
 * The precmd hook is PREPENDED to `precmd_functions` rather than appended, and
 * that is the whole subtlety: only the first hook in the list sees the real
 * `$?`, because every hook before it has already replaced it with its own last
 * command's status. It therefore captures the status on its first line and
 * `return`s it, so the hooks behind it — the user's prompt theme included —
 * still see what they saw before we were here.
 *
 * `__sprintengine_osc133_active` is what keeps a bare Enter from being reported as
 * a command: D is emitted only when a C opened one. (The renderer applies the
 * same rule independently — see `terminalShellMarks.ts` — because the marks are
 * attacker-controlled and this hook is not the only thing that can print them.)
 */
const OSC133_ZSH_HOOK: string = [
  '__sprintengine_osc133_precmd() {',
  // Before `emulate`, before anything: any command at all replaces `$?`.
  '  local __sprintengine_ret=$?',
  '  emulate -L zsh',
  '  if (( __sprintengine_osc133_active )); then',
  `    printf '${oscSequenceLiteral('133;D;%s')}' "$__sprintengine_ret"`,
  '    __sprintengine_osc133_active=0',
  '  fi',
  `  printf '${oscSequenceLiteral('133;A')}'`,
  // Prompt end. `%{`…`%}` is zsh's "these bytes occupy no columns"; without it
  // the shell mis-measures the prompt and wraps the user's typing early.
  // Re-checked every prompt so a theme that rebuilds PS1 costs one mark rather
  // than losing it for the session, and guarded so one that does not rebuild it
  // does not collect a copy per prompt.
  `  if (( __sprintengine_osc133_prompt_percent )) && [[ $PS1 != *$'\\e]133;B'* ]]; then`,
  `    PS1=$PS1$'%{\\e]133;B\\e\\\\%}'`,
  '  fi',
  // The status the rest of the prompt machinery expects to find.
  '  return $__sprintengine_ret',
  '}',
  '__sprintengine_osc133_preexec() {',
  '  emulate -L zsh',
  '  __sprintengine_osc133_active=1',
  `  printf '${oscSequenceLiteral('133;C')}'`,
  '}',
  'typeset -g __sprintengine_osc133_active=0',
  // Whether `%{`…`%}` means anything in this shell, read HERE rather than in the
  // hook: `emulate -L zsh` inside a function reports zsh's default option set,
  // not the user's, and a user who turned PROMPT_PERCENT off would otherwise
  // get a literal `%{` printed into their prompt. Read after their own .zshrc
  // has run, which is the state the prompt will actually be rendered under.
  'typeset -g __sprintengine_osc133_prompt_percent=0',
  'if [[ -o promptpercent ]]; then __sprintengine_osc133_prompt_percent=1; fi',
  'typeset -ag precmd_functions',
  // Idempotent prepend: the filter drops any copy a nested zsh already added,
  // then puts exactly one back at the front.
  'precmd_functions=(__sprintengine_osc133_precmd "${(@)precmd_functions:#__sprintengine_osc133_precmd}")',
  'typeset -ag preexec_functions',
  'if (( ! ${preexec_functions[(I)__sprintengine_osc133_preexec]} )); then',
  '  preexec_functions+=(__sprintengine_osc133_preexec)',
  'fi',
].join('\n')

/**
 * One of the four files zsh reads out of `$ZDOTDIR`, as a shim in front of the
 * user's own copy.
 *
 * All four exist because zsh takes the WHOLE set from `$ZDOTDIR`: shim only
 * `.zshrc` and a login shell silently loses its `.zprofile`.
 */
export function buildShellIntegrationZshShim(fileName: '.zshenv' | '.zprofile' | '.zshrc' | '.zlogin'): string {
  const lines = [
    '# SprintEngine Studio shell integration (OSC 7 working directory, OSC 133 prompt marks).',
    '# Generated — rewritten on every terminal launch, so do not edit.',
    '#',
    "# This directory stands in front of the user's $ZDOTDIR and hands each stage",
    '# straight back to it, so their own files run with their own $ZDOTDIR set.',
    'SPRINTENGINE_ZDOTDIR_SELF=${ZDOTDIR}',
    'ZDOTDIR=${SPRINTENGINE_USER_ZDOTDIR:-$HOME}',
    "# A nested launch could point us at ourselves; $HOME is the shell's own default.",
    // The right side of `==` inside `[[ ]]` is a GLOB PATTERN unless it is
    // quoted, and this path is `~/Library/Application Support/<productName>/…`
    // — one `[`, `*`, `?` or `(` in the product name or the user's home and the
    // self-reference guard either stops firing or fires against a directory
    // that merely matched, throwing away a real `~/.config/zsh`.
    'if [[ $ZDOTDIR == "$SPRINTENGINE_ZDOTDIR_SELF" ]]; then ZDOTDIR=$HOME; fi',
    // Quoted for the same reason one layer down: these run with the USER'S
    // options in effect (their .zshenv has already been sourced by the shim
    // above), so `SH_WORD_SPLIT` or `GLOB_SUBST` would otherwise reach an
    // unquoted expansion of a path we do not control.
    `if [[ -f "$ZDOTDIR/${fileName}" ]]; then source "$ZDOTDIR/${fileName}"; fi`,
    '# Their file may have moved $ZDOTDIR itself; that is the value to keep.',
    'export SPRINTENGINE_USER_ZDOTDIR="$ZDOTDIR"',
  ]

  if (fileName === '.zshrc') {
    // Interactive shells end here, so this is where the shell gets its own
    // $ZDOTDIR back for good and where the hook goes.
    lines.push(
      'ZDOTDIR=$SPRINTENGINE_USER_ZDOTDIR',
      'unset SPRINTENGINE_ZDOTDIR_SELF',
      '',
      OSC7_ZSH_HOOK,
      '',
      OSC133_ZSH_HOOK,
    )
  } else {
    lines.push('ZDOTDIR=$SPRINTENGINE_ZDOTDIR_SELF', 'unset SPRINTENGINE_ZDOTDIR_SELF')
  }

  return `${lines.join('\n')}\n`
}

/**
 * The generated `$ZDOTDIR`, or null when it could not be written (a read-only
 * profile directory, say). Null simply means no OSC 7 from zsh.
 *
 * Stable rather than per-session: the contents do not vary, and a per-session
 * directory would need reaping on a path where a crashed app leaves it behind.
 */
function ensureShellIntegrationZshZdotdir(): string | null {
  try {
    const directory = join(userDataDir(), 'shell-integration', 'zsh')
    writeShellIntegrationZshShims(directory)
    return directory
  } catch {
    return null
  }
}

/**
 * The four shims in `directory`, each rewritten only when what is there is
 * not already it: every zsh pane launch comes through here, and a restored
 * layout starts several at once, so a launch reads four small files rather
 * than making the folder and writing and renaming four. A file that went
 * missing or came from another build is put back. Exported for
 * terminal-launch.test.ts.
 */
export function writeShellIntegrationZshShims(directory: string): void {
  let made = false
  for (const fileName of ['.zshenv', '.zprofile', '.zshrc', '.zlogin'] as const) {
    const filePath = join(directory, fileName)
    const contents = buildShellIntegrationZshShim(fileName)
    try {
      if (readFileSync(filePath, 'utf8') === contents) continue
    } catch {
      // Not there yet: written below.
    }
    if (!made) {
      mkdirSync(directory, { recursive: true })
      made = true
    }
    replaceFileAtomically(filePath, contents)
  }
}

/**
 * Write, then rename into place — never `O_TRUNC` over a file something else
 * may be reading.
 *
 * This directory is STABLE and SHARED, and these four files are rewritten by
 * whichever shell-pane launch first finds them missing or out of date. Restoring a saved layout starts several panes at
 * once: a plain `writeFileSync` truncates `.zshrc` to nothing and refills it,
 * so the zsh one pane just spawned can read the empty middle of another pane's
 * write. The user's own `.zshrc` then silently never sources, and `$ZDOTDIR`
 * is left pointing at the shim for the life of that shell. `rename(2)` is
 * atomic within a filesystem, so a reader sees either the old file or the new
 * one and never a half of either.
 *
 * The temporary name carries the pid and a UUID so two processes writing the
 * same target cannot collide on the temporary either.
 *
 * Exported for terminal-launch.test.ts, which holds a descriptor open across a
 * replace — the one observation that tells `rename` apart from `O_TRUNC`.
 */
export function replaceFileAtomically(filePath: string, contents: string): void {
  const temporaryPath = `${filePath}.${process.pid}.${randomUUID()}.tmp`
  try {
    writeFileSync(temporaryPath, contents, { encoding: 'utf8', mode: 0o600 })
    renameSync(temporaryPath, filePath)
  } catch (error) {
    // A failed rename leaves the temporary behind; a failed write may too.
    try {
      unlinkSync(temporaryPath)
    } catch {
      // Nothing to clean up, or nothing we can do about it.
    }
    throw error
  }
}

/**
 * The startup-script line that arms OSC 7 for this shell, or null for a shell
 * we have no env-only way to reach (`sh`, `fish`, a login shell we do not know).
 */
export function buildShellIntegrationSetup(shellName: string | undefined, zdotdir: string | null): string | null {
  if (shellName === 'bash') {
    return [
      // The user's own exported `PROMPT_COMMAND`, captured before it is
      // replaced — the same shape the zsh branch below uses for `$ZDOTDIR`.
      // A bare `export PROMPT_COMMAND=…` destroyed an inherited value outright,
      // which is what the header of this section always claimed it did not do.
      //
      // The `case` is the self-reference guard: relaunching inside one of our
      // own terminals inherits `<ours>; <theirs>`, and re-capturing THAT would
      // append our emitter to itself once per nesting level. `__sprintengine_status`
      // appears only in our string, and `SPRINTENGINE_USER_PROMPT_COMMAND` is
      // exported, so the nested shell keeps the value the outer one captured.
      `case "\${PROMPT_COMMAND:-}" in *${OSC133_BASH_STATUS_CAPTURE_VARIABLE}*) ;; *) SPRINTENGINE_USER_PROMPT_COMMAND=\${PROMPT_COMMAND:-}; export SPRINTENGINE_USER_PROMPT_COMMAND ;; esac`,
      // Theirs runs AFTER ours, which is the order the emitter is built for:
      // its last act is to put `$?` back, so a command appended behind it still
      // reads the real exit status. A plain assignment rather than
      // `export NAME=…` so no shell can field-split the joined value.
      `PROMPT_COMMAND=${quotePosix(SHELL_INTEGRATION_BASH_PROMPT_COMMAND)}\${SPRINTENGINE_USER_PROMPT_COMMAND:+"; $SPRINTENGINE_USER_PROMPT_COMMAND"}`,
      'export PROMPT_COMMAND',
    ].join('; ')
  }
  if (shellName === 'zsh' && zdotdir) {
    return [
      // Captured before it is replaced, and guarded so a relaunch inside one of
      // our own terminals does not record the shim directory as "the user's".
      `if [ "\${ZDOTDIR:-}" != ${quotePosix(zdotdir)} ]; then export SPRINTENGINE_USER_ZDOTDIR="\${ZDOTDIR:-$HOME}"; fi`,
      `export ZDOTDIR=${quotePosix(zdotdir)}`,
    ].join('; ')
  }
  return null
}

function isLoginShell(shellName: string | undefined): boolean {
  return shellName === 'bash' || shellName === 'zsh'
}

function isExecutableFile(filePath: string | undefined): filePath is string {
  if (!filePath) return false
  try {
    const stats = statSync(filePath)
    return stats.isFile()
  } catch {
    return false
  }
}

function assertExistingDirectory(dirPath: string): void {
  try {
    if (statSync(dirPath).isDirectory()) return
  } catch {
    // Fall through to the clearer terminal-specific error below.
  }

  throw new Error(`Terminal working directory does not exist: ${dirPath}`)
}

function getPosixShellPath(): string {
  const configuredShell = process.env.SHELL?.trim()
  if (configuredShell?.startsWith('/') && isExecutableFile(configuredShell)) {
    return configuredShell
  }

  const fallbackShell = ['/bin/zsh', '/bin/bash', '/usr/bin/zsh', '/usr/bin/bash', '/bin/sh'].find(isExecutableFile)
  return fallbackShell ?? 'sh'
}

function buildInteractiveShellExec(shellPath: string, shellName: string | undefined): string {
  const loginArg = isLoginShell(shellName) ? ' -l' : ''
  return `exec ${quotePosixCommand(shellPath)}${loginArg}`
}

// A startup script for a shell on this machine (macOS, Linux, This PC). A WSL
// launch's script is written inside the distribution instead; see
// `wslStartupScript`.
function createTerminalStartupScript(sessionId: string, extension: 'sh' | 'ps1', content: string): string {
  const scriptDirectory = join(userDataDir(), 'terminal-startup')
  const safeSessionId = sessionId.replace(/[^A-Za-z0-9._-]/g, '_')
  const scriptPath = join(scriptDirectory, `${safeSessionId}-${Date.now()}.${extension}`)
  mkdirSync(scriptDirectory, { recursive: true })
  writeFileSync(scriptPath, `${content.trim()}\n`, { encoding: 'utf8', mode: 0o600 })
  return scriptPath
}

/**
 * A WSL launch's startup script, as a file for the helper to write into its
 * private launch directory inside the distribution, and the Linux path it is
 * run from. Never a Windows file read through `/mnt/<drive>`: a distribution
 * that mounts its drives elsewhere (`[automount] root = /`), or not at all,
 * would not find it. Throws when the helper is not up, which is the one
 * reason there is no directory to name.
 */
function wslStartupScript(
  sessionId: string,
  host: WslLaunchTarget,
  content: (scriptPath: string) => string,
): { path: string; file: HostLaunchFile } {
  const dir = requireWslSessionDir(host)
  const safeSessionId = sessionId.replace(/[^A-Za-z0-9._-]/g, '_')
  const path = `${dir}/${safeSessionId}-${Date.now()}.sh`
  return { path, file: { path, content: `${content(path).trim()}\n` } }
}

function requireWslSessionDir(host: WslLaunchTarget): string {
  if (host.sessionDir) return host.sessionDir
  throw new Error(
    `The WSL helper for ${host.distro ?? 'this distribution'} is not running, so nothing can be started there. ` +
      'Try again in a moment; if it keeps failing, Settings ▸ Machines says why.',
  )
}

/**
 * The WSL startup script's first commands: record this shell's Linux pid in
 * the helper's private directory, then delete the script. The script is one
 * line, which bash has read whole before running any of it, and it holds the
 * launch's secrets (a provider key, the MCP channel token); once read it is
 * not left on disk for anything else running as this user to find.
 */
function wslPidFileLine(scriptPath: string, host: WslLaunchTarget): string {
  const key = wslSessionPidKey(scriptPath)
  const pid = key && host.pidDir ? wslSessionPidFileCommand(host.pidDir, key) : ''
  // Then the score the kernel's out-of-memory killer reads, raised so this
  // terminal and its agent go before the app's server in the distribution;
  // the script ends in an `exec`, so whatever it runs inherits it.
  return [pid, `rm -f -- ${quotePosix(scriptPath)}`, RAISE_OOM_SCORE_SHELL_LINE].filter(Boolean).join('; ')
}

/**
 * `wsl.exe` arguments that run a startup script in the host's distribution,
 * else the one `cwd` belongs to (a `\\wsl.localhost\<distro>\…` folder),
 * else the default distribution. Exported for its test.
 */
export function wslStartupArgs(cwd: string, startupScriptPath: string, distro?: string | null): string[] {
  return [...wslDistroArgs(distro || wslDistroForPath(cwd)), '-e', 'bash', '-li', toWslPath(startupScriptPath)]
}

// A WSL launch's files are Linux paths inside the distribution, which this
// file system cannot open; the host removes those (`discardLaunchFiles`).
function isForeignLaunchPath(path: string): boolean {
  return process.platform === 'win32' && path.startsWith('/')
}

export function cleanupTerminalStartupScript(scriptPath: string | undefined): void {
  if (!scriptPath || isForeignLaunchPath(scriptPath)) return
  void unlink(scriptPath).catch(() => {})
}

// ── Host context ────────────────────────────────────────────────────────────
//
// Everything the host wants the agent to know that is NOT the user's request —
// today: an attached design system, and the project's Knowledge Graph. It used
// to be two sentences the RENDERER pasted after the user's prompt, which meant
// the model could not tell host from user, a resumed session was never told at
// all, and a headless launch got only half of it. It is built here instead,
// because this is the one seam every launcher passes through: the interactive
// spawn, the mobile spawn, and `AgentLaunchService` (gateway, automations) all
// reach the pty through `getShellLaunchConfig`.
//
// The manifest decides the channel (`contextInjection`), not this file.

/** Where per-session context documents live, beside the startup scripts. */
const HOST_CONTEXT_DIRECTORY = 'host-context'

/**
 * Exported for terminal-launch.test.ts: the delivery decision and the path
 * normalisation over it are the rules this file owns, and driving them through
 * `getShellLaunchConfig` would need a real Electron `userData` and a real
 * workspace on disk. The manifest-by-manifest argv/env each mode actually
 * produces is proved in agent-launch-render.test.ts, against the bundled
 * manifests and through the same renderer every launch uses.
 */
export type HostContextDelivery = {
  /** The manifest's declared channel. A CLI declaring none falls back to `prompt`. */
  mode: PluginContextInjectionMode
  /** The document, or null when the host has nothing to say about this launch. */
  document: string | null
  /** Where it was written (markdown file, or a Cursor plugin directory). Null in `prompt` mode. */
  filePath: string | null
}

/**
 * Resolve, build and (for the out-of-band channels) write this launch's host
 * context.
 *
 * The design-system predicate is unchanged from the renderer's: the document
 * carries a design section when and only when `<executionRoot>/design-system/`
 * exists — deliberately KG-independent, so a repo with a design system and no
 * knowledge graph still gets told. A failed write degrades to no context rather
 * than to an empty flag: `--append-system-prompt-file ""` is worse than silence.
 *
 * `onHost` is a WSL launch's: the document is not written here but added to
 * `files` under the helper's launch directory `dir` (with its paths as Linux
 * names them), and `filePath` is its Linux path.
 */
export function resolveHostContextDelivery(input: {
  cwd: string
  sessionId: string
  cli: AgentCli
  memoryRootPath?: string
  memoryRelativeRoot?: string
  onHost?: { dir: string; files: HostLaunchFile[] }
  /** The session is an agent bound to a workspace, so it can call the editor tools. */
  editorTools?: boolean
}): HostContextDelivery {
  const injection = getPluginManifest(input.cli)?.contextInjection
  const mode = injection?.mode ?? 'prompt'
  const bundlePath = join(input.cwd, DESIGN_SYSTEM_BUNDLE_DIRECTORY_NAME)
  const attached = designSystemAttached(bundlePath)
  const document = buildHostContextDocument({
    ...(attached ? { designSystem: { bundlePath } } : {}),
    // `memoryRootPath` is set only when the configured root actually resolved,
    // so its presence IS the ok/not-ok the shared builder asks for — the same
    // pair the launch already carries into the session env.
    ...(input.memoryRootPath || input.memoryRelativeRoot
      ? {
          knowledge: {
            ok: Boolean(input.memoryRootPath),
            ...(input.memoryRootPath ? { rootPath: input.memoryRootPath } : {}),
            ...(input.memoryRelativeRoot ? { relativeRoot: input.memoryRelativeRoot } : {}),
          },
        }
      : {}),
    // Out-of-band channels only. On the prompt fallback the document is pasted
    // after the person's first message, and four lines of tool advice are not
    // worth putting in their words; those CLIs learn the editor tools from the
    // tool descriptions and the studio-workspaces skill instead.
    ...(input.editorTools && mode !== 'prompt' ? { editorTools: true } : {}),
  })
  if (!document || mode === 'prompt') return { mode, document, filePath: null }
  if (input.onHost) {
    const hostDocument = normalizeTextPaths(document, 'wsl', [input.cwd, input.memoryRootPath]) ?? document
    const base = `${input.onHost.dir}/host-context-${hostContextSessionKey(input.sessionId, input.cwd)}`
    if (contextInjectionWritesPluginDir(injection)) {
      input.onHost.files.push(
        { path: `${base}/${CURSOR_HOST_CONTEXT_PLUGIN_MANIFEST_REL}`, content: buildCursorHostContextPluginManifest() },
        {
          path: `${base}/${CURSOR_HOST_CONTEXT_PLUGIN_RULE_REL}`,
          content: buildCursorHostContextRuleFile(hostDocument),
        },
      )
      return { mode, document, filePath: base }
    }
    input.onHost.files.push({ path: `${base}.md`, content: `${hostDocument}\n` })
    return { mode, document, filePath: `${base}.md` }
  }
  const filePath = contextInjectionWritesPluginDir(injection)
    ? writeHostContextCursorPlugin(input.sessionId, input.cwd, document)
    : writeHostContextFile(input.sessionId, input.cwd, document)
  return { mode, document, filePath }
}

/**
 * True when this manifest's argv channel is `--plugin-dir {{contextFile}}`.
 * Cursor has no system-prompt flag; the document is packed as a one-session
 * plugin directory and that path is what `{{contextFile}}` names.
 */
function contextInjectionWritesPluginDir(
  injection: { mode?: PluginContextInjectionMode; args?: string[] } | undefined,
): boolean {
  return injection?.mode === 'argv' && Boolean(injection.args?.includes('--plugin-dir'))
}

/** Never let a probe failure (a permission error on the root) fail a launch. */
function designSystemAttached(bundlePath: string): boolean {
  try {
    return existsSync(bundlePath)
  } catch {
    return false
  }
}

function hostContextSessionKey(sessionId: string, cwd: string): string {
  return (
    sessionId.replace(/[^A-Za-z0-9._-]/g, '_') || `cwd-${createHash('sha1').update(cwd).digest('hex').slice(0, 12)}`
  )
}

/**
 * Write the document under `<userData>/host-context/<sessionId>.md`, overwriting
 * on every launch and resume. Returns null when it cannot be written (outside a
 * real Electron app there is no `userData`), which the caller reads as "deliver
 * nothing".
 *
 * A launch with no session id to name the file after is real: a bare
 * `codex resume` passes an empty id. It falls back to a digest of the execution
 * root, which is what the document is actually derived from anyway.
 */
function writeHostContextFile(sessionId: string, cwd: string, document: string): string | null {
  try {
    const directory = join(userDataDir(), HOST_CONTEXT_DIRECTORY)
    const filePath = join(directory, `${hostContextSessionKey(sessionId, cwd)}.md`)
    mkdirSync(directory, { recursive: true })
    writeFileSync(filePath, `${document}\n`, { encoding: 'utf8', mode: 0o600 })
    return filePath
  } catch {
    return null
  }
}

/**
 * Pack the document as a Cursor plugin directory and return that directory.
 * `--plugin-dir` requires a directory (CLI 2026.09.10 exits if the path is a
 * file); a markdown file cannot be passed. The rule is always-apply so resume
 * still sees it — `sessionStart` does not re-fire on `--continue`.
 */
function writeHostContextCursorPlugin(sessionId: string, cwd: string, document: string): string | null {
  try {
    const pluginRoot = join(userDataDir(), HOST_CONTEXT_DIRECTORY, hostContextSessionKey(sessionId, cwd))
    const manifestPath = join(pluginRoot, CURSOR_HOST_CONTEXT_PLUGIN_MANIFEST_REL)
    const rulePath = join(pluginRoot, CURSOR_HOST_CONTEXT_PLUGIN_RULE_REL)
    mkdirSync(dirname(manifestPath), { recursive: true })
    mkdirSync(dirname(rulePath), { recursive: true })
    writeFileSync(manifestPath, buildCursorHostContextPluginManifest(), { encoding: 'utf8', mode: 0o600 })
    writeFileSync(rulePath, buildCursorHostContextRuleFile(document), { encoding: 'utf8', mode: 0o600 })
    return pluginRoot
  } catch {
    return null
  }
}

// ── A first message too long for the command line ───────────────────────────
//
// `planAgentLaunch` decides; these write the file a `file` overflow names and
// turn the decision into what the caller acts on. A file is written beside the
// host-context documents on this machine, or (WSL) added to the launch's files
// inside the distribution, where the CLI that reads it runs.

const LAUNCH_PROMPT_DIRECTORY = 'launch-prompts'

function writeLaunchPromptFile(sessionId: string, cwd: string, text: string): string | null {
  try {
    const directory = join(userDataDir(), LAUNCH_PROMPT_DIRECTORY)
    // Named per launch, not per session: a relaunch under the same session id
    // must not have its file reaped by the previous pty's exit.
    const filePath = join(directory, `${hostContextSessionKey(sessionId, cwd)}-${randomUUID()}.md`)
    mkdirSync(directory, { recursive: true })
    writeFileSync(filePath, text, { encoding: 'utf8', mode: 0o600 })
    return filePath
  } catch {
    return null
  }
}

/** The plan options for a launch on `target`, with a prompt file written where that launch can read it. */
function launchPlanOptions(
  target: HostLaunchTarget,
  sessionId: string,
  cwd: string,
  onHost?: { dir: string; files: HostLaunchFile[] },
): AgentLaunchPlanOptions {
  return {
    budget: launchArgBudgetFor(target.kind),
    writePromptFile: (text) => {
      if (!onHost) return writeLaunchPromptFile(sessionId, cwd, text)
      const path = `${onHost.dir}/launch-prompt-${hostContextSessionKey(sessionId, cwd)}-${randomUUID()}.md`
      onHost.files.push({ path, content: text })
      return path
    },
  }
}

/** What the caller of a launch acts on once the plan moved the prompt off the command line. */
function promptDeliveryConfig(
  delivery: AgentPromptDelivery | undefined,
): Pick<ShellLaunchConfig, 'deferredPrompt' | 'launchPromptPath'> {
  if (delivery?.kind === 'input') return { deferredPrompt: delivery.text }
  if (delivery?.kind === 'file') return { launchPromptPath: delivery.path }
  return {}
}

/** Reap a session's host-context document or plugin directory. */
export function cleanupHostContextFile(contextPath: string | undefined): Promise<void> {
  if (!contextPath || isForeignLaunchPath(contextPath)) return Promise.resolve()
  return stat(contextPath)
    .then((info) => (info.isDirectory() ? rm(contextPath, { recursive: true, force: true }) : unlink(contextPath)))
    .catch(() => {})
}

/**
 * The `contextFile` / `contextText` a manifest's templates render against, in
 * the path style this launch's shell speaks.
 *
 * Both are withheld together when the document could not be written, so a
 * manifest that spends `{{contextFile}}` never renders a flag with an empty
 * value. `contextText` is path-normalized too: it names the design-system folder
 * and the knowledge root absolutely, and a Windows path inside a document handed
 * to a CLI running under WSL points at nothing.
 */
/** What a manifest's `contextInjection` templates render against. */
export type HostContextRenderInputs = { contextFile?: string; contextText?: string }

export function hostContextRenderInputs(
  delivery: HostContextDelivery,
  target: 'windows' | 'wsl' | null,
  paths: Array<string | undefined>,
): HostContextRenderInputs {
  if (delivery.mode === 'prompt' || !delivery.document || !delivery.filePath) return {}
  if (!target) return { contextFile: delivery.filePath, contextText: delivery.document }
  const allPaths = [...paths, delivery.filePath]
  return {
    contextFile: target === 'wsl' ? toWslPath(delivery.filePath) : wslToWindowsPath(delivery.filePath),
    contextText: normalizeTextPaths(delivery.document, target, allPaths) ?? delivery.document,
  }
}

/**
 * The initial prompt for a CLI with no out-of-band channel at all: the document
 * wrapped in `<host-context>` tags, AFTER the user's request so the title hook
 * sees the person's words first.
 *
 * Only when there IS a request. A CLI launched with nothing typed is meant to
 * sit at its prompt waiting for the user; handing it a host-context block as its
 * first message would start it working on the host's words.
 */
export function applyHostContextToPrompt(
  delivery: HostContextDelivery,
  initialPrompt: string | undefined,
): string | undefined {
  if (delivery.mode !== 'prompt' || !delivery.document || !initialPrompt?.trim()) return initialPrompt
  return wrapHostContextForPrompt(delivery.document, initialPrompt)
}

function buildWslShellScript(
  scriptPath: string,
  cwd: string,
  sessionId: string,
  resume = false,
  cli: AgentCli = 'codex',
  initialPrompt?: string,
  cliRuntime?: CliRuntimeSettings,
  cliPermissionPreset: CliPermissionSetting = 'none',
  cliModel?: string,
  memoryRootPath?: string,
  managedMcpEnv?: Record<string, string>,
  providerLaunchEnv?: Record<string, string>,
  cliReasoning?: string,
  hostContext: HostContextRenderInputs = {},
  host: WslLaunchTarget = DEFAULT_WSL_TARGET,
  planOptions: AgentLaunchPlanOptions = { budget: launchArgBudgetFor('wsl') },
  onPlan?: (plan: PlannedAgentLaunch) => void,
  launchSkills: readonly string[] = [],
): string {
  const shellInitialPrompt = normalizeTextPaths(initialPrompt, 'wsl', [cwd, memoryRootPath])
  return [
    wslPidFileLine(scriptPath, host),
    buildUserShellStartup(),
    wslHostEnvExports(host),
    wslIdentityExports(host),
    `cd ${quotePosix(toWslPath(cwd))}`,
    buildLaunchShellBootstrap(managedMcpEnv, providerLaunchEnv),
    buildAgentLaunchCommand(
      cli,
      sessionId,
      resume,
      shellInitialPrompt,
      cliRuntime,
      cliPermissionPreset,
      cliModel,
      cliReasoning,
      undefined,
      hostContext,
      pluginDirsForLaunch(cli, host, launchSkills),
      launchSettingsForLaunch(cli, cwd, host),
      planOptions,
      onPlan,
    ),
    wslShellExec(host),
  ]
    .filter(Boolean)
    .join('; ')
}

type WslLaunchTarget = Extract<HostLaunchTarget, { kind: 'wsl' }>

const DEFAULT_WSL_TARGET: WslLaunchTarget = { kind: 'wsl', distro: null, env: {} }

/**
 * The launch target a caller that named no host gets: this machine, as the
 * platform runs it. Only the host registry ever hands out a WSL target.
 */
function defaultLaunchTarget(): HostLaunchTarget {
  return process.platform === 'win32' ? { kind: 'windows' } : { kind: 'posix' }
}

/**
 * The machine's own environment (Settings ▸ Machines), exported before the
 * launch's own bootstrap so a provider's endpoint or a module's variable still
 * wins over a machine-wide default of the same name.
 */
function wslHostEnvExports(host: WslLaunchTarget): string {
  return Object.entries(host.env)
    .filter(([key]) => /^[A-Za-z_][A-Za-z0-9_]*$/.test(key))
    .map(([key, value]) => `export ${key}=${quotePosix(value)}`)
    .join('; ')
}

/**
 * The agent's identity as `export` lines: which workspace and agent this is,
 * the CLI, and the helper's socket in this distribution, which the hooks, the
 * status line and OpenCode's plugin report to. The socket is always the
 * helper's (the identity handed in names this machine's own, which Linux
 * cannot open), and is left out when the helper is not up. Last, the launch's
 * MCP channel token, which the app's MCP bridge under this CLI opens its
 * channel with; nothing else in the distribution has it.
 */
function wslIdentityExports(host: WslLaunchTarget): string {
  const identity: Record<string, string> = { ...host.identity }
  delete identity.SPRINTENGINE_AGENT_STATE_SOCKET
  if (identity.SPRINTENGINE_AGENT_ID && host.integration) {
    identity.SPRINTENGINE_AGENT_STATE_SOCKET = host.integration.agentStateSocketPath
  }
  const lines = Object.entries(identity)
    .filter(([key, value]) => (AGENT_IDENTITY_ENV_KEYS as readonly string[]).includes(key) && value !== '')
    .map(([key, value]) => `export ${key}=${quotePosix(value)}`)
  if (host.channelToken) lines.push(`export ${MCP_CHANNEL_TOKEN_ENV}=${quotePosix(host.channelToken)}`)
  return lines.join('; ')
}

/**
 * What a WSL terminal ends in once its CLI exits (or at once, for a plain
 * terminal): the machine's configured shell, else a login bash. The script's
 * `exec` keeps the pid its pid file recorded, so the reaper still reads the
 * right subtree whatever shell this is.
 */
function wslShellExec(host: WslLaunchTarget): string {
  return `exec ${host.shell?.trim() || 'bash -li'}`
}

export function getShellLaunchConfig(
  cwd: string,
  sessionId: string,
  resume = false,
  cli: AgentCli = 'codex',
  initialPrompt?: string,
  cliRuntimes?: Partial<Record<AgentCli, Partial<CliRuntimeSettings>>>,
  cliPermissionPreset: CliPermissionSetting = 'none',
  cliModel?: string,
  memoryRootPath?: string,
  memoryRelativeRoot?: string,
  managedMcpEnv?: Record<string, string>,
  cliAuthToken?: string,
  cliReasoning?: string,
  // Absolute binary path resolved by the spawn pre-flight; see
  // AgentLaunchRenderInput.resolvedBinaryPath. Undefined leaves the launch on
  // the manifest binary name (Windows/WSL, or an undecided probe).
  resolvedBinaryPath?: string,
  // The machine this runs on (its host's `launchTarget()`). Absent is this
  // machine as the platform runs it, which is all macOS and Linux ever have.
  launchHost: HostLaunchTarget = defaultLaunchTarget(),
  // What else the host context says about this launch. `editorTools`: the
  // session is an agent bound to a workspace, so it can open files and diffs
  // for the person through the app's gateway.
  hostContextOptions: {
    editorTools?: boolean
    /**
     * The bundled skills this launch's prompt invokes (a Backlog handoff's
     * `backlog`). A launch that takes the app's plugin
     * directories is handed each as a plugin of its own; see
     * `bundledSkillDeliveredAtLaunch`, which answers from the same copy.
     */
    launchSkills?: readonly string[]
  } = {},
): ShellLaunchConfig {
  assertExistingDirectory(cwd)

  const cliRuntime = getCliRuntimeSettings(cli, cliRuntimes)

  // The host's own context for this launch (an attached design system, the
  // project's Knowledge Graph), built here so EVERY
  // launcher gets the same document — interactive, mobile, and the headless
  // AgentLaunchService all arrive at this function. The manifest's
  // `contextInjection` decides the channel; only the prompt fallback touches
  // the user's message, and then only by putting the block after it. On WSL
  // the document goes with the startup script, into the distribution.
  const hostFiles: HostLaunchFile[] = []
  const onHost = launchHost.kind === 'wsl' ? { dir: requireWslSessionDir(launchHost), files: hostFiles } : undefined
  const hostContext = resolveHostContextDelivery({
    cwd,
    sessionId,
    cli,
    ...(memoryRootPath ? { memoryRootPath } : {}),
    ...(memoryRelativeRoot ? { memoryRelativeRoot } : {}),
    ...(onHost ? { onHost } : {}),
    ...(hostContextOptions.editorTools ? { editorTools: true } : {}),
  })
  const launchPrompt = applyHostContextToPrompt(hostContext, initialPrompt)
  const hostContextPath = hostContext.filePath ?? undefined
  // Whether the prompt rode the command line, set by whichever builder below
  // renders this launch (see `planAgentLaunch`).
  let promptDelivery: AgentPromptDelivery | undefined

  // CLI manifests may redirect the agent at an alternate API endpoint via
  // `launch.env` (e.g. the Z.AI runtime points the `claude` binary at Z.AI's
  // Anthropic-compatible endpoint). Render it once here with the resolved auth
  // token, then inject it into the spawned env (PTY env for native, bootstrap
  // exports for WSL). Empty for the ordinary CLIs, so their launch is unchanged.
  // A manifest delivering host context through the environment (OpenCode) is
  // rendered by the same call, so it rides the same injection.
  const providerLaunchEnv = renderCliLaunchEnv({
    cli,
    sessionId,
    initialPrompt: launchPrompt,
    cliRuntime,
    cliPermissionPreset,
    cliModel,
    cliReasoning,
    colorScheme: getColorScheme(),
    secretToken: cliAuthToken,
    ...hostContextRenderInputs(hostContext, launchHost.kind === 'posix' ? null : launchHost.kind, [
      cwd,
      memoryRootPath,
    ]),
  })

  if (launchHost.kind === 'windows') {
    const windowsCwd = wslToWindowsPath(cwd)
    const windowsHostContext = hostContextRenderInputs(hostContext, 'windows', [cwd, memoryRootPath])
    const shellInitialPrompt = normalizeTextPaths(launchPrompt, 'windows', [
      cwd,
      memoryRootPath,
      hostContext.filePath ?? undefined,
    ])
    if (!isWindowsPath(windowsCwd)) {
      throw new Error(
        `Workspace path "${cwd}" is not available as a Windows path, so ${cli} cannot run on This PC. ` +
          'Run this workspace on its WSL machine instead.',
      )
    }
    const startupScriptPath = createTerminalStartupScript(
      sessionId,
      'ps1',
      buildNativeAgentLaunchPowerShellScript(
        cli,
        sessionId,
        resume,
        windowsCwd,
        shellInitialPrompt,
        cliRuntime,
        cliPermissionPreset,
        cliModel,
        cliReasoning,
        windowsHostContext,
        pluginDirsForLaunch(cli, launchHost, hostContextOptions.launchSkills),
        launchSettingsForLaunch(cli, cwd, launchHost),
        launchPlanOptions(launchHost, sessionId, cwd),
        (plan) => {
          promptDelivery = plan.promptDelivery
        },
      ),
    )

    return {
      command: 'powershell.exe',
      args: ['-NoLogo', '-NoExit', '-ExecutionPolicy', 'Bypass', '-File', startupScriptPath],
      env: mergeProviderLaunchEnv(
        {
          ...getTerminalEnv(),
          ...managedMcpEnv,
        },
        providerLaunchEnv,
      ),
      cwd: windowsCwd,
      pathStyle: 'windows',
      startupScriptPath,
      ...(hostContextPath ? { hostContextPath } : {}),
      ...promptDeliveryConfig(promptDelivery),
    }
  }

  if (launchHost.kind === 'wsl') {
    const startup = wslStartupScript(sessionId, launchHost, (scriptPath) =>
      buildWslShellScript(
        scriptPath,
        cwd,
        sessionId,
        resume,
        cli,
        launchPrompt,
        cliRuntime,
        cliPermissionPreset,
        cliModel,
        memoryRootPath,
        managedMcpEnv,
        providerLaunchEnv,
        cliReasoning,
        hostContextRenderInputs(hostContext, 'wsl', [cwd, memoryRootPath]),
        launchHost,
        launchPlanOptions(launchHost, sessionId, cwd, onHost),
        (plan) => {
          promptDelivery = plan.promptDelivery
        },
        hostContextOptions.launchSkills,
      ),
    )
    return {
      command: 'wsl.exe',
      args: wslStartupArgs(cwd, startup.path, launchHost.distro),
      // The agent's identity and the helper's socket travel in the startup
      // script as `export` lines (see `wslIdentityExports`), not through this
      // env: a Windows variable reaches Linux only when `WSLENV` names it.
      env: getTerminalEnv(),
      pathStyle: 'wsl',
      startupScriptPath: startup.path,
      hostFiles: [startup.file, ...hostFiles],
      ...(hostContextPath ? { hostContextPath } : {}),
      ...promptDeliveryConfig(promptDelivery),
    }
  }

  const shellPath = getPosixShellPath()
  const shellName = shellPath.split(/[\\/]/).at(-1)
  const launchCommand = [
    buildLaunchShellBootstrap(managedMcpEnv, providerLaunchEnv),
    buildAgentLaunchCommand(
      cli,
      sessionId,
      resume,
      launchPrompt,
      cliRuntime,
      cliPermissionPreset,
      cliModel,
      cliReasoning,
      resolvedBinaryPath,
      hostContextRenderInputs(hostContext, null, []),
      pluginDirsForLaunch(cli, launchHost, hostContextOptions.launchSkills),
      launchSettingsForLaunch(cli, cwd, launchHost),
      launchPlanOptions(launchHost, sessionId, cwd),
      (plan) => {
        promptDelivery = plan.promptDelivery
      },
    ),
    buildInteractiveShellExec(shellPath, shellName),
  ]
    .filter(Boolean)
    .join('; ')
  const startupScriptPath = createTerminalStartupScript(sessionId, 'sh', launchCommand)

  return {
    command: shellPath,
    args: isLoginShell(shellName) ? ['-l', startupScriptPath] : [startupScriptPath],
    cwd,
    env: mergeProviderLaunchEnv(
      {
        ...getTerminalEnv(),
        ...managedMcpEnv,
      },
      providerLaunchEnv,
    ),
    pathStyle: 'posix',
    startupScriptPath,
    ...(hostContextPath ? { hostContextPath } : {}),
    ...promptDeliveryConfig(promptDelivery),
  }
}

export function getPlainShellLaunchConfig(
  cwd: string,
  sessionId = 'plain-terminal',
  // The machine the terminal opens on; see getShellLaunchConfig.
  launchHost: HostLaunchTarget = defaultLaunchTarget(),
): ShellLaunchConfig {
  assertExistingDirectory(cwd)

  if (launchHost.kind !== 'posix') {
    const windowsCwd = wslToWindowsPath(cwd)

    // This PC opens PowerShell in any folder Windows can name. One it cannot
    // (a bare Linux path) is opened in the default distribution by the caller,
    // which hands this a WSL target for it.
    if (launchHost.kind === 'windows' && isWindowsPath(windowsCwd)) {
      return {
        command: 'powershell.exe',
        args: ['-NoLogo'],
        env: getTerminalEnv(),
        cwd: windowsCwd,
        pathStyle: 'windows',
      }
    }

    const wslHost = launchHost.kind === 'wsl' ? launchHost : DEFAULT_WSL_TARGET
    const startup = wslStartupScript(sessionId, wslHost, (scriptPath) =>
      [
        wslPidFileLine(scriptPath, wslHost),
        buildUserShellStartup(),
        wslHostEnvExports(wslHost),
        `cd ${quotePosix(toWslPath(cwd))}`,
        wslShellExec(wslHost),
      ]
        .filter(Boolean)
        .join('; '),
    )

    return {
      command: 'wsl.exe',
      args: wslStartupArgs(cwd, startup.path, wslHost.distro),
      pathStyle: 'wsl',
      startupScriptPath: startup.path,
      hostFiles: [startup.file],
    }
  }

  const shellPath = getPosixShellPath()
  const shellName = shellPath.split(/[\\/]/).at(-1)
  // Only a shell pane gets shell integration — OSC 7 and OSC 133 alike. An
  // agent pane runs a CLI rather than a prompt (nothing would fire the hook),
  // and a mesh pane must not resolve a local path at all — so this is the one
  // launcher that arms it. The 133 marks are shell ergonomics and nothing else:
  // agent phase comes from `agent-state.ts` over the state socket, and no pane
  // ever derives it from what a shell printed.
  const shellIntegrationSetup = buildShellIntegrationSetup(
    shellName,
    shellName === 'zsh' ? ensureShellIntegrationZshZdotdir() : null,
  )
  const launchCommand = [
    ...(shellIntegrationSetup ? [shellIntegrationSetup] : []),
    buildInteractiveShellExec(shellPath, shellName),
  ]
    .filter(Boolean)
    .join('; ')
  const startupScriptPath = createTerminalStartupScript(sessionId, 'sh', launchCommand)

  return {
    command: shellPath,
    cwd,
    args: isLoginShell(shellName) ? ['-l', startupScriptPath] : [startupScriptPath],
    env: getTerminalEnv(),
    pathStyle: 'posix',
    startupScriptPath,
  }
}

// Exported for launch regression coverage: the startup script a native Windows
// agent launch runs.
export function buildNativeAgentLaunchPowerShellScript(
  cli: AgentCli,
  sessionId: string,
  resume: boolean,
  cwd: string,
  initialPrompt: string | undefined,
  cliRuntime: CliRuntimeSettings,
  cliPermissionPreset: CliPermissionSetting = 'none',
  cliModel?: string,
  cliReasoning?: string,
  hostContext: HostContextRenderInputs = {},
  pluginDirs: string[] = [],
  launchSettings?: Record<string, unknown>,
  planOptions: AgentLaunchPlanOptions = { budget: launchArgBudgetFor('windows') },
  onPlan?: (plan: PlannedAgentLaunch) => void,
): string {
  // Codex needs an explicit workspace and npm-shim unwrapping on Windows.
  // Its argument rendering is shared with the other launch paths.
  if (pluginIdForCli(cli) === 'codex') {
    return buildCodexLegacyNativeAgentLaunchPowerShellScript(
      sessionId,
      resume,
      cwd,
      initialPrompt,
      cliRuntime,
      cliPermissionPreset,
      cliModel,
      cliReasoning,
      hostContext,
      getColorScheme(),
      planOptions,
      onPlan,
    )
  }

  const plan = planAgentLaunch(
    {
      cli,
      sessionId,
      resume,
      initialPrompt,
      cliRuntime,
      cliPermissionPreset,
      cliModel,
      cliReasoning,
      colorScheme: getColorScheme(),
      pluginDirs,
      ...(launchSettings ? { launchSettings } : {}),
      ...hostContext,
    },
    planOptions,
  )
  onPlan?.(plan)
  const { argv, binary } = plan
  // argv[0] is the binary; the remainder are the arguments PowerShell needs
  // to base64-encode for round-trip safety through nested quoting layers.
  const args = argv.slice(1)
  return [
    `$ErrorActionPreference = 'Continue'`,
    `Set-Location -LiteralPath ${quotePowerShell(cwd)}`,
    `$command = ${quotePowerShell(binary)}`,
    `$arguments = @(${args.map((arg) => powerShellBase64Literal(arg)).join(', ')})`,
    ...powerShellTypedPromptEnvLines(plan.typedPromptEnv),
    ...buildNativeWindowsInvocation(args),
    ...powerShellClearTypedPromptEnvLines(plan.typedPromptEnv),
    ...(plan.promptDelivery.kind === 'input' ? [POWERSHELL_CLI_EXITED_LINE] : []),
  ].join('\r\n')
}

// The environment a launch whose first message is typed in adds (see
// `PlannedAgentLaunch.typedPromptEnv`), set for the CLI the script is about to
// start. PowerShell has no per-command assignment, so it is removed again once
// the CLI returns: the session the script leaves behind must not run the same
// CLI by hand with its update check silently off.
function powerShellTypedPromptEnvLines(env: Record<string, string> | undefined): string[] {
  return typedPromptEnvEntries(env).map(([name, value]) => `$env:${name} = ${quotePowerShell(value)}`)
}

function powerShellClearTypedPromptEnvLines(env: Record<string, string> | undefined): string[] {
  return typedPromptEnvEntries(env).map(([name]) => `Remove-Item Env:${name} -ErrorAction SilentlyContinue`)
}

function typedPromptEnvEntries(env: Record<string, string> | undefined): Array<[string, string]> {
  return Object.entries(env ?? {}).filter(([name]) => /^[A-Za-z_][A-Za-z0-9_]*$/.test(name))
}

// Exported for launch regression coverage. The legacy name is retained for
// callers; only workspace propagation and executable resolution are specific
// to Windows. Flags, context and resume behavior come from the manifest.
export function buildCodexLegacyNativeAgentLaunchPowerShellScript(
  sessionId: string,
  resume: boolean,
  cwd: string,
  initialPrompt: string | undefined,
  cliRuntime: CliRuntimeSettings,
  cliPermissionPreset: CliPermissionSetting = 'none',
  cliModel?: string,
  cliReasoning?: string,
  hostContext: HostContextRenderInputs = {},
  colorScheme?: 'light' | 'dark',
  // Fit the launch to the Windows command line (`planAgentLaunch`). Absent
  // renders it as-is, which is what the script's own tests pin.
  planOptions?: AgentLaunchPlanOptions,
  onPlan?: (plan: PlannedAgentLaunch) => void,
): string {
  const renderInput = {
    cli: 'codex' as const,
    sessionId,
    resume,
    initialPrompt,
    cliRuntime,
    cliPermissionPreset,
    cliModel,
    cliReasoning,
    colorScheme,
    ...hostContext,
  }
  let rendered: { argv: string[]; binary: string }
  let typedPrompt = false
  let typedPromptEnv: Record<string, string> | undefined
  if (planOptions) {
    const plan = planAgentLaunch(renderInput, planOptions)
    onPlan?.(plan)
    rendered = plan
    typedPrompt = plan.promptDelivery.kind === 'input'
    typedPromptEnv = plan.typedPromptEnv
  } else {
    rendered = renderAgentLaunchArgv(renderInput)
  }
  const { argv, binary } = rendered
  const args = ['-C', cwd, ...argv.slice(1)]
  // Use the same native quoting as other agents. Splatting through Windows
  // PowerShell 5.1 loses embedded quotes in TOML overrides and user prompts.
  const [encodeArgs, ...invoke] = buildNativeWindowsInvocation(args)

  return [
    `$ErrorActionPreference = 'Continue'`,
    `Set-Location -LiteralPath ${quotePowerShell(cwd)}`,
    `$command = ${quotePowerShell(binary)}`,
    `$arguments = @(${args.map((arg) => powerShellBase64Literal(arg)).join(', ')})`,
    encodeArgs,
    `$resolvedCommand = Get-Command $command -ErrorAction SilentlyContinue | Select-Object -First 1`,
    `$resolvedSource = if ($resolvedCommand) { $resolvedCommand.Source } else { $null }`,
    `$resolvedLeaf = if ($resolvedSource) { Split-Path -Leaf $resolvedSource } else { '' }`,
    `$isCodexNpmShim = $resolvedLeaf -in @('codex.cmd', 'codex.ps1')`,
    `if ($isCodexNpmShim) {`,
    `  $codexJs = Join-Path (Split-Path -Parent $resolvedSource) 'node_modules\\@openai\\codex\\bin\\codex.js'`,
    `  if (!(Test-Path -LiteralPath $codexJs)) { throw "Codex npm shim detected, but codex.js was not found at $codexJs." }`,
    `  $command = 'node.exe'`,
    `  $arguments = @($codexJs) + $arguments`,
    // A Windows filename cannot contain a double quote; this file path ends
    // in .js, so quoting it needs no trailing-backslash escaping either.
    `  $env:SPRINTENGINE_LAUNCH_ARGS = '"' + $codexJs + '" ' + $env:SPRINTENGINE_LAUNCH_ARGS`,
    `}`,
    ...powerShellTypedPromptEnvLines(typedPromptEnv),
    ...invoke,
    ...powerShellClearTypedPromptEnvLines(typedPromptEnv),
    ...(typedPrompt ? [POWERSHELL_CLI_EXITED_LINE] : []),
  ].join('\r\n')
}

function buildAgentLaunchCommand(
  cli: AgentCli,
  sessionId: string,
  resume = false,
  initialPrompt?: string,
  cliRuntime?: CliRuntimeSettings,
  cliPermissionPreset: CliPermissionSetting = 'none',
  cliModel?: string,
  cliReasoning?: string,
  resolvedBinaryPath?: string,
  hostContext: HostContextRenderInputs = {},
  pluginDirs: string[] = [],
  launchSettings?: Record<string, unknown>,
  planOptions: AgentLaunchPlanOptions = { budget: launchArgBudgetFor('posix') },
  onPlan?: (plan: PlannedAgentLaunch) => void,
): string {
  const { command, plan } = planAgentShellCommand(
    {
      cli,
      sessionId,
      resume,
      initialPrompt,
      cliRuntime,
      cliPermissionPreset,
      cliModel,
      cliReasoning,
      colorScheme: getColorScheme(),
      resolvedBinaryPath,
      pluginDirs,
      ...(launchSettings ? { launchSettings } : {}),
      ...hostContext,
    },
    planOptions,
  )
  onPlan?.(plan)
  return plan.promptDelivery.kind === 'input' ? `${command}; ${POSIX_CLI_EXITED_LINE}` : command
}

// A launch whose first message is typed in says when its CLI has exited, before
// the shell the script ends in starts (see `CLI_EXITED_SENTINEL`): that shell
// turns bracketed paste on too, and the message must never be typed into it.
// Only such a launch prints it, so every other launch is byte-for-byte as it was.
const POSIX_CLI_EXITED_LINE = `printf '\\033]${CLI_EXITED_OSC}\\007'`
const POWERSHELL_CLI_EXITED_LINE = `[Console]::Out.Write([string][char]27 + ']${CLI_EXITED_OSC}' + [char]7)`
