import assert from 'node:assert/strict'
import { mkdir, mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join, relative } from 'node:path'
import { afterEach, test } from 'vitest'

import { collectArtifactBundle } from './artifact-bundle'

const roots: string[] = []
afterEach(async () => {
  for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true })
})

/** A project on disk: path → content. */
async function project(files: Record<string, string>): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), 'artifact-bundle-'))
  roots.push(root)
  for (const [path, content] of Object.entries(files)) {
    await mkdir(dirname(join(root, path)), { recursive: true })
    await writeFile(join(root, path), content)
  }
  return root
}

async function bundleOf(input: Parameters<typeof collectArtifactBundle>[0]) {
  const collected = await collectArtifactBundle(input)
  assert.ok(collected.ok, collected.ok ? '' : collected.message)
  return collected.bundle
}

test('a page and what it references keep their layout, so ../ links still resolve', async () => {
  const root = await project({
    'design-system/patterns/stars.html': `<!doctype html><html><head>
      <link rel="stylesheet" href="../foundations/tokens.css">
      <link rel="stylesheet" href="../components/button/component.css?v=2">
      <link rel="canonical" href="https://acme.example/elsewhere">
      <script type="module" src="./stars.js"></script>
      <style>.hero { background: url('../assets/hero.png') }</style>
    </head><body>
      <img srcset="../assets/a.png 1x, ../assets/b.png 2x" src="../assets/a.png" alt="">
      <div style="background-image: url(&quot;../assets/c.png&quot;)"></div>
      <a href="./other.html">Other</a>
      <!-- <img src="../assets/commented.png"> -->
    </body></html>`,
    'design-system/patterns/stars.js': `import { rate } from './rate.js'\nexport const x = rate`,
    'design-system/patterns/rate.js': `export const rate = 1`,
    'design-system/patterns/other.html': '<p>not followed</p>',
    'design-system/foundations/tokens.css': `@import "./fonts.css"; :root { --x: url(../assets/grain.svg) }`,
    'design-system/foundations/fonts.css': `@font-face { src: url("../assets/face.woff2") format("woff2") }`,
    'design-system/components/button/component.css': '.b { color: red }',
    'design-system/assets/hero.png': 'png',
    'design-system/assets/a.png': 'a',
    'design-system/assets/b.png': 'b',
    'design-system/assets/c.png': 'c',
    'design-system/assets/grain.svg': '<svg/>',
    'design-system/assets/face.woff2': 'font',
    'design-system/assets/commented.png': 'never',
  })
  const bundle = await bundleOf({ path: join(root, 'design-system/patterns/stars.html') })
  assert.equal(bundle.entry, 'patterns/stars.html')
  assert.deepEqual(
    bundle.files.map((file) => file.path),
    [
      'assets/a.png',
      'assets/b.png',
      'assets/c.png',
      'assets/face.woff2',
      'assets/grain.svg',
      'assets/hero.png',
      'components/button/component.css',
      'foundations/fonts.css',
      'foundations/tokens.css',
      'patterns/rate.js',
      'patterns/stars.html',
      'patterns/stars.js',
    ],
  )
  assert.ok(
    bundle.files.every((file) => !file.content),
    'nothing needed rewriting',
  )
  assert.deepEqual(bundle.warnings, [])
})

test('a file the page names that is not on disk, or that loads from the network, is said once', async () => {
  const root = await project({
    'page.html': `<link rel="stylesheet" href="missing.css"><script src="https://cdn.example/x.js"></script><img src="//img.example/y.png">`,
  })
  const bundle = await bundleOf({ path: join(root, 'page.html') })
  assert.deepEqual(
    bundle.files.map((file) => file.path),
    ['page.html'],
  )
  assert.equal(bundle.warnings.length, 2)
  assert.match(bundle.warnings[0], /missing\.css .*not on disk/)
  assert.match(bundle.warnings[1], /cdn\.example, img\.example/)
})

