# Backlog item schema (v2)

A backlog item is a markdown file filed under the epic it belongs to —
`backlog/<epic-slug>/<item>.md` — or `backlog/unfiled/` when it has no epic. Its
lightweight, human-editable fields live in the file's **frontmatter** and are the
source of truth there. Anyone — a human, Git, or an agent — creates an item by
writing the file; existing items are preferably mutated through the validated
`backlog.update` tool, which stamps precise timestamps.

Durable app-written facts live in that same frontmatter: the star (`starred`,
`highlight`) and the links an item declares (`pr`). What is left is
volatile — resolved link status, the agent terminal holding an item — and lives
in `backlog/cache/links.json` in the project's store in the person's home
(`~/.sprintengine/workspaces/<project>/`), outside the project, re-derivable,
and merged over the file at scan time. It replaced the tracked `items.json`, which held both halves and rewrote
itself on every resolve tick.

The app reads the frontmatter, the `# Title`, and mockup links in the body;
everything else below the title is for whoever works the item. Both backlog
skills teach one shape for it — statements under fixed uppercase keys (`GOAL:`,
`STATE:`, `SPEC:`, `ACCEPT:`, `LOG:` and the rest), written for an agent rather
than as prose — in their "Item body" section. Nothing parses those keys, so an
item written as paragraphs stays valid.

This split follows Google Cloud's **Open Knowledge Format (OKF) v0.1**: `backlog/`
is a bundle of markdown concept files, each with one required `type` field;
producer-defined fields are allowed, and unknown types and fields are tolerated
and preserved rather than dropped.

## Frontmatter

Frontmatter is a single block of **flat scalar** `key: value` lines — no nested
YAML, no YAML library, no schema validator. The one writer is
`serializeBacklogFrontmatterFields` in `src/shared/backlog/frontmatter.ts`; it
preserves the document body byte-for-byte and preserves unknown keys and their
order. The matching reader is `parseBacklogFrontmatter` in the same module, which
the renderer read model (`src/renderer/src/utils/backlog.ts`) delegates to so
there is exactly one parser.

```yaml
---
id: 240              # stable workspace-global integer; allocated once, never changes
type: feature        # epic | feature | bug | mockup | spike   (epic = container)
status: ready        # idea | ready | in_progress | needs_input | completed | archived
difficulty: m        # xs | s | m | l | xl   (effort to build)
criticality: high    # low | normal | high | critical   (impact if missing)
risk: normal         # low | normal | high   (likelihood it breaks; not effort)
epic: auth-revamp    # optional; slug of the epic this item belongs to
dependsOn: a-item, b-item   # optional; comma-separated slugs of prerequisite items
mockups: backlog/mockups/2026-07-06-x.html   # optional; comma-separated project-relative mockup paths
updated: 2026-06-26T10:00:00.000Z   # precise UTC instant; drives the "recently updated" sort
---
```

### Fields

- **id**: a stable, workspace-global sequential integer that is the item's
  durable identity. Allocated once (scan-max + 1) and **never changed** — not
  across re-type, rename, or re-triage — so anything keyed on it (a commit
  message, an external dashboard) stays valid. The human-facing identifier shown
  in the panel is `<KEY>-<id>` (e.g. `MC-240`), where `KEY` is the per-workspace
  display key; the type is conveyed by a glyph, never encoded in the id (the
  Jira/Linear convention). New files — whether authored by a human, an agent, or
  Git — simply omit `id:`; the scan-time `ensureBacklogItemIds` pass allocates
  and writes the number inside the per-project serialized mutation lane. Writers
  never allocate or edit ids; the app-assigned display id is resolved afterwards
  through `backlog.list` or the panel. The pure helpers live in
  `src/shared/backlog/item-id.ts`.
- **type** (required by OKF): one of `epic`, `feature`, `bug`, `mockup`, `spike`.
  `epic` marks a grouping container (see below). Unknown values are tolerated on
  read and left untouched.
- **status**: lifecycle state. Files under `backlog/archived/` are always treated
  as `archived` regardless of the field.
- **difficulty**: t-shirt effort estimate. Normally set by whoever plans the
  work rather than by whoever captured it.
