import type { RegisteredModalSurfaceLauncher, SurfaceIconComponent } from '../../../modules/renderer-host'
import type { WorkspacePaneTabKind } from '../../../types/workspace'

// The kinds the workspace pane can open, in the order the "+" menu and the
// empty-state launcher list them. A kind whose module is disabled is absent
// from both, not present-but-empty.
//
// Most kinds become a TAB of the pane. A kind with `modalSurfaceId` does not:
// picking it floats that registered modal surface over the page at workbench
// width instead (Reviews, 2026-09-05). The pane is still where the person
// reaches for it — it sits in the same list as Browser and Diff, because it is
// the same kind of thing, a view of this workspace's work — but the pane
// column is too narrow to read a walkthrough in, so the pane hands it off.
//
// Those modal rows are CONTRIBUTED, not listed here (D7, 2026-09-10): a module
// declares one on its modal surface (`registerModalSurface({ launcher })`) and
// `composePaneKinds` appends it to the static list below. Reviews was the one
// hard-coded row, and it left with the review module.

// What the launcher and the "+" menu can pick: every tab kind, plus the ids of
// contributed modal rows — open strings, because the shell cannot know them.
// The `(string & {})` arm keeps editor completion on the tab kinds.
export type PaneLaunchKind = WorkspacePaneTabKind | (string & {})

export type PaneKindDefinition = {
  kind: PaneLaunchKind
  label: string
  // The letter that opens the kind while the "+" menu or the launcher has
  // focus. Uppercase, as the hint column prints it.
  letter: string
  // Capability module the kind belongs to; undefined for core kinds.
  moduleId?: string
  // The same component type a module hands the host, so a contributed row's
  // glyph and a built-in one are the same kind of thing here.
  Glyph: SurfaceIconComponent
  // Set when picking the kind opens a modal surface rather than a pane tab.
  modalSurfaceId?: string
}

function TerminalGlyph({ className }: { className?: string }) {
  return (
    <svg viewBox="0 0 16 16" fill="none" className={className} aria-hidden="true">
      <rect x="2" y="3" width="12" height="10" rx="1.5" stroke="currentColor" strokeWidth="1.5" />
      <path
        d="M5 6.5 7 8.5 5 10.5M8.5 10.5h3"
        stroke="currentColor"
        strokeWidth="1.5"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  )
}

function FilesGlyph({ className }: { className?: string }) {
  return (
    <svg viewBox="0 0 16 16" fill="none" className={className} aria-hidden="true">
      <path
        d="M2 4.5A1.5 1.5 0 0 1 3.5 3h3l1.5 1.5h4.5A1.5 1.5 0 0 1 14 6v5.5a1.5 1.5 0 0 1-1.5 1.5h-9A1.5 1.5 0 0 1 2 11.5v-7z"
        stroke="currentColor"
        strokeWidth="1.5"
        strokeLinejoin="round"
      />
    </svg>
  )
}

function GitGlyph({ className }: { className?: string }) {
  return (
    <svg viewBox="0 0 16 16" fill="none" className={className} aria-hidden="true">
      <circle cx="4.5" cy="3.5" r="1.5" stroke="currentColor" strokeWidth="1.5" />
      <circle cx="4.5" cy="12.5" r="1.5" stroke="currentColor" strokeWidth="1.5" />
      <circle cx="11.5" cy="5.5" r="1.5" stroke="currentColor" strokeWidth="1.5" />
      <path d="M4.5 5v6M11.5 7c0 2.5-3 2.5-7 4" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" />
    </svg>
  )
}

// Plus over minus in the rounded frame the Terminal and Canvas glyphs share, so
// it sits in the tab strip as one of the family. A page with ± on it was the
// other candidate; it reads as `create-patch`, the Git panel's verb.
function DiffGlyph({ className }: { className?: string }) {
  return (
    <svg viewBox="0 0 16 16" fill="none" className={className} aria-hidden="true">
      <rect x="2.25" y="2.25" width="11.5" height="11.5" rx="2.25" stroke="currentColor" strokeWidth="1.5" />
      <path d="M8 4.75v4M6 6.75h4M6 11h4" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" />
    </svg>
  )
}

