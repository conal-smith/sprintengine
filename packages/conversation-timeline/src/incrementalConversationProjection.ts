import type { ConversationEvent } from './protocol.js'
import { isBackgroundLaunchAck, readSubagentStatus } from './subagents.js'
import { applyPromptCacheEvent } from './promptCache.js'
import {
  agentStateOf,
  nextConversationUsage,
  applyAgentState,
  backgroundResultTaskId,
  isResumed,
  openReasoningRun,
  projectConversation,
  readBoolean,
  readImagePaths,
  readNumber,
  readString,
  reopenAgentLane,
  type ConversationProjection,
  type TranscriptEntry,
  type TranscriptToolEntry,
  type UserTurn,
} from './conversationProjection.js'

type ReasoningWindow = { startedAt: number; endedAt?: number }

export type IncrementalConversationState = {
  projection: ConversationProjection
  userTurns: UserTurn[]
  // What has been folded: `events[0, length)`. The array can be longer than
  // that: a later state of the same lineage appended to it in place, or it is
  // the caller's array a batch was read from.
  events: readonly ConversationEvent[]
  length: number
  // Whether `events` belongs to this lineage, so an append may go into it in
  // place. A caller's array (a session snapshot) is never written to.
  ownsEvents: boolean
  reasoning: Map<string, ReasoningWindow>
  entryIndexes: Map<string, number>
  // Moves on every change except a streamed token. What is derived from the
  // transcript's shape (pending approvals, the latest failed turn, prompt
  // history) is keyed on it, so it is not recomputed per token.
  structureRevision: number
}

// A batch of appended events is applied one at a time while that stays cheap:
// a coalesced frame of tokens, or a hidden view catching up on a few steps.
// Past these bounds one fold of the whole log costs less than the refolds the
// batch would trigger (a reconnect, or a view that rested through a long turn).
const MAX_INCREMENTAL_BATCH = 512
const MAX_BATCH_REFOLDS = 8

// Within one batch the entries array is copied on its first write and written
// in place after that, so a frame of tokens copies it once, not once a token.
type Batch = { entries: TranscriptEntry[] | null }

function entryKey(entry: TranscriptEntry): string {
  switch (entry.kind) {
    case 'user':
      return `user:${entry.id}`
    case 'assistant':
      return `assistant:${entry.turnId}`
    case 'tool':
      return `tool:${entry.id}`
    case 'approval':
      return `approval:${entry.requestId}`
    case 'compaction':
      return `compaction:${entry.id}`
    case 'commandOutput':
      return `commandOutput:${entry.id}`
  }
}

function indexEntries(entries: TranscriptEntry[]): Map<string, number> {
  return new Map(entries.map((entry, index) => [entryKey(entry), index]))
}

function folded(state: Pick<IncrementalConversationState, 'events' | 'length'>): readonly ConversationEvent[] {
  return state.length === state.events.length ? state.events : state.events.slice(0, state.length)
}

// Each turn's latest reasoning run: a run closed by prose or a tool call is
// replaced by the next one, as the fold adds each closed run to its segment.
// A failure without a turn id (an interrupt) closes the latest turn still
// streaming, as the fold resolves it, so the two never disagree about whether
// a run is open.
function reasoningWindows(events: readonly ConversationEvent[]): Map<string, ReasoningWindow> {
  const windows = new Map<string, ReasoningWindow>()
  // Turns in the order the fold creates them, and whether each still streams.
  const streaming = new Map<string, boolean>()
  const close = (turnId: string, at: number) => {
    const window = windows.get(turnId)
    if (window && window.endedAt === undefined) window.endedAt = at
  }
  for (const event of events) {
    const turnId = readString(event.payload, 'turnId')
    if (!turnId) {
      if (event.type !== 'turn_failed') continue
      const active = [...streaming].findLast(([, live]) => live)?.[0]
      if (active === undefined) continue
      close(active, event.createdAt)
      streaming.set(active, false)
      continue
    }
    // Every event the fold opens a turn for; a resolved approval opens none.
    if (event.type !== 'approval_resolved' && !streaming.has(turnId)) streaming.set(turnId, true)
    if (event.type === 'turn_started') streaming.set(turnId, true)
    if (event.type === 'reasoning_delta' && !isOpen(windows.get(turnId)))
      windows.set(turnId, { startedAt: event.createdAt })
    else if (
      event.type === 'content_delta' ||
      event.type === 'tool_started' ||
      event.type === 'turn_completed' ||
      event.type === 'turn_failed'
    )
      close(turnId, event.createdAt)
    if (event.type === 'turn_completed' || event.type === 'turn_failed') streaming.set(turnId, false)
  }
  return windows
}

