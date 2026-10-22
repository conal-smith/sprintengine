import assert from 'node:assert/strict'

import type { TailnetRemoteStatus } from '../../../../shared/tailnet'
import {
  outstandingPairingNote,
  pairingExpiry,
  pairRequestAnswerable,
  pairRequestSummary,
  tailnetReadiness,
} from './tailnetPanelModel'
import { test } from 'vitest'

test('tailnetPanelModel', async () => {
  // The Remote (tailnet) panel's rules, tested where they live.
  //
  // The acceptance criterion these exist for: with Tailscale absent or down, the
  // panel says so plainly and the feature cannot be half-enabled.

  let failures = 0

  function check(name: string, run: () => void): void {
    try {
      run()
      console.log(`ok - ${name}`)
    } catch (error) {
      failures++
      console.error(`not ok - ${name}`)
      console.error(error)
    }
  }

  function status(overrides: Partial<TailnetRemoteStatus> = {}): TailnetRemoteStatus {
    return {
      enabled: false,
      running: false,
      endpoint: null,
      port: 8471,
      tailnetAddress: '100.64.0.1',
      lastError: null,
      notifications: true,
      devices: [],
      pairing: null,
      pairRequests: [],
      ...overrides,
    }
  }

  check('with no Tailscale the switch cannot be turned on, and the panel says why', () => {
    const readiness = tailnetReadiness(status({ tailnetAddress: null }))
    assert.equal(readiness.state, 'no-tailnet')
    assert.equal(readiness.canTurnOn, false, 'the feature must not be half-enabled')
    assert.equal(readiness.canPair, false)
    // Plainly: it names Tailscale and what to do, with no jargon and no code.
    assert.match(readiness.detail, /Tailscale/u)
    assert.match(readiness.detail, /Install Tailscale and sign in/u)
  })

  check('Tailscale going down under an enabled listener is an error, not a quiet Off', () => {
    const readiness = tailnetReadiness(
      status({ enabled: true, tailnetAddress: null, lastError: 'no Tailscale interface was found' }),
    )
    assert.equal(readiness.state, 'no-tailnet')
    assert.equal(readiness.tone, 'error')
    assert.equal(readiness.canPair, false, 'a pairing code would point at nothing')
    assert.match(readiness.detail, /nothing is listening/u)
    // Turning it back OFF must stay possible — only turning it ON is refused.
    assert.equal(readiness.canTurnOn, false)
  })

  check('off, failed-to-start, and listening are three distinct states', () => {
    const off = tailnetReadiness(status())
    assert.equal(off.state, 'off')
    assert.equal(off.canTurnOn, true)
    assert.equal(off.canPair, false)

    const failed = tailnetReadiness(status({ enabled: true, running: false, lastError: 'port 8471 is in use' }))
    assert.equal(failed.state, 'not-listening')
    assert.equal(failed.tone, 'error')
    assert.equal(failed.detail, 'port 8471 is in use', 'the real reason, not a generic one')
    assert.equal(failed.canPair, false)

    const listening = tailnetReadiness(status({ enabled: true, running: true, endpoint: '100.64.0.1:8471' }))
    assert.equal(listening.state, 'listening')
    assert.equal(listening.tone, 'good')
    assert.equal(listening.canPair, true)
    assert.match(listening.detail, /100\.64\.0\.1:8471/u)
  })

  check('enabled but running with no endpoint is still not pairable', () => {
    // Defensive: a status claiming to run with nowhere to reach it cannot mint a
    // usable code, so it is treated as not listening rather than trusted.
    const readiness = tailnetReadiness(status({ enabled: true, running: true, endpoint: null }))
    assert.equal(readiness.state, 'not-listening')
    assert.equal(readiness.canPair, false)
  })

  check('a pairing code’s remaining life reads in days, hours, minutes, then seconds, then expired', () => {
    const now = Date.parse('2026-08-07T12:00:00Z')
    // Codes run to 30 days, so the unit climbs with the remainder rather than
    // reporting a month in minutes.
    assert.equal(pairingExpiry('2026-09-06T12:00:00Z', now), 'Expires in 30 days')
    assert.equal(pairingExpiry('2026-08-08T18:00:00Z', now), 'Expires in 1 day')
    // Each step floors into its own unit: 23h59m is not "1 day".
    assert.equal(pairingExpiry('2026-08-08T11:59:00Z', now), 'Expires in 23 hours')
    assert.equal(pairingExpiry('2026-08-07T13:00:00Z', now), 'Expires in 1 hour')
    assert.equal(pairingExpiry('2026-08-07T12:09:30Z', now), 'Expires in 9 min')
    assert.equal(pairingExpiry('2026-08-07T12:00:45Z', now), 'Expires in 45s')
    assert.equal(pairingExpiry('2026-08-07T11:59:00Z', now), 'Expired')
    assert.equal(pairingExpiry('not a date', now), 'Expired')
  })

  check('a code the panel cannot re-show is still admitted to, not hidden', () => {
    // Reopening Settings loses the code (it is returned once and never re-read),
    // but the offer is still live in the main process. Hiding it would leave a
    // credential nobody can cancel; pretending none exists would put a fresh
    // "Pair a device" over a code someone is carrying to the other machine.
    //
    // ONE clause now (remote-settings-rebuild): the card it sits in draws the
    // expiry and the granted scopes as pills, so the note only has to say that a
    // code exists and what to do about it.
    const now = Date.parse('2026-08-07T12:00:00Z')
    const note = outstandingPairingNote(
      { scopes: ['workspace:read', 'backlog:read'], expiresAt: '2026-08-07T12:07:00Z' },
      now,
    )
    assert.match(note, /already active/u)
    assert.match(note, /expires in 7 min/u)
    assert.ok(!/scopes/u.test(note), 'the pills carry the scopes; the note does not repeat them')
  })

  check('a waiting request names who is asking, and says when it cannot vouch for the name', () => {
    const request = {
      id: 'tpr_1',
      deviceName: 'Sam’s MacBook Air',
      peerNode: 'macbook.example.ts.net',
      peerAddress: '100.64.0.9',
      createdAt: '2026-09-02T21:00:00.000Z',
      expiresAt: '2026-09-02T21:05:00.000Z',
    }
    assert.equal(pairRequestSummary(request), 'Asking from macbook.example.ts.net')
    // No whois means the address and a stated caveat — never an invented name,
    // and never dropping the request, which would make the feature dead on any
    // machine without the Tailscale CLI.
    assert.equal(pairRequestSummary({ ...request, peerNode: null }), 'Asking from 100.64.0.9 · name unverified')
    assert.match(pairRequestSummary({ ...request, peerNode: null, peerAddress: '' }), /unknown address/u)
  })

  check('a lapsed request explains itself rather than failing when pressed', () => {
    const request = {
      id: 'tpr_1',
      deviceName: 'Laptop',
      peerNode: null,
      peerAddress: '100.64.0.9',
      createdAt: '2026-09-02T21:00:00.000Z',
      expiresAt: '2026-09-02T21:05:00.000Z',
    }
    const before = Date.parse('2026-09-02T21:04:59.000Z')
    const after = Date.parse('2026-09-02T21:05:01.000Z')
    assert.deepEqual(pairRequestAnswerable(request, before), { canAnswer: true, note: null })
    assert.equal(pairRequestAnswerable(request, after).canAnswer, false)
    assert.match(String(pairRequestAnswerable(request, after).note), /lapsed/u)
  })

  if (failures > 0) {
    console.error(`${failures} test(s) failed`)
    process.exit(1)
  }
  console.log('tailnet panel model tests passed')
})
