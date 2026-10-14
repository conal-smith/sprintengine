import React from 'react'

import type { CloneProgress, RepositoryCloneInput, RepositoryCloneResult } from '../../../../../shared/electron-api'
import {
  GhostButton,
  Input,
  LinkButton,
  MenuItem,
  MENU_DIVIDER_CLASS,
  MENU_LIST_CLASS,
  MenuOption,
  OutlineButton,
  PrimaryButton,
  Spinner,
  Tooltip,
} from '../../ui'
import { FolderTypeIcon, NoProjectGlyph } from '../../AppIcons'
import { isProjectlessChatsRoot, PROJECTLESS_CHATS_LABEL } from '../../../../../shared/projectless-chats'
import type { ProjectColor } from '../../../utils/projectColor'
import { GitHubRepoPicker, toRepoListState, type GitHubRepoListState } from '../newWorkspace/GitHubRepoPicker'
import { cloneParentFor, describeCloneProgress, draftNamesRepo, resolveCloneSource } from '../newWorkspace/githubClone'
import { suggestedWorkspaceFolderName } from '../newWorkspace/folderCreation'
import { basename } from '../../../utils/paths'
import { isImeKey } from '../../../utils/imeKey'

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

export type ProjectCloneRequest = RepositoryCloneInput
export type ProjectCloneResult = RepositoryCloneResult

