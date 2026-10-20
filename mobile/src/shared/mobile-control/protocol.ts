export const mobileControlProtocolVersion = 4 as const;

/**
 * Every protocol version this desktop still accepts from a phone, oldest first.
 *
 * The desktop and the phone are two separately installed apps, and the phone's
 * update goes through a store review this repository does not control. Exact
 * equality — which is what every check here did until now — meant the hour
 * between shipping a desktop bump and the phone's build clearing review was an
 * hour in which every paired phone was refused outright, with
 * `unsupported_protocol_version` and no way for its owner to act on it.
 *
 * One version of slack is the smallest window that survives that, and the
 * largest that does not ask this code to remember two wire shapes indefinitely.
 * Widening it is a decision about how long an old phone keeps working; see
 * `docs/compatibility.md` for what a bump obliges a contributor to do.
 *
 * Outbound traffic is unaffected: this desktop always STAMPS
 * `mobileControlProtocolVersion`. The window governs only what it will read.
 */
export const mobileControlSupportedProtocolVersions = [3, 4] as const;

export type MobileControlProtocolVersion = (typeof mobileControlSupportedProtocolVersions)[number];

/**
 * The window has to END at the version this build speaks, or the desktop would
 * be advertising a version it does not itself accept back. A compile error here
 * means a bump changed `mobileControlProtocolVersion` and left the window behind.
 */
type _AssertWindowEndsAtCurrent =
  (typeof mobileControlSupportedProtocolVersions) extends readonly [...unknown[], typeof mobileControlProtocolVersion]
    ? true
    : ["mobileControlSupportedProtocolVersions must end at mobileControlProtocolVersion"];
const _windowEndsAtCurrent: _AssertWindowEndsAtCurrent = true;
void _windowEndsAtCurrent;

/** The oldest phone this desktop will still talk to. */
export const mobileControlMinSupportedProtocolVersion = mobileControlSupportedProtocolVersions[0];

export function isSupportedMobileControlProtocolVersion(value: unknown): value is MobileControlProtocolVersion {
  return (mobileControlSupportedProtocolVersions as readonly unknown[]).includes(value);
}

/**
 * Why a payload was refused, naming both the version seen and the window.
 *
 * Both, because either alone is undiagnosable: the phone's owner cannot act on
 * "unsupported version" without knowing which side is behind, and a support
 * thread that carries only one number cannot tell a phone that is too old from
 * one that is too new.
 */
export function unsupportedMobileControlProtocolVersion(
  seen: unknown,
  accepts: "window" | "current" = "window",
): string {
  // What the READER accepts, which is not always the window — a payload the
  // desktop sends is read at the current version only. Saying "speaks 1-2" on a
  // refusal that accepted neither would send someone looking for a bug that is
  // not there. Collapses to a single number once the window narrows to one.
  const speaks =
    accepts === "current"
      ? String(mobileControlProtocolVersion)
      : [...new Set<number>([mobileControlMinSupportedProtocolVersion, mobileControlProtocolVersion])].join("-");
  const saw = typeof seen === "number" ? String(seen) : "no readable version";
  return `mobile-control protocol version ${saw} is not supported; this build speaks ${speaks}`;
}

export type MobileControlCommandType =
  | "snapshot.request"
  | "device.revoke"
  | "backlog.update"
  | "backlog.create";

export type MobileControlEventType =
  | "snapshot.updated"
  | "command.accepted"
  | "command.rejected"
  | "device.presence"
  | "notification.created";

export type MobileControlCapability =
  | "snapshots.read"
  | "devices.revoke"
  | "backlog.update"
  | "backlog.create";

export type MobileControlErrorCode =
  | "unsupported_protocol_version"
  | "invalid_payload"
  | "unauthenticated"
  | "unauthorized"
  | "device_revoked"
  | "desktop_unavailable"
  | "relay_unavailable"
  | "command_not_supported"
  | "command_expired"
  | "duplicate_idempotency_key"
  | "stale_snapshot"
  | "path_not_allowed"
  | "snapshot_too_large"
  | "internal_error";

export type MobileNotificationCategory = "command.failed" | "desktop.offline";

export type MobileNotificationTarget =
  | { kind: "command"; commandId: string }
  | { kind: "desktop" };

