import React, { createContext, useCallback, useContext, useEffect, useId, useMemo, useState } from 'react'
import { Input } from './Input'
import { Modal, ModalBody, ModalButton, ModalFooter, ModalHeader } from './Modal'

type ConfirmTone = 'default' | 'danger'

type ConfirmDialogBase = {
  title: string
  body?: React.ReactNode
  confirmLabel?: string
  cancelLabel?: string
  pendingLabel?: string
  tone?: ConfirmTone
  pending?: boolean
  contained?: boolean
}

type ConfirmDialogProps = ConfirmDialogBase & {
  open: boolean
  onCancel: () => void
  onConfirm: () => void
}

export type ConfirmDialogOptions = ConfirmDialogBase

export type PromptDialogOptions = ConfirmDialogBase & {
  inputLabel: string
  initialValue?: string
  placeholder?: string
  required?: boolean
  validate?: (value: string) => string | null | undefined
}

type DialogRequest =
  | {
      kind: 'confirm'
      options: ConfirmDialogOptions
      resolve: (confirmed: boolean) => void
    }
  | {
      kind: 'prompt'
      options: PromptDialogOptions
      resolve: (value: string | null) => void
    }

type ConfirmDialogApi = {
  confirm: (options: ConfirmDialogOptions) => Promise<boolean>
  prompt: (options: PromptDialogOptions) => Promise<string | null>
}

const ConfirmDialogContext = createContext<ConfirmDialogApi | null>(null)

function ConfirmDialog({
  open,
  onCancel,
  onConfirm,
  title,
  body,
  confirmLabel = 'Confirm',
  cancelLabel = 'Cancel',
  pendingLabel,
  tone = 'default',
  pending = false,
  contained = false,
}: ConfirmDialogProps) {
  const titleId = useId()
  const confirmText = pending && pendingLabel ? pendingLabel : confirmLabel

  return (
    <Modal
      open={open}
      onClose={pending ? () => {} : onCancel}
      labelledBy={titleId}
      size="confirm"
      contained={contained}
    >
      <ModalHeader title={title} titleId={titleId} onClose={pending ? undefined : onCancel} />
      {body ? (
        <ModalBody>
          <div className="text-body leading-5 text-[color:var(--text-default)]">{body}</div>
        </ModalBody>
      ) : null}
      <ModalFooter>
        <ModalButton type="button" onClick={onCancel} disabled={pending}>
          {cancelLabel}
        </ModalButton>
        <ModalButton
          type="button"
          variant={tone === 'danger' ? 'danger' : 'primary'}
          onClick={onConfirm}
          disabled={pending}
          autoFocus
        >
          {confirmText}
        </ModalButton>
      </ModalFooter>
    </Modal>
  )
}

export function ConfirmDialogProvider({ children }: { children: React.ReactNode }) {
  const [request, setRequest] = useState<DialogRequest | null>(null)

  const replaceRequest = useCallback((nextRequest: DialogRequest) => {
    setRequest((current) => {
      if (current?.kind === 'confirm') current.resolve(false)
      if (current?.kind === 'prompt') current.resolve(null)
      return nextRequest
    })
  }, [])

  const confirm = useCallback(
    (options: ConfirmDialogOptions) => {
      return new Promise<boolean>((resolve) => {
        replaceRequest({ kind: 'confirm', options, resolve })
      })
    },
    [replaceRequest],
  )

  const prompt = useCallback(
    (options: PromptDialogOptions) => {
      return new Promise<string | null>((resolve) => {
        replaceRequest({ kind: 'prompt', options, resolve })
      })
    },
    [replaceRequest],
  )

  const api = useMemo(() => ({ confirm, prompt }), [confirm, prompt])

  useEffect(() => {
    return () => {
      setRequest((current) => {
        if (current?.kind === 'confirm') current.resolve(false)
        if (current?.kind === 'prompt') current.resolve(null)
        return null
      })
    }
  }, [])

  const closeConfirm = (confirmed: boolean) => {
    if (request?.kind !== 'confirm') return
    request.resolve(confirmed)
    setRequest(null)
  }

  const closePrompt = (value: string | null) => {
    if (request?.kind !== 'prompt') return
    request.resolve(value)
    setRequest(null)
  }

  return (
    <ConfirmDialogContext.Provider value={api}>
      {children}
      {request?.kind === 'confirm' ? (
        <ConfirmDialog
          open
          {...request.options}
          onCancel={() => closeConfirm(false)}
          onConfirm={() => closeConfirm(true)}
        />
      ) : null}
      {request?.kind === 'prompt' ? (
        <PromptDialog
          options={request.options}
          onCancel={() => closePrompt(null)}
          onSubmit={(value) => closePrompt(value)}
        />
      ) : null}
    </ConfirmDialogContext.Provider>
  )
}

