import { BrowserWindow, dialog, type MessageBoxOptions } from 'electron'

import { isCanvasWorkerWindow } from '../canvas/canvas-worker-window'
import type { ArtifactsSetupConsent } from './artifacts-setup-consent'

// The Electron half of the set-up question (artifacts-setup-consent.ts): a
// native message box, as the quit question is, so it is asked whatever the
// renderer is doing. It is the fallback for when no workspace window is open
// to ask in (artifacts-setup-consent-broker.ts). Return and Escape both
// refuse: setting up a host takes a click on the named button.
//
// The refusal is button 0, so a box that is answered without being shown (a
// session that cannot draw one resolves with the first button) is a no. An
// answer quicker than a person could read the question is taken as no too.

const REFUSE_BUTTON = 0
const CONFIRM_BUTTON = 1
const QUICKEST_ANSWER_MS = 500

export const askToSetUpArtifacts: ArtifactsSetupConsent = async (question, signal) => {
  const options: MessageBoxOptions = {
    type: 'question',
    message: question.message,
    detail: question.detail,
    buttons: [question.refuseLabel, question.confirmLabel],
    defaultId: REFUSE_BUTTON,
    cancelId: REFUSE_BUTTON,
    noLink: true,
    signal,
  }
  const focused = BrowserWindow.getFocusedWindow()
  const parent = focused && !focused.isDestroyed() && !isCanvasWorkerWindow(focused) ? focused : null
  const askedAt = Date.now()
  try {
    const result = parent ? await dialog.showMessageBox(parent, options) : await dialog.showMessageBox(options)
    return !signal.aborted && result.response === CONFIRM_BUTTON && Date.now() - askedAt >= QUICKEST_ANSWER_MS
  } catch {
    return false
  }
}
