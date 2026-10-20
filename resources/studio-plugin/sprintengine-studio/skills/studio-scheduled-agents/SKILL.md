---
name: studio-scheduled-agents
description: List, create, run, pause, resume and remove SprintEngine Studio scheduled agents, and read the agent CLIs, capability modules and marketplace behind them. Use when asked to run an agent on a schedule ("every weekday at 9", "nightly", a cron expression), to check what is scheduled on this computer, to start a scheduled agent's run now, to pause or resume one, to stop one, to find out whether a capability module is enabled, or to browse the extension marketplace the app itself reads.
---

# Scheduled agents

A scheduled agent is a prompt and a schedule. Each time the schedule comes
round, Studio starts a **new chat** in the scheduled agent's project with that
prompt as its first message — the same chat New chat would start, on the same
machine, with the model, permission preset, skills, MCP servers and worktree
choice it was scheduled with. Nothing carries over from one run to the next:
there is no shared conversation and no memory between runs beyond what the
prompt tells the agent to read or write. Each run's chat is marked with the
scheduled agent that started it, and the person sees a schedule's recent runs
when they open it in the app. If a run needs to know
what the last one did, the prompt has to say where to look (a file, an issue
tracker, the git log).

Scheduled agents live in the app's own data on this computer, not in the
project, and run in the main process, so a run starts with no app window open.
They run while the app is running: a time that passes while the app is closed is
not replayed, and one that passes while the computer sleeps runs once on waking.

## Read before you write

`schedule_list` returns every scheduled agent on this computer: its `id`, the
prompt, the cron schedule and its `scheduleWords` ("Every Sunday at 9:00 PM"),
`nextRunAt`, the project folder and machine, `paused` (and `pausedAt`), and
`lastRun` — whether the last run started (with the `workspaceId` of the chat it
started) or why it did not. Beside the list, `pausedAll` says whether the person
has paused every scheduled agent, and `until` when (null: until they resume
them). `nextRunAt` is null for a schedule that is paused either way. Read it
before creating one, so you do not schedule the same thing twice.

## Create

`schedule_create` takes:

- `workspaceId` — from `workspace_list`. The scheduled agent runs in that
  workspace's project and on its machine; a workspace on a worktree schedules
  into its project, not into that worktree.
- `prompt` — the first message every run is sent. Its first line is the
  scheduled agent's name in the sidebar, so make that line say what it does.
- `cron` — five-field cron: minute, hour, day of month, month, day of week.
  `*`, lists, ranges and steps work, as do three-letter month and day names and
  the `@hourly`/`@daily`/`@weekly`/`@monthly` shorthands. Several expressions
  separated by `;` run at the union of their times — `0 9 * * *; 30 13 * * *` is
  daily at 9:00 AM and 1:30 PM.
- `timezone` (optional) — the IANA zone the cron is read in; this computer's
  when omitted.
- `cli` and `model` (optional) — read `cli_runtime_list` first; the CLI picked
  last on this computer when omitted.
- `permissionPreset` (optional) — `bypass`, `auto`, `manual` or `none`, the
  same four a person picks in the app. Omitted, the run uses the preset chosen
  for that CLI at run time, else `auto`.
- `worktree` (optional) — `true` runs each time in a fresh git worktree rather
  than the project's checkout.
- `skills` and `mcpServers` (optional) — ids attached to every run.

A schedule that never comes round (the 30th of February) is refused rather than
saved. The answer carries the new scheduled agent with its `scheduleWords` and
`nextRunAt`: read those back to the person, because a cron line is easy to get
wrong and the words are how they check it.

A run starts with nobody watching. `bypass` is the right preset for an agent
nobody is watching. `auto` lets edits in the workspace through and asks before
commands and anything outside it; `manual` asks before every edit, command and
outside call; `none` passes no permission flag, so the CLI runs on its own
configured default. Any of them can ask for approval, and then the run waits on
its approval card for a person. Say so when you create one on any preset but
`bypass`.

Called by an agent of this app, the scheduled agent is held to that agent's own
preset: a looser one is refused with `permission_escalation`, and an omitted
one is stored as the caller's.

## Run now and remove

`schedule_run` with `{id}` starts the scheduled agent's run now, without
waiting for its schedule, and answers with the `workspaceId` of the chat it
started. `schedule_delete` with `{id}` stops and removes a scheduled agent;
chats its earlier runs started are left as they are.

## Pause and resume

`schedule_pause` with `{id}` stops a scheduled agent's runs at its times until
it is resumed; it stays in the list, and the person sees it marked Paused. A run
already going is left to finish, and `schedule_run` still starts one.
`schedule_resume` with `{id}` puts it back on its schedule: it runs next at its
first time from now, and the times that passed while it was paused are not made
up. Resuming is held to your preset as `schedule_run` is. Pausing every
scheduled agent at once is the person's, in the app; while that holds, a
resumed one still waits for it to end.

Runs never overlap. While a scheduled agent's last run is still working — a
turn open, or waiting on an approval card — `schedule_run` is refused with
"Its last run is still working.", and a scheduled time that comes round then is
skipped rather than starting a second chat beside the first.

## When you are a scheduled run

A chat a scheduled agent started may read `schedule_list`, but
`schedule_create`, `schedule_delete`, `schedule_run`, `schedule_pause` and
`schedule_resume` refuse it with
`scheduled_run_refused`: a run never makes, removes or fires a schedule, so no
run can start a chain of runs. If the task seems to need a schedule changed,
say so in your reply for the person to do in the app.

## What is available to schedule

`cli_runtime_list` is the list of agent CLIs this app can launch, with each
one's model ids and reasoning-effort levels. Read it before naming a `cli` or
`model` anywhere — those are otherwise blind strings. Only rows with
`agentSelectable: true` may be launched; a false row is registry-held for
install and detection only, and every launch door refuses it. A row whose
`allowCustomModelId` is true accepts model ids outside its listed options, which
are a seed rather than a closed set. This reports what the registry holds, not
what is installed on this machine — it never probes for binaries.

`module_list` reports the capability modules this app has, as the user sees
them: bundled and third-party, each with its source, version, whether it is
enabled, and why it is not when it is off. Scheduled agents are one of them
(`scheduled-agents`); when it is off, the `schedule_*` tools say so. A module
that ships only in development builds is absent from a packaged build
entirely, never reported as present-but-disabled. A third-party module that is
installed but untrusted appears as installed even though it loads nowhere.

`module_status` with `{id}` reads one module: its manifest, the permissions it
declares, the surfaces it contributes, the gateway tools it adds, and — when it
is not active — why. This is the tool that answers "why is that tool missing":
a `<moduleId>_module_disabled` refusal anywhere on this gateway is a module to
look up here.

Enabling, installing and trusting are **not** on this surface. They are trust
decisions and belong to a person in the app. Report what is off and why; do not
try to turn it on.

`marketplace_list` browses the extension index the app itself reads — modules,
MCP servers, skill packs and agent CLIs — through the same registry client,
cache and bundled-first policy as the Plugins catalogue. Filter with `provides`
for the module-first facet, `query` to search, `forceRefresh` to skip the
cache. The result discloses where the index came from and whether it is a stale
offline cache; say which when you quote it, because an offline answer can be out
of date and is still the only honest one available.
