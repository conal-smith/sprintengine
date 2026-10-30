import type { GitBranchSnapshot, GitGraphCommit, GitGraphOptions, GitGraphSnapshot, GitRef } from './git'
import { getGitHubRepoWebUrl } from './git-github'
import { runGit } from './git-utils'

export async function getGitBranches(repoRoot: string): Promise<GitBranchSnapshot> {
  // `lstrip=2`, not `short`: `short` keeps `heads/` on a branch that shares
  // its name with a tag, and that name is then shown and pushed as the branch.
  const branchOutput = await runGit(repoRoot, [
    'branch',
    '--format=%(refname:lstrip=2)%09%(HEAD)%09%(upstream:short)',
    '--sort=refname',
  ])
  const branches = branchOutput
    .split(/\r?\n/)
    .filter(Boolean)
    .map((line) => {
      const [name, head, upstream] = line.split('\t')
      return {
        name,
        current: head === '*',
        upstream: upstream || null,
      }
    })
  const current = branches.find((branch) => branch.current)?.name ?? null
  let ahead = 0
  let behind = 0

  try {
    const counts = await runGit(repoRoot, ['rev-list', '--left-right', '--count', 'HEAD...@{upstream}'])
    const [aheadText, behindText] = counts.trim().split(/\s+/)
    ahead = Number.parseInt(aheadText ?? '0', 10) || 0
    behind = Number.parseInt(behindText ?? '0', 10) || 0
  } catch {
    // Repositories without an upstream simply have no ahead/behind counts.
  }

  return { current, branches, ahead, behind }
}

async function collectGitRefs(repoRoot: string, headHash: string | null): Promise<GitRef[]> {
  const refsOutput = await runGit(repoRoot, [
    'for-each-ref',
    '--format=%(refname:short)%09%(objectname)%09%(refname)',
    'refs/heads',
    'refs/remotes',
    'refs/tags',
  ])
  const parsed = refsOutput
    .split(/\r?\n/)
    .filter(Boolean)
    .map((line): GitRef => {
      const [shortName = '', hash = '', fullRef = ''] = line.split('\t')
      // Branches and tags are named from their full ref: the short form of a
      // branch and a tag that share a name is `heads/<name>` and `tags/<name>`.
      const name = /^refs\/(?:heads|tags)\//u.test(fullRef)
        ? fullRef.replace(/^refs\/(?:heads|tags)\//u, '')
        : shortName
      const type = fullRef.startsWith('refs/heads/')
        ? 'head'
        : fullRef.startsWith('refs/remotes/')
          ? 'remote'
          : fullRef.startsWith('refs/tags/')
            ? 'tag'
            : 'other'
      return { name, hash, type }
    })

  return headHash ? [{ name: 'HEAD', hash: headHash, type: 'other' }, ...parsed] : parsed
}

function groupRefsByHash(refs: GitRef[]): Map<string, string[]> {
  const refsByHash = new Map<string, string[]>()
  refs.forEach((ref) => {
    const names = refsByHash.get(ref.hash) ?? []
    names.push(ref.name)
    refsByHash.set(ref.hash, names)
  })
  return refsByHash
}

/**
 * Reads commit history across branches, remotes, and tags (plus HEAD, so a
 * detached checkout still appears) with parent hashes so the renderer can lay
 * out a branch graph. We deliberately do not use `--all`: that also walks
 * refs/stash and refs/notes, which would surface stash WIP commits in the graph
 * with no ref label. `--date-order` keeps commits in commit date order while
 * guaranteeing no parent is emitted before its children, which the lane-layout
 * algorithm relies on. Paginated via skip/limit so a large history stays bounded.
 */
export async function getGitCommitGraph(repoRoot: string, options: GitGraphOptions = {}): Promise<GitGraphSnapshot> {
  const emptySnapshot: GitGraphSnapshot = {
    commits: [],
    refs: [],
    headHash: null,
    detached: false,
    totalCount: 0,
    hasMore: false,
    updatedAt: Date.now(),
  }

  try {
    const limit = Math.min(Math.max(Math.floor(options.limit ?? 200), 1), 2000)
    const skip = Math.max(Math.floor(options.skip ?? 0), 0)
    const githubRepoWebUrl = await getGitHubRepoWebUrl(repoRoot)

    const totalCount =
      Number.parseInt(
        (await runGit(repoRoot, ['rev-list', '--branches', '--remotes', '--tags', '--count', 'HEAD', '--'])).trim(),
        10,
      ) || 0

    let headHash: string | null = null
    try {
      headHash = (await runGit(repoRoot, ['rev-parse', 'HEAD'])).trim() || null
    } catch {
      headHash = null
    }

    let detached = false
    if (headHash) {
      try {
        await runGit(repoRoot, ['symbolic-ref', '-q', 'HEAD'])
        detached = false
      } catch {
        detached = true
      }
    }

    const refs = await collectGitRefs(repoRoot, headHash)
    const refsByHash = groupRefsByHash(refs)

    const stdout = await runGit(repoRoot, [
      'log',
      '--branches',
      '--remotes',
      '--tags',
      'HEAD',
      '--date-order',
      `--skip=${skip}`,
      `--max-count=${limit}`,
      '--date=format:%Y-%m-%d %H:%M',
      '--pretty=format:%H%x1f%h%x1f%an%x1f%ad%x1f%P%x1f%D%x1f%s%x1e',
      '--',
    ])

    const commits = stdout
      .split('\x1e')
      .map((record) => record.trim())
      .filter(Boolean)
      .map((record): GitGraphCommit => {
        const [hash = '', shortHash = '', author = '', date = '', parentsText = '', refsText = '', subject = ''] =
          record.split('\x1f')
        const decoratedRefs = refsText
          .split(',')
          .map((ref) => ref.trim())
          .filter(Boolean)
        const exactRefs = refsByHash.get(hash) ?? []
        return {
          hash,
          shortHash,
          author,
          date,
          parents: parentsText
            .split(' ')
            .map((parent) => parent.trim())
            .filter(Boolean),
          refs: [...new Set([...decoratedRefs, ...exactRefs])],
          subject,
          commitWebUrl: githubRepoWebUrl ? `${githubRepoWebUrl}/commit/${hash}` : null,
        }
      })

    return {
      commits,
      refs,
      headHash,
      detached,
      totalCount,
      hasMore: skip + commits.length < totalCount,
      updatedAt: Date.now(),
    }
  } catch {
    return emptySnapshot
  }
}
