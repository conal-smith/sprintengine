import React, { Component, memo, useEffect, useId, useRef, useState, type ReactNode } from 'react'
import { ChevronDownIcon } from '../AppIcons'
import { GhostButton, IconButton } from './Buttons'
import { LinkButton } from './LinkButton'
import { CopyGlyphButton } from './CopyGlyphButton'
import { FileTypeGlyph } from './FileTypeGlyph'
import { Tooltip } from './Tooltip'
import { TruncatedText } from './TruncatedText'
import { TerminalPromptGlyph, ViewSourceGlyph, WrapLinesGlyph } from './CodeBlockGlyphs'
import { codeBlockTitle, countLines, pastableShellCommand } from './codeBlockModel'
import { useRevealMatch } from '../../utils/revealMatch'
import {
  cachedCodeLines,
  HIGHLIGHT_LINE_LIMIT,
  IncrementalCodeTokenizer,
  loadCodeLanguage,
  normalizeCodeLanguage,
  type CodeLine,
} from '../../lib/highlight/codeHighlight'
import '../../../../../design-system/components/code-block/component.css'

export type CodeBlockProps = {
  code: string
  language?: string
  filename?: string
  streaming?: boolean
  /** Header actions a surface adds for its own kind of block, set before the block's own. Glyph buttons at `xs`. */
  actions?: ReactNode
  /**
   * Offer "Paste into terminal" on a settled shell block. The block decides
   * whether it is one (see `pastableShellCommand`) and hands over the command
   * with its `$ ` / `% ` prompts stripped; the surface decides which terminal it
   * goes to. The handler must paste, never press Enter — the person runs it.
   * Leave it unset where no terminal is reachable, and the action is not drawn.
   */
  onPasteInTerminal?: (command: string) => void
  /**
   * Fold a long settled block to its first lines behind a "Show all" control.
   * On by default; a surface that already pages its own output turns it off so
   * the block does not grow a second disclosure.
   */
  collapsible?: boolean
  /**
   * A drawing made from the source — a diagram — shown in its place on a
   * settled block, with a toggle back to the source. The source stays the
   * block's text: Copy code copies it, and so does a selection across the
   * block. Leave it unset while the drawing is not ready, and the source shows.
   */
  drawing?: ReactNode
  /** A quiet line under the block saying something about it, such as why it shows as source. */
  note?: string
  /** An action the note offers, set after it as a link: "Retry" when a drawing failed to load. */
  noteAction?: CodeBlockNoteAction
}

export type CodeBlockNoteAction = { label: string; onClick: () => void }

/**
 * A settled block longer than this folds. Twenty lines is about a screenful of
 * reply at the conversation's width: past it, one block pushes the prose that
 * explains it out of view.
 */
export const COLLAPSE_AFTER_LINES = 20

/** Lines a folded block keeps visible — set in component.css as `12lh`; keep the two together. */
export const COLLAPSED_LINES = 12

const TokenLine = memo(function TokenLine({ line }: { line: CodeLine }) {
  return (
    <>
      {line.tokens.map((token, index) => (
        <span key={index} style={{ color: token.color }}>
          {token.content}
        </span>
      ))}
    </>
  )
})

function HighlightedSource({ code, language, streaming }: { code: string; language: string; streaming?: boolean }) {
  const normalized = normalizeCodeLanguage(language)
  const tokenizer = useRef<{ language: string; value: IncrementalCodeTokenizer } | null>(null)
  const [ready, setReady] = useState<string | null>(null)
  const [failed, setFailed] = useState(false)
  useEffect(() => {
    let cancelled = false
    setFailed(false)
    if (!normalized) return
    void loadCodeLanguage(normalized)
      .then((engine) => {
        if (cancelled) return
        tokenizer.current = { language: normalized, value: new IncrementalCodeTokenizer(engine, normalized) }
        setReady(normalized)
      })
      .catch(() => {
        if (!cancelled) setFailed(true)
      })
    return () => {
      cancelled = true
    }
  }, [normalized])
  if (!normalized || failed) return <code>{code}</code>
  const cached = !streaming ? cachedCodeLines(normalized, code) : undefined
  const current = tokenizer.current
  const lines =
    cached ?? (ready === normalized && current?.language === normalized ? current.value.update(code, !streaming) : null)
  if (!lines)
    return (
      <code aria-busy="true" style={{ visibility: 'hidden' }}>
        {code}
      </code>
    )
  return (
    <code>
      {lines.map((line, index) => (
        <React.Fragment key={index}>
          <TokenLine line={line} />
          {index < lines.length - 1 ? '\n' : null}
        </React.Fragment>
      ))}
    </code>
  )
}

