// The chat's timeline: which rows a projected conversation turns into, and
// how resolved approvals are grouped.

import { type TranscriptToolEntry, type TranscriptEntry, type TurnRetry } from './conversationProjection.js'
import { toolActionVerb } from './protocol.js'
import { proseShownToUser } from './shownProse.js'

// Every call in a lane subtree, lane headers included, in start order.
export function flattenToolEntries(tools: TranscriptToolEntry[]): TranscriptToolEntry[] {
  const flat: TranscriptToolEntry[] = []
  for (const tool of tools) {
    flat.push(tool)
    if (tool.children?.length) flat.push(...flattenToolEntries(tool.children))
  }
  return flat
}

// A lane names the kind of agent that was spawned, or the generic noun when
// the call did not name one. What it was sent to do rides alongside as the
// row's object (`toolObject`), so a fan-out of four Explore agents stays four
// distinguishable rows rather than four identical ones.
export function subagentLaneLabel(tool: TranscriptToolEntry): string {
  const subagentType = tool.subagentType?.trim()
  return subagentType ? `${subagentType} agent` : 'Agent'
}

export function activeConversationStage(
  entries: TranscriptEntry[],
  activeTurn: boolean,
): 'idle' | 'thinking' | 'tool' | 'approval' | 'responding' {
  if (findLast(entries, (entry) => entry.kind === 'approval' && entry.status === 'pending')) return 'approval'
  if (findLast(entries, (entry) => entry.kind === 'tool' && entry.status === 'running')) return 'tool'
  if (!activeTurn) return 'idle'
  const latestAssistant = findLast(entries, (entry) => entry.kind === 'assistant')
  if (latestAssistant?.kind === 'assistant' && /\S/u.test(latestAssistant.text)) return 'responding'
  return 'thinking'
}

// The last entry matching, read from the end without copying the list: the
// timeline is derived on every token of the reply streaming now.
function findLast<T extends TranscriptEntry>(
  entries: readonly TranscriptEntry[],
  match: (entry: TranscriptEntry) => entry is T,
): T | undefined
function findLast(
  entries: readonly TranscriptEntry[],
  match: (entry: TranscriptEntry) => boolean,
): TranscriptEntry | undefined
function findLast(entries: readonly TranscriptEntry[], match: (entry: TranscriptEntry) => boolean) {
  for (let index = entries.length - 1; index >= 0; index--) if (match(entries[index]!)) return entries[index]
  return undefined
}

export type ConversationApprovalEntry = Extract<TranscriptEntry, { kind: 'approval' }>

// A resolved request stays in the transcript as a decision record. A batch of
// tool permissions answered together is one line ("Approved 10 files"), not ten
// rows; a question or plan decision carries its own content and always keeps a
// row of its own.
export type ConversationDecisionRow =
  | { kind: 'decision'; id: string; entry: ConversationApprovalEntry }
  | {
      kind: 'decisionGroup'
      id: string
      status: 'approved' | 'denied' | 'cancelled'
      label: string
      entries: ConversationApprovalEntry[]
    }

export type ConversationTimelineRow =
  | { kind: 'user'; id: string; entry: Extract<TranscriptEntry, { kind: 'user' }> }
  // One row per assistant turn: byline, reasoning disclosure, work timeline
  // (the turn's tools), the turn's resolved decisions, and prose all render as
  // a single block, per the approved mockup.
  | {
      kind: 'assistant'
      id: string
      entry: Extract<TranscriptEntry, { kind: 'assistant' }>
      tools: Extract<TranscriptEntry, { kind: 'tool' }>[]
      decisions: ConversationDecisionRow[]
      // The turn ran on another model than the reply before it — the model
      // can be switched mid-conversation, and the footer then names it.
      modelSwitched?: boolean
    }
  // Requests that never named a turn; they surface on their own.
  | { kind: 'approval'; id: string; decisions: ConversationDecisionRow[] }
  | { kind: 'compaction'; id: string; entry: Extract<TranscriptEntry, { kind: 'compaction' }> }
  | { kind: 'commandOutput'; id: string; entry: Extract<TranscriptEntry, { kind: 'commandOutput' }> }
  | {
      kind: 'working'
      id: string
      stage: ReturnType<typeof activeConversationStage>
      label: string
      startedAt?: number
      // Agents still working, when the line is counting them.
      agents?: number
      // The turn running now, whose fold the line sits under.
      turnId?: string
      // The first sentence of what the agent last thought or said between its
      // steps, while the turn is folded and those steps are out of sight: the
      // line says what it is doing, this says why. Absent while it replies,
      // when the reply itself is on screen.
      latestThought?: string
    }

