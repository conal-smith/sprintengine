import React, { type JSX } from 'react'

import { PullRequestGlyph, SplitButton, Tooltip, IconButton, type SplitButtonItem } from '../ui'
import { formatRelativeMs, relativeFromNow } from '../../utils/relativeTime'
import { openUrlInPane } from './pane/browser/openInPane'
import {
  earlierPullRequests,
  groupPullRequests,
  primaryPullRequest,
  pullRequestOpenLabel,
  pullRequestStateLabel,
  pullRequestTone,
  PULL_REQUEST_TONE_VAR,
  type BranchPullRequest,
} from '../../../../shared/git/pull-request'
import {
  pullRequestWatchIsTrouble,
  pullRequestWatchSentence,
  pullRequestWatchWords,
} from '../../../../shared/git/pull-request-watch'

// The pull request mark a conversation wears, in the two places it is drawn:
// the sidebar's agent line and the conversation peek's head line (epic
// `pull-request-marks`, decisions 4–7; mockup
// `backlog/mockups/2026-09-09-pull-request-marks.html`, frames 2–4).
//
// ONE module for both, because the two surfaces have to agree about four things
// a reader would otherwise catch them disagreeing on: which pull request the
// mark is (`primaryPullRequest` — the most recent one still open, else the
// newest of all), what colour the state inks in (`pullRequestTone`), what the
// hover says, and what a screen reader is told. The tooltips READ differently —
// the line has no room for the pull request's title and the card has nothing
// else to say about it — but the words come from here either way, so the two
// cannot drift.
//
// NOTHING IS DRAWN FOR AN EMPTY LIST (decision 3). There is no "unknown" mark
// and no placeholder: a conversation that opened no pull request, and a record
// that has not been read yet, draw exactly what a plain terminal draws.
//
// Colour is a reinforcement, never the message: every state has its own shape
// (`PullRequestGlyph`) and every tooltip and accessible name says the state in
// words, so the mark survives grayscale and a screen reader.

/**
 * What a mark says, in the three registers the design asks for: the tooltip's
 * bolder first line, the lines under it, and the same content spoken.
 *
 * Strings, not nodes, so the wording is testable without a DOM — which is the
 * only way to hold a tooltip that is portalled on hover and therefore invisible
 * to the static-markup harness the sidebar and card suites use.
 */
export type PullRequestCopy = {
  title: string
  lines: string[]
  ariaLabel: string
}

/**
 * More than one repository in the list (epic decision 10). An agent can open a
 * pull request in another repository than its own, so a conversation's marks
 * are not always all in one repo — and
 * when they are not, every LINE of a tooltip and every menu row has to say
 * which repository it is talking about. When they are, naming the repo on every
 * line would be noise on the case that is almost always true.
 *
 * The mark itself never names a repository at any time: it is one glyph.
 */
export function pullRequestsSpanRepositories(list: readonly BranchPullRequest[]): boolean {
  return new Set(list.map((pr) => pr.repoKey)).size > 1
}

/** "#418", or "sprintengine-website #12" once the list spans repositories. */
function writtenNumber(pr: BranchPullRequest, spans: boolean): string {
  return spans ? `${pr.repoName} #${pr.number}` : `#${pr.number}`
}

/**
 * The same identity spoken. A screen reader gets "pull request 418", never
 * "hash four one eight", and the repository is named with a preposition rather
 * than with the middle dot the visible line uses — a spoken label is a
 * sentence, and the visible line is a label.
 */
function spokenNumber(pr: BranchPullRequest, spans: boolean): string {
  return spans ? `Pull request ${pr.number} in ${pr.repoName}` : `Pull request ${pr.number}`
}

/**
 * The pull request Studio is watching for this list's conversation, if any:
 * an open one on GitHub its agent asked to have watched. What makes a chat
 * read as working between its turns, and what its words are about.
 */
export function watchedPullRequest(list: readonly BranchPullRequest[]): BranchPullRequest | null {
  return list.find((pr) => pr.watch && pr.state === 'open' && !pr.forge) ?? null
}

