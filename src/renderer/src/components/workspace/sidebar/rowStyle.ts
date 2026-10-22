// The sidebar row's accent, highlight and attention classes.

import { type Workspace } from '../../../types/workspace'
import { getHighlightSwatch, hasHighlightOverride } from '../../../utils/highlight'
import { type Tone } from '../../ui'

export type Activity = 'working' | 'failed' | 'needs-input' | 'idle'

// No `shadow` member: the row's edge is not an accent's to carry. Selection's
// 2px accent edge is drawn once by `SELECTION_EDGE_CLASS` below, on top of
// whatever fill the row has — a neutral one, a highlight hue, or a status wash
// — so no accent needs to ship an edge of its own.
export type RowAccent = {
  bg: string
  text: string
}

// Selection's edge: the 2px accent border the row of the pane you are driving
// wears (owner ruling 2026-09-05; design-system/patterns/selection.html and
// components/list-row).
//
// The complaint it answers, verbatim: "I'm finding it a little bit difficult to
// really see which terminal I'm in control of." The selected row was a neutral
// fill and an ink lift, which is one step of grey; the rows around it wearing
// `needs-input` gold or `unseen-done` green were a hue, a whole-row wash AND a
// ring. The loudest row on the rail was reliably not the one the person was in,
// and the green ring in particular read as "you are here" because it is the
// same mark the FOCUSED TERMINAL wears (`terminal-focus-ring`, a 2px
// --border-focus border). So the two vocabularies are now split down the
// middle: a tint says what happened on a row, an edge says which row you are
// in, and the rail and the terminal it drives wear that edge together.
//
// `--selection-edge` rather than `--accent-primary` directly: the resting-tier
// rules in assets/index.css rebind it to `transparent` on a pane that is not
// holding focus, the same way they rebind the fill and the ink lift. Naming the
// accent here would opt the sidebar out of tiering.
export const SELECTION_EDGE_CLASS = 'ring-2 ring-inset ring-[color:var(--selection-edge)]'

// No `glyph` member either, and no per-mode entry left to hold one: the row
// carries no icon since 2026-09-02 (the logo moved to the folder header, the
// type glyph went), and the glyph ink was the ONLY thing the mode accents ever
// differed by — every mode's fill and ink were already identical. So one
// accent stands for every mode.
//
// The active row body sits on the brighter `--bg-selected` surface — the same
// canonical selection fill used elsewhere (notifications, file/artifact
// selection) — so the selected row clears the hover `--bg-surface-raised` fill
// by a full step.
//
// The colored 4px left rail is gone: selection is a neutral fill and carries no
// left bar (`design-system/patterns/selection.html`). A collapsed icon rail is
// the one place the design system still permits a stripe — rows there are too
// narrow for a fill to read — but this sidebar has no such rail to except:
// collapsing hides the whole aside rather than narrowing it to icons (the
// `hidden` class on the <aside> below), so no stripe survives here.
export const SELECTED_ROW_ACCENT: RowAccent = {
  bg: 'bg-[color:var(--bg-selected)]',
  text: 'text-[color:var(--text-strong)]',
}

// Effective accent for a workspace row: a user-set highlight colour when the
// workspace has one, the neutral selection accent otherwise. Mode no longer
// enters into it — with the row's icon gone there is nothing per-mode left to
// tint, so the enablement gating this used to do (degrade a disabled module's
// row to the generic accent) has nothing to degrade.
export function rowAccent(workspace: Workspace): RowAccent {
  const highlight = workspace.highlight?.color
  if (highlight) {
    const swatch = getHighlightSwatch(highlight)
    return { bg: swatch.bg, text: swatch.text }
  }
  return SELECTED_ROW_ACCENT
}

// A user-set highlight colour is workspace identity, not selection, so its rail
// reads the same whether or not the row is the active one. Rows with no
// highlight keep the base transparent 4px border and show no rail at all.
export function highlightRailClass(workspace: { highlight?: Workspace['highlight'] | null }): string {
  if (!hasHighlightOverride(workspace.highlight)) return ''
  return `border-l-[4px] ${getHighlightSwatch(workspace.highlight!.color!).border}`
}

// The selected row is its fill, its ink lift and the selection edge — no left
// bar of its own. The base row keeps `border-l-[4px] border-l-transparent`, so
// a highlight rail appears and disappears without shifting the row's content
// sideways, and the edge is a ring so it never moves the row either.
export function activeRowClass(workspace: Workspace): string {
  const accent = rowAccent(workspace)
  return `${highlightRailClass(workspace)} ${accent.bg} ${accent.text} ${SELECTION_EDGE_CLASS}`
}

