import React, { memo, useEffect, useMemo, useRef, useState } from 'react'
import type { ConversationToolDetail, ConversationJsonValue } from '../../../../../../shared/conversation-runtime'
import { presentToolItem, type ToolPresentation } from '../../../../../../shared/conversation/presentation'
import { labelCommand } from '../../../../../../shared/conversation/commandLabel'
import { parseAnsi, type AnsiLine } from '../../../../../../shared/conversation/ansi'
import { Checkbox, CopyGlyphButton, GhostButton, InlineNotice, MediaButton, RowButton, Spinner } from '../../../ui'
import { CodeBlock } from '../../../ui/CodeBlock'
import {
  cachedCodeLines,
  IncrementalCodeTokenizer,
  loadCodeLanguage,
  normalizeCodeLanguage,
  type CodeLine,
} from '../../../../lib/highlight/codeHighlight'
import { ConversationFileLink, conversationText, useConversationLinkContext } from '../conversationLinks'
import { useConversationDisclosure } from '../conversationViewState'
import type { TranscriptToolEntry } from '../conversationProjection'
import { AnsiOutput } from '../AnsiOutput'
import { deriveEditHunks } from '../../../../../../shared/conversation/editHunks'
import { InlineDiff } from '../../../ui/InlineDiff'
import { openCheckpointDiffWindow } from '../../../auxWindows/openCheckpointDiffWindow'
import { useLiveRowMotion } from '../liveVisibility'
import { formatMessageTime, LiveElapsed } from '../liveElapsed'
import { useClockFormat } from '../../../../utils/clockFormat'
import { formatStepDuration } from '../stepDuration'
import { useConversationTransport } from '../conversationTransport'
import { isPreviewableImagePath, useToolImage } from '../useLocalImage'
import { treeRelativePath } from '../../../../utils/fileTreeEntries'
import { revealLabel } from '../../../../utils/revealLabel'
import { showToast } from '../../../../store/toastStore'
import { ChevronRightGlyph, ToolKindGlyph } from './ToolKindGlyph'
import { InlineMarkdown } from './InlineMarkdown'
import { useClientToolOrigin } from '../../../../studio/clientTools'
import type { ConversationEdit } from '../../../../../../shared/conversation/editHunks'
import { clientSupports, hostPlatform } from '../../../../clientCapabilities'
import {
  stepWentWrong,
  toolPresentationInput,
} from '../../../../../../../packages/conversation-timeline/src/stepOutcome'

// How a step reads, and whether it went wrong, are the timeline package's:
// the turn fold counts what went wrong without drawing a row.
export { stepWentWrong, toolPresentationInput }
function pretty(value: ConversationJsonValue | undefined): string {
  return typeof value === 'string' ? value : value == null ? '' : JSON.stringify(value, null, 2)
}
function object(value: ConversationJsonValue | undefined): Record<string, ConversationJsonValue> {
  return value && typeof value === 'object' && !Array.isArray(value) ? value : {}
}

// Where the step's own words sit when a row opens: one contained, height-capped
// panel, the same for every kind of step, so a command's output, a search's
// matches and a tool's reply all read as "what this step produced" and never as
// loose text spilling into the transcript around it. It scrolls inside itself
// rather than pushing the conversation down.
export function ToolPanel({
  copyText,
  copyHtml,
  mono = true,
  children,
}: {
  copyText?: string
  /** The rendered flavour, for a panel that holds prose (an agent's report);
   *  output and code copy as the text they are. */
  copyHtml?: () => string
  mono?: boolean
  children: React.ReactNode
}) {
  return (
    <div className="group/tool-panel relative rounded-sm border border-[color:var(--border-subtle)] bg-[color:var(--bg-surface-raised)]">
      {copyText ? (
        <div className="absolute right-1 top-1 opacity-0 group-hover/tool-panel:opacity-100 focus-within:opacity-100">
          <CopyGlyphButton text={copyText} html={copyHtml} label="Copy output" size="xs" />
        </div>
      ) : null}
      <div
        className={`max-h-72 overflow-auto px-3 py-2 text-meta leading-relaxed text-[color:var(--text-default)] ${
          mono ? 'whitespace-pre-wrap break-words font-mono' : ''
        }`}
      >
        {children}
      </div>
    </div>
  )
}

const SHELL = normalizeCodeLanguage('bash')!
// The highlighter's base ink. A token in it is plain shell text and takes the
// terminal's own foreground instead, so the uncoloured words of a command are
// the same ink as the output under them.
const SYNTAX_FOREGROUND = 'var(--sem-syntax-foreground)'