/** A watched pull request's tooltip line: the short words, then what they mean. */
function watchLines(pr: BranchPullRequest): string[] {
  if (!pr.watch || pr.state !== 'open') return []
  return [`${pullRequestWatchWords(pr.watch)}. ${pullRequestWatchSentence(pr.watch)}`]
}

/**
 * The sidebar line's mark (mockup frame 4): the number and the state, then what
 * clicking does, then one line per earlier pull request — newest first, never
 * dropped, because the line has no chevron and this tooltip is the only place
 * the rest of the record is visible from the sidebar (decision 6).
 *
 * Null when there is no pull request, which is the caller's signal to draw
 * nothing at all.
 */
export function sidebarMarkCopy(list: readonly BranchPullRequest[]): PullRequestCopy | null {
  const primary = primaryPullRequest(list)
  if (!primary) return null
  const spans = pullRequestsSpanRepositories(list)
  const earlier = earlierPullRequests(list)
  const stateOf = (pr: BranchPullRequest) => pullRequestStateLabel(pr)
  return {
    title: spans
      ? `${writtenNumber(primary, spans)} · ${stateOf(primary)}`
      : `Pull request ${writtenNumber(primary, spans)} ${stateOf(primary)}`,
    lines: [
      ...watchLines(primary),
      pullRequestOpenLabel(primary),
      ...earlier.map((pr) =>
        spans
          ? `Earlier: ${writtenNumber(pr, spans)} · ${stateOf(pr)}`
          : `Earlier: ${writtenNumber(pr, spans)} ${stateOf(pr)}`,
      ),
    ],
    // The spoken name carries the state and the earlier pull requests too: the
    // tooltip is portalled on hover and a person who cannot summon it must lose
    // nothing (design-system/components/tooltip → Accessibility).
    ariaLabel: [
      `${spokenNumber(primary, spans)}, ${stateOf(primary)}.`,
      ...watchLines(primary),
      ...earlier.map((pr) => `Earlier: ${spokenNumber(pr, spans).toLowerCase()}, ${stateOf(pr)}.`),
      pullRequestOpenLabel(primary),
    ].join(' '),
  }
}

/**
 * The peek head's mark (mockup frame 3). The card has room the line does not,
 * so the pull request's own TITLE leads and the identity line carries the
 * number, the state and how long ago it was opened.
 */
export function peekMarkCopy(list: readonly BranchPullRequest[], now: number): PullRequestCopy | null {
  const primary = primaryPullRequest(list)
  if (!primary) return null
  const spans = pullRequestsSpanRepositories(list)
  const state = pullRequestStateLabel(primary)
  // A paired machine's list carries no opening time (read as 0), and an age
  // counted from 1970 is worse than none.
  const opened = primary.openedAt > 0 ? relativeFromNow(primary.openedAt, now) : ''
  const identity = spans ? writtenNumber(primary, spans) : `Pull request ${writtenNumber(primary, spans)}`
  // A pull request recorded from its URL alone has no title until GitHub
  // answers — and never gets one if `gh` cannot reach it, or it is on
  // another forge. Untitled, the identity moves up
  // into the title line, because a bold empty line over "Pull request #418 ·
  // open · 12 minutes ago" is a tooltip whose first line is missing, and a
  // spoken "Pull request 418, open: . Open it on GitHub" is a sentence with a
  // hole in it. The number is a name; the title is an elaboration of it, and an
  // elaboration that is not there is simply left out.
  const titled = primary.title.trim().length > 0
  return {
    title: titled ? primary.title : identity,
    lines: [
      // Identity only ONCE: it is the title line above when there is no title,
      // and this line then carries what is left to say about it.
      (titled ? [identity, state, opened] : [state, opened]).filter((part) => part.length > 0).join(' · '),
      ...watchLines(primary),
      pullRequestOpenLabel(primary),
    ],
    ariaLabel: [
      titled
        ? `${spokenNumber(primary, spans)}, ${state}: ${primary.title}.`
        : `${spokenNumber(primary, spans)}, ${state}.`,
      ...watchLines(primary),
      pullRequestOpenLabel(primary),
    ].join(' '),
  }
}