test('a stylesheet asked for is linked into the head, its package imports resolved through node_modules', async () => {
  const root = await project({
    'design-system/patterns/stars.html':
      '<html><head><title>x</title><link rel="stylesheet" href="own.css"></head></html>',
    'design-system/patterns/own.css': '',
    'ui/fonts.css': `@import "@fontsource/kalam/400.css";\n@font-face { src: url("@fontsource/plex/files/plex.woff2") }`,
    'node_modules/@fontsource/kalam/400.css': `@font-face { src: url(./files/kalam.woff2) }`,
    'node_modules/@fontsource/kalam/files/kalam.woff2': 'k',
    'node_modules/@fontsource/plex/files/plex.woff2': 'p',
  })
  const bundle = await bundleOf({
    path: join(root, 'design-system/patterns/stars.html'),
    stylesheets: [join(root, 'ui/fonts.css')],
  })
  assert.equal(bundle.entry, 'design-system/patterns/stars.html')
  const byPath = new Map(bundle.files.map((file) => [file.path, file]))
  assert.ok(byPath.has('node_modules/@fontsource/kalam/files/kalam.woff2'))
  assert.ok(byPath.has('node_modules/@fontsource/plex/files/plex.woff2'))
  const page = byPath.get('design-system/patterns/stars.html')?.content?.toString('utf8') ?? ''
  assert.ok(page.indexOf('../../ui/fonts.css') < page.indexOf('own.css'), 'added ahead of the page’s own stylesheets')
  const fonts = byPath.get('ui/fonts.css')?.content?.toString('utf8') ?? ''
  assert.match(fonts, /@import "\.\.\/node_modules\/@fontsource\/kalam\/400\.css"/)
  assert.match(fonts, /url\("\.\.\/node_modules\/@fontsource\/plex\/files\/plex\.woff2"\)/)
})

test('a folder publishes its files, its root-relative links pointed at the folder', async () => {
  const root = await project({
    'site/index.html': '<link rel="stylesheet" href="/css/site.css"><script>fetch("data.json")</script>',
    'site/css/site.css': '',
    'site/data.json': '{}',
    'site/.env': 'SECRET=1',
    'site/node_modules/x/index.js': '',
  })
  const bundle = await bundleOf({ path: join(root, 'site') })
  assert.equal(bundle.entry, 'index.html')
  assert.deepEqual(
    bundle.files.map((file) => file.path),
    ['css/site.css', 'data.json', 'index.html'],
  )
  const page = bundle.files.find((file) => file.path === 'index.html')?.content?.toString('utf8') ?? ''
  assert.match(page, /href="\.\/css\/site\.css"/)
})

test('a folder with several pages and no index says which to open', async () => {
  const root = await project({ 'site/a.html': '', 'site/b.html': '' })
  const collected = await collectArtifactBundle({ path: join(root, 'site') })
  assert.equal(collected.ok, false)
  const chosen = await bundleOf({ path: join(root, 'site'), entry: 'b.html' })
  assert.equal(chosen.entry, 'b.html')
})

test('an entry outside the folder is refused', async () => {
  const root = await project({ 'site/index.html': '', 'outside.html': '' })
  const collected = await collectArtifactBundle({ path: join(root, 'site'), entry: '../outside.html' })
  assert.equal(collected.ok, false)
})

test('a hidden file or a symbolic link the page names is left out, so nothing private rides along', async () => {
  const root = await project({
    'app/pages/leak.html':
      '<img src="../../.ssh/id_ed25519"><link rel="stylesheet" href="../.env"><img src="link.png">',
    '.ssh/id_ed25519': 'PRIVATE KEY',
    'app/.env': 'TOKEN=1',
    'secret.txt': 'secret',
  })
  await symlink(join(root, 'secret.txt'), join(root, 'app/pages/link.png'))
  const bundle = await bundleOf({ path: join(root, 'app/pages/leak.html') })
  assert.deepEqual(
    bundle.files.map((file) => file.path),
    ['leak.html'],
  )
  assert.equal(bundle.warnings.length, 3)
  assert.ok(bundle.warnings.some((warning) => /symbolic link/.test(warning)))
})

test('no published path climbs out of the version folder', async () => {
  const root = await project({
    'a/b/c/page.html': '<link rel="stylesheet" href="../../../top.css">',
    'top.css': '',
  })
  const bundle = await bundleOf({ path: join(root, 'a/b/c/page.html') })
  assert.ok(bundle.files.every((file) => !file.path.split('/').includes('..') && !file.path.startsWith('/')))
  assert.equal(bundle.entry, 'a/b/c/page.html')
})

