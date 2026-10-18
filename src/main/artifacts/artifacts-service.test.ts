import assert from 'node:assert/strict'
import { mkdtemp } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, test, vi } from 'vitest'

import { EMPTY_ARTIFACTS_SETTINGS, type ArtifactsSettings } from '../../shared/artifacts'
import { readArtifactsSiteTemplate } from './artifact-site'
import { createArtifactsService, siteUrlFor, type ArtifactThumbnailer } from './artifacts-service'
import {
  bareRemote,
  cleanup,
  git,
  hermeticGit,
  remoteFile,
  remoteFiles,
  testGit,
  writeFiles,
} from '../../../tests/artifacts-repo'

const SITE = 'http://127.0.0.1:8123/artifacts/'
const temporary: string[] = []
let root = ''
let remote = { path: '', url: '' }
let pages = ''

beforeEach(async () => {
  temporary.push(await hermeticGit())
  root = await mkdtemp(join(tmpdir(), 'artifacts-service-'))
  temporary.push(root)
  remote = await bareRemote(root)
  pages = join(root, 'work', 'design-system')
  await writeFiles(join(root, 'work'), {
    'design-system/patterns/your-stars.html':
      '<!doctype html><html><head><title>Stars</title><link rel="stylesheet" href="../foundations/tokens.css"></head><body>Stars</body></html>',
    'design-system/foundations/tokens.css': ':root { --x: 1 }',
    'design-system/patterns/other.html': '<p>Other</p>',
  })
})
afterEach(async () => {
  vi.unstubAllEnvs()
  await cleanup(temporary)
})

function settings(): ArtifactsSettings {
  return {
    ...EMPTY_ARTIFACTS_SETTINGS,
    provider: 'github-pages',
    github: { repositoryUrl: remote.url, pagesUrl: SITE },
  }
}

function service(
  name = 'studio',
  options: { settings?: () => ArtifactsSettings; thumbnailer?: ArtifactThumbnailer } = {},
) {
  let clock = Date.parse('2026-10-18T09:00:00Z')
  return createArtifactsService({
    settings: options.settings ?? settings,
    hostDeps: {
      dataDir: join(root, name),
      git: testGit,
      resolveHostToken: async () => '',
      cloudflareToken: async () => '',
      retryDelayMs: () => 5,
    },
    siteTemplate: () => readArtifactsSiteTemplate(join(process.cwd(), 'resources', 'artifacts-site')),
    thumbnailer: options.thumbnailer ?? (async () => Buffer.from('PNG')),
    git: testGit,
    now: () => new Date((clock += 60_000)),
  })
}

const STARS = () => ({
  path: join(pages, 'patterns', 'your-stars.html'),
  title: 'Your stars: a rider’s own star rating',
  tags: ['wingfoil', 'Mockup', 'stars', 'design system'],
  project: 'wingfoil',
  branch: 'agent/your-stars-mockup',
  commit: 'b004ad8',
})

test('with no host chosen, every operation refuses and names the settings page', async () => {
  const off = service('off', { settings: () => EMPTY_ARTIFACTS_SETTINGS })
  for (const outcome of [await off.list(), await off.get('x'), await off.publish(STARS()), await off.remove('x')]) {
    assert.equal(outcome.ok, false)
    assert.equal(!outcome.ok && outcome.code, 'not_configured')
    assert.match(!outcome.ok ? outcome.message : '', /Settings ▸ Artifacts/)
  }
})

