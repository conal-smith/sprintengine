import type { TranscriptToolEntry } from './conversationProjection.js'
import { presentToolItem, type PresentableTool } from './protocol.js'

// How a tool step reads, without drawing it: the shape the shared wording
// takes, and whether the step went wrong. The fold that summarises a turn
// counts the steps that went wrong, and every view draws them the same way,
// so the rule lives here rather than in any one view's row.

/** A step as the shared presentation reads it. */
export function toolPresentationInput(tool: TranscriptToolEntry): PresentableTool {
  return {
    kind: tool.toolKind,
    name: tool.name,
    input: tool.input,
    status: tool.status === 'running' ? 'running' : (tool.outputStatus ?? 'ok'),
    exitCode: tool.exitCode,
    summary: tool.summary,
    subagentType: tool.subagentType,
    ...(tool.displayTitle ? { displayTitle: tool.displayTitle } : {}),
    ...(tool.serverName ? { serverName: tool.serverName } : {}),
  }
}

/** Whether a finished step went wrong: a non-zero exit, or an outcome the presentation tones as an error. */
export function stepWentWrong(tool: TranscriptToolEntry): boolean {
  if (tool.status === 'running') return false
  if (tool.exitCode) return true
  return presentToolItem(toolPresentationInput(tool)).tone === 'error'
}
