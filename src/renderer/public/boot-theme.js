// The theme pre-paint, run as a classic blocking script before any CSS
// evaluates. A file rather than an inline script so the web client's
// Content-Security-Policy needs no 'unsafe-inline' for scripts (phase 9
// spec, 3.1). Served from the renderer's public directory beside index.html,
// in the desktop build and the web build alike.
//
// Apply the persisted theme before any CSS evaluates so the user never
// sees a flash of the wrong theme. Mirrors the resolution rules in
// src/renderer/src/hooks/useAppTheme.ts.
//
// No theme-id allow-list here on purpose: the React-side store
// normalizer (normalizeAppearanceSettings in settingsSlice.ts) is the
// single source of truth for valid ids. Worst case: a corrupt
// persisted value falls through to a missing data-theme block,
// which inherits the default :root (Dark) until React mounts and
// the normalizer rewrites it. One frame, theme-list-agnostic.
//
// Adding a new DARK theme never touches this file — only
// src/renderer/src/types/appTheme.ts (one row) and index.css (one
// :root[data-theme="..."] block). A new LIGHT-surface theme adds a row to
// LIGHT_SURFACES below, which drives both the canvas pre-paint and the
// data-mode stamp.
;(function () {
  // The light-surface themes, mapped to the canvas colour to pre-paint.
  // Membership must match LIGHT_SURFACE_THEMES in types/appTheme.ts (this
  // script runs before any bundle exists, so it cannot import it).
  var LIGHT_SURFACES = {
    light: '#f6f6f4',
    vellum: '#e8e0d0',
    herbarium: '#d4dcc0',
    paper: '#f4f1e8',
    'catppuccin-latte': '#dce0e8',
  }
  // The design-system bundle imported by index.css keys its dark values
  // off data-mode; its bare :root is the LIGHT tier, the inverse of this
  // app's dark-default :root. Without this attribute the first frame
  // resolves a dark theme's aliased surfaces to the bundle's light
  // values — the white flash this whole script exists to prevent.
  // hasOwnProperty, not a truthiness check: a corrupt persisted value of
  // `constructor` or `toString` would otherwise inherit off Object and
  // stamp a light canvas over a dark theme.
  function isLightSurface(theme) {
    return Object.prototype.hasOwnProperty.call(LIGHT_SURFACES, theme)
  }
  function applyThemeAttributes(theme) {
    document.documentElement.setAttribute('data-theme', theme)
    document.documentElement.setAttribute('data-mode', isLightSurface(theme) ? 'light' : 'dark')
  }
  try {
    var KEY = 'sprintengine-app-settings'
    var raw = window.localStorage.getItem(KEY)
    var persisted = raw ? JSON.parse(raw) : null
    var theme =
      persisted &&
      persisted.state &&
      persisted.state.appSettings &&
      persisted.state.appSettings.appearance &&
      persisted.state.appSettings.appearance.theme
    if (!theme || theme === 'system') {
      // The theme the person chose for each side of the OS's switch
      // (systemLightTheme / systemDarkTheme), Light and Dark when none is
      // stored. Mirrors resolveAppTheme() in types/appTheme.ts.
      var stored = persisted && persisted.state && persisted.state.appSettings && persisted.state.appSettings.appearance
      var mql = window.matchMedia && window.matchMedia('(prefers-color-scheme: light)')
      theme =
        mql && mql.matches
          ? (stored && typeof stored.systemLightTheme === 'string' && stored.systemLightTheme) || 'light'
          : (stored && typeof stored.systemDarkTheme === 'string' && stored.systemDarkTheme) || 'dark'
    }
    applyThemeAttributes(theme)
    // Window material must be stamped just as synchronously: main
    // already created the window with vibrancy (glass) or the theme's
    // opaque canvas (tinted, solid), so a late attribute would flash the
    // wrong canvas. Same no-allow-list stance as the theme — the store
    // normalizer owns validity.
    var material =
      persisted &&
      persisted.state &&
      persisted.state.appSettings &&
      persisted.state.appSettings.appearance &&
      persisted.state.appSettings.appearance.windowMaterial
    // Mirrors effectiveWindowMaterial() in types/appTheme.ts: an explicit
    // solid or tinted is kept; anything else (glass, or nothing persisted
    // on a first launch) is the platform default — glass on macOS,
    // tinted where there is no vibrancy. A browser tab has no window
    // material at all (no preload put a `window.api` here before this
    // script): solid, or a Mac browser would draw a transparent canvas
    // over nothing.
    var inBrowserTab = typeof window.api === 'undefined'
    var effective = inBrowserTab
      ? 'solid'
      : material === 'solid' || material === 'tinted'
        ? material
        : navigator.platform.indexOf('Mac') === 0
          ? 'glass'
          : 'tinted'
    var glass = effective === 'glass'
    if (effective !== 'solid') {
      document.documentElement.setAttribute('data-window-material', effective)
    }
    // Paint the canvas background immediately (before the bundled CSS
    // loads) so first launch never flashes the wrong scale. The exact
    // per-theme bg takes over once index.css applies; this is just the
    // pre-paint guard. Each LIGHT_SURFACES theme pre-paints its own warm
    // or cool canvas so a light theme never flashes the dark ink scale;
    // everything else falls through to the dark ink scale. Under glass
    // the canvas must stay unpainted — an opaque html background would
    // sit in front of the window vibrancy and block the frost.
    if (!glass) {
      document.documentElement.style.backgroundColor = isLightSurface(theme) ? LIGHT_SURFACES[theme] : '#08090b'
    }
    // The chat's width and text contrast, stamped as early for the same
    // reason: a restored chat would otherwise draw one frame at full
    // width and the theme's own contrast. Mirrors applyChatAppearance()
    // in hooks/useAppTheme.ts and normalizeChatContrast() in
    // types/appTheme.ts (85–200 in steps of 5, 100 is the default).
    var appearance =
      persisted && persisted.state && persisted.state.appSettings && persisted.state.appSettings.appearance
    // No stored appearance at all is a new install, which opens on
    // Comfortable; a stored one without a width predates the setting and
    // keeps Full (DEFAULT_CHAT_WIDTH and LEGACY_CHAT_WIDTH in types/appTheme.ts).
    var chatWidth = appearance ? appearance.chatWidth : 'comfortable'
    document.documentElement.setAttribute(
      'data-chat-width',
      chatWidth === 'comfortable' || chatWidth === 'wide' ? chatWidth : 'full',
    )
    var chatContrast = appearance && appearance.chatContrast
    if (typeof chatContrast === 'number' && isFinite(chatContrast)) {
      chatContrast = Math.min(200, Math.max(85, Math.round(chatContrast / 5) * 5))
      if (chatContrast !== 100) {
        document.documentElement.setAttribute('data-chat-contrast', chatContrast < 100 ? 'lower' : 'higher')
        document.documentElement.style.setProperty('--chat-contrast-keep', Math.min(chatContrast, 100) + '%')
        document.documentElement.style.setProperty('--chat-contrast-boost', Math.max(chatContrast - 100, 0) / 2 + '%')
      }
    }
  } catch {
    applyThemeAttributes('dark')
    document.documentElement.style.backgroundColor = '#08090b'
  }
})()
