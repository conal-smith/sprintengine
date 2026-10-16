# Main-process API (`entry.main`)

`export const registerMain: RegisterMain = (host) => { … }` runs once, in
Studio's main process (Node, no window), after the module is trusted and
enabled. It may be async; Studio waits up to 10 seconds. Only use a main entry
when the idea needs Node, a service only main has, or work with no window
open — a renderer-only module is simpler, installs without a restart, and
asks for less trust.

Bundle it as one CommonJS entry file with `electron` external and everything
else bundled: the installed module has no `node_modules`. The entry is one
file, but it may start worker threads from other files the module ships —
build each worker as its own CommonJS bundle into `module/dist/` and start it
with `new Worker(host.getAssetPath('dist/worker.cjs'))`. Every file is in
`files` and signed with the rest, and `getAssetPath` resolves only a file whose
bytes still match. A new or rebuilt main entry loads only after a Studio
restart.

## The host

| Member | Notes |
| --- | --- |
| `moduleId`, `hostApiVersion`, `supports(capability)` | Identity; ask `supports` before using a newer capability. |
| `listChatRuntimes()` | `Promise<[{ id, label, available, models, lastSelected }]>`: the agent runtimes a chat can run on, as the renderer lists them, with missing ones `available: false`. `id` is the runtime id every `cli` takes. May probe (cached a minute). `supports('chat-runtimes')`. |
| `registerIpc(channel, handler)` | A channel the renderer calls with `host.invoke`. Must start with `<moduleId>:`; the module must declare `module:bridge`. Handler: `(event, payload) => result`; `event` is opaque. Validate `payload` — it is input. |
| `emit(topic, payload?)` | Push a signal to your renderer's `host.subscribe(topic, cb)` in every window. No replay. |
| `registerMcpTools(tools)` | Tools on the Studio MCP gateway every agent is connected to. Needs `mcp:tools`. |
| `registerSkills(skills)` / `ensureSkillInstalled(root, id)` / `getSkillStatus(root, id)` | Ship skills (folders with SKILL.md) inside the module, put them in a workspace, or check without writing (below). |
| `getModuleAppState(key)` / `watchModuleAppState(cb)` | Your Settings section's values (your module app state), read-only, with no window open. `storage`. |
| `getWorkspaceGitInfo(workspaceId)` | `{ ok, branch, remotes: [{ name, url, github? }] }`, read by git from the workspace's folder. Checked: `ipc:workspace-read`. |
| `getModuleDataDir()` | A private directory under user data for data past the 1 MB value limit; removed at uninstall. `storage`. |
| `getAssetPath(relative)` | Absolute path of a file your module ships (a worker, WASM, a data table); verified files only. |
| `notify({ severity, title, body?, target? })` | A row in the bell of every open window, under the module's display name. `target: { surfaceId, viewId? }` (one of your own doors) gives the row an Open that lands there and counts it on that door's drawer row. Dropped: an identical repeat within 10 s, or more than 20 rows in 10 s — fold a burst into one row. Rows sent before a window opens are kept (last 50). Add actions from the renderer with `registerNotificationActionProvider({ source: host.moduleId })`. `supports('notifications')` is false where no window can show it. |
| `onStartup(hook)` / `onShutdownBegin(hook)` / `onShutdown(hook)` | Start watchers on startup; stop loops at shutdown begin; release everything at shutdown. |
| `requireService(token)` / `getService(token)` | Host services by token (below). `requireService` throws when absent. |
| `provideService(token, factory)` | Offer a service to modules that depend on yours. |
| `registerSidecar(spec)` | A declaration only; the host does not spawn third-party sidecars. |

## Services

Each helper closes over `host.moduleId`, so a module only ever reaches its own
data. Call a helper at the top of `registerMain` only when the manifest's
`dependsOn` guarantees the provider loaded first; otherwise call it inside the
handler that needs it.

