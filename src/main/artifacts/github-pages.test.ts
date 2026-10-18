import assert from 'node:assert/strict'
import { mkdtemp } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, test, vi } from 'vitest'

import { createSecretCipherStandIn } from '../../../tests/stubs/secret-cipher'
import {
  bareRemote,
  cleanup,
  hermeticGit,
  mapRemote,
  remoteFiles,
  testGit,
  writeFiles,
} from '../../../tests/artifacts-repo'
import { fakeGitHub } from '../../../tests/fake-github'
import { parseArtifactsRepositoryUrl, type ArtifactsRepository } from '../../shared/artifacts'
import { readArtifactsSiteTemplate } from './artifact-site'
import type { ArtifactsHostDeps } from './artifacts-hosts'
import { createArtifactsService } from './artifacts-service'
import { createArtifactsSettingsStore } from './artifacts-settings-store'
import { setUpArtifacts } from './artifacts-setup'
import { ensurePages, waitForPagesBuild } from './github-pages'

// GitHub is never called here: `gh api` is a fake (tests/fake-github.ts), and
// the repository's https address is pointed at a local bare repository with
// git's own `insteadOf`, so the code under test pushes to the address a
// person would type.

const ADDRESS = 'https://github.com/acme/artifacts'

function repository(address = ADDRESS): ArtifactsRepository {
  const parsed = parseArtifactsRepositoryUrl(address)
  assert.ok(parsed.ok)
  return parsed.repository
}

test('Pages that is off is turned on once, from main at /, and its address read back', async () => {
  const fake = fakeGitHub({ enabledUrl: 'https://docs.acme.example/artifacts/' })
  const on = await ensurePages(fake.gh, repository())
  assert.deepEqual(on, {
    ok: true,
    turnedOn: true,
    site: { url: 'https://docs.acme.example/artifacts/', status: null, branch: 'main', path: '/' },
  })
  assert.deepEqual(fake.calls[1], {
    host: 'github.com',
    path: 'repos/acme/artifacts/pages',
    method: 'POST',
    fields: { 'source[branch]': 'main', 'source[path]': '/' },
  })
  const again = await ensurePages(fake.gh, repository())
  assert.ok(again.ok && !again.turnedOn)
  assert.equal(fake.enables(), 1)
})

test('two callers at once share one request, so Pages is never asked to turn on twice', async () => {
  const fake = fakeGitHub()
  const [one, two] = await Promise.all([ensurePages(fake.gh, repository()), ensurePages(fake.gh, repository())])
  assert.ok(one.ok && two.ok)
  assert.equal(fake.enables(), 1)
})

test('Pages turned on by another machine in between is read as on', async () => {
  const fake = fakeGitHub({ enableRaces: true })
  const on = await ensurePages(fake.gh, repository())
  assert.ok(on.ok, on.ok ? '' : on.message)
  assert.equal(on.ok && on.site.url, 'https://acme.github.io/artifacts/')
})

test('a refusal is said in plain words, with what to do', async () => {
  const plan = await ensurePages(
    fakeGitHub({
      enableFails: { status: 422, message: 'Your current plan does not support GitHub Pages for this repository.' },
    }).gh,
    repository(),
  )
  assert.match(
    !plan.ok ? plan.message : '',
    /not available for a private repository on the plan acme is on.*public.*Cloudflare Pages/,
  )
  const scope = await ensurePages(
    fakeGitHub({ enableFails: { status: 403, message: 'Resource not accessible by personal access token' } }).gh,
    repository(),
  )
  assert.match(
    !scope.ok ? scope.message : '',
    /needs admin rights.*gh auth refresh --hostname github.com --scopes repo/,
  )
  const missing = await ensurePages(fakeGitHub({ notInstalled: true }).gh, repository())
  assert.match(
    !missing.ok ? missing.message : '',
    /GitHub CLI, which is not installed.*gh auth login --hostname github.com/,
  )
})

test('a GitHub Enterprise Server is asked on its own host', async () => {
  const fake = fakeGitHub({ enabledUrl: 'https://pages.git.acme.example/design/artifacts/' })
  const on = await ensurePages(fake.gh, repository('https://git.acme.example:8443/design/artifacts'))
  assert.ok(on.ok)
  assert.ok(fake.calls.every((call) => call.host === 'git.acme.example'))
})

test('the first build is waited for, and given up on in time', async () => {
  let clock = 0
  const timing = { sleep: async (ms: number) => void (clock += ms), now: () => clock, intervalMs: 1000 }
  assert.equal(
    await waitForPagesBuild(fakeGitHub({ buildingPolls: 3 }).gh, repository(), { timeoutMs: 10_000, ...timing }),
    'built',
  )
  clock = 0
  assert.equal(
    await waitForPagesBuild(fakeGitHub({ buildingPolls: 50 }).gh, repository(), { timeoutMs: 5_000, ...timing }),
    'timeout',
  )
  assert.equal(
    await waitForPagesBuild(fakeGitHub({ buildErrors: true }).gh, repository(), { timeoutMs: 5_000, ...timing }),
    'errored',
  )
})

const temporary: string[] = []
let root = ''
let home = ''
let remote = { path: '', url: '' }

beforeEach(async () => {
  home = await hermeticGit()
  temporary.push(home)
  root = await mkdtemp(join(tmpdir(), 'artifacts-github-'))
  temporary.push(root)
  remote = await bareRemote(root)
  await mapRemote(home, `${ADDRESS}.git`, remote.url)
  await writeFiles(join(root, 'work'), { 'stars.html': '<p>Stars</p>' })
})
afterEach(async () => {
  vi.unstubAllEnvs()
  await cleanup(temporary)
})

