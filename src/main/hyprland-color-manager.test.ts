import assert from 'node:assert/strict'
import { test } from 'vitest'
import { colorManagerDisableFeatures, type ColorManagerSwitchInput } from './hyprland-color-manager'

const AFFECTED = JSON.stringify({
  version: '0.50.1',
  tag: 'v0.50.1',
  commit: '4e242d086e20b32951fdc0ebcbfb4d41b5be8dcc',
  dirty: false,
})

function input(overrides: Partial<ColorManagerSwitchInput> = {}): ColorManagerSwitchInput {
  return {
    env: { XDG_CURRENT_DESKTOP: 'Hyprland' },
    ozonePlatform: 'wayland',
    enableFeatures: '',
    disableFeatures: '',
    readHyprctlVersion: () => AFFECTED,
    ...overrides,
  }
}

test('a stock affected Hyprland release on native Wayland turns the color manager off', () => {
  assert.equal(colorManagerDisableFeatures(input()), 'WaylandWpColorManagerV1')
})

test('features already disabled are kept, because Chromium reads only the last list', () => {
  assert.equal(
    colorManagerDisableFeatures(input({ disableFeatures: 'Vulkan,UseOzonePlatform' })),
    'Vulkan,UseOzonePlatform,WaylandWpColorManagerV1',
  )
})

test('a session desktop list naming Hyprland among others counts', () => {
  assert.equal(
    colorManagerDisableFeatures(input({ env: { XDG_CURRENT_DESKTOP: 'Hyprland:wlroots' } })),
    'WaylandWpColorManagerV1',
  )
  assert.equal(
    colorManagerDisableFeatures(input({ env: { XDG_SESSION_DESKTOP: 'hyprland' } })),
    'WaylandWpColorManagerV1',
  )
})

test('X11, other desktops and a stale Hyprland signature leave the command line alone', () => {
  let probed = false
  const readHyprctlVersion = () => {
    probed = true
    return AFFECTED
  }
  assert.equal(colorManagerDisableFeatures(input({ ozonePlatform: 'x11', readHyprctlVersion })), null)
  assert.equal(colorManagerDisableFeatures(input({ ozonePlatform: '', readHyprctlVersion })), null)
  assert.equal(
    colorManagerDisableFeatures(
      input({ env: { XDG_CURRENT_DESKTOP: 'GNOME', HYPRLAND_INSTANCE_SIGNATURE: 'abc' }, readHyprctlVersion }),
    ),
    null,
  )
  assert.equal(probed, false)
})

test('a person who named the feature keeps their choice', () => {
  assert.equal(colorManagerDisableFeatures(input({ enableFeatures: 'WaylandWpColorManagerV1' })), null)
  assert.equal(colorManagerDisableFeatures(input({ enableFeatures: '*WaylandWpColorManagerV1<Trial' })), null)
  assert.equal(colorManagerDisableFeatures(input({ disableFeatures: 'Vulkan,WaylandWpColorManagerV1' })), null)
})

test('fixed, modified, unknown and unreadable Hyprland builds keep the default', () => {
  const version = (fields: Record<string, unknown>) => () => JSON.stringify({ ...JSON.parse(AFFECTED), ...fields })
  assert.equal(
    colorManagerDisableFeatures(input({ readHyprctlVersion: version({ version: '0.51.0', tag: 'v0.51.0' }) })),
    null,
  )
  assert.equal(colorManagerDisableFeatures(input({ readHyprctlVersion: version({ dirty: true }) })), null)
  assert.equal(colorManagerDisableFeatures(input({ readHyprctlVersion: version({ commit: 'deadbeef' }) })), null)
  assert.equal(colorManagerDisableFeatures(input({ readHyprctlVersion: () => 'not json' })), null)
  assert.equal(
    colorManagerDisableFeatures(
      input({
        readHyprctlVersion: () => {
          throw new Error('spawn hyprctl ENOENT')
        },
      }),
    ),
    null,
  )
})
