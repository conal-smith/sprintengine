import { randomUUID } from 'node:crypto'
import { hostname } from 'node:os'

import type { AutomationBackends } from '../../main/automation/automation-tools'
import { createTailnetShareService, readTailnetWebTargets } from '../../main/automation/tailnet/tailnet-share-service'
import {
  addOrUpdateBacklogLink,
  listBacklogItems,
  readBacklogItem,
  repairBacklogIntegrity,
  updateBacklogDependenciesPlanned,
  updateBacklogEpic,
  updateBacklogStatus,
  updateBacklogTriage,
  updateBacklogType,
} from '../../main/backlog-service'
import { ensureSkillInstalled } from '../../main/builtin-skills'
import { createGitWorktree, getGitRepoRoot } from '../../main/git'
import { startedDependencyInstall } from '../../main/worktree-pool/dependency-install'
import { readBranchName, resolveTrunk } from '../../main/git-branch-span'
import { getGitBranches } from '../../main/git-read-models'
import { listGitWorktrees } from '../../main/git-worktree-list'
import { hostRegistry } from '../../main/hosts/host-registry'
import { MobileControlCommandService } from '../../main/mobile/control/command'
import { deepRedactLocalPaths } from '../../main/mobile/control/path-safety'
import {
  mobileControlProtocolVersion,
  mobileSnapshotCollections,
  type MobileControlCommandType,
  type MobileSnapshotCollection,
} from '../../main/mobile/control/protocol'
import { MobileControlSnapshotService, sanitizeMobileSnapshotForTransport } from '../../main/mobile/control/snapshot'
import { getPluginRegistry } from '../../main/plugin-registry-instance'
import { readRepositoryIdentity } from '../../main/repository-identity'
import { listKnownWorkspaceRoots, uniqueResolvedRoots } from '../../main/workspace-roots'
import { readDiscoveredCliModelCatalogs } from '../../main/model-discovery/service'
import { effectiveAgentLaunchSettings, type AgentLaunchSettings } from '../../shared/launch-settings'
import { agentWorktreePaths } from '../../shared/worktree-paths'

// The gateway's automation backends that are the server's own: backlog reads
// and writes, the mobile companion's snapshot and command lane, agent
// worktrees, a checkout's branches, a folder's repository identity, the CLI
// plugins and the built-in skill installer. Built here, free of Electron, so
// the desktop composes them in process and the Studio server composes the same
// ones out of process; only what reaches a screen, a terminal or the shell's
// caches is handed in.

export type GatewayBackendDeps = Pick<
  AutomationBackends,
  | 'getWorkspaceSyncSnapshot'
  | 'listTerminalSessions'
  | 'readTerminalOutputTail'
  | 'launchAgent'
  | 'linkLaunchedAgent'
  | 'resolveAgentPermissionPreset'
  | 'createWorkspace'
  | 'getScheduledAgents'
  | 'defaultChatCli'
  | 'projectUsage'
  | 'getModuleRegistrySnapshot'
  | 'listInstalledThirdPartyModules'
  | 'listModuleContributedTools'
  | 'readMarketplaceRegistry'
  | 'readWorkspaceExtensions'
> & {
  /**
   * The ids the person added for a CLI in Settings, from the launch settings
   * this process holds. Given, `cli.runtime.list` answers each CLI with the
   * model picker's own rows (`readCliModelSources`); a gateway that does not
   * serve that tool leaves it out.
   */
  userCliModels?: (cli: string) => readonly string[] | undefined
}

/**
 * What the gateway reads from the launch settings this process holds: the
 * CLI a new chat starts with, the projects' usage, and the ids the person
 * added for each CLI. One helper, so the gateways built in process, out of
 * process and for the shell read them alike.
 */
export function launchSettingsGatewayDeps(settings: {
  get(): AgentLaunchSettings
}): Pick<GatewayBackendDeps, 'defaultChatCli' | 'projectUsage' | 'userCliModels'> {
  return {
    defaultChatCli: () => effectiveAgentLaunchSettings(settings.get()).lastSelectedCli ?? null,
    projectUsage: () => settings.get().projectUsage,
    userCliModels: (cli) => settings.get().cliRuntimes[cli]?.models,
  }
}

