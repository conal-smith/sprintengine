import { withNeutralRepoPrograms } from './git-run'
import { copyFile, mkdtemp, readFile, rm, stat, utimes } from 'fs/promises'
import { tmpdir } from 'os'
import { isAbsolute, join, resolve } from 'path'

import { parseNumstatZ, readBranchFacts, scopeOfFacts } from './git-branch-span'
import { isInsideRepo, runGitCommand } from './git-utils'
import type {
  BranchStep,
  BranchStepDiff,
  BranchStepFile,
  BranchStepSelection,
  BranchStepsSnapshot,
  RevFileResult,
} from '../shared/electron-api'

/**
 * The branch's commits as steps, and the diff of any one of them
 * (the-diff-an-agent-made / changed-files-and-commit-steps).
 *
 * A step is a COMMIT, not a captured turn. The timeline is the branch's own
 * history, so it survives a restart, a re-clone and a machine change, needs
 * nothing recorded as it happens, and cannot be inflated by a pull — the three
 * properties the retired checkpoint timeline could not offer.
 *
 * Read live on every request and never cached: a rebase or an amend
 * re-identifies commits, and a cached strip would then be confidently wrong
 * about work that no longer exists under those hashes.
 */

/** Untracked files bigger than this are listed without a line count. */
const UNTRACKED_COUNT_LIMIT_BYTES = 1_000_000

/**
 * Above this many untracked files the uncommitted reading lists them as new
 * without looking for files they were moved from (`readPairingMoves`): a build
 * output nobody ignored would otherwise cost a copy of the index and a `git add`
 * of every one of its files on each read.
 */
const RENAME_PAIRING_MAX_UNTRACKED = 300

/** A blob bigger than this is reported as too large rather than sent to Monaco. */
const REV_FILE_MAX_BYTES = 5 * 1024 * 1024

/**
 * What a commit hash must look like before it is handed to git.
 *
 * This is not paranoia about a hostile renderer; it is the difference between a
 * positional argument and an OPTION. `git show` accepts `--output=<file>`, and
 * an unvalidated hash sits in exactly that argv slot — a review confirmed
 * `{ kind: 'commit', hash: '--output=/somewhere' }` writing a file from main.
 * The same pattern and the same reasoning are already in `git-branch-actions.ts`
 * (COMMIT_HASH_PATTERN) and `git-worktree-validation.ts`; these handlers are new
 * and had simply not adopted it.
 */
const COMMIT_HASH_PATTERN = /^[0-9a-f]{7,40}$/i

/** Anything git could read as an option, wherever a value is expected. */
function looksLikeOption(value: string): boolean {
  return value.startsWith('-')
}

/**
 * Field separator inside one `git log` record. A commit subject may contain
 * tabs, newlines and anything else a person can type, so the separator has to
 * be something git emits only on request: US (unit separator), written into the
 * format string as `%x1f` and split on here.
 */
const FIELD = '\u001f'

type NameStatusEntry = { path: string; status: BranchStepFile['status']; oldPath?: string }

/**
 * The steps between the branch's base and HEAD, OLDEST FIRST — the order the
 * work happened in, which is the order a person reads it.
 *
 * A checkout with no base (detached, unborn, no default branch to compare
 * against) has no commits it can call its own, so it reports none. That is not
 * an error: the uncommitted step still carries whatever is in the tree.
 */
export function listBranchSteps(cwd: string): Promise<BranchStepsSnapshot> {
  // The app's own read: an untrusted repository's programs stay off (git-run.ts).
  return withNeutralRepoPrograms(() => listBranchStepsUnscoped(cwd))
}

