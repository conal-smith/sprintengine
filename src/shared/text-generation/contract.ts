/**
 * The text-generation contract: what a caller asks for, what comes back, and
 * which agent CLIs can answer at all.
 *
 * The premise: the person's own installed agent CLI,
 * headless, one shot, structured output, under the subscription the CLI is
 * already logged into. No API key is read or sent anywhere on this path.
 *
 * Pure: no I/O, no Electron. Shared by main (the service), preload (the
 * bridge) and the renderer (the settings row and the title requester).
 */

import type { CommitMessageInput, CommitMessageText } from './commit-message'
import type { PullRequestText, PullRequestTextInput } from './pull-request-text'
import { normalizeWritingStyle, type TextGenerationWritingStyle } from './writing-style'

/** Which CLI runs the job, on which model, at which effort. */
export type TextGenerationEngine = {
  cli: string
  model: string
  /** Absent means the backend's own cheap default, not the CLI's default. */
  reasoning?: string
}

/**
 * What a generation call can fail with. Every code is a reason to keep what
 * the caller already had, never a reason to show an error: a title that does
 * not arrive is the heuristic title, silently (rule of record).
 */
type TextGenerationFailureCode =
  | 'unsupported' // no backend for this CLI
  | 'unavailable' // the CLI is not installed, or could not be probed
  | 'timeout'
  | 'transport' // spawn failed, non-zero exit, or unparseable output
  | 'guardrail' // the model answered, but not with a usable title
  | 'cancelled' // the person called it off, and the CLI was stopped

export type TextGenerationResult =
  { ok: true; value: string; ms: number } | { ok: false; code: TextGenerationFailureCode; message: string }

/**
 * Per-CLI command override, the same shape the launch path forwards. `hostId`
 * names the machine the command belongs to (a WSL distribution); absent is
 * this machine.
 */
export type TextGenerationCliRuntimeOverrides = Record<
  string,
  { command?: string; hostId?: import('../execution-host').ExecutionHostId } | undefined
>

export type ChatTitleRequest = {
  /** The first prompt the person sent. Truncated by the prompt builder. */
  prompt: string
  engine: TextGenerationEngine
  cliRuntimes?: TextGenerationCliRuntimeOverrides
  /** Caller-owned deadline. Defaults to DEFAULT_TEXT_GENERATION_TIMEOUT_MS. */
  timeoutMs?: number
}

/** The title and description of a pull request, drafted for the person to edit before anything is sent. */
export type PullRequestTextRequest = {
  input: PullRequestTextInput
  engine: TextGenerationEngine
  cliRuntimes?: TextGenerationCliRuntimeOverrides
  timeoutMs?: number
  /** The person closed the dialog: the CLI is stopped. Main-side only; it does not cross IPC. */
  signal?: AbortSignal
}

export type PullRequestTextResult =
  { ok: true; value: PullRequestText; ms: number } | Extract<TextGenerationResult, { ok: false }>

/** A commit message for what is staged, drafted into the Git panel's box for the person to edit before committing. */
export type CommitMessageRequest = {
  input: CommitMessageInput
  engine: TextGenerationEngine
  cliRuntimes?: TextGenerationCliRuntimeOverrides
  timeoutMs?: number
  /** The person stopped the draft: the CLI is stopped. Main-side only; it does not cross IPC. */
  signal?: AbortSignal
}

export type CommitMessageResult =
  { ok: true; value: CommitMessageText; ms: number } | Extract<TextGenerationResult, { ok: false }>

/**
 * A title is a background job with nothing waiting on it, so the budget is
 * generous: a cold `codex exec` takes 5-15 s, `claude -p` with thinking off
 * ~3 s (see `engineEnv` in the service), a slow day more. 90 s is far past
 * any answer still worth having.
 */
export const DEFAULT_TEXT_GENERATION_TIMEOUT_MS = 90_000

/**
 * The CLIs with a headless backend, and the cheap engine each one defaults to.
 *
 * This is code knowledge, not manifest knowledge: a manifest cannot declare a
 * backend that is not implemented, so the table lives beside the backends
 * rather than in plugin.json. The defaults are a small model at effort
 * `low`, never the chat's own model, which is what makes a title cost a
 * fraction of a turn.
 *
 * Verified 2026-10-15 on this machine: `claude-haiku-5-5` through
 * `claude 2.1.296` with the title flags, and on 2026-09-07 `gpt-5.6-luna`
 * through `codex-cli 0.153.3` on a ChatGPT account (`gpt-5.1-codex-mini` is
 * refused there). Haiku 5.5 is a tenth of 4.5's price per token, and every
 * title, commit message and PR draft runs on this default unless the person
 * picked a model.
 */
