// The small pieces a sidebar row is built from: the shelf fold row, the
// attention pulse, row tooltips, the machine and schedule marks, the project
// line, the branch chip and the working timer.

import { MachineGlyph, RowButton, Tooltip, TruncatedText } from '../../ui'
import type { MachineRef } from '../../../../../shared/machine-identity'
import { useMachineIdentity } from '../../../hooks/useMachineIdentity'
import { useChangePulse } from '../../../hooks/useChangePulse'
import React, { createContext, useContext, useState } from 'react'
import { shortMachineName } from '../../remote/machineRowModel'
import { FolderTypeIcon, GitBranchGlyph, NoProjectGlyph, ScheduleGlyph } from '../../AppIcons'
import { isProjectlessChatsRoot } from '../../../../../shared/projectless-chats'
import { type ProjectColor } from '../../../utils/projectColor'
import { formatElapsedMs } from '../../../utils/relativeTime'
import { useRelativeNow } from '../../../hooks/useRelativeNow'

// A shelf's fold row (settled-chats, 2026-09-07): the one line a folder shows
// for a group of parked chats — its name, and how many — collapsed by default,
// in the fold-row idiom the older-rows disclosure used to carry. The section
// rule applies (design-system/components/section): a heading earns its place by
// separating one group from another, so the row renders only when the folder
// has rows to separate from its active ones.
//
// Snoozed (sleep, 2026-09-10) is the shelf that uses it; Settled had one too
// until settled chats moved to Settings ▸ Settled chats (owner, 2026-09-28).
//
// It sits in the background (owner, 2026-09-28): the rows it folds away are
// ones the person has said "not now" about, so the line counting them is never
// the kit row's `text.default`. The label rests at `text.subtle` — the quiet
// row's title tier — at the smaller `text-meta` step, and the count and the
// chevron go one step further down to `text.disabled`. Under the pointer or
// keyboard focus the label lifts to `text.default`, the same lift a quiet row's
// title takes, so reaching for it is never reading dim text.
//
// The ink is on the spans, not the button: RowButton's resting `text.default`
// and a caller's `text-*` on one element are resolved by stylesheet order, not
// class order. The group is named (`group/shelf`) so hovering the folder
// section around it, which is a `group` of its own, does not lift it.
export function ShelfFoldRow({
  label,
  count,
  expanded,
  controlsId,
  onToggle,
  flush = false,
}: {
  label: string
  count: number
  expanded: boolean
  controlsId: string
  onToggle: () => void
  /** The flat stream's shelf: no folder header above it, so no indent under one. */
  flush?: boolean
}) {
  return (
    <div className="mx-1.5 my-0.5 flex items-center gap-1">
      {/* The kit's nav row. Only the alignment inset stays with the caller —
          a `pl-*` out-specifies the density's `px-2` in Tailwind's own
          ordering — along with the type step, which `RowButton` deliberately
          does not spell. */}
      <RowButton
        density="nav"
        onClick={onToggle}
        aria-expanded={expanded}
        aria-controls={controlsId}
        // design-tokens-allow: alignment — 30px = the workspace row's 4px rail + 26px inset, so the fold row's text lines up under the row title (see the layout note in this file); flush drops to 10px, which is the same sum for a flat-stream row
        className={`group/shelf min-w-0 flex-1 select-none ${flush ? 'pl-[10px]' : 'pl-[30px]'} pr-1.5 text-meta`}
      >
        <svg
          viewBox="0 0 16 16"
          fill="none"
          aria-hidden="true"
          className={`icon-xs shrink-0 text-[color:var(--text-disabled)] transition-transform group-hover/shelf:text-[color:var(--text-subtle)] group-focus-visible/shelf:text-[color:var(--text-subtle)] ${
            expanded ? '' : '-rotate-90'
          }`}
        >
          <path
            d="M5 6L8 9L11 6"
            stroke="currentColor"
            strokeWidth="1.6"
            strokeLinecap="round"
            strokeLinejoin="round"
          />
        </svg>
        <span className="truncate text-[color:var(--text-subtle)] group-hover/shelf:text-[color:var(--text-default)] group-focus-visible/shelf:text-[color:var(--text-default)]">
          {label}
        </span>
        <span className="tabular-nums text-[color:var(--text-disabled)] group-hover/shelf:text-[color:var(--text-subtle)] group-focus-visible/shelf:text-[color:var(--text-subtle)]">
          {count}
        </span>
      </RowButton>
    </div>
  )
}