function isOpen(window: ReasoningWindow | undefined): window is ReasoningWindow {
  return window !== undefined && window.endedAt === undefined
}

// Whether two values a fold built are the same, by value, without
// serialising them. Strings and numbers compare as values; arrays and plain
// objects field by field, a few levels down, which covers what an entry holds
// (mentions, stored attachments, reasoning segments, an agent's state).
// Anything deeper — a tool's input, an image's bytes — is the payload object
// itself, which the fold passes through, so identity decides it. A false
// "changed" costs one re-render; a false "same" would show stale data, so
// every doubt is "changed".
function sameValue(a: unknown, b: unknown, depth = 0): boolean {
  if (a === b) return true
  if (typeof a !== 'object' || typeof b !== 'object' || a === null || b === null || depth >= 4) return false
  if (Array.isArray(a)) {
    if (!Array.isArray(b) || a.length !== b.length) return false
    for (let index = 0; index < a.length; index++) if (!sameValue(a[index], b[index], depth + 1)) return false
    return true
  }
  if (Array.isArray(b)) return false
  const left = a as Record<string, unknown>
  const right = b as Record<string, unknown>
  for (const key in left) if (!sameValue(left[key], right[key], depth + 1)) return false
  // A key only the right has counts when it holds a value, as JSON would see it.
  for (const key in right) if (!(key in left) && right[key] !== undefined) return false
  return true
}

function reuseTool(previous: TranscriptToolEntry, next: TranscriptToolEntry): TranscriptToolEntry {
  const oldChildren = previous.children ?? []
  const nextChildren = next.children ?? []
  const oldById = new Map(oldChildren.map((child) => [child.id, child]))
  const children = nextChildren.map((child) => {
    const old = oldById.get(child.id)
    return old ? reuseTool(old, child) : child
  })
  const sameChildren =
    children.length === oldChildren.length && children.every((child, index) => child === oldChildren[index])
  if (sameChildren) {
    let same = true
    for (const key in next) {
      if (
        key !== 'children' &&
        !sameValue(previous[key as keyof TranscriptToolEntry], next[key as keyof TranscriptToolEntry])
      ) {
        same = false
        break
      }
    }
    if (same)
      for (const key in previous)
        if (key !== 'children' && !(key in next) && previous[key as keyof TranscriptToolEntry] !== undefined)
          same = false
    if (same) return previous
  }
  return { ...next, ...(next.children ? { children: sameChildren ? previous.children : children } : {}) }
}

function reconcileEntries(previous: TranscriptEntry[], next: TranscriptEntry[]): TranscriptEntry[] {
  const oldByKey = new Map(previous.map((entry) => [entryKey(entry), entry]))
  return next.map((entry) => {
    const old = oldByKey.get(entryKey(entry))
    if (!old || old.kind !== entry.kind) return entry
    if (old.kind === 'tool' && entry.kind === 'tool') return reuseTool(old, entry)
    return sameValue(old, entry, -1) ? old : entry
  })
}

