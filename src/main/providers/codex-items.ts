import type { ConversationToolKind } from '../../shared/conversation-runtime'
import { toolImagesNotShown, toolResultImages, type ToolResultImage } from './tool-result-images'
import type { ThreadItem, TurnPlanUpdatedNotification } from './codex-protocol'

type RecordValue = Record<string, unknown>
export type CodexTool = { name: string; kind: ConversationToolKind; input: RecordValue }
export type CodexToolResult = {
  output: unknown
  status: 'ok' | 'error' | 'declined'
  exitCode?: number
  /** Pictures the step returned, for the adapter to write to disk (tool-result-images.ts). */
  images?: ToolResultImage[]
}

// Every item type Codex can send is named here, so regenerating the protocol
// types after a Codex upgrade that adds one fails the typecheck at this switch
// instead of the new item vanishing from the chat.
function unhandled(item: never): null {
  void item
  return null
}

/**
 * The step row a Codex item draws, or null for an item that is not a step:
 * text and thinking, which stream on their own, markers, and the subagent
 * traffic the agent lanes carry.
 */
export function codexTool(item: ThreadItem): CodexTool | null {
  switch (item.type) {
    case 'commandExecution':
      return { name: 'Bash', kind: 'command', input: { command: item.command, cwd: item.cwd } }
    case 'fileChange':
      return {
        name: 'Edit',
        kind: 'file_edit',
        input: {
          // A move names its destination only in the change's kind; the
          // destination is a file the change writes, so it rides with it.
          edits: (Array.isArray(item.changes) ? item.changes : []).map((change) => ({
            path: change.path,
            patch: change.diff,
            ...(change.kind?.type === 'update' && change.kind.move_path ? { movePath: change.kind.move_path } : {}),
          })),
        },
      }
    case 'mcpToolCall':
      return { name: `mcp__${item.server}__${item.tool}`, kind: 'mcp', input: record(item.arguments) }
    case 'webSearch':
      return {
        name: 'WebSearch',
        kind: 'web',
        input: { query: item.query ?? record(item.action).query ?? '', action: item.action },
      }
    // A plan Codex proposes in plan mode is prose; its text is the step's output.
    case 'plan':
      return { name: 'Plan', kind: 'other', input: {} }
    case 'dynamicToolCall':
      return { name: item.tool || 'Tool', kind: 'other', input: record(item.arguments) }
    // Codex waits between retries of a tool; the row says why the turn is quiet.
    case 'sleep':
      return { name: 'Sleep', kind: 'other', input: { durationMs: item.durationMs } }
    case 'imageView':
      return { name: 'Read', kind: 'file_read', input: { path: item.path } }
    // The picture itself is written to disk by the adapter, which adds its path.
    case 'imageGeneration':
      return {
        name: 'GenerateImage',
        kind: 'other',
        input: { ...(item.revisedPrompt ? { prompt: item.revisedPrompt } : {}) },
      }
    // The output of a call Codex made through a tool namespace of its own. The
    // call it answers is not an item, so there is no step to attach it to.
    case 'functionCallOutput':
    // Subagents are lanes, opened and closed by the adapter from these.
    case 'collabAgentToolCall':
    case 'subAgentActivity':
    case 'userMessage':
    case 'hookPrompt':
    case 'agentMessage':
    case 'reasoning':
    case 'enteredReviewMode':
    case 'exitedReviewMode':
    case 'contextCompaction':
      return null
    default:
      return unhandled(item)
  }
}

/** What a finished step returned, and whether it worked. */
export function codexToolResult(item: ThreadItem): CodexToolResult {
  const status = 'status' in item ? String(item.status) : ''
  const base: CodexToolResult['status'] = status === 'declined' ? 'declined' : status === 'failed' ? 'error' : 'ok'
  switch (item.type) {
    case 'commandExecution':
      return {
        output: item.aggregatedOutput ?? '',
        status: base,
        ...(typeof item.exitCode === 'number' ? { exitCode: item.exitCode } : {}),
      }
    case 'mcpToolCall': {
      if (item.error) return { output: item.error.message, status: 'error' }
      // A result with pictures (a screenshot) has them taken out to be shown,
      // never left in as base64 for the transcript to print, and its words
      // are the output, with a line for any picture past those kept. Any other
      // result is handed on whole, as it always was.
      const content = item.result?.content ?? []
      const images = toolResultImages(content)
      if (images.length === 0) return { output: item.result ?? '', status: base }
      const words = [
        ...content.map((entry) => {
          const block = entry && typeof entry === 'object' && !Array.isArray(entry) ? entry : null
          return block?.type === 'text' && typeof block.text === 'string' ? block.text : ''
        }),
        toolImagesNotShown(content, images.length),
      ]
        .filter(Boolean)
        .join('\n')
      return { output: words, status: base, images }
    }
    case 'dynamicToolCall':
      return {
        output: (item.contentItems ?? [])
          .map((content) => (content.type === 'inputText' ? content.text : ''))
          .filter(Boolean)
          .join('\n'),
        status: item.success === false ? 'error' : base,
      }
    case 'plan':
      return { output: item.text, status: 'ok' }
    // Never the base64 picture: it is on disk, and the transcript keeps its path.
    case 'imageGeneration':
      return item.failure
        ? { output: imageGenerationFailure(item.failure.resetsAt), status: 'error' }
        : { output: '', status: base }
    default:
      return { output: '', status: base }
  }
}

function imageGenerationFailure(resetsAt: number | null): string {
  if (!resetsAt) return 'Codex has reached its image generation limit.'
  const when = new Date(resetsAt * 1000).toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' })
  return `Codex has reached its image generation limit. It resets ${when}.`
}

/** Codex's `update_plan` as the checklist a plan step draws. */
export function codexPlanInput(update: TurnPlanUpdatedNotification): RecordValue {
  return {
    ...(update.explanation ? { explanation: update.explanation } : {}),
    todos: update.plan.map((step) => ({
      content: step.step,
      status: step.status === 'inProgress' ? 'in_progress' : step.status,
    })),
  }
}

function record(value: unknown): RecordValue {
  return value && typeof value === 'object' && !Array.isArray(value) ? (value as RecordValue) : {}
}
