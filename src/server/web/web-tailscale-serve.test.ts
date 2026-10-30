import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, expect, test } from 'vitest'

import type { TailscaleRun } from '../../main/automation/tailnet/tailscale-cli'
import type { TailscaleServeDeps } from '../../main/automation/tailnet/tailscale-serve'
import { checkTailscaleServePort, serveWebOnTailnet } from './web-tailscale-serve'

// The web client on the tailnet through `tailscale serve` (R19; phase 9 spec,
// 6.6), against a stand-in for tailscaled that keeps its serve table.

let runDir: string
beforeEach(() => {
  runDir = mkdtempSync(join(tmpdir(), 'web-tailscale-'))
})
afterEach(() => rmSync(runDir, { recursive: true, force: true }))

function fakeTailscale(initial: Record<number, string> = {}) {
  const table = new Map<number, string>(Object.entries(initial).map(([port, target]) => [Number(port), target]))
  const calls: string[] = []
  const status = JSON.stringify({
    BackendState: 'Running',
    Self: { ID: 'self', HostName: 'mac-mini', DNSName: 'mac-mini.tail1234.ts.net.', TailscaleIPs: ['100.64.0.1'] },
    Peer: {},
  })
  const serveStatus = () =>
    JSON.stringify({
      Web: Object.fromEntries(
        [...table].map(([port, target]) => [
          `mac-mini.tail1234.ts.net:${port}`,
          { Handlers: { '/': { Proxy: target } } },
        ]),
      ),
    })
  const deps: TailscaleServeDeps = {
    read: async (args) => {
      calls.push(args.join(' '))
      if (args[0] === 'status') return status
      if (args[0] === 'serve' && args[1] === 'status') return serveStatus()
      return null
    },
    run: async (args): Promise<TailscaleRun> => {
      calls.push(args.join(' '))
      const https = args.find((arg) => arg.startsWith('--https='))
      const port = Number(https?.slice('--https='.length))
      if (args.at(-1) === 'off') {
        if (!table.delete(port))
          return { ok: false, stdout: '', stderr: 'error: handler does not exist', timedOut: false }
      } else table.set(port, args.at(-1)!)
      return { ok: true, stdout: '' }
    },
  }
  return { deps, table, calls }
}

test('publishes the loopback listener over HTTPS and takes it back on stop', async () => {
  const daemon = fakeTailscale()
  const serve = await serveWebOnTailnet({ localPort: 4791, servePort: 443, runDir, deps: daemon.deps })
  expect(serve.origin).toBe('https://mac-mini.tail1234.ts.net')
  // Serve proxies to loopback; nothing is ever published as plain HTTP.
  expect(daemon.calls).toContain('serve --bg --https=443 http://127.0.0.1:4791')
  expect(daemon.calls.some((call) => /--http=|--tcp=|funnel/u.test(call))).toBe(false)
  expect(JSON.parse(readFileSync(join(runDir, 'web-tailscale.json'), 'utf8'))).toEqual({
    servePort: 443,
    localPort: 4791,
  })
  await serve.stop()
  expect(daemon.table.has(443)).toBe(false)
})

test('a port serving something else is left alone, and the server does not start', async () => {
  const daemon = fakeTailscale({ 443: 'http://127.0.0.1:3000' })
  await expect(serveWebOnTailnet({ localPort: 4791, servePort: 443, runDir, deps: daemon.deps })).rejects.toThrow(
    /already serves something else on HTTPS port 443/u,
  )
  expect(daemon.table.get(443)).toBe('http://127.0.0.1:3000')
})

test("this server's own mapping from a crashed run is replaced", async () => {
  const first = fakeTailscale()
  await serveWebOnTailnet({ localPort: 4791, servePort: 443, runDir, deps: first.deps })
  // The run died without stopping; the next run's listener is on another port.
  const daemon = fakeTailscale({ 443: 'http://127.0.0.1:4791' })
  const serve = await serveWebOnTailnet({ localPort: 4792, servePort: 443, runDir, deps: daemon.deps })
  expect(daemon.table.get(443)).toBe('http://127.0.0.1:4792')
  expect(serve.origin).toBe('https://mac-mini.tail1234.ts.net')
})

