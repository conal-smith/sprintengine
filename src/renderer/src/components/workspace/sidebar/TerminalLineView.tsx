// One terminal's line in the sidebar.

import { type TerminalLine, changedFileMarks, diffScopeCopy } from '../terminalLines'
import React from 'react'
import { labelForCliRuntime } from '../newWorkspace/cliRuntimeOptions'
import type { AgentCli } from '../../../../../shared/electron-api'
import { formatRelativeMs, formatRelativeMsAgo } from '../../../utils/relativeTime'
import { shouldLookUpPullRequests, refreshPullRequestsForLine, PullRequestMark } from '../PullRequestMark'
import { Tooltip, LinkButton, StatusDot, WorkingMark } from '../../ui'
import CliIcon from '../../CliIcon'
import { RemoteMachineGlyph } from '../../AppIcons'
import { BranchChip, RowTooltip, WorkingElapsed } from './rowParts'
import { PromptCacheMark } from '../PromptCacheMark'
import { formatDiffCount } from '../../../utils/diffCount'

/**
 * One terminal's line under a row's title (sidebar-lists-every-terminal):
 * mark · branch · ±lines · seat. The row shows one per live terminal in
 * place of the head pile and the single row-level branch it used to carry:
 * the lines are the count, and each says where IT is — an agent in a
 * worktree of its own reads at full strength, with the path on hover.
 *
 * The terminal's NAME is not row text: it is the mark's tooltip and
 * accessible name, so the line spends its width on where the terminal is and
 * what it changed rather than on a name the row's title already implies.
 *
 * Truncation is an ordered give-way, not a fixed cap: the branch yields
 * (weight 3) down to its floor; the mark, the diff and the seat never
 * shrink. The line clips at the row's gutter rather than spilling past it.
 *
 * `seatOverlay` is the row's hover-revealed actions, handed to the first
 * line only; the seat's own content steps aside for it on hover, as the
 * row-level seat always did.
 */