let cloneSeq = 0
function nextCloneId(): string {
  cloneSeq += 1
  return `project-source-${Date.now().toString(36)}-${cloneSeq}`
}

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
  const [urlDraft, setUrlDraft] = React.useState('')
  // null follows the source: the branch a pasted page named, and the
  // repository's own name for the folder. Typing in either field takes it over.
  const [branchDraft, setBranchDraft] = React.useState<string | null>(null)
  const [folderDraft, setFolderDraft] = React.useState<string | null>(null)
  const [parentOverride, setParentOverride] = React.useState<string | null>(null)
  const [cloning, setCloning] = React.useState<{ id: string; progress: CloneProgress | null } | null>(null)
  const [cloneError, setCloneError] = React.useState<{ message: string; existingPath?: string } | null>(null)
  const repoRequestSeq = React.useRef(0)
  const fieldId = React.useId()

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

  const resolution = resolveCloneSource(urlDraft)
  const source = resolution.source
  const branch = (branchDraft ?? source?.branch ?? '').trim()
  const folderName = folderDraft ?? (source ? suggestedWorkspaceFolderName(source.repoName) : '')
  const parentDir = parentOverride ?? defaultParent
  const canClone = Boolean(source) && Boolean(folderName.trim()) && Boolean(parentDir) && !cloning

  // The running clone's progress, from main's one channel for every clone.
  const cloningId = cloning?.id ?? null
  React.useEffect(() => {
    if (!cloningId) return undefined
    return window.api.onRepositoryCloneProgress?.((progress) => {
      if (progress.cloneId !== cloningId) return
      setCloning((current) => (current?.id === cloningId ? { ...current, progress } : current))
    })
  }, [cloningId])

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
    if (!source || cloning || !onClone) return
    if (!parentDir) {
      // Only a true cold start with no default parent from the app lands here.
      setCloneError({ message: 'Choose where to clone it with Change… first.' })
      return
    }
    const id = nextCloneId()
    setCloning({ id, progress: null })
    setCloneError(null)
    try {
      const cloned = await onClone({
        url: source.url,
        parentDir,
        folderName: folderName.trim(),
        branch: branch || null,
        cloneId: id,
      })
      if (!mounted.current) return
      if (!cloned.ok) {
        // A cancel is the person's own doing, not news; anything else is
        // git's reason, said inline, with the fields left as they were.
        if (cloned.reason !== 'cancelled') {
          setCloneError({ message: cloned.message, existingPath: cloned.existingPath })
        }
        return
      }
      onClose()
    } finally {
      if (mounted.current) setCloning(null)
    }
  }

  const chooseParent = async (): Promise<void> => {
    const picked = await window.api.openDir(parentDir ? { defaultPath: parentDir } : undefined).catch(() => null)
    if (!picked || !mounted.current) return
    setParentOverride(cloneParentFor(picked, folderName.trim()))
    setCloneError(null)
  }

  if (step === 'git') {
    const parentLabel = parentDir ? `${basename(parentDir) || parentDir}/` : 'Choose a folder'
    return (
      <div className="flex w-[380px] flex-col gap-3 p-2.5">
        {/* The kit's text link in its `quiet` ink — the back affordance is a
            word, not a control with a box. */}
        <LinkButton ink="quiet" underline="never" onClick={() => setStep('projects')} className="self-start">
          <span aria-hidden="true">←</span> Import from Git
        </LinkButton>

        {/* The URL leads: it is the one lane that reaches every host — GitHub,
            GitLab, Bitbucket, Azure DevOps, Gitea, a company's own server —
            and the account's GitHub list below only fills it in. */}
        <div className="flex flex-col gap-1.5">
          {/* A real <label for>, at the kit label's type step: the field
              carries its own note in aria-describedby, which `Field` would
              overwrite when it clones its child. */}
          <label htmlFor={`${fieldId}-url`} className="text-body font-medium text-[color:var(--text-default)]">
            Repository URL
          </label>
          <Input
            id={`${fieldId}-url`}
            aria-label="Repository URL"
            autoFocus
            value={urlDraft}
            onChange={(event) => {
              setUrlDraft(event.target.value)
              setBranchDraft(null)
              setFolderDraft(null)
              setCloneError(null)
            }}
            onKeyDown={(event) => {
              if (isImeKey(event)) return
              if (event.key === 'Enter' && canClone) {
                event.preventDefault()
                void runClone()
              }
            }}
            placeholder="https://…, git@host:owner/repo, or owner/repo"
            spellCheck={false}
            autoComplete="off"
            aria-invalid={resolution.error ? true : undefined}
            aria-describedby={`${fieldId}-url-note`}
            disabled={Boolean(cloning)}
            className="font-mono"
          />
          <p id={`${fieldId}-url-note`} className="min-w-0 px-0.5 text-micro leading-4">
            {resolution.error ? (
              <span className="text-[color:var(--tone-error)]">{resolution.error}</span>
            ) : source ? (
              <span className="flex min-w-0 items-baseline gap-1.5">
                <span className="shrink-0 font-medium text-[color:var(--text-default)]">{source.providerName}</span>
                <span className="min-w-0 truncate font-mono text-[color:var(--text-subtle)]" title={source.location}>
                  {source.location}
                </span>
              </span>
            ) : (
              <span className="text-[color:var(--text-subtle)]">
                GitHub, GitLab, Bitbucket, Azure DevOps, Gitea, or any Git server — public or self-hosted.
              </span>
            )}
          </p>
          {source?.insecure ? (
            <p className="px-0.5 text-micro leading-4 text-[color:var(--tone-warn)]">
              Not encrypted: this address sends the code, and any sign-in, in the clear.
            </p>
          ) : null}
        </div>

        <GitHubRepoPicker
          listState={repoList}
          filter={repoFilter}
          onChangeFilter={setRepoFilter}
          isSelected={(repo) => draftNamesRepo(urlDraft, repo)}
          onSelectRepo={(repo) => {
            // Picking fills the field; picking the row it already names clears it.
            setUrlDraft((current) => (draftNamesRepo(current, repo) ? '' : repo.cloneUrl))
            setBranchDraft(null)
            setFolderDraft(null)
            setCloneError(null)
          }}
          onRetry={loadRepos}
        />

        <div className="grid grid-cols-[auto_minmax(0,1fr)] items-center gap-x-2.5 gap-y-2">
          <label htmlFor={`${fieldId}-branch`} className="text-meta text-[color:var(--text-muted)]">
            Branch
          </label>
          <Input
            id={`${fieldId}-branch`}
            size="sm"
            value={branchDraft ?? source?.branch ?? ''}
            onChange={(event) => setBranchDraft(event.target.value)}
            placeholder="Default branch"
            spellCheck={false}
            autoComplete="off"
            disabled={Boolean(cloning)}
            className="font-mono"
          />
          <label htmlFor={`${fieldId}-folder`} className="text-meta text-[color:var(--text-muted)]">
            Clone into
          </label>
          <div className="flex min-w-0 items-center gap-1.5">
            {/* The parent is shown by its last name only; the whole path is
                one hover away, and Change… opens the folder dialog on it. */}
            <Tooltip
              content={parentDir ? `${parentDir} — change where it is cloned` : 'Choose where to clone it'}
              wrapperClassName="min-w-0 max-w-[45%] shrink"
            >
              <OutlineButton
                size="sm"
                onClick={() => void chooseParent()}
                disabled={Boolean(cloning)}
                aria-label={parentDir ? `Change where it is cloned, now ${parentDir}` : 'Choose where to clone it'}
                className="w-full min-w-0"
              >
                <span className="min-w-0 truncate">{parentLabel}</span>
              </OutlineButton>
            </Tooltip>
            <Input
              id={`${fieldId}-folder`}
              size="sm"
              value={folderName}
              onChange={(event) => {
                setFolderDraft(event.target.value)
                setCloneError(null)
              }}
              placeholder="folder-name"
              spellCheck={false}
              autoComplete="off"
              disabled={Boolean(cloning)}
              aria-invalid={
                cloneError && !cloneError.existingPath && /folder/i.test(cloneError.message) ? true : undefined
              }
              className="min-w-0 flex-1 font-mono"
            />
          </div>
        </div>

        {cloneError ? (
          <div role="alert" className="flex items-start gap-2 text-micro leading-4">
            <p
              className={`min-w-0 flex-1 ${cloneError.existingPath ? 'text-[color:var(--text-muted)]' : 'text-[color:var(--tone-error)]'}`}
            >
              {cloneError.message}
            </p>
            {cloneError.existingPath ? (
              <GhostButton
                size="sm"
                onClick={() => {
                  onSelect(cloneError.existingPath as string)
                  onClose()
                }}
              >
                Open it
              </GhostButton>
            ) : null}
          </div>
        ) : null}

        {cloning ? (
          // Its own line, full width: git's transfer detail (`131.77 MiB |
          // 26.00 MiB/s`) is the part that says the clone is moving, and
          // beside the buttons it was the part that got cut off.
          <p className="flex min-w-0 items-center gap-1.5 text-micro text-[color:var(--text-muted)]" aria-live="polite">
            <Spinner size={12} />
            <span className="min-w-0 truncate">{describeCloneProgress(cloning.progress)}</span>
          </p>
        ) : null}

        <div className="flex items-center justify-end gap-1.5">
          {cloning ? (
            <GhostButton size="sm" onClick={() => void window.api.cancelRepositoryClone?.(cloning.id)}>
              Cancel
            </GhostButton>
          ) : null}
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