/**
 * The one-shot flash a row plays when it STARTS needing you (`warn`), or when
 * a turn on it has just finished while you were elsewhere (`good`).
 *
 * Motion here means "just changed" — the other of the two things this system
 * lets motion mean — and then it stops. What holds the row loud while it waits
 * is ink: the gold fill, rail and title. An ambient shimmer was considered and
 * ruled out (owner, 2026-09-04): `components/liveness` is explicit that motion
 * is not emphasis and that a mark which is always moving stops meaning
 * anything, and three waiting rows would have been three loops running beside
 * the terminals.
 *
 * It renders as a keyed, pointer-inert sibling rather than on the row itself,
 * so replaying the animation never remounts a row mid-drag or steals its focus.
 * `mode: 'increase'` fires on the way in only; `resetKey` keeps a row that
 * merely swaps identity from flashing.
 */
export function AttentionPulse({
  active,
  resetKey,
  tone = 'warn',
}: {
  active: boolean
  resetKey: string
  /** The status colour the row is already wearing; the flash never introduces its own. */
  tone?: 'warn' | 'good'
}) {
  const token = useChangePulse(active ? 1 : 0, { mode: 'increase', resetKey })
  if (token === 0) return null
  return (
    <span
      key={token}
      aria-hidden="true"
      className={`attention-row-pulse ${tone === 'good' ? 'attention-row-pulse-good' : ''} pointer-events-none absolute inset-0 rounded-md`}
    />
  )
}

/**
 * How long the turn in flight has been running, beside the working mark (owner
 * direction 2026-09-04): the dots say work
 * is ongoing, this says for how long. The word is dropped — the dots already
 * carry it and the aria-label spells it out — because a 276px rail has no room
 * to repeat itself.
 *
 * It owns its own tick rather than riding the sidebar's shared `useRelativeNow`:
 * that runs at 30s and so cannot count seconds, and dropping IT to 1s would
 * re-render the whole tree once a second. Here one text node re-renders, and the
 * tick relaxes to 30s once the turn is past a minute and the seconds stop
 * mattering.
 */
// Two hover surfaces over one row is one too many (owner, 2026-09-09).
//
// A chat row already opens the conversation peek from a hover anywhere on it,
// and the card says what the row's own tooltips were saying: how much changed,
// how long it has been idle, what the agent is doing. Dwelling on the row while
// scrolling past it fired BOTH, and the tooltip — wider than the row and
// positioned over its neighbours — landed on top of the card that was arriving
// to answer the same question.
//
// So the row's readings carry `RowTooltip`, which is the kit's Tooltip
// everywhere except inside a row that opens a card, where it is the trigger's
// own wrapper and nothing else. This is the 2026-09-07 title ruling continued:
// where there IS a card, the card is the surface; where there is not, every one
// of these tooltips still opens exactly as it did.
//
// Not everything on the row is in here. A glyph whose ONLY meaning is its label
// — the machine mark, the provider mark, "Directory removed" — keeps the kit's
// Tooltip outright, because suppressing it would leave a drawing that says
// nothing and a card that never mentions it.
// Exported for `WorkspaceSidebar.rowTooltips.test.tsx`, as the row's other
// pieces are: the rule is one line of behaviour and it is tested directly.
export const RowTooltipsSuppressed = createContext(false)

export function RowTooltip({ children, ...props }: React.ComponentProps<typeof Tooltip>) {
  const suppressed = useContext(RowTooltipsSuppressed)
  if (!suppressed) return <Tooltip {...props}>{children}</Tooltip>
  // The same wrapper the kit renders, so suppressing a tooltip never moves the
  // thing it was wrapping: Tooltip's own span is `relative` plus the caller's
  // wrapperClassName, defaulting to `inline-flex`.
  return (
    <span role={props.wrapperRole} className={`relative ${props.wrapperClassName ?? 'inline-flex'}`}>
      {children}
    </span>
  )
}

