# @sprintengine/module-sdk

The contract, templates and authoring CLI for building **SprintEngine Studio
extensions** (capability modules): the manifest and its host API version, the
`MainHost` / `RendererHost` registration contracts, chat conversations with the
app's agents, brokered secrets and GitHub access, scheduled agents, module
storage, notifications, and signing.

Studio is a home for agent runtimes — Claude Code, Codex and the ACP agents —
and an extension reaches those agents one way: **as chats**. A module starts,
drives and reads chat conversations it owns, opens a chat for the person with a
drafted prompt, or runs a background companion agent. It never launches,
types into, or watches an agent terminal; that surface is not part of the SDK.

The package is types-first. Beyond the declarations it ships a few small pure
values (`BUNDLED_MODULE_IDS`, `KNOWN_CAPABILITY_PERMISSIONS`,
`HOST_API_VERSION`, `createServiceToken`, the `get*Service` helpers), the
manifest validators, the `sprintengine-module` CLI, the starter templates,
the `sprintengine-extension-builder` agent skill, and a testing kit
(`@sprintengine/module-sdk/testing`: fake hosts that keep the host's rules, and
a UI kit stand-in that renders in Node). It has no runtime dependency
on Electron or on the app's code, so a project compiles against the tarball
alone. Node 22.15 or newer.

## Quick start

```sh
npx -p @sprintengine/module-sdk sprintengine-module init my-extension --template panel
cd my-extension
npm install
npm run check        # typecheck, build, tests (smoke test and yours), validate
npm run dev:install  # side-load into Studio on this machine
```

`init <dir> --template <id> [--with <part,...>] [--id <module-id>] [--name <display name>]`
scaffolds a project that already builds, passes its own tests and installs.
`--sdk-tarball <file>` depends on a local SDK build instead of the npm release
(for working on the SDK itself). Templates:

| Template | What it starts you with |
| --- | --- |
| `blank` | A palette command and nothing else: the smallest extension that runs |
| `panel` | A notes panel in a workspace of its own, saved in module app state |
| `global-surface` | A full-page surface behind its own row, drawn with the host's door shell |
| `top-bar-item` | A compact control in the app's top bar |
| `settings-section` | A section in Settings, and a command that reads what it saved |
| `workspace-type` | A workspace type with a creation step |
| `backlog-action` | A Backlog item action that opens a planning chat for the item |
| `file-action` | A Files-tree context-menu action |
| `mcp-tools` | Tools any agent in a workspace calls through the Studio MCP gateway |
| `chat-companion` | Starts and follows chats of its own, and opens chat drafts with `openChat` |

Templates combine. `--with` adds parts on top of the one you start from, and
`sprintengine-module add <part>...` adds them to a project you already have:

| Part | What it adds |
| --- | --- |
| `main` | `src/main.ts` and `entry.main` with its `build:main` script, `dependsOn: ["agent-runtime"]`, and `module:bridge` when the project has a renderer |
| `mcp` | MCP tools registered from `entry.main` (`mcp:tools`); brings `main` when missing |
| `settings` | A Settings section (`storage`) |
| `door` | A full-page surface drawn with the host's door shell |

A part copies its files and its test, merges its entry, permissions and
`dependsOn` into `module/manifest.json` and `plugin.json`, adds its scripts
and devDependencies to `package.json`, and wires its registration in by adding
an import and a call at the top of `registerRenderer` or `registerMain`. A part
that needs the renderer or main entry brings it. When the entry function is not
one of the shapes the templates write, `add` says what to call instead.

Studio can do the same from the Extensions door: **Build your own extension**
opens New chat in extension mode. You name the extension, pick the project it
goes in and describe it (or start from one of the ideas, one per template);
Studio scaffolds `<project>/<name>` from the `blank` template and opens a chat
on it with the agent you pick and the extension-builder skill, which adds the
surfaces your description needs. The app ships this SDK beside itself, so such a
project depends on its own copy, `vendor/sprintengine-module-sdk-<version>.tgz`,
by `file:`: `npm install` needs no registry, and the project builds against the
SDK of the Studio that made it. Commit `vendor/` with the project.

### The extension-builder skill

Every scaffolded project carries the `sprintengine-extension-builder` skill
once, in `.agents/skills/`, where every agent CLI can read it, with a pointer in
`.claude/skills/` carrying the same name and description so Claude Code picks it
up for the same requests (the package ships it under `skills/`).
`npm run validate` fails when the pointer's name or description no longer match
the skill's. It is the working method for an agent building an extension — the project
layout, which host API to reach for, choosing permissions, the check /
side-load loop, signing, publishing, and what "not trusted", "tampered" and
"incompatible" mean — with references for the main and renderer APIs,
conversations, brokers, the UI kit and troubleshooting. Point your agent at it:
"Use the sprintengine-extension-builder skill."

### Project layout

```
src/renderer.tsx      registerRenderer(host) — UI contributions
src/main.ts           registerMain(host) — Node side (templates that need one)
module/manifest.json  the module manifest; module/ is the only folder that installs
module/dist/          build output (renderer.mjs, main.cjs)
plugin.json           the bundle manifest a GitHub or marketplace install reads;
                      its "module" component points at module/
test/smoke.test.mjs   loads the built bundles against the SDK's fake hosts and renders what they register
test/*.test.ts        your tests, in TypeScript (see Testing)
IDEA.md               the brief
```

## Testing

`@sprintengine/module-sdk/testing` runs a module in Node without the app:

```ts
import { createFakeMainHost, createFakeRendererHost } from '@sprintengine/module-sdk/testing'
import manifest from '../module/manifest.json'
import { registerMain } from '../src/main'
import { registerRenderer } from '../src/renderer'

const main = createFakeMainHost({ manifest })            // id and permissions from the manifest
await registerMain(main.host)
await main.ipc.invoke('my-extension:start', { workspaceId: 'ws-app' })   // as the renderer would
main.services.conversations.emitEvent(ref, { type: 'turn_completed' })  // make the agent answer
await main.tools.call('my_extension_search', { query: 'x' })            // as an agent would

const renderer = createFakeRendererHost({ main })        // invoke and subscribe reach `main`
await registerRenderer(renderer.host)
const html = await renderer.render.surface('my-extension')   // a door, rendered to HTML
```

