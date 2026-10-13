import assert from 'node:assert/strict'

import type { BinaryVersionProbe } from '../cli-runtime-install'
import {
  parseGhAuthLogin,
  parseGlabAuthLogin,
  parseTeaLogin,
  probeVersionControlProviders,
  type VersionControlProbeDeps,
} from './version-control-probe'
import { test } from 'vitest'

test('version-control-probe', async () => {
  // Version strings here are synthetic fixtures for the mapping under test; the
  // product never carries a version literal — real ones come from probeBinaryVersion.
  const GIT_VERSION_FIXTURE = 'git version 0.0.0-fixture'
  const GH_VERSION_FIXTURE = 'gh version 0.0.0-fixture'

  function deps(input: {
    probes: Record<string, BinaryVersionProbe>
    login?: string | null
    onLoginRead?: () => void
  }): VersionControlProbeDeps {
    return {
      // The forge CLIs a case does not name are not installed.
      probeVersion: async (binary) => input.probes[binary] ?? { outcome: 'not_installed' },
      readGhLogin: async () => {
        input.onLoginRead?.()
        return input.login ?? null
      },
      readForgeLogin: async () => assert.fail('no forge CLI is installed in these cases'),
    }
  }

  const FORGE_CLIS_MISSING = [
    { id: 'glab', resolved: false, reason: 'not_installed' },
    { id: 'tea', resolved: false, reason: 'not_installed' },
  ]

  async function main(): Promise<void> {
    // Resolved with auth: gh carries the login its own auth resolves to.
    const withAuth = await probeVersionControlProviders(
      deps({
        probes: {
          git: { outcome: 'resolved', version: GIT_VERSION_FIXTURE, resolvedPath: '/usr/bin/git' },
          gh: { outcome: 'resolved', version: GH_VERSION_FIXTURE, resolvedPath: '/opt/homebrew/bin/gh' },
        },
        login: 'octocat',
      }),
    )
    assert.deepEqual(withAuth, [
      { id: 'git', resolved: true, version: GIT_VERSION_FIXTURE },
      { id: 'gh', resolved: true, version: GH_VERSION_FIXTURE, auth: { login: 'octocat' } },
      ...FORGE_CLIS_MISSING,
    ])
    // Exactly the providers the product integrates — no row for anything else.
    assert.deepEqual(
      withAuth.map((provider) => provider.id),
      ['git', 'gh', 'glab', 'tea'],
    )

    // Resolved without auth: an installed but unauthenticated gh omits `auth`
    // rather than carrying an empty login.
    let loginReads = 0
    const withoutAuth = await probeVersionControlProviders(
      deps({
        probes: {
          git: { outcome: 'resolved', version: GIT_VERSION_FIXTURE, resolvedPath: '/usr/bin/git' },
          gh: { outcome: 'resolved', version: GH_VERSION_FIXTURE, resolvedPath: '/opt/homebrew/bin/gh' },
        },
        login: null,
        onLoginRead: () => {
          loginReads += 1
        },
      }),
    )
    assert.deepEqual(withoutAuth, [
      { id: 'git', resolved: true, version: GIT_VERSION_FIXTURE },
      { id: 'gh', resolved: true, version: GH_VERSION_FIXTURE },
      ...FORGE_CLIS_MISSING,
    ])
    assert.equal(loginReads, 1, 'auth is read only for the provider that has auth')

    // Not installed: a definitive verdict, per provider, with no version field.
    const notInstalled = await probeVersionControlProviders(
      deps({
        probes: {
          git: { outcome: 'resolved', version: GIT_VERSION_FIXTURE, resolvedPath: '/usr/bin/git' },
          gh: { outcome: 'not_installed' },
        },
      }),
    )
    assert.deepEqual(notInstalled, [
      { id: 'git', resolved: true, version: GIT_VERSION_FIXTURE },
      { id: 'gh', resolved: false, reason: 'not_installed' },
      ...FORGE_CLIS_MISSING,
    ])

    // Probe failed: a probe that could not answer never reads as installed and
    // never reads as missing.
    const probeFailed = await probeVersionControlProviders(
      deps({ probes: { git: { outcome: 'probe_failed' }, gh: { outcome: 'probe_failed' } }, login: 'octocat' }),
    )
    assert.deepEqual(probeFailed, [
      { id: 'git', resolved: false, reason: 'probe_failed' },
      { id: 'gh', resolved: false, reason: 'probe_failed' },
      ...FORGE_CLIS_MISSING,
    ])

    // gh auth login parsing: both report wordings gh has shipped, indented and
    // with the status glyph, and the failure text carries no login.
    assert.equal(
      parseGhAuthLogin('github.com\n  ✓ Logged in to github.com account octocat (keyring)\n  - Active account: true\n'),
      'octocat',
    )
    assert.equal(parseGhAuthLogin('  ✓ Logged in to github.com as octocat (oauth_token)\n'), 'octocat')
    assert.equal(parseGhAuthLogin('  ✓ Logged in to ghe.example.com account octo-corp (keyring)\n'), 'octo-corp')
    assert.equal(parseGhAuthLogin('You are not logged into any GitHub hosts. To log in, run: gh auth login\n'), null)
    assert.equal(parseGhAuthLogin(''), null)

    console.log('version-control-probe: all assertions passed')
  }

  const suiteRun = main().catch((error) => {
    console.error(error)
    process.exit(1)
  })

  await suiteRun
})

