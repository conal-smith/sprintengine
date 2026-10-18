import { execFileSync } from 'node:child_process'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { vi } from 'vitest'

import { runGitCommand } from '../src/main/git-run'
import type { ArtifactsGit } from '../src/main/artifacts/artifacts-store'

// What the artifacts suites share: a git that knows nobody's own config, a
// bare repository standing in for the remote, and a project on disk to
// publish from.

export const testGit: ArtifactsGit = (cwd, args, env, options) => runGitCommand(cwd, args, env, options)

/** git for the suite: no global or system config, a placeholder identity. */
export async function hermeticGit(): Promise<string> {
  const home = await mkdtemp(join(tmpdir(), 'artifacts-git-home-'))
  await writeFile(join(home, 'gitconfig'), '[init]\n\tdefaultBranch = main\n')
  vi.stubEnv('GIT_CONFIG_GLOBAL', join(home, 'gitconfig'))
  vi.stubEnv('GIT_CONFIG_NOSYSTEM', '1')
  vi.stubEnv('GIT_AUTHOR_NAME', 'Dev')
  vi.stubEnv('GIT_AUTHOR_EMAIL', 'dev@example.com')
  vi.stubEnv('GIT_COMMITTER_NAME', 'Dev')
  vi.stubEnv('GIT_COMMITTER_EMAIL', 'dev@example.com')
  return home
}

export function git(cwd: string, args: string[]): string {
  return execFileSync('git', args, { cwd, encoding: 'utf8', env: process.env })
}

/** A bare repository at `<root>/acme/artifacts.git`, and its file address. */
export async function bareRemote(root: string): Promise<{ path: string; url: string }> {
  const path = join(root, 'remote', 'acme', 'artifacts.git')
  await mkdir(path, { recursive: true })
  git(path, ['init', '--quiet', '--bare', '--initial-branch=main'])
  return { path, url: pathToFileURL(path).toString() }
}

export async function writeFiles(root: string, files: Record<string, string>): Promise<void> {
  for (const [path, content] of Object.entries(files)) {
    await mkdir(dirname(join(root, path)), { recursive: true })
    await writeFile(join(root, path), content)
  }
}

/** The files on the remote's main. */
export function remoteFiles(remote: string): string[] {
  try {
    return git(remote, ['ls-tree', '-r', '--name-only', 'main']).trim().split('\n').filter(Boolean)
  } catch {
    return []
  }
}

export function remoteFile(remote: string, path: string): string {
  return git(remote, ['show', `main:${path}`])
}

export async function cleanup(paths: string[]): Promise<void> {
  for (const path of paths.splice(0)) await rm(path, { recursive: true, force: true })
}
