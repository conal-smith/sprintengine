# Conversations

Chat agents run through the conversation runtime; terminal agents keep their
existing PTY workflow. The launcher lists these surfaces separately. A provider
only exposes the controls it actually supports: models, reasoning effort, image
input, skills, plans, questions, interruption, and permission presets.

## Local workflow

Start a chat in a workspace, choose an installed provider and model, and send a
prompt. Tool activity stays in the transcript with expandable input/output and
file links. Older turns page in as needed; search can open a historical turn.
Selecting a skill attaches it to the chat, while file mentions attach to one
send. Claude chats load attached skills natively. Codex, Cursor, Grok and
OpenCode chats are told to run the skill by name, the way each CLI's own picker
would (`$name` for Codex, `/name` for Cursor and Grok, its skill tool by name
for OpenCode), once, on the turn it is attached; the skill is copied into the
folder that CLI reads first if it is not there. A provider with no CLI behind
it, and Kimi Code, whose skill folders Studio does not install into, is sent the
SKILL.md as instructions. The composer's Skills & MCPs
picker also lists the MCP servers the chat's CLI is configured with, with the
connection each last reported. A file dropped, picked or pasted from the computer into a chat that runs
on it is a card: the send carries it beside the words (`files` on the send and
on its `user_message`), the agent is told where it is, and the bubble draws the
card from that list, never from the text. Failed sends keep the draft. Pending approvals and questions appear above
the composer, with a counter and keyboard navigation when several are waiting.

Remembered tool permissions are scoped to the conversation or workspace.
Requests that cannot be represented safely as a rule offer only a one-time
decision. Deny-by-default requests focus Deny. Workspace rules can be reviewed
and revoked. Remote clients cannot choose a permanent rule.

### Permission modes

Each agent's permission menu lists its CLI's own modes under the CLI's own names
(owner request 2026-10-01): Claude Code's Manual, Accept edits, Auto, Don't ask
and Bypass permissions; Codex's Read only, Default, Auto-review and YOLO;
Cursor's Default, Auto-review and Run Everything; Grok's Default, Accept edits,
Auto, Don't ask and Always approve; OpenCode's Ask, Allow edits and
Auto-approve. Only modes the CLI really has are listed, from its plugin manifest
(`permissionPresets`, where each mode carries its label, a one-line summary and
a tooltip). A **No flag** row (Cursor calls it Default, OpenCode Your rules)
passes no permission setting at all.

Under the names, every mode sits at one of four levels, and the app reasons
only in levels: the launch cap on agents an agent starts, the stricter and
looser notices, what the app answers without a card, and what a caller that
names a level gets (an MCP tool, an automation, a paired machine, a third-party
manifest). A level a caller names runs the CLI's own mode for it.

| Level                                    | What it means                                                                                                                                                                                                                                                                                                                                                                                                                                |
| ---------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Auto**                                 | The default. The CLI's own auto mode where it has one: a classifier (Claude Code, Grok) or a reviewer (Codex, Cursor) runs what it judges safe. Elsewhere it reads and edits files inside the workspace without asking, and asks before commands, web access and anything outside it. In a chat it also calls MCP tools unasked, bar the gateway tools that start another agent or workspace. Accept edits and Codex's Default sit here too. |
| **Manual**                               | Asks before every action that changes something or reaches out: each edit, command, web request and MCP tool. Reading, searching and listing inside the workspace do not ask, since a card for every file read would stop a chat from getting anywhere. Don't ask sits here: it never asks, and refuses what the person's own rules do not allow.                                                                                            |
| **Bypass permissions** (Codex: **YOLO**) | Never asks: the CLI's own skip-every-prompt setting.                                                                                                                                                                                                                                                                                                                                                                                         |
| **No flag**                              | Passes no permission setting at all, so the CLI runs on its own configured default. That can mean asking, or not.                                                                                                                                                                                                                                                                                                                            |

Auto is what an agent starts on when nobody chose (owner request 2026-10-01;
Bypass before then): it neither asks about everything nor skips every check. A
CLI with no auto mode (Kimi Code, whose only flag runs it fully autonomous)
passes no flag instead, never something looser. Only a choice nobody made
moves: a person who chose Bypass, for one CLI or for all of them, keeps it, and
so does every agent record, scheduled agent and automation that names one.

A choice is stored as its level and, for a mode that is not the level's own
(Accept edits, Don't ask, Codex's Default), the CLI's id for it beside it: per
CLI in the launch settings, and on the agent record. A peer or a window that
knows only levels reads the level and runs its own mode, so nothing written
before keeps meaning anything else. A chat runs a CLI's other modes where its
runtime maps them (Claude Code's and Grok's Accept edits and Don't ask, Codex's
Default); a chat on a paired machine is told levels, so its menu lists each
level's own mode.

Plan mode is a separate toggle, not a mode. Questions and plans are answers, not
permissions, so every mode shows them; so does a request the runtime marks as
needing a person (a safety check it will not let a stray keystroke pass, or the
person's own "always ask" rule).

The mode is chosen in the launcher and changed at any time from the chat box's
permission chip, mid-reply included. A permission card offers, beside Allow
once and Deny, to allow and switch to the CLI's Auto and Bypass modes, under
their names (**Allow and switch to Auto-review**, **Allow and switch to YOLO**
for Codex), whichever would ask less than the chat does now: the request is
allowed once, and then the chat moves to that mode. The mode is stored on the
chat's agent record, so a resumed chat starts on it.

A mode is applied twice. Each runtime is told it in its own words when its
child starts, and again when it changes where the runtime takes that mid-session
(below). And the app answers what the mode covers: a request that still reaches
the app is allowed without a card when the chat's mode allows it (the transcript
says "Auto-approved: Auto mode"), and switching mode answers the requests
already waiting that the new mode covers. Nothing is ever denied that way, and a
request the person has already answered is never answered again or relabelled.
A stricter mode chosen mid-reply cannot hold back what the runtime does without
asking before it takes the change; its notice says the new permissions apply
from the next message.

