// The last word on what a diagram or a formula may draw. The renderer page
// (`renderer/rendererMain.js`) draws from an agent's text, and a reply can be
// prompt-injected, so whatever the page posts back is treated as hostile: it
// is parsed here, outside the WebView, and rebuilt from an allow-list before
// react-native-svg ever sees it.
//
// What survives is shapes, text, markers, clip paths and gradients, with
// geometry and paint. What never does: anything that links, loads or runs
// (`a` is unwrapped, `script`, `image`, `img`, `foreignObject`, `use`,
// `style`, filters and animation go with everything inside them), any
// `href`, `xlink:href`, `src` or `srcset`, event handlers, and any value that
// reaches outside the drawing. A `url()` may name only an element of the
// drawing itself (`url(#arrowhead)`); any other `url()`, an `image-set()`
// or an `@import`, in any attribute, is dropped with the attribute, CSS
// escapes (`\75 rl(`) read first. A `style` attribute is read for the
// presentation properties it sets, which are written as attributes, and
// nothing else of it is kept. Comments, doctypes and their entities,
// processing instructions are dropped; only XML's own entities are read.
//
// And what survives is in a form react-native-svg's native side reads: it
// parses a drawing's values on the UI thread and throws on one it cannot
// read, which no error boundary catches (`svgNativeValues.ts`). A value it
// cannot read is dropped, and a path or polygon whose geometry is unreadable
// is dropped whole. Markers go inside a `defs`, since it draws one anywhere
// else where it stands, and a marker's `orient` is written as it reads it:
// `auto-start-reverse` is `auto`, and its start uses get a copy of the
// marker turned to face back.
//
// No DOM: a tokenizer and a stack, so it runs on Hermes and under Node alike.

import {
  SVG_KEYWORDS,
  svgFontWeight,
  svgLength,
  svgLengthList,
  svgMarkerOrient,
  svgNumber,
  svgPathReads,
  svgPoints,
  svgPreserveAspectRatio,
  svgTransform,
  svgViewBox,
  svgWord,
} from "./svgNativeValues";

export type SanitizedSvg = { svg: string; width: number; height: number };

/** Inputs past these are refused whole rather than trimmed. */
export const SVG_LIMITS = { bytes: 2_000_000, elements: 30_000, depth: 96 };

// Element names, lowercased, to the spelling SVG wants.
const KEPT = new Map(
  [
    "svg",
    "g",
    "defs",
    "path",
    "rect",
    "circle",
    "ellipse",
    "line",
    "polyline",
    "polygon",
    "text",
    "tspan",
    "marker",
    "clipPath",
    "linearGradient",
    "radialGradient",
    "stop",
  ].map((name) => [name.toLowerCase(), name]),
);
// Kept for what they hold, dropped themselves: a link around a node leaves
// the node.
const UNWRAPPED = new Set(["a", "switch"]);

// Attribute names, lowercased, to the spelling SVG wants.
const ATTRIBUTES = new Map(
  [
    "id",
    "x",
    "y",
    "x1",
    "y1",
    "x2",
    "y2",
    "cx",
    "cy",
    "r",
    "rx",
    "ry",
    "fx",
    "fy",
    "dx",
    "dy",
    "width",
    "height",
    "d",
    "points",
    "transform",
    "viewBox",
    "preserveAspectRatio",
    "xmlns",
    "version",
    "refX",
    "refY",
    "markerWidth",
    "markerHeight",
    "markerUnits",
    "orient",
    "clipPathUnits",
    "gradientUnits",
    "gradientTransform",
    "spreadMethod",
    "offset",
    "opacity",
    "visibility",
    "display",
    ...presentationProperties(),
  ].map((name) => [name.toLowerCase(), name]),
);

function presentationProperties(): string[] {
  return [
    "fill",
    "fill-opacity",
    "fill-rule",
    "stroke",
    "stroke-width",
    "stroke-opacity",
    "stroke-dasharray",
    "stroke-dashoffset",
    "stroke-linecap",
    "stroke-linejoin",
    "stroke-miterlimit",
    "clip-path",
    "clip-rule",
    "marker-start",
    "marker-mid",
    "marker-end",
    "stop-color",
    "stop-opacity",
    "font-family",
    "font-size",
    "font-weight",
    "font-style",
    "text-anchor",
    "letter-spacing",
    "dominant-baseline",
    "alignment-baseline",
  ];
}
const STYLE_PROPERTIES = new Set([...presentationProperties(), "opacity", "visibility", "display"]);

