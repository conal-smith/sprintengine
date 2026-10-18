import { createHash } from 'node:crypto'
import { extname } from 'node:path'

// Cloudflare Pages, spoken to directly: no CI, no Wrangler, nothing installed.
// A deployment is a whole snapshot of the site, uploaded the way Pages' Direct
// Upload takes one:
//
//   1. GET  accounts/:account/pages/projects/:project/upload-token → a JWT for the asset API
//   2. POST pages/assets/check-missing  { hashes }  → which files Pages does not have yet
//   3. POST pages/assets/upload         [ { key, value (base64), metadata, base64 } ] in buckets
//   4. POST pages/assets/upsert-hashes  { hashes }  → keep every file of this snapshot
//   5. POST accounts/:account/pages/projects/:project/deployments (multipart: the manifest)
//
// Files are content-addressed, so a publish that adds one artifact uploads that
// artifact's files and nothing else, however big the gallery has grown. A dry
// run stops after step 2 and says what it would have uploaded.
//
// The API token is read only to put it in the Authorization header. It is never
// in a message this module returns or throws: Cloudflare's own error text is
// passed on, and that does not echo the token.

export const CLOUDFLARE_API_BASE = 'https://api.cloudflare.com/client/v4'

export type CloudflareFetch = (
  url: string,
  init: { method: string; headers: Record<string, string>; body?: string | FormData },
) => Promise<{
  ok: boolean
  status: number
  json(): Promise<unknown>
}>

export type CloudflarePagesFile = { path: string; bytes: Buffer }

export type CloudflareProject = {
  name: string
  subdomain: string | null
  domains: string[]
  productionBranch: string
  /** `github`/`gitlab` for a project that builds from its own git connection, which takes no direct upload. */
  sourceType: string | null
}

export type CloudflareDeployResult =
  | { ok: true; dryRun: boolean; files: number; uploaded: number; deploymentId: string | null; url: string | null }
  | { ok: false; message: string }

/** Every deployment Studio makes says so first, so a project it finds can be told apart from someone else's. */
export const STUDIO_DEPLOYMENT_PREFIX = 'SprintEngine Studio artifacts'

export type CloudflarePagesClient = {
  verifyToken(): Promise<{ ok: true } | { ok: false; message: string }>
  project(): Promise<{ ok: true; project: CloudflareProject } | { ok: false; status: number; message: string }>
  /** Make the project, for Direct Upload, publishing from main. 409: it exists already. */
  createProject(): Promise<{ ok: true; project: CloudflareProject } | { ok: false; status: number; message: string }>
  /** The project's latest deployment, if any: its id, and whether Studio made it. */
  latestDeployment(): Promise<
    | { ok: true; deployed: false }
    | { ok: true; deployed: true; id: string; studios: boolean }
    | { ok: false; message: string }
  >
  deploy(
    files: CloudflarePagesFile[],
    options: { commitMessage: string; commitHash?: string | null; dryRun?: boolean },
  ): Promise<CloudflareDeployResult>
}

/** The most one upload request carries, under Pages' own limits for a request. */
const BUCKET_BYTES = 40 * 1024 * 1024
const BUCKET_FILES = 1000
const MAX_FILE_BYTES = 25 * 1024 * 1024
const MAX_FILES = 20_000

const CONTENT_TYPES: Record<string, string> = {
  '.html': 'text/html',
  '.htm': 'text/html',
  '.css': 'text/css',
  '.js': 'application/javascript',
  '.mjs': 'application/javascript',
  '.json': 'application/json',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
  '.avif': 'image/avif',
  '.ico': 'image/x-icon',
  '.woff': 'font/woff',
  '.woff2': 'font/woff2',
  '.ttf': 'font/ttf',
  '.otf': 'font/otf',
  '.txt': 'text/plain',
  '.md': 'text/markdown',
  '.mp4': 'video/mp4',
  '.webm': 'video/webm',
  '.mp3': 'audio/mpeg',
  '.wasm': 'application/wasm',
}

export function contentTypeOf(path: string): string {
  return CONTENT_TYPES[extname(path).toLowerCase()] ?? 'application/octet-stream'
}

