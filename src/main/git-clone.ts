import { execFile, spawn } from 'child_process'
import { join } from 'path'
import { readdirSync, rmSync } from 'fs'
import { lstat, mkdir, readdir, rm } from 'fs/promises'
import { promisify } from 'util'
import { withGitExecutable } from './git-executable'
import type {
  CloneProgress,
  CloneProgressStage,
  RepositoryCloneInput,
  RepositoryCloneResult,
} from '../shared/electron-api'
import { isValidBranchName, providerLabel, validateCloneUrl, type CloneUrlValidation } from '../shared/git-clone-url'

const execFileAsync = promisify(execFile)

// A big repository clones for as long as it takes; what is never acceptable is
// a transport that stopped talking. git prints progress at least every second
// while it moves data (GIT_PROGRESS_DELAY=0 below), so five silent minutes is a
// wedged connection, not a slow one.
const CLONE_IDLE_TIMEOUT_MS = 5 * 60 * 1000

// Long before that kill, the silence is worth saying: git prints nothing while
// a transfer waits on a dead connection, and the kernel can take many minutes
// to give up on one. Without this the progress line keeps showing the last
// transfer speed as if data were still arriving.
const CLONE_STALL_MS = 20 * 1000

// The lines of git's output kept for the failure message; progress is
// redrawn with \r hundreds of times and is never one of them.
const STDERR_TAIL_LINES = 40

// The token travels to git through the child's environment and an inline
// credential helper — never through argv (visible in `ps`) and never into the
// cloned repo's config (the remote URL stays clean). The helper reads the
// host git is asking about from stdin and answers ONLY for the host the token
// belongs to, so a cross-host redirect mid-clone gets nothing rather than the
// token.
const TOKEN_ENV_VAR = 'SPRINTENGINE_CLONE_TOKEN'
const TOKEN_HOST_ENV_VAR = 'SPRINTENGINE_CLONE_TOKEN_HOST'
const TOKEN_CREDENTIAL_HELPER =
  `!f() { h=; while IFS= read -r l; do [ "$l" = "host=$${TOKEN_HOST_ENV_VAR}" ] && h=1; [ -z "$l" ] && break; done; ` +
  `[ "$h" = "1" ] && printf "username=x-access-token\\npassword=%s\\n" "$${TOKEN_ENV_VAR}"; :; }; f`

/**
 * What a git command needs to sign in to one https host with a token: the
 * arguments that put the helper above in place, and the environment it reads
 * the token from. The empty helper comes first: it clears inherited helpers
 * (osxkeychain, manager) so a stale stored credential cannot shadow the token.
 * `host` is the host as git names it in a credential request (with its port,
 * when the URL has one).
 */
export function tokenCredentialGit(host: string, token: string): { args: string[]; env: Record<string, string> } {
  return {
    args: ['-c', 'credential.helper=', '-c', `credential.helper=${TOKEN_CREDENTIAL_HELPER}`],
    env: { [TOKEN_ENV_VAR]: token, [TOKEN_HOST_ENV_VAR]: host },
  }
}

// Public hosts that are certainly not a GitHub server: `gh` has no sign-in
// for them, so it is not asked. Any other https host may be a company's own
// GitHub under a name of its choosing, and `gh auth token --hostname` is the
// one place that knows.
const NOT_GITHUB_HOSTS = new Set([
  'gitlab.com',
  'bitbucket.org',
  'dev.azure.com',
  'codeberg.org',
  'gitea.com',
  'git.sr.ht',
])

export type CloneDeps = {
  /** The saved GitHub token, for github.com. */
  token?: string | null
  /** A GitHub host's own sign-in (`gh auth token --hostname`), for a self-hosted GitHub. */
  resolveHostToken?: (host: string) => Promise<string>
  onProgress?: (progress: Omit<CloneProgress, 'cloneId'>) => void
  signal?: AbortSignal
}

type TargetState = 'free' | 'empty' | 'occupied'

