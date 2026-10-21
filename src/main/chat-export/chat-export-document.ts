import {
  projectConversation,
  type TranscriptEntry,
  type TranscriptToolEntry,
} from '../../../packages/conversation-timeline/src/conversationProjection'
import {
  DECISION_VERB,
  deriveConversationTimelineRows,
  flattenToolEntries,
  subagentLaneLabel,
  toolObject,
  type ConversationDecisionRow,
  type ConversationTimelineRow,
} from '../../../packages/conversation-timeline/src/conversationTimeline'
import { formatStepDuration } from '../../../packages/conversation-timeline/src/stepDuration'
import { stepWentWrong, toolPresentationInput } from '../../../packages/conversation-timeline/src/stepOutcome'
import { presentToolItem, summarizeToolGroup } from '../../shared/conversation/presentation'
import type { ConversationEvent } from '../../shared/conversation-runtime'
import { STUDIO_PRODUCT_NAME } from '../../shared/product-identity'
import { parseExportMarkdown } from './chat-export-markdown-parse'

// A chat as an export reads it: the one model the Markdown, Word and PDF
// writers all write from, so the three never disagree about what the chat
// said. It is built from the chat's transcript by the same projection and
// timeline the chat view draws (`@sprintengine/conversation-timeline`), so a
// turn the view hides (one taken back with Edit from here) is not in it, and a
// step is labelled as its row is.
//
// What it keeps, and what it leaves for the chat:
//
// - the person's messages, with when they were sent and the pictures they
//   attached;
// - each reply as it was written, its prose between steps included, in order;
// - each run of steps as the one line its row shows ("Ran npm script test",
//   "Read 3 files and edited 2 files"), never the step's output;
// - each agent a turn sent off as one line: what kind, what for, how it ended;
// - each decision answered as one line, and a plan that was approved as the
//   plan it was;
// - a turn that failed or was stopped, as a line saying so.
//
// Reasoning is not in it, nor is anything the chat says about itself rather
// than the conversation: Studio's own notices, compactions, usage, retries,
// session bookkeeping.

export type ExportTableAlign = 'left' | 'center' | 'right' | null
export type ExportAlert = 'note' | 'tip' | 'important' | 'warning' | 'caution'

export type ExportInline =
  | { kind: 'text'; text: string }
  | { kind: 'strong' | 'emphasis' | 'delete'; children: ExportInline[] }
  | { kind: 'code'; text: string }
  | { kind: 'math'; tex: string }
  | { kind: 'link'; href: string; children: ExportInline[] }
  /** A picture a reply links to. No writer fetches it: it is written as the link it is. */
  | { kind: 'image'; alt: string; src: string }
  | { kind: 'break' }

export type ExportListItem = { checked?: boolean; blocks: ExportBlock[] }

export type ExportBlock =
  | { kind: 'heading'; level: 1 | 2 | 3 | 4 | 5 | 6; content: ExportInline[] }
  | { kind: 'paragraph'; content: ExportInline[] }
  | { kind: 'list'; ordered: boolean; start?: number; items: ExportListItem[] }
  | { kind: 'code'; language?: string; text: string }
  | { kind: 'math'; tex: string }
  | { kind: 'table'; align: ExportTableAlign[]; head: ExportInline[][]; rows: ExportInline[][][] }
  | { kind: 'quote'; alert?: ExportAlert; blocks: ExportBlock[] }
  | { kind: 'rule' }

/** A picture the person attached. `data` is absent when the attachment could not be read back. */
export type ExportImage = {
  id: string
  name: string
  mediaType: string
  data?: Uint8Array
}

/** One piece of a reply, in the order it happened. */
export type ExportPart =
  | { kind: 'prose'; blocks: ExportBlock[] }
  /** A run of steps as one line, and how many of them went wrong. */
  | { kind: 'steps'; text: string; failed: number }
  /** An agent the turn sent off. */
  | { kind: 'agent'; text: string }
  /** A decision answered, or how a turn ended when it did not end well. */
  | { kind: 'note'; text: string; tone?: 'error' }

