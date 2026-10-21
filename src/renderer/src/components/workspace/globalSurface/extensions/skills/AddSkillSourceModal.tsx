// Add a skill source: a centred modal, not a right-hand aside. The application
// does not configure things in an aside, and the right edge is reserved for a
// future skills surface. Escape, the scrim, and the padding around the modal
// all dismiss it — that is the shared Modal's contract.
//
// Paste a repository, scan it, and read the one number that answers "did it
// work?" — how many skills came in, and how they group. File counts, the pinned
// commit, and the layout the source will open in are stored, not displayed:
// metadata nobody asked for at this moment is bloat, and a paragraph explaining
// what adding a source means is copy standing in for a self-evident UI.
//
// Scanning and adding are one call (`skillsAddSource` walks the tree and stores
// the source with its scan), so the footer offers Remove for a repository that
// turned out to be the wrong one. Nothing installs here — adding a source and
// taking skills from it stay separate acts.
//
// Discover lives inside this modal since the source-tabs ruling (2026-09-05)
// retired the Sources rail that used to carry it in its foot. It is the same
// question this modal asks — "which repository?" — for someone who does not
// have one in mind, so it is a second panel of the same dialog rather than a
// third item on a two-item menu.

import React, { useEffect, useMemo, useState, type JSX } from 'react'

import {
  SOURCE_SHAPE_LABEL,
  scanMcpServers,
  scanPlugins,
  scanShape,
  type ScanResult,
  type SkillSource,
} from '../../../../../../../shared/skills'
import { GhostButton, InlineNotice, Input, LinkButton, PrimaryButton, Spinner } from '../../../../ui'
import { Modal, ModalBody, ModalFooter, ModalHeader } from '../../../../ui/Modal'
import { addedRepoKeys } from './discoverModel'
import { SkillsDiscover } from './SkillsDiscover'
import { pluralSkills } from './skillsSurfaceModel'
import { isImeKey } from '../../../../../utils/imeKey'

type AddPhase =
  | { kind: 'idle' }
  | { kind: 'scanning' }
  | { kind: 'added'; source: SkillSource; scan: ScanResult; mergedIntoBuiltin: boolean }
  | { kind: 'failed'; message: string }

/**
 * What a paste that landed in a built-in tab has to say for itself. Every other
 * add says it with the row that appears in the list.
 *
 * Pasting `anthropics/claude-plugins-official` or `sprintengine/studio-releases`
 * is not an add: those repositories are tabs this studio always has, so the
 * paste merges into the tab and nothing new turns up in the list. The modal
 * used to report the same flat success it reports for a new repository, and
 * the person went looking for a source that was never going to appear.
 * Exported for its test.
 */
export function mergedIntoBuiltinNotice(source: SkillSource): { title: string; hint: string } {
  return {
    title: `That is already the ${source.name} tab.`,
    hint: `${source.repo} comes with the studio, so nothing was added to your sources — its listing has just been re-read.`,
  }
}

