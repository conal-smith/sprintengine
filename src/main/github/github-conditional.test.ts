// Conditional REST reads: an ETag kept per URL, a 304 answered from what was
// kept, and the required checks a base branch has, read that way.
import assert from 'node:assert/strict'

import { test } from 'vitest'

import type { GhResult, GhRunner } from './gh'
import {
  createRequiredChecksReader,
  ghApiConditional,
  parseIncludedResponse,
  REQUIRED_CHECKS_FRESH_MS,
  type ConditionalCache,
} from './github-conditional'
import type { GitHubQuotaReading } from './github-quota'

const RESET = 1_793_404_939

function printed(status: string, headers: Record<string, string>, body = ''): string {
  const lines = Object.entries(headers).map(([name, value]) => `${name}: ${value}`)
  return `HTTP/2.0 ${status}\r\n${lines.join('\r\n')}\r\n\r\n${body}`
}

const quotaHeaders = (remaining: number) => ({
  'X-Ratelimit-Limit': '5000',
  'X-Ratelimit-Remaining': String(remaining),
  'X-Ratelimit-Reset': String(RESET),
  'X-Ratelimit-Resource': 'core',
})

/** A fake `gh api -i`: answers by path, 304 when the request carries the ETag it last gave. */
function restServer(bodies: Record<string, { status?: string; body: string; etag?: string } | undefined>) {
  const calls: string[][] = []
  let remaining = 4000
  const gh: GhRunner = {
    available: async () => true,
    run: async (args): Promise<GhResult> => {
      calls.push(args)
      const path = args[args.length - 1]!
      const answer = bodies[path]
      const sent = args.includes('-H') ? args[args.indexOf('-H') + 1] : undefined
      if (!answer) {
        return { found: true, code: 1, stdout: printed('404 Not Found', quotaHeaders(--remaining)), stderr: 'HTTP 404' }
      }
      const etag = answer.etag ?? `W/"${answer.body.length}"`
      if (sent === `If-None-Match: ${etag}`) {
        // Not charged: the quota the 304 reports has not moved.
        return {
          found: true,
          code: 1,
          stdout: printed('304 Not Modified', quotaHeaders(remaining)),
          stderr: 'HTTP 304',
        }
      }
      const status = answer.status ?? '200 OK'
      return {
        found: true,
        code: status.startsWith('2') ? 0 : 1,
        stdout: printed(status, { ...quotaHeaders(--remaining), Etag: etag }, answer.body),
        stderr: '',
      }
    },
  }
  return { gh, calls }
}

test('gh api -i output reads as status, headers and body', () => {
  const response = parseIncludedResponse(
    printed('200 OK', { Etag: 'W/"abc"', 'X-Ratelimit-Remaining': '12' }, '{"a":1}'),
  )
  assert.equal(response?.status, 200)
  assert.equal(response?.headers.get('etag'), 'W/"abc"')
  assert.equal(response?.headers.get('x-ratelimit-remaining'), '12')
  assert.equal(response?.body, '{"a":1}')
  assert.equal(parseIncludedResponse('{"a":1}'), null)
})

test('a repeat read sends the ETag, and a 304 answers with what was kept, quota and all', async () => {
  const path = 'repos/acme/app/rules/branches/main'
  const { gh, calls } = restServer({ [path]: { body: '[{"type":"deletion"}]', etag: 'W/"v1"' } })
  const cache: ConditionalCache = new Map()
  const quotas: Array<[string, GitHubQuotaReading]> = []
  const deps = { gh, onQuota: (host: string, reading: GitHubQuotaReading) => quotas.push([host, reading]) }

  const first = await ghApiConditional('github.com', path, cache, deps)
  assert.deepEqual(first, { ok: true, status: 200, body: '[{"type":"deletion"}]', notModified: false })
  assert.ok(!calls[0]!.includes('-H'), 'nothing to be conditional on yet')

  const second = await ghApiConditional('github.com', path, cache, deps)
  assert.deepEqual(second, { ok: true, status: 304, body: '[{"type":"deletion"}]', notModified: true })
  assert.deepEqual(calls[1], ['api', '-i', '--hostname', 'github.com', '-H', 'If-None-Match: W/"v1"', path])
  assert.deepEqual(
    quotas.map(([host, reading]) => [host, reading.resource, reading.remaining, reading.resetAt]),
    [
      ['github.com', 'core', 3999, RESET * 1000],
      ['github.com', 'core', 3999, RESET * 1000],
    ],
    'the 304 reports the quota and spent none of it',
  )
})