// ── Presentation vocabulary (pure, unit-tested) ─────────────────────────────

// The first line of some reasoning or prose as plain words: enough to tell one
// stretch of thinking from the next without opening it. Markdown marks are
// dropped because what shows it is a single line of plain text. Only the lines
// up to the first worth showing are read: it runs on every streamed token, and
// splitting a whole trace each time is work thrown away.
export function reasoningPreview(text: string): string {
  let line = ''
  for (let start = 0; start < text.length;) {
    const end = text.indexOf('\n', start)
    const part = text.slice(start, end === -1 ? text.length : end).trim()
    if (part && !/^(```|---|\*\*\*)/u.test(part)) {
      line = part
      break
    }
    if (end === -1) break
    start = end + 1
  }
  if (!line) return ''
  return line
    .replace(/^(#{1,6}\s+|>\s*|[-*+]\s+|\d+[.)]\s+)/u, '')
    .replace(/(\*\*|__|`)/gu, '')
    .replace(/\[([^\]]*)\]\([^)]*\)/gu, '$1')
    .trim()
}

// The first sentence of that line: a thought is shown in a single muted line,
// and a sentence is the unit that reads as one. A full stop inside a word
// (`a.ts`, `1.5`) does not end it; one followed by a space or the end does.
export function firstThoughtSentence(text: string): string {
  const line = reasoningPreview(text)
  const sentence = /^.*?[.!?…](?=\s|$)/u.exec(line)
  return (sentence ? sentence[0] : line).trim()
}

// What the turn last thought or said between its steps, newest first: the
// thinking since its last step, else whichever came last of the thinking and
// the prose before each step. Prose that shows the person a picture is drawn
// outside the fold already, so it is not repeated here.
export function latestTurnThought(
  entry: Pick<Extract<TranscriptEntry, { kind: 'assistant' }>, 'reasoning' | 'reasoningSegments' | 'intermediateText'>,
  tools: readonly TranscriptToolEntry[],
): string | undefined {
  const trailing = firstThoughtSentence(entry.reasoning)
  if (trailing) return trailing
  const order = new Map(tools.map((tool, index) => [tool.id, index]))
  let best: { at: number; text: string } | undefined
  const consider = (beforeToolUseId: string, rank: number, text: string) => {
    const index = order.get(beforeToolUseId)
    if (index === undefined) return
    const sentence = firstThoughtSentence(text)
    if (!sentence) return
    // The prose before a step comes after the thinking before it.
    const at = index * 2 + rank
    if (!best || at >= best.at) best = { at, text: sentence }
  }
  for (const segment of entry.reasoningSegments ?? []) consider(segment.beforeToolUseId, 0, segment.text)
  for (const part of entry.intermediateText ?? []) {
    if (!proseShownToUser(part.text)) consider(part.beforeToolUseId, 1, part.text)
  }
  return best?.text
}

// The live line while the provider waits to retry a failed call: what went
// wrong, and how far through its attempts it is. The reason is the one thing a
// person can act on (an expired sign-in, a limit), so it leads.
export function retryLabel(retry: Pick<TurnRetry, 'attempt' | 'maxAttempts' | 'error' | 'status'>): string {
  return `${retryReason(retry)} · retrying (${retry.attempt} of ${retry.maxAttempts})…`
}