async function listBranchStepsUnscoped(cwd: string): Promise<BranchStepsSnapshot> {
  // Facts, not the whole span: this needs branch/base/worktree and none of the
  // numstat, and reading the span here ran a full `git diff` that was discarded.
  const facts = await readBranchFacts(cwd)
  if (!facts) {
    return { branch: null, baseOid: null, scope: 'folder', steps: [], hasUncommitted: false }
  }

  // The shared rule, not a local copy: the row renders the same reading and must
  // say the same thing about it.
  const scope = scopeOfFacts(facts)

  const steps = facts.baseOid && facts.aheadOfBase ? await readLog(cwd, facts.baseOid) : []

  // "Anything at all in the working tree", tracked or not — the uncommitted
  // step must appear for a brand-new file, which `diff` alone cannot see.
  const dirty = await runGitCommand(cwd, ['status', '--porcelain', '-z', '--untracked-files=all'])
  const hasUncommitted = dirty.ok && dirty.stdout.trim().length > 0

  return {
    branch: facts.branch,
    baseOid: facts.baseOid,
    // The row clamps to `folder` when it could not read its diff, and the two
    // surfaces must not disagree about what they may claim. A checkout whose
    // `git status` fails has no readable working tree at all — a bare repo, a
    // locked index — so it claims nothing here either.
    scope: dirty.ok ? scope : 'folder',
    steps,
    hasUncommitted,
  }
}

async function readLog(cwd: string, baseOid: string): Promise<BranchStep[]> {
  const result = await runGitCommand(cwd, [
    'log',
    '--reverse',
    '--no-color',
    '--format=%H%x1f%h%x1f%at%x1f%P%x1f%s',
    '-z',
    `${baseOid}..HEAD`,
  ])
  if (!result.ok) return []
  return result.stdout
    .split('\0')
    .map((record) => record.trim())
    .filter(Boolean)
    .map((record) => {
      const [hash, shortHash, at, parents, ...subject] = record.split(FIELD)
      const seconds = Number.parseInt(at ?? '', 10)
      return {
        hash: hash ?? '',
        shortHash: shortHash ?? '',
        // Rejoined: a subject that somehow contains the separator would
        // otherwise be truncated at it. An empty subject is legal and stays so.
        subject: subject.join(FIELD),
        authoredAt: Number.isFinite(seconds) ? seconds * 1000 : 0,
        // More than one parent. The step still shows a diff — what the merge
        // brought in — and the flag is what lets the strip say so.
        isMerge: (parents ?? '').trim().split(/\s+/).filter(Boolean).length > 1,
      }
    })
    .filter((step) => step.hash.length > 0)
}

/**
 * The diff for one selection.
 *
 * - `span` — `merge-base → working tree`: everything the branch has produced,
 *   counted once even where several commits touched one file. Untracked files
 *   are NOT included here, deliberately: the span has to agree file-for-file
 *   with the sidebar row's number for the same checkout, and the row reads
 *   `git diff` — which is structurally blind to content git has never tracked.
 *   Two surfaces claiming to show one span while disagreeing about its size is a
 *   bug a person sees immediately; a new file still has its own home, one chip
 *   to the left, in the uncommitted step.
 * - `commit` — that commit alone. `git show` rather than `<hash>^ <hash>` so a
 *   ROOT commit (which has no parent to diff against) reports its whole tree as
 *   added instead of failing outright.
 *
 *   **Merges show what they brought IN** — git's first-parent reading, verified
 *   rather than assumed: an earlier version of this comment claimed a merge
 *   reports nothing, and the test proved otherwise. Bringing the default branch
 *   into a feature branch is a real event on that branch and a person stepping
 *   through should see it, so it is reported and the step is flagged `isMerge`
 *   for the UI to label. The SPAN is unaffected either way, because the
 *   merge-base moves with it — which is the property the whole model rests on.
 * - `uncommitted` — `HEAD → working tree`, plus untracked files, which `diff`
 *   cannot see because git has never tracked their content.
 */
export function diffBranchSelection(cwd: string, selection: BranchStepSelection): Promise<BranchStepDiff> {
  // The app's own read: an untrusted repository's programs stay off (git-run.ts).
  return withNeutralRepoPrograms(() => diffBranchSelectionUnscoped(cwd, selection))
}

