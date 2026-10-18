import type { StudioErrorCode } from './envelope.js'
import { STUDIO_CLIENT_TOOLS_CAPABILITY } from './handshake.js'
import { parseStudioConversationKey, type StudioConversationKey } from './key.js'
import type { StudioScope } from './scopes.js'

// Client tools: a client offers Studio named toolsets, Studio lists their
// tools to its agents through the MCP gateway they already reach, and a call
// an agent makes is sent to the client that offered the tool and answered
// with what that client replies. Studio never runs a client tool's logic: it
// checks who may see the tool, picks the client, holds the deadline and the
// size limits, forwards a cancellation, and audits.
//
// The same mechanism carries the desktop's own browser and canvas, which is
// why the built-in toolset names are reserved for a client Studio knows is its
// own shell, and a third-party app (a game offering `spawn_enemy`) offers its
// tools exactly as the desktop does.
//
// All of this is additive within protocol version 1, behind the
// `client-tools` capability. A client that never offers is never sent a
// `call`, and a client only sends `reply` or `progress` to a Studio that
// advertised the capability, so neither end is handed a frame it does not know.

// ── Names ───────────────────────────────────────────────────────────────────

/**
 * A toolset name: lowercase, starting with a letter, no underscore. MCP
 * clients that do not take a dot in a tool name write `<toolset>_<tool>`, and
 * with no underscore in the toolset that splits at its first `_` one way only.
 */
export const STUDIO_TOOLSET_NAME_PATTERN = /^[a-z][a-z0-9-]{1,15}$/
/** A tool's own name within its toolset. */
export const STUDIO_TOOL_NAME_PATTERN = /^[a-z][a-z0-9_]{0,31}$/

/**
 * The toolsets a Studio's own shell offers. Only a connection Studio knows is
 * its shell may offer one; every other client is refused `reserved_name`.
 */
export const STUDIO_BUILT_IN_TOOLSETS = ['browser', 'canvas', 'editor', 'tour', 'terminal'] as const
export type StudioBuiltInToolset = (typeof STUDIO_BUILT_IN_TOOLSETS)[number]

/**
 * Names no app may take: the built-ins, the families Studio's own tools use,
 * and three that would read as Studio's own. A Studio adds the families it
 * actually serves and every module id at start, so this list is a floor.
 */
export const STUDIO_RESERVED_TOOLSET_NAMES: readonly string[] = [
  ...STUDIO_BUILT_IN_TOOLSETS,
  'agent',
  'backlog',
  'cli',
  'conversation',
  'marketplace',
  'module',
  'schedule',
  'tailnet',
  'workspace',
  'worktree',
  'artifacts',
  'studio',
  'sprintengine',
  'app',
]

/** Whether a toolset name is one of the shell's own. */
export function isStudioBuiltInToolset(name: string): name is StudioBuiltInToolset {
  return (STUDIO_BUILT_IN_TOOLSETS as readonly string[]).includes(name)
}

/** The name an agent sees a tool under: `<toolset>.<tool>`. */
export function studioToolWireName(toolset: string, tool: string): string {
  return `${toolset}.${tool}`
}

// ── Limits ──────────────────────────────────────────────────────────────────

/**
 * The most bytes one encoded `reply` may take. An agent receives a tool's
 * result as one line of at most 1 MiB on the gateway, and this leaves room for
 * the JSON-RPC envelope around it.
 */
export const STUDIO_MAX_TOOL_RESULT_BYTES = 960 * 1024

