import type { ChildProcess } from 'node:child_process'
import { existsSync, readFileSync } from 'node:fs'
import { win32 } from 'node:path'
import { resolveWindowsProgramOnPathSync, windowsPowerShellPath } from '../command-on-path'
import { killProcessTree } from '../process-tree-kill'

type CliSpawnTarget = { file: string; args: string[]; windowsVerbatimArguments?: boolean }

/**
 * How to start an agent CLI that speaks a protocol over stdio.
 *
 * On Windows the resolved command is often an npm shim, `codex.cmd` or
 * `codex.ps1`, and neither is an executable Node can spawn without a shell.
 * A batch shim runs through the command processor and a PowerShell shim
 * through PowerShell, with the rest of the argv passed as it is. Everything
 * else, and every command on macOS and Linux, is spawned directly.
 *
 * The command processor re-reads its line, so the line is built here rather
 * than by Node: every argument quoted, `/s` stripping only the outer pair.
 * Inside quotes the command processor still expands `%VAR%` and ends at a
 * quote, so an argument carrying either is refused instead of being
 * reinterpreted. The arguments are the app's own (`acp`, `app-server`) and the
 * path the CLI was found at.
 *
 * The command processor cannot start in a UNC folder: given one (a folder
 * inside a distribution, `\\wsl.localhost\Ubuntu\…`, which a chat on This PC
 * may run in) it starts in the Windows folder instead, and so would the CLI.
 * There an npm batch shim is read for what it runs (`npmShimTarget`), and
 * that is started directly, which keeps the folder. Not the PowerShell shim
 * npm writes beside it: Windows PowerShell holds a piped stdin until it
 * closes, so a protocol's first request never arrives, and it re-encodes
 * that stdin as ASCII and drops an empty argument or a quote in one. A batch
 * file that is not an npm shim is refused with the way out, rather than run
 * in the wrong folder.
 */
export function cliSpawnTarget(
  command: string,
  args: string[],
  deps: {
    platform?: NodeJS.Platform
    env?: NodeJS.ProcessEnv
    cwd?: string
    exists?: (path: string) => boolean
    readText?: (path: string) => string | null
  } = {},
): CliSpawnTarget {
  if ((deps.platform ?? process.platform) !== 'win32') return { file: command, args }
  const lower = command.toLowerCase()
  const env = deps.env ?? process.env
  if ((lower.endsWith('.cmd') || lower.endsWith('.bat')) && deps.cwd && /^[\\/]{2}[^\\/]/u.test(deps.cwd)) {
    const exists = deps.exists ?? existsSync
    const target = npmShimTarget(command, exists, deps.readText ?? readTextOrNull, () =>
      resolveWindowsProgramOnPathSync('node', { pathValue: env.PATH ?? env.Path ?? '', exists }),
    )
    if (target) return { file: target.file, args: [...target.args, ...args] }
    throw new Error(
      `${command} is a batch file, and Windows cannot start one in ${deps.cwd}: it would run in the Windows folder instead. ` +
        "Set the CLI's command to its .exe in Settings › Agents, or run this chat on its WSL machine.",
    )
  }
  if (lower.endsWith('.cmd') || lower.endsWith('.bat')) {
    const line = [command, ...args]
      .map((value) => {
        if (/["%\r\n]/.test(value))
          throw new Error(`Cannot start ${command} safely: an argument contains a quote, percent sign or line break.`)
        return `"${value}"`
      })
      .join(' ')
    return {
      file: deps.env?.ComSpec ?? process.env.ComSpec ?? 'cmd.exe',
      args: ['/d', '/s', '/c', `"${line}"`],
      windowsVerbatimArguments: true,
    }
  }
  if (lower.endsWith('.ps1')) return powerShellTarget(command, args, env)
  return { file: command, args }
}

/**
 * What an npm batch shim (`codex.cmd`, written by npm's `cmd-shim`) runs, as
 * a program and the arguments before the caller's: Node with the package's
 * script, or the package's own executable. Node is the one beside the shim
 * when there is one, else the first on PATH, as the shim itself chooses, by
 * its full path: a bare `node` would be looked for in the child's working
 * folder first, which is the workspace. Null for any batch file that is not
 * such a shim, whose target is gone, or that needs a Node there is none of.
 */
export function npmShimTarget(
  shim: string,
  exists: (path: string) => boolean,
  readText: (path: string) => string | null,
  nodeOnPath: () => string | null = () => resolveWindowsProgramOnPathSync('node', { exists }),
): { file: string; args: string[] } | null {
  const text = readText(shim)
  // A shim that sets variables for its program (a shebang's `env NAME=…`,
  // pnpm's NODE_PATH) needs them, and is left to the command processor.
  if (!text || /^\s*@?SET\s+"?(?!PATHEXT=|dp0=|"?_prog=)/imu.test(text)) return null
  const dir = win32.dirname(shim)
  const local = (relative: string) => win32.join(dir, relative)
  // npm 7 and later: `"%_prog%"  "%dp0%\node_modules\…\cli.js" %*`, with
  // `_prog` Node; or the package's executable alone, `"%dp0%\…\x.exe" %*`.
  // npm 6: `"%~dp0\node.exe"  "%~dp0\node_modules\…\cli.js" %*`, else `node`.
  const script =
    (/SET "_prog=node"/iu.test(text) ? /"%_prog%"\s+"%dp0%\\([^"\r\n%]+)"\s+%\*/u.exec(text) : null) ??
    /"%~dp0\\node\.exe"\s+"%~dp0\\([^"\r\n%]+)"\s+%\*/iu.exec(text)
  if (script) {
    const path = local(script[1])
    if (!exists(path)) return null
    const beside = local('node.exe')
    const node = exists(beside) ? beside : nodeOnPath()
    return node ? { file: node, args: [path] } : null
  }
  const executable = /^\s*"%dp0%\\([^"\r\n%]+\.exe)"\s+%\*\s*$/imu.exec(text)
  if (executable && exists(local(executable[1]))) return { file: local(executable[1]), args: [] }
  return null
}

function readTextOrNull(path: string): string | null {
  try {
    return readFileSync(path, 'utf8')
  } catch {
    return null
  }
}

function powerShellTarget(script: string, args: string[], env: NodeJS.ProcessEnv): CliSpawnTarget {
  return {
    file: windowsPowerShellPath(env),
    args: ['-NoLogo', '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', script, ...args],
  }
}

/**
 * Stop an agent CLI child and whatever it started. On Windows the child is
 * usually the shim's wrapper (the command processor or PowerShell) and the
 * agent is its grandchild, so the whole tree is ended at once. Elsewhere the
 * child is asked to exit and is killed if it has not within two seconds.
 */
export function terminateCliChild(
  child: Pick<ChildProcess, 'pid' | 'exitCode' | 'kill'>,
  deps: { platform?: NodeJS.Platform; runTaskkill?: (pid: number) => void } = {},
): void {
  if (child.exitCode !== null) return
  const platform = deps.platform ?? process.platform
  if (platform === 'win32') {
    killProcessTree(child, { platform, runTaskkill: deps.runTaskkill })
    return
  }
  child.kill('SIGTERM')
  const timer = setTimeout(() => {
    if (child.exitCode === null) child.kill('SIGKILL')
  }, 2_000)
  timer.unref()
}
