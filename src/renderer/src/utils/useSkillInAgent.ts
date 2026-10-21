// One round trip: "use this skill in a running agent".
//
// Before this module the complete flow — find the live agents, make the skill
// exist where they read skills, render the CLI's own invocation, and park it at
// that agent's prompt — lived twice: once inside the Installed inventory's
// `UseSkillMenu` and once inside `AgentPanel` for its own pane. It was
// reachable from one row in one door, a navigation away from where a person had
// just installed the skill. It is a flow, not a widget, so it lives here:
// DOM-free, window.api-only, and callable from any surface that can name a
// skill (the doors, the terminal's star, the command palette).
//
// Nothing here submits anything. The invocation is bracket-pasted with a
// trailing space and left at the prompt, like every other door in the app: the
// person reads what would run and presses Enter themselves.

import type { AgentSkillTarget, TerminalSessionSnapshot, WorkspaceSkill } from '../../../shared/electron-api'
import type { ShowToastInput } from '../store/toastStore'
import {
  ensureSkillForAgent,
  hasInstalledNativeSkillTarget,
  renderSkillInvocation,
  skillInstalledForHarness,
  type SkillIntegrationLike,
} from './skillInvocation'
import { bracketedPaste } from './terminalDrop'

/**
 * The little a CLI entry has to tell this flow: who it is, what to call it, and
 * the skill templates its invocation is rendered from. Both plugin list shapes
 * (`PluginRegistryListEntry` from the registry, `PluginCatalogEntry` from the
 * renderer's catalog) satisfy it, which is why neither is named here.
 */
export type SkillCliEntry = {
  id: string
  displayName?: string
  skillIntegration?: SkillIntegrationLike
}

/** No workspace folder, so nothing to install into and no harness dirs to write. */
export const NO_WORKSPACE_FOLDER_MESSAGE = 'Open a folder in this workspace before using a skill in an agent.'

/** The skill row resolved to nothing in the workspace inventory. */
export const SKILL_NOT_IN_WORKSPACE_MESSAGE = 'This skill is missing from the workspace inventory.'

/** No live agent to paste into. */
export const NO_LIVE_AGENT_MESSAGE = 'No running agents'

/** The chosen agent exited, or was paused, between the menu and the paste. */
export const AGENT_NO_LONGER_RUNNING_MESSAGE = 'That agent is no longer running. Pick another.'

// ── Which agents can take a skill ────────────────────────────────────────────

/**
 * A live PTY agent an invocation can be pasted into.
 *
 * `snapshot` rides along because callers that render rows want the same session
 * facts the terminal list carries (activity, worktree, agent record) without a
 * second `terminalList()`; `label` and `cli` are the two every caller needs.
 */
export type LiveAgentSession = {
  sessionId: string
  workspaceId?: string
  agentId?: string
  /** The agent CLI's plugin id (`claude-code`, `codex`…), when known. */
  cli?: string
  /** What to call it in a menu: the agent's display name, else its id. */
  label: string
  snapshot: TerminalSessionSnapshot
}

/**
 * Whether a terminal session is one this flow may write into.
 *
 * Worktree agents are excluded on purpose and everywhere: the ensure-install
 * writes the MAIN checkout's harness dirs, which a CLI running inside a
 * worktree does not read, so a paste there would name a skill that agent cannot
 * find (the same rule the backlog file-drop path keeps).
 *
 * Conversation runtimes never appear here at all — they have no pty, so
 * `terminalList()` does not carry them, and they have no slash contract to
 * render into (see `renderChatSkillPrefill` in skillInvocation.ts).
 */
export function isUsableAgentSession(
  session: TerminalSessionSnapshot,
  scope?: { workspaceId?: string | null },
): boolean {
  if (session.kind !== 'agent') return false
  if (!session.processAlive) return false
  if (session.executionMode === 'worktree' || session.worktreePath) return false
  if (scope?.workspaceId && session.workspaceId !== scope.workspaceId) return false
  return true
}

export function toLiveAgentSession(session: TerminalSessionSnapshot): LiveAgentSession {
  return {
    sessionId: session.sessionId,
    workspaceId: session.workspaceId,
    agentId: session.agentId,
    cli: session.cli,
    label: session.agentSession?.displayName ?? session.agentName ?? session.agentId ?? session.sessionId,
    snapshot: session,
  }
}

/** The pure half of `listLiveAgentSessions`, for callers that already hold a list. */
export function selectLiveAgentSessions(
  sessions: readonly TerminalSessionSnapshot[],
  scope?: { workspaceId?: string | null },
): LiveAgentSession[] {
  return sessions.filter((session) => isUsableAgentSession(session, scope)).map(toLiveAgentSession)
}