// The command, coloured as the shell reads it — the program, its flags, the
// quoted strings, the pipes and redirections each in their syntax ink — so a
// long pipeline can be read at a glance. Plain text until the grammar has
// loaded, and plain text if it never does: the words are the same either way.
export function HighlightedCommand({ command }: { command: string }) {
  const [highlighted, setHighlighted] = useState<{ command: string; lines: CodeLine[] } | null>(() => {
    const lines = cachedCodeLines(SHELL, command)
    return lines ? { command, lines } : null
  })
  useEffect(() => {
    if (!command) return
    const cached = cachedCodeLines(SHELL, command)
    if (cached) {
      setHighlighted({ command, lines: cached })
      return
    }
    let cancelled = false
    loadCodeLanguage(SHELL)
      .then((engine) => {
        if (!cancelled)
          setHighlighted({ command, lines: new IncrementalCodeTokenizer(engine, SHELL).update(command, true) })
      })
      .catch(() => {})
    return () => {
      cancelled = true
    }
  }, [command])
  if (highlighted?.command !== command) return <>{command}</>
  return (
    <>
      {highlighted.lines.map((line, lineIndex) => (
        <React.Fragment key={lineIndex}>
          {line.tokens.map((token, tokenIndex) => (
            <span
              key={tokenIndex}
              style={token.color && token.color !== SYNTAX_FOREGROUND ? { color: token.color } : undefined}
            >
              {token.content}
            </span>
          ))}
          {lineIndex < highlighted.lines.length - 1 ? '\n' : null}
        </React.Fragment>
      ))}
    </>
  )
}

// A command and what it printed, on the terminal's own ground: it is terminal
// output, colours and all, and it reads as that rather than as more prose. The
// command heads the panel and the output scrolls under it, so a long log never
// scrolls the command out of sight; each has its own copy, because the one
// wanted again is usually the command and the one pasted into a bug is the
// output. The exit status sits on the header line in words the eye can skip —
// quiet at 0, the error tone otherwise.
function CommandPanel({
  command,
  output,
  lines,
  exitCode,
}: {
  command: string
  output: string
  lines: AnsiLine[]
  exitCode?: number
}) {
  return (
    <div className="group/tool-panel rounded-sm border border-[color:var(--border-subtle)] bg-[color:var(--terminal-bg)] font-mono text-meta leading-relaxed text-[color:var(--terminal-fg)]">
      <div className="flex items-start gap-2 py-1 pl-3 pr-1">
        <span aria-hidden="true" className="select-none py-0.5 text-[color:var(--text-subtle)]">
          $
        </span>
        <span className="min-w-0 flex-1 whitespace-pre-wrap break-words py-0.5">
          <HighlightedCommand command={command} />
        </span>
        {exitCode !== undefined ? (
          // Held in a line of the command's own height, so the small status
          // sits on the command's baseline rather than floating above it.
          <span className="shrink-0 whitespace-nowrap py-0.5">
            <span
              data-exit-tone={exitCode ? 'error' : 'ok'}
              className={`font-sans text-micro tabular-nums ${
                exitCode ? 'text-[color:var(--tone-error)]' : 'text-[color:var(--text-subtle)]'
              }`}
            >
              exit {exitCode}
            </span>
          </span>
        ) : null}
        {command ? (
          <CopyGlyphButton
            text={command}
            label="Copy command"
            size="xs"
            className="opacity-0 group-hover/tool-panel:opacity-100 focus-within:opacity-100"
          />
        ) : null}
      </div>
      {output ? (
        <div className="group/tool-output relative border-t border-[color:var(--border-subtle)]">
          <div className="absolute right-1 top-1 opacity-0 group-hover/tool-output:opacity-100 focus-within:opacity-100">
            <CopyGlyphButton text={output} label="Copy output" size="xs" />
          </div>
          <div className="max-h-72 overflow-auto px-3 py-2">
            <AnsiOutput lines={lines} />
          </div>
        </div>
      ) : null}
    </div>
  )
}

export { isPreviewableImagePath }

// A read is shown as a picture only when what the agent read was pixels. An SVG
// is markup the agent read as text, and that text is what it went on.
export function previewsAsImage(path: string): boolean {
  return isPreviewableImagePath(path) && !/\.svg$/iu.test(path.trim())
}