export interface MobileControlError {
  protocolVersion: MobileControlProtocolVersion;
  code: MobileControlErrorCode;
  message: string;
  retryable: boolean;
  correlationId?: string;
  detail?: Record<string, string | number | boolean | null>;
}

export interface MobileControlCapabilities {
  protocolVersion: MobileControlProtocolVersion;
  deviceId: string;
  commands: MobileControlCommandType[];
  capabilities: MobileControlCapability[];
  snapshotTtlMs: number;
}

export type MobileControlDevicePlatform = "ios" | "android" | "web";

export interface MobileControlDevice {
  protocolVersion: MobileControlProtocolVersion;
  deviceId: string;
  displayName: string;
  platform: MobileControlDevicePlatform;
  appVersion: string;
  pairedAt: string;
  lastSeenAt?: string;
  revokedAt?: string;
  capabilities: MobileControlCapability[];
}

export interface MobileControlCommandBase<Type extends MobileControlCommandType, Payload> {
  protocolVersion: MobileControlProtocolVersion;
  commandId: string;
  type: Type;
  issuedAt: string;
  deviceId: string;
  idempotencyKey?: string;
  expectedSnapshotVersion?: string;
  payload: Payload;
}

// Snapshot collections a `snapshot.request` may scope down to (item 1600). It
// ships by default.
export const mobileSnapshotCollections = [
  "backlog",
] as const;
export type MobileSnapshotCollection = (typeof mobileSnapshotCollections)[number];

export type SnapshotRequestCommand = MobileControlCommandBase<
  "snapshot.request",
  {
    /**
     * The `snapshotVersion` the client already holds. When it equals the
     * version the desktop would ship, `dispatchSnapshotRequest` skips the
     * payload and answers `{ ok: true, unchanged: true, snapshotVersion }`
     * (item 1599) — an If-None-Match on the read path. Additive and
     * old-client-safe: a client that omits it gets the full snapshot exactly
     * as before, so it cost no version bump of its own.
     *
     * This is skip-on-match, the opposite of the base `expectedSnapshotVersion`
     * (a reject-on-mismatch mutation guard) — do not fold the two together.
     */
    knownSnapshotVersion?: string;
    /**
     * Scope the snapshot to a single project root (item 1600). The value is the
     * relay-safe workspace token the phone already holds as `projectKey` on every
     * collection (deriveWorkspaceId output); the desktop resolves it back to the
     * real root and returns only that root's backlog.
     * Additive and old-client-safe.
     */
    workspacePath?: string;
    /**
     * Restrict the payload to these collections (item 1600) so a list screen can
     * skip the ones it does not render. Absent means every collection.
     */
    include?: MobileSnapshotCollection[];
  }
>;

export type DeviceRevokeCommand = MobileControlCommandBase<
  "device.revoke",
  {
    deviceId: string;
    reason?: string;
  }
>;

export type BacklogUpdateCommand = MobileControlCommandBase<
  "backlog.update",
  {
    workspacePath: string;
    relativePath: string;
    status?: MobileControlBacklogItemStatus;
    type?: MobileControlBacklogItemType;
    difficulty?: MobileControlBacklogItemDifficulty;
    criticality?: MobileControlBacklogItemCriticality;
  }
>;


export type BacklogCreateCommand = MobileControlCommandBase<
  "backlog.create",
  {
    workspacePath: string;
    title: string;
    description?: string;
    type?: MobileControlBacklogItemType;
    difficulty?: MobileControlBacklogItemDifficulty;
    criticality?: MobileControlBacklogItemCriticality;
  }
>;

export type MobileControlCommand =
  | SnapshotRequestCommand
  | DeviceRevokeCommand
  | BacklogUpdateCommand
  | BacklogCreateCommand;

export type MobileControlBacklogItemStatus = "idea" | "ready" | "in_progress" | "needs_input" | "completed" | "archived";
export type MobileControlBacklogItemType = "epic" | "feature" | "bug" | "mockup" | "spike";
export type MobileControlBacklogItemDifficulty = "xs" | "s" | "m" | "l" | "xl";
export type MobileControlBacklogItemCriticality = "low" | "normal" | "high" | "critical";

