import type { IBufferLine, ILink, ILinkProvider, Terminal } from '@xterm/xterm'
import { distroOfHostId } from '../../../shared/execution-host'
import { distroOfUncPath, isWindowsPath, isWslDriveMountPath, wslToWindowsPath } from '../../../shared/host-paths'
import { basename, isAbsoluteFilePath, joinFilePath, pathSeparatorFor } from './paths'

export type TerminalFileReference = {
  text: string
  path: string
  resolvedPath: string
  line?: number
  column?: number
  startIndex: number
  endIndex: number
}

export type TerminalFileLinkSegment = {
  y: number
  startIndex: number
  startColumn: number
  text: string
  /**
   * The terminal column (1-based) each UTF-16 code unit of `text` was read
   * from.
   *
   * Not derivable from `startColumn + offset`, which is what this replaced: a
   * cell is not a code unit. Under Unicode 11 an emoji is TWO columns and two
   * code units (accidentally aligned), while a CJK character is two columns
   * and ONE code unit, and a plain empty cell is one column and one code unit
   * — so a single `世` in a line shifts every link range after it left by a
   * cell. The user then sees the underline on the wrong characters and clicks
   * a path that is not there.
   *
   * Optional because `readWrappedLogicalLine` is not the only way a segment is
   * built in tests; absent, `positionForOffset` falls back to the old
   * arithmetic, which is exact for any line of narrow BMP characters.
   */
  columns?: number[]
}

type TerminalFileLinkActivateInput = {
  resolvedPath: string
  name: string
  isDirectory: boolean
  line?: number
  column?: number
}

/** What the clicked path turned out to be on disk. A path that cannot be read
 *  is reported as missing, which routes to `onOpenError` rather than a menu. */
type TerminalFileLinkPathInfo = { exists: boolean; isDirectory: boolean }

/**
 * Why a path the pattern DID match never became a link.
 *
 * Both are invisible by construction — the text just stays un-underlined — so
 * they are reported to the host, which counts them in terminal diagnostics.
 * That is the only way a pane that quietly linkifies nothing can be told apart
 * from a pane whose output happens to contain no paths.
 *
 * - `no-root`: a relative path arrived with neither an execution root nor a
 *   workspace root to resolve it against. This is the one that actually
 *   happens, and the one the counter exists for.
 * - `no-range`: the reference resolved but its offsets did not land inside the
 *   buffer segments the logical line was read from. Through
 *   `createTerminalFileLinkProvider` this should be UNREACHABLE — the
 *   references are matched against the very text those segments tile, so every
 *   offset maps — which is exactly why it is worth counting: a non-zero
 *   `no-range` means the segment tiling and the match offsets have come apart,
 *   and every link on that line is silently gone.
 */
export type TerminalFileLinkDropReason = 'no-root' | 'no-range'

export type TerminalFileLinkDrop = {
  reason: TerminalFileLinkDropReason
  /** The matched text, for a diagnostic log line — never shown to the user. */
  text: string
}

/**
 * A root the provider resolves relative paths against, or a thunk read afresh
 * on every `provideLinks` call.
 *
 * The thunk exists because a pane's real root is not known when the provider is
 * registered. Registration is synchronous, immediately after `term.open`; the
 * spawn cwd is settled later behind an async `pathExists` (a worktree redirect),
 * and a shell's cwd changes for the rest of the session every time the user
 * types `cd` (OSC 7). A value baked in at registration is therefore a guess that
 * silently ages, and the failure mode is the worst kind: the same relative path
 * exists in the stale tree too, so the link opens the WRONG COPY rather than
 * failing. Reading it late costs nothing — `provideLinks` runs on hover.
 */
export type TerminalFileLinkRoot = string | null | (() => string | null)

function readTerminalFileLinkRoot(root: TerminalFileLinkRoot | undefined): string | null {
  return typeof root === 'function' ? root() : (root ?? null)
}

export type TerminalFileLinkProviderOptions = {
  terminal: Terminal
  workspaceRoot?: TerminalFileLinkRoot
  executionRoot?: TerminalFileLinkRoot
  /**
   * The WSL distribution the pane's process runs in, on a Windows host. Its
   * output names files the Linux way (`/home/dev/repo/src/app.ts`), which
   * Windows cannot open until it is spelled as the distribution's share.
   * Null (or absent) everywhere else; see `terminalWslDistro`.
   */
  wslDistro?: TerminalFileLinkRoot
  inspectPath: (path: string) => Promise<TerminalFileLinkPathInfo>
  /** Hands the verified click up to the host: the provider no longer
   *  decides what a click DOES, it only resolves what was clicked. */
  onActivate: (input: TerminalFileLinkActivateInput, anchor: { x: number; y: number }) => Promise<void> | void
  /** Reports a failed open, anchored to the click that triggered it so the UI
   *  can surface the error next to the pointer. */
  onOpenError?: (message: string, anchor: { x: number; y: number }) => void
  /** Reports a match that was discarded before it could become a link. */
  onDrop?: (drop: TerminalFileLinkDrop) => void
}

