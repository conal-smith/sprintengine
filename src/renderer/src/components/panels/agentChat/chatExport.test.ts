// @vitest-environment jsdom
import { afterEach, expect, test, vi } from 'vitest'

import type { ChatExportInput, ChatExportRemoteSource } from '../../../../../shared/chat-export'
import { useToastStore } from '../../../store/toastStore'
import { exportChatOrToast } from './chatExport'

// A chat followed from a paired machine is exported from its transcript
// there: the window reads it first and hands it to main with the request,
// and a read that fails is said as any failed export is.

const source: ChatExportRemoteSource = {
  events: [],
  title: 'Parser review',
  project: 'parser',
  providerId: 'claude-agent',
  modelId: 'default',
  workspaceRoot: '/Users/dev/parser',
}

afterEach(() => {
  useToastStore.setState({ toasts: [] })
})

test('a paired machine’s chat goes to main with what was read from there', async () => {
  const asked: ChatExportInput[] = []
  ;(window as unknown as { api: unknown }).api = {
    exportChat: async (input: ChatExportInput) => {
      asked.push(input)
      return { ok: true, kind: 'copied' }
    },
  }
  const read = vi.fn(async () => source)
  await exportChatOrToast({ workspaceId: 'w-followed', agentId: 'agent-there', action: 'copy', remote: read })
  expect(read).toHaveBeenCalledOnce()
  expect(asked).toEqual([{ workspaceId: 'w-followed', agentId: 'agent-there', action: 'copy', remote: source }])
  expect(useToastStore.getState().toasts.some((toast) => toast.title === 'Chat copied')).toBe(true)
})

test('a transcript that could not be read from there is said, and main is not asked', async () => {
  const exportChat = vi.fn()
  ;(window as unknown as { api: unknown }).api = { exportChat }
  await exportChatOrToast({
    workspaceId: 'w-followed',
    agentId: 'agent-there',
    action: 'pdf',
    remote: async () => {
      throw new Error('mac-mini is offline.')
    },
  })
  expect(exportChat).not.toHaveBeenCalled()
  expect(useToastStore.getState().toasts).toEqual(
    expect.arrayContaining([
      expect.objectContaining({ title: 'Could not export the chat', description: 'mac-mini is offline.' }),
    ]),
  )
})
