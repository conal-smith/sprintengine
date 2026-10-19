// A Windows path as a link or image destination, kept as it was written.
//
// Markdown reads a backslash before punctuation as an escape, inside a link
// destination too, so `[settings](C:\Users\me\.claude\settings.json)` parsed
// to `C:\Users\me.claude\settings.json`, and an image path lost every `\.` and
// `\_` the same way. Agents on Windows write paths exactly like that. And a
// destination that survived the parse was then URL-encoded on its way to
// HTML, every `\` turning into `%5C`, which names no file either. So a
// destination whose source is a Windows absolute path (a drive or a UNC share)
// keeps its source text, and that text is what the link or image is handed.
// A web address, or anything else, parses exactly as before. A character
// reference (`&amp;`) is the one escape a path could mean, so a destination
// holding `&` keeps the parsed value.
//
// The same escape ate backslashes in prose: `Saved to C:\Users\me\.t3\_build`
// read `C:\Users\me.t3_build`. An escape inside a drive path keeps its
// backslash too. A prose path ends at whitespace, since past that nothing tells
// a path from a sentence, and `C:\x and \*this\*` still reads `*this*`.

const WINDOWS_PATH = /^(?:[A-Za-z]:[\\/]|\\\\)/u

// A drive path that has not reached whitespace yet: `C:`, `C:\Users\me`, `C:/work`.
const UNFINISHED_DRIVE_PATH = /(?:^|\W)[A-Za-z]:(?:[\\/]\S*)?$/u

// The slices of the parser's context and of the syntax tree this pass touches.
// Declared here, as the other passes declare theirs: the packages that own the
// real types are reached only through remark.
type PathNode = {
  type: string
  url?: string
  identifier?: string
  children?: PathNode[]
  data?: { hProperties?: Record<string, unknown> }
}

type TextNode = { type: string; value?: string }

type CompileContext = {
  resume(): string
  sliceSerialize(token: unknown): string
  stack: PathNode[]
}

function keepWindowsPath(this: CompileContext, token: unknown): void {
  const parsed = this.resume()
  const source = this.sliceSerialize(token)
  const node = this.stack[this.stack.length - 1]
  node.url = WINDOWS_PATH.test(source) && !source.includes('&') ? source : parsed
}

// By the time an escape exits, its character has been appended to the text
// before it, with the backslash dropped; put the backslash back when that text
// is part-way through a drive path.
function keepWindowsPathEscape(this: CompileContext): void {
  const siblings = this.stack[this.stack.length - 1]?.children as TextNode[] | undefined
  const text = siblings?.[siblings.length - 1]
  if (text?.type !== 'text' || text.value === undefined) return
  const before = text.value.slice(0, -1)
  if (UNFINISHED_DRIVE_PATH.test(before)) text.value = `${before}\\${text.value.slice(-1)}`
}

// The HTML a link becomes carries its URL percent-encoded; a path's own
// characters are set on the element instead, so the link sees the path.
function pin(node: PathNode, url: string): void {
  const key = node.type === 'image' || node.type === 'imageReference' ? 'src' : 'href'
  node.data = { ...node.data, hProperties: { ...node.data?.hProperties, [key]: url } }
}

function collectDefinitions(node: PathNode, definitions: Map<string, string>): void {
  if (node.type === 'definition' && node.identifier && node.url && WINDOWS_PATH.test(node.url)) {
    if (!definitions.has(node.identifier)) definitions.set(node.identifier, node.url)
  }
  for (const child of node.children ?? []) collectDefinitions(child, definitions)
}

function pinPaths(node: PathNode, definitions: Map<string, string>): void {
  if ((node.type === 'link' || node.type === 'image') && node.url && WINDOWS_PATH.test(node.url)) pin(node, node.url)
  if ((node.type === 'linkReference' || node.type === 'imageReference') && node.identifier) {
    const url = definitions.get(node.identifier)
    if (url) pin(node, url)
  }
  for (const child of node.children ?? []) pinPaths(child, definitions)
}

/** Remark plugin: Windows path destinations, and drive paths in prose, read as written. */
export function remarkWindowsPaths(this: { data(): object }) {
  const data = this.data() as { fromMarkdownExtensions?: unknown[] }
  data.fromMarkdownExtensions ??= []
  data.fromMarkdownExtensions.push({
    exit: {
      resourceDestinationString: keepWindowsPath,
      definitionDestinationString: keepWindowsPath,
      characterEscape: keepWindowsPathEscape,
    },
  })
  return (tree: PathNode) => {
    const definitions = new Map<string, string>()
    collectDefinitions(tree, definitions)
    pinPaths(tree, definitions)
  }
}
