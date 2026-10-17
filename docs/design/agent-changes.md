# What an agent changed — per-agent change records for every agent, and the pull request marks

Status: proposed, 2026-10-03. The decisions in section 3 are locked (owner,
2026-10-03). The pull request marks in section 7 are built, on
`fix/pull-request-marks`, moved to the server on `build/server-pull-requests`,
and owned by the conversation that opened them since 2026-10-04; nothing else
here is. Only P0 (section 8) may be
built before phase 6 of `docs/design/studio-server.md` (the Studio server out
of process) lands; everything after it is built on the server. When code and
this file disagree, fix one of them in the same change.

File references are `path:line` on `origin/main` unless a branch is named.
Phase 6 references are on `build/phase-6-server-process`, where that phase is
built behind its flag.

## 1. What is being built

One answer to "what did this agent change?", for every agent Studio runs —
terminal agents and chat agents, on every runtime — as the raw files and line
ranges that agent wrote, kept apart from what any other agent or the person
wrote in the same folder.

Today Studio has that answer for terminal agents only, as the Git panel's
per-agent changelists. Chat agents have a folder snapshot instead, which counts
everyone's work as theirs. The sidebar and the title bar count a third thing,
the checkout's git diff. This design makes the per-agent record the one source
every surface reads, extends it to chats, takes it off its dependency on git,
and places it in the Studio server, where chats run.

### Owner rulings this design is built on

Rulings (a) to (d) were given on 2026-10-02 and 2026-10-03.

| Ruling                         | Text                                                                                                                                                                                                                                  |
| ------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| (a) Raw files and lines        | The person sees exactly what each agent changed, as files and lines, not a summary.                                                                                                                                                   |
| (b) One branch, one folder     | Many agents may work on one branch in one folder, and each agent's work stays its own. Worktrees are optional: "people don't always want worktrees".                                                                                  |
| (c) No git required            | "People don't always use git; if you can see raw files edited by an agent, that is powerful." The record works in a folder that is not a repository.                                                                                  |
| (d) Change sets over snapshots | Per-agent change sets are preferred to a per-turn folder snapshot model, because a snapshot of the folder cannot tell two agents on one branch apart.                                                                                 |
| (e) Chat pull requests         | "Any agent who's gonna do some work should result in a pull request… we need to intercept that call on the conversational chat agent" (owner, 2026-10-02). Built: section 7.                                                          |
| (f) Server owns chats          | The Studio server owns conversations, providers, checkpoints and git for chat; clients render; terminals stay in the shell in v1; the full git panel comes later (`docs/design/studio-server.md`, rulings a and c, owner 2026-10-01). |

## 2. Where things stand

### 2.1 Terminal agents: the per-agent changelists

A terminal agent's edits travel from the agent CLI's hooks to the Git panel's
list named after that agent:

| Step | Where                                                                    | What it does                                                                                                                                                                                                                                                            |
| ---- | ------------------------------------------------------------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1    | `resources/hooks/sprintengine-agent-state.mjs:726` (`deriveFileChanges`) | The hook reporter turns one tool call into the files it changed, with minimal changed regions in git's hunk convention. The table keys on the CLI's event spelling and tool name.                                                                                       |
| 2    | `src/main/terminal-runtime.ts:2335`                                      | Each frame's `fileChange` goes to the session ledger and to `onAgentFileEdit`.                                                                                                                                                                                          |
| 3    | `src/main/app-services.ts:763`                                           | Hands it to the editor's written-files list and to the changelist feed.                                                                                                                                                                                                 |
| 4    | `src/main/agent-changelist-feed.ts:57`, `:164`                           | Keys the edit by the session's observed checkout (`gitRoot`, the worktree, not the primary repository), drops paths outside it, and coalesces a burst for 250 ms.                                                                                                       |
| 5    | `src/main/git-changelists.ts:254` (`recordAgentEdits`)                   | The store: `<userData>/git-changelists/<basename>-<hash>.json`, one file per repository, pruned against `git status` on every read (`:15`).                                                                                                                             |
| 6    | `src/shared/git/changelists.ts:637` (`recordEdit`)                       | The model: a list owns a file outright, or owns spans of new-side lines in a file another list owns. Each edit (`Edit`, `:87`: `oldStart`, `oldLines`, `newStart`, `newLines`) moves every span through its coordinate change, then claims its lines: last writer wins. |

