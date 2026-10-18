import type { GhApi, GhApiRequest } from '../src/main/artifacts/github-pages'

// A stand-in for `gh api` on a GitHub host, for the Pages endpoints the
// artifacts use. It records every call; nothing leaves the machine.

export type FakeGitHubOptions = {
  /** Pages is on already, serving this address. */
  pagesUrl?: string
  /** What turning Pages on answers instead of turning it on. */
  enableFails?: { status: number; message: string }
  /** Builds still running before one finishes, read by builds/latest. */
  buildingPolls?: number
  buildErrors?: boolean
  /** Another machine turns Pages on while this one asks. */
  enableRaces?: boolean
  /** The address GitHub gives when it turns Pages on. */
  enabledUrl?: string
  notInstalled?: boolean
}

export function fakeGitHub(options: FakeGitHubOptions = {}) {
  const calls: Array<{ host: string; path: string; method: string; fields: Record<string, string> }> = []
  let pages: { url: string; status: string | null } | null = options.pagesUrl
    ? { url: options.pagesUrl, status: 'built' }
    : null
  let building = options.buildingPolls ?? 0
  const gh: GhApi = async (host: string, path: string, request?: GhApiRequest) => {
    const method = request?.method ?? 'GET'
    calls.push({ host, path, method, fields: request?.fields ?? {} })
    if (options.notInstalled) return { ok: false, status: null, message: 'gh is not installed', notInstalled: true }
    if (path.endsWith('/pages') && method === 'GET') {
      return pages
        ? {
            ok: true,
            status: 200,
            json: { html_url: pages.url, status: pages.status, source: { branch: 'main', path: '/' } },
          }
        : { ok: false, status: 404, message: 'Not Found' }
    }
    if (path.endsWith('/pages') && method === 'POST') {
      if (options.enableFails) return { ok: false, ...options.enableFails }
      if (options.enableRaces && !pages) {
        pages = { url: options.enabledUrl ?? 'https://acme.github.io/artifacts/', status: null }
        return { ok: false, status: 409, message: 'GitHub Pages is already enabled.' }
      }
      if (pages) return { ok: false, status: 409, message: 'GitHub Pages is already enabled.' }
      pages = { url: options.enabledUrl ?? 'https://acme.github.io/artifacts/', status: null }
      return {
        ok: true,
        status: 201,
        json: { html_url: pages.url, status: null, source: { branch: 'main', path: '/' } },
      }
    }
    if (path.endsWith('/pages/builds/latest')) {
      if (options.buildErrors) return { ok: true, status: 200, json: { status: 'errored' } }
      if (building > 0) {
        building -= 1
        return { ok: true, status: 200, json: { status: 'building' } }
      }
      if (pages) pages.status = 'built'
      return { ok: true, status: 200, json: { status: 'built' } }
    }
    return { ok: false, status: 404, message: 'Not Found' }
  }
  return { gh, calls, enables: () => calls.filter((call) => call.method === 'POST').length }
}
