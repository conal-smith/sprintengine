import { createHash } from 'node:crypto'
import { cp, mkdir, mkdtemp, rm, stat } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'

import type { ArtifactsCheck, ArtifactsRepository } from '../../shared/artifacts'
import type { GitCommandResult } from '../git'
import { tokenCredentialGit } from '../git-clone'
import type { GitRunOptions } from '../git-run'

// Where the artifacts site's source is kept while Studio changes it: a clone
// of a git repository, or (for a Cloudflare project with no repository) a
// folder in Studio's data folder.
//
// A git store is the one way anything is written to the repository: bring the
// clone to the remote's main, make the change, commit, push. The commit
// history is the record of every publish, edit and removal.
//
// Two publishes can race: another Studio, or a second agent here. Here they
// queue, one change at a time per store. Across machines the push of the one
// that lost is refused as not a fast-forward, and the change is then made
// again on the new tip and pushed again, a few times before giving up. Making
// it again rather than rebasing the commit is what keeps the manifest right:
// it is rebuilt from the records each time (artifact-site.ts), where a rebase
// would stop on both sides having edited it. Anything a failed attempt left in
// the clone (a half-written manifest, an unpushed commit) is thrown away by the
// next attempt's reset to the remote, so it never reaches anyone.
//
// Signing in is the app's own way to a git host (git-clone.ts): for an https
// remote, the token the app holds for that host (the saved GitHub token for
// github.com, otherwise the one `gh` holds for the host, a GitHub Enterprise
// Server included), handed to git through an inline helper and the child's
// environment, never written into the clone's config or a remote URL. Without
// one, and for ssh, git uses the person's own credential helper or keys, as
// their own push would.

export type ArtifactsGit = (
  cwd: string,
  args: string[],
  env?: NodeJS.ProcessEnv,
  options?: GitRunOptions,
) => Promise<GitCommandResult>

export type ArtifactsChange<T> = (dir: string) => Promise<{ message: string; value: T } | { failure: string } | null>

/**
 * What runs once a change is kept, still in the store's queue, on the tree as
 * it was kept: a host's upload. It answers null, or why it failed; the change
 * stays kept either way.
 */
export type ArtifactsAfterChange = (dir: string, commit: string | null) => Promise<string | null>

export type ArtifactsChangeResult<T> =
  { ok: true; value: T | null; commit: string | null; afterFailure?: string } | { ok: false; message: string }

export type ArtifactsStore = {
  /** What the store is, for messages: `acme/artifacts on github.com`, or `this machine`. */
  readonly label: string
  readonly dir: string
  /** Read the source, brought up to date first unless it was a moment ago. Offline, it reads what it has. */
  read<T>(
    work: (dir: string) => Promise<T>,
  ): Promise<{ ok: true; value: T; stale: boolean } | { ok: false; message: string }>
  /**
   * Make a change and keep it. `work` runs on a clean tree at the latest
   * source, and may run more than once; it answers the commit message and a
   * value, null when there is nothing to do, or a failure to stop with.
   */
  change<T>(work: ArtifactsChange<T>, after?: ArtifactsAfterChange): Promise<ArtifactsChangeResult<T>>
  /** The checks Settings' Test runs: reachable, and pushable, without writing anything. */
  test(): Promise<ArtifactsCheck[]>
  /** Run work in the store's queue, so nothing changes the source meanwhile. */
  exclusive<T>(work: () => Promise<T>): Promise<T>
}

export type GitStoreDeps = {
  git: ArtifactsGit
  /** A token for an https host, or '' when the app holds none for it. */
  resolveHostToken: (host: string) => Promise<string>
  /** How long to wait before trying again after a refused push; jittered so two racers part. */
  retryDelayMs?: (attempt: number) => number
}

const PUSH_ATTEMPTS = 5
const READ_FRESH_MS = 15_000
/** The branch a push check names. It is never created: the check is a dry run. */
const PUSH_CHECK_REF = 'refs/heads/studio-artifacts-push-check'

class StoreError extends Error {}

function lastLines(result: GitCommandResult): string {
  return `${result.stderr}\n${result.message ?? ''}`
    .split('\n')
    .map((part) => part.trim())
    .filter((part) => part && !part.startsWith('hint:'))
    .slice(-2)
    .join(' ')
}

