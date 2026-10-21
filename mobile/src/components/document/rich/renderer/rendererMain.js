/* global ttfGlyphs, mermaid, katex */
// The renderer page's own script: it draws a reply's diagrams and formulas
// into SVG the phone can hold, one job at a time, and hands each back to
// React Native as a string. It runs in the hidden renderer WebView
// (`RichRendererHost.tsx`), whose page refuses every request and navigation;
// what it sends back is untrusted there and sanitised again
// (`svgSanitizer.ts`) before anything draws it.
//
// The phone draws with react-native-svg, which reads no stylesheet, has no
// `foreignObject` and has none of KaTeX's faces. So what comes back is
// flattened: every style the page computed is written onto the element it
// styles, a baseline the native renderer cannot place is turned into an
// offset, and every KaTeX glyph is the outline its face holds for it.
//
// Jobs arrive through `window.__richRender(job)`, injected by the host:
//   { id, kind: "mermaid" | "math", source, fontSize, fontFamily, color, theme }
// and leave as `{ type: "result", id, svg, width, height }` or
// `{ type: "error", id, message }`.
(function () {
  "use strict";

  const bridge = window.ReactNativeWebView;
  const send = (message) => {
    if (bridge) bridge.postMessage(JSON.stringify(message));
  };
  const stage = document.getElementById("stage");
  const messageOf = (error) => (error && error.message ? String(error.message) : String(error || "Unknown error"));

  // ---- KaTeX's faces ---------------------------------------------------------

  // `window.__richFonts` is written by `scripts/build-rich-renderer.mjs` from
  // katex.css's own @font-face rules: each face's family, weight, style and
  // TrueType bytes, base64. They are added to the page from memory (nothing
  // is fetched) and read for their outlines from the same bytes.
  const faces = new Map();
  for (const face of window.__richFonts || []) faces.set(`${face.family}|${face.weight}|${face.style}`, face);
  let fontsLoading = null;

  function bytesOf(face) {
    if (!face.buffer) {
      const binary = atob(face.data);
      const bytes = new Uint8Array(binary.length);
      for (let index = 0; index < binary.length; index += 1) bytes[index] = binary.charCodeAt(index);
      face.buffer = bytes.buffer;
    }
    return face.buffer;
  }

  function fontsReady() {
    fontsLoading =
      fontsLoading ||
      Promise.all(
        [...faces.values()].map((face) => {
          const loaded = new FontFace(face.family, bytesOf(face), { weight: String(face.weight), style: face.style });
          document.fonts.add(loaded);
          return loaded.load();
        }),
      );
    return fontsLoading;
  }

  function outlinesOf(face) {
    if (!face.outlines) face.outlines = ttfGlyphs.parseFont(bytesOf(face));
    return face.outlines;
  }

  /** The face a computed style resolves to, if it is one of KaTeX's. */
  function faceFor(style) {
    const family = style.fontFamily.split(",")[0].trim().replace(/^["']|["']$/g, "");
    if (!family.startsWith("KaTeX_")) return null;
    const weight = Number.parseInt(style.fontWeight, 10) >= 600 ? 700 : 400;
    const italic = style.fontStyle === "italic" || style.fontStyle === "oblique" ? "italic" : "normal";
    return (
      faces.get(`${family}|${weight}|${italic}`) ||
      faces.get(`${family}|${weight}|normal`) ||
      faces.get(`${family}|400|${italic}`) ||
      faces.get(`${family}|400|normal`) ||
      null
    );
  }

  // ---- Shared helpers ----------------------------------------------------------

  const round = (value) => {
    const rounded = Math.round(value * 100) / 100;
    return Object.is(rounded, -0) ? 0 : rounded;
  };
  const px = (value) => Number.parseFloat(value) || 0;
  const transparent = (color) => !color || color === "transparent" || /rgba\([^)]*,\s*0\)$/.test(color);
  const escapeText = (text) => text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
  const escapeAttribute = (text) => escapeText(text).replace(/"/g, "&quot;");

  function bounds() {
    return { left: Infinity, top: Infinity, right: -Infinity, bottom: -Infinity };
  }
  function grow(box, left, top, right, bottom) {
    if (!(right > left) && !(bottom > top)) return;
    box.left = Math.min(box.left, left);
    box.top = Math.min(box.top, top);
    box.right = Math.max(box.right, right);
    box.bottom = Math.max(box.bottom, bottom);
  }

  // ---- Formulas ------------------------------------------------------------------

  // The formula is an agent's text: `trust: false` refuses `\href`, `\url`,
  // `\includegraphics` and raw HTML; `maxExpand` stops a self-referencing
  // macro, and `maxSize` an absurd dimension. The desktop's options.
  const KATEX_OPTIONS = {
    displayMode: true,
    output: "html",
    throwOnError: true,
    trust: false,
    strict: "ignore",
    maxExpand: 1000,
    maxSize: 20,
  };

  async function drawFormula(job) {
    await fontsReady();
    const markup = katex.renderToString(job.source, KATEX_OPTIONS);
    const box = document.createElement("div");
    box.className = "formula";
    box.style.fontSize = `${job.fontSize}px`;
    box.style.color = job.color;
    box.innerHTML = markup;
    stage.appendChild(box);
    const root = box.querySelector(".katex-html") || box;
    const origin = root.getBoundingClientRect();
    const extent = bounds();
    grow(extent, origin.left, origin.top, origin.right, origin.bottom);

    // A marker after every run of text, sitting on its baseline: an empty
    // inline block's bottom edge is the line's baseline. Placed before
    // anything is measured, so every measurement sees the same layout.
    const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
    const runs = [];
    for (let node = walker.nextNode(); node; node = walker.nextNode()) {
      if (!node.nodeValue || !node.nodeValue.trim()) continue;
      const marker = document.createElement("span");
      marker.className = "baseline";
      node.parentNode.insertBefore(marker, node.nextSibling);
      runs.push({ node, marker });
    }

    const backgrounds = [];
    const rules = [];
    const clips = [];
    const drawings = [];
    const glyphs = new Map();
    const fallbacks = [];

    for (const element of root.querySelectorAll("*")) {
      if (element.closest("svg")) continue;
      const style = getComputedStyle(element);
      if (style.visibility === "hidden") continue;
      const rect = element.getBoundingClientRect();
      if (!transparent(style.backgroundColor) && rect.width > 0 && rect.height > 0) {
        backgrounds.push({ x: rect.left, y: rect.top, width: rect.width, height: rect.height, fill: style.backgroundColor });
      }
      for (const side of ["top", "right", "bottom", "left"]) {
        const width = px(style.getPropertyValue(`border-${side}-width`));
        const line = style.getPropertyValue(`border-${side}-style`);
        const color = style.getPropertyValue(`border-${side}-color`);
        if (!(width > 0) || line === "none" || line === "hidden" || transparent(color)) continue;
        const edge =
          side === "top"
            ? { x: rect.left, y: rect.top, width: rect.width, height: width }
            : side === "bottom"
              ? { x: rect.left, y: rect.bottom - width, width: rect.width, height: width }
              : side === "left"
                ? { x: rect.left, y: rect.top, width, height: rect.height }
                : { x: rect.right - width, y: rect.top, width, height: rect.height };
        rules.push({ ...edge, fill: color, dashed: line === "dashed" || line === "dotted", horizontal: side === "top" || side === "bottom" });
        grow(extent, edge.x, edge.y, edge.x + edge.width, edge.y + edge.height);
      }
    }

    // KaTeX's own SVG (roots, stretchy arrows and braces): each kept as its
    // shapes, placed by its viewBox, clipped to what the page showed of it.
    let clipCount = 0;
    for (const svg of root.querySelectorAll("svg")) {
      const rect = svg.getBoundingClientRect();
      let clip = { left: rect.left, top: rect.top, right: rect.right, bottom: rect.bottom };
      for (let parent = svg.parentElement; parent && parent !== box; parent = parent.parentElement) {
        const style = getComputedStyle(parent);
        if (style.overflowX === "visible" && style.overflowY === "visible") continue;
        const outer = parent.getBoundingClientRect();
        clip = {
          left: Math.max(clip.left, outer.left),
          top: Math.max(clip.top, outer.top),
          right: Math.min(clip.right, outer.right),
          bottom: Math.min(clip.bottom, outer.bottom),
        };
      }
      if (!(clip.right > clip.left) || !(clip.bottom > clip.top)) continue;
      const placement = viewBoxPlacement(svg, rect);
      const shapes = [];
      for (const shape of svg.querySelectorAll("path, line, rect, polygon, polyline, circle, ellipse")) {
        const serialised = svgShape(shape, placement);
        if (serialised) shapes.push(serialised);
      }
      if (!shapes.length) continue;
      // Unique to the job, so two formulas never share a clip by name.
      const id = `${String(job.id).replace(/[^A-Za-z0-9_-]/g, "")}clip${++clipCount}`;
      clips.push({ id, ...clip });
      drawings.push({ id, transform: placement.transform, shapes });
      grow(extent, clip.left, clip.top, clip.right, clip.bottom);
    }

    for (const { node, marker } of runs) {
      const parent = node.parentElement;
      const style = getComputedStyle(parent);
      if (style.visibility === "hidden" || transparent(style.color)) continue;
      const baseline = marker.getBoundingClientRect().bottom;
      const size = px(style.fontSize);
      const face = faceFor(style);
      const outlines = face ? outlinesOf(face) : null;
      const text = node.nodeValue;
      const range = document.createRange();
      let offset = 0;
      for (const character of text) {
        const length = character.length;
        const codePoint = character.codePointAt(0);
        if (!/\s/.test(character)) {
          range.setStart(node, offset);
          range.setEnd(node, offset + length);
          const box = range.getBoundingClientRect();
          const glyph = outlines ? outlines.glyphIndex(codePoint) : 0;
          if (outlines && glyph) {
            const contours = outlines.contours(glyph);
            const scale = size / outlines.unitsPerEm;
            const extentOf = ttfGlyphs.contourBounds(contours);
            if (extentOf) {
              const data = ttfGlyphs.pathData(contours, box.left - origin.left, baseline - origin.top, scale);
              const list = glyphs.get(style.color) || [];
              list.push(data);
              glyphs.set(style.color, list);
              grow(extent, box.left + extentOf.xMin * scale, baseline - extentOf.yMax * scale, box.left + extentOf.xMax * scale, baseline - extentOf.yMin * scale);
            }
          } else {
            // A character none of KaTeX's faces has, in a `\text{}`: the
            // phone's own face draws it where the page set it.
            fallbacks.push({ x: box.left, y: baseline, size, fill: style.color, text: character });
            grow(extent, box.left, box.top, box.right, box.bottom);
          }
        }
        offset += length;
      }
    }

    const pad = 1;
    const shiftX = pad - (extent.left - origin.left);
    const shiftY = pad - (extent.top - origin.top);
    const width = round(extent.right - extent.left + pad * 2);
    const height = round(extent.bottom - extent.top + pad * 2);
    const at = (x, y) => [round(x - origin.left + shiftX), round(y - origin.top + shiftY)];
    let out = "";
    if (clips.length) {
      out += "<defs>";
      for (const clip of clips) {
        const [x, y] = at(clip.left, clip.top);
        out += `<clipPath id="${clip.id}"><rect x="${x}" y="${y}" width="${round(clip.right - clip.left)}" height="${round(clip.bottom - clip.top)}"/></clipPath>`;
      }
      out += "</defs>";
    }
    for (const fill of backgrounds) {
      const [x, y] = at(fill.x, fill.y);
      out += `<rect x="${x}" y="${y}" width="${round(fill.width)}" height="${round(fill.height)}" fill="${escapeAttribute(fill.fill)}"/>`;
    }
    for (const rule of rules) {
      const [x, y] = at(rule.x, rule.y);
      if (rule.dashed) {
        const thickness = rule.horizontal ? rule.height : rule.width;
        const [x2, y2] = rule.horizontal ? at(rule.x + rule.width, rule.y) : at(rule.x, rule.y + rule.height);
        const middle = round(thickness / 2);
        out += rule.horizontal
          ? `<line x1="${x}" y1="${round(y + middle)}" x2="${x2}" y2="${round(y2 + middle)}" stroke="${escapeAttribute(rule.fill)}" stroke-width="${round(thickness)}" stroke-dasharray="${round(thickness * 3)} ${round(thickness * 2)}"/>`
          : `<line x1="${round(x + middle)}" y1="${y}" x2="${round(x2 + middle)}" y2="${y2}" stroke="${escapeAttribute(rule.fill)}" stroke-width="${round(thickness)}" stroke-dasharray="${round(thickness * 3)} ${round(thickness * 2)}"/>`;
      } else {
        out += `<rect x="${x}" y="${y}" width="${round(rule.width)}" height="${round(rule.height)}" fill="${escapeAttribute(rule.fill)}"/>`;
      }
    }
    for (const drawing of drawings) {
      const [a, b, c, d, e, f] = drawing.transform;
      const [x, y] = at(e, f);
      out += `<g clip-path="url(#${drawing.id})"><g transform="matrix(${round6(a)} ${round6(b)} ${round6(c)} ${round6(d)} ${x} ${y})">${drawing.shapes.join("")}</g></g>`;
    }
    for (const [fill, list] of glyphs) {
      out += `<path transform="translate(${round(shiftX)} ${round(shiftY)})" fill="${escapeAttribute(fill)}" d="${list.join("")}"/>`;
    }
    for (const glyph of fallbacks) {
      const [x, y] = at(glyph.x, glyph.y);
      out += `<text x="${x}" y="${y}" font-size="${round(glyph.size)}" fill="${escapeAttribute(glyph.fill)}">${escapeText(glyph.text)}</text>`;
    }
    const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" viewBox="0 0 ${width} ${height}">${out}</svg>`;
    return { svg, width, height };
  }

  const round6 = (value) => Math.round(value * 1e6) / 1e6;

  /**
   * Where an inline SVG's user space lands on the page: the matrix from its
   * viewBox to page pixels, as `preserveAspectRatio` places it.
   */
  function viewBoxPlacement(svg, rect) {
    const box = (svg.getAttribute("viewBox") || "").trim().split(/[\s,]+/).map(Number);
    if (box.length !== 4 || box.some((value) => !Number.isFinite(value)) || !(box[2] > 0) || !(box[3] > 0)) {
      return { transform: [1, 0, 0, 1, rect.left, rect.top], viewport: { width: rect.width, height: rect.height } };
    }
    const [minX, minY, viewWidth, viewHeight] = box;
    const [align, meetOrSlice] = (svg.getAttribute("preserveAspectRatio") || "xMidYMid meet").trim().split(/\s+/);
    let scaleX = rect.width / viewWidth;
    let scaleY = rect.height / viewHeight;
    let left = rect.left - minX * scaleX;
    let top = rect.top - minY * scaleY;
    if (align !== "none") {
      const scale = meetOrSlice === "slice" ? Math.max(scaleX, scaleY) : Math.min(scaleX, scaleY);
      scaleX = scaleY = scale;
      const spareX = rect.width - viewWidth * scale;
      const spareY = rect.height - viewHeight * scale;
      const alignX = align.startsWith("xMin") ? 0 : align.startsWith("xMax") ? 1 : 0.5;
      const alignY = align.endsWith("YMin") ? 0 : align.endsWith("YMax") ? 1 : 0.5;
      left = rect.left + spareX * alignX - minX * scale;
      top = rect.top + spareY * alignY - minY * scale;
    }
    return { transform: [scaleX, 0, 0, scaleY, left, top], viewport: { width: viewWidth, height: viewHeight } };
  }

  const SHAPE_GEOMETRY = {
    path: ["d"],
    line: ["x1", "y1", "x2", "y2"],
    rect: ["x", "y", "width", "height", "rx", "ry"],
    polygon: ["points"],
    polyline: ["points"],
    circle: ["cx", "cy", "r"],
    ellipse: ["cx", "cy", "rx", "ry"],
  };

  /** One of KaTeX's SVG shapes with its paint written out and its lengths resolved. */
  function svgShape(shape, placement) {
    const tag = shape.tagName.toLowerCase();
    const style = getComputedStyle(shape);
    if (style.display === "none" || style.visibility === "hidden") return "";
    const fontSize = px(style.fontSize);
    const resolve = (name, value) => {
      if (name === "d" || name === "points") return value;
      const number = Number.parseFloat(value);
      if (!Number.isFinite(number)) return null;
      if (/%$/.test(value)) {
        const across = /^(x|x1|x2|cx|width|rx)$/.test(name) ? placement.viewport.width : /^(y|y1|y2|cy|height|ry)$/.test(name) ? placement.viewport.height : Math.hypot(placement.viewport.width, placement.viewport.height) / Math.SQRT2;
        return String(round((number / 100) * across));
      }
      if (/em$/.test(value)) return String(round(number * fontSize));
      return String(number);
    };
    let out = `<${tag}`;
    for (const name of SHAPE_GEOMETRY[tag] || []) {
      const value = shape.getAttribute(name);
      if (value === null) continue;
      const resolved = resolve(name, value);
      if (resolved !== null) out += ` ${name}="${escapeAttribute(resolved)}"`;
    }
    const fill = style.fill;
    const stroke = style.stroke;
    out += ` fill="${escapeAttribute(fill === "none" || transparent(fill) ? "none" : fill)}"`;
    if (stroke && stroke !== "none" && !transparent(stroke)) {
      const strokeWidth = shape.getAttribute("stroke-width");
      const width = strokeWidth ? resolve("stroke-width", strokeWidth) : String(px(style.strokeWidth));
      out += ` stroke="${escapeAttribute(stroke)}" stroke-width="${escapeAttribute(width || "0")}"`;
    }
    if (shape.getAttribute("fill-rule")) out += ` fill-rule="${escapeAttribute(shape.getAttribute("fill-rule"))}"`;
    return `${out}/>`;
  }

  // ---- Diagrams ------------------------------------------------------------------

  // What a shape or a text keeps of its computed style, written as attributes.
  const PAINT = [
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
  ];
  const TYPE = ["font-size", "font-weight", "font-style", "text-anchor", "letter-spacing"];
  const MARKERS = ["marker-start", "marker-mid", "marker-end"];
  // What SVG (and react-native-svg) assume when an attribute is not given.
  const INITIAL = {
    "fill-opacity": "1",
    "fill-rule": "nonzero",
    "stroke-opacity": "1",
    "stroke-dashoffset": "0",
    "stroke-linecap": "butt",
    "stroke-linejoin": "miter",
    "stroke-miterlimit": "4",
    "font-style": "normal",
    "font-weight": "400",
    "text-anchor": "start",
    stroke: "none",
  };
  const SHAPES = new Set(["path", "rect", "circle", "ellipse", "line", "polyline", "polygon", "text", "tspan"]);
  const LENGTHS = ["x", "y", "dx", "dy"];

  function diagramConfig(job) {
    return {
      startOnLoad: false,
      // Labels sanitised, click handlers and links refused.
      securityLevel: "strict",
      // Labels as SVG text: the phone has no foreignObject to hold HTML in.
      htmlLabels: false,
      flowchart: { htmlLabels: false },
      // Settings a diagram's own `%%{init}%%` or front matter may not
      // change: Mermaid's own list (`secure` replaces it), then HTML labels,
      // and everything written into the diagram's stylesheet while it is
      // measured (its CSS, its theme's values, and the fonts a directive
      // copies into them), how labels are sanitised, and markers drawn as
      // absolute URLs. The desktop's list.
      secure: [
        "secure",
        "securityLevel",
        "startOnLoad",
        "maxTextSize",
        "suppressErrorRendering",
        "maxEdges",
        "htmlLabels",
        "themeCSS",
        "themeVariables",
        "fontFamily",
        "altFontFamily",
        "dompurifyConfig",
        "arrowMarkerAbsolute",
      ],
      theme: "base",
      themeVariables: { ...job.theme, fontFamily: job.fontFamily, fontSize: `${job.fontSize}px` },
      fontFamily: job.fontFamily,
      // A diagram that does not parse is reported back; Mermaid must not
      // draw its own error graphic in its place.
      suppressErrorRendering: true,
      maxTextSize: 50000,
      maxEdges: 500,
    };
  }

  let serial = 0;

  async function drawDiagram(job) {
    mermaid.initialize(diagramConfig(job));
    const id = `diagram${++serial}`;
    try {
      // Parse first: a syntax error then throws before anything is laid out.
      await mermaid.parse(job.source);
      const { svg: markup } = await mermaid.render(id, job.source);
      const holder = document.createElement("div");
      holder.className = "diagram";
      holder.innerHTML = markup;
      stage.appendChild(holder);
      const svg = holder.querySelector("svg");
      if (!svg) throw new Error("The diagram drew nothing");
      return flattenDiagram(svg, job);
    } finally {
      const scratch = document.getElementById(`d${id}`);
      if (scratch) scratch.remove();
    }
  }

  function flattenDiagram(svg, job) {
    const box = (svg.getAttribute("viewBox") || "").trim().split(/[\s,]+/).map(Number);
    let width;
    let height;
    if (box.length === 4 && box.every(Number.isFinite) && box[2] > 0 && box[3] > 0) {
      width = box[2];
      height = box[3];
    } else {
      const extent = svg.getBBox();
      width = extent.width;
      height = extent.height;
      svg.setAttribute("viewBox", `${extent.x} ${extent.y} ${extent.width} ${extent.height}`);
    }

    const elements = [...svg.querySelectorAll("*")];
    const removed = [];
    const written = new Map();
    for (const element of elements) {
      const tag = element.tagName.toLowerCase();
      const style = getComputedStyle(element);
      if (tag !== "marker" && !element.closest("defs, marker, clipPath") && style.display === "none") {
        removed.push(element);
        continue;
      }
      const attributes = {};
      if (SHAPES.has(tag)) {
        for (const name of PAINT) attributes[name] = style.getPropertyValue(name);
        for (const name of MARKERS) attributes[name] = style.getPropertyValue(name);
        if (tag === "text" || tag === "tspan") {
          for (const name of TYPE) attributes[name] = style.getPropertyValue(name);
          const fontSize = px(style.fontSize);
          for (const name of LENGTHS) {
            const value = element.getAttribute(name);
            if (value && /em\b/.test(value)) {
              element.setAttribute(
                name,
                value
                  .split(/[\s,]+/)
                  .map((part) => (/em$/.test(part) ? String(round(Number.parseFloat(part) * fontSize)) : part))
                  .join(" "),
              );
            }
          }
        }
      }
      const opacity = style.getPropertyValue("opacity");
      if (opacity && opacity !== "1") attributes.opacity = opacity;
      // An edge label's box. Mermaid draws an SVG label's at half opacity,
      // where an HTML label's (the desktop's) is solid, so the edge's line
      // ran through the label. It is solid here, in the theme's colour for it.
      if (tag === "rect" && element.closest(".edgeLabel")) {
        attributes.fill = job.theme.edgeLabelBackground || attributes.fill;
        delete attributes.opacity;
      }
      if (style.visibility === "hidden" && SHAPES.has(tag)) attributes.visibility = "hidden";
      written.set(element, attributes);
    }

    // Baselines react-native-svg does not place (`central`, `middle`,
    // `hanging`) become an offset: the text is measured as the page set it
    // and again on its alphabetic baseline, and moved by the difference.
    for (const text of svg.querySelectorAll("text")) {
      let before;
      try {
        before = text.getBBox();
      } catch {
        continue;
      }
      const targets = [text, ...text.querySelectorAll("tspan")];
      for (const target of targets) {
        target.style.setProperty("dominant-baseline", "alphabetic", "important");
        target.style.setProperty("alignment-baseline", "baseline", "important");
        target.removeAttribute("dominant-baseline");
        target.removeAttribute("alignment-baseline");
      }
      const after = text.getBBox();
      const shift = before.y - after.y;
      if (Math.abs(shift) > 0.01) {
        const transform = text.getAttribute("transform");
        text.setAttribute("transform", `${transform ? `${transform} ` : ""}translate(0 ${round(shift)})`);
      }
    }

    for (const element of removed) element.remove();
    for (const [element, attributes] of written) {
      if (!element.isConnected) continue;
      const tag = element.tagName.toLowerCase();
      // Containers lose their own paint: every shape and text now says what
      // it wears, so nothing is left to inherit but a group's opacity.
      if (!SHAPES.has(tag)) {
        for (const name of [...PAINT, ...TYPE, ...MARKERS, "font-family"]) element.removeAttribute(name);
      }
      // A tspan inherits from its text, everything else from nothing: a
      // value that is what it would inherit anyway is left unsaid.
      const inherited = tag === "tspan" ? written.get(element.parentElement) || {} : null;
      for (const [name, raw] of Object.entries(attributes)) {
        const value = normaliseValue(name, raw);
        const implied = inherited ? (inherited[name] === undefined ? null : normaliseValue(name, inherited[name])) : INITIAL[name];
        if (value === null || (implied !== undefined && value === implied && name !== "fill" && name !== "font-size")) element.removeAttribute(name);
        else element.setAttribute(name, value);
      }
      if (element.tagName.toLowerCase() === "text" || element.tagName.toLowerCase() === "tspan") {
        element.setAttribute("font-family", job.fontFamily);
      }
      element.removeAttribute("style");
      element.removeAttribute("class");
    }
    // With SVG labels Mermaid leaves a label's entities (`#amp;` as "&amp;")
    // escaped in its text, where an HTML label would show the character.
    // A textarea reads entities and nothing else: no markup comes of it.
    const decoder = document.createElement("textarea");
    const labels = document.createTreeWalker(svg, NodeFilter.SHOW_TEXT);
    for (let node = labels.nextNode(); node; node = labels.nextNode()) {
      if (!node.nodeValue || !node.nodeValue.includes("&")) continue;
      decoder.innerHTML = node.nodeValue.replace(/</g, "&lt;");
      node.nodeValue = decoder.value;
    }
    for (const sheet of svg.querySelectorAll("style")) sheet.remove();
    svg.removeAttribute("style");
    svg.removeAttribute("class");
    svg.setAttribute("width", String(round(width)));
    svg.setAttribute("height", String(round(height)));
    return { svg: new XMLSerializer().serializeToString(svg), width: round(width), height: round(height) };
  }

  /** A computed value as an attribute takes it: units dropped, defaults left out. */
  function normaliseValue(name, raw) {
    const value = String(raw || "").trim();
    if (!value || (value === "normal" && name !== "font-style" && name !== "font-weight")) return null;
    if (MARKERS.includes(name)) {
      if (value === "none") return null;
      const match = /^url\(\s*["']?(#[^"')]+)["']?\s*\)$/.exec(value);
      return match ? `url(${match[1]})` : null;
    }
    if (name === "stroke-dasharray") return value === "none" ? null : value.replace(/px/g, "").replace(/,\s*/g, " ");
    if (/^(stroke-width|stroke-dashoffset|font-size|letter-spacing|stroke-miterlimit)$/.test(name)) {
      const number = Number.parseFloat(value);
      return Number.isFinite(number) ? String(round(number)) : null;
    }
    if (name === "fill" || name === "stroke") {
      const match = /^url\(\s*["']?(#[^"')]+)["']?\s*\)/.exec(value);
      if (match) return `url(${match[1]})`;
      return /url\(/i.test(value) ? null : value;
    }
    return value;
  }

  // ---- Jobs ------------------------------------------------------------------------

  let queue = Promise.resolve();

  async function run(job) {
    try {
      const drawn = job.kind === "mermaid" ? await drawDiagram(job) : await drawFormula(job);
      send({ type: "result", id: job.id, svg: drawn.svg, width: drawn.width, height: drawn.height });
    } catch (error) {
      send({ type: "error", id: job.id, message: messageOf(error) });
    } finally {
      stage.textContent = "";
    }
  }

  window.__richRender = (job) => {
    queue = queue.then(() => run(job));
  };

  send({ type: "ready" });
})();
