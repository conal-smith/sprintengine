# Phase 9 — the web client and the embeddable conversation view

Status: scoped, 2026-10-01. Nothing here is implemented. This file hardens
phase 9 of `docs/design/studio-server.md` (sections 9, 11 and 13). Where the
two disagree, this file states the change the parent needs, in section 12, and
the parent is updated in the same change that lands the work.

Amended 2026-10-02 for the owner ruling of that date: the server has no
browser and no canvas. The screencast pane is gone. The web client shows an
agent's dev server through `previews` (3.6), offers the `canvas` toolset
itself (3.8), and offers no `browser` toolset in v1.

Owner defaults this scope is built on (2026-10-01, as amended):

- The server is small (owner ruling 2026-10-02): no browser and no canvas in
  it. The earlier default, "the browser pane becomes a live view of the
  server's headless browser", is withdrawn.
- No terminals in v1.
- Chat first: conversations and the data chat needs (changed files, turn diffs,
  checkpoints and revert, attachments, @-mention file search, the workspace
  list). The git panel and file explorer come later.

## 1. What phase 9 delivers

1. **The web client.** The Studio server serves the renderer as a web app on
   its loopback listener (and, under the conditions in 6.6, the tailnet). A
   browser pairs once, holds a session cookie, and then runs the same React
   tree the desktop runs, with the shell members of `window.api` filled by
   browser fallbacks and the server members carried by the SDK client.
2. **The embeddable conversation view.** Another app can show a Studio
   conversation:
   - a headless **timeline layer** that folds protocol events into rows, with
     no React, DOM or Electron in it;
   - a thin **React view** over it;
   - an **iframe route** on the server for apps that do not want to build
     anything.

   All three are versioned against the protocol like any other client. The
   embed is built after the web client.
3. **Previews.** An agent's dev server on the server's loopback, passed
   through to the browser on an origin of its own (3.6).
4. **The web client's `canvas` toolset.** The web client draws boards and
   answers agents' `canvas.*` calls, as the desktop does (3.8).

Not in phase 9: terminals (ruling a), the git panel and file explorer
(ruling c), a hosted relay or public endpoint, multi-user servers.

## 2. Where things stand (measured)

### 2.1 How the renderer is built

- `electron.vite.config.ts` builds three renderer HTML entries (`index`,
  `splash`, `canvas-worker`) with React, Tailwind v4 (configured in CSS, no
  `tailwind.config`), a `virtual:sprintengine-build-stamp` module, and a plugin
  that emits the canvas scene fonts unhashed at `fonts/<Family>/<file>.woff2`
  beside each document. The only alias is `@renderer` → `src/renderer/src`.
  Minify is `oxc` with `keepNames`.
- Nothing in the renderer config is Electron-specific. `base` is unset (the
  Electron build loads over `file://`), Monaco workers are Vite `?worker`
  imports (same-origin files), fonts are `@fontsource` packages, and the
  canvas asset path is `new URL('.', location.href)`. All of that works over
  HTTP unchanged (experiment E1).
- `src/renderer/src/main.tsx` holds the first render on three promises:
  third-party renderer modules, launch settings (an IPC round trip) and
  `monacoReady`. On the desktop a splash window covers that wait. A browser
  has no splash.

### 2.2 What the renderer assumes from Electron

- One preload global, `window.api` (`src/preload/index.ts:114`), typed by
  `ElectronApi` in `src/shared/electron-api.ts`: 282 invokes, 13 sends, 47 push
  subscriptions, and four values computed in the preload (`platform`,
  `isDevelopment`, `isDiagnosticsEnabled`, `diagnosticsGetIpcStats`).
- 189 renderer files reference `window.api`, about 373 distinct members, 965
  references. Guards: 56 files use `typeof window.api.X`, 88 files use some
  guard form, and **103 files use none**. The parent design's "about 72
  files guard" overstates the cover. Note also that `typeof window.api.X`
  itself throws when `window.api` is undefined; only `window.api?.X` survives
  that.
- No renderer module touches `window.api` at import time. Failures happen
  when a component mounts or a handler runs.
- **No root error boundary.** `main.tsx` renders `WorkspaceManager` with no
  boundary above it; `GlobalSurfaceErrorBoundary` wraps only two surfaces.
  One malformed reply unmounts the whole app to a blank page (E2–E5).

### 2.3 The chat seam

- `ConversationTransport` (`components/panels/agentChat/conversationTransport.ts`)
  covers subscribe, load earlier, tool detail, turn diff, send, interrupt,
  respond, preset, and optionally model, attachment, rewind and fork, with
  twelve capability flags. 18 call sites use it.
- About 20 chat files still call `window.api` directly (table in 4.3): session
  start, providers, models, secret status, revert, the plan document, the
  command catalog, @-mention search, the skill reader, history and search,
  local images, file links, clipboard and `platform`.
- The event-to-row pipeline is already pure TypeScript:
  `conversationProjection.ts` → `incrementalConversationProjection.ts` →
  `conversationTimeline.ts` (`ConversationTimelineRow`), plus
  `sessionEventLog.ts` and `todoProgress.ts`. **One leak:** `turnFolds.ts`
  imports `stepWentWrong` from `toolRows/ToolRow.tsx`, which drags React,
  `window.api`, shiki and the diff window in. The session store in
  `useConversationSession.ts` (cursors, merge, urgency, load earlier, retry)
  is React-free except the hook at the bottom.
- Rows render through `@legendapp/list` (virtualized, 10 turns a page,
  manual "load earlier"), `react-markdown` + `remark-gfm`, `shiki` and `diff`.

## 3. Spec — the web client

### 3.1 Build and serve

- **Build.** `npm run build:web` runs Vite with the renderer section of
  `electron.vite.config.ts` factored into a shared function
  (`renderer.vite.config.ts`), `base: './'`, one HTML entry (`index`), the
  build-stamp plugin and the canvas fonts plugin. Output is `out/web/`,
  copied into the server bundle beside `server.mjs` (parent 10.4). The
  `splash` entry is not built for the web. The `canvas-worker` entry is built
  for the web too: the web client loads it in a hidden frame to offer the
  `canvas` toolset (3.8). The server bundle itself carries no canvas worker
  and renders nothing.
- **`import.meta.env.STUDIO_CLIENT`** (`'desktop' | 'web'`) is a build-time
  define. It is used **only** to choose which `window.api` to install at boot
  (`createDesktopApi` reads the preload; `createWebApi` builds the shim). Every
  other branch asks a capability (3.4), so one code path serves a web build
  and a desktop attached to a remote server.
- **The inline boot script** in `src/renderer/index.html` moves into a file
  (`public/boot-theme.js`), loaded as a classic blocking script, so a CSP
  needs no `'unsafe-inline'` for scripts (E8). Its window-material rule gains
  "web → solid" (E7).
