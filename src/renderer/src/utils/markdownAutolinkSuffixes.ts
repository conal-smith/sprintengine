// A bare web address keeps the underscores and tildes it ends with.
//
// GFM's autolink literal leaves a trailing `_` or `~` out of the link, so
// `https://x.com/name_` linked to `https://x.com/name` and the `_` trailed it
// as text. Addresses like that are common in replies. Only a bare address is
// extended: its source must read exactly as its label, so a `[label](url)`,
// an `<url>` autolink, a reference or an emphasised `_url_` reads as before.

// The slices of the syntax tree this pass touches. Declared here, as the other
// passes declare theirs: the packages that own the real types are reached only
// through remark.
type Point = { line: number; column: number; offset?: number }
type Position = { start: Point; end: Point }
type AutolinkNode = {
  type: string
  url?: string
  value?: string
  children?: AutolinkNode[]
  position?: Position
}

export function remarkKeepAutolinkSuffixes() {
  return (tree: AutolinkNode, file: { toString(): string }) => {
    const source = String(file)
    const visit = (node: AutolinkNode) => {
      const children = node.children
      if (!children || node.type === 'link' || node.type === 'linkReference') return
      for (let index = 0; index < children.length; index++) {
        const child = children[index]
        const next = children[index + 1]
        if (child.type === 'link' && /^https?:\/\//iu.test(child.url ?? '') && next?.type === 'text') {
          const suffix = /^[_~]+/u.exec(next.value ?? '')?.[0]
          const label = child.children?.length === 1 ? child.children[0] : undefined
          if (
            suffix &&
            label?.type === 'text' &&
            label.value !== undefined &&
            (label.value === child.url || `http://${label.value}` === child.url)
          ) {
            const start = child.position?.start.offset
            const end = child.position?.end.offset
            const bare =
              !child.position ||
              (start !== undefined &&
                end !== undefined &&
                source.slice(start, end) === label.value &&
                source.slice(end, end + suffix.length) === suffix)
            if (bare) {
              child.url += suffix
              label.value += suffix
              next.value = next.value!.slice(suffix.length)
              if (child.position && end !== undefined) {
                const boundary = {
                  ...child.position.end,
                  column: child.position.end.column + suffix.length,
                  offset: end + suffix.length,
                }
                child.position.end = boundary
                if (label.position) label.position.end = boundary
                if (next.position) next.position.start = boundary
              }
              if (!next.value) children.splice(index + 1, 1)
            }
          }
        }
        visit(child)
      }
    }
    visit(tree)
  }
}
