// @vitest-environment jsdom
import React, { act } from 'react'
import { createRoot } from 'react-dom/client'
import { afterEach, beforeEach, expect, test } from 'vitest'

import { ConfirmDialogProvider } from '../components/ui/ConfirmDialog'
import { useWorkspaceStore } from '../store/workspaceStore'
import { useToastStore } from '../store/toastStore'
import { useDeleteSettledChats } from './useDeleteSettledChats'

// A settled chat opened here from a paired machine that deletes its chats
// from here is deleted there, as that machine plans it and after the person
// confirms what goes, and then this computer's record of it goes too.

let host: HTMLElement | null = null
const calls: Array<[string, unknown]> = []

beforeEach(() => {
  ;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true
  calls.length = 0
  useToastStore.setState({ toasts: [] })
  useWorkspaceStore.setState({
    workspaces: [
      {
        id: 'w-followed',
        name: 'Parser review',
        mode: 'standard',
        folderPath: null,
        agents: {},
        settledAt: 1,
        remoteOrigin: {
          connectionId: 'c1',
          machineName: 'mac-mini',
          workspaceId: 'rw4',
          workspaceName: 'parser',
          workspaceRoot: '/Users/dev/parser',
          sessionId: 'conversation:rw4:agent-1',
        },
      },
    ] as never,
  })
})

afterEach(() => {
  host?.remove()
  host = null
})

function api(plan: Record<string, unknown>) {
  ;(window as unknown as { api: unknown }).api = {
    meshConversationDeletePlan: async (input: unknown) => {
      calls.push(['plan', input])
      return plan
    },
    meshChangeConversation: async (input: unknown) => {
      calls.push(['delete there', input])
      return { ok: true, workspaceId: 'rw4' }
    },
    deleteSettledChats: async (ids: string[]) => {
      calls.push(['remove here', ids])
      return ids.map((workspaceId) => ({ workspaceId, ok: true, worktrees: [] }))
    },
  }
}

async function mount() {
  let deleteThere: ((id: string) => Promise<boolean>) | null = null
  function Probe() {
    deleteThere = useDeleteSettledChats().deleteThere
    return null
  }
  host = document.createElement('div')
  document.body.appendChild(host)
  const root = createRoot(host)
  await act(async () =>
    root.render(
      <ConfirmDialogProvider>
        <Probe />
      </ConfirmDialogProvider>,
    ),
  )
  return { run: (id: string) => deleteThere!(id), root }
}

const settle = () => act(async () => new Promise((resolve) => setTimeout(resolve, 0)))

test('a paired machine’s settled chat is deleted there after the person confirms, then here', async () => {
  api({
    ok: true,
    workspaceId: 'rw4',
    worktrees: [
      {
        name: 'chat-k_iq',
        branch: 'agent/chat-k_iq',
        pooled: false,
        changedPaths: 0,
        unpushedCommits: 2,
        fate: 'remove',
      },
    ],
  })
  const { run, root } = await mount()
  let done: Promise<boolean> | null = null
  await act(async () => {
    done = run('w-followed')
  })
  await settle()
  const dialog = document.body.querySelector('[role="dialog"], [role="alertdialog"]')
  expect(dialog?.textContent).toContain('Delete “Parser review” on mac-mini?')
  expect(dialog?.textContent).toContain('chat-k_iq')
  const confirm = [...document.body.querySelectorAll('button')].find((button) => button.textContent === 'Delete')
  await act(async () => confirm!.click())
  expect(await done!).toBe(true)
  expect(calls).toEqual([
    ['plan', { connectionId: 'c1', workspaceId: 'rw4' }],
    ['delete there', { connectionId: 'c1', workspaceId: 'rw4', change: { kind: 'delete' } }],
    ['remove here', ['w-followed']],
  ])
  await act(async () => root.unmount())
})

test('a chat its machine will not delete now is said so, and nothing goes', async () => {
  api({ ok: true, workspaceId: 'rw4', worktrees: [], refused: 'An agent in this chat is still working.' })
  const { run, root } = await mount()
  let gone = true
  await act(async () => {
    gone = await run('w-followed')
  })
  expect(gone).toBe(false)
  expect(calls.map(([kind]) => kind)).toEqual(['plan'])
  expect(useToastStore.getState().toasts.at(-1)?.description).toBe('An agent in this chat is still working.')
  await act(async () => root.unmount())
})
