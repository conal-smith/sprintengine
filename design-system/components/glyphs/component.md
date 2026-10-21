# Glyphs

The product's icon language: one concept per glyph, drawn in `currentColor`
line work, sized only by the `--sem-icon-size-*` ramp. The seventy-three SVGs in
`glyphs/` (close, search, spinner, sprintengine-mark, git-branch, remote-machine,
schedule, wsl-machine,
the four `device-*` marks, the six `machine-*` kinds, the composer's six —
plus, conversation, terminal-agent, attach, plugins, send —
commit, worktree, history, folder, file-typescript, file-generic, the three
pull-request marks — pull-request-open, pull-request-merged,
pull-request-closed — and the
nineteen Commit-window action marks — rollback, move-to-changelist, stash,
group-by, expand-all, collapse-all, next-difference, previous-difference,
show-diff, side-by-side, unified, gear, open-in-editor, write-commit-message,
new-changelist, delete-changelist, edit-changelist, create-patch, kebab — and
the diff tour's four — tour, play, pause, step-list — and the copy
affordance's pair — copy, and the check it confirms with — and the code
block's three — wrap-lines, terminal-prompt, view-source — the chat's ten tool-step
marks, `tool-*`, the quote mark — quote — and open-in-window) are
the framework-neutral assets; the shipped vocabulary lives in React —
`src/renderer/src/components/AppIcons.tsx` and the `ui/` glyph primitives
beside it. This entry documents that vocabulary so a consumer can pick, size,
and color a glyph without reading the React source.

A glyph is not decoration and not a status pill. It answers exactly one
question — *which thing is this* (identity), *where is it in its pipeline*
(lifecycle), *which machine is it on* (device), *what kind of capability*
(capability), *which runtime* (CLI), or *what will this control do* (action) —
and each question has its own family below. A surface that reaches for two
families to answer one question has the wrong hierarchy, not the wrong icon.

## Anatomy

Two drawing grids, each with its own stroke discipline:

| Grid | Primary stroke | Drawn by |
|---|---|---|
| 24 × 24 | `1.7` (the `iconStroke` constant) | `AppIcons.tsx` — every action, identity, status, and settings icon; `CliIcon.tsx` tile marks (1.7 frame, 1.9 letterform) |
| 16 × 16 | `1.2 – 1.5` | the `ui/` primitives — `LifecycleGlyph` (1.4–1.5), `PullRequestGlyph` (1.4), `CapabilityGlyphs` (1.3), `RefreshIcon` (1.35), `StarGlyph` (1.4), `FileTypeGlyph` (1.2 frame, 1.3–1.4 line work, 1.45 letterform) — and the assets in `glyphs/` |

The 24-grid stroke flexes deliberately and narrowly: secondary strokes step
*down* by 0.1–0.3 (`iconStroke - 0.2` on the `AutomationsWorkspaceTypeIcon`
bolt), and a
check or emphasis stroke steps *up* to 1.8–1.9 (the shield tick, the tile
letterforms). Anything outside that band is drift, not a variant.

- **`currentColor`, always.** A glyph inherits the ink of the text beside it
  and never carries its own palette. The whole list of self-coloring
  exceptions: `LifecycleGlyph`, which inks each state in its lifecycle tone
  (below), and the two **identity-colour** families ruled 2026-09-06
  (principles.md → "Identity colour"): vendor marks in their vendors' colours
  (`CliIcon`, `brand/EditorMarks`), and `FileTypeGlyph` under `tone="kind"`,
  which inks by language from the `--sem-color-mark-*` ramp — and a third,
  ruled 2026-10-04: `MachineGlyph`, which inks a machine's kind in that
  machine's colour (Machine kinds, below).
- **Drawn for 16 px.** Every glyph must read at `--sem-icon-size-sm`; detail
  that only resolves at 22 px is detail the glyph cannot afford.
- **Named by grid.** 24-grid components end in `Icon`; 16-grid primitives end
  in `Glyph`. (`RefreshIcon` predates the rule — see Known drift.)
- **Never its own hit area.** An interactive glyph pads out to
  `--sem-size-control-xs` (26 px) with a transparent hit area; the glyph
  itself never grows to fill the target.

**The size ramp** — these four steps are the sanctioned sizes, and 16 px is
the rail canon (the leading-glyph slot of every sidebar and door-rail row):

| Token | Value | Use |
|---|---|---|
| `--sem-icon-size-xs` | 13px | Inline glyphs beside meta copy and inside chips |
| `--sem-icon-size-sm` | 16px | **The default.** List-row leading slots, toolbars, close glyphs |
| `--sem-icon-size-md` | 18px | Icons paired with button labels, panel-header chrome |
| `--sem-icon-size-lg` | 22px | Empty-state glyphs, large overlay close buttons |

A rail row reserves a fixed 16 px leading slot whether or not the glyph fills
it — an unreserved slot is what lets sibling doors' titles start at three
different x-offsets (Known drift).

## Variants

The variants of this system are its families. Within a family, glyphs share a
grid, a stroke, and a naming pattern; across families they share nothing but
the ramp and `currentColor`.

### Core actions and navigation (24-grid)

