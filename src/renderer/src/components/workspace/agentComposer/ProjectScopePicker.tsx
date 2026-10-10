import React from 'react'

import { sortByLastUse } from '../../../../../shared/project-frecency'
import { workspaceProjectRootOf } from '../../../../../shared/worktree-paths'
import { isProjectlessChatsRoot } from '../../../../../shared/projectless-chats'
import { basename } from '../../../utils/paths'
import { showToast } from '../../../store/toastStore'
import { useWorkspaceStore } from '../../../store/workspaceStore'
import { useProjectColors } from '../../../hooks/useProjectColors'
import { projectColorKey, resolveProjectColor, type ProjectColor } from '../../../utils/projectColor'
import { ChipButton, Popover } from '../../ui'
import { FolderIdentityIcon } from '../FolderIdentityIcon'
import {
  folderIdentityKey,
  useFolderRepositoryIdentities,
  type FolderIdentityMap,
} from '../useFolderRepositoryIdentities'
import { resolveDefaultParentPath } from '../newWorkspace/folderCreation'
import {
  focusProjectSearch,
  ProjectSourceMenu,
  type ProjectCloneRequest,
  type ProjectCloneResult,
  type ProjectSourceOption,
} from './ProjectSourceMenu'
import { ChipCaretGlyph } from './agentSpawnShared'

// "Which project is this about?", as one chip.
//
// It was a local function inside `NewAgentPanel` until the Design door needed
// the same control: that door opens from the Extensions drawer and silently
// bound to whichever workspace happened to be focused last, so pointing the app
// at a different folder made it claim knowledge of a project the user never
// chose (owner, 2026-09-07). Two surfaces asking the same question have to ask
// it with the same control, so the chip lives here and `ProjectSourceMenu` — the
// searchable body it opens — stays exactly where it was, beside it.
//
// New chat's behaviour is unchanged by the move: same chip, same menu, same
// clone handling, same recents.
//
// The chip WEARS THE PROJECT'S COLOUR (owner ruling 2026-09-09, backlog item
// `one-colour-per-project-on-the-folder-glyph`, decision 7). The owner's
// complaint was "I keep opening up a new chat and forgetting to pick the
// project", and the fix is that a chosen project and no project stop looking
// alike: a chosen one is a solid folder in its own hue, and no project at all
// is a dashed, colourless folder reading "Choose a project". The colour is on
// the glyph and nowhere else on the line — decision 1 — so there is no tinted
// pill and no dot, and there is deliberately no hint text under the chip
// (owner: the person can figure it out from the composer below).

/** One choosable project scope: a folder some open workspace lives in. */
export type ProjectScopeOption = ProjectSourceOption

