# Changelog

## 1.0.0-beta.1

Automations became scheduled agents: a prompt and a cron schedule, each run a
new chat. The app no longer has an automations engine for a module to extend.
Beside that, it adds the Backlog, usage, activity and text-generation
services, the shell's notifications and window context, main-host plumbing,
`module:bridge`, the testing kit, and companion tools, turn replies and
scheduled-agent runs, all additive under host API 1.

### Changed: the extension guide replaces the extension-builder skill

- The `sprintengine-extension-builder` skill is gone from the package
  (`skills/`), and `scaffoldModuleProject` no longer writes it into
  `.agents/skills/` and `.claude/skills/`: its `skillsRoot` option,
  `defaultSkillsRoot` and the `EXTENSION_BUILDER_SKILL_*` exports and
  `extensionBuilderSkillPointer` are removed. A project's `validate.mjs` no
  longer checks a skill pointer.
- Its content is the extension guide: Markdown topics in `guide/`, shipped in
  the package, with `EXTENSION_GUIDE_TOPICS`, `readExtensionGuideTopic` and
  `defaultGuideRoot` in the new `@sprintengine/module-sdk/guide` subpath.
  SprintEngine Studio serves the topics to agents with its `extension.guide`
  tool, and makes projects with `extension.create`.
- A scaffolded project's `AGENTS.md` sends its agent to the guide, and the
  project gains `scripts/check-toolchain.mjs` (it was the skill's).

### Added: Backlog, usage and activity services

- **Backlog writes.** `getBacklogService(host)` in `entry.main` — `list`,
  `getLocation`, `create`, `updateStatus`, `updateTriage`, `addLink`,
  `updateModuleMetadata` — and the renderer twins `getBacklogLocation`,
  `createBacklogItem`, `updateBacklogStatus`, `updateBacklogTriage`,
  `addBacklogLink`, `updateBacklogModuleMetadata`. Every write goes through
  the app's Backlog service in the project's mutation lane; `create` takes the
  app's create path and answers the new item's id, number and display id.
  Result-shaped (`ModuleBacklogResult`). `host.supports('backlog-write')`.
- **`BacklogItemView`** gains `numericId`, `displayId` (`MC-240`), `epic` and
  `modifiedAt`.
- **`watchBacklogItems(workspaceId, cb, { onError })`**: a workspace with no
  folder, one that cannot be resolved, or an unreadable Backlog now reaches the
  module (`BacklogWatchError`) instead of only the console.
- **Usage.** `getUsageService(host)` (`query({ from, to, groupBy })`,
  `onChanged`) and `RendererHost.queryUsage`: token usage of Studio chats and of
  the Claude Code and Codex sessions on the machine, each request counted once
  and attributed to open workspaces. New permission `usage:read`;
  `host.supports('usage')`.
- **Activity.** `getActivityService(host)` (`listChats`, `prompts`): the
  person's Studio chats and their messages with the tail of each reply,
  read-only, never tool output. New permission `conversation:read-all`, flagged
  as a broad scope in the consent prompt; `host.supports('activity')`.

### Changed

- **`backlog.read` and `backlog.write` are checked.** The Backlog service checks
  both on every call, and a third-party module's `listBacklogItems` /
  `watchBacklogItems` now throw without `backlog.read`, which the docs always
  asked for. The `listBacklogItems` doc no longer suggests writing an item's
  file: a module changes items through the host only.
- **Workspace storage is out of the project.** Workspace-scoped keys live in
  the project's store in the person's home
  (`~/.sprintengine/workspaces/<project>/modules/<moduleId>/`), one per
  project whichever checkout asks, instead of `<project>/.sprintengine/modules/`.
  The app moves existing keys there once; a file git tracks stays in the
  project and is no longer read. The API is unchanged.

<!-- Shell surfaces, notifications and the renderer host. All additive under host API 1. -->

### Added: shell surfaces, notifications and the renderer host

- **`MainHost.notify` reaches the bell.** A row in the notification bell of
  every open window, under the module's display name (stamped by the host).
  Rows sent before a window opens are kept (the last 50) and filed when one
  does; this works the same when Studio's server runs in a process of its own.
  `host.supports('notifications')` is true only where a client delivery is
  wired. The existing flood bound applies; the same words about two different
  targets are two rows, not a repeat.
- **`ModuleNotifyInput.target`** (`{ surfaceId, viewId? }`, type
  `ModuleNotificationTarget`): the row's Open lands on one of the module's own
  doors — never another module's — and the row counts on that door's drawer
  row until the door is opened. `ModuleNotification.target` carries it.
- **Actions on a module's own bell rows:**
  `registerNotificationActionProvider({ source: host.moduleId, … })` adds
  actions to every row the module's `notify` sent. `NotificationActionView`
  gains `title`, `message` and `surfaceTarget`.
- **Installed doors' nav entries and badges are drawn.**
  `registerDoorBadge({ rowId: <surface id> })` counts on the door's Extensions
  drawer row (the first row of a surface with `views`) and on the app rail's
  Extensions square, beside the module's unread bell rows filed under the door.
  `registerSidebarNavEntry({ id: <surface id> })` draws that row in the
  module's own component; `SidebarNavEntryRenderProps` gains the host's
  `badge` (`SidebarNavEntryBadge`). `host.supports('door-badges')`,
  `host.supports('sidebar-nav-entries')`.
- **`RendererHost.toast({ tone, message, detail?, action? })`** — transient
  feedback in the app's toast region, under the module's name, with at most one
  button (`ModuleToastInput`, `ModuleToastTone`). Returns a dismisser.
  `host.supports('toast')`.
- **`RendererHost.moduleId`** (`host.supports('module-id')`).
- **Commands get context.** `ModuleCommandDefinition.run(context)` receives the
  `ModuleCommandContext` of the window it ran in; a zero-argument `run` still
  works. `RendererHost.getActiveWorkspaceId()` and `watchActiveWorkspace(cb)`
  read the workspace the window shows. `host.supports('command-context')`,
  `host.supports('active-workspace')`.
- **`RendererHost.setSurfaceView(surfaceId, viewId | null)`** publishes which
  of a surface's `views` it is showing, so that drawer row reads selected
  (`host.supports('surface-view')`).
- **`RendererHost.openExternal(url)`** opens an absolute http(s) URL in the
  system browser through the app's own link path, answering
  `ModuleOpenExternalResult` (`host.supports('open-external')`).

### Added: UI kit and theme tokens

All behind `host.supports('ui-kit-extras')`, and `host.supports('chart-tokens')`
for the tokens.

- `@sprintengine/module-sdk/ui` exports `ContextMenu`, `MenuItem` and
  `MenuDivider`: a menu at a point, with arrow keys, Escape and focus return
  built in.
- `TaskCard` and `BoardLane`, the app's own task card and board lane, so a
  module's board is built from them.
- `DateTimeInput` (the native `datetime-local` / `date` / `time` control in the
  `Input` box) and `Toggle` (the app's switch).
- `Chip` (the static fact chip) and `ChipButton` (a pill that toggles, filters
  or wears an identity `tint`).
- `SafeMarkdown`: agent Markdown drawn like a chat reply, with raw HTML shown
  as text, http(s)-only links (`links: 'open' | 'copy' | 'none'`) and no
  fetched images.
- `SidebarNavButton` and the `RowBadge` type, so a nav entry draws the app's
  own row wearing its host-derived badge.
- `Select` takes `size: 'xs' | 'sm' | 'md'` (default `sm`) to sit level with
  the buttons in its row.
- `LinkButton` takes `ink: 'name'`: title ink, underlined on hover, for a
  row's name that opens its details.
- `CliModelPickerButton` takes `host.listChatRuntimes()` as is;
  `CliRuntimeOption[]` still works. Its doc no longer names the nonexistent
  `listAgentRuntimes()`.
- `SurfaceRail`'s `newAffordance` is optional, and every row field, `scope`,
  `search`, `filter` and `groups` is documented — including when a row is
  "rich" and that `scope` lives inside the filter menu as "Project".
- `THEME_TOKENS` adds `--chart-1` … `--chart-8` and `--chart-other`: ordered
  categorical series colours, never status, at 3:1 or better against
  `--bg-surface` in every theme and separable under common colour-vision
  deficiencies.

### Changed: shell surfaces

- `registerSidebarNavEntry` rows are drawn in the Extensions drawer as their
  door's row; an entry whose id names none of the module's global surfaces is
  not drawn. The sidebar's top-nav cluster they were documented for no longer
  exists.
- An installed module may register a notification action provider only for
  its own module id.
- The `global-surface` template no longer registers a nav entry: the door's
  drawer row is the way in.

<!-- End of shell surfaces, notifications and the renderer host. -->

<!-- Main-host plumbing: settings, workspaces, storage, GitHub, skills, MCP. -->

### Added

- **Settings in `entry.main`.** `MainHost.getModuleAppState(key)` and
  `watchModuleAppState(cb)` read the module's app-level state — what its
  Settings section writes — from a persisted copy main keeps, so a scheduler or
  poller sees the person's choices with no window open. Read-only.
  `supports('main-app-state')`.
- **Workspaces.** `WorkspaceContextService.list({ includeClosed: true })` adds
  the workspaces closed on this machine (`ModuleWorkspaceListEntry`, with
  `open` and `closedAt`); `supports('workspace-history')`.
  `getWorkspaceGitInfo(workspaceId)` on `MainHost` and `RendererHost` answers
  the branch and remotes, each with `owner/repo` for GitHub, SSH host aliases
  resolved; checked against `ipc:workspace-read`. `supports('workspace-git-info')`.
- **Storage.** `list({ prefix })`, `getMany({ keys })`
  (`supports('storage-query')`) and `watch({ workspaceRoot? }, cb)` with
  `ModuleStorageChange` (`supports('storage-watch')`).
  `MainHost.getModuleDataDir()`: a per-module directory under user data for
  data past the 1 MB value limit, removed at uninstall
  (`supports('module-data-dir')`). `MainHost.getAssetPath(relative)`: the
  main-side twin of `getAssetUrl`, verified files only — worker threads loaded
  from module files are supported (`supports('main-asset-path')`).
- **GitHub broker.** Allow-listed response `headers`, `ifNoneMatch` (a 304 is
  an answer) and `accept` (`ModuleGitHubMediaType`) — `supports('github-headers')`;
  read-only `graphql(query, variables)` — `supports('github-graphql')`;
  `download(request)` following GitHub's storage redirect with the token
  stripped — `supports('github-download')`. New error codes `invalid_query`
  and `redirect_not_allowed` (`ModuleGitHubErrorCode`).
- **Skills.** `MainHost.getSkillStatus(workspaceRoot, skillId)` checks without
  writing; `ModuleSkillStatus` is the exhaustive status vocabulary, including
  `delivered-at-launch`, `missing` and `update-available`.
  `supports('skill-status')`.
- **MCP.** `McpConnectionMetadata.verified`: true when a launch token or the
  tailnet transport proved the caller; always set on a module tool's context
  by a host that `supports('mcp-verified-identity')`.

### Changed

- A module MCP tool whose name collides with a core gateway tool (compared as
  clients file it: `a.b` and `a_b` are one name) or falls in a shell tool
  family is now a registration error naming the conflict; it used to be
  skipped with a log warning. Module-vs-module collisions use the same
  comparison.
- `EnsureSkillInstalledResult.status` is typed `ModuleSkillStatus` instead of
  `string`.
- `ModuleGitHubResponse`'s ok branch carries `headers`, and an `http_error`
  may.
- `WorkspaceContextService.list()` answers `ModuleWorkspaceListEntry[]`
  (each view plus `open`).

### Added

- **`module:bridge`**, the permission for the renderer → own `entry.main`
  bridge alone (`RendererHost.invoke` to the module's own `registerIpc`
  channels). Its consent line reads "Let its window code talk to its own
  background code", where `ipc:invoke`, which a module needed for the same
  thing, reads "Call any of the app's internal APIs … (broad scope)". The
  bridge accepts either, so an existing manifest keeps working; the
  `chat-companion` template, the docs and the smoke test use `module:bridge`.
- **`@sprintengine/module-sdk/testing`**, for testing a module in Node
  without the app:
  - `createFakeMainHost({ moduleId, permissions } | { manifest }, …)`: a
    `MainHost` with stateful fakes of every published service, held to the
    host's rules — storage's key pattern, absolute-root rule and 1 MB cap;
    chats with ownership, the preset ceiling, `commandId` receipts and
    `services.conversations.emitEvent`; scheduled agents (`fire`); companions
    (`respond`); secrets (https, origins, redaction); GitHub with scripted
    answers; workspaces (`setHydrated(false)` for the after-launch null). The
    permissions the host checks are refused as it refuses them
    (`permission_missing`, or a throw); disclosure-only ones used undeclared
    are listed in `undeclared`. `ipc.invoke` calls the module's channels as its
    renderer would (own channels, `module:bridge`, structured cloning) and
    `tools.call` its MCP tools as an agent would.
  - `createFakeRendererHost({ …, main? })`: records every registration,
    renders a registered door, modal, panel, settings section, top-bar item or
    nav entry to HTML, runs commands, and bridges `invoke` and `subscribe` to
    a fake main host.
  - `installTestingKit()`, `renderToHtml(node)`, and two more subpaths:
    `/testing/kit` (a stand-in for `/ui`, `/surface` and
    `@monaco-editor/react` whose components draw their props and children, so
    a door renders in Node) and `/testing/register` (for
    `node --import`, installing the kit before any test file loads).
  - The fakes cover every API above: the Backlog, usage and activity services
    (`services.backlog` / `usage` / `activity`, with their permissions
    checked); storage `list({ prefix })`, `getMany` and `watch`; GitHub
    headers, `ifNoneMatch`, read-only `graphql` and `download`; closed
    workspaces and git info; `getModuleAppState` / `watchModuleAppState`,
    `getModuleDataDir`, `getAssetPath` and `getSkillStatus` in main; and
    `toast`, `openExternal`, `moduleId`, the active workspace,
    `setSurfaceView`, the command context and notify `target` in the
    renderer, with stand-ins for the new kit components.
  - And the agent and conversation APIs: a text-generation fake
    (`services.textGeneration`, `agents:generate` checked, `busy` and
    `unsupported` as the host answers them); companion `tools` with
    `requestApproval` and `respondToApproval`; conversation `reply`,
    `create({ worktree })`, turn ids on turn events and `restore` for a
    chat a subscribe or follow was waiting for; scheduled-agent `name`,
    `tag`, `onRun` and run chats the module owns; `MainHost.listChatRuntimes`;
    and `openChat`'s `name`, `dedupeKey` and `chat:draft` rule.
- **`MODULE_SERVICE_REQUIREMENTS`** (with `moduleServiceRequirement`,
  `dependsOnReaches`, `MODULE_DEPENDENCY_CHAINS`): for each service a module
  may resolve, the permission it needs, the module that provides it, and
  whether the host checks it. The smoke test and the fakes read it.
- **Composable templates.** `sprintengine-module init … --with main,mcp,settings,door`,
  and `sprintengine-module add <part>...` in an existing project (`addModuleParts`
  and `listModuleParts` from `./scaffold`). A part copies its files and test,
  merges its entry, permissions and `dependsOn` into the manifest and
  `plugin.json`, adds its build script and dependencies, and wires its
  registration into `registerRenderer` / `registerMain`.
- **A TypeScript test pattern in every template.** `test/*.test.ts`, bundled by
  `npm run build:test` (esbuild, into the ignored `test/.build/`) and run by
  `npm test` with `node --test` and `--import @sprintengine/module-sdk/testing/register`,
  on any Node the SDK supports. Each template ships tests of its own.

### Changed

- **The scaffold's smoke test runs the module against the SDK's fake hosts**
  instead of a recorder that answered every call with a no-op. It checks
  permissions and `dependsOn` from `MODULE_SERVICE_REQUIREMENTS` (the old copy
  still named the removed automations service and never checked the workspace
  context or scheduled agents' `dependsOn: ["scheduled-agents"]`), and it
  renders everything the renderer registers, so a door that throws while
  rendering fails `npm run check`. `test/host-kit-fake.mjs` is gone; the
  templates add `react-dom` for the render.
- **`npm run build` writes `module/manifest.json` only when the file digests
  changed**, and signs again only when the signature no longer covers the
  manifest, so a rebuild of unchanged code leaves git clean. The build still
  records the digests (not only `dev:install`), because a GitHub install reads
  the committed manifest and refuses one that does not describe the committed
  `module/dist/`. `npm run build` runs `build:renderer` and `build:main` when
  they exist.
- **The extension-builder skill is kept once in a project**, in
  `.agents/skills/sprintengine-extension-builder/`; `.claude/skills/…/SKILL.md`
  is a pointer with the same name and description
  (`extensionBuilderSkillPointer`, `EXTENSION_BUILDER_SKILL_DIR`,
  `EXTENSION_BUILDER_SKILL_POINTER_DIR`). `npm run validate` fails when the
  pointer's front matter no longer matches, or, in a project with two full
  copies, when they differ.
- The `panel` and `top-bar-item` templates render outside a window: the panel
  inserts its stylesheet in `useInsertionEffect`, and both give
  `useSyncExternalStore` its server snapshot.

### Agents, conversations and scheduled agents

Additive: host API 1 still. Each item has a `host.supports(...)` answer, named
beside it.

#### Changed

- **A companion's structured run no longer approves its agent's tool calls.**
  `runStructured` takes `tools: 'none' | 'ask' | 'auto'`, default `'none'`:
  every approval the agent raises is denied, and the agent is told before the
  prompt that it has no tools. `'ask'` leaves approvals open for the person,
  relayed with the new `handle.respondToApproval({ requestId, decision })`
  (allowing needs `conversation:operate`); `'auto'` approves them all and
  needs `conversation:bypass` (refused without it). Companion sessions start
  on `manual`, so every tool asks. A module that relied on the old
  auto-approve passes `tools: 'auto'` and declares `conversation:bypass`.
  `engine.cli` also takes a chat runtime id (`claude-code`) beside a provider
  id (`claude-agent`). `companion-tools`.
- **`subscribe` and `follow` no longer throw `not_owned`** for a chat the host
  has not loaded yet (a saved chat at startup): they attach and deliver once
  it is known. A ref to anything not the module's delivers nothing. They throw
  only without `conversation:read` or for a malformed ref or cursor.
- **`openChat` drafts need only `chat:draft`.** `send: true` still needs
  `conversation:operate`.

#### Added

- **`turn_completed` carries `text` and `usage`.** `text` is the agent's last
  message of the turn; `usage` is `{ inputTokens, outputTokens,
  cacheReadTokens, cacheWriteTokens }` summed over the turn, fresh input
  apart from the prompt cache's share, a count the runtime cannot report left
  out (`ModuleConversationTurnCompletedPayload`,
  `ModuleConversationTurnUsage`). Claude Code, Codex and ACP agents report
  them. `reply(ref, turnId?)` reads a finished turn's text off the transcript;
  `no_reply` joins the error codes. `conversation-replies`.
- **`getTextGenerationService(host).generate({ prompt, system?, model?,
  maxOutputTokens?, json?, cli? })`**: one prompt answered by the person's own
  agent CLI (`claude-code` or `codex`; absent, the runtime and model they chose
  for Studio's text generation, else Claude Code) with no workspace or chat,
  as `{ ok, text, usage, model }` or a typed failure. `maxOutputTokens` is
  honoured by Claude Code and ignored by Codex, which has no output cap. New
  permission `agents:generate`. Each module gets two calls at once and eight waiting, and
  thirty a minute. `text-generation`.
- **`create({ worktree: { name? } })`** starts a chat in a fresh worktree of
  the project, in a workspace of its own; `worktree_unavailable` joins the
  error codes. `conversation-worktrees`.
- **`openChat({ name, dedupeKey })`**: the chat's title, and a key that
  focuses the chat this module already opened under it (`existing: true`)
  instead of opening another; `invalid_input` joins its failures. New
  permission `chat:draft`. `chat.open-options` (renderer).
- **`MainHost.listChatRuntimes()`**, the renderer's list from `entry.main`,
  with missing runtimes `available: false`. The runtime id is documented as
  the one id every `cli` takes. `chat-runtimes`.
- **Scheduled agents can be traced.** `name` (the sidebar's title) and `tag`
  (your own label) on `ScheduledAgent` and its draft (an update without them
  keeps them); `lastRun.agentId`; `onRun((agent, run) => …)`, which also hears
  a one-time schedule's run before it closes; and `scheduledAgentId` /
  `scheduledAgentTag` on a run's `ModuleConversationSummary`. The type docs
  say what happens to a missed time. `scheduled-agent-runs`.
- **`ScheduledAgent.pausedAt`**: when the person paused a scheduled agent in
  the app, absent while it runs. A paused one (or any, while the person has
  paused them all) has `nextRunAt: null`, starts nothing at its times, and
  does not make them up when resumed; `runNow` still runs it. Read-only to a
  module, and absent on an older host.

### Breaking: removed

- **The `automation` bundle component.** Automations became scheduled agents,
  which an extension creates at runtime rather than ships as a file. A
  `plugin.json` that declares `components.automation` no longer validates: the
  app refuses it at verify, download and install with the reason, and
  `plugin scaffold` no longer offers the kind. `MARKETPLACE_COMPONENT_KINDS` is
  `mcp`, `skills`, `module`.
- **Automations.** `registerAutomationTrigger`, `registerAutomationAction`,
  `getAutomationsService` and every `Automation*` type, the
  `automations.manage` permission, the `automations` host capability, the
  `automationsEnabled` command availability and the `automation-trigger`
  template. A module schedules work with scheduled agents instead (below):
  custom trigger and action kinds have no replacement, because a scheduled
  agent's only trigger is its schedule and its only action is starting a chat.

### Added

- **`context_handed_off`** joins `ModuleConversationEventType`: the chat was
  handed off to a fresh session of its CLI instead of being compacted. Its
  payload names the file its messages were saved to (`path`), the context the
  old session held (`preTokens`) and that the next message still carries the
  pointer to the file (`seedOwed`).
- **`turn_retrying`** joins `ModuleConversationEventType`: a model call in
  the turn failed and the provider will try it again. The payload carries the
  attempt, the attempt limit, the wait before it and the failure's category.
- **Scheduled agents.** `getScheduledAgentsService(host)` creates, updates,
  removes, lists and runs the module's own scheduled agents — a prompt and a
  cron schedule, each run a new chat in the project — and tells the module
  when they change. Declare `scheduled-agents.manage` and
  `dependsOn: ["scheduled-agents"]`; `host.supports('scheduled-agents')` says
  whether the host in front of the module provides it.
  A scheduled agent's `permissionPreset` is any of the four modes a chat
  takes (`bypass`, `auto`, `manual`, `none`), or null to follow the person's
  choice at run time.
- **Conversation streams.** `host.supports('conversation-streams')` says the
  host takes both:
  - `follow(ref, cursor, onFrame)`: a snapshot, or only the events after a
    cursor (`afterSeq` and `generation`) the log can vouch for, then a
    `synchronized` fence, then live events (`ModuleConversationStreamFrame`).
  - `commandId` on `create`, `send`, `interrupt`, `respondToApproval`,
    `answerQuestion`, `resolvePlan`, `setPermissionPreset` and `setModel`
    (`ModuleConversationCommandOptions` for the ones that take options): a
    retry is answered with the first call's result and never carried out
    twice, and a retried `create` answers with the chat the first one made.
- **Typed answers.** `host.supports('conversation-requests')`:
  `answerQuestion(ref, { requestId, answers })` and
  `resolvePlan(ref, { requestId, decision: 'approve' | 'reject' })`, each
  refused for a request of another kind. On an older host `answerQuestion`
  answers through `respondToApproval`, as such a host took a question's
  answers, and `resolvePlan` is refused naming the capability.
- **CLI modes and allowed tools.** `host.supports('conversation-permissions')`:
  `permissionMode` beside the preset on `create`, `setPermissionPreset` and
  the summaries, and `allowedTools` on `create`, which needs
  `conversation:bypass`.
- The event, page, frame and decision types restate
  `@sprintengine/conversation-protocol` exactly; the drift guard pins them to
  the package. The SDK still has no dependencies.
- **Conversation controls.** `host.supports('conversation-controls')` says the
  host takes all of these:
  - `create` takes any of the four presets (`none`, `manual`, `auto`,
    `bypass`), and `ModuleConversationPermissionPreset` names all four.
  - `setPermissionPreset(ref, preset)` switches a conversation's preset from
    its next tool call, and `setModel(ref, modelId)` switches it to another
    model of the same agent runtime from its next turn: an id the runtime's
    picker lists, or `default`. Both answer with what is now in force and the
    runtime's `notice` when the change applies later than at once, and both
    move the conversation's record, so its next session starts on them.
  - `respondToApproval` takes a `decision`: `once`, `conversation` (allow
    requests of its kind for the rest of the conversation) or `deny`
    (`ModuleConversationApprovalDecision`). `approved` still works, as `once`
    or `deny`. No answer makes a permanent rule.
  - `ModuleConversationSummary.permissionPreset` names the preset a
    conversation runs on.
- **The `conversation:bypass` permission.** A module's conversations run no
  looser than `auto` unless its manifest declares it.

### Changed

- **`bypass` needs `conversation:bypass`.** A module that asks for `bypass`
  without declaring it gets `auto`, on `create` and on `setPermissionPreset`:
  lowered, not refused, and the answer names the preset in force. Before,
  `conversation:operate` alone started a conversation on `bypass`.
- **`voice-dictation` is retired.** The bundled voice dictation module is
  removed from the app, along with its top-bar control, its
  `voice-dictation.toggle` command and its settings section. The id stays in
  `BUNDLED_MODULE_IDS`, reserved, so no third-party module can install under
  it.

### Fixed

- **A kit tooltip goes away once its control has been used.** It opens on
  `:focus-visible` rather than any focus, and pressing the trigger or the app
  losing focus dismisses it. `TooltipChildProps` gains `onPointerDown`, which a
  glyph that forwards the tooltip's handlers to its host element now forwards
  too. A focus the pointer last steered (a dismissed surface handing focus
  back to the control that opened it) does not open it either.
- **`npm run keygen` on Windows.** The templates' `keygen` script wrote the key
  under `$HOME`, which `cmd.exe` (where npm runs scripts on Windows) does not
  expand. It passes `~/.sprintengine/keys/<id>.key`, and `keygen --out`
  expands a leading `~` to the home folder itself.

## 1.0.0-beta.0

The first beta of the contract 1.0 will ship: modules reach the
app's agents **as chats**, declare the host API they were built for, sign their
code as well as their manifest, and install from a folder, from GitHub or from
the marketplace. This entry covers everything since 0.5.0 and replaces the
unreleased notes that were kept while the contract moved; where those notes
described an API added and removed again before release (per-launch terminal
contributions, host-run Python), this release has neither.

The package was renamed with the app: it is `@sprintengine/module-sdk`, and a
module must change every import, including the `--external:` flags for
`@sprintengine/module-sdk/ui` and `@sprintengine/module-sdk/surface`.

### Breaking: removed

- **Terminal agents.** A module no longer launches, types into, watches or
  names agent terminals. Removed: `getAgentSessionService` with
  `ModuleAgentSessionService`, `ModuleAgentSessionRecord`,
  `ModuleAgentSpawnRequest`, `ModuleAgentSpawnResult` and
  `ModuleAgentExitEvent`; `RendererHost.spawnAgent`,
  `RendererHost.watchAgentSessions`, `RendererHost.registerAgentIdNamespace`
  and `RendererHost.listAgentRuntimes` with `ModuleSpawnAgentInput`,
  `ModuleSpawnAgentResult`, `ModuleAgentSessionView`,
  `AgentIdNamespaceDefinition`, `ModuleAgentRuntimeOption` and
  `ModuleAgentRuntimeModelOption`. Use the conversation service and
  `openChat` (below).
- **Permissions `ipc:agents` and `agents:session`.** Declare
  `conversation:read` / `conversation:operate` for chats and `mcp:tools` for
  gateway tools. A manifest that still lists either shows it as an
  unrecognised capability.
- **`MainHost.ipcMain`.** Register handlers with `registerIpc`.
- **Agent CLI plugins.** `validateCliPluginManifest`, `parseCliPluginManifest`
  and every `Cli*` manifest type leave the SDK: agent runtimes ship with the
  app, and nothing a user installs adds or replaces one. `cli` is no longer a
  `MarketplaceComponentKind`, and `plugin scaffold --component cli` is gone.
- **`BacklogItemView.kind`.** The host no longer guesses a plan kind. Read
  `item.type`, or `item.relativePath` for the file's format.
- **Vocabulary nothing produces any more:** `LifecycleState` loses `review`,
  `testing`, `product`, `changes_requested`, `recorded`, `approved_auto`,
  `done_unmerged` and `done_merged`, and `WorkspaceRunGlyphState` loses
  `review` (map onto `in_progress`, `needs_input` or `done`);
  `CommandAvailability` loses `sprintengineWorkspace`,
  `sprintengineHasArchitect`, `sprintengineFocusAgentVisible` and
  `sprintEngineEnabled`; `BacklogItemLink` loses `target.taskId` and
  `priorStatus`; `CliModelPickerButtonProps` loses `noneOption`;
  `McpConnectionMetadata` loses `sprintRunId`; `ActionContext.spawnAgent`
  loses `specialistId`.

### Breaking: changed

- **`engines.hostApi` is required** on a third-party manifest. A module
  without it, or built for a host API outside the app's supported range, is
  refused with a message saying which side to update. The CLI's `sign`,
  `verify` and `pack` check it too.
- **A module needs `files` to load.** `CapabilityManifest.files` maps every
  file the module ships (POSIX path → lowercase sha256, `manifest.json` aside).
  `sprintengine-module sign` writes it before signing, so the signature covers
  the code; `verify` and `pack` fail when the folder no longer matches. The app
  refuses a changed, missing or extra file as tampered, trusts a signed module
  by key only when it carries `files`, and binds a person's trust grant to a
  fingerprint that covers them. **Sign existing modules again.**
  `MarketplacePluginAuthoringManifest` omits `files`: a bundle's digests live
  per component.
- **`focusTab` takes `kind: 'chat' | 'file'`.** `'agent'` is gone; a chat is
  focused by its agent id.
- **`MainHost.registerMcpTools` requires `mcp:tools`**, and a third-party tool
  counts as changing state unless it declares `mutates: false`.
- **Automations run their agents as chats.** `ActionContext.spawnAgent` takes
  `model` (was `cliModel`) and `skills`, and resolves with the chat's
  `sessionId`; the run finishes when that chat's turn completes or fails.
  `AutomationRun.executionId` is now `AutomationRun.sessionId`.
- **A sidecar is a declaration.** The host lists a `registerSidecar` spec and
  spawns nothing; `SidecarSpec.kind` no longer suggests Python.
- **The previous app name is gone from every contract:** the import map
  answers only `@sprintengine/module-sdk`, the panel-command event is
  `sprintengine:panel-command`, the CLI binary is `sprintengine-module`, and
  the drop-in roots are `~/.sprintengine/modules` and `~/.sprintengine/plugins`.
- The package requires Node 22.15 or newer, as the templates do.

### Added

- **Host API version.** `HOST_API_VERSION` (1), `HOST_API_MIN_SUPPORTED` (1),
  `checkHostApiCompatibility`, `HostApiCompatibility`, and
  `CapabilityManifest.engines`. Both hosts carry `hostApiVersion` and
  `supports(capability)` with the `HostCapability` names `conversations`,
  `chat.open`, `companion-agents`, `automations`, `secrets`, `github`,
  `storage`, `mcp-tools`, `skills`, `module-assets` and `notifications`.
- **Chat conversations.** `getConversationService(host)` creates, sends to,
  steers, interrupts, approves for, stops, subscribes to, replays, lists and
  watches the chats a module owns — only its own. Types:
  `ModuleConversationService`, `ModuleConversationCreateInput`,
  `ModuleConversationEvent`, `ModuleConversationEventType`,
  `ModuleConversationRef`, `ModuleConversationSummary`,
  `ModuleConversationStatus`, `ModuleConversationImageAttachment`,
  `ModuleConversationPermissionPreset`, `ModuleConversationErrorCode`,
  `ModuleConversationResult`. Permissions `conversation:read` and
  `conversation:operate`.
- **Opening a chat for the person.** `RendererHost.openChat` (a drafted prompt
  by default, `send: true` to send it) and `RendererHost.listChatRuntimes`,
  with `ModuleOpenChatInput`, `ModuleOpenChatResult` and
  `ModuleChatRuntimeOption`.
- **Brokered credentials.** `getSecretsService(host)` (permission `secrets`):
  a stored value only ever leaves the host inside a request to an https origin
  it was stored with. `getGitHubService(host)` (permission `github`): the GitHub
  API with the person's sign-in, token never shown. Types:
  `ModuleSecretsService`, `ModuleSecretFetchInit`, `ModuleSecretFetchResult`,
  `ModuleSecretsError`, `ModuleGitHubService`, `ModuleGitHubRequest`,
  `ModuleGitHubResponse`.
- **Opening a module's own surfaces.** `RendererHost.openGlobalSurface(id)` and
  `RendererHost.openModalSurface(id)`; each opens only a surface the calling
  module registered.
- **Async registration.** `RegisterMain` and `RegisterRenderer` may return a
  promise; the host waits for it (bounded) and fails the module alone on a
  rejection.
- **Templates and `sprintengine-module init`.** Eleven starter projects
  (`blank`, `panel`, `global-surface`, `top-bar-item`, `settings-section`,
  `workspace-type`, `backlog-action`, `file-action`, `mcp-tools`,
  `automation-trigger`, `chat-companion`), each building, testing and
  side-loading out of the box, with `plugin.json` at the project root pointing
  at `module/`. `@sprintengine/module-sdk/scaffold` exports the scaffolder
  (`scaffoldModuleProject`, `listModuleTemplates`).
- **The `sprintengine-extension-builder` skill**, shipped in the package and
  copied into every scaffolded project, for the agent that builds the
  extension.
- **File digests for tooling:** `ModuleFileDigests`,
  `validateModuleFileDigests`, `compareModuleFileDigests` and
  `isPackExcludedPath` from the root; `computeModuleFileDigestsSync` and
  `moduleFileDigestIssuesSync` from `./signing`.
- **Renderer contributions:** `registerFileAction` (Files-tree actions),
  `registerNotificationActionProvider` (Open actions for bell rows),
  `registerDoorBadge` (a row's waiting count), and on
  `WorkspaceTypeDefinition` `hiddenFromRail`, `createLabel`, `RowMark`,
  `rowActions` and `openOnFirstLoad`, with `RendererHost.openWorkspace(typeId)`.
- **Packaged web runtimes.** `RendererHost.getAssetUrl` serves an installed
  file from a stable, private `studio-module:` origin.
- **Automations provider metadata.** `label`, `glyph`
  (`AUTOMATION_PROVIDER_GLYPHS`), `summary`, and a trigger's `pairsWith`.
- **Sidecar handles.** `registerSidecar` returns a `SidecarHandle`
  (`start`, `stop`, `status`), with `SidecarRunState`, `SidecarStartOptions`
  and `SidecarRuntimeStatus`.
- **UI kit:** `PanelHeader`, `LifecycleGlyph`'s `style`, `SegmentedControlItem`'s
  `badge`, and the button and input prop building blocks (`ButtonBase`,
  `SizedButtonProps`, `ButtonComponent`, `SharedInputProps`) are exported.
- `CompanionAgentEvent.seq`.

### Behaviour

- `RendererHost.invoke` routes to any module that declares `ipc:invoke`.
- Backlog item actions render in the row's menu and the detail header's
  More-actions menu, ordered by `order`.
- A new renderer-only module loads as soon as it is trusted; `entry.main` and
  updates to loaded code still take a restart.
- A third-party module resolves only the services the SDK publishes.

## 0.5.0 — 2026-09-10

- **An MCP tool can say that it writes.** `McpToolRegistration.mutates?: boolean`.
  The Studio gateway used to classify mutations from a table of core tool names,
  which a module's tool could never be in — so a module tool that wrote to disk
  was served to a remote caller holding only the read scope, and left no audit
  entry. Declare `mutates: true` and the gateway requires `<family>:operate`
  from a tailnet caller and records every call, refusals included. Omitted means
  a read, as before.
- **The host's UI kit, door shell and Monaco are bridged to modules**
  (Reviews-extraction ruling D6, 2026-09-10). A module that wanted to look like
  the app had two options, both bad: re-implement the chrome a shade off, or
  bundle a second copy of React-dependent components and break hooks. Two new
  subpath entry points now publish the app's own pieces —
  `@sprintengine/module-sdk/ui` (`GhostButton`, `OutlineButton`, `PrimaryButton`,
  `Banner`, `Drawer`, `EmptyState`, `Field`, `Input`, `Textarea`,
  `InlineNotice`, `KbdChord`, `LifecycleGlyph`, `LinkButton`, `RowButton`,
  `Section`, `SegmentedControl`, `Select`, `Spinner`, `StatusDot`,
  `TruncatedText`, `CliModelPickerButton`, `FOCUS_RING_CLASS`) and
  `@sprintengine/module-sdk/surface` (`GlobalSurfaceShell`, `useSurfaceBackNav`,
  `SurfaceRail`, `SurfaceCanvasState`) — alongside `@monaco-editor/react`,
  which the host has always shipped and now answers for modules too. All three
  join `react` and friends in the import map the host installs before it
  evaluates an `entry.renderer` bundle, so there is one React, one Monaco and
  one kit in the process.

  Both subpaths ship TYPES ONLY: their runtime is a stub that throws
  `"@sprintengine/module-sdk/ui is provided by the host at runtime; mark it
  external in your bundler"`, so forgetting the external is a loud failure at
  load rather than a silent second React. Add
  `--external:@monaco-editor/react --external:@sprintengine/module-sdk/ui
  --external:@sprintengine/module-sdk/surface` to your bundle.

  Two things this does NOT give you. Tailwind utility classes written inside a
  module compile to nothing — the app's Tailwind build scans app source only —
  so a module that writes its own classes must ship a utilities-only stylesheet
  (README shows the four-line entry). And the published list is short on
  purpose: it is a versioned contract pinned in both directions by the drift
  guard, so a component that is not on it is cheaper copied into your module
  than frozen here forever.
- **A modal surface contributes the row that opens it** (D7, 2026-09-10).
  `ModalSurfaceDefinition.launcher = { label, letter, Glyph }` puts your
  surface in the workspace pane's kind list — the strip's "+" menu and the
  pane's empty-state launcher, beside Browser, Terminal, Files, Diff, Git and
  Backlog. It is the one trigger the shell draws for a modal, and it exists
  because Reviews was hard-coded into that list: the entry above says
  "contribute that trigger yourself", which a module reaching for the pane
  could not do. `letter` must be exactly one character (uppercased for you) and
  a malformed launcher is a registration error. The shell's own kinds win a
  letter collision, as does an earlier-registered module: the losing row keeps
  its label and glyph and simply has no shortcut, rather than taking a key the
  person already knows.

- **A modal body is told which workspace opened it.** `Component` is now
  `ComponentType<{ workspaceId?: string }>` (`ModalSurfaceComponent`), and the
  shell passes the workspace its opener acted from — for a pane row, the
  workspace the row was picked in. A modal floats over the window rather than
  mounting inside a workspace card, so it had no way to know what it was acting
  on but "the active workspace", which can change under an open modal. A
  zero-prop component still satisfies the type, so an app-level surface needs
  no change.

- **The open workspaces, not just one.** `RendererHost.listWorkspaces()` and
  `watchWorkspaces(cb)` return the same `ModuleWorkspaceView` rows
  `getWorkspace` resolves, for a surface that is not mounted inside any one
  workspace and so has no id to ask about. The watch fires once with the
  current list, then on change (deduped by value). Declare
  `ipc:workspace-read`. Empty — never a throw — before the shell wires
  workspace state.

- **`RendererHost.watchColorScheme(cb)`** reports the app's resolved
  `'light' | 'dark'` immediately and on every change (an explicit theme switch,
  or an OS switch while the preference follows the system). For a themed
  runtime you HOST and must hand a concrete value — Monaco's base theme, a
  chart palette. Ordinary module UI should keep reading `THEME_TOKENS` and
  re-skin without JavaScript. New published type: `ModuleColorScheme`.

- **`watchAgentSessions` takes `undefined` for "every workspace"**, narrowed to
  the agent-id namespaces your module claimed with `registerAgentIdNamespace`.
  A module whose `entry.main` spawns agents without a window's knowledge had no
  workspace id to watch and no way to follow them; this is that watch. Claim no
  namespace and the unscoped call reports an empty list — it is never a window
  onto other modules' sessions. A workspace id behaves exactly as before.

- **`listAgentRuntimes()` answers what a picker needs.**
  `ModuleAgentRuntimeOption` widens from `{ id, label }` to
  `{ id, label, available, models, isDefault }` (`models` being
  `ModuleAgentRuntimeModelOption[]` — the manifest, discovered and user-added
  ids merged, exactly the rows the shell's own model picker shows). A module
  building a CLI + model picker previously had ids and labels and nothing else
  to preselect or disable with.

- **`THEME_TOKENS` gains `--motion-normal` and `--motion-ease`** — the app's
  standard transition duration and easing, guaranteed in every theme by the
  same per-theme repo gate as the rest. Use them as a pair
  (`transition: opacity var(--motion-normal) var(--motion-ease)`) so module UI
  moves at the app's pace instead of inventing its own.
- **`plugin scaffold` and `plugin sign` write components in canonical order,
  and print the `provides` array to paste.** A registry entry's `provides` must
  equal the component kinds the app derives from the bundle, and the app derives
  them by filtering `MARKETPLACE_COMPONENT_KINDS` (`mcp, skills, module, cli,
  automation`) — so an author who typed `--component cli --component mcp`, or who
  hand-wrote `plugin.json`, read one order out of their own file and the
  downloader computed another. The mismatch surfaced as a registry-mismatch
  failure on the user's machine, naming two lists that look the same. Both
  writers of `plugin.json` now key `components` canonically before the manifest
  is signed, and `plugin scaffold`, `plugin sign` and `plugin verify` each end
  with a `Registry entry "provides": [...]` line that is the exact array the
  registry entry needs.
- **Agent sessions: a module can own an agent TERMINAL** (`getAgentSessionService(host)`,
  new scope `agents:session`). A module's `entry.main` had two doors to an agent
  and neither fits a long-lived working one: the companion service drives a
  conversation-runtime session (no pty, no tab, no CLI of the user's choosing),
  and `ipc:agents` discloses a renderer surface main-side code cannot reach.
  The third door is the one the in-tree review guide always actually used — an
  ordinary agent terminal, spawned in the workspace the module's surface was
  opened from, under the user's CLI, permission default, runtime overrides, MCP
  and knowledge graph, with a skill attached at spawn. `spawn` (fresh, or
  `reused: true` when a live session already answers to the same agent id),
  `send`, `kill`, `setReapExempt`, `onExit`, `list`. New types:
  `ModuleAgentSessionRecord`, `ModuleAgentSpawnRequest`, `ModuleAgentSpawnResult`,
  `ModuleAgentExitEvent`, `ModuleAgentSessionService`.

  Scoping is by agent-id prefix: name your agents `${agentIdPrefix}${agentIdKey}`
  under a namespace you registered, and `list()` answers for those and nothing
  else. Every method checks `agents:session` at runtime — the third scope that
  is genuinely gated, alongside `ipc:invoke` and `agents:companion`.

  *Known limitation.* Agent-id namespaces are registered on the RENDERER host and
  main holds no mirror of that registry yet, so main cannot verify that a prefix
  is one you registered. Until it can, a prefix is validated as non-empty and
  ownership falls back to "prefixes this module has spawned under in this
  process" — sound (no module can reach another's agents) but forgotten across a
  restart, so `list()` may under-report sessions spawned before one.

- **`WorkspaceContextService.list()`.** `WorkspaceContextToken` could resolve one
  workspace id and had no way to enumerate them, so an MCP tool a module
  contributes — which runs with no window and no renderer to ask — could not
  answer "which project roots are open". `list(): Promise<ModuleWorkspaceView[]>`
  is the main-side twin of `RendererHost.listWorkspaces`.
- **A module can ship its own skills** (`MainHost.registerSkills`,
  `MainHost.ensureSkillInstalled`). Skills used to be a closed set compiled
  into the app, so a module that wanted an agent to run with its own skill had
  no way to say so — it could spawn an agent and name a skill that was never
  copied anywhere. `registerSkills([{ id, sourceDir, targetPolicy,
  description }])` hands the host a directory inside your module root
  (resolved and containment-checked; a rootless bundled module passes an
  absolute path) and the host then treats it exactly as it treats its own:
  same check-first install, same managed manifest, same `'all-native'` fan-out
  into every installed CLI's native skill directory, and the same resolution
  at the agent-launch boundary. Ownership matches `registerMcpTools` — an id a
  built-in or another module holds throws, the batch is validated before one
  skill of it lands, and unloading the module unregisters its skills.
  `ensureSkillInstalled(workspaceRoot, skillId)` pre-installs one on demand
  and never throws; an id nothing answers to now returns
  `{ ok: false, status: 'unknown-skill' }` (and is logged by the app's launch
  path) where it used to be a silent no-op. New mirrored types:
  `ModuleSkillRegistration`, `ModuleSkillTargetPolicy`,
  `EnsureSkillInstalledResult`.

- **A door surface names and places itself** (Extensions drawer ruling,
  2026-09-05). `GlobalSurfaceDefinition` was `{ id, Component }` while the host
  grew five presentation fields around it, so an SDK module could register a
  door and then have no way to say what it is CALLED — the shell's chrome fell
  back to a capitalised id. All five are mirrored now, all optional, and a door
  that draws its own row through `registerSidebarNavEntry` may still omit every
  one: `label` (the drawer row's name, the bar's fallback title, the "not
  installed" explainer's heading), `Icon` (the glyph any chrome that names the
  surface draws), `onOpen` (runs just before a PLAIN open — a rail glyph, a
  drawer row, a history step — for discarding stale deep-link latches),
  `views` (several drawer rows for one surface that is several destinations to
  the person, each with its own label, glyph and `open()`), and `railPlacement`
  (`'sidebar'`, the default, replaces the app sidebar's column for the length of
  the visit; `'inline'` renders your rail beside your own canvas and leaves the
  column alone — right when the column already holds the navigation that reached
  you). New mirrored types: `SurfaceIconComponent`, `SurfaceViewDefinition`,
  `SurfaceRailPlacement`.

- **`roadmap` leaves `BUNDLED_MODULE_IDS`.** The app retired the module when
  Horizon did and the SDK's copy of the reserved list did not follow, so the
  SDK went on telling third parties that an id nothing ships was unclaimable.
  Caught only now because the drift guard's type pins were failing first and
  the runtime assertion below them never ran.

- **Modal surfaces no longer get a trigger, and the docs stop promising one**
  (Extensions drawer ruling, 2026-09-05). The 2026-09-01 entry below says the
  shell renders your trigger as a glyph button in the sidebar footer's settings
  cluster. It does not: that ruling was reversed four days later — every
  destination the shell's own chrome offers is a DOOR again, and the cluster
  went with it. A modal surface is now reached from inside the content it floats
  over (a pane launcher, a row action, a notification's Open), which is the
  shape a modal is actually for; contribute that trigger yourself and call
  `openModalSurface(id)`. `order` and `Icon` are the fields the retired cluster
  read and are **optional** as of this change — nothing renders them — kept so a
  module that already declares them still compiles.

- **Modal surfaces** (doors→modals, 2026-09-01). A new contribution kind beside
  the door pair: `registerModalSurface({ id, order, label, Icon, onOpen?,
  Component })` mounts your zero-prop body in the shell's modal shell (workbench
  width, flat darkening scrim — never a backdrop blur, terminals render at 60fps
  behind it — focus trap, Escape/scrim close) and renders your trigger as a
  glyph button in the sidebar footer's settings cluster, tooltip and accessible
  name from `label`. Trigger and mount gate on your module's enablement, no
  reload. `onOpen` runs just before a plain trigger open, for discarding stale
  deep-link latches; deep-link openers bypass it. The shell's own Settings,
  Plugins (né Extensions), Automations and Design surfaces are the first
  consumers. New mirrored types: `ModalSurfaceDefinition`,
  `ModalSurfaceIconComponent`.

- The four module-boundary surfaces. Each was discovered separately by
  a task trying to put a door behind a real module boundary; they are published
  together so a contribution API does not grow four subtly different escape
  hatches for the same problems.

  - **A module-owned event channel.** `MainHost.emit(topic, payload?)` pushes to
    `RendererHost.subscribe(topic, cb)` — the subscribe verb the request/response
    bridge (`RendererHost.invoke`) does not have, and without which a module's
    renderer half cannot learn that its main half finished something. Identity is
    stamped from the emitting host's scope, so only your module's subscribers see
    it and you can never emit as another module. Delivery: fan-out to every open
    window, FIFO per module, **no replay** (an event emitted with no window open
    is dropped — events are signals, so keep the durable answer readable through
    an IPC channel and let the event say "read it again"), and **no flood
    bound** (unlike `notify`, dropping one would make a subscriber wrong).
    Delivery pauses while your module is disabled and resumes on re-enable; the
    returned closure unsubscribes. `subscribe` before the shell wires the source
    is a working no-op, never a throw. New mirrored type: `ModuleEventEnvelope`.

  - **App-level module state on `RendererHost`.** `getModuleAppState<T>(key)` /
    `setModuleAppState(key, value)` / `watchModuleAppState(cb)` — the scope above
    `getWorkspaceModuleState`, for state that belongs to your module rather than
    to a single workspace: remembered defaults, the last thing the user opened.
    It is renderer-side and **synchronous** on purpose: these values are read
    inside render, and routing them through the `entry.main`
    `ModuleStorageService` would change render timing (an async hydration flashes
    a default before the remembered value lands). Scoped to your module, persists
    with app settings, survives a disable/enable cycle, and shares a keyspace
    with your contributed Settings section's values — which are app-level module
    state by another name. `undefined` read / `false` write mean "not set" and
    "not stored", never a deletion signal. Pair `get` + `watch` with
    `useSyncExternalStore` for a reactive read. Disclosure: `storage`.

  - **Module-owned agent-id namespaces.**
    `RendererHost.registerAgentIdNamespace({ prefix, label })` claims every agent
    id starting with `prefix` for your module, and names what the shell calls
    those sessions where no workspace claims them. A module that spawns agents
    outside a window's knowledge — a background guide, a companion — owned ids
    the shell previously had to recognise by importing the module's own
    predicate. Keep the prefix distinctive and terminated (`'review-guide-'`, not
    `'review'`); a prefix overlapping one another module already claimed is a
    registration error. The shell gates resolution on live enablement.
    Disclosure: `ipc:agents`. New mirrored type: `AgentIdNamespaceDefinition`.

  - **An async create hook on `WorkspaceTypeDefinition`.**
    `createWorkspace(request, host)` lets a type own its whole create action when
    creating it is orchestration rather than a layout choice — probe a source,
    materialize it on disk, roll back on failure. `createTemplate` stays
    synchronous and keeps answering only "what layout?". Resolve to mean
    "created, close the hub"; reject to leave the hub open with the create still
    available. The host lends exactly two capabilities: `createWorkspace()` mints
    the row (running your `createTemplate`) and `removeWorkspace(id)` takes it
    back, so a create that fails after minting leaves no empty workspace behind.
    `request.setStepValue` writes into your creation step's value, which is where
    a failed hook reports — your step owns that page's body. Absent ⇒ the hub
    creates from `createTemplate` directly, unchanged. New mirrored types:
    `WorkspaceTypeCreateRequest`, `WorkspaceTypeCreateHost`.

- Top-bar items on `RendererHost`:
  `registerTopBarItem({ id, order, Component })` contributes a control to the
  app's top-bar title-strip cluster. The `Component` is zero-prop and
  self-contained — state, tooltip, action — eager or `React.lazy()`
  (`TopBarItemComponent`); the bar filters by your module's live enablement
  and orders contributed items by `order` (ties on id), so a module toggle
  adds/removes the control without a reload. Duplicate ids are a registration
  error naming the owner. The top bar is dense: contribute a single compact
  control (an icon button), not a cluster. First consumer: the bundled
  voice-dictation module's mic button. Also removed `voiceDictationEnabled`
  from `CommandAvailability` — the voice toggle is a module command now
  (`voice-dictation.toggle`); module commands gate on enablement through the
  contribution list, not a shell availability enum entry.

- MCP tool contributions on `MainHost`:
  `registerMcpTools(tools: McpToolRegistration[])` puts agent-facing MCP tools
  on SprintEngine's always-on Studio gateway, owned by your module's id the way
  IPC channels are. A tool name another module already registered is a
  registration error and the whole batch is rejected (no partial
  registration). Availability follows your module's live enablement at the
  gateway: while the module is registered but disabled the tools stay listed
  on `tools/list`, and `tools/call` answers a normal MCP tool result carrying
  an actionable "enable it in Settings → Modules" error instead of running —
  toggling needs no app restart, and connected clients are nudged with
  `notifications/tools/list_changed`. Tools of a module that never loaded are
  not listed. New mirrored types: `McpToolRegistration`, `McpToolResult`,
  `McpConnectionContext`, `McpConnectionMetadata` (all exact-identity
  drift-guarded). Keep JSON-Schema array fields arrays end to end.
  Disclosure: an MCP tool is agent-reachable capability — declare
  `ipc:agents`.

- Global door surfaces on `RendererHost`:
  `registerGlobalSurface({ id, Component })` publishes the full-page surface
  behind a sidebar nav entry with the same id. A global surface is a
  first-class, instance-global extension point: no workspace type, panel, or
  project scope is required to own a top-level door. `Component` is zero-prop,
  eager or `React.lazy()` (`GlobalSurfaceComponent`). The shell gates the
  mount on your module's live enablement — while the module is uninstalled or
  disabled it renders an explicit "not installed" door (name, one sentence,
  one CTA into Extensions) and never clears the user's persisted spot, so
  reinstalling lands them back on the door. An id already claimed by another
  module is a registration error, reported as a module load error that gates
  off the failing module's other contributions.

- Per-module workspace state on `RendererHost`:
  `getWorkspaceModuleState<T>(workspaceId)` /
  `setWorkspaceModuleState(workspaceId, state)` — your module's own durable
  entry in the workspace's per-module state bag, scoped to the calling module
  by the host. Entries persist with the workspace registry and sync across
  windows like built-in workspace fields; keep them JSON-serializable.
  null/undefined removes the entry. Read resolves `undefined` and write
  reports `false` when the workspace id is unknown or the shell hasn't wired
  workspace state yet (early boot) — retry later; neither is a deletion
  signal and neither throws. Disclosure: `storage`. The accessor pair is the
  pinned shape (exact-identity drift-guarded); no watch variant yet — re-read
  on render until a consumer motivates one.

- Live runtime surfaces on `RendererHost` (the extraction blocker
  set): `watchAgentSessions(workspaceId, cb)` — read-only session views
  (`ModuleAgentSessionView`: sessionId/agentId/name/kind/system/executionId/
  isLive, enum-ish fields widened to string), snapshot then deduped change
  events; `spawnAgent(input)` — spawns through the app's SHARED session
  runtime (never a bespoke PTY) with structured failures
  (`unknown_workspace`/`missing_folder`/`unknown_runtime`/`spawn_failed`)
  and adds the agent's layout tab; `focusTab({ kind: 'agent' | 'file' })`;
  `listAgentRuntimes()` — ids + labels from the shell's availability-
  filtered CLI catalog (no plugin internals);
  `watchWorkspaceFile(workspaceId, relativePath, cb)` — debounced content
  watch (null = file absent), absolute/escaping paths reject with a named
  cause; and `getWorkingRoot(workspaceId)` — the *effective working root*
  (`ModuleWorkspaceView.folderPath` stays the durable primary checkout;
  worktree-backed workspaces do live work under a worktree, and the file
  watch, spawn cwd, and file-tab focus all resolve against that root).
  Every method fails with a named cause when agent runtime is unavailable
  (unwired shell vs the Agent Runtime module disabled are distinct causes).
  Disclosures: `ipc:agents` (sessions/spawn/focus),
  `filesystem:read-workspace` (file watch), `ipc:workspace-read`
  (working root).

- Module-owned workspace-creation config steps:
  `WorkspaceTypeDefinition.creationStep` —
  `{ id, heading, description?, Component, isReady?, blockedHint? }`, one
  step per type in v1. The hub renders the step as the flow's one config page
  after the shared name/folder fields; `Component` receives
  `{ value, setValue }` (`WorkspaceCreationStepProps`); `isReady(value)`
  gates the Create button and `blockedHint` is the footer hint while it is
  false. The collected value arrives in the new optional
  `createTemplate(context?: WorkspaceTypeCreateContext)` argument
  (`{ stepValue?: unknown }`) — the shell holds it for the pane's lifetime
  only and persists nothing. A throwing step component degrades to the
  type's zero-config create with an inline notice; it never blocks the hub.

- Workspace supervisors + sidebar run glyphs published on
  `WorkspaceTypeDefinition`: `supervisors` (render-nothing background
  components; scope `'global'` = one instance in the primary window while the
  module is enabled, `'all-windows'` = one per window; mounted inside a crash
  boundary and a display:none host) and `deriveRunGlyph(workspace)` (sync
  sidebar status — `{ state, live, label }` with `state` from the stable
  `WorkspaceRunGlyphState` subset; input is the minimal `{ mode }` view; the
  mode's own provider wins the dispatch; return null for "no run signal").
  Both were v1 narrowings; extraction makes them load-bearing (an auto-run IS
  a supervisor; the calendar benchmark's "2 scheduled today" badge needs the
  glyph slot).
- Module command scopes + availability: `CommandScope` and
  `CommandAvailability` are open at the type level (`(string & {})`) — the
  shell derives a module's `panel:<moduleId>` scope from the workspace-type
  registry and activates it while a workspace of that module's mode is
  active. `ModuleCommandDefinition.availability` now also accepts a predicate
  over the published `ModuleCommandContext`
  (`{ activeWorkspaceId, activeWorkspaceMode }`) — "offer this only when…"
  without a shell enum change; predicate commands fail closed when no context
  is wired. Panel-targeted dispatch stays the module bus pattern (a
  `sprintengine:panel-command` CustomEvent from the command's `run()`), now the
  documented convention. In-tree proof: Switchboard/Watchtower's built-in
  commands are registered through this path.
- Per-module, per-workspace storage: `getModuleStorage(host)` →
  `{ get, set, delete, list }` scoped to your module, with host-owned file
  placement (workspace `.sprintengine/modules/<moduleId>/<key>.json`, or
  per-user app data for global keys). JSON values with a 1 MB cap, keys
  `^[a-z0-9][a-z0-9._-]{0,63}$`, atomic write-then-rename, honest errors
  (`invalid_key` / `invalid_value` / `value_too_large` /
  `invalid_workspace_root` / `io_error`; a corrupt record reads as
  `io_error`, never silently missing). New `storage` disclosure permission.
  Main-side only in v1 — renderer access rides the module's own
  `host.invoke` channels.
- `BacklogItemLink` mirror caught up with the app: `target.taskId?` (the task
  inside a run target that owns the item), `priorStatus?` (item status to
  restore if the linked work is abandoned), and the `pending` value in
  `BacklogItemLinkStatus`.
- Workspace context resolution (id → root/name/mode): renderer
  `RendererHost.getWorkspace(workspaceId)` and main-side
  `WorkspaceContextToken` (`core.workspace-context`, always-on) both resolve a
  read-only `ModuleWorkspaceView` (`{ id, name, folderPath, mode }`). Unknown
  ids resolve `null`, never a throw. Disclosure permission:
  `ipc:workspace-read`. Replaces deriving the workspace root from Backlog item
  paths or drop payloads.

## 0.4.0 — 2026-07-07

Calendar-class workspace parity: a module's renderer can now reach its own
`entry.main` (IPC bridge), create and observe real automations (scoped
service + one-shot `at` cadence), enumerate and watch the Backlog, accept
Backlog/Files drags, and style against published theme tokens.

- File-drop drag-and-drop contract: `SPRINTENGINE_FILE_DROP_MIME`,
  `FileDropPayload`, `setFileDropData`, `hasFileDropData` (the dragover-safe
  presence check), and the null-safe `readFileDropPayload` (missing entry,
  bad JSON, unknown version, or invalid shape ⇒ `null`, never a throw; file
  entries are rebuilt, dropping unknown properties). Backlog-panel and
  Files-tree drags are now a supported module surface, drift-guarded against
  the app implementation.
- Theme token contract: `THEME_TOKENS` + `ThemeToken` publish the CSS
  custom-property names guaranteed present in every app theme (chrome,
  border, text, accent, and semantic tone families). Names only — values are
  theme-specific and retuned freely. A repo gate verifies presence per theme.

- Backlog read API on `RendererHost`: `listBacklogItems(workspaceId)` and
  `watchBacklogItems(workspaceId, cb)` expose the workspace's Backlog as
  read-only `BacklogItemView`s, backed by the same shared scan + watcher the
  Backlog panel uses. `watch` fires with the current snapshot, then on every
  change; unsubscribe via the returned closure. Declare the `backlog.read`
  disclosure permission. Both methods fail with a named cause when the
  backlog module is disabled or absent.

- `ScheduleTriggerConfig` gains the one-shot `at` cadence:
  `{ type: 'at', datetime: 'YYYY-MM-DDTHH:mm' }` — local wall-clock resolved
  in the config's `timezone` (seconds optional and ignored; a trailing
  `Z`/offset is rejected). Fires exactly once; after the fire time the
  automation stays listed with no upcoming run. A wall-clock inside a DST
  spring-forward gap resolves to the first instant after the gap, matching
  daily/weekly.

- Scoped Automations service: `getAutomationsService(host)` returns a
  `ModuleAutomationsService` with owned CRUD (`create`/`update`/`delete`/
  `list`/`listRuns`) and ownership-filtered `onRunEvent`. New mirrored types:
  `AutomationDefinition`, `AutomationDefinitionDraft`,
  `AutomationDefinitionPatch`, `AutomationsRunEvent`,
  `AutomationRunEventStatus`, `AutomationRunEventTrigger`,
  `ModuleAutomationsError`, `ModuleAutomationsResult`. Every method returns a
  structured result (`invalid_workspace` covers roots the app does not have
  open); writes require the workspace folder to be open in the app.
  `AutomationDefinition` gains `ownerModuleId` (stamped server-side;
  module-created automations show a "via <module>" attribution in the panel,
  and open panels refresh live when a module writes). New
  `automations.manage` disclosure permission.

- `RendererHost.invoke(channel, payload?)`: renderer→module-main IPC bridge.
  A module's renderer code can now call channels its own `entry.main`
  registered via `MainHost.registerIpc`. Channels must be `<moduleId>:`-
  prefixed; the host routes only to third-party-owned channels whose module
  declares `ipc:invoke`. Refused invokes reject with an Error carrying a
  structured `code` (new exported type `ModuleBridgeRefusalCode`). A
  contract, not a security boundary — trust gating remains the boundary.

- Licensed MIT (`LICENSE` added, `license` field set, included in published
  files). Permits building and selling modules, including closed-source;
  covers this SDK package only, not the SprintEngine app or marketplace terms.
- New Automations provider authoring surface:
  `registerAutomationTrigger`, `registerAutomationAction`, provider/context
  types for trusted modules that declare `dependsOn: ['automations']`.
- `BUNDLED_MODULE_IDS` now includes `automations`, matching the app reserved-id
  set.
- `BacklogItemLink.type` now includes `agent`, matching the app's
  lifecycle-neutral working-agent links.
- Three additive Backlog disclosure scopes — `backlog.read`, `backlog.write`,
  `backlog.link.open` — added to `CapabilityPermission` and
  `KNOWN_CAPABILITY_PERMISSIONS`. Install-time disclosure vocabulary only (no
  runtime enforcement), consistent with the existing `ipc:*` tiers.

## 0.3.0 — 2026-06-15

BYO-CLI plugin authoring and programmatic workspace creation.

- New CLI plugin authoring surface: `CliPluginManifest` (the `plugin.json`
  contract for adding an agent CLI), `validateCliPluginManifest` /
  `parseCliPluginManifest`, and the supporting token types (`CliLaunchSpec`,
  `CliResumeSpec`, `CliPromptInjection`, `CliCompletionSpec`, `CliCapabilities`,
  `CliMcpConfigSpec`, `CliModelSelectionSpec`, `CliSkillIntegration`,
  `CliSkillInstallTarget`, `CliSkillInvocation`, …). A CLI plugin is a folder
  dropped into `~/.sprintengine/plugins/<id>/`, or installed from
  Settings → Agents → "Install CLI from folder".
- `validateCliPluginManifest` is the **single source of truth** for CLI
  manifest validation: the SprintEngine app loads a `plugin.json` by delegating to
  it (no separate in-app copy), so the authoring contract and the loader cannot
  drift. As part of consolidating the two former copies, `version` is now
  required to be a positive integer (the app previously accepted any number).
- New `WorkspaceService` + `WorkspaceServiceToken`: resolve with
  `host.requireService(WorkspaceServiceToken)` from `entry.main` to create a
  workspace programmatically. The creation runs the same renderer flow as the
  UI and is confirmed on the workspace-sync bus before it resolves.
- `CommandAvailability` mirror synced with the app (`diagnosticsEnabled`).

## 0.2.0 — 2026-06-11

Signing toolchain for module authors.

- New `sprintengine-module` CLI (`bin`): `keygen` (ed25519 PKCS#8 PEM keypair),
  `pack` (validate + assemble an installable module directory; excludes
  node_modules, .git, and key material), `sign` (detached ed25519 signature
  over the canonical manifest, normalized manifest written back to disk),
  `verify` (checks a module directory exactly like the SprintEngine app).
- New `@sprintengine/module-sdk/signing` subpath export:
  `generateModuleSigningKeyPair`, `signManifest`, `verifyModuleSignature`,
  `manifestFingerprint`, `publicKeyFingerprint`. The SprintEngine app's verifier
  imports these same functions, so signer and verifier cannot drift.
- Manifest validation (`parseThirdPartyModuleManifest`,
  `validateThirdPartyModuleManifest`, `canonicalManifestPayload`) is now the
  single source of truth consumed by both the app and the CLI.

## 0.1.0 — 2026-06-10

Initial published surface.

- Manifest contracts: `CapabilityManifest`, `ModuleEntry`, `ModuleSignature`,
  `ModuleSource`, `ModuleTrustStatus`, `CapabilityCategory`,
  `BUNDLED_MODULE_IDS`.
- Permission disclosure vocabulary: `CapabilityPermission`,
  `KNOWN_CAPABILITY_PERMISSIONS` (tiered `ipc:*` scopes; `ipc:invoke` legacy
  broad scope).
- Main host: `MainHost`, `RegisterMain`, `IpcInvokeHandler`, `ServiceToken`,
  `createServiceToken`, `SidecarSpec` (including `startOn` spawn policy),
  startup/shutdown hooks.
- Notifications: `ModuleNotifyInput`, `ModuleNotification`,
  `ModuleNotificationSeverity`.
- Renderer host: `RendererHost`, `RegisterRenderer`, panel types, workspace
  type definition + layout JSON subset, Backlog item actions and link
  providers, module commands (`ModuleCommandDefinition`, scopes,
  availability), settings sections.
- `entry.preload` documented as reserved, not loaded in v1.
