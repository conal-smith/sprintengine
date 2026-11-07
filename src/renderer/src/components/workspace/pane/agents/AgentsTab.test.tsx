import { JSDOM } from 'jsdom'
import { expect, test } from 'vitest'
import type {
  ConversationEvent,
  ConversationEventType,
  ConversationSessionFrame,
} from '../../../../../../shared/conversation-runtime'
import type { MeshConversationFrame, MeshConversationKey, MeshSubagent } from '../../../../../../shared/tailnet-mesh'
import type { ConversationSessionEntry } from '../../../../hooks/conversationSessionsStore'
import type { ConversationTransport } from '../../../panels/agentChat/conversationTransport'
import { latestSessionOf } from './studioSubagents'

let seq = 0
function event(type: ConversationEventType, payload: Record<string, unknown>): ConversationEvent {
  seq++
  return {
    id: `event-${seq}`,
    seq,
    sessionId: 'session',
    workspaceId: 'workspace',
    agentId: 'agent',
    providerId: 'claude-agent',
    modelId: 'sonnet',
    type,
    createdAt: seq * 1000,
    payload,
  }
}

// A chat that sent two agents off: one still working (a step in, reporting what
// it is doing), one finished with its report.
const transcript = [
  event('session_updated', {
    providerSessionId: 'native',
    agents: [{ name: 'Explore', description: 'Fast read-only search agent for locating code.' }],
  }),
  event('turn_started', { turnId: 'turn-1' }),
  event('tool_started', {
    turnId: 'turn-1',
    toolCallId: 'lane-find',
    tool: 'Agent',
    subagentLane: true,
    subagentType: 'Explore',
    input: { description: 'Find the router', subagent_type: 'Explore' },
  }),
  event('subagent_status', { toolUseId: 'lane-find', status: 'running', background: true }),
  event('tool_started', {
    turnId: 'turn-1',
    toolCallId: 'lane-plan',
    tool: 'Agent',
    subagentLane: true,
    subagentType: 'Plan',
    input: { description: 'Plan the migration', subagent_type: 'Plan' },
  }),
  event('subagent_status', { toolUseId: 'lane-plan', status: 'running', background: true }),
  event('turn_completed', { turnId: 'turn-1' }),
  event('tool_started', {
    turnId: 'turn-1',
    toolCallId: 'grep-1',
    tool: 'Grep',
    summary: 'Grep: createRouter',
    parentToolUseId: 'lane-find',
  }),
  event('subagent_status', {
    toolUseId: 'lane-find',
    status: 'running',
    progressSummary: 'Searching for the router',
    usage: { totalTokens: 9_000, toolUses: 1, durationMs: 2_000 },
  }),
  event('tool_output', { toolCallId: 'lane-plan', output: 'Move the tables first.', backgroundResult: true }),
  event('subagent_status', {
    toolUseId: 'lane-plan',
    status: 'completed',
    usage: { totalTokens: 21_000, toolUses: 4, durationMs: 9_000 },
  }),
]

// Rows the live-row hook watches, so a test can scroll one out of view.
const observed = new Map<Element, (entries: Array<{ target: Element; isIntersecting: boolean }>) => void>()
class FakeIntersectionObserver {
  constructor(private readonly callback: (entries: Array<{ target: Element; isIntersecting: boolean }>) => void) {}
  observe(target: Element) {
    observed.set(target, this.callback)
  }
  unobserve(target: Element) {
    observed.delete(target)
  }
  disconnect() {
    observed.clear()
  }
}

