import tokensCss from '../../../design-system/foundations/tokens.css?raw'

// The design system's light tokens, for the exports. The PDF page carries the
// token sheet whole and reads its `--sem-*` names; what cannot read a custom
// property (a Word document, a pasted email, the PDF's footer, which Chromium
// draws as a document of its own) takes a token's value from here, so no
// export spells a colour of its own.

export { tokensCss }

/** A token's light value, followed through the `var()`s it is made of. */
export function lightTokenValue(name: string, css: string = tokensCss): string | null {
  const root = /:root\s*\{([^}]*)\}/u.exec(css)?.[1] ?? ''
  const values = new Map<string, string>()
  for (const match of root.matchAll(/(--[\w-]+)\s*:\s*([^;]+);/gu)) values.set(match[1]!, match[2]!.trim())
  let value = values.get(name)
  for (let depth = 0; value && depth < 8; depth += 1) {
    const reference = /^var\((--[\w-]+)\)$/u.exec(value)
    if (!reference) return value
    value = values.get(reference[1]!)
  }
  return null
}

/** A colour token as six hex digits, a translucent one laid on the white it is printed on. */
export function solidTokenColor(name: string, css: string = tokensCss): string {
  const value = lightTokenValue(name, css)
  const hex = value ? /^#([0-9a-f]{6})$/iu.exec(value) : null
  if (hex) return hex[1]!.toUpperCase()
  const short = value ? /^#([0-9a-f])([0-9a-f])([0-9a-f])$/iu.exec(value) : null
  if (short) return `${short[1]}${short[1]}${short[2]}${short[2]}${short[3]}${short[3]}`.toUpperCase()
  const rgba = value ? /^rgba?\(\s*(\d+)\s*,\s*(\d+)\s*,\s*(\d+)\s*(?:,\s*([\d.]+)\s*)?\)$/iu.exec(value) : null
  if (!rgba) throw new Error(`${name} is not a colour the exports can write.`)
  const alpha = rgba[4] === undefined ? 1 : Number(rgba[4])
  return [rgba[1], rgba[2], rgba[3]]
    .map((channel) => Math.round(Number(channel) * alpha + 255 * (1 - alpha)))
    .map((channel) => channel.toString(16).padStart(2, '0'))
    .join('')
    .toUpperCase()
}

/** The colours an export writes, as six hex digits each. */
export type ExportPalette = {
  text: string
  strong: string
  muted: string
  accent: string
  danger: string
  well: string
  border: string
  surface: string
}

export function exportPalette(): ExportPalette {
  return {
    surface: solidTokenColor('--sem-color-bg-surface'),
    text: solidTokenColor('--sem-color-text-default'),
    strong: solidTokenColor('--sem-color-text-primary'),
    muted: solidTokenColor('--sem-color-text-muted'),
    accent: solidTokenColor('--sem-color-accent-primary'),
    danger: solidTokenColor('--sem-color-status-danger'),
    well: solidTokenColor('--sem-color-bg-well'),
    border: solidTokenColor('--sem-color-border-default'),
  }
}