- **Boot skeleton.** On the web, `index.html` paints a static skeleton (the
  sidebar and an empty chat column in the theme's colours) that React
  replaces, because nothing else covers the wait for launch settings and
  modules.
- **Serving.** The server's HTTP layer, on the loopback listener:

  | Path | Auth | Cache | Notes |
  | --- | --- | --- | --- |
  | `/assets/*`, `/fonts/*` (hashed, or fixed by the editor's font loader) | none | `public, max-age=31536000, immutable` (fonts: `max-age=86400`) | brotli and gzip precompressed at build time, chosen by `Accept-Encoding` |
  | `/`, `/index.html`, any SPA route | session, else 302 to `/pair` | `no-store` | carries the headers in 6.4 |
  | `/pair` | none | `no-store` | a small standalone page, not the app bundle |
  | `/.well-known/sprintengine-studio` | none | `no-store` | parent 5.3 |
  | `/ws` | session cookie (web) or ticket (embed, SDK) | — | the one multiplexed socket |
  | `/api/upload`, `/api/attachment/*`, `/api/tool-image/*` | session or ticket | `private` | bytes beside the socket (parent 5.1) |
  | `/modules/<hex id>/…` | session | `no-store` | module renderer entries and assets (3.7) |
  | `/embed/…` | embed token (section 5) | `no-store` | the iframe view |
  | each preview's own origin (a separate listener) | preview cookie, after a one-time code (3.6) | as the dev server sends | an agent's dev server, passed through |

  Static assets are public on purpose. The bundle is open source, and a page
  that cannot load its own scripts before pairing cannot show a useful error.
  Nothing an asset contains is per-user.
- **Development.** The server proxies page loads to the Vite dev server on
  `SPRINTENGINE_RENDERER_PORT`; Vite proxies `/ws` and `/api` back. The Origin
  check (6.3) accepts the dev server's origin only when the server was started
  with `--dev`.

### 3.2 The web `window.api`

`createWebApi(client)` returns an object typed `ElectronApi` with no casts, so
the compiler lists every member the shim has not decided about:

- **Server members** come from `createServerBackedApi(client)` (parent 5.5),
  the same adapter the desktop uses from phase 4.
- **Shell members** come from `createWebShellApi()`, the fallbacks in
  section 4.
- **A member with no web meaning** is implemented as an explicit refusal
  (`unsupportedOnWeb('terminalSpawn')`). It returns a rejected promise with a
  typed `UnsupportedOnThisClient` error, or for a subscription, a no-op
  unsubscribe. It never returns `undefined` and never throws synchronously.
  Each refusal is logged once per member, which yields the
  "missing-member report" the parent's test plan asks for.
- **Values computed in the preload** become explicit: `platform` splits into
  `clientPlatform` and `hostPlatform` (3.3). `isDevelopment` comes from
  `import.meta.env.DEV`; `isDiagnosticsEnabled` from a URL flag on loopback
  only.

The catch-all proxy approach (answer every member with an empty value) does
not work: it boots only after hand-typed shapes for eight members, and even
then one wrong shape blanks the app (E3, E4). The shim is typed or it is not
a shim.

### 3.3 `platform` means two things

`window.api.platform` is the preload's `process.platform`: today the same
machine as the window. With a server it is two facts:

- **`clientPlatform`** (the browser's OS, from `navigator.userAgentData`, else
  the user-agent string) decides the Primary modifier (Cmd or Ctrl), the
  keyboard labels, the traffic-light reserve and the caption buttons. A
  Windows browser on a Mac server must get Ctrl. The parent design never
  separates these.
- **`hostPlatform`** (`welcome.environment.os`) decides path syntax, the
  "reveal in Finder/Explorer" wording, and CLI hints.

There are 53 `window.api.platform` references in 31 files. Each is
classified once. Most are client-side; the path helpers are host-side.

### 3.4 Capabilities, not `typeof`

A `clientCapabilities` record (renderer-only) answers what the current shell
can do: `native-dialogs`, `reveal-in-folder`, `open-in-app`, `os-clipboard`,
`os-notifications`, `aux-windows`, `multi-window`, `window-controls`,
`terminals`, `browser-pane` (the desktop's native pane), `previews` (the web
client's preview pane, 3.6), `app-menu`, `deep-links`, `drag-paths`, `file-uploads`
(the web client's, 14.14). The desktop sets them from the
preload. The web shim sets them from feature detection, including
`isSecureContext`. UI hides or swaps a control by asking
`clientSupports('reveal-in-folder')`, never by `typeof window.api.X`.

Server-side capabilities stay in `welcome.capabilities` (parent 5.3). A
control needs both when it needs both. For example, "Paste in terminal" needs
client `terminals` and a server that advertises them.

### 3.5 Session, tabs and reconnect

- **One WebSocket per tab** at `/ws`. The same-origin upgrade carries the
  session cookie, so a web tab needs no ticket.
- **`windowId` per tab.** Today every web tab would believe it is
  `windowId=primary`. The web shim mints a `windowId` per tab, kept in
  `sessionStorage` so a reload keeps it. The server's workspace sync treats
  each tab as a window, as it treats each desktop window.
- **Persisted stores** (`sprintengine-workspaces`, `sprintengine-app-settings`,
  drafts, notifications, view state; 15 keys) are per origin, so all tabs of
  one server share them, last writer wins. On the web:
  - the workspace registry and launch settings are server state, so their
    `localStorage` envelopes are not authoritative (the store already
    hydrates from main's registry);
  - drafts are keyed by conversation and merge;
  - the appearance settings take a `storage` event listener, as
    `notificationStore.ts` already has.
- **Reconnect.** The SDK client reconnects with backoff and resumes every
  open stream from its `{ afterSeq, generation }`. A cursor the server cannot
  vouch for gets a reset snapshot (unchanged rule). Triggers in a browser:
  - `online`;
  - `visibilitychange` to visible;
  - `pageshow` with `persisted` (a page restored from the back/forward
    cache, whose socket was closed);
  - the socket's `close`.

  Heartbeats are WebSocket ping/pong frames, which the browser answers itself,
  so background timer throttling cannot fail a heartbeat. The server keeps
  ping every 25 s and pong timeout at 60 s.
- **Reload.** Cursors live in memory. A reload takes a fresh snapshot, which
  is paged (10 turns), so this costs one page.
- **Version skew.** The page is served by the server it talks to, so they
  match at load. After a server upgrade, or a rebuild of its web client, the
  bundle the server serves differs from the one the page was loaded from. The
  page then shows "Studio was updated" with Reload and keeps working inside
  the protocol window. As built (14.11) the comparison is of web bundle ids,
  read from `/api/session`, not of `welcome.server.buildStamp`.
- **Unload.** Today's flushes on `beforeunload` also run on `pagehide` and
  `visibilitychange` to hidden, because mobile browsers do not fire
  `beforeunload` reliably.

### 3.6 The browser pane on the web: previews

The server has no browser and there is no screencast (owner ruling
2026-10-02). A page cannot drive other sites, so the web client offers no
`browser` toolset in v1, and with only web clients attached agents have no
browser (phase 5 §10.5). What the person still needs is to see what an agent
built: a dev server listening on the server's loopback. The `previews`
namespace passes one through to the browser, on an origin of its own.

```
 web client page, origin S (http://127.0.0.1:<studio port>, or the tailnet HTTPS name)
   └─ preview pane: <iframe sandbox …>, or a new browser tab
        origin P: the same host, a port of its own  ──► preview listener on the server
                                                           │ HTTP and WebSocket, passed through
                                                           ▼
                                               127.0.0.1:<dev port> on the server host
```

**Methods.** Owner sessions, or a `previews:open` grant that tailnet browser
pairings do not get by default (a preview exposes services on the server's
loopback to that device).

| Method | Shape |
| --- | --- |
| `previews.list` | `{}` → `{ ports: [{ port, pid, command, workspaceId?, conversation? }] }`. TCP listeners, on loopback or a wildcard address, of processes in the server's agent process trees (the CLIs it spawned and their descendants): `/proc/net/tcp` and `tcp6` mapped through `/proc/<pid>/fd` on Linux, `lsof -nP -iTCP -sTCP:LISTEN` for those pids on macOS. The server's own listeners are never listed. |
| `previews.open` | `{ port, workspaceId? }` → `{ previewId, origin, enterUrl }`. The port is one `list` gave, or any port from 1024 an owner types, never one of the server's own. The target is always the server's loopback (`127.0.0.1`, else `[::1]`), never another host, so this is not an open proxy. |
| `previews.close` | `{ previewId }` → `{}` |
| topic `previews.changes` (push) | the session's open previews, whole, on every change |

**Origin.** Each preview gets its own listener on the server's loopback, on a
port the OS picks, so its origin differs from Studio's by port:
`http://127.0.0.1:<pp>` for a loopback page; on the tailnet, an HTTPS port of
the node's name mapped to it with `tailscale serve`, the way the app itself is
served (6.6). The separate origin is what keeps agent-written code away from
Studio:

- the app's script cannot read Studio's DOM, storage or responses;
- any WebSocket upgrade or non-GET request the app makes to Studio carries
  `Origin: P`, which the exact-origin rule (6.3) refuses whatever cookie rides
  with it;
- Studio's authenticated responses gain `Cross-Origin-Resource-Policy:
  same-origin`, so the app cannot embed them as images or scripts either.

Same host and another port is a different origin but the **same site**, and
cookies are not isolated by port. So:

- Studio's session cookie (`se_s_<env>`, `HttpOnly`, `SameSite=Strict`) is
  sent to P by the browser. The preview listener strips every `se_` cookie
  from a request before forwarding it: the dev server never sees one.
- A `Set-Cookie` from the dev server whose name starts `se_` or `__Host-se_`
  is dropped, so the app cannot overwrite Studio's session.
- The app's script can still set cookies for the host itself
  (`document.cookie`), which Studio then receives. It cannot replace an
  `HttpOnly` cookie, but it can add a same-named one on a narrower path. So
  Studio reads every `se_s_` value a request carries and accepts the one that
  verifies, never the first. A page that floods the jar can make Studio's
  requests too large until the person clears the host's cookies; that is a
  nuisance the preview's help names, not a way in.
- A hostname per preview would make a separate site as well, but a loopback
  page and a tailnet node each have one name (`*.localhost` is not resolved
  by every browser), so the port is the boundary that holds everywhere.

**Auth.** A preview listener is never open without a credential (parent goal
4).

1. `previews.open` returns `enterUrl`, `P/__se_preview/enter?code=<code>`: 32
   random bytes, single use, 60 seconds, kept as a hash.
2. The web client loads it in the pane or a new tab. The listener spends the
   code, sets `se_pv_<previewId>` (`HttpOnly`, `SameSite=Strict`, `Path=/`,
   `Secure` on HTTPS) and redirects to `/` with `Referrer-Policy: no-referrer`
   and `Cache-Control: no-store`. The code is in the query, not a fragment,
   because the listener must see it on that first navigation; it is spent
   before the page it opens can run, the same reasoning as R17's tickets.
3. Every later request and upgrade needs that cookie. Without it the listener
   answers 401 with a one-line page, "Open this preview from Studio". Nothing
   under `/__se_preview/` is ever forwarded.
4. An upgrade must also carry `Origin: P`: no other site, and not Studio's own
   page, can drive the dev server's socket with the person's cookie.
5. A preview closes on `previews.close`, when its browser session is revoked,
   after 30 minutes with no request, or when the server stops. A session holds
   at most eight.

**Pass-through.** The listener speaks HTTP/1.1 to the browser (on the tailnet,
`tailscale serve` terminates TLS in front of it) and pipes each request to the
dev server with only these changes:

- `Host` becomes `localhost:<dev port>`, because current dev servers refuse an
  unknown `Host` as their own DNS-rebinding guard; an `Origin` equal to P
  becomes `http://localhost:<dev port>` for the same reason. Studio's cookies
  are removed. No `X-Forwarded-*` header is added.
- On the way back, a `Location` naming `localhost:<dev port>` or
  `127.0.0.1:<dev port>` is rewritten to P; Studio-named `Set-Cookie`s are
  dropped; `X-Frame-Options` is removed and any `frame-ancestors` in the
  app's CSP is replaced by `frame-ancestors S`, so the pane can frame the app
  and no other page can. Bodies are never rewritten, and nothing is injected
  into the app's pages.
- **WebSocket upgrades** (hot reload) pass through with the same `Host` and
  `Origin` changes and the cookie check; frames are piped, never parsed. Hot
  reload clients that connect to `location.host`, the default for the common
  dev servers, therefore work.
- Streaming responses and server-sent events are piped without buffering.

**The pane.** Where the desktop shows a browser tab, the web client shows a
preview pane: a port picker from `previews.list` (each port labelled with its
command and the conversation that started it), the preview in an `<iframe
sandbox="allow-scripts allow-same-origin allow-forms allow-popups allow-modals
allow-downloads">` (`allow-same-origin` beside `allow-scripts` is safe only
because P is never S), Reload, "Open in a new tab", and "Open in the desktop
app" when a desktop is attached to this server. There is no back or forward,
and the path field shows what the person typed: a cross-origin frame's
navigations cannot be read, and Studio injects nothing to read them.

**Limits, stated in the pane's help.**

- An app that uses absolute URLs (`fetch('http://localhost:3001/api')`, a hot
  reload client pinned to `ws://localhost:24678`) points at the person's own
  machine. From a browser on the server's machine they still work; through
  the tailnet they do not. The fix is in the app: relative URLs, or its dev
  server's own proxy. A second preview gives the API an origin, not a new
  address in the app's code.
- Previews on one host share the browser's cookie jar, as two dev servers on
  `localhost` do today.
- Agents do not see the preview. They have a browser only when a desktop (or,
  later, the headless client) offers one.

### 3.7 Modules on the web

- **Bundled modules** load as they do today, from the web bundle.
- **Third-party renderer entries** today arrive as source strings and are
  evaluated with `import()` of `blob:` URLs. React and Monaco are bridged by
  an import map appended after load (`modules/third-party-loader.ts`). That
  relies on multiple import maps, which only recent Chromium supports. On
  Firefox and Safari the loader must instead rewrite bare specifiers to
  `blob:` URLs before evaluation. The rewrite is a plain string transform the
  loader already half-does.
- **Assets.** `getAssetUrl` builds `studio-module://<hmac host>/…` on the
  desktop. On the web it builds `/modules/<hex id>/assets/<path>?sig=…`,
  served with the same checks as `module-assets.ts`: trust and enablement per
  request, the verified file list and its SHA-256, `nosniff`, `no-store`.
  These assets share the app's origin. That is acceptable only because module
  renderer code already runs in the app's document on the desktop (blob
  import), so the origin was never its isolation boundary. Module HTML that
  wants isolation runs in a sandboxed iframe, as it does now.
- **Graceful degradation.** `RendererHost.supports()` gains the client
  capability names in 3.4, so a module can ask
  `host.supports('native-dialogs')` and degrade. This needs no host API bump:
  `supports` already answers unknown names `false`.
- **Recommendation:** third-party renderer modules are off on the web in v1
  unless the owner turns them on for that server (owner decision 4).

### 3.8 The web client offers `canvas`

The web client runs the same `@excalidraw/excalidraw` build in a real
browser, so it can do what the desktop's hidden worker window does, and phase
5 leaves the choice to this phase (phase 5 §7.2, §10.5). It offers `canvas`.

- **What runs in the page.** The web build includes the `canvas-worker` entry
  and its fonts (3.1). The web client loads the worker in a hidden
  same-origin iframe, and runs the portable canvas service and tools (phase 5
  §10.2) in the page, with `path.posix` and a Web Crypto hash injected for
  their two Node imports. Boards are kept through the server's `files.*`
  methods and followed with `files.watch` (phase 5 §10.3), so an edit made
  here shows in a desktop on the same board, and the reverse.
- **Who may offer it.** A web tab whose session holds the owner's grants
  (a loopback pairing that kept them), with `hello.client.kind: 'web'`; that
  is the shell role phase 5 §7.2 asks this phase to settle. A tailnet browser
  pairing never offers it in v1, because `tools:offer` is never granted on
  the tailnet.
- **Routing.** By phase 5 §6.2 (R81): affinity first, then the client the
  person is looking at, then the one showing the workspace, then the
  conversation's starter, then by kind, desktop before web. A hidden tab sends
  `tools.focus { focused: false }`, so a visible client is preferred.
- **Background tabs.** Browsers throttle timers and pause
  `requestAnimationFrame` in hidden tabs. A call arrives as a socket message,
  which is not throttled, and the worker must answer without waiting on a
  frame or a timer; a test runs the canvas suite with the page hidden. The
  page withdraws `canvas` on `pagehide` and offers it again on `pageshow`.
- **Fonts.** The same bundled fonts as the desktop, served from the web
  bundle's `fonts/`, so a label measures the same in both clients (R48 for
  CJK).
- **Results.** `canvas.screenshot` uses the same export ladder, inside phase
  5's 960 KiB reply limit. `canvas.open` reveals the board in that tab.

## 4. Inventory: every Electron dependency in the renderer and its web fallback

Legend for **Guard**: `none` = an unguarded call that throws on the web
today; `typeof` = degrades to a no-op today; `n/a` = nothing to guard.
Paths are under `src/renderer/src/` unless they start with `src/`.

### 4.1 Shell surfaces

| # | Dependency | Where (main sites) | Guard | Web fallback |
| --- | --- | --- | --- | --- |
| 1 | `window.api` itself | `src/preload/index.ts:114` | n/a | `createWebApi(client)` installed before React (3.2) |
| 2 | `platform`, `isDevelopment`, `isDiagnosticsEnabled` (preload values) | 53 refs in 31 files; `WorkspaceManager.tsx:716` is the first boot read | none | `clientPlatform` / `hostPlatform` (3.3); `import.meta.env.DEV`; URL flag on loopback |
| 3 | `<webview>` browser pane, guest preload, `before-input-event` keys | `pane/browser/BrowserTab.tsx:591`, `src/preload/browser-guest.ts`, `src/main/browser/browser-manager.ts:488` | none (22 members) | The preview pane over `previews` (3.6): an iframe on the preview's own origin. No element picker, no agent control, no screencast |
| 4 | App menu: `onAppMenuCommand`, `updateAppMenuAccelerators`; Electron role items (undo, cut, zoom, reload, devtools, fullscreen) | `WorkspaceManager.tsx:3961,3975`; `src/main/app-menu.ts` | none | Menu commands are already registry commands, so they run from the palette. The menu-only items (About, Check for updates, Diagnostics) move into the account menu. Role items fall to the browser's own (undo/cut/copy work natively in inputs). |
| 5 | Native menubar popup on Windows/Linux: `showMenubarMenu` | `WorkspaceManager.tsx:4211` | none | Not drawn: `clientSupports('app-menu')` is false. The palette lists the same commands. |
| 6 | Context menus | All in-page already (`PointerPopover`, `OverflowMenu`; `onContextMenu` in 18 files) | n/a | Unchanged. Where the app does not `preventDefault`, the browser's own menu shows, which is the right default for text. |
| 7 | Folder picker: `openDir` (`dialog.showOpenDialog`) | 11 sites, e.g. `WorkspaceManager.tsx:3215` (New chat → Browse), `FileExplorer.tsx:2021`, `ExtensionsGlobalSurface.tsx:230` | none | `FolderBrowserDialog`, an in-app modal over `files.browse` (6.8) |
| 8 | Save dialogs: `git:save-patch`, canvas export | `GitPanel.tsx:1467` (typeof), `CanvasTab.tsx:224` (none) | mixed | Download: the server returns bytes, and the page saves them through an `<a download>` on a blob URL. The git one is out of v1 scope. |
| 9 | Attach file | `AgentChatView.tsx:2931` (`<input type=file>`) | n/a | Unchanged; bytes go to `/api/upload` |
| 10 | Drop OS files: `getPathForFile`, `File.path`, `saveDroppedImage` | `utils/imageFileTransfer.ts:82`, `NewAgentPanel.tsx:905`, `utils/terminalDrop.ts:449`, `FileExplorer.tsx:225` | none | No paths exist in a browser. Images attach as base64 as today. Other files upload to `/api/upload` and come back as a server path in the session's upload directory, which is what the agent receives. A document-level `dragover`/`drop` `preventDefault` stops a stray drop from navigating the app away; on the desktop, `will-navigate` does that job. |
| 11 | In-app drags (custom MIME with server paths) | `utils/terminalDrop.ts:48` | n/a | Unchanged |
| 12 | Clipboard read/write: `clipboardReadText`, `clipboardWriteText` | about 25 sites; 14 unguarded writes (e.g. `ConversationCodeBlock.tsx:123`), `EditorPanel.tsx:425` read | mixed | `navigator.clipboard`. **Never the server's clipboard**: today these IPC calls hit main's `clipboard`, which on a remote server is the wrong machine. Rich copy already uses `ClipboardItem`. On an insecure origin, writes fall back to `document.execCommand('copy')` and reads are not offered. |
| 13 | Paste bridge: `bindElectronClipboardPasteBridge` | `main.tsx:37`, `utils/clipboardPasteBridge.ts:42` | none | Not installed on the web. It exists for an Electron paste quirk, and on the web it would `preventDefault` a paste and then fail. |
| 14 | OS notifications, dock badge and bounce, `flashFrame` | main only (`app-services.ts:1268`, `agent-attention.ts`) | n/a | Web Notifications, shown only when the tab is hidden and permission was granted after a click in Settings. One tab shows each notification, chosen through `BroadcastChannel` leader election, with `tag` set to the event id so duplicates replace each other. `navigator.setAppBadge` where supported (installed PWAs). Otherwise the in-app bell, which exists today. |
| 15 | `openExternal` (`shell.openExternal`) | 7 sites, 6 unguarded (e.g. `ConversationImage.tsx:40`, `CanvasEditor.tsx:639`) | mixed | `window.open(url, '_blank', 'noopener,noreferrer')` for http, https and mailto; anything else refused. Today's IPC would open the URL on the server machine. |
| 16 | `target="_blank"` links, `window.open` | `utils/markdown.tsx:569`, `conversationLinks.tsx:145` | n/a | Unchanged: a browser opens a tab. Add `rel="noopener"` where missing. |
| 17 | `showItemInFolder`, `listFolderOpenTargets`, `openFolderInTarget`, `openHtmlFileInBrowser`, `openDiagnosticsLogsFolder` | 8 + 4 + 4 + 1 sites, unguarded (e.g. `ToolRow.tsx:317`, `conversationLinks.tsx:170`) | none | Hidden (`reveal-in-folder`, `open-in-app` false). A file link opens the in-app viewer. An HTML file opens in a sandboxed `srcDoc` frame, as HTML artifacts already do. Today these would act on the server's desktop. |
| 18 | `openImageAttachment` | `ComposerAttachmentStrip.tsx:51`, `ToolRow.tsx:294`, `ConversationImage.tsx:47` | none | Opens `/api/attachment/<id>` in a new tab |
| 19 | Keyboard: DOM dispatcher (`commandDispatcher.ts`), six menu accelerators, browser-pane forwarded chords | `WorkspaceManager.tsx:3840`, `src/main/app-menu.ts:5` | n/a | DOM dispatcher unchanged, Primary from `clientPlatform`. A web keymap profile (4.2). |
| 20 | Window controls and state: `windowMinimize`, `windowToggleMaximize`, `windowClose`, `getWindowState`, `onWindowStateChanged`, `onWindowPlacementChanged`, `onWindowCloseRequested` | `WindowControls.tsx:52`, `WorkspaceManager.tsx:1577,1584,2052` | none | Not drawn (`window-controls` false). The close handshake becomes `beforeunload` while a draft or turn is in flight. |
| 21 | Traffic-light reserve (78 px gap) | `AppRail.tsx:60`, `SidebarChrome.tsx:242`, `WorkspaceHeader.tsx:158`, `AppTitleBar.tsx:16`, two aux windows | n/a | No reserve. It is keyed on `clientPlatform === 'darwin' && clientSupports('window-controls')`, not on platform alone (E6 screenshot shows the gap). |
| 22 | `-webkit-app-region` drag regions | `index.css:3814`, about 40 uses | n/a | Ignored by browsers; harmless |
| 23 | Aux windows (`?aux=diff\|file`), diagnostics window, pop-outs: `openAuxWindow`, `dockFileToWorkspace`, `dockDiffToWorkspace`, `onAuxWindowRetarget` | 16 `openAuxWindow` sites; `CheckpointDiffWindow.tsx`, `ExternalEditorWindow.tsx`, `DiffViewer.tsx` | none | In-app modal (the checkpoint diff) or a same-tab route. "Pop out" opens a new tab on the same route; it is a separate client and needs no dock handshake. `windowClose` in an aux view is "close the modal". |
| 24 | Multiple workspace windows: `createWorkspaceWindow`, `?windowId=`, `restoreDetached` | `WorkspaceManager.tsx:1559,1563,2121` | none | "New window" opens a tab with a fresh `windowId` (3.5) |
| 25 | Window material (glass, tinted vibrancy): `setWindowMaterial`, boot script `navigator.platform` | `index.html:74`, `hooks/useAppTheme.ts:75`, `index.css:4103` | typeof | Forced `solid` on the web. Today a Mac browser gets `glass`: a transparent canvas and a 52% body tint with nothing behind it (E7). |
| 26 | `setColorScheme` (native theme) | `useAppTheme.ts:53` | typeof | No-op; `prefers-color-scheme` already drives "system" |
| 27 | Splash, startup marks: `notifyBootComplete`, `reportBuildStamp`, `startupTimelineEnabled` | `main.tsx` | `?.` | Boot skeleton (3.1); the build stamp is compared with `welcome` (3.5) |
| 28 | Auto-update: `updateGetState`, `onUpdateStateChanged` | boot | none | Not offered; the server's version shows in About, and skew prompts a reload |
| 29 | Deep links (`sprintengine://`) | main | n/a | URL routes: `/w/<workspaceId>/c/<conversationId>` |
| 30 | Third-party module loader: `blob:` import plus appended import map | `modules/third-party-loader.ts:126` | n/a | Specifier rewrite where multiple import maps are unsupported (3.7) |
| 31 | `studio-module://` asset scheme | `modules/renderer-host.ts:1626`, `src/main/modules/module-assets.ts` | n/a | `/modules/<hex id>/assets/…?sig=` (3.7) |
| 32 | Design system and theme | `assets/index.css` imports `design-system/foundations/tokens.css`; `data-theme`, `data-mode` | n/a | Unchanged |
| 33 | Fonts: `@fontsource` Inter and JetBrains Mono; canvas scene fonts | `index.css:6`, `canvasAssetPath.ts:32` | n/a | Unchanged; the server must serve `fonts/` beside `index.html`, else the editor falls back to a public CDN |
| 34 | Monaco and workers (`?worker`, `loader.config({ monaco })`) | `utils/monacoRuntime.ts` | n/a | Works unchanged over HTTP. Recommendation: lazy on the web, see 7.6. |
| 35 | xterm, terminals (`terminalSpawn`, `terminalList`, …; called at boot) | `utils/createStudioTerminal.ts`, boot calls `terminalList`, `onTerminalSessionsDelta` | none | Refused (`terminals` false); boot calls get an empty answer (ruling a) |
| 36 | Voice dictation `getUserMedia` | Removed 2026-10-09 | n/a | Nothing to port: the app no longer asks for the microphone, and the page's Permissions-Policy denies it |
| 37 | Secure-context APIs: `crypto.randomUUID` (4 sites), `navigator.clipboard`, Notifications, service workers | `utils/undeliveredPrompt.ts:50`, `utils/diagnostics.ts:35`, … | n/a | Loopback (`http://127.0.0.1`, `localhost`) is a secure context. Plain HTTP to a tailnet IP is not. One `randomId()` helper over `crypto.getRandomValues` replaces `randomUUID`, and 6.6 requires HTTPS off loopback. |
| 38 | Account sign-in: `authGetState`, `authLogin` (opens a browser and returns through a deep link) | `SidebarAccountBar` (first crash in E3) | none | The login redirect returns to the server's `/auth/callback` instead of the deep link, or account features are hidden on the web in v1 (owner decision 9) |
| 39 | Mesh and tailnet admin (`meshGetLiveState`, `tailnetGetStatus`, …; called at boot) | `WorkspaceActions.tsx` (`remoteGlyphState`) | none | Server members (`auth.*` in phase 8). The Remote glyph shows only for owner sessions. |
| 40 | Canvas worker document | `canvasWorker/transport.ts:40` | `?.` | Loaded by the web client in a hidden same-origin frame to offer `canvas` (3.8). Never server-side |

### 4.2 Keyboard chords browsers reserve

The DOM dispatcher sees a chord only if the browser lets it through. These
defaults collide (registry lines in `commands/commandRegistry.ts`):

| Chord | Command | In a browser tab | Web default |
| --- | --- | --- | --- |
| Primary+W | close pane tab | closes the browser tab; cannot be intercepted | Alt+W |
| Primary+Shift+W | close workspace | closes the window | Alt+Shift+W |
| Primary+N | new chat | new browser window | Alt+N |
| Primary+T (not bound today) | — | new tab | keep unbound |
| Primary+1…9 | switch workspace | switch browser tab | Alt+1…9 |
| Ctrl+Tab, Ctrl+Shift+Tab; Cmd+Shift+[ ] | next/previous pane tab | switch browser tab | Alt+] / Alt+[ |
| Cmd+Alt+←/→ | next/previous workspace | switch tab (Mac) | Alt+Shift+] / [ |
| Primary+` | next workspace | OS window cycling | unchanged in the PWA window; Alt+` in a tab |
| Primary+Shift+P | command palette | private window (one browser) | Primary+K remains |
| Primary+, | settings | browser preferences (Mac) | Alt+, |
| Primary+K, O, D, F, B, Shift+O, Shift+M, Shift+G, Alt+B | various | browser features, but `preventDefault` works for a focused page | unchanged |

- The web profile is a set of default overrides applied when
  `clientSupports('app-menu')` is false. A person's own bindings still win.
- `KbdChord` labels read the effective binding, so the shortcut sheet stays
  correct.
- In an installed PWA window, more chords reach the page, but Primary+W still
  closes it.
- `navigator.keyboard.lock()` is fullscreen-only and not used.
- Synthetic Playwright key events bypass the browser's reservation, so these
  are checked by hand per browser (8.4).

### 4.3 Chat files that bypass `ConversationTransport`

Phase 4 owns moving these behind the transport. Phase 9 depends on it and
verifies it with the missing-member report on the chat route:

| File | Direct members | Web answer |
| --- | --- | --- |
| `AgentChatView.tsx` | `conversationSessionStart`, `conversationProvidersList`, `conversationProviderModels`, `conversationSecretStatus`, clipboard, `platform` | transport `start`, `providers`, `models`, `secretStatus`; clipboard from 4.1 #12 |
| `changedFilesCard.tsx` | `conversationRevertToTurn`, `getGitRepoRoot`, `statPath` | transport `revert`, `repoRoot`, `stat` |
| `editFromHere.tsx` | `conversationRevertToTurn` | transport `revert` (gated by `checkpointRevert`, not only `rewind`) |
| `planCard.tsx` | `conversationPlanDocument` | transport `planDocument`; opens in the in-app viewer |
| `composerContextPicker.tsx` | `searchFiles`, `cancelFileSearch` | transport `mentionSearch` |
| `composerSkillReader.tsx` | `pathExists`, `readdir`, `readfile`, `skillsListSources`, `skillsGetScan` | `files.readText`, `skills.*` |
| `useConversationCommands.ts` | `conversationCommands`, `onConversationCommandsChanged` | transport `commands` stream |
| `useLocalImage.ts` | `statPath`, `readImageDataUrl` | `/api/attachment` signed URL instead of data URLs |
| `conversationLinks.tsx` | `statPath`, `listFolderOpenTargets`, `openFolderInTarget`, `platform` | `stat` via transport; open-in-app hidden |
| `ConversationImage.tsx`, `ToolRow.tsx`, `ComposerAttachmentStrip.tsx` | `openExternal`, `openImageAttachment`, `showItemInFolder` | 4.1 #15, #17, #18 |
| `ConversationCodeBlock.tsx`, `cliSignIn.ts`, `resumeInTerminal.ts` | `terminal*`, `conversationSessionTerminalHandoff`, `conversationProviderSignIn` | hidden without `terminals`; sign-in through `providers.signIn` (parent 6.6) |
| `palette/conversationHistoryProvider.ts` | `conversationThreads`, `conversationSearch` (+ stream) | `conversation.threads`, `conversation.search` |
| `hooks/conversationSessionsStore.ts` | `conversationSessionsList`, `onConversationEvent` (already injectable) | inject the SDK client |
| `CheckpointDiffWindow.tsx` | `conversationTurnDiff`, `conversationToolDetail`, `windowClose` | transport; modal instead of window |
| `NewAgentPanel.tsx` and pickers | `agentLaunchPreview`, `meshBrowse`, `getPathForFile`, `saveDroppedImage`, `defaultWorkspaceParentDir`, `cloneGitHubRepo`, scheduled agents | v1: launch preview, workspace list and the folder browser; scheduled agents and clone are later domains |

## 5. The embeddable conversation view

### 5.1 Layers

```
 @sprintengine/conversation-protocol   (exists; wire types, parsers)
            ▲
 @sprintengine/conversation-timeline   (new; React-free, DOM-free)
   events → projection → rows; session store with cursors, merge, paging
            ▲
 @sprintengine/conversation-view       (new; React 19 peer)
   <ConversationView>, row components, compiled scoped CSS, theme API
            ▲
 /embed/conversation/<id>  (served by the server; iframe; uses the view)
```

- **`conversation-timeline`** takes, unchanged in behaviour:
  - `conversationProjection.ts`, `incrementalConversationProjection.ts`,
    `conversationTimeline.ts`, `sessionEventLog.ts`, `todoProgress.ts`,
    `turnFolds.ts`, `stepDuration.ts`;
  - the shared helpers they import (`shared/conversation/{mentions,
    apiKeySource,subagents}`, `shared/records`, `shared/prompt-cache`);
  - the React-free half of `useConversationSession.ts`, as
    `createConversationFollower(client, ref, { turnLimit })`, which owns
    cursors, merge, urgency tiers, load earlier and retry.

  `stepWentWrong` moves out of `ToolRow.tsx` into the package first; that is
  the one leak. The app imports these from the package, so there is one
  implementation, not a copy. The phone's five pinned protocol files are not
  touched.
- **`conversation-view`** is the read-only subset of today's rows:
  - `TimelineRow` and the user, assistant, work-timeline, decision,
    compaction and command-output rows;
  - `ConversationMarkdown`/`StreamingMarkdown`, `CodeBlock`, `ToolRow`,
    `InlineDiff`, `AnsiOutput`, reasoning, turn meta, subagent status and
    result, resolved plans;
  - `@legendapp/list` virtualization.

  It drops edit, fork, revert, file open, paste in terminal, sign-in and
  plan-to-pane. A transport with `operate: false`, `localFiles: false` and no
  `rewind`/`fork` already hides most of them.
  Its React dependency is a peer. `shiki` languages load lazily. Monaco is not
  a dependency.
- The app's chat view consumes the same row components, so a row fixed once is
  fixed everywhere. The package boundary is enforced by an import-graph test,
  like the server's Electron guard: `conversation-view` may not import
  `window.api`, zustand stores or `@renderer/*` outside itself.

### 5.2 Delivery: component, iframe, web component

| Strategy | For | Auth | Styling | Recommendation |
| --- | --- | --- | --- | --- |
| React component (`@sprintengine/conversation-view`) | apps that already run React and talk to the server through the SDK | the host app's SDK connection (owner token on the same machine, or a paired device) | shadow root by default (5.3) | **v1** |
| iframe (`/embed/conversation/<id>`) | any page, no build step | an embed token (5.4) | the server's own page; theme by `postMessage` or URL | **v1** |
| Web component (`<sprintengine-conversation>`) | non-React apps that want no iframe | as the React component | shadow DOM | later; a thin wrapper over the React view once the two above settle |

The iframe is the security boundary. A third-party page never holds a token
that can do more than read one conversation, and it never sees the
conversation's data except what the iframe draws. The component is for
trusted apps that already hold credentials.

### 5.3 Theming API

- **Isolation.** The rows use Tailwind utility classes. A host app's own
  Tailwind (or any `.flex`) would collide. `<ConversationView>` therefore
  renders into an open shadow root it creates, carrying the compiled
  stylesheet (`adoptedStyleSheets`). `isolation="none"` opts out for hosts
  that want to restyle, with the stylesheet under `@layer sprintengine` and
  scoped to `.se-conversation`.
- **Fonts.** `@font-face` declared inside a shadow root is not applied in
  every browser, so the view injects its `@font-face` rules into the document
  once, under unique family names (`SE Inter`, `SE JetBrains Mono`). A host
  can set `fonts="inherit"` to use its own.
- **Tokens.** The public contract is a small set of custom properties, not the
  internal `--sem-*` names, so internal token renames do not break embeds:

  | Token | Maps to |
  | --- | --- |
  | `--se-bg`, `--se-surface`, `--se-border` | `--sem-color-bg-*`, `--sem-color-border-*` |
  | `--se-text`, `--se-text-muted`, `--se-link` | `--sem-color-text-*`, accent |
  | `--se-accent`, `--se-danger`, `--se-success` | `--sem-color-accent-*`, status |
  | `--se-diff-add`, `--se-diff-remove` | `--sem-color-diff-*` |
  | `--se-font-body`, `--se-font-mono`, `--se-font-size` | `--sem-font-*` |
  | `--se-radius`, `--se-density` (`compact` \| `comfortable`) | `--sem-radius-*`, `[data-density]` |
  | `--se-syntax-*` (optional) | `--sem-syntax-*` (the shiki theme) |

- **Mode.** `theme={{ mode: 'light' | 'dark' | 'system', tokens?: Partial<Record<SeToken, string>> }}`
  sets `data-mode` on the embed root, never on the host's `:root`. One of the
  app's named themes can be picked by id (`theme={{ preset: 'vellum' }}`).
- **Tokens are generated.** The table is generated from
  `design-system/foundations/tokens.tokens.json` by
  `design-system/scripts/build-catalog.mjs`, as `tokens.css` already is.
  It is never hand-edited.

### 5.4 Embed tokens and the iframe

- **Why tokens and not cookies.** A third-party iframe gets no first-party
  cookies: third-party cookies are blocked or partitioned in current
  browsers, and `SameSite=Strict` would refuse them anyway. The iframe
  authenticates with a token.
- **Minting.** An owner (or an app holding `conversation:read` plus a new
  `embed:create` scope) calls `embeds.create`:

  ```
  embeds.create({
    conversationId,
    origins: ['https://dashboard.example.com'],
    ttlMs,
    live: true,
  })
  → { embedId, token: 'mcemb_…', url }
  ```

  The token is stored as a hash. It is read-only, scoped to one conversation,
  and expires (default 24 hours, at most 30 days). It is listed and revoked
  beside devices, and revocation closes its streams with 4401.
- **Delivery.** `url` is `/embed/conversation/<id>#token=…`. A fragment is
  never sent to a server or in a `Referer`. The page reads it, strips it
  with `history.replaceState`, exchanges it at `POST /embed/session` for a
  single-use WebSocket ticket, and opens `/ws?ticket=…`. A host that prefers
  not to put the token in a URL sends it by `postMessage` after `se:ready`
  instead.
- **Framing.** `/embed/*` is served with
  `Content-Security-Policy: frame-ancestors <the embed's origins>`, read from
  the embed record on each load. Everything else keeps `frame-ancestors
  'none'`. An embed with no origins cannot be framed at all; it can only be
  opened as a page.
- **`postMessage` protocol** (`se.embed`, version 1):
  - **iframe → host:**
    - `{ v: 1, type: 'ready', embedId }`
    - `{ type: 'resize', height }`
    - `{ type: 'link', href }`: links open in the host's control, never
      navigate the iframe
    - `{ type: 'state', turns, working }`
    - `{ type: 'error', code }`
  - **host → iframe:**
    - `{ v: 1, type: 'theme', mode, tokens }`
    - `{ type: 'token', token }`
    - `{ type: 'scrollTo', turnId }`
  - **Rules.** The iframe posts only to the embed's registered origins, never
    `'*'`. It accepts a message only when `event.origin` is one of them and
    `event.source === window.parent`. Every message is schema-checked: unknown
    `type` is ignored, unknown `v` is answered with `error: unsupported_version`.
    No message can make the iframe send, respond or navigate.
- **Live or frozen.** `live: true` follows the stream. `live: false` serves a
  snapshot taken at mint time from a static endpoint, for a page that shows a
  finished chat.

### 5.5 Versioning

- `conversation-timeline` declares the conversation protocol window it
  understands and checks `welcome.conversation` on connect. Outside it, the
  view renders one row: "This Studio server speaks protocol X; this view
  speaks Y–Z."
- New event types are additive; the projection already skips unknown types,
  and the view renders an unknown tool kind with the generic tool row.
- The `postMessage` protocol is a new wire and gets a row in
  `docs/compatibility.md` (integer `v`, one version of slack, refusals name
  both).
- `conversation-view` follows semver against its row-component props;
  `conversation-timeline`'s row model (`ConversationTimelineRow`) is public
  API from 1.0. While both are 0.x, the row shape may change, and the
  changelog says so.
- Both get a pack check like `verify-conversation-protocol-pack.mjs` in
  `verify:app`.

## 6. Auth and security model

### 6.1 Threats specific to a browser

| Threat | Why it applies | Control |
| --- | --- | --- |
| Another site drives the server through the person's browser (CSRF, cross-site WebSocket hijacking) | Browsers attach cookies to cross-site requests and WebSocket upgrades | Exact `Origin` check on every upgrade and every non-GET request (6.3); `SameSite=Strict`; no state change on GET |
| **Another local port** drives it | Cookies are **not** isolated by port, and `SameSite` treats `127.0.0.1:3000` and `127.0.0.1:4791` as the **same site**. Any dev server the person runs is same-site. | The Origin check compares scheme, host **and port**. `SameSite` is not relied on between local ports. |
| DNS rebinding | A hostile name resolving to 127.0.0.1 reaches the loopback listener with the hostile page's origin | `Host` must be a loopback name or a configured public origin; `Origin` must equal it |
| Clickjacking | The app framed by a hostile page | `frame-ancestors 'none'` and `X-Frame-Options: DENY` except `/embed/*` (5.4) |
| Cookie clobbering between servers | Several Studio servers on one host's loopback (the desktop's own, WSL forwarded to localhost, SSH tunnels) share one cookie jar for `127.0.0.1` | Cookie name carries the environment: `se_s_<first 12 of environment.id>`. The server ignores cookies with other names. |
| Script injection from transcript content | Markdown, tool output and HTML artifacts are agent-written | `react-markdown` (no raw HTML) as today; HTML artifacts stay in sandboxed `srcDoc` iframes; CSP (6.4) as defence in depth |
| An agent's dev app, shown as a preview, attacks Studio | It is agent-written code running in the person's browser, on the same host as Studio | Its own origin, never Studio's; Studio's cookies stripped from what the preview forwards and Studio-named `Set-Cookie`s dropped; the exact `Origin` rule refuses its requests to Studio; `Cross-Origin-Resource-Policy: same-origin` on Studio's authenticated responses; its own one-time code and cookie (3.6) |
| Token in a URL | History, logs, `Referer`, chat unfurlers | Codes and embed tokens travel only in fragments, are single-use or short-lived, and are stripped from history on load |
| A stolen session cookie | Malware on the client, a shared browser profile | `HttpOnly`; sessions bound to the device record and listed under Devices; revocation closes streams with 4401; idle expiry |

### 6.2 Pairing a browser

- **Loopback, same user.** The desktop's "Open in browser", or
  `studio-server pair`, mints a one-time code (32 random bytes, base64url,
  5-minute TTL, hash only kept) and opens
  `http://127.0.0.1:<port>/pair#code=<code>`.
  1. The `/pair` page reads the fragment, removes it with `replaceState`, and
     `POST`s the code to `/pair/exchange` with `Origin` checked.
  2. The server consumes the code whether the exchange succeeds or not. It
     creates a **browser device** (kind `web`, a name from the user agent the
     person can edit) holding the owner's grants or a narrower set, and sets
     the session cookie.
  3. The page goes to `/`.

  A wrong or expired code shows "This pairing link was used or has
  expired — make a new one in Studio", with nothing more.
- **Another device on the tailnet.** Approval by comparison code, as the phone
  pairs today:
  1. The browser's `/pair` page (reached at the server's HTTPS name, 6.6)
     shows "Pair this browser". The person names it, and the page shows a
     6-digit code.
  2. The person types the code into the desktop's pending-request prompt and
     ticks scopes. Three wrong tries decline.
  3. The page polls `/pair/request/<id>` and receives the cookie once
     approved.

  This is the existing `requestPairing`, `approvePairRequest` and
  `collectPairRequest` flow, with the collect secret held in
  `sessionStorage`.
- **QR.** The desktop shows the `/pair#code=` URL as a QR code with the repo's
  own `src/shared/qr-code.ts` encoder, for a phone browser on the tailnet.
  This is distinct from the phone app's `sprintengine-tailnet://` link, whose
  custom scheme exists so that scanning it in a browser cannot spend the code;
  for the web, spending it in a browser is the point.
- **SSH.** A browser on the person's laptop reaches a remote server through a
  loopback listener the desktop opens on request over the SSH relay (phase 8,
  5.4, which replaced `ssh -L`), so it is a loopback page. `studio-server
  pair` on the remote prints a code; the desktop opens the URL through that
  listener. A preview over SSH is forwarded the same way, one listener per
  preview, so it keeps an origin of its own.

### 6.3 Cookies, CSRF, Origin and Host

- **Cookie.** `se_s_<env>=<32 random bytes>`; `HttpOnly`; `SameSite=Strict`;
  `Path=/`; `Secure` whenever the origin is HTTPS (and on `http://localhost`,
  where current browsers accept it); no `Domain`. Sliding expiry: 30 days
  idle, 90 days absolute (owner decision 7). Stored as a hash on the device
  record.
- **Every WebSocket upgrade and every non-GET request**:
  1. `Host` must be in the allowed set: `127.0.0.1:<port>`, `localhost:<port>`,
     `[::1]:<port>`, plus each configured `--public-origin` host.
  2. `Origin` must equal one of the allowed origins **exactly** (scheme, host,
     port). A missing `Origin` on an upgrade is allowed only with a ticket (SDK
     and other non-browser clients), never with a cookie alone.
  3. The cookie or ticket is resolved to a device, and its scopes are read
     live, per frame, as the tailnet lane does.
- **No CSRF tokens.** The exact `Origin` check on non-GET requests is the CSRF
  defence, and every state change rides the socket or a non-GET request.
  `SameSite=Strict` is the second layer for cross-site requests only.
- **GET is never a state change**, including `/api/attachment/*`, which only
  reads.
- **The tailnet listener today refuses any request with an `Origin`**
  (`tailnet-gateway-server.ts:614`, `:999`), by design: no client of that lane
  is a browser. The phone lane keeps that rule. The web routes are a
  separate handler on the server's HTTP layer with the allow-exact rule
  above. They never share a code path with the refuse-all lane, so the
  phone's guarantee does not weaken.

### 6.4 Response headers for the app page

```
Content-Security-Policy:
  default-src 'self';
  script-src 'self' blob:;            (blob: only when third-party modules are on)
  style-src 'self' 'unsafe-inline';   (Monaco, the canvas editor and React style props)
  img-src 'self' data: blob:;
  font-src 'self' data:;
  connect-src 'self' ws://<host> wss://<host>;   (explicit for older WebKit)
  worker-src 'self' blob:;
  frame-src 'self' blob: <scheme>://<host>:*;   (sandboxed HTML previews; dev-server previews, 3.6)
  frame-ancestors 'none';
  object-src 'none'; base-uri 'none'; form-action 'self'
X-Frame-Options: DENY
X-Content-Type-Options: nosniff
Referrer-Policy: no-referrer
Cross-Origin-Opener-Policy: same-origin
Permissions-Policy: camera=(), geolocation=(), microphone=()
Cross-Origin-Resource-Policy: same-origin   (on every authenticated response, 3.6)
```

- E8 booted the app under `script-src 'self'; style-src 'self'`. The only
  violation was the inline theme script, which 3.1 moves to a file.
- The owner removed the renderer CSP on the desktop (2026-09-27) as a
  standing rule nobody asked for. This policy is for the **served web page
  only**, where any site the person visits is another origin with a path to
  the server. That is a different exposure from a `file://` window. Owner
  decision 2.

### 6.5 Server-side folder browser (`files.browse`)

- Lists directories only, under the owner's home by default, with a typed
  path field and breadcrumbs. Files are never listed or read.
- Requires owner scope or an explicit `files:browse` grant. Tailnet browser
  pairings do not get it by default; they choose among workspaces the server
  already knows.
- Refuses symlink loops, caps entries per listing (1,000, with "more"), and
  hides dot-directories unless asked.
- Reuses `filesystem-search.ts`'s ignore rules for "probably not a project"
  hints (`node_modules`).

### 6.6 Off loopback: the tailnet, proxies and HTTPS

- **Plain HTTP on a tailnet address is not a secure context.** On it:
  - `crypto.randomUUID` is missing (4 call sites throw);
  - so are `navigator.clipboard`, Notifications and service workers;
  - and iOS refuses cleartext by policy.

  The web client off loopback is therefore served over HTTPS or not at all.
- **Recommended route:** `tailscale serve --bg --https=443 http://127.0.0.1:<port>`.
  The server sets this up on request, and `tailscale-serve.ts` already
  drives the CLI. The listener stays loopback-only. The public origin
  `https://<node>.<tailnet>.ts.net` is added to the allowed set. Serve's
  identity headers (`Tailscale-User-Login`, `Tailscale-User-Name`) are not
  read: see the identity bullet in 6.6. Pairing (6.2, approval) is what lets
  a browser in.
- **`tailscale cert`** with the server terminating TLS itself is the fallback
  where serve is unavailable. It needs cert renewal; not v1.
- **Generic reverse proxies.** `--public-origin https://studio.example.ts.net`
  (repeatable) is the only way to add an origin. `X-Forwarded-*` headers are
  ignored unless `--trust-proxy 127.0.0.1` names the proxy. Paths work under a
  prefix because the build uses `base: './'` and the socket URL is resolved
  relative to `location`.
- This makes parent open question 11 a phase 9 decision: tailnet web needs
  HTTPS in the same phase that ships tailnet web (owner decision 1).

## 7. Edge cases

### 7.1 Several tabs and devices on one session

- Each tab is its own client with its own `windowId`. Stream fan-out, command
  ids and receipts are per connection, so two tabs sending at once produce
  two turns in order, with each tab's optimistic echo reconciled by its
  command id.
- One person on a laptop and a phone browser: two devices, two cookies, both
  in the Devices list. Revoking one closes only its streams.
- Notifications: one tab shows each (4.1 #14).
- Drafts are per conversation in `localStorage`. Two tabs editing the same
  draft: the last keystroke wins, and the other tab picks it up on its next
  focus (`storage` event).

### 7.2 Mobile browsers

- The layout today is the desktop layout squeezed: at 390 px the sidebar
  takes 230 px and the chat column is unusable (E6). Mobile already has the
  phone app.
- **Recommendation for v1:** a narrow-viewport chat route (below 640 px: no
  rail, the sidebar as a drawer, the chat full width). It is the same
  components with a layout switch, not a mobile design. Owner decision 5.
- iOS Safari suspends sockets in background tabs. Reconnect on
  `visibilitychange` and `pageshow` (3.5) covers it.
- A preview on a phone is the dev app's own page, so touch is the app's.
- The software keyboard resizes the visual viewport; the composer anchors to
  `visualViewport` height.

### 7.3 Offline and reconnect

- **While disconnected:**
  - The UI shows "Reconnecting…" with the time since the last frame.
  - The composer keeps typing into the draft.
  - Send queues **one** turn with its command id, marked "will send when
    reconnected", and resends it on reconnect. The receipt makes the resend
    idempotent.
  - Approvals cannot be answered offline (the button says so).
- After 10 minutes offline, streams are dropped server-side. Reconnect then
  takes a reset snapshot, which the existing rules handle.
- **A `4409` resync close** reconnects after `retryAfterMs` without
  surfacing an error.

### 7.4 Large transcripts in the browser

- Paging (10 turns, 8 MiB page cap), the 256 KiB frame limit with chunking,
  and the 32 MiB snapshot cap carry over. The SDK reassembles chunks and
  snapshot parts in the browser, as `tailnet-remote-conversations.ts` does in
  main.
- `JSON.parse` of a 256 KiB frame is about a millisecond. The risk is a
  32 MiB snapshot parsed on the main thread: the browser SDK parses snapshot
  parts larger than 1 MiB in a worker.
- Tool output stays out of the snapshot (`toolDetail` on demand) as today.
- **Measured target** (test 8.5): a 2,000-turn fixture opens to the last page
  in under 1 s on loopback and keeps the heap under 300 MB after paging to
  the top.

### 7.5 Service worker

None in v1:

- The page must match its server's version, and a cached shell that outlives
  an upgrade is the skew 3.5 exists to avoid.
- Caching authenticated responses in a worker adds a store to clear on
  revoke.

Hashed assets with `immutable` caching already make a reload cheap. A
manifest (`manifest.webmanifest`, icons) ships so the page can be installed
as an app where the browser allows it without a worker. Installing as an app
also lets more chords reach the page (4.2).

### 7.6 Bundle size

- **Measured (E1):** the eager set is 57 files, 6.32 MB raw, 1.57 MB gzip,
  1.26 MB brotli. All assets: 477 files, 29 MB raw.
- **Monaco's `editor.api` chunk** (2.95 MB raw, 0.73 MB gzip) is eager,
  because `main.tsx` holds the first render on `monacoReady`. The chat route
  needs Monaco only for the checkpoint diff.
- **Recommendation:** on the web, `monacoReady` stops gating the first render
  and loads after it, idle. That roughly halves the bytes before first paint.
  This recommends a load order, not a size gate (the bundle budget gate was
  removed by owner ruling 2026-09-27). Owner decision 6.
- Precompressed brotli at build time; no runtime compression.

### 7.7 Accessibility parity

- Same Chromium engine on the desktop and in Chrome, so the ARIA tree is the
  same for everything in-page.
- **Differences that need work:**
  - The native app menu and the Windows/Linux menubar popup are accessible
    native menus today; on the web, their commands are reachable only
    through the palette and the account menu, which must be complete and
    keyboard-reachable.
  - Browser zoom replaces the Electron zoom roles: layouts are checked at
    200%.
  - Focus must not be trapped by the browser's own chrome on Tab out of the
    last control (it is not; this is a checklist item).
  - The preview pane is the dev app's own DOM in a frame, as accessible as
    the app is; the pane's own controls are checked like any other.
  - The pairing page is keyboard-only and screen-reader complete, including
    the 6-digit code being announced.
- **Automated.** axe-core runs in the Playwright suite on the pairing page,
  the chat route with a fixture transcript, the folder browser and the embed
  page, at both themes. Zero serious violations is the bar.

### 7.8 Feature detection so modules degrade

- **Module renderer code** asks `host.supports(<client capability>)` (3.4,
  3.7). The SDK docs (`docs/module-authors/`) gain a "running in a browser"
  section listing which `RendererHost` members are refused on the web, and
  what the refusal looks like (a rejected promise with
  `UnsupportedOnThisClient`).
- **Bundled modules** degrade the same way and serve as the worked examples.
- **A module that calls a refused member unguarded** gets the rejection, and
  its contribution boundary (`ModuleContributionBoundary`) catches a render
  failure, so one module cannot blank the app.

## 8. Test strategy

### 8.1 Unit

- Session store:
  - cookie minting and hashing;
  - sliding and absolute expiry;
  - revocation closing streams with 4401;
  - cookie name per environment;
  - a foreign-environment cookie ignored.
- `Origin` and `Host` matrix, one table-driven test:
  - each allowed origin;
  - a different port on `127.0.0.1`;
  - `localhost` vs `127.0.0.1`;
  - a rebinding `Host`;
  - a missing `Origin` with and without a ticket;
  - a configured public origin;
  - the dev server origin with and without `--dev`.
- Pairing codes: TTL, single use (a failed exchange still consumes), fragment
  never logged.
- Embed tokens: scope (one conversation, read-only), expiry, origins →
  `frame-ancestors`, revocation.
- `postMessage` handler: wrong origin, wrong source, unknown type, unknown
  version, oversize message.
- Previews (3.6): `previews.list` against a fake `/proc` and a fake `lsof`
  (an agent's listener listed, the server's own and another user's process
  never); `open` refusing a typed port from a non-owner, a port under 1024,
  the server's own port and any non-loopback target; the enter code single
  use and expired at 60 s; requests without the preview cookie answered
  401; every `se_` cookie stripped from a forwarded request; Studio-named
  `Set-Cookie`s dropped; `Host`, `Origin` and `Location` rewriting;
  `X-Frame-Options` and `frame-ancestors` replaced; an upgrade with another
  `Origin` refused; idle close at 30 minutes; a script-set `se_s_` cookie on
  a narrower path not shadowing the real session.
- `createWebApi` type test: `satisfies ElectronApi` with no casts. A unit test
  that enumerates `ElectronApi` keys and asserts each is server-backed,
  shell-backed or an explicit refusal.
- `conversation-timeline`: today's projection and timeline tests move with
  the code. Golden row fixtures for every event type are shared with the
  phone's protocol fixtures.

### 8.2 The missing-member report

The web build in Playwright against a fake server (the SDK's fake transport
answering typed fixtures) walks the chat route:

1. boot;
2. New chat;
3. folder browser;
4. send;
5. stream;
6. approve;
7. revert;
8. @-mention;
9. attach by drop;
10. history search;
11. fork.

It asserts zero calls to refused members and zero `RendererError` logs. This
is the parent's "the shim's missing-member report is empty for the chat route",
made concrete.

### 8.3 End to end

Real server bundle, mock provider, Chromium. WebKit and Firefox run the smoke
subset.

- Pair by fragment URL; the code is gone from `location` and from history.
- A chat round trip: send, stream, an approval, revert.
- Kill the socket mid-turn: reconnect, resume from the cursor, no duplicated
  text (parent phase 4's test, in a browser).
- Two tabs on one conversation stay consistent; a send from each lands once.
- Revoke the browser device from the desktop: the tab closes its streams and
  returns to `/pair`.
- Drag a non-image file onto the composer: it is uploaded, and the agent
  receives a server path.
- Server upgrade while a tab is open: the reload prompt shows; old frames
  still parse.
- The embed page framed by a fixture host on another origin: theme message
  applies; a message from a third origin is ignored; framing from an
  unlisted origin is refused by the browser.
- A preview of a Vite fixture started by a mock agent: the pane loads it, an
  edit on the server reaches the page through hot reload, and a second
  browser context without the enter code gets 401.
- The web client offering `canvas`: an agent's `canvas.edit` on the mock
  provider is answered by the web tab with no desktop attached; the board
  shows the edit in a second tab through `files.watch`; the same with the
  page hidden.

### 8.4 Manual, per browser (a checklist in the PR)

Reserved chords per 4.2 on Chrome, Safari and Firefox on macOS, and on Chrome
on Windows. Synthetic key events bypass the browser's own reservation, so
automation cannot prove these. Also:

- notifications permission flow;
- clipboard on an HTTPS tailnet origin;
- iOS Safari reconnect after backgrounding;
- `tailscale serve` setup and identity headers.

### 8.5 Performance

- The 2,000-turn fixture: first-page time and heap after paging to the top
  (7.4).
- Cold load of the app on loopback with an empty cache: time to first
  contentful paint and to an interactive composer, with and without lazy
  Monaco. These are recorded, not gated.

### 8.6 Security regression

Each a test that fails if the control is removed:

- a cross-origin WebSocket upgrade with a valid cookie is refused;
- a `POST` from another local port is refused;
- `Host: rebind.example` is refused;
- `/` is served with `frame-ancestors 'none'`;
- `/embed/*` is served with the embed's origins only;
- the tailnet phone lane still refuses any `Origin`.
- a page on a preview origin cannot open `/ws` or `POST` to Studio, even with
  Studio's cookie in the jar;
- a preview's dev server never receives a `se_` cookie, and cannot set one;
- Studio's authenticated responses carry `Cross-Origin-Resource-Policy:
  same-origin`, so a preview cannot embed them;
- a preview listener answers nothing without its own cookie.

## 9. Experiments and results

All run on 2026-10-01 against `origin/feat/studio-agent-sdk` at `5fd954b19`,
with scratch scripts outside the tree. No product code was changed.

| # | Experiment | Result |
| --- | --- | --- |
| E1 | Build `src/renderer/index.html` with plain Vite 8 (React, Tailwind, a stub build stamp), `base: './'`, no electron-vite | Builds in 2.3 s. 477 assets, 29 MB raw. Eager set: 57 files, 6.32 MB raw / 1.57 MB gzip / 1.26 MB brotli, of which Monaco's `editor.api` is 2.95 MB raw. Largest lazy chunk is `ts.worker` at 6.9 MB. Served statically from any path with no 404s. The canvas fonts plugin was not included; it is needed for `fonts/`. |
| E2 | Load it in Chromium with **no** `window.api` | Blank page. One warning ("Workspace sync API is unavailable"), then `TypeError: Cannot read properties of undefined (reading 'isDevelopment')` in `WorkspaceManager`'s `useMemo`. With no root error boundary, the whole tree unmounts. |
| E3 | A catch-all proxy `window.api`: every member a function returning a real promise of `null` (and callable as an unsubscribe) | The third-party module loader fails (caught, logged), then `SidebarAccountBar` reads `.user` of `null` and the app blanks again. |
| E4 | The same proxy returning `[]` or `{}` by name, plus hand-typed shapes for eight members (`authGetState`, `tailnetGetLiveState`, `meshGetLiveState`, `tailnetGetStatus`, `listThirdPartyRendererEntries`, `listDesignSystemArrivals`, `defaultWorkspaceParentDir`, `hostsList`; the last two are reached from New chat) and the four preload values | Boots to the shell ("No workspace open", New chat). **Boot touches 79 members and calls 67**, including terminals (`terminalList`, `setTerminalIdleSuspendMs`), window placement, the app menu, auto-update, tailnet and mesh state, scheduled agents, design-system arrivals, hosted card feed, plugins, CLI version advisories and workspace backup. Each is a v1 decision: server-backed, shell fallback or refusal. |
| E5 | Click New chat, then Choose a project, then Browse… | New chat calls `hostsList`, `defaultWorkspaceParentDir`, `onHostsChanged`. Browse… calls `openDir`; its non-string reply crashes `newChat…` with `e.split is not a function` and blanks the app. The folder picker is `openDir`, and its replacement is the first thing a web user hits. |
| E6 | 390 × 844 viewport | No horizontal overflow, but the desktop layout is squeezed: the sidebar takes about 230 px; the chat column is unusable; the 78 px traffic-light reserve shows because `platform` said `darwin`. |
| E7 | Computed styles at boot in a browser on macOS | `data-window-material="glass"` (from `navigator.platform`), `html` background transparent, `body` a 52% tint. On the desktop that sits over vibrancy; in a browser it sits over nothing. |
| E8 | Serve with `script-src 'self'; style-src 'self'; worker-src 'self' blob:; frame-ancestors 'none'` | The app boots. The only violation on the boot path is the inline theme script (it reports its sha256), so the first frame has no theme until React applies it. Monaco, the canvas editor and the third-party loader were not exercised under it; they are expected to need `'unsafe-inline'` styles and `blob:` scripts (6.4). |

**Not tested, and why:**

- Firefox and WebKit: only Chromium was installed.
- Browser-reserved chords: synthetic events bypass the reservation.
- A real server: none exists yet; the stubs stood in for it.
- Secure-context behaviour on a tailnet IP: it follows from the platform
  rule, not from a run.

## 10. Risks and mitigations

| Risk | Likelihood / impact | Mitigation |
| --- | --- | --- |
| One malformed server reply blanks the whole app (E2–E5) | High / high | A root error boundary with a "reload" surface, and per-surface boundaries around the sidebar, chat and pane, before anything else in this phase |
| 103 unguarded `window.api` files; refusals surface as crashes far from the chat route | High / medium | A typed shim whose refusals reject instead of being absent; the missing-member report in CI; capabilities instead of `typeof` |
| `platform` conflation gives Windows browsers Mac shortcuts against a Mac server, or the reverse | Certain without the split / medium | 3.3, done early |
| Local-port same-site: any local dev server can reach a cookie-authenticated loopback server | Certain without exact Origin / high | 6.3: exact `Origin` incl. port on every upgrade and non-GET; tested (8.6) |
| Cookie collisions between the local, WSL and tunnelled servers on `127.0.0.1` | Likely / medium | Cookie name per environment id |
| Tailnet over plain HTTP is not a secure context: clipboard, notifications and `randomUUID` break | Certain / high | HTTPS through `tailscale serve`, or no tailnet web in v1 (owner decision 1) |
| A previewed dev app (agent-written) reaches Studio's session or API | Low with the controls / high | Its own origin, cookie stripping both ways, the exact `Origin` rule, `Cross-Origin-Resource-Policy`, its own one-time code (3.6); the security regressions in 8.6 |
| A dev app with absolute `localhost` URLs breaks in a preview from another device | Likely / low | Stated in the pane's help; works from a browser on the server's machine; "Open in the desktop app" where a desktop is attached |
| With only web clients attached, agents have no browser | Certain / medium | The ruling's intent (no browser in the server, none a page can offer). Agents get `canvas` from the web client; `browser.*` answers `client_unavailable` naming the fix (phase 5) |
| A hidden web tab answers `canvas` calls slowly | Medium / low | Calls ride socket messages, which are not throttled; the worker waits on no frame or timer; routing prefers a visible client (3.8) |
| Third-party renderer modules rely on multiple import maps | Certain on Firefox/Safari / low in v1 | Off by default on the web; specifier rewrite when turned on |
| The embed's shadow-DOM styling meets fonts and portals (popovers rendered to `document.body`) | Medium / low | Fonts injected in the document under unique names; portals target the shadow root; tests at both themes |
| Extracting the timeline package churns the chat view | Medium / medium | Move files with no behaviour change first (tests move with them), fix the `stepWentWrong` leak, then point the app at the package |
| Scope: two packages and an iframe route on top of the web client | High / schedule | The embed lands after the web client, as its own commits (11), and can ship a release later without blocking the web client |
| Monaco eager on the web delays first paint on slow links | Medium / low | Lazy on the web (owner decision 6) |

## 11. Breakdown into reviewable commits

On `feat/studio-agent-sdk`, after phases 4 (chat over the protocol) and 5
(client tools, and the `files` subset boards are kept through) have landed. Each commit leaves `npm run verify:app`
green.

**A. Make the renderer safe to run elsewhere** (desktop-visible, behaviour
unchanged)

1. `fix(renderer): a root error boundary so one failed surface cannot blank the window`
2. `refactor(renderer): separate the client's platform from the host's`. This
   adds `clientPlatform` and `hostPlatform` and classifies the 53 references.
3. `refactor(renderer): client capabilities instead of typeof checks on window.api`.
   This adds `clientSupports()`; the desktop sets all of them; call sites on
   the chat route are converted.
4. `refactor(renderer): the theme boot script is a file, and the traffic-light reserve asks for window controls`
5. `refactor(chat): move stepWentWrong out of the tool row so the timeline is pure`

**B. The web build and the server serving it**

6. `build(renderer): a shared renderer Vite config and a web build target`
   (`build:web`, `out/web`, precompression, `STUDIO_CLIENT` define, manifest,
   boot skeleton; CI builds it)
7. `feat(server): serve the web client with its cache and security headers`
   (static routes, CSP, frame headers, SPA fallback, dev proxy)
8. `feat(server): browser sessions, origin and host checks`
   (session store, cookie per environment, the exact-Origin rule, Devices
   listing kind `web`; tests from 8.1 and 8.6)
9. `feat(server): pair a browser with a one-time link or by approval`
   (`/pair`, `/pair/exchange`, approval polling, `studio-server pair`, the
   desktop's "Open in browser" and QR)

**C. The web shell**

10. `feat(renderer): the web window.api — server-backed members and explicit refusals`
11. `feat(renderer): browser fallbacks for clipboard, links, notifications and attachments`
12. `feat(renderer): a server-side folder browser replaces the native folder picker`
    (with `files.browse` on the server)
13. `feat(renderer): drop and upload files without a local path`
14. `feat(renderer): tabs as windows — per-tab window ids, reconnect and the reload prompt`
15. `feat(renderer): a keymap profile for chords browsers keep`
16. `feat(server): previews of a dev server on an origin of its own`
    (`previews.list/open/close`, the per-preview listener, the one-time code
    and cookie, cookie stripping, `Host`/`Origin` rewriting, WebSocket
    pass-through, frame headers, `tailscale serve` ports for tailnet origins,
    `Cross-Origin-Resource-Policy` on Studio's responses; tests from 8.1 and
    8.6) and `feat(renderer): the preview pane` (port picker, sandboxed frame,
    open in a new tab)
17. `feat(renderer): the web client offers the canvas toolset`
    (the worker entry in the web build, the portable canvas service in the
    page over `files.*`, `tools.offer` from owner sessions, focus and
    visibility, the canvas suite run through it, page hidden included)
18. `feat(renderer): a narrow layout for the chat route` (if owner decision 5
    says yes)
19. `feat(modules): module assets over HTTP and capability checks on the web`
    (third-party entries gated per owner decision 4)
20. `test(web): the missing-member report and the end-to-end suite in CI`
21. `feat(server): HTTPS for the web client through tailscale serve`
    (if owner decision 1 says v1)

**D. The embeddable view**

22. `refactor(chat): the conversation timeline as a package`
    (`@sprintengine/conversation-timeline`, files moved unchanged, the app
    imports it, pack check)
23. `feat(conversation-view): the read-only conversation view as a React package`
    (row components, compiled scoped CSS, generated `--se-*` tokens, shadow
    root, pack check)
24. `feat(server): embed tokens and the iframe conversation view`
    (`embeds.create/list/revoke`, `/embed/conversation/<id>`, per-embed
    `frame-ancestors`, the `postMessage` protocol)
25. `docs: the web client, embedding a conversation, and the embed wire in compatibility.md`

Sizes: A is S, B is M, C is L (16 and 17 are M each), D is M. The
parent's "Phase 9 (M)" is low; with the embed this is L.

## 12. Changes the overall design needs

1. **§9.1/§9.4 — the tailnet Origin rule.** The tailnet lane refuses any
   request with an `Origin`. Browser routes must be a separate handler that
   allows exactly the server's own origins. The phone lane keeps refuse-all.
   Say so, or "a browser on another tailnet device pairs like the phone"
   reads as possible on the existing listener, and it is not.
2. **§9.2 — `SameSite=Strict` is not a port boundary.** Local ports are the
   same site. The exact-Origin check (scheme, host, port) on every upgrade and
   non-GET request is the CSRF control. Cookies need a per-environment name,
   because every server reachable on `127.0.0.1` shares one jar.
3. **§9.4, §15 q11 — HTTPS is a precondition for tailnet web**, not a later
   option: plain HTTP to a tailnet address is not a secure context. Either
   phase 9 ships `tailscale serve` HTTPS, or tailnet web moves out of v1.
4. **§11 — `platform` is two facts** (client and host). Add the split to 5.5's
   list of what the shell keeps.
5. **§11 — clipboard and `openExternal` are client-side on every client**, not
   only the web. A desktop attached to a remote server must not call the
   server's clipboard or open URLs on the server's screen. The IPC-backed
   members move to the shell list in 5.6.
6. **§11 — the guard count.** It is 56 files with `typeof`, 88 with any guard,
   103 with none. And there is no root error boundary, so "degrades rather
   than throws" is not true today. Phase 9 starts with the boundary and a
   typed shim.
7. **§8, §15 q5 — superseded by the owner ruling of 2026-10-02.** This asked
   for the pane to be a screencast on every client. There is no server
   browser: the desktop's pane is the `browser` toolset on every route, the
   web client shows `previews` (3.6) and offers no `browser` in v1. The parent
   keeps "agent browser tools act on the person's pane" (it is now the only
   path). That mouse input bumps the epoch stands, as a rule of the desktop's
   pane (decisions R39).
8. **§5.4 — the SDK must run in a browser** (no Node built-ins, WebSocket
   only), and accept a ticket in the URL for clients that cannot set headers
   (the embed). A same-origin web tab authenticates by cookie and needs no
   ticket.
9. **§5.2 — new namespace `embeds`** (`create`, `list`, `revoke`; owner or
   `embed:create`). **New wire:** the embed `postMessage` protocol, a row in
   `docs/compatibility.md`.
10. **§13 phase 9 — size L, not M,** and it depends on phase 5's client
    tools and `files` subset (for the web `canvas` toolset), not on a
    screencast. The embed packages are their own commit group.
11. **§7.2 — client-owned state on the web** lives in `localStorage` per
    origin. The same server reached by two routes (loopback and its tailnet
    HTTPS name) is two origins with separate drafts. That is acceptable, and
    should be stated.
12. **§5.2, §8 (2026-10-02) — a `previews` namespace** (`list`, `open`,
    `close`, a `changes` topic; owner or `previews:open`), each preview on a
    listener and an origin of its own (3.6). §9.4 gains `previews:open` as a
    family tailnet pairings do not get by default.
13. **§6.3, §8 (2026-10-02) — the web client offers `canvas`** from an owner
    session with `kind: 'web'` (3.8), settling the web row of phase 5 §7.2.

## 13. Owner decisions

| # | Question | Recommendation |
| --- | --- | --- |
| 1 | Tailnet web in v1, which requires HTTPS through `tailscale serve`; or loopback and SSH-forwarded only in v1? | **Ship it with `tailscale serve`** (commit 21). The phone already proves tailnet use; plain HTTP is not an option. |
| 2 | A Content-Security-Policy on the **served web page** (6.4), given the desktop's was removed on 2026-09-27? | **Yes, web only.** The exposure differs: other sites in the same browser are one origin away. |
| 3 | Embed scope: read-only in v1, or also answer approvals and send? | **Read-only.** Operating from inside someone else's page needs its own threat model. |
| 4 | Third-party renderer modules on the web in v1? | **Off by default**, a per-server owner switch to turn on. Bundled modules load. |
| 5 | A narrow layout for the chat route on phones' browsers in v1, given the phone app exists? | **Yes, the chat route only** (drawer sidebar, full-width chat). No other surface is reworked. |
| 6 | Load Monaco lazily on the web (not a size gate)? | **Yes.** The chat route needs it only for the checkpoint diff. |
| 7 | Browser session lifetime | **30 days idle, 90 absolute**, listed and revocable with devices |
| 8 | Embed delivery | **iframe and React component in v1**; the web component later |
| 9 | Account sign-in (`authGetState`, `authLogin`) on the web | **Hidden in v1.** Nothing in chat needs it, and its deep-link return needs a redirect route designed with the account service. |
| 10 | Web keymap: remap the reserved chords to Alt-based defaults (4.2)? | **Yes**, as default overrides a person can change |
| 11 | Package names `@sprintengine/conversation-timeline` and `@sprintengine/conversation-view`, or fold the timeline into the protocol package? | **Separate packages.** The protocol package stays types and parsers, which the phone pins. |
| 12 | Service worker | **None in v1**; a manifest only |
| 13 | How the web client shows an agent's dev server (3.6) | **`previews`**: a listener and an origin per preview on the server's loopback, its own one-time code and cookie, Studio's cookies stripped, WebSocket upgrades passed through; offered ports are the agents' listeners plus an owner-typed port, never Studio's own |
| 14 | The web client offers `canvas` (3.8) | **Yes, from owner sessions** (`kind: 'web'`); never from a tailnet browser pairing in v1 |

## 14. As built

Where building phase 9 forced a change to the sections above, the change is
recorded here, with the commit that made it.

### 14.1 The web listener (2026-10-03)

- **Off unless asked for.** `studio-server serve --web` starts the listener on
  `127.0.0.1:4791` (`--web-port`, 0 picks one). It binds loopback only.
  `--public-origin https://…` (repeatable) adds the HTTPS name a proxy serves
  it under, such as `tailscale serve`'s; an `http://` public origin is
  refused at start (R19). The desktop's own server does not start it.
- **Session lifetime is R18's, not 6.3's:** 30 days from pairing, absolute,
  with no sliding window.
- **`studio-server pair`** reads `run/web.json` (0600 in the owner-only
  `run/`), which the running listener writes with its port, origins and a
  per-run key, and posts the key to `/pair/mint` with no `Origin`. A browser
  cannot send that request (it always sends `Origin` on a POST, and it cannot
  read the file), and the listener refuses the route when `Origin` is
  present. `--origin` prints the link on a public origin instead. The server
  does not print a pairing link at start: stderr may be a service's log.
- **Tailnet pairing by approval (6.2, the six-digit flow) is not built.** A
  browser on another tailnet device pairs with a one-time link minted for the
  public origin (`studio-server pair --origin https://<node>.ts.net`). A
  session paired on a public origin is never an owner session and never holds
  `tools:offer`, whatever the code was minted for.
- **Two sockets per tab, not one.** `/ws` carries the Studio protocol as
  specified. `/ws/ipc` carries the `window.api` domains the server owns, over
  the same IPC tunnel a desktop window uses when its server runs out of
  process (phase 6, 6.2), as JSON frames. It admits owner sessions only, since
  the tunnelled handlers have no scopes of their own. It goes away with the
  tunnel, when phase 10 empties `SERVER_IPC_CHANNELS`. This is what the
  parent's `createServerBackedApi` is on the web until then.
- **A cookie-authenticated socket's hello** carries a placeholder credential;
  the session cookie, checked with the exact `Origin` at the upgrade, is the
  proof, and the connection's authenticator reads the session live (a revoked
  or expired session is refused on its next frame, and its sockets are closed
  with 4401 at once). An owner's tab is served as Studio's own view
  (`ownWindow`): unredacted, with a window's request bounds.
- **App routes.** Only `/` serves the app. Deep routes
  (`/w/<id>/c/<id>`) are not built; `/api/*` and `/ws*` that match nothing
  answer 404 rather than the app.
- **The folder browser (6.5)** is a tunnelled channel, `web:browse-folders`,
  that only a web tab's tunnel registers, rather than a `files.browse`
  protocol method: an owner session is the only caller in v1, and it becomes a
  method when the file domain moves in phase 10.

### 14.2 The web build and the web `window.api` (2026-10-03)

- **`npm run build:web`** builds `vite.web.config.ts` into `out/web/`, on the
  renderer config the desktop build shares (`renderer.vite.config.ts`). It
  builds `index`, `pair` (the pairing page, standalone) and `canvas-worker`,
  and precompresses with brotli and gzip. CI builds it beside the desktop.
  The server finds it at `out/web/` beside `out/server/` (`--web-root`
  overrides). Not built: the boot skeleton, the web manifest, the dev-server
  proxy (`--dev`).
- **How the tab's `window.api` is installed.** Not by `STUDIO_CLIENT` alone:
  an `import` of the shim from `main.tsx` is bundled into the app's entry
  chunk, whose imports of shared chunks evaluate first, and the workspace
  store reads `window.api` as its chunk loads. The web build makes the shim
  an entry of its own (`web/installWebApi.ts`) and puts its module script
  ahead of the app's in `index.html`; module scripts run in document order,
  each graph whole. `STUDIO_CLIENT` remains, read where only a build can know
  (the Electron paste bridge is not bound in a browser).
- **`createWebApi`** spreads the preload's own api modules
  (`src/preload/api-surface.ts`), whose IPC in the web build is the tab's
  router (`web/webIpcRouter.ts`, swapped for `src/preload/ipc-router.ts` at
  build time, as `electron` is swapped for a stand-in). The router is the
  desktop's out-of-process router: a channel in `SERVER_IPC_CHANNELS` goes
  over `/ws/ipc`, and every other channel is refused with
  `UnsupportedOnThisClient`, noted once per channel (the missing-member
  report, `window.__studioWebRefusals()`). Members a browser can do are
  replaced, typed: the clipboard and links (R56), `openDir` (the folder
  browser), the Studio ports (over `/ws`), "New window" (a new tab), and the
  empty states the boot reads (no terminals, no window placement, signed out,
  no third-party renderer entries (R61), no shell caches).
- **Tabs and windows (3.5).** A plain tab is the server's `primary` workspace
  window, as the desktop's first window is, so every plain tab shows the same
  workspaces. "New window" opens a tab whose address carries a window id of
  its own (`?windowId=`), which the renderer and the tunnel both read, and a
  reload keeps. Minting a fresh id per tab would leave every new tab with an
  empty sidebar.
- **Reconnect** follows 3.5: the tunnel and the protocol client reconnect
  with backoff, and at once on `online`, visible and `pageshow`. A 4401 close
  returns the tab to `/pair`.

### 14.3 Platforms and client capabilities (2026-10-03)

- **`platform` stays, and means the client.** Rather than rename 53
  references, `window.api.platform` is documented as the client's OS (the
  browser's, in a tab) and `window.api.hostPlatform` is added for the
  server's. The host-side reads (paths and their case rules, "Reveal in
  Finder/Explorer", CLI hints and install commands, the WSL rules, terminals'
  paths, the local machine's label) go through `hostPlatform()`; the keyboard,
  modifier and window-chrome reads keep `platform`. The served page carries
  the server's OS in a meta tag, which the tab's shim reads at install.
- **`clientSupports()`** reads `window.api.clientCapabilities`; a `window.api`
  that does not declare them (an older preload, a test's stand-in) is a
  desktop window's. Converted in this pass: the window chrome (traffic-light
  reserve, caption buttons, the menubar button, window material), the New
  chat roster (no Agent or Terminal rows without `terminals`), paste and
  resume in a terminal, and reveal in folder on the chat route. The rest of
  the `typeof window.api.X` guards are unchanged; on the web their members
  exist and refuse.

### 14.4 Previews (2026-10-03)

- **Tunnelled channels, not a `previews` namespace.** `previews.list`,
  `open` and `close` are `web:previews:*` channels on a web tab's tunnel, with
  `web:previews:changed` pushed to the session's tabs, for the reason 14.1
  gives the folder browser: only an owner's tab calls them in v1, which is
  R77's "owner sessions". A `previews:open` grant for tailnet pairings comes
  with the protocol namespace.
- **The listener checks `Host`** as Studio's does: a request that names
  another host is answered 421 before the cookie is read.
- **Ports.** `list` walks the server process's own descendants (the agents'
  CLIs and what they started); an owner may type any port from 1024 that is
  not one of the server's. Opening a port the session already previews
  returns that preview with a fresh entry code.
- **The pane.** Where a desktop window shows its browser pane, a tab whose
  shell has `previews` and no `browser-pane` shows the preview pane: a port
  picker (and a typed port), the path field, Reload and "Open in a new tab".
  Not built: "Open in the desktop app", and HTTPS ports through
  `tailscale serve` for a preview reached off loopback.

### 14.5 The embed (2026-10-03)

- **Built:** embed tokens (`mcemb_…`, kept as a hash, one conversation by
  workspace and agent, read-only, 24 hours by default and 30 days at most,
  revocable, closing their sockets with 4401); the iframe route
  `/embed/conversation/<id>`, whose `frame-ancestors` is read from the embed
  on every load (none: it cannot be framed); `POST /embed/session`, trading
  the token for a single-use ticket; the `postMessage` wire with its row in
  `docs/compatibility.md`; and `studio-server embed`, which mints one from the
  command line (`--list` and `--revoke <id>` added in review, so an embed
  made anywhere can be seen and taken back). An owner's tab can create, list and revoke embeds over its
  tunnel (`web:embeds:*`), as 14.1 says of the folder browser; there is no
  Settings surface for them yet.
- **Held three ways.** The socket's grant is `conversation:read` and not an
  owner's, so the router refuses every write and redacts what it reads; a
  gate on the socket passes only `hello`, `unsub`, the one conversation's
  `conversation.session` stream and its `loadEarlier`, `toolDetail` and
  `turnDiff`, by workspace and agent and never by folder, and closes the
  socket on anything else; and the embed expires.
- **The packages are in 14.10.** The iframe page draws with the app's own
  rows, under a read-only transport, so a row fixed in the chat is fixed in
  the embed; the theme message carries the mode alone.
- **Not built: frozen embeds** (`live: false`); asking for one is refused.

### 14.6 The browser keymap (2026-10-03)

As 4.2 says, with these as built: the swaps are applied where a command's
defaults are read (the dispatcher, the effective-binding labels, the shortcut
sheet and its conflict check), keyed on `clientSupports('app-menu')`; a
person's own binding still wins. `Primary+Shift+P` is dropped rather than
swapped (the palette keeps `Primary+K`), and the next and previous workspace
chords become `Alt+Shift+]` and `Alt+Shift+[`. The installed-app (PWA) case
keeps the same swaps, since the browser's own window still takes
`Primary+W`.

### 14.7 The web client's `canvas` (2026-10-03)

- **As 3.8, with these as built.** An owner's tab, once the app has loaded,
  opens a Studio connection of its own (`kind: 'web'`) and offers `canvas`
  with the desktop's tool definitions, answered by the portable canvas
  service running in the page over the server's `files.*` (boards followed
  with `files.watch`). The worker is the bundle's `canvas-worker.html` in a
  hidden same-origin frame, spoken to over `postMessage` (each end accepts
  only the other's window on its own origin); the listener serves that page
  with `frame-ancestors 'self'` and `X-Frame-Options: SAMEORIGIN`, every other
  page keeping `'none'`. The service's two Node imports are swapped at build
  time for browser stand-ins (a synchronous SHA-256, since Web Crypto's digest
  is asynchronous, and POSIX paths); the board filesystem no longer uses
  `Buffer`. The toolset is withdrawn on `pagehide` and offered again on a
  restored `pageshow`, and `tools.focus` follows the tab's visibility.
- **Not built here; the Canvas pane is in 14.16.** Export to a local folder; the canvas module's enable switch, read
  as on; the canvas suite run through the web toolset, and the hidden-tab
  test.

### 14.8 What an owner's tab reaches, and the audit (2026-10-03)

- **An allow-list, held on both sides.** An owner's web tab reaches the
  tunnelled domains the web client draws: workspace sync and the registry,
  launch settings, machines, the chats (`conversation:*`), command lists,
  model discovery, backlog files, workspace backups, the automation status,
  and the reads `credential:secrets:status`, `github:token-status`,
  `github:list-repos`, `scheduled-agents:list` and `mark-seen`. It does not
  reach, and the desktop app alone offers: pairing local apps
  (`studio-local-apps:*`), the tailnet lane's administration (`tailnet:*`),
  other machines (`mesh:*`), setting or clearing provider keys
  (`conversation:secrets:set`/`clear`, `credential:secrets:set`/`clear`),
  the GitHub token and clone, a provider's CLI sign-in, terminal hand-off,
  scheduled agents' changes (they launch terminals), and the module bridge.
  The spec names none of these for the web client, so v1 keeps them on the
  desktop. The tab's router sends only allowed channels to the tunnel (the
  rest are refused in the page and land in the missing-member report); the
  server answers any other channel `DesktopOnly` before a handler sees it
  (`src/shared/web-client.ts`, `src/server/web/web-tunnel-guard.ts`).
