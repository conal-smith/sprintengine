// The design system's token sheet as text, which Vite inlines at build time
// (`?raw`): an exported chat's PDF page carries it whole. Main's types have no
// `?raw` of their own; the renderer's come from `vite/client`.
declare module '*/tokens.css?raw' {
  const css: string
  export default css
}
