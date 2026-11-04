import * as LegacyFileSystem from "expo-file-system/legacy";
import * as IntentLauncher from "expo-intent-launcher";
import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { Alert, AppState, Linking } from "react-native";

import { useToast } from "../../components/Toast";
import { apkUpdater } from "./apkNative";
import {
  apkFileName,
  appUpdateView,
  INSTALL_PERMISSION_MESSAGE,
  installOutcome,
  PACKAGE_NAME,
  parseUpdateManifest,
  reinstallMessage,
  shouldCheck,
  updateOffered,
  updateProblemMessage,
  verifyDownload,
  type AppUpdatePhase,
  type AppUpdateView,
  type CheckReason,
  type UpdateManifest,
  type UpdateProblem,
  UPDATE_MANIFEST_URL,
} from "./apkUpdateLogic";

// Drives the phone's update glyph (apkUpdateLogic.ts has the steps and what is
// trusted). Android only: on iOS `apkUpdater` is null and nothing here runs.
// The manifest is read when the app opens and, at most every fifteen minutes,
// when it comes back to the foreground. Nothing polls.

interface UpdateState {
  phase: AppUpdatePhase;
  manifest: UpdateManifest | null;
  received: number;
  total: number;
  /** The verified APK, once there is one. */
  fileUri: string | null;
}

const NONE: UpdateState = { phase: "none", manifest: null, received: 0, total: 0, fileUri: null };
const BUSY: readonly AppUpdatePhase[] = ["downloading", "verifying", "installing"];
const MANIFEST_TIMEOUT_MS = 15_000;
const APK_MIME = "application/vnd.android.package-archive";
const FLAG_GRANT_READ_URI_PERMISSION = 1;

interface AppUpdateValue {
  view: AppUpdateView | null;
  press: () => void;
}

const AppUpdateContext = createContext<AppUpdateValue>({ view: null, press: () => undefined });

export function useAppUpdate(): AppUpdateValue {
  return useContext(AppUpdateContext);
}

function updateDirectory(): string | null {
  return LegacyFileSystem.cacheDirectory ? `${LegacyFileSystem.cacheDirectory}app-update/` : null;
}

async function fetchManifest(): Promise<UpdateManifest | null> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), MANIFEST_TIMEOUT_MS);
  try {
    const response = await fetch(UPDATE_MANIFEST_URL, {
      headers: { Accept: "application/json", "Cache-Control": "no-cache" },
      signal: controller.signal,
    });
    if (!response.ok) return null;
    const parsed = parseUpdateManifest(await response.json());
    return parsed.ok ? parsed.manifest : null;
  } catch {
    // Offline, a timeout, or no release yet: no glyph, and no nagging about it.
    return null;
  } finally {
    clearTimeout(timer);
  }
}

function looksOffline(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error);
  return /network|host|connect|timed? ?out|internet|offline|unreachable/i.test(message);
}

async function removeQuietly(uri: string | null): Promise<void> {
  if (!uri) return;
  await LegacyFileSystem.deleteAsync(uri, { idempotent: true }).catch(() => undefined);
}

