import { readFile, stat, realpath } from 'fs/promises'
import { basename, dirname, join, resolve } from 'path'
import type { ConversationSkillRef, ConversationCapabilities } from '../shared/conversation-runtime'
import { SKILL_HARNESS_DIR, SKILL_PACK_HARNESSES } from '../shared/skill-harnesses'
import { createWorkspaceSkillsService } from './workspace-skills-service'
import { createAgentSkillInstaller } from './agent-skill-installer'
import { builtinSkillSourceRoot, findBuiltinSkill } from './builtin-skills'
import { skillWithoutPermissionKeys } from './claude-project-commands'
import { isOwnSkillEntry, skillDirStaysInRoot } from './skills/skill-dir-containment'

/**
 * `invocation` is the CLI's own way of running the skills by name, to open the
 * message with; `context` is their instructions, for a provider no CLI stands
 * behind to load a skill from disk.
 */
export type ResolvedConversationSkills = { ids: string[]; context?: string; invocation?: string }
export type ConversationSkillsResolver = (input: {
  workspaceRoot: string
  skills: ConversationSkillRef[]
  mode: ConversationCapabilities['skills']
  /** The CLI behind the chat, when one is: it decides how a skill is run. */
  cli?: string | null
  /** Skills this chat has already run; they stay in the CLI's own history, so they are not run again. */
  invoked?: ReadonlySet<string>
}) => Promise<ResolvedConversationSkills>

type SkillInvocation = {
  /** The workspace folders the CLI finds skills in, each holding `skills/<id>/SKILL.md`. */
  dirs: readonly string[]
  render: (ids: readonly string[]) => string
}

// A CLI that loads skills itself is told which to run, in the form it parses,
// rather than handed the SKILL.md: the skill then arrives the way the CLI's own
// picker would send it, with its folder, scripts and references beside it, and
// costs a name instead of the whole file on every turn. The first `/name` opens
// the message, which is the one place an ACP agent runs a command; the rest are
// named inline, and the model starts them with its skill tool. OpenCode runs
// skills only through that tool, so it is asked by name.
const slashInvocation = (ids: readonly string[]) => ids.map((id) => `/${id}`).join(' ')
const CLI_SKILL_INVOCATION: Readonly<Record<string, SkillInvocation>> = {
  codex: { dirs: ['.codex', '.agents'], render: (ids) => ids.map((id) => `$${id}`).join(' ') },
  cursor: { dirs: ['.cursor', '.claude', '.codex', '.agents'], render: slashInvocation },
  grok: { dirs: ['.grok'], render: slashInvocation },
  opencode: {
    dirs: ['.opencode', '.claude', '.agents'],
    render: (ids) =>
      ids.length === 1
        ? `Use the ${ids[0]} skill.`
        : `Use the ${ids.slice(0, -1).join(', ')} and ${ids[ids.length - 1]} skills.`,
  },
}

