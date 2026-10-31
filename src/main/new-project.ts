import { execFile } from 'child_process'
import { lstat, mkdir, writeFile } from 'fs/promises'
import { join } from 'path'

import type { GitHubOwnerListResult, NewProjectInput, NewProjectResult } from '../shared/electron-api'
import { newProjectNameProblem } from '../shared/new-project-name'
import { tokenCredentialGit } from './git-clone'
import { withGitExecutable } from './git-executable'

// A project started from nothing: a folder, a repository with one commit in
// it, and — only when the person asked for it and confirmed — a repository on
// their GitHub account that the commit is pushed to.
//
// The order is the point. Everything local happens first, and the outward
// step (a new repository on someone's account) runs only once there is a
// commit to push, so a failure part-way leaves a working local project rather
// than an empty repository on GitHub with nothing behind it. A failure after
// the folder exists is a `warning` on a success, not a failure: the folder is
// real, and the person opens it either way.
//
// Everything that touches the disk, git or the network comes in as
// `NewProjectDeps`, so the flow is tested with fakes and no test ever makes a
// repository on anyone's account.

const GITHUB_API = 'https://api.github.com'
const DEFAULT_BRANCH = 'main'

export type NewProjectGitResult = { code: number; stderr: string }

export type NewProjectDeps = {
  /** Runs git in `cwd`. Resolves with the exit code; never rejects for a non-zero exit. */
  git(args: string[], cwd: string, env?: Record<string, string>): Promise<NewProjectGitResult>
  /** Whether anything is at `path`. */
  exists(path: string): Promise<boolean>
  mkdir(path: string): Promise<void>
  writeFile(path: string, content: string): Promise<void>
  join(dir: string, name: string): string
  /** The saved GitHub token, or null/empty when there is none. */
  resolveToken(): Promise<string | null>
  fetch: typeof fetch
}

function githubHeaders(token: string): Record<string, string> {
  return {
    Accept: 'application/vnd.github+json',
    Authorization: `Bearer ${token}`,
    'User-Agent': 'sprintengine-new-project',
    'X-GitHub-Api-Version': '2022-11-28',
  }
}

function tail(stderr: string): string {
  const lines = stderr.trim().split(/\r?\n/u).filter(Boolean)
  return lines.slice(-3).join(' ') || 'git gave no reason.'
}

/** The signed-in account and the organisations it belongs to, for the owner field. */
export async function listGitHubOwners(
  deps: Pick<NewProjectDeps, 'resolveToken' | 'fetch'>,
): Promise<GitHubOwnerListResult> {
  const token = (await deps.resolveToken())?.trim()
  if (!token) return { ok: false, reason: 'no_token', message: 'No GitHub token is configured.' }
  try {
    const user = await deps.fetch(`${GITHUB_API}/user`, { headers: githubHeaders(token) })
    if (user.status === 401 || user.status === 403) {
      return {
        ok: false,
        reason: 'unauthorized',
        message: 'GitHub rejected the saved token. Check it in Settings → Version control.',
      }
    }
    if (!user.ok) return { ok: false, reason: 'network', message: `GitHub returned HTTP ${user.status}.` }
    const login = ((await user.json()) as { login?: unknown }).login
    if (typeof login !== 'string' || !login) {
      return { ok: false, reason: 'network', message: 'GitHub returned an unexpected response shape.' }
    }
    // The organisations are a convenience; a token that cannot read them still
    // publishes under the account itself.
    const orgs: string[] = []
    const orgResponse = await deps.fetch(`${GITHUB_API}/user/orgs?per_page=100`, { headers: githubHeaders(token) })
    if (orgResponse.ok) {
      const payload = (await orgResponse.json()) as unknown
      if (Array.isArray(payload)) {
        for (const org of payload) {
          const name = (org as { login?: unknown }).login
          if (typeof name === 'string' && name) orgs.push(name)
        }
      }
    }
    return { ok: true, login, orgs }
  } catch (error) {
    return { ok: false, reason: 'network', message: error instanceof Error ? error.message : 'Could not reach GitHub.' }
  }
}

type CreatedRepository = { fullName: string; htmlUrl: string; cloneUrl: string; isPrivate: boolean }

// The one outward call. Private unless the person picked public.
async function createGitHubRepository(
  token: string,
  owner: string | null,
  name: string,
  isPrivate: boolean,
  deps: Pick<NewProjectDeps, 'fetch'>,
): Promise<{ ok: true; repository: CreatedRepository } | { ok: false; message: string }> {
  const headers = { ...githubHeaders(token), 'Content-Type': 'application/json' }
  const user = await deps.fetch(`${GITHUB_API}/user`, { headers })
  if (!user.ok) return { ok: false, message: `GitHub would not say who the token belongs to (HTTP ${user.status}).` }
  const login = ((await user.json()) as { login?: unknown }).login
  if (typeof login !== 'string' || !login) return { ok: false, message: 'GitHub returned an unexpected response.' }

  const target = owner?.trim() || login
  const endpoint =
    target.toLowerCase() === login.toLowerCase()
      ? `${GITHUB_API}/user/repos`
      : `${GITHUB_API}/orgs/${encodeURIComponent(target)}/repos`
  const response = await deps.fetch(endpoint, {
    method: 'POST',
    headers,
    body: JSON.stringify({ name, private: isPrivate, auto_init: false }),
  })
  const payload = (await response.json().catch(() => null)) as {
    full_name?: unknown
    html_url?: unknown
    clone_url?: unknown
    private?: unknown
    message?: unknown
    errors?: Array<{ message?: unknown }>
  } | null
  if (!response.ok) {
    const detail =
      payload?.errors?.map((e) => (typeof e.message === 'string' ? e.message : '')).find(Boolean) ??
      (typeof payload?.message === 'string' ? payload.message : `HTTP ${response.status}`)
    return { ok: false, message: `GitHub did not create ${target}/${name}: ${detail}` }
  }
  const cloneUrl = typeof payload?.clone_url === 'string' ? payload.clone_url : ''
  // The push carries the token, so it only ever goes to github.com over https.
  let cloneHost = ''
  try {
    const parsed = new URL(cloneUrl)
    cloneHost = parsed.protocol === 'https:' ? parsed.hostname : ''
  } catch {
    cloneHost = ''
  }
  if (cloneHost !== 'github.com' || typeof payload?.full_name !== 'string') {
    return { ok: false, message: 'GitHub returned an unexpected response for the new repository.' }
  }
  return {
    ok: true,
    repository: {
      fullName: payload.full_name,
      htmlUrl: typeof payload.html_url === 'string' ? payload.html_url : `https://github.com/${payload.full_name}`,
      cloneUrl,
      isPrivate: payload.private !== false,
    },
  }
}

