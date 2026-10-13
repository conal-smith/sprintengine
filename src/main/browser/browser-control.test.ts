import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'

import type { WebContents } from 'electron'
import { CONSOLE_BUFFER_MAX, createBrowserControl, parseKeyChord } from './browser-control'
import type { BrowserDownload } from './browser-manager'
import { test } from 'vitest'

test('browser-control', async () => {
  function run(name: string, body: () => Promise<void> | void): Promise<void> {
    return Promise.resolve()
      .then(body)
      .then(() => console.log(`ok - ${name}`))
      .catch((error) => {
        console.error(`not ok - ${name}`)
        throw error
      })
  }

  // A guest WebContents reduced to what the control layer touches: an in-process
  // debugger with attach/detach/sendCommand and its event stream.
  class FakeDebugger extends EventEmitter {
    attached = false
    commands: Array<{ method: string; params: Record<string, unknown> | undefined }> = []
    respond: (method: string, params: Record<string, unknown> | undefined) => unknown = () => ({})
    isAttached() {
      return this.attached
    }
    attach() {
      if (this.attached) throw new Error('Debugger is already attached')
      this.attached = true
    }
    detach() {
      this.attached = false
      this.emit('detach', {}, 'target closed')
    }
    async sendCommand(method: string, params?: Record<string, unknown>) {
      this.commands.push({ method, params })
      return this.respond(method, params)
    }
  }

  class FakeWebContents extends EventEmitter {
    debugger = new FakeDebugger()
    destroyed = false
    devTools = false
    isDestroyed() {
      return this.destroyed
    }
    isDevToolsOpened() {
      return this.devTools
    }
  }

  function fixture() {
    const wc = new FakeWebContents()
    let epoch = 0
    let inputDepth = 0
    const badges: string[] = []
    const inputDepths: number[] = []
    const control = createBrowserControl({
      webContentsOf: (tabId) => (tabId === 't1' ? (wc as unknown as WebContents) : null),
      epochOf: () => epoch,
      noteAgentActivity: (tabId) => {
        badges.push(tabId)
      },
      noteAgentInput: (_tabId, delta) => {
        inputDepth += delta
        inputDepths.push(inputDepth)
      },
      onHumanInput: (listener) => {
        humanListeners.push(listener)
        return () => {}
      },
      onDownload: () => () => {},
      notePointer: (event) => {
        log.push(`pointer:${event.kind}@${event.x},${event.y}`)
      },
    })
    const original = wc.debugger.sendCommand.bind(wc.debugger)
    wc.debugger.sendCommand = async (method, params) => {
      if (method === 'Input.dispatchMouseEvent') log.push(`dispatch:${String(params?.type)}`)
      return original(method, params)
    }
    return {
      wc,
      control,
      badges,
      inputDepths,
      log,
      bump: () => (epoch += 1),
      human: () => {
        epoch += 1
        for (const listener of humanListeners) listener('t1')
      },
    }
  }
  const humanListeners: Array<(tabId: string) => void> = []
  const log: string[] = []

  function evaluation(value: unknown) {
    return { result: { type: typeof value, value } }
  }

  async function main(): Promise<void> {
    await run(
      'a dialog the page opens is reported at once, holds every action, and is answered by browser.dialog',
      async () => {
        const { wc, control } = fixture()
        // A click that makes the page open an alert: the click's own dispatch
        // never returns while the alert holds the page.
        wc.debugger.respond = (method, params) => {
          if (method === 'Runtime.evaluate') return evaluation({ x: 10, y: 10 })
          if (method === 'Input.dispatchMouseEvent' && params?.type === 'mousePressed') {
            wc.debugger.emit('message', {}, 'Page.javascriptDialogOpening', {
              type: 'confirm',
              message: 'Discard your changes?',
              url: 'http://localhost:5173/',
            })
            return new Promise(() => undefined)
          }
          return {}
        }
        const clicked = await control.click('t1', { ref: 'e1' })
        assert.equal(clicked.ok ? null : clicked.code, 'dialog_open')
        assert.match(clicked.ok ? '' : clicked.message, /confirm dialog: "Discard your changes\?"/)
        // Everything that needs the page waits for the answer.
        const snapshot = await control.snapshot('t1')
        assert.equal(snapshot.ok ? null : snapshot.code, 'dialog_open')
        // The buffers do not need the page.
        assert.equal((await control.console('t1')).ok, true)
        const answered = await control.dialog('t1', { accept: false })
        assert.deepEqual(answered.ok && [answered.answered.type, answered.accepted], ['confirm', false])
        assert.deepEqual(wc.debugger.commands.at(-1), {
          method: 'Page.handleJavaScriptDialog',
          params: { accept: false },
        })
        const none = await control.dialog('t1', { accept: true })
        assert.equal(none.ok ? null : none.code, 'no_dialog')
        // One the person answers in the pane is gone for the agent too.
        wc.debugger.emit('message', {}, 'Page.javascriptDialogOpening', {
          type: 'prompt',
          message: 'Name?',
          defaultPrompt: 'Ada',
        })
        wc.debugger.emit('message', {}, 'Page.javascriptDialogClosed', { result: true })
        assert.equal((await control.dialog('t1', { accept: true, promptText: 'Grace' })).ok, false)
      },
    )

    await run('the pointer overlay hears each move, click and wheel before the page does', async () => {
      const { wc, control } = fixture()
      log.length = 0
      wc.debugger.respond = (method) => (method === 'Runtime.evaluate' ? evaluation({ x: 40, y: 20 }) : {})
      await control.click('t1', { ref: 'e1' })
      assert.deepEqual(log, [
        'pointer:move@40,20',
        'dispatch:mouseMoved',
        'pointer:click@40,20',
        'dispatch:mousePressed',
        'dispatch:mouseReleased',
      ])
      log.length = 0
      await control.scroll('t1', null, 0, 300)
      assert.deepEqual(log, ['pointer:wheel@40,20', 'dispatch:mouseWheel'])
    })

    await run(
      'history: actions record their outcome, takeovers become one human entry, the ring is bounded',
      async () => {
        const { wc, control, human } = fixture()
        wc.debugger.respond = (method) => (method === 'Runtime.evaluate' ? evaluation({ x: 1, y: 1 }) : {})
        assert.deepEqual(control.actionsOf('t1'), [], 'nothing before the first action')
        await control.click('t1', { ref: 'e1' })
        human()
        human()
        const failing = await control.click('t1', { selector: '' })
        assert.equal(failing.ok, false)
        const entries = control.actionsOf('t1')
        assert.deepEqual(
          entries.map((entry) => [entry.action, entry.status]),
          [
            ['click', 'succeeded'],
            ['human', 'succeeded'],
            ['click', 'failed'],
          ],
        )
        assert.equal(entries[0].args, 'ref e1')
        assert.ok(entries[2].error, 'a failure carries its message')
        // An action the person interrupts says so.
        wc.debugger.respond = (method) => {
          if (method === 'Runtime.evaluate') {
            human()
            return evaluation({ x: 1, y: 1 })
          }
          return {}
        }
        await control.hover('t1', { ref: 'e2' })
        // Ordered by start: the hover began, the person's takeover landed during it,
        // and the hover ended interrupted — the sequence that explains the outcome.
        const last = control.actionsOf('t1').slice(-2)
        assert.deepEqual(
          last.map((entry) => [entry.action, entry.status]),
          [
            ['hover', 'interrupted'],
            ['human', 'succeeded'],
          ],
        )
        // Bounded.
        wc.debugger.respond = () => ({})
        for (let i = 0; i < 80; i += 1) await control.press('t1', 'Enter')
        assert.equal(control.actionsOf('t1').length, 50)
      },
    )

    await run('parseKeyChord: named keys, modifiers, single characters, and nonsense', () => {
      assert.deepEqual(parseKeyChord('Enter'), { key: 'Enter', code: 'Enter', keyCode: 13, modifiers: 0 })
      assert.deepEqual(parseKeyChord('shift+Tab'), { key: 'Tab', code: 'Tab', keyCode: 9, modifiers: 8 })
      assert.deepEqual(parseKeyChord('Meta+a'), { key: 'a', code: 'KeyA', keyCode: 65, modifiers: 4 })
      assert.deepEqual(parseKeyChord('Shift+a'), { key: 'A', code: 'KeyA', keyCode: 65, modifiers: 8 })
      assert.deepEqual(parseKeyChord('escape'), { key: 'Escape', code: 'Escape', keyCode: 27, modifiers: 0 })
      assert.equal(parseKeyChord('Ctrl+Alt+Delete+Foo'), null)
      assert.equal(parseKeyChord(''), null)
      assert.equal(parseKeyChord('Hyperspace'), null)
    })

    await run('an unknown tab is no_tab; DevTools open refuses to attach', async () => {
      const { wc, control } = fixture()
      const missing = await control.snapshot('nope')
      assert.equal(missing.ok, false)
      assert.equal(!missing.ok && missing.code, 'no_tab')
      wc.devTools = true
      const refused = await control.snapshot('t1')
      assert.equal(!refused.ok && refused.code, 'cdp')
      assert.equal(wc.debugger.attached, false)
    })

    await run(
      'the first command attaches once and enables the domains; console events buffer, bounded, and reset on navigation',
      async () => {
        const { wc, control } = fixture()
        wc.debugger.respond = (method) => (method === 'Runtime.evaluate' ? evaluation([]) : {})
        const first = await control.console('t1')
        assert.equal(first.ok, true)
        assert.deepEqual(
          wc.debugger.commands.map((c) => c.method),
          ['Runtime.enable', 'Log.enable', 'Network.enable', 'Page.enable'],
        )
        for (let i = 0; i < CONSOLE_BUFFER_MAX + 5; i += 1) {
          wc.debugger.emit('message', {}, 'Runtime.consoleAPICalled', {
            type: i % 2 ? 'error' : 'log',
            args: [{ type: 'string', value: `line ${i}` }],
            stackTrace: { callFrames: [{ url: 'http://localhost:5173/app.js', lineNumber: i }] },
          })
        }
        wc.debugger.emit('message', {}, 'Runtime.exceptionThrown', {
          exceptionDetails: {
            text: 'Uncaught',
            exception: { description: 'TypeError: boom' },
            url: 'http://localhost:5173/app.js',
            lineNumber: 9,
          },
        })
        const buffered = await control.console('t1')
        assert.equal(buffered.ok && buffered.entries.length, CONSOLE_BUFFER_MAX)
        const last = buffered.ok ? buffered.entries[buffered.entries.length - 1] : null
        assert.deepEqual(last && { level: last.level, text: last.text, location: last.location }, {
          level: 'error',
          text: 'Uncaught TypeError: boom',
          location: 'http://localhost:5173/app.js:10',
        })
        const errorsOnly = await control.console('t1', { level: 'error' })
        assert.ok(errorsOnly.ok && errorsOnly.entries.every((entry) => entry.level === 'error'))
        // Only one attach for the whole sequence.
        assert.equal(wc.debugger.commands.filter((c) => c.method === 'Runtime.enable').length, 1)
        wc.debugger.emit('message', {}, 'Page.frameNavigated', { frame: { id: 'main' } })
        const afterNavigation = await control.console('t1')
        assert.equal(afterNavigation.ok && afterNavigation.entries.length, 0)
      },
    )

    await run('network entries track status and failures; failedOnly keeps errors and 4xx/5xx', async () => {
      const { wc, control } = fixture()
      await control.network('t1')
      const send = (method: string, params: Record<string, unknown>) => wc.debugger.emit('message', {}, method, params)
      send('Network.requestWillBeSent', {
        requestId: 'r1',
        request: { method: 'GET', url: 'http://localhost:5173/api/ok' },
        type: 'Fetch',
      })
      send('Network.requestWillBeSent', {
        requestId: 'r2',
        request: { method: 'POST', url: 'http://localhost:5173/api/bad' },
        type: 'Fetch',
      })
      send('Network.requestWillBeSent', {
        requestId: 'r3',
        request: { method: 'GET', url: 'http://localhost:5173/gone' },
      })
      send('Network.requestWillBeSent', {
        requestId: 'r4',
        request: { method: 'GET', url: 'data:image/png;base64,AAAA' },
      })
      send('Network.responseReceived', { requestId: 'r1', response: { status: 200 } })
      send('Network.loadingFinished', { requestId: 'r1' })
      send('Network.responseReceived', { requestId: 'r2', response: { status: 500 } })
      send('Network.loadingFinished', { requestId: 'r2' })
      send('Network.loadingFailed', { requestId: 'r3', errorText: 'net::ERR_CONNECTION_REFUSED' })
      const all = await control.network('t1')
      assert.equal(all.ok && all.entries.length, 3)
      const failed = await control.network('t1', { failedOnly: true })
      assert.deepEqual(
        failed.ok && failed.entries.map((entry) => [entry.requestId, entry.outcome, entry.status, entry.errorText]),
        [
          ['r2', 'ok', 500, null],
          ['r3', 'failed', null, 'net::ERR_CONNECTION_REFUSED'],
        ],
      )
    })

    await run('click locates, then yields to a human who acted mid-action; the badge lights either way', async () => {
      const { wc, control, badges, bump } = fixture()
      wc.debugger.respond = (method) => {
        if (method === 'Runtime.evaluate') {
          bump() // the person typed a chord while the page was being measured
          return evaluation({ x: 40, y: 20 })
        }
        return {}
      }
      const result = await control.click('t1', { ref: 'e3' })
      assert.equal(!result.ok && result.code, 'interrupted')
      assert.equal(
        wc.debugger.commands.some((c) => c.method === 'Input.dispatchMouseEvent'),
        false,
      )
      assert.deepEqual(badges, ['t1'])
    })

    await run(
      'click dispatches move, press and release at the element centre; a stale ref says to re-snapshot',
      async () => {
        const { wc, control } = fixture()
        wc.debugger.respond = (method) => (method === 'Runtime.evaluate' ? evaluation({ x: 40, y: 20 }) : {})
        const clicked = await control.click('t1', { ref: 'e3' })
        assert.equal(clicked.ok, true)
        const mouse = wc.debugger.commands
          .filter((c) => c.method === 'Input.dispatchMouseEvent')
          .map((c) => c.params?.type)
        assert.deepEqual(mouse, ['mouseMoved', 'mousePressed', 'mouseReleased'])
        wc.debugger.respond = (method) => (method === 'Runtime.evaluate' ? evaluation({ missing: true }) : {})
        const stale = await control.click('t1', { ref: 'e99' })
        assert.equal(!stale.ok && stale.code, 'not_found')
        assert.match(!stale.ok ? stale.message : '', /snapshot/)
        const noTarget = await control.click('t1', {})
        assert.equal(!noTarget.ok && noTarget.code, 'invalid')
      },
    )

    await run('type with clear yields BEFORE emptying the field when the person took over', async () => {
      const { wc, control, bump } = fixture()
      wc.debugger.respond = (method) => {
        if (method === 'Runtime.evaluate') {
          bump()
          return evaluation({ x: 5, y: 5 })
        }
        return {}
      }
      const result = await control.type('t1', { ref: 'e1' }, 'hello', { clear: true })
      assert.equal(!result.ok && result.code, 'interrupted')
      assert.equal(
        wc.debugger.commands.some((c) => c.method.startsWith('Input.')),
        false,
        'nothing was dispatched to the page',
      )
    })

    await run('synthetic input is bracketed so the manager does not count it as a human', async () => {
      const { wc, control, inputDepths } = fixture()
      wc.debugger.respond = () => ({})
      await control.press('t1', 'Enter')
      assert.deepEqual(inputDepths, [1, 0, 1, 0], 'each dispatch enters and leaves the bracket')
      const weird = await control.press('t1', 'constructor')
      assert.equal(!weird.ok && weird.code, 'invalid')
    })

    await run('an expression that never settles times out instead of holding the call', async () => {
      const { wc, control } = fixture()
      wc.debugger.respond = (method) => (method === 'Runtime.evaluate' ? new Promise(() => {}) : {})
      // The deadline is the control's own; the test cannot wait 30s, so it
      // races a 60ms deadline through the same helper by faking the clock.
      const originalSetTimeout = globalThis.setTimeout
      ;(globalThis as { setTimeout: typeof setTimeout }).setTimeout = ((fn: () => void, ms?: number) =>
        originalSetTimeout(fn, ms && ms >= 30_000 ? 20 : ms)) as typeof setTimeout
      try {
        const result = await control.evaluate('t1', 'new Promise(() => {})')
        assert.equal(!result.ok && result.code, 'timeout')
      } finally {
        ;(globalThis as { setTimeout: typeof setTimeout }).setTimeout = originalSetTimeout
      }
    })

    await run('type inserts text as one IME commit and submits with Enter when asked', async () => {
      const { wc, control } = fixture()
      wc.debugger.respond = (method) => (method === 'Runtime.evaluate' ? evaluation({ x: 1, y: 1 }) : {})
      const typed = await control.type('t1', null, 'hello', { submit: true })
      assert.equal(typed.ok, true)
      const kinds = wc.debugger.commands
        .filter((c) => c.method.startsWith('Input.'))
        .map((c) => `${c.method}:${c.params?.type ?? c.params?.text}`)
      assert.deepEqual(kinds, [
        'Input.insertText:hello',
        'Input.dispatchKeyEvent:keyDown',
        'Input.dispatchKeyEvent:keyUp',
      ])
    })

    await run('evaluate returns the value, surfaces page exceptions, and bounds huge results', async () => {
      const { wc, control } = fixture()
      wc.debugger.respond = (_method, params) => {
        const expression = String(params?.expression ?? '')
        if (expression === 'throw')
          return {
            result: { type: 'undefined' },
            exceptionDetails: { text: 'Uncaught', exception: { description: 'ReferenceError: nope' } },
          }
        if (expression === 'big') return evaluation('x'.repeat(20_000))
        return evaluation({ answer: 42 })
      }
      const ok = await control.evaluate('t1', '1+1')
      assert.deepEqual(ok, { ok: true, value: { answer: 42 }, truncated: false })
      const thrown = await control.evaluate('t1', 'throw')
      assert.equal(!thrown.ok && thrown.message, 'ReferenceError: nope')
      const big = await control.evaluate('t1', 'big')
      assert.equal(big.ok && big.truncated, true)
    })

    await run(
      'a detach (DevTools opened) drops the session; the next command re-attaches once DevTools closes',
      async () => {
        const { wc, control } = fixture()
        wc.debugger.respond = (method) => (method === 'Runtime.evaluate' ? evaluation([]) : {})
        await control.console('t1')
        wc.debugger.detach()
        wc.devTools = true
        const refused = await control.console('t1')
        assert.equal(!refused.ok && refused.code, 'cdp')
        wc.devTools = false
        const again = await control.console('t1')
        assert.equal(again.ok, true)
        assert.equal(wc.debugger.commands.filter((c) => c.method === 'Runtime.enable').length, 2)
        control.forget('t1')
        assert.equal(wc.debugger.listenerCount('message'), 0)
      },
    )
  }

  const suiteRun = main().catch((error) => {
    console.error(error)
    process.exit(1)
  })

  await suiteRun
})

