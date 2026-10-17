// Where a branch is pushed when it is published under its own name: shared by
// the chat's Create PR push and the Git panel's Push, so both send a branch
// cut from `origin/main` to its own name rather than wherever it tracks.

/** A git command's trimmed output, or null when it failed. */
export type GitOutput = (cwd: string, args: string[]) => Promise<string | null>

export type GitPushTarget = { ok: true; remote: string; setUpstream: boolean } | { ok: false; message: string }

/**
 * The repository's trunk on origin: what `origin/HEAD` names (`originHead`,
 * read by the caller as `symbolic-ref --short refs/remotes/origin/HEAD`), else
 * `main` or `master` when origin has one.
 */
export async function originDefaultBranch(
  out: GitOutput,
  gitRoot: string,
  originHead: string | null,
): Promise<string | null> {
  if (originHead?.startsWith('origin/')) return originHead.slice('origin/'.length)
  for (const candidate of ['main', 'master']) {
    if (await out(gitRoot, ['rev-parse', '--verify', '--quiet', `refs/remotes/origin/${candidate}`])) return candidate
  }
  return null
}

/**
 * Where the branch is pushed, chosen as a plain `git push` chooses:
 * `branch.<b>.pushRemote` (origin included), then `remote.pushDefault`, then
 * the branch's own remote when it tracks its namesake there (a branch set up
 * on a fork as `fork/<b>`), then origin. A configured push remote that does
 * not exist is an error, as it is for git, never a quiet push to origin.
 *
 * `setUpstream` only for a branch that tracks nothing yet or tracks the
 * trunk (cut from `origin/main`), and pushed where no setting sent it: a
 * branch configured to push elsewhere keeps the upstream it was given.
 */
export async function gitPushTarget(
  out: GitOutput,
  gitRoot: string,
  branch: string,
  defaultBranch: string | null,
): Promise<GitPushTarget> {
  for (const key of [`branch.${branch}.pushRemote`, 'remote.pushDefault']) {
    const named = await out(gitRoot, ['config', '--get', key])
    if (!named) continue
    // The setting comes from the repository's own config, which may have
    // arrived with the folder or been written by an agent, and the remote it
    // names is handed to `git push` as an argument. A value that starts with a
    // dash would be read there as an option (`--receive-pack=<program>` runs
    // that program), and no remote or URL a person means starts with one.
    if (named.startsWith('-')) {
      return {
        ok: false,
        message: `Git is set to push this branch to “${named}” (${key}), which is not a remote name or address. Change the setting, then push again.`,
      }
    }
    // A URL in the setting is a remote too, for git.
    if ((await out(gitRoot, ['remote', 'get-url', '--push', named])) || /[:/]/u.test(named)) {
      return { ok: true, remote: named, setUpstream: false }
    }
    return {
      ok: false,
      message: `Git is set to push this branch to “${named}” (${key}), and this checkout has no remote of that name. Add the remote or change the setting, then push again.`,
    }
  }
  const [upstreamRemote, upstreamMerge] = await Promise.all([
    out(gitRoot, ['config', '--get', `branch.${branch}.remote`]),
    out(gitRoot, ['config', '--get', `branch.${branch}.merge`]),
  ])
  if (
    upstreamRemote &&
    upstreamRemote !== '.' &&
    upstreamMerge === `refs/heads/${branch}` &&
    (await out(gitRoot, ['remote', 'get-url', '--push', upstreamRemote]))
  ) {
    return { ok: true, remote: upstreamRemote, setUpstream: false }
  }
  const tracksTrunk =
    upstreamRemote === 'origin' && defaultBranch !== null && upstreamMerge === `refs/heads/${defaultBranch}`
  return { ok: true, remote: 'origin', setUpstream: !upstreamMerge || tracksTrunk }
}
