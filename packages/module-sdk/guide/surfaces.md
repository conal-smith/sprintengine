# Which surface

Pick the smallest surface that does the job. `extension.create` takes a
`template` that starts from one of these, and `parts` (`main`, `mcp`,
`settings`, `door`) add more; in an existing project,
`npx sprintengine-module add <part>` does the same.

| The idea needs… | API (renderer unless noted) | Permission | Template |
| --- | --- | --- | --- |
| A command in the palette | `registerCommand` | — | blank |
| A page of its own, opened from the Extensions drawer | `registerGlobalSurface({ id, label, Icon, Component })` + `@sprintengine/module-sdk/surface`; its count with `registerDoorBadge({ rowId: id })` | per data read | global-surface |
| Tell the person something happened | main: `host.notify({ severity, title, target })` (the bell; `target` opens your door); renderer: `host.toast({ tone, message })` (transient) | — | — |
| A panel inside a workspace | `registerPanel` + a `registerWorkspaceType` whose layout places it | per data read | panel |
| A new kind of workspace, with a setup step | `registerWorkspaceType({ creationStep, createWorkspace })` | `storage` for its state | workspace-type |
| One control in the top bar | `registerTopBarItem` | — | top-bar-item |
| Options in Settings | `registerSettingsSection` (values readable via `getModuleAppState`, in the renderer and in main) | `storage` to read them elsewhere | settings-section |
| An action on a Backlog item | `registerBacklogItemAction` | `backlog.*` if it reads/writes more | backlog-action |
| Reading or changing Backlog items (a board, a quick-add) | renderer: `listBacklogItems`, `createBacklogItem`, `updateBacklogStatus`, …; main: `getBacklogService(host)` | `backlog.read` / `backlog.write` | — |
| Token usage and cost across agent sessions | main: `getUsageService(host)`; renderer: `queryUsage` | `usage:read` | — |
| Reading the person's own chats (standups, prompt coaching) | main: `getActivityService(host)` | `conversation:read-all` (broad) | — |
| An action on files in the Files tree | `registerFileAction` | — | file-action |
| A pick-and-close dialog over the workspace | `registerModalSurface({ launcher })` | — | — |
| Tools agents call | main: `host.registerMcpTools` | `mcp:tools` | mcp-tools |
| An agent doing work in a chat | main: `getConversationService(host)` | `conversation:operate` (or `:read`) | chat-companion |
| Hand the person a prepared chat | `host.openChat({ workspaceId, prompt, name, dedupeKey })` | `chat:draft` (`conversation:operate` to send it) | backlog-action |
| Ask a model one question (summary, digest, JSON), no chat | main: `getTextGenerationService(host).generate` | `agents:generate` | — |
| A background agent returning validated JSON | main: `getCompanionAgentsService(host)`, `runStructured({ tools: 'none' })` | `agents:companion` | — |
| An agent that runs on a schedule | main: `getScheduledAgentsService(host)` (`tag`, `onRun` to trace runs) | `scheduled-agents.manage`, `dependsOn: ["scheduled-agents"]` | — |
| Calling an API with a key | main: `getSecretsService(host).fetchWithSecret` | `secrets` | — |
| Calling GitHub as the user | main: `getGitHubService(host).request` / `.graphql` (read-only) / `.download` (logs) | `github` | — |
| A workspace's branch and GitHub remote | `host.getWorkspaceGitInfo(workspaceId)` (renderer or main) | `ipc:workspace-read` | — |
| Saving data | renderer: `get/setModuleAppState`, `get/setWorkspaceModuleState`; main: `getModuleStorage(host)` (`list({ prefix })`, `getMany`, `watch`), `host.getModuleDataDir()` past 1 MB | `storage` | panel |
| Renderer ↔ main | main `registerIpc('<id>:…')`, renderer `host.invoke`; main → renderer `host.emit` / `host.subscribe` | `module:bridge` | chat-companion |
| Skills agents can use | main: `host.registerSkills`, `host.ensureSkillInstalled`, `host.getSkillStatus` | — | — |
| Files inside the module (HTML, WASM) | `host.getAssetUrl('runtime/index.html')`; main: `host.getAssetPath('dist/worker.cjs')` | — | — |

The details are in the `api-renderer`, `api-main`, `conversations`, `brokers`
and `ui-kit` topics.

## Agents are chats

Studio drives agents as chats. An extension starts, prompts, watches and stops
its **own** chats through `getConversationService(host)` in `entry.main`, or
opens one for the person with `host.openChat` in the renderer (a draft by
default: the person reads and sends it). It never drives the person's own chats
or another module's; reading the person's chats is the separate, read-only
`getActivityService(host)` behind the broad `conversation:read-all` (the
`api-main` topic). A question with one answer (a summary, a digest, a
classification) needs no chat at all: `getTextGenerationService(host)`. Read
what an agent answered with `chats.reply(ref)`, never by joining streamed
text deltas. There is no API to spawn a terminal agent, run a CLI in a
pane, or inject into another session — do not look for one, and do not shell
out to an agent CLI from `entry.main` to get around it. See the
`conversations` topic.

## Ask the host first

Before relying on a capability, ask the host: `host.supports('conversations')`,
`'chat.open'`, `'secrets'`, `'github'`, `'storage'`, `'mcp-tools'`, … A host
without it answers `false`; degrade with a message instead of throwing.