- **`createFakeMainHost({ moduleId, permissions } | { manifest }, …)`** is a
  `MainHost` with stateful fakes of every published service, held to the host's
  rules. Each service's handle is on `services`, to arrange the world and read
  what the module did to it:
  - `storage`: the real key pattern, absolute-root rule and 1 MB cap;
    `list({ prefix })`, `getMany` and `watch`, which hears the module's own
    writes and `changeExternally(key, value, root)` (a `git pull`, a hand edit).
  - `conversations`: `emitEvent` (turn events get a `turnId`; give
    `turn_completed` its `text` and `usage` and `reply(ref)` reads it),
    ownership and the preset ceiling, `create({ worktree })` in a workspace
    of its own (for a project `setGitInfo` made a repository, else
    `worktree_unavailable`), and `restore(chat)` to make a saved chat known,
    which a `subscribe` or `follow` attached before it hears from then on.
  - `scheduledAgents`: `fire(id)` starts a chat the module owns (with
    `scheduledAgentId` and `scheduledAgentTag`), sets `lastRun.agentId` and
    tells `onRun`; `failNextRun`.
  - `companions`: `respond` (may be async), and `requestApproval` for an
    agent asking to use a tool mid-run: `tools: 'none'` denies it, `'auto'`
    (refused without `conversation:bypass`) allows it, `'ask'` leaves it to
    `respondToApproval`, whose allow needs `conversation:operate`.
  - `textGeneration`: `respond` (text, an answer with `usage`, or a failure),
    `setPreferred`, `calls`; `agents:generate` checked, `claude-code` or
    `codex` only, and the host's two-running, eight-waiting lane (`busy`).
  - `secrets` (origins, https, redaction).
  - `github`: `respond('GET', '/route', …)` (headers narrowed to the ones a
    module may read, 304 for a matching `ifNoneMatch`), `respondGraphql` (a
    mutation is refused before it is sent), `respondDownload`, `setSignedIn`.
  - `backlog` (`seed`, `setKey`, `setLocation`, `failScan`), `usage`
    (`record` usage, summed over the query's window and `groupBy`) and
    `activity` (`addChat`, `addPrompt`), behind `backlog.read` /
    `backlog.write`, `usage:read` and `conversation:read-all`.
  - `workspaces`: `setHydrated(false)` for the after-launch null, `close(id)`
    for `list({ includeClosed: true })`, `setGitInfo(id, …)` for
    `getWorkspaceGitInfo` on both hosts.

  A permission the host checks is refused as the host refuses it
  (`permission_missing`, or a throw); a disclosure-only one used undeclared is
  listed in `undeclared`. `ipc.invoke` needs `module:bridge` and clones like
  IPC; `tools.call` hands the handler agent metadata. The module app state is
  the windows' to write: `setAppState(key, value)` pushes a Settings change
  that `watchModuleAppState` hears (`appState` seeds it).
  `getModuleDataDir()` hands out a temporary folder (`dispose()` removes it;
  `dataDir` picks one), `getAssetPath` resolves under `moduleRoot` (default
  the working directory, limited to `verifiedFiles` when given), and
  `skills.setStatus(root, id, status)` scripts `getSkillStatus` and
  `ensureSkillInstalled`, and `setChatRuntimes` what `listChatRuntimes`
  answers (default `claude-code` and `codex`). `emitted`, `notifications` (validated, `target`
  included), `skills`, `startup()` and `shutdown()` cover the rest.
- **`createFakeRendererHost({ … , main? })`** records every registration
  (`registrations`), renders a registered door, modal, panel, settings section,
  top-bar item or nav entry to HTML (`render.*`), and records `openChat`,
  `focusTab`, surface opens, `toasts` (validated and clipped; press one's
  `action.run()`), `openedUrls` and `surfaceViews`. `runCommand(id, context?)`
  refuses a command its `availability` rules out and hands `run` the
  `ModuleCommandContext` of the active workspace (`activeWorkspaceId`,
  `setActiveWorkspace`). Given `main`, the module app state, the Backlog,
  usage and git info are main's (`services`); alone, it keeps its own.
  `openChat` holds a draft to `chat:draft` (or `conversation:operate`) and
  `send: true` to `conversation:operate`, takes `name`, and answers
  `existing: true` for a `dedupeKey` it already opened.
  `capabilities` without `toast`, `open-external` or `command-context` tests
  the older-host branch.
- **`installTestingKit()`** (or `node --import @sprintengine/module-sdk/testing/register`)
  routes `@sprintengine/module-sdk/ui`, `/surface` and `@monaco-editor/react` to
  `@sprintengine/module-sdk/testing/kit`, whose components render a
  `<div data-kit="Name">` holding their text props and children, so a door
  renders in Node and one that throws fails its test. `renderToHtml(node)`
  renders any tree, waiting for `lazy` components. It is a server render: no
  effects run, and `useSyncExternalStore` needs its third argument.

A scaffolded project's tests are TypeScript: `npm test` bundles
`test/**/*.test.ts` with esbuild into `test/.build/` (`npm run build:test`, so
it works on every Node the SDK supports, with or without type stripping) and
runs them with `node --test` beside the smoke test. The smoke test loads the
built bundles against the fakes, checks the permissions and `dependsOn` the
registration needs (`MODULE_SERVICE_REQUIREMENTS` says what each service needs),
and renders everything the renderer registered.

## What an extension is

A folder with a `manifest.json` (`CapabilityManifest`) and built JavaScript:

- **`entry.renderer`** — a single-file ESM bundle exporting
  `registerRenderer(host)`. Adds UI.
- **`entry.main`** — a CommonJS bundle exporting `registerMain(host)`. Runs in
  Studio's main process with Node. It is one entry file, but it may start
  worker threads from other files the module ships:
  `new Worker(host.getAssetPath('dist/worker.cjs'))`.
- **`entry.preload`** is reserved and never loaded.

Both registration functions may be `async`: the host waits for the returned
promise (bounded at 10 seconds) before it counts the module as loaded, and a
rejection or a timeout fails that module alone.

The manifest fields that matter most:

| Field | Notes |
| --- | --- |
| `id` | `^[a-z0-9][a-z0-9-]{0,62}$`, equal to the install folder name, not one of `BUNDLED_MODULE_IDS`. |
| `version` | Positive integer. |
| `source` | `"third-party"`. |
| `engines` | `{ "hostApi": 1 }` — **required**. See "Host API version". |
| `permissions` | What the module touches; shown before anyone trusts it. |
| `dependsOn` | Module ids that load first, e.g. `scheduled-agents`, `agent-runtime`. |
| `entry` | `{ "renderer": "dist/renderer.mjs", "main": "dist/main.cjs" }`. |
| `files` | Written by `sign` / `dev:install`: every file's sha256. **Required** to load. |
| `signature` | Written by `sign`. |

**Trust.** Only a module the person trusts runs code. A valid signature from a
publisher key shows who vouches for it; the person still grants trust. A grant
binds to the manifest's fingerprint, which covers `files`, so it holds only
while the installed folder matches them byte for byte. Studio checks the files
when it lists modules, again immediately before it runs `entry.main`, and on
every `entry.renderer` and asset it serves.

## Host API version

`HOST_API_VERSION` names the host contract this SDK describes, as one integer;
this release has `HOST_API_VERSION = 1` and `HOST_API_MIN_SUPPORTED = 1`. A third-party manifest must declare the version it was built
against:

```json
"engines": { "hostApi": 1 }
```

Studio loads a module when that number is within
`[HOST_API_MIN_SUPPORTED, HOST_API_VERSION]` of the app, and otherwise refuses
it with a message saying which side to update (`host_api_missing`,
`host_api_too_new`, `host_api_too_old`). `checkHostApiCompatibility(manifest)`
is the same check, exported; `sprintengine-module sign`, `verify` and `pack`
run it too.

The version says which contract a module was built for. What the running host
provides *today* is a separate question, and every host answers it:

```ts
if (host.supports('conversations')) registerChatFeatures(host)
```

`host.hostApiVersion` is the app's `HOST_API_VERSION`; `host.supports(name)`
is true for a capability the host provides now — a service can be missing
because the module that provides it is turned off. Names: `conversations`,
`chat.open`, `companion-agents`, `scheduled-agents`, `secrets`, `github`,
`storage`, `mcp-tools`, `skills`, `module-assets`, `notifications`,
`backlog-write`, `usage`, `activity`. For agents,
conversations and scheduled agents also: `companion-tools`,
`conversation-replies`, `conversation-worktrees`, `text-generation`,
`chat-runtimes`, `scheduled-agent-runs` and (in the renderer)
`chat.open-options`; each is described where its API is, below. An unknown
name answers `false`, so a module may probe for capabilities newer than its
SDK.

## Permissions

Declare what the module touches in `permissions`. They are install-time
disclosure: the consent prompt lists them before the person trusts the module.
Most are not a sandbox — trusted code runs in the app's process — but these are
checked on every call, and a module without them gets `permission_missing`:

| Permission | Checked on |
| --- | --- |
| `conversation:read` | `getConversationService`: `subscribe`, `follow`, `transcript`, `reply`, `list`, `watch` |
| `conversation:operate` | Everything in the conversation service, `RendererHost.openChat` with `send: true`, and allowing a companion's tool call. Implies read. |
| `conversation:bypass` | Running the module's chats on `bypass` (without it they go no looser than `auto`), and a companion task with `tools: 'auto'` |
| `chat:draft` | `RendererHost.openChat` without `send` (a draft the person reads and sends) |
| `secrets` | `getSecretsService` |
| `github` | `getGitHubService` |
| `mcp:tools` | `MainHost.registerMcpTools` |
| `agents:companion` | Attaching a companion agent |
| `module:bridge` | The renderer → own `entry.main` bridge (`RendererHost.invoke`). The broad `ipc:invoke` still opens it for older manifests; declare `module:bridge` instead |
| `backlog.read` | `getBacklogService` reads; `listBacklogItems`, `watchBacklogItems`, `getBacklogLocation` |
| `backlog.write` | `getBacklogService` writes; the renderer's `createBacklogItem`, `updateBacklogStatus`, `updateBacklogTriage`, `addBacklogLink`, `updateBacklogModuleMetadata` |
| `usage:read` | `getUsageService`, `RendererHost.queryUsage` |
| `conversation:read-all` | `getActivityService` (flagged as a broad scope in the consent prompt) |
| `agents:generate` | `getTextGenerationService(host).generate` |

The full vocabulary and its consent copy is in
[`docs/module-authors/permissions.md`](../../docs/module-authors/permissions.md)
in the app repository, and `KNOWN_CAPABILITY_PERMISSIONS` exports it.

## Chats with the app's agents

### From `entry.main`: the conversation service

```ts
import { getConversationService, type RegisterMain } from '@sprintengine/module-sdk'

export const registerMain: RegisterMain = (host) => {
  if (!host.supports('conversations')) return
  const chats = getConversationService(host)

  host.registerIpc('my-module:ask', async (_event, workspaceId: string) => {
    const created = await chats.create({
      workspaceId,
      prompt: 'Summarise what changed on this branch.',
      skills: ['my-review-guide'], // installed before the first turn and invoked in it
    })
    if (!created.ok) return created // { ok: false, code, message }
    const { conversation } = created
    const off = chats.subscribe(conversation, async (event) => {
      if (event.type !== 'turn_completed') return
      off()
      const reply = await chats.reply(conversation) // the agent's last message of the turn
      if (reply.ok) host.emit('summary', reply.text)
    })
    return { ok: true, agentId: conversation.agentId }
  })
}
```

Declare `conversation:operate` (or `conversation:read` for a module that only
reads its chats) and `dependsOn: ["agent-runtime"]`.

- **`create(input)`** starts a chat in a workspace: `cli` and `model` default
  to the person's last choice, `prompt` is the opening turn, `skills` are
  installed and invoked, `attachments` are images, `name` is optional.
  `permissionPreset` is `'manual'`, `'none'`, `'auto'` or `'bypass'`; absent
  takes the person's default. `worktree: { name? }` starts the chat in a fresh
  git worktree of the project (branch `<prefix>/<name>-<suffix>`, the person's
  worktree branch prefix being `agent` unless they changed it), in a workspace
  of its own whose id the answer names; a project that is not a git
  repository answers `worktree_unavailable`. Check
  `host.supports('conversation-worktrees')`.
- **`send(ref, { message, skills?, attachments?, steer? })`** adds a turn;
  `steer: true` lands it inside the turn already running. `interrupt` and
  `stop` do what they say.
- **`respondToApproval(ref, { requestId, decision, answers? })`** answers an
  `approval_requested` event: `decision` is `'once'`, `'conversation'` (allow
  requests of that kind for the rest of the chat) or `'deny'`. The older
  `approved: boolean` still works, as `'once'` or `'deny'`. A rule that
  outlives the chat is the person's to make, so no answer makes one.
- **`setPermissionPreset(ref, preset)`** and **`setModel(ref, modelId)`**
  switch a running chat's preset (from its next tool call) or its model (from
  its next turn; an id `listChatRuntimes()` lists for the chat's runtime, or
  `'default'`). Each answers with what is now in force, plus the runtime's
  `notice` when the change applies later than at once. A runtime that binds a
  chat to its model refuses `setModel`.