export type ExportMessage =
  | {
      kind: 'user'
      id: string
      author: string
      at?: number
      blocks: ExportBlock[]
      images: ExportImage[]
      /** Files attached by path, by their paths. */
      files: string[]
    }
  | { kind: 'assistant'; id: string; author: string; at?: number; parts: ExportPart[] }

export type ChatExportDocument = {
  title: string
  project: string | null
  engine: string | null
  model: string | null
  /** When the first message was sent and the last event recorded; absent for a chat with neither. */
  startedAt?: number
  endedAt?: number
  exportedAt: number
  /** How dates and times are written, so a document reads the same wherever it is written. */
  locale: string
  timeZone: string
  generator: string
  messages: ExportMessage[]
}

/** What the export knows about the chat besides its transcript. */
export type ChatExportMeta = {
  title: string
  project: string | null
  /** The agent CLI the chat runs on, by name ("Claude Code"). */
  engine: string | null
  /** The model the chat is set to, used when no turn recorded the one it ran on. */
  model: string | null
  /** The folder the chat works in, so a step's file reads as a path in it. */
  workspaceRoot: string | null
  exportedAt: number
  locale: string
  timeZone: string
}

export type ChatExportSource = {
  events: readonly ConversationEvent[]
  /** The attached pictures the transcript names, by their store reference; one missing is one not read. */
  attachments: ReadonlyMap<string, { mediaType: string; data: Uint8Array }>
}

/** What the person is called in an export, as the chat calls them. */
export const EXPORT_USER_AUTHOR = 'You'

export function buildChatExportDocument(source: ChatExportSource, meta: ChatExportMeta): ChatExportDocument {
  const projection = projectConversation(source.events)
  const rows = deriveConversationTimelineRows(projection.entries, false)
  const assistantName = meta.engine ?? 'Agent'
  const messages: ExportMessage[] = []
  for (const row of rows) {
    const message = messageOf(row, source, meta, assistantName)
    if (message) messages.push(message)
  }
  const modelId = latestModel(projection.entries) ?? meta.model
  const firstAt = messages.find((message) => message.at !== undefined)?.at
  const lastAt = source.events.reduce<number | undefined>(
    (latest, event) =>
      Number.isFinite(event.createdAt) && event.createdAt > (latest ?? -Infinity) ? event.createdAt : latest,
    undefined,
  )
  return {
    title: meta.title.trim() || 'Chat',
    project: meta.project,
    engine: meta.engine,
    model: modelId && modelId !== 'default' ? modelId : null,
    ...(firstAt !== undefined ? { startedAt: firstAt } : {}),
    ...(lastAt !== undefined ? { endedAt: lastAt } : {}),
    exportedAt: meta.exportedAt,
    locale: meta.locale,
    timeZone: meta.timeZone,
    generator: STUDIO_PRODUCT_NAME,
    messages,
  }
}

/** Whether a document has anything to export: a message from either side. */
export function chatExportHasMessages(document: ChatExportDocument): boolean {
  return document.messages.length > 0
}

