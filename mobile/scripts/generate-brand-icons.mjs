#!/usr/bin/env node
// Cuts every launcher icon and the in-app mark from the SprintEngine se mark.
//
//   node scripts/generate-brand-icons.mjs      (or: npm run brand:icons)
//
// The phone wears the same mark as SprintEngine Studio's Mac icon:
// lowercase "se" on the near-black card, the "s" in paper and the
// "e" in the brand green. The mark is not drawn here, because text needs a font
// rasteriser this script deliberately does without. It is read from
// scripts/brand/sprintengine-se-mark-1024.png, a byte-for-byte copy of the
// desktop's committed master (resources/brand/ in the desktop repo), exported
// from sprintengine-se-mark.source.html beside it. To move the mark, replace
// that master with the desktop's and run this again; never edit an output.
//
// The master is RGB, with the card's rounded corners sitting on the source
// page's #888. Every output re-cuts the silhouette the way the desktop's own
// icon generator does: coverage is supersampled 4x, fully covered pixels keep
// the master's colour, boundary pixels take the card colour at partial alpha,
// and outside is transparent, so no grey survives into a corner. Sizes are
// area-averaged from the master in premultiplied alpha, which keeps edges clean
// at sizes that do not divide 1024 evenly.
//
// Outputs (all committed):
//
//   iOS  ios/SprintEngine/Images.xcassets/AppIcon.appiconset/App-Icon-1024x1024@1x.png
//        Full-bleed square, RGB with no alpha channel. iOS applies its own
//        corner mask, and App Store Connect rejects an icon with transparency,
//        so the card fills the square and the #888 corners become card.
//   Android  android/app/src/main/res/mipmap-<density>/
//        ic_launcher.png             the rounded card, as on the Mac (API < 26)
//        ic_launcher_round.png       the card clipped to a circle (API < 26)
//        ic_launcher_foreground.png  the adaptive icon's foreground: the glyphs
//                                    alone on transparency, see FOREGROUND below
//        The adaptive background is the card colour, @color/ic_launcher_background
//        in res/values/colors.xml, which must stay equal to CARD_HEX.
//   App  src/assets/brand/se-mark{,@2x,@3x}.png — the rounded card at 128pt, the
//        mark the welcome screen draws.
//   Expo mirrors (inert while ios/ and android/ are checked in, kept honest):
//        src/assets/brand/app-icon.png, android-adaptive-foreground.png.

import { Buffer } from 'node:buffer'
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, join, relative } from 'node:path'
import { fileURLToPath } from 'node:url'

import { decodePNG, encodePNG } from './brand/png.mjs'

const repoRoot = fileURLToPath(new URL('..', import.meta.url))
const MASTER = join(repoRoot, 'scripts/brand/sprintengine-se-mark-1024.png')
const RES = join(repoRoot, 'android/app/src/main/res')
const IOS_ICON = join(repoRoot, 'ios/SprintEngine/Images.xcassets/AppIcon.appiconset/App-Icon-1024x1024@1x.png')
const BRAND = join(repoRoot, 'src/assets/brand')

// The card, `#0c0c10` (ref ink-900) in the mark's source HTML, and the two inks
// the letters are set in. Boundary pixels are painted with CARD rather than the
// master's own, whose corner anti-aliasing is blended toward the page's #888.
const CARD = [0x0c, 0x0c, 0x10]
const CARD_HEX = '#0c0c10'
const PAPER_INK = [0xec, 0xec, 0xec] // the "s", paper-100
const GREEN_INK = [0x3f, 0x94, 0x68] // the "e", green-500
const RADIUS_RATIO = 236 / 1024 // border-radius from the mark's source HTML
const SS = 4 // coverage supersampling

// FOREGROUND. An adaptive icon is a 108dp square of which launchers show at most
// the central 72dp, masked to a shape of their choosing, and only the central
// 66dp circle is guaranteed to survive every mask. The Mac icon's card maps onto
// that visible 72dp: the glyphs keep exactly the size and position they have on
// the Mac card, and their bounding box sits well inside the 66dp circle (its far
// corner is ~24dp from centre), so no launcher mask can clip them.
const ADAPTIVE_CANVAS_DP = 108
const ADAPTIVE_VISIBLE_DP = 72

const DENSITIES = { mdpi: 1, hdpi: 1.5, xhdpi: 2, xxhdpi: 3, xxxhdpi: 4 }
const LEGACY_DP = 48

// ── Geometry ────────────────────────────────────────────────────────────────

function inRoundedRect(x, y, n, r) {
  if (x < 0 || x > n || y < 0 || y > n) return false
  const cx = x < r ? r : x > n - r ? n - r : x
  const cy = y < r ? r : y > n - r ? n - r : y
  return (x - cx) ** 2 + (y - cy) ** 2 <= r * r
}

