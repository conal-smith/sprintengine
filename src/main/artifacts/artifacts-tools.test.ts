import assert from 'node:assert/strict'
import { test } from 'vitest'

import { localOnlyGatewayToolReason, requiredScopeForTool } from '../automation/tailnet/tailnet-scopes'
import { isStudioGatewayMutation } from '../automation/studio-gateway-tools'
import type { ArtifactsService } from './artifacts-service'
import { createArtifactsTools, type ArtifactsSetupToolDeps } from './artifacts-tools'
import type { ArtifactsSetupConsentQuestion } from './artifacts-setup-consent'
import { EMPTY_ARTIFACTS_SETTINGS, type ArtifactsSetupInput } from '../../shared/artifacts'

/** A service that records what it was asked and answers ok. */
function recordingService() {
  const calls: Array<[string, unknown]> = []
  const answer = (name: string) => async (input: unknown) => {
    calls.push([name, input])
    return { ok: true as const, echoed: input }
  }
  const service = {
    publish: answer('publish'),
    update: answer('update'),
    remove: answer('remove'),
    list: answer('list'),
    get: answer('get'),
  } as unknown as ArtifactsService
  return { service, calls }
}

/** The folders the calling agent's chat may publish from, in these tests. */
const ROOTS = ['/Users/dev']
const publishRoots = async () => ROOTS

function tool(name: string, service: ArtifactsService) {
  const found = createArtifactsTools({ service, publishRoots }).find((registration) => registration.name === name)
  assert.ok(found, name)
  return found
}

function errorOf(result: Awaited<ReturnType<ReturnType<typeof tool>['handler']>>): string | null {
  const structured = result.structuredContent as { ok?: boolean; error?: { code: string } } | undefined
  return result.isError ? (structured?.error?.code ?? 'error') : null
}

test('the family is publish, list, search, get, update and delete, and only the writes mutate', () => {
  const { service } = recordingService()
  const tools = createArtifactsTools({ service, publishRoots })
  assert.deepEqual(
    tools.map((registration) => [registration.name, registration.mutates === true]),
    [
      ['artifacts.setup', true],
      ['artifacts.publish', true],
      ['artifacts.list', false],
      ['artifacts.search', false],
      ['artifacts.get', false],
      ['artifacts.update', true],
      ['artifacts.delete', true],
    ],
  )
  for (const registration of tools) assert.match(registration.description, /Settings ▸ Artifacts/)
})

test('a publish needs an absolute path and a title, and checks every field it is given', async () => {
  const { service, calls } = recordingService()
  const publish = tool('artifacts.publish', service)
  const refused: Array<Record<string, unknown>> = [
    {},
    { path: 'relative/page.html', title: 'x' },
    { path: '/Users/dev/p.html' },
    { path: '/Users/dev/p.html', title: '   ' },
    { path: '/Users/dev/p.html', title: 'x', tags: 'mockup' },
    { path: '/Users/dev/p.html', title: 'x', tags: [1] },
    { path: '/Users/dev/p.html', title: 'x', commit: 'not-a-sha' },
    { path: '/Users/dev/p.html', title: 'x', slug: '../escape' },
    { path: '/Users/dev/p.html', title: 'x', entry: '../outside.html' },
    { path: '/Users/dev/p.html', title: 'x', stylesheets: ['fonts.css'] },
    { path: '/Users/dev/p.html', title: 'x', thumbnail: 'thumb.png' },
    { path: '/Users/dev/p.html', title: 'x'.repeat(201) },
    { path: '/Users/dev/p\0.html', title: 'x' },
  ]
  for (const args of refused)
    assert.equal(errorOf(await publish.handler(args)), 'invalid_arguments', JSON.stringify(args))
  assert.equal(calls.length, 0)
  const ok = await publish.handler({ path: '/Users/dev/p.html', title: ' Stars ', tags: ['mockup'], commit: 'B004AD8' })
  assert.equal(errorOf(ok), null)
  assert.deepEqual(calls[0], [
    'publish',
    {
      path: '/Users/dev/p.html',
      title: 'Stars',
      tags: ['mockup'],
      commit: 'B004AD8',
      entry: undefined,
      stylesheets: undefined,
      description: undefined,
      project: undefined,
      repo: undefined,
      branch: undefined,
      thumbnail: undefined,
      roots: ROOTS,
    },
  ])
})

