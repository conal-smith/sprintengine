# SprintEngine Studio Release Checklist

A merge to main publishes nothing. Main feeds a nightly train, cut on a
schedule when there is something new to ship, and a stable release is a manual
promotion of the exact commit the latest nightly shipped. PRs merge by merge
commit, never squash or rebase, with Conventional Commit titles; see
[CONTRIBUTING.md](../CONTRIBUTING.md).

## Before merging

- Pass the required PR-title, build and JS checks. The release also runs
  `npm run verify:app` and the marketplace signature check against the exact
  source commit before it publishes.
- Select the intended version bump: `feat` means minor, `!` or a
  `BREAKING CHANGE:` footer means major from 1.x and minor while the version
  is 0.x (1.0.0 is only ever typed into a promotion's `version` input), and
  every other accepted type means patch. Maintenance-only merges also move the
  version.
  The next nightly carries the bump straight away.
- Describe user-visible changes and compatibility breaks in the PR body. The
  merge commit keeps both the title and body.
- Do not manually edit the app version. Stable tags are the release version
  ledger; the workflow stamps `package.json` before compilation and packaging.
  The committed version remains a development baseline. SDK versions are separate.
- Publish `@sprintengine/module-sdk` on its own: set its `package.json` version,
  write that version's `CHANGELOG.md` entry on top, then push an
  `sdk-v<version>` tag (`.github/workflows/sdk-publish.yml`; needs the
  `NPM_TOKEN` secret). `scripts/release/sdk-release-check.mjs` refuses a tag,
  CHANGELOG or quoted host API version that disagrees, and `npm run
  test:release` runs the same check on every pull request.
- Keep the download site's release-notes data in step with releases if using its
  version-specific What's New section.
- Keep macOS signing credentials configured: the `CSC_*` pair and `APPLE_*`
  trio. Windows uses all seven `AZURE_*` Trusted Signing secrets, or none for
  unsigned installers; a partial set fails packaging.

## Retirements To State In Release Notes

Removals an installed profile cannot be migrated through. State each in the notes
of the first release that ships it, then delete the line.

- Voice dictation, 2026-10-09: the top-bar microphone button, its shortcut
  (`voice-dictation.toggle`, and the older `voice.toggle` spelling) and the
  Settings -> Voice dictation section are removed. The feature only ever shipped
  in from-source development builds, so a packaged install loses nothing it
  showed. Its saved settings - the transcription server URL, model, language and
  bearer token - are dropped from the profile on first launch, and a custom
  shortcut saved for it is dropped when Settings -> Shortcuts is opened. The app
  no longer declares microphone use: the macOS build loses the `audio-input`
  entitlement and microphone usage description, app windows refuse microphone
  and camera requests, and the served web client's Permissions-Policy denies the
  microphone. There is no replacement.
- Attention Queue shortcut: the cross-workspace Attention Queue popover in the
  window's top-right corner was removed - the sidebar rows and the Home glyph's
  notifications already say which agents are waiting on you - and the
  `panel.attention-queue.toggle` command went with it. The command shipped
  unbound, so only a user who bound it by hand is affected: that shortcut stopped
  firing when the popover was removed, and opening Settings -> Shortcuts now
  drops the saved binding. There is no replacement shortcut.
- The Sprint Engine, 2026-09-16: the agent-looping run engine is removed from
  the application. The Sprints door, the run board and its inspector, the New
  sprint dialog, the run-backed workspace mode, the `sprint.*` MCP tools, the
  `panel.sprint-engines.toggle` shortcut and the board and New sprint shortcuts
  (`sprint-engine.*`, and the older `sprintengine.*` spellings) all go with it;
  a custom shortcut saved for any of those commands is dropped when Settings ->
  Shortcuts is opened. A board or Architect Plan tab dragged into another
  workspace is removed from its layout.
  A workspace saved in the run-backed mode is DROPPED from the Projects list -
  everything a run wrote is on disk and untouched under the workspace's
  `.sprintengine/` sidecar, so open the project as a normal chat to keep working
  on those files. A Backlog item's `sprints:` frontmatter field is no longer read
  or written; `pr:` is unchanged, and its links now resolve through the Backlog
  itself rather than through the engine. The engine returns as an installable
  capability module under the reserved id `sprint-engine`, published separately -
  the id stays claimed in this build so nothing else can take the name.
- Workflow roles, 2026-09-16: the app no longer has a concept of a role. The
  role registry, the role picker and the role brief are gone,
  and the `workflow-roles` plugin is no longer offered in the bundled
  marketplace seed. The sixteen role skills are unaffected as SKILLS - they ship
  from `sprintengine/studio-releases` and install like any other plugin. Invoke
  one from a terminal (`/architect`) instead of picking a role in the app.
- Design Wizard (the guided brief), 2026-09-08: the workspace that interviewed
  you about product, architecture and frontend and minted a `guided-brief`
  workspace is removed outright. There is no replacement flow.
  A workspace saved in that mode is DROPPED from the Projects list on first load
  - everything it wrote is on disk and untouched (`product/`, `architecture/`,
    `mockups/`, `design-system/`, `.guided-brief/`), so open the project as a normal
    chat to keep working on those files. The Settings -> Agents toggle that ran the
    design interview as chat sessions is gone and its saved value is dropped. The
    Design door, design-system bundles, the library, attach and the bundle lint are
    unaffected - they were never part of the wizard. Three Learn Center cards under
    a "Design Wizard" category are gone with it.

- Horizon and Multiloop, 2026-09-08: the two workspace modes are removed from
  the tree. A workspace saved in either mode is DROPPED from the Projects list
  on first load (`dropRetiredModeWorkspaces`, which runs on every list-entry
  path, not only in the migration rung) — everything either wrote is on disk and
  untouched, so open the project as a normal chat to keep working on those
  files. Horizon's functional leftovers go with it: two tailnet scopes no tool
  could require, a chip variant only its step rows used, and the backlog header
  action only its own start entry supplied.

- Third-party skills and MCP servers, 2026-09-08: the studio no longer
  ships anybody else's software. The bundled MCP catalogue
  (`resources/mcps/catalog.json`, sixteen servers) is deleted with its reader,
  and with it the whole `catalog` population of the Extensions door: the browse
  grid now lists the marketplace registry's plugins only, the New chat composer
  and the automation connector picker offer the MCP servers you have installed
  and no others, and the Connectors detail pane for a catalogue server is gone.
  **Nothing installed is removed or disabled** — a server already in your MCP
  settings keeps working, keeps launching and keeps syncing. What goes is the
  route to servers you had NOT installed: the sixteen are no longer offered, and
  none of them has a replacement in any plugin marketplace we recommend, so a
  card or a flow that named one now says so instead of installing it. Settings →
  Ticket trackers lists nothing of its own for the same reason and points at the
  plugin catalogue, where Jira, Linear, GitHub and GitLab live. The four signed
  first-party MCP bundles leave the marketplace index in the same change: it is
  18 rows now (13 agent CLIs, 5 automation starters) and carries no signed
  component at all.
- Plugin-source update cadence, 2026-09-08: without a GitHub token the
  studio checks each plugin source for updates **once a day** rather than once an
  hour, because anonymous GitHub allows 60 requests an hour for the whole
  machine. With a token configured the hourly cadence is unchanged. The cadence
  in force is stated beside the token field in Settings → GitHub, and a new
  "Check for updates" action on a source's overflow counts against the same
  window and says when the source was last asked.

## Channels

There are two. **Nightly** is main as it stands, a few times a day: versions
`X.Y.Z-nightly.YYYYMMDD.RUN`, published as GitHub prereleases that are never
marked latest, with `nightly.yml`, `nightly-mac.yml` and `nightly-linux.yml` as
their updater manifests. **Stable** is `X.Y.Z`, published as the latest release
with the `latest*.yml` manifests, and is always a build of a commit some nightly
already shipped (the hotfix tag below is the one exception).

`X.Y.Z` in a nightly is the version the next stable would take: the strongest
Conventional Commit since the last stable tag, applied to that tag. So a `feat`
merged in the morning shows up as a minor bump in the afternoon's nightly, and
promoting that nightly ships the same number without working it out again. A
version a tag already holds is never reused.

## What a merge to main does

Nothing, until the next nightly. CI gates the pull request as before; the
release workflow no longer listens for pushes to main.

## How a nightly is cut

`.github/workflows/release.yml` wakes every 30 minutes (minutes 7 and 37). A
scheduled run publishes only when both hold:

- at least six hours have passed since the last published nightly, and
- main has commits the last nightly did not ship (GitHub's compare of that
  nightly's commit against main is "ahead").

Otherwise the run ends in the resolve step within seconds. The one exception
is a main whose history was rewritten under the last nightly (the compare says
"behind" or "diverged"): that run fails, and keeps failing every tick, with a
message naming the nightly and its commit, so the stall is seen. Dispatch a
nightly from main to restart the train from its current head. The rule is
`scripts/release/nightly-gate.mjs`, covered by `npm run test:release`. A run is
also skipped when the latest stable already ships main's head, because a nightly
of that commit would sort below the stable.

To cut one now, dispatch the workflow from main with channel `nightly` (the
default). A dispatch skips the six-hour and new-commits checks.

Nightly runs share one concurrency group with `queue: max` and cancellation
disabled, so two runs can never build the same commit or publish out of order.

## How stable is promoted

Dispatch the workflow from main with channel `stable`. It finds the newest
published nightly, reads the commit that nightly shipped from its release body,
refuses if that commit is not on main, and builds that commit, not main's head.
Merges that land while you are checking the nightly never reach the stable.

A promotion runs the workflow file as it is on `main` against source from the
nightly's older commit. A step that calls a repository script must therefore
tolerate a checkout from before that script existed (the channel-icon step
guards on the file); otherwise the first promotion after the script lands
fails in every package job.

The stable's version is the nightly's with the train dropped:
`0.5.0-nightly.20260923.41` ships as `0.5.0`. To ship another version, set the
`version` input to any `X.Y.Z` above the latest published stable that no tag
already holds, higher or lower than the derived one: the commit markers can
overstate a change (a release-process change and an internal refactor marked
`!` derive a minor at 0.x) as well as understate it. A version below the nightly's
leaves installed nightlies ahead of the train until a later nightly passes
them, since the next nightly derives from the new stable tag.
The `vX.Y.Z` tag is created on the nightly's commit when the release publishes.

Stable runs have their own concurrency group, so a queued nightly never holds up
a promotion.

## The hotfix route

Push a tag `vX.Y.Z` to build and publish exactly that commit as stable. The
version must be above the latest published stable and must not be one a
release already holds; `package.json` is not consulted, since it stays at the
development baseline and the build stamps the tag's version. The tag must be
on main's first-parent history (tag the merge commit), because every later
nightly works out its version from the latest stable tag on main and refuses
to run while that tag sits somewhere else.

## How an installed app picks its channel

At startup the app reads its own version: a `-nightly.` build follows nightly,
anything else follows stable. Settings -> General -> Update channel overrides
that, and the choice is saved in `update-channel.json` under the app's user-data
directory. Switching re-points the updater and checks the new channel at once.
A nightly install that switches to stable is allowed to "downgrade", so it is
offered the latest stable even while its own nightly version sorts higher.

## The retired preview train

Before nightlies there was a switched-off `preview` train, and one release,
`v0.4.0-preview.20260919.2`, was published on it. Builds installed from it
follow `preview*.yml` and nothing else, so no nightly or stable reaches them.
Dispatching channel `preview` from main publishes one bridge release,
`<latest stable>-preview.YYYYMMDD.RUN`, built from main's head. The app it
installs reads no `-nightly.` in its version, follows stable, and is offered the
latest stable at its next check. Run it once after this change merges. Once the
download count of the bridge's `preview-mac.yml` stops climbing, the option and
the `preview` spelling in `scripts/release/release-lib.mjs` can go.

## Builds and publishing

Every entry point builds macOS Intel and Apple Silicon DMGs and updater ZIPs, a
Windows installer, and a Linux AppImage. All four jobs use `--publish never`.
One publisher waits for packaging and the quality gate (`npm run verify:app`
and the marketplace signature check against the exact commit), merges both Mac
updater manifests, uploads every file to a draft, then publishes it. It verifies
installers, manifests and the anonymous URLs installed apps use to discover
updates, including that a nightly is the first nightly in the feed and never
what `/releases/latest` resolves to.

The macOS legs notarize in electron-builder's `afterSign` hook
(`scripts/release/notarize-mac.mjs`), before the DMG and updater ZIP are made
from the app, so both carry the stapled ticket. Notarization is submitted
once. Stapling fetches the ticket from Apple's CloudKit service, which
sometimes drops the connection (`Failed to staple your application with code:
68`, NSURLErrorDomain -1005); a staple that fails that way is retried after
30s, 60s and 120s, four attempts in all, and the log says so. Any other staple
failure, and a fourth network failure, fails the leg. The DMG itself is not
signed, notarized or stapled; the app inside it is.

A tag left by an interrupted draft reserves its version. No version-bump commit
is pushed to main, and the workflow's own token does not trigger a second
release from the tag it creates.

The release body records `<!-- source-sha: -->`. The nightly gate and stable
promotion both read it back, so do not remove it. Public-source release notes
list changes since the preceding release on that channel. Private-source
subjects are omitted.

Set dispatch `publish=false` to keep the packages as workflow artifacts for 14
days without publishing anything. The `PREVIEW_SCHEDULE` repository variable is
no longer read and can be deleted.

## GitHub enforcement

The versioned ruleset is [main-ruleset.json](../.github/main-ruleset.json).
It requires a PR, a merge commit (no squash, no rebase), resolved
conversations and these checks from GitHub Actions: **Conventional PR title**, **Build
(ubuntu-latest)**, **Build (windows-latest)**, **Build (macos-latest)** and
**JS tests (ubuntu-latest)**. It prohibits force pushes and branch deletion,
requires checks against current main, and has no bypass actors. No additional
human approval count is imposed.

Repository settings must also set `allow_merge_commit=true`,
`allow_squash_merge=false`, `allow_rebase_merge=false`,
`merge_commit_title=PR_TITLE` and `merge_commit_message=PR_BODY`, so a merge
commit carries the PR's conventional title and body while the branch's own
commits keep their history behind it (owner ruling 2026-10-04: squash merges
lost every branch commit). Older history on main is squash commits; the release
reads main's first-parent history, so both kinds version the same way. Dependabot is configured to use
`build:` and `ci:` titles so its updates pass the same check.

For a new repository, create the PR containing the title-check workflow before
activating this ruleset, so that its required check can run. Apply the JSON with
`gh api --method POST repos/OWNER/REPO/rulesets --input .github/main-ruleset.json`;
update an existing rule with PUT at its ruleset ID. Do not create duplicate rules.
The JSON is a reproducible policy definition; editing it alone does not change
GitHub settings.

## Smoke Test

- Install on a clean Windows machine or VM. The installer is one-click and
  per-user: it shows its small progress window with the app icon, no wizard
  and no UAC prompt, installs under `%LOCALAPPDATA%\Programs`, and launches the
  app when it finishes.
- Install on macOS Intel and Apple Silicon where available.
- Install on Linux using the AppImage.
- Launch the installed app.
- Confirm Help -> Check For Updates opens Settings and performs a visible update check.
- Confirm Settings shows version, channel, packaged state, and update status.
- Confirm Settings -> General -> Update channel shows Stable on a stable build
  and Nightly on a nightly build.
- Confirm terminal sessions launch.
- Confirm Git panel reads status in a real repository.
- Confirm the Backlog door lists items in a project that has a `backlog/`.
- Confirm protocol registration for `sprintengine://` auth callbacks still works.
- Confirm a chat's "Copy link to chat" link opens that chat from a browser or a
  terminal, with the app quit, in the background, and in front.

## Update Validation

Every update is asked for: a check that finds one offers it, and nothing
downloads until Download is pressed, unless Settings -> General -> Download
updates automatically is on (it is off by default). The diagnostics log
(Open logs on a notification in the bell) has a line for each step below: the
check, the download at 25/50/75%, "Update downloaded" (after the file's sha512
and, on Windows, its signature were checked), "Restart to update", each
shutdown leg with its time, the installer's full command line, and the
hand-over. Read it first when an update misbehaves.

What the person should see, in order:

1. **Offered.** Help -> Check For Updates, or the hourly check: the toast
   "SprintEngine Studio X is available" with Later and Download, a bell row,
   and Settings -> General shows "X available" with a Download button. Nothing
   downloads yet (no progress bar in Settings).
2. **Downloading.** Press Download. The same toast becomes "Downloading
   SprintEngine Studio X" and counts up ("42% downloaded"); the Settings row
   shows a filling bar. Later on the offer instead leaves it offered; the next
   hourly check does not offer the same version again in that window.
3. **Ready.** The toast becomes "SprintEngine Studio X is ready" with Later and
   Restart to update. On a Windows all-users installation its description says
   Windows will ask for administrator permission.
4. **Restart pressed.** At once, before anything else happens: the toast reads
   "Installing update" and its button reads "Restarting…" with a spinner and
   cannot be pressed again. The window stays responsive; Windows never labels
   it "Not responding".
5. **Progress window.** The workspace windows close and the small launch-plate
   window appears in the centre of the screen: "Getting ready to update…", then
   "Saving your work…" with the bar at its foot advancing as each part of the
   app shuts down (terminals are the long step), then "Starting the
   installer…", then "Installing SprintEngine Studio X…" (Windows) or
   "Restarting into SprintEngine Studio X…" (macOS). It takes at most about
   ten seconds, however many terminals are open.
6. **Installer (Windows).** The small one-click installer window with the app
   icon and a progress bar: no wizard, nothing to click. No UAC prompt for a
   per-user installation. It closes itself when done.
7. **Back.** The app starts again on its own with the normal launch plate, and
   once it is up the toast "Updated to SprintEngine Studio X" appears (a bell
   row too). Settings shows version X. If it came back on the old version, the
   toast is "Update to X did not install" with the reason instead.

Also confirm:

- Later on the ready toast leaves the app running, and a per-user update
  installs at the next quit (the next start then says "Updated to X"). An
  all-users Windows installation does not install at quit; its toast said so.
- Turning on Download updates automatically with an update offered starts the
  download at once, and later checks download without asking.
- On a nightly install, switch Update channel to Stable and confirm the check
  that follows offers the latest stable even when its version is lower than the
  nightly's. Switch back to Nightly and confirm the latest nightly is offered.
- Switching channel is refused while an install is under way.

### Windows: updating the installation that is running

Owner ruling 2026-09-24: an update installs over the installation the person
is running, wherever it is. Stable 0.4.0, 0.5.0, 0.5.1 and 0.6.0 shipped the
assisted NSIS installer (`oneClick: false`), which let the person install for
all users under Program Files (recorded in HKLM) or into a folder of their own;
the one-click per-user installer on its own only finds a per-user installation
(HKCU), and would have put a second copy under `%LOCALAPPDATA%\Programs`.

How it works: this build's app passes its own folder to the installer as
`/D=<folder>` (last, unquoted), and `build/installer.nsh` installs there, in
all-users mode when HKLM records that folder. An all-users installation needs
an administrator: this build's app asks Windows for permission when Restart to
update is pressed, before it shuts anything down. An older build (0.6.0 and
earlier) passes no folder; the installer then takes the folder of the app that
started it, and relaunches itself elevated when that folder is an all-users
installation.

Run every row on a Windows 10 or 11 VM with a fresh snapshot per row. Install
0.6.0 from its GitHub release, start it, let it offer the candidate, and update
through Restart to update. Then check every column; "one entry" means Settings
-> Apps -> Installed apps lists SprintEngine Studio exactly once.

| Row | Install 0.6.0 as                                                          | UAC                                                                                               | Version launched afterwards                                         | `%LOCALAPPDATA%\Programs`                                                                                  | Apps & features                          | Shortcuts                                                                           |
| --- | ------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------- | ---------------------------------------- | ----------------------------------------------------------------------------------- |
| a   | Only for me, default folder                                               | None                                                                                              | The candidate, relaunched by the installer                          | Only the original `SprintEngine Studio` folder, now holding the candidate; no `sprintengine-studio` folder | One entry, candidate version             | Start menu and desktop start the candidate                                          |
| b   | Only for me, a custom folder (for example `D:\Tools\SprintEngine Studio`) | None                                                                                              | The candidate, from the custom folder                               | No `SprintEngine Studio` or `sprintengine-studio` folder created                                           | One entry, candidate version             | Start menu and desktop start `D:\Tools\SprintEngine Studio\SprintEngine Studio.exe` |
| c   | Anyone who uses this computer (Program Files)                             | One prompt, from the installer that 0.6.0 started, naming "SprintEngine Studio" and its publisher | The candidate, from `C:\Program Files\SprintEngine Studio`          | No `SprintEngine Studio` or `sprintengine-studio` folder created                                           | One entry (all users), candidate version | The all-users Start menu and Public Desktop shortcuts start the Program Files copy  |
| d   | As (c), and answer No on the UAC prompt                                   | Declined                                                                                          | 0.6.0 again, restarted by the installer; it offers the update again | Nothing created                                                                                            | One entry, 0.6.0                         | Unchanged                                                                           |

Then, from the candidate itself (the path this build's app takes), install
the candidate on each kind of installation and update it to a later build
(a nightly cut after it):

| Row | Installation              | UAC                                                                                                          | Expected                                                                                                                                                                                                      |
| --- | ------------------------- | ------------------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| e   | Per-user default          | None                                                                                                         | As (a): installer window, relaunch, "Updated to X" toast                                                                                                                                                      |
| f   | Custom folder             | None                                                                                                         | As (b)                                                                                                                                                                                                        |
| g   | All users (Program Files) | One prompt, in front of the app window, as soon as Restart to update is pressed (before the progress window) | As (c); the installer window then shows progress; "Updated to X" toast                                                                                                                                        |
| h   | All users, answer No      | Declined                                                                                                     | No progress window, nothing shut down: the app keeps running on its version, and the toast turns to "Update not installed" saying administrator permission was not given, with Restart to update to try again |

For each of (a) to (h) also check:

- `reg query HKLM\SOFTWARE\811b2173-7620-5d95-bc40-528684ed1d2d /v InstallLocation /reg:64`
  and the same under HKCU: exactly one of them names the installation (HKLM for
  c, d, g, h; HKCU otherwise), and it is the folder updated.
- Uninstall from Apps & features removes the folder, the entry and every
  shortcut (for an all-users installation Windows asks for permission once, and
  the "are you sure" question is asked once).
- Row (c) or (g) on a machine that also has a stray per-user copy under
  `%LOCALAPPDATA%\Programs\sprintengine-studio` (left by a nightly from before
  this change): the update removes that copy, its HKCU entry, and its per-user
  shortcuts; the all-users shortcuts remain. Repeat it through 0.6.0's
  install at quit (Later on its ready toast, then quit 0.6.0): the Program
  Files copy is the one updated, after one UAC prompt.
- An older build's install at quit cannot see which copy it came from, so the
  installer picks by registry: the per-user installation, unless it sits in
  the one-click default folder (`%LOCALAPPDATA%\Programs\sprintengine-studio`)
  beside an all-users one, which is the stray case above. Known limit, stated
  in the release notes: a person running a pre-fix nightly per-user on a
  machine where another account installed 0.6.0 for all users is asked for
  administrator permission at quit, and their copy is folded into the
  all-users one if they give it. Restart to update is not affected.
- Later, then quit, on (e) and (f): no window and no prompt; the next start is
  the candidate's successor, in the same folder, with "Updated to X".

## Failure And Rollback

- Confirm manual update check errors are visible in Settings.
- Confirm updater errors are written to diagnostics logs.
- Keep the previous installer available in GitHub Releases.
- For a bad release, mark the GitHub Release as not latest or remove the updater metadata asset after deciding on the rollback path.
- Publish a patch release as the preferred rollback mechanism when users may already have installed the bad build.
