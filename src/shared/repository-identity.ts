// One repository across machines (one-project-across-machines).
//
// Two clones of the same repository — on this disk, on a paired machine's —
// are one logical project to the person using them: "run this repo on the
// faster machine", not "find that machine's copy of this repo". The identity
// that says two folders are the same repository is the remote they fetch
// from, normalised so the transport (ssh, https, scp-style) and the
// spelling (`.git`, trailing slash, case of the host) stop mattering.
//
// Pure and node-free, so the renderer (sidebar grouping, the launch panel's
// machine filter) and main (the `workspace.list` projection) derive the same
// key from the same string.

export type RepositoryIdentity = {
  /** `host/owner/name` (or the normalised URL when it has no such path): equal for every clone of one repository. */
  canonicalKey: string
  /** The remote URL as `git remote` reported it, for display and diagnosis. */
  remoteUrl: string
  /**
   * The repository's last path segment as the remote spells it — `SprintEngine`
   * for `git@github.com:Acme/SprintEngine.git` — for display. Compare keys, not names.
   */
  name: string
}

/**
 * The key two clones share. Lower-cased and stripped of `.git`, trailing
 * slashes and the transport, so `git@github.com:Acme/SprintEngine.git`,
 * `https://github.com/acme/sprintengine/` and `ssh://git@github.com/acme/sprintengine`
 * are one key: `github.com/acme/sprintengine`. A URL that cannot be read as
 * host + path is returned normalised as-is — still stable for that string.
 */
export function canonicalRepositoryKey(remoteUrl: string): string {
  const normalized = remoteUrl
    .trim()
    .replace(/\/+$/g, '')
    .replace(/\.git$/i, '')
    .toLowerCase()
  if (!normalized) return ''

  if (/^(?:ssh|https?|git|git\+ssh|ssh\+git):\/\//i.test(normalized)) {
    try {
      const url = new URL(normalized)
      const path = url.pathname
        .split('/')
        .filter((segment) => segment.length > 0)
        .join('/')
      if (url.hostname && path.includes('/')) return `${url.hostname}/${path}`
    } catch {
      return normalized
    }
    return normalized
  }

  // scp-style: `user@host:owner/name`. Only the host and the path matter.
  const scp = /^(?:[a-z0-9._-]+@)?([^:/\s]+):([^/\s]+(?:\/[^/\s]+)+)$/i.exec(normalized)
  if (scp?.[1] && scp[2]) return `${scp[1]}/${scp[2]}`

  return normalized
}

/** The repository's short name off its key: the last path segment. */
function repositoryNameFromKey(canonicalKey: string): string {
  const segments = canonicalKey.split('/').filter((segment) => segment.length > 0)
  return segments[segments.length - 1] ?? canonicalKey
}

/**
 * The key's name in the remote's own casing. The key is lower-cased so clones
 * match, but "No copy of myrepo" reads wrong for `MyRepo`; the URL's last
 * segment is used when it is the same name, else the key's.
 */
function repositoryDisplayName(remoteUrl: string, canonicalKey: string): string {
  const fromKey = repositoryNameFromKey(canonicalKey)
  const segments = remoteUrl
    .trim()
    .replace(/\/+$/g, '')
    .replace(/\.git$/i, '')
    .split(/[/:]/)
  const spelled = segments[segments.length - 1] ?? ''
  return spelled.toLowerCase() === fromKey ? spelled : fromKey
}

/**
 * Build an identity from a remote URL, or null when the URL yields no key.
 */
export function repositoryIdentityFromRemote(remoteUrl: string): RepositoryIdentity | null {
  const canonicalKey = canonicalRepositoryKey(remoteUrl)
  if (!canonicalKey) return null
  const strippedUrl = stripRemoteCredentials(remoteUrl.trim())
  return {
    canonicalKey,
    remoteUrl: strippedUrl,
    name: repositoryDisplayName(strippedUrl, canonicalKey),
  }
}