test('a page is published only from the folders the caller may publish from', async () => {
  const { service, calls } = recordingService()
  const seen: unknown[] = []
  const tools = createArtifactsTools({
    service,
    publishRoots: async (context) => {
      seen.push(context?.metadata.kind)
      return context?.metadata.kind === 'studio-agent' ? ['/Users/dev/app'] : null
    },
  })
  const publish = tools.find((registration) => registration.name === 'artifacts.publish')!
  const update = tools.find((registration) => registration.name === 'artifacts.update')!
  const agent = { metadata: { kind: 'studio-agent' as const, workspaceId: 'ws-1', agentId: 'agent-1' } }
  const page = { path: '/Users/dev/app/page.html', title: 'Stars' }

  // No agent of this app: nothing is published, and the service is never asked.
  assert.equal(errorOf(await publish.handler(page, { metadata: { kind: 'external-local' } })), 'forbidden')
  assert.equal(errorOf(await publish.handler(page)), 'forbidden')
  assert.equal(errorOf(await update.handler({ slug: 'stars', path: page.path })), 'forbidden')
  assert.equal(calls.length, 0)

  assert.equal(errorOf(await publish.handler(page, agent)), null)
  assert.equal(errorOf(await update.handler({ slug: 'stars', path: page.path }, agent)), null)
  // A retitle reads no file, so it needs no folders.
  assert.equal(errorOf(await update.handler({ slug: 'stars', title: 'Moons' })), null)
  assert.deepEqual(
    calls.map(([, input]) => (input as { roots?: unknown }).roots),
    [['/Users/dev/app'], ['/Users/dev/app'], undefined],
  )
})

test('search needs words; list and search take a limit from 1 to 200', async () => {
  const { service, calls } = recordingService()
  assert.equal(errorOf(await tool('artifacts.search', service).handler({})), 'invalid_arguments')
  assert.equal(errorOf(await tool('artifacts.search', service).handler({ query: '  ' })), 'invalid_arguments')
  for (const limit of [0, 201, 1.5, '10']) {
    assert.equal(errorOf(await tool('artifacts.list', service).handler({ limit })), 'invalid_arguments', String(limit))
  }
  assert.equal(
    errorOf(await tool('artifacts.search', service).handler({ query: 'stars', tags: ['mockup'], limit: 5 })),
    null,
  )
  assert.deepEqual(calls, [['list', { query: 'stars', tags: ['mockup'], limit: 5 }]])
})

test('get, update and delete take only a slug that names a folder of the site', async () => {
  const { service, calls } = recordingService()
  for (const name of ['artifacts.get', 'artifacts.update', 'artifacts.delete']) {
    for (const slug of [undefined, '', '..', '../x', 'a/b', 'A', 'x'.repeat(65)]) {
      assert.equal(errorOf(await tool(name, service).handler({ slug })), 'invalid_arguments', `${name} ${String(slug)}`)
    }
  }
  assert.equal(calls.length, 0)
  assert.equal(errorOf(await tool('artifacts.delete', service).handler({ slug: 'your-stars' })), null)
  assert.deepEqual(calls, [['remove', 'your-stars']])
})

test('a service failure is the tool’s error, with its code and message', async () => {
  const service = {
    list: async () => ({ ok: false, code: 'not_configured', message: 'Choose a host on Settings ▸ Artifacts.' }),
  } as unknown as ArtifactsService
  const result = await tool('artifacts.list', service).handler({})
  assert.equal(errorOf(result), 'not_configured')
  assert.match(result.content[0]?.type === 'text' ? result.content[0].text : '', /Settings ▸ Artifacts/)
})

test('a paired device may read artifacts, but publishing, changing and removing stay on this machine', () => {
  for (const name of ['artifacts.publish', 'artifacts.update', 'artifacts.delete', 'artifacts.setup']) {
    assert.ok(localOnlyGatewayToolReason(name), name)
    assert.equal(isStudioGatewayMutation(name), true, name)
  }
  for (const name of ['artifacts.list', 'artifacts.search', 'artifacts.get']) {
    assert.equal(localOnlyGatewayToolReason(name), null, name)
    assert.equal(requiredScopeForTool(name, isStudioGatewayMutation(name)), 'workspace:read', name)
  }
})

const TOKEN = 'cf-test-token-0123456789abcdef'

/** A set-up whose person answers `answer`, recording what was asked and run. */
function setupDeps(answer: boolean, accounts = [{ id: 'a'.repeat(32), name: 'Acme' }]) {
  const asked: ArtifactsSetupConsentQuestion[] = []
  const ran: ArtifactsSetupInput[] = []
  const deps: ArtifactsSetupToolDeps = {
    cloudflareAccount: async (_token, accountId) => {
      const chosen = accountId
        ? accounts.find((account) => account.id === accountId)
        : accounts.length === 1
          ? accounts[0]
          : undefined
      return chosen
        ? { ok: true, account: chosen }
        : { ok: false, message: `The token can see ${accounts.length} accounts.`, accounts }
    },
    run: async (input) => {
      ran.push(input)
      return {
        ok: true,
        saved: true,
        siteUrl: 'https://studio-artifacts.pages.dev/',
        steps: [{ label: 'Account', status: 'pass', detail: 'Found account Acme.' }],
        view: {
          ...EMPTY_ARTIFACTS_SETTINGS,
          cloudflareToken: { configured: true, encryptionAvailable: true },
          siteUrl: 'https://studio-artifacts.pages.dev/',
        },
      }
    },
    consent: async (question) => {
      asked.push(question)
      return answer
    },
  }
  return { deps, asked, ran }
}

