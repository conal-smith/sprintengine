import assert from 'node:assert/strict'

import {
  listBranchPullRequests,
  parseRateLimitReset,
  readPullRequestState,
  readRateLimitReset,
} from './branch-pull-request'
import type { GhResult, GhRunner } from './gh'
import { test } from 'vitest'

test('branch-pull-request', async () => {
  // A fake `gh` throughout: no subprocess, no network, no repository. What is
  // under test is what the app CONCLUDES from an answer — including the answers
  // that mean "I could not ask".

  const NOW = Date.parse('2026-09-09T12:00:00.000Z')

  type Call = { args: string[]; cwd?: string; timeoutMs?: number }

  function ghStub(reply: (call: Call) => GhResult): { gh: GhRunner; calls: Call[] } {
    const calls: Call[] = []
    const gh: GhRunner = {
      available: async () => true,
      run: async (args, options) => {
        const call: Call = {
          args,
          ...(options?.cwd ? { cwd: options.cwd } : {}),
          ...(options?.timeoutMs === undefined ? {} : { timeoutMs: options.timeoutMs }),
        }
        calls.push(call)
        return reply(call)
      },
    }
    return { gh, calls }
  }

  function timeoutOf(call: Call | undefined): number | undefined {
    return call?.timeoutMs
  }

  // Nothing below runs unless main() reaches its last line; see the resolve
  // handler at the foot of the file.
  process.exitCode = 1

  function ok(stdout: string): GhResult {
    return { found: true, code: 0, stdout, stderr: '' }
  }

  function row(overrides: Record<string, unknown> = {}): Record<string, unknown> {
    return {
      number: 12,
      url: 'https://github.com/acme/app/pull/12',
      title: 'Teach the sidebar to say where the work went',
      state: 'OPEN',
      isDraft: false,
      createdAt: '2026-09-08T10:00:00.000Z',
      mergedAt: null,
      closedAt: null,
      ...overrides,
    }
  }

  async function main(): Promise<void> {
    // -------------------------------------------------------------------------
    // The query, and the three states. A draft is an OPEN pull request wearing
    // `isDraft` — never a fourth state (decision 1).
    // -------------------------------------------------------------------------
    {
      const { gh, calls } = ghStub(() =>
        ok(
          JSON.stringify([
            row(),
            row({
              number: 11,
              url: 'https://github.com/acme/app/pull/11',
              state: 'OPEN',
              isDraft: true,
              createdAt: '2026-09-07T10:00:00.000Z',
            }),
            row({
              number: 10,
              url: 'https://github.com/acme/app/pull/10',
              state: 'MERGED',
              createdAt: '2026-09-06T10:00:00.000Z',
              mergedAt: '2026-09-06T18:00:00.000Z',
            }),
            row({
              number: 9,
              url: 'https://github.com/acme/app/pull/9',
              state: 'CLOSED',
              createdAt: '2026-09-05T10:00:00.000Z',
              closedAt: '2026-09-05T18:00:00.000Z',
            }),
          ]),
        ),
      )
      const read = await listBranchPullRequests(
        { gitRoot: '/repo/worktree', branch: 'feature/marks' },
        { gh, now: () => NOW },
      )

      assert.deepEqual(calls[0].args, [
        'pr',
        'list',
        '--head',
        'feature/marks',
        '--state',
        'all',
        '--json',
        'number,url,title,state,isDraft,createdAt,mergedAt,closedAt,headRefOid',
      ])
      assert.equal(calls[0].cwd, '/repo/worktree', "the read runs in the session's own checkout")
      assert.equal(read.settled, true)
      if (!read.settled) return
      assert.equal(read.pullRequests.length, 4, 'a branch may carry several pull requests, and every one is kept')
      assert.deepEqual(
        read.pullRequests.map((pr) => [pr.number, pr.state, pr.isDraft]),
        [
          [12, 'open', false],
          [11, 'open', true],
          [10, 'merged', false],
          [9, 'closed', false],
        ],
        'newest first, with MERGED/CLOSED/OPEN mapped and draft carried as a flag',
      )
      assert.equal(read.pullRequests[0].title, 'Teach the sidebar to say where the work went')
      assert.equal(read.pullRequests[0].repoKey, 'github.com/acme/app', 'each row says which repository it is in')
      assert.equal(read.pullRequests[0].repoName, 'app')
      assert.equal(read.pullRequests[0].openedAt, Date.parse('2026-09-08T10:00:00.000Z'))
      assert.equal(read.pullRequests[0].stateAt, NOW, 'stateAt is when GitHub was asked')
      assert.equal(read.pullRequests[0].openedByWorkspaceId, undefined, 'a lookup names no conversation')
      assert.deepEqual(
        read.pullRequests.map((pr) => pr.endedAt),
        [undefined, undefined, Date.parse('2026-09-06T18:00:00.000Z'), Date.parse('2026-09-05T18:00:00.000Z')],
        'one that ended says when: its merge, else its close; an open one says nothing',
      )
    }

    // A pull request whose payload says CLOSED but carries a mergedAt is merged.
    {
      const { gh } = ghStub(() => ok(JSON.stringify([row({ state: 'CLOSED', mergedAt: '2026-09-08T20:00:00.000Z' })])))
      const read = await listBranchPullRequests({ gitRoot: '/repo', branch: 'feature' }, { gh, now: () => NOW })
      assert.equal(read.settled && read.pullRequests[0].state, 'merged')
    }

    // A draft flag on a merged pull request is dropped: only an open one can be a draft.
    {
      const { gh } = ghStub(() =>
        ok(JSON.stringify([row({ state: 'MERGED', isDraft: true, mergedAt: '2026-09-08T20:00:00.000Z' })])),
      )
      const read = await listBranchPullRequests({ gitRoot: '/repo', branch: 'feature' }, { gh, now: () => NOW })
      assert.equal(read.settled && read.pullRequests[0].isDraft, false)
    }

    // -------------------------------------------------------------------------
    // Empty is an ANSWER: this branch has no pull request, and the caller may
    // write that down.
    // -------------------------------------------------------------------------
    {
      const { gh } = ghStub(() => ok('[]'))
      const read = await listBranchPullRequests({ gitRoot: '/repo', branch: 'feature' }, { gh, now: () => NOW })
      assert.deepEqual(read, { settled: true, pullRequests: [] })
    }

    // -------------------------------------------------------------------------
    // "Could not ask" is NOT an empty list. Each of these must leave the caller's
    // record untouched.
    // -------------------------------------------------------------------------
    {
      const missing = ghStub(() => ({ found: false, code: -1, stdout: '', stderr: '' }))
      assert.deepEqual(
        await listBranchPullRequests({ gitRoot: '/repo', branch: 'feature' }, { gh: missing.gh, now: () => NOW }),
        { settled: false, reason: 'gh-missing' },
        'gh not installed is unsettled, never "no pull request"',
      )

      const failed = ghStub(() => ({ found: true, code: 1, stdout: '', stderr: 'could not determine base repository' }))
      assert.deepEqual(
        await listBranchPullRequests({ gitRoot: '/repo', branch: 'feature' }, { gh: failed.gh, now: () => NOW }),
        { settled: false, reason: 'gh-failed' },
      )

      const garbage = ghStub(() => ok('not json at all'))
      assert.deepEqual(
        await listBranchPullRequests({ gitRoot: '/repo', branch: 'feature' }, { gh: garbage.gh, now: () => NOW }),
        { settled: false, reason: 'bad-output' },
      )

      const threw = ghStub(() => {
        throw new Error('spawn exploded')
      })
      assert.deepEqual(
        await listBranchPullRequests({ gitRoot: '/repo', branch: 'feature' }, { gh: threw.gh, now: () => NOW }),
        { settled: false, reason: 'gh-failed' },
      )

      const hangs: GhRunner = { available: async () => true, run: () => new Promise<GhResult>(() => {}) }
      // The race's timer is deliberately unref'd (a pending read must never hold
      // the app open at quit), so THIS process has to hold the loop itself while
      // it waits — without it node simply exited here, silently, taking every
      // assertion below with it and still reporting success.
      const holdLoopOpen = setInterval(() => {}, 1_000)
      assert.deepEqual(
        await listBranchPullRequests(
          { gitRoot: '/repo', branch: 'feature' },
          { gh: hangs, now: () => NOW, timeoutMs: 1 },
        ),
        { settled: false, reason: 'timeout' },
        'a hover never waits behind an offline laptop',
      )
      clearInterval(holdLoopOpen)
    }

    // A question we cannot ask never reaches `gh` at all.
    {
      const { gh, calls } = ghStub(() => ok('[]'))
      assert.deepEqual(await listBranchPullRequests({ gitRoot: '/repo', branch: '' }, { gh }), {
        settled: false,
        reason: 'bad-request',
      })
      assert.deepEqual(await listBranchPullRequests({ gitRoot: '/repo', branch: '--state' }, { gh }), {
        settled: false,
        reason: 'bad-request',
      })
      assert.deepEqual(await listBranchPullRequests({ gitRoot: '', branch: 'feature' }, { gh }), {
        settled: false,
        reason: 'bad-request',
      })
      assert.equal(calls.length, 0, 'a flag-shaped branch is never handed to gh')
    }

    // -------------------------------------------------------------------------
    // GitHub Enterprise Server: the host the checkout's remote uses is the host
    // the record keys on. Nothing is rewritten to github.com.
    // -------------------------------------------------------------------------
    {
      const { gh } = ghStub(() =>
        ok(JSON.stringify([row({ url: 'https://ghe.corp.example.com/acme/app/pull/12/files?w=1' })])),
      )
      const read = await listBranchPullRequests({ gitRoot: '/repo', branch: 'feature' }, { gh, now: () => NOW })
      assert.equal(
        read.settled && read.pullRequests[0].url,
        'https://ghe.corp.example.com/acme/app/pull/12',
        'the enterprise host passes through, canonicalised by the one URL parser',
      )
      assert.equal(
        read.settled && read.pullRequests[0].repoKey,
        'ghe.corp.example.com/acme/app',
        'and its repository key carries the host, so two hosts are two repositories',
      )
    }

    // A row we cannot key or cannot state is skipped; the rest of the answer stands.
    {
      const { gh } = ghStub(() =>
        ok(
          JSON.stringify([
            { ...row(), url: 'not a url' },
            { ...row({ number: 8, url: 'https://github.com/acme/app/pull/8' }), state: 'ELSEWHERE' },
            row(),
          ]),
        ),
      )
      const read = await listBranchPullRequests({ gitRoot: '/repo', branch: 'feature' }, { gh, now: () => NOW })
      assert.equal(read.settled, true)
      assert.deepEqual(read.settled && read.pullRequests.map((pr) => pr.number), [12])
    }

    // -------------------------------------------------------------------------
    // The state re-read, by URL — the watch's probe and hover's refresh.
    // -------------------------------------------------------------------------
    {
      const { gh, calls } = ghStub(() =>
        ok(
          JSON.stringify({
            state: 'OPEN',
            isDraft: true,
            mergedAt: null,
            closedAt: null,
            headRefName: 'feature/marks',
          }),
        ),
      )
      const read = await readPullRequestState('https://github.com/acme/app/pull/12/files', { gh, now: () => NOW })
      assert.deepEqual(calls[0].args, [
        'pr',
        'view',
        'https://github.com/acme/app/pull/12',
        '--json',
        'number,title,state,isDraft,createdAt,mergedAt,closedAt,headRefName',
      ])
      assert.equal(calls[0].cwd, undefined, 'a URL read needs no checkout')
      assert.deepEqual(
        read,
        {
          settled: true,
          state: 'open',
          isDraft: true,
          stateAt: NOW,
          headRefName: 'feature/marks',
          title: null,
          openedAt: null,
          number: null,
        },
        'the head branch comes back too: it is how a captured pull request learns which branch it is on',
      )
    }
    {
      const { gh } = ghStub(() =>
        ok(
          JSON.stringify({
            state: 'MERGED',
            isDraft: false,
            mergedAt: '2026-09-09T09:00:00.000Z',
            closedAt: '2026-09-09T09:00:00.000Z',
          }),
        ),
      )
      assert.deepEqual(await readPullRequestState('https://github.com/acme/app/pull/12', { gh, now: () => NOW }), {
        settled: true,
        state: 'merged',
        isDraft: false,
        stateAt: NOW,
        headRefName: null,
        title: null,
        openedAt: null,
        number: null,
        endedAt: Date.parse('2026-09-09T09:00:00.000Z'),
      })
    }
    {
      const { gh } = ghStub(() =>
        ok(JSON.stringify({ state: 'CLOSED', isDraft: false, mergedAt: null, closedAt: '2026-09-09T09:00:00.000Z' })),
      )
      assert.deepEqual(await readPullRequestState('https://github.com/acme/app/pull/12', { gh, now: () => NOW }), {
        settled: true,
        state: 'closed',
        isDraft: false,
        stateAt: NOW,
        headRefName: null,
        title: null,
        openedAt: null,
        number: null,
        endedAt: Date.parse('2026-09-09T09:00:00.000Z'),
      })
    }
    {
      const missing = ghStub(() => ({ found: false, code: -1, stdout: '', stderr: '' }))
      assert.deepEqual(await readPullRequestState('https://github.com/acme/app/pull/12', { gh: missing.gh }), {
        settled: false,
        reason: 'gh-missing',
      })
      const { gh, calls } = ghStub(() => ok('{}'))
      assert.deepEqual(await readPullRequestState('https://bitbucket.org/acme/app/pull-requests/12', { gh }), {
        settled: false,
        reason: 'bad-request',
      })
      assert.deepEqual(await readPullRequestState('nonsense', { gh }), { settled: false, reason: 'bad-request' })
      assert.equal(calls.length, 0)
    }
    {
      // gh answered, but with no state we recognise: unsettled, so the record
      // keeps the state it last read (decision 3).
      const { gh } = ghStub(() => ok(JSON.stringify({ isDraft: false })))
      assert.deepEqual(await readPullRequestState('https://github.com/acme/app/pull/12', { gh }), {
        settled: false,
        reason: 'bad-output',
      })
    }

    // -------------------------------------------------------------------------
    // REVIEW FIX (finding 2). A CAPTURED pull request is filed from a URL alone,
    // and in another repository no branch lookup will ever name it. So the state
    // read asks for the title and the opening date too — without them every menu
    // row, the peek's title line and the spoken label read empty for ever.
    // -------------------------------------------------------------------------
    {
      const { gh } = ghStub(() =>
        ok(
          JSON.stringify({
            number: 9,
            title: 'Refresh the banner',
            state: 'OPEN',
            isDraft: false,
            createdAt: '2026-09-05T09:00:00.000Z',
            mergedAt: null,
            closedAt: null,
            headRefName: 'site/banner',
          }),
        ),
      )
      assert.deepEqual(await readPullRequestState('https://github.com/acme/website/pull/9', { gh, now: () => NOW }), {
        settled: true,
        state: 'open',
        isDraft: false,
        stateAt: NOW,
        headRefName: 'site/banner',
        title: 'Refresh the banner',
        openedAt: Date.parse('2026-09-05T09:00:00.000Z'),
        number: 9,
      })
    }

    // -------------------------------------------------------------------------
    // REVIEW FIX (finding 7). The runner's PATH fallback is `$SHELL -ilc 'gh …'`,
    // and on a GUI-launched macOS app with a Homebrew gh that is the NORMAL path.
    // An interactive login shell prints whatever the user's rc files print on the
    // same stdout, so the JSON arrives with a banner in front of it — which used
    // to make every read permanently 'bad-output'.
    // -------------------------------------------------------------------------
    {
      const banner = 'Now using node v22.4.0 (npm v10.13.0)\nnvm: setting up\n'
      const { gh } = ghStub(() => ok(`${banner}${JSON.stringify([row()])}\n`))
      const read = await listBranchPullRequests({ gitRoot: '/repo', branch: 'feature' }, { gh, now: () => NOW })
      assert.equal(read.settled, true, 'a login-shell banner is not a bad answer')
      assert.deepEqual(read.settled && read.pullRequests.map((pr) => pr.number), [12])

      // The same, for the state read — and with a brace inside a string, which a
      // naive "find the last }" would cut in the wrong place.
      const state = ghStub(() =>
        ok(`${banner}${JSON.stringify({ state: 'OPEN', isDraft: false, title: 'a } brace', headRefName: 'feature' })}`),
      )
      assert.deepEqual(
        await readPullRequestState('https://github.com/acme/app/pull/12', { gh: state.gh, now: () => NOW }),
        {
          settled: true,
          state: 'open',
          isDraft: false,
          stateAt: NOW,
          headRefName: 'feature',
          title: 'a } brace',
          openedAt: null,
          number: null,
        },
      )

      // A banner and nothing else is still 'bad-output': there is no answer in it.
      const empty = ghStub(() => ok(banner))
      assert.deepEqual(await listBranchPullRequests({ gitRoot: '/repo', branch: 'feature' }, { gh: empty.gh }), {
        settled: false,
        reason: 'bad-output',
      })
    }

    // -------------------------------------------------------------------------
    // REVIEW FIX (finding 6). The read's bound is handed to the RUNNER, which
    // kills the child with it. Racing a timer only stops us waiting: the `gh` —
    // and, on the login-shell fallback, a whole `$SHELL -ilc` — kept running.
    // -------------------------------------------------------------------------
    {
      const { gh, calls } = ghStub(() => ok('[]'))
      await listBranchPullRequests({ gitRoot: '/repo', branch: 'feature' }, { gh, now: () => NOW, timeoutMs: 1_234 })
      assert.equal(timeoutOf(calls[0]), 1_234, 'the bound reaches the runner, not just our own timer')

      // And a child the runner killed is a read that did not happen.
      const killed: GhRunner = {
        available: async () => true,
        run: async () => ({ found: true, code: 1, stdout: '', stderr: '', timedOut: true }),
      }
      assert.deepEqual(await listBranchPullRequests({ gitRoot: '/repo', branch: 'feature' }, { gh: killed }), {
        settled: false,
        reason: 'timeout',
      })
      assert.deepEqual(await readPullRequestState('https://github.com/acme/app/pull/12', { gh: killed }), {
        settled: false,
        reason: 'timeout',
      })
    }
  }

  const suiteRun = main().then(
    () => {
      // A silent early exit — an unref'd timer with nothing else on the loop —
      // used to read as success. Nothing but this line clears the failure.
      process.exitCode = 0
      console.log('github/branch-pull-request: all assertions passed')
    },
    (error) => {
      console.error(error)
      process.exitCode = 1
    },
  )

  await suiteRun
})