/** What Studio holds client tools to. Constants, so a client can read them and a later Studio can move them. */
export const STUDIO_TOOL_LIMITS = {
  /** Toolsets one connection may hold offered at once (`too_large` past it). */
  toolsetsPerConnection: 8,
  /** Tools in one toolset (`too_large`). */
  toolsPerToolset: 32,
  /** App tools across every app on one Studio (`busy` on the offer). */
  appToolsPerServer: 256,
  /** One tool's input schema, as JSON (`invalid_params`). */
  inputSchemaBytes: 16 * 1024,
  /** One offer, as JSON (`too_large`). */
  offerBytes: 256 * 1024,
  /** Offers and withdrawals per connection per minute (`busy`). */
  offersPerMinute: 20,
  /** Calls one client connection may be running at once; the agent past it is answered `busy`. */
  callsInFlightPerConnection: 16,
  /** Calls to client tools one agent connection may have running at once. */
  callsInFlightPerAgent: 8,
  /** Calls started per app per second, as a token bucket refilled at this rate. */
  callsPerSecondPerApp: 20,
  /** The bucket's size: a burst an app may take at once. */
  callBurstPerApp: 40,
  /** How often one agent connection is told its tool list changed, at most; later ones are delayed, never dropped. */
  listChangedIntervalMs: 2_000,
  /** A tool's own description. */
  descriptionChars: 2_000,
  /** A toolset's one sentence for the agent. */
  toolsetDescriptionChars: 300,
  /** A toolset's title for the person. */
  titleChars: 60,
  /** A progress frame's message. */
  progressMessageChars: 200,
  /** A tool's deadline when its offer names none. */
  defaultTimeoutMs: 60_000,
  minTimeoutMs: 1_000,
  maxTimeoutMs: 600_000,
  /** Studio waits this much past a tool's deadline for the round trip. */
  timeoutSlackMs: 5_000,
  /** How long a client that dropped keeps its offers, its calls and its place, waiting for it to come back. */
  reconnectGraceMs: 20_000,
} as const

// ── Shapes ──────────────────────────────────────────────────────────────────

/** What kind of client a connection is. Read only from an owner's grant; any other grant is an `app`. */
export type StudioClientKind = 'desktop' | 'web' | 'app' | 'headless'
export const STUDIO_CLIENT_KINDS: readonly StudioClientKind[] = ['desktop', 'web', 'app', 'headless']

/**
 * Which conversations an app's tools reach: those it started (and those the
 * person opened to it), or every agent on the machine. An owner's offer may
 * name it; an app's comes from its pairing.
 */
export type StudioToolReach = 'own' | 'all'

/** One part of a tool's result: text, or a picture the agent sees inline. */
export type StudioToolContent = { type: 'text'; text: string } | { type: 'image'; data: string; mimeType: string }

/** A tool's result: the MCP tool result an agent receives. */
export type StudioToolResult = {
  content: StudioToolContent[]
  structuredContent?: Record<string, unknown>
  /** A failure the agent should read (`no_tab`, `interrupted`), as opposed to a failure of the client. */
  isError?: boolean
}

/** The picture types a result may carry. */
export const STUDIO_TOOL_IMAGE_TYPES = ['image/png', 'image/jpeg', 'image/webp', 'image/gif'] as const

export type StudioToolSpec = {
  name: string
  /** What the agent reads about the tool: 1 to 2,000 characters. */
  description: string
  /** A JSON Schema whose root is `type: 'object'`, at most 16 KiB as JSON, with no `$ref` outside itself. */
  inputSchema: Record<string, unknown>
  /** Whether a call changes anything. An app's tool does unless it says `false`. */
  mutates?: boolean
  /** How long Studio waits for an answer: 1,000 to 600,000 ms, 60,000 when absent. */
  timeoutMs?: number
}

export type StudioToolsetOffer = {
  name: string
  /** Shown to the person ("Acme Game"). Defaults to the grant's name. */
  title?: string
  /** One sentence for the agent, placed before each tool's description. */
  description?: string
  tools: StudioToolSpec[]
}

/** One client offering a toolset, as the catalog shows it. */
export type StudioToolsetProvider = {
  clientName: string
  kind: StudioClientKind
  instanceId: string
  /** False while the client is away within its reconnect grace. */
  connected: boolean
}

export type StudioToolsetListing = {
  name: string
  title: string
  builtIn: boolean
  offeredBy: StudioToolsetProvider[]
  tools: Array<{ name: string; wireName: string; mutates: boolean }>
}