function setupTool(deps: ArtifactsSetupToolDeps) {
  const { service } = recordingService()
  return createArtifactsTools({ service, setup: deps, publishRoots }).find(
    (registration) => registration.name === 'artifacts.setup',
  )!
}

const agent = {
  metadata: { kind: 'studio-agent' as const, workspaceId: 'ws-1', agentId: 'agent-1', agentName: 'Claude Code' },
}

test('setting up waits for the person: refused, nothing runs and nothing is saved', async () => {
  const { deps, asked, ran } = setupDeps(false)
  const result = await setupTool(deps).handler(
    { provider: 'github-pages', repositoryUrl: 'https://github.com/acme/artifacts' },
    agent,
  )
  assert.equal(errorOf(result), 'not_confirmed')
  assert.equal(ran.length, 0)
  assert.equal(asked.length, 1)
  assert.equal(asked[0].message, 'Publish artifacts with GitHub Pages?')
  assert.match(asked[0].detail, /Claude Code asks to set this up/)
  assert.match(asked[0].detail, /Repository: acme\/artifacts on github\.com/)
  assert.match(asked[0].detail, /public on the internet/)
})

test('confirmed, the set-up runs and answers the site, never the token', async () => {
  const { deps, asked, ran } = setupDeps(true)
  const result = await setupTool(deps).handler({ provider: 'cloudflare-pages', cloudflareToken: ` ${TOKEN} ` }, agent)
  assert.equal(errorOf(result), null)
  assert.deepEqual(ran, [{ provider: 'cloudflare-pages', token: TOKEN, accountId: 'a'.repeat(32) }])
  assert.equal((result.structuredContent as { siteUrl?: string }).siteUrl, 'https://studio-artifacts.pages.dev/')
  assert.ok(!JSON.stringify(result).includes(TOKEN), 'the answer never carries the token')
  assert.ok(!JSON.stringify(asked).includes(TOKEN), 'nor does the question put to the person')
  assert.match(asked[0].detail, /Account: Acme/)
})

test('a token that sees several accounts is answered with them before the person is asked anything', async () => {
  const accounts = [
    { id: 'a'.repeat(32), name: 'Acme' },
    { id: 'b'.repeat(32), name: 'Acme Labs' },
  ]
  const { deps, asked, ran } = setupDeps(true, accounts)
  const first = await setupTool(deps).handler({ provider: 'cloudflare-pages', cloudflareToken: TOKEN }, agent)
  assert.equal(errorOf(first), null)
  assert.deepEqual((first.structuredContent as { accounts?: unknown }).accounts, accounts)
  assert.equal(asked.length + ran.length, 0)
  const second = await setupTool(deps).handler(
    { provider: 'cloudflare-pages', cloudflareToken: TOKEN, accountId: 'b'.repeat(32) },
    agent,
  )
  assert.equal(errorOf(second), null)
  assert.match(asked[0].detail, /Account: Acme Labs/)
})

test('a malformed request is refused before the person is asked', async () => {
  const { deps, asked } = setupDeps(true)
  const tool = setupTool(deps)
  for (const args of [
    {},
    { provider: 'carrier-pigeon' },
    { provider: 'github-pages' },
    { provider: 'github-pages', repositoryUrl: 'https://x:secret@github.com/acme/a' },
    { provider: 'cloudflare-pages', cloudflareToken: 12 },
    { provider: 'cloudflare-pages', sourceRepositoryUrl: 'not a repository' },
  ]) {
    assert.equal(errorOf(await tool.handler(args, agent)), 'invalid_arguments', JSON.stringify(args))
  }
  assert.equal(asked.length, 0)
})

test('a set-up that fails after the person said yes says why, with its steps', async () => {
  const { deps } = setupDeps(true)
  deps.run = async () => ({
    ok: false,
    message: 'GitHub Pages is not available for a private repository.',
    steps: [{ label: 'Pages', status: 'fail', detail: 'Plan.' }],
  })
  const result = await setupTool(deps).handler({ provider: 'github-pages', repositoryUrl: 'acme/artifacts' }, agent)
  assert.equal(errorOf(result), 'setup_failed')
  assert.match(
    result.content[0]?.type === 'text' ? result.content[0].text : '',
    /not available for a private repository.*Pages: Plan\./,
  )
})

test('while the person is being asked, another set-up is refused rather than stacking a second question', async () => {
  const { deps } = setupDeps(true)
  let release: (answer: boolean) => void = () => {}
  deps.consent = () => new Promise<boolean>((resolve) => (release = resolve))
  const tool = setupTool(deps)
  const first = tool.handler({ provider: 'github-pages', repositoryUrl: 'acme/artifacts' }, agent)
  await new Promise((resolve) => setTimeout(resolve, 0))
  assert.equal(errorOf(await tool.handler({ provider: 'github-pages', repositoryUrl: 'acme/other' }, agent)), 'busy')
  release(false)
  assert.equal(errorOf(await first), 'not_confirmed')
})
