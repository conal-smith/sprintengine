import assert from 'node:assert/strict'
import { test } from 'vitest'

import {
  cloneParentFor,
  describeCloneProgress,
  draftNamesRepo,
  filterGitHubRepos,
  resolveCloneSource,
} from './githubClone'
import type { GitHubRepoSummary } from '../../../../../shared/electron-api'

const repo: GitHubRepoSummary = {
  fullName: 'octocat/weather-api',
  name: 'weather-api',
  owner: 'octocat',
  isPrivate: true,
  description: 'Standalone service',
  cloneUrl: 'https://github.com/octocat/weather-api.git',
  defaultBranch: 'main',
  pushedAt: '2026-08-30T00:00:00Z',
}

test('a blank draft is nothing chosen yet, not an error', () => {
  const blank = resolveCloneSource('   ')
  assert.equal(blank.source, null)
  assert.equal(blank.error, null)
})

test('a pasted URL resolves to what the preview shows', () => {
  const pasted = resolveCloneSource('https://gitlab.acme.dev/platform/api/-/tree/develop')
  assert.equal(pasted.source?.repoName, 'api')
  assert.equal(pasted.source?.providerName, 'GitLab')
  assert.equal(pasted.source?.location, 'gitlab.acme.dev/platform/api')
  assert.equal(pasted.source?.branch, 'develop')
})

test('a draft that does not parse carries its error inline', () => {
  const invalid = resolveCloneSource('ftp://nope')
  assert.equal(invalid.source, null)
  assert.ok(invalid.error)
})

test('a listed repository is picked however the draft spells it', () => {
  assert.equal(draftNamesRepo(repo.cloneUrl, repo), true)
  assert.equal(draftNamesRepo('octocat/weather-api', repo), true, 'shorthand')
  assert.equal(draftNamesRepo('https://github.com/OctoCat/Weather-API/tree/main', repo), true, 'a page, any case')
  assert.equal(draftNamesRepo('octocat/other', repo), false)
  assert.equal(draftNamesRepo('', repo), false)
})

test('the repository filter matches full name and description, case-insensitively', () => {
  const repos = [repo, { ...repo, fullName: 'octocat/sprintengine', name: 'sprintengine', description: 'Desktop app' }]
  assert.equal(filterGitHubRepos(repos, '').length, 2)
  assert.equal(filterGitHubRepos(repos, 'WEATHER').length, 1)
  assert.equal(filterGitHubRepos(repos, 'desktop app').length, 1)
  assert.equal(filterGitHubRepos(repos, 'zzz').length, 0)
})

test('progress reads as one line of words', () => {
  assert.equal(describeCloneProgress(null), 'Starting…')
  assert.equal(describeCloneProgress({ stage: 'connecting', percent: null, detail: null }), 'Connecting')
  assert.equal(
    describeCloneProgress({ stage: 'receiving', percent: 45, detail: '12.30 MiB | 5.00 MiB/s' }),
    'Receiving objects · 45% · 12.30 MiB | 5.00 MiB/s',
  )
})

test('picking a folder already named for the clone clones into it, not into a folder inside it', () => {
  assert.equal(cloneParentFor('/Users/dev/code', 'widget'), '/Users/dev/code')
  assert.equal(cloneParentFor('/Users/dev/code/widget', 'widget'), '/Users/dev/code')
})
