# iOS splash & appearance — native files are the source of truth

`ios/` is checked in, so the `expo.splash` and `expo.userInterfaceStyle` keys in
`app.json` are **inert**. The values that actually ship live here:

| What | Where |
|---|---|
| Follow the system appearance | `Info.plist` → `UIUserInterfaceStyle` = `Automatic` |
| Splash background (light / dark) | `Images.xcassets/SplashScreenBackground.colorset/Contents.json` — a base colour plus a `luminosity: dark` appearance |
| Splash logo (light / dark) | `Images.xcassets/SplashScreenLogo.imageset/` — `image*.png` (light) and `image-dark*.png` (`luminosity: dark`) |
| Wiring | `SplashScreen.storyboard` references the *named* colour `SplashScreenBackground`, not a literal |

`app.json` only records the light half, because the `expo.splash` schema has no
dark variant on this setup (`expo-splash-screen` is not installed).

**Do not run `expo prebuild`.** On SDK 55 it rewrites `SplashScreen.storyboard`
from the centered-logo layout to the legacy full-bleed `SplashScreenLegacy`
imageset, drops both appearance variants above, re-encodes the app icon and
reformats `Info.plist`. This reproduces on a clean tree, before any local edit.
Hand-edit these files, or adopt the `expo-splash-screen` config plugin first and
re-verify the storyboard.

See `android/app/src/main/README-splash.md` for the Android half.
