// @vitest-environment jsdom
//
// The open chat's local servers on the composer's strip: drawn only for a
// conversation whose agents linked one, in words, at the line's pinned end
// beside the pull request slot and the context ring.
import React, { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, expect, test } from 'vitest'

import type { StudioLocalServer } from '../../../../../../packages/studio-protocol/src/public'
import { ConversationComposerStrip } from './conversationStrip'
import { localPullRequestHost } from './pullRequestHost'

function server(overrides: Partial<StudioLocalServer> = {}): StudioLocalServer {
  return {
    id: 'srv-1',
    agentId: 'agent-1',
    url: 'http://localhost:5173/',
    title: 'localhost:5173',
    port: 5173,
    state: 'running',
    linkedAt: 1,
    stateAt: 1,
    command: 'npm run dev',
    ...overrides,
  }
}

let root: Root | null = null
let host: HTMLElement | null = null

beforeEach(() => {
  ;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true
  ;(window as unknown as { api: unknown }).api = {}
})

afterEach(async () => {
  await act(async () => root?.unmount())
  host?.remove()
  root = null
  host = null
})

async function render(node: React.ReactNode): Promise<HTMLElement> {
  await act(async () => root?.unmount())
  host?.remove()
  host = document.createElement('div')
  document.body.append(host)
  root = createRoot(host)
  await act(async () => root!.render(node))
  return host
}

test('a conversation with no servers draws nothing for them', async () => {
  const none = await render(
    <ConversationComposerStrip
      machine={null}
      branch={null}
      changes={null}
      context={null}
      localServers={{ workspaceId: 'ws-1', servers: [] }}
    />,
  )
  expect(none.innerHTML).toBe('')
})

test('one server is named with its state, before the ring', async () => {
  const one = await render(
    <ConversationComposerStrip
      machine={null}
      branch={null}
      changes={null}
      context={{ used: 40_000, total: 200_000 }}
      localServers={{ workspaceId: 'ws-1', servers: [server()] }}
    />,
  )
  const button = one.querySelector('[data-strip-local-servers]')
  expect(button?.textContent).toBe('localhost:5173·Running')
  expect(button?.getAttribute('aria-label')).toBe('Local server localhost:5173, running')
  const slots = Array.from(one.querySelectorAll('[data-strip-local-servers-slot], [data-strip-context]'))
  expect(slots.map((slot) => slot.hasAttribute('data-strip-context'))).toEqual([false, true])
})

test('several servers are counted with how many are up', async () => {
  const many = await render(
    <ConversationComposerStrip
      machine={null}
      branch={null}
      changes={null}
      context={null}
      localServers={{
        workspaceId: 'ws-1',
        servers: [
          server(),
          server({ id: 'srv-2', title: 'Storybook', url: 'http://localhost:6006/', port: 6006, state: 'stopped' }),
        ],
      }}
    />,
  )
  expect(many.querySelector('[data-strip-local-servers]')?.textContent).toBe('2 servers·1 running')
})

test("one item takes the line's slack, so the pinned end sits together: Create PR and the ring", async () => {
  const strip = await render(
    <ConversationComposerStrip
      machine={null}
      branch={null}
      changes={null}
      context={{ used: 40_000, total: 200_000 }}
      createPullRequest={{
        host: localPullRequestHost('/Users/dev/app', { workspaceId: 'ws-1', agentId: 'agent-1' }),
        onSettled: () => undefined,
      }}
    />,
  )
  expect(strip.querySelector('[data-strip-pull-request-slot]')).not.toBeNull()
  expect(strip.querySelectorAll('.ml-auto').length).toBe(1)
})
