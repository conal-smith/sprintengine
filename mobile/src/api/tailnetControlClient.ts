import { readPeerRefusal, readTransportDeclaration, type TailnetTransportDeclaration } from "./tailnetTransport";
import {
  validateMobileControlSnapshot,
  type ApiResult,
  type DesktopMachineMark,
  type MobileControlCommand,
  type MobileControlErrorCode,
  type MobileControlSnapshot,
  type MobileSession,
  type MobileSnapshotCollection,
} from "./types";
import { pullRequestReadCommandTypes } from "../shared/mobile-control/protocol";

// The desktop gateway's tailnet surface: plain fetch + JSON-RPC, no account
// and no server in between. Prior art is the desktop's own
// tailnet-remote-client.ts; the contract is POST /tailnet/v1/pair once, then
// Bearer-authenticated JSON-RPC tools/call against /tailnet/v1/mcp. Never send
// an Origin header — the gateway refuses any request carrying one (React
// Native's native fetch sends none).
//
// The snapshot and the commands speak the mobile-control protocol
// (src/shared/mobile-control), which is why its validators are used here.

const TAILNET_MCP_PATH = "/tailnet/v1/mcp";
const TAILNET_PAIR_PATH = "/tailnet/v1/pair";
const TAILNET_IDENTITY_PATH = "/tailnet/v1/identity";
const SNAPSHOT_TOOL = "workspace.snapshot";
const COMMAND_TOOL = "workspace.mobile_command";
const READ_TIMEOUT_MS = 10_000;
// Mutations run synchronously inside the gateway's response (the desktop
// invokes the handler before answering), so they get 30s, not a read's 10 —
// aborting at 10s while the desktop is mid-execute manufactures phantom
// failures.
const MUTATION_TIMEOUT_MS = 30_000;

/**
 * The mobile commands the gateway serves in v1 — mirrors the desktop tool's
 * allowlist. Anything else is refused client-side as command_not_supported
 * so the failure names the transport rather than arriving as a mystery.
 */
export const tailnetSupportedCommands = ["snapshot.request", "backlog.update", "pullRequest.read", "pullRequest.diff"] as const;

export interface SnapshotReadOptions {
  /**
   * The `snapshotVersion` the phone already holds. When it still matches, the
   * desktop skips the up-to-256 KB payload and answers with a tiny
   * `{ unchanged: true, snapshotVersion }` marker — an If-None-Match on the
   * read path. Omit it to always receive the full snapshot.
   */
  knownSnapshotVersion?: string;
  /**
   * Restrict the payload to these collections so a screen skips the ones it
   * does not render. Omit for the desktop's default set.
   */
  include?: readonly MobileSnapshotCollection[];
}

/**
 * A snapshot read is either the full snapshot, or — when the phone's
 * `knownSnapshotVersion` still matched — a marker that nothing has changed, so
 * the caller keeps the snapshot it already holds and only refreshes freshness.
 */
export type SnapshotRead =
  | { unchanged: false; snapshot: MobileControlSnapshot }
  | { unchanged: true; snapshotVersion: string };

export interface MobileControlCommandInput {
  type: MobileControlCommand["type"];
  payload: Record<string, unknown>;
  expectedSnapshotVersion?: string;
}

/** A command the desktop refused, carrying the wire's error code for the caller to branch on. */
export class DesktopCommandError extends Error {
  readonly code?: MobileControlErrorCode;
  constructor(message: string, code?: MobileControlErrorCode) {
    super(message);
    this.name = "DesktopCommandError";
    this.code = code;
  }
}

export const knownCommandTypes = [
  "snapshot.request",
  "device.revoke",
  "backlog.update",
  "backlog.create",
  "pullRequest.read",
  "pullRequest.diff",
] as const satisfies readonly MobileControlCommand["type"][];

// A hand-kept list silently drops a command the union gains, and a capable desktop
// advertising that command is then filtered out of the capability gate. `satisfies`
// proves each entry is valid; this alias turns a MISSING one into a compile error
// (same guard protocol.ts uses for its capability list).
type _AssertKnownCommandsComplete = [
  Exclude<MobileControlCommand["type"], (typeof knownCommandTypes)[number]>,
] extends [never]
  ? true
  : ["knownCommandTypes is missing", Exclude<MobileControlCommand["type"], (typeof knownCommandTypes)[number]>];
