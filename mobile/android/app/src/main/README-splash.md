# Android splash & appearance — native resources are the source of truth

`android/` is checked in, so `expo.splash` in `app.json` is **inert**. The
values that actually ship are resource-qualified here:

| What | Where |
|---|---|
| Follow the system appearance | `res/values/styles.xml` → `Theme.AppCompat.DayNight`, plus `uiMode` in the activity's `configChanges` (gives the live flip with no restart) |
| Splash background | `res/values/colors.xml` (light) and `res/values-night/colors.xml` (dark) → `splashscreen_background` |
| Splash logo | `res/drawable-*/splashscreen_logo.png` (light) and `res/drawable-night-*/splashscreen_logo.png` (dark) |
| Wiring | `res/drawable/ic_launcher_background.xml` layers `@color/splashscreen_background` under `@drawable/splashscreen_logo` |

`app.json` only records the light half. **Do not run `expo prebuild`** — see
`ios/SprintEngine/README-splash.md` for why.