/** What a failed git said, in words that say what to do. Never the remote's credentials: there are none in it. */
export function describeGitFailure(label: string, what: string, result: GitCommandResult): string {
  const text = `${result.stderr}\n${result.message ?? ''}`
  if (/tell me who you are|unable to auto-detect email/i.test(text)) {
    return (
      `git has no name and email to commit to ${label} with. Set them once with ` +
      '`git config --global user.name "…"` and `git config --global user.email "…"`.'
    )
  }
  if (/Permission denied \(publickey|Host key verification failed/i.test(text)) {
    return `${label} refused this machine’s SSH key. Load it with \`ssh-add\` and check it has write access, or use the https address.`
  }
  if (
    /Authentication failed|could not read Username|could not read Password|terminal prompts disabled|\b40[13]\b|Permission to .* denied|Repository not found|not found|does not appear to be a git repository/i.test(
      text,
    )
  ) {
    return (
      `${label} refused to ${what}: it does not exist, or this machine is not signed in with access to it. ` +
      'Sign in to the host with `gh auth login --hostname <host>` (or add a token in Settings ▸ Version control for github.com), with an account that can push to it.'
    )
  }
  if (/Could not resolve host|unable to access|Failed to connect|timed out|Connection refused/i.test(text)) {
    return `Could not reach ${label} to ${what}. Check the network and try again.`
  }
  return `git could not ${what} ${label}: ${lastLines(result) || 'it failed without saying why.'}`
}

function isRefusedPush(result: GitCommandResult): boolean {
  return /\[rejected\]|non-fast-forward|fetch first|stale info|failed to push some refs|cannot lock ref/i.test(
    `${result.stderr}\n${result.stdout}\n${result.message ?? ''}`,
  )
}

async function exists(path: string): Promise<boolean> {
  return stat(path).then(
    () => true,
    () => false,
  )
}

/**
 * One queue per folder, shared by every store on it: Settings' Test builds a
 * host of its own for the fields on screen, and its store must wait for a
 * publish the live one is making in the same clone rather than reset the tree
 * under it.
 */
const queues = new Map<string, Promise<unknown>>()

function queueOf(dir: string): <T>(work: () => Promise<T>) => Promise<T> {
  return <T>(work: () => Promise<T>): Promise<T> => {
    const run = (queues.get(dir) ?? Promise.resolve()).then(work, work)
    const tail = run.catch(() => undefined)
    queues.set(dir, tail)
    void tail.then(() => {
      if (queues.get(dir) === tail) queues.delete(dir)
    })
    return run
  }
}

/** The clone's folder: named for the repository and its address, so two remotes never share one. */
export function gitStoreDir(checkoutRoot: string, repository: ArtifactsRepository): string {
  const digest = createHash('sha256').update(repository.remoteUrl).digest('hex').slice(0, 10)
  return join(checkoutRoot, `${repository.owner}--${repository.name}--${digest}`.toLowerCase())
}

export function repositoryLabel(repository: ArtifactsRepository): string {
  return repository.host
    ? `${repository.owner}/${repository.name} on ${repository.host}`
    : `${repository.owner}/${repository.name}`
}

export function createGitStore(input: {
  repository: ArtifactsRepository
  /** The folder clones are kept under, in Studio's data folder. */
  checkoutRoot: string
  deps: GitStoreDeps
}): ArtifactsStore {
  const { repository, deps } = input
  const label = repositoryLabel(repository)
  const dir = gitStoreDir(input.checkoutRoot, repository)
  const remote = repository.remoteUrl
  const delay = deps.retryDelayMs ?? ((attempt) => 300 * attempt + Math.floor(Math.random() * 400))
  const serialized = queueOf(dir)
  let syncedAt = 0

  /** git with the app's sign-in for the remote's host, when it holds one. */
  const signedIn = async (cwd: string, args: string[], options?: GitRunOptions): Promise<GitCommandResult> => {
    const env: NodeJS.ProcessEnv = {}
    // An ssh remote with no agent-loaded key would ask for a passphrase nobody can see.
    if (repository.transport === 'ssh' && !process.env.GIT_SSH_COMMAND) env.GIT_SSH_COMMAND = 'ssh -oBatchMode=yes'
    const token =
      repository.transport === 'https' ? (await deps.resolveHostToken(repository.host).catch(() => '')).trim() : ''
    if (!token) return deps.git(cwd, args, env, options)
    const credential = tokenCredentialGit(repository.host, token)
    return deps.git(cwd, [...credential.args, ...args], { ...env, ...credential.env }, options)
  }

  const must = async (result: Promise<GitCommandResult>, what: string): Promise<GitCommandResult> => {
    const done = await result
    if (!done.ok) throw new StoreError(describeGitFailure(label, what, done))
    return done
  }

  const ensureClone = async (): Promise<void> => {
    if (await exists(join(dir, '.git'))) return
    await mkdir(dirname(dir), { recursive: true })
    await rm(dir, { recursive: true, force: true })
    await must(
      signedIn(dirname(dir), ['clone', '--no-tags', '--quiet', '--', remote, dir], { kind: 'network' }),
      'clone',
    )
  }

  /** The clone at the remote's main, clean; on an empty remote, an empty main with no commits. */
  const sync = async (): Promise<void> => {
    await ensureClone()
    await must(signedIn(dir, ['fetch', '--no-tags', '--prune', '--quiet', 'origin']), 'fetch from')
    const remoteMain = await deps.git(dir, ['rev-parse', '--verify', '--quiet', 'refs/remotes/origin/main'])
    if (remoteMain.ok && remoteMain.stdout.trim()) {
      await must(
        deps.git(dir, ['checkout', '--quiet', '--force', '-B', 'main', 'refs/remotes/origin/main']),
        'check out',
      )
      await must(deps.git(dir, ['reset', '--quiet', '--hard', 'refs/remotes/origin/main']), 'reset')
    } else {
      // Nothing published yet: main is born with the first change.
      await deps.git(dir, ['update-ref', '-d', 'refs/heads/main'])
      await must(deps.git(dir, ['symbolic-ref', 'HEAD', 'refs/heads/main']), 'prepare')
      await must(deps.git(dir, ['read-tree', '--empty']), 'prepare')
    }
    await must(deps.git(dir, ['clean', '-fdxq']), 'clean')
    syncedAt = Date.now()
  }

  return {
    label,
    dir,
    exclusive: serialized,
    read(work) {
      return serialized(async () => {
        let stale = false
        try {
          if (Date.now() - syncedAt > READ_FRESH_MS) await sync()
        } catch (error) {
          // Offline, or the host said no: what the clone already has is still an answer.
          if (!(await exists(join(dir, '.git')))) {
            return { ok: false as const, message: error instanceof Error ? error.message : String(error) }
          }
          stale = true
        }
        return { ok: true as const, value: await work(dir), stale }
      })
    },
    change(work, after) {
      const kept = async <T>(value: T | null, commit: string | null): Promise<ArtifactsChangeResult<T>> => {
        const afterFailure = after ? await after(dir, commit).catch((error: unknown) => String(error)) : null
        return { ok: true, value, commit, ...(afterFailure ? { afterFailure } : {}) }
      }
      const headCommit = async (): Promise<string | null> => {
        const head = await deps.git(dir, ['rev-parse', '--verify', '--quiet', 'HEAD'])
        return head.ok ? head.stdout.trim() || null : null
      }
      return serialized(async () => {
        try {
          for (let attempt = 1; ; attempt += 1) {
            await sync()
            const made = await work(dir)
            if (made === null) {
              await must(deps.git(dir, ['reset', '--quiet', '--hard']), 'reset')
              await must(deps.git(dir, ['clean', '-fdxq']), 'clean')
              return await kept(null, await headCommit())
            }
            if ('failure' in made) return { ok: false as const, message: made.failure }
            await must(deps.git(dir, ['add', '--all']), 'stage')
            const status = await must(deps.git(dir, ['status', '--porcelain']), 'read')
            if (!status.stdout.trim()) return await kept(made.value, await headCommit())
            await must(
              deps.git(dir, ['commit', '--quiet', '--no-verify', '-m', made.message], undefined, { timeoutMs: 60_000 }),
              'commit to',
            )
            // No pre-push hook: the person's own (a global hooksPath) would
            // run with the sign-in in its environment.
            const pushed = await signedIn(dir, ['push', '--quiet', '--no-verify', 'origin', 'HEAD:refs/heads/main'], {
              kind: 'network',
            })
            if (pushed.ok) {
              syncedAt = Date.now()
              return await kept(made.value, await headCommit())
            }
            if (!isRefusedPush(pushed) || attempt >= PUSH_ATTEMPTS) {
              throw new StoreError(
                isRefusedPush(pushed)
                  ? `${label} kept moving while this was published (${PUSH_ATTEMPTS} tries). Try again in a moment.`
                  : describeGitFailure(label, 'take the push', pushed),
              )
            }
            await new Promise((resolve) => setTimeout(resolve, delay(attempt)))
          }
        } catch (error) {
          // The clone is reset before it is next used; it may hold a commit that never left.
          syncedAt = 0
          return { ok: false as const, message: error instanceof Error ? error.message : String(error) }
        }
      })
    },
    async test() {
      const checks: ArtifactsCheck[] = []
      await mkdir(dirname(dir), { recursive: true })
      const listed = await signedIn(dirname(dir), ['ls-remote', '--heads', '--', remote], { kind: 'network' }).catch(
        (error: unknown) =>
          ({ ok: false, stdout: '', stderr: String(error), message: String(error) }) as GitCommandResult,
      )
      if (!listed.ok) {
        checks.push({ label: 'Repository', status: 'fail', detail: describeGitFailure(label, 'be read', listed) })
        return checks
      }
      const hasMain = /\trefs\/heads\/main$/m.test(listed.stdout)
      const hasBranches = listed.stdout.trim() !== ''
      checks.push({
        label: 'Repository',
        status: 'pass',
        detail: hasMain
          ? `${label} is reachable, with a main branch.`
          : hasBranches
            ? `${label} is reachable. It has no main branch yet: the first publish starts one, and its other branches are left alone.`
            : `${label} is reachable; it is empty, and the first publish sets it up.`,
      })
      // A dry-run push of a throwaway commit: the host checks the right to
      // push, and nothing is sent or created.
      const probe = await mkdtemp(join(tmpdir(), 'artifacts-push-check-'))
      try {
        await must(deps.git(probe, ['init', '--quiet']), 'prepare a check for')
        await must(
          deps.git(probe, [
            '-c',
            'user.name=Studio',
            '-c',
            'user.email=studio@localhost',
            'commit',
            '--quiet',
            '--allow-empty',
            '--no-verify',
            '--no-gpg-sign',
            '-m',
            'push check',
          ]),
          'prepare a check for',
        )
        const pushed = await signedIn(probe, ['push', '--dry-run', '--quiet', '--', remote, `HEAD:${PUSH_CHECK_REF}`], {
          kind: 'network',
        })
        checks.push(
          pushed.ok
            ? { label: 'Push', status: 'pass', detail: 'This machine may push to it (checked without pushing).' }
            : { label: 'Push', status: 'fail', detail: describeGitFailure(label, 'take a push', pushed) },
        )
      } catch (error) {
        checks.push({ label: 'Push', status: 'fail', detail: error instanceof Error ? error.message : String(error) })
      } finally {
        await rm(probe, { recursive: true, force: true })
      }
      return checks
    },
  }
}

/**
 * The site kept in a folder on this machine, for a Cloudflare project with no
 * repository: no history, and the source exists only here. Changes still
 * queue, and a change that fails part-way is undone from a copy taken first,
 * so a half-written manifest is never what the next upload reads.
 */
export function createLocalStore(input: {
  dir: string
  /**
   * Bring the copy up to date before it is used (a Cloudflare site's copy,
   * from the live site): null, or why it could not be. Runs in the queue.
   */
  prepare?: (dir: string) => Promise<string | null>
}): ArtifactsStore {
  const { dir } = input
  const serialized = queueOf(dir)
  const backup = `${dir}.before-change`
  /** A copy left by a change the app did not live to finish is the last good site: put it back. */
  const recover = async (): Promise<void> => {
    if (await exists(backup)) {
      await rm(dir, { recursive: true, force: true })
      await cp(backup, dir, { recursive: true })
      await rm(backup, { recursive: true, force: true })
    }
    await mkdir(dir, { recursive: true })
  }
  return {
    label: 'this machine',
    dir,
    exclusive: serialized,
    read(work) {
      return serialized(async () => {
        await recover()
        // A copy that is behind is still an answer; only no answer is a failure.
        const failed = input.prepare ? await input.prepare(dir).catch((error: unknown) => String(error)) : null
        return { ok: true as const, value: await work(dir), stale: failed !== null }
      })
    },
    change(work, after) {
      return serialized(async () => {
        await recover()
        const failed = input.prepare ? await input.prepare(dir).catch((error: unknown) => String(error)) : null
        if (failed) return { ok: false as const, message: failed }
        await cp(dir, backup, { recursive: true })
        const restore = async () => {
          await rm(dir, { recursive: true, force: true })
          await cp(backup, dir, { recursive: true })
        }
        try {
          const made = await work(dir)
          if (made !== null && 'failure' in made) {
            await restore()
            return { ok: false as const, message: made.failure }
          }
          await rm(backup, { recursive: true, force: true })
          const afterFailure = after ? await after(dir, null).catch((error: unknown) => String(error)) : null
          return {
            ok: true as const,
            value: made?.value ?? null,
            commit: null,
            ...(afterFailure ? { afterFailure } : {}),
          }
        } catch (error) {
          await restore()
          return { ok: false as const, message: error instanceof Error ? error.message : String(error) }
        } finally {
          await rm(backup, { recursive: true, force: true })
        }
      })
    },
    async test() {
      return [
        {
          label: 'Source',
          status: 'warn',
          detail: 'Kept on this machine only, with no history: add a repository to keep it elsewhere too.',
        },
      ]
    },
  }
}
