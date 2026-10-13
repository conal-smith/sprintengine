import assert from 'node:assert/strict'

import { test } from 'vitest'

import { forgeOfRemote, type ForgeRemote } from '../shared/git/pull-request-create'
import {
  createForgePullRequests,
  glabDescription,
  lastRequestUrl,
  teaLoginFor,
  type ForgeRequestTarget,
} from './forge-pull-request'
import type { GhResult, GhRunner, GhRunOptions } from './github/gh'

// GitLab merge requests and Gitea pull requests through stand-ins for `glab`
// and `tea`: every call is recorded and answered from a script, so nothing
// reaches a forge and the exact command lines are what is asserted.

type Call = { args: string[]; options: GhRunOptions | undefined }

function fakeCli(answer: (args: string[]) => Partial<GhResult>): GhRunner & { calls: Call[] } {
  const calls: Call[] = []
  return {
    calls,
    available: async () => true,
    run: async (args, options) => {
      calls.push({ args, options })
      return { found: true, code: 0, stdout: '', stderr: '', ...answer(args) }
    },
  }
}

const MISSING: Partial<GhResult> = { found: false, code: -1 }

function remote(url: string): ForgeRemote {
  const read = forgeOfRemote(url)
  assert.ok(read)
  return read
}

function target(url: string, extra: Partial<ForgeRequestTarget> = {}): ForgeRequestTarget {
  return { gitRoot: '/Users/dev/app', remote: remote(url), branch: 'feature/marks', base: 'main', ...extra }
}

const TEXT = { title: 'feat: marks', body: '## Why\n\nMarks.' }

/** glab, signed in, answering `mr create` and `mr list` as told. */
function glabSignedIn(answers: { create?: Partial<GhResult>; list?: Partial<GhResult> } = {}) {
  return fakeCli((args) => {
    if (args[0] === 'auth') return { stderr: 'gitlab.com\n  ✓ Logged in to gitlab.com as dev (keyring)\n' }
    if (args[1] === 'create') return answers.create ?? {}
    if (args[1] === 'list') return answers.list ?? { stdout: '[]' }
    return assert.fail(`unexpected glab ${args.join(' ')}`)
  })
}

const TEA_LOGINS = JSON.stringify([
  { name: 'work', url: 'https://gitea.example.com', ssh_host: 'gitea.example.com', user: 'dev', default: 'true' },
  { name: 'codeberg', url: 'https://codeberg.org', ssh_host: 'codeberg.org', user: 'dev', default: 'false' },
])

/** tea 0.16, logged in to gitea.example.com and codeberg.org, answering `pulls create` and `pulls list` as told. */
function teaSignedIn(answers: { create?: Partial<GhResult>; list?: Partial<GhResult>; version?: string } = {}) {
  return fakeCli((args) => {
    if (args[0] === '--version') return { stdout: answers.version ?? 'Version: 0.16.0\tgolang: 1.25\n' }
    if (args[0] === 'logins') return { stdout: TEA_LOGINS }
    if (args[1] === 'create') return answers.create ?? {}
    if (args[1] === 'list') return answers.list ?? { stdout: '[]' }
    return assert.fail(`unexpected tea ${args.join(' ')}`)
  })
}

const CODEBERG_ROW = (state: string, head = 'feature/marks') =>
  JSON.stringify([{ index: '12', state, head, url: 'https://codeberg.org/acme/app/pulls/12' }])

test('GitLab: glab opens the merge request on the remote’s project, and its address is read from what glab prints', async () => {
  const glab = glabSignedIn({
    create: {
      stdout: '!7 feat: marks (feature/marks)\n https://gitlab.com/acme/app/-/merge_requests/7\n',
      stderr: '\nCreating merge request for feature/marks into main in acme/app\n\n',
    },
  })
  const forges = createForgePullRequests({ glab, tea: fakeCli(() => assert.fail('tea is not GitLab’s')) })
  assert.deepEqual(await forges.create(target('git@gitlab.com:acme/app.git'), TEXT), {
    kind: 'created',
    url: 'https://gitlab.com/acme/app/-/merge_requests/7',
  })
  assert.deepEqual(glab.calls[0].args, ['auth', 'status', '--hostname=gitlab.com'])
  assert.deepEqual(glab.calls[1].args, [
    'mr',
    'create',
    '--repo=https://gitlab.com/acme/app',
    '--head=https://gitlab.com/acme/app',
    '--source-branch=feature/marks',
    '--target-branch=main',
    '--title=feat: marks',
    '--description=## Why\n\nMarks.',
    '--yes',
  ])
  assert.equal(glab.calls[1].options?.cwd, '/Users/dev/app')
  assert.deepEqual(glab.calls[1].options?.setEnv, { NO_PROMPT: '1' }, 'glab never waits on a prompt')
})

