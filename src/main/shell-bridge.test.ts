import assert from 'node:assert/strict'
import { describe, test } from 'vitest'

import type { AgentLaunchRequest, AgentLaunchResult } from '../shared/agent-launch'
import { createControlRpc, type ControlRpc } from '../server/bootstrap/control-rpc'
import type { StudioNotice } from '../server/platform/notifier'
import { createRemoteShellBridge } from '../server/shell-bridge/remote'
import { serveShellBridge } from '../server/shell-bridge/serve-shell-bridge'
import {
  utf8Bytes,
  utf8Text,
  type ShellAnalyticsEvent,
  type ShellBridge,
  type ShellRevealTarget,
} from '../server/shell-bridge/shell-bridge'
import { createInProcessShellBridge } from './shell-bridge'
import type { DecodedImage, ImageCodec } from './conversation-image-downscale'

// The bridge's contract, run against both implementations: the shell's own
// (what the server calls in process) and the remote one a server out of
// process holds, served over a control channel by that same shell bridge.

type Harness = {
  bridge: ShellBridge
  notices: StudioNotice[]
  reveals: ShellRevealTarget[]
  events: ShellAnalyticsEvent[]
  setWindows(present: boolean): void
  setLauncher(launch: ((request: AgentLaunchRequest) => Promise<AgentLaunchResult>) | null): void
  openIntegrations(): void
  setEncryptionAvailable(available: boolean): void
}

// safeStorage's shape: a reversible transform that is not the identity, so a
// test can tell sealed bytes from plain ones.
const PREFIX = Buffer.from('v10')
function fakeSafeStorage() {
  let available = true
  return {
    setAvailable: (next: boolean) => {
      available = next
    },
    isEncryptionAvailable: () => available,
    encryptString: (plain: string) => Buffer.concat([PREFIX, Buffer.from(plain, 'utf8').reverse()]),
    decryptString: (sealed: Buffer) => {
      if (!sealed.subarray(0, 3).equals(PREFIX)) throw new Error('not sealed by this keychain')
      return Buffer.from(sealed.subarray(3)).reverse().toString('utf8')
    },
  }
}

// An image codec over text: `img:<w>x<h>` decodes at that size, and encodes as
// `png:<w>x<h>` or `jpeg:<w>x<h>`, so a test reads what was drawn at what size.
function textImage(width: number, height: number): DecodedImage {
  return {
    width,
    height,
    resize: (nextWidth, nextHeight) => textImage(nextWidth, nextHeight),
    png: () => utf8Bytes(`png:${width}x${height}`),
    jpeg: () => utf8Bytes(`jpeg:${width}x${height}`),
  }
}
const textImageCodec: ImageCodec = {
  decode(bytes) {
    const match = /^img:(\d+)x(\d+)$/.exec(utf8Text(bytes))
    return match ? textImage(Number(match[1]), Number(match[2])) : null
  },
}

function shellHarness(): Harness & { shellBridge: ShellBridge } {
  const notices: StudioNotice[] = []
  const reveals: ShellRevealTarget[] = []
  const events: ShellAnalyticsEvent[] = []
  let windows = true
  let launcher: ((request: AgentLaunchRequest) => Promise<AgentLaunchResult>) | null = null
  let open: () => void = () => undefined
  const gate = new Promise<void>((resolve) => {
    open = resolve
  })
  const safeStorage = fakeSafeStorage()
  const shellBridge = createInProcessShellBridge({
    safeStorage,
    launchAgent: () => launcher,
    reveal: (target) => {
      if (!windows) return false
      reveals.push(target)
      return true
    },
    notifier: { notify: (notice) => notices.push(notice) },
    analytics: (event) => events.push(event),
    integrationsReady: () => gate,
    imageCodec: textImageCodec,
  })
  return {
    bridge: shellBridge,
    shellBridge,
    notices,
    reveals,
    events,
    setWindows: (present) => {
      windows = present
    },
    setLauncher: (launch) => {
      launcher = launch
    },
    openIntegrations: () => open(),
    setEncryptionAvailable: (available) => safeStorage.setAvailable(available),
  }
}

/** A server's remote bridge, wired over a pair of control RPCs to a shell serving its own. */
function remoteHarness(): Harness & { serverRpc: ControlRpc; cutShell(): void } {
  const shell = shellHarness()
  let shellRpc: ControlRpc
  let connected = true
  const serverRpc: ControlRpc = createControlRpc((frame) => {
    // A structured clone, as a parent port delivers: bytes stay bytes.
    if (connected) setImmediate(() => shellRpc.receive(structuredClone(frame)))
  })
  shellRpc = createControlRpc((frame) => {
    if (connected) setImmediate(() => serverRpc.receive(structuredClone(frame)))
  })
  serveShellBridge(shellRpc, shell.shellBridge)
  return {
    ...shell,
    bridge: createRemoteShellBridge(serverRpc),
    serverRpc,
    cutShell() {
      connected = false
      serverRpc.close('The shell has gone.')
    },
  }
}

const settle = () => new Promise((resolve) => setImmediate(resolve)).then(() => new Promise((r) => setImmediate(r)))

