import type { AgentSkillTarget, BuiltinSkillTargetState, WorkspaceSkill } from '../../../shared/electron-api'
import type { PluginSkillInvocation, PluginSkillSupport } from '../../../shared/plugin-manifest'
import {
  plainSkillInvocation,
  renderSkillInvocationTemplate,
  resolveSkillInvocation,
} from '../../../shared/skill-invocation'

// Re-exported from the node-free shared module (its home now that the automation
// backlog.work handoff composes invocations in main); existing renderer callers
// keep importing it from here.
export { renderSkillInvocationTemplate }

// The `{ support, harnessId, invocation }` shape common to PluginSkillCatalog
// (renderer plugin list) and PluginSkillIntegration (main manifest).
export type SkillIntegrationLike = {
  support: PluginSkillSupport
  harnessId: string
  invocation?: PluginSkillInvocation
}

// The explicit invocation text to hand an agent for a skill: the CLI's native
// form (`/backlog` for claude, `Use $backlog.` for codex) when the plugin
// declares native support AND the skill is actually present in that CLI's
// harness dir, otherwise a plain prompt mention every agent can follow.
export function renderSkillInvocation(input: {
  skill: Pick<WorkspaceSkill, 'id' | 'name'>
  integration?: SkillIntegrationLike
  // Whether the skill is installed where the plugin's harness reads native
  // skills (e.g. .claude/skills). Callers with a WorkspaceSkill derive it via
  // skillInstalledForHarness; default true for callers that ensure-installed.
  nativeInstalled?: boolean
}): string {
  const { skill, integration } = input
  if (input.nativeInstalled ?? true) {
    const native = resolveSkillInvocation(integration, skill.id)
    if (native) return native
  }
  return plainSkillInvocation(skill.id)
}

// Conversation-agent draft prefill (approved mockup copy): a plain sentence
// opener that leaves the caret ready for arguments. Conversation transports
// have no CLI slash contract, so the sentence form is the invocation there.
export function renderChatSkillPrefill(skill: Pick<WorkspaceSkill, 'id'>): string {
  return `Use the ${skill.id} skill to `
}

// What the chat composer's `$` type-ahead inserts mid-prompt.
// A noun phrase, not the prefill sentence:
// the person is already writing a sentence, and this has to read inside it
// ("run the backlog skill on…", "with the review skill"). Conversation transports
// have no native mention syntax, so a bare `$backlog` would be a character the
// model has no contract for; the phrase is what every agent can follow.
export function renderChatSkillMention(skill: Pick<WorkspaceSkill, 'id'>): string {
  return `the ${skill.id} skill`
}

// Whether a workspace skill is present in the harness dir a plugin's native
// skill integration reads from.
export function skillInstalledForHarness(
  skill: Pick<WorkspaceSkill, 'harnesses' | 'installState'>,
  integration: SkillIntegrationLike | undefined,
): boolean {
  if (!integration) return false
  return skill.installState !== 'available' && skill.harnesses.some((harness) => harness === integration.harnessId)
}

// Agent-spawn patch for a "+ Skill" attachment on a terminal-CLI agent:
// builtins ride spawnSkillId (ensure-installed at the launch boundary); the
// invocation is parked at the CLI prompt unsubmitted via cliPendingInput.
function skillSpawnAgentPatch(
  skill: WorkspaceSkill,
  integration: SkillIntegrationLike | undefined,
): { spawnSkillId?: string; cliPendingInput: string } {
  const invocation = renderSkillInvocation({
    skill,
    integration,
    nativeInstalled: skillInstalledForHarness(skill, integration),
  })
  return {
    ...(skill.source === 'builtin' ? { spawnSkillId: skill.id } : {}),
    cliPendingInput: `${invocation} `,
  }
}

// The same for the Skills & MCPs picks (browser-pane epic, child 7), in pick
// order. A CLI whose native form is a slash command (`/backlog`) cannot take
// two on one line, so with several skills each becomes the plain mention; a
// CLI whose native form is a sentence (`Use $backlog.`) keeps it for each.
// The picker installed every pick already; the first builtin still rides
// spawnSkillId for the launch boundary's own ensure-install.
export function skillsSpawnAgentPatch(
  skills: readonly WorkspaceSkill[],
  integration: SkillIntegrationLike | undefined,
): { spawnSkillId?: string; cliPendingInput?: string } {
  if (skills.length === 0) return {}
  if (skills.length === 1) return skillSpawnAgentPatch(skills[0], integration)
  const firstBuiltin = skills.find((skill) => skill.source === 'builtin')
  const slashForm = integration?.invocation?.nativeSlashCommand === true
  const invocations = skills.map((skill) =>
    slashForm
      ? plainSkillInvocation(skill.id)
      : renderSkillInvocation({ skill, integration, nativeInstalled: skillInstalledForHarness(skill, integration) }),
  )
  return {
    ...(firstBuiltin ? { spawnSkillId: firstBuiltin.id } : {}),
    cliPendingInput: `${invocations.join(' ')} `,
  }
}

// Whether any of a builtin skill's install targets is a usable native copy for
// the given plugin/harness (moved verbatim from the terminal drop path).
export function hasInstalledNativeSkillTarget(
  harnessId: string,
  pluginId: string,
  targets: readonly BuiltinSkillTargetState[],
): boolean {
  return targets.some(
    (target) =>
      (target.status === 'installed' ||
        target.status === 'update-available' ||
        target.status === 'modified' ||
        target.status === 'local') &&
      target.support !== 'unsupported' &&
      (target.pluginId === pluginId || target.harness === harnessId),
  )
}

// Makes a skill exist where the target agent can read it before an invocation
// lands. The one install path the renderer has: main attaches it to every
// installed, skill-capable harness (src/main/agent-skill-installer.ts), which
// is also what the Skills pane's Add does — a skill the user can invoke in one
// CLI should not be missing from the next one they open.
//
// Partial success is success here: the caller is about to invoke the skill, and
// one harness that refused the write does not make the others unusable. Only a
// request that reached nothing is a failure worth stopping for.
//
// The per-target report rides back on success (`targets`): it is the only place
// that knows which harness directories now hold the skill and which of their
// CLIs re-read a skills directory only on restart. `utils/useSkillInAgent.ts`
// turns it into the invocation's native/plain decision and the restart notice.
export async function ensureSkillForAgent(input: {
  /** Null attaches it for every project, in the home folder's harness directories. */
  workspaceRoot: string | null
  skill: Pick<WorkspaceSkill, 'id'>
}): Promise<{ ok: true; targets: AgentSkillTarget[] } | { ok: false; message: string }> {
  const { workspaceRoot, skill } = input
  try {
    const result = await window.api.agentSkillAttach({ workspaceRoot, skillId: skill.id })
    if (!result.ok) return { ok: false, message: result.message }
    const usable = result.targets.filter((target) => target.status !== 'failed')
    if (usable.length > 0) return { ok: true, targets: result.targets }
    return {
      ok: false,
      message: result.targets[0]?.message ?? 'Unable to install the skill.',
    }
  } catch (error) {
    return {
      ok: false,
      message: error instanceof Error ? error.message : 'Unable to install the skill.',
    }
  }
}