test('a 304 with nothing kept, or a failure, is not an answer', async () => {
  const cache: ConditionalCache = new Map()
  const notModified: GhRunner = {
    available: async () => true,
    run: async () => ({ found: true, code: 1, stdout: printed('304 Not Modified', {}), stderr: 'HTTP 304' }),
  }
  assert.deepEqual(await ghApiConditional('github.com', 'repos/acme/app', cache, { gh: notModified }), {
    ok: false,
    status: 304,
    reason: 'gh-failed',
  })
  const offline: GhRunner = {
    available: async () => true,
    run: async () => ({ found: true, code: 1, stdout: '', stderr: 'dial tcp: no route to host' }),
  }
  assert.deepEqual(await ghApiConditional('github.com', 'repos/acme/app', cache, { gh: offline }), {
    ok: false,
    status: null,
    reason: 'gh-failed',
  })
})

const BRANCH = 'repos/acme/app/branches/main'
const RULES = 'repos/acme/app/rules/branches/main'
const protectedBranch = (contexts: string[], checks: string[] = [], level = 'non_admins') =>
  JSON.stringify({
    name: 'main',
    protected: true,
    protection: {
      enabled: true,
      required_status_checks: {
        enforcement_level: level,
        contexts,
        checks: checks.map((context) => ({ context, app_id: 15368 })),
      },
    },
  })
const rules = (contexts: string[]) =>
  JSON.stringify([
    { type: 'deletion' },
    {
      type: 'required_status_checks',
      parameters: { required_status_checks: contexts.map((context) => ({ context, integration_id: 15368 })) },
    },
  ])

test('required checks are the branch protection’s and the rulesets’, kept per repository and base', async () => {
  const { gh, calls } = restServer({
    [BRANCH]: { body: protectedBranch(['ci/legacy'], ['Build (ubuntu-latest)']) },
    [RULES]: { body: rules(['JS tests (ubuntu-latest)', 'Build (ubuntu-latest)']) },
  })
  let nowMs = 1_000_000
  const reader = createRequiredChecksReader({ now: () => nowMs })
  const target = { host: 'github.com', owner: 'acme', repo: 'app', base: 'main' }
  const names = await reader.read(target, { gh })
  assert.deepEqual([...(names ?? [])].sort(), ['Build (ubuntu-latest)', 'JS tests (ubuntu-latest)', 'ci/legacy'])
  assert.equal(calls.length, 2)

  // A second pull request on the same base inside one sweep: no call at all.
  await reader.read(target, { gh })
  assert.equal(calls.length, 2)

  // Later: asked again, conditionally, and answered by 304s.
  nowMs += REQUIRED_CHECKS_FRESH_MS
  const again = await reader.read(target, { gh })
  assert.deepEqual([...(again ?? [])].sort(), [...(names ?? [])].sort())
  assert.equal(calls.length, 4)
  assert.ok(calls.slice(2).every((args) => args.includes('-H')))
})

test('no rulesets on the host is none from them; a branch that cannot be read is unknown', async () => {
  const target = { host: 'github.com', owner: 'acme', repo: 'app', base: 'main' }
  const noRulesets = restServer({ [BRANCH]: { body: protectedBranch(['Build']) } })
  assert.deepEqual([...((await createRequiredChecksReader().read(target, { gh: noRulesets.gh })) ?? [])], ['Build'])

  const off = restServer({ [BRANCH]: { body: protectedBranch(['Build'], [], 'off') }, [RULES]: { body: '[]' } })
  assert.deepEqual([...((await createRequiredChecksReader().read(target, { gh: off.gh })) ?? [])], [])

  const unreadable = restServer({})
  assert.equal(await createRequiredChecksReader().read(target, { gh: unreadable.gh }), null)
  assert.equal(
    await createRequiredChecksReader().read({ ...target, owner: '--hostname' }, { gh: unreadable.gh }),
    null,
    'nothing flag-shaped reaches gh',
  )
})
