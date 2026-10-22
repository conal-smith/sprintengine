import assert from 'node:assert/strict'

import { JSDOM } from 'jsdom'

// jsdom globals must exist before React mounts
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'

import { ToastHost } from './ToastHost'
import { useToastStore } from '../../store/toastStore'
import { test } from 'vitest'

test('ToastHost', async () => {
  // The toast host's event bridges (remote-sessions-ux / toast-host-region +
  // incoming-pair-request-prompt), mounted for real: the pair-request toast is
  // ANSWERED where it arrives (owner ruling 2026-09-05) — a code field and two
  // answers, never the code itself, no pointer to another surface — and is
  // RETRACTED when the request resolves from anywhere, while one the person
  // dismissed stays dismissed.

  const dom = new JSDOM('<!doctype html><html><body></body></html>', {
    url: 'http://localhost',
    pretendToBeVisual: true,
  })
  const anyGlobal = globalThis as unknown as Record<string, unknown>
  anyGlobal.window = dom.window
  anyGlobal.document = dom.window.document
  anyGlobal.HTMLElement = dom.window.HTMLElement
  // React's controlled-input change detection needs the real constructors on
  // the global, or a synthetic `input` event never reaches onChange.
  anyGlobal.HTMLInputElement = dom.window.HTMLInputElement
  anyGlobal.HTMLButtonElement = dom.window.HTMLButtonElement
  anyGlobal.Node = dom.window.Node
  // React DOM's legacy change-event polyfill (it decided at load that no DOM
  // existed) watches the focused element through IE's attachEvent/detachEvent;
  // jsdom has neither, so `typeInto` needs them as no-ops. Same shim as
  // RemotePopover.test.tsx.
  const inputProto = dom.window.HTMLInputElement.prototype as unknown as Record<string, unknown>
  inputProto.attachEvent = () => {}
  inputProto.detachEvent = () => {}
  anyGlobal.IS_REACT_ACT_ENVIRONMENT = true

  type Handler<T> = (payload: T) => void
  const tailnetHandlers: Array<Handler<unknown>> = []
  const meshHandlers: Array<Handler<unknown>> = []
  const bridge = {
    approveCalls: [] as Array<{ id: string; scopes: string[]; code: string }>,
    denyCalls: [] as string[],
  }
  ;(dom.window as unknown as { api: unknown }).api = {
    onTailnetEvent: (cb: Handler<unknown>) => {
      tailnetHandlers.push(cb)
      return () => tailnetHandlers.splice(tailnetHandlers.indexOf(cb), 1)
    },
    onMeshEvent: (cb: Handler<unknown>) => {
      meshHandlers.push(cb)
      return () => meshHandlers.splice(meshHandlers.indexOf(cb), 1)
    },
    tailnetApprovePairRequest: (id: string, scopes: string[], code: string) => {
      bridge.approveCalls.push({ id, scopes, code })
      return Promise.resolve({ ok: true })
    },
    tailnetDenyPairRequest: (id: string) => {
      bridge.denyCalls.push(id)
      return Promise.resolve({})
    },
  }

  let failures = 0
  function run(name: string, fn: () => void): void {
    try {
      fn()
      console.log(`ok - ${name}`)
    } catch (error) {
      failures += 1
      console.error(`not ok - ${name}`)
      console.error(error)
    }
  }
  // The answer-in-place tests click through IPC promises; they queue behind the
  // synchronous ones rather than interleaving with them.
  let queue: Promise<void> = Promise.resolve()
  function runAsync(name: string, fn: () => Promise<void>): void {
    queue = queue
      .then(async () => {
        await fn()
        console.log(`ok - ${name}`)
      })
      .catch((error) => {
        failures += 1
        console.error(`not ok - ${name}`)
        console.error(error)
      })
  }

  let revision = 0
  function pairEvent(
    phase: 'received' | 'approved' | 'denied' | 'expired' | 'cancelled',
    requestId = 'req1',
    peerNode: string | null = null,
  ): unknown {
    // The push payload carries the status the event happened to, and the toast
    // reads the waiting request out of it — the body cannot be drawn from the
    // event alone.
    const waiting = {
      id: requestId,
      deviceName: 'macbook-air',
      peerNode,
      peerAddress: '100.4.4.4',
      createdAt: new Date().toISOString(),
      expiresAt: new Date(Date.now() + 4 * 60_000).toISOString(),
    }
    return {
      revision: ++revision,
      event: { kind: 'pair-request', phase, requestId, deviceName: 'macbook-air', peerNode },
      status: { pairRequests: phase === 'received' ? [waiting] : [] },
      live: { revision, devices: [] },
    }
  }
  async function typeInto(input: Element | null, value: string): Promise<void> {
    assert.ok(input instanceof dom.window.HTMLInputElement, 'the code field exists')
    const field = input as HTMLInputElement
    await act(async () => {
      field.dispatchEvent(new dom.window.FocusEvent('focusin', { bubbles: true }))
      const setter = Object.getOwnPropertyDescriptor(dom.window.HTMLInputElement.prototype, 'value')?.set
      setter?.call(field, value)
      field.dispatchEvent(new dom.window.Event('input', { bubbles: true }))
      field.dispatchEvent(new dom.window.KeyboardEvent('keyup', { bubbles: true }))
    })
  }
  function buttonNamed(mounted: HTMLElement, text: RegExp): HTMLButtonElement | null {
    return [...mounted.querySelectorAll('button')].find((button) => text.test(button.textContent ?? '')) ?? null
  }
  function click(element: Element | null): void {
    assert.ok(element, 'the element to click exists')
    act(() => {
      element.dispatchEvent(new dom.window.MouseEvent('click', { bubbles: true }))
    })
  }
  async function flush(): Promise<void> {
    await act(async () => {
      await Promise.resolve()
      await Promise.resolve()
    })
  }

  function meshEvent(body: Record<string, unknown>): unknown {
    return { revision: ++revision, ...body }
  }
  function fireMesh(payload: unknown): void {
    act(() => {
      for (const handler of [...meshHandlers]) handler(payload)
    })
  }
  function titles(): string[] {
    return useToastStore.getState().toasts.map((toast) => toast.title)
  }

  let root: Root | null = null
  let host: HTMLElement | null = null
  function mount(): HTMLElement {
    const created = dom.window.document.createElement('div')
    host = created
    dom.window.document.body.appendChild(created)
    act(() => {
      root = createRoot(created)
      root.render(<ToastHost />)
    })
    return created
  }
  function unmount(): void {
    act(() => root?.unmount())
    host?.remove()
    root = null
    host = null
  }
  function fireTailnet(payload: unknown): void {
    act(() => {
      for (const handler of [...tailnetHandlers]) handler(payload)
    })
  }
  function reset(): void {
    act(() => {
      useToastStore.setState({ toasts: [] })
    })
  }

  run(
    'a pair request arrives as a persistent warn toast that can be answered in place, without showing the code',
    () => {
      reset()
      const mounted = mount()
      fireTailnet(pairEvent('received'))
      assert.match(mounted.innerHTML, /Pair request from macbook-air/)
      assert.match(mounted.innerHTML, /role="alert"/, 'warn interrupts and persists')
      assert.doesNotMatch(mounted.innerHTML, /481972/, 'the comparison code is typed here, never shown')
      assert.ok(mounted.querySelector('input[inputmode="numeric"]'), 'the code field is on the toast')
      assert.ok(buttonNamed(mounted, /^Allow/)?.disabled, 'Allow is dead until six digits are typed')
      assert.ok(buttonNamed(mounted, /^Decline/), 'and the request can be refused from here')
      assert.doesNotMatch(mounted.innerHTML, /Remote glyph|Settings/, 'no pointer elsewhere — this surface answers')
      unmount()
    },
  )

  run('the same request announced twice is one toast', () => {
    reset()
    const mounted = mount()
    fireTailnet(pairEvent('received'))
    fireTailnet(pairEvent('received'))
    assert.equal(useToastStore.getState().toasts.length, 1)
    unmount()
    void mounted
  })

  run('the toast names the transport-proven node, shortened, and says nothing else about it', () => {
    reset()
    const mounted = mount()
    fireTailnet(pairEvent('received', 'req-named', 'sam-macbook-air.tailabc123.ts.net'))
    assert.match(mounted.innerHTML, /Pair request from sam-macbook-air<|Pair request from sam-macbook-air\b/)
    assert.doesNotMatch(mounted.innerHTML, /tailabc123/, 'the tailnet tail is the same on every machine — not a name')
    assert.doesNotMatch(
      mounted.innerHTML,
      /Calls itself/,
      'the second identity belongs on the card, not the announcement',
    )
    unmount()
  })

  runAsync('typing the code and pressing Allow answers from the toast, granting the defaults', async () => {
    reset()
    bridge.approveCalls.length = 0
    const mounted = mount()
    fireTailnet(pairEvent('received', 'req-answer', 'sam-macbook-air'))
    assert.match(mounted.innerHTML, /Type the code it is showing\./, 'the help line asks for the code')
    await typeInto(mounted.querySelector('input[inputmode="numeric"]'), '48 19 72')
    click(buttonNamed(mounted, /^Allow/))
    await flush()
    assert.equal(bridge.approveCalls.length, 1, 'one approval')
    assert.equal(bridge.approveCalls[0]?.id, 'req-answer')
    assert.equal(bridge.approveCalls[0]?.code, '481972', 'digits only, six at most')
    assert.ok(bridge.approveCalls[0]?.scopes.includes('workspace:operate'), 'the default families are granted')
    unmount()
  })

  runAsync('Decline from the toast refuses the request main is holding', async () => {
    reset()
    bridge.denyCalls.length = 0
    const mounted = mount()
    fireTailnet(pairEvent('received', 'req-no', 'sam-macbook-air'))
    click(buttonNamed(mounted, /^Decline/))
    await flush()
    assert.deepEqual(bridge.denyCalls, ['req-no'])
    unmount()
  })

  for (const phase of ['approved', 'denied', 'expired', 'cancelled'] as const) {
    run(`every terminal phase retracts the standing toast — ${phase}`, () => {
      reset()
      const mounted = mount()
      fireTailnet(pairEvent('received', `req-${phase}`))
      assert.match(mounted.innerHTML, /Pair request/)
      fireTailnet(pairEvent(phase, `req-${phase}`))
      assert.equal(mounted.innerHTML, '', 'the invitation to review a request that no longer exists is gone')
      unmount()
    })
  }

  run('the toast’s id is the request’s, so a retraction can never orphan', () => {
    reset()
    mount()
    fireTailnet(pairEvent('received', 'req-id'))
    assert.deepEqual(
      useToastStore.getState().toasts.map((toast) => toast.id),
      ['pair-request:req-id'],
    )
    unmount()
  })

  run('a toast the person dismissed stays dismissed — resolution does not resurrect it', () => {
    reset()
    const mounted = mount()
    fireTailnet(pairEvent('received'))
    act(() => {
      const id = useToastStore.getState().toasts[0]?.id
      if (id) useToastStore.getState().dismissToast(id)
    })
    fireTailnet(pairEvent('expired'))
    assert.equal(useToastStore.getState().toasts.length, 0)
    assert.equal(mounted.innerHTML, '')
    unmount()
  })

  run('the listener falling over is announced, retracted on recovery, and a requested stop is silent', () => {
    reset()
    const mounted = mount()
    const listener = (running: boolean, error: string | null = null): unknown => ({
      revision: ++revision,
      event: { kind: 'listener', running, error },
      status: { pairRequests: [] },
      live: { revision, devices: [] },
    })

    fireTailnet(listener(false, null))
    assert.equal(titles().length, 0, 'someone turning remote off is not news')

    fireTailnet(listener(false, 'Tailnet remote control stopped: Tailscale is no longer up on this machine.'))
    assert.deepEqual(titles(), ['Remote stopped serving'])
    assert.match(mounted.innerHTML, /Tailscale is no longer up/, 'in main’s own words')
    assert.match(mounted.innerHTML, /role="alert"/, 'warn persists — the phone is not coming back on its own')

    // The interface heartbeat keeps beating; a repeat is not a second toast.
    fireTailnet(listener(false, 'Tailnet remote control stopped: Tailscale is no longer up on this machine.'))
    assert.equal(titles().length, 1)

    fireTailnet(listener(true))
    assert.deepEqual(titles(), ['Remote is serving again'], 'the loss is retracted and the recovery announced')
    assert.doesNotMatch(mounted.innerHTML, /stopped serving/)

    // Recovery is only news after a loss.
    reset()
    fireTailnet(listener(true))
    assert.equal(titles().length, 0)
    unmount()
  })

  // ── the mesh bridge ─────────────────────────────────────────────────────

  run('a machine paired announces good; a machine removed announces neutral', () => {
    reset()
    const mounted = mount()
    fireMesh(meshEvent({ kind: 'machine-paired', connection: { id: 'c1', machineName: 'Air' } }))
    assert.match(mounted.innerHTML, /Machine paired/)
    assert.match(mounted.innerHTML, /Air is in your mesh/)
    assert.ok(mounted.querySelector('[role="status"]'), 'good is polite')
    fireMesh(meshEvent({ kind: 'machine-forgotten', connectionId: 'c1', machineName: 'Air' }))
    assert.match(mounted.innerHTML, /Machine removed/)
    assert.match(mounted.innerHTML, /Air was removed from your mesh/)
    unmount()
  })

  const suiteRun = queue.then(() => {
    if (failures > 0) {
      console.error(`ToastHost.test.tsx: ${failures} failing`)
      process.exit(1)
    }
    console.log('ToastHost.test.tsx: ok')
  })

  await suiteRun
})
