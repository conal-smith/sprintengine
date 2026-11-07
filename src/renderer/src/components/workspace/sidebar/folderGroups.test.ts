import assert from 'node:assert/strict'
import { test } from 'vitest'

import type { Workspace } from '../../../types/workspace'
import {
  buildFolderGroups,
  folderDisplayName,
  groupKeyOf,
  newChatProjectTarget,
  remoteFolderGroupKey,
  remoteGroupDisplayName,
  remoteProjectFolder,
  remoteProjectName,
  resolveGroups,
} from './folderGroups'

const ROOT = '/Users/dev/.sprintengine/chats'

function chat(id: string, folderPath: string | null): Workspace {
  return { id, name: id, folderPath, createdAt: 1 } as unknown as Workspace
}

test('the chats started without a project share one "No project" header', () => {
  const rows = [
    chat('a', `${ROOT}/2026-10-10-hello-ab12cd34`),
    chat('b', '/Users/dev/app'),
    chat('c', `${ROOT}/2026-10-11-plan-a-trip-0a1b2c3d`),
  ]
  // As the sidebar builds them: keys and headers resolved first.
  const resolved = resolveGroups(rows, new Map())
  const groups = buildFolderGroups(rows, (workspace) => resolved.keys.get(workspace.id) ?? '', resolved.headers)
  assert.deepEqual(
    groups.map((group) => [group.displayName, group.fullPath, group.workspaces.map((workspace) => workspace.id)]),
    [
      ['No project', ROOT, ['a', 'c']],
      ['app', '/Users/dev/app', ['b']],
    ],
  )
  assert.equal(folderDisplayName(ROOT), 'No project')
  assert.equal(folderDisplayName(null), 'No folder', 'the folderless bucket keeps its name')
})

test('New chat from a chat without a project starts another one, not a chat in its folder', () => {
  assert.equal(newChatProjectTarget(chat('a', `${ROOT}/2026-10-10-hello-ab12cd34`)), ROOT)
})

const MINI_ROOT = '/Users/me/.sprintengine/chats'

function remoteChat(id: string, workspaceRoot: string | null): Workspace {
  return {
    ...chat(id, null),
    remoteOrigin: { connectionId: 'conn-mini', machineName: 'mac-mini', workspaceId: `r-${id}`, workspaceRoot },
  } as unknown as Workspace
}

function sshChat(id: string, folderPath: string): Workspace {
  return { ...chat(id, folderPath), environment: { id: 'ssh-build-box', label: 'build-box' } } as unknown as Workspace
}

function sidebarGroups(rows: Workspace[]) {
  const resolved = resolveGroups(rows, new Map())
  const groups = buildFolderGroups(rows, (workspace) => resolved.keys.get(workspace.id) ?? '', resolved.headers)
  return groups.map((group) => [group.displayName, group.workspaces.map((workspace) => workspace.id)])
}

test('chats started without a project on other machines share one "No project" header', () => {
  const rows = [
    remoteChat('a', `${MINI_ROOT}/2026-10-10-convert-pngs-3f9a2c1d`),
    remoteChat('b', `${MINI_ROOT}/2026-10-11-plan-a-trip-0a1b2c3d`),
    sshChat('c', '/home/dev/.sprintengine/chats/2026-10-11-tidy-logs-9e8d7c6b'),
    remoteChat('d', '/Users/me/app'),
  ]
  assert.deepEqual(sidebarGroups(rows), [
    ['No project', ['a', 'b', 'c']],
    ['app', ['d']],
  ])
})

test("chats started without a project elsewhere join this window's own No project header", () => {
  const rows = [
    remoteChat('a', `${MINI_ROOT}/2026-10-10-convert-pngs-3f9a2c1d`),
    chat('b', `${ROOT}/2026-10-10-hello-ab12cd34`),
    sshChat('c', '/home/dev/.sprintengine/chats/2026-10-11-tidy-logs-9e8d7c6b'),
  ]
  const resolved = resolveGroups(rows, new Map())
  assert.equal(resolved.projectlessKey, resolved.keys.get('b'))
  const groups = buildFolderGroups(rows, (workspace) => resolved.keys.get(workspace.id) ?? '', resolved.headers)
  assert.deepEqual(
    groups.map((group) => [group.displayName, group.fullPath, group.remote, group.workspaces.map((row) => row.id)]),
    [['No project', ROOT, null, ['a', 'b', 'c']]],
    "the header is this disk's root, so its New chat starts here",
  )
})

