import { useEffect, useLayoutEffect, useState } from 'react'
import { useWorkspaceStore } from '../store/workspaceStore'
import { clientSupports } from '../clientCapabilities'
import { setClockFormat } from '../utils/clockFormat'
import { applyAppearanceFonts } from '../utils/fonts'
import { setReplyStreaming } from '../utils/replyStreaming'
import {
  colorSchemeForResolvedTheme,
  DEFAULT_CHAT_CONTRAST,
  effectiveWindowMaterial,
  LIGHT_SURFACE_THEMES,
  normalizeChatContrast,
  type AppearanceSettings,
  type AppTheme,
  type ChatWidth,
  type ColorScheme,
  type ResolvedAppTheme,
  type WindowMaterial,
} from '../types/appTheme'

export type { ResolvedAppTheme }

const LIGHT_MEDIA_QUERY = '(prefers-color-scheme: light)'

function prefersLight(): boolean {
  if (typeof window === 'undefined' || typeof window.matchMedia !== 'function') {
    return false
  }
  return window.matchMedia(LIGHT_MEDIA_QUERY).matches
}

function resolveTheme(theme: AppTheme): ResolvedAppTheme {
  if (theme === 'system') return prefersLight() ? 'light' : 'dark'
  return theme
}

// Writes the two appearance attributes <html> carries. `data-theme` selects the
// theme block in index.css; `data-mode` selects the light/dark tier of the
// design-system bundle that index.css's base and light blocks alias. They must
// be written together — the bundle's polarity is the inverse of the app's (its
// bare :root is light, ours is Dark), so a `data-theme` written without a
// matching `data-mode` resolves every aliased surface to the wrong mode.
//
// The boot script in src/renderer/public/boot-theme.js stamps the same pair before any
// CSS evaluates; it cannot import this module, so it repeats the rule.
function applyThemeAttributes(resolved: ResolvedAppTheme): void {
  if (typeof document === 'undefined') return
  document.documentElement.setAttribute('data-theme', resolved)
  document.documentElement.setAttribute('data-mode', LIGHT_SURFACE_THEMES.includes(resolved) ? 'light' : 'dark')
}

function applyTheme(resolved: ResolvedAppTheme, mirrorToMain: boolean): void {
  if (typeof document === 'undefined') return
  applyThemeAttributes(resolved)
  if (!mirrorToMain) return
  // Mirror the resolved light/dark scheme to main so newly-spawned agent CLIs
  // launch matching the app surface (e.g. Claude Code's --settings theme).
  // Best-effort: the API is absent in non-Electron/test contexts.
  void window.api?.setColorScheme?.(colorSchemeForResolvedTheme(resolved))
  // An opaque window's background colour is the theme's canvas, so a theme
  // change re-pushes the material with the new colour.
  pushWindowMaterial(useWorkspaceStore.getState().appSettings.appearance.windowMaterial)
}

// The active theme's canvas (`--bg-app`) as `#rrggbb` — the colour main paints
// an opaque window before the renderer has drawn, so a new window or a resize
// that outruns the renderer shows the theme's own ground rather than a fixed
// dark one. Undefined when the value is not a plain opaque hex (main then
// keeps the colour it already has).
function themeCanvasColor(): string | undefined {
  if (typeof document === 'undefined' || typeof getComputedStyle !== 'function') return undefined
  const value = getComputedStyle(document.documentElement).getPropertyValue('--bg-app').trim()
  return /^#[0-9a-f]{6}$/i.test(value) ? value : undefined
}

// A shell with no native window to dress (a browser tab) is always solid:
// glass there would be a transparent canvas over nothing.
function windowMaterialHere(material: WindowMaterial): WindowMaterial {
  return clientSupports('window-controls') ? effectiveWindowMaterial(material, window.api?.platform) : 'solid'
}

function pushWindowMaterial(material: WindowMaterial): void {
  const effective = windowMaterialHere(material)
  // Mirror to main: persists for pre-boot application on the next launch and
  // re-applies the window-level material to live windows. Best-effort outside
  // Electron. The theme's canvas goes with glass too: a glass workspace window
  // ignores it, but the opaque aux and diagnostics windows open on it.
  void window.api?.setWindowMaterial?.(effective, themeCanvasColor())
}

