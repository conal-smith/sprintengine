import { clientSupports } from '../clientCapabilities'

// The default chords a browser tab keeps for itself (phase 9 spec, 4.2;
// decision R54). In a browser tab the browser sees a chord before the page:
// Primary+W closes the tab, Primary+N opens a window, Primary+1…9 and
// Ctrl+Tab switch tabs, Primary+, opens the browser's own preferences. A
// default on one of those would silently never fire, so a shell with no app
// menu of its own (a browser tab) swaps it for an Alt-based chord the browser
// leaves alone. These are defaults only: a person's own binding still wins,
// and the shortcut sheet and every label read the swapped chord.

const SWAPS: Readonly<Record<string, string | null>> = {
  'Primary+W': 'Alt+W',
  'Primary+Shift+W': 'Alt+Shift+W',
  // The browser's own reopen-closed-tab.
  'Primary+Shift+T': 'Alt+Shift+T',
  'Primary+N': 'Alt+N',
  'Primary+,': 'Alt+,',
  'Ctrl+Tab': 'Alt+]',
  'Meta+Shift+]': 'Alt+]',
  'Ctrl+Shift+Tab': 'Alt+[',
  'Meta+Shift+[': 'Alt+[',
  'Meta+Alt+ArrowRight': 'Alt+Shift+]',
  'Meta+Alt+ArrowLeft': 'Alt+Shift+[',
  'Primary+`': 'Alt+`',
  'Primary+Shift+`': 'Alt+Shift+`',
  // A private window in one browser; the palette keeps Primary+K.
  'Primary+Shift+P': null,
  // A new browser tab; the pane's "+" is a click away.
  'Primary+T': null,
}

function swap(chord: string): string | null {
  if (Object.hasOwn(SWAPS, chord)) return SWAPS[chord]
  const workspace = /^Primary\+([1-9])$/u.exec(chord)
  return workspace ? `Alt+${workspace[1]}` : chord
}

/** A command's default chords as this shell can actually receive them. */
export function defaultKeybindingsHere(
  defaults: readonly string[],
  browserTab: boolean = !clientSupports('app-menu'),
): readonly string[] {
  if (!browserTab) return defaults
  const swapped: string[] = []
  for (const chord of defaults) {
    const next = swap(chord)
    if (next !== null && !swapped.includes(next)) swapped.push(next)
  }
  return swapped
}
