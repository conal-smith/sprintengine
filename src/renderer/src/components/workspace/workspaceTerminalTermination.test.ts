import assert from 'node:assert/strict'

import { test } from 'vitest'

import type { Workspace } from '../../types/workspace'
import { suspendSnoozedWorkspaceTerminals, terminateSettledWorkspaceTerminals } from './workspaceTerminalTermination'

// Settle's kill waits on main's answer about what is working; a chat the
// person un-settled during that round trip keeps its agents.

test('a chat un-settled while main is asked is not killed; one still settled is', async () => {
  const killed: string[] = []
  Object.assign(globalThis, {
    window: {
      api: {
        terminalList: async () => [],
        conversationSessionsList: async () => ({ ok: true, sessions: [] }),
        terminalKill: async (sessionId: string) => {
          killed.push(sessionId)
        },
      },
    },
  })
  const workspace = {
    id: 'ws-1',
    agents: { a: { cliSessionId: 'pty-1' } },
    layoutModel: {},
  } as unknown as Workspace
  assert.equal(await terminateSettledWorkspaceTerminals(workspace, () => false), false)
  assert.deepEqual(killed, [], 'un-settled meanwhile: nothing killed')
  assert.equal(await terminateSettledWorkspaceTerminals(workspace, () => true), true)
  assert.deepEqual(killed, ['pty-1'])
})

// Snooze's suspend interrupts a running turn, and the gesture only knew what
// the sidebar last drew. Main is asked first, as for Settle's kill: an agent
// working by then keeps its processes, and so does a chat woken meanwhile.
test('a Snooze pauses nothing while main says an agent is working, nor once the chat is woken', async () => {
  const suspended: string[] = []
  let working = true
  Object.assign(globalThis, {
    window: {
      api: {
        terminalList: async () => [],
        conversationSessionsList: async () => ({
          ok: true,
          sessions: [
            {
              sessionId: 'chat-1',
              workspaceId: 'ws-1',
              agentId: 'a',
              status: 'ready',
              backgroundAgents: working ? 1 : 0,
            },
          ],
        }),
        terminalSuspend: async (sessionId: string) => {
          suspended.push(sessionId)
        },
        conversationSessionSuspend: async ({ sessionId }: { sessionId: string }) => {
          suspended.push(sessionId)
          return { ok: true }
        },
      },
    },
  })
  const workspace = {
    id: 'ws-1',
    agents: { a: { cliSessionId: 'pty-1' } },
    layoutModel: {},
  } as unknown as Workspace
  assert.equal(await suspendSnoozedWorkspaceTerminals(workspace), 'working')
  assert.deepEqual(suspended, [], 'an agent working when main is asked is not cut off')
  working = false
  assert.equal(await suspendSnoozedWorkspaceTerminals(workspace, () => false), 'woken')
  assert.deepEqual(suspended, [], 'woken meanwhile: nothing paused')
  assert.equal(await suspendSnoozedWorkspaceTerminals(workspace, () => true), 'suspended')
  assert.deepEqual(suspended.sort(), ['chat-1', 'pty-1'])
})
