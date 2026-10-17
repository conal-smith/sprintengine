import React, { useEffect, useMemo, useRef, useState, useSyncExternalStore } from 'react'
import MonacoEditor, { OnMount } from '@monaco-editor/react'
import type * as Monaco from 'monaco-editor'
import { useWorkspaceStore } from '../../store/workspaceStore'
import { getGitEntry, useGitStatus } from '../../hooks/useGitStatus'
import { getGitLineChanges, type GitLineChange } from '../../utils/gitDiff'
import { renderMarkdown } from '../../utils/markdown'
import { isImageFile } from '../../utils/files'
import { basename, isPathOrChild, trimPath } from '../../utils/paths'
import { getEditorBuffer, hasEditorBuffer, setEditorBuffer, subscribeEditorBuffer } from '../../utils/editorBuffers'
import { removeFileTabsForPath } from '../../utils/modelRegistry'
import { EDITOR_FOCUS_EVENT } from '../../utils/editorFocus'
import {
  onEditorLandingQueued,
  peekEditorLanding,
  registerMountedEditor,
  revealEditorRange,
  takeEditorLanding,
} from '../../utils/agentEditorReveal'
import { remeasureMonacoFontsOnLoad, useCodeFontFamily } from '../../utils/fonts'
import { useMonacoBaseTheme } from '../../hooks/useAppTheme'
import { configureMonacoLanguages } from '../../utils/patchLanguage'
import { ContextMenu, EmptyState, IconButton, InlineNotice, MenuDivider, MenuItem, Spinner, Tooltip } from '../ui'

// The editor's three non-content states, each in its own kit idiom so a failed
// read never renders like an empty pane (principles.md → Accessibility;
// 2026-09-02 audit). They used to be five identical sentences in disabled ink,
// one of them red.
function EditorLoading({ label }: { label: string }) {
  return (
    <div className="flex h-full items-center justify-center gap-2 bg-[color:var(--bg-app)] text-meta text-[color:var(--text-muted)]">
      <Spinner />
      <span role="status">{label}</span>
    </div>
  )
}

function EditorEmpty({ title }: { title: string }) {
  return (
    <div className="h-full bg-[color:var(--bg-app)]">
      <EmptyState title={title} />
    </div>
  )
}

interface Props {
  workspaceId: string
  filePath?: string
}

type MonacoApi = Parameters<OnMount>[1]
const GIT_DECORATION_DEBOUNCE_MS = 200
const GIT_DECORATION_MAX_CHARS = 600_000
const GIT_DECORATION_MAX_LINES = 8_000
const MARKDOWN_PREVIEW_MAX_CHARS = 2 * 1024 * 1024

// What the editor's right-click menu needs to know, sampled at open time —
// selection and tab count can both change while the menu is up.
type EditorMenuState = { x: number; y: number; hasSelection: boolean; canCloseOtherEditorTabs: boolean }

// The chord Monaco already binds for its clipboard and select-all actions.
// Read per render, never once at module load: preload publishes `window.api`
// after this module is first evaluated.
function editorModifier(): string {
  return typeof window !== 'undefined' && window.api?.platform === 'darwin' ? '⌘' : 'Ctrl+'
}

function readCssVar(name: string): string {
  if (typeof document === 'undefined') return ''
  return getComputedStyle(document.documentElement).getPropertyValue(name).trim()
}