test('an action a dialog ended does not resume typing once the dialog is answered', async () => {
  // A debugger whose page call that opens the dialog blocks until the dialog
  // is closed, the way a real alert holds Input.dispatchMouseEvent.
  class BlockingDebugger extends EventEmitter {
    attached = false
    commands: string[] = []
    isAttached() {
      return this.attached
    }
    attach() {
      this.attached = true
    }
    detach() {
      this.attached = false
    }
    async sendCommand(method: string, params?: Record<string, unknown>) {
      this.commands.push(method === 'Input.dispatchMouseEvent' ? `${method}:${String(params?.type)}` : method)
      if (method === 'Runtime.evaluate') return { result: { type: 'object', value: { x: 10, y: 10 } } }
      if (method === 'Page.handleJavaScriptDialog') {
        queueMicrotask(() => this.emit('message', {}, 'Page.javascriptDialogClosed', { result: false }))
        return {}
      }
      if (method === 'Input.dispatchMouseEvent' && params?.type === 'mousePressed') {
        return new Promise((resolve) => {
          const closed = (_event: unknown, name: string) => {
            if (name !== 'Page.javascriptDialogClosed') return
            this.removeListener('message', closed)
            resolve({})
          }
          this.on('message', closed)
          this.emit('message', {}, 'Page.javascriptDialogOpening', { type: 'alert', message: 'Saved' })
        })
      }
      return {}
    }
  }
  const wc = Object.assign(new EventEmitter(), {
    debugger: new BlockingDebugger(),
    isDestroyed: () => false,
    isDevToolsOpened: () => false,
  })
  const control = createBrowserControl({
    webContentsOf: () => wc as unknown as WebContents,
    epochOf: () => 0,
    noteAgentActivity: () => {},
    noteAgentInput: () => {},
    onHumanInput: () => () => {},
    onDownload: () => () => {},
    notePointer: () => {},
  })

  const typed = await control.type('t1', { ref: 'e1' }, 'hello', { submit: true })
  assert.equal(typed.ok ? null : typed.code, 'dialog_open')
  assert.equal((await control.dialog('t1', { accept: true })).ok, true)
  // Let the parked click return and the old action run as far as it would.
  for (let i = 0; i < 20; i += 1) await new Promise((resolve) => setImmediate(resolve))

  const after = wc.debugger.commands.slice(wc.debugger.commands.indexOf('Page.handleJavaScriptDialog') + 1)
  assert.deepEqual(after, [], 'the abandoned type sent nothing to the page after the dialog closed')
  assert.ok(!wc.debugger.commands.includes('Input.insertText'))
})

