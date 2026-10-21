import { createContext, useContext, type ReactNode } from "react";

export interface PairingLinkValue {
  /**
   * A pairing link the OS just handed us. Raw rather than parsed on purpose: the
   * pairing screen already parses its own input, so a malformed link arrives
   * there and gets the error copy that field owns, instead of being judged
   * twice.
   *
   * Held until the pairing screen is *done* with it — connected or cancelled —
   * not until it mounts. A cold start reads the stored sessions asynchronously,
   * so the root flips from gate to tabs a few frames in and tears down whichever
   * stack the link was delivered into; surviving that flip is the whole reason
   * this outlives the mount.
   *
   * `sequence` is the delivery identity, because the URL is not: tapping the
   * same link twice must seed the field twice, and two identical strings are one
   * value to React.
   *
   * It never pairs on its own. The link removes the typing, not the consent —
   * any app or web page can fire a URL at the phone, so the confirmation sheet
   * stays on the path.
   */
  pendingPairingLink: { url: string; sequence: number } | null;
  clearPendingPairingLink: () => void;
}

const PairingLinkContext = createContext<PairingLinkValue | null>(null);

/**
 * The pairing link the OS delivered. The pairing screen is reachable from two
 * different stacks and the link arrives from outside both, so it travels by
 * context rather than through the navigators.
 */
export function PairingLinkProvider({ value, children }: { value: PairingLinkValue; children: ReactNode }) {
  return <PairingLinkContext.Provider value={value}>{children}</PairingLinkContext.Provider>;
}

export function usePairingLink(): PairingLinkValue {
  const value = useContext(PairingLinkContext);
  if (!value) {
    throw new Error("usePairingLink must be called inside a PairingLinkProvider.");
  }
  return value;
}
