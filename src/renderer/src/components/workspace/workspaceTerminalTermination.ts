import { paneTerminalSessionId } from './pane/paneTerminals'
import type { Workspace } from '../../types/workspace'
import { useWorkspaceStore } from '../../store/workspaceStore'
import { workspaceIsWorking } from './sidebar/conversationLines'

type LayoutSessionNode = {
  component?: string
  config?: {
    agentId?: string
    terminalId?: string
  }
  children?: LayoutSessionNode[]
}

/**
 * Every terminal session this workspace holds — the agents' CLI sessions, the
 * layout's agent and terminal tabs, and the pane's own terminal tabs, which own
 * ptys the layout knows nothing about.
 *
 * One collector, so the paths that stop a workspace running cannot drift about
 * what "this workspace's terminals" means.
 *
 * The store's copy wins over the one passed in. Callers hand over the row they
 * rendered, and the sidebar renders from a projection that does not move for a
 * layout or agent change alone, so the passed copy can miss a tab opened since.
 * A tab missed here is a pty left running. The passed copy stands in once the
 * workspace has left the store (its folder forgotten before its kills settle).
 */
export function workspaceTerminalSessionIds(passed: Workspace): string[] {
  const workspace = useWorkspaceStore.getState().workspaces.find((candidate) => candidate.id === passed.id) ?? passed
  const sessionIds = new Set<string>()

  Object.values(workspace.agents ?? {}).forEach((agent) => {
    if (agent.cliSessionId) sessionIds.add(agent.cliSessionId)
  })

  const collectLayoutSessions = (node: LayoutSessionNode | undefined) => {
    if (!node) return

    if (node.component === 'agent') {
      const agentId = node.config?.agentId
      const sessionId = agentId ? workspace.agents[agentId]?.cliSessionId : undefined
      if (sessionId) sessionIds.add(sessionId)
    }

    if (node.component === 'terminal') {
      const terminalId = node.config?.terminalId
      if (terminalId) sessionIds.add(`terminal-${terminalId}`)
    }

    node.children?.forEach(collectLayoutSessions)
  }

  // Optional-chained through the layout, not because the type says it can be
  // missing but because Settle now runs this over whatever the sweep decided
  // — a record that predates a field, or one a failed write left half-formed,
  // must not throw inside a sweep and strand the rest of the batch.
  collectLayoutSessions(workspace.layoutModel?.layout as LayoutSessionNode | undefined)
  workspace.layoutModel?.borders?.forEach((border) => collectLayoutSessions(border as LayoutSessionNode))
  // The pane's terminal tabs own ptys the layout knows nothing about.
  for (const tab of workspace.paneState?.tabs ?? []) {
    if (tab.kind === 'terminal' && tab.terminalId) sessionIds.add(paneTerminalSessionId(tab.terminalId))
  }

  return [...sessionIds]
}

/**
 * Kill every terminal session the workspace holds. The returned promise settles
 * once main has acknowledged each kill — the pty has been signalled and the
 * session dropped from the registry — which is as close to "this workspace's
 * writers are done" as the renderer can get. Kill failures are absorbed: a
 * session that died first must not hold up the caller.
 *
 * Two callers, and they are the whole list of ways a workspace stops running
 * for good: Forget folder (its chats leave the record with it), and Settle
 * (2026-09-07) — a chat that has come to rest holds no ptys, whether a person
 * settled it by hand or the sweep did after three idle days. Settle is also
 * the one way a person puts a single chat away: Close, which removed the chat
 * and killed unconditionally, is gone (2026-10-21).
 *
 * It lives here rather than in WorkspaceManager, where it grew up, because
 * settling is driven from the sidebar.
 */
export async function terminateWorkspaceTerminals(workspace: Workspace): Promise<void> {
  await Promise.all([
    ...workspaceTerminalSessionIds(workspace).map((sessionId) => window.api.terminalKill(sessionId).catch(() => {})),
    suspendWorkspaceConversations(workspace),
  ])
}

/**
 * Settle's half of the kill: the same as `terminateWorkspaceTerminals`, unless
 * something in the workspace is working by the time main is asked. Resolves to
 * whether the kill went ahead.
 *
 * Settle refuses a working chat, but it decides on the sessions the window last
 * heard about, and the kill lands a round trip later: a turn started in that
 * gap — a message from the phone, a scheduled prompt — would be interrupted by
 * a gesture made before it existed. So main's own list is read once more first,
 * and a chat working by then is left running. Its record still says settled;
 * the rest sweep wakes a settled chat whose agent is working on its next pass,
 * which here is the moment that activity reaches the window.
 *
 * Only an agent's work spares the chat (`workspaceIsWorking`): a plain shell
 * printing is not work Settle would be cutting short, and it ends with the
 * rest, so a chat holding only a terminal is put away like any other.
 *
 * Forget folder keeps the unconditional kill: a chat leaving the record must
 * not leave a writer behind.
 */
