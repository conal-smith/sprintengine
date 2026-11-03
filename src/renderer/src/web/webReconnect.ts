import {
  ConnectionSupervisor,
  type SupervisorClock,
} from '../../../../packages/connection-supervisor/src/connectionSupervisor'
import { onWindowVisibilityChange } from '../utils/windowActivity'

// When a web tab tries its sockets again at once rather than waiting out a
// backoff (phase 9 spec, 3.5): the browser is back online, the tab is visible
// again, or it was restored from the back/forward cache (whose sockets were
// closed while it sat there). Mobile browsers suspend background tabs'
// sockets, so these are how a phone's tab comes back.

/** The private close code the server ends a removed browser's sockets with. */
export const WEB_CLOSE_REVOKED = 4401

/** Dispatched on `window` when the tab's tunnel opens again after a drop: the server may have been replaced. */
export const WEB_TUNNEL_REOPENED_EVENT = 'sprintengine:web-tunnel-reopened'

export function watchWebReconnectTriggers(wake: () => void): () => void {
  const stopVisibility = onWindowVisibilityChange((visible) => {
    if (visible) wake()
  })
  const onPageShow = (event: PageTransitionEvent) => {
    if (event.persisted) wake()
  }
  window.addEventListener('online', wake)
  window.addEventListener('pageshow', onPageShow)
  return () => {
    stopVisibility()
    window.removeEventListener('online', wake)
    window.removeEventListener('pageshow', onPageShow)
  }
}

/** As much of a browser WebSocket as the tab's supervision uses. */
export type TabSocket = {
  addEventListener(type: 'open' | 'close', listener: (event: { code?: number }) => void): void
  close(): void
}

class TabRevokedError extends Error {}

/**
 * The tab's socket, kept open by the connection supervisor every reconnecting
 * connection in the app shares: a quarter second doubling to ten, jittered so
 * tabs a server restart dropped together do not all knock at once, and tried
 * at once on a wake. A page cannot ping a WebSocket, so a wake trusts a socket
 * that is open, as the browser does. A close with 4401 means this browser was
 * removed in Studio: `onRevoked`, and no more tries.
 */
export function superviseTabSocket<S extends TabSocket>(options: {
  open(): S
  /** The socket is open (`reopened`: after a drop, so the server may have been replaced). */
  onOpen(socket: S, reopened: boolean): void
  onRevoked(): void
  /** A socket refused at its upgrade, which closes without a code a page can read. */
  onRefused(): void
  clock?: SupervisorClock
  random?: () => number
}): ConnectionSupervisor<S> {
  let everOpened = false
  return new ConnectionSupervisor<S>({
    connect: (attempt) =>
      new Promise<S>((resolve, reject) => {
        const socket = options.open()
        let opened = false
        socket.addEventListener('open', () => {
          // Opened after its attempt was given up on: a newer one is on its way.
          if (!attempt.current()) {
            socket.close()
            return
          }
          opened = true
          options.onOpen(socket, everOpened)
          everOpened = true
          // Up from this event on, so a close in the same tick is a drop of it.
          attempt.connected(socket)
          resolve(socket)
        })
        socket.addEventListener('close', (event) => {
          if (!attempt.current()) return
          const failure =
            event.code === WEB_CLOSE_REVOKED
              ? new TabRevokedError('This browser was removed in Studio.')
              : new Error('The tab lost its connection to Studio.')
          if (failure instanceof TabRevokedError) options.onRevoked()
          // A browser removed while it was offline (asleep, out of range) is
          // refused at the upgrade on every try, and never hears 4401.
          else if (!opened) options.onRefused()
          if (opened) attempt.lost(failure)
          else reject(failure)
        })
      }),
    close: (socket) => socket.close(),
    classify: (error) => (error instanceof TabRevokedError ? { kind: 'needs-sign-in' } : { kind: 'transient' }),
    backoff: { baseMs: 250, maxMs: 10_000 },
    clock: options.clock,
    random: options.random,
  })
}