How step 1 reads each CLI. The reporter reads what the tool call actually did,
not what the agent asked for:

| Runtime                          | Reader                                                                                                                                                     | Precision                                                                                                                                |
| -------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------- |
| Claude Code Edit/MultiEdit/Write | `deriveFileChange` (`:235`) over the result's `structuredPatch`, walked by `deriveEdits` (`:112`)                                                          | Exact. Each hunk is walked into its minimal `-`/`+` runs, so context lines are never claimed.                                            |
| Codex `apply_patch`              | `deriveCodexFileChanges` (`:501`) over the V4A patch                                                                                                       | Exact. The patch is read only when the result says it applied; one patch can change several files.                                       |
| Cursor, Kimi, Grok edits         | `deriveOldNewFileChange` (`:632`): `locateEdit` (`:367`) finds each old/new pair in the file as it is after the edit, `sequenceEdits` (`:394`) orders them | Exact when every pair is found. If any pair cannot be placed, the whole call falls back to a file-level claim rather than a partial one. |
| Kimi, Grok whole-file writes     | `deriveWriteFileChange` (`:655`)                                                                                                                           | The file only, with its line count as additions. Without the old content, any range would be a guess.                                    |
| Claude Code file watcher         | `WATCHED_FILE_EVENT` (`:691`, `FileChanged`)                                                                                                               | A touch: path only, no lines, no counts. The only signal for an edit made through Bash, a formatter or a code generator.                 |

There is a second, separate store for the same edits: the per-session ledger
`recordSessionFileChange` (`src/main/terminal-session.ts:845`) sums additions
and deletions per file on the live terminal session. It feeds the hover peek's
file list (`src/renderer/src/components/workspace/ConversationPeekCard.tsx:361`).
So paths and line ownership live in one store (git-keyed, no counts), and counts
live in another (in memory, per terminal session).

### 2.2 Chat agents feed none of it

Only `terminal-runtime.ts` calls `onAgentFileEdit`, and nothing else calls
`recordAgentEdits`. A chat agent has no changelist, no ledger and no peek file
list. Each chat provider already receives what the reporter would need:

- **Claude** (`src/main/providers/claude-agent-provider.ts`). The SDK's user
  message carries `tool_use_result`, the same object the CLI writes to its
  transcript as `toolUseResult`. On a real transcript, an Edit's result has
  `filePath`, `oldString`, `newString`, `originalFile`, `structuredPatch`,
  `userModified` and `replaceAll`, and each `structuredPatch` entry has
  `oldStart`, `oldLines`, `newStart`, `newLines` and `lines`. The provider reads
  only the exit code from it (`commandOutcome(message.tool_use_result, …)`,
  `:2164`). The SDK `hooks` option is already used for `PreToolUse` (`:801`).
  SDK 0.3.283 declares a `FileChanged` hook event
  (`node_modules/@anthropic-ai/claude-agent-sdk/sdk.d.ts:777`, listed in
  `HOOK_EVENTS` at `:956`). Whether it fires through an SDK callback hook the
  way it does for a CLI hook is **not verified**.
- **Codex** (`src/main/providers/codex-items.ts:29`). A `fileChange` item
  carries a `diff` text per file and a move's destination (`move_path`).
- **ACP agents** (`src/main/providers/acp-conversation-provider.ts:672`). Tool
  updates carry `diff` content entries with `path`, `oldText` and `newText`.
  When the agent writes through the client's own `writeTextFile` callback
  (`:837`), Studio performs the write itself and holds both sides.

The `+N −N` chips on a chat's timeline steps come from
`computeEditDiffCounts` (`claude-agent-provider.ts:2524`, called at `:2137`):
Claude only, read from the tool input, and a Write counts every line as
added. They are a preview, not a record. The timeline's edit previews
(`src/shared/conversation/editHunks.ts:56`, `deriveEditHunks`) are also built
from the tool input.

