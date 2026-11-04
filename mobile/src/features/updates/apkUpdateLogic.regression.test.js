const assert = require("node:assert/strict");
const { test } = require("node:test");
const {
  appUpdateView,
  FOREGROUND_CHECK_INTERVAL_MS,
  installOutcome,
  isTrustedApkUrl,
  normalizeCertSha256,
  parseUpdateManifest,
  reinstallMessage,
  RELEASE_CERT_SHA256,
  shouldCheck,
  UPDATE_DOWNLOAD_PREFIX,
  UPDATE_MANIFEST_URL,
  updateOffered,
  updateProblemMessage,
  verifyDownload,
} = require("../../../.mobile-test-build/src/features/updates/apkUpdateLogic.js");

const RELEASE_CERT_COLONS = "ED:44:01:C2:E8:B6:75:3E:25:33:84:35:52:6E:CE:0E:A6:94:59:04:D2:B1:53:FE:9F:1F:5C:2B:40:4E:A7:D7";
// The stock React Native debug keystore's certificate, which local and pull
// request builds are signed with.
const DEBUG_CERT = "FAC61745DC0903786FB9EDE62A962B399F7348F0BB6F899B8332667591033B9C";
const HASH = "a".repeat(64);

const published = {
  schema: 1,
  packageName: "ai.sprintengine.mobile",
  versionCode: 1250,
  versionName: "0.1.0-main.1250+0123abc",
  commit: "0123abc0123abc0123abc0123abc0123abc0123a",
  sha256: HASH,
  size: 80_000_000,
  url: `${UPDATE_DOWNLOAD_PREFIX}sprintengine-mobile-1250.apk`,
  certSha256: RELEASE_CERT_COLONS,
  publishedAt: "2026-11-04T12:00:00Z",
};

const manifestOf = (overrides = {}) => {
  const result = parseUpdateManifest({ ...published, ...overrides });
  assert.equal(result.ok, true, result.reason);
  return result.manifest;
};

test("the manifest and the APK come from the phone's one release on github.com", () => {
  assert.equal(
    UPDATE_MANIFEST_URL,
    "https://github.com/sprintengine/sprintengine/releases/download/mobile-android/android-update.json",
  );
  // Not a vX.Y.Z tag: release.yml triggers on `v*` tags, the desktop's
  // scripts parse only those, and electron-updater skips a tag that is not semver.
  assert.doesNotMatch(UPDATE_MANIFEST_URL, /\/download\/v/);
});

test("the pinned certificate is the release key's, the digest apksigner prints", () => {
  assert.equal(normalizeCertSha256(RELEASE_CERT_COLONS), RELEASE_CERT_SHA256);
  assert.equal(normalizeCertSha256(RELEASE_CERT_SHA256.toLowerCase()), RELEASE_CERT_SHA256);
  assert.equal(normalizeCertSha256("ED:44"), null);
  assert.equal(normalizeCertSha256(42), null);
});

test("a well-formed manifest parses, with the hash lowercased", () => {
  const manifest = manifestOf({ sha256: HASH.toUpperCase() });
  assert.equal(manifest.versionCode, 1250);
  assert.equal(manifest.sha256, HASH);
  assert.equal(manifest.certSha256, RELEASE_CERT_SHA256);
});

test("a manifest naming any other signing certificate is refused, the debug key included", () => {
  assert.deepEqual(parseUpdateManifest({ ...published, certSha256: DEBUG_CERT }), {
    ok: false,
    reason: "not the release certificate",
  });
  assert.equal(parseUpdateManifest({ ...published, certSha256: undefined }).ok, false);
});

test("every field is checked, so a malformed manifest offers nothing", () => {
  const broken = [
    null,
    [],
    "text",
    { ...published, schema: 2 },
    { ...published, packageName: "com.example.other" },
    { ...published, versionCode: 0 },
    { ...published, versionCode: 12.5 },
    { ...published, versionCode: "1250" },
    { ...published, versionName: "" },
    { ...published, commit: "abc" },
    { ...published, sha256: "z".repeat(64) },
    { ...published, sha256: HASH.slice(1) },
    { ...published, size: 0 },
    { ...published, size: 10 * 1024 * 1024 * 1024 },
  ];
  for (const raw of broken) assert.equal(parseUpdateManifest(raw).ok, false, JSON.stringify(raw));
});

