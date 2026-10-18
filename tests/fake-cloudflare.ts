import type { CloudflareFetch } from '../src/main/artifacts/cloudflare-pages-client'
import type { SiteFetch } from '../src/main/artifacts/cloudflare-live-copy'

// A stand-in for the parts of Cloudflare's API the artifacts use: accounts,
// a Pages project (found, made, or someone else's), Direct Upload, and the
// deployments list. It records every call; nothing leaves the machine.

export const FAKE_TOKEN = 'cf-test-token-0123456789abcdef'
export const ACCOUNT_ACME = '0123456789abcdef0123456789abcdef'
export const ACCOUNT_OTHER = 'fedcba9876543210fedcba9876543210'

export type FakeCall = { method: string; path: string; bearer: string; body: unknown }

export type FakeProject = {
  name: string
  subdomain: string
  domains: string[]
  source: { type: string } | null
  deployments: Array<{ id: string; commit_message: string; manifest?: Record<string, string> }>
}

export type FakeCloudflareOptions = {
  accounts?: Array<{ id: string; name: string }>
  /** Projects that exist already, by name. */
  projects?: FakeProject[]
  /** Deployments refused before one goes through. */
  failDeployments?: number
  /** The project appears between the lookup and the create, as another machine made it. */
  createRaces?: boolean
}