/** One row of the peek's menu — everything it draws and everything it says. */
export type PullRequestMenuRow = {
  url: string
  /** "#409", or "sprintengine-website #12" when the conversation spans repositories. */
  number: string
  title: string
  /** The terse age in the hint slot ("1d"); empty under a minute, and then omitted. */
  age: string
  state: BranchPullRequest['state']
  ariaLabel: string
}

/** A group of the peek's menu: the label with its count, and its rows. */
export type PullRequestMenuGroup = {
  id: 'open' | 'merged' | 'closed'
  label: string
  rows: PullRequestMenuRow[]
}

/**
 * The menu behind the chevron (decision 6): every pull request the conversation
 * has made, grouped Open / Merged / Closed, newest first within each, with the
 * empty groups omitted rather than shown as a heading over nothing.
 *
 * The grouping and the ordering are the shared module's (`groupPullRequests`),
 * so this cannot disagree with the mark about which one is newest.
 */
export function pullRequestMenuGroups(list: readonly BranchPullRequest[], now: number): PullRequestMenuGroup[] {
  const spans = pullRequestsSpanRepositories(list)
  const grouped = groupPullRequests(list)
  const rowOf = (pr: BranchPullRequest): PullRequestMenuRow => {
    // Same rule as the tooltip above: a captured pull request has no title
    // until GitHub answers, and the row is then the number alone rather than a
    // number followed by a gap. Spoken, the colon clause goes with it.
    const titled = pr.title.trim().length > 0
    return {
      url: pr.url,
      number: writtenNumber(pr, spans),
      title: titled ? pr.title : '',
      age: pr.openedAt > 0 ? formatRelativeMs(pr.openedAt, now) : '',
      state: pr.state,
      ariaLabel: titled
        ? `${spokenNumber(pr, spans)}, ${pullRequestStateLabel(pr)}: ${pr.title}. ${pullRequestOpenLabel(pr)}`
        : `${spokenNumber(pr, spans)}, ${pullRequestStateLabel(pr)}. ${pullRequestOpenLabel(pr)}`,
    }
  }
  return (
    [
      { id: 'open', label: 'Open', rows: grouped.open },
      { id: 'merged', label: 'Merged', rows: grouped.merged },
      { id: 'closed', label: 'Closed', rows: grouped.closed },
    ] as const
  )
    .filter((group) => group.rows.length > 0)
    .map((group) => ({
      id: group.id,
      label: `${group.label} · ${group.rows.length}`,
      rows: group.rows.map(rowOf),
    }))
}

/**
 * How long an ask holds before the same conversation may be asked about again.
 *
 * Matched to the record's own "re-read a reading older than ~60s on hover"
 * (epic decision 9): this side must not be the thing that makes that
 * unreachable. It is a FLOOR on how often this window asks, not a schedule —
 * nothing here polls, and an ask only happens under a pointer.
 */
const LOOKUP_ASK_TTL_MS = 60_000

/**
 * When this window last asked main about a conversation, keyed by session AND
 * branch.
 *
 * It was a permanent one-shot `Set` of session ids, and that burned the only
 * ask the app would ever make before main could act on it. Three ways, all of
 * them the common case:
 *
 * - the key was the session alone, while the ask is really about a BRANCH. A
 *   line's branch is filled from the launch intent long before the observed
 *   checkout resolves, and main only acts once it has resolved — so the very
 *   first hover, in the first second of a chat, spent the one ask on a question
 *   main could not answer, and no later hover asked again.
 * - a `gh` read that never settled (no auth, no network, a repo `gh` cannot
 *   see) was also never re-asked.
 * - and the branch CHANGING — the agent moving to its worktree, a rebase onto a
 *   new branch — asked nothing, because the session id had not changed.
 *
 * Keyed by session + branch with a TTL, all three re-ask on the next hover.
 * There is no timer and no poll: entries are written by hovers and read by
 * hovers, so a window nobody is pointing at asks nothing at all.
 */
const askedAt = new Map<string, number>()