test('a mapping someone moved since is not turned off on stop', async () => {
  const daemon = fakeTailscale()
  const serve = await serveWebOnTailnet({ localPort: 4791, servePort: 9443, runDir, deps: daemon.deps })
  expect(serve.origin).toBe('https://mac-mini.tail1234.ts.net:9443')
  daemon.table.set(9443, 'http://127.0.0.1:5000')
  await serve.stop()
  expect(daemon.table.get(9443)).toBe('http://127.0.0.1:5000')
})

test("the dev-server shares' ports are refused for the web client", () => {
  expect(checkTailscaleServePort(443)).toBeNull()
  expect(checkTailscaleServePort(8443)).toMatch(/shares dev servers on/u)
  expect(checkTailscaleServePort(70000)).toMatch(/port number/u)
})

function serveStatusWith(port: number, extra: Record<string, unknown>) {
  return {
    async read(args: readonly string[]) {
      if (args[0] === 'status')
        return JSON.stringify({
          BackendState: 'Running',
          Self: {
            ID: 'self',
            HostName: 'mac-mini',
            DNSName: 'mac-mini.tail1234.ts.net.',
            TailscaleIPs: ['100.64.0.1'],
          },
          Peer: {},
        })
      if (args[0] === 'serve') return JSON.stringify(extra)
      return null
    },
    runs: [] as string[],
    async run(args: readonly string[]): Promise<TailscaleRun> {
      this.runs.push(args.join(' '))
      return { ok: true, stdout: '' }
    },
    port,
  }
}

test('a port whose serve config holds more than one root proxy is never written to', async () => {
  const host = 'mac-mini.tail1234.ts.net:443'
  for (const config of [
    // A handler on a path: `serve --https=443 <target>` would keep it, and `off` would clear it.
    { TCP: { 443: { HTTPS: true } }, Web: { [host]: { Handlers: { '/docs': { Path: '/srv/docs' } } } } },
    // A root that is not a loopback proxy.
    { TCP: { 443: { HTTPS: true } }, Web: { [host]: { Handlers: { '/': { Proxy: 'http://192.168.1.20:80' } } } } },
    // A raw TCP forward on the port.
    { TCP: { 443: { TCPForward: '127.0.0.1:22' } } },
    // A foreground session's config.
    { Foreground: { s1: { Web: { [host]: { Handlers: { '/': { Text: 'hi' } } } } } } },
  ]) {
    const daemon = serveStatusWith(443, config)
    await expect(
      serveWebOnTailnet({ localPort: 4791, servePort: 443, runDir, deps: daemon as unknown as TailscaleServeDeps }),
    ).rejects.toThrow(/already serves something else/u)
    expect(daemon.runs).toEqual([])
  }
})

test('a port with funnel on is refused: Studio is never on the internet', async () => {
  const host = 'mac-mini.tail1234.ts.net:443'
  const daemon = serveStatusWith(443, { AllowFunnel: { [host]: true } })
  await expect(
    serveWebOnTailnet({ localPort: 4791, servePort: 443, runDir, deps: daemon as unknown as TailscaleServeDeps }),
  ).rejects.toThrow(/funnel is on/u)
  expect(daemon.runs).toEqual([])
})

test('the port is left on at stop when someone added to it since', async () => {
  const daemon = fakeTailscale()
  const serve = await serveWebOnTailnet({ localPort: 4791, servePort: 443, runDir, deps: daemon.deps })
  const read = daemon.deps.read!
  daemon.deps.read = async (args, timeoutMs) => {
    if (args[0] === 'serve' && args[1] === 'status')
      return JSON.stringify({
        Web: {
          'mac-mini.tail1234.ts.net:443': {
            Handlers: { '/': { Proxy: 'http://127.0.0.1:4791' }, '/docs': { Path: '/srv/docs' } },
          },
        },
      })
    return read(args, timeoutMs)
  }
  await serve.stop()
  expect(daemon.calls.some((call) => call.endsWith('off'))).toBe(false)
})
