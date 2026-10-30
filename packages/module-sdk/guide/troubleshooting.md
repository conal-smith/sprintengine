# Troubleshooting

Start with `npm run check` and `node scripts/validate.mjs`: most problems show
up there first, with the app's own validators.

## Studio does not list the module

| Check | Fix |
| --- | --- |
| Is it installed where Studio looks? `ls ~/.sprintengine/modules/<id>/manifest.json` (or `$SPRINTENGINE_USER_MODULE_ROOT` if Studio was started with it) | `npm run dev:install` |
| Does the folder name equal the manifest `id`? | `dev:install` names it from the id |
| Does the manifest validate? | `node scripts/validate.mjs` |
| Is Settings → Modules showing an older list? | Close and reopen Settings; the list rescans the folder |

## Listed, but not running

| Studio shows | Cause | Fix |
| --- | --- | --- |
| Needs trust / unsigned / signed | Not trusted yet — or trusted before the last rebuild | Trust it. Every `dev:install` changes the fingerprint |
| Invalid / tampered | Files in the folder do not match `files`, or the manifest changed after signing | `npm run dev:install` (it rewrites `files` and signs again when it can). Never edit the installed copy |
| Needs a newer Studio (`host_api_too_new`) | `engines.hostApi` is newer than this Studio | Update Studio, or build against the SDK version it ships |
| Built for an older host (`host_api_too_old`) | The SDK the module was built with is too old | Update `@sprintengine/module-sdk`, rebuild |
| No host API (`host_api_missing`) | `engines` missing or not an integer | Add `"engines": { "hostApi": 1 }` |
| Disabled | `defaultEnabled: false` and never turned on, or a `dependsOn` module is off | Turn it on; turn on the dependency |
| A load error | `registerRenderer`/`registerMain` threw, rejected or took over 10 s; or an id clash | Read the error text; `npm test` reproduces most registration failures |
| Trusted, main entry not running | `entry.main` loads at startup only | Restart Studio |
| Old code still running | The renderer already evaluated this module id this session | Restart Studio |

## Running, but something is missing

| Symptom | Cause |
| --- | --- |
| A panel never appears | Nothing places it: add it to a workspace type's layout |
| No row for my door | `registerGlobalSurface` needs both `label` and `Icon` for the Extensions drawer to list it |
| Unstyled markup | Tailwind classes you wrote (see the `ui-kit` topic) |
| "…is provided by the host at runtime; mark it external" | The bundle inlined `./ui` or `./surface`; fix the esbuild `--external` flags |
| Failed to resolve module specifier "@sprintengine/module-sdk" | The SDK root was left external in the renderer build; bundle it |
| Cannot find module '…' from entry.main | A dependency left external in the main build; bundle it |
| `invoke` rejects `permission_missing` | Declare `module:bridge` |
| Smoke test: "… needs "storage"" (or another permission) | The module resolves a service or calls a host method whose permission the manifest does not declare. Declare it (and in `plugin.json`) |
| Smoke test: "… is resolved while registering, so "dependsOn" must include …" | Add that module to `dependsOn`, or resolve the service inside the handler that uses it |
| Smoke test: `door "…" renders` fails | The component threw while rendering; the error follows the line. In tests a render is a server render, so `document`/`window` in render (not in an effect) and `useSyncExternalStore` without its third argument fail too |
| A test cannot import `@sprintengine/module-sdk/ui` ("provided by the host at runtime") | Run it through `npm test`, which loads `@sprintengine/module-sdk/testing/register` first, or call `installTestingKit()` before importing the component |
| `invoke` rejects `unknown_channel` | The main entry is not loaded (restart), or the channel name differs |
| `invoke` rejects `not_bridgeable` | The channel does not start with `<moduleId>:` |
| `openChat` → `permission_missing` | Declare `conversation:operate` |
| `openChat` → `workspace_folder_missing` | Chats need a workspace with a folder |
| `openChat` → `unavailable` | This window cannot open chats; try the main window |
| Conversation service → `not_owned` | The chat was not created by this module |
| `requireService` throws at startup | The provider loads after you: add `dependsOn`, or resolve it inside the handler |
| `host.supports('…')` is false | This Studio (or its providing module) does not offer it; degrade with a message |
| MCP tool answers "module disabled" | Turn the module on |
| MCP tool rejected at registration | Declare `mcp:tools`; or a name another module already holds |
| Secrets → `origin_not_allowed` | The URL's origin was not in `allowedOrigins` when the secret was set; set it again with the origin |
| GitHub → `not_signed_in` | The person is not signed in to GitHub in Studio |

## Dev loop problems

| Symptom | Fix |
| --- | --- |
| `validate`/`dev:install`: "cannot digest module files" | The installed SDK is too old to write the `files` map Studio requires. Update it |
| `validate`: stale `files` warning | Normal between builds; `dev:install` rewrites it. Commit the rewritten manifest before publishing |
| `validate`: key material in the project | Move the key to `~/.sprintengine/keys/` and rotate it if it was ever committed |
| `npm test`: "contributed nothing" | `registerRenderer`/`registerMain` registered nothing — check the export name |
| `npm test`: "needs the … permission" | Add it to both manifests, or stop using the service |
| Smoke test cannot load a package | Something in the bundle is external that should not be (see above) |

## Reading Studio's side

The person can open Settings → Modules for the module's status line and load
error. Ask them to copy it to you verbatim; do not guess from a screenshot of
the drawer.
