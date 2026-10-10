import assert from 'node:assert/strict'

import { test } from 'vitest'

import {
  createPullRequestReadiness,
  forgeOfRemote,
  newPullRequestPageUrl,
  type CreatePullRequestFacts,
} from './pull-request-create'

const READY: CreatePullRequestFacts = {
  branch: 'feature/marks',
  defaultBranch: 'main',
  unmergedCommits: 2,
  openPullRequest: false,
  forge: 'github',
}

test('Create PR shows for committed, unproposed work on a branch of its own, whatever is uncommitted', () => {
  assert.deepEqual(createPullRequestReadiness(READY), { ready: true })
  const reason = (facts: Partial<CreatePullRequestFacts>) => {
    const readiness = createPullRequestReadiness({ ...READY, ...facts })
    return readiness.ready ? 'ready' : readiness.reason
  }
  assert.equal(reason({ branch: null }), 'detached')
  assert.equal(reason({ branch: 'main' }), 'default-branch')
  assert.equal(reason({ defaultBranch: null }), 'default-branch', 'an unknown default is never guessed')
  assert.equal(reason({ unmergedCommits: 0 }), 'nothing-to-propose', 'a merged pull request carried every commit')
  assert.equal(reason({ unmergedCommits: null }), 'nothing-to-propose')
  assert.equal(reason({ openPullRequest: true }), 'open-pull-request', 'whoever opened it')
  assert.equal(reason({ openPullRequest: null }), 'ready', 'a lookup that could not be made does not hide it')
  assert.equal(reason({ forge: null }), 'no-remote')
  assert.equal(reason({ forge: 'azure-devops' }), 'unsupported-forge')
  assert.equal(reason({ forge: 'gitlab', openPullRequest: null }), 'ready')
})

test('a remote names its forge by host, and the forges the app does not drive open their own page', () => {
  assert.deepEqual(forgeOfRemote('git@github.com:acme/app.git'), {
    forge: 'github',
    webUrl: 'https://github.com/acme/app',
  })
  assert.deepEqual(forgeOfRemote('https://dev@ghe.example.com/acme/app'), {
    forge: 'github',
    webUrl: 'https://ghe.example.com/acme/app',
  })
  assert.deepEqual(forgeOfRemote('ssh://git@gitlab.example.com:2222/acme/platform/app.git'), {
    forge: 'gitlab',
    webUrl: 'https://gitlab.example.com/acme/platform/app',
  })
  assert.equal(
    forgeOfRemote('https://gitlab.example.com:8443/acme/app.git')?.webUrl,
    'https://gitlab.example.com:8443/acme/app',
    'a web remote keeps its port',
  )
  assert.equal(
    forgeOfRemote('http://gitea.lan:3000/acme/app.git')?.webUrl,
    'http://gitea.lan:3000/acme/app',
    'and its scheme: a forge cloned over plain http serves its pages there',
  )
  assert.equal(forgeOfRemote('ssh://git@gitea.lan:2222/acme/app.git')?.webUrl, 'https://gitea.lan/acme/app')
  assert.equal(forgeOfRemote('https://codeberg.org/acme/app.git')?.forge, 'gitea')
  assert.equal(forgeOfRemote('git@forgejo.example.com:acme/app.git')?.forge, 'gitea')
  assert.equal(forgeOfRemote('git@bitbucket.org:acme/app.git')?.forge, 'bitbucket')
  assert.equal(forgeOfRemote('https://dev.azure.com/acme/platform/_git/app')?.forge, 'azure-devops')
  assert.equal(forgeOfRemote('/Users/dev/remotes/app.git'), null, 'a path is no forge')
  assert.equal(forgeOfRemote('C:/remotes/acme/app.git'), null, 'nor is a Windows one')
  assert.equal(forgeOfRemote('D:\\remotes\\acme\\app.git'), null)
  assert.equal(forgeOfRemote(''), null)

  const head = 'feature/marks'
  assert.equal(
    newPullRequestPageUrl(forgeOfRemote('git@gitlab.com:acme/app.git')!, 'main', head),
    'https://gitlab.com/acme/app/-/merge_requests/new?merge_request%5Bsource_branch%5D=feature%2Fmarks&merge_request%5Btarget_branch%5D=main',
  )
  assert.equal(
    newPullRequestPageUrl(forgeOfRemote('https://codeberg.org/acme/app.git')!, 'main', head),
    'https://codeberg.org/acme/app/compare/main...feature%2Fmarks',
  )
  assert.equal(
    newPullRequestPageUrl(forgeOfRemote('git@bitbucket.org:acme/app.git')!, 'main', head),
    'https://bitbucket.org/acme/app/pull-requests/new?source=feature%2Fmarks&dest=main',
  )
  assert.equal(newPullRequestPageUrl(forgeOfRemote('git@github.com:acme/app.git')!, 'main', head), null)
})
