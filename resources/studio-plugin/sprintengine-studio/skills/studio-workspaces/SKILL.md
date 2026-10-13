---
name: studio-workspaces
description: Read and drive SprintEngine Studio's workspaces, agents, terminals, git checkouts and the editor and the workspace browser pane through the workspace_*, agent_*, terminal_*, editor_* and browser_* tools. Use when asked what workspaces or agents exist, to open a workspace or launch an agent, to start or list the agent terminals on this machine or read a terminal's output (a dev server's errors, a test run's failures), to inspect a workspace's branches and worktrees, to show the person specific files, lines or your diff in their editor, to drive or screenshot the in-app browser, or to check the mobile companion snapshot or tailnet pairing.
---

# Workspaces and terminals

Everything here reads or writes the running app's own state through its main
process, so it works with no window open: a workspace created this way is
immediately addressable, and a terminal created this way appears as a painted
pane when a window opens later.

**Start with `workspace_list`.** Almost every other tool on this surface takes a
`workspaceId`, and this is where ids come from. It lists the workspaces visible
to the user, with window assignment and agent ids. Workspaces that survived a
restart are listed like any other — main owns the registry, so their name,
folder, mode and agents are real whether or not a window is open.

`workspace_status` with `{workspaceId}` reads one workspace including its agents
and their terminal liveness. `agent_status` with `{workspaceId, agentId}` reads
one agent's launch state plus its terminal session liveness — the two halves are
separate, and an agent recorded as launched whose session is gone is a real and
reportable state.

## Creating and opening

`workspace_create` takes `name`, `folderPath` and `templateId`, all optional,
and creates the workspace in the running app. `workspace_checkout` with
`{workspaceId}` reads the git side: whether the folder is a repository, the
branch it is on, the trunk, every local branch, and the worktrees the repository
holds. Read it before launching an agent on a worktree, because
`agent_launch`'s `worktree.baseRef` has to name a branch that exists.

## Launching agents and terminals

`agent_launch` with `{workspaceId}` adds a fully configured agent and starts its
CLI through the same renderer flow the UI uses. It can select the model,
permission preset and connector, and can isolate the agent in a git
worktree. Success is confirmed by the agent's terminal session registering with
the main process — a call that returns success has a live session behind it.

