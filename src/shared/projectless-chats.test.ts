import assert from 'node:assert/strict'
import { test } from 'vitest'

import {
  isProjectlessChatsRoot,
  projectlessChatFolderName,
  projectlessChatsRootIn,
  projectlessChatsRootOf,
  projectlessScopeOf,
} from './projectless-chats'
import { workspaceProjectRootOf } from './worktree-paths'

const ROOT = '/Users/dev/.sprintengine/chats'
const CHAT = `${ROOT}/2026-10-10-convert-these-pngs-3f9a2c1d`

test('the root sits in the home folder, in its separator', () => {
  assert.equal(projectlessChatsRootIn('/Users/dev'), ROOT)
  assert.equal(projectlessChatsRootIn('C:\\Users\\dev'), 'C:\\Users\\dev\\.sprintengine\\chats')
})

test('the root is recognised whatever its separator or trailing slash', () => {
  assert.equal(isProjectlessChatsRoot(ROOT), true)
  assert.equal(isProjectlessChatsRoot(`${ROOT}/`), true)
  assert.equal(isProjectlessChatsRoot('C:\\Users\\dev\\.sprintengine\\chats'), true)
  assert.equal(isProjectlessChatsRoot('/Users/dev/app'), false)
  assert.equal(isProjectlessChatsRoot(CHAT), false)
  assert.equal(isProjectlessChatsRoot('.sprintengine/chats'), false, 'a relative path only looks like it')
  assert.equal(isProjectlessChatsRoot(null), false)
  assert.equal(isProjectlessChatsRoot('   '), false)
})

test("a chat's own folder files under the root, and nothing deeper does", () => {
  assert.equal(projectlessChatsRootOf(CHAT), ROOT)
  assert.equal(projectlessChatsRootOf(`${CHAT}/site`), null, "a folder the agent made is the chat's work")
  assert.equal(projectlessChatsRootOf(ROOT), null)
  assert.equal(projectlessChatsRootOf('/Users/dev/app'), null)
})

test('New chat from the root or from a chat in it is scoped to No project', () => {
  assert.equal(projectlessScopeOf(ROOT), ROOT)
  assert.equal(projectlessScopeOf(`${ROOT}/`), ROOT)
  assert.equal(projectlessScopeOf(CHAT), ROOT)
  assert.equal(projectlessScopeOf('/Users/dev/app'), null)
  assert.equal(projectlessScopeOf(null), null)
})

test('every chat started without a project is one project for the sidebar: the root', () => {
  assert.equal(workspaceProjectRootOf({ folderPath: CHAT }), ROOT)
  assert.equal(workspaceProjectRootOf({ folderPath: `${ROOT}/2026-10-11-another-chat-0a1b2c3d` }), ROOT)
  assert.equal(workspaceProjectRootOf({ folderPath: '/Users/dev/app' }), '/Users/dev/app')
})

test('a chat folder is named for its day, its first words and an id', () => {
  const now = new Date(2026, 9, 10, 14, 30)
  assert.equal(
    projectlessChatFolderName({ prompt: 'Convert these PNGs to WebP, please and thanks', now, id: 'Zx3f9a2c1d' }),
    '2026-10-10-convert-these-pngs-to-webp-3f9a2c1d',
  )
  assert.equal(projectlessChatFolderName({ prompt: '', now, id: 'ab12cd34' }), '2026-10-10-chat-ab12cd34')
  assert.equal(projectlessChatFolderName({ prompt: '🙂 ?!', now, id: '' }), '2026-10-10-chat-chat')
  const long = projectlessChatFolderName({
    prompt: 'supercalifragilisticexpialidocious antidisestablishmentarianism words',
    now,
    id: 'ab12cd34',
  })
  assert.ok(long.length <= '2026-10-10-'.length + 48 + '-ab12cd34'.length, long)
  assert.ok(!long.includes('--'), long)
})
