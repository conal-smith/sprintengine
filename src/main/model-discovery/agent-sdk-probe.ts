// Claude Code's model list, asked through the Agent SDK's control channel.
//
// `query()` starts the CLI with a streaming input that never yields, so no user
// turn is sent and nothing is billed; `supportedModels()` is answered by the
// CLI's own initialize handshake through the person's `claude` login. Measured
// 2026-09-22 against Claude Code 2.1.280: five rows in well under two seconds.
//
// The rows are taken exactly as the CLI reports them. An alias (`default`,
// `opus[1m]`, `sonnet`) is a first-class id: the CLI resolves it to its current
// model at launch, which is the reason to offer the alias at all. Its
// `resolvedModel` is kept as a display hint only (see DiscoveredCliModel).
import { isWslHostId } from '../../shared/execution-host'
import { isAbsolute } from 'path'
import type { ModelInfo, Options, SDKUserMessage } from '@anthropic-ai/claude-agent-sdk'

import type { DiscoveredCliModel } from '../../shared/cli-model-catalog'
import { defaultProbeEnv } from '../cli-runtime-install'
import { stripAnthropicAuthEnv } from '../providers/claude-agent-provider'
import { CliModelProbeError, type CliModelProbeContext } from './probe-types'

type SupportedModelsQuery = {
  supportedModels: () => Promise<ModelInfo[]>
  close: () => void
}

type QueryFunction = (input: { prompt: AsyncIterable<SDKUserMessage>; options: Options }) => SupportedModelsQuery

export type AgentSdkProbeDeps = {
  loadQuery?: () => Promise<QueryFunction>
  env?: () => Record<string, string>
}

export function mapAgentSdkModels(rows: readonly ModelInfo[]): DiscoveredCliModel[] {
  const seen = new Set<string>()
  const models: DiscoveredCliModel[] = []
  for (const row of rows) {
    const id = typeof row.value === 'string' ? row.value.trim() : ''
    if (!id || seen.has(id)) continue
    seen.add(id)
    const model: DiscoveredCliModel = { id }
    if (row.displayName?.trim()) model.displayName = row.displayName.trim()
    if (row.description?.trim()) model.description = row.description.trim()
    if (row.resolvedModel?.trim()) model.resolvedModel = row.resolvedModel.trim()
    if (row.supportedEffortLevels && row.supportedEffortLevels.length > 0) {
      model.effortLevels = [...row.supportedEffortLevels]
    }
    if (typeof row.supportsFastMode === 'boolean') model.supportsFastMode = row.supportsFastMode
    models.push(model)
  }
  return models
}

async function defaultLoadQuery(): Promise<QueryFunction> {
  const sdk = await import('@anthropic-ai/claude-agent-sdk')
  return sdk.query
}

// The subscription login, not an inherited key: the CLI prefers an
// ANTHROPIC_API_KEY over its own login silently, and a base URL would point the
// question at another endpoint. Same stripping the conversation provider does.
function defaultEnv(): Record<string, string> {
  const env = Object.fromEntries(
    Object.entries(defaultProbeEnv()).filter((entry): entry is [string, string] => typeof entry[1] === 'string'),
  )
  return stripAnthropicAuthEnv(env)
}

/**
 * A probe asks one question and exits, so nothing an IDE connection brings can
 * reach its answer. Claude Code still looks for a running IDE at startup, and
 * on Windows that lookup is a `tasklist` process tree per probe. Both probes
 * that start Claude Code (models here, commands in
 * conversation-commands/claude.ts) run with it off.
 */
export function probeEnv(env: Record<string, string>): Record<string, string> {
  const { FORCE_CODE_TERMINAL: _terminal, ...rest } = env
  return { ...rest, CLAUDE_CODE_AUTO_CONNECT_IDE: '0', CLAUDE_CODE_IDE_SKIP_AUTO_INSTALL: '1' }
}

// An input stream with no turns in it. It ends when the probe is torn down, so
// the SDK's reader is not left awaiting forever after close(). The command
// probe (conversation-commands/claude.ts) asks its question the same way.
export function noTurns(signal: AbortSignal): AsyncIterable<SDKUserMessage> {
  const ended = new Promise<void>((resolve) => {
    if (signal.aborted) resolve()
    else signal.addEventListener('abort', () => resolve(), { once: true })
  })
  return {
    [Symbol.asyncIterator]: () => ({
      next: () => ended.then((): IteratorResult<SDKUserMessage> => ({ done: true, value: undefined })),
    }),
  }
}

export async function probeAgentSdkModels(
  context: Pick<CliModelProbeContext, 'binary' | 'hostId' | 'timeoutMs' | 'displayName'>,
  deps: AgentSdkProbeDeps = {},
): Promise<DiscoveredCliModel[]> {
  if (isWslHostId(context.hostId)) {
    throw new CliModelProbeError(`${context.displayName} models cannot be listed under WSL yet.`)
  }
  if (!isAbsolute(context.binary)) {
    throw new CliModelProbeError(`${context.displayName} was found, but its path could not be resolved.`)
  }
  const loadQuery = deps.loadQuery ?? defaultLoadQuery
  const abort = new AbortController()
  let timer: ReturnType<typeof setTimeout> | undefined
  let session: SupportedModelsQuery | undefined
  try {
    const query = await loadQuery()
    session = query({
      prompt: noTurns(abort.signal),
      options: {
        tools: [],
        settingSources: [],
        pathToClaudeCodeExecutable: context.binary,
        env: probeEnv((deps.env ?? defaultEnv)()),
        abortController: abort,
      },
    })
    const deadline = new Promise<never>((_, reject) => {
      timer = setTimeout(
        () =>
          reject(
            new CliModelProbeError(
              `${context.displayName} did not list its models within ${Math.round(context.timeoutMs / 1000)} s.`,
            ),
          ),
        context.timeoutMs,
      )
    })
    return mapAgentSdkModels(await Promise.race([session.supportedModels(), deadline]))
  } catch (error) {
    if (error instanceof CliModelProbeError) throw error
    const detail = error instanceof Error ? error.message : String(error)
    throw new CliModelProbeError(`${context.displayName} did not list its models: ${detail}`)
  } finally {
    if (timer) clearTimeout(timer)
    // close() ends the child; the abort is the backstop that kills it if close
    // was not reached or did not take, so a hung CLI never outlives the probe.
    try {
      session?.close()
    } catch {
      // Already closed.
    }
    abort.abort()
  }
}
