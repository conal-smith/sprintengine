import assert from 'node:assert/strict'

import { icnsFile, pngOfWidth } from '../../tests/icns'
import { pngHeader } from '../../tests/image-headers'
import {
  PROJECT_LOGO_ICNS_MAX_BYTES,
  PROJECT_LOGO_MAX_BYTES,
  PROJECT_LOGO_RASTER_MAX_PX,
  createProjectLogoResolver,
  detectProjectLogo,
  pageIconPaths,
  rankProjectLogoCandidates,
  sanitizeProjectLogoSvg,
  type ProjectLogoIo,
} from './project-logo'
import { expect, test } from 'vitest'

// The io seam, faked over a repo shape stated in the test rather than one
// built on disk.
type FakeFile = { bytes: Buffer; size?: number; mtimeMs?: number; isFile?: boolean }

function createIo(files: Record<string, FakeFile>, options: { onDownscale?: () => void } = {}) {
  const reads: string[] = []
  const io: ProjectLogoIo = {
    async readdir(dirPath: string) {
      const prefix = `${dirPath}/`
      const names = Object.keys(files)
        .filter((path) => path.startsWith(prefix))
        .map((path) => path.slice(prefix.length))
      if (names.length === 0 && dirPath === '/gone') throw new Error('ENOENT')
      return names
    },
    async stat(filePath: string) {
      const file = files[filePath]
      if (!file) throw new Error(`ENOENT: ${filePath}`)
      return {
        isFile: file.isFile ?? true,
        size: file.size ?? file.bytes.byteLength,
        mtimeMs: file.mtimeMs ?? 1000,
      }
    },
    async readFile(filePath: string) {
      const file = files[filePath]
      if (!file) throw new Error(`ENOENT: ${filePath}`)
      reads.push(filePath)
      return file.bytes
    },
    async downscaleRaster(bytes, mimeType) {
      options.onDownscale?.()
      // Stand in for nativeImage: the real one re-encodes to PNG.
      return { bytes: Buffer.concat([Buffer.from('resized:'), bytes]), mimeType }
    },
    join: (dirPath, name) => `${dirPath}/${name}`,
  }
  return { io, reads }
}