export function AddSkillSourceModal({
  open,
  initialRepo = '',
  addedRepos = [],
  onClose,
  onAdded,
  onRemoved,
  onConfigureGitHubToken,
}: {
  open: boolean
  /** A candidate chosen in Discover. It arrives in the same field a pasted
   *  repository lands in, and takes the same path from there. */
  initialRepo?: string
  /** Repositories already in the list, so Discover says "Added" rather than
   *  offering a scan for one the person already has. */
  addedRepos?: readonly string[]
  onClose: () => void
  /** A source landed in the list; the surface reloads and opens it. */
  onAdded: (source: SkillSource) => void
  /** The just-added source was removed again. */
  onRemoved: () => void
  /** Discover's code search needs a GitHub token, which is set in Settings. */
  onConfigureGitHubToken?: () => void
}): JSX.Element {
  const [repo, setRepo] = useState(initialRepo)
  const [phase, setPhase] = useState<AddPhase>({ kind: 'idle' })
  const [removing, setRemoving] = useState(false)
  const [discovering, setDiscovering] = useState(false)
  const added = useMemo(() => addedRepoKeys([...addedRepos]), [addedRepos])

  useEffect(() => {
    if (!open) return
    setRepo(initialRepo)
    setPhase({ kind: 'idle' })
    setRemoving(false)
    setDiscovering(false)
  }, [open, initialRepo])

  const scan = async (): Promise<void> => {
    const value = repo.trim()
    if (value.length === 0) return
    if (typeof window.api.skillsAddSource !== 'function') {
      setPhase({ kind: 'failed', message: 'Skills need an app restart before they are available.' })
      return
    }
    setPhase({ kind: 'scanning' })
    try {
      // `replace` re-scans a repository already in the list rather than
      // refusing it, which is what a user who pastes it twice means.
      const result = await window.api.skillsAddSource({ repo: value, replace: true })
      if (!result.ok) {
        setPhase({ kind: 'failed', message: result.message })
        return
      }
      setPhase({
        kind: 'added',
        source: result.source,
        scan: result.scan,
        mergedIntoBuiltin: result.mergedIntoBuiltin === true,
      })
      onAdded(result.source)
    } catch (error) {
      setPhase({ kind: 'failed', message: error instanceof Error ? error.message : String(error) })
    }
  }

  const remove = async (sourceId: string): Promise<void> => {
    if (typeof window.api.skillsRemoveSource !== 'function') return
    setRemoving(true)
    const result = await window.api.skillsRemoveSource({ sourceId })
    setRemoving(false)
    if (!result.ok) {
      setPhase({ kind: 'failed', message: result.message })
      return
    }
    onRemoved()
    onClose()
  }

  return (
    <Modal open={open} onClose={onClose} labelledBy="add-skill-source-title" size="standard">
      <ModalHeader titleId="add-skill-source-title" title="Add a source from a git repository" onClose={onClose} />
      <ModalBody className="flex flex-col gap-4">
        <Input
          value={repo}
          autoFocus
          disabled={phase.kind === 'scanning' || phase.kind === 'added'}
          onChange={(event) => setRepo(event.target.value)}
          onKeyDown={(event) => {
            if (isImeKey(event)) return
            if (event.key === 'Enter') void scan()
          }}
          // `owner/repo` is github.com; any other git host is named by the
          // address its Clone button gives, https or ssh.
          placeholder="owner/repo, or any git clone address"
          aria-label="Repository"
          className="font-mono"
        />

        {phase.kind === 'scanning' ? (
          <div className="flex items-center gap-2 text-body text-[color:var(--text-muted)]">
            <Spinner size={14} />
            {`Walking ${repo.trim()}…`}
          </div>
        ) : null}

        {phase.kind === 'failed' ? (
          <InlineNotice tone="error" title="That repository was not added." hint={phase.message} />
        ) : null}

        {phase.kind === 'added' && phase.mergedIntoBuiltin ? (
          <InlineNotice tone="warn" {...mergedIntoBuiltinNotice(phase.source)} />
        ) : null}

        {phase.kind === 'added' ? <ScanSummary scan={phase.scan} /> : null}

        {phase.kind === 'idle' ? (
          // The kit's link button, `quiet` ink — the disclosure sentence, in the
          // one shape the system gives it: muted ink lifting to `text.primary`
          // over a standing `border.strong` underline. `self-start` is the only
          // class left, because where it sits in the modal's column is this
          // file's business and nothing else here is.
          <LinkButton
            ink="quiet"
            onClick={() => setDiscovering((value) => !value)}
            aria-expanded={discovering}
            className="self-start"
          >
            {discovering ? 'Hide search' : "Don't have one in mind? Search GitHub"}
          </LinkButton>
        ) : null}
        {phase.kind === 'idle' && discovering ? (
          <div className="max-h-[320px] min-h-0 overflow-y-auto">
            <SkillsDiscover
              addedRepos={added}
              // A candidate lands in the field above and takes the pasted
              // repository's path from there — one way in, two ways to find it.
              onScanRepo={(candidate) => {
                setRepo(candidate)
                setDiscovering(false)
              }}
              onConfigureToken={onConfigureGitHubToken ?? (() => undefined)}
            />
          </div>
        ) : null}
      </ModalBody>
      <ModalFooter>
        {phase.kind === 'added' ? (
          <>
            {/* No Remove for a tab the studio always has: the store refuses it,
                so the button's only possible outcome is a failure. */}
            {phase.mergedIntoBuiltin ? null : (
              <GhostButton size="md" disabled={removing} onClick={() => void remove(phase.source.id)}>
                {removing ? 'Removing…' : 'Remove source'}
              </GhostButton>
            )}
            <PrimaryButton size="md" onClick={onClose}>
              Done
            </PrimaryButton>
          </>
        ) : (
          <>
            <GhostButton size="md" onClick={onClose}>
              Cancel
            </GhostButton>
            <PrimaryButton
              size="md"
              onClick={() => void scan()}
              disabled={repo.trim().length === 0 || phase.kind === 'scanning'}
            >
              {phase.kind === 'scanning' ? 'Adding…' : 'Add'}
            </PrimaryButton>
          </>
        )}
      </ModalFooter>
    </Modal>
  )
}

// The whole result, in one line: what came in, and how it groups. The scan also
// knows the file count, the commit it pinned, and the layout the source will
// open in — all stored, none of it shown. A person adding a repository is
// asking "did it work?", not reading an inventory.
function ScanSummary({ scan }: { scan: ScanResult }): JSX.Element {
  const plugins = scanPlugins(scan)
  const linked = plugins.filter((plugin) => plugin.origin.kind === 'linked').length
  const servers = scanMcpServers(scan).length
  const skills =
    scan.groups.length > 0 && scan.groupingSignal !== 'manifest'
      ? `${pluralSkills(scan.skills.length)} in ${scan.groups.length} categories`
      : pluralSkills(scan.skills.length)
  return (
    <dl className="grid grid-cols-[max-content_minmax(0,1fr)] gap-x-3 gap-y-1.5 text-meta">
      <dt className="text-[color:var(--text-muted)]">Found</dt>
      <dd className="text-[color:var(--text-strong)]">{SOURCE_SHAPE_LABEL[scanShape(scan)]}</dd>
      {plugins.length > 0 ? (
        <>
          <dt className="text-[color:var(--text-muted)]">Plugins</dt>
          <dd className="text-[color:var(--text-strong)]">
            {plugins.length}
            {linked > 0 ? ` · ${linked} of them link to other repositories, read when opened` : ''}
          </dd>
        </>
      ) : null}
      <dt className="text-[color:var(--text-muted)]">Skills</dt>
      <dd className="text-[color:var(--text-strong)]">{skills}</dd>
      {servers > 0 ? (
        <>
          <dt className="text-[color:var(--text-muted)]">MCP servers</dt>
          <dd className="text-[color:var(--text-strong)]">{servers}</dd>
        </>
      ) : null}
    </dl>
  )
}