// Class fragment applied to inactive rows that have a highlight color set, so
// the user spots their highlighted workspaces at a glance even when not active.
// The colored left rail plus a dimmed full-width tint of the same hue — the
// quiet half of the dim/bright pair; selecting the row swaps to the brighter
// `bg` fill in `activeRowClass`.
export function inactiveHighlightClass(workspace: { highlight?: Workspace['highlight'] | null }): string {
  if (!hasHighlightOverride(workspace.highlight)) return ''
  const swatch = getHighlightSwatch(workspace.highlight!.color!)
  return `${highlightRailClass(workspace)} ${swatch.dimBg}`
}

// Chat/session workspaces use the terminal activity idiom: active work earns a
// pulsing green dot, while idle rows fall back to minute-based recency.
// A workspace type that ships a run-glyph provider bypasses this.
export function activityTone(activity: Activity): { tone: Tone; pulse: boolean } | null {
  if (activity === 'needs-input') return { tone: 'warn', pulse: true }
  if (activity === 'working') return { tone: 'good', pulse: true }
  if (activity === 'failed') return { tone: 'error', pulse: false }
  return null
}

export function activityLabel(activity: Activity): string {
  if (activity === 'needs-input') return 'Workspace needs input'
  if (activity === 'working') return 'Workspace agents working'
  if (activity === 'failed') return 'Workspace agent failed'
  return 'Workspace idle'
}

// Needs-input is the loudest thing a row can say, so it takes the row's whole
// surface rather than a 6px dot in its corner (owner ruling 2026-09-04): a gold
// tint and the title in warn ink. The dot is gone with it — status-dot's own
// spec calls a dot beside a surface already saying the same thing a
// reject-on-sight, and a dot is the weakest possible carrier for the one state
// that actually wants you to look.
//
// The gold RING that used to close the tint is gone too (owner ruling
// 2026-09-05). The edge belongs to selection now, and a status state may not
// borrow it: while both drew edges, the loudest row on the rail was whichever
// one had a status, never the one the person was actually in. A tint says what
// happened here; the edge says where you are. A row that is both wears the wash
// and, from `activeRowClass`, the accent edge — two marks answering two
// questions instead of two spellings of one.
//
// A left rail was never on the table for either: a tone-coloured left bar is a
// ruled rejection in this system (designSystemAxes' LEFT_TONE_BAR), and the 4px
// left slot already belongs to a different vocabulary here — the user's
// highlight colour, which is identity rather than severity.
export function attentionRowClass(active: boolean): string {
  return [
    'bg-[color:var(--tone-warn-soft)] hover:bg-[color:var(--tone-warn-soft)]',
    // The wash is the same either way: what changes when the row is the active
    // one is the accent edge, and that is selection's to add, not status's.
    active ? SELECTION_EDGE_CLASS : '',
    'text-[color:var(--tone-warn-on-tint)]',
  ]
    .filter(Boolean)
    .join(' ')
}

// The unseen-done row is the same treatment in the good tone (owner ruling
// 2026-09-04, replacing the bordered "Done" micro chip): a green fill, the
// title in good ink, and the same one-shot flash on arrival — list-row's
// `--finished`. One notch under the gold by construction (owner, same day: the
// first cut at full strength read heavy): the fill is the 10% wash rather than
// the 18% soft. It holds until the row is opened — `deriveUnseenCompletions`
// clears the mark the moment the workspace becomes the active one — so the
// surface, not a word in the corner, is what says "finished while you were
// away". A chip was the wrong carrier for the same reason the dot was for
// needs-input: the one state that wants you to come back was the quietest
// thing on the row. Needs-input still outranks it — a row that is both draws
// gold, because that one needs an answer rather than a look.
//
// The green ring this used to close with is gone (owner ruling 2026-09-05).
// It was the single worst offender in the whole rail: a 2px green border around
// a row is EXACTLY the mark the focused terminal wears, so the row that had
// finished while you were away was the one row on screen that looked like the
// one you were typing into. The wash stays; the edge went to selection.
//
// Exported for the row-meta suite, which pins the good-tone channels.
export function doneRowClass(active: boolean): string {
  return [
    'bg-[color:var(--tone-good-faint)] hover:bg-[color:var(--tone-good-faint)]',
    active ? SELECTION_EDGE_CLASS : '',
    'text-[color:var(--tone-good-on-tint)]',
  ]
    .filter(Boolean)
    .join(' ')
}
