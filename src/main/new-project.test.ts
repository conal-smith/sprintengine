import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { execFileSync } from 'node:child_process'

import { afterEach, describe, expect, test, vi } from 'vitest'

import { newProjectNameProblem } from '../shared/new-project-name'
import { parseNewProjectInput } from './ipc/github-repos-ipc'
import { createNewProject, listGitHubOwners, realNewProjectDeps, type NewProjectDeps } from './new-project'

type FetchCall = { url: string; method: string; body: unknown; auth: string | null }

// Every GitHub call answered from a table; nothing here reaches the network.
function fakeGitHub(routes: Record<string, { status: number; body: unknown }>) {
  const calls: FetchCall[] = []
  const fetch = vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
    const method = init?.method ?? 'GET'
    const headers = (init?.headers ?? {}) as Record<string, string>
    calls.push({
      url: String(url),
      method,
      body: init?.body ? JSON.parse(String(init.body)) : null,
      auth: headers.Authorization ?? null,
    })
    const route = routes[`${method} ${String(url)}`]
    if (!route) throw new Error(`unexpected ${method} ${String(url)}`)
    return new Response(JSON.stringify(route.body), { status: route.status })
  }) as unknown as typeof globalThis.fetch
  return { fetch, calls }
}

function fakeDeps(
  overrides: Partial<NewProjectDeps> & { failGit?: (args: string[]) => string | null } = {},
): NewProjectDeps & {
  gitCalls: Array<{ args: string[]; cwd: string; env?: Record<string, string> }>
  files: Map<string, string>
  dirs: Set<string>
} {
  const gitCalls: Array<{ args: string[]; cwd: string; env?: Record<string, string> }> = []
  const files = new Map<string, string>()
  const dirs = new Set<string>(['/Users/dev/code/taken'])
  return {
    gitCalls,
    files,
    dirs,
    git: async (args, cwd, env) => {
      gitCalls.push({ args, cwd, env })
      const failure = overrides.failGit?.(args) ?? null
      return failure ? { code: 128, stderr: failure } : { code: 0, stderr: '' }
    },
    exists: async (path) => dirs.has(path) || files.has(path),
    mkdir: async (path) => {
      dirs.add(path)
    },
    writeFile: async (path, content) => {
      files.set(path, content)
    },
    join: (dir, name) => `${dir}/${name}`,
    resolveToken: async () => 'ghp_fixture',
    fetch: (async () => {
      throw new Error('no network in this test')
    }) as unknown as typeof globalThis.fetch,
    ...overrides,
  }
}

const USER = { 'GET https://api.github.com/user': { status: 200, body: { login: 'dev' } } }
const created = (fullName: string, isPrivate = true) => ({
  status: 201,
  body: {
    full_name: fullName,
    html_url: `https://github.com/${fullName}`,
    clone_url: `https://github.com/${fullName}.git`,
    private: isPrivate,
  },
})

