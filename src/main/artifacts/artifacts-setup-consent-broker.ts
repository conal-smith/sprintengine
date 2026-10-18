import { randomUUID } from 'node:crypto'

import type { ArtifactsSetupQuestionView } from '../../shared/artifacts'
import type { ArtifactsSetupConsent } from './artifacts-setup-consent'

// Where the set-up question is put to the person: in Studio's own window, as
// a confirmation dialog, the way main asks what ssh asks (SshPromptDialog).
// Main broadcasts the question to every workspace window; the first answer
// from one of them settles it, and every window is told it is closed. With
// no window open, the native message box asks instead
// (artifacts-setup-consent-electron.ts).
//
// Only an explicit yes from a Studio workspace window counts. Anything else
// that sends an answer (a page in the embedded browser) is not heard; an answer
// for a question that is not open, or a second answer, does nothing; the
// question expiring and the call being cancelled are a no.

export const ARTIFACTS_SETUP_QUESTION_CHANNEL = 'artifacts:setup-question'
export const ARTIFACTS_SETUP_QUESTION_CLOSED_CHANNEL = 'artifacts:setup-question-closed'
export const ARTIFACTS_SETUP_ANSWER_CHANNEL = 'artifacts:setup-answer'

export type ArtifactsSetupConsentBroker = {
  ask: ArtifactsSetupConsent
  /** An answer from a renderer; `fromWorkspaceWindow` is main's own check of the sender. */
  answer(id: unknown, confirmed: unknown, fromWorkspaceWindow: boolean): void
}

export function createArtifactsSetupConsentBroker(deps: {
  broadcast: (channel: string, payload: unknown) => void
  hasWindow: () => boolean
  /** The question asked natively, when no window could show it. */
  fallback: ArtifactsSetupConsent
  timeoutMs: number
  now?: () => number
}): ArtifactsSetupConsentBroker {
  const now = deps.now ?? Date.now
  const open = new Map<string, (confirmed: boolean) => void>()

  return {
    ask(question, signal) {
      if (!deps.hasWindow()) return deps.fallback(question, signal)
      return new Promise<boolean>((resolve) => {
        const id = randomUUID()
        const settle = (confirmed: boolean) => {
          if (!open.has(id)) return
          open.delete(id)
          clearTimeout(timer)
          signal.removeEventListener('abort', onAbort)
          deps.broadcast(ARTIFACTS_SETUP_QUESTION_CLOSED_CHANNEL, { id })
          resolve(confirmed)
        }
        const onAbort = () => settle(false)
        const timer = setTimeout(() => settle(false), deps.timeoutMs)
        open.set(id, settle)
        signal.addEventListener('abort', onAbort, { once: true })
        if (signal.aborted) return settle(false)
        const view: ArtifactsSetupQuestionView = { id, ...question, expiresAt: now() + deps.timeoutMs }
        deps.broadcast(ARTIFACTS_SETUP_QUESTION_CHANNEL, view)
      })
    },
    answer(id, confirmed, fromWorkspaceWindow) {
      // Anything else that could send this (a page in the embedded browser)
      // is not listened to at all: it can neither say yes nor close the question.
      if (!fromWorkspaceWindow || typeof id !== 'string') return
      open.get(id)?.(confirmed === true)
    },
  }
}