// XML's own five, and character references. Anything else stays as written.
const ENTITIES: Record<string, string> = { lt: "<", gt: ">", amp: "&", quot: '"', apos: "'" };
function decodeEntities(text: string): string {
  return text.replace(/&(#x[0-9a-f]{1,6}|#[0-9]{1,7}|[a-z]+);/gi, (match, body: string) => {
    if (body[0] !== "#") return ENTITIES[body] ?? match;
    const point = body[1] === "x" || body[1] === "X" ? Number.parseInt(body.slice(2), 16) : Number.parseInt(body.slice(1), 10);
    return point > 0 && point <= 0x10ffff && !(point >= 0xd800 && point <= 0xdfff) ? String.fromCodePoint(point) : "";
  });
}

// CSS reads `\75 rl(` and `u\rl(` as `url(`, so values are judged with their
// escapes decoded, as the desktop judges a diagram's CSS.
function decodeCssEscapes(text: string): string {
  if (!text.includes("\\")) return text;
  return text.replace(/\\(?:([0-9a-f]{1,6})[ \t\n\r\f]?|(.))/gis, (_match, hex: string | undefined, char: string) => {
    if (!hex) return char;
    const point = Number.parseInt(hex, 16);
    return point && point <= 0x10ffff ? String.fromCodePoint(point) : "�";
  });
}

