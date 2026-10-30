# Drop-in extensions: modules and conversation providers

SprintEngine Studio picks up two kinds of extension from per-user folders,
discovered on launch. Both folders are created (and seeded with a README) the
first time the app runs — including on a packaged install — so there is always
a discoverable place to drop things.

| Kind | Folder | Manifest | Surfaced in |
| --- | --- | --- | --- |
| **Capability module** | `~/.sprintengine/modules/<id>/` | `manifest.json` | Settings → Modules, the Extensions door |
| **Conversation provider** | `~/.sprintengine/plugins/<id>/` | `plugin.json` with `"kind": "provider"` | Settings → Providers |

In both cases the folder name must equal the manifest `id`. Agent CLIs are not
drop-in: they ship with the app, and nothing a user installs adds or replaces
one. A provider in the plugins folder that reuses any built-in id is refused
with the reason, and the built-in one stays.

The module root can be relocated with the `SPRINTENGINE_USER_MODULE_ROOT`
environment variable (the dev harness and a template's `dev:install` honour
it); providers always resolve under `~/.sprintengine/plugins`.

## Capability modules

A capability module extends the app itself — main-process services and IPC,
renderer panels, workspace types, commands, Backlog and Files actions,
settings sections, sidebar doors, top-bar controls, modal surfaces, MCP tools
agents can call, chats of its own with the app's agents, Backlog reads and
writes through the app's Backlog service, and read-only views of the person's
own activity (token usage, their chats) — through the `MainHost` /
`RendererHost` contracts. Modules are trust-gated: only modules
the user has trusted execute code.

- Author against [`@sprintengine/module-sdk`](../../packages/module-sdk/README.md).
  The fastest start is a template:
  `npx -p @sprintengine/module-sdk sprintengine-module init my-extension --template panel`,
  or **Build your own extension** (the Extensions door, or the palette), which
  opens New chat in extension mode: name the extension, pick the project it goes
  in, describe it, and the project is scaffolded in `<project>/<name>` with a
  chat on it. Any agent Studio serves can do the same itself: `extension.create`
  makes the project, and `extension.guide` is the manual it builds from.
  Templates combine: `init … --with main,mcp,settings,door`, or
  `sprintengine-module add <part>` in an existing project.
- Test without the app. `@sprintengine/module-sdk/testing` has fake main and
  renderer hosts that keep this app's rules (the permissions it checks,
  storage's limits, chat ownership, the bridge's `module:bridge`) and a UI kit
  stand-in that renders in Node; a scaffolded project runs its TypeScript
  tests and a smoke test that renders every registered surface on
  `npm run check`. See the SDK README's "Testing".
- Declare the host API the module was built for: `"engines": { "hostApi": 1 }`.
  A module without it, or built for a host API this app does not load, is
  refused with a message saying which side to update — never shown as merely
  "not trusted".
- Validate, sign, and pack with the bundled `sprintengine-module` CLI. `sign`
  records the sha256 of every file the module ships in the manifest's `files`
  field, so the signature covers the code, not only the manifest.
- **`files` is required.** A module whose manifest lists no `files` does not
  load, signed or not. A template's `npm run build` (when the files changed)
  and `npm run dev:install` write it for an unsigned local build (and sign
  when your key is at
  `~/.sprintengine/keys/<id>.key`) before copying `module/` here.
- Install the packed folder by dropping it into `~/.sprintengine/modules/<id>/`,
  or from **Settings → Modules → "Install a module from a folder"**, then grant
  trust. A folder with a symbolic link, `node_modules`, `.git` or key files in it
  is refused; `pack` leaves those out.
- Trust covers the files as well as the manifest. A publisher key vouches for a
  module only when its signed `files` match the folder exactly — a signed
  manifest without them is not trusted by key — and a grant you give binds to
  the manifest's fingerprint, which covers its `files`. A changed, missing or
  extra file is refused as tampered, when the app lists modules and again
  immediately before it runs `entry.main`.
- Permissions are install-time disclosure — see [permissions.md](./permissions.md).
- **What a person sees of a module.** A door (`registerGlobalSurface` with a
  `label` and `Icon`) is a row in the Extensions drawer; the module's
  `registerDoorBadge({ rowId: <surface id> })` count and its unread bell rows
  are worn on that row and summed on the app rail's Extensions square, and a
  `registerSidebarNavEntry` under the same id draws the row in the module's
  own component. `MainHost.notify` is a row in the bell of every window, under
  the module's display name, whose `target` opens the module's own door; a
  window that opens later files the rows it missed. `RendererHost.toast` is a
  transient report in the window's toast region. Notifications reach the
  windows through the same client bus as module events, so they work
  unchanged when the server runs in a process of its own.
