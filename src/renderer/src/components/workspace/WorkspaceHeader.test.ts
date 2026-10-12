import { expect, test } from 'vitest'
import { APP_RAIL_WIDTH, TRAFFIC_LIGHT_RESERVE } from './AppRail'
import { headerTrafficLightInset } from './WorkspaceHeader'

const mac = { isMac: true, isFullScreen: false, sidebarCollapsed: true }

test('beside the rail, the header leaves room for what the traffic lights run past it', () => {
  expect(headerTrafficLightInset({ ...mac, besideRail: true })).toBe(TRAFFIC_LIGHT_RESERVE - APP_RAIL_WIDTH)
})

test('with the rail hidden by the narrow layout, the header leaves room for all of the traffic lights', () => {
  expect(headerTrafficLightInset({ ...mac, besideRail: false })).toBe(TRAFFIC_LIGHT_RESERVE)
})

test('no room is left with the sidebar open, in fullscreen, or off macOS', () => {
  for (const besideRail of [true, false]) {
    expect(headerTrafficLightInset({ ...mac, sidebarCollapsed: false, besideRail })).toBe(0)
    expect(headerTrafficLightInset({ ...mac, isFullScreen: true, besideRail })).toBe(0)
    expect(headerTrafficLightInset({ ...mac, isMac: false, besideRail })).toBe(0)
  }
})
