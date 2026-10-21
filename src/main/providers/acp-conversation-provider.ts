import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process'
import { Readable, Writable } from 'node:stream'
import { lstat } from 'node:fs/promises'
import { resolve, sep } from 'node:path'
import {
  openConfinedExistingFile,
  readBoundedConversationFile,
  resolveConversationPath,
} from '../conversation-file-access'
import { terminateCliChild } from './cli-child-process'
import { cliProbeEnv } from '../cli-probe-env'
import { mergeJsonEnvValue } from '../json-env-value'
import {
  CONVERSATION_IDENTITY_ENV_KEYS,
  cliHostSpawn,
  hostMachineName,
  localLaunchToken,
  mcpServersOnWsl,
  prepareWslCliTarget,
  spawnCliHostChild,
  wslTargetForHost,
  type WslChannelToken,
  type WslCliChild,
  type WslCliTarget,
} from './cli-host-child'
import {
  isStudioGatewayName,
  studioGatewayForChat,
  withStudioGateway,
  type StudioMcpServerResolver,
} from './studio-gateway-entry'
import { inferConversationToolKind } from '../../shared/conversation/toolKind'
import { isWslHostId, type ExecutionHostId } from '../../shared/execution-host'
import { AGENT_IDENTITY_ENV_KEYS, MCP_CHANNEL_TOKEN_ENV } from '../../shared/studio-env'
import { toWslPath, wslPathInRootSpelling } from '../../shared/host-paths'
import { publishConversationCommands } from '../conversation-commands/registry'
import { acpConversationCommands } from '../conversation-commands/acp'
import { leadingCommandFor } from '../conversation-commands/leading-command'
import type { ConversationCommand } from '../../shared/conversation/commands'
import { conversationPermissionPresetRefusals } from '../../shared/conversation-harness'
import { isLooserCliPermissionPreset } from '../../shared/cli-permission-preset'
import type {
  ClientSideConnection,
  McpCapabilities,
  McpServer,
  RequestPermissionRequest,
  RequestPermissionResponse,
  SessionUpdate,
  ToolKind,
} from '@agentclientprotocol/sdk'
import type {
  ConversationCapabilities,
  ConversationCliRuntimeOverrides,
  ConversationEvent,
  ConversationMcpServer,
  ConversationPermissionPreset,
  ConversationQuestion,
  ConversationToolKind,
} from '../../shared/conversation-runtime'
import { turnUsageOf } from '../../shared/conversation/turn-usage'
import type {
  ConversationProviderAdapter,
  MockAdapterSessionInput,
  MockAdapterTurnInput,
} from './conversation-provider-adapter'
import { cliStderrSummary } from '../../shared/conversation/permissionModes'
import {
  saveToolResultImages,
  toolResultImages,
  type SaveToolResultImages,
  type ToolResultImage,
} from './tool-result-images'

type EnforcedPreset = Exclude<ConversationPermissionPreset, 'none'>

/**
 * How a CLI is told one permission preset: launch argv in place of the plain
 * one, environment on top, or one of the agent's own ACP session modes, which
 * it is put in before each turn and the moment the preset changes.
 */
type AcpPresetLaunch = { argv?: string[]; env?: Record<string, string>; mode?: string }

export type AcpProfile = {
  id: string
  displayName: string
  cli: string
  // The launch argv under `none`: no permission flag, so the CLI's own
  // configuration decides.
  argv: string[]
  // How the CLI is told each preset it can be held to. Both are fixed when
  // the child starts, so changing the preset respawns it and reloads the
  // session, at the next turn when one is running. A preset missing here is
  // one the CLI cannot be held to; `unsupported` says why, and it is refused
  // rather than run as something else.
  presets?: Partial<Record<EnforcedPreset, AcpPresetLaunch>>
  // The CLI's other modes, by the id its manifest keys them under, each at the
  // preset it sits at (conversationPermissionModes). Told the same way, and
  // run only at that preset.
  ownModes?: Record<string, AcpPresetLaunch & { level: EnforcedPreset }>
  unsupported?: Partial<Record<EnforcedPreset, string>>
  // Commands the CLI accepts in the prompt that switch its own permission mode,
  // with the least permissive preset that already allows what they switch to.
  // Typed under a stricter preset, they would undo the person's choice from
  // inside the conversation, where the permission picker cannot see it.
  permissionCommands?: Record<string, EnforcedPreset>
  authHint: string
  authenticate?: string
  images: boolean
  planMode: boolean
  // The agent asks its own questions as a permission request titled
  // `AskUserQuestion`, one option per answer (acpQuestionRequest): asked as a
  // question, not as a tool to allow.
  questions?: boolean
}

// OpenCode's permission rule set for a preset. `opencode acp` takes no
// permission flag (`--auto` belongs to the TUI and `run`), but its
// configuration takes a rule set, merged over the person's own, and the last
// matching rule wins. So the wildcard comes first and every tool OpenCode
// names follows it, each overriding the person's rule for the same tool;
// reads, searches, listings and the to-do list run, and `external_directory`
// (anything outside the project) asks.
function opencodePermission(edit: 'allow' | 'ask'): Record<string, string> {
  return opencodeRules({
    '*': 'ask',
    read: 'allow',
    glob: 'allow',
    grep: 'allow',
    list: 'allow',
    lsp: 'allow',
    todoread: 'allow',
    todowrite: 'allow',
    edit,
    bash: 'ask',
    task: 'ask',
    webfetch: 'ask',
    websearch: 'ask',
    codesearch: 'ask',
    external_directory: 'ask',
  })
}

// The two ways OpenCode takes that rule set. 1.x reads OPENCODE_PERMISSION;
// 2.x no longer does (the variable is gone from its binary, and a Manual chat
// on 2.0.32 ran a shell command without asking), but it reads `permission`
// from the OPENCODE_CONFIG_CONTENT document, which 1.x reads too, merged over
// the person's own configuration, and maps 1.x's `bash` and `task` onto its
// `shell` and `subagent`. Measured live against 1.18.32 and 2.0.32 on
// 2026-10-17. The document is merged with whatever else says to it (the
// person's own export), never replaced: see the launch below.
function opencodeRules(rules: Record<string, string>): Record<string, string> {
  return {
    OPENCODE_PERMISSION: JSON.stringify(rules),
    OPENCODE_CONFIG_CONTENT: JSON.stringify({ permission: rules }),
  }
}

/** Profiles are protocol observations, not guesses based on a CLI's terminal features. */
export const ACP_PROFILES: AcpProfile[] = [
  {
    id: 'cursor-agent',
    displayName: 'Cursor',
    cli: 'cursor',
    argv: ['acp'],
    // Cursor's permission flags are top-level options and must precede the
    // subcommand. Without a flag it sends session/request_permission for what
    // its own configuration does not already allow. `--auto-review` is its own
    // Auto: a classifier runs the calls it judges safe and asks for the rest.
    presets: {
      auto: { argv: ['--auto-review', 'acp'] },
      bypass: { argv: ['--force', 'acp'] },
    },
    unsupported: conversationPermissionPresetRefusals('cursor'),
    authHint: 'Run agent login in a terminal.',
    authenticate: 'cursor_login',
    images: true,
    planMode: true,
  },
  {
    id: 'opencode-agent',
    displayName: 'OpenCode',
    cli: 'opencode',
    argv: ['acp'],
    presets: {
      manual: { env: opencodePermission('ask') },
      auto: { env: opencodePermission('allow') },
      // A wildcard allow is what `--auto` does for the TUI.
      bypass: { env: opencodeRules({ '*': 'allow' }) },
    },
    authHint: 'Run opencode auth login in a terminal and configure a working model.',
    images: true,
    planMode: true,
  },
  {
    id: 'grok-agent',
    displayName: 'Grok',
    cli: 'grok',
    // --no-leader keeps one agent process per conversation even when Grok's
    // config enables its shared leader, so the flags below govern this session
    // alone. --permission-mode is a top-level option (before `agent`) and
    // overrides the configured mode for this process: Grok has the same modes
    // Claude Code does, so Manual is `default` and Auto its own classifier
    // mode, `auto`, as Claude's is (owner ruling 2026-10-01).
    // --always-approve is an agent option (after `agent`, before the transport).
    argv: ['agent', '--no-leader', 'stdio'],
    presets: {
      manual: { argv: ['--permission-mode', 'default', 'agent', '--no-leader', 'stdio'] },
      auto: { argv: ['--permission-mode', 'auto', 'agent', '--no-leader', 'stdio'] },
      bypass: { argv: ['agent', '--always-approve', '--no-leader', 'stdio'] },
    },
    ownModes: {
      acceptEdits: { level: 'auto', argv: ['--permission-mode', 'acceptEdits', 'agent', '--no-leader', 'stdio'] },
      dontAsk: { level: 'manual', argv: ['--permission-mode', 'dontAsk', 'agent', '--no-leader', 'stdio'] },
    },
    // Grok's `/auto` hands its approvals to the classifier Auto already starts
    // it in, so only a stricter mode refuses it; `/always-approve` is bypass.
    permissionCommands: { '/always-approve': 'bypass', '/auto': 'auto' },
    authHint: 'Run grok login in a terminal.',
    images: false,
    planMode: false,
  },
  {
    id: 'kimi-code-agent',
    displayName: 'Kimi Code',
    cli: 'kimi-code',
    // `kimi acp` takes no permission flag and no variable for one. What it
    // has are four ACP session modes, which are what each preset is told,
    // over the protocol, before every turn. Read off Kimi Code 0.42.0's
    // permission policies rather than its mode descriptions, which have the
    // two looser ones the wrong way round:
    //   default  reads, searches, web lookups and subagents run; a Write or
    //            Edit inside a git project runs; everything else asks.
    //   yolo     its "Ask When Needed" (`kimi --yolo`): routine edits and
    //            commands run; a command its parser reads as dangerous, a
    //            sensitive file, the git directory and the person's own ask
    //            rules still ask. Its own Auto.
    //   auto     its "Never Ask" (`kimi --auto`, the terminal agent's
    //            Bypass): everything runs but what the person's own rules
    //            deny, and it asks no questions.
    // Manual has no mode: see conversationPermissionPresetRefusals.
    argv: ['acp'],
    presets: {
      auto: { mode: 'yolo' },
      bypass: { mode: 'auto' },
    },
    unsupported: conversationPermissionPresetRefusals('kimi-code'),
    authHint: 'Run kimi login in a terminal.',
    images: true,
    planMode: true,
    questions: true,
  },
]