- **Audited as a client.** An owner's tab is Studio's own view (unredacted,
  a window's request bounds), but a client of the server all the same: its
  protocol mutations are audited (`audited` on the connection), and so is
  every tunnel call that changes something, under `web:<session>` and the
  browser's name.
- **JSON, out loud.** A value JSON would change (a `Date`, a `Map`, bytes,
  `NaN`, a hole in a list) is refused where it is sent: in the tab, the call
  that carried it fails; on the server, a result becomes the failed call it
  is and a push is dropped with a log line naming the member.
- **Subscriptions survive a reconnect.** The router keeps the window's live
  conversation subscriptions and makes them again on each new port, in a
  desktop window whose out-of-process server restarted as in a tab whose
  socket came back.

### 14.9 Devices, and pairing by approval (2026-10-03)

- **Settings → Remote → Browsers**, in an owner's tab: every paired browser,
  with where it paired from, when it was last seen and when its pairing ends,
  and Remove, which closes its connections at once (a removed tab goes back
  to `/pair`). "Pair another browser" makes a one-time link on one of the
  server's origins, shown as text and as a QR code (the repo's own encoder).
  Pending requests wait here.
- **Pairing by approval (6.2)**, as specified, with the owner's prompt in
  that Settings section rather than the desktop's: the pairing page asks
  (`POST /pair/request`, the exact-Origin rule applies), shows six digits,
  and polls `POST /pair/request/collect` with a secret only it holds, kept in
  the tab's session storage; the owner types the digits; three wrong tries
  decline; a request lives five minutes; eight wait at most. The session is
  handed over once, with the cookie, on the first poll after approval.
