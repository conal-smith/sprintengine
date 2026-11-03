import { createIpcRouter, type RendererIpc, type RouterPort } from '../../../preload/ipc-router-core'
import { SERVER_IPC_CHANNELS } from '../../../shared/ipc-channel-owners'
import { assertJsonSafe } from '../../../shared/json-safe'
import { WEB_TUNNEL_CHANNELS } from '../../../shared/web-client'
import { webTunnelAllows } from '../../../shared/web-tunnel-access'
import { superviseTabSocket, WEB_TUNNEL_REOPENED_EVENT, watchWebReconnectTriggers } from './webReconnect'
import { returnToPairing, webPageUrl, webSocketUrl, webWindowId } from './webLocation'
import { webShellIpc } from './webShellIpc'

// A web tab's IPC router: what `src/preload/ipc-router.ts` is in a desktop
// window, and what the web build puts in its place. The router is the same
// one a desktop window uses when its server runs out of process: a channel the
// server owns goes over a port to the server, and every other channel to the
// shell. Here the port is the tab's `/ws/ipc` socket, and the shell is the
// browser (`webShellIpc`).
//
// The socket reconnects by itself, on the connection supervisor every
// reconnecting connection shares (`superviseTabSocket`), and at once when the
// page comes back online or to the foreground. While it is down, invokes wait in
// the router's queue and the idempotent reads go out again on the next socket,
// as across a server restart on the desktop. A close with 4401 means this
// browser was removed in Studio: the tab goes back to pairing, as it does when
// a socket is refused and the session says the browser is no longer paired.

export * from '../../../preload/ipc-router-core'

const router = createIpcRouter({
  ipcRenderer: webShellIpc,
  mode: 'out-of-process',
  // Only what the server lets a web tab reach goes to it; every other channel
  // is the shell's, which in a tab refuses it here, in the missing-member report.
  table: {
    ...Object.fromEntries(Object.entries(SERVER_IPC_CHANNELS).filter(([channel]) => webTunnelAllows(channel))),
    ...WEB_TUNNEL_CHANNELS,
  },
})

function socketPort(socket: WebSocket): RouterPort {
  return {
    postMessage(message) {
      // Thrown inside the call's own promise, so a value JSON would mangle
      // fails the call that sent it rather than arriving changed.
      assertJsonSafe(message, 'message')
      if (socket.readyState === WebSocket.OPEN) socket.send(JSON.stringify(message))
    },
    addEventListener(type: 'message' | 'close', listener: (event: { data: unknown }) => void) {
      if (type === 'message') {
        socket.addEventListener('message', (event) => {
          if (typeof event.data !== 'string') return
          let data: unknown
          try {
            data = JSON.parse(event.data)
          } catch {
            return
          }
          listener({ data })
        })
      } else socket.addEventListener('close', () => (listener as () => void)())
    },
    start: () => undefined,
    close: () => socket.close(),
  } as RouterPort
}

async function checkStillPaired(): Promise<void> {
  try {
    const response = await fetch(webPageUrl('api/session'), { credentials: 'same-origin', cache: 'no-store' })
    if (response.status === 401) returnToPairing()
  } catch {
    // The server is not there: the backoff keeps trying.
  }
}

const tab = superviseTabSocket<WebSocket>({
  open: () => new WebSocket(webSocketUrl('ws/ipc', { windowId: webWindowId() })),
  onOpen: (socket, reopened) => {
    router.attachPort(socketPort(socket))
    if (reopened) window.dispatchEvent(new Event(WEB_TUNNEL_REOPENED_EVENT))
  },
  onRevoked: returnToPairing,
  onRefused: () => void checkStillPaired(),
})
tab.start()
watchWebReconnectTriggers(() => tab.wake())

export const ipc: RendererIpc = router
