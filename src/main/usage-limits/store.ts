import {
  USAGE_LIMIT_PROVIDERS,
  USAGE_LIMIT_STALE_AFTER_MS,
  isProviderWideUsageWindow,
  usageWindowHasReset,
  type UsageLimitBilling,
  type UsageLimitHit,
  type UsageLimitProvider,
  type UsageLimitSnapshot,
  type UsageLimitStatus,
  type UsageLimitWindow,
  type UsageLimitsState,
} from '../../shared/usage-limits'
import { claudeStatusLineUpdates } from './sources'

// The latest usage-limit reading per provider, merged from whatever the agents
// report as they run: a Claude chat's `rate_limit_event`s, a Claude terminal's
// status line, a Codex app-server's `account/rateLimits/*`. Nothing here asks a
// provider for anything; it only keeps what it is told, and says when that
// changed (for the renderer) and when a turn hit a limit (for whatever waits
// to resume it).
//
// One reading per provider, not per account: no source names the account
// without its credentials being read, and a person signed in to a second
// account replaces the first's reading the moment that account reports.
//
// Billing is a session's, though, not the provider's: one chat may run on a
// claude.ai login while another in the same run uses an API key, a cloud
// provider or a gateway. The key's chat reports no windows and its limits are
// not plan limits (each provider checks its own session's billing before it
// reports either), so all it may change here is a provider no subscription has
// spoken for this run: it must not wipe what the subscription's chats report.

/** Part of a window, as one report has it: fields left undefined keep what was known. */
export type UsageWindowUpdate = {
  id: string
  label?: string
  usedPercent?: number | null
  resetsAt?: number | null
  durationMs?: number
  scope?: 'model'
  status?: UsageLimitStatus
}

export type UsageRateLimitAnswer = {
  /**
   * An account-wide window is at its limit (or a turn said so) and has not
   * reset yet. A window that meters one model (`scope: 'model'`) never makes
   * the provider limited: a chat on another model still runs.
   */
  limited: boolean
  /** When the last limiting window lifts (epoch ms), or null when unknown or not limited. */
  resetsAt: number | null
  windowId: string | null
}

export type UsageLimitsStore = {
  /** What the session's sign-in says about billing; an API key hides the provider and forgets its windows. */
  noteBilling(provider: UsageLimitProvider, billing: Exclude<UsageLimitBilling, 'unknown'>, plan?: string): void
  /** Windows a source reported; each merges into the window of the same id. Only a subscription reports them. */
  noteWindows(provider: UsageLimitProvider, updates: UsageWindowUpdate[], at?: number): void
  /** A turn failed on a usage limit. Marks the window it named, and tells `onLimitHit`'s listeners. */
  noteLimitHit(hit: Omit<UsageLimitHit, 'at'> & { at?: number }): void
  /** One snapshot per provider with something to show: never an API-billed one, never one with no windows. */
  state(): UsageLimitsState
  /** "Is this provider rate-limited now, and until when?" */
  rateLimit(provider: UsageLimitProvider, now?: number): UsageRateLimitAnswer
  onChanged(listener: (state: UsageLimitsState) => void): () => void
  onLimitHit(listener: (hit: UsageLimitHit) => void): () => void
  /** Readings from an earlier run's cache. A provider already reported this run keeps its live reading. */
  restore(snapshots: readonly UsageLimitSnapshot[], now?: number): void
  /** What the cache keeps: the providers with a reading, windows that reset already left out. */
  persisted(now?: number): UsageLimitSnapshot[]
}

type ProviderEntry = {
  billing: UsageLimitBilling
  plan?: string
  windows: Map<string, UsageLimitWindow>
  observedAt: number
  // The last turn that ended on a limit, until a later reading says the
  // provider is allowed again or the time it gave has passed.
  hit: { resetsAt: number | null; at: number } | null
  // A session on a subscription has spoken in this run: signed in, reported
  // windows or hit a limit. Readings restored from an earlier run do not count.
  subscribedThisRun?: boolean
}

// A reading republished with nothing changed but its age, so the "as of" a
// stale reading is drawn with moves on when a fresh one arrives.
const REPUBLISH_AFTER_MS = USAGE_LIMIT_STALE_AFTER_MS / 3

