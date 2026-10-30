// The one door onto scheduled agents that every caller goes through — the New
// chat panel over IPC, an extension through the SDK, an agent through the MCP
// tools — so each write is validated the same way and the scheduler hears of it.

import type { CliPermissionPreset } from '../../shared/cli-permission-preset'
import { isLooserCliPermissionPreset } from '../../shared/cli-permission-preset'
import {
  scheduledAgentsPauseHolds,
  validateScheduledAgentDraft,
  type ScheduledAgent,
  type ScheduledAgentDraft,
  type ScheduledAgentLastRun,
  type ScheduledAgentRun,
  type ScheduledAgentView,
  type ScheduledAgentWriteResult,
  type ScheduledAgentsPause,
} from '../../shared/scheduled-agents'
import { refuseScheduledAgentRun } from '../automation/launch-permission-cap'
import { moduleConversationCeiling } from '../module-host/module-conversation-service'
import { clampToModuleToolCaller, moduleToolCallerCeiling } from '../module-host/module-tool-caller'
import type { ScheduledAgentsScheduler } from './scheduler'
import type { ScheduledPromptImages } from './prompt-images'
import type { ScheduledAgentsStore } from './store'

/** Lowers a validated draft's preset before it is stored; the identity when absent. */
type CapPreset = (preset: CliPermissionPreset | null) => CliPermissionPreset | null

export type ScheduledAgentsService = {
  list(options?: { ownerModuleId?: string }): ScheduledAgentView[]
  get(id: string): ScheduledAgentView | null
  create(
    input: unknown,
    options?: { ownerModuleId?: string; capPreset?: CapPreset },
  ): Promise<ScheduledAgentWriteResult>
  update(
    id: string,
    input: unknown,
    options?: { ownerModuleId?: string; capPreset?: CapPreset },
  ): Promise<ScheduledAgentWriteResult>
  remove(id: string, options?: { ownerModuleId?: string }): Promise<{ ok: true } | { ok: false; message: string }>
  runNow(
    id: string,
    options?: { ownerModuleId?: string },
  ): Promise<{ ok: true; run: ScheduledAgentLastRun } | { ok: false; message: string }>
  markFailureSeen(id: string): Promise<void>
  /**
   * Stop its runs at their times until it is resumed. A run already going is
   * left alone, and Run now still runs it. Pausing a paused one keeps the time
   * it was first paused at.
   */
  pause(id: string, options?: { ownerModuleId?: string }): Promise<ScheduledAgentWriteResult>
  /** Run on its schedule again, from its first time after now: no time missed while paused is made up. */
  resume(id: string, options?: { ownerModuleId?: string }): Promise<ScheduledAgentWriteResult>
  /** Every scheduled agent paused at once, while that holds; null when it does not. */
  pausedAll(): ScheduledAgentsPause | null
  /**
   * Pause every scheduled agent until `until` (null: until `resumeAll`). Each
   * one's own pause is kept apart from this, so resuming them all leaves a
   * schedule paused on its own paused. Pausing them all again moves the until
   * and keeps when it began.
   */
  pauseAll(until: number | null): Promise<{ ok: true; pause: ScheduledAgentsPause } | { ok: false; message: string }>
  /**
   * End the pause of every scheduled agent. `ended`: only that pause, which
   * came to its until — not one the person has set since.
   */
  resumeAll(ended?: ScheduledAgentsPause): Promise<{ ok: true } | { ok: false; message: string }>
  /** Called with the whole list after every change, including a run's outcome. */
  onChanged(listener: (agents: ScheduledAgentView[]) => void): () => void
  /** Something outside a write changed what the list says: a run finished, the computer woke. */
  notifyChanged(): void
  /**
   * Called when a run has started its chat, with the scheduled agent as it
   * ran (its `lastRun` that run) and the chat. A one-time schedule is told
   * before it closes itself, so its run is heard even though the list never
   * shows it again.
   */
  onRun(listener: (agent: ScheduledAgentView, run: ScheduledAgentRun) => void): () => void
  /** A run finished starting, however it went: the scheduler's report. */
  notifyRan(agent: ScheduledAgent, run: ScheduledAgentLastRun): void
}