/** Who is calling, as the client running the tool is told. */
export type StudioToolCallContext = {
  /** The gateway connection the call came on. Device fields are given to Studio's own shell only. */
  connection: {
    kind: 'studio-agent' | 'external-local' | 'remote-tailnet'
    workspaceId?: string
    agentId?: string
    agentName?: string
    cliId?: string
    deviceId?: string
    deviceName?: string
  }
  /** The calling conversation, when the agent is one Studio launched. */
  conversation?: { workspaceId: string; agentId: string }
}

// ── Frames ──────────────────────────────────────────────────────────────────

/** Studio → client: run one tool. */
export type StudioCallFrame = {
  t: 'call'
  /** Minted by Studio, unique for its lifetime. */
  id: string
  toolset: string
  tool: string
  input: Record<string, unknown>
  context: StudioToolCallContext
  /** What Studio will wait, from the offer. */
  timeoutMs: number
  /** This id was sent before, to an earlier connection of the same client process. */
  redelivery?: true
}

/** Why Studio stopped waiting for a call. */
export const STUDIO_CANCEL_REASONS = [
  'interrupted',
  'agent_gone',
  'timeout',
  'client_replaced',
  'shutting_down',
] as const
export type StudioCancelReason = (typeof STUDIO_CANCEL_REASONS)[number]

/** Studio → client: the agent has been answered without this call's reply; stop if you can. */
export type StudioCancelFrame = { t: 'cancel'; id: string; reason: StudioCancelReason }

/** Client → Studio: a call's answer. `ok: false` is a failure of the client, not of the tool. */
export type StudioReplyFrame =
  | { t: 'reply'; id: string; ok: true; result: StudioToolResult }
  | { t: 'reply'; id: string; ok: false; error: { code: string; message: string } }

/** Client → Studio: a running call is still alive, and how far it has got. */
export type StudioProgressFrame = { t: 'progress'; id: string; progress?: number; total?: number; message?: string }

// ── Methods and topics ──────────────────────────────────────────────────────

export type StudioToolsMethodMap = {
  /**
   * Offer one toolset, or replace this connection's earlier offer of it. The
   * answer names the wire names agents see. `reach` is read from an owner
   * only; an app's comes from its pairing.
   */
  'tools.offer': {
    params: { toolset: StudioToolsetOffer; reach?: StudioToolReach }
    result: { toolset: string; wireNames: string[]; reach: StudioToolReach }
  }
  'tools.withdraw': { params: { toolset: string }; result: { withdrawn: boolean } }
  /** A routing hint: whether the person is looking at this client, and which workspaces it shows. */
  'tools.focus': {
    params: { focused: boolean; workspaceIds: string[]; activeWorkspaceId?: string }
    result: Record<string, never>
  }
  /** Every toolset this client may see: its own and the built-ins; an owner sees all of them. */
  'tools.catalog': { params: Record<string, never>; result: { toolsets: StudioToolsetListing[] } }
  /** Owners only: the app toolsets one conversation was opened to. */
  'tools.grants': { params: { key: StudioConversationKey }; result: { grants: string[] } }
  /** Owners only: open one conversation to one app's toolset, or close it again. */
  'tools.grant': {
    params: { key: StudioConversationKey; toolset: string; granted: boolean; commandId: string }
    result: { grants: string[] }
  }
}

export type StudioToolsMethod = keyof StudioToolsMethodMap

export type StudioToolsTopicMap = {
  /** The catalog as `tools.catalog` answers it, whole, on every change. */
  'tools.catalog': { params: Record<string, never> }
}

type MethodSpec = {
  scope: StudioScope
  mutation: boolean
  capability: typeof STUDIO_CLIENT_TOOLS_CAPABILITY
  owner?: true
}

const offering: MethodSpec = { scope: 'tools:offer', mutation: false, capability: STUDIO_CLIENT_TOOLS_CAPABILITY }

/**
 * An offer is idempotent (a second offer of a toolset replaces the first), as
 * are a withdrawal and a focus hint, so none of them carries a command id.
 * Opening a conversation to an app is the person's decision and is audited.
 */
