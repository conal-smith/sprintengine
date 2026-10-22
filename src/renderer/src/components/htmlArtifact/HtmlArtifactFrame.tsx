import { useEffect, useState, type ReactNode } from 'react'
import { ChipButton, GhostButton, IconButton, Skeleton, Tooltip, TruncatedText } from '../ui'
import { basename } from '../../utils/paths'
import { inertHtml } from '../../utils/inertHtml'

// The generated-HTML artifact viewer: one file on disk, live-rendered in a
// scripts-off sandbox, with device widths, zoom and an optional source view.
// It lives here, on its own, rather than beside any one consumer: every mockup
// surface renders the same frame.
//
// The scripts-off sandbox policy is `htmlFrameSandbox` below, which never adds
// `allow-same-origin`; the shared HtmlPreviewCard thumbnail spells the same
// rule for its own inert frame.

// The preview never shows an undesigned void: every non-rendered situation maps
// to one of four designed states derived from a real file signal.
// `generating` = the file exists but is still empty (the agent is mid-write);
// `deleted` = the selected file is gone from disk; `error` = it could not be
// read. `loading` is the brief first read before any of these resolve.
type FrameState =
  | { kind: 'loading' }
  | { kind: 'ready'; content: string }
  | { kind: 'generating' }
  | { kind: 'deleted' }
  | { kind: 'error'; reason: string }

type BrowserOpenState = { kind: 'idle' } | { kind: 'opening' } | { kind: 'failed'; reason: string }

// Reviewing a responsive mockup needs real device widths, not whatever width
// the pane happens to be. Fixed widths render the iframe on a centered,
// scrollable stage; Fit fills the pane. Zoom scales the rendered document
// while keeping its layout width truthful.
export type HtmlPreviewViewport = 'fit' | 1280 | 768 | 390

const PREVIEW_VIEWPORTS: ReadonlyArray<{ id: HtmlPreviewViewport; label: string }> = [
  { id: 'fit', label: 'Fit' },
  { id: 1280, label: '1280' },
  { id: 768, label: '768' },
  { id: 390, label: '390' },
]

const PREVIEW_ZOOMS = [1, 0.75, 0.5] as const
export type HtmlPreviewZoom = (typeof PREVIEW_ZOOMS)[number]

/**
 * Sandbox for the preview iframe: scripts off by default, `allow-scripts` only
 * behind the explicit interactive-demo toggle, and never `allow-same-origin`.
 */
function htmlFrameSandbox(allowScripts: boolean): string {
  return allowScripts ? 'allow-scripts' : ''
}

function nextHtmlPreviewZoom(zoom: HtmlPreviewZoom): HtmlPreviewZoom {
  const index = PREVIEW_ZOOMS.indexOf(zoom)
  return PREVIEW_ZOOMS[(index + 1) % PREVIEW_ZOOMS.length]
}

// The Source view is an opt-in mode (default off), so a host that does not ask
// for it is unchanged: no toggle,
// always the rendered iframe, all preview controls. Source only exists to read
// the raw HTML text, so it hides the preview-only controls (viewport, zoom,
// allow-scripts) that shape the rendered iframe and never itself run scripts.
export type HtmlArtifactViewMode = 'preview' | 'source'

export type HtmlArtifactView = {
  showToggle: boolean
  mode: HtmlArtifactViewMode
  showsSource: boolean
  showsPreviewControls: boolean
}

function resolveHtmlArtifactView(enableSourceView: boolean, viewMode: HtmlArtifactViewMode): HtmlArtifactView {
  const mode: HtmlArtifactViewMode = enableSourceView ? viewMode : 'preview'
  const isSource = mode === 'source'
  return {
    showToggle: enableSourceView,
    mode,
    showsSource: isSource,
    showsPreviewControls: !isSource,
  }
}

const HTML_ARTIFACT_VIEW_MODES: ReadonlyArray<{ id: HtmlArtifactViewMode; label: string }> = [
  { id: 'preview', label: 'Preview' },
  { id: 'source', label: 'Source' },
]