// The projection's own values that are objects keep their identity while they
// read the same, so a consumer memoized on one (the agent types every lane's
// card reads) is not redrawn by a fold that did not change it.
function reconcileProjection(previous: ConversationProjection, next: ConversationProjection): ConversationProjection {
  const entries = reconcileEntries(previous.entries, next.entries)
  return {
    ...next,
    entries,
    usage: sameValue(previous.usage, next.usage) ? previous.usage : next.usage,
    agentTypes: sameValue(previous.agentTypes, next.agentTypes, -1) ? previous.agentTypes : next.agentTypes,
    backgroundTasks: sameValue(previous.backgroundTasks, next.backgroundTasks, -1)
      ? previous.backgroundTasks
      : next.backgroundTasks,
    promptCache: sameValue(previous.promptCache, next.promptCache) ? previous.promptCache : next.promptCache,
  }
}

export function createConversationProjectionState(
  events: readonly ConversationEvent[] = [],
  userTurns: UserTurn[] = [],
): IncrementalConversationState {
  const projection = projectConversation(events, userTurns)
  return {
    projection,
    userTurns,
    events,
    length: events.length,
    ownsEvents: false,
    reasoning: reasoningWindows(events),
    entryIndexes: indexEntries(projection.entries),
    structureRevision: 0,
  }
}

// Fold `events` whole, keeping the identity of every entry that came out the
// same, so rows that did not change are not re-rendered.
function rebuild(
  state: IncrementalConversationState,
  events: readonly ConversationEvent[],
  userTurns: UserTurn[],
  ownsEvents: boolean,
  batch: Batch | null = null,
): IncrementalConversationState {
  const next = createConversationProjectionState(events, userTurns)
  const projection = reconcileProjection(state.projection, next.projection)
  if (batch) batch.entries = projection.entries
  return {
    ...next,
    ownsEvents,
    projection,
    entryIndexes: indexEntries(projection.entries),
    structureRevision: state.structureRevision + 1,
  }
}

function writableEntries(state: IncrementalConversationState, batch: Batch | null): TranscriptEntry[] {
  if (batch && batch.entries === state.projection.entries) return batch.entries
  const entries = state.projection.entries.slice()
  if (batch) batch.entries = entries
  return entries
}

function updateEntry(
  state: IncrementalConversationState,
  key: string,
  update: (entry: TranscriptEntry) => TranscriptEntry,
  batch: Batch | null,
): ConversationProjection | null {
  const index = state.entryIndexes.get(key)
  if (index === undefined) return null
  const entry = state.projection.entries[index]
  if (!entry) return null
  const updated = update(entry)
  if (updated === entry) return null
  const entries = writableEntries(state, batch)
  entries[index] = updated
  return { ...state.projection, entries }
}

// The call `id` anywhere in a lane tree, changed by `update`; null when it is
// not in this tree.
function updateToolTree(
  tool: TranscriptToolEntry,
  id: string,
  update: (tool: TranscriptToolEntry) => TranscriptToolEntry,
): TranscriptToolEntry | null {
  if (tool.id === id) return update(tool)
  if (!tool.children) return null
  for (let index = 0; index < tool.children.length; index++) {
    const child = updateToolTree(tool.children[index], id, update)
    if (child) {
      const children = tool.children.slice()
      children[index] = child
      return { ...tool, children }
    }
  }
  return null
}

// A call by id, wherever it sits.
function findTool(
  entries: readonly (TranscriptEntry | TranscriptToolEntry)[],
  id: string,
): TranscriptToolEntry | undefined {
  for (const entry of entries) {
    if (entry.kind !== 'tool') continue
    if (entry.id === id) return entry
    const found = entry.children ? findTool(entry.children, id) : undefined
    if (found) return found
  }
  return undefined
}

