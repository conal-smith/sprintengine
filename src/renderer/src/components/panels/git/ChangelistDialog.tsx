// New changelist… / Edit changelist… (epic `git-commit-window`, T6).
//
// A kit `Modal`, not the one-line ask `useConfirmDialog` offers: a changelist
// has a NAME, an optional COMMENT, and — when it is being made — the question
// of whether the next change should land in it. Three fields is a form, and
// that dialog holds a single line.
//
// The comment is the load-bearing second field. The active list's comment
// is the commit message's placeholder, which is why a person
// writes one at all: the list is the sentence they will commit later, typed
// once, at the moment they knew what the work was.

import React, { type JSX } from 'react'

import { Checkbox, Field, Input, Textarea } from '../../ui'
// The shell itself is not on the barrel — every dialog in the product reaches
// for it by path, and this one follows that rather than widening the barrel for
// a single caller.
import { Modal, ModalBody, ModalButton, ModalFooter, ModalHeader } from '../../ui/Modal'
import { isImeKey } from '../../../utils/imeKey'

export type ChangelistDialogValue = {
  name: string
  comment: string
  /** Only asked on `new` — an existing list's active-ness is set from the menu,
   *  where it belongs beside the other lists it is exclusive with. */
  activate: boolean
}

export type ChangelistDialogProps = {
  open: boolean
  mode: 'new' | 'edit'
  initial: ChangelistDialogValue
  /** How many files the new list will be made around, when it was opened from
   *  "Move to → New changelist…". Zero means an empty list. */
  fileCount?: number
  busy?: boolean
  onCancel: () => void
  onSubmit: (value: ChangelistDialogValue) => void
}

export function ChangelistDialog({
  open,
  mode,
  initial,
  fileCount = 0,
  busy = false,
  onCancel,
  onSubmit,
}: ChangelistDialogProps): JSX.Element | null {
  const titleId = React.useId()
  const nameId = React.useId()
  const commentId = React.useId()
  const [name, setName] = React.useState(initial.name)
  const [comment, setComment] = React.useState(initial.comment)
  const [activate, setActivate] = React.useState(initial.activate)

  // Re-seed on every OPEN, not on every render: the dialog is mounted by the
  // panel and the same instance serves "new" and "edit", so a stale name from
  // the last time it was open would be the first thing the person sees.
  React.useEffect(() => {
    if (!open) return
    setName(initial.name)
    setComment(initial.comment)
    setActivate(initial.activate)
  }, [open, initial.name, initial.comment, initial.activate])

  if (!open) return null
  const trimmed = name.trim()
  const canSubmit = trimmed.length > 0 && !busy

  const submit = (): void => {
    if (!canSubmit) return
    onSubmit({ name: trimmed, comment: comment.trim(), activate })
  }

  return (
    <Modal open onClose={busy ? () => {} : onCancel} labelledBy={titleId} size="confirm">
      <ModalHeader
        title={mode === 'new' ? 'New changelist' : 'Edit changelist'}
        subtitle={
          mode === 'new' && fileCount > 0
            ? `${fileCount === 1 ? 'One file moves' : `${fileCount} files move`} into it.`
            : undefined
        }
        titleId={titleId}
        onClose={busy ? undefined : onCancel}
      />
      <ModalBody className="flex flex-col gap-3">
        <Field label="Name" htmlFor={nameId} required>
          <Input
            id={nameId}
            value={name}
            autoFocus
            placeholder="Feature name"
            onChange={(event) => setName(event.target.value)}
            onKeyDown={(event) => {
              // Enter submits from the one-line field, the way it does in every
              // other single-line form in the product. The textarea below does
              // not, because a comment has paragraphs.
              if (isImeKey(event)) return
              if (event.key === 'Enter') {
                event.preventDefault()
                submit()
              }
            }}
          />
        </Field>
        <Field
          label="Comment"
          htmlFor={commentId}
          help="Offered as the commit message when this list is the active one."
        >
          <Textarea
            id={commentId}
            value={comment}
            rows={3}
            placeholder="What this set of changes is"
            onChange={(event) => setComment(event.target.value)}
          />
        </Field>
        {mode === 'new' ? (
          // The kit checkbox IS a `<label>` and takes its own text. Wrapping it
          // in a second one nested two labels, gave the control two accessible
          // names (the `aria-label` and the outer label's text), and made a
          // click on the words land on the wrong element in some browsers.
          <Checkbox checked={activate} onChange={setActivate} label="Make this the active changelist" />
        ) : null}
      </ModalBody>
      <ModalFooter>
        <ModalButton type="button" onClick={onCancel} disabled={busy}>
          Cancel
        </ModalButton>
        <ModalButton type="button" variant="primary" onClick={submit} disabled={!canSubmit}>
          {mode === 'new' ? 'Create' : 'Save'}
        </ModalButton>
      </ModalFooter>
    </Modal>
  )
}
