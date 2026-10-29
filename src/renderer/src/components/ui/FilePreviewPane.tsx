import React from 'react'
import { Tooltip } from './Tooltip'
import { CloseIconButton, GhostButton, IconButton } from './Buttons'
import { PanelHeader } from './PanelHeader'
import { renderMarkdown } from '../../utils/markdown'
import { maskMarkdownFrontmatter } from '../../utils/markdownFrontmatter'

// FilePreviewPane — canonical inline file/artifact preview surface.
// Renders a Back affordance, the filename, an optional "Open in editor"
// jump-out, and a body that switches between markdown rendering and a
// preformatted plain-text view based on the file extension.
//
// Used by the task-attached file preview and
// artifact preview. Both panels previously hand-rolled the same chrome
// (header pixel-for-pixel identical; only the title typography differed
// per caller).
//
// The header is `ui/PanelHeader` (2112). It used to be a hand-rolled band at
// `px-5 py-3` with its own Back button, and `title` took a NODE so each of the
// four callers could pick its own type step — which is how one primitive's
// identity row shipped in three sizes. The title is a string now and the row
// owns its type; Back rides the `leading` slot, which exists for exactly this.
// The path is the row's `subtitle` — the scope beside the name, which shrinks
// before the name does and keeps its own hover reveal, so nothing the old
// title-attribute tooltip carried is lost.

type FilePreviewPaneProps = {
  /** Visible title — the file or artifact name. Typography is the header
   *  row's, not the caller's. */
  title: string
  /** Full path. Rendered as the header's scope line, and used to detect
   *  whether the body is markdown (`.md` extension). */
  path: string
  /** File contents. Rendered through the markdown pipeline when the path
   *  ends in `.md`; otherwise rendered as preformatted text. */
  content: string
  /** Back affordance — typically returns the user to the detail pane. */
  onBack: () => void
  /** Optional "Open in editor tab" handler. Hides the button when omitted. */
  onPopOut?: () => void
  /** Optional close handler. Renders the canonical top-right X so the pane
   *  keeps its dismiss affordance when the preview replaces an inspector
   *  view that had one. Back returns one level; close dismisses the pane. */
  onClose?: () => void
  /** Opt-in body override: replaces the extension-based content rendering
   *  while keeping the shared header chrome. Used for previews that manage
   *  their own scrolling (e.g. the sandboxed HTML artifact frame). */
  body?: React.ReactNode
}

const MARKDOWN_PREVIEW_MAX_CHARS = 2 * 1024 * 1024

export function FilePreviewPane({ title, path, content, onBack, onPopOut, onClose, body }: FilePreviewPaneProps) {
  const isMarkdown = path.toLowerCase().endsWith('.md')
  const renderAsMarkdown = isMarkdown && content.length <= MARKDOWN_PREVIEW_MAX_CHARS
  return (
    <div className="flex h-full min-h-0 flex-col">
      <PanelHeader
        title={title}
        subtitle={path}
        leading={
          <Tooltip content="Back">
            <IconButton onClick={onBack} aria-label="Back">
              <svg viewBox="0 0 16 16" fill="none" className="icon-xs">
                <path
                  d="M10 4L6 8L10 12"
                  stroke="currentColor"
                  strokeWidth="1.6"
                  strokeLinecap="round"
                  strokeLinejoin="round"
                />
              </svg>
            </IconButton>
          </Tooltip>
        }
        primaryAction={
          onPopOut ? (
            <Tooltip content="Open in editor tab">
              <GhostButton size="xs" onClick={onPopOut} aria-label="Open in editor tab">
                <svg viewBox="0 0 16 16" fill="none" className="icon-xs">
                  <path
                    d="M9 3H13V7M13 3L7.5 8.5M6 4H4C3.45 4 3 4.45 3 5V12C3 12.55 3.45 13 4 13H11C11.55 13 12 12.55 12 12V10"
                    stroke="currentColor"
                    strokeWidth="1.5"
                    strokeLinecap="round"
                    strokeLinejoin="round"
                  />
                </svg>
                Open in editor
              </GhostButton>
            </Tooltip>
          ) : undefined
        }
        // Close is the SECOND control in the cluster — `primaryAction` is one
        // action, and jumping the file out to a real tab is the one this row
        // offers. Dismissal follows it.
        overflow={onClose ? <CloseIconButton aria-label="Close preview" onClick={onClose} /> : undefined}
      />
      {body ? (
        <div className="flex min-h-0 flex-1 flex-col p-3">{body}</div>
      ) : (
        <div className="flex-1 overflow-auto px-5 py-4 text-body leading-6 text-[color:var(--text-default)]">
          {renderAsMarkdown ? (
            <div className="markdown-body">{renderMarkdown(maskMarkdownFrontmatter(content))}</div>
          ) : (
            <pre className="whitespace-pre-wrap break-words font-mono text-body leading-5 text-[color:var(--text-default)]">
              {content}
            </pre>
          )}
        </div>
      )}
    </div>
  )
}