function messageOf(
  row: ConversationTimelineRow,
  source: ChatExportSource,
  meta: ChatExportMeta,
  assistantName: string,
): ExportMessage | null {
  switch (row.kind) {
    case 'user': {
      const entry = row.entry
      // Studio's own notices are the app talking about the chat, not the chat.
      if (entry.origin?.kind === 'studio') return null
      const images: ExportImage[] = (entry.storedAttachments ?? []).map((attachment) => {
        const stored = source.attachments.get(attachment.ref)
        return {
          id: attachment.id,
          name: attachment.name?.trim() || 'Attached image',
          mediaType: stored?.mediaType ?? attachment.mediaType,
          ...(stored ? { data: stored.data } : {}),
        }
      })
      const files = (entry.files ?? []).map((file) => file.path)
      const blocks = parseExportMarkdown(entry.text)
      if (!blocks.length && !images.length && !files.length) return null
      return {
        kind: 'user',
        id: entry.id,
        author: EXPORT_USER_AUTHOR,
        ...(entry.createdAt !== undefined ? { at: entry.createdAt } : {}),
        blocks,
        images,
        files,
      }
    }
    case 'assistant': {
      const parts = assistantParts(row, meta)
      if (!parts.length) return null
      return {
        kind: 'assistant',
        id: row.id,
        author: assistantName,
        ...(row.entry.startedAt !== undefined ? { at: row.entry.startedAt } : {}),
        parts,
      }
    }
    case 'commandOutput': {
      // A command the CLI ran by itself (`/context`): what it was, not what it printed.
      const entry = row.entry
      const text = entry.note ? entry.output.trim() : entry.command ? `Ran /${entry.command}` : ''
      if (!text) return null
      return {
        kind: 'assistant',
        id: row.id,
        author: assistantName,
        at: entry.createdAt,
        parts: [entry.note ? { kind: 'note', text } : { kind: 'steps', text, failed: 0 }],
      }
    }
    // Requests no turn claimed, compactions and the live line are the chat's
    // own bookkeeping.
    default:
      return null
  }
}

function assistantParts(
  row: Extract<ConversationTimelineRow, { kind: 'assistant' }>,
  meta: ChatExportMeta,
): ExportPart[] {
  const { entry, tools } = row
  const parts: ExportPart[] = []
  const prose = (text: string) => {
    const blocks = parseExportMarkdown(text)
    if (blocks.length) parts.push({ kind: 'prose', blocks })
  }
  // The steps since the last prose, folded into one line when it closes.
  let run: TranscriptToolEntry[] = []
  const flush = () => {
    const line = stepsLine(run, meta)
    if (line) parts.push(line)
    run = []
  }
  for (const tool of tools) {
    const before = entry.intermediateText?.filter((part) => part.beforeToolUseId === tool.id) ?? []
    if (before.some((part) => part.text.trim())) {
      flush()
      for (const part of before) prose(part.text)
    }
    // An agent the turn sent off is a line of its own, after the work.
    if (!tool.subagentLane) run.push(tool)
  }
  flush()
  for (const lane of tools.filter((tool) => tool.subagentLane)) parts.push({ kind: 'agent', text: agentLine(lane) })
  for (const decision of row.decisions) parts.push(...decisionParts(decision))
  prose(entry.text)
  if (entry.status === 'failed') {
    const reason = entry.failureDetail?.trim() || entry.failureReason?.trim()
    parts.push({
      kind: 'note',
      tone: 'error',
      text: reason ? `The turn failed: ${firstLine(reason)}` : 'The turn failed',
    })
  } else if (entry.status === 'interrupted') parts.push({ kind: 'note', text: 'Interrupted' })
  return parts
}

/**
 * A run of steps as the chat's row says it: one step by its own label, more
 * than one by the summary their group shows, each with how many went wrong.
 */
export function stepsLine(
  tools: readonly TranscriptToolEntry[],
  context: { workspaceRoot: string | null },
): Extract<ExportPart, { kind: 'steps' }> | null {
  if (!tools.length) return null
  const failed = flattenToolEntries([...tools]).filter(stepWentWrong).length
  if (tools.length > 1) return { kind: 'steps', text: summarizeToolGroup(tools.map(toolPresentationInput)), failed }
  return { kind: 'steps', text: stepLabel(tools[0]!, context), failed }
}

function stepLabel(tool: TranscriptToolEntry, context: { workspaceRoot: string | null }): string {
  const presentation = presentToolItem(toolPresentationInput(tool))
  const fileStep =
    presentation.icon === 'file_read' || presentation.icon === 'file_edit' || presentation.icon === 'file_write'
  // A file step names its file where it is in the project, which a reader with
  // no chat beside them needs: "Edited src/export.ts", not "Edited export.ts".
  const path = fileStep && presentation.subtitle && !tool.exitCode ? projectPath(presentation.subtitle, context) : ''
  return path ? `${presentation.verb} ${path}` : presentation.title
}

