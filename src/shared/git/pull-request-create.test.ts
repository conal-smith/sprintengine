import assert from 'node:assert/strict'

import { test } from 'vitest'

import {
  createPullRequestReadiness,
  forgeOfRemote,
  newPullRequestPageUrl,
  maxPageUrlChars,
  prefilledPullRequestPage,
  pullRequestListPageUrl,
  pullRequestNoun,
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

test('a forge page carries the confirmed title and description where the forge reads them', () => {
  const text = { title: 'feat: marks & "more"', body: 'Line one\nLine two' }
  assert.deepEqual(
    prefilledPullRequestPage(forgeOfRemote('git@gitlab.com:acme/app.git')!, 'main', 'feature/marks', text, 'darwin'),
    {
      url: 'https://gitlab.com/acme/app/-/merge_requests/new?merge_request%5Bsource_branch%5D=feature%2Fmarks&merge_request%5Btarget_branch%5D=main&merge_request%5Btitle%5D=feat%3A%20marks%20%26%20%22more%22&merge_request%5Bdescription%5D=Line%20one%0ALine%20two',
      descriptionFilled: true,
    },
  )
  // Gitea reads `title` and `body`; Forgejo ignores them, and a host does not
  // say which it runs, so the description is not counted as delivered.
  assert.deepEqual(
    prefilledPullRequestPage(
      forgeOfRemote('https://codeberg.org/acme/app.git')!,
      'main',
      'feature/marks',
      text,
      'darwin',
    ),
    {
      url: 'https://codeberg.org/acme/app/compare/main...feature%2Fmarks?title=feat%3A%20marks%20%26%20%22more%22&body=Line%20one%0ALine%20two',
      descriptionFilled: false,
    },
  )
  assert.deepEqual(
    prefilledPullRequestPage(forgeOfRemote('git@bitbucket.org:acme/app.git')!, 'main', 'feature/marks', text, 'darwin'),
    {
      url: 'https://bitbucket.org/acme/app/pull-requests/new?source=feature%2Fmarks&dest=main',
      descriptionFilled: false,
    },
  )
  assert.equal(
    prefilledPullRequestPage(
      forgeOfRemote('git@gitlab.com:acme/app.git')!,
      'main',
      'feature/marks',
      {
        title: 'x',
        body: '',
      },
      'darwin',
    )?.descriptionFilled,
    true,
    'an empty description has nothing to lose',
  )
  assert.equal(
    prefilledPullRequestPage(forgeOfRemote('git@github.com:acme/app.git')!, 'main', 'feature/marks', text, 'darwin'),
    null,
  )
})

test('a description too long for an address is left out of it, and the title still goes', () => {
  const page = prefilledPullRequestPage(
    forgeOfRemote('git@gitlab.com:acme/app.git')!,
    'main',
    'feature/marks',
    { title: 'feat: marks', body: 'x'.repeat(20_000) },
    'darwin',
  )
  assert.equal(page?.descriptionFilled, false)
  assert.ok(page?.url.endsWith('&merge_request%5Btitle%5D=feat%3A%20marks'))
})

test('on Windows the page address stays short enough for the shell to open it', () => {
  // About 3,000 characters encoded: within the cap elsewhere, past what
  // Windows hands to a browser.
  const text = { title: 'feat: marks', body: 'word '.repeat(500) }
  const remote = forgeOfRemote('git@gitlab.com:acme/app.git')!
  const mac = prefilledPullRequestPage(remote, 'main', 'feature/marks', text, 'darwin')
  assert.equal(mac?.descriptionFilled, true)
  assert.ok(mac!.url.length > 2_048)
  const windows = prefilledPullRequestPage(remote, 'main', 'feature/marks', text, 'win32')
  assert.equal(windows?.descriptionFilled, false, 'the description is kept for the person to paste')
  assert.ok(windows!.url.length <= maxPageUrlChars('win32'))
  assert.ok(windows!.url.endsWith('&merge_request%5Btitle%5D=feat%3A%20marks'))
  assert.ok(maxPageUrlChars('win32') < 2_048)
  assert.equal(maxPageUrlChars('linux'), maxPageUrlChars('darwin'))
})

test('the list of requests to find one in is the forge’s own list page', () => {
  assert.equal(
    pullRequestListPageUrl(forgeOfRemote('git@gitlab.com:acme/app.git')!),
    'https://gitlab.com/acme/app/-/merge_requests',
  )
  assert.equal(
    pullRequestListPageUrl(forgeOfRemote('https://codeberg.org/acme/app.git')!),
    'https://codeberg.org/acme/app/pulls',
  )
  assert.equal(pullRequestListPageUrl(forgeOfRemote('git@github.com:acme/app.git')!), null)
})

test('GitLab says merge request; every other forge says pull request', () => {
  assert.equal(pullRequestNoun('gitlab'), 'merge request')
  assert.equal(pullRequestNoun('gitea'), 'pull request')
  assert.equal(pullRequestNoun('github'), 'pull request')
  assert.equal(pullRequestNoun(null), 'pull request')
})
