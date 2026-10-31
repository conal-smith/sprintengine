import type { ProjectLogo } from '../../../shared/electron-api'

// Session-scoped store for detected project logos, keyed by the
// project's folder path so every surface that shows the same project shares one
// detection instead of racing its own.
//
// Deliberately NOT persisted: the data URI is bytes, and the main process
// re-detects cheaply on open (its own cache is keyed on the resolved file's
// mtime). Nothing here writes to the workspace row.

type ProjectLogoEntry = {
  status: 'loading' | 'ready'
  dataUrl: string | null
}

const entries = new Map<string, ProjectLogoEntry>()
const listeners = new Set<() => void>()

function emit(): void {
  for (const listener of listeners) listener()
}

export function subscribeProjectLogos(listener: () => void): () => void {
  listeners.add(listener)
  return () => {
    listeners.delete(listener)
  }
}

/**
 * The logo for a project, or null when there is none, one has not been detected
 * yet, or the project has no folder. Null is what the icon slot reads as "keep
 * the glyph", so a pending detection and a genuine miss look the same to the
 * caller — no flash of an empty box while the scan runs.
 */
export function getProjectLogoDataUrl(folderPath: string | null | undefined): string | null {
  if (!folderPath) return null
  return entries.get(folderPath)?.dataUrl ?? null
}

/**
 * Start detection for a project folder if it has not run this session. Repeat
 * calls for the same folder are no-ops, which is what lets every row, popover,
 * and header ask without coordinating.
 */
export function ensureProjectLogo(
  folderPath: string | null | undefined,
  detect: (folderPath: string) => Promise<ProjectLogo | null>,
): void {
  if (!folderPath) return
  if (entries.has(folderPath)) return

  entries.set(folderPath, { status: 'loading', dataUrl: null })
  // `Promise.resolve().then(...)` rather than calling `detect` directly, so a
  // detector that throws SYNCHRONOUSLY lands in the same catch as one that
  // rejects. Both are a failed detection, and a failed detection keeps the
  // glyph — the sidebar must never fail to mount over decoration.
  void Promise.resolve()
    .then(() => detect(folderPath))
    .then((logo) => {
      entries.set(folderPath, { status: 'ready', dataUrl: logo?.dataUrl ?? null })
      emit()
    })
    .catch(() => {
      // Detection is best-effort decoration: a failed scan keeps the glyph and
      // is not worth a surfaced error. It stays cached as a miss so the failing
      // call is not repeated for every row on every render.
      entries.set(folderPath, { status: 'ready', dataUrl: null })
      emit()
    })
}

/**
 * Drop one entry so the next `ensureProjectLogo` reads it again: a chosen icon
 * file the person has just picked (again) must not show this session's copy.
 */
export function forgetProjectLogo(key: string): void {
  if (entries.delete(key)) emit()
}

/** Test seam: clear everything this session has detected. */
export function resetProjectLogos(): void {
  entries.clear()
  emit()
}