### 2.3 The end-of-turn card is a folder snapshot

The "N files changed" card (`src/renderer/src/components/panels/agentChat/changedFilesCard.tsx:450`,
mounted at `timelineRows.tsx:439`) is a diff between two snapshots of the whole
folder. Before the turn's first tool that is not read-only,
`captureBeforeTool` (`src/main/conversation-runtime.ts:3156`) takes the `pre`
snapshot. At turn end the runtime takes the `post` snapshot (`:2018`). Each
snapshot is `git add -A -- .` into a throwaway index
(`src/main/conversation-checkpoints.ts:371`), committed under
`refs/sprintengine/checkpoints/` (`:19`). The card shows
`git diff --no-renames` between them (`:421`).

Two consequences. In a shared folder, every edit made during the turn by
another agent, or by the person, is counted on this agent's card. And it only
works in a git repository. The same snapshots are what Revert restores, and
that use is sound.

### 2.4 The sidebar and title-bar numbers

The sidebar row's `+N −M` and the title bar's branch chip count **files**, not
lines (`changedFileMarks`, `src/renderer/src/components/workspace/terminalLines.ts:132`;
`WorkspaceIdentity.tsx`, `gitCountBadge`). They are read from git: on a feature branch,
`merge-base(HEAD, trunk)` to the working tree (`src/main/git-branch-span.ts:11`),
and on the trunk only what is uncommitted. They include everyone's changes. A
chat row shows no numbers at all (`WorkspaceSidebar.tsx:3701`).

Pressing an agent line's numbers opens that agent's changelist
(`WorkspaceSidebar.tsx:3710`), so the person clicks the checkout's count and
lands on one agent's list. The comment there ("An agent line's ±count is that
agent's own work") and the line's spoken label ("Open this agent's diff",
`sidebar/TerminalLineView.tsx:198`) describe a number the line does not draw.

### 2.5 The server split

Phase 6 runs the Studio server out of process behind
`SPRINTENGINE_SERVER_MODE` and an Advanced toggle. In process stays the default
(`src/shared/server-mode.ts:12`, `DEFAULT_SERVER_MODE = 'in-process'`). Its
decision D7 (`docs/design/studio-server/phase-6-server-process.md:252`, and the
ownership table in section 5, `:334`) leaves git changelists and pull requests
with the shell (Electron main) until phase 10. Chats live in the server.

Out of process, the shell's view of the core answers `conversations.onEvent`
with a no-op (`src/main/server-supervisor/remote-core.ts:131`). Anything in the
shell that listens to the conversation stream hears nothing. The server reaches
the shell through `ShellBridge` (`src/server/shell-bridge/shell-bridge.ts:35`):
a few requests (cipher, terminal launch, reveal, integrations gate) and two
one-way events, `shell.notify` and `shell.analytics` (`:63`).

## 3. Decisions

Each is locked (owner, 2026-10-03).

**D1. The per-agent change record is the source of truth for "what this agent
changed".** It covers terminal and chat agents on every runtime. The folder
snapshot, the git diff and the tool inputs are not. A snapshot answers "what
changed in this folder", which is a different question as soon as two writers
share it. A git diff answers it for a branch, not an agent. A tool input is what
the agent asked for, which a failed or partly applied call does not match. Only
a record kept per agent, from what each call did, answers the question asked.

**D2. The record is derived from tool results.** Exact hunks where the runtime
reports them: Claude's `structuredPatch`, Codex's per-file diffs, ACP's `diff`
entries. Cursor, Kimi and Grok old/new strings are placed in the file as it is
after the edit. An edit the agent made through a shell (Bash, a formatter, code
generation) is a file-level touch where a watcher reports it, and is never
guessed from the command line. A touch is a smaller lie than a wrong line range.
A call that failed records nothing.

**D3. Attribution is per agent, line-level, last writer wins.** This is the
existing changelist model (`recordEdit`). Many agents on one branch in one
folder each see only their own lines, and when two agents alternate inside one
function, each line belongs to whoever wrote it last. Worktrees remain
available and remain optional. Nothing in this design requires one.

