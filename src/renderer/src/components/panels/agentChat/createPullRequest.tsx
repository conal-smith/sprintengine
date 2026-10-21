import React, { useCallback, useEffect, useId, useRef, useState } from 'react'

import {
  pullRequestNoun,
  type CreatePullRequestState,
  type PullRequestCheckoutPin,
} from '../../../../../shared/git/pull-request-create'
import type { BranchPullRequest } from '../../../../../shared/git/pull-request'
import type { PullRequestForge } from '../../../../../shared/git/pr-url'
import { Field, GhostButton, PullRequestGlyph, Spinner } from '../../ui'
import { Input, Textarea } from '../../ui/Input'
import { Modal, ModalBody, ModalButton, ModalFooter, ModalHeader } from '../../ui/Modal'
import { copyToClipboardWithToast } from '../../../utils/copyToClipboardWithToast'
import type { PullRequestHost } from './pullRequestHost'

// The chat's "Create PR" (owner ruling 2026-10-04), in the same slot at the
// bottom of the chat as "Open PR #123", and never beside it. The slot shows:
//
// - "Open PR #N" while the conversation owns an open (or draft) pull request;
// - "Create PR" when the checkout is ready to propose (`createPullRequestReadiness`:
//   a named branch that is not the default, commits no merged pull request
//   carried, and no open pull request from the branch, whoever opened it).
//   Uncommitted changes do not hide it: only the branch's commits are pushed,
//   and the confirm step says how many changes stay behind;
// - otherwise the conversation's merged pull request, as the sidebar shows it,
//   or nothing.
//
// Pressing it drafts a title and description with the person's own agent CLI
// (Settings → Agents → Text generation), shows them, editable, and creates the
// pull request only on "Create": it is outward-facing, so it is seen before it
// is sent. The app then pushes the branch if its remote is behind and opens
// the pull request itself — `gh pr create` on GitHub, `glab` on GitLab, `tea`
// on Gitea, Forgejo and Codeberg — and records it as this conversation's,
// which flips the slot to "Open PR #N". Where the forge's CLI is missing,
// signed out or fails (and on Bitbucket) it opens the forge's own page with
// the title and description filled in, and the strip says why; a description
// the page could not take is put on the clipboard, so nothing written is
// lost. A page the system would not open (Windows refuses a long address) is
// never claimed opened: the title and description go on the clipboard and
// the strip says so. Where the CLI probably opened the request but its
// address is not known, the forge's list of requests opens instead, to find
// it in. Every step says where it is, and a failure says why, on the strip.
//
// GitLab calls them merge requests, and so does the control on a GitLab
// checkout: "Create MR", "Create a merge request".
//
// Where the work is done is the host's (`pullRequestHost.ts`): this
// computer's shell for a chat here, the paired machine for a chat there
// (owner ruling 2026-10-18), which drafts with its own text generation
// settings and records the pull request itself. Opening a page and the
// clipboard stay here, in front of the person. A chat on WSL or an SSH
// machine draws no button, because its git and `gh` are not here and nothing
// there answers for them.

/** Which control the slot draws. */
export type PullRequestSlotChoice = 'open' | 'create' | 'merged' | null

/** The slot's rule, pure (see the header). */
export function pullRequestSlotChoice(
  pullRequests: readonly BranchPullRequest[],
  createReady: boolean,
): PullRequestSlotChoice {
  if (pullRequests.some((pr) => pr.state === 'open')) return 'open'
  if (createReady) return 'create'
  if (pullRequests.some((pr) => pr.state === 'merged')) return 'merged'
  return null
}

/**
 * Whether the checkout is ready to propose, asked of its host when the chat
 * opens, when `refreshKey` changes (a turn ended, the branch or its changes
 * moved, a pull request moved) and when the window comes back to the front.
 * Null asks nothing and answers nothing.
 */
export function useCreatePullRequestState(
  host: PullRequestHost | null,
  refreshKey: string,
): CreatePullRequestState | null {
  const [state, setState] = useState<CreatePullRequestState | null>(null)
  // Asks overlap (a focus during a turn's end, a `gh` lookup that takes
  // seconds), and only the latest may answer: an earlier one landing last
  // would put back a reading the checkout has since moved on from.
  const latest = useRef(0)
  const ask = useCallback(async () => {
    const asked = ++latest.current
    if (!host) {
      setState(null)
      return
    }
    let next: CreatePullRequestState | null
    try {
      next = await host.state()
    } catch {
      // A shell that cannot answer (the web client has no checkout here) draws no button.
      next = null
    }
    if (asked === latest.current) setState(next)
  }, [host])
  useEffect(() => {
    void ask()
  }, [ask, refreshKey])
  useEffect(() => {
    const onFocus = () => void ask()
    window.addEventListener('focus', onFocus)
    return () => window.removeEventListener('focus', onFocus)
  }, [ask])
  return state
}

