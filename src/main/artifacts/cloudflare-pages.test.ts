import assert from 'node:assert/strict'
import { mkdtemp, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, test, vi } from 'vitest'

import { createSecretCipherStandIn } from '../../../tests/stubs/secret-cipher'
import { bareRemote, cleanup, hermeticGit, remoteFiles, testGit, writeFiles } from '../../../tests/artifacts-repo'
import {
  ACCOUNT_ACME,
  ACCOUNT_OTHER,
  FAKE_TOKEN,
  fakeCloudflare,
  type FakeProject,
} from '../../../tests/fake-cloudflare'
import { readArtifactsSiteTemplate } from './artifact-site'
import { createCloudflarePagesHost, type ArtifactsHostDeps } from './artifacts-hosts'
import { createArtifactsService } from './artifacts-service'
import { createArtifactsSettingsStore, type ArtifactsSettingsStore } from './artifacts-settings-store'
import { setUpArtifacts } from './artifacts-setup'
import { cloudflareAssetHash, createCloudflarePagesClient, STUDIO_DEPLOYMENT_PREFIX } from './cloudflare-pages-client'

// Cloudflare Pages is never called here: a fake of its API answers
// (tests/fake-cloudflare.ts), records what was asked of it, and serves the
// live site from its latest deployment.

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
    'patterns/swell.html': '<p>Swell</p>',
  })
})
afterEach(async () => {
  vi.unstubAllEnvs()
  await cleanup(temporary)
})

type Fake = ReturnType<typeof fakeCloudflare>

/** One machine: its own data folder and settings, the shared fake Cloudflare. */
function machine(fake: Fake, name: string, options: { behindAccess?: boolean } = {}) {
  const store = createArtifactsSettingsStore({
    resolveUserDataDir: () => join(root, name),
    cipher: createSecretCipherStandIn(),
  })
  const hostDeps: ArtifactsHostDeps = {
    dataDir: join(root, name, 'artifacts'),
    git: testGit,
    resolveHostToken: async () => '',
    cloudflareToken: () => store.cloudflareToken(),
    fetch: fake.fetch,
    siteFetch: fake.siteFetch('studio-artifacts', options.behindAccess),
    retryDelayMs: () => 5,
  }
  const siteTemplate = () => readArtifactsSiteTemplate(join(process.cwd(), 'resources', 'artifacts-site'))
  const service = createArtifactsService({
    settings: () => store.read(),
    hostDeps,
    siteTemplate,
    thumbnailer: async () => Buffer.from('PNG'),
    git: testGit,
  })
  const setUp = (input: Parameters<typeof setUpArtifacts>[0], save = true) =>
    setUpArtifacts(input, { save }, { store, hostDeps, siteTemplate })
  return { store, service, setUp, hostDeps }
}

const page = (name: string) => join(root, 'work', 'patterns', `${name}.html`)

function words(result: { steps: Array<{ detail: string }> }): string[] {
  return result.steps.map((step) => step.detail)
}

test('a token is all it takes: the one account is found, the project made, the site put up and its address kept', async () => {
  const fake = fakeCloudflare()
  const here = machine(fake, 'a')
  const result = await here.setUp({ provider: 'cloudflare-pages', token: FAKE_TOKEN })
  assert.ok(result.ok, result.ok ? '' : result.message)
  assert.equal(result.siteUrl, 'https://studio-artifacts.pages.dev/')
  assert.deepEqual(words(result).slice(0, 2), ['Found account Acme.', 'Created project studio-artifacts.'])
  assert.match(words(result).join(' '), /Uploaded the site/)
  assert.equal(fake.deployments('studio-artifacts').length, 1)
  assert.ok(fake.deployments('studio-artifacts')[0].commit_message.startsWith(STUDIO_DEPLOYMENT_PREFIX))
  const settings = here.store.read()
  assert.deepEqual(settings.cloudflare, {
    accountId: ACCOUNT_ACME,
    accountName: 'Acme',
    projectName: '',
    repositoryUrl: '',
    siteUrl: 'https://studio-artifacts.pages.dev/',
  })
  assert.equal(await here.store.cloudflareToken(), FAKE_TOKEN)
  assert.ok(!JSON.stringify(result).includes(FAKE_TOKEN), 'the token is never answered back')
})

test('a test finds and makes what it says, and saves nothing', async () => {
  const fake = fakeCloudflare()
  const here = machine(fake, 'a')
  const tested = await here.setUp({ provider: 'cloudflare-pages', token: FAKE_TOKEN }, false)
  assert.ok(tested.ok)
  assert.equal(tested.saved, false)
  assert.equal(here.store.read().provider, null)
  assert.equal(await here.store.cloudflareToken(), '')
  // Saved after: the project it made is found, not made again.
  const saved = await here.setUp({ provider: 'cloudflare-pages', token: FAKE_TOKEN })
  assert.ok(saved.ok)
  assert.ok(words(saved).includes('Found project studio-artifacts.'))
  assert.equal(fake.writes().filter((call) => call.path.endsWith('/pages/projects')).length, 1)
})