| Helper / token | Permission | `dependsOn` | What |
| --- | --- | --- | --- |
| `getConversationService(host)` | `conversation:read` / `conversation:operate` | `agent-runtime` | The module's own chats — [conversation-api.md](conversation-api.md) |
| `getModuleStorage(host)` | `storage` | `agent-runtime` | JSON key-value store, per workspace (`workspaceRoot`) or global; 1 MB per value; atomic writes |
| `getSecretsService(host)` | `secrets` | — | API keys the host holds and sends only to named origins — [brokers.md](brokers.md) |
| `getGitHubService(host)` | `github` | — | GitHub API calls with the user's sign-in — [brokers.md](brokers.md) |
| `getScheduledAgentsService(host)` | `scheduled-agents.manage` | `scheduled-agents` | Create/list/update/remove/run the module's own scheduled agents, and hear when they change (`onChanged`) and when one starts a chat (`onRun`) |
| `getCompanionAgentsService(host)` | `agents:companion` | `agent-runtime` | A workspace-bound background agent with a structured `runStructured` task API |
| `getTextGenerationService(host)` | `agents:generate` | — (resolve in handlers) | One prompt answered by the person's own Claude Code or Codex with no chat or workspace — [conversation-api.md](conversation-api.md) |
| `host.requireService(WorkspaceContextToken)` | `ipc:workspace-read` | — (resolve in handlers) | `get(id)`, and `list()` of open workspaces `{ id, name, folderPath, mode, open }`; `list({ includeClosed: true })` adds the ones closed on this machine (`open: false`, `closedAt`) |
| `host.requireService(WorkspaceServiceToken)` | `ipc:workspace-write` | — (resolve in handlers) | `create({ name, folderPath })` a workspace |
| `getBacklogService(host)` | `backlog.read` / `backlog.write` | `agent-runtime` | List, locate, create and change Backlog items through the app — below |
| `getUsageService(host)` | `usage:read` | `agent-runtime` | Token usage of every agent session on the machine — below |
| `getActivityService(host)` | `conversation:read-all` | `agent-runtime` | The person's Studio chats and prompts, read-only — below |

## Settings in `entry.main`

What your Settings section writes (`setValue`) and what the renderer writes
with `setModuleAppState` is one namespace, and `entry.main` reads it with
`host.getModuleAppState(key)` — the value the person chose, persisted, with no
window open. `host.watchModuleAppState(cb)` hears it change. Read-only from
main; no second store and no IPC sync step.

```ts
const every = host.getModuleAppState<number>('pollMinutes') ?? 15
const stop = host.watchModuleAppState((values) => reschedule(Number(values.pollMinutes ?? 15)))
host.onShutdown(stop)
```

## MCP tools

```ts
host.registerMcpTools([
  {
    name: 'wordcount.count',
    description: 'Count the words in a piece of text.',
    inputSchema: { type: 'object', properties: { text: { type: 'string' } }, required: ['text'] },
    mutates: false,
    handler: async (args) => ({ content: [{ type: 'text', text: String(String(args.text).split(/\s+/).length) }] }),
  },
])
```

- Names are a public contract: keep them stable, in a family of your own
  named for the module (`decisions.record`, `decisions_list`). The gateway
  serves names verbatim; clients without dots write `a_b` for `a.b`, so names
  are compared in that form. A name that matches a core tool
  (`backlog_list` vs `backlog.list`), falls in a shell family (`browser`,
  `canvas`, `editor`, `tour`, `terminal`) or matches another module's tool is a
  registration error naming the conflict. Keep out of the core families too
  (`agent`, `backlog`, `cli`, `conversation`, `local_server`, `marketplace`,
  `module`, `pull_request`, `schedule`, `tailnet`, `workspace`, `worktree`,
  `studio`, `sprintengine`, `app`): new core tools land there.
- `context.metadata` says who is calling. `verified: true` means a launch token
  or the tailnet proved it; a chat Studio launched is always `studio-agent`,
  verified, with `workspaceId` and `agentId`, and `agentName` / `cliId` when
  the launch recorded them. Anything else declared its identity: never label
  that as verified authorship.
- A third-party tool counts as changing state unless it declares
  `mutates: false`. Declare it on every read-only tool.
- `args` comes from an agent: validate every field; return `isError: true`
  with a sentence the agent can act on rather than throwing.
- While the module is disabled its tools stay listed and answer with an
  "enable the module" error.

## Scheduled agents

A scheduled agent is a prompt and a cron schedule: each time the schedule
comes round, a new chat starts in `folderPath` with the prompt as its first
message, on the CLI, model, permissions, skills, MCP servers and worktree
setting recorded. `getScheduledAgentsService(host).create(draft)` validates
the draft (a cron that does not parse, or never comes round, is refused with
the reason) and answers `{ ok: true, agent }` with `agent.nextRunAt`. The
module sees and changes only the ones it created; the person sees them in the
sidebar with their own, and can close them.