export function createUsageLimitsStore(options: { now?: () => number } = {}): UsageLimitsStore {
  const clock = options.now ?? Date.now
  const entries = new Map<UsageLimitProvider, ProviderEntry>()
  const changedListeners = new Set<(state: UsageLimitsState) => void>()
  const hitListeners = new Set<(hit: UsageLimitHit) => void>()
  let published = ''
  let publishedAt = 0

  const entryFor = (provider: UsageLimitProvider): ProviderEntry => {
    let entry = entries.get(provider)
    if (!entry) {
      entry = { billing: 'unknown', windows: new Map(), observedAt: 0, hit: null }
      entries.set(provider, entry)
    }
    return entry
  }

  function snapshotOf(provider: UsageLimitProvider, entry: ProviderEntry): UsageLimitSnapshot | null {
    if (entry.billing === 'api' || entry.windows.size === 0) return null
    return {
      provider,
      billing: entry.billing,
      ...(entry.plan ? { plan: entry.plan } : {}),
      windows: [...entry.windows.values()],
      observedAt: entry.observedAt,
    }
  }

  function state(): UsageLimitsState {
    const snapshots: UsageLimitSnapshot[] = []
    for (const provider of USAGE_LIMIT_PROVIDERS) {
      const entry = entries.get(provider)
      const snapshot = entry ? snapshotOf(provider, entry) : null
      if (snapshot) snapshots.push(snapshot)
    }
    return { snapshots }
  }

  // Told only when what the renderer draws changed, or whether a turn's limit
  // still holds (a hit with no window names nothing drawn, and the notices
  // it held wait to hear it lift): a status line refreshes after every
  // assistant message, almost always with the same numbers.
  function publish(): void {
    const next = state()
    const signature = JSON.stringify({
      snapshots: next.snapshots.map((snapshot) => ({
        ...snapshot,
        observedAt: 0,
        windows: snapshot.windows.map((window) => ({
          ...window,
          usedPercent: window.usedPercent === null ? null : Math.round(window.usedPercent),
          observedAt: 0,
        })),
      })),
      hits: [...entries].filter(([, entry]) => entry.hit).map(([provider]) => provider),
    })
    const now = clock()
    if (signature === published && now - publishedAt < REPUBLISH_AFTER_MS) return
    published = signature
    publishedAt = now
    for (const listener of changedListeners) listener(next)
  }

  function mergeWindow(entry: ProviderEntry, update: UsageWindowUpdate, at: number): void {
    const previous = entry.windows.get(update.id)
    const resetsAt = update.resetsAt !== undefined ? update.resetsAt : (previous?.resetsAt ?? null)
    const usedPercent = update.usedPercent !== undefined ? update.usedPercent : (previous?.usedPercent ?? null)
    // A window that reset is a new window: the old one's status does not carry
    // into it. Without a word on status, a full window is at its limit —
    // unless the same window was last said to be a warning: full and carried
    // by the person's extra usage, which a status line's bare 100% cannot
    // tell apart from refused.
    const sameWindow = previous !== undefined && previous.resetsAt === resetsAt
    const status: UsageLimitStatus =
      update.status ??
      (usedPercent !== null && usedPercent >= 100
        ? sameWindow && previous.status === 'warning'
          ? 'warning'
          : 'rejected'
        : sameWindow && previous.status !== 'allowed'
          ? previous.status
          : 'allowed')
    const durationMs = update.durationMs ?? previous?.durationMs
    const scope = update.scope ?? previous?.scope
    entry.windows.set(update.id, {
      id: update.id,
      label: update.label ?? previous?.label ?? update.id,
      usedPercent,
      resetsAt,
      ...(durationMs ? { durationMs } : {}),
      ...(scope ? { scope } : {}),
      status,
      observedAt: at,
    })
  }

  return {
    noteBilling(provider, billing, plan) {
      const entry = entryFor(provider)
      // Another chat's subscription is reporting into this entry: a session
      // on a key leaves its readings, its plan and its limit where they are.
      if (billing === 'api' && entry.subscribedThisRun) return
      if (billing === 'subscription') entry.subscribedThisRun = true
      const changed = entry.billing !== billing || (plan !== undefined && entry.plan !== plan)
      entry.billing = billing
      if (plan !== undefined) entry.plan = plan
      // An API key has no plan limits: what an earlier run read under a
      // subscription is not this account's, and is neither shown nor kept.
      if (billing === 'api') {
        entry.windows.clear()
        entry.plan = undefined
        entry.hit = null
      }
      if (changed) publish()
    },
    noteWindows(provider, updates, at = clock()) {
      if (updates.length === 0) return
      const entry = entryFor(provider)
      // Only a subscription is reported windows; whatever was believed before,
      // this is one now.
      entry.billing = 'subscription'
      entry.subscribedThisRun = true
      for (const update of updates) mergeWindow(entry, update, at)
      entry.observedAt = Math.max(entry.observedAt, at)
      if (entry.hit && updates.some((update) => update.status === 'allowed' || update.status === 'warning')) {
        const stillRejected = [...entry.windows.values()].some(
          (window) =>
            isProviderWideUsageWindow(window) && window.status === 'rejected' && !usageWindowHasReset(window, at),
        )
        if (!stillRejected) entry.hit = null
      }
      publish()
    },
    noteLimitHit(input) {
      const at = input.at ?? clock()
      const entry = entryFor(input.provider)
      if (entry.billing === 'api') return
      entry.subscribedThisRun = true
      let resetsAt = input.resetsAt
      const named = input.windowId ? entry.windows.get(input.windowId) : undefined
      if (named && input.windowId) {
        mergeWindow(entry, { id: input.windowId, status: 'rejected', ...(resetsAt !== null ? { resetsAt } : {}) }, at)
      }
      // The turn did not say when; the windows at their limit might.
      resetsAt ??= named && !isProviderWideUsageWindow(named) ? named.resetsAt : limitingWindows(entry, at).resetsAt
      // A model's own window holds back the chats on that model, which the
      // hit's listeners resume; it does not make the provider limited.
      if (!named || isProviderWideUsageWindow(named)) entry.hit = { resetsAt, at }
      const hit: UsageLimitHit = {
        provider: input.provider,
        sessionId: input.sessionId,
        resetsAt,
        windowId: input.windowId,
        at,
      }
      for (const listener of hitListeners) listener(hit)
      publish()
    },
    state,
    rateLimit(provider, now = clock()) {
      const entry = entries.get(provider)
      if (!entry || entry.billing === 'api') return { limited: false, resetsAt: null, windowId: null }
      const limiting = limitingWindows(entry, now)
      if (limiting.windowId) return { limited: true, resetsAt: limiting.resetsAt, windowId: limiting.windowId }
      if (entry.hit && (entry.hit.resetsAt === null || entry.hit.resetsAt > now))
        return { limited: true, resetsAt: entry.hit.resetsAt, windowId: null }
      return { limited: false, resetsAt: null, windowId: null }
    },
    onChanged(listener) {
      changedListeners.add(listener)
      return () => changedListeners.delete(listener)
    },
    onLimitHit(listener) {
      hitListeners.add(listener)
      return () => hitListeners.delete(listener)
    },
    restore(snapshots, now = clock()) {
      let restored = false
      for (const snapshot of snapshots) {
        if (entries.has(snapshot.provider) || snapshot.billing === 'api') continue
        const windows = snapshot.windows.filter((window) => !usageWindowHasReset(window, now))
        if (windows.length === 0) continue
        entries.set(snapshot.provider, {
          billing: snapshot.billing,
          ...(snapshot.plan ? { plan: snapshot.plan } : {}),
          windows: new Map(windows.map((window) => [window.id, window])),
          observedAt: snapshot.observedAt,
          hit: null,
        })
        restored = true
      }
      if (restored) publish()
    },
    persisted(now = clock()) {
      const out: UsageLimitSnapshot[] = []
      for (const snapshot of state().snapshots) {
        const windows = snapshot.windows.filter((window) => !usageWindowHasReset(window, now))
        if (windows.length > 0) out.push({ ...snapshot, windows })
      }
      return out
    },
  }
}

