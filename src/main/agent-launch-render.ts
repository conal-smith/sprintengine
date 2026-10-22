import type { AgentCli, CliRuntimeSettings, ColorScheme } from '../shared/electron-api'
import type { CliPermissionSetting } from '../shared/cli-permission-mode'
import type { LoadedPlugin, PluginRenderContext } from '../shared/plugin-manifest'
import { LAUNCH_PROMPT_READS_AS_OPTION_MESSAGE, launchPromptReadsAsOption } from '../shared/agent-launch'

import { getPluginById } from './plugin-registry-instance'
import { launchArgvExceedsBudget, measureLaunchArgv, type LaunchArgBudget } from './launch-arg-budget'
import {
  renderPluginContextArgs,
  renderPluginLaunch,
  renderPluginResume,
  renderPluginTypedPromptEnv,
} from './plugin-render'

export function pluginIdForCli(cli: AgentCli): string {
  return cli
}

/**
 * Whether this CLI is handed the app's own plugin directories at launch.
 *
 * The one question both halves of the arrangement ask: the launch path, to
 * decide whether to pass `--plugin-dir`, and the workspace installers, to
 * decide whether to write the same skills and the same hook into the person's
 * repository. They must never disagree — a CLI answering true here and getting
 * a workspace install too would register the reporter twice and fire it twice
 * per event, which is the doubling the studio-plugin notes describe.
 *
 * Answers false for a CLI whose manifest is missing, so an unresolvable plugin
 * degrades to the behaviour that was there before this flag existed.
 */
export function cliTakesLaunchPlugins(cli: string): boolean {
  const plugin = getPluginById(cli)
  const args = plugin?.manifest.launchPlugins?.args
  return Array.isArray(args) && args.length > 0
}

// Resolves the effective command override for a launch, and the machine it is
// for. Uses the plugin-id key only; a blank command means "use the manifest
// binary".
export function resolveCliRuntimeSettings(
  cli: AgentCli,
  cliRuntimes?: Partial<Record<AgentCli, Partial<CliRuntimeSettings>>>,
): CliRuntimeSettings {
  const direct = cliRuntimes?.[cli]
  const command = (typeof direct?.command === 'string' ? direct.command : undefined) ?? ''
  return { command: command.trim(), ...(direct?.hostId ? { hostId: direct.hostId } : {}) }
}