test('the rate-limit reset is the latest among the spent quotas the reads use', () => {
  const quota = (remaining: number, reset: number) => ({ limit: 5000, used: 5000 - remaining, remaining, reset })
  assert.equal(
    parseRateLimitReset({ resources: { core: quota(0, 1_800_000_100), graphql: quota(0, 1_800_000_200) } }),
    1_800_000_200_000,
  )
  assert.equal(
    parseRateLimitReset({ resources: { core: quota(12, 1_800_000_100), graphql: quota(0, 1_800_000_050) } }),
    1_800_000_050_000,
  )
  // Nothing spent is a secondary limit: no reset to wait for.
  assert.equal(
    parseRateLimitReset({ resources: { core: quota(1, 1_800_000_100), graphql: quota(9, 1_800_000_100) } }),
    null,
  )
  assert.equal(parseRateLimitReset({ message: 'Bad credentials' }), null)
  assert.equal(parseRateLimitReset(null), null)
})

test('the rate-limit reset is asked of the pull request host, and an unaskable host is not asked', async () => {
  const calls: string[][] = []
  const gh: GhRunner = {
    available: async () => true,
    run: async (args) => {
      calls.push(args)
      return {
        found: true,
        code: 0,
        stdout: JSON.stringify({ resources: { graphql: { remaining: 0, reset: 1_800_000_000 } } }),
        stderr: '',
      } as GhResult
    },
  }
  assert.equal(await readRateLimitReset('github.example.com', { gh }), 1_800_000_000_000)
  assert.deepEqual(calls, [['api', 'rate_limit', '--hostname', 'github.example.com']])
  assert.equal(await readRateLimitReset('--hostname=evil', { gh }), null)
  assert.equal(calls.length, 1)
})
