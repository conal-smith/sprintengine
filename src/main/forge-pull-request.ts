// GitLab merge requests and Gitea pull requests for the chat's "Create PR",
// opened through the forge's own CLI as GitHub's are through `gh`: `glab` on
// GitLab, `tea` on Gitea, Forgejo and Codeberg. The CLI's credential store is
// the only auth source, as gh's is for GitHub, so the app holds no token for
// any forge.
//
// Whatever goes wrong before a request exists, the answer is `unavailable`
// with a sentence saying why (the CLI is missing, is not signed in to that
// host, or refused), and the caller opens the forge's own prefilled page
// instead: the person still gets to propose what they confirmed, and learns
// what would let the app do it next time. Once the CLI may have opened one
// (it said it did but printed no address Studio can read, or it ran out of
// time mid-creation), the answer is `address-unknown` instead, and the caller
// opens the repository's list of requests: the prefilled page would invite a
// second request beside the one that is probably there.
//
// This computer's checkouts only, like the button itself: a chat on WSL, an
// SSH machine or a paired machine draws no Create PR, so there is no remote
// `glab` or `tea` to find.
//
// Every argument the person wrote (the title, the description) and every one
// git named (the branch, the base) is passed as `--flag=value` in an argv
// array, never through a shell: a title that starts with a dash is still the
// title, and quotes and newlines are only characters.

import { classifyPullRequestUrl } from '../shared/git/pr-url'
import { pullRequestNoun, type ForgeRemote } from '../shared/git/pull-request-create'
import { isRecord } from '../shared/records'
import { parseJsonDocument } from './github/branch-pull-request'
import { sharedHostCliRunner, type GhResult, type GhRunner } from './github/gh'

/** The forges driven here, and the CLI each is driven through. */
export type DrivenForge = 'gitlab' | 'gitea'
type ForgeCli = 'glab' | 'tea'

export type ForgeRequestState = 'open' | 'merged' | 'closed'

/** One merge or pull request whose head is the branch, as the forge's CLI listed it. */
export type ForgeBranchRequest = {
  url: string
  state: ForgeRequestState
  /** The commit the head was at, where the CLI says (glab does, tea does not). */
  headSha: string | null
}

/** A branch lookup: settled (its list, empty or not, is the truth) or not asked. */
export type ForgeBranchRead = { settled: true; requests: ForgeBranchRequest[] } | { settled: false }

/** Where the request opens, and from what. */
export type ForgeRequestTarget = {
  gitRoot: string
  /** The repository it opens on: origin's, as the forge's page opens there too. */
  remote: ForgeRemote
  branch: string
  base: string
  /** The repository the branch is pushed to when that is not `remote` (a fork); null or absent when it is. */
  pushedTo?: ForgeRemote | null
}

export type ForgeCreateOutcome =
  | { kind: 'created' | 'existing'; url: string }
  /** No request was opened here; `reason` says why, and the forge's page opens instead. */
  | { kind: 'unavailable'; reason: string }
  /** One was probably opened, but where is not known; `reason` says why, and the forge's list opens instead. */
  | { kind: 'address-unknown'; reason: string }

export type ForgePullRequestDeps = {
  glab?: GhRunner
  tea?: GhRunner
  now?: () => number
}

/** How long a CLI's "installed and signed in" (or not) answers before it is asked again. */
const ACCESS_HOLD_MS = 5 * 60_000
/** A read: the sign-in check, a branch's requests. */
const READ_TIMEOUT_MS = 15_000
/** The creation, which waits on the forge's API. */
const CREATE_TIMEOUT_MS = 60_000
/** How many of a branch's requests a lookup reads; the newest come first. */
const LIST_LIMIT = 50
/** glab's own switch that turns every prompt into an error, so nothing waits on a terminal that is not there. */
const GLAB_ENV = { NO_PROMPT: '1' } as const
/** GitLab's refusal of a second open merge request from one source branch. */
const GITLAB_ALREADY_EXISTS = /\banother open merge request already exists\b/i
/** Gitea's refusal of a second open pull request between one head and base. */
const GITEA_ALREADY_EXISTS = /\bpull request already exists\b/i