export const STUDIO_TOOLS_METHODS: { readonly [M in StudioToolsMethod]: MethodSpec } = {
  'tools.offer': offering,
  'tools.withdraw': offering,
  'tools.focus': offering,
  'tools.catalog': { scope: 'conversation:read', mutation: false, capability: STUDIO_CLIENT_TOOLS_CAPABILITY },
  'tools.grants': {
    scope: 'conversation:read',
    mutation: false,
    capability: STUDIO_CLIENT_TOOLS_CAPABILITY,
    owner: true,
  },
  'tools.grant': {
    scope: 'conversation:operate',
    mutation: true,
    capability: STUDIO_CLIENT_TOOLS_CAPABILITY,
    owner: true,
  },
}

export const STUDIO_TOOLS_TOPICS: {
  readonly [T in keyof StudioToolsTopicMap]: {
    scope: StudioScope
    capability: typeof STUDIO_CLIENT_TOOLS_CAPABILITY
    push: true
  }
} = {
  'tools.catalog': { scope: 'conversation:read', capability: STUDIO_CLIENT_TOOLS_CAPABILITY, push: true },
}

export function isStudioToolsMethod(value: unknown): value is StudioToolsMethod {
  return typeof value === 'string' && Object.hasOwn(STUDIO_TOOLS_METHODS, value)
}

// ── Validation ──────────────────────────────────────────────────────────────

type Refusal = { ok: false; code: StudioErrorCode; message: string }
const refuse = (message: string, code: StudioErrorCode = 'invalid_params'): Refusal => ({ ok: false, code, message })

function record(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}
function id(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0 && value.length <= 200
}
function text(value: unknown, max: number): value is string {
  return typeof value === 'string' && value.length <= max
}
function finite(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value)
}
function code(value: unknown): value is string {
  return typeof value === 'string' && /^[a-z_]{1,64}$/.test(value)
}

/** A connection's random id, the same across one process's reconnects. */
export const STUDIO_INSTANCE_ID_PATTERN = /^[A-Za-z0-9_-]{16,64}$/

/** The UTF-8 length of a string, without a Buffer: this package runs in a browser too. */
export function studioUtf8Length(value: string): number {
  let bytes = 0
  for (let index = 0; index < value.length; index++) {
    const unit = value.charCodeAt(index)
    if (unit < 0x80) bytes += 1
    else if (unit < 0x800) bytes += 2
    else if (unit >= 0xd800 && unit <= 0xdbff && index + 1 < value.length) {
      const next = value.charCodeAt(index + 1)
      if (next >= 0xdc00 && next <= 0xdfff) {
        bytes += 4
        index++
      } else bytes += 3
    } else bytes += 3
  }
  return bytes
}

/** The first `$ref` that points outside its own document, or null. */
function outsideRef(value: unknown, depth = 0): string | null {
  if (depth > 64) return '(nested too deeply)'
  if (Array.isArray(value)) {
    for (const entry of value) {
      const found = outsideRef(entry, depth + 1)
      if (found !== null) return found
    }
    return null
  }
  if (!record(value)) return null
  for (const [key, entry] of Object.entries(value)) {
    if ((key === '$ref' || key === '$dynamicRef') && (typeof entry !== 'string' || !entry.startsWith('#')))
      return String(entry)
    const found = outsideRef(entry, depth + 1)
    if (found !== null) return found
  }
  return null
}

/**
 * One offer, checked at the trust boundary: names, counts, sizes, and each
 * schema's root. A schema is not validated further: the client owns its
 * handler and checks its own input, as every gateway tool does.
 */
