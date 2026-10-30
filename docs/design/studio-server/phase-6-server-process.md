# Phase 6: the local Studio server out of process

Status: scoping spec, 2026-10-01; implemented behind the flag on 2026-10-02,
section 6.3's toolsets on 2026-10-03 once phase 5 merged (see
"Implementation status" below). This document
refines phase 6 of `docs/design/studio-server.md` (section 13) and the parts of
sections 4.3, 5.5, 6.3, 9.3 and 10.1 it touches. It also covers the module
server/client split that phase 10 completes (section 12 here). Where this
document asks for a change to the overall design, it says so in section 3. The
owner rules on it there or in section 14 before code lands.

Amended 2026-10-02 for the owner ruling of that date: the server has no
browser and no canvas. Phase 5 is now client tools
(`phase-5-client-tools.md`), so the shell's pane and canvas reach the server
as the `browser` and `canvas` toolsets it offers, not as `ShellBridge`
members, and the canvas service is the shell's.

## Implementation status (2026-10-03)

Built, behind `SPRINTENGINE_SERVER_MODE` and the Advanced toggle, with in
process still the default (decision R04): the bootstrap envelope and control
frames (6.1), the stdio and parent-port carriers and the serve loop (7.2),
the run lock guarding the socket (7.2), `ShellBridge` both ways (6.3, the
non-tool half), the IPC tunnel and the preload router (6.2), the supervisor
(7.1), the utility-process launcher and the server log (10), the port broker,
the desktop server's composition with the module kernel (12.2, 12.4), the
shell's composition out of process with `ServerStateMirror` (5), the keychain
as the server's cipher (9.1), the split quit (7.4), the MCP bridge's
reconnect (6.5), the server's state in words, the Advanced toggle and the
boot fallback (7.1, O9), the seam tests and `scripts/smoke-server-mode.mjs`
(16), and the shell's toolsets over a port it brokers on the control channel
(6.3). Each section says what was amended at implementation.

Not built yet:

- **The toolsets in process.** With the server in the shell's process, the
  gateway still serves `editor`, `tour`, `terminal` and `agent` itself, and
  the shell offers `browser` and `canvas` only, as phase 5 left it: the flag
  off changes nothing. Out of process every one of the six is the shell's.
  An agent lists the same tools either way (`shell-toolsets.test.ts`); their
  order within `tools/list` differs, the shell's toolsets first.
- **Section 8's measurements.** `measure-startup.mjs --server-mode` exists;
  no comparison has been run. Section 16.4's manual checklist (packaged and
  notarized builds, Windows, Linux) has not been run either.
- **Dev restart on rebuild (R9).** The server is part of the main build, so a
  change to it restarts the whole app under `electron-vite dev`.
- **A transcript's own words for a server crash** (7.4): a turn a crash cut
  short still reads "The app closed while this turn was streaming."
- **The CI job for the both-modes matrix** (16.2) and the import-graph
  single-writer guard (16.1).

## 0. Owner defaults this spec is built on (2026-10-01)

| Default | What it means for phase 6 |
| --- | --- |
| The local server exits with the app | No detached or background server on the desktop. Background mode (the tray) keeps the app alive, which keeps the server alive. |
| Secrets use the system keyring where one exists, otherwise an owner-only file | On the desktop, the shell's `safeStorage` is the keyring (Keychain, DPAPI, libsecret or kwallet). A headless server keeps a 0600 key file in a 0700 directory and probes no keyring (decision R12, owner ruling 2026-10-02). |
| A third-party module that imports `electron` has its server half skipped, based on a capability | The server never loads such an `entry.main`. The in-process path still does. |
| No terminals in v1 | Terminals, their node-pty sessions, the agent-state socket and terminal snapshots stay in the Electron shell. |
| The server is small (owner ruling 2026-10-02) | No browser and no canvas in the server process. The shell offers its pane as the `browser` toolset and its canvas service and worker as the `canvas` toolset (phase 5); the server routes agents' calls to them and keeps only the board files. |

## 1. What phase 6 delivers

The desktop app starts a separate **Studio server process** for its own
machine. These move into that process:

- the conversation core that phases 3 and 4 made Electron-free and reachable
  over the protocol;
- the MCP gateway (`automation.sock`, discovery files, audit);
- the tailnet listener and the mesh;
- provider, GitHub and module secrets;
- the module kernel with every module's server half.

The Electron main process becomes the **shell**. It owns windows, terminals,
the browser pane, the canvas service and its worker window, update, tray,
menus, dialogs, OS notifications and account sign-in. It reaches server-owned
state over the protocol, and offers the server its toolsets.

The whole phase sits behind a flag that is **off by default**. With the flag
off, the app runs exactly as it does today, in one process, from the same
files.

Three principles shape every decision below:

1. **Phase 6 moves processes, not data.** No file in userData changes path or
   format. Secrets stay sealed by the same `safeStorage` ciphertext (section
   9). Rollback is therefore a flag flip, with no migration either way.
2. **One writer per file, decided at boot.** With the flag on, the shell
   constructs no server-owned store. With it off, the server is never spawned.
   A file never has two writers in one session.
3. **The hot paths that do not need to move do not move.** Terminal output is
   the highest-volume channel in the app, and it stays inside the shell.

## 2. Where things stand (findings)

Paths are relative to the repository root.

### 2.1 Startup and shutdown

- `src/main/index.ts` takes the single-instance lock, registers the
  `studio-module://` scheme, then dynamically imports `app-main.ts`.
- `app-main.ts` builds the whole service graph **synchronously, before
  `ready`**, in this order:
  1. `createAppServices` (`app-services.ts`, 2,163 lines);
  2. `registerCoreIpc`, about 60 `registerXIpc` calls;
  3. the module kernel (`loadMainModules`);
  4. three late-bound resolvers: scheduled agents, module enablement, module
     MCP tools.
- `app-lifecycle.ts`, at `ready`:
  - `automationService.initialize()`, not awaited;
  - the splash window, then the main window with `deferShow`;
  - `prepareWorkspacesAtBoot` with a 4 s budget;
  - the boot discovery legs;
  - reveal on `app:boot-complete`, or at the 10 s `BOOT_REVEAL_TIMEOUT_MS`.
- Agent launches wait on `whenAgentLaunchReady`: the gateway is ready **and**
  `agentIntegrationReady` (the launcher and plugin home are written) has
  settled.
- Quit is one ordered list of 16 legs (`app-lifecycle.ts`, `runShutdown`):
  modules (begin), timers, automations, agent state, workspace registry, chat
  transcripts, terminals, pull requests, chats, canvas, command lists, registry
  (final), integrations, WSL helpers, telemetry, modules.
  - Each leg is best-effort.
  - No overall budget applies, except "Restart to update", which allows 10 s
    (`UPDATE_SHUTDOWN_BUDGET_MS`).
  - There is no confirmation when quitting with running agents.
- Background mode (`background-presence.ts`) keeps main alive with no windows
  when the setting is on. macOS stays alive anyway.
- There is no `crashReporter`, no `uncaughtException` handler in the app, and
  no log rotation for `diagnostics-YYYY-MM-DD.jsonl`.

### 2.2 The Electron runtime facts that decide the spawn mechanism

Each fact was measured or read in this tree (section 13 has the numbers):

- **Electron 44.4.5 embeds Node 24.21.0.** That is the exact version
  `wsl-node-runtime.ts` pins for WSL. The local and remote servers can run one
  Node version.
- **No Electron fuses are configured.** `RunAsNode` is on, and the app already
  depends on it: the MCP stdio bridge, the `studio-run` launcher, hook scripts
  and the managed npm shims all run `process.execPath` with
  `ELECTRON_RUN_AS_NODE=1`.
- **`utilityProcess` is already used**, by `design-system/utility-process-fork.ts`.
  - It cannot be forked before `ready`.
  - Its `process.execPath` is the **Helper** binary, not the app binary.
  - `require('electron')` inside it returns only `{ net, systemPreferences }`.
  - It dies with main when main is SIGKILLed.
- **The only native module is `node-pty`**, and it stays with terminals.
  The ripgrep dependency ships a plain executable. **The server has no native addons**,
  so there is no ABI question for the local server or for the Linux bundles.
- **Lazy `require('electron')` sites.** Under `ELECTRON_RUN_AS_NODE`,
  `require('electron')` returns a path string. Three sites have no object
  guard and would throw rather than degrade: `secret-store.ts`,
  `plugin-registry-instance.ts` and `mcp-config-service.ts`.

### 2.3 The gateway reaches into everything

`createAutomationService` (`app-services.ts`) takes:

- every backlog, workspace, conversation, canvas, browser, editor, tour,
  terminal, agent-launch, module and tailnet backend;
- `hasWindow` and `onTailnetEvent`/`onMeshEvent` closures over
  `BrowserWindow.getAllWindows()`.