export function ToolBody({ tool, detail }: { tool: TranscriptToolEntry; detail?: ConversationToolDetail }) {
  const input = object(detail?.input ?? tool.input)
  const output = pretty(detail?.output ?? tool.output)
  const presentation = presentToolItem(toolPresentationInput(tool))
  const kind = presentation.icon
  // Parsing megabytes of fetched output on every render (each streamed token
  // re-renders the turn) stalls the chat; it only changes with the output.
  const ansi = useMemo(() => (kind === 'command' ? parseAnsi(output) : null), [kind, output])
  const path = String(input.path ?? input.file_path ?? '')
  const status = detail?.status ?? tool.outputStatus
  if (status === 'declined' || status === 'stopped')
    return (
      <p className="text-[color:var(--text-muted)]">
        {status === 'declined' ? 'Tool request declined' : 'Tool stopped'}
      </p>
    )
  if (kind === 'command') {
    const command = String(input.command ?? input.cmd ?? tool.summary ?? '')
    const exitCode = detail?.exitCode ?? tool.exitCode
    return <CommandPanel command={command} output={output} lines={ansi ?? []} exitCode={exitCode} />
  }
  if (tool.name === 'GenerateImage' && status !== 'error') {
    const prompt = String(input.prompt ?? '')
    if (!path) return <p className="text-[color:var(--text-muted)]">Codex did not return a picture to show.</p>
    return (
      <>
        {prompt ? <p className="text-[color:var(--text-muted)]">{prompt}</p> : null}
        <ImagePreview path={path} toolUseId={tool.id} />
      </>
    )
  }
  if (kind === 'file_read') {
    // A read that failed says why; there is no file behind it to show.
    if (status === 'error')
      return <ToolPanel copyText={output || undefined}>{output || 'The file could not be read.'}</ToolPanel>
    return previewsAsImage(path) ? (
      <ImagePreview path={path} toolUseId={tool.id} />
    ) : (
      <ReadOutput output={output} path={path} />
    )
  }
  if (kind === 'file_edit' || kind === 'file_write')
    return <EditBody input={detail?.input ?? tool.input} toolUseId={tool.id} subject={path} />
  if (kind === 'todo') {
    const todos = Array.isArray(input.todos) ? input.todos : []
    return (
      <ToolPanel mono={false}>
        {/* The plan as a list the reply's own lists would draw: a box per
            item on the text's first line, done items struck through and
            dimmed so what is left stands out. The boxes are read-only; the
            agent owns the plan. */}
        <ul className="flex flex-col gap-1.5">
          {todos.map((value, index) => {
            const todo = object(value)
            const text = String(todo.content ?? todo.description ?? '')
            const done = todo.status === 'completed'
            const active = todo.status === 'in_progress'
            return (
              <li key={index} data-todo-status={String(todo.status ?? 'pending')} className="flex items-start gap-2">
                <span className="flex h-5 shrink-0 items-center">
                  <Checkbox readOnly checked={done} ariaLabel={text || 'Task'} />
                </span>
                <span
                  className={`min-w-0 leading-5 ${
                    done
                      ? 'text-[color:var(--text-subtle)] line-through'
                      : active
                        ? 'font-medium text-[color:var(--text-strong)]'
                        : 'text-[color:var(--text-default)]'
                  }`}
                >
                  <InlineMarkdown text={text} />
                  {active ? <span className="sr-only"> (in progress)</span> : null}
                </span>
              </li>
            )
          })}
        </ul>
      </ToolPanel>
    )
  }
  if (kind === 'search' || kind === 'list' || kind === 'web') {
    // The row's label already carries the query; the panel repeats it only when
    // the label had to shorten it.
    const query = String(input.query ?? input.pattern ?? input.url ?? input.path ?? '')
    return (
      <ToolPanel copyText={output || undefined}>
        {query && !presentation.title.includes(query) ? (
          <div className="mb-1.5 text-[color:var(--text-strong)]">{conversationText(query)}</div>
        ) : null}
        <div className="text-[color:var(--text-muted)]">{output ? <LinkedOutput output={output} /> : 'No results'}</div>
        <ToolImages images={tool.images} toolUseId={tool.id} />
      </ToolPanel>
    )
  }
  // A step called with nothing (a screenshot) prints no `{}` over its
  // pictures, and one whose only answer is pictures draws them alone.
  const pictures = Boolean(tool.images?.length)
  const called = pretty(detail?.input ?? tool.input)
  const request = pictures && called.trim() === '{}' ? '' : called
  if (pictures && !request && !output.trim()) return <ToolImages images={tool.images} toolUseId={tool.id} />
  return (
    <ToolPanel copyText={output || request || undefined}>
      {request ? <div className="text-[color:var(--text-subtle)]">{request}</div> : null}
      {output ? <div className={`text-[color:var(--text-default)] ${request ? 'mt-2' : ''}`}>{output}</div> : null}
      <ToolImages images={tool.images} toolUseId={tool.id} />
    </ToolPanel>
  )
}

