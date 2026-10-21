import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, test, vi } from 'vitest'

// A recursive mkdir of a Windows drive root fails with EPERM although the
// folder is there. The stand-in mkdir fails the same way for every path, so a
// clone into a parent that already exists must never ask for one.
const { mkdir } = vi.hoisted(() => ({
  mkdir: vi.fn(async (path: string) => {
    throw Object.assign(new Error(`EPERM: operation not permitted, mkdir '${path}'`), { code: 'EPERM' })
  }),
}))
vi.mock('fs/promises', async (importOriginal) => ({ ...(await importOriginal<typeof import('fs/promises')>()), mkdir }))

import { cloneRepository } from './git-clone'

const scratches: string[] = []
afterEach(() => {
  for (const dir of scratches.splice(0)) rmSync(dir, { recursive: true, force: true })
  mkdir.mockClear()
})

test('a clone into a parent folder that exists does not create it', async () => {
  const parent = mkdtempSync(join(tmpdir(), 'git-clone-parent-test-'))
  scratches.push(parent)
  const result = await cloneRepository({
    url: 'https://127.0.0.1:9/platform/api',
    parentDir: parent,
    folderName: 'api',
  })
  assert.equal(mkdir.mock.calls.length, 0)
  assert.equal(!result.ok && result.reason, 'failed')
  assert.doesNotMatch(!result.ok ? result.message : '', /EPERM/, 'the clone itself ran and failed to connect')
})

test('a parent folder that is missing is still created', async () => {
  const parent = join(mkdtempSync(join(tmpdir(), 'git-clone-parent-test-')), 'missing')
  scratches.push(parent)
  const result = await cloneRepository({
    url: 'https://127.0.0.1:9/platform/api',
    parentDir: parent,
    folderName: 'api',
  })
  assert.deepEqual(mkdir.mock.calls[0], [parent, { recursive: true }])
  assert.match(!result.ok ? result.message : '', /EPERM/)
})
