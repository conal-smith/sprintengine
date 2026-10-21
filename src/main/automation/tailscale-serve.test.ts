import assert from 'node:assert/strict'

import {
  allocateServePort,
  buildServeUrl,
  classifyServeStderr,
  describeServeDiagnostic,
  parseServedPorts,
  readSelfDnsName,
  SERVE_PORT_LADDER,
  shareLocalPort,
  unshareServePort,
  type TailscaleServeDiagnostic,
} from './tailnet/tailscale-serve'
import type { TailscaleRun } from './tailnet/tailscale-cli'
import { test } from 'vitest'

test('tailscale-serve', async () => {
  // Publishing a loopback dev server on the tailnet (Track 1). Three boundaries
  // are worth pinning, because all three are places where something outside this
  // app becomes something inside it:
  //
  //  1. Tailscale's stderr. It is the only thing that explains a failure, and it
  //     is also where auth keys live. The classification must be specific enough
  //     to act on and must never let the text through.
  //  2. `tailscale serve status --json` — the shape is Tailscale's, so our
  //     reading of it is the only thing we can test.
  //  3. Port allocation, which decides whether sharing the same server twice
  //     quietly eats the ladder.

  let failures = 0
  let queue: Promise<void> = Promise.resolve()

  function check(name: string, run: () => void | Promise<void>): void {
    queue = queue.then(async () => {
      try {
        await run()
        console.log(`ok - ${name}`)
      } catch (error) {
        failures++
        console.error(`not ok - ${name}`)
        console.error(error)
      }
    })
  }

  const STATUS_JSON = JSON.stringify({
    BackendState: 'Running',
    Self: {
      ID: 'self',
      DNSName: 'studio-mac.tail1a2b.ts.net.',
      HostName: 'studio-mac',
      TailscaleIPs: ['100.101.102.103'],
    },
    Peer: {},
  })

  const okRun = (): Promise<TailscaleRun> => Promise.resolve({ ok: true, stdout: '' })
  const failRun =
    (stderr: string, timedOut = false): (() => Promise<TailscaleRun>) =>
    () =>
      Promise.resolve({ ok: false, stdout: '', stderr, timedOut })

  check('stderr classifies into the diagnostics a person can act on', () => {
    assert.equal(
      classifyServeStderr('error: HTTPS is not enabled on your tailnet; see https://tailscale.com/s/https'),
      'https-not-enabled',
    )
    assert.equal(classifyServeStderr('not logged in, run tailscale up'), 'not-logged-in')
    assert.equal(classifyServeStderr('permission denied'), 'permission-denied')
    assert.equal(classifyServeStderr('listen tcp :8443: address already in use'), 'port-unavailable')
    assert.equal(classifyServeStderr('serve: handler does not exist'), 'no-existing-handler')
    assert.equal(classifyServeStderr('failed to connect to local tailscaled'), 'unavailable')
    assert.equal(classifyServeStderr('something nobody has seen before'), 'unknown')
  })

  check('no diagnostic message ever echoes Tailscale stderr', () => {
    // The rule that must not be relaxed: stderr carries `tskey-…` auth keys, node
    // names and tailnet names, and these messages reach logs and the renderer. A
    // message is chosen BY LABEL, so a secret in stderr has no path into one.
    const secret = 'tskey-auth-kW8sN3CNTRL-9fKq2LmXp node=studio-mac.tail1a2b.ts.net'
    const diagnostics: TailscaleServeDiagnostic[] = [
      'unavailable',
      'not-logged-in',
      'https-not-enabled',
      'permission-denied',
      'port-unavailable',
      'no-existing-handler',
      'timeout',
      'unknown',
    ]
    for (const diagnostic of diagnostics) {
      const message = describeServeDiagnostic(diagnostic)
      assert.ok(message.length > 0, `${diagnostic} has a message`)
      assert.ok(!message.includes('tskey'), `${diagnostic} leaks no auth key`)
      assert.ok(!message.includes(secret), `${diagnostic} leaks no stderr`)
    }
  })

  check('a failed share reports the reason and never the raw text', async () => {
    const result = await shareLocalPort(
      { localPort: 5173, servePort: 8443 },
      {
        read: async () => STATUS_JSON,
        run: failRun('tskey-auth-SECRET: HTTPS is not enabled on your tailnet'),
      },
    )
    assert.equal(result.ok, false)
    if (result.ok) return
    assert.equal(result.diagnostic, 'https-not-enabled')
    assert.ok(!result.message.includes('tskey'), 'the failure message carries no auth key')
  })

  check('a timeout is a timeout, not a misread stderr', async () => {
    const result = await shareLocalPort(
      { localPort: 5173, servePort: 8443 },
      { read: async () => STATUS_JSON, run: failRun('permission denied', true) },
    )
    assert.equal(result.ok, false)
    if (result.ok) return
    // `killed` wins over the text: a child killed at the deadline may have
    // written anything on its way out.
    assert.equal(result.diagnostic, 'timeout')
  })

  check('a share publishes the machine name Tailscale reports', async () => {
    const args: string[][] = []
    const result = await shareLocalPort(
      { localPort: 5173, servePort: 8443 },
      {
        read: async () => STATUS_JSON,
        run: async (called) => {
          args.push([...called])
          return { ok: true, stdout: '' }
        },
      },
    )
    assert.equal(result.ok, true)
    if (!result.ok) return
    assert.equal(result.share.url, 'https://studio-mac.tail1a2b.ts.net:8443/')
    assert.equal(result.share.localPort, 5173)
    // `--bg` is what makes the mapping outlive this process; the proxy target
    // stays loopback so the dev server is never asked to rebind, and is
    // `localhost` so a server listening on `::1` alone is reached as well.
    assert.deepEqual(args[0], ['serve', '--bg', '--https=8443', 'http://localhost:5173'])
  })

  check('no tailnet means no share, and it says so', async () => {
    const result = await shareLocalPort({ localPort: 5173, servePort: 8443 }, { read: async () => null, run: okRun })
    assert.equal(result.ok, false)
    if (result.ok) return
    assert.equal(result.diagnostic, 'unavailable')
  })

  check('the self name is null unless the backend is actually running', async () => {
    const stopped = JSON.stringify({ BackendState: 'Stopped', Self: { ID: 'self', DNSName: 'x.ts.net.' }, Peer: {} })
    assert.equal(await readSelfDnsName({ read: async () => stopped }), null)
    assert.equal(await readSelfDnsName({ read: async () => STATUS_JSON }), 'studio-mac.tail1a2b.ts.net')
  })

  check('443 has no port in the URL, other ports do', () => {
    assert.equal(buildServeUrl('studio-mac.tail1a2b.ts.net', 443), 'https://studio-mac.tail1a2b.ts.net/')
    assert.equal(buildServeUrl('studio-mac.tail1a2b.ts.net', 8443), 'https://studio-mac.tail1a2b.ts.net:8443/')
  })

  check('serve status is read back as port pairs', () => {
    const raw = JSON.stringify({
      TCP: { '8443': { HTTPS: true } },
      Web: {
        'studio-mac.tail1a2b.ts.net:8443': { Handlers: { '/': { Proxy: 'http://127.0.0.1:5173' } } },
        'studio-mac.tail1a2b.ts.net:10000': { Handlers: { '/': { Proxy: 'http://localhost:3000' } } },
      },
    })
    const served = parseServedPorts(raw)
    assert.equal(served.get(8443), 5173)
    assert.equal(served.get(10000), 3000)
  })

  check('someone else’s serve config is left alone', () => {
    // A handler that is not a root loopback proxy is not ours to report or reuse:
    // a text mount, a path mount, or a proxy off-machine all belong to whoever
    // configured them on the command line.
    const raw = JSON.stringify({
      Web: {
        'studio-mac.tail1a2b.ts.net:443': { Handlers: { '/': { Text: 'hello' } } },
        'studio-mac.tail1a2b.ts.net:8444': { Handlers: { '/app': { Proxy: 'http://127.0.0.1:4000' } } },
        'studio-mac.tail1a2b.ts.net:8445': { Handlers: { '/': { Proxy: 'http://192.168.1.20:8080' } } },
      },
    })
    assert.equal(parseServedPorts(raw).size, 0)
  })

  check('unreadable serve status is an empty map, never a throw', () => {
    assert.equal(parseServedPorts('not json').size, 0)
    assert.equal(parseServedPorts('{}').size, 0)
    assert.equal(parseServedPorts('[]').size, 0)
  })

  check('sharing the same dev server twice reuses its port', () => {
    const served = new Map([[8443, 5173]])
    assert.equal(allocateServePort(served, 5173), 8443)
  })

  check('a new dev server takes the next free ladder port', () => {
    assert.equal(allocateServePort(new Map(), 5173), SERVE_PORT_LADDER[0])
    assert.equal(allocateServePort(new Map([[8443, 3000]]), 5173), SERVE_PORT_LADDER[1])
  })

  check('a full ladder refuses rather than colliding', () => {
    const served = new Map(SERVE_PORT_LADDER.map((port, index) => [port, 3000 + index]))
    assert.equal(allocateServePort(served, 5173), null)
  })

  check('443 is never handed to a dev server', () => {
    // The tailnet's front door belongs to the Studio gateway, not to whichever
    // dev server was shared first.
    assert.ok(!SERVE_PORT_LADDER.includes(443))
  })

  check('turning off a port that was already off is success', async () => {
    const result = await unshareServePort({ servePort: 8443 }, { run: failRun('serve: handler does not exist') })
    assert.equal(result.ok, true)
  })

  check('a real unshare failure is still a failure', async () => {
    const result = await unshareServePort({ servePort: 8443 }, { run: failRun('permission denied') })
    assert.equal(result.ok, false)
  })

  const suiteRun = queue.then(() => {
    if (failures > 0) {
      console.error(`${failures} test(s) failed`)
      process.exit(1)
    }
    console.log('tailscale serve tests passed')
  })

  await suiteRun
})