- **The preset ceiling.** A module's chats run no looser than `'auto'` unless
  its manifest declares `conversation:bypass`. A looser preset is lowered to
  the ceiling, not refused, and `create` and `setPermissionPreset` name the
  preset in force. Check `host.supports('conversation-controls')` before
  `setPermissionPreset`, `setModel`, a `decision`, or a preset other than
  `'none'` and `'bypass'`.
- **`answerQuestion(ref, { requestId, answers })`** answers a question the
  agent asked, and **`resolvePlan(ref, { requestId, decision })`** carries a
  plan out (`'approve'`) or sends the agent back to planning (`'reject'`).
  Each is refused for a request of another kind. Check
  `host.supports('conversation-requests')`; an older host takes a question's
  answers on `respondToApproval`, which `answerQuestion` falls back to.
- **CLI modes and allowed tools.** `create` and `setPermissionPreset` take the
  agent CLI's own `permissionMode` beside the preset (Claude Code's
  `'acceptEdits'`), which goes with a preset lowered to the ceiling; `create`
  also takes `allowedTools`, tools the chat uses without asking, which needs
  `conversation:bypass`. Check `host.supports('conversation-permissions')`.
- **`commandId`.** Every mutating call but `stop` takes your own id for it. A
  retry with the same id, even after the app restarted, is answered with the
  first call's result and never carried out twice; a retried `create` answers
  with the chat the first one made. Check `host.supports('conversation-streams')`.
