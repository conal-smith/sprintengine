import { homedir } from 'os'
import { sep } from 'path'

/**
 * A `~/` path as the file it names in this machine's home folder; any other
 * path as it is. An agent's reply may show a picture by such a path, and the
 * chat hands it over unexpanded, not knowing the home folder (useLocalImage.ts).
 * The rest of the path is kept as written, not normalized, so a check that
 * refuses a `..` in a path still sees one.
 */
export function expandHomePath(path: string, home: string = homedir()): string {
  return /^~[\\/]/u.test(path) ? `${home.replace(/[\\/]+$/u, '')}${sep}${path.slice(2)}` : path
}
