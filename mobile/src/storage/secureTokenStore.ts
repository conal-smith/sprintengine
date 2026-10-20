import * as SecureStore from "expo-secure-store";

import {
  createDeviceNotesStore,
  createProjectContextStore,
  createSessionListStore,
  createThemePreferenceStore,
  rememberAvailability,
  type DeviceNotesStore,
  type SessionStorageAdapter,
  type StoredSessionList,
} from "./sessionStore";

import { sweepRelayRecords } from "./relayCleanup";

import type { MobileSession } from "../api/types";
import type { ThemePreferenceStore } from "../theme/ThemeProvider";

export interface SecureSessionListStore {
  getSessionList(): Promise<StoredSessionList>;
  upsertSession(session: MobileSession): Promise<StoredSessionList>;
  updateSession(session: MobileSession): Promise<StoredSessionList>;
  removeSession(deviceId: string): Promise<StoredSessionList>;
  setActiveSession(deviceId: string): Promise<StoredSessionList>;
}

export interface SecureProjectContextStore {
  getCurrentProjectKey(): Promise<string | null>;
  saveCurrentProjectKey(key: string): Promise<void>;
  getStarredProjectKeys(): Promise<string[]>;
  saveStarredProjectKeys(keys: string[]): Promise<void>;
}

// Every store shares this adapter, so the keychain's availability is asked
// once per run (see `rememberAvailability`).
const secureStorageAdapter: SessionStorageAdapter = rememberAvailability({
  isAvailable: isSecureStoreAvailable,
  getItem: SecureStore.getItemAsync,
  setItem: (key, value) =>
    SecureStore.setItemAsync(key, value, {
      keychainAccessible: SecureStore.WHEN_UNLOCKED_THIS_DEVICE_ONLY,
    }),
  deleteItem: SecureStore.deleteItemAsync,
});

// The relay sweep runs before the list is first read, so a phone updating from a
// relay-era build opens on its tailnet pairings already moved into the v3 list.
export const createSecureSessionListStore = (): SecureSessionListStore =>
  createSessionListStore(secureStorageAdapter, { prepare: () => sweepRelayRecords(secureStorageAdapter) });

export const createSecureThemePreferenceStore = (): ThemePreferenceStore =>
  createThemePreferenceStore(secureStorageAdapter);

export const createSecureProjectContextStore = (): SecureProjectContextStore =>
  createProjectContextStore(secureStorageAdapter);

export const createSecureDeviceNotesStore = (): DeviceNotesStore => createDeviceNotesStore(secureStorageAdapter);

async function isSecureStoreAvailable() {
  try {
    return await SecureStore.isAvailableAsync();
  } catch {
    return false;
  }
}