/** Resolve the same workspace inventory and installer used by skill chips. */
export function createConversationSkillsResolver(
  options: {
    inventory?: ReturnType<typeof createWorkspaceSkillsService>
    installer?: Pick<ReturnType<typeof createAgentSkillInstaller>, 'attach'>
  } = {},
): ConversationSkillsResolver {
  const inventory = options.inventory ?? createWorkspaceSkillsService()
  const installer = options.installer ?? createAgentSkillInstaller()
  return async ({ workspaceRoot, skills, mode, cli, invoked }) => {
    if (skills.length === 0) return { ids: [] }
    if (mode === 'none') throw new Error('This conversation provider does not support attached skills.')
    const invocation = mode === 'context' && cli ? CLI_SKILL_INVOCATION[cli] : undefined
    if (invocation) {
      const ids: string[] = []
      const readable = async (id: string) => {
        for (const dir of invocation.dirs)
          if (await isFile(join(workspaceRoot, dir, 'skills', id, 'SKILL.md'))) return true
        return false
      }
      for (const skill of skills) {
        if (!/^[\w.-]+(?::[\w.-]+)?$/.test(skill.id) || skill.id === '.' || skill.id === '..')
          throw new Error('Attached skill identity is invalid.')
        if (ids.includes(skill.id)) continue
        if (!(await readable(skill.id))) {
          const attached = await installer.attach({ workspaceRoot, skillId: skill.id })
          if (!attached.ok) throw new Error(`Could not attach ${skill.id}: ${attached.message}`)
          if (!(await readable(skill.id)))
            throw new Error(`Skill ${skill.id} could not be installed where ${cli} reads skills.`)
        }
        ids.push(skill.id)
      }
      const fresh = ids.filter((id) => !invoked?.has(id))
      return { ids, ...(fresh.length ? { invocation: invocation.render(fresh) } : {}) }
    }
    const listed = await inventory.listWorkspaceSkills({ workspaceRoot })
    if (!listed.ok) throw new Error(listed.message)
    const ids: string[] = []
    const sections: string[] = []
    let totalBytes = 0
    for (const skill of skills) {
      if (!/^[\w.-]+(?::[\w.-]+)?$/.test(skill.id) || skill.id === '.' || skill.id === '..')
        throw new Error('Attached skill identity is invalid.')
      if (ids.includes(skill.id)) continue
      const known = listed.skills.find((entry) => entry.id === skill.id)
      if (mode === 'native') {
        const installed = join(workspaceRoot, '.claude', 'skills', skill.id, 'SKILL.md')
        if (!(await isFile(installed))) {
          const attached = await installer.attach({ workspaceRoot, skillId: skill.id })
          if (!attached.ok) throw new Error(`Could not attach ${skill.id}: ${attached.message}`)
          if (!(await isFile(installed)))
            throw new Error(`Skill ${skill.id} could not be installed for this conversation.`)
        }
      } else {
        if (!known || known.installState === 'available')
          throw new Error(`Skill ${skill.id} must be installed before its instructions can be attached.`)
        const installedPaths: string[] = []
        for (const harness of SKILL_PACK_HARNESSES) {
          const candidate = join(workspaceRoot, SKILL_HARNESS_DIR[harness], 'skills', skill.id, 'SKILL.md')
          if (await isFile(candidate)) installedPaths.push(await realpath(candidate))
        }
        let source: string | undefined
        if (skill.sourcePath) {
          const candidate = resolve(workspaceRoot, skill.sourcePath)
          source = basename(candidate) === 'SKILL.md' ? candidate : join(candidate, 'SKILL.md')
        } else if (known) {
          for (const harness of SKILL_PACK_HARNESSES) {
            const candidate = join(workspaceRoot, SKILL_HARNESS_DIR[harness], 'skills', skill.id, 'SKILL.md')
            if (await isFile(candidate)) {
              source = candidate
              break
            }
          }
        }
        // Studio's own copy of a skill it ships is the one read, whatever a
        // project folder of the same name holds.
        const shipped = await shippedSkillEntry(skill.id)
        if (shipped) source = shipped
        if (!source || !(await isFile(source))) throw new Error(`Skill ${skill.id} is not available in this workspace.`)
        if (!shipped) {
          // The SKILL.md must be the project's own file, in a folder really
          // inside the project: a link would put another file's text here.
          if (!(await isOwnSkillEntry(source)) || !(await skillDirStaysInRoot(workspaceRoot, dirname(source))))
            throw new Error(`Skill ${skill.id} is reached through a link, so its instructions were not attached.`)
          source = await realpath(source)
          if (!installedPaths.includes(source))
            throw new Error(`Skill ${skill.id} source is not an installed workspace skill.`)
        }
        const size = (await stat(source)).size
        if (size > 24 * 1024) throw new Error(`Skill ${skill.id} exceeds the 24 KB instructions limit.`)
        // Only the frontmatter keys a project command keeps travel with it.
        const body = skillWithoutPermissionKeys(await readFile(source, 'utf8'))
        totalBytes += Buffer.byteLength(body)
        if (totalBytes > 64 * 1024) throw new Error(`Skill ${skill.id} exceeds the 64 KB total instructions budget.`)
        sections.push(`Attached skill: ${skill.id}\nSource directory: ${dirname(source)}\n${body}`)
      }
      ids.push(skill.id)
    }
    return { ids, ...(sections.length ? { context: sections.join('\n\n') } : {}) }
  }
}

/** The `SKILL.md` Studio ships for `id`, when it ships one. */
async function shippedSkillEntry(id: string): Promise<string | null> {
  if (!findBuiltinSkill(id)) return null
  let entry: string
  try {
    entry = join(builtinSkillSourceRoot(), id, 'SKILL.md')
  } catch {
    return null
  }
  return (await isOwnSkillEntry(entry)) ? entry : null
}

async function isFile(path: string): Promise<boolean> {
  try {
    return (await stat(path)).isFile()
  } catch {
    return false
  }
}