const TEXT_GENERATION_BACKENDS: Readonly<
  Record<string, { readonly defaultModel: string; readonly defaultReasoning: string }>
> = {
  'claude-code': { defaultModel: 'claude-haiku-5-5', defaultReasoning: 'low' },
  codex: { defaultModel: 'gpt-5.6-luna', defaultReasoning: 'low' },
}

export function supportsTextGeneration(cli: string | null | undefined): boolean {
  return typeof cli === 'string' && Object.prototype.hasOwnProperty.call(TEXT_GENERATION_BACKENDS, cli)
}

/**
 * The person's setting, as persisted. `engine` null means "whichever supported
 * CLI is installed, at its default"; a stored engine with an empty model means
 * that CLI at its default model. `writingStyle` is how a drafted commit
 * message or pull request is written (`writing-style.ts`).
 */
export type TextGenerationSettings = {
  enabled: boolean
  engine: TextGenerationEngine | null
  writingStyle: TextGenerationWritingStyle
}

/** The part of the setting that decides whether a call is made, and on which engine. */
export type TextGenerationEngineSettings = Pick<TextGenerationSettings, 'enabled' | 'engine'>

/**
 * The text-generation setting as persisted. Enabled by default: the owner's
 * ruling (2026-09-07) is that the heuristic is the fallback for a person who
 * turned this off or has no supported CLI, so a fresh profile starts with it
 * on. The engine follows the AgentCliModelSelection rules — a CLI with an
 * empty model means that CLI's default model, and a stray level without a
 * CLI is nothing.
 *
 * Shared because two copies of the setting read it: the window's own, and
 * main's mirror, which titles a chat with no window to ask
 * (`main/text-generation/text-generation-settings-store.ts`). Both read an
 * absent value as the same default.
 */
export function normalizeTextGenerationSettings(
  input: Partial<TextGenerationSettings> | null | undefined,
): TextGenerationSettings {
  const enabled = typeof input?.enabled === 'boolean' ? input.enabled : true
  // A profile from before the writing style existed reads as the default:
  // match the repository, which is what the drafts did then.
  const writingStyle = normalizeWritingStyle(input?.writingStyle)
  return { enabled, engine: normalizeEngine(input?.engine), writingStyle }
}

function normalizeEngine(raw: unknown): TextGenerationEngine | null {
  if (!raw || typeof raw !== 'object') return null
  const { cli: rawCli, model: rawModel, reasoning: rawReasoning } = raw as Record<string, unknown>
  const cli = typeof rawCli === 'string' ? rawCli.trim() : ''
  const model = typeof rawModel === 'string' ? rawModel.trim() : ''
  const reasoning = typeof rawReasoning === 'string' ? rawReasoning.trim() : ''
  if (!cli) return null
  return { cli, model, ...(reasoning ? { reasoning } : {}) }
}

/**
 * Turn the setting into the engine a call should actually use, or null when
 * no call should be made. `installed(cli)` answers from the availability
 * probe: `false` excludes a CLI, while `true` and `undefined` (not probed yet)
 * both keep it — the same trust rule the deployment pickers use, so a slow
 * probe never silences the feature on a machine that has the CLI.
 *
 * A remembered engine whose CLI is gone falls through to the first supported
 * installed CLI in `candidates`, so uninstalling Codex does not leave the
 * setting pointing at nothing.
 */
export function resolveTextGenerationEngine(
  settings: TextGenerationEngineSettings | null | undefined,
  candidates: ReadonlyArray<string>,
  installed: (cli: string) => boolean | undefined,
): TextGenerationEngine | null {
  if (!settings?.enabled) return null
  const usable = (cli: string): boolean => supportsTextGeneration(cli) && installed(cli) !== false

  const chosen = settings.engine
  if (chosen && usable(chosen.cli)) return withDefaults(chosen)

  const fallback = candidates.find(usable)
  return fallback ? withDefaults({ cli: fallback, model: '' }) : null
}

/**
 * An engine with its backend's cheap defaults filled in: a CLI with an empty
 * model runs the backend's small model, at its default effort.
 */
export function textGenerationEngineWithDefaults(engine: TextGenerationEngine): TextGenerationEngine {
  return withDefaults(engine)
}

function withDefaults(engine: TextGenerationEngine): TextGenerationEngine {
  const backend = TEXT_GENERATION_BACKENDS[engine.cli]
  const model = engine.model.trim() || backend?.defaultModel || ''
  const reasoning = engine.reasoning?.trim() || backend?.defaultReasoning
  return { cli: engine.cli, model, ...(reasoning ? { reasoning } : {}) }
}