async function mountAgentsTab({
  focused = true,
  subagents = {},
}: { focused?: boolean; subagents?: Record<string, unknown> } = {}) {
  const dom = new JSDOM('<!doctype html><body></body>', { url: 'http://localhost', pretendToBeVisual: true })
  const previous = Object.getOwnPropertyDescriptors(globalThis)
  const globals = {
    window: dom.window,
    document: dom.window.document,
    navigator: dom.window.navigator,
    HTMLElement: dom.window.HTMLElement,
    Element: dom.window.Element,
    Node: dom.window.Node,
    getComputedStyle: dom.window.getComputedStyle.bind(dom.window),
    requestAnimationFrame: dom.window.requestAnimationFrame.bind(dom.window),
    cancelAnimationFrame: dom.window.cancelAnimationFrame.bind(dom.window),
    IntersectionObserver: FakeIntersectionObserver,
    IS_REACT_ACT_ENVIRONMENT: true,
  }
  Object.assign(globalThis, globals)
  const frames: ((frame: ConversationSessionFrame) => void)[] = []
  // What a chat on a paired machine is followed through, by the agent it names.
  const followed = new Map<string, (frame: MeshConversationFrame) => void>()
  const resolved: unknown[] = []
  Object.assign(dom.window, {
    matchMedia: () => ({ matches: true, addEventListener: () => undefined, removeEventListener: () => undefined }),
    api: {
      platform: 'darwin',
      onConversationSession: (_input: unknown, receive: (frame: ConversationSessionFrame) => void) => {
        frames.push(receive)
        return () => undefined
      },
      onMeshConversationSession: (
        input: { key: MeshConversationKey },
        receive: (frame: MeshConversationFrame) => void,
      ) => {
        followed.set(input.key.agentId, receive)
        return () => undefined
      },
      meshConversationResolveApproval: async (input: unknown) => {
        resolved.push(input)
        return { ok: true }
      },
    },
  })
  const { act, createElement } = await import('react')
  const { createRoot } = await import('react-dom/client')
  const { useWorkspaceStore } = await import('../../../../store/workspaceStore')
  const { AgentsTab } = await import('./AgentsTab')
  useWorkspaceStore.setState({
    workspaces: [
      {
        id: 'workspace',
        name: 'Project',
        folderPath: '/Users/dev/project',
        agents: {
          agent: {
            id: 'agent',
            name: 'Router work',
            runtimeKind: 'conversation',
            conversation: { providerId: 'claude-agent', modelId: 'sonnet' },
          },
          ...subagents,
        },
      },
    ] as never,
    focusedAgentByWorkspaceId: focused ? { workspace: 'agent' } : {},
  })
  const host = dom.window.document.createElement('div')
  dom.window.document.body.appendChild(host)
  const root = createRoot(host)
  await act(async () => root.render(createElement(AgentsTab, { workspaceId: 'workspace', active: true })))
  return {
    host,
    act,
    async setActive(active: boolean) {
      await act(async () => root.render(createElement(AgentsTab, { workspaceId: 'workspace', active })))
    },
    async deliver(events: ConversationEvent[]) {
      await act(async () => {
        frames.at(-1)?.({ type: 'snapshot', page: { events, hasMore: false, beforeCursor: null } })
        frames.at(-1)?.({ type: 'synchronized', seq: events.at(-1)?.seq ?? 0 })
      })
    },
    button: (label: string) =>
      Array.from(host.querySelectorAll('button')).find((item) => item.textContent?.includes(label)),
    subscriptions: () => frames.length,
    followed,
    resolved,
    async unmount() {
      await act(async () => root.unmount())
      dom.window.close()
      for (const key of Object.keys(globals)) {
        if (previous[key]) Object.defineProperty(globalThis, key, previous[key])
        else Reflect.deleteProperty(globalThis, key)
      }
    },
  }
}

test('with no chat in focus the tab says where agents come from', async () => {
  const tab = await mountAgentsTab({ focused: false })
  try {
    expect(tab.host.textContent).toContain('No chat in focus')
    expect(tab.subscriptions()).toBe(0)
  } finally {
    await tab.unmount()
  }
})