const FILE_REFERENCE_PATTERN =
  /(^|[\s"'(<{[])([A-Za-z]:[\\/][^\s"'<>`)\]}]+|\/[^\s"'<>`)\]}]+|\.{1,2}[\\/][^\s"'<>`)\]}]+|(?:[\w@.+-]+[\\/])+[\w@.+-][^\s"'<>`]*)/gu

// A colon too: compilers print `main.go:10:5: undefined`, and the colon after
// the position belongs to the message, not the path. URLs never reach this —
// the pattern cannot start one, and the web-link provider owns them.
const TRAILING_PUNCTUATION_PATTERN = /[.,;:!?]+$/u

function stripTrailingPunctuation(value: string): string {
  let next = value.replace(TRAILING_PUNCTUATION_PATTERN, '')
  while (next.endsWith(')') || next.endsWith(']') || next.endsWith('}')) {
    const open = next.endsWith(')') ? '(' : next.endsWith(']') ? '[' : '{'
    const close = next.at(-1)
    const openCount = [...next].filter((char) => char === open).length
    const closeCount = [...next].filter((char) => char === close).length
    if (closeCount <= openCount) break
    next = next.slice(0, -1)
  }
  return next
}

function parseLineSuffix(value: string): { path: string; line?: number; column?: number } {
  const match = /^(.*?)(?::(\d{1,7})(?::(\d{1,7}))?)$/u.exec(value)
  if (!match) return { path: value }

  const path = match[1] ?? ''
  if (!path || /^[A-Za-z]$/u.test(path)) return { path: value }

  const line = Number(match[2])
  const column = match[3] ? Number(match[3]) : undefined
  if (!Number.isSafeInteger(line) || line <= 0) return { path: value }
  if (column !== undefined && (!Number.isSafeInteger(column) || column <= 0)) return { path: value }
  return { path, line, column }
}

function isRemoteOrShellReference(value: string): boolean {
  if (/^[a-z][a-z0-9+.-]*:\/\//iu.test(value)) return true
  if (value.startsWith('~/')) return true
  if (value.startsWith('~\\')) return true
  return false
}

/**
 * Collapses `.`, `..` and repeated separators, keeping the root (a leading
 * separator, or a `C:` drive) so `..` can never climb out of it.
 *
 * Exported because `terminalOscLinks.ts` needs the SAME answer: a path that
 * arrives as an OSC 8 `file:` URI and one the heuristic provider matched in the
 * output both end up in `projectRelativePath`, which is a prefix comparison —
 * two normalisations would mean a `..` that reads as inside the workspace
 * through one route and outside it through the other.
 */
export function normalizePath(pathValue: string): string {
  const separator = pathSeparatorFor(pathValue)
  const normalized = pathValue.replace(/[\\/]+/gu, separator)
  const drive = /^[A-Za-z]:[\\/]/u.exec(normalized)?.[0]?.slice(0, 2) ?? ''
  const absoluteRoot = !drive && normalized.startsWith(separator) ? separator : ''
  const root = drive ? `${drive}${separator}` : absoluteRoot
  const rest = root ? normalized.slice(root.length) : normalized
  const segments: string[] = []

  for (const segment of rest.split(separator)) {
    if (!segment || segment === '.') continue
    if (segment === '..') {
      if (segments.length > 0 && segments.at(-1) !== '..') {
        segments.pop()
      } else if (!root) {
        segments.push(segment)
      }
      continue
    }
    segments.push(segment)
  }

  return `${root}${segments.join(separator)}` || root || '.'
}

/**
 * Decision of record (2026-09-08, item `terminal-relative-links-dropped`):
 * with neither root known we leave a relative path UNLINKED rather than guess
 * a base for it. A guessed root produces links that open the wrong file — or,
 * worse, a same-named file in an unrelated tree — and a terminal pane is the
 * one place where "that is not the file I clicked" is unrecoverable.
 *
 * The roots are both null exactly when the workspace has no configured folder:
 * `TerminalView` derives them from `folderReadyPath`/`savedFolderPath`, and its
 * terminal effect deliberately runs for a folder-less workspace. Such an agent
 * runs in the app's default path, which only main knows — the renderer has
 * nothing to resolve against. Reading the agent's real cwd off the wire is
 * [[terminal-osc7-cwd]]'s job, not a guess this function should make.
 *
 * Until then the drop is at least COUNTED: callers pass `onDrop` and the count
 * reaches terminal diagnostics.
 */
export function resolveTerminalFileReferencePath(filePath: string, roots: TerminalFileReferenceRoots): string | null {
  if (isRemoteOrShellReference(filePath)) return null
  if (isAbsoluteFilePath(filePath)) return normalizeResolvedPath(toHostPath(filePath, roots))

  const base = roots.executionRoot || roots.workspaceRoot
  if (!base) return null
  return normalizeResolvedPath(toHostPath(joinFilePath(base, filePath), roots))
}

type TerminalFileReferenceRoots = {
  executionRoot?: string | null
  workspaceRoot?: string | null
  wslDistro?: string | null
}

/**
 * A Linux path printed by a process under WSL, as Windows opens it — or the
 * path unchanged anywhere else.
 *
 * An agent running in a distribution prints `/home/dev/repo/src/app.ts`, and
 * a shell there reports its cwd the same way, so a relative path joined onto
 * it is Linux too. Handed to Windows as it is, `/home/dev/…` is read as a
 * folder on the current drive and every such link says the file does not
 * exist. `/mnt/c/…` needs no distribution to translate; anything else needs
 * the pane to say which one holds it (`terminalWslDistro`).
 */
function toHostPath(pathValue: string, roots: TerminalFileReferenceRoots): string {
  if (!pathValue.startsWith('/') || pathValue.startsWith('//')) return pathValue
  if (roots.wslDistro) return wslToWindowsPath(pathValue, { distro: roots.wslDistro })
  const windowsHost = [roots.executionRoot, roots.workspaceRoot].some((root) => root && isWindowsPath(root))
  return windowsHost && isWslDriveMountPath(pathValue) ? wslToWindowsPath(pathValue) : pathValue
}

/**
 * The distribution a pane's Linux paths belong to: the one its process was
 * launched into, else the one whose share holds a root. Null off Windows,
 * where `/home/…` is already a path this machine opens — including for a
 * workspace another machine stored under a share.
 */
export function terminalWslDistro(input: {
  platform: string
  hostId?: string | null
  roots: Array<string | null | undefined>
}): string | null {
  if (input.platform !== 'win32') return null
  const fromHost = distroOfHostId(input.hostId)
  if (fromHost) return fromHost
  for (const root of input.roots) {
    const distro = root ? distroOfUncPath(root) : null
    if (distro) return distro
  }
  return null
}

/**
 * `normalizePath`, keeping a UNC path's `\\server\share` whole. The normaliser
 * collapses every run of separators, so `\\wsl.localhost\Ubuntu\…` handed to it
 * as it is would come back as a path on the current drive; and a `..` has to
 * stop at the share, as it stops at a drive. A posix `//x` is not a share and
 * is collapsed as it always was.
 */
function normalizeResolvedPath(pathValue: string): string {
  const unc = /^\\\\[^\\/]/u.test(pathValue) || distroOfUncPath(pathValue) !== null
  if (!unc) return normalizePath(pathValue)
  const [server = '', share = '', ...rest] = pathValue.slice(2).split(/[\\/]+/u)
  const root = `\\\\${server}\\${share}`
  const tail = normalizePath(`\\${rest.join('\\')}`)
  return tail === '\\' ? root : `${root}${tail}`
}

export function findTerminalFileReferences(
  lineText: string,
  roots: TerminalFileReferenceRoots,
  onDrop?: (drop: TerminalFileLinkDrop) => void,
): TerminalFileReference[] {
  const references: TerminalFileReference[] = []

  for (const match of lineText.matchAll(FILE_REFERENCE_PATTERN)) {
    const prefix = match[1] ?? ''
    const rawCandidate = match[2] ?? ''
    const matchIndex = match.index ?? 0
    const startIndex = matchIndex + prefix.length
    const text = stripTrailingPunctuation(rawCandidate)
    if (!text || isRemoteOrShellReference(text)) continue

    const parsed = parseLineSuffix(text)
    // A URL or a `~/…` path is a deliberate NON-match, not a drop: counting it
    // would fire the diagnostic on every `https://…` an agent prints. Screened
    // on `text` above and re-screened here on the suffix-stripped path, so the
    // reason recorded below stays a fact about this branch rather than an
    // argument about which prefixes `parseLineSuffix` can and cannot remove.
    if (isRemoteOrShellReference(parsed.path)) continue

    const resolvedPath = resolveTerminalFileReferencePath(parsed.path, roots)
    if (!resolvedPath) {
      // Only one way left to get here: a relative path with no root to hang it
      // on. See the decision of record on `resolveTerminalFileReferencePath`.
      onDrop?.({ reason: 'no-root', text })
      continue
    }

    references.push({
      text,
      path: parsed.path,
      resolvedPath,
      line: parsed.line,
      column: parsed.column,
      startIndex,
      endIndex: startIndex + text.length,
    })
  }

  return references
}

export function rangeForTerminalFileReference(
  reference: Pick<TerminalFileReference, 'startIndex' | 'endIndex'>,
  segments: TerminalFileLinkSegment[],
): ILink['range'] | null {
  if (segments.length === 0 || reference.endIndex <= reference.startIndex) return null

  const start = positionForOffset(reference.startIndex, segments)
  const end = positionForOffset(reference.endIndex - 1, segments)
  if (!start || !end) return null

  return { start, end }
}

function positionForOffset(offset: number, segments: TerminalFileLinkSegment[]): ILink['range']['start'] | null {
  for (const segment of segments) {
    const segmentEnd = segment.startIndex + segment.text.length
    if (offset >= segment.startIndex && offset < segmentEnd) {
      const withinSegment = offset - segment.startIndex
      return {
        // The cell the character actually came from, when the segment was read
        // off real buffer cells. The arithmetic fallback is only correct while
        // every character is one column wide — see `columns`.
        x: segment.columns?.[withinSegment] ?? withinSegment + segment.startColumn,
        y: segment.y,
      }
    }
  }
  return null
}

/**
 * A row's text, and the 1-based terminal column each of its UTF-16 code units
 * was read from.
 *
 * Why this is not `startColumn + offset`: a cell is not a code unit, and under
 * Unicode 11 the two come apart in both directions. An emoji is two columns and
 * two code units; a CJK character is two columns and ONE; a blank cell is one
 * column and one. So a single wide character earlier in a line shifts every
 * later link range by a cell, and the user sees the underline on the wrong
 * characters and clicks a path that is not there.
 *
 * Why this is not xterm's own mapping: `BufferLine.translateToString` does take
 * a fourth `outColumns` argument and fills it with exactly this — but the
 * public `IBufferLine` an addon receives is an API view whose
 * `translateToString(trimRight, start, end)` forwards only three arguments, so
 * the parameter is unreachable from here and passing it silently yields an
 * empty array. The walk below is therefore a deliberate reimplementation of
 * that loop, and `terminalWideCharacterLinks.test.ts` pins it against the real
 * `translateToString` — over wide, astral, combining, blank and trailing-blank
 * rows of a live xterm buffer — so the two cannot drift apart unnoticed.
 */
function readLineWithColumns(
  line: IBufferLine,
  trimRight: boolean,
  startColumn: number,
  endColumn: number,
): { text: string; columns: number[] } {
  const cell = line.getCell(startColumn)
  const end = trimRight ? Math.min(endColumn, trimmedCellLength(line, endColumn)) : endColumn

  const chunks: string[] = []
  const columns: number[] = []
  let x = startColumn
  while (x < end) {
    const current = line.getCell(x, cell)
    if (!current) break
    // A cell the stream never wrote has no codepoint and renders as a space,
    // exactly as xterm does. Advancing by the cell's WIDTH is what steps over
    // the placeholder cell that follows a wide character; `|| 1` keeps a
    // zero-width cell reached head-on from looping forever.
    const chars = current.getChars() || WHITESPACE_CELL
    const width = current.getWidth()
    chunks.push(chars)
    for (let unit = 0; unit < chars.length; unit += 1) columns.push(x + 1)
    x += width || 1
  }

  return { text: chunks.join(''), columns }
}

const WHITESPACE_CELL = ' '

/**
 * Where a row's content ends, in CELLS — xterm's `getTrimmedLength`, which is
 * what `translateToString(true)` clamps to and which the public `IBufferLine`
 * does not expose. Note it is the index plus the character's WIDTH, so a row
 * ending in a wide character reports both of its columns.
 */
function trimmedCellLength(line: IBufferLine, cols: number): number {
  const cell = line.getCell(0)
  for (let x = cols - 1; x >= 0; x -= 1) {
    const current = line.getCell(x, cell)
    if (!current) continue
    if (current.getChars() !== '') return x + current.getWidth()
  }
  return 0
}

export function readWrappedLogicalLine(
  terminal: Terminal,
  bufferLineNumber: number,
): { text: string; segments: TerminalFileLinkSegment[] } | null {
  const buffer = terminal.buffer.active
  const currentLine = buffer.getLine(bufferLineNumber - 1)
  if (!currentLine) return null

  let startY = bufferLineNumber
  while (startY > 1 && buffer.getLine(startY - 1)?.isWrapped) {
    startY -= 1
  }

  let endY = bufferLineNumber
  while (buffer.getLine(endY)?.isWrapped) {
    endY += 1
  }

  const segments: TerminalFileLinkSegment[] = []
  let text = ''
  for (let y = startY; y <= endY; y += 1) {
    const line = buffer.getLine(y - 1)
    if (!line) break
    const isLast = y === endY
    const row = readLineWithColumns(line, isLast, 0, terminal.cols)
    segments.push({
      y,
      startIndex: text.length,
      startColumn: 1,
      text: row.text,
      columns: row.columns,
    })
    text += row.text
  }

  return { text, segments }
}

// =============================================================================
// Hard wraps: a path the program broke onto the next row itself
//
// A soft wrap is xterm's own: the row ran out of columns, the next row carries
// `isWrapped`, and `readWrappedLogicalLine` joins the two exactly. An agent CLI
// never produces one. It lays out its own frame, word-wraps every paragraph to
// the width it computed, and writes each row with a cursor move or a newline —
// so a path longer than the space left for it arrives as two ordinary rows, the
// second indented to the paragraph's margin (or behind the frame's `│`). A
// Windows pty that re-renders its screen can hard-wrap plain shell output the
// same way, with no indent at all.
//
// Nothing in the buffer says those two rows are one path, so the join below is
// a guess, and it is only kept when the file system agrees with it: the joined
// path must exist. A guess that fails falls back to what each row says on its
// own, which is what the pane did before any of this.
// =============================================================================

/**
 * The vertical rules a TUI draws down the sides of a frame. A row that ends in
 * one of these is a framed row, and its content ends before the rule.
 */
const FRAME_RULE_CHARS = '│┃║╎╏┆┇┊┋▕⎹'

/** Stripped off the right of a row: padding, one frame rule, padding. */
const TRAILING_FRAME_PATTERN = new RegExp(`\\s*[${FRAME_RULE_CHARS}]?\\s*$`, 'u')

/**
 * Stripped off the left of a continuation row: the indent a wrapped paragraph
 * hangs from, and whatever the program drew in its gutter — a frame's rule, a
 * tree connector, the `⎿` an agent CLI hangs tool output from.
 */
const LEADING_GUTTER_PATTERN = new RegExp(`^[\\s\\u2500-\\u257F${FRAME_RULE_CHARS}⎿⎸▏]*`, 'u')

/**
 * How far short of the right edge a row may stop and still count as having run
 * into it.
 *
 * A program wrapping its own text wraps at the width IT computed, which is the
 * terminal's minus whatever margin and frame padding its layout keeps — a
 * column or two for an agent CLI's message column, more inside a bordered box.
 * The requirement that remains is that the row's last token runs right up to
 * that point, which ordinary prose ending mid-row does not. The existence check
 * is what makes a generous margin safe.
 */
const HARD_WRAP_EDGE_SLACK = 8

/** How many rows beyond the hovered one a single path may be joined across. */
const MAX_HARD_WRAP_JOINS = 3

/**
 * How long a row's links may wait on the file system before the row is
 * answered with what it says on its own. xterm holds every later provider's
 * links — web links too — until this one answers.
 */
const HARD_WRAP_CHECK_DEADLINE_MS = 300

/** How long one existence check answers for, and how many are remembered. */
const HARD_WRAP_CHECK_TTL_MS = 2_000
const HARD_WRAP_CHECK_CACHE_SIZE = 64

type LogicalLine = { text: string; segments: TerminalFileLinkSegment[] }

function firstRowOf(line: LogicalLine): number {
  return line.segments[0]?.y ?? 0
}

function lastRowOf(line: LogicalLine): number {
  return line.segments.at(-1)?.y ?? 0
}

/**
 * Where a row's content ends, once any frame rule and padding are taken off,
 * or null when the row does not end in a token that runs into the right edge
 * and so cannot be the first half of a hard-wrapped path.
 */
function hardWrapHeadEnd(line: LogicalLine, cols: number): number | null {
  const last = line.segments.at(-1)
  if (!last) return null
  const trailing = TRAILING_FRAME_PATTERN.exec(line.text)?.[0] ?? ''
  const end = line.text.length - trailing.length
  if (end <= last.startIndex) return null
  if (/\s/u.test(line.text[end - 1] ?? ' ')) return null

  // The rule, when there is one, is the edge; otherwise the terminal's.
  const rule = trailing.trim()
  const ruleOffset = rule ? line.text.length - trailing.length + trailing.indexOf(rule) : -1
  const edge = rule ? columnAt(last, ruleOffset) - 1 : cols
  if (columnAt(last, end - 1) < edge - HARD_WRAP_EDGE_SLACK) return null
  return end
}

/** Where a continuation row's content starts, past its indent and gutter. */
function hardWrapContinuationStart(line: LogicalLine): number {
  return LEADING_GUTTER_PATTERN.exec(line.text)?.[0].length ?? 0
}

function columnAt(segment: TerminalFileLinkSegment, offset: number): number {
  const within = offset - segment.startIndex
  return segment.columns?.[within] ?? segment.startColumn + within
}

function canJoin(above: LogicalLine, below: LogicalLine, cols: number): boolean {
  if (hardWrapHeadEnd(above, cols) === null) return false
  const start = hardWrapContinuationStart(below)
  return start < below.text.length && !/\s/u.test(below.text[start] ?? ' ')
}

/**
 * The run of logical lines a hard-wrapped path through `hovered` could span,
 * top to bottom, `hovered` included. A single entry means there is nothing to
 * join.
 *
 * Walks both ways because xterm asks for links one row at a time: the row a
 * person hovers is as often the tail of the path as its head, and a tail read
 * on its own is a relative fragment that resolves to a file that is not there.
 */
function readHardWrapChain(terminal: Terminal, hovered: LogicalLine): LogicalLine[] {
  const cols = terminal.cols
  const chain = [hovered]

  for (let joins = 0; joins < MAX_HARD_WRAP_JOINS; joins += 1) {
    const top = chain[0]!
    const aboveY = firstRowOf(top) - 1
    if (aboveY < 1) break
    const above = readWrappedLogicalLine(terminal, aboveY)
    if (!above || !canJoin(above, top, cols)) break
    chain.unshift(above)
  }

  for (let joins = 0; joins < MAX_HARD_WRAP_JOINS; joins += 1) {
    const bottom = chain.at(-1)!
    const below = readWrappedLogicalLine(terminal, lastRowOf(bottom) + 1)
    if (!below || !canJoin(bottom, below, cols)) break
    chain.push(below)
  }

  return chain
}

/** The part of `line` between two offsets, as segments rebased to `base`. */
function sliceSegments(line: LogicalLine, from: number, to: number, base: number): TerminalFileLinkSegment[] {
  const sliced: TerminalFileLinkSegment[] = []
  for (const segment of line.segments) {
    const segmentEnd = segment.startIndex + segment.text.length
    const start = Math.max(from, segment.startIndex)
    const end = Math.min(to, segmentEnd)
    if (end <= start) continue
    const within = start - segment.startIndex
    const length = end - start
    sliced.push({
      y: segment.y,
      startIndex: base + (start - from),
      startColumn: columnAt(segment, start),
      text: segment.text.slice(within, within + length),
      columns: segment.columns?.slice(within, within + length),
    })
  }
  return sliced
}

/**
 * The chain as one line: each head's frame and padding cut off its right, each
 * continuation's indent and gutter cut off its left, so the two halves of the
 * path meet with nothing between them. `joins` are the offsets where one row's
 * text meets the next's.
 */
function joinHardWrapChain(chain: LogicalLine[], cols: number): LogicalLine & { joins: number[] } {
  const segments: TerminalFileLinkSegment[] = []
  const joins: number[] = []
  let text = ''
  chain.forEach((line, index) => {
    const from = index === 0 ? 0 : hardWrapContinuationStart(line)
    const to = index === chain.length - 1 ? line.text.length : (hardWrapHeadEnd(line, cols) ?? line.text.length)
    if (index > 0) joins.push(text.length)
    segments.push(...sliceSegments(line, from, to, text.length))
    text += line.text.slice(from, to)
  })
  return { text, segments, joins }
}

type ResolvedTerminalLink = { reference: TerminalFileReference; range: ILink['range'] }

function comparePositions(a: ILink['range']['start'], b: ILink['range']['start']): number {
  return a.y === b.y ? a.x - b.x : a.y - b.y
}

function rangesOverlap(a: ILink['range'], b: ILink['range']): boolean {
  return comparePositions(a.start, b.end) <= 0 && comparePositions(b.start, a.end) <= 0
}

function rangeTouchesRow(range: ILink['range'], y: number): boolean {
  return range.start.y <= y && y <= range.end.y
}

/**
 * The paths in `joined` that cross from one row into the next and touch
 * `hoveredRow` — the guesses worth asking the file system about.
 *
 * Read from every join as well as from the start, because the row above a
 * path is as often the end of a wrapped sentence as the start of the path: an
 * agent word-wraps its prose to the same edge, so `…in the file at` joins onto
 * `/Users/dev/…` as `at/Users/dev/…`, and a match read only from the start is
 * that one wrong guess. A match that begins at a join is the path on its own.
 * Anything that crosses no join is a match `rowLinks` already has.
 */
function hardWrapCandidates(
  joined: LogicalLine & { joins: number[] },
  roots: TerminalFileReferenceRoots,
  hoveredRow: number,
): ResolvedTerminalLink[] {
  const candidates = new Map<string, ResolvedTerminalLink>()
  for (const from of [0, ...joined.joins]) {
    // Not reported to `onDrop`: every text here was either counted when its
    // own row was read or is a guess, and a failed guess is not a drop.
    for (const found of findTerminalFileReferences(joined.text.slice(from), roots)) {
      const reference = { ...found, startIndex: found.startIndex + from, endIndex: found.endIndex + from }
      const crosses = joined.joins.some((join) => reference.startIndex < join && join < reference.endIndex)
      if (!crosses) continue
      const range = rangeForTerminalFileReference(reference, joined.segments)
      if (!range || !rangeTouchesRow(range, hoveredRow)) continue
      candidates.set(`${reference.startIndex}:${reference.endIndex}`, { reference, range })
    }
  }
  return [...candidates.values()]
}

/** The longest links that exist, and none that overlaps one already kept. */
function longestFirstWithoutOverlap(links: ResolvedTerminalLink[]): ResolvedTerminalLink[] {
  const kept: ResolvedTerminalLink[] = []
  const longestFirst = [...links].sort(
    (a, b) => b.reference.endIndex - b.reference.startIndex - (a.reference.endIndex - a.reference.startIndex),
  )
  for (const link of longestFirst) {
    if (!kept.some((other) => rangesOverlap(other.range, link.range))) kept.push(link)
  }
  return kept
}

const URL_PATTERN = /[a-z][a-z0-9+.-]*:\/\/[^\s"'<>`]+/giu

/** The cell each join a URL runs across lands on — where its tail starts. */
function urlCutPositions(joined: LogicalLine & { joins: number[] }): Array<ILink['range']['start']> {
  const cuts: Array<ILink['range']['start']> = []
  for (const match of joined.text.matchAll(URL_PATTERN)) {
    const start = match.index ?? 0
    const end = start + match[0].length
    for (const join of joined.joins) {
      if (start >= join || join >= end) continue
      const position = positionForOffset(join, joined.segments)
      if (position) cuts.push(position)
    }
  }
  return cuts
}

export function createTerminalFileLinkProvider({
  terminal,
  workspaceRoot,
  executionRoot,
  wslDistro,
  inspectPath,
  onActivate,
  onOpenError,
  onDrop,
}: TerminalFileLinkProviderOptions): ILinkProvider {
  const toLink = ({ reference, range }: ResolvedTerminalLink): ILink => ({
    text: reference.text,
    range,
    decorations: {
      pointerCursor: true,
      underline: true,
    },
    activate: (event) => {
      const anchor = { x: event.clientX, y: event.clientY }
      void (async () => {
        try {
          const info = await inspectPath(reference.resolvedPath)
          if (!info.exists) {
            onOpenError?.(`File does not exist: ${reference.resolvedPath}`, anchor)
            return
          }
          await onActivate(
            {
              resolvedPath: reference.resolvedPath,
              name: basename(reference.resolvedPath),
              isDirectory: info.isDirectory,
              line: reference.line,
              column: reference.column,
            },
            anchor,
          )
        } catch (error) {
          onOpenError?.(error instanceof Error ? error.message : 'Could not open terminal file link.', anchor)
        }
      })()
    },
  })

  // Hovering along a wrapped paragraph asks about the same guesses row after
  // row; one answer serves them all for a moment.
  const recentChecks = new Map<string, { exists: boolean; at: number }>()
  const exists = async ({ reference }: ResolvedTerminalLink): Promise<boolean> => {
    const now = Date.now()
    const recent = recentChecks.get(reference.resolvedPath)
    if (recent && now - recent.at < HARD_WRAP_CHECK_TTL_MS) return recent.exists
    const found = await inspectPath(reference.resolvedPath).then(
      (info) => info.exists,
      () => false,
    )
    if (recentChecks.size >= HARD_WRAP_CHECK_CACHE_SIZE) recentChecks.clear()
    recentChecks.set(reference.resolvedPath, { exists: found, at: Date.now() })
    return found
  }
  let requestCount = 0

  return {
    provideLinks(bufferLineNumber, callback) {
      // Every request counts, answered at once or not: a later one means xterm
      // has moved on from this row.
      requestCount += 1
      const logicalLine = readWrappedLogicalLine(terminal, bufferLineNumber)
      if (!logicalLine) {
        callback(undefined)
        return
      }

      // Read on every call, not captured at registration: see
      // `TerminalFileLinkRoot`. For a plain root this is the same value it
      // always was.
      const roots = {
        executionRoot: readTerminalFileLinkRoot(executionRoot),
        workspaceRoot: readTerminalFileLinkRoot(workspaceRoot),
        wslDistro: readTerminalFileLinkRoot(wslDistro),
      }

      const rowLinks: ResolvedTerminalLink[] = findTerminalFileReferences(logicalLine.text, roots, onDrop).flatMap(
        (reference) => {
          const range = rangeForTerminalFileReference(reference, logicalLine.segments)
          if (!range) {
            // Invariant tripwire, not an expected branch: `reference` was matched
            // against `logicalLine.text`, which `logicalLine.segments` tile
            // exactly, so every offset must map to a cell. Counted rather than
            // ignored because the failure mode is a line that silently stops
            // linkifying.
            onDrop?.({ reason: 'no-range', text: reference.text })
            return []
          }
          return [{ reference, range }]
        },
      )

      const chain = readHardWrapChain(terminal, logicalLine)
      const joined = chain.length > 1 ? joinHardWrapChain(chain, terminal.cols) : null
      const candidates = joined ? hardWrapCandidates(joined, roots, bufferLineNumber) : []
      // The other half of the same guess, for a URL: the web-link provider
      // reads one soft-wrapped line at a time, so the tail of a hard-wrapped
      // `https://…` is left on its row looking like a relative path
      // (`com/docs/guide.md`). A row match that starts exactly where such a URL
      // was cut is kept only if it, too, turns out to exist.
      const urlCuts = joined ? urlCutPositions(joined) : []
      const suspects = rowLinks.filter((row) => urlCuts.some((cut) => comparePositions(cut, row.range.start) === 0))

      if (candidates.length === 0 && suspects.length === 0) {
        callback(rowLinks.length > 0 ? rowLinks.map(toLink) : undefined)
        return
      }

      const request = requestCount
      let settled = false
      const answer = (links: ResolvedTerminalLink[]) => {
        // xterm keeps one set of replies, for the row the pointer is on NOW.
        // An answer for a row it has since left would be filed under the new
        // row and replace that row's links, so it is dropped instead; xterm
        // discarded the request along with that row.
        if (settled || request !== requestCount) return
        settled = true
        callback(links.length > 0 ? links.map(toLink) : undefined)
      }
      // Every provider after this one waits for its answer, web links
      // included, so a check that hangs (a host that has gone away) must not
      // hold the row: past the deadline the row gets what it says on its own.
      const deadline = setTimeout(() => answer(rowLinks), HARD_WRAP_CHECK_DEADLINE_MS)

      void Promise.all([Promise.all(candidates.map(exists)), Promise.all(suspects.map(exists))]).then(
        ([candidateExists, suspectExists]) => {
          clearTimeout(deadline)
          const accepted = longestFirstWithoutOverlap(candidates.filter((_, index) => candidateExists[index]))
          const missingSuspects = new Set(suspects.filter((_, index) => !suspectExists[index]))
          // A joined path that exists replaces the fragments either row matched
          // on its own — the tail of `src/comp` + `onents/App.tsx` read alone is
          // `onents/App.tsx`, a relative path to nothing.
          const kept = rowLinks.filter(
            (row) => !missingSuspects.has(row) && !accepted.some((join) => rangesOverlap(join.range, row.range)),
          )
          answer([...accepted, ...kept])
        },
      )
    },
  }
}
