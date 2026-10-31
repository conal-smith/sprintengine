import type { IpcRendererEvent } from 'electron'
import { ipc as ipcRenderer } from '../ipc-router'
import type {
  AgentCli,
  CliDetectResult,
  CliInstallInput,
  CliInstallMethodInfo,
  CliInstallResult,
  CliRuntimeSettings,
  ElectronApi,
} from '../../shared/electron-api'
import { cliInstallOutputChannel } from '../../shared/ipc/cli-install-output'
import {
  CLI_UPDATE_ALL_CHANNEL,
  CLI_UPDATE_ALL_PROGRESS_CHANNEL,
  type CliUpdateAllItem,
  type CliUpdateAllResult,
} from '../../shared/ipc/cli-update-all'

// The renderer passes the per-CLI runtime override (command path + WSL flag) so
// detection/install run against the same binary and execution mode the agent
// will actually launch with.
type RuntimeOverride = Partial<CliRuntimeSettings> | undefined

export const cliRuntimeApi = {
  cliDetect: (cli: AgentCli, runtime?: RuntimeOverride): Promise<CliDetectResult> =>
    ipcRenderer.invoke('cli-runtime:detect', { cli, runtime }),
  cliInstallMethods: (cli: AgentCli, runtime?: RuntimeOverride): Promise<CliInstallMethodInfo[]> =>
    ipcRenderer.invoke('cli-runtime:install-methods', { cli, runtime }),
  cliInstall: (input: CliInstallInput, runtime?: RuntimeOverride): Promise<CliInstallResult> =>
    ipcRenderer.invoke('cli-runtime:install', { ...input, runtime }),
  cliUpdate: (cli: AgentCli, runtime?: RuntimeOverride): Promise<CliInstallResult> =>
    ipcRenderer.invoke('cli-runtime:update', { cli, runtime }),
  cliUpdateAll: (): Promise<CliUpdateAllResult> => ipcRenderer.invoke(CLI_UPDATE_ALL_CHANNEL),
  onCliUpdateAllProgress: (cb: (items: CliUpdateAllItem[]) => void): (() => void) => {
    const handler = (_: IpcRendererEvent, items: CliUpdateAllItem[]): void => cb(items)
    ipcRenderer.on(CLI_UPDATE_ALL_PROGRESS_CHANNEL, handler)
    return () => ipcRenderer.removeListener(CLI_UPDATE_ALL_PROGRESS_CHANNEL, handler)
  },
  onCliInstallOutput: (cli: AgentCli, cb: (chunk: string) => void, hostId?: string): (() => void) => {
    const ch = cliInstallOutputChannel(cli, hostId)
    const handler = (_: IpcRendererEvent, chunk: string): void => cb(chunk)
    ipcRenderer.on(ch, handler)
    return () => ipcRenderer.removeListener(ch, handler)
  },
} satisfies Pick<
  ElectronApi,
  | 'cliDetect'
  | 'cliInstallMethods'
  | 'cliInstall'
  | 'cliUpdate'
  | 'cliUpdateAll'
  | 'onCliUpdateAllProgress'
  | 'onCliInstallOutput'
>
