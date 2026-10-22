// The command and folder the person last agreed to run for each local server,
// so "Run again" asks the first time and again whenever the agent changes
// either, and not on every click in between. The command is the agent's,
// written when it linked the server; the person reads it before it runs as
// them. Per window's storage and best-effort: blocked storage or a corrupt
// entry reads as nothing agreed, which only means being asked again.

const STORAGE_KEY = 'sprintengine.localServers.confirmedRuns'
/** Enough for every server a person keeps around; the oldest agreement goes first. */
const MAX_ENTRIES = 200

/** One server's run, as the person is asked about it. */
export type LocalServerRun = {
  workspaceId: string
  agentId: string
  serverId: string
  command: string
  /** The folder it runs in; null for the conversation's own folder. */
  cwd: string | null
}

type Agreed = Record<string, { command: string; cwd: string | null }>

const keyOf = (run: LocalServerRun) => [run.workspaceId, run.agentId, run.serverId].join('\0')

function readAgreed(): Agreed {
  try {
    const raw = window.localStorage.getItem(STORAGE_KEY)
    const parsed: unknown = raw ? JSON.parse(raw) : {}
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? (parsed as Agreed) : {}
  } catch {
    return {}
  }
}

/** Whether the person already agreed to run exactly this command, in exactly this folder, for this server. */
export function isLocalServerRunConfirmed(run: LocalServerRun): boolean {
  const agreed = readAgreed()[keyOf(run)]
  return Boolean(agreed && agreed.command === run.command && (agreed.cwd ?? null) === run.cwd)
}

/** Remember that the person agreed to this run. */
export function rememberLocalServerRun(run: LocalServerRun): void {
  try {
    const key = keyOf(run)
    const { [key]: _previous, ...rest } = readAgreed()
    const kept = Object.entries(rest).slice(-(MAX_ENTRIES - 1))
    window.localStorage.setItem(
      STORAGE_KEY,
      JSON.stringify(Object.fromEntries([...kept, [key, { command: run.command, cwd: run.cwd }]])),
    )
  } catch {
    // Storage refused: the run goes ahead, and the next one asks again.
  }
}
