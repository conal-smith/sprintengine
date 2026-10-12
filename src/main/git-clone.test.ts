import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, test } from 'vitest'

import { cloneRepository, describeCloneFailure, parseCloneProgressLine, sameRepository } from './git-clone'
import { validateCloneUrl } from '../shared/git-clone-url'

const scratches: string[] = []
function scratch(): string {
  const dir = mkdtempSync(join(tmpdir(), 'git-clone-test-'))
  scratches.push(dir)
  return dir
}
afterEach(() => {
  for (const dir of scratches.splice(0)) rmSync(dir, { recursive: true, force: true })
})

function source(raw: string) {
  const parsed = validateCloneUrl(raw)
  assert.ok(parsed.ok)
  return parsed
}

test('progress lines become a stage, a percent and git’s transfer detail', () => {
  assert.deepEqual(parseCloneProgressLine('remote: Counting objects:  45% (450/1000)'), {
    stage: 'counting',
    percent: 45,
    detail: null,
  })
  assert.deepEqual(parseCloneProgressLine('Receiving objects:  12% (1200/10000), 12.30 MiB | 5.00 MiB/s'), {
    stage: 'receiving',
    percent: 12,
    detail: '12.30 MiB | 5.00 MiB/s',
  })
  assert.deepEqual(
    parseCloneProgressLine('Receiving objects: 100% (10000/10000), 98.10 MiB | 7.20 MiB/s, done.'),
    { stage: 'receiving', percent: 100, detail: '98.10 MiB | 7.20 MiB/s' },
    'the trailing done is not part of the detail',
  )
  assert.equal(parseCloneProgressLine('Resolving deltas:  50% (5/10)')?.stage, 'resolving')
  assert.equal(parseCloneProgressLine('Updating files:  80% (8/10)')?.stage, 'checkout')
  assert.equal(parseCloneProgressLine("Cloning into 'widget'..."), null)
  assert.equal(parseCloneProgressLine('fatal: repository not found'), null)
})

test('a failure says what to do about it, on the host it happened on', () => {
  const github = source('https://github.com/acme/widget')
  assert.match(
    describeCloneFailure("fatal: could not read Username for 'https://github.com': terminal prompts disabled", github),
    /GitHub asked for a sign-in for acme\/widget: it is private, or it does not exist\. Add a token/,
  )
  const gitlab = source('https://gitlab.acme.dev/platform/api')
  assert.match(
    describeCloneFailure('remote: HTTP Basic: Access denied\nfatal: Authentication failed', gitlab),
    /^GitLab asked for a sign-in.*credential manager/,
  )
  const ssh = source('git@bitbucket.org:acme/app.git')
  assert.match(
    describeCloneFailure('git@bitbucket.org: Permission denied (publickey).\nfatal: Could not read', ssh),
    /bitbucket\.org refused your SSH key/,
  )
  assert.match(
    describeCloneFailure('Host key verification failed.\nfatal: Could not read from remote repository.', ssh),
    /ssh -T git@bitbucket\.org/,
  )
  assert.match(
    describeCloneFailure(
      'warning: Could not find remote branch nope to clone.\nfatal: Remote branch nope not found in upstream origin',
      github,
    ),
    /no branch named nope/,
  )
  assert.match(
    describeCloneFailure(
      "fatal: unable to access 'https://git.acme.dev/x/y/': Could not resolve host: git.acme.dev",
      source('https://git.acme.dev/x/y'),
    ),
    /Could not reach git\.acme\.dev/,
  )
  assert.match(
    describeCloneFailure(
      "fatal: unable to access 'https://git.acme.dev/x/y/': SSL certificate problem: self-signed certificate",
      source('https://git.acme.dev/x/y'),
    ),
    /certificate is not trusted/,
  )
  assert.equal(
    describeCloneFailure("Cloning into 'y'...\nReceiving objects: 10% (1/10)\nfatal: something odd happened", github),
    'something odd happened',
    'anything else is git’s own last words, without its progress',
  )
})