for (const [name, make] of [
  ['in process', shellHarness],
  ['over the control channel', remoteHarness],
] as const) {
  describe(`ShellBridge ${name}`, () => {
    test('a secret seals to the keychain bytes and opens back', async () => {
      const harness = make()
      const sealed = await harness.bridge.cipher.seal(utf8Bytes('sk-test-key'))
      assert.deepEqual(
        Buffer.from(sealed),
        fakeSafeStorage().encryptString('sk-test-key'),
        'byte-identical to safeStorage',
      )
      assert.equal(utf8Text(await harness.bridge.cipher.open(sealed)), 'sk-test-key')
    })

    test('a ciphertext the keychain did not seal fails to open', async () => {
      const harness = make()
      await assert.rejects(harness.bridge.cipher.open(utf8Bytes('plain')), /not sealed by this keychain/)
    })

    test('the keychain says whether it can seal now', async () => {
      const harness = make()
      assert.equal(await harness.bridge.cipher.available(), true)
      harness.setEncryptionAvailable(false)
      assert.equal(await harness.bridge.cipher.available(), false)
    })

    test('a terminal launch with no terminals answers that it cannot, and goes through once there are', async () => {
      const harness = make()
      const refused = await harness.bridge.terminals.launchAgent({ workspaceId: 'ws-1' })
      assert.equal(refused.ok, false)
      assert.equal(!refused.ok && refused.code, 'shell_unavailable')
      harness.setLauncher(async (request) => ({
        ok: true,
        workspaceId: request.workspaceId,
        agentId: 'agent-1',
        sessionId: 'session-1',
        cli: 'claude',
        executionId: 'session-1',
      }))
      const launched = await harness.bridge.terminals.launchAgent({ workspaceId: 'ws-1', cli: 'claude' })
      assert.equal(launched.ok && launched.agentId, 'agent-1')
    })

    test('a reveal with no window answers false', async () => {
      const harness = make()
      harness.setWindows(false)
      assert.equal(await harness.bridge.reveal.tab({ kind: 'remote' }), false)
      harness.setWindows(true)
      assert.equal(await harness.bridge.reveal.tab({ kind: 'remote' }), true)
      assert.deepEqual(harness.reveals, [{ kind: 'remote' }])
    })

    test('a notice reaches the notification centre, and its click reveals what it names', async () => {
      const harness = make()
      harness.bridge.notify({
        key: 'pair:1',
        title: 'Pair request from mac-mini',
        body: 'Enter its code.',
        activate: { kind: 'remote' },
      })
      await settle()
      assert.equal(harness.notices.length, 1)
      assert.equal(harness.notices[0].title, 'Pair request from mac-mini')
      harness.notices[0].onActivate?.()
      assert.deepEqual(harness.reveals, [{ kind: 'remote' }])
    })

    test('a chat notice keeps its silence and the chat its click opens', async () => {
      const harness = make()
      harness.bridge.notify({
        key: 'chat:ws-1',
        title: 'Pricing page polish',
        body: 'Finished.',
        silent: true,
        activate: { kind: 'chat', chatId: 'ws-1', agentId: 'agent-1' },
      })
      await settle()
      assert.equal(harness.notices.length, 1)
      assert.equal(harness.notices[0].silent, true)
      harness.notices[0].onActivate?.()
      assert.deepEqual(harness.reveals, [{ kind: 'chat', chatId: 'ws-1', agentId: 'agent-1' }])
    })

    test('an analytics event goes to the shell, which holds consent', async () => {
      const harness = make()
      harness.bridge.analytics({ name: 'conversation.started', properties: { cli: 'claude' } })
      await settle()
      assert.deepEqual(harness.events, [{ name: 'conversation.started', properties: { cli: 'claude' } }])
    })

    test("a paired device's picture comes back sized for the model, and one the codec cannot read as it was", async () => {
      const harness = make()
      const shrunk = await harness.bridge.images.downscale(utf8Bytes('img:4032x3024'), 'image/jpeg')
      assert.deepEqual(
        { ...shrunk, bytes: utf8Text(shrunk.bytes) },
        { bytes: 'jpeg:1568x1176', mediaType: 'image/jpeg' },
      )
      const unread = await harness.bridge.images.downscale(utf8Bytes('not an image'), 'image/webp')
      assert.deepEqual({ ...unread, bytes: utf8Text(unread.bytes) }, { bytes: 'not an image', mediaType: 'image/webp' })
    })

    test('launches wait for the integrations gate', async () => {
      const harness = make()
      let open = false
      const waiting = harness.bridge.integrationsReady().then(() => {
        open = true
      })
      await settle()
      assert.equal(open, false)
      harness.openIntegrations()
      await waiting
      assert.equal(open, true)
    })
  })
}

describe('ShellBridge when the shell has gone', () => {
  test('a seal fails, a launch says so, a reveal is false, the integrations gate lets launches go, and a picture goes on unshrunk', async () => {
    const harness = remoteHarness()
    harness.cutShell()
    await assert.rejects(harness.bridge.cipher.seal(utf8Bytes('x')), /shell has gone/)
    assert.equal(await harness.bridge.cipher.available(), false)
    const launched = await harness.bridge.terminals.launchAgent({ workspaceId: 'ws-1' })
    assert.equal(!launched.ok && launched.code, 'shell_unavailable')
    assert.equal(await harness.bridge.reveal.tab({ kind: 'app' }), false)
    await harness.bridge.integrationsReady()
    const picture = await harness.bridge.images.downscale(utf8Bytes('img:4032x3024'), 'image/png')
    assert.equal(utf8Text(picture.bytes), 'img:4032x3024', 'a picture stays the size it was sent')
  })
})