test('a download the agent’s tab saved is in its action history with the path, and says how it ended', async () => {
  const debuggerStub = Object.assign(new EventEmitter(), {
    attached: false,
    isAttached() {
      return this.attached
    },
    attach() {
      this.attached = true
    },
    detach() {
      this.attached = false
    },
    sendCommand: async () => ({}),
  })
  const wc = Object.assign(new EventEmitter(), {
    debugger: debuggerStub,
    isDestroyed: () => false,
    isDevToolsOpened: () => false,
  })
  let tell: (tabId: string, download: BrowserDownload) => void = () => {}
  const control = createBrowserControl({
    webContentsOf: () => wc as unknown as WebContents,
    epochOf: () => 0,
    noteAgentActivity: () => {},
    noteAgentInput: () => {},
    onHumanInput: () => () => {},
    onDownload: (listener) => {
      tell = listener
      return () => {}
    },
    notePointer: () => {},
  })
  assert.equal((await control.console('t1', {})).ok, true)
  const path = '/Users/dev/app/.sprintengine/browser/downloads/report.csv'
  tell('t1', { url: 'http://localhost:5173/report.csv', path, state: 'started' })
  assert.deepEqual(
    control.actionsOf('t1').map(({ action, args, path, status }) => ({ action, args, path, status })),
    [{ action: 'download', args: 'http://localhost:5173/report.csv', path, status: 'running' }],
  )
  tell('t1', { url: 'http://localhost:5173/report.csv', path, state: 'interrupted' })
  const [entry] = control.actionsOf('t1')
  assert.equal(entry?.status, 'failed')
  assert.equal(entry?.error, 'The download was interrupted.')
})