export function TerminalLineView({
  line,
  now,
  seatOverlay,
  disambiguate = false,
  dim = false,
  rowOwnsStatus = false,
  onOpenDiff,
}: {
  line: TerminalLine
  now: number
  seatOverlay?: React.ReactNode
  /** More than one line on the row: a waiting line wears the warn dot so the gold surface says WHICH. */
  disambiguate?: boolean
  /** The row is background (`workspaceRowEmphasis`): the line recedes with it. */
  dim?: boolean
  /**
   * The ROW is saying the status somewhere else — the flat stream's project
   * line, where the clock and the working mark sit at the top-right of every
   * row (all-chats-view). The line then says nothing about time or work: one
   * terminal's dots beside the row's own dots is the same fact twice, six
   * pixels apart (owner, 2026-09-07).
   *
   * What survives is the disambiguation mark, and only on a row with more than
   * one line: a row wearing the gold wash still has to say WHICH of its
   * terminals is the one waiting, and the row's single seat cannot.
   */
  rowOwnsStatus?: boolean
  /**
   * Open this terminal's diff — its agent's changelist (agent changelists).
   * Absent for a line with no agent behind it (a shell, a remote pane, a
   * session main holds no agent record for), and then the ±count is the plain
   * reading it has always been rather than a control that does nothing.
   */
  onOpenDiff?: () => void
}) {
  const runtimeLabel = line.cli
    ? labelForCliRuntime(line.cli as AgentCli)
    : line.kind === 'remote'
      ? 'Remote terminal'
      : 'Terminal'
  // The mark carries the terminal's name (owner ruling 2026-09-05), the way
  // the machine glyph below carries its machine's: the name is worth a hover,
  // not a column of row text spending the line's width on a word the row's
  // title already implies. A shell, whose name IS its runtime, says it once.
  const markLabel = line.name && line.name !== runtimeLabel ? `${line.name} · ${runtimeLabel}` : runtimeLabel
  // FILES, not lines (owner decision 2026-09-09): green is what the checkout
  // gained or reworked, red what it lost, and the per-file line counts live
  // where a single file is in view — the conversation peek's rows and the diff
  // viewer. A line whose summary carries no breakdown (an older main, a span
  // git could not read, a remote row) has `files: null` and draws NOTHING; it
  // never falls back to the line counts, which are a different unit.
  const marks = line.files ? changedFileMarks(line.files) : null
  const hasDiff = marks !== null && (marks.plus > 0 || marks.minus > 0)
  // What the ± numbers may claim, from the line's scope: the words on hover, the
  // words for a screen reader, and whether they step back. The sentences live
  // beside the scope they belong to (terminalLines), not in this render.
  const diffCopy = diffScopeCopy(line)
  const idleText = line.idleSince !== null ? formatRelativeMs(line.idleSince, now) : ''
  return (
    <div
      // Which terminal this line is, for the row's conversation peek: hovering
      // one of the row's own heads moves the open card to that terminal
      // (mockup frame 9). An attribute rather than a callback threaded down
      // through every line, because the peek reads it from one delegated
      // listener on the row — the line itself stays a presentational thing that
      // knows nothing about a hover surface. Agent lines only: a shell has no
      // conversation, and a remote pane's key is a tab id, not a session.
      {...(line.kind === 'agent' ? { 'data-peek-session': line.key } : {})}
      // The hover hook for the branch lookup (epic decision 8a): pointing at an
      // agent line asks main about its branch. Coalesced inside
      // `refreshPullRequestsForLine` — at most one ask per session per BRANCH
      // per minute, not one per mouse event — and on `mouseenter`, which does
      // not re-fire as the pointer crosses the line's own children.
      //
      // A line that already wears a mark asks too: decision 9 has main re-read
      // a reading older than ~60s on hover, and the lines with a reading to
      // refresh are exactly the lines that have a mark.
      onMouseEnter={
        shouldLookUpPullRequests(line) ? () => refreshPullRequestsForLine(line.key, line.branch) : undefined
      }
      className={`flex h-5 min-w-0 items-center gap-2 overflow-hidden text-meta ${
        dim ? 'text-[color:var(--text-disabled)]' : 'text-[color:var(--text-subtle)]'
      }`}
    >
      <Tooltip content={markLabel} placement="bottom" wrapperClassName="flex shrink-0 items-center">
        <span
          role="img"
          aria-label={markLabel}
          // The provider mark in the tab strip's vocabulary; a plain shell wears
          // the prompt mark, drawn, not typed, so it never needs type below the
          // 11px floor; a remote pane with no CLI wears the machine glyph.
          className="flex size-icon-sm shrink-0 items-center justify-center rounded-full border border-[color:var(--border-subtle)] bg-[color:var(--bg-surface-raised)]"
        >
          {line.cli ? (
            <CliIcon cli={line.cli} className="icon-xs" />
          ) : line.kind === 'remote' ? (
            <RemoteMachineGlyph className="icon-xs text-[color:var(--text-muted)]" />
          ) : (
            <svg viewBox="0 0 10 10" fill="none" aria-hidden="true" className="icon-xs text-[color:var(--text-muted)]">
              <path
                d="M2 2.5L4.5 5L2 7.5"
                stroke="currentColor"
                strokeWidth="1.3"
                strokeLinecap="round"
                strokeLinejoin="round"
              />
              <path d="M5.8 8h2.6" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round" />
            </svg>
          )}
        </span>
      </Tooltip>
      {line.machineName ? (
        // The glyph alone (owner ruling 2026-09-05): the machine's full name
        // is the tooltip's, not the line's.
        <Tooltip content={`On ${line.machineName}`} placement="bottom" wrapperClassName="flex shrink-0 items-center">
          <span role="img" aria-label={`Remote: ${line.machineName}`} className="flex shrink-0 items-center">
            <RemoteMachineGlyph className="icon-xs shrink-0" />
          </span>
        </Tooltip>
      ) : null}
      {line.branch ? (
        <BranchChip branch={line.branch} worktree={line.worktree} cwd={line.cwd} dim={dim} />
      ) : line.removed ? (
        <Tooltip
          content={line.cwd ? `Directory removed — ${line.cwd}` : 'Directory removed'}
          wrapperClassName="flex shrink-0 items-center"
        >
          <span className="shrink-0 text-micro text-[color:var(--tone-error)]">Removed</span>
        </Tooltip>
      ) : null}
      {/* Immediately after the branch and before the ±lines, because it belongs
          to the branch: "this branch, this much changed, and here is where it
          went" (epic pull-request-marks, decision 4). It draws nothing at all
          when the conversation has no pull request, and the ±lines then slide
          left exactly as they always did — there is no "unknown" mark and no
          placeholder (decision 3). */}
      <PullRequestMark pullRequests={line.pullRequests} dim={dim} />
      {hasDiff ? (
        // Beside the branch, not at the far edge: the two are one fact —
        // "this branch, this much changed" — and the trailing seat is spoken
        // for by the status. Every reading here is the checkout's (owner
        // ruling 2026-09-09): the branch's span, or what the checkout still
        // carries once that branch has landed. The words on hover and the
        // spoken label are what say which of those you are reading, and the
        // kit's Tooltip, not a native title, carries them.
        <RowTooltip content={diffCopy.tooltip} wrapperClassName="inline-flex shrink-0">
          {/* Only a folder reading dims (see diffScopeCopy): a `branch` or
              `worktree` reading IS attributable work — to the branch rather
              than to this terminal alone — and a `landed` reading is what this
              checkout still carries after its pull request merged, so both
              draw at full strength.

              Where there is an agent behind the line the numbers are a
              CONTROL — the shortest path from "this agent touched 5 files" to
              seeing which — and the kit's link button is what carries the focus
              ring and the hit target for it. Where there is not, the same
              drawing stays a reading. */}
          {onOpenDiff ? (
            <LinkButton
              layout="row"
              underline="never"
              size="inherit"
              ink="quiet"
              aria-label={`Open this agent\u2019s diff. ${diffCopy.srText}`}
              className={`shrink-0 font-mono text-micro tabular-nums ${diffCopy.dim ? 'opacity-60' : ''}`}
              onClick={(event) => {
                event.stopPropagation()
                onOpenDiff()
              }}
            >
              <span className="text-[color:var(--tone-good)]">+{formatDiffCount(marks?.plus ?? 0)}</span>
              <span className="ml-1 text-[color:var(--tone-error)]">−{formatDiffCount(marks?.minus ?? 0)}</span>
            </LinkButton>
          ) : (
            <span className={`shrink-0 font-mono text-micro tabular-nums ${diffCopy.dim ? 'opacity-60' : ''}`}>
              <span className="text-[color:var(--tone-good)]">+{formatDiffCount(marks?.plus ?? 0)}</span>
              <span className="ml-1 text-[color:var(--tone-error)]">−{formatDiffCount(marks?.minus ?? 0)}</span>
              <span className="sr-only">{diffCopy.srText}</span>
            </span>
          )}
        </RowTooltip>
      ) : null}
      {/* A chat's words, where a local chat's line puts them: after its
          marks, taking the width the seat leaves. */}
      {line.text ? <span className="min-w-0 flex-1 truncate">{line.text}</span> : null}
      {/* The line's own seat: working mark + how long, the failure dot, a
          waiting mark when the row needs to say which line, else how long it
          has sat idle. The seat's min-w is what the row's revealed actions
          reserve (list-row's `data-actions` rule), so revealing never reflows. */}
      <span className="relative ml-auto flex h-5 min-w-[44px] shrink-0 items-center justify-end pl-2">
        <span
          className={`inline-flex items-center gap-1 ${
            seatOverlay
              ? 'transition-opacity group-hover:opacity-0 group-focus-within:opacity-0 group-data-[settle-flourish]:opacity-0'
              : ''
          }`}
        >
          {rowOwnsStatus ? (
            // The row's own seat has said it. All that is left for the line is
            // the mark that says which terminal is waiting, on a row that has
            // more than one — and the words, always. And the prompt cache about
            // to go cold, which is this line's alone: the row's seat says when,
            // not what it will cost.
            line.needsInput ? (
              disambiguate ? (
                <StatusDot tone="warn" pulse label="Needs your input" />
              ) : (
                <span className="sr-only">Needs your input</span>
              )
            ) : (
              <PromptCacheMark reading={line.promptCache} working={line.working} includeCold={false} />
            )
          ) : line.working ? (
            <>
              <WorkingMark label="Agent working" seed={line.key} />
              {line.workingSince !== null ? <WorkingElapsed since={line.workingSince} /> : null}
            </>
          ) : line.failed ? (
            <StatusDot tone="error" label="Agent failed" />
          ) : line.needsInput ? (
            disambiguate ? (
              <StatusDot tone="warn" pulse label="Needs your input" />
            ) : (
              // The row's gold surface is the mark; a dot beside it would say
              // the same thing twice (status-dot's reject-on-sight).
              <span className="sr-only">Needs your input</span>
            )
          ) : idleText ? (
            <>
              {/* Before the idle time: the cache about to go cold is the one
                  thing on this seat that will not wait. A cache already gone
                  is not marked here — on every old chat in the list it would
                  be decoration — but the card says so. */}
              <PromptCacheMark reading={line.promptCache} working={false} includeCold={false} />
              <RowTooltip
                content={`${line.idleLabel} ${formatRelativeMsAgo(line.idleSince!, now)} (${new Date(line.idleSince!).toLocaleString()})`}
              >
                <span className="text-meta tabular-nums text-[color:var(--text-subtle)]">
                  <span aria-hidden="true">{idleText}</span>
                  <span className="sr-only">
                    {line.idleLabel} {formatRelativeMsAgo(line.idleSince!, now)}
                  </span>
                </span>
              </RowTooltip>
            </>
          ) : null}
        </span>
        {seatOverlay}
      </span>
    </div>
  )
}
