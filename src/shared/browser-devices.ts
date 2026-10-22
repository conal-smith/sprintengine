// Device presets for the browser tab's device toolbar (browser-pane epic,
// decision 7): Chromium's default device list, in DevTools' own order, with
// CSS viewport sizes copied from its EmulatedDevices catalogue. Sizing only —
// no user-agent or touch emulation; a dev server's responsive CSS is what a
// person is checking.

export type BrowserDevicePreset = {
  id: string
  label: string
  category: 'Phone' | 'Tablet' | 'Laptop' | 'Display'
  width: number
  height: number
}

export const BROWSER_DEVICE_PRESETS: readonly BrowserDevicePreset[] = [
  { id: 'iphone-se', label: 'iPhone SE', category: 'Phone', width: 375, height: 667 },
  { id: 'iphone-xr', label: 'iPhone XR', category: 'Phone', width: 414, height: 896 },
  { id: 'iphone-12-pro', label: 'iPhone 12 Pro', category: 'Phone', width: 390, height: 844 },
  { id: 'iphone-14-pro-max', label: 'iPhone 14 Pro Max', category: 'Phone', width: 430, height: 932 },
  { id: 'pixel-7', label: 'Pixel 7', category: 'Phone', width: 412, height: 915 },
  { id: 'samsung-galaxy-s8-plus', label: 'Galaxy S8+', category: 'Phone', width: 360, height: 740 },
  { id: 'samsung-galaxy-s20-ultra', label: 'Galaxy S20 Ultra', category: 'Phone', width: 412, height: 915 },
  { id: 'ipad-mini', label: 'iPad Mini', category: 'Tablet', width: 768, height: 1024 },
  { id: 'ipad-air', label: 'iPad Air', category: 'Tablet', width: 820, height: 1180 },
  { id: 'ipad-pro', label: 'iPad Pro', category: 'Tablet', width: 1024, height: 1366 },
  { id: 'surface-pro-7', label: 'Surface Pro 7', category: 'Tablet', width: 912, height: 1368 },
  { id: 'surface-duo', label: 'Surface Duo', category: 'Tablet', width: 540, height: 720 },
  { id: 'galaxy-z-fold-5', label: 'Galaxy Z Fold 5', category: 'Phone', width: 344, height: 882 },
  { id: 'asus-zenbook-fold', label: 'Asus Zenbook Fold', category: 'Laptop', width: 853, height: 1280 },
  { id: 'samsung-galaxy-a51-71', label: 'Galaxy A51/71', category: 'Phone', width: 412, height: 914 },
  { id: 'nest-hub', label: 'Nest Hub', category: 'Display', width: 1024, height: 600 },
  { id: 'nest-hub-max', label: 'Nest Hub Max', category: 'Display', width: 1280, height: 800 },
]

// The preset the toolbar opens on: the phone size most sites are still
// designed against, so the first look is the one that matters most.
export const DEFAULT_BROWSER_DEVICE_PRESET_ID = 'iphone-12-pro'

const BROWSER_VIEWPORT_MIN = 240
const BROWSER_VIEWPORT_MAX = 3840

export type BrowserViewport =
  | { mode: 'fill' }
  | { mode: 'preset'; presetId: string; width: number; height: number }
  | { mode: 'freeform'; width: number; height: number }

function browserDevicePreset(id: string): BrowserDevicePreset | undefined {
  return BROWSER_DEVICE_PRESETS.find((preset) => preset.id === id)
}

export function clampViewportSize(value: number): number {
  if (!Number.isFinite(value)) return BROWSER_VIEWPORT_MIN
  return Math.min(BROWSER_VIEWPORT_MAX, Math.max(BROWSER_VIEWPORT_MIN, Math.round(value)))
}

export function presetViewport(presetId: string): BrowserViewport {
  const preset = browserDevicePreset(presetId) ?? browserDevicePreset(DEFAULT_BROWSER_DEVICE_PRESET_ID)!
  return { mode: 'preset', presetId: preset.id, width: preset.width, height: preset.height }
}

/** Swap width and height; a preset becomes freeform because the preset names a portrait size. */
export function rotateViewport(viewport: BrowserViewport): BrowserViewport {
  if (viewport.mode === 'fill') return viewport
  return { mode: 'freeform', width: viewport.height, height: viewport.width }
}

export function normalizeBrowserViewport(input: unknown): BrowserViewport | undefined {
  if (!input || typeof input !== 'object') return undefined
  const raw = input as Partial<Record<'mode' | 'presetId' | 'width' | 'height', unknown>>
  if (raw.mode === 'fill') return { mode: 'fill' }
  if (raw.mode === 'preset' && typeof raw.presetId === 'string' && browserDevicePreset(raw.presetId)) {
    return presetViewport(raw.presetId)
  }
  if (raw.mode === 'freeform' && typeof raw.width === 'number' && typeof raw.height === 'number') {
    return { mode: 'freeform', width: clampViewportSize(raw.width), height: clampViewportSize(raw.height) }
  }
  return undefined
}

/**
 * The scale that fits a CSS viewport inside the tab body, never above 1: the
 * guest keeps its requested CSS size and is presented smaller when the pane
 * is narrower than the device.
 */
export function fitViewportScale(
  viewport: { width: number; height: number },
  available: { width: number; height: number },
): number {
  if (available.width <= 0 || available.height <= 0) return 1
  return Math.min(1, available.width / viewport.width, available.height / viewport.height)
}

/**
 * The size, in the app window's CSS px, that lays a guest out at `size` CSS
 * px of its own. A `<webview>` guest is laid out in the screen pixels its
 * element covers, and the window's zoom (View ▸ Zoom) makes each of the
 * window's CSS px cover more of them: at zoom 1.2 an element 390 wide gives
 * the page 468, past a phone's breakpoints. Dividing by the zoom puts the
 * page back at the size asked for; at zoom 1 the size is unchanged.
 */
export function guestLayoutSize(
  size: { width: number; height: number },
  windowZoom: number,
): { width: number; height: number } {
  const zoom = Number.isFinite(windowZoom) && windowZoom > 0 ? windowZoom : 1
  return { width: size.width / zoom, height: size.height / zoom }
}

// Zoom ladder, Chromium's own steps.
export const BROWSER_ZOOM_LEVELS: readonly number[] = [
  0.25, 0.33, 0.5, 0.67, 0.75, 0.8, 0.9, 1, 1.1, 1.25, 1.5, 1.75, 2, 2.5, 3, 4, 5,
]

export function nextZoomLevel(current: number, direction: 1 | -1): number {
  const index = BROWSER_ZOOM_LEVELS.findIndex((level) => Math.abs(level - current) < 0.001)
  const from =
    index === -1 ? BROWSER_ZOOM_LEVELS.findIndex((level) => level > current) - (direction === 1 ? 1 : 0) : index
  const next = Math.min(BROWSER_ZOOM_LEVELS.length - 1, Math.max(0, from + direction))
  return BROWSER_ZOOM_LEVELS[next] ?? 1
}

export type BrowserColorScheme = 'system' | 'light' | 'dark'
