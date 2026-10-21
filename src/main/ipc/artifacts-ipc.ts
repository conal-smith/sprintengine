import type { IpcMain } from 'electron'

import type { ArtifactsSettingsView, ArtifactsSetupInput, ArtifactsSetupResult } from '../../shared/artifacts'
import type { ArtifactsSettingsStore } from '../artifacts/artifacts-settings-store'
import {
  ARTIFACTS_SETUP_ANSWER_CHANNEL,
  type ArtifactsSetupConsentBroker,
} from '../artifacts/artifacts-setup-consent-broker'
import { listWorkspaceWindows } from '../window-factory'

/**
 * Settings ▸ Artifacts. Main owns the setting (artifacts-settings-store.ts):
 * a read answers what main holds; a set-up (Test, or Save) finds and makes
 * what the host needs and answers each step, and a save keeps what it found.
 * The Cloudflare token goes in with a set-up and never comes back out. An
 * agent's set-up is answered here too, by the person, in a workspace window.
 */
export function registerArtifactsIpc(
  ipcMain: IpcMain,
  deps: {
    store: ArtifactsSettingsStore
    setUp: (input: ArtifactsSetupInput, save: boolean) => Promise<ArtifactsSetupResult>
    consent: ArtifactsSetupConsentBroker
  },
): void {
  // The person's answer to an agent's set-up, heard only from a workspace
  // window's own page: never an iframe in it, nor any other web contents.
  ipcMain.on(ARTIFACTS_SETUP_ANSWER_CHANNEL, (event, payload: unknown) => {
    const answer = payload && typeof payload === 'object' ? (payload as { id?: unknown; confirmed?: unknown }) : {}
    const fromWorkspaceWindow =
      event.senderFrame !== null &&
      event.senderFrame === event.sender.mainFrame &&
      listWorkspaceWindows().some((window) => window.webContents === event.sender)
    deps.consent.answer(answer.id, answer.confirmed, fromWorkspaceWindow)
  })
  ipcMain.handle('artifacts:get-settings', (): Promise<ArtifactsSettingsView> => deps.store.view())
  ipcMain.handle('artifacts:set-up', (_event, input: unknown, save: unknown): Promise<ArtifactsSetupResult> => {
    const provider = input && typeof input === 'object' ? (input as { provider?: unknown }).provider : undefined
    if (provider !== null && provider !== 'github-pages' && provider !== 'cloudflare-pages') {
      return Promise.resolve({
        ok: false,
        steps: [],
        field: 'provider',
        message: 'Choose GitHub Pages or Cloudflare Pages.',
      })
    }
    return deps.setUp(input as ArtifactsSetupInput, save === true)
  })
}