// The call an agent started in, found by its task wherever the call sits.
function findAgentLane(
  entries: readonly (TranscriptEntry | TranscriptToolEntry)[],
  taskId: string,
): string | undefined {
  for (const entry of entries) {
    if (entry.kind !== 'tool') continue
    if (entry.agent?.taskId === taskId) return entry.id
    const lane = entry.children ? findAgentLane(entry.children, taskId) : undefined
    if (lane) return lane
  }
  return undefined
}

// Change one call wherever it sits in the transcript, as the fold would; null
// when it is not there (not loaded, or taken out by a rewind), for the fold to
// settle.
function updateTool(
  state: IncrementalConversationState,
  id: string,
  update: (tool: TranscriptToolEntry) => TranscriptToolEntry,
  batch: Batch | null,
): ConversationProjection | null {
  for (let index = 0; index < state.projection.entries.length; index++) {
    const entry = state.projection.entries[index]
    if (entry.kind !== 'tool') continue
    const changed = updateToolTree(entry, id, update)
    if (!changed) continue
    const entries = writableEntries(state, batch)
    entries[index] = changed
    return { ...state.projection, entries }
  }
  return null
}

function withOutput(tool: TranscriptToolEntry, event: ConversationEvent): TranscriptToolEntry {
  const status = event.payload?.status
  const images = readImagePaths(event.payload) ?? tool.images
  return {
    ...tool,
    status: event.payload?.partial === true ? tool.status : 'done',
    completedAt: event.payload?.partial === true ? tool.completedAt : event.createdAt,
    output: readString(event.payload, 'preview', 'output', 'text') ?? tool.output,
    truncated: readBoolean(event.payload, 'truncated') ?? tool.truncated,
    totalBytes: readNumber(event.payload, 'totalBytes') ?? tool.totalBytes,
    outputStatus:
      status === 'ok' || status === 'error' || status === 'declined' || status === 'stopped'
        ? status
        : tool.outputStatus,
    exitCode: readNumber(event.payload, 'exitCode') ?? tool.exitCode,
    mime: readString(event.payload, 'mime') ?? tool.mime,
    ...(images ? { images } : {}),
  }
}