/**
 * Every live agent a skill can be handed to, newest-spoken-to first is NOT
 * imposed here: the list keeps `terminalList()`'s own order so a menu reads the
 * same as every other session list in the app.
 *
 * Scope is by `workspaceId` — the only workspace identity a session snapshot
 * carries. A workspace ROOT is not a filter: `cwd` is launch intent, and an
 * agent that moves into another checkout is still that workspace's agent. Pass
 * no scope to list every window's agents, which is what the Installed
 * inventory's menu has always shown.
 */
export async function listLiveAgentSessions(scope?: { workspaceId?: string | null }): Promise<LiveAgentSession[]> {
  try {
    const all = await window.api.terminalList()
    return selectLiveAgentSessions(all, scope)
  } catch {
    return []
  }
}

/**
 * The one agent to use without asking, or null when the person has to choose.
 *
 * A caller that knows which pane is in front of the user (AgentPanel knows its
 * own `sessionId`; the workspace store knows the focused agent per workspace —
 * `focusedAgentByWorkspaceId`) passes it as a preference and always gets it
 * back when it is still live. Otherwise one live agent is unambiguous and is
 * used; two or more is a question, and a question is a menu.
 */
export function pickTargetSession(
  sessions: readonly LiveAgentSession[],
  preferred?: { sessionId?: string | null; agentId?: string | null } | null,
): LiveAgentSession | null {
  if (preferred?.sessionId) {
    const bySession = sessions.find((session) => session.sessionId === preferred.sessionId)
    if (bySession) return bySession
  }
  if (preferred?.agentId) {
    const byAgent = sessions.find((session) => session.agentId === preferred.agentId)
    if (byAgent) return byAgent
  }
  return sessions.length === 1 ? sessions[0] : null
}

// ── Using it ─────────────────────────────────────────────────────────────────

/** One harness directory the ensure-install actually wrote the skill into. */
export type SkillHarnessWrite = {
  harnessId: string
  /** Every installed CLI that reads that directory — `.claude` serves three. */
  pluginIds: string[]
  /** Whether those CLIs pick a new skill up only after a restart. */
  restartRequired: boolean
  /** Display names for the CLIs, for a sentence a person reads. */
  labels: string[]
}

export type UseSkillInAgentResult =
  | {
      ok: true
      /** Exactly the text pasted, without the trailing space the write adds. */
      invocation: string
      sessionId: string
      /** True when at least one CLI that just RECEIVED a copy needs a restart. */
      restartRequired: boolean
      harnesses: SkillHarnessWrite[]
    }
  | { ok: false; message: string }

export type UseSkillInAgentInput = {
  /** The main checkout the harness dirs are written into. */
  workspaceRoot: string | null | undefined
  skill: Pick<WorkspaceSkill, 'id' | 'name' | 'source' | 'harnesses' | 'installState'>
  session: Pick<LiveAgentSession, 'sessionId' | 'cli'>
  /**
   * The CLI plugin registry entries whose `skillIntegration` renders the
   * per-CLI invocation. Callers that already resolved the integration for this
   * session's CLI may pass it directly instead.
   */
  clis?: readonly SkillCliEntry[]
  integration?: SkillIntegrationLike
}

/**
 * Install where the agent reads, render what that CLI understands, paste it at
 * the prompt. The whole round trip, in one call.
 *
 * Partial install success is success (see `ensureSkillForAgent`): the person is
 * about to invoke the skill, and one harness that refused the write does not
 * make the CLI in front of them unusable.
 */
export async function useSkillInAgent(input: UseSkillInAgentInput): Promise<UseSkillInAgentResult> {
  const { workspaceRoot, skill, session } = input
  if (!workspaceRoot) return { ok: false, message: NO_WORKSPACE_FOLDER_MESSAGE }

  const ensured = await ensureSkillForAgent({ workspaceRoot, skill })
  if (!ensured.ok) return { ok: false, message: ensured.message }

  const integration =
    input.integration ??
    (session.cli ? (input.clis ?? []).find((plugin) => plugin.id === session.cli)?.skillIntegration : undefined)

  // `skill.harnesses` is what the inventory knew BEFORE the attach above, so a
  // skill that has only just landed in this CLI's directory would render as the
  // plain mention. For a built-in we can ask what is on disk now; for the rest
  // the attach's own report answers it.
  let nativeInstalled = skillInstalledForHarness(skill, integration)
  if (!nativeInstalled && integration) {
    nativeInstalled = ensured.targets.some(
      (target) => target.harnessId === integration.harnessId && target.status !== 'failed',
    )
  }
  if (!nativeInstalled && integration && skill.source === 'builtin') {
    const status = await window.api.builtinSkillStatus({ workspaceRoot, skillId: skill.id })
    if (status.ok) {
      nativeInstalled = hasInstalledNativeSkillTarget(integration.harnessId, session.cli ?? '', status.targets)
    }
  }

  const invocation = renderSkillInvocation({ skill, integration, nativeInstalled })

  // The paste is a plain `terminalWrite`, and main's handler for it drops input
  // to a session that has exited instead of saying so (`writeTerminalInput`,
  // src/main/terminal-runtime.ts). The attach above took a moment; an agent
  // that died in it would otherwise be reported as used, with the menu closed
  // over a paste that reached nothing. So the session is asked about again,
  // by the same rule that listed it, right before the write.
  if (!(await sessionStillUsable(session.sessionId))) {
    return { ok: false, message: AGENT_NO_LONGER_RUNNING_MESSAGE }
  }
  try {
    await window.api.terminalWrite(session.sessionId, bracketedPaste(`${invocation} `))
  } catch (error) {
    return {
      ok: false,
      message: error instanceof Error ? error.message : 'The agent terminal did not take the invocation.',
    }
  }

  const harnesses = describeHarnessWrites(ensured.targets, input.clis)
  return {
    ok: true,
    invocation,
    sessionId: session.sessionId,
    restartRequired: harnesses.some((harness) => harness.restartRequired),
    harnesses,
  }
}