export type AgentLaunchRenderInput = {
  cli: AgentCli
  sessionId: string
  resume?: boolean
  initialPrompt?: string
  cliRuntime?: CliRuntimeSettings
  // The preset, or the CLI's own mode id when one was chosen beside it
  // (`permissionRenderKey`): the manifest entry the launch renders.
  cliPermissionPreset?: CliPermissionSetting
  cliModel?: string
  // Selected reasoning-effort level. Consumed only by manifests declaring
  // reasoningSelection (today: Codex and Claude Code); rendered as
  // `reasoningArgs` only when it differs from the manifest's declared default,
  // so unset/default levels leave the launch argv unchanged. Claude Code
  // declares no default, so every explicitly picked level renders there.
  cliReasoning?: string
  // Host light/dark scheme to launch the CLI matching the app surface. Consumed
  // only by manifests declaring themeSelection (today: Claude Code); undefined
  // leaves the CLI on its own configured theme.
  colorScheme?: ColorScheme
  // Resolved provider auth token for CLIs whose manifest redirects the agent at
  // an alternate API endpoint (e.g. the Z.AI runtime, which runs the `claude`
  // binary against Z.AI's Anthropic-compatible endpoint). Exposed to the
  // manifest's `launch.env` templates as `{{secret}}` so the token is injected
  // into the spawned process env without ever appearing in argv. Undefined for
  // the ordinary CLIs (claude-code/codex/opencode), which declare no auth.
  secretToken?: string
  // Absolute path the availability probe resolved this CLI to, supplied by the
  // launch pre-flight (`preflightAgentCliLaunch`). Executing it is the whole
  // point: the probe consults the user's interactive shell, the launch shell
  // does not, so a binary on a ~/.zshrc-only PATH is otherwise detected and then
  // not found at launch. Undefined when the probe could not decide, which leaves
  // the bare name below.
  resolvedBinaryPath?: string
  // This launch's host-context document, in the two shapes a manifest's
  // `contextInjection` templates can spend it: the absolute path main wrote
  // (a markdown file, or for Cursor a plugin directory — already in the
  // launched shell's path style), and the document itself.
  // Both absent — the ordinary case, a project with no design system and no
  // knowledge graph — render no context args and no context env, so the launch
  // is byte-identical to what it was.
  contextFile?: string
  contextText?: string
  // The app-owned plugin directories this launch hands the CLI (its skills, its
  // agent-state hook and its MCP server), for manifests declaring
  // `launchPlugins`. Absent or empty renders no flag — which is what a build
  // whose plugin has not been materialised yet, or a CLI that takes no plugin
  // directory, gets.
  pluginDirs?: string[]
  // Settings this launch sends in the manifest's `launchSettings` document
  // (Claude Code's `--settings`), merged with the theme by `renderPluginLaunch`.
  // Today that is the status line the app reads a session's context-window
  // usage, cost and lines-changed from — the ONLY channel for it once the
  // workspace install is skipped, so a launch that drops it is a context ring
  // that never fills and nothing in the terminal to say so. Absent renders the
  // document the theme alone would have.
  launchSettings?: Record<string, unknown>
  // The CLI's own per-launch flags for the MCP servers and hooks the app hands
  // this session (see `launch-integration.ts`), for manifests that place
  // `integrationArgs`. Absent or empty renders nothing.
  integrationArgs?: string[]
  // Set by `planAgentLaunch` when the prompt is too long for the command line,
  // or is typed in because the manifest is `send-after-ready`: the prompt leaves
  // argv and the manifest's `promptInjection.overflow` args render in its place.
  // `input` renders no prompt at all (it is typed in once the CLI is up); `file`
  // renders a one-line note naming `promptFile`. Nothing else sets it, so every
  // other launch renders the argv it always did.
  promptOverflow?: { mode: 'input' } | { mode: 'file'; promptFile: string }
}

export type RenderedAgentLaunch = {
  argv: string[]
  binary: string
  plugin: LoadedPlugin
  // Environment variables the manifest's `launch.env` resolves to (with
  // `{{secret}}` and other variables substituted). Empty for manifests that
  // declare no `launch.env`. The caller injects these into the spawned PTY env
  // (and the WSL bootstrap) — they are intentionally NOT folded into argv.
  env: Record<string, string>
  // The first message this launch carries: what `{{prompt}}` renders, or what
  // an overflowed launch still owes the CLI.
  // Undefined for a launch with nothing to say.
  prompt?: string
}

class AgentLaunchRenderError extends Error {}

function resolveLaunchPlugin(cli: AgentCli): LoadedPlugin {
  const pluginId = pluginIdForCli(cli)
  const plugin = getPluginById(pluginId)
  if (!plugin) {
    throw new AgentLaunchRenderError(
      `No plugin manifest found for "${cli}" (looked up as "${pluginId}"). ` +
        `Check that resources/plugins/${pluginId}/plugin.json is bundled.`,
    )
  }
  return plugin
}

/**
 * What `{{prompt}}` renders when the prompt went to a file: one line, in the
 * person's voice because it stands where their message would have, pointing at
 * the file that holds the message itself.
 */
export function promptFileNote(promptFile: string): string {
  return `My request is in the attached file ${promptFile}. Read all of it and act on it as this message.`
}

export function renderAgentLaunchArgv(input: AgentLaunchRenderInput): RenderedAgentLaunch {
  const plugin = resolveLaunchPlugin(input.cli)
  const prompt = input.initialPrompt
  const rendered = renderWithPlugin(input, plugin, renderedPromptToken(input, prompt))
  return { ...rendered, prompt }
}

