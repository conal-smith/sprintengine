import { createHash } from 'crypto'
import type { Stats } from 'fs'
import { copyFile, lstat, mkdtemp, realpath, rm, stat, utimes } from 'fs/promises'
import { tmpdir } from 'os'
import { basename, dirname, join, resolve, relative, isAbsolute, sep } from 'path'
import { runGitCommand } from './git-utils'
import type {
  ConversationKey,
  ConversationCheckpointFile,
  ConversationCheckpointDiff,
  ConversationTurnDiffInput,
  ConversationTurnDiffResult,
  ConversationRevertInput,
  ConversationRevertResult,
} from '../shared/conversation-runtime'
import { errorMessage } from '../shared/errors'

const CHECKPOINT_FAILED = 'Checkpoint operation failed.'

export type ConversationCheckpointResult = { ok: true; ref: string } | { ok: false; message: string; skipped?: boolean }

const PREFIX = 'refs/sprintengine/checkpoints/'
// Refs removed by one `update-ref --stdin`, and untracked files measured at once.
const REF_BATCH = 1000
const LSTAT_BATCH = 64
// The folders older builds kept the app's state in, inside the checkout
// (`.multi-code` before the rename). This build keeps it in the project's
// store (workspace-store.ts), but one an older build left is still the app's,
// never a turn's work.
const SIDECARS = ['.sprintengine', '.multi-code']
// The line a checkpoint's message records HEAD on, so a turn can tell its own
// work from what a pull or rebase brought in (see `authoredPaths`).
const HEAD_TRAILER = 'Head:'
// The most nested repositories with no commit a snapshot looks for and leaves out.
const MAX_UNBORN_REPOSITORIES = 64
// Windows caps a command line at 32,767 characters; leave room for the rest of
// a diff's arguments when paths are passed as pathspecs.
const PATHSPEC_CHARS = 24_000
// The copy must never write a split index into the repository's git
// directory, and a filesystem monitor's answers belong to the real index.
// Every stat field is compared, whatever runs the snapshot: Linux git on a
// Windows drive trusts size and mtime alone (R89), and there the copy is
// Git for Windows' index, whose blobs may be the file after a line-ending
// conversion Linux git does not make. A trusted entry would put LF in the
// turn's "before" for a CRLF file, so its diff would show every line and
// revert would write LF. The inode it does not know makes git read the file.
const SNAPSHOT_CONFIG = ['-c', 'core.splitIndex=false', '-c', 'core.fsmonitor=false', '-c', 'core.checkStat=default']
const IDENTITY = {
  GIT_AUTHOR_NAME: 'SprintEngine Studio',
  GIT_AUTHOR_EMAIL: 'studio@example.com',
  GIT_COMMITTER_NAME: 'SprintEngine Studio',
  GIT_COMMITTER_EMAIL: 'studio@example.com',
}

/** Hidden git objects use an isolated index; only an explicit revert alters files. */
export class ConversationCheckpoints {
  constructor(private readonly limits = { bytes: 200 * 1024 * 1024, files: 50_000 }) {}

  async available(cwd: string): Promise<boolean> {
    return (await runGitCommand(cwd, ['rev-parse', '--is-inside-work-tree'])).stdout.trim() === 'true'
  }

  async fileScope(cwd: string): Promise<string> {
    return this.root(cwd).catch(() => realpath(cwd))
  }

  async capture(key: ConversationKey, turnSeq: number, point: 'pre' | 'post'): Promise<ConversationCheckpointResult> {
    try {
      const root = await this.root(key.workspaceRoot)
      const guard = await this.checkSize(root)
      if (guard) return { ok: false, skipped: true, message: guard }
      const ref = this.ref(key, turnSeq, point)
      const head = await this.head(root)
      const tree = await this.worktreeTree(root)
      await this.git(root, ['update-ref', ref, await this.commit(root, tree, turnSeq, point, head)])
      return { ok: true, ref }
    } catch (error) {
      return { ok: false, message: errorMessage(error, CHECKPOINT_FAILED) }
    }
  }

