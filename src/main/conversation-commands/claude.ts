import type { Options, SDKUserMessage, SlashCommand } from '@anthropic-ai/claude-agent-sdk'

import type { ConversationCommand } from '../../shared/conversation/commands'
import type { ConversationCliRuntimeOverrides } from '../../shared/conversation-runtime'
import { isWslHostId } from '../../shared/execution-host'

/** The CLI id a Claude chat's command list is kept under. */
export const CLAUDE_COMMANDS_CLI = 'claude-code'

/**
 * Commands Claude Code lists that a chat must not offer. The list was read off
 * Claude Code 2.1.284's own answer for a chat's options (67 rows), and each
 * entry is dropped for what it does to a chat, not for how it is spelled:
 * - `clear` (typed also as `reset` or `new`): starts a new CLI conversation.
 *   The chat would keep showing a history the model no longer has, and every
 *   "Edit from here" point would name the conversation it left.
 * - `resume`, `exit`, `quit`: leave the conversation the chat follows. Claude
 *   Code keeps them out of a headless list today; listed in case it stops.
 * - `model`, `effort`: the composer's model and effort controls own these. Set
 *   inside the CLI they would change behind a picker that still names the old
 *   value, and the next respawn would put the picker's value back.
 * - `workflow-launch-exec`, and any name starting with `_`: the CLI's plumbing
 *   for sessions a server launched, not something a person types.
 * The terminal-bound commands are dropped too (see `TERMINAL_ONLY`), as are
 * rows that only say where a command went (`(removed) …`, `Renamed to /…`).
 */
const NOT_FOR_CHAT = new Set([
  'clear',
  'reset',
  'new',
  'resume',
  'exit',
  'quit',
  'model',
  'effort',
  'workflow-launch-exec',
])

/**
 * Commands whose effect is on the CLI's own terminal screen (a prompt-bar
 * colour, a focus view, a status line), which a chat does not have. A live
 * session names these itself in its init (`terminal_slash_commands`) and that
 * list wins; a probe gets no init, so it uses the names Claude Code 2.1.284
 * reported there, plus the two it marks the same way but keeps out of a
 * headless list (`exit`, `statusline`).
 */
const TERMINAL_ONLY = ['color', 'doctor', 'focus', 'reload-plugins', 'statusline', 'exit']

// A row that only points somewhere else: `/agents` reads "(removed) Ask Claude
// to…", `/extra-usage` reads "Renamed to /usage-credits".
const REDIRECT_DESCRIPTION = /^\s*(?:\(removed\)|renamed to \/)/i

/** A SlashCommand row as the CLI sends it; newer CLIs add `builtin`. */
type SlashCommandRow = Partial<SlashCommand> & { builtin?: unknown }

function offeredInChat(name: string, terminal: ReadonlySet<string>): boolean {
  return !name.startsWith('_') && !NOT_FOR_CHAT.has(name) && !terminal.has(name)
}

/**
 * The composer's rows from Claude Code's `supportedCommands()` (or a
 * `commands_changed` push). Names stay exactly as the CLI reports them, a
 * plugin's `plugin:name` included, because that is what it runs when typed.
 *
 * Where a row comes from is not in the SDK's type. A CLI that marks its own
 * rows `builtin` (Claude Code 2.1.284 does) makes the rest tell-able: a
 * built-in is `cli`, and among the others a name the CLI also lists as a skill
 * is `skill` and anything else is `custom`. The skill names come from the
 * probe's `reloadSkills()` or a live session's init. A CLI that marks nothing
 * leaves built-ins and custom commands indistinguishable, and both read as
 * `custom`.
 */
