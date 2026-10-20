# SprintEngine mobile

The phone companion for SprintEngine Studio. It pairs with Studio running on
your own computers over [Tailscale](https://tailscale.com) and lets you follow
and drive their chats from your phone: read the list of chats across every
paired desktop, open one and reply or steer it while the agent works, start a
new chat on a project, attach photos or dictate, answer an agent's questions
and approvals, look over the files a turn changed, and open the dev servers a
desktop shares on your tailnet.

There is no account, no relay and no server in between. The phone talks
directly to the Studio gateway on each paired desktop, over your tailnet, and
keeps its pairings on the device in the platform's secure storage.

It is an Expo / React Native app (Expo SDK 55, React Native 0.83) for iOS and
Android, written in TypeScript.

## Requirements

- **Node 20.19.4 or later** (Node 22 matches the rest of the repository) and npm.
- **iOS:** a Mac with Xcode 16 or later and CocoaPods. A simulator works
  without an Apple developer account; a physical iPhone needs a signing team
  (see below).
- **Android:** Android Studio with an SDK and an emulator or a device with USB
  debugging, and **JDK 17 or later** on your `JAVA_HOME` (the Gradle build
  does not pin a JDK path).
- **A Tailscale account**, with Tailscale running on the phone and on every
  computer the phone should reach.
- **SprintEngine Studio** running on at least one of those computers, to pair
  with.

## Install

From this directory:

```bash
npm ci
```

## Build and run

`ios/` and `android/` are checked in and are the source of truth for the
native projects. **Do not run `expo prebuild`**: it rewrites the splash
storyboard, the appearance variants and the hand-maintained permission strings
(see `app.json`'s `extra` notes and the `README-splash.md` in each native
folder). Edit the native files directly instead.

### iOS

```bash
npx expo run:ios                # build and launch on a simulator
npx expo run:ios --device       # build and install on a connected iPhone
```

React Native is built from source here (`ios.buildReactNativeFromSource` in
`ios/Podfile.properties.json`), so the first build takes a while.

The Xcode project carries **no development team**, so a simulator build needs
nothing, but a device build needs your own signing set up:

1. Open `ios/SprintEngine.xcworkspace` in Xcode.
2. Select the **SprintEngine** target, then **Signing & Capabilities**.
3. Choose your **Team**. With a free personal team you will also need to change
   the **Bundle Identifier** (`ai.sprintengine.mobile`) to one of your own, since
   a bundle id can only belong to one team.

Expo may offer to pick a team for you on `run:ios --device`; either way the
choice is written into `ios/SprintEngine.xcodeproj/project.pbxproj`. Keep your
`DEVELOPMENT_TEAM` line and any bundle-id change out of commits.

### Android

```bash
npx expo run:android                       # debug build on an emulator or device
npx expo run:android --variant release     # release build, installed the same way
```

To build a release APK without installing it:

```bash
cd android && ./gradlew assembleRelease
# android/app/build/outputs/apk/release/app-release.apk
```

**Release builds are signed with the debug keystore** (`android/app/debug.keystore`,
the stock React Native one) unless you configure your own. To ship a build,
create a release keystore and point `signingConfigs` in `android/app/build.gradle`
at it, keeping the keystore and its passwords out of the repository (for
example in `~/.gradle/gradle.properties`). See React Native's
[signed APK guide](https://reactnative.dev/docs/signed-apk-android).

## Pairing with Studio

1. On the computer, open Studio's **Settings** (⌘, on macOS) and go to
   **Remote**. Turn on **Remote control over your tailnet** (it needs Tailscale
   running).
2. Click **Pair a device**. If Studio offers a **Pair with** choice, pick
   **A phone or another device — make a link**, choose what the phone may do,
   and click **Create link**. Studio shows a QR code and a
   `sprintengine-tailnet://pair?…` link.
3. On the phone, tap **Pair with a desktop**, then **Scan Studio's code** and
   point the camera at the QR code, or paste the link into the box and tap
   **Pair phone**. Opening the link on the phone works too. The phone shows the
   endpoint it is about to reach; tap **Confirm desktop**.

The link is single-use and expires; possession of it is the credential, so
share it only with your own devices. Pair more desktops from the phone's
Settings (**Pair another desktop**), and cut a phone off at any time with
**Revoke** on its row in Studio's **Remote** page.

## Tests and checks

```bash
npm run ci
```

That runs, in order:

| Script | What it does |
| --- | --- |
| `npm run typecheck` | `tsc --noEmit` over the whole app. |
| `npm run lint` | ESLint with Expo's config. |
| `npm run lint:tokens` | Checks that screens use the design tokens in `src/theme/tokens.ts` rather than raw colours, spacing and font values. |
| `npm run test:mobile` | Compiles the logic modules to `.mobile-test-build/` and runs the `*.regression.test.js` suites with `node --test`. |

The tests run on plain Node with no simulator. A new suite has to be added to
the `test:mobile` list in `package.json`, and any module it loads to
`tsconfig.test.json`.

Other scripts:

- `npm run build:renderer` regenerates
  `src/components/document/rich/richRendererDocument.generated.ts`, the
  self-contained page that draws Mermaid diagrams and KaTeX maths, after you
  bump `mermaid` or `katex` or edit `src/components/document/rich/renderer/`. A
  test fails if the generated file is out of date with its inputs.
- `npm run brand:icons` recuts every launcher icon and the welcome-screen mark
  from `scripts/brand/sprintengine-se-mark-1024.png`. Never hand-edit an output.

### Working without a desktop

A build made with `EXPO_PUBLIC_VERIFY_HARNESS=1` replaces the pairing gate
with a fixture desktop (`src/__verify__/`), so every screen can be opened and
photographed without Studio. Screens are reached by deep link, for example
`sprintengine://verify/notices`; on an iOS simulator also set
`EXPO_PUBLIC_VERIFY_URL` to the link to open at launch. A normal build never
bundles the harness.

## How it talks to Studio

Everything goes to the Studio gateway on the paired desktop, over the tailnet,
under `/tailnet/v1/`:

- **Pairing and identity:** `pair` spends the one-time link for a device token;
  `identity` reports what the desktop speaks and whether the pairing still
  stands (`src/api/tailnetControlClient.ts`, `src/api/tailnetTransport.ts`).
- **Tools:** `mcp` takes JSON-RPC tool calls such as `workspace.list`,
  `workspace.snapshot` and `conversation.create`
  (`src/api/tailnetWorkspaces.ts`, `src/api/conversationLaunch.ts`).
- **Live chats:** a WebSocket per open chat, opened with a short-lived ticket
  from `ws-ticket`, streams the conversation's events
  (`src/api/tailnetConversations.ts`, `src/api/conversationWire.ts`).

Two parts of the wire are copies of Studio's own definitions and are
hash-pinned by tests so they cannot drift silently:
`src/api/conversation-protocol/` mirrors `packages/conversation-protocol/src/`,
and `src/shared/mobile-control/protocol.ts` carries the mobile-control types.
Change them together with the Studio side; the policy for wire changes is
`docs/compatibility.md` at the repository root.

`docs/conversations.md` describes how the chat list and a chat behave in
detail.

## Notes

- The URL schemes are `sprintengine://` (chat and conversation links) and
  `sprintengine-tailnet://` (pairing links Studio mints). They are declared in
  `ios/SprintEngine/Info.plist`, `android/app/src/main/AndroidManifest.xml` and
  `app.json`, and must stay in step in all three.
- Stored keys use a `multicode.mobile.*` prefix, kept from an earlier name so
  existing installs keep their pairings; `src/storage/sessionStore.ts` explains
  why it must not be renamed.
- Third-party licence notices for code bundled into the app are in
  [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md).
