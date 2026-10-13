import React, { createContext, useContext, useEffect, useMemo, useRef, useState } from 'react'
import { classifyLinkToken, type LinkTokenContext } from '../../../../../shared/links/classifyLinkToken'
import { ChipButton, LinkButton, Tooltip } from '../../ui'
import { FileTypeGlyph } from '../../ui/FileTypeGlyph'
import { TerminalLinkMenu } from '../../terminal/TerminalLinkMenu'
import { openFileSurface } from '../../../utils/openFileSurface'
import { useWorkspaceStore } from '../../../store/workspaceStore'
import { availableFolderOpenTargets, resolveFolderOpenPrimary } from '../../workspace/openInEditorTargets'
import { resolveTerminalFileReferencePath } from '../../../utils/terminalFileLinks'
import { showToast } from '../../../store/toastStore'
import { StreamingMarkdown } from './StreamingMarkdown'
import { useReplyStreaming } from '../../../utils/replyStreaming'
import { ConversationCodeBlock, ConversationReplyCodeBlock } from './ConversationCodeBlock'
import { ConversationImage } from './ConversationImage'
import { renderMarkdown } from '../../../utils/markdown'
import { FOCUS_RING_CLASS } from '../../ui/tokens'
import { useConversationTransport } from './conversationTransport'
import { hostPlatform } from '../../../clientCapabilities'

export type ConversationLinkContext = { workspaceId: string; cwd: string; workspaceRoot: string; agentId?: string }
const LinkContext = createContext<ConversationLinkContext | null>(null)
export function ConversationLinkProvider({
  children,
  ...value
}: ConversationLinkContext & { children: React.ReactNode }) {
  const { workspaceId, cwd, workspaceRoot, agentId } = value
  const stable = useMemo(
    () => ({ workspaceId, cwd, workspaceRoot, agentId }),
    [workspaceId, cwd, workspaceRoot, agentId],
  )
  return <LinkContext.Provider value={stable}>{children}</LinkContext.Provider>
}
export function useConversationLinkContext() {
  return useContext(LinkContext)
}

// What each resolved path turned out to be on this disk, asked once per path:
// a transcript repeats the same few paths, and a row re-mounting under the
// virtual list must not re-ask. Bounded, least recently used out, since a
// window stays open for days of transcripts.
const MAX_PATH_KINDS = 2_000
const pathKinds = new Map<string, 'file' | 'other'>()
function knownPathKind(path: string): 'file' | 'other' | undefined {
  const kind = pathKinds.get(path)
  if (kind !== undefined) {
    pathKinds.delete(path)
    pathKinds.set(path, kind)
  }
  return kind
}
function rememberPathKind(path: string, kind: 'file' | 'other'): void {
  pathKinds.delete(path)
  pathKinds.set(path, kind)
  if (pathKinds.size > MAX_PATH_KINDS) pathKinds.delete(pathKinds.keys().next().value!)
}

// A path in prose or inline code is a link only when it is a FILE that exists
// here. Before the disk has answered, a path whose last segment has an
// extension reads as one (nearly always right, and it keeps the text from
// changing under the reader); one without — `/Users/dev/project` — reads as text,
// because it is far more often a folder. The answer then settles it either way.
function useExistingFile(resolved: string | null | undefined, path: string | null): boolean {
  const files = useConversationTransport().services.files
  const guess = (): boolean => {
    const known = resolved ? knownPathKind(resolved) : undefined
    if (known) return known === 'file'
    return /\.[A-Za-z0-9]+$/u.test((resolved ?? path ?? '').split(/[\\/]/).at(-1) ?? '')
  }
  const [isFile, setIsFile] = useState(guess)
  useEffect(() => {
    if (!resolved) return
    const known = knownPathKind(resolved)
    if (known) {
      setIsFile(known === 'file')
      return
    }
    if (!files.canStat) return
    let cancelled = false
    void files
      .stat(resolved)
      .then((stat) => (stat.isFile ? 'file' : 'other'))
      .catch(() => 'other' as const)
      .then((kind) => {
        rememberPathKind(resolved, kind)
        if (!cancelled) setIsFile(kind === 'file')
      })
    return () => {
      cancelled = true
    }
  }, [resolved, files])
  return isFile
}