/** What `{{prompt}}` renders: the prompt, the note naming its file, or nothing once it is typed in. */
function renderedPromptToken(input: AgentLaunchRenderInput, prompt: string | undefined): string | undefined {
  const overflow = input.promptOverflow
  if (!overflow) return prompt
  return overflow.mode === 'file' ? promptFileNote(overflow.promptFile) : undefined
}

function buildLaunchRenderContext(
  input: AgentLaunchRenderInput,
  plugin: LoadedPlugin,
  prompt: string | undefined,
): { binary: string; context: PluginRenderContext } {
  // The probed path wins over a `cliRuntimes` command override because the probe
  // ran against that same override (detection is keyed by it) — the resolved
  // path is that command, made absolute. The bare name is the last resort.
  const binary = input.resolvedBinaryPath?.trim() || input.cliRuntime?.command?.trim() || plugin.manifest.binary
  const context: PluginRenderContext = {
    binary,
    sessionId: input.sessionId,
    prompt,
    permissionPreset: input.cliPermissionPreset,
    model: input.cliModel,
    reasoning: input.cliReasoning,
    colorScheme: input.colorScheme,
    // Only expose the secret variable when a token was resolved, so manifests
    // without auth render no `{{secret}}` value (renderEnv drops empty results,
    // so an unconfigured endpoint injects no empty token).
    variables: input.secretToken ? { secret: input.secretToken } : undefined,
    ...(input.contextFile ? { contextFile: input.contextFile } : {}),
    ...(input.contextText ? { contextText: input.contextText } : {}),
    // Only when there are directories to pass, so a launch before the app has
    // materialised its copy renders the argv it always did rather than an
    // empty flag.
    ...(input.pluginDirs && input.pluginDirs.length > 0 ? { pluginDirs: input.pluginDirs } : {}),
    // Same rule as the directories above: only when there is something to send,
    // so a launch with no settings of its own renders the theme-only document
    // the manifest always rendered.
    ...(input.launchSettings && Object.keys(input.launchSettings).length > 0
      ? { launchSettings: input.launchSettings }
      : {}),
    ...(input.integrationArgs && input.integrationArgs.length > 0 ? { integrationArgs: input.integrationArgs } : {}),
    ...(input.promptOverflow ? { promptOverflow: input.promptOverflow } : {}),
  }
  return { binary, context }
}

function renderWithPlugin(
  input: AgentLaunchRenderInput,
  plugin: LoadedPlugin,
  prompt: string | undefined,
): Omit<RenderedAgentLaunch, 'prompt'> {
  const pluginId = plugin.manifest.id
  const { binary, context } = buildLaunchRenderContext(input, plugin, prompt)
  const rendered = input.resume
    ? renderPluginResume(plugin.manifest, context)
    : renderPluginLaunch(plugin.manifest, context)

  if (!rendered) {
    throw new AgentLaunchRenderError(
      `Plugin "${pluginId}" does not declare a resume command. ` +
        `Set resume.supported = true and resume.argv in its plugin.json.`,
    )
  }
  // The last line of defence for every launch door: a first message that
  // starts with `-` and lands on the command line with no `--` in front of it
  // would be parsed by the CLI as an option.
  if (prompt !== undefined && launchPromptReadsAsOption(prompt)) {
    const at = rendered.argv.lastIndexOf(prompt)
    if (at !== -1 && rendered.argv[at - 1] !== '--') {
      throw new AgentLaunchRenderError(LAUNCH_PROMPT_READS_AS_OPTION_MESSAGE)
    }
  }

  return { argv: rendered.argv, binary, plugin, env: rendered.env }
}

