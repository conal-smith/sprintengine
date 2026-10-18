import React, { useCallback, useEffect, useId, useState, type JSX } from 'react'

import {
  CLOUDFLARE_TOKEN_URL,
  DEFAULT_CLOUDFLARE_PROJECT,
  type ArtifactsCheck,
  type ArtifactsSettingsView,
  type ArtifactsSetupField,
  type ArtifactsSetupInput,
  type ArtifactsSetupResult,
} from '../../../../shared/artifacts'
import {
  GhostButton,
  InlineNotice,
  Input,
  LinkButton,
  OutlineButton,
  PrimaryButton,
  ProviderStateId,
  SegmentedControl,
  Select,
} from '../ui'
import { SettingCard, SettingsPageHeader, SettingsRow, SettingsSectionTitle } from './SettingsAtoms'

// Settings ▸ Artifacts: where agents publish the HTML pages they make, so the
// person can open them from any device. Each host asks for one thing:
//
// - GitHub Pages: the repository. Studio turns Pages on and reads the site's
//   address back.
// - Cloudflare Pages: an API token. Studio finds the account (a picker when
//   the token sees several) and finds or makes the project; its name and a
//   source repository wait under Advanced.
//
// Test and Save both set the host up and list what was found and done; Save
// also keeps it. Main owns the setting, because the `artifacts.*` tools read
// it with no window open. The token goes to main with a set-up and never
// comes back: the page only learns whether one is held.

type HostChoice = 'off' | 'github-pages' | 'cloudflare-pages'

const ROW_FIELD = 'w-72 max-w-full font-mono'
const MUTED = 'text-body leading-5 text-[color:var(--text-muted)]'

const HOST_ITEMS: Array<{ value: HostChoice; label: string }> = [
  { value: 'off', label: 'Off' },
  { value: 'github-pages', label: 'GitHub Pages' },
  { value: 'cloudflare-pages', label: 'Cloudflare Pages' },
]

/** The words a step's outcome is said in: no dots, no colour alone. */
const STEP_WORD: Record<ArtifactsCheck['status'], { word: string; tone: string }> = {
  pass: { word: 'OK', tone: 'text-[color:var(--tone-good)]' },
  warn: { word: 'To do', tone: 'text-[color:var(--tone-warn)]' },
  fail: { word: 'Failed', tone: 'text-[color:var(--tone-error)]' },
}

type Draft = {
  host: HostChoice
  repositoryUrl: string
  token: string
  accountId: string
  projectName: string
  sourceRepositoryUrl: string
}

function draftOf(view: ArtifactsSettingsView): Draft {
  return {
    host: view.provider ?? 'off',
    repositoryUrl: view.github.repositoryUrl,
    token: '',
    accountId: view.cloudflare.accountId,
    projectName: view.cloudflare.projectName,
    sourceRepositoryUrl: view.cloudflare.repositoryUrl,
  }
}

function inputOf(draft: Draft): ArtifactsSetupInput {
  if (draft.host === 'github-pages') return { provider: 'github-pages', repositoryUrl: draft.repositoryUrl }
  if (draft.host === 'cloudflare-pages') {
    return {
      provider: 'cloudflare-pages',
      ...(draft.token.trim() ? { token: draft.token.trim() } : {}),
      ...(draft.accountId ? { accountId: draft.accountId } : {}),
      projectName: draft.projectName,
      repositoryUrl: draft.sourceRepositoryUrl,
    }
  }
  return { provider: null }
}