describe('new project', () => {
  test('a local project is a folder with a README and one commit, and touches no network', async () => {
    const deps = fakeDeps()
    const result = await createNewProject({ parentDir: '/Users/dev/code', name: 'notes' }, deps)
    expect(result).toEqual({ ok: true, path: '/Users/dev/code/notes', repository: null, warning: null })
    expect(deps.files.get('/Users/dev/code/notes/README.md')).toBe('# notes\n')
    expect(deps.gitCalls.map((c) => c.args.join(' '))).toEqual([
      '-c init.defaultBranch=main init',
      'symbolic-ref HEAD refs/heads/main',
      'add README.md',
      'commit -m Initial commit',
    ])
  })

  test('a name that is not a folder or repository name, or one already taken, makes nothing', async () => {
    expect(newProjectNameProblem('')).toBe('Name the project.')
    expect(newProjectNameProblem('a/b')).not.toBeNull()
    expect(newProjectNameProblem('..')).not.toBeNull()
    expect(newProjectNameProblem('my app')).not.toBeNull()
    expect(newProjectNameProblem('my-app.v2_x')).toBeNull()

    const deps = fakeDeps()
    const taken = await createNewProject({ parentDir: '/Users/dev/code', name: 'taken' }, deps)
    expect(taken).toMatchObject({ ok: false, reason: 'exists' })
    const invalid = await createNewProject({ parentDir: '/Users/dev/code', name: '../up' }, deps)
    expect(invalid).toMatchObject({ ok: false, reason: 'invalid' })
    expect(deps.gitCalls).toEqual([])
  })

  test('publishing makes a PRIVATE repository on the account by default and pushes the first commit', async () => {
    const github = fakeGitHub({ ...USER, 'POST https://api.github.com/user/repos': created('dev/notes') })
    const deps = fakeDeps({ fetch: github.fetch })
    const result = await createNewProject(
      {
        parentDir: '/Users/dev/code',
        name: 'notes',
        publish: { owner: null, visibility: 'private', confirmed: true },
      },
      deps,
    )
    expect(result).toEqual({
      ok: true,
      path: '/Users/dev/code/notes',
      repository: { fullName: 'dev/notes', htmlUrl: 'https://github.com/dev/notes', isPrivate: true },
      warning: null,
    })
    const post = github.calls.find((c) => c.method === 'POST')
    expect(post?.body).toEqual({ name: 'notes', private: true, auto_init: false })
    expect(post?.auth).toBe('Bearer ghp_fixture')
    const gitArgs = deps.gitCalls.map((c) => c.args)
    expect(gitArgs).toContainEqual(['remote', 'add', 'origin', 'https://github.com/dev/notes.git'])
    const push = deps.gitCalls.find((c) => c.args.includes('push'))
    expect(push?.args.slice(-4)).toEqual(['push', '-u', 'origin', 'main'])
    // The token rides the environment, never the argument list.
    expect(push?.args.join(' ')).not.toContain('ghp_fixture')
    expect(push?.env).toMatchObject({ SPRINTENGINE_CLONE_TOKEN: 'ghp_fixture' })
  })

  test('an organisation owner posts to that organisation, and public is only what was asked for', async () => {
    const github = fakeGitHub({ ...USER, 'POST https://api.github.com/orgs/acme/repos': created('acme/app', false) })
    const result = await createNewProject(
      { parentDir: '/Users/dev/code', name: 'app', publish: { owner: 'acme', visibility: 'public', confirmed: true } },
      fakeDeps({ fetch: github.fetch }),
    )
    expect(result).toMatchObject({ ok: true, repository: { fullName: 'acme/app', isPrivate: false } })
    expect(github.calls.find((c) => c.method === 'POST')?.body).toEqual({
      name: 'app',
      private: false,
      auto_init: false,
    })
  })

  test('an unconfirmed publish never reaches GitHub', async () => {
    const github = fakeGitHub({})
    const result = await createNewProject(
      {
        parentDir: '/Users/dev/code',
        name: 'notes',
        publish: { owner: null, visibility: 'private', confirmed: false },
      },
      fakeDeps({ fetch: github.fetch }),
    )
    expect(result).toMatchObject({ ok: true, repository: null })
    expect(result.ok && result.warning).toMatch(/not confirmed/u)
    expect(github.calls).toEqual([])
  })

  test('a commit that fails stops before GitHub, so no empty repository is left behind', async () => {
    const github = fakeGitHub({})
    const result = await createNewProject(
      { parentDir: '/Users/dev/code', name: 'notes', publish: { owner: null, visibility: 'private', confirmed: true } },
      fakeDeps({
        fetch: github.fetch,
        failGit: (args) => (args[0] === 'commit' ? 'Author identity unknown' : null),
      }),
    )
    expect(result).toMatchObject({ ok: true, path: '/Users/dev/code/notes', repository: null })
    expect(result.ok && result.warning).toMatch(/Author identity unknown.*Nothing was published/u)
    expect(github.calls).toEqual([])
  })

  test("GitHub's refusal is said, and the local project still opens", async () => {
    const github = fakeGitHub({
      ...USER,
      'POST https://api.github.com/user/repos': {
        status: 422,
        body: { message: 'Repository creation failed.', errors: [{ message: 'name already exists on this account' }] },
      },
    })
    const result = await createNewProject(
      { parentDir: '/Users/dev/code', name: 'notes', publish: { owner: null, visibility: 'private', confirmed: true } },
      fakeDeps({ fetch: github.fetch }),
    )
    expect(result).toMatchObject({ ok: true, repository: null })
    expect(result.ok && result.warning).toMatch(/name already exists on this account/u)
  })

  test('a clone URL off github.com is not pushed to with the token', async () => {
    const github = fakeGitHub({
      ...USER,
      'POST https://api.github.com/user/repos': {
        status: 201,
        body: { full_name: 'dev/notes', clone_url: 'https://elsewhere.example/dev/notes.git' },
      },
    })
    const deps = fakeDeps({ fetch: github.fetch })
    const result = await createNewProject(
      { parentDir: '/Users/dev/code', name: 'notes', publish: { owner: null, visibility: 'private', confirmed: true } },
      deps,
    )
    expect(result).toMatchObject({ ok: true, repository: null })
    expect(deps.gitCalls.some((c) => c.args.includes('push'))).toBe(false)
  })

  test('no token: the project is made and the warning says how to publish', async () => {
    const result = await createNewProject(
      { parentDir: '/Users/dev/code', name: 'notes', publish: { owner: null, visibility: 'private', confirmed: true } },
      fakeDeps({ resolveToken: async () => '' }),
    )
    expect(result).toMatchObject({ ok: true, repository: null })
    expect(result.ok && result.warning).toMatch(/GitHub token/u)
  })

  test('the owners are the account and its organisations', async () => {
    const github = fakeGitHub({
      ...USER,
      'GET https://api.github.com/user/orgs?per_page=100': { status: 200, body: [{ login: 'acme' }] },
    })
    expect(await listGitHubOwners({ fetch: github.fetch, resolveToken: async () => 'ghp_fixture' })).toEqual({
      ok: true,
      login: 'dev',
      orgs: ['acme'],
    })
    expect(await listGitHubOwners({ fetch: github.fetch, resolveToken: async () => null })).toMatchObject({
      ok: false,
      reason: 'no_token',
    })
  })

  test('the IPC request is parsed strictly, and a missing publish is a local project', () => {
    expect(parseNewProjectInput({ parentDir: '/Users/dev/code', name: 'x' })).toEqual({
      parentDir: '/Users/dev/code',
      name: 'x',
      publish: null,
    })
    expect(parseNewProjectInput({ parentDir: '/Users/dev/code', name: 'x', publish: { owner: null } })).toBeNull()
    expect(
      parseNewProjectInput({
        parentDir: '/Users/dev/code',
        name: 'x',
        publish: { owner: 'acme', visibility: 'internal', confirmed: true },
      }),
    ).toBeNull()
    expect(parseNewProjectInput(null)).toBeNull()
  })
})

