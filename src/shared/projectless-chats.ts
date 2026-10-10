/**
 * Chats started without a project. Each still runs somewhere real — an agent
 * CLI needs a working directory, and a chat with none either refused to start
 * or fell back to the app's own — so each gets a folder of its own under one
 * root in the person's home: `~/.sprintengine/chats/<date>-<words>-<id>`.
 *
 * The root plays the project: the sidebar files every such chat under it as
 * "No project", New chat scoped to it means "start without a project", and the
 * folder a launch makes inside it is that one chat's, the way a worktree is.
 * A folder of its own rather than one shared folder so two chats never trip
 * over each other's files, and so a chat's files are where its row reveals.
 *
 * Recognised by path shape rather than a flag on the record, like the worktree
 * container convention beside it (`worktree-paths.ts`): every reader — the
 * sidebar, the stores, main's registry ordering — answers the same way from
 * the path alone, and nothing on the workspace wire changes.
 *
 * String-only, no Node `path`, so the renderer and main share it.
 */
import { parentPath, pathJoin, slugify, trimPath } from './paths'

/** The root's path below the home folder, segment by segment. */
export const PROJECTLESS_CHATS_SEGMENTS = ['.sprintengine', 'chats'] as const

/** What the root is called wherever a project's name would be. */
export const PROJECTLESS_CHATS_LABEL = 'No project'

/** `<home>/.sprintengine/chats`, in the home folder's own separator. */
export function projectlessChatsRootIn(home: string): string {
  return pathJoin(home, ...PROJECTLESS_CHATS_SEGMENTS)
}

/** True for the root itself: the "No project" scope. */
export function isProjectlessChatsRoot(pathValue: string | null | undefined): boolean {
  const trimmed = pathValue?.trim()
  if (!trimmed) return false
  const segments = trimPath(trimmed).split(/[\\/]+/)
  // Something must stand above `.sprintengine` — the home folder — or this is
  // a relative path that only looks like the root.
  if (segments.length < 3) return false
  const tail = segments.slice(-PROJECTLESS_CHATS_SEGMENTS.length).map((segment) => segment.toLowerCase())
  return PROJECTLESS_CHATS_SEGMENTS.every((segment, index) => tail[index] === segment)
}

/**
 * The root a chat's own folder sits in, or null for any other path. Only a
 * DIRECT child counts: a folder the agent made inside its chat's folder is
 * that chat's work, not a chat of its own.
 */
export function projectlessChatsRootOf(pathValue: string | null | undefined): string | null {
  const trimmed = pathValue?.trim()
  if (!trimmed || isProjectlessChatsRoot(trimmed)) return null
  const parent = parentPath(trimmed)
  return parent !== trimPath(trimmed) && isProjectlessChatsRoot(parent) ? parent : null
}

/**
 * The "No project" scope a path stands for — the root for the root and for a
 * chat's folder in it — or null when the path is an ordinary folder. New chat
 * opened from a project-less chat starts another one, never a chat inside the
 * first one's folder.
 */
export function projectlessScopeOf(pathValue: string | null | undefined): string | null {
  const trimmed = pathValue?.trim()
  if (!trimmed) return null
  if (isProjectlessChatsRoot(trimmed)) return trimPath(trimmed)
  return projectlessChatsRootOf(trimmed)
}

const NAME_WORDS = 5
const NAME_WORDS_MAX_LENGTH = 48

/**
 * A chat folder's name: the day, the first few words the chat was started
 * with, and a short id that keeps two chats started alike apart —
 * `2026-10-10-convert-these-pngs-to-webp-3f9a2c1d`. Readable in Finder and in
 * a terminal's prompt, and sorted by when it was made.
 */
export function projectlessChatFolderName(input: { prompt?: string | null; now: Date; id: string }): string {
  const day = [
    input.now.getFullYear(),
    String(input.now.getMonth() + 1).padStart(2, '0'),
    String(input.now.getDate()).padStart(2, '0'),
  ].join('-')
  const words = slugify((input.prompt ?? '').split(/\s+/).filter(Boolean).slice(0, NAME_WORDS).join(' '))
    .slice(0, NAME_WORDS_MAX_LENGTH)
    .replace(/-+$/u, '')
  const id = slugify(input.id).slice(-8) || 'chat'
  return [day, words || 'chat', id].join('-')
}
