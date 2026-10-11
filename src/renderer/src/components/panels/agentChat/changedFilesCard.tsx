import { useEffect, useId, useMemo, useRef, useState, type KeyboardEvent } from 'react'
import type { ConversationCheckpointFile, ConversationTurnDiffResult } from '../../../../../shared/conversation-runtime'
import {
  CollapseAllGlyph,
  ExpandAllGlyph,
  GhostButton,
  IconButton,
  InlineNotice,
  OpenInEditorGlyph,
  ShowDiffGlyph,
  Spinner,
  Tooltip,
} from '../../ui'
import { FileTreeRow } from '../../ui/FileTree'
import { useConfirmDialog } from '../../ui/ConfirmDialog'
import { InlineDiff } from '../../ui/InlineDiff'
import { deriveEditHunks } from '../../../../../shared/conversation/editHunks'
import { showToast } from '../../../store/toastStore'
import { useConversationLinkContext, type ConversationLinkContext } from './conversationLinks'
import { setConversationDisclosures, useConversationDisclosure } from './conversationViewState'
import { joinTreePath } from '../../../utils/fileTreeEntries'
import { openFileSurface } from '../../../utils/openFileSurface'
import { openGitDiff } from '../../../utils/openGitDiff'
import type { ChatFileSource } from './chatServices'
import { useConversationTransport } from './conversationTransport'
import { formatDiffCount } from '../../../utils/diffCount'

export type TurnChangeSummary = { files: number; addedLines: number; removedLines: number }
export function hasTurnChanges(available: boolean | undefined, summary: TurnChangeSummary | undefined): boolean {
  return available === true && Boolean(summary && summary.files > 0)
}

type RevertTurnActionProps = {
  turnSeq: number
  running: boolean
  reverted?: boolean
  // Undoing this revert would replace changes made after it.
  overwritesLaterWork?: boolean
  className?: string
}

export function RevertTurnAction(props: RevertTurnActionProps) {
  // Reverting rewrites the files of the machine the checkpoint is on; a
  // transport for a conversation on another machine does not offer it.
  return useConversationTransport().capabilities.checkpointRevert ? <RevertTurnButton {...props} /> : null
}

function RevertTurnButton({
  turnSeq,
  running,
  reverted = false,
  overwritesLaterWork = false,
  className,
}: RevertTurnActionProps) {
  const context = useConversationLinkContext()
  const transport = useConversationTransport()
  const dialog = useConfirmDialog()
  const [pending, setPending] = useState(false)
  async function revert() {
    const revertTurn = transport.revert
    if (!context?.agentId || running || pending || !revertTurn) return
    setPending(true)
    const key = { workspaceRoot: context.workspaceRoot, workspaceId: context.workspaceId, agentId: context.agentId }
    try {
      let preview = await revertTurn({ key, turnSeq, undo: reverted })
      let drift: string | undefined
      // The runtime acts only on the exact paths the dialog showed. When the
      // files moved while it was open, show the new list and ask again.
      for (;;) {
        if (!preview.ok) throw new Error(preview.message)
        const shown = preview.files
        const replacesLaterWork = reverted && overwritesLaterWork
        const accepted = await dialog.confirm({
          title: replacesLaterWork
            ? 'Undo this revert and replace later changes?'
            : reverted
              ? 'Undo this revert?'
              : 'Revert to before this turn?',
          tone: 'danger',
          confirmLabel: replacesLaterWork ? 'Replace later changes' : reverted ? 'Undo revert' : 'Revert files',
          body: (
            <>
              {drift ? <p>{drift}</p> : null}
              {/* An older revert is offered again once a newer one is undone,
                  and turns may have run since: its undo puts back files from
                  before all of that, so it says so rather than reading as the
                  harmless undo of a moment ago. */}
              {replacesLaterWork ? (
                <p>
                  Files have changed since this revert, in later turns or another revert. Undoing it puts back the files
                  as they were before it, replacing those later changes in the files below.
                </p>
              ) : null}
              <p>
                The following files will be restored. Your staged changes are left as they are. Your conversation stays
                in history. A recovery checkpoint is kept before reverting.
              </p>
              <ul className="max-h-60 overflow-auto">
                {shown.map((file) => (
                  <li key={file.path}>
                    {file.path} · +{formatDiffCount(file.addedLines)} −{formatDiffCount(file.removedLines)}
                  </li>
                ))}
              </ul>
            </>
          ),
        })
        if (!accepted) return
        const result = await revertTurn({
          key,
          turnSeq,
          undo: reverted,
          confirmed: true,
          files: shown.map((file) => file.path),
        })
        if (!result.ok && result.changed) {
          drift = result.message
          preview = await revertTurn({ key, turnSeq, undo: reverted })
          continue
        }
        if (!result.ok) throw new Error(result.message)
        showToast({
          tone: 'good',
          title: reverted ? 'Revert undone' : 'Files reverted. Undo revert can restore the previous state.',
        })
        // A new file git ignores most likely existed, ignored, before the turn,
        // so the runtime keeps it; say so rather than leave it unexplained.
        if (result.kept?.length)
          showToast({
            tone: 'warn',
            title: 'Some new files were left in place',
            description: `Git ignores them, so they may predate this turn: ${result.kept.join(', ')}`,
          })
        return
      }
    } catch (error) {
      showToast({
        tone: 'error',
        title: `Could not restore files: ${error instanceof Error ? error.message : String(error)}`,
      })
    } finally {
      setPending(false)
    }
  }
  return (
    <Tooltip
      content={
        running
          ? 'Stop the running turn before restoring files'
          : reverted
            ? 'Restore the recovery checkpoint'
            : 'Preview the files that will be restored'
      }
    >
      <span className={className}>
        <GhostButton size="inline" disabled={running || pending} onClick={() => void revert()}>
          {pending ? 'Preparing…' : reverted ? 'Undo revert' : 'Revert to before this turn'}
        </GhostButton>
      </span>
    </Tooltip>
  )
}

