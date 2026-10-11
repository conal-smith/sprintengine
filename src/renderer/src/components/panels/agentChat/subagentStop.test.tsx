// @vitest-environment jsdom
import React, { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, expect, test, vi } from 'vitest'

import type { TranscriptToolEntry } from './conversationProjection'
import { SubagentStopProvider } from './subagentStatus'
import { SubagentLane } from './timelineRows'

// A running agent's lane offers to stop that agent alone, says so while the
// stop is on its way, and offers nothing once the agent has ended.

const lane = (extra: Partial<TranscriptToolEntry> = {}): TranscriptToolEntry => ({
  kind: 'tool',
  id: 'toolu_agent',
  turnId: 't1',
  name: 'Agent',
  toolKind: 'subagent',
  subagentLane: true,
  subagentType: 'Explore',
  input: { description: 'Find the flaky test', prompt: 'Look for it' },
  status: 'running',
  startedAt: 1_000,
  agent: { state: 'running', taskId: 'task_1' },
  ...extra,
})

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

async function mount(tool: TranscriptToolEntry, stop: ((laneId: string) => Promise<boolean>) | null) {
  host = document.createElement('div')
  document.body.appendChild(host)
  root = createRoot(host)
  await act(async () =>
    root!.render(
      <SubagentStopProvider value={stop}>
        <SubagentLane tool={tool} />
      </SubagentStopProvider>,
    ),
  )
}

const stopButton = () =>
  host!.querySelector<HTMLButtonElement>(
    'button[aria-label="Stop this agent"], button[aria-label="Stopping this agent"]',
  )

test('a running agent’s lane offers to stop that agent', async () => {
  const stop = vi.fn(async () => true)
  await mount(lane(), stop)
  const button = stopButton()
  expect(button?.getAttribute('aria-label')).toBe('Stop this agent')
  expect(button?.disabled).toBe(false)
  await act(async () => button!.click())
  expect(stop).toHaveBeenCalledWith('toolu_agent')
})

test('asked to stop, the control says it is stopping until the lane ends', async () => {
  let answer = (_asked: boolean): void => undefined
  const stop = vi.fn(() => new Promise<boolean>((resolve) => (answer = resolve)))
  await mount(lane(), stop)
  await act(async () => stopButton()!.click())
  expect(stopButton()?.getAttribute('aria-label')).toBe('Stopping this agent')
  expect(stopButton()?.getAttribute('aria-busy')).toBe('true')
  expect(stopButton()?.disabled).toBe(true)
  // The chat took the stop: it stays that way until the agent reports.
  await act(async () => answer(true))
  expect(stopButton()?.getAttribute('aria-label')).toBe('Stopping this agent')
  // The agent reported itself stopped: the lane has nothing left to stop.
  await act(async () =>
    root!.render(
      <SubagentStopProvider value={stop}>
        <SubagentLane
          tool={lane({ status: 'done', completedAt: 9_000, outputStatus: 'stopped', agent: { state: 'stopped' } })}
        />
      </SubagentStopProvider>,
    ),
  )
  expect(stopButton()).toBeNull()
})

test('a stop the chat refused offers the control again', async () => {
  const stop = vi.fn(async () => false)
  await mount(lane(), stop)
  await act(async () => stopButton()!.click())
  expect(stopButton()?.getAttribute('aria-label')).toBe('Stop this agent')
  expect(stopButton()?.disabled).toBe(false)
})

test('an ended agent’s lane, or a chat that cannot stop one agent, offers no stop', async () => {
  await mount(lane({ status: 'done', completedAt: 9_000, outputStatus: 'ok', agent: { state: 'completed' } }), vi.fn())
  expect(stopButton()).toBeNull()
  await act(async () => root!.render(<SubagentLane tool={lane()} />))
  expect(stopButton()).toBeNull()
})
