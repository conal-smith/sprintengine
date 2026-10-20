// Glyph outlines read straight out of a TrueType font, for the formula
// renderer (`rendererMain.js`). KaTeX lays a formula out as HTML in KaTeX's
// own faces; the phone draws the result with react-native-svg, which has
// none of those faces. So each glyph is drawn as the outline the face holds
// for it, at the place the browser set it, and the SVG needs no font at all.
//
// Only what KaTeX's TrueType files use is read: the table directory, `head`,
// `maxp`, `hhea`, `loca`, `cmap` (formats 0, 4, 6 and 12) and `glyf`, simple
// and composite glyphs alike. A component placed by point matching rather
// than by offset is placed at its origin; KaTeX's faces have none.
//
// Loaded as a plain script in the renderer page, where it sets
// `globalThis.ttfGlyphs`, and required by the regression suite on Node.
(function (root) {
  "use strict";

  function readTables(view) {
    const count = view.getUint16(4);
    const tables = {};
    for (let index = 0; index < count; index += 1) {
      const at = 12 + index * 16;
      const tag = String.fromCharCode(view.getUint8(at), view.getUint8(at + 1), view.getUint8(at + 2), view.getUint8(at + 3));
      tables[tag] = { offset: view.getUint32(at + 8), length: view.getUint32(at + 12) };
    }
    return tables;
  }

  /** The best Unicode subtable's lookup, from code point to glyph index. */
  function readCmap(view, offset) {
    const count = view.getUint16(offset + 2);
    const candidates = [];
    for (let index = 0; index < count; index += 1) {
      const at = offset + 4 + index * 8;
      const platform = view.getUint16(at);
      const encoding = view.getUint16(at + 2);
      const table = offset + view.getUint32(at + 4);
      const format = view.getUint16(table);
      const rank =
        platform === 3 && encoding === 10 ? 0 : platform === 0 ? 1 : platform === 3 && encoding === 1 ? 2 : platform === 3 && encoding === 0 ? 3 : platform === 1 ? 4 : 9;
      if ([0, 4, 6, 12].includes(format) && rank < 9) candidates.push({ rank, table, format });
    }
    candidates.sort((a, b) => a.rank - b.rank);
    const chosen = candidates[0];
    if (!chosen) return () => 0;
    const { table, format } = chosen;
    if (format === 0) return (code) => (code < 256 ? view.getUint8(table + 6 + code) : 0);
    if (format === 6) {
      const first = view.getUint16(table + 6);
      const entries = view.getUint16(table + 8);
      return (code) => (code >= first && code < first + entries ? view.getUint16(table + 10 + (code - first) * 2) : 0);
    }
    if (format === 12) {
      const groups = view.getUint32(table + 12);
      return (code) => {
        let low = 0;
        let high = groups - 1;
        while (low <= high) {
          const middle = (low + high) >> 1;
          const at = table + 16 + middle * 12;
          const start = view.getUint32(at);
          const end = view.getUint32(at + 4);
          if (code < start) high = middle - 1;
          else if (code > end) low = middle + 1;
          else return view.getUint32(at + 8) + (code - start);
        }
        return 0;
      };
    }
    const segments = view.getUint16(table + 6) / 2;
    const ends = table + 14;
    const starts = ends + segments * 2 + 2;
    const deltas = starts + segments * 2;
    const ranges = deltas + segments * 2;
    return (code) => {
      if (code > 0xffff) return 0;
      for (let index = 0; index < segments; index += 1) {
        if (code > view.getUint16(ends + index * 2)) continue;
        const start = view.getUint16(starts + index * 2);
        if (code < start) return 0;
        const delta = view.getInt16(deltas + index * 2);
        const range = view.getUint16(ranges + index * 2);
        if (range === 0) return (code + delta) & 0xffff;
        const glyph = view.getUint16(ranges + index * 2 + range + (code - start) * 2);
        return glyph === 0 ? 0 : (glyph + delta) & 0xffff;
      }
      return 0;
    };
  }

  const ON_CURVE = 0x01;
  const X_SHORT = 0x02;
  const Y_SHORT = 0x04;
  const REPEAT = 0x08;
  const X_SAME = 0x10;
  const Y_SAME = 0x20;

  const ARGS_ARE_WORDS = 0x0001;
  const ARGS_ARE_XY = 0x0002;
  const HAS_SCALE = 0x0008;
  const MORE_COMPONENTS = 0x0020;
  const HAS_XY_SCALE = 0x0040;
  const HAS_2X2 = 0x0080;

  /**
   * A font's outlines and metrics. `contours(glyph)` is the glyph's contours
   * in font units, y up, each a list of `{ x, y, on }` points.
   */
  function parseFont(buffer) {
    const view = new DataView(buffer);
    const tables = readTables(view);
    for (const tag of ["head", "maxp", "loca", "glyf", "cmap"]) {
      if (!tables[tag]) throw new Error(`The font has no ${tag} table`);
    }
    const head = tables.head.offset;
    const unitsPerEm = view.getUint16(head + 18);
    const longOffsets = view.getInt16(head + 50) === 1;
    const glyphCount = view.getUint16(tables.maxp.offset + 4);
    const hhea = tables.hhea ? tables.hhea.offset : -1;
    const ascender = hhea >= 0 ? view.getInt16(hhea + 4) : unitsPerEm;
    const descender = hhea >= 0 ? view.getInt16(hhea + 6) : 0;
    const loca = tables.loca.offset;
    const glyf = tables.glyf.offset;
    const glyphAt = (glyph) =>
      longOffsets
        ? [view.getUint32(loca + glyph * 4), view.getUint32(loca + glyph * 4 + 4)]
        : [view.getUint16(loca + glyph * 2) * 2, view.getUint16(loca + glyph * 2 + 2) * 2];
    const lookup = readCmap(view, tables.cmap.offset);
    const cache = new Map();

    function simple(at, contourCount) {
      const endPoints = [];
      for (let index = 0; index < contourCount; index += 1) endPoints.push(view.getUint16(at + 10 + index * 2));
      const pointCount = contourCount ? endPoints[contourCount - 1] + 1 : 0;
      const instructions = view.getUint16(at + 10 + contourCount * 2);
      let cursor = at + 12 + contourCount * 2 + instructions;
      const flags = [];
      while (flags.length < pointCount) {
        const flag = view.getUint8(cursor++);
        flags.push(flag);
        if (flag & REPEAT) {
          let repeats = view.getUint8(cursor++);
          while (repeats-- > 0 && flags.length < pointCount) flags.push(flag);
        }
      }
      const xs = [];
      let x = 0;
      for (const flag of flags) {
        if (flag & X_SHORT) {
          const step = view.getUint8(cursor++);
          x += flag & X_SAME ? step : -step;
        } else if (!(flag & X_SAME)) {
          x += view.getInt16(cursor);
          cursor += 2;
        }
        xs.push(x);
      }
      const ys = [];
      let y = 0;
      for (const flag of flags) {
        if (flag & Y_SHORT) {
          const step = view.getUint8(cursor++);
          y += flag & Y_SAME ? step : -step;
        } else if (!(flag & Y_SAME)) {
          y += view.getInt16(cursor);
          cursor += 2;
        }
        ys.push(y);
      }
      const contours = [];
      let first = 0;
      for (const last of endPoints) {
        const contour = [];
        for (let index = first; index <= last; index += 1) contour.push({ x: xs[index], y: ys[index], on: (flags[index] & ON_CURVE) !== 0 });
        contours.push(contour);
        first = last + 1;
      }
      return contours;
    }

    function composite(at, depth) {
      const contours = [];
      let cursor = at + 10;
      let flags = MORE_COMPONENTS;
      while (flags & MORE_COMPONENTS) {
        flags = view.getUint16(cursor);
        const component = view.getUint16(cursor + 2);
        cursor += 4;
        let dx = 0;
        let dy = 0;
        if (flags & ARGS_ARE_WORDS) {
          if (flags & ARGS_ARE_XY) {
            dx = view.getInt16(cursor);
            dy = view.getInt16(cursor + 2);
          }
          cursor += 4;
        } else {
          if (flags & ARGS_ARE_XY) {
            dx = view.getInt8(cursor);
            dy = view.getInt8(cursor + 1);
          }
          cursor += 2;
        }
        let [a, b, c, d] = [1, 0, 0, 1];
        const f2dot14 = (offset) => view.getInt16(offset) / 16384;
        if (flags & HAS_SCALE) {
          a = d = f2dot14(cursor);
          cursor += 2;
        } else if (flags & HAS_XY_SCALE) {
          a = f2dot14(cursor);
          d = f2dot14(cursor + 2);
          cursor += 4;
        } else if (flags & HAS_2X2) {
          a = f2dot14(cursor);
          b = f2dot14(cursor + 2);
          c = f2dot14(cursor + 4);
          d = f2dot14(cursor + 6);
          cursor += 8;
        }
        for (const contour of outline(component, depth + 1)) {
          contours.push(contour.map((point) => ({ x: a * point.x + c * point.y + dx, y: b * point.x + d * point.y + dy, on: point.on })));
        }
      }
      return contours;
    }

    function outline(glyph, depth) {
      if (glyph < 0 || glyph >= glyphCount || depth > 8) return [];
      const [start, end] = glyphAt(glyph);
      if (end <= start) return [];
      const at = glyf + start;
      const contourCount = view.getInt16(at);
      return contourCount >= 0 ? simple(at, contourCount) : composite(at, depth);
    }

    return {
      unitsPerEm,
      ascender,
      descender,
      glyphCount,
      /** The glyph a code point maps to; 0, the missing glyph, when the face has none. */
      glyphIndex: (codePoint) => lookup(codePoint),
      contours(glyph) {
        let hit = cache.get(glyph);
        if (!hit) cache.set(glyph, (hit = outline(glyph, 0)));
        return hit;
      },
    };
  }

  const round = (value) => {
    const rounded = Math.round(value * 100) / 100;
    return Object.is(rounded, -0) ? "0" : String(rounded);
  };

  /**
   * SVG path data for contours placed at `(x, baseline)` and scaled by
   * `scale` (pixels per font unit), y flipped to point down. Quadratic
   * segments stay quadratic; two off-curve points in a row imply the
   * on-curve point halfway between them, as TrueType defines.
   */
  function pathData(contours, x, baseline, scale) {
    const px = (point) => round(x + point.x * scale);
    const py = (point) => round(baseline - point.y * scale);
    let data = "";
    for (const contour of contours) {
      if (contour.length < 2) continue;
      const count = contour.length;
      // A contour of off-curve points only starts halfway between its last
      // point and its first, and walks all of them before closing there.
      let startIndex = contour.findIndex((point) => point.on);
      let start;
      if (startIndex === -1) {
        start = { x: (contour[0].x + contour[count - 1].x) / 2, y: (contour[0].y + contour[count - 1].y) / 2, on: true };
        startIndex = count - 1;
      } else start = contour[startIndex];
      data += `M${px(start)} ${py(start)}`;
      let control = null;
      for (let step = 1; step <= count; step += 1) {
        const point = contour[(startIndex + step) % count];
        if (point.on) {
          data += control ? `Q${px(control)} ${py(control)} ${px(point)} ${py(point)}` : `L${px(point)} ${py(point)}`;
          control = null;
        } else if (control) {
          const middle = { x: (control.x + point.x) / 2, y: (control.y + point.y) / 2 };
          data += `Q${px(control)} ${py(control)} ${px(middle)} ${py(middle)}`;
          control = point;
        } else control = point;
      }
      if (control) data += `Q${px(control)} ${py(control)} ${px(start)} ${py(start)}`;
      data += "Z";
    }
    return data;
  }

  /** The contours' extent in font units, or null for an empty glyph. */
  function contourBounds(contours) {
    let xMin = Infinity;
    let yMin = Infinity;
    let xMax = -Infinity;
    let yMax = -Infinity;
    for (const contour of contours) {
      for (const point of contour) {
        if (point.x < xMin) xMin = point.x;
        if (point.x > xMax) xMax = point.x;
        if (point.y < yMin) yMin = point.y;
        if (point.y > yMax) yMax = point.y;
      }
    }
    return xMin === Infinity ? null : { xMin, yMin, xMax, yMax };
  }

  const api = { parseFont, pathData, contourBounds };
  root.ttfGlyphs = api;
  if (typeof module === "object" && module.exports) module.exports = api;
})(typeof globalThis === "object" ? globalThis : this);