function askKey(sessionId: string, branch: string | null): string {
  // A newline, which no branch name and no session id can contain, so
  // "a" + "b/c" and "a\nb" + "c" cannot collide.
  return `${sessionId}\n${branch ?? ''}`
}

/**
 * Whether pointing at this line should ask main to re-read its pull requests
 * (epic decision 8a):
 *
 * - an AGENT line, because a shell has no conversation and a remote pane's
 *   checkout is on another machine's disk;
 * - with a BRANCH, because main only answers for an agent once git has said
 *   where it is.
 *
 * A line that already WEARS a mark asks too, which it used to be barred from.
 * The bar made decision 9's "refresh on hover when the reading is older than
 * ~60s" unreachable — the only lines with a reading to refresh were exactly the
 * lines this refused to ask about — and it is not what keeps this from becoming
 * a poller: the TTL above does, and the server holds each read behind its own
 * hold and coalesces the refreshes it accepts.
 */
export function shouldLookUpPullRequests(line: { kind: 'agent' | 'shell' | 'remote'; branch: string | null }): boolean {
  return line.kind === 'agent' && line.branch !== null
}

/**
 * Ask main to re-read this conversation's pull requests — the ONE path both
 * anchors use, so the sidebar line and the agent tab cannot ask at two
 * different rates or key their coalescing two different ways.
 *
 * `now` is a test seam. Callers are event handlers and pass nothing.
 */
export function refreshPullRequestsForLine(sessionId: string, branch: string | null, now: number = Date.now()): void {
  if (!sessionId) return
  const key = askKey(sessionId, branch)
  const last = askedAt.get(key)
  if (last !== undefined && now - last < LOOKUP_ASK_TTL_MS) return
  // Recorded BEFORE the call, not in its `then`: a mousemove storm is
  // synchronous and would otherwise fire an IPC per event while the first
  // promise was still in flight.
  askedAt.set(key, now)
  const answer = window.api?.refreshPullRequestsForSession?.(sessionId)
  void Promise.resolve(answer).then(
    (accepted) => {
      // Main answers whether there was anything to ask about — false for a
      // session it cannot name, or one whose observed checkout has not resolved
      // yet. A question that was never put is not an ask, so it does not spend
      // the minute; the next hover, by which time the checkout may have
      // resolved, puts it again. (`undefined` is an older preload that answered
      // nothing, and is read as an ask that was taken.)
      if (accepted === false) askedAt.delete(key)
    },
    // A rejected call reached nobody. Forget it, or a main process that was
    // restarting during the hover would cost this window a silent minute.
    () => askedAt.delete(key),
  )
}

/** Test seam: forget what has been asked, so a case can assert the coalescing. */
export function resetPullRequestRefreshes(): void {
  askedAt.clear()
}

function openPullRequest(url: string): void {
  void window.api?.openExternal?.(url)
}

function withPaneHint(copy: PullRequestCopy): PullRequestCopy {
  const hint = `Opens in the browser pane; ${window.api?.platform === 'darwin' ? '⌘' : 'Ctrl'}-click opens your browser.`
  return { ...copy, lines: [...copy.lines, hint], ariaLabel: `${copy.ariaLabel} ${hint}` }
}

/**
 * A click on a row's mark: the pull request in the chat's own browser pane,
 * beside the conversation that opened it, or with Cmd (Ctrl elsewhere) held
 * in the system browser, as a link's modified click opens outside. A pane
 * that cannot take it (the tab cap) hands it to the system browser too. True
 * when it went to the pane.
 */
export function openPullRequestFromMark(
  url: string,
  workspaceId: string | undefined,
  modifiers: { metaKey: boolean; ctrlKey: boolean },
  openInPane: (workspaceId: string, url: string) => boolean = openUrlInPane,
): boolean {
  const outside = modifiers.metaKey || modifiers.ctrlKey
  if (!outside && workspaceId && openInPane(workspaceId, url)) return true
  openPullRequest(url)
  return false
}