Moving the gateway therefore moves its data backends with it. The backends
that act on a screen or a terminal become **toolsets the shell offers**
(phase 5's mechanism, section 6.3 here): `browser` and `canvas` from phase 5,
and `editor`, `tour` and `terminal` moved onto it in this phase.

`mcp-socket-server.ts` unlinks any existing socket file unconditionally at
start. Its comment says this is safe only because the app's single-instance
lock rules out a live second owner. A server process needs a lock of its own
before it unlinks anything (section 7.3).

The MCP stdio bridge (`resources/automation/mcp-stdio-bridge.mjs`) exits when
its socket closes. Today a gateway restart is an app restart, so this has
never mattered. **With a restartable server, every running agent, terminal
agents included, would lose its Studio tools for the rest of its session**
(section 6.5).

### 2.4 IPC, broadcasts and window identity

- **The preload.** It spreads 51 `api/*.ts` modules into `window.api`. They
  make 282 `ipcRenderer.invoke` calls, 43 `on`, 41 `removeListener` and 15
  `send`. Each module imports `ipcRenderer` directly. There is **no
  `sendSync`** anywhere. The preload reads only `process.env` and no files.
- **Main.** It has 364 `ipcMain.handle` handlers and 13 `ipcMain.on`
  listeners.
- **Push channels.**
  - About 35 server-owned channels: conversation, workspace sync, launch
    settings, hosts, tailnet, mesh, modules, scheduled agents, canvas, tours,
    editor reveal, skills and CLI model discovery. (Since the 2026-10-02
    ruling the canvas channels stay with the shell: the canvas service is
    client-side.)
  - About 30 shell-owned: terminal, browser pane, window, menu, update,
    splash.
  - Three hybrid: `auth:*` and `browser:open-request`.
- **State keyed by `WebContents` lifetime**: conversation subscriptions, mesh
  followers, command-list subscribers, git `windowRetains`, fs watchers, canvas
  subscribers and the terminal sender.
- **Window identity travels in the URL query** (`windowId`). Main reads it
  back from `event.sender.getURL()` in `workspace-sync-ipc.ts`.
- **Ask-and-ack loops across windows**: editor reveal, tour reveal and
  goto, dock diff.
- **Sender validation.** `ipc-sender.ts` `isAppSender` checks for a top-level
  frame, a real `BrowserWindow` and the renderer URL. Only 9 handlers call
  it.

### 2.5 Credentials

| Store | File | Today |
| --- | --- | --- |
| Provider secrets (`secret-store.ts`) | `provider-secrets/*.bin` | `safeStorage` ciphertext, 0600 |
| GitHub token (`github-token-store.ts`) | `github-token.bin` | `safeStorage`, static `app` import |
| Module secrets (`module-secrets.ts`) | `module-secrets/<id>.bin` | `safeStorage`, injected from `agent-runtime-module.ts` |
| Mesh tokens (`tailnet-mesh-store.ts`) | `tailnet-mesh-connections.json` | base64 `safeStorage` in JSON |
| Tailnet device tokens (`tailnet-devices.ts`) | `tailnet-remote-devices.json` | SHA-256 hashes only, no cipher |
| Account refresh tokens (`auth-service.ts`) | `*-refresh-token.bin` | `safeStorage`; **stays in the shell** |

No code chooses a Linux `safeStorage` backend. Where no keyring answers,
Electron's default applies (`basic_text`). Section 9.3 covers that case.

### 2.6 userData today (one real profile, names only)

```
agent-integration/  agent-launch-settings.json  agent-prompts/  agent-state.sock
automation-server-info.json  automation.sock  cli-update-notices.json
conversation-attachments/  conversation-commands-cache.json  git-changelists/
host-context/  integration-ledger.json  marketplace-registry-cache.json
model-discovery-cache.json  model-feed-cache.json  module-asset-origin-secret
module-enablement.json  plugin-installs.json  pull-requests/  skill-repos/
skill-sources*.json  sources-feed-cache.json  sprintengine-launch-settings.json
sprintengine-studio-mcp-audit.jsonl  sprintengine-studio-mcp-info.json
studio-area-skills.json  studio-plugin.json  tailnet-mesh-connections.json
tailnet-remote-devices.json  tailnet-remote-settings.json  terminal-snapshots/
terminal-startup/  tool-bin/  trusted-modules.json  window-material.json
workspace-backup.json  workspace-registry.json
(+ Chromium's own: Local Storage, Cache, SingletonLock, …)
```

## 3. Changes this phase asks of the overall design

Each change is a recommendation. Section 14 lists them as decisions.

| # | Section of `studio-server.md` | Today it says | Change |
| --- | --- | --- | --- |
| D1 | 10.1 spawn | A child process on `process.execPath` with `ELECTRON_RUN_AS_NODE=1`, envelope on stdin | **`utilityProcess.fork`** for the desktop-local server. The envelope arrives by `postMessage`. The same `server.mjs` keeps a stdio bootstrap for WSL, SSH and CI. |
| D2 | 5.5 the preload | The renderer opens a loopback WebSocket with a single-use ticket | **A `MessagePort` per window, brokered by main** to the utility process. Desktop windows need no network listener, ticket or `Origin` rule. Tickets remain for remote environments. |
| D3 | 5.4 the SDK | WebSocket and socket transports | `@sprintengine/agent-sdk` gets a `StudioTransport` seam (`send`, `onFrame`, `close`) with WebSocket, Node socket and MessagePort implementations. |
| D4 | 9.3 secrets | Desktop: data key handed over in the envelope, `*.bin` re-sealed during phase 6 | Desktop: **the shell is the cipher** (`seal`/`open` over the control channel), and the files stay byte-identical. Data keys apply only to headless servers. Phase 6 does no re-seal migration. |
| D5 | 8.1 render host, source 1 | The server launches the app's Electron binary as a headless render host | **Superseded (2026-10-02).** The parent's render host is gone. What D5 asked for on the desktop (the shell's canvas worker and pane) is now the only path on every server, as the shell's `browser` and `canvas` toolsets (phase 5), and no server runs a Chromium. |
| D6 | 10.1 lifetime | The server exits when its parent exits and no other client is attached | The local server exits with the app, always (owner default). A server never "attaches to an existing one" on the desktop: the app's own lock already rules out a second shell per profile. |
| D7 | 7.2 split | The full list of server-owned files | Phase 6 moves a **subset** (section 5). Git changelists, pull requests (moved since: 5.2), tours, skills and marketplace, memory, design and the file-explorer data stay with the shell until phase 10. |
| D8 | 6.2 gateway | The audit and socket move unchanged | They move unchanged, plus a server run lock before any unlink, plus an MCP bridge that reconnects (section 6.5). |
| D9 | 4.2 interfaces | `StudioPaths` and others | Add `appExecPath` and `helperExecPath` to `StudioPaths`. A guard test forbids `process.execPath` under `src/server/`. Add a `ShellBridge` interface for what is not an agent tool: cipher, the terminal runtime behind two internal service tokens, revealing a tab, power and visibility hints, analytics sink, integrations-ready gate. Agent-facing shell tools are toolsets (6.3). |
| D10 | 4.3 third-party modules | Open question: capability or API bump | Use an `electron-main` host capability, an optional manifest field, and a load-time `require('electron')` interceptor. The host API version is not bumped (section 12.4). |
| D11 | 6.3 client tools (2026-10-02) | `editor.*`, `tour.*`, `terminal.*`, `agent.launch` and `backlog.work` reach windows through in-process brokers | They become the shell's `editor`, `tour` and `terminal` toolsets on phase 5's mechanism, offered over the control channel, rather than `ShellBridge` members (section 6.3). `ShellBridge` keeps only what is not an agent tool. As built: `agent.*` is a toolset of its own (wire names are `<toolset>.<tool>`), and `backlog.work` stays the server's and launches through `ShellBridge.terminals` (6.3). |

D1 and D2 go together. A child started with `ELECTRON_RUN_AS_NODE` cannot
receive a `MessagePort`, so choosing D1 is what makes D2 possible.

**Why `utilityProcess` and not `ELECTRON_RUN_AS_NODE`** (measured in section
13 unless noted):

| | `utilityProcess.fork` | `spawn(execPath)` + `ELECTRON_RUN_AS_NODE` |
| --- | --- | --- |
| Dies with main on crash or force quit | yes, immediately (E3) | only if the server watches stdin EOF (E2: 6 ms) |
| Direct port to each renderer | yes (`MessageChannelMain`) | no; needs a loopback WS listener or a relay through main |
| Renderer round trip, mean | 25 µs (E4) | 49 µs over WS, 70 µs relayed through main |
| Can start before `ready` | no; about 25–45 ms later in boot (E5) | yes |
| Binary | the signed Helper on macOS (inherit entitlements); the app's own exe on Windows and Linux | the main app binary (main entitlements) |
| Leaks `ELECTRON_RUN_AS_NODE` into every agent it spawns | no (`env` is clean, E6) | yes, unless scrubbed. An agent that runs an Electron project's `npm start` would get a Node process instead of an app. |
| Shows in `app.getAppMetrics()` | yes, by `serviceName` | no; only through the `ps` walk |
| Works if a later hardening turns `RunAsNode` off | yes | no |
| Same code path as WSL and SSH | no: a second bootstrap adapter, about 60 lines | yes |

The last row is the only cost, and it is small: the server core is
transport-agnostic after phase 3. Only `src/server/bootstrap/` differs.

## 4. Process architecture in phase 6

```
┌──────────────────────── Electron main = the shell ────────────────────────┐
│ windows · menus · tray · dialogs · OS notifications · update · account    │
│ terminals (node-pty) · agent-state.sock · terminal snapshots               │
│ browser pane · canvas service + worker · integrations (launcher, hooks)    │
│ git panel · file explorer · skills/marketplace · tours UI · design · memory│
│                                                                            │
│ ServerSupervisor ──fork──► utilityProcess "studio-server"                  │
│ PortBroker: MessageChannelMain per window                                  │
│ ShellBridge (cipher, reveal, hints, …) · toolsets: browser, canvas, editor,│
│ tour, terminal (offered over the control channel, phase 5's mechanism)     │
└──────┬───────────────── parentPort (control channel) ─────────────┬───────┘
       │                                                            │
       │  ┌──────────── utilityProcess: Studio server ──────────────┐│
       │  │ StudioCore: conversations, providers, checkpoints,      ││
       │  │ thread index, workspace registry, launch settings,      ││
       │  │ secrets (sealed via the shell), backlog, board files,   ││
       │  │ scheduled agents, companion agents, module kernel and   ││
       │  │ module server halves                                    ││
       │  │ MCP gateway: automation.sock ◄── agent CLIs (bridge);   ││
       │  │ client tool calls routed to the shell's toolsets        ││
       │  │ tailnet listener + mesh ◄── phone, other desktops       ││
       │  └───────────────▲──────────────────────────────────────────┘│
       │                  │ one MessagePort per window (D2)           │
  ┌────┴─────┐       ┌────┴─────┐                                   │
  │ window 1 │  …    │ window n │  preload ChannelRouter: server-owned│
  └──────────┘       └──────────┘  channels → port, shell → ipcMain  │
```

There are three channels, all of them process-private:

1. **The control channel** (`parentPort` ⇄ `UtilityProcess.postMessage`).
   It carries the bootstrap envelope, `ready`, health pings, shutdown and
   drain, the shell's client session (the shell is an owner client with the
   shell role, capabilities `reveal-tab`, `notify` and `cipher`, and the
   toolsets `browser`, `canvas`, `editor`, `tour` and `terminal` it offers
   with `tools.offer`), the `call`, `cancel`, `reply` and `progress` frames
   of its toolsets, and the requests for `ShellBridge`.
2. **One window port per renderer.** Main creates a `MessageChannelMain`. It
   sends `port1` to the server with `{ attachClient: { clientId, windowId,
   kind: 'desktop-window' } }` and `port2` to that window's preload. The frames
   are the Studio protocol of `studio-server.md` section 5, as structured
   clones instead of JSON text, plus the legacy IPC tunnel (section 6.2).
3. **The existing listeners**, now opened by the server: `automation.sock` or
   the named pipe, and the tailnet listener. Phase 6 adds **no** loopback TCP
   listener. That arrives with the web client (phase 9).

The port is the identity. Main is the trusted broker: it only ever hands a port
to a top-level app frame of a `BrowserWindow` it created, the same check as
`isAppSender`. Webview guests, module asset frames and the splash never get
one. The renderer's main world never sees the port either: the preload keeps
it in the isolated world and exposes only `window.api` functions.

## 5. Ownership in phase 6

The rule: **a store is constructed in exactly one process per session, chosen
at boot by the flag.** The other process reaches it over the protocol.

| Owner with the flag on | Files and services |
| --- | --- |
| **Server** | `automation.sock`, `sprintengine-studio-mcp-info.json`, `automation-server-info.json`, `automation-settings.json`, `sprintengine-studio-mcp-audit.jsonl`; `tailnet-remote-settings.json`, `tailnet-remote-devices.json`, `tailnet-mesh-connections.json`; `provider-secrets/`, `github-token.bin`, `module-secrets/`; `module-storage/`, `module-enablement.json`, `trusted-modules.json`; scheduled agents; `conversation-attachments/`, conversation plans, approval rules, `conversation-commands-cache.json`; `sprintengine-launch-settings.json`, the CLI runtime and host settings; `workspace-registry.json`, `workspace-backup.json`; `model-discovery-cache.json`, `model-feed-cache.json`, `cli-update-notices.json`; canvas board files (written only through `files.write`, phase 5); checkpoints and their sweep; title generation; companion agents; mobile control; backlog service; `pull-requests/` (the pull request record, a server domain since 2026-10-03, 5.2) |
| **Shell** | Chromium's own files, the pane's partitions included; the canvas service, its worker window and its pending writes (it keeps boards through the server's `files.*`); `window-material.json`, background mode, update channel and install note, color scheme; account refresh tokens; `terminal-snapshots/`, `terminal-startup/`, `agent-state.sock`, `agent-prompts/`, `agent-launch-settings.json` (terminal launches); `integration-ledger.json`, `agent-integration/`, `tool-bin/`, the `~/.sprintengine/bin` launcher and pointer, `~/.sprintengine/instances`; `git-changelists/`; skills, plugins and marketplace caches and installs; tours; memory graph; design system; hosted card and source feeds; telemetry consent and install id; `module-asset-origin-secret` and the `studio-module://` handler |
| **Read by both, written by one** | `trusted-modules.json` and `module-enablement.json` (written by the server; read per request by the shell's asset handler); the launcher pointer (written by the shell; read by the server to build MCP entries); `host-context/` |

Notes:

- **Integrations stay with the shell** in phase 6. The launcher pointer, hooks
  and repository MCP entries are shared with terminals. They are tied to the
  live-instances bookkeeping and to the quit leg that removes them. On this
  machine the pointer has the same value whoever writes it. The server learns
  that the pointer is written through a `ShellBridge` gate
  (`integrationsReady`), which replaces the in-process `agentIntegrationReady`
  promise in `whenAgentLaunchReady`.
- **Git runs in both processes.** Git is stateless across commands, and both
  processes run it through `git-run.ts`. The server runs git for chat (turn
  diffs, changed files, checkpoints); the shell runs it for the git panel.
  `index.lock` contention is no worse than today's concurrent panel and agent
  use.
- **The shell needs some server state synchronously.**
  - The terminal launch path reads workspace records, launch settings and a
    CLI's credential (`terminal-runtime.ts` calls `resolveSecret`, which is
    already async).
  - The shell keeps a **`ServerStateMirror`**: a read-only, synchronously
    readable copy of the workspace registry snapshot and launch settings, fed
    by their streams.
  - Writes are async calls.
  - Credentials are resolved by a shell-only method,
    `secrets.resolveForLaunch`, that is never granted to any other client.

### 5.1 As built (amended at implementation, 2026-10-02)

- **Module enablement and trust are written by the shell in this phase.**
  Settings' enablement IPC and the third-party install, trust and uninstall
  IPC stay with the marketplace in the shell, so the shell is the one writer
  of `module-enablement.json` and `trusted-modules.json`; the server reads
  both when it loads the kernel, and the shell asks it to apply a change live
  (`modules.apply-enablement`). The table above named the server as their
  writer; one writer is kept either way, and this one needs no second path
  for the marketplace.
- **The shell's view of the core** (`src/main/server-supervisor/remote-core.ts`)
  has the core's shape for the members the shell uses: the registry and the
  workspace bus and the launch settings from `ServerStateMirror`, the agent
  records its launches write sent as calls (answered optimistically), a host
  registry of its own over the mirrored settings for terminals on WSL, and
  the idle threshold passed on. Any other member throws by name.
- **The GitHub token** is the server's; the shell's skills, cards and
  marketplace ask for it over the control channel. A terminal launch's
  credential is `secrets.resolve-for-launch`, asked by the shell only.
- **The boot's workspace pass** (the plugin home and the pass over every
  workspace) stays with the shell, which owns the integrations (decision
  R63): it waits for the server's first snapshot inside the boot budget, so
  there is no `workspaces.prepareAtBoot` call (7.3, step 5).
- **A chat on a WSL machine** does not start out of process. The WSL
  helper is the shell's, and the server configures none, so preparing the
  host fails with "the WSL helper is not available in this process", as do
  the server's git and model discovery for that machine (and no second
  helper is ever started). WSL servers (phase 7) bring it back.

