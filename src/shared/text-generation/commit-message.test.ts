import assert from 'node:assert/strict'

import { test } from 'vitest'

import {
  MAX_COMMIT_BODY_LENGTH,
  MAX_COMMIT_PATCH_CHARS,
  MAX_COMMIT_SUBJECT_LENGTH,
  buildCommitMessagePrompt,
  commitMessageIsConventional,
  readCommitMessageOutput,
  type CommitMessageInput,
} from './commit-message'

const INPUT: CommitMessageInput = {
  branch: 'feature/marks',
  diffStat: ' src/sidebar.ts | 2 +-',
  patch: '-old\n+new',
  recentSubjects: ['Show the branch in the header', 'Keep the marks on a switch'],
  conventionalCommits: false,
  style: { mode: 'repository', instructions: '' },
}

const PLAIN = { conventional: false }
const CONVENTIONAL = { conventional: true }

// ── The prompt, one style at a time ──────────────────────────────────────────

test('matching a plain repository imitates its recent subjects', () => {
  const prompt = buildCommitMessagePrompt(INPUT)
  assert.match(prompt, /staged changes below, which are committed on the branch "feature\/marks"/)
  assert.match(prompt, /Return JSON with exactly two keys: subject and body\./)
  assert.match(prompt, /Write the subject in the style of the recent commit subjects below/)
  assert.doesNotMatch(prompt, /Conventional Commit/)
  assert.match(prompt, /Recent commit subjects:\nShow the branch in the header\nKeep the marks on a switch/)
  assert.match(prompt, /Files changed:\nsrc\/sidebar\.ts \| 2 \+-/)
  assert.match(prompt, /Diff:\n-old\n\+new/)
  assert.doesNotMatch(prompt, /STYLE GUIDE/)
})

test('matching a repository that keeps Conventional Commits asks for one', () => {
  const prompt = buildCommitMessagePrompt({ ...INPUT, conventionalCommits: true })
  assert.match(prompt, /This repository uses Conventional Commits: the subject must be one/)
})

test('the conventional style asks for one whatever the history keeps', () => {
  const prompt = buildCommitMessagePrompt({ ...INPUT, style: { mode: 'conventional', instructions: '' } })
  assert.match(prompt, /The subject must be a Conventional Commit/)
  assert.doesNotMatch(prompt, /in the style of the recent commit subjects/)
})