/** `noted`: the forge's page opened instead of the request being created here, and why. */
type Progress = { step: 'pushing' | 'creating' | 'recording' } | { step: 'failed' | 'noted'; message: string } | null

function stepWords(step: 'pushing' | 'creating' | 'recording', noun: string): string {
  return step === 'pushing' ? 'Pushing the branch…' : `Opening the ${noun}…`
}

/** What the strip says when the forge's page opened: why, and where the description went if the page could not take it. */
function pageNote(place: string, reason: string | undefined, descriptionCopied: boolean): string | null {
  const note = reason ? `${place}’s page opened instead. ${reason}` : null
  const copied = descriptionCopied ? 'The description is on the clipboard to paste into the page.' : null
  if (note && copied) return `${note} ${copied}`
  return note ?? copied
}

/**
 * What the strip says when the forge's page would not open: that it did not,
 * where the title and description went instead, and why the page was the
 * way at all. `copied` names what reached the clipboard, null when nothing
 * did (the copy says its own failure).
 */
function unopenedPageNote(
  place: string,
  reason: string | undefined,
  copied: 'title' | 'title and description' | null,
): string {
  const lead = copied
    ? `${place}’s page could not be opened, so the ${copied} ${copied === 'title' ? 'is' : 'are'} on the clipboard.`
    : `${place}’s page could not be opened.`
  return reason ? `${lead} ${reason}` : lead
}

/** What the strip says when the request's address is not known and the forge's list of them was to open. */
function listNote(place: string, reason: string, noun: string, opened: boolean): string {
  return opened
    ? `${reason} ${place}’s ${noun} list opened, to look for it there.`
    : `${reason} Look for it in ${place}’s ${noun} list.`
}

/**
 * Whether the system opened `url` in the browser. The shell answers
 * `{ ok: false }` when it would not (an address too long for Windows, no
 * handler for it), and a shell with no bridge opens nothing.
 */
async function openedExternally(url: string): Promise<boolean> {
  const open = typeof window === 'undefined' ? undefined : window.api?.openExternal
  if (typeof open !== 'function') return false
  try {
    const result = await open(url)
    return result?.ok !== false
  } catch {
    return false
  }
}

/**
 * The "Create PR" button, its confirm step, and the progress and failures it
 * says on the strip.
 */
