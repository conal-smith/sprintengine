import { lstat, realpath } from 'node:fs/promises'
import { homedir } from 'node:os'
import { join, relative, resolve, sep } from 'node:path'

import { isPathInsideOrEqual, isPathStrictlyInside } from '../path-containment'

// Where a skill is installed, attached or removed is judged by where it really
// is. In a project, every folder from the project down to the skill's own
// folder must be a real folder rather than a link, and the nearest one that
// exists must really be inside the project, so a project whose `.claude` or
// `.agents` is a link cannot point a skill copy, or a removal, somewhere else.
//
// The home folder is the person's own setup, where a linked `~/.claude` is how
// dotfiles are kept, so a skill installed for every project is not held to it.

/** Whether `dir` really sits inside `root`, through no linked folder. */
export async function skillDirStaysInRoot(
  root: string,
  dir: string,
  options: { home?: string } = {},
): Promise<boolean> {
  const base = resolve(root)
  const target = resolve(dir)
  if (!isPathStrictlyInside(base, target)) return false
  if (base === resolve(options.home ?? homedir())) return true

  let at = base
  let nearest = base
  for (const segment of relative(base, target).split(sep)) {
    at = join(at, segment)
    const info = await lstat(at).catch(() => null)
    if (!info) break
    if (info.isSymbolicLink()) return false
    nearest = at
  }
  const realRoot = await realpath(base).catch(() => null)
  const realNearest = await realpath(nearest).catch(() => null)
  return realRoot !== null && realNearest !== null && isPathInsideOrEqual(realRoot, realNearest)
}

/** Whether a skill's `SKILL.md` is a file of its own, not a link to one elsewhere. */
export async function isOwnSkillEntry(path: string): Promise<boolean> {
  const info = await lstat(path).catch(() => null)
  return info !== null && info.isFile()
}
