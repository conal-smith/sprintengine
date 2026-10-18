# File tree

A folder of files, as a tree: one 24px row per entry, indented by depth, a
disclosure chevron on folders, a 16px glyph slot, the name in its git tint and
a one-letter status. It is the Files tab in the workspace pane, the column
beside the file in the editor window, and the file list beside the diff in the
diff viewer — and it is **one tree** in all three, not three trees sharing a
row. Two trees that drew their own rows would be two answers to "how far does a
child indent" and "what does the selected row look like"; two trees with their
own menus would be two answers to "what can I do with this file".

What a row offers is the tree's decision, made once: the same right-click menu
in every host, with an item left off only where it makes no sense for the
entry (a deleted file has nothing on disk to open or rename) or where the host
cannot do it (below). What differs between hosts is what a **click** means —
select, in the Files tab; open the file, in the editor window; show its diff,
in the diff viewer — and where the rows come from.

**Why not `check-row --tree`.** [check-row](../check-row/component.md) is the
pick-_and_-mark row: it spends its fifth element on a checkbox, because in the
Git changes list the tick is the index. A file tree marks nothing — picking a
row is the whole interaction — so it has no box, and its rows can stay at four
elements (chevron, glyph, name, status) under the ceiling without an amendment.

In the app: the rows are `FileTreeRow`, `FileTreeRootRow`, `FileTreePinnedRow`
and `FileTreeRows` in `src/renderer/src/components/ui/FileTree.tsx`; the tree is
`FileExplorerTree` in `src/renderer/src/components/panels/FileExplorer.tsx`,
which the editor window (`EditorFileTree`) and the diff viewer (`DiffFileTree`)
render inside their own bands.

## Anatomy

| Part       | Class                      | Required                                                                                            |
| ---------- | -------------------------- | --------------------------------------------------------------------------------------------------- |
| Tree       | `.ds-file-tree`            | yes — `role="tree"`, one tab stop, `aria-label` naming the root                                     |
| Band       | `.ds-file-tree-band`       | no — the chrome row over a tree with no root row: the root's name, then the filter and collapse-all |
| Band title | `.ds-file-tree-band-title` | with the band — folder glyph and the root's name; the full path is its tooltip                      |
| Row        | `.ds-file-tree-row`        | yes — `role="treeitem"`, `aria-level`, `aria-selected`, `aria-expanded` on folders                  |
| Depth      | `--ds-file-tree-depth`     | yes — a unitless level; one level is `space.lg + space.3xs`, the chevron's advance plus a hair      |
| Twisty     | `.ds-file-tree-twisty`     | yes — the chevron; `--leaf` on a file keeps the slot and drops the mark                             |
| Glyph      | `.ds-file-tree-glyph`      | yes — the reserved 16px slot: the file's kind glyph, or the folder glyph                            |
| Name       | `.ds-file-tree-name`       | yes — truncates from the end; tinted by git status (`--modified`, `--added`, `--deleted`)           |
| Badge      | `.ds-file-tree-badge`      | no — display-only status letter: `A`, `M`, `R`, `D`, `!`                                            |
| Meta       | `.ds-file-tree-meta`       | no — display-only trailing counts before the badge: the diff's `+N −N`, in the `diff.*` inks        |
| Pinned     | `.ds-file-tree-pinned`     | no — the open file when it lies outside the root (below); `role="group"`, outside the tree          |
| Agent      | `.ds-file-tree-agent`      | no — an agent at work on the row (below): the verb or count, then the agent's mark                  |

## Variants

- **Rooted** — the workspace pane's tree: the first row is the root folder
  itself, name strong and path muted, and its chevron folds the whole tree.
  Depth 0 sits one level in from it.
- **Banded** — the editor window's tree: a band names the root and carries
  the view controls, and the first level of the tree is depth 0 with no row
  above it. The band is the root row's job done once, as chrome.
- **Filtered** — the tree with a filter applied, not a separate component:
  exactly a given set of files, with the folders between them and the root
  synthesised from their paths, open until the person closes one. Nothing is
  read from disk to show it. The editor window's _Changed files_ is the files
  git reports; the diff viewer's list is the files the diff holds — after an
  agent's narrowing or a tour — one row per file even where the diff steps
  through it twice (staged and unstaged), with the diff's own status letter
  and `+N −N` rather than the working tree's.
- `.ds-file-tree-row--folder` — a folder's name is set at `font.weight.medium`.
- `.ds-file-tree-row--ignored` — a path the repository ignores: the whole row,
  glyph included, drops to `text.disabled`.

## States

| State                      | Treatment                                                      |
| -------------------------- | -------------------------------------------------------------- |
| Rest                       | `text.default`; the glyph in its kind hue                      |
| Hover                      | `bg.hover`, name to `text.primary` — background only           |
| Selected (tree has focus)  | `--selected`: `bg.selected` plus the 2px inset edge            |
| Selected (focus elsewhere) | `--resting`: `bg.selected-resting`, no edge                    |
| Multi-select companion     | `--resting` — the cursor row alone is `--selected`             |
| Expanded                   | chevron rotated 90°; `aria-expanded="true"`                    |
| Loading                    | the spinner in the chevron's slot, once a listing passes 160ms |
| Drop target                | `bg.selected` plus a 1px accent ring (unfiltered tree only)    |
| Agent reading              | `--agent-reading`: `agent-trail.soft`                          |
| Agent editing              | `--agent-editing`: `agent-trail.soft-strong`                   |

The two selection tiers are `patterns/selection` exactly. In the editor
window the open file's row is selected, and in the diff viewer the file on
screen; while Monaco has the keyboard it rests, and it takes the full fill and
the edge only when the tree itself is being driven. Exactly one edge is ever on
screen.