  async getTurnDiff(input: ConversationTurnDiffInput): Promise<ConversationTurnDiffResult> {
    try {
      const root = await this.root(input.key.workspaceRoot)
      const before = this.ref(input.key, input.turnSeq, 'pre')
      const after = this.ref(input.key, input.turnSeq, 'post')
      const diff = await this.diff(root, before, after, (await this.authoredPaths(root, before, after)) ?? undefined)
      if (input.path !== undefined && !diff.files.some((file) => file.path === input.path))
        return { ok: false, message: 'File is not part of this turn.' }
      if (input.path !== undefined) {
        const file = diff.files.find((file) => file.path === input.path)!
        if (file.binary) return { ok: false, message: 'Binary checkpoint files cannot be displayed as text.' }
        const original = file.status === 'added' ? '' : await this.readText(root, before, input.path)
        const modified = file.status === 'deleted' ? '' : await this.readText(root, after, input.path)
        const patch = await this.git(root, [
          'diff',
          '--no-ext-diff',
          '--no-renames',
          '--ignore-submodules=all',
          before,
          after,
          '--',
          `:(literal)${input.path}`,
        ])
        return { ok: true, diff, patch, original, modified }
      }
      const patch =
        input.path === undefined
          ? undefined
          : await this.git(root, [
              'diff',
              '--no-ext-diff',
              '--no-renames',
              '--ignore-submodules=all',
              before,
              after,
              '--',
              `:(literal)${input.path}`,
            ])
      return { ok: true, diff, ...(patch !== undefined ? { patch } : {}) }
    } catch (error) {
      return { ok: false, message: errorMessage(error, CHECKPOINT_FAILED) }
    }
  }

  async revert(input: ConversationRevertInput): Promise<ConversationRevertResult> {
    try {
      const root = await this.root(input.key.workspaceRoot)
      const guard = await this.checkSize(root)
      if (guard) return { ok: false, message: guard }
      const target = input.undo
        ? await this.latestRecovery(root, input.key, input.turnSeq, 'undo')
        : this.ref(input.key, input.turnSeq, 'pre')
      if (!target) return { ok: false, message: 'There is no revert to undo for this turn.' }
      // A file the target holds may be ignored now; capture it anyway so the
      // diff shows it and the recovery ref can bring back what is replaced.
      const current = await this.worktreeTree(root, await this.blobPaths(root, target))
      const { files } = await this.diff(root, target, current)
      if (!input.confirmed) return { ok: true, files, reverted: false }
      // Act only on what the dialog showed. A file that changed state since the
      // preview could otherwise be restored or removed without being seen.
      const shown = new Set(input.files ?? [])
      if (!input.files || shown.size !== files.length || files.some((file) => !shown.has(file.path)))
        return {
          ok: false,
          changed: true,
          message: 'The files to restore changed since they were shown. Review the new list and confirm again.',
        }
      // Record the exact state about to be replaced before changing any path,
      // for an undo as much as for a revert: work done after a revert is as
      // much the user's as work done before it. Each recovery ref is new, so a
      // second revert of the same turn never overwrites the first one's.
      const recovery = await this.storeRecovery(root, input.key, input.turnSeq, input.undo ? 'redo' : 'undo', current)
      const restores = files.filter((file) => file.status !== 'added').map((file) => file.path)
      if (restores.length) await this.checkoutFiles(root, target, restores)
      // A file absent from the target that the target's own ignore rules
      // ignore most likely existed, ignored, before the turn: keep it.
      const kept = await this.ignoredPaths(
        root,
        files.filter((file) => file.status === 'added').map((file) => file.path),
      )
      for (const file of files.filter((file) => file.status === 'added' && !kept.has(file.path))) {
        const path = safePath(root, file.path)
        // Files absent from the target can be untracked, so a checkout cannot
        // remove them. Remove only the exact diff path, never a directory tree,
        // and never through a symlinked parent that leads out of the work tree.
        const info = await lstat(path).catch(() => null)
        if (!info) continue
        if (info.isDirectory()) throw new Error(`Cannot remove directory ${file.path} during revert.`)
        safePath(await realpath(root), join(await realpath(dirname(path)), basename(path)))
        await rm(path, { force: true })
      }
      return { ok: true, files, reverted: true, undoRef: recovery, ...(kept.size ? { kept: [...kept] } : {}) }
    } catch (error) {
      return { ok: false, message: errorMessage(error, CHECKPOINT_FAILED) }
    }
  }