export default function EditorPanel({ workspaceId, filePath }: Props) {
  const monacoTheme = useMonacoBaseTheme()
  const codeFontFamily = useCodeFontFamily()
  const editorState = useWorkspaceStore((s) => s.workspaces.find((w) => w.id === workspaceId)?.editorState)
  const folderPath = useWorkspaceStore((s) => s.workspaces.find((w) => w.id === workspaceId)?.folderPath ?? null)
  const setActiveFile = useWorkspaceStore((s) => s.setActiveFile)
  const openFile = useWorkspaceStore((s) => s.openFile)
  const updateFileContent = useWorkspaceStore((s) => s.updateFileContent)
  const markFileClean = useWorkspaceStore((s) => s.markFileClean)
  const closeFile = useWorkspaceStore((s) => s.closeFile)
  const { repoRoot, status: gitStatus, refresh: refreshGitStatus } = useGitStatus(folderPath)

  const openFiles = editorState?.openFiles ?? []
  const activeFilePath = filePath ?? editorState?.activeFilePath ?? null
  const activeFile = openFiles.find((f) => f.path === activeFilePath)
  const isImage = Boolean(activeFilePath && activeFile && isImageFile(activeFile.path || activeFile.name))
  const activeFileHasRuntimeBuffer = activeFilePath ? hasEditorBuffer(workspaceId, activeFilePath) : false
  const activeFileContentReady =
    !activeFilePath || isImage || activeFileHasRuntimeBuffer || typeof activeFile?.content === 'string'
  const activeContent = useSyncExternalStore(
    (listener) => (activeFilePath ? subscribeEditorBuffer(workspaceId, activeFilePath, listener) : () => {}),
    () => (activeFilePath ? getEditorBuffer(workspaceId, activeFilePath, activeFile?.content ?? '') : ''),
    () => '',
  )
  const editorRef = useRef<Monaco.editor.IStandaloneCodeEditor | null>(null)
  const monacoRef = useRef<MonacoApi | null>(null)
  const gitDecorationsRef = useRef<Monaco.editor.IEditorDecorationsCollection | null>(null)
  const [gitBaseContent, setGitBaseContent] = useState<{ path: string; content: string } | null>(null)
  const [contentLoadError, setContentLoadError] = useState<{ path: string; message: string } | null>(null)
  const [imageDataUrl, setImageDataUrl] = useState<{ path: string; url: string } | null>(null)
  const [markdownMode, setMarkdownMode] = useState<'preview' | 'source'>('preview')
  const [restoringFilePath, setRestoringFilePath] = useState<string | null>(null)
  const [editorMenu, setEditorMenu] = useState<EditorMenuState | null>(null)
  // Bumped on every Monaco mount, so the landing effect below runs once the
  // editor it drives exists.
  const [editorMountTick, setEditorMountTick] = useState(0)
  const unregisterEditorRef = useRef<(() => void) | null>(null)
  const isMarkdown = activeFile?.language === 'markdown'
  const markdownPreviewTooLarge = isMarkdown && activeContent.length > MARKDOWN_PREVIEW_MAX_CHARS
  const showPreview = isMarkdown && markdownMode === 'preview' && !markdownPreviewTooLarge
  const canRestoreMissingActiveFile = Boolean(
    filePath && !activeFile && folderPath && isPathOrChild(filePath, trimPath(folderPath)),
  )
  const activeGitEntry = useMemo(() => getGitEntry(gitStatus, activeFilePath), [activeFilePath, gitStatus])
  const activeGitEntrySignature = activeGitEntry
    ? [
        activeGitEntry.path,
        activeGitEntry.status,
        activeGitEntry.staged ? '1' : '0',
        activeGitEntry.unstaged ? '1' : '0',
      ].join('\u001f')
    : ''
  const previewGitLineChanges = useMemo(() => {
    if (!showPreview || !activeFile || gitBaseContent?.path !== activeFile.path) return []

    const lineCount = Math.max(activeContent.split(/\r\n|\r|\n/).length, 1)
    const baseLineCount = gitBaseContent.content.split(/\r\n|\r|\n/).length
    const tooLargeForDetailedDiff =
      activeContent.length > GIT_DECORATION_MAX_CHARS ||
      gitBaseContent.content.length > GIT_DECORATION_MAX_CHARS ||
      lineCount > GIT_DECORATION_MAX_LINES ||
      baseLineCount > GIT_DECORATION_MAX_LINES

    return tooLargeForDetailedDiff ? [] : getGitLineChanges(gitBaseContent.content, activeContent)
  }, [activeContent, activeFile?.path, gitBaseContent, showPreview])
  // The same element while the text and its line changes are, so a re-render
  // for anything else (a git status refresh, a menu opening) does not parse
  // and lay out the whole document again.
  const markdownPreview = useMemo(
    () => (showPreview ? renderMarkdown(activeContent, { lineChanges: previewGitLineChanges }) : null),
    [activeContent, previewGitLineChanges, showPreview],
  )

  useEffect(() => {
    if (filePath) setActiveFile(workspaceId, filePath)
  }, [filePath, setActiveFile, workspaceId])

  useEffect(() => {
    if (!filePath || activeFile || !folderPath || !isPathOrChild(filePath, trimPath(folderPath))) {
      setRestoringFilePath((path) => (path === filePath ? null : path))
      return
    }

    let cancelled = false
    const name = basename(filePath)
    setRestoringFilePath(filePath)
    setContentLoadError(null)

    if (isImageFile(filePath || name)) {
      openFile(workspaceId, filePath, name, '')
      setRestoringFilePath((path) => (path === filePath ? null : path))
      return
    }

    const restoreOpenFile = async () => {
      try {
        const content = await window.api.readfile(filePath)
        if (cancelled) return
        openFile(workspaceId, filePath, name, content)
      } catch (error) {
        if (cancelled) return
        setContentLoadError({
          path: filePath,
          message: error instanceof Error ? error.message : String(error),
        })
      } finally {
        if (!cancelled) {
          setRestoringFilePath((path) => (path === filePath ? null : path))
        }
      }
    }

    void restoreOpenFile()

    return () => {
      cancelled = true
    }
  }, [activeFile, filePath, folderPath, openFile, workspaceId])

  useEffect(() => {
    if (activeFile?.language === 'markdown') {
      // A file an agent opened AT LINES lands in the source, where lines are;
      // the rendered preview has none to scroll to.
      setMarkdownMode(activeFilePath && peekEditorLanding(workspaceId, activeFilePath) ? 'source' : 'preview')
    }
  }, [activeFilePath, activeFile?.language, workspaceId])

  // Where an agent's reveal asked this file to land (agentEditorReveal). Taken
  // once the editor has the file: now, when the tab was already open, or on the
  // mount that follows the person switching to a tab that opened behind theirs.
  // It never takes focus — that is the rule for everything an agent opens —
  // and the highlight is the short "just changed" tint.
  useEffect(() => {
    if (showPreview || !activeFilePath || !activeFileContentReady) return
    let clearHighlight: (() => void) | null = null
    let waitForLayout: { dispose(): void } | null = null
    const land = (): void => {
      const editor = editorRef.current
      if (!editor || !editor.getModel()) return
      // A tab behind another is mounted at zero size: landing there would spend
      // the highlight where nobody can see it. Wait until it is laid out.
      if (editor.getLayoutInfo().height <= 0) {
        waitForLayout ??= editor.onDidLayoutChange((layout) => {
          if (layout.height <= 0) return
          waitForLayout?.dispose()
          waitForLayout = null
          land()
        })
        return
      }
      const landing = takeEditorLanding(workspaceId, activeFilePath)
      if (!landing) return
      window.requestAnimationFrame(() => {
        if (editorRef.current !== editor) return
        clearHighlight?.()
        clearHighlight = revealEditorRange(editor, landing.range, {
          highlight: landing.highlight,
          moveCaret: landing.takeFocus,
        })
        if (landing.takeFocus) editor.focus()
      })
    }
    land()
    const stop = onEditorLandingQueued(land)
    return () => {
      stop()
      waitForLayout?.dispose()
      clearHighlight?.()
    }
  }, [activeFileContentReady, activeFilePath, editorMountTick, showPreview, workspaceId])

  useEffect(
    () => () => {
      unregisterEditorRef.current?.()
      unregisterEditorRef.current = null
    },
    [],
  )

  const handleMount: OnMount = (editor, monaco) => {
    editorRef.current = editor
    monacoRef.current = monaco
    gitDecorationsRef.current = editor.createDecorationsCollection()
    // Known to the agent reveal: whether the person is typing here, and what
    // editor.state reports as visible.
    unregisterEditorRef.current?.()
    const mountedPath =
      filePath ?? useWorkspaceStore.getState().workspaces.find((w) => w.id === workspaceId)?.editorState?.activeFilePath
    unregisterEditorRef.current = mountedPath ? registerMountedEditor(workspaceId, mountedPath, editor) : null
    editor.onDidDispose(() => {
      unregisterEditorRef.current?.()
      unregisterEditorRef.current = null
    })
    setEditorMountTick((tick) => tick + 1)
    // An editor opened early in the window's life may have measured a fallback
    // face; see `remeasureWhenMonoFontLoads` for why the caret drifts until then.
    remeasureMonacoFontsOnLoad(editor, monaco)
    editor.addCommand(monaco.KeyMod.CtrlCmd | monaco.KeyCode.KeyS, async () => {
      const state = useWorkspaceStore.getState()
      const ws = state.workspaces.find((w) => w.id === workspaceId)
      const pathToSave = filePath ?? ws?.editorState?.activeFilePath
      const file = ws?.editorState?.openFiles.find((f) => f.path === pathToSave)
      if (!file) return
      if (isImageFile(file.path || file.name)) return
      // A clean buffer is what was read off disk, and by now perhaps older than
      // what is there: an agent may have rewritten the file since. Writing it
      // back would put the old version over theirs, so ⌘S on it does nothing.
      if (!file.isDirty) return
      if (!hasEditorBuffer(workspaceId, file.path) && typeof file.content !== 'string') return
      await window.api.writefile(file.path, getEditorBuffer(workspaceId, file.path, file.content ?? ''))
      markFileClean(workspaceId, file.path)
      void refreshGitStatus()
    })
  }

  useEffect(() => {
    if (!activeFilePath || !activeFile) {
      setContentLoadError(null)
      return
    }
    if (activeFileContentReady) {
      setContentLoadError((error) => (error?.path === activeFilePath ? null : error))
      return
    }

    let cancelled = false
    setContentLoadError(null)

    const loadRestoredContent = async () => {
      try {
        const content = await window.api.readfile(activeFilePath)
        if (cancelled || hasEditorBuffer(workspaceId, activeFilePath)) return
        setEditorBuffer(workspaceId, activeFilePath, content)
      } catch (error) {
        if (cancelled) return
        setContentLoadError({
          path: activeFilePath,
          message: error instanceof Error ? error.message : String(error),
        })
      }
    }

    void loadRestoredContent()

    return () => {
      cancelled = true
    }
  }, [activeFile, activeFileContentReady, activeFilePath, workspaceId])

  useEffect(() => {
    if (!isImage || !activeFilePath) {
      setImageDataUrl(null)
      return
    }

    let cancelled = false
    setContentLoadError(null)
    setImageDataUrl((current) => (current?.path === activeFilePath ? current : null))

    const loadImage = async () => {
      try {
        const url = await window.api.readImageDataUrl(activeFilePath)
        if (!cancelled) setImageDataUrl({ path: activeFilePath, url })
      } catch (error) {
        if (cancelled) return
        setContentLoadError({
          path: activeFilePath,
          message: error instanceof Error ? error.message : String(error),
        })
      }
    }

    void loadImage()

    return () => {
      cancelled = true
    }
  }, [activeFilePath, isImage])

  useEffect(() => {
    if (showPreview) return

    const handleFocusRequest = (event: Event) => {
      const detail = (
        event as CustomEvent<{
          workspaceId?: string
          filePath?: string
          line?: number
          column?: number
        }>
      ).detail
      if (detail?.workspaceId !== workspaceId) return
      if (detail.filePath && detail.filePath !== activeFilePath) return

      window.requestAnimationFrame(() => {
        const editor = editorRef.current
        if (!editor) return
        if (detail.line && Number.isSafeInteger(detail.line) && detail.line > 0) {
          editor.setPosition({
            lineNumber: detail.line,
            column: detail.column && Number.isSafeInteger(detail.column) && detail.column > 0 ? detail.column : 1,
          })
          editor.revealLineInCenter(detail.line)
        }
        editor.focus()
      })
    }

    window.addEventListener(EDITOR_FOCUS_EVENT, handleFocusRequest)
    return () => window.removeEventListener(EDITOR_FOCUS_EVENT, handleFocusRequest)
  }, [activeFilePath, showPreview, workspaceId])

  // Monaco's own menu is off (`contextmenu: false`); this is the replacement.
  // It was a native Electron popup until the context-menu sweep — OS-drawn, Title-Cased, and
  // unable to carry the shortcut hints Monaco actually binds.
  const openEditorContextMenu = (event: React.MouseEvent<HTMLDivElement>) => {
    if (showPreview || !editorRef.current) return

    event.preventDefault()
    const selection = editorRef.current.getSelection()
    setEditorMenu({
      x: event.clientX,
      y: event.clientY,
      hasSelection: Boolean(selection && !selection.isEmpty()),
      canCloseOtherEditorTabs: Boolean(activeFilePath && openFiles.some((file) => file.path !== activeFilePath)),
    })
  }

  // The clipboard actions run through Monaco's hidden textarea, so the editor
  // has to hold focus when they fire. Closing the menu hands focus back on
  // unmount, which happens after this handler returns — hence the deferral:
  // focus and trigger land once React has finished putting focus back.
  const runEditorAction = (action: string) => {
    setEditorMenu(null)
    window.setTimeout(() => {
      const editor = editorRef.current
      if (!editor) return
      editor.focus()
      editor.trigger('context-menu', action, null)
    }, 0)
  }

  // Paste cannot go through Monaco's `clipboardPasteAction` like cut and copy
  // do. Those two run `document.execCommand` over a selection the renderer
  // already owns; paste asks for content the page has no permission to read, so
  // Chromium refuses a programmatic one and the action silently no-ops. (It did
  // under the native menu too — the row has never worked, verified by cutting
  // the buffer and pasting it back.) ⌘V still works because a real key press
  // hands Monaco a
  // genuine paste event the OS filled in.
  //
  // So this reads the clipboard through the app's own IPC — the same route
  // `clipboardPasteBridge` uses for plain inputs, which skips Monaco precisely
  // because Monaco owns the keyboard path — and applies it as an edit. Empty
  // clipboard is a no-op, never an edit that clears the selection.
  //
  // Deferred like `runEditorAction` and for the same reason: the menu hands
  // focus back on unmount, after this handler returns. Not left to the IPC
  // round trip to provide that ordering — the focus is what makes the edit land
  // in the editor, and it should not depend on how slow a clipboard read is.
  const pasteFromClipboard = () => {
    setEditorMenu(null)
    window.setTimeout(() => {
      void (async () => {
        const text = await window.api.clipboardReadText()
        const editor = editorRef.current
        if (!editor || !text) return
        const selection = editor.getSelection()
        if (!selection) return
        editor.focus()
        editor.pushUndoStop()
        editor.executeEdits('context-menu', [{ range: selection, text, forceMoveMarkers: true }])
        editor.pushUndoStop()
      })()
    }, 0)
  }

  const closeOtherEditorTabs = () => {
    setEditorMenu(null)
    if (!activeFilePath) return
    openFiles
      .filter((file) => file.path !== activeFilePath)
      .forEach((file) => {
        closeFile(workspaceId, file.path)
        removeFileTabsForPath(workspaceId, file.path)
      })
  }

  useEffect(() => {
    let cancelled = false

    if (!activeFilePath || !repoRoot) {
      setGitBaseContent(null)
      return
    }

    const loadBaseContent = async () => {
      if (activeGitEntry?.status === 'new') {
        setGitBaseContent({ path: activeFilePath, content: '' })
        return
      }

      if (typeof window.api.getGitFileBase !== 'function') {
        setGitBaseContent(null)
        return
      }

      const result = await window.api.getGitFileBase(repoRoot, activeFilePath)
      if (cancelled) return

      setGitBaseContent(result.ok ? { path: activeFilePath, content: result.content } : null)
    }

    void loadBaseContent()

    return () => {
      cancelled = true
    }
  }, [activeFilePath, activeGitEntry?.status, activeGitEntrySignature, repoRoot])

  useEffect(() => {
    const editor = editorRef.current
    const monaco = monacoRef.current
    const decorations = gitDecorationsRef.current
    const model = editor?.getModel()

    if (
      !editor ||
      !monaco ||
      !decorations ||
      !model ||
      !activeFile ||
      gitBaseContent?.path !== activeFile.path ||
      showPreview
    ) {
      decorations?.clear()
      return
    }

    const lineCount = Math.max(model.getLineCount(), 1)
    const tooLargeForDetailedDiff =
      activeContent.length > GIT_DECORATION_MAX_CHARS ||
      gitBaseContent.content.length > GIT_DECORATION_MAX_CHARS ||
      lineCount > GIT_DECORATION_MAX_LINES

    if (tooLargeForDetailedDiff) {
      decorations.clear()
      return
    }

    const baseLineCount = gitBaseContent.content.split(/\r\n|\r|\n/).length
    if (baseLineCount > GIT_DECORATION_MAX_LINES) {
      decorations.clear()
      return
    }

    const toDecoration = (change: GitLineChange): Monaco.editor.IModelDeltaDecoration => {
      const startLine = Math.min(Math.max(change.startLine, 1), lineCount)
      const endLine = Math.min(Math.max(change.endLine, startLine), lineCount)
      const className =
        change.kind === 'added'
          ? 'git-change-gutter git-change-added'
          : change.kind === 'modified'
            ? 'git-change-gutter git-change-modified'
            : 'git-change-gutter git-change-deleted'
      const color =
        change.kind === 'added'
          ? readCssVar('--tone-good')
          : change.kind === 'modified'
            ? readCssVar('--tone-warn')
            : readCssVar('--tone-error')
      const label =
        change.kind === 'added'
          ? 'Added lines'
          : change.kind === 'modified'
            ? 'Modified lines'
            : `${change.deletedCount ?? 1} deleted line${change.deletedCount === 1 ? '' : 's'}`

      return {
        range: new monaco.Range(startLine, 1, endLine, 1),
        options: {
          isWholeLine: true,
          glyphMarginClassName: className,
          glyphMarginHoverMessage: { value: label },
          overviewRuler: {
            color,
            position: monaco.editor.OverviewRulerLane.Left,
          },
          zIndex: 20,
        },
      }
    }

    const timer = window.setTimeout(() => {
      decorations.set(getGitLineChanges(gitBaseContent.content, activeContent).map(toDecoration))
    }, GIT_DECORATION_DEBOUNCE_MS)

    return () => window.clearTimeout(timer)
  }, [activeContent, activeFile?.path, gitBaseContent, showPreview])

  if (!filePath) {
    return <EditorEmpty title="Open a file from the Files pane" />
  }

  if (contentLoadError?.path === activeFilePath) {
    return (
      <div className="flex h-full items-center justify-center bg-[color:var(--bg-app)] px-4">
        <InlineNotice
          tone="error"
          title="Couldn't load this file."
          hint={<span className="break-all font-mono">{activeFilePath}</span>}
          detail={contentLoadError.message}
          className="w-full max-w-[46rem]"
        />
      </div>
    )
  }

  if (restoringFilePath === activeFilePath || canRestoreMissingActiveFile) {
    return <EditorLoading label="Loading file…" />
  }

  if (!activeFile) {
    return <EditorEmpty title="This file is no longer open." />
  }

  if (!activeFileContentReady) {
    return <EditorLoading label="Loading file…" />
  }

  const markdownModeToggle = isMarkdown ? (
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
        {/* Borderless, like every other IconButton. The override this carried —
            a border plus a raised ground — is the bordered icon button the kit
            retired by name ("do not reintroduce it", ui/Buttons.tsx): it adds a
            second radius to a view that already spends two, and it competes
            with the surface it floats over instead of sitting on it. The
            primitive's own hover fill is what makes it findable. */}
        <IconButton
          aria-label={showPreview ? 'Edit Markdown source' : 'Preview Markdown'}
          onClick={() => setMarkdownMode((mode) => (mode === 'preview' ? 'source' : 'preview'))}
          disabled={markdownPreviewTooLarge}
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
  ) : null

  if (isImage && activeFilePath) {
    if (!imageDataUrl || imageDataUrl.path !== activeFilePath) {
      return <EditorLoading label="Loading image…" />
    }

    return (
      <div className="flex h-full flex-col bg-[color:var(--bg-app)]">
        <div className="flex min-h-0 flex-1 items-center justify-center overflow-auto p-6">
          <img
            src={imageDataUrl.url}
            alt={activeFile.name}
            className="max-h-full max-w-full object-contain"
            draggable={false}
          />
        </div>
      </div>
    )
  }

  return (
    <div className="flex flex-col h-full bg-[color:var(--bg-app)]">
      <div className="relative flex-1 overflow-hidden">
        {markdownModeToggle}
        {showPreview ? (
          <div className="h-full overflow-y-auto bg-[color:var(--bg-app)] px-8 pb-8 pt-8 [scrollbar-gutter:stable]">
            {/* The mode toggle floats over this same `relative` box at `top-3`
                and is a `size-control-xs` (26px) IconButton, so it occupies
                y 12 → 38 — past the 32px `pt-8` inset the prose starts at. The
                clearance used to be `pt-14`, but 56px is not a step on the
                space scale and no step above 32px is; so the rest of it is
                reserved structurally instead, by a spacer exactly one control
                tall. It reads from the same token the button's height does,
                which is what keeps the two in step if the control ramp moves. */}
            <div aria-hidden="true" className="h-control-xs" />
            <div className="max-w-4xl mx-auto">{markdownPreview}</div>
          </div>
        ) : (
          <div className="h-full" onContextMenu={openEditorContextMenu}>
            <MonacoEditor
              height="100%"
              beforeMount={configureMonacoLanguages}
              language={activeFile.language}
              value={activeContent}
              theme={monacoTheme}
              options={{
                fontSize: 13,
                fontFamily: codeFontFamily,
                minimap: { enabled: false },
                scrollBeyondLastLine: false,
                renderLineHighlight: 'gutter',
                glyphMargin: true,
                lineNumbers: 'on',
                wordWrap: 'off',
                tabSize: 2,
                automaticLayout: true,
                contextmenu: false,
                padding: { top: isMarkdown ? 44 : 12 },
              }}
              onChange={(value) => {
                if (value !== undefined && activeFilePath) {
                  setEditorBuffer(workspaceId, activeFilePath, value)
                  if (!activeFile.isDirty) updateFileContent(workspaceId, activeFilePath, value)
                }
              }}
              onMount={handleMount}
            />
          </div>
        )}
      </div>
      {editorMenu ? (
        <ContextMenu
          x={editorMenu.x}
          y={editorMenu.y}
          ariaLabel={`Editor actions for ${activeFile.name}`}
          onClose={() => setEditorMenu(null)}
          surfaceClassName="min-w-[196px]"
        >
          <MenuItem
            disabled={!editorMenu.hasSelection}
            shortcut={`${editorModifier()}X`}
            onClick={() => runEditorAction('editor.action.clipboardCutAction')}
          >
            Cut
          </MenuItem>
          <MenuItem
            disabled={!editorMenu.hasSelection}
            shortcut={`${editorModifier()}C`}
            onClick={() => runEditorAction('editor.action.clipboardCopyAction')}
          >
            Copy
          </MenuItem>
          <MenuItem shortcut={`${editorModifier()}V`} onClick={pasteFromClipboard}>
            Paste
          </MenuItem>
          <MenuDivider />
          <MenuItem shortcut={`${editorModifier()}A`} onClick={() => runEditorAction('editor.action.selectAll')}>
            Select all
          </MenuItem>
          <MenuDivider />
          <MenuItem disabled={!editorMenu.canCloseOtherEditorTabs} onClick={closeOtherEditorTabs}>
            Close other editor tabs
          </MenuItem>
        </ContextMenu>
      ) : null}
    </div>
  )
}