export function mapClaudeCommands(
  rows: readonly unknown[],
  context: { skills?: readonly string[] | null; terminal?: readonly string[] | null } = {},
): ConversationCommand[] {
  const skills = new Set(context.skills ?? [])
  const terminal = new Set(context.terminal ?? TERMINAL_ONLY)
  const byName = new Map<string, { command: ConversationCommand; builtin: boolean }>()
  for (const raw of rows) {
    if (!raw || typeof raw !== 'object') continue
    const row = raw as SlashCommandRow
    const name = typeof row.name === 'string' ? row.name.trim().replace(/^\//, '') : ''
    // The composer inserts `/name ` and the CLI reads up to the first space.
    if (!name || /\s/.test(name) || !offeredInChat(name, terminal)) continue
    const description = typeof row.description === 'string' ? row.description.trim() : ''
    if (REDIRECT_DESCRIPTION.test(description)) continue
    const builtin = row.builtin === true
    // Rows can share a name, and the CLI runs the one it marks as its own.
    const existing = byName.get(name)
    if (existing && (existing.builtin || !builtin)) continue
    const aliases = Array.isArray(row.aliases)
      ? row.aliases.filter((alias): alias is string => typeof alias === 'string' && alias.trim().length > 0)
      : []
    const argumentHint = typeof row.argumentHint === 'string' ? row.argumentHint.trim() : ''
    const isSkill = skills.has(name) || aliases.some((alias) => skills.has(alias))
    const command: ConversationCommand = {
      name,
      ...(description ? { description } : {}),
      ...(argumentHint ? { argumentHint } : {}),
      ...(aliases.length ? { aliases } : {}),
      source: builtin ? 'cli' : isSkill ? 'skill' : 'custom',
    }
    byName.set(name, { command, builtin })
  }
  return [...byName.values()].map((entry) => entry.command)
}

/**
 * The list a live session's init names (`slash_commands`, names only), as
 * composer rows. Rows the list already holds keep their description, hint and
 * source, in their order; a name it does not know (an MCP server's prompt, a
 * skill added since the probe) is added after them with its name alone.
 */
export function claudeCommandsFromInit(
  init: { slash_commands?: unknown; terminal_slash_commands?: unknown; skills?: unknown },
  known: readonly ConversationCommand[],
): ConversationCommand[] | null {
  if (!Array.isArray(init.slash_commands)) return null
  const terminal = new Set(strings(init.terminal_slash_commands) ?? TERMINAL_ONLY)
  const skills = new Set(strings(init.skills) ?? [])
  const names = new Set(
    strings(init.slash_commands)
      ?.map((name) => name.trim().replace(/^\//, ''))
      .filter((name) => name && !/\s/.test(name) && offeredInChat(name, terminal)),
  )
  const kept = known.filter((command) => names.has(command.name))
  const keptNames = new Set(kept.map((command) => command.name))
  const added: ConversationCommand[] = [...names]
    .filter((name) => !keptNames.has(name))
    .map((name) => ({ name, source: skills.has(name) ? 'skill' : 'custom' }))
  return [...kept, ...added]
}

/** The terminal-bound names a live session's init reports, or null when it reports none. */
export function initTerminalCommands(init: { terminal_slash_commands?: unknown }): string[] | null {
  return strings(init.terminal_slash_commands)
}

/** The skill names a live session's init reports, or null when it reports none. */
export function initSkillNames(init: { skills?: unknown }): string[] | null {
  return strings(init.skills)
}

/** Whether two lists offer the same names in the same order. */
export function sameCommandNames(a: readonly ConversationCommand[], b: readonly ConversationCommand[]): boolean {
  return a.length === b.length && a.every((command, index) => command.name === b[index]?.name)
}

function strings(value: unknown): string[] | null {
  return Array.isArray(value) ? value.filter((entry): entry is string => typeof entry === 'string') : null
}

// ── Probe: the list before a chat has said anything ────────────────────────

type CommandsQuery = {
  supportedCommands: () => Promise<SlashCommand[]>
  reloadSkills?: () => Promise<{ skills?: SlashCommand[] }>
  close: () => void
}

type QueryFunction = (input: { prompt: AsyncIterable<SDKUserMessage>; options: Options }) => CommandsQuery

export type ClaudeCommandsProbeDeps = {
  loadQuery?: () => Promise<QueryFunction>
  resolveExecutable?: (cliRuntimes?: ConversationCliRuntimeOverrides) => Promise<string>
  env?: () => Promise<Record<string, string>> | Record<string, string>
  timeoutMs?: number
}

const CLAUDE_COMMANDS_PROBE_TIMEOUT_MS = 20_000

/**
 * Claude Code's command list for a folder, asked the way a chat's session
 * would load it but with no turn sent: `query()` starts the CLI on an input
 * that never yields and asks `supportedCommands()`, which the CLI answers from
 * its initialize handshake (about 600 ms, nothing billed).
 *
 * The options that decide which commands exist match a chat's session: the
 * same executable and environment (the person's login, no inherited API key),
 * the chat's folder as cwd, and `settingSources: ['user']` — a repository's
 * settings are never loaded, so its commands and skills are not listed, just
 * as a chat does not load them. The chat's attached-skills plugin is its own
 * per-chat state and is not part of a folder's list. What a probe does not
 * need is off: hooks (they would run the person's commands just to list) and
 * MCP servers (they would be started to be asked nothing). The prompts an MCP
 * server offers as commands therefore arrive only from a live session's init.
 */
export async function probeClaudeConversationCommands(
  input: { cwd: string; cliRuntimes?: ConversationCliRuntimeOverrides },
  deps: ClaudeCommandsProbeDeps = {},
): Promise<ConversationCommand[]> {
  if (isWslHostId(input.cliRuntimes?.[CLAUDE_COMMANDS_CLI]?.hostId)) {
    throw new Error('Claude Code commands cannot be listed on a WSL machine yet.')
  }
  const timeoutMs = deps.timeoutMs ?? CLAUDE_COMMANDS_PROBE_TIMEOUT_MS
  const abort = new AbortController()
  let timer: ReturnType<typeof setTimeout> | undefined
  let session: CommandsQuery | undefined
  try {
    const [query, executable, env] = await Promise.all([
      (deps.loadQuery ?? defaultLoadQuery)(),
      (deps.resolveExecutable ?? defaultResolveExecutable)(input.cliRuntimes),
      (deps.env ?? defaultEnv)(),
    ])
    const { noTurns, probeEnv } = await import('../model-discovery/agent-sdk-probe')
    session = query({
      prompt: noTurns(abort.signal),
      options: {
        cwd: input.cwd,
        pathToClaudeCodeExecutable: executable,
        settingSources: ['user'],
        settings: { disableAllHooks: true },
        strictMcpConfig: true,
        env: probeEnv(env),
        abortController: abort,
      },
    })
    const deadline = new Promise<never>((_, reject) => {
      timer = setTimeout(
        () => reject(new Error(`Claude Code did not list its commands within ${Math.round(timeoutMs / 1000)} s.`)),
        timeoutMs,
      )
    })
    const rows = await Promise.race([session.supportedCommands(), deadline])
    // Which of the rows are skills, for the menu's grouping. A CLI without
    // the request still lists every command, just with coarser sources.
    const skills = session.reloadSkills
      ? await Promise.race([session.reloadSkills(), deadline])
          .then((answer) => answer.skills?.map((skill) => skill.name) ?? null)
          .catch(() => null)
      : null
    return mapClaudeCommands(rows, { skills })
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

async function defaultLoadQuery(): Promise<QueryFunction> {
  const sdk = await import('@anthropic-ai/claude-agent-sdk')
  return sdk.query as unknown as QueryFunction
}

async function defaultResolveExecutable(cliRuntimes?: ConversationCliRuntimeOverrides): Promise<string> {
  const { resolveClaudeExecutable } = await import('../providers/claude-agent-provider')
  return resolveClaudeExecutable(cliRuntimes)
}

async function defaultEnv(): Promise<Record<string, string>> {
  const { claudeChatBaseEnv } = await import('../providers/claude-agent-provider')
  return claudeChatBaseEnv()
}