### 5.2 The pull request record moves to the server (2026-10-03)

Owner rulings 2026-10-03: what reacts to chats lives in the server. (A mark
then came only from a branch lookup; since 2026-10-04 a conversation owns the
pull requests its agent opened, design section 6.8.) The record is composed by
the core (`createStudioCore`, `src/server/pull-requests/`), so the in-process
and out-of-process modes build the same one, and the shell builds none. It is
a server domain with no tunnelled channel: clients read it through the Studio
protocol's `pullRequests.*` (design section 6.8). The shell keeps its
terminals, so it tells the server where each terminal agent works
(`pullRequests.noteWork`) and forwards the tool calls their reporters saw
(`pullRequests.noteToolCall`) over a Studio client of its own, the same in both
modes, and puts the lists the server answers on the terminal snapshot. The one
shell channel left is `pullRequest:refreshForSession`, a hover on a terminal
line, which the shell forwards as `pullRequests.refresh`. At quit the server
settles the record in its own legs (`pull requests`, after the chats); in
process the shell's `pull requests` legs do it.

## 6. Interfaces

### 6.1 Bootstrap envelope and ready

```ts
// src/server/bootstrap/envelope.ts (private to the app's own processes; see below)
interface ServerBootstrapEnvelope {
  v: 1
  role: 'desktop-local' | 'headless'
  dataDir: string               // the app's userData, unchanged (7.1 of the design)
  logsDir: string
  runDir: string                // <dataDir>/run, created 0700
  tempDir: string
  paths: {
    resourcesDir: string | null; appPath: string | null; isPackaged: boolean
    appExecPath: string         // the app binary: launcher pointer, MCP fallback entry
    helperExecPath?: string     // what process.execPath is inside a utilityProcess
  }
  app: { version: string; buildStamp: string; channel: 'latest' | 'nightly' }
  owner: { tokenHash?: string } // headless only; the desktop needs no token (D2)
  listeners: { gateway: boolean; tailnet: 'from-settings' | 'off' }
  secrets: { kind: 'shell'; available: boolean } | { kind: 'key-file' }   // section 9
  flags: Record<string, boolean> // forwarded SPRINTENGINE_* switches (diagnostics, timeline)
}

type ServerToSupervisor =
  | { t: 'ready'; pid: number; environmentId: string; version: string; buildStamp: string;
      gateway: { socketPath: string | null }; tailnet: { bound: string | null } ; bootMs: number }
  | { t: 'pong'; seq: number; loopLagMs: number; rssMb: number }
  | { t: 'shutdown-progress'; leg: string; done: number; total: number; durationMs: number; failed: boolean }
  | { t: 'fatal'; code: ServerExitCode; message: string }

type SupervisorToServer =
  | { t: 'envelope'; envelope: ServerBootstrapEnvelope }      // parent port only; stdio sends the bare envelope
  | { t: 'ping'; seq: number }
  | { t: 'shutdown'; drain: boolean; budgetMs: number }
  | { t: 'attach-client'; clientId: string; windowId: string | null; kind: 'desktop-window' | 'shell' } // port transferred
  | { t: 'detach-client'; clientId: string }
```

Beside these, either end may ask the other through a small request, answer
and event layer (`src/server/bootstrap/control-rpc.ts`: `req`, `res`,
`event`). `ShellBridge` (6.3) and `supervisor.call` (6.4) are built on it.

Amended at implementation (2026-10-02):

- **Where it lives.** An earlier draft put the envelope in the
  conversation-protocol package. Both ends are this app's own processes,
  built from one commit and checked by build stamp, so it is not a surface
  another program codes against; a published package would make it one, with
  a compatibility row to keep. It lives in `src/server/bootstrap/`.
