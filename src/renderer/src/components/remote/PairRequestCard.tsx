import React from 'react'

import {
  PAIR_REQUEST_CODE_ATTEMPTS,
  TAILNET_LEGACY_REQUEST_SCOPES,
  type TailnetPairRequest,
  type TailnetScope,
} from '../../../../shared/tailnet'
import { Input, OutlineButton, PrimaryButton, StatusDot } from '../ui'
import { pairRequestAnswerable } from '../settings/tailnetPanelModel'
import { ScopePicker } from './ScopePicker'
import { usePairRequestAnswer } from './pairRequestAnswer'
import { clampToRequested, signInDefaultScopes } from './scopePickerModel'

// The ACTING surface for a request from another machine, shared by the
// Remote popover and Settings → Remote (pair-from-the-scan-and-stay-paired,
// phase 2). The six digits are no longer displayed here: the person TYPES
// the code the asking machine is showing, which proves they can see that
// screen — the binding the comparison code was always for, enforced rather
// than trusted. Main compares; a wrong code is refused inline; the third
// wrong code declines the request. Approval and denial go through the exact
// IPC both surfaces always used (`usePairRequestAnswer`), and resolution
// reaches every surface over the push channel, so no double-approve is
// possible.
//
// This is the surface that CHOOSES SCOPES, and it opens pre-ticked to what the
// asking machine ASKED FOR (`requestedScopes`) rather than to a house default
// the asker never wanted — the difference between answering the question that
// was put and answering a different one. The rows are the same `ScopePicker`
// the Pair a device dialog uses, so one set of words decides what a scope means
// in both directions. The toast the request arrives as grants exactly the
// requested set; anyone who wants to change it comes here.
//
// An MCP client signing in with OAuth (`request.oauth`) is the same card in
// other words. It names the client and where its access goes — a client on
// the computer whose browser opened the sign-in page, or a web service whose
// operator gets the access — and the code to type is the one that page shows.
// It opens on Read only, and can be granted at most what the client asked for.