test('project-logo', async () => {
  // The detection half of project logos: the ranking, the size guard, the SVG
  // sanitizer, and the mtime cache, all exercised against the faked io.

  const CLEAN_SVG = '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24"><rect width="24" height="24" /></svg>'

  function decode(dataUrl: string): string {
    return Buffer.from(dataUrl.slice(dataUrl.indexOf(',') + 1), 'base64').toString('utf-8')
  }

  // --- ranking -----------------------------------------------------------------

  assert.deepEqual(
    rankProjectLogoCandidates(['README.md', 'favicon.ico', 'src', 'logo.svg', 'icon.png']),
    ['logo.svg', 'icon.png', 'favicon.ico'],
    'candidates come back in declared rank order, not directory order',
  )
  assert.deepEqual(
    rankProjectLogoCandidates(['LOGO.SVG', 'Favicon.PNG']),
    ['LOGO.SVG', 'Favicon.PNG'],
    'matching is case-insensitive and the real on-disk name is returned',
  )
  assert.deepEqual(rankProjectLogoCandidates(['logo.jpg', 'brand.svg']), [], 'unranked names are not candidates')

  // --- sanitizer ---------------------------------------------------------------

  assert.equal(sanitizeProjectLogoSvg(CLEAN_SVG), CLEAN_SVG, 'a clean SVG passes through unchanged')
  assert.equal(
    sanitizeProjectLogoSvg('<svg><script>alert(1)</script></svg>'),
    null,
    'AC: an SVG containing a <script> element is rejected',
  )
  assert.equal(sanitizeProjectLogoSvg('<svg onload="steal()"></svg>'), null, 'inline event handlers are rejected')
  assert.equal(
    sanitizeProjectLogoSvg('<svg><image href="https://example.com/a.png" /></svg>'),
    null,
    'an external image reference is rejected',
  )
  assert.equal(
    sanitizeProjectLogoSvg('<svg><use xlink:href="../other.svg#g" /></svg>'),
    null,
    'a relative external reference is rejected',
  )
  assert.equal(
    sanitizeProjectLogoSvg('<svg><use href="#glyph" /></svg>'),
    '<svg><use href="#glyph" /></svg>',
    'a same-document reference is allowed',
  )
  assert.equal(
    sanitizeProjectLogoSvg('<svg><style>@import url("http://x/y.css");</style></svg>'),
    null,
    'a stylesheet import is rejected',
  )
  assert.equal(
    sanitizeProjectLogoSvg('<svg><a href="javascript:alert(1)">x</a></svg>'),
    null,
    'a javascript: URL is rejected',
  )
  assert.equal(
    sanitizeProjectLogoSvg('<!DOCTYPE svg [<!ENTITY xxe SYSTEM "file:///etc/passwd">]><svg />'),
    null,
    'an entity declaration (XXE) is rejected',
  )
  assert.equal(
    sanitizeProjectLogoSvg(
      `<!DOCTYPE svg PUBLIC "-//W3C//DTD SVG 1.1//EN" "http://www.w3.org/Graphics/SVG/1.1/DTD/svg11.dtd">${CLEAN_SVG}`,
    ) !== null,
    true,
    'a bare doctype with no internal subset is not a rejection on its own',
  )
  assert.notEqual(
    sanitizeProjectLogoSvg('<svg xmlns:xlink="http://www.w3.org/1999/xlink"><path d="M0 0h4v4z" /></svg>'),
    null,
    'namespace declarations are not external references',
  )

  // --- detection ---------------------------------------------------------------

  async function main(): Promise<void> {
    {
      const { io } = createIo({
        '/repo/favicon.ico': { bytes: Buffer.from('ico') },
        '/repo/logo.svg': { bytes: Buffer.from(CLEAN_SVG), mtimeMs: 42 },
        '/repo/README.md': { bytes: Buffer.from('# hi') },
      })
      const logo = await detectProjectLogo('/repo', io)
      assert.ok(logo, 'a repo with a logo resolves one')
      assert.equal(logo.path, '/repo/logo.svg', 'AC: with both favicon.ico and logo.svg, the SVG wins')
      assert.equal(logo.mtimeMs, 42)
      assert.ok(logo.dataUrl.startsWith('data:image/svg+xml;base64,'))
      assert.equal(decode(logo.dataUrl), CLEAN_SVG, 'the SVG travels as authored')
    }

    {
      const { io } = createIo({
        '/repo/logo.svg': { bytes: Buffer.from(CLEAN_SVG), size: PROJECT_LOGO_MAX_BYTES + 1 },
        '/repo/icon.png': { bytes: Buffer.from('png-bytes') },
      })
      const logo = await detectProjectLogo('/repo', io)
      assert.equal(logo?.path, '/repo/icon.png', 'AC: an oversized candidate is skipped for the next-ranked one')
      assert.equal(decode(logo?.dataUrl ?? ''), 'resized:png-bytes', 'raster candidates are downscaled before caching')
      assert.ok(logo?.dataUrl.startsWith('data:image/png;base64,'))
    }

    {
      const { io } = createIo({
        '/repo/logo.svg': { bytes: Buffer.from('<svg><script>alert(1)</script></svg>') },
        '/repo/favicon.png': { bytes: Buffer.from('png') },
      })
      const logo = await detectProjectLogo('/repo', io)
      assert.equal(logo?.path, '/repo/favicon.png', 'a rejected SVG falls through to the next candidate')
    }

    {
      const { io } = createIo({ '/repo/README.md': { bytes: Buffer.from('# hi') } })
      assert.equal(await detectProjectLogo('/repo', io), null, 'AC: a repo with no candidates resolves nothing')
    }

    {
      const { io } = createIo({})
      assert.equal(
        await detectProjectLogo('/gone', io),
        null,
        'an unreadable folder resolves nothing instead of throwing',
      )
    }

    {
      // A resizer that cannot decode the bytes is not a reason to drop the logo:
      // the 1 MB guard already bounds what we serve, so it falls back to the
      // candidate's own bytes rather than all the way to the glyph.
      const { io } = createIo({ '/repo/favicon.ico': { bytes: Buffer.from('ico-bytes') } })
      const failing: ProjectLogoIo = {
        ...io,
        async downscaleRaster() {
          throw new Error('nativeImage unavailable')
        },
      }
      const logo = await detectProjectLogo('/repo', failing)
      assert.equal(logo?.path, '/repo/favicon.ico', 'a failing downscale still yields the logo')
      assert.equal(decode(logo?.dataUrl ?? ''), 'ico-bytes', 'the original bytes are served when the resize fails')
    }

    {
      // A directory named `logo.svg` is not a logo. The real io filters directories
      // out of readdir too; this pins the second guard.
      const { io } = createIo({ '/repo/logo.svg': { bytes: Buffer.from(''), isFile: false } })
      assert.equal(await detectProjectLogo('/repo', io), null, 'a non-file candidate is skipped')
    }

    // --- resolver cache ----------------------------------------------------------

    {
      const files: Record<string, FakeFile> = { '/repo/logo.svg': { bytes: Buffer.from(CLEAN_SVG), mtimeMs: 5 } }
      const { io, reads } = createIo(files)
      const resolver = createProjectLogoResolver(io)

      assert.equal((await resolver.resolve('/repo'))?.path, '/repo/logo.svg')
      assert.equal(reads.length, 1, 'first resolve reads the file')

      await resolver.resolve('/repo')
      assert.equal(reads.length, 1, 'an unchanged mtime is served from cache without re-reading')

      files['/repo/logo.svg'] = { bytes: Buffer.from(CLEAN_SVG), mtimeMs: 6 }
      await resolver.resolve('/repo')
      assert.equal(reads.length, 2, 'a changed mtime rescans')

      delete files['/repo/logo.svg']
      assert.equal(
        await resolver.resolve('/repo'),
        null,
        'AC: removing the file and reopening restores the glyph (no stale cached logo)',
      )

      files['/repo/logo.svg'] = { bytes: Buffer.from(CLEAN_SVG), mtimeMs: 7 }
      assert.equal(
        (await resolver.resolve('/repo'))?.path,
        '/repo/logo.svg',
        'a miss is not cached, so a logo added later is picked up on the next open',
      )
    }

    assert.equal(PROJECT_LOGO_RASTER_MAX_PX, 32, 'raster cap stays 2x the 16px icon slot')
  }

  const suiteRun = main()
    .then(() => console.log('project logo tests passed'))
    .catch((error) => {
      console.error(error)
      process.exitCode = 1
    })

  await suiteRun
})