- **A browser paired over the tailnet is the owner's** (it reaches the
  tunnel's allow-list, 14.8), because a session without the tunnel cannot
  run the app at all. What 6.5, R77 and R79 withhold from tailnet pairings is
  held where it is served: such a session never holds `tools:offer`, opens no
  preview, and browses no folders (it chooses among the workspaces the server
  knows). The pairing-link route keeps the same rule.
- **The tailnet lane's and local apps' Settings are the desktop's**: a tab
  hides them (`clientSupports('tailnet-admin')`, a capability added for it).
- **Not built: "Open in browser" on the desktop.** The desktop's own server
  runs no web listener (in process it cannot, and out of process it is not
  composed with one), so there is no link for it to open; the Browsers
  section is where a link and its QR code are made.

### 14.10 The timeline and view packages (2026-10-03)

- **`@sprintengine/conversation-timeline`** holds the projection, the
  incremental projection, the timeline, the session event log, the todo
  progress, the turn folds and step durations, moved unchanged with their
  tests, and the helpers they read (records, mentions, the API-key source,
  the prompt cache, subagents, and the two attachment types). The app's old
  paths are one-line re-exports, so there is one implementation.
  `stepWentWrong` moved out of the tool row first (`stepOutcome.ts`). Its
  types are the conversation protocol's; `presentToolItem` and its kin are
  now exported from that package's entry (the phone's pinned files are
  unchanged). It adds `createConversationFollower`, the non-visual half of a
  view over any source that follows a conversation (an agent SDK client's
  `conversations`), and the protocol window check of 5.5. Not extracted: the
  app's own session store in `useConversationSession.ts`, which the app keeps;
  the follower is a new, smaller one for other clients.
