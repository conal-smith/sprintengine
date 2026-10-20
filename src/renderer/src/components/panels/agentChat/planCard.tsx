// A plan the agent proposed, kept in the transcript after it is answered. The
// dock shows the plan while it waits for a decision; once decided, this card is
// where it can still be found, so an approved plan does not vanish with its
// request.
//
// The card is the plan's place in the conversation, not where it is read. A
// plan is a document — headings, phases, file lists — and it reads as one in
// the workspace pane, opened beside the chat as a Document tab. The card keeps
// the title and the opening lines, and a long plan fades out under them
// rather than unrolling a wall of text between tool rows.

import React, { useRef, useState } from 'react'
import { useWorkspaceStore } from '../../../store/workspaceStore'
import { showToast } from '../../../store/toastStore'
import { useRevealMatch } from '../../../utils/revealMatch'
import { markdownClipboardHtml } from '../../../utils/markdownClipboardHtml'
import { Badge, CopyGlyphButton, GhostButton } from '../../ui'
import { CHAT_FIND_SEGMENT_ATTRIBUTE } from './chatFindSegment'
import { ConversationMarkdown, useConversationLinkContext } from './conversationLinks'
import type { ChatServices } from './chatServices'
import { useConversationTransport } from './conversationTransport'

const HEADING = /^\s{0,3}#{1,6}\s+(.+?)\s*#*\s*$/u

// Past this a plan rests as a preview: about a screenful of prose, or a list
// long enough that the answer under it would be pushed out of view.
export const PLAN_PREVIEW_MAX_LINES = 20
export const PLAN_PREVIEW_MAX_CHARS = 900

/** The plan's own name: its first heading, when it has one. */
export function planTitle(plan: string): string | null {
  for (const line of plan.split(/\r?\n/u)) {
    const match = HEADING.exec(line)
    if (match?.[1]) return match[1]
  }
  return null
}

/** The plan as the card shows it: a leading heading is already the card's title. */
export function planBody(plan: string): string {
  const lines = plan.trim().split(/\r?\n/u)
  if (lines[0] && HEADING.test(lines[0])) lines.shift()
  return lines.join('\n').trim()
}

export function planIsLong(plan: string): boolean {
  return plan.length > PLAN_PREVIEW_MAX_CHARS || plan.split(/\r?\n/u).length > PLAN_PREVIEW_MAX_LINES
}

type PlanDocumentTarget = { workspaceId: string; workspaceRoot: string; agentId: string; planFilePath?: string }

async function openPlanInPane(services: ChatServices, target: PlanDocumentTarget, plan: string): Promise<void> {
  const title = planTitle(plan) ?? 'Proposed plan'
  const failed = (description: string) =>
    void showToast({ tone: 'error', title: 'Couldn’t open the plan', description })
  try {
    const result = await services.planDocument({ ...target, plan, title })
    if (!result.ok) return failed(result.message)
    useWorkspaceStore.getState().openPaneTab(target.workspaceId, {
      kind: 'document',
      title,
      document: { path: result.path },
    })
  } catch (error) {
    failed(error instanceof Error ? error.message : String(error))
  }
}

/**
 * Opens a plan in the workspace pane, or null outside a conversation that can
 * say whose plan it is. The agent's own plan file is offered only when the
 * agent runs on this machine: a remote agent's path names a file on its host.
 */
export function usePlanOpener(): ((plan: string, planFilePath?: string) => void) | null {
  const context = useConversationLinkContext()
  const transport = useConversationTransport()
  if (!context?.agentId) return null
  const { workspaceId, workspaceRoot, agentId } = context
  const local = transport.kind === 'local'
  return (plan, planFilePath) =>
    void openPlanInPane(
      transport.services,
      { workspaceId, workspaceRoot, agentId, ...(local && planFilePath ? { planFilePath } : {}) },
      plan,
    )
}

// The pane opener's glyph: a page with an arrow leaving it to the right, the
// side the pane opens on.
function OpenInPaneGlyph({ className }: { className?: string }) {
  return (
    <svg viewBox="0 0 16 16" fill="none" className={className} aria-hidden="true">
      <rect x="2" y="3" width="12" height="10" rx="1.5" stroke="currentColor" strokeWidth="1.4" />
      <path d="M10 3v10" stroke="currentColor" strokeWidth="1.4" />
      <path d="M5 8h2.5M6.5 6.5 8 8 6.5 9.5" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" />
    </svg>
  )
}

export function OpenPlanButton({ onOpen }: { onOpen: () => void }) {
  return (
    <GhostButton size="xs" onClick={onOpen} className="shrink-0">
      <OpenInPaneGlyph className="icon-xs" />
      Open plan
    </GhostButton>
  )
}

export function ResolvedPlanCard({
  plan,
  planFilePath,
  findSegment,
}: {
  plan: string
  planFilePath?: string
  /** The plan's key in Find in chat's index (chatFind.ts). */
  findSegment?: string
}) {
  const open = usePlanOpener()
  const named = planTitle(plan)
  const title = named ?? 'Proposed plan'
  const body = planBody(plan)
  const cardRef = useRef<HTMLDivElement | null>(null)
  // A find that lands past the preview shows the whole plan, for as long as
  // the card is drawn. Not remembered, unlike a folded message: the card has
  // no control to fold it again, and its full reading is the pane's.
  const [revealed, setRevealed] = useState(false)
  // Without a pane to open it in, the card is the only place to read the plan,
  // so it shows the whole of it.
  const clamped = open !== null && planIsLong(body) && !revealed
  useRevealMatch(cardRef, clamped, () => setRevealed(true))
  // Only words the plan wrote are searched: the fallback title is the card's.
  const segment = { [CHAT_FIND_SEGMENT_ATTRIBUTE]: findSegment }
  return (
    <div
      ref={cardRef}
      data-conversation-plan=""
      className="rounded-sm border border-[color:var(--border-subtle)] bg-[color:var(--bg-surface)]"
    >
      <div className="flex items-center gap-2 px-3 pt-2">
        <Badge className="shrink-0">Plan</Badge>
        <span
          className="min-w-0 flex-1 truncate text-body font-medium text-[color:var(--text-strong)]"
          {...(named ? segment : {})}
        >
          {title}
        </span>
        {open ? <OpenPlanButton onOpen={() => open(plan, planFilePath)} /> : null}
        <CopyGlyphButton
          size="xs"
          label="Copy plan"
          text={plan.trim()}
          html={() => markdownClipboardHtml(plan.trim())}
          className="shrink-0"
        />
      </div>
      {body ? (
        <div
          className={`min-w-0 px-3 pb-2 pt-1 text-meta leading-5 ${
            clamped ? 'max-h-40 overflow-hidden [mask-image:linear-gradient(to_bottom,black_50%,transparent)]' : ''
          }`}
          {...segment}
        >
          <ConversationMarkdown text={body} size="compact" />
        </div>
      ) : (
        <div className="pb-2" />
      )}
    </div>
  )
}