/** Whether the forge can be driven here; `login` is the tea login to use. */
type Access = { ok: true; login: string | null } | { ok: false; reason: string; hold: boolean }

export function createForgePullRequests(deps: ForgePullRequestDeps = {}) {
  const now = deps.now ?? (() => Date.now())
  const access = new Map<string, { at: number; answer: Access }>()
  const checking = new Map<string, Promise<Access>>()

  const runnerOf = (cli: ForgeCli): GhRunner => (cli === 'glab' ? deps.glab : deps.tea) ?? sharedHostCliRunner(cli)

  /**
   * Whether the forge's CLI is installed and signed in to the remote's host.
   * Held for a while, so the strip asking whether the button may show does
   * not start a process each time; `fresh` asks again, which a creation does,
   * since the person may have just signed in after reading why the page
   * opened. Asks that overlap (the strip asks on focus and on a turn's end
   * at once) share the one check in flight.
   */
  function accessOf(remote: ForgeRemote, { fresh }: { fresh: boolean }): Promise<Access> {
    const cli = cliOf(remote.forge as DrivenForge)
    const key = `${cli}\0${hostOf(remote.webUrl)}`
    const held = access.get(key)
    if (held && !fresh && now() - held.at < ACCESS_HOLD_MS) return Promise.resolve(held.answer)
    const pending = checking.get(key)
    if (pending) return pending
    const check = (cli === 'glab' ? glabAccess(remote) : teaAccess(remote))
      .then((answer) => {
        if (answer.ok || answer.hold) access.set(key, { at: now(), answer })
        else access.delete(key)
        return answer
      })
      .finally(() => checking.delete(key))
    checking.set(key, check)
    return check
  }

  async function glabAccess(remote: ForgeRemote): Promise<Access> {
    const host = hostOf(remote.webUrl)
    // A non-zero exit is glab's own "not signed in to that host". The status
    // masks the token, and nothing here reads it.
    const status = await runnerOf('glab').run(['auth', 'status', `--hostname=${host}`], {
      timeoutMs: READ_TIMEOUT_MS,
      setEnv: GLAB_ENV,
    })
    if (!status.found) return { ok: false, hold: true, reason: missingReason('glab') }
    if (status.timedOut) return { ok: false, hold: false, reason: 'glab did not answer in time.' }
    if (status.code !== 0) {
      return {
        ok: false,
        hold: true,
        reason: `glab is not signed in to ${host}: run \`glab auth login --hostname ${host}\` to open merge requests from here.`,
      }
    }
    return { ok: true, login: null }
  }

  async function teaAccess(remote: ForgeRemote): Promise<Access> {
    const tea = runnerOf('tea')
    const version = await tea.run(['--version'], { timeoutMs: READ_TIMEOUT_MS })
    if (!version.found) return { ok: false, hold: true, reason: missingReason('tea') }
    if (version.timedOut) return { ok: false, hold: false, reason: 'tea did not answer in time.' }
    // tea 1.0 renamed every command this drives (`pulls` became `pr`, logins
    // became `auth`) with no aliases, so a 0.x command line would only fail.
    const major = /(\d+)\.\d+\.\d+/.exec(`${version.stdout}\n${version.stderr}`)?.[1]
    if (major && Number(major) >= 1) {
      return {
        ok: false,
        hold: true,
        reason: `This tea (${major}.x) changed its commands, and Studio opens pull requests with tea 0.x so far.`,
      }
    }
    const listed = await tea.run(['logins', 'list', '--output=json'], { timeoutMs: READ_TIMEOUT_MS })
    if (listed.timedOut) return { ok: false, hold: false, reason: 'tea did not answer in time.' }
    if (!listed.found || listed.code !== 0) {
      return { ok: false, hold: false, reason: `tea could not list its logins: ${failureDetail(listed, 'tea')}` }
    }
    const login = teaLoginFor(parseJsonDocument(listed.stdout), remote.webUrl)
    if (!login) {
      const origin = originOf(remote.webUrl)
      return {
        ok: false,
        hold: true,
        reason: `tea has no login for ${hostOf(remote.webUrl)}: run \`tea login add --url ${origin}\` to open pull requests from here.`,
      }
    }
    return { ok: true, login }
  }

  /**
   * Every request whose head is the branch, open, merged and closed, as the
   * forge's CLI lists them. Unsettled when the CLI cannot be asked, which is
   * never "there are none". Asked only while the CLI's held answer says it is
   * installed and signed in: a checkout without glab or tea starts no process
   * each time the strip asks.
   */
  async function listBranch(
    target: Pick<ForgeRequestTarget, 'remote' | 'branch' | 'gitRoot'>,
  ): Promise<ForgeBranchRead> {
    const { remote, branch, gitRoot } = target
    if (!isDriven(remote.forge) || !branch || branch.startsWith('-')) return { settled: false }
    const allowed = await accessOf(remote, { fresh: false })
    if (!allowed.ok) return { settled: false }
    const result =
      remote.forge === 'gitlab'
        ? await runnerOf('glab').run(
            [
              'mr',
              'list',
              `--repo=${remote.webUrl}`,
              `--source-branch=${branch}`,
              '--all',
              '--output=json',
              `--per-page=${LIST_LIMIT}`,
            ],
            { cwd: gitRoot, timeoutMs: READ_TIMEOUT_MS, setEnv: GLAB_ENV },
          )
        : await runnerOf('tea').run(
            [
              'pulls',
              'list',
              `--login=${allowed.login ?? ''}`,
              `--repo=${repositorySlug(remote.webUrl)}`,
              '--state=all',
              '--output=json',
              '--fields=index,state,head,url',
              `--limit=${LIST_LIMIT}`,
            ],
            { cwd: gitRoot, timeoutMs: READ_TIMEOUT_MS },
          )
    if (!result.found || result.timedOut || result.code !== 0) return { settled: false }
    const rows = parseJsonDocument(result.stdout)
    if (!Array.isArray(rows)) return { settled: false }
    // A list none of whose addresses reads as a request on this forge is one
    // this cannot read, not one with none from the branch: a Gitea served
    // under a path (`https://host/git/<owner>/<repo>/pulls/<n>`) prints
    // addresses `classifyPullRequestUrl` does not take, and reading its list
    // as empty would show Create PR beside the request already open.
    const forge = remote.forge
    if (rows.length > 0 && !rows.some((row) => rowClassifies(row, forge))) return { settled: false }
    const requests = rows.flatMap((row) => {
      const read = forge === 'gitlab' ? gitlabRow(row, branch) : giteaRow(row, branch)
      return read ? [read] : []
    })
    return { settled: true, requests }
  }

  /** The branch's open request on the forge, asked now; null when there is none or the CLI could not say. */
  async function openRequestOf(target: ForgeRequestTarget): Promise<string | null> {
    const read = await listBranch(target)
    return read.settled ? (read.requests.find((request) => request.state === 'open')?.url ?? null) : null
  }

  /** Open the request with the forge's CLI, or say why it was not. */
  async function create(
    target: ForgeRequestTarget,
    text: { title: string; body: string },
  ): Promise<ForgeCreateOutcome> {
    const { remote, branch, base, gitRoot } = target
    if (!isDriven(remote.forge)) return { kind: 'unavailable', reason: 'Studio has no CLI to drive for this forge.' }
    const cli = cliOf(remote.forge)
    const noun = pullRequestNoun(remote.forge)
    const pushedTo = target.pushedTo ?? null
    if (pushedTo && hostOf(pushedTo.webUrl) !== hostOf(remote.webUrl)) {
      return {
        kind: 'unavailable',
        reason: `The branch is pushed to a repository on another host, which ${cli} cannot open a ${noun} from.`,
      }
    }
    const allowed = await accessOf(remote, { fresh: true })
    if (!allowed.ok) return { kind: 'unavailable', reason: allowed.reason }

    const result =
      remote.forge === 'gitlab'
        ? await runnerOf('glab').run(
            [
              'mr',
              'create',
              `--repo=${remote.webUrl}`,
              // The repository the branch was pushed to, named rather than
              // left to glab's guess among the checkout's remotes.
              `--head=${(pushedTo ?? remote).webUrl}`,
              `--source-branch=${branch}`,
              `--target-branch=${base}`,
              `--title=${text.title}`,
              `--description=${glabDescription(text.body)}`,
              '--yes',
            ],
            { cwd: gitRoot, timeoutMs: CREATE_TIMEOUT_MS, setEnv: GLAB_ENV },
          )
        : await runnerOf('tea').run(
            [
              'pulls',
              'create',
              `--login=${allowed.login ?? ''}`,
              `--repo=${repositorySlug(remote.webUrl)}`,
              `--head=${pushedTo ? `${ownerOf(pushedTo.webUrl)}:${branch}` : branch}`,
              `--base=${base}`,
              `--title=${text.title}`,
              `--description=${text.body}`,
            ],
            { cwd: gitRoot, timeoutMs: CREATE_TIMEOUT_MS },
          )
    if (!result.found) return { kind: 'unavailable', reason: missingReason(cli) }
    if (result.timedOut) {
      // The forge may have opened it before the CLI was stopped. The button
      // shows only while the branch has no open request it knows of, so one
      // open now is, as after a quiet success, taken for the one asked for.
      const url = await openRequestOf(target)
      if (url) return { kind: 'created', url }
      return {
        kind: 'address-unknown',
        reason: `${cli} did not answer in time, so the ${noun} may or may not be open.`,
      }
    }
    const output = `${result.stdout}\n${result.stderr}`
    if (result.code === 0) {
      // tea prints the new pull request as Markdown wrapped to a width, so
      // the list is asked first there; glab prints the address on a line of
      // its own, after the title it echoes.
      const url =
        remote.forge === 'gitea'
          ? ((await openRequestOf(target)) ?? lastRequestUrl(output, remote))
          : (lastRequestUrl(output, remote) ?? (await openRequestOf(target)))
      if (url) return { kind: 'created', url }
      return { kind: 'address-unknown', reason: `${cli} opened the ${noun} without saying its address.` }
    }
    // The branch already has one, whoever opened it: shown, not claimed, as
    // gh's refusal is.
    const refusal = remote.forge === 'gitlab' ? GITLAB_ALREADY_EXISTS : GITEA_ALREADY_EXISTS
    if (refusal.test(output)) {
      const existing = await openRequestOf(target)
      if (existing) return { kind: 'existing', url: existing }
    }
    return { kind: 'unavailable', reason: `${cli} could not open the ${noun}: ${failureDetail(result, cli)}` }
  }

  return { listBranch, create }
}

