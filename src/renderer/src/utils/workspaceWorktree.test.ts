import assert from 'node:assert/strict'

import {
  agentWorktreePaths,
  connectorMcpSettings,
  connectorWorktreeBranch,
  connectorWorktreeSlug,
  findHealthyWorktreeScope,
  resolveWorkspaceTerminalCwd,
  resolveWorkspaceWorktree,
  repoRootFromWorktreePath,
  resolveWorktreeSpawnFallback,
  slugifyWorktreeName,
  workspaceProjectRoot,
  worktreeContainerPath,
  worktreeIdFromPath,
  type WorktreeScopeCandidate,
} from './workspaceWorktree'
import { resolveSkillInvocation } from '../../../shared/skill-invocation'
import type { McpServerConfig, Workspace } from '../types/workspace'
import type { PluginSkillCatalog } from '../../../shared/plugin-manifest'
import { test } from 'vitest'

test('workspaceWorktree', async () => {
  type WorktreeInput = Pick<Workspace, 'folderPath' | 'worktree'>

  function make(overrides: Partial<WorktreeInput>): WorktreeInput {
    return {
      folderPath: '/Users/example/project',
      worktree: null,
      ...overrides,
    }
  }

  // 1. A worktree workspace (Open as workspace): folderPath already IS the
  //    worktree, so git root stays folderPath; branch from the explicit marker.
  {
    const ws = make({
      folderPath: '/Users/example/wt/parser-spike',
      worktree: { branch: 'spike/parser' },
    })
    const resolved = resolveWorkspaceWorktree(ws)
    assert.deepEqual(resolved, {
      gitRoot: '/Users/example/wt/parser-spike',
      branch: 'spike/parser',
    })
  }

  // 1b. The marker's own `repoRoot` (the project the worktree was cut from) is a
  //     grouping fact and stays OUT of the resolved entry: the Git panel
  //     operates on the resolved checkout, and naming the parent there would
  //     diff, stage, commit and spawn terminals in the parent while a perfectly
  //     healthy worktree sits in front of the user.
  {
    const ws = make({
      folderPath: '/Users/example/.sprintengine-worktrees/project/chat-a1b2',
      worktree: { branch: 'agent/chat-a1b2', repoRoot: '/Users/example/project' },
    })
    assert.deepEqual(resolveWorkspaceWorktree(ws), {
      gitRoot: '/Users/example/.sprintengine-worktrees/project/chat-a1b2',
      branch: 'agent/chat-a1b2',
    })
  }

  // 2. Regular workspace (no worktree marker) → null.
  {
    assert.equal(resolveWorkspaceWorktree(make({})), null)
  }

  // 3. No folderPath → null even with a marker (can't resolve a git root).
  {
    assert.equal(resolveWorkspaceWorktree(make({ folderPath: null, worktree: { branch: 'b' } })), null)
  }

  // --- findHealthyWorktreeScope ---

  const scope = (overrides: Partial<WorktreeScopeCandidate>): WorktreeScopeCandidate => ({
    id: 'worktree:/x',
    path: '/x',
    branch: null,
    missing: false,
    locked: false,
    prunable: false,
    ...overrides,
  })

  const mainScope = scope({ id: 'main', path: '/Users/example/project', branch: 'main' })

  // 8. Matches the worktree by path.
  {
    const wt = scope({
      id: 'worktree:/wt',
      path: '/Users/example/project/.sprintengine-worktrees/project/a',
      branch: 'agent/a',
    })
    const found = findHealthyWorktreeScope([mainScope, wt], wt.path, 'agent/a')
    assert.equal(found?.id, wt.id)
  }

  // 9. Branch recovers the match when the path diverges (symlinked root): the
  //    joined gitRoot points at /tmp/... but git lists /private/tmp/...
  {
    const wt = scope({
      id: 'worktree:/private',
      path: '/private/tmp/proj/.sprintengine-worktrees/project/a',
      branch: 'agent/a',
    })
    const joinedButSymlinked = '/tmp/proj/.sprintengine-worktrees/project/a'
    const found = findHealthyWorktreeScope([mainScope, wt], joinedButSymlinked, 'agent/a')
    assert.equal(found?.id, wt.id, 'branch match recovers a symlinked path divergence')
  }

  // 10. Unhealthy worktree scopes are excluded → null (so the panel stays on main
  //     and does not loop with the validity-reset effect).
  {
    for (const bad of [{ prunable: true }, { missing: true }, { locked: true }]) {
      const wt = scope({ id: 'worktree:/wt', path: '/wt', branch: 'agent/a', ...bad })
      assert.equal(
        findHealthyWorktreeScope([mainScope, wt], '/wt', 'agent/a'),
        null,
        `excludes ${JSON.stringify(bad)} worktree`,
      )
    }
  }

  // 11. No gitRoot and no branch → null (a non-worktree workspace).
  {
    assert.equal(findHealthyWorktreeScope([mainScope], null, null), null)
  }

  // 12. No matching scope present → null (worktree not yet listed).
  {
    assert.equal(findHealthyWorktreeScope([mainScope], '/wt', 'agent/a'), null)
  }

  // --- connector chats ---

  // 18. Branch + slug are derived from the connector id and a unique suffix.
  {
    assert.equal(connectorWorktreeBranch('railway', 'a1b2c3d4'), 'connector/railway-a1b2c3d4')
    assert.equal(connectorWorktreeSlug('railway', 'a1b2c3d4'), 'railway-a1b2c3d4')
  }

  // 19. Worktree paths land under the repo's shared `.sprintengine-worktrees/<repo>`
  //     container (worktreeContainerPath — the single source the Worktree manager
  //     also uses).
  {
    assert.equal(worktreeContainerPath('/Users/example/project'), '/Users/example/.sprintengine-worktrees/project')
  }

  // 20. connectorMcpSettings wraps exactly one server with sync ON — never a second
  //     server, so the spawn syncs only the connector into the worktree.
  {
    const railway: McpServerConfig = {
      id: 'railway',
      name: 'Railway',
      transport: 'http',
      url: 'https://mcp.railway.com',
      enabled: true,
      clients: ['codex', 'claude'],
      scope: 'workspace',
      source: 'bundled',
      riskLevel: 'secrets',
    }
    const settings = connectorMcpSettings(railway)
    assert.equal(settings.syncEnabled, true)
    assert.deepEqual(Object.keys(settings.servers), ['railway'])
    assert.equal(settings.servers.railway, railway)
  }

  // 21. resolveSkillInvocation (shared with the debug launch path) is the plugin's
  //     CLI-native explicit template with {{skillId}} substituted — `/use-railway`
  //     (Claude) and `Use $use-railway.` (Codex).
  {
    const claude: PluginSkillCatalog = {
      support: 'native',
      harnessId: 'claude',
      installTargets: [
        {
          scope: 'workspace',
          path: '{{workspaceRoot}}/.claude/skills/{{skillId}}',
          format: 'claude-code',
          restartRequired: true,
        },
      ],
      invocation: { explicitTemplate: '/{{skillId}}', nativeSlashCommand: true },
    }
    const codex: PluginSkillCatalog = {
      support: 'native',
      harnessId: 'codex',
      installTargets: [
        {
          scope: 'workspace',
          path: '{{workspaceRoot}}/.codex/skills/{{skillId}}',
          format: 'codex',
          restartRequired: true,
        },
      ],
      invocation: { explicitTemplate: 'Use ${{skillId}}.', explicitMention: true },
    }
    assert.equal(resolveSkillInvocation(claude, 'use-railway'), '/use-railway')
    assert.equal(resolveSkillInvocation(codex, 'use-railway'), 'Use $use-railway.')
  }

  // 22. No native skill support (or no plugin, or no explicit template) → undefined,
  //     so the caller falls back to the plain instruction.
  {
    assert.equal(resolveSkillInvocation(undefined, 'use-railway'), undefined)
    const unsupported: PluginSkillCatalog = { support: 'unsupported', harnessId: 'x', installTargets: [] }
    assert.equal(resolveSkillInvocation(unsupported, 'use-railway'), undefined)
    const noTemplate: PluginSkillCatalog = {
      support: 'native',
      harnessId: 'claude',
      installTargets: [
        {
          scope: 'workspace',
          path: '{{workspaceRoot}}/.claude/skills/{{skillId}}',
          format: 'claude-code',
          restartRequired: true,
        },
      ],
      invocation: {},
    }
    assert.equal(resolveSkillInvocation(noTemplate, 'use-railway'), undefined)
  }

  // --- agent spawn worktrees ---

  // 28. Slug + id derivation (shared with the Worktree manager): messy names
  //     reduce to a safe slug; ids are path-derived and separator-free.
  {
    assert.equal(slugifyWorktreeName('  Fix Payments!! '), 'fix-payments')
    assert.equal(slugifyWorktreeName('///'), '')
    assert.equal(
      worktreeIdFromPath('/Users/example/.sprintengine-worktrees/project/nova-x1'),
      'worktree-users-example-sprintengine-worktrees-project-nova-x1',
    )
  }

  // 29. Agent worktree paths land under the same shared container as the Worktree
  //     manager and connector chats, on a `<prefix>/<slug>` branch, or the
  //     slug alone with no prefix.
  {
    const paths = agentWorktreePaths('/Users/example/project', 'Fix Payments', 'agent')
    assert.deepEqual(paths, {
      containerPath: '/Users/example/.sprintengine-worktrees/project',
      destinationPath: '/Users/example/.sprintengine-worktrees/project/fix-payments',
      slug: 'fix-payments',
      branchName: 'agent/fix-payments',
    })
    assert.equal(
      agentWorktreePaths('/Users/example/project', 'Fix Payments', 'jane/wip')?.branchName,
      'jane/wip/fix-payments',
    )
    assert.equal(agentWorktreePaths('/Users/example/project', 'Fix Payments', '')?.branchName, 'fix-payments')
  }

  // 30. A name that reduces to an empty slug → null (caller surfaces the error
  //     instead of creating a worktree at the container root).
  {
    assert.equal(agentWorktreePaths('/Users/example/project', ' // ', 'agent'), null)
  }

  // --- repoRootFromWorktreePath / workspaceProjectRoot ---

  // 31. The inverse of the container convention: whatever worktreeContainerPath
  //     and agentWorktreePaths build, this takes apart again.
  {
    const repo = '/Users/example/project'
    assert.equal(repoRootFromWorktreePath(`${worktreeContainerPath(repo)}/nova-x1`), repo)
    assert.equal(repoRootFromWorktreePath(agentWorktreePaths(repo, 'Fix Payments', 'agent')!.destinationPath), repo)
    // A slug may itself contain `/` (slugifyWorktreeName allows it); everything
    // past `<repo>` is slug and simply falls away.
    assert.equal(repoRootFromWorktreePath(`${worktreeContainerPath(repo)}/feat/x`), repo)
    // Windows separators survive as Windows separators, drive letter included.
    assert.equal(repoRootFromWorktreePath('C:\\a\\.sprintengine-worktrees\\proj\\s'), 'C:\\a\\proj')
    // A trailing separator is not a slug segment.
    assert.equal(repoRootFromWorktreePath(`${worktreeContainerPath(repo)}/nova-x1/`), repo)
  }

  // 32. Anything not inside a container is not a worktree path.
  {
    assert.equal(repoRootFromWorktreePath('/Users/example/project'), null, 'a plain checkout')
    assert.equal(repoRootFromWorktreePath('/Users/example/.sprintengine-worktrees'), null, 'the container dir itself')
    assert.equal(repoRootFromWorktreePath('/Users/example/.sprintengine-worktrees/project'), null, 'no slug segment')
    assert.equal(repoRootFromWorktreePath('.sprintengine-worktrees/project/slug'), null, 'nothing before the marker')
  }

  // 33. workspaceProjectRoot: the recorded project wins over the derived one, so a
  //     symlinked or relocated worktree still files under the folder the chat was
  //     scoped to.
  {
    assert.equal(
      workspaceProjectRoot({
        folderPath: '/Users/example/.sprintengine-worktrees/project/chat-a1b2',
        worktree: { branch: 'agent/chat-a1b2', repoRoot: '/Users/example/other-checkout' },
      }),
      '/Users/example/other-checkout',
    )
  }

  // 34. A row written before `repoRoot` existed still files under its parent,
  //     derived from the container convention.
  {
    assert.equal(
      workspaceProjectRoot({
        folderPath: '/Users/example/.sprintengine-worktrees/project/chat-a1b2',
        worktree: { branch: 'agent/chat-a1b2' },
      }),
      '/Users/example/project',
    )
  }

  // 34b. A worktree cut from a worktree nests its container. Both the derived and
  //      the recorded answer peel all the way out, so such a chat files under the
  //      real project and never under the intermediate worktree.
  {
    const nested = `${worktreeContainerPath('/Users/example/.sprintengine-worktrees/project/chat-a1b2')}/chat-e5f6`
    assert.equal(nested, '/Users/example/.sprintengine-worktrees/project/.sprintengine-worktrees/chat-a1b2/chat-e5f6')
    assert.equal(
      workspaceProjectRoot({ folderPath: nested, worktree: { branch: 'agent/chat-e5f6' } }),
      '/Users/example/project',
      'a legacy nested row derives past the intermediate worktree',
    )
    assert.equal(
      workspaceProjectRoot({
        folderPath: nested,
        worktree: { branch: 'agent/chat-e5f6', repoRoot: '/Users/example/.sprintengine-worktrees/project/chat-a1b2' },
      }),
      '/Users/example/project',
      'a recorded intermediate worktree is peeled too',
    )
  }

  // 35. Everything else is its own folder, unchanged.
  {
    assert.equal(
      workspaceProjectRoot({ folderPath: '/Users/example/project', worktree: null }),
      '/Users/example/project',
    )
    assert.equal(
      workspaceProjectRoot({ folderPath: '/Users/example/project', worktree: undefined }),
      '/Users/example/project',
    )
    assert.equal(workspaceProjectRoot({ folderPath: null, worktree: null }), null, 'folderless workspace')
    assert.equal(workspaceProjectRoot({ folderPath: '   ', worktree: null }), null, 'blank folderPath')
  }

  // --- resolveWorktreeSpawnFallback ---

  const existsAlways = async () => true
  const existsNever = async () => false

  const suiteRun = (async () => {
    // 13. Worktree cwd still present → pass through unchanged, no fallback.
    {
      const result = await resolveWorktreeSpawnFallback(
        'worktree',
        '/proj/.sprintengine-worktrees/project/a',
        '/proj',
        existsAlways,
      )
      assert.deepEqual(result, { fellBack: false, cwd: '/proj/.sprintengine-worktrees/project/a' })
    }

    // 14. Worktree cwd removed → fall back to the workspace folder and flag it.
    {
      const result = await resolveWorktreeSpawnFallback(
        'worktree',
        '/proj/.sprintengine-worktrees/project/a',
        '/proj',
        existsNever,
      )
      assert.deepEqual(result, { fellBack: true, cwd: '/proj' })
    }

    // 15. Non-worktree agent → never probes the filesystem, passes through.
    {
      let probed = false
      const result = await resolveWorktreeSpawnFallback('current_workspace', undefined, '/proj', async () => {
        probed = true
        return false
      })
      assert.deepEqual(result, { fellBack: false, cwd: undefined })
      assert.equal(probed, false, 'non-worktree agents must not stat a cwd')
    }

    // 16. Worktree mode but no cwd recorded → pass through (nothing to probe).
    {
      const result = await resolveWorktreeSpawnFallback('worktree', undefined, '/proj', existsNever)
      assert.deepEqual(result, { fellBack: false, cwd: undefined })
    }

    // 17. Removed worktree with no workspace folder → fell back with undefined cwd
    //     (caller lets the launch surface the missing-root error).
    {
      const result = await resolveWorktreeSpawnFallback('worktree', '/gone/worktree', null, existsNever)
      assert.deepEqual(result, { fellBack: true, cwd: undefined })
    }

    // --- resolveWorkspaceTerminalCwd ---

    // 24. Null gitRoot → not worktree-backed, no override, never probes the fs.
    {
      let probed = false
      const result = await resolveWorkspaceTerminalCwd(null, '/proj', async () => {
        probed = true
        return true
      })
      assert.deepEqual(result, { cwd: null, missing: false })
      assert.equal(probed, false, 'null gitRoot must not stat')
    }

    // 25. gitRoot === folderPath → the workspace folder already IS the worktree
    //     (worktree-opened / connector-chat), so no override and no fs probe.
    {
      let probed = false
      const result = await resolveWorkspaceTerminalCwd('/wt/spike', '/wt/spike', async () => {
        probed = true
        return true
      })
      assert.deepEqual(result, { cwd: null, missing: false })
      assert.equal(probed, false, 'samePath short-circuits before probing')
    }

    // 26. Distinct gitRoot present on disk → spawn into the worktree.
    {
      const result = await resolveWorkspaceTerminalCwd('/proj/.sprintengine-worktrees/project/a', '/proj', existsAlways)
      assert.deepEqual(result, { cwd: '/proj/.sprintengine-worktrees/project/a', missing: false })
    }

    // 27. Distinct gitRoot gone from disk → missing, no cwd override.
    {
      const result = await resolveWorkspaceTerminalCwd('/proj/.sprintengine-worktrees/project/a', '/proj', existsNever)
      assert.deepEqual(result, { cwd: null, missing: true })
    }

    console.log('workspaceWorktree.test.ts: ok')
  })()

  await suiteRun
})

