import assert from 'node:assert/strict'
import { afterEach, test, vi } from 'vitest'

import type { ChatTitleRequest } from '../../../../../shared/text-generation/contract'
import { createGeneratedTitleRequester } from '../../../store/generatedWorkspaceTitle'
import { launchSettingsClient } from '../../../store/launchSettingsClient'
import { useWorkspaceStore } from '../../../store/workspaceStore'
import type { NewChatWorktreeResult } from '../../../utils/newChatWorktree'
import { confirmNewChatWith, type NewChatConfirmHost } from './newChatConfirm'

const PROJECT = '/Users/dev/app'
const NO_PROJECT = '/Users/dev/.sprintengine/chats'
const CHAT_FOLDER = `${NO_PROJECT}/2026-10-10-hello-ab12cd34`
const WORKTREE = '/Users/dev/.sprintengine-worktrees/app/chat-ab12'

afterEach(() => {
  vi.restoreAllMocks()
})

// A host whose starts each create a chat, and whose project use is the store's
// own, so the assertion is on what reaches main: the `projectUse` patch.
function harness(
  worktree: NewChatWorktreeResult = { ok: false, message: 'unused' },
  projectlessFolder: string | null = CHAT_FOLDER,
) {
  const updates: unknown[] = []
  vi.spyOn(launchSettingsClient, 'update').mockImplementation(async (patch) => {
    updates.push(patch)
    return true
  })
  const started: Array<{ kind: string; folderPath: string | null }> = []
  const opened: Array<{ worktree: unknown; pending: unknown }> = []
  const prepared: string[] = []
  const titled: Array<[string, string]> = []
  let worktreesMade = 0
  const projectlessPrompts: Array<string | undefined> = []
  let closed = 0
  const host: NewChatConfirmHost = {
    makeExtension: async ({ id, folder }) => folder ?? `/Users/dev/Documents/SprintEngine/Extensions/${id}`,
    makeWorktree: async () => {
      worktreesMade += 1
      return worktree
    },
    makeProjectlessFolder: async (prompt) => {
      projectlessPrompts.push(prompt)
      return projectlessFolder
    },
    prepareWorktree: (workspaceId) => {
      prepared.push(workspaceId)
    },
    titleFromPrompt: (workspaceId, prompt) => {
      titled.push([workspaceId, prompt])
    },
    startTerminal: (folderPath) => {
      started.push({ kind: 'terminal', folderPath })
      return 'ws-terminal'
    },
    startGeneral: (_confirm, folderPath) => {
      started.push({ kind: 'general', folderPath })
      return 'ws-general'
    },
    startConversation: (_confirm, folderPath, _prompt, worktree, _images, _files, _background, pending) => {
      started.push({ kind: 'conversation', folderPath })
      opened.push({ worktree, pending })
      return 'ws-conversation'
    },
    recordProjectUse: (folder) => useWorkspaceStore.getState().recordProjectUse(folder),
    closePanel: () => {
      closed += 1
    },
  }
  const projectUses = () =>
    updates
      .map((patch) => (patch as { projectUse?: { folderPath: string } }).projectUse?.folderPath)
      .filter((folder): folder is string => folder !== undefined)
  return {
    host,
    started,
    opened,
    prepared,
    titled,
    projectUses,
    closed: () => closed,
    worktreesMade: () => worktreesMade,
    projectlessPrompts,
  }
}

const CHAT_CONFIRM = {
  kind: 'conversation' as const,
  provider: { providerId: 'claude', modelId: 'default', modelLabel: 'Claude' },
}

test('a chat on a worktree opens at once, folderless and waiting on its worktree', async () => {
  const { host, started, opened, prepared, projectUses, closed, worktreesMade } = harness()
  const created = await confirmNewChatWith(host, {
    confirm: { ...CHAT_CONFIRM, worktree: { name: 'fix-login' } },
    scopedFolder: PROJECT,
    startupPrompt: 'fix the login',
    hostId: 'wsl:Ubuntu',
  })
  assert.equal(created, 'ws-conversation')
  assert.equal(worktreesMade(), 0, 'the door waits on no worktree')
  assert.deepEqual(started, [{ kind: 'conversation', folderPath: null }], 'no folder until the worktree lands')
  assert.deepEqual(opened, [
    {
      worktree: { repoRoot: PROJECT },
      pending: { name: 'fix-login', projectFolder: PROJECT, hostId: 'wsl:Ubuntu' },
    },
  ])
  assert.deepEqual(prepared, ['ws-conversation'], 'the worktree is made behind the open chat')
  assert.deepEqual(projectUses(), [PROJECT])
  assert.equal(closed(), 1)
})