const LOCAL_URL = /^url\(\s*(['"]?)\s*#([A-Za-z0-9_.:-]+)\s*\1\s*\)$/;

/**
 * A value as it may be kept, or null when it reaches outside the drawing:
 * any `url()` but one naming an element by id, `image-set()`, `@import`,
 * `expression()`, a script or data URL. Control characters go.
 */
export function safeSvgValue(raw: string): string | null {
  // Control characters (C0 but tab, line feed and carriage return; DEL) go.
  const value = raw.replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g, "");
  const css = decodeCssEscapes(value).replace(/\/\*[\s\S]*?\*\//g, "");
  if (/@import|image-set\s*\(|expression\s*\(|javascript:|vbscript:|data:/i.test(css)) return null;
  const urls = css.match(/url\s*\([^)]*\)?/gi);
  if (urls) {
    for (const url of urls) if (!LOCAL_URL.test(url.replace(/\s+\(/, "("))) return null;
    // Only a whole local reference is kept; it is written back unescaped.
    const whole = LOCAL_URL.exec(css.trim());
    return whole ? `url(#${whole[2]})` : null;
  }
  return value;
}

const escapeAttribute = (text: string) => text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/"/g, "&quot;");
const escapeText = (text: string) => text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");

type Tag = { name: string; attributes: [string, string][]; selfClosing: boolean; end: number };

/** The tag starting at `start` (just past `<`), quoted values skipped; null when it never closes. */
function readTag(source: string, start: number): Tag | null {
  let index = start;
  const nameMatch = /^[A-Za-z_][\w:.-]*/.exec(source.slice(index, index + 256));
  if (!nameMatch) return null;
  const name = nameMatch[0];
  index += name.length;
  const attributes: [string, string][] = [];
  for (;;) {
    while (index < source.length && /\s/.test(source[index])) index += 1;
    if (index >= source.length) return null;
    if (source[index] === ">") return { name, attributes, selfClosing: false, end: index + 1 };
    if (source.startsWith("/>", index)) return { name, attributes, selfClosing: true, end: index + 2 };
    const attributeMatch = /^[^\s=/>"']+/.exec(source.slice(index, index + 256));
    if (!attributeMatch) {
      index += 1;
      continue;
    }
    const attribute = attributeMatch[0];
    index += attribute.length;
    while (index < source.length && /\s/.test(source[index])) index += 1;
    let value = "";
    if (source[index] === "=") {
      index += 1;
      while (index < source.length && /\s/.test(source[index])) index += 1;
      const quote = source[index];
      if (quote === '"' || quote === "'") {
        const close = source.indexOf(quote, index + 1);
        if (close === -1) return null;
        value = source.slice(index + 1, close);
        index = close + 1;
      } else {
        const bare = /^[^\s>]*/.exec(source.slice(index))![0];
        value = bare.endsWith("/") && source[index + bare.length] === ">" ? bare.slice(0, -1) : bare;
        index += value.length;
      }
    }
    attributes.push([attribute, decodeEntities(value)]);
  }
}

/** A `style` attribute's declarations that are presentation properties, safe ones only. */
function styleDeclarations(style: string): [string, string][] {
  const out: [string, string][] = [];
  for (const declaration of decodeCssEscapes(style).split(";")) {
    const colon = declaration.indexOf(":");
    if (colon === -1) continue;
    const property = declaration.slice(0, colon).trim().toLowerCase();
    const value = declaration.slice(colon + 1).replace(/!important/i, "").trim();
    if (!STYLE_PROPERTIES.has(property) || !value) continue;
    const safe = safeSvgValue(value);
    if (safe !== null) out.push([property, safe]);
  }
  return out;
}

const LOCAL_REFERENCE = /^url\(#[A-Za-z0-9_.:-]+\)$/;

/** A number, or a percentage of one, as `extractOpacity` and a stop's offset read it. */
function fraction(value: string): string | null {
  const text = value.trim();
  return svgNumber(text.endsWith("%") ? text.slice(0, -1) : text) === null ? null : text;
}

/**
 * A kept attribute's value in a form react-native-svg's native side reads,
 * or null when it has none. `orient` is read with its marker (`svgMarkerOrient`).
 */
function nativeValue(element: string, name: string, value: string): string | null {
  switch (name) {
    case "orient":
      return element === "marker" ? value : null;
    case "id":
    case "xmlns":
    case "fill":
    case "stroke":
    case "stop-color":
      // Paint is read by `extractBrush`, which takes any string.
      return value;
    case "x":
    case "y":
    case "dx":
    case "dy":
      // A text's positions are a list, one per character; anything else's a length.
      return element === "text" || element === "tspan" ? svgLengthList(value) : svgLength(value);
    case "x1":
    case "y1":
    case "x2":
    case "y2":
    case "cx":
    case "cy":
    case "fx":
    case "fy":
    case "refX":
    case "refY":
    case "stroke-dashoffset":
      return svgLength(value);
    case "r":
    case "rx":
    case "ry":
    case "width":
    case "height":
    case "markerWidth":
    case "markerHeight":
    case "stroke-width":
    case "font-size":
      return svgLength(value, { nonNegative: true });
    case "letter-spacing":
      return value.trim() === "normal" ? "normal" : svgLength(value);
    case "stroke-dasharray":
      return value.trim() === "none" ? "none" : svgLengthList(value, { nonNegative: true });
    case "opacity":
    case "fill-opacity":
    case "stroke-opacity":
    case "stop-opacity":
    case "offset":
      return fraction(value);
    case "stroke-miterlimit": {
      const limit = svgNumber(value);
      return limit !== null && limit >= 1 ? value.trim() : null;
    }
    case "version":
      return svgNumber(value) === null ? null : value.trim();
    case "viewBox":
      return svgViewBox(value);
    case "preserveAspectRatio":
      return svgPreserveAspectRatio(value);
    case "transform":
    case "gradientTransform":
      return svgTransform(value);
    case "d":
      return svgPathReads(value) ? value : null;
    case "points":
      return svgPoints(value, element === "polygon");
    case "font-weight":
      return svgFontWeight(value);
    case "font-family":
    case "display":
    case "dominant-baseline":
      return svgWord(value);
    case "clip-path":
    case "marker-start":
    case "marker-mid":
    case "marker-end":
      // `extractProps` matches these as strings: only a reference is one.
      return LOCAL_REFERENCE.test(value) ? value : null;
    default: {
      const text = value.trim();
      return SVG_KEYWORDS[name]?.includes(text) ? text : null;
    }
  }
}

/**
 * An element's attributes as they may be written, in order; null when the
 * element is to be dropped whole, a shape whose geometry react-native-svg
 * could not read.
 */
function keptAttributes(element: string, attributes: [string, string][]): Map<string, string> | null {
  const kept = new Map<string, string>();
  const fromStyle: [string, string][] = [];
  for (const [rawName, rawValue] of attributes) {
    const lower = rawName.toLowerCase();
    if (lower === "style") {
      fromStyle.push(...styleDeclarations(rawValue));
      continue;
    }
    const name = ATTRIBUTES.get(lower);
    if (!name) continue;
    if (name === "xmlns" && rawValue !== "http://www.w3.org/2000/svg") continue;
    if (name === "id" && !/^[A-Za-z0-9_.:-]{1,128}$/.test(rawValue)) continue;
    const value = safeSvgValue(rawValue);
    if (value === null || value.length > 200_000) continue;
    kept.set(name, value);
  }
  // A style's declarations win over attributes, as CSS has it.
  for (const [property, value] of fromStyle) kept.set(ATTRIBUTES.get(property) ?? property, value);
  for (const [name, value] of kept) {
    const native = nativeValue(element, name, value);
    if (native !== null) kept.set(name, native);
    else if (name === "d" || name === "points") return null;
    else kept.delete(name);
  }
  if (element === "svg") kept.set("xmlns", "http://www.w3.org/2000/svg");
  return kept;
}

/** A kept marker, where it was written, for the reversed copy its start uses get. */
type WrittenMarker = {
  attributes: Map<string, string>;
  reverseAtStart: boolean;
  contentStart: number;
  contentEnd: number;
  end: number;
};

/**
 * The point a reversed marker copy turns about, and its reference point
 * there; null when the marker's box or reference point is not plain numbers.
 *
 * Turning the contents about the reference point would be enough to face
 * back, but it would carry them out of the marker's box, which a browser
 * clips to. So they turn about the box's centre, which keeps them in it, and
 * the reference point turns with them: drawn from there, every point of the
 * contents sits where turning about the reference point puts it.
 */
function reversal(attributes: Map<string, string>): { centre: [number, number]; reference: [number, number] } | null {
  const plain = (name: string, fallback: string) => svgNumber((attributes.get(name) ?? fallback).trim().replace(/px$/, ""));
  const reference = [plain("refX", "0"), plain("refY", "0")];
  // The box: the viewBox where there is one, else markerWidth by markerHeight (3 by 3 unless given).
  const box = attributes.get("viewBox")?.split(/[\s,]+/).map(Number) ?? [0, 0, plain("markerWidth", "3"), plain("markerHeight", "3")];
  if ([...reference, ...box].some((value) => value === null)) return null;
  const [x, y, width, height] = box as number[];
  const centre: [number, number] = [x + width / 2, y + height / 2];
  const turned = (at: number, about: number) => Number((2 * about - at).toFixed(4));
  return { centre, reference: [turned(reference[0]!, centre[0]), turned(reference[1]!, centre[1])] };
}

/**
 * The drawing with each `auto-start-reverse` marker that a `marker-start`
 * names given a reversed copy beside it, its contents turned 180° and drawn
 * `auto`, and those references pointed at the copy. That is the marker SVG
 * draws at a start: turned to face back along the path. A marker whose box or
 * reference point is not plain numbers keeps its start uses facing forward:
 * drawn, if the wrong way round.
 */
function withReversedStarts(
  out: string,
  markers: readonly WrittenMarker[],
  references: readonly { at: number; value: string }[],
  ids: Set<string>,
): string {
  const byId = new Map<string, WrittenMarker>();
  // As react-native-svg defines them: a later marker of the same id wins.
  for (const marker of markers) {
    const id = marker.attributes.get("id");
    if (id !== undefined) byId.set(id, marker);
  }
  const edits: { at: number; remove: number; text: string }[] = [];
  const reversed = new Map<string, string>();
  for (const { at, value } of references) {
    const id = /^url\(#(.+)\)$/.exec(value)![1];
    let copy = reversed.get(id);
    if (copy === undefined) {
      const marker = byId.get(id);
      if (!marker?.reverseAtStart) continue;
      const turn = reversal(marker.attributes);
      if (!turn) continue;
      copy = `${id}-reversed`;
      while (ids.has(copy)) copy += "-";
      ids.add(copy);
      reversed.set(id, copy);
      const attributes = new Map(marker.attributes);
      attributes.set("id", copy);
      attributes.set("refX", String(turn.reference[0]));
      attributes.set("refY", String(turn.reference[1]));
      let opening = "<marker";
      for (const [name, attribute] of attributes) opening += ` ${name}="${escapeAttribute(attribute)}"`;
      const content = out.slice(marker.contentStart, marker.contentEnd);
      const [x, y] = turn.centre;
      edits.push({ at: marker.end, remove: 0, text: `${opening}><g transform="rotate(180 ${x} ${y})">${content}</g></marker>` });
    }
    edits.push({ at, remove: value.length, text: `url(#${copy})` });
  }
  edits.sort((a, b) => b.at - a.at);
  for (const edit of edits) out = out.slice(0, edit.at) + edit.text + out.slice(edit.at + edit.remove);
  return out;
}

// What a tspan inherits from its text and may say again without changing a
// thing. A tspan that says nothing else, no position, no id, nothing that
// does not inherit, is a run of its line's text.
const INHERITED_BY_RUNS = new Set([
  "fill",
  "fill-opacity",
  "fill-rule",
  "stroke",
  "stroke-width",
  "stroke-opacity",
  "stroke-dasharray",
  "stroke-dashoffset",
  "stroke-linecap",
  "stroke-linejoin",
  "stroke-miterlimit",
  "font-family",
  "font-size",
  "font-weight",
  "font-style",
  "text-anchor",
  "letter-spacing",
  "visibility",
]);

/** What a text or tspan's runs inherit: its own text's, with what it says itself. */
function runStyle(inherited: ReadonlyMap<string, string> | undefined, attributes: ReadonlyMap<string, string>): Map<string, string> {
  const style = new Map(inherited);
  for (const [name, value] of attributes) if (INHERITED_BY_RUNS.has(name)) style.set(name, value);
  return style;
}

function dimension(value: string | undefined): number | undefined {
  if (value === undefined || !/^\s*[0-9.]+(px)?\s*$/.test(value)) return undefined;
  const number = Number.parseFloat(value);
  return Number.isFinite(number) && number > 0 ? number : undefined;
}

/**
 * The SVG rebuilt from its allowed parts, with its size; null when it is not
 * an SVG document, is malformed past reading, or is over the limits.
 */
export function sanitizeSvg(input: string, limits = SVG_LIMITS): SanitizedSvg | null {
  if (typeof input !== "string" || input.length > limits.bytes) return null;
  const source = input;
  let out = "";
  // Each open element: its name, and whether it is written (`kept`), left
  // out with its contents written (`unwrapped`), or left out whole; a marker
  // with where it was written, and whether a `defs` was opened for it. A text
  // or tspan has what its runs inherit, and the last run written in it, where
  // it closed; a run written as a tspan has what it says.
  type Runs = { style: Map<string, string>; last?: { says: string; end: number } };
  type Open = { name: string; mode: "kept" | "unwrapped" | "dropped"; marker?: WrittenMarker; inDefs?: boolean; runs?: Runs; says?: string };
  const stack: Open[] = [];
  let dropping = 0;
  // Every id written, every marker, and every `marker-start` reference, where
  // its value was written, for the reversed copies.
  const ids = new Set<string>();
  const markers: WrittenMarker[] = [];
  const startReferences: { at: number; value: string }[] = [];
  const writeAttributes = (attributes: Map<string, string>) => {
    for (const [name, value] of attributes) {
      if (name === "id") ids.add(value);
      if (name === "marker-start") startReferences.push({ at: out.length + name.length + 3, value });
      out += ` ${name}="${escapeAttribute(value)}"`;
    }
  };
  const closeElement = (entry: Open) => {
    if (entry.mode === "dropped") dropping -= 1;
    else if (entry.mode === "kept" && !dropping) {
      if (entry.marker) entry.marker.contentEnd = out.length;
      out += `</${KEPT.get(entry.name)}>`;
      if (entry.marker) {
        entry.marker.end = out.length;
        markers.push(entry.marker);
      }
      if (entry.inDefs) out += "</defs>";
      const runs = stack[stack.length - 1]?.runs;
      if (entry.says !== undefined && runs) runs.last = { says: entry.says, end: out.length };
    }
  };
  let elements = 0;
  let root: { width?: number; height?: number; viewBox?: string } | null = null;
  let rootClosed = false;
  let index = 0;
  while (index < source.length) {
    const open = source.indexOf("<", index);
    const textEnd = open === -1 ? source.length : open;
    if (textEnd > index) {
      const text = source.slice(index, textEnd);
      if (!dropping && stack.length && /^(text|tspan)$/.test(stack[stack.length - 1].name)) out += escapeText(decodeEntities(text));
      index = textEnd;
      if (open === -1) break;
    }
    if (source.startsWith("<!--", index)) {
      const close = source.indexOf("-->", index + 4);
      index = close === -1 ? source.length : close + 3;
      continue;
    }
    if (source.startsWith("<![CDATA[", index)) {
      const close = source.indexOf("]]>", index + 9);
      const text = source.slice(index + 9, close === -1 ? source.length : close);
      if (!dropping && stack.length && /^(text|tspan)$/.test(stack[stack.length - 1].name)) out += escapeText(text);
      index = close === -1 ? source.length : close + 3;
      continue;
    }
    if (source.startsWith("<?", index)) {
      const close = source.indexOf("?>", index + 2);
      index = close === -1 ? source.length : close + 2;
      continue;
    }
    if (source.startsWith("<!", index)) {
      // A doctype, with any internal subset of entity declarations: none is read.
      const subset = source.indexOf("[", index);
      const close = source.indexOf(">", index);
      if (subset !== -1 && subset < close) {
        const end = source.indexOf("]>", subset);
        index = end === -1 ? source.length : end + 2;
      } else index = close === -1 ? source.length : close + 1;
      continue;
    }
    if (source.startsWith("</", index)) {
      const close = source.indexOf(">", index);
      if (close === -1) return null;
      const name = source.slice(index + 2, close).trim().toLowerCase();
      index = close + 1;
      const at = stack.map((entry) => entry.name).lastIndexOf(name);
      if (at === -1) continue;
      while (stack.length > at) closeElement(stack.pop()!);
      if (stack.length === 0) rootClosed = true;
      continue;
    }
    const tag = readTag(source, index + 1);
    if (!tag) return null;
    index = tag.end;
    if (rootClosed) continue;
    elements += 1;
    if (elements > limits.elements || stack.length >= limits.depth) return null;
    const name = tag.name.toLowerCase();
    if (!root) {
      if (name !== "svg") return null;
      const value = (attribute: string) => tag.attributes.find(([key]) => key.toLowerCase() === attribute)?.[1];
      root = { width: dimension(value("width")), height: dimension(value("height")), viewBox: value("viewbox") };
    }
    let mode: Open["mode"] = dropping ? "dropped" : KEPT.has(name) ? "kept" : UNWRAPPED.has(name) ? "unwrapped" : "dropped";
    const attributes = mode === "kept" ? keptAttributes(name, tag.attributes) : null;
    if (!attributes && mode === "kept") mode = "dropped";
    const entry: Open = { name, mode };
    // A line's runs of text, one tspan a word as Mermaid writes a label,
    // are written as one: react-native-svg lays a line's tspans out itself
    // and misplaces each word after the first (a word's leading space is
    // drawn too wide or not at all), where one run of text it lays out right.
    // A run that says no more than its line inherits is its text and no
    // more, and one beside a run that says the same continues it.
    const line = attributes && name === "tspan" && !tag.selfClosing ? stack[stack.length - 1]?.runs : undefined;
    if (line && [...attributes!.keys()].every((key) => INHERITED_BY_RUNS.has(key))) {
      if ([...attributes!].every(([key, value]) => line.style.get(key) === value)) entry.mode = mode = "unwrapped";
      else entry.says = [...attributes!].map(([key, value]) => `${key}=${value}`).join("\n");
    }
    if (attributes && (name === "text" || name === "tspan")) entry.runs = { style: runStyle(stack[stack.length - 1]?.runs?.style, attributes) };
    if (entry.says !== undefined && line!.last?.says === entry.says && line!.last.end === out.length) {
      out = out.slice(0, -"</tspan>".length);
    } else if (attributes && mode === "kept") {
      if (name === "marker") {
        const { orient, reverseAtStart } = svgMarkerOrient(attributes.get("orient"));
        attributes.set("orient", orient);
        entry.inDefs = !stack.some((open) => open.mode === "kept" && open.name === "defs");
        if (entry.inDefs) out += "<defs>";
        out += "<marker";
        writeAttributes(attributes);
        out += tag.selfClosing ? "/>" : ">";
        if (tag.selfClosing && entry.inDefs) out += "</defs>";
        if (!tag.selfClosing) entry.marker = { attributes, reverseAtStart, contentStart: out.length, contentEnd: 0, end: 0 };
      } else {
        out += `<${KEPT.get(name)}`;
        writeAttributes(attributes);
        out += tag.selfClosing ? "/>" : ">";
      }
    }
    if (tag.selfClosing) {
      if (stack.length === 0) rootClosed = true;
      continue;
    }
    if (mode === "dropped") dropping += 1;
    stack.push(entry);
  }
  if (!root || stack.length) {
    // An unclosed document is closed here rather than refused, as long as it began as an SVG.
    if (!root) return null;
    while (stack.length) closeElement(stack.pop()!);
  }
  out = withReversedStarts(out, markers, startReferences, ids);
  let { width, height } = root;
  const box = (root.viewBox ?? "").trim().split(/[\s,]+/).map(Number);
  if (box.length === 4 && box.every(Number.isFinite) && box[2] > 0 && box[3] > 0) {
    if (width === undefined || height === undefined) {
      width = box[2];
      height = box[3];
    }
  }
  if (width === undefined || height === undefined) return null;
  return { svg: out, width, height };
}
