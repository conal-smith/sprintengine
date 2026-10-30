// Text generation in the main process: the person's own agent CLI, headless,
// one shot, under the login it already holds. Four jobs run on it: the chat
// title, the title and description the chat's "Create PR" button drafts, the
// commit message the Git panel drafts, and a module's free-text prompt
// (module-text-generation.ts).
//
// What every call guarantees:
//   - no API key is read or forwarded — the Anthropic key/base-URL variables
//     are stripped so `claude` binds its own subscription login, exactly as
//     the conversation provider does;
//   - a fresh process, no session, no transcript, tools off, read-only;
//   - the CLI runs in a scratch directory, never the checkout, so no CLAUDE.md
//     or AGENTS.md rides along and nothing is read from the project;
//   - failure is a typed `{ ok: false }`, never a throw — the caller keeps
//     what it had.

import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'

import type { CliDetectResult } from '../../shared/electron-api'
import { LOCAL_HOST_ID, type ExecutionHostId } from '../../shared/execution-host'
import {
  CHAT_TITLE_OUTPUT_SCHEMA,
  buildChatTitlePrompt,
  readChatTitleOutput,
  sanitizeGeneratedChatTitle,
} from '../../shared/text-generation/chat-title'
import {
  COMMIT_MESSAGE_OUTPUT_SCHEMA,
  buildCommitMessagePrompt,
  commitMessageIsConventional,
  readCommitMessageOutput,
} from '../../shared/text-generation/commit-message'
import {
  DEFAULT_TEXT_GENERATION_TIMEOUT_MS,
  type ChatTitleRequest,
  type CommitMessageRequest,
  type CommitMessageResult,
  type PullRequestTextRequest,
  type PullRequestTextResult,
  type TextGenerationCliRuntimeOverrides,
  type TextGenerationEngine,
  type TextGenerationResult,
  supportsTextGeneration,
} from '../../shared/text-generation/contract'
import {
  PULL_REQUEST_TEXT_OUTPUT_SCHEMA,
  buildPullRequestTextPrompt,
  readPullRequestTextOutput,
} from '../../shared/text-generation/pull-request-text'
import { detectAgentCliAvailability } from '../cli-availability'
import { defaultProbeEnv } from '../cli-runtime-install'
import { listPluginRegistryEntries } from '../plugin-registry-instance'
import { STRIPPED_ANTHROPIC_AUTH_ENV_KEYS } from '../providers/claude-agent-provider'
import {
  claudeChatTitleInvocation,
  claudeTextInvocation,
  codexChatTitleInvocation,
  codexMcpListInvocation,
  codexTextInvocation,
  codexTextPrompt,
  readClaudeErrorResult,
  readClaudeStructuredStdout,
  readClaudeTextStdout,
  readCodexEnabledMcpServers,
  readCodexTextUsage,
  type ChatTitleInvocation,
  type ClaudeTextAnswer,
} from './backends'
import { runCommand, type RunCommand } from './run-command'
import { hasClaudeManagedMcpConfig } from '../claude-managed-mcp'

export type TextGenerationServiceDeps = {
  detect?: (cli: string, runtime?: { command?: string; hostId?: ExecutionHostId }) => Promise<CliDetectResult>
  run?: RunCommand
  env?: () => Record<string, string>
  /** Where scratch directories are made. Defaults to the OS temp dir. */
  scratchRoot?: string
  now?: () => number
  /** Whether an administrator's `managed-mcp.json` is installed; read from disk by default. */
  managedMcpConfig?: () => boolean
}

const SCRATCH_PREFIX = 'sprintengine-text-'
// `codex mcp list` only reads the config, and answers in about a second with
// servers configured; a listing slower than this is not worth the call's wait.
const CODEX_MCP_LIST_TIMEOUT_MS = 10_000

/**
 * The deadline is the caller's for the whole call: a step that runs ahead of
 * the answer (Codex's MCP listing) is bounded by it and taken out of it, so a
 * title asked for in 90 s is never waited on for 100. `left()` reads the
 * clock, and is asked only once such a step has run.
 */
function callDeadline(startedAt: number, timeoutMs: number | undefined, now: () => number) {
  const total = timeoutMs ?? DEFAULT_TEXT_GENERATION_TIMEOUT_MS
  return { total, left: () => startedAt + total - now() }
}

export async function generateChatTitle(
  request: ChatTitleRequest,
  deps: TextGenerationServiceDeps = {},
): Promise<TextGenerationResult> {
  return runStructuredJob(
    {
      engine: request.engine,
      cliRuntimes: request.cliRuntimes,
      timeoutMs: request.timeoutMs,
      prompt: buildChatTitlePrompt(request.prompt),
      schema: CHAT_TITLE_OUTPUT_SCHEMA,
      read: (answer) => sanitizeGeneratedChatTitle(readChatTitleOutput(answer)),
      nothing: 'title',
    },
    deps,
  )
}

