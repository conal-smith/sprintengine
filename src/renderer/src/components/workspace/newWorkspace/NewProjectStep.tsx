import React from 'react'

import type { GitHubOwnerListResult, NewProjectInput, NewProjectResult } from '../../../../../shared/electron-api'
import { newProjectNameProblem } from '../../../../../shared/new-project-name'
import {
  Checkbox,
  GhostButton,
  Input,
  LinkButton,
  OutlineButton,
  PrimaryButton,
  SegmentedControl,
  Spinner,
  Tooltip,
} from '../../ui'
import { basename } from '../../../utils/paths'
import { isImeKey } from '../../../utils/imeKey'

// The New-chat project selector's "New project" step: a name, where it goes on
// this machine, and — only if the person ticks it — a GitHub repository for it.
//
// Publishing is the one thing here that reaches past this machine: it makes a
// repository on the person's own account. So it is off until ticked, private
// unless they pick public, and Create asks once more, naming the repository
// and its visibility, before anything is sent. Main refuses a publish that
// was not confirmed, too.

export type NewProjectRequest = NewProjectInput

type OwnersState = { status: 'idle' | 'loading' } | GitHubOwnerListResult

export function NewProjectStep({
  defaultParent,
  onBack,
  onCreate,
  onDone,
}: {
  /** Where the folder lands unless the person changes it; null on a cold start. */
  defaultParent: string | null
  onBack: () => void
  /** Makes the project and ADOPTS it; the host outlives this step, as it does a clone. */
  onCreate: (request: NewProjectRequest) => Promise<NewProjectResult>
  /** The project was made: the host closes the menu. */
  onDone: () => void
}) {
  const fieldId = React.useId()
  const [name, setName] = React.useState('')
  const [parentOverride, setParentOverride] = React.useState<string | null>(null)
  const [publish, setPublish] = React.useState(false)
  const [visibility, setVisibility] = React.useState<'private' | 'public'>('private')
  const [ownerDraft, setOwnerDraft] = React.useState<string | null>(null)
  const [owners, setOwners] = React.useState<OwnersState>({ status: 'idle' })
  const [confirming, setConfirming] = React.useState(false)
  const [creating, setCreating] = React.useState(false)
  const [error, setError] = React.useState<string | null>(null)

  const mounted = React.useRef(true)
  React.useEffect(() => {
    mounted.current = true
    return () => {
      mounted.current = false
    }
  }, [])

  const parentDir = parentOverride ?? defaultParent
  const trimmed = name.trim()
  const nameProblem = trimmed ? newProjectNameProblem(trimmed) : null
  const login = 'ok' in owners && owners.ok ? owners.login : null
  const owner = (ownerDraft ?? login ?? '').trim()
  const publishReady = !publish || ('ok' in owners && owners.ok && Boolean(owner))
  const canCreate = Boolean(trimmed) && !nameProblem && Boolean(parentDir) && publishReady && !creating

  const loadOwners = () => {
    setOwners({ status: 'loading' })
    void window.api
      .listGitHubOwners()
      .then((result) => {
        if (mounted.current) setOwners(result)
      })
      .catch((caught: unknown) => {
        if (mounted.current) {
          setOwners({
            ok: false,
            reason: 'network',
            message: caught instanceof Error ? caught.message : String(caught),
          })
        }
      })
  }

  const togglePublish = (next: boolean) => {
    setPublish(next)
    setConfirming(false)
    if (next && !('ok' in owners && owners.ok)) loadOwners()
  }

  const chooseParent = async (): Promise<void> => {
    const picked = await window.api.openDir(parentDir ? { defaultPath: parentDir } : undefined).catch(() => null)
    if (!picked || !mounted.current) return
    setParentOverride(picked)
    setError(null)
  }

  const create = async (confirmed: boolean): Promise<void> => {
    if (!canCreate || !parentDir) return
    // A publish asks first: the next press is the confirmation.
    if (publish && !confirmed) {
      setConfirming(true)
      return
    }
    setCreating(true)
    setError(null)
    try {
      const result = await onCreate({
        parentDir,
        name: trimmed,
        publish: publish ? { owner: owner === login ? null : owner, visibility, confirmed: true } : null,
      })
      if (!mounted.current) return
      if (!result.ok) {
        setConfirming(false)
        setError(result.message)
        return
      }
      onDone()
    } catch (caught) {
      if (mounted.current) setError(caught instanceof Error ? caught.message : 'Could not create the project.')
    } finally {
      if (mounted.current) setCreating(false)
    }
  }

  const parentLabel = parentDir ? `${basename(parentDir) || parentDir}/` : 'Choose a folder'
  const repositoryName = `${owner || 'you'}/${trimmed}`

  if (confirming) {
    return (
      <div className="flex w-[380px] flex-col gap-3 p-2.5" role="group" aria-label="Confirm the GitHub repository">
        <p className="text-body font-medium text-[color:var(--text-default)]">
          Create {visibility === 'private' ? 'a private' : 'a public'} repository on GitHub?
        </p>
        <p className="text-meta text-[color:var(--text-muted)]">
          <span className="font-mono text-[color:var(--text-default)]">{repositoryName}</span> is made on your GitHub
          account{visibility === 'public' ? ', visible to everyone,' : ''} and the project&apos;s first commit is pushed
          to it.
        </p>
        {error ? (
          <p role="alert" className="text-micro leading-4 text-[color:var(--tone-error)]">
            {error}
          </p>
        ) : null}
        {creating ? (
          <p className="flex items-center gap-1.5 text-micro text-[color:var(--text-muted)]" aria-live="polite">
            <Spinner size={12} />
            <span>Creating {trimmed} and publishing it…</span>
          </p>
        ) : null}
        <div className="flex items-center justify-end gap-1.5">
          <GhostButton size="sm" disabled={creating} onClick={() => setConfirming(false)}>
            Back
          </GhostButton>
          <PrimaryButton size="sm" disabled={creating} onClick={() => void create(true)}>
            {creating ? 'Creating…' : 'Create repository'}
          </PrimaryButton>
        </div>
      </div>
    )
  }

  return (
    <div className="flex w-[380px] flex-col gap-3 p-2.5">
      <LinkButton ink="quiet" underline="never" onClick={onBack} className="self-start">
        <span aria-hidden="true">←</span> New project
      </LinkButton>

      <div className="flex flex-col gap-1.5">
        <label htmlFor={`${fieldId}-name`} className="text-body font-medium text-[color:var(--text-default)]">
          Name
        </label>
        <Input
          id={`${fieldId}-name`}
          aria-label="Project name"
          autoFocus
          value={name}
          onChange={(event) => {
            setName(event.target.value)
            setError(null)
          }}
          onKeyDown={(event) => {
            if (isImeKey(event)) return
            if (event.key === 'Enter' && canCreate) {
              event.preventDefault()
              void create(false)
            }
          }}
          placeholder="my-project"
          spellCheck={false}
          autoComplete="off"
          aria-invalid={nameProblem ? true : undefined}
          aria-describedby={`${fieldId}-name-note`}
          disabled={creating}
          className="font-mono"
        />
        <p id={`${fieldId}-name-note`} className="px-0.5 text-micro leading-4">
          {nameProblem ? (
            <span className="text-[color:var(--tone-error)]">{nameProblem}</span>
          ) : (
            <span className="text-[color:var(--text-subtle)]">
              A folder of that name on this machine, with a README and a first commit.
            </span>
          )}
        </p>
      </div>

      <div className="grid grid-cols-[auto_minmax(0,1fr)] items-center gap-x-2.5 gap-y-2">
        <span className="text-meta text-[color:var(--text-muted)]">Make it in</span>
        <Tooltip
          content={parentDir ? `${parentDir} — change where it is made` : 'Choose where to make it'}
          wrapperClassName="min-w-0 justify-self-start"
        >
          <OutlineButton
            size="sm"
            onClick={() => void chooseParent()}
            disabled={creating}
            aria-label={parentDir ? `Change where it is made, now ${parentDir}` : 'Choose where to make it'}
            className="min-w-0"
          >
            <span className="min-w-0 truncate">{parentLabel}</span>
          </OutlineButton>
        </Tooltip>
      </div>

      <Checkbox checked={publish} onChange={togglePublish} disabled={creating} size="body" label="Publish to GitHub" />

      {publish ? (
        <div className="flex flex-col gap-2 pl-6">
          {'ok' in owners && !owners.ok ? (
            <div role="alert" className="flex items-start gap-2 text-micro leading-4">
              <p className="min-w-0 flex-1 text-[color:var(--tone-error)]">
                {owners.reason === 'no_token'
                  ? 'Add a GitHub token in Settings → Version control to publish.'
                  : owners.message}
              </p>
              <GhostButton size="sm" onClick={loadOwners}>
                Retry
              </GhostButton>
            </div>
          ) : !('ok' in owners) ? (
            <p className="flex items-center gap-1.5 text-micro text-[color:var(--text-muted)]" aria-live="polite">
              <Spinner size={12} />
              <span>Asking GitHub who you are…</span>
            </p>
          ) : (
            <div className="grid grid-cols-[auto_minmax(0,1fr)] items-center gap-x-2.5 gap-y-2">
              <label htmlFor={`${fieldId}-owner`} className="text-meta text-[color:var(--text-muted)]">
                Owner
              </label>
              <Input
                id={`${fieldId}-owner`}
                size="sm"
                value={ownerDraft ?? login ?? ''}
                onChange={(event) => setOwnerDraft(event.target.value)}
                placeholder={login ?? 'owner'}
                spellCheck={false}
                autoComplete="off"
                disabled={creating}
                aria-describedby={owners.orgs.length > 0 ? `${fieldId}-owner-note` : undefined}
                className="font-mono"
              />
              {owners.orgs.length > 0 ? (
                <p id={`${fieldId}-owner-note`} className="col-start-2 text-micro text-[color:var(--text-subtle)]">
                  Your account, or one of: {owners.orgs.join(', ')}
                </p>
              ) : null}
              <span className="text-meta text-[color:var(--text-muted)]">Visibility</span>
              <SegmentedControl
                ariaLabel="Repository visibility"
                size="sm"
                items={[
                  { value: 'private', label: 'Private' },
                  { value: 'public', label: 'Public' },
                ]}
                value={visibility}
                onChange={(next) => setVisibility(next === 'public' ? 'public' : 'private')}
              />
            </div>
          )}
        </div>
      ) : null}

      {error ? (
        <p role="alert" className="text-micro leading-4 text-[color:var(--tone-error)]">
          {error}
        </p>
      ) : null}

      {creating ? (
        <p className="flex items-center gap-1.5 text-micro text-[color:var(--text-muted)]" aria-live="polite">
          <Spinner size={12} />
          <span>Creating {trimmed}…</span>
        </p>
      ) : null}

      <div className="flex items-center justify-end gap-1.5">
        <PrimaryButton size="sm" disabled={!canCreate} onClick={() => void create(false)}>
          {creating ? 'Creating…' : publish ? 'Create and publish…' : 'Create project'}
        </PrimaryButton>
      </div>
    </div>
  )
}