test('an empty site is set up with its README, gallery and manifest', async () => {
  const set = await service().initialize()
  assert.ok(set.ok, set.ok ? '' : set.message)
  assert.deepEqual(remoteFiles(remote.path), [
    '.nojekyll',
    'README.md',
    'artifacts.json',
    'assets/gallery.js',
    'assets/site.css',
    'assets/viewer.js',
    'index.html',
  ])
  assert.deepEqual(JSON.parse(remoteFile(remote.path, 'artifacts.json')).artifacts, [])
  assert.match(remoteFile(remote.path, 'README.md'), /Open the gallery: http:\/\/127\.0\.0\.1:8123\/artifacts\//)
})

test('a publish lays out the page with its assets, a record, a thumbnail and a viewer, under the site’s sub-path', async () => {
  const published = await service().publish(STARS())
  assert.ok(published.ok, published.ok ? '' : published.message)
  const slug = 'your-stars-a-riders-own-star-rating'
  assert.equal(published.artifact.slug, slug)
  assert.equal(published.artifact.url, `${SITE}a/${slug}/`)
  assert.equal(published.artifact.pageUrl, `${SITE}a/${slug}/v1/patterns/your-stars.html`)
  assert.equal(published.versionUrl, `${SITE}a/${slug}/?v=1`)
  assert.deepEqual(published.artifact.tags, ['wingfoil', 'mockup', 'stars', 'design-system'])
  assert.equal(published.created, true)
  const files = remoteFiles(remote.path)
  for (const path of [
    'index.html',
    'meta.json',
    'thumbnail.png',
    'v1/patterns/your-stars.html',
    'v1/foundations/tokens.css',
  ]) {
    assert.ok(files.includes(`a/${slug}/${path}`), path)
  }
  const meta = JSON.parse(remoteFile(remote.path, `a/${slug}/meta.json`))
  assert.equal(meta.source.commit, 'b004ad8')
  assert.equal(meta.source.branch, 'agent/your-stars-mockup')
  assert.equal(meta.thumbnail, 'thumbnail.png?v=1')
  const manifest = JSON.parse(remoteFile(remote.path, 'artifacts.json'))
  assert.deepEqual(
    manifest.artifacts.map((artifact: { slug: string; entry: string }) => [artifact.slug, artifact.entry]),
    [[slug, 'v1/patterns/your-stars.html']],
  )
  assert.equal(git(remote.path, ['log', '-1', '--format=%s', 'main']).trim(), `Publish ${slug} v1: ${STARS().title}`)
  assert.ok(!JSON.stringify(manifest).includes(root), 'no local path is published')
})

test('publishing again to a slug adds a version and keeps the earlier one', async () => {
  const studio = service()
  const first = await studio.publish(STARS())
  assert.ok(first.ok)
  const second = await studio.publish({ ...STARS(), slug: first.artifact.slug, commit: 'c0ffee1' })
  assert.ok(second.ok, second.ok ? '' : second.message)
  assert.equal(second.created, false)
  assert.equal(second.artifact.version, 2)
  assert.equal(second.artifact.versionCount, 2)
  const files = remoteFiles(remote.path)
  assert.ok(files.includes(`a/${first.artifact.slug}/v1/patterns/your-stars.html`))
  assert.ok(files.includes(`a/${first.artifact.slug}/v2/patterns/your-stars.html`))
  const got = await studio.get(first.artifact.slug)
  assert.ok(got.ok)
  assert.deepEqual(
    got.artifact.versions.map((version) => [version.version, version.source.commit, version.url]),
    [
      [1, 'b004ad8', `${SITE}a/${first.artifact.slug}/?v=1`],
      [2, 'c0ffee1', `${SITE}a/${first.artifact.slug}/?v=2`],
    ],
  )
})

test('the same title without a slug is a new artifact with a slug of its own', async () => {
  const studio = service()
  const one = await studio.publish(STARS())
  const two = await studio.publish(STARS())
  assert.ok(one.ok && two.ok)
  assert.equal(two.artifact.slug, `${one.artifact.slug}-2`)
})

test('an update retitles and re-tags without a new version, and says what changed', async () => {
  const studio = service()
  const published = await studio.publish(STARS())
  assert.ok(published.ok)
  const updated = await studio.update({ slug: published.artifact.slug, title: 'Your stars', tags: ['stars'] })
  assert.ok(updated.ok, updated.ok ? '' : updated.message)
  assert.deepEqual(updated.changed, ['title', 'tags'])
  assert.equal(updated.artifact.version, 1)
  assert.equal(
    git(remote.path, ['log', '-1', '--format=%s', 'main']).trim(),
    `Update ${published.artifact.slug}: title, tags`,
  )
  const unknown = await studio.update({ slug: 'no-such-thing', title: 'x' })
  assert.equal(!unknown.ok && unknown.code, 'unknown_artifact')
  const thumbOnly = await studio.update({ slug: published.artifact.slug, thumbnail: join(pages, 'x.png') })
  assert.equal(thumbOnly.ok, false)
})

test('list is newest first, and search narrows by words, tags and project', async () => {
  const studio = service()
  await studio.publish(STARS())
  await studio.publish({
    path: join(pages, 'patterns', 'other.html'),
    title: 'Tide table',
    tags: ['tides'],
    project: 'harbour',
  })
  const all = await studio.list()
  assert.ok(all.ok)
  assert.deepEqual(
    all.artifacts.map((artifact) => artifact.title),
    ['Tide table', STARS().title],
  )
  const byWord = await studio.list({ query: 'RIDER star' })
  assert.ok(byWord.ok && byWord.artifacts.length === 1 && byWord.artifacts[0].project === 'wingfoil')
  const byTag = await studio.list({ tags: ['tides'] })
  assert.ok(byTag.ok && byTag.artifacts.map((artifact) => artifact.title).join() === 'Tide table')
  const byProject = await studio.list({ project: 'Wingfoil' })
  assert.ok(byProject.ok && byProject.total === 1)
  const none = await studio.list({ query: 'nothing like it' })
  assert.ok(none.ok && none.total === 0)
})

test('a removal takes the artifact off the site and leaves it in the history', async () => {
  const studio = service()
  const published = await studio.publish(STARS())
  assert.ok(published.ok)
  const removed = await studio.remove(published.artifact.slug)
  assert.ok(removed.ok, removed.ok ? '' : removed.message)
  assert.ok(!remoteFiles(remote.path).some((path) => path.startsWith('a/')))
  assert.deepEqual(JSON.parse(remoteFile(remote.path, 'artifacts.json')).artifacts, [])
  assert.match(git(remote.path, ['show', `main~1:a/${published.artifact.slug}/meta.json`]), /Your stars/)
  const again = await studio.remove(published.artifact.slug)
  assert.equal(!again.ok && again.code, 'unknown_artifact')
})

test('a slug that would climb out of the site is refused before anything is read', async () => {
  const studio = service()
  for (const slug of ['../etc', 'a/b', '..', 'UPPER', '-x', '']) {
    const got = await studio.get(slug)
    assert.equal(!got.ok && got.code, 'invalid_arguments', slug)
    const published = await studio.publish({ ...STARS(), slug })
    assert.equal(!published.ok && published.code, 'invalid_arguments', slug)
    const removed = await studio.remove(slug)
    assert.equal(!removed.ok && removed.code, 'invalid_arguments', slug)
  }
})

test('two Studios publishing at once each land, with one manifest listing all', async () => {
  const left = service('left')
  const right = service('right')
  const outcomes = await Promise.all([
    left.publish({ ...STARS(), title: 'Left one' }),
    right.publish({ ...STARS(), title: 'Right one' }),
    left.publish({ ...STARS(), title: 'Left two' }),
    right.publish({ ...STARS(), title: 'Right two' }),
  ])
  for (const outcome of outcomes) assert.ok(outcome.ok, outcome.ok ? '' : outcome.message)
  const manifest = JSON.parse(remoteFile(remote.path, 'artifacts.json'))
  assert.deepEqual(manifest.artifacts.map((artifact: { title: string }) => artifact.title).sort(), [
    'Left one',
    'Left two',
    'Right one',
    'Right two',
  ])
})

test('where a page came from is read from its checkout, and what the caller says wins', async () => {
  const work = join(root, 'work')
  git(work, ['init', '--quiet', '--initial-branch=agent/sketch'])
  git(work, ['remote', 'add', 'origin', 'git@github.com:acme/wingfoil.git'])
  git(work, ['add', '-A'])
  git(work, ['commit', '--quiet', '-m', 'Sketch'])
  const head = git(work, ['rev-parse', 'HEAD']).trim()
  const studio = service()
  const detected = await studio.publish({ path: join(pages, 'patterns', 'your-stars.html'), title: 'Detected' })
  assert.ok(detected.ok)
  assert.deepEqual(detected.artifact.source, {
    repo: 'acme/wingfoil',
    branch: 'agent/sketch',
    commit: head,
    commitUrl: `https://github.com/acme/wingfoil/commit/${head}`,
  })
  assert.equal(detected.artifact.project, 'wingfoil')
  const given = await studio.publish({ ...STARS(), title: 'Given' })
  assert.ok(given.ok)
  assert.equal(given.artifact.source.commit, 'b004ad8')
  assert.equal(given.artifact.source.commitUrl, 'https://github.com/acme/wingfoil/commit/b004ad8')
})

test('a page whose picture could not be taken is published without one', async () => {
  const published = await service('plain', { thumbnailer: async () => null }).publish(STARS())
  assert.ok(published.ok)
  assert.equal(published.thumbnail, false)
  assert.equal(published.artifact.thumbnail, null)
})

test('a site path is escaped segment by segment under the site’s own sub-path', () => {
  assert.equal(
    siteUrlFor('https://acme.github.io/artifacts/', 'a/x/v1/my page.html'),
    'https://acme.github.io/artifacts/a/x/v1/my%20page.html',
  )
  assert.equal(
    siteUrlFor('https://pages.git.acme.example/design/artifacts/', 'a/x/'),
    'https://pages.git.acme.example/design/artifacts/a/x/',
  )
  assert.equal(siteUrlFor('https://art.pages.dev/', 'a/x/', { v: '2' }), 'https://art.pages.dev/a/x/?v=2')
  assert.equal(siteUrlFor('https://art.pages.dev/', '/a/what?.html'), 'https://art.pages.dev/a/what%3F.html')
})
