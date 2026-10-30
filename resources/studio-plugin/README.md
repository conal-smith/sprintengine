# The SprintEngine Studio marketplace

This directory is a Claude-format **marketplace**, and it carries only what
SprintEngine Studio itself authors: the plugin the app installs into every
workspace it opens. The studio does not author
or bundle skills or MCP servers for somebody else's tool — it points people at
the external sources that do, which are GitHub repositories in this same
Claude marketplace format.

```
resources/studio-plugin/
  .claude-plugin/marketplace.json     the marketplace manifest
  sprintengine-studio/
    .claude-plugin/plugin.json        name, description, version
    .mcp.json                         the stdio bridge to the running app
    hooks/hooks.json                  the agent-state reporter
    skills/studio-*/SKILL.md          one skill per area
    skills/studio-design-system/
      scripts/render-swap-report.mjs  the before/after page renderer
```

`sprintengine-studio` is the built-in: its bridge and agent-state hook are
installed into every workspace the app opens, because they are how an agent
reaches the running app at all. Its area skills are **not** (owner ruling
2026-09-28): each is opt-in, machine-wide, offered by its own surface the first
time it is opened and switched in Settings › Agents › Studio skills — see
[The skills](#the-skills).

This marketplace used to list a second plugin, `studio-skills`: nine general
workflow skills (debug, backlog, frontend-design, prototype, handoff and the
rest), which the launch then handed to every Claude session whole. It was
removed on 2026-09-28 — an agent follows a skill it can see, and those were
instructions nobody had asked for. The one a prompt the app composes still
invokes, `backlog` (the Backlog handoff), lives in `resources/builtin-skills`,
outside this marketplace, and reaches only the launch that invokes it
(`src/main/builtin-skills.ts`). The other eight no longer ship — `debug` went
with Debug Mode, which agents do for themselves — and copies an earlier build
wrote are taken out of each workspace.

Anything published to `sprintengine/studio-releases` and installed from the
catalogue lives in that repository, not here. This directory carries only what
the app itself authors.

Installer: `src/main/skills/studio-plugin.ts` (what it writes) and
`src/main/studio-plugin-service.ts` (when).

## What is here is a template

Three things in this tree cannot be known until the app is running on a
particular machine: the binary that will run the bridge, the absolute path of
that bridge inside this app bundle, and the live agent-state socket. They appear
here as tokens — `__SPRINTENGINE_NODE__`, `__SPRINTENGINE_BRIDGE__`,
`__SPRINTENGINE_USER_DATA_DIR__`, `__SPRINTENGINE_AGENT_STATE_REPORTER__`,
`__SPRINTENGINE_AGENT_STATE_SOCKET__` — and install materialises the whole
marketplace into `<workspace>/.sprintengine/studio-plugin` with each one replaced.
A test walks every materialised file and fails if a token survives.

The JSON files here explain themselves under a `$comment` key, and that key
stops at the template. Install strips every `$comment`, at any depth, from each
JSON file it copies: Claude Code validates a plugin's `hooks/hooks.json` and
prints `unknown key "$comment" ignored` at the end of every session that loads
one, and under `mcpServers` the key would read as a server's name. A test walks
the materialised copy and fails if one survives.

## Where the bridge comes from

The item offered two ways to give the plugin its MCP server: **ship the bridge
inside the plugin**, or **rewrite the command at install** to the app's bundled
`resources/automation/mcp-stdio-bridge.mjs`, the way the agent-state hook
installer already rewrites its own absolute script path.

**We rewrite at install.** Three reasons:

1. **The bridge must belong to the running build.** It speaks that build's
   discovery file (`sprintengine-studio-mcp-info.json`), its connect frame, and
   its tailnet protocol constants, which the file itself says are kept in step
   with `src/main/automation/tailnet/tailnet-gateway-server.ts`. A copy inside
   the plugin would be a second 725-line file to keep in step with the first,
   and the failure mode of letting them drift is an agent that cannot reach the
   app at all.
2. **One resolver already exists.** `resolveStudioMcpBridgeScriptPath` in
   `src/main/app-services.ts` resolves the packaged and the development layout,
   and `syncStudioMcpConfig` already writes exactly this command
   into every CLI's own config. The plugin's `.mcp.json` now names the same
   path from the same resolver, so the two cannot disagree.
3. **`${CLAUDE_PLUGIN_ROOT}` cannot reach it.** That variable expands to the
   plugin's own directory, and the bridge is not in it. Shipping the bridge into
   the plugin purely so the variable could be used would be paying reason 1's
   price to avoid a substitution we already perform for the hook.

The same reasoning is why the hook command is rewritten rather than made
plugin-relative: the reporter's `--socket` argument is a per-profile path this
app run owns, and no path variable can stand for it.

## Native Claude Code enablement is wired, and off

Install writes both keys Claude Code documents for team-shared plugins:
`enabledPlugins` into `.claude/settings.json` (a project normally commits it,
and it names a plugin rather than a path, so it means the same thing on every
machine) and `extraKnownMarketplaces` into `.claude/settings.local.json` (which
is gitignored, because a directory marketplace's source is this machine's
absolute path).

Those two keys are **not enough on their own**. Measured against Claude Code
2.1.261 on 2026-09-06:

| `known_marketplaces.json` | workspace `extraKnownMarketplaces` | workspace `enabledPlugins` | plugin loads |
| --- | --- | --- | --- |
| absent | present (directory source) | present | **no** — no skills, no MCP server, no hooks |
| present | absent | present | **yes** — skills, MCP server and hooks all load |

So native loading needs the marketplace to be in Claude Code's own user-global
`~/.claude/plugins/known_marketplaces.json`, which `claude plugin marketplace
add` writes. This app will not write another product's user-global state behind
a person's back, so native enablement waits for a marketplace Claude Code
fetches for itself — the GitHub marketplace child of this epic.

Until then `STUDIO_PLUGIN_NATIVE_CLAUDE_ENABLEMENT` in
`src/main/skills/studio-plugin.ts` is `false` and the app delivers the same
three things itself: the opted-in skills are copied into every harness's skill directory,
the MCP server is written into each CLI's config by
`syncStudioMcpConfig`, and the hook is merged into
`.claude/settings.local.json` from the command and event set this plugin's own
`hooks/hooks.json` declares.

**When that flag goes true, the by-hand hook merge must stop** — Claude Code
would then register the plugin's hooks itself, and two registrations spawn the
reporter twice for every event. `installStudioPlugin` already skips the merge on
the flag; the flag is the whole change.

## The skills

### Opt-in, not installed by default

An agent building an ordinary UI once picked up `studio-design-system`, because
every area skill was installed into every workspace with the bridge. A skill is
a standing instruction to every agent that can see it, so each is now the
person's choice (`src/shared/studio-area-skills.ts`):

- **Off by default.** A fresh machine installs the bridge and the hook and no
  area skill, in every copy: the workspace copy, the app-owned `--plugin-dir`
  copy, each WSL distribution's copy, and the per-harness skill directories.
  One exception (2026-10-11): `studio-ship` is on until the person switches it
  off in Settings. It steers no ordinary work — it is read only when the person
  says "ship it" — and every chat can watch a pull request
  (`pull_request_watch`), so every chat gets the steps. Switched off, it is
  remembered as an answer and stays off.
- **Offered where it applies.** Backlog, Design, Canvas, scheduled agents and
  the Diff viewer each show one muted line offering their skill until the
  person answers it (Install, or Not now). `studio-workspaces` has no surface of its
  own and is a switch in Settings only. Switching one off in Settings counts as
  an answer, so the surface does not offer it back.
- **Machine-wide.** The choice lives in `<userData>/studio-area-skills.json`
  (`src/main/studio-area-skill-store.ts`) and applies to every workspace, now
  and later; a change reaches the next agent launched.
- **Taken back out.** A copy of an unchosen skill carrying this plugin's
  provenance marker is removed on the next workspace pass — the migration for
  every workspace an earlier build filled. A copy the repository committed is
  left, as the quit removal leaves it, and so is anything without our marker.
- **At the loading screen.** The workspace pass — this plugin's home under
  userData, then every known workspace — runs while the app's loading plate is
  up ("Preparing your workspaces…"). The reveal waits for it for at most
  `BOOT_WORKSPACE_SYNC_BUDGET_MS` (4 s, `src/main/boot-discovery.ts`); past
  that the app opens and the pass carries on in the background.

One per area: `studio-backlog`, `studio-scheduled-agents`, `studio-canvas`,
`studio-diff-tours`, `studio-workspaces`, `studio-ship` (push, open the pull
request, set it to merge, and have Studio watch it) and `studio-design-system`
— seven. (`studio-review` left
with the Reviews module, which ships it itself. `sprintengine-extension-builder`,
the module SDK's skill that the Extensions home used to offer, left on
2026-10-30: the gateway's `extension.create` and `extension.guide` tools teach
every agent instead, and the workspace pass removes a copy an earlier build
installed.) The last one is the odd shape of
the set: the other four are manuals for a tool surface, and it is the manual for
the *repository's* design system. It sits here rather than with the workflow
skills because it teaches the studio's own kit, spec trio and lint gates by path,
which is knowledge about this product and not a general technique. It ships one
executable of its own, `skills/studio-design-system/scripts/`, which the other
four do not.
Each is written to the Agent Skills specification — `name` equal to its
directory, a `description` under 1024 characters that says **when** to use it, a
body under 500 lines — and `src/main/skills/studio-plugin-skills.test.ts` checks
them against the same frontmatter parser the app's own skill reader uses.

The four tool-surface skills are distilled from the tool descriptions in
`src/main/automation/automation-tools.ts`, `canvas-tools.ts` and the review
gateway tools.
`studio-design-system` is distilled from a different set — `design-system/`'s
own `USAGE.md`, `AGENTS.md` and `foundations/principles.md`, the kit under
`src/renderer/src/components/ui/`, and the lint gates under `scripts/` that
enforce both. The tool descriptions stay authoritative — an agent that arrives
without the plugin still has them — but the skills are the manual: they cost
nothing until invoked and carry the workflow, not just the tool list.

They deliberately do **not** restate tool schemas. `tools/list` is the listing
surface and every parameter description is authoritative; a skill that copied
them would be a second copy to keep in step.

## Why no third-party servers live here

This tree used to carry `brave-search/`, `kubernetes/` and `snyk/` — each an
outside MCP server packaged as a plugin with a hand-written `use-*` skill
teaching it — alongside `use-codex` and `use-railway` under the since-retired
`studio-skills/`. They are gone (2026-09-08). The studio ships its own plugin; a manual for somebody else's tool belongs with that tool's publisher,
where it is maintained against the product rather than drifting here. People
reach those through external marketplaces: any GitHub repository in this
Claude marketplace format can be added as a source, and Anthropic's own
`claude-plugins-official` already carries most of what used to be listed here
(Railway included, via `railwayapp/railway-skills`).

What remains true of anything this directory does publish: a `.mcp.json` names
env VARIABLES and never values, because this tree is published to a public
repository.
