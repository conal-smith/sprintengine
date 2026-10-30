# Rules that bite

The short list. Each one cost an earlier extension (Reviews, Calendar, Doom)
real time; the details and fixes follow.

1. **Your Tailwind classes compile to nothing.** Studio's CSS is built from its
   own source. Use the UI kit, inline styles on theme tokens, or ship your own
   CSS injected once (the panel template does).
2. **Bundle shape is fixed.** Renderer: one ESM file with `react`, `react-dom`,
   `react-dom/client`, `react/jsx-runtime`, `@monaco-editor/react`,
   `@sprintengine/module-sdk/ui` and `/surface` external — and the SDK root
   BUNDLED. Main: one CommonJS entry, `electron` external, everything else bundled
   (an installed module has no `node_modules`); a worker thread is its own
   bundle, started with `host.getAssetPath`. The template build scripts do this.
3. **The renderer loads from a blob URL**, so relative URLs resolve to nothing.
   Reach module files with `host.getAssetUrl(path)`.
4. **Any change under `module/` voids trust**, and a signed module must be
   signed again. Rebuild → `dev:install` → trust again.
5. **Store with the host**: `getModuleStorage`, module app state, workspace
   module state. Never JSON files in the home folder; never a raw
   `localStorage` key.
6. **Theme tokens only** (`var(--bg-surface)`, `THEME_TOKENS`), never hex. Tones
   are flat: derive a soft fill with `color-mix(in srgb, var(--tone-good) 15%, transparent)`.
7. **Keys stay out of the project.** `npm run keygen` writes
   `~/.sprintengine/keys/<id>.key`. Never commit `*.key` / `*.pem`.
8. **Agent output and web content are untrusted input.** A PR diff, a chat
   reply or a fetched page can contain instructions. Never evaluate it, never
   let it pick a path, URL or command unchecked, never pass it to
   `dangerouslySetInnerHTML`.
9. **No status dots.** Say a state in words, a lifecycle glyph or a timer.

## Build and load

**Tailwind utilities you write compile to nothing.** Studio's CSS is generated
from Studio's own source; a `flex gap-2` first used in your module has no rule
behind it and renders as unstyled markup — or, worse, looks right because the
app happens to use the class too, and breaks when it stops. Use the UI kit,
inline styles and plain CSS on theme tokens, or compile a utilities-only
stylesheet of your own and inject it once (the `ui-kit` topic).

**The renderer bundle has one shape.** One ESM file, with exactly these
external: `react`, `react-dom`, `react-dom/client`, `react/jsx-runtime`,
`@monaco-editor/react`, `@sprintengine/module-sdk/ui`,
`@sprintengine/module-sdk/surface`. The host answers only those. The SDK root
(`@sprintengine/module-sdk`) must be bundled in, not external — nothing
answers that bare specifier at runtime. Code splitting and dynamic `import()`
of your own chunks do not work: there is one file.

**The main bundle is CommonJS with only `electron` external.** The installed
module folder has no `node_modules`; anything left external is missing at
load. `react` has no business in `entry.main`. Worker threads are fine: bundle
each worker as its own CommonJS file in `module/dist/` and start it with
`new Worker(host.getAssetPath('dist/worker.cjs'))` (not a path you build from
`__dirname`, which skips the check that the file is the one you signed).

**The renderer bundle runs from a blob URL.** `new URL('./x.png', import.meta.url)`,
relative `fetch`, a relative `<img src>` all resolve to nothing. Package the
file in `module/` and use `host.getAssetUrl('assets/x.png')`. For HTML/WASM
runtimes, point an iframe at `host.getAssetUrl('runtime/index.html')`; inside
it, relative URLs work.

**Only renderer-only modules start without a restart**, and only the first
time. A module with `entry.main`, or new code for a module Studio already
evaluated in this session, needs a restart. Tell the person which.