| Export | Meaning |
|---|---|
| `CheckIcon` | Confirmed / applied — `glyphs/check.svg` is its 16-grid sample |
| `ChevronDownIcon` | Disclosure; rotate for other directions rather than adding siblings |
| `CopyIcon` | Copy to clipboard — `glyphs/copy.svg` is its 16-grid sample. Reach for it through `CopyGlyphButton`, which swaps it for `CheckIcon` on a landed copy ([button → The copy glyph](../button/component.md#the-copy-glyph)) |
| `NewChatIcon` | Compose — pencil-in-square, deliberately *not* a plus, because compose is not create |
| `WarningIcon` | Finding / warning triangle — a real glyph so it scales and inks like one, never the `▲` character |
| `FolderPlusIcon` | Install from a folder on disk — a folder wearing the plus |
| `ResetIcon` | Restore a default: the shortcut a person rebound, a setting they changed |
| `ReleaseNotesIcon` | What changed in this version |

There is no standalone `CloseIcon`. The dismiss mark lives inside
`ui/CloseIconButton`, on its own 14-grid at stroke 1.4, because a close glyph
is only ever a button — an unpadded one is below the hit-target floor.
`glyphs/close.svg` is the framework-neutral sample of the same mark.

### Workspace-type identity (24-grid, registry-resolved)

`WorkspaceTypeIcon` is the dispatcher: it resolves a workspace mode through
the renderer host registry, gated on module enablement when
`moduleOverrides` is passed, and degrades to the standard glyph for anything
disabled or unknown. Consumers go through it; the concrete marks exist for
the registry to point at:

| Mark | Drawing |
|---|---|
| the standard fallback | Terminal-in-frame — module-private, reached only through the dispatcher |
| `AutomationsWorkspaceTypeIcon` | Schedule dial around a lightning bolt — "on a schedule, do work" |
| `FolderTypeIcon` | The project folder, optionally wearing a workspace's own logo |

### Product mark (`brand/SprintEngineFrond.tsx`)

`SprintEngineFrond` is the SprintEngine frond, copied path-for-path from the
mobile app's generated icon so both products carry one drawing. Two tones:
`brand` keeps the mark's own ink and rust leaflet, for the fixed-light icon
chip; `current` draws it in `currentColor` for chrome that inks its own glyphs.
It is a brand mark, not a workspace type, so the dispatcher never resolves to
it. The brand accent tokens `--tool-sprintengine` and `--tool-sprintengine-ink`
stay defined for brand ink on themed chrome; the frond does not read them.

### Device identity (16-grid — `AppIcons.tsx`)

The identity family for **a machine on the tailnet**: what kind of thing it is,
one shape each, at 16px so it leads a settings row without out-weighing the
name beside it. Added 2026-09-10 for the rebuilt Settings › Remote, where a
list merges this machine, paired devices, outbound connections and the peer
scan into one set of rows — and a list that is one row per *machine* has to say
which machine at a glance.

They are drawn to one discipline, because `remote-machine.svg` (the Beam) is
the family's fallback and the five have to read as one set: the 16-grid,
stroke **1.4**, `fill="none"` line work in `currentColor`, rounded rects at
`rx` 1.3–1.8, and a filled 0.75r dot where a unit needs a light.

| Export | Asset | Drawing |
|---|---|---|
| `DeviceMacGlyph` | `glyphs/device-mac.svg` | The flat wide box with one small dot — a Mac mini seen head-on |
| `DeviceDesktopGlyph` | `glyphs/device-desktop.svg` | A monitor on a stand: the screen rect, a short neck, a foot |
| `DeviceLaptopGlyph` | `glyphs/device-laptop.svg` | An open lid over a base line. The gap between them is the hinge, and it is what separates this from the monitor at a glance |
| `DevicePhoneGlyph` | `glyphs/device-phone.svg` | A tall rounded rect with a short bottom mark |
| `RemoteMachineGlyph` | `glyphs/remote-machine.svg` | The family's **fallback**, and the mark for a machine whose kind is unknown. Listed under Utility marks, where it also serves every other "this is elsewhere" surface |

**The mapping is a rule, not a per-caller choice** — `deviceGlyphFor({ os, hostName })`
in `ui/` is the single implementation, and callers pass an OS string and a host
name and take what comes back:

1. macOS whose host name says desktop — it contains `mini`, `imac`, `studio` or
   `pro`, and does **not** contain `book` → `DeviceMacGlyph`.
2. macOS whose host name contains `book` → `DeviceLaptopGlyph`.
3. Windows or Linux → `DeviceDesktopGlyph`.
4. Android or iOS → `DevicePhoneGlyph`.
5. Anything else, including an absent OS → `RemoteMachineGlyph`.

The `book` exclusion in rule 1 is the whole reason the rule is written down
once: "MacBook Pro" satisfies both halves of the desktop test, and a rule
re-derived at each call site gets that backwards on one of them. It is a
**guess about a name**, which is why the fallback is a real mark rather than an
empty slot — a machine whose name says nothing is still a machine.

One mark per row, and the glyph never carries the online/offline state: an
offline row dims its glyph, title and supporting line together with the row's
own treatment, and the row's words say what happened.

### Machine kinds (16-grid — `AppIcons.tsx`, drawn by `ui/MachineMark`)

What a machine IS, drawn as the device, in the machine's own colour (owner
ruling 2026-10-04). Where Device identity above is a guess the tailnet list
makes from an OS string and a host name, this family is a machine's settled
identity: a default kind from what the machine is, a default colour from a
hash of its stable id, and both changeable in Settings › Machines. It marks a
machine wherever a surface names one — the composer's context strip, a
sidebar row (trailing), a chat tab, the machine picker's rows and Settings ›
Machines — and **never this machine**, which is the unmarked default.

| Kind | Export | Asset | Drawing | Default for |
|---|---|---|---|---|
| `laptop` | `DeviceLaptopGlyph` | `glyphs/device-laptop.svg` | The Device identity laptop, shared | A paired Mac (its name says nothing else) |
| `desktop` | `DeviceDesktopGlyph` | `glyphs/device-desktop.svg` | The Device identity monitor, shared | Any other paired machine |
| `mini` | `MachineMiniGlyph` | `glyphs/machine-mini.svg` | A small box under a sloped lid, with a slot of light | A paired Mac whose name says `mini` or `studio`, or a `mini` PC |
| `tower` | `MachineTowerGlyph` | `glyphs/machine-tower.svg` | A tall case with two bays | A paired Mac Pro |
| `server` | `MachineServerGlyph` | `glyphs/machine-server.svg` | Three units in one rack, each with its light | An SSH machine |
| `cloud` | `MachineCloudGlyph` | `glyphs/machine-cloud.svg` | A cloud | Chosen by hand |
| `container` | `MachineContainerGlyph` | `glyphs/machine-container.svg` | A cube | Chosen by hand |
| `board` | `MachineBoardGlyph` | `glyphs/machine-board.svg` | A board with its chip and two pins | Chosen by hand |
| `wsl` | `WslMachineGlyph` | `glyphs/wsl-machine.svg` | A window with a title bar and a prompt | A WSL distribution |

There is no phone and no tablet: the server never runs on one. (`device-phone`
stays in Device identity, where a phone pairs as a client.)

**Colour.** One of eight: the seven `--sem-color-mark-*` hues and a neutral
(`--sem-color-text-muted`). The default is the top half of a 32-bit FNV-1a hash
of the machine's id, over the seven hues — never the neutral, which is a choice
a person makes. The id is what every device agrees on — the WSL host id,
`ssh:<host name>` (no user, and `:<port>` only when it is not 22),
`tailnet:<short host name>` — so the same machine is the same colour wherever
it is seen. Only a host name is shortened: a tailnet address or a typed name
with a full stop in it is kept whole, or every `100.x` address would share one
id. A paired machine's default kind reads its host name as words, so
`macro-runner` is not a Mac; a wrong guess is one pick away in Settings ›
Machines. The colour is on the glyph and nowhere else: never
the machine's name, a row wash or a pill.

`MachineGlyph({ identity })` is the one way to draw one: the kind's drawing
inside a span inked by `MACHINE_COLOUR_INK`, decorative, carrying
`data-machine-mark` with the machine's id. The surface names the machine.

### Composer (16-grid — `ui/ComposerGlyphs.tsx`)

The New chat composer's own marks (owner ruling 2026-10-04). Stroke 1.4,
`currentColor`, round caps and joins.

| Export | Asset | Drawing |
|---|---|---|
| `ComposerPlusGlyph` | `glyphs/plus.svg` | A plus: the composer's options |
| `ConversationGlyph` | `glyphs/conversation.svg` | A speech bubble with its tail: Start as Conversation |
| `TerminalAgentGlyph` | `glyphs/terminal-agent.svg` | The terminal frame and prompt, with a small plus of activity in its corner: Start as Terminal agent |
| `TerminalPromptGlyph` | `glyphs/terminal-prompt.svg` | The plain terminal (Code block actions, above): Start as Terminal |
| `AttachGlyph` | `glyphs/attach.svg` | A paper clip: Attach files |
| `PluginsGlyph` | `glyphs/plugins.svg` | A puzzle piece: Skills, plugins & MCPs |
| `SendGlyph` | `glyphs/send.svg` | An arrow up, inside the round send |
| `QueueGlyph` | `glyphs/queue.svg` | Three lines of a list with a plus: the round send while the agent works, when it queues the message for the turn's end |
| `SteerGlyph` | `glyphs/steer.svg` | An arrow that turns up and to the right: the round send while the agent works, when it hands the message to the running turn |
| `WorktreeGlyph` | `glyphs/worktree.svg` | A folder holding a commit node: the strip's Worktree switch, and the Git panel's Worktrees view |

### Status (16-grid)

There is one status vocabulary, and it is `LifecycleGlyph` (below). The 24-grid
`PriorityIcon` / `StatusIcon` pair that used to sit here is gone: it was a
second answer to the same question, drawn on a different grid, and the folder
status enum it keyed off is now `FolderStatus` in the shared layer with no
glyph family of its own.

`StatusDot` draws from this same vocabulary: the product draws no status dots
(owner ruling 2026-09-28), so a status tone maps onto a lifecycle shape —
danger to `failed`'s ×, warn to `needs_input`'s !, good and merged to `done`'s
check, neutral to `blocked`'s bar, accent to `in_progress`'s held arc — and a
live good or accent tone is the working mark (`components/liveness`). One
status idiom per surface still holds: a surface speaks in status tones
(`StatusDot`) *or* in lifecycle states (`LifecycleGlyph`), never both, or the
same shapes turn up twice saying two different things.

### Lifecycle (16-grid — `ui/LifecycleGlyph.tsx`)

The shape-coded lifecycle vocabulary shared by Backlog readiness and
Automations run state. Ten states, read by shape first — every state
survives grayscale — with ink only reinforcing:

| Shape | States |
|---|---|
| Ring (plain / dashed) | `todo`, `ready` (heavier stroke), `idea` (dashed) |
| Ring + inner mark | `blocked` (bar), `paused` (pause bars), `needs_input` (!), `archived` (slash), `failed` (×) |
| Quarter gauge arc | `in_progress` ¼ (spins when `live`) |
| Filled disc + check | `done` |

Held states (`blocked`, `paused`) are neutral ink, never the accent — the
accent means *startable or live right now*, and never `--tone-error` —
waiting is calm, not a defect.

### Pull request (16-grid — `ui/PullRequestGlyph.tsx`)

*Where did this work go* — the state of a pull request, in the three marks
GitHub itself has taught people to read (epic `pull-request-marks`, decision 1,
2026-09-09). 16-grid, stroke 1.4, `currentColor`, `fill="none"`. All three are
the same branch-and-node armature, so the family reads as one set; what differs
is where the branch ends, and that difference is the state.

| State | Drawing | Asset |
|---|---|---|
| `open` | The branch beside main with an arrow that has NOT gone in: two nodes on the left rail, a third down on the right, and the connector turning back into an arrowhead that stops short of it | `glyphs/pull-request-open.svg` |
| `merged` | The branch gone into main: the right-hand node sits at the middle and the connector curves cleanly into it | `glyphs/pull-request-merged.svg` |
| `closed` | The branch ending in a cross: the same three nodes, the right-hand connector cut short, and an × where the merge would have been | `glyphs/pull-request-closed.svg` |

**Three states and no more.** A draft is an *open* pull request and wears the
open mark — the word "draft" belongs in the tooltip, not in a fourth drawing.
There is no "unknown" mark either: nothing is drawn unless a pull request
definitely exists, so a lookup that could not be made draws exactly what no
pull request draws (decision 3).

**Shape first, tone second.** The three shapes are distinguishable in
grayscale; the tone only agrees with the shape. The tone map is shared — one
function, `pullRequestTone` in `src/shared/git/pull-request.ts` — so every
surface inks the same state the same way:

| State | Tone | CSS variable |
|---|---|---|
| `open` | `accent` — the one you can still act on | `--accent-primary` |
| `merged` | `merged` — the violet a landed branch already wears | `--tone-merged` (`--sem-color-status-merged`) |
| `closed` | `error` — GitHub's own red for a pull request that ended without landing | `--tone-error` (`--sem-color-status-danger`) |

The primitive takes `state` and an optional `label`; the caller owns the size
(`icon-xs` beside meta copy, `icon-sm` in a row's leading slot) and the ink.

**Every pull request in the product is drawn from here.** `BranchStepStrip`'s
merge commits take the merged drawing, and `PullRequestMark` — the pull request a
conversation wears on its sidebar line and in its peek card — leads with the
mark for its state. Nothing draws its own.

### Capability (16-grid — `ui/CapabilityGlyphs.tsx`)

| Export | Meaning |
|---|---|
| `SkillsGlyph` | The Skills category mark (framed panel) |
| `McpGlyph` | The MCP plug mark |

Shared by Extensions and capability inventory rows so a category reads the
same everywhere; default themselves to `icon-xs` + `--text-muted`.

### CLI / runtime marks (`CliIcon.tsx`)

`CliIcon(cli)` resolves an agent CLI to one of eight marks: `claude-code`
(the brand starburst — the one glyph with its own fill), `codex` (the knot
mark, `currentColor`), `opencode`, and five original rounded-square tile
marks (`zai`, `grok`, `kimi`, `cursor`, `muse` — placeholders until official
brand SVGs are bundled; both Kimi runtimes share one mark so they read as one
provider), with `terminal` as the fallback. Tile marks keep the 24-grid
discipline: 1.7 frame, 1.9 letterform.

### File type (16-grid — `ui/FileTypeGlyph.tsx`)

*Which kind of file is this row about*, answered by shape first. One drawing
per kind in the 16 px leading slot every tree and list row reserves — the File
Explorer and the Git changes list wear the same mark for the same file, so a
`.ts` reads as a `.ts` on both (owner 2026-09-05). `fileTypeKind(name)` is the
pure resolver and `FILE_TYPE_LABEL` names each
kind for a tooltip or `aria-label`; the identity hue a kind wears when coloured
is private to the component, applied through its `tone` prop.

| Kind | Shape |
|---|---|
| `typescript` · `javascript` · `python` · `rust` · `go` | Letter tile: rounded frame at 1.2, letterform at 1.45 (TS / JS / PY / RS / GO) — the 16-grid cousin of the `CliIcon` placeholder tile |
| `typescript-test` · `javascript-test` · `python-test` · `rust-test` · `go-test` · `react-test` | The same drawing with its bottom-right corner notched for a tick — `*.test.*` and `*.spec.*` |
| `react` | The atom — `.tsx` / `.jsx` |
| `json` | Braces `{ }` |
| `markdown` | M with a down arrow |
| `yaml` | Indented list lines |
| `html` | Angle brackets `< >` |
| `css` | Hash `#` |
| `shell` | Prompt `>_` |
| `java` | Cup |
| `image` | Framed landscape |
| `pdf` | Page with a P — `.pdf` |
| `document` | Page with a W — `.docx` / `.doc` / `.odt` / `.rtf` / `.pages` |
| `spreadsheet` | Ruled grid, header row and first column — `.xlsx` / `.xls` / `.ods` / `.numbers` / `.csv` / `.tsv` |
| `presentation` | Slide on its stand — `.pptx` / `.ppt` / `.odp` / `.key` |
| `archive` | Page zipped down the middle — `.zip` / `.tar` / `.gz` / `.7z` / `.rar` |
| `lock` | Padlock — lockfiles (`package-lock.json`, `yarn.lock`, `Cargo.lock` …) |
| `config` | Gear — dotfiles, `.env*`, `Dockerfile`, `.toml` / `.ini` / `.xml` |
| `text` | Document with lines — `.txt`, `.log`, `LICENSE`, `README` |
| `generic` | Plain document — anything unrecognised |

Colour is the `tone` axis, and the surface picks it (ruled 2026-09-06,
amended 2026-09-09, principles.md → "Identity colour"). `tone="ink"`, the
default, is the monochrome glyph the 2026-09-02 ruling left: it takes the
row's ink, and it is what a row uses when its glyph names no language or when
the surface wants no identity channel at all. `tone="kind"` inks the glyph in
its language's identity hue from the `--sem-color-mark-*` ramp, the pairings
people know from their editors:

| Hue | Kinds |
|---|---|
| `mark.blue` | `typescript` · `python` · `markdown` · `document` |
| `mark.yellow` | `javascript` · `json` · `lock` |
| `mark.cyan` | `react` · `go` |
| `mark.orange` | `html` · `rust` · `presentation` |
| `mark.red` | `yaml` · `java` · `pdf` |
| `mark.teal` | `shell` · `spreadsheet` — the ramp's nearest to a spreadsheet's usual green |
| `mark.violet` | `css` · `image` |
| *(row ink)* | `config` · `text` · `archive` · `generic` — they name no language |

A `*-test` kind takes its base language's hue: the notch says "test", the hue
still says which language.

**Both file surfaces wear `tone="kind"` (amended 2026-09-09).** The
2026-09-06 ruling let the hue on only where nothing else in the row was
coloured, which admitted the File Explorer and excluded the Git changes list.
The owner reversed the exclusion for the Commit window: a Git row carries the
kind hue on its glyph **and** the status tint on its name, because the hue
identifies and the tint grades. The glyph is the same blue on a modified,
added and deleted `.ts` row — it never moves with state — so the only thing
grading in the row is still the name.

The hue identifies and never grades: it is not a status ramp, and a `.ts` row
is not "more" than a `.md` row for being bluer. A row still spends at most two
colour channels, and the second one is the name's. `glyphs/file-
typescript.svg` and `glyphs/file-generic.svg` are the framework-neutral samples
of the tile and document idioms, in `currentColor`.

`FolderGlyph(open)` is the family's folder: the outlined folder in the same
16 px slot, so a folder row's name starts at the same x as a file row's. The
chevron beside it carries expanded state, so a tree may leave `open` off and
let the folder read the same either way. `glyphs/folder.svg`.

### Git views (16-grid — `panels/GitPanel.tsx`)

The Git panel's glyph-only view strip. Three of the five were redrawn on
2026-09-05 to shapes that name the view without a tooltip; the first set had
to be learned from the tooltip.

| View | Shape | Asset |
|---|---|---|
| Changes | A commit node on a line identifies changes | `glyphs/commit.svg` |
| Worktrees | A folder holding that node: a checkout in its own directory | `glyphs/worktree.svg` |
| Log | The history clock | `glyphs/history.svg` |
| Stashes | The drawer — the same one drawing the Stash *action* wears, extracted to `ui/GitActionGlyphs.tsx` so the view strip and the toolbar cannot drift | `glyphs/stash.svg` |
| Terminal | The prompt in a frame | — |

### Git and diff actions (16-grid — `ui/GitActionGlyphs.tsx`)

*What will this toolbar button do* on the Commit window and the diff window
(epic `git-commit-window`, 2026-09-09).
Action glyphs, not identity: they answer the sixth question, so they sit here
rather than in the Git-views strip above, and the two families share `stash`
because putting changes away is one concept whether it is a view or a verb.
16-grid, `currentColor`, `fill="none"`; frame 1.3, line work 1.4. Every one is
`aria-hidden` — the icon-only button that hosts it carries the `aria-label`.

| Export | Concept | Shape | Asset |
|---|---|---|---|
| `RollbackGlyph` | Discard a file's changes | The undo arrow: a hook doubling back on itself. **Not** `ResetIcon` — that is "restore a default", a 24-grid settings act, and this one throws work away | `glyphs/rollback.svg` |
| `MoveToChangelistGlyph` | Move files between changelists | Two opposed arrows, one over the other | `glyphs/move-to-changelist.svg` |
| `StashGlyph` | Stash uncommitted work | The drawer. One drawing, shared with the Stashes view above | `glyphs/stash.svg` |
| `GroupByGlyph` | Grouping options | The target: a ring crossed by four ticks | `glyphs/group-by.svg` |
| `ExpandAllGlyph` | Expand every group | Two chevrons apart | `glyphs/expand-all.svg` |
| `CollapseAllGlyph` | Collapse every group | The same two chevrons, together | `glyphs/collapse-all.svg` |
| `NextDifferenceGlyph` · `PreviousDifferenceGlyph` | Step to the next / previous hunk | An arrow travelling to a rule — the hunk boundary it lands on. ONE drawing, mirrored about y = 8 for the other direction, the way `ChevronDownIcon` is rotated rather than twinned; a bare chevron would say *disclosure*, which stepping is not. React applies the mirror as a transform; the folder ships both, because a framework-neutral asset a consumer has to transform is not a framework-neutral asset | `glyphs/next-difference.svg` · `glyphs/previous-difference.svg` |
| `ShowDiffGlyph` | Open this file's diff | Two opposed arrows about a centre line: one running right over it, one running left under it — two versions read against each other. **Not** `NextDifferenceGlyph`, which the diff window spends on *step to the next hunk*: one mark answering "open the comparison" in one window and "move within the comparison" in the other teaches that the mark means nothing in particular (added 2026-09-09, review of T5/T6) | `glyphs/show-diff.svg` |
| `SideBySideGlyph` | Diff layout: two panes | A frame split by one vertical line | `glyphs/side-by-side.svg` |
| `UnifiedGlyph` | Diff layout: one pane | The same frame, unsplit. The pair is a two-state toggle, and the presence or absence of the divider *is* the difference | `glyphs/unified.svg` |
| `GearGlyph` | Settings on a toolbar | A real toothed gear. `GeneralSettingsIcon` is sliders on the 24-grid rail and the `config` file kind is an identity mark, so neither serves an action toolbar | `glyphs/gear.svg` |
| `OpenInEditorGlyph` | Open the file in an editor | The pencil on the page: the one mark in this family that leaves the diff rather than rearranging it, so it is not another frame (added 2026-09-09 for the diff window's toolbar, T4) | `glyphs/open-in-editor.svg` |
| `WriteCommitMessageGlyph` | Compose the commit message | Three lines of a message with a crossed spark beside them: *text, composed for you*. A pencil would say a person types it, which is `OpenInEditorGlyph`'s job | `glyphs/write-commit-message.svg` |
| `NewChangelistGlyph` · `DeleteChangelistGlyph` | Make / remove a changelist | The bare plus and the bare minus at the family's weight. The changelist is already named by the menu row beside them, so the operator is the whole mark; `FolderPlusIcon` is a 24-grid folder and a changelist is not a folder (added 2026-09-09, T6) | `glyphs/new-changelist.svg` · `glyphs/delete-changelist.svg` |
| `EditChangelistGlyph` | Rename a changelist | The pencil WITHOUT the page. `OpenInEditorGlyph` is the pencil on a page and means "hand this file to an editor"; renaming a list touches no file, so it keeps the tool and drops the page | `glyphs/edit-changelist.svg` |
| `KebabGlyph` | More actions (the overflow trigger) | Three dots stacked, `r=1.15` at y 3.4 / 8 / 12.6. The one mark in this folder made of FILLS: a dot has no line work, and a stroked dot is a circle pretending to be a point. One drawing since 2026-09-09 — `OverflowMenu` drew it on a 14-grid and the Git group band hand-rolled a 16-grid copy | `glyphs/kebab.svg` |
| `CreatePatchGlyph` | Write the selection out as a patch | A page carrying a diff's two marks, one added line over one taken away: a patch is a file *of* a difference, so the glyph is both. Not `WriteCommitMessageGlyph`'s prose lines, and not another frame — every frame in this family is a layout | `glyphs/create-patch.svg` |

Reused, not redrawn, by the same two surfaces: `RefreshIcon` (re-read the
working tree), `FileTypeGlyph` `lock` (the padlock), `glyphs/commit.svg`,
`glyphs/worktree.svg`, `glyphs/history.svg` (the view strip), and
`ChevronDownIcon` rotated for disclosure.

### Utility marks (16-grid)

| Export | Meaning |
|---|---|
| `StarGlyph(filled, stroked)` | The one star path for starred/favorite — solid when earned, outlined for menu unstarred states. Caller owns size and ink |
| `RefreshIcon` | The canonical two-arrow refresh, shared by every panel that offers a manual re-read (Git status, Backlog scan) |
| `GitBranchGlyph` | The branch fork beside a branch name — sidebar rows, the git button, the run-on strip. `glyphs/git-branch.svg` |
| `PresetDialGlyph` · `LockGlyph` · `UnlockedGlyph` · `SparkGlyph` · `RuleShieldGlyph` | The access-level vocabulary (CLI default · Manual · Bypass · Auto) on the permission-preset menu rows and the composer's permission pill — one drawing per concept, shared by both hosts. A CLI's own mode listed beside its level's own takes a mark of its own so two rows never share one: `RuleShieldGlyph` for Don't ask (never asks, held to the allow rules) and the bare pencil (`EditChangelistGlyph`) for Accept edits. Inline in `AppIcons.tsx`; no standalone asset. |
| `RemoteMachineGlyph` | **The Beam** (redrawn 2026-10-04, owner ruling; it was a stack of two server units): a screen on its stand with two arcs of signal off its corner — a machine reached over the air. The one mark for "another machine" in general, where a surface does not say which: the paired-devices list, the "Other machines" group of the machine picker, the tailnet UI, a remote group header (remote-sessions-ux decision 7: one glyph, machine name beside it or in the tooltip). Also the Device identity family's fallback (above). A surface that names one machine wears that machine's own mark instead (Machine kinds). Stroke 1.4. `glyphs/remote-machine.svg` |
| `ScheduleGlyph` | A scheduled agent: a prompt that starts a new chat each time its schedule comes round. The plain clock face — hands at the hour, nothing else — on the New chat panel's Scheduled agent switch, its schedule row, the entry beside New chat, each scheduled agent's row in the sidebar's Scheduled section, and beside the title of every chat a scheduled run started, where it is named "Started by a schedule" (accessible name and tooltip) and says where the chat came from, never that it is working. **Not** `glyphs/history.svg`, whose clock carries a rewind arrow and means *the past* (the Git log); this one means *a time that is coming*. Stroke 1.4. `glyphs/schedule.svg` |
| `WslMachineGlyph` | A WSL distribution on this computer, which is a machine of its own ("WSL: Ubuntu"): a window with a title bar and a prompt, because the distribution is reached as a shell. The title bar (redrawn 2026-10-04) is what keeps it apart from the plain terminal's frame, `TerminalPromptGlyph`, which the composer's "Start as" choice draws beside it. It is also the `wsl` machine kind (Machine kinds, above). Stroke 1.4. `glyphs/wsl-machine.svg` |
| `OpenInWindowGlyph` | *In a window of its own*: a box with an arrow leaving it by the top-right corner. One drawing for every way a surface leaves for its own OS window — the Diff tab's "Open in separate window", the workspace pane's "Pop out pane" — and, in a pane tab's glyph slot, for a tab that is showing in a pop-out window right now: the mark the person clicked to send it there is the one that says where it went (the tab's accessible name says it in words). Extracted from the diff band in 2026-10, when the pane's pop-out reached for the same idea. Stroke 1.5. `glyphs/open-in-window.svg` |

### Code block actions (16-grid — `ui/CodeBlockGlyphs.tsx`)

The three header actions a code block has beside its copy glyph
([code-block](../code-block/component.md)). Stroke 1.4, `currentColor`, drawn
at `icon-xs` inside an `xs` icon button.

| Export | Asset | Drawing |
|---|---|---|
| `WrapLinesGlyph` | `glyphs/wrap-lines.svg` | A full line, a line that runs to the edge and turns back under itself with an arrowhead, and the short line it continues on. The turn is the meaning; without it the mark is a paragraph icon. A toggle, so it takes the pressed fill when on |
| `TerminalPromptGlyph` | `glyphs/terminal-prompt.svg` | A terminal frame with a `>` prompt and the cursor after it: "put this at a terminal's prompt". Deliberately not the play triangle — nothing runs until the person presses Enter, and a play mark would promise that it does. The same drawing as the terminal pane kind's private glyph (`workspace/pane/paneKinds.tsx`); see Known drift |
| `ViewSourceGlyph` | `glyphs/view-source.svg` | A pair of angle brackets: "the code behind this". On a block that draws its source (a diagram), it switches to the text the drawing was made from. A toggle, so it takes the pressed fill while the source shows |

### Tool step (16-grid — `ui/ToolKindGlyph.tsx`)

*What kind of step did the agent take* — the mark that leads each tool row in
a conversation's work log, and the summary row over a group of them. A column
of steps is read by shape before it is read by label ("read, read, ran,
edited"), so each kind gets one drawing and the label beside it never has to
start with the kind. 16-grid, stroke 1.4, `currentColor`, `fill="none"`,
decorative (`aria-hidden`; the row's label says what happened). The glyph
carries its kind as `data-tool-glyph`.

`ToolKindGlyph({ kind })` takes a `ConversationToolKind` and falls back to the
wrench for anything it does not know. The row owns the ink: the quietest text
ink at rest, the accent (pulsing) while the step runs, the error tone when it
failed — so the mark doubles as the step's status and the row needs no second
status mark.

| Kind | Drawing | Asset |
|---|---|---|
| `command` | A prompt caret and a cursor line | `glyphs/tool-command.svg` |
| `file_read` | A page with its corner folded and two lines of text | `glyphs/tool-read.svg` |
| `file_edit` | A pencil | `glyphs/tool-edit.svg` |
| `file_write` | The page again, wearing a plus: a file made rather than read | `glyphs/tool-write.svg` |
| `search` | A magnifier, drawn to this family's grid and weight; `glyphs/search.svg` stays the search field's 11-grid mark | `glyphs/tool-search.svg` |
| `list` | A folder | `glyphs/tool-list.svg` |
| `web` | A globe: rim, meridian, equator | `glyphs/tool-web.svg` |
| `mcp` | `McpGlyph`, the plug the capability inventory already wears for MCP — one concept, one drawing, so it has no second asset | — |
| `subagent` | A small robot head | `glyphs/tool-subagent.svg` |
| `todo` | A checklist: two ticks, two lines | `glyphs/tool-todo.svg` |
| `other` | A wrench | `glyphs/tool-other.svg` |

### Settings rail (24-grid, one per category)

`GeneralSettingsIcon` (sliders), `ProfileSettingsIcon` (person),
`AppearanceSettingsIcon` (half-filled disc), `ShortcutsSettingsIcon`
(keyboard), `AgentsSettingsIcon` (robot), `ProvidersSettingsIcon` (plug),
`GithubSettingsIcon` (branch),
`TrackersSettingsIcon` (tagged file), `KnowledgeGraphSettingsIcon` (node
triangle), `DesignSystemSettingsIcon` (disc, square and triangle),
`ModulesSettingsIcon` (2 × 2 grid), `MachinesSettingsIcon` (a screen with a
prompt; Windows only), `MobileSettingsIcon` (phone),
`RemoteSettingsIcon` (two linked machines).
All at `iconStroke` so the rail reads as one set.

### Conversation actions (16-grid — `ui/QuoteGlyph.tsx`)

What a person can do with a stretch of a conversation they have selected.
Stroke 1.4, `currentColor`, drawn at `icon-xs` beside the action's word in the
selection toolbar.

| Export | Asset | Drawing |
|---|---|---|
| `QuoteGlyph` | `glyphs/quote.svg` | Two opening quotation marks, each a small block with a tail that curls up and forward: "carry these words into what I write next". Deliberately not a speech bubble — a bubble reads as reply or comment, and pressing it sends nothing; the selection lands in the composer as a markdown blockquote for the person to write under |

## States

| State | Treatment |
|---|---|
| Rest | Inherits the surrounding ink — typically `--sem-color-text-muted` in a row or toolbar |
| Hover / active | The *owning control* shifts its ink and background; the glyph itself defines no hover |
| Live | `LifecycleGlyph` `in_progress` with `live` rotates (`.ds-glyph--spin`). The only animated glyph state, honoring `prefers-reduced-motion` |
| Disabled | Ink drops to `--sem-color-text-disabled` via the owning control |
| Meaning-bearing | `role="img"` + `aria-label` (see Accessibility) |
| Decorative | `aria-hidden="true"` |

## Usage

- **Pick the family by the question, then the glyph by the table.** Never
  answer a lifecycle question with a status mark *and* a glyph, or an identity
  question with an action icon.
- **Size from the ramp, nothing else.** Rails and toolbars at `sm`; chips and
  inline-with-meta at `xs`; button-paired and panel-header at `md`;
  empty states at `lg`. A 28 px icon button is not a size the system has
  (Known drift).
- **Reserve the slot.** A rail row's leading glyph slot is a fixed
  `--sem-icon-size-sm` box; a smaller glyph centers in it rather than
  narrowing it.
- **One meaning per shape.** The plus belongs to create; compose gets
  the pencil-in-square; a second surface wanting "add" reuses `PlusIcon`, it
  does not redraw it. Duplicating a path into a second file is how the
  title-bar chrome ended up with two divergent copies of the same four
  glyphs (Known drift).
- **Drawing a new glyph:** 24-grid, `iconStroke` 1.7, `currentColor`, one
  concept, `fill="none"` line work, legible at 16 px. Name it `<Concept>Icon`
  (24-grid) or `<Concept>Glyph` (16-grid); a framework-neutral copy
  contributed to `glyphs/` takes a kebab-case concept name per the naming
  grammar in `design-system.json`.
- **Rebuilding in a framework:** React consumers import from `AppIcons.tsx`
  and the `ui/` primitives — never paste paths inline. Framework-neutral
  consumers take the `glyphs/` assets. Both size via the ramp tokens and ink
  via `currentColor`.

## Accessibility

- **Decorative is the default.** A glyph whose meaning is carried by adjacent
  text is `aria-hidden="true"` — every core action, identity, and settings
  icon ships that way.
- **Meaning-bearing glyphs label themselves.** A labelled `LifecycleGlyph`,
  `StarGlyph` with `label`, and `PullRequestGlyph` with `label` carry
  `role="img"` + `aria-label` (and a `<title>` where hover should confirm). Omit the label only when the row's text
  already announces the state.
- **Icon-only buttons carry `aria-label`** on the button; the glyph inside
  stays hidden. Pair with a tooltip that says the consequence, not the name.
- **Shape first, color second.** Every status and lifecycle state is
  distinguishable in grayscale; ink only reinforces. Color is never the sole
  differentiator, with no exception. The one that used to stand here —
  merged-vs-unmerged on the branch fork, on the ruling that a distinct merge
  shape read as noise at 16 px — was retired on 2026-09-09: the Pull request
  family draws merged, open and closed as three different shapes at 16 px, so
  the ruling's premise is gone and nothing in the system needs colour to carry
  a state on its own.
- **Hit targets.** Nothing interactive below `--sem-size-hit-target-min`;
  the glyph pads out, it does not grow.

## Known drift

Shipped divergences from the conventions above, with their backlog homes.
Cite these rather than matching the code you happen to be nearest.

1. **Four icon-button sizes in the chrome strips** — 22 px
   (`WorkspaceIdentity` star toggle), 26 px (`SidebarChrome`
   `BRAND_ROW_BUTTON`), 28 px (`AppTitleBar` / `WorkspaceHeader`
   `STRIP_BUTTON` — off the 26/30/34 control ramp entirely, and with no
   radius or hover fill where SidebarChrome's 26 px button has both), and
   30 px (`AppMenuButton`). Canon is `--sem-size-control-xs` (26 px).
   Tracked as the icon-size conformance axis. *2026-09-02:* the
   kit's own off-ramp sites are resolved — `CursorErrorPopover`'s two 20 px
   reveal buttons are `IconButton` / `CloseIconButton`, and `MenuSwatchRow`'s
   20 px swatches pad out to the 24 px hit-target floor. **Resolved 2026-09-02**
   for the app chrome too: `STRIP_BUTTON` is deleted from `WorkspaceHeader` and
   `AppTitleBar`, and every strip, popover-trigger and row glyph button in the
   renderer is `IconButton` / `CloseIconButton` at `--sem-size-control-xs`
   (backlog `icon-buttons-off-the-control-ramp`); the conformance guard's
   `focus-ring-missing` rule keeps a bare button from returning.
2. **Per-door rail glyph sizes 16 / 13 / 12 px** — Automations leads
   rows with 16 px glyphs (titles at x = 42 px), Extensions
   with bare 13 px `icon-xs` glyphs and no fixed-width wrapper (39 px), the
   Design door with a 12 px chip (38 px) — so sibling doors' titles start at
   three different offsets in the same column. `AutomationTypeGlyph`
   compounds it: an 18 px `icon-md` SVG inside a 16 px box, overflowing by
   2 px. Canon: `sm` glyph in a reserved 16 px slot. Tracked in the glyph-slot ruling
   (door glyph normalization).
3. **Copy-pasted chrome SVGs.** The back / forward / search / panel-left
   paths are duplicated between `AppTitleBar.tsx` and `SidebarChrome.tsx`
   rather than shared, and the two copies get different hit areas and hover
   treatments (item 1). One export, two consumers, is the fix.
4. **Stroke drift at the edges.** The chrome strips draw bespoke 16-grid
   glyphs at 1.5 with a one-off 1.6 "+"; window controls sit at 1.2–1.4; a
   backlog toggle at 1.3 beside a skills glyph at 1.5. The 16-grid band is
   1.2–1.5, so most of these pass individually — the drift is per-surface
   inconsistency, resolved by consuming the shared exports (item 3).
5. **`RefreshIcon` is a 16-grid primitive named `Icon`** where the family
   convention is `Glyph`. Rename when it next moves.
6. **The `glyphs/` folder holds thirty-four assets** against a shipped vocabulary of
   roughly sixty. This entry closes the documentation gap; extracting
   framework-neutral SVGs for the core-action set into `glyphs/` (and
   registering them in `design-system.json`) remains open. *2026-09-05:* the
   Git view marks, the folder and two file-type samples joined the folder.
   *2026-09-09:* the seventeen Commit-window and diff-window action marks
   joined it (Git and diff actions, above), `previous-difference` among them
   as a shipped mirror rather than a transform the reader has to apply, and
   the three pull-request marks with them (Pull request, above).
7. **Two copies of the terminal-prompt drawing.** `TerminalPromptGlyph`
   (`ui/CodeBlockGlyphs.tsx`, stroke 1.4) and the terminal pane kind's private
   `TerminalGlyph` (`workspace/pane/paneKinds.tsx`, stroke 1.5) are the same
   frame, `>` and cursor. The pane kind should import the kit's export and
   drop its own copy.