async function diffBranchSelectionUnscoped(cwd: string, selection: BranchStepSelection): Promise<BranchStepDiff> {
  if (selection.kind === 'commit') {
    // The hash reaches argv as a POSITIONAL, which is also where git looks for
    // options — see COMMIT_HASH_PATTERN above. An unusable one is an empty diff,
    // not a git invocation.
    if (!COMMIT_HASH_PATTERN.test(selection.hash)) return totals([])
    const base = [
      'show',
      '--format=',
      '--no-color',
      '--no-ext-diff',
      '--no-textconv',
      // A workspace can be opened on a SUBDIRECTORY of its repo, where the
      // user's `diff.relative=true` would both under-count and hand back
      // cwd-relative paths no other surface here agrees with.
      '--no-relative',
      // `-m --first-parent` for BOTH readings, and this pair is load-bearing on
      // a merge: `--numstat` alone already gives the first-parent diff, but
      // `--name-status` alone gives a COMBINED diff, which for an ordinary merge
      // is EMPTY. Without this every file a merge brought in fell through to the
      // leftover branch of combine() and was labelled "Modified" — an added file
      // shown as modified, a deleted one too. Verified against real git.
      '-m',
      '--first-parent',
      selection.hash,
    ]
    return combine(
      (await numstat(cwd, [...base, '--numstat', '-z'])) ?? new Map(),
      (await nameStatus(cwd, [...base, '--name-status', '-z'])) ?? [],
    )
  }

  // Both working-tree selections measure from what the facts say — which is
  // git's empty tree on an unborn HEAD, where `git diff HEAD` fails outright and
  // the pane would show nothing while the sidebar row showed the staged work.
  const facts = await readBranchFacts(cwd)
  const from =
    selection.kind === 'uncommitted'
      ? // The tail is HEAD → working tree, except on an unborn HEAD where there
        // is no HEAD to diff and the empty tree is the only honest start.
        ((facts?.hasHead === false ? facts.diffFrom : 'HEAD') ?? 'HEAD')
      : (facts?.diffFrom ?? 'HEAD')
  // `diff-index`, which never writes the index, where `git diff` rewrites it
  // for a file whose stat data alone moved (git-branch-span.ts, `diffFlags`).
  // Its status pass names such a file as modified with no change to count, so
  // only the files the counts list are kept. `-M`: it finds no renames unless asked.
  const base = ['diff-index', '--no-color', '--no-ext-diff', '--no-textconv', '--no-relative', '-M', from]
  if (selection.kind !== 'uncommitted') return (await readTracked(cwd, base)) ?? totals([])
  const untracked = await listUntracked(cwd)
  const paired = from === 'HEAD' && untracked ? await readPairingMoves(cwd, base, untracked) : null
  return withUntracked(cwd, paired ?? (await readTracked(cwd, base)) ?? totals([]), untracked ?? [])
}

/**
 * The tracked half of a working-tree reading. Read through a copied index
 * (`env`), a failure is null, so the caller can read the plain way instead.
 */
async function readTracked(cwd: string, base: string[], env?: NodeJS.ProcessEnv): Promise<BranchStepDiff | null> {
  const counts = await numstat(cwd, [...base, '--numstat', '-z', '--'], env)
  const statuses = await nameStatus(cwd, [...base, '--name-status', '-z', '--'], env)
  if (env && (!counts || !statuses)) return null
  const known = counts ?? new Map<string, { additions: number; deletions: number }>()
  return combine(
    known,
    (statuses ?? []).filter((entry) => known.has(entry.path)),
  )
}

/**
 * The uncommitted reading with each file moved without `git mv` read as one
 * rename. Git pairs a deleted path with an added one only when both are in the
 * index, and an untracked file is not, so a plain `mv a.ts b.ts` read as a.ts
 * deleted and an unrelated b.ts new. The untracked files are added to a COPY of
 * the index as intent-to-add entries (`git add -N`, which records the path and
 * none of its content), and the same diff is read through the copy. The
 * person's own index is never written: every git here runs on the copy, with
 * optional locks off. Null on any failure, and the caller reads the plain way.
 */
