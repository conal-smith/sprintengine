import React, { useCallback, useEffect, useId, useState } from 'react'

import type { ArtifactsSetupQuestionView } from '../../../../shared/artifacts'
import { Modal, ModalBody, ModalButton, ModalFooter, ModalHeader } from '../ui/Modal'

// An agent asked to set up where artifacts are published (`artifacts.setup`),
// and that is the person's setting, so main asks them here first
// (artifacts-setup-consent-broker.ts), the way it asks what ssh asks. One
// question at a time. "Don't allow" is the focused default, and closing the
// dialog, Escape or the question expiring are all a no: setting a host up
// takes a click on the button that names it.

type Api = Pick<
  Window['api'],
  'onArtifactsSetupQuestion' | 'onArtifactsSetupQuestionClosed' | 'answerArtifactsSetupQuestion'
>

const TEXT = 'text-body leading-5 text-[color:var(--text-default)]'

export function ArtifactsSetupQuestionBody({
  question,
  onAnswer,
}: {
  question: ArtifactsSetupQuestionView
  onAnswer: (confirmed: boolean) => void
}) {
  const titleId = useId()
  const refuse = () => onAnswer(false)
  return (
    <Modal open onClose={refuse} labelledBy={titleId} size="confirm">
      <ModalHeader title={question.message} titleId={titleId} onClose={refuse} />
      <ModalBody className="flex flex-col gap-3">
        {question.detail.split('\n\n').map((paragraph, index) => (
          <p key={index} className={`${TEXT} whitespace-pre-wrap break-words`}>
            {paragraph}
          </p>
        ))}
      </ModalBody>
      <ModalFooter>
        <ModalButton type="button" onClick={refuse} autoFocus>
          {question.refuseLabel}
        </ModalButton>
        <ModalButton type="button" variant="primary" onClick={() => onAnswer(true)}>
          {question.confirmLabel}
        </ModalButton>
      </ModalFooter>
    </Modal>
  )
}

/** Mounted once per workspace window: shows main's set-up questions as they come, one at a time. */
export function ArtifactsSetupQuestionHost({ api = window.api }: { api?: Api }) {
  const [queue, setQueue] = useState<ArtifactsSetupQuestionView[]>([])
  useEffect(() => {
    if (!api?.onArtifactsSetupQuestion || !api.onArtifactsSetupQuestionClosed) return undefined
    const offQuestion = api.onArtifactsSetupQuestion((question) => setQueue((current) => [...current, question]))
    const offClosed = api.onArtifactsSetupQuestionClosed((id) =>
      setQueue((current) => current.filter((entry) => entry.id !== id)),
    )
    return () => {
      offQuestion()
      offClosed()
    }
  }, [api])
  const current = queue[0] ?? null
  useEffect(() => {
    if (!current) return undefined
    // Main gives up at the same moment; the dialog does not outstay it.
    const timer = setTimeout(
      () => setQueue((entries) => entries.filter((entry) => entry.id !== current.id)),
      Math.max(0, current.expiresAt - Date.now()),
    )
    return () => clearTimeout(timer)
  }, [current])
  const answer = useCallback(
    (confirmed: boolean) => {
      if (!current) return
      api.answerArtifactsSetupQuestion?.(current.id, confirmed)
      setQueue((entries) => entries.filter((entry) => entry.id !== current.id))
    },
    [api, current],
  )
  if (!current) return null
  return <ArtifactsSetupQuestionBody key={current.id} question={current} onAnswer={answer} />
}
