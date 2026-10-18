import assert from 'node:assert/strict'
import { readdir, readFile, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, test } from 'vitest'

import { EMPTY_ARTIFACTS_SETTINGS } from '../../shared/artifacts'
import { createSecretCipherStandIn } from '../../../tests/stubs/secret-cipher'
import { createArtifactsSettingsStore } from './artifacts-settings-store'

const directories: string[] = []
async function tempDir(): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), 'artifacts-settings-'))
  directories.push(directory)
  return directory
}
afterEach(async () => {
  for (const directory of directories.splice(0)) await rm(directory, { recursive: true, force: true })
})

const TOKEN = 'cf-test-token-0123456789abcdef'
const CLOUDFLARE = {
  provider: 'cloudflare-pages',
  cloudflare: { accountId: '0123456789abcdef0123456789abcdef', projectName: 'art' },
}

test('nothing saved reads as no host, and a broken file as the same', async () => {
  const dir = await tempDir()
  const store = createArtifactsSettingsStore({ resolveUserDataDir: () => dir, cipher: createSecretCipherStandIn() })
  assert.deepEqual(store.read(), EMPTY_ARTIFACTS_SETTINGS)
  await writeFile(join(dir, 'artifacts-settings.json'), '{ not json')
  const again = createArtifactsSettingsStore({ resolveUserDataDir: () => dir, cipher: createSecretCipherStandIn() })
  assert.deepEqual(again.read(), EMPTY_ARTIFACTS_SETTINGS)
  assert.deepEqual((await again.view()).cloudflareToken, { configured: false, encryptionAvailable: true })
})

test('the Cloudflare token is sealed apart, never in the settings file or the view', async () => {
  const dir = await tempDir()
  const cipher = createSecretCipherStandIn()
  const store = createArtifactsSettingsStore({ resolveUserDataDir: () => dir, cipher })
  const saved = await store.write(CLOUDFLARE, TOKEN)
  assert.ok(saved.ok, saved.ok ? '' : saved.message)
  assert.equal(saved.view.cloudflareToken.configured, true)
  assert.equal(saved.view.siteUrl, 'https://art.pages.dev/')
  assert.ok(!JSON.stringify(saved.view).includes(TOKEN))
  for (const name of await readdir(dir)) {
    assert.ok(
      !(await readFile(join(dir, name))).toString('utf8').includes(TOKEN),
      `${name} holds the token in the clear`,
    )
  }
  const next = createArtifactsSettingsStore({ resolveUserDataDir: () => dir, cipher })
  assert.equal(await next.cloudflareToken(), TOKEN)
  assert.equal(next.read().provider, 'cloudflare-pages')
})

test('Cloudflare cannot be chosen without a token, and its token cannot be cleared while chosen', async () => {
  const dir = await tempDir()
  const store = createArtifactsSettingsStore({ resolveUserDataDir: () => dir, cipher: createSecretCipherStandIn() })
  const without = await store.write(CLOUDFLARE)
  assert.equal(without.ok ? null : without.field, 'cloudflare.token')
  const malformed = await store.write(CLOUDFLARE, 'has spaces in it, not a token')
  assert.equal(malformed.ok ? null : malformed.field, 'cloudflare.token')
  assert.ok(!(malformed.ok ? '' : malformed.message).includes('has spaces'), 'the token is not repeated back')
  assert.ok((await store.write(CLOUDFLARE, TOKEN)).ok)
  const cleared = await store.write(CLOUDFLARE, '')
  assert.equal(cleared.ok, false)
  // Switching host keeps it unless cleared; clearing then works.
  assert.ok((await store.write({ ...CLOUDFLARE, provider: null }, '')).ok)
  assert.equal(await store.cloudflareToken(), '')
})

test('without secure storage the token lasts for the session only, and is not written', async () => {
  const dir = await tempDir()
  const store = createArtifactsSettingsStore({
    resolveUserDataDir: () => dir,
    cipher: createSecretCipherStandIn({ value: false }),
  })
  const saved = await store.write(CLOUDFLARE, TOKEN)
  assert.ok(saved.ok)
  assert.equal(saved.view.cloudflareToken.encryptionAvailable, false)
  assert.equal(await store.cloudflareToken(), TOKEN)
  assert.deepEqual(await readdir(dir), ['artifacts-settings.json'])
})

test('a refused write names its field and keeps what was saved', async () => {
  const dir = await tempDir()
  const store = createArtifactsSettingsStore({ resolveUserDataDir: () => dir, cipher: createSecretCipherStandIn() })
  assert.ok((await store.write({ provider: 'github-pages', github: { repositoryUrl: 'acme/artifacts' } })).ok)
  const refused = await store.write({
    provider: 'github-pages',
    github: { repositoryUrl: 'acme/artifacts', pagesUrl: 'ftp://x' },
  })
  assert.equal(refused.ok ? null : refused.field, 'github.pagesUrl')
  assert.equal(store.read().github.repositoryUrl, 'acme/artifacts')
  assert.equal((await store.view()).siteUrl, 'https://acme.github.io/artifacts/')
})
