import assert from 'node:assert/strict'

import { JSDOM } from 'jsdom'

import { startColumnResizeDrag } from './columnResizeDrag'
import { test } from 'vitest'

test('columnResizeDrag', async () => {
  // The bug this suite exists for: the workspace pane aside hosts a browser tab,
  // and a browser tab is an Electron `<webview>` guest. A drag wired to `window`
  // stopped receiving pointer events the moment the pointer crossed into the
  // guest — so the column froze a few pixels in (you could widen it, never narrow
  // it) and the drag stayed armed with no pointer-up to end it, following the
  // cursor until the next click on host chrome.
  //
  // A guest cannot be stood up in jsdom, so what is tested here is the guard that
  // makes the guest unreachable: the drag shield that covers the window for the
  // length of the gesture, and the promise that the gesture always ends and
  // always takes the shield back down. jsdom also has no pointer capture, which
  // makes this the fallback path — the drag has to complete without it.

  const dom = new JSDOM('<!doctype html><html><body></body></html>', {
    url: 'http://localhost',
    pretendToBeVisual: true,
  })
  const anyGlobal = globalThis as unknown as Record<string, unknown>
  anyGlobal.window = dom.window
  anyGlobal.document = dom.window.document

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

  const { document, MouseEvent } = dom.window

  function shields(): Element[] {
    return Array.from(document.querySelectorAll('[data-column-resize-shield]'))
  }

  function mountHandle(): HTMLElement {
    document.body.innerHTML = ''
    const handle = document.createElement('div')
    document.body.appendChild(handle)
    return handle
  }

  // A React SyntheticEvent stand-in: startColumnResizeDrag reads only these.
  function pointerDown(handle: HTMLElement, clientX: number) {
    return {
      currentTarget: handle,
      pointerId: 1,
      clientX,
      preventDefault: () => {},
    } as unknown as Parameters<typeof startColumnResizeDrag>[0]
  }

  function dispatch(type: string, clientX: number, pointerId = 1): void {
    const event = new MouseEvent(type, { bubbles: true, clientX })
    Object.defineProperty(event, 'pointerId', { value: pointerId })
    dom.window.dispatchEvent(event)
  }

  // The frames are rAF-coalesced, so a drag's positions land on the next frame.
  function nextFrame(): Promise<void> {
    return new Promise((resolve) => dom.window.requestAnimationFrame(() => resolve()))
  }

  async function main(): Promise<void> {
    await (async () => {
      const handle = mountHandle()
      const seen: number[] = []
      let ended = 0
      startColumnResizeDrag(pointerDown(handle, 500), {
        onDrag: (x) => seen.push(x),
        onDragEnd: () => {
          ended += 1
        },
      })

      run('a live drag covers the window so no guest can swallow it', () => {
        assert.equal(shields().length, 1, 'exactly one shield, over everything')
        const shield = shields()[0] as HTMLElement
        assert.equal(shield.style.position, 'fixed')
        assert.equal(shield.style.inset, '0px')
        assert.equal(shield.style.cursor, 'col-resize', 'the guest paints its own cursor; the shield carries ours')
        assert.equal(shield.style.zIndex, 'var(--z-toast)', 'a z tier, never a literal')
        assert.equal(document.body.style.userSelect, 'none')
      })

      dispatch('pointermove', 420)
      await nextFrame()
      run('the pointer keeps driving the width after it leaves the handle', () => {
        assert.deepEqual(seen, [420])
      })

      dispatch('pointerup', 420)
      run('pointer-up ends the drag once and takes the shield down', () => {
        assert.equal(ended, 1, 'the drag ends')
        assert.deepEqual(shields(), [], 'a shield left up would swallow every click in the app')
        assert.equal(document.body.style.cursor, '')
        assert.equal(document.body.style.userSelect, '')
      })

      dispatch('pointermove', 300)
      await nextFrame()
      run('an ended drag is deaf to the pointer', () => {
        assert.deepEqual(seen, [420], 'no width write after the gesture ended')
      })
    })()

    // Every other way a gesture can die still has to end it, because each one
    // leaves the shield up otherwise.
    for (const [name, endIt] of [
      ['pointer-cancel', () => dispatch('pointercancel', 400)],
      ['the window losing focus', () => dom.window.dispatchEvent(new dom.window.Event('blur'))],
      [
        'the handle unmounting mid-drag',
        () => {
          const handle = document.querySelector('div:not([data-column-resize-shield])')
          handle?.dispatchEvent(new dom.window.Event('lostpointercapture'))
        },
      ],
    ] as const) {
      const handle = mountHandle()
      let ended = 0
      startColumnResizeDrag(pointerDown(handle, 500), {
        onDrag: () => {},
        onDragEnd: () => {
          ended += 1
        },
      })
      endIt()
      run(`${name} ends the drag and clears the shield`, () => {
        assert.equal(ended, 1)
        assert.deepEqual(shields(), [])
      })
    }

    // A second pointer (a stray touch, a second mouse) must not end someone
    // else's drag or steer it.
    {
      const handle = mountHandle()
      const seen: number[] = []
      let ended = 0
      startColumnResizeDrag(pointerDown(handle, 500), {
        onDrag: (x) => seen.push(x),
        onDragEnd: () => {
          ended += 1
        },
      })
      dispatch('pointermove', 100, 2)
      dispatch('pointerup', 100, 2)
      await nextFrame()
      run('another pointer neither steers nor ends this drag', () => {
        assert.deepEqual(seen, [])
        assert.equal(ended, 0)
        assert.equal(shields().length, 1)
      })
      dispatch('pointerup', 500)
    }

    if (failures > 0) {
      console.error(`${failures} column resize drag test(s) failed`)
      process.exit(1)
    }
    console.log('column resize drag tests passed')
  }

  const suiteRun = main()

  await suiteRun
})

