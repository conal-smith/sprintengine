import { createGitWorktree, getGitRepoRoot, removeGitWorktree } from '../git'
import { activeWorktreePool } from '../worktree-pool/active-pool'
import { withGitHost } from '../git-run'
import { hostRegistry } from '../hosts/host-registry'
import { powerActivity } from '../power-activity'
import { writeDiagnosticLog } from '../diagnostics-service'
import {
  ConversationLaunchServiceToken,
  ConversationRuntimeToken,
  ScheduledAgentsModuleServiceToken,
  ScheduledAgentsServiceToken,
} from '../module-host/service-tokens'
import type { CapabilityModule } from '../module-host/load-modules'
import { isRunChatWorking, runScheduledAgent } from '../scheduled-agents/runner'
import { createScheduledRunOutcomes } from '../scheduled-agents/run-outcomes'
import { createScheduledAgentsScheduler } from '../scheduled-agents/scheduler'
import {
  createScheduledAgentsModuleRegistry,
  createScheduledAgentsService,
  withinOwnerModuleCeiling,
  type ScheduledAgentsService,
} from '../scheduled-agents/service'
import { createScheduledAgentsStore, scheduledAgentsFilePath } from '../scheduled-agents/store'
import type { ExecutionHostId } from '../../shared/execution-host'
import {
  SCHEDULED_AGENTS_CHANGED_CHANNEL,
  SCHEDULED_AGENTS_IPC,
  SCHEDULED_AGENTS_PAUSE_CHANGED_CHANNEL,
  scheduledAgentTitle,
  type ScheduledAgentView,
} from '../../shared/scheduled-agents'
import { isRecord } from '../../shared/records'
import type { StudioPlatform } from '../../server/platform/platform'

// The machine whose git answers for a folder: the run's own machine, so its
// worktree names a gitdir that machine can follow. Nothing named leaves the
// resolver to decide.
function gitHostFor(hostId: ExecutionHostId | null) {
  return hostId ? hostRegistry().get(hostId) : null
}

/**
 * `paths` places the schedule file; `clients` hears every change to the list;
 * `getModulePermissions` is what an extension's schedule is held to.
 */
