/**
 * The renderer's `AgentState` record and its data-only field types, shared
 * with the main process.
 *
 * These are core agent records: `AgentExecution` and `defaultAgent` are
 * generic, and an agent a module started is identified by its
 * `ownerModuleId` — not by an enum member. Pure data shapes only — no DOM, React, or
 * flexlayout imports may be added here.
 */
import { DEFAULT_CLI_PERMISSION_PRESET, type CliPermissionPreset } from './cli-permission-preset'
import type { ExecutionHostId } from './execution-host'

/** An agent CLI runtime id (`claude`, `codex`, …). Open: plugins add their own. */
export type AgentCli = string
/**
 * A renderer agent record's id. One minted now (`newAgentId`) is unique across
 * workspaces, but a chat made before that may still hold a template's `agent-1`,
 * so only the pair (workspace id, agent id) is guaranteed to name one agent.
 */
export type AgentId = string

type AgentMessage = {
  role: 'user' | 'assistant' | 'system'
  content: string
  timestamp: number
}

type AgentStatus = 'idle' | 'running' | 'streaming' | 'error' | 'complete'

export type AgentExecutionMode = 'current_workspace' | 'worktree'

export type McpClientTarget = AgentCli
type McpTransport = 'stdio' | 'http' | 'sse'
export type McpScope = 'workspace' | 'user'
// These MCP shapes are the twin of the ones in src/shared/electron-api.ts (the
// renderer re-exports them from here, the IPC contract declares them there);
// they are structurally identical on purpose and must be changed together.
// 'source' — a server a source installed, owned by Sync — arrived with
// backlog/2026-09-06-mcp-installs-carry-source-provenance.md.
export type McpServerSource = 'bundled' | 'custom' | 'source'
type McpRiskLevel = 'low' | 'network' | 'local-command' | 'secrets'

export type McpServerSourceRef = {
  sourceId: string
  itemId: string
  commitSha: string
  /** Set by a sync that no longer found `itemId` in the source. */
  missing?: boolean
  /**
   * Where the declaring plugin's own files landed, for a server whose command
   * was `${CLAUDE_PLUGIN_ROOT}`-relative. Absent for every other server; the
   * contract's copy in electron-api.ts carries the full reasoning.
   *
   * Added here on 2026-09-06. The field landed on the contract alone
   * (b3b1c81a0) and this twin kept the shorter shape, which is exactly the
   * drift `server-from-scanned.test.ts` guards — "a provenance field added to
   * one and not the other is a config that loses its source somewhere between
   * the two". The guard was right and had simply not been run: verify:app was
   * halting 226 steps before it.
   */
  pluginRoot?: string
}

export type McpServerConfig = {
  id: string
  name: string
  category?: string
  description?: string
  transport: McpTransport
  command?: string
  args?: string[]
  url?: string
  env?: Record<string, string>
  envVarNames?: string[]
  headers?: Record<string, string>
  enabled: boolean
  required?: boolean
  clients: McpClientTarget[]
  scope: McpScope
  source: McpServerSource
  /** Present exactly when `source` is 'source'; see McpServerSourceRef. */
  sourceRef?: McpServerSourceRef
  riskLevel: McpRiskLevel
  auth?: string
  capabilities?: string[]
  sourceUrl?: string
}

export type McpSettings = {
  syncEnabled: boolean
  servers: Record<string, McpServerConfig>
}

export type AgentExecution = {
  mode: AgentExecutionMode
  worktreeId: string | null
  cwd: string | null
}

// Standard workspace agents run through one of two runtimes. `terminal` is the
// default CLI/PTY path.
// `conversation` is the plugin-driven conversation runtime backed by a
// provider/model selection. Older persisted agents have no `runtimeKind` and
// must be treated as `terminal`.
export type AgentRuntimeKind = 'terminal' | 'conversation'

// Conversation runtime selection for a standard workspace agent. `providerId`
// and `modelId` reference an installed conversation provider plugin (see
// `conversation:providers:list`). Absent for terminal agents.
export type AgentConversationRuntime = {
  providerId: string
  modelId: string
}

