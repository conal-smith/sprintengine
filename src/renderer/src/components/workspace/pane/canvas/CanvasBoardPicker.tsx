import React, { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react'

import type { CanvasBoardSummary } from '../../../../../../shared/canvas/types'
import {
  canvasBoardKeyPath,
  canvasPathIsCaseInsensitive,
  normalizeCanvasPath,
} from '../../../../../../shared/canvas/paths'
import {
  Badge,
  EmptyState,
  GhostButton,
  Input,
  Pager,
  PrimaryButton,
  RowButton,
  SettingCard,
  Skeleton,
  TruncatedText,
} from '../../../ui'
import { ExtensionIcon } from '../../../ui/ExtensionIcon'
import { CanvasGlyph } from '../paneKinds'
import {
  CANVAS_DEFAULT_NEW_BOARD_NAME,
  canvasBoardFolder,
  canvasBoardRowLabel,
  canvasPickerPage,
  collidingCanvasBoardPath,
  describeCanvasChangedAt,
  duplicateCanvasBoardNames,
  formatCanvasChangedAt,
  uniqueCanvasBoardName,
} from './canvasPickerModel'
import { hostPlatform } from '../../../../clientCapabilities'
import { isImeKey } from '../../../../utils/imeKey'

// What a Canvas tab shows before it has a board: this project's boards, and one
// affordance that makes another.
//
// It is a LIST — the same list card the app already uses for its agent CLIs,
// its skills and its paired devices — rather than the grid of tiles the pane's
// own launcher draws (owner, 2026-09-17). The launcher offers six fixed tools
// and will offer six tomorrow; boards are documents, an open-ended set that
// grows with the project, and a growing set is read by name and by recency down
// one column. Two columns of tiles would break the newest-first reading order
// the whole surface is sorted on, and spend more height doing it.
//
// So: a quiet heading naming the list and counting it, the primary action on
// that same line where it never pages away, ten rows in one bordered card, and
// the kit pager at its foot.

type CanvasBoardPickerProps = {
  workspaceId: string
  /** Picking a board writes it onto this tab; the tab then opens the editor. */
  onPick: (path: string) => void
  /**
   * Boards another tab in this pane already holds. Picking one is not refused —
   * it brings that tab forward — but a row that says so beforehand is the
   * difference between "open it" and "why did my tab disappear".
   */
  openPaths?: readonly string[]
}

type PickerState =
  { kind: 'loading' } | { kind: 'ready'; boards: CanvasBoardSummary[] } | { kind: 'error'; message: string }

// One frozen array for every state that has no boards, so the memos below are
// not invalidated by a fresh `[]` on each render.
const NO_BOARDS: readonly CanvasBoardSummary[] = []

/** The mark on the primary action and on the row that is not a board yet. */
function PlusGlyph({ className }: { className?: string }) {
  return (
    <svg viewBox="0 0 16 16" fill="none" className={className} aria-hidden="true">
      <path d="M8 3.5v9M3.5 8h9" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" />
    </svg>
  )
}

/** The plate every row wears: the pane kind's own mark in the kit's icon chip. */
function BoardMark({ name }: { name: string }) {
  return <ExtensionIcon name={name} size={32} mark={<CanvasGlyph className="text-[color:var(--icon-chip-ink)]" />} />
}

export function CanvasBoardPicker({ workspaceId, onPick, openPaths }: CanvasBoardPickerProps) {
  const [state, setState] = useState<PickerState>({ kind: 'loading' })
  const [attempt, setAttempt] = useState(0)
  const [page, setPage] = useState(1)
  const [naming, setNaming] = useState(false)
  const [draft, setDraft] = useState('')
  // Only shown once the person has tried to create: a name that is not finished
  // being typed is not yet wrong.
  const [nameError, setNameError] = useState<string | null>(null)
  // One clock for the whole mount. Re-reading it per row would let two rows
  // written in the same second disagree about which minute it is.
  const [now] = useState(() => Date.now())
  const newBoardRef = useRef<HTMLButtonElement | null>(null)
  const nameFieldRef = useRef<HTMLInputElement | null>(null)
  // Escape and Cancel put focus back where it came from; opening the field puts
  // it in the field. Which of the two a render owes is decided when the gesture
  // happens, not when the effect runs.
  const restoreFocusRef = useRef(false)
  // `onPick` replaces this whole surface, so a second create in the same naming
  // session can only ever be a duplicate of the first — Enter held down
  // repeating, or Enter landing in the same frame as a click on Create.
  const creatingRef = useRef(false)

  useEffect(() => {
    let cancelled = false
    setState({ kind: 'loading' })
    void (async () => {
      try {
        const result = await window.api.canvasListBoards(workspaceId)
        if (cancelled) return
        setState(result.ok ? { kind: 'ready', boards: result.value } : { kind: 'error', message: result.error.message })
      } catch {
        if (!cancelled) {
          setState({ kind: 'error', message: 'The list of boards could not be read.' })
        }
      }
    })()
    return () => {
      cancelled = true
    }
  }, [attempt, workspaceId])

  // Page 3 of one project is not page 3 of the next, and a half-typed name for
  // one project's board is not a name for another's.
  useEffect(() => {
    setPage(1)
    setNaming(false)
    setNameError(null)
  }, [workspaceId])

  const boards = state.kind === 'ready' ? state.boards : NO_BOARDS
  // Folded the way the pane and main fold their own keys, so a board open under
  // another spelling of its path is still marked as open.
  const openKeys = useMemo(
    () => new Set((openPaths ?? []).map((path) => canvasBoardKeyPath(path, hostPlatform()))),
    [openPaths],
  )
  const duplicateNames = useMemo(() => duplicateCanvasBoardNames(boards), [boards])
  const paths = useMemo(() => boards.map((board) => board.path), [boards])
  // The name the field opens on: `canvas`, then `canvas-2`, so opening it twice
  // never lands on the same file.
  const suggested = useMemo(() => uniqueCanvasBoardName(CANVAS_DEFAULT_NEW_BOARD_NAME, paths), [paths])
  // Clamped here rather than pushed back into state: a board removed under the
  // picker must not leave an empty card with a working "previous", and an
  // effect that corrected the state would render the empty card once first.
  const view = useMemo(() => canvasPickerPage({ boards, page }), [boards, page])

  const startNaming = useCallback(() => {
    setDraft(suggested)
    setNameError(null)
    // The guard below belongs to ONE naming session. Released here rather than
    // left set, so a create that somehow did not take this surface away leaves
    // a working field behind rather than one that silently refuses.
    creatingRef.current = false
    setNaming(true)
  }, [suggested])

  const cancelNaming = useCallback(() => {
    restoreFocusRef.current = true
    setNaming(false)
    setNameError(null)
  }, [])

  useLayoutEffect(() => {
    if (naming) {
      const field = nameFieldRef.current
      if (!field) return
      field.focus()
      // Selected, not just focused: the suggested name is an offer, and typing
      // over an offer should not first mean deleting it.
      field.select()
      return
    }
    if (!restoreFocusRef.current) return
    restoreFocusRef.current = false
    newBoardRef.current?.focus()
  }, [naming])

  const create = useCallback(() => {
    if (creatingRef.current) return
    const typed = draft.trim()
    const normalized = normalizeCanvasPath(typed || suggested)
    if (!normalized.ok) {
      setNameError(normalized.error.message)
      return
    }
    const collision = collidingCanvasBoardPath(normalized.value, paths, canvasPathIsCaseInsensitive(hostPlatform()))
    if (collision) {
      // Refused rather than silently opened: the person asked for a NEW board,
      // and handing them someone else's is how work gets drawn on top of.
      setNameError(`This project already has a board at ${collision}.`)
      return
    }
    creatingRef.current = true
    setNaming(false)
    // The new board is the newest, so it is on page 1 whatever page the person
    // was standing on when they asked for it.
    setPage(1)
    onPick(normalized.value)
  }, [draft, onPick, paths, suggested])

  // The launcher's own letter handling, on the one letter this surface has: a
  // key pressed while a row has focus opens the thing that key names. Skipped
  // while the field is open, where every letter belongs to the name being typed.
  const onKeyDown = useCallback(
    (event: React.KeyboardEvent<HTMLDivElement>) => {
      if (naming || state.kind !== 'ready') return
      if (event.key.length !== 1 || event.metaKey || event.ctrlKey || event.altKey) return
      if (event.key.toUpperCase() !== 'N') return
      const target = event.target as HTMLElement | null
      if (target?.closest('input, textarea, select, [contenteditable="true"]')) return
      event.preventDefault()
      startNaming()
    },
    [naming, startNaming, state.kind],
  )

  // A listing that failed says so and nothing else. A heading counting zero
  // boards over a "New board" button that would fail the same way is the
  // surface pretending it is merely empty.
  if (state.kind === 'error') {
    return (
      <div className="h-full bg-[color:var(--bg-surface)]">
        <EmptyState
          title="The boards could not be listed"
          body={state.message}
          action={<PrimaryButton onClick={() => setAttempt((n) => n + 1)}>Try again</PrimaryButton>}
        />
      </div>
    )
  }

  const nameErrorId = `canvas-new-board-error-${workspaceId}`
  const empty = state.kind === 'ready' && boards.length === 0

  const namingRow = (
    // The resting selection fill, because this row is where the person is —
    // and `bg.selected-resting` rather than `bg.selected` because nothing here
    // is chosen yet, it is being written.
    <li key="naming" className="bg-[color:var(--bg-selected-resting)]">
      <div className="flex items-center gap-2 py-1.5 pl-2 pr-4">
        <div className="flex min-w-0 flex-1 items-center gap-2 px-2 py-1.5">
          <BoardMark name={draft || suggested} />
          <Input
            ref={nameFieldRef}
            value={draft}
            aria-label="New board name"
            aria-invalid={nameError ? true : undefined}
            aria-describedby={nameError ? nameErrorId : undefined}
            spellCheck={false}
            autoCorrect="off"
            autoCapitalize="off"
            onChange={(event) => {
              setDraft(event.currentTarget.value)
              if (nameError) setNameError(null)
            }}
            onKeyDown={(event) => {
              if (isImeKey(event)) return
              if (event.key === 'Enter') {
                event.preventDefault()
                create()
                return
              }
              if (event.key === 'Escape') {
                event.preventDefault()
                cancelNaming()
              }
            }}
            className="min-w-0 flex-1"
          />
        </div>
        <div className="flex shrink-0 items-center gap-2">
          <PrimaryButton onClick={create}>Create</PrimaryButton>
          <GhostButton onClick={cancelNaming}>Cancel</GhostButton>
        </div>
      </div>
      {nameError ? (
        // Under the field, inside the row it belongs to: the rows below move
        // down by one line and nothing else on the surface moves at all.
        <p id={nameErrorId} role="alert" className="px-4 pb-2 text-meta leading-4 text-[color:var(--tone-error)]">
          {nameError}
        </p>
      ) : null}
    </li>
  )

  const rows = view.boards.map((board) => {
    const folder = canvasBoardFolder(board.path)
    const changed = formatCanvasChangedAt(board.modifiedAt, now)
    const open = openKeys.has(canvasBoardKeyPath(board.path, hostPlatform()))
    return (
      <li key={board.path}>
        {/* The list-card row anatomy the agent CLI, plugin and skill rows draw:
            the wrapper owns the fill and the card's 16/12px inset, and the row
            half inside it is the kit's `flush` density, which draws no ground of
            its own. Composed here rather than imported from the Connectors
            surface's own row: that row's target is named "Show details for …"
            and its trailing slot sits OUTSIDE the button, and a board's row
            opens a board and is clickable to its right edge. */}
        <div className="flex items-center gap-2 py-1.5 pl-2 pr-4 transition-colors hover:bg-[color:var(--bg-hover)]">
          <RowButton
            density="flush"
            onClick={() => onPick(board.path)}
            aria-label={canvasBoardRowLabel({
              name: board.name,
              folder,
              changed: describeCanvasChangedAt(board.modifiedAt, now),
              open,
            })}
            className="min-w-0 flex-1"
          >
            <BoardMark name={board.name} />
            <span className="min-w-0 flex-1">
              <span className="flex min-w-0 items-center gap-1.5 overflow-hidden">
                <TruncatedText
                  as="span"
                  text={board.name}
                  className="min-w-0 text-body font-semibold leading-5 text-[color:var(--text-strong)]"
                />
                {/* Only where the name alone cannot be chosen between. A folder
                    on every row is a column of the word "diagrams". */}
                {duplicateNames.has(board.name.toLowerCase()) ? (
                  <TruncatedText
                    as="span"
                    text={folder}
                    className="min-w-0 shrink font-mono text-meta text-[color:var(--text-subtle)]"
                  />
                ) : null}
                {open ? (
                  // Decorative: the row's own name already says it is open in
                  // another tab, and a badge that repeated it would be read
                  // twice.
                  <Badge decorative tone="accent" className="shrink-0">
                    Open
                  </Badge>
                ) : null}
              </span>
            </span>
            {/* Aria-hidden because the accessible name says the same thing in
                words — "5m" read aloud is not a time. */}
            <span
              aria-hidden="true"
              className="shrink-0 font-mono text-meta tabular-nums text-[color:var(--text-subtle)]"
            >
              {changed}
            </span>
          </RowButton>
        </div>
      </li>
    )
  })

  // Rows of the same height as the real ones, so the card does not jump when
  // the listing lands. Three rather than ten: a directory read answers in
  // milliseconds, and ten shimmering rows over a project with two boards
  // promises a list that is not there.
  const skeletonRows = [0, 1, 2].map((index) => (
    <li key={`skeleton-${index}`}>
      <div className="flex items-center gap-2 py-1.5 pl-2 pr-4">
        <div className="flex min-w-0 flex-1 items-center gap-2 px-2 py-1.5">
          <Skeleton className="size-8 shrink-0 rounded-lg bg-[color:var(--bg-hover)]" />
          <Skeleton className="h-3 w-32 rounded-sm bg-[color:var(--bg-hover)]" />
        </div>
      </div>
    </li>
  ))

  return (
    <div
      className="h-full min-h-0 overflow-y-auto bg-[color:var(--bg-surface)] p-6 [scrollbar-gutter:stable]"
      onKeyDown={onKeyDown}
    >
      <div className="mx-auto flex w-full max-w-[720px] flex-col gap-3">
        {/* The section heading the app's other lists wear: the label muted, the
            count beside it in mono. The card below is the group's edge, so the
            heading only names it. */}
        <div className="flex items-baseline gap-2">
          <span className="text-body font-medium text-[color:var(--text-muted)]">Boards</span>
          {state.kind === 'ready' ? (
            <span className="font-mono text-meta tabular-nums text-[color:var(--text-subtle)]">{boards.length}</span>
          ) : null}
          {/* Hidden while the field is open rather than disabled: the field IS
              the button, moved into the card. Held back while the listing is
              still coming, because the name it would suggest is only unique
              once we know what the project already has. */}
          {!naming ? (
            <PrimaryButton
              ref={newBoardRef}
              onClick={startNaming}
              disabled={state.kind !== 'ready'}
              // `gap` is the kit button's own (`gap-1.5`); only the push to the
              // right of the heading line belongs to this caller.
              className="ml-auto"
            >
              <PlusGlyph className="icon-xs" />
              <span>New board</span>
            </PrimaryButton>
          ) : null}
        </div>

        {state.kind === 'loading' ? (
          <SettingCard as="ul" ariaLabel="Boards">
            {skeletonRows}
          </SettingCard>
        ) : empty && !naming ? (
          <EmptyState
            density="list"
            title="No boards yet."
            body="Boards are kept by the app, outside your repository — you and your agents can both draw on them. Export one to a folder when it belongs in the project."
          />
        ) : (
          <SettingCard as="ul" ariaLabel="Boards">
            {naming ? namingRow : null}
            {rows}
          </SettingCard>
        )}

        {/* Only when there is more than one page. A single page's count is news
            the heading already carries. */}
        {view.pageCount > 1 ? (
          <Pager
            page={view.page}
            pageCount={view.pageCount}
            rangeLabel={view.rangeLabel}
            onPageChange={setPage}
            ariaLabel="Boards in this project"
          />
        ) : null}
      </div>
    </div>
  )
}
