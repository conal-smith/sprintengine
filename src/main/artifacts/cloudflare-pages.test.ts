import assert from 'node:assert/strict'
import { mkdtemp } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, test, vi } from 'vitest'

import { EMPTY_ARTIFACTS_SETTINGS, type ArtifactsSettings } from '../../shared/artifacts'
import { readArtifactsSiteTemplate } from './artifact-site'
import { createArtifactsService } from './artifacts-service'
import { createCloudflarePagesHost } from './artifacts-hosts'
import { cloudflareAssetHash, createCloudflarePagesClient, type CloudflareFetch } from './cloudflare-pages-client'
import { bareRemote, cleanup, hermeticGit, remoteFiles, testGit, writeFiles } from '../../../tests/artifacts-repo'

// Cloudflare Pages is never called here: a fake of its API answers, and
// records what was asked of it.

const ACCOUNT = '0123456789abcdef0123456789abcdef'
const TOKEN = 'cf-test-token-0123456789abcdef'

type Call = { method: string; path: string; bearer: string; body: unknown }

function fakeCloudflare(
  options: { sourceType?: string; failDeployments?: number; tokenStatus?: string; projectStatus?: number } = {},
) {
  const calls: Call[] = []
  const stored = new Set<string>()
  const deployments: Array<Record<string, string>> = []
  let failDeployments = options.failDeployments ?? 0
  const reply = (status: number, body: unknown) => ({ ok: status < 300, status, json: async () => body })
  const fetch: CloudflareFetch = async (url, init) => {
    const path = url.replace('https://api.cloudflare.com/client/v4/', '')
    const bearer = init.headers.Authorization?.replace(/^Bearer /, '') ?? ''
    let body: unknown = init.body
    if (typeof init.body === 'string') body = JSON.parse(init.body)
    if (init.body instanceof FormData)
      body = Object.fromEntries([...init.body.entries()].map(([key, value]) => [key, String(value)]))
    calls.push({ method: init.method, path, bearer, body })
    if (path === 'user/tokens/verify') {
      return bearer === TOKEN
        ? reply(200, { success: true, result: { status: options.tokenStatus ?? 'active' } })
        : reply(401, { success: false, errors: [{ code: 1000, message: 'Invalid API Token' }] })
    }
    if (path === `accounts/${ACCOUNT}/tokens/verify`)
      return reply(401, { success: false, errors: [{ code: 1000, message: 'Invalid API Token' }] })
    if (bearer !== TOKEN && bearer !== 'upload-jwt')
      return reply(403, { success: false, errors: [{ code: 10000, message: 'Authentication error' }] })
    if (path === `accounts/${ACCOUNT}/pages/projects/art`) {
      if (options.projectStatus === 404)
        return reply(404, { success: false, errors: [{ code: 8000007, message: 'Project not found' }] })
      return reply(200, {
        success: true,
        result: {
          name: 'art',
          subdomain: 'art.pages.dev',
          domains: ['art.pages.dev'],
          production_branch: 'main',
          source: options.sourceType ? { type: options.sourceType } : null,
        },
      })
    }
    if (path === `accounts/${ACCOUNT}/pages/projects/art/upload-token`)
      return reply(200, { success: true, result: { jwt: 'upload-jwt' } })
    if (path === 'pages/assets/check-missing') {
      const hashes = (body as { hashes: string[] }).hashes
      return reply(200, { success: true, result: hashes.filter((hash) => !stored.has(hash)) })
    }
    if (path === 'pages/assets/upload') {
      for (const file of body as Array<{ key: string }>) stored.add(file.key)
      return reply(200, { success: true, result: null })
    }
    if (path === 'pages/assets/upsert-hashes') return reply(200, { success: true, result: null })
    if (path === `accounts/${ACCOUNT}/pages/projects/art/deployments`) {
      if (failDeployments > 0) {
        failDeployments -= 1
        return reply(500, { success: false, errors: [{ code: 8000000, message: 'Internal error' }] })
      }
      deployments.push(body as Record<string, string>)
      return reply(200, {
        success: true,
        result: { id: `dep-${deployments.length}`, url: `https://${deployments.length}.art.pages.dev` },
      })
    }
    return reply(404, { success: false, errors: [{ code: 7003, message: `No route for ${path}` }] })
  }
  return { fetch, calls, deployments, stored }
}

const temporary: string[] = []
let root = ''