/** A folder's figures are the sum of every file under it, so a collapsed folder still says how much it holds. */
type ChangeNode = {
  path: string
  name: string
  children: ChangeNode[]
  file?: ConversationCheckpointFile
  addedLines: number
  removedLines: number
}
export function changeTree(files: ConversationCheckpointFile[]): ChangeNode[] {
  const roots: ChangeNode[] = []
  for (const file of files) {
    let level = roots
    let path = ''
    const names = file.path.split('/')
    for (const [index, name] of names.entries()) {
      path = path ? `${path}/${name}` : name
      let node = level.find((item) => item.path === path)
      if (!node) {
        node = { path, name, children: [], addedLines: 0, removedLines: 0 }
        level.push(node)
      }
      node.addedLines += file.addedLines
      node.removedLines += file.removedLines
      if (index === names.length - 1) node.file = file
      level = node.children
    }
  }
  // A folder whose only entry is another folder is one step of a path, not a
  // level anyone chose: `src/main/ipc` reads as one row rather than three
  // nested ones that each hold nothing but the next.
  const compact = (node: ChangeNode): ChangeNode => {
    let merged = node
    while (!merged.file && merged.children.length === 1 && !merged.children[0].file) {
      const only = merged.children[0]
      merged = { ...only, name: `${merged.name}/${only.name}` }
    }
    return { ...merged, children: merged.children.map(compact) }
  }
  const sort = (nodes: ChangeNode[]) => {
    nodes.sort((a, b) => Number(Boolean(a.file)) - Number(Boolean(b.file)) || a.name.localeCompare(b.name))
    for (const node of nodes) sort(node.children)
  }
  const compacted = roots.map(compact)
  sort(compacted)
  return compacted
}

/** Every folder's path, outermost first — what "expand all" has to open. */
export function changeTreeFolders(nodes: ChangeNode[]): string[] {
  return nodes.flatMap((node) => (node.file ? [] : [node.path, ...changeTreeFolders(node.children)]))
}

/** The first file in display order: where the turn's diff opens. */
function firstChangedFile(nodes: ChangeNode[]): ConversationCheckpointFile | undefined {
  for (const node of nodes) {
    const file = node.file ?? firstChangedFile(node.children)
    if (file) return file
  }
  return undefined
}

// Added and removed lines in the diff channel's own inks — the tokens the
// diff viewer's body and gutter read — so a count here and the lines it counts
// are one green and one red. A reverted turn's figures drop to the card's muted
// ink with the rest of it: they describe changes no longer on disk.
function DiffStat({
  addedLines,
  removedLines,
  muted = false,
}: {
  addedLines: number
  removedLines: number
  muted?: boolean
}) {
  return (
    <span className="inline-flex shrink-0 gap-1 font-mono tabular-nums" aria-hidden="true">
      <span className={muted ? '' : 'text-[color:var(--sem-color-diff-added)]'}>+{formatDiffCount(addedLines)}</span>
      <span className={muted ? '' : 'text-[color:var(--sem-color-diff-removed)]'}>
        −{formatDiffCount(removedLines)}
      </span>
    </span>
  )
}

