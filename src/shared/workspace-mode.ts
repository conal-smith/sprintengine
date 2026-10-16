// A workspace's kind. `'standard'` is the only mode shared contracts pin by
// name; every other mode (a module-registered type, …) is
// renderer-owned and flows through shared boundaries as an open string. Lifted
// here from `renderer/src/types/workspace.ts` so shared contracts (e.g.
// `agent-launch.ts`, the main-process launch surface) can name the type
// without importing the renderer — the `shared` layer must not depend on
// `renderer`. The renderer type module re-exports this so its existing import
// sites keep working.
export type WorkspaceMode = 'standard' | (string & {})

// Workspace-mode strings whose features were retired. Kept as plain literals
// rather than live `WorkspaceMode` constants precisely because nothing may mint
// them again: they are legacy values with no producer left, named here only so
// persisted state written by an older build can be filtered. One list for both
// processes: main drops these rows when it loads its registry (so its own
// consumers — the gateway's `workspace_list`, the phone snapshot — never see
// them) and refuses to adopt one, and the renderer drops them on every
// list-entry path (`dropRetiredModeWorkspaces`) and on registry adoption.
//
//   `roadmap`   — store v65: the per-project Roadmap workspace became an
//                 instance-global sidebar surface, and that surface was itself
//                 deleted on 2026-09-05. The plans on disk (the home project's
//                 `backlog/roadmaps/`) are untouched files.
//   `multiloop` — store v66: the feature was removed outright. Any loop state on
//                 disk under the project folder is untouched.
//   `guided-brief` — 2026-09-08: the Design Wizard was deleted outright. The
//                 files it wrote into the project (product/, architecture/,
//                 mockups/, design-system/) are untouched; only the workspace
//                 row, which nothing can render any more, is dropped.
//   `reviews-host` — 2026-09-10: Reviews left the app for an installable module,
//                 which spawns its guide into the workspace the door was opened
//                 from, so the per-project background host has no producer left.
//                 The row and the guide-terminal agent records nested in it go;
//                 the review data on disk (`.sprintengine/review/`) is untouched
//                 (since 2026-10-16 the store's one-time move keeps it in the
//                 project's store, under `legacy/review/`).
//   `sprintengine` — 2026-09-16: the in-tree sprint engine was deleted outright.
//                 Nothing registers the workspace type any more, so the row has
//                 no surface to render; the run's own files under the project's
//                 `.sprintengine/` sidecar are untouched.
//   `automations-host` — 2026-09-30: Automations was replaced by scheduled
//                 agents, whose runs are ordinary chats, so the per-project
//                 hidden host has no producer left. The row and the run agents
//                 nested in it go; the definitions and run records on disk
//                 (`.sprintengine/automations/`) are untouched (moved, like
//                 review data, to the project's store, `legacy/automations/`).
export const RETIRED_WORKSPACE_MODES: readonly string[] = [
  'roadmap',
  'multiloop',
  'guided-brief',
  'reviews-host',
  'sprintengine',
  'automations-host',
]

export function isRetiredWorkspaceMode(mode: unknown): boolean {
  return typeof mode === 'string' && RETIRED_WORKSPACE_MODES.includes(mode)
}