// ── Fitting a launch to the platform's command line ──────────────────────────
//
// Two things a launch carries can be arbitrarily long: the person's first
// message (a pasted log) and the host-context document (a CLI that takes it as
// text rather than as a file). Either can make the exec fail outright on Linux
// and WSL, where one argument is capped at 128 KiB, or on Windows, where the
// whole command line is. `planAgentLaunch` renders the launch, measures it
// against `launch-arg-budget.ts`, and moves what does not fit:
//
// 1. A host-context document longer than one argument may be is cut, with a
//    marker naming the file main wrote it to, so the agent can read the rest —
//    a launch that loses the tail of its context beats one that does not start.
// 2. A prompt that does not fit leaves argv by the manifest's
//    `promptInjection.overflow`: typed in once the CLI is ready (the default),
//    or written to a file the CLI documents an option for.
// 3. If the launch is still over, the context is cut to what room is left; and
//    if that is not enough either, the launch goes as rendered and says so in
//    the log. A launch that fits is never changed, context included.
//
// A `send-after-ready` manifest never puts the prompt on the command line: its
// CLI documents no way to take a first message there, so every new launch that
// carries one types it in, whatever its length. A resume never does — the
// conversation being resumed already had its first message.

export type AgentPromptDelivery =
  /** On the command line, where `{{prompt}}` put it — or there is no prompt. */
  | { kind: 'argv' }
  /** Typed into the CLI once it is ready: the caller owes the CLI exactly this. */
  | { kind: 'input'; text: string }
  /** Written to `path`, which the launch names through the manifest's file args. */
  | { kind: 'file'; text: string; path: string }

export type PlannedAgentLaunch = RenderedAgentLaunch & {
  promptDelivery: AgentPromptDelivery
  /**
   * Environment the launch adds because its first message is typed in (the
   * manifest's `promptInjection.overflow.env`). Absent for every other launch.
   */
  typedPromptEnv?: Record<string, string>
  /** Set when the host-context document was cut to fit: characters kept of the whole. */
  contextTruncated?: { shown: number; total: number }
  /** True when nothing more could be moved and the launch is still over budget. */
  overBudget?: boolean
}

export type AgentLaunchPlanOptions = {
  budget: LaunchArgBudget
  /**
   * Write the prompt where the launched CLI can read it, returning the path as
   * the launched shell names it, or null when it could not be written (the
   * prompt then stays on the command line). Only consulted for a manifest whose
   * overflow is `file`.
   */
  writePromptFile?: (text: string) => string | null
  /** Where a launch that had to be changed to fit is reported. */
  log?: (event: string, detail: Record<string, unknown>) => void
}

function defaultPlanLog(event: string, detail: Record<string, unknown>): void {
  console.warn(`[agent-launch] ${event}`, detail)
}

/**
 * The marker a cut host-context document ends with. It names the file because
 * the whole document is there: main writes it for every CLI with an
 * out-of-band channel, the ones that take it as text included.
 */
export function hostContextTruncationMarker(shown: number, total: number, contextFile: string | undefined): string {
  const where = contextFile ? ` The complete document is in ${contextFile}; read it before you start.` : ''
  return (
    `\n\n[Host context truncated: this platform's command line has room for ${shown} of its ${total} characters.` +
    `${where}]`
  )
}

/**
 * The longest prefix of `text` (with its marker) that `fits`, found by halving:
 * each probe is one render, and the answer is exact to the character. Never
 * splits a surrogate pair. Null when not even the marker alone fits.
 */
function truncateToFit(
  text: string,
  withMarker: (kept: string) => string,
  fits: (candidate: string) => boolean,
): { text: string; kept: number } | null {
  if (!fits(withMarker(''))) return null
  let lo = 0
  let hi = text.length
  while (hi - lo > 1) {
    const mid = Math.floor((lo + hi) / 2)
    if (fits(withMarker(safePrefix(text, mid)))) lo = mid
    else hi = mid
  }
  const kept = safePrefix(text, lo)
  return { text: withMarker(kept), kept: kept.length }
}

function safePrefix(text: string, length: number): string {
  const code = text.charCodeAt(length - 1)
  const cut = length > 0 && code >= 0xd800 && code <= 0xdbff ? length - 1 : length
  return text.slice(0, cut)
}

