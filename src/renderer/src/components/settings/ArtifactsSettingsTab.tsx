import React, { useCallback, useEffect, useId, useMemo, useState, type JSX } from 'react'

import {
  defaultGitHubPagesUrl,
  parseArtifactsRepositoryUrl,
  type ArtifactsCheck,
  type ArtifactsProviderKind,
  type ArtifactsSettings,
  type ArtifactsSettingsField,
  type ArtifactsSettingsView,
  type ArtifactsTestResult,
} from '../../../../shared/artifacts'
import {
  GhostButton,
  InlineNotice,
  Input,
  OutlineButton,
  PrimaryButton,
  ProviderStateId,
  SegmentedControl,
} from '../ui'
import { SettingCard, SettingsPageHeader, SettingsRow, SettingsSectionTitle } from './SettingsAtoms'

// Settings ▸ Artifacts: where agents publish the HTML pages they make, so the
// person can open them from any device. One host or none: GitHub Pages (a
// repository Pages serves, github.com or a company's GitHub) or Cloudflare
// Pages (a project Studio uploads to directly, its source optionally kept in a
// repository too). Main owns the setting, because the `artifacts.*` tools read
// it with no window open; the page edits a draft, Test checks the draft
// without publishing, and Save keeps it. The Cloudflare token goes to main
// with a save or a test and never comes back: the page only learns whether
// one is held.

type HostChoice = 'off' | ArtifactsProviderKind

const ROW_FIELD = 'w-72 max-w-full font-mono'
const MUTED = 'text-body leading-5 text-[color:var(--text-muted)]'

const HOST_ITEMS: Array<{ value: HostChoice; label: string }> = [
  { value: 'off', label: 'Off' },
  { value: 'github-pages', label: 'GitHub Pages' },
  { value: 'cloudflare-pages', label: 'Cloudflare Pages' },
]

/** The words a check's outcome is said in: no dots, no colour alone. */
const CHECK_WORD: Record<ArtifactsCheck['status'], { word: string; tone: string }> = {
  pass: { word: 'OK', tone: 'text-[color:var(--tone-good)]' },
  warn: { word: 'To do', tone: 'text-[color:var(--tone-warn)]' },
  fail: { word: 'Failed', tone: 'text-[color:var(--tone-error)]' },
}

function settingsOf(view: ArtifactsSettingsView): ArtifactsSettings {
  return { provider: view.provider, github: { ...view.github }, cloudflare: { ...view.cloudflare } }
}

function sameSettings(a: ArtifactsSettings, b: ArtifactsSettings): boolean {
  return JSON.stringify(a) === JSON.stringify(b)
}

