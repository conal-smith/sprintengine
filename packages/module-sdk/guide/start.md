# Building a SprintEngine Studio extension

An extension is a **capability module**: a folder with a `manifest.json` and
built JavaScript that Studio loads into itself. `entry.renderer` (one ESM
file) adds UI; `entry.main` (one CommonJS entry file, which may start worker
threads from files it ships) runs in Studio's main process with Node. Both get
a `host` object scoped to the module, and everything the module does goes
through it. The contract is `@sprintengine/module-sdk` and nothing else — an
extension never imports Studio's source.

The SDK's type declarations (`node_modules/@sprintengine/module-sdk/dist/*.d.ts`)
are the authority on every signature; its README is the long-form guide. This
guide is the working method and the things that are not obvious from the
types. Studio serves it to agents with the `extension.guide` tool, one topic at
a time; the same files are in `node_modules/@sprintengine/module-sdk/guide/`.

## The project

`extension.create` (or `npx sprintengine-module init`) makes a project that
looks like this:

```
src/renderer.tsx      registerRenderer(host) — UI contributions
src/main.ts           registerMain(host) — Node side (only if the template has one)
module/manifest.json  the module manifest; module/ is the ONLY folder that installs
module/dist/          build output (renderer.mjs, main.cjs)
plugin.json           bundle manifest for GitHub/marketplace installs; component "module" → module/
test/smoke.test.mjs   loads the built bundles against the SDK's fake hosts and renders what they register
test/*.test.ts        the project's own tests, in TypeScript, against the same fakes
scripts/              check-toolchain.mjs, validate.mjs, dev-install.mjs
IDEA.md               what the person wants — read it first
```

## First steps in a project

1. `npm install`, then `node scripts/check-toolchain.mjs`. Fix every FAIL
   line.
2. `npm run check`. A fresh project passes; if it does not, fix that before
   changing anything.
3. Read `IDEA.md`. If the brief leaves the surface, the data or the
   permissions open, ask — at most three questions, each with a suggested
   answer — before writing code. A project Studio's New chat made starts on the
   `blank` template, and its first message is the person's request as they
   wrote it (IDEA.md quotes it): that request is the brief.
4. Pick the smallest surface that does the job (the `surfaces` topic) and
   change the template toward it. Delete what the idea does not need. A surface
   the template lacks is one command: `npx sprintengine-module add main|mcp|settings|door`
   adds its files, test, entry, permissions and build script, and wires it in.
5. When it works, `npm run dev:install` and tell the person what to click to
   try it (the loop below).

## The loop

```sh
npm run check        # typecheck → build → tests (smoke + test/*.test.ts) → validate. Run it after every change.
npm run dev:install  # build, write module/manifest.json "files", sign if a key exists, copy to ~/.sprintengine/modules/<id>
```

Then in Studio: **Settings → Modules**, find the module, trust it. Only the
person can trust it; never try to do it for them. `module.status` (a Studio
tool) says whether Studio sees the installed module, whether it is trusted, and
why it is not running when it is not.

- Trust is granted to exact contents. Every rebuild changes the `files`
  digests, so Studio asks again after each `dev:install`. That is the
  design, not a bug.
- A module with `entry.main`, or a rebuild of renderer code Studio already
  loaded, needs a Studio restart. A first install of a renderer-only module
  starts as soon as it is trusted.
- Say what the person should click and what they should see. You cannot see
  Studio's window; they can.

## Testing without Studio

`main.ts` changes need a Studio restart to try, so test them in Node first.
`@sprintengine/module-sdk/testing` has fake hosts that keep the host's rules
(the permissions it checks, storage's key and size limits, chat ownership, the
bridge's `module:bridge`), and a UI kit stand-in that renders. Write tests in
`test/*.test.ts`; `npm test` bundles them with esbuild and runs them with
`node --test`:

```ts
import { createFakeMainHost, createFakeRendererHost } from '@sprintengine/module-sdk/testing'
import manifest from '../module/manifest.json'

const main = createFakeMainHost({ manifest })
await registerMain(main.host)
await main.ipc.invoke('<id>:start', { workspaceId: 'ws-app' })          // what the window would send
main.services.conversations.emitEvent(ref, { type: 'turn_completed' }) // what the agent would do
assert.deepEqual(main.undeclared, [])                                   // nothing used undeclared

const renderer = createFakeRendererHost({ main })
await registerRenderer(renderer.host)
assert.match(await renderer.render.surface('<id>'), /Nothing yet/)
```

Every service and host method has a fake you can arrange and read back:
`main.services.backlog.seed(...)`, `usage.record(...)`,
`activity.addChat(...)`, `storage.changeExternally(...)` (a `git pull` the
watch hears), `github.respond(...)` / `respondGraphql(...)` /
`respondDownload(...)`, `workspaces.close(id)` / `setGitInfo(id, ...)`,
`main.setAppState(key, value)` (a Settings change `entry.main` hears),
`main.skills.setStatus(...)`, `textGeneration.respond(...)`,
`conversations.restore(...)` (a saved chat appearing after launch),
`companions.requestApproval(...)` (an agent asking for a tool mid-run),
`scheduledAgents.fire(id)` (a run, with its chat and `onRun`),
`main.setChatRuntimes(...)`. On the renderer: `renderer.toasts`,
`renderer.openedUrls`, `renderer.surfaceViews`,
`renderer.setActiveWorkspace(id)`, and `runCommand(id)` hands `run` the
command context. Pass `capabilities: [...]` to test an older host's branch.

A render is a server render: effects do not run, and `useSyncExternalStore`
needs its third argument. The smoke test renders every door, panel, settings
section and top-bar item the module registers, so one that throws fails
`npm run check`.

## The other topics

| Topic | Read it when |
| --- | --- |
| `surfaces` | Choosing what the extension adds to Studio, and which API does it |
| `manifest` | Writing `module/manifest.json` and `plugin.json` |
| `permissions` | Choosing permissions; what each one allows |
| `rules` | Before writing UI or a build change: the mistakes that cost earlier extensions time |
| `api-renderer` | The renderer host: contributions, state, `openChat` |
| `api-main` | The main host: services, storage, IPC, MCP tools, skills |
| `conversations` | Starting, prompting and reading the extension's own chats; one-shot text generation |
| `brokers` | API keys and GitHub through the host |
| `ui-kit` | `@sprintengine/module-sdk/ui` and `/surface`, theme tokens, styling |
| `troubleshooting` | Studio does not list, trust or run the module |
| `publishing` | Signing, installing from GitHub, the marketplace |

## Done means

- `npm run check` passes with no warnings you have not explained.
- `npm run dev:install` succeeded, and you told the person exactly what to
  click and what they should see.
- Permissions in `module/manifest.json` and `plugin.json` match and are the
  minimum; `IDEA.md` says what the extension does now.
- The smoke test still passes; add your own `test/*.test.ts` for logic worth
  pinning.
