import React, { useCallback, useEffect, useRef, useState } from 'react'
import MonacoEditor from '@monaco-editor/react'
import type * as Monaco from 'monaco-editor'
import { detectLanguage } from '../../utils/files'
import {
  isEditorBeingTyped,
  onEditorLandingQueued,
  peekEditorLanding,
  queueEditorLanding,
  revealEditorRange,
  takeEditorLanding,
} from '../../utils/agentEditorReveal'
import type { EditorRange } from '../../../../shared/editor-reveal'
import { remeasureMonacoFontsOnLoad, useCodeFontFamily } from '../../utils/fonts'
import { useMonacoBaseTheme } from '../../hooks/useAppTheme'
import { renderMarkdown } from '../../utils/markdown'
import { configureMonacoLanguages } from '../../utils/patchLanguage'
import { TITLE_BAR_HEIGHT, TRAFFIC_LIGHT_INSET } from '../workspace/AppTitleBar'
import { WindowCloseButton } from '../workspace/WindowControls'
import {
  CloseIconButton,
  EmptyState,
  GhostButton,
  IconButton,
  InlineNotice,
  RowButton,
  Spinner,
  Tooltip,
  useConfirmDialog,
} from '../ui'
import {
  createExternalFileLoadingBuffer,
  createExternalFileTab,
  isExternalFileBufferDirty,
  loadExternalFileBuffer,
  type ExternalFileBuffer,
  type ExternalFileTab,
} from './externalEditorFile'
import { EditorFileTree } from './EditorFileTree'
import {
  EDITOR_TREE_DEFAULT_WIDTH,
  EDITOR_TREE_MAX_WIDTH,
  EDITOR_TREE_MIN_WIDTH,
  clampEditorTreeWidth,
  readEditorTreePrefs,
  writeEditorTreePrefs,
  type EditorTreePrefs,
} from './editorTreePrefs'
import { startColumnResizeDrag } from '../workspace/columnResizeDrag'
import { splitTreePath } from '../../utils/fileTreeEntries'
import { isLetterKey } from '../../utils/keyboard'
import { applyDiskContentToEditor, classifyDiskChange, oneAtATime, readFileOnDisk } from '../../utils/editorDiskSync'
import { watchFileOnDisk } from '../../utils/fileDiskWatch'
import { EditorDiskNotice, type EditorDiskNoticeState } from '../panels/editor/EditorDiskNotice'

// Match EditorPanel: above this size the rendered preview is disabled and the
// file falls back to the Monaco source view so a huge document can't hang the
// markdown renderer.
const MARKDOWN_PREVIEW_MAX_CHARS = 2 * 1024 * 1024

// This window has no workspace shell, so its reveal landings share one key.
const EXTERNAL_WINDOW_LANDING_SCOPE = 'external-editor'

// One open file in the external editor window. Content is read off disk and
// edited in place; `saved` is the on-disk baseline used to derive the dirty dot.
type FileTab = ExternalFileTab
type FileBuffer = ExternalFileBuffer

type DiskNotice = EditorDiskNoticeState

type IncomingFile = {
  filePath: string
  fileName: string
  workspaceId: string
  // An agent's reveal: the lines to land on (highlighted, caret untouched),
  // and whether to add the tab behind the one the person is on.
  revealRange?: EditorRange | null
  revealBackground?: boolean
  /** An agent's open rather than the person's own. */
  revealByAgent?: boolean
  /** The folder the tree shows for this file; empty when the opener knew none. */
  rootPath: string
}

type Props = {
  // The most recent file the opener asked to show. `nonce` bumps on every
  // request (even a repeat of the same path) so re-opening focuses its tab.
  incoming: IncomingFile | null
  nonce: number
}

function isDirty(buffer: FileBuffer | undefined): boolean {
  return isExternalFileBufferDirty(buffer)
}

/**
 * The folder the tree shows for a tab. The opener's answer when it gave one —
 * the workspace's working root, resolved where the workspace is known. With
 * none (a window opened from somewhere that knew no workspace), the file's own
 * repository, and failing that its folder: never a blank tree.
 */
