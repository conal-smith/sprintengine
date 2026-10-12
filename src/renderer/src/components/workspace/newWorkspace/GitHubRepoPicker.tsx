import { Field, GhostButton, InlineNotice, Input, RowButton, TruncatedText } from '../../ui'
import type { GitHubRepoListResult, GitHubRepoSummary } from '../../../../../shared/electron-api'
import { filterGitHubRepos } from './githubClone'

export type GitHubRepoListState =
  | { status: 'loading' }
  | { status: 'ready'; repos: GitHubRepoSummary[] }
  | { status: 'error'; reason: 'no_token' | 'unauthorized' | 'network'; message: string }

export function toRepoListState(result: GitHubRepoListResult): GitHubRepoListState {
  return result.ok
    ? { status: 'ready', repos: result.repos }
    : { status: 'error', reason: result.reason, message: result.message }
}

/**
 * The Import from Git step's list of the account's GitHub repositories (via
 * the token saved in Settings → Version control). Picking one fills the URL
 * field above it with the repository's clone URL, so the field stays the one
 * source of what is cloned; `isSelected` asks the field which row it names.
 */
export function GitHubRepoPicker({
  listState,
  filter,
  onChangeFilter,
  isSelected,
  onSelectRepo,
  onRetry,
}: {
  listState: GitHubRepoListState
  filter: string
  onChangeFilter: (value: string) => void
  isSelected: (repo: GitHubRepoSummary) => boolean
  onSelectRepo: (repo: GitHubRepoSummary) => void
  onRetry: () => void
}) {
  const visibleRepos = listState.status === 'ready' ? filterGitHubRepos(listState.repos, filter) : []

  return (
    <div className="flex min-h-0 flex-1 flex-col gap-2">
      <Field.Label>Your GitHub repositories</Field.Label>

      {listState.status === 'loading' ? (
        <p className="px-0.5 text-micro text-[color:var(--text-subtle)]">Loading repositories…</p>
      ) : null}

      {listState.status === 'error' && listState.reason === 'no_token' ? (
        // Not a failure — nothing was tried yet. One quiet line: the URL field
        // above clones from any host without a token, so this is an extra, not
        // a gate, and a boxed notice made it read like one.
        <p className="px-0.5 text-meta leading-5 text-[color:var(--text-subtle)]">
          Add a GitHub token in{' '}
          <span className="font-medium text-[color:var(--text-muted)]">Settings → Version control</span> to pick from
          your repositories here.
        </p>
      ) : null}

      {listState.status === 'error' && listState.reason !== 'no_token' ? (
        <InlineNotice
          tone="error"
          action={
            <GhostButton size="sm" onClick={onRetry}>
              Retry
            </GhostButton>
          }
        >
          {listState.message}
        </InlineNotice>
      ) : null}

      {listState.status === 'ready' ? (
        <>
          {/* The kit's field at its `sm` step — the ramp height an input and
              the select beside it share. The 32px box this drew was off the
              26/30/34 ramp entirely. */}
          <Input
            value={filter}
            onChange={(event) => onChangeFilter(event.target.value)}
            placeholder="Filter repositories…"
            spellCheck={false}
            autoComplete="off"
          />
          {visibleRepos.length === 0 ? (
            <p className="px-0.5 text-micro text-[color:var(--text-subtle)]">
              {listState.repos.length === 0 ? 'No repositories on this account.' : 'No repositories match the filter.'}
            </p>
          ) : (
            <div
              className="flex max-h-[168px] min-h-[64px] flex-col gap-0.5 overflow-y-auto pr-1"
              role="listbox"
              aria-label="GitHub repositories"
            >
              {visibleRepos.map((repo) => {
                const selected = isSelected(repo)
                return (
                  // The kit's inset row. `selected` paints the neutral
                  // selection canon; `aria-current` is withheld because a
                  // listbox option states its state in `aria-selected`, which
                  // the caller passes.
                  <RowButton
                    key={repo.fullName}
                    density="row"
                    selected={selected}
                    aria-current={undefined}
                    role="option"
                    aria-selected={selected}
                    onClick={() => onSelectRepo(repo)}
                    className="pl-2.5 pr-2.5"
                  >
                    <span className="shrink-0 text-body font-medium text-[color:var(--text-strong)]">
                      {repo.fullName}
                    </span>
                    <span className="shrink-0 rounded-full border border-[color:var(--border-default)] px-1.5 text-micro leading-4 text-[color:var(--text-subtle)]">
                      {repo.isPrivate ? 'Private' : 'Public'}
                    </span>
                    {repo.description ? (
                      <TruncatedText
                        as="span"
                        text={repo.description}
                        className="min-w-0 flex-1 truncate text-meta text-[color:var(--text-muted)]"
                      />
                    ) : null}
                  </RowButton>
                )
              })}
            </div>
          )}
        </>
      ) : null}
    </div>
  )
}