const supportedPresets = (profile: AcpProfile): ConversationPermissionPreset[] => [
  'none',
  ...(Object.keys(profile.presets ?? {}) as EnforcedPreset[]),
]

// How the CLI is told a preset, or the mode of its own chosen at it: the mode
// when the profile has it at that preset, else the preset's own.
function presetLaunch(
  profile: AcpProfile,
  preset: ConversationPermissionPreset,
  mode: string | undefined,
): AcpPresetLaunch | undefined {
  if (preset === 'none') return undefined
  const own = mode && profile.ownModes && Object.hasOwn(profile.ownModes, mode) ? profile.ownModes[mode] : undefined
  return own && own.level === preset ? own : profile.presets?.[preset]
}

/** The argv a conversation's child is launched with under a permission preset (and the CLI's own mode at it). */
export function acpLaunchArgv(
  profile: AcpProfile,
  preset: ConversationPermissionPreset = 'none',
  mode?: string,
): string[] {
  return presetLaunch(profile, preset, mode)?.argv || profile.argv
}

/** What a conversation's child gets on top of its environment under a permission preset. */
export function acpLaunchEnv(
  profile: AcpProfile,
  preset: ConversationPermissionPreset = 'none',
  mode?: string,
): Record<string, string> {
  return presetLaunch(profile, preset, mode)?.env || {}
}

/** The agent's own session mode a preset (and the CLI's own mode at it) puts it in, if it is told one that way. */
export function acpPresetSessionMode(
  profile: AcpProfile,
  preset: ConversationPermissionPreset = 'none',
  mode?: string,
): string | undefined {
  return presetLaunch(profile, preset, mode)?.mode
}

// Whether two settings start the child the same way, so moving between them
// only moves the agent's session mode and needs no new process.
function sameAcpLaunch(
  profile: AcpProfile,
  from: { preset?: ConversationPermissionPreset; mode?: string },
  to: { preset?: ConversationPermissionPreset; mode?: string },
): boolean {
  const launch = (setting: typeof from) =>
    JSON.stringify([
      acpLaunchArgv(profile, setting.preset, setting.mode),
      acpLaunchEnv(profile, setting.preset, setting.mode),
    ])
  return launch(from) === launch(to)
}

/** Why a CLI cannot run a preset, or null when it can. */
function presetRefusal(profile: AcpProfile, preset: ConversationPermissionPreset): string | null {
  if (supportedPresets(profile).includes(preset)) return null
  const reason = preset === 'none' ? undefined : profile.unsupported?.[preset]
  return `${reason ?? `${profile.displayName} cannot be held to this permission preset.`} Choose another permission preset.`
}

/** A prompt that would switch the CLI's own permission mode past the chosen preset. */
function permissionCommandRefusal(
  profile: AcpProfile,
  preset: ConversationPermissionPreset | undefined,
  message: string,
): string | undefined {
  if (!preset || preset === 'none') return undefined
  const command = message.trim().split(/\s/, 1)[0]?.toLowerCase() ?? ''
  const needs = profile.permissionCommands?.[command]
  if (!needs || !isLooserCliPermissionPreset(needs, preset)) return undefined
  return `${command} would change ${profile.displayName}'s permissions from inside the conversation. Use the permission picker in the chat box instead.`
}

const baseCapabilities = (profile: AcpProfile): ConversationCapabilities => ({
  permissionPresets: supportedPresets(profile),
  permissionModes: Object.keys(profile.ownModes ?? {}),
  tools: true,
  approvals: true,
  questions: profile.questions === true,
  planMode: profile.planMode,
  images: profile.images,
  skills: 'context',
  reasoningEfforts: null,
  interrupt: true,
  resume: true,
  subagents: false,
  cost: false,
  contextMeter: false,
  liveModelSwitch: true,
  fork: true,
  forkFromLiveSession: true,
})
// What a permission request is read as. ACP agents name the files a call
// touches in `locations`, beside an input that may use its own key for them or
// be absent, so the locations go with it: a mode places a lookup by them.
export function acpApprovalInput(
  rawInput: unknown,
  locations: ReadonlyArray<{ path: string }> | null | undefined,
): unknown {
  if (!locations?.length) return rawInput
  const listed = locations.map((location) => ({ path: location.path }))
  if (rawInput === undefined || rawInput === null) return { locations: listed }
  if (typeof rawInput !== 'object' || Array.isArray(rawInput) || 'locations' in rawInput)
    return { input: rawInput, locations: listed }
  return { ...rawInput, locations: listed }
}
export const acpToolKind = (kind?: ToolKind | null): ConversationToolKind =>
  ({
    read: 'file_read',
    edit: 'file_edit',
    delete: 'file_edit',
    move: 'file_edit',
    search: 'search',
    execute: 'command',
    fetch: 'web',
    think: 'other',
    switch_mode: 'other',
    other: 'other',
  })[kind ?? 'other'] as ConversationToolKind

// ACP has no tool kind for a checklist. OpenCode keeps its plan with its
// `todowrite` tool and sends no `plan` update for it: the list arrives only as
// a call of ACP kind `other`, its `todos` in the input. Grok's agent carries
// the same tool and a `TodoWrite`. The tool's name says what the kind cannot,
// so the call is drawn as a checklist and the strip above the composer reads
// it as it reads Claude Code's.
export const acpTodoTool = (name: string | null | undefined): boolean =>
  inferConversationToolKind(name?.trim() ?? '') === 'todo'

// ACP has no notion of a subagent: an agent that spawns one reports the spawn
// as an ordinary tool call. It is read off the call instead, by the spawn
// tool's name or by the agent type its input names (OpenCode's `task` takes
// `description`, `prompt` and `subagent_type`), so the chat draws it as an
// agent of its own rather than one more step.
const ACP_SUBAGENT_TOOL_NAMES = new Set(['task', 'agent', 'subagent', 'spawn_agent'])

type AcpSubagentLane = { subagentLane?: true; subagentType?: string }

export function acpSubagentLaneFields(name: string | null | undefined, rawInput: unknown): AcpSubagentLane {
  const input =
    rawInput && typeof rawInput === 'object' && !Array.isArray(rawInput) ? (rawInput as Record<string, unknown>) : {}
  const type = [input.subagent_type, input.subagentType, input.agent_type].find(
    (value): value is string => typeof value === 'string' && value.trim().length > 0,
  )
  if (!type && !ACP_SUBAGENT_TOOL_NAMES.has((name ?? '').trim().toLowerCase())) return {}
  return { subagentLane: true, ...(type ? { subagentType: type.trim() } : {}) }
}

// A data URL's picture, as the attachments of OpenCode's raw tool output carry one.
const IMAGE_DATA_URL = /^data:(image\/[\w.+-]+);base64,(.+)$/s

function acpAttachments(rawOutput: unknown): Array<Record<string, unknown>> {
  const attachments =
    rawOutput && typeof rawOutput === 'object' ? (rawOutput as { attachments?: unknown }).attachments : undefined
  return Array.isArray(attachments)
    ? attachments.filter((entry): entry is Record<string, unknown> => !!entry && typeof entry === 'object')
    : []
}

/**
 * The pictures a tool call returned, in order and once each: its image
 * content blocks, and the data URLs among its raw output's attachments
 * (OpenCode sends a screenshot both ways).
 */
export function acpToolResultImages(content: readonly unknown[], rawOutput: unknown): ToolResultImage[] {
  const blocks: Array<{ type: 'image'; mimeType: unknown; data: unknown }> = []
  for (const entry of content) {
    const block = entry && typeof entry === 'object' ? (entry as { type?: unknown; content?: unknown }) : null
    const inner = block?.type === 'content' ? (block.content as { type?: unknown } | null) : null
    if (inner?.type === 'image') blocks.push(inner as { type: 'image'; mimeType: unknown; data: unknown })
  }
  for (const attachment of acpAttachments(rawOutput)) {
    const match = typeof attachment.url === 'string' ? IMAGE_DATA_URL.exec(attachment.url) : null
    if (match) blocks.push({ type: 'image', mimeType: match[1], data: match[2] })
  }
  const seen = new Set<unknown>()
  return toolResultImages(blocks.filter((block) => !seen.has(block.data) && seen.add(block.data)))
}

/**
 * What is kept of a tool call between its updates, for the next one to build
 * on: its name, kind, title, input and what was read off them (its subagent
 * lane, its todo mark). Not its content or raw output: each update's are read
 * from that update alone, and kept they would hold every file the turn read
 * and every screenshot's base64 until the turn ends.
 */
export function acpRememberedToolCall(tool: Record<string, unknown>): Record<string, unknown> {
  const kept = { ...tool }
  delete kept.content
  delete kept.rawOutput
  return kept
}

/**
 * What a tool call's raw output says, with its pictures' bytes left out: the
 * tool's own text when it has one, else the raw output with each picture
 * attachment's data URL dropped. Output with no pictures is unchanged.
 */
export function acpRawOutputText(rawOutput: unknown): unknown {
  const attachments = acpAttachments(rawOutput)
  if (!attachments.some((entry) => typeof entry.url === 'string' && entry.url.startsWith('data:'))) return rawOutput
  const raw = rawOutput as Record<string, unknown>
  if (typeof raw.output === 'string') return raw.output
  return {
    ...raw,
    attachments: attachments.map(({ url, ...rest }) =>
      typeof url === 'string' && url.startsWith('data:') ? rest : { url, ...rest },
    ),
  }
}