- **No heap cap.** `limits.maxOldSpaceMb` is gone: decision R06 settled O10
  the other way (Node's own limit applies).
- **`secrets`.** The server must answer `available()` synchronously while it
  composes its stores, before any request to the shell could return, so the
  shell's answer at fork time travels in the envelope. A headless server says
  `key-file` (decision R12).
- **`gateway: boolean` and `tailnet: 'off'`.** The seam tests start a server
  with no listeners.

The desktop delivers the envelope by `postMessage`. WSL, SSH and CI deliver
it as one stdin line (`studio-server --bootstrap stdio`).
`src/server/bootstrap/parent-port.ts` and `src/server/bootstrap/stdio.ts`
both produce the same control channel, and `serveOnChannel`
(`src/server/bootstrap/serve.ts`) reads the envelope from it, starts the
role's server, says `ready`, answers pings and runs the shutdown legs. A
message that arrives before anyone listens (a `shutdown` sent during boot) is
held, not dropped.

**Exit codes**, which tell the supervisor whether to retry:

| Code | Meaning | Retried |
| --- | --- | --- |
| 0 | Clean shutdown | no |
| 64 | Envelope missing or invalid | no |
| 65 | Data directory unusable (missing, not writable, wrong owner) | no |
| 66 | Run lock held by a live server | no; attach not offered on the desktop (D6) |
| 67 | Protocol or build-stamp mismatch with the shell | no; dev rebuild only |
| 70 | Uncaught error | yes |
| 75 | Temporary failure (listener bind raced, `EMFILE`) | yes |
| signal | Killed or crashed | yes |

### 6.2 The legacy IPC tunnel

Phase 4 moved the chat view onto Studio protocol methods. Phase 6 moves
domains that still speak `window.api` IPC channels: workspace sync, launch
settings, hosts, tailnet and mesh admin, backlog, scheduled agents, module
bridge, credentials, model discovery, automation admin. Rewriting their 100+
members into typed protocol methods is phase 10 work. Phase 6 **tunnels them
unchanged**:

```ts
// server side: ipcMain-shaped, so registerXIpc(ipc, services) moves verbatim
interface ServerIpcRegistry {
  handle(channel: string, handler: (caller: CallerContext, ...args: unknown[]) => unknown): void
  on(channel: string, listener: (caller: CallerContext, ...args: unknown[]) => void): void
  removeHandler(channel: string): void
}
interface CallerContext {
  clientId: string              // the window port's id; subscriptions are released when it closes
  windowId: string | null       // from the window's URL query, asserted by main at attach
  kind: 'desktop-window' | 'shell'
  /** Throws `IpcSenderUnavailable` naming the channel: catches handlers that still touch WebContents. */
  readonly sender: never
}
// frames on the window port
{ t: 'ipc.invoke', id, channel, args }  →  { t: 'ipc.result', id, ok, value | error }
{ t: 'ipc.send', channel, args }
{ t: 'ipc.push', channel, args }                       // server → window
```

- **`ClientBus` targets** replace the broadcast loops one for one: `all`,
  `workspace-windows`, `{ clientId }` and `{ exceptClientId }`. The last one
  covers `workspace-sync:event`, which skips its sender today. In process a
  window's client id is its `webContents.id`; out of process it is the id main
  gave its port. The tunnel (`src/server/ipc/ipc-tunnel.ts`) is the server's
  `ClientBus`.
- **Routing in the preload.** `src/preload/ipc-router.ts` exports an `ipc`
  object with the `ipcRenderer` methods the api modules use. It routes by
  channel through one table, `SERVER_IPC_CHANNELS`
  (`src/shared/ipc-channel-owners.ts`). The 50 api modules change one import
  line each.
  - Server channels go to the port.
  - Every other channel goes to `ipcRenderer`: the shell is the default.
  - With the flag off, every channel goes to `ipcRenderer`.
  - Amended at implementation (2026-10-02): push channels are not classified.
    A listener hears a push from either side, since a push comes from
    whichever process owns its domain; only invokes and sends need routing.
  - The server's domains are registered in one function,
    `registerServerDomainIpc` (`src/server/desktop/server-ipc.ts`), which main
    calls on `ipcMain` in process and the server calls on its tunnel out of
    process, so both modes register the same handlers.
- **Classification completeness.** A test fails when a channel the server
  registers is missing from the table, or the table lists one the server does
  not register (`src/server/desktop/server-ipc.test.ts`). This is the same
  rule as `STUDIO_METHOD_SCOPES` in the design. Since the shell is the
  default, a shell channel needs no entry.
- **Before the port arrives**, invokes on server channels queue in the preload.
  The queue holds at most 256 entries, and each times out after 30 s with
  `ServerUnavailable`. Listeners for server push channels are kept locally and
  start receiving once the port is attached.
- **When the port closes** (the server restarted), pending invokes reject with
  `ServerUnavailable { restarting: true }`. The table marks idempotent reads
  (`retry: 'once'`): the router re-sends those on the new port; nothing else is
  re-sent.
- **Handlers that use `event.sender`.** Amended at implementation
  (2026-10-02): rather than typing `sender` as `never`, the tunnel hands each
  handler a stand-in with exactly the part of a `WebContents` the tunnelled
  domains use: a numeric `id`, `send` (a push to that window alone),
  `isDestroyed`, and the `destroyed` event (and `did-navigate`, accepted and
  never fired), which fires when the window's port goes: a closed window, a
  reload, a crashed renderer. That is what the `WebContents`-keyed
  subscriptions in 2.4 need, so they move verbatim and end with their window as
  they do today. **Any other member throws `IpcSenderUnavailable` naming the
  channel and the member**, so a missed conversion (a `getURL()`, a
  `BrowserWindow.fromWebContents`) still fails loudly in a test. The window id
  comes from `event.caller.windowId`, which main asserts when it attaches the
  port; `registerWorkspaceSyncIpc` already takes it as an option. The 9
  `assertAppSender` calls become no-ops on the server side (the port is
  app-frame-only), through an injected check, because `ipc-sender.ts` imports
  Electron.
- **Ports.** The tunnel has a port of its own per window (`kind:
  'desktop-window'`). The chat view's Studio protocol connections keep the
  per-connection ports and tickets phase 4 built (`studio:connect`); out of
  process, main hands the server those ports instead of serving them itself.
  One multiplexed port would have to reimplement the reconnect and ticket
  rules phase 4 already has per connection.

### 6.3 `ShellBridge` and the shell's toolsets

What the server asks of the shell splits in two.

**Agent tools are toolsets.** Phase 5 made the pane and the canvas client
toolsets (`browser`, `canvas`), offered with `tools.offer` by the client that
holds the shell role. In process, that client is main's port attached with
`shell: true`; out of process it is the control channel, which is
process-private. The server routes `call` frames to it and receives `reply`
and `progress` back, exactly as for any client tool, so the server carries no
CDP and no canvas code. Phase 6 moves the rest of the gateway's screen and
terminal tools onto the same mechanism instead of building bespoke bridge
members: the shell offers `editor` (`editor.*`), `tour` (`tour.*`) and
`terminal` (`terminal.*`, `agent.launch`, `backlog.work`, under today's wire
names). `terminal` is offered only to a server on the shell's own machine
(parent 6.3).

As built (2026-10-03, `src/server/desktop/shell-toolsets.ts`):

- **Six toolsets, not three.** A toolset's tools are `<toolset>.<tool>` on
  the wire (phase 5, 3.1), so one toolset cannot hold `terminal.*` and
  `agent.launch` under today's names. The shell offers `browser`, `canvas`,
  `editor`, `tour`, `terminal` (`terminal.list`, `terminal.create`) and
  `agent` (`agent.launch`, `agent.status`); `agent` is a reserved name, so the
  shell role may offer it and no app can. The server serves the rest of the
  automation tools and refuses no family by halves: a test holds that the
  split loses no tool, doubles none, and leaves no family on both sides.
- **`backlog.work` stays the server's.** Its family is (`backlog.list`,
  `backlog.read`, …), and an offer may never shadow a family the server
  registers (phase 5, 7.2). It starts its terminal through
  `ShellBridge.terminals`, as do a scheduled run and resume in terminal,
  which are not agent tools. So `ShellBridge.terminals` is the server's one
  way to start a terminal: for those three and the two internal service
  tokens (12.2).
- **How the shell reaches the server.** The control channel carries frames
  of its own, so the shell's Studio client gets a port: main creates a
  `MessageChannelMain`, posts one end with `attach-client { kind: 'shell' }`,
  and asks `studio.connect-shell`, which attaches it to the server's Studio
  RPC with the shell role and answers a ticket good once. The control channel
  is process-private, so whatever asks there is the shell. Each reconnect
  brokers a new port and a new ticket.
- **The server coming back.** The shell's client is started at boot and
  retries a failed first connect with backoff (phase 5's `start()` gave up
  after one try, which in process could not fail). After that the SDK
  reconnects by itself, and offers every toolset again on the new connection;
  the supervisor's ready wakes it so it does not wait out its backoff. The
  server's gateway expects all six (`expectShellToolsets`), so an agent's
  first `tools/list` after a restart waits up to 5 s for them, as in process
  it waits for the browser and the canvas.
- **What the server reads of the shell's terminals.** `backlog.work`'s
  confirmation and the launch cap read the live sessions, so the shell sends
  them (`terminals.sessions`) on every coalesced sessions broadcast. The
  launch tokens (decision R87) its terminal launches are issued cross as
  SHA-256 digests with their identity (`gateway.launch-tokens`), never the
  token, so the server's gateway proves those agents' bridges. A server that
  has just started asks the shell for every live one before its gateway
  listens (`shell.launch-tokens.live`): the shell's terminals outlive it, and
  the MCP bridge reconnects with the token it was given the moment the socket
  is back (6.5).
- **Timeouts.** `agent.launch` and `terminal.create` may cut a worktree and
  then wait 20 s for a live session, so their call deadline is 120 s; the
  others keep phase 5's default.
- **At quit** the shell's client closes before the server drains (7.4,
  "desktop tools"), so the server's goodbye is not answered by reconnecting.

**What is not an agent tool stays on `ShellBridge`:**

```ts
interface ShellBridge {
  cipher: { available(): Promise<boolean>; seal(plain: Uint8Array): Promise<Uint8Array>; open(sealed: Uint8Array): Promise<Uint8Array> }
  terminals: { launchAgent(input: AgentLaunchInput): Promise<AgentLaunchResult> }   // backlog.work, scheduled runs, resume in terminal, and the two internal service tokens (12.2)
  reveal: { tab(target): Promise<boolean> }                                       // the reveal-tab capability: a notice clicked, a deep link
  notify(n: ServerNotification): void                                      // OS notification, bell, dock badge
  analytics(event: AnalyticsEvent): void                                    // consent and install id stay in the shell
  integrationsReady(): Promise<void>
}
```

The in-process implementation calls the shell services directly, so the flag-off
path uses the same interface. The out-of-process implementation sends
requests on the control channel. The `browserPane` (CDP over the control
channel) and `canvasRender` members an earlier draft had are gone (owner
ruling 2026-10-02).

As built (`src/server/shell-bridge/`, `src/main/shell-bridge.ts`):

- **A notice carries its click as data.** `notify({ key, title, body,
  activate })` names a reveal target, and the shell carries the click out
  itself, so no closure has to cross the channel. The targets are `remote`
  (the Remote popover) and `app`; the tailnet notifier is the one server-side
  caller today, and it already goes through the bridge in process.
- **Analytics names are checked on the shell's side** against the closed
  event list (`isTelemetryEventName`), and the record keeps only plain
  property values, so a server cannot open a new series.
- **The integrations gate is one request** the shell answers once its
  launcher and plugin home are written. Like `agentIntegrationReady`, it
  never fails: a shell that cannot answer lets launches proceed.
- **The shell that is gone** fails each call by its own rule: a seal rejects,
  a launch answers `shell_unavailable`, a reveal answers false.

The shell sends the server **hints**:

- `power { suspend | resume | lock | unlock | battery }`, from `powerMonitor`;
- `visibility { anyWindowVisible }`, which replaces the mesh's `hasWindow`;
- `focus { appFocused }`, for tours, editor tools and the tailnet notifier;
  routing among clients that offer a toolset reads phase 5's `tools.focus`,
  which the shell sends beside it;
- `online`.

### 6.4 `ServerSupervisor` in the shell

```ts
interface ServerSupervisor {
  readonly state: SupervisorState
  onState(listener: (s: SupervisorState) => void): () => void
  start(): void                               // at app ready
  whenReady(budgetMs: number): Promise<'ready' | 'timeout' | 'failed'>
  attachWindow(win: BrowserWindow): void      // brokers a port now and after each restart / reload
  call<T>(method: string, params: unknown): Promise<T>   // control-channel request
  shutdown(opts: { drain: boolean; budgetMs: number; onLeg?: (leg) => void }): Promise<'exited' | 'killed'>
  restart(reason: string): void               // Diagnostics action
}
```

### 6.5 The MCP bridge across server restarts

`mcp-stdio-bridge.mjs` gains a reconnect loop. It only reconnects when the
info file's `pid` changed or the socket reappears within 30 s.

1. The bridge keeps the client's MCP `initialize` request and the
   `notifications/initialized` that followed.
2. On reconnect it resends the `sprintengine.studio/connect` frame, replays
   `initialize`, and swallows the duplicate response.
3. It answers in-flight requests with an MCP error ("Studio restarted; retry").
4. It then sends `notifications/tools/list_changed`.

Bridges already running in a CLI session started before the update cannot
benefit. A CLI started afterwards does.

As built (`resources/automation/mcp-stdio-bridge.mjs`, local mode): the
bridge now reads the client's lines instead of piping them, so it can hold
what the client sent before the first socket connected (the connect frame has
to be first), answer every request that was waiting when the socket closed,
and answer at once anything sent while Studio is away. The replayed
`initialize` carries an id of the bridge's own, whose answer it keeps from
the client. A bridge never gives up on its Studio while its client is there:
it looks again with a backoff of 250 ms doubling to 5 s, for as long as it
takes (an app that crashed or quit may be started again minutes later), and
leaves with code 0 only when its client closes stdin. An MCP client marks a
stdio server that exits "not connected" for the rest of its session, so a
bridge that left on its own would cut the agent off from a Studio that came
back.

