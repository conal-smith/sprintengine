import { requireOptionalNativeModule } from "expo";
import { Platform } from "react-native";

import type { ApkIdentity } from "./apkUpdateLogic";

// The app's own Android-only native module (modules/apk-updater): this
// install's versionCode and signing certificate, the "Install unknown apps"
// switch, and the streamed SHA-256 and identity of a downloaded APK. Null on
// iOS, and in a build made before the module existed, which is "no updater".

export interface InstalledApp extends ApkIdentity {
  versionName: string;
}

interface ApkUpdaterNative {
  installedApp(): InstalledApp;
  canRequestPackageInstalls(): boolean;
  sha256File(uri: string): Promise<string>;
  archiveInfo(uri: string): Promise<ApkIdentity | null>;
}

export const apkUpdater: ApkUpdaterNative | null =
  Platform.OS === "android" ? requireOptionalNativeModule<ApkUpdaterNative>("SprintEngineApkUpdater") : null;