function projectPath(path: string, context: { workspaceRoot: string | null }): string {
  const root = context.workspaceRoot?.replace(/\\/gu, '/').replace(/\/+$/u, '')
  const file = path.replace(/\\/gu, '/')
  if (!root || !file.startsWith(`${root}/`)) return path
  return file.slice(root.length + 1)
}

// What the chat's agent card says: the kind of agent, what it was sent to do,
// and how it ended (agentChat/subagentStatus.tsx says it the same way).
function agentLine(lane: TranscriptToolEntry): string {
  const task = toolObject(lane) || describedTask(lane)
  const steps = flattenToolEntries(lane.children ?? []).length
  const outcome = laneOutcome(lane)
  return [
    `${subagentLaneLabel(lane)}${task ? `: ${task}` : ''}`,
    outcome,
    ...(steps ? [`${steps} ${steps === 1 ? 'step' : 'steps'}`] : []),
  ]
    .filter(Boolean)
    .join(' · ')
}

function describedTask(lane: TranscriptToolEntry): string {
  const input = lane.input
  const described =
    input && typeof input === 'object' && !Array.isArray(input) && typeof input.description === 'string'
      ? input.description.trim()
      : ''
  return described || lane.agent?.description || ''
}

function laneOutcome(lane: TranscriptToolEntry): string {
  if (lane.status === 'running') return 'Working'
  if (lane.agent?.state === 'unknown') return 'Ran in the background'
  if (lane.outputStatus === 'declined') return 'Declined'
  const ms =
    lane.startedAt !== undefined && lane.completedAt !== undefined
      ? Math.max(0, lane.completedAt - lane.startedAt)
      : lane.agent?.usage?.durationMs || undefined
  const took = ms !== undefined ? formatStepDuration(ms) : undefined
  if (lane.agent?.state === 'failed' || lane.outputStatus === 'error') return took ? `Failed after ${took}` : 'Failed'
  if (lane.agent?.state === 'stopped' || lane.outputStatus === 'stopped')
    return took ? `Stopped after ${took}` : 'Stopped'
  return took ? `Done in ${took}` : 'Done'
}

// A decision as the chat's record of it says it: the outcome of a batch of
// permissions in one line, a question with the answer chosen, and a plan as
// the plan itself, which is what the turn's work went on to follow.
function decisionParts(row: ConversationDecisionRow): ExportPart[] {
  if (row.kind === 'decisionGroup') return [{ kind: 'note', text: row.label }]
  const entry = row.entry
  if (entry.requestKind === 'question' && entry.questions?.length) {
    return entry.questions.map((question) => {
      const answer = entry.answers?.[question.question]
      return {
        kind: 'note' as const,
        text:
          entry.status === 'approved' && answer
            ? `${question.question} — ${answer}`
            : `${question.question} — dismissed without answering`,
      }
    })
  }
  if (entry.requestKind === 'plan') {
    const verdict =
      entry.status === 'approved'
        ? 'Plan approved'
        : entry.status === 'denied'
          ? 'Sent back for more planning'
          : 'Cancelled with the turn'
    const blocks = entry.plan?.trim() ? parseExportMarkdown(entry.plan) : []
    return [...(blocks.length ? [{ kind: 'prose' as const, blocks }] : []), { kind: 'note', text: verdict }]
  }
  const verdict = entry.autoApproved
    ? `Auto-approved: ${entry.ruleLabel ?? 'matching permission rule'}`
    : entry.status === 'pending'
      ? ''
      : DECISION_VERB[entry.status]
  if (!verdict) return []
  return [{ kind: 'note', text: `${verdict}: ${firstLine(entry.summary)}` }]
}

function latestModel(entries: readonly TranscriptEntry[]): string | undefined {
  for (let index = entries.length - 1; index >= 0; index -= 1) {
    const entry = entries[index]
    if (entry?.kind === 'assistant' && entry.modelId) return entry.modelId
  }
  return undefined
}

function firstLine(text: string): string {
  return text.trim().split(/\r?\n/u, 1)[0] ?? ''
}