  async deleteConversation(key: ConversationKey): Promise<void> {
    if (!(await this.available(key.workspaceRoot))) return
    const prefix = `${PREFIX}${this.identity(key)}/`
    const refs = await this.git(key.workspaceRoot, ['for-each-ref', '--format=%(refname)', prefix])
    await this.deleteRefs(key.workspaceRoot, refs.trim().split('\n').filter(Boolean))
  }

  /**
   * Expire a conversation's refs once the conversation itself has been idle
   * for 30 days, never ref by ref: a live conversation keeps every turn's
   * checkpoint however old that turn is. Activity is the newest of its refs
   * and, for conversations the caller knows, the thread's last update. Refs of
   * conversations the caller does not know (another worktree of the same
   * repository shares this ref namespace) expire on their refs alone.
   */
  async collectExpired(
    cwd: string,
    now = Date.now(),
    live: Array<{ key: ConversationKey; updatedAt: number }> = [],
  ): Promise<void> {
    if (!(await this.available(cwd))) return
    const refs = await this.git(cwd, ['for-each-ref', '--format=%(refname) %(committerdate:unix)', PREFIX])
    const groups = new Map<string, { refs: string[]; activity: number }>()
    for (const line of refs.trim().split('\n')) {
      const [ref, timestamp] = line.split(' ')
      const identity = ref?.startsWith(PREFIX) ? ref.slice(PREFIX.length).split('/')[0] : ''
      if (!identity) continue
      const group = groups.get(identity) ?? { refs: [], activity: 0 }
      group.refs.push(ref)
      group.activity = Math.max(group.activity, Number(timestamp) * 1000 || 0)
      groups.set(identity, group)
    }
    for (const thread of live) {
      const group = groups.get(this.identity(thread.key))
      if (group) group.activity = Math.max(group.activity, thread.updatedAt)
    }
    const cutoff = now - 30 * 24 * 60 * 60 * 1000
    await this.deleteRefs(
      cwd,
      [...groups.values()].filter((group) => group.activity < cutoff).flatMap((group) => group.refs),
    )
  }

  /**
   * Delete refs a batch at a time: an editing turn leaves two, so a long
   * conversation expires thousands, and one git process per ref took minutes
   * of spawning in the background of opening a chat.
   */
  private async deleteRefs(cwd: string, refs: string[]): Promise<void> {
    for (let start = 0; start < refs.length; start += REF_BATCH) {
      const batch = refs.slice(start, start + REF_BATCH)
      await this.git(cwd, ['update-ref', '--stdin'], undefined, batch.map((ref) => `delete ${ref}\n`).join(''))
    }
  }

  /**
   * HEAD is recorded as a line of the message, never as a parent: a parent
   * would make every checkpoint reachable from the branch's real history, keep
   * commits a rebase dropped alive for as long as the checkpoint lives, and
   * break the "parentless, nothing references them" rule expiry relies on.
   */
  private async commit(
    root: string,
    tree: string,
    turnSeq: number,
    point: string,
    head: string | null = null,
  ): Promise<string> {
    const message = ['-m', `Conversation checkpoint ${turnSeq} ${point}`]
    if (head) message.push('-m', `${HEAD_TRAILER} ${head}`)
    return (await this.git(root, ['commit-tree', tree, ...message], IDENTITY)).trim()
  }

  private async head(root: string): Promise<string | null> {
    const result = await runGitCommand(root, ['rev-parse', '--verify', '--quiet', 'HEAD'])
    return (result.ok && result.stdout.trim()) || null
  }