export function ArtifactsSettingsTab(): JSX.Element {
  const [view, setView] = useState<ArtifactsSettingsView | null | undefined>(undefined)
  const [draft, setDraft] = useState<Draft | null>(null)
  const [busy, setBusy] = useState<'save' | 'test' | null>(null)
  const [result, setResult] = useState<ArtifactsSetupResult | null>(null)
  const [accounts, setAccounts] = useState<Array<{ id: string; name: string }>>([])
  const [replacingToken, setReplacingToken] = useState(false)
  const [advanced, setAdvanced] = useState(false)

  useEffect(() => {
    let cancelled = false
    void Promise.resolve(window.api?.getArtifactsSettings?.())
      .then((next) => {
        if (cancelled) return
        setView(next ?? null)
        if (next) {
          setDraft(draftOf(next))
          setAdvanced(Boolean(next.cloudflare.projectName || next.cloudflare.repositoryUrl))
        }
      })
      .catch(() => {
        if (!cancelled) setView(null)
      })
    return () => {
      cancelled = true
    }
  }, [])

  const update = useCallback((change: Partial<Draft>) => {
    setDraft((current) => (current ? { ...current, ...change } : current))
    setResult(null)
  }, [])

  const run = useCallback(
    async (save: boolean) => {
      if (!draft) return
      setBusy(save ? 'save' : 'test')
      setResult(null)
      try {
        const answer = await window.api.setUpArtifacts(inputOf(draft), save)
        if (!answer) return
        setResult(answer)
        if (!answer.ok && answer.accounts?.length) setAccounts(answer.accounts)
        if (answer.ok && answer.saved) {
          setView(answer.view)
          setDraft({ ...draftOf(answer.view), host: answer.view.provider ?? 'off' })
          setReplacingToken(false)
          setAccounts([])
        }
      } finally {
        setBusy(null)
      }
    },
    [draft],
  )

  const failedField: ArtifactsSetupField | null = result && !result.ok ? (result.field ?? null) : null

  return (
    <div role="tabpanel" id="settings-panel-artifacts" aria-labelledby="settings-tab-artifacts" className="space-y-6">
      <SettingsPageHeader title="Artifacts" />
      <p className={MUTED}>
        Agents publish the pages they make (mockups, prototypes, reports) with the artifacts tools, to a site you can
        open from any device, phone included. Every publish keeps the earlier versions, and the site lists them newest
        first, with search, tags and projects. An agent can also set this up for you; Studio asks you first.
      </p>
      {view === undefined ? null : view === null || !draft ? (
        <p className={MUTED}>Artifacts are set up in the desktop app, on the machine whose agents publish them.</p>
      ) : (
        <>
          <section className="space-y-3" aria-labelledby="artifacts-host-title">
            <SettingsSectionTitle id="artifacts-host-title">Host</SettingsSectionTitle>
            <SegmentedControl
              ariaLabel="Where artifacts are hosted"
              items={HOST_ITEMS}
              value={draft.host}
              onChange={(host) => update({ host })}
            />
            {draft.host === 'off' ? (
              <p className={MUTED}>Off: the artifacts tools refuse, and say this page is where they are set up.</p>
            ) : null}
          </section>
          {draft.host === 'github-pages' ? (
            <GitHubSection view={view} draft={draft} update={update} invalid={failedField} />
          ) : null}
          {draft.host === 'cloudflare-pages' ? (
            <CloudflareSection
              view={view}
              draft={draft}
              update={update}
              invalid={failedField}
              accounts={accounts}
              replacingToken={replacingToken}
              setReplacingToken={setReplacingToken}
              advanced={advanced}
              setAdvanced={setAdvanced}
            />
          ) : null}
          <div className="space-y-3">
            <div className="flex flex-wrap items-center justify-end gap-2">
              {result?.ok && result.saved ? (
                <span role="status" className={`mr-auto ${MUTED}`}>
                  Saved.
                </span>
              ) : null}
              <OutlineButton size="md" disabled={busy !== null || draft.host === 'off'} onClick={() => void run(false)}>
                {busy === 'test' ? 'Testing…' : 'Test'}
              </OutlineButton>
              <PrimaryButton
                size="md"
                disabled={busy !== null || (draft.host === 'off' && view.provider === null)}
                onClick={() => void run(true)}
              >
                {busy === 'save' ? 'Setting up…' : 'Save'}
              </PrimaryButton>
            </div>
            {result ? <SetupResult result={result} /> : null}
          </div>
        </>
      )}
    </div>
  )
}

function SiteLine({ url }: { url: string }): JSX.Element {
  return (
    <p className={MUTED}>
      The gallery is at{' '}
      <LinkButton size="inherit" onClick={() => void window.api.openExternal(url)}>
        {url}
      </LinkButton>
      .
    </p>
  )
}

