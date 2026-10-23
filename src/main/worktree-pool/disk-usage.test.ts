import assert from 'node:assert/strict'
import { mkdir, mkdtemp, realpath, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test, vi } from 'vitest'

// Lets a test put pnpm's store on another device without a second volume.
const devices = vi.hoisted(() => ({ moved: null as string | null }))
vi.mock('fs/promises', async (importOriginal) => {
  const actual = await importOriginal<typeof import('fs/promises')>()
  const stat = (async (path: string, options?: unknown) => {
    const info = await actual.stat(path, options as undefined)
    return path === devices.moved ? Object.assign(info, { dev: info.dev + 1 }) : info
  }) as typeof actual.stat
  return { ...actual, stat }
})

import { measureDiskUsage, parseDuOutput } from './disk-usage'

test('du output becomes a total and the largest top-level entries, the rest summed', () => {
  const usage = parseDuOutput(
    ['300\t/w/node_modules', '40\t/w/out', '8\t/w/src', '4\t/w/.git', '2\t/w/docs', '360\t/w', ''].join('\n'),
    '/w/',
    5,
  )
  assert.deepEqual(usage, {
    bytes: 360 * 1024,
    measuredAt: 5,
    parts: [
      { name: 'node_modules', bytes: 300 * 1024 },
      { name: 'out', bytes: 40 * 1024 },
      { name: 'src', bytes: 8 * 1024 },
      { name: '.git', bytes: 4 * 1024 },
      { name: '…', bytes: 8 * 1024 },
    ],
  })
  assert.equal(parseDuOutput('du: cannot read\n', '/w', 0), null, 'no total, no answer')
})

test('a real tree measures at least what is in it, its biggest folder first', async () => {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'sprintengine-disk-usage-')))
  try {
    await mkdir(join(root, 'node_modules', 'pkg'), { recursive: true })
    await writeFile(join(root, 'node_modules', 'pkg', 'blob'), Buffer.alloc(256 * 1024, 1))
    await writeFile(join(root, 'README.md'), '# hi\n')
    const usage = await measureDiskUsage(root)
    assert.ok(usage)
    assert.ok(usage.bytes >= 256 * 1024, `${usage.bytes}`)
    assert.equal(usage.parts[0]?.name, 'node_modules')
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test.each([
  { store: 'same-device', manifest: 'json', platform: process.platform, counted: false },
  { store: 'same-device', manifest: 'yaml', platform: process.platform, counted: false },
  { store: 'same-device', manifest: 'json', platform: 'win32', counted: false },
  { store: 'other-device', manifest: 'json', platform: process.platform, counted: true },
  { store: 'same-device', manifest: 'none', platform: process.platform, counted: true },
] as const)(
  'pnpm packages count only when they do not share the store: $store, $manifest manifest, $platform',
  async ({ store, manifest, platform, counted }) => {
    const root = await realpath(await mkdtemp(join(tmpdir(), 'sprintengine-disk-usage-')))
    const storeDir = await realpath(await mkdtemp(join(tmpdir(), 'sprintengine-pnpm-store-')))
    const realPlatform = process.platform
    try {
      const nodeModules = join(root, 'node_modules')
      await mkdir(join(nodeModules, '.pnpm', 'pkg@1.0.0'), { recursive: true })
      await mkdir(join(nodeModules, '.vite'))
      await writeFile(join(nodeModules, '.pnpm', 'pkg@1.0.0', 'index.js'), Buffer.alloc(256 * 1024, 1))
      await writeFile(join(nodeModules, '.vite', 'deps.js'), Buffer.alloc(64 * 1024, 1))
      if (manifest === 'json')
        await writeFile(join(nodeModules, '.modules.yaml'), JSON.stringify({ storeDir, virtualStoreDir: '.pnpm' }))
      if (manifest === 'yaml')
        await writeFile(
          join(nodeModules, '.modules.yaml'),
          `layoutVersion: 5\nstoreDir: '${storeDir}'\nvirtualStoreDir: .pnpm\n`,
        )
      devices.moved = store === 'other-device' ? storeDir : null
      Object.defineProperty(process, 'platform', { value: platform })
      const usage = await measureDiskUsage(root)
      assert.ok(usage)
      // Other folders under node_modules, such as a bundler's cache, always count.
      assert.ok(usage.bytes >= 64 * 1024, `${usage.bytes}`)
      if (counted) assert.ok(usage.bytes >= 320 * 1024, `${usage.bytes}`)
      else assert.ok(usage.bytes < 256 * 1024, `${usage.bytes}`)
      assert.equal(usage.parts[0]?.name, 'node_modules')
    } finally {
      Object.defineProperty(process, 'platform', { value: realPlatform })
      devices.moved = null
      await rm(root, { recursive: true, force: true })
      await rm(storeDir, { recursive: true, force: true })
    }
  },
)