export function PairRequestCard({
  request,
  now,
  /** Settings draws it flush on the page; the popover as a bordered card. */
  variant = 'card',
}: {
  request: TailnetPairRequest
  now: number
  variant?: 'card' | 'flush'
}) {
  // A request from a build older than `requestedScopes` carries none, and reads
  // as the structured set — what every pairing path defaulted to before the
  // field existed.
  const requested = React.useMemo<TailnetScope[]>(
    () => [...(request.requestedScopes ?? TAILNET_LEGACY_REQUEST_SCOPES)],
    [request.requestedScopes],
  )
  const signIn = request.oauth ?? null
  const initial = React.useMemo(() => (signIn ? signInDefaultScopes(requested) : requested), [signIn, requested])
  const [scopes, setScopesRaw] = React.useState<TailnetScope[]>(initial)
  const setScopes = (next: TailnetScope[]): void => setScopesRaw(signIn ? clampToRequested(next, requested) : next)
  // A request replaced under the cursor (answered elsewhere, re-asked) must not
  // leave the previous asker's ticks on screen.
  React.useEffect(() => setScopesRaw(initial), [initial])
  const { code, setCode, codeError, busy, answer } = usePairRequestAnswer(request.id)
  const inputId = React.useId()
  const helpId = `${inputId}-help`
  const msLeft = Math.max(0, Date.parse(request.expiresAt) - now)
  const minutes = Math.floor(msLeft / 60_000)
  const seconds = Math.floor((msLeft % 60_000) / 1000)
  // Settings' own rule: a lapsed request stays on screen until the channel
  // clears it, with its buttons dead and the reason stated — not failing.
  const answerable = pairRequestAnswerable(request, now)
  const disabled = busy !== null || !answerable.canAnswer
  const asker = request.peerNode ?? request.peerAddress
  const codeSource = signIn ? 'the sign-in page' : asker

  const frame =
    variant === 'card'
      ? 'mx-2.5 my-1.5 rounded-md border border-[color:var(--border-default)] p-2.5'
      : // A row inside a card: the card owns the hairline, so the row owns only
        // its padding — and it pads its sides too, since the card is full-bleed.
        'px-3 py-2.5'

  return (
    <div className={frame} data-pair-request={request.id}>
      <div className="flex items-center gap-2 text-meta">
        <StatusDot tone="warn" pulse label={signIn ? 'Sign-in request' : 'Pair request'} />
        <span className="min-w-0 flex-1 truncate font-medium text-[color:var(--text-default)]">
          {signIn ? signIn.clientName : asker}{' '}
          <span className="font-normal text-[color:var(--text-subtle)]">
            {signIn ? 'wants access to this Studio' : 'asks to pair'}
          </span>
        </span>
      </div>
      {/* Both identities, labelled: the node is what the transport proved
          (Tailscale's whois, or the bare address, unverified); the device
          name is whatever the asker typed. */}
      <dl className="mt-1 grid grid-cols-[auto_minmax(0,1fr)] gap-x-2 gap-y-0.5 text-micro">
        <dt className="text-[color:var(--text-subtle)]">
          {signIn ? 'Sign-in page opened on' : request.peerNode ? 'Tailnet node' : 'Address (unverified)'}
        </dt>
        <dd className="truncate font-mono text-[color:var(--text-default)]">
          {asker}
          {signIn && !request.peerNode ? ' (unverified)' : ''}
          {signIn?.viaServe && request.peerNode ? ' (as Tailscale Serve reports it)' : ''}
        </dd>
        {signIn ? (
          <>
            <dt className="text-[color:var(--text-subtle)]">Access goes to</dt>
            <dd className="truncate text-[color:var(--text-default)]">
              {signIn.redirectKind === 'loopback'
                ? `An MCP client on ${asker} (${signIn.redirectHost})`
                : `${signIn.redirectHost} — whoever runs it gets the access`}
            </dd>
          </>
        ) : (
          <>
            <dt className="text-[color:var(--text-subtle)]">Calls itself</dt>
            <dd className="truncate text-[color:var(--text-default)]">{request.deviceName}</dd>
          </>
        )}
      </dl>
      {signIn ? (
        <p className="mt-1 text-micro text-[color:var(--text-subtle)]">
          Only allow a sign-in you just started. It lasts 30 days.
        </p>
      ) : null}
      <div className="my-2">
        <label htmlFor={inputId} className="mb-1 block text-meta text-[color:var(--text-muted)]">
          Enter the code shown on {codeSource}
        </label>
        <Input
          id={inputId}
          value={code}
          onChange={(event) => setCode(event.target.value)}
          onKeyDown={(event) => {
            if (event.key === 'Enter' && code.length === 6 && !disabled && scopes.length > 0)
              void answer('allow', scopes)
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
          className="text-center font-mono text-title tracking-[0.3em]"
        />
        <p
          id={helpId}
          className={`mt-1 text-micro ${codeError ? 'text-[color:var(--tone-error)]' : 'text-[color:var(--text-subtle)]'}`}
        >
          {codeError ?? `Allow enables at six digits. ${PAIR_REQUEST_CODE_ATTEMPTS} wrong codes decline the request.`}
        </p>
      </div>
      <div className="pb-2">
        <ScopePicker value={scopes} onChange={setScopes} disabled={disabled} idPrefix={`pair-request-${request.id}`} />
      </div>
      <div className="flex items-center gap-2">
        <span className="font-mono text-micro tabular-nums text-[color:var(--tone-warn)]">
          {answerable.canAnswer ? `${minutes}:${String(seconds).padStart(2, '0')}` : 'Lapsed'}
        </span>
        <span className="flex-1" />
        <OutlineButton size="sm" disabled={disabled} onClick={() => void answer('decline', scopes)}>
          {busy === 'decline' ? 'Declining…' : 'Decline'}
        </OutlineButton>
        <PrimaryButton
          size="sm"
          disabled={disabled || scopes.length === 0 || code.length !== 6}
          onClick={() => void answer('allow', scopes)}
        >
          {busy === 'allow' ? 'Allowing…' : 'Allow'}
        </PrimaryButton>
      </div>
      {answerable.note ? <p className="mt-1.5 text-micro text-[color:var(--text-subtle)]">{answerable.note}</p> : null}
    </div>
  )
}
