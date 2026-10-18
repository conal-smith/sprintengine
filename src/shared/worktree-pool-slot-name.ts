/**
 * What a worktree pool slot's folder is called (worktree-pool/pool-lease.ts),
 * and how one is told apart from any other folder in the container.
 *
 * A slot is named after the project it is a checkout of, `multicode-05` for
 * `multicode`, so a terminal title, a Files root or a `git worktree list`
 * says which project it is without the path around it. The container is
 * already named after the project (`.sprintengine-worktrees/<project>`), so the
 * stem is derived from the container's own name and both ends agree.
 *
 * Slots made before the rename are `pool-NN`, and keep that name for life: a
 * slot's path is recorded in venvs, caches and chats, so it is never moved.
 * Both spellings are recognised, and they share one sequence of numbers.
 */
import { basename } from './paths'

/** The stem slots took before they were named after their project. */
export const LEGACY_POOL_SLOT_STEM = 'pool'

/** Long enough to say the project, short enough to leave a path its room on Windows. */
const STEM_MAX_LENGTH = 40

/**
 * The project folder's name made safe for a single path segment and for a
 * git branch name (the slot id names held and rescue branches,
 * worktree-branch.ts): lowercased, with anything else, a leading dot, a `..`
 * and a `.lock` ending taken out. A name with nothing left becomes `pool`.
 */
export function poolSlotStem(projectFolderName: string): string {
  const stem = projectFolderName
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9._-]+/gu, '-')
    .replace(/\.{2,}/gu, '-')
    .replace(/-{2,}/gu, '-')
    .replace(/^[-.]+/u, '')
    .slice(0, STEM_MAX_LENGTH)
    .replace(/(?:\.lock)+$/u, '')
    .replace(/[-._]+$/u, '')
  return stem || LEGACY_POOL_SLOT_STEM
}

/** The stem of the slots in a container: `<parent>/.sprintengine-worktrees/<project>`. */
export function poolSlotStemForContainer(containerPath: string): string {
  return poolSlotStem(basename(containerPath))
}

/** Slot `n` of a container whose slots take `stem`: `multicode-05`. */
export function poolSlotName(stem: string, n: number): string {
  return `${stem}-${String(n).padStart(2, '0')}`
}

/**
 * The number of the slot `name` names in a container whose slots take
 * `stem`, under either spelling, or null for a folder no slot would be
 * called. A name is only half the proof: recovery adopts a folder only if
 * the pool also marked it.
 */
export function poolSlotNumber(name: string, stem: string): number | null {
  for (const candidate of new Set([stem, LEGACY_POOL_SLOT_STEM])) {
    if (!name.startsWith(`${candidate}-`)) continue
    const digits = name.slice(candidate.length + 1)
    if (/^\d{2,}$/u.test(digits)) return Number(digits)
  }
  return null
}

/** Whether `path` is a slot's folder: named like one in the container it sits in. */
export function isPoolSlotPath(path: string): boolean {
  const trimmed = path.replace(/[\\/]+$/u, '')
  const parts = trimmed.split(/[\\/]/u)
  const name = parts.pop() ?? ''
  const container = parts.pop() ?? ''
  return poolSlotNumber(name, poolSlotStem(container)) !== null
}