/**
 * The dialog when this tree has one, else null: for a surface that is drawn in
 * places without a provider and asks only on a click, so its render never
 * throws and the click says it could not ask.
 */
export function useOptionalConfirmDialog(): ConfirmDialogApi | null {
  return useContext(ConfirmDialogContext)
}

export function useConfirmDialog(): ConfirmDialogApi {
  const context = useContext(ConfirmDialogContext)
  if (!context) {
    throw new Error('useConfirmDialog must be used within ConfirmDialogProvider')
  }
  return context
}

function PromptDialog({
  options,
  onCancel,
  onSubmit,
}: {
  options: PromptDialogOptions
  onCancel: () => void
  onSubmit: (value: string) => void
}) {
  const titleId = useId()
  const inputId = useId()
  const [value, setValue] = useState(options.initialValue ?? '')
  const [touched, setTouched] = useState(false)
  const trimmed = value.trim()
  const missing = Boolean(options.required) && trimmed.length === 0
  const validationError = options.validate?.(value) ?? null
  const canSubmit = !missing && !validationError
  // An empty required field is not an error yet — it is a field nobody has
  // filled in. The disabled confirm button already says "not yet"; a red
  // "Required" under an untouched input is the UI narrating itself. Real
  // validation messages wait for the first keystroke too.
  const shownError = touched ? validationError : null

  return (
    <Modal open onClose={onCancel} labelledBy={titleId} size="confirm" contained={options.contained}>
      <form
        onSubmit={(event) => {
          event.preventDefault()
          if (!canSubmit) return
          onSubmit(value)
        }}
      >
        <ModalHeader title={options.title} titleId={titleId} onClose={onCancel} />
        <ModalBody className="space-y-3">
          {options.body ? (
            <div className="text-body leading-5 text-[color:var(--text-default)]">{options.body}</div>
          ) : null}
          {/* No visible label and no required asterisk. The dialog title names
              the thing being asked for and there is exactly one field, so a
              label above it restates the title in smaller type. `inputLabel`
              becomes the accessible name instead — the label still exists for
              a screen reader, it just stops being redundant on screen. */}
          {/* The kit's field, at the overlay step: `md` (34px) is the ramp's
              size for a control inside a dialog, and `Input` brings the
              `--bg-field` ground, the hover edge, the `aria-invalid` edge and
              the disabled state the bare input here used to lack. */}
          <Input
            id={inputId}
            size="md"
            value={value}
            autoFocus
            placeholder={options.placeholder}
            aria-label={options.inputLabel}
            aria-required={options.required ? true : undefined}
            aria-invalid={shownError ? true : undefined}
            aria-describedby={shownError ? `${inputId}-error` : undefined}
            onChange={(event) => {
              setTouched(true)
              setValue(event.currentTarget.value)
            }}
          />
          {shownError ? (
            <p id={`${inputId}-error`} className="text-micro text-[color:var(--tone-error)]">
              {shownError}
            </p>
          ) : null}
        </ModalBody>
        <ModalFooter>
          <ModalButton type="button" onClick={onCancel}>
            {options.cancelLabel ?? 'Cancel'}
          </ModalButton>
          <ModalButton type="submit" variant={options.tone === 'danger' ? 'danger' : 'primary'} disabled={!canSubmit}>
            {options.confirmLabel ?? 'Continue'}
          </ModalButton>
        </ModalFooter>
      </form>
    </Modal>
  )
}
