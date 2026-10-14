import { useEffect, useState } from 'react'
import { DiffEditor } from '@monaco-editor/react'
import type { ConversationTurnDiffInput, ConversationTurnDiffResult } from '../../../../shared/conversation-runtime'
import { GhostButton, InlineNotice, Spinner, Toolbar, ToolbarSpacer } from '../ui'
import { WindowCloseButton } from '../workspace/WindowControls'
import { useMonacoBaseTheme } from '../../hooks/useAppTheme'
import { configureMonacoLanguages } from '../../utils/patchLanguage'
import { detectLanguage } from '../../utils/files'
import { useCodeFontFamily } from '../../utils/fonts'
import { TRAFFIC_LIGHT_INSET } from '../workspace/AppTitleBar'
import type { ToolDiffWindowInput } from './openCheckpointDiffWindow'
import { deriveEditHunks, editPreviewSources } from '../../../../shared/conversation/editHunks'

export function parseCheckpointDiffRequest(raw: string): ConversationTurnDiffInput | ToolDiffWindowInput | null {
  try {
    const value = JSON.parse(raw) as ConversationTurnDiffInput & ToolDiffWindowInput
    return value &&
      typeof value.key?.workspaceRoot === 'string' &&
      typeof value.key.workspaceId === 'string' &&
      typeof value.key.agentId === 'string' &&
      ((Number.isSafeInteger(value.turnSeq) && value.turnSeq > 0) ||
        (typeof value.toolUseId === 'string' && Number.isSafeInteger(value.editIndex) && value.editIndex >= 0)) &&
      typeof value.path === 'string'
      ? value
      : null
  } catch {
    return null
  }
}

async function loadDiff(input: ConversationTurnDiffInput | ToolDiffWindowInput): Promise<ConversationTurnDiffResult> {
  if (!('toolUseId' in input)) return window.api.conversationTurnDiff(input)
  const result = await window.api.conversationToolDetail({ ...input.key, toolUseId: input.toolUseId })
  if (!result.ok) return result
  if (result.detail.clipped)
    return { ok: false, message: 'The stored tool input was clipped; the complete edit is unavailable.' }
  const edit = deriveEditHunks(result.detail.input)[input.editIndex]
  if (!edit || edit.limited) return { ok: false, message: 'The tool edit could not be reconstructed.' }
  return { ok: true, diff: { files: [], submodulesExcluded: true }, ...editPreviewSources(edit) }
}

/** Historical snapshots never read today's working file or offer staging actions. */
export default function CheckpointDiffWindow({ request }: { request: string }) {
  const theme = useMonacoBaseTheme()
  const codeFontFamily = useCodeFontFamily()
  const [result, setResult] = useState<ConversationTurnDiffResult>()
  const [retry, setRetry] = useState(0)
  const input = parseCheckpointDiffRequest(request)
  useEffect(() => {
    let cancelled = false
    setResult(undefined)
    const parsed = parseCheckpointDiffRequest(request)
    if (!parsed) {
      setResult({ ok: false, message: 'Invalid checkpoint diff request.' })
      return
    }
    void loadDiff(parsed)
      .then((value) => {
        if (!cancelled) setResult(value)
      })
      .catch((error: unknown) => {
        if (!cancelled) setResult({ ok: false, message: String(error) })
      })
    return () => {
      cancelled = true
    }
  }, [request, retry])
  return (
    <div className="flex h-screen flex-col bg-[color:var(--sem-color-bg-app)] text-[color:var(--sem-color-text-primary)]">
      <div style={{ paddingLeft: window.api.platform === 'darwin' ? TRAFFIC_LIGHT_INSET : undefined }}>
        <Toolbar ariaLabel="Checkpoint diff" className="app-drag-region">
          <span className="truncate">
            {input?.path ?? 'Turn changes'} ·{' '}
            {input && 'toolUseId' in input ? 'Recorded edit and surrounding context' : 'Before / after turn'}
          </span>
          <ToolbarSpacer />
          <WindowCloseButton onClick={() => void window.api.windowClose()} />
        </Toolbar>
      </div>
      {!result ? (
        <Spinner label="Loading checkpoint diff" />
      ) : !result.ok ? (
        <InlineNotice
          tone="error"
          action={
            <GhostButton size="inline" onClick={() => setRetry(retry + 1)}>
              Retry
            </GhostButton>
          }
        >
          {result.message}
        </InlineNotice>
      ) : (
        <div className="min-h-0 flex-1">
          <DiffEditor
            beforeMount={configureMonacoLanguages}
            theme={theme}
            language={detectLanguage(input?.path ?? '')}
            original={result.original ?? ''}
            modified={result.modified ?? ''}
            options={{
              readOnly: true,
              originalEditable: false,
              automaticLayout: true,
              renderSideBySide: true,
              minimap: { enabled: false },
              fontFamily: codeFontFamily,
            }}
          />
        </div>
      )}
    </div>
  )
}
