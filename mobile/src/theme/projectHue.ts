/**
 * A project's hue, as a colour this app can paint.
 *
 * The DEGREE is not computed here. The desktop hashes it — one function, in
 * multicode's `shared/project-hue.ts` — and sends it on every `workspace.list`
 * row, precisely so the phone and the studio cannot disagree about which
 * degree a project is. Re-implementing the hash here would reintroduce the
 * "multicode is blue on one machine and teal on the next" bug the desktop's
 * 2026-09-11 decision exists to kill, one repo over.
 *
 * What IS this file's job is the part the wire cannot carry: turning that angle
 * into an `rgb()` string at the same lightness and chroma the studio paints it
 * at. The desktop says `oklch(L C H)` in CSS and lets the browser resolve it;
 * React Native has no OKLCH, so the conversion is written out — OKLCH → OKLab →
 * LMS → linear sRGB → gamma-encoded sRGB, the standard pipeline.
 *
 * L and C are per-MODE, mirroring `--sem-color-mark-project-lightness` and
 * `-chroma` in design-system/foundations/tokens.css. Both values are duplicated
 * from that file rather than derived, because there is no token pipeline
 * between the two repos; a change there is a change here, and the regression
 * test pins the four numbers so the copy cannot rot silently.
 */

/** `:root` in design-system/foundations/tokens.css. */
const LIGHT = { lightness: 0.54, chroma: 0.09 } as const;
/** `[data-mode="dark"]` in the same file. */
const DARK = { lightness: 0.74, chroma: 0.125 } as const;

/** A hue is a whole degree on the OKLCH wheel, 0 to 359, as the desktop sends it. */
export function isProjectHue(value: unknown): value is number {
  return typeof value === "number" && Number.isInteger(value) && value >= 0 && value < 360;
}

function gammaEncode(channel: number): number {
  const c = channel <= 0.0031308 ? 12.92 * channel : 1.055 * Math.pow(channel, 1 / 2.4) - 0.055;
  return Math.max(0, Math.min(255, Math.round(c * 255)));
}

/**
 * One OKLCH triple as `rgb(r, g, b)`.
 *
 * Out-of-gamut hues are clamped per channel rather than gamut-mapped. At these
 * lightness/chroma pairs the wheel is very nearly inside sRGB, so the clamp
 * moves a handful of degrees by a value or two — visible to a colorimeter and
 * to nobody holding a phone. A real gamut mapper would be a lot of arithmetic
 * to move those same degrees somewhere else.
 */
function oklchToRgb(lightness: number, chroma: number, hueDegrees: number): string {
  const hueRadians = (hueDegrees * Math.PI) / 180;
  const a = chroma * Math.cos(hueRadians);
  const b = chroma * Math.sin(hueRadians);

  const lRoot = lightness + 0.3963377774 * a + 0.2158037573 * b;
  const mRoot = lightness - 0.1055613458 * a - 0.0638541728 * b;
  const sRoot = lightness - 0.0894841775 * a - 1.291485548 * b;

  const l = lRoot * lRoot * lRoot;
  const m = mRoot * mRoot * mRoot;
  const s = sRoot * sRoot * sRoot;

  const red = 4.0767416621 * l - 3.3077115913 * m + 0.2309699292 * s;
  const green = -1.2684380046 * l + 2.6097574011 * m - 0.3413193965 * s;
  const blue = -0.0041960863 * l - 0.7034186147 * m + 1.707614701 * s;

  return `rgb(${gammaEncode(red)}, ${gammaEncode(green)}, ${gammaEncode(blue)})`;
}

/**
 * The ink a project's mark wears, or null when the row has no project.
 *
 * Null is the answer for a chat with no folder — it is not a project, and the
 * glyph stays in its ordinary muted ink rather than being given a colour that
 * would imply one.
 */
export function projectHueColor(hue: number | null | undefined, mode: "light" | "dark"): string | null {
  if (!isProjectHue(hue)) return null;
  const { lightness, chroma } = mode === "dark" ? DARK : LIGHT;
  return oklchToRgb(lightness, chroma, hue);
}