- **`@sprintengine/conversation-view`** is a React component over the
  follower, read-only, in a shadow root it makes (or under `@layer
  sprintengine` with `isolation="none"`), themed through `--se-*` tokens. Its
  rows are its own compact ones, not the app's: the app's rows depend on
  Studio's design system, Monaco-free but not Tailwind-free, and drawing them
  outside the app is a larger move. Prose is drawn as React elements from a
  small markdown subset, never as HTML. The token defaults are the semantic
  tokens' values at release, written in the package rather than generated.
- Both have a build, a README, a changelog and a pack check
  (`test:studio-packages:pack`, which also compiles the view's example
  against the packed tarballs), and an import-graph test. `docs/embedding-a-conversation.md`
  covers the iframe and the component.

### 14.11 The reload prompt (2026-10-03)

- **What is compared** is the web bundle, not the server's commit. The web
  build writes one id (the commit and a nonce) into every page as
  `<meta name="sprintengine-web-build">`; `/api/session` answers the id of
  the `index.html` served now, re-read when the file changes. A commit
  comparison would miss a rebuild of the same commit, whose chunk names
  differ, and would prompt for ever, reload or not, when the server and its
  web bundle were built from different commits. The welcome frame and the
  Studio protocol are unchanged.
- **When the tab asks:** when its tunnel opens again after a drop (the
  router dispatches `sprintengine:web-tunnel-reopened`), when the page comes
  back online, visible or out of the back/forward cache, and every ten
  minutes while it is seen. It offers once per new bundle.
