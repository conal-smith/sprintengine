import React from 'react'

import { TAILNET_LEGACY_REQUEST_SCOPES, type TailnetPairRequest } from '../../../../shared/tailnet'
import { GhostButton, Input, PrimaryButton } from '../ui'
import { shortMachineName } from './machineRowModel'
import { usePairRequestAnswer } from './pairRequestAnswer'
import { signInDefaultScopes } from './scopePickerModel'

// Answering a pair request from the toast it arrives in (owner ruling
// 2026-09-05, recorded in design-system/components/toast/component.md): the
// code field and the two answers, nothing else. The old toast only pointed
// at the Remote glyph — a person at the machine, watching the asking screen,
// had to go somewhere else to type the digits it was showing.
//
// Allow here grants exactly what the asking machine ASKED FOR
// (`requestedScopes`, remote-settings-rebuild). It used to grant a house
// default, which meant a machine that asked to watch your chats was silently
// paired without the scope that shows them and nobody was told — the same bug
// in one click that the old Pair a device button had in another. The card in
// the Remote popover remains the surface that CHANGES the set; this one answers
// the question as it was put.
export function PairRequestToastAccept({ request }: { request: TailnetPairRequest }) {
  const { code, setCode, codeError, busy, answer } = usePairRequestAnswer(request.id)
  const inputId = React.useId()
  const helpId = `${inputId}-help`
  // The same short name the toast's title carries: the field is labelled by
  // the machine a person is looking at, not by its tailnet FQDN.
  const asker = shortMachineName(request.peerNode ?? request.peerAddress)
  const disabled = busy !== null
  // Absent on a request from a build older than the field, which reads as the
  // set every pairing path defaulted to before it existed — never a scope added
  // since, such as the conversation pair, which that build could not have
  // asked for. The same fallback the pair-request card and the store use.
  const asked = [...(request.requestedScopes ?? TAILNET_LEGACY_REQUEST_SCOPES)]
  // An MCP client signing in is allowed Read only from here; more is chosen on
  // the card, where the scopes are shown.
  const requested = request.oauth ? signInDefaultScopes(asked) : asked
  const codeSource = request.oauth ? 'the sign-in page' : asker

  return (
    <div className="mt-1.5">
      <div className="flex items-center gap-1.5">
        <Input
          id={inputId}
          value={code}
          onChange={(event) => setCode(event.target.value)}
          onKeyDown={(event) => {
            if (event.key === 'Enter' && code.length === 6 && !disabled) void answer('allow', requested)
          }}
          inputMode="numeric"
          pattern="[0-9]*"
          autoComplete="one-time-code"
          maxLength={6}
          placeholder="000000"
          aria-label={`Code shown on ${codeSource}`}
          aria-describedby={helpId}
          aria-invalid={codeError ? true : undefined}
          disabled={disabled}
          fullWidth={false}
          className="w-[92px] text-center font-mono tracking-[0.2em]"
        />
        <span className="flex-1" />
        <GhostButton size="sm" disabled={disabled} onClick={() => void answer('decline', requested)}>
          {busy === 'decline' ? 'Declining…' : 'Decline'}
        </GhostButton>
        <PrimaryButton
          size="sm"
          disabled={disabled || code.length !== 6}
          onClick={() => void answer('allow', requested)}
        >
          {busy === 'allow' ? 'Allowing…' : 'Allow'}
        </PrimaryButton>
      </div>
      <p
        id={helpId}
        className={`mt-1 text-micro ${codeError ? 'text-[color:var(--tone-error)]' : 'text-[color:var(--text-subtle)]'}`}
      >
        {codeError ??
          (request.oauth
            ? 'Type the code its sign-in page shows. Allows read only; choose more from the Remote glyph.'
            : 'Type the code it is showing.')}
      </p>
    </div>
  )
}