beforeEach(async () => {
  temporary.push(await hermeticGit())
  root = await mkdtemp(join(tmpdir(), 'artifacts-cloudflare-'))
  temporary.push(root)
  await writeFiles(join(root, 'work'), {
    'patterns/stars.html': '<link rel="stylesheet" href="../foundations/tokens.css"><p>Stars</p>',
    'foundations/tokens.css': ':root{}',
    'patterns/tide.html': '<p>Tide</p>',
  })
})
afterEach(async () => {
  vi.unstubAllEnvs()
  await cleanup(temporary)
})

function cloudflareSettings(repositoryUrl = ''): ArtifactsSettings {
  return {
    ...EMPTY_ARTIFACTS_SETTINGS,
    provider: 'cloudflare-pages',
    cloudflare: { accountId: ACCOUNT, projectName: 'art', customDomain: '', repositoryUrl },
  }
}

function service(fake: ReturnType<typeof fakeCloudflare>, settings = cloudflareSettings(), token = TOKEN) {
  return createArtifactsService({
    settings: () => settings,
    hostDeps: {
      dataDir: join(root, 'data'),
      git: testGit,
      resolveHostToken: async () => '',
      cloudflareToken: async () => token,
      fetch: fake.fetch,
      retryDelayMs: () => 5,
    },
    siteTemplate: () => readArtifactsSiteTemplate(join(process.cwd(), 'resources', 'artifacts-site')),
    thumbnailer: async () => Buffer.from('PNG'),
    git: testGit,
  })
}

test('a publish uploads the whole site as one deployment, at the project’s address', async () => {
  const fake = fakeCloudflare()
  const published = await service(fake).publish({
    path: join(root, 'work/patterns/stars.html'),
    title: 'Stars',
    tags: ['mockup'],
  })
  assert.ok(published.ok, published.ok ? '' : published.message)
  assert.equal(published.live, true)
  assert.equal(published.artifact.url, 'https://art.pages.dev/a/stars/')
  assert.equal(fake.deployments.length, 1)
  const manifest = JSON.parse(fake.deployments[0].manifest) as Record<string, string>
  for (const path of [
    '/index.html',
    '/artifacts.json',
    '/assets/gallery.js',
    '/a/stars/index.html',
    '/a/stars/meta.json',
    '/a/stars/v1/patterns/stars.html',
    '/a/stars/v1/foundations/tokens.css',
  ]) {
    assert.ok(manifest[path], path)
  }
  assert.ok(!Object.keys(manifest).some((path) => path.includes('/.')), 'no hidden file is deployed')
  assert.equal(fake.deployments[0].branch, 'main')
})

test('a second publish uploads only the files Pages does not have', async () => {
  const fake = fakeCloudflare()
  const studio = service(fake)
  await studio.publish({ path: join(root, 'work/patterns/stars.html'), title: 'Stars' })
  const before = fake.calls
    .filter((call) => call.path === 'pages/assets/upload')
    .flatMap((call) => call.body as unknown[]).length
  await studio.publish({ path: join(root, 'work/patterns/tide.html'), title: 'Tide' })
  const uploads = fake.calls.filter((call) => call.path === 'pages/assets/upload')
  const after = uploads.flatMap((call) => call.body as unknown[]).length
  // The new artifact's page, record, viewer and picture, and the manifest: not the gallery's own files again.
  assert.ok(after - before < before, `${after - before} new of ${before}`)
  assert.equal(fake.deployments.length, 2)
})

test('an upload that fails after the change was kept says so, and the next change puts it live', async () => {
  const fake = fakeCloudflare({ failDeployments: 1 })
  const studio = service(fake)
  const published = await studio.publish({ path: join(root, 'work/patterns/stars.html'), title: 'Stars' })
  assert.ok(published.ok)
  assert.equal(published.live, false)
  assert.match(
    published.note,
    /not live on Cloudflare Pages yet: Cloudflare could not create the deployment \(HTTP 500: Internal error \(8000000\)\)\./,
  )
  assert.match(published.note, /next publish or update uploads it again/)
  // Nothing changes in this update, and the kept change goes live with it.
  const retried = await studio.update({ slug: published.artifact.slug })
  assert.ok(retried.ok)
  assert.equal(retried.live, true)
  assert.equal(fake.deployments.length, 1)
  // And a site already live is not uploaded again for nothing.
  await studio.update({ slug: published.artifact.slug })
  assert.equal(fake.deployments.length, 1)
})

test('with a source repository, the change is pushed there first and then deployed with its commit', async () => {
  const remote = await bareRemote(root)
  const fake = fakeCloudflare()
  const published = await service(fake, cloudflareSettings(remote.url)).publish({
    path: join(root, 'work/patterns/stars.html'),
    title: 'Stars',
  })
  assert.ok(published.ok, published.ok ? '' : published.message)
  assert.ok(remoteFiles(remote.path).includes('a/stars/meta.json'))
  assert.equal(fake.deployments[0].commit_hash, published.commit)
  assert.equal(fake.deployments[0].commit_dirty, 'false')
})

