import assert from 'node:assert/strict'
import { randomBytes } from 'node:crypto'
import { existsSync, readFileSync } from 'node:fs'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, test, vi } from 'vitest'

import type { SecretCipher } from '../../server/platform/secret-cipher'

// The trust record is honoured only as Studio wrote it: its entries carry a MAC
// under a key the platform's cipher (safeStorage, in the app) keeps sealed.
// Each case loads the store fresh, as a new launch of the app would, over a
// platform whose cipher it chooses.

let dir = ''

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'se-trust-integrity-'))
})

afterEach(async () => {
  await rm(dir, { recursive: true, force: true })
})

async function launch(cipher: SecretCipher | null) {
  vi.resetModules()
  const platform = await import('../../server/platform/platform')
  if (cipher) platform.installStudioPlatform({ secrets: cipher } as never)
  else platform.resetStudioPlatform()
  return import('./trust-store')
}

async function dataKeyCipher(): Promise<SecretCipher> {
  const { createDataKeySecretCipher } = await import('../../server/platform/secret-cipher')
  return createDataKeySecretCipher(randomBytes(32))
}

test('what Studio wrote is honoured on the next launch, and its key is sealed', async () => {
  const cipher = await dataKeyCipher()
  const first = await launch(cipher)
  const { result } = await first.setModuleTrust(dir, 'acme.notes', 'fp-1')
  assert.equal(result.ok, true)
  const sealedKey = readFileSync(join(dir, 'trusted-modules.key'))
  // The key on disk is the cipher's ciphertext, not the key.
  assert.equal(cipher.open(sealedKey).length > 0, true)
  const next = await launch(cipher)
  assert.deepEqual([...next.readTrustedModulesSync(dir)], [['acme.notes', 'fp-1']])
})

test('a record edited outside Studio is not honoured', async () => {
  const cipher = await dataKeyCipher()
  const store = await launch(cipher)
  await store.setModuleTrust(dir, 'acme.notes', 'fp-1')
  const path = join(dir, 'trusted-modules.json')
  const written = JSON.parse(await readFile(path, 'utf8'))

  // Another module added beside the real one, under the old MAC.
  await writeFile(path, JSON.stringify({ ...written, modules: { ...written.modules, 'other.tool': 'fp-x' } }))
  assert.equal((await launch(cipher)).readTrustedModulesSync(dir).size, 0)

  // The fingerprint swapped for another manifest's.
  await writeFile(path, JSON.stringify({ ...written, modules: { 'acme.notes': 'fp-2' } }))
  assert.equal((await launch(cipher)).readTrustedModulesSync(dir).size, 0)

  // The MAC dropped, or the record in the earlier, unsigned shape.
  await writeFile(path, JSON.stringify({ version: 2, modules: written.modules }))
  assert.equal((await launch(cipher)).readTrustedModulesSync(dir).size, 0)
  await writeFile(path, JSON.stringify({ 'acme.notes': 'fp-1' }))
  assert.equal((await launch(cipher)).readTrustedModulesSync(dir).size, 0)

  // Put back as Studio wrote it, it reads again.
  await writeFile(path, JSON.stringify(written))
  assert.equal((await launch(cipher)).readTrustedModulesSync(dir).get('acme.notes'), 'fp-1')
})

test('a record whose key this machine cannot open is not honoured, and the next grant starts over', async () => {
  const store = await launch(await dataKeyCipher())
  await store.setModuleTrust(dir, 'acme.notes', 'fp-1')
  // Another keychain: the sealed key does not open.
  const elsewhere = await launch(await dataKeyCipher())
  assert.equal(elsewhere.readTrustedModulesSync(dir).size, 0)
  const { trustedModules, previous } = await elsewhere.setModuleTrust(dir, 'acme.tasks', 'fp-9')
  assert.equal(previous, null)
  assert.deepEqual([...trustedModules], [['acme.tasks', 'fp-9']])
  assert.deepEqual([...elsewhere.readTrustedModulesSync(dir)], [['acme.tasks', 'fp-9']])
})

test('with no cipher, trust lasts for the session and nothing is written or read', async () => {
  // A record on disk is not read without the key to check it.
  const sealed = await launch(await dataKeyCipher())
  await sealed.setModuleTrust(dir, 'acme.notes', 'fp-1')
  const before = await readFile(join(dir, 'trusted-modules.json'), 'utf8')

  const store = await launch(null)
  assert.equal(store.readTrustedModulesSync(dir).size, 0)
  const { result } = await store.setModuleTrust(dir, 'acme.tasks', 'fp-2')
  assert.equal(result.ok, true)
  assert.equal(store.readTrustedModulesSync(dir).get('acme.tasks'), 'fp-2')
  assert.equal(await readFile(join(dir, 'trusted-modules.json'), 'utf8'), before)

  const unavailable = { available: () => false, seal: () => Buffer.alloc(0), open: () => '' }
  const other = await mkdtemp(join(tmpdir(), 'se-trust-integrity-'))
  try {
    const locked = await launch(unavailable)
    await locked.setModuleTrust(other, 'acme.tasks', 'fp-2')
    assert.equal(existsSync(join(other, 'trusted-modules.json')), false)
    assert.equal(existsSync(join(other, 'trusted-modules.key')), false)
  } finally {
    await rm(other, { recursive: true, force: true })
  }
})