test('a worktree chat with no folder yet files under the project its marker names', () => {
  // A New chat whose worktree is still being made has no folder, only the
  // marker naming the project it is cut from; it files there from its first frame.
  assert.equal(workspaceProjectRoot({ folderPath: null, worktree: { repoRoot: '/Users/dev/app' } }), '/Users/dev/app')
  assert.equal(workspaceProjectRoot({ folderPath: null, worktree: { branch: 'agent/x' } }), null)
  assert.equal(workspaceProjectRoot({ folderPath: null, worktree: { repoRoot: '  ' } }), null)
})

test('a repository at a filesystem root gets an absolute container of its own', () => {
  // The root itself: an absolute container no other repository's can be.
  assert.equal(worktreeContainerPath('/'), '/.sprintengine-worktrees/(root)')
  assert.equal(repoRootFromWorktreePath(`${worktreeContainerPath('/')}/fix-x`), '/')
  // A drive root: no drive letter as a folder name.
  assert.equal(worktreeContainerPath('C:\\'), 'C:/.sprintengine-worktrees/(root)')
  assert.equal(repoRootFromWorktreePath(`${worktreeContainerPath('C:\\')}/fix-x`), 'C:/')
  // Everything else is as it was.
  assert.equal(worktreeContainerPath('/Users/dev/app'), '/Users/dev/.sprintengine-worktrees/app')
  assert.equal(worktreeContainerPath('C:\\code\\app'), 'C:\\code\\.sprintengine-worktrees\\app')
})