export type ScheduledAgentsServiceDeps = {
  store: ScheduledAgentsStore
  scheduler: ScheduledAgentsScheduler
  now?: () => number
  /** Keeps the images a prompt names past the temp folder's clearing (`prompt-images.ts`). Absent, prompts are stored as written. */
  promptImages?: ScheduledPromptImages
}

export function createScheduledAgentsService(deps: ScheduledAgentsServiceDeps): ScheduledAgentsService {
  const now = deps.now ?? Date.now
  const listeners = new Set<(agents: ScheduledAgentView[]) => void>()
  const runListeners = new Set<(agent: ScheduledAgentView, run: ScheduledAgentRun) => void>()

  const view = (agent: ScheduledAgent): ScheduledAgentView => ({
    ...agent,
    nextRunAt: deps.scheduler.nextRunAt(agent.id),
  })
  const listViews = (): ScheduledAgentView[] => deps.store.list().map(view)
  // A prompt's temp images, copied where a later run can still read them.
  const withKeptImages = async (draft: ScheduledAgentDraft): Promise<ScheduledAgentDraft> =>
    deps.promptImages ? { ...draft, prompt: await deps.promptImages.keep(draft.prompt) } : draft
  const pruneImages = (): void => {
    if (!deps.promptImages) return
    void deps.promptImages.prune(deps.store.list().map((agent) => agent.prompt)).catch(() => undefined)
  }
  const changed = (): void => {
    deps.scheduler.refresh()
    const views = listViews()
    for (const listener of listeners) listener(views)
  }

  // An extension reaches only the scheduled agents it made; the app reaches all.
  const reachable = (id: string, ownerModuleId: string | undefined): ScheduledAgent | null => {
    const agent = deps.store.get(id)
    if (!agent) return null
    if (ownerModuleId !== undefined && agent.ownerModuleId !== ownerModuleId) return null
    return agent
  }
  const notFound = (id: string) => ({ ok: false as const, message: `No scheduled agent "${id}".` })
  const capped = (draft: ScheduledAgentDraft, capPreset: CapPreset | undefined): ScheduledAgentDraft =>
    capPreset ? { ...draft, permissionPreset: capPreset(draft.permissionPreset) } : draft
  /** A write the store refused (its file could not be read), as the caller's answer rather than a throw. */
  const refused = (error: unknown) => ({
    ok: false as const,
    message: error instanceof Error ? error.message : String(error),
  })

  return {
    list(options) {
      const owner = options?.ownerModuleId
      return listViews().filter((agent) => owner === undefined || agent.ownerModuleId === owner)
    },
    get(id) {
      const agent = deps.store.get(id)
      return agent ? view(agent) : null
    },
    async create(input, options) {
      const validated = validateScheduledAgentDraft(input, now())
      if (!validated.ok) return validated
      const draft = await withKeptImages(capped(validated.draft, options?.capPreset))
      let created: ScheduledAgent
      try {
        created = await deps.store.create(draft, options?.ownerModuleId ?? null)
      } catch (error) {
        return refused(error)
      }
      changed()
      pruneImages()
      return { ok: true, agent: view(created) }
    },
    async update(id, input, options) {
      await deps.store.load()
      if (!reachable(id, options?.ownerModuleId)) return notFound(id)
      const validated = validateScheduledAgentDraft(input, now())
      if (!validated.ok) return validated
      let updated: ScheduledAgent | null
      try {
        updated = await deps.store.update(id, await withKeptImages(capped(validated.draft, options?.capPreset)))
      } catch (error) {
        return refused(error)
      }
      if (!updated) return notFound(id)
      changed()
      pruneImages()
      return { ok: true, agent: view(updated) }
    },
    async remove(id, options) {
      await deps.store.load()
      if (!reachable(id, options?.ownerModuleId)) return notFound(id)
      try {
        await deps.store.remove(id)
      } catch (error) {
        return refused(error)
      }
      changed()
      pruneImages()
      return { ok: true }
    },
    async runNow(id, options) {
      await deps.store.load()
      if (!reachable(id, options?.ownerModuleId)) return notFound(id)
      const fired = await deps.scheduler.runNow(id)
      if (fired.ok) return { ok: true, run: fired.run }
      if (fired.refused === 'unknown') return notFound(id)
      return {
        ok: false,
        message:
          fired.refused === 'still_working'
            ? 'Its last run is still working.'
            : fired.refused === 'stopped'
              ? 'Studio is quitting, so the run did not start.'
              : 'That scheduled agent is already starting a run.',
      }
    },
    async markFailureSeen(id) {
      // Unsaved when the file could not be read; the failure is still shown.
      await deps.store.markFailureSeen(id).catch(() => undefined)
      changed()
    },
    async pause(id, options) {
      await deps.store.load()
      const agent = reachable(id, options?.ownerModuleId)
      if (!agent) return notFound(id)
      if (agent.pausedAt !== undefined) return { ok: true, agent: view(agent) }
      let paused: ScheduledAgent | null
      try {
        paused = await deps.store.setPaused(id, now())
      } catch (error) {
        return refused(error)
      }
      if (!paused) return notFound(id)
      changed()
      return { ok: true, agent: view(paused) }
    },
    async resume(id, options) {
      await deps.store.load()
      const agent = reachable(id, options?.ownerModuleId)
      if (!agent) return notFound(id)
      if (agent.pausedAt === undefined) return { ok: true, agent: view(agent) }
      let resumed: ScheduledAgent | null
      try {
        resumed = await deps.store.setPaused(id, null)
      } catch (error) {
        return refused(error)
      }
      if (!resumed) return notFound(id)
      // Heard before it is viewed, so its next run is the one it now has.
      changed()
      return { ok: true, agent: view(resumed) }
    },
    pausedAll() {
      const pause = deps.store.pausedAll()
      return scheduledAgentsPauseHolds(pause, now()) ? pause : null
    },
    async pauseAll(until) {
      const at = now()
      if (until !== null && (typeof until !== 'number' || !Number.isFinite(until))) {
        return { ok: false, message: 'Pause them until a time, or until they are resumed.' }
      }
      if (until !== null && until <= at) return { ok: false, message: 'That time has already passed.' }
      await deps.store.load()
      const current = deps.store.pausedAll()
      const pause: ScheduledAgentsPause = {
        since: current && scheduledAgentsPauseHolds(current, at) ? current.since : at,
        until,
      }
      try {
        await deps.store.setPausedAll(pause)
      } catch (error) {
        return refused(error)
      }
      changed()
      return { ok: true, pause }
    },
    async resumeAll(ended) {
      await deps.store.load()
      const current = deps.store.pausedAll()
      if (!current) return { ok: true }
      if (ended && (current.since !== ended.since || current.until !== ended.until)) return { ok: true }
      try {
        await deps.store.setPausedAll(null)
      } catch (error) {
        return refused(error)
      }
      changed()
      return { ok: true }
    },
    onChanged(listener) {
      listeners.add(listener)
      return () => listeners.delete(listener)
    },
    notifyChanged: changed,
    onRun(listener) {
      runListeners.add(listener)
      return () => runListeners.delete(listener)
    },
    notifyRan(agent, run) {
      // Only a run that started a chat has one to tell of; one recorded
      // before the chat's agent was kept has no agent to name.
      if (!run.ok || !run.agentId) return
      const ran: ScheduledAgentRun = { at: run.at, workspaceId: run.workspaceId, agentId: run.agentId }
      const viewed: ScheduledAgentView = { ...agent, lastRun: run, nextRunAt: deps.scheduler.nextRunAt(agent.id) }
      for (const listener of [...runListeners]) {
        try {
          listener(viewed, ran)
        } catch {
          // A listener throwing is its own problem; the others still hear the run.
        }
      }
    },
  }
}