/** A machine other than this one, as a row knows it: who it is, and what to call it. */
export type RowMachine = { ref: MachineRef | null; name: string }

/**
 * The one mark that says a row is running somewhere else: the machine's own
 * glyph in the machine's own colour (owner ruling 2026-10-04), with its name
 * on hover. A chat on a WSL distribution, an SSH machine or a paired machine
 * wears it; a chat on this computer wears nothing.
 *
 * The kind and colour are the machine's identity (shared/machine-identity), so
 * two chats on one machine wear one mark and two machines are told apart at a
 * glance — which the single green "elsewhere" glyph it replaces could not do.
 *
 * The NAME stays in the tooltip and the accessible name, never in the row's
 * own width: `mac-mini.example.ts.net` would take the row.
 */
export function MachineRowGlyph({ machine }: { machine: RowMachine | null }) {
  const identity = useMachineIdentity(machine?.ref ?? null)
  if (!machine || !identity) return null
  const short = shortMachineName(machine.name)
  return (
    <Tooltip content={`On ${short}`} placement="bottom" wrapperClassName="flex shrink-0 items-center">
      <span
        role="img"
        aria-label={`On ${short}`}
        className="flex shrink-0 items-center"
        data-remote-row-glyph={machine.name}
      >
        <MachineGlyph identity={identity} />
      </span>
    </Tooltip>
  )
}

/**
 * The mark on a chat a schedule started (owner ruling 2026-09-30): the
 * schedule's own clock, in the accent the Scheduled section's rows draw it in,
 * so a run's chat and the schedule behind it read as one thing seen from two
 * places. It says where the chat came from and nothing else — the chat is an
 * ordinary chat, and its working state is the row's own.
 */
export function ScheduledRunGlyph({ scheduledAgentId }: { scheduledAgentId: string }) {
  return (
    <Tooltip content="Started by a schedule" placement="bottom" wrapperClassName="flex shrink-0 items-center">
      <span
        role="img"
        aria-label="Started by a schedule"
        className="flex shrink-0 items-center"
        data-scheduled-run={scheduledAgentId}
      >
        <ScheduleGlyph className="icon-xs shrink-0 text-[color:var(--accent-primary)]" />
      </span>
    </Tooltip>
  )
}

/**
 * The project a row belongs to, as the flat stream says it: the folder glyph
 * in the project's hue, the project's name, and — when the row runs on another
 * machine — that machine's glyph trailing the name (owner ruling 2026-10-04,
 * moved from beside the folder icon, where it read as part of the project).
 *
 * One component for local and remote rows both, so a remote chat in the All
 * chats list is the same row as every other one, differing by that single mark.
 */
export type FlatProjectLine = {
  name: string
  folderPath: string | null
  color: ProjectColor | null
  unfiled: boolean
}

export function ProjectLine({
  project,
  machine = null,
  dim = false,
  children,
}: {
  project: FlatProjectLine
  /** The machine this row runs on; null for a row on this computer. */
  machine?: RowMachine | null
  dim?: boolean
  /** The row's status seat, which rides this line's trailing edge. */
  children?: React.ReactNode
}) {
  return (
    <div
      className={`flex h-5 min-w-0 items-center gap-1.5 text-meta ${
        dim ? 'text-[color:var(--text-disabled)]' : 'text-[color:var(--text-subtle)]'
      }`}
    >
      {/* THE glyph the project's colour lives on in the flat stream
          (one-colour-per-project, 2026-09-09). The name beside it stays
          in the row's own ink: the hue identifies the project, and a
          coloured word would be a second, louder saying of it. */}
      {isProjectlessChatsRoot(project.folderPath) ? (
        <NoProjectGlyph className="icon-xs shrink-0" />
      ) : (
        <FolderTypeIcon className="icon-xs shrink-0" color={project.color} unfiled={project.unfiled} />
      )}
      <span className="min-w-0 truncate">{project.name}</span>
      <MachineRowGlyph machine={machine} />
      {/* No pull request count here (owner, 2026-10-02). This line repeats
          down every row of a project, so a project-wide count on it read as
          "this chat has an open pull request" on chats that had none. A
          chat's pull request is drawn once, on its own row; the tree's
          folder header, drawn once per project, keeps the count. */}
      {children}
    </div>
  )
}