export function parseStudioToolsetOffer(value: unknown): { ok: true; offer: StudioToolsetOffer } | Refusal {
  if (!record(value)) return refuse('"toolset" is { name, title?, description?, tools }.')
  let encoded: string
  try {
    encoded = JSON.stringify(value)
  } catch {
    return refuse('The offer is not plain JSON.')
  }
  if (studioUtf8Length(encoded) > STUDIO_TOOL_LIMITS.offerBytes)
    return refuse(`An offer may be at most ${STUDIO_TOOL_LIMITS.offerBytes / 1024} KiB as JSON.`, 'too_large')
  if (typeof value.name !== 'string' || !STUDIO_TOOLSET_NAME_PATTERN.test(value.name))
    return refuse(
      `"${String(value.name)}" is not a toolset name: 2 to 16 lowercase letters, digits or hyphens, starting with a letter.`,
    )
  if (value.title !== undefined && !(text(value.title, STUDIO_TOOL_LIMITS.titleChars) && value.title.trim()))
    return refuse(`"title" is 1 to ${STUDIO_TOOL_LIMITS.titleChars} characters.`)
  if (value.description !== undefined && !text(value.description, STUDIO_TOOL_LIMITS.toolsetDescriptionChars))
    return refuse(`"description" is at most ${STUDIO_TOOL_LIMITS.toolsetDescriptionChars} characters.`)
  if (!Array.isArray(value.tools) || value.tools.length === 0) return refuse('"tools" lists at least one tool.')
  if (value.tools.length > STUDIO_TOOL_LIMITS.toolsPerToolset)
    return refuse(`A toolset holds at most ${STUDIO_TOOL_LIMITS.toolsPerToolset} tools.`, 'too_large')
  const tools: StudioToolSpec[] = []
  const seen = new Set<string>()
  for (const entry of value.tools as unknown[]) {
    if (!record(entry)) return refuse('Each tool is { name, description, inputSchema, mutates?, timeoutMs? }.')
    const name = entry.name
    if (typeof name !== 'string' || !STUDIO_TOOL_NAME_PATTERN.test(name))
      return refuse(
        `"${String(name)}" is not a tool name: 1 to 32 lowercase letters, digits or underscores, starting with a letter.`,
      )
    if (seen.has(name)) return refuse(`"${name}" is offered twice in one toolset.`)
    seen.add(name)
    if (
      typeof entry.description !== 'string' ||
      !entry.description.trim() ||
      entry.description.length > STUDIO_TOOL_LIMITS.descriptionChars
    )
      return refuse(`"${name}" needs a description of 1 to ${STUDIO_TOOL_LIMITS.descriptionChars} characters.`)
    const schema = entry.inputSchema
    if (!record(schema) || schema.type !== 'object')
      return refuse(`"${name}"'s inputSchema must be a JSON Schema whose root is { type: 'object' }.`)
    if (studioUtf8Length(JSON.stringify(schema)) > STUDIO_TOOL_LIMITS.inputSchemaBytes)
      return refuse(`"${name}"'s inputSchema is over ${STUDIO_TOOL_LIMITS.inputSchemaBytes / 1024} KiB as JSON.`)
    const ref = outsideRef(schema)
    if (ref !== null) return refuse(`"${name}"'s inputSchema refers outside itself (${ref.slice(0, 80)}).`)
    if (entry.mutates !== undefined && typeof entry.mutates !== 'boolean')
      return refuse(`"${name}"'s "mutates" is true or false.`)
    if (
      entry.timeoutMs !== undefined &&
      !(
        Number.isSafeInteger(entry.timeoutMs) &&
        (entry.timeoutMs as number) >= STUDIO_TOOL_LIMITS.minTimeoutMs &&
        (entry.timeoutMs as number) <= STUDIO_TOOL_LIMITS.maxTimeoutMs
      )
    )
      return refuse(
        `"${name}"'s "timeoutMs" is between ${STUDIO_TOOL_LIMITS.minTimeoutMs} and ${STUDIO_TOOL_LIMITS.maxTimeoutMs}.`,
      )
    tools.push({
      name,
      description: entry.description,
      inputSchema: schema,
      ...(entry.mutates === undefined ? {} : { mutates: entry.mutates as boolean }),
      ...(entry.timeoutMs === undefined ? {} : { timeoutMs: entry.timeoutMs as number }),
    })
  }
  return {
    ok: true,
    offer: {
      name: value.name,
      ...(value.title === undefined ? {} : { title: (value.title as string).trim() }),
      ...(value.description === undefined ? {} : { description: value.description as string }),
      tools,
    },
  }
}