- **`entry.main` may run without Electron.** When Studio runs its server in a
  process of its own, a module's main half runs there: a Node process with no
  Electron APIs, where `host.supports('electron-main')` is false. A module
  that cannot live without them declares
  `"requires": { "hostCapabilities": ["electron-main"] }` and loads only where
  that is true; elsewhere it loads manifest-only and Settings says
  "skipped: needs electron-main". A main half that requires `electron` without
  declaring it is refused at the require, with the same words.

### Installing from GitHub

A module published in a GitHub repository installs from its URL: the
Extensions door's **Install extension from GitHub…**, or **Add from GitHub** in
Settings → Modules. The repository must carry:

```
plugin.json            at the root; components.module.path = "module"
module/manifest.json   with "engines", "files" (and "signature" if signed)
module/dist/…          the built bundles, committed
```

Studio resolves the default branch to a commit, reads `plugin.json` at the
repository root at that commit, and shows the name, publisher, permissions and
whether the module is signed before anything installs. Only `module/` is
installed. A signed module installs through the normal trust prompt. An
**unsigned** module is allowed, with a warning that nobody vouches for its code
and an explicit "I trust this code" choice the install cannot proceed without;
its `files` are still required, since they are what the installed folder is
held to. An invalid signature is refused. An update resolves the commit again
and asks again when the permissions, the disclosed MCP servers or the signing
change. A repository with a `.claude-plugin/` folder is an agent skill source,
not a Studio extension: add it from the Skills path.

### Creating a workspace from a module

A module's `entry.main` can create workspaces programmatically through the
always-on core, the same flow the UI uses:

```ts
import { WorkspaceServiceToken } from '@sprintengine/module-sdk'

const workspaces = host.requireService(WorkspaceServiceToken)
const result = await workspaces.create({ name: 'Scratch', folderPath: '/abs/path' })
// { ok: true, workspaceId } | { ok: false, code, message }
```

The promise resolves only after the workspace is confirmed on the
workspace-sync bus, so a returned id is always a real workspace.

### Developing a first-party module locally

A handful of module ids are **reserved** (`BUNDLED_MODULE_IDS`): the app
installs one only when its `manifest.json` is signed by a key whose
fingerprint is listed in `resources/marketplace/trusted-publishers.json`. That
is what stops anyone shadowing a first-party module — and it also means a
contributor building the app from source cannot install their own build of
one, because they do not hold the release signing key.

`resources/marketplace/trusted-publishers.dev.json` is the way through. It has
the same shape as `trusted-publishers.json`, it is gitignored, and its
fingerprints are unioned into the trusted set **only when the app is not
packaged** (`src/main/marketplace/trusted-publishers.ts`). A packaged build
never reads it, and neither does the registry verifier
(`npm run verify:marketplace-registry` opens `trusted-publishers.json` by name),
so a dev key can never become a signing authority for anybody else.

```bash
# once
sprintengine-module keygen --out ~/.config/sprintengine/keys/my-dev.key
# prints: Public key fingerprint: <fingerprint>

cat > resources/marketplace/trusted-publishers.dev.json <<'JSON'
{
  "schemaVersion": 1,
  "publishers": [
    {
      "name": "SprintEngine Labs",
      "verified": true,
      "publicKey": "<the public key the keygen printed>",
      "fingerprint": "<fingerprint>",
      "scope": "Local development only; never committed."
    }
  ]
}
JSON
```

The `name` must equal the `publisher.name` on the registry entry you are
standing in for. Then build the module, sign the inner module manifest
(`sprintengine-module sign`, which records its file digests) and then the
bundle `plugin.json` (`sprintengine-module plugin sign`, which digests the
module's signed manifest among its files) with that key, install, and restart
the app. The order matters: signing the module rewrites its manifest, which the
bundle's digests cover.

### Shipping skills with a module

Skills are not a closed set the app compiles in. A module can carry its own
skill directories and register them at startup:

```ts
host.registerSkills([
  {
    id: 'review-guide',
    sourceDir: 'skills/review-guide',      // relative to the module root
    targetPolicy: 'all-native',            // or 'agents'
    description: 'Walk a human reviewer through a code change.',
  },
])
```

`sourceDir` must stay inside the module root (the `module/` folder of a
project: ship the skill as `module/skills/<id>/SKILL.md` and register
`sourceDir: 'skills/<id>'`) — the host resolves it and rejects anything that
escapes. The skill's files are module files: they are in `files`, covered by
the signature, and editing one means rebuilding and re-trusting. An `id` a built-in skill or another module
already owns is a registration error, and unloading the module unregisters its
skills.

From then on the skill is a skill: an agent launched with that skill id gets it
copied into the workspace before it starts, `targetPolicy: 'all-native'` fans
it out into every installed CLI's own skill directory (`.claude/skills`,
`.codex/skills`, …) rather than only `.agents/skills`, and the copy carries the
same managed manifest as the app's own skills, so a hand-edited copy is never
overwritten.

