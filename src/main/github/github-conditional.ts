// Conditional REST reads through `gh api`, and the one the watch makes: which
// checks a base branch requires.
//
// A REST answer carries an `ETag`. Asked again with `If-None-Match: <etag>`,
// GitHub answers 304 when nothing changed, and a 304 to an authorised request
// is not charged against the rate limit. So each URL's last ETag and body are
// kept ({@link ConditionalCache}), and a repeat read of something that has not
// moved costs a round trip and no quota.
//
// `gh api -i` prints the status line and headers before the body. On a 304 gh
// exits non-zero ("HTTP 304") with the headers on stdout, which is why the
// failed outcome keeps its stdout (`runGh`). Every answer's `x-ratelimit-*`
// headers are handed to `onQuota`, 304s included, so the quota tracker
// (`github-quota.ts`) learns what is left at no cost.

import { runGh, type BranchPullRequestDeps, type PullRequestReadFailure } from './branch-pull-request'
import { quotaFromHeaders, type GitHubQuotaReading } from './github-quota'

/** The most URLs a conditional cache remembers; the least recently used go first. */
export const MAX_CONDITIONAL_CACHE_ENTRIES = 200

/** URL → the ETag and body of its last 200. */
export type ConditionalCache = Map<string, { etag: string; body: string }>

export type ConditionalAnswer =
  | { ok: true; status: number; body: string; notModified: boolean }
  | { ok: false; status: number | null; reason: PullRequestReadFailure }

export type ConditionalDeps = BranchPullRequestDeps & {
  onQuota?: (host: string, reading: GitHubQuotaReading) => void
}

const SAFE_HOST = /^[a-z0-9.-]+(?::\d+)?$/i

/**
 * `GET <path>` on `host`, conditional on the cached ETag. A 304 answers with
 * the cached body. A non-2xx status other than 304 is a failure with its
 * status, so a caller can tell "not there" (404) from "could not ask".
 */
export async function ghApiConditional(
  host: string,
  path: string,
  cache: ConditionalCache,
  deps: ConditionalDeps = {},
): Promise<ConditionalAnswer> {
  if (!SAFE_HOST.test(host) || path.startsWith('-')) return { ok: false, status: null, reason: 'bad-request' }
  const key = `${host}\0${path}`
  const cached = cache.get(key)
  const args = ['api', '-i', '--hostname', host]
  if (cached) args.push('-H', `If-None-Match: ${cached.etag}`)
  args.push(path)
  const outcome = await runGh(args, {}, deps)
  const printed = outcome.ok ? outcome.stdout : (outcome.stdout ?? '')
  const response = parseIncludedResponse(printed)
  if (response) {
    const reading = quotaFromHeaders(response.headers)
    if (reading) deps.onQuota?.(host.replace(/:\d+$/, '').toLowerCase(), reading)
  }
  if (!response) return { ok: false, status: null, reason: outcome.ok ? 'bad-output' : outcome.reason }
  if (response.status === 304 && cached) {
    remember(cache, key, cached)
    return { ok: true, status: 304, body: cached.body, notModified: true }
  }
  if (response.status >= 200 && response.status < 300) {
    const etag = response.headers.get('etag')
    if (etag) remember(cache, key, { etag, body: response.body })
    else cache.delete(key)
    return { ok: true, status: response.status, body: response.body, notModified: false }
  }
  return { ok: false, status: response.status, reason: outcome.ok ? 'gh-failed' : outcome.reason }
}

function remember(cache: ConditionalCache, key: string, value: { etag: string; body: string }): void {
  cache.delete(key)
  cache.set(key, value)
  while (cache.size > MAX_CONDITIONAL_CACHE_ENTRIES) {
    const oldest = cache.keys().next().value
    if (oldest === undefined) break
    cache.delete(oldest)
  }
}

/** `gh api -i`'s output → status, lower-cased headers and body. Null when it does not start with a status line. Exported for the test. */
export function parseIncludedResponse(
  printed: string,
): { status: number; headers: Map<string, string>; body: string } | null {
  const statusLine = /^HTTP\/[\d.]+ (\d{3})\b[^\n]*\r?\n/.exec(printed)
  if (!statusLine) return null
  const rest = printed.slice(statusLine[0].length)
  const split = /\r?\n\r?\n/.exec(rest)
  const headerText = split ? rest.slice(0, split.index) : rest
  const body = split ? rest.slice(split.index + split[0].length) : ''
  const headers = new Map<string, string>()
  for (const line of headerText.split(/\r?\n/)) {
    const colon = line.indexOf(':')
    if (colon <= 0) continue
    headers.set(line.slice(0, colon).trim().toLowerCase(), line.slice(colon + 1).trim())
  }
  return { status: Number(statusLine[1]), headers, body }
}

// ── Required checks ─────────────────────────────────────────────────────────