test('a token that sees several accounts asks which; the one picked is used', async () => {
  const fake = fakeCloudflare({
    accounts: [
      { id: ACCOUNT_ACME, name: 'Acme' },
      { id: ACCOUNT_OTHER, name: 'Acme Labs' },
    ],
  })
  const here = machine(fake, 'a')
  const asked = await here.setUp({ provider: 'cloudflare-pages', token: FAKE_TOKEN })
  assert.equal(asked.ok, false)
  assert.deepEqual(!asked.ok && asked.accounts, [
    { id: ACCOUNT_ACME, name: 'Acme' },
    { id: ACCOUNT_OTHER, name: 'Acme Labs' },
  ])
  assert.equal(fake.writes().length, 0, 'nothing is made before the person picks')
  const picked = await here.setUp({ provider: 'cloudflare-pages', token: FAKE_TOKEN, accountId: ACCOUNT_OTHER })
  assert.ok(picked.ok, picked.ok ? '' : picked.message)
  assert.equal(here.store.read().cloudflare.accountName, 'Acme Labs')
  const stranger = await here.setUp({ provider: 'cloudflare-pages', token: FAKE_TOKEN, accountId: 'f'.repeat(32) })
  assert.equal(!stranger.ok && stranger.field, 'cloudflare.accountId')
  assert.equal(!stranger.ok && stranger.accounts?.length, 2, 'the accounts it can see are offered to pick from')
})

test('a token that sees no account is told so, with what to make instead', async () => {
  const here = machine(fakeCloudflare({ accounts: [] }), 'a')
  const result = await here.setUp({ provider: 'cloudflare-pages', token: FAKE_TOKEN })
  assert.equal(result.ok, false)
  assert.equal(!result.ok && result.field, 'cloudflare.token')
  assert.match(!result.ok ? result.message : '', /can see no Cloudflare account.*Cloudflare Pages › Edit/)
  const wrong = await machine(fakeCloudflare(), 'b').setUp({
    provider: 'cloudflare-pages',
    token: 'cf-wrong-token-0123456789abcd',
  })
  assert.equal(!wrong.ok && wrong.field, 'cloudflare.token')
  assert.ok(!JSON.stringify(wrong).includes('cf-wrong-token'))
  const malformed = await machine(fakeCloudflare(), 'c').setUp({ provider: 'cloudflare-pages', token: 'not a token' })
  assert.equal(!malformed.ok && malformed.field, 'cloudflare.token')
})

test('a project of that name that is not Studio’s is left alone, and another name asked for', async () => {
  const foreign: FakeProject = {
    name: 'studio-artifacts',
    subdomain: 'studio-artifacts.pages.dev',
    domains: [],
    source: null,
    deployments: [{ id: 'theirs', commit_message: 'Launch the marketing site' }],
  }
  const fromGit: FakeProject = {
    name: 'docs',
    subdomain: 'docs.pages.dev',
    domains: [],
    source: { type: 'github' },
    deployments: [],
  }
  const fake = fakeCloudflare({ projects: [foreign, fromGit] })
  const here = machine(fake, 'a')
  const taken = await here.setUp({ provider: 'cloudflare-pages', token: FAKE_TOKEN })
  assert.equal(!taken.ok && taken.field, 'cloudflare.projectName')
  assert.match(!taken.ok ? taken.message : '', /a site Studio did not publish.*under Advanced/)
  const git = await here.setUp({ provider: 'cloudflare-pages', token: FAKE_TOKEN, projectName: 'docs' })
  assert.match(!git.ok ? git.message : '', /deploys from its own github connection/)
  assert.equal(fake.writes().length, 0, 'neither project was touched')
  const other = await here.setUp({ provider: 'cloudflare-pages', token: FAKE_TOKEN, projectName: 'acme-artifacts' })
  assert.ok(other.ok, other.ok ? '' : other.message)
  assert.equal(here.store.read().cloudflare.projectName, 'acme-artifacts')
  assert.equal(other.siteUrl, 'https://acme-artifacts.pages.dev/')
})

test('a project made by someone else between the lookup and the create is found, at the address it got', async () => {
  const fake = fakeCloudflare({ createRaces: true })
  const result = await machine(fake, 'a').setUp({ provider: 'cloudflare-pages', token: FAKE_TOKEN })
  assert.ok(result.ok, result.ok ? '' : result.message)
  assert.ok(words(result).includes('Found project studio-artifacts.'))
  assert.equal(result.siteUrl, 'https://studio-artifacts-a1b.pages.dev/')
})