test("the APK must sit on the same release: no other host, release, path or query", () => {
  assert.equal(isTrustedApkUrl(`${UPDATE_DOWNLOAD_PREFIX}sprintengine-mobile-1250.apk`), true);
  for (const url of [
    "https://example.com/sprintengine-mobile.apk",
    "http://github.com/sprintengine/sprintengine/releases/download/mobile-android/a.apk",
    "https://github.com/sprintengine/sprintengine/releases/download/v0.11.0/a.apk",
    "https://github.com/someone/sprintengine/releases/download/mobile-android/a.apk",
    `${UPDATE_DOWNLOAD_PREFIX}../v0.11.0/a.apk`,
    `${UPDATE_DOWNLOAD_PREFIX}a..apk`,
    `${UPDATE_DOWNLOAD_PREFIX}sub/a.apk`,
    `${UPDATE_DOWNLOAD_PREFIX}a.apk?x=1`,
    `${UPDATE_DOWNLOAD_PREFIX}a.apk#x`,
    `${UPDATE_DOWNLOAD_PREFIX}android-update.json`,
    `${UPDATE_DOWNLOAD_PREFIX}.apk`,
    `${UPDATE_DOWNLOAD_PREFIX}a.apk.exe`,
    "https://github.com.example.com/sprintengine/sprintengine/releases/download/mobile-android/a.apk",
  ]) {
    assert.equal(isTrustedApkUrl(url), false, url);
    assert.equal(parseUpdateManifest({ ...published, url }).ok, false, url);
  }
});

test("only a newer versionCode is offered; a local build's 1 is offered the published one", () => {
  const manifest = manifestOf();
  assert.equal(updateOffered(1, manifest), true);
  assert.equal(updateOffered(1249, manifest), true);
  assert.equal(updateOffered(1250, manifest), false, "the build already running");
  assert.equal(updateOffered(1300, manifest), false, "a newer build than the published one");
  assert.equal(updateOffered(null, manifest), false, "unknown installed version offers nothing");
  assert.equal(updateOffered(1, null), false);
});

test("opening the app always checks; the foreground checks at most every fifteen minutes; nothing polls", () => {
  const now = 10 * FOREGROUND_CHECK_INTERVAL_MS;
  assert.equal(shouldCheck({ reason: "launch", lastCheckedAt: now - 1000, now, busy: false }), true);
  assert.equal(shouldCheck({ reason: "foreground", lastCheckedAt: null, now, busy: false }), true);
  assert.equal(shouldCheck({ reason: "foreground", lastCheckedAt: now - 60_000, now, busy: false }), false);
  assert.equal(
    shouldCheck({ reason: "foreground", lastCheckedAt: now - FOREGROUND_CHECK_INTERVAL_MS, now, busy: false }),
    true,
  );
  assert.equal(shouldCheck({ reason: "launch", lastCheckedAt: null, now, busy: true }), false, "never two at once");
});

const releaseArchive = { packageName: "ai.sprintengine.mobile", versionCode: 1250, signers: [RELEASE_CERT_COLONS] };
const verified = (overrides = {}) =>
  verifyDownload({
    manifest: manifestOf(),
    size: published.size,
    sha256: HASH,
    archive: releaseArchive,
    installedSigners: [RELEASE_CERT_SHA256],
    ...overrides,
  });

test("a download that is exactly the published build installs over a release-signed app", () => {
  assert.deepEqual(verified(), { ok: true, installsOverThisApp: true });
  assert.deepEqual(verified({ sha256: HASH.toUpperCase() }), { ok: true, installsOverThisApp: true });
});

test("a hash mismatch is refused, and so is a wrong size, before the file is ever opened", () => {
  assert.deepEqual(verified({ sha256: "b".repeat(64) }), { ok: false, failure: "hash" });
  assert.deepEqual(verified({ sha256: null }), { ok: false, failure: "hash" });
  assert.deepEqual(verified({ size: published.size - 1 }), { ok: false, failure: "size" });
  assert.deepEqual(verified({ size: null }), { ok: false, failure: "size" });
});