export const ConversationFileLink = React.memo(function ConversationFileLink({
  token,
  source = 'text',
  label: givenLabel,
  variant = 'inline',
  ink = 'accent',
}: {
  token: string
  source?: LinkTokenContext['source']
  // What a markdown link says (`[the docs](…)`); shown in place of the target.
  label?: React.ReactNode
  /**
   * `inline` (the default) is a path inside prose or inline code: the text
   * itself, at the text's own size and line height — never a boxed chip
   * mid-sentence, never shortened. `chip` is a file standing as an object in
   * its own right: one the person attached to a message, or a tool row's
   * subject. Either is a link only when it names a file that exists here.
   */
  variant?: 'inline' | 'chip'
  /**
   * An inline link's ink. `accent` (the default) is a path inside prose, where
   * the colour is what makes it findable. `quiet` is a path beside a tool row's
   * label: it is metadata there, and an accent path on every row would out-shout
   * the rows themselves.
   */
  ink?: 'accent' | 'quiet'
}) {
  const context = useContext(LinkContext)
  const [menu, setMenu] = useState<{ x: number; y: number } | null>(null)
  // A path from a conversation on another machine names a file over there;
  // resolving it here could open a same-named local file.
  const transport = useConversationTransport()
  const localFiles = transport.capabilities.localFiles
  const target = classifyLinkToken(token, {
    source,
    cwd: context?.cwd,
    platform: hostPlatform() || 'darwin',
  })
  const resolved =
    target?.type === 'file'
      ? resolveTerminalFileReferencePath(target.path, {
          executionRoot: context?.cwd,
          workspaceRoot: context?.workspaceRoot,
        })
      : null
  const existingFile = useExistingFile(
    target?.type === 'file' && localFiles ? resolved : null,
    target?.type === 'file' ? target.path : null,
  )
  if (!target || (target.type === 'file' && !localFiles)) return <>{givenLabel ?? token}</>
  if (target.type === 'url') {
    const href = /^[a-z]+:/i.test(target.href) ? target.href : `https://${target.href}`
    return (
      <a
        href={href}
        target="_blank"
        rel="noreferrer"
        className={`underline text-[color:var(--sem-color-accent-primary)] ${FOCUS_RING_CLASS}`}
      >
        {givenLabel ?? token}
      </a>
    )
  }
  // A folder, or a path that is not on this disk, is text — in a sentence, and
  // as a tool row's subject alike. Only a file gets a link, and only a file
  // gets a file's glyph.
  if (!existingFile) return <>{givenLabel ?? token}</>
  const label = target.path.split(/[\\/]/).slice(-2).join('/') + (target.line ? `:${target.line}` : '')
  const report = (message: string) => showToast({ tone: 'error', title: message })
  async function open(external: boolean) {
    if (!context || !resolved || target?.type !== 'file') return
    try {
      const stat = await transport.services.files.stat(resolved)
      if (!stat.isFile) {
        rememberPathKind(resolved, 'other')
        report(`File not found: ${target.path}`)
        return
      }
      const name = resolved.split(/[\\/]/).at(-1) ?? resolved
      if (external) {
        const available = availableFolderOpenTargets(await window.api.listFolderOpenTargets()).filter(
          (id) => id !== 'finder',
        )
        const editor = resolveFolderOpenPrimary(
          available,
          useWorkspaceStore.getState().appSettings.lastFolderOpenTarget,
        )
        if (!editor) {
          report('No external editor is available')
          return
        }
        const result = await window.api.openFolderInTarget({ target: editor, path: resolved })
        if (!result.ok) report(result.message)
      } else
        openFileSurface({
          workspaceId: context.workspaceId,
          path: resolved,
          name,
          lineNumber: target.line,
          column: target.col,
          rootPath: context.cwd,
        })
    } catch {
      report(`File not found: ${target.path}`)
    }
  }
  const onContextMenu = (event: React.MouseEvent) => {
    event.preventDefault()
    setMenu({ x: event.clientX, y: event.clientY })
  }
  return (
    <>
      {variant === 'inline' ? (
        // The kit's inline link at the surrounding text's size: inside a
        // `<code>` it keeps the code's mono face and box, inside prose the
        // prose's, and it sits on the line's baseline without growing it.
        <LinkButton
          ink={ink}
          underline="hover"
          size="inherit"
          aria-label={`Open ${token}`}
          title={resolved ?? token}
          onClick={(event) => void open(event.metaKey || event.ctrlKey)}
          onContextMenu={onContextMenu}
        >
          {givenLabel ?? token}
        </LinkButton>
      ) : (
        <Tooltip content={token}>
          <ChipButton
            tone="neutral"
            variant="outline"
            aria-label={`Open ${token}`}
            onClick={(event) => void open(event.metaKey || event.ctrlKey)}
            onContextMenu={onContextMenu}
          >
            <FileTypeGlyph name={target.path} className="icon-xs" />
            <span>{givenLabel ?? label}</span>
          </ChipButton>
        </Tooltip>
      )}
      {menu && context && resolved ? (
        <TerminalLinkMenu
          workspaceId={context.workspaceId}
          target={{ kind: 'file', resolvedPath: resolved, isDirectory: false, workspaceRoot: context.workspaceRoot }}
          x={menu.x}
          y={menu.y}
          line={target.line}
          column={target.col}
          onClose={() => setMenu(null)}
          onError={report}
        />
      ) : null}
    </>
  )
})