To put one in a workspace ahead of time — a skill an agent will be told to
invoke, or one the user should see listed — call
`host.ensureSkillInstalled(workspaceRoot, skillId)`. It never throws and
answers `{ ok, status, message? }`; `status: 'unknown-skill'` means nothing
answers to that id. `host.getSkillStatus(workspaceRoot, skillId)` asks the same
question without writing anything. `status` is a `ModuleSkillStatus`:
`installed`, `updated`, `missing`, `update-available`, `local`, `modified`,
`delivered-at-launch` (a built-in skill the launch hands its CLI as a plugin,
so nothing is written), `missing-source`, `missing-workspace`, `unknown-skill`
or `install-failed`.

Registering a skill writes nothing to any workspace. An `all-native` skill
reaches a chat when that chat's launch names it, or when
`ensureSkillInstalled` has already put it in the workspace — after which every
new chat there finds it in its CLI's own skill directory, the person's included.

### Publishing a module to the marketplace

Folder install (above) is the developer loop. To let other users discover and
install your module from the Extensions door's **Plugins** view, publish it to
the marketplace registry as a signed plugin bundle:

1. **Sign the module.** `sprintengine-module keygen` once, then build, then
   `sprintengine-module sign <module-dir> --key <key.pem>` and
   `sprintengine-module verify <module-dir>`. `sign` records a digest of every
   file the module ships; sign again after every build. Keep the private key
   out of the module directory and out of version control. The marketplace
   takes signed module bundles only (GitHub installs are where unsigned code
   is allowed, behind a warning).
2. **Wrap it in a plugin bundle.**
   `sprintengine-module plugin scaffold <plugin-id> --component module`, replace
   the `module/` placeholder with your packed module
   (`sprintengine-module pack <module-dir> --out <staging>`), and fill in
   `plugin.json` — id, displayName, summary, category, and the same
   `permissions` your module manifest declares (they are what the install
   trust prompt shows).
3. **Sign and check the bundle.**
   `sprintengine-module plugin sign <plugin-dir> --key <key.pem>` writes
   per-component file digests into `plugin.json` and signs it — component
   bytes can't change afterwards without failing verification. Then
   `sprintengine-module plugin verify <plugin-dir>` runs the exact check the app
   runs at install.
4. **Open a registry PR.** Add `plugins/<plugin-id>/` (your signed bundle), an
   `icons/<plugin-id>.svg`, and a `marketplace.json` entry whose
   `name`/`latest`/`provides`/`signature` match your `plugin.json`
   byte-for-byte, with a `source` URL on an allowlisted HTTPS host
   (`github.com`, `api.github.com`, `raw.githubusercontent.com`, plus anything
   `SPRINTENGINE_MARKETPLACE_EXTRA_HOSTS` adds). Registry CI runs the same
   verifier the app build runs (`verify:marketplace-registry`). The full
   command walkthrough, including the registry-entry shape, lives in
   [`docs/plugin-authors/README.md`](../plugin-authors/README.md). Registry
   entries reach the app through the published catalogue snapshot — the app's
   bundled index is generated from it, so listing follows the next snapshot
   release rather than the PR merge alone.

What users then see: your module in the Extensions door's **Plugins** view,
carrying a `Module` component chip inside its source and category group (card
copy comes from your module's `displayName` + `summary` — say what it adds:
workspace type, panels, commands), a trust prompt listing the REAL
permissions from your verified manifest at install time, and the module in
Settings → Modules once installed. Signed community bundles install through
that trust prompt; a publisher key fingerprint listed in
`trusted-publishers.json` installs without one; unsigned module bundles are
rejected from the marketplace.

## Conversation providers

A conversation provider adds a model provider to Studio's chat: a
`plugin.json` with `"kind": "provider"` naming the provider, its models and how
it signs in (`providerType`, `models`, `auth`, and an OpenAI-compatible
endpoint or an adapter). Drop it into `~/.sprintengine/plugins/<id>/`; it is
picked up on the next launch. An executable adapter must be signed by a
publisher you trust before it runs. `resources/plugins/claude-agent`,
`openrouter` and `xai` in the app repository are worked examples, and
`src/shared/plugin-manifest.ts` is the shape.

Agent CLIs (`kind: "cli"`) are not loaded from this folder: they ship with the
app, and their manifest contract is the app's own
(`src/shared/cli-plugin-manifest.ts`), not part of the SDK.
