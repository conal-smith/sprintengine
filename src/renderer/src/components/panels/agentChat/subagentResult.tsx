// What a background agent came back with. The spawning call's own output is the
// agent's final report — the reason it was sent — so a settled lane shows its
// first line under the header, and opens onto the whole report. A lane that
// failed says so in words and in the error ink, never only by a glyph's colour.

import React, { useState } from 'react'
import type { ConversationJsonValue } from '../../../../../shared/conversation-runtime'
import { GhostButton, InlineNotice, RowButton, Spinner } from '../../ui'
import type { TranscriptToolEntry } from './conversationProjection'
import { ConversationMarkdown, useConversationLinkContext } from './conversationLinks'
import { useConversationDisclosure } from './conversationViewState'
import { useConversationTransport } from './conversationTransport'
import { ChevronRightGlyph } from './toolRows/ToolKindGlyph'
import { ToolPanel } from './toolRows/ToolRow'

/** The report's first line of prose, with the markdown that opens it dropped. */
export function subagentResultPreview(output: string | undefined): string {
  const line = output?.split(/\r?\n/u).find((candidate) => candidate.trim()) ?? ''
  return line
    .trim()
    .replace(/^(?:#{1,6}\s+|[-*+]\s+|>\s*|\d+[.)]\s+)/u, '')
    .replace(/^(\*\*|__)(.+)\1$/u, '$2')
    .trim()
}

// How the lane ended when it did not simply finish, as the header words it.
export function subagentOutcomeWord(tool: TranscriptToolEntry): string | undefined {
  if (tool.status === 'running') return undefined
  if (tool.outputStatus === 'error') return 'failed'
  if (tool.outputStatus === 'stopped') return 'stopped'
  if (tool.outputStatus === 'declined') return 'declined'
  return undefined
}

// The model the call asked the agent to run on, when it named one; otherwise
// the agent ran on the conversation's own and there is nothing to add.
export function subagentModel(tool: TranscriptToolEntry): string | undefined {
  const input = tool.input
  if (!input || typeof input !== 'object' || Array.isArray(input)) return undefined
  const model = input.model
  return typeof model === 'string' && model.trim() ? model.trim() : undefined
}

// The level names the effort picker shows for Claude Code
// (resources/plugins/claude-code/plugin.json), so a lane says "Extra high"
// where the composer does rather than the flag's `xhigh`.
const EFFORT_LABELS: Record<string, string> = {
  low: 'Low',
  medium: 'Medium',
  high: 'High',
  xhigh: 'Extra high',
  max: 'Max',
}

// The reasoning effort the call asked the agent to run at, when it set one, in
// the picker's words; otherwise the agent ran at the conversation's own, and
// there is nothing to add — the same rule the model follows.
export function subagentEffort(tool: TranscriptToolEntry): string | undefined {
  const input = tool.input
  if (!input || typeof input !== 'object' || Array.isArray(input)) return undefined
  const effort = input.effort
  if (typeof effort !== 'string' || !effort.trim()) return undefined
  const level = effort.trim()
  return EFFORT_LABELS[level.toLowerCase()] ?? level
}

/** What the agent was asked to run on — "haiku · High effort", either alone, or nothing. */
export function subagentRunsOn(tool: TranscriptToolEntry): string | undefined {
  const effort = subagentEffort(tool)
  return [subagentModel(tool), effort ? `${effort} effort` : undefined].filter(Boolean).join(' · ') || undefined
}

function text(value: ConversationJsonValue | undefined): string {
  return typeof value === 'string' ? value : value == null ? '' : JSON.stringify(value, null, 2)
}

export function SubagentLaneResult({ tool }: { tool: TranscriptToolEntry }) {
  const context = useConversationLinkContext()
  const transport = useConversationTransport()
  const [open, setOpen] = useConversationDisclosure(
    `${context?.workspaceId ?? ''}:${context?.agentId ?? ''}`,
    `lane-report:${tool.id}`,
    false,
  )
  // The stored preview keeps a long report's beginning; the rest is fetched on
  // request, as a tool row fetches its full output.
  const [full, setFull] = useState<string>()
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string>()
  const failed = tool.outputStatus === 'error'
  const report = (full ?? tool.output ?? '').trim()
  const preview = subagentResultPreview(report)
  if (tool.status === 'running' || !preview) return null
  async function fetchFull() {
    if (!context?.agentId) return
    setLoading(true)
    setError(undefined)
    try {
      const result = await transport.toolDetail({
        workspaceRoot: context.workspaceRoot,
        workspaceId: context.workspaceId,
        agentId: context.agentId,
        toolUseId: tool.id,
      })
      if (result.ok) setFull(text(result.detail.output))
      else setError(result.message)
    } catch (failure) {
      setError(failure instanceof Error ? failure.message : 'Could not load the full report')
    } finally {
      setLoading(false)
    }
  }
  const ink = failed
    ? 'text-[color:var(--tone-error)]'
    : 'text-[color:var(--text-subtle)] group-hover/tool-row:text-[color:var(--text-muted)]'
  return (
    <div className="ml-6 min-w-0">
      <div className="group/tool-row min-w-0 rounded-sm transition-colors hover:bg-[color:var(--bg-hover)]">
        <RowButton
          density="flush"
          className="min-w-0 gap-1 text-meta"
          aria-expanded={open}
          aria-label={`${failed ? 'Error' : 'Report'}: ${preview}`}
          onClick={() => setOpen(!open)}
        >
          {open ? (
            <span className={`min-w-0 ${ink}`}>{failed ? 'Error' : 'Report'}</span>
          ) : (
            <span className={`min-w-0 truncate ${ink}`}>{preview}</span>
          )}
          <ChevronRightGlyph
            className={`icon-xs ml-auto shrink-0 text-[color:var(--text-disabled)] transition-transform group-hover/tool-row:text-[color:var(--text-subtle)] ${open ? 'rotate-90' : ''}`}
          />
        </RowButton>
      </div>
      {open ? (
        <div className="mb-1.5 mt-1 flex flex-col items-start gap-1.5 text-meta [&>*]:w-full">
          <ToolPanel mono={false} copyText={report}>
            <ConversationMarkdown text={report} />
          </ToolPanel>
          {loading ? <Spinner label="Loading the full report" /> : null}
          {error ? (
            <InlineNotice
              tone="error"
              action={
                <GhostButton size="inline" onClick={() => void fetchFull()}>
                  Retry
                </GhostButton>
              }
            >
              {error}
            </InlineNotice>
          ) : null}
          {tool.truncated && full === undefined && !loading && !error && context?.agentId ? (
            <GhostButton size="inline" align="start" onClick={() => void fetchFull()}>
              Show full report
            </GhostButton>
          ) : null}
        </div>
      ) : null}
    </div>
  )
}