test('GitLab: a branch that already has an open merge request is shown, not opened twice', async () => {
  const glab = glabSignedIn({
    create: {
      code: 1,
      stderr:
        'POST https://gitlab.com/api/v4/projects/acme%2Fapp/merge_requests: 409 {message: [Another open merge request already exists for this source branch: !5]}\n',
    },
    list: {
      stdout: JSON.stringify([
        {
          iid: 5,
          state: 'opened',
          source_branch: 'feature/marks',
          sha: 'a1b2c3d4e5f6',
          web_url: 'https://gitlab.com/acme/app/-/merge_requests/5',
        },
      ]),
    },
  })
  const forges = createForgePullRequests({ glab })
  assert.deepEqual(await forges.create(target('git@gitlab.com:acme/app.git'), TEXT), {
    kind: 'existing',
    url: 'https://gitlab.com/acme/app/-/merge_requests/5',
  })
  assert.deepEqual(glab.calls.at(-1)?.args, [
    'mr',
    'list',
    '--repo=https://gitlab.com/acme/app',
    '--source-branch=feature/marks',
    '--all',
    '--output=json',
    '--per-page=50',
  ])
})

test('GitLab: without glab the page opens, and the reason says how to get it', async () => {
  const glab = fakeCli(() => MISSING)
  const forges = createForgePullRequests({ glab })
  const outcome = await forges.create(target('git@gitlab.com:acme/app.git'), TEXT)
  assert.equal(outcome.kind, 'unavailable')
  assert.match(outcome.kind === 'unavailable' ? outcome.reason : '', /Install glab and run `glab auth login`/)
  assert.equal(glab.calls.length, 1, 'nothing is attempted after glab is found missing')
})

test('GitLab: glab signed out of the remote’s host names the host and the command that signs in', async () => {
  const glab = fakeCli((args) =>
    args[0] === 'auth'
      ? { code: 1, stderr: 'x gitlab.example.com has not been authenticated with glab.\n' }
      : assert.fail('nothing is created while signed out'),
  )
  const forges = createForgePullRequests({ glab })
  const outcome = await forges.create(target('https://gitlab.example.com:8443/acme/platform/app.git'), TEXT)
  assert.deepEqual(glab.calls[0].args, ['auth', 'status', '--hostname=gitlab.example.com:8443'])
  assert.equal(outcome.kind, 'unavailable')
  assert.equal(
    outcome.kind === 'unavailable' ? outcome.reason : '',
    'glab is not signed in to gitlab.example.com:8443: run `glab auth login --hostname gitlab.example.com:8443` to open merge requests from here.',
  )
})

test('GitLab: glab refusing for another reason says why in its own words', async () => {
  const glab = glabSignedIn({ create: { code: 1, stderr: 'POST …/merge_requests: 403 {message: 403 Forbidden}\n' } })
  const outcome = await createForgePullRequests({ glab }).create(target('git@gitlab.com:acme/app.git'), TEXT)
  assert.deepEqual(outcome, {
    kind: 'unavailable',
    reason: 'glab could not open the merge request: POST …/merge_requests: 403 {message: 403 Forbidden}',
  })
})

test('Gitea and Forgejo: tea opens the pull request with the login for the remote’s host', async () => {
  const tea = teaSignedIn({
    create: { stdout: '# #12 feat: marks (open)\n@dev created now\tmain <- feature/marks\n' },
    list: { stdout: CODEBERG_ROW('open') },
  })
  const forges = createForgePullRequests({ tea, glab: fakeCli(() => assert.fail('glab is not Gitea’s')) })
  assert.deepEqual(await forges.create(target('git@codeberg.org:acme/app.git'), TEXT), {
    kind: 'created',
    url: 'https://codeberg.org/acme/app/pulls/12',
  })
  assert.deepEqual(
    tea.calls.map((call) => call.args.slice(0, 2)),
    [['--version'], ['logins', 'list'], ['pulls', 'create'], ['pulls', 'list']],
  )
  assert.deepEqual(tea.calls[2].args, [
    'pulls',
    'create',
    '--login=codeberg',
    '--repo=acme/app',
    '--head=feature/marks',
    '--base=main',
    '--title=feat: marks',
    '--description=## Why\n\nMarks.',
  ])
  assert.deepEqual(tea.calls[3].args, [
    'pulls',
    'list',
    '--login=codeberg',
    '--repo=acme/app',
    '--state=all',
    '--output=json',
    '--fields=index,state,head,url',
    '--limit=50',
  ])
})