function fastProjection(
  state: IncrementalConversationState,
  event: ConversationEvent,
  batch: Batch | null,
): ConversationProjection | null {
  const turnId = readString(event.payload, 'turnId')
  // A notice rides on whichever event followed it; only the fold reads it.
  if (readString(event.payload, 'notice')) return null
  // The first word after a retry or compaction notice clears it, which only
  // the fold does. Rare: once per failed call or summary, never per token of a
  // reply that went through.
  if (turnId) {
    const index = state.entryIndexes.get(`assistant:${turnId}`)
    const entry = index === undefined ? undefined : state.projection.entries[index]
    if (entry?.kind === 'assistant' && (entry.retry || entry.compacting)) return null
  }
  if ((event.type === 'content_delta' || event.type === 'reasoning_delta') && turnId) {
    const delta = readString(event.payload, 'text', 'delta') ?? ''
    const key = `assistant:${turnId}`
    // An unknown turn needs the fold to create its entry, even from an empty delta.
    if (!state.entryIndexes.has(key)) return null
    // An empty content delta still ends the reasoning window, exactly as the
    // fold does, so it is not a no-op.
    return (
      updateEntry(
        state,
        key,
        (entry) => {
          if (entry.kind !== 'assistant') return entry
          const window = state.reasoning.get(turnId)
          if (event.type === 'reasoning_delta') {
            if (isOpen(window)) return delta ? { ...entry, reasoning: entry.reasoning + delta } : entry
            return { ...entry, reasoning: openReasoningRun(entry.reasoning, delta), reasoningLive: true }
          }
          const reasoningDurationMs = isOpen(window)
            ? (entry.reasoningDurationMs ?? 0) + Math.max(0, event.createdAt - window.startedAt)
            : entry.reasoningDurationMs
          if (!delta && reasoningDurationMs === entry.reasoningDurationMs && !entry.reasoningLive) return entry
          return { ...entry, text: entry.text + delta, reasoningDurationMs, reasoningLive: undefined }
        },
        batch,
      ) ?? state.projection
    )
  }
  if (event.type === 'tool_output') {
    const id = readString(event.payload, 'toolUseId', 'callId', 'id', 'toolCallId')
    if (!id) return null
    // A background agent's launch notice keeps its lane open; only the fold
    // knows how to read one.
    if (isBackgroundLaunchAck(readString(event.payload, 'preview', 'output', 'text'))) return null
    if (turnId && !state.entryIndexes.has(`assistant:${turnId}`)) return null
    // A background agent's answer goes to the lane its task started in. One
    // whose lane is not on screen (an earlier page) is the fold's to place.
    const resultTaskId = backgroundResultTaskId(event.payload)
    const lane = resultTaskId ? findAgentLane(state.projection.entries, resultTaskId) : undefined
    if (resultTaskId && !lane) return null
    return updateTool(state, lane ?? id, (tool) => withOutput(tool, event), batch)
  }
  // A subagent's progress and its words between steps: frequent while agents
  // fan out, and each changes one lane.
  if (event.type === 'subagent_status') {
    const status = readSubagentStatus(event.payload)
    if (!status) return state.projection
    // The agent goes on in the lane it started in, as the fold has it.
    const lane = status.taskId ? findAgentLane(state.projection.entries, status.taskId) : undefined
    // A task whose lane is not found, naming a call that is not a lane (the
    // SendMessage that resumed it), started on a page not loaded: the fold
    // files it under that lane once the page is.
    if (status.taskId && !lane && findTool(state.projection.entries, status.toolUseId)?.subagentLane !== true)
      return null
    const resumed = isResumed(status, lane)
    const agent = agentStateOf(status)
    return updateTool(
      state,
      lane ?? status.toolUseId,
      (tool) => {
        const next = { ...tool }
        if (resumed) reopenAgentLane(next)
        applyAgentState(next, agent, status.endedAt ?? event.createdAt)
        return next
      },
      batch,
    )
  }
  if (event.type === 'subagent_message') {
    const parentToolUseId = readString(event.payload, 'parentToolUseId')
    const text = readString(event.payload, 'text')
    if (!parentToolUseId || !text) return state.projection
    const message = { at: event.createdAt, text, ...(event.payload?.truncated === true ? { truncated: true } : {}) }
    return updateTool(
      state,
      parentToolUseId,
      (tool) => ({ ...tool, messages: [...(tool.messages ?? []), message] }),
      batch,
    )
  }
  // A usage report, once a model call: the session's count, the turn's own, and
  // the prompt cache's clock.
  if (event.type === 'usage_updated') {
    const usage = nextConversationUsage(state.projection.usage, event.payload)
    const promptCache = applyPromptCacheEvent(state.projection.promptCache, event)
    let projection: ConversationProjection = state.projection
    if (turnId) {
      const key = `assistant:${turnId}`
      if (!state.entryIndexes.has(key)) return null
      projection =
        updateEntry(
          state,
          key,
          (entry) =>
            entry.kind !== 'assistant'
              ? entry
              : {
                  ...entry,
                  inputTokens: readNumber(event.payload, 'inputTokens') ?? entry.inputTokens,
                  cachedInputTokens: readNumber(event.payload, 'cachedInputTokens') ?? entry.cachedInputTokens,
                  outputTokens: readNumber(event.payload, 'outputTokens') ?? entry.outputTokens,
                },
          batch,
        ) ?? state.projection
    }
    return { ...projection, usage, promptCache }
  }
  return null
}

// Whether an event can take the fast path, as far as its type says; only for
// sizing a batch, so a guess either way costs time, never correctness.
const FAST_TYPES: ReadonlySet<string> = new Set([
  'content_delta',
  'reasoning_delta',
  'tool_output',
  'subagent_status',
  'subagent_message',
  'usage_updated',
])
function mayApplyFast(event: ConversationEvent): boolean {
  return FAST_TYPES.has(event.type)
}