`terminal_create` starts an AGENT terminal on this machine and returns its
session id and agent id — it launches a CLI under a permission preset through
the same path `agent_launch` uses, without the connector and worktree options,
and `terminal_list`'s `kind` filter counts it as `agent`, not as a plain shell.
There is no tool here that opens a bare shell. Name the workspace by
`workspaceId` or by `workspaceName`. The CLI and the permission preset default
to this machine's own launch settings unless you name them: the preset chosen
for that CLI, else `auto`, exactly as the app's launcher would. Name `bypass`
(every prompt skipped), `manual` (every edit and command asks) or `none` (no
permission flag, so the CLI's own configuration decides) when the person asks
for it; `auto` is the CLI's own auto mode where it has one (Claude Code's and
Grok's classifier, Codex's and Cursor's auto-review), else edits go through and
commands ask. A terminal agent takes only the presets its CLI has a setting
for, which `cli_runtime_list` names, each with the name the CLI gives its mode
(`permissionModes`): when the person asks for "Accept edits" or "YOLO", pass
the preset that list puts it at. The answer reports the preset the launch
resolved. Follow the agent with `agent_status` or `terminal_list`.

`terminal_list` lists open sessions — session id, agent name, CLI, working
directory, workspace, whether the process is live or the session is paused, and
the agent phase when the CLI reports one. It reads the terminal runtime and
never writes.

`terminal_read` with `{sessionId}` reads what a terminal printed — a dev
server's error, a watcher's rebuild, a test run's failure — as plain text with
the escapes stripped: the newest 200 lines by default (`lines`, at most 2000),
with `truncated: true` when older output was left out. Every answer carries a
`cursor`; pass it back as `since` and the next read returns only what the
terminal printed after it, so follow a running server by polling with the last
cursor rather than reading its whole log each time. A paused or exited session
still reads the output it left, and `state` (`running`, `paused`, `exited`,
`failed`) and `exitCode` say how it ended. A full-screen program such as an
agent CLI reads as the stream that drew it, so for an agent's progress prefer
`agent_status`. It reads only sessions `terminal_list` lists and never types
into the terminal.

These terminal tools and the launch tools above are served to agents on this
machine only, never to a paired machine over the tailnet — a paired device
starts chat agents instead.

Read `cli_runtime_list` before naming any `cli` or `cliModel`. Only rows with
`agentSelectable: true` can be launched as agents.

## The browser pane

`browser_open` with a `url` puts a page in the workspace's browser pane;
`browser_navigate`, `browser_press`, `browser_scroll`, `browser_resize` and
`browser_set_appearance` move it. `browser_status` says what is loaded.

**Take a `browser_snapshot` after every navigation or change.** It renders the
page as an outline of roles and names with `[ref=eN]` handles, which are what
`browser_click`, `browser_hover` and `browser_type` address. It is cheaper and
far more precise than a screenshot, and it is read-only. Reach for
`browser_screenshot` when a human needs to see the pixels, not when you need to
find an element.

`browser_console` and `browser_network` read what the page logged and requested;
`browser_actions` reports what has been driven. `browser_evaluate` runs an
expression in the page — use it when the DOM holds an answer the snapshot does
not, not as a substitute for clicking.

A page that opens an alert, a confirm, a prompt or a leave-page confirmation is
held until the dialog is answered, and every other browser tool on that tab
answers `dialog_open` with its text. Answer it with `browser_dialog`: `accept`
(with `text` for a prompt) or `dismiss`.

## Showing files and diffs

When you want the person to look at specific code, open it for them instead of
pasting paths into your reply. `editor_open` takes up to eight `files`, each a
`path` (absolute, or relative to your working directory) with an optional
1-based `range` (`startLine`, `endLine`); the editor scrolls there and briefly
highlights the lines. Pick the few files that matter — three out of forty — rather than everything you touched.

`editor_open_diff` opens the diff viewer on your own changes: by default only
the files in your changelist, `only: "all"` for every change in your checkout.
`changes` picks the view (`uncommitted`, `staged`, `unstaged`, `branch`, or
`commit` with `commit`), `paths` narrows it to named files with a "Show all"
way back, and `focus` lands on one file at a `range`.

Neither ever takes the keyboard or raises a window. Read the answer:

- `shown: "foreground"` — it is in front of them.
- `shown: "background"` — they were typing, so it opened behind their tab;
  tell them it is there.
- `shown: "not_visible"` — no window shows this workspace. It opens when they
  switch to it. Say so in your reply and **do not retry**: retrying cannot
  make them look.

Each file comes back `opened`, `awaiting_owner` or `refused` with a `reason`.
A file outside the workspace, your worktree and the files you wrote is
`awaiting_owner`: the person is asked whether to open it. Credential stores
(`~/.ssh`, `~/.aws` and the like) are always refused. A patch you wrote to
`/tmp` for them to copy opens directly, because you wrote it.

`editor_state` says whether a window shows the workspace, which file is
active with its visible lines and selection, and how many reveals are still
waiting for them. Check it before talking about what they can see — not in a
loop.

## The mobile companion and the tailnet

The phone companion pairs with and talks to this desktop only over the tailnet;
there is no hosted relay. These two tools are its whole connection.

`workspace_snapshot` is the companion document: backlog and the dev servers
published on the tailnet as one versioned read, in path-token form
— `ws_` tokens round-trip and local paths never leave the desktop. Pass
`knownSnapshotVersion` from your previous read to get an `{unchanged: true}`
marker instead of the whole document when nothing moved; a polling loop that
ignores this is re-sending the same document every time.

`workspace_mobile_command` dispatches one mobile-control command envelope from a
paired device. The device identity comes from the transport, never from the
arguments — do not try to name a device in the payload.

The `tailnet_*` tools are served **only over the local socket** and are
unreachable from a remote client, by design. `tailnet_status` and
`tailnet_list_peers` read; `tailnet_set_enabled`, `tailnet_revoke_device`,
`tailnet_approve_pair_request` and `tailnet_deny_pair_request` change pairing
state. `tailnet_offer_pairing` returns the pairing code and the
`sprintengine-tailnet://` URL **once** — neither is re-readable afterwards, and
`tailnet_status` never returns them — so deliver them to the person who asked in
the same reply or they are lost. A lost code is recovered by offering again,
which replaces the outstanding offer rather than needing a cancel first; that
also invalidates one a person may be part-way through redeeming, so say that you
are replacing it. The code does not survive an app restart.

## Reaching this surface without the app running

These tools live in the running app. The stdio bridge finds it through a
discovery file in the app's user-data directory
(`sprintengine-studio-mcp-info.json`), which the app writes at start and removes
on quit. If a call fails because the app is not running, that is the honest
answer: say so rather than retrying. A "stale discovery file" message means the
app crashed and must be restarted before this surface exists again.
