import type { ConversationCommand } from '../../shared/conversation/commands'
import { leadingSlashCommand } from './leading-command'

/**
 * Codex's app-server has no command list: the terminal's slash commands are
 * RPCs there, and a `/compact` sent as text reaches the model as prose. The
 * menu offers the ones the Codex adapter runs itself: this one as
 * `thread/compact/start`, and `/goal` below.
 */
export const CODEX_COMPACT_COMMAND: ConversationCommand = {
  name: 'compact',
  description: 'Summarise the conversation to free context',
  source: 'cli',
}

/**
 * What a message asks of `/compact`: `run` when it is `/compact` and nothing
 * else, `refuse` when anything rides with it — instructions on the same line
 * or the next, images, or the context Studio adds for a file mention — since
 * Codex's compaction takes none of them and would drop them without a word;
 * null when the message is not `/compact` at all.
 */
export function codexCompactRequest(message: string, attachments = 0): 'run' | 'refuse' | null {
  if (leadingSlashCommand(message) !== CODEX_COMPACT_COMMAND.name) return null
  return message.trim() === '/compact' && attachments === 0 ? 'run' : 'refuse'
}

/**
 * A goal Codex keeps working toward: with one set, Codex starts its next turn
 * itself until the goal is met, paused or blocked. The adapter runs it as
 * `thread/goal/set`, `get` and `clear`, the words the terminal's `/goal` takes.
 */
export const CODEX_GOAL_COMMAND: ConversationCommand = {
  name: 'goal',
  description: 'Set a goal Codex keeps working toward',
  argumentHint: '[objective | pause | resume | clear]',
  source: 'cli',
}

/** The commands the Codex adapter runs itself, ahead of the folder's skills. */
export const CODEX_BUILT_IN_COMMANDS: readonly ConversationCommand[] = [CODEX_COMPACT_COMMAND, CODEX_GOAL_COMMAND]

export type CodexGoalRequest =
  | { action: 'show' | 'pause' | 'resume' | 'clear' }
  | { action: 'set'; objective: string }
  | { action: 'refuse'; message: string }

/**
 * What a message asks of `/goal`: on its own, to say the goal; `pause`,
 * `resume` or `clear` alone after it, that; anything else after it, the
 * objective to set, every line of it. Images are refused, since a goal is
 * words only and Codex would drop them without a word. Null when the message
 * is not `/goal` at all.
 */
export function codexGoalRequest(message: string, attachments = 0): CodexGoalRequest | null {
  if (leadingSlashCommand(message) !== CODEX_GOAL_COMMAND.name) return null
  if (attachments > 0) return { action: 'refuse', message: 'A Codex goal is words only: send /goal without images.' }
  const rest = message.trim().slice('/goal'.length).trim()
  if (!rest) return { action: 'show' }
  const word = rest.toLowerCase()
  if (word === 'pause' || word === 'resume' || word === 'clear') return { action: word }
  return { action: 'set', objective: rest }
}

/**
 * The skills Codex lists for a folder (`skills/list`), as composer entries that
 * insert a `$name` mention: Codex reads `$name` in a message as the skill.
 * Disabled skills are left out, since Codex will not run them.
 */
export function codexSkillCommands(response: unknown, cwd: string): ConversationCommand[] {
  const data = (response as { data?: unknown } | null)?.data
  if (!Array.isArray(data)) return []
  // One entry per requested folder; a single folder is asked for, so its entry
  // is the one naming it, or the only one if Codex spelled the path differently.
  const entry = (data.find((item) => (item as { cwd?: unknown })?.cwd === cwd) ??
    (data.length === 1 ? data[0] : null)) as {
    skills?: unknown
  } | null
  if (!Array.isArray(entry?.skills)) return []
  const commands: ConversationCommand[] = []
  const seen = new Set<string>()
  for (const skill of entry.skills as Array<Record<string, unknown>>) {
    if (!skill || typeof skill !== 'object' || skill.enabled === false) continue
    const name = typeof skill.name === 'string' ? skill.name.trim() : ''
    if (!name || /\s/.test(name) || seen.has(name)) continue
    seen.add(name)
    const face = (skill.interface ?? {}) as Record<string, unknown>
    // The short description is written for a one-line row; the full one is
    // written for the model and runs to paragraphs.
    const description = [face.shortDescription, skill.shortDescription, skill.description].find(
      (value): value is string => typeof value === 'string' && value.trim().length > 0,
    )
    commands.push({
      name,
      ...(description ? { description: description.trim() } : {}),
      insertText: `$${name} `,
      source: 'skill',
    })
  }
  return commands
}

/** Codex's whole `/` menu for a folder: `/compact` and `/goal`, then its skills. */
export function codexConversationCommands(skillsListResponse: unknown, cwd: string): ConversationCommand[] {
  const builtIn = new Set(CODEX_BUILT_IN_COMMANDS.map((command) => command.name))
  return [
    ...CODEX_BUILT_IN_COMMANDS,
    ...codexSkillCommands(skillsListResponse, cwd).filter((skill) => !builtIn.has(skill.name)),
  ]
}
