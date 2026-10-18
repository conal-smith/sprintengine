import type { IpcMain } from 'electron'

import type { ArtifactsSettingsView, ArtifactsSettingsWriteResult, ArtifactsTestResult } from '../../shared/artifacts'
import type { ArtifactsSettingsStore } from '../artifacts/artifacts-settings-store'

/**
 * Settings ▸ Artifacts. Main owns the setting (artifacts-settings-store.ts):
 * a read answers what main holds, a write answers what it now holds or which
 * field it refused, and Test checks the page's fields without publishing.
 * The Cloudflare token goes in on a write or a test and never comes back out.
 */
export function registerArtifactsIpc(
  ipcMain: IpcMain,
  deps: {
    store: ArtifactsSettingsStore
    test: (settings: unknown, cloudflareToken?: string) => Promise<ArtifactsTestResult>
  },
): void {
  const tokenArg = (value: unknown): string | undefined => (typeof value === 'string' ? value : undefined)
  ipcMain.handle('artifacts:get-settings', (): Promise<ArtifactsSettingsView> => deps.store.view())
  ipcMain.handle(
    'artifacts:set-settings',
    (_event, settings: unknown, cloudflareToken: unknown): Promise<ArtifactsSettingsWriteResult> =>
      deps.store.write(settings, tokenArg(cloudflareToken)),
  )
  ipcMain.handle(
    'artifacts:test-settings',
    (_event, settings: unknown, cloudflareToken: unknown): Promise<ArtifactsTestResult> =>
      deps.test(settings, tokenArg(cloudflareToken)),
  )
}