export interface MobileControlBacklogItemSnapshot {
  itemId: string;
  relativePath: string;
  title: string;
  excerpt?: string;
  status: MobileControlBacklogItemStatus;
  type?: MobileControlBacklogItemType;
  difficulty?: MobileControlBacklogItemDifficulty;
  criticality?: MobileControlBacklogItemCriticality;
  // The up-pointing epic slug (frontmatter `epic:`) when this item belongs to an
  // epic; absent otherwise. The epic -> children direction stays a derived query.
  epic?: string;
  updatedAt?: string;
}

// Per-workspace epic metadata (MC-1498). Items carry only the `epic` up-slug; the
// phone renders desktop-parity epic chips and color bands, which need the epic's
// display id and color. Kept as a per-workspace block rather than denormalized
// onto every item.
export interface MobileControlBacklogEpicSnapshot {
  /** The epic slug (matches an item's `epic` up-slug). */
  slug: string;
  /** The epic's display id, e.g. `MC-1493`, when the epic file carries an `id`. */
  displayId?: string;
  title?: string;
  /** One of the desktop seven-color highlight set, when the epic sets `color`. */
  color?: string;
  /** Rollup over the epic's member items. */
  doneCount: number;
  totalCount: number;
}

export interface MobileControlBacklogWorkspaceSnapshot {
  workspaceId: string;
  workspacePath: string;
  /** The repo this backlog group belongs to, as a relay-safe token (MC-1583). */
  projectKey?: string;
  workspaceName: string;
  updatedAt: string;
  items: MobileControlBacklogItemSnapshot[];
  /** Epic metadata for the workspace's epics (MC-1498). */
  epics?: MobileControlBacklogEpicSnapshot[];
}

/**
 * A web page on this desktop that a phone can actually open.
 *
 * The pane's browser tab is not one of these: it holds a `localhost` URL, and
 * localhost on a phone is the phone. What a phone can open is a dev server the
 * desktop has published on the tailnet (`tailscale serve`), which is a real
 * HTTPS origin reachable from any device on the tailnet.
 *
 * Additive and optional, so a phone that predates it simply does not draw the
 * screen.
 */
export interface MobileControlWebTargetSnapshot {
  /** Stable within a desktop session: the HTTPS port publishing it. */
  id: string;
  /** What a person recognises — the local port and the process serving it. */
  label: string;
  /** `https://<node>.<tailnet>.ts.net[:port]/` — opened as-is, never rewritten. */
  url: string;
  /** The loopback port on the desktop, for the label and for matching. */
  localPort: number;
  /** The desktop publishing it, by MagicDNS name. */
  machine: string;
}

export interface MobileControlSnapshot {
  protocolVersion: MobileControlProtocolVersion;
  generatedAt: string;
  desktopSessionId: string;
  snapshotVersion?: string;
  // Deliberately `string[]`, not MobileControlCommandType[]: the desktop may
  // advertise commands newer than this client (dark-launched controls gate on
  // them by raw string — see snapshotAdvertisesCapability). Rejecting unknown
  // entries here would turn every desktop command addition into a client that
  // can no longer read snapshots at all.
  commands?: string[];
  backlog?: MobileControlBacklogWorkspaceSnapshot[];
  // Dev servers this desktop publishes on the tailnet, so the phone has a door
  // to them (Track 1b). Additive and omitted when there are none.
  webTargets?: MobileControlWebTargetSnapshot[];
}

export interface MobileControlEventBase<Type extends MobileControlEventType, Payload> {
  protocolVersion: MobileControlProtocolVersion;
  eventId: string;
  type: Type;
  emittedAt: string;
  payload: Payload;
}

export type SnapshotUpdatedEvent = MobileControlEventBase<
  "snapshot.updated",
  {
    snapshot: MobileControlSnapshot;
  }
>;

export type CommandAcceptedEvent = MobileControlEventBase<
  "command.accepted",
  {
    commandId: string;
    acceptedAt: string;
  }
>;

export type CommandRejectedEvent = MobileControlEventBase<
  "command.rejected",
  {
    commandId: string;
    error: MobileControlError;
  }
>;

export type DevicePresenceEvent = MobileControlEventBase<
  "device.presence",
  {
    device: MobileControlDevice;
    presence: "online" | "offline" | "revoked";
  }
>;

export type NotificationCreatedEvent = MobileControlEventBase<
  "notification.created",
  {
    category: MobileNotificationCategory;
    title: string;
    body: string;
    severity: "info" | "warning" | "error";
    deepLink: string;
    target: MobileNotificationTarget;
  }