// What a detected logo serves, as the fake downscaler marked it.
function served(dataUrl: string | undefined): Buffer {
  return Buffer.from((dataUrl ?? '').slice((dataUrl ?? '').indexOf(',') + 1), 'base64')
}

const APP_ICON = icnsFile(['ic10', pngOfWidth(1024)], ['icp5', pngOfWidth(32)], ['it32', Buffer.alloc(64)])

test('an app icon under build/ is the logo, served as the PNG it carries', async () => {
  const { io } = createIo({ '/repo/build/icon.icns': { bytes: APP_ICON, mtimeMs: 9 } })
  const logo = await detectProjectLogo('/repo', io)
  expect(logo?.path).toBe('/repo/build/icon.icns')
  expect(logo?.mtimeMs).toBe(9)
  expect(logo?.dataUrl.startsWith('data:image/png;base64,')).toBe(true)
  expect(served(logo?.dataUrl)).toEqual(Buffer.concat([Buffer.from('resized:'), pngOfWidth(32)]))
})

test('a top-level app icon matches whatever its case', async () => {
  const { io } = createIo({ '/repo/AppIcon.icns': { bytes: APP_ICON } })
  expect((await detectProjectLogo('/repo', io))?.path).toBe('/repo/AppIcon.icns')
})

test('every existing candidate outranks an app icon', async () => {
  const { io } = createIo({
    '/repo/favicon.ico': { bytes: Buffer.from('ico') },
    '/repo/AppIcon.icns': { bytes: APP_ICON },
    '/repo/build/icon.icns': { bytes: APP_ICON },
  })
  expect((await detectProjectLogo('/repo', io))?.path).toBe('/repo/favicon.ico')
})

test('a top-level app icon outranks one in a folder, and the folders keep their order', async () => {
  const files: Record<string, FakeFile> = {
    '/repo/icon.icns': { bytes: APP_ICON },
    '/repo/build/icon.icns': { bytes: APP_ICON },
    '/repo/resources/icon.icns': { bytes: APP_ICON },
    '/repo/Resources/AppIcon.icns': { bytes: APP_ICON },
  }
  const { io } = createIo(files)
  const order: string[] = []
  for (const path of Object.keys(files)) {
    order.push((await detectProjectLogo('/repo', io))?.path ?? '')
    delete files[path]
  }
  expect(order).toEqual([
    '/repo/icon.icns',
    '/repo/build/icon.icns',
    '/repo/resources/icon.icns',
    '/repo/Resources/AppIcon.icns',
  ])
})