export function createServerGatewayBackends(deps: GatewayBackendDeps): AutomationBackends {
  const { userCliModels, ...backends } = deps
  return {
    ...backends,
    // The model picker's sources, read where the picker's are: the discovery
    // cache under this profile's user data, and the person's own ids.
    ...(userCliModels
      ? {
          readCliModelSources: async () => ({
            discovered: await readDiscoveredCliModelCatalogs().catch(() => ({})),
            userModels: userCliModels,
          }),
        }
      : {}),
    listBacklogItems: (workspaceRoot) => listBacklogItems(workspaceRoot),
    readBacklogItem: (workspaceRoot, relativePath) => readBacklogItem(workspaceRoot, relativePath),
    backlogWrite: {
      updateStatus: updateBacklogStatus,
      updateType: updateBacklogType,
      updateTriage: updateBacklogTriage,
      updateEpic: updateBacklogEpic,
      updateDependenciesPlanned: updateBacklogDependenciesPlanned,
      addOrUpdateLink: addOrUpdateBacklogLink,
      repairIntegrity: repairBacklogIntegrity,
    },
    // The mobile companion, which reaches this desktop only over the tailnet
    // gateway: the snapshot builder and the command service behind
    // `workspace.snapshot` and `workspace.mobile_command`, scoped to the
    // workspaces the registry knows. Both are stateless enough to own here,
    // and nothing else holds an instance: this desktop publishes nothing to a
    // phone, it only answers what a paired device asks.
    mobileControl: createMobileControl(() => deps.getWorkspaceSyncSnapshot()),
    // Agent-at-launch worktrees (agent.launch isolation + every connector
    // launch): derive the `agent/<slug>` branch and container the Worktree
    // manager uses, then create through the shared git helper. Mirrors
    // WorkspaceManager's own worktree-agent spawn (copyIncludedFiles carries
    // the repo's worktree-include set into the isolated tree).
    createAgentWorktree: async ({ workspaceRoot, name, baseRef }) => {
      const paths = agentWorktreePaths(workspaceRoot, name)
      if (!paths) return { error: `"${name}" does not reduce to a usable worktree name.` }
      const named = baseRef?.trim()
      const created = await createGitWorktree({
        repoRoot: workspaceRoot,
        containerPath: paths.containerPath,
        destinationPath: paths.destinationPath,
        branchName: paths.branchName,
        // A remote launch names the branch to fork from (its picker lists
        // this checkout's branches); a launch that names none forks the
        // default branch, from the worktree pool when this process keeps one.
        baseRef: named || 'HEAD',
        fromPool: !named,
        copyIncludedFiles: true,
        // The agent's id is minted after this, by the launch; the branch
        // names the owner until then.
        agentLockOwner: paths.branchName,
        // A gateway call answers while the project's dependency install
        // runs, and the launch waits on it instead (`agent.launch`): the
        // call's client would give up long before an install ends.
        dependencyInstall: 'start',
      })
      if (!created.ok) return { error: created.message ?? 'Git worktree creation failed.' }
      const installing = startedDependencyInstall(created.data.dependencyInstall)
      return {
        worktreePath: created.data.path,
        branch: created.data.branch ?? paths.branchName,
        ...(installing ? { dependencyInstall: installing } : {}),
      }
    },
    readRepositoryIdentity: (folderPath) => readRepositoryIdentity(folderPath),
    // The facts behind `workspace.checkout` (checkout-and-branch-on-remote-
    // create): the same readers the sidebar rows and the Worktree manager
    // use, so a remote picker lists exactly what this machine's Git view
    // would. Not a repo is an answer, not an error.
    readWorkspaceCheckout: async (workspaceRoot) => {
      const empty = { git: false as const, branch: null, defaultBranch: null, branches: [], worktrees: [] }
      const repoRoot = await getGitRepoRoot(workspaceRoot).catch(() => null)
      if (!repoRoot) return empty
      const [branch, snapshot, worktrees] = await Promise.all([
        readBranchName(repoRoot),
        getGitBranches(repoRoot).catch(() => null),
        listGitWorktrees(repoRoot).catch(() => null),
      ])
      const trunk = await resolveTrunk(repoRoot, branch).catch(() => null)
      return {
        git: true,
        branch,
        defaultBranch: trunk?.name ?? null,
        // `git branch` prints a detached HEAD as a pseudo-entry,
        // "(HEAD detached at abc)", marked current; it is not a ref
        // anyone can fork from and is dropped.
        branches: (snapshot?.branches ?? [])
          .filter((entry) => !entry.name.startsWith('('))
          .map((entry) => ({ name: entry.name, current: entry.current })),
        worktrees: worktrees?.ok
          ? worktrees.data.worktrees
              .filter((entry) => !entry.bare)
              // `git worktree list` names the main worktree first, always.
              .map((entry, index) => ({ path: entry.path, branch: entry.branch, isMain: index === 0 }))
          : [],
      }
    },
    // backlog.work composes the target CLI's native skill invocation from the
    // loaded plugin manifests.
    listPlugins: () => getPluginRegistry().loaded(),
    // backlog.work ensures the Backlog skill exists in the CLI's native dir
    // before launch (the same getStatus → install seam as a spawn). Reports
    // whether the skill is now present; a false result is non-fatal. Asked
    // of the machine the agent will run on: a WSL machine is prepared
    // first (the launch that follows waits for the same), so its answer
    // is the one that launch will act on.
    ensureBuiltinSkillInstalled: async (workspaceRoot, skillId, cli, hostId) => {
      const host = hostRegistry().resolve({ requested: hostId ?? null, folder: workspaceRoot })
      if (host.kind === 'wsl') await host.prepare().catch(() => undefined)
      const result = await ensureSkillInstalled(workspaceRoot, skillId, {
        cli,
        hostId: host.id,
        integration: host.agentIntegration(),
      })
      if (!result.ok && result.status === 'unknown-skill') {
        console.warn(`[skills] backlog.work asked for unknown skill "${skillId}".`)
      }
      return result.ok
    },
  }
}

