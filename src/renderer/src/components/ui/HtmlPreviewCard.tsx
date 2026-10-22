import { useEffect, useState } from 'react'
import { WarningIcon } from '../AppIcons'
import { TruncatedText } from './TruncatedText'
import { inertHtml } from '../../utils/inertHtml'

// Shared card primitive: a small live render of one HTML file on disk + title +
// mono path meta + click-through. The live render holds the same scripts-off
// sandbox policy the full HtmlArtifactFrame does — scripts off, and never
// `allow-same-origin`. First consumer is the
// design-system component gallery; it is built reviewer-neutral so the
// backlog mockup-attachments surface can reuse the same card.
//
// The card reads its file once on mount (no fs watch of its own). Callers force
// a fresh render when the file changes by giving the card a React `key` that
// includes the file's mtime, so only cards whose file actually changed remount.

/**
 * The iframe sandbox token for this card's inert thumbnail. Scripts are off and
 * `allow-same-origin` is never granted, so generated HTML never receives
 * same-origin privileges. The interactive frame's own opt-in lives in
 * `htmlArtifact/HtmlArtifactFrame.tsx`, under the same rule.
 */
function htmlArtifactFrameSandbox(allowScripts: boolean): string {
  return allowScripts ? 'allow-scripts' : ''
}

type CardState = { kind: 'loading' } | { kind: 'ready'; content: string } | { kind: 'error' }

type Props = {
  /** Absolute on-disk path read for the live render. */
  absolutePath: string
  /** Workspace-root-relative path shown as mono meta. */
  relativePath: string
  /** Human title (the card's accessible name). */
  title: string
  /** Opens the file — e.g. switches the preview to its single-file view. */
  onOpen: () => void
  /** Roving-focus tab index; omit for a normal tab stop. */
  tabIndex?: number
  onFocus?: () => void
  buttonRef?: (element: HTMLButtonElement | null) => void
}

export function HtmlPreviewCard({ absolutePath, relativePath, title, onOpen, tabIndex, onFocus, buttonRef }: Props) {
  const [state, setState] = useState<CardState>({ kind: 'loading' })
  const [frameLoaded, setFrameLoaded] = useState(false)

  useEffect(() => {
    let cancelled = false
    setFrameLoaded(false)
    setState({ kind: 'loading' })
    void (async () => {
      try {
        const content = await window.api.readfile(absolutePath)
        if (cancelled) return
        // An empty or unreadable file is the render-error state: the card stays
        // clickable so opening it shows the raw file, never a blank tile.
        setState(content.trim() ? { kind: 'ready', content } : { kind: 'error' })
      } catch {
        if (!cancelled) setState({ kind: 'error' })
      }
    })()
    return () => {
      cancelled = true
    }
  }, [absolutePath])

  return (
    <button
      type="button"
      ref={buttonRef}
      tabIndex={tabIndex}
      onFocus={onFocus}
      onClick={onOpen}
      aria-label={state.kind === 'error' ? `${title} — the demo will not render; open to see the file` : title}
      className="
        flex w-full flex-col overflow-hidden rounded-md border border-[color:var(--border-subtle)] bg-[color:var(--bg-surface-raised)] text-left
        transition-colors hover:border-[color:var(--border-default)] hover:bg-[color:var(--bg-hover)]
        focus-visible:focus-ring
      "
    >
      <span
        aria-hidden="true"
        className="relative block h-[108px] overflow-hidden border-b border-[color:var(--border-subtle)] bg-[color:var(--bg-surface)]"
      >
        {state.kind === 'ready' ? (
          <iframe
            title=""
            tabIndex={-1}
            srcDoc={inertHtml(state.content)}
            sandbox={htmlArtifactFrameSandbox(false)}
            onLoad={() => setFrameLoaded(true)}
            // Zoomed-out thumbnail: render at 2× logical size anchored top-left
            // and scale to half, so the card shows the component's top-left
            // region filling the box. The frame is inert (pointer-events off) so
            // clicks reach the card.
            className={`pointer-events-none absolute left-0 top-0 border-0 bg-white transition-opacity duration-150 ${
              frameLoaded ? 'opacity-100' : 'opacity-0'
            }`}
            style={{
              width: '200%',
              height: '200%',
              transform: 'scale(0.5)',
              transformOrigin: 'top left',
            }}
          />
        ) : (
          <span className="absolute inset-0 flex flex-col items-center justify-center gap-1 px-3 text-center">
            {state.kind === 'loading' ? (
              <span className="text-micro text-[color:var(--text-subtle)]">Loading…</span>
            ) : (
              <>
                <WarningIcon className="icon-sm text-[color:var(--tone-error)]" />
                <span className="text-micro leading-4 text-[color:var(--text-muted)]">
                  Demo won’t render — open to see the file
                </span>
              </>
            )}
          </span>
        )}
      </span>
      <span className="flex flex-col gap-0.5 px-3 py-2">
        <span className="text-meta font-semibold text-[color:var(--text-strong)]">{title}</span>
        <TruncatedText as="span" text={relativePath} className="font-mono text-micro text-[color:var(--text-subtle)]" />
      </span>
    </button>
  )
}
