import { lstat, realpath } from 'node:fs/promises'
import { basename, dirname, isAbsolute, join, resolve } from 'node:path'
import { isPathInsideOrEqual } from './path-containment'

// Where an editor save may write. A file inside the project is written only
// where it really is inside the project: its folder, every link followed,
// must be inside the project's real folder, and a file that is itself a link
// must point inside it too. A file outside every project the person has open
// was opened by its own path, and is saved there as long as it is that file
// and not a link to another one.

export const SAVE_TARGET_OUTSIDE_PROJECT =
  'That file is a link to somewhere outside this project, so Studio did not save over it.'
export const SAVE_TARGET_IS_LINK = 'That file is a link to another file; open the file it points to and save it there.'

async function lstatOrNull(path: string) {
  try {
    return await lstat(path)
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null
    throw error
  }
}

/**
 * The path to write a save of `filePath` to, or a refusal. `roots` are the
 * folders of the project the file was opened in (its folder and, for a
 * worktree, the worktree); none is the same as a file opened from outside.
 */
export async function resolveEditorSaveTarget(filePath: string, roots: readonly unknown[]): Promise<string> {
  const target = resolve(filePath)
  const projectRoots = roots.filter(
    (root): root is string => typeof root === 'string' && isAbsolute(root) && isPathInsideOrEqual(root, target),
  )
  const entry = await lstatOrNull(target)
  if (projectRoots.length === 0) {
    if (entry?.isSymbolicLink()) throw new Error(SAVE_TARGET_IS_LINK)
    return target
  }

  const realFolder = await realpath(dirname(target))
  for (const root of projectRoots) {
    const realRoot = await realpath(root).catch(() => null)
    if (!realRoot || !isPathInsideOrEqual(realRoot, realFolder)) continue
    if (!entry?.isSymbolicLink()) return join(realFolder, basename(target))
    // A link inside the project that points elsewhere in it is saved through
    // to the file it names; the link itself stays a link.
    const realTarget = await realpath(target).catch(() => null)
    if (realTarget && isPathInsideOrEqual(realRoot, realTarget)) return realTarget
  }
  throw new Error(SAVE_TARGET_OUTSIDE_PROJECT)
}