- **The prompt** is the app-update toast's browser form, recorded in the
  toast's component.md: "Studio was updated", Later and Reload, kept until
  answered.
- Verified in Chromium: a tab open while `build:web` rewrote the bundle
  showed the toast on its next check, and Reload loaded the new bundle.

### 14.12 `tailscale serve` (2026-10-03)

- **`studio-server serve --web --tailscale-serve [--tailscale-serve-port <n>]`**
  asks tailscaled to publish the loopback listener at
  `https://<node>.<tailnet>.ts.net` (port 443 unless asked otherwise) with
  `tailscale serve --bg --https=<n> http://127.0.0.1:<port>`, through
  `tailscale-serve.ts`. The listener stays on loopback and nothing is ever
  published as plain HTTP or through funnel (R19). The published name joins
  the listener's origins and the run file's, so `studio-server pair --origin`
  and the Browsers settings' link work on it.
- **Serve's configuration is not this server's to replace.** A port already
  serving something else stops the start, with the `tailscale serve ... off`
  command that frees it; the dev-server shares' ports (8443, 10000, ...) are
  refused outright. The one exception is this server's own mapping from an
  earlier run, recorded in `run/web-tailscale.json`, which a crash leaves
  pointing at a port the listener no longer holds. A clean stop turns the
  mapping off, only while it still points at this run's listener.