function useTreeRoot(tab: FileTab | null): string | null {
  const [resolved, setResolved] = useState<Record<string, string>>({})
  const path = tab?.path ?? null
  const given = tab?.rootPath ?? ''
  useEffect(() => {
    if (!path || given || resolved[path]) return
    let cancelled = false
    const folder = splitTreePath(path).directory || path
    const lookup =
      typeof window.api.getGitRepoRoot === 'function'
        ? window.api.getGitRepoRoot(folder).catch(() => null)
        : Promise.resolve(null)
    void lookup.then((repoRoot) => {
      if (cancelled) return
      setResolved((current) => ({ ...current, [path]: repoRoot || folder }))
    })
    return () => {
      cancelled = true
    }
  }, [given, path, resolved])
  if (!path) return null
  return given || resolved[path] || null
}

export default function ExternalEditorWindow({ incoming, nonce }: Props) {
  const isMac = window.api.platform === 'darwin'
  const monacoTheme = useMonacoBaseTheme()
  const codeFontFamily = useCodeFontFamily()
  const { confirm: confirmDialog } = useConfirmDialog()
  const [tabs, setTabs] = useState<FileTab[]>([])
  const [activePath, setActivePath] = useState<string | null>(null)
  const [buffers, setBuffers] = useState<Record<string, FileBuffer>>({})
  // Markdown files default to the rendered preview; the toggle drops to the
  // Monaco source view for editing, mirroring the in-app EditorPanel.
  const [markdownMode, setMarkdownMode] = useState<'preview' | 'source'>('preview')
  // The tree column: shown, and how wide. The window's own, in its own
  // localStorage key — never the shared settings (see editorTreePrefs.ts).
  const [treePrefs, setTreePrefs] = useState<EditorTreePrefs>(readEditorTreePrefs)
  const [treeResizing, setTreeResizing] = useState(false)
  const treeColumnRef = useRef<HTMLElement>(null)
  const treeDragWidthRef = useRef<number | null>(null)
  const contentRef = useRef<HTMLDivElement>(null)
  const tabsRef = useRef<FileTab[]>([])
  tabsRef.current = tabs
  const activePathRef = useRef<string | null>(null)
  activePathRef.current = activePath
  const editorRef = useRef<Monaco.editor.IStandaloneCodeEditor | null>(null)
  const lastKeyAtRef = useRef(0)
  // Land an agent's range on the file on screen: now, when it is already
  // mounted, or from the mount that follows it becoming the active tab.
  const landActive = useCallback(() => {
    const editor = editorRef.current
    const path = activePathRef.current
    if (!editor || !path || !editor.getModel()) return
    const landing = takeEditorLanding(EXTERNAL_WINDOW_LANDING_SCOPE, path)
    if (!landing) return
    window.requestAnimationFrame(() => {
      if (editorRef.current === editor) revealEditorRange(editor, landing.range, { highlight: true, moveCaret: false })
    })
  }, [])
  useEffect(() => onEditorLandingQueued(landActive), [landActive])
  const buffersRef = useRef<Record<string, FileBuffer>>({})
  buffersRef.current = buffers
  const [diskNotices, setDiskNotices] = useState<Record<string, DiskNotice>>({})
  const setDiskNotice = useCallback((path: string, notice: DiskNotice | null) => {
    setDiskNotices((prev) => {
      if (!notice) {
        if (!(path in prev)) return prev
        const next = { ...prev }
        delete next[path]
        return next
      }
      return { ...prev, [path]: notice }
    })
  }, [])

  // Puts what is on disk into a tab: into the editor first when the tab is on
  // screen, as an edit over just the lines that changed (caret, scroll and undo
  // survive it), then into the buffer as both the text and its saved baseline.
  const takeDiskContent = useCallback(
    (path: string, content: string) => {
      const editor = editorRef.current
      if (editor && activePathRef.current === path) applyDiskContentToEditor(editor, content)
      setBuffers((prev) => {
        const current = prev[path]
        if (!current || current.kind !== 'text') return prev
        return { ...prev, [path]: { ...current, value: content, saved: content } }
      })
      setDiskNotice(path, null)
    },
    [setDiskNotice],
  )

  // One tab against the file on disk, after its folder watch said it may have
  // changed. `saved` is the baseline: what the tab last read or wrote.
  const syncTabWithDisk = useCallback(
    async (path: string) => {
      const read = await readFileOnDisk(window.api, path)
      const buffer = buffersRef.current[path]
      if (!tabsRef.current.some((tab) => tab.path === path)) return
      if (!buffer || buffer.kind !== 'text' || buffer.loading || buffer.error) return
      if (read.kind === 'unreadable') return
      if (read.kind === 'missing') {
        setDiskNotice(path, { kind: 'deleted' })
        return
      }
      const change = classifyDiskChange({
        disk: read.content,
        buffer: buffer.value,
        baseline: buffer.saved,
        dirty: isDirty(buffer),
      })
      if (change === 'reload') {
        takeDiskContent(path, read.content)
        return
      }
      if (change === 'conflict') {
        setDiskNotice(path, { kind: 'changed', content: read.content })
        return
      }
      if (change === 'in-sync') {
        setBuffers((prev) => {
          const current = prev[path]
          if (!current || current.kind !== 'text') return prev
          return { ...prev, [path]: { ...current, saved: read.content } }
        })
      }
      setDiskNotice(path, null)
    },
    [setDiskNotice, takeDiskContent],
  )
  const syncTabWithDiskRef = useRef(syncTabWithDisk)
  syncTabWithDiskRef.current = syncTabWithDisk

  // Every text tab watches its file, through the folder watch it shares with
  // the other tabs in that folder; a closed tab stops. A folder that cannot be
  // watched (an SSH machine's) leaves its tabs as they were.
  const diskWatchesRef = useRef(new Map<string, () => void>())
  useEffect(() => {
    const watches = diskWatchesRef.current
    const wanted = new Set(tabs.filter((tab) => tab.kind === 'text').map((tab) => tab.path))
    for (const [path, stop] of watches) {
      if (wanted.has(path)) continue
      stop()
      watches.delete(path)
    }
    for (const path of wanted) {
      if (watches.has(path)) continue
      watches.set(
        path,
        watchFileOnDisk(
          path,
          oneAtATime(() => syncTabWithDiskRef.current(path)),
        ),
      )
    }
  }, [tabs])
  useEffect(() => {
    const watches = diskWatchesRef.current
    return () => {
      for (const stop of watches.values()) stop()
      watches.clear()
    }
  }, [])

  const loadBuffer = useCallback((tab: FileTab) => {
    setBuffers((prev) => ({ ...prev, [tab.path]: createExternalFileLoadingBuffer(tab.kind) }))
    void loadExternalFileBuffer(tab.path, tab.kind, window.api).then((buffer) => {
      setBuffers((prev) => ({ ...prev, [tab.path]: buffer }))
    })
  }, [])

  // Add (or focus) the incoming file as a tab whenever the opener sends one.
  useEffect(() => {
    if (!incoming) return
    const { filePath, fileName, workspaceId, rootPath } = incoming
    if (incoming.revealRange) {
      queueEditorLanding(EXTERNAL_WINDOW_LANDING_SCOPE, filePath, {
        range: incoming.revealRange,
        takeFocus: false,
        highlight: true,
      })
    }
    // Behind the person's tab when they are typing — in the main window (the
    // opener says so) or here, in this window's own editor, which the opener
    // cannot see. In front otherwise.
    const typingHere = isEditorBeingTyped(editorRef.current, lastKeyAtRef.current)
    const keepCurrent =
      (incoming.revealBackground || (incoming.revealByAgent && typingHere)) &&
      activePathRef.current !== null &&
      activePathRef.current !== filePath
    if (!keepCurrent) setActivePath(filePath)
    if (!tabsRef.current.some((tab) => tab.path === filePath)) {
      const tab = createExternalFileTab({ path: filePath, name: fileName, workspaceId, rootPath })
      setTabs((prev) => [...prev, tab])
      loadBuffer(tab)
    }
  }, [nonce])

  const activeTab = tabs.find((tab) => tab.path === activePath) ?? null
  const treeRoot = useTreeRoot(activeTab)

  const updateTreePrefs = useCallback((next: EditorTreePrefs) => {
    setTreePrefs(next)
    writeEditorTreePrefs(next)
  }, [])

  // A file picked in the tree opens here, as a tab, under the root the tree is
  // showing — so the tree stays on that root when the new tab becomes active.
  const openFromTree = useCallback(
    (path: string, name: string) => {
      setActivePath(path)
      if (tabsRef.current.some((tab) => tab.path === path)) return
      const tab = createExternalFileTab({
        path,
        name,
        workspaceId: activeTab?.workspaceId ?? '',
        rootPath: treeRoot ?? '',
      })
      setTabs((prev) => [...prev, tab])
      loadBuffer(tab)
    },
    [activeTab?.workspaceId, loadBuffer, treeRoot],
  )

  // Escape in the tree: the keyboard goes back to the file — Monaco when it is
  // showing, else the preview or image it is showing instead.
  const returnFocusToEditor = useCallback(() => {
    if (editorRef.current) {
      editorRef.current.focus()
      return
    }
    contentRef.current?.focus()
  }, [])

  const handleTreeResizePointerDown = useCallback(
    (event: React.PointerEvent<HTMLDivElement>) => {
      if (event.button !== 0) return
      const startX = event.clientX
      const startWidth = treeDragWidthRef.current ?? treePrefs.width
      treeDragWidthRef.current = startWidth
      setTreeResizing(true)
      // The column is left-docked, so dragging its right edge RIGHT widens it.
      startColumnResizeDrag(event, {
        onDrag: (clientX) => {
          const next = clampEditorTreeWidth(startWidth + (clientX - startX))
          treeDragWidthRef.current = next
          if (treeColumnRef.current) treeColumnRef.current.style.width = `${next}px`
        },
        onDragEnd: () => {
          setTreeResizing(false)
          const finalWidth = treeDragWidthRef.current
          treeDragWidthRef.current = null
          if (finalWidth !== null) updateTreePrefs({ ...treePrefs, width: finalWidth })
        },
      })
    },
    [treePrefs, updateTreePrefs],
  )

  const handleTreeResizeKeyDown = useCallback(
    (event: React.KeyboardEvent<HTMLDivElement>) => {
      const STEP = 16
      if (event.key === 'ArrowRight') {
        event.preventDefault()
        updateTreePrefs({ ...treePrefs, width: clampEditorTreeWidth(treePrefs.width + STEP) })
      } else if (event.key === 'ArrowLeft') {
        event.preventDefault()
        updateTreePrefs({ ...treePrefs, width: clampEditorTreeWidth(treePrefs.width - STEP) })
      } else if (event.key === 'Home') {
        event.preventDefault()
        updateTreePrefs({ ...treePrefs, width: EDITOR_TREE_DEFAULT_WIDTH })
      }
    },
    [treePrefs, updateTreePrefs],
  )
  const activeBuffer = activePath ? buffers[activePath] : undefined
  const activeTextBuffer = activeBuffer && !activeBuffer.loading && activeBuffer.kind === 'text' ? activeBuffer : null
  const isMarkdown = activeTab ? detectLanguage(activeTab.name) === 'markdown' : false
  const markdownPreviewTooLarge =
    isMarkdown && !!activeTextBuffer && activeTextBuffer.value.length > MARKDOWN_PREVIEW_MAX_CHARS
  const showPreview = isMarkdown && !!activeTextBuffer && markdownMode === 'preview' && !markdownPreviewTooLarge

  // Land on the rendered preview each time a markdown file becomes active, so
  // opening one shows the formatted document rather than the last source view.
  useEffect(() => {
    // A file an agent opened at lines lands in the source, where lines are.
    if (isMarkdown) {
      setMarkdownMode(activePath && peekEditorLanding(EXTERNAL_WINDOW_LANDING_SCOPE, activePath) ? 'source' : 'preview')
    }
  }, [activePath, isMarkdown])

  const closeTab = useCallback(
    (path: string) => {
      setTabs((prev) => {
        const next = prev.filter((tab) => tab.path !== path)
        if (next.length === 0) {
          void window.api.windowClose()
          return prev
        }
        setActivePath((current) => {
          if (current !== path) return current
          const closedIndex = prev.findIndex((tab) => tab.path === path)
          const neighbor = next[Math.min(closedIndex, next.length - 1)]
          return neighbor?.path ?? null
        })
        return next
      })
      setBuffers((prev) => {
        const next = { ...prev }
        delete next[path]
        return next
      })
      setDiskNotice(path, null)
    },
    [setDiskNotice],
  )

  const saveBuffer = useCallback(
    async (path: string): Promise<void> => {
      const buffer = buffersRef.current[path]
      if (!buffer || buffer.kind !== 'text' || buffer.loading || !isDirty(buffer)) return
      const value = buffer.value
      const previousSaved = buffer.saved
      // The baseline moves before the write, so the watch event the write itself
      // causes reads as this tab's own save and not as someone else's edit.
      setBuffers((prev) => {
        const current = prev[path]
        if (!current || current.kind !== 'text') return prev
        return { ...prev, [path]: { ...current, saved: value } }
      })
      try {
        await window.api.writefile(path, value)
        setDiskNotice(path, null)
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error)
        setBuffers((prev) => {
          const current = prev[path]
          if (!current || current.kind !== 'text') return prev
          return { ...prev, [path]: { ...current, saved: previousSaved, error: message } }
        })
      }
    },
    [setDiskNotice],
  )

  const saveActive = useCallback(() => {
    if (activePath) void saveBuffer(activePath)
  }, [activePath, saveBuffer])

  const dockActive = useCallback(async () => {
    if (!activeTab) return
    // Persist pending edits before docking so the workspace tab (which reloads
    // from disk) reflects them — docking moves the file, it does not discard work.
    await saveBuffer(activeTab.path)
    await window.api.dockFileToWorkspace({
      workspaceId: activeTab.workspaceId,
      path: activeTab.path,
      name: activeTab.name,
    })
    closeTab(activeTab.path)
  }, [activeTab, closeTab, saveBuffer])

  // The whole window, however many tabs it holds. Where Escape refuses outright
  // while anything is unsaved, a click on Close is a deliberate choice, so it
  // asks once — naming what would be lost — instead of doing nothing.
  const closeWindow = useCallback(async () => {
    const unsaved = tabsRef.current.filter((tab) => isDirty(buffersRef.current[tab.path]))
    if (unsaved.length > 0) {
      const confirmed = await confirmDialog({
        title: 'Close the editor window?',
        body:
          unsaved.length === 1
            ? `${unsaved[0].name} has unsaved changes. Closing the window discards them.`
            : `${unsaved.length} files have unsaved changes. Closing the window discards them.`,
        confirmLabel: 'Discard and close',
        tone: 'danger',
      })
      if (!confirmed) return
    }
    void window.api.windowClose()
  }, [confirmDialog])

  // Cmd/Ctrl+S saves the active file; Escape dismisses the window. Escape is
  // guarded by the same no-silent-discard rule the tab close affordance uses:
  // with unsaved edits in any tab it does nothing, so the file is saved or
  // docked first rather than lost to a single keypress.
  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if ((event.metaKey || event.ctrlKey) && isLetterKey(event, 's')) {
        event.preventDefault()
        saveActive()
        return
      }
      if (event.key === 'Escape') {
        // Inside the files column Escape means "back to the file", never
        // "close the window" — whichever of its controls has focus.
        if (event.target instanceof Element && event.target.closest('#editor-window-files')) return
        if (tabsRef.current.some((tab) => isDirty(buffersRef.current[tab.path]))) return
        event.preventDefault()
        void window.api.windowClose()
      }
    }
    window.addEventListener('keydown', onKeyDown)
    return () => window.removeEventListener('keydown', onKeyDown)
  }, [saveActive])

  return (
    <div className="flex h-screen w-screen flex-col bg-[color:var(--bg-app)] text-[color:var(--text-default)]">
      <div
        className={`app-drag flex ${TITLE_BAR_HEIGHT} shrink-0 items-center gap-1 border-b border-[color:var(--border-default)] bg-[color:var(--bg-surface)] ${
          // The close caption fills the right-hand corner on win/linux, so the
          // strip's own end padding would only push it off the edge.
          isMac ? `pr-2 ${TRAFFIC_LIGHT_INSET}` : 'pl-2'
        }`}
      >
        {/* The tree's switch sits first in the strip, over the column it
            opens — the same mark and the same place as the app sidebar's. */}
        <Tooltip content={treePrefs.visible ? 'Hide files' : 'Show files'} placement="bottom">
          <IconButton
            tone={treePrefs.visible ? 'strong' : 'subtle'}
            onClick={() => updateTreePrefs({ ...treePrefs, visible: !treePrefs.visible })}
            aria-label={treePrefs.visible ? 'Hide files' : 'Show files'}
            aria-pressed={treePrefs.visible}
            aria-controls={treePrefs.visible ? 'editor-window-files' : undefined}
            className="app-no-drag shrink-0"
          >
            <svg viewBox="0 0 16 16" fill="none" className="icon-sm" aria-hidden="true">
              <rect x="2.5" y="3" width="11" height="10" rx="1.5" stroke="currentColor" strokeWidth="1.5" />
              <path d="M6 3V13" stroke="currentColor" strokeWidth="1.5" />
            </svg>
          </IconButton>
        </Tooltip>
        <div className="flex min-w-0 flex-1 items-stretch gap-0.5 overflow-x-auto">
          {tabs.map((tab) => {
            const selected = tab.path === activePath
            return (
              <div
                key={tab.path}
                className={`app-no-drag group/tab flex h-[28px] min-w-0 shrink-0 items-center gap-1.5 self-center rounded-md px-2 text-meta transition-colors ${
                  selected
                    ? // The neutral selected fill, as every other selection: the
                      // raised surface it used was the strip's own ground in the
                      // light themes, so the active tab could not be told apart.
                      'bg-[color:var(--bg-selected)] text-[color:var(--text-strong)]'
                    : 'text-[color:var(--text-muted)] hover:bg-[color:var(--bg-hover)] hover:text-[color:var(--text-default)]'
                }`}
              >
                <Tooltip content={tab.path} placement="bottom" wrapperClassName="flex min-w-0">
                  {/* `flush`: the tab chip around it owns the fill and the radius,
                      and this is one of the two targets inside it. Its ring is
                      inset, which the scrolling strip needs — an outset one at
                      either end is clipped by the overflow container. */}
                  <RowButton density="flush" onClick={() => setActivePath(tab.path)} className="max-w-[200px]">
                    <span className="min-w-0 truncate">{tab.name}</span>
                  </RowButton>
                </Tooltip>
                <span
                  className={`inline-flex size-control-xs shrink-0 items-center justify-center ${
                    isDirty(buffers[tab.path])
                      ? ''
                      : // Revealed on hover AND on keyboard focus inside the tab
                        // (Tab → close button): hover-only is a bug, not a style.
                        'opacity-0 group-hover/tab:opacity-100 group-focus-within/tab:opacity-100'
                  }`}
                >
                  {isDirty(buffers[tab.path]) ? (
                    <span className="text-[color:var(--tone-warn)]" role="img" aria-label="Unsaved changes">
                      •
                    </span>
                  ) : (
                    <CloseIconButton onClick={() => closeTab(tab.path)} aria-label={`Close ${tab.name}`} />
                  )}
                </span>
              </div>
            )
          })}
        </div>
        <GhostButton
          size="xs"
          onClick={() => void dockActive()}
          disabled={!activeTab}
          aria-label="Dock current file back into the workspace"
          className="app-no-drag shrink-0"
        >
          <svg viewBox="0 0 16 16" fill="none" className="icon-sm" aria-hidden="true">
            <rect x="2.5" y="3" width="11" height="10" rx="1.5" stroke="currentColor" strokeWidth="1.4" />
            <path d="M6 3v10" stroke="currentColor" strokeWidth="1.4" />
          </svg>
          Dock into workspace
        </GhostButton>
        {/* The window is frameless on win/linux, so it draws its own way out;
            macOS keeps its native traffic lights on the left. */}
        {isMac ? null : (
          <div className="app-no-drag flex shrink-0 items-stretch self-stretch">
            <WindowCloseButton onClick={() => void closeWindow()} />
          </div>
        )}
      </div>

      <div className="flex min-h-0 flex-1">
        {treePrefs.visible ? (
          <aside
            ref={treeColumnRef}
            id="editor-window-files"
            aria-label="Files"
            onKeyDown={(event) => {
              if (event.key !== 'Escape' || event.defaultPrevented) return
              event.preventDefault()
              returnFocusToEditor()
            }}
            // Never more than half the window: the file is the point.
            className="relative flex max-w-[50%] shrink-0 flex-col border-r border-[color:var(--border-default)] bg-[color:var(--bg-surface)]"
            style={{ width: clampEditorTreeWidth(treeDragWidthRef.current ?? treePrefs.width) }}
          >
            <EditorFileTree
              rootPath={treeRoot}
              outsideLabel={activeTab?.rootPath ? 'Outside this workspace' : 'Outside this folder'}
              activePath={activePath}
              onOpenFile={openFromTree}
              onReturnFocus={returnFocusToEditor}
            />
            {/* Drag the right edge to resize — the side-pane's resizable
                variant, with the workspace columns' drag underneath. */}
            <div
              role="separator"
              aria-orientation="vertical"
              aria-label="Resize files"
              aria-valuemin={EDITOR_TREE_MIN_WIDTH}
              aria-valuemax={EDITOR_TREE_MAX_WIDTH}
              aria-valuenow={treePrefs.width}
              tabIndex={0}
              onPointerDown={handleTreeResizePointerDown}
              onKeyDown={handleTreeResizeKeyDown}
              onDoubleClick={() => updateTreePrefs({ ...treePrefs, width: EDITOR_TREE_DEFAULT_WIDTH })}
              className="group absolute right-0 top-0 z-[var(--z-pane)] h-full w-1.5 translate-x-1/2 cursor-col-resize focus-visible:focus-ring"
            >
              <span
                aria-hidden="true"
                className={`absolute inset-y-0 left-1/2 w-px -translate-x-1/2 bg-[color:var(--accent-primary)] transition-opacity ${
                  treeResizing ? 'opacity-100' : 'opacity-0 group-hover:opacity-60 group-focus-visible:opacity-100'
                }`}
              />
            </div>
          </aside>
        ) : null}
        <div className="flex min-h-0 min-w-0 flex-1 flex-col">
          {activePath && diskNotices[activePath] ? (
            <EditorDiskNotice
              notice={diskNotices[activePath]}
              onReload={() => {
                const path = activePath
                void readFileOnDisk(window.api, path).then((read) => {
                  if (read.kind === 'content') takeDiskContent(path, read.content)
                  else if (read.kind === 'missing') setDiskNotice(path, { kind: 'deleted' })
                })
              }}
              onKeepMine={() => {
                // What is on disk becomes the baseline: the notice goes, the
                // tab stays unsaved, and the next save overwrites on purpose.
                const notice = diskNotices[activePath]
                const path = activePath
                if (notice?.kind === 'changed') {
                  setBuffers((prev) => {
                    const current = prev[path]
                    if (!current || current.kind !== 'text') return prev
                    return { ...prev, [path]: { ...current, saved: notice.content } }
                  })
                }
                setDiskNotice(path, null)
              }}
            />
          ) : null}
          <div ref={contentRef} tabIndex={-1} className="relative min-h-0 min-w-0 flex-1 outline-none">
            {isMarkdown && activeTextBuffer ? (
              <div className="absolute right-3 top-3 z-10">
                <Tooltip
                  content={
                    markdownPreviewTooLarge
                      ? 'Markdown preview disabled for large files'
                      : showPreview
                        ? 'Edit Markdown source'
                        : 'Preview Markdown'
                  }
                  placement="bottom"
                >
                  <IconButton
                    aria-label={showPreview ? 'Edit Markdown source' : 'Preview Markdown'}
                    onClick={() => setMarkdownMode((mode) => (mode === 'preview' ? 'source' : 'preview'))}
                    disabled={markdownPreviewTooLarge}
                    className="border border-[color:var(--border-default)] bg-[color:var(--bg-surface-raised)]"
                  >
                    {showPreview ? (
                      <svg viewBox="0 0 16 16" className="icon-sm" fill="none" aria-hidden="true">
                        <path
                          d="M2.5 11.75L2.5 13.5h1.75L12 5.75 10.25 4 2.5 11.75z"
                          stroke="currentColor"
                          strokeWidth="1.4"
                          strokeLinejoin="round"
                        />
                        <path d="M9.25 5L11 6.75" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" />
                      </svg>
                    ) : (
                      <svg viewBox="0 0 16 16" className="icon-sm" fill="none" aria-hidden="true">
                        <path
                          d="M1.5 8s2.5-4 6.5-4 6.5 4 6.5 4-2.5 4-6.5 4S1.5 8 1.5 8z"
                          stroke="currentColor"
                          strokeWidth="1.4"
                          strokeLinejoin="round"
                        />
                        <circle cx="8" cy="8" r="1.75" stroke="currentColor" strokeWidth="1.4" />
                      </svg>
                    )}
                  </IconButton>
                </Tooltip>
              </div>
            ) : null}
            {renderBody(
              activeTab,
              activeBuffer,
              activePath,
              setBuffers,
              showPreview,
              monacoTheme,
              codeFontFamily,
              (editor) => {
                editorRef.current = editor
                editor.onDidDispose(() => {
                  if (editorRef.current === editor) editorRef.current = null
                })
                editor.onKeyDown(() => {
                  lastKeyAtRef.current = Date.now()
                })
                landActive()
              },
            )}
          </div>
        </div>
      </div>
    </div>
  )
}