>;

export type MobileControlEvent =
  | SnapshotUpdatedEvent
  | CommandAcceptedEvent
  | CommandRejectedEvent
  | DevicePresenceEvent
  | NotificationCreatedEvent;

export type ValidationResult<T> =
  | {
      ok: true;
      value: T;
    }
  | {
      ok: false;
      error: MobileControlError;
    };

type ObjectValidationResult =
  | {
      ok: true;
      value: Record<string, unknown>;
    }
  | {
      ok: false;
      error: string;
    };

const commandTypes = [
  "snapshot.request",
  "device.revoke",
  "backlog.update",
  "backlog.create",
] as const satisfies readonly MobileControlCommandType[];

const eventTypes = [
  "snapshot.updated",
  "command.accepted",
  "command.rejected",
  "device.presence",
  "notification.created",
] as const satisfies readonly MobileControlEventType[];

const capabilities = [
  "snapshots.read",
  "devices.revoke",
  "backlog.update",
  "backlog.create",
] as const satisfies readonly MobileControlCapability[];

// `satisfies` only proves the entries are valid, not that the list is
// complete — the backlog trio above was once missing here (MC-1499), so
// validateCapabilityArray rejected device payloads carrying scopes that
// pairing actually grants. This alias turns a missing member into a compile
// error.
type _AssertCapabilityListComplete = [
  Exclude<MobileControlCapability, (typeof capabilities)[number]>,
] extends [never]
  ? true
  : ["capabilities const is missing", Exclude<MobileControlCapability, (typeof capabilities)[number]>];
const _capabilityListComplete: _AssertCapabilityListComplete = true;
void _capabilityListComplete;

const errorCodes = [
  "unsupported_protocol_version",
  "invalid_payload",
  "unauthenticated",
  "unauthorized",
  "device_revoked",
  "desktop_unavailable",
  "relay_unavailable",
  "command_not_supported",
  "command_expired",
  "duplicate_idempotency_key",
  "stale_snapshot",
  "path_not_allowed",
  "snapshot_too_large",
  "internal_error",
] as const satisfies readonly MobileControlErrorCode[];

const devicePlatforms = ["ios", "android", "web"] as const satisfies readonly MobileControlDevicePlatform[];
const presenceValues = ["online", "offline", "revoked"] as const;
const severityValues = ["info", "warning", "error"] as const;
const notificationCategories = [
  "command.failed",
  "desktop.offline",
] as const satisfies readonly MobileNotificationCategory[];
const notificationTargetKinds = ["command", "desktop"] as const;
export function validateMobileControlCommand(input: unknown): ValidationResult<MobileControlCommand> {
  const base = validateObject(input, "command");
  if (base.ok === false) {
    return invalidPayload(base.error);
  }

  const versionError = validateProtocolVersion(base.value);
  if (versionError) {
    return versionError;
  }

  const baseError =
    requireString(base.value, "commandId") ??
    requireString(base.value, "issuedAt") ??
    requireIsoDate(base.value, "issuedAt") ??
    requireString(base.value, "deviceId");
  if (baseError) {
    return invalidPayload(baseError);
  }

  const type = base.value.type;
  if (!isOneOf(type, commandTypes)) {
    return invalidPayload("command.type must be a supported mobile-control command");
  }

  const payload = validateObject(base.value.payload, "command.payload");
  if (payload.ok === false) {
    return invalidPayload(payload.error);
  }

  const idempotencyError = optionalString(base.value, "idempotencyKey") ?? optionalString(base.value, "expectedSnapshotVersion");
  if (idempotencyError) {
    return invalidPayload(idempotencyError);
  }

  const payloadError = validateCommandPayload(type, payload.value);
  if (payloadError) {
    return invalidPayload(payloadError);
  }

  return { ok: true, value: input as MobileControlCommand };
}