/** A file's key in Pages' asset store: a digest of its content and its extension, 32 hex characters. */
export function cloudflareAssetHash(path: string, bytes: Buffer): string {
  return createHash('sha256').update(bytes.toString('base64')).update(extname(path).slice(1)).digest('hex').slice(0, 32)
}

type Envelope = { success?: boolean; errors?: Array<{ code?: number; message?: string }>; result?: unknown }

function envelopeOf(value: unknown): Envelope {
  return value && typeof value === 'object' ? (value as Envelope) : {}
}

/** Cloudflare's own words for a failure, which never carry the token. */
function cloudflareError(status: number, envelope: Envelope, what: string): string {
  const said = (envelope.errors ?? [])
    .map((error) => [error.message, error.code ? `(${error.code})` : ''].filter(Boolean).join(' '))
    .filter(Boolean)
    .join('; ')
  if (status === 401 || status === 403) {
    return `Cloudflare refused the API token to ${what}${said ? `: ${said}` : ''}. Check it is current and has Cloudflare Pages Edit permission on this account.`
  }
  return `Cloudflare could not ${what} (HTTP ${status}${said ? `: ${said}` : ''}).`
}

/**
 * The accounts a token can see. An empty list is a token made without an
 * account in its scope: the person makes another, with Pages edit on one.
 */
export async function listCloudflareAccounts(input: {
  token: string
  fetch?: CloudflareFetch
  apiBase?: string
}): Promise<{ ok: true; accounts: Array<{ id: string; name: string }> } | { ok: false; message: string }> {
  const fetchImpl: CloudflareFetch = input.fetch ?? ((url, init) => fetch(url, init))
  let response: Awaited<ReturnType<CloudflareFetch>>
  try {
    response = await fetchImpl(`${input.apiBase ?? CLOUDFLARE_API_BASE}/accounts?per_page=50`, {
      method: 'GET',
      headers: { Authorization: `Bearer ${input.token}` },
    })
  } catch (error) {
    return {
      ok: false,
      message: `Could not reach Cloudflare (${error instanceof Error ? error.message : 'the request failed'}).`,
    }
  }
  const envelope = envelopeOf(await response.json().catch(() => ({})))
  if (!response.ok || envelope.success === false) {
    return { ok: false, message: cloudflareError(response.status, envelope, 'list the accounts it can use') }
  }
  const accounts = (Array.isArray(envelope.result) ? envelope.result : [])
    .map((entry) => envelopeOf(entry) as Record<string, unknown>)
    .filter((entry) => typeof entry.id === 'string' && /^[0-9a-f]{32}$/i.test(entry.id))
    .map((entry) => ({
      id: String(entry.id).toLowerCase(),
      name: typeof entry.name === 'string' ? entry.name : String(entry.id),
    }))
  return { ok: true, accounts }
}

