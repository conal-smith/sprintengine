import assert from 'node:assert/strict'

import {
  canonicalRepositoryKey,
  parseRemoteFetchUrls,
  pickPrimaryRemote,
  repositoryIdentityFromRemote,
  sameRepository,
  stripRemoteCredentials,
} from './repository-identity'
import { test } from 'vitest'

test('the name keeps the casing the remote spells it in, and every spelling still shares one key', () => {
  for (const form of [
    'git@github.com:Acme/MyRepo.git',
    'https://github.com/Acme/MyRepo/',
    'ssh://git@github.com/Acme/MyRepo',
  ]) {
    const identity = repositoryIdentityFromRemote(form)
    assert.equal(identity?.name, 'MyRepo', form)
    assert.equal(identity?.canonicalKey, 'github.com/acme/myrepo', form)
  }
  assert.equal(repositoryIdentityFromRemote('https://me:ghp_secret@github.com/Acme/MyRepo.git')?.name, 'MyRepo')
  assert.equal(repositoryIdentityFromRemote('/srv/git/Repo.git')?.name, 'Repo')
})

test('a remote at a relative path never names the repository', () => {
  assert.equal(pickPrimaryRemote(new Map([['gb-local', '.']])), null)
  assert.equal(pickPrimaryRemote(new Map([['mirror', '../mirror']])), null)
  assert.equal(pickPrimaryRemote(new Map([['mirror', '.\\mirror']])), null)
  assert.deepEqual(
    pickPrimaryRemote(
      new Map([
        ['gb-local', '.'],
        ['origin', 'git@github.com:acme/app.git'],
      ]),
    ),
    { remoteName: 'origin', remoteUrl: 'git@github.com:acme/app.git' },
  )
  // An `origin` at a relative path gives way to a remote that names something.
  assert.deepEqual(
    pickPrimaryRemote(
      new Map([
        ['origin', './'],
        ['github', 'https://github.com/acme/app.git'],
      ]),
    ),
    { remoteName: 'github', remoteUrl: 'https://github.com/acme/app.git' },
  )
  // An absolute path still names one place: two clones of one bare repository.
  assert.deepEqual(pickPrimaryRemote(new Map([['origin', '/srv/git/app.git']])), {
    remoteName: 'origin',
    remoteUrl: '/srv/git/app.git',
  })
  // A dotted name is not a relative path.
  assert.deepEqual(pickPrimaryRemote(new Map([['origin', '.hidden-host:acme/app']])), {
    remoteName: 'origin',
    remoteUrl: '.hidden-host:acme/app',
  })
})

test("a partial clone's remote, whose fetch line ends with its filter, is read", () => {
  const remotes = parseRemoteFetchUrls(
    [
      'origin\thttps://github.com/acme/app (fetch) [blob:none]',
      'origin\thttps://github.com/acme/app (push)',
      'mirror\tgit@github.com:acme/app.git (fetch) [tree:0]',
      'mirror\tgit@github.com:acme/app.git (push)',
    ].join('\n'),
  )
  assert.deepEqual(
    [...remotes],
    [
      ['origin', 'https://github.com/acme/app'],
      ['mirror', 'git@github.com:acme/app.git'],
    ],
  )
  assert.deepEqual(pickPrimaryRemote(remotes), { remoteName: 'origin', remoteUrl: 'https://github.com/acme/app' })
})

test('repository-identity', async () => {
  // one-project-across-machines: every spelling of one remote is one
  // key, so a clone on this disk and a clone on a paired machine group as one
  // project. The shapes are the ones `git remote -v` actually prints.

  function main(): void {
    // Transport and spelling collapse to host/owner/name.
    const forms = [
      'git@github.com:Acme/SprintEngine.git',
      'https://github.com/acme/sprintengine/',
      'ssh://git@github.com/acme/sprintengine',
      'HTTPS://GitHub.com/Acme/SprintEngine.git',
      'git@github.com:acme/sprintengine',
    ]
    for (const form of forms) {
      assert.equal(canonicalRepositoryKey(form), 'github.com/acme/sprintengine', form)
    }
    assert.equal(
      canonicalRepositoryKey('ssh://git@gitlab.example.com:2222/team/sub/repo.git'),
      'gitlab.example.com/team/sub/repo',
    )
    // A path with no owner segment is not host/owner/name; it stays a stable string.
    assert.equal(canonicalRepositoryKey('https://example.com/repo.git'), 'https://example.com/repo')
    // A local path remote is still a key — two clones of one bare repo on disk.
    assert.equal(canonicalRepositoryKey('/srv/git/repo.git'), '/srv/git/repo')
    assert.equal(canonicalRepositoryKey('   '), '')

    const identity = repositoryIdentityFromRemote('git@github.com:Acme/SprintEngine.git')
    assert.deepEqual(identity, {
      canonicalKey: 'github.com/acme/sprintengine',
      remoteUrl: 'git@github.com:Acme/SprintEngine.git',
      name: 'SprintEngine',
    })
    assert.equal(repositoryIdentityFromRemote(''), null)
    // A token in the URL never leaves the reader; the key was never carrying it.
    const tokened = repositoryIdentityFromRemote('https://me:ghp_secret@github.com/acme/sprintengine.git')
    assert.equal(tokened?.remoteUrl, 'https://github.com/acme/sprintengine.git')
    assert.equal(tokened?.canonicalKey, 'github.com/acme/sprintengine')
    assert.equal(
      stripRemoteCredentials('git@github.com:acme/sprintengine.git'),
      'git@github.com:acme/sprintengine.git',
      'scp-style user is the ssh login, not a secret',
    )

    // `git remote -v` parsing: fetch URLs only, one per remote.
    const remotes = parseRemoteFetchUrls(
      [
        'origin\tgit@github.com:me/sprintengine.git (fetch)',
        'origin\tgit@github.com:me/sprintengine.git (push)',
        'upstream\thttps://github.com/acme/sprintengine.git (fetch)',
        'upstream\thttps://github.com/acme/sprintengine.git (push)',
        '',
      ].join('\n'),
    )
    assert.deepEqual([...remotes.keys()], ['origin', 'upstream'])
    // upstream beats origin: a fork's identity is the repository it forked.
    assert.deepEqual(pickPrimaryRemote(remotes), {
      remoteName: 'upstream',
      remoteUrl: 'https://github.com/acme/sprintengine.git',
    })
    assert.deepEqual(
      pickPrimaryRemote(
        new Map([
          ['zeta', 'z'],
          ['alpha', 'a'],
        ]),
      ),
      { remoteName: 'alpha', remoteUrl: 'a' },
      'otherwise alphabetical, so the answer is stable',
    )
    assert.equal(pickPrimaryRemote(new Map()), null)

    // Unknown never matches, and only equal keys do.
    assert.equal(sameRepository({ canonicalKey: 'a' }, { canonicalKey: 'a' }), true)
    assert.equal(sameRepository({ canonicalKey: 'a' }, { canonicalKey: 'b' }), false)
    assert.equal(sameRepository(null, { canonicalKey: 'a' }), false)
    assert.equal(sameRepository({ canonicalKey: '' }, { canonicalKey: '' }), false)

    console.log('repository-identity.test.ts: ok')
  }

  main()
})
