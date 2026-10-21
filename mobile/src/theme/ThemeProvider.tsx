import { createContext, useContext, useEffect, useMemo, useState, type ReactNode } from "react";
import { Appearance, useColorScheme, type ColorSchemeName } from "react-native";

import { themes, type Theme, type ThemeName } from "./tokens";

export type ThemePreference = "system" | ThemeName;

export const themePreferences: readonly ThemePreference[] = ["system", "light", "dark"];

export const themePreferenceLabel: Record<ThemePreference, string> = {
  system: "System",
  light: "Light",
  dark: "Dark",
};

export interface ThemePreferenceStore {
  getPreference(): Promise<ThemePreference | null>;
  savePreference(preference: ThemePreference): Promise<void>;
  /**
   * Settings → Appearance → Agent characters. Optional so a store that keeps
   * no such thing (the screenshot harness) leaves the characters on.
   */
  getAgentCharacters?(): Promise<boolean | null>;
  saveAgentCharacters?(enabled: boolean): Promise<void>;
}

interface ThemeContextValue {
  theme: Theme;
  preference: ThemePreference;
  setPreference: (preference: ThemePreference) => void;
  /** True once a write was rejected: the choice applies now but will not survive a relaunch. */
  isPreferenceUnsaved: boolean;
  agentCharacters: boolean;
  setAgentCharacters: (enabled: boolean) => void;
}

const ThemeContext = createContext<ThemeContextValue | null>(null);

// Two themes, the site's: Light follows the phone's light appearance and Dark
// its dark one. An unknown or unspecified scheme resolves to Dark, matching the
// desktop's bare `:root` default.
export function resolveTheme(preference: ThemePreference, colorScheme: ColorSchemeName): Theme {
  if (preference !== "system") {
    return themes[preference];
  }
  return colorScheme === "light" ? themes.light : themes.dark;
}

export function ThemeProvider({ store, children }: { store: ThemePreferenceStore; children: ReactNode }) {
  const colorScheme = useColorScheme();
  const [preference, setPreferenceState] = useState<ThemePreference>("system");
  const [isPreferenceUnsaved, setIsPreferenceUnsaved] = useState(false);
  // On until the person turns them off, as on the desktop.
  const [agentCharacters, setAgentCharactersState] = useState(true);

  useEffect(() => {
    let isMounted = true;

    // A storage read that fails means no override could be recovered, which is
    // the same state as never having set one: keep following the system. The
    // resolved theme stays visible in Settings, so the fallback is observable
    // rather than silent.
    void store
      .getPreference()
      .catch(() => null)
      .then((stored) => {
        if (isMounted && stored) {
          setPreferenceState(stored);
        }
      });
    void Promise.resolve(store.getAgentCharacters?.())
      .catch(() => null)
      .then((stored) => {
        if (isMounted && typeof stored === "boolean") {
          setAgentCharactersState(stored);
        }
      });

    return () => {
      isMounted = false;
    };
  }, [store]);

  // A pinned override has to reach the native appearance too, or UIKit chrome we
  // do not render ourselves — the keyboard, the text-selection handles and menu
  // across the app's TextInputs — stays on the phone's appearance while the JS
  // surfaces flip. `"unspecified"` (not `null`, which RN 0.83 rejects) hands
  // control back to the OS for "system".
  //
  // This makes useColorScheme() echo the pinned value, which is harmless:
  // resolveTheme branches on `preference` first and only consults colorScheme
  // for "system", where we have just restored the real OS value.
  useEffect(() => {
    Appearance.setColorScheme(
      preference === "system" ? "unspecified" : themes[preference].isDark ? "dark" : "light",
    );
  }, [preference]);

  const value = useMemo<ThemeContextValue>(
    () => ({
      theme: resolveTheme(preference, colorScheme),
      preference,
      // Applying the choice is local; persisting it can fail (locked or
      // unavailable secure storage). Rather than swallow that, Settings tells the
      // user the theme is session-only so the missing persistence is visible.
      setPreference: (next) => {
        setPreferenceState(next);
        void store.savePreference(next).then(
          () => setIsPreferenceUnsaved(false),
          () => setIsPreferenceUnsaved(true),
        );
      },
      isPreferenceUnsaved,
      agentCharacters,
      // The same session-only fallback as the theme: the switch holds for now
      // and Settings says when it will not survive a relaunch.
      setAgentCharacters: (next) => {
        setAgentCharactersState(next);
        void Promise.resolve(store.saveAgentCharacters?.(next)).then(
          () => setIsPreferenceUnsaved(false),
          () => setIsPreferenceUnsaved(true),
        );
      },
    }),
    [preference, colorScheme, store, isPreferenceUnsaved, agentCharacters],
  );

  return <ThemeContext.Provider value={value}>{children}</ThemeContext.Provider>;
}

function useThemeContext(): ThemeContextValue {
  const value = useContext(ThemeContext);
  if (!value) {
    throw new Error("useTheme must be called inside a ThemeProvider.");
  }
  return value;
}

export function useTheme(): Theme {
  return useThemeContext().theme;
}

/** Settings owns the explicit override; every other surface only reads the theme. */
export function useThemePreference() {
  const { preference, setPreference, theme, isPreferenceUnsaved, agentCharacters, setAgentCharacters } =
    useThemeContext();
  return { preference, setPreference, resolvedTheme: theme, isPreferenceUnsaved, agentCharacters, setAgentCharacters };
}

/**
 * Whether agents are drawn as characters (Settings → Appearance). Off, an agent
 * wears the working mark while it runs and a lifecycle shape after.
 */
export function useAgentCharacters(): boolean {
  return useContext(ThemeContext)?.agentCharacters ?? true;
}

// One StyleSheet per (factory, theme) rather than per component instance: a
// board renders dozens of rows off the same factory, and RN styles are
// immutable, so the sheets are safe to share.
const styleSheetCache = new WeakMap<object, Map<ThemeName, unknown>>();

export function useThemedStyles<T>(createStyles: (theme: Theme) => T): T {
  const theme = useTheme();

  return useMemo(() => {
    let byTheme = styleSheetCache.get(createStyles);
    if (!byTheme) {
      byTheme = new Map();
      styleSheetCache.set(createStyles, byTheme);
    }

    const cached = byTheme.get(theme.name);
    if (cached !== undefined) {
      return cached as T;
    }

    const created = createStyles(theme);
    byTheme.set(theme.name, created);
    return created;
  }, [createStyles, theme]);
}