/**
 * The tooltip body: the identifier in the title's weight, then the description
 * (design-system/components/tooltip → Anatomy). Block spans rather than a
 * newline-joined string, so the first line can carry the title treatment.
 */
function MarkTooltip({ copy }: { copy: PullRequestCopy }) {
  return (
    <>
      <span className="block font-medium text-[color:var(--text-strong)]">{copy.title}</span>
      {copy.lines.map((line) => (
        <span key={line} className="block">
          {line}
        </span>
      ))}
    </>
  )
}

/**
 * The SIDEBAR line's mark — right after the branch chip and before the ±lines,
 * because it belongs to the branch: "this branch, this much changed, and here
 * is where it went."
 *
 * The glyph is `icon-xs` and the control around it is the kit's smallest icon
 * step, whose transparent overlay pads a 16px drawing out to the 24px hit floor
 * without growing the 20px line it sits on. It is a real control and not an
 * anchor: a click opens the pull request in the chat's browser pane, and a
 * Cmd/Ctrl-click hands the URL to the app's one external-open path
 * (`openPullRequestFromMark`).
 *
 * The ink is the state's tone, inline from the shared map — the idiom every
 * other tone-driven mark in the app already uses (`StatusDot`) — so no per-state class literal exists here to fall out of step
 * with the map. Inline also outranks the kit's own ink at every state, which is
 * what keeps a merged mark violet under the pointer instead of reverting to the
 * button's neutral hover ink.
 */
export function PullRequestMark({
  pullRequests,
  dim = false,
  workspaceId,
}: {
  pullRequests: readonly BranchPullRequest[]
  /** The row is background: the mark recedes with the rest of its line. */
  dim?: boolean
  /**
   * The chat whose browser pane a click opens the pull request in; absent, a
   * click opens the system browser (a paired machine's row, which has no pane here).
   */
  workspaceId?: string
}): JSX.Element | null {
  // Open asks for you and merged says it went in; a pull request closed
  // unmerged says neither, so the row does not wear it (owner, 2026-10-02).
  // The peek's menu still lists it.
  const shown = pullRequests.filter((pr) => pr.state !== 'closed')
  const primary = primaryPullRequest(shown)
  const listed = sidebarMarkCopy(shown)
  if (!primary || !listed) return null
  // Into the pane by default, so the tooltip says how to reach the system browser.
  const copy = workspaceId ? withPaneHint(listed) : listed
  return (
    <Tooltip content={<MarkTooltip copy={copy} />} multiline wrapperClassName="flex shrink-0 items-center">
      <IconButton
        size="3xs"
        aria-label={copy.ariaLabel}
        data-pull-request-mark={primary.url}
        className={`shrink-0 ${dim ? 'opacity-60' : ''}`}
        style={{ color: PULL_REQUEST_TONE_VAR[pullRequestTone(primary.state)] }}
        onClick={(event) => {
          // Into the pane, the click goes on to the row, which selects the
          // chat so the pane it opened in is the one in front. Outside, the
          // row underneath must not take it: opening the pull request would
          // also select the chat.
          const inPane = openPullRequestFromMark(primary.url, workspaceId, event)
          if (!inPane) event.stopPropagation()
        }}
      >
        <PullRequestGlyph state={primary.state} className="icon-xs" />
      </IconButton>
    </Tooltip>
  )
}

/**
 * What a watched pull request waits on, in words, beside its mark on a
 * sidebar line: "Watching · checks running", "Check failed", "Behind main".
 * Words and not a dot (owner ruling 2026-09-28); the danger ink only agrees
 * with words that already say something went wrong. Nothing is drawn while
 * nothing is watched.
 */
export function PullRequestWatchWords({
  pullRequests,
  dim = false,
}: {
  pullRequests: readonly BranchPullRequest[]
  dim?: boolean
}): JSX.Element | null {
  const watched = watchedPullRequest(pullRequests)
  if (!watched?.watch) return null
  const trouble = pullRequestWatchIsTrouble(watched.watch)
  return (
    <span
      data-pull-request-watch={watched.watch.waitingOn}
      className={`min-w-0 flex-1 truncate ${
        dim
          ? 'text-[color:var(--text-disabled)]'
          : trouble
            ? 'text-[color:var(--tone-error)]'
            : 'text-[color:var(--text-subtle)]'
      }`}
    >
      {pullRequestWatchWords(watched.watch)}
    </span>
  )
}

