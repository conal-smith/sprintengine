// The phone's in-app updater, Android only: every push to main publishes a
// release-signed APK and a small manifest beside it
// (.github/workflows/mobile-android.yml). The app reads the manifest when it opens and when
// it comes back to the foreground, lights an update glyph on the chat list when
// the build there is newer than this one, and one press downloads it, checks
// it and hands it to Android's package installer, which always asks the person
// to confirm.
//
//   none          no glyph: up to date, iOS, or the check failed quietly
//   available     download arrow, lit             press → download and verify
//   downloading   ring filling with the bytes     —
//   verifying     ring full                       —
//   ready         restart arrow, lit              press → open the installer
//   installing    restart arrow                   —
//   reinstall     download arrow, lit             press → explain the one-time
//                                                 uninstall (signed with
//                                                 another key)
//
// What the app trusts, and why:
//
//   - The manifest comes from one fixed URL on github.com over HTTPS. It is
//     only advice: it names a newer build, its size and its SHA-256.
//   - The APK must be served from the same release (the URL prefix below), be
//     exactly that size and hash, and be this app's package at the version the
//     manifest named, or it is deleted unopened.
//   - It must be signed with the release key, whose certificate is pinned here
//     (RELEASE_CERT_SHA256), not taken from the manifest. A manifest naming
//     any other certificate is refused outright.
//   - The file is hashed again just before it is handed to the installer, so
//     nothing that changed it in the cache since it was checked gets through.
//   - Android itself then refuses to install it over this app unless both are
//     signed with the same key, which is the guarantee that matters once the
//     phone runs a release-signed build. A debug-signed build (a local or pull
//     request build) cannot take it: that is the `reinstall` state.
//
// Pure: no React, no native module, no network. The hook that drives it is
// useAppUpdate.tsx; apkUpdateLogic.regression.test.js covers this file. The
// publishing side is .github/workflows/mobile-android.yml.

export const APP_NAME = "Sprint Engine";
export const PACKAGE_NAME = "ai.sprintengine.mobile";

/** The repository and the one release tag the phone build is published on. */
export const UPDATE_REPOSITORY = "sprintengine/sprintengine";
export const UPDATE_TAG = "mobile-android";
export const UPDATE_MANIFEST_NAME = "android-update.json";

export const UPDATE_DOWNLOAD_PREFIX = `https://github.com/${UPDATE_REPOSITORY}/releases/download/${UPDATE_TAG}/`;
export const UPDATE_MANIFEST_URL = `${UPDATE_DOWNLOAD_PREFIX}${UPDATE_MANIFEST_NAME}`;

/**
 * SHA-256 of the release signing certificate, uppercase hex without colons
 * (`apksigner verify --print-certs` prints the same digest). Rotating the key
 * means changing this, and every installed build then needs one reinstall.
 */
export const RELEASE_CERT_SHA256 = "ED4401C2E8B6753E25338435526ECE0EA6945904D2B153FE9F1F5C2B404EA7D7";

/** Foreground checks closer together than this reuse the last answer. */
export const FOREGROUND_CHECK_INTERVAL_MS = 15 * 60 * 1000;

/** No phone build is anywhere near this; a manifest claiming more is wrong. */
export const MAX_APK_BYTES = 512 * 1024 * 1024;

export interface UpdateManifest {
  versionCode: number;
  versionName: string;
  commit: string;
  sha256: string;
  size: number;
  url: string;
  certSha256: string;
}

export type ManifestResult = { ok: true; manifest: UpdateManifest } | { ok: false; reason: string };

/** `ED:44:01:…` or `ed4401…` → `ED4401…`; anything that is not 32 bytes of hex → null. */
export function normalizeCertSha256(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const hex = value.replace(/:/g, "").trim().toUpperCase();
  return /^[0-9A-F]{64}$/.test(hex) ? hex : null;
}

function normalizeSha256(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const hex = value.trim().toLowerCase();
  return /^[0-9a-f]{64}$/.test(hex) ? hex : null;
}

/**
 * Whether a download URL is an APK on the phone's own release. Only the file
 * name may vary, and only in a plain way: no query, no fragment, no slash, no
 * `..`, so the URL cannot walk to another release or another host.
 */
export function isTrustedApkUrl(url: unknown): url is string {
  if (typeof url !== "string" || !url.startsWith(UPDATE_DOWNLOAD_PREFIX)) return false;
  const name = url.slice(UPDATE_DOWNLOAD_PREFIX.length);
  return /^[A-Za-z0-9][A-Za-z0-9._-]*\.apk$/.test(name) && !name.includes("..");
}

