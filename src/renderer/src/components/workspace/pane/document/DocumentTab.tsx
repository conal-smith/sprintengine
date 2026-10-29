import React, { useEffect, useState } from 'react'
import type { WorkspacePaneTab } from '../../../../types/workspace'
import { renderMarkdown } from '../../../../utils/markdown'
import { maskMarkdownFrontmatter } from '../../../../utils/markdownFrontmatter'
import { basename } from '../../../../utils/paths'
import { CopyGlyphButton, InlineNotice, PanelHeader, Spinner } from '../../../ui'

// A markdown file read in the workspace pane: a plan an agent proposed, opened
// from its card in the conversation. Read-only, and rendered the way the
// editor previews markdown, so a plan reads as a document rather than as a
// card squeezed between tool rows.
//
// The file is read again whenever the tab comes to the front. An agent's own
// plan file moves on while it keeps planning, and the tab shows what is on
// disk now rather than what was there when it opened.

const MARKDOWN_PREVIEW_MAX_CHARS = 2 * 1024 * 1024

type DocumentRead = { path: string; content: string } | { path: string; error: string }

type DocumentTabProps = {
  tab: WorkspacePaneTab
  active: boolean
}

export function DocumentTab({ tab, active }: DocumentTabProps) {
  const path = tab.document?.path ?? ''
  const [read, setRead] = useState<DocumentRead | null>(null)

  useEffect(() => {
    if (!active || !path) return
    let cancelled = false
    window.api
      .readfile(path)
      .then((content) => {
        if (!cancelled) setRead({ path, content })
      })
      .catch((error: unknown) => {
        if (!cancelled) setRead({ path, error: error instanceof Error ? error.message : String(error) })
      })
    return () => {
      cancelled = true
    }
  }, [active, path])

  const title = tab.title?.trim() || basename(path)
  const current = read?.path === path ? read : null
  const content = current && 'content' in current ? current.content : null

  return (
    <div className="flex h-full min-h-0 flex-col bg-[color:var(--bg-app)]">
      <PanelHeader
        title={title}
        subtitle={path}
        primaryAction={content !== null ? <CopyGlyphButton size="xs" label="Copy markdown" text={content} /> : null}
      />
      {current === null ? (
        <div className="flex flex-1 items-center justify-center gap-2 text-meta text-[color:var(--text-muted)]">
          <Spinner />
          <span role="status">Loading document…</span>
        </div>
      ) : 'error' in current ? (
        <div className="flex flex-1 items-center justify-center px-4">
          <InlineNotice
            tone="error"
            title="Couldn't open this document."
            hint={<span className="break-all font-mono">{path}</span>}
            detail={current.error}
            className="w-full max-w-[46rem]"
          />
        </div>
      ) : (
        <div className="min-h-0 flex-1 overflow-y-auto px-6 pb-8 pt-6 [scrollbar-gutter:stable]">
          <div className="mx-auto max-w-4xl">
            {current.content.length <= MARKDOWN_PREVIEW_MAX_CHARS ? (
              renderMarkdown(maskMarkdownFrontmatter(current.content))
            ) : (
              <pre className="whitespace-pre-wrap break-words font-mono text-body leading-5 text-[color:var(--text-default)]">
                {current.content}
              </pre>
            )}
          </div>
        </div>
      )}
    </div>
  )
}
