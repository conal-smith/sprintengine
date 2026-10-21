import { useEffect, useState } from 'react'

import { fontStackFor } from './fontFamilyPreference'

// The two default stacks, as the design system declares them
// (`--sem-font-family-ui` and `--sem-font-family-mono` in
// design-system/foundations/tokens.css). The primary faces, Inter and JetBrains
// Mono, are bundled with the app (the @fontsource imports at the top of
// assets/index.css); the rest are platform fallbacks for a face that fails to
// load. Settings ▸ Appearance can put a chosen family in front of either stack
// (`applyAppearanceFonts`), never in place of it.
export const UI_FONT_STACK = 'Inter, "SF Pro Text", "Segoe UI", Roboto, Helvetica, Arial, sans-serif'
export const MONO_FONT_STACK =
  '"JetBrains Mono", ui-monospace, SFMono-Regular, "SF Mono", "Cascadia Code", Menlo, Consolas, monospace'

// The code stack in force. CSS surfaces read it from `--sem-font-family-mono`;
// the surfaces that take a `fontFamily` string rather than CSS — xterm
// terminals and Monaco editors — read it here, through `followCodeFont` or
// `useCodeFontFamily`, so a change in Settings reaches an editor or a terminal
// that is already open.
let codeFontStack = MONO_FONT_STACK
const codeFontListeners = new Set<() => void>()

/** The code stack in force, whether or not its face has loaded yet. */
export const currentCodeFontStack = (): string => codeFontStack

function setCodeFontStack(stack: string): void {
  if (stack === codeFontStack) return
  codeFontStack = stack
  for (const listener of codeFontListeners) listener()
}

function writeFontVariable(root: HTMLElement, variable: string, preference: string, defaultStack: string): string {
  const stack = fontStackFor(preference, defaultStack)
  // At the default the override goes, so the design system's own value (and
  // any later change to it) is what stands.
  if (stack === defaultStack) root.style.removeProperty(variable)
  else root.style.setProperty(variable, stack)
  return stack
}

/**
 * Settings ▸ Appearance's two fonts, applied by overriding the VALUE of the two
 * family tokens on <html>. Everything typeset in CSS follows from the
 * cascade; the terminals and editors follow `currentCodeFontStack`.
 */
export function applyAppearanceFonts(root: HTMLElement, fonts: { interfaceFont: string; codeFont: string }): void {
  writeFontVariable(root, '--sem-font-family-ui', fonts.interfaceFont, UI_FONT_STACK)
  setCodeFontStack(writeFontVariable(root, '--sem-font-family-mono', fonts.codeFont, MONO_FONT_STACK))
}

const loadFontStack = async (stack: string): Promise<void> => {
  if (typeof document === 'undefined' || !('fonts' in document)) return
  await document.fonts.load(`13px ${stack}`).catch(() => undefined)
  await document.fonts.ready.catch(() => undefined)
}

// Kept in step with the size the terminals draw at (createStudioTerminal): a
// terminal that fits itself against a fallback face reflows once the real one
// lands.
export const waitForMonoFontReady = (): Promise<void> => loadFontStack(codeFontStack)

/**
 * Hands `apply` the code stack once its face has loaded, and again each time
 * Settings changes it — again only once the new face has loaded, so a surface
 * that measures its cells or its glyphs (a terminal, an editor) never measures
 * a fallback. A stack replaced before its face arrived is never delivered.
 * Returns the unsubscribe.
 */
export function followCodeFont(apply: (stack: string) => void): () => void {
  let disposed = false
  let delivered: string | null = null
  const sync = (): void => {
    const stack = codeFontStack
    void loadFontStack(stack).then(() => {
      if (disposed || stack !== codeFontStack || stack === delivered) return
      delivered = stack
      apply(stack)
    })
  }
  codeFontListeners.add(sync)
  sync()
  return () => {
    disposed = true
    codeFontListeners.delete(sync)
  }
}

/**
 * The code stack for a Monaco editor's `fontFamily` option. It changes only
 * once the new face has loaded, so the editor's re-measure on `updateOptions`
 * reads the face it will draw.
 */
export function useCodeFontFamily(): string {
  const [stack, setStack] = useState(codeFontStack)
  useEffect(() => followCodeFont(setStack), [])
  return stack
}

// Monaco measures its font once per window, caches the widths, and draws the
// caret and the selection by those cached widths rather than by the glyphs the
// browser actually paints. A window that mounts an editor before JetBrains Mono
// has loaded — a freshly opened pop-out editor or diff window, whose font file
// is still being read when the editor is already there — measures a
// fallback face and keeps those numbers after the real face swaps in. Where the
// fallback is Consolas (Windows) it is about 8% narrower, so by the twelfth
// column a double-clicked word is highlighted a character to the left of where
// it is drawn, and the caret sits a character left of where typing lands.
// Re-measuring once the mono face is ready, and again whenever a later face
// finishes loading, puts the cached widths back on the painted ones. Returns
// the unsubscribe; pass it to the editor's `onDidDispose`.
export const remeasureWhenMonoFontLoads = (remeasure: () => void): (() => void) => {
  if (typeof document === 'undefined' || !('fonts' in document)) return () => undefined
  let disposed = false
  const run = () => {
    if (!disposed) remeasure()
  }
  void waitForMonoFontReady().then(run)
  document.fonts.addEventListener('loadingdone', run)
  return () => {
    disposed = true
    document.fonts.removeEventListener('loadingdone', run)
  }
}

// The same, shaped as a Monaco `onMount` handler (it also fits a diff editor's
// mount), so every editor in the app wires it the one way.
export const remeasureMonacoFontsOnLoad = (
  editor: { onDidDispose: (listener: () => void) => unknown },
  monaco: { editor: { remeasureFonts: () => void } },
): void => {
  editor.onDidDispose(remeasureWhenMonoFontLoads(() => monaco.editor.remeasureFonts()))
}