- **`subscribe(ref, cb)`** streams `ModuleConversationEvent`s from now on;
  **`follow(ref, cursor, onFrame)`** streams with no gap: a `snapshot` (or,
  given the `afterSeq` and `generation` of events you already hold, only the
  ones after them), one `synchronized` fence, then live events. Render what
  you cached, then follow from its cursor; keep each fence's `seq` and
  `generation` as the next cursor. A snapshot with `reset: true` replaces what
  you held. Check `host.supports('conversation-streams')`. Both attach to a
  chat the host has not loaded yet (a saved chat at startup) and deliver once
  it is; they throw only without `conversation:read` or for a malformed ref.
  **`transcript(ref)`** replays everything recorded. **`list(filter?)`** and
  **`watch(filter, cb)`** give `ModuleConversationSummary` rows; a scheduled
  run's chat carries `scheduledAgentId` and `scheduledAgentTag`.
- **Replies and usage.** A `turn_completed` event's payload carries `text`
  (the agent's last message of the turn), `usage` (`{ inputTokens,
  outputTokens, cacheReadTokens, cacheWriteTokens }`, summed over the turn's
  model requests, fresh input apart from the prompt cache's share; a count
  the runtime cannot report is absent) and `costUsd`, where the runtime can
  say them (`ModuleConversationTurnCompletedPayload`).
  **`reply(ref, turnId?)`** reads a finished turn's text for you; never
  rebuild it from `content_delta`s. Check `host.supports('conversation-replies')`.
- A module reaches **only the chats it created** — never the person's own and
  never another module's (`not_owned`). Its chats are otherwise ordinary: they
  appear in the sidebar and on paired devices like any other. Reading the
  person's chats is a separate, read-only service behind its own broad
  permission: see "The person's chats" below.
- Failures come back as `{ ok: false, code, message }` with a
  `ModuleConversationErrorCode`, never a throw.

### From the renderer: open a chat for the person

```ts
const runtimes = host.listChatRuntimes() // [{ id, label, available, models, lastSelected }]
const opened = await host.openChat({
  workspaceId,
  prompt: 'Review the open pull request against our style guide.',
  skills: ['my-review-guide'],
})
if (opened.ok) host.focusTab({ workspaceId, kind: 'chat', id: opened.agentId })
```

`openChat` adds a chat to the workspace and focuses it. By default the prompt
lands in the composer as a **draft** the person reads and sends; `send: true`
sends it as the first turn. Declare `chat:draft` for drafts, or
`conversation:operate`, which `send: true` needs; check
`host.supports('chat.open')` first (`unavailable` means this window cannot
open chats). `name` titles the chat, and `dedupeKey` (your own key for it)
focuses the chat this module already opened under that key in the workspace
instead of opening a second, answering `existing: true` and changing nothing
in it (`host.supports('chat.open-options')`). `listChatRuntimes()` is the
catalog the shell's own chat picker reads, with the person's last choice
marked — use it for a picker, and pass the chosen `id` / model as `cli` /
`model`. The same list is `await host.listChatRuntimes()` in `entry.main`.

A runtime's `id` (`claude-code`, `codex`, `cursor`, `opencode`, `grok`) is the
one id every API takes for it: a conversation's and a scheduled agent's
`cli`, a companion's `engine.cli` (which also takes the older provider ids,
`claude-agent` and the like) and text generation's `cli`.

`focusTab({ workspaceId, kind, id })` focuses a chat by its agent id
(`kind: 'chat'`) or a file tab by workspace-relative path (`kind: 'file'`).
It returns `false` for an id that is not a chat in that workspace.

### Companion agents

`getCompanionAgentsService(host)` attaches a workspace-bound background agent
your module drives with structured runs (`runStructured`) and messages, without
a chat tab. `attach` never starts anything; the first run does. Declare
`agents:companion`.

The agent asks before every tool it uses, and a run's `tools` decides the
answer: `'none'` (the default) denies them all and tells the agent up front
it has no tools — use it for any prompt carrying text you did not write;
`'ask'` leaves them for the person, whose answer you relay with
`handle.respondToApproval({ requestId, decision })` (allowing needs
`conversation:operate`); `'auto'` approves them all and needs
`conversation:bypass`. `engine.cli` takes a runtime id. Check
`host.supports('companion-tools')`: an older host approves every tool call.

### One prompt, no chat: text generation

```ts
import { getTextGenerationService } from '@sprintengine/module-sdk'

const answer = await getTextGenerationService(host).generate({
  prompt: digest,
  system: 'Write a three-line standup from this work log.',
  json: true, // optional: the answer must be one JSON value
})
if (answer.ok) console.log(answer.text, answer.usage, answer.model)
```

`generate` answers one prompt through the person's own agent CLI, headless and
under its own sign-in: no workspace, no chat tab, nothing in their history.
`cli` is `claude-code` or `codex`; absent, the runtime the person chose for
Studio's text generation in Settings, else `claude-code`. `model` absent takes
the person's chosen model on their chosen runtime, else the runtime's small
default (`claude-haiku-4-5`, `gpt-5.6-luna`); `maxOutputTokens` caps the
answer on Claude Code (Codex has no output cap and ignores it). Declare `agents:generate` and check
`host.supports('text-generation')`. Each module gets two calls at once and
eight waiting, and more than thirty a minute answer `busy`. Failures are typed
(`ModuleTextGenerationErrorCode`), never thrown.

## Brokered credentials

### Secrets

```ts
import { getSecretsService } from '@sprintengine/module-sdk'

const secrets = getSecretsService(host)
await secrets.set('weather-api', apiKey, { allowedOrigins: ['https://api.weather.example'] })
const res = await secrets.fetchWithSecret('weather-api', 'https://api.weather.example/v1/today', {
  placement: { header: 'Authorization', scheme: 'Bearer' },
})
if (res.ok) render(JSON.parse(res.body))
```

A stored value never comes back to module code — not from `has`, not in a
response, not in an error. It leaves the host only inside a `fetchWithSecret`
request to one of the https origins it was stored with (exact origin, bound at
`set`; change the list by setting the value again). Requests refuse redirects
and cap the response at 1 MiB. Values are encrypted with the operating
system's keychain; where it has none, `set` answers `storage_unavailable`.
Declare `secrets`; check `host.supports('secrets')`.

### GitHub

```ts
import { getGitHubService } from '@sprintengine/module-sdk'

