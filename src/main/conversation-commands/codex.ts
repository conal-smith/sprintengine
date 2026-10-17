import type { ConversationCommand } from '../../shared/conversation/commands'
import { leadingSlashCommand } from './leading-command'

/**
 * Codex's app-server has no command list: the terminal's slash commands are
 * RPCs there, and a `/compact` sent as text reaches the model as prose. This is
 * the one the Codex adapter runs itself (`thread/compact/start`), so it is the
 * one the menu offers.
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

/** A skill Codex lists for a folder, with the `SKILL.md` path it names it by. */
export type CodexListedSkill = { name: string; path: string | null; description?: string }

/**
 * The enabled skills Codex lists for a folder (`skills/list`), one per name,
 * in Codex's order. Disabled skills are left out, since Codex will not run them.
 */
export function codexListedSkills(response: unknown, cwd: string): CodexListedSkill[] {
  const data = (response as { data?: unknown } | null)?.data
  if (!Array.isArray(data)) return []
  // One entry per requested folder; a single folder is asked for, so its entry
  // is the one naming it, or the only one if Codex spelled the path differently.
  const entry = (data.find((item) => (item as { cwd?: unknown })?.cwd === cwd) ??
    (data.length === 1 ? data[0] : null)) as {
    skills?: unknown
  } | null
  if (!Array.isArray(entry?.skills)) return []
  const skills: CodexListedSkill[] = []
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
    skills.push({
      name,
      path: typeof skill.path === 'string' && skill.path ? skill.path : null,
      ...(description ? { description: description.trim() } : {}),
    })
  }
  return skills
}

/**
 * The skills Codex lists for a folder, as composer entries that insert a
 * `$name` mention: Codex reads `$name` in a message as the skill.
 */
export function codexSkillCommands(response: unknown, cwd: string): ConversationCommand[] {
  return codexListedSkills(response, cwd).map(({ name, description }) => ({
    name,
    ...(description ? { description } : {}),
    insertText: `$${name} `,
    source: 'skill',
  }))
}

// What may continue a skill's name, so `$deploy-prod` is not `$deploy`.
const NAME_CHAR = /[\p{L}\p{N}_:-]/u

/**
 * The skills a message mentions as whole `$name` tokens, as the structured
 * inputs `turn/start` takes beside the text (`{ type: 'skill', name, path }`):
 * Codex then loads the skill it listed under that path, not whichever skill a
 * bare name happens to match. A `$` inside a word or a name Codex did not
 * list stays text. Each skill once, in the order first mentioned; where two
 * listed names both fit (`$a` and `$a.b` at `$a.b`), the longer one.
 */
export function codexSkillInputs(
  message: string,
  skills: readonly CodexListedSkill[],
): Array<{ type: 'skill'; name: string; path: string }> {
  const listed = skills.filter((skill): skill is CodexListedSkill & { path: string } => skill.path !== null)
  if (!listed.length || !message.includes('$')) return []
  const byLength = [...listed].sort((a, b) => b.name.length - a.name.length)
  const inputs: Array<{ type: 'skill'; name: string; path: string }> = []
  const taken = new Set<string>()
  for (let at = message.indexOf('$'); at !== -1; at = message.indexOf('$', at + 1)) {
    const before = at > 0 ? message[at - 1] : ''
    if (before === '$' || (before && NAME_CHAR.test(before))) continue
    const skill = byLength.find(({ name }) => {
      if (!message.startsWith(name, at + 1)) return false
      const after = message[at + 1 + name.length]
      return after === undefined || !NAME_CHAR.test(after)
    })
    if (!skill || taken.has(skill.name)) continue
    taken.add(skill.name)
    inputs.push({ type: 'skill', name: skill.name, path: skill.path })
  }
  return inputs
}

/** Codex's whole `/` menu for a folder: `/compact`, then its skills. */
export function codexConversationCommands(skillsListResponse: unknown, cwd: string): ConversationCommand[] {
  return [
    CODEX_COMPACT_COMMAND,
    ...codexSkillCommands(skillsListResponse, cwd).filter((skill) => skill.name !== CODEX_COMPACT_COMMAND.name),
  ]
}
