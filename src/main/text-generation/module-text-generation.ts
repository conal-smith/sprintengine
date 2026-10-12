// Headless text generation for modules (SDK `getTextGenerationService`): one
// prompt answered by the person's own agent CLI, with no workspace, no tools
// and no tab. Built on the call that titles chats (text-generation-service.ts),
// so it carries the same guarantees: the CLI's own login and never an API key,
// a scratch directory rather than a checkout, one shot.
//
// Every CLI the app has a headless backend for answers (Claude Code and Codex,
// `supportsTextGeneration`). A call that names none runs on the engine the
// person chose for Studio's own text generation in Settings, and on Claude
// Code's small model when they chose none; a call that names a CLI but no model
// runs that CLI's chosen model when it is the person's, else its small one.
//
// `agents:generate` is checked on every call, as the conversation service
// checks its permissions. Each module has its own lane: two calls run at once,
// a few more wait their turn, and a module calling faster than a person could
// read the answers is told `busy` rather than queued without end. One module's
// flood never slows another's calls.

import type { ExecutionHostId } from '../../shared/execution-host'
import type {
  ModuleTextGenerationErrorCode,
  ModuleTextGenerationInput,
  ModuleTextGenerationRegistry,
  ModuleTextGenerationResult,
} from '../../shared/modules/conversation-service'
import {
  supportsTextGeneration,
  textGenerationEngineWithDefaults,
  type TextGenerationEngine,
  type TextGenerationEngineSettings,
} from '../../shared/text-generation/contract'
import { extractJson } from '../companion-agent-service'
import type { HeadlessTextRequest, HeadlessTextResult } from './text-generation-service'

/** The runtime a call answers on when neither the module nor the person chose one. */
export const MODULE_TEXT_DEFAULT_CLI = 'claude-code'

/**
 * The engine a call that names no CLI runs on: the one the person chose for
 * Studio's text generation, when it is one with a headless backend, else
 * Claude Code; each with its backend's cheap defaults filled in.
 */
export function moduleTextGenerationEngine(
  settings: TextGenerationEngineSettings | null | undefined,
): TextGenerationEngine {
  const chosen = settings?.engine
  return textGenerationEngineWithDefaults(
    chosen && supportsTextGeneration(chosen.cli) ? chosen : { cli: MODULE_TEXT_DEFAULT_CLI, model: '' },
  )
}

// Bounds on what one call may carry: a long digest fits, a runaway does not.
const MAX_PROMPT_CHARS = 400_000
const MAX_SYSTEM_CHARS = 40_000
const MAX_OUTPUT_TOKENS = 64_000
// A model id is one argv entry: a name, never something read as a flag.
const MODEL_ID = /^[A-Za-z0-9][A-Za-z0-9._:/[\]-]{0,199}$/
// A long prompt to a small model still answers within a couple of minutes.
const CALL_TIMEOUT_MS = 180_000

// Each module's lane.
const MAX_RUNNING = 2
const MAX_WAITING = 8
const RATE_WINDOW_MS = 60_000
const MAX_CALLS_PER_WINDOW = 30

// Said after the module's own system prompt when it asked for JSON.
const JSON_NOTE = 'Answer with a single JSON value and nothing else: no prose before or after it, and no code fence.'

export type ModuleTextGenerationDeps = {
  /** The permissions the module declared in its manifest. */
  getModulePermissions: (moduleId: string) => readonly string[] | undefined
  /** One headless call (generateHeadlessText). */
  generate: (request: HeadlessTextRequest) => Promise<HeadlessTextResult>
  /** The person's CLI command overrides, read per call. */
  getCliRuntimes?: () => Record<string, { command?: string; hostId?: ExecutionHostId } | undefined> | undefined
  /** The person's text-generation setting (Settings), read per call; absent, none chosen. */
  getTextGenerationSettings?: () => TextGenerationEngineSettings | null | undefined
  now?: () => number
}

type Lane = { running: number; waiting: Array<() => void>; calls: number[] }

function refuse(code: ModuleTextGenerationErrorCode, message: string): ModuleTextGenerationResult {
  return { ok: false, code, message }
}