test('the focused chat’s agents are listed working first, and one opens onto its own thread', async () => {
  const tab = await mountAgentsTab()
  try {
    await tab.deliver(transcript)
    const text = tab.host.textContent ?? ''
    expect(text).toContain('Router work')
    expect(text).toContain('Working · 1')
    expect(text).toContain('Finished · 1')
    expect(text).toContain('Find the router')
    expect(text).toContain('Searching for the router')
    expect(text).toContain('Plan the migration')
    expect(text).toContain('Done in')
    expect(text).toContain('Move the tables first.')
    expect(text).toContain('1 working · 1 finished · 30k tokens')
    expect(text.indexOf('Find the router')).toBeLessThan(text.indexOf('Plan the migration'))

    await tab.act(async () => tab.button('Find the router')!.click())
    const thread = tab.host.textContent ?? ''
    expect(thread).toContain('‹ All agents')
    expect(thread).toContain('Fast read-only search agent for locating code.')
    expect(thread).toContain('Now: Searching for the router')
    expect(thread).toContain('Steps')
    expect(thread).toContain('createRouter')
    expect(thread).not.toContain('Report')

    await tab.act(async () => tab.button('All agents')!.click())
    expect(tab.host.textContent).toContain('Finished · 1')
  } finally {
    await tab.unmount()
  }
})

test('a chat asking for one of its agents opens the tab on that agent', async () => {
  const tab = await mountAgentsTab()
  try {
    await tab.deliver(transcript)
    const { openAgentsPane } = await import('./agentsPaneFocus')
    await tab.act(async () => openAgentsPane('workspace', 'agent', 'lane-plan'))
    const thread = tab.host.textContent ?? ''
    expect(thread).toContain('‹ All agents')
    expect(thread).toContain('Plan the migration')
    expect(thread).toContain('Report')
    expect(thread).toContain('It took no steps of its own.')
  } finally {
    await tab.unmount()
  }
})

test('an agent’s words sit before the step they lead into, and its report is not said twice', async () => {
  const { placeAgentMessages } = await import('./AgentsTab')
  const lane = {
    kind: 'tool' as const,
    id: 'lane',
    turnId: 'turn',
    name: 'Agent',
    status: 'done' as const,
    subagentLane: true,
    output: 'The router lives in src/router.ts.\n\nIt exports createRouter.',
    children: [
      { kind: 'tool' as const, id: 'grep', turnId: 'turn', name: 'Grep', status: 'done' as const, startedAt: 20 },
      { kind: 'tool' as const, id: 'read', turnId: 'turn', name: 'Read', status: 'done' as const, startedAt: 40 },
    ],
    messages: [
      { at: 10, text: 'Searching for the router.' },
      { at: 30, text: 'Found a candidate; reading it.' },
      { at: 50, text: 'One more note.' },
      { at: 60, text: 'The router lives in src/router.ts.' },
    ],
  }
  expect(placeAgentMessages(lane)).toEqual({
    beforeSteps: [
      { text: 'Searching for the router.', beforeToolUseId: 'grep', at: 10 },
      { text: 'Found a candidate; reading it.', beforeToolUseId: 'read', at: 30 },
    ],
    afterSteps: [{ text: 'One more note.', at: 50 }],
  })
  // While it works, nothing it said is its report yet.
  expect(placeAgentMessages({ ...lane, status: 'running' }).afterSteps).toEqual([
    { text: 'One more note.', at: 50 },
    { text: 'The router lives in src/router.ts.', at: 60 },
  ])
})

test('an agent’s thread says when it said each thing and when each step ran, as the chat does on hover', async () => {
  const tab = await mountAgentsTab()
  try {
    const said = event('subagent_message', { parentToolUseId: 'lane-find', text: 'The router is in src/router.ts.' })
    await tab.deliver([...transcript, said])
    await showList(tab)
    await tab.act(async () => tab.button('Find the router')!.click())
    const { formatMessageDateTime } = await import('../../../panels/agentChat/liveElapsed')
    const times = Array.from(tab.host.querySelectorAll('time'))
    const message = times.find((time) => time.dateTime === new Date(said.createdAt).toISOString())
    expect(message, 'the message carries its time').toBeDefined()
    expect(message!.querySelector('.sr-only')?.textContent).toBe(formatMessageDateTime(said.createdAt))
    expect(message!.closest('.group\\/conversation')?.textContent).toContain('The router is in src/router.ts.')
    // The step it is still running says when it started.
    const grep = transcript.find((item) => item.type === 'tool_started' && item.payload?.toolCallId === 'grep-1')!
    const step = times.find((time) => time.dateTime === new Date(grep.createdAt).toISOString())
    expect(step?.querySelector('.sr-only')?.textContent).toBe(`Started ${formatMessageDateTime(grep.createdAt)}`)
  } finally {
    await tab.unmount()
  }
})