- **Identity headers are not read.** They were once shown on a pairing
  request through serve ("signed in to Tailscale as ..."), believed only on
  serve's own host name. That check cannot hold: the listener is on loopback,
  so any local program, another user's included, can send serve's name in
  `Host` and any login beside it. The six digits do not stop it either, since
  its own browser shows them, and a forged account name is exactly what would
  persuade the owner to type them. A request is labelled by its route alone.
- **Not smoke-tested against a live tailscaled** on the build machine: serve
  configuration outlives the process and the machine is shared. The tests
  drive a stand-in daemon that keeps a serve table; the CLI refusals were run
  against the built server.

### 14.13 The browser smoke test (2026-10-03)

- **`npm run test:web:smoke`** (`scripts/web-smoke.mjs`, and the CI job
  `web-smoke`) runs the built server, on a fresh data directory, serving the
  built web bundle to headless Chromium through `playwright-core`. It walks
  a subset of 8.3: pairing by fragment (the code leaves the address and the
  history; the cookie is HttpOnly and SameSite=Strict), the boot under CSP
  with no page error and only the known refusals (a member refused at boot
  that the list does not name fails it), pairing by approval with a wrong
  code refused first, removal sending the tab to `/pair` at once, and the
  reload prompt for a bundle replaced under an open tab. A drop on the
  composer is in it since 14.14.
