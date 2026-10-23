// Math in a reply: `$$…$$` and `\(…\)` inline, `$$` and `\[` … `\]` blocks,
// and a ```math fence, typeset with KaTeX.
//
// The risk is not missing a formula but finding one that is not there. Agents
// write prices ("between $5 and $10") and shell variables (`$HOME`, `$PATH`)
// in prose all the time, so a single dollar never opens math; only a doubled
// one does. A `$$` that closes right before a digit is a pair of amounts
// written with doubled signs ("$$100 and then $$200"), not a formula. Every
// delimiter is read by the parser itself rather than by a pass over the source,
// so none opens inside a code span or a code block, which the parser has
// already set aside, and inline math gives way to a backtick or a `://`, which
// TeX has no use for and code spans and links do.
//
// A display block is a block of its own, like a code fence: `$$` or `\[` alone
// on a line (or `\[ … \]` filling one), its TeX the lines up to the matching
// closing line, so a line of TeX that starts with `-`, `+`, `1.` or `#` stays
// TeX instead of becoming a list or a heading. Unlike a code fence it needs its
// closing line, so a formula still streaming in is text until it is complete.
// In the middle of a sentence `\[` is the escaped bracket markdown always made
// it, and `\[1\]` on a line of its own is a citation.
//
// The typesetter is loaded on the first formula (`lib/math/typesetMath.ts`).
// Until it has loaded, and whenever a formula does not parse, the source shows
// as code, so nothing a reply says is ever lost to a failed render.

import { useEffect, useSyncExternalStore, type ReactNode } from 'react'
import { loadedTypesetter, loadTypesetter, onTypesetterLoaded, typesetMath } from '../lib/math/typesetMath'

// Reading the delimiters is shared with a chat's export, so it lives beside the
// conversation's other parsers.
export { remarkMathDelimiters } from '../../../shared/conversation/markdownMathSyntax'

// ---- Drawing it -------------------------------------------------------------

/** The typesetter once it has loaded; asks for it the first time it is wanted. */
function useTypesetter(wanted: boolean) {
  const engine = useSyncExternalStore(onTypesetterLoaded, loadedTypesetter, loadedTypesetter)
  useEffect(() => {
    if (wanted && !engine) loadTypesetter().catch(() => undefined)
  }, [wanted, engine])
  return engine
}

/** A formula's first line of complaint, for the note under its source. */
function mathError(message: string): string {
  return `Shown as source: ${message.split('\n', 1)[0].replace(/^KaTeX parse error:\s*/u, '')}`
}

/**
 * Inline math. The source shows as inline code while the typesetter loads,
 * and stays that way, with the reason on hover, when the formula does not
 * parse. The TeX rides on the element so a copied selection gets it back.
 * `dir` isolates it left to right inside a right-to-left line.
 */
export function InlineMath({
  tex: written,
  codeClassName,
  dir,
}: {
  tex: string
  codeClassName: string
  dir?: string
}): ReactNode {
  const tex = written.trim()
  const engine = useTypesetter(true)
  const result = engine ? typesetMath(engine, tex, false) : null
  if (!result || 'error' in result) {
    return (
      <code dir={dir} className={codeClassName} title={result ? mathError(result.error) : undefined}>
        {tex}
      </code>
    )
  }
  return <span data-math="inline" data-tex={tex} dir={dir} dangerouslySetInnerHTML={{ __html: result.html }} />
}

/**
 * A display formula. While its message streams it is the source, in the code
 * block it arrived in: a formula typed a token at a time parses, fails and
 * parses again, and would flicker between the two. Once settled it is drawn;
 * `fallback` is the block it falls back to, with a note saying why when the
 * formula does not parse.
 */
export function DisplayMath({
  tex: written,
  streaming,
  className,
  fallback,
}: {
  tex: string
  streaming: boolean
  className: string
  fallback: (note?: string) => ReactNode
}): ReactNode {
  const tex = written.trim()
  const engine = useTypesetter(!streaming)
  if (streaming || !engine) return fallback()
  const result = typesetMath(engine, tex, true)
  if ('error' in result) return fallback(mathError(result.error))
  // A formula is laid out left to right, in a right-to-left list item too.
  return (
    <div
      data-math="display"
      data-tex={tex}
      dir="ltr"
      className={className}
      dangerouslySetInnerHTML={{ __html: result.html }}
    />
  )
}

/**
 * The fence tag a display formula comes in: a `$$` or `\[` block is built as
 * one, and ```math asks for it outright. A ```latex, ```tex or ```katex fence
 * stays code: it is as often a document, or TeX someone is meant to copy, as a
 * formula, and a drawing would hide it behind one with nothing to copy.
 */
export function isMathLanguage(language: string | undefined): boolean {
  return (language ?? '').toLowerCase() === 'math'
}