export function planAgentLaunch(input: AgentLaunchRenderInput, options: AgentLaunchPlanOptions): PlannedAgentLaunch {
  const { budget } = options
  const log = options.log ?? defaultPlanLog
  const plugin = resolveLaunchPlugin(input.cli)
  const prompt = input.initialPrompt
  const overBudget = (argv: string[]): boolean => launchArgvExceedsBudget(argv, budget)
  const render = (candidate: AgentLaunchRenderInput): RenderedAgentLaunch => ({
    ...renderWithPlugin(candidate, plugin, renderedPromptToken(candidate, prompt)),
    prompt,
  })

  let working: AgentLaunchRenderInput = { ...input }
  let contextTruncated: PlannedAgentLaunch['contextTruncated']
  const originalContext = input.contextText
  const cutContext = (fits: (candidate: AgentLaunchRenderInput) => boolean): boolean => {
    if (!originalContext) return false
    const cut = truncateToFit(
      originalContext,
      (kept) => `${kept}${hostContextTruncationMarker(kept.length, originalContext.length, input.contextFile)}`,
      (text) => fits({ ...working, contextText: text }),
    )
    if (cut === null) return false
    working = { ...working, contextText: cut.text }
    contextTruncated = { shown: cut.kept, total: originalContext.length }
    return true
  }

  // 1. The context document alone must fit in one argument; past that nothing
  //    else moving could save the launch. A document that fits is left whole
  //    here, and only cut in step 3 if the launch is still over.
  const contextFits = (candidate: AgentLaunchRenderInput): boolean => {
    const { context } = buildLaunchRenderContext(candidate, plugin, undefined)
    const measured = measureLaunchArgv(renderPluginContextArgs(plugin.manifest, context), budget)
    return measured.largest <= budget.maxArg && measured.total <= budget.maxArg
  }
  if (originalContext && !contextFits(working)) cutContext(contextFits)

  // 2. The prompt: typed in by a `send-after-ready` manifest, or moved off the
  //    command line when the launch does not fit with it there.
  let promptDelivery: AgentPromptDelivery = { kind: 'argv' }
  if (typesFirstMessage(plugin, input, prompt)) {
    working = { ...working, promptOverflow: { mode: 'input' } }
    promptDelivery = { kind: 'input', text: prompt }
  }
  let rendered = render(working)
  if (
    promptDelivery.kind === 'argv' &&
    overBudget(rendered.argv) &&
    prompt &&
    promptRendersIntoArgv(working, plugin, rendered.argv)
  ) {
    const overflow = plugin.manifest.promptInjection?.overflow ?? { mode: 'input' as const }
    if (overflow.mode === 'file') {
      // A CLI that takes an overflowed message from a file has no line editor
      // to type it into (OpenCode's `run` is one-shot). A file that could not
      // be written leaves the prompt on the command line: a launch the platform
      // refuses says so, where a message typed at nothing is lost in silence.
      const promptFile = options.writePromptFile?.(prompt) ?? null
      if (promptFile) {
        working = { ...working, promptOverflow: { mode: 'file', promptFile } }
        promptDelivery = { kind: 'file', text: prompt, path: promptFile }
      }
    } else {
      working = { ...working, promptOverflow: { mode: 'input' } }
      promptDelivery = { kind: 'input', text: prompt }
    }
    if (promptDelivery.kind !== 'argv') {
      rendered = render(working)
      log('prompt-moved-off-command-line', {
        cli: input.cli,
        platform: budget.platform,
        delivery: promptDelivery.kind,
        promptLength: prompt.length,
      })
    }
  }

  // 3. Still over: whatever room is left goes to the context.
  if (overBudget(rendered.argv) && working.contextText) {
    if (cutContext((candidate) => !overBudget(render(candidate).argv))) rendered = render(working)
  }
  if (contextTruncated) {
    log('host-context-truncated', {
      cli: input.cli,
      platform: budget.platform,
      shown: contextTruncated.shown,
      total: contextTruncated.total,
    })
  }

  const typedPromptEnv =
    promptDelivery.kind === 'input'
      ? renderPluginTypedPromptEnv(plugin.manifest, buildLaunchRenderContext(working, plugin, undefined).context)
      : {}

  const stillOver = overBudget(rendered.argv)
  if (stillOver) {
    const measured = measureLaunchArgv(rendered.argv, budget)
    log('launch-still-over-budget', {
      cli: input.cli,
      platform: budget.platform,
      largestArg: measured.largest,
      largestArgIndex: measured.largestIndex,
      total: measured.total,
      maxArg: budget.maxArg,
      maxTotal: budget.maxTotal,
    })
  }

  return {
    ...rendered,
    promptDelivery,
    ...(Object.keys(typedPromptEnv).length > 0 ? { typedPromptEnv } : {}),
    ...(contextTruncated ? { contextTruncated } : {}),
    ...(stillOver ? { overBudget: true } : {}),
  }
}