function BrowserGlyph({ className }: { className?: string }) {
  return (
    <svg viewBox="0 0 16 16" fill="none" className={className} aria-hidden="true">
      <circle cx="8" cy="8" r="6" stroke="currentColor" strokeWidth="1.5" />
      <path
        d="M2 8h12M8 2c2 2 2 10 0 12M8 2c-2 2-2 10 0 12"
        stroke="currentColor"
        strokeWidth="1.5"
        strokeLinecap="round"
      />
    </svg>
  )
}

// A pencil drawing on a frame: the board and the hand on it. The frame is the
// same rounded rect the Terminal and Files marks are built from, so the six
// kinds read as one family rather than as six drawings.
//
// Exported because the board picker plates the same mark on every one of its
// rows: the tab's kind and the rows that open a tab of that kind must be one
// drawing, not two that drift.
export function CanvasGlyph({ className }: { className?: string }) {
  return (
    <svg viewBox="0 0 16 16" fill="none" className={className} aria-hidden="true">
      <path
        d="M2 4.5A1.5 1.5 0 0 1 3.5 3h9A1.5 1.5 0 0 1 14 4.5v4"
        stroke="currentColor"
        strokeWidth="1.5"
        strokeLinecap="round"
      />
      <path d="M2 8.5v3A1.5 1.5 0 0 0 3.5 13H7" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" />
      <path
        d="M13.2 8.3 9 12.5l-2 .5.5-2 4.2-4.2a1.06 1.06 0 0 1 1.5 1.5Z"
        stroke="currentColor"
        strokeWidth="1.5"
        strokeLinejoin="round"
      />
    </svg>
  )
}

// The header's Backlog switch draws this same mark (PanelSwitches): one glyph
// for the surface on both ends of the gesture.
function BacklogGlyph({ className }: { className?: string }) {
  return (
    <svg viewBox="0 0 16 16" fill="none" className={className} aria-hidden="true">
      <path d="M6 4.5h7M6 8h7M6 11.5h7" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round" />
      <circle cx="3" cy="4.5" r="1" fill="currentColor" />
      <circle cx="3" cy="8" r="1" fill="currentColor" />
      <circle cx="3" cy="11.5" r="1" fill="currentColor" />
    </svg>
  )
}

// A little robot, still: the Agents list. The characters that move live on the
// agents themselves; the kind's own mark stays a plain glyph.
function AgentsGlyph({ className }: { className?: string }) {
  return (
    <svg viewBox="0 0 16 16" fill="none" className={className} aria-hidden="true">
      <rect x="3" y="5.4" width="10" height="7.8" rx="2.4" stroke="currentColor" strokeWidth="1.5" />
      <path d="M8 5.4V3" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" />
      <path d="M6.2 8.6v1.4M9.8 8.6v1.4" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" />
    </svg>
  )
}

// A page with its lines: a document the pane reads, drawn on the same frame
// as the Files and Canvas marks.
function DocumentGlyph({ className }: { className?: string }) {
  return (
    <svg viewBox="0 0 16 16" fill="none" className={className} aria-hidden="true">
      <path
        d="M4.5 2h4.8L12 4.7v7.8a1.5 1.5 0 0 1-1.5 1.5h-6A1.5 1.5 0 0 1 3 12.5v-9A1.5 1.5 0 0 1 4.5 2z"
        stroke="currentColor"
        strokeWidth="1.5"
        strokeLinejoin="round"
      />
      <path d="M5.5 8h5M5.5 10.5h3.5" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" />
    </svg>
  )
}