test('each WSL machine gets its own git row, after this machine and the forge', async () => {
  const probes = await probeVersionControlProviders({
    probeVersion: async (binary) =>
      binary === 'git'
        ? { outcome: 'resolved', version: 'git version 0.0.0-win', resolvedPath: 'C:/Program Files/Git/cmd/git.exe' }
        : { outcome: 'not_installed' },
    readGhLogin: async () => null,
    readForgeLogin: async () => null,
    listGitMachines: async () => [
      {
        hostId: 'wsl:Ubuntu',
        label: 'WSL: Ubuntu',
        probeGit: async () => ({ outcome: 'resolved', version: 'git version 0.0.0-linux', resolvedPath: null }),
      },
      { hostId: 'wsl:Debian', label: 'WSL: Debian', probeGit: async () => ({ outcome: 'not_installed' }) },
      {
        hostId: 'wsl:Broken',
        label: 'WSL: Broken',
        probeGit: async () => {
          throw new Error('wsl.exe exited')
        },
      },
    ],
  })
  assert.deepEqual(probes, [
    { id: 'git', resolved: true, version: 'git version 0.0.0-win' },
    { id: 'gh', resolved: false, reason: 'not_installed' },
    { id: 'glab', resolved: false, reason: 'not_installed' },
    { id: 'tea', resolved: false, reason: 'not_installed' },
    {
      id: 'git',
      resolved: true,
      version: 'git version 0.0.0-linux',
      machine: { hostId: 'wsl:Ubuntu', label: 'WSL: Ubuntu' },
    },
    { id: 'git', resolved: false, reason: 'not_installed', machine: { hostId: 'wsl:Debian', label: 'WSL: Debian' } },
    { id: 'git', resolved: false, reason: 'probe_failed', machine: { hostId: 'wsl:Broken', label: 'WSL: Broken' } },
  ])
})

test('glab and tea rows carry the account their own auth names, and none when it names none', async () => {
  const asked: string[] = []
  const probes = await probeVersionControlProviders({
    probeVersion: async (binary) => ({
      outcome: 'resolved',
      version: `${binary} version 0.0.0-fixture`,
      resolvedPath: null,
    }),
    readGhLogin: async () => null,
    readForgeLogin: async (binary) => {
      asked.push(binary)
      return binary === 'glab' ? 'dev' : null
    },
  })
  assert.deepEqual(probes.slice(2), [
    { id: 'glab', resolved: true, version: 'glab version 0.0.0-fixture', auth: { login: 'dev' } },
    { id: 'tea', resolved: true, version: 'tea version 0.0.0-fixture' },
  ])
  assert.deepEqual(asked, ['glab', 'tea'])
})

test('glab’s auth status is read as gh’s older wording, whatever host fails beside it', () => {
  assert.equal(
    parseGlabAuthLogin(
      'gitlab.com\n  ✓ Logged in to gitlab.com as dev (/Users/dev/.config/glab-cli/config.yml)\n  ✓ Token found: **************************\ngitlab.example.com\n  x gitlab.example.com: api call failed\n',
    ),
    'dev',
  )
  assert.equal(parseGlabAuthLogin('x No GitLab instances have been authenticated with glab.\n'), null)
})

test('tea’s logins name the default one’s user, else the first one’s, and carry no token', () => {
  const listed = JSON.stringify([
    {
      name: 'work',
      url: 'https://gitea.example.com',
      ssh_host: 'gitea.example.com',
      user: 'dev-work',
      default: 'false',
    },
    { name: 'codeberg', url: 'https://codeberg.org', ssh_host: 'codeberg.org', user: 'dev', default: 'true' },
  ])
  assert.equal(parseTeaLogin(listed), 'dev')
  assert.equal(parseTeaLogin(JSON.stringify([{ name: 'one', url: 'https://gitea.lan', user: 'acme' }])), 'acme')
  assert.equal(parseTeaLogin('[]'), null)
  assert.equal(parseTeaLogin('No logins configured'), null)
})