test('Gitea and Forgejo: an open pull request between the same branches is shown, not opened twice', async () => {
  const tea = teaSignedIn({
    create: {
      code: 1,
      stderr:
        'could not create PR from feature/marks to acme:main: pull request already exists for these targets [id: 12, issue_id: 30, head_repo_id: 4, base_repo_id: 4, head_branch: feature/marks, base_branch: main]\n',
    },
    list: { stdout: CODEBERG_ROW('open') },
  })
  assert.deepEqual(await createForgePullRequests({ tea }).create(target('https://codeberg.org/acme/app.git'), TEXT), {
    kind: 'existing',
    url: 'https://codeberg.org/acme/app/pulls/12',
  })
})

test('Gitea and Forgejo: tea with no login for the host says which command adds one', async () => {
  const tea = teaSignedIn()
  const outcome = await createForgePullRequests({ tea }).create(target('git@forgejo.example.com:acme/app.git'), TEXT)
  assert.deepEqual(outcome, {
    kind: 'unavailable',
    reason:
      'tea has no login for forgejo.example.com: run `tea login add --url https://forgejo.example.com` to open pull requests from here.',
  })
})

test('Gitea and Forgejo: tea 1.x, whose commands were all renamed, is not driven with 0.x command lines', async () => {
  const tea = teaSignedIn({ version: 'tea version 1.0.0\n' })
  const outcome = await createForgePullRequests({ tea }).create(target('https://codeberg.org/acme/app.git'), TEXT)
  assert.equal(outcome.kind, 'unavailable')
  assert.match(outcome.kind === 'unavailable' ? outcome.reason : '', /tea 0\.x/)
  assert.equal(tea.calls.length, 1)
})

test('titles and descriptions with quotes, newlines and leading dashes stay values, never flags', async () => {
  const awkward = {
    title: '--draft "quoted" title; $(rm -rf ~)',
    body: '-d\n--yes\n"quotes" and \'apostrophes\'\n`backticks`',
  }
  const glab = glabSignedIn({ create: { stdout: 'https://gitlab.com/acme/app/-/merge_requests/9\n' } })
  await createForgePullRequests({ glab }).create(target('git@gitlab.com:acme/app.git'), awkward)
  const create = glab.calls[1].args
  assert.ok(create.includes(`--title=${awkward.title}`), 'the title is one argument, joined to its flag')
  assert.ok(create.includes(`--description=${awkward.body}`))
  assert.ok(!create.includes('--draft') && create.filter((arg) => arg === '--yes').length === 1)

  const tea = teaSignedIn({ list: { stdout: CODEBERG_ROW('open') } })
  await createForgePullRequests({ tea }).create(target('git@codeberg.org:acme/app.git'), awkward)
  const teaCreate = tea.calls.find((call) => call.args[1] === 'create')?.args ?? []
  assert.ok(teaCreate.includes(`--title=${awkward.title}`))
  assert.ok(teaCreate.includes(`--description=${awkward.body}`))

  // glab reads a description of exactly "-" as "open an editor".
  assert.equal(glabDescription('-'), '\\-')
  assert.equal(glabDescription(' - \n'), '\\-')
  assert.equal(glabDescription('- a list item'), '- a list item')
})

test('a fork on the same host is named as the head; one on another host is not driven', async () => {
  const glab = glabSignedIn({ create: { stdout: 'https://gitlab.com/acme/app/-/merge_requests/3\n' } })
  await createForgePullRequests({ glab }).create(
    target('git@gitlab.com:acme/app.git', { pushedTo: remote('git@gitlab.com:dev/app.git') }),
    TEXT,
  )
  assert.ok(glab.calls[1].args.includes('--head=https://gitlab.com/dev/app'))

  const tea = teaSignedIn({ list: { stdout: CODEBERG_ROW('open', 'dev:feature/marks') } })
  const forked = await createForgePullRequests({ tea }).create(
    target('git@codeberg.org:acme/app.git', { pushedTo: remote('git@codeberg.org:dev/app.git') }),
    TEXT,
  )
  assert.ok(tea.calls.find((call) => call.args[1] === 'create')?.args.includes('--head=dev:feature/marks'))
  assert.deepEqual(forked, { kind: 'created', url: 'https://codeberg.org/acme/app/pulls/12' })

  const elsewhere = fakeCli(() => assert.fail('nothing is run for a fork on another host'))
  const outcome = await createForgePullRequests({ glab: elsewhere }).create(
    target('git@gitlab.com:acme/app.git', { pushedTo: remote('git@gitlab.example.com:dev/app.git') }),
    TEXT,
  )
  assert.equal(outcome.kind, 'unavailable')
})