/**
 * How long one repository and base branch's required checks are taken as
 * read: every watched pull request on that base asks inside one sweep, and
 * one answer serves them all.
 */
export const REQUIRED_CHECKS_FRESH_MS = 60_000

export type RequiredChecksTarget = { host: string; owner: string; repo: string; base: string }

export type RequiredChecksReader = {
  /**
   * The names of the checks `base` requires, from its branch protection and
   * its rulesets; empty when it requires none. Null when that could not be
   * read: the caller asks another way.
   */
  read(target: RequiredChecksTarget, deps?: BranchPullRequestDeps): Promise<Set<string> | null>
}

const SAFE_SEGMENT = /^[A-Za-z0-9_.-]{1,100}$/

/**
 * Required checks per repository and base branch, through two conditional
 * reads: `GET /repos/{o}/{r}/branches/{base}` (classic branch protection,
 * which any reader of the repository may see) and
 * `GET /repos/{o}/{r}/rules/branches/{base}` (rulesets, the repository's and
 * its organisation's). A host with no rulesets (an older GitHub Enterprise
 * Server) answers the second with 404, which is none.
 */
export function createRequiredChecksReader(
  options: { now?: () => number; onQuota?: (host: string, reading: GitHubQuotaReading) => void } = {},
): RequiredChecksReader {
  const now = options.now ?? (() => Date.now())
  const cache: ConditionalCache = new Map()
  const answers = new Map<string, { at: number; names: Set<string> }>()
  const inFlight = new Map<string, Promise<Set<string> | null>>()

  async function ask(target: RequiredChecksTarget, deps: BranchPullRequestDeps): Promise<Set<string> | null> {
    const base = target.base
      .split('/')
      .map((segment) => encodeURIComponent(segment))
      .join('/')
    const conditional = { ...deps, ...(options.onQuota ? { onQuota: options.onQuota } : {}) }
    const repo = `repos/${target.owner}/${target.repo}`
    const branch = await ghApiConditional(target.host, `${repo}/branches/${base}`, cache, conditional)
    if (!branch.ok) return null
    const fromProtection = parseBranchProtection(branch.body)
    if (fromProtection === null) return null
    const rules = await ghApiConditional(target.host, `${repo}/rules/branches/${base}`, cache, conditional)
    if (!rules.ok && rules.status !== 404) return null
    const fromRules = rules.ok ? parseRulesets(rules.body) : []
    if (fromRules === null) return null
    return new Set([...fromProtection, ...fromRules])
  }

  return {
    async read(target, deps = {}) {
      if (
        !SAFE_HOST.test(target.host) ||
        !SAFE_SEGMENT.test(target.owner) ||
        !SAFE_SEGMENT.test(target.repo) ||
        !target.base ||
        target.base.startsWith('-')
      )
        return null
      const key = `${target.host}\0${target.owner}/${target.repo}\0${target.base}`.toLowerCase()
      const known = answers.get(key)
      if (known && now() - known.at < REQUIRED_CHECKS_FRESH_MS) return known.names
      const running = inFlight.get(key)
      if (running) return running
      const asked = ask(target, deps)
        .then((names) => {
          if (names) answers.set(key, { at: now(), names })
          else answers.delete(key)
          return names
        })
        .finally(() => inFlight.delete(key))
      inFlight.set(key, asked)
      return asked
    },
  }
}

/** A branch's `protection.required_status_checks` → the check names it requires. Exported for the test. */
export function parseBranchProtection(body: string): string[] | null {
  const json = parse(body)
  if (!isObject(json)) return null
  const protection = json.protection
  if (!isObject(protection)) return []
  const required = protection.required_status_checks
  if (!isObject(required) || required.enforcement_level === 'off') return []
  const names = new Set<string>()
  for (const context of Array.isArray(required.contexts) ? required.contexts : [])
    if (typeof context === 'string' && context) names.add(context)
  for (const check of Array.isArray(required.checks) ? required.checks : [])
    if (isObject(check) && typeof check.context === 'string' && check.context) names.add(check.context)
  return [...names]
}

/** A branch's active rules → the check names its `required_status_checks` rules require. Exported for the test. */
export function parseRulesets(body: string): string[] | null {
  const json = parse(body)
  if (!Array.isArray(json)) return null
  const names = new Set<string>()
  for (const rule of json) {
    if (!isObject(rule) || rule.type !== 'required_status_checks' || !isObject(rule.parameters)) continue
    const checks = rule.parameters.required_status_checks
    for (const check of Array.isArray(checks) ? checks : [])
      if (isObject(check) && typeof check.context === 'string' && check.context) names.add(check.context)
  }
  return [...names]
}

function parse(body: string): unknown {
  try {
    return JSON.parse(body) as unknown
  } catch {
    return undefined
  }
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}