export function AppUpdateProvider({ children }: { children: ReactNode }) {
  const toast = useToast();
  const [state, setState] = useState<UpdateState>(NONE);
  const stateRef = useRef(state);
  stateRef.current = state;
  const lastCheckedAt = useRef<number | null>(null);
  const checking = useRef(false);

  const set = useCallback((next: UpdateState) => {
    stateRef.current = next;
    setState(next);
  }, []);

  const problem = useCallback(
    (kind: UpdateProblem) => toast.show({ ...updateProblemMessage(kind), tone: kind === "downgrade" ? "neutral" : "error" }),
    [toast],
  );

  const check = useCallback(
    async (reason: CheckReason) => {
      if (!apkUpdater) return;
      const busy = checking.current || BUSY.includes(stateRef.current.phase);
      if (!shouldCheck({ reason, lastCheckedAt: lastCheckedAt.current, now: Date.now(), busy })) return;
      checking.current = true;
      try {
        const manifest = await fetchManifest();
        lastCheckedAt.current = Date.now();
        // A failed check keeps whatever the glyph already offered.
        if (!manifest || BUSY.includes(stateRef.current.phase)) return;
        if (!updateOffered(apkUpdater.installedApp().versionCode, manifest)) {
          set(NONE);
          // This build is the published one (or newer): any APK left in the
          // cache from installing it is done with.
          await removeQuietly(updateDirectory());
          return;
        }
        const current = stateRef.current;
        if (current.manifest?.sha256 === manifest.sha256 && current.phase !== "none") return;
        set({ ...NONE, phase: "available", manifest });
      } finally {
        checking.current = false;
      }
    },
    [set],
  );

  useEffect(() => {
    if (!apkUpdater) return;
    void check("launch");
    const subscription = AppState.addEventListener("change", (next) => {
      if (next === "active") void check("foreground");
    });
    return () => subscription.remove();
  }, [check]);

  const explainReinstall = useCallback((manifest: UpdateManifest) => {
    Alert.alert("Reinstall once to get updates", reinstallMessage(manifest), [
      { text: "Not now", style: "cancel" },
      { text: "Open download", onPress: () => void Linking.openURL(manifest.url) },
    ]);
  }, []);

  const install = useCallback(
    async (ready: UpdateState): Promise<void> => {
      const native = apkUpdater;
      if (!native || !ready.manifest || !ready.fileUri) return;
      const { manifest, fileUri } = ready;

      if (!native.canRequestPackageInstalls()) {
        Alert.alert("Allow updates", INSTALL_PERMISSION_MESSAGE, [
          { text: "Not now", style: "cancel" },
          {
            text: "Open settings",
            onPress: () => {
              void IntentLauncher.startActivityAsync("android.settings.MANAGE_UNKNOWN_APP_SOURCES", {
                data: `package:${PACKAGE_NAME}`,
              })
                .catch(() => IntentLauncher.startActivityAsync("android.settings.MANAGE_UNKNOWN_APP_SOURCES"))
                .then(() => {
                  // Back from the setting: carry on if it was turned on.
                  if (native.canRequestPackageInstalls() && stateRef.current.phase === "ready") {
                    void install(stateRef.current);
                  }
                })
                .catch(() => undefined);
            },
          },
        ]);
        return;
      }

      // The cache can be cleared under the app; a missing file is a new download.
      const info = await LegacyFileSystem.getInfoAsync(fileUri).catch(() => null);
      if (!info?.exists || info.size !== manifest.size) {
        set({ ...NONE, phase: "available", manifest });
        return;
      }

      set({ ...ready, phase: "installing" });
      try {
        // Checked again right before the hand-over: the file may have sat in
        // the cache since it was verified (a trip to Settings, a relaunch).
        const sha256 = await native.sha256File(fileUri);
        const archive = await native.archiveInfo(fileUri);
        const verdict = verifyDownload({
          manifest,
          size: info.size,
          sha256,
          archive,
          installedSigners: native.installedApp().signers,
        });
        if (!verdict.ok) {
          await removeQuietly(fileUri);
          set({ ...NONE, phase: "available", manifest });
          problem(verdict.failure);
          return;
        }
        const contentUri = await LegacyFileSystem.getContentUriAsync(fileUri);
        const result = await IntentLauncher.startActivityAsync("android.intent.action.INSTALL_PACKAGE", {
          data: contentUri,
          type: APK_MIME,
          flags: FLAG_GRANT_READ_URI_PERMISSION,
          extra: { "android.intent.extra.RETURN_RESULT": true },
        });
        const outcome = installOutcome(result);
        if (outcome === "installed") {
          set(NONE);
        } else if (outcome === "incompatible") {
          set({ ...ready, phase: "reinstall" });
          explainReinstall(manifest);
        } else {
          set({ ...ready, phase: "ready" });
          if (outcome !== "cancelled") problem(outcome === "storage" || outcome === "downgrade" ? outcome : "install");
        }
      } catch {
        set({ ...ready, phase: "ready" });
        problem("install");
      }
    },
    [explainReinstall, problem, set],
  );

  const downloadAndVerify = useCallback(
    async (manifest: UpdateManifest): Promise<void> => {
      const native = apkUpdater;
      const directory = updateDirectory();
      if (!native || !directory) return;
      const fileUri = `${directory}${apkFileName(manifest.versionCode)}`;
      const fail = async (kind: UpdateProblem) => {
        await removeQuietly(fileUri);
        set({ ...NONE, phase: "available", manifest });
        problem(kind);
      };

      set({ ...NONE, phase: "downloading", manifest, total: manifest.size });
      try {
        await LegacyFileSystem.makeDirectoryAsync(directory, { intermediates: true });
        // Only this version's file is kept; an older one is from a build that
        // was never installed.
        const names = await LegacyFileSystem.readDirectoryAsync(directory);
        await Promise.all(names.filter((name) => `${directory}${name}` !== fileUri).map((name) => removeQuietly(`${directory}${name}`)));
      } catch {
        await fail("download");
        return;
      }

      // A file of the right size from an earlier try (the app was closed before
      // it installed) is hashed again rather than downloaded again.
      const existing = await LegacyFileSystem.getInfoAsync(fileUri).catch(() => null);
      if (!existing?.exists || existing.size !== manifest.size) {
        let lastPercent = -1;
        const task = LegacyFileSystem.createDownloadResumable(manifest.url, fileUri, { cache: false }, (progress) => {
          const percent = Math.floor((progress.totalBytesWritten / manifest.size) * 100);
          if (percent === lastPercent) return;
          lastPercent = percent;
          set({ ...NONE, phase: "downloading", manifest, received: progress.totalBytesWritten, total: manifest.size });
        });
        try {
          const result = await task.downloadAsync();
          if (!result || result.status !== 200) {
            await fail("download");
            return;
          }
        } catch (error) {
          await fail(looksOffline(error) ? "offline" : "download");
          return;
        }
      }

      set({ ...NONE, phase: "verifying", manifest, received: manifest.size, total: manifest.size });
      try {
        const info = await LegacyFileSystem.getInfoAsync(fileUri);
        const size = info.exists ? info.size : null;
        // The size is checked before the hash so a truncated file is not read.
        const sha256 = size === manifest.size ? await native.sha256File(fileUri) : null;
        const archive = sha256 ? await native.archiveInfo(fileUri) : null;
        const verdict = verifyDownload({ manifest, size, sha256, archive, installedSigners: native.installedApp().signers });
        if (!verdict.ok) {
          await fail(verdict.failure);
          return;
        }
        const ready: UpdateState = { ...NONE, phase: "ready", manifest, fileUri };
        if (!verdict.installsOverThisApp) {
          // Android would refuse it: say so now instead of opening an
          // installer that can only fail.
          set({ ...ready, phase: "reinstall" });
          explainReinstall(manifest);
          return;
        }
        set(ready);
        await install(ready);
      } catch {
        await fail("download");
      }
    },
    [explainReinstall, install, problem, set],
  );

  const press = useCallback(() => {
    const current = stateRef.current;
    if (!current.manifest) return;
    if (current.phase === "available") void downloadAndVerify(current.manifest);
    else if (current.phase === "ready") void install(current);
    else if (current.phase === "reinstall") explainReinstall(current.manifest);
  }, [downloadAndVerify, explainReinstall, install]);

  const value = useMemo(
    () => ({
      view: appUpdateView({
        phase: state.phase,
        versionName: state.manifest?.versionName ?? null,
        received: state.received,
        total: state.total,
      }),
      press,
    }),
    [state, press],
  );

  return <AppUpdateContext.Provider value={value}>{children}</AppUpdateContext.Provider>;
}
