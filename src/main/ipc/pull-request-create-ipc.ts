import type { IpcMain } from 'electron'

import {
  PULL_REQUEST_BODY_MAX_CHARS,
  PULL_REQUEST_TITLE_MAX_CHARS,
  readPullRequestCheckoutPin,
} from '../../shared/git/pull-request-create'
import type { PullRequestTextRequest, PullRequestTextResult } from '../../shared/text-generation/contract'
import { writeDiagnosticLog } from '../diagnostics-service'
import { createPullRequestCreator, type PullRequestCreator } from '../pull-request-create'
import { generatePullRequestText } from '../text-generation/text-generation-service'
import { createDraftRuns, folderOf, readDraftRequest, type DraftRequest } from './text-generation-draft'

// The chat's "Create PR" button (owner ruling 2026-10-04), in the shell: the
// checkout is on this computer, and so are git, `gh` and the agent CLI that
// drafts the text. Four channels, one per step, so the window can say which
// step it is on: whether the button may show, the draft, the push, the
// creation. None of them throws: a failure is `{ ok: false, message }`, which
// the strip shows as it is.

export type PullRequestCreateIpcDeps = {
  creator?: PullRequestCreator
  generate?: (request: PullRequestTextRequest) => Promise<PullRequestTextResult>
}

export function registerPullRequestCreateIpc(ipcMain: IpcMain, deps: PullRequestCreateIpcDeps = {}): void {
  const creator = deps.creator ?? createPullRequestCreator()
  const generate = deps.generate ?? generatePullRequestText
  /** Drafts in flight, by the id the window gave each: closing the dialog stops its CLI. */
  const drafts = createDraftRuns()

  ipcMain.handle('pull-request-create:state', async (_, cwd: unknown) => {
    const folder = folderOf(cwd)
    if (!folder) return null
    return creator.state(folder).catch(() => null)
  })

  ipcMain.handle('pull-request-create:draft', async (_, input: unknown): Promise<PullRequestTextResult> => {
    const request = readPullRequestDraftRequest(input)
    if (!request) return { ok: false, code: 'unsupported', message: 'Malformed pull request draft request.' }
    const result = await drafts.run(request.draftId, async (signal): Promise<PullRequestTextResult> => {
      const gathered = await creator.draftInput(request.cwd)
      if (!gathered.ok) return { ok: false, code: 'unsupported', message: gathered.message }
      return generate({
        input: { ...gathered.input, style: request.writingStyle },
        engine: request.engine,
        ...(request.cliRuntimes ? { cliRuntimes: request.cliRuntimes } : {}),
        signal,
      })
    })
    if (!result.ok && result.code !== 'cancelled') {
      await writeDiagnosticLog({
        level: 'info',
        source: 'agents',
        title: 'Pull request text not drafted',
        message: `${request.engine.cli}: ${result.code} — ${result.message}`,
      }).catch(() => undefined)
    }
    return result
  })

  ipcMain.handle('pull-request-create:draft-cancel', (_, draftId: unknown) => drafts.cancel(draftId))

  // The pin is optional: a window that sends none (an older one) is pushed
  // and created for as the checkout stands.
  ipcMain.handle('pull-request-create:push', async (_, cwd: unknown, pin: unknown) => {
    const folder = folderOf(cwd)
    if (!folder) return { ok: false, message: 'No checkout to push.' }
    return creator
      .push(folder, readPullRequestCheckoutPin(pin) ?? undefined)
      .catch((error: unknown) => ({ ok: false, message: describe(error) }))
  })

  ipcMain.handle('pull-request-create:create', async (_, input: unknown) => {
    const record = input && typeof input === 'object' ? (input as Record<string, unknown>) : {}
    const folder = folderOf(record.cwd)
    if (!folder || typeof record.title !== 'string' || typeof record.body !== 'string') {
      return { ok: false, message: 'Malformed pull request.' }
    }
    return creator
      .create(
        folder,
        {
          title: record.title.slice(0, PULL_REQUEST_TITLE_MAX_CHARS),
          body: record.body.slice(0, PULL_REQUEST_BODY_MAX_CHARS),
        },
        readPullRequestCheckoutPin(record.pin) ?? undefined,
      )
      .catch((error: unknown) => ({ ok: false, message: describe(error) }))
  })
}

function readPullRequestDraftRequest(input: unknown): (DraftRequest & { cwd: string }) | null {
  if (!input || typeof input !== 'object') return null
  const record = input as Record<string, unknown>
  const folder = folderOf(record.cwd)
  const request = readDraftRequest(record)
  return folder && request ? { ...request, cwd: folder } : null
}

function describe(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}