export type ForgePullRequests = ReturnType<typeof createForgePullRequests>

export function isDriven(forge: string): forge is DrivenForge {
  return forge === 'gitlab' || forge === 'gitea'
}

function cliOf(forge: DrivenForge): ForgeCli {
  return forge === 'gitlab' ? 'glab' : 'tea'
}

function missingReason(cli: ForgeCli): string {
  return cli === 'glab'
    ? 'Install glab and run `glab auth login` to open merge requests from here.'
    : 'Install tea and run `tea login add` to open pull requests from here.'
}

/**
 * glab reads a description of exactly "-" as "open an editor", which here
 * would wait on a terminal nobody sees. An escaped dash renders the same.
 */
export function glabDescription(body: string): string {
  return body.trim() === '-' ? '\\-' : body
}

/** The host (and a non-default port) of a web URL, lower case. */
function hostOf(webUrl: string): string {
  try {
    return new URL(webUrl).host.toLowerCase()
  } catch {
    return ''
  }
}

function originOf(webUrl: string): string {
  try {
    return new URL(webUrl).origin
  } catch {
    return webUrl
  }
}

/**
 * `owner/repo` of a Gitea repository's web URL: its last two segments, which
 * is what tea's `--repo` takes whatever path the server is mounted on. The
 * addresses such a server prints back are another matter: the pull request
 * record reads a Gitea request only at `/<owner>/<repo>/pulls/<n>` from the
 * host's root, so on a server under a path a branch lookup is unsettled and
 * a creation ends `address-unknown`, with the list to find it in.
 */
