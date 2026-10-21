// A machine's mark: the kind of device it is drawn as, in its colour. The desktop's machine identity, ported for the phone.
//
// The phone draws a mark and never decides one. The desktop owns the defaults
// (a kind from what the machine is, a colour hashed from its stable id) and the
// person's overrides from Settings › Machines, and it sends the result: a
// chat's `host` on the conversation list, and the paired desktop's own
// `machine` on `/tailnet/v1/identity`. Hashing a colour here as well would
// disagree with the desktop the first time someone picked one, so a machine
// the desktop says nothing about simply wears no mark.
//
// Pure data and readers, no react-native, so `node --test` pins the same rules
// `MachineGlyph` renders from.

import type { ThemeColors } from "../../theme/tokens";

/**
 * The kinds a machine is drawn as, in the desktop's order. Phones and tablets
 * are not here: Studio never runs on one.
 */
export const MACHINE_KINDS = [
  "laptop",
  "desktop",
  "mini",
  "tower",
  "server",
  "cloud",
  "container",
  "board",
  "wsl",
] as const;
export type MachineKind = (typeof MACHINE_KINDS)[number];

/** What each kind is called where a surface spells it out. */
export const MACHINE_KIND_LABELS: Record<MachineKind, string> = {
  laptop: "Laptop",
  desktop: "Desktop",
  mini: "Mini",
  tower: "Tower",
  server: "Server",
  cloud: "Cloud VM",
  container: "Container",
  board: "Board",
  wsl: "WSL",
};

/**
 * The colours a machine can wear: the seven mark hues, then a neutral. The
 * order is the desktop's, where it is the hash's; the phone only reads names.
 */
export const MACHINE_COLOURS = ["blue", "teal", "cyan", "orange", "yellow", "violet", "red", "neutral"] as const;
export type MachineColour = (typeof MACHINE_COLOURS)[number];

/**
 * The theme token each colour inks a glyph with. The seven hues are the
 * desktop's `--sem-color-mark-*`; the neutral is muted text, as it is there.
 */
export const MACHINE_COLOUR_TOKEN: Record<MachineColour, keyof ThemeColors> = {
  blue: "markBlue",
  teal: "markTeal",
  cyan: "markCyan",
  orange: "markOrange",
  yellow: "markYellow",
  violet: "markViolet",
  red: "markRed",
  neutral: "textMuted",
};

/** One piece of a drawing on the 16 grid: a rounded rectangle, a circle, or a path. */
export type MachineDrawingPart =
  | { rect: { x: number; y: number; width: number; height: number; rx: number } }
  | { path: string };

/**
 * Each kind's drawing, coordinate for coordinate from the desktop's
 * `design-system/glyphs/` (device-laptop, device-desktop, machine-mini,
 * machine-tower, machine-server, machine-cloud, machine-container,
 * machine-board, wsl-machine). Stroke 1.4, round caps and joins, no fill.
 */
export const MACHINE_KIND_DRAWINGS: Record<MachineKind, readonly MachineDrawingPart[]> = {
  laptop: [{ rect: { x: 3, y: 2.8, width: 10, height: 7.4, rx: 1.3 } }, { path: "M1.8 12.2h12.4" }],
  desktop: [{ rect: { x: 2, y: 2.6, width: 12, height: 8.4, rx: 1.4 } }, { path: "M8 11v2.4M5.4 13.4h5.2" }],
  mini: [
    { rect: { x: 2, y: 7.4, width: 12, height: 4.6, rx: 1.3 } },
    { path: "M3.3 7.4 4.5 4.6h7l1.2 2.8M4.6 9.7h1.6" },
  ],
  tower: [{ rect: { x: 4.4, y: 1.8, width: 7.2, height: 12.4, rx: 1.3 } }, { path: "M6.6 4.6h2.8M6.6 6.8h2.8" }],
  server: [
    { rect: { x: 2, y: 2.2, width: 12, height: 11.6, rx: 1.4 } },
    { path: "M2 6.07h12M2 9.93h12M4.4 4.13h1.6M4.4 8h1.6M4.4 11.87h1.6" },
  ],
  cloud: [{ path: "M4.4 12.2A2.6 2.6 0 0 1 4.9 7.1A3.4 3.4 0 0 1 11.3 6.7A2.8 2.8 0 0 1 11.6 12.2Z" }],
  container: [{ path: "M8 1.9 13.4 5v6L8 14.1 2.6 11V5ZM2.6 5 8 8.1 13.4 5M8 8.1v6" }],
  board: [
    { rect: { x: 2, y: 3, width: 12, height: 10, rx: 1.2 } },
    { rect: { x: 4.2, y: 5.6, width: 4.6, height: 4.8, rx: 0.6 } },
    { path: "M10.9 6.4h1.2M10.9 9.6h1.2" },
  ],
  wsl: [
    { rect: { x: 2, y: 2.4, width: 12, height: 11.2, rx: 1.4 } },
    { path: "M2 5.4h12M4.8 7.8l1.8 1.6-1.8 1.6M8.4 11h2.8" },
  ],
};

/**
 * The Beam: a screen reached over the air. The generic "another machine" mark,
 * for a paired desktop that has not said what it is. Desktop `remote-machine.svg`.
 */
export const REMOTE_MACHINE_DRAWING: readonly MachineDrawingPart[] = [
  { path: "M1.8 6.6h7.4v5.2H1.8ZM5.5 11.8v1.8M3.6 13.6h3.8M10.6 3.2a2.2 2.2 0 0 1 2.2 2.2M10.6 1.4a4 4 0 0 1 4 4" },
];

/** A machine as a surface draws it: the kind, the colour, and what it is called. */
export interface MachineMark {
  kind: MachineKind;
  colour: MachineColour;
}

/**
 * The kind the desktop sent, or `desktop` for one this build does not know: a
 * desktop that has learned a tenth kind still marks the machine, just with the
 * plainest drawing, rather than leaving the slot empty.
 */
export function readMachineKind(value: unknown): MachineKind {
  const kind = typeof value === "string" ? value.trim().toLowerCase() : "";
  return (MACHINE_KINDS as readonly string[]).includes(kind) ? (kind as MachineKind) : "desktop";
}

/**
 * The colour the desktop sent, or the neutral for one this build does not know.
 * Never a hue of the phone's own choosing: a guessed hue would contradict the
 * desktop's the moment the two disagreed.
 */
export function readMachineColour(value: unknown): MachineColour {
  const colour = typeof value === "string" ? value.trim().toLowerCase() : "";
  return (MACHINE_COLOURS as readonly string[]).includes(colour) ? (colour as MachineColour) : "neutral";
}

/**
 * `{ kind, color }` as the desktop sends it (the identity's `machine`, a chat
 * `host`'s two fields), read fail-soft. Null only when it is not an object at
 * all: a desktop that sent one meant the machine to wear a mark.
 */
export function readMachineMark(value: unknown): MachineMark | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const raw = value as Record<string, unknown>;
  return { kind: readMachineKind(raw.kind), colour: readMachineColour(raw.color) };
}

/** The theme ink a mark's colour resolves to. */
export function machineMarkInk(colours: ThemeColors, colour: MachineColour): string {
  return colours[MACHINE_COLOUR_TOKEN[colour]];
}
