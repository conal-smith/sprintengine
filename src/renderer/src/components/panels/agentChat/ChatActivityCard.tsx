import React, { useCallback, useEffect, useMemo, type JSX } from 'react'

import { useWorkspaceStore } from '../../../store/workspaceStore'
import { selectModuleEnabled } from '../../../modules'
import { dispatchFileReveal } from '../../../utils/fileReveal'
import { DiffStatPill, OutlineButton, Popover, RowButton, Tooltip } from '../../ui'
import { OVERLAY_SURFACE_CLASS } from '../../ui/tokens'
import {
  AgentsGlyph,
  BrowserGlyph,
  CanvasGlyph,
  DiffGlyph,
  FilesGlyph,
  LibraryGlyph,
} from '../../workspace/pane/paneKinds'
import { openAgentsPane } from '../../workspace/pane/agents/agentsPaneFocus'
import type { TranscriptEntry } from './conversationProjection'
import { deriveChatActivity, sharedEditFolder, type ChatActivity, type ChatActivityKind } from './chatActivity'
import {
  markRowSeen,
  publishChatActivity,
  rowSeen,
  useChatActivity,
  type ChatActivityRow,
  type PublishedChatActivity,
} from './chatActivityStore'

// The card on the right of a chat that lists what the agent touched — the
// files it changed and where they sit, the page it drove, the board it drew
// on, the agents it sent off and the pictures in the chat — each row opening
// the workspace pane on that tab, so none of it is a hunt through the pane's
// strip after a run. Docked at the top right of the transcript while the chat
// has room for it; where it has not (a narrow window, or the pane open beside
// it), it condenses to a pill of the rows' glyphs in the title bar, which
// drops the same rows down.

/** The transcript width from which the card docks rather than condensing to the pill. */
export const ACTIVITY_CARD_DOCK_MIN_WIDTH = 860
/** The card's width, and the room the transcript keeps clear for it while it is docked. */
export const ACTIVITY_CARD_WIDTH = 264

const GLYPHS: Record<ChatActivityKind, (props: { className?: string }) => JSX.Element> = {
  changes: DiffGlyph,
  files: FilesGlyph,
  browser: BrowserGlyph,
  canvas: CanvasGlyph,
  agents: AgentsGlyph,
  library: LibraryGlyph,
}

const PANE_KIND: Record<ChatActivityKind, string> = {
  changes: 'diff',
  files: 'files',
  browser: 'browser',
  canvas: 'canvas',
  agents: 'agents',
  library: 'library',
}

const plural = (count: number, word: string) => `${count} ${word}${count === 1 ? '' : 's'}`