/** The title and description of a pull request, drafted from the branch's commits and diff. */
export async function generatePullRequestText(
  request: PullRequestTextRequest,
  deps: TextGenerationServiceDeps = {},
): Promise<PullRequestTextResult> {
  return runStructuredJob(
    {
      engine: request.engine,
      cliRuntimes: request.cliRuntimes,
      timeoutMs: request.timeoutMs,
      signal: request.signal,
      prompt: buildPullRequestTextPrompt(request.input),
      schema: PULL_REQUEST_TEXT_OUTPUT_SCHEMA,
      read: readPullRequestTextOutput,
      nothing: 'pull request text',
    },
    deps,
  )
}

/**
 * A commit message for what is staged, drafted from the staged diff, the
 * repository's recent subjects and the person's writing style. Under
 * Conventional Commits a subject that is not one is a guardrail failure, so
 * the box keeps what the person had (`sanitizeCommitMessage` says why).
 */
export async function generateCommitMessage(
  request: CommitMessageRequest,
  deps: TextGenerationServiceDeps = {},
): Promise<CommitMessageResult> {
  const conventional = commitMessageIsConventional(request.input)
  return runStructuredJob(
    {
      engine: request.engine,
      cliRuntimes: request.cliRuntimes,
      timeoutMs: request.timeoutMs,
      signal: request.signal,
      prompt: buildCommitMessagePrompt(request.input),
      schema: COMMIT_MESSAGE_OUTPUT_SCHEMA,
      read: (answer) => readCommitMessageOutput(answer, { conventional }),
      nothing: conventional ? 'Conventional Commits message' : 'commit message',
    },
    deps,
  )
}

/** One free-text call a module asked for (`getTextGenerationService`). */
export type HeadlessTextRequest = {
  prompt: string
  system?: string
  /** The CLI, model and effort that answer; the CLI one with a headless backend. */
  engine: TextGenerationEngine
  maxOutputTokens?: number
  cliRuntimes?: TextGenerationCliRuntimeOverrides
  timeoutMs?: number
  signal?: AbortSignal
}

export type HeadlessTextResult =
  | { ok: true; text: string; usage: ClaudeTextAnswer['usage']; model: string; ms: number }
  | Extract<TextGenerationResult, { ok: false }>

/**
 * A prompt answered as free text by the person's own agent CLI, headless, with
 * every guarantee a title has: no API key, a scratch directory, one shot.
 * Claude Code answers on stdout with its tools off and the system prompt as its
 * own; Codex writes its last message to a file, reports its usage on its JSON
 * event stream, and reads the system prompt ahead of the prompt.
 * `maxOutputTokens` caps the answer through Claude Code's own output limit
 * (`CLAUDE_CODE_MAX_OUTPUT_TOKENS`); Codex has no such setting, so a Codex call
 * ignores it.
 */