/** The manifest the publish job writes, checked field by field. */
export function parseUpdateManifest(raw: unknown): ManifestResult {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return { ok: false, reason: "not an object" };
  const record = raw as Record<string, unknown>;
  if (record.schema !== 1) return { ok: false, reason: "unknown schema" };
  if (record.packageName !== PACKAGE_NAME) return { ok: false, reason: "another app's manifest" };
  const versionCode = record.versionCode;
  if (typeof versionCode !== "number" || !Number.isSafeInteger(versionCode) || versionCode < 1) {
    return { ok: false, reason: "bad versionCode" };
  }
  const versionName = typeof record.versionName === "string" ? record.versionName.trim() : "";
  if (!versionName || versionName.length > 100) return { ok: false, reason: "bad versionName" };
  const commit = typeof record.commit === "string" ? record.commit.toLowerCase() : "";
  if (!/^[0-9a-f]{40}$/.test(commit)) return { ok: false, reason: "bad commit" };
  const sha256 = normalizeSha256(record.sha256);
  if (!sha256) return { ok: false, reason: "bad sha256" };
  const size = record.size;
  if (typeof size !== "number" || !Number.isSafeInteger(size) || size < 1 || size > MAX_APK_BYTES) {
    return { ok: false, reason: "bad size" };
  }
  if (!isTrustedApkUrl(record.url)) return { ok: false, reason: "untrusted url" };
  const certSha256 = normalizeCertSha256(record.certSha256);
  if (certSha256 !== RELEASE_CERT_SHA256) return { ok: false, reason: "not the release certificate" };
  return { ok: true, manifest: { versionCode, versionName, commit, sha256, size, url: record.url, certSha256 } };
}

/** The manifest's build, when it is newer than the one running. */
export function updateOffered(installedVersionCode: number | null, manifest: UpdateManifest | null): boolean {
  if (!manifest || installedVersionCode === null || !Number.isFinite(installedVersionCode)) return false;
  return manifest.versionCode > installedVersionCode;
}

export type CheckReason = "launch" | "foreground";

/**
 * Whether to fetch the manifest now. The app opening always checks; coming back
 * to the foreground checks at most every FOREGROUND_CHECK_INTERVAL_MS, so
 * flicking between apps costs nothing. There is no timer: nothing checks while
 * the app sits open.
 */
export function shouldCheck({
  reason,
  lastCheckedAt,
  now,
  busy,
}: {
  reason: CheckReason;
  lastCheckedAt: number | null;
  now: number;
  busy: boolean;
}): boolean {
  if (busy) return false;
  if (reason === "launch" || lastCheckedAt === null) return true;
  return now - lastCheckedAt >= FOREGROUND_CHECK_INTERVAL_MS;
}

export interface ApkIdentity {
  packageName: string;
  versionCode: number;
  /** SHA-256 of each signing certificate, any case, with or without colons. */
  signers: string[];
}

export type VerifyFailure = "size" | "hash" | "not_apk" | "package" | "version" | "signer";

export type VerifyResult =
  | { ok: true; installsOverThisApp: boolean }
  | { ok: false; failure: VerifyFailure };

function signerSet(signers: readonly string[]): string[] {
  return signers.map(normalizeCertSha256).filter((value): value is string => value !== null).sort();
}

/**
 * The downloaded file against what the manifest promised and what is pinned.
 * Any failure means the file is deleted and never opened. `installsOverThisApp`
 * is false when the APK is the genuine release but this install was signed
 * with another key (a debug build): Android will refuse it, and the person
 * has to uninstall once.
 */
export function verifyDownload({
  manifest,
  size,
  sha256,
  archive,
  installedSigners,
}: {
  manifest: UpdateManifest;
  size: number | null;
  sha256: string | null;
  archive: ApkIdentity | null;
  installedSigners: readonly string[];
}): VerifyResult {
  if (size !== manifest.size) return { ok: false, failure: "size" };
  if (normalizeSha256(sha256) !== manifest.sha256) return { ok: false, failure: "hash" };
  if (!archive) return { ok: false, failure: "not_apk" };
  if (archive.packageName !== PACKAGE_NAME) return { ok: false, failure: "package" };
  if (archive.versionCode !== manifest.versionCode) return { ok: false, failure: "version" };
  const apkSigners = signerSet(archive.signers);
  // One signer, and it is the release key. A multi-signer APK is not what the
  // publish job makes.
  if (apkSigners.length !== 1 || apkSigners[0] !== RELEASE_CERT_SHA256) return { ok: false, failure: "signer" };
  const installed = signerSet(installedSigners);
  const installsOverThisApp = installed.length === apkSigners.length && installed.every((value, index) => value === apkSigners[index]);
  return { ok: true, installsOverThisApp };
}

// android.content.pm.PackageManager INSTALL_FAILED_* codes the installer hands
// back in EXTRA_INSTALL_RESULT when asked to return a result.
const INSTALL_FAILED_INSUFFICIENT_STORAGE = -4;
const INSTALL_FAILED_UPDATE_INCOMPATIBLE = -7;
const INSTALL_FAILED_SHARED_USER_INCOMPATIBLE = -8;
const INSTALL_FAILED_VERSION_DOWNGRADE = -25;
const INSTALL_PARSE_FAILED_NO_CERTIFICATES = -103;
const INSTALL_PARSE_FAILED_INCONSISTENT_CERTIFICATES = -104;

export type InstallOutcome = "installed" | "cancelled" | "incompatible" | "storage" | "downgrade" | "failed";

/**
 * What the package installer's answer means. `resultCode` is the activity
 * result (-1 OK, 0 cancelled, 1 first-user, which the installer uses for a
 * failure), `extra` the result intent's extras.
 */