/** A tool result as a client returned it, or null when it is not one: text or picture parts, and nothing else. */
export function parseStudioToolResult(value: unknown): StudioToolResult | null {
  if (!record(value) || !Array.isArray(value.content)) return null
  const content: StudioToolContent[] = []
  for (const part of value.content as unknown[]) {
    if (!record(part)) return null
    if (part.type === 'text' && typeof part.text === 'string') content.push({ type: 'text', text: part.text })
    else if (
      part.type === 'image' &&
      typeof part.data === 'string' &&
      (STUDIO_TOOL_IMAGE_TYPES as readonly unknown[]).includes(part.mimeType)
    )
      content.push({ type: 'image', data: part.data, mimeType: part.mimeType as string })
    else return null
  }
  if (value.structuredContent !== undefined && !record(value.structuredContent)) return null
  if (value.isError !== undefined && typeof value.isError !== 'boolean') return null
  return {
    content,
    ...(value.structuredContent === undefined
      ? {}
      : { structuredContent: value.structuredContent as Record<string, unknown> }),
    ...(value.isError === undefined ? {} : { isError: value.isError as boolean }),
  }
}

/** A `reply` from a client, or null. The result's size is the receiver's to check. */
export function parseStudioReplyFrame(value: unknown): StudioReplyFrame | null {
  if (!record(value) || value.t !== 'reply' || !id(value.id) || typeof value.ok !== 'boolean') return null
  if (value.ok) {
    const result = parseStudioToolResult(value.result)
    return result ? { t: 'reply', id: value.id, ok: true, result } : null
  }
  const error = value.error
  if (!record(error) || !code(error.code) || typeof error.message !== 'string') return null
  return { t: 'reply', id: value.id, ok: false, error: { code: error.code, message: error.message.slice(0, 2_000) } }
}

/** A `progress` from a client, or null. */
export function parseStudioProgressFrame(value: unknown): StudioProgressFrame | null {
  if (!record(value) || value.t !== 'progress' || !id(value.id)) return null
  if (value.progress !== undefined && !finite(value.progress)) return null
  if (value.total !== undefined && !finite(value.total)) return null
  if (value.message !== undefined && typeof value.message !== 'string') return null
  return {
    t: 'progress',
    id: value.id,
    ...(value.progress === undefined ? {} : { progress: value.progress as number }),
    ...(value.total === undefined ? {} : { total: value.total as number }),
    ...(value.message === undefined
      ? {}
      : { message: (value.message as string).slice(0, STUDIO_TOOL_LIMITS.progressMessageChars) }),
  }
}

const CONTEXT_KINDS = ['studio-agent', 'external-local', 'remote-tailnet'] as const

function callContext(value: unknown): StudioToolCallContext | null {
  if (!record(value) || !record(value.connection)) return null
  const connection = value.connection
  if (!(CONTEXT_KINDS as readonly unknown[]).includes(connection.kind)) return null
  const out: StudioToolCallContext['connection'] = {
    kind: connection.kind as StudioToolCallContext['connection']['kind'],
  }
  for (const key of ['workspaceId', 'agentId', 'agentName', 'cliId', 'deviceId', 'deviceName'] as const) {
    const field = connection[key]
    if (field === undefined) continue
    if (!text(field, 256)) return null
    out[key] = field
  }
  const conversation = value.conversation
  if (conversation === undefined) return { connection: out }
  if (!record(conversation) || !id(conversation.workspaceId) || !id(conversation.agentId)) return null
  return { connection: out, conversation: { workspaceId: conversation.workspaceId, agentId: conversation.agentId } }
}