function inCircle(x, y, n) {
  const h = n / 2
  return (x - h) ** 2 + (y - h) ** 2 <= h * h
}

/** Fraction of pixel (x, y) that `inside` covers, supersampled SS×SS. */
function coverage(x, y, inside) {
  let covered = 0
  for (let sy = 0; sy < SS; sy++) {
    for (let sx = 0; sx < SS; sx++) {
      if (inside(x + (sx + 0.5) / SS, y + (sy + 0.5) / SS)) covered++
    }
  }
  return covered / (SS * SS)
}

// ── Layers ──────────────────────────────────────────────────────────────────
// A layer is a square of premultiplied RGBA floats: colour channels 0–255
// already multiplied by alpha, alpha 0–1.

function readMaster() {
  const { width, height, bpp, pixels } = decodePNG(readFileSync(MASTER))
  if (width !== height) throw new Error(`master must be square, got ${width}x${height}`)
  const n = width
  const rgb = new Float32Array(n * n * 3)
  for (let i = 0; i < n * n; i++) {
    for (let c = 0; c < 3; c++) rgb[i * 3 + c] = pixels[i * bpp + c]
  }
  const radius = RADIUS_RATIO * n
  // Whether a pixel lies wholly on the card, where the master can be trusted.
  const onCard = new Uint8Array(n * n)
  for (let y = 0; y < n; y++) {
    for (let x = 0; x < n; x++) {
      onCard[y * n + x] = coverage(x, y, (px, py) => inRoundedRect(px, py, n, radius)) === 1 ? 1 : 0
    }
  }
  return { n, rgb, onCard, radius }
}

/**
 * The master cut to a silhouette. Pixels the silhouette wholly covers keep the
 * master's colour (off the card they take CARD, so the #888 page never shows);
 * boundary pixels are CARD at partial alpha. `inside` of null is the full square.
 */
function cardLayer(master, inside) {
  const { n, rgb, onCard } = master
  const out = new Float32Array(n * n * 4)
  for (let y = 0; y < n; y++) {
    for (let x = 0; x < n; x++) {
      const i = y * n + x
      const a = inside ? coverage(x, y, inside) : 1
      if (a === 0) continue
      const colour = a === 1 && onCard[i] ? [rgb[i * 3], rgb[i * 3 + 1], rgb[i * 3 + 2]] : CARD
      for (let c = 0; c < 3; c++) out[i * 4 + c] = colour[c] * a
      out[i * 4 + 3] = a
    }
  }
  return { size: n, px: out }
}

/**
 * The letters alone, lifted off the card. Each master pixel is the card with
 * some share of each ink laid over it: pixel = card + p·(paper − card) +
 * g·(green − card). Solving for p and g (least squares over the three channels)
 * recovers both shares, including at the seam where the "s" meets the "e", so
 * the glyphs come out with their anti-aliasing intact and no card fringe.
 */
function glyphLayer(master) {
  const { n, rgb, onCard } = master
  const u = PAPER_INK.map((v, c) => v - CARD[c])
  const v = GREEN_INK.map((w, c) => w - CARD[c])
  const uu = u.reduce((s, x) => s + x * x, 0)
  const vv = v.reduce((s, x) => s + x * x, 0)
  const uv = u.reduce((s, x, c) => s + x * v[c], 0)
  const det = uu * vv - uv * uv
  const out = new Float32Array(n * n * 4)
  let worst = 0
  for (let i = 0; i < n * n; i++) {
    if (!onCard[i]) continue
    const d = [0, 1, 2].map((c) => rgb[i * 3 + c] - CARD[c])
    if (d[0] === 0 && d[1] === 0 && d[2] === 0) continue
    const du = d.reduce((s, x, c) => s + x * u[c], 0)
    const dv = d.reduce((s, x, c) => s + x * v[c], 0)
    let p = Math.max(0, (du * vv - dv * uv) / det)
    let g = Math.max(0, (dv * uu - du * uv) / det)
    const total = p + g
    if (total > 1) {
      p /= total
      g /= total
    }
    const a = p + g
    if (a === 0) continue
    for (let c = 0; c < 3; c++) {
      out[i * 4 + c] = p * PAPER_INK[c] + g * GREEN_INK[c]
      worst = Math.max(worst, Math.abs(CARD[c] + p * u[c] + g * v[c] - rgb[i * 3 + c]))
    }
    out[i * 4 + 3] = a
  }
  // The unmixing is exact for a master that really is two inks on the card; a
  // large residual means the master changed shape and the inks above are stale.
  if (worst > 12) throw new Error(`glyph unmixing residual ${worst.toFixed(1)}: the inks no longer match the master`)
  return { size: n, px: out }
}

