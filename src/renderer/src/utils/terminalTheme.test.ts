// @vitest-environment jsdom
import { afterEach, expect, test } from 'vitest'

import { getTerminalAnsiPalette, getTerminalTheme } from './terminalTheme'

const html = document.documentElement

afterEach(() => {
  html.removeAttribute('style')
})

test('a theme with no ANSI colours of its own keeps the stock palette for its surface', () => {
  html.style.setProperty('--terminal-bg', '#101018')
  const dark = getTerminalTheme()
  html.style.setProperty('--terminal-bg', '#f0f0f4')
  const light = getTerminalTheme()
  expect(dark.red).not.toBe(light.red)
  expect(dark.background).toBe('#101018')
})

test("a theme's own ANSI colours replace the stock ones they name, and only those", () => {
  html.style.setProperty('--terminal-bg', '#101018')
  const stock = getTerminalTheme()
  html.style.setProperty('--terminal-ansi-red', '#fc5454')
  html.style.setProperty('--terminal-ansi-bright-black', '#6474a4')
  const themed = getTerminalTheme()
  expect(themed.red).toBe('#fc5454')
  expect(themed.brightBlack).toBe('#6474a4')
  expect(themed.green).toBe(stock.green)
  // The transcript's ANSI renderer reads the same palette, in xterm's order.
  const palette = getTerminalAnsiPalette()
  expect(palette[1]).toBe('#fc5454')
  expect(palette[8]).toBe('#6474a4')
})