function browserOpenFailureMessage(relativePath: string, failure: 'missing' | 'handler', error?: unknown): string {
  if (failure === 'missing') {
    return `${relativePath} is missing on disk. Reload the preview or regenerate the mockup before opening it.`
  }
  const detail = error instanceof Error ? error.message.trim() : ''
  return detail
    ? `Could not open ${relativePath} in your browser: ${detail}`
    : `Could not open ${relativePath} in your browser. Check your default browser and try again.`
}

/**
 * A human display title for a file, used as the fallback when no HTML `<title>`
 * is present: drop the extension, strip a leading ISO date prefix
 * (`2026-07-06-panel-header.html` → `Panel header`) so a raw date-prefixed
 * filename never reads as a primary label, then sentence-case.
 */
export function humanizeFileTitle(name: string): string {
  const base = basename(name)
    .replace(/\.[a-z0-9]+$/i, '')
    .replace(/^\d{4}-\d{2}-\d{2}[-_]?/, '')
    .replace(/[-_]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
  if (!base) return basename(name)
  return base.charAt(0).toUpperCase() + base.slice(1)
}

/**
 * Backlog mockup HTML files open with a YAML frontmatter block (`---` / `id: N` /
 * `---`, written by the scan-time id allocation) that a browser would paint as
 * literal text above the document. Strip it from the rendered document only —
 * Source view and the on-disk file keep the real bytes.
 */
function stripHtmlFrontmatter(content: string): string {
  const match = /^\uFEFF?---\r?\n[\s\S]*?\r?\n---\r?\n?/.exec(content)
  return match ? content.slice(match[0].length) : content
}

/** The `<title>` text of an HTML document, whitespace-collapsed; null when absent or empty. */
function pageTitleFromHtml(html: string): string | null {
  const match = /<title[^>]*>([\s\S]*?)<\/title>/i.exec(html)
  if (!match) return null
  const text = match[1].replace(/\s+/g, ' ').trim()
  return text || null
}

/**
 * The preview title bar's primary label for an HTML file: its `<title>` when the
 * content is loaded and has one, otherwise the humanized filename. The path is
 * shown demoted beneath it, never as the primary label.
 */
function htmlPreviewTitle(relativePath: string, content: string | null): string {
  const fromDocument = content ? pageTitleFromHtml(content) : null
  return fromDocument ?? humanizeFileTitle(relativePath)
}

/**
 * Sandboxed HTML preview for a single real file on disk. Reads the file through
 * the existing IPC, re-reads on fs-watch changes and explicit reload, and runs
 * it in an iframe with scripts off by default behind an explicit allow-scripts
 * toggle. Shared by the mockup review tab and the studio's Design preview pane
 * so the sandbox behavior is defined once. No `webview`; generated HTML never
 * receives same-origin privileges, and the interactive toggle only adds scripts.
 */
export function HtmlArtifactFrame({
  absolutePath,
  relativePath,
  watchDirectoryPath,
  enableSourceView = false,
}: {
  absolutePath: string
  relativePath: string
  watchDirectoryPath: string
  enableSourceView?: boolean
}) {
  const [allowScripts, setAllowScripts] = useState(false)
  const [viewMode, setViewMode] = useState<HtmlArtifactViewMode>('preview')
  const [frameState, setFrameState] = useState<FrameState>({ kind: 'loading' })
  const [browserOpenState, setBrowserOpenState] = useState<BrowserOpenState>({ kind: 'idle' })
  const [copiedPath, setCopiedPath] = useState(false)
  const [reloadNonce, setReloadNonce] = useState(0)
  // Viewport and zoom deliberately persist across file changes — a review
  // pass at mobile width stays at mobile width while flipping screens.
  const [viewport, setViewport] = useState<HtmlPreviewViewport>('fit')
  const [zoom, setZoom] = useState<HtmlPreviewZoom>(1)
  // The iframe stays invisible until its document loads, so the empty white
  // canvas never flashes over the dark stage before a dark mockup paints.
  const [frameLoaded, setFrameLoaded] = useState(false)

  // Reset scripts to off whenever the previewed file changes — the safe default
  // must not carry over from a previously trusted file.
  useEffect(() => {
    setAllowScripts(false)
    setBrowserOpenState({ kind: 'idle' })
    setCopiedPath(false)
  }, [absolutePath])

  useEffect(() => {
    setFrameLoaded(false)
  }, [absolutePath, allowScripts, reloadNonce])

  useEffect(() => {
    let cancelled = false
    let stopWatch: (() => Promise<void>) | null = null

    const load = async () => {
      try {
        const exists = await window.api.pathExists(absolutePath)
        if (cancelled) return
        if (!exists) {
          setFrameState((prev) => (prev.kind === 'deleted' ? prev : { kind: 'deleted' }))
          return
        }
        const content = await window.api.readfile(absolutePath)
        if (cancelled) return
        if (!content.trim()) {
          // Exists but empty — the agent is still writing it. A designed
          // generating state, never a black void.
          setFrameState((prev) => (prev.kind === 'generating' ? prev : { kind: 'generating' }))
          return
        }
        // The watch covers the whole directory, so sibling-file events re-read
        // this file; keep the previous state object when the content is
        // unchanged so those events don't re-render the pane.
        setFrameState((prev) => (prev.kind === 'ready' && prev.content === content ? prev : { kind: 'ready', content }))
      } catch (error) {
        if (cancelled) return
        setFrameState({
          kind: 'error',
          reason:
            error instanceof Error
              ? `Could not read ${relativePath}: ${error.message}`
              : `Could not read ${relativePath}.`,
        })
      }
    }

    void load()
    void window.api
      .watchPath(watchDirectoryPath, () => {
        void load()
      })
      .then((stop) => {
        if (cancelled) {
          void stop()
          return
        }
        stopWatch = stop
      })
      .catch(() => {})

    return () => {
      cancelled = true
      if (stopWatch) void stopWatch()
    }
  }, [absolutePath, relativePath, watchDirectoryPath, reloadNonce])

  const onOpenInBrowser = async () => {
    setBrowserOpenState({ kind: 'opening' })
    try {
      const exists = await window.api.pathExists(absolutePath)
      if (!exists) {
        setBrowserOpenState({
          kind: 'failed',
          reason: browserOpenFailureMessage(relativePath, 'missing'),
        })
        return
      }
      await window.api.openHtmlFileInBrowser(absolutePath)
      setBrowserOpenState({ kind: 'idle' })
    } catch (error) {
      setBrowserOpenState({
        kind: 'failed',
        reason: browserOpenFailureMessage(relativePath, 'handler', error),
      })
    }
  }

  const onCopyPath = async () => {
    try {
      await window.api.clipboardWriteText(relativePath)
      setCopiedPath(true)
      window.setTimeout(() => setCopiedPath(false), 1400)
    } catch {
      // Clipboard failures are non-critical; leave the label unchanged.
    }
  }

  const view = resolveHtmlArtifactView(enableSourceView, viewMode)
  // The page title (from the document's own <title>) leads; the path is demoted
  // beneath it. Falls back to the humanized filename before the content loads.
  const pageTitle = htmlPreviewTitle(relativePath, frameState.kind === 'ready' ? frameState.content : null)

  return (
    <div className="relative flex min-h-0 flex-1 flex-col overflow-hidden rounded-md border border-[color:var(--border-default)] bg-[color:var(--bg-surface)]">
      {/* flex-wrap: narrow hosts (e.g. a narrow detail pane) fit fewer
          controls than the full cluster — wrapping to a second row keeps every
          control reachable instead of clipping under overflow-hidden. */}
      <div className="flex shrink-0 flex-wrap items-center gap-3 gap-y-1 border-b border-[color:var(--border-subtle)] px-3 py-2">
        <span className="flex min-w-0 flex-col leading-tight">
          <TruncatedText
            as="span"
            text={pageTitle}
            className="min-w-0 text-meta font-semibold text-[color:var(--text-strong)]"
          />
          <TruncatedText
            as="span"
            text={relativePath}
            className="min-w-0 font-mono text-micro text-[color:var(--text-subtle)]"
          />
        </span>
        <span className="ml-auto flex min-w-0 flex-wrap items-center justify-end gap-1">
          {view.showToggle ? (
            <span role="group" aria-label="View mode" className="flex items-center gap-0.5">
              {HTML_ARTIFACT_VIEW_MODES.map((option) => (
                <ChipButton key={option.id} onClick={() => setViewMode(option.id)} pressed={view.mode === option.id}>
                  {option.label}
                </ChipButton>
              ))}
            </span>
          ) : null}
          {view.showsPreviewControls ? (
            <>
              <span role="group" aria-label="Viewport width" className="flex items-center gap-0.5">
                {PREVIEW_VIEWPORTS.map((option) => (
                  <ChipButton
                    key={option.label}
                    onClick={() => setViewport(option.id)}
                    pressed={viewport === option.id}
                    className="tabular-nums"
                  >
                    {option.label}
                  </ChipButton>
                ))}
              </span>
              <ChipButton
                onClick={() => setZoom((value) => nextHtmlPreviewZoom(value))}
                aria-label={`Zoom ${Math.round(zoom * 100)} percent`}
                className="tabular-nums"
              >
                {Math.round(zoom * 100)}%
              </ChipButton>
              {/* Hairline between the viewport+zoom cluster and the actions cluster. */}
              <span aria-hidden="true" className="mx-0.5 h-4 w-px bg-[color:var(--border-subtle)]" />
            </>
          ) : null}
          <Tooltip content="Reload">
            <IconButton size="xs" aria-label="Reload preview" onClick={() => setReloadNonce((nonce) => nonce + 1)}>
              <svg viewBox="0 0 16 16" fill="none" className="icon-xs" aria-hidden="true">
                <path d="M13 8a5 5 0 1 1-1.5-3.6" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" />
                <path
                  d="M13 1.8v3h-3"
                  stroke="currentColor"
                  strokeWidth="1.5"
                  strokeLinecap="round"
                  strokeLinejoin="round"
                />
              </svg>
            </IconButton>
          </Tooltip>
          <Tooltip content={copiedPath ? 'Copied' : 'Copy path'}>
            <IconButton size="xs" aria-label="Copy path" onClick={() => void onCopyPath()}>
              <svg viewBox="0 0 16 16" fill="none" className="icon-xs" aria-hidden="true">
                <rect x="5.5" y="5.5" width="8" height="8" rx="1.5" stroke="currentColor" strokeWidth="1.4" />
                <path
                  d="M10.5 3.5v-1a1 1 0 0 0-1-1h-6a1 1 0 0 0-1 1v6a1 1 0 0 0 1 1h1"
                  stroke="currentColor"
                  strokeWidth="1.4"
                />
              </svg>
            </IconButton>
          </Tooltip>
          {view.showsPreviewControls ? (
            // The chip's `warn` tone: the standing warning the control itself
            // carries — scripts are running in this preview, and this is where
            // they are turned off (design-system/components/chip-button → Tone).
            <ChipButton tone="warn" onClick={() => setAllowScripts((value) => !value)} pressed={allowScripts}>
              {allowScripts ? (
                <>
                  <span
                    aria-hidden="true"
                    className="inline-flex h-4 w-4 shrink-0 items-center justify-center rounded-full border border-current text-micro font-semibold leading-none"
                  >
                    !
                  </span>
                  Scripts on
                </>
              ) : (
                <>Allow interactive demo</>
              )}
            </ChipButton>
          ) : null}
          {/* `busy`, not merely disabled: the control is off BECAUSE it is
              working, so the cursor says wait rather than no. */}
          <GhostButton
            size="xs"
            onClick={() => void onOpenInBrowser()}
            disabled={browserOpenState.kind === 'opening'}
            busy={browserOpenState.kind === 'opening'}
          >
            {browserOpenState.kind === 'opening' ? 'Opening…' : 'Open in browser'}
          </GhostButton>
        </span>
      </div>
      {browserOpenState.kind === 'failed' ? (
        <div
          role="alert"
          aria-live="polite"
          className="shrink-0 border-b border-[color:var(--border-subtle)] bg-[color:var(--tone-warn-soft)] px-3 py-2 text-meta leading-5 text-[color:var(--tone-warn)]"
        >
          {browserOpenState.reason}
        </div>
      ) : null}
      <div className="relative min-h-0 flex-1 overflow-auto bg-[color:var(--bg-app)]">
        {frameState.kind === 'ready' && view.showsSource ? (
          <pre className="m-0 min-h-full whitespace-pre px-4 py-3 font-mono text-micro leading-5 text-[color:var(--text-default)]">
            {frameState.content}
          </pre>
        ) : frameState.kind === 'ready' ? (
          <div className={viewport === 'fit' ? 'h-full w-full' : 'flex min-h-full justify-center px-4 py-4'}>
            <div
              className={
                viewport === 'fit'
                  ? 'relative h-full w-full overflow-hidden'
                  : 'relative h-full shrink-0 overflow-hidden rounded-md border border-[color:var(--border-strong)]'
              }
              style={viewport === 'fit' ? undefined : { width: viewport * zoom }}
            >
              <iframe
                key={`${absolutePath}::${allowScripts ? 'scripts' : 'no-scripts'}::${reloadNonce}`}
                title={`Preview · ${pageTitle}`}
                srcDoc={
                  allowScripts
                    ? stripHtmlFrontmatter(frameState.content)
                    : inertHtml(stripHtmlFrontmatter(frameState.content))
                }
                sandbox={htmlFrameSandbox(allowScripts)}
                onLoad={() => setFrameLoaded(true)}
                className={`border-0 bg-white transition-opacity duration-150 ${frameLoaded ? 'opacity-100' : 'opacity-0'}`}
                style={{
                  width: viewport === 'fit' ? `${100 / zoom}%` : viewport,
                  height: `${100 / zoom}%`,
                  transform: zoom === 1 ? undefined : `scale(${zoom})`,
                  transformOrigin: 'top left',
                }}
              />
            </div>
          </div>
        ) : frameState.kind === 'generating' ? (
          <PreviewState
            title="Building this page…"
            body="The preview refreshes automatically as the file is written."
            skeleton
          />
        ) : frameState.kind === 'deleted' ? (
          <PreviewState
            glyph="deleted"
            title="This file isn’t on disk"
            path={relativePath}
            body="It may have been removed since you selected it, or not written yet. Pick another file, or reload."
          />
        ) : frameState.kind === 'error' ? (
          <PreviewState glyph="error" tone="warn" title="This file can’t be previewed" body={frameState.reason} />
        ) : (
          <PreviewState title="Loading preview…" skeleton />
        )}
        {/* Paint gap: hold a shimmer over the dark stage until the iframe's own
            document paints, so a dark mockup never flashes an undesigned void. */}
        {frameState.kind === 'ready' && !view.showsSource && !frameLoaded ? (
          <div className="pointer-events-none absolute inset-0 bg-[color:var(--bg-surface)]">
            <PreviewSkeletonLines />
          </div>
        ) : null}
      </div>
    </div>
  )
}

type PreviewStateGlyph = 'deleted' | 'error'

/**
 * A designed non-render state shared by the HTML preview frame and the artifact
 * preview pane: a shape glyph, a title, an optional demoted path, and
 * body copy — neutral by default, warn-toned for a genuine failure. The glyph
 * shape (not color) carries the meaning, so it survives grayscale. `skeleton`
 * swaps the glyph for a shimmer stack for the generating/loading states.
 */
function PreviewState({
  glyph,
  tone = 'neutral',
  title,
  path,
  body,
  skeleton = false,
}: {
  glyph?: PreviewStateGlyph
  tone?: 'neutral' | 'warn'
  title: string
  path?: string
  body?: ReactNode
  skeleton?: boolean
}) {
  if (skeleton) {
    return (
      <div className="flex h-full flex-col items-center justify-center gap-4 px-6 text-center">
        <span className="flex flex-col items-center gap-1">
          <span className="text-meta font-semibold text-[color:var(--text-strong)]">{title}</span>
          {body ? (
            <span className="max-w-[360px] text-meta leading-5 text-[color:var(--text-muted)]">{body}</span>
          ) : null}
        </span>
        <span className="flex w-full max-w-[280px] flex-col gap-2.5">
          <Skeleton className="h-3 w-3/5 rounded bg-[color:var(--bg-surface-raised)]" />
          <Skeleton className="h-3 w-4/5 rounded bg-[color:var(--bg-surface-raised)]" />
          <Skeleton className="h-24 w-full rounded bg-[color:var(--bg-surface-raised)]" />
          <Skeleton className="h-3 w-2/5 rounded bg-[color:var(--bg-surface-raised)]" />
        </span>
      </div>
    )
  }
  return (
    <div className="flex h-full flex-col items-center justify-center gap-2 px-6 text-center">
      {glyph ? <PreviewGlyph glyph={glyph} tone={tone} /> : null}
      <span
        className={`text-meta font-semibold ${
          tone === 'warn' ? 'text-[color:var(--tone-warn)]' : 'text-[color:var(--text-strong)]'
        }`}
      >
        {title}
      </span>
      {path ? (
        <span className="max-w-full truncate font-mono text-micro text-[color:var(--text-subtle)]">{path}</span>
      ) : null}
      {body ? <span className="max-w-[360px] text-meta leading-5 text-[color:var(--text-muted)]">{body}</span> : null}
    </div>
  )
}

function PreviewGlyph({ glyph, tone }: { glyph: PreviewStateGlyph; tone: 'neutral' | 'warn' }) {
  const color = tone === 'warn' ? 'var(--tone-warn)' : 'var(--text-subtle)'
  if (glyph === 'error') {
    return (
      <svg viewBox="0 0 16 16" className="h-5 w-5" aria-hidden="true" style={{ color }}>
        <path d="M8 2 15 14H1z" fill="none" stroke="currentColor" strokeWidth="1.4" strokeLinejoin="round" />
        <path d="M8 6.5v3.4" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" />
      </svg>
    )
  }
  // deleted — a hollow circle with a diagonal slash (removed from the set).
  return (
    <svg viewBox="0 0 16 16" className="h-5 w-5" aria-hidden="true" style={{ color }}>
      <circle cx="8" cy="8" r="6" fill="none" stroke="currentColor" strokeWidth="1.4" />
      <path d="M4.2 11.8 11.8 4.2" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" />
    </svg>
  )
}

// Centered shimmer stack, filling its container — the paint-gap overlay behind
// a not-yet-painted iframe. The shared Skeleton honors prefers-reduced-motion.
function PreviewSkeletonLines() {
  return (
    <div className="flex h-full flex-col items-center justify-center gap-2.5 px-6">
      <span className="flex w-full max-w-[280px] flex-col gap-2.5">
        <Skeleton className="h-3 w-3/5 rounded bg-[color:var(--bg-surface-raised)]" />
        <Skeleton className="h-3 w-4/5 rounded bg-[color:var(--bg-surface-raised)]" />
        <Skeleton className="h-24 w-full rounded bg-[color:var(--bg-surface-raised)]" />
        <Skeleton className="h-3 w-2/5 rounded bg-[color:var(--bg-surface-raised)]" />
      </span>
    </div>
  )
}