export async function terminateSettledWorkspaceTerminals(
  workspace: Workspace,
  // Asked again once main has answered: a chat un-settled during that round
  // trip is the person's again, and is not killed.
  stillSettled: () => boolean = () => true,
): Promise<boolean> {
  if (await workspaceWorkingNow(workspace)) return false
  if (!stillSettled()) return false
  await terminateWorkspaceTerminals(workspace)
  return true
}

async function workspaceWorkingNow(workspace: Workspace): Promise<boolean> {
  try {
    const sessionIds = new Set(workspaceTerminalSessionIds(workspace))
    const [terminals, conversations] = await Promise.all([
      window.api.terminalList(),
      window.api.conversationSessionsList(),
    ])
    return workspaceIsWorking(
      'idle',
      conversations.ok ? conversations.sessions.filter((session) => session.workspaceId === workspace.id) : [],
      terminals.filter((session) => sessionIds.has(session.sessionId) || session.workspaceId === workspace.id),
    )
  } catch {
    // Main unreachable: nothing would answer the kill either, and the gesture
    // goes on as it did.
    return false
  }
}

/**
 * End the child process of every chat agent the workspace holds. A chat agent
 * has no pty, so neither `terminalKill` nor `terminalSuspend` reaches it: main
 * owns the process, and its sessions are asked for rather than collected from
 * the record. A session belongs here when it was started under the workspace's
 * id, and only then. An agent id is unique within a workspace, not across them
 * — nearly every chat's first agent is `agent-1` — so matching on it settled
 * one chat and suspended every other chat's agent with it, ending the
 * background agents they were running.
 *
 * Suspended, not stopped, for Settle and Forget folder alike: a stopped session refuses
 * every later turn, and a settled chat can be un-settled and typed into. The
 * session keeps its resume cursor, so the next message respawns the agent on
 * the same conversation. A running turn is interrupted: the person put the
 * chat away. Failures are absorbed like the pty kills'.
 */
async function suspendWorkspaceConversations(workspace: Workspace): Promise<void> {
  try {
    const listed = await window.api.conversationSessionsList()
    if (!listed.ok) return
    await Promise.all(
      listed.sessions
        .filter((session) => session.status !== 'stopped' && session.workspaceId === workspace.id)
        .map((session) => window.api.conversationSessionSuspend({ sessionId: session.sessionId }).catch(() => {})),
    )
  } catch {
    // Main unreachable: nothing to suspend through, and the gesture goes on.
  }
}

/**
 * PAUSE every terminal session the workspace holds, rather than killing them.
 * Snooze's half of the pair (owner ruling, 2026-09-10).
 *
 * A snoozed chat must sit exactly as the app's other non-live chats do: no
 * agent process running, the row just there. Snooze first shipped as
 * visibility-only — the row left the list and every pty stayed up — which made
 * a chat you had told to go away the most expensive kind of row in the tree,
 * holding a CLI process for the whole snooze. Visibility-only is the right rule
 * for a snooze whose session lives on a SERVER, where hiding costs nothing;
 * ours holds a live local process, so hiding the row is not putting it away.
 *
 * Suspend rather than kill because a snoozed chat is coming back on a clock.
 * `terminalSuspend` ends the agent PROCESS but keeps the painted, resumable
 * session, and the first keystroke relaunches it under the same session id with
 * `--resume` (TerminalView's `resumeFromSuspend`). Nothing here and nothing on
 * the wake path resumes anything: waking returns the row to the sidebar with
 * its terminals still paused, and the person's own keystroke is what starts an
 * agent again.
 *
 * Failures are absorbed for the reason the kill path absorbs them: a session
 * that is already gone must not hold up a gesture whose whole job is to get a
 * row out of the way.
 */
export async function suspendWorkspaceTerminals(workspace: Workspace): Promise<void> {
  await Promise.all([
    ...workspaceTerminalSessionIds(workspace).map((sessionId) => window.api.terminalSuspend(sessionId).catch(() => {})),
    suspendWorkspaceConversations(workspace),
  ])
}

/**
 * What Snooze's suspend came to: the chat's processes paused, an agent found
 * working when main was asked (left running), or the chat woken while main
 * was being asked (left alone).
 */
export type SnoozeSuspendOutcome = 'suspended' | 'working' | 'woken'

/**
 * Snooze's suspend, guarded the way Settle's kill is
 * (`terminateSettledWorkspaceTerminals`). The gesture checks for a working
 * agent against the sidebar's last render, and suspending interrupts a
 * running turn, so an agent that started since — a scheduled message landing,
 * a reply from a paired phone — was cut off mid-turn by a Snooze that would
 * have been refused a moment later. Main's own list is read first, and a chat
 * working by then keeps its agents; so does one woken during that round trip.
 */
export async function suspendSnoozedWorkspaceTerminals(
  workspace: Workspace,
  stillSnoozed: () => boolean = () => true,
): Promise<SnoozeSuspendOutcome> {
  if (await workspaceWorkingNow(workspace)) return 'working'
  if (!stillSnoozed()) return 'woken'
  await suspendWorkspaceTerminals(workspace)
  return 'suspended'
}