function ChangeTreeNode({
  node,
  depth,
  parent,
  conversationKey,
  turnSeq,
  selected,
  select,
  prefix,
  muted,
  openDiff,
  openFile,
}: {
  node: ChangeNode
  depth: number
  parent: string
  conversationKey: string
  turnSeq: number
  selected: string
  select: (path: string, file?: ConversationCheckpointFile) => void
  prefix: string
  muted: boolean
  openDiff?: (path: string) => void
  openFile?: (path: string) => void
}) {
  const [open, setOpen] = useConversationDisclosure(conversationKey, `files:${turnSeq}:${node.path}`, true)
  const file = node.file
  // The row's actions wait for a pointer or the keyboard's cursor: on every row
  // at rest they would be a column of identical marks beside the figures the
  // card is there to show.
  const reveal =
    selected === node.path
      ? ''
      : 'opacity-0 group-hover:opacity-100 group-focus-within:opacity-100 focus-visible:opacity-100'
  return (
    <>
      <FileTreeRow
        id={`${prefix}-${encodeURIComponent(node.path)}`}
        data-change-path={node.path}
        data-change-parent={parent}
        name={node.name}
        isDir={!file}
        depth={depth}
        indentSteps={0}
        expanded={open}
        selection={selected === node.path ? 'cursor' : null}
        onToggleExpanded={() => setOpen(!open)}
        onClick={() => {
          select(node.path, file)
          if (!file) setOpen(!open)
        }}
        // A file opens where every other diff in the app does: the diff
        // viewer, with the turn's files down its side.
        onDoubleClick={file && openDiff && !file.binary ? () => openDiff(node.path) : undefined}
        // The name slot carries the figures and actions too: the kit's badge is
        // a display-only status letter, and these need two inks and buttons.
        nameSlot={
          <span className="flex min-w-0 flex-1 items-center gap-2">
            <span className={`truncate ${file ? '' : 'font-medium'}`}>{node.name}</span>
            <span className="ml-auto flex shrink-0 items-center gap-2 text-micro">
              {file ? (
                <span className="font-mono font-semibold opacity-80" aria-hidden="true">
                  {file.status[0].toUpperCase()}
                </span>
              ) : null}
              <DiffStat addedLines={node.addedLines} removedLines={node.removedLines} muted={muted} />
              {file && openDiff && !file.binary ? (
                <Tooltip content="Open in diff viewer">
                  <IconButton
                    size="3xs"
                    tone="ink"
                    tabIndex={-1}
                    className={reveal}
                    aria-label={`Open ${node.path} in diff viewer`}
                    onClick={(event) => {
                      event.stopPropagation()
                      openDiff(node.path)
                    }}
                  >
                    <ShowDiffGlyph className="icon-xs" />
                  </IconButton>
                </Tooltip>
              ) : null}
              {file && openFile && file.status !== 'deleted' ? (
                <Tooltip content="Open file">
                  <IconButton
                    size="3xs"
                    tone="ink"
                    tabIndex={-1}
                    className={reveal}
                    aria-label={`Open ${node.path}`}
                    onClick={(event) => {
                      event.stopPropagation()
                      openFile(node.path)
                    }}
                  >
                    <OpenInEditorGlyph className="icon-xs" />
                  </IconButton>
                </Tooltip>
              ) : null}
            </span>
          </span>
        }
        aria-label={
          file
            ? `${node.path}, ${file.status}, ${file.addedLines} added, ${file.removedLines} removed`
            : `${node.path}, ${node.addedLines} added, ${node.removedLines} removed`
        }
      />
      {!file && open ? (
        <div role="group">
          {node.children.map((child) => (
            <ChangeTreeNode
              key={child.path}
              node={child}
              depth={depth + 1}
              parent={node.path}
              conversationKey={conversationKey}
              turnSeq={turnSeq}
              selected={selected}
              select={select}
              prefix={prefix}
              muted={muted}
              openDiff={openDiff}
              openFile={openFile}
            />
          ))}
        </div>
      ) : null}
    </>
  )
}