export function ProjectScopePicker({
  label,
  branch,
  options,
  selectedPath,
  onSelect,
  onStartWithoutProject,
  onBrowse,
  onClone,
  importFromGit = true,
  ariaLabel = 'Project this agent runs in',
  color,
  unfiled,
  identities,
}: {
  label: string
  /** Checked-out branch, shown after the project name. Null on a door with no checkout. */
  branch: string | null
  options: ProjectScopeOption[]
  selectedPath: string | null
  onSelect: (path: string) => void
  /** Absent hides the "No project" source (a host whose question needs a folder). */
  onStartWithoutProject?: () => void
  /** Absent hides the Browse… source (a host with no folder dialog). */
  onBrowse?: () => void
  /**
   * Runs the clone and ADOPTS the result. It lives with the host rather than in
   * the menu: the popover can close mid-clone, and a success that arrived into
   * an unmounted menu used to be lost. Absent falls back to cloning in place.
   */
  onClone?: (request: ProjectCloneRequest) => Promise<ProjectCloneResult>
  /**
   * Whether Import from Git is one of the sources. The Design door says no: its
   * product model is bring/render/point-at, a system is a folder that already
   * exists on the user's disk, and offering to clone one would be a second way
   * in that the epic explicitly cut.
   */
  importFromGit?: boolean
  /** What the trigger is called, for a host whose question is not "which project does this agent run in". */
  ariaLabel?: string
  /**
   * The chosen project's hue, when the HOST already knows it.
   *
   * A project is a repository (decision 3), and only the host holds the
   * repository identity behind `selectedPath` — New chat reads it for the
   * machine list anyway. Passing it here is therefore the accurate answer, and
   * `null` is a real one: an unseen project, or a person who chose "No colour".
   * Omitting the prop entirely asks this component to resolve the hue from the
   * path alone, which is right for a folder with no remote and simply misses —
   * a plain folder glyph — for one that has.
   */
  color?: ProjectColor | null
  /**
   * No project is chosen, so the glyph is the dashed grey outline: no folder is
   * not a project (decision 6). Defaults to "nothing is selected", which is what
   * it means on every host that passes `selectedPath` honestly.
   */
  unfiled?: boolean
  /**
   * Which repository each offered folder is a clone of, so the rows in the
   * popover wear their own hues rather than only the chosen one.
   *
   * Handed down rather than read here: New chat already asks main for exactly
   * this map (`useFolderRepositoryIdentities` over the scope and every option),
   * and a second reader would repeat every IPC for the same answer. It covers
   * the folders the HOST knows; the recents below are this component's own rows
   * and it asks for those itself. A host with no map still gets colours — the
   * rows fall back to the folder key, which finds the projects that have no
   * remote and misses the rest, and a miss is a plain glyph, never a wrong one.
   */
  identities?: FolderIdentityMap
}) {
  // Projects this app knows beyond the ones open in this window: the recent
  // folders the workspace hub lists. Searching the selector covers them too,
  // so a repo opened last week is one keystroke away rather than a Browse.
  const storedRecentFolders = useWorkspaceStore((s) => s.appSettings.recentWorkspaceFolders ?? [])
  // A recent folder inside a worktree container (a pool slot, `chat-…`) was a
  // chat's worktree, opened from the hub: it offers its project instead.
  const recentOptions = React.useMemo<ProjectScopeOption[]>(() => {
    const open = new Set(options.map((option) => folderPathKey(option.path)))
    const seen = new Set<string>()
    const recents: ProjectScopeOption[] = []
    for (const path of storedRecentFolders) {
      const project = workspaceProjectRootOf({ folderPath: path })
      if (!project || isProjectlessChatsRoot(project)) continue
      const key = folderPathKey(project)
      if (open.has(key) || seen.has(key)) continue
      seen.add(key)
      recents.push({ path: project, label: basename(project) || project })
    }
    return recents
  }, [options, storedRecentFolders])
  // One list, the project used last first (owner, 2026-10-08, replacing the
  // frecency order and the separate "Recent" section of 2026-10-06): by the
  // later of the last new chat main recorded for it (shared/project-frecency.ts)
  // and the last message in any of its chats here. Never-used projects keep
  // the order they came in, open ones (rail order) before the recents.
  const projectUsage = useWorkspaceStore((s) => s.appSettings.projectUsage)
  const orderedOptions = React.useMemo(
    () =>
      sortByLastUse(
        [...options, ...recentOptions],
        (option) => option.path,
        projectUsage,
        (option) => option.lastUsedAt,
      ),
    [options, projectUsage, recentOptions],
  )
  // One map for the chip and every row in the list, out of the same store the
  // sidebar's glyphs read, so a colour changed from the project header moves
  // all of them at once.
  const projectColors = useProjectColors()
  // The recents are this component's own rows, so their identities are its own
  // question to ask. The host's map covers the projects the host knows — the
  // scope and the open ones — and a recent clone of an open repository is
  // exactly the row that would otherwise sit grey beside its blue twin, which
  // is the confusion the colour exists to end. Main caches the answer, so this
  // is a read of a cache rather than a git call per row.
  const recentIdentities = useFolderRepositoryIdentities(
    React.useMemo(() => recentOptions.map((option) => option.path), [recentOptions]),
  )
  const colorOf = React.useCallback(
    (path: string | null | undefined): ProjectColor | null => {
      const folderPath = path?.trim()
      if (!folderPath) return null
      const key = folderIdentityKey(folderPath)
      // No hue until the folder's repository question is ANSWERED: an unasked
      // folder keys by its path and re-keys to `repo:` a beat later, and since
      // the hue is hashed from the key, painting early shows one colour and
      // then another. An answered "not a repository" is a stored null and an
      // unasked folder is absent, so `has` is the test. A host with no map at
      // all (the Design door) never learns the repository, so for it the path
      // key is already final.
      if (identities && !identities.has(key) && !recentIdentities.has(key)) return null
      const repository = identities?.get(key) ?? recentIdentities.get(key) ?? null
      return resolveProjectColor(projectColors, projectColorKey({ folderPath, repository }))
    },
    [identities, projectColors, recentIdentities],
  )
  const chipColor = color === undefined ? colorOf(selectedPath) : color
  const chipUnfiled = unfiled ?? !selectedPath?.trim()
  // Cold start: nothing open and nothing recent still needs somewhere for a
  // clone to land, so the app's default parent (the hub's own fallback) is
  // asked for once rather than telling the person to open a project first.
  const [fallbackParent, setFallbackParent] = React.useState<string | null>(null)
  React.useEffect(() => {
    let active = true
    void window.api
      .defaultWorkspaceParentDir?.()
      .then((dir) => {
        if (active) setFallbackParent(dir)
      })
      .catch(() => {})
    return () => {
      active = false
    }
  }, [])
  // Where an imported repository lands: beside the current project, else
  // beside the first offered one, else beside a recent one, else the app's
  // default — the same smart-parent resolver the workspace hub uses.
  const defaultParent = resolveDefaultParentPath({
    folderPath: selectedPath,
    recentFolders: [...options.map((option) => option.path), ...storedRecentFolders],
    fallbackParent,
  })
  // A host that runs the clone itself outlives this popover; without one the
  // panel clones in place (the tab-strip host offers no picker, so in practice
  // this is the door with an older host).
  const runClone = React.useCallback(
    async (request: ProjectCloneRequest): Promise<ProjectCloneResult> => {
      if (onClone) return onClone(request)
      const cloned = await window.api
        .cloneGitHubRepo(request)
        .catch((caught: unknown): { ok: false; message: string } => ({
          ok: false,
          message: caught instanceof Error ? caught.message : 'Could not clone the repository.',
        }))
      if (!cloned.ok) return cloned
      showToast({ tone: 'good', title: `Cloned ${basename(cloned.path) || cloned.path}`, description: cloned.path })
      onSelect(cloned.path)
      return { ok: true, path: cloned.path }
    },
    [onClone, onSelect],
  )
  const [open, setOpen] = React.useState(false)
  return (
    <Popover
      open={open}
      onOpenChange={setOpen}
      ariaLabel={ariaLabel}
      popupRole="menu"
      placement="bottom-start"
      onOpenAutoFocus={focusProjectSearch}
      // A long project name gives way before the controls beside it do: the
      // chip may shrink, and its name truncates rather than pushing the
      // Worktree switch off the end of a narrow strip.
      className="min-w-0"
      renderTrigger={({ ref, triggerProps, togglePopover }) => (
        // Exactly the machine trigger's box, because it is now literally the
        // same component: the scope line is one row of sibling chips, and the
        // kit's chip is what they are all made of.
        <ChipButton
          ref={ref}
          variant="raised"
          onClick={togglePopover}
          // A stable hook for the passes that reach the folder through this
          // control.
          data-project-trigger="true"
          {...triggerProps}
        >
          {/* The one coloured thing on the line, and the SAME component the
              sidebar's folder header uses — so a project with a detected logo
              shows its logo here too, and the hue is what the glyph falls back
              to rather than a second mark beside it. A logo already answers
              "which project is this"; a hue behind one would answer it twice. */}
          <FolderIdentityIcon
            folderPath={selectedPath}
            className="icon-xs shrink-0"
            color={chipColor}
            unfiled={chipUnfiled}
          />
          <span className="min-w-0 truncate">
            {label}
            {branch ? ` · ${branch}` : ''}
          </span>
          <ChipCaretGlyph />
        </ChipButton>
      )}
    >
      {/* Search + sources (remote-sessions-ux / project-selector-sources):
          the selector filters the projects, browses the disk, and steps in
          place into the shipped Git import — one surface, no second
          dialog stacked on the first. */}
      <ProjectSourceMenu
        options={orderedOptions}
        selectedPath={selectedPath}
        defaultParent={defaultParent}
        onSelect={(path) => onSelect(path)}
        colorOf={colorOf}
        onStartWithoutProject={onStartWithoutProject}
        onBrowse={onBrowse}
        onClone={importFromGit ? runClone : undefined}
        onClose={() => setOpen(false)}
      />
    </Popover>
  )
}

// One key per folder whatever the separator or trailing slash, so an open
// project and its recent-folders twin count once.
function folderPathKey(path: string): string {
  return path.replace(/\\/g, '/').replace(/\/+$/u, '').toLowerCase()
}