// Events in the order the agent sent them. One may wait on a promise (its
// pictures being written to disk), and every event after it waits behind it.
class Queue implements AsyncIterable<ConversationEvent> {
  private items: Array<{ event: ConversationEvent; ready?: Promise<void> }> = []
  private wake?: () => void
  private ended = false
  push(event: ConversationEvent, ready?: Promise<void>) {
    if (!this.ended) {
      this.items.push({ event, ready })
      this.wake?.()
    }
  }
  end() {
    this.ended = true
    this.wake?.()
  }
  async *[Symbol.asyncIterator]() {
    while (!this.ended || this.items.length) {
      const next = this.items.shift()
      if (next) {
        if (next.ready) await next.ready
        yield next.event
      } else
        await new Promise<void>((resolve) => {
          this.wake = resolve
        })
    }
  }
}
type Pending = {
  options: RequestPermissionRequest['options']
  resolve: (value: RequestPermissionResponse) => void
  // The text of a question asked as a permission request, which its answer is keyed by.
  question?: string
}

/**
 * A question the agent asked as a permission request, or null for a tool to
 * allow. Kimi Code has no other way to ask over ACP without forms: its
 * AskUserQuestion arrives titled so, the question as the call's text, one
 * `allow_once` option per answer and a `reject_once` to skip it. One question,
 * one answer from the list: it takes no typed answer.
 */
export function acpQuestionRequest(params: RequestPermissionRequest): ConversationQuestion | null {
  if (params.toolCall.title !== 'AskUserQuestion') return null
  const question = (params.toolCall.content ?? [])
    .map((entry) => (entry.type === 'content' && entry.content.type === 'text' ? entry.content.text : ''))
    .join('\n')
    .trim()
  const answers = params.options.filter((option) => option.kind === 'allow_once' && option.name.trim())
  if (!question || answers.length === 0) return null
  return {
    question,
    multiSelect: false,
    allowFreeText: false,
    options: answers.map((option) => ({ label: option.name })),
  }
}
// How much of a CLI's stderr is kept for the message of a failure it ends with.
const STDERR_TAIL_CHARS = 4000

/**
 * A failure's message with what the CLI printed, when it printed anything:
 * the line refusing its permission setting when there is one, however much
 * usage text came after it, else its last lines (`cliStderrSummary`).
 */
function withStderrTail(message: string, stderrTail: string): string {
  const tail = cliStderrSummary(stderrTail)
  return tail ? `${message} (${tail})` : message
}

// What Cursor's agent says, as its reply, when it has lost its connection to
// Cursor's servers: the error it caught, or its generic apology, and nothing
// else. It then ends the prompt with an ordinary stop reason.
const CURSOR_TRANSPORT_LINES = [
  /^(?:Error: )?(?:RetriableError|ConnectError): \S/,
  /^Something went wrong communicating with the server\. Please try again\.$/,
]
const STACK_FRAME_LINE = /^\s+at \S/

/**
 * The reply itself when Cursor's whole reply is one of its connection
 * diagnostics (with the stack frames it may print under one), else undefined.
 * Such a turn failed: it never reached the model, and recorded as an answer it
 * would read as the agent's reply and be carried into the next turn's
 * history. Any other line, prose included, makes it an answer, so a reply that
 * explains an error is never taken for one.
 */
export function cursorTransportFailure(reply: string): string | undefined {
  const message = reply.trim()
  let diagnostic = false
  for (const line of message.split('\n')) {
    if (!line.trim() || (diagnostic && STACK_FRAME_LINE.test(line))) continue
    if (!CURSOR_TRANSPORT_LINES.some((pattern) => pattern.test(line.trim()))) return undefined
    diagnostic = true
  }
  return diagnostic ? message : undefined
}

type State = {
  input: MockAdapterSessionInput
  // What the agent said it can connect to, from its handshake.
  mcpCapabilities?: McpCapabilities
  child?: ChildProcessWithoutNullStreams
  connection?: ClientSideConnection
  starting?: Promise<void>
  nativeId?: string
  closed: boolean
  loading: boolean
  loadSupported: boolean
  // The agent branches a session on `session/fork` (`sessionCapabilities.fork`).
  forkSupported: boolean
  // Where the session was opened, and with which servers, in the agent's own
  // terms: a branch of it opens in the same.
  opened?: { cwd: string; mcpServers: ReturnType<typeof acpMcpServers> }
  queue?: Queue
  turn?: MockAdapterTurnInput
  // Settles when the running turn has ended, however it ended.
  turnEnded?: Promise<void>
  cancelled: boolean
  // Ends the process of a stopped turn the agent does not wind down; see
  // ACP_CANCEL_GRACE_MS.
  cancelWatchdog?: ReturnType<typeof setTimeout>
  pending: Map<string, Pending>
  toolCalls: Map<string, Record<string, unknown>>
  lastActivityAt: number
  spawnedAt: number | null
  capabilities: ConversationCapabilities
  modes: string[]
  defaultMode?: string
  modeConfigId?: string
  // The agent's model config option, the value it started on (what the CLI's
  // own default row maps back to), and the model the live session is on — a
  // switch is applied at the start of the next turn when these disagree.
  modelConfigId?: string
  defaultModelValue?: string
  appliedModelId?: string
  history: Array<{ user: string; assistant: string }>
  replayHistory: boolean
  // A fork the agent could not branch: its first message carries the
  // conversation, whichever session it lands in.
  seedPending: boolean
  // Set when a stored session could not be reopened; reported once, with the
  // replacement session's identity, so the person knows context was replayed.
  resumeNotice?: string
  assistantText: string
  // The agent's latest message of the turn: what it said since its last tool
  // call or plan, which `turn_completed` reports as the reply. `replyClosed`
  // marks a tool or plan said since, so the next text starts a new message.
  reply: string
  replyClosed: boolean
  // The preset changed while a turn ran; the next turn starts a new child.
  relaunch?: boolean
}
// A change larger than this is approved by path and size: the approval card is
// persisted with the transcript, and a multi-megabyte diff would dominate it.
const WRITE_PREVIEW_BYTES = 256 * 1024
// The largest protocol line an agent may print before it is taken for broken.
const MAX_FRAME_BYTES = 16 * 1024 * 1024
// How long a stopped turn waits for the agent to answer its prompt after
// `session/cancel`. The protocol has the prompt resolve as cancelled, and the
// process is kept for the next turn; one that does not answer by then is
// ended, so Stop always takes effect.
export const ACP_CANCEL_GRACE_MS = 5_000

type Options = {
  detect?: (input: MockAdapterSessionInput) => Promise<string>
  buildEnv?: (input: MockAdapterSessionInput) => Promise<NodeJS.ProcessEnv>
  startupTimeoutMs?: number
  cancelGraceMs?: number
  // Readies a WSL machine for a chat whose CLI runs there; tests stand in.
  prepareWslTarget?: (hostId: ExecutionHostId) => Promise<WslCliTarget>
  // Starts the child; tests stand in to see what a WSL chat would run.
  spawnChild?: typeof spawn
  // The app's MCP gateway on the machine the chat's CLI runs on. Null leaves
  // it out; the chat runs without Studio's tools rather than not at all.
  resolveStudioMcpServer?: StudioMcpServerResolver
  // Writes a step's pictures; the app's data folder unless a test stands in.
  saveToolImages?: SaveToolResultImages
}

/** Text helpers refuse symlinks in every path component, not only the leaf.
 * The agent was started in the workspace root as configured, so it names files
 * under that spelling or under the resolved one (a root below macOS `/var` is
 * really below `/private/var`); both are the workspace. */
export async function confinedAcpPath(cwd: string, requested: string, writing = false): Promise<string> {
  const { root, target, suffix } = await resolveConversationPath(cwd, requested)
  const parts = suffix.split(sep)
  let current = root
  for (let index = 0; index < parts.length; index++) {
    current = resolve(current, parts[index])
    try {
      const entry = await lstat(current)
      if (entry.isSymbolicLink()) throw new Error('Symbolic links are not available through conversation file access.')
      if (index < parts.length - 1 && !entry.isDirectory()) throw new Error('File parent is not a directory.')
      if (index === parts.length - 1 && !entry.isFile())
        throw new Error('Only regular files are available through conversation file access.')
    } catch (error) {
      if (writing && index === parts.length - 1 && (error as NodeJS.ErrnoException).code === 'ENOENT') break
      throw error
    }
  }
  return target
}

async function detectAcpCommand(profile: AcpProfile, cliRuntimes?: ConversationCliRuntimeOverrides): Promise<string> {
  const { resolveCliExecutable } = await import('../cli-runtime-install')
  const runtime = cliRuntimes?.[profile.cli]
  const found = await resolveCliExecutable(profile.cli, runtime)
  if (!found.path) {
    if (isWslHostId(runtime?.hostId))
      throw new Error(
        `${profile.displayName} CLI was not found on ${hostMachineName(runtime.hostId)}. Install it in that distribution (or set its command for that machine in Settings) to chat there.` +
          (found.error ? ` ${found.error}` : ''),
      )
    throw new Error(`${profile.displayName} CLI was not found. Install it or configure its command in Settings.`)
  }
  return found.path
}

/**
 * What an agent in WSL is started with of the chat's environment: the
 * variables its permission preset sets, and nothing else of this PC's. Its
 * login, PATH and configuration are the distribution's own.
 */
export function acpWslChild(
  target: WslCliTarget,
  profile: AcpProfile,
  preset: ConversationPermissionPreset = 'none',
  mode?: string,
): WslCliChild {
  return { ...target, forwardEnv: Object.keys(acpLaunchEnv(profile, preset, mode)) }
}

/**
 * A path an agent sent the client, as this machine opens it. An agent in WSL
 * names files the Linux way (`/home/dev/repo/a.ts`, `/mnt/c/…`); the
 * workspace is opened through its Windows spelling, which keeps its share name.
 */
export function acpClientPath(path: string, root: string, wsl: WslCliTarget | null): string {
  return wsl ? wslPathInRootSpelling(path, root, wsl.distro) : path
}