export function validateMobileControlEvent(input: unknown): ValidationResult<MobileControlEvent> {
  const event = validateObject(input, "event");
  if (event.ok === false) {
    return invalidPayload(event.error);
  }

  const versionError = validateProtocolVersion(event.value, "current");
  if (versionError) {
    return versionError;
  }

  const baseError =
    requireString(event.value, "eventId") ??
    requireString(event.value, "emittedAt") ??
    requireIsoDate(event.value, "emittedAt");
  if (baseError) {
    return invalidPayload(baseError);
  }

  const type = event.value.type;
  if (!isOneOf(type, eventTypes)) {
    return invalidPayload("event.type must be a supported mobile-control event");
  }

  const payload = validateObject(event.value.payload, "event.payload");
  if (payload.ok === false) {
    return invalidPayload(payload.error);
  }

  const payloadError = validateEventPayload(type, payload.value);
  if (payloadError) {
    return invalidPayload(payloadError);
  }

  return { ok: true, value: input as MobileControlEvent };
}

export function validateMobileControlSnapshot(input: unknown): ValidationResult<MobileControlSnapshot> {
  const snapshot = validateObject(input, "snapshot");
  if (snapshot.ok === false) {
    return invalidPayload(snapshot.error);
  }

  const versionError = validateProtocolVersion(snapshot.value, "current");
  if (versionError) {
    return versionError;
  }

  const baseError =
    requireString(snapshot.value, "generatedAt") ??
    requireIsoDate(snapshot.value, "generatedAt") ??
    requireString(snapshot.value, "desktopSessionId") ??
    optionalString(snapshot.value, "snapshotVersion");
  if (baseError) {
    return invalidPayload(baseError);
  }

  if (snapshot.value.commands !== undefined) {
    // Strings only, membership unchecked — unknown commands must flow through
    // so dark-launched capability gates can see them (see the field comment on
    // MobileControlSnapshot.commands).
    const commandError = validateStringArray(snapshot.value.commands, "snapshot.commands");
    if (commandError) {
      return invalidPayload(commandError);
    }
  }

  return { ok: true, value: input as MobileControlSnapshot };
}

export function validateMobileControlDevice(input: unknown): ValidationResult<MobileControlDevice> {
  const device = validateObject(input, "device");
  if (device.ok === false) {
    return invalidPayload(device.error);
  }

  const versionError = validateProtocolVersion(device.value);
  if (versionError) {
    return versionError;
  }

  const baseError =
    requireString(device.value, "deviceId") ??
    requireString(device.value, "displayName") ??
    requireString(device.value, "appVersion") ??
    requireString(device.value, "pairedAt") ??
    requireIsoDate(device.value, "pairedAt") ??
    requireArray(device.value, "capabilities") ??
    optionalIsoDate(device.value, "lastSeenAt") ??
    optionalIsoDate(device.value, "revokedAt");
  if (baseError) {
    return invalidPayload(baseError);
  }

  if (!isOneOf(device.value.platform, devicePlatforms)) {
    return invalidPayload("device.platform must be ios, android, or web");
  }

  const capabilitiesError = validateCapabilityArray(device.value.capabilities, "device.capabilities");
  if (capabilitiesError) {
    return invalidPayload(capabilitiesError);
  }

  return { ok: true, value: input as MobileControlDevice };
}

export function validateMobileControlCapabilities(input: unknown): ValidationResult<MobileControlCapabilities> {
  const contract = validateObject(input, "capabilities");
  if (contract.ok === false) {
    return invalidPayload(contract.error);
  }

  const versionError = validateProtocolVersion(contract.value);
  if (versionError) {
    return versionError;
  }

  const baseError =
    requireString(contract.value, "deviceId") ??
    requireArray(contract.value, "commands") ??
    requireArray(contract.value, "capabilities") ??
    requirePositiveInteger(contract.value, "snapshotTtlMs");
  if (baseError) {
    return invalidPayload(baseError);
  }

  const commandError = validateStringLiteralArray(contract.value.commands, commandTypes, "capabilities.commands");
  const capabilityError = validateCapabilityArray(contract.value.capabilities, "capabilities.capabilities");
  const error = commandError ?? capabilityError;
  if (error) {
    return invalidPayload(error);
  }

  return { ok: true, value: input as MobileControlCapabilities };
}