test("the custom style hands over the person's guide, fenced, after the rules", () => {
  const prompt = buildCommitMessagePrompt({
    ...INPUT,
    conventionalCommits: true,
    style: { mode: 'custom', instructions: 'Past tense, and name the area first.' },
  })
  assert.match(prompt, /Write the subject as the person's style guide below asks\./)
  assert.doesNotMatch(prompt, /This repository uses Conventional Commits/)
  const rules = prompt.indexOf('Rules:')
  const open = prompt.indexOf('----- STYLE GUIDE -----')
  const guide = prompt.indexOf('Past tense, and name the area first.')
  const close = prompt.indexOf('----- END OF STYLE GUIDE -----')
  const quoted = prompt.indexOf('Recent commit subjects:')
  assert.ok(rules < open && open < guide && guide < close && close < quoted)
})

test('a custom style with nothing written matches the repository', () => {
  const input = { ...INPUT, style: { mode: 'custom' as const, instructions: '  ' } }
  assert.equal(buildCommitMessagePrompt(input), buildCommitMessagePrompt(INPUT))
  assert.equal(commitMessageIsConventional({ ...input, conventionalCommits: true }), true)
})

test('every input is cut to size, and missing ones say so', () => {
  const prompt = buildCommitMessagePrompt({
    ...INPUT,
    branch: null,
    patch: 'x'.repeat(MAX_COMMIT_PATCH_CHARS + 10),
    recentSubjects: [],
  })
  assert.match(prompt, /^Write the commit message for the staged changes below\.\n/)
  assert.match(prompt, /Recent commit subjects:\n\(none\)/)
  assert.match(prompt, /\[truncated\]/)
  assert.match(
    buildCommitMessagePrompt({ ...INPUT, patch: '' }),
    /Diff:\n\(not available: work from the files changed\)/,
  )
})

// ── Reading the answer ───────────────────────────────────────────────────────

test('structured output becomes a subject, a blank line and the body', () => {
  assert.deepEqual(
    readCommitMessageOutput({ subject: 'Keep the marks', body: 'They vanished on a switch.\n' }, PLAIN),
    {
      subject: 'Keep the marks',
      body: 'They vanished on a switch.',
      message: 'Keep the marks\n\nThey vanished on a switch.',
    },
  )
})

test('an empty body leaves the subject alone as the message', () => {
  assert.deepEqual(readCommitMessageOutput({ subject: 'Keep the marks', body: '  ' }, PLAIN), {
    subject: 'Keep the marks',
    body: '',
    message: 'Keep the marks',
  })
})

test('fenced JSON in text is read', () => {
  assert.equal(
    readCommitMessageOutput('Here you go:\n```json\n{"subject":"fix: keep the marks","body":""}\n```', CONVENTIONAL)
      ?.message,
    'fix: keep the marks',
  )
})

test('a fenced subject and a fenced body are unwrapped', () => {
  assert.deepEqual(
    readCommitMessageOutput({ subject: '```\nKeep the marks\n```', body: '```text\nWhy.\n```' }, PLAIN),
    {
      subject: 'Keep the marks',
      body: 'Why.',
      message: 'Keep the marks\n\nWhy.',
    },
  )
})

test('quotes around the subject are dropped', () => {
  assert.equal(readCommitMessageOutput({ subject: '"Keep the marks"', body: '' }, PLAIN)?.subject, 'Keep the marks')
  assert.equal(readCommitMessageOutput({ subject: '`Keep the marks`', body: '' }, PLAIN)?.subject, 'Keep the marks')
  assert.equal(readCommitMessageOutput({ subject: '“Keep the marks”', body: '' }, PLAIN)?.subject, 'Keep the marks')
})

test('a subject spread over lines keeps its first, and the rest becomes the empty body', () => {
  assert.deepEqual(readCommitMessageOutput({ subject: '\nKeep the marks\n\nThey vanished.', body: '' }, PLAIN), {
    subject: 'Keep the marks',
    body: 'They vanished.',
    message: 'Keep the marks\n\nThey vanished.',
  })
  assert.equal(
    readCommitMessageOutput({ subject: 'Keep the marks\nstray', body: 'The real body.' }, PLAIN)?.body,
    'The real body.',
    'a body the model wrote wins over the spill',
  )
})

test('a subject past the hard cap is cut at a word', () => {
  const long = `Keep ${'the marks '.repeat(20)}visible`
  const subject = readCommitMessageOutput({ subject: long, body: '' }, PLAIN)?.subject ?? ''
  assert.ok(subject.length <= MAX_COMMIT_SUBJECT_LENGTH, `${subject.length} characters`)
  const words = new Set(['Keep', 'the', 'marks'])
  assert.ok(
    subject.split(' ').every((word) => words.has(word)),
    'cut between words, not inside one',
  )
})

test('a trailing full stop is dropped', () => {
  assert.equal(readCommitMessageOutput({ subject: 'Keep the marks.', body: '' }, PLAIN)?.subject, 'Keep the marks')
  assert.equal(
    readCommitMessageOutput({ subject: 'fix: keep the marks. ', body: '' }, CONVENTIONAL)?.subject,
    'fix: keep the marks',
  )
})

test('a subject that is not a Conventional Commit is refused when one is required', () => {
  assert.equal(readCommitMessageOutput({ subject: 'Keep the marks', body: '' }, CONVENTIONAL), null)
  assert.equal(readCommitMessageOutput({ subject: 'feature: keep the marks', body: '' }, CONVENTIONAL), null)
  assert.equal(
    readCommitMessageOutput({ subject: 'Keep the marks', body: '' }, PLAIN)?.subject,
    'Keep the marks',
    'and kept when none is',
  )
})

test("a recognised type's spelling is repaired, never guessed", () => {
  assert.equal(
    readCommitMessageOutput({ subject: 'Fix(sidebar):keep the marks', body: '' }, CONVENTIONAL)?.subject,
    'fix(sidebar): keep the marks',
  )
  assert.equal(
    readCommitMessageOutput({ subject: 'FEAT!: drop the old format', body: '' }, CONVENTIONAL)?.subject,
    'feat!: drop the old format',
  )
  assert.equal(
    readCommitMessageOutput({ subject: 'Fix: keep the marks', body: '' }, PLAIN)?.subject,
    'Fix: keep the marks',
    'a repository that keeps no convention gets its subject as written',
  )
})

test('an empty or missing answer is no message', () => {
  assert.equal(readCommitMessageOutput({ subject: '', body: 'Body' }, PLAIN), null)
  assert.equal(readCommitMessageOutput({ subject: '  \n ', body: '' }, PLAIN), null)
  assert.equal(readCommitMessageOutput({ body: 'Body' }, PLAIN), null)
  assert.equal(readCommitMessageOutput('', PLAIN), null)
  assert.equal(readCommitMessageOutput('no json here', PLAIN), null)
  assert.equal(readCommitMessageOutput(['Keep the marks'], PLAIN), null)
  assert.equal(readCommitMessageOutput({ subject: '1234 --- 56', body: '' }, PLAIN), null, 'no letters at all')
})

test('trailers, and a body that repeats the subject, are dropped', () => {
  assert.equal(
    readCommitMessageOutput(
      {
        subject: 'Keep the marks',
        body: 'Keep the marks.\n\nThey vanished.\n\nCo-Authored-By: Someone <dev@example.com>',
      },
      PLAIN,
    )?.body,
    'They vanished.',
  )
})

// A lone surrogate, which git would store as U+FFFD. With the `u` flag a whole
// pair is one code point, so only half of one matches.
const splitsAPair = (text: string) => /[\uD800-\uDFFF]/u.test(text)

test('a subject cut at the length limit never ends in half an emoji', () => {
  const subject = 'fix: ' + 'a'.repeat(MAX_COMMIT_SUBJECT_LENGTH - 6) + '🚀 more'
  const read = readCommitMessageOutput({ subject, body: '' }, { conventional: true })
  assert.ok(read)
  assert.equal(splitsAPair(read.subject), false)
  assert.ok(read.subject.length <= MAX_COMMIT_SUBJECT_LENGTH)
})

test('a body cut at the length limit never ends in half an emoji', () => {
  const body = 'x'.repeat(MAX_COMMIT_BODY_LENGTH - 1) + '🚀🚀'
  const read = readCommitMessageOutput({ subject: 'fix: a thing', body }, { conventional: true })
  assert.ok(read)
  assert.equal(splitsAPair(read.body), false)
  assert.equal(read.body, 'x'.repeat(MAX_COMMIT_BODY_LENGTH - 1))
})