const _knownCommandsComplete: _AssertKnownCommandsComplete = true;
void _knownCommandsComplete;

/**
 * The snapshot collections this app asks for on every read, sent as `include`
 * so the desktop composes exactly these.
 *
 * This is every collection the wire declares. `sprintEngines` and
 * `roleCatalogs` left it with protocol v3, `desktopWorkspaces` — the
 * Switchboard and Watchtower projections the desktop stopped producing on
 * 2026-09-08 — with v4, and `automations` on 2026-09-29, when the phone stopped
 * rendering the desktop's automations at all. The phone stopped asking for each
 * no later than the wire dropped it.
 *
 * It lives here rather than beside its consumer so the regression suite can pin it:
 * `SessionDataProvider` cannot be loaded under the bare-Node test build.
 */
export const POLLED_SNAPSHOT_COLLECTIONS: readonly MobileSnapshotCollection[] = ["backlog"];

const knownApiErrorCodes: readonly MobileControlErrorCode[] = [
  "unsupported_protocol_version",
  "invalid_payload",
  "unauthenticated",
  "unauthorized",
  "device_revoked",
  "desktop_unavailable",
  "command_not_supported",
  "command_expired",
  "duplicate_idempotency_key",
  "stale_snapshot",
  "path_not_allowed",
  "snapshot_too_large",
  "internal_error",
];

/** The commands a desktop advertises on its snapshot, narrowed to the ones this build knows. */
export function readSnapshotCommands(input: unknown): ReadonlySet<MobileControlCommand["type"]> {
  if (!Array.isArray(input)) {
    return new Set();
  }
  const allowed: Set<MobileControlCommand["type"]> = new Set();
  for (const value of input) {
    if (typeof value === "string" && (knownCommandTypes as readonly string[]).includes(value)) {
      allowed.add(value as MobileControlCommand["type"]);
    }
  }
  return allowed;
}

/**
 * Whether this pairing's grant covers a command — mapped to what the desktop
 * ENFORCES, not what the scope names suggest. Every mobile mutation rides one
 * gateway tool (workspace.mobile_command), which the desktop gates on
 * `workspace:operate` regardless of the inner command type; a device's
 * per-family grants (backlog:operate and friends) are never consulted on this
 * transport. So workspace:operate unlocks every served mutation, and the
 * per-family scopes unlock nothing — drawing a control the desktop would
 * refuse is the bug this exists to prevent. A command the gateway does not
 * serve at all is never granted. The desktop can widen or narrow a grant
 * after pairing; the phone re-reads it from the identity on foreground
 * (`withTailnetScopes`).
 */
export function tailnetGrantAllows(
  tailnetScopes: readonly string[] | undefined,
  type: MobileControlCommand["type"],
): boolean {
  const scopes = tailnetScopes ?? [];
  if (!(tailnetSupportedCommands as readonly string[]).includes(type)) {
    return false;
  }
  if (type === "snapshot.request") {
    return scopes.includes("workspace:read") || scopes.includes("workspace:operate");
  }
  return scopes.includes("workspace:operate");
}

/**
 * The session with the grant the desktop holds for it now, or null when that
 * is the one already held (or the identity said none). A grant widened on the
 * desktop unlocks the phone's controls without pairing again, and a narrowed
 * one takes away controls the desktop would refuse.
 */
export function withTailnetScopes<T extends { tailnetScopes: string[] }>(session: T, scopes: readonly string[] | null): T | null {
  if (!scopes) return null;
  const held = new Set(session.tailnetScopes);
  if (scopes.length === held.size && scopes.every((scope) => held.has(scope))) return null;
  return { ...session, tailnetScopes: [...new Set(scopes)] };
}

/** The gateway client for one paired desktop. */
export function tailnetClientForSession(session: MobileSession): TailnetControlClient {
  return new TailnetControlClient({ baseUrl: session.baseUrl, deviceToken: session.deviceToken });
}

export interface TailnetPairingCompletion {
  deviceId: string;
  deviceName: string;
  deviceToken: string;
  scopes: string[];
  /** What the gateway said it speaks, if it said (a version-1 Studio says nothing here). */
  transport: TailnetTransportDeclaration;
}

