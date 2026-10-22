import { realpath } from 'node:fs/promises'
import { posix, win32 } from 'node:path'

// The folders `workspace.create` will not open for an agent. A workspace's
// folder is the line its agents' edits are judged by ("inside the workspace"
// is what Auto lets through unasked), so a workspace on the home folder, a
// filesystem root or a system folder would make that line the whole disk, and
// one on Studio's own data would put the app's records inside it. A project
// folder anywhere under them is a project folder and opens as before.

export type WorkspaceFolderGuard = {
  platform: NodeJS.Platform
  homeDir: string
  /** Studio's own data: the user data folder, the workspace stores. Refused with everything above and below them. */
  dataDirs: readonly string[]
}

/** Top-level folders that are the system's or every user's, refused themselves (a project inside one opens). */
const POSIX_SHARED_FOLDERS = [
  '/Applications',
  '/Library',
  '/System',
  '/Users',
  '/Volumes',
  '/bin',
  '/boot',
  '/dev',
  '/etc',
  '/home',
  '/lib',
  '/media',
  '/mnt',
  '/opt',
  '/private',
  '/private/tmp',
  '/private/var',
  '/proc',
  '/root',
  '/sbin',
  '/snap',
  '/srv',
  '/sys',
  '/tmp',
  '/usr',
  '/usr/local',
  '/var',
]
/** Folders the system runs from, refused with everything inside them. */
const POSIX_SYSTEM_TREES = [
  '/System',
  '/bin',
  '/boot',
  '/dev',
  '/etc',
  '/private/etc',
  '/proc',
  '/sbin',
  '/sys',
  '/usr/bin',
  '/usr/lib',
  '/usr/libexec',
  '/usr/sbin',
  '/usr/share',
]
/** The same, under any drive letter. */
const WINDOWS_SHARED_FOLDERS = ['Users', 'Program Files', 'Program Files (x86)', 'ProgramData']
const WINDOWS_SYSTEM_TREES = ['Windows']

type Paths = typeof posix

function pathsFor(platform: NodeJS.Platform): Paths {
  return platform === 'win32' ? win32 : posix
}

/** A path as compared: resolved, no trailing separator, and in one case where the filesystem ignores case. */
function comparable(path: string, guard: WorkspaceFolderGuard): string {
  const paths = pathsFor(guard.platform)
  const resolved = paths.resolve(path)
  const root = paths.parse(resolved).root
  const trimmed = resolved.length > root.length ? resolved.replace(/[\\/]+$/u, '') : resolved
  return guard.platform === 'darwin' || guard.platform === 'win32' ? trimmed.toLowerCase() : trimmed
}

function isInside(child: string, parent: string, paths: Paths): boolean {
  if (child === parent) return true
  return child.startsWith(parent.endsWith(paths.sep) ? parent : `${parent}${paths.sep}`)
}

/** Why `folder` is not a workspace folder, or null when it is one. Judged on the path as given. */
export function workspaceFolderRefusal(folder: string, guard: WorkspaceFolderGuard): string | null {
  const paths = pathsFor(guard.platform)
  const path = comparable(folder, guard)
  const shown = paths.resolve(folder)
  if (path === comparable(paths.parse(path).root, guard)) {
    return `${shown} is the root of a disk, not a project folder.`
  }
  const home = comparable(guard.homeDir, guard)
  if (isInside(home, path, paths)) {
    return `${shown} is ${path === home ? 'your home folder' : 'a folder that holds your home folder'}, not a project folder.`
  }
  for (const data of guard.dataDirs) {
    const dir = comparable(data, guard)
    if (isInside(path, dir, paths) || isInside(dir, path, paths)) {
      return `${shown} holds SprintEngine Studio's own data, not a project.`
    }
  }
  const drive = paths.parse(path).root
  const shared =
    guard.platform === 'win32'
      ? WINDOWS_SHARED_FOLDERS.map((name) => comparable(paths.join(drive, name), guard))
      : POSIX_SHARED_FOLDERS.map((name) => comparable(name, guard))
  const trees =
    guard.platform === 'win32'
      ? WINDOWS_SYSTEM_TREES.map((name) => comparable(paths.join(drive, name), guard))
      : POSIX_SYSTEM_TREES.map((name) => comparable(name, guard))
  if (shared.includes(path) || trees.some((tree) => isInside(path, tree, paths))) {
    return `${shown} is a system folder, not a project folder.`
  }
  return null
}

/**
 * The same, judged on the path as given and on where its links lead (a link to
 * the home folder is the home folder), with the guarded folders' own links
 * resolved too. A folder that does not exist yet is judged as given.
 */
export async function refuseWorkspaceFolder(folder: string, guard: WorkspaceFolderGuard): Promise<string | null> {
  const real = (path: string) => realpath(path).catch(() => path)
  const given = workspaceFolderRefusal(folder, guard)
  if (given) return given
  const resolvedGuard: WorkspaceFolderGuard = {
    ...guard,
    homeDir: await real(guard.homeDir),
    dataDirs: await Promise.all(guard.dataDirs.map(real)),
  }
  const resolved = await real(folder)
  return workspaceFolderRefusal(folder, resolvedGuard) ?? workspaceFolderRefusal(resolved, resolvedGuard)
}
