import React, { useEffect, useId, useState, type JSX } from 'react'

import type { ThirdPartyModuleView } from '../../../../shared/modules/manifest'
import { AccessCareList, AccessChips, Checkbox, RefreshIcon, type AccessItem } from '../ui'
import { Modal, ModalBody, ModalButton, ModalFooter, ModalHeader } from '../ui/Modal'

// Review → trust and turn on, in one step. The dialog is the consent: what
// needs care with a short why for each, the rest as quiet pills, and — for
// unsigned code only — one box the person ticks to say they trust it anyway,
// which is what enables the primary action. One sentence says what trusting
// means, because the access list reads like a limit and is not one: a trusted
// module's code runs in the app with everything the app can reach. Beyond that
// nothing explains the dialog to itself: no sentence under the box, no
// reassurance under the title.

export const TRUSTED_MODULE_ACCESS_NOTE =
  'A trusted extension’s code runs inside SprintEngine Studio with full access to the app: your projects, your terminals and the credentials your agents use. The access below is what it says it uses, not a limit on what it can do.'

export type TrustReviewDialogProps = {
  module: ThirdPartyModuleView | null
  /** The extension's mark, as its row draws it. */
  icon: React.ReactNode
  /** "acme · GitHub · v1". */
  meta: string
  care: AccessItem[]
  standard: AccessItem[]
  busy: boolean
  onCancel: () => void
  onTrust: () => void
}

export function TrustReviewDialog({
  module,
  icon,
  meta,
  care,
  standard,
  busy,
  onCancel,
  onTrust,
}: TrustReviewDialogProps): JSX.Element | null {
  const titleId = useId()
  const [trustUnsigned, setTrustUnsigned] = useState(false)
  // A fresh answer for every module the dialog opens on.
  const moduleId = module?.manifest.id ?? null
  useEffect(() => setTrustUnsigned(false), [moduleId])

  if (!module) return null
  const unsigned = module.trust === 'unsigned'
  const ready = !busy && (!unsigned || trustUnsigned)
  return (
    <Modal open onClose={onCancel} labelledBy={titleId} size="standard">
      <ModalHeader title={`Trust ${module.manifest.displayName}?`} titleId={titleId} subtitle={meta} leading={icon} />
      <ModalBody className="space-y-4">
        <p className="text-meta leading-4 text-[color:var(--text-subtle)]">{TRUSTED_MODULE_ACCESS_NOTE}</p>
        {care.length > 0 ? (
          <section
            aria-label="Needs care"
            className="rounded-md border border-[color:var(--border-default)] px-3 pb-3 pt-2.5"
          >
            <h3 className="mb-2 text-meta font-semibold text-[color:var(--text-muted)]">Needs care</h3>
            <AccessCareList items={care} ariaLabel="Needs care" />
          </section>
        ) : null}
        {standard.length > 0 ? (
          <section aria-label={care.length > 0 ? 'Also' : 'Access'}>
            <h3 className="mb-1.5 text-meta font-semibold text-[color:var(--text-muted)]">
              {care.length > 0 ? 'Also' : 'Access'}
            </h3>
            <AccessChips items={standard} ariaLabel={care.length > 0 ? 'Also' : 'Access'} />
          </section>
        ) : null}
        {unsigned ? (
          <div className="rounded-md bg-[color:var(--tone-warn-soft)] px-3 py-2.5">
            <Checkbox
              checked={trustUnsigned}
              onChange={setTrustUnsigned}
              size="body"
              label={<span className="font-medium text-[color:var(--text-strong)]">I trust this unsigned code</span>}
            />
          </div>
        ) : null}
      </ModalBody>
      <ModalFooter>
        {module.launch.hasMainEntry ? (
          <span className="mr-auto inline-flex items-center gap-1.5 text-meta text-[color:var(--text-muted)]">
            <RefreshIcon className="icon-xs shrink-0" />
            Starts after a restart
          </span>
        ) : null}
        <ModalButton variant="ghost" onClick={onCancel}>
          Cancel
        </ModalButton>
        <ModalButton variant="primary" disabled={!ready} onClick={onTrust}>
          Trust and turn on
        </ModalButton>
      </ModalFooter>
    </Modal>
  )
}