A chat is never left unstarted because of its mode. When a runtime will not
start under the mode it was given (a flag its installed CLI no longer takes, or
a mode it refuses, such as Cursor's Manual), it is started again with no
permission setting. That covers the session's start, and a turn that fails
before it has done anything, which is where a runtime that spawns its child per
message (Claude Code) or takes its policy per turn (Codex) shows the failure.
The failed attempt is dropped, the chip reads No flag, and a warning over the
chat box names the mode that failed and the runtime's error. The agent record
keeps the person's choice, so the next start tries it again. A runtime that
fails with no flag as well keeps its mode and reports its first failure.

Every surface that starts an agent takes all four modes (owner ruling
2026-09-27, extended 2026-09-30): the launcher, a launch on a paired machine,
the MCP tools (`agent.launch`, `backlog.work`, `schedule.create`,
`conversation.create`), and scheduled agents themselves. A
launch that names no mode resolves the way the launcher does: the mode chosen
for that CLI on the machine that runs it, else Auto. The launcher names its
mode when it starts an agent on a paired machine, so the agent there runs on
the choice the launcher showed. A terminal agent takes only the levels its CLI's
manifest names a setting for (`cli.runtime.list` says which, and names each
mode); the launcher lists only those, and a launch that asks for another is
refused.

Completed turns may expose changed files and a checkpoint diff. Reverting asks
for confirmation and refuses when the working tree no longer matches the
checkpoint's expected content. Checkpoints preserve the real Git index and do
not include submodules.

### Fork from here

Hovering one of your messages or a finished reply offers **Fork from here**. It
opens a new chat in the tab right after this one, named after it with
"(fork)", holding the conversation up to that point; the two then carry on
separately. Forked at a reply, the new chat holds that reply's turn. Forked at
one of your messages, it holds everything before it, and the message waits in
its composer to be changed or sent as it is. The fork runs on the same CLI,
model, effort, permission mode, skills and folder as the chat it came from,
and connector servers a running chat was started with ride along while the app
stays open. The chat forked from is not changed.

Both chats work in the same files, and nothing is restored: a fork made after
the agent changed files sees them changed. The forked turns' changed-files
cards and Revert stay with the original chat, whose checkpoints they are.

The fork is offered while the chat is idle, on this machine (a paired
machine's chat is not forked from here), wherever the runtime can be forked:

| Runtime                           | How the fork continues                                                                                                                                                                      |
| --------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Claude Code                       | Its first message branches Claude's own session at the point (`resumeSessionAt` with `forkSession`). A point Claude recorded nothing at (a reply a queued message joined) cannot be forked. |
| Codex                             | Its first message branches the thread through the turn forked at (`thread/fork` with `lastTurnId`).                                                                                         |
| Cursor, Grok, Kimi Code, OpenCode | At the newest reply, an agent that offers `session/fork` branches its running session; anywhere else, a new session whose first message carries the conversation so far as text.            |
| API-key (OpenAI-compatible)       | The conversation is replayed from the copy each turn, as for any chat on it.                                                                                                                |

Codex falls back to the conversation as text too, for a chat from before turns
recorded their Codex turn, and when it cannot branch the thread at that turn
(the thread or the turn is gone). A fork that carries the conversation as text
owes it until a message has actually reached the agent: a first send that
failed before it did (signed out, a CLI that would not start) leaves it owed
to the next message, across a restart too. An ACP chat that is itself still
owed its conversation is never branched natively; its fork is seeded as well.
A second fork of a chat is numbered: "Atlas (fork 2)". A fork
keeps its point across a restart until its first message is sent. Until then a
Claude or Codex fork has no CLI session of its own, so Continue in terminal
waits for that first message.

### Side question

**Side question**, in the composer's "+" or on ⌘⇧B (Ctrl+Shift+B), opens a
drawer to ask something about the chat without adding it to the chat. Typing
`/btw` and a question in the composer asks it the same way. The agent answers
from the conversation so far, in one reply and with no tools, so it can change
nothing. The question and the answer stay out of the transcript, the chat's
history, the sidebar and the phone. A turn the chat is running goes on
undisturbed, and so does its queue. Follow-ups in the same drawer see the side
questions before them. Closing the drawer lets the whole aside go, and calls
off a question still being answered. **Continue in a new chat** forks the chat
at its newest reply, as Fork from here does, with the last question waiting in
the fork's composer. It is offered once no turn runs.

It is Claude Code's own `/btw`, asked over the SDK (`askSideQuestion`), and is
offered for Claude chats on this machine, a WSL server's or an SSH machine's.
A Claude Code that has no side questions says so in the drawer. Its cost joins
the session's running total, so the chat's next turn reports it; Claude Code
writes no request for it to its session log. Codex, the ACP runtimes and a
paired machine's chat do not offer it, and there `/btw` goes to the CLI as
before.

## Installed CLI providers

Claude and Codex use their native headless interfaces. ACP providers share an
adapter and declare profile-specific capabilities. The user's installed CLI
and native credentials remain authoritative; Studio does not bundle these ACP
executables or copy credentials to a remote client.

Each mode reaches each chat runtime its own way. No flag sends none of these.

| Runtime     | Bypass                                    | Auto                                                                                                                     | Manual                                                              | Mid-conversation change                                                                                            |
| ----------- | ----------------------------------------- | ------------------------------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------ |
| Claude Code | SDK `bypassPermissions`                   | SDK `auto` (its classifier)                                                                                              | SDK `default`, plus a hook that sends every non-read tool to a card | Live over the SDK's `setPermissionMode`, mid-reply included; No flag respawns the child (resumed) at the next turn |
| Codex       | `approvalPolicy: never`, full access      | `on-request` in the `workspaceWrite` sandbox, no network, reviewed by its auto-review (`approvalsReviewer: auto_review`) | `untrusted` in a read-only sandbox                                  | Rides the next `turn/start`; No flag restarts the app-server before the next turn                                  |
| Cursor      | `--force`                                 | `--auto-review` (its classifier)                                                                                         | Not offered: Cursor edits files without asking                      | Launch flag: the child is replaced at the end of the running turn                                                  |
| Grok        | `--always-approve`                        | `--permission-mode auto` (its classifier)                                                                                | `--permission-mode default`                                         | Launch flag, as Cursor; its own `/always-approve` and `/auto` commands are refused under a stricter mode           |
| OpenCode    | `OPENCODE_PERMISSION` allowing everything | A rule set asking for everything but reads, listings and edits                                                           | The same rule set asking for edits too                              | Launch environment, as Cursor                                                                                      |
| Kimi Code   | Its `auto` session mode (Never Ask)       | Its `yolo` session mode (Ask When Needed: dangerous commands, sensitive files and the git directory still ask)           | Not offered: Kimi Code edits files in a git project without asking  | Its ACP session mode, set before every turn and live mid-reply; no new process                                     |

A CLI's other modes reach a chat the same ways: Claude Code's Accept edits and
Don't ask as SDK `acceptEdits` and `dontAsk` (Don't ask adds no card of its
own), Grok's as `--permission-mode acceptEdits` and `dontAsk`, and Codex's
Default as `on-request` in the `workspaceWrite` sandbox with the person, not the
reviewer, answering what leaves it.

`kimi acp` takes no permission flag, so a Kimi Code chat is told its level as
one of Kimi's own ACP session modes. Read off Kimi Code 0.42.0's permission
policies, its `yolo` is the Ask When Needed of `kimi --yolo` and its `auto` the
Never Ask of `kimi --auto`, the other way round from the descriptions its ACP
server gives them. Its menu lists the modes its terminal manifest names (Auto,
which is Never Ask, at Bypass, and No flag); Auto runs `yolo` for a caller that
names it. Kimi asks its own questions as permission requests, one option per
answer; the chat shows them as questions, answered from the list or skipped.

Claude's Auto is its own classifier mode, `auto`, as Grok's is, Cursor's its
auto-review and Codex's its auto-review (owner ruling 2026-10-01): someone who
picks Auto expects the CLI's own auto mode. The classifier runs what it judges
safe and turns the rest back to the agent rather than asking. Where an account
or model is not offered it, Claude Code starts in its asking mode; in a chat the requests Auto covers
are still answered without a card. Claude Code pointed at another model endpoint
(Kimi, Z.ai) keeps `acceptEdits` for Auto, since the classifier is not offered
there.

A Codex terminal agent is told the same modes on its command line: Bypass as
`--dangerously-bypass-approvals-and-sandbox`, Auto as `--approve-for-me` (the
workspace sandbox with its auto-review), and Manual as `--ask-for-approval
on-request --sandbox read-only`, where every write and every request for the
network has to ask to leave the sandbox. Codex's command line no longer takes
`untrusted`, which its app-server still does.

Chats on an API-key provider run no tools and have no permission control. Do
not interpret a hidden approval control as a promise that a provider will ask
for permission.

A Claude chat loads only the person's user settings, never the project's, so
the app's MCP gateway is handed to each Claude chat directly rather than read
from the workspace's `.mcp.json`. A scheduled agent's run that carries MCP
servers starts its chat with them the same way: Claude through
the SDK's `mcpServers`, Codex as `mcp_servers` config overrides for that chat's
app-server, and ACP agents through `session/new` (HTTP and SSE servers only
where the agent's handshake says it takes them). A provider that cannot take
the server fails the run and says so, rather than running without it.

ACP filesystem callbacks are confined, verified existing-file operations.
Creating a new file through those callbacks is refused on platforms without
anchored directory operations; provider-owned native edits are a separate CLI
capability. Post-open filesystem checks are defense in depth, not a kernel
sandbox against a malicious process repeatedly replacing directory ancestors.

### Chats on a WSL machine

On Windows, every chat runtime runs on a WSL machine as well as on This PC
(owner ruling 2026-10-01): Claude Code, Codex, Cursor, Grok, Kimi Code and OpenCode alike.
A chat in a workspace on a WSL machine runs each CLI from that distribution,
with the command set for it there (or the one its PATH finds), the way a
terminal agent there does (`conversationCliRuntimesForHost`).

Every runtime starts its child the same way (`cli-host-child.ts`): one
`wsl.exe -d <distro>` whose stdio is the CLI's, running the person's login
shell so the CLI sees their PATH, login and configuration under the Linux home.
Nothing of the Windows environment goes in except what the runtime names: the
chat's identity variables, the SDK's own marks for Claude, and the variables an
ACP preset is told through (OpenCode's rule set). Codex additionally has the
OpenAI API variables removed from the login environment, so a key the profile
exports cannot take the chat off the person's Codex login.

Paths cross the boundary in both directions:

- **Out.** The workspace folder is sent as Linux names it (`/home/dev/repo`,
  `/mnt/c/Users/dev/repo`): Codex's `thread/start` and `skills/list`, ACP's
  `session/new` and `session/load`. A stdio MCP server's `C:\…` and
  `\\wsl.localhost\…` paths become the distribution's.
- **Back.** An ACP agent's file reads and writes, and a picture Codex saved, are
  opened through the workspace as Windows names it. Approval checks respell the
  agent's Linux paths against the workspace root
  (`ConversationRuntime.approvalCheckInput`), so Auto and "always allow" place
  files in the workspace for every runtime.

Claude Code's `/` menu is not yet listed for a folder before a chat on a WSL
machine has started; a running chat lists it.

## Remote connection over the tailnet

Another machine follows and drives a conversation over Tailscale, and only over
Tailscale: there is no hosted relay in the path, for transcripts, commands,
images or phase changes. The phone companion and another Studio desktop use the
same socket and the same frames; nothing in the wire is specific to a phone.

### Trust boundaries

- **Network.** The gateway listens only on this machine's tailnet address
  (loopback in tests). Tailscale authenticates the peer machine; the gateway
  records the peer node it resolved, but does not treat it as authorization.
- **Device.** Authorization is the paired device's bearer token and its scopes.
  A WebSocket is opened with a short-lived single-use ticket, never the token in
  a URL. Browser-originated requests are refused.
- **Scopes.** `conversation:read` lists, follows and pages conversations and
  fetches tool details and diffs. `conversation:operate` sends, stops, answers
  approvals and questions, attaches images, changes the permission preset and
  switches the model, and implies read. New pairings grant both by default; the pairing surfaces
  list them as their own rows. There is no terminal scope: terminals do not
  cross the tailnet (see "Terminals stay on the machine" below).
  Grants are read live: narrowing a device in Settings refuses its next
  command, removing read closes its socket (4403), and revoking it closes every
  stream it holds (4401).
- **What a remote command can do.** A device with `conversation:operate` drives
  a chat exactly as the host can, preset included: it can send to a chat in
  Bypass, and switch a chat between any of the modes the host runs (all four on
  a host that advertises `conversation-permission-modes`, Bypass and No flag on
  one that does not, which is never sent Manual or Auto). A conversation a
  remote send resumes starts under the preset it was left on. The one thing a
  remote command cannot choose is a permanent approval rule, which outlives the
  conversation; that is refused before the runtime sees it.
- **Starting a chat.** The same grant starts one: `conversation.create` adds a
  chat agent to one of this machine's workspaces, starts its session on the
  named CLI (the launcher's model and preset, else this machine's choice for
  that CLI), and sends the prompt as its first message. It answers once the
  session is up, with the workspace and agent ids a remote pane follows the
  chat by. Like every remote command it is audited.
- **A new chat as New chat here starts one.** A desktop that advertises
  `new-chat-worktree` takes `worktree: true` beside `newChat: true` and starts
  the chat in a worktree of its own, cut exactly as New chat here cuts one with
  Worktree on: from the worktree pool where this process keeps one, on the
  project's default branch, as `<prefix>/chat-<id>` (the branch prefix from
  Settings ▸ Worktrees, `agent` unless changed) under the project's worktree
  container, and filed under the project it was cut from, so the chat lists here
  as if it had been started here. A project that is not a git repository, or a
  folder on an SSH machine, is refused with `worktree_unavailable` rather than
  started in the checkout. A desktop that advertises `new-chat-effort` takes an
  `effort`, one of the CLI's `reasoningLevels`, refused as `unsupported_effort`
  otherwise. It is kept on the chat's agent record as New chat here keeps its
  effort pick, and every turn, from this machine's chat view or a paired
  device, runs at it where the chat's provider runs that level: Claude Code's
  chat runs all five of its levels and Codex's runs low to xhigh, so Codex's
  `max` and `ultra` run at its default. A CLI that declares no levels (Cursor,
  OpenCode, Grok, Kimi Code) ignores it. A desktop that advertises `cli-runtime-catalog`
  answers each CLI on `cli.runtime.list` with a `catalog`: whether it can run as
  a chat (`conversational`), its provider line (`providerLabel`, naming the CLI
  a hosted runtime rides), and `models`, the rows this machine's model picker
  offers — the CLI's reported list (its manifest seed until it has reported),
  then the ids added in Settings — each with the `family` row it renders under,
  its window (`contextLabel`, `1M` or `Standard`), whether it is the id the row
  selects (`familyDefault`), and `isNew` where the picker shows New. The model
  favourites are this machine's window's own and do not travel.
- **Answering a plan.** A desktop that advertises `conversation-plans` takes
  `resolvePlan` (`approve` or `reject`) for a plan the agent proposed, and
  refuses it for a request that is not a plan, before the provider sees it.
  A plan answered as a `resolveApproval` (`once` carries it out, `deny` sends
  the agent back to planning), as every client did before, is still taken.
- **A CLI's own modes.** A desktop that advertises
  `conversation-cli-permission-modes` lists the CLI's own mode a chat runs at
  its preset (Claude Code's Accept edits) and the modes its provider runs, and
  takes a `permissionMode` beside the preset on `setPermissionPreset`. A
  resume keeps the mode the chat was left on. A desktop without it drops the
  member and runs the preset's own mode, never a looser one.
- **Switching a chat's model.** A desktop that advertises the
  `conversation-models` capability (owner ruling 2026-09-27) lists each chat's
  CLI and the models this machine's own picker offers for it — the CLI's
  reported catalog (its manifest seed until it has reported) and the ids added
  in Settings — and takes a `setModel` command naming one of them, or the CLI's
  own default. The switch stays within the chat's CLI: an id outside the
  catalog is refused with `unsupported_model` before the runtime sees it, and
  a provider that binds a session to its model refuses it as well. The switch
  runs through the same runtime path as a switch made here, a chat with no live
  session is resumed to take it, and a switch made while a turn is running is
  accepted with a notice that the new model applies from the next turn. This
  machine's own chat view follows a switch made from a paired device.
- **Audit.** Every remote command — refused ones included — is written to the
  gateway audit with the device, the conversation, the command kind, the command
  id and the outcome. Message text and answers are never written there.
- **What leaves the machine.** Frames carry transcripts, tool output previews,
  tool details and diffs, with secret-looking keys redacted. Paths in the
  followed conversation's workspace are sent workspace-relative; other paths in
  the home directory start `[home]`.
- **Images.** Uploads are staged in a private temporary directory, never in the
  workspace, and referenced by an opaque id bound to the device and session.
  At most 16 images of 5 MB each per turn, as JPEG, PNG, GIF or WebP, on a live
  image-capable session. An accepted send removes its staged files; unused ones
  expire after an hour.
- **Pictures sized for the model.** A desktop that advertises
  `conversation-image-downscale` shrinks each uploaded picture on receipt by
  the rules its own composer uses (`src/shared/conversation-attachments.ts`):
  to a 1568px long edge, kept a JPEG if it was one and a PNG otherwise, a JPEG
  only when the PNG is still over 5 MB, and byte for byte when it already
  fits. So the route takes an upload of up to 20 MB as it arrives, and what is
  kept is still at most 5 MB (`413 too_large` either way, saying which). A
  picture its codec cannot read (Electron's `nativeImage` reads PNG and JPEG)
  is kept as it came, under the same 5 MB. Without the shrinking a phone's
  photo reached Claude full size, and Claude refuses an image over 2000px a
  side once a thread holds more than 20. Only a desktop has the codec: a
  standalone Studio server does not advertise the capability, and keeps the
  5 MB upload ceiling. A client that does not see it keeps its own 5 MB check.
- **Pictures a step shows.** A desktop that advertises the `conversation-images`
  capability serves the picture a step made (Codex's `GenerateImage`) or looked
  at (a file read of a picture) at `GET /tailnet/v1/conversation-image`, named
  by `workspaceId`, `agentId` and the step's `toolUseId`, to a device with
  `conversation:read`. The file is the one the conversation's own record of
  that step names — the request carries no path — followed through links to a
  regular file, and served only when its first bytes are a PNG, JPEG, WebP or
  GIF (`415 not_an_image` otherwise, whatever its name) and it is at most 8 MB,
  the ceiling this machine's own previews use (`413 image_too_large`). A chat
  this machine does not have is `404 unknown_conversation`; a step that is not
  there, shows no picture, or whose file is gone is `404 unknown_image`. The
  bytes are cached privately for a day, since a step's picture never changes.
  A paired desktop shows these under a remote chat's steps the same way; for a
  machine without the capability it still says the picture is on the other
  machine.
- **Pictures a message carried.** A desktop that also advertises
  `conversation-message-images` serves the pictures a person sent with a
  message on the same route, named by `attachment`, the `ref` its
  `user_message` recorded for each (`attachments`), in place of `toolUseId`.
  The bytes come from this machine's attachment store, never from a path, and
  only from the folder the store keeps for that chat (or for its live
  session's folder), so a ref another chat recorded is `404 unknown_image`, as
  one that is gone is. What is served is at most the 5 MB a sent picture may
  be, under the type its first bytes say (PNG, JPEG, WebP or GIF), and cached
  privately for a day. The phone draws them as thumbnails on the person's
  message; it shows its own just-sent photos from the phone itself, and names
  a picture it cannot fetch.
- **Files a message carries.** A desktop that advertises
  `conversation-message-files` takes a file of any type on the upload route
  with `kind=file`, from a device with `conversation:operate`, for a chat it
  lists: at most 25 MB (`413 too_large`, naming the limit), under its own name
  made one safe path segment. It is written into Studio's data folder,
  `tailnet-uploads/<device>/<upload>/<name>`, never into the project, and
  answered `{ uploadId, bytes, name }`. A `send` naming that id in
  `uploadIds` attaches the file to the message by that path, as a file
  dropped into the desktop's composer is: the agent is told where it is, and
  the `user_message` records it in `files`, which every view draws as a card.
  Pictures and files go in the same `uploadIds`, each spent as what it was
  uploaded as. The id is the uploading device's alone and goes with the send;
  the file stays, for the agent to read in a later turn, and is removed a
  week on, or with the device when it is removed. One never sent goes when its
  id expires, after an hour.

### Sync

A subscription receives its replay — a bounded snapshot, or only the missed
events — then a `synchronized` fence, then live events. A client resumes with
the last sequence it holds and the log `generation` from the snapshot or fence
it came from; when the desktop can vouch for that cursor it sends only the
missed events and no snapshot. Another generation (the log was recreated), a
cursor ahead of the log, or one too far behind gets a reset snapshot instead.
Sequence numbers increase but have gaps, because a run of text deltas can be
merged into one delta numbered with its last sequence. Older turns page in
through `loadEarlier`. Command ids stay stable across retries, so a send
acknowledged before a disconnect is not accepted twice.

A reader that falls behind gets consecutive deltas merged instead of queued;
a large snapshot is sent in parts and never counts against live events. A
reader that stops reading is told to resync with a retry delay that grows while
it keeps falling behind. Requests beyond the per-socket bound are answered
`busy`, and responses over 32 MB are answered `too_large`; neither closes the
socket. Every refusal is answered under the id of what it refuses.

Every snapshot and fence names the conversation it belongs to. When a socket
switches conversations, the old replay stops at the next whole frame and never
sends its fence, and a client ignores frames for a conversation it no longer
follows. Live events that arrive while a replay is still going out wait behind
it, bounded by size rather than count, so a busy turn during a large catch-up
does not force a resync before the fence.

### The protocol

`@sprintengine/conversation-protocol` (`packages/conversation-protocol`) is the
one contract every follower of a conversation speaks (owner ruling
2026-10-01): this socket, the module SDK's conversation service, and the
desktop's own chat view, which imports its event types from it through
`src/shared/conversation-runtime.ts`. Its README is the frame reference. It
declares:

- **Events, in two layers.** Each provider adapter reads its CLI's own stream
  and writes `ConversationEvent`s in a vocabulary no provider owns
  (`CONVERSATION_EVENT_TYPES`); the provider's shapes stay in the adapter.
  Everything above, this socket included, carries only that second layer.
- **Commands and answers.** Every mutation carries the client's `commandId`,
  which the runtime records as a durable receipt before any work starts, so a
  retry is answered with the first attempt's result. A tool permission is
  answered `once`, `conversation` or `deny`, a question with its answers, a
  plan with `approve` or `reject`, and each answer can name the kind it is for.
  A permanent approval rule is the person's to make here and has no command.
- **Capabilities and a version.** `hello` answers the conversation protocol
  version (1), its minimum, and the conversation capabilities this machine
  advertises (`conversation-hello`). Features are asked about by capability,
  never by version; the version exists to refuse a peer a change could not be
  made additive for, naming both numbers.
- **Create requests.** `ConversationCreateRequest`, with `allowedTools` beside
  the preset. This socket does not create conversations through it; the
  module SDK does, and so does the Studio RPC on the owner socket
  (`@sprintengine/studio-protocol`, `conversation.create`).

The package entry is `public.ts`. The phone carries `index.ts` and the four
files it re-exports byte for byte under a shared SHA-256 pin
(`src/main/automation/tailnet/conversation-protocol.test.ts`), so those five
files change only in a change made on both sides at once; everything added
since lives in files of its own, re-exported from the entry, and leaves the
pin as it is. Building this branch does not publish the package.

Phase changes reach a client while its socket is open, and every paired
device's change feed says when the conversation list moved — a conversation
started, finished, or began waiting on a person — so a list re-reads on the
change rather than on a timer. Background push notifications are not provided. A conversation deep link is
`sprintengine://conversation/<deviceId>/<workspaceId>/<agentId>` (each component
URL-encoded); it resolves only against an already paired desktop.

### Machines and pull requests in the list

Two optional members on each row of the `sessions` answer to `list`, and one
on `GET /tailnet/v1/identity`, tell a paired phone which machine a chat runs
on and what has come of its work. All three are additive with no capability:
a desktop built before them sends none, an older phone ignores them, and a
client tells the two cases apart by the member being absent.

```ts
// On each listed chat (ConversationThread, packages/conversation-protocol/src/serverFrames.ts)
host?: { id: string; kind: string; label: string; color: string }
pullRequests?: Array<{ number: number; state: 'open' | 'merged' | 'closed'; url: string; title: string }>

// On GET /tailnet/v1/identity, beside deviceId, scopes and the rest
machine?: { kind: string; color: string }
```

- **`host.id`** is the machine's stable id, the one every device keys its mark
  by (`src/shared/machine-identity.ts`): `local` for the desktop answering,
  `wsl:<distro>` for one of its WSL distributions, `ssh:<host>` for an SSH
  machine (the host its SSH config resolves to, with `:<port>` when that is
  not 22), `tailnet:<short host>` for a chat born on a paired machine (an
  address, or a name typed with a full stop in it, stays whole). A client
  draws no machine mark for `local`.
- **`host.kind`** is one of `laptop`, `desktop`, `mini`, `tower`, `server`,
  `cloud`, `container`, `board` or `wsl`, and **`host.color`** one of `blue`,
  `teal`, `cyan`, `orange`, `yellow`, `violet`, `red` or `neutral`: the
  person's choice in Settings › Machines, else the defaults. A client draws a
  kind or colour it does not know as its fallback rather than dropping the
  machine. **`host.label`** is the name to show: `WSL: Ubuntu`, the SSH
  machine's label, the paired machine's name, or this machine's host name.
- A row whose machine cannot be named yet carries no `host` rather than a
  colour that would change once it is known: an SSH machine's host is read
  from the SSH machines Electron main holds, so a desktop serving from an
  out-of-process server leaves those rows unmarked.
- **`pullRequests`** is what the desktop's pull request record holds for the
  chat (`pullRequests.list`), at most `CONVERSATION_MAX_PULL_REQUESTS` (20),
  and an empty list when it holds none. It is read from the record only:
  listing never runs `gh`, so a phone refreshing its list costs no request to
  GitHub. The record is kept current when a chat's turn ends and on its slow
  poll, and the change feed says when the list moved.
- **`machine`** is how the phone draws the desktop itself: the kind and colour
  a second desktop gives it by default when it pairs by this machine's host
  name, with any override kept under `local` in the launch settings'
  `machineMarks` applied. A `host` of `local` on a listed chat carries the same
  pair.

### Rest, order and read state in the list

The desktop is the one owner of whether a chat is settled and of whether its
latest finish has been seen, and every client — the phone, another desktop,
the desktop's own sidebar — agrees with it. A desktop that advertises
`conversation-lifecycle` (owner report 2026-10-05) answers `list` this way:

- **Settled chats are not listed.** The sidebar draws no row for a chat whose
  record has `settledAt`, so no list does either. `workspace.list` items carry
  `settledAt` (null while the chat is in the list), so a paired desktop's
  browse leaves those workspaces out too.
- **The order is the sidebar's.** Most recently written to first, by the
  person's last message from any device (`lastUserMessageAt`), falling back,
  for a chat nobody has written to, to the latest of when it was made and when
  it was last typed into. Never by what an agent is doing: a finishing or
  waiting agent recolours its row, it does not move it. A message a paired
  device sends moves the desktop's own clock, so the sidebar and every list
  agree.
- **Five optional members on each row**, beside the agent's name in `title`,
  which older clients keep reading:

  ```ts
  chatTitle?: string          // the chat's title as the desktop's sidebar shows it
  lastUserMessageAt?: number  // when a person last sent it a message, from any device
  lastTurnEndedAt?: number    // when its agent last finished a turn, or failed one
  lastVisitedAt?: number      // when a person last had it on screen, on any device
  visitRewoundAt?: number     // when it was last marked unread, on any device
  ```

  `lastTurnEndedAt` is read from the chat's transcript (the thread index keeps
  it, and a session running now reads it off the same events), so a rename, a
  model switch or a session starting does not move it, and it is there for
  every chat whose agent has finished a turn, including turns that ended
  before it was kept. A chat whose `lastTurnEndedAt` is later than its
  `lastVisitedAt` has a finish nobody has seen. Nothing recorded visits before
  this, so the first launch of a desktop that does counts every chat it
  already had as seen at that moment, once; a chat made since starts with its
  own creation as its visit.

The first two are the capability's promise and hold only where it is
advertised. The Studio RPC on the owner socket does not advertise it, and its
`conversation.list` stays the list it always was: every chat, settled ones
included, most recently moved first, with the five members as optional
additions.

- **`conversation.settle`** `{ workspaceId, settled? }` (default `true`)
  writes the same patch as the row menu's Settle, or with `false` its
  Un-settle, and answers `{ ok: true, workspaceId, settledAt }` (`null` when
  the chat is in the list). It is refused as `working` while anything in the
  chat would be cut short — a turn starting, running or waiting on a person,
  an agent it launched still working in the background, or one of its agent
  terminals mid-turn — and `unknown_workspace` for a chat the desktop does not
  have; settling a settled chat again changes nothing. The desktop then does
  what its own Settle does: the chat's agents stop, and a window that has it
  in front moves on to the next chat.
- **`conversation.visit`** `{ workspaceId, visitedAt? }` moves the chat's
  `lastVisitedAt` forward to `visitedAt` (now when omitted, and never past the
  desktop's now) and answers `{ ok: true, workspaceId, lastVisitedAt }`. A
  `visitedAt` no later than the chat's `visitRewoundAt` is a reading taken
  before its last Mark unread and changes nothing. A desktop following a paired
  machine's chat sends no `visitedAt`, so that machine stamps the visit by its
  own clock. Like the other lifecycle tools it needs `conversation:operate`,
  but it is kept out of the gateway audit, allowed or refused: a device stamps
  one every few seconds while a chat is on screen. It is
  not activity: the chat keeps its place and a settled one stays settled. The
  desktop stamps its own windows' visits the same way: at once when the chat
  in front has an unseen finish, otherwise at most every ten seconds while it
  stays in front of a visible, focused window. A visit from elsewhere clears
  the desktop's own "finished while you were away" mark too. New chat
  covering a window's chat counts as nobody looking at it, as a door does,
  so it is not stamped; unlike a door it is not leaving the chat, whose "New"
  divider holds and whose Mark unread waits until the person moves on.
- **`conversation.mark_unread`** `{ workspaceId }` (2026-10-07, on a desktop
  that advertises `chat-mark-unread`) moves the chat's `lastVisitedAt`
  **back**, to its latest finish less a millisecond, and answers
  `{ ok: true, workspaceId, lastVisitedAt }`. Its finish reads as unseen again
  on every device, and the next opening's "New" divider sits above its latest
  reply. A chat already unread from further back keeps its clock; one whose
  agent has finished nothing is refused as `nothing_finished`. The finish is
  read as the list reads it, transcripts included, so a chat the list shows
  finished can be marked after a restart too. It is the one
  write that moves the visit clock back: the record stamps `visitRewoundAt`
  beside it, and the desktop's windows and its registry take an earlier
  `lastVisitedAt` only with a newer stamp, so a lagging visit still cannot
  roll the clock back. The desktop's own row menu calls the same command; on
  the chat in front it takes effect as the person leaves the chat, since
  looking at it is what reads it. A desktop without the capability answers
  "Unknown tool".

The change feed says the conversation list moved when a chat is settled or
brought back, renamed, or written to, marked unread, and for a visit when it
is the first since the chat's agent finished (the visits stamped while a chat
stays on screen are not a push each). A change to the record's clocks alone
(a visit, a Mark unread, a keystroke, a message, a turn's end) does not say
the workspace list moved, since `workspace.list` carries none of them.

`lastVisitedAt` going back is new with `conversation.mark_unread`, and a
client from before it reads it as it reads any visit clock: as of 2026-10-07
the phone takes the later of the listed clock and its own opening of the chat
(and of a visit it stamped itself this run), so it shows such a chat read
until the list says otherwise, never anything wrong. A phone that offers Mark
unread asks for `chat-mark-unread` first and drops its own later readings
once the list carries an earlier clock. Which readings to drop is what
`visitRewoundAt` says: a reading taken before it is older than the Mark
unread, so the listed `lastVisitedAt` wins over it, and a reading taken after
it (the person opened the chat since) still stands. A chat marked unread
while the phone was closed is found that way on the next list. Only Mark
unread writes the stamp; the desktop refuses it in any other patch.

All three tools need `conversation:operate` and are audited, like
`conversation.create`. A paired desktop's Remote rows use all of it: they are
titled with `chatTitle`, ordered by `lastUserMessageAt` (else `updatedAt`),
offer Settle from their menu on a desktop with the capability, and say a chat
opened here was visited there. A chat opened here offers Settle in its row menu
too: the other desktop is asked, and once it has settled the chat the row here
goes the way a local Settle takes a row. One that machine settles without
asking here (on the phone, or on that machine) is followed once its browse says
so, and the row here leaves the rail the same way.

On a desktop that advertises `chat-row-menu` (2026-10-21), a paired
desktop's row menu on one of its chats is the menu a local chat has, each
item written there, to the record the desktop's own menu writes:
**`conversation.highlight`** `{ workspaceId, starred?, color? }` is Star and
Highlight color (one of `CONVERSATION_HIGHLIGHT_COLORS`, or `null` for none;
a member left out stays as it is, and a chat left with neither has no
highlight); **`conversation.snooze`** `{ workspaceId, until }` is Snooze, until
a time still ahead, and with `until: null` Wake now (refused `working` while an
agent there works and `settled` for a settled chat, and the desktop pauses the
chat's processes as its own Snooze does); **`conversation.auto_settle`**
`{ workspaceId, enabled }` is the Auto-settle switch. Each listed chat says
what they wrote: `highlight` (`{ starred, color? }`) and `autoSettle: true`,
beside the `snoozedUntil` it already carried, and a change to any of them
moves the list. All three need `conversation:operate` and are audited. The
paired desktop draws the chat as that machine does: starred in its Starred
section, tinted with its colour, asleep in its project's Snoozed shelf until
it wakes. Mark unread is `conversation.mark_unread` above, offered where the
machine advertises `chat-mark-unread`. Copy link to chat links the chat by its
id on that machine, which opens it there and on any desktop that follows it;
Move to New Window opens it in a window of its own. Rename, New chat in
project, Reveal folder and Close workspace are about a workspace on the
desktop doing the asking, and are not offered for a chat no window there has
open. A machine without the capability answers the tools "Unknown tool", and
its chats offer none of the four.

On a desktop that advertises `chat-create-pull-request` (2026-10-18), a
paired desktop's Create PR runs there too, in the chat's own checkout:
**`conversation.pull_request_state`** `{ workspaceId, agentId }` answers
whether it is ready, as the strip asks a local chat's (`gitRoot` is always
null: no path of that machine's crosses); **`conversation.pull_request_draft`**
`{ workspaceId, agentId, draftId? }` writes the title and description with that
machine's text generation settings, refused `text_generation_off` where they
are off (`conversation.pull_request_draft_cancel` stops one by its id);
**`conversation.pull_request_push`** and **`conversation.pull_request_create`**
take the `pin` the state answered and are refused once the checkout has moved
off it. A creation's `kind` is the local one's, and a `created` pull request
is recorded there as the chat's, with `recorded` saying whether that landed.
The state is a read on `conversation:read`; the other four need
`conversation:operate` and are audited.

### Following from another desktop

A Studio desktop paired to this one follows its conversations with the same
pairing and grant a phone uses. The sidebar's
Remote band lists each chat on the paired machine as its own row, with the
presence its phase says: running, needs approval, or done. Opening one makes a
solo workspace whose pane is the regular chat view, following the conversation
over the tailnet, with the machine on the tab and above the transcript.
New chat starts one there too: with Chat agent picked, the machine dropdown
offers the paired machines, and launching on one asks it to start the chat in
the chosen project and opens that same pane on it. Attached images go with
the first message: the chat is started without its words, each image goes up
that machine's upload route under the new chat's session, and the words are
sent naming them, as a message to a followed chat is. That chat reads them
exactly as one started there would. A chat that cannot take them (a machine
without uploads, a CLI whose chat reads no images) is refused with the reason,
and an empty chat it left behind is settled. Skills and attached files are this
machine's and do not travel yet; the launcher says so rather than dropping
them. A WSL distribution is still not offered for a chat, which runs
in the app's own process.

- **The copy is kept.** Main follows over one socket per conversation, shared
  by every window showing it, and keeps the transcript tail with its cursor
  (log generation and last sequence) in the app profile. A dropped link or an
  app restart shows the conversation at once and asks only for what came after
  the cursor; another generation, or a cursor too far behind, gets a reset
  snapshot that replaces the copy. Forgetting the machine deletes its copies.
- **Every frame is validated** against the protocol before it touches the copy.
  A frame of a known type in the wrong shape ends the follow with a sentence
  rather than being skipped, since skipping an event and moving the cursor past
  it would lose it.
- **The link follows the host's advice.** A resync close waits the delay it
  names, a wake does not cut that short, `busy` is retried after its delay under
  the same id, a revoked device or a lost read grant ends the follow without
  retrying, and a socket silent past two of the host's pings is re-dialled.
- **What the view offers is what the grant and the lane allow.** A pairing
  without `conversation:operate` sees the conversation with the composer,
  approvals and stop closed. A remote view never offers a permanent approval
  rule, a checkpoint revert, or this machine's skills and files: what its
  composer offers of skills, mentions and commands is that machine's (below).
  Images it
  does offer, where the machine lists the chat as taking them: main puts each
  in that machine's upload store, as the phone does, and the send names them. It
  offers the same two-preset switcher a local chat does, reading the preset the
  machine's list names; a desktop built before the list carried the preset
  leaves the switcher hidden rather than guessing. Its engine chip is the same
  picker a local chat has, locked to the chat's CLI and listing the models the
  machine's own catalog names; a machine that does not advertise
  `conversation-models` keeps the chip on the model the chat is on. File paths in a
  remote transcript are not links, since they name files on the other disk. A
  send is answered when its turn ends, as on the desktop itself, and a send in
  flight across a reconnect is sent again under the same command id and
  accepted once.
- **A queued message is the other machine's to send** (owner report
  2026-10-08). A message typed while the chat's turn runs is handed at once to
  the machine the chat runs on, where it advertises
  `conversation-queued-sends`: that machine holds it among its scheduled
  messages, shows it in the chat's own tray, and sends it when the turn ends,
  whether or not this machine is still awake. The pane draws the rows from
  what that machine says it holds (`watchQueued`, `queued` frames); Edit takes
  it back from there. Where that machine takes a steer, the row's Send now
  (and Primary+Enter with nothing typed) takes the message back and steers it
  into the running turn (2026-10-24); elsewhere it is Stop and send, which
  stops the turn and lets the message go.
  Several queued in one turn go as one message, as the composer's own queue
  sends them. A machine without the capability, or one that refuses to hold a
  message, leaves it queued in this pane, which sends it when the turn ends
  only while this machine is awake, as every queued message was before.
- **A message can steer the turn over there** (2026-10-14). Where the machine
  advertises `conversation-steer-sends` and lists the chat's provider as taking
  a message mid-turn (`capabilities.steer`), the composer's Steer, chosen in
  Settings ▸ Agents or by Primary+Enter for one message, sends with `steer`,
  and the message goes into the running turn there. A turn that cannot take it
  then (a request it waits on, a turn that ended on the way) has that machine
  hold it as a queued message, and the pane shows it among the held rows. A
  machine without the capability is never sent a steer: the composer offers
  only Queue, and Primary+Enter stops the turn and sends after, as before.
- **An agent over there has its own Stop** (2026-10-24). Where the machine
  advertises `conversation-stop-subagent` and lists the chat's provider as
  able (`capabilities.stopSubagent`), each running agent's card and lane
  offers "Stop this agent", as a local chat's do, and it stops that agent
  alone over there. The machine's turn Stop spares a Claude chat's agents, so
  this is how one is stopped from here.
- **The composer reaches the chat's folder over there** (2026-10-25). Where
  the machine advertises `conversation-file-search` and
  `conversation-send-mentions`, an @ searches the chat's folder there (`GET
conversation-files`, on `conversation:read`), the picker ranks the matches
  and their folders as a search here is ranked, and the send names each pick
  by its path in that folder (`mentions`), which that machine resolves as its
  own composer's chips are, refusing one outside the folder, behind a link, or
  gone. Where it advertises `conversation-commands`, the `/` menu lists what
  the chat's CLI runs in that folder (`GET conversation-commands`), asked when
  the menu opens rather than as the chat does, since each ask may start the
  CLI over there; asking again (`refresh`) needs `conversation:operate`. A `$`
  lists that machine's skills, as the "+" does. Where it advertises
  `conversation-message-files`, a file attached here by its path is a card, as
  in a local chat: main reads it (25 MB at most), puts it in that machine's
  store with `upload?kind=file` under the chat's live session, and the send
  names it, so the agent reads it there by that path. A chat at rest there
  takes files once a message has woken it, as it takes pictures. A machine
  without one of these leaves that part of the composer as before: no @, the
  `/` menu with Studio's commands, a file typed as its path. A message holding
  mentions, skills or files is not handed to that machine's queue: that queue
  keeps words alone, so such a message waits in this pane and goes when the
  turn ends while this machine is awake.

### Terminals stay on the machine

Conversations are the only agents that cross the tailnet (2026-09-29). A
paired device, phone or desktop, cannot list, watch, type into, or start a
terminal on this machine: there is no terminal socket and no terminal scope,
and the tools that list terminals, read their output or start an agent in one
(`terminal.list`, `terminal.read`, `terminal.create`, `agent.launch`,
`backlog.work`) are served on the local socket only, to the agents and MCP
clients on this machine. What a
paired device starts is a chat, through `conversation.create`, and the machine
dropdown in New chat offers a paired machine only for a Chat agent. Scheduled
agents stay on the machine too: the phone neither lists nor runs them. A tab left open on a remote terminal by an earlier build reopens as
an unavailable panel.

## Manual verification

1. Run `npm run verify:app` and `npm run build`, then start Studio with a separate
   development profile.
2. Start an installed chat provider, stream a reply, expand work groups, select
   code while it streams, and scroll back while new text arrives.
3. Attach a skill and a file, switch conversations, and confirm the draft and
   skill survive. Deny a request, answer a multi-question prompt, and interrupt
   a running turn.
4. Open an old search result, close/reopen the conversation, inspect changed
   files, and check a confirmed revert in a disposable repository.
5. Fork a chat from an earlier reply and from an earlier message on each
   installed runtime. The fork opens in the next tab with the conversation up
   to that point (and the message in its composer); ask it what was said last,
   then confirm the original chat is unchanged. Restart before the fork's first
   message and send one: it still continues from the point.
6. Pair the companion over a tailnet with conversation access. Read, send,
   approve, answer, stop, disconnect mid-reply and reconnect (the reply resumes
   without a reset), and verify an offline send appears once after
   acknowledgement. Narrow the device to read-only in Settings and confirm the
   next command is refused.
7. Pair a second Studio desktop with conversation access. Open a chat from its
   Remote band, send, approve and stop from there; switch its model between
   turns and mid-reply (the notice says the switch applies from the next
   turn), and confirm the host's own chip follows; drop Wi-Fi mid-reply and
   rejoin (no reset, no repeated text); quit and relaunch it (the transcript is
   on screen before it reconnects, then catches up). Narrow the pairing to read
   and confirm the composer closes with the reason.

Mocked native UI fixtures and protocol tests do not replace a live provider or
physical-device test. Authentication-dependent checks should record which CLI
and permission policy were actually exercised.
