import { existsSync } from 'node:fs'
import { mkdir, mkdtemp, readFile, readdir, realpath, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, onTestFinished, test } from 'vitest'

import { createNodeStudioPlatform, installStudioPlatform, resetStudioPlatform } from '../../server/platform/platform'
import type { ScannedSkill } from '../../shared/skills'
import { createConversationSkillsResolver } from '../conversation-skills'
import { installSkill, uninstallSkill } from './install'
import { skillDirStaysInRoot } from './skill-dir-containment'

const PROVENANCE = { sourceId: 'github:acme/skills', skillId: 'skills/writer', commitSha: 'b81f77a' }

function skill(id = 'skills/writer'): ScannedSkill {
  return {
    id,
    name: 'writer',
    description: '',
    group: '',
    files: [{ path: 'SKILL.md', size: 1, blobSha: '', isEntry: true }],
    allowedTools: [],
    hasExecutables: false,
  }
}

const install = (workspaceRoot: string, provenance = PROVENANCE) =>
  installSkill({
    workspaceRoot,
    skill: skill(),
    harnesses: ['claude'],
    readFile: async () => Buffer.from('# writer\n'),
    provenance,
  })

describe.skipIf(process.platform === 'win32')('skill folders stay inside the project', () => {
  let base: string
  let workspace: string
  let outside: string
  beforeEach(async () => {
    base = await realpath(await mkdtemp(join(tmpdir(), 'sprintengine-skill-links-')))
    workspace = join(base, 'workspace')
    outside = join(base, 'outside')
    await mkdir(workspace, { recursive: true })
    await mkdir(join(outside, 'skills'), { recursive: true })
  })
  afterEach(async () => {
    await rm(base, { recursive: true, force: true })
  })

  test('a linked harness folder is judged outside the project', async () => {
    await symlink(outside, join(workspace, '.claude'))
    expect(await skillDirStaysInRoot(workspace, join(workspace, '.claude', 'skills', 'writer'), { home: '/' })).toBe(
      false,
    )
    expect(await skillDirStaysInRoot(workspace, join(workspace, '.agents', 'skills', 'writer'), { home: '/' })).toBe(
      true,
    )
  })

  test('an install does not write through a linked harness folder', async () => {
    await symlink(outside, join(workspace, '.claude'))
    const result = await install(workspace)
    expect(result.ok).toBe(false)
    expect(await readdir(join(outside, 'skills'))).toEqual([])
  })

  test('a removal does not reach through a linked harness folder', async () => {
    await mkdir(join(outside, 'skills', 'writer'), { recursive: true })
    await writeFile(join(outside, 'skills', 'writer', 'SKILL.md'), 'kept\n')
    await symlink(outside, join(workspace, '.claude'))
    const result = await uninstallSkill({ workspaceRoot: workspace, dirName: 'writer', harnesses: ['claude'] })
    expect(result.ok && result.removedPaths).toEqual([])
    expect(await readFile(join(outside, 'skills', 'writer', 'SKILL.md'), 'utf8')).toBe('kept\n')
  })

  test("an install does not overwrite another source's copy, and updates its own", async () => {
    const own = join(workspace, '.claude', 'skills', 'writer')
    expect((await install(workspace)).ok).toBe(true)
    expect((await install(workspace)).ok).toBe(true)
    await writeFile(join(own, 'SKILL.md'), 'kept\n')
    expect((await install(workspace, { ...PROVENANCE, sourceId: 'github:other/skills' })).ok).toBe(false)
    expect(await readFile(join(own, 'SKILL.md'), 'utf8')).toBe('kept\n')
  })

  test('a linked SKILL.md is not attached as instructions', async () => {
    await writeFile(join(outside, 'notes.md'), 'Text from outside the project.\n')
    const dir = join(workspace, '.agents', 'skills', 'writer')
    await mkdir(dir, { recursive: true })
    await symlink(join(outside, 'notes.md'), join(dir, 'SKILL.md'))
    const resolve = createConversationSkillsResolver()
    await expect(
      resolve({ workspaceRoot: workspace, mode: 'context', skills: [{ id: 'writer', sourcePath: dir }] }),
    ).rejects.toThrow(/link/)
  })

  test('attached instructions keep only the frontmatter a project command keeps', async () => {
    const dir = join(workspace, '.agents', 'skills', 'writer')
    await mkdir(dir, { recursive: true })
    await writeFile(
      join(dir, 'SKILL.md'),
      '---\nname: writer\ndescription: Write.\nallowed-tools: Bash(*)\nhooks:\n  PreToolUse: []\n---\nWrite it.\n',
    )
    const resolved = await createConversationSkillsResolver()({
      workspaceRoot: workspace,
      mode: 'context',
      skills: [{ id: 'writer', sourcePath: dir }],
    })
    expect(resolved.context).toContain('---\nname: writer\ndescription: Write.\n---\nWrite it.')
    expect(resolved.context).not.toContain('allowed-tools')
    expect(resolved.context).not.toContain('PreToolUse')
  })

  test("Studio's own skill is attached over a project folder of the same name", async () => {
    installStudioPlatform(createNodeStudioPlatform({ dataDir: join(base, 'data'), packaged: false, version: '0.0.0' }))
    onTestFinished(() => resetStudioPlatform())
    const dir = join(workspace, '.agents', 'skills', 'backlog')
    await mkdir(dir, { recursive: true })
    await writeFile(join(dir, 'SKILL.md'), '---\nname: backlog\n---\nA project copy.\n')
    const resolved = await createConversationSkillsResolver()({
      workspaceRoot: workspace,
      mode: 'context',
      skills: [{ id: 'backlog', sourcePath: dir }],
    })
    expect(resolved.context).not.toContain('A project copy.')
    const shipped = await readFile(join(process.cwd(), 'resources', 'builtin-skills', 'backlog', 'SKILL.md'), 'utf8')
    expect(resolved.context).toContain(shipped.split('\n').find((line) => line.startsWith('# ')) ?? '')
    expect(existsSync(join(dir, 'SKILL.md'))).toBe(true)
  })
})