### Outside the root

When the open file is not under the tree's root — an agent's patch written to
a scratch folder, a file in the home directory — the tree cannot show it, and
saying nothing would leave the person exactly as lost as before. A **pinned**
block shows between the band and the tree, for as long as that file is the
open one: a caption, _Outside this workspace_ (`.ds-file-tree-pinned-label`),
over one row (`.ds-file-tree-pinned-row`) holding the file's glyph, its
**name** as the primary text (`-name`), and its folder as muted secondary text
(`-dir`) truncated in the middle — the head of the path gives way, the folder
nearest the file stays. The full path is the row's tooltip.

It sits outside the tree's scroll, so no row slides under it, and outside the
tree's keyboard walk. It is the open file, not a keyboard cursor, so it wears
the open file's **resting** fill (`bg.selected-resting`) and never the accent
edge. Its menu (a trailing overflow button, and right-click) has two items:
_Reveal in Finder_ (_Show in Explorer_ on Windows, _Show in file manager_
elsewhere) and _Copy path_.

### Agent trail

While an agent works, the tree shows where — in every host, since "is an agent
in this file?" does not change with the window it is asked in: the file it is reading
or editing wears a violet wash, stronger for an edit, with the verb at the
row's end (`.ds-file-tree-agent-verb`, _reading_ or _editing_). The file the
agent is on right now also carries the agent's own mark after the verb: its
character ([agent-glyph](../agent-glyph/component.md)), or the working mark
with characters turned off, both inked violet. A spawned agent wears the face
its lane in the chat wears, so two agents in one tree are told apart.

A **closed** folder holding a marked file takes the same wash and says how
many marked files are under it, with the agent's mark when the agent is in
there, so a collapsed tree still shows the way down: open the folder and the
mark moves one level in. An open folder carries nothing, because the rows
under it say it.

A file stays marked while the call on it runs, ten seconds after, and for as
long as it is the last file its agent touched while the chat works — an agent
thinking over the file it just read is still on it. Then the wash fades on the
row's own colour transition.

The trail's colours are its own tokens (`agent-trail.ink`, `.soft` and
`.soft-strong`), never the identity violet a stylesheet or image glyph wears:
no git tint or accent is violet, and a glyph's hue never fills a row, so a
violet wash and a violet word at the row's end read as the agent and nothing
else. The trail takes the wash channel, standing in for a declared role's
wash while it is there; the name keeps its git tint and the glyph its kind
hue. Selection still wins the fill.

## Usage

**Every row is exactly 24px.** `size.hit-target-min`, reached through the
vertical padding — the glyph slot stays 16px so the chevron, folder and file
marks line up with every rail in the app. Nothing a row holds may make it
taller; the rename field that replaces a name is 20px for that reason. The
fixed pitch is also what lets a folder past a thousand rows be windowed by
arithmetic instead of measurement.

**Colour has three channels, one each.** The glyph's hue is the file's kind;
the name's tint is its git status; the row's ink is whether it is ignored.
Selection lifts the fill and the ink, and removes any wash, but never repaints
the glyph or the status tint.

**A reveal lists only the ancestors.** Following the open file expands exactly
the folders between the root and the file, reading only the ones not already
read, then selects the row and scrolls it to the nearest edge. It never scans
the tree, and a tab switch that lands before the last one finished cancels it.

**Only the Files tab remembers for the workspace.** The editor window's and
the diff viewer's trees keep their own open folders, and their columns' width
and visibility live in their own storage — never in the workspace's
remembered state, which is the Files tab's, so two trees on one workspace never
fight over which folders are open.

**A window that cannot write the workspace says so by leaving items out.** The
editor window and the diff window are auxiliary windows; the workspace is not
theirs to write. Their menus leave off _Mark directory as_, a rename carries
that window's own tabs rather than the workspace's, and _View Git diff_ opens
the diff window. Everything else — open, reveal, new, copy, paste, rename,
delete, refresh, a module's actions — is the same menu.

**The diff viewer's column is shown in the window and hidden in the pane.** The
pane's Diff tab is the narrow right-hand column, where a tree beside a
side-by-side diff leaves neither readable, and the band's file stepper already
walks the list there; one press on the band's files switch shows it. Either
host remembers the choice, and the column's width, for itself.

**Rebuilding it in a framework:** what must survive is the fixed 24px pitch,
the one glyph column (the leaf keeps the chevron's slot), the three colour
channels, the two selection tiers, and the one-tab-stop keyboard contract.

## Accessibility

- The tree is **one tab stop**. ↑/↓ move the selection, Home/End jump to the
  ends, → opens a folder (or steps into it when open), ← closes it (or steps
  to its parent), Enter opens a file or toggles a folder.
- **Escape returns focus to the editor** in the editor window (to the diff, in
  the diff viewer), and must not reach the window's own Escape (which closes
  it). The diff viewer's own arrow keys stand back while the tree has focus.
- A plain click or Enter on a file does the host's thing (open it, show its
  diff); a modifier click still extends the selection, and a double click
  opens the file in an editor.
- Every row carries `aria-level`; folders carry `aria-expanded`; the selected
  row carries `aria-selected="true"`. The chevron is `tabindex="-1"` — the
  keyboard reaches folders through the tree, not through the chevron.
- The status letter is display-only and duplicated in the name's tint; it is
  never the only carrier of the state.
- The agent trail says itself in words to assistive tech: a visually hidden
  _an agent is editing this_ on a file, _an agent is reading 3 files in here_
  on a folder. The verb, the count and the agent's mark are hidden from it.
- The pinned block is a `role="group"` beside the tree, not a treeitem, and
  names itself in full — file, _outside this workspace_, and
  the folder — since its visible folder may be truncated.
