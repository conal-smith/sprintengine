import React, { Suspense, lazy, useEffect, useState } from 'react'
import type { AuxWindowKind } from '../../../../shared/electron-api'
import { parseEditorRange, type EditorRange } from '../../../../shared/editor-reveal'
import { useAppTheme } from '../../hooks/useAppTheme'
import { followStoredSettings } from './auxSettingsWrite'
import { writeAuxWindowBounds } from './auxWindowPlacement'
import { InlineNotice, Spinner } from '../ui'
import { ToastRegion } from '../ui/ToastRegion'

// Each window body is only ever needed by the one kind of aux window that shows
// it, and the workspace window shares this bundle without showing any of them,
// so they load behind React.lazy just like EditorPanel does in the workspace
// shell. Monaco itself is not behind this boundary: it is loaded at boot
// (utils/monacoRuntime.ts), so these bodies arrive to an editor already there.
const DiffViewerWindow = lazy(() => import('./DiffViewerWindow'))
const CheckpointDiffWindow = lazy(() => import('./CheckpointDiffWindow'))
const ExternalEditorWindow = lazy(() => import('./ExternalEditorWindow'))
const PanePopOutWindow = lazy(() => import('../workspace/pane/popout/PanePopOutWindow'))

function AuxLoading() {
  return (
    <div className="flex h-screen w-screen items-center justify-center gap-2 bg-[color:var(--bg-app)] text-body text-[color:var(--text-muted)]">
      <Spinner />
      Loading…
    </div>
  )
}

// A window that cannot open at all: the kit's notice, centred in the empty
// window, rather than a red sentence floating in the middle of it.
function AuxFailure({ message }: { message: string }) {
  return (
    <div className="flex h-screen w-screen items-center justify-center bg-[color:var(--bg-app)] px-6">
      <InlineNotice tone="error" className="max-w-md">
        {message}
      </InlineNotice>
    </div>
  )
}

// Root for lightweight auxiliary windows. Mounted by `main.tsx` when the renderer
// is loaded with `?aux=<kind>` — a sibling of the diagnostics window root, not
// the workspace shell. It reads the initial params from the URL, updates them on
// `aux:retarget` (singleton windows are reused, not reopened), and persists its
// bounds per kind so the next open reuses the size/position.

export type AuxWindowParams = Record<string, string>

function parseRevealPaths(raw: string | undefined): string[] | null {
  if (!raw) return null
  try {
    const parsed: unknown = JSON.parse(raw)
    return Array.isArray(parsed) && parsed.every((entry) => typeof entry === 'string') ? parsed : null
  } catch {
    return null
  }
}

function parseRevealRange(raw: string | undefined): EditorRange | null {
  if (!raw) return null
  try {
    const parsed = parseEditorRange(JSON.parse(raw))
    return parsed.ok ? parsed.value : null
  } catch {
    return null
  }
}

function readInitialParams(): { kind: AuxWindowKind; params: AuxWindowParams } | null {
  const search = new URLSearchParams(window.location.search)
  const kind = search.get('aux')
  if (kind !== 'diff' && kind !== 'file' && kind !== 'pane') return null
  const params: AuxWindowParams = {}
  search.forEach((value, key) => {
    if (key !== 'aux') params[key] = value
  })
  return { kind, params }
}

