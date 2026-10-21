import { expect, test, vi } from 'vitest'

// The template, as the menu is built from it.
const windows = vi.hoisted(() => new Map<number, { isDestroyed: () => boolean; webContents: unknown }>())
vi.mock('electron', () => ({
  BrowserWindow: { fromId: (id: number) => windows.get(id) ?? null, getFocusedWindow: () => null },
  Menu: { buildFromTemplate: (template: unknown) => template, setApplicationMenu: () => {} },
}))

const { createAppMenu, setAfterWindowZoom, setChatWindowsForCloseChord, zoomWindowContents, zoomWithWheel } =
  await import('./app-menu')

type Item = {
  label?: string
  role?: string
  visible?: boolean
  accelerator?: string
  submenu?: Item[]
  click?: (item: unknown, win: Electron.BaseWindow | undefined, event: { triggeredByAccelerator?: boolean }) => void
}

function closeItem(platform: NodeJS.Platform): Item {
  const file = (createAppMenu(platform) as unknown as Item[]).find((menu) => menu.label === 'File')!
  return file.submenu!.find((item) => item.role === 'close' || item.label === 'Close Window')!
}

function fakeWindow(id: number): Electron.BaseWindow & { closed: number } {
  const win = {
    id,
    closed: 0,
    isDestroyed: () => false,
    close: () => {
      win.closed++
    },
  }
  return win as unknown as Electron.BaseWindow & { closed: number }
}

test("the View menu's zoom keeps its roles' names and keys", () => {
  const view = (createAppMenu() as unknown as Item[]).find((menu) => menu.label === 'View')!
  const zoom = view.submenu!.filter(
    (item) => item.visible !== false && /zoom|actual size/i.test(item.label ?? item.role ?? ''),
  )
  expect(zoom.map(({ label, role, accelerator }) => ({ label, role, accelerator }))).toEqual([
    { label: 'Actual Size', role: undefined, accelerator: 'CmdOrCtrl+0' },
    { label: 'Zoom In', role: undefined, accelerator: 'CmdOrCtrl+=' },
    { label: 'Zoom Out', role: undefined, accelerator: 'CmdOrCtrl+-' },
  ])
})

test('the numeric keypad zooms the window too, through items the menu does not list', () => {
  const view = (createAppMenu() as unknown as Item[]).find((menu) => menu.label === 'View')!
  let level = 0
  const contents = {
    getZoomLevel: () => level,
    setZoomLevel: (next: number) => {
      level = next
    },
  }
  windows.set(7, { isDestroyed: () => false, webContents: contents })
  try {
    const press = (accelerator: string) => {
      const item = view.submenu!.find((entry) => entry.accelerator === accelerator)!
      expect(item.visible).toBe(false)
      item.click!({}, fakeWindow(7), { triggeredByAccelerator: true })
    }
    press('CmdOrCtrl+numadd')
    press('CmdOrCtrl+numadd')
    expect(level).toBe(1)
    press('CmdOrCtrl+numsub')
    expect(level).toBe(0.5)
    press('CmdOrCtrl+num0')
    expect(level).toBe(0)
  } finally {
    windows.delete(7)
  }
})

test('Cmd++ and Ctrl++ zoom in, through items the menu does not list', () => {
  const zoomIns = (platform: NodeJS.Platform) =>
    (createAppMenu(platform) as unknown as Item[])
      .find((menu) => menu.label === 'View')!
      .submenu!.filter((item) => item.label === 'Zoom In' && item.visible === false)
      .map((item) => item.accelerator)
  expect(zoomIns('darwin')).toEqual(['CmdOrCtrl+numadd', 'CmdOrCtrl+Plus', 'CmdOrCtrl+Shift+='])
  expect(zoomIns('win32')).toEqual(['CmdOrCtrl+numadd', 'CmdOrCtrl+Plus'])
  expect(zoomIns('linux')).toEqual(['CmdOrCtrl+numadd', 'CmdOrCtrl+Plus'])

  const view = (createAppMenu('darwin') as unknown as Item[]).find((menu) => menu.label === 'View')!
  let level = 0
  const contents = {
    getZoomLevel: () => level,
    setZoomLevel: (next: number) => {
      level = next
    },
  }
  windows.set(8, { isDestroyed: () => false, webContents: contents })
  try {
    for (const accelerator of ['CmdOrCtrl+Plus', 'CmdOrCtrl+Shift+=']) {
      view.submenu!.find((entry) => entry.accelerator === accelerator)!.click!({}, fakeWindow(8), {
        triggeredByAccelerator: true,
      })
    }
    expect(level).toBe(1)
  } finally {
    windows.delete(8)
  }
})

test('Ctrl+wheel zooms the window by the step the menu takes, and the browser pane puts its pages back after', () => {
  let level = 0
  let request: ((event: unknown, direction: 'in' | 'out') => void) | null = null
  const contents = {
    isDestroyed: () => false,
    getZoomLevel: () => level,
    setZoomLevel: (next: number) => {
      level = next
    },
    on: (event: string, listener: typeof request) => {
      if (event === 'zoom-changed') request = listener
    },
  } as unknown as Electron.WebContents
  const after: number[] = []
  setAfterWindowZoom(() => after.push(level))
  try {
    zoomWithWheel(contents)
    request!({}, 'in')
    request!({}, 'out')
    request!({}, 'out')
    expect(after).toEqual([0.5, 0, -0.5])
  } finally {
    setAfterWindowZoom(null)
  }
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

test('on Windows and Linux Ctrl+W leaves the last chat window open, and the menu item still closes it', () => {
  const chat = fakeWindow(1)
  setChatWindowsForCloseChord(() => [chat])
  try {
    for (const platform of ['win32', 'linux'] as const) {
      const item = closeItem(platform)
      expect({ label: item.label, role: item.role, accelerator: item.accelerator }).toEqual({
        label: 'Close Window',
        role: undefined,
        accelerator: 'Ctrl+W',
      })
      item.click!(undefined, chat, { triggeredByAccelerator: true })
      expect(chat.closed).toBe(0)
    }
    closeItem('win32').click!(undefined, chat, { triggeredByAccelerator: false })
    expect(chat.closed).toBe(1)
  } finally {
    setChatWindowsForCloseChord(null)
  }
})

test('Ctrl+W still closes a pop-out, and one of two chat windows', () => {
  const chat = fakeWindow(1)
  const popOut = fakeWindow(2)
  const second = fakeWindow(3)
  const open = [chat]
  setChatWindowsForCloseChord(() => open)
  try {
    const item = closeItem('linux')
    item.click!(undefined, popOut, { triggeredByAccelerator: true })
    expect(popOut.closed).toBe(1)
    open.push(second)
    item.click!(undefined, second, { triggeredByAccelerator: true })
    expect(second.closed).toBe(1)
  } finally {
    setChatWindowsForCloseChord(null)
  }
})

test('on macOS the close item stays the role, whose Cmd+W leaves the app running', () => {
  const item = closeItem('darwin')
  expect(item.role).toBe('close')
  expect(item.click).toBeUndefined()
})