export async function createNewProject(input: NewProjectInput, deps: NewProjectDeps): Promise<NewProjectResult> {
  const name = input.name.trim()
  const problem = newProjectNameProblem(name)
  if (problem) return { ok: false, reason: 'invalid', message: problem }
  if (!input.parentDir.trim()) return { ok: false, reason: 'invalid', message: 'Choose where to make the project.' }

  const target = deps.join(input.parentDir, name)
  if (await deps.exists(target)) {
    return { ok: false, reason: 'exists', message: `${name} already exists in that folder. Choose another name.` }
  }

  try {
    await deps.mkdir(target)
    await deps.writeFile(deps.join(target, 'README.md'), `# ${name}\n`)
  } catch (error) {
    return {
      ok: false,
      reason: 'failed',
      message: error instanceof Error ? error.message : 'Could not create the project folder.',
    }
  }

  const done = (warning: string | null, repository: CreatedRepository | null = null): NewProjectResult => ({
    ok: true,
    path: target,
    repository: repository
      ? { fullName: repository.fullName, htmlUrl: repository.htmlUrl, isPrivate: repository.isPrivate }
      : null,
    warning,
  })

  const init = await deps.git(['-c', `init.defaultBranch=${DEFAULT_BRANCH}`, 'init'], target)
  if (init.code !== 0) return done(`The folder is made, but git init failed: ${tail(init.stderr)}`)
  // Named outright too: an older git ignores init.defaultBranch.
  await deps.git(['symbolic-ref', 'HEAD', `refs/heads/${DEFAULT_BRANCH}`], target)
  const add = await deps.git(['add', 'README.md'], target)
  const commit =
    add.code === 0 ? await deps.git(['commit', '-m', 'Initial commit'], target) : { code: add.code, stderr: add.stderr }
  if (commit.code !== 0) {
    return done(
      `The repository is made, but git could not commit to it: ${tail(commit.stderr)}` +
        (input.publish ? ' Nothing was published to GitHub.' : ''),
    )
  }

  const publish = input.publish
  if (!publish) return done(null)
  // Only an explicit, confirmed request reaches GitHub. The form asks the
  // person to confirm before it sends one; a request without the mark is
  // refused here as well, so nothing else can publish by accident.
  if (publish.confirmed !== true) return done('Not published: the GitHub repository was not confirmed.')

  const token = (await deps.resolveToken())?.trim()
  if (!token) return done('Not published: add a GitHub token in Settings → Version control, then publish it.')

  let created: Awaited<ReturnType<typeof createGitHubRepository>>
  try {
    created = await createGitHubRepository(token, publish.owner, name, publish.visibility !== 'public', deps)
  } catch (error) {
    created = { ok: false, message: error instanceof Error ? error.message : 'Could not reach GitHub.' }
  }
  if (!created.ok) return done(`The project is made locally. ${created.message}`)

  const repository = created.repository
  const remote = await deps.git(['remote', 'add', 'origin', repository.cloneUrl], target)
  if (remote.code !== 0) {
    return done(
      `${repository.fullName} is on GitHub, but adding it as origin failed: ${tail(remote.stderr)}`,
      repository,
    )
  }
  const signIn = tokenCredentialGit('github.com', token)
  const push = await deps.git([...signIn.args, 'push', '-u', 'origin', DEFAULT_BRANCH], target, signIn.env)
  if (push.code !== 0) {
    return done(`${repository.fullName} is on GitHub, but the first push failed: ${tail(push.stderr)}`, repository)
  }
  return done(null, repository)
}

/** The real disk, git and network. */
export function realNewProjectDeps(resolveToken: () => Promise<string | null>): NewProjectDeps {
  const baseEnv = (): NodeJS.ProcessEnv => ({
    ...process.env,
    LC_ALL: 'C',
    GIT_TERMINAL_PROMPT: '0',
  })
  return {
    git: (args, cwd, extraEnv) => {
      const env = { ...baseEnv(), ...extraEnv }
      return withGitExecutable(
        env,
        (file) =>
          new Promise<NewProjectGitResult>((resolve) => {
            execFile(file, args, { cwd, env, windowsHide: true, encoding: 'utf8' }, (error, _stdout, stderr) => {
              const code = error ? (typeof error.code === 'number' ? error.code : 1) : 0
              resolve({ code, stderr: stderr || (error ? error.message : '') })
            })
          }),
      )
    },
    exists: async (path) => (await lstat(path).catch(() => null)) !== null,
    mkdir: async (path) => {
      await mkdir(path, { recursive: true })
    },
    writeFile: (path, content) => writeFile(path, content, { encoding: 'utf8', flag: 'wx' }),
    join,
    resolveToken,
    fetch: (...args) => fetch(...args),
  }
}