// The CLI could not be started from where it was found: look it up again on
// the next start.
function forgetAcpCommand(profile: AcpProfile): void {
  void import('../cli-runtime-install').then(({ invalidateCliExecutable }) => invalidateCliExecutable(profile.cli))
}

/**
 * The gateway token for one ACP child, bound to its chat. An ACP agent's
 * environment names no conversation (acpEnvironment), so the token is issued
 * here from the session rather than from that environment, and the gateway
 * entry the agent is told carries its value. On a WSL machine it is also the
 * channel token the helper opens the bridge's channel with, issued as before
 * to a child whose session names no chat.
 */
function acpLaunchToken(
  input: Pick<MockAdapterSessionInput, 'workspaceId' | 'agentId'>,
  cli: string,
  wsl: WslCliTarget | null,
): WslChannelToken | null {
  const workspaceId = input.workspaceId?.trim()
  const agentId = input.agentId?.trim()
  const identity = workspaceId && agentId ? { workspaceId, agentId, cliId: cli } : null
  if (wsl) return wsl.issueChannelToken?.(identity) ?? null
  return localLaunchToken(identity)
}

async function acpEnvironment(): Promise<NodeJS.ProcessEnv> {
  const { getTerminalEnv } = await import('../terminal-launch')
  return Object.fromEntries(
    Object.entries(getTerminalEnv()).filter(
      ([key]) => !/^(SPRINTENGINE_|MULTICODE_|CODEX_|CLAUDECODE$|ELECTRON_)/.test(key),
    ),
  )
}

/**
 * The commands an ACP CLI lists before any chat has started, published for the
 * composer's `/` menu. Only a list the agent gives in its `initialize` answer
 * is read (Grok does): opening a session just to list would leave an empty
 * chat in the CLI's own history, so Cursor and OpenCode are listed once a
 * chat's session opens. Resolves null when the CLI gives no list this way.
 */
export async function probeAcpConversationCommands(
  profile: AcpProfile,
  input: { cwd: string; cliRuntimes?: ConversationCliRuntimeOverrides },
  options: {
    detect?: () => Promise<string>
    buildEnv?: () => Promise<NodeJS.ProcessEnv>
    timeoutMs?: number
    prepareWslTarget?: (hostId: ExecutionHostId) => Promise<WslCliTarget>
    spawnChild?: typeof spawn
  } = {},
): Promise<ConversationCommand[] | null> {
  // On a WSL machine the handshake is the distribution's CLI's, asked there.
  const wsl = await wslTargetForHost(
    input.cliRuntimes?.[profile.cli]?.hostId,
    options.prepareWslTarget ?? prepareWslCliTarget,
  )
  const command = await (options.detect ?? (() => detectAcpCommand(profile, input.cliRuntimes)))()
  // Nobody asked for this start, so it runs as a check does (cli-probe-env.ts).
  const probeEnv = cliProbeEnv(profile.cli)
  const env = { ...(await (options.buildEnv ?? acpEnvironment)()), ...probeEnv }
  const sdk = await import('@agentclientprotocol/sdk')
  const wslChild = wsl ? acpWslChild(wsl, profile) : null
  const target = cliHostSpawn({
    command,
    args: profile.argv,
    cwd: input.cwd,
    env,
    wsl: wslChild ? { ...wslChild, forwardEnv: [...wslChild.forwardEnv, ...Object.keys(probeEnv)] } : null,
  })
  const child = (options.spawnChild ?? spawn)(target.file, target.args, target.options)
  child.stderr.on('data', () => undefined)
  child.stdin.on('error', () => undefined)
  const failed = new Promise<never>((_, reject) => {
    child.on('error', reject)
    child.on('close', () => reject(new Error(`${profile.displayName} exited before answering.`)))
  })
  failed.catch(() => undefined)
  // Nothing is asked of this client before a session exists; refuse anything that is.
  const refuse = async (): Promise<never> => {
    throw new Error('No conversation is open.')
  }
  const connection = new sdk.ClientSideConnection(
    () => ({
      requestPermission: refuse,
      sessionUpdate: async () => undefined,
      readTextFile: refuse,
      writeTextFile: refuse,
    }),
    sdk.ndJsonStream(Writable.toWeb(child.stdin), Readable.toWeb(child.stdout) as ReadableStream<Uint8Array>),
  )
  let timer: ReturnType<typeof setTimeout> | undefined
  try {
    const hello = await Promise.race([
      connection.initialize({
        protocolVersion: sdk.PROTOCOL_VERSION,
        clientInfo: { name: 'sprintengine-studio', version: '1' },
        clientCapabilities: { fs: { readTextFile: false, writeTextFile: false }, terminal: false },
      }),
      failed,
      new Promise<never>((_, reject) => {
        timer = setTimeout(
          () => reject(new Error(`${profile.displayName} did not answer.`)),
          options.timeoutMs ?? 10_000,
        )
      }),
    ])
    const advertised = hello._meta?.availableCommands
    if (!Array.isArray(advertised)) return null
    const commands = acpConversationCommands(advertised)
    publishConversationCommands({ cli: profile.cli, cwd: input.cwd, commands })
    return commands
  } finally {
    if (timer) clearTimeout(timer)
    child.stdin.end()
    terminateCliChild(child)
  }
}