test('a folder a remote chat made inside its own chat folder is still that chat', () => {
  // Only a chat's own folder, a direct child of the root, is "No project".
  assert.deepEqual(sidebarGroups([remoteChat('a', `${MINI_ROOT}/2026-10-10-site-1a2b3c4d/web`)]), [['web', ['a']]])
})

// A pool slot is named after its project (`demo-app-04`), so it reads as one. The
// local rows and New chat's picker have always been told the difference; every
// path a paired machine's chat takes to a name or a key has to be told it too.
const SLOT = '/Users/dev/.sprintengine-worktrees/demo-app/demo-app-04'

function openedFrom(id: string, workspaceRoot: string | null, repository: unknown = null): Workspace {
  return {
    ...chat(id, null),
    remoteOrigin: { connectionId: 'c1', machineName: 'mac-mini', workspaceId: id, workspaceRoot, repository },
  } as unknown as Workspace
}

test('a chat in a pool slot on a paired machine is named for its project', () => {
  assert.equal(remoteProjectName(SLOT, 'mac-mini'), 'demo-app')
  assert.equal(remoteProjectName(`${SLOT}/`, 'mac-mini'), 'demo-app', 'a trailing separator changes nothing')
  assert.equal(
    remoteProjectName('C:\\dev\\.sprintengine-worktrees\\demo-app\\chat-k_iq', 'build-box'),
    'demo-app',
    'on a Windows machine too',
  )
  assert.equal(remoteGroupDisplayName(openedFrom('a', SLOT)), 'demo-app', 'a row opened here too')
  assert.equal(remoteProjectFolder(SLOT), '/Users/dev/demo-app')
})

test('a nested worktree on a paired machine is named for the project, not the worktree it was cut from', () => {
  const nested = '/Users/dev/.sprintengine-worktrees/demo-app/.sprintengine-worktrees/demo-app-04/chat-1'
  assert.equal(remoteProjectName(nested, 'mac-mini'), 'demo-app')
})

test('a folder on a paired machine that is not an app-made worktree keeps its own name', () => {
  assert.equal(remoteProjectName('/Users/dev/demo-app', 'mac-mini'), 'demo-app')
  assert.equal(remoteProjectName('/Users/dev/worktrees/demo-app-04', 'mac-mini'), 'demo-app-04')
  assert.equal(remoteProjectName(null, 'mac-mini.tail1234.ts.net'), 'mac-mini', 'no folder still names the machine')
  assert.equal(remoteProjectName(`${MINI_ROOT}/2026-10-10-hello-ab12cd34`, 'mac-mini'), 'No project')
})

test('the slots of a project with no repository share one header with its checkout', () => {
  const rows = [
    openedFrom('a', SLOT),
    openedFrom('b', '/Users/dev/.sprintengine-worktrees/demo-app/demo-app-07'),
    openedFrom('c', '/Users/dev/demo-app'),
  ]
  assert.deepEqual(new Set(rows.map(groupKeyOf)).size, 1)
  assert.equal(groupKeyOf(rows[0]!), remoteFolderGroupKey('c1', SLOT), 'an opened row and a listed one key alike')
  const groups = buildFolderGroups(rows)
  assert.deepEqual(
    groups.map((group) => [group.displayName, group.workspaces.length]),
    [['demo-app', 3]],
  )
})

test('a worktree on an SSH machine files under its project', () => {
  const environment = { id: 'env1', label: 'build-box' }
  const worktree = { ...chat('a', SLOT), environment } as unknown as Workspace
  const checkout = { ...chat('b', '/Users/dev/demo-app'), environment } as unknown as Workspace
  assert.equal(groupKeyOf(worktree), groupKeyOf(checkout))
  assert.equal(remoteGroupDisplayName(worktree), 'demo-app')
})
