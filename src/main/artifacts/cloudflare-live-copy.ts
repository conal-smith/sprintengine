import { createHash } from 'node:crypto'
import { mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'

import { normalizeSiteUrl } from '../../shared/artifacts'
import { ARTIFACTS_DIR, META_FILE, MANIFEST_FILE, SITE_FILES_FILE, SLUG_PATTERN } from './artifact-site'

// A Cloudflare site with no source repository is kept in a folder on the
// machine that publishes it. Another machine (or this one after its data
// folder was cleared) has no such folder, and publishing from a stale or empty
// one would replace everything else on the site. So before it publishes, a
// machine whose copy is not what is live reads the live site back:
//
// - no copy at all: every file `site-files.json` lists is fetched, checked
//   against its SHA-256, and becomes the copy;
// - a copy that is behind: each artifact the live site has a newer version of
//   (or that the copy lacks) is fetched and replaces the copy's. An artifact
//   the copy has at the same or a newer version is never touched, so work
//   made here and not yet uploaded survives.
//
// A site behind Cloudflare Access answers a sign-in page instead, and cannot
// be read this way; the caller says so, and that a source repository under
// Advanced is how two machines share one site.

export type SiteResponse = {
  ok: boolean
  status: number
  /** Where a redirect was going, when the response is one. */
  location: string | null
  bytes(): Promise<Buffer>
}

/** A GET of a file of the live site, redirects not followed. */
export type SiteFetch = (url: string) => Promise<SiteResponse>

export const defaultSiteFetch: SiteFetch = async (url) => {
  const response = await fetch(url, { redirect: 'manual', cache: 'no-store' })
  return {
    ok: response.ok,
    status: response.status,
    location: response.headers.get('location'),
    bytes: async () => Buffer.from(await response.arrayBuffer()),
  }
}

export type LiveCopyOutcome =
  | { state: 'empty' }
  | { state: 'rebuilt'; artifacts: number }
  | { state: 'merged'; taken: string[] }
  | { state: 'behind-access' }
  | { state: 'unreachable'; message: string }

type ListedFile = { path: string; sha256: string }

const ACCESS_HOSTS = /cloudflareaccess\.com|\/cdn-cgi\/access\//i

function isContained(path: string): boolean {
  return (
    path.length > 0 &&
    path.length < 1024 &&
    !path.startsWith('/') &&
    !path.includes('\\') &&
    !path.includes('\0') &&
    path
      .split('/')
      .every((segment) => segment !== '' && segment !== '.' && segment !== '..' && !segment.startsWith('.'))
  )
}

function sha256(bytes: Buffer): string {
  return createHash('sha256').update(bytes).digest('hex')
}

async function readLocal(path: string): Promise<Buffer | null> {
  return readFile(path).catch(() => null)
}

function recordVersion(bytes: Buffer | null): { version: number; updatedAt: string } | null {
  if (!bytes) return null
  try {
    const raw = JSON.parse(bytes.toString('utf8')) as { version?: unknown; updatedAt?: unknown }
    return {
      version: typeof raw.version === 'number' ? raw.version : 0,
      updatedAt: typeof raw.updatedAt === 'string' ? raw.updatedAt : '',
    }
  } catch {
    return null
  }
}

/** Whether the live record is ahead of the copy's. */
function liveIsNewer(
  live: { version: number; updatedAt: string },
  local: { version: number; updatedAt: string } | null,
): boolean {
  if (!local) return true
  if (live.version !== local.version) return live.version > local.version
  return live.updatedAt > local.updatedAt
}

/**
 * Bring the copy at `dir` up to the live site at `siteUrl`, never replacing
 * anything the copy has newer. Writes go to a folder beside the copy first
 * and are moved in only once every file has arrived whole.
 */
export async function syncLiveCopy(
  dir: string,
  siteUrl: string,
  fetchSite: SiteFetch = defaultSiteFetch,
): Promise<LiveCopyOutcome> {
  const base = normalizeSiteUrl(siteUrl)
  if (!base) return { state: 'unreachable', message: `${siteUrl} is not a site address.` }
  const get = async (path: string): Promise<SiteResponse | { error: string }> => {
    try {
      return await fetchSite(new URL(path.split('/').map(encodeURIComponent).join('/'), base).toString())
    } catch (error) {
      return { error: error instanceof Error ? error.message : String(error) }
    }
  }
  const listed = await get(SITE_FILES_FILE)
  if ('error' in listed) return { state: 'unreachable', message: `Could not reach ${base} (${listed.error}).` }
  if (
    (listed.status >= 300 && listed.status < 400 && ACCESS_HOSTS.test(listed.location ?? '')) ||
    listed.status === 401 ||
    listed.status === 403
  ) {
    return { state: 'behind-access' }
  }
  if (listed.status === 404) return { state: 'empty' }
  if (!listed.ok) return { state: 'unreachable', message: `${base}${SITE_FILES_FILE} answered HTTP ${listed.status}.` }
  let files: ListedFile[]
  try {
    const raw = JSON.parse((await listed.bytes()).toString('utf8')) as { files?: unknown }
    files = (Array.isArray(raw.files) ? raw.files : []).filter(
      (entry): entry is ListedFile =>
        !!entry &&
        typeof (entry as ListedFile).path === 'string' &&
        typeof (entry as ListedFile).sha256 === 'string' &&
        /^[0-9a-f]{64}$/.test((entry as ListedFile).sha256) &&
        isContained((entry as ListedFile).path),
    )
  } catch {
    // A sign-in page served as 200 is the other way Access answers.
    return { state: 'behind-access' }
  }

  /**
   * Fetch the files into `into`, each checked against its digest, at its
   * path less `strip`; a file the copy already has, byte for byte, is copied
   * rather than fetched. A failure names the file.
   */
  const fetchInto = async (into: string, wanted: ListedFile[], strip = ''): Promise<string | null> => {
    for (const file of wanted) {
      const target = join(into, ...file.path.slice(strip.length).split('/'))
      const local = await readLocal(join(dir, ...file.path.split('/')))
      let bytes = local && sha256(local) === file.sha256 ? local : null
      if (!bytes) {
        const answer = await get(file.path)
        if ('error' in answer || !answer.ok) {
          return `${file.path} could not be read from ${base}${'error' in answer ? ` (${answer.error})` : ` (HTTP ${answer.status})`}.`
        }
        bytes = await answer.bytes()
        if (sha256(bytes) !== file.sha256)
          return `${file.path} from ${base} is not the file the site lists; it changed while it was read. Try again.`
      }
      await mkdir(dirname(target), { recursive: true })
      await writeFile(target, bytes)
    }
    return null
  }

  const incoming = `${dir}.incoming`
  await rm(incoming, { recursive: true, force: true })
  try {
    const hasCopy = (await readLocal(join(dir, MANIFEST_FILE))) !== null
    if (!hasCopy) {
      const failed = await fetchInto(incoming, files)
      if (failed) return { state: 'unreachable', message: failed }
      await mkdir(dirname(dir), { recursive: true })
      await rm(dir, { recursive: true, force: true })
      await rename(incoming, dir)
      const slugs = new Set(
        files
          .map((file) => file.path.split('/'))
          .filter((p) => p[0] === ARTIFACTS_DIR)
          .map((p) => p[1]),
      )
      return { state: 'rebuilt', artifacts: slugs.size }
    }

    const bySlug = new Map<string, ListedFile[]>()
    for (const file of files) {
      const [top, slug] = file.path.split('/')
      if (top !== ARTIFACTS_DIR || !slug || !SLUG_PATTERN.test(slug)) continue
      bySlug.set(slug, [...(bySlug.get(slug) ?? []), file])
    }
    const taken: string[] = []
    for (const [slug, slugFiles] of bySlug) {
      const metaFile = slugFiles.find((file) => file.path === `${ARTIFACTS_DIR}/${slug}/${META_FILE}`)
      if (!metaFile) continue
      const localMeta = await readLocal(join(dir, ARTIFACTS_DIR, slug, META_FILE))
      const local = recordVersion(localMeta)
      if (localMeta && sha256(localMeta) === metaFile.sha256) continue
      const metaAnswer = await get(metaFile.path)
      if ('error' in metaAnswer || !metaAnswer.ok) {
        return { state: 'unreachable', message: `${metaFile.path} could not be read from ${base}.` }
      }
      const live = recordVersion(await metaAnswer.bytes())
      if (!live || !liveIsNewer(live, local)) continue
      const staged = join(incoming, slug)
      const failed = await fetchInto(staged, slugFiles, `${ARTIFACTS_DIR}/${slug}/`)
      if (failed) return { state: 'unreachable', message: failed }
      taken.push(slug)
    }
    for (const slug of taken) {
      await rm(join(dir, ARTIFACTS_DIR, slug), { recursive: true, force: true })
      await mkdir(join(dir, ARTIFACTS_DIR), { recursive: true })
      await rename(join(incoming, slug), join(dir, ARTIFACTS_DIR, slug))
    }
    return { state: 'merged', taken }
  } finally {
    await rm(incoming, { recursive: true, force: true })
  }
}