export function splitProseLinkToken(token: string): { prefix: string; body: string; suffix: string } {
  const prefix = /^[([{"']*/u.exec(token)?.[0] ?? ''
  const start = prefix.length
  let end = token.length
  while (end > start) {
    const char = token[end - 1]
    if (/[.,;:!?"']/u.test(char)) {
      end--
      continue
    }
    const opener = char === ')' ? '(' : char === ']' ? '[' : char === '}' ? '{' : undefined
    if (!opener) break
    const body = token.slice(start, end)
    if (body.split(char).length <= body.split(opener).length) break
    end--
  }
  return { prefix, body: token.slice(start, end), suffix: token.slice(end) }
}

// A path with a space in it, written the two ways a shell would take it: in
// quotes (`'/var/folders/x/Screenshot 2026-09-27 at 22.41.31.png'`) or with its
// spaces escaped (`/Users/dev/My\ File.ts`). Splitting prose on whitespace cuts
// either into pieces that name nothing, so these are found first and kept whole.
// A quoted one starts like a path — `/`, `./`, `../`, `~/` or a drive — and its
// quotes stay outside the link, as text; an escaped one is POSIX only, where a
// backslash before a space is an escape and not a separator.
const SPACED_PATH =
  /(?<=^|[\s([{])(?:(['"])((?:~|\.{1,2})?\/(?:(?!\1)[^\n])*|[A-Za-z]:\\(?:(?!\1)[^\n])*)\1(?=$|[\s)\]},.;:!?])|(?:~|\.{1,2})?\/(?:\\ |\S)*\\ (?:\\ |\S)*)/gu

function unescapeSpaces(path: string): string {
  return path.replace(/\\ /gu, ' ')
}

/** The path a whole inline-code span names when it is one quoted or escaped path. */
function spacedPathIn(text: string): string | null {
  const match = new RegExp(`^${SPACED_PATH.source}$`, 'u').exec(text)
  if (!match) return null
  return match[2] ?? unescapeSpaces(text)
}

type ProsePiece = string | { token: string; label?: string }

// Whether a word of prose could be a link at all. In running text a link is a
// URL (it has a scheme, so a colon) or a path (a slash, or a Windows drive or
// share); `classifyLinkToken` turns every other word down. Most of a reply is
// words like these, and each would otherwise be a link component with its own
// state and effect that renders the word as text.
const MAY_LINK = /[/\\:]/u

export function splitConversationText(text: string): ProsePiece[] {
  const pieces: ProsePiece[] = []
  // Plain text runs join into one string, so a sentence is one text node.
  const push = (piece: ProsePiece) => {
    const last = pieces.length - 1
    if (typeof piece === 'string' && typeof pieces[last] === 'string') pieces[last] += piece
    else pieces.push(piece)
  }
  const words = (chunk: string) => {
    if (!MAY_LINK.test(chunk)) {
      if (chunk) push(chunk)
      return
    }
    for (const token of chunk.split(/(\s+)/)) {
      if (!token) continue
      if (!/\S/.test(token) || !MAY_LINK.test(token)) {
        push(token)
        continue
      }
      const { prefix, body, suffix } = splitProseLinkToken(token)
      if (prefix) push(prefix)
      if (body) push(MAY_LINK.test(body) ? { token: body } : body)
      if (suffix) push(suffix)
    }
  }
  let last = 0
  for (const match of text.matchAll(SPACED_PATH)) {
    words(text.slice(last, match.index))
    const [whole, quote, quoted] = match
    if (quote) {
      push(quote)
      push({ token: quoted })
      push(quote)
    } else {
      const { prefix, body, suffix } = splitProseLinkToken(whole)
      if (prefix) push(prefix)
      push({ token: unescapeSpaces(body), label: body })
      if (suffix) push(suffix)
    }
    last = match.index + whole.length
  }
  words(text.slice(last))
  return pieces
}

export function conversationText(text: string, source: 'text' | 'inlineCode' = 'text'): React.ReactNode {
  if (source === 'inlineCode') {
    const spaced = spacedPathIn(text)
    return spaced ? (
      <ConversationFileLink token={spaced} source={source} label={text} />
    ) : (
      <ConversationFileLink token={text} source={source} />
    )
  }
  return splitConversationText(text).map((piece, index) =>
    typeof piece === 'string' ? (
      piece
    ) : (
      <ConversationFileLink key={index} token={piece.token} source={source} label={piece.label} />
    ),
  )
}

const renderLink = (href: string, label: React.ReactNode) => (
  <ConversationFileLink token={href} source="href" label={label} />
)

// An image in a reply. A file on this disk opens where a file link would — the
// app's own file surface, which shows pictures — so the image and a link to the
// same path beside it do the same thing.
function ConversationMarkdownImage({ src, alt, inLink }: { src: string; alt: string; inLink: boolean }) {
  const context = useContext(LinkContext)
  const onOpenFile = context
    ? (path: string) =>
        openFileSurface({
          workspaceId: context.workspaceId,
          path,
          name: path.split(/[\\/]/).at(-1) ?? path,
          rootPath: context.cwd,
        })
    : undefined
  return <ConversationImage src={src} alt={alt} inLink={inLink} onOpenFile={onOpenFile} />
}
const renderImage = (src: string, alt: string, inLink: boolean) => (
  <ConversationMarkdownImage src={src} alt={alt} inLink={inLink} />
)
export function ConversationMarkdown({
  text,
  streaming = false,
  userText = false,
  tone = 'default',
  size = 'reply',
}: {
  text: string
  streaming?: boolean
  // A message the person sent: newlines stay line breaks and HTML stays text.
  userText?: boolean
  // `muted` sets the whole block one ink step down, for text read beside the
  // reply it led to rather than as one — a reasoning trace.
  tone?: 'default' | 'muted'
  // `compact` is the conversation scale one step smaller, for markdown inside a
  // card (a plan, a pending question) whose own title already heads it.
  size?: 'reply' | 'compact'
}) {
  const streamed = useRef(streaming)
  if (streaming) streamed.current = true
  // Show replies: a paragraph at a time holds what is still being written,
  // and draws it all once the message ends.
  const hold = useReplyStreaming() === 'paragraph' && streaming
  // What a person typed shows as they typed it; an agent's reply typesets its
  // math and draws its diagrams. A `$$` or a ```mermaid fence in a message is
  // far more often a question about the syntax than a request to draw it.
  const options = useMemo(
    () => ({
      codeBlock: userText ? ConversationCodeBlock : ConversationReplyCodeBlock,
      math: !userText,
      streaming,
      density: size === 'compact' ? ('chat-compact' as const) : ('chat' as const),
      tone,
      renderText: conversationText,
      renderLink,
      renderImage,
      ...(userText ? { userText } : { repairFileLinks: true }),
    }),
    [streaming, userText, tone, size],
  )
  // A settled message re-renders with every token of the reply streaming below
  // it; its text has not changed, so neither has its parse.
  const settled = !streamed.current
  const rendered = useMemo(() => (settled ? renderMarkdown(text, options) : null), [settled, text, options])
  return settled ? <>{rendered}</> : <StreamingMarkdown source={text} options={options} hold={hold} />
}
