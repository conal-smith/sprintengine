import { DefaultTheme, type Theme as NavigationTheme } from "@react-navigation/native";
import type { NativeStackNavigationOptions } from "@react-navigation/native-stack";

import { motionDurations } from "../components/motion";
import type { Theme } from "../theme/tokens";

/**
 * React Navigation paints the scene background and the gesture-driven card
 * shadow itself, so it needs the palette too. Everything else — headers, tab bar
 * — is drawn by our own components off the same tokens.
 */
export function createNavigationTheme(theme: Theme): NavigationTheme {
  return {
    dark: theme.isDark,
    colors: {
      // Neutral: nothing in navigation chrome wears the brand green.
      primary: theme.colors.textPrimary,
      background: theme.colors.bgApp,
      card: theme.colors.bgSurface,
      text: theme.colors.textPrimary,
      border: theme.colors.borderSubtle,
      notification: theme.colors.toneError,
    },
    fonts: DefaultTheme.fonts,
  };
}

/**
 * One transition, inside the desktop motion budget, and none at all when the
 * phone asks for reduced motion. `animationDuration` is honored on iOS; Android
 * runs the platform's own slide, which is already inside the budget.
 */
export function stackScreenOptions(reducedMotion: boolean): NativeStackNavigationOptions {
  return {
    headerShown: false,
    animation: reducedMotion ? "none" : "slide_from_right",
    animationDuration: motionDurations.slow,
  };
}