## 7. Process lifecycle

### 7.1 Supervisor state machine (shell side)

```
                 flag off
   ┌──────────────────────────────► IN_PROCESS (no server; today's app)
   │
 BOOT ──app ready──► STARTING ──ready──► READY ◄──────────────┐
                       │  │                 │ │               │
          exit 64–67 ◄─┘  │ exit / timeout  │ │ exit, crash,  │ ready
          (no retry)      │ (attempt < 3)   │ │ or 3 missed   │
              │           ▼                 │ │ pongs         │
              │       BACKOFF ◄─────────────┘ │ (kill first)  │
              │   0.5 s · 1 · 2 · 4 · 8 · 10  │               │
              │       │  └──timer──► STARTING ┘───────────────┘
              │       │ 5 crashes in 120 s, or 3 failed boots
              ▼       ▼
            FAILED  (banner: Retry · Open logs · Restart in compatibility mode)
                       │ Retry → STARTING (counters reset)

 any of STARTING, READY, BACKOFF ──quit / update──► STOPPING ──exit──► STOPPED
                                                        │ budget spent
                                                        └──► SIGKILL ──► STOPPED
```

- **Backoff resets** after 60 s in `READY`.
- **The boot budget** is 15 s from fork to `ready`. A first boot on a large
  workspace registry is the slow case, and the window does not wait for it
  (7.2).
- **Health.** The supervisor sends a ping every 5 s. Each pong carries
  event-loop lag (`monitorEventLoopDelay`) and RSS. Three missed pongs (15 s)
  mean the server is hung: the supervisor kills it and restarts it. **On
  `suspend`, the watchdog is paused.** It resumes 10 s after `resume`, so a
  laptop lid never counts as a hang.
- **Only one child at a time.** The supervisor never forks a new server until
  the previous child has emitted `exit`. A hung child is SIGKILLed first. This
  closes the race where two servers share one userData during a restart.
- **Compatibility mode.** "Restart in compatibility mode" writes
  `server-mode.json` = `in-process` and relaunches. It is the user-facing
  rollback.
- **The boot-time fallback (decision O9), as built.** When the supervisor
  gives up and no server reached `ready` this session, the shell leaves a
  note of the reason and relaunches with `--studio-server-fallback`, which
  runs that launch in process without touching `server-mode.json`; the next
  ordinary launch tries the separate process again. The fallback launch says
  why, once, in the window's banner and in Settings. Building the in-process
  services in the failing session instead would have made it the second
  writer the rule forbids.
- **In words** (`src/renderer/src/components/studioServer/`): a strip across
  the top of a workspace window says "Starting Studio server…" (only after
  1.5 s), "Reconnecting to Studio server…", or "Studio server stopped." with
  the reason, Retry and Restart in compatibility mode. Settings → Agents →
  Studio server holds the Advanced toggle (restart required), the phase, the
  process's id, uptime and memory, Open log and Restart server. This is also
  the Diagnostics section of 10: it lives in Settings beside the gateway and
  the paired apps, which the Diagnostics window does not show.
- **As built** (`src/main/server-supervisor/supervisor.ts`): `FAILED` carries
  `neverReady`, true when no server reached `ready` this session, which is
  the case decision O9's boot-time fallback applies to. A server stopped for a
  quit is never restarted, and a fork that throws counts as a failed boot.

### 7.2 Server state machine (server side)

```
BOOTING ──envelope ok──► LOCKING ──run lock acquired──► COMPOSING (createStudioCore)
   │ bad envelope (64)      │ live holder (66)                │
   ▼                        ▼                                 ▼
 EXIT                     EXIT                  LISTENING: control channel ready;
                                                gateway socket bound; tailnet per settings
                                                              │ emit `ready`
                                                              ▼
                                                SERVING ──shutdown{drain}──► DRAINING ──► EXIT 0
                                                   │ parent port closed (shell gone)
                                                   └──► exit at once (nothing can be shown;
                                                        the transcript flush is attempted first)
```

**Run lock.** The lock phase 3 added, `<dataDir>/run/studio.lock`, serves:
it is written whole and linked into place, and holds `{ role, pid, hostname,
startedAt, token }`. A lock whose pid is dead, or is this process's own, is
stale and replaced. A headless server refuses a live holder, and refuses a
directory whose Electron `SingletonLock` names a running app. The desktop
takes any lock over (its single-instance lock already makes it the profile's
only app), and a headless server that loses its lock that way stops and exits
66. **The desktop's out-of-process server takes the lock with the desktop
role**, as main does in process: it is the app's own process tree, it must not
be refused by its own parent's `SingletonLock`, and a crashed predecessor's
lock is its to replace (the supervisor never forks while that predecessor
lives, 7.1). Only the lock holder may unlink a stale `automation.sock` (D8):
the socket server asks before it removes a file it finds, and a process
without the lock leaves the file and reports the failed listen. In-process
mode takes the same lock, so even a misconfigured flag cannot produce two
gateways.

Amended at implementation (2026-10-02): an earlier draft named a new
`server.lock` with a `bootId` and a "younger than `startedAt`" rule for a
reused pid. The phase 3 lock already answers both cases for the desktop (it
takes over), and a headless server meeting a reused pid refuses with a
message that names the file to remove, which is the safe side of a guess.

### 7.3 Startup ordering with the flag on

1. `index.ts` takes the single-instance lock. This is unchanged.
2. `app-main.ts` reads `server-mode.json`, a shell-owned file, synchronously.
   `SPRINTENGINE_SERVER_MODE` overrides it for dev and CI. Then:
   - it builds **shell services only** (`createShellServices`);
   - it registers the shell's IPC handlers;
   - it builds the `ServerStateMirror`, which is empty until the server is
     ready.
3. At `ready`:
   - the supervisor forks immediately;
   - the splash and the deferred main window are created **in parallel**,
     without waiting for the server;
   - the splash shows "Starting Studio server" as one more progress row.
4. The server becomes ready (about 40 ms plus composition, E5). The supervisor
   then:
   - sends the shell session (capabilities and hints);
   - brokers a port to every window that exists;
   - starts the mirror's streams.
5. Boot discovery's workspaces leg becomes `supervisor.whenReady(budget)`
   followed by `call('workspaces.prepareAtBoot')`, inside the existing 4 s
   budget. The cli, editors and updates legs are unchanged.
6. **Reveal is as today.** If the server is not ready by the 10 s reveal
   timeout, the window reveals anyway. Chat and other server-backed panes then
   show "Starting Studio server…" in words, never a status dot. Everything the
   shell owns works meanwhile: terminals, the git panel, the file explorer and
   Settings sections that do not read server state.
7. **Deferred boot jobs** (WSL CLI detection, the checkpoint sweep, the plugin
   source check) run where their data lives. The checkpoint sweep and model
   discovery run in the server and start on `SERVING`.
8. Module startup hooks run in the server after `COMPOSING`. The shell sends
   `integrationsReady` once `prepareStudioIntegrations` has written the
   launcher. Launches wait for it exactly as `whenAgentLaunchReady` does today.

### 7.4 Quit, "Restart to update", and agents that are running

The 16 legs split across the two processes and run partly in parallel:

```
t0  shell: modules(begin, shell) · timers · drop tray · canvas (pending board
      writes go to the server while it still serves, bounded at 2 s) · withdraw
      toolsets
t0' shell → server: shutdown { drain: true, budgetMs: 8000 }
      server legs: modules(begin) · timers · automations (mesh, tailnet, socket,
      discovery files, audit) · workspace registry · chat transcripts · chats
      (stop sessions, dispose adapters) · command lists · registry (final) ·
      modules  → exit 0
t0  shell (concurrently): agent state · terminals · pull requests (flush, dispose)
t1  both done (or server SIGKILLed at its budget)
    shell: integrations (skipped when leaving for update) · WSL helpers ·
    telemetry · modules (shell)
```

- **Transcripts flush first in the server.** They are what a person would
  miss, exactly as today.
- **Board writes flush before the drain.** The canvas service is the shell's,
  and its last writes reach disk through the server's `files.write`, so they
  go before the server stops serving. Withdrawing the toolsets stops new
  calls reaching the shell (they answer `tool_withdrawn`); a call already
  in flight to it is cancelled with `shutting_down` when the server drains
  (phase 5, 8.1 and 8.4).
- **Integrations run only after the server has exited.** No chat agent is left
  to use the MCP entries being removed.
- **As built** (`app-lifecycle.ts`): the shell's legs are modules (begin),
  timers, canvas, desktop tools (the shell's client closes, which withdraws
  its toolsets), then the server's drain starts (8 s, 6 s when leaving for
  an update) while the shell's agent state, terminals and pull requests run;
  `studio server` waits for it before integrations, WSL helpers, telemetry
  and modules. The server's legs are modules (begin), local app socket,
  automations, workspace registry, chat transcripts, chats, command lists,
  the registry again, modules, and the data directory; a lost parent runs
  only the transcripts, the registry and the lock.
- **"Restart to update"** forwards the server's `shutdown-progress` to the
  progress window. The 10 s `UPDATE_SHUTDOWN_BUDGET_MS` covers both processes.
- **Windows: the server must be gone before the NSIS hand-over.** The installer
  waits on main's pid only, but the server is the same executable image. If
  the drain overruns, the supervisor SIGKILLs it inside the update budget.
- **Running agents.** The app does not confirm a quit with running agents today,
  and phase 6 keeps that (decision O7).
  - In-flight turns end as interrupted. The transcript reader already closes an
    open turn on load. Its text, "The app closed while this turn was
    streaming.", stays accurate for a quit.
  - A server crash gets its own text: "Studio server stopped while this turn
    was streaming."
  - Stateful providers resume from their cursors on the next turn.

### 7.5 Failure scenarios