/** `layer` centred on a transparent square `canvas` pixels wide. */
function padLayer(layer, canvas) {
  const off = Math.round((canvas - layer.size) / 2)
  const out = new Float32Array(canvas * canvas * 4)
  for (let y = 0; y < layer.size; y++) {
    out.set(layer.px.subarray(y * layer.size * 4, (y + 1) * layer.size * 4), ((y + off) * canvas + off) * 4)
  }
  return { size: canvas, px: out }
}

/** Area-average `layer` down to `size`, returning straight 8-bit RGBA. */
function resample(layer, size) {
  const { size: n, px } = layer
  const scale = n / size
  const out = Buffer.alloc(size * size * 4)
  for (let y = 0; y < size; y++) {
    const y0 = y * scale
    const y1 = (y + 1) * scale
    for (let x = 0; x < size; x++) {
      const x0 = x * scale
      const x1 = (x + 1) * scale
      let r = 0
      let g = 0
      let b = 0
      let a = 0
      let w = 0
      for (let sy = Math.floor(y0); sy < Math.ceil(y1); sy++) {
        const wy = Math.min(y1, sy + 1) - Math.max(y0, sy)
        for (let sx = Math.floor(x0); sx < Math.ceil(x1); sx++) {
          const wt = (Math.min(x1, sx + 1) - Math.max(x0, sx)) * wy
          if (wt <= 0) continue
          const o = (sy * n + sx) * 4
          r += px[o] * wt
          g += px[o + 1] * wt
          b += px[o + 2] * wt
          a += px[o + 3] * wt
          w += wt
        }
      }
      const o = (y * size + x) * 4
      if (a <= 0) continue
      out[o] = Math.round(r / a)
      out[o + 1] = Math.round(g / a)
      out[o + 2] = Math.round(b / a)
      out[o + 3] = Math.round((a / w) * 255)
    }
  }
  return out
}

// ── Writing ─────────────────────────────────────────────────────────────────

function write(file, layer, size, { opaque = false } = {}) {
  const rgba = resample(layer, size)
  let png
  if (opaque) {
    const rgb = Buffer.alloc(size * size * 3)
    for (let i = 0; i < size * size; i++) {
      if (rgba[i * 4 + 3] !== 255) throw new Error(`${relative(repoRoot, file)} must be opaque`)
      rgba.copy(rgb, i * 3, i * 4, i * 4 + 3)
    }
    png = encodePNG(size, size, rgb, { channels: 3 })
  } else {
    png = encodePNG(size, size, rgba, { channels: 4 })
  }
  mkdirSync(dirname(file), { recursive: true })
  writeFileSync(file, png)
  process.stdout.write(`  ${relative(repoRoot, file)}  (${size}x${size}${opaque ? ', no alpha' : ''})\n`)
}

function main() {
  process.stdout.write(`Cutting icons from ${relative(repoRoot, MASTER)}\n`)
  const master = readMaster()
  const { n, radius } = master

  const square = cardLayer(master, null)
  const rounded = cardLayer(master, (x, y) => inRoundedRect(x, y, n, radius))
  const round = cardLayer(master, (x, y) => inCircle(x, y, n))
  const foreground = padLayer(glyphLayer(master), Math.round((n * ADAPTIVE_CANVAS_DP) / ADAPTIVE_VISIBLE_DP))

  write(IOS_ICON, square, 1024, { opaque: true })

  for (const [density, factor] of Object.entries(DENSITIES)) {
    const dir = join(RES, `mipmap-${density}`)
    write(join(dir, 'ic_launcher.png'), rounded, LEGACY_DP * factor)
    write(join(dir, 'ic_launcher_round.png'), round, LEGACY_DP * factor)
    write(join(dir, 'ic_launcher_foreground.png'), foreground, ADAPTIVE_CANVAS_DP * factor)
  }

  for (const [suffix, factor] of [['', 1], ['@2x', 2], ['@3x', 3]]) {
    write(join(BRAND, `se-mark${suffix}.png`), rounded, 128 * factor)
  }

  write(join(BRAND, 'app-icon.png'), square, 1024, { opaque: true })
  write(join(BRAND, 'android-adaptive-foreground.png'), foreground, 1024)

  const colors = readFileSync(join(RES, 'values/colors.xml'), 'utf8')
  if (!colors.includes(`<color name="ic_launcher_background">${CARD_HEX}</color>`)) {
    throw new Error(`res/values/colors.xml: ic_launcher_background must be ${CARD_HEX}, the card the glyphs sit on`)
  }
  process.stdout.write('Done.\n')
}

main()