test('what is not a page is refused, as is a relative path', async () => {
  const root = await project({ 'notes.txt': '' })
  assert.equal((await collectArtifactBundle({ path: join(root, 'notes.txt') })).ok, false)
  assert.equal((await collectArtifactBundle({ path: 'relative/page.html' })).ok, false)
  assert.equal((await collectArtifactBundle({ path: join(root, 'absent.html') })).ok, false)
  assert.equal((await collectArtifactBundle({ path: join(root, 'notes.txt'), stylesheets: ['x.css'] })).ok, false)
})

test('files whose bytes were not changed are read from disk when written', async () => {
  const root = await project({ 'p.html': '<img src="i.png">', 'i.png': 'bytes' })
  const bundle = await bundleOf({ path: join(root, 'p.html') })
  const image = bundle.files.find((file) => file.path === 'i.png')
  assert.equal(image?.content, undefined)
  assert.equal(await readFile(image?.source ?? '', 'utf8'), 'bytes')
})

test('a url() inside a data URI is part of that string, not a file to find', async () => {
  const root = await project({
    'p.html': '<link rel="stylesheet" href="t.css">',
    't.css': `:root { --grain: url("data:image/svg+xml,%3Csvg%3E%3Crect filter='url(%23n)'/%3E%3C/svg%3E"); --img: url('i.png'); --bare: url(j.png) }`,
    'i.png': 'i',
    'j.png': 'j',
  })
  const bundle = await bundleOf({ path: join(root, 'p.html') })
  assert.deepEqual(bundle.warnings, [])
  assert.deepEqual(
    bundle.files.map((file) => file.path),
    ['i.png', 'j.png', 'p.html', 't.css'],
  )
})

test('with roots, a page publishes only what is inside them: ../, other folders and linked folders refuse it', async () => {
  const outside = await project({ 'secret.txt': 'not for the site', 'notes.css': '.n {}', 'page.html': '<p>x</p>' })
  const root = await project({
    'app/site/page.html': '<link rel="stylesheet" href="./local.css"><img src="../shared/logo.png">',
    'app/site/local.css': '.a {}',
    'app/shared/logo.png': 'png',
  })
  const workspace = join(root, 'app')
  const refusedWith = async (input: Parameters<typeof collectArtifactBundle>[0]) => {
    const collected = await collectArtifactBundle(input)
    assert.equal(collected.ok, false, JSON.stringify(input))
    assert.match(collected.ok ? '' : collected.message, /outside the folders this chat may publish from/u)
  }

  // Inside: everything goes, `../` within the project included.
  const inside = await bundleOf({ path: join(workspace, 'site/page.html'), roots: [workspace] })
  assert.deepEqual(inside.files.map((file) => file.path).sort(), [
    'shared/logo.png',
    'site/local.css',
    'site/page.html',
  ])

  // A reference that climbs out of the project, however many `../` it takes.
  await writeFile(
    join(workspace, 'site/climbs.html'),
    `<img src="${relative(join(workspace, 'site'), join(outside, 'secret.txt'))}">`,
  )
  await refusedWith({ path: join(workspace, 'site/climbs.html'), roots: [workspace] })
  // A stylesheet, or the page itself, outside the project.
  await refusedWith({
    path: join(workspace, 'site/page.html'),
    stylesheets: [join(outside, 'notes.css')],
    roots: [workspace],
  })
  await refusedWith({ path: join(outside, 'page.html'), roots: [workspace] })
  // A folder inside the project that is a link to another one.
  await symlink(outside, join(workspace, 'site/linked'))
  await writeFile(join(workspace, 'site/linking.html'), '<img src="./linked/secret.txt">')
  await refusedWith({ path: join(workspace, 'site/linking.html'), roots: [workspace] })

  // Without roots, a page publishes what it references, as it always did.
  assert.equal((await collectArtifactBundle({ path: join(workspace, 'site/climbs.html') })).ok, true)
})
