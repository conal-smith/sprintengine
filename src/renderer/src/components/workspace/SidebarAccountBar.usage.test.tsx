// @vitest-environment jsdom
import React from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { expect, test } from 'vitest'

import type { SprintEngineAuthState } from '../../../../shared/electron-api'
import SidebarAccountBar from './SidebarAccountBar'

// The usage dashboard's chart glyph stands above the account on the rail
// (owner ruling 2026-10-10), and wears the pressed state while it is open.

const SIGNED_OUT: SprintEngineAuthState = {
  authenticated: false,
  user: null,
  selectedOrganization: null,
  status: 'signed_out',
  message: null,
}

function render(props: { collapsed: boolean; usageOpen?: boolean; openUsage?: () => void }): HTMLElement {
  const host = document.createElement('div')
  host.innerHTML = renderToStaticMarkup(
    <SidebarAccountBar
      authState={SIGNED_OUT}
      authMessage={null}
      accountOpen={false}
      setAccountOpen={() => {}}
      startLogin={() => {}}
      refreshAuthState={() => {}}
      logout={() => {}}
      openSettings={() => {}}
      settingsOpen={false}
      settingsBadge={null}
      {...props}
    />,
  )
  return host
}

const labels = (host: HTMLElement): string[] =>
  [...host.querySelectorAll('button')].map((button) => button.getAttribute('aria-label') ?? '')

test('on the rail, Usage comes first: above the account, which is above Settings', () => {
  expect(labels(render({ collapsed: true, openUsage: () => {} }))).toEqual(['Usage', 'Sign in', 'Settings'])
})

test('in a row, Usage sits with the gear at the right edge', () => {
  expect(labels(render({ collapsed: false, openUsage: () => {} }))).toEqual(['Sign in', 'Usage', 'Settings'])
})

test('the glyph is pressed while the dashboard is open, and absent with nothing to open', () => {
  const open = render({ collapsed: true, usageOpen: true, openUsage: () => {} })
  expect(open.querySelector('button[aria-label="Usage"]')?.getAttribute('aria-pressed')).toBe('true')
  expect(labels(render({ collapsed: true }))).toEqual(['Sign in', 'Settings'])
})