// The pictures a step returned (a browser screenshot), kept on this desktop
// when the step ran (`images` on its output): shown, since a screenshot's
// size says nothing about what was on it. A chat followed from another
// device names files over there, which nothing serves by name, so it says
// how many there are instead.
function ToolImages({ images, toolUseId }: { images: readonly string[] | undefined; toolUseId: string }) {
  const transport = useConversationTransport()
  if (!images?.length) return null
  if (!transport.capabilities.localFiles)
    return (
      <p className="mt-2 text-[color:var(--text-muted)]">
        {images.length === 1 ? 'This step returned a picture' : `This step returned ${images.length} pictures`}, on the
        machine that ran it.
      </p>
    )
  return (
    <div data-tool-images="" className="mt-2 flex flex-col items-start gap-2">
      {images.map((path) => (
        <ImagePreview key={path} path={path} toolUseId={toolUseId} />
      ))}
    </div>
  )
}

// An image the agent looked at is shown, not described: the picture is what it
// read, and a path to a screenshot says nothing about what was on it. A remote
// conversation's path names a file over there, so its picture is asked of that
// machine by the step, where the machine serves pictures at all.
function ImagePreview({ path, toolUseId }: { path: string; toolUseId: string }) {
  const current = useToolImage(toolUseId, path)
  if (!current.resolved) return <p className="text-[color:var(--text-muted)]">This image is on another machine.</p>
  if (current.failed)
    // Screenshots in particular are often read from a temporary folder the
    // system empties minutes later, so a missing file is the expected case.
    return <p className="text-[color:var(--text-muted)]">This image is no longer available to preview.</p>
  if (!current.src) return <Spinner label="Loading image" />
  return (
    <img
      src={current.src}
      alt={path.split(/[\\/]/).at(-1) ?? path}
      className="block max-h-64 max-w-full rounded-sm border border-[color:var(--border-subtle)] object-contain"
    />
  )
}

// A picture the agent made is what the step was for, so it shows under its row
// without the row being opened, at a size that says what it is. A click hands
// it to the system's viewer, as an attached image is; where it was saved is a
// click away for keeping it. A picture that cannot be shown here draws nothing:
// the row, opened, says why. A picture made on a paired machine has no folder
// here to reveal.
function GeneratedImage({ path, prompt, toolUseId }: { path: string; prompt?: string; toolUseId: string }) {
  const current = useToolImage(toolUseId, path)
  if (!current.resolved || current.failed) return null
  if (!current.src) return <Spinner label="Loading image" />
  const src = current.src
  const [, mediaType = 'image/png', dataBase64 = ''] = /^data:([^;]+);base64,(.*)$/s.exec(src) ?? []
  const label = prompt || 'Generated image'
  return (
    <figure data-generated-image="" className="mb-1.5 ml-6 mt-1 flex flex-col items-start gap-1">
      <MediaButton
        aria-label={`Open ${label}`}
        className="max-w-full"
        onClick={() =>
          void window.api.openImageAttachment({ mediaType, dataBase64 }).catch((error: unknown) =>
            showToast({
              tone: 'error',
              title: 'Could not open that image',
              description: error instanceof Error ? error.message : String(error),
            }),
          )
        }
      >
        <img
          src={src}
          alt={label}
          className="block max-h-96 max-w-full rounded-sm border border-[color:var(--border-subtle)] object-contain"
        />
      </MediaButton>
      {prompt || !current.remote ? (
        <figcaption className="flex min-w-0 max-w-full items-center gap-2 text-meta text-[color:var(--text-subtle)]">
          {prompt ? (
            <span className="min-w-0 truncate" title={prompt}>
              {prompt}
            </span>
          ) : null}
          {current.remote || !clientSupports('reveal-in-folder') ? null : (
            <GhostButton size="inline" onClick={() => void window.api.showItemInFolder(path)}>
              {revealLabel(hostPlatform())}
            </GhostButton>
          )}
        </figcaption>
      ) : null}
    </figure>
  )
}

// Diff noise: git's "\\ No newline at end of file" marker says something about
// the file's last byte, not about the change, and in a three-line preview it
// reads as one more line of code. Dropped here, before the diff sees the hunk;
// the diff window still shows the whole patch.
export function withoutNoNewlineMarkers(edit: ConversationEdit): ConversationEdit {
  if (!edit.hunks.some((hunk) => hunk.lines.some((line) => line.startsWith('\\')))) return edit
  return {
    ...edit,
    hunks: edit.hunks.map((hunk) => ({ ...hunk, lines: hunk.lines.filter((line) => !line.startsWith('\\')) })),
  }
}

