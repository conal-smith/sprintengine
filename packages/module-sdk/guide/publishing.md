# Signing and publishing

## What a signature does and does not do

`sprintengine-module sign` writes a detached ed25519 signature over the
validated manifest, which includes `files` — the digest of every file in
`module/`. So a signature says "this key vouches for exactly this code".

- Signed by a key Studio does not know: the module shows as **signed**, with
  the key's fingerprint, and the person still decides whether to trust it.
- Signed by a publisher key Studio ships in its trusted list: trusted without
  a prompt. Only first-party publishers are on that list.
- Unsigned: installable, with a clear warning and an explicit trust decision.
- Any change to `module/` after signing makes the signature invalid, and an
  invalid module is refused outright (not merely untrusted). Sign again.

## The key

```sh
npm run keygen    # sprintengine-module keygen --out ~/.sprintengine/keys/<id>.key
```

- The private key is a PKCS#8 PEM file, mode 600. It never goes in the
  project, never in git, never in CI logs. `pack` and the validators refuse
  `*.key` / `*.pem` files; `.gitignore` ignores them.
- Back it up. Losing it means publishing under a new fingerprint, and people
  who trusted the old one are asked again.
- In CI, keep it in a secret and write it to a temp file for the `sign` step.

## Sign, verify, pack

```sh
npm run build
npx sprintengine-module sign module --key ~/.sprintengine/keys/<id>.key   # writes files + signature into module/manifest.json
npx sprintengine-module verify module                                     # the app's own check: signature AND files
npx sprintengine-module pack module --out packed/<id>                     # an installable copy without keys or node_modules
```

`npm run dev:install` does the sign step for you whenever
`~/.sprintengine/keys/<id>.key` (or `$SPRINTENGINE_SIGNING_KEY`) exists.

## Release checklist

1. Bump `version` in `module/manifest.json` **and** `plugin.json`.
2. `npm run check`.
3. Sign the module (above), then the bundle:
   `npx sprintengine-module plugin sign . --key ~/.sprintengine/keys/<id>.key`
   and `npx sprintengine-module plugin verify .` — module first, because the
   bundle digests the module's signed manifest.
4. `node scripts/validate.mjs` — it runs both verifies.
5. Commit `module/manifest.json`, `module/dist/` and `plugin.json` together
   (the template's `.gitignore` keeps the build; see
   below), tag the release, push.

## Where people get it

| Channel | What they do | What you need |
| --- | --- | --- |
| Folder | Settings → Modules → "Install a module from a folder", pointing at `module/` (or `packed/<id>`) | Nothing more |
| GitHub | Install from GitHub with the repository URL | `plugin.json` at the repo root, `module/dist` committed — below |
| Marketplace | Find it in the Extensions door's Plugins view | A signed bundle and a registry pull request (below) |

## The marketplace registry

The catalogue is the `sprintengine/studio-releases` repository:

```
marketplace.json
icons/<id>.svg
plugins/<id>/plugin.json
plugins/<id>/module/…        # your signed module folder
```

1. Copy `plugin.json` and `module/` (after both are signed) into
   `plugins/<id>/`, and add `icons/<id>.svg`.
2. Add an entry to `marketplace.json`:
   ```json
   {
     "id": "<id>",
     "name": "<displayName>",
     "publisher": { "name": "<publisher>", "verified": false },
     "summary": "<summary>",
     "category": "Developer Tools",
     "icon": "icons/<id>.svg",
     "latest": 1,
     "source": "https://github.com/sprintengine/studio-releases/tree/main/plugins/<id>",
     "provides": ["module"],
     "signature": { "algorithm": "ed25519", "publicKey": "<from plugin.json>", "signature": "<from plugin.json>" }
   }
   ```
   `name`, `latest`, `provides` and `signature` must match the signed
   `plugin.json` exactly. `source` must be `https:` on github.com,
   api.github.com or raw.githubusercontent.com.
3. Open the pull request. Registry CI runs the same verifier Studio runs;
   listings reach people with the next catalogue release.

Community entries use `"verified": false`: people install them through the
trust prompt, which lists the permissions from the verified manifest.

## The SDK itself

Projects depend on `@sprintengine/module-sdk` from npm (`^1.0.0-beta.0` or
newer). To try an unreleased SDK, depend on a local tarball
(`"@sprintengine/module-sdk": "file:vendor/sprintengine-module-sdk-<v>.tgz"`)
— the scaffolder's `--sdk-tarball` option sets that up.

## Installing from GitHub

People can install an extension straight from its repository: in Studio's
Extensions door, **Install extension from GitHub…**, paste the repository URL.
Studio resolves the default branch to a commit, reads `plugin.json` at the
repository root at that commit, shows what it found — name, publisher,
permissions, whether it is signed — and installs the `module/` folder the
bundle names. Updates compare the commit again and ask again when the
permissions or the signing change.

### What the repository must contain

```
plugin.json              at the root; components.module.path = "module"
module/manifest.json     with "files" (and "signature" if you sign)
module/dist/…            the BUILT bundles — commit them
```

The template is set up for this: its `.gitignore` keeps `module/dist/`, and
`npm run build` ends by recording `files` in `module/manifest.json` (and
signing it when `~/.sprintengine/keys/<id>.key` exists). It writes the manifest
only when the files changed, so after a rebuild of unchanged code git shows
nothing, and after a real change it shows the manifest beside `module/dist/`,
which is what to commit together. So:

1. Build: `npm run check`, or `npm run dev:install` to try it in Studio first
   (or `npx sprintengine-module sign module --key …` to sign by hand). Each
   leaves the manifest describing the build.
2. If you sign: `npx sprintengine-module plugin sign . --key …` after the
   module is signed.
3. `node scripts/validate.mjs` — clean, no stale-digest warning.
4. Commit `plugin.json`, `module/manifest.json` and `module/dist/` in one
   commit, and push.
5. Others install it: Extensions → **Install extension from GitHub…**, and the
   repository URL.

A `module/` whose files do not match its manifest's `files` is refused as
tampered, so never commit a rebuild without the manifest it produced — build,
then commit both.

Under the hood Studio resolves with `extensions:github:resolve` (the commit,
`plugin.json` there, and what it discloses), installs that exact commit with
`extensions:github:install`, and removes an installed module with
`modules:third-party:uninstall` (Settings → Modules → Uninstall).

### Signed or not

- **Signed** (a valid signature over `files`): installs through the normal
  trust prompt showing your key's fingerprint.
- **Unsigned, with code** (`entry.main` or `entry.renderer`): Studio warns that
  nobody vouches for the code and requires an explicit "I trust this code"
  choice before it installs. `files` is still required: it is what Studio
  holds the installed folder to.
- **Invalid** signature (changed after signing): refused.

### What is not an extension repository

A repository with `.claude-plugin/` (an agent-CLI plugin of skills and
commands) is a skill source, not a Studio extension: add it from the Skills
path, which is unchanged. And a `plugin.json` that describes an agent CLI is
not installable — Studio's agent runtimes ship with the app.

### Forks

A fork is a different repository and a different source: installing it is a
separate install, with its own trust decision. Keep the module `id` unless
the fork is meant to sit beside the original; two modules cannot share an id.
