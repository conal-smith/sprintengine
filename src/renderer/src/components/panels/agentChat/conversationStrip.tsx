import React, { useLayoutEffect, useRef, useState } from 'react'

import type { MachineIdentity } from '../../../../../shared/machine-identity'
import { GitBranchGlyph } from '../../AppIcons'
import { ContextRing, DiffStatPill, GhostButton, MachineGlyph, OverflowMenu, Tooltip, WorktreeGlyph } from '../../ui'
import type { OverflowMenuItem } from '../../ui/OverflowMenu'
import { FOCUS_RING_CLASS } from '../../ui/tokens'
import { ComposerStrip } from '../../workspace/agentComposer/ComposerStrip'
import type { BranchPullRequest } from '../../../../../shared/git/pull-request'
import type { StudioLocalServer } from '../../../../../../packages/studio-protocol/src/public'
import { LocalServersStripButton, localServersStripCopy } from '../../workspace/LocalServerMarks'
import { PullRequestStripButton, stripPullRequestCopy } from '../../workspace/PullRequestMark'
import { CreatePullRequestControl, pullRequestSlotChoice } from './createPullRequest'
import { fitComposerStrip, fullComposerStripFit, sameComposerStripFit, type ComposerStripFit } from './composerStripFit'
import type { UsageLimitSnapshot } from '../../../../../shared/usage-limits'
import { UsageLimitsStripButton } from './usageLimits'

// The strip under an open conversation's composer (owner ruling 2026-10-04):
// the facts of where this agent works, read-only, on the same strip the New
// chat composer's choices sit on. Left to right —
//
//   the machine's glyph (only when the chat is not on this computer) ·
//   the branch (a worktree glyph before it only when the agent works in one;
//   opens the file explorer) · the diff counts (open the changes) ·
//   [⋮ what did not fit] · the local servers the conversation's agents
//   started ("localhost:5173 · Running", "3 servers · 2 running";
//   LocalServerMarks.tsx) · the pull request slot: the conversation's pull
//   request ("Open PR #123"), or "Create PR" when the branch is ready to
//   propose (createPullRequest.tsx), never both · the subscription's usage
//   limits, as a small bar (usageLimits.tsx) · the context ring, pinned to the
//   right corner.
//
// The project is not here: the title bar names it, and the person knows which
// project they are in. Nothing here is a choice — the conversation has
// started, and where it runs is settled. The pull request is the one thing to
// act on: it sits at the bottom of the chat, beside the ring, because that is
// where a person finishing with a conversation looks (owner ruling 2026-10-04),
// and like the ring it never leaves for the menu — the line gives way around it.
// The local servers keep the same seat for the same reason: they are the other
// thing on the line to act on (open the app the agent started, run it again),
// and their own menu cannot fold into the "⋮" menu's flat list of facts
// without becoming a menu inside a menu.
//
// One line, always: as the pane narrows, items leave for the "⋮" menu in the
// order `composerStripFit` gives, measured rather than at fixed breakpoints,
// because the same pane width holds a different strip depending on the branch
// name and the counts.

export type ConversationStripMachine = { name: string; identity: MachineIdentity }
export type ConversationStripBranch = { name: string; worktree: boolean; onOpen: (() => void) | null }
export type ConversationStripChanges = {
  added: number
  removed: number
  /** The counts in words: "3 files added, 2 removed". */
  phrase: string
  onOpen: (() => void) | null
}

/** The branch control's accessible name, which its tooltip shortens to the name itself. */
export function branchItemLabel(branch: ConversationStripBranch): string {
  const where = branch.worktree ? `Branch ${branch.name}, in a worktree` : `Branch ${branch.name}`
  return branch.onOpen ? `${where} — open in file explorer` : where
}

/** The diff counts' accessible name. */
export function changesItemLabel(changes: ConversationStripChanges): string {
  return changes.onOpen ? `${changes.phrase} — open changes` : changes.phrase
}

// Widths a part has when it has not been drawn yet, so the first fit has a
// number: the "⋮" button is 24px (`h-6 w-6`), the ring's anchor is the hit
// target.
const OVERFLOW_FALLBACK_WIDTH = 24