export async function generateHeadlessText(
  request: HeadlessTextRequest,
  deps: TextGenerationServiceDeps = {},
): Promise<HeadlessTextResult> {
  const now = deps.now ?? Date.now
  const startedAt = now()
  const { cli } = request.engine
  if (!supportsTextGeneration(cli)) {
    return { ok: false, code: 'unsupported', message: `${cli} has no text generation backend.` }
  }
  const model = request.engine.model.trim()
  if (!model) return { ok: false, code: 'unsupported', message: 'No model was chosen for text generation.' }
  const binaryPath = await resolveBinary(cli, request.cliRuntimes, deps.detect ?? cachedDetect)
  if (!binaryPath.ok) return binaryPath
  if (request.signal?.aborted) return { ok: false, code: 'cancelled', message: `${cli} was stopped.` }
  const scratch = await mkdtemp(path.join(deps.scratchRoot ?? tmpdir(), SCRATCH_PREFIX))
  try {
    const env = engineEnv(cli, deps.env)
    const run = deps.run ?? runCommand
    const deadline = callDeadline(startedAt, request.timeoutMs, now)
    const context = { cwd: scratch, env, ...(request.signal ? { signal: request.signal } : {}) }
    const common = { ...context, timeoutMs: deadline.total }
    let answer: ClaudeTextAnswer | null
    if (cli === 'codex') {
      const outputPath = path.join(scratch, 'last-message.txt')
      await writeFile(outputPath, '', 'utf8')
      const mcpServersOff = await listCodexMcpServers(binaryPath.path, run, context, deadline.total)
      common.timeoutMs = deadline.left()
      if (common.timeoutMs <= 0) return { ok: false, code: 'timeout', message: `${cli} did not answer in time.` }
      const outcome = await run({
        ...codexTextInvocation({
          binaryPath: binaryPath.path,
          model,
          reasoning: request.engine.reasoning,
          outputPath,
          mcpServersOff,
        }),
        ...common,
        stdin: request.system ? codexTextPrompt(request.system, request.prompt) : request.prompt,
      })
      const failure = runFailure(cli, outcome)
      if (failure) return failure
      const text = await readFile(outputPath, 'utf8')
      answer = text.trim() ? { text, model: null, usage: readCodexTextUsage(outcome.stdout) } : null
    } else {
      if (request.maxOutputTokens !== undefined) env.CLAUDE_CODE_MAX_OUTPUT_TOKENS = String(request.maxOutputTokens)
      const outcome = await run({
        ...claudeTextInvocation({
          binaryPath: binaryPath.path,
          model,
          reasoning: request.engine.reasoning,
          ...(request.system ? { system: request.system } : {}),
          managedMcpConfig: (deps.managedMcpConfig ?? hasClaudeManagedMcpConfig)(),
        }),
        ...common,
        stdin: request.prompt,
      })
      const failure = runFailure(cli, outcome)
      if (failure) return failure
      answer = readClaudeTextStdout(outcome.stdout)
      const reason = answer ? null : readClaudeErrorResult(outcome.stdout)
      if (reason) return { ok: false, code: 'guardrail', message: `${cli} answered with an error: ${lastLine(reason)}` }
    }
    if (!answer) return { ok: false, code: 'guardrail', message: `${cli} returned no usable answer.` }
    return { ok: true, text: answer.text, usage: answer.usage, model: answer.model ?? model, ms: now() - startedAt }
  } catch (error) {
    return { ok: false, code: 'transport', message: describe(error) }
  } finally {
    await rm(scratch, { recursive: true, force: true }).catch(() => undefined)
  }
}

/**
 * One headless, structured-output call: resolve the CLI, run it in a scratch
 * directory with the prompt on stdin, and read its answer through `read`.
 */
async function runStructuredJob<T>(
  job: {
    engine: TextGenerationEngine
    cliRuntimes: TextGenerationCliRuntimeOverrides | undefined
    timeoutMs: number | undefined
    signal?: AbortSignal
    prompt: string
    schema: object
    read: (answer: unknown) => T | null
    /** What a failed read says was missing: "returned no usable <nothing>". */
    nothing: string
  },
  deps: TextGenerationServiceDeps,
): Promise<{ ok: true; value: T; ms: number } | Extract<TextGenerationResult, { ok: false }>> {
  const now = deps.now ?? Date.now
  const startedAt = now()
  const { engine } = job
  if (!supportsTextGeneration(engine.cli)) {
    return { ok: false, code: 'unsupported', message: `${engine.cli} has no text generation backend.` }
  }
  const model = engine.model.trim()
  if (!model) return { ok: false, code: 'unsupported', message: 'No model was chosen for text generation.' }

  const binaryPath = await resolveBinary(engine.cli, job.cliRuntimes, deps.detect ?? cachedDetect)
  if (!binaryPath.ok) return binaryPath
  if (job.signal?.aborted) return { ok: false, code: 'cancelled', message: `${engine.cli} was stopped.` }

  const scratch = await mkdtemp(path.join(deps.scratchRoot ?? tmpdir(), SCRATCH_PREFIX))
  try {
    const deadline = callDeadline(startedAt, job.timeoutMs, now)
    let listed = false
    const env = engineEnv(engine.cli, deps.env)
    const run = deps.run ?? runCommand

    const backend = await prepareBackend(engine.cli, {
      binaryPath: binaryPath.path,
      model,
      reasoning: engine.reasoning,
      schemaJson: JSON.stringify(job.schema),
      scratch,
      managedMcpConfig: engine.cli !== 'codex' && (deps.managedMcpConfig ?? hasClaudeManagedMcpConfig)(),
      listMcpServers: () => {
        listed = true
        return listCodexMcpServers(
          binaryPath.path,
          run,
          { cwd: scratch, env, ...(job.signal ? { signal: job.signal } : {}) },
          deadline.total,
        )
      },
    })
    const timeoutMs = listed ? deadline.left() : deadline.total
    if (timeoutMs <= 0) return { ok: false, code: 'timeout', message: `${engine.cli} did not answer in time.` }
    const outcome = await run({
      ...backend.invocation,
      cwd: scratch,
      env,
      stdin: job.prompt,
      timeoutMs,
      ...(job.signal ? { signal: job.signal } : {}),
    })
    const failure = runFailure(engine.cli, outcome)
    if (failure) return failure
    const value = job.read(await backend.readAnswer(outcome.stdout))
    if (value === null) {
      const reason = engine.cli === 'codex' ? null : readClaudeErrorResult(outcome.stdout)
      const message = reason
        ? `${engine.cli} answered with an error: ${lastLine(reason)}`
        : `${engine.cli} returned no usable ${job.nothing}.`
      return { ok: false, code: 'guardrail', message }
    }
    return { ok: true, value, ms: now() - startedAt }
  } catch (error) {
    return { ok: false, code: 'transport', message: describe(error) }
  } finally {
    await rm(scratch, { recursive: true, force: true }).catch(() => undefined)
  }
}