function EditBody({
  input,
  toolUseId,
  subject,
}: {
  input: ConversationJsonValue | undefined
  toolUseId: string
  // The file the row's header already names; its diff needs no second chip.
  subject: string
}) {
  const context = useConversationLinkContext()
  // The diff window reads this machine's checkpoints; a remote edit has none here.
  const openable = useConversationTransport().capabilities.localFiles
  const edits = useMemo(() => deriveEditHunks(input).map(withoutNoNewlineMarkers), [input])
  return (
    <>
      {edits.map((edit, index) => (
        <div key={index}>
          {edits.length > 1 || edit.path !== subject ? (
            <ConversationFileLink token={edit.path} source="inlineCode" variant="chip" />
          ) : null}
          <InlineDiff
            edit={edit}
            onOpen={
              context?.agentId && openable
                ? () =>
                    void openCheckpointDiffWindow({
                      key: {
                        workspaceId: context.workspaceId,
                        workspaceRoot: context.workspaceRoot,
                        agentId: context.agentId!,
                      },
                      toolUseId,
                      editIndex: index,
                      path: edit.path,
                    })
                : undefined
            }
          />
        </div>
      ))}
    </>
  )
}

// A read shows the file's text under the row that already names the file, so
// the block's header carries the language and the copy, not the path again. A
// long read folds the way any long block does, with the block's own control:
// the whole text stays in the block, so its copy glyph copies all of it. How
// much of the file there is to show is the row's business — the transcript
// keeps a preview, and "Show full output" fetches the rest.
function ReadOutput({ output, path }: { output: string; path: string }) {
  return <CodeBlock code={output} language={path.split('.').at(-1)} />
}