const github = getGitHubService(host)
const { signedIn } = await github.status()
const pulls = await github.request({
  route: '/repos/{owner}/{repo}/pulls',
  params: { owner: 'acme', repo: 'app', state: 'open' },
})
```

The request goes to the GitHub API with the person's own sign-in; the module
never sees the token. `route` is a `/`-prefixed template: `{name}` placeholders
are filled from `params` (encoded, so a value cannot add a segment, a query or
a host) and the rest of `params` becomes the query string. Anything that could
move the request elsewhere is `invalid_route`. Declare `github`; check
`host.supports('github')`.

Beyond plain requests:

- **Headers and cheap polling** (`supports('github-headers')`): every answer
  carries `headers` narrowed to `x-ratelimit-*`, `link`, `etag` and
  `retry-after`. Send an `etag` back as `ifNoneMatch` and an unchanged resource
  answers `{ ok: true, status: 304, data: null }`, free of the rate limit.
  `accept` takes one of GitHub's media types (`ModuleGitHubMediaType`), such as
  `application/vnd.github.diff`.
- **Read-only GraphQL** (`supports('github-graphql')`):
  `github.graphql(query, variables)`. A document holding a top-level `mutation`
  or `subscription` is refused (`invalid_query`) before it is sent, so a poll is
  a read, not a write acting as the person. `data` is `{ data, errors? }`.
- **Downloads** (`supports('github-download')`): `github.download({ route,
  params, encoding? })` for a job's logs or an archive. GitHub answers those
  with a redirect to its own storage; the host follows that one redirect only
  to a GitHub storage host and strips the token before it does
  (`redirect_not_allowed` otherwise).

## The main host

`MainHost` (handed to `registerMain`):

- `moduleId`, `hostApiVersion`, `supports(capability)`.
- `listChatRuntimes()` — the agent runtimes a chat can run on, as the
  renderer lists them, with the ones this machine lacks marked unavailable
  (`host.supports('chat-runtimes')`).
- `registerIpc(channel, handler)` — a channel your renderer calls through
  `invoke`; it must start with `<moduleId>:`.
- `provideService` / `getService` / `requireService(token)` — the service bridge. A
  third-party module resolves only the services the SDK publishes (its
  exported tokens and the ones behind the `get*Service` helpers).
- `onStartup`, `onShutdownBegin` and `onShutdown` hooks.
- `registerSidecar(spec)` — a declaration the host lists; it does not spawn it.
  Spawn your own process if you need one (declare `process:spawn`).
- `notify({ severity, title, body?, target? })` — a row in the bell of every
  open window, under your module's display name (stamped by the host).
  `target: { surfaceId, viewId? }` names one of your own doors: the row's Open
  lands there, and the row counts on that door's drawer row until the door is
  opened. Flood-bounded per module (an identical repeat within 10 s, or more
  than 20 in 10 s, is dropped — fold a burst into one row). A row sent before
  any window is open is kept and filed when one opens; this works the same
  when Studio's server runs in a process of its own. Check
  `host.supports('notifications')`.
- `emit(topic, payload?)` — a module event to your own renderer (below).
- `registerMcpTools(tools)` — tools agents call through the always-on Studio
  MCP gateway, owned by your module id. Declare `mcp:tools`. A tool counts as
  changing state unless it declares `mutates: false`; declare that only on a
  tool that genuinely reads. A disabled module's tools stay listed and answer
  an enable error instead of running.
- `registerSkills(skills)` / `ensureSkillInstalled(workspaceRoot, skillId)` /
  `getSkillStatus(workspaceRoot, skillId)` — see "Skills a module ships".
- `getModuleAppState(key)` / `watchModuleAppState(cb)` — your module's
  app-level state (what your Settings section writes), read-only, persisted, so
  `entry.main` sees the person's settings with no window open
  (`supports('main-app-state')`).
- `getWorkspaceGitInfo(workspaceId)` — the branch and remotes of a workspace,
  each remote with `owner/repo` when it is on GitHub (SSH host aliases
  resolved). Declare `ipc:workspace-read`; it is checked.
- `getModuleDataDir()` — your module's own directory under the app's user
  data, for data past module storage's 1 MB value limit; removed at uninstall.
- `getAssetPath(relativePath)` — the absolute path of a file your module
  ships, for a worker thread or a data file; only verified files whose bytes
  still match resolve.

MCP tool names are compared as clients file them (`a.b` and `a_b` are one
name): a name that matches a core gateway tool, falls in one of the shell's
families (`browser`, `canvas`, `editor`, `tour`, `terminal`) or matches another
module's tool is a registration error naming the conflict. The core families
(`agent`, `backlog`, `cli`, `conversation`, `local_server`, `marketplace`,
`module`, `pull_request`, `schedule`, `tailnet`, `workspace`, `worktree`, and
`studio`, `sprintengine`, `app`) are reserved for core tools; name yours in a
family of your own (`decisions.record`). The gateway does not rename or prefix
module tools: the name you register is the name agents see. A tool's handler
receives `context.metadata.verified`: true when a launch token or the tailnet
proved who is calling (`supports('mcp-verified-identity')`); a chat Studio
launched always arrives verified with `workspaceId` and `agentId`.

## The renderer host

`RendererHost` (handed to `registerRenderer`). Every contribution is gated on
your module's enablement, so turning it off removes it without a reload; an id
another module already holds is a registration error that fails your module's
load.

- **Who you are:** `moduleId` — your manifest id, the prefix of your
  `invoke` channels.
- **Where you appear:** `registerPanel`, `registerWorkspaceType`,
  `registerSidebarNavEntry`, `registerGlobalSurface`, `registerModalSurface`,
  `registerTopBarItem`, `registerSettingsSection`, `registerCommand`,
  `registerBacklogItemAction`, `registerBacklogLinkProvider`,
  `registerFileAction`, `registerNotificationActionProvider`,
  `registerDoorBadge`.
- **Your door's row:** a global surface with a `label` and `Icon` is a row in
  the Extensions drawer. `registerDoorBadge({ rowId: <surface id>, … })` puts
  your waiting count on it, beside your unread bell rows that `target` the
  door. `registerSidebarNavEntry({ id: <surface id>, … })` draws that row
  yourself (handed `{ collapsed, badge }`) instead of the generic one; an
  entry whose id names none of your surfaces is not drawn.
  `setSurfaceView(surfaceId, viewId)` says which of your surface's `views` is
  showing, so the right row reads selected.
- **Commands:** `registerCommand({ …, run(context) })` — `run` receives the
  `ModuleCommandContext` (`activeWorkspaceId`, `activeWorkspaceMode`) of the
  window it ran in. A zero-argument `run` still works.
- **Telling the person:** `toast({ tone, message, detail?, action? })` for
  transient feedback in the app's toast region (one optional button); the
  bell (`MainHost.notify`) for anything they must find again.
  `registerNotificationActionProvider({ source: host.moduleId, … })` adds
  actions to your own bell rows.
- **Links:** `openExternal(url)` opens an http(s) URL in the system browser
  through the app's own link path; anything else is refused.
- **The window:** `getActiveWorkspaceId()` and `watchActiveWorkspace(cb)` —
  the workspace this window is showing.
- **Opening your own surfaces:** `openGlobalSurface(id)` and
  `openModalSurface(id)` open a surface **your module registered** — the page
  behind your door, or your modal over the window — from a command, a panel
  button or a notification action. Both return `false` for an id that is not
  yours, not registered, or while your module is off. The shell draws no
  trigger for a modal surface unless you declare a `launcher` (a row in the
  workspace pane's kind list), so these are how you open one.
- **Workspaces:** `getWorkspace`, `listWorkspaces`, `watchWorkspaces`,
  `getWorkingRoot`, `getWorkspaceGitInfo`, `watchWorkspaceFile`,
  `openWorkspace(typeId)` (declare `ipc:workspace-read`;
  `filesystem:read-workspace` for file watches).
- **Chats:** `openChat`, `listChatRuntimes`, `focusTab` (above).
- **State:** `getWorkspaceModuleState` / `setWorkspaceModuleState` (your entry
  on a workspace, synced across windows) and `getModuleAppState` /
  `setModuleAppState` / `watchModuleAppState` (app-level, shared with your
  Settings section's values, and readable from `entry.main` with
  `MainHost.getModuleAppState`). Declare `storage`.
- **Backlog:** `listBacklogItems`, `watchBacklogItems(id, cb, { onError })`,
  `getBacklogLocation` (declare `backlog.read`); `createBacklogItem`,
  `updateBacklogStatus`, `updateBacklogTriage`, `addBacklogLink`,
  `updateBacklogModuleMetadata` (declare `backlog.write`). See "The Backlog".
- **Usage:** `queryUsage(query)` (declare `usage:read`). See "Token usage".
- **Theme:** `watchColorScheme(cb)` for a runtime you host (Monaco, a chart
  library); ordinary UI reads `THEME_TOKENS`.
- **Bridge and events:** `invoke(channel, payload)` and `subscribe(topic, cb)`.
- **Assets:** `getAssetUrl(relativePath)`.

The TSDoc on each member in `dist/index.d.ts` is the reference for its exact
behaviour.

## Calling your entry.main from the renderer

```ts
// entry.main
export const registerMain: RegisterMain = (host) => {
  host.registerIpc('my-module:save-events', async (_event, payload) => {
    // Node APIs available here
    return { saved: true }
  })
}

