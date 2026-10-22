// This Mac, or this Linux machine: the only host there is on macOS and Linux.
//
// It is a move, not a change. Every method is what those platforms did before
// hosts existed — the POSIX launch script, `ps` and `lsof` for the reaper, a
// login-shell PATH for CLI detection — reached through the host interface so a
// caller no longer asks `process.platform` itself.

import { homedir } from 'node:os'

import type { CliRuntimeSettings } from '../../shared/electron-api'
import { executionHostLabel, LOCAL_HOST_ID, type ExecutionHostSummary } from '../../shared/execution-host'
import { detectCliBatch } from '../cli-runtime-install'
import { withGitSafetyConfig } from '../git-run'
import { runSpawnDescriptor } from '../process-run'
import {
  killCliSessionSurvivors,
  probeSubtreesForLiveWork,
  type SubtreeLiveReason,
  type SubtreeProbeDeps,
} from '../terminal-subtree-probe'
import type { ExecutionHost, HostProcessRef } from './execution-host'

/** The CLI runtime with only what a launch reads: this machine's command, and the models. */
export function localCliRuntime(runtime: Partial<CliRuntimeSettings> | undefined): CliRuntimeSettings {
  return {
    command: typeof runtime?.command === 'string' ? runtime.command.trim() : '',
    ...(runtime?.models ? { models: runtime.models } : {}),
  }
}

export function createPosixLocalHost(platform: NodeJS.Platform = process.platform): ExecutionHost {
  const summary: ExecutionHostSummary = {
    id: LOCAL_HOST_ID,
    kind: 'posix',
    label: executionHostLabel(LOCAL_HOST_ID, platform),
    pathStyle: 'posix',
    state: 'ready',
  }
  return {
    id: LOCAL_HOST_ID,
    kind: 'posix',
    pathStyle: 'posix',
    summary: () => summary,
    toHostPath: (nativePath) => nativePath,
    toNativePath: (hostPath) => hostPath,
    homeDir: async () => {
      const home = homedir()
      return { host: home, native: home }
    },
    prepare: async () => undefined,
    retainSession: () => undefined,
    releaseSession: () => undefined,
    agentIntegration: () => null,
    launchTarget: () => ({ kind: 'posix' }),
    cliRuntime: (_cli, runtime) => localCliRuntime(runtime),
    async probeSubtrees(refs: readonly HostProcessRef[], deps?: SubtreeProbeDeps) {
      const verdicts = await probeSubtreesForLiveWork(
        refs.map((ref) => ref.rootPid),
        { platform, ...deps },
      )
      const result = new Map<string, SubtreeLiveReason | null>()
      for (const ref of refs) {
        if (verdicts.has(ref.rootPid)) result.set(ref.sessionId, verdicts.get(ref.rootPid) ?? null)
      }
      return result
    },
    killSessionSurvivors: (cliSessionId) =>
      killCliSessionSurvivors(cliSessionId, { platform, host: { pathStyle: 'posix' } }),
    detectClis: (requests, options = {}) =>
      detectCliBatch(
        requests.map(({ cli, runtime }) => ({ cli, runtime: localCliRuntime(runtime) })),
        { platform, ...(options.force ? { force: true } : {}) },
      ),
    runCommand: (argv, options) =>
      runSpawnDescriptor(
        { file: argv[0] ?? '', args: argv.slice(1) },
        { timeoutMs: options.timeoutMs, ...(options.cwd ? { cwd: options.cwd } : {}) },
      ),
    // Under the app's safety config (git-run.ts), which the shared runner may
    // already have put in front.
    runGit: (cwd, args, options) =>
      runSpawnDescriptor(
        {
          file: 'git',
          args: ['-C', cwd, ...withGitSafetyConfig(args)],
          ...(options.stdin !== undefined ? { stdin: options.stdin } : {}),
        },
        {
          env: { ...process.env, ...options.env },
          ...(options.timeoutMs !== null ? { timeoutMs: options.timeoutMs } : {}),
        },
      ),
    dispose: async () => undefined,
  }
}