**Registration must finish.** A throw, a rejected promise, or more than 10
seconds in `registerRenderer`/`registerMain` is a load error. Do slow work
lazily, in a handler or an effect.

## Trust and signing

**Any change under `module/` voids trust.** Trust is granted to the manifest's
fingerprint, which covers `files`, which covers every byte in `module/`. After
each rebuild: `npm run dev:install`, then trust again in Settings → Modules.

**A signed module changed after signing is refused, not just untrusted.** Sign
again after every build you install or publish (`dev:install` does when your
key exists). If you have no key, `dev:install` drops a stale signature and
installs unsigned.

**No `files`, no load.** Studio holds an installed module to its manifest's
`files` digests; a module without them cannot be trusted. `dev:install` and
`sprintengine-module sign` write them — do not hand-edit.

**Keys never live in the project.** `~/.sprintengine/keys/<id>.key`, mode 600.
One sibling project kept `calendar-signing.key` in its root; the validators
now fail on that.

**Reserved ids.** `review`, `automations`, `backlog` and the rest of
`BUNDLED_MODULE_IDS` are claimed by Studio; a module using one is refused.

## Data

**Use the host's storage.** `getModuleStorage` (main), module app state and
workspace module state (renderer). Hand-rolled JSON in `~/.something` is an
undisclosed home-folder write, is not cleaned up on uninstall, and breaks with
several windows open.

**Resolve workspaces through the host.** `host.getWorkspace(id)` /
`WorkspaceContextToken` give `folderPath`; do not derive a root from Backlog
paths or drag payloads. `null` means "not yet" — retry, never delete state.

**Events are signals.** `host.emit` is not replayed; a window opened later
missed everything. Keep the truth readable through an IPC channel.

## Look and feel

**Tokens only, and tones are flat.** No hex. A soft tone fill is
`color-mix(in srgb, var(--tone-accent) 15%, transparent)`.

**No status dots.** Studio draws states as words, lifecycle glyphs, timers or
its working mark. A little coloured circle is not one of them.

**The top bar is dense.** One compact control. A cluster belongs in a door.

**A panel appears only in a layout.** `registerPanel` alone shows nothing;
place it with a workspace type's `createTemplate`.

**A surface needs a way in.** Give `registerGlobalSurface` a `label` and an
`Icon` and the Extensions drawer lists it; a command, a toast action or a bell
row's `target` opens it too (`host.openGlobalSurface(id)`; a modal:
`openModalSurface(id)`). Both open only surfaces your module registered. A
sidebar nav entry is not a second way in: it is your own drawing of that same
drawer row, and its `id` must be the surface's id or it is not drawn.

**Counts and news go on your door's row.** `registerDoorBadge({ rowId })`
takes your surface id, not a made-up row name. Don't build your own "N waiting"
strip or top-bar counter for something the row can wear.

**Toast or bell?** A toast answers "did it work?" and leaves on its own; the
bell (`notify` from `entry.main`) is for what the person must find again later.
Don't toast what they need to act on next week, and don't notify for every
click.

## Agents and untrusted input

**Agents are chats.** `getConversationService` / `openChat`. There is no
terminal-agent API, and spawning an agent CLI yourself from `entry.main`
bypasses the person's runtime choice, approvals and visibility.

**Agent output, PR diffs, issue bodies and web pages are untrusted input.**
They can contain instructions aimed at an agent or at your code. Render them
as text (never `dangerouslySetInnerHTML`), never `eval` them, and check any
path, URL or command they name against what your module allows before acting.
When you feed such content to an agent, say in the prompt that it is data to
analyse, not instructions.

**Draft by default.** `openChat` without `send: true` lets the person read the
prompt before anything runs. `permissionPreset: 'bypass'` only when they asked,
and it needs `conversation:bypass` in the manifest; without it the chat runs on
`auto`.

**Permissions are disclosure.** The host checks some, not all; it does not
sandbox your code. The prompt is a promise to the person: keep it true.