export async function completeTailnetPairing(input: {
  baseUrl: string;
  pairingToken: string;
  deviceName: string;
}): Promise<ApiResult<TailnetPairingCompletion>> {
  let response: Response;
  try {
    response = await fetchWithTimeout(`${input.baseUrl}${TAILNET_PAIR_PATH}`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ pairingToken: input.pairingToken, deviceName: input.deviceName }),
    });
  } catch {
    return {
      ok: false,
      errorCode: "desktop_unavailable",
      message: "The desktop's tailnet gateway is unreachable. Is Tailscale up on both devices, and remote control enabled on the desktop?",
    };
  }

  const body = (await response.json().catch(() => null)) as Record<string, unknown> | null;
  if (!response.ok) {
    // The gateway refuses as { error: { code, message } } (older shapes may be
    // a bare string) — surface its own reason when it gives one.
    const gatewayError = isRecord(body?.error)
      ? (typeof body.error.message === "string" && body.error.message) ||
        (typeof body.error.code === "string" && body.error.code) ||
        null
      : typeof body?.error === "string"
        ? body.error
        : null;
    return {
      ok: false,
      errorCode: response.status === 400 ? "invalid_payload" : "unauthenticated",
      message: gatewayError
        ? `The desktop refused the pairing: ${gatewayError}.`
        : "The desktop refused the pairing code. Codes are single-use and expire — generate a fresh one from the desktop.",
    };
  }
  if (
    !body ||
    typeof body.deviceId !== "string" ||
    typeof body.deviceName !== "string" ||
    typeof body.deviceToken !== "string" ||
    !Array.isArray(body.scopes) ||
    body.scopes.some((scope) => typeof scope !== "string")
  ) {
    return { ok: false, errorCode: "invalid_payload", message: "The desktop returned an invalid pairing response." };
  }
  return {
    ok: true,
    data: {
      deviceId: body.deviceId,
      deviceName: body.deviceName,
      deviceToken: body.deviceToken,
      scopes: body.scopes as string[],
      transport: readTransportDeclaration(body),
    },
  };
}

/**
 * `GET /tailnet/v1/identity`: what the gateway says about this pairing and
 * itself, of which the phone keeps the grant, the transport declaration and
 * the machine mark. Read on foreground because a Studio
 * updates under a standing pairing, and its grant can be widened or narrowed
 * there, so the pair-time answer goes stale. One cheap GET; a 401 is the
 * pairing being gone, which the caller already knows how to say. `scopes` is
 * null when the answer carries none, which says nothing about the grant.
 */
export async function readTailnetIdentity(input: {
  baseUrl: string;
  deviceToken: string;
}): Promise<
  ApiResult<{ scopes: string[] | null; transport: TailnetTransportDeclaration; machine: DesktopMachineMark | null }>
> {
  let response: Response;
  try {
    response = await fetchWithTimeout(`${input.baseUrl}${TAILNET_IDENTITY_PATH}`, {
      method: "GET",
      headers: { authorization: `Bearer ${input.deviceToken}` },
    });
  } catch {
    return { ok: false, errorCode: "desktop_unavailable", message: "The desktop did not answer." };
  }
  const body = (await response.json().catch(() => null)) as Record<string, unknown> | null;
  if (response.status === 401) return unauthorizedResult(body);
  if (!response.ok || !body) {
    return { ok: false, errorCode: "desktop_unavailable", message: `The desktop answered ${response.status}.` };
  }
  const scopes = Array.isArray(body.scopes) ? body.scopes.filter((scope): scope is string => typeof scope === "string") : null;
  return { ok: true, data: { scopes, transport: readTransportDeclaration(body), machine: readIdentityMachine(body.machine) } };
}

/**
 * The identity's `machine`: how the desktop draws itself, kind and colour as
 * strings. Kept as sent, and read into a known kind and colour where it is
 * drawn (`readMachineMark`), so a kind this build has never heard of still
 * marks the desktop. Null when absent or not in that shape.
 */