function invalidInput(input: ModuleTextGenerationInput): string | null {
  if (typeof input !== 'object' || input === null) return 'generate takes an object.'
  if (typeof input.prompt !== 'string' || !input.prompt.trim()) return '"prompt" is required.'
  if (input.prompt.length > MAX_PROMPT_CHARS) return `"prompt" is longer than ${MAX_PROMPT_CHARS} characters.`
  if (input.system !== undefined && (typeof input.system !== 'string' || input.system.length > MAX_SYSTEM_CHARS))
    return `"system" must be a string of at most ${MAX_SYSTEM_CHARS} characters.`
  if (input.model !== undefined && (typeof input.model !== 'string' || !MODEL_ID.test(input.model.trim())))
    return '"model" must be a model id, such as "claude-haiku-4-5" or "haiku".'
  if (
    input.maxOutputTokens !== undefined &&
    !(
      Number.isSafeInteger(input.maxOutputTokens) &&
      input.maxOutputTokens >= 1 &&
      input.maxOutputTokens <= MAX_OUTPUT_TOKENS
    )
  )
    return `"maxOutputTokens" must be a whole number from 1 to ${MAX_OUTPUT_TOKENS}.`
  if (input.json !== undefined && typeof input.json !== 'boolean') return '"json" must be true or false.'
  if (input.cli !== undefined && typeof input.cli !== 'string') return '"cli" must be a chat runtime id.'
  return null
}

// What a failed call says to the module, in its own vocabulary.
function failureCode(code: Extract<HeadlessTextResult, { ok: false }>['code']): ModuleTextGenerationErrorCode {
  switch (code) {
    case 'unsupported':
      return 'unsupported'
    case 'unavailable':
      return 'unavailable'
    case 'timeout':
      return 'timeout'
    case 'guardrail':
      return 'invalid_output'
    default:
      return 'failed'
  }
}

export function createModuleTextGenerationRegistry(deps: ModuleTextGenerationDeps): ModuleTextGenerationRegistry {
  const now = deps.now ?? Date.now
  const lanes = new Map<string, Lane>()

  function laneOf(moduleId: string): Lane {
    let lane = lanes.get(moduleId)
    if (!lane) {
      lane = { running: 0, waiting: [], calls: [] }
      lanes.set(moduleId, lane)
    }
    return lane
  }

  // A place in the module's lane, or why there is none.
  async function enter(lane: Lane): Promise<string | null> {
    const at = now()
    lane.calls = lane.calls.filter((call) => call > at - RATE_WINDOW_MS)
    if (lane.calls.length >= MAX_CALLS_PER_WINDOW) {
      return `This module asked for more than ${MAX_CALLS_PER_WINDOW} answers in a minute; try again shortly.`
    }
    if (lane.running >= MAX_RUNNING && lane.waiting.length >= MAX_WAITING) {
      return `This module already has ${MAX_RUNNING + MAX_WAITING} prompts running or waiting; try again when one has answered.`
    }
    lane.calls.push(at)
    if (lane.running >= MAX_RUNNING) await new Promise<void>((resolve) => lane.waiting.push(resolve))
    lane.running += 1
    return null
  }

  function leave(lane: Lane): void {
    lane.running -= 1
    lane.waiting.shift()?.()
  }

  return {
    async generate(moduleId, input) {
      if (!(deps.getModulePermissions(moduleId) ?? []).includes('agents:generate')) {
        return refuse('permission_missing', `Module "${moduleId}" must declare the "agents:generate" permission.`)
      }
      const invalid = invalidInput(input)
      if (invalid) return refuse('invalid_input', invalid)
      const preferred = moduleTextGenerationEngine(deps.getTextGenerationSettings?.())
      const cli = input.cli?.trim() || preferred.cli
      if (!supportsTextGeneration(cli)) {
        return refuse(
          'unsupported',
          `"${cli}" cannot answer a prompt headlessly here; use "claude-code" or "codex", or leave "cli" out.`,
        )
      }
      // The person's own pick when the call runs on their CLI, else that CLI's small model.
      const base = cli === preferred.cli ? preferred : textGenerationEngineWithDefaults({ cli, model: '' })
      const model = input.model?.trim()
      const engine: TextGenerationEngine = model ? { ...base, model } : base
      const lane = laneOf(moduleId)
      const refused = await enter(lane)
      if (refused) return refuse('busy', refused)
      try {
        const system = [input.system?.trim(), input.json ? JSON_NOTE : ''].filter(Boolean).join('\n\n')
        const cliRuntimes = deps.getCliRuntimes?.()
        const answered = await deps.generate({
          prompt: input.prompt,
          ...(system ? { system } : {}),
          engine,
          ...(input.maxOutputTokens !== undefined ? { maxOutputTokens: input.maxOutputTokens } : {}),
          ...(cliRuntimes ? { cliRuntimes } : {}),
          timeoutMs: CALL_TIMEOUT_MS,
        })
        if (!answered.ok) return refuse(failureCode(answered.code), answered.message)
        if (!input.json) return { ok: true, text: answered.text, usage: answered.usage, model: answered.model }
        const value = extractJson(answered.text)
        if (value === undefined) return refuse('invalid_output', 'The model did not answer with JSON.')
        return { ok: true, text: JSON.stringify(value), usage: answered.usage, model: answered.model }
      } catch (error) {
        return refuse('failed', error instanceof Error ? error.message : String(error))
      } finally {
        leave(lane)
      }
    },
  }
}
