import assert from 'node:assert/strict'

import { afterEach, test, vi } from 'vitest'

import {
  MONO_FONT_STACK,
  UI_FONT_STACK,
  applyAppearanceFonts,
  currentCodeFontStack,
  followCodeFont,
  remeasureWhenMonoFontLoads,
} from './fonts'

// A stand-in for `document.fonts`: `load` and `ready` settle when the test says
// so, and `loadingdone` is an ordinary event the test can fire.
function stubFontFaceSet() {
  let settle: () => void = () => undefined
  const settled = new Promise<void>((resolve) => {
    settle = resolve
  })
  const target = new EventTarget()
  const fonts = Object.assign(target, {
    load: vi.fn((_font: string) => settled.then(() => [])),
    ready: settled,
  })
  vi.stubGlobal('document', { fonts })
  return { fonts, settle, loadingDone: () => target.dispatchEvent(new Event('loadingdone')) }
}

const flush = () => new Promise((resolve) => setTimeout(resolve, 0))

// A stand-in for <html>: the custom properties written on its style.
function fakeRoot() {
  const properties = new Map<string, string>()
  const style = {
    setProperty: (name: string, value: string) => void properties.set(name, value),
    removeProperty: (name: string) => void properties.delete(name),
  }
  return { root: { style } as unknown as HTMLElement, properties }
}

afterEach(() => {
  // The code font is the window's: put the default back for the next case.
  applyAppearanceFonts(fakeRoot().root, { interfaceFont: '', codeFont: '' })
  vi.unstubAllGlobals()
})

test('re-measures once the mono face has loaded, not before', async () => {
  // The pop-out editor mounts before JetBrains Mono arrives; the widths it
  // cached then are the fallback's, so the re-measure has to wait for the face.
  const { fonts, settle } = stubFontFaceSet()
  const remeasure = vi.fn()
  remeasureWhenMonoFontLoads(remeasure)
  await flush()
  assert.equal(remeasure.mock.calls.length, 0)
  assert.match(String(fonts.load.mock.calls[0]?.[0]), /JetBrains Mono/)

  settle()
  await flush()
  assert.equal(remeasure.mock.calls.length, 1)
})

test('re-measures again whenever a later face finishes loading', async () => {
  const { settle, loadingDone } = stubFontFaceSet()
  const remeasure = vi.fn()
  remeasureWhenMonoFontLoads(remeasure)
  settle()
  await flush()
  loadingDone()
  assert.equal(remeasure.mock.calls.length, 2)
})

test('an editor disposed before the font arrives is never re-measured', async () => {
  // The unsubscribe goes to the editor's onDidDispose: a disposed editor's
  // Monaco may be gone, and a late font must not reach into it.
  const { settle, loadingDone } = stubFontFaceSet()
  const remeasure = vi.fn()
  const dispose = remeasureWhenMonoFontLoads(remeasure)
  dispose()
  settle()
  await flush()
  loadingDone()
  assert.equal(remeasure.mock.calls.length, 0)
})

test('is a no-op where there is no FontFaceSet', () => {
  vi.stubGlobal('document', {})
  const remeasure = vi.fn()
  const dispose = remeasureWhenMonoFontLoads(remeasure)
  dispose()
  assert.equal(remeasure.mock.calls.length, 0)
})

test('a chosen font overrides the value of its family token, ahead of the bundled stack', () => {
  const { root, properties } = fakeRoot()
  applyAppearanceFonts(root, { interfaceFont: 'IBM Plex Sans', codeFont: 'Fira Code' })
  assert.equal(properties.get('--sem-font-family-ui'), `"IBM Plex Sans", ${UI_FONT_STACK}`)
  assert.equal(properties.get('--sem-font-family-mono'), `"Fira Code", ${MONO_FONT_STACK}`)
  assert.equal(currentCodeFontStack(), `"Fira Code", ${MONO_FONT_STACK}`)
})

test('back at the default, the override goes and the token’s own value stands', () => {
  const { root, properties } = fakeRoot()
  applyAppearanceFonts(root, { interfaceFont: 'IBM Plex Sans', codeFont: 'Fira Code' })
  applyAppearanceFonts(root, { interfaceFont: '', codeFont: '' })
  assert.equal(properties.size, 0)
  assert.equal(currentCodeFontStack(), MONO_FONT_STACK)
})

test('a value that tries to leave the declaration is written as one quoted name', () => {
  const { root, properties } = fakeRoot()
  applyAppearanceFonts(root, { interfaceFont: 'x"; } body { display: none', codeFont: '' })
  assert.equal(properties.get('--sem-font-family-ui'), `"x body display: none", ${UI_FONT_STACK}`)
})

test('an open terminal or editor gets a new code font once its face has loaded', async () => {
  const { fonts, settle } = stubFontFaceSet()
  const apply = vi.fn()
  const unfollow = followCodeFont(apply)
  settle()
  await flush()
  assert.deepEqual(apply.mock.calls, [[MONO_FONT_STACK]], 'the face in force, once loaded')

  applyAppearanceFonts(fakeRoot().root, { interfaceFont: '', codeFont: 'Iosevka' })
  await flush()
  assert.deepEqual(apply.mock.calls.at(-1), [`"Iosevka", ${MONO_FONT_STACK}`])
  assert.match(String(fonts.load.mock.calls.at(-1)?.[0]), /^13px "Iosevka"/)
  unfollow()
})

test('a code font replaced before its face loaded is never delivered', async () => {
  const { settle } = stubFontFaceSet()
  const apply = vi.fn()
  const unfollow = followCodeFont(apply)
  applyAppearanceFonts(fakeRoot().root, { interfaceFont: '', codeFont: 'Iosevka' })
  applyAppearanceFonts(fakeRoot().root, { interfaceFont: '', codeFont: 'Fira Code' })
  settle()
  await flush()
  assert.deepEqual(apply.mock.calls, [[`"Fira Code", ${MONO_FONT_STACK}`]])
  unfollow()
})

test('a surface that stopped following hears nothing more', async () => {
  const { settle } = stubFontFaceSet()
  const apply = vi.fn()
  followCodeFont(apply)()
  applyAppearanceFonts(fakeRoot().root, { interfaceFont: '', codeFont: 'Iosevka' })
  settle()
  await flush()
  assert.equal(apply.mock.calls.length, 0)
})