export function ArtifactsSettingsTab(): JSX.Element {
  const [view, setView] = useState<ArtifactsSettingsView | null | undefined>(undefined)
  const [draft, setDraft] = useState<ArtifactsSettings | null>(null)
  const [token, setToken] = useState('')
  const [replacingToken, setReplacingToken] = useState(false)
  const [error, setError] = useState<{ field: ArtifactsSettingsField; message: string } | null>(null)
  const [saved, setSaved] = useState(false)
  const [busy, setBusy] = useState<'save' | 'test' | null>(null)
  const [tested, setTested] = useState<ArtifactsTestResult | null>(null)

  useEffect(() => {
    let cancelled = false
    void Promise.resolve(window.api?.getArtifactsSettings?.())
      .then((next) => {
        if (cancelled) return
        setView(next ?? null)
        if (next) setDraft(settingsOf(next))
      })
      .catch(() => {
        if (!cancelled) setView(null)
      })
    return () => {
      cancelled = true
    }
  }, [])

  const update = useCallback((change: (current: ArtifactsSettings) => ArtifactsSettings) => {
    setDraft((current) => (current ? change(current) : current))
    setError(null)
    setSaved(false)
    setTested(null)
  }, [])

  const dirty = useMemo(
    () => (view && draft ? !sameSettings(settingsOf(view), draft) || token.trim() !== '' : false),
    [view, draft, token],
  )

  const save = useCallback(async () => {
    if (!draft) return
    setBusy('save')
    try {
      const result = await window.api.setArtifactsSettings(draft, token.trim() ? token.trim() : undefined)
      if (!result) return
      if (!result.ok) {
        setError({ field: result.field, message: result.message })
        return
      }
      setView(result.view)
      setDraft(settingsOf(result.view))
      setToken('')
      setReplacingToken(false)
      setSaved(true)
    } finally {
      setBusy(null)
    }
  }, [draft, token])

  const test = useCallback(async () => {
    if (!draft) return
    setBusy('test')
    setTested(null)
    try {
      setTested(await window.api.testArtifactsSettings(draft, token.trim() ? token.trim() : undefined))
    } finally {
      setBusy(null)
    }
  }, [draft, token])

  return (
    <div role="tabpanel" id="settings-panel-artifacts" aria-labelledby="settings-tab-artifacts" className="space-y-6">
      <SettingsPageHeader title="Artifacts" />
      <p className={MUTED}>
        Agents publish the pages they make (mockups, prototypes, reports) with the artifacts tools, to a site you can
        open from any device, phone included. Every publish keeps the earlier versions, and the site lists them newest
        first, with search, tags and projects.
      </p>
      {view === undefined ? null : view === null || !draft ? (
        <p className={MUTED}>Artifacts are set up in the desktop app, on the machine whose agents publish them.</p>
      ) : (
        <ArtifactsForm
          view={view}
          draft={draft}
          update={update}
          token={token}
          setToken={(next) => {
            setToken(next)
            setError(null)
            setSaved(false)
            setTested(null)
          }}
          replacingToken={replacingToken}
          setReplacingToken={setReplacingToken}
          error={error}
        />
      )}
      {view && draft ? (
        <div className="space-y-3">
          <div className="flex flex-wrap items-center justify-end gap-2">
            {saved && !dirty ? (
              <span role="status" className={`mr-auto ${MUTED}`}>
                Saved.
              </span>
            ) : null}
            <OutlineButton size="md" disabled={busy !== null || draft.provider === null} onClick={() => void test()}>
              {busy === 'test' ? 'Testing…' : 'Test'}
            </OutlineButton>
            <PrimaryButton size="md" disabled={busy !== null || !dirty} onClick={() => void save()}>
              {busy === 'save' ? 'Saving…' : 'Save'}
            </PrimaryButton>
          </div>
          {error ? <InlineNotice tone="error" title={error.message} /> : null}
          {tested ? <TestResult result={tested} /> : null}
        </div>
      ) : null}
    </div>
  )
}