class CodeBoundary extends Component<{ children: ReactNode; code: string }, { failed: boolean }> {
  state = { failed: false }
  static getDerivedStateFromError() {
    return { failed: true }
  }
  render() {
    return this.state.failed ? <code>{this.props.code}</code> : this.props.children
  }
}

/**
 * Marks which horizontal edges of an unwrapped block have code past them, so the
 * CSS fades exactly those edges. Written straight onto the element rather than
 * through state: it changes on every scroll event, and a re-render per scroll
 * frame would re-run the highlighter's line diff for nothing.
 */
function useOverflowEdges(ref: React.RefObject<HTMLPreElement | null>, code: string, wrap: boolean) {
  useEffect(() => {
    const pre = ref.current
    if (!pre) return
    const update = () => markOverflowEdges(pre)
    pre.addEventListener('scroll', update, { passive: true })
    const observer = typeof ResizeObserver === 'undefined' ? null : new ResizeObserver(update)
    observer?.observe(pre)
    return () => {
      pre.removeEventListener('scroll', update)
      observer?.disconnect()
    }
  }, [ref])
  // When the source or the wrap changes, too: a streamed line can widen the
  // source without resizing the box, and a wrap toggle changes the answer
  // without either event firing. Read on the next frame rather than in the
  // commit, so a burst of streamed tokens costs one layout read, not one each.
  useEffect(() => {
    const frame = requestAnimationFrame(() => {
      if (ref.current) markOverflowEdges(ref.current)
    })
    return () => cancelAnimationFrame(frame)
  }, [ref, code, wrap])
}

function markOverflowEdges(pre: HTMLPreElement) {
  // A pixel of slack: fractional widths leave scrollLeft a hair short of the end.
  const room = pre.scrollWidth - pre.clientWidth
  pre.toggleAttribute('data-fade-start', room > 1 && pre.scrollLeft > 1)
  pre.toggleAttribute('data-fade-end', room > 1 && pre.scrollLeft < room - 1)
}