  /**
   * The paths the turn's own work touched when HEAD moved during it, or null
   * when every changed path is the turn's.
   *
   * An agent that runs `git pull` or `git rebase` moves HEAD, and the pre→post
   * diff then carries every file the pulled commits changed, so a one-line fix
   * read as a thousand changed files. The turn's work is what is left once
   * those commits are set aside: edits uncommitted at either end, commits that
   * left HEAD (a reset, or the side a rebase rewrote), and commits made since
   * the "pre" capture. A pulled commit is older than the capture, so its paths
   * are not listed. Remerge diff names a merge's paths only where the result
   * differs from git's own automatic merge, so a conflict fix counts and the
   * cleanly merged upstream changes do not.
   *
   * Null keeps the full diff: a checkpoint written before HEAD was recorded,
   * an unborn HEAD at either end, HEAD unchanged (the common case, which costs
   * one read), a git older than 2.36 without remerge diff, or any step failing.
   * Revert never asks: it restores the whole tree whatever HEAD did.
   */
  private async authoredPaths(root: string, before: string, after: string): Promise<string[] | null> {
    try {
      const records = (await this.git(root, ['log', '--no-walk=unsorted', '-z', '--format=%ct%n%B', before, after]))
        .split('\0')
        .map((record) => ({
          // The capture's own committer time: commits made after it are the turn's.
          capturedAt: record.slice(0, record.indexOf('\n')),
          head: new RegExp(`^${HEAD_TRAILER} ([0-9a-f]+)$`, 'mu').exec(record)?.[1],
        }))
      const [start, end] = records
      if (!start?.head || !end?.head || start.head === end.head || !/^\d+$/u.test(start.capturedAt)) return null
      const list = async (args: string[]) =>
        (await this.git(root, [...args, '--name-only', '-z', '--no-renames', '--no-ext-diff'])).split('\0')
      const remerge = ['log', '--format=', '--diff-merges=remerge']
      const lists = await Promise.all([
        list(['diff', start.head, before]),
        list(['diff', end.head, after]),
        list([...remerge, `${end.head}..${start.head}`]),
        list([...remerge, `--since=@${start.capturedAt}`, `${start.head}..${end.head}`]),
      ])
      return [...new Set(lists.flat().filter(Boolean))].sort()
    } catch {
      return null
    }
  }

  /**
   * `<turn>-undo-<n>` holds the files a revert replaced; `<turn>-redo-<n>` the
   * files an undo replaced. Numbers only grow and every ref is kept, so each
   * recovery point stays listed until the conversation is deleted or expires.
   */
  private async recoveries(root: string, key: ConversationKey, turnSeq: number, kind: 'undo' | 'redo') {
    const base = this.ref(key, turnSeq, kind)
    const refs = await this.git(root, ['for-each-ref', '--format=%(refname)', `${base}*`])
    return refs
      .split('\n')
      .map((ref) => {
        // The unnumbered `<turn>-undo` is what earlier builds wrote.
        const match = ref === base ? ['', '0'] : new RegExp(`^${base}-(\\d+)$`, 'u').exec(ref)
        return match ? { ref, n: Number(match[1]) } : null
      })
      .filter((entry) => entry !== null)
      .sort((a, b) => a.n - b.n)
  }
  private async latestRecovery(root: string, key: ConversationKey, turnSeq: number, kind: 'undo' | 'redo') {
    return (await this.recoveries(root, key, turnSeq, kind)).at(-1)?.ref ?? null
  }
  private async storeRecovery(
    root: string,
    key: ConversationKey,
    turnSeq: number,
    kind: 'undo' | 'redo',
    tree: string,
  ): Promise<string> {
    const n = ((await this.recoveries(root, key, turnSeq, kind)).at(-1)?.n ?? 0) + 1
    const ref = `${this.ref(key, turnSeq, kind)}-${n}`
    const commit = await this.commit(root, tree, turnSeq, kind)
    // Create-only: an existing ref of this name is never replaced.
    await this.git(root, ['update-ref', ref, commit, '0'.repeat(commit.length)])
    return ref
  }

  private identity(key: ConversationKey): string {
    return createHash('sha256').update(`${key.workspaceId}\0${key.agentId}`).digest('hex').slice(0, 24)
  }
  private ref(key: ConversationKey, turnSeq: number, point: string): string {
    if (!Number.isSafeInteger(turnSeq) || turnSeq < 1) throw new Error('Turn sequence is invalid.')
    return `${PREFIX}${this.identity(key)}/${turnSeq}-${point}`
  }
  private async root(cwd: string): Promise<string> {
    return (await this.git(cwd, ['rev-parse', '--show-toplevel'])).trim()
  }
  private async readText(root: string, ref: string, path: string): Promise<string> {
    const object = `${ref}:${path}`
    const size = Number((await this.git(root, ['cat-file', '-s', object])).trim())
    if (!Number.isFinite(size) || size > 2 * 1024 * 1024)
      throw new Error('Checkpoint file exceeds the 2 MB text preview limit.')
    return this.git(root, ['show', object])
  }

