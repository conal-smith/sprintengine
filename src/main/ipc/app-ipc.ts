import { ipcMain as electronIpcMain, type IpcMain } from 'electron'

import { ipcSenderKind, senderMayUseChannel, type SenderEvent } from './ipc-sender'

// Every `ipcMain.handle` / `ipcMain.on` in the main process registers through
// this object, never through Electron's `ipcMain` directly (the lint rule in
// .oxlintrc.json and app-ipc.registration.test.ts hold that). Each handler and
// listener is wrapped so that, before it runs, the sender is checked
// (ipc-sender.ts): the top-level frame of a BrowserWindow (never a webview
// guest, never a subframe) showing one of Studio's own documents, and for any
// document other than the app's, only the channels that document uses.
//
// A refused invoke rejects in words; a refused `send` is dropped. Handlers
// keep the sender checks they already make (a workspace window only, the
// window that owns a recording): this is the floor under them, not a
// replacement.

type AnyHandler = (event: any, ...args: any[]) => unknown
type AnyListener = (event: any, ...args: any[]) => void

class RefusedIpcSenderError extends Error {
  constructor(channel: string) {
    super(`${channel} answers only SprintEngine Studio's own windows.`)
    this.name = 'RefusedIpcSenderError'
  }
}

export type GuardIpcOptions = {
  /** Told once per channel when a sender is turned away, for the diagnostics log. */
  onRefused?: (channel: string) => void
}

/**
 * An `IpcMain` whose registrations run only for senders `senderMayUseChannel`
 * accepts. Everything else (`removeHandler`, `removeListener`, `emit`, …)
 * reaches the target, with a listener's wrapper found again on removal.
 */
export function guardIpcMain(source: IpcMain | (() => IpcMain), options: GuardIpcOptions = {}): IpcMain {
  // Read when used, so importing this module costs nothing and needs no Electron.
  const resolve = typeof source === 'function' ? source : () => source
  const refusedOnce = new Set<string>()
  const refused = (channel: string): void => {
    if (refusedOnce.has(channel)) return
    refusedOnce.add(channel)
    options.onRefused?.(channel)
  }
  const allowed = (channel: string, event: SenderEvent): boolean => {
    let kind: ReturnType<typeof ipcSenderKind>
    try {
      kind = ipcSenderKind(event)
    } catch {
      kind = null
    }
    if (kind !== null && senderMayUseChannel(kind, channel)) return true
    refused(channel)
    return false
  }

  const guardHandler =
    (channel: string, handler: AnyHandler): AnyHandler =>
    (event, ...args) => {
      if (!allowed(channel, event)) throw new RefusedIpcSenderError(channel)
      return handler(event, ...args)
    }

  // The wrapper each listener was registered as, per channel, so removing the
  // listener the caller holds removes what Electron holds.
  const wrappers = new Map<string, WeakMap<AnyListener, AnyListener>>()
  const wrapListener = (channel: string, listener: AnyListener, once: boolean): AnyListener => {
    let byListener = wrappers.get(channel)
    if (!byListener) wrappers.set(channel, (byListener = new WeakMap()))
    const existing = byListener.get(listener)
    if (existing) return existing
    const wrapped: AnyListener = (event, ...args) => {
      if (!allowed(channel, event)) {
        // Harmless on a plain send; a sendSync is answered rather than left hanging.
        if (event && typeof event === 'object') (event as { returnValue?: unknown }).returnValue = undefined
        return
      }
      // A once-listener is registered as a plain one and leaves on its first
      // accepted message, so a refused sender cannot use it up.
      if (once) {
        byListener.delete(listener)
        resolve().removeListener(channel, wrapped)
      }
      listener(event, ...args)
    }
    byListener.set(listener, wrapped)
    return wrapped
  }
  const unwrapListener = (channel: string, listener: AnyListener): AnyListener =>
    wrappers.get(channel)?.get(listener) ?? listener

  const guarded = {
    handle(channel: string, handler: AnyHandler) {
      resolve().handle(channel, guardHandler(channel, handler))
    },
    // Electron's handleOnce is spent by any invoke, a refused one included;
    // this one is spent by the first accepted invoke.
    handleOnce(channel: string, handler: AnyHandler) {
      resolve().handle(channel, (event, ...args) => {
        if (!allowed(channel, event)) throw new RefusedIpcSenderError(channel)
        resolve().removeHandler(channel)
        return handler(event, ...args)
      })
    },
    on(channel: string, listener: AnyListener) {
      resolve().on(channel, wrapListener(channel, listener, false))
      return proxy
    },
    addListener(channel: string, listener: AnyListener) {
      resolve().addListener(channel, wrapListener(channel, listener, false))
      return proxy
    },
    prependListener(channel: string, listener: AnyListener) {
      resolve().prependListener(channel, wrapListener(channel, listener, false))
      return proxy
    },
    once(channel: string, listener: AnyListener) {
      resolve().on(channel, wrapListener(channel, listener, true))
      return proxy
    },
    prependOnceListener(channel: string, listener: AnyListener) {
      resolve().prependListener(channel, wrapListener(channel, listener, true))
      return proxy
    },
    removeListener(channel: string, listener: AnyListener) {
      resolve().removeListener(channel, unwrapListener(channel, listener))
      return proxy
    },
    off(channel: string, listener: AnyListener) {
      resolve().off(channel, unwrapListener(channel, listener))
      return proxy
    },
  }

  const proxy = new Proxy({} as IpcMain, {
    get(_object, property) {
      if (typeof property === 'string' && Object.prototype.hasOwnProperty.call(guarded, property))
        return guarded[property as keyof typeof guarded]
      const target = resolve()
      const value = Reflect.get(target, property) as unknown
      return typeof value === 'function' ? (value as (...input: unknown[]) => unknown).bind(target) : value
    },
  })
  return proxy
}

/** The main process's `ipcMain`: Electron's, behind the sender check. */
export const ipcMain: IpcMain = guardIpcMain(() => electronIpcMain, {
  onRefused: (channel) => {
    console.warn(`[ipc] refused ${channel} from a sender that is not a Studio window`)
  },
})
