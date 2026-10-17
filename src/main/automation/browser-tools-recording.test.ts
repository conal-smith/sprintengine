import assert from 'node:assert/strict'
import { afterAll, test } from 'vitest'

import type { BrowserRecordingStart, BrowserTabState } from '../../shared/browser'
import type { McpConnectionContext, McpToolRegistration, McpToolResult } from '../../shared/modules/mcp-tools'
import { createBrowserRecorder, type RecordingEncoder, type RecordingOutputs } from '../browser/browser-recorder'
import { BROWSER_MUTATION_TOOL_NAMES, createBrowserTools, type BrowserToolsManager } from './browser-tools'
import { createClientToolLoop, type ClientToolLoop } from './client-tool-loop.test-helper'
import { gatewayToolTimeoutMs } from './offer-gateway-tools'
import { isStudioGatewayMutation } from './studio-gateway-tools'

// `browser.record_start` and `browser.record_stop` over the real recorder,
// with the encoder and the workspace file stood in for. Each case that an
// agent reaches runs twice: the handler called directly, and the same call
// routed through the desktop shell's client, which must answer the same.

function tabState(tabId: string, overrides: Partial<BrowserTabState> = {}): BrowserTabState {
  return {
    tabId,
    url: 'http://localhost:5173/',
    documentUrl: 'http://localhost:5173/',
    title: 'App',
    faviconUrl: null,
    loading: false,
    canGoBack: false,
    canGoForward: false,
    error: null,
    zoomFactor: 1,
    colorScheme: 'system',
    devToolsOpen: false,
    controller: 'none',
    ...overrides,
  }
}

const agentA: McpConnectionContext = { metadata: { kind: 'studio-agent', workspaceId: 'ws-1', agentId: 'agent-a' } }
const agentB: McpConnectionContext = { metadata: { kind: 'studio-agent', workspaceId: 'ws-1', agentId: 'agent-b' } }

function harness(options: { refuseOutput?: boolean } = {}) {
  const tabs = new Map<string, { workspaceId: string; state: BrowserTabState }>([
    ['t1', { workspaceId: 'ws-1', state: tabState('t1') }],
    ['t2', { workspaceId: 'ws-1', state: tabState('t2') }],
  ])
  const assignments = new Map<string, string>()
  const openRequests: Array<{ workspaceId: string; tabId: string | null | undefined }> = []
  const manager: BrowserToolsManager = {
    listTabs: (workspaceId) =>
      [...tabs.values()].filter((tab) => tab.workspaceId === workspaceId).map((tab) => tab.state),
    state: (tabId) => tabs.get(tabId)?.state ?? null,
    activeTab: () => ({ tabId: 't1' }),
    assignedTab: (workspaceId, agentId) => {
      const tabId = assignments.get(`${workspaceId}:${agentId}`)
      return tabId ? { tabId } : null
    },
    assignTab: (workspaceId, agentId, tabId) => void assignments.set(`${workspaceId}:${agentId}`, tabId),
    requestOpen: (workspaceId, _url, tabId) => void openRequests.push({ workspaceId, tabId }),
    requestViewport: () => undefined,
    navigate: () => true,
    back: () => true,
    forward: () => true,
    reload: () => true,
    setColorScheme: () => true,
    noteAgentActivity: () => undefined,
  }

  let listener: Parameters<RecordingEncoder['listen']>[0] | null = null
  const starts: BrowserRecordingStart[] = []
  const encoder: RecordingEncoder = {
    start: async (input) => {
      starts.push(input)
      return { ok: true, mimeType: 'video/webm;codecs=vp9', width: 1280, height: 720, cursor: input.cursor }
    },
    // The window hands over a last chunk, then ends, as the real one does.
    stop: (recordingId) => {
      queueMicrotask(() => {
        listener?.chunk(recordingId, new Uint8Array(40))
        listener?.ended(recordingId, { durationMs: 2_500 })
      })
    },
    listen: (next) => void (listener = next),
  }
  const outputs: RecordingOutputs = {
    create: async ({ stem }) =>
      options.refuseOutput
        ? {
            ok: false,
            code: 'recording_unavailable',
            message:
              'Recordings are kept on the machine a workspace is on, and Studio cannot write files on build-box yet.',
          }
        : {
            ok: true,
            output: {
              path: `/Users/dev/.sprintengine/workspaces/app-0123456789abcdef/browser/recordings/${stem}.webm`,
              append: async () => undefined,
              finish: async () => ({ bytes: 40 }),
              discard: async () => undefined,
            },
          },
  }
  const published: Array<[string, unknown]> = []
  let ids = 0
  const recorder = createBrowserRecorder({
    encoder,
    outputs,
    publish: (tabId, recording) => {
      published.push([tabId, recording])
      const tab = tabs.get(tabId)
      if (tab) tab.state = { ...tab.state, recording }
    },
    describeTab: () => 'localhost:5173',
    newId: () => `rec-${++ids}`,
    now: () => Date.UTC(2026, 9, 4, 9, 0, 0),
  })
  const registrations = createBrowserTools({
    manager,
    control: { actionsOf: () => [] } as never,
    recorder,
    hasWorkspace: (workspaceId) => workspaceId === 'ws-1',
    sleep: async () => undefined,
  })
  return {
    registrations,
    recorder,
    starts,
    openRequests,
    published,
    chunk: (id: string) => listener?.chunk(id, new Uint8Array(10)),
    end: (id: string, error: string) => listener?.ended(id, { error }),
  }
}

function structured(result: McpToolResult): Record<string, any> {
  return result.structuredContent as Record<string, any>
}

const loops: Array<Promise<ClientToolLoop>> = []
afterAll(async () => {
  for (const loop of loops) await (await loop).close()
})

