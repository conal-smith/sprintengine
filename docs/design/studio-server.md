# Studio server — design and phased plan

Status: proposed, 2026-10-01. Phases 1 (the Electron seams), 2 (the Studio
RPC), 3 (the Electron-free core and the `studio-server` entry) and 4 (the chat
view over the protocol, behind the `SPRINTENGINE_CHAT_TRANSPORT=studio`
environment variable) have landed (section 13, "As
landed"); nothing after them is. Phases 5 to 10 were replanned on 2026-10-02
for a server with no browser and no canvas (section 1.1). This file replaces
the remaining steps of the agent SDK plan on `feat/studio-agent-sdk` (the work
after the protocol package and the tailnet lane and module service that speak
it) with the phases in section 13. When code and this file disagree, fix one of
them in the same change.

## 1. What is being built

Studio becomes a headless **Studio server** that every client builds on
(owner direction 2026-10-01):

- It runs on your own machine, inside a WSL distribution, or on a remote box
  installed over SSH.
- The Electron desktop app is one client of it. It spawns a local server, or
  connects to one that is already running somewhere else.
- A web page can connect to it, with the UI served by the server as a web app.
- `@sprintengine/agent-sdk` and `@sprintengine/conversation-protocol` are how
  third parties drive it. The protocol is published and documented; a client we
  did not write is a supported client, not a reverse-engineering project.

The server owns the data and the agents: conversations, providers and the
agent CLIs they run, checkpoints, the thread index, the MCP gateway, settings
and credentials, and raw access to its machine's files and git. Clients build
every view on that access, and supply the tools that need a screen.

### 1.1 The architecture principle: a small server (owner ruling 2026-10-02)

**The server is small.** It holds agents, conversations, the routing of tool
calls between agents and clients, pairing and permissions, and raw access to
its machine: read, list, search, watch and write files, run git, diffs,
workspaces. It has no browser and no canvas. Every view is a client thing
built on the server's machine access.

| The server                                                            | Clients                                                                                                         |
| --------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------- |
| Agents, providers, the agent CLIs, conversations, checkpoints         | The chat view, the composer, history                                                                            |
| Files: read, list, search, watch, write; git; diffs; workspaces       | The file explorer, editor, diff viewer, git pane, backlog, tours                                                |
| Canvas boards, as files                                               | The canvas: the editor, the hidden worker that draws, and the `canvas.*` tools agents call                      |
| The MCP gateway, and routing a tool call to the client that offers it | Toolsets they offer: the desktop `browser` (its pane) and `canvas`; the web client `canvas`; an SDK app its own |
| Pairing, devices, scopes, permission ceilings, audit                  | Pairing screens, Settings                                                                                       |
| Nothing that renders                                                  | The browser pane, and on the web a view of the server's dev servers (section 8)                                 |

Any attached client can offer **toolsets**. The server exposes them to agents
through the Studio MCP gateway and forwards each call to the client that
offers it (section 6.3, and the phase 5 spec,
[`studio-server/phase-5-client-tools.md`](studio-server/phase-5-client-tools.md)).
With no client offering a toolset, agents work without it: a tool an agent
was already shown answers that no client offers it. Why: a
browser and a canvas renderer are the heaviest, least portable parts of the
old plan (a Chromium per host, its libraries, fonts and sandbox), and every
client a person actually looks at already has a browser engine. Keeping the
server to agents, data and routing is what lets it run unchanged on a laptop,
in WSL and on a minimal Linux box.

### Owner rulings this design is built on

| Ruling                 | Text                                                                                                                                                                                                                                                                                                                 |
| ---------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| (a) Terminals          | Terminals are not served by the server, at least in v1. The focus is conversation/agent chat (owner ruling 2026-10-01).                                                                                                                                                                                              |
| (b) Canvas             | The server owns the board data and the agent-facing gateway tools; clients render (owner ruling 2026-10-01). Narrowed by (f): the boards stay the server's, as files; the `canvas.*` tools and all rendering are the client's.                                                                                       |
| (c) Panels             | The git panel, file explorer and editor are client renderings. v1 serves only the data chat needs: changed files, turn diffs, checkpoints and revert, attachments, @-mention file search, the workspace list. The full git panel and file explorer come later (owner ruling 2026-10-01).                             |
| (d) WSL                | On Windows, the server runs inside the distribution on the pinned Linux Node Studio already installs. Agents, git and files are native Linux, with no per-process `wsl.exe` path translation. The Windows app connects over localhost. The same pinned-Node streaming serves SSH installs (owner ruling 2026-10-01). |
| (e) Headless rendering | Superseded by (f). It said: the server has a headless mode for anything that needs rendering, with a headless Chromium for canvas boards and the agents' `browser.*` tools (owner ruling 2026-10-01).                                                                                                                |
| (f) A small server     | The server holds agents, conversations, tool routing, pairing and permissions, and raw machine access (files, git, diffs, workspaces). It has no browser and no canvas. Clients build the views and offer toolsets; the server routes agents' calls to them (owner ruling 2026-10-02, section 1.1).                  |

## 2. Goals and non-goals

**Goals**

1. One process owns a machine's Studio data and agents, and any number of
   clients (desktop windows, browser tabs, the phone, SDK scripts, another
   Studio) follow it at the same time without disagreeing.
2. A chat on a WSL distribution or a remote Linux box behaves exactly like a
   chat on this Mac: the agent, git and the files are all on that machine.
3. The desktop keeps working at every step of the migration. No phase leaves
   the app with a feature that worked before and does not now, except where a
   ruling removes it for a remote server (terminals).
4. Never an unauthenticated port. Every listener is owner-only by file
   permission, loopback with a token, or a tailnet address with pairing.
5. Third parties get the same protocol the desktop uses, versioned by the
   policy in `docs/compatibility.md`.
6. Agents get the tools their clients offer. The desktop offers its browser
   pane and its canvas, the web client its canvas, an SDK app whatever it is
   for, and the server routes each call to the client that offers it. With no
   such client attached, an agent works without those tools rather than
   failing on them.

**Non-goals for v1**

- **Terminals on the server** (ruling a). The desktop keeps its terminals for
  the machine it runs on (and for WSL through today's `wsl.exe` path), served
  by Electron main as today. A remote or headless server has none. The chat
  features that open a terminal (CLI sign-in, running a code block, Resume in
  terminal) are hidden on a server that does not advertise them.
- The full git panel, file explorer and editor over the protocol (ruling c).
- A browser or a canvas renderer in the server (ruling f), and with them any
  Chromium download, screencast or server-side drawing.
- A hosted relay, a cloud account, or a public HTTPS endpoint. Remote access
  is SSH or the tailnet.
- A native Windows server reached over SSH. Windows hosts run the server in WSL
  or as the desktop's own local server.
- Our own SSH implementation. The system `ssh` client is used, with the
  person's own config, agent and keys.
- Multi-user servers. A server belongs to the OS user that runs it.

## 3. Where things stand

### 3.1 What the main process is made of

The conversation core is already Electron-free. The coupling sits in the
composition root, the IPC layer and a handful of lazy `require('electron')`
calls.

| Group                | Key files                                                                                                                                                                                                                                                                   | Electron use                                                                                                                                    |
| -------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------- |
| Conversation runtime | `conversation-runtime.ts`, `conversation-session-api.ts` (the transport-independent replay/subscribe/command boundary IPC and the tailnet both wrap), `conversation-event-log.ts`, `conversation-transcript-reader.ts`, `conversation-*-store.ts`, `conversation-commands/` | none directly                                                                                                                                   |
| Providers            | `providers/claude-agent-provider.ts`, `codex-conversation-provider.ts`, `acp-conversation-provider.ts`, `openai-compatible-provider.ts`, `cli-host-child.ts`, `cli-child-process.ts`                                                                                        | none                                                                                                                                            |
| Launch               | `conversation-launch-service.ts`, `agent-launch-service.ts`                                                                                                                                                                                                                 | none                                                                                                                                            |
| Checkpoints          | `conversation-checkpoints.ts` (git refs under `refs/sprintengine/checkpoints/`), `checkpoint-sweep.ts`                                                                                                                                                                      | none                                                                                                                                            |
| Thread index         | `conversation-index.ts` (per-workspace `index.json` in the workspace sidecar)                                                                                                                                                                                               | none                                                                                                                                            |
| Git                  | `git-run.ts` (the one place git processes start), `git*.ts`                                                                                                                                                                                                                 | none                                                                                                                                            |
| MCP gateway          | `automation/automation-service.ts`, `mcp-socket-server.ts`, `mcp-dispatch.ts`, `studio-gateway-tools.ts`, `gateway-audit.ts`, the tool files                                                                                                                                | none; wired in `app-services.ts`                                                                                                                |
| Tailnet lane         | `automation/tailnet/*`                                                                                                                                                                                                                                                      | `tailnet-mesh-store.ts` lazily requires `safeStorage`                                                                                           |
| Canvas               | `canvas/canvas-service.ts`, `canvas-board-store.ts`                                                                                                                                                                                                                         | none; `canvas-worker-window.ts` is a hidden `BrowserWindow`; `canvas-subscribers.ts` holds `WebContents`                                        |
| Browser tools        | `browser/browser-control.ts` over `wc.debugger` and `capturePage`                                                                                                                                                                                                           | inherently Electron today                                                                                                                       |
| Module host          | `module-host/main-host.ts` (`IpcMain` injected), `load-modules.ts`, `module-conversation-service.ts`, `module-storage.ts`, `module-secrets.ts`                                                                                                                              | type-only, except `modules/agent-runtime-module.ts` (`app`, `safeStorage`) and `modules/scheduled-agents-module.ts` (`BrowserWindow` broadcast) |
| Settings             | `launch-settings-store.ts`, `workspace-registry-store.ts`, `module-host/enablement-store.ts`, …                                                                                                                                                                             | take `resolveUserDataDir`; `window-material-store.ts` imports `app`                                                                             |
| Credentials          | `secret-store.ts` (cipher and path injectable, lazy `require('electron')` fallback), `github-token-store.ts` (hard `app` + `safeStorage`)                                                                                                                                   | `safeStorage`                                                                                                                                   |
| Resources            | `plugin-registry-instance.ts`, `managed-runtime.ts`, `ripgrep-binary.ts`, `builtin-skills.ts`                                                                                                                                                                               | `app.isPackaged`, `app.getAppPath`, `process.resourcesPath`, asar-unpacked paths                                                                |
| File search          | `conversation-mentions.ts`, `filesystem-search.ts`                                                                                                                                                                                                                          | none (ripgrep path above)                                                                                                                       |

In numbers: 113 of 536 non-test files in `src/main` reference Electron, about
half of them type-only `IpcMain` imports in `src/main/ipc/*`. Seven use a lazy
`require('electron')`. `src/shared` has none. There are 42
`BrowserWindow.getAllWindows()` broadcast loops across 20 files; only four
files use the shared `broadcastToWorkspaceWindows` helper in `window-factory.ts`.

`app-services.ts` (`createAppServices`, about 2,200 lines) is the composition
root. It builds every service with closures over `app` and `BrowserWindow`.
`src/seams/moduleConversationSeam.test.ts` already composes the runtime, the
launch service, the gateway tools and the module host without Electron, which
is the closest thing to a headless composition recipe the tree has.

This section records where things stood when the design was written. Phase 1
has since routed the Electron uses in the table above through the platform
interfaces of section 4.2, except the canvas worker window, the canvas
subscribers and the browser tools. Under ruling (f) those stay in the shell
for good: they are what the desktop offers agents as its `canvas` and
`browser` toolsets (phase 5).

### 3.2 The IPC surface

`src/preload/index.ts` spreads 51 `api/*.ts` modules into one flat
`window.api` typed by `ElectronApi` (`src/shared/electron-api.ts`): **444
members** — about 370 invoke channels, 58 push subscriptions and 13 one-way
sends. 189 renderer files touch `window.api`, using about 390 distinct members.
The largest domains are git (62), filesystem (40), conversation (38), browser
(25), mesh (20), backlog (17), skills (17) and automation (18).

The chat view's own surface is much smaller (section 6.5): about 75 members.

The renderer already has the seam the migration needs.
`components/panels/agentChat/conversationTransport.ts` declares a
`ConversationTransport` with `kind: 'local' | 'remote'`, capability flags
(operate, startSession, checkpointRevert, modelSwitch, composerContext,
localFiles, …) and the calls a conversation view makes. The local
implementation reads `window.api`; the remote one rides the tailnet mesh. 18
call sites read it through `useConversationTransport()`. What it does not yet
cover — session start, providers, models and secrets, revert, the plan
document, the command catalog, @-mention search, history — are still direct
`window.api` calls.

### 3.3 Pieces to reuse

- **The tailnet conversation lane** (`src/main/automation/tailnet/`). A
  hand-rolled HTTP/WebSocket server (`tailnet-gateway-server.ts`,
  `websocket-frames.ts`) that refuses to bind anything but a tailnet or
  loopback address and refuses any request with an `Origin`. Pairing by
  one-time offer or by approval with a typed comparison code
  (`tailnet-devices.ts`); device tokens stored only as hashes, 0600; scopes
  (`workspace|backlog|conversation` × `read|operate`) read live on every frame;
  single-use 30-second WebSocket tickets (`ws-ticket`) so a token never sits in
  a URL; Tailscale `whois` binding a token to a node; a JSONL audit log
  (`gateway-audit.ts`) shared with the local MCP socket; close codes 4401
  (revoked), 4403 (scope lost), 4409 (resync). The conversation stream does
  snapshots in parts, a `synchronized` fence, cursor resume, delta merging,
  bounded queues and `busy` / `too_large` refusals. This is the server's
  network transport in all but name.
- **`@sprintengine/conversation-protocol`** after the full-contract step:
  events, commands with `commandId`, `ConversationCreateRequest`, the `hello`
  handshake (`protocolVersion`, `minProtocolVersion`, capabilities),
  `parseConversationClientMessage`, server-frame parsers for clients. No
  Electron, Node or React dependencies. The phone's byte pin covers five files;
  everything new goes in new files re-exported from `public.ts`.
- **The module SDK conversation service** (`module-conversation-service.ts`):
  ownership, the preset ceiling, namespaced command ids, idempotent create,
  follow from a cursor. It is the in-process client the RPC methods are shaped
  after.
- **The MCP socket server**: newline-delimited JSON-RPC on
  `<userData>/automation.sock` or a named pipe, owner-only by file mode, with
  discovery files and the `studio-run` launcher (`~/.sprintengine/bin/current`
  pointer) that keeps MCP entries valid across app updates.
- **Execution hosts** (`src/shared/execution-host.ts`, `src/main/hosts/`):
  `local` and `wsl:<distro>`. The WSL install pipeline (`wsl-node-runtime.ts`:
  pinned `v24.21.0`, SHA-256 per arch, downloaded on the Windows side;
  `wsl-install.ts`: streamed over `wsl.exe` stdin into a staging directory,
  `flock`, digest marker, `mv -T`, pruning) and the helper protocol
  (`resources/wsl-helper/`, newline JSON over stdio, a `boot` line then
  `hello`) are the template for both the WSL server and the SSH bootstrap.
- **`ConversationIpcHandlers`** (`ipc/conversation-ipc.ts`): a handler object
  with no IPC in it, bound to `ipcMain` by a thin function. Every domain that
  moves to the server gets this shape first.

There was no SSH host, no headless entry point and no Electron-free
composition root when this was written. Phase 3 added the last two
(`src/server/core/studio-core.ts`, `src/server/main.ts`); there is still no SSH
host.

## 4. Process architecture

```
               ┌───────────────────── Studio server (Node) ─────────────────────┐
               │ StudioCore                                                      │
 desktop  ─┐   │  conversations · providers · checkpoints · thread index        │
 web tab  ─┼─► │  workspaces · files (read/list/search/watch/write) · git       │
 SDK      ─┤   │  settings · credentials · module main halves                   │
 phone    ─┘   │  MCP gateway (automation.sock) ◄── agent CLIs via studio-run   │
  (RPC/WS)     │  tool routing ──call/reply──► toolsets the clients offer       │
               │ Listeners: owner socket · loopback (token) · tailnet (pairing) │
               └─────────────────────────────────────────────────────────────────┘

 Electron shell (desktop only): windows, menus, tray, dialogs, notifications,
 clipboard, deep links, auto-update, the person's browser pane and the hidden
 canvas worker (offered to agents as the `browser` and `canvas` toolsets),
 terminals for its own machine, the client-side settings, keychain access.
```

### 4.1 What runs where

| Concern                                                          | Server                        | Electron shell                           | Web client                                   |
| ---------------------------------------------------------------- | ----------------------------- | ---------------------------------------- | -------------------------------------------- |
| Conversation runtime, providers, agent CLIs                      | yes                           | —                                        | —                                            |
| Transcripts, thread index, checkpoints                           | yes                           | —                                        | —                                            |
| MCP gateway, audit, tailnet lane                                 | yes                           | —                                        | —                                            |
| Canvas boards                                                    | as files (read, write, watch) | the canvas module: editor, merge, worker | the canvas module: editor, merge, worker     |
| Agents' `browser.*` and `canvas.*` tools                         | routes calls to a client      | offers `browser` (the pane) and `canvas` | offers `canvas`                              |
| Workspace registry                                               | yes                           | caches a snapshot                        | caches a snapshot                            |
| Launch settings, CLI runtimes, approval rules, module enablement | yes                           | —                                        | —                                            |
| API keys, CLI logins                                             | yes (on the server host)      | sends a key once                         | sends a key once                             |
| Windows, menus, tray, dock badge                                 | —                             | yes                                      | one tab                                      |
| Native dialogs                                                   | —                             | yes                                      | server-side folder browser                   |
| Notifications                                                    | emits events                  | shows OS notifications                   | Web Notifications                            |
| Clipboard, open external, reveal in folder                       | —                             | yes                                      | `navigator.clipboard`, `window.open`, hidden |
| The person's browser pane (`WebContentsView`)                    | —                             | yes, every server (8.1)                  | previews of the server's dev servers (8.2)   |
| Terminals                                                        | — (ruling a)                  | yes, for its own machine and WSL         | —                                            |
| Appearance, window material, update channel, background mode     | —                             | yes                                      | browser storage                              |
| Auto-update of the app                                           | —                             | yes                                      | —                                            |
| Server install and upgrade (WSL, SSH)                            | answers `--version`           | drives it                                | —                                            |

### 4.2 The interfaces that replace Electron in server code

Server code imports none of `electron`. What it used Electron for becomes a
small interface in `src/server/platform/`, with an Electron implementation (used
while the core still runs inside main) and a Node implementation (used by the
standalone server).

| Interface                                                                                                                                    | Replaces                                                                                                                                               | Node implementation                                                                                                           |
| -------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------ | ----------------------------------------------------------------------------------------------------------------------------- |
| `StudioPaths` — `dataDir`, `logsDir`, `isPackaged`, `resourcesDir`, `appRoot` (`cacheDir` and `runDir` arrive with the phases that use them) | `app.getPath`, `app.isPackaged`, `app.getAppPath`, `process.resourcesPath`                                                                             | from `--data-dir` / the bootstrap envelope; XDG defaults (`defaultServerLocations`); the bundle's own directory for resources |
| `SecretCipher` — `available()`, `seal(text)`, `open(bytes)`                                                                                  | `safeStorage`                                                                                                                                          | a data key from the bootstrap envelope (desktop-spawned), else a 0600 key file in `<dataDir>/run/` (see 9.3)                  |
| `ClientBus` — `publish(topic, payload)` (`publishTo(clientId, …)` when the router exists)                                                    | `BrowserWindow.getAllWindows()` loops, `webContents.send`, `broadcastToWorkspaceWindows`                                                               | fans out to RPC subscriptions                                                                                                 |
| `Notifier` — `notify({ key, title, body, onActivate })`                                                                                      | `Notification`, the bell                                                                                                                               | a `notifications` stream clients render                                                                                       |
| `AppIdentity` — `version` (the build stamp and channel join it with `welcome`)                                                               | `app.getVersion`, the build stamp                                                                                                                      | baked into the bundle                                                                                                         |
| `ClientDirectory` — which attached clients offer which toolsets (reveal a tab, open an editor, show a tour, `browser`, `canvas`, …)          | `BrowserWindow` lookups in the editor, tour and canvas-open tools; the hidden canvas worker window and `wc.debugger` as the gateway reaches them today | client capabilities and toolset offers from `hello` and after it (6.4, phase 5)                                               |
| `PowerEvents` (optional)                                                                                                                     | `powerMonitor`, `net.isOnline`                                                                                                                         | none; the shell forwards wake and online hints as client events                                                               |

`IpcMain` disappears from server code entirely: every domain exposes a handler
object (the `ConversationIpcHandlers` shape) and is registered on the RPC router
and, during the migration only, on `ipcMain` by the shell.

A guard test (`src/server/electron-boundary.test.ts`) walks the import graph
from everything under `src/server/` and from a list of the server-bound files
still in `src/main/`, and fails on any path to `electron`, so the boundary is
enforced by a test rather than by review.

The process installs one platform before it builds anything
(`installStudioPlatform`): Electron main does it first thing in its entry, and
the standalone server will in its own. A store that is constructed takes its
piece as an option and falls back to the installed platform; a free function
deep in the call graph reads the installed one when it is called.

### 4.3 Modules split along the same line

Every module — canvas, backlog, git, design, scheduled agents, review, and
third-party modules — splits into a **server half** (its data, its
agent-facing gateway tools, its protocol methods) and a **client half** (its
UI). The module SDK already draws this line: `entry.main` is the server half
and `entry.renderer` is the client half. A module can have no server half at
all: under ruling (f) the canvas is a client module whose boards are files the
server reads and writes for it, and whose agent tools are a toolset the client
offers.

| `MainHost` member today                    | On the server                                                                                                          |
| ------------------------------------------ | ---------------------------------------------------------------------------------------------------------------------- |
| `registerIpc(channel, handler)`            | a protocol method `module.invoke { moduleId, channel, payload }`, routed by the same ownership and `ipc:invoke` checks |
| `emit(topic, payload)`                     | the `module.events` stream, per module, nothing replayed (as today)                                                    |
| `registerMcpTools`                         | the server's gateway, unchanged                                                                                        |
| `notify`                                   | the server's `Notifier`                                                                                                |
| `provideService` / `getService`            | unchanged, in the server process                                                                                       |
| `registerSkills` / `ensureSkillInstalled`  | unchanged, on the server host's disk                                                                                   |
| `registerSidecar`                          | unchanged, spawned on the server host                                                                                  |
| storage, secrets, the conversation service | unchanged, on the server                                                                                               |

| `RendererHost` member                                     | In a client                                                                          |
| --------------------------------------------------------- | ------------------------------------------------------------------------------------ |
| `registerPanel`, surfaces, commands, settings sections, … | unchanged                                                                            |
| `invoke(channel)` / `subscribe(topic)`                    | carried by `module.invoke` / `module.events`                                         |
| workspaces, backlog, chats, app state                     | the matching protocol methods                                                        |
| `getAssetUrl`                                             | an HTTP path the server serves (`/modules/<id>/assets/…`), signed per client session |

Consequences:

- A module's main half runs on the **server host**. Trust is granted on that
  host, against that host's copy of the module, by its owner. A desktop client
  connected to a remote server lists the remote's modules; installing one there
  is an owner-scoped call.
- Bundled modules that are still wired statically in `app-services.ts` and
  `register-core-ipc.ts` (canvas, backlog, git, design, review) are split the
  same way when their domain moves (phase 10), and land on the kernel as
  `createBundledMainModules()` entries rather than as static wiring. Canvas
  is the exception: it has no server half to split off, and its main-side
  service stays with the desktop shell, which offers it as the `canvas`
  toolset (phase 5).
- A third-party `entry.main` that `require`s `electron` cannot run on a
  headless server. The host advertises a host capability (`electron-main`) only
  when it is the in-process core, so a module can check `host.supports` and
  degrade. Whether that is a host API bump is an open question (section 15).

## 5. The Studio protocol

### 5.1 Shape

One WebSocket per client connection, multiplexing every namespace. (The tailnet
conversation lane opens one socket per conversation; that stays as the phone's
wire until phase 10 folds it in.) Frames are JSON text; images and uploads go
over HTTP beside the socket.

```
client → server
  { t: 'hello', protocolVersion, client: { kind, name, version, capabilities, instanceId } }
  { t: 'req',   id, method, params }                 // read or command
  { t: 'sub',   id, topic, params, cursor? }         // open a stream
  { t: 'unsub', id }
  { t: 'reply', id, ok, result | error }             // answer to a server 'call' (phase 5)
  { t: 'progress', id, progress?, total?, message? } // a long client tool call is alive

server → client
  { t: 'welcome', … }                                // see 5.3
  { t: 'res',   id, ok: true, result } | { t: 'res', id, ok: false, error: { code, message, retryAfterMs? } }
  { t: 'snapshot', sub, … } { t: 'event', sub, seq, … } { t: 'synchronized', sub, … }
  { t: 'subFailed', sub, code, retryable, retryAfterMs? }
  { t: 'call',  id, toolset, tool, input, context, timeoutMs }  // a client tool call (6.3)
  { t: 'cancel', id, reason }                        // the server gave up on a call
  { t: 'chunk', … }                                  // a frame over the size limit
```

Rules carried over from the conversation lane, unchanged in meaning:

- Every mutation carries a client `commandId`, recorded as a durable receipt
  before work starts; a retry is answered with the first attempt's result.
- Every refusal is correlated to the id of what it refuses.
- Streams resume from a cursor (`afterSeq` and `generation`); a cursor the
  server cannot vouch for gets a reset snapshot. Sequence numbers increase with
  gaps.
- Large frames are chunked; slow readers get deltas merged, then a resync close
  with a growing `retryAfterMs`; requests beyond the per-connection bound are
  answered `busy`.

The conversation stream's payloads are the existing `ConversationServerFrame`
payloads wrapped with a `sub` id, so the desktop, the SDK and the phone parse
one vocabulary. New namespaces add their own topics and methods.

As built in phase 2, a stream frame is `{ t: 'frame', sub, frame }`, the inner
`frame` being the conversation lane's `snapshot`, `event` or `synchronized`
exactly, so a client validates it with `parseConversationServerFrame`; and a
server closing a connection says why first, `{ t: 'bye', code, message,
retryAfterMs? }` (`revoked`, `resync_required`, `shutting_down`,
`unauthorized`, `unsupported_protocol_version`, …), standing in for the
WebSocket close codes the tailnet lane uses. On the owner socket each frame is
one line of JSON, the automation socket's framing; a WebSocket carries the same
frames one per message. The conversation commands are one method each, named
after the command kind they carry (`conversation.resolveApproval`,
`conversation.answerQuestion`, …, where 5.2 says `respond`), with params read
by `parseConversationClientMessage`.

Every method declares its required scope in one table
(`STUDIO_METHOD_SCOPES`), typed so that a method without an entry does not
compile. The router checks it on every request, as the tailnet lane re-reads
grants on every frame.

### 5.2 Namespaces, in the order they land

| Namespace          | v1?                   | Methods and streams                                                                                                                                                                                                                                                                                                                                                                                                                                              |
| ------------------ | --------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `server`           | yes                   | `hello`; `info` (version, environment, data dir for owners); `shutdown { drain }`; `logs.tail` (owner)                                                                                                                                                                                                                                                                                                                                                           |
| `conversation`     | yes                   | `list`, `create` (`ConversationCreateRequest`), stream `session`, stream `events` (the list-level feed), `loadEarlier`, `toolDetail`, `turnDiff`, `send`, `interrupt`, `respond`, `resolvePlan`, `setPermissionPreset`, `setModel`, `revert`, `rewind`, `fork`, `rename`, `delete`, `stop`, `suspend`, `threads`, `search` (+ stream), `planDocument`, `attachment`, `peek`, `compact`, `generateTitle`, `commands` (+ stream)                                   |
| `providers`        | yes                   | `list`, `models`, `discoverModels` (+ stream), `secrets.status`, `secrets.set`, `secrets.clear`, `signIn` (6.6)                                                                                                                                                                                                                                                                                                                                                  |
| `workspaces`       | yes                   | `snapshot`, `eventsAfter`, stream `changes`, `dispatch` (the subset chat needs: open, rename, close), `repoRoot`                                                                                                                                                                                                                                                                                                                                                 |
| `files`            | yes (chat subset)     | `search` (purpose `mention`) + `cancelSearch`, `stat`, `readImage`, `browse` (directory listing for the folder picker), `readText` (composer skill reader), `upload` (HTTP). Phase 5 adds the first write and watch members, owner only: `roots`, `list`, `read`, `write` and `remove` (`*.excalidraw` only in v1, conditional on the file's hash), a `root` form of `stat`, and a `watch` topic, which the canvas keeps its boards through (phase 5 spec §10.3) |
| `skills`           | yes (read)            | `listSources`, `scan`                                                                                                                                                                                                                                                                                                                                                                                                                                            |
| `settings`         | yes (launch settings) | `launch.get`, `launch.update`, stream `launch.changes`, `hosts.list`                                                                                                                                                                                                                                                                                                                                                                                             |
| `notifications`    | yes                   | stream                                                                                                                                                                                                                                                                                                                                                                                                                                                           |
| `tools`            | phase 5               | `offer`, `withdraw`, `focus` (a routing hint), `catalog` (+ push topic), `grant` (owner); the `call`, `cancel`, `reply` and `progress` frames carry the calls (6.3, phase 5 spec §4). Replaces the `canvas` and `browser` namespaces planned before ruling (f)                                                                                                                                                                                                   |
| `previews`         | phase 9               | `list` (ports the server's agents listen on), `open`, `close`: a dev server on the server's loopback, passed through on an origin of its own (8.2)                                                                                                                                                                                                                                                                                                               |
| `module`           | phase 10              | `list`, `invoke`, stream `events`, `assets`                                                                                                                                                                                                                                                                                                                                                                                                                      |
| `git`, `fs` (full) | later                 | the git panel and file explorer data (ruling c)                                                                                                                                                                                                                                                                                                                                                                                                                  |
| `auth`             | phase 8               | `devices.list`, `devices.revoke`, `pairing.offer`, `pairing.requests` (owner only)                                                                                                                                                                                                                                                                                                                                                                               |

### 5.3 Handshake, versioning and capabilities

`hello` is the first frame. The server answers `welcome`:

```
{
  t: 'welcome',
  protocolVersion, minProtocolVersion,            // STUDIO_PROTOCOL_VERSION window
  server: { version, buildStamp },
  environment: { id, label, os, arch, hostKind: 'local' | 'wsl' | 'ssh' | 'tailnet', home },
  capabilities: [ 'conversations', 'conversation-create', 'files-mention', 'client-tools', 'previews', … ],
  conversation: { protocolVersion, minProtocolVersion, capabilities },   // the existing conversation hello answer
  grant: { scopes, owner: boolean },
}
```

- `STUDIO_PROTOCOL_VERSION` is an integer with one version of slack, refused at
  the handshake by an error that names both numbers — the policy in
  `docs/compatibility.md`, which gains a row for this wire. The conversation
  protocol's own version and capability list nest inside, unchanged, so a
  client that only speaks conversations reads exactly what it reads from the
  tailnet lane today.
- Features are asked about by capability, never by version. A purely additive
  namespace or method ships as a capability with no bump.
- `environment.id` is a stable random id minted when a data directory is
  created. A client keys its caches and its saved connections on it, so a
  server reached by two routes (an SSH tunnel and the tailnet) is recognised as
  one.
- An unauthenticated `GET /.well-known/sprintengine-studio` answers the
  product, `server.version`, the protocol window and the auth methods it
  accepts, and nothing else (no label, no paths), so a client can tell "wrong
  version" from "wrong credentials" before it pairs. It is the tailnet lane's
  `health` route, generalised.
- The client's `hello` carries its own capabilities (6.4), a `kind`
  (`desktop`, `web`, `app` or `headless`, read only from an owner grant) and
  an `instanceId` that stays the same across one process's reconnects, so the
  server can tell two desktops on one owner grant apart. The toolsets it
  offers follow as `tools.offer` requests (6.3).

### 5.4 Where the protocol lives

The protocol is `@sprintengine/studio-protocol` (owner ruling 2026-10-01), a
package of its own that depends on `@sprintengine/conversation-protocol` and
re-exports all of it, so a client imports one package. The conversation
package stays the conversation lane on its own, the phone's subset, and its
five pinned files are untouched: the Studio protocol adds the connection around
the contract rather than growing inside it. In this repository the protocol's
one bridging file re-exports the conversation package's source by path, and
its build swaps that file for the published dependency; the pack check
installs the tarballs together. New namespaces are new files in the Studio
protocol package.

`@sprintengine/agent-sdk` is the client library built on it, for Node and the
browser: connect (owner socket, loopback with a token, or a ticketed WebSocket
URL), `hello`, typed calls, stream resume with stored cursors, reconnection
with backoff, command-id retry. The desktop renderer and the web client use
the same library, so the public client is the one the app itself depends on.

### 5.5 The preload becomes a thin client

The renderer talks to the server directly over the WebSocket, through
`@sprintengine/agent-sdk`, exactly as the web client does. The preload keeps
only what a browser page cannot do:

- `studioConnection.current()` — the descriptor of the environment this window
  is attached to and a **ticket** for it. Main holds the long-lived credential
  and mints a single-use ticket per connection; the renderer never sees the
  token.
- Shell APIs: windows and aux windows, menus, dialogs, clipboard, open
  external, reveal in folder, notifications, the browser pane, terminals for
  the local machine, auto-update, deep links, appearance and window material,
  the splash and startup marks.
- The environment manager: saved connections, the SSH and WSL bootstrap, and
  the per-environment status (section 10), because spawning `ssh` and
  `wsl.exe` is the shell's job.

During the migration `window.api` keeps its shape. A renderer-side adapter,
`createServerBackedApi(client)`, implements the moved members on top of the SDK
client and is merged over the IPC-backed object, domain by domain. 189 files
keep calling `window.api.conversationSessionSendTurn` while the call stops being
IPC underneath, and each domain's call sites are moved to the SDK's own typed
calls afterwards, at leisure. The same adapter, with the shell members filled
by browser fallbacks, is the web client's `window.api` (section 11).

### 5.6 How the IPC channels migrate

| Bucket                                                 | Members (approx.) | Fate                                                                                                                                                                                                                                                                                                                    |
| ------------------------------------------------------ | ----------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **v1 server** — what the chat view and its panels call | ~75               | conversation (38), the command catalog, providers/models/secrets, `cliModelsDiscover`, launch settings, workspace sync, `searchFiles`/`cancelFileSearch`, `statPath`, `readImageDataUrl`, `getGitRepoRoot`, skills list/scan, `generateChatTitle`, `compactAgentSession`, `readConversationPeek`, `hostsList`           |
| **Shell, stays in the preload**                        | ~120              | window (19), browser pane (25), app menu, update, clipboard, dialogs, appearance, splash/startup/build-stamp, `openExternal`, `showItemInFolder`, `openFolderInTarget`, `getPathForFile`, terminals (21, for the local machine)                                                                                         |
| **Later server domains**                               | ~250              | git panel (62), file explorer/editor (most of filesystem's 40), backlog (17), skills management, marketplace, modules, mesh (folded into environments), automation/tailnet admin, canvas (a client module; boards via `files` from phase 5), tours, memory graph, design system, scheduled agents, pull requests, voice |

The rule for each domain that moves: extract a handler object with no IPC in it
(if it is not one already), register it on the RPC router, register the same
object on `ipcMain` for the window of time where both exist, switch the
renderer adapter, then delete the IPC registration. The push channels map to
streams one for one; a `BrowserWindow.getAllWindows()` loop in the handler's
service becomes a `ClientBus.publish`.

## 6. Conversations, agents and the gateway on the server

### 6.1 Agents

Providers, `cli-host-child.ts` and the launch services move into the server
unchanged. On the server host every CLI is local: `resolveCliExecutable`, the
login-shell PATH resolver and the managed npm prefix (`~/.sprintengine/node`)
run where the agents run. `managed-runtime.ts` runs npm on the server's own
Node instead of Electron's (`ELECTRON_RUN_AS_NODE` is only needed when the
server is Electron's Node, section 10.1).

### 6.2 The MCP gateway

The automation socket and its discovery files move with the server into its
data directory. Agents the server spawns are pointed at it through the
`studio-run` launcher, and the server rewrites `~/.sprintengine/bin/current` on
its own host at start, exactly as the app does today; on a WSL or SSH host that
pointer names the pinned Node and the server's payload directory. The
`external-local` MCP clients on that host (a CLI the person started in their
own terminal) find the same socket the same way.

The audit log stays one file per server, with new `connection.kind` values for
`owner-client`, `web` and `ssh-tunnel` beside `studio-agent`, `external-local`
and `remote-tailnet`.

### 6.3 Gateway tools a client supplies

Most tools are data, and the server answers them itself. The rest act on
something only a client has: a screen, a browser, a canvas. These are
**client tools**. An attached client offers a **toolset** with `tools.offer`
(a name, and for each tool a name, a description and a JSON Schema for its
input). The gateway lists the tools to agents under `<toolset>.<tool>`, and
each call goes to an offering client as a `call` frame and comes back as its
`reply`, with `progress` while it runs and `cancel` when the server gives up
on it. Routing keeps a conversation on the client it first used, then prefers
the client the person is looking at, then the one showing the calling agent's
workspace.

- **Built-in toolsets**, offered only by a client with the shell role: the
  desktop's `browser` (its pane, driven through its webview, as today) and
  `canvas` (the canvas service and its hidden worker window, moved to the
  client) in phase 5; `editor`, `tour` and `terminal` in phase 6. The web
  client may offer `canvas` (phase 9).
- **App toolsets**: a third-party app built on `@sprintengine/agent-sdk`
  offers its own (a game offers `spawn_enemy`), with the `tools:offer` scope,
  reaching the conversations it started unless the owner widens it.
- **Nobody offering.** An agent works without the tools. A tool it was already
  shown stays listed and answers `client_unavailable` until a client offers it
  again; a list only grows within one MCP connection, because several runtimes
  ignore `list_changed`.
- **Which agents reach the gateway.** Claude chats are handed it at launch,
  and terminal agents get it from the app's plugin or an entry pinned into the
  workspace's MCP config. Codex and ACP chats are not handed it today, so
  client tools reach them only once they are (decisions R86).

The phase 5 spec
([`studio-server/phase-5-client-tools.md`](studio-server/phase-5-client-tools.md))
has the frames, names, limits, routing, approval, and what happens to a call
whose client disconnects.

`terminal.*`, `agent.launch` and `backlog.work` need a terminal, which only the
desktop shell has (ruling a). They become the shell's `terminal` toolset in
phase 6, offered only while a desktop that has terminals is attached to a
server on its own PC: its local server, and its WSL servers through the
Windows-side front door, which can open terminals there (phase 7 §3.7,
§12.8). They are still never offered to a tailnet peer, as today. An SSH or
headless server does not list them.

### 6.4 Client capabilities

A client lists what it can do for the server in `hello.client.capabilities`.
What an agent calls is no longer one of them: the earlier list's
`browser-pane` and `canvas-render` became the `browser` and `canvas` toolsets
(6.3), and `editor` and `tour` follow in phase 6. What stays a capability is
what serves the server or the person rather than an agent: `notify`,
`reveal-tab`, and on the desktop's control channel `cipher` (phase 6). The
desktop lists them all; a web tab lists `reveal-tab` and `notify`; the SDK
lists none.

### 6.5 What chat needs in v1

From the chat view, its composer and panels (`AgentChatView.tsx`,
`agentChat/*`, `CheckpointDiffWindow.tsx`, `composerContextPicker.tsx`,
`changedFilesCard.tsx`, `NewAgentPanel.tsx`, the history palette and the
sessions store):

- the session stream, list events, load earlier, tool detail, plan document;
- send, interrupt, respond, plans, preset, model, stop, suspend, fork, rename,
  delete;
- turn diffs, changed files (`getGitRepoRoot`, `statPath`), revert and rewind;
- attachments both ways: images upload over HTTP and come back by a signed URL;
  `getPathForFile` stays a shell call whose bytes the client then uploads;
- @-mention search (`files.search` with purpose `mention`), the composer's skill
  reader, the slash-command catalog;
- providers, models, model discovery, secret status;
- the workspace list and its change feed, `hosts.list`;
- thread history and search, peek, compact, title generation.

`ConversationTransport` gains the members it lacks (start, providers, revert,
plan document, commands, mention search, history) or a sibling seam carries
them, so every chat call goes through one injected object and the
`kind: 'local' | 'remote'` distinction becomes "which environment", with
capabilities from `welcome`.

### 6.6 Sign-in without a terminal

A CLI's login lives on the server host. Today the chat opens a terminal to run
it. With no terminal on a remote server, `providers.signIn` runs the CLI's
login non-interactively where the CLI supports a device-code or URL-and-paste
flow, streams the lines it prints (a URL to open, a code to type), and accepts
a pasted code back. A CLI with no such flow shows the command to run over SSH.
Which CLIs support which flow needs checking per CLI (section 15).

### 6.7 Canvas: a client toolset over the server's files

Ruling (f) splits the canvas along the line of section 1.1 (phase 5 spec,
§10.2–10.3):

- **Boards stay files on the server's disk**, where they are today: under
  `<dataDir>/canvas/<project key>/`, plus boards an earlier build left in
  `<workspace root>/diagrams/`. Nothing moves. The server reads, writes and
  watches them through the owner-only `files` subset (5.2): a write is atomic
  and conditional on the hash the writer last read (`ifMatch`), and in v1 it
  accepts only `*.excalidraw`. That file access is the only canvas code the
  server keeps; it knows nothing about the format.
- **Everything else is the client's.** `canvas-service.ts` (the board cache,
  revisions, the per-element merge where the person wins a shape both sides
  touched, the action log, the screenshot ladder), the eight `canvas.*` tools
  (`list`, `open`, `describe`, `find`, `edit`, `layout`, `import`,
  `screenshot`) and the hidden worker window run in the desktop, one canvas
  service per environment it is attached to, over a `CanvasFs` that speaks the
  `files` methods. The desktop offers them as the `canvas` toolset. Boards are
  still named, never located.
- **Several clients on one board.** Each client's canvas service follows
  `files.watch` and merges what it reads from disk, so an agent's edit made
  through one desktop shows in another; a write that loses the `ifMatch` race
  is merged again and retried once. Presence across clients is not carried in
  v1.
- **With no client offering `canvas`**, agents have no canvas tools, and the
  boards are untouched files until one attaches.

### 6.8 Pull request marks: a server domain (owner rulings 2026-10-03, 2026-10-04)

The pull request record is the server's, in both modes (`src/server/pull-requests/`).
Features that react to chats live in the server; every client (the desktop,
the web client, the phone, an SDK app) displays the result through the
protocol and decides nothing. The desktop does not see conversation events for
this.

**A conversation owns a pull request when its agent opened it** (owner ruling
2026-10-04). It replaces the rule of 2026-10-03, under which a conversation
wore every pull request on every branch it worked on: a chat started in a
checkout that happened to be on someone else's branch wore that branch's
merged pull requests, and two agents on one branch both wore its pull request.
These say a conversation opened one, and nothing else does:

- **Its agent ran a create command or tool, and the output named it.** One
  reader decides (`src/shared/git/pull-request-opened.ts`), for chats and
  terminal agents alike. The gate is the call: `gh pr create`,
  `glab mr create`, `git push -o merge_request.create`, or an MCP tool named
  `create_pull_request` / `create_merge_request`. The evidence is the result:
  the call did not fail, did not say the pull request "already exists", and
  its output (never its input) names a URL the shared classifier reads
  (`classifyPullRequestUrl`: GitHub and GitHub Enterprise, GitLab, Gitea,
  Forgejo and Codeberg, Bitbucket, Azure DevOps, on any host). A push's "open
  a pull request by visiting" link is a form, not a pull request, and a URL a
  push or `gh pr list` prints names one somebody may have opened before.
- **Its agent called the gateway's `pull_request.link`** with the URL. The
  conversation is the calling agent's own, from the connection, never from an
  argument. This is the way for every other forge and every other way of
  opening one.
- **The person pressed the chat's "Create PR".** The desktop pushes the
  branch and runs `gh pr create` in the conversation's own checkout on this
  computer (on other forges it opens the forge's prefilled page instead, and
  nothing exists to record yet), then records the pull request with the
  owner-only `pullRequests.link` (capability `pull-request-link`; refused as
  `claimed` when another conversation opened it first). The button shows only
  when the branch is ready to propose: a named branch that is not the default,
  commits no merged pull request carried, and no open pull request from the
  branch, whoever opened it. That last check is a branch lookup
  (`gh pr list --head`): it says whether a pull request exists, never whose it
  is. Uncommitted changes do not hide it: only the confirmed commit is pushed,
  and the confirm step says how many changes stay behind.

A chat's calls are read off its stream (`tool_started`, then the final
`tool_output`, whose whole output is read from the tool's detail when the
event carries a preview). A terminal agent's are forwarded: its hook reporter
(and the OpenCode plugin) sends the tool's name, the shell command and the
output, bounded at both ends, for a shell or MCP call whose output holds a URL
at all, and decides nothing; the shell sends it on with
`pullRequests.noteToolCall`, and the server reads it with the same reader.
The first conversation to claim a pull request keeps it.

**State.** A GitHub pull request's state is read by its URL (`gh pr view`):
once when it is recorded, every two minutes while it is open (for 30 days),
and when a client asks (`pullRequests.refresh`: a hover, a window coming to
the front). A pull request on another forge is shown as opened, with no state.
No branch is looked up to decide anything.

**Its own branch.** A conversation's checkout, noted at a chat's turn end and
by `pullRequests.noteWork` for a terminal agent, decides which of its pull
requests are from the branch it is on (`onConversationBranch`), which is the
only one that may say the branch landed. It never adds one.

**The record's rules hold.** Settled reads only; "could not ask" changes
nothing, so a mark never blinks out for a probe that failed or a server
restart. At most three `gh` reads at a time. A list asked for before the
stored record is read waits for it.

**No `gh`, no state.** The record reads through `gh` on the server's machine,
with `gh`'s own sign-in. A server with no `gh`, or not signed in, shows what it
has as last read, and says nothing: a missing `gh` holds every read for five
minutes, and nothing is reported as an error.

**The protocol** (`pull-requests` capability, owners only, `workspaces:read`):
`pullRequests.list` by workspace or by conversation, `pullRequests.refresh`,
`pullRequests.noteWork`, `pullRequests.noteToolCall`, `pullRequests.link`, and
the `pullRequests.changed` stream, which names what moved and never carries the
lists. The desktop's sidebar reads rows through the window's Studio client;
the shell's own client forwards its terminal agents' calls and checkouts, and
puts the lists the server answers on the terminal snapshot, which carries them
to the peek and the tooltips as before.

**Storage.** One file, `pull-requests/opened.json` in the server's data
directory. The files the branch-lookup rule wrote (one per repository, and
`conversations.json`) are read once at the first start: a row a capture filed
under a conversation is kept (one that named only its workspace is worn by
every conversation in it, until its agent links it again), every row a branch
lookup found is dropped, and the old files are removed.

### 6.9 Local servers: a server domain (owner ruling 2026-10-04)

The dev servers, previews and other local web servers a conversation's agent
started are recorded and checked by the server
(`src/server/local-servers/`), shaped like the pull request record: an agent
says "I started this" with the gateway's `local_server.link` (the URL, and
when it has them a title, the command that starts it and its folder; the
conversation is the calling agent's own, from the connection), and every
client reads `localServers.*` and draws what it is told.

**A server is its address.** Two links name one server when they name the
same host and port, every spelling of the default loopback read as one host; the unspecified
address a dev server prints (`0.0.0.0`, `[::]`) is recorded as `localhost`.
The same conversation linking it again updates the link; another conversation
linking it takes it over, since only one process can hold a port. At most 20
per conversation and 500 in all, the oldest going first, except one a run the
server started is following.

**Liveness is checked where the agents run**, by a TCP connect to the port
(no HTTP request, so a dev server's log stays quiet; a loopback host is tried
at `127.0.0.1` and `::1`). A server that is up, starting, or changed or was
linked in the last ten minutes is checked every five seconds, the rest every
thirty, at most eight at once. A state is never stored: at start each link is
checked at once and `localServers.list` waits for that (up to five seconds).
`localServers.changed` is published only when something a client draws moved.

**Run again** starts the link's command as a process the server owns, in the
person's login shell with the PATH that shell sets up, in the link's folder
(else the conversation's), in a process group of its own. It reads as
`starting` until its port opens (checked every second, for up to two
minutes, and not again once it has opened). A run lasts as long as anything
in its process group does, so a shell that backgrounds its server and exits
still has a run to stop. Only that run can be stopped from a client (SIGTERM
to its group, SIGKILL five seconds later; `taskkill /T` on Windows); a server
the agent started is the agent's. How a run that ended on its own ended (exit
code and the end of its output) is kept until the next one starts; a stopped
one has nothing to explain. The server's own end stops every
run it started, which would otherwise be left holding its port.

**The protocol** (`local-servers` capability, owners only):
`localServers.list` by workspace or by conversation (`workspaces:read`),
`localServers.run`, `localServers.stop` and `localServers.remove`
(`conversation:operate`), and the `localServers.changed` stream.

**Storage.** One file, `local-servers/linked.json` in the server's data
directory. One that cannot be read is kept aside as `.corrupt`.

## 7. Data and settings

### 7.1 Data locations, per host

| Host                              | Server data directory                                                                                                            | Logs                                                             |
| --------------------------------- | -------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------- |
| macOS or Windows, desktop-spawned | the app's userData directory as it is today (`app.getPath('userData')`, handed over in the bootstrap envelope), so nothing moves | the app's logs directory (`app.getPath('logs')`), `server-*.log` |
| Linux, WSL, SSH                   | `${XDG_DATA_HOME:-~/.local/share}/sprintengine-studio/data`                                                                      | `${XDG_STATE_HOME:-~/.local/state}/sprintengine-studio/logs`     |

The runtime, bundles and launcher live beside it as they already do for WSL:
`~/.local/share/sprintengine-studio/runtime/node-<v>/` and
`~/.local/share/sprintengine-studio/<version>/`. A `--data-dir` flag (and the
existing `SPRINTENGINE_USER_DATA_DIR` profile override) points a server at any
other directory. One server per data directory, enforced by a lock file in
`<dataDir>/run/`.

Per-workspace data does not move: transcripts, the thread index and tool
details stay in each workspace's `.sprintengine/` sidecar, and checkpoints stay
git refs in each repository, because they belong to the checkout.

### 7.2 Splitting today's userData

Server-owned: conversation stores, approval rules, attachments, plans, the
command cache, provider secrets, module secrets and storage, launch settings,
the workspace registry and backup, module enablement, studio-area skills,
scheduled agents, git changelists, pull requests (the server's in both modes
since section 6.8), linked local servers (section 6.9), canvas board files (the
server holds them as files; the canvas module that edits them is a
client's), tours, model discovery, tailnet devices and settings, the audit log, the integration ledger,
marketplace and feed caches.

Client-owned (stay in the desktop's userData, or browser storage on the web):
window material, appearance, update channel, background mode, the splash and
window geometry, the saved environment list, and each environment's cached
snapshot and cursors.

Desktop-local server and desktop share one directory on macOS and Windows, so
each file must have exactly one writer. The split is enforced by the same
handler-object rule: a store is constructed in the server or in the shell, never
in both, and the shell reads server-owned state over the protocol.

### 7.3 Settings and credentials

- Launch settings, CLI runtimes and per-host CLI commands
  (`ExecutionHostSettings`), approval rules and module enablement are the
  server's. A client edits them through `settings.*` and hears changes on a
  stream.
- **API keys** are entered in any client and sent once, over the authenticated
  channel, to `providers.secrets.set` (owner scope, or an explicit
  `secrets:write` grant that remote pairings never get by default). The server
  stores them sealed by its `SecretCipher` and only ever answers their status.
- **CLI logins** (Claude Code, Codex, Cursor, …) live in the server host's
  home, where the CLI keeps them. A remote server is signed in on that host.
- GitHub tokens and module secrets follow the same rule as API keys.

## 8. Browsers and the canvas: client things

The server has no browser and no canvas (ruling f). This section replaces the
render host an earlier draft planned: no headless Chromium, no Chromium
download or probe on any host, no screencast and no server-side drawing. What
each client does instead:

| Client, attached to                  | The agents' `browser.*` tools              | What the person sees of a dev server an agent starts                   | `canvas.*` tools and drawing              |
| ------------------------------------ | ------------------------------------------ | ---------------------------------------------------------------------- | ----------------------------------------- |
| Desktop, its local server            | offered by the desktop: its pane, as today | the pane, direct                                                       | offered by the desktop: its hidden worker |
| Desktop, a WSL server on the same PC | offered by the desktop                     | the pane, direct: Windows reaches WSL's `localhost` by forwarding      | offered by the desktop                    |
| Desktop, an SSH server               | offered by the desktop                     | the pane, its traffic sent through the SSH connection (8.1)            | offered by the desktop                    |
| Web client, any server               | none in v1                                 | a preview: the dev server passed through on an origin of its own (8.2) | offered by the web client                 |
| SDK app                              | whatever the app offers                    | —                                                                      | whatever the app offers                   |
| Nobody                               | none                                       | —                                                                      | none                                      |

### 8.1 The desktop's pane on every route

The pane stays the desktop's native `<webview>`, with DevTools, file drag and
drop, rich clipboard, inline PDFs and the password manager, on every server
the desktop attaches to. The agents' `browser.*` tools (`open`, `navigate`,
`click`, `type`, `press`, `scroll`, `hover`, `evaluate`, `snapshot`,
`screenshot`, `console`, `network`, `resize`, `set_appearance`, `wait_for`,
`record_start`, `record_stop`, …) are the desktop's `browser` toolset:
`browser-control.ts` keeps driving the pane through `wc.debugger` and
`capturePage`, a recording is captured and encoded by the window hosting the
tab and written into the calling agent's workspace
([`browser-recording.md`](browser-recording.md)), and the person-wins rule (a
person's input bumps the tab's epoch, and an agent action in flight yields
`interrupted`) stays where it is. With no window open (the tray), the shell
keeps a workspace's tabs as offscreen web contents in the same partition, so
no tool needs a window.

Where the pane's traffic goes is what differs by route:

- **The local server and its WSL servers.** Direct, as today. A dev server an
  agent starts in WSL is reachable at `localhost` through WSL's localhost
  forwarding. With forwarding off (the stdio bridge of phase 7), the pane
  cannot reach it, as today.
- **An SSH server.** The agent's dev server listens on the remote's
  `localhost`, which a pane on the laptop cannot reach. The desktop sends that
  environment's pane traffic through the SSH connection it already holds: a
  SOCKS forward carried by the relay (phase 8, section 6.8), set as the proxy
  of that environment's own partition (`persist:env-<environment.id>`) with
  `proxyBypassRules: '<-loopback>'`, so that `localhost:5173` in the pane is
  the remote's. Nothing is installed on the remote for it, and the cookies
  stay the desktop's.

### 8.2 The web client: previews, and no browser toolset

A web tab cannot drive another page, so in v1 it offers no `browser` toolset;
with only web clients attached, agents have no browser. The person still sees
what an agent builds: the server's `previews` namespace passes a port on the
server's loopback through to the browser, on an origin of its own, never the
Studio web app's. The dev app is agent-written code; on Studio's origin it
could read the person's session and drive the server. The preview origin has
its own credential, Studio's cookies are stripped from what it forwards, and
WebSocket upgrades (a dev server's hot reload) pass through. The phase 9 spec
(section 3.6) has the details: which ports, the auth, the headers, the
limits.

### 8.3 The canvas

The desktop draws in its hidden canvas worker window, as it does today, and
offers the `canvas` toolset over it (6.7). The web client runs the same
`@excalidraw/excalidraw` build and fonts in the page, and in phase 9 offers
`canvas` too. Both keep boards through the server's `files` methods. The
output matches between them because it is the same editor build with the same
bundled fonts; which client answers a call is the phase 5 routing rule (6.3).

### 8.4 With nobody attached

A scheduled agent, or a chat left running on a remote with every client gone,
has no browser and no canvas tools: they are absent from its tool list, and
nothing waits for a client. A later, optional **headless client** can close
that gap without touching the server: a small separate program run beside the
server that connects as an ordinary client and offers `browser` (a headless
Chromium) and `canvas` (the editor in plain Node). It is out of scope for this
plan; the phase 5 spec (§14) keeps the research for it.

## 9. Auth and security

### 9.1 The rule

The server never listens on a port without authentication. It has three
listeners, each optional, and no flag binds a public interface in v1:

| Listener                                                                                                | Who uses it                                                                                       | Auth                                                                                        |
| ------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------- |
| **Owner socket**: `<dataDir>/run/studio.sock` (directory 0700, socket 0600), or a named pipe on Windows | the desktop shell, the SDK and scripts on the same host, an SSH tunnel's far end                  | the owner token, always, in `hello`                                                         |
| **Loopback TCP**: `127.0.0.1:<port>`                                                                    | browser tabs on the same host, the Windows app reaching a server in WSL, an SSH tunnel's near end | ticket or session cookie; `Host` must be a loopback name; `Origin` must be the server's own |
| **Tailnet**: the existing listener on the tailnet address                                               | the phone, other Studio desktops, a browser on another tailnet device                             | pairing, device tokens, scopes, Tailscale `whois` binding, tickets                          |

The owner token is required on the socket even though the file mode already
keeps other users out, because a Windows named pipe's default ACL lets other
local users connect, and a second check costs nothing.

As built in phase 2, Node cannot set a pipe's security descriptor or refuse
remote clients by flag (`PIPE_REJECT_REMOTE_CLIENTS`), so on Windows the pipe
keeps the default access its creator gets, and what holds instead is its
unguessable name (a random part per start, learned only from the owner's 0600
discovery file) and the token every connection must present. A native helper
that creates the pipe with an owner-only descriptor would close the gap; it is
not part of v1.

### 9.2 Local, same user

- The **owner token** is 32 random bytes. When the desktop spawns a server, it
  mints the token and hands it over in the bootstrap envelope (10.1); the
  server stores only its hash. A server started any other way writes
  `<dataDir>/run/owner-token` (0600) and the SDK reads it from there, which is
  the same-user check. While the server runs inside the app (phases 2 to 5)
  the token is minted in memory for each run and never written down, so no
  file grants owner access.
- **Paired local apps** (phase 2) are not owners. The person mints a one-time
  pairing code in Settings naming the app, its scopes (`conversation:read`,
  `conversation:operate`, `conversation:create`) and its permission ceiling;
  the app's first hello redeems it for a token, kept only as a hash. The
  ceiling is the module service's: a preset asked for is lowered to it, none
  asked for is pinned to it, `allowedTools` needs `bypass`, and a chat already
  running looser than it is not driven by the app (a chat whose session runs
  tools unasked counts as `bypass`). Allowing a request for the rest of a
  conversation needs a ceiling of at least `auto`. Revocation in Settings
  closes the app's connections at once, and a connection re-reads its grant
  before every frame it streams. One app holds at most eight connections.
- **Scopes are not a sandbox.** On macOS and Linux a paired app runs as the
  same OS user as Studio. It can read and write everything Studio can,
  `studio-local-apps.json` included, so it could grant itself a wider scope or
  ceiling, or run the agent CLIs itself. Scopes and ceilings protect against
  mistakes in a trusted app, and against a script given less than it could
  take; they do not contain a malicious one. Pair only software you would let
  run as you. A follow-up can seal the paired-apps file with an integrity MAC
  under the platform's `SecretCipher`, so an edit to it is detected (not
  prevented).
- A desktop window gets a **single-use ticket** (30 seconds, as on the tailnet)
  from main for each connection, and opens the WebSocket with it. The long-lived
  token stays in main.
- **A browser tab on this machine** opens a URL the desktop or `studio-server
pair` prints: `http://127.0.0.1:<port>/pair#code=<one-time code>`. The code
  is in the fragment so it never reaches a log or a `Referer`, lives five
  minutes, and is exchanged once for an `HttpOnly`, `SameSite=Strict` session
  cookie scoped to the owner's grants (narrowable, never widenable). The page
  strips the fragment from history after the exchange.
- The upgrade checks `Origin` against the server's own origin and `Host`
  against loopback names, which closes DNS rebinding.

### 9.3 Secrets at rest

`safeStorage` is not available outside Electron. The `SecretCipher` has two
sources:

- **Desktop-spawned server**: the shell keeps a data key sealed by
  `safeStorage` (so by the OS keychain on macOS and DPAPI on Windows) and hands
  it to the server in the bootstrap envelope. Existing `provider-secrets/*.bin`
  are opened once by the shell and re-sealed with the data key during the
  migration (phase 6), so nobody re-enters a key.
- **Headless server** (WSL, SSH, started from a shell): a key file in
  `<dataDir>/run/` (0600; on Windows, an ACL with one entry for the current
  user). It is written whole and linked into place, so a crash or a second
  server never leaves a short key, and a damaged one is reported, never
  replaced. Secrets are therefore protected by the OS user
  boundary on those hosts, the same protection the CLIs' own login files have
  there. Whether to use `libsecret` where a desktop session exists is an open
  question.

### 9.4 Remote

- **SSH.** The server binds only its owner socket and its front door's
  bridge socket on the remote, no TCP port. The desktop runs one relay over
  the SSH session's own stdio (decision R21; phase 8 spec, 5.4): no `ssh -L`
  and no local listener for the protocol. The relay reads the owner token on
  the remote and proves itself to the server with it, so the token never
  reaches the desktop (R22). The person's SSH login is the proof of being that
  user. The audit log names such a connection `via ssh-relay` with the SSH
  client's address. Nothing is exposed on the remote's network.
- **Tailnet.** The existing listener moves into the server unchanged: pairing
  by offer or by approval with a typed comparison code, device tokens stored as
  hashes, scopes read live, `whois` binding, single-use tickets, revocation
  closing every stream with 4401, audit. The scope list grows by the new
  families (`files:read`, `settings:read|operate`, `secrets:write`, and
  `previews:open` from phase 9), each with a `TAILNET_LEGACY_REQUEST_SCOPES`-style
  rule so an old pairing never gains a family added later. `tools:offer` and
  `files:write` are never granted to a tailnet pairing in v1.
- **A browser on another tailnet device** pairs by approval like the phone does;
  the device token becomes its session cookie. Serving the page over HTTPS via
  `tailscale serve` is a later option.
- **Audit**: one log per server, for every listener, mutations only, no message
  text.

## 10. Deployment

### 10.1 The desktop spawns its local server

- The server is a child process running the server bundle on **Electron's own
  Node** (`process.execPath` with `ELECTRON_RUN_AS_NODE=1`), so the desktop
  ships no second Node.
- **Bootstrap envelope**: one JSON line on the child's stdin — data dir,
  owner token, data key, log path, the listeners wanted, the app version and
  build stamp, and a `parentPid` the server watches. Stdin rather than argv or
  the environment, so nothing secret shows in a process list; stdin rather than
  an extra file descriptor, so the same envelope works through `wsl.exe` and
  `ssh`, which pass only stdio.
- **Ready**: the server writes `{ "ready": { socket, port, environmentId,
version } }` on stdout once its listeners are bound, and
  `<dataDir>/run/server.json` (0600) for other local clients. The shell then
  connects and `hello`s. A start that is not ready within its budget is killed
  and reported with the tail of its log.
- **Crash restart** with exponential backoff (half a second, capped at ten);
  a failure before ready (a bad data dir, a held lock) stops the loop and says
  why. Open windows show "reconnecting" and resume from their cursors.
- **Logs**: stdout and stderr into a rotating `server-*.log` beside the app's
  diagnostics.
- **Lifetime**: by default the server exits when its parent exits and no other
  client is attached. In background mode (the tray) the shell keeps it alive.
  A server that finds a compatible server already running on the same data
  directory (the lock is held) exits and the shell attaches to the existing one.

### 10.2 Inside WSL, on the pinned Node

This is what "a chat on WSL" becomes:

| Today                                                                                                               | With a server in WSL                                                        |
| ------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------- |
| The conversation runtime runs in Electron main on Windows                                                           | The runtime runs in the distribution                                        |
| Each CLI child is a `wsl.exe -d <distro>` with stdio parked on fds 57/58 (`cli-host-child.ts`)                      | Each CLI is a plain local child of the server                               |
| Outbound paths respelled to Linux, inbound respelled to the Windows root (`host-paths.ts`, `approvalCheckInput`)    | Paths are Linux paths end to end                                            |
| MCP bridges inside WSL reach main through the helper's `mcp.sock` relay over stdio, with a per-launch channel token | MCP bridges connect straight to the server's `automation.sock`              |
| git runs through the helper or `wsl.exe`                                                                            | git runs locally on the server                                              |
| The helper retains/releases per session and idles out                                                               | The server is the long-lived process; the helper remains only for terminals |

Install and start:

1. `wsl-install.ts` gains the server bundle as one more archive beside the
   helper, hooks, automation and plugin payloads, under
   `~/.local/share/sprintengine-studio/<appVersion>/server/`, with the same
   staging, `flock`, digest marker and `mv -T`. The pinned Node is already
   there.
2. The shell starts it with `wsl.exe -d <distro> --cd ~ --exec sh -s`, the
   script `exec`ing `setsid <node> server.mjs` and reading the bootstrap
   envelope from stdin (`--data-dir` defaults to the XDG path, 7.1). The
   server binds `127.0.0.1:<port>` inside the distribution.
3. The Windows app connects to `127.0.0.1:<port>`; WSL2's localhost forwarding
   carries it (both the default NAT mode with `localhostForwarding` and the
   mirrored networking mode). When forwarding is off, the shell falls back to a
   **stdio transport**: the WebSocket frames carried over the `wsl.exe`
   process's own stdio, exactly as the helper relay carries MCP today. The
   fallback is always available, so a person's `.wslconfig` cannot break chat.
4. Lifetime: the server outlives a single `wsl.exe` only while a client is
   attached or an agent is running, then idles out like the helper does; with
   background mode on it stays. A systemd user unit is a later option where the
   distribution runs systemd.

Files the Windows side still needs to show or open (a link in a transcript,
reveal in Explorer) are translated by the client from the Linux path to
`\\wsl.localhost\<distro>\…` with the existing `host-paths.ts` helpers — a
shell concern, at the edge, instead of a per-process one inside every agent.

Terminals in WSL keep today's `wsl.exe` path in the shell (ruling a).

### 10.3 Over SSH

The desktop drives the system `ssh`, using the person's `~/.ssh/config`,
agent and keys. A password or passphrase prompt goes through an `SSH_ASKPASS`
shim that asks in a Studio dialog.

**Bootstrap** (one script per step, each a fresh `ssh <host> sh -s` exec, the
same shape as the WSL install):

1. **Probe**: `uname -sm`, `$HOME`, glibc version, an existing install's
   digest markers and a running server's `server.json`. Linux x64 and arm64 and
   macOS arm64 and x64 are supported targets.
2. **Install the runtime** if its digest marker is missing: the client
   downloads the pinned Node for that os/arch, verifies the SHA-256, and streams
   the archive over the SSH session's stdin into `tar -x` in a staging
   directory. The remote needs no network, no `curl` and no Node.
3. **Install the server bundle** for the desktop's own version the same way,
   into `~/.local/share/sprintengine-studio/<version>/`, then `flock`, verify,
   write the marker, `mv -T`, prune versions nothing references.
4. **Start or reuse**: if a server of a compatible version is already running
   on the data directory, use it and mark it **external** (it was not started
   by this client and survives this client's disconnect). Otherwise start one
   with `setsid nohup`, the envelope on stdin, owner socket only, and mark it
   **managed**.
5. **Connect**: the same session becomes the relay (`bridge.mjs --mux`): a
   multiplexer over its stdio, each stream a connection to the server's front
   door proven with the owner token on the remote, or a TCP connection made
   there for the desktop's browser pane. An SSH route is an environment, not
   an execution host: `ExecutionHostId` stays `local | wsl:<distro>`, and on
   the remote server every process is its `local`.

As built in phase 8 (2026-10-03), the bootstrap is one script per session, a
probe and then one decision after `@@SPRINTENGINE_SEND` (install, attach,
start, upgrade, stop), so a connect is one authentication and a first install
two. The marker rule is the same one stdin envelopes need everywhere: nothing
is written to a remote shell before it asks, or it is run as a command. The
install lock is a `mkdir` lock (macOS has no `flock`), and a managed server is
a detached process (no `setsid`, no systemd unit unasked, R29). The detail is
in `docs/design/studio-server/phase-8-ssh-remotes.md`.

**Lifecycle and upgrade**

- A managed server idles out after the last client leaves and no agent is
  running, unless the owner set it to stay up on that host.
- The desktop installs the server version that matches itself. When it finds an
  older managed server running, it installs the new bundle beside it, calls
  `server.shutdown { drain: true }` on the old one (turns in flight finish or
  are suspended; stateful providers resume from their resume cursors), and
  starts the new one. An external server is never stopped; the desktop says
  which version runs there and offers the upgrade.
- **Version skew**: the protocol window decides compatibility (one version of
  slack, both numbers named). Inside the window, capabilities decide features,
  so a newer desktop on an older server simply hides what the server does not
  advertise. Outside it, the environment shows "this machine runs Studio server
  X, this app speaks Y–Z" with the action that fixes it.
- Data migrations run when a new server version first opens a data directory,
  behind a copy of each file it rewrites, so a downgrade within the window can
  still read what the newer version left.

**Environments in the app**: a saved connection has a label, a route (`local`,
`wsl:<distro>`, `ssh:<host alias>`, `tailnet:<device>`) and the
`environment.id` it last reported. The sidebar groups workspaces by
environment; the existing Remote band and the machine dropdown in New chat list
environments instead of paired desktops only.

### 10.4 The server bundle

- `npm run build:server` builds `out/server/server.mjs`, a single Node ESM
  bundle of `src/server/` and its dependencies, with the pure-JS dependencies
  inlined (`@anthropic-ai/claude-agent-sdk`, `@agentclientprotocol/sdk`,
  `diff`, `ignore`, `nanoid`, the protocol packages). _As of phase 3 it builds
  `out/server/server.cjs` instead: CommonJS, as the main bundle the same source
  goes into is, with every dependency left in `node_modules`. That is what a
  desktop-spawned server (phase 6, inside the app archive) needs; inlining for
  hosts with no `node_modules` (WSL, SSH) is phases 7 and 8's packaging, and
  is where the ESM question is decided, against how the agent SDK finds its
  own files once inlined._
- Beside it: `resources/` (plugins, hooks, the studio plugin, built-in skills,
  `automation/mcp-stdio-bridge.mjs`), the ripgrep binary for the target
  os/arch, and the web client (section 11), which carries the canvas worker
  page and its fonts for the web client's `canvas` toolset. The server itself
  draws nothing.
- Not in it: `node-pty` (terminals are out), `electron`, `electron-updater`,
  xterm, Monaco's main-side pieces.
- One archive per target (`studio-server-<version>-<os>-<arch>.tar.gz`) with a
  manifest of SHA-256s. The desktop package carries its own platform's bundle
  and the Linux x64 and arm64 bundles (for WSL and SSH); a macOS desktop carries
  the macOS bundles for SSH to another Mac.
- A `studio-server` CLI entry in the bundle: `serve`, `pair` (print a one-time
  web URL), `token`, `status`, `stop`, `--version`. Publishing it to npm for
  machines with no desktop is an open question.

## 11. The web client

- The renderer gets a web build target beside the Electron one
  (`vite build --mode web`), output into the server bundle. The server serves
  it at `/` on the loopback and tailnet listeners, with an `index.html`
  fallback, and serves module renderer entries and assets under `/modules/`.
  In development the server redirects page loads to the Vite dev server and
  Vite proxies `/ws` and `/api` back.
- `window.api` on the web is `createServerBackedApi(client)` with the shell
  members filled by browser fallbacks:

| Desktop feature                                 | Web fallback                                                                                                         |
| ----------------------------------------------- | -------------------------------------------------------------------------------------------------------------------- |
| Native folder and file dialogs                  | a server-side folder browser (`files.browse`) in an in-app modal; file attach through `<input type=file>` and upload |
| `getPathForFile` (drag and drop)                | the dropped file's bytes, uploaded                                                                                   |
| Clipboard                                       | `navigator.clipboard`                                                                                                |
| `openExternal`                                  | `window.open`                                                                                                        |
| Reveal in folder, open in an external app       | hidden; links to files open the in-app viewer                                                                        |
| OS notifications, dock badge                    | Web Notifications when granted; no badge                                                                             |
| App menu, context menus                         | the in-app command palette and DOM menus                                                                             |
| Multiple windows, aux windows (checkpoint diff) | tabs and in-app modals                                                                                               |
| The browser pane (`WebContentsView`)            | previews of the server's dev servers on an origin of their own (8.2); no `browser` toolset in v1                     |
| Terminals                                       | hidden (ruling a)                                                                                                    |
| Auto-update, window material, splash            | none                                                                                                                 |
| Deep links (`sprintengine://`)                  | URL routes                                                                                                           |
| Appearance                                      | `prefers-color-scheme` plus a stored choice                                                                          |

- About 72 renderer files already guard members with `typeof window.api.X ===
'function'`, so a member the web shim leaves out degrades rather than throws;
  the rest are found by running the web build against a shim that reports every
  missing call.
- The web client offers the `canvas` toolset (8.3): it runs the canvas worker
  page in the browser and answers agents' `canvas.*` calls like the desktop's
  hidden worker window does.
- Third-party module renderer code runs in the web page too. It is gated by the
  same trust store (on the server); whether module assets need their own origin
  on the web, as they get their own protocol on the desktop, is an open
  question.

## 12. Migration: keeping the app working at every step

The core moves out of main in the same order it would if nobody were watching,
but every intermediate state is a shippable app:

1. **Seams first** (phase 1). Server-bound modules stop importing Electron;
   main supplies the Electron implementations. Nothing changes for anyone.
2. **The protocol in process** (phase 2). Main starts the RPC router on the
   owner socket next to everything else. The SDK can create and follow chats.
   The desktop does not use it yet.
3. **A core that runs without Electron** (phase 3). `createStudioCore(platform)`
   is extracted from `createAppServices`; main calls it with the Electron
   platform; a `studio-server` entry calls it with the Node platform. CI boots
   the standalone server and drives a chat through the SDK.
4. **The chat view over the protocol** (phase 4), still against the in-process
   core: the renderer's adapter routes the v1 members to the SDK client,
   behind the `SPRINTENGINE_CHAT_TRANSPORT` environment variable until it is at
   parity, then by default. IPC stays for
   everything else.
5. **Client tools** (phase 5). The browser and canvas tools become toolsets
   the desktop offers through the server, the canvas keeping its boards
   through the server's `files` methods, so nothing the server does depends
   on main's windows.
6. **Out of process** (phase 6). The shell spawns the server; main stops
   constructing the server-owned stores and reaches them over the protocol. The
   in-process mode stays available behind a flag for one release, as the
   fallback if the child fails to start.
7. **WSL** (phase 7): a WSL workspace's chats go to the server in the
   distribution. The per-process `wsl.exe` path stays for terminals only.
8. **SSH** (phase 8) and **web** (phase 9) are new routes to the same server.
9. **The rest of the surface** (phase 10) moves domain by domain.

## 13. Phased plan

Each phase lands as reviewable commits on `feat/studio-agent-sdk`, leaves
`npm run verify:app` green, and is shippable on its own. Sizes are relative
(S < M < L < XL).

### Phase 1 — Electron seams for the server-bound modules (S)

- **Scope.** `src/server/platform/` with `StudioPaths`, `SecretCipher`,
  `ClientBus`, `Notifier`, `AppIdentity`, and their Electron implementations in
  `src/main/platform/`. Route through them: the seven lazy
  `require('electron')` sites (`secret-store.ts`, `plugin-registry-instance.ts`,
  `managed-runtime.ts`, `mcp-config-service.ts`, `marketplace/resources.ts`,
  `marketplace/trusted-publishers.ts`, `tailnet-mesh-store.ts`),
  `github-token-store.ts`, `modules/agent-runtime-module.ts`, the broadcast in
  `modules/scheduled-agents-module.ts`, `ripgrep-binary.ts`, `builtin-skills.ts`,
  and `terminal-launch.ts`'s userData paths.
- **Tests.** Each touched store tested with the Node implementations and a temp
  directory; a guard test listing the server-bound files that must not import
  `electron` (the list grows each phase).
- **Risks.** Low; the trap is a lazy require that only runs in a packaged
  build, so a packaged smoke run is part of the phase.
- **Landed.** As scoped, plus what the guard found: the model discovery cache
  (`model-discovery/service.ts`), the pictures Codex generates
  (`providers/codex-conversation-provider.ts`, through a dynamic import) and
  the diagnostics log (`diagnostics-service.ts`, whose open-the-folder half
  moved to the shell's `diagnostics-folder.ts`). The module host's event
  delivery publishes on the `ClientBus`, and the tailnet pairing notices go
  through the `Notifier`. `ripgrep-binary.ts` needed nothing.

### Phase 2 — Studio RPC on the owner socket, in process; the agent SDK (M)

- **Scope.** `packages/conversation-protocol/src/studio/` (envelope, `hello` /
  `welcome`, method and scope tables, the `conversation` and `server`
  namespaces); `src/server/rpc/` (router, scope checks, stream fan-out over
  `ConversationSessionApi`, command receipts); the owner socket and token in
  `<userData>/run/`; `packages/agent-sdk/` (`@sprintengine/agent-sdk`: connect,
  hello, `conversations.create/follow/send/respond/interrupt`, resume, retry),
  with a pack check like the protocol's. `docs/compatibility.md` gains the
  Studio protocol row. This is where the "local socket" the protocol README
  promises arrives.
- **Tests.** Protocol parsers and handshake window; router scope table
  completeness (a test, not only a type); a seam test driving a mock-provider
  chat through the SDK over a real socket in a temp dir; token and file-mode
  checks.
- **Risks.** Freezing names that later namespaces regret; mitigated by shipping
  only `server` and `conversation` and the envelope.
- **Carried from phase 1.** Three shapes the platform has today that the
  protocol must not freeze by accident. `ClientBus` topics are the preload's IPC
  channel names (`scheduled-agents:changed`, the module events channel); the
  router maps each to a stream name of its own rather than exposing them.
  `StudioNotice.onActivate` is a closure, which cannot cross a socket: a click
  in a remote client comes back as an activation of the notice's `key`, so the
  server keeps a registry of pending activations keyed by it. And
  `SecretCipher` is synchronous, as `safeStorage` is, which rules out an async
  OS keychain (`libsecret` over D-Bus, owner default 6) behind it; adopting one
  means making `seal`/`open` async through the four stores, or unsealing a
  data key from the keychain once at start and keeping the cipher synchronous.
- **As landed.** `packages/studio-protocol` (not `conversation-protocol/src/studio`,
  see 5.4); `src/server/rpc/` (listener, connection, router), held by phase 1's
  boundary guard, which also covers `src/main/studio-rpc/`; `src/main/studio-rpc/` (the backend over the
  tailnet lane's conversation host and the launch service, the paired-app
  store, the service started and stopped with the gateway); Settings → Agents →
  Local apps; `packages/agent-sdk` with `./node`, an in-process adapter over
  the module SDK's conversation service, an example script and a pack check
  that installs all three tarballs. The socket is
  `<userData>/run/studio.sock` in a 0700 directory (a private temp directory
  when the path is too long; a pipe with a random name on Windows), found
  through `<userData>/run/server.json`. Audit records go into the gateway's one
  log under the `studio-client` connection kind. The service takes its data
  directory and version from the platform's `StudioPaths` and `AppIdentity`,
  and tells Settings about pairings on the `ClientBus` (topic
  `studio-local-apps:changed`, a preload channel name that no protocol stream
  exposes). It seals nothing, so the synchronous `SecretCipher` does not bind
  it: a paired app's token is kept only as a hash, and the owner token only in
  memory. It raises no notification, so no `onActivate` has to cross a socket.

### Phase 3 — An Electron-free core and the `studio-server` entry (L)

- **Scope.** `createStudioCore(platform)` extracted from `createAppServices`:
  conversation runtime, providers, launch service, checkpoints, the thread
  index, workspace registry, settings, credentials, the MCP gateway, module
  host (main halves). `src/server/main.ts` with flags and the bootstrap
  envelope, `npm run build:server`, the bundle layout (10.4), the `studio-run`
  pointer written by the server. Main calls the same `createStudioCore`.
- **Tests.** The import-graph guard over all of `src/server/`; CI boots the
  bundle under plain Node with a temp data dir and runs a mock chat, a revert
  and an MCP `conversation.create` call through the gateway; the existing seam
  suites keep passing against the in-process core.
- **Risks.** `app-services.ts` is large and order-sensitive (late-bound
  resolvers); split it in mechanical commits before moving anything.
- **Carried from phase 1.** The synchronous `SecretCipher` and the
  closure-carrying `onActivate` above apply here too: the standalone server's
  platform is `createNodeStudioPlatform`, whose cipher is the key file and
  whose notifier has no click to deliver until the router exists. Its
  `packaged` flag is required and must come from the bundle, never default.
- **As landed.**
  - _One wiring._ `createStudioCore(platform, { role })`
    (`src/server/core/studio-core.ts`) installs the platform it is given, takes
    the data directory's run lock, settles whose cipher seals the directory,
    then builds launch settings and the host registry, the workspace registry
    and sync, git's machine resolver, the conversation runtime (providers,
    checkpoints, the thread index and transcripts are the runtime's), the
    model catalog, the chat launch service, the launch cap and the conversation
    host factory. `createStudioGateway(core)` composes the MCP gateway and the
    tailnet lane over it, with the desktop's window and terminal tools placed
    among the core's own; `createStudioRpc(core, gateway)` composes phase 2's
    RPC. `createAppServices` calls all three with the Electron platform, the
    standalone server with the Node one.
  - _A `ConversationBackend` seam_ (`src/server/core/conversation-backend.ts`,
    so a later phase can route a chat to another server): the chat calls, picked off the runtime
    by name. The session API, the tailnet host, the IPC handlers, the module
    conversation and companion services, scheduled agents (through the runtime
    token), the launch service, the control plane and the peek take it; only
    the owner's calls (idle sweep, flush, shutdown, live child processes)
    still reach the runtime. A test fails on a new file that names the runtime
    class. The runtime is its only implementation; phases 7 and 8 add the
    remote and routed ones.
  - _The entry._ `src/server/main.ts` (`serve`, `--version`, `--help`):
    `--data-dir` (XDG by default, or `SPRINTENGINE_USER_DATA_DIR`),
    `--logs-dir` (inside a given data directory by default), `--app-root`,
    `--resources-dir` with `--packaged`, `--share-desktop-data-dir`, `--stdio`.
    One JSON line on stdout, `{"ready":{pid, version, dataDir, gatewaySocket,
rpcSocket, secrets}}` or `{"fatal":{code, message}}`; everything for a
    person on stderr. `--stdio` stops on `{"t":"shutdown"}` or when stdin
    closes, which is the parent-watch of 10.1. Exit codes:
    64 usage, 65 data directory unusable, 66 held, 70 failed. It also
    exports `startStudioServer` for a process that embeds the server.
  - _No terminals_ (ruling a), no module host, no canvas worker and no browser
    tools on the standalone server yet: the module host's bundled modules
    still take the shell's terminal runtime and account bridge (phase 6 moves
    the agent-runtime module, phase 10 splits the rest), and the canvas and
    browser tools are toolsets a client offers (phase 5, as replanned on
    2026-10-02). Its gateway serves `conversation.create` and
    module-free tools only.
  - _Not done:_ the bootstrap envelope on stdin (phase 6 decides between it
    and `utilityProcess` with `postMessage`), and the `studio-run`
    pointer. The pointer stays the shell's: it is shared with terminals, and
    phases 6 and 7 both keep it to one writer. A server writing it
    from a shell would repoint the desktop's hooks at itself.
  - _Tests._ `src/server/studio-server.smoke.test.ts` builds the bundle and
    runs it with the `node` running the suite: the ready line, the run lock,
    the discovery file, a second server refused with 66, MCP `initialize`,
    `tools/list` and `conversation.create` through the gateway, a clean stop
    on a shutdown line and on a closed stdin, a desktop's directory refused
    with 65 or shared with secrets off; and, requiring the bundle as a
    library, a chat on the mock provider through a tool turn with an edit,
    its checkpoint and a revert, then an approval. The import-graph guard
    lists the newly composed `src/main/` files.
- **Edge cases, and what was done about each.**
  - _Import-time side effects._ None of the core's graph reads the platform,
    starts a timer or touches the disk while it is imported (the bundle boots
    with nothing installed until `startStudioServer` builds the platform).
    The idle sweep, the gateway and the RPC start only when composed.
  - _`__dirname` and resources._ The bundle is CommonJS, so `__dirname` is
    real; resources are found through `StudioPaths` (`appRoot` from
    `--app-root`, else the checkout two levels above the bundle; `resourcesDir`
    with `--packaged`). One lookup still reads the working directory: a
    source checkout's vendored npm (`resources/runtime`, for installing a CLI
    through the managed Node), so a dev server started outside the checkout
    falls back to the person's own npm.
  - _Dynamic imports of providers._ Relative dynamic imports (the Codex
    picture store) are bundled; package imports stay `require`s of
    `node_modules`, ESM-only ones through Node's `require(esm)` (22.12+, and
    Electron's 24.21.0).
  - _The gateway and the module host._ The gateway is composed (its socket,
    discovery files, audit, tailnet lane); the module host is not (above).
  - _Worker threads._ The core starts none.
  - _Electron-only packages._ `scripts/build-server.mjs` refuses `electron`,
    `electron-updater` and `node-pty` anywhere in the graph, naming the
    importer.
  - _PATH and CLIs._ The login-shell PATH resolver runs unchanged; a server
    started from a terminal already has the person's PATH. The managed `node`
    and `npm` shims set `ELECTRON_RUN_AS_NODE` only when the binary is
    Electron, and a chat's MCP bridge entry runs on the server's own Node.
  - _Windows._ The named-pipe gateway, the lock (`process.kill(pid, 0)`) and
    the key file (phase 1's ACL) work there. A WSL host is not this server's
    to reach: its helper is a shell concern, so a launch into a distribution
    fails with "the WSL helper is not available in this process", and a chat's
    gateway entry is null for a WSL host. The server for a distribution runs
    inside it (phase 7).
  - _Two cores on one data directory._ Every core takes
    `<dataDir>/run/studio.lock` (pid, host, a token; written whole under
    another name and linked into place, so a full disk leaves no half lock)
    before any store is built, the desktop included, and lets it go as the
    last leg of its quit. A server takes over a lock whose process is gone,
    or is itself (a container restarting its one process), never one naming
    another machine, and refuses a directory whose Electron `SingletonLock`
    names a running app; refused, it exits 66.
  - _The desktop always starts, and wins._ `takeDataDir`
    (`src/server/core/take-data-dir.ts`) reports any error from the lock or
    the record (EACCES, ENOSPC, EBUSY from an antivirus) as a diagnostic and
    the app runs without them. It holds Electron's single-instance lock for
    its profile, so it takes over any lock naming a desktop whatever its pid
    or host name (a Mac's changes with the network), and any lock naming a
    server: that server sees the lock is no longer its own within half a
    second, stops and exits 66, and the desktop's gateway and RPC bind only
    once its process has gone (closing a listener removes the socket file at
    the shared path).
  - _Secrets sealed by the desktop._ `<dataDir>/studio-data-dir.json` records
    which cipher seals the directory (`desktop-keychain` or `server-key`);
    an unrecorded directory is a desktop's when Chromium's `Local State` is in
    it or any sealed file is not a data key's. A server refuses such a
    directory (65), or with `--share-desktop-data-dir` runs with a cipher that
    is unavailable by design: every store treats a secret as session-only,
    never opens what is on disk, never seals over it and never deletes it
    on a clear. The core also
    refuses to start a server whose cipher could seal into a desktop's
    directory, so the guard holds for an embedder that skips the entry.
  - _Startup and shutdown order._ Platform, then the core (lock, record,
    stores), then the gateway's socket and discovery, then the RPC socket,
    then ready. Stop is the reverse: the RPC (it audits into the gateway's
    log), the gateway, the registry flushed around the chats' end, the hosts'
    helpers, the lock, released only after every transcript is closed. The
    chats stop together, not one after another. A stop that takes over ten
    seconds leaves anyway and leaves the lock to be found abandoned; a second
    signal does not wait. The entry's handlers are installed before startup,
    so a stop asked for then runs once the server is up.
  - _A bundle away from its dependencies._ The two packages only a chat
    loads (the Claude agent SDK, the ACP SDK) are resolved at start, and a
    bundle that cannot find them exits 70 naming them.
- **Risks left.** A lock whose process id came round to an unrelated process
  reads as held until that process ends; the message names the file to
  remove. Taking over a stale lock has a narrow race between two starters on
  one directory. The desktop now writes `run/studio.lock` and
  `studio-data-dir.json` into its profile, which nothing reads but a server.
  The server's owner credential for the RPC is phase 2's in-memory token,
  which no client of a headless server can learn yet (the envelope or a 0600
  token file of 9.2 is phase 6's).
- **For phase 6.** Spawn `startStudioServer`'s options through the bootstrap
  (or `utilityProcess` `postMessage`), not argv; take `packaged`,
  `resourcesDir`, `appRoot` and `appExecPath` from the shell. The shell then
  stops calling `createStudioCore` itself and so stops taking the run lock;
  the server takes it with `role: 'server'` and the desktop's cipher handed
  over (`SecretCipher` via the shell), so `takeDataDir` needs a third case
  for a server that seals with the keychain on the desktop's behalf. Move the
  quit's core legs (`core.shutdown`) behind the control channel's drain. The
  phone lane, scheduled agents, module and companion services already take a
  `ConversationBackend`, so routing them over the protocol is a change of
  implementation, not of callers.

### Phase 4 — The chat view over the protocol (M)

- **Scope.** The renderer's SDK client and `createServerBackedApi`;
  `ConversationTransport` grows the missing members (or a sibling seam) and
  gains a server implementation; the ~75 v1 members route through it; the
  preload's `studioConnection.current()` with per-connection tickets;
  `files.*`, `providers.*`, `workspaces.*`, `settings.launch.*`, `skills.*`
  namespaces server-side. Behind the `SPRINTENGINE_CHAT_TRANSPORT` environment variable, then the default.
- **Tests.** The existing chat view tests run against both transports; the
  conversation seam suite runs over the socket; a reconnect test (kill the
  socket mid-turn, resume from the cursor, no duplicated text).
- **Risks.** Latency on the composer's mention search and on large snapshots;
  measured against IPC before the default flips.
- **As landed.**
  - _The way in._ A window does not open a WebSocket with a ticket (5.5): main
    makes a message channel per connection, serves one end in process
    (`StudioRpcService.connectWindow`, `framePortStream`) and transfers the
    other to the window's preload (`studio:connect`, `studio:port`), which
    keeps the port in its own world and lends the page `studioConnect`,
    `studioPortSend`, `studioPortListen` and `studioPortClose` by connection
    id. Only an app window's top-level document gets one (the IPC sender
    check), at most four at once. The hello still carries a credential: a
    ticket minted for that one connection, good once within thirty seconds,
    which is all the page ever holds. This is phase 6's port-per-window
    decision taken a phase early, so phase 6 hands main's end to the server
    process and changes nothing in the window.
  - _Studio's own window._ A connection attached this way (`ownWindow`) is the
    app's chat view: its events and replies are not redacted, a refusal from
    below is told in its own words, its mutations are not audited, and its
    request bounds are sized for a view (512 in flight, 512 streams) rather
    than a paired app's 8 and 32, because the IPC it replaces refused none of
    these. Frames a stream takes at once go out at once, so deltas merge only
    behind a reader that is actually slow.
  - _The protocol._ `chat.ts` adds `session.*` (start and drive a live session
    with everything the composer sends), `uploads.*` (a picture in pieces of
    512 KiB ahead of the send that names it; 5 MB each, 16 a send, a budget
    per connection, given back with `uploads.discard` and expired on a
    timer; a resent send the runtime holds a receipt for is answered from it
    without its pictures), the
    conversation's `revert`, `rewind`, `fork`, `attachment`, `planDocument`
    and `commands` (and a `conversation.commands` push stream: a new
    `{ t: 'push', sub, payload }` frame for a stream with no cursor),
    `providers.*`, `files.*` (mention search, stat, a picture, a repository
    root; a stat or a picture only inside a workspace's folder or the app's
    stores of sent pictures and plans, by its real path and plain spelling)
    and `workspaces.list`. Three read scopes join
    (`providers:read`, `files:read`, `workspaces:read`), with eight
    capabilities. Every chat method is held to an owner's connection
    (`owner_required`), and so is naming a conversation by its folder
    (`key.workspaceRoot`, `conversation-folders`): a chat started in a run
    worktree is kept there, not in its workspace's folder. `server.ping`
    answers any authenticated client at once.
  - _Main's half._ The chat surface is the conversation IPC's own handler
    object, file search and reads, command list service and repository-root
    lookup (`createStudioChatBackend`), behind the IPC's own input checks,
    now shared (`conversation-ipc-inputs.ts`). It is provided by the core IPC
    registration that builds those handlers, so the standalone server does
    not serve it yet. Sessions are driven through the handlers over the
    core's `ConversationBackend`, never the runtime.
  - _The renderer._ `ConversationTransport` gains `startSession` and `revert`,
    and a sibling seam on every transport, `services`, carries what a chat
    asks of its window's Studio whichever machine it runs on: providers,
    files, a plan as a document and the command lists. The chat files call
    those instead of `window.api`. Each has an IPC and a protocol
    implementation with the same answers (`chatServices.ts`, `studioChat.ts`);
    the window's choice is `SPRINTENGINE_CHAT_TRANSPORT` (`studio`, else the
    IPC), read when a call is made behind one transport object. The window's
    client is the SDK's (`windowStudioClient`), bound to the environment it
    first reached. A chat on the protocol says "Reconnecting to Studio" in
    the composer tray when its connection has been down for a moment.
  - _The boundary._ `ChatViewErrorBoundary` wraps the local chat (AgentPanel)
    and a followed one (RemoteConversationPanel): a chat that throws stops in
    its pane with Reload chat, and the window stays drawn. A chat whose code
    failed to load is loaded again by Reload chat (`reloadableLazy`) and is
    also offered Reload window. It is on for everyone, whichever transport:
    a stopped pane is better than a blank window. It is the one intentional
    visible change in phases 1 to 4 (2026-10-02).
  - _Hardening carried with it._ Command fingerprints: a reused command id
    for a different command is refused `command_id_conflict`, by the router
    while it runs and by the runtime's receipts across a restart. Every
    refusal told in stable words carries an `errorId` the log keeps beside
    the real cause. The SDK refuses a reconnect that reaches another
    environment (`environment_changed`), parks on a refused credential or
    offline until woken, pings a quiet line, times reads out after 60 s, and
    its stream `cursor` moves only as the consumer reads. Catch-up already
    chose a snapshot past 8 MiB as well as past 2,000 events; that now has a
    test.
  - _Parity and latency._ The chat view's suites that script its IPC run a
    second time in a `chat-over-studio` Vitest project over a real RPC
    (`tests/studio-chat-loopback.ts`), with the same assertions and the
    runtime's receipts kept as it keeps them; one IPC-shaped test (a preload
    without the command list) sits out with its reason. A reconnect test drops the
    port mid-reply and checks the text resumes with nothing repeated or lost.
    Measured in process over a Node message channel (5,000 calls): an
    invoke-shaped round trip 4.1 µs mean, `files.stat` over the protocol
    9.7 µs (p99 28 µs), `session.send` 10.2 µs, one streamed event backend to
    client 5.3 µs. The protocol adds about 6 µs a call, against 25–36 µs for
    a call over Electron's own IPC or ports (measured while planning phase 6). A session command
    over the protocol carries a command id, so the runtime keeps a receipt
    for it, which the IPC never did: two writes of the conversation's
    receipts file per command, the first (the intent) awaited before the
    command runs, the second (its result) after.
  - _Still on IPC, and why._ The shell's own members (clipboard, `platform`,
    open externally, reveal, open in an editor, the picture viewer), the
    terminals behind a code block's Run, CLI sign-in and Resume in terminal
    (ruling a), the composer's skill reader (it opens the Extensions
    surface's reader, which reads through the skills domain, a phase 10
    domain), the remote chat's Mesh transport, and the session list and
    history palette outside the chat view.
  - _Why the IPC stays the default._ The suites prove the renderer's side and
    the RPC's; nothing yet runs the real Electron ports end to end in a
    packaged app. Before the default flips: a packaged smoke run drives a
    chat over them, and the receipt writes are measured where they cost
    most, a conversation kept on a WSL path from Windows, where each write
    crosses into the distribution and the first delays every send, stop and
    answer to an approval. If that wait is felt, the intent write needs to
    move off the command's path (written alongside, or batched) first. Keep
    the IPC behind the setting for one release after.
- **Follow-ups.**
  - _Assets beside the socket (phase 9)._ Phase 4 serves nothing over HTTP:
    pictures go over the connection in pieces and come back as data. When the
    web client serves them beside the socket, its routes need signed URLs
    bound to the file and their expiry, `X-Content-Type-Options: nosniff`, a
    sandboxing CSP (or `application/octet-stream`) for HTML and SVG, and
    `Cache-Control: no-store` on anything that carries a credential.
  - _Durable answers (phase 6)._ The router keeps a start's, revert's,
    rewind's and fork's first answer, and every command's fingerprint, in
    memory. Once a server can restart under a window that resends, those need
    receipts that outlive it, as a session's commands already have.
  - _Flow control on a port (phase 6)._ A message port does not push back, so
    a window's connection never queues and never resyncs; the renderer holds
    what it is sent, as it does over IPC. A server in its own process should
    pace a window by acknowledgement rather than by its socket's drain.
  - _The chat surface on a standalone server (phase 6)._ Build the handler
    objects in the core rather than in the IPC registration, so a server with
    no Electron serves the chat surface too.
  - _Paired apps and worktree chats (phase 10)._ A key without a folder is
    resolved by its workspace's folder, as on the tailnet, so a paired app or
    the phone reaches a chat started in a run worktree only through an owner
    that names the folder.

### Phase 5 — Client tools (M)

Spec: [`studio-server/phase-5-client-tools.md`](studio-server/phase-5-client-tools.md).
It replaces "The render host (L)", withdrawn by ruling (f).

- **Scope.** Client toolsets: `tools.offer`, `withdraw`, `focus`, `catalog`
  and `grant`; the `call`, `cancel`, `reply` and `progress` frames; the
  `tools:offer` and `files:write` scopes and the `client-tools` capability;
  `kind` and `instanceId` in `hello`. A per-connection tool list in the
  gateway that only grows; routing by affinity and focus; the grace,
  redelivery and cancellation. `client.tools` in the SDK. The desktop offers
  `browser` (today's 17 tools, unchanged, still in main against the pane) and
  `canvas` (today's eight tools, the canvas service and its worker moved to
  the client side). The owner-only `files` subset that boards are kept
  through. Pairing and Settings for app toolsets.
- **Tests.** A snapshot of `tools/list` before and after the move, identical;
  the browser and canvas suites through the toolsets; a registry suite on a
  fake clock covering every call state; the SDK's redelivery and cancellation;
  path confinement, `ifMatch` conflicts and the `.excalidraw` filter in
  `files`.
- **Risks.** Runtimes that ignore `list_changed`; a mutation run twice after a
  reconnect (held to at most once by the SDK's call memory); two desktops
  editing one board.

### Phase 6 — The local server out of process (L)

- **Scope.** The shell spawns the bundle on Electron's Node with the bootstrap
  envelope; ready, health, restart, logs; the server owns the userData stores
  in 7.2 and main reaches them over the protocol; the gateway and the tailnet
  listener move to the server; the data key handoff and the secret
  re-sealing; the shell offering its toolsets (`browser`, `canvas`, and
  `editor`, `tour` and `terminal` moved onto the same mechanism) over the
  control channel; the in-process fallback flag.
- **Tests.** Spawn and crash-restart tests with a fake child; a packaged smoke
  run (start, chat, quit, relaunch, resume); a single-writer test that fails if
  main constructs a server-owned store; migration of sealed secrets.
- **Risks.** Two writers on one userData during the switch; agents mid-turn at
  app quit (drain); background mode semantics.

### Phase 7 — A server inside WSL (M)

- **Scope.** The server bundle in the WSL install; start over `wsl.exe` with
  the envelope on stdin; connect over localhost with the stdio fallback; a WSL
  workspace's chats route to its distribution's server; `cli-host-child.ts`'s
  WSL branch and the helper's MCP relay are no longer used for chats; the
  client translates paths only at the edge (links, reveal).
- **Tests.** Install script tests extended (staging, markers, pruning); the
  stdio transport against a fake `wsl.exe`; a Windows CI job (or a manual
  checklist where CI has no WSL) for a real chat in a distribution.
- **Risks.** Localhost forwarding configurations; a distribution without
  systemd or with a long login profile; the lifetime of a server nobody is
  attached to.

### Phase 8 — Remote environments over SSH (L)

- **Scope.** The environment list and the Remote band grouping by environment;
  the SSH bootstrap scripts (probe, runtime, bundle, start or reuse, token,
  tunnel); askpass dialogs; managed vs external servers; drain-and-replace
  upgrades; version-skew messages; the `auth` namespace for owners; the
  desktop pane's traffic for that environment sent through the SSH connection
  (a SOCKS forward carried by the relay, on a per-environment partition), so
  `localhost` in the pane is the remote's (8.1).
- **Tests.** Each script against a local `sh` in a temp `$HOME`; an
  integration test against an SSH server in a container in CI, including a
  dev server on the remote's loopback with hot reload seen through the pane;
  skew tests with a fake server advertising the window's edges.
- **Risks.** The variety of SSH setups (jump hosts, `ControlMaster`, 2FA
  prompts); old glibc on remotes below the pinned Node's floor.

### Phase 9 — The web client and the embedded chat (L)

- **Scope.** The web build target; the server serving it with the module asset
  routes; the web `window.api` shim and its fallbacks (section 11); pairing a
  browser to a session cookie; `Origin`/`Host` checks; `studio-server pair`;
  `previews`, the port pass-through on an origin of its own (8.2); the web
  client offering `canvas`. Then, after the web client, the embeddable
  read-only chat (an iframe route and a React component).
- **Tests.** The web build in CI; the shim's missing-member report is empty for
  the chat route; cookie, ticket and origin tests on the server; a preview
  with hot reload, and a preview that cannot reach Studio's cookies or API;
  the canvas suite through the web client's toolset.
- **Risks.** Renderer code that assumes Electron in ways the type guards do not
  catch; module asset origins; agent-written code on a preview origin.

### Phase 10 — The rest of the surface (XL, ongoing)

- **Scope.** Domain by domain: the module host's server halves and
  `module.invoke` / `module.events`; bundled modules split onto the kernel;
  the git panel and file explorer data (ruling c); backlog, scheduled agents,
  tours, design; the tailnet conversation lane folded into the single
  multiplexed socket with the old lane kept for the phone's window.
- **Tests.** Per domain, the handler object tested directly and through the
  router.
- **Risks.** Scope creep; each domain is its own reviewable unit and ships
  when it is ready.

## 14. Risks across the plan

- **Two writers on one data directory** while the local server and main share
  userData. Mitigated by the single-writer rule and a test for it (phase 6).
- **Agents across a server restart.** Stateless providers lose an in-flight
  turn; stateful ones resume from their cursors. `server.shutdown { drain }` and
  the "suspended" state cover upgrades; a crash shows the turn as interrupted.
- **The phone's pinned files.** Everything new goes in new files; the pin test
  fails loudly if not.
- **Performance of the chat over a socket** vs IPC. Measured in phase 4 before
  the default changes.
- **Agents without a client.** With no desktop attached, agents have no
  browser and no canvas, and a laptop that sleeps takes them away mid-task.
  This is the ruling's intent; the tools answer `client_unavailable` naming
  the fix, and the headless client (8.4) is the later answer.
- **Runtimes that ignore a changing tool list** (Codex, the Cursor agent CLI,
  possibly Grok) see a client that attaches mid-session only at their next
  session. Lists only grow per connection (6.3), so nothing they hold goes
  stale. Their chats are not handed the gateway at all yet (R86); their
  terminal sessions are.
- **Agent-written code on a preview origin** (phase 9). A dev app shown to a
  web client runs in the person's browser; its origin is never Studio's, and
  Studio's cookies never reach it (8.2).

## 15. Open questions for the owner

These questions, and the decisions the phase specs raise, are resolved in
[`studio-server/decisions.md`](studio-server/decisions.md) (owner ruling
2026-10-01). That file classifies every decision, settles the ones that have a
settled answer, and lists only the rest for the owner. Where its rows change
what this design says, this file is amended when the phase that implements them
lands. The owner ruling of 2026-10-02 (ruling f) superseded three of them
outright; they are kept, marked, so the numbering holds. The phase 5 spec's
own open decisions are rows R80–R86 of that file. The questions as they were
asked, with where each is answered:

1. **Package names.** Answered (owner ruling 2026-10-01):
   `@sprintengine/studio-protocol`, depending on and re-exporting the
   conversation package, which stays the phone's subset (5.4).
2. **Local server lifetime.** Settled: it exits with the app (R01).
3. **Secrets on headless hosts.** Settled: a 0600 key file, with no keyring
   probing (R12).
4. **Sign-in without terminals.** Settled: device code, browser callback or
   paste-back, credentials, and a sign-in-only terminal for the CLI's login
   command (R34).
5. **The person's browser pane.** Superseded by the 2026-10-02 ruling: the
   server has no browser, so the pane is the desktop's native pane on every
   route (its traffic sent through the SSH connection for an SSH server), and
   the web client shows previews of dev servers instead (section 8). R37 is
   superseded with it.
6. **Chromium source by default, and running without the sandbox.**
   Superseded by the 2026-10-02 ruling: no Chromium on any server. R40–R43
   are superseded.
7. **Attached-client rendering fallback.** Superseded by the 2026-10-02
   ruling: rendering by an attached client is now the only path, and a
   general one (6.3). R47 is superseded.
8. **Remote targets.** Settled: Linux and macOS over SSH. WSL is the only
   Windows answer (R33).
9. **Publishing the server.** Settled: yes, to npm and as an archive (R08).
10. **Third-party `entry.main` that imports `electron`.** For the owner: R60.
11. **Web exposure.** Settled: tailnet web over HTTPS through `tailscale serve`
    in phase 9, never plain HTTP (R19).
12. **Terminals later.** Settled: out of scope until chat reaches parity on
    every route (R09).