export function createAcpConversationProvider(profile: AcpProfile, options: Options = {}): ConversationProviderAdapter {
  const sessions = new Map<string, State>()
  const modelIds = new Set<string>(['default'])
  let requestSequence = 0
  const event = (
    state: State,
    type: ConversationEvent['type'],
    payload: Record<string, unknown> = {},
  ): ConversationEvent => ({
    id: '',
    sessionId: state.input.sessionId,
    workspaceId: state.input.workspaceId,
    agentId: state.input.agentId,
    providerId: profile.id,
    modelId: state.input.modelId,
    createdAt: Date.now(),
    type,
    payload: { ...(state.turn ? { turnId: state.turn.turnId } : {}), ...payload },
  })
  const emit = (
    state: State,
    type: ConversationEvent['type'],
    payload: Record<string, unknown>,
    ready?: Promise<void>,
  ) => {
    state.lastActivityAt = Date.now()
    if (!state.loading) state.queue?.push(event(state, type, payload), ready)
  }
  const cancelPermissions = (state: State) => {
    for (const pending of state.pending.values()) pending.resolve({ outcome: { outcome: 'cancelled' } })
    state.pending.clear()
  }
  const dispose = (state: State) => {
    cancelPermissions(state)
    const child = state.child
    state.child = undefined
    state.connection = undefined
    if (child && child.exitCode === null) {
      child.stdin.end()
      terminateCliChild(child)
    }
  }
  // Stop the running turn with the protocol's own `session/cancel`, keeping
  // the process: respawning it would sign in again and reload (or, without
  // session loading, replay as a prompt) the whole conversation on the next
  // turn. The process is ended only when the cancel cannot be sent or the
  // agent has not wound the turn down within ACP_CANCEL_GRACE_MS.
  const cancelTurn = async (state: State) => {
    state.cancelled = true
    cancelPermissions(state)
    const turn = state.turn
    if (!turn) return
    if (!state.cancelWatchdog) {
      state.cancelWatchdog = setTimeout(() => {
        state.cancelWatchdog = undefined
        if (state.turn === turn) dispose(state)
      }, options.cancelGraceMs ?? ACP_CANCEL_GRACE_MS)
      state.cancelWatchdog.unref?.()
    }
    if (!state.nativeId || !state.connection) return
    await state.connection.cancel({ sessionId: state.nativeId }).catch(() => dispose(state))
  }
  const permission = (state: State, params: RequestPermissionRequest): Promise<RequestPermissionResponse> => {
    if (!state.turn || state.cancelled || state.closed || params.sessionId !== state.nativeId)
      return Promise.resolve({ outcome: { outcome: 'cancelled' } })
    const question = profile.questions ? acpQuestionRequest(params) : null
    if (question) {
      const requestId = `acp_permission_${++requestSequence}`
      const answered = new Promise<RequestPermissionResponse>((resolve) =>
        state.pending.set(requestId, { options: params.options, resolve, question: question.question }),
      )
      // A question, never a tool: no permission mode answers it for the person.
      emit(state, 'approval_requested', {
        requestId,
        kind: 'question',
        action: 'AskUserQuestion',
        input: { questions: [question] },
        toolUseId: params.toolCall.toolCallId,
        summary: question.question,
        questions: [question],
        cwd: state.input.workspaceRoot,
      })
      return answered
    }
    if (state.turn.mode === 'ask' && !['read', 'search', 'fetch'].includes(params.toolCall.kind ?? 'other'))
      return Promise.resolve({ outcome: { outcome: 'cancelled' } })
    const requestId = `acp_permission_${++requestSequence}`
    const result = new Promise<RequestPermissionResponse>((resolve) =>
      state.pending.set(requestId, { options: params.options, resolve }),
    )
    emit(state, 'approval_requested', {
      requestId,
      kind: 'tool',
      action: params.toolCall.name ?? params.toolCall.title ?? params.toolCall.kind ?? 'Tool',
      input: acpApprovalInput(params.toolCall.rawInput, params.toolCall.locations),
      toolKind: acpToolKind(params.toolCall.kind),
      toolUseId: params.toolCall.toolCallId,
      cwd: state.input.workspaceRoot,
    })
    return result
  }
  // The agent's command list, for the composer's `/` menu. ACP agents send it
  // on their own schedule — right after `session/new`, outside any turn — and
  // send it again whole when it changes, so each one replaces the last.
  const publishCommands = (state: State, available: unknown) =>
    publishConversationCommands({
      cli: profile.cli,
      cwd: state.input.workspaceRoot!,
      commands: acpConversationCommands(available),
    })
  const update = (state: State, value: SessionUpdate) => {
    // The one update read outside a turn: it describes the session, not a
    // reply, so it touches no turn state. Everything else out of turn is
    // replayed history or stray output and stays dropped.
    if (value.sessionUpdate === 'available_commands_update') return publishCommands(state, value.availableCommands)
    if (state.loading || !state.turn) return
    if (value.sessionUpdate === 'agent_message_chunk' || value.sessionUpdate === 'agent_thought_chunk') {
      if (value.content.type === 'text')
        emit(state, value.sessionUpdate === 'agent_message_chunk' ? 'content_delta' : 'reasoning_delta', {
          text: value.content.text,
        })
      if (value.sessionUpdate === 'agent_message_chunk' && value.content.type === 'text') {
        state.assistantText += value.content.text
        if (state.replyClosed) state.reply = ''
        state.replyClosed = false
        state.reply += value.content.text
      }
    } else if (value.sessionUpdate === 'tool_call' || value.sessionUpdate === 'tool_call_update') {
      const prior = state.toolCalls.get(value.toolCallId)
      // Only a new call ends the message. A call already running reports its
      // progress while the agent talks over it, and that text is one message.
      if (!prior) state.replyClosed = true
      // Kept from the update that first showed a spawn, and added to as later
      // ones fill in its input: an update may retitle the call with what the
      // agent was sent to do, which is no spawn tool's name.
      const lane = {
        ...(prior?.lane as AcpSubagentLane | undefined),
        ...acpSubagentLaneFields(value.title, value.rawInput),
      }
      // Kept from the first update too: OpenCode retitles a finished
      // `todowrite` with a count ("3 todos"), which names no todo tool.
      const todo = prior?.todo === true || acpTodoTool(value.title)
      const tool = { ...prior, ...value, ...(lane.subagentLane ? { lane } : {}), ...(todo ? { todo } : {}) }
      state.toolCalls.set(value.toolCallId, acpRememberedToolCall(tool))
      const content = value.content ?? []
      const diff = content.find((entry) => entry.type === 'diff')
      if (!prior || value.rawInput !== undefined || diff)
        emit(state, 'tool_started', {
          toolUseId: value.toolCallId,
          toolCallId: value.toolCallId,
          kind: lane.subagentLane ? 'subagent' : todo ? 'todo' : acpToolKind(tool.kind as ToolKind | undefined),
          ...lane,
          name: tool.name ?? tool.title ?? tool.kind ?? 'Tool',
          input: diff
            ? {
                ...(tool.rawInput && typeof tool.rawInput === 'object' ? tool.rawInput : {}),
                path: diff.path,
                oldText: diff.oldText ?? '',
                newText: diff.newText,
              }
            : tool.rawInput,
        })
      const output =
        value.rawOutput !== undefined && value.rawOutput !== null
          ? acpRawOutputText(value.rawOutput)
          : content
              .map((entry) =>
                entry.type === 'content' && entry.content.type === 'text'
                  ? entry.content.text
                  : entry.type === 'diff'
                    ? { path: entry.path, oldText: entry.oldText, newText: entry.newText }
                    : '',
              )
              .filter(Boolean)
      // A step's pictures (a browser screenshot), kept to show under it rather
      // than as base64 in its output; on disk before the step says where.
      const pictures = state.input.workspaceRoot ? acpToolResultImages(content, value.rawOutput) : []
      const write = pictures.length
        ? (options.saveToolImages ?? saveToolResultImages)({
            key: {
              workspaceRoot: state.input.workspaceRoot!,
              workspaceId: state.input.workspaceId,
              agentId: state.input.agentId,
            },
            toolUseId: value.toolCallId,
            images: pictures,
          })
        : null
      if (
        value.status === 'completed' ||
        value.status === 'failed' ||
        value.rawOutput !== undefined ||
        content.length
      ) {
        const payload: Record<string, unknown> = {
          toolUseId: value.toolCallId,
          toolCallId: value.toolCallId,
          output,
          status: value.status === 'failed' ? 'error' : value.status === 'completed' ? 'success' : 'running',
          isError: value.status === 'failed',
          partial: value.status !== 'completed' && value.status !== 'failed',
        }
        // The same list, which the write trims of any file it could not make.
        if (write) payload.images = write.paths
        emit(
          state,
          'tool_output',
          payload,
          write?.written.then(() => {
            if (!write.paths.length) delete payload.images
          }),
        )
      }
    } else if (value.sessionUpdate === 'plan') {
      state.replyClosed = true
      const toolUseId = `plan_${state.turn.turnId}`
      emit(state, 'tool_started', {
        toolUseId,
        toolCallId: toolUseId,
        kind: 'todo',
        name: 'Plan',
        input: { todos: value.entries.map((entry) => ({ content: entry.content, status: entry.status })) },
      })
      emit(state, 'tool_output', { toolUseId, toolCallId: toolUseId, output: '', status: 'success' })
    } else if (value.sessionUpdate === 'usage_update') {
      emit(state, 'usage_updated', {
        contextWindow: value.size,
        contextUsed: value.used,
        ...(value.cost?.currency === 'USD' ? { costUsd: value.cost.amount } : {}),
      })
    }
  }
  // The agent's session mode for a turn: the chat's own (Plan) when it chose
  // one, else the mode the permission preset puts the agent in, else the one
  // the agent opened the session in. Set before every turn, so a session
  // reloaded in another mode, or switched from inside it, is put back.
  const applySessionMode = async (state: State, turnMode: MockAdapterTurnInput['mode']) => {
    const presetMode = acpPresetSessionMode(profile, state.input.permissionPreset, state.input.permissionMode)
    if (!turnMode && !state.defaultMode && !presetMode) return
    const desired = !turnMode || turnMode === 'default' ? (presetMode ?? state.defaultMode) : turnMode
    // Worded as a refusal of the preset, so the runtime can start the chat
    // again with no preset rather than leave it unable to answer.
    if (desired && desired === presetMode && !state.modes.includes(desired))
      throw new Error(
        `The ${desired} session mode this permission preset runs in is not supported by this ${profile.displayName} build.`,
      )
    if (!desired || !state.modes.includes(desired)) throw new Error('This mode is unavailable from the ACP agent.')
    if (state.modeConfigId)
      await state.connection!.setSessionConfigOption({
        sessionId: state.nativeId!,
        configId: state.modeConfigId,
        value: desired,
      })
    else await state.connection!.setSessionMode({ sessionId: state.nativeId!, modeId: desired })
  }
  const environment = async (input: MockAdapterSessionInput): Promise<NodeJS.ProcessEnv> =>
    (options.buildEnv ?? acpEnvironment)(input)
  const ensure = async (state: State) => {
    if (state.connection) return
    if (state.starting) return state.starting
    state.starting = (async () => {
      // A chat on a WSL machine runs that machine's CLI, with the login and
      // configuration under its Linux home; everything below is the same.
      const wsl = await wslTargetForHost(
        state.input.cliRuntimes?.[profile.cli]?.hostId,
        options.prepareWslTarget ?? prepareWslCliTarget,
      )
      if (state.closed) throw new Error('Conversation was stopped during startup.')
      const command = await (options.detect ?? ((input) => detectAcpCommand(profile, input.cliRuntimes)))(state.input)
      const env = await environment(state.input)
      // A JSON document the preset sets (OpenCode's config content) joins the
      // person's own rather than replacing it. In WSL the chat is handed the
      // preset's variables alone, nothing of this PC's (acpWslChild).
      for (const [key, value] of Object.entries(
        acpLaunchEnv(profile, state.input.permissionPreset, state.input.permissionMode),
      ))
        env[key] = wsl ? value : mergeJsonEnvValue(env[key], value)
      const hostId = state.input.cliRuntimes?.[profile.cli]?.hostId
      const gateway = await options.resolveStudioMcpServer?.({ ...(hostId ? { hostId } : {}) }).catch(() => null)
      if (state.closed) throw new Error('Conversation was stopped during startup.')
      const sdk = await import('@agentclientprotocol/sdk')
      if (state.closed) throw new Error('Conversation was stopped during startup.')
      // The child is issued its own gateway token, bound to this chat, and
      // taken back when it ends: on stdin in WSL, where it is also the channel
      // token, and in its environment here. The gateway entry the session is
      // opened with carries the same value (openSession).
      const launch = acpLaunchToken(state.input, profile.cli, wsl)
      const child = spawnCliHostChild(
        {
          command,
          args: acpLaunchArgv(profile, state.input.permissionPreset, state.input.permissionMode),
          cwd: state.input.workspaceRoot ?? '',
          env,
          wsl: wsl ? acpWslChild(wsl, profile, state.input.permissionPreset, state.input.permissionMode) : null,
          launch,
        },
        { spawn: options.spawnChild ?? spawn },
      )
      state.child = child
      state.spawnedAt = Date.now()
      // The end of what the CLI printed, kept for the message of a start or a
      // turn it ends: a build that refuses a permission flag says so here and
      // only here, and that sentence is what lets the runtime start the chat
      // again with no flag (`looksLikePermissionSettingRefusal`).
      let stderrTail = ''
      child.stderr.on('data', (data: Buffer | string) => {
        stderrTail = `${stderrTail}${data.toString()}`.slice(-STDERR_TAIL_CHARS)
      })
      const childClosed = new Promise<void>((resolve) => child.once('close', () => resolve()))
      // A CLI that cannot be started is reported as that, not as a protocol
      // failure followed by a sign-in hint that would send the person the
      // wrong way. Later errors close the stream, which rejects what is pending.
      let spawnError: Error | undefined
      const spawnFailed = new Promise<never>((_, reject) =>
        child.on('error', (error) => {
          if (child.pid !== undefined) return
          spawnError = error
          reject(error)
        }),
      )
      spawnFailed.catch(() => undefined)
      child.stdin.on('error', () => undefined)
      child.on('close', () => {
        if (state.child !== child) return
        state.child = undefined
        state.connection = undefined
        cancelPermissions(state)
        if (state.queue) {
          emit(state, 'turn_failed', { message: withStderrTail(`${profile.displayName} process exited.`, stderrTail) })
          state.queue.end()
        }
      })
      // The bytes since the last newline: only the chunk's first and last
      // newline matter, found natively rather than by walking every byte.
      let frameBytes = 0
      const boundedInput = (Readable.toWeb(child.stdout) as ReadableStream<Uint8Array>).pipeThrough(
        new TransformStream<Uint8Array, Uint8Array>({
          transform(chunk, controller) {
            const first = chunk.indexOf(10)
            const oversized =
              first < 0 ? frameBytes + chunk.length > MAX_FRAME_BYTES : frameBytes + first > MAX_FRAME_BYTES
            frameBytes = first < 0 ? frameBytes + chunk.length : chunk.length - chunk.lastIndexOf(10) - 1
            if (oversized) {
              dispose(state)
              throw new Error('ACP protocol frame exceeds the size limit.')
            }
            controller.enqueue(chunk)
          },
        }),
      )
      const connection = new sdk.ClientSideConnection(
        () => ({
          // A child that has been replaced (a permission change relaunches it)
          // can still be flushing what it said last; none of it belongs to the
          // turn its replacement is running.
          requestPermission: (params) =>
            state.child === child ? permission(state, params) : Promise.resolve({ outcome: { outcome: 'cancelled' } }),
          sessionUpdate: async (params) => {
            if (state.child !== child) return
            if (params.sessionId === state.nativeId || state.loading) update(state, params.update)
          },
          readTextFile: async (params) => {
            if (!state.turn || params.sessionId !== state.nativeId) throw new Error('No active conversation turn.')
            const path = await confinedAcpPath(
              state.input.workspaceRoot!,
              acpClientPath(params.path, state.input.workspaceRoot!, wsl),
            )
            const file = await openConfinedExistingFile(state.input.workspaceRoot!, path)
            try {
              if ((await file.stat()).size > 2 * 1024 * 1024)
                throw new Error('File exceeds the conversation read limit.')
              const content = (await readBoundedConversationFile(file, 2 * 1024 * 1024)).toString('utf8')
              if (content.includes('\0')) throw new Error('Binary files are not supported.')
              const lines = content.split('\n'),
                start = Math.max(0, (params.line ?? 1) - 1)
              return {
                content:
                  params.line || params.limit
                    ? lines.slice(start, params.limit ? start + params.limit : undefined).join('\n')
                    : content,
              }
            } finally {
              await file.close()
            }
          },
          writeTextFile: async (params) => {
            if (!state.turn || params.sessionId !== state.nativeId) throw new Error('No active conversation turn.')
            if (state.turn.mode === 'ask' || state.turn.mode === 'plan')
              throw new Error('This conversation mode is read-only.')
            if (Buffer.byteLength(params.content) > 2 * 1024 * 1024)
              throw new Error('File exceeds the conversation write limit.')
            const requested = acpClientPath(params.path, state.input.workspaceRoot!, wsl)
            const path = await confinedAcpPath(state.input.workspaceRoot!, requested, true)
            // Creating through an unanchored parent path can escape after a
            // directory swap, even with O_NOFOLLOW. Native CLI tools may create
            // files under their own policy; this callback edits existing files.
            // That is checked before asking, so an approval is never spent on a
            // write that cannot happen, and the current text becomes the
            // before side of the change the person is asked to approve.
            const openExisting = (access: 'read' | 'write') =>
              openConfinedExistingFile(state.input.workspaceRoot!, path, access).catch((error) => {
                if ((error as NodeJS.ErrnoException).code === 'ENOENT')
                  throw new Error(
                    'Conversation file callbacks can edit existing files only. Use the native CLI file tool to create a file.',
                  )
                throw error
              })
            const current = await openExisting('read')
            let oldText: string | undefined
            try {
              if ((await current.stat()).size <= WRITE_PREVIEW_BYTES) {
                const text = (await readBoundedConversationFile(current, WRITE_PREVIEW_BYTES)).toString('utf8')
                if (!text.includes('\0')) oldText = text
              }
            } finally {
              await current.close()
            }
            const preview =
              oldText !== undefined && Buffer.byteLength(params.content) <= WRITE_PREVIEW_BYTES
                ? { oldText, newText: params.content }
                : { bytes: Buffer.byteLength(params.content) }
            const decision = await permission(state, {
              sessionId: params.sessionId,
              toolCall: {
                toolCallId: `write_${++requestSequence}`,
                kind: 'edit',
                name: 'Write',
                rawInput: { path, ...preview },
              },
              options: [{ optionId: 'once', name: 'Allow once', kind: 'allow_once' }],
            })
            if (decision.outcome.outcome !== 'selected') throw new Error('File write was not approved.')
            await state.input.onBeforeTool?.('Write')
            await confinedAcpPath(state.input.workspaceRoot!, requested, true)
            const file = await openExisting('write')
            try {
              await file.truncate(0)
              await file.writeFile(params.content, 'utf8')
            } finally {
              await file.close()
            }
          },
        }),
        sdk.ndJsonStream(Writable.toWeb(child.stdin), boundedInput),
      )
      const initialize = async () => {
        const hello = await connection.initialize({
          protocolVersion: sdk.PROTOCOL_VERSION,
          clientInfo: { name: 'sprintengine-studio', version: '1' },
          clientCapabilities: { fs: { readTextFile: true, writeTextFile: true }, terminal: false },
        })
        if (hello.protocolVersion !== sdk.PROTOCOL_VERSION) throw new Error('ACP protocol version is incompatible.')
        // Grok lists its commands in the handshake, before any session.
        const advertised = hello._meta?.availableCommands
        if (Array.isArray(advertised)) publishCommands(state, advertised)
        state.loadSupported = hello.agentCapabilities?.loadSession === true
        state.forkSupported = Boolean(hello.agentCapabilities?.sessionCapabilities?.fork)
        state.mcpCapabilities = hello.agentCapabilities?.mcpCapabilities ?? undefined
        state.capabilities = {
          ...baseCapabilities(profile),
          resume: state.loadSupported,
          images: hello.agentCapabilities?.promptCapabilities?.image === true,
        }
        if (profile.authenticate && hello.authMethods?.some((method) => method.id === profile.authenticate))
          await connection.authenticate({ methodId: profile.authenticate })
        // Replayed history is suppressed while loading. The flag must drop on
        // every exit, or the failure this startup reports is suppressed too
        // and the turn that triggered a reload never receives a terminal event.
        state.loading = true
        try {
          await openSession(connection)
        } finally {
          state.loading = false
        }
        if (state.closed || state.child !== child || child.exitCode !== null)
          throw new Error('Conversation was stopped during startup.')
        state.connection = connection
      }
      const openSession = async (connection: ClientSideConnection) => {
        const resumeId = state.nativeId ?? state.input.resumeSessionId
        state.replayHistory = Boolean(resumeId && !state.loadSupported) || state.seedPending
        // The app's gateway and the session's own servers, on a new session
        // and a reopened one alike. ACP names a server's environment outright,
        // so the gateway's entry carries this child's token itself: it travels
        // in the request, on the child's stdin, and is never on a command line
        // or in a file. Under the name a terminal launch pins the gateway into
        // the workspace's config with, so an agent that also reads that file
        // runs the session's in its place.
        const servers = withStudioGateway(
          gateway
            ? studioGatewayForChat(
                gateway,
                { workspaceId: state.input.workspaceId, agentId: state.input.agentId, cli: profile.cli },
                launch ? { value: launch.token } : null,
              )
            : null,
          state.input.mcpServers ?? [],
        )
        const mcpServers = acpMcpServers(
          wsl ? mcpServersOnWsl(servers) : servers,
          state.mcpCapabilities,
          profile.displayName,
          { wsl: wsl !== null },
        )
        // The folder as the agent names it: the Linux spelling in WSL.
        const cwd = wsl ? toWslPath(state.input.workspaceRoot!) : state.input.workspaceRoot!
        state.opened = { cwd, mcpServers }
        const fresh = () => connection.newSession({ cwd, mcpServers })
        let session: Awaited<ReturnType<typeof fresh>> | Awaited<ReturnType<ClientSideConnection['loadSession']>>
        if (resumeId && state.loadSupported) {
          try {
            session = await connection.loadSession({ sessionId: resumeId, cwd, mcpServers })
          } catch (error) {
            // The agent answered that it cannot load this session (it was
            // deleted, or the cursor came from another machine). Asking again
            // would fail on every turn, so continue in a new session, carry the
            // conversation over as context, and say so. Any other answer (the
            // session is busy, a rate limit, an internal error) and a request
            // that was never answered fail this turn and keep the id, since
            // the session may still be there to reopen next time.
            if (!isMissingSessionError(error)) throw error
            session = await fresh()
            state.replayHistory = true
            state.resumeNotice = `${profile.displayName} could not reopen its previous session, so this conversation continues in a new one. The earlier messages were passed to it as context.`
          }
        } else session = await fresh()
        state.nativeId = 'sessionId' in session ? String(session.sessionId) : resumeId
        state.modes = session.modes?.availableModes.map((mode) => mode.id) ?? []
        state.defaultMode = session.modes?.currentModeId
        const modeConfig = session.configOptions?.find((option) => option.category === 'mode')
        state.modeConfigId = modeConfig?.id
        if (!state.modes.length && modeConfig && 'options' in modeConfig) {
          state.modes = modeConfig.options.flatMap((option) =>
            'value' in option ? [option.value] : option.options.map((entry) => entry.value),
          )
          state.defaultMode = modeConfig.currentValue
        }
        state.capabilities.planMode = state.modes.includes('plan')
        const modelConfig = session.configOptions?.find((option) => option.category === 'model')
        state.modelConfigId = modelConfig?.id
        state.defaultModelValue =
          modelConfig && 'currentValue' in modelConfig ? String(modelConfig.currentValue) : undefined
        state.appliedModelId = state.input.modelId
        if (modelConfig && 'options' in modelConfig) {
          for (const option of modelConfig.options) {
            for (const id of 'value' in option ? [option.value] : option.options.map((entry) => entry.value))
              modelIds.add(id)
          }
        }
        if (state.input.modelId !== 'default') {
          if (modelConfig)
            await selectModel(profile.displayName, state.input.modelId, () =>
              connection.setSessionConfigOption({
                sessionId: state.nativeId!,
                configId: modelConfig.id,
                value: state.input.modelId,
              }),
            )
          else throw new Error('This ACP agent does not expose model selection. Choose the default model.')
        }
      }
      let timer: ReturnType<typeof setTimeout> | undefined
      try {
        await Promise.race([
          initialize(),
          spawnFailed,
          new Promise<never>((_, reject) => {
            timer = setTimeout(() => reject(new Error('ACP startup timed out.')), options.startupTimeoutMs ?? 30_000)
          }),
        ])
      } catch (error) {
        dispose(state)
        if (child.pid === undefined) {
          if (!options.detect) forgetAcpCommand(profile)
          throw new Error(
            `${profile.displayName} could not be started from ${command}: ${spawnError?.message ?? 'the process did not start.'}`,
          )
        }
        // Not a sign-in problem, so without the sign-in hint.
        if (error instanceof AcpMcpServerUnsupportedError || error instanceof AcpModelSelectionError) throw error
        // What it printed as it went is all read once it has closed.
        await Promise.race([childClosed, new Promise((resolve) => setTimeout(resolve, 250))])
        const message = withStderrTail(error instanceof Error ? error.message : String(error), stderrTail)
        throw new Error(`${message} ${profile.authHint}`)
      } finally {
        if (timer) clearTimeout(timer)
      }
    })().finally(() => {
      state.starting = undefined
    })
    return state.starting
  }
  return {
    id: profile.id,
    displayName: profile.displayName,
    executionHostCli: profile.cli,
    capabilities: baseCapabilities(profile),
    sessions: 'stateful',
    acceptsMcpServers: true,
    listModels: () => Array.from(modelIds),
    async startSession(input) {
      const refused = input.permissionPreset ? presetRefusal(profile, input.permissionPreset) : null
      // Marked, so the runtime knows this is the preset's refusal (Cursor's
      // Manual) and may start the chat again with no flag.
      if (refused) throw Object.assign(new Error(refused), { permissionRefused: true })
      const state: State = {
        input,
        closed: false,
        loading: false,
        loadSupported: false,
        forkSupported: false,
        cancelled: false,
        pending: new Map(),
        toolCalls: new Map(),
        lastActivityAt: Date.now(),
        spawnedAt: null,
        capabilities: baseCapabilities(profile),
        modes: [],
        history: [],
        replayHistory: false,
        seedPending: input.seedFromHistory === true,
        assistantText: '',
        reply: '',
        replyClosed: false,
      }
      sessions.set(input.sessionId, state)
      try {
        await ensure(state)
      } catch (error) {
        sessions.delete(input.sessionId)
        throw error
      }
      const notice = state.resumeNotice
      state.resumeNotice = undefined
      return [
        event(state, 'session_started', { providerSessionId: state.nativeId, capabilities: state.capabilities }),
        ...(notice ? [event(state, 'session_updated', { providerSessionId: state.nativeId, notice })] : []),
      ]
    },
    async sendTurn(input) {
      const state = sessions.get(input.sessionId)
      if (!state || state.closed) throw new Error('ACP session is unavailable.')
      // A stopped turn the agent is still winding down is over from the
      // person's side: wait for it (the watchdog bounds the wait).
      if (state.turn && state.cancelled) await state.turnEnded
      if (state.closed) throw new Error('ACP session is unavailable.')
      if (state.turn) throw new Error('ACP turn is already active.')
      const queue = new Queue()
      let turnEnded = () => {}
      state.turnEnded = new Promise<void>((resolve) => {
        turnEnded = resolve
      })
      state.queue = queue
      state.turn = input
      state.cancelled = false
      state.assistantText = ''
      state.reply = ''
      state.replyClosed = false
      const abort = () => void cancelTurn(state)
      input.signal?.addEventListener('abort', abort, { once: true })
      void (async () => {
        try {
          // Turned away here, before any child is asked: marked `refused`, so
          // the runtime does not read it as the CLI refusing its permission
          // flag and send the command again with no flag, where it is allowed.
          const refusal = permissionCommandRefusal(profile, state.input.permissionPreset, input.message)
          if (refusal) {
            emit(state, 'turn_failed', { message: refusal, refused: true })
            return
          }
          const previousId = state.nativeId
          await ensure(state)
          // A reconnect can land in a different session; record it as the
          // resume cursor, or the next restart would try the old one again.
          if (state.nativeId !== previousId || state.resumeNotice) {
            const notice = state.resumeNotice
            state.resumeNotice = undefined
            emit(state, 'session_updated', { providerSessionId: state.nativeId, ...(notice ? { notice } : {}) })
          }
          if (input.signal?.aborted || state.cancelled) throw new Error('interrupted')
          // A model switched since the session last ran lands here, before the
          // prompt, so this turn is the first on the new model.
          if (state.input.modelId !== state.appliedModelId) {
            const value = state.input.modelId === 'default' ? state.defaultModelValue : state.input.modelId
            if (!state.modelConfigId || !value)
              throw new Error('This ACP agent does not expose model selection. Choose the default model.')
            const configId = state.modelConfigId
            await selectModel(profile.displayName, state.input.modelId, () =>
              state.connection!.setSessionConfigOption({ sessionId: state.nativeId!, configId, value }),
            )
            state.appliedModelId = state.input.modelId
          }
          await applySessionMode(state, input.mode)
          await state.input.onBeforeTool?.('ACP agent turn')
          emit(state, 'turn_started', { providerSessionId: state.nativeId })
          // A slash command runs only from the start of the prompt, so the
          // replayed conversation waits for the next message rather than
          // pushing the command off it and into prose.
          const command = leadingCommandFor(input.message, { cli: profile.cli, cwd: state.input.workspaceRoot })
          const prior =
            state.replayHistory && !command
              ? [
                  ...(state.input.fallbackHistory ?? []).map((message) => `${message.role}: ${message.content}`),
                  ...state.history.map((turn) => `User: ${turn.user}\nAssistant: ${turn.assistant}`),
                ].join('\n\n')
              : ''
          const prompt: Parameters<ClientSideConnection['prompt']>[0]['prompt'] = [
            {
              type: 'text',
              text: prior ? `Previous conversation:\n${prior}\n\nUser: ${input.message}` : input.message,
            },
          ]
          const seeding = Boolean(prior)
          if (input.attachments?.length && !state.capabilities.images)
            throw new Error('This ACP agent does not support images.')
          for (const attachment of input.attachments ?? [])
            prompt.push({ type: 'image', data: attachment.dataBase64, mimeType: attachment.mediaType })
          // A Stop that landed while the model, the mode or the checkpoint was
          // being set reached an agent with no prompt to cancel. Sent now, the
          // prompt would run on until the watchdog ended the process.
          if (input.signal?.aborted || state.cancelled) {
            emit(state, 'turn_failed', { reason: 'interrupted' })
            return
          }
          const result = await state.connection!.prompt({ sessionId: state.nativeId!, prompt })
          // The agent has the conversation now. Until it answered the prompt
          // (a refused image, an agent that died on it) the conversation is
          // owed still, to the next message and after a restart too, as Codex
          // owes it until its turn starts.
          if (!command) {
            state.replayHistory = false
            state.seedPending = false
          }
          if (seeding) emit(state, 'session_updated', { historySeeded: true })
          if (result.usage)
            emit(state, 'usage_updated', {
              inputTokens: result.usage.inputTokens,
              outputTokens: result.usage.outputTokens,
            })
          const stopped = state.cancelled || result.stopReason === 'cancelled'
          const transportFailure =
            profile.cli === 'cursor' && !stopped ? cursorTransportFailure(state.assistantText) : undefined
          if (transportFailure) {
            emit(state, 'turn_failed', { message: transportFailure })
            return
          }
          if (!stopped) state.history.push({ user: input.message, assistant: state.assistantText })
          // What the turn spent, as the agent's own protocol counts it.
          const usage = result.usage
            ? turnUsageOf({
                inputTokens: result.usage.inputTokens,
                outputTokens: result.usage.outputTokens,
                cacheReadTokens: result.usage.cachedReadTokens ?? undefined,
                cacheWriteTokens: result.usage.cachedWriteTokens ?? undefined,
              })
            : null
          const reply = state.reply.trim() ? state.reply : ''
          emit(
            state,
            stopped ? 'turn_failed' : 'turn_completed',
            stopped
              ? { reason: 'interrupted' }
              : {
                  stopReason: result.stopReason,
                  ...(reply ? { text: reply } : {}),
                  ...(usage ? { usage } : {}),
                },
          )
        } catch (error) {
          emit(state, 'turn_failed', {
            message: state.cancelled ? 'interrupted' : error instanceof Error ? error.message : String(error),
          })
        } finally {
          input.signal?.removeEventListener('abort', abort)
          cancelPermissions(state)
          if (state.cancelWatchdog) clearTimeout(state.cancelWatchdog)
          state.cancelWatchdog = undefined
          // The turn's tool calls (diffs included) are only needed while it runs.
          state.toolCalls.clear()
          state.turn = undefined
          state.queue = undefined
          // A preset chosen while this turn ran is a launch flag: the child it
          // ran in is replaced now, once nothing it still says can reach a
          // turn, and the next turn reloads the session under the new flags.
          if (state.relaunch) {
            state.relaunch = false
            dispose(state)
          }
          queue.end()
          turnEnded()
        }
      })()
      return queue
    },
    resolveApproval(input) {
      const state = sessions.get(input.sessionId),
        pending = state?.pending.get(input.requestId)
      if (!state || !pending) return []
      // A question is answered with the option its answer names, and skipped
      // (its reject option) when declined or answered with anything else.
      const answer = pending.question === undefined ? undefined : input.answers?.[pending.question]
      const selected =
        pending.question === undefined
          ? pending.options.find((option) => option.kind === (input.approved ? 'allow_once' : 'reject_once'))
          : (input.approved &&
              pending.options.find((option) => option.kind === 'allow_once' && option.name === answer)) ||
            pending.options.find((option) => option.kind === 'reject_once')
      // Never convert a once-only approval into an agent-wide persistent grant.
      pending.resolve(
        selected
          ? { outcome: { outcome: 'selected', optionId: selected.optionId } }
          : { outcome: { outcome: 'cancelled' } },
      )
      state.pending.delete(input.requestId)
      const answered = pending.question !== undefined && selected?.kind === 'allow_once'
      return [
        event(state, 'approval_resolved', {
          requestId: input.requestId,
          approved: pending.question === undefined ? input.approved && Boolean(selected) : answered,
          ...(answered ? { answers: { [pending.question!]: selected!.name } } : {}),
        }),
      ]
    },
    // ACP's `session/fork` branches a session as it stands now and names no
    // point inside it, so it is used only for a fork made at the newest reply,
    // and only on the chat's own running agent: the branch is made now, while
    // the parent's session still ends there, and the fork's child opens it
    // with `session/load` (an agent that cannot load could not reopen it).
    // Anything else, or a branch the agent refuses, starts the fork in a new
    // session handed the conversation as text.
    async fork(input) {
      const state = sessions.get(input.sessionId)
      const connection = state?.connection
      if (
        !input.latest ||
        !state ||
        !connection ||
        !state.nativeId ||
        !state.opened ||
        state.turn ||
        state.closed ||
        !state.forkSupported ||
        !state.loadSupported ||
        // A session still owed the conversation (a seeded fork not yet sent a
        // message, a reload that fell back to a new session) holds none of it:
        // a branch of it would be just as empty.
        state.replayHistory ||
        state.seedPending
      )
        return { ok: true, cursor: null }
      try {
        // Without the gateway: its entry carries this chat's token, and the
        // branch is another chat's, whose own child opens it with its own.
        const branched = await connection.unstable_forkSession({
          sessionId: state.nativeId,
          cwd: state.opened.cwd,
          mcpServers: state.opened.mcpServers.filter((server) => !isStudioGatewayName(server.name)),
        })
        return { ok: true, cursor: { sessionId: String(branched.sessionId), at: null } }
      } catch {
        return { ok: true, cursor: null }
      }
    },
    // The model is the agent's session config option. It is recorded here and
    // applied at the start of the next turn (sendTurn), so a turn already
    // running keeps the model it started with and a respawn starts on the new
    // one (initialize applies `input.modelId`).
    async setModel(input) {
      const state = sessions.get(input.sessionId)
      if (!state) return { ok: false, message: 'ACP session is unavailable.' }
      state.input = { ...state.input, modelId: input.nextModelId }
      return state.turn
        ? {
            ok: true,
            notice: 'The new model starts with your next message — this reply finishes on the model it started with.',
          }
        : { ok: true }
    },
    // A preset that is a launch flag (or a launch environment) replaces the
    // child: the next turn starts a new one under the new flags and reloads
    // this session. A turn already running finishes in the child it started
    // in, and the runtime answers what it still asks by the new mode.
    async setPermissionPreset(input) {
      const state = sessions.get(input.sessionId)
      if (!state) return { ok: false, message: 'ACP session is unavailable.' }
      const refused = presetRefusal(profile, input.permissionPreset)
      if (refused) return { ok: false, message: refused }
      const before = { preset: state.input.permissionPreset, mode: state.input.permissionMode }
      state.input.permissionPreset = input.permissionPreset
      if (input.permissionMode) state.input.permissionMode = input.permissionMode
      else delete state.input.permissionMode
      // A preset told as a session mode alone (Kimi Code's) keeps the process:
      // the next turn sets the mode, and a turn running in the preset's mode
      // (not Plan) is moved to it now, so its next tool call is decided by it.
      if (
        !state.relaunch &&
        sameAcpLaunch(profile, before, { preset: input.permissionPreset, mode: input.permissionMode })
      ) {
        const turn = state.turn
        if (!turn || !state.connection || !state.nativeId || (turn.mode && turn.mode !== 'default')) return { ok: true }
        try {
          await applySessionMode(state, turn.mode)
          return { ok: true }
        } catch {
          return { ok: true, notice: `${profile.displayName} takes the new permissions from your next message.` }
        }
      }
      if (state.turn && (state.child || state.starting)) {
        state.relaunch = true
        return { ok: true, notice: `${profile.displayName} takes the new permissions from your next message.` }
      }
      dispose(state)
      return { ok: true }
    },
    async interrupt(input) {
      const state = sessions.get(input.sessionId)
      if (state) await cancelTurn(state)
      return []
    },
    stopSession(input) {
      const state = sessions.get(input.sessionId)
      if (!state) return []
      state.closed = true
      dispose(state)
      sessions.delete(input.sessionId)
      return []
    },
    disposeAll() {
      for (const state of sessions.values()) {
        state.closed = true
        dispose(state)
      }
      sessions.clear()
    },
    // A running turn keeps its process, except one already stopped: Settle
    // and Snooze interrupt and then dispose straight away, before the agent
    // has answered the cancel, and the process has nothing left to do.
    // `force` ends it whatever it is doing; its pending cards are cancelled.
    disposeChildProcess(sessionId, options) {
      const state = sessions.get(sessionId)
      if (!state) return false
      if (!options?.force && ((state.turn && !state.cancelled) || state.pending.size)) return false
      dispose(state)
      return true
    },
    listLiveSessions() {
      return Array.from(sessions.values(), (state) => ({
        sessionId: state.input.sessionId,
        workspaceId: state.input.workspaceId,
        agentId: state.input.agentId,
        workspaceRoot: state.input.workspaceRoot!,
        providerSessionId: state.nativeId ?? null,
        hasChildProcess: Boolean(state.child),
        childPid: state.child?.pid ?? null,
        turnActive: Boolean(state.turn),
        pendingApproval: state.pending.size > 0,
        lastActivityAt: state.lastActivityAt,
        spawnedAt: state.spawnedAt,
      }))
    },
  }
}