/**
 * The PROJECT's mark: how many pull requests are open across a project's
 * conversations (owner, 2026-09-10).
 *
 * The complaint it answers is the one the row marks could not: an agent that
 * has finished leaves the sidebar, and with it any sign that its pull request is
 * still sitting open. "So it just gives a quick summary of all of the open pull
 * requests that are in a workspace."
 *
 * OPEN ONLY, and this is the difference between this mark and the row's. A
 * conversation's own mark is a RECORD — it keeps a merged pull request, because
 * that is the history of that chat. A project's is a to-do: merged and closed
 * ones have nothing left to do and counting them would make the number grow for
 * ever and mean less every week.
 *
 * A number, not one glyph per pull request. The project line is the row's
 * filing, not a place to enumerate; the count says how many and the
 * conversations underneath say which.
 *
 * Nothing at all is drawn for zero — the same rule the row mark keeps
 * (decision 3). There is no "no pull requests here" state, because a project
 * with none should look exactly like a project in a tree with no GitHub at all.
 *
 * Not a button. A row mark opens its one pull request; a count of three has no
 * single thing to open, and a control that swallowed the click on a folder
 * header would cost that header its own job.
 */
export function ProjectPullRequestMark({
  openCount,
  projectName,
  dim = false,
}: {
  openCount: number
  /** Named in the tooltip and the spoken label: "croissant — 2 pull requests open". */
  projectName: string
  dim?: boolean
}): JSX.Element | null {
  if (openCount <= 0) return null
  const words = `${openCount} pull request${openCount === 1 ? '' : 's'} open`
  return (
    <Tooltip content={`${projectName} — ${words}`} wrapperClassName="flex shrink-0 items-center">
      <span
        role="img"
        aria-label={`${projectName}, ${words}`}
        className={`inline-flex shrink-0 items-center gap-0.5 font-mono text-micro tabular-nums ${
          dim ? 'opacity-60' : ''
        }`}
        // The open tone, because every one of them is open — the mark and the
        // number are saying one thing.
        style={{ color: PULL_REQUEST_TONE_VAR[pullRequestTone('open')] }}
      >
        <PullRequestGlyph state="open" className="icon-xs" />
        {openCount}
      </span>
    </Tooltip>
  )
}

/**
 * How many pull requests are still open across these lists, each counted
 * once: two chats that worked on one branch both wear its pull request, and
 * the project has one thing to do about it, not two.
 */
export function openPullRequestCount(...lists: ReadonlyArray<readonly BranchPullRequest[]>): number {
  const open = new Set<string>()
  for (const list of lists) for (const pr of list) if (pr.state === 'open') open.add(pr.url)
  return open.size
}

/** The mark's own drawing on the peek: the glyph and the number, in the tone. */
function PeekMarkFace({ pr }: { pr: BranchPullRequest }) {
  return (
    <span
      className="inline-flex items-center gap-1 font-mono text-micro tabular-nums"
      style={{ color: PULL_REQUEST_TONE_VAR[pullRequestTone(pr.state)] }}
    >
      <PullRequestGlyph state={pr.state} className="icon-xs" />#{pr.number}
    </span>
  )
}

/**
 * The CONVERSATION PEEK's mark — on the card's head line, right of the context
 * ring and left of the live corner (mockup frame 3).
 *
 * One pull request is a link: the glyph, the number, and a tooltip carrying the
 * pull request's title. Two or more grow the split control — the same mark on
 * the primary half, and a chevron opening the whole record, grouped by state.
 * Choosing a row opens it and does NOT re-point the primary, which is the one
 * place this deliberately departs from the split button's own usage note: the
 * primary here is a RULE (the most recent open one, decision 5), not a memory
 * of what you last picked, so it moves when GitHub moves and never because of a
 * click.
 *
 * Clicks are already sealed by the card's shell (`PointerPopover` stops click,
 * mousedown and keydown at its surface, because a portal is still a React child
 * of its opener), and the link stops its own as well so the mark is correct
 * wherever the card is hosted.
 */