// lstat, not stat: a dangling symlink at the target is still an occupied
// path — git would refuse it, so the pre-check must see it too. An empty
// directory is free to clone into, as it is for git itself: it is what a
// person makes in Finder before pointing the clone at it.
async function targetState(target: string): Promise<TargetState> {
  try {
    const stat = await lstat(target)
    if (!stat.isDirectory()) return 'occupied'
    return (await readdir(target)).length === 0 ? 'empty' : 'occupied'
  } catch {
    return 'free'
  }
}

/** The repository a folder's `origin` points at, or null when it is not a clone. */
async function originOf(dir: string, env: NodeJS.ProcessEnv): Promise<string | null> {
  try {
    const { stdout } = await withGitExecutable(env, (file) =>
      execFileAsync(file, ['-C', dir, 'remote', 'get-url', 'origin'], { encoding: 'utf8', windowsHide: true, env }),
    )
    return stdout.trim() || null
  } catch {
    return null
  }
}

/** Whether two clone sources name the same repository, whatever the transport. */
export function sameRepository(a: string, b: string): boolean {
  const left = validateCloneUrl(a)
  const right = validateCloneUrl(b)
  if (!left.ok || !right.ok) return false
  const key = (source: Extract<CloneUrlValidation, { ok: true }>) =>
    `${source.host.replace(/^ssh\./, '').replace(/^vs-ssh\./, '')}/${source.path}`.toLowerCase()
  return key(left) === key(right)
}

const STAGES: ReadonlyArray<[RegExp, CloneProgressStage]> = [
  [/^remote: (?:Enumerating|Counting|Compressing) objects/, 'counting'],
  [/^Receiving objects/, 'receiving'],
  [/^Resolving deltas/, 'resolving'],
  [/^(?:Updating files|Checking out files|Filtering content)/, 'checkout'],
]

/**
 * One line of `git clone --progress`: the stage it is in, how far through it,
 * and the transfer detail git prints beside the count (`12.30 MiB | 5.00 MiB/s`).
 */
export function parseCloneProgressLine(line: string): Omit<CloneProgress, 'cloneId'> | null {
  const text = line.trim()
  const stage = STAGES.find(([pattern]) => pattern.test(text))?.[1]
  if (!stage) return null
  const match = text.match(/:\s+(\d+)%\s+\(\d+\/\d+\)(?:,\s*([^,]*?))?(?:,\s*done\.?)?\.?$/)
  const detail = match?.[2]?.trim().replace(/\s*done$/, '') || null
  return { stage, percent: match ? Number(match[1]) : null, detail }
}

/** git's transfer detail once the transfer has gone quiet: the amount stays, the speed becomes `Stalled`. */
export function stalledCloneDetail(detail: string | null): string {
  const amount = detail?.includes('|') ? detail.split('|')[0].trim() : ''
  return amount ? `${amount} | Stalled` : 'Stalled'
}

/**
 * A clone's progress reports, with a stall said out loud: once git has been
 * silent for `stallMs`, the last report goes out again with its detail made
 * `stalledCloneDetail`, and the next progress line puts the live one back.
 * `heard` is called on every chunk git writes, progress or not; `stop` once it
 * has exited.
 */
export function stallAwareProgress(
  onProgress: CloneDeps['onProgress'],
  stallMs = CLONE_STALL_MS,
): { report: (progress: Omit<CloneProgress, 'cloneId'>) => void; heard: () => void; stop: () => void } {
  let last: Omit<CloneProgress, 'cloneId'> | null = null
  let stalled = false
  let timer: NodeJS.Timeout | undefined
  const arm = () => {
    clearTimeout(timer)
    if (!onProgress) return
    timer = setTimeout(() => {
      if (!last || stalled) return
      stalled = true
      onProgress({ ...last, detail: stalledCloneDetail(last.detail) })
    }, stallMs)
  }
  return {
    report: (progress) => {
      last = progress
      stalled = false
      onProgress?.(progress)
      arm()
    },
    heard: arm,
    stop: () => clearTimeout(timer),
  }
}

function isProgressLine(line: string): boolean {
  return /^(?:remote: )?(?:Enumerating|Counting|Compressing|Receiving|Resolving|Updating files|Checking out|Filtering|Total \d)/.test(
    line.trim(),
  )
}