// entry.renderer
const result = await host.invoke('my-module:save-events', { events })
```

The channel must start with your own module id. The host routes an invoke only
to a channel registered through `registerIpc` whose owner declares
`module:bridge` (consent: "Let its window code talk to its own background
code"). The broad `ipc:invoke`, which the bridge used to need, still opens it,
so an older manifest keeps working. A refused invoke rejects with an Error whose `code` is a
`ModuleBridgeRefusalCode` (`unknown_channel` | `not_bridgeable` |
`permission_missing`).

**This bridge is a contract, not a security boundary.** All renderer code runs
in one world; trust gating is the boundary.

## Module events (main → renderer)

`MainHost.emit(topic, payload?)` pushes to your own
`RendererHost.subscribe(topic, cb)`. Only your module's subscribers receive
it; one emit reaches every open window, in order per module. **Nothing is
replayed**: keep the durable answer readable through an IPC channel and let
the event say "read it again". Payloads must be structured-cloneable; delivery
pauses while your module is off.

## Module storage

`getModuleStorage(host)` → `get` / `set` / `delete` / `list`, keyed per module
and optionally per workspace. Workspace keys live in the project's store in
the person's home (`~/.sprintengine/workspaces/<project>/modules/<moduleId>/`),
never in the project's folder; global keys under the app's data; JSON
values up to 1 MB, atomic writes. Declare `storage` and
`dependsOn: ["agent-runtime"]`.

`list({ prefix })` and `getMany({ keys })` read a record family in one call
(`supports('storage-query')`). `watch({ workspaceRoot? }, cb)` says which keys
changed: your own writes at once, and a change made by other means — a
hand edit — within a couple of seconds (`supports('storage-watch')`).
Workspace keys do not travel with a clone; data that belongs to the project
is a file your module writes where the person asks. Data past the value limit
belongs in `host.getModuleDataDir()` (`supports('module-data-dir')`).

## Workspaces from entry.main

```ts
import { WorkspaceContextToken, WorkspaceServiceToken } from '@sprintengine/module-sdk'

const created = await host.requireService(WorkspaceServiceToken).create({ name: 'Scratch', folderPath: '/abs/path' })
const view = await host.requireService(WorkspaceContextToken).get(workspaceId) // { id, name, folderPath, mode } | null
```

`create` resolves once the workspace is confirmed, so a returned id is real.
The context service (declare `ipc:workspace-read`) also has `list()`: the open
workspaces, each with `open: true`. `list({ includeClosed: true })` adds the
workspaces closed on this machine, newest first, with `open: false` and
`closedAt` (`supports('workspace-history')`), so a module can tie what it kept
back to a project that is no longer open. `host.getWorkspaceGitInfo(id)` reads
a workspace's branch and remotes without parsing `.git` yourself.

<!-- Backlog, usage and activity services -->

## The Backlog

A module reads and changes a workspace's Backlog through the host, never by
reading or writing item files itself. `getBacklogService(host)` in
`entry.main`, and the same calls on `RendererHost`:

```ts
import { getBacklogService } from '@sprintengine/module-sdk'

const backlog = getBacklogService(host)
const created = await backlog.create(workspaceId, { title: 'Faster refunds', status: 'ready', epic: 'payments' })
if (created.ok) console.log(created.displayId, created.relativePath) // "MC-241", "backlog/payments/2026-10-09-faster-refunds.md"
await backlog.updateStatus(workspaceId, itemId, 'in_progress')
await backlog.addLink(workspaceId, itemId, { id: 'board-chat', type: 'agent', label: 'Board chat', target: { kind: 'chat', id: agentId } })

// renderer
const moved = await host.updateBacklogStatus(workspaceId, item.id, 'completed')
```

- `itemId` is a `BacklogItemView.id` (the item's logical path, `backlog/…`).
- Every write is a call into the app's own Backlog service, in the project's
  mutation lane, so it never interleaves with another writer. `create` takes
  the app's create path: it allocates the next number, files the item under
  its epic's folder with a unique name, and answers `{ id, relativePath,
  path, numericId, displayId }`.
- `addLink` records the link as your module's (a `moduleId` naming another
  module is refused); `updateModuleMetadata` writes your module's entry only.
- `getLocation` / `getBacklogLocation` answer `{ root, isDefault, exists }`:
  where the item files are, including a Backlog the person moved elsewhere.
- `list(workspaceId)` (main) reads the items from disk now.
- Answers are `{ ok: true, … }` or `{ ok: false, code, message }` with a
  `ModuleBacklogErrorCode`; values outside the app's vocabulary are refused
  as `invalid_input`, never guessed.
- `BacklogItemView` carries `numericId`, `displayId` (`MC-240`, with the
  workspace's key), `epic` and `modifiedAt`.
- `watchBacklogItems(workspaceId, cb, { onError })`: `onError` hears a
  workspace with no folder, one that cannot be resolved, or a Backlog that
  could not be read. The watch stays open and calls `cb` again after the next
  readable scan.

Declare `backlog.read` for reads and `backlog.write` for writes; the host
checks both. `host.supports('backlog-write')` says whether the host has the
write API.

## Token usage

`getUsageService(host).query({ from, to, groupBy })` answers token usage of
every agent session on this machine: Studio's chats, and the Claude Code and
Codex sessions a person ran in a terminal (read from the CLIs' own session
logs). The renderer twin is `host.queryUsage(query)`.

```ts
import { getUsageService } from '@sprintengine/module-sdk'

