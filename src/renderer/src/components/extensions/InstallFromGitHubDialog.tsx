// Install extension from GitHub: paste any repository URL, read what main
// found there, trust it, install it.
//
// Main does all of the reading. It resolves the repository's default branch
// (or the ref the URL names) to one commit, reads plugin.json and the
// components it names at that commit, and answers with the same disclosure the
// storefront's trust prompt shows — so this dialog renders ExtensionTrustReview
// and nothing of its own about trust. The install sends back the one-time
// token that review came with, which installs exactly that commit.
//
// Unsigned code is allowed here, and only here: the review asks for an
// explicit "I trust this code" before the install button does anything, and
// main refuses the install without it too.

import React, { useCallback, useEffect, useState, type JSX } from 'react'

import type {
  GithubExtensionPreview,
  GithubExtensionReviewChange,
  MarketplacePluginRegistryInstallResult,
  McpSettings,
} from '../../../../shared/electron-api'
import { installAndActivateRendererModules } from '../../modules'
import { installNeedsWorkspace, trustReviewFromVerify } from '../settings/installFlow'
import { GhostButton, InlineNotice, Input, LinkButton, PrimaryButton, Spinner, TruncatedText } from '../ui'
import { Modal, ModalBody, ModalFooter, ModalHeader } from '../ui/Modal'
import { ExtensionTrustReview, trustCodeRequired, trustReviewReady } from './ExtensionTrustReview'
import { isImeKey } from '../../utils/imeKey'

type Phase =
  | { kind: 'idle' }
  | { kind: 'resolving' }
  | { kind: 'review'; preview: GithubExtensionPreview; trustToken: string }
  | { kind: 'installing'; preview: GithubExtensionPreview }
  | { kind: 'installed'; preview: GithubExtensionPreview; updated: boolean; restartRequired: boolean }
  | { kind: 'failed'; message: string; issues?: string[]; skillSource?: boolean }

const CHANGE_LABEL: Record<GithubExtensionReviewChange, string> = {
  permissions: 'the access it requests',
  mcp: 'the MCP servers it adds',
  classification: 'how it is signed',
  source: 'where it comes from',
}

/**
 * What the review says about a copy already installed: which version and
 * commit it is, and — when this review discloses something the last approval
 * did not — what changed. Null for a first install. Exported for its test.
 */
export function installedStateLine(preview: GithubExtensionPreview): { text: string; changed: boolean } | null {
  const installed = preview.installed
  if (!installed) return null
  const commit = preview.verify.pin?.commitSha?.slice(0, 7)
  const was = `version ${installed.version}${installed.sha ? ` at ${installed.sha.slice(0, 7)}` : ''}`
  const now = `version ${preview.version}${commit ? ` at ${commit}` : ''}`
  if (installed.changes.length === 0) {
    return { text: `${preview.displayName} ${was} is installed. This installs ${now} in its place.`, changed: false }
  }
  const changed = installed.changes.map((change) => CHANGE_LABEL[change]).join(', ')
  return {
    text: `${preview.displayName} ${was} is installed. ${now} changes ${changed} — review it again before updating.`,
    changed: true,
  }
}

export type InstallFromGitHubDialogProps = {
  open: boolean
  onClose: () => void
  /** A URL to start from (the field is still editable). */
  initialUrl?: string
  /** Where an MCP server or skill component installs; absent, such a bundle cannot install. */
  workspaceRoot?: string | null
  mcpSettings?: McpSettings
  /** After a successful install, with main's result. */
  onInstalled?: (result: Extract<MarketplacePluginRegistryInstallResult, { ok: true }>) => void
  /** The repository is a skill source, not an extension: offer to add it as one. */
  onAddSkillSource?: (url: string) => void
}

