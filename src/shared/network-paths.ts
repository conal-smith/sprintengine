import { distroOfUncPath } from './host-paths'

// A path or `file:` URL that names a file on another machine: a UNC path
// (`\\server\share\…`, or the same with forward slashes), a device path
// (`\\?\…`, `\\.\…`, which may be a UNC path in disguise), or a `file:` URL
// with a host. On Windows, merely looking at one has the system connect to
// that server and offer it the person's credentials, so a picture or file a
// reply names this way is not read. A WSL distribution's share is this
// computer's own and is not one of these.

const LOCAL_FILE_HOSTS = new Set(['', 'localhost'])

/** Whether `value` names a file on another machine, by its spelling alone. */
export function namesNetworkLocation(value: string): boolean {
  const text = value.trim()
  if (/^file:/iu.test(text)) {
    let url: URL
    try {
      url = new URL(text)
    } catch {
      return true
    }
    const host = url.hostname.toLowerCase()
    if (!LOCAL_FILE_HOSTS.has(host)) return distroOfUncPath(`//${host}${url.pathname}`) === null
    let path = url.pathname
    try {
      path = decodeURIComponent(path)
    } catch {
      // The spelling as written is what is judged.
    }
    return namesNetworkLocation(path)
  }
  if (!/^[\\/]{2}/u.test(text)) return false
  return distroOfUncPath(text) === null
}