function createMobileControl(
  getWorkspaceSyncSnapshot: AutomationBackends['getWorkspaceSyncSnapshot'],
): AutomationBackends['mobileControl'] {
  // Dev servers this machine publishes on the tailnet ride the snapshot
  // so the phone has a door to them. Stateless; the daemon is the truth.
  const shareService = createTailnetShareService()
  const snapshotService = new MobileControlSnapshotService({
    readWebTargets: () => readTailnetWebTargets(shareService),
  })
  const commandService = new MobileControlCommandService()
  // Stable for the app's lifetime; the phone treats it as an opaque id.
  const desktopSessionId = `tailnet:${hostname()}`
  // The commands the gateway transport actually serves: snapshot reads
  // via workspace.snapshot, mutations via workspace.mobile_command's
  // allowlist. Advertised in the snapshot so the phone's affordance
  // gate shows exactly what will work over this transport.
  const gatewayCommands: MobileControlCommandType[] = ['snapshot.request', 'backlog.update']
  const workspaceRoots = () => uniqueResolvedRoots(listKnownWorkspaceRoots(getWorkspaceSyncSnapshot()))
  return {
    async readSnapshot(input: { include?: string[]; knownSnapshotVersion?: string }) {
      const roots = workspaceRoots()
      // An empty or absent `include` is the default set. A named one is
      // served exactly, retired names included: they select nothing, so
      // a read that names only a retired collection gets an empty
      // snapshot rather than silently widening to every collection.
      const include =
        input.include && input.include.length > 0
          ? input.include.filter((entry): entry is MobileSnapshotCollection =>
              (mobileSnapshotCollections as readonly string[]).includes(entry),
            )
          : undefined
      const snapshot = await snapshotService.readSnapshot({
        desktopSessionId,
        workspaceRoots: roots,
        commands: gatewayCommands,
        ...(include ? { include } : {}),
      })
      // The version is computed before sanitizing and sanitizing
      // keeps it, so an unchanged read is answered without the copy.
      if (input.knownSnapshotVersion && input.knownSnapshotVersion === snapshot.snapshotVersion) {
        return { unchanged: true as const, snapshotVersion: snapshot.snapshotVersion }
      }
      const safe = sanitizeMobileSnapshotForTransport(snapshot)
      return { unchanged: false as const, snapshot: safe as unknown as Record<string, unknown> }
    },
    async dispatchCommand(input: {
      type: string
      payload: Record<string, unknown>
      deviceId: string
      idempotencyKey: string
      expectedSnapshotVersion?: string
    }) {
      const result = await commandService.dispatch(
        {
          protocolVersion: mobileControlProtocolVersion,
          commandId: `tnc_${randomUUID()}`,
          type: input.type,
          payload: input.payload,
          deviceId: input.deviceId,
          issuedAt: new Date().toISOString(),
          idempotencyKey: input.idempotencyKey,
          ...(input.expectedSnapshotVersion ? { expectedSnapshotVersion: input.expectedSnapshotVersion } : {}),
        },
        { allowedWorkspaceRoots: workspaceRoots() },
      )
      if (!result.ok) {
        return { ok: false as const, code: result.error.code, message: result.error.message }
      }
      return {
        ok: true as const,
        commandId: result.commandId,
        commandType: result.commandType,
        executedAt: result.executedAt,
        // The result crosses to another device: local paths never do.
        data: deepRedactLocalPaths(result.data),
      }
    },
  }
}