test('the same repository is recognised across transports and spellings', () => {
  assert.equal(sameRepository('git@github.com:acme/widget.git', 'https://github.com/acme/widget'), true)
  assert.equal(sameRepository('https://github.com/Acme/Widget.git', 'acme/widget'), true)
  assert.equal(
    sameRepository('git@ssh.dev.azure.com:v3/acme/web/storefront', 'https://dev.azure.com/acme/web/_git/storefront'),
    false,
  )
  assert.equal(sameRepository('https://github.com/acme/widget', 'https://gitlab.com/acme/widget'), false)
})

test('a request git must not see is refused before anything runs', async () => {
  const parent = scratch()
  assert.deepEqual(await cloneRepository({ url: 'file:///etc', parentDir: parent, folderName: 'x' }), {
    ok: false,
    reason: 'invalid',
    message: 'Enter a clone URL (https://… or git@host:owner/repo) or a GitHub owner/repo.',
  })
  for (const folderName of ['', '..', 'a/b', 'a\\b']) {
    const result = await cloneRepository({ url: 'acme/widget', parentDir: parent, folderName })
    assert.equal(result.ok, false)
    assert.equal(!result.ok && result.reason, 'invalid', `folder ${JSON.stringify(folderName)}`)
  }
  const branch = await cloneRepository({
    url: 'acme/widget',
    parentDir: parent,
    folderName: 'w',
    branch: '--upload-pack=x',
  })
  assert.equal(!branch.ok && branch.reason, 'invalid')
  assert.deepEqual(readdirSync(parent), [], 'nothing was written')
})

test('a folder that is already this repository is offered back, any other occupant refuses', async () => {
  const parent = scratch()
  const existing = join(parent, 'widget')
  mkdirSync(existing)
  execFileSync('git', ['init', '-q', existing])
  execFileSync('git', ['-C', existing, 'remote', 'add', 'origin', 'git@github.com:acme/widget.git'])
  const same = await cloneRepository({
    url: 'https://github.com/acme/widget/tree/main',
    parentDir: parent,
    folderName: 'widget',
  })
  assert.deepEqual(same, {
    ok: false,
    reason: 'exists',
    existingPath: existing,
    message: 'widget is already a clone of acme/widget.',
  })

  const other = join(parent, 'notes')
  mkdirSync(other)
  writeFileSync(join(other, 'todo.txt'), 'keep me')
  const occupied = await cloneRepository({ url: 'acme/notes', parentDir: parent, folderName: 'notes' })
  assert.equal(!occupied.ok && occupied.reason, 'exists')
  assert.equal(!occupied.ok && occupied.existingPath, undefined, 'not a clone of it, so nothing to open')
  assert.ok(existsSync(join(other, 'todo.txt')), 'and nothing in it was touched')
})

test('a clone that cannot connect reports it, leaves an empty target folder as it was, and asks gh only about its host', async () => {
  const parent = scratch()
  mkdirSync(join(parent, 'api'))
  const asked: string[] = []
  const progress: string[] = []
  const result = await cloneRepository(
    { url: 'https://127.0.0.1:9/platform/api', parentDir: parent, folderName: 'api' },
    {
      token: 'saved-github-token',
      resolveHostToken: async (host) => {
        asked.push(host)
        return ''
      },
      onProgress: (step) => progress.push(step.stage),
    },
  )
  assert.equal(result.ok, false)
  assert.equal(!result.ok && result.reason, 'failed')
  assert.match(!result.ok ? result.message : '', /127\.0\.0\.1/)
  assert.deepEqual(asked, ['127.0.0.1'], 'the saved github.com token is never offered to another host')
  assert.equal(progress[0], 'connecting')
  assert.deepEqual(readdirSync(join(parent, 'api')), [], 'the empty folder is still there, still empty')
})

test('a cancelled clone answers cancelled and leaves nothing behind', async () => {
  const parent = scratch()
  const controller = new AbortController()
  controller.abort()
  const result = await cloneRepository(
    { url: 'https://127.0.0.1:9/platform/api', parentDir: parent, folderName: 'api' },
    { signal: controller.signal },
  )
  assert.deepEqual(result, { ok: false, reason: 'cancelled', message: 'Clone cancelled.' })
  assert.equal(existsSync(join(parent, 'api')), false)
})