// How much of a search's or a fetch's output becomes links. Each link is a
// component that asks the disk whether its path is a file, so linking every
// word of a ten-thousand-line grep costs ten thousand lookups for rows nobody
// scrolls to. Only the first lines are linked, and only the words in them that
// look like a path or a web address; the rest is text, and all of it is still
// selectable and copyable.
const LINKED_OUTPUT_LINES = 200
const LINKABLE =
  /^[([{"'<]*(?:[a-z][a-z0-9+.-]*:\/\/|~?\.{0,2}\/|[A-Za-z]:[\\/]|[\w@.-]+[\\/]|[\w@-][\w@.-]*\.[A-Za-z][\w]{0,9}(?::\d+){0,2}[:.,;)\]}'">]*$)/u

// Where the linked lines end: just past the last one's newline.
function linkedHeadLength(output: string): number {
  let at = -1
  for (let line = 0; line < LINKED_OUTPUT_LINES; line++) {
    at = output.indexOf('\n', at + 1)
    if (at === -1) return output.length
  }
  return at + 1
}

export function LinkedOutput({ output }: { output: string }) {
  return useMemo(() => {
    const headLength = linkedHeadLength(output)
    const nodes: React.ReactNode[] = []
    let text = ''
    for (const token of output.slice(0, headLength).split(/(\s+)/u)) {
      if (!token) continue
      if (/\s/u.test(token[0]) || !LINKABLE.test(token)) {
        text += token
        continue
      }
      if (text) nodes.push(text)
      text = ''
      nodes.push(<React.Fragment key={nodes.length}>{conversationText(token)}</React.Fragment>)
    }
    text += output.slice(headLength)
    if (text) nodes.push(text)
    return <>{nodes}</>
  }, [output])
}

// Fetched full output, kept by call id: the virtualized timeline unmounts a row
// scrolled out of view, and scrolling back must not lose (or refetch) it. The
// cap is on size, not count: one detail can be megabytes, and twenty of those
// would pin a hundred of them in the renderer for the session.
const MAX_CACHED_DETAIL_BYTES = 16 * 1024 * 1024
const detailCache = new Map<string, { detail: ConversationToolDetail; bytes: number }>()
let cachedDetailBytes = 0
// What the detail holds in memory: its strings are UTF-16, two bytes a unit.
function detailBytes(detail: ConversationToolDetail): number {
  return (pretty(detail.output).length + pretty(detail.input).length) * 2
}
function cachedDetail(key: string): ConversationToolDetail | undefined {
  const entry = detailCache.get(key)
  if (entry) {
    detailCache.delete(key)
    detailCache.set(key, entry)
  }
  return entry?.detail
}
function forgetDetail(key: string): void {
  const entry = detailCache.get(key)
  if (!entry) return
  detailCache.delete(key)
  cachedDetailBytes -= entry.bytes
}
function cacheDetail(key: string, detail: ConversationToolDetail): void {
  forgetDetail(key)
  const bytes = detailBytes(detail)
  if (bytes > MAX_CACHED_DETAIL_BYTES) return
  detailCache.set(key, { detail, bytes })
  cachedDetailBytes += bytes
  while (cachedDetailBytes > MAX_CACHED_DETAIL_BYTES) forgetDetail(detailCache.keys().next().value!)
}

// The ink a step's glyph wears: accent and pulsing while it runs, error when it
// failed, and otherwise the quietest ink there is. Settled steps are the
// conversation's working-out, not what it says — a column of them should read
// as texture under the prose until one of them needs the eye.
export function toolGlyphInk(tone: ToolPresentation['tone'] | 'running'): string {
  if (tone === 'running') return 'text-[color:var(--tone-accent)] status-dot-pulse'
  if (tone === 'error') return 'text-[color:var(--tone-error)]'
  return 'text-[color:var(--text-disabled)] group-hover/tool-row:text-[color:var(--text-subtle)]'
}

// A settled step that went wrong: one that failed, or a command that exited
// non-zero. The row keeps a non-zero exit's glyph neutral — a search that
// matched nothing exits 1 — but its "exit N" and any closed summary over it
// still wear error ink, so a step that went wrong never folds away unseen.
// A path as the row shows it: relative to where the agent runs, or to the
// workspace, when it is inside either. An absolute path out of a temp folder is
// most of a row's width spent on directories nobody needs to read.
export function displayToolPath(path: string, context: { cwd?: string; workspaceRoot?: string } | null): string {
  for (const root of [context?.cwd, context?.workspaceRoot]) {
    const relative = root ? treeRelativePath(root, path) : null
    if (relative) return relative
  }
  return path
}

// A click anywhere on the row's ground opens it, not only on the label — the
// chevron sits at the far end. It is handed to the label's own button rather
// than toggling here, so the transcript's hold on a disclosure's position (which
// watches presses on `button[aria-expanded]`) covers the ground too and the row
// stays under the pointer while following the bottom. Clicks that land on a real
// control inside the row (the label's button, the file link) are that
// control's, and a click from a portalled menu, which React bubbles through the
// row without it being inside, is nobody's here.
export function forwardRowGroundClick(event: React.MouseEvent<HTMLElement>, button: HTMLButtonElement | null) {
  if (!(event.target instanceof Node) || !event.currentTarget.contains(event.target)) return
  if (event.target instanceof Element && event.target.closest('button, a')) return
  button?.click()
}

// The folder part of a file step's path, when the label already carries the
// file's name; the whole path when it does not (a label shortened past it).
// Empty for a file at the top of the workspace: its name is the whole of its
// relative path, and the label has already said it.
export function subjectFolder(path: string, title: string): string {
  const cut = Math.max(path.lastIndexOf('/'), path.lastIndexOf('\\'))
  const name = path.slice(cut + 1)
  if (!name || !title.endsWith(name)) return path
  if (cut === -1) return ''
  return cut === 0 ? path.slice(0, 1) : path.slice(0, cut)
}

// A command's label (`npm test`, `git status` …) is read out of the shell
// text by a tokenizer. The same command is labelled every time its row
// renders, and a transcript repeats commands, so the labels are kept.
const MAX_COMMAND_LABELS = 512
const commandLabels = new Map<string, string>()
export function cachedCommandLabel(command: string): string {
  const cached = commandLabels.get(command)
  if (cached !== undefined) {
    commandLabels.delete(command)
    commandLabels.set(command, cached)
    return cached
  }
  const label = labelCommand(command).label
  commandLabels.set(command, label)
  if (commandLabels.size > MAX_COMMAND_LABELS) commandLabels.delete(commandLabels.keys().next().value!)
  return label
}

function isEmptyValue(value: ConversationJsonValue | undefined): boolean {
  if (value == null) return true
  if (typeof value === 'string') return !value.trim()
  if (Array.isArray(value)) return value.length === 0
  if (typeof value === 'object') return Object.keys(value).length === 0
  return false
}

// Whether opening the row would show anything. A step that took no input,
// printed nothing and is not running has no panel to open — a chevron over it
// opens an empty box — so its row is a plain line: no disclosure, no chevron.
// Running and truncated steps can still fill in or fetch more, and a read or
// an edit always shows its file, so those keep theirs.
export function toolHasBody(tool: TranscriptToolEntry, kind: ToolPresentation['icon']): boolean {
  if (tool.status === 'running' || tool.truncated || tool.inputTruncated) return true
  if (tool.outputStatus === 'declined' || tool.outputStatus === 'stopped') return true
  if (kind === 'file_read' || kind === 'file_edit' || kind === 'file_write') return true
  if (tool.name === 'GenerateImage') return true
  // A step whose answer was only pictures (a screenshot) shows them.
  if (tool.images?.length) return true
  // A command with no input still prints the provider's one-line summary.
  if (kind === 'command' && tool.summary?.trim()) return true
  return !isEmptyValue(tool.input) || !isEmptyValue(tool.output)
}

// When a settled step happened, on the app's clock. Its own memoized
// component so a streamed token does not re-format it, while a change to the
// Clock setting (which it reads) does.
const SettledClock = memo(function SettledClock({ at }: { at: number }) {
  useClockFormat()
  return <>{formatMessageTime(at)}</>
})

// Memoized: a turn's steps sit under the reply streaming into it, and a step's
// entry keeps its identity until the step itself changes.
export const ToolRow = memo(function ToolRow({ tool }: { tool: TranscriptToolEntry }) {
  const context = useConversationLinkContext()
  const transport = useConversationTransport()
  const key = `${context?.workspaceId ?? ''}:${context?.agentId ?? ''}`
  const detailKey = `${transport.kind === 'remote' ? `remote:${transport.machineName}:` : ''}${key}:${tool.id}`
  const [open, setOpen] = useConversationDisclosure(key, `tool:${tool.id}`, false)
  const [detail, setDetail] = useState<ConversationToolDetail | undefined>(() => cachedDetail(detailKey))
  // Output fetched while the tool was still running is a snapshot of a moving
  // target: it is shown but never cached, and can be fetched again.
  const [partial, setPartial] = useState(false)
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string>()
  const presentation = useMemo(() => presentToolItem(toolPresentationInput(tool), cachedCommandLabel), [tool])
  // A tool an app gave agents says whose it is.
  const origin = useClientToolOrigin(tool.name)
  const running = tool.status === 'running'
  const expandable = toolHasBody(tool, presentation.icon)
  const tone = running ? 'running' : presentation.tone
  const settledAt = running ? undefined : (tool.completedAt ?? tool.startedAt)
  const durationMs =
    !running && tool.startedAt !== undefined && tool.completedAt !== undefined
      ? Math.max(0, tool.completedAt - tool.startedAt)
      : undefined
  // The subtitle is "exit N" exactly when the command exited non-zero.
  const exited = Boolean(tool.exitCode)
  const subject = presentation.subtitle && !exited ? presentation.subtitle : undefined
  // A file step's label already ends in the file's name, so the path beside it
  // gives only the folder the file is in: the name once, where it is once.
  const fileStep =
    presentation.icon === 'file_read' || presentation.icon === 'file_edit' || presentation.icon === 'file_write'
  const subjectLabel = subject ? displayToolPath(subject, context) : undefined
  const shownSubject = fileStep && subjectLabel ? subjectFolder(subjectLabel, presentation.title) : subjectLabel
  const rowRef = useRef<HTMLDivElement>(null)
  const buttonRef = useRef<HTMLButtonElement>(null)
  useLiveRowMotion(rowRef, running)
  const toolInput = object(tool.input)
  const generatedPath = typeof toolInput.path === 'string' ? toolInput.path : ''
  const generatedPrompt = typeof toolInput.prompt === 'string' ? toolInput.prompt : undefined
  async function fetchDetail() {
    if (!context?.agentId) {
      setError('Tool detail is unavailable for this conversation')
      return
    }
    const stillRunning = running
    setLoading(true)
    setError(undefined)
    try {
      const result = await transport.toolDetail({
        workspaceRoot: context.workspaceRoot,
        workspaceId: context.workspaceId,
        agentId: context.agentId,
        toolUseId: tool.id,
      })
      if (result.ok) {
        if (stillRunning) forgetDetail(detailKey)
        else cacheDetail(detailKey, result.detail)
        setPartial(stillRunning)
        setDetail(result.detail)
      } else setError(result.message)
    } catch (failure) {
      setError(failure instanceof Error ? failure.message : 'Could not load tool output')
    } finally {
      setLoading(false)
    }
  }
  const label = (
    <>
      <span data-tone={tone === 'error' ? 'error' : undefined} className={`flex shrink-0 ${toolGlyphInk(tone)}`}>
        <ToolKindGlyph kind={presentation.icon} />
      </span>
      <span
        className={`min-w-0 truncate ${running ? 'text-[color:var(--text-muted)]' : 'text-[color:var(--text-subtle)] group-hover/tool-row:text-[color:var(--text-muted)]'}`}
      >
        {presentation.title}
      </span>
      {origin ? <span className="shrink-0 text-micro text-[color:var(--text-disabled)]">from {origin}</span> : null}
      {running ? <span className="sr-only">running</span> : null}
      {tone === 'error' ? <span className="sr-only">failed</span> : null}
    </>
  )
  return (
    <div ref={rowRef} data-tool-kind={presentation.icon}>
      <div
        className={`group/tool-row flex min-w-0 items-center gap-1 rounded-sm pr-1.5 ${
          expandable ? 'cursor-pointer transition-colors hover:bg-[color:var(--bg-hover)]' : ''
        }`}
        onClick={expandable ? (event) => forwardRowGroundClick(event, buttonRef.current) : undefined}
      >
        {/* Sized to its label rather than stretched, so the path sits right
            beside what the step did instead of across the row from it. */}
        <div className="flex min-w-0 max-w-fit shrink">
          {expandable ? (
            <RowButton
              ref={buttonRef}
              density="flush"
              className="min-w-0 text-meta"
              aria-expanded={open}
              onClick={() => setOpen(!open)}
            >
              {label}
            </RowButton>
          ) : (
            // The flush row half's box and ink, with nothing to press.
            <span data-tool-label="" className="flex w-full min-w-0 items-center gap-2 px-2 py-1.5 text-left text-meta">
              {label}
            </span>
          )}
        </div>
        {exited ? (
          <span className="min-w-0 shrink-[2] truncate text-meta text-[color:var(--tone-error)]">
            {presentation.subtitle}
          </span>
        ) : subject && shownSubject ? (
          // The link is a button, which lays out as its own box: the ellipsis a
          // narrow pane needs has to be drawn by the button, not by this span.
          <span className="min-w-0 shrink-[2] truncate text-meta text-[color:var(--text-disabled)] group-hover/tool-row:text-[color:var(--text-subtle)] [&>button]:max-w-full [&>button]:truncate [&>button]:align-bottom">
            <ConversationFileLink token={subject} source="inlineCode" ink="quiet" label={shownSubject} />
          </span>
        ) : null}
        <span className="min-w-2 flex-1" />
        {running && tool.startedAt !== undefined ? (
          <span className="shrink-0 text-micro tabular-nums text-[color:var(--text-subtle)]">
            <LiveElapsed startedAt={tool.startedAt} />
          </span>
        ) : settledAt !== undefined ? (
          <span className="flex shrink-0 items-baseline gap-2 whitespace-nowrap text-micro tabular-nums text-[color:var(--text-subtle)]">
            {/* When it happened is there for the asking; how long it took is
                what a column of steps is scanned for, so it stays. */}
            <span className="opacity-0 group-hover/tool-row:opacity-100">
              <SettledClock at={settledAt} />
            </span>
            {durationMs !== undefined ? <span data-step-duration="">{formatStepDuration(durationMs)}</span> : null}
          </span>
        ) : null}
        {expandable ? (
          <ChevronRightGlyph
            className={`icon-xs shrink-0 text-[color:var(--text-disabled)] group-hover/tool-row:text-[color:var(--text-subtle)] motion-safe:transition-transform ${open ? 'rotate-90' : ''}`}
          />
        ) : null}
      </div>
      {!open && tool.name === 'GenerateImage' && tool.outputStatus !== 'error' && generatedPath ? (
        <GeneratedImage path={generatedPath} prompt={generatedPrompt} toolUseId={tool.id} />
      ) : null}
      {open && expandable ? (
        // What the step produced. A read's code block sits here as every other
        // step's panel does (index.css drops the margins it keeps in prose).
        <div
          data-tool-step-body=""
          className="mb-1.5 ml-6 mt-1 flex flex-col items-start gap-1.5 text-meta [&>*]:w-full"
        >
          <ToolBody tool={tool} detail={detail} />
          {detail?.clipped ? (
            <InlineNotice tone="warn">
              Output exceeded the stored detail limit; the beginning and end are shown.
            </InlineNotice>
          ) : null}
          {loading ? <Spinner label="Loading tool output" /> : null}
          {error ? (
            <InlineNotice
              tone="error"
              action={
                <GhostButton size="inline" onClick={() => void fetchDetail()}>
                  Retry
                </GhostButton>
              }
            >
              {error}
            </InlineNotice>
          ) : null}
          {!detail && !loading && (tool.truncated || tool.inputTruncated) ? (
            <GhostButton size="inline" onClick={() => void fetchDetail()}>
              Show full output
            </GhostButton>
          ) : null}
          {detail && partial && !loading ? (
            <GhostButton size="inline" onClick={() => void fetchDetail()}>
              {running ? 'Refresh output' : 'Show final output'}
            </GhostButton>
          ) : null}
        </div>
      ) : null}
    </div>
  )
})