export function installOutcome(result: { resultCode: number; extra?: object | null }): InstallOutcome {
  if (result.resultCode === -1) return "installed";
  const code = (result.extra as Record<string, unknown> | null | undefined)?.["android.intent.extra.INSTALL_RESULT"];
  if (result.resultCode === 0 && typeof code !== "number") return "cancelled";
  switch (code) {
    case INSTALL_FAILED_UPDATE_INCOMPATIBLE:
    case INSTALL_FAILED_SHARED_USER_INCOMPATIBLE:
    case INSTALL_PARSE_FAILED_INCONSISTENT_CERTIFICATES:
    case INSTALL_PARSE_FAILED_NO_CERTIFICATES:
      return "incompatible";
    case INSTALL_FAILED_INSUFFICIENT_STORAGE:
      return "storage";
    case INSTALL_FAILED_VERSION_DOWNGRADE:
      return "downgrade";
    default:
      return "failed";
  }
}

export type UpdateProblem =
  | "offline"
  | "download"
  | VerifyFailure
  | "storage"
  | "downgrade"
  | "install";

/** One plain sentence for each way an update can go wrong. */
export function updateProblemMessage(problem: UpdateProblem): { title: string; description: string } {
  switch (problem) {
    case "offline":
      return { title: "Couldn't download the update", description: "The phone looks offline. Try again once it's connected." };
    case "download":
      return { title: "Couldn't download the update", description: "The download stopped before it finished. Try again." };
    case "size":
    case "hash":
      return {
        title: "The update didn't match its checksum",
        description: "The download was damaged or changed on the way, so it was deleted. Try again.",
      };
    case "not_apk":
    case "package":
    case "version":
      return {
        title: "The update wasn't the build it said it was",
        description: "It was deleted without being opened. Try again later.",
      };
    case "signer":
      return {
        title: "The update isn't signed by Sprint Engine",
        description: "It was deleted without being opened.",
      };
    case "storage":
      return { title: "Not enough space to install", description: "Free some storage on the phone, then try again." };
    case "downgrade":
      return { title: "This phone already has a newer build", description: "Nothing was installed." };
    case "install":
      return { title: "Android didn't install the update", description: "Try again from the update button." };
  }
}

/** The one-line reason given before sending the person to Android's setting. */
export const INSTALL_PERMISSION_MESSAGE = `To install updates, turn on "Allow from this source" for ${APP_NAME}.`;

/**
 * Why a build signed with another key cannot take the update, and what to do.
 * Installed by hand, the APK is not checked by the app, so the message names
 * what to check it against: the release page lists each asset's SHA-256.
 */
export function reinstallMessage(manifest: Pick<UpdateManifest, "commit" | "sha256">): string {
  return (
    `This copy of ${APP_NAME} was signed with a different key from the published build, so Android won't ` +
    `install over it. Uninstall ${APP_NAME} once, then install the update from the browser. You'll need ` +
    `to pair with your desktop again.\n\nThe app can't check a download you install yourself: get it only ` +
    `from the ${UPDATE_TAG} release on github.com/${UPDATE_REPOSITORY}, and check it is commit ` +
    `${manifest.commit.slice(0, 7)} with a SHA-256 starting ${manifest.sha256.slice(0, 12)}.`
  );
}

export type AppUpdatePhase = "none" | "available" | "downloading" | "verifying" | "ready" | "installing" | "reinstall";

export interface AppUpdateView {
  phase: AppUpdatePhase;
  /** Pressing it does something. */
  pressable: boolean;
  /** 0–100 while downloading, else null. */
  percent: number | null;
  /** The accessible name. */
  label: string;
}

/** What the glyph shows. Null when there is no glyph at all. */
export function appUpdateView(state: {
  phase: AppUpdatePhase;
  versionName: string | null;
  received: number;
  total: number;
}): AppUpdateView | null {
  const name = state.versionName ? `${APP_NAME} ${state.versionName}` : `A new ${APP_NAME}`;
  switch (state.phase) {
    case "none":
      return null;
    case "available":
      return { phase: "available", pressable: true, percent: null, label: `${name} is available. Tap to download and install.` };
    case "downloading": {
      const percent = state.total > 0 ? Math.max(0, Math.min(100, Math.floor((state.received / state.total) * 100))) : 0;
      return { phase: "downloading", pressable: false, percent, label: `Downloading the update (${percent}%)` };
    }
    case "verifying":
      return { phase: "verifying", pressable: false, percent: 100, label: "Checking the update" };
    case "ready":
      return { phase: "ready", pressable: true, percent: null, label: `${name} is downloaded. Tap to install.` };
    case "installing":
      return { phase: "installing", pressable: false, percent: null, label: "Opening the installer" };
    case "reinstall":
      return { phase: "reinstall", pressable: true, percent: null, label: `${name} needs a one-time reinstall. Tap for details.` };
  }
}

/** The cache file a version downloads to, inside the app's cache directory. */
export function apkFileName(versionCode: number): string {
  return `sprintengine-${versionCode}.apk`;
}
