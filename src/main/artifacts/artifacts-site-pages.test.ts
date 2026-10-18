import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { JSDOM } from 'jsdom'
import { test } from 'vitest'

// The site's own pages, as a reader's browser runs them: the gallery reading
// artifacts.json, and an artifact's viewer reading its meta.json, with zero,
// one and many artifacts. The pages are the files Studio writes into the
// repository (resources/artifacts-site).

const SITE_DIR = join(process.cwd(), 'resources', 'artifacts-site')
const read = (path: string) => readFileSync(join(SITE_DIR, path), 'utf8')

type Summary = {
  slug: string
  title: string
  description?: string
  tags: string[]
  project: string
  updatedAt: string
  version: number
  thumbnail: string | null
}

function summary(index: number, extra: Partial<Summary> = {}): Summary {
  return {
    slug: `artifact-${index}`,
    title: `Artifact ${index}`,
    tags: index % 2 ? ['mockup'] : ['report', 'tides'],
    project: index % 3 ? 'wingfoil' : 'harbour',
    updatedAt: new Date(Date.UTC(2026, 9, 1 + index)).toISOString(),
    version: 1,
    thumbnail: index % 2 ? 'thumbnail.png?v=1' : null,
    ...extra,
  }
}

async function settle(window: JSDOM['window']): Promise<void> {
  for (let i = 0; i < 5; i += 1) await new Promise((resolve) => window.setTimeout(resolve, 0))
}

async function gallery(artifacts: Summary[] | 'missing', search = ''): Promise<JSDOM['window']> {
  const dom = new JSDOM(read('index.html').replace(/<script[^>]*><\/script>/, ''), {
    url: `http://127.0.0.1:8123/artifacts/${search}`,
    runScripts: 'outside-only',
  })
  const window = dom.window
  const fetched: string[] = []
  ;(window as unknown as { fetch: unknown }).fetch = async (url: string) => {
    fetched.push(url)
    if (artifacts === 'missing') return { ok: false, status: 404, json: async () => ({}) }
    return { ok: true, status: 200, json: async () => ({ schema: 1, artifacts }) }
  }
  window.eval(read('assets/gallery.js'))
  await settle(window)
  assert.deepEqual(fetched, ['artifacts.json'], 'the manifest is read relative to the page, so a sub-path works')
  return window
}

const titles = (window: JSDOM['window']) =>
  [...window.document.querySelectorAll('.card-title')].map((node) => node.textContent ?? '')

test('with nothing published the gallery says so, with no filters', async () => {
  const window = await gallery([])
  assert.equal(titles(window).length, 0)
  assert.equal(window.document.getElementById('empty')?.hidden, false)
  assert.match(window.document.getElementById('empty')?.textContent ?? '', /Nothing published yet/)
  assert.equal(window.document.getElementById('tags')?.hidden, true)
  assert.equal(window.document.getElementById('count')?.textContent, '0 artifacts')
})

test('one artifact is one card linking to its page, with its picture, project and tags', async () => {
  const window = await gallery([summary(1)])
  assert.deepEqual(titles(window), ['Artifact 1'])
  const card = window.document.querySelector('.card')
  assert.equal(card?.querySelector('a.open')?.getAttribute('href'), 'a/artifact-1/')
  assert.equal(card?.querySelector('img')?.getAttribute('src'), 'a/artifact-1/thumbnail.png?v=1')
  assert.equal(card?.querySelector('.project')?.textContent, 'wingfoil')
  assert.equal(window.document.getElementById('count')?.textContent, '1 artifact')
  assert.equal(
    (window.document.getElementById('project') as HTMLSelectElement).hidden,
    true,
    'one project needs no filter',
  )
})

test('many artifacts are newest first, and narrow as you type, by tag and by project', async () => {
  const window = await gallery([1, 2, 3, 4, 5, 6].map((index) => summary(index)))
  assert.deepEqual(titles(window), ['Artifact 6', 'Artifact 5', 'Artifact 4', 'Artifact 3', 'Artifact 2', 'Artifact 1'])
  const search = window.document.getElementById('search') as HTMLInputElement
  search.value = 'artifact 4'
  search.dispatchEvent(new window.Event('input'))
  assert.deepEqual(titles(window), ['Artifact 4'])
  assert.equal(window.document.getElementById('count')?.textContent, '1 of 6')
  assert.equal(window.location.search, '?q=artifact+4')
  search.value = ''
  search.dispatchEvent(new window.Event('input'))
  const mockup = [...window.document.querySelectorAll('.tag-filter')].find(
    (node) => node.textContent === 'mockup',
  ) as HTMLButtonElement
  mockup.click()
  assert.deepEqual(titles(window), ['Artifact 5', 'Artifact 3', 'Artifact 1'])
  const project = window.document.getElementById('project') as HTMLSelectElement
  assert.equal(project.hidden, false)
  project.value = 'harbour'
  project.dispatchEvent(new window.Event('change'))
  assert.deepEqual(titles(window), ['Artifact 3'])
  ;(window.document.querySelector('[data-view="list"]') as HTMLButtonElement).click()
  assert.equal(window.document.getElementById('results')?.className, 'results list')
})

test('filters in the address are applied when the gallery opens', async () => {
  const window = await gallery(
    [1, 2, 3, 4].map((index) => summary(index)),
    '?tag=tides&project=wingfoil',
  )
  assert.deepEqual(titles(window), ['Artifact 4', 'Artifact 2'])
})