// A flick: the last move is still waiting for its frame when the pointer comes
// up. The callers commit whatever `onDrag` last drew, so a release that only
// cancelled the frame left the column short of where the pointer let go.
function flickHarness() {
  const dom = new JSDOM('<!doctype html><html><body></body></html>', {
    url: 'http://localhost',
    pretendToBeVisual: true,
  })
  const anyGlobal = globalThis as unknown as Record<string, unknown>
  anyGlobal.window = dom.window
  anyGlobal.document = dom.window.document
  const handle = dom.window.document.createElement('div')
  dom.window.document.body.appendChild(handle)
  const log: string[] = []
  startColumnResizeDrag(
    {
      currentTarget: handle,
      pointerId: 1,
      clientX: 500,
      preventDefault: () => {},
    } as unknown as Parameters<typeof startColumnResizeDrag>[0],
    {
      onDrag: (x) => log.push(`drag ${x}`),
      onDragEnd: () => log.push('end'),
    },
  )
  const dispatch = (type: string, clientX: number): void => {
    const event = new dom.window.MouseEvent(type, { bubbles: true, clientX })
    Object.defineProperty(event, 'pointerId', { value: 1 })
    dom.window.dispatchEvent(event)
  }
  const nextFrame = () => new Promise<void>((resolve) => dom.window.requestAnimationFrame(() => resolve()))
  return { dom, log, dispatch, nextFrame }
}

test('a release before the next frame still draws the width where the pointer let go', async () => {
  const { log, dispatch, nextFrame } = flickHarness()
  dispatch('pointermove', 380)
  dispatch('pointerup', 360)
  assert.deepEqual(log, ['drag 360', 'end'])
  await nextFrame()
  assert.deepEqual(log, ['drag 360', 'end'], 'the cancelled frame does not draw again after the commit')
})

test('a release where the last frame already drew adds no second write', async () => {
  const { log, dispatch, nextFrame } = flickHarness()
  dispatch('pointermove', 420)
  await nextFrame()
  dispatch('pointerup', 420)
  assert.deepEqual(log, ['drag 420', 'end'])
})

test('an interrupted drag commits what was drawn and does not chase the pending move', async () => {
  const { dom, log, dispatch, nextFrame } = flickHarness()
  dispatch('pointermove', 420)
  await nextFrame()
  dispatch('pointermove', 300)
  dom.window.dispatchEvent(new dom.window.Event('blur'))
  await nextFrame()
  assert.deepEqual(log, ['drag 420', 'end'])
})

test('a cancelled pointer is not a release, so its x is not drawn', async () => {
  const { log, dispatch, nextFrame } = flickHarness()
  dispatch('pointermove', 420)
  dispatch('pointercancel', 0)
  await nextFrame()
  assert.deepEqual(log, ['end'])
})