test("the file must be this app at the version named, signed with the pinned release key alone", () => {
  assert.deepEqual(verified({ archive: null }), { ok: false, failure: "not_apk" });
  assert.deepEqual(verified({ archive: { ...releaseArchive, packageName: "com.example" } }), { ok: false, failure: "package" });
  assert.deepEqual(verified({ archive: { ...releaseArchive, versionCode: 1249 } }), { ok: false, failure: "version" });
  assert.deepEqual(verified({ archive: { ...releaseArchive, signers: [DEBUG_CERT] } }), { ok: false, failure: "signer" });
  assert.deepEqual(verified({ archive: { ...releaseArchive, signers: [] } }), { ok: false, failure: "signer" });
  assert.deepEqual(verified({ archive: { ...releaseArchive, signers: [RELEASE_CERT_SHA256, DEBUG_CERT] } }), {
    ok: false,
    failure: "signer",
  });
});

test("a debug-signed install gets the genuine release, but has to uninstall once to take it", () => {
  assert.deepEqual(verified({ installedSigners: [DEBUG_CERT] }), { ok: true, installsOverThisApp: false });
  assert.deepEqual(verified({ installedSigners: [] }), { ok: true, installsOverThisApp: false });
});

test("the installer's answer: confirmed, backed out of, or refused for a different key", () => {
  const result = (code) => ({ resultCode: 1, extra: { "android.intent.extra.INSTALL_RESULT": code } });
  assert.equal(installOutcome({ resultCode: -1 }), "installed");
  assert.equal(installOutcome({ resultCode: 0 }), "cancelled");
  assert.equal(installOutcome({ resultCode: 0, extra: {} }), "cancelled");
  assert.equal(installOutcome(result(-7)), "incompatible", "INSTALL_FAILED_UPDATE_INCOMPATIBLE: signed with another key");
  assert.equal(installOutcome(result(-104)), "incompatible");
  assert.equal(installOutcome(result(-4)), "storage");
  assert.equal(installOutcome(result(-25)), "downgrade");
  assert.equal(installOutcome(result(-110)), "failed");
  assert.equal(installOutcome({ resultCode: 1 }), "failed");
});

test("every problem has a plain title and line", () => {
  for (const kind of ["offline", "download", "size", "hash", "not_apk", "package", "version", "signer", "storage", "downgrade", "install"]) {
    const message = updateProblemMessage(kind);
    assert.ok(message.title.length > 0 && message.description.length > 0, kind);
  }
  assert.match(updateProblemMessage("offline").description, /offline/);
  assert.match(updateProblemMessage("hash").title, /checksum/);
});

test("the glyph is there only while there is something to take, and says what a press does", () => {
  const base = { versionName: "0.1.0-main.1250+0123abc", received: 0, total: 100 };
  assert.equal(appUpdateView({ ...base, phase: "none" }), null);
  assert.deepEqual(appUpdateView({ ...base, phase: "available" }), {
    phase: "available",
    pressable: true,
    percent: null,
    label: "Sprint Engine 0.1.0-main.1250+0123abc is available. Tap to download and install.",
  });
  const downloading = appUpdateView({ ...base, phase: "downloading", received: 42.9, total: 100 });
  assert.equal(downloading.percent, 42);
  assert.equal(downloading.pressable, false);
  assert.equal(appUpdateView({ ...base, phase: "downloading", received: 500, total: 100 }).percent, 100);
  assert.equal(appUpdateView({ ...base, phase: "downloading", total: 0 }).percent, 0);
  assert.equal(appUpdateView({ ...base, phase: "verifying" }).pressable, false);
  assert.equal(appUpdateView({ ...base, phase: "ready" }).pressable, true);
  assert.equal(appUpdateView({ ...base, phase: "installing" }).pressable, false);
  assert.equal(appUpdateView({ ...base, phase: "reinstall" }).pressable, true);
});

test("the reinstall message says to pair again and what to check a hand-installed APK against", () => {
  const message = reinstallMessage(manifestOf());
  assert.match(message, /Uninstall Sprint Engine once/);
  assert.match(message, /pair with your desktop again/);
  assert.match(message, /mobile-android release on github\.com\/sprintengine\/sprintengine/);
  assert.match(message, /commit 0123abc/);
  assert.match(message, /SHA-256 starting aaaaaaaaaaaa/);
});
