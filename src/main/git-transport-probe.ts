import { execFile } from 'child_process'
import { promisify } from 'util'
import { withGitExecutable } from './git-executable'
import { GIT_SAFETY_CONFIG } from './git-run'
import { createGitRepoReader } from './skills/git-repo-reader'
import type { SkillRepoReader } from './skills/repo-reader'

const execFileAsync = promisify(execFile)

/**
 * Whether this machine's git can do what the reader asks of it, asked once the
 * app is ready and again — at most once a minute — while the answer is no.
 *
 * The floor is 2.19: partial clone (`--filter=blob:none`) arrived there, and a
 * git that rejects the filter would fail every read with the API reader sitting
 * unreachable beside it. `git --version` alone proved only that a git exists
 * (review, 2026-09-09).
 */
const GIT_VERSION_FLOOR: readonly [number, number] = [2, 19]
const GIT_REPROBE_MS = 60_000

export function createGitTransportProbe(options: {
  cacheDir: string
  resolveToken: () => Promise<string>
  resolveHostToken: (host: string) => Promise<string>
}): {
  readonly reader: SkillRepoReader | undefined
  readonly installed: boolean
  refresh(): Promise<void>
} {
  let reader: SkillRepoReader | undefined
  let installed = false
  let probedAt = 0
  let inFlight: Promise<void> | null = null
  const probe = async (): Promise<void> => {
    probedAt = Date.now()
    const usable = await gitMeetsFloor()
    installed = usable
    if (usable && !reader) reader = createGitRepoReader(options)
    if (!usable) reader = undefined
  }
  return {
    get reader() {
      return reader
    },
    get installed() {
      return installed
    },
    refresh() {
      // A usable git stays usable for the app's life; only a missing one is
      // asked again, and not on every call.
      if (installed) return Promise.resolve()
      if (inFlight) return inFlight
      if (probedAt !== 0 && Date.now() - probedAt < GIT_REPROBE_MS) return Promise.resolve()
      inFlight = probe().finally(() => {
        inFlight = null
      })
      return inFlight
    },
  }
}

async function gitMeetsFloor(): Promise<boolean> {
  try {
    const env = { ...process.env, GIT_TERMINAL_PROMPT: '0' }
    const { stdout } = await withGitExecutable(env, (file) =>
      execFileAsync(file, [...GIT_SAFETY_CONFIG, '--version'], { windowsHide: true, timeout: 5_000, env }),
    )
    const match = /git version (\d+)\.(\d+)/.exec(String(stdout))
    if (!match) return false
    const [major, minor] = [Number(match[1]), Number(match[2])]
    return major > GIT_VERSION_FLOOR[0] || (major === GIT_VERSION_FLOOR[0] && minor >= GIT_VERSION_FLOOR[1])
  } catch {
    return false
  }
}