test('a chat waiting on its worktree is named from its message at once; one that starts in its folder is named by its send', async () => {
  const pending = harness()
  await confirmNewChatWith(pending.host, {
    confirm: { ...CHAT_CONFIRM, worktree: { name: '' } },
    scopedFolder: PROJECT,
    startupPrompt: 'fix the login',
  })
  assert.deepEqual(pending.titled, [['ws-conversation', 'fix the login']])

  const imagesOnly = harness()
  await confirmNewChatWith(imagesOnly.host, {
    confirm: { ...CHAT_CONFIRM, worktree: { name: '' } },
    scopedFolder: PROJECT,
    startupPrompt: '  ',
    startupImages: ['/Users/dev/shot.png'],
  })
  assert.deepEqual(imagesOnly.titled, [], 'no words, no name: the send names it as before')

  const inFolder = harness()
  await confirmNewChatWith(inFolder.host, {
    confirm: CHAT_CONFIRM,
    scopedFolder: PROJECT,
    startupPrompt: 'fix the login',
  })
  assert.deepEqual(inFolder.titled, [], 'unchanged: named when the message is sent')
})

test('naming a waiting chat from its message spends the one title call; its send makes none', async () => {
  const id = 'ws-conversation'
  useWorkspaceStore.setState({ workspaces: [{ id, name: 'Chat', folderPath: null, agents: {} }] as never })
  const requests: ChatTitleRequest[] = []
  const store = () => useWorkspaceStore.getState()
  const requester = createGeneratedTitleRequester({
    autoTitle: (workspaceId, prompt) => store().autoTitleWorkspaceFromPrompt(workspaceId, prompt),
    applyGenerated: () => true,
    isTitleOpen: (workspaceId) => !store().workspaces.find((workspace) => workspace.id === workspaceId)?.titleLocked,
    resolveEngine: () => ({ cli: 'codex', model: 'default', reasoning: 'low' }),
    cliRuntimes: () => undefined,
    generate: async (request) => {
      requests.push(request)
      return { ok: false, code: 'unavailable', message: 'not here' }
    },
  })
  const { host } = harness()
  host.titleFromPrompt = (workspaceId, prompt) => void requester.titleFromPrompt(workspaceId, prompt)
  await confirmNewChatWith(host, {
    confirm: { ...CHAT_CONFIRM, worktree: { name: '' } },
    scopedFolder: PROJECT,
    startupPrompt: 'fix the login page redirect',
  })
  const named = store().workspaces[0]!
  assert.notEqual(named.name, 'Chat')
  assert.equal(named.titleLocked, true)
  assert.equal(requests.length, 1)

  // The message goes once the worktree lands, and the session offers it for a title.
  assert.equal(requester.titleFromPrompt(id, 'fix the login page redirect'), null)
  assert.equal(requests.length, 1, 'no second call')
})

test('a chat on a worktree started from inside another worktree waits on a worktree of the project', async () => {
  const { host, opened } = harness()
  await confirmNewChatWith(host, {
    confirm: { ...CHAT_CONFIRM, worktree: { name: '' } },
    scopedFolder: WORKTREE,
  })
  assert.deepEqual(opened[0]?.pending, { name: '', projectFolder: PROJECT })
})

test('a conversation, a terminal agent and a plain terminal each count once as a use of the project', async () => {
  for (const confirm of [
    { kind: 'conversation' as const, provider: { providerId: 'claude', modelId: 'default', modelLabel: 'Claude' } },
    { kind: 'general' as const, cli: 'claude-code' },
    { kind: 'terminal' as const },
  ]) {
    const { host, started, projectUses, closed } = harness()
    const created = await confirmNewChatWith(host, { confirm, scopedFolder: PROJECT })
    assert.equal(created, `ws-${confirm.kind}`)
    assert.deepEqual(started, [{ kind: confirm.kind, folderPath: PROJECT }])
    assert.deepEqual(projectUses(), [PROJECT], `${confirm.kind}: one projectUse patch, for the project`)
    assert.equal(closed(), 1)
    vi.restoreAllMocks()
  }
})

