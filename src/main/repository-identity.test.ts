import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { readRepositoryIdentity, readRepositoryIdentityRead } from './repository-identity'
import { test } from 'vitest'

test('repository-identity', async () => {
  // Which repository a folder is a clone of, and — the part this suite is for —
  // whether the question was ANSWERED (one-colour-per-project, 2026-09-09).
  //
  // The reader always answered a bare `RepositoryIdentity | null`, which made
  // "asked, and this folder has no remote" indistinguishable from "could not
  // ask": a 3s timeout on a spun-down volume, or git throwing. That is fine for
  // grouping, where either way the folder groups by its path, and wrong for the
  // project colour, which WRITES the answer down — a folder on a sleeping disk
  // would be given a hue under its path key now and a second one under its
  // repository key the next time the disk was awake, so one project would wear
  // two of the six colours. `settled` is what the renderer waits on, so it is
  // worth a suite of its own.
  //
  // The git calls are injected. The alternative is a real repository per case,
  // which cannot produce the failure modes that matter here (a read that throws,
  // a read served from the hold) without a great deal of ceremony.

  let failures = 0
  async function run(name: string, fn: () => Promise<void> | void): Promise<void> {
    try {
      await fn()
      console.log(`ok - ${name}`)
    } catch (error) {
      failures += 1
      console.error(`not ok - ${name}`)
      console.error(error)
    }
  }

  // A fresh folder path per case: the module holds its answers in a process-wide
  // cache keyed by path, which is the point of the cache and would otherwise make
  // these cases read each other's results.
  let counter = 0
  const uniqueFolder = () => `/tmp/repo-identity-${(counter += 1)}`

  const REMOTE_V =
    'origin\tgit@github.com:acme/sprintengine.git (fetch)\norigin\tgit@github.com:acme/sprintengine.git (push)\n'

  const suiteRun = (async () => {
    await run('a completed read is settled, and names the repository', async () => {
      const folder = uniqueFolder()
      const read = await readRepositoryIdentityRead(folder, {
        readers: { readRepoRoot: async () => folder, readRemotes: async () => REMOTE_V },
      })
      assert.equal(read.settled, true)
      assert.equal(read.identity?.canonicalKey, 'github.com/acme/sprintengine')
    })

    await run('a folder that is not a repository is a settled null, not an unknown', async () => {
      const read = await readRepositoryIdentityRead(uniqueFolder(), {
        readers: { readRepoRoot: async () => null, readRemotes: async () => '' },
      })
      assert.deepEqual(read, { identity: null, settled: true })
    })

    await run('a repository with no remote is also a settled null', async () => {
      const folder = uniqueFolder()
      const read = await readRepositoryIdentityRead(folder, {
        readers: { readRepoRoot: async () => folder, readRemotes: async () => '' },
      })
      assert.deepEqual(read, { identity: null, settled: true })
    })

    await run('a read that throws is NOT an answer', async () => {
      const read = await readRepositoryIdentityRead(uniqueFolder(), {
        readers: {
          readRepoRoot: async () => {
            throw new Error('ENOENT: the volume is not mounted')
          },
          readRemotes: async () => '',
        },
      })
      assert.deepEqual(read, { identity: null, settled: false }, 'a spun-down volume is "could not ask"')
    })

    await run('an unsettled read is held briefly and then really re-read', async () => {
      const folder = uniqueFolder()
      let attempts = 0
      const failing = {
        readRepoRoot: async () => {
          attempts += 1
          throw new Error('unreadable')
        },
        readRemotes: async () => '',
      }
      let clock = 1_000_000
      const now = () => clock
      await readRepositoryIdentityRead(folder, { now, readers: failing })
      assert.equal(attempts, 1)

      // Within the failure window the cached non-answer is served — a hundred
      // folders on one sleeping volume must not each spend the timeout again —
      // and it is still reported as unsettled rather than as "no remote".
      clock += 5_000
      const cached = await readRepositoryIdentityRead(folder, { now, readers: failing })
      assert.equal(attempts, 1, 'the failure is held for the short window')
      assert.deepEqual(cached, { identity: null, settled: false }, 'and is still not an answer')

      // Past it, the read really happens again, and this time it lands.
      clock += 6_000
      const answered = await readRepositoryIdentityRead(folder, {
        now,
        readers: { readRepoRoot: async () => folder, readRemotes: async () => REMOTE_V },
      })
      assert.equal(answered.settled, true)
      assert.equal(answered.identity?.canonicalKey, 'github.com/acme/sprintengine')
    })

    await run('a settled answer is held for the full minute', async () => {
      const folder = uniqueFolder()
      let attempts = 0
      const readers = {
        readRepoRoot: async () => {
          attempts += 1
          return folder
        },
        readRemotes: async () => REMOTE_V,
      }
      let clock = 2_000_000
      const now = () => clock
      await readRepositoryIdentityRead(folder, { now, readers })
      clock += 30_000
      await readRepositoryIdentityRead(folder, { now, readers })
      assert.equal(attempts, 1, 'a remote URL changes about never; one read covers the hold')
    })

    await run('an empty path is answered, not failed', async () => {
      assert.deepEqual(await readRepositoryIdentityRead('   '), { identity: null, settled: true })
    })

    await run('the narrow reader still answers the identity alone', async () => {
      const folder = uniqueFolder()
      const identity = await readRepositoryIdentity(folder, {
        readers: { readRepoRoot: async () => folder, readRemotes: async () => REMOTE_V },
      })
      assert.equal(identity?.canonicalKey, 'github.com/acme/sprintengine')

      // The gateway's projection only groups, so it is handed the identity and
      // never has to think about whether the question was answered: an
      // unreadable folder is simply no identity to it.
      const unreadable = await readRepositoryIdentity(uniqueFolder(), {
        readers: {
          readRepoRoot: async () => {
            throw new Error('unreadable')
          },
          readRemotes: async () => '',
        },
      })
      assert.equal(unreadable, null)
    })

    if (failures > 0) {
      console.error(`repository-identity.test.ts: ${failures} failing`)
      process.exit(1)
    }
    console.log('repository-identity.test.ts: ok')
  })()

  await suiteRun
})