- **axe** (`axe-core`, WCAG 2 A and AA) runs on the pairing page and the
  app's first screen and fails on anything critical; serious findings are
  printed. Its first run found three critical ones in the sidebar, shared
  with the desktop, fixed here: the resize separator is focusable, so it
  says its position (`aria-valuenow` and its bounds), and the sidebar tree's
  sections are its groups, so its rows sit in a tree.
- **Not covered yet:** the chat round trip with the mock provider, the
  socket killed mid-turn, two tabs, the embed framed cross-origin,
  previews and the canvas, and WebKit and Firefox. Those were checked by
  hand in Chromium while building (14.2 to 14.7) and stay on the 8.3 list.

### 14.14 Dropped files without a path (2026-10-03)

- **`POST /api/upload?name=<file name>`** takes one file's bytes as the
  body, from an owner session only (a non-owner session is refused 403, no
  session 401, and the exact-origin rule applies as to every POST), 50 MB at
  most, refused by its declared length or as it arrives. It answers
  `{ ok, path, bytes }`. The file is saved at
  `<data dir>/web-uploads/<session id>/<date>-<random>/<name>`, 0600 in a
  0700 directory, with the file's own name made a safe single segment.
  Uploads are kept a week and pruned when the next is saved; removing a
  browser removes its uploads. Tickets are not accepted: the route is for a
  tab, and an SDK client sends paths it already has.
- **The client capability `file-uploads`** (web only) and
  `window.api.uploadFiles(files)`, which a desktop window refuses. Both
  composers (the chat's and New chat's) sort a drop as before: paths typed,
  images attached as base64. A file with no path, which in a tab is every
  non-image file, is uploaded where `file-uploads` is supported and its
  server path typed into the message, quoted as a dropped path is; the
  desktop keeps its refusal message. An upload's refusal shows where the
  refusal did.
- Not built: drops onto a terminal or the file explorer in a tab, which the
  desktop serves by path and a tab refuses; the paste of a file.
- Verified in Chromium against the built server: a text file dropped on the
  chat composer and on New chat's was saved and its path typed (the smoke
  test's drop step).

### 14.15 The narrow layout (2026-10-03)

- **Below 640 px** (`useNarrowViewport`, `(max-width: 639px)`) the shell's
  row switches layout with the same components (owner decision 5): the
  content (the chat) has the full width, and the sidebar toggle shows the
  sidebar, with the rail beside it, at the full width instead. Choosing a
  chat, opening New chat or another surface, or crossing back over 640 px
  shows the content again.
- **Not a drawer over the page.** The design system's drawer comes from the
  right and covers the page on a scrim; a left drawer would be a new
  component argued in the principles first. Taking turns at the full width
  needs no overlay, no scrim and no focus trap, and a phone shows one of the
  two at a time either way.
- The sidebar stays mounted while the content has the screen, so the tree
  keeps its scroll and folds; on a wide window its wrapper is
  `display: contents`, so the desktop's row is unchanged. The desktop's
  persisted `sidebarCollapsed` is not touched, so a phone does not fold the
  sidebar of the desktop app sharing the server's settings.
- Not built: anchoring the composer to `visualViewport` under a software
  keyboard (7.2); any surface other than the chat route reworked for a
  phone. The smoke test walks the switch at 390 px.

### 14.16 The Canvas pane in a tab (2026-10-03)

- **The pane speaks to the service the tab already runs.** A desktop
  window's Canvas pane reaches the shell's canvas service over `canvas:*`
  IPC; a tab runs the same service in the page for its `canvas` toolset
  (14.7), so `createWebApi` answers the pane's members from it
  (`web/canvas/webCanvasPane.ts`) and no `canvas:*` channel is refused. The
  tab is the service's one subscriber: scene and presence pushes and an
  agent's `canvas.open` reach the pane's listeners in the page, so
  `canvas.open` now reveals the board in the tab. A call made before the
  toolset starts waits for it; a tab that runs no service (not an owner's,
  or a server without board files) is answered `forbidden` with a sentence.
- **One set of checks.** The path, shape and size checks the desktop's IPC
  made on what the pane sends moved to `shared/canvas/commit-checks.ts`
  (`canvasRefOf`, `canvasCommitOf`), which both paths call; the IPC's
  behaviour is unchanged.
- **Refused in a tab:** export to a folder (the server's folders are not
  the person's to pick from a browser, and a browser download is not built)
  and reveal in a file manager.
- Verified in Chromium against the built server: an agent's `canvas.open`
  over MCP revealed a new board in the tab's pane and its `canvas.edit`
  appeared there. The editor's last-resort font source, a public CDN, is
  refused by the page's CSP as intended. The CJK face (Xiaolai) was not in
  the bundle; in review it was added to the web build alone, as R48 rules
  (its 209 unicode-range subsets, about 12 MB, under `fonts/Xiaolai/`, of
  which a page fetches only what its text needs). The desktop renderer still
  leaves it out: that is twelve megabytes in every installer, R48's own
  change rather than the web client's.