// The account-wide windows holding the provider back now, and when the last of
// them lifts: every one has to before a turn can run again. A model's own
// window holds back only the chats on that model, so it is not one of them.
function limitingWindows(entry: ProviderEntry, now: number): { resetsAt: number | null; windowId: string | null } {
  let windowId: string | null = null
  let resetsAt: number | null = null
  for (const window of entry.windows.values()) {
    if (usageWindowHasReset(window, now)) continue
    if (window.status !== 'rejected' || !isProviderWideUsageWindow(window)) continue
    if (windowId === null || (window.resetsAt ?? 0) > (resetsAt ?? 0)) {
      windowId = window.id
      resetsAt = window.resetsAt
    }
  }
  return { resetsAt, windowId }
}

// The app's one store. Providers report into it from wherever they run; the
// IPC layer relays it, and a later feature asks it whether to wait.
let usageLimits = createUsageLimitsStore()

/** Test seam: the app's store as a fresh process has it. Listeners on the old one hear nothing more. */
export function resetUsageLimitsStore(): void {
  usageLimits = createUsageLimitsStore()
}

export function usageLimitsStore(): UsageLimitsStore {
  return usageLimits
}

/** Whether `provider` is rate-limited now and when that lifts; the question auto-resume will ask. */
export function usageRateLimit(provider: UsageLimitProvider, now?: number): UsageRateLimitAnswer {
  return usageLimits.rateLimit(provider, now)
}

/** Every turn that ends on a usage limit, with when it lifts. Returns the unsubscribe. */
export function onUsageLimitHit(listener: (hit: UsageLimitHit) => void): () => void {
  return usageLimits.onLimitHit(listener)
}

// A Claude terminal's status line is read in the desktop's own process, where
// its terminals run. With the Studio server out of process the chats, the
// IPC that draws the limits and the resumes after them are the server's, and
// its store is another; the desktop forwards each reading there (app-services,
// `SERVER_EVENTS.usageStatusLine`) as well as keeping it here, where the
// launch notices read it.
const statusLineForwarders = new Set<(rateLimits: unknown, at: number) => void>()

/** A Claude Code status line's `rateLimits`: into this process's store, and to whatever forwards them. */
export function noteStatusLineRateLimits(rateLimits: unknown, at: number): void {
  usageLimits.noteWindows('claude', claudeStatusLineUpdates(rateLimits), at)
  for (const forward of statusLineForwarders) forward(rateLimits, at)
}

/** Hear every status-line reading this process takes. Returns the unsubscribe. */
export function forwardStatusLineRateLimits(listener: (rateLimits: unknown, at: number) => void): () => void {
  statusLineForwarders.add(listener)
  return () => statusLineForwarders.delete(listener)
}
