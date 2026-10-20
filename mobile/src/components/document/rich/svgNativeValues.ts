// What react-native-svg's native side can read, value by value. A drawing's
// attributes reach Java and Objective-C as strings and numbers, and Android
// parses them where it draws: `Double.parseDouble` on a marker's `orient`,
// `Double.valueOf` on every length, its own path parser on `d`, an enum's
// `valueOf` on a text anchor. A value any of those refuses throws on the UI
// thread, and the app dies: no error boundary sees it. So the sanitiser
// (`svgSanitizer.ts`) keeps a value only in a form those parsers take,
// written as they read it, and drops the rest; a shape without its geometry
// is dropped whole.
//
// The forms are read off react-native-svg 15.15.3: `SVGLength.java` and
// `PropHelper.fromRelative` for lengths, `PathParser.java` for paths,
// `MarkerView.renderMarker` for `orient`, `FontData` and `TextProperties` for
// text, and its JS layer (`xml.tsx`, `lib/extract/*`, `transform.peg`), which
// turns every attribute that reads as a number into one first: a keyword
// attribute must never read as a number, or a string-typed native prop is
// handed a number.

// A number as Java's `Double.valueOf`, JS's `Number`, react-native-svg's
// transform grammar and its path parser all read it, and nothing else: no
// `Infinity`, no hex, no `1f`, no bare `.`.
const NUMBER = /^[+-]?(?:\d+(?:\.\d*)?|\.\d+)(?:[eE][+-]?\d+)?$/;

/** The number a string is, or null; finite even as a 32-bit float, as Android draws in floats. */
export function svgNumber(raw: string): number | null {
  const text = raw.trim();
  if (!NUMBER.test(text)) return null;
  const value = Number(text);
  return Number.isFinite(Math.fround(value)) ? value : null;
}

// `SVGLength` reads these units; `PropHelper.fromRelative`, which font sizes
// and spacing go through, does not read `ex`, so neither does this.
const LENGTH = /^(.*?)(%|px|em|pt|pc|mm|cm|in)?$/;

/** A length as `SVGLength` reads it: a number, with a unit or a percentage. */
export function svgLength(raw: string, options: { nonNegative?: boolean } = {}): string | null {
  const text = raw.trim();
  const [, number, unit = ""] = LENGTH.exec(text)!;
  const value = svgNumber(number);
  if (value === null || (options.nonNegative && value < 0)) return null;
  return `${number}${unit}`;
}

/** Lengths separated by spaces or commas, as `SVGLength.arrayFrom` and `extractLengthList` read them. */
export function svgLengthList(raw: string, options: { nonNegative?: boolean } = {}): string | null {
  const parts = raw.trim().split(/[\s,]+/);
  if (!parts[0]) return null;
  const lengths: string[] = [];
  for (const part of parts) {
    const length = svgLength(part, options);
    if (length === null) return null;
    lengths.push(length);
  }
  return lengths.join(" ");
}

/** Four numbers, a box with room in it; `extractViewBox` reads the rest as NaN. */
export function svgViewBox(raw: string): string | null {
  const parts = raw.trim().split(/[\s,]+/);
  if (parts.length !== 4) return null;
  const numbers = parts.map(svgNumber);
  if (numbers.some((value) => value === null) || numbers[2]! <= 0 || numbers[3]! <= 0) return null;
  return parts.join(" ");
}

const ALIGNS = /^(?:none|x(?:Min|Mid|Max)Y(?:Min|Mid|Max))(?:\s+(?:meet|slice))?$/;

export function svgPreserveAspectRatio(raw: string): string | null {
  const text = raw.trim().replace(/\s+/g, " ");
  return ALIGNS.test(text) ? text : null;
}

// ---- transform -------------------------------------------------------------