/**
 * Whether the session is still one this flow may write into. A list that
 * cannot be read is not evidence the agent is gone, so the write goes ahead on
 * that failure alone — which is all any caller could do before.
 */
async function sessionStillUsable(sessionId: string): Promise<boolean> {
  let sessions: readonly TerminalSessionSnapshot[]
  try {
    sessions = await window.api.terminalList()
  } catch {
    return true
  }
  const current = sessions.find((candidate) => candidate.sessionId === sessionId)
  return current ? isUsableAgentSession(current) : false
}

/**
 * What the attach wrote, per harness directory, in CLI names a person reads.
 *
 * Only `written` targets count: `unchanged` means that CLI already had the
 * skill, so there is nothing new for it to notice and no restart to mention.
 */
export function describeHarnessWrites(
  targets: readonly AgentSkillTarget[],
  clis?: readonly SkillCliEntry[],
): SkillHarnessWrite[] {
  return targets
    .filter((target) => target.status === 'written')
    .map((target) => ({
      harnessId: target.harnessId,
      pluginIds: target.pluginIds,
      restartRequired: target.restartRequired,
      labels: target.pluginIds.map(
        (pluginId) => (clis ?? []).find((plugin) => plugin.id === pluginId)?.displayName ?? pluginId,
      ),
    }))
}

/**
 * The one thing the round trip cannot verify for the person: `restartRequired`
 * is measured false for Claude Code and Codex (both pick a new skill directory
 * up live) and declared true-but-unmeasured for grok and opencode. Saying so is
 * the difference between a skill that "did nothing" and one the CLI has not
 * re-read yet.
 *
 * Returns null when there is nothing to say — which is the common case.
 */
export function skillRestartToast(result: UseSkillInAgentResult, skillName: string): ShowToastInput | null {
  if (!result.ok || !result.restartRequired) return null
  const names = Array.from(
    new Set(result.harnesses.filter((harness) => harness.restartRequired).flatMap((harness) => harness.labels)),
  )
  if (names.length === 0) return null
  return {
    tone: 'warn',
    title: `Installed for ${formatList(names)}`,
    description: `${skillName} is in place. ${names.length === 1 ? 'That CLI' : 'Those CLIs'} may need a restart to see new skills.`,
  }
}

function formatList(names: readonly string[]): string {
  if (names.length <= 1) return names[0] ?? ''
  if (names.length === 2) return `${names[0]} and ${names[1]}`
  return `${names.slice(0, -1).join(', ')} and ${names[names.length - 1]}`
}

// ── Resolving the skill a surface names ──────────────────────────────────────

/**
 * The workspace inventory record behind a skill id, read at click time.
 *
 * Every surface that offers "use in agent" holds a projection — a catalogue
 * row, a scanned plugin component, an inventory row — and the invocation
 * machinery needs the record itself (source, harnesses, install state). Reading
 * it here rather than at render time is what lets a skill installed since the
 * list loaded still resolve.
 */
export async function resolveWorkspaceSkill(input: {
  workspaceRoot: string | null | undefined
  skillId: string
}): Promise<{ ok: true; skill: WorkspaceSkill } | { ok: false; message: string }> {
  if (!input.workspaceRoot) return { ok: false, message: NO_WORKSPACE_FOLDER_MESSAGE }
  try {
    // A skill installed for every project is as usable here as the folder's
    // own — installs land there by default.
    const result = await window.api.workspaceSkillsList({ workspaceRoot: input.workspaceRoot, includeGlobal: true })
    if (!result.ok) return { ok: false, message: result.message }
    const skill = result.skills.find((candidate) => candidate.id === input.skillId)
    if (!skill) return { ok: false, message: SKILL_NOT_IN_WORKSPACE_MESSAGE }
    return { ok: true, skill }
  } catch (error) {
    return {
      ok: false,
      message: error instanceof Error ? error.message : SKILL_NOT_IN_WORKSPACE_MESSAGE,
    }
  }
}