const usage = getUsageService(host)
const week = await usage.query({ from: Date.now() - 7 * 864e5, to: Date.now(), groupBy: ['day', 'model'] })
// week.rows: [{ day: '2026-10-08', model: 'claude-opus-4-1', tokens: { input, output, cacheRead, cacheWrite }, requests, reportedCostUsd }]
const off = usage.onChanged(() => refreshMyView())
```

- `groupBy` is any of `day` (local calendar day), `model`, `provider`,
  `workspace` and `session`; without it the query answers one total row.
- A session a Studio chat ran is counted once: from the CLI's own log when this
  machine has it, under the chat's workspace, agent id and title. A terminal
  session is attributed to the open workspace whose folder holds it (a
  worktree is followed to its repository); `workspaceId` is null otherwise.
- The service returns tokens; pricing them is your module's job.
  `reportedCostUsd` is set only for turns whose tokens come from a Studio
  transcript, where the runtime reported a cost.
- Usage is kept to the hour, so a window is too.
- Nothing is read at startup. The first query waits for the first read of the
  logs (seconds on a large history; incremental after that, cached across
  runs); later queries answer at once and read again in the background.
  `onChanged` fires after a read that changed the numbers.

Declare `usage:read` (the consent prompt says "See token usage and cost of
every agent session on this machine"); check `host.supports('usage')`.

## The person's chats (activity)

`getActivityService(host)` reads the person's Studio chats in every open
workspace, read-only:

- `listChats({ from?, to?, workspaceId? })` → `{ workspaceId, agentId, title,
  cli, providerId, model, createdAt, updatedAt, turnCount, status }` per chat,
  newest first.
- `prompts({ from, to, workspaceId?, limit? })` → `{ at, workspaceId,
  agentId, text, replyTail? }`: each message the person sent, with the last
  few hundred characters of the agent's reply. `limit` defaults to 200 (at
  most 1000); `truncated` says older ones were left out.

It never returns tool calls, tool output, reasoning or attachments, and every
event is redacted the way the conversation service redacts what it hands
modules. Messages the app sent on the person's behalf are not theirs and are
left out. Chats in closed workspaces, and agent sessions outside Studio, are
not covered.

Declare `conversation:read-all`. Its consent prompt says "Read every chat on
this machine, including what you and the agents wrote" and is flagged as a
broad scope, so ask for it only when reading the person's chats is the point
of the module. Check `host.supports('activity')`.

## Scheduled agents

A scheduled agent is a prompt and a cron schedule: each time the schedule
comes round, a new chat starts in the project with that prompt as its first
message, on the CLI, model, permissions, skills, MCP servers and worktree
setting it was made with. Nothing carries from one run to the next. A module
creates its own with `getScheduledAgentsService(host)` (declare
`scheduled-agents.manage` and `dependsOn: ["scheduled-agents"]`). Every method
is scoped to your module: `list` returns only yours, and `update`, `remove`
and `runNow` refuse an id you did not create. They appear in the person's
sidebar like the ones they make themselves, and they can close them.

```ts
import { getScheduledAgentsService, type RegisterMain } from '@sprintengine/module-sdk'

export const registerMain: RegisterMain = (host) => {
  host.registerIpc('weather-deck:schedule-refresh', async (_event, folderPath: string) => {
    const created = await getScheduledAgentsService(host).create({
      prompt: 'Refresh the forecast notes for the watched city.',
      schedule: { cron: '0 9 * * 1-5', timezone: 'Europe/Dublin' },
      folderPath,
      hostId: null,
      cli: 'claude-code',
      cliModel: null,
      permissionPreset: null,
      skills: [],
      mcpServers: [],
      worktree: null,
      name: 'Morning forecast', // the sidebar's title; absent, the prompt's first line
      tag: 'city:dublin', // your own label; each run's chat carries it
    })
    return created.ok ? created.agent.id : null
  })
}
```

To follow a run, listen with `onRun((agent, run) => …)`: it names each run's
chat (`run.workspaceId`, `run.agentId`) as it starts, a one-time schedule's
included (it closes itself straight after, so `onChanged` never shows that
run). The chat is your module's, so the conversation service follows it, and
its summary carries `scheduledAgentId` and `scheduledAgentTag`; `lastRun` also
names its `agentId`. A repeating schedule's times missed while the app was
closed are not replayed (the next run counts from start-up); a one-time
schedule missed that way runs once the app is open; times missed while the
computer slept run once on waking; and a time that comes while the previous
run is still working is skipped, not queued. Check
`host.supports('scheduled-agent-runs')` before relying on `name`, `tag` or
`onRun`.

## Skills a module ships

```ts
host.registerSkills([
  { id: 'my-review-guide', sourceDir: 'skills/my-review-guide', targetPolicy: 'all-native', description: 'Walk a reviewer through a change.' },
])
```

Ship each skill as `module/skills/<id>/SKILL.md`. `sourceDir` is relative to
your module root (the `module/` folder) and must stay inside it; the skill's
files are module files, signed with the rest. An id a built-in skill or another
module holds is a registration error, and unloading your module takes its
skills with it. `'agents'` installs into `.agents/skills/<id>`; `'all-native'`
also into every installed agent's own skill directory — pick it whenever a
prompt invokes the skill by name.

Registering writes nothing to a workspace. A skill reaches a chat when the
chat's launch names it (`create` / `openChat` / a scheduled agent's `skills`
install it before the first turn), or once `ensureSkillInstalled(workspaceRoot,
id)` has put it in the workspace — after that every new chat there finds it,
the person's own included. `getSkillStatus(workspaceRoot, id)` asks without
writing. Both never throw and answer a `ModuleSkillStatus`: `installed`,
`updated`, `missing`, `update-available`, `local`, `modified`,
`delivered-at-launch`, `missing-source`, `missing-workspace`, `unknown-skill`,
`install-failed`.

## Accepting drags from the Backlog and Files panels

`readFileDropPayload(dataTransfer)` reads the published payload under
`SPRINTENGINE_FILE_DROP_MIME` and returns `null` — never throws — for anything
it does not recognise. `hasFileDropData` is the `dragover`-safe presence check;
`setFileDropData` originates a drag the app's own drop targets accept.

## Theme tokens

`THEME_TOKENS` lists the CSS custom properties present in every app theme.
Use them as CSS variables (`var(--bg-surface)`); only the names are contract.

| Family | Tokens |
|---|---|
| Chrome | `--bg-app`, `--bg-surface`, `--bg-surface-raised`, `--bg-hover`, `--bg-selected` |
| Border | `--border-subtle`, `--border-default`, `--border-strong` |
| Text | `--text-strong`, `--text-default`, `--text-muted`, `--text-subtle`, `--text-disabled`, `--text-on-accent` |
| Accent | `--accent-primary`, `--accent-primary-soft`, `--focus-ring` |
| Tone | `--tone-neutral`, `--tone-accent`, `--tone-warn`, `--tone-good`, `--tone-error`, `--tone-merged` |
| Motion | `--motion-normal`, `--motion-ease` (use as a pair) |

## UI kit, surface shell and Monaco

| Specifier | What it is |
|---|---|
| `@sprintengine/module-sdk/ui` | A curated slice of the app's component kit |
| `@sprintengine/module-sdk/surface` | The door shell and its rail/canvas substrate |
| `@monaco-editor/react` | The Monaco wrapper the app ships |

These are **host-provided**: this package ships their types, and the `.js`
behind `./ui` and `./surface` throws if evaluated. The app answers them (and
`react`, `react-dom`, `react-dom/client`, `react/jsx-runtime`) from an import
map, so mark every one external:

```
esbuild src/renderer.tsx --bundle --format=esm --outfile=module/dist/renderer.mjs \
  --external:react --external:react-dom --external:react-dom/client \
  --external:react/jsx-runtime --external:@monaco-editor/react \
  --external:@sprintengine/module-sdk/ui --external:@sprintengine/module-sdk/surface
