import type { IpcMain } from 'electron'

import type { CommitMessageRequest, CommitMessageResult } from '../../shared/text-generation/contract'
import type { TextGenerationWritingStyle } from '../../shared/text-generation/writing-style'
import { readCommitMessageDraftInput, type CommitMessageDraftInputOutcome } from '../commit-message-draft'
import { writeDiagnosticLog } from '../diagnostics-service'
import { generateCommitMessage } from '../text-generation/text-generation-service'
import { createDraftRuns, folderOf, readDraftRequest } from './text-generation-draft'

// The Git panel's "Write commit message", in the shell: git reads the staged
// changes of a checkout on this computer (or in one of its WSL distributions,
// which the git runner routes to), and the person's own agent CLI drafts the
// message. Two channels: the draft, and stopping it. Neither throws: a
// failure is `{ ok: false, code, message }`, which the panel shows as it is,
// and the box keeps what the person had.
//
// On plain `ipcMain`, not the machine wrapper the git channels sit behind: a
// checkout on an SSH machine has its git there, and its path is no absolute
// path here, so it is refused in words rather than read from this disk.

export type CommitMessageIpcDeps = {
  gather?: (repoRoot: string, style: TextGenerationWritingStyle) => Promise<CommitMessageDraftInputOutcome>
  generate?: (request: CommitMessageRequest) => Promise<CommitMessageResult>
}

export function registerCommitMessageIpc(ipcMain: IpcMain, deps: CommitMessageIpcDeps = {}): void {
  const gather = deps.gather ?? readCommitMessageDraftInput
  const generate = deps.generate ?? generateCommitMessage
  const drafts = createDraftRuns()

  ipcMain.handle('commit-message:draft', async (_, input: unknown): Promise<CommitMessageResult> => {
    const record = input && typeof input === 'object' ? (input as Record<string, unknown>) : null
    const repoRoot = record ? folderOf(record.repoRoot) : null
    const request = record ? readDraftRequest(record) : null
    if (!record || !request) return { ok: false, code: 'unsupported', message: 'Malformed commit message request.' }
    if (!repoRoot) return { ok: false, code: 'unsupported', message: 'Only a checkout on this computer can be read.' }
    const result = await drafts.run(request.draftId, async (signal): Promise<CommitMessageResult> => {
      const gathered = await gather(repoRoot, request.writingStyle)
      if (!gathered.ok) return { ok: false, code: 'unsupported', message: gathered.message }
      if (signal.aborted) return { ok: false, code: 'cancelled', message: 'The draft was stopped.' }
      return generate({
        input: gathered.input,
        engine: request.engine,
        ...(request.cliRuntimes ? { cliRuntimes: request.cliRuntimes } : {}),
        signal,
      })
    })
    if (!result.ok && result.code !== 'cancelled') {
      await writeDiagnosticLog({
        level: 'info',
        source: 'agents',
        title: 'Commit message not drafted',
        message: `${request.engine.cli}: ${result.code} — ${result.message}`,
      }).catch(() => undefined)
    }
    return result
  })

  ipcMain.handle('commit-message:draft-cancel', (_, draftId: unknown) => drafts.cancel(draftId))
}