export function readIdentityMachine(value: unknown): DesktopMachineMark | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const { kind, color } = value as Record<string, unknown>;
  if (typeof kind !== "string" || typeof color !== "string") return null;
  return { kind, color };
}

export class TailnetControlClient {
  private readonly baseUrl: string;
  private readonly deviceToken: string;
  private requestCounter = 0;

  constructor(options: { baseUrl: string; deviceToken: string }) {
    this.baseUrl = options.baseUrl;
    this.deviceToken = options.deviceToken;
  }

  async readSnapshot(options: SnapshotReadOptions = {}): Promise<ApiResult<SnapshotRead>> {
    const args: Record<string, unknown> = {};
    if (options.include && options.include.length > 0) {
      args.include = options.include;
    }
    if (options.knownSnapshotVersion) {
      args.knownSnapshotVersion = options.knownSnapshotVersion;
    }
    const result = await this.callTool(SNAPSHOT_TOOL, args);
    if (!result.ok) {
      return { ok: false, errorCode: result.errorCode, message: result.message };
    }
    const structured = result.data as Record<string, unknown>;
    const unchanged = readUnchangedMarker(structured, options.knownSnapshotVersion);
    if (unchanged) {
      return { ok: true, data: unchanged };
    }
    return validateSnapshotResult(structured.snapshot);
  }

  async sendCommand<TResult>(command: MobileControlCommandInput): Promise<ApiResult<TResult>> {
    if (!(tailnetSupportedCommands as readonly string[]).includes(command.type)) {
      return {
        ok: false,
        errorCode: "command_not_supported",
        message: `${command.type} is not served over the tailnet transport yet.`,
      };
    }
    const result = await this.callTool(
      COMMAND_TOOL,
      {
        type: command.type,
        payload: command.payload,
        // The gateway replays a repeated key instead of re-executing; a
        // crypto-random key per sendCommand call cannot collide across
        // rapid-fire commands the way a millisecond timestamp can.
        idempotencyKey: `tnk_${randomToken()}`,
        ...(command.expectedSnapshotVersion ? { expectedSnapshotVersion: command.expectedSnapshotVersion } : {}),
      },
      // A read that times out did nothing, and says so in a read's words;
      // its gh calls on the desktop can take as long as a mutation does.
      { timeoutMs: MUTATION_TIMEOUT_MS, mutation: !(pullRequestReadCommandTypes as readonly string[]).includes(command.type) }
    );
    if (!result.ok) {
      return { ok: false, errorCode: result.errorCode, message: result.message };
    }
    const structured = result.data as Record<string, unknown>;
    return { ok: true, data: structured.data as TResult };
  }

  private async callTool(
    name: string,
    args: Record<string, unknown>,
    options: { timeoutMs?: number; mutation?: boolean } = {}
  ): Promise<ApiResult<unknown>> {
    let response: Response;
    try {
      response = await fetchWithTimeout(
        `${this.baseUrl}${TAILNET_MCP_PATH}`,
        {
          method: "POST",
          headers: {
            "content-type": "application/json",
            authorization: `Bearer ${this.deviceToken}`,
          },
          body: JSON.stringify({
            jsonrpc: "2.0",
            id: `mob-${++this.requestCounter}`,
            method: "tools/call",
            params: { name, arguments: args },
          }),
        },
        options.timeoutMs ?? READ_TIMEOUT_MS
      );
    } catch {
      return {
        ok: false,
        errorCode: "desktop_unavailable",
        message: options.mutation
          ? // A timed-out mutation is not proven dead: the desktop may still
            // be executing it. Say so, or a retry manufactures a duplicate.
            "The desktop did not answer in time — the command may still have run. Check the board before retrying."
          : "The desktop's tailnet gateway is unreachable. Is Tailscale up on both devices?",
      };
    }

    const body = (await response.json().catch(() => null)) as Record<string, unknown> | null;
    if (response.status === 401) {
      // The gateway re-checks the device on every call: a plain 401 means this
      // device was revoked on the desktop, which is re-pair territory. One
      // about the tailnet node presenting the token is not (see below).
      return unauthorizedResult(body);
    }
    if (!response.ok || !body) {
      return { ok: false, errorCode: "desktop_unavailable", message: `The tailnet gateway returned ${response.status}.` };
    }
    if (isRecord(body.error)) {
      return {
        ok: false,
        errorCode: "invalid_payload",
        message: typeof body.error.message === "string" ? body.error.message : "The tailnet gateway refused the call.",
      };
    }
    const result = isRecord(body.result) ? body.result : null;
    const structured = result && isRecord(result.structuredContent) ? result.structuredContent : null;
    if (result?.isError === true) {
      const error = structured && isRecord(structured.error) ? structured.error : null;
      const code = typeof error?.code === "string" ? error.code : null;
      const message = typeof error?.message === "string" ? error.message : "The desktop refused the call.";
      if (code === "tailnet_scope_required") {
        // The device's grant is frozen at pair time: widening it means
        // pairing again.
        return { ok: false, errorCode: "unauthorized", message };
      }
      // Codes the app's vocabulary already knows (command_not_supported,
      // stale_snapshot, path_not_allowed, …) keep their identity; only a
      // genuinely foreign code flattens to invalid_payload.
      return { ok: false, errorCode: readApiErrorCode(code, "invalid_payload"), message };
    }
    if (!structured) {
      return { ok: false, errorCode: "invalid_payload", message: "The tailnet gateway returned no structured result." };
    }
    return { ok: true, data: structured };
  }
}