function GitHubSection({
  view,
  draft,
  update,
  invalid,
}: {
  view: ArtifactsSettingsView
  draft: Draft
  update: (change: Partial<Draft>) => void
  invalid: ArtifactsSetupField | null
}): JSX.Element {
  const id = useId()
  const saved = view.provider === 'github-pages' && view.github.repositoryUrl === draft.repositoryUrl.trim()
  return (
    <section className="space-y-3" aria-label="GitHub Pages">
      <SettingCard>
        <SettingsRow
          label="Repository"
          htmlFor={id}
          help="On github.com or your company’s GitHub. Studio pushes with the sign-in this machine already has for that host, turns Pages on if it is off, and uses the address GitHub gives the site."
        >
          <Input
            id={id}
            value={draft.repositoryUrl}
            onChange={(event) => update({ repositoryUrl: event.target.value })}
            placeholder="https://github.com/acme/artifacts"
            spellCheck={false}
            autoCapitalize="none"
            autoCorrect="off"
            aria-invalid={invalid === 'github.repositoryUrl' ? true : undefined}
            size="md"
            variant="well"
            fullWidth={false}
            className={ROW_FIELD}
          />
        </SettingsRow>
      </SettingCard>
      <p className={MUTED}>
        A Pages site is public on the internet even when the repository is private, unless your organization is on
        GitHub Enterprise Cloud and limits it to members. Pages on a private repository needs a paid plan.
      </p>
      {saved && view.siteUrl ? <SiteLine url={view.siteUrl} /> : null}
    </section>
  )
}

function CloudflareSection({
  view,
  draft,
  update,
  invalid,
  accounts,
  replacingToken,
  setReplacingToken,
  advanced,
  setAdvanced,
}: {
  view: ArtifactsSettingsView
  draft: Draft
  update: (change: Partial<Draft>) => void
  invalid: ArtifactsSetupField | null
  accounts: Array<{ id: string; name: string }>
  replacingToken: boolean
  setReplacingToken: (next: boolean) => void
  advanced: boolean
  setAdvanced: (next: boolean) => void
}): JSX.Element {
  const ids = { token: useId(), account: useId(), project: useId(), repository: useId(), advanced: useId() }
  const tokenInputVisible = replacingToken || !view.cloudflareToken.configured
  const savedHere = view.provider === 'cloudflare-pages'
  const field = (name: ArtifactsSetupField) => (invalid === name ? true : undefined)
  const project = draft.projectName.trim() || DEFAULT_CLOUDFLARE_PROJECT
  return (
    <section className="space-y-3" aria-label="Cloudflare Pages">
      <SettingCard>
        <SettingsRow
          label="API token"
          htmlFor={tokenInputVisible ? ids.token : undefined}
          help={
            <>
              A token with the Cloudflare Pages Edit permission, kept in this computer’s secure storage
              {view.cloudflareToken.encryptionAvailable ? '' : ' (unavailable now: kept for this session only)'}.{' '}
              <LinkButton size="inherit" onClick={() => void window.api.openExternal(CLOUDFLARE_TOKEN_URL)}>
                Create a token
              </LinkButton>
            </>
          }
        >
          {tokenInputVisible ? (
            <span className="flex items-center gap-2">
              <Input
                id={ids.token}
                type="password"
                value={draft.token}
                onChange={(event) => update({ token: event.target.value })}
                placeholder="Pages Edit token"
                autoComplete="off"
                aria-invalid={field('cloudflare.token')}
                size="md"
                variant="well"
                fullWidth={false}
                className={ROW_FIELD}
              />
              {view.cloudflareToken.configured ? (
                <GhostButton
                  size="md"
                  onClick={() => {
                    setReplacingToken(false)
                    update({ token: '' })
                  }}
                >
                  Cancel
                </GhostButton>
              ) : null}
            </span>
          ) : (
            <span className="flex items-center gap-2">
              <span className="text-body font-medium text-[color:var(--text-default)]">Saved</span>
              <OutlineButton size="md" onClick={() => setReplacingToken(true)}>
                Replace
              </OutlineButton>
            </span>
          )}
        </SettingsRow>
        {accounts.length > 1 ? (
          <SettingsRow
            label="Account"
            htmlFor={ids.account}
            help="The token can see several accounts. Pick the one to publish to."
          >
            <Select
              id={ids.account}
              ariaLabel="Cloudflare account"
              items={accounts.map((account) => ({ value: account.id, label: account.name }))}
              value={accounts.some((account) => account.id === draft.accountId) ? draft.accountId : null}
              placeholder="Choose an account"
              onChange={(accountId) => update({ accountId })}
              size="md"
            />
          </SettingsRow>
        ) : savedHere && view.cloudflare.accountName ? (
          <SettingsRow label="Account" help="The account the token publishes to.">
            <span className="text-body text-[color:var(--text-default)]">{view.cloudflare.accountName}</span>
          </SettingsRow>
        ) : null}
      </SettingCard>
      <div>
        <GhostButton
          size="sm"
          aria-expanded={advanced}
          aria-controls={ids.advanced}
          onClick={() => setAdvanced(!advanced)}
        >
          {advanced ? 'Hide advanced' : 'Advanced'}
        </GhostButton>
      </div>
      {advanced ? (
        <div id={ids.advanced}>
          <SettingCard>
            <SettingsRow
              label="Project"
              htmlFor={ids.project}
              help={`The Pages project to publish to, made if there is none. ${DEFAULT_CLOUDFLARE_PROJECT} when left empty.`}
            >
              <Input
                id={ids.project}
                value={draft.projectName}
                onChange={(event) => update({ projectName: event.target.value })}
                placeholder={DEFAULT_CLOUDFLARE_PROJECT}
                spellCheck={false}
                autoCapitalize="none"
                autoCorrect="off"
                aria-invalid={field('cloudflare.projectName')}
                size="md"
                variant="well"
                fullWidth={false}
                className={ROW_FIELD}
              />
            </SettingsRow>
            <SettingsRow
              label="Source repository"
              htmlFor={ids.repository}
              help="A git repository to keep the site’s source and history in. Without one, the source is kept on this computer and read back from the live site on another, which cannot be done through a Cloudflare Access sign-in."
            >
              <Input
                id={ids.repository}
                value={draft.sourceRepositoryUrl}
                onChange={(event) => update({ sourceRepositoryUrl: event.target.value })}
                placeholder="git@github.com:acme/artifacts.git"
                spellCheck={false}
                autoCapitalize="none"
                autoCorrect="off"
                aria-invalid={field('cloudflare.repositoryUrl')}
                size="md"
                variant="well"
                fullWidth={false}
                className={ROW_FIELD}
              />
            </SettingsRow>
          </SettingCard>
        </div>
      ) : null}
      <p className={MUTED}>
        A Pages site is public. To put a sign-in in front of it, add a Cloudflare Access application: in the dashboard’s
        Zero Trust ▸ Access ▸ Applications, add a self-hosted application for the site’s address (
        <ProviderStateId>{project}.pages.dev</ProviderStateId> and any custom domain), with a policy that allows your
        own email address.
      </p>
      {savedHere && view.siteUrl ? <SiteLine url={view.siteUrl} /> : null}
    </section>
  )
}

