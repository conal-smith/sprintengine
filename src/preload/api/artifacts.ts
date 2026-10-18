import { ipc as ipcRenderer } from '../ipc-router'
import type { ArtifactsSettingsView, ArtifactsSettingsWriteResult, ArtifactsTestResult } from '../../shared/artifacts'
import type { ElectronApi } from '../../shared/electron-api'

type ArtifactsIpcRenderer = {
  invoke(channel: 'artifacts:get-settings'): Promise<ArtifactsSettingsView>
  invoke(
    channel: 'artifacts:set-settings',
    settings: unknown,
    cloudflareToken?: string,
  ): Promise<ArtifactsSettingsWriteResult>
  invoke(channel: 'artifacts:test-settings', settings: unknown, cloudflareToken?: string): Promise<ArtifactsTestResult>
}

// Settings ▸ Artifacts, which main owns: the `artifacts.*` tools read it with
// no window open. A token typed on the page goes in with a save or a test and
// never comes back out.
function createArtifactsApi(renderer: ArtifactsIpcRenderer) {
  return {
    getArtifactsSettings: (): Promise<ArtifactsSettingsView> => renderer.invoke('artifacts:get-settings'),
    setArtifactsSettings: (settings: unknown, cloudflareToken?: string): Promise<ArtifactsSettingsWriteResult> =>
      renderer.invoke('artifacts:set-settings', settings, cloudflareToken),
    testArtifactsSettings: (settings: unknown, cloudflareToken?: string): Promise<ArtifactsTestResult> =>
      renderer.invoke('artifacts:test-settings', settings, cloudflareToken),
  } satisfies Pick<ElectronApi, 'getArtifactsSettings' | 'setArtifactsSettings' | 'testArtifactsSettings'>
}

export const artifactsApi = createArtifactsApi(ipcRenderer)
