import React, { useEffect, useMemo, useState } from 'react'
import MonacoEditor from '@monaco-editor/react'
import {
  combineConflictSides,
  hasGitConflictMarkers,
  parseGitConflictBlocks,
  replaceGitConflictBlock,
} from '../../utils/gitConflictMarkers'
import { remeasureMonacoFontsOnLoad, useCodeFontFamily } from '../../utils/fonts'
import { useMonacoBaseTheme } from '../../hooks/useAppTheme'
import { detectLanguage } from '../../utils/files'
import { configureMonacoLanguages } from '../../utils/patchLanguage'
import { EmptyState, GhostButton, InlineNotice, PanelHeader, PrimaryButton, Section, Spinner } from '../ui'
import { useConfirmDialog } from '../ui/ConfirmDialog'

type ResolverState =
  | { status: 'loading' }
  | { status: 'error'; message: string }
  | { status: 'ready'; conflict: GitConflictFileContent; content: string; saving: boolean; message: string | null }

type Props = {
  repoRoot: string
  filePath: string
}

export default function GitConflictResolverPanel({ repoRoot, filePath }: Props) {
  const [state, setState] = useState<ResolverState>({ status: 'loading' })
  const language = detectLanguage(filePath)
  const monacoTheme = useMonacoBaseTheme()
  const codeFontFamily = useCodeFontFamily()
  const dialog = useConfirmDialog()
  const blocks = useMemo(() => (state.status === 'ready' ? parseGitConflictBlocks(state.content) : []), [state])

  useEffect(() => {
    let cancelled = false
    setState({ status: 'loading' })

    const load = async () => {
      if (typeof window.api.getGitConflictFile !== 'function') {
        setState({ status: 'error', message: 'Restart the app to enable the conflict resolver.' })
        return
      }

      const conflict = await window.api.getGitConflictFile(repoRoot, filePath)
      if (cancelled) return
      if (!conflict) {
        setState({ status: 'error', message: 'This file is not available as a Git conflict.' })
        return
      }

      setState({
        status: 'ready',
        conflict,
        content: conflict.result,
        saving: false,
        message: null,
      })
    }

    void load().catch((error) => {
      if (cancelled) return
      setState({ status: 'error', message: error instanceof Error ? error.message : String(error) })
    })

    return () => {
      cancelled = true
    }
  }, [filePath, repoRoot])

  const updateContent = (content: string) => {
    setState((current) => (current.status === 'ready' ? { ...current, content } : current))
  }

  const applyBlock = (blockIndex: number, replacement: string) => {
    setState((current) => {
      if (current.status !== 'ready') return current
      const nextBlock = parseGitConflictBlocks(current.content)[blockIndex]
      if (!nextBlock) return current
      return {
        ...current,
        content: replaceGitConflictBlock(current.content, nextBlock, replacement),
        message: null,
      }
    })
  }

  const saveResolved = async () => {
    if (state.status !== 'ready' || state.saving) return
    if (hasGitConflictMarkers(state.content)) {
      const confirmed = await dialog.confirm({
        title: 'Conflict markers remain',
        body: 'This file still has <<<<<<<, =======, or >>>>>>> markers. Mark it resolved anyway?',
        confirmLabel: 'Mark resolved',
        tone: 'danger',
      })
      if (!confirmed) return
    }

    setState({ ...state, saving: true, message: null })
    try {
      const result = await window.api.resolveGitConflict(repoRoot, filePath, state.content)
      setState((current) =>
        current.status === 'ready'
          ? {
              ...current,
              saving: false,
              message: result.ok ? 'Saved and marked resolved.' : (result.message ?? 'Unable to mark resolved.'),
            }
          : current,
      )
    } catch (error) {
      setState((current) =>
        current.status === 'ready'
          ? {
              ...current,
              saving: false,
              message: error instanceof Error ? error.message : String(error),
            }
          : current,
      )
    }
  }

  if (state.status === 'loading') {
    return (
      <div className="flex h-full items-center justify-center bg-[color:var(--bg-app)]">
        <Spinner label="Loading conflict" />
      </div>
    )
  }

  if (state.status === 'error') {
    return (
      <div className="flex h-full items-center justify-center bg-[color:var(--bg-app)] px-6">
        <InlineNotice tone="error" title="Could not load the conflict" detail={state.message} />
      </div>
    )
  }

  return (
    <div className="flex h-full flex-col overflow-hidden bg-[color:var(--bg-app)] text-[color:var(--text-default)]">
      {/* The identity row is the shared primitive: the panel names itself, the
          file it is resolving is the scope beside it. The two-line band this
          replaced ran a second caption — "Pulled version / Your stashed changes
          / Final result" — that each pane below already carries as its own
          title, and a hand-rolled save button beside it (2112). */}
      <PanelHeader
        title="Resolve conflict"
        subtitle={state.conflict.relativePath}
        primaryAction={
          <PrimaryButton onClick={() => void saveResolved()} disabled={state.saving}>
            {state.saving ? 'Saving…' : 'Save & mark resolved'}
          </PrimaryButton>
        }
      />
      {state.message ? (
        <div className="shrink-0 border-b border-[color:var(--border-default)] px-3 py-2 text-meta text-[color:var(--text-muted)]">
          {state.message}
        </div>
      ) : null}

      <div className="grid min-h-0 flex-1 grid-rows-[minmax(170px,32%)_minmax(0,1fr)]">
        <div className="grid min-h-0 grid-cols-2 border-b border-[color:var(--border-default)]">
          <ConflictReadOnlyPane
            title="Pulled version"
            content={state.conflict.ours ?? ''}
            language={language}
            empty="No pulled version for this conflict."
          />
          <ConflictReadOnlyPane
            title="Your stashed changes"
            content={state.conflict.theirs ?? ''}
            language={language}
            empty="No stashed version for this conflict."
          />
        </div>

        <div className="grid min-h-0 grid-cols-[260px_minmax(0,1fr)]">
          <aside className="min-h-0 overflow-y-auto border-r border-[color:var(--border-default)] bg-[color:var(--bg-surface)]">
            <Section title="Conflicts" count={blocks.length} level={3} inset>
              {blocks.length === 0 ? (
                <div className="text-micro text-[color:var(--text-subtle)]">No conflict markers remain.</div>
              ) : (
                <div className="space-y-2">
                  {blocks.map((block) => (
                    <div
                      key={`${block.index}:${block.startOffset}`}
                      className="rounded-md border border-[color:var(--border-default)] bg-[color:var(--bg-surface-raised)] p-2"
                    >
                      <div className="mb-2 text-micro font-semibold text-[color:var(--text-default)]">
                        Conflict {block.index + 1}
                      </div>
                      <div className="grid gap-1">
                        <ConflictActionButton label="Use pulled" onClick={() => applyBlock(block.index, block.ours)} />
                        <ConflictActionButton
                          label="Use stashed"
                          onClick={() => applyBlock(block.index, block.theirs)}
                        />
                        <ConflictActionButton
                          label="Use both"
                          onClick={() => applyBlock(block.index, combineConflictSides(block))}
                        />
                      </div>
                    </div>
                  ))}
                </div>
              )}
            </Section>
          </aside>
          <section className="min-h-0 bg-[color:var(--bg-app)]">
            <MonacoEditor
              height="100%"
              beforeMount={configureMonacoLanguages}
              // See `remeasureWhenMonoFontLoads`: a fallback face measured at mount
              // puts the caret off the text once the mono face swaps in.
              onMount={remeasureMonacoFontsOnLoad}
              language={language}
              value={state.content}
              theme={monacoTheme}
              options={{
                fontSize: 13,
                fontFamily: codeFontFamily,
                minimap: { enabled: false },
                scrollBeyondLastLine: false,
                automaticLayout: true,
                wordWrap: 'off',
              }}
              onChange={(value) => updateContent(value ?? '')}
            />
          </section>
        </div>
      </div>
    </div>
  )
}