export function PullRequestPeekMark({
  pullRequests,
  now,
}: {
  pullRequests: readonly BranchPullRequest[]
  now: number
}): JSX.Element | null {
  const primary = primaryPullRequest(pullRequests)
  const copy = peekMarkCopy(pullRequests, now)
  if (!primary || !copy) return null
  const items = pullRequestMenuItems(pullRequests, now)
  return (
    <Tooltip
      content={<MarkTooltip copy={copy} />}
      multiline
      // The card is a menu-tier surface, so a tooltip opened from inside it at
      // the default tier paints UNDER the card the moment the card is near a
      // viewport edge and the tooltip flips back onto it.
      layer="menu"
      wrapperClassName="flex shrink-0 items-center"
    >
      {/* A plain wrapper, because `Tooltip` wires its handlers onto the element
          it is given and `SplitButton` takes a closed set of props: handed them
          directly they would be dropped and the tooltip would never open. The
          hover and the focus both still reach this span — focus events bubble.

          `Tooltip` also clones its child with `aria-describedby`, which lands on
          THIS span and is therefore never announced. That is deliberate and
          costs nothing: `primaryAriaLabel` below is the whole of what the
          tooltip says (`copy.ariaLabel` — the same number, the same state word,
          the same title, the same "Open it on GitHub"), so a description
          pointing at those words as well would only make a screen reader say
          them twice. The tooltip is the POINTER's copy of a label the control
          already carries. */}
      <span className="flex items-center">
        <SplitButton
          quiet
          layer="menu"
          label={<PeekMarkFace pr={primary} />}
          primaryAriaLabel={copy.ariaLabel}
          // On the primary half, which is the control, exactly as the sidebar
          // mark's marker is on its button. One pull request or several, the
          // mark is found the same way and pressed in the same place.
          primaryData={{ name: 'data-pull-request-mark', value: primary.url }}
          menuAriaLabel={`All pull requests from this conversation, ${pullRequests.length}`}
          // One target draws the primary half alone — the group's own chrome,
          // the 24px hit floor, the hover fill, and no chevron over a menu with
          // one row in it (`SplitButton`'s own rule). The solo arm used to be a
          // text link here, which made the same mark a ~15px target with one
          // pull request and a 24px one with two.
          items={items}
          onPrimary={() => openPullRequest(primary.url)}
        />
      </span>
    </Tooltip>
  )
}

/** The record behind a split control's chevron, grouped Open / Merged / Closed; choosing a row opens it. */
function pullRequestMenuItems(pullRequests: readonly BranchPullRequest[], now: number): SplitButtonItem[] {
  return pullRequestMenuGroups(pullRequests, now).flatMap((group) =>
    group.rows.map((row) => ({
      id: row.url,
      group: group.label,
      label: (
        <>
          <span className="mr-1.5 font-mono tabular-nums">{row.number}</span>
          {row.title}
        </>
      ),
      ariaLabel: row.ariaLabel,
      icon: (
        <span style={{ color: PULL_REQUEST_TONE_VAR[pullRequestTone(row.state)] }}>
          <PullRequestGlyph state={row.state} className="icon-xs" />
        </span>
      ),
      hint: row.age || undefined,
      onSelect: () => openPullRequest(row.url),
    })),
  )
}

/**
 * What the open chat's composer strip says about the pull requests its
 * conversation opened (owner ruling 2026-10-04): the words on the button, and
 * the pull request they are about. Null draws nothing.
 *
 * The pull request is the mark's own (`primaryPullRequest`: the newest still
 * open, else the newest of all), so the strip, the sidebar row and the peek
 * never disagree about which one it is. A pull request closed without merging
 * is left off, as the sidebar row leaves it off (owner, 2026-10-02); the menu
 * still lists it. The state is in the words, not only the colour:
 *
 * - open: "Open PR #123"; a draft: "Open draft PR #123";
 * - watched (its agent asked Studio to babysit it): what it waits on,
 *   "PR #123 · Checks failed", "PR #123 · Approved · merging when green";
 * - merged: "Merged PR #123";
 * - on a forge whose state is not read: "Opened PR #5".
 */