// `transform.peg`'s grammar, run here so a list it would refuse (and log
// as an error) never reaches it, and one whose matrix overflows a float is
// dropped too.
const TRANSFORM_ARITY: Record<string, number[]> = {
  matrix: [6],
  translate: [1, 2],
  scale: [1, 2],
  rotate: [1, 3],
  skewX: [1],
  skewY: [1],
};
const PEG_SPACE = /[ \t\r\n]/;
const PEG_NUMBER = /^[+-]?(?:(?:\d*\.\d+|\d+\.)(?:[eE][+-]?\d+)?|\d+[eE][+-]?\d+|\d+)/;

type Matrix = [number, number, number, number, number, number];

function transformMatrix(name: string, args: number[]): Matrix {
  const rad = Math.PI / 180;
  switch (name) {
    case "matrix":
      return [args[0], args[2], args[4], args[1], args[3], args[5]];
    case "translate":
      return [1, 0, args[0], 0, 1, args[1] ?? 0];
    case "scale":
      return [args[0], 0, 0, 0, args[1] ?? args[0], 0];
    case "rotate": {
      const cos = Math.cos(rad * args[0]);
      const sin = Math.sin(rad * args[0]);
      if (args.length === 1) return [cos, -sin, 0, sin, cos, 0];
      const [, x, y] = args;
      return [cos, -sin, cos * -x + -sin * -y + x, sin, cos, sin * -x + cos * -y + y];
    }
    case "skewX":
      return [1, Math.tan(rad * args[0]), 0, 0, 1, 0];
    default:
      return [1, 0, 0, Math.tan(rad * args[0]), 1, 0];
  }
}

function multiply(l: Matrix, r: Matrix): Matrix {
  return [
    l[0] * r[0] + l[1] * r[3],
    l[0] * r[1] + l[1] * r[4],
    l[0] * r[2] + l[1] * r[5] + l[2],
    l[3] * r[0] + l[4] * r[3],
    l[3] * r[1] + l[4] * r[4],
    l[3] * r[2] + l[4] * r[5] + l[5],
  ];
}

/** A transform list react-native-svg's grammar reads to a finite matrix, as written; null for any other. */
export function svgTransform(raw: string): string | null {
  const source = raw;
  let index = 0;
  const spaces = () => {
    while (index < source.length && PEG_SPACE.test(source[index])) index += 1;
  };
  // `commaWsp`: (wsp+ comma? wsp*) / (comma wsp*). Returns whether one was there.
  const commaWsp = () => {
    const start = index;
    spaces();
    if (source[index] === ",") index += 1;
    spaces();
    return index > start;
  };
  const number = () => {
    const match = PEG_NUMBER.exec(source.slice(index));
    if (!match) return null;
    index += match[0].length;
    const value = Number(match[0]);
    return Number.isFinite(value) ? value : null;
  };
  let matrix: Matrix = [1, 0, 0, 0, 1, 0];
  spaces();
  while (index < source.length) {
    const name = /^(?:matrix|translate|scale|rotate|skewX|skewY)/.exec(source.slice(index))?.[0];
    if (!name) return null;
    index += name.length;
    spaces();
    if (source[index] !== "(") return null;
    index += 1;
    spaces();
    const args: number[] = [];
    for (;;) {
      const before = index;
      if (args.length && !commaWsp()) break;
      const value = number();
      if (value === null) {
        if (!args.length) return null;
        // A separator with no number after it is not one.
        index = before;
        break;
      }
      args.push(value);
    }
    spaces();
    if (source[index] !== ")" || !TRANSFORM_ARITY[name].includes(args.length)) return null;
    index += 1;
    matrix = multiply(matrix, transformMatrix(name, args));
    // Between transforms, any run of separators, or none; after the last, spaces only.
    while (index < source.length && (PEG_SPACE.test(source[index]) || source[index] === ",")) index += 1;
    if (index >= source.length && /,[ \t\r\n]*$/.test(source)) return null;
  }
  if (!matrix.every((value) => Number.isFinite(Math.fround(value)))) return null;
  const text = source.trim();
  return text || null;
}

// ---- path data -------------------------------------------------------------