test('the API token is sent only as the bearer, and never said back', async () => {
  const fake = fakeCloudflare()
  const studio = service(fake, cloudflareSettings(), 'cf-wrong-token-0123456789abcdef')
  const published = await studio.publish({ path: join(root, 'work/patterns/stars.html'), title: 'Stars' })
  assert.ok(published.ok)
  assert.equal(published.live, false)
  assert.match(published.note, /refused the API token/)
  assert.ok(!JSON.stringify(published).includes('cf-wrong-token'), 'not in the answer')
  for (const call of fake.calls) assert.ok(!JSON.stringify(call.body ?? '').includes('cf-wrong-token'), 'not in a body')
})

test('the check verifies the token and the project, rehearses the upload, and deploys nothing', async () => {
  const fake = fakeCloudflare()
  const studio = service(fake)
  await studio.publish({ path: join(root, 'work/patterns/stars.html'), title: 'Stars' })
  const deployed = fake.deployments.length
  const uploads = fake.calls.filter((call) => call.path === 'pages/assets/upload').length
  const checked = await studio.test()
  assert.ok('checks' in checked)
  assert.ok(checked.ok, JSON.stringify(checked))
  assert.deepEqual(
    checked.checks.map((check) => [check.label, check.status]),
    [
      ['API token', 'pass'],
      ['Project', 'pass'],
      ['Source', 'warn'],
      ['Upload', 'pass'],
    ],
  )
  assert.equal(fake.deployments.length, deployed, 'no deployment')
  assert.equal(fake.calls.filter((call) => call.path === 'pages/assets/upload').length, uploads, 'no upload')
})

test('the check says what is wrong: a bad token, a missing project, a project that builds from git', async () => {
  const badToken = await service(fakeCloudflare(), cloudflareSettings(), 'cf-other-token-0123456789abcdef').test()
  assert.ok('checks' in badToken && !badToken.ok && badToken.checks[0].label === 'API token')
  const missing = await service(fakeCloudflare({ projectStatus: 404 })).test()
  assert.ok('checks' in missing && !missing.ok)
  assert.match(JSON.stringify(missing), /no Pages project named \\"art\\"/)
  const fromGit = await service(fakeCloudflare({ sourceType: 'github' })).test()
  assert.ok('checks' in fromGit && !fromGit.ok)
  assert.match(JSON.stringify(fromGit), /takes no direct upload/)
  const noToken = await service(fakeCloudflare(), cloudflareSettings(), '').test()
  assert.ok('checks' in noToken && !noToken.ok && noToken.checks[0].detail === 'No API token is saved.')
})

test('a dry run compares the site with Pages and uploads nothing', async () => {
  const fake = fakeCloudflare()
  const client = createCloudflarePagesClient({
    accountId: ACCOUNT,
    projectName: 'art',
    token: async () => TOKEN,
    fetch: fake.fetch,
  })
  const files = [
    { path: 'index.html', bytes: Buffer.from('<p>hi</p>') },
    { path: 'a/x/v1/page.html', bytes: Buffer.from('<p>x</p>') },
  ]
  const rehearsed = await client.deploy(files, { commitMessage: 'Check', dryRun: true })
  assert.deepEqual(rehearsed, { ok: true, dryRun: true, files: 2, uploaded: 2, deploymentId: null, url: null })
  assert.deepEqual(
    fake.calls.map((call) => call.path),
    [
      `accounts/${ACCOUNT}/pages/projects/art`,
      `accounts/${ACCOUNT}/pages/projects/art/upload-token`,
      'pages/assets/check-missing',
    ],
  )
  const dryHost = createCloudflarePagesHost({
    settings: cloudflareSettings(),
    siteUrl: 'https://art.pages.dev/',
    dryRun: true,
    deps: {
      dataDir: join(root, 'dry'),
      git: testGit,
      resolveHostToken: async () => '',
      cloudflareToken: async () => TOKEN,
      fetch: fake.fetch,
    },
  })
  const changed = await dryHost.change(async () => null)
  assert.ok(changed.ok)
  assert.equal(fake.deployments.length, 0)
})

test('an asset’s key is 32 hex characters of its content and extension', () => {
  const key = cloudflareAssetHash('a/page.html', Buffer.from('x'))
  assert.match(key, /^[0-9a-f]{32}$/)
  assert.notEqual(key, cloudflareAssetHash('a/page.css', Buffer.from('x')))
  assert.equal(key, cloudflareAssetHash('b/other.html', Buffer.from('x')))
})