test('a title is text, never markup', async () => {
  const window = await gallery([summary(1, { title: '<img src=x onerror="window.pwned=1">Stars' })])
  assert.equal(window.document.querySelector('.card-title img'), null)
  assert.equal(titles(window)[0], '<img src=x onerror="window.pwned=1">Stars')
})

test('a manifest that cannot be read is said, not a blank page', async () => {
  const window = await gallery('missing')
  assert.match(
    window.document.getElementById('empty')?.textContent ?? '',
    /could not be read \(artifacts\.json answered 404\)/,
  )
})

async function viewer(meta: unknown, search = ''): Promise<JSDOM['window']> {
  const dom = new JSDOM(read('artifact.html').replace(/<script[^>]*><\/script>/, ''), {
    url: `http://127.0.0.1:8123/artifacts/a/your-stars/${search}`,
    runScripts: 'outside-only',
  })
  const window = dom.window
  ;(window as unknown as { fetch: unknown }).fetch = async (url: string) => {
    assert.equal(url, 'meta.json')
    return meta === null
      ? { ok: false, status: 404, json: async () => ({}) }
      : { ok: true, status: 200, json: async () => meta }
  }
  window.eval(read('assets/viewer.js'))
  await settle(window)
  return window
}

const META = {
  slug: 'your-stars',
  title: 'Your stars',
  tags: ['mockup', 'stars'],
  versions: [
    {
      version: 1,
      publishedAt: '2026-10-17T10:00:00Z',
      entry: 'v1/patterns/your-stars.html',
      source: {
        commit: 'b004ad8aaaa',
        repo: 'acme/wingfoil',
        commitUrl: 'https://github.com/acme/wingfoil/commit/b004ad8aaaa',
      },
    },
    {
      version: 2,
      publishedAt: '2026-10-18T10:00:00Z',
      entry: 'v2/patterns/your-stars.html',
      source: { commit: 'c0ffee1bbbb' },
    },
  ],
}

test('the viewer opens the latest version, with its tags, a version picker and its commit', async () => {
  const window = await viewer(META)
  const document = window.document
  assert.equal(document.getElementById('title')?.textContent, 'Your stars')
  assert.equal(document.getElementById('frame')?.getAttribute('src'), 'v2/patterns/your-stars.html')
  const picker = document.getElementById('version') as HTMLSelectElement
  assert.equal(picker.hidden, false)
  assert.deepEqual(
    [...picker.options].map((option) => option.value),
    ['2', '1'],
  )
  assert.equal(document.getElementById('commit')?.textContent, 'c0ffee1')
  assert.equal(document.querySelector('.back')?.getAttribute('href'), '../../')
  picker.value = '1'
  picker.dispatchEvent(new window.Event('change'))
  assert.equal(document.getElementById('frame')?.getAttribute('src'), 'v1/patterns/your-stars.html')
  assert.equal(window.location.search, '?v=1')
  assert.equal(
    document.getElementById('commit')?.getAttribute('href'),
    'https://github.com/acme/wingfoil/commit/b004ad8aaaa',
  )
})

test('the viewer opens the version in the address, and hides the picker for a single version', async () => {
  const earlier = await viewer(META, '?v=1')
  assert.equal(earlier.document.getElementById('frame')?.getAttribute('src'), 'v1/patterns/your-stars.html')
  const single = await viewer({ ...META, versions: [META.versions[0]] })
  assert.equal((single.document.getElementById('version') as HTMLSelectElement).hidden, true)
})

test('an artifact that is not there says so', async () => {
  const window = await viewer(null)
  assert.equal(window.document.getElementById('title')?.textContent, 'Not found')
  assert.match(window.document.getElementById('missing')?.textContent ?? '', /not published here/)
})

test('a hand-edited record cannot make the viewer run script or open another site’s page', async () => {
  const window = await viewer({
    ...META,
    versions: [
      {
        version: 1,
        publishedAt: '2026-10-17T10:00:00Z',
        entry: 'v1/page.html',
        source: { commit: 'b004ad8', commitUrl: 'javascript:alert(1)' },
      },
      { version: 2, publishedAt: '2026-10-18T10:00:00Z', entry: 'javascript:alert(2)', source: {} },
      { version: 3, publishedAt: '2026-10-18T11:00:00Z', entry: 'https://elsewhere.example/x.html', source: {} },
      { version: 4, publishedAt: '2026-10-18T12:00:00Z', entry: 'v4/../../../other/page.html', source: {} },
    ],
  })
  assert.equal(window.document.getElementById('frame')?.getAttribute('src'), 'v1/page.html')
  assert.equal(window.document.getElementById('commit')?.hasAttribute('href'), false)
})

test('a hand-edited manifest entry with a slug that is not a folder is left out', async () => {
  const window = await gallery([
    summary(1),
    summary(2, { slug: '../../elsewhere' }),
    summary(3, { thumbnail: 'https://elsewhere.example/x.png' }),
  ])
  assert.deepEqual(titles(window), ['Artifact 3', 'Artifact 1'])
  const cards = [...window.document.querySelectorAll('.card')]
  assert.equal(cards[0].querySelector('img'), null, 'a picture from elsewhere is not shown')
  assert.ok(cards[1].querySelector('img'), 'its own picture is')
})