const anotherLane = () => [
  event('tool_started', {
    turnId: 'turn-1',
    toolCallId: 'lane-tests',
    tool: 'Agent',
    subagentLane: true,
    subagentType: 'Plan',
    input: { description: 'Write the tests', subagent_type: 'Plan' },
  }),
  event('subagent_status', { toolUseId: 'lane-tests', status: 'running', background: true }),
]
const pause = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms))
// An earlier test asked the tab to open one agent's thread; start from the list.
async function showList(tab: Awaited<ReturnType<typeof mountAgentsTab>>) {
  const back = tab.button('All agents')
  if (back) await tab.act(async () => back.click())
}

test('a hidden tab holds what it showed and catches up when it is shown', async () => {
  const tab = await mountAgentsTab()
  try {
    await tab.deliver(transcript)
    await showList(tab)
    expect(tab.host.textContent).toContain('Working · 1')
    await tab.setActive(false)
    await tab.deliver([...transcript, ...anotherLane()])
    await tab.act(() => pause(500))
    expect(tab.host.textContent).not.toContain('Write the tests')
    await tab.setActive(true)
    expect(tab.host.textContent).toContain('Write the tests')
    expect(tab.host.textContent).toContain('Working · 2')
  } finally {
    await tab.unmount()
  }
})

test('a tab out of sight in an open pane rests its subscription too, and catches up when seen', async () => {
  const tab = await mountAgentsTab()
  try {
    await tab.deliver(transcript)
    await showList(tab)
    // The pane is open on this tab, but the view is out of the viewport (a
    // warm workspace layer or a pane pushed off screen says the same).
    const view = tab.host.firstElementChild!
    await tab.act(async () => observed.get(view)?.([{ target: view, isIntersecting: false }]))
    await tab.deliver([...transcript, ...anotherLane()])
    await tab.act(() => pause(500))
    expect(tab.host.textContent).not.toContain('Write the tests')
    await tab.act(async () => observed.get(view)?.([{ target: view, isIntersecting: true }]))
    await tab.act(() => pause(500))
    expect(tab.host.textContent).toContain('Write the tests')
  } finally {
    await tab.unmount()
  }
})

test('while the chat streams, the lanes follow on a short beat rather than every event', async () => {
  const tab = await mountAgentsTab()
  try {
    await tab.deliver(transcript)
    await showList(tab)
    await tab.deliver([...transcript, ...anotherLane()])
    expect(tab.host.textContent).not.toContain('Write the tests')
    await tab.act(() => pause(500))
    expect(tab.host.textContent).toContain('Write the tests')
  } finally {
    await tab.unmount()
  }
})

test('a working agent reads as its model, and is held by the live-row motion rule, as a transcript lane is', async () => {
  const tab = await mountAgentsTab()
  try {
    await tab.deliver(transcript)
    await showList(tab)
    const row = tab.button('Find the router')!
    expect(row.querySelector('svg path')?.getAttribute('fill')).toBe('#D97757') // design-tokens-allow: the maker's own mark
    expect(row.querySelector('.agent-glyph')).toBeNull()
    // The row only says it is out of view; the stylesheet's pause rule holds
    // what moves in it still, and nothing is written inline to beat that rule.
    expect(row.hasAttribute('data-live-offscreen'), 'on screen, the row is unmarked').toBe(false)
    await tab.act(async () => observed.get(row)?.([{ target: row, isIntersecting: false }]))
    expect(row.hasAttribute('data-live-offscreen'), 'scrolled away, the row is marked').toBe(true)
    const inline = [...row.querySelectorAll<HTMLElement>('*')].map((el) => el.style.animationPlayState)
    expect(inline.filter(Boolean)).toEqual([])
  } finally {
    await tab.unmount()
  }
})