function applyWindowMaterial(material: WindowMaterial, mirrorToMain: boolean): void {
  if (typeof document === 'undefined') return
  // Glass is macOS-only and resolves to tinted elsewhere, so a synced/copied
  // profile can never leave a translucent canvas over a non-vibrant window.
  const effective = windowMaterialHere(material)
  if (effective === 'solid') {
    document.documentElement.removeAttribute('data-window-material')
  } else {
    document.documentElement.setAttribute('data-window-material', effective)
  }
  if (effective === 'glass') {
    // The boot script's opaque pre-paint on <html> would sit in front of the
    // window vibrancy; clear it so the frost shows (body carries the tint).
    document.documentElement.style.backgroundColor = ''
  }
  if (mirrorToMain) pushWindowMaterial(material)
}

/**
 * The chat's two appearance settings, on <html> like the theme: the chat reads
 * them through CSS (the chat rules in assets/index.css), so every chat pane —
 * local or a paired machine's — follows without a prop, and live.
 *
 * `data-chat-width` selects the column cap. Contrast is a number, not a
 * choice, so it travels as two percentages: how much of each ink to keep
 * against the background (under 100) and how far to push it past the theme's
 * strongest ink (over 100). Half the distance at the top of the ramp, not all
 * of it, so a heading still sits a step above body text at 200. At the
 * default nothing is set at all, and the chat's inks are the theme's own.
 */
export function applyChatAppearance(root: HTMLElement, contrast: number, width: ChatWidth): void {
  root.setAttribute('data-chat-width', width)
  const value = normalizeChatContrast(contrast)
  if (value === DEFAULT_CHAT_CONTRAST) {
    root.removeAttribute('data-chat-contrast')
    root.style.removeProperty('--chat-contrast-keep')
    root.style.removeProperty('--chat-contrast-boost')
    return
  }
  root.setAttribute('data-chat-contrast', value < DEFAULT_CHAT_CONTRAST ? 'lower' : 'higher')
  root.style.setProperty('--chat-contrast-keep', `${Math.min(value, 100)}%`)
  root.style.setProperty('--chat-contrast-boost', `${Math.max(value - 100, 0) / 2}%`)
}

// Drives the <html data-theme="…"> attribute from the persisted preference.
// Mount once near the root of the React tree. The boot-time script in
// public/boot-theme.js applies the same logic synchronously to avoid a flash of the
// wrong theme before React mounts.
//
// `mirrorToMain` is for the window that owns the preference: a workspace
// window, where it is changed, tells main the colour scheme and the window
// material (which main saves, and applies to every workspace window). An
// auxiliary window only follows a copy of the preference, so it says nothing:
// pushed as it mounts, its copy would be re-saved and re-applied over a change
// it had not heard of yet.
export function useAppTheme({ mirrorToMain = true }: { mirrorToMain?: boolean } = {}): void {
  const theme = useWorkspaceStore((s) => s.appSettings.appearance.theme)
  const windowMaterial = useWorkspaceStore((s) => s.appSettings.appearance.windowMaterial)
  const chatContrast = useWorkspaceStore((s) => s.appSettings.appearance.chatContrast)
  const chatWidth = useWorkspaceStore((s) => s.appSettings.appearance.chatWidth)
  const interfaceFont = useWorkspaceStore((s) => s.appSettings.appearance.interfaceFont)
  const codeFont = useWorkspaceStore((s) => s.appSettings.appearance.codeFont)

  useEffect(() => {
    applyWindowMaterial(windowMaterial, mirrorToMain)
  }, [mirrorToMain, windowMaterial])

  // The Clock and Show replies settings, followed as the store changes rather
  // than after the render that changed them: a stamp re-rendered by the change
  // must already read the new clock (utils/clockFormat.ts).
  useEffect(() => {
    const follow = (appearance: AppearanceSettings) => {
      setClockFormat(appearance.clockFormat)
      setReplyStreaming(appearance.replyStreaming)
    }
    follow(useWorkspaceStore.getState().appSettings.appearance)
    return useWorkspaceStore.subscribe((state) => follow(state.appSettings.appearance))
  }, [])

  // Before paint, as the boot script (public/boot-theme.js) stamps them before the
  // first one: a chat must not draw a frame at the old width or contrast.
  useLayoutEffect(() => {
    if (typeof document === 'undefined') return
    applyChatAppearance(document.documentElement, chatContrast, chatWidth)
  }, [chatContrast, chatWidth])

  // The two fonts, before paint too, and before the panes' own effects run: a
  // terminal or an editor mounting in the same commit is built in the chosen
  // code face rather than built in the default and changed a moment later.
  useLayoutEffect(() => {
    if (typeof document === 'undefined') return
    applyAppearanceFonts(document.documentElement, { interfaceFont, codeFont })
  }, [interfaceFont, codeFont])

  useEffect(() => {
    applyTheme(resolveTheme(theme), mirrorToMain)

    if (theme !== 'system') return undefined
    if (typeof window === 'undefined' || typeof window.matchMedia !== 'function') {
      return undefined
    }
    const media = window.matchMedia(LIGHT_MEDIA_QUERY)
    const onChange = (): void => applyTheme(resolveTheme('system'), mirrorToMain)
    if (typeof media.addEventListener === 'function') {
      media.addEventListener('change', onChange)
      return () => media.removeEventListener('change', onChange)
    }
    // Safari < 14 fallback.
    media.addListener(onChange)
    return () => media.removeListener(onChange)
  }, [mirrorToMain, theme])
}