/**
 * What a failed clone tells the person: git's own last words, with the
 * reason it failed said plainly when it is one of the few that need
 * something done on their side — and what to do about it on that host.
 */
export function describeCloneFailure(stderr: string, source: Extract<CloneUrlValidation, { ok: true }>): string {
  const lines = stderr
    .split(/[\r\n]+/)
    .map((line) => line.trim())
    .filter((line) => line && !line.startsWith('Cloning into') && !isProgressLine(line))
  const text = lines.join('\n')
  const ssh = source.httpsHost === null && !source.insecure
  const where = source.provider === 'git' ? source.host : providerLabel(source.provider)
  const signIn =
    source.provider === 'github'
      ? `Add a token in Settings → Version control, or run \`gh auth login --hostname ${source.host}\`.`
      : `Sign in with your Git credential manager, or use the repository's SSH URL.`

  if (/Remote branch (\S+) not found/i.test(text)) {
    const branch = text.match(/Remote branch (\S+) not found/i)?.[1] ?? 'that branch'
    return `${where} has no branch named ${branch}. Clear the branch to clone the default one.`
  }
  if (/Permission denied \(publickey/i.test(text)) {
    return `${source.host} refused your SSH key. Load it with \`ssh-add\`, add it to your ${where} account, or use the https URL.`
  }
  if (/Host key verification failed/i.test(text)) {
    return `${source.host} is not a known SSH host yet. Run \`ssh -T git@${source.host}\` once in a terminal to trust it, then try again.`
  }
  if (/Could not resolve host|Name or service not known|nodename nor servname/i.test(text)) {
    return `Could not reach ${source.host}. Check the address and your network or VPN.`
  }
  if (/SSL certificate problem|server certificate verification failed|unable to get local issuer/i.test(text)) {
    return `${source.host}'s certificate is not trusted on this machine (a self-signed or internal certificate). Add it to your system's trusted certificates, or use SSH.`
  }
  if (
    /Authentication failed|could not read Username|could not read Password|terminal prompts disabled|HTTP Basic: Access denied|invalid credentials|\b401\b/i.test(
      text,
    )
  ) {
    // GitHub, and most hosts, answer a repository that does not exist exactly
    // as they answer a private one, so the message cannot say which it is.
    return `${where} asked for a sign-in for ${source.path}: it is private, or it does not exist. ${signIn}`
  }
  if (/Repository not found|not found|does not appear to be a git repository|\b404\b|access rights/i.test(text)) {
    return ssh
      ? `${where} has no repository at ${source.path} that your SSH key can read. Check the URL and that your key has access.`
      : `${where} has no repository at ${source.path} — or it is private and you are not signed in. ${signIn}`
  }
  if (/Connection (?:timed out|refused)|Operation timed out|Failed to connect/i.test(text)) {
    return `${source.host} did not answer. Check the address, the port and your network or VPN.`
  }
  const tail = lines.filter((line) => !line.startsWith('hint:')).slice(-3)
  return tail.join(' ').replace(/^fatal:\s*/i, '') || 'git clone failed.'
}

/** The host git names in a credential request: the host, and the port when the URL has one. */
function credentialHost(url: string): string {
  try {
    return new URL(url).host.toLowerCase()
  } catch {
    return ''
  }
}

async function tokenFor(
  source: Extract<CloneUrlValidation, { ok: true }>,
  deps: CloneDeps,
): Promise<{ host: string; token: string } | null> {
  // Only https carries a token: ssh authenticates with the person's own keys,
  // and plain http would send it in the clear.
  if (!source.httpsHost) return null
  const host = credentialHost(source.url)
  if (!host) return null
  if (source.httpsHost === 'github.com') {
    const saved = deps.token?.trim()
    if (saved) return { host, token: saved }
  } else if (NOT_GITHUB_HOSTS.has(source.httpsHost) || source.provider === 'azure') {
    return null
  }
  // No saved token for github.com, or a host that may be a self-hosted
  // GitHub: the sign-in `gh` holds for it, when it holds one. Anything else
  // is left to the person's own credential helper, exactly as their own
  // `git clone` would be.
  const fromGh = (await deps.resolveHostToken?.(source.httpsHost).catch(() => ''))?.trim() ?? ''
  return fromGh ? { host, token: fromGh } : null
}

async function emptyDirectory(dir: string): Promise<void> {
  const entries = await readdir(dir).catch(() => [] as string[])
  await Promise.all(entries.map((entry) => rm(join(dir, entry), { recursive: true, force: true }).catch(() => {})))
}

// The clones running now, so a quit mid-clone does not strand a partial
// checkout: whatever stops this process — a quit, an update's restart —
// stops them first and takes back what each had written. Synchronous, because
// `exit` runs nothing after it returns.
const inFlight = new Map<number, { kill: () => void; target: string; existed: boolean }>()
let exitHookInstalled = false

function abandonInFlightClones(): void {
  for (const clone of inFlight.values()) {
    clone.kill()
    try {
      if (clone.existed) {
        for (const entry of readdirSync(clone.target))
          rmSync(join(clone.target, entry), { recursive: true, force: true })
      } else {
        rmSync(clone.target, { recursive: true, force: true })
      }
    } catch {
      // Best effort on the way out: nothing is left to report it to.
    }
  }
  inFlight.clear()
}

type RunOutcome = { code: number | null; stderr: string; stopped: 'cancelled' | 'idle' | null }

function runGitClone(
  file: string,
  args: string[],
  env: NodeJS.ProcessEnv,
  options: {
    signal?: AbortSignal
    onOutput?: () => void
    onLine: (line: string) => void
    target: string
    existed: boolean
  },
): Promise<RunOutcome> {
  return new Promise((resolve, reject) => {
    const child = spawn(file, args, { env, windowsHide: true, stdio: ['ignore', 'ignore', 'pipe'] })
    if (!exitHookInstalled) {
      exitHookInstalled = true
      process.once('exit', abandonInFlightClones)
    }
    const pid = child.pid ?? -1
    if (pid > 0) inFlight.set(pid, { kill: () => child.kill(), target: options.target, existed: options.existed })
    let stopped: RunOutcome['stopped'] = null
    const tail: string[] = []
    let partial = ''
    let idle: NodeJS.Timeout | undefined
    const stop = (why: 'cancelled' | 'idle') => {
      if (stopped) return
      stopped = why
      child.kill()
    }
    const armIdle = () => {
      clearTimeout(idle)
      idle = setTimeout(() => stop('idle'), CLONE_IDLE_TIMEOUT_MS)
    }
    const onAbort = () => stop('cancelled')
    options.signal?.addEventListener('abort', onAbort, { once: true })
    if (options.signal?.aborted) stop('cancelled')
    armIdle()
    child.stderr.setEncoding('utf8')
    child.stderr.on('data', (chunk: string) => {
      armIdle()
      options.onOutput?.()
      const pieces = (partial + chunk).split(/[\r\n]/)
      partial = pieces.pop() ?? ''
      for (const line of pieces) {
        if (!line.trim()) continue
        options.onLine(line)
        if (!isProgressLine(line)) {
          tail.push(line)
          if (tail.length > STDERR_TAIL_LINES) tail.shift()
        }
      }
    })
    const finish = () => {
      inFlight.delete(pid)
      clearTimeout(idle)
      options.signal?.removeEventListener('abort', onAbort)
    }
    child.on('error', (error) => {
      finish()
      reject(error)
    })
    child.on('close', (code) => {
      finish()
      if (partial.trim() && !isProgressLine(partial)) tail.push(partial)
      resolve({ code, stderr: tail.join('\n'), stopped })
    })
  })
}

/**
 * Clone a repository into parentDir/folderName. Any host git can reach:
 * GitHub (github.com or a company's own), GitLab, Bitbucket, Azure DevOps,
 * Gitea, or a bare server over ssh. Never throws — failures return
 * `{ok:false}` with a message that says what to do, so the Import from Git
 * step can show it under the field it is about.
 */
export async function cloneRepository(
  input: RepositoryCloneInput,
  deps: CloneDeps = {},
): Promise<RepositoryCloneResult> {
  const source = validateCloneUrl(input.url)
  if (!source.ok) return { ok: false, reason: 'invalid', message: source.error }

  const folderName = input.folderName.trim()
  if (
    !folderName ||
    folderName === '.' ||
    folderName === '..' ||
    /[/\\]/.test(folderName) ||
    folderName.includes('\0')
  ) {
    return { ok: false, reason: 'invalid', message: 'Enter a valid folder name for the clone.' }
  }
  const branch = input.branch?.trim() || null
  if (branch && !isValidBranchName(branch)) {
    return { ok: false, reason: 'invalid', message: `"${branch}" is not a branch name git accepts.` }
  }

  const env: NodeJS.ProcessEnv = {
    ...process.env,
    LC_ALL: 'C',
    GIT_TERMINAL_PROMPT: '0',
    GIT_PROGRESS_DELAY: '0',
    // Fail fast instead of hanging on an interactive host-key or passphrase
    // prompt no one can see. An agent-backed ssh clone still works.
    GIT_SSH_COMMAND: process.env.GIT_SSH_COMMAND ?? 'ssh -oBatchMode=yes',
  }

  const target = join(input.parentDir, folderName)
  const state = await targetState(target)
  if (state === 'occupied') {
    const origin = await originOf(target, env)
    if (origin && sameRepository(origin, source.url)) {
      return {
        ok: false,
        reason: 'exists',
        existingPath: target,
        message: `${folderName} is already a clone of ${source.path}.`,
      }
    }
    return {
      ok: false,
      reason: 'exists',
      message: `${folderName} already exists in that folder. Choose another folder name.`,
    }
  }

  try {
    // Only a parent that is missing is created. On Windows a recursive mkdir
    // of a drive root (`D:\`) fails with EPERM even though it exists.
    const parent = await lstat(input.parentDir).catch(() => null)
    if (!parent?.isDirectory()) await mkdir(input.parentDir, { recursive: true })
  } catch (error) {
    return {
      ok: false,
      reason: 'failed',
      message: error instanceof Error ? error.message : 'Could not create the parent folder.',
    }
  }

  const args = ['clone', '--progress']
  const credential = await tokenFor(source, deps)
  if (credential) {
    const signIn = tokenCredentialGit(credential.host, credential.token)
    Object.assign(env, signIn.env)
    args.unshift(...signIn.args)
  }
  if (branch) args.push('--branch', branch)
  args.push('--', source.url, target)

  const progress = stallAwareProgress(deps.onProgress)
  progress.report({ stage: 'connecting', percent: null, detail: null })
  let outcome: RunOutcome
  try {
    outcome = await withGitExecutable(env, (file) =>
      runGitClone(file, args, env, {
        signal: deps.signal,
        target,
        existed: state === 'empty',
        onOutput: progress.heard,
        onLine: (line) => {
          const step = parseCloneProgressLine(line)
          if (step) progress.report(step)
        },
      }),
    )
  } catch (error) {
    const code = (error as NodeJS.ErrnoException | null)?.code
    return {
      ok: false,
      reason: 'failed',
      message: code === 'ENOENT' ? 'Git is not installed on this machine.' : String((error as Error)?.message ?? error),
    }
  } finally {
    progress.stop()
  }

  if (outcome.stopped) {
    // git cleans up its own failed targets; only a kill can strand a partial
    // checkout, and only then is removal justified — and only of what this
    // clone made: a folder that was there empty stays, emptied again.
    if (state === 'empty') await emptyDirectory(target)
    else await rm(target, { recursive: true, force: true }).catch(() => {})
    return outcome.stopped === 'cancelled'
      ? { ok: false, reason: 'cancelled', message: 'Clone cancelled.' }
      : {
          ok: false,
          reason: 'failed',
          message: `${source.host} stopped sending data. Check your connection, then try again.`,
        }
  }
  if (outcome.code === 0) return { ok: true, path: target }
  return { ok: false, reason: 'failed', message: describeCloneFailure(outcome.stderr, source) }
}
