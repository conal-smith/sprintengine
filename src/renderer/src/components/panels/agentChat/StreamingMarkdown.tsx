import { Fragment, memo, useRef } from 'react'
import { createMarkdownSplitter, createParagraphHold } from '../../../../../shared/conversation/markdownSegments'
import { markdownRootProps, renderMarkdown } from '../../../utils/markdown'

type MarkdownOptions = Parameters<typeof renderMarkdown>[1]

type SegmentProps = { source: string; options?: MarkdownOptions; frozen: boolean }
const MarkdownSegment = memo(
  function MarkdownSegment({ source, options, frozen }: SegmentProps) {
    return <>{renderMarkdown(source, { ...options, bare: true, streaming: frozen ? false : options?.streaming })}</>
  },
  (previous, next) => {
    if (previous.source !== next.source || previous.frozen !== next.frozen) return false
    const before = previous.options ?? {}
    const after = next.options ?? {}
    const keys = new Set([...Object.keys(before), ...Object.keys(after)])
    for (const key of keys) {
      if (key === 'streaming' && previous.frozen && next.frozen) continue
      if (before[key as keyof MarkdownOptions] !== after[key as keyof MarkdownOptions]) return false
    }
    return true
  },
)

// A streaming message as segments that parse apart: each token re-parses the
// last paragraph or block, not the whole reply, and the splitter reads only
// the text the token added.
//
// `hold` (Show replies: a paragraph at a time) draws the message only as far
// as its last finished block. The unfinished rest is neither drawn nor parsed:
// while a token finishes nothing, the held text is the same string as before,
// so the splitter reads nothing new and every segment's memo holds.
export function StreamingMarkdown({
  source,
  options,
  hold = false,
}: {
  source: string
  options?: MarkdownOptions
  hold?: boolean
}) {
  const splitter = useRef<ReturnType<typeof createMarkdownSplitter>>(null)
  const paragraphs = useRef<ReturnType<typeof createParagraphHold>>(null)
  splitter.current ??= createMarkdownSplitter()
  const shown = hold ? (paragraphs.current ??= createParagraphHold())(source) : source
  const { frozen, tail } = splitter.current(shown)
  const segments = tail ? [...frozen, tail] : frozen
  return (
    <div {...markdownRootProps(options)}>
      {segments.map((segment, index) => (
        <Fragment key={index}>
          {/* The newline a whole parse leaves between two blocks, so the joined
              segments are the same markup as the message parsed at once. It is
              whitespace between block boxes, so it never draws. */}
          {index > 0 ? '\n' : null}
          <MarkdownSegment source={segment} options={options} frozen={index < frozen.length} />
        </Fragment>
      ))}
    </div>
  )
}