export function CreatePullRequestControl({
  host,
  onSettled,
  onHoldChange,
  ready = true,
  forge = null,
}: {
  /** The machine whose checkout the pull request is opened from, and whose record keeps it. */
  host: PullRequestHost
  /** The forge the checkout's remote is on, whose own word for the request the control uses. */
  forge?: PullRequestForge | null
  /**
   * Whether the checkout reads as ready for a pull request now. Held on a
   * failure once it is not (the pull request it opened exists), the control
   * offers to dismiss the failure rather than a Create PR that could only fail.
   */
  ready?: boolean
  /** The flow ended (created, opened a forge page, or failed): ask again whether the button may show. */
  onSettled: () => void
  /**
   * The control has something on screen of its own: the dialog, a step in
   * progress, or a failure. The slot keeps it while it does, even once the
   * checkout stops reading as ready, which it does the moment the pull
   * request exists: the ask `onSettled` starts would otherwise unmount it
   * with a failure to record it still unread.
   */
  onHoldChange?: (held: boolean) => void
}): React.JSX.Element {
  const [dialogOpen, setDialogOpen] = useState(false)
  const [progress, setProgress] = useState<Progress>(null)
  const noun = pullRequestNoun(forge)
  const held = dialogOpen || progress !== null
  useEffect(() => {
    onHoldChange?.(held)
  }, [held, onHoldChange])
  useEffect(() => () => onHoldChange?.(false), [onHoldChange])

  // `pin`: the branch and commit the dialog opened on. The push and the
  // creation are refused once the checkout has moved off it.
  const create = async (text: { title: string; body: string }, pin: PullRequestCheckoutPin | null) => {
    setDialogOpen(false)
    setProgress({ step: 'pushing' })
    const pushed = await host.push(pin ?? undefined).catch((error: unknown) => failed(error))
    if (!pushed.ok) {
      setProgress({ step: 'failed', message: pushed.message })
      return
    }
    setProgress({ step: 'creating' })
    const created = await host.create(text, pin ?? undefined).catch((error: unknown) => failed(error))
    if (!created.ok) {
      setProgress({ step: 'failed', message: created.message })
      return
    }
    if (created.kind === 'page' || created.kind === 'list' || created.kind === 'existing') {
      // A page: the forge opens it from there, and nothing exists to record
      // yet. A list: the request is probably there, but with no address
      // there is nothing to record either. An existing one: the branch had
      // it already, perhaps a teammate's, so it is shown, not claimed for
      // this chat (whose merge would then settle it).
      const opened = await openedExternally(created.url)
      let note: string | null = null
      if (created.kind === 'existing') {
        if (!opened) note = `This branch already has a ${noun}, and it could not be opened.`
      } else if (created.kind === 'list') {
        note = listNote(created.place, created.reason, noun, opened)
      } else if (opened) {
        const copied =
          created.descriptionLeftOut === true && text.body.trim() !== ''
            ? await copyToClipboardWithToast(text.body, { success: 'silent' })
            : false
        note = pageNote(created.place, created.reason, copied)
      } else {
        // Nothing opened, so nothing was filled in anywhere: everything the
        // person confirmed goes on the clipboard for them to take to the forge.
        const described = text.body.trim() !== ''
        const copied = await copyToClipboardWithToast(described ? `${text.title}\n\n${text.body}` : text.title, {
          success: 'silent',
        })
        note = unopenedPageNote(
          created.place,
          created.reason,
          copied ? (described ? 'title and description' : 'title') : null,
        )
      }
      setProgress(note ? { step: 'noted', message: note } : null)
      onSettled()
      return
    }
    setProgress({ step: 'recording' })
    const recorded = await host.link(created.url, text.title)
    setProgress(recorded.ok ? null : { step: 'failed', message: recorded.message })
    onSettled()
  }

  const busy = progress !== null && progress.step !== 'failed' && progress.step !== 'noted'
  const said = progress?.step === 'failed' || progress?.step === 'noted'
  return (
    <span className="inline-flex min-w-0 items-center gap-1.5" data-strip-create-pull-request="">
      {progress?.step === 'noted' ? (
        <span
          role="status"
          className="min-w-0 max-w-64 truncate text-meta text-[color:var(--text-muted)]"
          title={progress.message}
          data-create-pull-request-note=""
        >
          {progress.message}
        </span>
      ) : progress?.step === 'failed' ? (
        <span
          role="alert"
          className="min-w-0 max-w-64 truncate text-meta text-[color:var(--tone-error)]"
          title={progress.message}
          data-create-pull-request-error=""
        >
          {progress.message}
        </span>
      ) : busy ? (
        <span
          role="status"
          className="inline-flex items-center gap-1.5 whitespace-nowrap text-meta text-[color:var(--text-subtle)]"
        >
          <Spinner size={12} />
          {stepWords(progress.step, noun)}
        </span>
      ) : null}
      {busy ? null : said && !ready ? (
        <GhostButton
          size="xs"
          tone="subtle"
          // Read: the slot goes back to what the checkout says.
          onClick={() => setProgress(null)}
          aria-label={progress?.step === 'noted' ? 'Dismiss this note' : 'Dismiss this Create PR failure'}
          className="shrink-0 whitespace-nowrap"
        >
          Dismiss
        </GhostButton>
      ) : (
        <GhostButton
          size="xs"
          tone="subtle"
          onClick={() => {
            setProgress(null)
            setDialogOpen(true)
          }}
          aria-label={`Create a ${noun} from this branch`}
          className="shrink-0 gap-1.5 whitespace-nowrap"
        >
          <PullRequestGlyph state="open" className="icon-xs" />
          {forge === 'gitlab' ? 'Create MR' : 'Create PR'}
        </GhostButton>
      )}
      {dialogOpen ? (
        <CreatePullRequestDialog
          host={host}
          noun={noun}
          onCancel={() => setDialogOpen(false)}
          onCreate={(text, pin) => void create(text, pin)}
        />
      ) : null}
    </span>
  )
}

/**
 * What the confirm step says about work left in the checkout. It never blocks:
 * the push sends the branch's commits and nothing else, so a stray untracked
 * file is no reason to hide Create PR, but the person should not believe their
 * unsaved edits are in the pull request.
 */
export function uncommittedNote(count: number): string {
  return count === 1
    ? '1 uncommitted change won’t be included: only the branch’s commits are pushed.'
    : `${count} uncommitted changes won’t be included: only the branch’s commits are pushed.`
}