function repositorySlug(webUrl: string): string {
  return webUrl.split('/').slice(-2).join('/')
}

function ownerOf(webUrl: string): string {
  return webUrl.split('/').at(-2) ?? ''
}

/** The repository part of a web URL, without its scheme, for comparing what two URLs name. */
function repositoryKey(url: string): string {
  return url
    .replace(/^[a-z]+:\/\//iu, '')
    .replace(/\/+$/u, '')
    .toLowerCase()
}

/**
 * The last request URL in a CLI's output that is on the target repository.
 * The last, because what a CLI echoes first (the title, which may itself
 * carry a link) comes before the address it prints for what it made.
 */
export function lastRequestUrl(output: string, remote: ForgeRemote): string | null {
  let found: string | null = null
  for (const match of output.matchAll(/https?:\/\/[^\s"'<>()]+/g)) {
    const classified = classifyPullRequestUrl(match[0].replace(/[.,;:!?]+$/, ''))
    if (
      classified?.forge === remote.forge &&
      repositoryKey(classified.repositoryUrl) === repositoryKey(remote.webUrl)
    ) {
      found = classified.url
    }
  }
  return found
}

/**
 * The tea login for a remote: the one whose server is the remote's host (by
 * its URL, or the SSH host it was set up with), the default one when several
 * are. Null when none is.
 */
export function teaLoginFor(logins: unknown, webUrl: string): string | null {
  if (!Array.isArray(logins)) return null
  let remoteHost: URL
  try {
    remoteHost = new URL(webUrl)
  } catch {
    return null
  }
  const matches = logins.filter((login): login is Record<string, unknown> => {
    if (!isRecord(login) || typeof login.name !== 'string' || !login.name || typeof login.url !== 'string') return false
    let server: URL
    try {
      server = new URL(login.url)
    } catch {
      return false
    }
    const sshHost = typeof login.ssh_host === 'string' ? login.ssh_host.toLowerCase() : ''
    const sameHost = server.hostname.toLowerCase() === remoteHost.hostname || sshHost === remoteHost.hostname
    // A web remote names the port the server answers on; an SSH one never does.
    return sameHost && (!remoteHost.port || server.port === remoteHost.port)
  })
  const chosen = matches.find((login) => String(login.default) === 'true') ?? matches[0]
  return chosen ? (chosen.name as string) : null
}

/** Whether a listed row's address reads as a request on `forge`, whatever branch it is from. */
function rowClassifies(row: unknown, forge: DrivenForge): boolean {
  if (!isRecord(row)) return false
  const url = forge === 'gitlab' ? row.web_url : row.url
  return typeof url === 'string' && classifyPullRequestUrl(url)?.forge === forge
}

/** A row of `glab mr list --output json`: GitLab's own merge request object. */
function gitlabRow(row: unknown, branch: string): ForgeBranchRequest | null {
  if (!isRecord(row) || typeof row.web_url !== 'string') return null
  if (typeof row.source_branch === 'string' && row.source_branch !== branch) return null
  const classified = classifyPullRequestUrl(row.web_url)
  if (classified?.forge !== 'gitlab') return null
  const state =
    row.state === 'opened' || row.state === 'locked'
      ? 'open'
      : row.state === 'merged'
        ? 'merged'
        : row.state === 'closed'
          ? 'closed'
          : null
  if (!state) return null
  const headSha = typeof row.sha === 'string' && /^[0-9a-f]{7,64}$/iu.test(row.sha) ? row.sha : null
  return { url: classified.url, state, headSha }
}

/** A row of `tea pulls list --output json`: every value a string, the head `branch` or `owner:branch`. */
function giteaRow(row: unknown, branch: string): ForgeBranchRequest | null {
  if (!isRecord(row) || typeof row.url !== 'string' || typeof row.head !== 'string') return null
  // A branch name cannot hold a colon, so what follows the last one is the branch.
  if (row.head.split(':').at(-1) !== branch) return null
  const classified = classifyPullRequestUrl(row.url)
  if (classified?.forge !== 'gitea') return null
  const state = row.state === 'open' || row.state === 'merged' || row.state === 'closed' ? row.state : null
  return state ? { url: classified.url, state, headSha: null } : null
}

/** Where a CLI says why it failed: its last lines, or its exit code when it said nothing. */
function failureDetail(result: GhResult, cli: ForgeCli): string {
  const text = (result.stderr || result.stdout)
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean)
    .slice(-3)
    .join(' ')
  return text || `${cli} exited ${result.code}.`
}
