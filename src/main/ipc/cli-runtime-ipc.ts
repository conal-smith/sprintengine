import type { IpcMain } from 'electron'

import type {
  AgentCli,
  CliDetectResult,
  CliInstallInput,
  CliInstallMethodInfo,
  CliInstallResult,
  CliRuntimeSettings,
} from '../../shared/electron-api'
import { recordCliDetection } from '../cli-availability'
import { cliInstallMethods, detectCli, installCli, updateCli } from '../cli-runtime-install'
import { noteCliDetected, outdatedCliTargets, type CliUpdateTarget } from '../cli-version-advisory-service'
import {
  CLI_UPDATE_ALL_CHANNEL,
  CLI_UPDATE_ALL_PROGRESS_CHANNEL,
  type CliUpdateAllItem,
  type CliUpdateAllResult,
} from '../../shared/ipc/cli-update-all'
import { isWslHostId, LOCAL_HOST_ID, type ExecutionHostId } from '../../shared/execution-host'
import type { CliModelDiscoveryInput } from '../../shared/ipc/cli-model-discovery'
import { cliInstallOutputChannel } from '../../shared/ipc/cli-install-output'
import { discoverAndBroadcastCliModels } from './cli-model-discovery-ipc'

type DetectInput = { cli: AgentCli; runtime?: Partial<CliRuntimeSettings> }
type MethodsInput = { cli: AgentCli; runtime?: Partial<CliRuntimeSettings> }
type InstallIpcInput = CliInstallInput & { runtime?: Partial<CliRuntimeSettings> }

type ModelDiscovery = (input: CliModelDiscoveryInput) => Promise<unknown>

type OutputSender = {
  isDestroyed: () => boolean
  send: (channel: string, payload: string | CliUpdateAllItem[]) => void
}
type CliRun = { kind: 'install' | 'update'; senders: Set<OutputSender>; result: Promise<CliInstallResult> }

export function registerCliRuntimeIpc(
  ipcMain: IpcMain,
  options: {
    /**
     * The pass that follows an install. In process it runs here; with the
     * Studio server in a process of its own it runs there, the one writer of
     * the model catalog cache.
     */
    discoverModels?: ModelDiscovery
    /** What Update everything updates; the version check's outdated CLIs unless a test names its own. */
    outdatedTargets?: () => Promise<{ ok: true; targets: CliUpdateTarget[] } | { ok: false; message: string }>
  } = {},
): void {
  const outdatedTargets = options.outdatedTargets ?? outdatedCliTargets
  const discoverModels: ModelDiscovery = options.discoverModels ?? ((input) => discoverAndBroadcastCliModels(input))
  // A row's own detection (opening it, or its Re-check): a probe of this one
  // CLI on this one machine, which the shared answer takes on, so the list, the
  // pickers and the version check agree with what the row just found.
  ipcMain.handle('cli-runtime:detect', async (_, input: DetectInput): Promise<CliDetectResult> => {
    const result = await detectCli(input.cli, input.runtime)
    // A changed answer schedules the version check's comparison (app-services).
    if (result.error === null) recordCliDetection(input.runtime, result)
    return result
  })
  ipcMain.handle('cli-runtime:install-methods', (_, input: MethodsInput): Promise<CliInstallMethodInfo[]> =>
    cliInstallMethods(input.cli, input.runtime),
  )
  // One install or update of a CLI on a machine at a time. Two package
  // managers writing the same global install at once (an Update pressed in two
  // windows, or in the toast and the Settings row) can leave it broken. A
  // second request of the same kind joins the one running, so its window reads
  // the same log and gets the same answer; one of the other kind is turned
  // away. Another machine's copy is its own, and runs beside it.
  const runs = new Map<string, CliRun>()
  const exclusive = (
    kind: CliRun['kind'],
    sender: OutputSender,
    cli: AgentCli,
    runtime: Partial<CliRuntimeSettings> | undefined,
    start: (onData: (chunk: string) => void) => Promise<CliInstallResult>,
  ): Promise<CliInstallResult> => {
    const hostId = machineOf(runtime)
    const key = `${cli}\0${hostId}`
    const running = runs.get(key)
    if (running) {
      if (running.kind !== kind) return Promise.resolve(alreadyRunning(cli, running.kind))
      running.senders.add(sender)
      return running.result
    }
    const channel = cliInstallOutputChannel(cli, hostId)
    const senders = new Set<OutputSender>([sender])
    const result = start((chunk) => {
      for (const each of senders) if (!each.isDestroyed()) each.send(channel, chunk)
    })
      .then((done) => {
        afterInstall(cli, runtime, done, discoverModels)
        return done
      })
      .finally(() => runs.delete(key))
    runs.set(key, { kind, senders, result })
    return result
  }
  ipcMain.handle('cli-runtime:install', (event, input: InstallIpcInput): Promise<CliInstallResult> =>
    exclusive('install', event.sender, input.cli, input.runtime, (onData) =>
      installCli({ cli: input.cli, methodId: input.methodId }, input.runtime, onData),
    ),
  )
  // Update action: the CLI's own updater where the manifest declares
  // one, else a re-run of the install spec. Streams onto the same output
  // channel installs use so one listener serves both flows.
  ipcMain.handle('cli-runtime:update', (event, input: DetectInput): Promise<CliInstallResult> =>
    exclusive('update', event.sender, input.cli, input.runtime, (onData) =>
      updateCli(input.cli, input.runtime, onData),
    ),
  )

  // Update everything: each outdated CLI on each machine, through the same
  // lock and log a row's Update takes, so one already updating from a row is
  // joined rather than run twice. A machine's CLIs go one after another (two
  // package managers on one machine can share a global prefix); machines run
  // beside each other. Every window that asked is told each time an item
  // moves, and a second ask while one runs joins it.
  let updateAll: { senders: Set<OutputSender>; result: Promise<CliUpdateAllResult> } | null = null
  ipcMain.handle(CLI_UPDATE_ALL_CHANNEL, (event): Promise<CliUpdateAllResult> => {
    if (updateAll) {
      updateAll.senders.add(event.sender)
      return updateAll.result
    }
    const senders = new Set<OutputSender>([event.sender])
    const result = runUpdateAll(senders).finally(() => {
      updateAll = null
    })
    updateAll = { senders, result }
    return result
  })

  async function runUpdateAll(senders: Set<OutputSender>): Promise<CliUpdateAllResult> {
    const listed = await outdatedTargets()
    if (!listed.ok) return listed
    const items: CliUpdateAllItem[] = listed.targets.map((target) => ({
      hostId: target.hostId,
      cli: target.cli,
      from: target.currentVersion,
      latest: target.latestVersion,
      state: 'queued',
    }))
    const tell = () => {
      const snapshot = items.map((item) => ({ ...item }))
      for (const sender of senders) if (!sender.isDestroyed()) sender.send(CLI_UPDATE_ALL_PROGRESS_CHANNEL, snapshot)
    }
    tell()
    const byMachine = new Map<string, number[]>()
    listed.targets.forEach((target, index) => {
      byMachine.set(target.hostId, [...(byMachine.get(target.hostId) ?? []), index])
    })
    // Output goes to whoever is following that CLI's row, as a row's Update does.
    const quiet: OutputSender = { isDestroyed: () => false, send: () => undefined }
    await Promise.all(
      [...byMachine.values()].map(async (indexes) => {
        for (const index of indexes) {
          const target = listed.targets[index]!
          const item = items[index]!
          item.state = 'updating'
          tell()
          try {
            const done = await exclusive('update', quiet, target.cli, target.runtime, (onData) =>
              updateCli(target.cli, target.runtime, onData),
            )
            item.to = done.version
            if (!done.ok) {
              item.state = 'failed'
              item.error = done.error ?? 'The update did not finish.'
            } else {
              item.state =
                done.version && done.version.trim() === (target.currentVersion ?? '').trim() ? 'unchanged' : 'updated'
            }
          } catch (error) {
            item.state = 'failed'
            item.error = error instanceof Error ? error.message : String(error)
          }
          tell()
        }
      }),
    )
    return { ok: true, items: items.map((item) => ({ ...item })) }
  }
}

