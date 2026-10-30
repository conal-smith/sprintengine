/**
 * Reading which branch HEAD is on.
 *
 * `symbolic-ref --short HEAD` and `rev-parse --abbrev-ref HEAD` shorten the
 * ref only as far as it stays unambiguous, so a branch that shares its name
 * with a tag comes back as `heads/<name>`, and that string is then shown, pushed
 * and compared as though it were the branch. The full ref has no such case:
 * every reader asks for it and strips the prefix itself.
 */

/** `symbolic-ref` names the branch even on an unborn HEAD, and fails on a detached one. */
export const HEAD_BRANCH_REF_ARGS = ['symbolic-ref', '--quiet', 'HEAD'] as const

/** The branch a full HEAD ref names, or null when it names none. */
export function branchNameFromHeadRef(stdout: string | null | undefined): string | null {
  const ref = (stdout ?? '').trim().split(/\r?\n/, 1)[0] ?? ''
  return ref.startsWith('refs/heads/') && ref.length > 'refs/heads/'.length ? ref.slice('refs/heads/'.length) : null
}