// `PathParser.java`, which throws on anything it cannot read, followed step
// by step: where it would throw, this says no. Its whitespace is Java's
// `Character.isWhitespace`; only the ASCII part of that is taken here, so a
// path spaced with anything else is refused rather than guessed at.
const PATH_SPACE = /[ \t\n\v\f\r\u001c-\u001f]/;
const PATH_ARGS: Record<string, string> = {
  m: "nn",
  l: "nn",
  h: "n",
  v: "n",
  c: "nnnnnn",
  s: "nnnn",
  q: "nnnn",
  t: "nn",
  a: "nnnffnn",
  z: "",
};

class PathRefusal extends Error {}

/** Whether react-native-svg's Android path parser reads `d` without throwing. */
export function svgPathReads(d: string): boolean {
  const s = d;
  const l = s.length;
  let i = 0;
  const charAt = (at: number) => {
    if (at >= l) throw new PathRefusal();
    return s[at];
  };
  const skipSpaces = () => {
    while (i < l && PATH_SPACE.test(s[i])) i += 1;
  };
  const isDigit = (c: string) => c >= "0" && c <= "9";
  const skipDigits = () => {
    while (i < l && isDigit(s[i])) i += 1;
  };
  const parseNumber = () => {
    skipSpaces();
    if (i === l) throw new PathRefusal();
    const start = i;
    let c = charAt(i);
    if (c === "-" || c === "+") {
      i += 1;
      c = charAt(i);
    }
    if (isDigit(c)) {
      skipDigits();
      if (i < l) c = s[i];
    } else if (c !== ".") throw new PathRefusal();
    if (c === ".") {
      i += 1;
      skipDigits();
      if (i < l) c = s[i];
    }
    if ((c === "e" || c === "E") && i + 1 < l) {
      const next = s[i + 1];
      if (next !== "m" && next !== "x") {
        i += 1;
        c = charAt(i);
        if (c === "+" || c === "-") {
          i += 1;
          skipDigits();
        } else if (isDigit(c)) skipDigits();
        else throw new PathRefusal();
      }
    }
    // `Float.parseFloat`, then refused when infinite or NaN.
    if (svgNumber(s.slice(start, i)) === null) throw new PathRefusal();
  };
  const listNumber = () => {
    if (i === l) throw new PathRefusal();
    parseNumber();
    skipSpaces();
    if (i < l && s[i] === ",") i += 1;
  };
  const flag = () => {
    skipSpaces();
    const c = charAt(i);
    if (c !== "0" && c !== "1") throw new PathRefusal();
    i += 1;
    if (i < l && s[i] === ",") i += 1;
    skipSpaces();
  };
  try {
    let previous = " ";
    while (i < l) {
      skipSpaces();
      if (i >= l) break;
      const first = s[i];
      if (previous === " " && first !== "M" && first !== "m") throw new PathRefusal();
      let command: string;
      let implicitMoveTo = false;
      if (PATH_ARGS[first.toLowerCase()] !== undefined) {
        command = first;
        i += 1;
      } else if (/[0-9.+-]/.test(first) && previous !== " ") {
        if (previous === "Z" || previous === "z") throw new PathRefusal();
        if (previous === "M" || previous === "m") {
          implicitMoveTo = true;
          command = previous === "M" ? "L" : "l";
        } else command = previous;
      } else throw new PathRefusal();
      for (const argument of PATH_ARGS[command.toLowerCase()]) {
        if (argument === "f") flag();
        else listNumber();
      }
      previous = implicitMoveTo ? (command === "L" ? "M" : "m") : command;
    }
    return true;
  } catch (error) {
    if (error instanceof PathRefusal) return false;
    throw error;
  }
}

/**
 * A `points` list as react-native-svg will draw it, or null. It becomes the
 * path `M<points>` (`z` closing a polygon) after `extractPolyPoints`, whose
 * first `[^eE]-` is replaced with ` -`, eating the character before the sign:
 * written here with a separator before every number, that character is
 * always a separator.
 */