/**
 * A remote URL as `git remote -v` prints it can carry a token
 * (`https://user:ghp_…@github.com/a/b.git`). The identity travels over the
 * gateway to every `workspace:read` device and into the workspace registry,
 * so the userinfo is cut before the URL leaves the reader. The key never had
 * it (`new URL().hostname`, and the scp form keeps host and path only).
 */
export function stripRemoteCredentials(remoteUrl: string): string {
  return remoteUrl.replace(/^([a-z][a-z0-9+.-]*:\/\/)[^/@\s]*@/i, '$1')
}

// A remote at a relative path (`.`, `./x`, `../x`) names a different place
// from every folder that has it. Tools add one for their own bookkeeping — a
// remote pointing at the repository itself is common — so as a key it would
// file unrelated repositories under one project. An absolute path still names
// one place, so two clones of one bare repository on disk stay one project.
const RELATIVE_PATH_REMOTE = /^\.{1,2}(?:[\\/]|$)/u

/**
 * Which remote names the repository when a clone has several. `upstream`
 * beats `origin` — a fork's origin is the fork, and the thing two machines
 * share is the repository it was forked from — and any other remote is
 * taken alphabetically, so the answer is stable rather than first-listed.
 * A remote at a relative path never names it.
 */
export function pickPrimaryRemote(
  remotes: ReadonlyMap<string, string>,
): { remoteName: string; remoteUrl: string } | null {
  const named = new Map([...remotes].filter(([, remoteUrl]) => !RELATIVE_PATH_REMOTE.test(remoteUrl.trim())))
  for (const preferred of ['upstream', 'origin']) {
    const remoteUrl = named.get(preferred)
    if (remoteUrl) return { remoteName: preferred, remoteUrl }
  }
  const [first] = [...named.entries()].sort(([left], [right]) => left.localeCompare(right))
  return first ? { remoteName: first[0], remoteUrl: first[1] } : null
}

/**
 * Parse `git remote -v` into name → fetch URL. Push URLs are ignored: a
 * repository is identified by where it is read from.
 */
export function parseRemoteFetchUrls(stdout: string): Map<string, string> {
  const remotes = new Map<string, string>()
  for (const line of stdout.split(/\r?\n/)) {
    const match = /^(\S+)\s+(\S+)\s+\((fetch|push)\)$/.exec(line.trim())
    if (!match) continue
    const [, name = '', url = '', direction = ''] = match
    if (direction !== 'fetch' || !name || !url) continue
    remotes.set(name, url)
  }
  return remotes
}

/**
 * What a read of a folder's identity actually answered.
 *
 * `settled` is the difference between "asked, and this folder has no remote"
 * and "could not ask" — a read that timed out on a spun-down volume, or that
 * threw. Both used to arrive as a bare `null`, which made a folder on a sleeping
 * disk indistinguishable from a folder with no remote. That is fine for
 * GROUPING, where either way the folder groups by its path, and wrong for
 * anything that writes the answer down: one-colour-per-project (2026-09-09)
 * would spend a hue on the folder's PATH key and then a second on its
 * repository key the next time the volume was awake, so one project would end
 * up wearing two of the six colours. A caller that persists anything derived
 * from an identity must wait for `settled`.
 */
export type RepositoryIdentityRead = {
  identity: RepositoryIdentity | null
  /** The read completed and this IS the answer — including "no remote". */
  settled: boolean
}

/**
 * Whether two identities name one repository. Null on either side is "not
 * known", which never matches — an unidentified folder stays its own thing.
 */
export function sameRepository(
  left: Pick<RepositoryIdentity, 'canonicalKey'> | null | undefined,
  right: Pick<RepositoryIdentity, 'canonicalKey'> | null | undefined,
): boolean {
  return Boolean(left?.canonicalKey && right?.canonicalKey && left.canonicalKey === right.canonicalKey)
}