export function createScheduledAgentsModule(
  platform: Pick<StudioPlatform, 'paths' | 'clients'>,
  getModulePermissions: (moduleId: string) => readonly string[] | undefined,
): CapabilityModule {
  const broadcastScheduledAgents = (agents: ScheduledAgentView[], service: ScheduledAgentsService): void => {
    platform.clients.publish(SCHEDULED_AGENTS_CHANGED_CHANNEL, agents)
    // Said with every change rather than only its own: a pause ending at its
    // time is a change too, and a window that missed one hears the next.
    platform.clients.publish(SCHEDULED_AGENTS_PAUSE_CHANGED_CHANNEL, service.pausedAll())
  }
  return {
    manifest: {
      id: 'scheduled-agents',
      displayName: 'Scheduled agents',
      version: 1,
      publisher: 'sprintengine',
      category: 'orchestration',
      summary: 'Start a chat agent with a prompt on a schedule.',
      defaultEnabled: true,
      dependsOn: ['agent-runtime'],
    },
    registerMain(host) {
      const conversationLaunchService = host.requireService(ConversationLaunchServiceToken)
      const conversations = host.requireService(ConversationRuntimeToken)
      const store = createScheduledAgentsStore({
        filePath: scheduledAgentsFilePath(platform.paths.dataDir()),
        warn: (message) => console.warn(`[scheduled-agents] ${message}`),
      })
      // Late-bound: the scheduler reports a finished run to the service, which
      // is built around the scheduler.
      let service: ScheduledAgentsService | null = null
      const outcomes = createScheduledRunOutcomes({
        store,
        notifyRan: (agent, run) => service?.notifyRan(agent, run),
        notifyChanged: () => service?.notifyChanged(),
        warn: (message) => console.warn(`[scheduled-agents] ${message}`),
      })
      const scheduler = createScheduledAgentsScheduler({
        list: () => store.list(),
        recordRun: outcomes.recordRun,
        onRan: outcomes.onRan,
        isRunWorking: (workspaceId) => {
          const listed = conversations.listSessions({ workspaceId })
          return listed.ok && isRunChatWorking(listed.sessions)
        },
        pausedAll: () => store.pausedAll(),
        // A pause of everything that came to its until ends; the schedules
        // count on from now, so nothing missed while it held runs.
        onPauseAllEnded: (pause) => {
          void service?.resumeAll(pause).then((ended) => {
            if (!ended.ok) console.warn(`[scheduled-agents] ${ended.message}`)
          })
        },
        // A skipped time is not a failed run — nothing was tried, and the
        // schedule's card has nothing to say about it — but it is written down,
        // so "why did it not run at nine" has an answer.
        log: (message) => console.warn(`[scheduled-agents] ${message}`),
        onSkipped: (agent, reason) => {
          // The skipped time moved its next run on: say so, or every window
          // keeps showing the passed time as "now" until something else changes.
          service?.notifyChanged()
          const workspaceId = agent.lastRun?.ok ? agent.lastRun.workspaceId : undefined
          void writeDiagnosticLog({
            level: 'info',
            source: 'agents',
            title: 'Scheduled run skipped',
            message:
              reason === 'still_working'
                ? `"${scheduledAgentTitle(agent.prompt, agent.name)}" did not start a run: its last run is still working.`
                : `"${scheduledAgentTitle(agent.prompt, agent.name)}" did not start a run: its last one is still starting.`,
            ...(workspaceId ? { workspaceId } : {}),
          }).catch(() => undefined)
        },
        run: (agent, signal) =>
          runScheduledAgent(
            withinOwnerModuleCeiling(agent, getModulePermissions),
            {
              launchConversation: (request) => conversationLaunchService.launch(request),
              getRepoRoot: (folderPath, hostId) => withGitHost(gitHostFor(hostId), () => getGitRepoRoot(folderPath)),
              createWorktree: async (input) => {
                const created = await withGitHost(gitHostFor(input.hostId), () =>
                  createGitWorktree({
                    repoRoot: input.repoRoot,
                    containerPath: input.containerPath,
                    destinationPath: input.destinationPath,
                    branchName: input.branchName,
                    baseRef: 'HEAD',
                    // On the default branch, from the worktree pool when this
                    // process keeps one: a run starts from what is merged, not
                    // from whatever branch the checkout happens to be on.
                    fromPool: true,
                    copyIncludedFiles: true,
                    // The chat is created after its worktree, so the branch names the owner.
                    agentLockOwner: input.branchName,
                    // Named to the pool too: it serves this machine's own git
                    // alone, and a run on a WSL machine (its folder may well be a
                    // Windows drive) must get a fresh worktree from that git.
                    ...(input.hostId ? { hostId: input.hostId } : {}),
                  }),
                )
                return created.ok
                  ? {
                      ok: true,
                      path: created.data.path,
                      branch: created.data.branch ?? input.branchName,
                      leaseId: created.data.leaseId,
                    }
                  : { ok: false, message: created.message }
              },
              // A pool slot goes back to the pool; a fresh worktree is removed.
              discardWorktree: async ({ repoRoot, path, leaseId, hostId }) => {
                const pool = leaseId ? activeWorktreePool() : null
                if (pool && leaseId) {
                  await pool.release(leaseId)
                  return
                }
                await withGitHost(gitHostFor(hostId), () => removeGitWorktree({ repoRoot, path, force: true }))
              },
              onFirstSendFailed: (workspaceId, message) => outcomes.firstSendFailed(agent.id, workspaceId, message),
            },
            signal,
          ),
      })
      const scheduledAgents = createScheduledAgentsService({ store, scheduler })
      service = scheduledAgents
      host.provideService(ScheduledAgentsServiceToken, () => scheduledAgents)
      host.provideService(ScheduledAgentsModuleServiceToken, () =>
        createScheduledAgentsModuleRegistry(scheduledAgents, getModulePermissions),
      )
      const unsubscribe = scheduledAgents.onChanged((agents) => broadcastScheduledAgents(agents, scheduledAgents))
      host.onShutdown(unsubscribe)

      const idOf = (input: unknown): string => (isRecord(input) && typeof input.id === 'string' ? input.id : '')
      // The window's channels are up before the scheduler's sidecar reads the
      // file; each waits for that read (the store's own), so an early write
      // does not replace the file with only its own entry.
      host.registerIpc(SCHEDULED_AGENTS_IPC.list, async () => {
        await store.load()
        return scheduledAgents.list()
      })
      host.registerIpc(SCHEDULED_AGENTS_IPC.create, async (_event, input: unknown) =>
        scheduledAgents.create(isRecord(input) ? input.draft : undefined),
      )
      host.registerIpc(SCHEDULED_AGENTS_IPC.update, async (_event, input: unknown) =>
        scheduledAgents.update(idOf(input), isRecord(input) ? input.draft : undefined),
      )
      host.registerIpc(SCHEDULED_AGENTS_IPC.remove, async (_event, input: unknown) =>
        scheduledAgents.remove(idOf(input)),
      )
      host.registerIpc(SCHEDULED_AGENTS_IPC.runNow, async (_event, input: unknown) =>
        scheduledAgents.runNow(idOf(input)),
      )
      host.registerIpc(SCHEDULED_AGENTS_IPC.markSeen, async (_event, input: unknown) => {
        await scheduledAgents.markFailureSeen(idOf(input))
        return { ok: true }
      })
      host.registerIpc(SCHEDULED_AGENTS_IPC.pause, async (_event, input: unknown) => scheduledAgents.pause(idOf(input)))
      host.registerIpc(SCHEDULED_AGENTS_IPC.resume, async (_event, input: unknown) =>
        scheduledAgents.resume(idOf(input)),
      )
      host.registerIpc(SCHEDULED_AGENTS_IPC.pauseState, async () => {
        await store.load()
        return scheduledAgents.pausedAll()
      })
      host.registerIpc(SCHEDULED_AGENTS_IPC.pauseAll, async (_event, input: unknown) =>
        // Checked by the service: a time to come, or null for until resumed.
        scheduledAgents.pauseAll((isRecord(input) ? (input.until ?? null) : null) as number | null),
      )
      host.registerIpc(SCHEDULED_AGENTS_IPC.resumeAll, async () => scheduledAgents.resumeAll())

      let releaseWakeOnResume: (() => void) | null = null
      host.registerSidecar(
        {
          id: 'scheduled-agents-scheduler',
          kind: 'scheduler',
          description: 'Starts each scheduled agent’s chat when its schedule comes round.',
          startOn: 'startup',
        },
        {
          start: async () => {
            await store.load()
            scheduler.start()
            scheduledAgents.notifyChanged()
            // A timer armed before a sleep counts only awake time, so a run
            // that came due during the nap is found on waking.
            releaseWakeOnResume?.()
            releaseWakeOnResume = powerActivity.onResume(() => scheduledAgents.notifyChanged())
          },
          stop: async () => {
            releaseWakeOnResume?.()
            releaseWakeOnResume = null
            scheduler.stop()
          },
          status: () => ({ state: scheduler.isRunning() ? 'running' : 'stopped' }),
        },
      )
    },
  }
}