function ConflictReadOnlyPane({
  title,
  content,
  language,
  empty,
}: {
  title: string
  content: string
  language?: string
  empty: string
}) {
  const monacoTheme = useMonacoBaseTheme()
  const codeFontFamily = useCodeFontFamily()
  return (
    <section className="flex min-h-0 flex-col border-r border-[color:var(--border-default)] last:border-r-0">
      <div className="shrink-0 border-b border-[color:var(--border-default)] bg-[color:var(--bg-surface)] px-3 py-1.5 text-meta font-semibold text-[color:var(--text-default)]">
        {title}
      </div>
      {content ? (
        <MonacoEditor
          height="100%"
          beforeMount={configureMonacoLanguages}
          onMount={remeasureMonacoFontsOnLoad}
          language={language}
          value={content}
          theme={monacoTheme}
          options={{
            readOnly: true,
            fontSize: 12,
            fontFamily: codeFontFamily,
            minimap: { enabled: false },
            scrollBeyondLastLine: false,
            automaticLayout: true,
            wordWrap: 'off',
            lineNumbers: 'on',
          }}
        />
      ) : (
        <div className="flex min-h-0 flex-1 items-center justify-center">
          <EmptyState density="list" title={empty} />
        </div>
      )}
    </section>
  )
}

// The take-a-side actions on a conflict hunk. On the kit's `sm` step, like
// every other labelled control in the Git surfaces: this ran the panel's
// private 28px/6px ramp, which is what put a Git button a pixel or two off
// every button beside it.
//
// Left alignment is a full-width CHILD rather than a `justify-start` on the
// button. The primitive already declares `justify-center`, and a second
// `justify-content` utility of equal specificity in `className` would leave
// which one wins to stylesheet order — the same trap the `tone` prop exists to
// close. A child that fills the line box sidesteps the question entirely.
function ConflictActionButton({ label, onClick }: { label: string; onClick: () => void }) {
  return (
    <GhostButton size="sm" onClick={onClick}>
      <span className="w-full text-left">{label}</span>
    </GhostButton>
  )
}
