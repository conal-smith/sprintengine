import React, { type JSX } from 'react'

import type { PullRequestState } from '../../../../shared/git/pull-request'
import { FolderTypeIcon } from '../AppIcons'
import { PullRequestGlyph } from '../ui/PullRequestGlyph'
import { matchSegments } from './conversationSnippet'

/**
 * The query inside a line of text, marked: the matched letters in the
 * strongest ink at a heavier weight, the rest left to the line's own ink. No
 * fill behind it — a tinted box on every row of a result list is a column of
 * highlighter, and the line is already the quiet part of the row.
 */
export function HighlightedText({ text, query }: { text: string; query: string }): JSX.Element {
  return (
    <>
      {matchSegments(text, query).map((segment, index) =>
        segment.match ? (
          <mark key={index} className="bg-transparent font-semibold text-[color:var(--text-strong)]">
            {segment.text}
          </mark>
        ) : (
          <React.Fragment key={index}>{segment.text}</React.Fragment>
        ),
      )}
    </>
  )
}

/** The line under a chat's title: why it is in the results, when the title does not say. */
export type ConversationResultLine = {
  /** Who wrote the matching message — "You", "Agent" — when the line is one. */
  speaker?: string | null
  text: string
  /** How many more of the chat's messages matched than the one shown. */
  more?: number
}

/**
 * A chat in the palette, drawn the way the sidebar draws it: its title, its
 * project by name beside it (the folder glyph and the folder's name, never
 * the path), the pull request it holds as the quietest thing on the line, and
 * — when the title is not what matched — the sentence that did, with the
 * query marked in it.
 *
 * The leading mark is the caller's: the agent's mark in a list that mixes
 * chats with files and skills, nothing in the Conversations tab, where every
 * row is a chat and a glyph on each says nothing.
 */
export function ConversationResultRow({
  title,
  query,
  project,
  pullRequest,
  line,
  mark,
}: {
  title: string
  query: string
  project: string | null
  pullRequest: { number: number; state: PullRequestState } | null
  line: ConversationResultLine | null
  mark?: React.ReactNode
}): JSX.Element {
  return (
    <>
      {mark}
      <div className="min-w-0 flex-1">
        <div className="flex min-w-0 items-center gap-2">
          <span className="min-w-0 truncate text-heading">
            <HighlightedText text={title} query={query} />
          </span>
          {pullRequest ? (
            // What `#79` is: the number of the pull request the chat opened,
            // the one the sidebar's mark stands for. Kept because it is how a
            // chat is remembered after a review; drawn as the line's quietest
            // ink, with the sidebar's glyph so it reads as a pull request and
            // not as a count or an id of ours.
            <span
              aria-label={`Pull request ${pullRequest.number}`}
              className="flex shrink-0 items-center gap-0.5 text-micro tabular-nums text-[color:var(--text-disabled)]"
            >
              <PullRequestGlyph state={pullRequest.state} className="icon-xs" />
              {pullRequest.number}
            </span>
          ) : null}
          {project ? (
            <span className="flex min-w-0 items-center gap-1 text-micro text-[color:var(--text-subtle)]">
              <FolderTypeIcon className="icon-xs shrink-0" />
              <span className="min-w-0 truncate">{project}</span>
            </span>
          ) : null}
        </div>
        {line ? (
          <div className="mt-0.5 flex min-w-0 items-center gap-1 text-meta text-[color:var(--text-muted)]">
            {line.speaker ? <span className="shrink-0 text-[color:var(--text-subtle)]">{line.speaker}:</span> : null}
            <span className="min-w-0 truncate">
              <HighlightedText text={line.text} query={query} />
            </span>
            {line.more ? (
              <span className="ml-1 shrink-0 text-micro text-[color:var(--text-disabled)]">+{line.more} more</span>
            ) : null}
          </div>
        ) : null}
      </div>
    </>
  )
}
