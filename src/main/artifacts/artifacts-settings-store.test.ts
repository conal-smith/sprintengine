import assert from 'node:assert/strict'
import { mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, test } from 'vitest'

import { EMPTY_ARTIFACTS_SETTINGS, type ArtifactsSettings } from '../../shared/artifacts'
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
const CLOUDFLARE: ArtifactsSettings = {
  ...EMPTY_ARTIFACTS_SETTINGS,
  provider: 'cloudflare-pages',
  cloudflare: {
    accountId: '0123456789abcdef0123456789abcdef',
    accountName: 'Acme',
    projectName: '',
    repositoryUrl: '',
    siteUrl: 'https://studio-artifacts.pages.dev/',
  },
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
  await store.write(CLOUDFLARE, TOKEN)
  const view = await store.view()
  assert.equal(view.cloudflareToken.configured, true)
  assert.equal(view.siteUrl, 'https://studio-artifacts.pages.dev/')
  assert.ok(!JSON.stringify(view).includes(TOKEN))
  for (const name of await readdir(dir)) {
    assert.ok(
      !(await readFile(join(dir, name))).toString('utf8').includes(TOKEN),
      `${name} holds the token in the clear`,
    )
  }
  const next = createArtifactsSettingsStore({ resolveUserDataDir: () => dir, cipher })
  assert.equal(await next.cloudflareToken(), TOKEN)
  assert.equal(next.read().cloudflare.accountName, 'Acme')
  await next.write({ ...CLOUDFLARE, provider: null }, '')
  assert.equal(await next.cloudflareToken(), '')
})

test('without secure storage the token lasts for the session only, and is not written', async () => {
  const dir = await tempDir()
  const store = createArtifactsSettingsStore({
    resolveUserDataDir: () => dir,
    cipher: createSecretCipherStandIn({ value: false }),
  })
  await store.write(CLOUDFLARE, TOKEN)
  assert.equal((await store.view()).cloudflareToken.encryptionAvailable, false)
  assert.equal(await store.cloudflareToken(), TOKEN)
  assert.deepEqual(await readdir(dir), ['artifacts-settings.json'])
})

test('what a host answers later (its site address) is kept, and only for that host', async () => {
  const dir = await tempDir()
  const store = createArtifactsSettingsStore({ resolveUserDataDir: () => dir, cipher: createSecretCipherStandIn() })
  await store.write({
    ...EMPTY_ARTIFACTS_SETTINGS,
    provider: 'github-pages',
    github: { repositoryUrl: 'acme/artifacts', siteUrl: '' },
  })
  store.update((current) => ({
    ...current,
    github: { ...current.github, siteUrl: 'https://docs.acme.example/artifacts/' },
  }))
  const again = createArtifactsSettingsStore({ resolveUserDataDir: () => dir, cipher: createSecretCipherStandIn() })
  assert.equal((await again.view()).siteUrl, 'https://docs.acme.example/artifacts/')
})