/** The agent answered `session/load` that the session does not exist, rather than that it cannot be opened now. */
function isMissingSessionError(error: unknown): boolean {
  const { code, message, data } = (error ?? {}) as { code?: unknown; message?: unknown; data?: unknown }
  if (typeof code !== 'number') return false
  // JSON-RPC "resource not found".
  if (code === -32002) return true
  let detail = ''
  try {
    detail = data === undefined ? '' : JSON.stringify(data)
  } catch {
    // Unserializable detail says nothing about the session.
  }
  return /not found|no such session|unknown session|does not exist|invalid session/i.test(
    `${typeof message === 'string' ? message : ''} ${detail}`,
  )
}

// What an agent in WSL holds for itself and hands on to the servers it starts.
const WSL_CHILD_OWNED_ENV: ReadonlySet<string> = new Set([
  MCP_CHANNEL_TOKEN_ENV,
  ...AGENT_IDENTITY_ENV_KEYS,
  ...CONVERSATION_IDENTITY_ENV_KEYS,
])

/** An MCP server this agent cannot connect to; see acpMcpServers. */
class AcpMcpServerUnsupportedError extends Error {}

/** An agent refused the model the chat asked it for. */
class AcpModelSelectionError extends Error {}

// A model id the chat stored can stop being one the agent offers: retired,
// renamed, or no longer on the account. The agent refuses it with JSON-RPC's
// invalid params, which on its own read "Invalid params", and at startup came
// with the sign-in hint, as if signing in again would help. Said instead as the
// model it is, so the person picks another. Any other failure keeps its own.
async function selectModel(agent: string, modelId: string, write: () => Promise<unknown>): Promise<void> {
  try {
    await write()
  } catch (error) {
    if ((error as { code?: unknown } | null)?.code === -32602)
      throw new AcpModelSelectionError(
        `${agent} did not accept the model "${modelId}". Choose another model, then send your message again.`,
      )
    throw error
  }
}

