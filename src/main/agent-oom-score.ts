// On Linux, when memory runs out, the kernel kills the process with the highest
// "badness", and an agent CLI with its tools and language servers is usually
// smaller than the app (or the Studio server on a WSL or SSH machine) that
// launched it. Losing the app takes every terminal and chat down with it;
// losing one agent loses one turn. So the agents and terminals the app starts
// are marked as the ones to go first, with a raised `oom_score_adj`.
//
// Two ways to do it, and the choice matters:
//
// - After the spawn, write `/proc/<pid>/oom_score_adj` for the child. A
//   process may RAISE the score of a process of the same user (lowering it
//   needs a privilege), and the child's descendants inherit it. The command,
//   its arguments, its pid and its signals are exactly what they were. The
//   cost is a window: anything the child forks before the write keeps the old
//   score. An agent CLI takes tens of milliseconds to start before it forks
//   anything, and the write lands well inside that.
// - Start the command through `sh -c 'echo 800 >/proc/self/oom_score_adj;
//   exec "$@"'`. No window, but every launch now depends on `/bin/sh`, the
//   argv the process table and node-pty report is a shell's until the exec,
//   and an `exec` that fails reports the shell's error rather than the spawn's.
//
// The first is used wherever the app spawns a process itself. Where a launch
// already IS a shell script (a WSL terminal's startup script, a WSL chat's
// launch line), the score is raised by a line in that script instead: there is
// no argv left to change, and `exec` keeps the pid.
//
// Best-effort everywhere: a kernel without the file, a process that already
// exited, or a sandbox that forbids the write leaves the launch as it was.

import { readFile, writeFile } from 'node:fs/promises'

/**
 * The score agents and terminals get. High enough to be picked before the app
 * (which runs at 0) and before ordinary programs, short of 1000, which marks a
 * process as the kernel's first choice whatever its size.
 */
export const AGENT_OOM_SCORE_ADJ = 800

/**
 * The same raise as one POSIX shell line, for a launch that is a shell script.
 * Never lowers a score already higher, and says nothing when it cannot write.
 * The current score is read by `cat`, a child that inherited the shell's own,
 * rather than by `read`: a WSL launch line reads its secrets from stdin with
 * `read`, and nothing else in it should look like that.
 */
export const RAISE_OOM_SCORE_SHELL_LINE = `{ [ "$(cat /proc/self/oom_score_adj)" -lt ${AGENT_OOM_SCORE_ADJ} ] && echo ${AGENT_OOM_SCORE_ADJ} >/proc/self/oom_score_adj; } 2>/dev/null`

export type OomScoreDeps = {
  platform?: NodeJS.Platform
  readText?: (path: string) => Promise<string>
  writeText?: (path: string, text: string) => Promise<void>
}

/**
 * Raise a just-spawned child's `oom_score_adj` to `AGENT_OOM_SCORE_ADJ` on
 * Linux. Never throws and never lowers a score already higher (a child that
 * inherited a higher one from the app's own launcher keeps it). Resolves when
 * it is done, for the tests; callers do not wait for it.
 */
export async function raiseChildOomScore(pid: number | undefined, deps: OomScoreDeps = {}): Promise<void> {
  if ((deps.platform ?? process.platform) !== 'linux') return
  if (typeof pid !== 'number' || !Number.isInteger(pid) || pid <= 0) return
  const path = `/proc/${pid}/oom_score_adj`
  try {
    const current = Number.parseInt((await (deps.readText ?? ((file) => readFile(file, 'utf8')))(path)).trim(), 10)
    if (Number.isFinite(current) && current >= AGENT_OOM_SCORE_ADJ) return
    await (deps.writeText ?? ((file, text) => writeFile(file, text)))(path, `${AGENT_OOM_SCORE_ADJ}\n`)
  } catch {
    // Best-effort: see the header.
  }
}
