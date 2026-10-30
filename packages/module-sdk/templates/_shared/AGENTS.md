# {{displayName}} — a SprintEngine Studio extension

This project builds a SprintEngine Studio extension (a capability module) with
`@sprintengine/module-sdk`. It never compiles against the app's source: the SDK
is the whole contract.

**Read first:** the extension guide. Call SprintEngine Studio's
`extension.guide` tool (on the `sprintengine-studio` MCP server) with topic
`start` before changing anything; its other topics answer "which surface",
"which API", "which permission" and "why won't it load". Without Studio's tools
the same topics are the files in `node_modules/@sprintengine/module-sdk/guide/`
(after `npm install`). The SDK's own README is
`node_modules/@sprintengine/module-sdk/README.md`, and its type declarations in
`node_modules/@sprintengine/module-sdk/dist/*.d.ts` are the authority on every
signature. What the extension is for is in `IDEA.md`.

## Layout

| Path | What it is |
| --- | --- |
| `src/` | Source. `renderer.tsx` → `registerRenderer(host)`, `main.ts` → `registerMain(host)` |
| `module/` | The installable module: `manifest.json` plus the built `dist/`. Everything in here ships, and it is committed — build included — because a GitHub install reads it at a commit |
| `plugin.json` | The bundle manifest a GitHub or marketplace install reads; its `module` component is `module/` |
| `test/` | `smoke.test.mjs` loads the built bundles against the SDK's fake hosts and renders what they register; `*.test.ts` are your tests |
| `scripts/` | `check-toolchain.mjs` (is this machine ready), `validate.mjs` and `dev-install.mjs`, the dev loop |

## Commands

```sh
npm install
node scripts/check-toolchain.mjs   # Node, npm, git, the SDK installed, the host API declared
npm run check        # typecheck, build (which records the file digests), tests, validate — run before calling anything done
npm test             # bundle test/*.test.ts with esbuild, then run them and the smoke test with node --test
npm run dev:install  # build, record file digests, sign if you have a key, copy into ~/.sprintengine/modules/{{id}}
npm run keygen       # once: a signing key in ~/.sprintengine/keys/{{id}}.key (never in this repo)
npx sprintengine-module add main|mcp|settings|door   # add a part: files, test, entry, permissions, build script
```

## Tests

Write tests in TypeScript as `test/*.test.ts`. `npm test` bundles them with
esbuild into `test/.build/` (ignored) and runs them with `node --test`, after
`@sprintengine/module-sdk/testing/register` has routed the host's UI kit to a
stand-in that renders in Node. Import the source (`../src/main`,
`../src/renderer`) and drive it with `createFakeMainHost` /
`createFakeRendererHost` from `@sprintengine/module-sdk/testing`: they keep the
host's rules, so a missing permission or a door that throws fails here rather
than in Studio. Test `entry.main` this way before a Studio restart.

After `dev:install`, trust the module in Studio (Settings → Modules). A module
with `entry.main`, or a rebuild of code Studio already loaded, needs a restart.

## Rules

- Keep `permissions` minimal and identical in `module/manifest.json` and
  `plugin.json`. They are shown to the person installing; the host enforces
  some of them.
- Any edit to `module/` — manifest or code — changes what trust was granted
  to. Rebuild, `dev:install`, trust again.
- Agents are chats: start them with the conversation service or `openChat`.
  There is no terminal-agent API.
- Store data with `getModuleStorage(host)` / module app state, never files in
  the home folder. Reach secrets and GitHub through the brokers, never by
  holding a token.
- Text an agent or a web page produced is untrusted input: never evaluate it,
  and never let it choose a path, a URL or a command unchecked.
- Commit `module/dist/` with the `module/manifest.json` the same build wrote;
  one without the other is refused as tampered.
- Never commit `*.key` / `*.pem`.
