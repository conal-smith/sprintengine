# Model discovery from the installed CLIs

Implementation plan, 2026-09-22. Status: in progress on branch
`model-discovery`.

## Decision

The models a picker offers come from the agent CLIs installed on this machine,
asked through each CLI's own login. The hosted model list in the public
releases repository is retired: the app stops fetching it, stops bundling a
seed of it, and stops checking the seed against the manifests.

Why the CLI and not a remote list or a vendor API:

- The CLI is the only authority on what its own `--model` flag accepts. A
  vendor's model API knows `claude-opus-5-5` but not `opus[1m]`, and knows no
  Codex slug at all. A third-party aggregator spells ids its own way.
- It answers through the person's subscription login. No API key is asked for,
  stored or sent.
- It tracks the version actually installed, so a machine on an old CLI is not
  offered a model that binary rejects.
- Nobody edits a file when a model ships. Two launches on one day needed four
  manual edits across two repositories under the old arrangement.

What each CLI offers, verified on 2026-09-22:

| CLI | Probe | Answer |
|---|---|---|
| Claude Code (and the Z.AI and Kimi providers on the same binary) | Claude Agent SDK `query().supportedModels()` with a streaming input that never yields, so no user turn is sent; ~1 s | `value` (the flag value), `resolvedModel`, `displayName`, `description`, `supportedEffortLevels`, `supportsFastMode` |
| Codex | `codex debug models` | JSON: `slug`, `display_name`, `description`, `default_reasoning_level`, `supported_reasoning_levels[].effort`, `visibility` (`list` or `hide`), `priority` |
| Cursor | `cursor-agent --list-models` | Lines `id - label` under an "Available models" heading |
| Grok | `grok models` | Lines `* id (default)` and `- id`; works signed out |
| OpenCode | `opencode models` | Lines of `provider/model`; slow, may exceed the probe timeout |
| Kimi Code, Gemini | none known | manifest seed only |

## Rules

1. **The CLI's list is the list.** When a probe for a CLI has succeeded, the
   picker shows exactly the rows the CLI reported, in the CLI's order, plus the
   person's own custom ids. A model the CLI stops listing disappears on the next
   refresh. The bundled manifest seed is shown only while no probe has ever
   succeeded for that CLI (fresh install, CLI not installed, probe failing).
   Owner ruling 2026-09-22; this replaces the earlier union rule.
2. **Custom models stay.** `cliRuntimes[cli].models` is the person's own list,
   edited in Settings, never touched by a refresh, and shown after the probed
   rows. It is how a model the CLI accepts but does not advertise is offered
   (Claude Code 2.1.280 accepts `claude-opus-5-5` but does not list it).
3. **A failed or skipped probe changes nothing.** The last good catalog stays;
   the Settings line says the probe failed and offers Refresh.
4. **"New" is per machine.** A row carries `firstSeenAt`, the time a probe on
   this machine first listed its id, carried forward across refreshes. The chip
   shows for `NEW_FOR_DAYS` (30) after that. Rows from the first-ever probe for
   a CLI carry no `firstSeenAt`, so a fresh install does not light up every
   model. The Design door keeps the same constant.
5. **Hidden rows are hidden.** Codex `visibility: "hide"` rows are not shown.
6. **A persisted choice survives.** A model the person already picked keeps
   launching even when the CLI no longer lists it; the never-remove rule in
   settings is unchanged.
7. **Probes run** after boot CLI detection, when a CLI's detected version
   differs from the version that produced its catalog, after an install or
   update through the app, and on Refresh or Re-check in Settings. Otherwise a
   catalog is fresh for an hour, and a window coming back to the front asks
   again: what a CLI lists can move with the account it is signed in to, with
   no new version to notice. Probes run concurrently with a 20 s timeout each, through
   the same posix / Windows / WSL spawn plumbing CLI detection uses.
8. **Probes are declared in main-process code** keyed by plugin id, not in the
   plugin manifests. Adding a manifest field means an SDK change and a drift
   guard update; that is a follow-up once the shape has settled.

## Work packages

- **A. Discovery service (main, preload, renderer boot).** `src/main/model-discovery/`:
  probe registry, the Codex JSON parser, the line parsers for Cursor, Grok and
  OpenCode, the Agent SDK probe, freshness and version gating, a main-side cache
  under userData so the renderer's persisted copy and the gating agree. IPC
  `cli-models:discover` and push `cli-models:changed` per
  `src/shared/ipc/cli-model-discovery.ts`. Preload api. A renderer boot module
  that loads the persisted catalogs into the discovery request and applies the
  answer through `setCliModelCatalog`. Normalizer accepts `firstSeenAt`.
- **B. Retire the hosted model list and apply the rules.** Remove the model
  feed client, service, IPC, preload api, slice, seed, scripts, package entries
  and env override, keeping the card and sources feeds. Rewrite the merge in
  `cliRuntimeOptions.ts` to rules 1, 2, 4 and 5. Replace the Settings
  GitHub line with a discovery line. Adapt the "new models" notice to probe
  additions. Move `NEW_FOR_DAYS` to a shared constant. Update docs.
- **C. Integration and review.** Wire the boot module where the hosted boot
  was, run the gates, and review the combined change.

## Retirement of the public list

`model-feed.json` in the releases repository stays where it is, frozen, so
builds that still fetch it keep their last good copy. Its README says it is no
longer maintained. The website that renders it is out of scope here and needs
its own decision.