/**
 * Whether this launch types its first message in because the manifest takes it
 * no other way (`send-after-ready`). Only a new launch with something to say: a
 * resume must never send the first message a second time, and a message of
 * nothing but whitespace has nothing to type.
 */
function typesFirstMessage(
  plugin: LoadedPlugin,
  input: AgentLaunchRenderInput,
  prompt: string | undefined,
): prompt is string {
  return plugin.manifest.promptInjection?.mode === 'send-after-ready' && !input.resume && Boolean(prompt?.trim())
}

/**
 * Whether this manifest puts the prompt on the command line at all. A launch
 * that never carries it there (a resumed session whose manifest renders no
 * `{{prompt}}` on resume) gains nothing from moving it, and must not be handed a
 * prompt to type in that its own launch never carried.
 */
function promptRendersIntoArgv(input: AgentLaunchRenderInput, plugin: LoadedPlugin, argv: string[]): boolean {
  const without = renderWithPlugin({ ...input, promptOverflow: undefined }, plugin, undefined).argv
  return without.length !== argv.length || without.some((token, index) => token !== argv[index])
}

// Decides whether a CLI launch must be blocked because the CLI declares a
// required credential (`auth`) that isn't configured. Returns a user-facing
// message when blocked, or null to proceed. Pure — the caller resolves the
// manifest + whether a secret is configured. A CLI without `auth` never blocks,
// so the ordinary CLIs are unaffected. This lets the spawn path show a clear
// "needs an API key" message instead of launching the agent into an auth error.
export function cliCredentialLaunchBlock(input: {
  displayName: string
  auth?: { label: string }
  secretConfigured: boolean
}): { message: string } | null {
  if (!input.auth || input.secretConfigured) return null
  return {
    message: `${input.displayName} needs an API key before it can start. Add it in Settings → Agents.`,
  }
}

// Renders just the launch-env a CLI manifest declares (with `{{secret}}` and
// other variables substituted), for callers that inject it into the spawned
// process env rather than argv. Returns an empty object for manifests with no
// `launch.env`. Resume vs launch only affects argv, so the env is identical;
// this always renders the launch spec.
export function renderCliLaunchEnv(input: AgentLaunchRenderInput): Record<string, string> {
  return renderAgentLaunchArgv({ ...input, resume: false }).env
}

// Quote rules match the legacy buildAgentLaunchCommand: tokens that are safe
// as bare shell words (alphanumeric and a small punctuation set) are passed
// through, everything else is single-quoted. Semantically identical to the
// pre-plugin output, though session-ids and simple prompts may render
// without surrounding quotes where the legacy code always quoted them.
const SAFE_POSIX_TOKEN = /^[A-Za-z0-9._/-]+$/

export function quotePosixToken(value: string): string {
  return SAFE_POSIX_TOKEN.test(value) ? value : quotePosixForced(value)
}

function quotePosixForced(value: string): string {
  return `'${value.replace(/'/g, `'"'"'`)}'`
}

export function argvToPosixShellCommand(argv: string[]): string {
  return argv.map(quotePosixToken).join(' ')
}