const reviewer = {
  id: 'agent-reviewer',
  name: 'Cursor · muse-wonder-1.0',
  runtimeKind: 'conversation',
  conversation: { providerId: 'cursor-agent', modelId: 'muse-wonder-1.0[context=300k,reasoning_effort=high]' },
  subagentOf: { agentId: 'agent', startedAt: 1_000, task: 'Review the calendar screen' },
  subagentReadOnly: true,
  subagentEnd: { at: 91_000, status: 'completed' },
}
const failedReviewer = {
  ...reviewer,
  id: 'agent-failed',
  name: 'Cursor · grok-4.7',
  conversation: { providerId: 'cursor-agent', modelId: 'grok-4.7[context=256k,reasoning_effort=high,fast=true]' },
  subagentReadOnly: undefined,
  subagentOf: { agentId: 'agent', startedAt: 2_000, task: 'Review the sidebar' },
  subagentEnd: { at: 12_000, status: 'failed', error: 'The model is unavailable.' },
}
const someoneElses = {
  ...reviewer,
  id: 'agent-other',
  name: 'Not this chat’s',
  subagentOf: { agentId: 'agent-second', startedAt: 3_000, task: 'Something else' },
}

test('Studio sub-agents are listed beside native lanes, with the model’s mark and a Read-only badge', async () => {
  const tab = await mountAgentsTab({
    subagents: { 'agent-reviewer': reviewer, 'agent-failed': failedReviewer, 'agent-other': someoneElses },
  })
  try {
    await tab.deliver(transcript)
    await showList(tab)
    const text = tab.host.textContent ?? ''
    expect(text).toContain('Finished · 3')
    expect(text).toContain('Working · 1')
    expect(text).toContain('Cursor · muse-wonder-1.0')
    expect(text).toContain('Read-only')
    expect(text).toContain('Review the calendar screen')
    expect(text).toContain('Done in 1m 30s')
    expect(text).toContain('Failed after 10s')
    expect(text).toContain('The model is unavailable.')
    expect(text).not.toContain('Not this chat’s')
    expect(text).toContain('1 working · 3 finished')
  } finally {
    await tab.unmount()
  }
})

test('a sub-agent’s answers go to its newest session: a follow-up to a rested one starts a new one', () => {
  const session = (sessionId: string, agentId: string, updatedAt: number) =>
    ({ sessionId, workspaceId: 'w-1', agentId, updatedAt }) as ConversationSessionEntry
  const sessions = [session('rested', 'agent-a', 1), session('newest', 'agent-a', 3), session('other', 'agent-b', 9)]
  expect(latestSessionOf(sessions, 'w-1', 'agent-a')?.sessionId).toBe('newest')
  expect(latestSessionOf(sessions, 'w-1', 'agent-c')).toBeUndefined()
})

test('a Studio sub-agent opens onto its own transcript, its final reply as the report', async () => {
  const tab = await mountAgentsTab({ subagents: { 'agent-reviewer': reviewer } })
  try {
    await tab.deliver(transcript)
    await showList(tab)
    await tab.act(async () => tab.button('Review the calendar screen')!.click())
    await tab.deliver([
      event('user_message', {
        turnId: 'turn-1',
        text: 'Act as the review sub-agent for this task.\n\nReview the calendar screen',
        origin: { kind: 'studio', reason: 'subagent-task' },
      }),
      event('turn_started', { turnId: 'turn-1' }),
      event('tool_started', { turnId: 'turn-1', toolCallId: 'read-1', tool: 'Read', summary: 'Read: calendar.png' }),
      event('tool_output', { turnId: 'turn-1', toolUseId: 'read-1', output: 'image', status: 'ok' }),
      event('content_delta', { turnId: 'turn-1', text: 'Verdict: 68/100.' }),
      event('turn_completed', { turnId: 'turn-1' }),
    ])
    const thread = tab.host.textContent ?? ''
    expect(thread).toContain('‹ All agents')
    expect(thread).toContain('Act as the review sub-agent for this task.')
    expect(thread).toContain('Report')
    expect(thread).toContain('Verdict: 68/100.')
    expect(thread).toContain('Read-only')
    await tab.act(async () => tab.button('All agents')!.click())
    expect(tab.host.textContent).toContain('Review the calendar screen')
  } finally {
    await tab.unmount()
  }
})

