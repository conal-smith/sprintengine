import type { IpcRendererEvent } from 'electron'
import { ipc as ipcRenderer } from '../ipc-router'
import type {
  WorkspaceMarkUnreadResult,
  WorkspaceSyncCommand,
  WorkspaceSyncCommandResult,
  WorkspaceSyncEvent,
  WorkspaceSyncSnapshot,
} from '../../shared/workspace-sync'
import type { ElectronApi, WorkspaceRegistryHydrateResult } from '../../shared/electron-api'
import type { WorkspaceLifecycleRequest, WorkspaceLifecycleResult } from '../../shared/workspace-lifecycle'
import type { SettledChatsSettings } from '../../shared/workspace-settlement'
import type { LifecycleState } from '../../shared/lifecycle-state'

type WorkspaceSyncIpcRenderer = {
  invoke(channel: string, ...args: unknown[]): Promise<unknown>
  on(channel: string, listener: (event: IpcRendererEvent, ...args: unknown[]) => void): void
  removeListener(channel: string, listener: (event: IpcRendererEvent, ...args: unknown[]) => void): void
}

export function createWorkspaceSyncApi(
  renderer: WorkspaceSyncIpcRenderer,
): Pick<
  ElectronApi,
  | 'workspaceSyncDispatch'
  | 'workspaceMarkUnread'
  | 'workspaceLifecycle'
  | 'setSettledChatsSettings'
  | 'setModuleRunStates'
  | 'workspaceSyncGetSnapshot'
  | 'workspaceSyncGetEventsAfter'
  | 'onWorkspaceSyncEvent'
  | 'workspaceRegistryNeedsHydration'
  | 'workspaceRegistryHydrate'
> {
  return {
    // The one-time hydration handshake. `needs-hydration` is false
    // from the moment main has written a registry, which is how a window learns
    // to stop offering its localStorage state and start mirroring.
    workspaceRegistryNeedsHydration: (): Promise<boolean> =>
      renderer.invoke('workspace-registry:needs-hydration') as Promise<boolean>,
    workspaceRegistryHydrate: (payload: unknown): Promise<WorkspaceRegistryHydrateResult> =>
      renderer.invoke('workspace-registry:hydrate', payload) as Promise<WorkspaceRegistryHydrateResult>,
    workspaceSyncDispatch: (command: WorkspaceSyncCommand): Promise<WorkspaceSyncCommandResult> =>
      renderer.invoke('workspace-sync:dispatch', command) as Promise<WorkspaceSyncCommandResult>,
    workspaceMarkUnread: (workspaceId: string): Promise<WorkspaceMarkUnreadResult> =>
      renderer.invoke('workspace-sync:mark-unread', workspaceId) as Promise<WorkspaceMarkUnreadResult>,
    workspaceLifecycle: (request: WorkspaceLifecycleRequest): Promise<WorkspaceLifecycleResult> =>
      renderer.invoke('workspace-sync:lifecycle', request) as Promise<WorkspaceLifecycleResult>,
    setSettledChatsSettings: (settings: SettledChatsSettings): Promise<void> =>
      renderer.invoke('workspace-sync:set-settled-chats-settings', settings) as Promise<void>,
    setModuleRunStates: (states: Record<string, LifecycleState | null>): Promise<void> =>
      renderer.invoke('workspace-sync:set-module-run-states', states) as Promise<void>,
    workspaceSyncGetSnapshot: (): Promise<WorkspaceSyncSnapshot> =>
      renderer.invoke('workspace-sync:get-snapshot') as Promise<WorkspaceSyncSnapshot>,
    workspaceSyncGetEventsAfter: (sequence: number): Promise<WorkspaceSyncEvent[]> =>
      renderer.invoke('workspace-sync:get-events-after', sequence) as Promise<WorkspaceSyncEvent[]>,
    onWorkspaceSyncEvent: (cb: (event: WorkspaceSyncEvent) => void): (() => void) => {
      const channel = 'workspace-sync:event'
      const handler = (_event: IpcRendererEvent, syncEvent: unknown) => cb(syncEvent as WorkspaceSyncEvent)
      renderer.on(channel, handler)
      return () => renderer.removeListener(channel, handler)
    },
  }
}

export const workspaceSyncApi = createWorkspaceSyncApi(ipcRenderer) satisfies Pick<
  ElectronApi,
  | 'workspaceSyncDispatch'
  | 'workspaceMarkUnread'
  | 'workspaceLifecycle'
  | 'setSettledChatsSettings'
  | 'setModuleRunStates'
  | 'workspaceSyncGetSnapshot'
  | 'workspaceSyncGetEventsAfter'
  | 'onWorkspaceSyncEvent'
  | 'workspaceRegistryNeedsHydration'
  | 'workspaceRegistryHydrate'
>
