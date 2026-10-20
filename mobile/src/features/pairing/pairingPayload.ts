export type PairingParseResult =
  | {
      ok: true;
      tailnet: TailnetPairingPayload;
    }
  | {
      ok: false;
      message: string;
    };

/**
 * The desktop's tailnet pairing link: `sprintengine-tailnet://pair?endpoint=…&token=…`
 * (minted by tailnet-service.ts, exactly two params). The endpoint is the
 * gateway's host:port on the tailnet; the token is the one-time pairing code
 * that POST /tailnet/v1/pair exchanges for a device token. There is no
 * challenge id and no expiry in the link — the desktop enforces the offer's TTL
 * server-side.
 *
 * It is the only way a phone pairs. The phone talks to a desktop over the
 * tailnet and nowhere else, so there is no code-only form to type: a pairing
 * without the endpoint would have nobody to go to.
 */
export interface TailnetPairingPayload {
  /** host:port as minted by the desktop (IPv6 hosts arrive bracketed). */
  endpoint: string;
  /** The gateway base URL the client will call: http://<endpoint>. */
  baseUrl: string;
  pairingToken: string;
}

const TAILNET_PAIRING_SCHEME = "sprintengine-tailnet:";

export function parsePairingPayload(payload: string): PairingParseResult {
  const normalizedPayload = payload.trim();

  if (!normalizedPayload) {
    return {
      ok: false,
      message: "Paste the pairing link from Sprint Engine Studio.",
    };
  }

  let url: URL;
  try {
    url = new URL(normalizedPayload);
  } catch {
    return { ok: false, message: NOT_A_PAIRING_LINK };
  }

  if (url.protocol !== TAILNET_PAIRING_SCHEME) {
    return { ok: false, message: NOT_A_PAIRING_LINK };
  }

  return parseTailnetUrlPayload(url);
}

const NOT_A_PAIRING_LINK =
  "That is not a Studio pairing link. Scan the square in Studio → Settings → Remote, or paste its sprintengine-tailnet:// link.";

/**
 * Is this URL the desktop handing us a pairing, as opposed to an auth callback,
 * a conversation link, or anything else that can reach a registered scheme?
 *
 * Deliberately a *recognition* test, not a validation one: it answers "was this
 * meant as a pairing link", and `parsePairingPayload` then answers "is it a good
 * one". Splitting the two is what lets a malformed link reach the pairing
 * screen and say so, instead of being dropped in silence and looking like the
 * OS lost it.
 *
 * `sprintengine-tailnet:` is a pairing link by scheme alone — the desktop mints
 * it for nothing else, and no other scheme carries a pairing.
 */
export function isPairingDeepLink(url: string): boolean {
  try {
    return new URL(url.trim()).protocol === TAILNET_PAIRING_SCHEME;
  } catch {
    return false;
  }
}

function parseTailnetUrlPayload(url: URL): PairingParseResult {
  const endpoint = readParam(url, "endpoint");
  const pairingToken = readParam(url, "token");
  if (!endpoint) {
    return { ok: false, message: "The tailnet pairing link is missing its endpoint." };
  }
  if (!pairingToken) {
    return { ok: false, message: "The tailnet pairing link is missing its pairing code." };
  }
  const baseUrl = tailnetEndpointBaseUrl(endpoint);
  if (!baseUrl) {
    return { ok: false, message: "The tailnet pairing link's endpoint is not a valid host and port." };
  }
  return { ok: true, tailnet: { endpoint, baseUrl, pairingToken } };
}

/**
 * The desktop gateway is plain HTTP on the tailnet — WireGuard is the
 * transport encryption, and the listener binds only to the Tailscale
 * interface. The endpoint is host:port exactly as the desktop minted it
 * (bracketed IPv6 included); anything beyond that — credentials, a path, a
 * query — is not a pairing endpoint and is refused.
 */
export function tailnetEndpointBaseUrl(endpoint: string): string | null {
  try {
    const url = new URL(`http://${endpoint}`);
    if (
      !url.hostname ||
      url.username ||
      url.password ||
      (url.pathname !== "/" && url.pathname !== "") ||
      url.search ||
      url.hash
    ) {
      return null;
    }
    return `http://${url.host}`;
  } catch {
    return null;
  }
}

function readParam(url: URL, key: string) {
  const value = url.searchParams.get(key);
  return value?.trim() ? value.trim() : undefined;
}