const NO_PULL_REQUESTS: readonly BranchPullRequest[] = []

/**
 * The width of the line's pinned end: the local servers, the pull request and
 * the ring, any of them; null when none is drawn.
 */
function pinnedWidth(widths: ReadonlyArray<number | null>, gap: number): number | null {
  const drawn = widths.filter((width): width is number => width !== null)
  if (drawn.length === 0) return null
  return drawn.reduce((sum, width) => sum + width, 0) + gap * (drawn.length - 1)
}

export function ConversationComposerStrip({
  machine,
  branch,
  changes,
  context,
  pullRequests = NO_PULL_REQUESTS,
  onStopWatchingPullRequest,
  createPullRequest = null,
  localServers = null,
  usageLimits = null,
  now = Date.now(),
}: {
  machine: ConversationStripMachine | null
  branch: ConversationStripBranch | null
  changes: ConversationStripChanges | null
  /** The context reading; null when the runtime has reported none (no ring is drawn then). */
  context: { used: number; total: number } | null
  /** The pull requests this conversation opened; none draws no button. */
  pullRequests?: readonly BranchPullRequest[]
  /** Stop Studio watching one of them; absent where this window cannot, and then none is offered. */
  onStopWatchingPullRequest?: (url: string) => void
  /** The checkout is ready to propose: "Create PR" may take the slot. Null when it is not, or not on this computer. */
  createPullRequest?: {
    cwd: string
    conversation: { workspaceId: string; agentId: string }
    onSettled: () => void
    /** Keeps the control in the slot while it shows its dialog, a step or a failure. */
    onHoldChange?: (held: boolean) => void
    /** Whether the checkout reads as ready now; a held failure is dismissed rather than retried when not. */
    ready?: boolean
  } | null
  /**
   * The local servers this conversation's agents linked, and the workspace
   * whose browser pane opens them. Null, or no servers, draws nothing.
   */
  localServers?: {
    workspaceId: string
    servers: readonly StudioLocalServer[]
  } | null
  /**
   * The subscription usage limits of the agent this chat runs on, when it has
   * reported some. Null draws nothing. Like the ring, it never leaves the line.
   */
  usageLimits?: UsageLimitSnapshot | null
  /** The clock the pull request's age is read against; a test pins it. */
  now?: number
}): React.JSX.Element | null {
  // A state, not a ref: the strip is not drawn while it has nothing to say,
  // and the measuring below has to start the moment it is.
  const [stripEl, setStripEl] = useState<HTMLDivElement | null>(null)
  const machineRef = useRef<HTMLSpanElement | null>(null)
  const branchRef = useRef<HTMLElement | null>(null)
  const branchTextRef = useRef<HTMLSpanElement | null>(null)
  const changesRef = useRef<HTMLSpanElement | null>(null)
  const overflowRef = useRef<HTMLSpanElement | null>(null)
  const pullRequestRef = useRef<HTMLSpanElement | null>(null)
  const serversRef = useRef<HTMLSpanElement | null>(null)
  const ringRef = useRef<HTMLSpanElement | null>(null)
  const usageRef = useRef<HTMLSpanElement | null>(null)
  // The last width each part was drawn at. A part in the menu is not drawn,
  // and its width is still what decides whether it comes back.
  const widths = useRef<{
    machine?: number
    branchChrome?: number
    charWidth?: number
    changes?: number
    overflow?: number
    pullRequest?: number
    servers?: number
    usage?: number
    ring?: number
  }>({})
  const [available, setAvailable] = useState(0)
  const [fit, setFit] = useState<ComposerStripFit>(() => fullComposerStripFit(branch?.name ?? null))

  const hasChanges = Boolean(changes && (changes.added > 0 || changes.removed > 0))
  const percentage = context && context.total > 0 ? (context.used / context.total) * 100 : null
  const slot = pullRequestSlotChoice(pullRequests, createPullRequest !== null)
  const pullRequest = slot === 'open' || slot === 'merged' ? stripPullRequestCopy(pullRequests, now) : null
  const serversCopy = localServers ? localServersStripCopy(localServers.servers) : null

  // The strip's own width: what the line has to hold.
  useLayoutEffect(() => {
    const strip = stripEl
    if (!strip) return
    const read = (): void => {
      const style = getComputedStyle(strip)
      const padding = (parseFloat(style.paddingLeft) || 0) + (parseFloat(style.paddingRight) || 0)
      setAvailable(Math.max(0, strip.clientWidth - padding))
    }
    read()
    if (typeof ResizeObserver !== 'function') return
    const observer = new ResizeObserver(() => read())
    observer.observe(strip)
    return () => observer.disconnect()
  }, [stripEl])

  // Measure what is drawn, then fit. A layout effect, so a strip that must
  // give way does so before it is painted rather than flinching into place.
  const machineId = machine?.identity.id ?? null
  const branchName = branch?.name ?? null
  const branchWorktree = branch?.worktree ?? false
  const changesKey = hasChanges && changes ? `${changes.added}:${changes.removed}` : null
  const ringShown = percentage !== null
  const usageShown = usageLimits !== null
  // What the slot draws, as a key its width is measured under.
  const pullRequestText = slot === 'create' ? 'create' : (pullRequest?.text ?? null)
  const serversText = serversCopy ? `${serversCopy.label} · ${serversCopy.state}` : null
  // "Create PR" changes width without changing its key: the button gives way
  // to a step ("Pushing the branch…") or a failure. The slot is watched, and
  // a new width measures the line again.
  const [slotResized, setSlotResized] = useState(0)
  const slotDrawn = pullRequestText !== null
  useLayoutEffect(() => {
    const node = pullRequestRef.current
    if (!slotDrawn || !node || typeof ResizeObserver !== 'function') return
    let last = node.getBoundingClientRect().width
    const observer = new ResizeObserver(() => {
      const width = node.getBoundingClientRect().width
      if (width === last) return
      last = width
      setSlotResized((count) => count + 1)
    })
    observer.observe(node)
    return () => observer.disconnect()
  }, [slotDrawn, stripEl])
  useLayoutEffect(() => {
    const strip = stripEl
    const known = widths.current
    const widthOf = (node: Element | null): number | undefined => {
      const width = node?.getBoundingClientRect().width
      return width && width > 0 ? width : undefined
    }
    known.machine = widthOf(machineRef.current) ?? known.machine
    known.changes = widthOf(changesRef.current) ?? known.changes
    known.overflow = widthOf(overflowRef.current) ?? known.overflow
    known.ring = widthOf(ringRef.current) ?? known.ring
    known.pullRequest = widthOf(pullRequestRef.current) ?? known.pullRequest
    known.servers = widthOf(serversRef.current) ?? known.servers
    known.usage = widthOf(usageRef.current) ?? known.usage
    const branchWidth = widthOf(branchRef.current)
    const textWidth = widthOf(branchTextRef.current)
    const drawnText = branchTextRef.current?.textContent ?? ''
    if (branchWidth !== undefined && textWidth !== undefined && drawnText.length > 0) {
      known.charWidth = textWidth / drawnText.length
      known.branchChrome = branchWidth - textWidth
    }
    // A part that is on the strip but has never been drawn has no width yet:
    // draw everything once to learn it, and fit on the next pass.
    const unmeasured =
      (machineId !== null && known.machine === undefined) ||
      (changesKey !== null && known.changes === undefined) ||
      (branchName !== null && known.charWidth === undefined) ||
      (pullRequestText !== null && known.pullRequest === undefined) ||
      (serversText !== null && known.servers === undefined)
    const gap = strip ? parseFloat(getComputedStyle(strip).columnGap) || 0 : 0
    const next =
      available <= 0 || unmeasured
        ? fullComposerStripFit(branchName)
        : fitComposerStrip({
            available,
            gap,
            // The local servers, the pull request, the usage limits and the
            // ring are the line's pinned end: none of them leaves, so the fit
            // gives way around them.
            ring: pinnedWidth(
              [
                serversText ? (known.servers ?? 0) : null,
                pullRequestText ? (known.pullRequest ?? 0) : null,
                usageShown ? (known.usage ?? 0) : null,
                ringShown ? (known.ring ?? 0) : null,
              ],
              gap,
            ),
            overflow: known.overflow ?? OVERFLOW_FALLBACK_WIDTH,
            machine: machineId !== null ? (known.machine ?? 0) : null,
            changes: changesKey !== null ? (known.changes ?? 0) : null,
            branch:
              branchName !== null
                ? { name: branchName, charWidth: known.charWidth ?? 0, chrome: known.branchChrome ?? 0 }
                : null,
          })
    setFit((current) => (sameComposerStripFit(current, next) ? current : next))
    // `fit` is a dependency on purpose: a fit that moved an item measures the
    // line it drew, and settles once the fit stops changing. A worktree mark
    // changes the branch's width, and the counts change the pill's.
  }, [
    stripEl,
    available,
    machineId,
    branchName,
    branchWorktree,
    changesKey,
    ringShown,
    usageShown,
    pullRequestText,
    slotResized,
    serversText,
    fit,
  ])

  if (
    !machine &&
    !branch &&
    !hasChanges &&
    percentage === null &&
    pullRequestText === null &&
    serversText === null &&
    !usageLimits
  )
    return null

  const showMachine = machine !== null && fit.machine
  const showBranch = branch !== null && fit.branchText !== null
  const showChanges = hasChanges && changes !== null && fit.changes

  // Everything that left the line, in the order it reads on the line, each
  // still doing what it did there.
  const hidden: OverflowMenuItem[] = []
  if (machine && !showMachine) {
    hidden.push({
      id: 'strip-machine',
      label: `On ${machine.name}`,
      icon: <MachineGlyph identity={machine.identity} />,
      // Nothing to open: the machine is a fact, said here in full.
      disabled: true,
      onSelect: () => undefined,
    })
  }
  if (branch && !showBranch) {
    hidden.push({
      id: 'strip-branch',
      label: branchItemLabel(branch),
      icon: branch.worktree ? (
        <WorktreeGlyph className="icon-xs shrink-0 text-[color:var(--text-subtle)]" />
      ) : (
        <GitBranchGlyph className="icon-xs shrink-0 text-[color:var(--text-subtle)]" />
      ),
      disabled: branch.onOpen === null,
      onSelect: () => branch.onOpen?.(),
    })
  }
  if (hasChanges && changes && !showChanges) {
    hidden.push({
      id: 'strip-changes',
      label: changesItemLabel(changes),
      disabled: changes.onOpen === null,
      onSelect: () => changes.onOpen?.(),
    })
  }

  return (
    <ComposerStrip ref={setStripEl} data-conversation-strip="true">
      {showMachine && machine ? (
        <Tooltip content={machine.name} placement="top" wrapperClassName="flex shrink-0">
          {/* Its glyph alone: a name would be the widest thing on the line
              for the one fact a glance gets from the mark's shape and
              colour. The name is the tooltip and the accessible name, and
              focusable so the tooltip is a keyboard's too. */}
          <span
            ref={machineRef}
            role="img"
            aria-label={`On ${machine.name}`}
            tabIndex={0}
            data-strip-machine={machine.identity.id}
            className={`inline-flex size-[var(--hit-target-min)] shrink-0 items-center justify-center rounded-sm ${FOCUS_RING_CLASS}`}
          >
            <MachineGlyph identity={machine.identity} />
          </span>
        </Tooltip>
      ) : null}
      {showBranch && branch && fit.branchText !== null ? (
        <BranchItem
          branch={branch}
          text={fit.branchText}
          itemRef={(node) => {
            branchRef.current = node
          }}
          textRef={branchTextRef}
        />
      ) : null}
      {showChanges && changes ? (
        <span ref={changesRef} className="inline-flex shrink-0">
          <Tooltip content={changes.phrase} placement="top" wrapperClassName="inline-flex">
            <DiffStatPill
              added={changes.added}
              removed={changes.removed}
              ariaLabel={changesItemLabel(changes)}
              {...(changes.onOpen ? { onClick: changes.onOpen } : {})}
            />
          </Tooltip>
        </span>
      ) : null}
      {hidden.length > 0 ? (
        <span ref={overflowRef} className="inline-flex shrink-0" data-strip-overflow="">
          <OverflowMenu ariaLabel="More about where this agent works" triggerTooltip="More" items={hidden} />
        </span>
      ) : null}
      {serversText !== null && localServers ? (
        <span ref={serversRef} className="ml-auto inline-flex shrink-0" data-strip-local-servers-slot="">
          <LocalServersStripButton workspaceId={localServers.workspaceId} servers={localServers.servers} />
        </span>
      ) : null}
      {pullRequestText !== null ? (
        <span
          ref={pullRequestRef}
          className={`${serversText !== null ? '' : 'ml-auto '}inline-flex shrink-0`}
          data-strip-pull-request-slot=""
        >
          {slot === 'create' && createPullRequest ? (
            <CreatePullRequestControl
              cwd={createPullRequest.cwd}
              conversation={createPullRequest.conversation}
              onSettled={createPullRequest.onSettled}
              onHoldChange={createPullRequest.onHoldChange}
              ready={createPullRequest.ready}
            />
          ) : (
            <PullRequestStripButton
              pullRequests={pullRequests}
              now={now}
              {...(onStopWatchingPullRequest ? { onStopWatching: onStopWatchingPullRequest } : {})}
            />
          )}
        </span>
      ) : null}
      {usageLimits ? (
        <span
          ref={usageRef}
          className={`${pullRequestText !== null || serversText !== null ? '' : 'ml-auto '}inline-flex shrink-0`}
          data-strip-usage-limits-slot=""
        >
          <UsageLimitsStripButton snapshot={usageLimits} />
        </span>
      ) : null}
      {percentage !== null && context ? (
        <span
          ref={ringRef}
          className={`${pullRequestText !== null || serversText !== null || usageLimits ? '' : 'ml-auto '}inline-flex shrink-0`}
          data-strip-context=""
        >
          <ContextRing usedPercentage={percentage} tokens={context} />
        </span>
      ) : null}
    </ComposerStrip>
  )
}