export type AgentState = {
  id: AgentId
  name: string
  status: AgentStatus
  execution: AgentExecution
  messages: AgentMessage[]
  streamBuffer: string
  // Runtime routing. Undefined is treated as `terminal` for back-compat; the
  // conversation runtime additionally requires a valid `conversation` pair.
  runtimeKind?: AgentRuntimeKind
  conversation?: AgentConversationRuntime
  // The session a person ran in the CLI's own terminal that this chat was
  // imported from (`conversation-import-service.ts`). The chat resumes it by
  // the id its transcript records; this copy is what tells a later import the
  // session is a chat here already.
  importedFrom?: { source: import('./ipc/conversation-import').ConversationImportSource; sessionId: string }
  // Next-turn conversation controls persist independently of terminal flags.
  conversationMode?: 'default' | 'plan' | 'ask'
  conversationReasoningEffort?: string
  /** Selected context skills apply to every turn until explicitly removed. */
  conversationSkills?: string[]
  cliSessionId?: string
  // The agent's session id within its CLI/harness, captured from lifecycle hooks
  // (the snapshot's `cliSessionId`). Distinct from `cliSessionId` above, which is
  // our terminal-tracking key. Used as the resume token so non-Claude CLIs (e.g.
  // Codex, which mints its own id) resume the right conversation. For Claude it
  // coincides with the terminal key. Persisted so resume survives a restart.
  harnessSessionId?: string
  // The machine the agent's CLI ran on (`local`, or `wsl:<distro>`), learned
  // from its session. A resume goes back there whatever the workspace says
  // now: the CLI's transcript lives in that machine's home.
  hostId?: import('./execution-host').ExecutionHostId
  cliStartRequested?: boolean
  cliRestartNonce?: number
  cliHasLaunched?: boolean
  cliOnboardingPromptSent?: boolean
  cliResumeAvailable?: boolean
  // Whether this agent's CLI resumes with the session id WE mint (Claude-family)
  // vs. minting its own (Codex). Stamped from the plugin manifest capability
  // (`sessionIdFromCaller`) at session assign, the sibling of cliResumeAvailable;
  // consumers use it to decide the resume token. See agent-cli-resume.ts.
  cliUsesStableSessionId?: boolean
  cliLastExitCode?: number | null
  cliLastExitedAt?: number | null
  cli?: AgentCli
  // Model id passed at CLI launch when the plugin declares modelSelection.
  // Undefined means the CLI's own default; persisted so relaunch and resume
  // keep the model the agent was created with.
  cliModel?: string
  // Reasoning-effort level passed at CLI launch when the plugin declares
  // reasoningSelection. Undefined means the CLI's own default effort (no flag);
  // persisted alongside cliModel so a relaunch keeps the effort the agent was
  // created with. Scoped by `cli` at the surface that resolved it
  // (resolveCliReasoning), so it is always a level this agent's CLI accepts.
  cliReasoning?: string
  cliPermissionPreset?: CliPermissionPreset
  // The CLI's own permission mode at that preset (Claude Code's Accept edits,
  // Codex's Default), when one other than the preset's own was chosen. The
  // preset stays the level everything else reads; a CLI that does not have
  // this mode runs the preset's own (cli-permission-mode.ts).
  cliPermissionMode?: string
  // (A `debugMode` flag sat here until Debug Mode was removed on 2026-09-28.
  // Agents persisted before then may still carry it; nothing reads it.)
  cliStartupPrompt?: string
  // Last user edit to renderer-owned per-agent config (name, cliStartupPrompt,
  // …), stamped when a window sends a `workspace.update_agent` command. The
  // workspace registry applies those edits last-write-wins on this stamp, so a
  // window whose store lags the newest edit can never clobber it.
  configEditedAt?: number
  // Connector chat: a worktree-isolated solo chat scoped to one MCP connector.
  // `connectorMcpSettings` is the connector-only MCP config the spawn forwards
  // *instead of* the global appSettings.mcp, so the connector server is written
  // into this worktree's .mcp.json and nowhere else. Read by the TerminalView
  // launch path.
  connectorMcpSettings?: McpSettings
  // Skill-at-spawn (the composer's "+ Skill" attachment): ensure-installed at
  // the launch boundary, with none of the connector MCP coupling. Works for any
  // agent spawn, not just connectors.
  spawnSkillId?: string
  // One-shot input pasted (bracketed, unsubmitted) into the PTY right after a
  // successful launch — the skill invocation sits at the prompt with the caret
  // ready for arguments. Cleared by TerminalView once pasted; never auto-sent.
  cliPendingInput?: string
  // Conversation-transport counterpart of `cliStartupPrompt`: what the launch
  // surface typed, sent as the chat's first message once its provider is ready.
  // One-shot — the chat clears it before sending, so a remount never resends.
  chatStartupPrompt?: string
  // The images the launch surface staged, as the files on this computer that
  // hold them: they go with `chatStartupPrompt` as the first message's images,
  // not as paths in its text. Paths, not bytes, because this record rides the
  // workspace registry. One-shot, cleared with the prompt.
  chatStartupImages?: string[]
  // The files the launch surface attached by path, as their paths on this
  // computer: they go with `chatStartupPrompt` as the first message's `files`,
  // not as paths in its text, and its bubble draws them as cards. One-shot,
  // cleared with the prompt.
  chatStartupFiles?: string[]
  // A New chat on a worktree, opened before its worktree was made: the
  // workspace has the project in its worktree marker and no folder until the
  // worktree lands, and the chat starts nothing until then. `name` is what the
  // person typed for the worktree (empty: one is made up per attempt), and
  // `failure` is why the last attempt did not make it; `hostId` is the machine
  // New chat stood on, whose git makes the worktree. Cleared once the folder
  // is set. Rides the registry, so a chat still pending when the app went away
  // comes back failed rather than waiting on an attempt that no longer exists.
  chatPendingWorktree?: { name: string; projectFolder: string; hostId?: ExecutionHostId; failure?: string }
  // The Backlog item this agent was last handed (drag-drop or send-to-agent).
  // Powers the top-right glyph on the agent terminal that navigates back to the
  // item. Latest-wins: one ref per agent, mirroring the most-recent-wins
  // fixed link id on the Backlog item side. Undefined when no item was handed.
  backlogItemRef?: AgentBacklogItemRef
  // The module that started this chat through the module conversation
  // service. Only that module reaches it there (a chat without one is the
  // person's own, and no module's). Set once at launch and never edited, so it
  // rides the workspace registry and every window's store as-is.
  ownerModuleId?: string
  // The caller's id for the command that created this chat, namespaced by the
  // caller (a module's is `module:<moduleId>:<commandId>`), so a create that
  // is retried finds the chat its first attempt made rather than making a
  // second. Set once at launch and never edited.
  launchCommandId?: string
  // The key the owning module opened this chat under (`openChat`'s
  // `dedupeKey`), so asking again focuses it instead of opening another. Set
  // once, beside `ownerModuleId`, and never edited.
  moduleChatKey?: string
  // The tag of the scheduled agent whose run started this chat
  // (`ScheduledAgent.tag`), beside its workspace's `scheduledAgentId`, so the
  // extension that made the schedule can tell its runs apart. Set once, at the
  // run's launch, and never edited.
  scheduledAgentTag?: string
}

