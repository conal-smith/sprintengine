import { lstatSync, mkdirSync, mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { isAbsolute, join } from 'node:path'

// Where a POSIX socket goes when the data directory's own path is too long for
// one (`sun_path` holds about a hundred bytes). A shared temp folder is open to
// every user of the machine, so a socket at a fixed name there could be
// created first by someone else, and an agent's bridge would connect to theirs.
// The socket goes instead in a folder only this user can enter.
//
// The folder's name is fixed per user, not random, so that every process of
// this Studio (the desktop, its server, a terminal launch) and the next run
// find the same socket. That is safe only for a folder this user made: one
// that is there already is used only when it is a real directory, owned by
// this user, that nobody else can enter. Anything else means someone made it
// first, and a fresh `mkdtemp` folder is used for this process instead.

const fallbacks = new Map<string, string>()

/** The base the folder is made in: the user's runtime directory when it has one, else the temp folder. */
function defaultBase(env: NodeJS.ProcessEnv): string {
  const runtime = env.XDG_RUNTIME_DIR
  return runtime && isAbsolute(runtime) ? runtime : tmpdir()
}

/** A folder only this user can enter, under `base`, for sockets whose usual path is too long. */
export function privateSocketDirectory(base: string = defaultBase(process.env)): string {
  const uid = process.getuid?.() ?? 0
  const dir = join(base, `sprintengine-${uid}`)
  try {
    mkdirSync(dir, { mode: 0o700 })
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'EEXIST') return fallback(base)
  }
  try {
    const found = lstatSync(dir)
    if (found.isDirectory() && found.uid === uid && (found.mode & 0o077) === 0) return dir
  } catch {
    // Unreadable: treated as not ours.
  }
  return fallback(base)
}

function fallback(base: string): string {
  let dir = fallbacks.get(base)
  if (!dir) {
    // `mkdtemp` makes the folder 0700, with a name nobody could have guessed.
    dir = mkdtempSync(join(base, 'sprintengine-'))
    fallbacks.set(base, dir)
  }
  return dir
}

/**
 * Runs `listen` with the process umask at owner-only, so a socket file is
 * created 0600 rather than narrowed after it already exists. `listen` binds
 * synchronously, so the umask is back before anything else runs on this
 * thread. A worker thread may not change the umask; there it runs as it is,
 * and the caller's `chmod` after listening still narrows the file.
 */
export function withOwnerOnlyUmask<T>(listen: () => T): T {
  let previous: number | null = null
  try {
    previous = process.umask(0o177)
  } catch {
    previous = null
  }
  try {
    return listen()
  } finally {
    if (previous !== null) process.umask(previous)
  }
}
