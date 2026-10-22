// Credential-shaped text taken out of a line before it is kept anywhere a
// person did not choose to keep a secret: the diagnostics log, which goes into
// bug reports and log collectors. The callers redact what they know is
// sensitive; this is the pass that catches what one of them did not.

const REDACTED = '[redacted]'

// Tokens recognisable by their own prefix, whatever surrounds them.
const PREFIXED_TOKENS: readonly RegExp[] = [
  // Studio's own tailnet device and pairing tokens.
  /\b(?:mctn|mcpair)_[A-Za-z0-9_-]{8,}/gu,
  // GitHub personal, OAuth, user-to-server, server-to-server and refresh tokens.
  /\bgh[pousr]_[A-Za-z0-9]{20,}/gu,
  /\bgithub_pat_[A-Za-z0-9_]{20,}/gu,
  // API keys in the `sk-…` shape several model providers use.
  /\bsk-[A-Za-z0-9_-]{16,}/gu,
  // Slack bot, user, app and refresh tokens.
  /\bxox[abeoprs]-[A-Za-z0-9-]{10,}/gu,
]

/** `text` with every credential-shaped run in it replaced by `[redacted]`. */
export function redactSecrets(text: string): string {
  let out = text
  for (const pattern of PREFIXED_TOKENS) out = out.replace(pattern, REDACTED)
  return (
    out
      // An authorization scheme and its credential. A Basic credential is
      // base64, so a word of letters after it ("Basic authentication") is prose.
      .replace(/\bBearer\s+[A-Za-z0-9._~+/=-]{8,}/giu, `Bearer ${REDACTED}`)
      .replace(/\bBasic\s+(?=[A-Za-z]*[0-9+/=])[A-Za-z0-9+/]{8,}={0,2}/gu, `Basic ${REDACTED}`)
      // A password in a URL's userinfo: `https://user:pass@host`.
      .replace(/\b([a-z][a-z0-9+.-]*:\/\/)[^\s/@:]+:[^\s/@]+@/giu, `$1${REDACTED}@`)
      // `token=…`, `"api_key": "…"`, `password: …` and the like.
      .replace(
        /\b([\w-]*(?:token|password|passwd|secret|credential|api[_-]?key)["']?\s*[:=]\s*)("[^"]*"|'[^']*'|[^\s,;&"']+)/giu,
        `$1${REDACTED}`,
      )
  )
}
