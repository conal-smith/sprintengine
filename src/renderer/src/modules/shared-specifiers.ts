import { parse } from 'es-module-lexer/js'

// A trusted module's renderer bundle imports the app's React (and the SDK's UI
// kit) by bare name: `import { useState } from 'react'`. Those names are bound
// to the app's own instances by rewriting each such specifier in the bundle to
// the URL of a shim module the loader made (third-party-loader.ts), before the
// bundle is imported. An import map would say the same thing, but it is an
// inline script, which the app window's Content-Security-Policy does not run.
//
// The lexer is the JavaScript build, not the WebAssembly one, so it is ready
// at once and needs nothing of the policy. It reads the bundle's real import
// statements and `import()` calls, so a string that only looks like one is
// left alone.

/** The bundle with every import of a name in `urls` pointed at that URL. */
export function bindSharedSpecifiers(code: string, urls: Readonly<Record<string, string>>): string {
  const [imports] = parse(code)
  let out = ''
  let last = 0
  for (const entry of imports) {
    const name = entry.n
    if (name === undefined || !Object.prototype.hasOwnProperty.call(urls, name)) continue
    const url = urls[name]!
    const written = code.slice(entry.s, entry.e)
    // A static import's range is the specifier inside its quotes; a dynamic
    // one's is the whole argument, quotes included.
    const quoted = /^(['"`]).*\1$/s.test(written)
    if (!quoted && written !== name) continue
    out += code.slice(last, entry.s) + (quoted ? JSON.stringify(url) : url)
    last = entry.e
  }
  return out + code.slice(last)
}
