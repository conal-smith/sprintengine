// What the Git panel's "Write commit message" is written from, read in the
// main process: the staged diff, its summary, the repository's recent
// subjects and the branch. Staged, because that is exactly what the panel's
// Commit commits — its checkboxes are the index, and `commitGitChanges` runs
// `git commit` on the index alone.
//
// Every read is a bounded git call through the shared runner: arguments as an
// array, never a shell string, the read deadline, and the host routing that
// sends a folder inside a WSL distribution to that distribution's git. The
// diffs run with external diff drivers and textconv off, because both are
// programs a repository's own config names, and a draft must not run them.

import type { CommitMessageInput } from '../shared/text-generation/commit-message'
import { followsConventionalCommits, type TextGenerationWritingStyle } from '../shared/text-generation/writing-style'
import { runGitCommand } from './git-utils'
import { branchNameFromHeadRef, HEAD_BRANCH_REF_ARGS } from './git-head-branch'

export type CommitMessageDraftInputOutcome = { ok: true; input: CommitMessageInput } | { ok: false; message: string }

/** How much of the staged diff is read; the prompt cuts it again. */
const MAX_PATCH_READ_CHARS = 60_000
const MAX_DIFF_STAT_READ_CHARS = 16_000
/** Enough history to tell whether it keeps Conventional Commits (`followsConventionalCommits` wants ten). */
const HISTORY_DEPTH = 30

const DIFF_FLAGS = ['--cached', '--no-color', '--no-ext-diff', '--no-textconv']

export async function readCommitMessageDraftInput(
  repoRoot: string,
  style: TextGenerationWritingStyle,
  deps: { git?: typeof runGitCommand } = {},
): Promise<CommitMessageDraftInputOutcome> {
  const git = deps.git ?? runGitCommand
  const out = async (args: string[]): Promise<string | null> => {
    const result = await git(repoRoot, args).catch(() => null)
    return result?.ok ? result.stdout : null
  }
  const [diffStat, patch, history, branch] = await Promise.all([
    out(['diff', ...DIFF_FLAGS, '--stat']),
    out(['diff', ...DIFF_FLAGS]),
    // A repository with no commits yet has no history to read: an empty list.
    out(['log', `-${HISTORY_DEPTH}`, '--no-merges', '--format=%s']),
    out([...HEAD_BRANCH_REF_ARGS]),
  ])
  if (diffStat === null) return { ok: false, message: 'Git could not read the staged changes.' }
  if (!diffStat.trim()) return { ok: false, message: 'Nothing is staged to commit.' }
  const subjects = (history ?? '').split('\n').filter((subject) => subject.trim())
  return {
    ok: true,
    input: {
      branch: branchNameFromHeadRef(branch),
      diffStat: diffStat.slice(0, MAX_DIFF_STAT_READ_CHARS),
      // A diff past git's own output limit comes back as null: the summary
      // alone still says what changed, and the prompt says the diff is missing.
      patch: (patch ?? '').slice(0, MAX_PATCH_READ_CHARS),
      recentSubjects: subjects,
      conventionalCommits: followsConventionalCommits(subjects),
      style,
    },
  }
}
