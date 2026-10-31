import { useSyncExternalStore } from 'react'
import { IconButton, Tooltip } from '../../ui'
import { FOCUS_RING_CLASS } from '../../ui/tokens'
import { NewChatIcon } from '../../AppIcons'
import { listNewChatDrafts, newChatDraftTitle, subscribeNewChatDrafts } from '../agentComposer/newChatDraft'
import { ProjectLine, ShelfFoldRow, type FlatProjectLine } from './rowParts'
import { SELECTED_ROW_ACCENT, SELECTION_EDGE_CLASS } from './rowStyle'

// The sidebar's Drafts: the New chat drafts kept with something in them
// (`newChatDraft.ts`), newest begun first, and nothing when there are none.
// A draft is listed by when it was begun, so typing in one never moves its
// row. It reads the drafts itself, so typing in New chat redraws this section
// and not the sidebar around it.

const DRAFTS_SHELF_ID = 'ws-new-chat-drafts'

export function DraftsSection({
  expanded,
  onToggle,
  projectOf,
  openDraftId,
  onOpen,
  onDelete,
}: {
  expanded: boolean
  onToggle: () => void
  /** The project line a draft's folder is drawn with, as a chat's row draws its own. */
  projectOf: (folderPath: string) => FlatProjectLine
  /** The draft this window's New chat is showing, drawn selected. */
  openDraftId: string | null
  onOpen: (id: string) => void
  onDelete: (id: string) => void
}) {
  const drafts = useSyncExternalStore(subscribeNewChatDrafts, listNewChatDrafts, listNewChatDrafts)
  if (drafts.length === 0) return null
  return (
    <section role="group" className="relative pt-1" aria-label="Drafts">
      <ShelfFoldRow
        label="Drafts"
        count={drafts.length}
        expanded={expanded}
        flush
        controlsId={DRAFTS_SHELF_ID}
        onToggle={onToggle}
      />
      <div id={DRAFTS_SHELF_ID} role="group" aria-label="Drafts" hidden={!expanded}>
        {expanded
          ? drafts.map((entry) => (
              <DraftRow
                key={entry.id}
                id={entry.id}
                title={newChatDraftTitle(entry.draft)}
                project={
                  entry.draft.folderPath
                    ? projectOf(entry.draft.folderPath)
                    : { name: 'No project', folderPath: null, color: null, unfiled: false }
                }
                selected={openDraftId === entry.id}
                onOpen={() => onOpen(entry.id)}
                onDelete={() => onDelete(entry.id)}
              />
            ))
          : null}
      </div>
    </section>
  )
}

/** One kept draft: its project over its first words, as a chat's row shows its project over its title. */
function DraftRow({
  id,
  title,
  project,
  selected,
  onOpen,
  onDelete,
}: {
  id: string
  title: string
  project: FlatProjectLine
  /** Open in this window's New chat. */
  selected: boolean
  onOpen: () => void
  onDelete: () => void
}) {
  return (
    <div
      role="treeitem"
      tabIndex={-1}
      aria-current={selected ? 'true' : undefined}
      aria-label={`Draft: ${title}, in ${project.name}`}
      data-new-chat-draft={id}
      onClick={onOpen}
      onKeyDown={(event) => {
        if (event.key === 'Enter' || event.key === ' ') {
          event.preventDefault()
          onOpen()
        } else if (event.key === 'Delete' || event.key === 'Backspace') {
          event.preventDefault()
          onDelete()
        }
      }}
      className={`interactive group relative mx-1.5 my-0.5 flex min-h-control-sm cursor-pointer select-none flex-col justify-center gap-0.5 rounded-md border-l-[4px] py-1 px-1.5 text-heading ${FOCUS_RING_CLASS} ${
        selected
          ? `border-l-transparent ${SELECTED_ROW_ACCENT.bg} ${SELECTED_ROW_ACCENT.text} ${SELECTION_EDGE_CLASS}`
          : 'border-l-transparent text-[color:var(--text-default)] hover:bg-[color:var(--bg-surface-raised)] hover:text-[color:var(--text-strong)]'
      }`}
    >
      <ProjectLine project={project} machine={null}>
        <span className="relative ml-auto flex h-5 shrink-0 items-center justify-end pl-2">
          {/* Revealed on hover and on focus, so the keyboard reaches it too. */}
          <span className="pointer-events-none inline-flex items-center opacity-0 transition-opacity group-hover:pointer-events-auto group-hover:opacity-100 group-focus-within:pointer-events-auto group-focus-within:opacity-100">
            <Tooltip content="Delete draft">
              <IconButton
                tone="quiet"
                aria-label={`Delete draft: ${title}`}
                data-new-chat-draft-delete={id}
                onClick={(event) => {
                  event.stopPropagation()
                  onDelete()
                }}
              >
                <svg className="icon-xs" viewBox="0 0 14 14" fill="none" aria-hidden="true">
                  <path
                    d="M3.25 3.25L10.75 10.75M10.75 3.25L3.25 10.75"
                    stroke="currentColor"
                    strokeWidth="1.4"
                    strokeLinecap="round"
                  />
                </svg>
              </IconButton>
            </Tooltip>
          </span>
        </span>
      </ProjectLine>
      <div className="flex min-w-0 items-center gap-1.5">
        <NewChatIcon className="icon-xs shrink-0 text-[color:var(--text-subtle)]" />
        <span className="min-w-0 flex-1 truncate">{title}</span>
      </div>
    </div>
  )
}