function failed(error: unknown): { ok: false; message: string } {
  return { ok: false, message: error instanceof Error ? error.message : String(error) }
}

/**
 * The confirm step: the drafted title and description, editable, and
 * "Create". Drafting failing is said here, and leaves both fields to write by
 * hand.
 */
function CreatePullRequestDialog({
  host,
  noun,
  onCancel,
  onCreate,
}: {
  host: PullRequestHost
  /** "merge request" on GitLab, "pull request" elsewhere. */
  noun: string
  onCancel: () => void
  onCreate: (text: { title: string; body: string }, pin: PullRequestCheckoutPin | null) => void
}): React.JSX.Element {
  const titleId = useId()
  const titleFieldId = useId()
  const bodyFieldId = useId()
  const [title, setTitle] = useState('')
  const [body, setBody] = useState('')
  const [drafting, setDrafting] = useState(true)
  const [draftError, setDraftError] = useState<string | null>(null)
  // The branch and commit the draft is written from, read as the dialog
  // opens: what "Create" confirms, and so all the push and creation may use.
  const pin = useRef<PullRequestCheckoutPin | null>(null)
  // Read with the pin: changes in the working tree the pull request leaves out.
  const [uncommitted, setUncommitted] = useState(0)
  useEffect(() => {
    let alive = true
    void host
      .state()
      .then((state) => {
        if (!alive) return
        if (state?.branch && state.headSha) pin.current = { branch: state.branch, headSha: state.headSha }
        setUncommitted(state?.uncommittedChanges ?? 0)
      })
      .catch(() => undefined)
    return () => {
      alive = false
    }
  }, [host])

  useEffect(() => {
    let alive = true
    // Named, so closing the dialog mid-draft stops the CLI writing it rather
    // than leaving it to run to its deadline for an answer nobody will read.
    const draftId =
      typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function'
        ? crypto.randomUUID()
        : `${Date.now()}-${Math.random().toString(36).slice(2)}`
    const started = host.draft(draftId)
    if ('refused' in started) {
      setDrafting(false)
      setDraftError(started.refused)
      return
    }
    let pending = true
    void started.written
      .then((result) => {
        pending = false
        if (!alive) return
        if (result.ok) {
          setTitle((current) => current || result.title)
          setBody((current) => current || result.body)
        } else {
          setDraftError(result.message)
        }
      })
      .catch((error: unknown) => {
        pending = false
        if (alive) setDraftError(`The draft could not be written: ${failed(error).message}`)
      })
      .finally(() => {
        if (alive) setDrafting(false)
      })
    return () => {
      alive = false
      if (pending) void host.cancelDraft(draftId).catch(() => undefined)
    }
    // Drafted once per opening, by the host it opened on.
  }, [host])

  const submit = (event?: React.FormEvent) => {
    event?.preventDefault()
    if (!title.trim() || drafting) return
    onCreate({ title: title.trim(), body }, pin.current)
  }

  return (
    <Modal open onClose={onCancel} labelledBy={titleId} size="wide">
      <form onSubmit={submit}>
        <ModalHeader title={`Create a ${noun}`} titleId={titleId} onClose={onCancel} />
        <ModalBody className="flex flex-col gap-3">
          {drafting ? (
            <p role="status" className="inline-flex items-center gap-2 text-body text-[color:var(--text-muted)]">
              <Spinner size={14} />
              Writing a title and description from the branch’s commits…
            </p>
          ) : null}
          {draftError ? (
            <p role="alert" className="text-body text-[color:var(--tone-error)]">
              {draftError}
            </p>
          ) : null}
          {uncommitted > 0 ? (
            <p className="text-meta text-[color:var(--text-muted)]" data-create-pull-request-uncommitted="">
              {uncommittedNote(uncommitted)}
            </p>
          ) : null}
          <Field label="Title" htmlFor={titleFieldId}>
            <Input
              id={titleFieldId}
              value={title}
              onChange={(event) => setTitle(event.target.value)}
              disabled={drafting}
              maxLength={300}
            />
          </Field>
          <Field label="Description" htmlFor={bodyFieldId}>
            <Textarea
              id={bodyFieldId}
              value={body}
              onChange={(event) => setBody(event.target.value)}
              disabled={drafting}
              rows={12}
              className="font-mono"
            />
          </Field>
        </ModalBody>
        <ModalFooter>
          <ModalButton type="button" onClick={onCancel}>
            Cancel
          </ModalButton>
          <ModalButton type="submit" variant="primary" disabled={drafting || !title.trim()}>
            Create
          </ModalButton>
        </ModalFooter>
      </form>
    </Modal>
  )
}