function retryReason({ error, status }: Pick<TurnRetry, 'error' | 'status'>): string {
  // A 403 is a refusal, not a lapsed sign-in, though a provider may file it
  // under authentication_failed: signing in again would not change it.
  if (status === 403) return 'Access refused'
  switch (error) {
    case 'authentication_failed':
      return 'Couldn’t authenticate'
    case 'rate_limit':
      return 'Rate limited'
    case 'overloaded':
      return 'Service overloaded'
    case 'server_error':
      return 'Server error'
    case 'billing_error':
      return 'Billing problem'
  }
  if (status === 401) return 'Couldn’t authenticate'
  if (status === 429) return 'Rate limited'
  if (status === 529) return 'Service overloaded'
  // No response at all: the request never reached the service.
  if (status === undefined) return 'Couldn’t connect'
  return `Request failed (${status})`
}

// Step verbs: past tense for finished steps, continuous for the live one.
export function toolVerb(tool: string, live: boolean): string {
  return toolActionVerb(tool, live)
}

// The step object is the provider summary minus its "Tool: " prefix — the verb
// already says which tool ran.
export function toolObject(tool: { name: string; summary?: string }): string {
  const summary = tool.summary ?? ''
  const prefix = `${tool.name}: `
  return summary.startsWith(prefix) ? summary.slice(prefix.length) : summary
}

// Tools whose permission request is really about a file, so a batch of them
// counts files rather than the generic "tool uses".
export const FILE_APPROVAL_TOOLS = new Set(['Read', 'Write', 'Edit', 'MultiEdit', 'NotebookEdit'])

export const DECISION_VERB: Record<'approved' | 'denied' | 'cancelled', string> = {
  approved: 'Approved',
  denied: 'Denied',
  cancelled: 'Cancelled',
}

export function resolvedDecisionGroupLabel(
  status: 'approved' | 'denied' | 'cancelled',
  entries: ConversationApprovalEntry[],
): string {
  const count = entries.length
  const files = entries.every((entry) => entry.action !== undefined && FILE_APPROVAL_TOOLS.has(entry.action))
  const noun = files ? (count === 1 ? 'file' : 'files') : count === 1 ? 'tool use' : 'tool uses'
  return `${DECISION_VERB[status]} ${count} ${noun}`
}

// Fold a turn's requests into decision rows. Pending requests are the composer
// dock's, never the transcript's. A run of consecutive tool permissions sharing
// one outcome collapses into a single expandable summary; question and plan
// decisions record a real answer and stay individual rows, and a run of one is
// left as its own row because a group of one is not a list.
export function groupResolvedDecisions(approvals: ConversationApprovalEntry[]): ConversationDecisionRow[] {
  const rows: ConversationDecisionRow[] = []
  let run: ConversationApprovalEntry[] = []
  const flush = (): void => {
    const first = run[0]
    if (!first) return
    if (run.length === 1) {
      rows.push({ kind: 'decision', id: `approval:${first.requestId}`, entry: first })
      // A pending request never joins a run; the check is what narrows the
      // group's outcome to a resolved one.
    } else if (first.status !== 'pending') {
      rows.push({
        kind: 'decisionGroup',
        id: `approvals:${first.requestId}`,
        status: first.status,
        label: resolvedDecisionGroupLabel(first.status, run),
        entries: run,
      })
    }
    run = []
  }
  for (const approval of approvals) {
    if (approval.status === 'pending') continue
    if ((approval.requestKind ?? 'tool') !== 'tool' || approval.autoApproved) {
      flush()
      rows.push({ kind: 'decision', id: `approval:${approval.requestId}`, entry: approval })
      continue
    }
    if (run[0] && run[0].status !== approval.status) flush()
    run.push(approval)
  }
  flush()
  return rows
}