// The two hook-free halves of `useResolvedColorScheme`, for readers that are
// not inside the React tree — the module host's `watchColorScheme`, which
// publishes this same answer to module code as a subscription. Kept here, next
// to the hook, so there is one resolution rule rather than a second copy that
// drifts.
export function resolvedColorScheme(theme: AppTheme): ColorScheme {
  return colorSchemeForResolvedTheme(resolveTheme(theme))
}

/** Fires on every OS light/dark switch; returns the unsubscriber. */
export function subscribeSystemColorScheme(onChange: () => void): () => void {
  if (typeof window === 'undefined' || typeof window.matchMedia !== 'function') {
    return () => {}
  }
  const media = window.matchMedia(LIGHT_MEDIA_QUERY)
  const listener = (): void => onChange()
  if (typeof media.addEventListener === 'function') {
    media.addEventListener('change', listener)
    return () => media.removeEventListener('change', listener)
  }
  // Safari < 14 fallback.
  media.addListener(listener)
  return () => media.removeListener(listener)
}

// Resolved light/dark surface of the active theme, reactive to both an explicit
// theme change and — under `system` — an OS light/dark switch (the store value
// stays `'system'`, so the media query is the only signal). Editor surfaces that
// must pick a matching base theme read this instead of the raw preference.
export function useResolvedColorScheme(): ColorScheme {
  const theme = useWorkspaceStore((s) => s.appSettings.appearance.theme)
  const [scheme, setScheme] = useState<ColorScheme>(() => colorSchemeForResolvedTheme(resolveTheme(theme)))

  useEffect(() => {
    setScheme(colorSchemeForResolvedTheme(resolveTheme(theme)))

    if (theme !== 'system') return undefined
    if (typeof window === 'undefined' || typeof window.matchMedia !== 'function') {
      return undefined
    }
    const media = window.matchMedia(LIGHT_MEDIA_QUERY)
    const onChange = (): void => setScheme(colorSchemeForResolvedTheme(resolveTheme('system')))
    if (typeof media.addEventListener === 'function') {
      media.addEventListener('change', onChange)
      return () => media.removeEventListener('change', onChange)
    }
    // Safari < 14 fallback.
    media.addListener(onChange)
    return () => media.removeListener(onChange)
  }, [theme])

  return scheme
}

// The concrete resolved theme id of the active preference, reactive to both an
// explicit theme change and — under `system` — an OS light/dark switch (the
// store value stays `'system'`, so the media query is the only signal). Surfaces
// that key off the specific theme rather than just its light/dark scheme (e.g.
// per-theme backdrop plates) read this. Mirrors useResolvedColorScheme but
// returns the full id instead of collapsing to a scheme.
export function useResolvedTheme(): ResolvedAppTheme {
  const theme = useWorkspaceStore((s) => s.appSettings.appearance.theme)
  const [resolved, setResolved] = useState<ResolvedAppTheme>(() => resolveTheme(theme))

  useEffect(() => {
    setResolved(resolveTheme(theme))

    if (theme !== 'system') return undefined
    if (typeof window === 'undefined' || typeof window.matchMedia !== 'function') {
      return undefined
    }
    const media = window.matchMedia(LIGHT_MEDIA_QUERY)
    const onChange = (): void => setResolved(resolveTheme('system'))
    if (typeof media.addEventListener === 'function') {
      media.addEventListener('change', onChange)
      return () => media.removeEventListener('change', onChange)
    }
    // Safari < 14 fallback.
    media.addListener(onChange)
    return () => media.removeListener(onChange)
  }, [theme])

  return resolved
}

// Monaco ships only a light (`vs`) and dark (`vs-dark`) built-in base theme, so
// map the active app theme's surface onto the matching one. Without this an
// editor renders its hard-coded dark canvas inside a light app — the mismatch
// users see as a "dark panel" spawned from a light window (and the reverse).
export function useMonacoBaseTheme(): 'vs' | 'vs-dark' {
  return useResolvedColorScheme() === 'light' ? 'vs' : 'vs-dark'
}
