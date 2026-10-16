# Agent launch isolation

What the app hands an agent CLI it launches — its agent-state hook, its MCP
gateway, the person's synced MCP servers, the skill a prompt invokes — which
channel each one travels by, and what is still written anywhere a plain
terminal's CLI would read it.

Two rules drive everything below.

1. **Nothing of the app's belongs in the repository** (owner ruling
   2026-10-16: nobody using Studio should have to add an entry to their
   `.gitignore` and commit it). A file the app writes into a checkout shows up
   in `git status`, gets committed by accident, and hands a colleague who never
   ran the app hook commands and absolute paths that do not exist on their
   machine. What the app hands a CLI comes from outside the project: a
   per-launch flag or variable naming a file under the profile's userData
   directory, or, where a CLI has no such channel, its user-level
   configuration, written while the app runs and inert outside the app's
   launches.
2. **The app's hooks, skills and MCP gateway apply to the sessions the app
   launches, never to a CLI run from a plain terminal.** A file in the
   repository fails this by construction: every CLI started in that checkout
   reads it. A launch flag passes it, because the flag exists only on the
   command line the app built. Where only user-level configuration is left,
   the hook does nothing without the launch's environment (the reporter exits
   when `SPRINTENGINE_AGENT_ID` is unset), and the entry is taken back out when
   the app quits.

## Per CLI