test('a chat on a worktree counts the checkout it was cut from, not the worktree', async () => {
  const { host, started, projectUses } = harness({
    ok: true,
    folderPath: WORKTREE,
    worktree: { branch: 'agent/chat-ab12', repoRoot: PROJECT },
  })
  await confirmNewChatWith(host, {
    confirm: { kind: 'general', cli: 'claude-code', worktree: { name: '' } },
    scopedFolder: PROJECT,
  })
  assert.deepEqual(started, [{ kind: 'general', folderPath: WORKTREE }])
  assert.deepEqual(projectUses(), [PROJECT])
})

test('a worktree that could not be made starts nothing, counts nothing and leaves the door open', async () => {
  const { host, started, projectUses, closed } = harness({ ok: false, message: 'fetch timed out' })
  const created = await confirmNewChatWith(host, {
    confirm: { kind: 'general', cli: 'claude-code', worktree: { name: '' } },
    scopedFolder: PROJECT,
    startupPrompt: 'fix the login',
  })
  assert.equal(created, null, 'null hands the prompt back to the panel')
  assert.deepEqual(started, [])
  assert.deepEqual(projectUses(), [])
  assert.equal(closed(), 0)
})

test('a chat started in the background counts too, and keeps New chat up', async () => {
  const { host, projectUses, closed } = harness()
  await confirmNewChatWith(host, { confirm: { kind: 'terminal' }, scopedFolder: PROJECT, background: true })
  assert.deepEqual(projectUses(), [PROJECT])
  assert.equal(closed(), 0)
})

test('a chat with no project counts as no project use', async () => {
  const { host, projectUses } = harness()
  await confirmNewChatWith(host, { confirm: { kind: 'terminal' }, scopedFolder: null })
  assert.deepEqual(projectUses(), [])
})

test('a chat with no project chosen starts in a folder of its own, never with no folder', async () => {
  const { host, started, projectlessPrompts } = harness()
  await confirmNewChatWith(host, { confirm: { kind: 'terminal' }, scopedFolder: null, startupPrompt: 'hello' })
  assert.deepEqual(started, [{ kind: 'terminal', folderPath: CHAT_FOLDER }])
  assert.deepEqual(projectlessPrompts, ['hello'])
})

test('No project starts the chat in a new folder of its own, with no worktree and no project use', async () => {
  const { host, started, opened, projectUses, worktreesMade, closed } = harness()
  const created = await confirmNewChatWith(host, {
    confirm: { ...CHAT_CONFIRM, worktree: { name: '' } },
    scopedFolder: NO_PROJECT,
    startupPrompt: 'hello',
  })
  assert.equal(created, 'ws-conversation')
  assert.deepEqual(started, [{ kind: 'conversation', folderPath: CHAT_FOLDER }])
  assert.deepEqual(opened, [{ worktree: undefined, pending: undefined }], 'never a worktree of the chats folder')
  assert.equal(worktreesMade(), 0)
  assert.deepEqual(projectUses(), [])
  assert.equal(closed(), 1)
})

test('a chat whose own folder could not be made is not started, and the door stays open', async () => {
  const { host, started, closed } = harness(undefined, null)
  const created = await confirmNewChatWith(host, { confirm: CHAT_CONFIRM, scopedFolder: NO_PROJECT })
  assert.equal(created, null)
  assert.deepEqual(started, [])
  assert.equal(closed(), 0)
})

test('an extension starts in its own folder, needs no project, and counts that folder as used', async () => {
  const confirm = {
    kind: 'conversation' as const,
    provider: { providerId: 'claude', modelId: 'default', modelLabel: 'Claude' },
  }
  const made = harness()
  await confirmNewChatWith(made.host, { confirm, scopedFolder: null, extension: { id: 'pr-radar' } })
  assert.deepEqual(made.started, [
    { kind: 'conversation', folderPath: '/Users/dev/Documents/SprintEngine/Extensions/pr-radar' },
  ])
  assert.deepEqual(made.projectUses(), ['/Users/dev/Documents/SprintEngine/Extensions/pr-radar'])

  const picked = harness()
  await confirmNewChatWith(picked.host, {
    confirm,
    scopedFolder: PROJECT,
    extension: { id: 'weekly-summary', folder: '/Users/dev/code/weekly-summary' },
  })
  assert.deepEqual(picked.started, [{ kind: 'conversation', folderPath: '/Users/dev/code/weekly-summary' }])
  assert.deepEqual(picked.projectUses(), ['/Users/dev/code/weekly-summary'], 'not the project the door was on')
})
