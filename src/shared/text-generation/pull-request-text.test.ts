import assert from 'node:assert/strict'

import { test } from 'vitest'

import {
  buildPullRequestTextPrompt,
  MAX_PULL_REQUEST_PATCH_CHARS,
  readPullRequestTextOutput,
  type PullRequestTextInput,
} from './pull-request-text'

const PLAIN: PullRequestTextInput = {
  base: 'main',
  head: 'feature/marks',
  commits: 'Show the marks',
  diffStat: ' a.ts | 1 +',
  patch: '+marks',
  template: null,
  conventionalCommits: false,
}

test('the prompt carries the convention, the template and the diff, each cut to size', () => {
  const prompt = buildPullRequestTextPrompt({
    base: 'main',
    head: 'feature/marks',
    commits: 'feat: marks',
    diffStat: ' a.ts | 1 +',
    patch: 'x'.repeat(MAX_PULL_REQUEST_PATCH_CHARS + 10),
    template: '### What changed and why',
    conventionalCommits: true,
  })
  assert.match(prompt, /"feature\/marks" into "main"/)
  assert.match(prompt, /Conventional Commits/)
  assert.match(prompt, /follows the repository template/)
  assert.match(prompt, /\[truncated\]/)
  const plain = buildPullRequestTextPrompt({
    base: 'main',
    head: 'x',
    commits: '',
    diffStat: '',
    patch: '',
    template: null,
    conventionalCommits: false,
  })
  assert.doesNotMatch(plain, /Template:/)
  assert.doesNotMatch(plain, /Conventional Commits/)
})

test('a draft is read from structured output or text, and a title is one bounded line', () => {
  assert.deepEqual(readPullRequestTextOutput({ title: '"Fix the marks."', body: ' Body \n' }), {
    title: 'Fix the marks',
    body: 'Body',
  })
  assert.deepEqual(readPullRequestTextOutput('```json\n{"title":"Fix it","body":"b"}\n```'), {
    title: 'Fix it',
    body: 'b',
  })
  assert.equal(readPullRequestTextOutput({ title: '', body: 'b' }), null)
  assert.equal(readPullRequestTextOutput('no json here'), null)
  assert.equal(readPullRequestTextOutput({ title: 'マークを表示する', body: '' })?.title, 'マークを表示する')
  assert.equal(readPullRequestTextOutput({ title: '1234 --- 56', body: '' }), null, 'no letters at all')
  assert.equal(readPullRequestTextOutput({ title: '修正', body: '' })?.title, '修正', 'two characters that are words')
  assert.equal(readPullRequestTextOutput({ title: 'ok', body: '' }), null, 'two Latin letters are not')
  assert.equal(readPullRequestTextOutput({ title: 'x'.repeat(500), body: '' })?.title.length, 120)
})

test('with no style given, the title matches the repository as it did before the setting', () => {
  assert.equal(
    buildPullRequestTextPrompt(PLAIN),
    buildPullRequestTextPrompt({ ...PLAIN, style: { mode: 'repository', instructions: '' } }),
  )
})

test('the conventional style asks for a Conventional Commits title even when the history keeps none', () => {
  const prompt = buildPullRequestTextPrompt({ ...PLAIN, style: { mode: 'conventional', instructions: '' } })
  assert.match(prompt, /The title must be a Conventional Commit/)
  assert.doesNotMatch(prompt, /in the style of the commit subjects/)
})

test("a custom style puts the person's guide after the rules and before the quoted material", () => {
  const prompt = buildPullRequestTextPrompt({
    ...PLAIN,
    conventionalCommits: true,
    style: { mode: 'custom', instructions: 'Name the area first, then a colon.' },
  })
  assert.match(prompt, /Write the title as the person's style guide below asks/)
  assert.doesNotMatch(prompt, /This repository uses Conventional Commits/, 'the guide decides, not the history')
  const rules = prompt.indexOf('Rules:')
  const guide = prompt.indexOf('Name the area first')
  const commits = prompt.indexOf('Commits:\n')
  assert.ok(rules < guide && guide < commits)
})
