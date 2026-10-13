import { lstatSync, mkdirSync, writeFileSync } from 'node:fs'
import { lstat, mkdir, writeFile } from 'node:fs/promises'
import { join } from 'node:path'

import { SIDECAR_DIR_NAME, sidecarFor, sidecarPath, type WorkspaceSidecar } from '../shared/workspace-sidecar'

export type { WorkspaceSidecar }
export { SIDECAR_DIR_NAME, sidecarPath }

/** The sidecar root for a workspace. */
export function workspaceSidecarRoot(workspaceRoot: string): string {
  return sidecarFor(workspaceRoot).root
}

/** An absolute path inside a workspace's sidecar. */
export function workspaceSidecarPath(workspaceRoot: string, ...segments: string[]): string {
  return sidecarPath(sidecarFor(workspaceRoot), ...segments)
}

// A workspace folder is a cloned repository's to fill, so any entry from
// `.sprintengine` down could be a link it committed, and whatever Studio
// writes or reads through it would land wherever it points.

/**
 * The first link on the way from `sidecarRoot` down to `path` (both
 * included), or null. The walk stops at the first entry that is not there
 * yet: what a write makes there is real.
 */
export async function sidecarLinkOnPath(sidecarRoot: string, path: string): Promise<string | null> {
  let at = sidecarRoot
  for (const segment of ['', ...path.slice(sidecarRoot.length).split(/[\\/]/).filter(Boolean)]) {
    at = segment ? join(at, segment) : at
    try {
      if ((await lstat(at)).isSymbolicLink()) return at
    } catch {
      return null
    }
  }
  return null
}

/** A link where a sidecar folder should be. */
export class SidecarLinkError extends Error {
  constructor(readonly path: string) {
    super(`${path} is a link; Studio does not write into the workspace through one.`)
  }
}

/**
 * Makes `<workspace>/.sprintengine/<segments…>` one folder at a time, refusing
 * (SidecarLinkError) wherever a link stands in for one, and returns its path.
 * The first segment's folder ignores itself with a `*` `.gitignore`, so what
 * Studio keeps there never shows in `git status`; one already there is left
 * alone, and a link in its place is not written through.
 */
export async function ensureSidecarDirNoLinks(workspaceRoot: string, ...segments: string[]): Promise<string> {
  let at = workspaceSidecarRoot(workspaceRoot)
  for (const [index, segment] of ['', ...segments].entries()) {
    at = segment ? join(at, segment) : at
    try {
      await mkdir(at)
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error
    }
    const info = await lstat(at)
    if (info.isSymbolicLink()) throw new SidecarLinkError(at)
    if (!info.isDirectory()) throw new Error(`${at} is not a folder.`)
    if (index === 1) {
      await writeFile(join(at, '.gitignore'), '*\n', { encoding: 'utf8', flag: 'wx' }).catch(
        (error: NodeJS.ErrnoException) => {
          if (error.code !== 'EEXIST') throw error
        },
      )
    }
  }
  return at
}

/**
 * `ensureSidecarDirNoLinks` for a caller that has to answer before it returns:
 * Electron takes a download's save path only inside its `will-download`
 * handler, so the folder is made and checked there, the same way.
 */
export function ensureSidecarDirNoLinksSync(workspaceRoot: string, ...segments: string[]): string {
  let at = workspaceSidecarRoot(workspaceRoot)
  for (const [index, segment] of ['', ...segments].entries()) {
    at = segment ? join(at, segment) : at
    try {
      mkdirSync(at)
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error
    }
    const info = lstatSync(at)
    if (info.isSymbolicLink()) throw new SidecarLinkError(at)
    if (!info.isDirectory()) throw new Error(`${at} is not a folder.`)
    if (index === 1) {
      try {
        writeFileSync(join(at, '.gitignore'), '*\n', { encoding: 'utf8', flag: 'wx' })
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error
      }
    }
  }
  return at
}
