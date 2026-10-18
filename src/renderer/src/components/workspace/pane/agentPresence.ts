import { useMemo, useSyncExternalStore } from 'react'

import type { BrowserController } from '../../../../../shared/browser'
import type { WorkspacePaneTab } from '../../../types/workspace'
import { normalizePathKey } from '../../../hooks/useGitStatus'
import { AGENT_TRAIL_LINGER_MS } from '../../panels/agentFileTrail'
import { useAgentFileTrail } from '../../panels/useAgentFileTrail'
import { canvasBoardKey } from './canvas/canvasSync'

// Which pane tabs an agent is using right now: a page it drives, a board it
// draws on. The tab wears the agent pill and its panel the agent edge, in the
// violet the Files tree marks a file an agent is in with — one colour for
// "an agent is here", wherever here is.
//
// Main says who holds a page (`browser:state`) or a board's pen
// (`canvas:presence`) to the window showing it, and lets an agent's claim
// lapse 1.5 s after its last action. A model thinking between two steps takes
// far longer than that, so a claim going back to nobody is not the agent
// leaving: the mark lingers as long as a Files tree mark does after its tool
// call ends, and goes at once when the person takes the page back.

/** How long the mark stays after an agent's claim lapses: the Files tree's linger, so the two agree. */
export const AGENT_PRESENCE_LINGER_MS = AGENT_TRAIL_LINGER_MS

type Entry = { lit: boolean; timer: ReturnType<typeof setTimeout> | null }

export type AgentPresenceStore = {
  /** Record who holds `key` as main reported it. */
  observe(key: string, controller: BrowserController): void
  isLit(key: string): boolean
  subscribe(listener: () => void): () => void
  /** Moves on every change; a snapshot for `useSyncExternalStore`. */
  version(): number
}

export function createAgentPresenceStore(lingerMs: number = AGENT_PRESENCE_LINGER_MS): AgentPresenceStore {
  const entries = new Map<string, Entry>()
  const listeners = new Set<() => void>()
  let version = 0
  const emit = (): void => {
    version += 1
    for (const listener of listeners) listener()
  }
  const settle = (entry: Entry): void => {
    if (entry.timer !== null) clearTimeout(entry.timer)
    entry.timer = null
  }
  return {
    observe(key, controller) {
      let entry = entries.get(key)
      if (!entry) {
        if (controller !== 'agent') return
        entry = { lit: false, timer: null }
        entries.set(key, entry)
      }
      const was = entry.lit
      if (controller === 'agent') {
        settle(entry)
        entry.lit = true
      } else if (controller === 'human') {
        settle(entry)
        entry.lit = false
      } else if (entry.lit && entry.timer === null) {
        const lapsing = entry
        lapsing.timer = setTimeout(() => {
          lapsing.timer = null
          lapsing.lit = false
          emit()
        }, lingerMs)
      }
      if (entry.lit !== was) emit()
    },
    isLit(key) {
      return entries.get(key)?.lit ?? false
    },
    subscribe(listener) {
      listeners.add(listener)
      return () => listeners.delete(listener)
    },
    version() {
      return version
    },
  }
}

export function browserPresenceKey(tabId: string): string {
  return `browser\0${tabId}`
}

export function canvasPresenceKey(workspaceId: string, path: string): string {
  return `canvas\0${canvasBoardKey({ workspaceId, path })}`
}

/** The presence a pane tab can have, or null for a kind no agent holds. */
export function paneTabPresenceKey(workspaceId: string, tab: WorkspacePaneTab): string | null {
  if (tab.kind === 'browser') return browserPresenceKey(tab.id)
  if (tab.kind === 'canvas' && tab.canvas) return canvasPresenceKey(workspaceId, tab.canvas.path)
  return null
}

/** The one store a window keeps, fed by main's reports from the first time anything asks. */
export const agentPresence = createAgentPresenceStore()

let feeding = false

// Listened to once per window, from the first subscriber on, and never let go:
// a report missed between one strip unmounting and the next mounting would
// leave a mark lit for good, or never lit.
function feedFromMain(): void {
  if (feeding || typeof window === 'undefined' || !window.api) return
  feeding = true
  window.api.onBrowserState?.((state) => agentPresence.observe(browserPresenceKey(state.tabId), state.controller))
  window.api.onCanvasPresence?.((presence) =>
    agentPresence.observe(canvasPresenceKey(presence.workspaceId, presence.path), presence.controller),
  )
}

function subscribe(listener: () => void): () => void {
  feedFromMain()
  return agentPresence.subscribe(listener)
}

/**
 * The ids of the tabs in `tabs` an agent is using now: a page or a board it
 * holds, or a document whose file it is reading or editing (the Files tree's
 * trail, so a plan an agent is writing is marked on its tab as on its row).
 */
export function useAgentPresentTabIds(workspaceId: string, tabs: readonly WorkspacePaneTab[]): ReadonlySet<string> {
  const version = useSyncExternalStore(subscribe, agentPresence.version, agentPresence.version)
  const trail = useAgentFileTrail(workspaceId, null)
  return useMemo(() => {
    const present = new Set<string>()
    for (const tab of tabs) {
      const key = paneTabPresenceKey(workspaceId, tab)
      if (key && agentPresence.isLit(key)) present.add(tab.id)
      else if (tab.kind === 'document' && tab.document && trail.marks.has(normalizePathKey(tab.document.path)))
        present.add(tab.id)
    }
    return present
    // `version` is the store's clock: a new reading when any mark moves.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [workspaceId, tabs, version, trail])
}
