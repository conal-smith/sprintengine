export {
  mobileControlProtocolVersion,
  type MobileControlCommand,
  type MobileControlErrorCode,
  type MobileControlSnapshot,
  type MobileSnapshotCollection,
  validateMobileControlSnapshot,
} from "../shared/mobile-control";

/**
 * One paired desktop, as this phone holds it: a tailnet pairing with the
 * desktop's Studio gateway. There is no other kind — the phone reaches a
 * desktop over the tailnet and nowhere else.
 */
export interface MobileSession {
  deviceId: string;
  desktopName: string;
  /**
   * The desktop gateway's base URL on the tailnet (`http://<tailnet-host>:<port>`).
   * Client base URL, settings display, and the storage dedupe key.
   */
  baseUrl: string;
  /**
   * The `mctn_` device token the gateway issued at pairing. It does not expire:
   * revocation on the desktop is the lifecycle, and it surfaces as a 401 on the
   * next call.
   */
  deviceToken: string;
  pairedAt: string;
  /**
   * The gateway's scope grant (`workspace:read`, `conversation:operate`, …), frozen
   * at pair time. Widening it means pairing again.
   */
  tailnetScopes: string[];
  /**
   * What the desktop's gateway said it speaks: its
   * `transportVersion`, and the additive `capabilities` it named. Read at pair
   * time and again on foreground. Absent on pairings made before either side
   * declared anything — those read as "unknown", never as "old".
   */
  tailnetTransportVersion?: number;
  tailnetCapabilities?: string[];
  /**
   * How the desktop draws itself as a machine — its kind and colour, the
   * person's override applied — from the `machine` its identity answers with.
   * Re-read on foreground with the declaration. Absent from a Studio that does
   * not send one, and then the desktop wears the generic remote mark.
   */
  machineMark?: DesktopMachineMark;
  status?: DesktopSessionStatus;
  lastSeenAt?: string;
  revokedAt?: string;
}

/** The paired desktop's machine mark, as its identity sends it. */
export interface DesktopMachineMark {
  kind: string;
  color: string;
}

export type DesktopSessionStatus = "online" | "offline" | "stale" | "revoked";

export interface ApiResult<TData> {
  ok: boolean;
  data?: TData;
  errorCode?: import("../shared/mobile-control").MobileControlErrorCode;
  message?: string;
}