test('the site’s address is the project’s own domain when it has one', async () => {
  const fake = fakeCloudflare({
    projects: [
      {
        name: 'studio-artifacts',
        subdomain: 'studio-artifacts.pages.dev',
        domains: ['studio-artifacts.pages.dev', 'artifacts.acme.example'],
        source: null,
        deployments: [],
      },
    ],
  })
  const result = await machine(fake, 'a').setUp({ provider: 'cloudflare-pages', token: FAKE_TOKEN })
  assert.ok(result.ok)
  assert.equal(result.siteUrl, 'https://artifacts.acme.example/')
})

test('a publish uploads only what Pages does not have, and an upload that failed after the change goes up with the next', async () => {
  const fake = fakeCloudflare()
  const here = machine(fake, 'a')
  assert.ok((await here.setUp({ provider: 'cloudflare-pages', token: FAKE_TOKEN })).ok)
  const published = await here.service.publish({ path: page('stars'), title: 'Stars' })
  assert.ok(published.ok, published.ok ? '' : published.message)
  assert.equal(published.artifact.url, 'https://studio-artifacts.pages.dev/a/stars/')
  assert.ok(
    [...fake.uploadCounts().values()].every((count) => count === 1),
    'no file is sent twice',
  )

  fake.refuseDeployments(1)
  const kept = await here.service.publish({ path: page('tide'), title: 'Tide' })
  assert.ok(kept.ok)
  assert.equal(kept.live, false)
  assert.match(kept.note, /not live on Cloudflare Pages yet.*next publish or update uploads it again/)
  const before = fake.deployments('studio-artifacts').length
  const retried = await here.service.update({ slug: kept.artifact.slug })
  assert.ok(retried.ok && retried.live)
  assert.equal(fake.deployments('studio-artifacts').length, before + 1)
  assert.ok(fake.deployments('studio-artifacts').at(-1)?.manifest?.['/a/tide/meta.json'])
  await here.service.update({ slug: kept.artifact.slug })
  assert.equal(fake.deployments('studio-artifacts').length, before + 1, 'a site already live is not uploaded again')
})

test('a machine with no copy of the site rebuilds it from the live site before it publishes', async () => {
  const fake = fakeCloudflare()
  const first = machine(fake, 'first')
  assert.ok((await first.setUp({ provider: 'cloudflare-pages', token: FAKE_TOKEN })).ok)
  assert.ok((await first.service.publish({ path: page('stars'), title: 'Stars' })).ok)
  assert.ok((await first.service.publish({ path: page('tide'), title: 'Tide' })).ok)

  const second = machine(fake, 'second')
  const joined = await second.setUp({ provider: 'cloudflare-pages', token: FAKE_TOKEN })
  assert.ok(joined.ok, joined.ok ? '' : joined.message)
  assert.ok(
    words(joined).some((word) => /Rebuilt this machine’s copy of the site .*\(2 artifacts\)/.test(word)),
    words(joined).join(' | '),
  )
  const published = await second.service.publish({ path: page('swell'), title: 'Swell' })
  assert.ok(published.ok)
  const listed = await second.service.list()
  assert.ok(listed.ok)
  assert.deepEqual(listed.artifacts.map((artifact) => artifact.slug).sort(), ['stars', 'swell', 'tide'])

  // Back on the first machine: the artifact published elsewhere is taken in, its own kept.
  const again = await first.service.publish({ path: page('stars'), title: 'Stars', slug: 'stars' })
  assert.ok(again.ok)
  const live = fake.deployments('studio-artifacts').at(-1)?.manifest ?? {}
  for (const slug of ['stars', 'swell', 'tide']) assert.ok(live[`/a/${slug}/meta.json`], slug)
  assert.ok(live['/a/stars/v2/patterns/stars.html'], 'the new version is live')
})

test('reading the live site back never replaces a newer artifact this machine has', async () => {
  const fake = fakeCloudflare()
  const first = machine(fake, 'first')
  const second = machine(fake, 'second')
  assert.ok((await first.setUp({ provider: 'cloudflare-pages', token: FAKE_TOKEN })).ok)
  assert.ok((await first.service.publish({ path: page('stars'), title: 'Stars' })).ok)
  assert.ok((await second.setUp({ provider: 'cloudflare-pages', token: FAKE_TOKEN })).ok)
  // The first machine makes v2 of stars, but its upload fails: v2 exists only there.
  fake.refuseDeployments(1)
  const local = await first.service.publish({ path: page('tide'), title: 'Stars', slug: 'stars' })
  assert.ok(local.ok && !local.live)
  // The second machine publishes something else, so the live site moves on without v2.
  assert.ok((await second.service.publish({ path: page('swell'), title: 'Swell' })).ok)
  const retried = await first.service.update({ slug: 'stars' })
  assert.ok(retried.ok, retried.ok ? '' : retried.message)
  const got = await first.service.get('stars')
  assert.ok(got.ok && got.artifact.version === 2, 'v2, made here, survives the read-back')
  const live = fake.deployments('studio-artifacts').at(-1)?.manifest ?? {}
  assert.ok(live['/a/stars/v2/tide.html'] && live['/a/swell/meta.json'], 'both machines’ work is live')
})