Give each a `name` (its sidebar title; absent, the prompt's first line) and a
`tag` (your own label, never shown). `onRun((agent, run) => …)` names each
run's chat as it starts — one-time schedules included, before they close —
and that chat, which your conversation service reaches, carries
`scheduledAgentId` and `scheduledAgentTag`. A time missed while the app was
closed is not replayed (a one-time schedule's is, once, at start-up); times
missed in sleep run once on waking; a time that comes while the last run is
still working is skipped. `supports('scheduled-agent-runs')`.

## Companion agents and their tools

`getCompanionAgentsService(host).attach(spec)` gives a background agent bound
to a workspace; `runStructured({ prompt, validate, tools? })` runs one task
and returns validated JSON. The agent asks before every tool it uses, and
`tools` decides the answer:

- `'none'` (default): denied, and the agent is told up front it has no tools.
  Use it whenever the prompt carries text you did not write.
- `'ask'`: left open for the person. Show the `approval_requested` events from
  `onEvent` and relay their answer with `handle.respondToApproval({ requestId,
  decision: 'once' | 'deny' })`; allowing needs `conversation:operate`.
- `'auto'`: approved without asking. Needs `conversation:bypass` (the run is
  refused without it).

`engine: { cli, model }` takes a runtime id (`claude-code`) or a provider id
(`claude-agent`). `supports('companion-tools')`; an older host approves every
tool call whatever `tools` says, so do not feed it untrusted text there.

## Backlog, usage and activity

**Backlog.** `getBacklogService(host)`: `list`, `getLocation`, `create`,
`updateStatus`, `updateTriage`, `addLink`, `updateModuleMetadata`. `itemId` is
a `BacklogItemView.id`. Writes go through the app's Backlog service in the
project's mutation lane; `create` uses the app's create path and answers
`{ id, relativePath, path, numericId, displayId }`. Never write an item's file
yourself, and never derive the Backlog root: `getLocation` answers it.

**Usage.** `getUsageService(host).query({ from, to, groupBy })` sums tokens
(`input`, `output`, `cacheRead`, `cacheWrite`) and requests over Studio chats
and terminal Claude Code / Codex sessions, each request once. `groupBy`:
`day`, `model`, `provider`, `workspace`, `session`. Tokens only — price them
yourself. The first query waits for the first read of the logs; `onChanged`
says when to query again. Do not read `~/.claude` or `~/.codex` yourself.

**Activity.** `getActivityService(host)`: `listChats({ from?, to?,
workspaceId? })` and `prompts({ from, to, workspaceId?, limit? })` — the
person's messages with the tail of each reply, never tool output. Open
workspaces only. `conversation:read-all` is flagged broad in the consent
prompt; ask for it only when reading the person's chats is the module's point.

## Storage

```ts
const storage = getModuleStorage(host)
const saved = await storage.get({ key: 'state', workspaceRoot })   // { ok, value, found } | { ok: false, code, message }
await storage.set({ key: 'state', value: { count: 1 }, workspaceRoot })
const { keys } = await storage.list({ workspaceRoot, prefix: 'decision.' })  // one record family
const many = await storage.getMany({ keys, workspaceRoot })        // { ok, values } — unset keys are absent
const stop = storage.watch({ workspaceRoot }, ({ keys }) => refresh(keys))  // own writes at once; another window's within ~2 s
```

Keys match `^[a-z0-9][a-z0-9._-]{0,63}$`. Omit `workspaceRoot` for the
module's global store. The host decides where files go (`modules/<id>/` in
the project's store in the person's home, or app data); never write your own
files in the home folder or the workspace for module state. Workspace keys are
not in the project's folder, so they never show in its `git status` and do not
travel with a clone.

Past the 1 MB value limit (caches, indexes, blobs), use
`host.getModuleDataDir()`: a directory of your own under the app's user data,
created on demand and removed when the module is uninstalled. Lay it out
however you like; it is per machine and never synced.

## Skills

Ship skill folders inside the module — `module/skills/<id>/SKILL.md` (plus any
`agents/` sidecars) — and register them with `sourceDir: 'skills/<id>'`,
relative to the module root (the `module/` folder). Editing a skill file is a
change under `module/` like any other: rebuild, re-sign, re-trust.

A registered skill reaches a chat in two ways, and only these:

- **A launch that names it** — `create({ skills: ['<id>'] })`, a scheduled
  agent's `skills`, an `openChat` that attaches it: the host installs it into
  that chat's folder first.
- **A copy already in the workspace** — `ensureSkillInstalled(root, id)` writes
  it (`'all-native'`: into `.agents/skills` and every installed CLI's own skill
  directory; `'agents'`: `.agents/skills` only). Those copies stay, so every new
  chat in that workspace finds it, including ones the person starts.

Registering alone writes nothing to any workspace: an `all-native` skill does
not reach new chats on its own until one of the above has run there.
`getSkillStatus(root, id)` answers the same question as `ensureSkillInstalled`
without writing, for a door that shows "installed in this project". Both answer
with `ModuleSkillStatus` (`installed`, `updated`, `missing`, `update-available`,
`local`, `modified`, `delivered-at-launch`, `missing-source`,
`missing-workspace`, `unknown-skill`, `install-failed`).
