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