- **criticality**: product impact. Follows user/product intent.
- **risk**: likelihood the change breaks something — a separate axis from
  `difficulty`. Combined with `difficulty` it derives a row color at render time
  (`deriveRiskColor` / `resolveBacklogRowColor`); nothing is persisted.
  Precedence is three deep: a hand-set `highlight` wins, then the epic's own
  identity colour, then risk heat. The risk tier resolves with `litFill: false`,
  and `backlogRowPaintClass` paints a background only for a lit fill, so the
  derived risk colour currently tints no row.
- **epic**: optional up-pointing slug naming the epic this item belongs to. The
  slug is the epic file's name stem (see below).
- **dependsOn**: optional prerequisite list — a single **flat comma-separated
  scalar** (the frontmatter has no array support), e.g. `dependsOn: a-item, b-item`.
  Each entry is an item **slug = the prerequisite file's name stem** (the same
  identifier `epic:` uses). Read trims, dedupes, and drops the item's own slug, so
  an item can never depend on itself. Like `epic`, dependencies are **stored up,
  derived down**: only the dependent stores the edge; the reverse "blocks" edges
  and the derived signals below are recomputed on every scan and never persisted
  to the cache.
  - **Derived blocked** (effective readiness): a stored `status: ready` with ≥1
    unresolved prerequisite (target not completed/archived, or a dangling slug)
    **presents as Blocked instead of Ready** everywhere — the readiness claim is
    falsified until the prerequisites resolve. `blocked` is never a frontmatter
    status; the file keeps `ready` and the presentation flips back on its own
    when the last prerequisite completes. The status and best sorts demote
    blocked items below actionable work.
  - **Derived waiting**: any other active item (`idea`, `in_progress`,
    `needs_input`) with an unresolved prerequisite keeps its status and gains a
    softer "Waiting" badge — those states make no can-start-now claim.
  - **Epic rollup** (granular, one blocked child never freezes the container):
    an epic surfaces `N blocked` of its remaining (non-terminal) children beside
    its progress meter, and reads Blocked itself only when **every** remaining
    child is blocked (or its own `dependsOn` is unresolved while `ready`).
- **mockups**: optional attached-mockup list — a single **flat comma-separated
  scalar** of **project-relative, comma-free paths** (the CSV contract forbids an
  embedded comma), e.g.
  `mockups: backlog/mockups/2026-07-06-x.html, backlog/mockups/2026-07-06-y.html`.
  The canonical home is `backlog/mockups/`;
  `backlogMockupResolutionCandidates` probes the ref as written first, then the
  same ref under `backlog/`, so either root resolves. Each attachment shows in the item detail pane's
  **Mockups** section as a live scripts-off preview, openable rendered in the
  panel and removable there (UI-editable via `window.api.updateBacklogMockups`,
  which validates paths and preserves every other frontmatter key). Body-prose
  mockup links (`Mockup: [x](../mockups/x.html)`) light up the same section
  read-only without being written here. Absolute paths and `..` escapes are
  rejected on write.
- **updated**: the full ISO-8601 UTC instant of the latest real content or
  frontmatter mutation, including hours, minutes, and seconds (the canonical
  writer emits milliseconds). App/API writers own this field and stamp it
  automatically. Agents should use `backlog.update` when the studio's
  automation MCP is available and must not supply the timestamp. Direct-file
  writers (including agent-authored new files) omit the field or delete the
  stale line instead of estimating one; `YYYY-MM-DD` is not a precise timestamp.
  Legacy date-only values remain readable but the renderer falls back to the
  file mtime rather than pretending UTC midnight is exact.

### App-written durable fields

These three are frontmatter the app writes and reads back; agents should leave
them to the app rather than hand-authoring them.

- **starred** / **highlight** (`HIGHLIGHT_FIELDS`): the star and its colour, one
  of the 7 highlight colours. Read by `backlogHighlightFromFrontmatter`, with
  the object store as the un-migrated fallback.
- **pr**: the pull requests opened for it, as `<url>` for the item's own project
  and `<repoId>=<url>` for a sibling one.

`pr` is declared in `durable-links.ts` and is the only durable link field left.
A `sprints:` line written by an older build is not read, and — like every other
unrecognised key — is preserved untouched rather than stripped. The resolved
*status* of a link is volatile and is never written here.

### Other read fields

- An `.html` / `.htm` file with no `type:` reads as `type: mockup`: the
  format is what makes it a mockup, not a field.