export function validateMobileControlError(input: unknown): ValidationResult<MobileControlError> {
  const error = validateObject(input, "error");
  if (error.ok === false) {
    return invalidPayload(error.error);
  }

  const versionError = validateProtocolVersion(error.value);
  if (versionError) {
    return versionError;
  }

  const baseError =
    requireString(error.value, "message") ??
    requireBoolean(error.value, "retryable") ??
    optionalString(error.value, "correlationId");
  if (baseError) {
    return invalidPayload(baseError);
  }

  if (!isOneOf(error.value.code, errorCodes)) {
    return invalidPayload("error.code must be a stable mobile-control error code");
  }

  if ("detail" in error.value && error.value.detail !== undefined) {
    const detail = validateObject(error.value.detail, "error.detail");
    if (detail.ok === false) {
      return invalidPayload(detail.error);
    }
    for (const [key, value] of Object.entries(detail.value)) {
      if (typeof value !== "string" && typeof value !== "number" && typeof value !== "boolean" && value !== null) {
        return invalidPayload(`error.detail.${key} must be a string, number, boolean, or null`);
      }
    }
  }

  return { ok: true, value: input as MobileControlError };
}

/**
 * How strict a reader is about the version stamped on what it just received.
 *
 * `window` accepts anything in `mobileControlSupportedProtocolVersions`, and is
 * for records where an OLDER counterpart is a case worth surviving: a command
 * from a phone whose store build has not cleared review yet, and the device and
 * capability records read back from disk, which were written by whatever version
 * was installed when they were stored.
 *
 * `current` accepts only the version this build speaks, and is for the payloads
 * the desktop SENDS. A window buys nothing there — a phone receiving a snapshot
 * from a newer desktop is not helped by also accepting older ones — and it costs
 * something real: an older snapshot can carry collections this wire has since
 * retired, so accepting its version would only get the reader further in before
 * failing on, or silently dropping, a shape it no longer has a type for.
 */
type ProtocolVersionStrictness = "window" | "current";

function validateProtocolVersion(
  record: Record<string, unknown>,
  strictness: ProtocolVersionStrictness = "window",
): ValidationResult<never> | null {
  const accepted =
    strictness === "current"
      ? record.protocolVersion === mobileControlProtocolVersion
      : isSupportedMobileControlProtocolVersion(record.protocolVersion);
  if (!accepted) {
    return {
      ok: false,
      error: buildError(
        "unsupported_protocol_version",
        unsupportedMobileControlProtocolVersion(record.protocolVersion, strictness),
        false,
      ),
    };
  }

  return null;
}

function validateCommandPayload(type: MobileControlCommandType, payload: Record<string, unknown>): string | null {
  switch (type) {
    case "snapshot.request":
      return (
        optionalString(payload, "knownSnapshotVersion") ??
        optionalString(payload, "workspacePath") ??
        optionalSnapshotCollections(payload, "include")
      );
    case "device.revoke":
      return requireString(payload, "deviceId") ?? optionalString(payload, "reason");
    case "backlog.update":
      return (
        requireString(payload, "workspacePath") ??
        requireString(payload, "relativePath") ??
        optionalString(payload, "status") ??
        optionalString(payload, "type") ??
        optionalString(payload, "difficulty") ??
        optionalString(payload, "criticality")
      );
    case "backlog.create":
      return (
        requireString(payload, "workspacePath") ??
        requireString(payload, "title") ??
        optionalString(payload, "description") ??
        optionalString(payload, "type") ??
        optionalString(payload, "difficulty") ??
        optionalString(payload, "criticality")
      );
  }
}

function validateEventPayload(type: MobileControlEventType, payload: Record<string, unknown>): string | null {
  switch (type) {
    case "snapshot.updated": {
      const snapshot = validateMobileControlSnapshot(payload.snapshot);
      if (snapshot.ok === false) {
        return snapshot.error.message;
      }
      return null;
    }
    case "command.accepted":
      return requireString(payload, "commandId") ?? requireString(payload, "acceptedAt") ?? requireIsoDate(payload, "acceptedAt");
    case "command.rejected": {
      const error = validateMobileControlError(payload.error);
      if (error.ok === false) {
        return error.error.message;
      }
      return requireString(payload, "commandId");
    }
    case "device.presence": {
      const device = validateMobileControlDevice(payload.device);
      if (device.ok === false) {
        return device.error.message;
      }
      return requireLiteral(payload, "presence", presenceValues);
    }
    case "notification.created":
      return (
        requireLiteral(payload, "category", notificationCategories) ??
        requireString(payload, "title") ??
        requireString(payload, "body") ??
        requireLiteral(payload, "severity", severityValues) ??
        requireString(payload, "deepLink") ??
        validateNotificationTarget(payload.target)
      );
  }
}

