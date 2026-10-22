import { contextBridge, ipcRenderer, type IpcRendererEvent } from 'electron'

import type { ElectronApi } from '../shared/electron-api'
import type { CanvasWorkerReport, CanvasWorkerRequest, CanvasWorkerResponse } from '../shared/canvas/worker-protocol'

// The canvas worker's preload (canvas-worker-window.ts): the hidden window
// that holds a drawing editor's DOM for main. It is sandboxed, and its page
// gets the worker protocol and nothing else: say it is ready, take requests,
// answer them. These are the only channels main hears from it (ipc-sender.ts).
//
// Type-only imports: a sandboxed preload is one file, with no module of the
// app's to require at run time.

const READY_CHANNEL = 'canvas-worker:ready'
const REQUEST_CHANNEL = 'canvas-worker:request'
const RESPONSE_CHANNEL = 'canvas-worker:response'

const api = {
  canvasWorkerReady: (report: CanvasWorkerReport): void => {
    ipcRenderer.send(READY_CHANNEL, report)
  },
  onCanvasWorkerRequest: (cb: (request: CanvasWorkerRequest) => void): (() => void) => {
    const handler = (_event: IpcRendererEvent, request: CanvasWorkerRequest): void => cb(request)
    ipcRenderer.on(REQUEST_CHANNEL, handler)
    return () => ipcRenderer.removeListener(REQUEST_CHANNEL, handler)
  },
  canvasWorkerRespond: (response: CanvasWorkerResponse): void => {
    ipcRenderer.send(RESPONSE_CHANNEL, response)
  },
} satisfies Pick<ElectronApi, 'canvasWorkerReady' | 'onCanvasWorkerRequest' | 'canvasWorkerRespond'>

contextBridge.exposeInMainWorld('api', api)
