import assert from 'node:assert/strict'

import type { TailnetPushPayload, TailnetRemoteStatus } from '../shared/tailnet'
import type { MeshEvent, MeshPairRequestView } from '../shared/tailnet-mesh'
import { createTailnetNotifier, meshNotice, tailnetNotice, type TailnetNotice } from './tailnet-notifications'
import { test } from 'vitest'

test('tailnet-notifications', async () => {
  // OS notifications for pairing (pair-from-the-scan-and-stay-paired, phase 3):
  // only while no window is focused, only the events a person is waiting on,
  // never the code, and a revocation once — not once per retry.

  const status: TailnetRemoteStatus = {
    enabled: true,
    running: true,
    endpoint: '100.1.1.1:8471',
    port: 8471,
    tailnetAddress: '100.1.1.1',
    lastError: null,
    notifications: true,
    devices: [],
    pairing: null,
    pairRequests: [],
  }
  const request: MeshPairRequestView = {
    requestId: 'tpr_1',
    endpoint: '100.1.1.2:8471',
    machineName: 'sam-macbook-air',
    comparisonCode: '481972',
    expiresAt: '2026-09-04T21:05:00.000Z',
    reverseOffered: false,
  }
  function payload(event: TailnetPushPayload['event']): TailnetPushPayload {
    return { revision: 1, event, status, live: { revision: 1, devices: [] } }
  }

  // ── what is said ─────────────────────────────────────────────────────────

  {
    const notice = tailnetNotice(
      payload({
        kind: 'pair-request',
        phase: 'received',
        requestId: 'r1',
        deviceName: 'MacBook Air',
        peerNode: 'sam-macbook-air',
      }),
    )
    assert.ok(notice)
    assert.equal(notice.title, 'Pair request from sam-macbook-air')
    assert.doesNotMatch(notice.body, /\d{6}/u, 'the code never rides on a banner')
    assert.equal(
      tailnetNotice(
        payload({ kind: 'pair-request', phase: 'approved', requestId: 'r1', deviceName: 'x', peerNode: null }),
      ),
      null,
      'only the arrival is banner-worthy on the inbound side',
    )
    assert.equal(tailnetNotice(payload({ kind: 'listener', running: true })), null)
  }

  {
    const approved = meshNotice({ kind: 'pair-request', revision: 1, phase: 'approved', request })
    assert.equal(approved?.title, 'Paired with sam-macbook-air')
    const both = meshNotice({
      kind: 'pair-request',
      revision: 1,
      phase: 'approved',
      request: { ...request, reverseOffered: true },
    })
    assert.match(both?.body ?? '', /Both ways/u)
    assert.equal(
      meshNotice({ kind: 'pair-request', revision: 1, phase: 'denied', request })?.title,
      'sam-macbook-air declined',
    )
    assert.equal(
      meshNotice({ kind: 'pair-request', revision: 1, phase: 'expired', request })?.title,
      'sam-macbook-air did not answer in time',
    )
    assert.equal(
      meshNotice({ kind: 'pair-request', revision: 1, phase: 'waiting', request }),
      null,
      'waiting has the card',
    )
    assert.equal(meshNotice({ kind: 'pair-request', revision: 1, phase: 'cancelled', request }), null)
    assert.equal(
      meshNotice({ kind: 'machine-paired', revision: 1, connection: {} as never }),
      null,
      'the pair-request approved banner covers it',
    )
    const revoked = meshNotice({
      kind: 'machine-reachability',
      revision: 1,
      connectionId: 'c1',
      machineName: 'Mini',
      checking: false,
      reachable: false,
      unauthorized: true,
      checkedAt: 1,
      lastReachedAt: null,
      detail: 'Unauthorized.',
    })
    assert.equal(revoked?.title, 'Mini revoked this device')
    assert.equal(
      meshNotice({
        kind: 'machine-reachability',
        revision: 1,
        connectionId: 'c1',
        machineName: 'Mini',
        checking: false,
        reachable: false,
        unauthorized: false,
        checkedAt: 1,
        lastReachedAt: null,
        detail: 'asleep',
      }),
      null,
      'merely not answering is not a banner',
    )
  }

  // ── when it is said ──────────────────────────────────────────────────────

  {
    const shown: TailnetNotice[] = []
    let focused = true
    let enabled = true
    let opened = 0
    const notifier = createTailnetNotifier({
      isAnyWindowFocused: () => focused,
      isEnabled: () => enabled,
      show: (notice, onClick) => {
        shown.push(notice)
        onClick()
      },
      openRemote: () => {
        opened += 1
      },
    })
    const arrival = payload({
      kind: 'pair-request',
      phase: 'received',
      requestId: 'r1',
      deviceName: 'x',
      peerNode: 'air',
    })
    notifier.onTailnetEvent(arrival)
    assert.equal(shown.length, 0, 'a focused window is already looking')
    focused = false
    notifier.onTailnetEvent(arrival)
    assert.equal(shown.length, 1)
    assert.equal(opened, 1, 'a click opens the Remote surface')
    enabled = false
    notifier.onTailnetEvent(arrival)
    assert.equal(shown.length, 1, 'the switch in Settings is honoured')
    enabled = true

    const revokedEvent = (reachable: boolean, unauthorized: boolean): MeshEvent => ({
      kind: 'machine-reachability',
      revision: 2,
      connectionId: 'c1',
      machineName: 'Mini',
      checking: false,
      reachable,
      unauthorized,
      checkedAt: 1,
      lastReachedAt: null,
      detail: null,
    })
    notifier.onMeshEvent(revokedEvent(false, true))
    notifier.onMeshEvent(revokedEvent(false, true))
    notifier.onMeshEvent(revokedEvent(false, true))
    assert.equal(
      shown.filter((notice) => notice.key === 'revoked:c1').length,
      1,
      'a revocation is announced once, not per retry',
    )
    notifier.onMeshEvent(revokedEvent(true, false))
    notifier.onMeshEvent(revokedEvent(false, true))
    assert.equal(
      shown.filter((notice) => notice.key === 'revoked:c1').length,
      2,
      'and again after it answered in between',
    )
  }

  console.log('tailnet notification contracts ok')
})

test('an MCP client signing in is announced as one, never with its code', () => {
  const notice = tailnetNotice({
    revision: 1,
    event: {
      kind: 'pair-request',
      phase: 'received',
      requestId: 'r2',
      deviceName: 'Claude Code',
      peerNode: 'dev-macbook-air',
      oauth: true,
    },
    status: {
      enabled: true,
      running: true,
      endpoint: null,
      port: 8471,
      tailnetAddress: null,
      lastError: null,
      notifications: true,
      devices: [],
      pairing: null,
      pairRequests: [],
    },
    live: { revision: 1, devices: [] },
  })
  assert.ok(notice)
  assert.equal(notice.title, 'Claude Code wants access to Studio')
  assert.match(notice.body, /sign-in page/u)
  assert.doesNotMatch(notice.body, /\d{6}/u)
})

test('a retried sign-in raises no second notification', () => {
  const notice = tailnetNotice({
    revision: 2,
    event: {
      kind: 'pair-request',
      phase: 'received',
      requestId: 'r3',
      deviceName: 'Claude Code',
      peerNode: 'dev-macbook-air',
      oauth: true,
      retry: true,
    },
    status: {
      enabled: true,
      running: true,
      endpoint: null,
      port: 8471,
      tailnetAddress: null,
      lastError: null,
      notifications: true,
      devices: [],
      pairing: null,
      pairRequests: [],
    },
    live: { revision: 2, devices: [] },
  })
  assert.equal(notice, null)
})
