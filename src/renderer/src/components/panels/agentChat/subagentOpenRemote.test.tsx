// @vitest-environment jsdom
import React, { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, expect, test } from 'vitest'

import type { TranscriptToolEntry } from './conversationProjection'
import { ConversationLinkProvider } from './conversationLinks'
import {
  ConversationTransportProvider,
  useConversationTransport,
  type ConversationTransport,
} from './conversationTransport'
import { SubagentLane } from './timelineRows'
import { readAgentFocusRequest } from '../../workspace/pane/agents/agentsPaneFocus'

// An agent of a chat followed from a paired machine opens in the Agents tab,
// as one of a chat here does: the tab reads that chat through its pane
// (`publishRemoteChat`), by its agent id on that machine.

const lane: TranscriptToolEntry = {
  kind: 'tool',
  id: 'toolu_agent',
  turnId: 't1',
  name: 'Agent',
  toolKind: 'subagent',
  subagentLane: true,
  subagentType: 'Explore',
  input: { description: 'Find the flaky test', prompt: 'Look for it' },
  status: 'done',
  startedAt: 1_000,
  completedAt: 2_000,
  agent: { state: 'completed' },
}

let root: Root | null = null
let host: HTMLElement | null = null

beforeEach(() => {
  ;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true
})

afterEach(async () => {
  await act(async () => root?.unmount())
  host?.remove()
  root = null
  host = null
})

function Remote({ children }: { children: React.ReactNode }) {
  const local = useConversationTransport()
  const remote: ConversationTransport = {
    ...local,
    kind: 'remote',
    capabilities: { ...local.capabilities, localFiles: false },
  }
  return <ConversationTransportProvider value={remote}>{children}</ConversationTransportProvider>
}

test('an agent of a paired machine’s chat opens in the Agents tab', async () => {
  host = document.createElement('div')
  document.body.appendChild(host)
  root = createRoot(host)
  await act(async () =>
    root!.render(
      <Remote>
        <ConversationLinkProvider workspaceId="w-followed" agentId="agent-there" cwd="" workspaceRoot="">
          <SubagentLane tool={lane} />
        </ConversationLinkProvider>
      </Remote>,
    ),
  )
  const open = host.querySelector<HTMLButtonElement>('button[aria-label$="in Agents"]')
  expect(open).not.toBeNull()
  await act(async () => open!.click())
  expect(readAgentFocusRequest('w-followed')).toMatchObject({ agentId: 'agent-there', laneId: 'toolu_agent' })
})