```

`/ui`: `GhostButton`, `OutlineButton`, `PrimaryButton`, `Banner`,
`PanelHeader`, `Drawer`, `EmptyState`, `Field`, `Input`, `Textarea`,
`DateTimeInput`, `Toggle`, `InlineNotice`, `KbdChord`, `LifecycleGlyph`,
`LinkButton`, `RowButton`, `Section`, `SegmentedControl`, `Select` (with a
`size`), `Spinner`, `StatusDot`, `TruncatedText`, `Chip`, `ChipButton`,
`ContextMenu`, `MenuItem`, `MenuDivider`, `TaskCard`, `BoardLane`,
`SafeMarkdown`, `SidebarNavButton`, `CliModelPickerButton` (feed it
`host.listChatRuntimes()` directly), `FOCUS_RING_CLASS`, and their props.
`/surface`: `GlobalSurfaceShell`, `useSurfaceBackNav`, `SurfaceRail`,
`SurfaceCanvasState`, and their props.

Charts take the ordered categorical series `--chart-1` … `--chart-8` and the
neutral `--chart-other` from `THEME_TOKENS` — never a status tone as a series.

**Tailwind classes you write produce no CSS** — the app's build scans app
source only. Write plain CSS against the theme tokens, or build a
stylesheet of your own and inject it once when your renderer registers (the
`panel` template's `src/styles.ts` does this).

## Signing and packaging

```sh
npx sprintengine-module keygen --out ~/.sprintengine/keys/my-extension.key   # once; keep it out of the project
npx sprintengine-module sign module --key ~/.sprintengine/keys/my-extension.key
npx sprintengine-module verify module
npx sprintengine-module pack module --out dist/my-extension
```

`sign` validates the manifest, records the sha256 of every file the module
ships in `files`, and signs the normalized manifest. `verify` checks the
signature and every file against `files`. `pack` copies an installable module,
leaving out `node_modules`, `.git` and key files. Sign again after every build.

**`files`** maps each file's POSIX path (relative to the module root) to its
lowercase sha256, for every file except `manifest.json`; a changed, missing or
extra file is a mismatch. It is part of the signed payload, so a signature
covers the code. A module whose manifest has no `files` does not load at all —
signed or not — and `npm run dev:install` writes it for an unsigned local
build. The checks are exported for tooling: `validateModuleFileDigests`,
`compareModuleFileDigests` (root, pure); `computeModuleFileDigestsSync`,
`moduleFileDigestIssuesSync` (`@sprintengine/module-sdk/signing`, Node).

For a bundle, `sprintengine-module plugin sign <dir> --key …` writes each
component's digests into `plugin.json` and signs it; sign the module first,
since signing rewrites its manifest. `plugin scaffold`, `plugin verify` and
`plugin pack` round it out. Bundle components are `mcp`, `skills` and
`module`.

## Installing

- **On your machine:** `npm run dev:install` builds, writes `files`, signs when
  a key is at `~/.sprintengine/keys/<id>.key` (and the signature no longer
  covers the files), and copies `module/` into
  `~/.sprintengine/modules/<id>/`. Studio asks you to trust it (again after each
  rebuild, since trust binds to exact contents). **Settings → Modules → Install
  a module from a folder** does the same for a packed folder.
- **From GitHub:** anyone can install from the repository URL (the Extensions
  door's **Install extension from GitHub…**). Studio resolves the default branch
  to a commit, reads **`plugin.json` at the repository root**, shows its name,
  publisher, permissions and whether it is signed, and installs the `module/`
  folder it names. Commit `module/dist/` and the `module/manifest.json` its build
  produced (with `files`): `npm run build` records the digests, and writes the
  manifest only when they changed, so it is modified in git exactly when
  `module/dist/` is. An **unsigned** module is allowed: Studio warns that
  nobody vouches for the code and requires an explicit "I trust this code"
  choice. An update re-checks the commit and asks again when the permissions
  or the signing change. A repository with `.claude-plugin/` is a skill source,
  added from the Skills path instead.
- **From the marketplace:** a signed bundle listed in the registry; see
  [`docs/plugin-authors/README.md`](../../docs/plugin-authors/README.md) in the
  app repository.

## Packaged web runtimes and WebAssembly

`host.getAssetUrl('runtime/index.html')` returns a stable `studio-module:` URL
for a file in the installed module — use it as an iframe `src`. Relative
scripts, workers, WebAssembly (`application/wasm`) and IndexedDB work inside
it, under a private per-installation origin. The host checks trust and
enablement on every request and serves only files the module was verified
with, up to 128 MiB. Never store secrets in the module folder or log these
URLs; use the secrets broker. This is not a sandbox for hostile code.

## Opening a zero-config workspace

A folderless workspace type can set `openOnFirstLoad: true`: once the module is
trusted and enabled, the primary window creates a workspace from
`createTemplate()` (or opens the existing one) the first time, and never again
on its own. `host.openWorkspace(typeId)` reopens it from a command; it accepts
only your own types without a `creationStep` or `createWorkspace` hook.

A new renderer-only module loads as soon as it is trusted. A module with
`entry.main`, or an update to code already loaded, takes a restart.

## Intentional narrowings

The drift guard keeps these narrowings sound — an SDK-typed module is always
valid for the app:

- `WorkspacePanelProps` exposes `workspaceId` only.
- `deriveRunGlyph` receives `{ mode }` and returns the published
  `WorkspaceRunGlyphState` subset.
- `WorkspaceLayoutJson` is a conservative subset of the app's layout model.
- `BacklogItemView` widens enumerated app internals to `string`.
- `BacklogItemActionContext` and `FileActionContext` omit shell-internal hooks.
- `NotificationActionContext.notification` is `{ workspaceId?, navigationTarget? }`.
- `CompanionAgentEvent.type` is widened to `string`.

## Versioning

Semver; `1.0.0-beta.0` is the first release of this contract (see
`CHANGELOG.md`). The package version and the host API version move
separately: a new SDK release that only adds optional types keeps
`HOST_API_VERSION`, and a module declares the host API, not the package
version. In the app repository a drift guard (`drift/sdk-drift-guard.ts`,
`npm run test:sdk:drift`) fails the build whenever these declarations diverge
from the app's own contracts, and `npm run test:sdk:pack` imports every
published name from the packed tarball.

## License

MIT — see [`LICENSE`](./LICENSE). You may build extensions against this SDK and
distribute or sell them, including closed-source. Marketplace distribution is
covered by separate marketplace terms.