| Scenario | Behaviour |
| --- | --- |
| **Server crashes while the UI is up** | The ports close, and every window shows "Reconnecting to Studio server" (words). The supervisor restarts with backoff. On `ready`, new ports are brokered, and chat views resubscribe from their cursors (phase 4). In-flight IPC invokes reject; idempotent reads retry once. Agent CLIs that were children of the server lose their stdin and exit, and their turns read as interrupted. Composer drafts live in the renderer and survive. Pending permission prompts are lost with their turn. Terminal agents keep running in the shell; their MCP bridges reconnect (6.5). |
| **Server hangs** (a synchronous loop, a deadlock on a sync fs call) | The shell stays responsive, which is an improvement on today, where the same hang freezes every window. After 15 s the watchdog kills the server, restarts it, and records a diagnostic with the last event-loop lag. |
| **A renderer crashes or reloads** | `render-process-gone` or `did-start-navigation` makes main send `detachClient` for that window. The server releases that client's subscriptions. On `did-finish-load` main brokers a new port. Nothing else is affected. |
| **Main crashes or is force-quit** | The utility process dies with it (E3). Server-side transcript buffers not yet flushed are lost, as they are today when main dies. The next launch recovers: the run lock is stale, the socket is unlinked by the new lock holder, and open turns are closed as interrupted. |
| **A quit arrives during `STARTING` or `BACKOFF`** | `STARTING`: `shutdown { drain: false }`, then SIGKILL after 2 s. Store writes are atomic, so a kill mid-boot cannot tear a file. `BACKOFF`: the timer is cancelled and nothing is spawned. |
| **Sleep and resume** | The control channel and ports are in-process pipes, so they survive sleep. The watchdog pauses. `power.resume` reaches the server, where the mesh `onWake()` and the scheduled-agents `refresh()` run as they do today. The tailnet listener's address poll handles a changed tailnet IP. |
| **Two app instances** | Same profile: refused by the app lock, unchanged. Different profiles (a dev build and the packaged app): separate userData, sockets, servers and locks. They share the launcher pointer as today (a dev build never overwrites a live packaged pointer). Both enabling tailnet on port 8471 conflicts, as it does today. |
| **Upgrade while running** | The local server is the app's own bundle, so app and server are never skewed in a packaged build. The macOS swap happens after quit, the Windows installer after the drain, and an AppImage keeps its old mount until exit. The `hello` window check and a build-stamp equality check still run. A mismatch exits 67, which only a dev rebuild can produce. In dev, `electron-vite` rebuilds `out/server/server.mjs` and the supervisor restarts the server on change, without restarting main. |
| **Read-only DMG, App Translocation, AppImage mount** | The server writes only under userData, logs and temp. `utilityProcess` can fork a script inside `app.asar`, as the design-system fork already does from resources. The pointer at a translocated or mounted path is an existing problem that phase 6 neither causes nor fixes; noted in section 11. |
| **Disk full or userData not writable** | The server exits 65 before `ready`, and the supervisor goes straight to `FAILED` with the server's own message. |

## 8. Performance

Numbers are from section 13, on an Apple-silicon Mac with Electron 44.4.5.

- **Per-call cost from a renderer:** today's `ipcRenderer.invoke` to main is
  36 µs mean. A port to the utility process is **25 µs**. A relay through main
  to a socket would be 70 µs, which is why D2 avoids the relay. All of these
  are noise next to the composer's ripgrep mention search or a 16 KB snapshot
  part (41 µs on a socket).
- **Push throughput, 100,000 events of about 200 bytes:** `webContents.send`
  510k/s, port 364k/s, WebSocket 164k/s. A streaming chat emits tens to a few
  hundred events a second. Fifty concurrent chats stay below 1% of the port's
  ceiling. The protocol's delta merging and bounded queues still apply.
- **Terminal data does not cross the new boundary.** It is the one channel
  whose volume could approach these ceilings.
- **Boot:**
  - `utilityProcess.fork` cannot start before `ready`. It is ready about
    40 ms after the fork, versus a pre-`ready` child process ready about 25 ms
    sooner in absolute time.
  - Parsing today's 2.9 MB main chunk takes about 27 ms cold.
  - Service composition moves rather than grows, and it now runs **in
    parallel** with window creation instead of before `ready`. Main should
    reach `ready` sooner than it does today.
  - Acceptance: `scripts/measure-startup.mjs --server-mode out-of-process`
    shows no more than 100 ms regression at `reveal` (median of 5 runs, reused
    profile).
- **Memory:** a second V8 isolate with Node costs about 60–70 MB RSS idle.
  Main's heap shrinks by what moves, so expect +40–70 MB net. It is reported in
  Diagnostics through `app.getAppMetrics()`, where the utility process appears
  by `serviceName`.
- **Main-thread relief.** Today the stall monitor sees main blocked by service
  work (transcript writes, model discovery, gateway calls). That work leaves
  main. Acceptance includes the stall monitor's p95 under a scripted chat load
  not regressing, and ideally improving.

## 9. Secrets

### 9.1 Desktop (phase 6)

- `SecretCipher` on the server is the `ShellBridge.cipher`. The shell answers
  with `safeStorage.encryptString` and `decryptString`, so every `*.bin` and
  every `sealedToken` stays **byte-identical**.
- Plaintext secrets cross only the control channel, a process-private Mojo
  pipe between two processes of the same user. They never touch a socket.
- The server caches opened values in memory, the way `ProviderSecretStore`
  does today.
- **As built** (`src/server/shell-bridge/shell-cipher.ts`, amended at
  implementation 2026-10-02): `SecretCipher` gains optional `sealAsync` and
  `openAsync`, and the stores that seal or open in an async path (provider
  secrets, the GitHub token, module secrets) go through `sealSecret` and
  `openSecret`, which prefer them. In process nothing changes: the Electron
  cipher has only the synchronous forms. The mesh store opens its tokens
  synchronously as it is built, so the server opens those ahead of time
  (`prime`) before it composes; a ciphertext nobody primed fails to open there,
  which that store already keeps for a later launch rather than overwriting.
  A new pairing's token is written first without its seal and again once the
  keychain answers. The shell's answer to `available()` at fork time rides in
  the envelope, and `prime` asks again.
- The three unguarded lazy `require('electron')` sites (`secret-store.ts`,
  `plugin-registry-instance.ts`, `mcp-config-service.ts`) take injected
  dependencies in phase 1. In the server, a `require('electron')` that slipped
  through would get `{ net, systemPreferences }` and fail on use, so the
  import-graph guard is the protection.
- Account refresh tokens never leave the shell.

### 9.2 Headless servers (phases 7 and 8, recorded here for the owner default)

`SecretCipher` uses a random 32-byte data key with AES-256-GCM, kept in a
0600 key file in `<dataDir>/run/` inside a 0700 directory
(`createKeyFileSecretCipher`, which phases 1–4 already built). No keyring is
probed: SSH and WSL sessions almost never have an unlocked one, and the agent
CLIs' own logins on those hosts already rely on the same user boundary
(decision R12, owner ruling 2026-10-02; an earlier draft probed
`/usr/bin/security` and `secret-tool` first). `server.info` reports the
choice. The envelope says `secrets: { kind: 'key-file' }`.

### 9.3 Linux desktop without a keyring

Electron's `safeStorage` falls back to `basic_text` there: a fixed,
well-known key. Today the app treats that as "encryption available".

Phase 6 keeps that behaviour (principle 1), and the server reports it in
`server.info` and Diagnostics. Changing it to the owner-only key file is a
format change, with a re-seal migration and a rollback cost. It is listed as
decision O4 and is not part of phase 6.

## 10. Logging and diagnostics

- **Server logs.** `utilityProcess.fork({ stdio: 'pipe' })`. The supervisor
  writes stdout and stderr, line-buffered with timestamps, to
  `<logs>/server-YYYY-MM-DD.log`. Each file is capped at 10 MB, and 14 days
  are kept. This is also the first rotation the logs directory has had. The
  last 200 lines stay in memory for the `FAILED` banner and Diagnostics.
- **Diagnostic entries.** `writeDiagnosticLog` in the server writes its own
  `diagnostics-server-YYYY-MM-DD.jsonl`, so two processes never append to one
  file. The Diagnostics window merges both files by timestamp.
- **`server.info` and the Diagnostics "Server" section** show:
  - state, pid and uptime;
  - restarts this session, with the last exit code or signal;
  - event-loop lag (p50 and p99), RSS;
  - gateway socket and tailnet bind;
  - which `SecretCipher` is in use;
  - the run lock holder.
  
  The section also offers Restart server, Open server log, and Copy diagnostics.
- **Process metrics.** `getAppMetrics()` lists the server. The `ps` walk in
  `child-process-metrics.ts` already descends from main's pid, so agent CLIs
  under the server keep being classified.
- **Crashes.** No crash reporter exists today, and phase 6 adds none. The
  server installs an `uncaughtException` handler that writes a diagnostic and
  exits 70. An `unhandledRejection` is logged and not fatal (amended at
  implementation, 2026-10-02): the same code has run in main, where one has
  never ended the app, and a server restarted on each would lose every chat
  for a promise someone forgot to catch. No heap cap is passed (decision R06
  settled O10 the other way): Node's own limit applies, and an OOM is a crash
  the supervisor restarts.
- **As built.** The log is `src/main/server-supervisor/server-log.ts`: a day
  that passes 10 MB continues in `server-YYYY-MM-DD.1.log`, files are 0600,
  and lines the shell says about the server (a fork, an exit, a kill) are
  marked `[shell]`. A hung server is ended with SIGKILL on POSIX, since a
  blocked event loop runs no SIGTERM handler.

## 11. Code signing, platform and packaging

- **No second executable.**
  - On macOS the server runs as the existing `<App> Helper`, which
    electron-builder already signs with `entitlements.mac.inherit.plist`
    (`allow-jit`, `allow-unsigned-executable-memory`,
    `disable-library-validation`) and which notarization already covers.
  - On Windows and Linux it is the app's own executable with `--type=utility`.
    SmartScreen reputation, Defender and firewall rules are unchanged.
- **What the Helper's entitlements lack.** It does not have the main
  entitlements' `allow-dyld-environment-variables` and `audio-input`. The
  server needs neither: voice stays in the shell, and nothing sets `DYLD_*`.
- **Local Network privacy (macOS 15+).** The tailnet listener moves from main
  to the Helper. TCC attributes a child to its responsible app, so the existing
  grant should carry over. This **must be checked on a packaged, notarized
  build** before the flag can default on (risk R6).
- **Firewall prompts on Windows.** Same executable image, so no new prompt is
  expected. Verify on a clean VM.
- **Bundle.**
  - `electron.vite.config.ts` gains a fourth target, `server`: `src/server/main.ts`
    becomes `out/server/server.mjs`. It is built with the same externals rules,
    and `electron` is forbidden by the import guard.
  - It is packed in `app.asar` beside `out/main`, so no `extraResources` entry
    is needed.
  - The standalone archives of `studio-server.md` 10.4 reuse the same output.
- **ripgrep.** It is resolved through `StudioPaths.resourcesDir`, the same
  `asar.unpacked` path as today.
- **Pre-existing, not changed by phase 6.**
  - App Translocation and AppImage mounts make the launcher pointer name a path
    that disappears after exit.
  - There is no `APPIMAGE` handling.
  - Both should be fixed where the pointer is written. Phase 6 notes them only
    so the server change is not blamed for them.

## 12. The module split: server half and client half

### 12.1 Where modules stand