function hostOf(url: string | null): string | null {
  if (!url) return null
  try {
    return new URL(/^[a-z]+:\/\//iu.test(url) ? url : `http://${url}`).host || url
  } catch {
    return url
  }
}

/** What each row says, from the activity and the checkout's own counts. */
export function chatActivityRows(
  activity: ChatActivity,
  facts: {
    diff: { added: number; removed: number } | null
    workspaceRoot: string | null
    seen: (kind: ChatActivityKind, version: string) => boolean
  },
): Array<ChatActivityRow & { version: string }> {
  return activity.order.map((kind) => {
    const row = (
      label: string,
      meta: string | null,
      live: boolean,
      version: string,
      diff?: ChatActivityRow['diff'],
    ): ChatActivityRow & { version: string } => ({
      kind,
      label,
      meta,
      live,
      version,
      unseen: !facts.seen(kind, version),
      ...(diff ? { diff } : {}),
    })
    switch (kind) {
      case 'changes': {
        const files = activity.edits.paths.length
        return row(
          files ? `Changes · ${plural(files, 'file')}` : 'Changes',
          null,
          activity.edits.live,
          `${files}:${facts.diff?.added ?? ''}:${facts.diff?.removed ?? ''}`,
          facts.diff ?? undefined,
        )
      }
      case 'files': {
        const folder = sharedEditFolder(activity.edits.paths, facts.workspaceRoot)
        return row('Files', folder, activity.edits.live, activity.edits.paths.join('\n'))
      }
      case 'browser': {
        const live = activity.browser?.live ?? false
        return row(
          'Browser',
          live ? 'Agent here' : hostOf(activity.browser?.url ?? null),
          live,
          activity.browser?.url ?? '',
        )
      }
      case 'canvas': {
        const live = activity.canvas?.live ?? false
        return row('Canvas', live ? 'Drawing' : (activity.canvas?.board ?? null), live, activity.canvas?.board ?? '')
      }
      case 'agents': {
        const agents = activity.agents ?? { total: 0, working: 0 }
        return row(
          `Agents · ${agents.total}`,
          agents.working ? `${agents.working} working` : 'All done',
          agents.working > 0,
          `${agents.total}:${agents.working}`,
        )
      }
      case 'library':
        return row('Library', plural(activity.images.length, 'image'), false, String(activity.images.length))
    }
  })
}

/**
 * Derives the chat's rows, publishes them for the title bar's pill, and
 * answers what the chat itself draws. Called once per chat view.
 */
export function useChatActivityCard({
  workspaceId,
  agentId,
  entries,
  diff,
  workspaceRoot,
  docked,
}: {
  workspaceId: string
  agentId: string
  entries: readonly TranscriptEntry[]
  /** The checkout's changed lines, as the composer strip counts them; null where it cannot. */
  diff: { added: number; removed: number } | null
  workspaceRoot: string | null
  /** The chat has room to dock the card. */
  docked: boolean
}): PublishedChatActivity {
  const activity = useMemo(() => deriveChatActivity(entries), [entries])
  const openPaneTab = useWorkspaceStore((state) => state.openPaneTab)
  const setActivePaneTab = useWorkspaceStore((state) => state.setActivePaneTab)
  const moduleOverrides = useWorkspaceStore((state) => state.appSettings.modules)
  const gitEnabled = selectModuleEnabled(moduleOverrides, 'git')
  // A seen mark is kept outside React, so opening a row redraws through this.
  const [seenRevision, bumpSeen] = React.useReducer((value: number) => value + 1, 0)
  const rows = useMemo(
    () =>
      chatActivityRows(activity, {
        diff,
        workspaceRoot,
        seen: (kind, version) => rowSeen(workspaceId, agentId, kind, version),
      }),
    // seenRevision: a row opened since is redrawn as seen.
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [activity, diff, workspaceRoot, workspaceId, agentId, seenRevision],
  )

  const open = useCallback(
    (kind: ChatActivityKind) => {
      const row = rows.find((candidate) => candidate.kind === kind)
      if (row) markRowSeen(workspaceId, agentId, kind, row.version)
      bumpSeen()
      const pane = useWorkspaceStore.getState().workspaces.find((workspace) => workspace.id === workspaceId)?.paneState
      switch (kind) {
        case 'changes':
          // The Diff tab reads the workspace's checkout; with Git off there is
          // no tab to open, and Files shows the same files.
          if (gitEnabled) openPaneTab(workspaceId, { kind: 'diff' })
          else openPaneTab(workspaceId, { kind: 'files' })
          return
        case 'files': {
          openPaneTab(workspaceId, { kind: 'files' })
          const folder = sharedEditFolder(activity.edits.paths, null)
          if (folder && folder.startsWith('/')) dispatchFileReveal({ workspaceId, path: folder })
          return
        }
        case 'browser': {
          // The tab the agent drove, when it is still open; otherwise one on
          // the page it was last on.
          const host = hostOf(activity.browser?.url ?? null)
          const tab = pane?.tabs.find(
            (candidate) => candidate.kind === 'browser' && host && hostOf(candidate.url ?? null) === host,
          )
          if (tab) {
            setActivePaneTab(workspaceId, tab.id)
            useWorkspaceStore.getState().setPaneOpen(workspaceId, true)
          } else
            openPaneTab(workspaceId, {
              kind: 'browser',
              ...(activity.browser?.url
                ? {
                    url: /^[a-z]+:\/\//iu.test(activity.browser.url)
                      ? activity.browser.url
                      : `http://${activity.browser.url}`,
                  }
                : {}),
            })
          return
        }
        case 'canvas': {
          // The board's tab, by its name; the canvas picker when it is not open.
          const board = activity.canvas?.board?.replace(/\.excalidraw$/u, '') ?? null
          const tab = pane?.tabs.find(
            (candidate) =>
              candidate.kind === 'canvas' &&
              board !== null &&
              (candidate.canvas?.path.split(/[\\/]/u).at(-1) ?? '').replace(/\.excalidraw$/u, '') === board,
          )
          if (tab) {
            setActivePaneTab(workspaceId, tab.id)
            useWorkspaceStore.getState().setPaneOpen(workspaceId, true)
          } else openPaneTab(workspaceId, { kind: 'canvas' })
          return
        }
        case 'agents':
          openAgentsPane(workspaceId, agentId, null)
          return
        case 'library':
          openPaneTab(workspaceId, { kind: 'library' })
          return
      }
    },
    [activity, agentId, gitEnabled, openPaneTab, rows, setActivePaneTab, workspaceId],
  )

  const published = useMemo<PublishedChatActivity>(() => ({ rows, docked, open }), [rows, docked, open])
  useEffect(() => {
    publishChatActivity(workspaceId, agentId, published.rows.length ? published : null)
  }, [workspaceId, agentId, published])
  useEffect(() => () => publishChatActivity(workspaceId, agentId, null), [workspaceId, agentId])
  return published
}

/** Whether the element is at least `min` pixels wide, kept as it resizes. */
export function useWidthAtLeast(ref: React.RefObject<HTMLElement | null>, min: number): boolean {
  const [wide, setWide] = React.useState(false)
  useEffect(() => {
    const element = ref.current
    if (!element || typeof ResizeObserver === 'undefined') return
    const measure = () => setWide(element.getBoundingClientRect().width >= min)
    measure()
    const observer = new ResizeObserver(measure)
    observer.observe(element)
    return () => observer.disconnect()
  }, [ref, min])
  return wide
}

/** The pane tab showing now, when the pane is open: the row it belongs to is the selected one. */
function useActivePaneKind(workspaceId: string | null): string | null {
  return useWorkspaceStore((state) => {
    const pane = state.workspaces.find((workspace) => workspace.id === workspaceId)?.paneState
    if (!pane?.open) return null
    return pane.tabs.find((tab) => tab.id === pane.activeTabId)?.kind ?? null
  })
}

/** The rows themselves, as the docked card and the pill's drop-down both list them. */
export function ChatActivityRows({
  rows,
  onOpen,
  activePaneKind,
}: {
  rows: readonly ChatActivityRow[]
  onOpen: (kind: ChatActivityKind) => void
  activePaneKind: string | null
}) {
  return (
    <ul className="flex flex-col gap-0.5" aria-label="What the agent touched">
      {rows.map((row) => {
        const Glyph = GLYPHS[row.kind]
        const selected = activePaneKind === PANE_KIND[row.kind]
        // An agent in it now wears the violet the pane's tabs and the Files
        // tree use for that; a row changed since it was opened, primary ink.
        const glyphTone = row.live
          ? 'text-[color:var(--agent-trail-ink)]'
          : row.unseen
            ? 'text-[color:var(--text-strong)]'
            : 'text-[color:var(--text-muted)]'
        return (
          <li key={row.kind}>
            <RowButton
              selected={selected}
              className="flex min-w-0 items-center gap-2.5 text-body text-[color:var(--text-default)]"
              onClick={() => onOpen(row.kind)}
            >
              <Glyph className={`icon-sm shrink-0 ${glyphTone}`} />
              <span className="min-w-0 flex-1 truncate">{row.label}</span>
              {row.diff ? (
                <DiffStatPill
                  added={row.diff.added}
                  removed={row.diff.removed}
                  ariaLabel={`${row.diff.added} lines added, ${row.diff.removed} removed`}
                  className="shrink-0"
                />
              ) : row.meta ? (
                <span
                  className={`max-w-[120px] shrink-0 truncate text-meta ${
                    row.live ? 'text-[color:var(--agent-trail-ink)]' : 'text-[color:var(--text-muted)]'
                  }`}
                >
                  {row.meta}
                </span>
              ) : null}
            </RowButton>
          </li>
        )
      })}
    </ul>
  )
}

/**
 * The card docked at the top right of the transcript. Memoised: the chat body
 * redraws on every keystroke into the composer, and the card has nothing to
 * say to one (chatRenderBudget.test.tsx).
 */
export const DockedChatActivityCard = React.memo(function DockedChatActivityCard({
  workspaceId,
  activity,
  topInset = 0,
}: {
  workspaceId: string
  activity: PublishedChatActivity
  /** Room left above it, for a bar that shares the corner. */
  topInset?: number
}) {
  const activePaneKind = useActivePaneKind(workspaceId)
  if (!activity.docked || !activity.rows.length) return null
  return (
    <aside
      aria-label="What the agent touched"
      data-chat-activity-card=""
      className={`${OVERLAY_SURFACE_CLASS} absolute right-3 z-[var(--z-float)] p-1`}
      style={{ width: ACTIVITY_CARD_WIDTH, top: 12 + topInset }}
    >
      <ChatActivityRows rows={activity.rows} onOpen={activity.open} activePaneKind={activePaneKind} />
    </aside>
  )
})

/**
 * The title bar's stand-in for the card, for the focused chat while it is too
 * narrow to dock it: the rows' glyphs and an arrow, which drops the rows down.
 */
export function ChatActivityPill({ workspaceId }: { workspaceId: string | null }) {
  const agentId = useWorkspaceStore((state) =>
    workspaceId ? (state.focusedAgentByWorkspaceId[workspaceId] ?? null) : null,
  )
  const activity = useChatActivity(workspaceId, agentId)
  const activePaneKind = useActivePaneKind(workspaceId)
  const [open, setOpen] = React.useState(false)
  if (!activity || activity.docked || !activity.rows.length) return null
  return (
    <Popover
      open={open}
      onOpenChange={setOpen}
      ariaLabel="What the agent touched"
      popupRole="dialog"
      placement="bottom-end"
      material="glass"
      surfaceClassName="w-[264px] p-1"
      renderTrigger={({ ref, triggerProps, togglePopover }) => (
        <Tooltip content="What the agent touched">
          <OutlineButton
            ref={ref}
            {...triggerProps}
            size="sm"
            pressed={open}
            aria-label="What the agent touched"
            onClick={togglePopover}
            className="app-no-drag mr-1.5 shrink-0 gap-1.5 px-2 text-[color:var(--text-muted)]"
          >
            {activity.rows.map((row) => {
              const Glyph = GLYPHS[row.kind]
              return (
                <Glyph
                  key={row.kind}
                  className={`icon-xs ${row.live ? 'text-[color:var(--agent-trail-ink)]' : row.unseen ? 'text-[color:var(--text-strong)]' : ''}`}
                />
              )
            })}
            <svg
              viewBox="0 0 16 16"
              fill="none"
              aria-hidden="true"
              className={`icon-xs transition-transform duration-150 ${open ? 'rotate-180' : ''}`}
            >
              <path
                d="m4 6 4 4 4-4"
                stroke="currentColor"
                strokeWidth="1.6"
                strokeLinecap="round"
                strokeLinejoin="round"
              />
            </svg>
          </OutlineButton>
        </Tooltip>
      )}
    >
      <ChatActivityRows
        rows={activity.rows}
        activePaneKind={activePaneKind}
        onOpen={(kind) => {
          setOpen(false)
          activity.open(kind)
        }}
      />
    </Popover>
  )
}