export function InstallFromGitHubDialog({
  open,
  onClose,
  initialUrl = '',
  workspaceRoot,
  mcpSettings,
  onInstalled,
  onAddSkillSource,
}: InstallFromGitHubDialogProps): JSX.Element {
  const [url, setUrl] = useState(initialUrl)
  const [phase, setPhase] = useState<Phase>({ kind: 'idle' })
  const [trustCode, setTrustCode] = useState(false)

  // A fresh open is a fresh review: never another repository's disclosure,
  // never a trust answer given to something else.
  useEffect(() => {
    if (!open) return
    setUrl(initialUrl)
    setPhase({ kind: 'idle' })
    setTrustCode(false)
  }, [open, initialUrl])

  const resolve = useCallback(async (): Promise<void> => {
    const value = url.trim()
    if (!value) return
    if (typeof window.api.resolveGithubExtension !== 'function') {
      setPhase({ kind: 'failed', message: 'Installing from GitHub needs a newer app build. Update and restart.' })
      return
    }
    setPhase({ kind: 'resolving' })
    setTrustCode(false)
    try {
      const result = await window.api.resolveGithubExtension({ url: value })
      setPhase(
        result.ok
          ? { kind: 'review', preview: result.preview, trustToken: result.trustToken }
          : {
              kind: 'failed',
              message: result.message,
              ...(result.issues?.length ? { issues: result.issues.map((issue) => issue.message) } : {}),
              ...(result.skillSource ? { skillSource: true } : {}),
            },
      )
    } catch (error) {
      setPhase({ kind: 'failed', message: error instanceof Error ? error.message : String(error) })
    }
  }, [url])

  const install = useCallback(async (): Promise<void> => {
    if (phase.kind !== 'review') return
    const { preview, trustToken } = phase
    setPhase({ kind: 'installing', preview })
    try {
      const result = await installAndActivateRendererModules(() =>
        window.api.installGithubExtension({
          trustToken,
          ...(trustCode ? { trustCode: true } : {}),
          ...(workspaceRoot ? { workspaceRoot } : {}),
          ...(mcpSettings ? { mcpSettings } : {}),
        }),
      )
      if (!result.ok) {
        // The token is spent either way, so a retry starts from a fresh review.
        setPhase({
          kind: 'failed',
          message: result.message,
          ...(result.issues?.length ? { issues: result.issues.map((issue) => issue.message) } : {}),
        })
        return
      }
      setPhase({
        kind: 'installed',
        preview,
        updated: result.updated,
        restartRequired: result.restartRequired === true,
      })
      onInstalled?.(result)
    } catch (error) {
      setPhase({ kind: 'failed', message: error instanceof Error ? error.message : String(error) })
    }
  }, [phase, trustCode, workspaceRoot, mcpSettings, onInstalled])

  const review = phase.kind === 'review' ? trustReviewFromVerify(phase.preview.verify) : null
  const workspaceBlocked = phase.kind === 'review' && installNeedsWorkspace(phase.preview.provides) && !workspaceRoot
  const installedLine = phase.kind === 'review' ? installedStateLine(phase.preview) : null
  const busy = phase.kind === 'resolving' || phase.kind === 'installing'

  return (
    <Modal open={open} onClose={onClose} labelledBy="install-from-github-title" size="standard">
      <ModalHeader titleId="install-from-github-title" title="Install extension from GitHub" onClose={onClose} />
      <ModalBody className="flex flex-col gap-4">
        <Input
          value={url}
          autoFocus
          disabled={busy || phase.kind === 'installed'}
          onChange={(event) => {
            setUrl(event.target.value)
            // A different repository is a different review.
            if (phase.kind !== 'idle') setPhase({ kind: 'idle' })
          }}
          onKeyDown={(event) => {
            if (isImeKey(event)) return
            if (event.key === 'Enter' && phase.kind === 'idle') void resolve()
          }}
          placeholder="https://github.com/owner/repo"
          aria-label="Repository URL"
          className="font-mono"
        />

        {phase.kind === 'resolving' ? (
          <div className="flex items-center gap-2 text-body text-[color:var(--text-muted)]">
            <Spinner size={14} />
            Reading the repository at its latest commit…
          </div>
        ) : null}

        {phase.kind === 'failed' ? (
          <InlineNotice
            tone="error"
            title="This can’t be installed."
            hint={phase.message}
            {...(phase.issues?.length ? { detail: phase.issues.join('\n') } : {})}
            {...(phase.skillSource && onAddSkillSource
              ? {
                  action: (
                    <LinkButton onClick={() => onAddSkillSource(url.trim())}>
                      Add it as a skill source instead
                    </LinkButton>
                  ),
                }
              : {})}
          />
        ) : null}

        {phase.kind === 'review' && review ? (
          <>
            <div className="min-w-0">
              <div className="text-title font-semibold text-[color:var(--text-strong)]">
                {phase.preview.displayName}
                <span className="ml-2 text-body font-normal text-[color:var(--text-muted)]">
                  version {phase.preview.version}
                </span>
              </div>
              <p className="mt-0.5 text-body leading-5 text-[color:var(--text-muted)]">{phase.preview.summary}</p>
              {/* The repository it installs from, as main read it — the field
                  above holds what was typed, which may have been shorthand. */}
              <TruncatedText
                as="div"
                text={phase.preview.origin.url}
                className="mt-0.5 font-mono text-meta text-[color:var(--text-subtle)]"
              />
            </div>
            {installedLine ? (
              installedLine.changed ? (
                <InlineNotice tone="warn">{installedLine.text}</InlineNotice>
              ) : (
                <p className="text-body leading-5 text-[color:var(--text-muted)]">{installedLine.text}</p>
              )
            ) : null}
            <ExtensionTrustReview
              {...review}
              sourceUrl={phase.preview.origin.url}
              publisher={phase.preview.publisher}
              trustCode={trustCode}
              onTrustCodeChange={setTrustCode}
            />
            {workspaceBlocked ? (
              <InlineNotice tone="warn">
                It adds MCP servers or skills to a project. Open the project it is for, then install it.
              </InlineNotice>
            ) : null}
          </>
        ) : null}

        {phase.kind === 'installing' ? (
          <div className="flex items-center gap-2 text-body text-[color:var(--text-muted)]">
            <Spinner size={14} />
            {`Installing ${phase.preview.displayName}…`}
          </div>
        ) : null}

        {phase.kind === 'installed' ? (
          <p role="status" className="text-body leading-5 text-[color:var(--text-default)]">
            {`${phase.updated ? 'Updated' : 'Installed'} ${phase.preview.displayName}.`}
            {phase.restartRequired ? ' Restart SprintEngine Studio to use it.' : ''}
          </p>
        ) : null}
      </ModalBody>
      <ModalFooter>
        {phase.kind === 'installed' ? (
          <PrimaryButton size="md" onClick={onClose}>
            Done
          </PrimaryButton>
        ) : (
          <>
            <GhostButton size="md" onClick={onClose}>
              Cancel
            </GhostButton>
            {phase.kind === 'review' || phase.kind === 'installing' ? (
              <PrimaryButton
                size="md"
                onClick={() => void install()}
                disabled={
                  phase.kind !== 'review' || workspaceBlocked || !review || !trustReviewReady(review, trustCode)
                }
              >
                {phase.kind === 'installing'
                  ? 'Installing…'
                  : phase.preview.installed
                    ? 'Update'
                    : review && trustCodeRequired(review)
                      ? 'Trust and install'
                      : 'Install'}
              </PrimaryButton>
            ) : (
              <PrimaryButton
                size="md"
                onClick={() => void resolve()}
                disabled={url.trim().length === 0 || phase.kind === 'resolving'}
              >
                {phase.kind === 'resolving' ? 'Reading…' : 'Review'}
              </PrimaryButton>
            )}
          </>
        )}
      </ModalFooter>
    </Modal>
  )
}
