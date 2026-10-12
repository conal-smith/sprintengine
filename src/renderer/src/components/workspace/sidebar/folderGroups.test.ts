import assert from 'node:assert/strict'
import { test } from 'vitest'

import type { Workspace } from '../../../types/workspace'
import { buildFolderGroups, folderDisplayName, newChatProjectTarget, resolveGroups } from './folderGroups'

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