test('an app icon with no PNG in it falls through to the next candidate', async () => {
  const { io } = createIo({
    '/repo/build/icon.icns': { bytes: icnsFile(['it32', Buffer.alloc(64)]) },
    '/repo/resources/icon.icns': { bytes: Buffer.from('not an icon at all') },
    '/repo/Resources/AppIcon.icns': { bytes: APP_ICON },
  })
  expect((await detectProjectLogo('/repo', io))?.path).toBe('/repo/Resources/AppIcon.icns')
})

test('an app icon past a megabyte is read, and one past its own bound is skipped unread', async () => {
  const { io, reads } = createIo({
    '/repo/build/icon.icns': { bytes: APP_ICON, size: PROJECT_LOGO_ICNS_MAX_BYTES + 1 },
    '/repo/resources/icon.icns': { bytes: APP_ICON, size: PROJECT_LOGO_MAX_BYTES * 2 },
  })
  expect((await detectProjectLogo('/repo', io))?.path).toBe('/repo/resources/icon.icns')
  expect(reads).toEqual(['/repo/resources/icon.icns'])
})

test('a PNG too big to serve is not taken out of an app icon', async () => {
  const huge = Buffer.concat([pngOfWidth(1024), Buffer.alloc(PROJECT_LOGO_MAX_BYTES)])
  const { io } = createIo({ '/repo/build/icon.icns': { bytes: icnsFile(['ic10', huge]) } })
  expect(await detectProjectLogo('/repo', io)).toBeNull()
})

test('a logo whose header declares a vast picture is passed over, not decoded', async () => {
  let downscaled = 0
  const { io } = createIo(
    { '/repo/logo.png': { bytes: Buffer.from(pngHeader(100_000, 100_000)) } },
    { onDownscale: () => downscaled++ },
  )
  expect(await detectProjectLogo('/repo', io)).toBeNull()
  expect(downscaled).toBe(0)
})

test('a web project’s favicon is found in its public, app and asset folders, and from its page’s icon link', async () => {
  const SVG = '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 8 8"><rect width="8" height="8" /></svg>'
  const svg = { bytes: Buffer.from(SVG) }
  const found = async (files: Record<string, FakeFile>) => (await detectProjectLogo('/repo', createIo(files).io))?.path

  expect(await found({ '/repo/README.md': svg, '/repo/public/favicon.svg': svg })).toBe('/repo/public/favicon.svg')
  expect(await found({ '/repo/src/app/icon.svg': svg })).toBe('/repo/src/app/icon.svg')
  expect(await found({ '/repo/static/favicon.svg': svg, '/repo/assets/logo.svg': svg })).toBe('/repo/assets/logo.svg')
  expect(await found({ '/repo/logo.svg': svg, '/repo/public/favicon.svg': svg })).toBe('/repo/logo.svg')
  // The page's own link, ahead of the folders: Vite serves `/` from public/.
  const page = { bytes: Buffer.from('<head><link rel="icon" type="image/svg+xml" href="/brand/mark.svg?v=2"></head>') }
  expect(
    await found({ '/repo/index.html': page, '/repo/public/brand/mark.svg': svg, '/repo/public/favicon.svg': svg }),
  ).toBe('/repo/public/brand/mark.svg')
  // A rejected SVG in a folder falls through to the next candidate, as at the top level.
  const scripted = { bytes: Buffer.from('<svg><script>alert(1)</script></svg>') }
  expect(await found({ '/repo/public/favicon.svg': scripted, '/repo/app/icon.svg': svg })).toBe('/repo/app/icon.svg')
})

test('a page’s icon link names a path in the project, never a URL or a climb out of it', () => {
  expect(pageIconPaths('<link rel="shortcut icon" href="favicon.ico">', '')).toEqual(['favicon.ico'])
  expect(pageIconPaths("<link href='./img/i.png' rel='icon'>", 'public')).toEqual(['public/img/i.png'])
  expect(pageIconPaths('<link rel="icon" href="/f.svg">', '')).toEqual(['public/f.svg', 'f.svg'])
  expect(pageIconPaths('<link rel="apple-touch-icon" href="touch.png">', '')).toEqual(['touch.png'])
  for (const href of [
    'https://cdn.example.com/f.svg',
    '//cdn/f.svg',
    'data:image/svg+xml,<svg/>',
    '../f.svg',
    'a\\..\\f.svg',
  ])
    expect(pageIconPaths(`<link rel="icon" href="${href}">`, '')).toEqual([])
  expect(pageIconPaths('<link rel="stylesheet" href="app.css">', '')).toEqual([])
})
