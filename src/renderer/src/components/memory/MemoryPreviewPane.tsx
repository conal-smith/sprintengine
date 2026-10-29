import React, { useEffect, useMemo, useRef } from 'react'
import { useWorkspaceStore } from '../../store/workspaceStore'
import { focusOrAddFileTab } from '../../utils/modelRegistry'
import { renderMarkdown } from '../../utils/markdown'
import { maskMarkdownFrontmatter } from '../../utils/markdownFrontmatter'
import { bucketForNode, colorForBucket } from './MemoryGraphCanvas'
import { Tooltip } from '../ui/Tooltip'
import { ChipButton, CloseIconButton, GhostButton, InlineNotice, PanelHeader } from '../ui'

type Props = {
  workspaceId: string
  /** The currently selected node (always one of `nodes`). */
  node: MemoryGraphNode
  /** Preview body — markdown body, plain text, or null while loading / on error. */
  preview: MemoryPreviewResult | null
  /** Full set of nodes so we can resolve Related pills. */
  nodes: MemoryGraphNode[]
  /** All edges so we can compute outgoing + incoming Related when frontmatter is empty. */
  edges: MemoryGraphEdge[]
  onNavigate: (node: MemoryGraphNode) => void
  onClose: () => void
}

export default function MemoryPreviewPane({ workspaceId, node, preview, nodes, edges, onNavigate, onClose }: Props) {
  const paneRef = useRef<HTMLElement>(null)
  const openFile = useWorkspaceStore((s) => s.openFile)

  // Build the Related list: frontmatter `related` + outgoing edges + incoming edges,
  // de-duplicated, in that priority order so explicit links lead.
  const related = useMemo(() => {
    const byId = new Map(nodes.map((n) => [n.id, n] as const))
    const seen = new Set<string>()
    const result: MemoryGraphNode[] = []
    const push = (id: string | undefined) => {
      if (!id || id === node.id || seen.has(id)) return
      const found = byId.get(id)
      if (!found) return
      seen.add(id)
      result.push(found)
    }
    node.related?.forEach(push)
    edges.forEach((edge) => {
      if (edge.source === node.id) push(edge.target)
    })
    edges.forEach((edge) => {
      if (edge.target === node.id) push(edge.source)
    })
    return result
  }, [node, nodes, edges])

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key !== 'Escape') return
      // A transient surface (menu, popover) that already handled Escape marks
      // the event — the pane must not also close (the topmost-surface rule).
      if (event.defaultPrevented) return
      const target = event.target
      if (target instanceof HTMLElement) {
        const tag = target.tagName
        if (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT' || target.isContentEditable) return
      }
      event.preventDefault()
      onClose()
    }
    window.addEventListener('keydown', onKeyDown)
    return () => window.removeEventListener('keydown', onKeyDown)
  }, [onClose])

  const bucket = bucketForNode(node)
  const color = colorForBucket(bucket)
  const title = node.title?.trim() || node.name
  const path = node.relativePath
  const canOpen =
    preview?.ok &&
    (preview.previewKind === 'markdown' || preview.previewKind === 'text' || preview.previewKind === 'image')

  const onOpenInEditor = () => {
    if (!preview?.ok) return
    if (preview.previewKind === 'markdown' || preview.previewKind === 'text') {
      openFile(workspaceId, preview.node.path, preview.node.name, preview.content)
      focusOrAddFileTab(workspaceId, preview.node.path, preview.node.name)
      onClose()
    } else if (preview.previewKind === 'image') {
      openFile(workspaceId, preview.node.path, preview.node.name, '')
      focusOrAddFileTab(workspaceId, preview.node.path, preview.node.name)
      onClose()
    }
  }

  return (
    <aside
      ref={paneRef}
      role="complementary"
      aria-label="Knowledge node preview"
      className="absolute inset-y-0 right-0 z-[var(--z-pane)] flex w-[min(560px,90%)] flex-col border-l border-[color:var(--border-default)] bg-[color:var(--bg-surface)] text-[color:var(--text-strong)] shadow-[var(--shadow-drawer)]"
    >
      {/* The identity row is `ui/PanelHeader` (2112). It was a three-line band
          at `px-5 py-4` with a `text-title` heading, so a drawer over the graph
          started its content lower than every panel beside it. What the band
          carried BESIDE the name — the bucket chip and the node's tags — is
          metadata about the node rather than chrome naming the pane, so it
          leads the body instead of stacking a second row into the header. */}
      <PanelHeader
        title={title}
        subtitle={path}
        primaryAction={
          canOpen ? (
            <GhostButton size="xs" onClick={onOpenInEditor}>
              Open in editor
            </GhostButton>
          ) : undefined
        }
        overflow={
          <Tooltip content="Close">
            <CloseIconButton size="md" aria-label="Close preview" onClick={onClose} />
          </Tooltip>
        }
      />

      <div className="min-h-0 flex-1 overflow-y-auto px-5 py-5">
        <div className="mb-4 flex flex-wrap items-center gap-1.5">
          {/* One idiom: the category dot carries the bucket's colour, the word
              sits in readable ink. The chip used to tint its border, ground
              AND ink from the same hex (a raw rgba written into style) while
              also drawing the dot — the same fact said twice. */}
          <span className="inline-flex items-center gap-1.5 rounded-sm border border-[color:var(--border-default)] bg-[color:var(--bg-surface-raised)] px-2 py-0.5 text-micro font-medium text-[color:var(--text-default)]">
            <span className="h-[6px] w-[6px] rounded-full" style={{ background: color }} aria-hidden />
            {bucket}
          </span>
          {node.tags?.slice(0, 4).map((tag) => (
            <span
              key={tag}
              className="rounded-sm border border-[color:var(--border-default)] bg-[color:var(--bg-surface-raised)] px-1.5 py-0.5 text-micro text-[color:var(--text-muted)]"
            >
              {tag}
            </span>
          ))}
        </div>
        {!preview ? (
          <PaneNotice message="Loading preview…" />
        ) : !preview.ok ? (
          <InlineNotice tone="error" className="px-4 py-3">
            {preview.message}
          </InlineNotice>
        ) : preview.previewKind === 'markdown' ? (
          <article className="memory-markdown">{renderMarkdown(maskMarkdownFrontmatter(preview.content))}</article>
        ) : preview.previewKind === 'text' ? (
          <pre className="m-0 overflow-x-auto rounded-sm border border-[color:var(--border-default)] bg-[color:var(--bg-app)] p-4 font-mono text-meta leading-5 text-[color:var(--text-default)]">
            {preview.content}
          </pre>
        ) : preview.previewKind === 'image' ? (
          <div className="flex min-h-[240px] items-center justify-center">
            <img
              src={preview.dataUrl}
              alt={preview.node.name}
              className="max-h-[60vh] max-w-full object-contain"
              draggable={false}
            />
          </div>
        ) : preview.previewKind === 'unsupported' ? (
          <PaneNotice message={preview.message} />
        ) : null}
      </div>

      {related.length > 0 ? (
        <footer className="shrink-0 border-t border-[color:var(--border-default)] px-5 py-4">
          <div className="mb-2 text-micro font-semibold text-[color:var(--text-muted)]">Related</div>
          <div className="flex flex-wrap gap-1.5">
            {related.map((target) => {
              const targetBucket = bucketForNode(target)
              const targetColor = colorForBucket(targetBucket)
              const label = target.title?.trim() || target.name.replace(/\.mdx?$/i, '')
              return (
                <ChipButton
                  key={target.id}
                  // The outline chip is what a related-node mark on a canvas takes:
                  // findable on a busy surface, and content-height so the wrap row
                  // keeps its rhythm.
                  variant="outline"
                  tone="neutral"
                  onClick={() => onNavigate(target)}
                >
                  <span className="h-[6px] w-[6px] rounded-full" style={{ background: targetColor }} aria-hidden />
                  {label}
                </ChipButton>
              )
            })}
          </div>
        </footer>
      ) : null}
    </aside>
  )
}

function PaneNotice({ message }: { message: string }) {
  return <div className="flex h-32 items-center justify-center text-body text-[color:var(--text-muted)]">{message}</div>
}