export function CodeBlock(props: CodeBlockProps) {
  const { code, streaming } = props
  const [wrap, setWrap] = useState(false)
  // A block first seen while it streamed stays open when it settles: folding it
  // then would pull the lines out from under someone reading them. One that
  // arrives settled — scrolled back to, reopened — starts folded.
  const [expanded, setExpanded] = useState(() => Boolean(streaming))
  const [showSource, setShowSource] = useState(false)
  const bodyId = useId()
  const preRef = useRef<HTMLPreElement | null>(null)
  useOverflowEdges(preRef, code, wrap)

  const title = codeBlockTitle(props.language, props.filename)
  const lineCount = countLines(code)
  const drawn = props.drawing != null && !streaming && !showSource
  const foldable = props.collapsible !== false && !streaming && !drawn && lineCount > COLLAPSE_AFTER_LINES
  const folded = foldable && !expanded
  const bodyRef = useRef<HTMLDivElement | null>(null)
  // A find in the app's own text (Find in chat) that lands on a folded line
  // opens the block, as "Show all" would.
  useRevealMatch(bodyRef, folded, () => setExpanded(true))
  const command = props.onPasteInTerminal ? pastableShellCommand(code, props.language, streaming) : null
  const onPaste = props.onPasteInTerminal

  return (
    <section
      className={`ds-code-block${wrap ? ' ds-code-block--wrap' : ''}`}
      aria-label={title.filename ? `${title.languageName} code, ${title.filename}` : `${title.languageName} code`}
      data-code-block=""
      data-code-language={normalizeCodeLanguage(title.highlightLanguage) ?? title.languageTag}
    >
      {/* Chrome, not content: a selection copied across the block takes the
          source and none of this. */}
      <div className="ds-code-block__header" data-copy-exclude="">
        <span className="ds-code-block__label">
          {title.kind ? <FileTypeGlyph kind={title.kind} className="ds-code-block__glyph" /> : null}
          {title.filename ? (
            <TruncatedText as="span" text={title.filename} className="ds-code-block__filename" />
          ) : (
            <span className="ds-code-block__language">{title.label}</span>
          )}
        </span>
        <div className="ds-code-block__actions" role="group" aria-label="Code actions">
          {props.actions}
          {command && onPaste ? (
            <Tooltip content="Paste into terminal — it runs when you press Enter">
              <IconButton size="xs" tone="subtle" aria-label="Paste into terminal" onClick={() => onPaste(command)}>
                <TerminalPromptGlyph className="size-icon-xs" />
              </IconButton>
            </Tooltip>
          ) : null}
          {/* Wrap comes and goes with the source view, so it sits left of
              Show source: the toggle keeps its place beside Copy, and a second
              click on the same spot switches back. */}
          {drawn ? null : (
            <Tooltip content="Wrap lines">
              <IconButton
                size="xs"
                tone="subtle"
                aria-label="Wrap lines"
                pressed={wrap}
                onClick={() => setWrap((value) => !value)}
              >
                <WrapLinesGlyph className="size-icon-xs" />
              </IconButton>
            </Tooltip>
          )}
          {props.drawing != null && !streaming ? (
            <Tooltip content="Show source">
              <IconButton
                size="xs"
                tone="subtle"
                aria-label="Show source"
                pressed={showSource}
                onClick={() => setShowSource((value) => !value)}
              >
                <ViewSourceGlyph className="size-icon-xs" />
              </IconButton>
            </Tooltip>
          ) : null}
          <CopyGlyphButton text={code} label="Copy code" size="xs" tone="subtle" />
        </div>
      </div>
      {/* Folding clips the box, never the source: every line stays in the DOM,
          so find-in-page, a selection and the copy glyph all still get it all. */}
      {/* A drawing is chrome to a selection: the source under it, hidden, is
          what a copy across the block takes. */}
      {drawn ? (
        <div className="ds-code-block__drawing" data-copy-exclude="">
          {props.drawing}
        </div>
      ) : null}
      <div
        ref={bodyRef}
        id={bodyId}
        className="ds-code-block__body"
        data-folded={folded ? '' : undefined}
        hidden={drawn}
      >
        <pre ref={preRef}>
          <CodeBoundary code={code}>
            <HighlightedSource code={code} language={title.highlightLanguage} streaming={streaming} />
          </CodeBoundary>
        </pre>
      </div>
      {foldable ? (
        <div className="ds-code-block__fold" data-copy-exclude="">
          <GhostButton
            size="xs"
            tone="subtle"
            aria-expanded={!folded}
            aria-controls={bodyId}
            onClick={() => setExpanded(folded)}
          >
            <ChevronDownIcon
              className={`size-icon-xs ds-code-block__chevron${folded ? '' : ' ds-code-block__chevron--open'}`}
            />
            {folded ? `Show all ${lineCount} lines` : 'Show less'}
          </GhostButton>
        </div>
      ) : null}
      {lineCount > HIGHLIGHT_LINE_LIMIT && !drawn ? (
        <div className="ds-code-block__note" data-copy-exclude="">
          Highlighting stopped at {HIGHLIGHT_LINE_LIMIT} lines
        </div>
      ) : null}
      {props.note ? (
        <div className="ds-code-block__note" data-copy-exclude="">
          {props.note}
          {props.noteAction ? (
            <>
              {' · '}
              <LinkButton onClick={props.noteAction.onClick}>{props.noteAction.label}</LinkButton>
            </>
          ) : null}
        </div>
      ) : null}
    </section>
  )
}