/** Up to this many files, a turn's card opens on its tree rather than on its summary line. */
const GLANCEABLE_CHANGED_FILES = 8

/**
 * Where a checkpoint path is on disk. Checkpoint paths are relative to the
 * repository's top level, which is the workspace root only for a workspace
 * opened on its repository; one opened on a folder inside it would put every
 * path under that folder a second time. A workspace git cannot answer for
 * falls back to its own root.
 */
export async function changedFileLocation(
  workspaceRoot: string,
  path: string,
  repoRoot: (folder: string) => Promise<string | null>,
): Promise<string> {
  const root = await repoRoot(workspaceRoot).catch(() => null)
  return joinTreePath(root || workspaceRoot, path)
}

// A path that is not a file any more — deleted or moved since the turn — says
// so rather than opening an empty tab.
async function openChangedFile(files: ChatFileSource, context: ConversationLinkContext, path: string) {
  try {
    const resolved = await changedFileLocation(context.workspaceRoot, path, (folder) => files.repoRoot(folder))
    if (!(await files.stat(resolved)).isFile) throw new Error('not a file')
    openFileSurface({
      workspaceId: context.workspaceId,
      path: resolved,
      name: path.split('/').at(-1) ?? path,
      rootPath: context.cwd,
    })
  } catch {
    showToast({ tone: 'error', title: `File not found: ${path}` })
  }
}

// Each open is a new narrowing, so the viewer narrows again to this turn's
// files even when the person pressed "Show all" on the last one.
let turnDiffReveals = 0

/**
 * A turn's changes in the app's diff viewer — the pane or the window, as the
 * person has chosen for every diff — narrowed to the files the turn touched
 * and landed on `focus`. The viewer reads the working tree, so each file reads
 * as it stands now against what is committed — including anything a later turn
 * or the person did to it since — rather than as this one turn's before/after.
 */
async function openTurnInDiffViewer(
  files: ChatFileSource,
  context: Pick<ConversationLinkContext, 'workspaceId' | 'workspaceRoot'>,
  turnSeq: number,
  paths: readonly string[],
  focus: string,
): Promise<void> {
  try {
    const repoRoot = (await files.repoRoot(context.workspaceRoot).catch(() => null)) || context.workspaceRoot
    openGitDiff({
      workspaceId: context.workspaceId,
      repoRoot,
      focusPath: joinTreePath(repoRoot, focus),
      scope: 'unstaged',
      reveal: { key: `turn-changes:${turnSeq}:${++turnDiffReveals}`, paths: [...paths] },
    })
  } catch (failure) {
    showToast({
      tone: 'error',
      title: `Could not open the diff: ${failure instanceof Error ? failure.message : String(failure)}`,
    })
  }
}