**D4. Git-free first.** The record (paths, line ranges and counts per agent)
stands on its own and works in a folder that is not a git repository. Paths are
relative to the folder root, which is the git root when there is one. The Git
panel's changelists become a git view over the record, and that view keeps
pruning against `git status` as it does today. Checkpoints and Revert stay
git-only: restoring a folder needs a snapshot, and that is the one job the
snapshot does well.

**D5. One derivation, shared.** The reporter's derivation gets a TypeScript
twin in `src/shared/` that every chat provider uses. The reporter cannot import
it: it is copied into the app-owned launch home and run by the agent CLI as a
standalone script (`src/main/agent-integration-home.ts:266`). So the two are
held together by a parity test over shared fixtures, which runs the real
reporter on each fixture and the twin on the same input and requires identical
output.

**D6. Surfaces read the record.**

- The end-of-turn card shows this agent's changes this turn. In a git folder,
  its line counts may come from the snapshot diff restricted to the agent's
  paths. Other changes in the folder during the turn appear on a separate,
  uncounted line: "2 other files changed in this folder during this turn".
- A chat's sidebar row gets its numbers, and the hover peek gets its file list,
  from the same record as a terminal agent's.
- The sidebar and title-bar wording says what it counts. A number that is the
  checkout's says so, and pressing an agent's number opens a view of the same
  thing the number counted.

**D7. The record lives with the conversations, in the Studio server.** Three
reasons. Chats run there out of process. A future web client needs it. And a
git-free record cannot hang off the shell's Git panel. Nothing in this design
is built until phase 6 lands. Then it is built server-side, and the shell's Git
panel and changelists read it over the control channel. Alternatively, phase 10
moves changelists to the server; that is the point to reconcile with the owner
of phases 6 and 10. The exception is D5's derivation module, which is pure, has
no process dependency, and may be built at any time.

**D8. Pull request marks follow D7.** The pull request record is a server
domain in both modes (owner rulings 2026-10-03). Since the owner ruling of
2026-10-04 a conversation owns the pull requests its agent opened, read in the
server from the same tool calls this record's sources carry, by one reader
(`docs/design/studio-server.md`, section 6.8).

## 4. The record

A sketch of the shape. The final types are settled in P1.

```ts
// One file per folder root, in the server's data directory.
type AgentChangeRecord = {
  root: string // absolute folder root; the git root when there is one
  agents: Record<string, AgentChanges> // keyed by agent id
}

type AgentChanges = {
  name: string // the name the Git panel's list carries today
  kind: 'terminal' | 'chat'
  workspaceId?: string
  conversationId?: string
  exited?: boolean
  files: Record<string, AgentFileChanges> // root-relative posix path
}

type AgentFileChanges = {
  additions: number // summed over the agent's calls
  deletions: number
  spans: OwnedSpan[] // new-side lines this agent owns now (src/shared/git/changelists.ts)
  touched?: true // a file-level claim with no line information
  turns?: Record<number, { additions: number; deletions: number }> // chats: per turn
  lastEditedAt: number
}
```

It merges the two stores of section 2.1. The span bookkeeping is
`recordEdit`'s, unchanged: every agent's spans in one root live in one place,
so one agent's edit can move and cut another's. The counts are the session
ledger's, made per agent instead of per terminal and kept on disk.

What the record does not claim:

- The person's own edits are in no agent's record.
- An edit made through a shell where no watcher reports it is invisible. Two
  agents' shell edits are never told apart by guessing.
- A subagent's edits ride its parent's record, as they ride the parent's hook
  frames today (`agent-changelist-feed.ts:21`).

## 5. Where each runtime's edits come from

All of them go through the D5 twin, so a terminal agent and a chat agent on the
same CLI produce the same entries for the same call.