function AuxLoadingState({ label }: { label: string }) {
  return (
    <div className="flex h-full items-center justify-center gap-2 text-body text-[color:var(--text-muted)]">
      <Spinner />
      {label}
    </div>
  )
}

function renderBody(
  activeTab: FileTab | null,
  buffer: FileBuffer | undefined,
  activePath: string | null,
  setBuffers: React.Dispatch<React.SetStateAction<Record<string, FileBuffer>>>,
  showPreview: boolean,
  monacoTheme: 'vs' | 'vs-dark',
  codeFontFamily: string,
  onEditorMount?: (editor: Monaco.editor.IStandaloneCodeEditor) => void,
): React.ReactNode {
  // Kit states, not the window's own dialect: the sentences a person
  // reads are `EmptyState` copy rather than `--text-disabled` mono, and a read
  // failure is the kit's notice.
  if (!activeTab || !activePath) {
    return <EmptyState title="No file open." />
  }
  if (!buffer || buffer.loading) {
    return <AuxLoadingState label="Loading…" />
  }
  if (buffer.error) {
    return (
      <div className="flex h-full items-center justify-center px-6">
        <InlineNotice tone="error" className="max-w-md">
          {buffer.error}
        </InlineNotice>
      </div>
    )
  }
  if (buffer.kind === 'image') {
    if (!buffer.dataUrl) {
      return <AuxLoadingState label="Loading image…" />
    }
    return (
      <div className="flex h-full flex-col bg-[color:var(--bg-app)]">
        <div className="flex min-h-0 flex-1 items-center justify-center overflow-auto p-6">
          <img
            src={buffer.dataUrl}
            alt={activeTab.name}
            className="max-h-full max-w-full object-contain"
            draggable={false}
          />
        </div>
      </div>
    )
  }
  if (showPreview) {
    return (
      <div className="h-full overflow-y-auto bg-[color:var(--bg-app)] px-8 pb-8 pt-8 [scrollbar-gutter:stable]">
        <div className="mx-auto max-w-4xl">{renderMarkdown(buffer.value)}</div>
      </div>
    )
  }
  return (
    <MonacoEditor
      key={activePath}
      height="100%"
      beforeMount={configureMonacoLanguages}
      theme={monacoTheme}
      language={detectLanguage(activeTab.name)}
      value={buffer.value}
      // A window opened moments ago may have measured a fallback face; see
      // `remeasureWhenMonoFontLoads` for why the caret drifts until it does.
      onMount={(editor, monaco) => {
        remeasureMonacoFontsOnLoad(editor, monaco)
        onEditorMount?.(editor)
      }}
      options={{
        fontSize: 13,
        fontFamily: codeFontFamily,
        minimap: { enabled: false },
        scrollBeyondLastLine: false,
        automaticLayout: true,
        tabSize: 2,
      }}
      onChange={(value) => {
        if (value === undefined) return
        setBuffers((prev) => {
          const current = prev[activePath]
          if (!current || current.kind !== 'text') return prev
          return { ...prev, [activePath]: { ...current, value } }
        })
      }}
    />
  )
}