| CLI                            | Agent-state hook                                                  | MCP gateway and synced servers                                            | Skill a prompt invokes                           |
| ------------------------------ | ----------------------------------------------------------------- | ------------------------------------------------------------------------- | ------------------------------------------------ |
| Claude Code, Z.AI, Kimi Claude | `--plugin-dir` (the app's plugin)                                 | gateway in the plugin's `.mcp.json`; synced servers `--mcp-config <file>` | `--plugin-dir` one-skill plugin                  |
| Codex                          | `-c hooks.<Event>=[…]`                                            | `-c mcp_servers.<id>={…}`                                                 | copied into `~/.codex/skills` while the app runs |
| OpenCode                       | `OPENCODE_CONFIG_CONTENT` `plugin` (a `file://` URL)              | `OPENCODE_CONFIG_CONTENT` `mcp`                                           | `OPENCODE_CONFIG_CONTENT` `skills.paths`         |
| Cursor                         | `~/.cursor/hooks.json`, while the app runs                        | one more `--plugin-dir` (its `.mcp.json`)                                 | the same `--plugin-dir`                          |
| Grok                           | `~/.grok/hooks/sprintengine-agent-state.json`, while the app runs | `~/.grok/config.toml` marked block; the gateway leaves at quit            | copied into `~/.grok/skills` while the app runs  |
| Kimi Code                      | `~/.kimi-code/config.toml`, while the app runs                    | —                                                                         | —                                                |

Each manifest says which per-launch channels its CLI takes
(`launchIntegration` in `resources/plugins/<cli>/plugin.json`, with what was
measured against which version), and `src/main/integrations/launch-integration.ts`
builds them for one launch. A user-level registration is declared with
`scope: "user"` on the manifest's `agentStateSpec`.

### Claude Code and the CLIs on its binary

The app materialises its own plugin once per build under the profile's
userData directory (`src/main/agent-integration-home.ts`) and passes it at
launch:

- `--plugin-dir <userData>/agent-integration/<version>/sprintengine-studio`
  carries the agent-state hook (`hooks/hooks.json` and the reporter beside it),
  the MCP gateway (`.mcp.json`) and the studio skills the person opted into
  (none by default; `src/shared/studio-area-skills.ts`). A choice changed in
  Settings is applied to this copy in place, not by rebuilding it.
- `--plugin-dir <userData>/agent-integration/<version>/launch-skills/<id>`,
  **only on the launch whose prompt invokes that skill**: `backlog`, for a
  Backlog handoff (Hand to agent, `backlog.work`). A skill a capability module
  registers is written as a one-skill plugin of its own on demand, under
  `<userData>/agent-integration/launch/`, and passed the same way.
- `--mcp-config <userData>/agent-integration/launch/claude-mcp-<hash>.json`
  carries the servers the person synced for this CLI. Measured against Claude
  Code 2.1.296 on 2026-10-16: such a server starts with no approval prompt,
  merges with the project's and the person's own, and wins over a same-named
  one. The file is owner-only, because a server's environment can hold a
  secret.
- `--settings '<json>'` carries the status line, which no plugin can declare,
  and the knowledge-activity hook when the workspace opted into it. A second
  `--settings` replaces the first outright (measured on the same version), so
  both ride one document; its hooks fire beside the project's and every
  plugin's.

A plugin skill is invoked by its bare name (`/backlog`) whenever no other command
claims that name, and always as `/sprintengine-backlog:backlog`, so the invocations
the app already prefills keep resolving. A person's own `.claude/skills/backlog`
takes the bare name ahead of the plugin's, which is the precedence they would
expect.

One predicate decides whether a launch carries the plugin:
`launchCarriesAppPlugins(cli, host)` in `src/main/app-services.ts`. On this
machine it is true when the copy has been materialised and the CLI's manifest
declares `launchPlugins`; native Windows included, where the copy's hooks and
status line run through the Studio launcher rather than `node`, as every hook
the workspace install wrote there did. (Windows was held back when the flag
arrived because the copy then shared substituted paths with WSL launches; a WSL
launch has had its own copy since.) On a WSL machine it is true when the CLI
declares `launchPlugins` and that distribution's helper has written its own
copy, with Linux paths substituted into it (`src/main/hosts/wsl-plugin-copy.ts`).
The launch flag, the agent-state installer and the MCP sync all ask this one
question, so none of them can write a workspace copy of something the launch is
also carrying, or skip one it is not. A build whose copy failed still installs
into the workspace, which keeps agent state working.

### Codex

Measured against codex-cli 0.161.0 on 2026-10-16. The gateway and the synced
servers go as `-c mcp_servers.<id>={…}` inline tables: `codex mcp list` shows
them with their environment, and `required` is honoured. The gateway names the
agent's ids and its launch token in `env_vars`, because Codex hands a server
only the variables it names. The hook goes as one `-c hooks.<Event>=[…]` per
registered event. Codex reviews such session-flag hooks like any hook that is
not admin-managed: the TUI asks once (`Hooks need review`) and records the
trust in `~/.codex/config.toml`, keyed to the command, so later launches with
the same command run them unasked — the same review the repository
registration this replaces needed, which on top loaded only in a trusted
project. `--dangerously-bypass-hook-trust` would skip that review for every
hook in the session, so it is not passed. `CODEX_HOME` would isolate
everything but relocates the whole profile, credentials included, so it is not
a route.

Codex has no launch-time skill folder (no flag, no `-c` key adds one), so the
skill a prompt invokes is copied into `~/.codex/skills/<id>` with the managed
manifest, listed in the ledger, and taken back out at quit unless someone
changed it. A skill of that name the person keeps there is theirs, and is what
the launch runs.

### OpenCode

Measured against opencode 1.18.32 on 2026-10-16. One `OPENCODE_CONFIG_CONTENT`
document, merged with the host context's `instructions` and with any the
person exported themselves (`mergeProviderLaunchEnv`, one level deep): a
`plugin` entry naming the agent-state plugin by `file://` URL loads beside the
person's own with nothing installed next to it; `mcp` merges field by field
with the project's and the person's tables and wins on the same id;
`skills.paths` adds the skill's own folder. `OPENCODE_CONFIG_DIR` also works
but runs a package install into the folder on every first use, so it is not
used.

### Cursor

Measured against cursor-agent 2026.10.14 on 2026-10-16. The gateway, the synced
servers and a launch skill ride one more `--plugin-dir`, beside the
host-context plugin: a plugin's `.mcp.json` server starts with no
server-approval dialog (a project `.cursor/mcp.json` one stops the start at
one), and its `skills/<id>/SKILL.md` loads. The plugin folder is always named
`sprintengine-studio`, because Cursor names a plugin's servers after it.

The hook is not in the plugin: a plugin's `stop` and `beforeSubmitPrompt` hooks
fire only when the person's or the project's own hooks file names the same
event, and `stop` is what ends a turn. So it is merged into the user-level
`~/.cursor/hooks.json` (whose `stop` and `beforeSubmitPrompt` fire in the
interactive CLI, measured the same day), written at the first Cursor launch
and taken back out when the app quits. In `-p` mode Cursor fires neither event
from any source. The Cursor editor reads the same user-level file, so its
agent runs the reporter too while the app is open, which exits at once without
the launch's environment.

### Grok

The Grok TUI takes no MCP flag, plugin directory or config overlay at launch
(grok 1.0.41: `--plugin-dir` is on `grok agent` only, `GROK_CONFIG` carries no
`mcp_servers`, `GROK_HOME` moves the whole home and its sign-in). So:

- the hook is the owned file `~/.grok/hooks/sprintengine-agent-state.json`
  (grok lists user hooks as always trusted);
- the gateway and the synced servers are the marked block in
  `~/.grok/config.toml`, which takes the same `[mcp_servers.<id>]` tables Codex
  does (an unknown key is dropped with a log warning; only a TOML syntax error
  drops the file); the gateway leaves at quit;
- the skill a prompt invokes is copied into `~/.grok/skills/<id>` as for Codex.

A `grok` started from a plain terminal while the app runs sees the gateway and
the hook; the hook reports nothing without the launch's environment.

### Kimi Code

Its only registration is user-scoped (`~/.kimi-code/config.toml`): written when
a Kimi Code session is launched and taken back out when the app quits.

## What outlives the app

Everything still written into a CLI's user configuration can outlive the app:
it is uninstalled, it moves, or it is killed before its quit runs. So none of
it names the app directly.

- **The launcher.** Every hook command and every MCP gateway entry runs
  `~/.sprintengine/bin/studio-run` (a POSIX `sh` script, run as `/bin/sh
<path> <target> …`) or, on Windows, `studio-run.cmd` beside it — inside a
  WSL distribution, the same script under that distribution's home. The app
  rewrites a small pointer file beside it (`current`: the Node to run, and the
  directory holding `hooks/` and `automation/`) on every start, and a WSL
  distribution's whenever its helper is prepared. When the app is gone the
  launcher does the harmless thing: a hook drains its input and exits 0, and
  the MCP target answers `initialize` with a server that has no tools, which
  Claude Code and OpenCode report as connected rather than failed
  (`src/main/integrations/launcher.ts`).
- **The ledger.** Every file, entry and piece of machine state the app writes
  outside userData — hook blocks, gateway entries, settings keys, plugin and
  skill copies, git excludes, worktree locks, tailnet shares, the protocol
  registration, the launcher — is recorded in `integration-ledger.json` in
  userData as it is written, with how our part is recognised
  (`src/main/integrations/ledger.ts`). A WSL distribution's entries are
  mirrored into its own `~/.sprintengine/integration-ledger.json`. Every quit
  takes out what a launch writes again when it next needs it
  (`SESSION_INTEGRATION_KINDS`).
- **The launch files** (`<userData>/agent-integration/launch/`: the
  `--mcp-config` documents, Cursor's launch plugin, OpenCode's agent-state
  plugin) are content-addressed, so a resumed session finds what it was
  launched with, and emptied at the next start.
- **Connector worktrees' excludes** go into that worktree's own
  `config.worktree` (`core.excludesFile`, with `extensions.worktreeConfig` on),
  never the repository's shared `info/exclude`, which hid a real `.mcp.json` in
  the main checkout (`src/main/integrations/worktree-exclude.ts`).

## Taking out what earlier builds wrote

Every start, before the first launch (which waits for it, for a bounded few
seconds), takes out what earlier builds wrote into repositories for what a
launch now carries itself (`cleanRepositoriesAtBoot` in
`src/main/integrations/integration-boot.ts`): the ledger's entries, and once
per clean-up version a fresh scan of the known checkouts and their worktrees
for what the ledger never saw (`integration-scan.ts`). Only what the removal can
prove is the app's goes — the marked TOML blocks, hook entries of the shape the
app writes or carrying its tag, the gateway entry that runs the app's bridge,
plugin and skill copies carrying its provenance marker — and nothing the
repository has committed. A file the removal leaves empty is deleted when the
app created it, or when the scan found it in a repository and git does not
track it. A workspace's knowledge-activity opt-in is moved into the project's
store first, so the choice survives. The pass is skipped while another Studio
runs, since its sessions may still read those files.

A launch also tidies the workspace it starts in, which reaches worktrees and
folders that are not workspaces: the Claude-family gateway and its approval in
`.mcp.json` / `.claude/settings.local.json`, Codex's managed blocks in
`.codex/config.toml`, the gateway in `opencode.json` and `.cursor/mcp.json`,
and the agent-state registration of the CLI being launched.

## Inventory

Every path the main process writes for agent integration, and where it is now.

| Was                                                                                                                                                       | Read by                               | Now                                                                                                                                                                                                                                  |
| --------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `.claude/settings.local.json` → agent-state hooks, status line, `extraKnownMarketplaces`, `enabledPlugins`                                                | Claude family                         | `--plugin-dir` and `--settings`, every platform. Written only when this build's plugin copy failed.                                                                                                                                  |
| `.claude/settings.local.json` → knowledge-activity hook; `.sprintengine/hooks/knowledge-activity.mjs`, `installed.json`; `.sprintengine/knowledge-trace/` | Claude family                         | `--settings`; the opt-in and the trace in the project's store (`~/.sprintengine/workspaces/<project>/`), the trace moved there with the rest of `.sprintengine/`. A workspace on a WSL machine keeps the in-repository registration. |
| `.sprintengine/studio-plugin/`, `.sprintengine/hooks/agent-state.mjs`, `status-line.mjs`                                                                  | Claude family, every command-hook CLI | Not written (the launcher runs the shipped reporter); the plugin copy only when this build's failed.                                                                                                                                 |
| `.mcp.json` → gateway; `enabledMcpjsonServers`                                                                                                            | Claude family, Grok                   | The Claude plugin's `.mcp.json`; Grok's `~/.grok/config.toml`.                                                                                                                                                                       |
| `.mcp.json` → the person's synced servers                                                                                                                 | Claude family                         | `--mcp-config <file>`.                                                                                                                                                                                                               |
| `.codex/config.toml` → MCP block, hooks block                                                                                                             | Codex                                 | `-c` overrides.                                                                                                                                                                                                                      |
| `.cursor/mcp.json`, `.cursor/hooks.json`                                                                                                                  | Cursor                                | Launch `--plugin-dir`; `~/.cursor/hooks.json`.                                                                                                                                                                                       |
| `opencode.json` → `mcp`; `.opencode/plugin/sprintengine-agent-state.js`                                                                                   | OpenCode                              | `OPENCODE_CONFIG_CONTENT`.                                                                                                                                                                                                           |
| `.grok/hooks/sprintengine-agent-state.json`                                                                                                               | Grok                                  | `~/.grok/hooks/`.                                                                                                                                                                                                                    |
| `.agents/skills/<id>`, `.claude/skills/<id>`, `.codex/skills/<id>`, `.opencode/skills/<id>`, `.grok/skills/<id>` (the skill a prompt invokes)             | each CLI                              | Per the table above; a launch with no route of its own (another machine) still fans it out.                                                                                                                                          |
| `.sprintengine/claude-plugins/<id>` (a catalogue plugin's own files)                                                                                      | the servers it declares               | The project's store. A plugin installed there by an earlier build stays, since the MCP settings name its folder, and is still removed by Remove.                                                                                     |
| `<worktree git dir>/sprintengine-exclude`                                                                                                                 | git                                   | Unchanged: per connector worktree, never the shared `info/exclude`.                                                                                                                                                                  |

The host-context document every launch writes (and the one-session plugin
directory Cursor receives it in) lives under `<userData>/host-context/`, and is
removed when the session ends.

### Not agent integration

The app's own features keep their state out of the checkout: the backlog's
config and link cache, browser captures and recordings, conversation records
and module storage live in the project's store in the person's home,
`~/.sprintengine/workspaces/<project>/` (`src/main/workspace-store.ts`), and
an older build's `.sprintengine/` is moved there once
(`src/main/workspace-store-migration.ts`). None of it is read by an agent
CLI's configuration loader, so none of it carries the app's behaviour into a
plain-terminal session.

Writes a person asks for explicitly — installing a skill or plugin from the
catalogue, attaching a skill to an agent, attaching a design system, syncing
skills — land where the person asked. They are left alone here: they are a
choice, not pollution.

## Remaining

- **WSL launches** keep the workspace writers for every CLI but the Claude
  family: the per-launch channels above name files on this machine, and a
  Linux CLI would need them written inside the distribution by its helper, as
  the Claude plugin copy already is. The knowledge-activity hook of a
  workspace inside a distribution stays in its settings for the same reason.
- **Connector launches** keep writing their worktree's MCP config: the
  connector-only server set is the isolation they promise, and the worktree's
  own exclude keeps it out of git.
- **Studio area skills for the other CLIs.** A skill the person opted into
  (none by default) is still copied into `.agents/skills`, `.codex/skills`,
  `.opencode/skills` and `.grok/skills` when a workspace is opened. OpenCode's
  `skills.paths`, Cursor's launch plugin and the user-level copies above could
  carry them instead.
- **Servers an earlier sync wrote into `.mcp.json` and `opencode.json`.** They
  carry no marker of the app's, so they cannot be told apart from the person's
  own and stay; the launch's own copy of the same server wins.
- **Copies an earlier build left in `.claude/skills`.** A bundled skill copied
  there by an earlier launch carries the same managed manifest as one copied
  when a person imports an existing agent configuration, so the two cannot be
  told apart and neither is deleted. Deleting the directory by hand is safe.
- **Chat mode.** The conversation runtime attaches a chat's skills through the
  workspace skill installer (`conversation-skills.ts`).
- **Gemini.** No manifest ships under `resources/plugins`, so the app writes
  nothing for it.
