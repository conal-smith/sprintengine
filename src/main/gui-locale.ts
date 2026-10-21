/**
 * An app opened from Finder or the Dock inherits launchd's environment, which
 * names no locale. Everything Studio starts (terminals, agent CLIs, git) then
 * runs in the C locale: zsh's line editor and less show non-ASCII text as
 * escapes, and pbcopy reads an agent's UTF-8 output as MacRoman.
 *
 * Only LC_CTYPE is set, so characters are UTF-8 while collation, numbers and
 * messages stay C and output Studio parses reads as it always has. C.UTF-8 is
 * missing from older supported macOS releases; en_US.UTF-8 is on all of them.
 * LANG, LC_ALL and LC_CTYPE are one group (LC_ALL overrides the others), so any
 * one of them set means the person chose a locale and it is left alone.
 */
const FALLBACK_LC_CTYPE = 'en_US.UTF-8'
const LOCALE_ENV_NAMES = ['LANG', 'LC_ALL', 'LC_CTYPE'] as const

/** The LC_CTYPE to add, or null to leave the environment as it is. */
export function missingGuiLocale(env: NodeJS.ProcessEnv, platform: NodeJS.Platform): string | null {
  if (platform !== 'darwin') return null
  if (LOCALE_ENV_NAMES.some((name) => env[name]?.trim())) return null
  return FALLBACK_LC_CTYPE
}

/** Before anything is spawned: children inherit `process.env`. */
export function ensureGuiLocale(): void {
  const lcCtype = missingGuiLocale(process.env, process.platform)
  if (lcCtype) process.env.LC_CTYPE = lcCtype
}
