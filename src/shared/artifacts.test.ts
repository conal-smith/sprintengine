import assert from 'node:assert/strict'
import { test } from 'vitest'

import {
  artifactsSiteUrl,
  CLOUDFLARE_TOKEN_URL,
  cloudflareProjectName,
  defaultGitHubPagesUrl,
  EMPTY_ARTIFACTS_SETTINGS,
  isArtifactsHostReady,
  normalizeSiteUrl,
  parseArtifactsRepositoryUrl,
  readArtifactsSettings,
} from './artifacts'

function repository(input: string) {
  const parsed = parseArtifactsRepositoryUrl(input)
  assert.equal(parsed.ok, true, input)
  return parsed.ok ? parsed.repository : (null as never)
}

test('owner/name is a repository on github.com, pushed over https', () => {
  assert.deepEqual(repository('acme/artifacts'), {
    host: 'github.com',
    owner: 'acme',
    name: 'artifacts',
    remoteUrl: 'https://github.com/acme/artifacts.git',
    transport: 'https',
  })
})

test('an https address keeps its host, a company’s GitHub included', () => {
  assert.deepEqual(repository('https://github.com/acme/artifacts'), repository('acme/artifacts'))
  assert.deepEqual(repository('https://git.acme.example/design/artifacts.git/'), {
    host: 'git.acme.example',
    owner: 'design',
    name: 'artifacts',
    remoteUrl: 'https://git.acme.example/design/artifacts.git',
    transport: 'https',
  })
})

test('an ssh address is pushed as given, with the person’s own keys', () => {
  assert.deepEqual(repository('git@git.acme.example:design/artifacts.git'), {
    host: 'git.acme.example',
    owner: 'design',
    name: 'artifacts',
    remoteUrl: 'git@git.acme.example:design/artifacts.git',
    transport: 'ssh',
  })
  assert.equal(repository('ssh://git@git.acme.example:2222/design/artifacts.git').host, 'git.acme.example:2222')
})

test('a file address names a local bare repository, with no Pages address of its own', () => {
  const local = repository('file:///Users/dev/sites/acme/artifacts.git')
  assert.equal(local.transport, 'file')
  assert.equal(local.name, 'artifacts')
  assert.equal(defaultGitHubPagesUrl(local), null)
})

test('an address with a sign-in in it is refused, so a token never lands in plain settings', () => {
  for (const input of [
    'https://x-access-token:ghp_secret@github.com/acme/artifacts',
    'https://dev@github.com/acme/artifacts',
  ]) {
    const parsed = parseArtifactsRepositoryUrl(input)
    assert.equal(parsed.ok, false, input)
    assert.ok(!parsed.ok && !parsed.message.includes('ghp_secret'))
  }
})

test('what is not a repository address is refused', () => {
  for (const input of [
    '',
    'acme',
    'https://github.com/acme',
    'ftp://github.com/acme/a',
    'acme/..',
    'https://github.com/acme/a?x=1',
  ]) {
    assert.equal(parseArtifactsRepositoryUrl(input).ok, false, input)
  }
})

test('the Pages address is worked out from the repository: github.com, a user site, and a company’s GitHub', () => {
  assert.equal(defaultGitHubPagesUrl(repository('Acme/artifacts')), 'https://acme.github.io/artifacts/')
  assert.equal(defaultGitHubPagesUrl(repository('acme/acme.github.io')), 'https://acme.github.io/')
  assert.equal(
    defaultGitHubPagesUrl(repository('https://git.acme.example:8443/design/artifacts')),
    'https://pages.git.acme.example/design/artifacts/',
  )
})

test('a site address is https (or http on this machine), ends in a slash, and carries no query or sign-in', () => {
  assert.equal(normalizeSiteUrl('https://acme.github.io/artifacts'), 'https://acme.github.io/artifacts/')
  assert.equal(normalizeSiteUrl('http://127.0.0.1:8000/artifacts/?x#y'), 'http://127.0.0.1:8000/artifacts/')
  assert.equal(normalizeSiteUrl('http://acme.example/artifacts/'), null)
  assert.equal(normalizeSiteUrl('https://dev:secret@acme.example/'), null)
  assert.equal(normalizeSiteUrl('not a url'), null)
})

test('what is on disk is read as the setting, anything malformed as empty', () => {
  const read = readArtifactsSettings({
    provider: 'cloudflare-pages',
    github: { repositoryUrl: 'https://x:secret@github.com/acme/a', siteUrl: 'ftp://nope' },
    cloudflare: {
      accountId: 'ABCDEF0123456789ABCDEF0123456789',
      accountName: 'Acme',
      projectName: 'Not Valid',
      repositoryUrl: 'acme/site',
      siteUrl: 'https://studio-artifacts.pages.dev',
    },
  })
  assert.deepEqual(read, {
    provider: 'cloudflare-pages',
    github: { repositoryUrl: '', siteUrl: '' },
    cloudflare: {
      accountId: 'abcdef0123456789abcdef0123456789',
      accountName: 'Acme',
      projectName: '',
      repositoryUrl: 'acme/site',
      siteUrl: 'https://studio-artifacts.pages.dev/',
    },
  })
  assert.deepEqual(readArtifactsSettings('garbage'), EMPTY_ARTIFACTS_SETTINGS)
  assert.deepEqual(readArtifactsSettings({ provider: 'carrier-pigeon' }).provider, null)
})

test('a host is ready once Studio has what it found: the repository, or the account', () => {
  assert.equal(isArtifactsHostReady(EMPTY_ARTIFACTS_SETTINGS), false)
  assert.equal(isArtifactsHostReady({ ...EMPTY_ARTIFACTS_SETTINGS, provider: 'github-pages' }), false)
  const github = {
    ...EMPTY_ARTIFACTS_SETTINGS,
    provider: 'github-pages' as const,
    github: { repositoryUrl: 'acme/a', siteUrl: 'https://acme.github.io/a/' },
  }
  assert.equal(isArtifactsHostReady(github), true)
  assert.equal(artifactsSiteUrl(github), 'https://acme.github.io/a/')
  const cloudflare = {
    ...EMPTY_ARTIFACTS_SETTINGS,
    provider: 'cloudflare-pages' as const,
    cloudflare: {
      ...EMPTY_ARTIFACTS_SETTINGS.cloudflare,
      accountId: 'a'.repeat(32),
      siteUrl: 'https://art.example.com/',
    },
  }
  assert.equal(isArtifactsHostReady(cloudflare), true)
  assert.equal(artifactsSiteUrl(cloudflare), 'https://art.example.com/')
  assert.equal(cloudflareProjectName(cloudflare.cloudflare), 'studio-artifacts')
})

test('the token page opens with Pages edit preselected', () => {
  const url = new URL(CLOUDFLARE_TOKEN_URL)
  assert.equal(url.host, 'dash.cloudflare.com')
  assert.deepEqual(JSON.parse(url.searchParams.get('permissionGroupKeys') ?? ''), [{ key: 'page', type: 'edit' }])
})