test('a site behind Cloudflare Access cannot be read back, and the publish says so and what to do', async () => {
  const fake = fakeCloudflare()
  const first = machine(fake, 'first')
  assert.ok((await first.setUp({ provider: 'cloudflare-pages', token: FAKE_TOKEN })).ok)
  assert.ok((await first.service.publish({ path: page('stars'), title: 'Stars' })).ok)
  const second = machine(fake, 'second', { behindAccess: true })
  const joined = await second.setUp({ provider: 'cloudflare-pages', token: FAKE_TOKEN })
  assert.equal(joined.ok, false)
  assert.match(!joined.ok ? joined.message : '', /behind Cloudflare Access.*source repository under Advanced/)
  assert.equal(fake.deployments('studio-artifacts').length, 2, 'nothing was uploaded over the first machine’s site')
  // The first machine, whose copy is what is live, publishes behind Access all the same.
  const firstBehind = machine(fake, 'first', { behindAccess: true })
  assert.ok((await firstBehind.service.publish({ path: page('tide'), title: 'Tide' })).ok)
})

test('with a source repository the change is pushed there, deployed with its commit, and no live read is needed', async () => {
  const remote = await bareRemote(root)
  const fake = fakeCloudflare()
  const here = machine(fake, 'a')
  const result = await here.setUp({ provider: 'cloudflare-pages', token: FAKE_TOKEN, repositoryUrl: remote.url })
  assert.ok(result.ok, result.ok ? '' : result.message)
  const published = await here.service.publish({ path: page('stars'), title: 'Stars' })
  assert.ok(published.ok)
  assert.ok(remoteFiles(remote.path).includes('a/stars/meta.json'))
  const latest = fake.deployments('studio-artifacts').at(-1)
  assert.ok(latest?.commit_message.endsWith(published.commit?.slice(0, 12) ?? 'none'))
})

test('a dry run compares the site with Pages and uploads nothing', async () => {
  const fake = fakeCloudflare({
    projects: [
      { name: 'studio-artifacts', subdomain: 'studio-artifacts.pages.dev', domains: [], source: null, deployments: [] },
    ],
  })
  const client = createCloudflarePagesClient({
    accountId: ACCOUNT_ACME,
    projectName: 'studio-artifacts',
    token: async () => FAKE_TOKEN,
    fetch: fake.fetch,
  })
  const files = [
    { path: 'index.html', bytes: Buffer.from('<p>hi</p>') },
    { path: 'a/x/v1/page.html', bytes: Buffer.from('<p>x</p>') },
  ]
  const rehearsed = await client.deploy(files, { commitMessage: 'Check', dryRun: true })
  assert.deepEqual(rehearsed, { ok: true, dryRun: true, files: 2, uploaded: 2, deploymentId: null, url: null })
  assert.equal(fake.writes().length, 0)
  const dir = join(root, 'dry')
  await writeFile(join(root, 'marker'), '')
  const dryHost = createCloudflarePagesHost({
    settings: {
      provider: 'cloudflare-pages',
      github: { repositoryUrl: '', siteUrl: '' },
      cloudflare: { accountId: ACCOUNT_ACME, accountName: 'Acme', projectName: '', repositoryUrl: '', siteUrl: '' },
    },
    dryRun: true,
    deps: {
      dataDir: dir,
      git: testGit,
      resolveHostToken: async () => '',
      cloudflareToken: async () => FAKE_TOKEN,
      fetch: fake.fetch,
    },
  })
  const changed = await dryHost.change(async () => null)
  assert.ok(changed.ok)
  assert.equal(fake.deployments('studio-artifacts').length, 0)
})

test('an asset’s key is 32 hex characters of its content and extension', () => {
  const key = cloudflareAssetHash('a/page.html', Buffer.from('x'))
  assert.match(key, /^[0-9a-f]{32}$/)
  assert.notEqual(key, cloudflareAssetHash('a/page.css', Buffer.from('x')))
  assert.equal(key, cloudflareAssetHash('b/other.html', Buffer.from('x')))
})

export type { ArtifactsSettingsStore }
