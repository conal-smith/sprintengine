// This PC, natively: PowerShell for launches and probes, CIM for process reads.
//
// Everything here existed before hosts did, split across the launch builder,
// the CLI prober and the reaper, each of which asked `process.platform` and a
// per-CLI "run through WSL" switch. The switch is gone: a folder on this PC
// that belongs to a WSL workspace runs on that workspace's `WslHost`, and this
// host is what "This PC (Windows)" means.

import { homedir } from 'node:os'

import { executionHostLabel, LOCAL_HOST_ID, type ExecutionHostSummary } from '../../shared/execution-host'
import { wslToWindowsPath } from '../../shared/host-paths'
import { detectCliBatch } from '../cli-runtime-install'
import { withGitExecutable } from '../git-executable'
import { withGitSafetyConfig } from '../git-run'
import { runSpawnDescriptor } from '../process-run'
import {
  killCliSessionSurvivors,
  probeWindowsSubtrees,
  type SubtreeLiveReason,
  type SubtreeProbeDeps,
} from '../terminal-subtree-probe'
import type { ExecutionHost, HostProcessRef } from './execution-host'
import { localCliRuntime } from './posix-local-host'

export function createWindowsHost(): ExecutionHost {
  const summary: ExecutionHostSummary = {
    id: LOCAL_HOST_ID,
    kind: 'windows',
    label: executionHostLabel(LOCAL_HOST_ID, 'win32'),
    pathStyle: 'windows',
    state: 'ready',
  }
  return {
    id: LOCAL_HOST_ID,
    kind: 'windows',
    pathStyle: 'windows',
    summary: () => summary,
    // A `/mnt/<drive>/…` path names a Windows drive; anything else already is
    // one, or is a Linux path this PC cannot open without knowing its
    // distribution (and that path belongs to a `WslHost`).
    toHostPath: (nativePath) => wslToWindowsPath(nativePath),
    toNativePath: (hostPath) => wslToWindowsPath(hostPath),
    homeDir: async () => {
      const home = homedir()
      return { host: home, native: home }
    },
    prepare: async () => undefined,
    retainSession: () => undefined,
    releaseSession: () => undefined,
    agentIntegration: () => null,
    launchTarget: () => ({ kind: 'windows' }),
    cliRuntime: (_cli, runtime) => localCliRuntime(runtime),
    async probeSubtrees(refs: readonly HostProcessRef[], deps?: SubtreeProbeDeps) {
      const verdicts = await probeWindowsSubtrees(
        refs.map((ref) => ref.rootPid),
        deps,
      )
      const result = new Map<string, SubtreeLiveReason | null>()
      for (const ref of refs) {
        if (verdicts.has(ref.rootPid)) result.set(ref.sessionId, verdicts.get(ref.rootPid) ?? null)
      }
      return result
    },
    killSessionSurvivors: (cliSessionId) =>
      killCliSessionSurvivors(cliSessionId, { platform: 'win32', host: { pathStyle: 'windows' } }),
    detectClis: (requests, options = {}) =>
      detectCliBatch(
        requests.map(({ cli, runtime }) => ({ cli, runtime: localCliRuntime(runtime) })),
        { platform: 'win32', ...(options.force ? { force: true } : {}) },
      ),
    runCommand: (argv, options) =>
      runSpawnDescriptor(
        { file: argv[0] ?? '', args: argv.slice(1) },
        { timeoutMs: options.timeoutMs, ...(options.cwd ? { cwd: options.cwd } : {}) },
      ),
    // The real git.exe rather than Git for Windows' launcher; see git-executable.ts.
    // Under the app's safety config (git-run.ts), which the shared runner may
    // already have put in front.
    runGit: (cwd, args, options) => {
      const env = { ...process.env, ...options.env }
      return withGitExecutable(
        env,
        (file) =>
          runSpawnDescriptor(
            {
              file,
              args: ['-C', cwd, ...withGitSafetyConfig(args)],
              ...(options.stdin !== undefined ? { stdin: options.stdin } : {}),
            },
            { env, ...(options.timeoutMs !== null ? { timeoutMs: options.timeoutMs } : {}) },
          ),
        { didNotStart: (outcome) => outcome.spawnFailed === true },
      )
    },
    dispose: async () => undefined,
  }
}