function BranchItem({
  branch,
  text,
  itemRef,
  textRef,
}: {
  branch: ConversationStripBranch
  text: string
  itemRef: (node: HTMLElement | null) => void
  textRef: React.RefObject<HTMLSpanElement | null>
}): React.JSX.Element {
  // No branch glyph: on a strip whose every item is about the checkout, a
  // monospace name already reads as a branch, and the glyph was width the
  // name needed. A worktree is the exception worth a mark. The cut name is
  // what is drawn; the whole one is what a screen reader hears.
  const cut = text !== branch.name
  const content = (
    <>
      {branch.worktree ? <WorktreeGlyph className="icon-xs shrink-0 text-[color:var(--text-subtle)]" /> : null}
      <span ref={textRef} aria-hidden={cut || undefined} className="whitespace-nowrap font-mono">
        {text}
      </span>
    </>
  )
  return (
    <Tooltip
      content={branch.worktree ? `${branch.name} · worktree` : branch.name}
      placement="top"
      wrapperClassName="flex min-w-0"
    >
      {branch.onOpen ? (
        // The strip's quiet ghost: the item reads as the line's text until
        // the pointer arrives, as the New chat strip's project line does.
        <GhostButton
          ref={itemRef}
          size="xs"
          tone="subtle"
          onClick={branch.onOpen}
          aria-label={branchItemLabel(branch)}
          data-strip-branch={branch.name}
          className="min-w-0 gap-1.5 whitespace-nowrap"
        >
          {content}
        </GhostButton>
      ) : (
        <span
          ref={itemRef}
          role="img"
          aria-label={branchItemLabel(branch)}
          data-strip-branch={branch.name}
          className="inline-flex h-control-xs min-w-0 items-center gap-1.5 whitespace-nowrap px-2 text-meta text-[color:var(--text-subtle)]"
        >
          {content}
        </span>
      )}
    </Tooltip>
  )
}