type PreparedBackend = {
  invocation: ChatTitleInvocation
  /** The answer, decoded as far as the backend can: an object, or text. */
  readAnswer: (stdout: string) => Promise<unknown>
}

// Each backend's answer lives somewhere different — Claude's on stdout, Codex's
// in a file it is told to write — so the recipe and its reader are prepared
// together, and the run itself is one line above.
async function prepareBackend(
  cli: string,
  input: {
    binaryPath: string
    model: string
    reasoning: string | undefined
    schemaJson: string
    scratch: string
    managedMcpConfig: boolean
    listMcpServers: () => Promise<string[]>
  },
): Promise<PreparedBackend> {
  if (cli === 'codex') {
    const schemaPath = path.join(input.scratch, 'schema.json')
    const outputPath = path.join(input.scratch, 'last-message.txt')
    await writeFile(schemaPath, input.schemaJson, 'utf8')
    await writeFile(outputPath, '', 'utf8')
    const mcpServersOff = await input.listMcpServers()
    return {
      invocation: codexChatTitleInvocation({ ...input, schemaPath, outputPath, mcpServersOff }),
      readAnswer: async () => await readFile(outputPath, 'utf8'),
    }
  }
  return {
    invocation: claudeChatTitleInvocation(input),
    readAnswer: async (stdout) => readClaudeStructuredStdout(stdout),
  }
}

// The MCP servers the person's Codex config would start, so the call can turn
// each off by name. Listed afresh every call: a server added a minute ago is
// one a cached list would let start. Any failure (an older CLI without
// `mcp list --json`, a timeout, output that is not the list) is no names, and
// the call runs with plugins and apps off but the servers as configured,
// never a text generation that fails over a listing.
async function listCodexMcpServers(
  binaryPath: string,
  run: RunCommand,
  context: { cwd: string; env: Record<string, string>; signal?: AbortSignal },
  deadlineMs: number,
): Promise<string[]> {
  try {
    const outcome = await run({
      ...codexMcpListInvocation(binaryPath),
      ...context,
      stdin: '',
      timeoutMs: Math.min(CODEX_MCP_LIST_TIMEOUT_MS, deadlineMs),
    })
    if (outcome.code !== 0 || outcome.timedOut || outcome.spawnError) return []
    return readCodexEnabledMcpServers(outcome.stdout)
  } catch {
    return []
  }
}

// Detection through the same 60 s cache the launch pre-flight uses, so a
// title never pays for a fresh login-shell probe when a spawn moments ago
// already answered. Errored probes are absent from the map, which reads here
// as "could not be probed" — never as "not installed".
async function cachedDetect(
  cli: string,
  runtime?: { command?: string; hostId?: ExecutionHostId },
): Promise<CliDetectResult> {
  const base = {
    cli,
    binary: runtime?.command?.trim() || cli,
    version: null,
    resolvedPath: null,
    hostId: runtime?.hostId ?? LOCAL_HOST_ID,
  }
  const entry = listPluginRegistryEntries().find((candidate) => candidate.id === cli)
  if (!entry) return { ...base, installed: false, error: `No plugin manifest found for "${cli}".` }
  const availability = await detectAgentCliAvailability(
    { cliRuntimes: runtime ? { [cli]: runtime } : undefined },
    { listEntries: () => [entry] },
  )
  const detected = availability[cli]
  if (!detected)
    return {
      ...base,
      binary: base.binary === cli ? entry.binary : base.binary,
      installed: false,
      error: 'the availability probe failed',
    }
  return {
    ...base,
    binary: base.binary === cli ? entry.binary : base.binary,
    installed: detected.installed,
    version: detected.version,
    resolvedPath: detected.resolvedPath,
    error: null,
  }
}

