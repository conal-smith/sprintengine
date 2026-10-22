import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'
import { test, vi } from 'vitest'

// The canvas worker's page gets the worker protocol and nothing else.

const exposed = new Map<string, Record<string, unknown>>()
const sent: Array<[string, unknown]> = []
const renderer = Object.assign(new EventEmitter(), {
  send: (channel: string, payload: unknown) => sent.push([channel, payload]),
})

vi.mock('electron', () => ({
  contextBridge: { exposeInMainWorld: (key: string, value: Record<string, unknown>) => exposed.set(key, value) },
  ipcRenderer: renderer,
}))

await import('./canvas-worker')

test('the worker preload exposes the worker protocol and nothing else', () => {
  assert.deepEqual([...exposed.keys()], ['api'])
  const api = exposed.get('api') as {
    canvasWorkerReady(report: unknown): void
    onCanvasWorkerRequest(cb: (request: unknown) => void): () => void
    canvasWorkerRespond(response: unknown): void
  }
  assert.deepEqual(Object.keys(api).sort(), ['canvasWorkerReady', 'canvasWorkerRespond', 'onCanvasWorkerRequest'])

  const requests: unknown[] = []
  const unsubscribe = api.onCanvasWorkerRequest((request) => requests.push(request))
  renderer.emit('canvas-worker:request', {}, { requestId: 'r1' })
  unsubscribe()
  renderer.emit('canvas-worker:request', {}, { requestId: 'r2' })
  assert.deepEqual(requests, [{ requestId: 'r1' }])

  api.canvasWorkerReady({ loaded: [], missing: [], errors: [] })
  api.canvasWorkerRespond({ requestId: 'r1', ok: true })
  assert.deepEqual(
    sent.map(([channel]) => channel),
    ['canvas-worker:ready', 'canvas-worker:response'],
  )
})