  private async checkSize(root: string): Promise<string | null> {
    const paths = (await this.git(root, ['ls-files', '--others', '--exclude-standard', '-z']))
      .split('\0')
      .filter((path) => path && !isSidecar(path))
    if (paths.length > this.limits.files) return 'Checkpoints skipped: too many untracked files.'
    let bytes = 0
    for (let start = 0; start < paths.length; start += LSTAT_BATCH) {
      const sizes = await Promise.all(
        paths.slice(start, start + LSTAT_BATCH).map(async (path) => (await lstatIn(root, path))?.size ?? 0),
      )
      bytes += sizes.reduce((sum, size) => sum + size, 0)
      if (bytes > this.limits.bytes) return 'Checkpoints skipped: untracked files exceed the size limit.'
    }
    return null
  }

  /**
   * Snapshot the work tree into a tree object through a throwaway index.
   * The index starts as a copy of the user's, so git's stat cache skips
   * rehashing every unchanged tracked file; only the copy is ever written.
   * `include` names extra paths to capture when present on disk, ignored or not.
   */
  private async worktreeTree(root: string, include: string[] = []): Promise<string> {
    const temp = await mkdtemp(join(tmpdir(), 'conversation-index-'))
    const index = join(temp, 'index')
    const env = { GIT_INDEX_FILE: index, GIT_OPTIONAL_LOCKS: '0' }
    try {
      if (await this.seedIndex(root, index)) {
        try {
          return await this.snapshot(root, env, include)
        } catch {
          // A copied index can carry state a throwaway one cannot use (a split
          // or sparse index); rebuild from HEAD instead.
          await rm(index, { force: true })
        }
      }
      const head = await runGitCommand(root, ['rev-parse', '--verify', 'HEAD'])
      await this.git(root, head.ok ? ['read-tree', 'HEAD'] : ['read-tree', '--empty'], env)
      // A force-added file can be tracked in the user's index while absent
      // from HEAD and ignored by discovery through the throwaway index.
      const staged = (await runGitCommand(root, ['ls-files', '--cached', '-z'])).stdout.split('\0').filter(Boolean)
      return await this.snapshot(root, env, [...include, ...staged])
    } finally {
      await rm(temp, { recursive: true, force: true })
    }
  }

  private async seedIndex(root: string, target: string): Promise<boolean> {
    const source = resolve(root, (await this.git(root, ['rev-parse', '--git-path', 'index'])).trim())
    const info = await stat(source).catch(() => null)
    if (!info?.isFile()) return false
    await copyFile(source, target)
    try {
      await this.clearUnwatchedFlags(root, target)
    } catch {
      // Whatever the copy holds that this cannot handle, a rebuild from HEAD can.
      await rm(target, { force: true })
      return false
    }
    // Keep the original mtime: git treats entries as racily clean by comparing
    // them with the index file's own mtime, and a fresh one would trust stale
    // stat data for a file changed in the same second as the index was written.
    await utimes(target, info.atime, info.mtime)
    return true
  }

  /**
   * Assume-unchanged and skip-worktree tell `git add` not to look at a file,
   * so a copy that kept them would miss an agent's edit to one: absent from
   * the turn diff, never reverted. The flags come off the copy only — the
   * user's own index is never written. A skip-worktree entry whose file is
   * absent is a sparse checkout leaving it out, not a deletion, so it keeps
   * its flag.
   */
  private async clearUnwatchedFlags(root: string, index: string): Promise<void> {
    const env = { GIT_INDEX_FILE: index, GIT_OPTIONAL_LOCKS: '0' }
    const flagged = { '--no-assume-unchanged': [] as string[], '--no-skip-worktree': [] as string[] }
    for (const entry of (await this.git(root, ['ls-files', '-v', '-z'], env)).split('\0')) {
      // `ls-files -v` tags assume-unchanged in lower case and skip-worktree as S.
      const tag = entry[0]
      if (!tag || (tag === tag.toUpperCase() && tag !== 'S')) continue
      const path = entry.slice(2)
      if (tag !== tag.toUpperCase()) flagged['--no-assume-unchanged'].push(path)
      if (tag.toUpperCase() === 'S' && (await lstatIn(root, path))) flagged['--no-skip-worktree'].push(path)
    }
    // One call per flag: `update-index --stdin` applies only the last flag given.
    for (const [flag, paths] of Object.entries(flagged))
      if (paths.length) await this.git(root, ['update-index', flag, '-z', '--stdin'], env, paths.join('\0') + '\0')
  }