test('a branch lookup reads open and merged requests and the merged heads, and asks no CLI it holds as missing', async () => {
  const glab = glabSignedIn({
    list: {
      stdout: JSON.stringify([
        {
          state: 'merged',
          source_branch: 'feature/marks',
          sha: 'a1b2c3d',
          web_url: 'https://gitlab.com/acme/app/-/merge_requests/2',
        },
        {
          state: 'opened',
          source_branch: 'feature/marks',
          sha: 'e4f5a6b',
          web_url: 'https://gitlab.com/acme/app/-/merge_requests/4',
        },
        {
          state: 'opened',
          source_branch: 'feature/other',
          sha: 'c7d8e9f',
          web_url: 'https://gitlab.com/acme/app/-/merge_requests/6',
        },
      ]),
    },
  })
  assert.deepEqual(await createForgePullRequests({ glab }).listBranch(target('git@gitlab.com:acme/app.git')), {
    settled: true,
    requests: [
      { url: 'https://gitlab.com/acme/app/-/merge_requests/2', state: 'merged', headSha: 'a1b2c3d' },
      { url: 'https://gitlab.com/acme/app/-/merge_requests/4', state: 'open', headSha: 'e4f5a6b' },
    ],
  })

  let at = 0
  const missing = fakeCli(() => MISSING)
  const forges = createForgePullRequests({ glab: missing, now: () => (at += 1_000) })
  assert.deepEqual(await forges.listBranch(target('git@gitlab.com:acme/app.git')), { settled: false })
  assert.deepEqual(await forges.listBranch(target('git@gitlab.com:acme/app.git')), { settled: false })
  assert.equal(missing.calls.length, 1, 'a glab found missing is not looked for again on every ask')
})

test('the created request’s address is the last one on the target repository in what the CLI printed', () => {
  const gitlab = remote('git@gitlab.com:acme/platform/app.git')
  assert.equal(
    lastRequestUrl(
      '!8 Revert https://gitlab.com/acme/platform/app/-/merge_requests/3 (feature/marks)\n https://gitlab.com/acme/platform/app/-/merge_requests/8\n',
      gitlab,
    ),
    'https://gitlab.com/acme/platform/app/-/merge_requests/8',
  )
  assert.equal(
    lastRequestUrl('see https://gitlab.com/other/app/-/merge_requests/8', gitlab),
    null,
    'another project’s merge request is not this one',
  )
  assert.equal(
    lastRequestUrl('http://gitea.lan:3000/acme/app/pulls/4\n', remote('http://gitea.lan:3000/acme/app.git')),
    'https://gitea.lan:3000/acme/app/pulls/4',
  )
  assert.equal(lastRequestUrl('https://gitlab.com/acme/platform/app/-/merge_requests/new', gitlab), null)
})

test('the tea login is the one for the remote’s server, by URL or SSH host, the default among several', () => {
  const logins = [
    { name: 'lan', url: 'http://gitea.lan:3000', ssh_host: 'gitea.lan', user: 'dev', default: 'false' },
    { name: 'work', url: 'https://gitea.example.com', ssh_host: 'git.example.com', user: 'dev', default: 'false' },
    { name: 'work-bot', url: 'https://gitea.example.com', ssh_host: 'gitea.example.com', user: 'bot', default: 'true' },
  ]
  assert.equal(teaLoginFor(logins, 'https://gitea.example.com/acme/app'), 'work-bot')
  assert.equal(teaLoginFor(logins, 'https://git.example.com/acme/app'), 'work', 'an SSH remote names the SSH host')
  assert.equal(teaLoginFor(logins, 'http://gitea.lan:3000/acme/app'), 'lan')
  assert.equal(teaLoginFor(logins, 'http://gitea.lan:8080/acme/app'), null, 'a web port that is not the server’s')
  assert.equal(teaLoginFor(logins, 'https://codeberg.org/acme/app'), null)
  assert.equal(teaLoginFor('not a list', 'https://codeberg.org/acme/app'), null)
})

test('asks that overlap share one sign-in check', async () => {
  const glab = glabSignedIn()
  const forges = createForgePullRequests({ glab })
  await Promise.all([
    forges.listBranch(target('git@gitlab.com:acme/app.git')),
    forges.listBranch(target('git@gitlab.com:acme/app.git')),
  ])
  assert.equal(glab.calls.filter((call) => call.args[0] === 'auth').length, 1)
})
