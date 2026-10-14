/**
 * The changelist store against a temp user-data dir and a real repository
 * (epic `git-commit-window`, T6). The model's own rules are proved in
 * `src/shared/git/changelists.test.ts`; what is proved HERE is the half that
 * touches the world — that two lists survive a restart, that a mutation lands
 * on the file the next read opens, that a committed file leaves the list it was
 * in, and that concurrent writes do not overwrite each other.
 */
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import {
  changelistOwnerId,
  DEFAULT_CHANGELIST_ID,
  type Changelist,
  type ChangelistOwner,
} from '../shared/git/changelists'
import {
  changelistsStorePath,
  createGitChangelist,
  deleteGitChangelist,
  ensureOwnedChangelist,
  getGitChangelists,
  markOwnerExited,
  moveGitChangelistPaths,
  recordAgentEdits,
  renameGitChangelist,
  setActiveGitChangelist,
} from './git-changelists'
import { createGitPatch, gitPatchArgs, gitUntrackedPatchArgs, suggestedPatchFileName } from './git-patch'
import { test } from 'vitest'

test('git-changelists', async () => {
  const suiteRun = main()

  function git(cwd: string, args: string[]): string {
    return execFileSync('git', args, { cwd, encoding: 'utf8' })
  }

  function configureRepo(repo: string): void {
    git(repo, ['config', 'user.email', 'test@example.com'])
    git(repo, ['config', 'user.name', 'Test'])
    git(repo, ['config', 'commit.gpgsign', 'false'])
  }

  function pathsOf(lists: Changelist[], id: string): string[] {
    return lists.find((list) => list.id === id)?.paths ?? []
  }

  function byName(lists: Changelist[], name: string): Changelist {
    const found = lists.find((list) => list.name === name)
    assert.ok(found, `expected a changelist named ${name}`)
    return found
  }

  async function main(): Promise<void> {
    const root = mkdtempSync(join(tmpdir(), 'sprintengine-changelists-'))
    const userData = join(root, 'user-data')
    const repo = join(root, 'repo')

    try {
      git(root, ['init', '--initial-branch=main', repo])
      configureRepo(repo)
      writeFileSync(join(repo, 'a.ts'), 'base\n')
      writeFileSync(join(repo, 'b.ts'), 'base\n')
      git(repo, ['add', '.'])
      git(repo, ['commit', '-m', 'base'])

      // A repository nobody has touched opens on the default list alone, and the
      // first read writes the file the second one will find.
      writeFileSync(join(repo, 'a.ts'), 'changed\n')
      const first = await getGitChangelists(userData, repo)
      assert.deepEqual(
        first.map((list) => list.id),
        [DEFAULT_CHANGELIST_ID],
      )
      assert.deepEqual(pathsOf(first, DEFAULT_CHANGELIST_ID), ['a.ts'], 'the change is adopted into the active list')
      assert.equal(
        changelistsStorePath(userData, repo).startsWith(join(userData, 'git-changelists')),
        true,
        'the store lives under the user-data dir, keyed by repository',
      )

      // Two repositories do not share a file.
      assert.notEqual(changelistsStorePath(userData, repo), changelistsStorePath(userData, join(root, 'other')))

      // A second list, made active. The file already in Changes stays there.
      const withFeature = await createGitChangelist(userData, repo, {
        name: 'Modal header group',
        comment: 'Modal header group: leading mark before the title',
        activate: true,
      })
      const feature = byName(withFeature, 'Modal header group')
      assert.equal(feature.active, true)
      assert.equal(withFeature.filter((list) => list.active).length, 1)
      assert.deepEqual(pathsOf(withFeature, DEFAULT_CHANGELIST_ID), ['a.ts'])
      assert.deepEqual(feature.paths, [])

      // The next file to change lands in the ACTIVE list — the whole point of the
      // flag, and the case that would otherwise sweep every existing change in.
      writeFileSync(join(repo, 'b.ts'), 'changed\n')
      const afterEdit = await getGitChangelists(userData, repo)
      assert.deepEqual(pathsOf(afterEdit, DEFAULT_CHANGELIST_ID), ['a.ts'])
      assert.deepEqual(pathsOf(afterEdit, feature.id), ['b.ts'])

      // Everything round-trips through the file: a fresh read (this is what a
      // restart is, the process holding no state between them) sees both lists.
      const reopened = await getGitChangelists(userData, repo)
      assert.deepEqual(reopened.map((list) => list.name).sort(), ['Changes', 'Modal header group'])
      assert.equal(byName(reopened, 'Modal header group').comment, 'Modal header group: leading mark before the title')

      // Moving takes the path out of the list it was in, and accepts the absolute
      // path the panel's rows carry.
      const moved = await moveGitChangelistPaths(userData, repo, feature.id, [join(repo, 'a.ts')])
      assert.deepEqual(pathsOf(moved, DEFAULT_CHANGELIST_ID), [])
      assert.deepEqual(pathsOf(moved, feature.id), ['a.ts', 'b.ts'])

      // Rename round-trips, and the default is renameable without losing its id.
      const renamed = await renameGitChangelist(userData, repo, feature.id, {
        name: 'Modal header',
        comment: 'chip on the band',
      })
      assert.equal(byName(renamed, 'Modal header').id, feature.id)
      assert.deepEqual(pathsOf(renamed, feature.id), ['a.ts', 'b.ts'], 'a rename does not disturb the paths')

      // Set-active round-trips and stays exclusive.
      const activeDefault = await setActiveGitChangelist(userData, repo, DEFAULT_CHANGELIST_ID)
      assert.deepEqual(
        activeDefault.filter((list) => list.active).map((list) => list.id),
        [DEFAULT_CHANGELIST_ID],
      )

      // A file that leaves git's status leaves the list, so a collapsed group can
      // never show a count of files that are no longer changed.
      git(repo, ['add', 'b.ts'])
      git(repo, ['commit', '-m', 'b'])
      const afterCommit = await getGitChangelists(userData, repo)
      assert.deepEqual(pathsOf(afterCommit, feature.id), ['a.ts'])

      // The default refuses its own delete; a real delete returns the paths.
      assert.deepEqual(
        (await deleteGitChangelist(userData, repo, DEFAULT_CHANGELIST_ID)).map((list) => list.id).sort(),
        [DEFAULT_CHANGELIST_ID, feature.id].sort(),
      )
      const afterDelete = await deleteGitChangelist(userData, repo, feature.id)
      assert.deepEqual(
        afterDelete.map((list) => list.id),
        [DEFAULT_CHANGELIST_ID],
      )
      assert.deepEqual(pathsOf(afterDelete, DEFAULT_CHANGELIST_ID), ['a.ts'])

      // Concurrency: two creates fired without awaiting the first must both land.
      // Without the per-repository write queue the second read-modify-write would
      // be built on the state the first one replaced, and one list would vanish.
      const [, second] = await Promise.all([
        createGitChangelist(userData, repo, { name: 'Race one' }),
        createGitChangelist(userData, repo, { name: 'Race two' }),
      ])
      assert.equal(second.length, 3, 'both concurrent creates survive')
      assert.deepEqual((await getGitChangelists(userData, repo)).map((list) => list.name).sort(), [
        'Changes',
        'Race one',
        'Race two',
      ])
      assert.equal(
        (await getGitChangelists(userData, repo)).filter((list) => list.active).length,
        1,
        'and the race cannot leave two lists active',
      )

      await assertPatches(repo)
      await assertAgentChangelists(userData, root)
      await assertChatsKeepTheirOwnLists(userData, root)
      await assertLegacyStoreIsRetired(userData, root)
    } finally {
      rmSync(root, { recursive: true, force: true })
    }

    console.log('git changelists store ok')
  }

  /**
   * The agent half, against a real repository with real commits: two agents in one
   * file, the spans one of them owns, and the two ways a span or a whole list
   * stops existing — git no longer reporting those lines, and the agent that owned
   * them leaving with nothing left to show.
   */
  async function assertAgentChangelists(userData: string, root: string): Promise<void> {
    const repo = join(root, 'repo-agents')
    git(root, ['init', '--initial-branch=main', repo])
    configureRepo(repo)
    const base = Array.from({ length: 10 }, (_unused, index) => `line ${index + 1}`).join('\n') + '\n'
    writeFileSync(join(repo, 'shared.ts'), base)
    git(repo, ['add', '.'])
    git(repo, ['commit', '-m', 'base'])

    const nadia: ChangelistOwner = { kind: 'agent', agentId: 'agent-nadia', name: 'Nadia', workspaceId: 'ws-1' }
    const ivo: ChangelistOwner = { kind: 'agent', agentId: 'agent-ivo', name: 'Ivo', workspaceId: 'ws-1' }
    const nadiaId = changelistOwnerId(nadia)
    const ivoId = changelistOwnerId(ivo)

    // A launch makes the agent's list and makes it ACTIVE, and says so twice
    // without moving anything: launch calls it, and so does every edit frame.
    const launched = await ensureOwnedChangelist(userData, repo, nadia, { activate: true })
    assert.equal(byName(launched, 'Nadia').id, nadiaId)
    assert.deepEqual(
      launched.filter((list) => list.active).map((list) => list.id),
      [nadiaId],
    )
    const relaunched = await ensureOwnedChangelist(userData, repo, nadia, { activate: true })
    assert.equal(relaunched.length, launched.length, 'the second launch makes no second list')

    // Nadia rewrites line 1; Ivo rewrites lines 5-6. Both are real changes in the
    // working tree, because a span that overlaps no hunk is a span reconcile drops.
    const withBoth = base.split('\n')
    withBoth[0] = 'nadia one'
    withBoth[4] = 'ivo five'
    withBoth[5] = 'ivo six'
    writeFileSync(join(repo, 'shared.ts'), withBoth.join('\n'))

    const afterNadia = await recordAgentEdits(userData, repo, nadia, [
      { path: join(repo, 'shared.ts'), edits: [{ oldStart: 1, oldLines: 1, newStart: 1, newLines: 1 }] },
    ])
    assert.deepEqual(
      pathsOf(afterNadia, nadiaId),
      ['shared.ts'],
      'the first agent to edit a file nobody owns becomes its home — no spans needed',
    )

    const afterIvo = await recordAgentEdits(userData, repo, ivo, [
      { path: 'shared.ts', edits: [{ oldStart: 5, oldLines: 2, newStart: 5, newLines: 2 }] },
    ])
    assert.deepEqual(pathsOf(afterIvo, nadiaId), ['shared.ts'], 'the home does not move when a guest edits')
    assert.deepEqual(pathsOf(afterIvo, ivoId), [], 'and the guest claims no whole file')
    assert.deepEqual(
      afterIvo.find((list) => list.id === ivoId)?.spans,
      { 'shared.ts': [{ start: 5, lines: 2 }] },
      'the guest owns exactly the lines it wrote',
    )

    // A path outside the repository is not this repository's to claim.
    const outsider = await recordAgentEdits(userData, repo, ivo, [{ path: join(root, 'elsewhere.ts') }])
    assert.deepEqual(pathsOf(outsider, ivoId), [], 'a path that climbs out of the checkout is dropped')

    // Ivo's lines go back to what they were: the file is still changed (Nadia's
    // line 1), but git reports no hunk where Ivo's span is, so the span is inert
    // and reconcile drops it on the very next read.
    const withoutIvo = base.split('\n')
    withoutIvo[0] = 'nadia one'
    writeFileSync(join(repo, 'shared.ts'), withoutIvo.join('\n'))
    const reread = await getGitChangelists(userData, repo)
    assert.equal(
      reread.find((list) => list.id === ivoId)?.spans,
      undefined,
      'a span that overlaps no current hunk is dropped',
    )
    assert.deepEqual(pathsOf(reread, nadiaId), ['shared.ts'], 'and the home keeps the file it owns whole')
    assert.ok(
      reread.some((list) => list.id === ivoId),
      'the list itself stays while its agent is still running',
    )

    // The agent leaves with nothing left to show: the list goes.
    const afterIvoExit = await markOwnerExited(userData, repo, ivo)
    assert.equal(
      afterIvoExit.some((list) => list.id === ivoId),
      false,
      'an owned list whose agent exited and which holds nothing is deleted',
    )

    // Nadia's is not empty, so hers stays — named after an agent that has gone,
    // until a person commits, moves or deletes it.
    const afterNadiaExit = await markOwnerExited(userData, repo, nadia)
    assert.deepEqual(pathsOf(afterNadiaExit, nadiaId), ['shared.ts'], 'a list with work in it survives its agent')
    assert.equal(afterNadiaExit.find((list) => list.id === nadiaId)?.owner?.exited, true)

    // …and goes the moment the work is committed.
    git(repo, ['add', 'shared.ts'])
    git(repo, ['commit', '-m', 'nadia'])
    const afterCommit = await getGitChangelists(userData, repo)
    assert.deepEqual(
      afterCommit.map((list) => list.id),
      [DEFAULT_CHANGELIST_ID],
      'the committed list is gone and the default is all that is left',
    )
    assert.equal(afterCommit.filter((list) => list.active).length, 1, 'and something is still active')
  }

  /**
   * Two chats in ONE checkout whose first agents are both `agent-1` — which is
   * nearly every pair of chats. Each gets a list of its own, neither's files
   * show in the other's, and one exiting leaves the other's list live.
   */
  async function assertChatsKeepTheirOwnLists(userData: string, root: string): Promise<void> {
    const repo = join(root, 'repo-two-chats')
    git(root, ['init', '--initial-branch=main', repo])
    configureRepo(repo)
    writeFileSync(join(repo, 'a.ts'), 'base\n')
    writeFileSync(join(repo, 'b.ts'), 'base\n')
    git(repo, ['add', '.'])
    git(repo, ['commit', '-m', 'base'])

    const inA: ChangelistOwner = { kind: 'agent', agentId: 'agent-1', name: 'Nadia', workspaceId: 'ws-a' }
    const inB: ChangelistOwner = { kind: 'agent', agentId: 'agent-1', name: 'Ivo', workspaceId: 'ws-b' }
    const idA = changelistOwnerId(inA)
    const idB = changelistOwnerId(inB)

    await ensureOwnedChangelist(userData, repo, inA, { activate: true })
    await ensureOwnedChangelist(userData, repo, inB, { activate: true })
    writeFileSync(join(repo, 'a.ts'), 'chat a\n')
    writeFileSync(join(repo, 'b.ts'), 'chat b\n')
    await recordAgentEdits(userData, repo, inA, [{ path: 'a.ts' }])
    const both = await recordAgentEdits(userData, repo, inB, [{ path: 'b.ts' }])
    assert.deepEqual(pathsOf(both, idA), ['a.ts'], "chat A's list holds chat A's file")
    assert.deepEqual(pathsOf(both, idB), ['b.ts'], "and chat B's holds chat B's, not both in one")
    assert.equal(byName(both, 'Nadia').id, idA, "chat B's launch did not rename chat A's list")

    const afterAExit = await markOwnerExited(userData, repo, inA)
    assert.equal(afterAExit.find((list) => list.id === idA)?.owner?.exited, true)
    assert.equal(
      afterAExit.find((list) => list.id === idB)?.owner?.exited,
      undefined,
      "chat A's agent exiting does not mark chat B's agent exited",
    )

    // Committing B's work must not delete B's list: it is still running.
    git(repo, ['add', 'b.ts'])
    git(repo, ['commit', '-m', 'chat b'])
    const afterCommit = await getGitChangelists(userData, repo)
    assert.ok(
      afterCommit.some((list) => list.id === idB),
      'a live agent keeps its emptied list, whatever another chat did',
    )
  }

  /**
   * A store an older build wrote, where the list was `agent:<agentId>`. It is
   * read back with every entry it held, flagged exited, and a new launch of the
   * agent its owner names gets a list of its own instead of inheriting it — the
   * old list may hold another chat's files, and no chat is handed them.
   */
  async function assertLegacyStoreIsRetired(userData: string, root: string): Promise<void> {
    const repo = join(root, 'repo-legacy')
    git(root, ['init', '--initial-branch=main', repo])
    configureRepo(repo)
    writeFileSync(join(repo, 'a.ts'), 'base\n')
    writeFileSync(join(repo, 'b.ts'), 'base\n')
    git(repo, ['add', '.'])
    git(repo, ['commit', '-m', 'base'])
    writeFileSync(join(repo, 'a.ts'), 'from before the upgrade\n')

    const storePath = changelistsStorePath(userData, repo)
    mkdirSync(dirname(storePath), { recursive: true })
    const legacyOwner: ChangelistOwner = { kind: 'agent', agentId: 'agent-1', name: 'Nadia', workspaceId: 'ws-a' }
    writeFileSync(
      storePath,
      JSON.stringify({
        version: 1,
        repoRoot: repo,
        lists: [
          { id: DEFAULT_CHANGELIST_ID, name: 'Changes', paths: [], active: false },
          { id: 'agent:agent-1', name: 'Nadia', paths: ['a.ts'], active: true, owner: legacyOwner },
        ],
      }),
    )

    const read = await getGitChangelists(userData, repo)
    const legacy = read.find((list) => list.id === 'agent:agent-1')
    assert.deepEqual(legacy?.paths, ['a.ts'], 'the legacy list keeps every entry it held')
    assert.equal(legacy?.owner?.exited, true, 'and is retired: no running agent will write to it again')
    assert.equal(legacy?.owner?.workspaceId, 'ws-a', 'its recorded owner is kept as it was')
    const onDisk = JSON.parse(readFileSync(storePath, 'utf8')) as { lists: Changelist[] }
    assert.deepEqual(
      onDisk.lists.find((list) => list.id === 'agent:agent-1')?.paths,
      ['a.ts'],
      'and the rewrite on disk still holds them',
    )

    // The same agent of the same chat its owner record names, relaunched.
    const owner = legacyOwner
    const fresh = changelistOwnerId(owner)
    writeFileSync(join(repo, 'b.ts'), 'after the upgrade\n')
    await ensureOwnedChangelist(userData, repo, owner, { activate: true })
    const after = await recordAgentEdits(userData, repo, owner, [{ path: 'b.ts' }])
    assert.deepEqual(pathsOf(after, fresh), ['b.ts'], 'the relaunched agent writes into a list of its own')
    assert.deepEqual(pathsOf(after, 'agent:agent-1'), ['a.ts'], 'and the legacy list is not merged into it')

    // Exiting the new list's agent leaves the legacy list untouched, and the
    // legacy list goes the moment the person commits what it held.
    await markOwnerExited(userData, repo, owner)
    git(repo, ['add', 'a.ts'])
    git(repo, ['commit', '-m', 'old work'])
    const committed = await getGitChangelists(userData, repo)
    assert.equal(
      committed.some((list) => list.id === 'agent:agent-1'),
      false,
      'an emptied legacy list is deleted like any exited one',
    )
    assert.deepEqual(pathsOf(committed, fresh), ['b.ts'])
  }

  async function assertPatches(repo: string): Promise<void> {
    // The argv is the contract: `--` guards a path that looks like a flag,
    // `:(literal)` guards a path that looks like a glob, `--cached` is the
    // only difference between the two sides of the index, and the pins keep a
    // person's diff settings out of the patch.
    assert.deepEqual(gitPatchArgs(['a.ts'], false), [
      'diff',
      '--no-color',
      '--no-ext-diff',
      '--no-textconv',
      '--src-prefix=a/',
      '--dst-prefix=b/',
      '--binary',
      '--',
      ':(literal)a.ts',
    ])
    assert.deepEqual(gitPatchArgs(['a.ts'], true), [
      'diff',
      '--cached',
      '--no-color',
      '--no-ext-diff',
      '--no-textconv',
      '--src-prefix=a/',
      '--dst-prefix=b/',
      '--binary',
      '--',
      ':(literal)a.ts',
    ])
    assert.deepEqual(gitUntrackedPatchArgs('new.ts'), [
      'diff',
      '--no-index',
      '--no-color',
      '--no-ext-diff',
      '--no-textconv',
      '--src-prefix=a/',
      '--dst-prefix=b/',
      '--binary',
      '--',
      '/dev/null',
      'new.ts',
    ])
    assert.match(suggestedPatchFileName('/tmp/My Repo', new Date(2026, 8, 9)), /^my-repo-2026-09-09\.patch$/)

    const unstaged = await createGitPatch(repo, [join(repo, 'a.ts')])
    assert.equal(unstaged.ok, true, unstaged.message ?? '')
    assert.match(unstaged.patch, /^diff --git a\/a\.ts b\/a\.ts/m)
    assert.match(unstaged.patch, /\+changed/)

    // Nothing is staged, so the cached side says so rather than handing back an
    // empty file that looks like a successful patch.
    const cached = await createGitPatch(repo, [join(repo, 'a.ts')], { cached: true })
    assert.equal(cached.ok, true)
    assert.equal(cached.patch, '')
    assert.equal(cached.message, 'Nothing staged in the selected files.')

    // An untracked file has no diff for git to show, and must still patch — via
    // `--no-index`, which never touches the index.
    writeFileSync(join(repo, 'fresh.ts'), 'brand new\n')
    const untracked = await createGitPatch(repo, [join(repo, 'fresh.ts')])
    assert.equal(untracked.ok, true, untracked.message ?? '')
    assert.match(untracked.patch, /\+brand new/)
    assert.equal(
      execFileSync('git', ['diff', '--cached', '--name-only'], { cwd: repo, encoding: 'utf8' }).trim(),
      '',
      'and building it staged nothing',
    )
  }

  await suiteRun
})
