import { spawn, type ChildProcess } from 'node:child_process'
import { accessSync, constants } from 'node:fs'
import { delimiter, isAbsolute, join, resolve } from 'node:path'

// Forks a watcher into the group, then becomes the CLI, which keeps the pid,
// pipes and signals it would have had, and none of the watcher's descriptor.
// The watcher blocks on a pipe only the starting process holds: at its end of
// file the group is asked to stop, then made to. The watcher ignores the ask
// so it is there to make sure.
const PARENT_DEATH_WATCH_SCRIPT = [
  "{ trap '' TERM; read -r _ <&3; kill -TERM 0; sleep 5; kill -KILL 0; } </dev/null >/dev/null 2>&1 &",
  'exec "$@" 3<&-',
].join('\n')

/**
 * Starts a Claude CLI on this machine, on POSIX as the leader of its own
 * process group. When the CLI ends it stops the MCP servers it started, but
 * not what those started: a plugin's `bun run start` wrapper goes and its
 * `bun server.ts` stays, with nobody reading its output, after every closed
 * chat, idle release and respawn. Those stay in the CLI's group, so once the
 * CLI exits, for any reason, whatever is left of the group is ended too.
 *
 * That needs this process alive, and the CLI carries on with its turn after
 * its pipes close. A server killed outright (replaced by an upgrade, or hung
 * and ended by its supervisor) would leave the CLI working with no parent
 * while the next server resumes the same session beside it, so the CLI is
 * started through a launcher whose watcher ends the group once this process
 * is gone, however it went. A command that cannot be run is spawned directly,
 * so it still fails as not found rather than as a shell's exit code.
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
  const watched = ownGroup && runnable(command, options)
  const child = spawn(
    watched ? '/bin/sh' : command,
    watched ? ['-c', PARENT_DEATH_WATCH_SCRIPT, 'claude', command, ...args] : args,
    {
      cwd: options.cwd,
      env: options.env,
      stdio: watched ? ['pipe', 'pipe', 'pipe', 'pipe'] : ['pipe', 'pipe', 'pipe'],
      signal: options.signal,
      windowsHide: true,
      detached: ownGroup,
    },
  )
  // Nothing reads or writes the watcher's pipe; its end is not worth a crash.
  child.stdio[3]?.on('error', () => {})
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

// Whether `command` names a file the child could run: a path against the
// child's working directory, a bare name the way its PATH would find it.
function runnable(command: string, options: { cwd?: string | undefined; env: NodeJS.ProcessEnv }): boolean {
  if (command.includes('/')) return executable(resolve(options.cwd ?? process.cwd(), command))
  return (options.env.PATH ?? '')
    .split(delimiter)
    .some((directory) => directory !== '' && isAbsolute(directory) && executable(join(directory, command)))
}

function executable(path: string): boolean {
  try {
    accessSync(path, constants.X_OK)
    return true
  } catch {
    return false
  }
}
