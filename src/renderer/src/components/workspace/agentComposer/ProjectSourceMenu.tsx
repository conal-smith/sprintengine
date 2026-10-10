import React from 'react'

import type { GitHubRepoSummary } from '../../../../../shared/electron-api'
import { Input, LinkButton, MenuItem, MENU_DIVIDER_CLASS, MENU_LIST_CLASS, MenuOption, PrimaryButton } from '../../ui'
import { FolderTypeIcon, NoProjectGlyph } from '../../AppIcons'
import { isProjectlessChatsRoot, PROJECTLESS_CHATS_LABEL } from '../../../../../shared/projectless-chats'
import type { ProjectColor } from '../../../utils/projectColor'
import { GitHubRepoPicker, toRepoListState, type GitHubRepoListState } from '../newWorkspace/GitHubRepoPicker'
import { resolveCloneSource } from '../newWorkspace/githubClone'
import { suggestedWorkspaceFolderName } from '../newWorkspace/folderCreation'
import { basename } from '../../../utils/paths'

// The New-chat project selector's body (remote-sessions-ux /
// project-selector-sources): one surface that searches the projects, browses
// the disk, and imports from Git — the shipped clone machinery
// (GitHubRepoPicker, github-repos, git-clone) resurfaced where the owner
// wants everything created, stepped in place rather than stacking a second
// dialog on the first.

export type ProjectSourceOption = {
  path: string
  label: string
  /** When a chat in it was last written to; the host orders by it. */
  lastUsedAt?: number
}

export type ProjectCloneRequest = { url: string; parentDir: string; folderName: string }
export type ProjectCloneResult = { ok: true; path: string } | { ok: false; message: string }

/**
 * The hosting popover's open-focus for a project list that leads with its
 * search field: focus goes to the field. `autoFocus` alone lands nowhere — the
 * surface is still hidden while it is first measured, and a hidden field
 * takes no focus — so a miss is tried again on the next frame, once it shows.
 */
export function focusProjectSearch(surface: HTMLElement): void {
  const field = surface.querySelector<HTMLInputElement>('input[aria-label^="Search projects"]')
  if (!field) return
  field.focus()
  if (document.activeElement !== field) {
    requestAnimationFrame(() => {
      if (field.isConnected) field.focus()
    })
  }
}

