// A skill installs for every project by default: into the home folder's
// harness directories, which every agent reads in every chat — with or without
// a folder open. A folder-only install is still there when asked for by name,
// and a caller that names no scope keeps the meaning it always had.
//
// Proved through the service over a real store and real directories; the
// repository reader is a fake, so nothing here touches the network.

import assert from 'node:assert/strict'
import { existsSync } from 'node:fs'
import { mkdir, mkdtemp } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { createSkillsService, type SkillsService } from './index'
import type { SkillRepoReader } from './repo-reader'
import type { SkillTreeEntry } from './scan'
import { test } from 'vitest'

const REPO = 'someone/skills'
const SOURCE_ID = `github:${REPO}`
const SKILL_ID = 'skills/teach'

const TREE: SkillTreeEntry[] = [
  { path: 'skills', mode: '040000', type: 'tree', sha: 't' },
  { path: 'skills/teach', mode: '040000', type: 'tree', sha: 't' },
  { path: 'skills/teach/SKILL.md', mode: '100644', type: 'blob', sha: 's', size: 64 },
]

const reader: SkillRepoReader = {
  resolveCommit: async () => 'a'.repeat(40),
  readTree: async () => TREE,
  readFile: async (_repo, _sha, path) =>
    path.endsWith('SKILL.md') ? Buffer.from('---\nname: teach\ndescription: Teach a concept\n---\n', 'utf8') : null,
}

async function setup(): Promise<{ service: SkillsService; home: string; workspace: string }> {
  const temp = await mkdtemp(join(tmpdir(), 'sprintengine-global-install-'))
  const home = join(temp, 'home')
  const workspace = join(temp, 'workspace')
  await mkdir(home, { recursive: true })
  await mkdir(workspace, { recursive: true })
  const service = createSkillsService(join(temp, 'user-data'), {
    resolveToken: async () => '',
    listHarnesses: async () => ['claude', 'agents'],
    studioMarketplaceSeedRoot: () => null,
    github: {
      fetcher: () => {
        throw new Error('this test reached GitHub instead of its reader')
      },
    },
    repoReader: reader,
    homeDir: home,
  })
  const added = await service.addSource({ repo: REPO })
  assert.equal(added.ok, true, added.ok ? '' : added.message)
  return { service, home, workspace }
}

const installedAt = (root: string, harnessDir: string) => join(root, harnessDir, 'skills', 'teach', 'SKILL.md')

test('with no folder open, Install puts the skill where every agent reads it', async () => {
  const { service, home } = await setup()
  const result = await service.install({ sourceId: SOURCE_ID, skillId: SKILL_ID })
  assert.equal(result.ok, true, result.ok ? '' : result.message)
  if (!result.ok) return
  assert.equal(result.scope, 'global')
  assert.ok(existsSync(installedAt(home, '.claude')))
  assert.ok(existsSync(installedAt(home, '.agents')))
})

test('asking for global with a folder open still installs for every project', async () => {
  const { service, home, workspace } = await setup()
  const result = await service.install({
    sourceId: SOURCE_ID,
    skillId: SKILL_ID,
    workspaceRoot: workspace,
    scope: 'global',
  })
  assert.equal(result.ok, true, result.ok ? '' : result.message)
  assert.ok(existsSync(installedAt(home, '.claude')))
  assert.equal(existsSync(installedAt(workspace, '.claude')), false, 'the folder is left alone')
})

test('a folder-only install lands in the folder, and needs one', async () => {
  const { service, home, workspace } = await setup()
  const result = await service.install({
    sourceId: SOURCE_ID,
    skillId: SKILL_ID,
    workspaceRoot: workspace,
    scope: 'workspace',
  })
  assert.equal(result.ok, true, result.ok ? '' : result.message)
  if (!result.ok) return
  assert.equal(result.scope, 'workspace')
  assert.ok(existsSync(installedAt(workspace, '.claude')))
  assert.equal(existsSync(installedAt(home, '.claude')), false)

  const noFolder = await service.install({ sourceId: SOURCE_ID, skillId: SKILL_ID, scope: 'workspace' })
  assert.equal(noFolder.ok, false)
  if (noFolder.ok) return
  assert.match(noFolder.message, /project folder/)
})

test('a caller that names no scope but gives a folder keeps installing into it', async () => {
  const { service, home, workspace } = await setup()
  const result = await service.install({ sourceId: SOURCE_ID, skillId: SKILL_ID, workspaceRoot: workspace })
  assert.equal(result.ok, true, result.ok ? '' : result.message)
  if (!result.ok) return
  assert.equal(result.scope, 'workspace')
  assert.ok(existsSync(installedAt(workspace, '.claude')))
  assert.equal(existsSync(installedAt(home, '.claude')), false)
})

test('Remove takes out the global copy, and the folder copy when a folder is given', async () => {
  const { service, home, workspace } = await setup()
  await service.install({ sourceId: SOURCE_ID, skillId: SKILL_ID })
  await service.install({ sourceId: SOURCE_ID, skillId: SKILL_ID, workspaceRoot: workspace, scope: 'workspace' })

  const removed = await service.uninstall({ workspaceRoot: workspace, dirName: 'teach' })
  assert.equal(removed.ok, true, removed.ok ? '' : removed.message)
  assert.equal(existsSync(installedAt(home, '.claude')), false)
  assert.equal(existsSync(installedAt(workspace, '.claude')), false)

  await service.install({ sourceId: SOURCE_ID, skillId: SKILL_ID })
  const globalOnly = await service.uninstall({ workspaceRoot: null, dirName: 'teach' })
  assert.equal(globalOnly.ok, true, globalOnly.ok ? '' : globalOnly.message)
  assert.equal(existsSync(installedAt(home, '.agents')), false)

  const stale = await service.uninstall({ workspaceRoot: null, dirName: 'teach' })
  assert.equal(stale.ok, false, 'a removal that removed nothing says so')
})