// The machine a runtime override names, as the version check and the output
// channel key it: a WSL distribution, else this machine.
function machineOf(runtime: Partial<CliRuntimeSettings> | undefined): ExecutionHostId {
  return isWslHostId(runtime?.hostId) ? runtime.hostId : LOCAL_HOST_ID
}

function alreadyRunning(cli: AgentCli, kind: CliRun['kind']): CliInstallResult {
  return {
    ok: false,
    cli,
    installed: false,
    version: null,
    resolvedPath: null,
    log: '',
    error: `It is already being ${kind === 'update' ? 'updated' : 'installed'} on this machine. Try again once that has finished.`,
  }
}

// Both flows end by detecting their CLI again on the machine they ran on. That
// answer is the new truth for that one CLI there: it replaces the cached one,
// and the version advisories are compared again from it, so the row's version
// moves and its update badge clears without re-scanning every CLI. Only a CLI
// found afterwards is recorded; one that was not may be a detection that could
// not run, and the next read looks again.
//
// A new binary is a new model list too: the version it reports no longer
// matches the one that produced the stored catalog, so this pass re-probes it
// (and a first install gets its first catalog) without waiting for the next
// refresh. Neither is awaited — the result goes back to Settings at once.
function afterInstall(
  cli: AgentCli,
  runtime: Partial<CliRuntimeSettings> | undefined,
  result: CliInstallResult,
  discoverModels: ModelDiscovery,
): void {
  if (!result.installed) return
  const hostId = machineOf(runtime)
  void noteCliDetected(runtime, {
    cli,
    binary: runtime?.command?.trim() || cli,
    installed: true,
    version: result.version,
    resolvedPath: result.resolvedPath,
    hostId,
    error: null,
  }).catch(() => undefined)
  if (!result.ok) return
  void discoverModels({ clis: [cli], ...(runtime ? { cliRuntimes: { [cli]: runtime } } : {}) }).catch(() => undefined)
}