// A tailnet that never turned Serve on: `tailscale serve` prints where to
// enable it on stdout and then waits for someone to, until it is killed at the
// deadline. The reason it printed is the one a person can act on.
const SERVE_OFF_STDOUT =
  '\nServe is not enabled on your tailnet.\nTo enable, visit:\n\n         https://login.tailscale.com/f/serve?node=nAbC123CNTRL\n\nWaiting for enablement...'

function shareWith(run: TailscaleRun): ReturnType<typeof shareLocalPort> {
  const status = JSON.stringify({
    BackendState: 'Running',
    Self: { ID: 'self', DNSName: 'mac-mini.tail1234.ts.net.', HostName: 'mac-mini', TailscaleIPs: ['100.101.102.103'] },
    Peer: {},
  })
  return shareLocalPort({ localPort: 5173, servePort: 8443 }, { read: async () => status, run: async () => run })
}

test('a share on a tailnet without Serve says HTTPS is off, not that Tailscale did not answer', async () => {
  const result = await shareWith({ ok: false, stdout: SERVE_OFF_STDOUT, stderr: '', timedOut: true })
  assert.equal(result.ok, false)
  if (result.ok) return
  assert.equal(result.diagnostic, 'https-not-enabled')
  assert.equal(result.message, describeServeDiagnostic('https-not-enabled'))
})

test('a share Serve refused at once on stdout is classified by what it printed', async () => {
  const result = await shareWith({ ok: false, stdout: SERVE_OFF_STDOUT, stderr: '', timedOut: false })
  assert.equal(result.ok, false)
  if (result.ok) return
  assert.equal(result.diagnostic, 'https-not-enabled')
})

test('a share that timed out after printing anything else is still a timeout', async () => {
  const result = await shareWith({ ok: false, stdout: 'starting…', stderr: 'permission denied', timedOut: true })
  assert.equal(result.ok, false)
  if (result.ok) return
  assert.equal(result.diagnostic, 'timeout')
})

test('the enable-Serve wording classifies as HTTPS not enabled', () => {
  assert.equal(classifyServeStderr(SERVE_OFF_STDOUT), 'https-not-enabled')
})
