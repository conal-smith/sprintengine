// The skills an agent can reach include the ones installed for every project
// in the home folder — so a chat with no folder still lists its skills, and a
// folder's own copy of a name wins over the global one.

import assert from 'node:assert/strict'
import { existsSync } from 'node:fs'
import { mkdir, mkdtemp, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import type { AgentCliAvailabilityMap } from '../shared/electron-api'
import { createAgentSkillInstaller } from './agent-skill-installer'
import { createMcpServerResolver } from './mcp-config-readers/resolve-servers'
import { createPluginRegistry } from './plugin-registry'
import { createAppPluginRegistryOptions } from './plugin-registry-instance'
import {
  createAgentCapabilityService,
  createFsSkillDirectoryReader,
  createWorkspaceSkillsService,
} from './workspace-skills-service'
import { test } from 'vitest'

async function writeSkill(root: string, harnessDir: string, dirName: string, description: string): Promise<void> {
  const dir = join(root, harnessDir, 'skills', dirName)
  await mkdir(dir, { recursive: true })
  await writeFile(join(dir, 'SKILL.md'), `---\nname: ${dirName}\ndescription: ${description}\n---\n`, 'utf8')
}

function bundledPlugins() {
  // The bundled manifests, so the claude harness resolves the way it does in the app.
  const registry = createPluginRegistry(
    createAppPluginRegistryOptions(
      join(process.cwd(), 'node_modules', '.cache', 'sprintengine'),
      join(process.cwd(), 'resources', 'plugins'),
      join(process.cwd(), 'node_modules', '.cache', 'sprintengine', 'plugins-none'),
    ),
  )
  registry.loadSync()
  return registry.list()
}

async function roots(): Promise<{ home: string; workspace: string }> {
  const temp = await mkdtemp(join(tmpdir(), 'sprintengine-global-skills-'))
  const home = join(temp, 'home')
  const workspace = join(temp, 'workspace')
  await mkdir(home, { recursive: true })
  await mkdir(workspace, { recursive: true })
  await writeSkill(home, '.claude', 'teach', 'global copy')
  await writeSkill(home, '.claude', 'shared', 'global copy')
  await writeSkill(workspace, '.claude', 'shared', 'workspace copy')
  await writeSkill(workspace, '.claude', 'local-only', 'workspace copy')
  return { home, workspace }
}

test('the workspace inventory lists global skills only when asked, and works with no folder', async () => {
  const { home, workspace } = await roots()
  const service = createWorkspaceSkillsService({ homeDir: home })

  const folderOnly = await service.listWorkspaceSkills({ workspaceRoot: workspace })
  assert.ok(folderOnly.ok)
  assert.equal(
    folderOnly.skills.some((skill) => skill.id === 'teach'),
    false,
    'callers that did not ask see what they always saw',
  )

  const both = await service.listWorkspaceSkills({ workspaceRoot: workspace, includeGlobal: true })
  assert.ok(both.ok)
  const installed = both.skills.filter((skill) => skill.installState !== 'available')
  assert.deepEqual(installed.map((skill) => skill.id).sort(), ['local-only', 'shared', 'teach'])
  assert.equal(installed.find((skill) => skill.id === 'shared')?.description, 'workspace copy', 'the nearer copy wins')

  const noFolder = await service.listWorkspaceSkills({ workspaceRoot: null, includeGlobal: true })
  assert.ok(noFolder.ok)
  assert.deepEqual(
    noFolder.skills
      .filter((skill) => skill.installState !== 'available')
      .map((skill) => skill.id)
      .sort(),
    ['shared', 'teach'],
  )

  const refused = await service.listWorkspaceSkills({ workspaceRoot: null })
  assert.equal(refused.ok, false, 'no folder and no global ask is still a question that cannot be answered')
})

test("an agent's capabilities include its home-folder skills, with or without a folder", async () => {
  const { home, workspace } = await roots()
  const plugins = bundledPlugins()
  const service = createAgentCapabilityService({
    reader: createFsSkillDirectoryReader(),
    listPlugins: () => plugins,
    lookupManifest: () => undefined,
    mcpResolver: createMcpServerResolver({ homeDir: () => join(home, 'no-config') }),
    homeDir: home,
  })

  const withFolder = await service.resolve({ workspaceRoot: workspace, pluginId: 'claude-code', includeGlobal: true })
  assert.ok(withFolder.ok)
  assert.deepEqual(withFolder.skills.map((skill) => skill.id).sort(), ['local-only', 'shared', 'teach'])
  assert.equal(withFolder.skills.find((skill) => skill.id === 'shared')?.description, 'workspace copy')

  const noFolder = await service.resolve({ workspaceRoot: null, pluginId: 'claude-code', includeGlobal: true })
  assert.ok(noFolder.ok)
  assert.deepEqual(noFolder.skills.map((skill) => skill.id).sort(), ['shared', 'teach'])
  assert.deepEqual(noFolder.servers, [], 'servers are a workspace configuration')

  const notAsked = await service.resolve({ workspaceRoot: workspace, pluginId: 'claude-code' })
  assert.ok(notAsked.ok)
  assert.equal(
    notAsked.skills.some((skill) => skill.id === 'teach'),
    false,
  )
})

test('using a skill installed for every project keeps it there, and a pick with no folder attaches globally', async () => {
  const { home, workspace } = await roots()
  const plugins = bundledPlugins()
  // The app's bundled skill folder, stood in for: the platform that serves it is not running here.
  const builtins = join(home, '..', 'builtin-skills')
  await mkdir(join(builtins, 'backlog'), { recursive: true })
  await writeFile(join(builtins, 'backlog', 'SKILL.md'), '---\nname: Backlog\ndescription: Work a backlog item.\n---\n')
  const installer = createAgentSkillInstaller({
    listPlugins: () => plugins,
    detectAvailability: async () => ({ 'claude-code': { installed: true } }) as unknown as AgentCliAvailabilityMap,
    homeDir: home,
    builtinSourceRoot: () => builtins,
  })

  const fromHome = await installer.attach({ workspaceRoot: workspace, skillId: 'teach' })
  assert.ok(fromHome.ok, fromHome.ok ? '' : fromHome.message)
  assert.equal(existsSync(join(workspace, '.claude', 'skills', 'teach')), false, 'not copied into the folder')

  const noFolder = await installer.attach({ workspaceRoot: null, skillId: 'backlog' })
  assert.ok(noFolder.ok, noFolder.ok ? '' : noFolder.message)
  assert.ok(existsSync(join(home, '.claude', 'skills', 'backlog', 'SKILL.md')), 'the built-in lands in the home folder')
})
