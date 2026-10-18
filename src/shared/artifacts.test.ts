import assert from 'node:assert/strict'
import { test } from 'vitest'

import {
  artifactsSiteUrl,
  cloudflareSiteUrl,
  defaultGitHubPagesUrl,
  EMPTY_ARTIFACTS_SETTINGS,
  normalizeSiteUrl,
  parseArtifactsRepositoryUrl,
  validateArtifactsSettings,
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

test('choosing GitHub Pages needs the repository, and an address when none can be worked out', () => {
  const missing = validateArtifactsSettings({ provider: 'github-pages' })
  assert.deepEqual(missing.ok ? null : missing.field, 'github.repositoryUrl')
  const local = validateArtifactsSettings({
    provider: 'github-pages',
    github: { repositoryUrl: 'file:///Users/dev/acme/a.git' },
  })
  assert.deepEqual(local.ok ? null : local.field, 'github.pagesUrl')
  const ok = validateArtifactsSettings({ provider: 'github-pages', github: { repositoryUrl: ' acme/artifacts ' } })
  assert.ok(ok.ok)
  assert.equal(ok.ok && artifactsSiteUrl(ok.settings), 'https://acme.github.io/artifacts/')
})

test('an override wins over the worked-out Pages address', () => {
  const ok = validateArtifactsSettings({
    provider: 'github-pages',
    github: { repositoryUrl: 'acme/artifacts', pagesUrl: 'https://docs.acme.example/artifacts' },
  })
  assert.ok(ok.ok)
  assert.equal(ok.ok && artifactsSiteUrl(ok.settings), 'https://docs.acme.example/artifacts/')
})

test('choosing Cloudflare Pages needs the account and the project, each well formed', () => {
  const account = 'a'.repeat(32)
  assert.equal(validateArtifactsSettings({ provider: 'cloudflare-pages' }).ok, false)
  const badAccount = validateArtifactsSettings({
    provider: 'cloudflare-pages',
    cloudflare: { accountId: 'abc', projectName: 'art' },
  })
  assert.equal(badAccount.ok ? null : badAccount.field, 'cloudflare.accountId')
  const badProject = validateArtifactsSettings({
    provider: 'cloudflare-pages',
    cloudflare: { accountId: account, projectName: 'Art_1' },
  })
  assert.equal(badProject.ok ? null : badProject.field, 'cloudflare.projectName')
  const badDomain = validateArtifactsSettings({
    provider: 'cloudflare-pages',
    cloudflare: { accountId: account, projectName: 'art', customDomain: 'not a domain' },
  })
  assert.equal(badDomain.ok ? null : badDomain.field, 'cloudflare.customDomain')
  const ok = validateArtifactsSettings({
    provider: 'cloudflare-pages',
    cloudflare: {
      accountId: account.toUpperCase(),
      projectName: 'art',
      customDomain: 'https://Artifacts.Acme.example/',
    },
  })
  assert.ok(ok.ok)
  assert.equal(ok.ok && ok.settings.cloudflare.accountId, account)
  assert.equal(ok.ok && artifactsSiteUrl(ok.settings), 'https://artifacts.acme.example/')
  assert.equal(
    cloudflareSiteUrl({ accountId: account, projectName: 'art', customDomain: '', repositoryUrl: '' }),
    'https://art.pages.dev/',
  )
})

test('the other host’s fields are kept as typed, and do not block the chosen one', () => {
  const kept = validateArtifactsSettings({
    provider: 'github-pages',
    github: { repositoryUrl: 'acme/artifacts' },
    cloudflare: { accountId: 'not-an-id', projectName: 'Not Valid' },
  })
  assert.ok(kept.ok, kept.ok ? '' : kept.message)
  assert.equal(kept.ok && kept.settings.cloudflare.accountId, 'not-an-id')
  // Chosen, they are checked.
  const chosen = validateArtifactsSettings({ ...(kept.ok ? kept.settings : {}), provider: 'cloudflare-pages' })
  assert.equal(chosen.ok ? null : chosen.field, 'cloudflare.accountId')
})

test('a sign-in in either repository address is refused whichever host is chosen', () => {
  const hidden = validateArtifactsSettings({
    provider: 'github-pages',
    github: { repositoryUrl: 'acme/artifacts' },
    cloudflare: { repositoryUrl: 'https://dev:ghp_secret@github.com/acme/site' },
  })
  assert.equal(hidden.ok ? null : hidden.field, 'cloudflare.repositoryUrl')
  assert.ok(!hidden.ok && !hidden.message.includes('ghp_secret'))
})

test('no host is always accepted, and has no site', () => {
  const off = validateArtifactsSettings({ provider: null })
  assert.ok(off.ok)
  assert.deepEqual(off.ok && off.settings, EMPTY_ARTIFACTS_SETTINGS)
  assert.equal(artifactsSiteUrl(EMPTY_ARTIFACTS_SETTINGS), null)
  assert.equal(validateArtifactsSettings({ provider: 'carrier-pigeon' }).ok, false)
})