test('a chat with only sub-agents is not told it has no agents', async () => {
  const tab = await mountAgentsTab({ subagents: { 'agent-reviewer': reviewer } })
  try {
    await tab.deliver([])
    await showList(tab)
    expect(tab.host.textContent).not.toContain('No agents yet')
    expect(tab.host.textContent).toContain('Finished · 1')
  } finally {
    await tab.unmount()
  }
})

const chatOnMachine = { connectionId: 'connection', workspaceId: 'far-workspace', agentId: 'far-agent' }
const farReviewer: MeshSubagent = {
  workspaceId: 'far-workspace',
  agentId: 'far-child',
  title: 'Cursor · grok-4.7',
  providerId: 'cursor-agent',
  modelId: 'grok-4.7',
  readOnly: true,
  status: 'needs_input',
  task: 'Review the calendar screen',
  startedAt: 1_000,
}

/** The tab on a chat of a paired machine: its pane publishes it as `RemoteConversationPanel` does. */
async function openRemoteChat(tab: Awaited<ReturnType<typeof mountAgentsTab>>, operate = true) {
  const { createRemoteConversationTransport } = await import('../../../panels/agentChat/conversationTransport')
  const { publishRemoteChat } = await import('../../../panels/agentChat/remoteChatRegistry')
  const transport = createRemoteConversationTransport({
    key: chatOnMachine,
    machineName: 'mac-mini',
    access: 'operate',
  })
  const transports = new Map<string, ConversationTransport>()
  const subagentTransport = (agentId: string) => {
    const made =
      transports.get(agentId) ??
      createRemoteConversationTransport({
        key: { ...chatOnMachine, agentId },
        machineName: 'mac-mini',
        access: operate ? 'operate' : 'read',
      })
    transports.set(agentId, made)
    return made
  }
  const binding = {
    agent: { name: 'Router work', conversation: { providerId: 'claude-agent', modelId: 'opus' } },
    update: () => undefined,
    workspace: null,
    workspaceRoot: null,
    sessionRoot: 'mesh:connection',
  }
  const { openAgentsPane } = await import('./agentsPaneFocus')
  let opened = false
  let take = () => {}
  const publish = async (subagents: MeshSubagent[]) => {
    await tab.act(async () => {
      take()
      take = publishRemoteChat('workspace', { agentId: 'far-agent', transport, binding, subagents, subagentTransport })
      // As the chat's own rows open the tab, by its agent id on that machine.
      if (!opened) openAgentsPane('workspace', 'far-agent', null)
      opened = true
    })
  }
  const deliver = async (agentId: string, events: ConversationEvent[]) => {
    await tab.act(async () => {
      const receive = tab.followed.get(agentId)!
      receive({ type: 'snapshot', page: { events, hasMore: false, beforeCursor: null } })
      receive({ type: 'synchronized', seq: events.at(-1)?.seq ?? 0 })
    })
  }
  return { publish, deliver, close: () => take() }
}

const asked = () => [
  event('turn_started', { turnId: 'turn-1' }),
  event('approval_requested', { turnId: 'turn-1', requestId: 'approval-1', action: 'Bash', summary: 'npm test' }),
]