/** A `call` from a Studio, or null. */
export function parseStudioCallFrame(value: unknown): StudioCallFrame | null {
  if (!record(value) || value.t !== 'call' || !id(value.id)) return null
  if (typeof value.toolset !== 'string' || !STUDIO_TOOLSET_NAME_PATTERN.test(value.toolset)) return null
  if (typeof value.tool !== 'string' || !STUDIO_TOOL_NAME_PATTERN.test(value.tool)) return null
  if (!record(value.input) || !Number.isSafeInteger(value.timeoutMs) || (value.timeoutMs as number) < 0) return null
  const context = callContext(value.context)
  if (!context) return null
  return {
    t: 'call',
    id: value.id,
    toolset: value.toolset,
    tool: value.tool,
    input: value.input,
    context,
    timeoutMs: value.timeoutMs as number,
    ...(value.redelivery === true ? { redelivery: true as const } : {}),
  }
}

/** A `cancel` from a Studio, or null. A reason this version does not know is read as `interrupted`. */
export function parseStudioCancelFrame(value: unknown): StudioCancelFrame | null {
  if (!record(value) || value.t !== 'cancel' || !id(value.id)) return null
  const reason = (STUDIO_CANCEL_REASONS as readonly unknown[]).includes(value.reason)
    ? (value.reason as StudioCancelReason)
    : 'interrupted'
  return { t: 'cancel', id: value.id, reason }
}

const KEY = '"key" names the conversation: { workspaceId, agentId }.'

/** A `tools.*` method's params, shape-checked, keeping only the members it defines. */
export function parseStudioToolsParams<M extends StudioToolsMethod>(
  method: M,
  params: unknown,
): { ok: true; params: StudioToolsMethodMap[M]['params'] } | Refusal {
  const value = params === undefined ? {} : params
  if (!record(value)) return refuse(`${method} takes an object of params.`)
  const ok = (parsed: unknown) => ({ ok: true as const, params: parsed as StudioToolsMethodMap[M]['params'] })
  switch (method as StudioToolsMethod) {
    case 'tools.offer': {
      const parsed = parseStudioToolsetOffer(value.toolset)
      if (!parsed.ok) return parsed
      if (value.reach !== undefined && value.reach !== 'own' && value.reach !== 'all')
        return refuse('"reach" is "own" or "all".')
      return ok({ toolset: parsed.offer, ...(value.reach === undefined ? {} : { reach: value.reach }) })
    }
    case 'tools.withdraw':
      return typeof value.toolset === 'string' && STUDIO_TOOLSET_NAME_PATTERN.test(value.toolset)
        ? ok({ toolset: value.toolset })
        : refuse('"toolset" names a toolset this connection offered.')
    case 'tools.focus': {
      if (typeof value.focused !== 'boolean') return refuse('"focused" is true or false.')
      if (!Array.isArray(value.workspaceIds) || value.workspaceIds.length > 64 || !value.workspaceIds.every(id))
        return refuse('"workspaceIds" lists at most 64 workspace ids.')
      if (value.activeWorkspaceId !== undefined && !id(value.activeWorkspaceId))
        return refuse('"activeWorkspaceId" is a workspace id.')
      return ok({
        focused: value.focused,
        workspaceIds: [...new Set(value.workspaceIds as string[])],
        ...(value.activeWorkspaceId === undefined ? {} : { activeWorkspaceId: value.activeWorkspaceId }),
      })
    }
    case 'tools.catalog':
      return ok({})
    case 'tools.grants': {
      const key = parseStudioConversationKey(value.key)
      return key ? ok({ key }) : refuse(KEY)
    }
    case 'tools.grant': {
      const key = parseStudioConversationKey(value.key)
      if (!key) return refuse(KEY)
      if (typeof value.toolset !== 'string' || !STUDIO_TOOLSET_NAME_PATTERN.test(value.toolset))
        return refuse('"toolset" names an app toolset.')
      if (typeof value.granted !== 'boolean') return refuse('"granted" is true or false.')
      if (!id(value.commandId)) return refuse('"commandId" must be a string of 1 to 200 characters.')
      return ok({ key, toolset: value.toolset, granted: value.granted, commandId: value.commandId })
    }
  }
}
