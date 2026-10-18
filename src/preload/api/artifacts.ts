import { ipc as ipcRenderer, type RendererIpc } from '../ipc-router'
import type {
  ArtifactsSettingsView,
  ArtifactsSetupInput,
  ArtifactsSetupQuestionView,
  ArtifactsSetupResult,
} from '../../shared/artifacts'
import type { ElectronApi } from '../../shared/electron-api'

type ArtifactsIpcRenderer = {
  invoke(channel: 'artifacts:get-settings'): Promise<ArtifactsSettingsView>
  invoke(channel: 'artifacts:set-up', input: ArtifactsSetupInput, save: boolean): Promise<ArtifactsSetupResult>
} & Pick<RendererIpc, 'on' | 'removeListener' | 'send'>

// Settings ▸ Artifacts, which main owns: the `artifacts.*` tools read it with
// no window open. A token typed on the page goes in with a set-up and never
// comes back out.
function createArtifactsApi(renderer: ArtifactsIpcRenderer) {
  return {
    getArtifactsSettings: (): Promise<ArtifactsSettingsView> => renderer.invoke('artifacts:get-settings'),
    setUpArtifacts: (input: ArtifactsSetupInput, save: boolean): Promise<ArtifactsSetupResult> =>
      renderer.invoke('artifacts:set-up', input, save),
    // An agent's set-up, put to the person in this window (artifacts-setup-consent-broker.ts).
    onArtifactsSetupQuestion: (cb: (question: ArtifactsSetupQuestionView) => void): (() => void) => {
      const handler = (_event: unknown, question: ArtifactsSetupQuestionView) => cb(question)
      renderer.on('artifacts:setup-question', handler)
      return () => void renderer.removeListener('artifacts:setup-question', handler)
    },
    onArtifactsSetupQuestionClosed: (cb: (id: string) => void): (() => void) => {
      const handler = (_event: unknown, payload: { id: string }) => cb(payload.id)
      renderer.on('artifacts:setup-question-closed', handler)
      return () => void renderer.removeListener('artifacts:setup-question-closed', handler)
    },
    answerArtifactsSetupQuestion: (id: string, confirmed: boolean): void =>
      renderer.send('artifacts:setup-answer', { id, confirmed }),
  } satisfies Pick<
    ElectronApi,
    | 'getArtifactsSettings'
    | 'setUpArtifacts'
    | 'onArtifactsSetupQuestion'
    | 'onArtifactsSetupQuestionClosed'
    | 'answerArtifactsSetupQuestion'
  >
}

export const artifactsApi = createArtifactsApi(ipcRenderer)