| Module | Wiring today | Electron use in its main half | Server half | Client half | Phase |
| --- | --- | --- | --- | --- | --- |
| agent-runtime | kernel module (`agent-runtime-module.ts`) | `app.getPath`, `safeStorage` | conversation, workspace, storage, secrets, GitHub and companion services | — | 6 |
| scheduled-agents | kernel module; six `scheduled-agents:*` channels registered directly | broadcast loop, `app.getPath` | store, scheduler, runner, gateway `schedule.*` tools, the six channels (tunnelled) | panel | 6 |
| third-party | kernel, `createRequire` in main, no sandbox | anything | `entry.main` unless it needs `electron-main` (12.4) | `entry.renderer`, `studio-module://` assets (shell) | 6 |
| canvas | static (`registerCanvasIpc`, `canvas-service.ts`) | hidden worker window, `WebContents` subscribers, export dialog | **none** (2026-10-02): the board files, through `files.*` (phase 5) | everything else: the service, merge, worker window, `canvas.*` tools as the shell's `canvas` toolset, the editor, the export dialog | 5 |
| backlog | static (`registerBacklogIpc`, 17 handlers) | none | backlog service, `backlog.*` tools, mobile control | panel | 6 (the gateway needs it) |
| git | static (`registerGitIpc` 55 handlers, repo watch) | save dialog in `git-ipc.ts`, focus checks in repo watch | phase 6: git for chat only. Phase 10: read models, changelists, repo watch, panel data | panel; dialogs | 10 |
| design system | static; `utilityProcess.fork` for bundle scripts | `utilityProcess`, `templates-path.ts` | phase 10: a `ScriptRunner` with a Node implementation (`child_process.fork` on the server's Node; `helperExecPath` runs as Node, E6) | panel | 10 |
| memory, tours, skills, marketplace | static | windows (tours), dialogs | phase 10, domain by domain | panels | 10 |
| pull requests | the core (`src/server/pull-requests/`), since 2026-10-03 | none | the record, its state reads and `pullRequests.*` | the sidebar marks, peek and tooltips; the shell's terminal notes | 6 (5.2) |
| review | no main-side code in this tree | — | — | — | — |

### 12.2 `MainHost` inside the server (phase 6)

`loadMainModules` moves into the server with the kernel. For each `MainHost`
member:

| Member | In the server |
| --- | --- |
| `registerIpc(channel, handler)` | `ServerIpcRegistry.handle`. The first handler argument becomes a `ModuleCallContext` (`clientId`, `windowId`). The module SDK already types it `unknown`, so no SDK change. `modules:bridge:invoke` and its ownership and `ipc:invoke` checks are tunnelled unchanged. |
| `emit(topic, payload)` | `ClientBus.publish('modules:events', …, 'all')`. Nothing is buffered, as today. |
| `registerMcpTools` | The server's gateway, unchanged. |
| `notify` | Flood-bounded as today, then `ShellBridge.notify`. |
| `provideService` / `getService` / `requireService` | Unchanged and still synchronous: every service a module can reach is in the server process. The two shell-side internal tokens (`core.terminal-runtime`, `core.agent-launch-service`) are provided as async proxies over `ShellBridge.terminals`. Neither token is on the third-party ACL, and no module consumes them today. |
| `registerSkills`, `ensureSkillInstalled` | Unchanged, on the same disk. |
| `registerSidecar` | Unchanged. Lifecycles start after `COMPOSING` and stop during `DRAINING`. |
| `onStartup`, `onShutdownBegin`, `onShutdown` | The server's lifecycle (7.2). The shell's own module legs keep the shell-side hooks. |

**Live enablement.** `applyModuleEnablementLive` runs in the server. The
renderer's override push reaches it through the tunnel, and the server
recomputes `enabledMainModuleIds` and nudges MCP tool lists.

**The asset handler.** `studio-module://` stays in the shell (it serves
renderer frames) and keeps reading `trusted-modules.json` and
`module-enablement.json` per request. Writes go through the server. Both files
are written atomically.

### 12.3 Phase 10: every module on the kernel, both halves declared

- **Bundled modules move to the kernel.** Backlog, git, design, tours, pull
  requests, skills and marketplace stop being static wiring in
  `app-services.ts` and `register-core-ipc.ts`. Each becomes a
  `createBundledMainModules()` entry whose `registerMain` runs in the server.
  Its renderer half is a kernel renderer module. Canvas has no server half
  (12.1): it becomes a kernel renderer module and the shell's toolset.
- **Tunnelled channels become protocol methods.** Each domain's tunnelled
  channels become `module.invoke { moduleId, channel }` or typed namespace
  methods, and the tunnel entry is removed. A domain is done when no channel in
  `IPC_CHANNEL_OWNERS` names it.
- **Shell-only pieces become client capabilities, not server code.** Examples
  are dialogs, focus checks and reveal. A git save dialog becomes "the client
  asks the shell for a path, then calls the server with it".
- **Done for phase 10** means the shell has no store of its own besides the
  client-owned list in design 7.2, and `src/main` imports nothing from
  `src/server` except the supervisor's types.

### 12.4 Third-party modules that import `electron`

The owner default is to skip the server half, based on a capability.

1. **Host capability.** `host.supports('electron-main')` is true only for the
   in-process host, the flag-off path. The server never advertises it.
2. **Manifest field.** An optional, additive field:
   `requires.hostCapabilities: ['electron-main']`. A module that declares it is
   planned as **manifest-only** in the server. Its `entry.renderer` still loads.
   The load report says `skipped: needs electron-main`, and Settings shows that
   in words.
3. **Undeclared imports are caught at load.** Inside a utility process,
   `require('electron')` does not throw, so failure on use would be silent and
   late. The server's third-party loader therefore passes `entry.main` a
   `require` that throws `ElectronUnavailableError` for `electron` and
   `electron/*`. A throw during `registerMain` is classified as
   `skipped: needs electron-main` rather than as a crash. A lazy `require`
   inside a handler fails that call with the same error, and the module is
   marked degraded in the load report.
4. **No host API bump.** `HOST_API_VERSION` stays 1. The capability and the
   manifest field are additive, which is the policy `docs/compatibility.md`
   already applies to capabilities.
5. **The SDK documents it.** `docs/module-authors/` gains a paragraph:
   `entry.main` runs in a Node process with no Electron APIs; a module that
   cannot live without them declares the capability and runs only in the
   in-process host.

## 13. Experiments and results

The experiments were run on 2026-10-01 on macOS (Apple silicon), Electron
44.4.5 (Node 24.21.0), and system Node 25.9.0. The scripts lived in a
scratchpad: a minimal server that reads one envelope, binds a unix socket, a
loopback TCP NDJSON port and a hand-rolled RFC 6455 WebSocket, and answers
`echo` and `stream`. Windows and Linux were not run (section 15, R11).

| # | Question | Result |
| --- | --- | --- |
| E1 | Spawn to ready, for a server on Electron-as-Node (`ELECTRON_RUN_AS_NODE`) and on plain Node, from a Node parent | Median **37–50 ms** on Electron-as-Node, 57 ms on plain Node. Idle RSS **60 MB** vs 50 MB. Socket round trip, 64-byte payload, p50/p99: unix **9–15 / 31–117 µs**, TCP 21 / 58 µs, WebSocket 20 / 54 µs; 16 KB on unix: 41 / 99 µs. Streaming 100k × 200 B events: unix about 1.1–1.4 M events/s (245–320 MB/s), WebSocket about 480–560k/s. |
| E2 | Does a child notice its parent being SIGKILLed? | With stdin piped and an EOF watch: **exits in 6–7 ms**, also when spawned `detached` (its own session). Without the watch: **keeps running**, orphaned. |
| E3 | Does a `utilityProcess` outlive a SIGKILLed Electron main? | **No**: gone at the first check (0 ms). |
| E4 | Renderer-side cost per call (mean over 5,000, the renderer clock is 100 µs-granular) and push throughput (100k events) | `ipcRenderer.invoke` → main **36 µs**; MessagePort → utility **25 µs**; WebSocket → child **49 µs**; ipc → main → unix socket → child **70 µs**. Push: `webContents.send` **510k/s**, MessagePort **364k/s**, WebSocket **164k/s**. Utility ready **38–44 ms** after fork, RSS 68 MB. The `Origin` a `file://` renderer sends on a WebSocket is `file://`, which identifies nothing. That is why D2 prefers ports to an origin rule. |
| E5 | Boot timing, measured from main's start (3 runs) | `ready` at 81–203 ms. A child spawned before `ready` was ready at 106–211 ms. `utilityProcess.fork` **before `ready` is refused** ("cannot be created before app is ready"); forked at `ready`, it was ready at 129–252 ms (+23–49 ms). |
| E6 | What a `utilityProcess` sees of itself | `process.execPath` is `…/Frameworks/<App> Helper.app/Contents/MacOS/<App> Helper`. `process.type` is `utility`. `require('electron')` returns `{ net, systemPreferences }`. `ELECTRON_RUN_AS_NODE` is unset. The Helper binary **does** run as Node with `ELECTRON_RUN_AS_NODE=1` (exit 0, prints 24.21.0). |
| E7 | Parse cost of today's 2.9 MB main chunk under Electron-as-Node (`vm.Script`, top level) | About **27 ms** cold. A V8 code cache of 538 KB was accepted. |

How to reproduce: the server and the parent scripts are each under 150 lines.
`scripts/experiments/server-process/` is a suitable home if the owner wants
them kept. They are not committed with this document.

## 14. Owner decisions, with recommendations

| # | Decision | Recommendation |
| --- | --- | --- |
| O1 | Spawn mechanism for the desktop-local server (D1) | **`utilityProcess.fork`**, with the stdio bootstrap kept for WSL, SSH and CI. |
| O2 | How desktop windows reach the local server (D2, D3) | **A brokered `MessagePort` per window**. No loopback listener until the web client (phase 9). Tickets only for remote environments. |
| O3 | Secrets on the desktop in phase 6 (D4) | **The shell as cipher, formats unchanged.** No re-seal migration in phase 6. |
| O4 | Linux desktop where `safeStorage` falls back to `basic_text` | Keep today's behaviour in phase 6 and report it. In a later phase, move those secrets to the owner-only key file with a one-time re-seal, which satisfies the owner default. |
| O5 | Local render host (D5) | **Superseded (2026-10-02).** No render host anywhere. The shell's worker and pane are its `canvas` and `browser` toolsets (phase 5) on every server. |
| O6 | The phase 6 domain cut (D7, section 5) | Approve the table. Git panel, file explorer, skills, marketplace, tours, memory, PRs and design stay in the shell until phase 10. |
| O7 | Confirm before quitting with running chat turns | **No**: parity with today. Revisit when the server can outlive the app. |
| O8 | Default and rollback | Flag **off** for the phase 6 release. A Settings → Advanced toggle ("Run Studio server in its own process", restart required) plus `SPRINTENGINE_SERVER_MODE`. Default on only after a release of dogfooding with zero `FAILED` reports and R6 verified. The in-process path stays for **at least two releases after** the default flips. |
| O9 | Automatic fallback when the server cannot start | **At boot only**: three failed boots means the session runs in process, with a notice in words and a Diagnostics entry. Never fall back mid-session (two writers). |
| O10 | Server heap cap | `--max-old-space-size=4096`. A crash and restart beats a machine-wide memory squeeze. |
| O11 | MCP bridge reconnect (6.5) | **Yes**, in phase 6. Without it, every server restart silently removes Studio tools from running agents. |
| O12 | Third-party `electron` modules (D10) | The capability, the manifest field and the require interceptor. **No host API bump.** |
| O13 | Who writes the launcher pointer and integrations on the desktop | **The shell**, in phase 6. Headless servers write their own host's pointer (phases 7 and 8). |
| O14 | Keep the experiment scripts in the tree | Optional: `scripts/experiments/server-process/`. |
| O15 | Editor, tour and terminal tools (D11) | **Toolsets the shell offers**, on phase 5's mechanism. One path for every tool a client supplies, with its routing, deadlines and cancellation, instead of bespoke `ShellBridge` members. |

## 15. Risks and mitigations

| # | Risk | Mitigation |
| --- | --- | --- |
| R1 | **Two writers on one userData**: during a restart, a fallback, or a store the split missed | Construction is decided once per session by the flag. The supervisor never forks while a previous child lives. The server run lock is also taken by in-process mode. The single-writer guard (16.1) fails if `createShellServices` reaches a server-owned store module. In dev, `claimStore(name)` throws on a second claimant. |
| R2 | **A tunnelled handler still touches `event.sender`** | `CallerContext.sender` throws by name. The list in 2.4 is converted per domain, and the router-completeness test covers every channel. |
| R3 | **Server restart drops MCP tools from running agents** | The bridge reconnects (6.5), and the restart is visible in words in every window. |
| R4 | **A crash mid-turn loses the turn and pending approvals** | The turn reads as interrupted with server-specific text. Stateful providers resume. The crash-loop limit stops a restart storm. A hang is now survivable for the UI, where today it freezes it. |
| R5 | **Boot regressions**: fork after `ready`, the window waiting on server state | Window creation runs in parallel with the server. Reveal never waits on the server beyond today's budgets. Acceptance is the `measure-startup` threshold (8). |
| R6 | **macOS Local Network privacy, firewall prompts, TCC attribution** for listeners and file access moving into the Helper | Verify on packaged, notarized and signed builds on macOS 15+ and Windows 11 before the default flips. These are blocking items on the dogfood checklist. |
| R7 | **App Nap or background priority** throttling the utility process while all windows are hidden (background mode) | Measure scheduled-agent timer drift and turn throughput with every window hidden, against in-process. If it drifts, the server holds a `powerSaveBlocker`-equivalent through the shell while agents run. |
| R8 | **The tunnel becomes permanent** | Phase 10's definition of done is an empty `server` column in `IPC_CHANNEL_OWNERS`. Each domain's conversion is its own commit. |
| R9 | **Dev loop friction** (separate bundle, separate restart) | The supervisor watches `out/server/server.mjs` in dev and restarts only the server. A build-stamp mismatch logs `[build-skew]` and restarts in dev. |
| R10 | **Lazy `require('electron')` returns something non-null in a utility process**, so guards that test for truthiness pass | The import-graph guard over `src/server/` (phase 3), and the interceptor for third-party code. |
| R11 | **Windows and Linux not measured here** | Re-run E1–E6 on Windows 11 (named pipe, NSIS update hand-over with the server alive) and on Linux (AppImage). Both are on the phase checklist. |
| R12 | **Memory +40–70 MB** | Reported in Diagnostics. The owner accepts it with O1, or the phase waits. |
| R13 | **Mixed versions of the bridge**: an agent started before the update holds an old bridge that does not reconnect | Accepted. Such a session behaves as it does today. |

## 16. Test strategy

### 16.1 Unit and guard tests (vitest, no Electron)

- **Supervisor state machine** against a fake child (`spawn`, `ready`,
  `exit(code)`, `pong`, silence):
  - every transition in 7.1;
  - backoff timings with fake timers;
  - crash-loop and boot-failure limits;
  - non-retryable codes;
  - quit in each state;
  - "only one child" (no fork before `exit`);
  - watchdog pause across `suspend`/`resume`;
  - update budget with SIGKILL.
- **Envelope parser and exit-code classifier**, with fixtures for each code.
- **Server state machine:**
  - the lock: stale by dead pid, stale by reused pid with a newer `startedAt`,
    live holder refused;
  - no socket unlink without the lock;
  - `DRAINING` order matching 7.4;
  - parent-port close leading to exit.
- **Preload `ChannelRouter`:**
  - routing by table;
  - queue before the port arrives (bound and timeout);
  - pending invokes rejected on port close;
  - `retry: 'once'` re-sent on the new port;
  - with the flag off, everything goes to `ipcRenderer`.
- **Channel table completeness.** Every `ipcMain.handle`/`on`, every
  `ServerIpcRegistry` registration and every push channel is classified. A
  generated list is diffed against the table.
- **Single-writer guard.** An import-graph walk from `createShellServices`
  must not reach the server-owned store modules in section 5. The reverse
  walk, from `src/server/`, must not reach `electron`. That second guard
  exists from phase 3 and is extended here.
- **No `process.execPath` under `src/server/`** (a lint-style test).
- **`ShellBridge` contract tests** run against both implementations (in
  process and over a fake control channel): cipher round trip,
  `terminals.launchAgent` errors when no shell is attached, `reveal` with no
  window.
- **The shell's toolsets over the control channel.** Phase 5's `tools/list`
  snapshot is identical in process and out of process, `editor`, `tour` and
  `terminal` included; a `browser` and a `canvas` call round trip through the
  control channel; a server restart leaves the agent's list unchanged and the
  tools answer again once the shell re-offers. As built: the split is held by
  `shell-toolsets.test.ts` (same tools both ways, no family on both sides);
  `desktop-shell-tools.test.ts` covers the first connect retried, every
  toolset offered again after the connection drops, and a family the server
  serves refused; `gateway-launch-tokens.test.ts` the digests; the bridge
  test that the same launch token is presented after a restart; the smoke
  script that a restarted server lists the shell's toolsets again.
- **Module host:**
  - `ModuleCallContext` passed through;
  - the `electron` require interceptor classifying a throwing `registerMain`
    as `needs electron-main`;
  - the manifest field planning a module as manifest-only;
  - `host.supports('electron-main')` false in the server.
- **MCP bridge reconnect** against a socket server that is killed and
  restarted: `initialize` replayed, duplicate response swallowed, in-flight
  request answered with an error, `tools/list_changed` sent.

### 16.2 Seam tests over a real process boundary

- **`studio-server` under plain Node with the stdio bootstrap**, temp data dir
  (extends phase 3's CI boot). Driven through the SDK:
  - a mock-provider chat;
  - a revert;
  - an MCP `conversation.create` through `automation.sock`;
  - a tunnelled `backlog` read;
  - a `scheduled-agents` create;
  - a module event.
- **Kill the server mid-turn and restart it with the same data dir:**
  - the transcript shows the turn interrupted;
  - the cursor resumes without duplicated text;
  - the lock is recovered;
  - the gateway socket is rebound.
- **Both-modes matrix.** The existing conversation, gateway and module seam
  suites run in process and against the child. CI gets a second job;
  `verify:app` stays the in-process run plus the child-boot test.

### 16.3 Electron-level checks

- `scripts/smoke-server-mode.mjs`, a sibling of `measure-startup.mjs`. It
  launches the built app with `SPRINTENGINE_SERVER_MODE=out-of-process` and a
  temp profile, then:
  1. waits for `ready` in the server log;
  2. drives a mock chat through the owner protocol;
  3. SIGKILLs the server pid, waits for `READY` again, and checks the chat
     resumes;
  4. quits and asserts both processes are gone within the budget;
  5. relaunches and checks state is intact;
  6. flips the flag off, relaunches, and checks the same state is read in
     process (the rollback check).
- `measure-startup.mjs --server-mode` comparing reveal and discovery marks
  against in-process.

### 16.4 Manual checklist before the default flips

- packaged and notarized macOS 15+: Local Network prompt behaviour with
  tailnet on;
- Windows 11: firewall, NSIS update with agents running, named pipe gateway;
- Linux AppImage;
- background mode overnight with a scheduled agent (R7);
- sleep and resume mid-turn;
- two profiles side by side.

## 17. Commit breakdown

Each commit leaves `npm run verify:app` green and the flag-off path unchanged.
Sizes are relative.

| # | Commit | Size |
| --- | --- | --- |
| 1 | `feat(protocol): bootstrap envelope, ready and control frames, server exit codes` (new files in the protocol package) | S |
| 2 | `feat(server): stdio and parent-port bootstrap adapters around startServer()` | S |
| 3 | `feat(server): run lock; the gateway unlinks a stale socket only under it` | S |
| 4 | `feat(server): ShellBridge interface with the in-process implementation (cipher, internal terminal launches, reveal, notify, analytics, integrations gate); the shell offers editor, tour and terminal as toolsets beside phase 5's browser and canvas` (flag off: same behaviour) | M |
| 5 | `feat(server): ServerIpcRegistry, CallerContext and ClientBus targets` | S |
| 6 | `refactor(main): createShellServices beside createStudioCore; app-main composes by server mode` (in process both are built, as today) | M |
| 7 | `feat(main): ServerSupervisor state machine with a fake-child test suite` | M |
| 8 | `feat(main): utilityProcess launcher, server log piping and rotation` | S |
| 9 | `feat(main): per-window MessagePort broker and attach/detach on reload and crash` | S |
| 10 | `feat(preload): ChannelRouter with the generated channel-owner table and its completeness test` | M |
| 11 | `feat(server): tunnel the server-owned domains (workspace sync, launch settings, hosts, backlog, credentials, model discovery, automation and mesh admin); convert their event.sender uses` | L |
| 12 | `feat(server): gateway, tailnet and mesh run in the server; power, visibility and focus hints` | M |
| 13 | `feat(server): module kernel in the server; electron-main capability, manifest field and require interceptor` | M |
| 14 | `feat(server): SecretCipher through the shell; secrets.resolveForLaunch for terminals` | S |
| 15 | `feat(main): ServerStateMirror for workspace records and launch settings` | S |
| 16 | `feat(main): split shutdown legs with server drain; update hand-over waits for server exit` | M |
| 17 | `feat(automation): the MCP bridge reconnects across server restarts` | S |
| 18 | `feat(renderer): server state in words (starting, reconnecting, stopped) and the Advanced toggle` | S |
| 19 | `feat(diagnostics): server section, merged diagnostics, restart action` | S |
| 20 | `test: both-modes seam matrix and the child kill-and-resume test` | M |
| 21 | `chore(scripts): smoke-server-mode and measure-startup --server-mode` | S |
| 22 | `docs: compatibility row, module-author note on electron-main, this file's status` | S |

Commits 1–6 are refactors that ship with no behaviour change. Commits 7–19
are inert until the flag is on. The flag stays off by default in the release
that carries them (O8).

## 18. Out of scope for phase 6

- Web, WSL and SSH routes (phases 7–9).
- A browser or a canvas in the server (owner ruling 2026-10-02); the optional
  headless client that offers them with nobody attached (phase 5 spec, §14).
- A server that outlives the app.
- A loopback TCP listener.
- Terminals on the server.
- Re-sealing secrets.
- Rewriting tunnelled channels as typed methods (phase 10).
- Launcher and pointer fixes for translocated or mounted app paths.