/**
 * A session's MCP servers as ACP's `session/new` takes them. Every agent takes
 * a stdio server; HTTP and SSE only when its handshake says so, and a server
 * it cannot take refuses the start rather than being left out. ACP names an
 * environment explicitly, so the variables a server's entry names
 * (`envVarNames`) are read from this app's own environment here, as is an
 * HTTP server's bearer token.
 *
 * Not for an agent in WSL, though, where the gateway's channel token and the
 * chat's identity are the child's own (issued to it at spawn, carried in by
 * `forwardEnv`) and inherited by what it starts: a value this app's process
 * happens to hold would only override them with a stale or foreign one.
 */
export function acpMcpServers(
  servers: readonly ConversationMcpServer[],
  capabilities: McpCapabilities | undefined,
  agentName: string,
  options: { wsl?: boolean } = {},
): McpServer[] {
  const hostValue = (name: string): string | undefined =>
    options.wsl && WSL_CHILD_OWNED_ENV.has(name) ? undefined : process.env[name]
  const fromEnv = (names: readonly string[] | undefined) =>
    (names ?? []).flatMap((name) => {
      const value = hostValue(name)
      return value ? [{ name, value }] : []
    })
  return servers.map((server): McpServer => {
    if (server.transport === 'stdio') {
      return {
        name: server.id,
        command: server.command ?? '',
        args: server.args ?? [],
        env: [
          ...Object.entries(server.env ?? {}).map(([name, value]) => ({ name, value })),
          ...fromEnv(server.envVarNames),
        ],
      }
    }
    if (!capabilities?.[server.transport]) {
      throw new AcpMcpServerUnsupportedError(
        `${agentName} does not connect to ${server.transport.toUpperCase()} MCP servers, so it cannot run with "${server.name || server.id}". Choose a CLI whose chats can, such as Claude Code or Codex.`,
      )
    }
    const headers = Object.entries(server.headers ?? {}).map(([name, value]) => ({ name, value }))
    const token = server.envVarNames?.[0] ? hostValue(server.envVarNames[0]) : undefined
    if (token && !headers.some((header) => header.name.toLowerCase() === 'authorization'))
      headers.push({ name: 'Authorization', value: `Bearer ${token}` })
    return { type: server.transport, name: server.id, url: server.url ?? '', headers }
  })
}