function validateNotificationTarget(input: unknown): string | null {
  const target = validateObject(input, "notification.target");
  if (target.ok === false) {
    return target.error;
  }

  const kindError = requireLiteral(target.value, "kind", notificationTargetKinds);
  if (kindError) {
    return kindError;
  }

  switch (target.value.kind) {
    case "command":
      return requireString(target.value, "commandId");
    case "desktop":
      return null;
  }

  return "notification.target.kind must be a supported notification target";
}

function validateCapabilityArray(input: unknown, fieldName: string): string | null {
  return validateStringLiteralArray(input, capabilities, fieldName);
}

function validateStringLiteralArray<const Values extends readonly string[]>(
  input: unknown,
  allowed: Values,
  fieldName: string,
): string | null {
  if (!Array.isArray(input)) {
    return `${fieldName} must be an array`;
  }

  for (const value of input) {
    if (!isOneOf(value, allowed)) {
      return `${fieldName} contains an unsupported value`;
    }
  }

  return null;
}

function validateStringArray(input: unknown, fieldName: string): string | null {
  if (!Array.isArray(input)) {
    return `${fieldName} must be an array`;
  }

  for (const value of input) {
    if (typeof value !== "string" || value.length === 0) {
      return `${fieldName} must contain only non-empty strings`;
    }
  }

  return null;
}

function validateObject(input: unknown, name: string): ObjectValidationResult {
  if (typeof input !== "object" || input === null || Array.isArray(input)) {
    return { ok: false, error: `${name} must be an object` };
  }

  return { ok: true, value: input as Record<string, unknown> };
}

function requireString(record: Record<string, unknown>, field: string): string | null {
  return typeof record[field] === "string" && record[field].length > 0 ? null : `${field} must be a non-empty string`;
}

function optionalString(record: Record<string, unknown>, field: string): string | null {
  return record[field] === undefined || (typeof record[field] === "string" && record[field].length > 0)
    ? null
    : `${field} must be a non-empty string when provided`;
}

function requireBoolean(record: Record<string, unknown>, field: string): string | null {
  return typeof record[field] === "boolean" ? null : `${field} must be a boolean`;
}

function requireArray(record: Record<string, unknown>, field: string): string | null {
  return Array.isArray(record[field]) ? null : `${field} must be an array`;
}

function requirePositiveInteger(record: Record<string, unknown>, field: string): string | null {
  return Number.isInteger(record[field]) && (record[field] as number) > 0 ? null : `${field} must be a positive integer`;
}





function requireIsoDate(record: Record<string, unknown>, field: string): string | null {
  const value = record[field];
  if (typeof value !== "string" || Number.isNaN(Date.parse(value))) {
    return `${field} must be an ISO 8601 timestamp`;
  }

  return null;
}

function optionalIsoDate(record: Record<string, unknown>, field: string): string | null {
  return record[field] === undefined ? null : requireIsoDate(record, field);
}



function requireLiteral<const Values extends readonly string[]>(
  record: Record<string, unknown>,
  field: string,
  allowed: Values,
): string | null {
  return isOneOf(record[field], allowed) ? null : `${field} must be one of: ${allowed.join(", ")}`;
}

function optionalSnapshotCollections(record: Record<string, unknown>, field: string): string | null {
  const value = record[field];
  if (value === undefined) {
    return null;
  }
  if (!Array.isArray(value)) {
    return `${field} must be an array of snapshot collections when provided`;
  }
  for (const entry of value) {
    if (!isOneOf(entry, mobileSnapshotCollections)) {
      return `${field} must contain only: ${mobileSnapshotCollections.join(", ")}`;
    }
  }
  return null;
}



function isOneOf<const Values extends readonly string[]>(input: unknown, values: Values): input is Values[number] {
  return typeof input === "string" && values.includes(input);
}

function invalidPayload(message: string): ValidationResult<never> {
  return {
    ok: false,
    error: buildError("invalid_payload", message, false),
  };
}

function buildError(code: MobileControlErrorCode, message: string, retryable: boolean): MobileControlError {
  return {
    protocolVersion: mobileControlProtocolVersion,
    code,
    message,
    retryable,
  };
}