  private async snapshot(root: string, env: NodeJS.ProcessEnv, include: string[]): Promise<string> {
    // An exclude pathspec naming an ignored path fails the whole add, so only
    // sidecars that exist and are not already ignored are excluded by name.
    const excludes: string[] = []
    for (const sidecar of SIDECARS)
      if (
        (await lstat(join(root, sidecar)).catch(() => null)) &&
        !(await runGitCommand(root, ['check-ignore', '-q', `${sidecar}/`], env)).ok
      )
        excludes.push(`:(exclude)${sidecar}`)
    const add = (more: string[] = []) =>
      this.git(root, [...SNAPSHOT_CONFIG, 'add', '-A', '--', '.', ...excludes, ...more], env)
    try {
      await add()
    } catch (error) {
      // A repository with no commit in a folder of the work tree (an agent ran
      // `git init` there) cannot be recorded as a submodule, and `git add`
      // refuses the whole add for it ("does not have a commit checked out").
      // Leave each such folder out and add the rest: the checkpoint then
      // holds nothing of what is in them, as it holds nothing of an ignored one.
      const unborn = await this.unbornRepositories(root, env)
      if (!unborn.length) throw error
      await add(unborn.map((path) => `:(exclude,literal)${path}`))
    }
    if (include.length) {
      const captured = new Set((await this.git(root, ['ls-files', '--cached', '-z'], env)).split('\0'))
      const extra: string[] = []
      for (const path of new Set(include))
        if (!captured.has(path) && !isSidecar(path) && (await lstatIn(root, path))?.isFile()) extra.push(path)
      if (extra.length)
        await this.git(
          root,
          [...SNAPSHOT_CONFIG, 'add', '-f', '--pathspec-from-file=-', '--pathspec-file-nul'],
          { ...env, GIT_LITERAL_PATHSPECS: '1' },
          extra.join('\0') + '\0',
        )
    }
    return (await this.git(root, ['write-tree'], env)).trim()
  }

  /**
   * Untracked folders of the work tree that hold a repository of their own
   * whose HEAD names no commit, at most MAX_UNBORN_REPOSITORIES of them. Git
   * lists a nested repository as its folder, with a trailing slash, rather
   * than the files in it.
   */
  private async unbornRepositories(root: string, env: NodeJS.ProcessEnv): Promise<string[]> {
    const listed = await runGitCommand(root, ['ls-files', '--others', '--exclude-standard', '-z'], env)
    if (!listed.ok) return []
    const candidates = listed.stdout
      .split('\0')
      .filter((path) => path.endsWith('/') && !isSidecar(path))
      .slice(0, MAX_UNBORN_REPOSITORIES)
    const unborn: string[] = []
    for (const folder of candidates) {
      const path = folder.slice(0, -1)
      if (!(await lstatIn(root, `${path}/.git`))) continue
      // Asked of the nested repository itself, so not through the snapshot's index.
      const head = await runGitCommand(safePath(root, path), ['rev-parse', '--verify', '--quiet', 'HEAD'])
      if (!head.ok) unborn.push(path)
    }
    return unborn
  }

  private async blobPaths(root: string, commit: string): Promise<string[]> {
    return (await this.git(root, ['ls-tree', '-r', '-z', '--full-tree', commit]))
      .split('\0')
      .filter((line) => /^\d+ blob /u.test(line))
      .map((line) => line.slice(line.indexOf('\t') + 1))
  }

  private async ignoredPaths(root: string, paths: string[]): Promise<Set<string>> {
    if (!paths.length) return new Set()
    // Exit status 1 means none are ignored; nothing is kept on any failure.
    const result = await runGitCommand(root, ['check-ignore', '--no-index', '-z', '--stdin'], undefined, {
      stdin: paths.join('\0') + '\0',
    })
    return new Set(result.stdout.split('\0').filter(Boolean))
  }

  /**
   * Write `paths` from `commit` into the work tree through a throwaway index.
   * The user's index is never read or written, so what they staged stays
   * staged byte for byte and nothing they had untracked becomes staged.
   */
  private async checkoutFiles(root: string, commit: string, paths: string[]): Promise<void> {
    const temp = await mkdtemp(join(tmpdir(), 'conversation-restore-'))
    const env = { GIT_INDEX_FILE: join(temp, 'index'), GIT_OPTIONAL_LOCKS: '0' }
    try {
      await this.git(root, ['read-tree', commit], env)
      await this.git(root, ['checkout-index', '-f', '-z', '--stdin'], env, paths.join('\0') + '\0')
    } finally {
      await rm(temp, { recursive: true, force: true })
    }
  }

