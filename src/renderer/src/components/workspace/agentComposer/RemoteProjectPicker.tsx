import React from 'react'

import type { MeshConnection, MeshWorkspace, MeshWorkspaceCheckout } from '../../../../../shared/tailnet-mesh'
import { useProjectColors } from '../../../hooks/useProjectColors'
import { projectColorKey, resolveProjectColor, type ProjectColor } from '../../../utils/projectColor'
import { FolderTypeIcon } from '../../AppIcons'
import { ChipButton, Input, MENU_LIST_CLASS, MenuOption, Popover } from '../../ui'
import { ChipCaretGlyph } from './agentSpawnShared'
import { focusProjectSearch } from './ProjectSourceMenu'
import type { RemoteProject } from './remoteProjects'

/** A paired machine New chat is aimed at, and what it has said so far. */
export type RemoteTargetState = {
  connection: MeshConnection
  /** What `workspace.list` served: the machine's open CHATS, not its projects. */
  workspaces: MeshWorkspace[] | null
  /** Those chats folded into the folders they stand in — the list the chip offers. */
  projects: RemoteProject[] | null
  error: string | null
  picked: RemoteProject | null
  /** The picked project's checkout facts, for the branch the launch names; null until read, or unreadable. */
  checkout: MeshWorkspaceCheckout | null
  /** What the machine said it can do, from its browse; null until it answered, or when it said nothing. */
  capabilities: readonly string[] | null
}

/**
 * A remote machine's projects: its workspaces, served over the mesh client.
 * Loading and unreachable states are said plainly — a machine that does not
 * answer keeps its entry with the reason, never a silent empty list.
 */
export function RemoteProjectPicker({
  target,
  color,
  onPick,
}: {
  target: RemoteTargetState
  /**
   * The picked project's hue — the SAME hue the local clone of that repository
   * wears here (decision 3: a project is a repository, and the machine is a
   * glyph on the line rather than a second colour). Null until a project is
   * picked, and null for a picked project whose machine could not say which
   * repository it is: that one keeps the plain solid glyph rather than being
   * keyed by a path on someone else's disk.
   */
  color: ProjectColor | null
  onPick: (project: RemoteProject) => void
}) {
  const [open, setOpen] = React.useState(false)
  const [query, setQuery] = React.useState('')
  // Each row's own hue, out of the same store the local list reads. A remote
  // project carries the repository its machine read, so the row for this
  // disk's project is the colour it is here — which is how a person picks the
  // right one out of a machine holding a dozen.
  const projectColors = useProjectColors()
  const colorOfProject = (project: RemoteProject): ProjectColor | null =>
    project.repository
      ? resolveProjectColor(projectColors, projectColorKey({ folderPath: null, repository: project.repository }))
      : null
  const needle = query.trim().toLowerCase()
  const visibleProjects =
    target.projects === null
      ? null
      : needle
        ? target.projects.filter(
            (project) =>
              project.name.toLowerCase().includes(needle) || project.folderPath.toLowerCase().includes(needle),
          )
        : target.projects
  const label = target.error
    ? 'Unavailable'
    : target.projects === null
      ? 'Loading…'
      : (target.picked?.name ?? 'Choose a project')
  // Dashed says one thing and only one: there is no folder here, so there is no
  // project (decision 6). That is true of "Choose a project" — the machine
  // answered and nothing has been picked — and false of "Loading…" and
  // "Unavailable", which are open questions rather than an answer of "none". A
  // dash on those would report an unfiled chat where there is a machine that
  // has not spoken yet, so they keep the plain solid glyph.
  const unfiled = !target.picked && target.projects !== null && !target.error
  return (
    <Popover
      open={open}
      onOpenChange={setOpen}
      ariaLabel={`Project on ${target.connection.machineName}`}
      popupRole="menu"
      placement="bottom-start"
      surfaceClassName={`w-[280px] ${MENU_LIST_CLASS}`}
      onOpenAutoFocus={focusProjectSearch}
      // As the local project chip: its name gives way first on a narrow strip.
      className="min-w-0"
      renderTrigger={({ ref, triggerProps, togglePopover }) => (
        // The same stable hook the local chip carries: the two never render
        // together, so a pass looking for "the project control on the scope
        // line" finds whichever one is there.
        <ChipButton ref={ref} variant="raised" onClick={togglePopover} data-project-trigger="true" {...triggerProps}>
          {/* The bare glyph, not `FolderIdentityIcon`: a logo is detected by
              reading THIS disk, and the folder is on another machine. */}
          <FolderTypeIcon className="icon-xs shrink-0" color={color} unfiled={unfiled} />
          <span className="min-w-0 truncate">{label}</span>
          <ChipCaretGlyph />
        </ChipButton>
      )}
    >
      <>
        {target.projects !== null && target.projects.length > 0 && !target.error ? (
          // The same search-first shape the local selector opens on, with the
          // same words: the list is projects either way, so the placeholder
          // says so rather than naming the machine the chip beside it names.
          <div className="px-1.5 pb-1">
            <Input
              type="text"
              size="sm"
              autoFocus
              value={query}
              onChange={(event) => setQuery(event.target.value)}
              placeholder="Search projects…"
              aria-label={`Search projects on ${target.connection.machineName}`}
            />
          </div>
        ) : null}
        {target.error ? (
          <div className="px-2.5 py-1.5 text-meta text-[color:var(--tone-error)]">{target.error}</div>
        ) : visibleProjects === null ? (
          <div className="px-2.5 py-1.5 text-meta text-[color:var(--text-muted)]">Loading projects…</div>
        ) : visibleProjects.length === 0 ? (
          <div className="px-2.5 py-1.5 text-meta text-[color:var(--text-muted)]">
            {needle ? 'No matching projects.' : 'No projects open on that machine.'}
          </div>
        ) : (
          visibleProjects.map((project) => (
            <MenuOption
              key={project.key}
              role="menuitemradio"
              selected={target.picked?.key === project.key}
              stacked
              onClick={() => {
                onPick(project)
                setOpen(false)
              }}
              icon={<FolderTypeIcon className="mt-0.5 icon-xs shrink-0" color={colorOfProject(project)} />}
            >
              {/* The FOLDER's name and the folder's path — the same two lines
                  the local list gives a project. What stands in it is the
                  machine's business, not a second name for the row. */}
              <span className="block truncate text-body font-medium">{project.name}</span>
              <span className="block truncate font-mono text-micro text-[color:var(--text-subtle)]">
                {project.folderPath}
              </span>
            </MenuOption>
          ))
        )}
      </>
    </Popover>
  )
}
