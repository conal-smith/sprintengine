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
import { noteCliDetected } from '../cli-version-advisory-service'
import { isWslHostId, LOCAL_HOST_ID, type ExecutionHostId } from '../../shared/execution-host'
import type { CliModelDiscoveryInput } from '../../shared/ipc/cli-model-discovery'
import { cliInstallOutputChannel } from '../../shared/ipc/cli-install-output'
import { discoverAndBroadcastCliModels } from './cli-model-discovery-ipc'

type DetectInput = { cli: AgentCli; runtime?: Partial<CliRuntimeSettings> }
type MethodsInput = { cli: AgentCli; runtime?: Partial<CliRuntimeSettings> }
type InstallIpcInput = CliInstallInput & { runtime?: Partial<CliRuntimeSettings> }

type ModelDiscovery = (input: CliModelDiscoveryInput) => Promise<unknown>

type OutputSender = { isDestroyed: () => boolean; send: (channel: string, chunk: string) => void }
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
  } = {},
): void {
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