export function createCloudflarePagesClient(input: {
  accountId: string
  projectName: string
  token: () => Promise<string>
  fetch?: CloudflareFetch
  apiBase?: string
}): CloudflarePagesClient {
  const base = input.apiBase ?? CLOUDFLARE_API_BASE
  const fetchImpl: CloudflareFetch = input.fetch ?? ((url, init) => fetch(url, init))
  const account = encodeURIComponent(input.accountId)
  const projectPath = encodeURIComponent(input.projectName)

  async function call(
    method: string,
    path: string,
    what: string,
    options: { bearer?: string; json?: unknown; form?: FormData } = {},
  ): Promise<{ ok: true; result: unknown } | { ok: false; status: number; message: string }> {
    const bearer = options.bearer ?? (await input.token())
    if (!bearer)
      return { ok: false, status: 0, message: 'No Cloudflare API token is saved. Add one on Settings ▸ Artifacts.' }
    const headers: Record<string, string> = { Authorization: `Bearer ${bearer}` }
    let body: string | FormData | undefined
    if (options.json !== undefined) {
      headers['Content-Type'] = 'application/json'
      body = JSON.stringify(options.json)
    } else if (options.form) {
      body = options.form
    }
    let response: Awaited<ReturnType<CloudflareFetch>>
    try {
      response = await fetchImpl(`${base}/${path}`, { method, headers, ...(body !== undefined ? { body } : {}) })
    } catch (error) {
      const reason = error instanceof Error ? error.message : 'the request failed'
      return { ok: false, status: 0, message: `Could not reach Cloudflare to ${what} (${reason}).` }
    }
    const envelope = envelopeOf(await response.json().catch(() => ({})))
    if (!response.ok || envelope.success === false) {
      return { ok: false, status: response.status, message: cloudflareError(response.status, envelope, what) }
    }
    return { ok: true, result: envelope.result }
  }

  function projectOf(raw: unknown): CloudflareProject {
    const result = envelopeOf(raw) as Record<string, unknown>
    const source =
      result.source && typeof result.source === 'object' ? (result.source as Record<string, unknown>) : null
    return {
      name: typeof result.name === 'string' ? result.name : input.projectName,
      subdomain: typeof result.subdomain === 'string' ? result.subdomain : null,
      domains: Array.isArray(result.domains) ? result.domains.filter((d): d is string => typeof d === 'string') : [],
      productionBranch: typeof result.production_branch === 'string' ? result.production_branch : 'main',
      sourceType: source && typeof source.type === 'string' ? source.type : null,
    }
  }

  async function project(): Promise<
    { ok: true; project: CloudflareProject } | { ok: false; status: number; message: string }
  > {
    const answered = await call(
      'GET',
      `accounts/${account}/pages/projects/${projectPath}`,
      `find the Pages project "${input.projectName}"`,
    )
    if (!answered.ok) {
      if (answered.status === 404) {
        return {
          ok: false,
          status: 404,
          message: `The account has no Pages project named "${input.projectName}".`,
        }
      }
      return answered
    }
    return { ok: true, project: projectOf(answered.result) }
  }

  return {
    async createProject() {
      const answered = await call(
        'POST',
        `accounts/${account}/pages/projects`,
        `make the Pages project "${input.projectName}"`,
        {
          json: { name: input.projectName, production_branch: 'main' },
        },
      )
      return answered.ok ? { ok: true, project: projectOf(answered.result) } : answered
    },

    async latestDeployment() {
      const answered = await call(
        'GET',
        `accounts/${account}/pages/projects/${projectPath}/deployments?per_page=1`,
        `read the project "${input.projectName}"'s deployments`,
      )
      if (!answered.ok) return { ok: false, message: answered.message }
      const list = Array.isArray(answered.result) ? answered.result : []
      if (list.length === 0) return { ok: true, deployed: false }
      const latest = envelopeOf(list[0]) as Record<string, unknown>
      const trigger = latest.deployment_trigger as { metadata?: { commit_message?: unknown } } | undefined
      const message = trigger?.metadata?.commit_message
      return {
        ok: true,
        deployed: true,
        id: typeof latest.id === 'string' ? latest.id : '',
        studios: typeof message === 'string' && message.startsWith(STUDIO_DEPLOYMENT_PREFIX),
      }
    },

    async verifyToken() {
      const user = await call('GET', 'user/tokens/verify', 'check the API token')
      if (user.ok) {
        const status = (envelopeOf(user.result) as Record<string, unknown>).status
        return status === 'active'
          ? { ok: true }
          : { ok: false, message: `The API token is ${String(status ?? 'not active')}.` }
      }
      // An account-owned token is checked against its account instead.
      const owned = await call('GET', `accounts/${account}/tokens/verify`, 'check the API token')
      if (owned.ok) {
        const status = (envelopeOf(owned.result) as Record<string, unknown>).status
        return status === 'active'
          ? { ok: true }
          : { ok: false, message: `The API token is ${String(status ?? 'not active')}.` }
      }
      return { ok: false, message: user.message }
    },

    project,

    async deploy(files, options) {
      if (files.length === 0) return { ok: false, message: 'There is nothing to upload.' }
      if (files.length > MAX_FILES)
        return { ok: false, message: `Pages takes at most ${MAX_FILES} files; the site has ${files.length}.` }
      const tooBig = files.find((file) => file.bytes.length > MAX_FILE_BYTES)
      if (tooBig) return { ok: false, message: `${tooBig.path} is over Pages' limit of 25 MB a file.` }

      const found = await project()
      if (!found.ok) return { ok: false, message: found.message }
      if (found.project.sourceType) {
        return {
          ok: false,
          message: `The Pages project "${input.projectName}" deploys from its own ${found.project.sourceType} connection, which takes no direct upload. Use a project created with Direct Upload.`,
        }
      }

      const tokenAnswer = await call(
        'GET',
        `accounts/${account}/pages/projects/${projectPath}/upload-token`,
        'start an upload',
      )
      if (!tokenAnswer.ok) return { ok: false, message: tokenAnswer.message }
      const jwt = (envelopeOf(tokenAnswer.result) as Record<string, unknown>).jwt
      if (typeof jwt !== 'string' || !jwt) return { ok: false, message: 'Cloudflare did not hand out an upload token.' }

      const manifest: Record<string, string> = {}
      const byHash = new Map<string, CloudflarePagesFile>()
      for (const file of files) {
        const hash = cloudflareAssetHash(file.path, file.bytes)
        manifest[`/${file.path.replace(/^\/+/, '')}`] = hash
        byHash.set(hash, file)
      }
      const hashes = [...byHash.keys()]

      const missingAnswer = await call('POST', 'pages/assets/check-missing', 'compare the site with what Pages has', {
        bearer: jwt,
        json: { hashes },
      })
      if (!missingAnswer.ok) return { ok: false, message: missingAnswer.message }
      const missing = Array.isArray(missingAnswer.result)
        ? missingAnswer.result.filter((hash): hash is string => typeof hash === 'string' && byHash.has(hash))
        : hashes
      if (options.dryRun) {
        return { ok: true, dryRun: true, files: files.length, uploaded: missing.length, deploymentId: null, url: null }
      }

      let bucket: Array<{ key: string; value: string; metadata: { contentType: string }; base64: true }> = []
      let bucketBytes = 0
      const flush = async (): Promise<string | null> => {
        if (!bucket.length) return null
        const sent = await call('POST', 'pages/assets/upload', 'upload the files', { bearer: jwt, json: bucket })
        bucket = []
        bucketBytes = 0
        return sent.ok ? null : sent.message
      }
      for (const hash of missing) {
        const file = byHash.get(hash)
        if (!file) continue
        const value = file.bytes.toString('base64')
        if (bucket.length && (bucketBytes + value.length > BUCKET_BYTES || bucket.length >= BUCKET_FILES)) {
          const failed = await flush()
          if (failed) return { ok: false, message: failed }
        }
        bucket.push({ key: hash, value, metadata: { contentType: contentTypeOf(file.path) }, base64: true })
        bucketBytes += value.length
      }
      const failed = await flush()
      if (failed) return { ok: false, message: failed }

      const kept = await call('POST', 'pages/assets/upsert-hashes', 'keep the uploaded files', {
        bearer: jwt,
        json: { hashes },
      })
      if (!kept.ok) return { ok: false, message: kept.message }

      const form = new FormData()
      form.append('manifest', JSON.stringify(manifest))
      form.append('branch', found.project.productionBranch)
      form.append('commit_message', options.commitMessage.slice(0, 380))
      if (options.commitHash) form.append('commit_hash', options.commitHash)
      form.append('commit_dirty', options.commitHash ? 'false' : 'true')
      const deployed = await call(
        'POST',
        `accounts/${account}/pages/projects/${projectPath}/deployments`,
        'create the deployment',
        {
          form,
        },
      )
      if (!deployed.ok) return { ok: false, message: deployed.message }
      const result = envelopeOf(deployed.result) as Record<string, unknown>
      return {
        ok: true,
        dryRun: false,
        files: files.length,
        uploaded: missing.length,
        deploymentId: typeof result.id === 'string' ? result.id : null,
        url: typeof result.url === 'string' ? result.url : null,
      }
    },
  }
}