export default function AuxWindowApp() {
  // Drive <html data-theme="…"> from the persisted preference, exactly like the
  // workspace shell. The boot script in index.html applies the initial theme to
  // avoid a flash; this keeps the attribute (and the CSS variables the chrome
  // reads) correct for the window's lifetime instead of leaving it frozen —
  // following the workspace window's saved changes, and never telling main
  // its copy of them.
  useAppTheme({ mirrorToMain: false })
  useEffect(() => followStoredSettings(), [])
  const [descriptor] = useState(readInitialParams)
  const [params, setParams] = useState<AuxWindowParams>(descriptor?.params ?? {})
  // Bumps on every retarget (even a repeat of the same params) so the file
  // window can re-focus/append a tab without the params object having changed.
  const [retargetNonce, setRetargetNonce] = useState(0)

  useEffect(() => {
    if (!descriptor) return
    return window.api.onAuxWindowRetarget((payload) => {
      if (payload.kind !== descriptor.kind) return
      setParams(payload.params)
      setRetargetNonce((n) => n + 1)
    })
  }, [descriptor])

  useEffect(() => {
    if (!descriptor) return
    return window.api.onWindowPlacementChanged((placement) => {
      writeAuxWindowBounds(descriptor.kind, placement.bounds)
    })
  }, [descriptor])

  if (!descriptor) {
    return <AuxFailure message="Unknown auxiliary window." />
  }

  // A pane popped out of its workspace window. It names the pop-out and the
  // workspace and nothing else: what it shows comes from the window that owns
  // it, over IPC, and changes as that window's pane does.
  if (descriptor.kind === 'pane') {
    if (!params.popOutId || !params.workspaceId) return <AuxFailure message="Missing pane for this window." />
    return (
      <Suspense fallback={<AuxLoading />}>
        <PanePopOutWindow popOutId={params.popOutId} workspaceId={params.workspaceId} />
      </Suspense>
    )
  }

  if (descriptor.kind === 'diff') {
    if (params.checkpoint)
      return (
        <Suspense fallback={<AuxLoading />}>
          <CheckpointDiffWindow request={params.checkpoint} />
        </Suspense>
      )
    const focusKind = params.scope === 'staged' ? 'staged' : params.scope === 'unstaged' ? 'unstaged' : null
    if (!params.repoRoot) {
      return <AuxFailure message="Missing repository for diff viewer." />
    }
    return (
      <Suspense fallback={<AuxLoading />}>
        <DiffViewerWindow
          // Keyed on the REPOSITORY and the CHANGELIST. A retarget to another
          // file in the same repo flows in as props and the viewer walks its
          // own cursor there; keying on the file remounted Monaco under the
          // diff widget on every Git row click — the flash the pane tab was
          // careful to avoid (see WorkspacePaneBody). A different repository is
          // a different file list, and that does start over.
          //
          // A different CHANGELIST is a different file list too, and it starts
          // over for the same reason: the viewer holds a cursor, a chosen
          // filter and a hunk read that are all about the list it opened on, so
          // retargeting one into another leaves a cursor pointing at a file the
          // new list may not contain. The empty string is "no filter", which is
          // the key every diff opened before agent changelists carries.
          key={`${params.repoRoot}\n${params.changelistId ?? ''}`}
          repoRoot={params.repoRoot}
          focusPath={params.focusPath ?? null}
          focusKind={focusKind}
          changelistId={params.changelistId ?? null}
          workspaceId={params.workspaceId ?? null}
          pathsFilter={parseRevealPaths(params.revealPaths)}
          focusRange={parseRevealRange(params.revealRange)}
          focusSide={params.revealSide === 'original' ? 'original' : 'modified'}
          revealKey={params.revealKey ?? null}
        />
        <ToastRegion />
      </Suspense>
    )
  }

  // External editor window: a singleton tabbed Monaco host. It is NOT remounted
  // per file (that would drop the other open tabs) — the incoming file + nonce
  // drive tab add/focus inside the component.
  const incoming = params.filePath
    ? {
        filePath: params.filePath,
        fileName: params.fileName ?? params.filePath,
        workspaceId: params.workspaceId ?? '',
        // An agent's reveal (editor.* tools): where to land, and whether to
        // stay behind the tab the person is on.
        revealRange: parseRevealRange(params.revealRange),
        revealBackground: params.revealBackground === '1',
        revealByAgent: params.revealByAgent === '1',
        rootPath: params.rootPath ?? '',
      }
    : null
  return (
    <Suspense fallback={<AuxLoading />}>
      <ExternalEditorWindow incoming={incoming} nonce={retargetNonce} />
      {/* The diff and editor windows carry the workspace's Files tree, whose
          menu reports a failed rename or delete as a toast — so they hold the
          one region a toast lands in, as a popped-out pane does. */}
      <ToastRegion />
    </Suspense>
  )
}