type AgentBacklogItemRef = {
  // Project-root-relative `backlog/...` path; the select key for reverse nav.
  relativePath: string
  // Item title, kept so the glyph's tooltip/accessible name needs no file read.
  title: string
  linkedAt: number
}

/**
 * The folder a chat agent's conversation runs in, and so the root its session
 * and transcript are keyed by: its worktree when it was started in one (an
 * automation run's), otherwise the workspace folder.
 */
export function conversationWorkingRoot(
  agent: Pick<AgentState, 'execution'> | null | undefined,
  workspaceFolder: string | null | undefined,
): string | null {
  const execution = agent?.execution
  if (execution?.mode === 'worktree' && execution.cwd?.trim()) return execution.cwd
  return workspaceFolder?.trim() ? workspaceFolder : null
}

// ---------------------------------------------------------------------------
// Record construction
// ---------------------------------------------------------------------------
//
// The blank agent record every creation path starts from. It lived in the
// renderer's agents slice until main began composing workspaces itself; a
// second copy in main would drift the moment a field is added, so both
// processes mint records here. `agentsSlice.ts` re-exports these so existing
// renderer import sites are unchanged.

export function defaultAgentExecution(): AgentExecution {
  return { mode: 'current_workspace', worktreeId: null, cwd: null }
}

// The agent-state fields that make a fresh agent a conversation-runtime agent.
// Shared by the spawn action, a fork (a window's own and one a paired device
// asks for, which main writes) and their tests, so the routing contract cannot
// drift: `runtimeKind`/`conversation` opt into AgentChatView, and the `cli*`
// fields are cleared so no terminal session is ever started for this agent.
export function conversationAgentRuntimePatch(providerId: string, modelId: string): Partial<AgentState> {
  return {
    runtimeKind: 'conversation',
    conversation: { providerId, modelId },
    cli: undefined,
    cliStartupPrompt: undefined,
    cliStartRequested: false,
    cliHasLaunched: false,
    cliResumeAvailable: false,
    cliSessionId: undefined,
  }
}

export function defaultAgent(id: AgentId, name = id): AgentState {
  return {
    id,
    name,
    status: 'idle',
    execution: defaultAgentExecution(),
    messages: [],
    streamBuffer: '',
    runtimeKind: 'terminal',
    conversation: undefined,
    cliSessionId: undefined,
    harnessSessionId: undefined,
    cliStartRequested: false,
    cliRestartNonce: 0,
    cliHasLaunched: false,
    cliOnboardingPromptSent: false,
    cliResumeAvailable: false,
    cli: undefined,
    cliModel: undefined,
    cliPermissionPreset: DEFAULT_CLI_PERMISSION_PRESET,
    cliStartupPrompt: undefined,
    backlogItemRef: undefined,
  }
}