export function ProjectSourceMenu({
  options,
  selectedPath,
  defaultParent,
  onSelect,
  colorOf,
  onStartWithoutProject,
  onBrowse,
  onClone,
  onClose,
}: {
  /**
   * Every project offered, open here or only known, in the order to list
   * them: one list, the one used last first (owner, 2026-10-08), never a
   * second "Recent" section below the first.
   */
  options: ProjectSourceOption[]
  selectedPath: string | null
  /** Where a cloned repository lands: the smart parent, or null on a cold start with nothing to go on. */
  defaultParent: string | null
  onSelect: (path: string) => void
  /**
   * The hue each offered project wears on its folder glyph (owner ruling
   * 2026-09-09, `one-colour-per-project-on-the-folder-glyph`). The list is where
   * the person is choosing BETWEEN projects, so it is the one place the six
   * hues have to be visible side by side; the chip that opened it then shows the
   * one they picked. Absent — or answering null for a project nobody has seen —
   * leaves the row's glyph in the row's own ink, which is the honest picture of
   * "this project has no colour".
   */
  colorOf?: (path: string) => ProjectColor | null
  /**
   * Scope to "No project": the chat runs in a folder the app makes for it
   * (shared/projectless-chats.ts). Absent hides the row — the Design door's
   * question is which system on disk, and "none" is not an answer to it.
   */
  onStartWithoutProject?: () => void
  /** Absent hides the Browse… source (a host with no folder dialog). */
  onBrowse?: () => void
  /**
   * Runs the clone and ADOPTS the result. It lives with the host rather than
   * here: this popover can close mid-clone, and a success that arrived into
   * an unmounted menu used to be lost. The menu only reports progress and
   * git's error inline, and closes on success if it is still open.
   *
   * Absent hides the Import-from-Git source, symmetrically with `onBrowse` — a
   * host that has nothing to clone into (the Design door, whose systems are
   * folders that already exist) must not be offered a way in that leads nowhere.
   */
  onClone?: (request: ProjectCloneRequest) => Promise<ProjectCloneResult>
  onClose: () => void
}) {
  const [step, setStep] = React.useState<'projects' | 'git'>('projects')
  const [query, setQuery] = React.useState('')
  const [repoList, setRepoList] = React.useState<GitHubRepoListState>({ status: 'loading' })
  const [repoFilter, setRepoFilter] = React.useState('')
  const [selectedRepo, setSelectedRepo] = React.useState<GitHubRepoSummary | null>(null)
  const [urlDraft, setUrlDraft] = React.useState('')
  const [cloning, setCloning] = React.useState(false)
  const [cloneError, setCloneError] = React.useState<string | null>(null)
  const repoRequestSeq = React.useRef(0)

  const loadRepos = React.useCallback(() => {
    const seq = ++repoRequestSeq.current
    setRepoList({ status: 'loading' })
    void window.api
      .listGitHubRepos()
      .then((result) => {
        if (repoRequestSeq.current === seq) setRepoList(toRepoListState(result))
      })
      .catch((error: unknown) => {
        if (repoRequestSeq.current === seq) {
          setRepoList({
            status: 'error',
            reason: 'network',
            message: error instanceof Error ? error.message : String(error),
          })
        }
      })
  }, [])

  const openGitStep = () => {
    setStep('git')
    loadRepos()
  }

  const resolution = resolveCloneSource(selectedRepo, urlDraft)
  const canClone = Boolean(resolution.source) && !cloning

  // Still mounted? State writes after an unmount are no-ops in React 18, but
  // `onClose` into a host that already closed the popover is not.
  const mounted = React.useRef(true)
  React.useEffect(() => {
    mounted.current = true
    return () => {
      mounted.current = false
    }
  }, [])

  const runClone = async (): Promise<void> => {
    const source = resolution.source
    if (!source || cloning || !onClone) return
    if (!defaultParent) {
      // Only a true cold start with no default parent from the app lands here.
      setCloneError('Choose a folder with Browse… first, so there is somewhere to clone into.')
      return
    }
    setCloning(true)
    setCloneError(null)
    try {
      const cloned = await onClone({
        url: source.url,
        parentDir: defaultParent,
        folderName: suggestedWorkspaceFolderName(source.repoName),
      })
      if (!mounted.current) return
      if (!cloned.ok) {
        // git's message, inline; the selection is untouched.
        setCloneError(cloned.message)
        return
      }
      onClose()
    } finally {
      if (mounted.current) setCloning(false)
    }
  }

  if (step === 'git') {
    return (
      <div className="flex w-[340px] flex-col gap-2 p-2">
        {/* The kit's text link in its `quiet` ink — the back affordance is a
            word, not a control with a box. */}
        <LinkButton ink="quiet" underline="never" onClick={() => setStep('projects')} className="self-start">
          <span aria-hidden="true">←</span> Import from Git
        </LinkButton>
        <GitHubRepoPicker
          listState={repoList}
          filter={repoFilter}
          onChangeFilter={setRepoFilter}
          selectedFullName={selectedRepo?.fullName ?? null}
          onSelectRepo={(repo) => {
            // Picking clears the URL draft; typing clears the pick — the two
            // lanes stay exclusive, same contract as the workspace hub.
            setSelectedRepo((current) => (current?.fullName === repo.fullName ? null : repo))
            setUrlDraft('')
            setCloneError(null)
          }}
          urlDraft={urlDraft}
          onChangeUrlDraft={(value) => {
            setUrlDraft(value)
            if (value.trim()) setSelectedRepo(null)
            setCloneError(null)
          }}
          urlError={resolution.error}
          onRetry={loadRepos}
        />
        {cloneError ? (
          <p role="alert" className="text-micro leading-4 text-[color:var(--tone-error)]">
            {cloneError}
          </p>
        ) : null}
        <div className="flex items-center justify-between gap-2">
          <span className="min-w-0 truncate text-micro text-[color:var(--text-subtle)]">
            {defaultParent ? `Clones into ${basename(defaultParent) || defaultParent}/` : ''}
          </span>
          <PrimaryButton size="sm" disabled={!canClone} onClick={() => void runClone()}>
            {cloning ? 'Cloning…' : 'Clone'}
          </PrimaryButton>
        </div>
      </div>
    )
  }

  const needle = query.trim().toLowerCase()
  const matches = (option: ProjectSourceOption) =>
    !needle || option.label.toLowerCase().includes(needle) || option.path.toLowerCase().includes(needle)
  const visible = options.filter(matches)

  const projectRow = (option: ProjectSourceOption) => (
    <MenuOption
      key={option.path}
      role="menuitemradio"
      selected={option.path === selectedPath}
      stacked
      onClick={() => {
        onSelect(option.path)
        onClose()
      }}
      // The leading slot is all-or-nothing per the menu spec, and Browse… and
      // Import from Git already fill it — the project rows were the ones
      // leaving it empty. The folder glyph closes that and carries the colour.
      //
      // The bare glyph, NOT `FolderIdentityIcon`: the logo lookup is one probe
      // per folder, and a list of every project this app has ever opened would
      // fire the lot of them to decorate rows the person is scrolling past. The
      // chip that opened this menu is the one place the logo is worth the probe.
      icon={<FolderTypeIcon className="mt-0.5 icon-xs shrink-0" color={colorOf?.(option.path) ?? null} />}
    >
      <span className="block truncate text-body font-medium">{option.label}</span>
      <span className="block truncate font-mono text-micro text-[color:var(--text-subtle)]">{option.path}</span>
    </MenuOption>
  )

  // The hosting Popover surface is the `role="menu"`; this is the list layer
  // inside it (menu spec anatomy), never a second menu.
  return (
    <div className={`w-[300px] ${MENU_LIST_CLASS}`}>
      {/* Search first (owner, 2026-09-03): typing narrows the projects. Off
          the roving order on purpose — the field is where focus lands. */}
      <div className="px-1.5 pb-1">
        <Input
          type="text"
          size="sm"
          autoFocus
          value={query}
          onChange={(event) => setQuery(event.target.value)}
          placeholder="Search projects…"
          aria-label="Search projects"
        />
      </div>
      {/* The sources lead (owner, 2026-09-04): Browse… and Import from Git are
          the two rows a person needs when the project they want is NOT in the
          list, and at the foot of a long list they were the rows that ran off
          the bottom of the window. Stacked glyph + name + what it does —
          all-or-nothing leading slot, per the menu spec. The projects grow
          below the separator; these two never move. */}
      {onBrowse ? (
        <MenuItem
          onClick={() => {
            onBrowse()
            onClose()
          }}
          icon={
            <svg
              viewBox="0 0 16 16"
              fill="none"
              aria-hidden="true"
              className="mt-0.5 icon-xs shrink-0 text-[color:var(--text-muted)]"
            >
              <path
                d="M2 5.5c0-.8.7-1.5 1.5-1.5h2.6l1.2 1.4h5.2c.8 0 1.5.7 1.5 1.5v5.1c0 .8-.7 1.5-1.5 1.5h-9c-.8 0-1.5-.7-1.5-1.5V5.5Z"
                stroke="currentColor"
                strokeWidth="1.4"
              />
              <path d="M8 7.5v3M6.5 9h3" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" />
            </svg>
          }
        >
          <span className="block text-body font-medium">Browse…</span>
          <span className="block text-meta text-[color:var(--text-subtle)]">Pick a folder on disk.</span>
        </MenuItem>
      ) : null}
      {onClone ? (
        <MenuItem
          aria-haspopup="true"
          onClick={openGitStep}
          icon={
            <svg
              viewBox="0 0 16 16"
              fill="none"
              aria-hidden="true"
              className="mt-0.5 icon-xs shrink-0 text-[color:var(--text-muted)]"
            >
              <path
                d="M6.5 9.5a2.6 2.6 0 0 0 3.7 0l2.3-2.3a2.6 2.6 0 1 0-3.7-3.7l-1 1"
                stroke="currentColor"
                strokeWidth="1.4"
                strokeLinecap="round"
              />
              <path
                d="M9.5 6.5a2.6 2.6 0 0 0-3.7 0L3.5 8.8a2.6 2.6 0 1 0 3.7 3.7l1-1"
                stroke="currentColor"
                strokeWidth="1.4"
                strokeLinecap="round"
              />
            </svg>
          }
          trailing={
            <span aria-hidden="true" className="mt-0.5 shrink-0 text-micro text-[color:var(--text-disabled)]">
              ›
            </span>
          }
        >
          <span className="block text-body font-medium">Import from Git</span>
          <span className="block text-meta text-[color:var(--text-subtle)]">Clone a repository and open it here.</span>
        </MenuItem>
      ) : null}
      {/* The third way in, after the two that find a project: none at all.
          With the sources rather than among the projects, because it is not
          one — and so it never scrolls away under a long list. */}
      {onStartWithoutProject ? (
        <MenuOption
          role="menuitemradio"
          selected={isProjectlessChatsRoot(selectedPath)}
          stacked
          onClick={() => {
            onStartWithoutProject()
            onClose()
          }}
          icon={<NoProjectGlyph className="mt-0.5 icon-xs shrink-0" />}
        >
          <span className="block text-body font-medium">{PROJECTLESS_CHATS_LABEL}</span>
          <span className="block text-meta text-[color:var(--text-subtle)]">Chat in a folder of its own.</span>
        </MenuOption>
      ) : null}
      <div className={MENU_DIVIDER_CLASS} role="separator" />
      {visible.map(projectRow)}
      {visible.length === 0 ? (
        // "No matching" answers a search; before anything is typed there is
        // nothing it could fail to match.
        <div className="px-2.5 py-1.5 text-meta text-[color:var(--text-muted)]">
          {needle ? 'No matching projects.' : 'No projects yet.'}
        </div>
      ) : null}
    </div>
  )
}