export function fakeCloudflare(options: FakeCloudflareOptions = {}) {
  const calls: FakeCall[] = []
  const stored = new Map<string, Buffer>()
  const accounts = options.accounts ?? [{ id: ACCOUNT_ACME, name: 'Acme' }]
  const projects = new Map<string, FakeProject>((options.projects ?? []).map((project) => [project.name, project]))
  let failDeployments = options.failDeployments ?? 0
  let raced = false
  const reply = (status: number, body: unknown) => ({ ok: status < 300, status, json: async () => body })
  const projectBody = (project: FakeProject) => ({
    name: project.name,
    subdomain: project.subdomain,
    domains: project.domains,
    production_branch: 'main',
    source: project.source,
  })
  const fetch: CloudflareFetch = async (url, init) => {
    const path = url.replace(/^https:\/\/api\.cloudflare\.com\/client\/v4\//, '')
    const bearer = init.headers.Authorization?.replace(/^Bearer /, '') ?? ''
    let body: unknown = init.body
    if (typeof init.body === 'string') body = JSON.parse(init.body)
    if (init.body instanceof FormData) {
      body = Object.fromEntries([...init.body.entries()].map(([key, value]) => [key, String(value)]))
    }
    calls.push({ method: init.method, path, bearer, body })
    if (path.startsWith('pages/assets/')) {
      if (bearer !== 'upload-jwt')
        return reply(403, { success: false, errors: [{ code: 10000, message: 'Authentication error' }] })
      if (path === 'pages/assets/check-missing') {
        const hashes = (body as { hashes: string[] }).hashes
        return reply(200, { success: true, result: hashes.filter((hash) => !stored.has(hash)) })
      }
      if (path === 'pages/assets/upload') {
        for (const file of body as Array<{ key: string; value: string }>)
          stored.set(file.key, Buffer.from(file.value, 'base64'))
        return reply(200, { success: true, result: null })
      }
      return reply(200, { success: true, result: null })
    }
    if (bearer !== FAKE_TOKEN)
      return reply(401, { success: false, errors: [{ code: 10000, message: 'Authentication error' }] })
    if (path.startsWith('accounts?')) return reply(200, { success: true, result: accounts })
    const match = /^accounts\/([0-9a-f]{32})\/pages\/projects(?:\/([a-z0-9-]+))?(\/[a-z-]+)?(\?.*)?$/.exec(path)
    if (!match || !accounts.some((account) => account.id === match[1])) {
      return reply(404, { success: false, errors: [{ code: 7003, message: `No route for ${path}` }] })
    }
    const [, , name, sub] = match
    if (!name && init.method === 'POST') {
      const wanted = (body as { name: string }).name
      if (projects.has(wanted))
        return reply(409, {
          success: false,
          errors: [{ code: 8000002, message: 'A project with this name already exists.' }],
        })
      const project: FakeProject = {
        name: wanted,
        subdomain: `${wanted}.pages.dev`,
        domains: [`${wanted}.pages.dev`],
        source: null,
        deployments: [],
      }
      projects.set(wanted, project)
      return reply(200, { success: true, result: projectBody(project) })
    }
    if (!name) return reply(404, { success: false, errors: [{ code: 7003, message: 'No route' }] })
    let project = projects.get(name)
    if (!project) {
      if (options.createRaces && !raced) {
        raced = true
        // Someone else makes it now: this lookup misses, the create collides.
        projects.set(name, {
          name,
          subdomain: `${name}-a1b.pages.dev`,
          domains: [`${name}-a1b.pages.dev`],
          source: null,
          deployments: [],
        })
      }
      return reply(404, { success: false, errors: [{ code: 8000007, message: 'Project not found' }] })
    }
    if (!sub) return reply(200, { success: true, result: projectBody(project) })
    if (sub === '/upload-token') return reply(200, { success: true, result: { jwt: 'upload-jwt' } })
    if (sub === '/deployments' && init.method === 'GET') {
      const latest = project.deployments[project.deployments.length - 1]
      return reply(200, {
        success: true,
        result: latest
          ? [{ id: latest.id, deployment_trigger: { metadata: { commit_message: latest.commit_message } } }]
          : [],
      })
    }
    if (sub === '/deployments' && init.method === 'POST') {
      if (failDeployments > 0) {
        failDeployments -= 1
        return reply(500, { success: false, errors: [{ code: 8000000, message: 'Internal error' }] })
      }
      const form = body as Record<string, string>
      const deployment = {
        id: `dep-${project.deployments.length + 1}`,
        commit_message: form.commit_message,
        manifest: JSON.parse(form.manifest),
      }
      project.deployments.push(deployment)
      project = projects.get(name) as FakeProject
      return reply(200, {
        success: true,
        result: { id: deployment.id, url: `https://${deployment.id}.${project.subdomain}` },
      })
    }
    return reply(404, { success: false, errors: [{ code: 7003, message: `No route for ${path}` }] })
  }
  /**
   * The live site of a project: its latest deployment's files, as Pages
   * serves them. Behind Access, every request is sent to the sign-in page.
   */
  const siteFetch =
    (name: string, behindAccess = false): SiteFetch =>
    async (url) => {
      const reply = (status: number, bytes: Buffer, location: string | null = null) => ({
        ok: status < 300,
        status,
        location,
        bytes: async () => bytes,
      })
      if (behindAccess) return reply(302, Buffer.alloc(0), 'https://acme.cloudflareaccess.com/cdn-cgi/access/login')
      const deployments = projects.get(name)?.deployments ?? []
      const latest = deployments[deployments.length - 1]
      const path = decodeURIComponent(new URL(url).pathname)
      const hash = latest?.manifest?.[path]
      const bytes = hash ? stored.get(hash) : undefined
      return bytes ? reply(200, bytes) : reply(404, Buffer.from('Not found'))
    }
  return {
    fetch,
    siteFetch,
    /** Refuse the next `count` deployments, as a Pages outage would. */
    refuseDeployments(count: number) {
      failDeployments = count
    },
    /** How many times each file (by content key) was uploaded. */
    uploadCounts(): Map<string, number> {
      const counts = new Map<string, number>()
      for (const call of calls.filter((entry) => entry.path === 'pages/assets/upload')) {
        for (const file of call.body as Array<{ key: string }>) counts.set(file.key, (counts.get(file.key) ?? 0) + 1)
      }
      return counts
    },
    calls,
    projects,
    stored,
    deployments: (name: string) => projects.get(name)?.deployments ?? [],
    /** Calls that change something on Cloudflare. */
    writes: () => calls.filter((call) => call.method !== 'GET' && call.path !== 'pages/assets/check-missing'),
  }
}