// The default readers, against real repositories: a bare one has no work tree,
// so the root question is the one that has to be asked differently.
function git(cwd: string, args: string[]): void {
  execFileSync('git', ['-C', cwd, ...args], { stdio: 'ignore' })
}

function withTempDir(prefix: string, fn: (dir: string) => Promise<void>): Promise<void> {
  const dir = mkdtempSync(join(tmpdir(), prefix))
  return fn(dir).finally(() => rmSync(dir, { recursive: true, force: true }))
}

test('a bare clone reads the identity of its remote', async () => {
  await withTempDir('sprintengine-repo-identity-bare-', async (dir) => {
    git(dir, ['init', '--quiet', '--bare'])
    git(dir, ['remote', 'add', 'origin', 'git@github.com:acme/app.git'])
    const read = await readRepositoryIdentityRead(dir)
    assert.deepEqual([read.settled, read.identity?.canonicalKey], [true, 'github.com/acme/app'])
  })
})

test('a folder whose .git file points at ./.bare reads the identity of its remote', async () => {
  await withTempDir('sprintengine-repo-identity-dotbare-', async (dir) => {
    git(dir, ['init', '--quiet', '--bare', join(dir, '.bare')])
    writeFileSync(join(dir, '.git'), 'gitdir: ./.bare\n')
    git(dir, ['remote', 'add', 'origin', 'https://github.com/acme/app.git'])
    const identity = await readRepositoryIdentity(dir)
    assert.equal(identity?.canonicalKey, 'github.com/acme/app')
  })
})

test('a checkout still reads the identity of its remote', async () => {
  await withTempDir('sprintengine-repo-identity-checkout-', async (dir) => {
    git(dir, ['init', '--quiet'])
    git(dir, ['remote', 'add', 'origin', 'git@github.com:acme/app.git'])
    const identity = await readRepositoryIdentity(dir)
    assert.equal(identity?.canonicalKey, 'github.com/acme/app')
  })
})

test("a checkout's .git folder is not taken for a bare repository", async () => {
  await withTempDir('sprintengine-repo-identity-gitdir-', async (dir) => {
    git(dir, ['init', '--quiet'])
    git(dir, ['remote', 'add', 'origin', 'git@github.com:acme/app.git'])
    const read = await readRepositoryIdentityRead(join(dir, '.git'))
    assert.deepEqual(read, { identity: null, settled: true })
  })
})
