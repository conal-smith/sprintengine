import type { BrowserController } from '../../../../../../shared/browser'
import { paneKindFloats } from '../../../../store/slices/workspacePaneSlice'
import type { WorkspacePaneState } from '../../../../types/workspace'

// When the floating player comes up by itself: an agent opening or driving a
// page, or drawing on a board, in a pane the person has closed. The pane would take the chat's width;
// the player shows the page in a corner and leaves the chat where it was.
//
// Pure decisions over the pane record and the controller history the main
// process broadcasts, so the rules are testable without a window. The hook
// (useAgentBrowserAutoFloat) and the open-request answer in the pane column
// apply them.

/**
 * How long a tab's agent must leave it alone before a Close on its player is
 * forgotten. Main lets an agent's claim lapse 1.5 s after its last action
 * (browser-manager's CONTROLLER_LINGER_MS), and a model thinking between two
 * steps takes far longer than that, so "the controller went back to none" is
 * not the end of a session — it happens between every step. A minute of
 * nothing is.
 */
export const AGENT_SESSION_QUIET_MS = 60_000

/**
 * How recently an agent must have acted for a closing pane to hand its page
 * back to the player. Long enough to cover the pause between two steps, short
 * enough that closing the pane after the agent finished just closes it.
 */
export const AGENT_DRIVING_GRACE_MS = 10_000

type TabTrack = {
  controller: BrowserController
  /** The last moment the agent held the page (its claim seen, or let go). */
  agentAt: number | null
  /** The person closed this tab's player; null when they have not. */
  dismissedAt: number | null
}

export type AgentBrowserTracker = {
  /**
   * Record a tab's controller as main reports it. True when this report is
   * the agent taking the page — from nobody, or from the person — which is
   * the moment the player may come up.
   */
  observe(tabId: string, controller: BrowserController, now: number): boolean
  /** The person closed the tab's player: keep it down while this session lasts. */
  dismiss(tabId: string, now: number): void
  /** Whether a Close on this tab's player still holds. */
  isSuppressed(tabId: string, now: number): boolean
  /** Whether an agent holds the page, or did a moment ago. */
  isDriving(tabId: string, now: number): boolean
  controllerOf(tabId: string): BrowserController
}

export function createAgentBrowserTracker(): AgentBrowserTracker {
  const tabs = new Map<string, TabTrack>()
  const trackOf = (tabId: string): TabTrack => {
    let track = tabs.get(tabId)
    if (!track) {
      track = { controller: 'none', agentAt: null, dismissedAt: null }
      tabs.set(tabId, track)
    }
    return track
  }
  // A Close lasts until the agent has been away for a quiet minute, measured
  // from whichever came last: its own last action or the Close itself.
  const expireDismissal = (track: TabTrack, now: number): void => {
    if (track.dismissedAt === null) return
    const lastSeen = Math.max(track.dismissedAt, track.agentAt ?? track.dismissedAt)
    if (now - lastSeen > AGENT_SESSION_QUIET_MS) track.dismissedAt = null
  }

  return {
    observe(tabId, controller, now) {
      const track = trackOf(tabId)
      const previous = track.controller
      track.controller = controller
      if (controller === 'agent') {
        expireDismissal(track, now)
        track.agentAt = now
        return previous !== 'agent'
      }
      if (previous === 'agent') track.agentAt = now
      return false
    },
    dismiss(tabId, now) {
      trackOf(tabId).dismissedAt = now
    },
    isSuppressed(tabId, now) {
      const track = tabs.get(tabId)
      if (!track) return false
      expireDismissal(track, now)
      return track.dismissedAt !== null
    },
    isDriving(tabId, now) {
      const track = tabs.get(tabId)
      if (!track) return false
      if (track.controller === 'agent') return true
      return track.agentAt !== null && now - track.agentAt <= AGENT_DRIVING_GRACE_MS
    },
    controllerOf(tabId) {
      return tabs.get(tabId)?.controller ?? 'none'
    },
  }
}

/** The one tracker a window keeps: Close on the player and the hook share it. */
export const agentBrowserTracker = createAgentBrowserTracker()

/**
 * Whether the agent taking `tabId` — a page it drives, or a board it draws
 * on — should bring it up as the player.
 *
 * Only into a closed pane: an open pane already shows the page, or shows what
 * the person chose instead. Never over a player already up — the person is
 * watching that one, and only one floats. Never a tab out in a window of its
 * own, which has no docked panel to restyle.
 */
export function shouldFloatForAgent(pane: WorkspacePaneState | undefined, tabId: string): boolean {
  if (!pane || pane.open) return false
  const tab = pane.tabs.find((candidate) => candidate.id === tabId)
  if (!tab || !paneKindFloats(tab.kind) || tab.poppedOut) return false
  return !pane.tabs.some((candidate) => candidate.floating)
}

/**
 * Whether an agent's `browser.open` should float its page rather than open
 * the pane: the pane is closed and the person has the player on. An open pane
 * keeps the old answer — the tab comes to the front of it.
 */
export function shouldFloatAgentOpen(pane: WorkspacePaneState | undefined, enabled: boolean): boolean {
  return enabled && !(pane?.open ?? false)
}