/**
 * The invocation a spawn WOULD make, rendered for display before it happens
 * (the new-agent tab's receipt line).
 *
 * It goes through `renderAgentLaunchArgv` — the same call the spawn makes — for
 * the reason the surface exists: a hand-written preview of `--permission-mode`
 * flags is a promise the launch path is free to break, and the first flag that
 * moved would turn the receipt into a lie. Sharing the renderer means a manifest
 * change reaches the preview and the spawn in one step.
 *
 * The prompt is deliberately NOT rendered: it is visible in the composer a line
 * above, it would re-render the preview on every keystroke, and on the CLIs that
 * pass it as argv it would bury the flags the line exists to show. `binary` is
 * the resolved command; callers show it plus `args`.
 */
export function renderAgentLaunchPreview(
  input: Omit<AgentLaunchRenderInput, 'sessionId' | 'resume' | 'initialPrompt'>,
): { binary: string; args: string[]; display: string } {
  const { argv, binary } = renderAgentLaunchArgv({
    ...input,
    // A stable placeholder: session ids are rendered into argv by some
    // manifests, and a real one would make the preview churn per keystroke
    // while telling the reader nothing.
    sessionId: 'preview',
    resume: false,
    initialPrompt: undefined,
  })
  // argv[0] is the binary; the receipt shows the command name and its flags.
  const args = argv.slice(1)
  return { binary, args, display: argvToPosixShellCommand(argv) }
}

const POSIX_ENV_NAME = /^[A-Za-z_][A-Za-z0-9_]*$/

// Exit status the launch script reports when its agent binary is not there —
// the shell's own "command not found", matching AGENT_CLI_NOT_FOUND_EXIT.
const AGENT_BINARY_NOT_FOUND_EXIT = 127

// Builds the shell snippet emitted by the manual terminal
// launch path: a `command -v` guard followed by the actual agent invocation.
// Pulled here so it can be unit-tested without touching the Electron-dependent
// `terminal-launch.ts` module.
//
// The guard EXITS rather than falling through. This snippet is joined ahead of
// an `exec $SHELL -l`, so a guard that only echoed left the user in a bare
// interactive shell with no agent — while the pty spawn itself succeeded, and
// the IPC reported `ok: true`. The pre-flight in `terminal-runtime` is the
// authority; this is the second line of defence for a binary that disappears
// between the pre-flight and the spawn, and it must fail visibly.
export function buildAgentShellCommand(input: AgentLaunchRenderInput): string {
  return agentShellCommandFor(input, renderAgentLaunchArgv(input))
}

/**
 * `buildAgentShellCommand`, fitted to the command line `options.budget`
 * allows (see `planAgentLaunch`), with the plan beside it so the caller can
 * deliver a prompt the command line could not carry.
 */
export function planAgentShellCommand(
  input: AgentLaunchRenderInput,
  options: AgentLaunchPlanOptions,
): { command: string; plan: PlannedAgentLaunch } {
  const plan = planAgentLaunch(input, options)
  return { command: agentShellCommandFor(input, plan), plan }
}

function agentShellCommandFor(
  input: AgentLaunchRenderInput,
  rendered: RenderedAgentLaunch & Pick<PlannedAgentLaunch, 'typedPromptEnv'>,
): string {
  const { argv, binary, plugin } = rendered
  // Assignments in front of the command set them for the CLI alone, not for the
  // shell the startup script leaves behind.
  const envPrefix = Object.entries(rendered.typedPromptEnv ?? {})
    .filter(([name]) => POSIX_ENV_NAME.test(name))
    .map(([name, value]) => `${name}=${quotePosixForced(value)} `)
    .join('')
  const shellCommand = `${envPrefix}${argvToPosixShellCommand(argv)}`
  const displayName = plugin.manifest.displayName
  const shortName = displayName.split(/\s+/)[0] || displayName
  const message = `${shortName} CLI was not found. Check the ${input.cli} command in Settings.`
  const guard = [
    `if ! command -v ${quotePosixToken(binary)} >/dev/null 2>&1; then`,
    `echo ${quotePosixForced(message)} >&2;`,
    `exit ${AGENT_BINARY_NOT_FOUND_EXIT};`,
    'fi',
  ].join(' ')
  return [guard, shellCommand].join('; ')
}