// Fold `events[index]` into a state that holds `events[0, index)`.
function step(
  state: IncrementalConversationState,
  events: readonly ConversationEvent[],
  index: number,
  ownsEvents: boolean,
  batch: Batch | null,
): IncrementalConversationState {
  const event = events[index]!
  const length = index + 1
  const projection = fastProjection(state, event, batch)
  if (projection) {
    let reasoning = state.reasoning
    const turnId = readString(event.payload, 'turnId')
    if (turnId && event.type === 'reasoning_delta' && !isOpen(reasoning.get(turnId))) {
      reasoning = new Map(reasoning).set(turnId, { startedAt: event.createdAt })
    } else if (turnId && event.type === 'content_delta') {
      const window = reasoning.get(turnId)
      if (window && window.endedAt === undefined)
        reasoning = new Map(reasoning).set(turnId, { ...window, endedAt: event.createdAt })
    }
    const token = event.type === 'content_delta' || event.type === 'reasoning_delta'
    return {
      ...state,
      events,
      length,
      ownsEvents,
      projection,
      reasoning,
      structureRevision: token ? state.structureRevision : state.structureRevision + 1,
    }
  }
  const prefix = length === events.length ? events : events.slice(0, length)
  return rebuild(state, prefix, state.userTurns, ownsEvents && prefix === events, batch)
}

export function applyEvent(
  state: IncrementalConversationState,
  event: ConversationEvent,
): IncrementalConversationState {
  // Append in place when this state is its lineage's tip; a branch (or a
  // caller's array) is copied once, and owned from then on.
  const events =
    state.ownsEvents && state.events.length === state.length
      ? (state.events as ConversationEvent[])
      : state.events.slice(0, state.length)
  events.push(event)
  return step(state, events, state.length, true, null)
}

export function prependEvents(
  state: IncrementalConversationState,
  olderEvents: ConversationEvent[],
): IncrementalConversationState {
  if (!olderEvents.length) return state
  return rebuild(state, [...olderEvents, ...folded(state)], state.userTurns, true)
}

// Events appended after what `state` holds: token by token while the batch is
// small, else one fold of the whole log.
function applyAppended(
  state: IncrementalConversationState,
  events: readonly ConversationEvent[],
): IncrementalConversationState {
  const start = state.length
  if (events.length - start === 1) return step(state, events, start, false, null)
  if (events.length - start <= MAX_INCREMENTAL_BATCH) {
    let refolds = 0
    for (let index = start; index < events.length && refolds <= MAX_BATCH_REFOLDS; index++)
      if (!mayApplyFast(events[index]!)) refolds++
    if (refolds <= MAX_BATCH_REFOLDS) {
      const batch: Batch = { entries: null }
      let next = state
      for (let index = start; index < events.length; index++) next = step(next, events, index, false, batch)
      return next
    }
  }
  return rebuild(state, events, state.userTurns, false)
}

/** Reconcile a paged snapshot or live window without replaying each snapshot event. */
export function syncConversationProjection(
  state: IncrementalConversationState,
  events: readonly ConversationEvent[],
  userTurns: UserTurn[],
): IncrementalConversationState {
  if (state.userTurns !== userTurns) return rebuild(state, events, userTurns, false)
  const oldLength = state.length
  if (events === state.events && events.length === oldLength) return state
  const last = oldLength > 0 ? state.events[oldLength - 1] : undefined
  if (oldLength > 0 && events.length > oldLength && events[oldLength - 1] === last) return applyAppended(state, events)
  // Anything else — a page of earlier turns, a log compacted or replaced — is
  // folded whole, keeping the rows that came out the same.
  if (events.length !== oldLength || (oldLength > 0 && events.at(-1) !== last))
    return rebuild(state, events, userTurns, false)
  return state
}
