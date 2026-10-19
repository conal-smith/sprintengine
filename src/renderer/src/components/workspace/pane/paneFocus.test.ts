// @vitest-environment jsdom
import { afterEach, expect, test, vi } from 'vitest'
import { keepFocusOutOfClosedPane, WORKSPACE_PANE_DATA_ATTRIBUTE } from './paneFocus'

// A header with the pane switch, and a pane column holding a focusable row.
function mount(): { inPane: HTMLButtonElement; outside: HTMLButtonElement; paneSwitch: HTMLButtonElement } {
  document.body.innerHTML = `
    <header><button data-pane-switch>Pane</button><button id="outside">Other</button></header>
    <aside ${WORKSPACE_PANE_DATA_ATTRIBUTE}><button id="row">src/index.ts</button></aside>`
  return {
    inPane: document.getElementById('row') as HTMLButtonElement,
    outside: document.getElementById('outside') as HTMLButtonElement,
    paneSwitch: document.querySelector('[data-pane-switch]') as HTMLButtonElement,
  }
}

function flushFrame(): void {
  vi.runOnlyPendingTimers()
}

afterEach(() => {
  vi.useRealTimers()
  document.body.innerHTML = ''
})

test('closing the pane with focus inside it moves focus to the pane switch', () => {
  vi.useFakeTimers({ toFake: ['requestAnimationFrame'] })
  const { inPane, paneSwitch } = mount()
  inPane.focus()
  let open = true
  keepFocusOutOfClosedPane(
    () => (open = false),
    () => open,
  )
  flushFrame()
  expect(document.activeElement).toBe(paneSwitch)
})

test('focus elsewhere, or a pane left open, stays where it is', () => {
  vi.useFakeTimers({ toFake: ['requestAnimationFrame'] })
  const { inPane, outside } = mount()
  outside.focus()
  keepFocusOutOfClosedPane(
    () => undefined,
    () => false,
  )
  flushFrame()
  expect(document.activeElement).toBe(outside)

  inPane.focus()
  keepFocusOutOfClosedPane(
    () => undefined,
    () => true,
  )
  flushFrame()
  expect(document.activeElement).toBe(inPane)
})
