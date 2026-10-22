/**
 * The agent-launch contract main owns.
 *
 * Launching an agent used to be split in two: a React hook decided the CLI,
 * permission preset, connector environment and name, wrote
 * an `AgentState`, and left the actual spawn to whichever `TerminalView` mounted
 * afterwards. Every one of those decisions is data, none of it is presentation —
 * but because it lived in the renderer, `agent.launch` and `backlog.work` both
 * failed outright when no window was open.
 *
 * The decision layer now lives in `src/main/agent-launch-service.ts`. This
 * module is the vocabulary both sides speak:
 *
 * - {@link AgentLaunchRequest} — what a caller asks for. Identical in shape to
 *   the old `agent.launch` renderer request, so the gateway and the plan
 *   orchestrators migrate without changing what they send.
 * - {@link AgentLaunchRecord} — what main DECIDED, carried back on the terminal
 *   session snapshot. The renderer projects it into an `AgentState` so the tab
 *   is a view of main's session list rather than the thing that created it.
 *   Its lifetime is the session's: when the pty is gone, so is the record, and
 *   a window opened an hour later projects exactly the sessions still running.
 */
import type { AgentCli, McpSettings, CliPermissionPreset } from './electron-api'
import type { ExecutionHostId } from './execution-host'

export type AgentLaunchRequest = {
  workspaceId: string
  /** Agent CLI plugin id. Absent takes the user's last-selected CLI. */
  cli?: string
  /** Display name. Absent picks an unused name from the shared pool. */
  name?: string
  /** Startup prompt delivered to the CLI at launch. */
  prompt?: string
  /** Model id for CLIs declaring modelSelection; forwarded verbatim. */
  cliModel?: string
  /** Absent takes the app-level agent-spawn default. */
  permissionPreset?: CliPermissionPreset
  /**
   * The CLI's own mode at `permissionPreset`, read only beside it. A mode this
   * CLI does not have at that preset launches the preset's own.
   */
  permissionMode?: string
  /** Git worktree to run in, instead of the workspace checkout. */
  worktreePath?: string
  /** Connector id from the installed connectors; resolves to an isolated single-server MCP. */
  connectorId?: string
  /** Built-in skill installed into the working directory before the CLI starts. */
  spawnSkillId?: string
  /**
   * The agent's id, when the CALLER owns it. A module agent session is keyed by
   * something the module already has (a review id, a document id) so a second
   * start finds the live terminal instead of spawning a twin; the minted
   * `agent-<cli>-<suffix>` form has nothing anyone could match on. Absent mints.
   */
  agentId?: string
  /**
   * Absolute working directory, instead of the workspace folder or worktree.
   * The workspace still names the agent's residency (its tab, its exit report);
   * this only says where the pty starts.
   */
  cwd?: string
  /**
   * Accept a workspace of any mode as the launch host. The default refuses
   * anything but a standard workspace, because an `agent.launch` caller
   * that named a hidden workspace has almost certainly named the wrong one. A
   * module agent session names its host explicitly — the workspace its surface
   * was opened from — so it opts out of that guard rather than being told the
   * workspace the user is standing in is the wrong kind.
   */
  anyWorkspaceMode?: boolean
  /**
   * The machine to run on. Absent takes the workspace's machine, then the
   * distribution its folder lives in, then this machine. Only Windows offers
   * a choice (`wsl:<distro>`); anywhere else every launch runs locally.
   */
  host?: ExecutionHostId
  /**
   * The CLI's own session id to resume instead of starting a new
   * conversation: the launch runs the CLI's resume command
   * (`claude --resume <id>`, `codex resume <id>`). A resume carries no
   * startup prompt. Refused for a CLI whose manifest declares no resume.
   */
  resumeCliSessionId?: string
  /**
   * The agent of this app whose tool call asked for the launch, and its chat.
   * Recorded on the session so the terminal tools show an agent the terminals
   * it or its chat started, and no others. Absent for a launch the person made.
   */
  launchedBy?: AgentLaunchCaller
}

/** An agent of this app that asked for a launch: its chat (workspace) and, when it declared one, its own id. */
export type AgentLaunchCaller = { workspaceId: string; agentId?: string }

export type AgentDisposeRequest = {
  workspaceId: string
  agentId: string
}

/**
 * The launch-time decisions main made, in `AgentState` vocabulary.
 *
 * Everything here is something the renderer could not re-derive from the raw
 * session snapshot: the snapshot knows the cli and cwd, but not which permission
 * preset was rendered into the launch argv, or which connector config was
 * written into the worktree. A projection missing those fields would look right
 * and behave wrong on the first relaunch.
 */
export type AgentLaunchRecord = {
  agentId: string
  name: string
  cli: AgentCli
  cliModel?: string
  cliPermissionPreset: CliPermissionPreset
  /** The CLI's own mode at that preset, when one other than the preset's own was chosen. */
  cliPermissionMode?: string
  connectorMcpSettings?: McpSettings
  spawnSkillId?: string
  /**
   * The worktree the agent runs in, when the launch created or was handed one.
   * Projected onto `AgentState.execution` so a reopened tab resolves the same
   * cwd instead of falling back to the workspace root.
   */
  worktreePath?: string
  /** The machine main launched on, so the agent resumes on the same one. */
  hostId?: ExecutionHostId
  /** The agent that asked for this launch through a tool, as the request named it. */
  launchedBy?: AgentLaunchCaller
}

export type AgentLaunchResult =
  | {
      ok: true
      workspaceId: string
      agentId: string
      sessionId: string
      /**
       * The CLI main resolved for this launch — the caller's, or the user's
       * last-selected one when the caller named none. A caller that has to
       * report which agent it started (or lead a prompt with that CLI's own
       * skill invocation) cannot re-derive this from the request.
       */
      cli: string
      /**
       * The session's EXECUTION identity: the id its exit will be reported
       * under. Equal to the terminal session id today; carried explicitly so a
       * caller correlating exits never has to depend on that staying true.
       */
      executionId: string
    }
  | { ok: false; code: string; message: string }

export type AgentDisposeResult =
  { ok: true; workspaceId: string; agentId: string } | { ok: false; code: string; message: string }

/**
 * Whether a launch prompt would be read as an option rather than a message.
 *
 * A terminal agent's first message becomes the last token on its CLI's
 * command line (`{{prompt}}` in its plugin manifest). The shell
 * is safe, since every value is quoted, but the CLI's own option parser is not:
 * a message that begins with `-` is parsed as a flag. Every launch door refuses
 * one, the same line the card executor draws (`run-card.ts`), and the render
 * refuses one that would land on a command line with no `--` before it.
 */
export function launchPromptReadsAsOption(prompt: string | null | undefined): boolean {
  return typeof prompt === 'string' && prompt.trim().startsWith('-')
}

/** What a launch door answers when {@link launchPromptReadsAsOption} refuses its prompt. */
export const LAUNCH_PROMPT_READS_AS_OPTION_MESSAGE =
  'The prompt begins with a dash, which an agent CLI would read as an option, so it was not sent. ' +
  'Start it with a word instead.'
