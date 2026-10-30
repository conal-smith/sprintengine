# module/manifest.json and plugin.json

Two manifests, two jobs:

- **`module/manifest.json`** is the module. Studio reads it from
  `~/.sprintengine/modules/<id>/manifest.json` to decide whether to load the
  code beside it. Validated by `validateThirdPartyModuleManifest` (the SDK
  export the app itself calls).
- **`plugin.json`**, at the repository root, is the bundle an install reads
  (from GitHub or the marketplace). It points at `module/` as its `module`
  component. Validated by `validateMarketplacePluginAuthoringManifest`.

`node scripts/validate.mjs` runs both validators and checks them against each
other.

## module/manifest.json

```json
{
  "id": "my-extension",
  "displayName": "My Extension",
  "version": 1,
  "publisher": "Your name",
  "summary": "One sentence the install prompt shows.",
  "defaultEnabled": false,
  "source": "third-party",
  "engines": { "hostApi": 1 },
  "permissions": ["storage"],
  "dependsOn": ["agent-runtime"],
  "entry": { "renderer": "dist/renderer.mjs", "main": "dist/main.cjs" }
}
```

- `id` prefixes IPC channels and command ids; name MCP tools in a family of
  your own that is not a core one (the `api-main` topic).
- `version` is an integer. Bump it on every release.
- `files` is written for you by `npm run build` (only when the files changed),
  `dev:install` and `sprintengine-module sign`. Never edit it by hand.
- `plugin.json` must carry the same `id`, `version` and `permissions`.


| Field | Required | Notes |
| --- | --- | --- |
| `id` | yes | `^[a-z0-9][a-z0-9-]{0,62}$`, equal to the install folder name, not in `BUNDLED_MODULE_IDS`. Never change it after release: trust, storage and settings are keyed by it. |
| `displayName` | yes | What people see. |
| `version` | yes | Positive integer. Bump for every release. |
| `publisher` | no | Your name or organisation. For a marketplace listing it must equal the registry entry's `publisher.name`. |
| `summary` | no | One sentence; the install prompt and cards show it. |
| `category` | no | e.g. `dev-tools`, `vcs`, `orchestration`, `insight`, `connectivity`. |
| `defaultEnabled` | yes | Keep `false`: a new module starts off until the person turns it on. |
| `source` | yes | `"third-party"`. The validator forces it anyway. |
| `engines` | yes | `{ "hostApi": 1 }` — the SDK's `HOST_API_VERSION`. Missing, non-integer, newer than Studio, or older than it still loads: the module is refused with a message saying which. |
| `permissions` | no | See the `permissions` topic. |
| `dependsOn` | no | Module ids that must load (and be enabled) first: `agent-runtime`, `scheduled-agents`. |
| `conflictsWith` | no | Module ids that must not be enabled alongside. |
| `entry` | no | `{ "renderer": "dist/renderer.mjs", "main": "dist/main.cjs" }`, relative to `module/`. `entry.preload` is reserved and never loaded. |
| `files` | written for you | `{ "<relative path>": "<sha256 hex>" }` for every file in `module/` except `manifest.json`. Studio holds the installed folder to exactly these files and bytes, at discovery and again before it loads `entry.main`; a changed, missing or extra file reads as tampered. `npm run dev:install` and `sprintengine-module sign` write it. |
| `signature` | written for you | `{ algorithm: "ed25519", publicKey, signature }` over the validated manifest (including `files`), written by `sprintengine-module sign`. |

`core` is stripped; unknown keys are dropped when the manifest is normalized,
so a field the validator does not know is a field Studio never sees.

## plugin.json

```json
{
  "id": "my-extension",
  "displayName": "My Extension",
  "version": 1,
  "publisher": "Your name",
  "summary": "One sentence.",
  "defaultEnabled": false,
  "source": "third-party",
  "permissions": ["storage"],
  "components": { "module": { "path": "module" } }
}
```

- `id`, `version` and `permissions` must match the module manifest.
- `components.module.path` is the folder holding `manifest.json`: `module`.
  The other component kinds are `mcp` and `skills`; an extension that is
  only a module needs just this one.
- `sprintengine-module plugin sign . --key <key>` adds a `files` list (path
  and sha256) to each component and signs the bundle. Run it AFTER signing the
  module, because the module's manifest is one of the files it digests.
- A registry entry's `provides` must list the component kinds in canonical
  order (`mcp`, `skills`, `module`); `plugin sign` prints it.

## Versions and compatibility

`engines.hostApi` says which contract you built against; `host.supports()`
says what this particular Studio provides right now. Declare the version your
SDK exports, and feature-detect anything newer:

```ts
if (host.supports('github')) registerGitHubFeatures(host)
```