describe('new project with real git', () => {
  let dir: string | null = null
  afterEach(() => {
    if (dir) rmSync(dir, { recursive: true, force: true })
    dir = null
  })

  test('makes a repository on main with the first commit', async () => {
    dir = mkdtempSync(join(tmpdir(), 'new-project-'))
    vi.stubEnv('GIT_AUTHOR_NAME', 'Dev')
    vi.stubEnv('GIT_AUTHOR_EMAIL', 'dev@example.com')
    vi.stubEnv('GIT_COMMITTER_NAME', 'Dev')
    vi.stubEnv('GIT_COMMITTER_EMAIL', 'dev@example.com')
    try {
      const deps = realNewProjectDeps(async () => {
        throw new Error('a local project never asks for the token')
      })
      const result = await createNewProject({ parentDir: dir, name: 'notes' }, deps)
      expect(result).toMatchObject({ ok: true, repository: null, warning: null })
      const project = join(dir, 'notes')
      expect(readFileSync(join(project, 'README.md'), 'utf8')).toBe('# notes\n')
      const branch = execFileSync('git', ['-C', project, 'rev-parse', '--abbrev-ref', 'HEAD'], { encoding: 'utf8' })
      expect(branch.trim()).toBe('main')
      const log = execFileSync('git', ['-C', project, 'log', '--format=%s'], { encoding: 'utf8' })
      expect(log.trim()).toBe('Initial commit')
    } finally {
      vi.unstubAllEnvs()
    }
  })
})