function SetupResult({ result }: { result: ArtifactsSetupResult }): JSX.Element {
  const summary = result.ok
    ? result.saved
      ? result.siteUrl
        ? `Set up. The gallery is at ${result.siteUrl}.`
        : 'Saved.'
      : result.steps.some((step) => step.status === 'warn')
        ? 'Ready to publish, with something left to do.'
        : 'Ready to publish. The setting is not saved until you Save.'
    : null
  return (
    <section aria-label="What the set-up found" className="space-y-2">
      {summary ? (
        <p role="status" className="text-body font-medium text-[color:var(--text-default)]">
          {summary}
        </p>
      ) : null}
      {!result.ok ? <InlineNotice tone="error" title={result.message} /> : null}
      {result.steps.length ? (
        <SettingCard as="ul" ariaLabel="Steps">
          {result.steps.map((step, index) => (
            <li key={`${step.label}-${index}`} className="flex items-start gap-3 px-4 py-2.5">
              <span className={`w-14 shrink-0 text-body font-semibold ${STEP_WORD[step.status].tone}`}>
                {STEP_WORD[step.status].word}
              </span>
              <span className="min-w-0 text-body leading-5">
                <span className="font-medium text-[color:var(--text-default)]">{step.label}.</span>{' '}
                <span className="break-words text-[color:var(--text-muted)]">{step.detail}</span>
              </span>
            </li>
          ))}
        </SettingCard>
      ) : null}
    </section>
  )
}
