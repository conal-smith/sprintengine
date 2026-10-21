import assert from 'node:assert/strict'

import { test } from 'vitest'

import { CHAT_EXPORT_CHANNEL, type ChatExportInput } from '../../shared/chat-export'
import { registerChatExportIpc } from './chat-export-ipc'

// The export channel takes a chat and a format, checks both, and passes on
// nothing else: no path or text a window sends reaches the export.

type Handler = (event: unknown, ...args: unknown[]) => Promise<unknown>

function setup(options: { foreign?: boolean } = {}) {
  const handlers = new Map<string, Handler>()
  const runs: ChatExportInput[] = []
  registerChatExportIpc({ handle: (channel: string, handler: Handler) => handlers.set(channel, handler) } as never, {
    run: async (input) => {
      runs.push(input)
      return { ok: true, kind: 'copied' }
    },
    assertSender: () => {
      if (options.foreign) throw new Error('This request did not come from a SprintEngine Studio window.')
    },
  })
  const handler = handlers.get(CHAT_EXPORT_CHANNEL)
  assert.ok(handler, 'the channel is registered')
  return { invoke: (payload: unknown) => handler({ sender: {} }, payload), runs }
}

test('a chat and a format pass, and only they do', async () => {
  const { invoke, runs } = setup()
  const result = await invoke({
    workspaceId: 'workspace-1',
    agentId: 'agent-1',
    action: 'pdf',
    path: '/etc/hosts',
    text: 'injected',
  })
  assert.deepEqual(result, { ok: true, kind: 'copied' })
  assert.deepEqual(runs, [{ workspaceId: 'workspace-1', agentId: 'agent-1', action: 'pdf' }])
})

test('every action the menu offers is accepted', async () => {
  const { invoke, runs } = setup()
  for (const action of ['pdf', 'docx', 'markdown', 'copy', 'copy-markdown'])
    await invoke({ workspaceId: 'workspace-1', agentId: 'agent-1', action })
  assert.equal(runs.length, 5)
})

test('a malformed request is answered in words and runs nothing', async () => {
  const { invoke, runs } = setup()
  assert.deepEqual(await invoke(null), { ok: false, message: 'Export input must be an object.' })
  assert.deepEqual(await invoke([]), { ok: false, message: 'Export input must be an object.' })
  assert.deepEqual(await invoke({ agentId: 'agent-1', action: 'pdf' }), {
    ok: false,
    message: 'A workspace id is required.',
  })
  assert.deepEqual(await invoke({ workspaceId: 'workspace-1', agentId: ' ', action: 'pdf' }), {
    ok: false,
    message: 'A chat id is required.',
  })
  assert.deepEqual(await invoke({ workspaceId: 'workspace-1', agentId: 'agent-1', action: 'exe' }), {
    ok: false,
    message: 'That is not a format a chat exports as.',
  })
  assert.deepEqual(await invoke({ workspaceId: 'w'.repeat(300), agentId: 'agent-1', action: 'pdf' }), {
    ok: false,
    message: 'A workspace id is required.',
  })
  assert.equal(runs.length, 0)
})

test('only the app’s own window is answered', async () => {
  const { invoke, runs } = setup({ foreign: true })
  await assert.rejects(
    invoke({ workspaceId: 'workspace-1', agentId: 'agent-1', action: 'pdf' }),
    /SprintEngine Studio window/u,
  )
  assert.equal(runs.length, 0)
})

test('an export that throws is an answer, not a dropped request', async () => {
  const handlers = new Map<string, Handler>()
  registerChatExportIpc({ handle: (channel: string, handler: Handler) => handlers.set(channel, handler) } as never, {
    run: async () => {
      throw new Error('The page for the PDF did not load.')
    },
    assertSender: () => undefined,
  })
  assert.deepEqual(
    await handlers.get(CHAT_EXPORT_CHANNEL)!({ sender: {} }, { workspaceId: 'w', agentId: 'a', action: 'pdf' }),
    { ok: false, message: 'The page for the PDF did not load.' },
  )
})