function machine(fake: ReturnType<typeof fakeGitHub>, options: { buildTimeoutMs?: number } = {}) {
  const store = createArtifactsSettingsStore({
    resolveUserDataDir: () => join(root, 'data'),
    cipher: createSecretCipherStandIn(),
  })
  const hostDeps: ArtifactsHostDeps = {
    dataDir: join(root, 'data', 'artifacts'),
    git: testGit,
    resolveHostToken: async () => '',
    cloudflareToken: async () => '',
    ghApi: fake.gh,
    retryDelayMs: () => 5,
    pagesBuildTimeoutMs: options.buildTimeoutMs ?? 2_000,
    pagesBuildIntervalMs: 10,
    onSiteUrl: (kind, url) =>
      store.update((current) =>
        kind === 'github-pages' ? { ...current, github: { ...current.github, siteUrl: url } } : current,
      ),
  }
  const siteTemplate = () => readArtifactsSiteTemplate(join(process.cwd(), 'resources', 'artifacts-site'))
  const service = createArtifactsService({ settings: () => store.read(), hostDeps, siteTemplate, git: testGit })
  return {
    store,
    service,
    setUp: (repositoryUrl: string, save = true) =>
      setUpArtifacts({ provider: 'github-pages', repositoryUrl }, { save }, { store, hostDeps, siteTemplate }),
  }
}

test('the repository is all it takes: the gallery goes on main, Pages is turned on, and its address is kept', async () => {
  const fake = fakeGitHub({ enabledUrl: 'https://docs.acme.example/artifacts/', buildingPolls: 2 })
  const here = machine(fake)
  const result = await here.setUp(ADDRESS)
  assert.ok(result.ok, result.ok ? '' : result.message)
  assert.deepEqual(
    result.steps.map((step) => [step.label, step.status]),
    [
      ['Repository', 'pass'],
      ['Push', 'pass'],
      ['Gallery', 'pass'],
      ['Pages', 'pass'],
      ['Build', 'pass'],
      ['Site', 'pass'],
    ],
  )
  assert.match(result.steps[3].detail, /Turned on GitHub Pages for acme\/artifacts on github\.com, from main/)
  assert.equal(result.siteUrl, 'https://docs.acme.example/artifacts/')
  assert.deepEqual(here.store.read().github, {
    repositoryUrl: ADDRESS,
    siteUrl: 'https://docs.acme.example/artifacts/',
  })
  assert.ok(remoteFiles(remote.path).includes('index.html'), 'main has the gallery')
  // Set up again: Pages is found on, not turned on twice, and nothing is pushed for nothing.
  const commits = remoteFiles(remote.path).length
  const again = await here.setUp(ADDRESS)
  assert.ok(again.ok)
  assert.ok(again.steps.some((step) => step.detail === 'Found GitHub Pages on, serving main.'))
  assert.equal(fake.enables(), 1)
  assert.equal(remoteFiles(remote.path).length, commits)
})

test('a test does what it says and saves nothing', async () => {
  const here = machine(fakeGitHub())
  const tested = await here.setUp(ADDRESS, false)
  assert.ok(tested.ok)
  assert.equal(here.store.read().provider, null)
})

test('a plan that does not allow Pages is said plainly, and nothing is saved', async () => {
  const fake = fakeGitHub({
    enableFails: { status: 422, message: 'Your current plan does not support GitHub Pages for this repository.' },
  })
  const here = machine(fake)
  const result = await here.setUp(ADDRESS)
  assert.equal(result.ok, false)
  assert.match(!result.ok ? result.message : '', /not available for a private repository/)
  assert.equal(here.store.read().provider, null)
})

test('a repository Studio cannot reach or push to is said before anything else is tried', async () => {
  const fake = fakeGitHub()
  const here = machine(fake)
  const missing = await here.setUp('https://github.com/acme/elsewhere')
  assert.equal(!missing.ok && missing.field, 'github.repositoryUrl')
  assert.equal(fake.calls.length, 0, 'Pages is not asked about')
  const local = await here.setUp(remote.url)
  assert.match(!local.ok ? local.message : '', /github\.com or a GitHub Enterprise Server/)
})

test('a first publish waits for the first build, and says when it is still building', async () => {
  const fake = fakeGitHub({ buildingPolls: 1_000 })
  const here = machine(fake, { buildTimeoutMs: 50 })
  await here.store.write({
    provider: 'github-pages',
    github: { repositoryUrl: ADDRESS, siteUrl: '' },
    cloudflare: { accountId: '', accountName: '', projectName: '', repositoryUrl: '', siteUrl: '' },
  })
  const published = await here.service.publish({ path: join(root, 'work', 'stars.html'), title: 'Stars' })
  assert.ok(published.ok, published.ok ? '' : published.message)
  assert.equal(published.live, false)
  assert.match(
    published.note,
    /still building the site for the first time; it will be at https:\/\/acme\.github\.io\/artifacts\/ in a few minutes/,
  )
  assert.equal(fake.enables(), 1)
  assert.equal(here.store.read().github.siteUrl, 'https://acme.github.io/artifacts/', 'the address GitHub gave is kept')
  // Once built, a publish does not wait for builds again.
  const calls = fake.calls.length
  fake.calls.length = 0
  const next = await createArtifactsService({
    settings: () => here.store.read(),
    hostDeps: {
      dataDir: join(root, 'data', 'artifacts'),
      git: testGit,
      resolveHostToken: async () => '',
      cloudflareToken: async () => '',
      ghApi: fakeGitHub({ pagesUrl: 'https://acme.github.io/artifacts/' }).gh,
    },
    siteTemplate: () => readArtifactsSiteTemplate(join(process.cwd(), 'resources', 'artifacts-site')),
    git: testGit,
  }).publish({ path: join(root, 'work', 'stars.html'), title: 'Stars again' })
  assert.ok(next.ok && next.live, String(calls))
})