async function readPairingMoves(
  cwd: string,
  base: string[],
  untracked: readonly string[],
): Promise<BranchStepDiff | null> {
  // A directory entry is an embedded repository, which `add` would record as a
  // gitlink; it stays a plain new path, added after.
  const files = untracked.filter((path) => !path.endsWith('/'))
  if (files.length === 0 || files.length > RENAME_PAIRING_MAX_UNTRACKED) return null
  const gitPath = await runGitCommand(cwd, ['rev-parse', '--git-path', 'index'])
  if (!gitPath.ok || !gitPath.stdout.trim()) return null
  const source = resolve(cwd, gitPath.stdout.trim())
  const temp = await mkdtemp(join(tmpdir(), 'branch-steps-index-')).catch(() => null)
  if (!temp) return null
  const index = join(temp, 'index')
  const env = { GIT_INDEX_FILE: index, GIT_OPTIONAL_LOCKS: '0' }
  try {
    const info = await stat(source)
    await copyFile(source, index)
    // The copy keeps the original's mtime: git judges an entry racily clean by
    // comparing it with the index file's own, and a fresh one would trust stale
    // stat data for a file changed in the same second the index was written.
    await utimes(index, info.atime, info.mtime)
    // `:(top,literal)`: the paths are repo-root-relative (`--full-name`) while
    // cwd may be a subdirectory, and a name with `*` in it is a name. The copy
    // is written whole, never as a split index: a split write under the
    // repository's `core.splitIndex` expires shared index files by age,
    // the one the repository's own index uses among them. Preloading is off:
    // it matches every tracked entry against the pathspec, over threads, to
    // stat the ones it names, and every path here is untracked, so on a large
    // repository that is CPU spent finding nothing in a copy thrown away next.
    const added = await runGitCommand(
      cwd,
      [
        '-c',
        'core.splitIndex=false',
        '-c',
        'splitIndex.sharedIndexExpire=never',
        '-c',
        'core.preloadIndex=false',
        'add',
        '--intent-to-add',
        '--',
        ...files.map((path) => `:(top,literal)${path}`),
      ],
      env,
    )
    return added.ok ? await readTracked(cwd, base, env) : null
  } catch {
    return null
  } finally {
    await rm(temp, { recursive: true, force: true }).catch(() => undefined)
  }
}

async function numstat(
  cwd: string,
  args: string[],
  env?: NodeJS.ProcessEnv,
): Promise<Map<string, { additions: number; deletions: number }> | null> {
  const result = await runGitCommand(cwd, args, env)
  if (!result.ok) return null
  const map = new Map<string, { additions: number; deletions: number }>()
  for (const file of parseNumstatZ(result.stdout).files) {
    map.set(file.path, { additions: file.additions, deletions: file.deletions })
  }
  return map
}

/**
 * `--name-status -z` framing: an ordinary change is `<code>` then `<path>`,
 * while a rename or copy is `<code><score>` then `<old>` then `<new>`. Reading
 * the second shape as the first misattributes every file after a rename — the
 * same trap the numstat parser carries, which is why both are parsed explicitly
 * and tested against real git output.
 */
export function parseNameStatusZ(stdout: string): NameStatusEntry[] {
  const fields = stdout.split('\0').filter((field) => field.length > 0)
  const out: NameStatusEntry[] = []
  let index = 0
  while (index < fields.length) {
    const code = fields[index]
    const letter = code?.[0]
    if (!letter) {
      index += 1
      continue
    }
    if (letter === 'R' || letter === 'C') {
      const oldPath = fields[index + 1]
      const newPath = fields[index + 2]
      if (newPath) out.push({ path: newPath, status: 'renamed', oldPath })
      index += 3
      continue
    }
    const path = fields[index + 1]
    if (path) {
      out.push({
        path,
        status: letter === 'A' ? 'new' : letter === 'D' ? 'deleted' : 'modified',
      })
    }
    index += 2
  }
  return out
}

async function nameStatus(cwd: string, args: string[], env?: NodeJS.ProcessEnv): Promise<NameStatusEntry[] | null> {
  const result = await runGitCommand(cwd, args, env)
  return result.ok ? parseNameStatusZ(result.stdout) : null
}

/**
 * Join the two readings by path. `--name-status` is the authority on WHAT
 * happened and `--numstat` on how much; a path present in only one is still
 * listed, because dropping it would silently shorten the list.
 */
function combine(
  counts: Map<string, { additions: number; deletions: number }>,
  statuses: NameStatusEntry[],
): BranchStepDiff {
  const files: BranchStepFile[] = []
  const seen = new Set<string>()
  for (const entry of statuses) {
    const count = counts.get(entry.path) ?? { additions: 0, deletions: 0 }
    seen.add(entry.path)
    files.push({ ...entry, ...count })
  }
  for (const [path, count] of counts) {
    if (seen.has(path)) continue
    files.push({ path, status: 'modified', ...count })
  }
  return totals(files)
}