function ArtifactsForm({
  view,
  draft,
  update,
  token,
  setToken,
  replacingToken,
  setReplacingToken,
  error,
}: {
  view: ArtifactsSettingsView
  draft: ArtifactsSettings
  update: (change: (current: ArtifactsSettings) => ArtifactsSettings) => void
  token: string
  setToken: (next: string) => void
  replacingToken: boolean
  setReplacingToken: (next: boolean) => void
  error: { field: ArtifactsSettingsField; message: string } | null
}): JSX.Element {
  const ids = {
    repository: useId(),
    pages: useId(),
    account: useId(),
    project: useId(),
    token: useId(),
    domain: useId(),
    cloudflareRepository: useId(),
  }
  const invalid = (field: ArtifactsSettingsField) => (error?.field === field ? true : undefined)
  const derivedPagesUrl = useMemo(() => {
    const parsed = parseArtifactsRepositoryUrl(draft.github.repositoryUrl)
    return parsed.ok ? defaultGitHubPagesUrl(parsed.repository) : null
  }, [draft.github.repositoryUrl])
  const cloudflareAddress = draft.cloudflare.customDomain
    ? `https://${draft.cloudflare.customDomain}/`
    : draft.cloudflare.projectName
      ? `https://${draft.cloudflare.projectName}.pages.dev/`
      : null
  const tokenInputVisible = replacingToken || !view.cloudflareToken.configured
  const choice: HostChoice = draft.provider ?? 'off'

  return (
    <>
      <section className="space-y-3" aria-labelledby={`${ids.repository}-host`}>
        <SettingsSectionTitle id={`${ids.repository}-host`}>Host</SettingsSectionTitle>
        <SegmentedControl
          ariaLabel="Where artifacts are hosted"
          items={HOST_ITEMS}
          value={choice}
          onChange={(value) => update((current) => ({ ...current, provider: value === 'off' ? null : value }))}
        />
        {choice === 'off' ? (
          <p className={MUTED}>Off: the artifacts tools refuse, and say this page is where they are set up.</p>
        ) : null}
      </section>

      {choice === 'github-pages' ? (
        <section className="space-y-3" aria-label="GitHub Pages">
          <SettingCard>
            <SettingsRow
              label="Repository"
              htmlFor={ids.repository}
              help="Its address on github.com or your company’s GitHub. Studio pushes with the sign-in this machine already has for that host: gh’s, or git’s own."
            >
              <Input
                id={ids.repository}
                value={draft.github.repositoryUrl}
                onChange={(event) =>
                  update((current) => ({
                    ...current,
                    github: { ...current.github, repositoryUrl: event.target.value },
                  }))
                }
                placeholder="https://github.com/acme/artifacts"
                spellCheck={false}
                autoCapitalize="none"
                autoCorrect="off"
                aria-invalid={invalid('github.repositoryUrl')}
                size="md"
                variant="well"
                fullWidth={false}
                className={ROW_FIELD}
              />
            </SettingsRow>
            <SettingsRow
              label="Site address"
              htmlFor={ids.pages}
              help="Where Pages serves the site. Left empty, the address Pages gives the repository; a GitHub Enterprise Server without subdomain isolation serves https://<host>/pages/<owner>/<repo>/ instead."
            >
              <Input
                id={ids.pages}
                value={draft.github.pagesUrl}
                onChange={(event) =>
                  update((current) => ({ ...current, github: { ...current.github, pagesUrl: event.target.value } }))
                }
                placeholder={derivedPagesUrl ?? 'https://acme.github.io/artifacts/'}
                spellCheck={false}
                autoCapitalize="none"
                autoCorrect="off"
                aria-invalid={invalid('github.pagesUrl')}
                size="md"
                variant="well"
                fullWidth={false}
                className={ROW_FIELD}
              />
            </SettingsRow>
          </SettingCard>
          <p className={MUTED}>
            Turn Pages on in the repository’s Settings ▸ Pages: deploy from a branch,{' '}
            <ProviderStateId>main</ProviderStateId>, folder <ProviderStateId>/ (root)</ProviderStateId>. A Pages site is
            public on the internet even when the repository is private, unless the organization is on GitHub Enterprise
            Cloud and limits it to members.
          </p>
        </section>
      ) : null}

      {choice === 'cloudflare-pages' ? (
        <section className="space-y-3" aria-label="Cloudflare Pages">
          <SettingCard>
            <SettingsRow
              label="Account ID"
              htmlFor={ids.account}
              help="On the account’s overview page in the Cloudflare dashboard."
            >
              <Input
                id={ids.account}
                value={draft.cloudflare.accountId}
                onChange={(event) =>
                  update((current) => ({
                    ...current,
                    cloudflare: { ...current.cloudflare, accountId: event.target.value },
                  }))
                }
                placeholder="32 letters and digits"
                spellCheck={false}
                autoCapitalize="none"
                autoCorrect="off"
                aria-invalid={invalid('cloudflare.accountId')}
                size="md"
                variant="well"
                fullWidth={false}
                className={ROW_FIELD}
              />
            </SettingsRow>
            <SettingsRow
              label="Pages project"
              htmlFor={ids.project}
              help="A project made with Direct Upload (Workers & Pages ▸ Create ▸ Pages ▸ Upload assets). Studio uploads to it; no build runs."
            >
              <Input
                id={ids.project}
                value={draft.cloudflare.projectName}
                onChange={(event) =>
                  update((current) => ({
                    ...current,
                    cloudflare: { ...current.cloudflare, projectName: event.target.value },
                  }))
                }
                placeholder="artifacts"
                spellCheck={false}
                autoCapitalize="none"
                autoCorrect="off"
                aria-invalid={invalid('cloudflare.projectName')}
                size="md"
                variant="well"
                fullWidth={false}
                className={ROW_FIELD}
              />
            </SettingsRow>
            <SettingsRow
              label="API token"
              htmlFor={tokenInputVisible ? ids.token : undefined}
              help={
                !view.cloudflareToken.encryptionAvailable
                  ? 'Secure storage is unavailable, so the token is kept for this session only.'
                  : 'A token with the Cloudflare Pages Edit permission on this account, kept in the system’s secure storage.'
              }
            >
              {tokenInputVisible ? (
                <span className="flex items-center gap-2">
                  <Input
                    id={ids.token}
                    type="password"
                    value={token}
                    onChange={(event) => setToken(event.target.value)}
                    placeholder="Pages Edit token"
                    autoComplete="off"
                    aria-invalid={invalid('cloudflare.token')}
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
                        setToken('')
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
            <SettingsRow
              label="Custom domain"
              htmlFor={ids.domain}
              help="Optional: a domain the project also answers on, added under the project’s Custom domains."
            >
              <Input
                id={ids.domain}
                value={draft.cloudflare.customDomain}
                onChange={(event) =>
                  update((current) => ({
                    ...current,
                    cloudflare: { ...current.cloudflare, customDomain: event.target.value },
                  }))
                }
                placeholder="artifacts.example.com"
                spellCheck={false}
                autoCapitalize="none"
                autoCorrect="off"
                aria-invalid={invalid('cloudflare.customDomain')}
                size="md"
                variant="well"
                fullWidth={false}
                className={ROW_FIELD}
              />
            </SettingsRow>
            <SettingsRow
              label="Source repository"
              htmlFor={ids.cloudflareRepository}
              help="Optional: a git repository to keep the site’s source and history in, so another machine can publish to the same site. Without one, the source is kept on this machine only."
            >
              <Input
                id={ids.cloudflareRepository}
                value={draft.cloudflare.repositoryUrl}
                onChange={(event) =>
                  update((current) => ({
                    ...current,
                    cloudflare: { ...current.cloudflare, repositoryUrl: event.target.value },
                  }))
                }
                placeholder="git@github.com:acme/artifacts.git"
                spellCheck={false}
                autoCapitalize="none"
                autoCorrect="off"
                aria-invalid={invalid('cloudflare.repositoryUrl')}
                size="md"
                variant="well"
                fullWidth={false}
                className={ROW_FIELD}
              />
            </SettingsRow>
          </SettingCard>
          <p className={MUTED}>
            A Pages site is public. To put a sign-in in front of it, add a Cloudflare Access application: in the
            dashboard’s Zero Trust ▸ Access ▸ Applications, add a self-hosted application for{' '}
            <ProviderStateId>
              {draft.cloudflare.projectName ? `${draft.cloudflare.projectName}.pages.dev` : '<project>.pages.dev'}
            </ProviderStateId>
            {draft.cloudflare.customDomain ? (
              <>
                {' '}
                and <ProviderStateId>{draft.cloudflare.customDomain}</ProviderStateId>
              </>
            ) : null}
            , with a policy that allows your own email address. The project’s own Access policy setting covers its
            preview addresses only.
          </p>
        </section>
      ) : null}

      {choice !== 'off' ? (
        <p className={MUTED}>
          The gallery will be at{' '}
          <ProviderStateId>
            {choice === 'github-pages'
              ? draft.github.pagesUrl || derivedPagesUrl || 'the address Pages gives it'
              : (cloudflareAddress ?? 'the project’s address')}
          </ProviderStateId>
          .
        </p>
      ) : null}
    </>
  )
}

function TestResult({ result }: { result: ArtifactsTestResult }): JSX.Element {
  return (
    <section aria-label="Test result" className="space-y-2">
      <p role="status" className="text-body font-medium text-[color:var(--text-default)]">
        {result.ok
          ? result.checks.some((check) => check.status === 'warn')
            ? 'Ready to publish, with something left to do.'
            : 'Ready to publish. Nothing was published by the test.'
          : 'Not ready to publish.'}
      </p>
      <SettingCard as="ul" ariaLabel="Checks">
        {result.checks.map((check, index) => (
          <li key={`${check.label}-${index}`} className="flex items-start gap-3 px-4 py-2.5">
            <span className={`w-14 shrink-0 text-body font-semibold ${CHECK_WORD[check.status].tone}`}>
              {CHECK_WORD[check.status].word}
            </span>
            <span className="min-w-0 text-body leading-5">
              <span className="font-medium text-[color:var(--text-default)]">{check.label}.</span>{' '}
              <span className="text-[color:var(--text-muted)]">{check.detail}</span>
            </span>
          </li>
        ))}
      </SettingCard>
    </section>
  )
}