/**
 * The extension-facing registry behind the SDK's `getScheduledAgentsService`:
 * the same service, with every call taking the module id first and scoped to
 * what that module created.
 */
export type ScheduledAgentsModuleRegistry = {
  create(moduleId: string, draft: unknown): Promise<ScheduledAgentWriteResult>
  update(moduleId: string, id: string, draft: unknown): Promise<ScheduledAgentWriteResult>
  remove(moduleId: string, id: string): Promise<{ ok: true } | { ok: false; message: string }>
  list(moduleId: string): Promise<ScheduledAgentView[]>
  runNow(moduleId: string, id: string): ReturnType<ScheduledAgentsService['runNow']>
  onChanged(moduleId: string, listener: (agents: ScheduledAgentView[]) => void): () => void
  onRun(moduleId: string, listener: (agent: ScheduledAgentView, run: ScheduledAgentRun) => void): () => void
}

export function createScheduledAgentsModuleRegistry(
  service: ScheduledAgentsService,
  getModulePermissions: (moduleId: string) => readonly string[] | undefined,
): ScheduledAgentsModuleRegistry {
  // A module's schedule starts chats the way its conversation service's
  // `create` does, so it is held to the same ceilings: its own (`auto`, or
  // `bypass` with `conversation:bypass`), and that of the agent whose tool
  // call into the module is running, which the stored preset is pinned to.
  const capFor =
    (moduleId: string): CapPreset =>
    (preset) =>
      clampToModuleToolCaller(
        lowerToModuleCeiling(preset, getModulePermissions(moduleId)) ?? undefined,
        moduleToolCallerCeiling(),
      ) ?? null
  return {
    create: (moduleId, draft) => service.create(draft, { ownerModuleId: moduleId, capPreset: capFor(moduleId) }),
    update: (moduleId, id, draft) =>
      service.update(id, draft, { ownerModuleId: moduleId, capPreset: capFor(moduleId) }),
    remove: (moduleId, id) => service.remove(id, { ownerModuleId: moduleId }),
    list: async (moduleId) => service.list({ ownerModuleId: moduleId }),
    runNow: async (moduleId, id) => {
      const stored = service.list({ ownerModuleId: moduleId }).find((agent) => agent.id === id)
      // Asked during a capped agent's tool call, a run that could start looser
      // than that agent is refused, as the agent's own `schedule.run` is.
      const refused = stored ? refuseScheduledAgentRun(stored.permissionPreset, moduleToolCallerCeiling()) : null
      if (refused) return { ok: false, message: refused.message }
      return service.runNow(id, { ownerModuleId: moduleId })
    },
    onChanged: (moduleId, listener) =>
      service.onChanged((agents) => listener(agents.filter((agent) => agent.ownerModuleId === moduleId))),
    onRun: (moduleId, listener) =>
      service.onRun((agent, run) => {
        if (agent.ownerModuleId === moduleId) listener(agent, run)
      }),
  }
}

/** A preset lowered to the ceiling of a module with these permissions; null (the person's own default) stays null. */
function lowerToModuleCeiling(
  preset: CliPermissionPreset | null,
  permissions: readonly string[] | undefined,
): CliPermissionPreset | null {
  const ceiling = moduleConversationCeiling(permissions ?? [])
  return preset && isLooserCliPermissionPreset(preset, ceiling) ? ceiling : preset
}

/**
 * The scheduled agent as a run starts it: one an extension made goes no looser
 * than that extension may go now, so a module updated without
 * `conversation:bypass`, or no longer installed, does not keep a `bypass`
 * schedule it was once allowed.
 */
export function withinOwnerModuleCeiling(
  agent: ScheduledAgent,
  getModulePermissions: (moduleId: string) => readonly string[] | undefined,
): ScheduledAgent {
  if (!agent.ownerModuleId) return agent
  const permissionPreset = lowerToModuleCeiling(agent.permissionPreset, getModulePermissions(agent.ownerModuleId))
  return permissionPreset === agent.permissionPreset ? agent : { ...agent, permissionPreset }
}
