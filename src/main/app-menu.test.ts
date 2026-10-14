import { expect, test, vi } from 'vitest'

// The template, as the menu is built from it.
vi.mock('electron', () => ({
  BrowserWindow: { fromId: () => null, getFocusedWindow: () => null },
  Menu: { buildFromTemplate: (template: unknown) => template, setApplicationMenu: () => {} },
}))

const { createAppMenu, setAfterWindowZoom, zoomWindowContents } = await import('./app-menu')

type Item = { label?: string; role?: string; accelerator?: string; submenu?: Item[] }

test("the View menu's zoom keeps its roles' names and keys", () => {
  const view = (createAppMenu() as unknown as Item[]).find((menu) => menu.label === 'View')!
  const zoom = view.submenu!.filter((item) => /zoom|actual size/i.test(item.label ?? item.role ?? ''))
  expect(zoom.map(({ label, role, accelerator }) => ({ label, role, accelerator }))).toEqual([
    { label: 'Actual Size', role: undefined, accelerator: 'CmdOrCtrl+0' },
    { label: 'Zoom In', role: undefined, accelerator: 'CmdOrCtrl+=' },
    { label: 'Zoom Out', role: undefined, accelerator: 'CmdOrCtrl+-' },
  ])
})

test("zooming a window steps its own zoom, then lets the browser pane put its pages' zoom back", () => {
  let level = 0
  const contents = {
    getZoomLevel: () => level,
    setZoomLevel: (next: number) => {
      level = next
    },
  } as unknown as Electron.WebContents
  const after: number[] = []
  setAfterWindowZoom(() => after.push(level))
  try {
    zoomWindowContents(contents, 1)
    zoomWindowContents(contents, 1)
    zoomWindowContents(contents, -1)
    expect(level).toBe(0.5)
    zoomWindowContents(contents, 0)
    expect(level).toBe(0)
    expect(after).toEqual([0.5, 1, 0.5, 0])
  } finally {
    setAfterWindowZoom(null)
  }
})