// The five general-purpose kinds first, in the order below; Backlog is
// ours alone and goes last so the shared five keep the low chord numbers.
// Its letter is L (back-L-og) because B is Browser's. Canvas follows it, on
// the same rule: it is a workspace surface of ours, not one of the shared
// five, so it appends rather than pushing a chord number along.
export const STATIC_PANE_KINDS: readonly PaneKindDefinition[] = [
  { kind: 'browser', label: 'Browser', letter: 'B', Glyph: BrowserGlyph },
  { kind: 'terminal', label: 'Terminal', letter: 'T', Glyph: TerminalGlyph },
  { kind: 'files', label: 'Files', letter: 'F', moduleId: 'dev-tools', Glyph: FilesGlyph },
  { kind: 'diff', label: 'Diff', letter: 'D', moduleId: 'git', Glyph: DiffGlyph },
  { kind: 'git', label: 'Git', letter: 'G', moduleId: 'git', Glyph: GitGlyph },
  { kind: 'backlog', label: 'Backlog', letter: 'L', moduleId: 'backlog', Glyph: BacklogGlyph },
  { kind: 'canvas', label: 'Canvas', letter: 'C', moduleId: 'canvas', Glyph: CanvasGlyph },
  // The agents the focused chat sent off to work, running and finished.
  { kind: 'agents', label: 'Agents', letter: 'A', Glyph: AgentsGlyph },
]

// Kinds that are tabs but never offered by the "+" menu or the launcher: a
// Document tab is always opened ON a file someone handed it (a plan an agent
// proposed), and an empty one would have nothing to pick from.
const TAB_ONLY_PANE_KINDS: readonly PaneKindDefinition[] = [
  { kind: 'document', label: 'Document', letter: '', Glyph: DocumentGlyph },
]

// The list one pane offers: the shell's own kinds, then the rows modules
// contributed, each dropped when its module is off (absent, never greyed).
//
// Static rows win a letter collision. The shell's keys are muscle memory and
// the person did not install anything to lose them, so a contributed row that
// wants a taken letter — or one an earlier contributed row already took —
// keeps its label and glyph and simply has no shortcut; the launchers print
// nothing in the hint column and no keypress opens it. Two modules cannot be
// made to agree on letters, so the arbitration has to live here.
export function composePaneKinds(
  launchers: readonly RegisteredModalSurfaceLauncher[],
  moduleEnabled: (moduleId: string) => boolean,
): PaneKindDefinition[] {
  const kinds = STATIC_PANE_KINDS.filter((definition) => !definition.moduleId || moduleEnabled(definition.moduleId))
  const taken = new Set(kinds.map((definition) => definition.letter))
  for (const launcher of launchers) {
    if (!moduleEnabled(launcher.moduleId)) continue
    const free = launcher.letter.length > 0 && !taken.has(launcher.letter)
    if (free) taken.add(launcher.letter)
    kinds.push({
      kind: launcher.surfaceId,
      label: launcher.label,
      letter: free ? launcher.letter : '',
      moduleId: launcher.moduleId,
      Glyph: launcher.Glyph,
      modalSurfaceId: launcher.surfaceId,
    })
  }
  return kinds
}

// A tab's own row. Only ever asked about TAB kinds (a contributed row opens a
// modal and never becomes a tab), so the static lists are the whole answer.
export function paneKindDefinition(kind: PaneLaunchKind): PaneKindDefinition {
  return (
    STATIC_PANE_KINDS.find((definition) => definition.kind === kind) ??
    TAB_ONLY_PANE_KINDS.find((definition) => definition.kind === kind) ?? {
      kind,
      label: kind,
      letter: kind[0]?.toUpperCase() ?? '',
      Glyph: BrowserGlyph,
    }
  )
}

// Kinds that keep their panel mounted while another tab is showing: a
// terminal's buffer (and, later, a browser's page) must survive a tab switch.
// A canvas joins them because unmounting its editor drops the board's
// subscription and the undo stack the person built up, and remounting reloads
// and re-lays-out a scene — a tab switch must not cost either.
export function paneKindRetainsPanel(kind: WorkspacePaneTabKind): boolean {
  return kind === 'terminal' || kind === 'browser' || kind === 'canvas'
}