- A `status: needs_structure` written by an older build is read as `idea`.
- `type: roadmap` is tolerated and carried as `rawType`; the main listing tags
  it `isRoadmap` and keeps it out of backlog lists. Any other unrecognised
  `type` is likewise preserved on `rawType` rather than dropped.

Set an axis only when the current context supports a grounded estimate; leave it
unset rather than guessing. Omitting a field is a calm neutral state, not a
defect — a rough capture can stay untyped and unestimated until someone
planning the work sizes and prioritizes it.

### Backward compatibility

- A single nested `backlog:` section (e.g. `backlog:` then indented `size:`,
  `priority:`) is still read for legacy files, and the aliases `size` →
  `difficulty`, `priority` → `criticality`, and `itemType`/`backlog_type` →
  `type` are honored. New files should use the flat top-level keys above.
- The reader tolerates not-yet-migrated files and sidecar records indefinitely
  (lazy migration): unknown keys are preserved on write, never dropped.
- Star/highlight is a frontmatter fact first: `backlogHighlightFromFrontmatter`
  reads `starred` / `highlight` (`HIGHLIGHT_FIELDS`) and the object store is
  only the fallback for a file that has not been migrated.

## Display identifiers

The human-facing id is `<KEY>-<id>` — `MC-240` — composed at render time from the
frontmatter `id` integer and a per-workspace **display key**. The key lives in a
small committed config file `backlog/config.json` in that same app-owned
directory (`{ "schemaVersion": 1, "key": "MC" }`), so the id reads identically
on every machine; when absent it is derived from the workspace folder name and
persisted. Changing the key only changes the displayed prefix — the stored `id`
integer is the identity and never moves, so a key rename never rewrites item
files.

Allocation is **max + 1** over committed frontmatter: no counter file or remote
daemon. All main-owned id writers (the scan-time backfill, mobile intake, and
the renderer create flow) share a per-project FIFO mutation lane, so concurrent
allocation cannot mint the same id or lose a sidecar registration. The scan pass
assigns ids to files lacking one oldest-first and stays idempotent once every
item has one. Two independent Git branches can still mint the same number because
no local singleton can coordinate separate repositories; that is **detected and
surfaced** by the panel, never silently rewritten. An explicit `backlog.repair`
operation may reallocate one side only after proving the duplicate still exists.
Imported issues (future importers) keep their provider key verbatim and display
that instead; the display formatter already accepts an external override.

## Epics (grouping)

An **epic** is itself a concept file at `backlog/epics/<slug>.md` with
`type: epic`. Its `<slug>` is the filename stem (e.g. `backlog/epics/auth-revamp.md`
→ slug `auth-revamp`); its title is the first `# Heading`. Optional epic fields:

```yaml
---
type: epic
status: ready              # optional
color: blue                # optional; one of the 7 highlight colors — the epic's identity colour
order: 1                   # optional; sort order among epic groups
dependenciesPlanned: true  # optional; the ordering pass over the children is finished
---
```

- **dependenciesPlanned** (epics only): the author declaring the ordering pass
  over this epic's children **finished** — their `dependsOn` edges are authored,
  and **no edges at all counts**: it means deliberately parallel. It exists to
  disambiguate the two meanings of "no `dependsOn` edges":

  | State | Meaning | What a consumer of the epic should do |
  | --- | --- | --- |
  | mark set, children carry edges | ordered | honour the edges as the work order |
  | mark set, no edges | deliberately parallel | take every child as ready at once |
  | mark absent | ordering never finished | plan the order before working it |

  Absent means false, and only the literal `true` sets it. It is an **assertion
  of intent, not a computed property**: nothing derives or unsets it, so editing
  an epic's membership is the author's cue to re-check it. Nothing polices how it
  got set — a hand edit, a planning agent finishing its pass, or `backlog.update`
  with `{ dependenciesPlanned: true }` are the same assertion. Nothing in the app
  blocks on it: it is a signal to whoever picks the epic up, never a gate, and an
  unset mark means "check the order first", not "you may not start".

Grouping is **derived down, stored up**. The only stored relationship is each
child's `epic:` field. An epic's children are the live query
`items.filter(i => i.epic === slug)`, regenerated on every scan — never persisted,
so it cannot desync. Changing an epic's slug orphans its children until they are
repointed; a child whose `epic:` slug has no matching epic file renders under an
"Unknown epic" group and is never dropped.