export function deriveConversationTimelineRows(
  entries: TranscriptEntry[],
  activeTurn: boolean,
  previousRows: ConversationTimelineRow[] = [],
): ConversationTimelineRow[] {
  const rows: ConversationTimelineRow[] = []
  const stage = activeConversationStage(entries, activeTurn)
  const latestAssistant = findLast(
    entries,
    (entry): entry is Extract<TranscriptEntry, { kind: 'assistant' }> => entry.kind === 'assistant',
  )
  const pendingApproval = findLast(entries, (entry) => entry.kind === 'approval' && entry.status === 'pending')

  let previousModelId: string | undefined
  for (let index = 0; index < entries.length; index += 1) {
    const entry = entries[index]
    if (!entry) continue
    if (entry.kind === 'user') {
      rows.push({ kind: 'user', id: `user:${entry.id}`, entry })
      continue
    }
    if (entry.kind === 'compaction') {
      rows.push({ kind: 'compaction', id: `compaction:${entry.id}`, entry })
      continue
    }
    if (entry.kind === 'commandOutput') {
      rows.push({ kind: 'commandOutput', id: `commandOutput:${entry.id}`, entry })
      continue
    }
    if (entry.kind === 'assistant') {
      const tools: Extract<TranscriptEntry, { kind: 'tool' }>[] = []
      let cursor = index + 1
      while (cursor < entries.length) {
        const next = entries[cursor]
        if (!next || next.kind !== 'tool' || next.turnId !== entry.turnId) break
        tools.push(next)
        cursor += 1
      }
      // The turn's own requests follow its tools in the entry stream. They ride
      // the turn block (between the work timeline and the prose) rather than
      // trailing it, so a decision reads before the text that came after it.
      const approvals: ConversationApprovalEntry[] = []
      while (cursor < entries.length) {
        const next = entries[cursor]
        if (!next || next.kind !== 'approval' || next.turnId !== entry.turnId) break
        approvals.push(next)
        cursor += 1
      }
      const decisions = groupResolvedDecisions(approvals)
      if (
        entry.text.trim() ||
        entry.reasoning.trim() ||
        tools.length > 0 ||
        decisions.length > 0 ||
        entry.status === 'failed' ||
        entry.status === 'interrupted'
      ) {
        const modelSwitched = Boolean(previousModelId && entry.modelId && entry.modelId !== previousModelId)
        rows.push({
          kind: 'assistant',
          id: `assistant:${entry.turnId}`,
          entry,
          tools,
          decisions,
          ...(modelSwitched ? { modelSwitched } : {}),
        })
      }
      previousModelId = entry.modelId ?? previousModelId
      index = cursor - 1
      continue
    }
    if (entry.kind === 'approval') {
      // Requests with no turn to hang off: take the whole consecutive run so
      // they group like any other batch.
      let cursor = index
      const orphans: ConversationApprovalEntry[] = []
      while (cursor < entries.length) {
        const next = entries[cursor]
        if (!next || next.kind !== 'approval') break
        orphans.push(next)
        cursor += 1
      }
      const decisions = groupResolvedDecisions(orphans)
      const first = decisions[0]
      if (first) rows.push({ kind: 'approval', id: `orphan:${first.id}`, decisions })
      index = cursor - 1
    }
  }

  if (stage !== 'idle' && !pendingApproval) {
    const runningTool = findLast(
      entries,
      (entry): entry is TranscriptToolEntry => entry.kind === 'tool' && entry.status === 'running',
    )
    // Fan-out is the headline: while background agents run, the live line
    // counts them instead of naming whichever tool happened to start last.
    const runningLanes = entries.filter(
      (entry): entry is TranscriptToolEntry =>
        entry.kind === 'tool' && entry.status === 'running' && entry.subagentLane === true,
    )
    const laneLabel =
      runningLanes.length > 1
        ? `${runningLanes.length} agents working…`
        : runningLanes[0]
          ? `${subagentLaneLabel(runningLanes[0])} working…`
          : undefined
    const retry = latestAssistant?.status === 'streaming' ? latestAssistant.retry : undefined
    const compacting = latestAssistant?.status === 'streaming' && latestAssistant.compacting === true
    const label = retry
      ? retryLabel(retry)
      : compacting
        ? 'Compacting…'
        : stage === 'tool' && laneLabel
          ? laneLabel
          : stage === 'tool' && runningTool
            ? `${toolVerb(runningTool.name, true)}${toolObject(runningTool) ? ` ${toolObject(runningTool)}` : ''}…`
            : stage === 'responding'
              ? 'Replying…'
              : 'Thinking…'
    const turnTools =
      latestAssistant && stage !== 'responding' && !retry
        ? entries.filter(
            (entry): entry is TranscriptToolEntry => entry.kind === 'tool' && entry.turnId === latestAssistant.turnId,
          )
        : null
    const latestThought =
      latestAssistant?.status === 'streaming' && turnTools ? latestTurnThought(latestAssistant, turnTools) : undefined
    rows.push({
      kind: 'working',
      id: 'working-indicator-row',
      stage,
      label,
      startedAt: latestAssistant?.startedAt,
      ...(stage === 'tool' && runningLanes.length > 0 ? { agents: runningLanes.length } : {}),
      ...(latestAssistant ? { turnId: latestAssistant.turnId } : {}),
      ...(latestThought ? { latestThought } : {}),
    })
  }

  if (!previousRows.length) return rows
  const previousById = new Map(previousRows.map((row) => [row.id, row]))
  return rows.map((row) => {
    const previous = previousById.get(row.id)
    if (!previous || previous.kind !== row.kind) return row
    if (row.kind === 'user' && previous.kind === 'user' && row.entry === previous.entry) return previous
    if (row.kind === 'assistant' && previous.kind === 'assistant') {
      const sameTools =
        row.tools.length === previous.tools.length && row.tools.every((tool, index) => tool === previous.tools[index])
      const sameDecisionRows = sameDecisions(row.decisions, previous.decisions)
      if (sameTools && sameDecisionRows && row.entry === previous.entry && row.modelSwitched === previous.modelSwitched)
        return previous
      // A token changes the turn's entry, not its steps or its decisions: they
      // keep their lists, so what is drawn from them is not drawn again.
      return {
        ...row,
        ...(sameTools ? { tools: previous.tools } : {}),
        ...(sameDecisionRows ? { decisions: previous.decisions } : {}),
      }
    }
    if (row.kind === 'compaction' && previous.kind === 'compaction' && row.entry === previous.entry) return previous
    if (row.kind === 'commandOutput' && previous.kind === 'commandOutput' && row.entry === previous.entry)
      return previous
    if (row.kind === 'approval' && previous.kind === 'approval' && sameDecisions(row.decisions, previous.decisions))
      return previous
    if (
      row.kind === 'working' &&
      previous.kind === 'working' &&
      row.stage === previous.stage &&
      row.label === previous.label &&
      row.startedAt === previous.startedAt &&
      row.turnId === previous.turnId &&
      row.latestThought === previous.latestThought
    )
      return previous
    return row
  })
}

function sameDecisions(first: ConversationDecisionRow[], second: ConversationDecisionRow[]): boolean {
  return (
    first.length === second.length &&
    first.every((item, index) => {
      const prior = second[index]
      if (!prior || item.kind !== prior.kind || item.id !== prior.id) return false
      if (item.kind === 'decision' && prior.kind === 'decision') return item.entry === prior.entry
      if (item.kind === 'decisionGroup' && prior.kind === 'decisionGroup') {
        return (
          item.status === prior.status &&
          item.label === prior.label &&
          item.entries.length === prior.entries.length &&
          item.entries.every((entry, offset) => entry === prior.entries[offset])
        )
      }
      return false
    })
  )
}