/**
 * What a 401 from the gateway means. A token the desktop no longer knows is
 * an unpairing. A token refused over the node presenting it is not: whois
 * failing for a moment is the desktop being briefly unable to answer, and a
 * token held to another node is a pairing to make again, with its own words.
 */
export function unauthorizedResult(body: unknown): ApiResult<never> {
  const refusal = readPeerRefusal(401, body);
  if (refusal?.code === "peer_unverified") return { ok: false, errorCode: "desktop_unavailable", message: refusal.message };
  if (refusal) return { ok: false, errorCode: "unauthenticated", message: refusal.message };
  return { ok: false, errorCode: "unauthenticated", message: "This device is no longer paired with the desktop." };
}

function fetchWithTimeout(url: string, init: RequestInit, timeoutMs: number = READ_TIMEOUT_MS): Promise<Response> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  return fetch(url, { ...init, signal: controller.signal }).finally(() => clearTimeout(timer));
}

function randomToken(): string {
  const bytes = new Uint8Array(18);
  const cryptoApi = globalThis.crypto;
  if (cryptoApi?.getRandomValues) {
    cryptoApi.getRandomValues(bytes);
  } else {
    for (let index = 0; index < bytes.length; index += 1) {
      bytes[index] = Math.floor(Math.random() * 256);
    }
  }
  return Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0")).join("");
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * The unchanged marker the desktop returns for a matched `knownSnapshotVersion`
 * (`{ unchanged: true, snapshotVersion }`). A real snapshot never carries
 * `unchanged`, so the flag is a safe discriminator. The marker's own
 * `snapshotVersion` wins; the version we asked with is the fallback for a
 * desktop that omits it.
 */
export function readUnchangedMarker(
  data: unknown,
  knownSnapshotVersion: string | undefined,
): { unchanged: true; snapshotVersion: string } | null {
  if (!isRecord(data) || data.unchanged !== true) {
    return null;
  }
  const snapshotVersion =
    typeof data.snapshotVersion === "string" ? data.snapshotVersion : knownSnapshotVersion;
  return snapshotVersion ? { unchanged: true, snapshotVersion } : null;
}

export function validateSnapshotResult(data: unknown): ApiResult<SnapshotRead> {
  const validation = validateMobileControlSnapshot(data);
  if (validation.ok === true) {
    return {
      ok: true,
      data: { unchanged: false, snapshot: validation.value },
    };
  }

  return {
    ok: false,
    errorCode: "invalid_payload",
    message: `Desktop returned an invalid mobile control snapshot: ${validation.error.message}`,
  };
}

/** A code the app's vocabulary knows keeps its identity; anything else becomes `fallback`. */
export function readApiErrorCode(input: unknown, fallback: ApiResult<never>["errorCode"]): ApiResult<never>["errorCode"] {
  return typeof input === "string" && knownApiErrorCodes.includes(input as MobileControlErrorCode)
    ? (input as MobileControlErrorCode)
    : fallback;
}