| Agent                    | Source                                                                                               | Reader in the twin                                    |
| ------------------------ | ---------------------------------------------------------------------------------------------------- | ----------------------------------------------------- |
| Terminal, every CLI      | The reporter's frames, as today                                                                      | The reporter itself; the twin only in tests           |
| Chat, Claude             | `tool_use_result` on the SDK user message, beside `commandOutcome` (`claude-agent-provider.ts:2164`) | The `structuredPatch` reader                          |
| Chat, Claude shell edits | An SDK `FileChanged` hook, if it fires (section 2.2)                                                 | The touch reader                                      |
| Chat, Codex              | `fileChange` items (`codex-items.ts:29`)                                                             | A per-file diff reader; a move is a delete and an add |
| Chat, ACP agents         | `diff` content (`acp-conversation-provider.ts:672`); the client's own writes (`:837`)                | Full-file pairs diffed; snippets placed like Cursor's |

The twin takes a `readFile` function for the readers that place an edit in the
file as it is afterwards, so it stays free of `fs` and runs anywhere.

## 6. Surfaces

| Surface                    | Today                                              | After this design                                                                                                |
| -------------------------- | -------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------- |
| Git panel, per-agent lists | Terminal agents, from `git-changelists/`           | Every agent, as a git view over the record, pruned against `git status`                                          |
| End-of-turn card           | Folder snapshot diff, everyone's edits             | This agent's files this turn, plus one uncounted line for other changes in the folder                            |
| Turn card counts           | Snapshot diff                                      | In git: the snapshot diff restricted to the agent's paths (net). Without git: the record's summed counts (gross) |
| Chat sidebar row           | No numbers                                         | The chat's own numbers from the record                                                                           |
| Terminal agent line        | The checkout's file counts; opens the agent's list | The agent's own numbers from the record; opens its list                                                          |
| Title-bar branch chip      | The checkout's branch span, in files               | Unchanged, and worded as the checkout's                                                                          |
| Hover peek file list       | Terminal session ledger                            | The record, for chats and terminals                                                                              |
| Timeline step chips        | Tool input, Claude only                            | May read the twin once results flow; a preview either way                                                        |
| Revert                     | Snapshot restore, git only                         | Unchanged                                                                                                        |

"Other files changed in this folder during this turn" is the snapshot diff's
paths minus this agent's, in a git folder. Without git it can only name other
agents' recorded edits in the turn's window; the person's own edits are not
visible there, and the line says nothing rather than undercount.

## 7. Pull request marks (built)

Built on `fix/pull-request-marks`. Recorded here as decisions already taken,
because D8 changes where part of this lives.

- **One mark per chat, on that chat's own row.** Green while open, violet once
  merged. A pull request closed without merging is not drawn on the row; the
  peek menu still lists it.
- **A project's open count appears once.** It is on the tree's folder header
  only, and no longer on every row's project line in the flat list, where each
  chat wore it and read as having an open pull request of its own.
- **A conversation owns the pull requests its agent opened** (owner ruling
  2026-10-04, replacing the branch lookups of 2026-10-03, which made a chat
  in a checkout on someone else's branch wear that branch's pull requests).
  Opened means a create command or tool whose output named the pull request,
  read by one reader for chats and terminals alike
  (`src/shared/git/pull-request-opened.ts`), or the agent's own
  `pull_request.link` call to the gateway. This is the identity side this
  record's pipeline already has: the conversation stream's tool calls per
  workspace and agent for chats, and the hook reporter's PostToolUse frames,
  forwarded by the shell, for terminals. The reporter forwards the call and
  decides nothing, so it cannot disagree with the reader. State is read from
  GitHub by URL; a pull request on another forge is shown as opened. The
  record is the server's (`src/server/pull-requests/`, design
  `studio-server.md` section 6.8).
- **Freshness.** The watch holds at two minutes instead of climbing to 32
  (`src/main/github/pull-request-watch-poller.ts:49`). A window focus re-reads
  every stale open pull request on the record. Stored records load at start.
- **Restart.** The record is one file, `pull-requests/opened.json`. The
  per-repository files the branch lookups wrote are read once: what a capture
  filed under a conversation stays, what a lookup found goes.

Follow-ups:

1. **Server mode records nothing for chats.** Done: the record and its lookups
   run in the server in both modes.
