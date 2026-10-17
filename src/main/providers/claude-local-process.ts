import { spawn, type ChildProcess } from 'node:child_process'

/**
 * Starts a Claude CLI on this machine, on POSIX as the leader of its own
 * process group. When the CLI ends it stops the MCP servers it started, but
 * not what those started: a plugin's `bun run start` wrapper goes and its
 * `bun server.ts` stays, with nobody reading its output, after every closed
 * chat, idle release and respawn. Those stay in the CLI's group, so once the
 * CLI exits, for any reason, whatever is left of the group is ended too.
 *
 * Windows has no process groups to sweep, and a WSL child is started through
 * `wsl.exe` elsewhere; both are left as they were.
 */
export function spawnClaudeLocalProcess(
  command: string,
  args: readonly string[],
  options: { cwd?: string | undefined; env: NodeJS.ProcessEnv; signal?: AbortSignal | undefined },
  platform: NodeJS.Platform = process.platform,
): ChildProcess {
  const ownGroup = platform !== 'win32'
  const child = spawn(command, args, {
    cwd: options.cwd,
    env: options.env,
    stdio: ['pipe', 'pipe', 'pipe'],
    signal: options.signal,
    windowsHide: true,
    detached: ownGroup,
  })
  if (ownGroup) {
    child.once('exit', () => {
      if (typeof child.pid !== 'number' || child.pid <= 0) return
      try {
        process.kill(-child.pid, 'SIGKILL')
      } catch {
        // The group is already empty.
      }
    })
  }
  return child
}
