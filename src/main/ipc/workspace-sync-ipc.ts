import type { IpcMain, IpcMainInvokeEvent, WebContents } from 'electron'

import { studioPlatform } from '../../server/platform/platform'
import type { WorkspaceMarkUnreadResult, WorkspaceSyncEvent } from '../../shared/workspace-sync'
import {
  parseWorkspaceLifecycleRequest,
  type WorkspaceLifecycleRequest,
  type WorkspaceLifecycleResult,
} from '../../shared/workspace-lifecycle'
import type { WorkspaceSyncService } from '../workspace-sync-service'
import type { WorkspaceRegistryHydratePayload, WorkspaceRegistryService } from '../workspace-registry-service'

type BroadcastTarget = {
  isDestroyed(): boolean
  webContents: WebContents
}

type RegisterWorkspaceSyncIpcOptions = {
  /** The windows to broadcast to. Absent: the platform's client bus, every window but the sender's. */
  listWindows?: () => BroadcastTarget[]
  getSourceWindowId?: (event: IpcMainInvokeEvent) => string
  /**
   * The registry behind the bus, for the one-time localStorage hydration
   * channel. Omitted in tests that only exercise the bus.
   */
  registry?: WorkspaceRegistryService
  /**
   * Mark unread from a window's row menu: the same write a paired device's
   * `conversation.mark_unread` makes (conversation-lifecycle.ts). Its event
   * reaches every window, the asking one included, through the subscription
   * below. Omitted, the channel answers that it cannot.
   */
  markUnread?: (workspaceId: string) => Promise<WorkspaceMarkUnreadResult>
  /**
   * A window's Settle, Un-settle, Snooze or Wake now, decided in main on the
   * reading of the chat the window made it on (conversation-lifecycle.ts's
   * `fromWindow`). Its event reaches every window through the subscription
   * below. Omitted, the channel answers that it cannot.
   */
  lifecycle?: (request: WorkspaceLifecycleRequest) => WorkspaceLifecycleResult
  /** The Settled chats settings a window pushes, which main's rest sweep reads. */
  setSettledChatsSettings?: (settings: unknown) => void
}

export function registerWorkspaceSyncIpc(
  ipcMain: IpcMain,
  service: WorkspaceSyncService,
  options: RegisterWorkspaceSyncIpcOptions = {},
): void {
  const getSourceWindowId = options.getSourceWindowId ?? defaultSourceWindowId
  const listWindows = options.listWindows
  const broadcast = (syncEvent: WorkspaceSyncEvent, source: SenderEvent | null): void => {
    if (listWindows) broadcastWorkspaceSyncEvent(syncEvent, source?.sender ?? null, listWindows())
    else
      studioPlatform().clients.publish(
        'workspace-sync:event',
        syncEvent,
        source ? { exceptClientId: callerClientId(source) } : 'all',
      )
  }

  // Events minted with no source window to skip — a gateway create, an
  // automation, the scheduler, a phone — reach every window through this
  // subscription. A window-originated dispatch deliberately does NOT announce
  // here; the handler below broadcasts it so the sending window is skipped.
  service.subscribeEvents((syncEvent) => {
    broadcast(syncEvent, null)
  })

  ipcMain.handle('workspace-sync:dispatch', (event, command: unknown) => {
    const result = service.dispatch({ command, sourceWindowId: getSourceWindowId(event) })
    if (result.ok) broadcast(result.event, event)
    return result
  })

  ipcMain.handle(
    'workspace-sync:mark-unread',
    async (_event, workspaceId: unknown): Promise<WorkspaceMarkUnreadResult> => {
      if (typeof workspaceId !== 'string' || !workspaceId.trim())
        return { ok: false, code: 'invalid_arguments', message: 'Mark unread needs a chat.' }
      if (!options.markUnread) return { ok: false, code: 'unavailable', message: 'Mark unread is not available here.' }
      return options.markUnread(workspaceId.trim())
    },
  )
  ipcMain.handle('workspace-sync:lifecycle', (_event, request: unknown): WorkspaceLifecycleResult => {
    const parsed = parseWorkspaceLifecycleRequest(request)
    if (!parsed) return { ok: false, code: 'invalid_arguments', message: 'That is not a change to a chat’s rest.' }
    if (!options.lifecycle) return { ok: false, code: 'unavailable', message: 'Settle is not available here.' }
    return options.lifecycle(parsed)
  })
  ipcMain.handle('workspace-sync:set-settled-chats-settings', (_event, settings: unknown): void => {
    options.setSettledChatsSettings?.(settings)
  })
  ipcMain.handle('workspace-sync:get-snapshot', () => service.getSnapshot())
  ipcMain.handle('workspace-sync:get-events-after', (_event, sequence: unknown) => service.getEventsAfter(sequence))

  // One-time hydration from a window's post-migrate-ladder localStorage state.
  // The window offers; main seeds only when it has never written a
  // registry, so a second window racing the first is a no-op rather than a
  // merge. Answering `needsHydration: false` is how a window learns to stop
  // offering and start mirroring.
  ipcMain.handle('workspace-registry:needs-hydration', () => options.registry?.needsHydration() ?? false)
  ipcMain.handle('workspace-registry:hydrate', (_event, payload: WorkspaceRegistryHydratePayload) => {
    if (!options.registry) return { changed: false, reason: 'already_present' }
    return options.registry.hydrate(payload ?? {})
  })
}

function broadcastWorkspaceSyncEvent(
  syncEvent: WorkspaceSyncEvent,
  source: WebContents | null,
  windows: BroadcastTarget[],
): void {
  for (const window of windows) {
    if (window.isDestroyed() || window.webContents.isDestroyed()) continue
    if (source && window.webContents.id === source.id) continue
    window.webContents.send('workspace-sync:event', syncEvent)
  }
}

type SenderEvent = Pick<IpcMainInvokeEvent, 'sender'> & { caller?: { clientId: string; windowId: string | null } }

/**
 * The window's client id: the port's in the Studio server's tunnel, its
 * contents' id in main (what the Electron platform's bus compares).
 */
function callerClientId(event: SenderEvent): string {
  return event.caller?.clientId ?? String(event.sender.id)
}

function defaultSourceWindowId(event: SenderEvent): string {
  // The tunnel says which window asked; main reads it back from the URL it gave the window.
  if (event.caller) return event.caller.windowId ?? 'primary'
  return workspaceWindowIdFromUrl(event.sender.getURL())
}

function workspaceWindowIdFromUrl(rawUrl: string): string {
  try {
    const parsed = new URL(rawUrl)
    return parsed.searchParams.get('windowId')?.trim() || 'primary'
  } catch {
    return 'primary'
  }
}