async function resolveBinary(
  cli: string,
  cliRuntimes: TextGenerationCliRuntimeOverrides | undefined,
  detect: NonNullable<TextGenerationServiceDeps['detect']>,
): Promise<{ ok: true; path: string } | Extract<TextGenerationResult, { ok: false }>> {
  const detection = await detect(cli, cliRuntimes?.[cli])
  if (detection.error !== null) {
    return { ok: false, code: 'unavailable', message: `${cli} could not be probed: ${detection.error}` }
  }
  if (!detection.installed) {
    return { ok: false, code: 'unavailable', message: `${cli} is not installed on this machine.` }
  }
  // The probe's absolute path is what the launch path executes too: it came
  // from the person's interactive shell, which is where a ~/.zshrc-only PATH
  // entry lives. A bare name is the last resort.
  const resolved = detection.resolvedPath?.trim()
  return { ok: true, path: resolved && path.isAbsolute(resolved) ? resolved : detection.binary }
}

// The launch PATH (managed runtime shims, the Studio CLI bin dir), minus the
// variables that would swing `claude` from its subscription login onto API
// billing or a third-party endpoint, plus thinking switched off. `--effort
// low` alone still lets `claude` spend ~1,700 thinking tokens on a title
// (measured 2026-09-08, claude 2.1.265: 10-23 s per call); with
// `MAX_THINKING_TOKENS=0` the same call answers in ~3 s with the same title.
// A title is a lookup, not a reasoning task. Codex has no such split; it
// inherits the same PATH untouched.
function engineEnv(cli: string, readEnv: (() => Record<string, string>) | undefined): Record<string, string> {
  const base = readEnv ? readEnv() : stringEnv(defaultProbeEnv())
  if (cli !== 'claude-code') return base
  const next = { ...base }
  for (const key of STRIPPED_ANTHROPIC_AUTH_ENV_KEYS) delete next[key]
  next.MAX_THINKING_TOKENS = '0'
  return next
}

function stringEnv(env: NodeJS.ProcessEnv): Record<string, string> {
  return Object.fromEntries(
    Object.entries(env).filter((entry): entry is [string, string] => typeof entry[1] === 'string'),
  )
}

function runFailure(
  cli: string,
  outcome: Awaited<ReturnType<RunCommand>>,
): Extract<TextGenerationResult, { ok: false }> | null {
  if (outcome.cancelled) return { ok: false, code: 'cancelled', message: `${cli} was stopped.` }
  if (outcome.spawnError) {
    return { ok: false, code: 'unavailable', message: `${cli} could not be started: ${outcome.spawnError}` }
  }
  if (outcome.timedOut) return { ok: false, code: 'timeout', message: `${cli} did not answer in time.` }
  if (outcome.code !== 0) {
    // Claude's own reason is in its stdout envelope; stderr then carries at
    // most a wrapper's notice, and a bare stdout fallback is the raw JSON.
    const claudeReason = cli === 'codex' ? null : readClaudeErrorResult(outcome.stdout)
    if (claudeReason) {
      return { ok: false, code: 'transport', message: `${cli} exited ${outcome.code}: ${lastLine(claudeReason)}` }
    }
    const detail = outcome.stderr.trim() || outcome.stdout.trim()
    return {
      ok: false,
      code: 'transport',
      message: detail ? `${cli} exited ${outcome.code}: ${failureReason(detail)}` : `${cli} exited ${outcome.code}.`,
    }
  }
  return null
}

// The one line of a failed run worth keeping. Usually the last line, but
// `codex exec` prints a refused API request as `ERROR:` followed by the
// response body pretty-printed over several lines — the last line of that is
// a lone `}` — so the body's own message is read out instead. A refused model
// or effort level then names itself in the diagnostics log.
function failureReason(detail: string): string {
  const marker = detail.lastIndexOf('ERROR:')
  if (marker !== -1) {
    const reason = apiErrorMessage(detail.slice(marker + 'ERROR:'.length).trim())
    if (reason) return reason
  }
  return lastLine(detail)
}

function apiErrorMessage(body: string): string | null {
  let parsed: unknown
  try {
    parsed = JSON.parse(body)
  } catch {
    return null
  }
  if (!parsed || typeof parsed !== 'object') return null
  const { error, message } = parsed as { error?: unknown; message?: unknown }
  const nested = error && typeof error === 'object' ? (error as { message?: unknown }).message : undefined
  const reason = typeof nested === 'string' ? nested : typeof message === 'string' ? message : null
  return reason?.trim() || null
}

function lastLine(text: string): string {
  const lines = text
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean)
  return lines[lines.length - 1] ?? text
}

function describe(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}
