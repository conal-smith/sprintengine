import type { MobileControlSnapshot, MobileControlWebTargetSnapshot } from "../../shared/mobile-control/protocol";

/**
 * Dev servers a paired desktop publishes on the tailnet, as this phone may open
 * them.
 *
 * The URL in a snapshot is a string a DESKTOP put on the wire. It is opened by
 * handing it to the operating system, so it is treated as untrusted input and
 * admitted only when it is unmistakably a tailnet origin:
 *
 *  - `https:` only. Serve terminates real TLS for the `.ts.net` name; a
 *    cleartext URL is either not a serve URL or not one worth opening, and on
 *    iOS it would hit ATS anyway.
 *  - host ends in `.ts.net`. That is the MagicDNS suffix, and it is the whole
 *    of what makes this URL reachable-but-private. Anything else — a public
 *    host, a raw IP, a `javascript:` payload wearing an https coat — is not a
 *    tailnet share and is not opened.
 *  - no credentials in the URL. `https://user:pass@host.ts.net` would hand
 *    whatever they are to the browser; a share never needs them.
 *
 * A refused target is dropped from the list rather than shown greyed out: there
 * is nothing a person can do about a malformed URL on another machine, and a
 * row that cannot be tapped is worse than no row.
 */

const TAILNET_SUFFIX = ".ts.net";

export function isOpenableTailnetUrl(value: string): boolean {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    return false;
  }
  if (url.protocol !== "https:") return false;
  if (url.username !== "" || url.password !== "") return false;
  const host = url.hostname.toLowerCase();
  // `endsWith` alone would admit `evil-ts.net`; the dot is what makes it a
  // suffix of the MagicDNS namespace rather than a lookalike registration.
  return host.endsWith(TAILNET_SUFFIX) && host.length > TAILNET_SUFFIX.length;
}

export type WebTarget = {
  id: string;
  label: string;
  url: string;
  localPort: number;
  machine: string;
};

function isUsable(target: MobileControlWebTargetSnapshot | undefined | null): target is MobileControlWebTargetSnapshot {
  return (
    !!target
    && typeof target.id === "string"
    && target.id.length > 0
    && typeof target.url === "string"
    && isOpenableTailnetUrl(target.url)
    && typeof target.machine === "string"
    && typeof target.localPort === "number"
  );
}

/**
 * The snapshot's web targets, filtered and ordered for the screen.
 *
 * Ordered by machine, then by local port, so the list is stable across polls —
 * a list that reorders under a thumb is a list that gets mis-tapped.
 */
export function readWebTargets(snapshot: MobileControlSnapshot | null): WebTarget[] {
  const raw = snapshot?.webTargets;
  if (!Array.isArray(raw)) return [];
  const seen = new Set<string>();
  const targets: WebTarget[] = [];
  for (const entry of raw) {
    if (!isUsable(entry)) continue;
    if (seen.has(entry.id)) continue;
    seen.add(entry.id);
    targets.push({
      id: entry.id,
      label: typeof entry.label === "string" && entry.label.length > 0 ? entry.label : `localhost:${entry.localPort}`,
      url: entry.url,
      localPort: entry.localPort,
      machine: entry.machine,
    });
  }
  targets.sort((left, right) => left.machine.localeCompare(right.machine) || left.localPort - right.localPort);
  return targets;
}

/** The machine name without its tailnet suffix — what a person calls the desktop. */
export function shortMachineName(machine: string): string {
  const first = machine.split(".")[0];
  return first && first.length > 0 ? first : machine;
}
