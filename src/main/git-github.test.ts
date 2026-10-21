import assert from 'node:assert/strict'

import { test } from 'vitest'

import { githubRepoFromRemote } from './git-github'

const APP = { owner: 'acme', repo: 'app', webUrl: 'https://github.com/acme/app' }

test('the usual remote spellings name the repository', () => {
  assert.deepEqual(githubRepoFromRemote('git@github.com:acme/app.git'), APP)
  assert.deepEqual(githubRepoFromRemote('ssh://git@github.com/acme/app.git'), APP)
  assert.deepEqual(githubRepoFromRemote('https://github.com/acme/app.git'), APP)
  assert.deepEqual(githubRepoFromRemote('https://github.com/acme/app\n'), APP)
})

test('a remote whose SSH user is not git, or whose URL carries a user, still names it', () => {
  // SSH certificate auth hands each organisation its own user.
  assert.deepEqual(githubRepoFromRemote('org-123@github.com:acme/app.git'), APP)
  assert.deepEqual(githubRepoFromRemote('ssh://org-123@github.com/acme/app'), APP)
  assert.deepEqual(githubRepoFromRemote('https://dev@github.com/acme/app.git'), APP)
  assert.deepEqual(githubRepoFromRemote('https://github.com/acme/app/'), APP)
})

test('anything that is not a GitHub repository is no repository', () => {
  assert.equal(githubRepoFromRemote(''), null)
  assert.equal(githubRepoFromRemote('git@gitlab.com:acme/app.git'), null)
  assert.equal(githubRepoFromRemote('https://github.com/acme'), null)
  assert.equal(githubRepoFromRemote('https://github.com.evil.example/acme/app'), null)
})