/**
 * Settle's one-click mark on a row's seat: `CheckIcon`'s geometry (24-grid,
 * M5 12.5L10 17L19 7.5) brought onto the 16-grid at its 1.4 stroke and inset
 * to the 12×12 live area. One drawing for a chat here and a chat on a paired
 * machine, which settle by the same gesture. An element rather than a
 * component: it has no state, and a row re-rendering need not render it too.
 */
export const SETTLE_TICK_GLYPH = (
  <svg viewBox="0 0 16 16" fill="none" className="icon-xs" aria-hidden="true">
    <path
      d="M3.75 8.5L6.5 11.25L12.25 5.25"
      stroke="currentColor"
      strokeWidth="1.4"
      strokeLinecap="round"
      strokeLinejoin="round"
    />
  </svg>
)

export function WorkingElapsed({ since }: { since: number }) {
  // Seconds for the turn's first minute, the sidebar's coarse scale after.
  // Both beats are the window's shared clocks, so every working row ticks on
  // one timer, and it stops while the window cannot be seen.
  const [inFirstMinute, setInFirstMinute] = useState(true)
  const now = useRelativeNow(inFirstMinute ? 1_000 : 30_000)
  // A new turn (a later `since`) is young again, and moves back to seconds.
  const young = now - since < 60_000
  if (young !== inFirstMinute) setInFirstMinute(young)
  const text = formatElapsedMs(since, now)
  if (!text) return null
  return (
    // Accent ink, matching the dots it sits beside, so the pair reads as one
    // status token rather than a mark plus an unrelated number. No aria-label
    // on a generic span (ignored there — the row's own review): the number is
    // the visible text and an sr-only sentence says what it measures.
    <span className="tabular-nums text-[color:var(--accent-primary)]">
      <span aria-hidden="true">{text}</span>
      <span className="sr-only">Working for {text}</span>
    </span>
  )
}

/**
 * The branch a row or a line sits on: the glyph, the name, and the path on
 * hover. Shared by a terminal's line and by a parked worktree row, so the two
 * are the same chip and not two drawings of one idea that drift apart.
 *
 * A worktree reads at full strength — it is a checkout of its own, not one it
 * shares — and says so in words too, since weight alone carries no meaning.
 */
export function BranchChip({
  branch,
  worktree,
  cwd,
  dim = false,
  tooltip,
}: {
  branch: string
  worktree: boolean
  cwd: string | null
  /** The row is background: nothing on its meta line may outshine its title. */
  dim?: boolean
  /** In place of the path, when the path is not where the checkout is (a worktree given back). */
  tooltip?: string
}) {
  return (
    <RowTooltip
      content={
        tooltip ?? (cwd ? (worktree ? `Worktree · ${cwd}` : cwd) : worktree ? 'A worktree of its own' : `On ${branch}`)
      }
      wrapperClassName="flex min-w-[4ch] shrink-[3] items-center"
    >
      <span
        className={`flex min-w-0 items-center gap-1 font-mono text-micro ${
          // A worktree of the terminal's own reads at full strength: it is
          // this terminal's checkout, not a checkout it shares. Not on a
          // background row, though — full strength there is BRIGHTER than the
          // dimmed title above it, which reads as the branch being the point
          // of a chat nobody is using (owner, 2026-09-07). It inherits the
          // line's ink instead.
          worktree && !dim ? 'text-[color:var(--text-default)]' : ''
        }`}
      >
        <GitBranchGlyph className="icon-xs shrink-0" />
        <TruncatedText as="span" text={branch} className="min-w-0" />
        {worktree ? <span className="sr-only"> (worktree)</span> : null}
      </span>
    </RowTooltip>
  )
}