2. **A pull request opened another way is not attributed** unless the agent
   links it (`pull_request.link`): `tea`, Forgejo's CLI, `az repos pr
   create`, `curl` or `gh api`, or by hand. That is the rule, not a gap: a
   pull request nobody's agent opened belongs to no conversation.
3. **A row with a live terminal shows only that terminal's pull requests,** not
   the ones the rest of the conversation's agents worked on. Unchanged.
4. **Open, not decided:** settle a chat automatically when its pull request
   merges, behind a setting (section 9).

## 8. Phased plan

**P0 — The shared derivation and its parity test (any time).**
A pure module in `src/shared/` with the reporter's readers (structuredPatch
walk, V4A, old/new placement with `sequenceEdits`, whole-file write, touch) plus
the chat-only shapes (Codex `fileChange`, ACP `diff`). Fixtures are JSON files
of tool payloads with the expected file changes. The parity test spawns the
real reporter on each fixture, as `src/main/agent-state-service.test.ts:366`
already does, and compares its frames to the twin's output. Done when every
runtime row in section 2.1 and section 5 has a fixture, both sides agree, and
nothing in the app calls the twin yet.

**P1 — The record in the server; chat providers feed it (after phase 6).**
The store and the span model in the server's data directory, keyed by folder
root. Claude, Codex and ACP providers feed it through the twin. Events for
subscribers. Verify the SDK `FileChanged` hook and use it if it fires. Done
when two chats in one non-git folder each see only their own lines, the same
holds in a git folder, and both pass with the server in process and out of
process (a seam test in each mode).

**P2 — The shell forwards terminal edits; the Git panel reads the record.**
The shell keeps the agent-state socket (terminals are the shell's in v1) and
forwards each `fileChange` to the server's record. In process this is a direct
call; out of process it is a shell-only method on the control channel. The Git
panel's per-agent lists become a view over the record, and existing
`git-changelists/` files are read once into it. Done when there is one store,
the Git panel lists chat agents beside terminal agents, and the person's own
lists (made and renamed in the panel) survive the migration. Reconcile with
phase 10 before starting.

**P3 — The surfaces.**
The end-of-turn card, the chat row's numbers, the peek file list and the
wording of section 6. Fix the stale comment and spoken label of section 2.4.
Done when an agent's card in a shared folder lists only its own files with the
other-changes line beneath, and every number in the sidebar opens a view of
what it counted.

**P4 — Pull requests in server mode.** Built (owner rulings 2026-10-03,
2026-10-04): the record is a server domain, a conversation owns the pull
requests its agent opened (a captured create call, or the gateway's
`pull_request.link`), and every client reads `pullRequests.*`.

## 9. Open questions

1. **Settle on merge.** Should a chat settle automatically when its pull request
   merges, behind a setting? Off or on by default?
2. **Where terminal agents' records live.** Terminals are the shell's in v1.
   Proposed: the shell forwards terminal edits into the same server record
   (P2), so there is one record and one model. The alternative, two records
   merged on read, keeps two writers of span ownership for one folder, which
   last-writer-wins cannot survive.
3. **Retention and size.** How long a settled or exited agent's record is kept,
   and a cap per root. In git, pruning against status bounds it. Without git,
   nothing does except the agent's own lifetime.
4. **Renames and deletes.** Codex reports moves; Claude's tools do not delete;
   the watcher reports `unlink`. Is a rename a delete and an add (as the
   snapshot diff's `--no-renames` already treats it) or one entry with two
   paths?
5. **A file two agents edited.** The card shows this agent's lines in it. Does
   it also say that another agent edited the same file in the turn, and if so,
   on the file's row or on the other-changes line?
6. **Net or gross counts.** Without git the record sums each call (an added
   line removed later reads +1 −1). Is that acceptable on the card, or should a
   git-free folder keep the before content of each touched file to show net
   counts?
7. **The row's unit.** The sidebar draws files today. When a chat row reads
   from the record, does it stay in files or move to lines?

## 10. Not this design

- **The silent test harness.** About 86 test files use a local `run()` helper
  that never asserts its failure count, so a failing case can pass the suite.
  That is a separate fix.
- Checkpoints and Revert, which stay as they are (D4).
- Pooled worktrees (`docs/design/worktree-pool.md`, parked).
- The full Git panel and file explorer over the protocol (phase 10 of
  `docs/design/studio-server.md`).