/** A tool as the agent reaches it: called directly, or through the shell's client. */
function reach(registrations: McpToolRegistration[], through: 'direct' | 'the shell') {
  if (through === 'direct') {
    const byName = new Map(registrations.map((tool) => [tool.name, tool]))
    return (name: string, args: Record<string, unknown>, context: McpConnectionContext) =>
      byName.get(name)!.handler(args, context)
  }
  const loop = createClientToolLoop({ toolsets: [{ name: 'browser', registrations }] })
  loops.push(loop)
  return async (name: string, args: Record<string, unknown>, context: McpConnectionContext) =>
    (await loop).call(name, args, context)
}

test('both tools are mutations, and the stop has time to save a long recording', () => {
  for (const name of ['browser.record_start', 'browser.record_stop']) {
    assert.ok(BROWSER_MUTATION_TOOL_NAMES.includes(name))
    assert.equal(isStudioGatewayMutation(name), true)
  }
  assert.equal(gatewayToolTimeoutMs('browser.record_start'), 40_000)
  assert.equal(gatewayToolTimeoutMs('browser.record_stop'), 60_000)
})

for (const through of ['direct', 'the shell'] as const) {
  test(`start, status, stop: the agent is told where the video is (${through})`, async () => {
    const h = harness()
    const call = reach(h.registrations, through)
    const started = await call('browser.record_start', { maxSeconds: 20 }, agentA)
    assert.equal(started.isError, undefined)
    const recording = structured(started).recording
    assert.equal(recording.recordingId, 'rec-1')
    assert.equal(recording.tabId, 't1')
    assert.equal(recording.maxDurationMs, 20_000)
    assert.match(
      recording.path,
      /^\/Users\/dev\/\.sprintengine\/workspaces\/app-0123456789abcdef\/browser\/recordings\/recording-localhost-5173-.*\.webm$/,
    )
    assert.equal(recording.workspacePath, undefined, 'no path relative to the project names a file kept outside it')
    assert.deepEqual(h.starts[0]?.cursor, true)
    // The pane is brought forward on the recorded tab.
    assert.deepEqual(h.openRequests, [{ workspaceId: 'ws-1', tabId: 't1' }])

    const status = await call('browser.status', {}, agentA)
    const tab = structured(status).tabs.find((entry: { tabId: string }) => entry.tabId === 't1')
    assert.deepEqual(tab.recording, {
      recordingId: 'rec-1',
      startedAt: '2026-10-04T09:00:00.000Z',
      maxDurationMs: 20_000,
    })

    h.chunk('rec-1')
    const stopped = await call('browser.record_stop', {}, agentA)
    assert.equal(stopped.isError, undefined)
    const saved = structured(stopped).recording
    assert.equal(saved.recordingId, 'rec-1')
    assert.equal(saved.bytes, 40)
    assert.equal(saved.durationMs, 2_500)
    assert.equal(saved.stopReason, 'stopped')
    assert.equal(saved.mimeType, 'video/webm;codecs=vp9')
    assert.equal(saved.path, recording.path)
    assert.equal(saved.cursor, true)

    // Asked again, the same answer: the recording it already saved.
    const again = await call('browser.record_stop', {}, agentA)
    assert.equal(structured(again).recording.recordingId, 'rec-1')
  })

  test(`another agent can neither start over nor stop someone's recording (${through})`, async () => {
    const h = harness()
    const call = reach(h.registrations, through)
    await call('browser.record_start', { tabId: 't1', cursor: false }, agentA)
    assert.equal(h.starts[0]?.cursor, false)
    const second = await call('browser.record_start', { tabId: 't1' }, agentB)
    assert.equal(structured(second).error.code, 'already_recording')
    assert.equal(h.openRequests.length, 1, 'only the start that was allowed brought the pane forward')
    const stop = await call('browser.record_stop', { tabId: 't1' }, agentB)
    assert.equal(structured(stop).error.code, 'not_yours')
    const notMine = await call('browser.record_stop', { tabId: 't2' }, agentB)
    assert.equal(structured(notMine).error.code, 'not_recording')
  })

  test(`a workspace whose files Studio cannot write is refused before anything is captured (${through})`, async () => {
    const h = harness({ refuseOutput: true })
    const call = reach(h.registrations, through)
    const refused = await call('browser.record_start', {}, agentA)
    assert.equal(refused.isError, true)
    assert.equal(structured(refused).error.code, 'recording_unavailable')
    assert.match(structured(refused).error.message, /build-box/)
    assert.equal(h.starts.length, 0)
    assert.deepEqual(h.published, [])
    assert.deepEqual(h.openRequests, [], 'a refused start moves nothing on screen')
  })
}

test('the person stopping it leaves the result for the agent', async () => {
  const h = harness()
  const call = reach(h.registrations, 'direct')
  await call('browser.record_start', {}, agentA)
  h.chunk('rec-1')
  const byPerson = await h.recorder.stop({ tabId: 't1', owner: null, reason: 'stopped_by_person' })
  assert.ok(byPerson.ok)
  const answer = await call('browser.record_stop', {}, agentA)
  assert.equal(structured(answer).recording.stopReason, 'stopped_by_person')
})

test('a recording that ended with nothing saved tells the agent why when it stops', async () => {
  const h = harness()
  const call = reach(h.registrations, 'direct')
  await call('browser.record_start', {}, agentA)
  // The window goes away before a single chunk.
  h.end('rec-1', 'The window hosting the tab closed.')
  await new Promise((resolve) => setTimeout(resolve, 0))
  const answer = await call('browser.record_stop', {}, agentA)
  assert.equal(answer.isError, true)
  assert.equal(structured(answer).error.code, 'empty')
  assert.match(structured(answer).error.message, /window hosting the tab closed/)
})