export function svgPoints(raw: string, closed: boolean): string | null {
  const parts = raw.trim().split(/[\s,]+/);
  if (parts.length < 2 || parts.length % 2 || parts.some((part) => svgNumber(part) === null)) return null;
  const pairs: string[] = [];
  for (let index = 0; index < parts.length; index += 2) pairs.push(`${parts[index]},${parts[index + 1]}`);
  const points = pairs.join(" ");
  const drawn = points.replace(/[^eE]-/, " -").split(/(?:\s+|\s*,\s*)/g).join(" ");
  return svgPathReads(`M${drawn}${closed ? "z" : ""}`) ? points : null;
}

// ---- markers ---------------------------------------------------------------

/**
 * A marker's `orient` as react-native-svg draws it the way SVG does. Its
 * `MarkerView` reads `"auto"` and otherwise `Double.parseDouble`, so
 * `auto-start-reverse` (every Mermaid sequence diagram's arrowheads) threw;
 * the sanitiser draws that as `auto` and gives its start uses a reversed
 * copy. And it turns a fixed angle by 180° more than it says
 * (`180 + angle`, a correction its `auto` needs and an angle does not), so a
 * fixed angle is written 180° less; an absent one is SVG's 0.
 */
export function svgMarkerOrient(raw: string | undefined): { orient: string; reverseAtStart: boolean } {
  const text = raw?.trim() ?? "0";
  if (text === "auto") return { orient: "auto", reverseAtStart: false };
  if (text === "auto-start-reverse") return { orient: "auto", reverseAtStart: true };
  const degrees = svgNumber(text.replace(/deg$/, ""));
  const angle = degrees === null ? 0 : degrees;
  return { orient: String((((angle - 180) % 360) + 360) % 360), reverseAtStart: false };
}

// ---- keywords --------------------------------------------------------------

/** Keyword attributes, each to the words react-native-svg reads for it; any other word throws or is ignored. */
export const SVG_KEYWORDS: Record<string, readonly string[]> = {
  markerUnits: ["strokeWidth", "userSpaceOnUse"],
  clipPathUnits: ["userSpaceOnUse", "objectBoundingBox"],
  gradientUnits: ["userSpaceOnUse", "objectBoundingBox"],
  spreadMethod: ["pad", "reflect", "repeat"],
  visibility: ["visible", "hidden", "collapse"],
  "fill-rule": ["nonzero", "evenodd"],
  "clip-rule": ["nonzero", "evenodd"],
  "stroke-linecap": ["butt", "round", "square"],
  "stroke-linejoin": ["miter", "round", "bevel"],
  // `FontStyle.valueOf`, `TextAnchor.valueOf` and `AlignmentBaseline.getEnum` throw on any other.
  "font-style": ["normal", "italic", "oblique"],
  "text-anchor": ["start", "middle", "end"],
  "alignment-baseline": [
    "baseline",
    "text-bottom",
    "alphabetic",
    "ideographic",
    "middle",
    "central",
    "mathematical",
    "text-top",
    "bottom",
    "center",
    "top",
    "text-before-edge",
    "text-after-edge",
    "before-edge",
    "after-edge",
    "hanging",
  ],
};

const FONT_WEIGHTS = new Set(["normal", "bold", "bolder", "lighter"]);

/** `FontData` reads a weight's keyword, or `Double.parseDouble` on anything else. */
export function svgFontWeight(raw: string): string | null {
  const text = raw.trim();
  if (FONT_WEIGHTS.has(text)) return text;
  return svgNumber(text) === null ? null : text;
}

/**
 * Text that must stay text: react-native-svg's XML reader turns an attribute
 * that reads as a number into one, and `extractFont` splits a family as a
 * string.
 */
export function svgWord(raw: string): string | null {
  const text = raw.trim();
  return text && Number.isNaN(Number(text)) ? text : null;
}