  /**
   * `paths` narrows the diff to those repository paths, a batch per command
   * line. Narrowing in git rather than here keeps a pull's thousand files from
   * being diffed line by line only to be thrown away.
   */
  private async diff(
    root: string,
    before: string,
    after: string,
    paths?: string[],
  ): Promise<ConversationCheckpointDiff> {
    if (paths === undefined) return { submodulesExcluded: true, files: await this.diffFiles(root, before, after, []) }
    const files: ConversationCheckpointFile[] = []
    for (const batch of pathspecBatches(paths)) files.push(...(await this.diffFiles(root, before, after, batch)))
    return { submodulesExcluded: true, files }
  }

  private async diffFiles(
    root: string,
    before: string,
    after: string,
    pathspecs: string[],
  ): Promise<ConversationCheckpointFile[]> {
    const base = ['diff', '--no-ext-diff', '--no-renames', '--ignore-submodules=all']
    const limit = pathspecs.length ? ['--', ...pathspecs] : []
    const stats = (await this.git(root, [...base, '--numstat', '-z', before, after, ...limit]))
      .split('\0')
      .filter(Boolean)
    const statuses = (await this.git(root, [...base, '--name-status', '-z', before, after, ...limit])).split('\0')
    const status = new Map<string, ConversationCheckpointFile['status']>()
    for (let i = 0; i + 1 < statuses.length; i += 2)
      status.set(statuses[i + 1], statuses[i] === 'A' ? 'added' : statuses[i] === 'D' ? 'deleted' : 'modified')
    return stats.map((line) => {
      const first = line.indexOf('\t')
      const second = line.indexOf('\t', first + 1)
      const added = line.slice(0, first)
      const removed = line.slice(first + 1, second)
      const path = line.slice(second + 1)
      return {
        path,
        status: status.get(path) ?? 'modified',
        addedLines: Number(added) || 0,
        removedLines: Number(removed) || 0,
        binary: added === '-' || removed === '-',
      }
    })
  }

  private async git(cwd: string, args: string[], env?: NodeJS.ProcessEnv, stdin?: string): Promise<string> {
    const result = await runGitCommand(cwd, args, env, { ...(stdin !== undefined ? { stdin } : {}) })
    if (!result.ok) throw new Error(result.message || result.stderr || 'Checkpoint git operation failed.')
    return result.stdout
  }
}

/** Literal, root-relative pathspecs split so each batch fits on one command line. */
function pathspecBatches(paths: string[]): string[][] {
  const batches: string[][] = []
  let batch: string[] = []
  let length = 0
  for (const path of paths) {
    const pathspec = `:(top,literal)${path}`
    if (batch.length && length + pathspec.length + 1 > PATHSPEC_CHARS) {
      batches.push(batch)
      batch = []
      length = 0
    }
    batch.push(pathspec)
    length += pathspec.length + 1
  }
  if (batch.length) batches.push(batch)
  return batches
}

function safePath(root: string, path: string): string {
  const absolute = resolve(root, path)
  const rel = relative(root, absolute)
  // A parent step, not a name: `..env` is a file in the work tree.
  if (!rel || rel === '..' || rel.startsWith(`..${sep}`) || isAbsolute(rel))
    throw new Error('Checkpoint path escapes the work tree.')
  return absolute
}
/**
 * The entry at a path git listed, or null when there is none this process can
 * reach — gone since git listed it, or a name this machine's paths cannot
 * hold inside the work tree (a WSL repository is listed by Linux git and
 * looked up here through Windows paths). Only a lookup: git itself still
 * captures the file, and one such name used to cost the turn its checkpoint.
 */
async function lstatIn(root: string, path: string): Promise<Stats | null> {
  try {
    return await lstat(safePath(root, path))
  } catch {
    return null
  }
}
function isSidecar(path: string): boolean {
  return SIDECARS.some((sidecar) => path === sidecar || path.startsWith(`${sidecar}/`))
}
