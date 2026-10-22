import assert from 'node:assert/strict'
import { mkdtemp, rm, symlink } from 'node:fs/promises'
import { homedir, tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'vitest'

import type { McpToolRegistration } from '../../shared/modules/mcp-tools'
import { createAutomationTools, type AutomationBackends } from './automation-tools'
import { refuseWorkspaceFolder, workspaceFolderRefusal, type WorkspaceFolderGuard } from './workspace-folder-guard'

const MAC: WorkspaceFolderGuard = {
  platform: 'darwin',
  homeDir: '/Users/dev',
  dataDirs: ['/Users/dev/Library/Application Support/SprintEngine Studio', '/Users/dev/.sprintengine/workspaces'],
}

test('the home folder, a root, a system folder and Studio’s own data are refused; a project folder is not', () => {
  for (const folder of [
    '/',
    '/Users/dev',
    '/Users/dev/',
    '/users/DEV',
    '/Users',
    '/etc',
    '/etc/ssh',
    '/usr/bin',
    '/System/Library',
    '/Library',
    '/tmp',
    '/Users/dev/Library/Application Support/SprintEngine Studio',
    '/Users/dev/Library/Application Support/SprintEngine Studio/artifacts',
    '/Users/dev/Library/Application Support',
    '/Users/dev/.sprintengine',
    '/Users/dev/.sprintengine/workspaces/app-1a2b',
  ]) {
    assert.notEqual(workspaceFolderRefusal(folder, MAC), null, folder)
  }
  for (const folder of [
    '/Users/dev/code/app',
    '/Users/dev/Documents/site',
    '/Users/dev/.sprintengine/chats/chat-1',
    '/tmp/scratch-app',
    '/usr/local/src/tool',
    '/Volumes/work/app',
    '/opt/projects/api',
  ]) {
    assert.equal(workspaceFolderRefusal(folder, MAC), null, folder)
  }
})

test('on Windows, a drive root, the user folders and the system folder are refused under any drive letter', () => {
  const windows: WorkspaceFolderGuard = { platform: 'win32', homeDir: 'C:\\Users\\dev', dataDirs: [] }
  for (const folder of ['C:\\', 'D:\\', 'C:\\Users', 'c:\\users\\dev', 'C:\\Windows\\System32', 'C:\\Program Files']) {
    assert.notEqual(workspaceFolderRefusal(folder, windows), null, folder)
  }
  assert.equal(workspaceFolderRefusal('C:\\Users\\dev\\code\\app', windows), null)
  assert.equal(workspaceFolderRefusal('D:\\work\\app', windows), null)
})

test('a link to the home folder is the home folder', async () => {
  const scratch = await mkdtemp(join(tmpdir(), 'workspace-guard-'))
  try {
    const home = join(scratch, 'home')
    await symlink(scratch, home)
    const guard: WorkspaceFolderGuard = { platform: process.platform, homeDir: scratch, dataDirs: [] }
    assert.notEqual(await refuseWorkspaceFolder(home, guard), null)
    assert.equal(await refuseWorkspaceFolder(join(scratch, 'project'), guard), null)
  } finally {
    await rm(scratch, { recursive: true, force: true })
  }
})

test('workspace.create from an agent refuses the home folder, and opens a project folder', async () => {
  const created: unknown[] = []
  const tools = createAutomationTools({
    createWorkspace: (input: unknown) => {
      created.push(input)
      return { ok: false, reason: 'not_in_this_test', message: 'not created' }
    },
    studioDataDirs: () => ['/Users/dev/Library/Application Support/SprintEngine Studio'],
  } as unknown as AutomationBackends)
  const create = tools.find((tool) => tool.name === 'workspace.create') as McpToolRegistration
  const agent = { metadata: { kind: 'studio-agent' as const, workspaceId: 'ws-1', agentId: 'agent-1' } }

  for (const folderPath of [homedir(), '/', '/Users/dev/Library/Application Support/SprintEngine Studio']) {
    const refused = await create.handler({ folderPath }, agent)
    assert.equal((refused.structuredContent as { error: { code: string } }).error.code, 'folder_refused', folderPath)
  }
  assert.equal(created.length, 0)
  await create.handler({ folderPath: join(homedir(), 'code', 'app') }, agent)
  assert.equal(created.length, 1, 'a project folder goes on to be created')
})