export function ChangedFilesCard({
  turnSeq,
  summary,
  running,
  reverted = false,
  undoTurnSeq,
  undoOverwritesLaterWork,
}: {
  turnSeq: number
  summary: TurnChangeSummary
  running: boolean
  reverted?: boolean
  undoTurnSeq?: number
  undoOverwritesLaterWork?: boolean
}) {
  const context = useConversationLinkContext()
  const transport = useConversationTransport()
  const conversationKey = `${context?.workspaceId ?? ''}:${context?.agentId ?? ''}`
  // A handful of files is shown as it stands, so the turn's footprint reads at
  // a glance; past that the card starts as its one-line summary.
  const [open, setOpen] = useConversationDisclosure(
    conversationKey,
    `files:${turnSeq}`,
    summary.files <= GLANCEABLE_CHANGED_FILES,
  )
  const [foldersOpen, setFoldersOpen] = useConversationDisclosure(conversationKey, `files-all:${turnSeq}`, true)
  const [files, setFiles] = useState<ConversationCheckpointFile[]>()
  const [selected, setSelected] = useState('')
  const [detail, setDetail] = useState<Extract<ConversationTurnDiffResult, { ok: true }>>()
  const [error, setError] = useState<string>()
  const [loading, setLoading] = useState(false)
  const [retry, setRetry] = useState(0)
  const tree = useRef<HTMLDivElement>(null)
  const request = useRef(0)
  const prefix = useId()
  const nodes = useMemo(() => changeTree(files ?? []), [files])
  const folders = useMemo(() => changeTreeFolders(nodes), [nodes])
  const key = context?.agentId
    ? { workspaceRoot: context.workspaceRoot, workspaceId: context.workspaceId, agentId: context.agentId }
    : undefined
  // Both open this machine's files, so a conversation on another one offers neither.
  const localKey = transport.capabilities.localFiles ? key : undefined
  // Opens in the app's diff viewer, which reads this machine's working tree —
  // so, like the file itself, only for a conversation on this machine. One on
  // another machine keeps the inline preview below instead.
  const openDiff =
    localKey && context
      ? (path: string, list = files) =>
          void openTurnInDiffViewer(
            transport.services.files,
            context,
            turnSeq,
            (list ?? []).map((file) => file.path),
            path,
          )
      : undefined
  const openFile =
    localKey && context ? (path: string) => void openChangedFile(transport.services.files, context, path) : undefined
  async function openTurnDiff() {
    if (!localKey) return
    try {
      let list = files
      if (!list) {
        const result = await transport.turnDiff({ key: localKey, turnSeq })
        if (!result.ok) throw new Error(result.message)
        list = result.diff.files
        setFiles(list)
      }
      const first = firstChangedFile(changeTree(list.filter((file) => !file.binary)))
      if (first) openDiff?.(first.path, list)
      else showToast({ tone: 'warn', title: 'This turn changed only binary files; there is no text diff to show' })
    } catch (failure) {
      showToast({
        tone: 'error',
        title: `Could not open the diff: ${failure instanceof Error ? failure.message : String(failure)}`,
      })
    }
  }
  useEffect(() => {
    if (!open || !context?.agentId || files) return
    let cancelled = false
    setLoading(true)
    setError(undefined)
    void transport
      .turnDiff({
        key: { workspaceRoot: context.workspaceRoot, workspaceId: context.workspaceId, agentId: context.agentId },
        turnSeq,
      })
      .then((result) => {
        if (!cancelled) {
          if (result.ok) setFiles(result.diff.files)
          else setError(result.message)
        }
      })
      .catch((failure: unknown) => {
        if (!cancelled) setError(String(failure))
      })
      .finally(() => {
        if (!cancelled) setLoading(false)
      })
    return () => {
      cancelled = true
    }
  }, [open, context, files, turnSeq, retry, transport])
  async function select(path: string, file?: ConversationCheckpointFile) {
    setSelected(path)
    const generation = ++request.current
    setDetail(undefined)
    // Selecting is all a click does where the diff viewer can open the file;
    // the preview below is for a conversation on another machine only.
    if (!file || !context?.agentId || openDiff) return
    if (file.binary) {
      setLoading(false)
      setError(undefined)
      setDetail({ ok: true, diff: { files: [file], submodulesExcluded: true } })
      return
    }
    setLoading(true)
    setError(undefined)
    try {
      const result = await transport.turnDiff({
        key: { workspaceRoot: context.workspaceRoot, workspaceId: context.workspaceId, agentId: context.agentId },
        turnSeq,
        path,
      })
      if (generation !== request.current) return
      if (result.ok) setDetail(result)
      else setError(result.message)
    } catch (failure) {
      if (generation === request.current) setError(String(failure))
    } finally {
      if (generation === request.current) setLoading(false)
    }
  }
  function keyDown(event: KeyboardEvent<HTMLDivElement>) {
    const rows = Array.from(tree.current?.querySelectorAll<HTMLElement>('[data-change-path]') ?? [])
    const index = Math.max(
      0,
      rows.findIndex((row) => row.dataset.changePath === selected),
    )
    const current = rows[index]
    let next = index
    if (event.key === 'ArrowDown') next = Math.min(rows.length - 1, index + 1)
    else if (event.key === 'ArrowUp') next = Math.max(0, index - 1)
    else if (event.key === 'Home') next = 0
    else if (event.key === 'End') next = rows.length - 1
    else if (event.key === 'Enter' && current && openDiff && isOpenableFile(current.dataset.changePath)) {
      // Enter is the keyboard's double-click: it opens the file in the viewer.
      openDiff(current.dataset.changePath!)
    } else if (event.key === 'Enter' || event.key === ' ') current?.click()
    else if (event.key === 'ArrowRight') {
      if (current?.getAttribute('aria-expanded') === 'false') current.click()
      else if (current?.hasAttribute('aria-expanded')) next = Math.min(rows.length - 1, index + 1)
    } else if (event.key === 'ArrowLeft') {
      if (current?.getAttribute('aria-expanded') === 'true') current.click()
      else next = rows.findIndex((row) => row.dataset.changePath === current?.dataset.changeParent)
    } else return
    event.preventDefault()
    event.stopPropagation()
    if (rows[next] && (next !== index || !selected)) {
      setSelected(rows[next].dataset.changePath ?? '')
      rows[next].scrollIntoView?.({ block: 'nearest' })
    }
  }
  function isOpenableFile(path: string | undefined) {
    const file = files?.find((item) => item.path === path)
    return Boolean(file && !file.binary)
  }
  const edits = detail?.patch ? deriveEditHunks({ patch: detail.patch, path: selected }) : []
  return (
    <section
      className={`mt-3 ${reverted ? 'text-[color:var(--sem-color-text-muted)]' : ''}`}
      aria-label="Turn file changes"
    >
      <div className="flex items-center gap-1">
        <GhostButton
          size="inline"
          aria-expanded={open}
          aria-label={`${summary.files} ${summary.files === 1 ? 'file' : 'files'} changed, ${summary.addedLines} added, ${summary.removedLines} removed${reverted ? ', reverted' : ''}`}
          onClick={() => setOpen(!open)}
        >
          {summary.files} {summary.files === 1 ? 'file' : 'files'} changed ·{' '}
          <DiffStat addedLines={summary.addedLines} removedLines={summary.removedLines} muted={reverted} />
          {reverted ? ' · Reverted' : ''}
        </GhostButton>
        {open && folders.length ? (
          <Tooltip content={foldersOpen ? 'Collapse all folders' : 'Expand all folders'}>
            <IconButton
              size="xs"
              aria-label={foldersOpen ? 'Collapse all folders' : 'Expand all folders'}
              onClick={() => {
                setConversationDisclosures(
                  conversationKey,
                  folders.map((path) => `files:${turnSeq}:${path}`),
                  !foldersOpen,
                )
                setFoldersOpen(!foldersOpen)
              }}
            >
              {foldersOpen ? <CollapseAllGlyph /> : <ExpandAllGlyph />}
            </IconButton>
          </Tooltip>
        ) : null}
        {localKey ? (
          <Tooltip content="Open this turn's changes in the diff viewer">
            <IconButton size="xs" aria-label="Open diff" onClick={() => void openTurnDiff()}>
              <ShowDiffGlyph />
            </IconButton>
          </Tooltip>
        ) : null}
      </div>
      {open ? (
        <>
          <div
            ref={tree}
            role="tree"
            tabIndex={0}
            aria-label="Files changed by this turn"
            aria-activedescendant={selected ? `${prefix}-${encodeURIComponent(selected)}` : undefined}
            onKeyDown={keyDown}
          >
            {nodes.map((node) => (
              <ChangeTreeNode
                key={node.path}
                node={node}
                depth={0}
                parent=""
                conversationKey={conversationKey}
                turnSeq={turnSeq}
                selected={selected}
                select={(path, file) => void select(path, file)}
                prefix={prefix}
                muted={reverted}
                openDiff={openDiff}
                openFile={openFile}
              />
            ))}
          </div>
          {loading ? <Spinner label="Loading turn changes" /> : null}
          {error ? (
            <InlineNotice
              tone="error"
              action={
                <GhostButton
                  size="inline"
                  onClick={() => {
                    setRetry(retry + 1)
                    if (files)
                      void select(
                        selected,
                        files.find((file) => file.path === selected),
                      )
                  }}
                >
                  Retry
                </GhostButton>
              }
            >
              {error}
            </InlineNotice>
          ) : null}
          {edits.map((edit) => (
            <InlineDiff key={edit.path} edit={edit} />
          ))}
          {detail?.diff.files.find((file) => file.path === selected)?.binary ? (
            <p>Binary file changed; no text preview is available.</p>
          ) : null}
          {/* Only the most recent revert can be undone; an older one stays marked. */}
          {!reverted || undoTurnSeq !== undefined ? (
            <RevertTurnAction
              turnSeq={reverted ? (undoTurnSeq ?? turnSeq) : turnSeq}
              running={running}
              reverted={reverted}
              overwritesLaterWork={undoOverwritesLaterWork}
            />
          ) : null}
        </>
      ) : null}
    </section>
  )
}