test('a chat on a paired machine lists the sub-agents that machine names, live, with their harness and status', async () => {
  const tab = await mountAgentsTab({ focused: false })
  const chat = await openRemoteChat(tab)
  try {
    await chat.publish([farReviewer])
    await chat.deliver('far-agent', transcript)
    await showList(tab)
    const text = tab.host.textContent ?? ''
    expect(text).toContain('Router work')
    expect(text).toContain('Cursor · grok-4.7')
    expect(text).toContain('Read-only')
    expect(text).toContain('Waiting on you')
    expect(text).toContain('Review the calendar screen')
    expect(text).toContain('Find the router')
    expect(text).toContain('2 working · 1 finished')
    const row = tab.button('Review the calendar screen')!
    expect(row.querySelector('svg')).not.toBeNull()

    await chat.publish([{ ...farReviewer, status: 'failed', endedAt: 11_000, error: 'The model is unavailable.' }])
    const moved = tab.host.textContent ?? ''
    expect(moved).toContain('Failed after 10s')
    expect(moved).toContain('The model is unavailable.')
    expect(moved).not.toContain('Waiting on you')
    expect(moved).toContain('1 working · 2 finished')
  } finally {
    chat.close()
    await tab.unmount()
  }
})

test('one opens onto its own chat over there, and what it asks is answered there', async () => {
  const tab = await mountAgentsTab({ focused: false })
  const chat = await openRemoteChat(tab)
  try {
    await chat.publish([farReviewer])
    await chat.deliver('far-agent', transcript)
    await showList(tab)
    await tab.act(async () => tab.button('Review the calendar screen')!.click())
    expect(tab.followed.has('far-child')).toBe(true)
    await chat.deliver('far-child', [
      event('user_message', { turnId: 'turn-1', text: 'Review the calendar screen, closely' }),
      ...asked(),
    ])
    const thread = tab.host.textContent ?? ''
    expect(thread).toContain('‹ All agents')
    expect(thread).toContain('Review the calendar screen, closely')
    expect(thread).toContain('npm test')
    await tab.act(async () => tab.button('Allow once')!.click())
    expect(tab.resolved).toEqual([
      { key: { ...chatOnMachine, agentId: 'far-child' }, requestId: 'approval-1', decision: 'once' },
    ])
    expect(tab.host.textContent).not.toContain('The answer did not go.')

    // The row in the parent's transcript opens it by the same id.
    await tab.act(async () => tab.button('All agents')!.click())
    expect(tab.host.textContent).toContain('Finished · 1')
    const { openAgentsPane } = await import('./agentsPaneFocus')
    await tab.act(async () => openAgentsPane('workspace', 'far-agent', 'far-child'))
    await chat.deliver('far-child', [event('user_message', { turnId: 'turn-1', text: 'Review it, closely' })])
    expect(tab.host.textContent).toContain('‹ All agents')
    expect(tab.host.textContent).toContain('Review it, closely')
  } finally {
    chat.close()
    await tab.unmount()
  }
})

test('a pairing that may only read sees what one asks, and cannot answer it', async () => {
  const tab = await mountAgentsTab({ focused: false })
  const chat = await openRemoteChat(tab, false)
  try {
    await chat.publish([farReviewer])
    await chat.deliver('far-agent', transcript)
    await showList(tab)
    await tab.act(async () => tab.button('Review the calendar screen')!.click())
    await chat.deliver('far-child', asked())
    expect(tab.host.textContent).toContain('npm test')
    expect(tab.button('Allow once')!.disabled).toBe(true)
  } finally {
    chat.close()
    await tab.unmount()
  }
})

test('a machine that names none leaves the tab as it was: the agents its chat’s CLI spawned', async () => {
  const tab = await mountAgentsTab({ focused: false })
  const chat = await openRemoteChat(tab)
  try {
    await chat.publish([])
    await chat.deliver('far-agent', transcript)
    await showList(tab)
    const text = tab.host.textContent ?? ''
    expect(text).toContain('Find the router')
    expect(text).toContain('1 working · 1 finished')
    expect(text).not.toContain("Couldn't")
  } finally {
    chat.close()
    await tab.unmount()
  }
})