export function stripPullRequestCopy(
  list: readonly BranchPullRequest[],
  now: number,
): { pr: BranchPullRequest; text: string; tooltip: PullRequestCopy } | null {
  const shown = list.filter((pr) => pr.state !== 'closed')
  const pr = primaryPullRequest(shown)
  const tooltip = peekMarkCopy(shown, now)
  if (!pr || !tooltip) return null
  const number = pullRequestsSpanRepositories(shown) ? `${pr.repoName} #${pr.number}` : `#${pr.number}`
  const text = pr.forge
    ? `Opened PR ${number}`
    : pr.state === 'merged'
      ? `Merged PR ${number}`
      : pr.watch
        ? `PR ${number} · ${pullRequestWatchWords(pr.watch)}`
        : pr.isDraft
          ? `Open draft PR ${number}`
          : `Open PR ${number}`
  return { pr, text, tooltip }
}

/**
 * The open chat's "Open PR" button, at the bottom of the conversation on the
 * composer's strip (owner ruling 2026-10-04). Nothing is drawn when the
 * conversation opened no pull request (decision 3).
 *
 * The same split control the peek wears: the button opens the pull request in
 * the browser, through the app's one external-open path, and with more than
 * one a chevron opens the whole record, grouped by state. Its words say the
 * state; the glyph and its tone agree with them.
 */
export function PullRequestStripButton({
  pullRequests,
  now,
  onStopWatching,
}: {
  pullRequests: readonly BranchPullRequest[]
  now: number
  /**
   * Stop Studio watching a pull request for this conversation. Absent where
   * the window cannot (a chat on a paired machine): no Stop watching is offered.
   */
  onStopWatching?: (url: string) => void
}): JSX.Element | null {
  const copy = stripPullRequestCopy(pullRequests, now)
  if (!copy) return null
  const { pr, text, tooltip } = copy
  const watching = pr.watch && pr.state === 'open' && onStopWatching ? pr : null
  const trouble = watching?.watch ? pullRequestWatchIsTrouble(watching.watch) : false
  const items = pullRequestMenuItems(pullRequests, now)
  // Stopping the watch sits behind the same chevron as the record, under its
  // own heading, so the button keeps opening the pull request: the thing a
  // person most often wants from it.
  if (watching)
    items.push({
      id: 'stop-watching',
      group: 'Studio is watching',
      label: `Stop watching #${watching.number}`,
      ariaLabel: `Stop watching pull request ${watching.number}`,
      onSelect: () => onStopWatching?.(watching.url),
    })
  return (
    <Tooltip content={<MarkTooltip copy={tooltip} />} multiline placement="top" wrapperClassName="flex shrink-0">
      {/* A plain wrapper: `SplitButton` takes a closed set of props, so the
          tooltip's handlers live here (see `PullRequestPeekMark`). */}
      <span className="flex items-center">
        <SplitButton
          quiet
          label={
            <span className="inline-flex items-center gap-1.5 whitespace-nowrap">
              <span className="inline-flex" style={{ color: PULL_REQUEST_TONE_VAR[pullRequestTone(pr.state)] }}>
                <PullRequestGlyph state={pr.state} className="icon-xs" />
              </span>
              <span className={trouble ? 'text-[color:var(--tone-error)]' : undefined}>{text}</span>
            </span>
          }
          primaryAriaLabel={`${text}. ${tooltip.ariaLabel}`}
          primaryData={{ name: 'data-strip-pull-request', value: pr.url }}
          menuAriaLabel={
            watching
              ? `All pull requests from this conversation, ${pullRequests.length}, and Stop watching`
              : `All pull requests from this conversation, ${pullRequests.length}`
          }
          items={items}
          onPrimary={() => openPullRequest(pr.url)}
        />
      </span>
    </Tooltip>
  )
}