function totals(files: BranchStepFile[]): BranchStepDiff {
  let additions = 0
  let deletions = 0
  for (const file of files) {
    additions += file.additions
    deletions += file.deletions
  }
  files.sort((left, right) => (left.path < right.path ? -1 : left.path > right.path ? 1 : 0))
  return { files, additions, deletions }
}

/**
 * Add untracked files to a working-tree reading. They are real changes a person
 * expects to see, and `git diff` is structurally blind to them.
 *
 * Line counts come from reading the file, capped: a large, binary or unreadable
 * file is listed with zero lines rather than being omitted or holding up the
 * panel.
 */
async function withUntracked(cwd: string, tracked: BranchStepDiff, paths: readonly string[]): Promise<BranchStepDiff> {
  if (paths.length === 0) return tracked

  // These paths are repo-root-relative (`--full-name`), so reading them off disk
  // has to start from the toplevel, not from a cwd that may be a subdirectory.
  const toplevel = await runGitCommand(cwd, ['rev-parse', '--show-toplevel'])
  const root = toplevel.ok ? toplevel.stdout.trim() || cwd : cwd

  // A moved file is already listed under its new name, as the rename.
  const known = new Set(tracked.files.map((file) => file.path))
  const added = await Promise.all(
    paths
      .filter((path) => !known.has(path))
      .map(async (path) => ({
        path,
        status: 'new' as const,
        additions: await countLines(join(root, path)),
        deletions: 0,
      })),
  )
  return added.length === 0 ? tracked : totals([...tracked.files, ...added])
}

/** The untracked files, repo-root-relative, or null when git could not list them. */
async function listUntracked(cwd: string): Promise<string[] | null> {
  // `--full-name` for the same reason as `--no-relative`: from a subdirectory
  // ls-files answers relative to cwd, and these paths sit in the same list as
  // the diff's repo-relative ones.
  const listed = await runGitCommand(cwd, ['ls-files', '--others', '--exclude-standard', '--full-name', '-z'])
  return listed.ok ? listed.stdout.split('\0').filter(Boolean) : null
}

async function countLines(absolutePath: string): Promise<number> {
  try {
    const buffer = await readFile(absolutePath)
    if (buffer.byteLength > UNTRACKED_COUNT_LIMIT_BYTES) return 0
    // A NUL byte near the start is git's own binary heuristic, and a binary file
    // has no lines to count.
    if (buffer.subarray(0, 8000).includes(0)) return 0
    const text = buffer.toString('utf8')
    if (text.length === 0) return 0
    const lines = text.split('\n').length
    return text.endsWith('\n') ? lines - 1 : lines
  } catch {
    return 0
  }
}

/**
 * One side of a step's diff: a file's content at a revision.
 *
 * Null means "not present at that revision", which is the correct original side
 * for an added file and the correct modified side for a deleted one — the
 * caller renders it as empty rather than as an error.
 */
export async function readFileAtRev(cwd: string, rev: string, path: string): Promise<RevFileResult> {
  // `git show` reads `--output=<file>` out of this argv slot, so a rev or a path
  // that could be an option never reaches it. The path is also held inside the
  // repo, matching what getGitFileAtStage already enforces for its own reads.
  if (!rev || looksLikeOption(rev) || rev.includes(':')) return { kind: 'absent' }
  if (!path || looksLikeOption(path)) return { kind: 'absent' }
  const absolute = isAbsolute(path) ? path : join(cwd, path)
  if (!isInsideRepo(cwd, absolute)) return { kind: 'absent' }

  // `cat-file -s` resolves existence and size in one cheap call, the same idiom
  // the staged/unstaged legs use. Without it a lockfile or a generated bundle
  // goes whole through IPC into Monaco — and past runGitCommand's 20MB buffer it
  // fails and renders as an EMPTY side, i.e. the file looks newly added.
  const size = await runGitCommand(cwd, ['cat-file', '-s', `${rev}:${path}`])
  if (!size.ok) return { kind: 'absent' }
  const bytes = Number.parseInt(size.stdout.trim(), 10)
  if (Number.isFinite(bytes) && bytes > REV_FILE_MAX_BYTES) return { kind: 'too-large' }

  const result = await runGitCommand(cwd, ['show', `${rev}:${path}`])
  return result.ok ? { kind: 'content', content: result.stdout } : { kind: 'absent' }
}
