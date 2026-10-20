/**
 * The navigation decision for the sandboxed HTML preview, kept free of React
 * Native imports so it can be pinned under `node --test`.
 *
 * The document under review authors every URL it proposes, so a URL *pattern*
 * cannot identify the initial load: `<meta http-equiv="refresh"
 * content="0;url=about:blank">` and `<a href="about:blank">` both wear the same
 * shape and need no JavaScript. The initial load is an event, not a URL.
 *
 * It is also not simply "the first request", because the two platforms disagree
 * about whether the initial load is a request at all:
 *
 * - iOS  — `loadHTMLString` runs through `decidePolicyForNavigationAction`, so
 *   the gate is asked about `about:blank` before the document exists.
 * - Android — `loadDataWithBaseURL` never calls `shouldOverrideUrlLoading`, so
 *   the gate's first question is already the document's first escape attempt.
 *   Latching "the first request" would wave that one through.
 *
 * So the latch is one-shot *and* only the initial-document URL may consume it,
 * and `settle()` slams it shut the moment the WebView starts loading — which on
 * Android (`onPageStarted`) happens before any in-page navigation can be
 * proposed. Every later request is refused whatever URL it wears.
 */
export interface SandboxNavigationGate {
  /** True only for the WebView's own initial load of the injected document. */
  allow(url: string): boolean;
  /**
   * Called whenever the WebView reports a load beginning. The first is the
   * injected document. A second means something started loading that `allow`
   * never approved — on Android `shouldOverrideUrlLoading` does not fire for
   * POST-method requests, so a `<form method="post">` submit is invisible to the
   * request gate and only surfaces here. The caller must stop it.
   */
  noteLoadStart(): "initial" | "unauthorized";
}

// The URLs a WebView reports for `source={{ html, baseUrl: "" }}`: `about:blank`
// on iOS, the empty string if a platform ever reports no base document. No
// `data:` URL is ever legitimate here — the document is injected, never fetched.
const initialDocumentUrls: readonly string[] = ["about:blank", ""];

/**
 * `onShouldStartLoadWithRequest` only sees *navigations*. Subresources — `<img>`,
 * `<link rel=stylesheet>`, `@font-face`, `<iframe>` — never reach it on either
 * platform, so without this an artifact under review can beacon its reader's IP
 * to any host it likes, `incognito` and `cacheEnabled={false}` notwithstanding.
 *
 * A document-level CSP closes that. It is injected *inside* `<head>`, never before
 * the doctype: rendering mode is chosen by the doctype, and markup prepended ahead
 * of it would drop the artifact into quirks mode and misrender the very document
 * being reviewed. Inside `<head>` a `<meta http-equiv>` changes nothing about mode.
 *
 * `form-action 'none'` is load-bearing beyond beaconing: it refuses form submits in
 * the engine, which is the only platform-independent answer to Android's
 * `shouldOverrideUrlLoading` not firing for POST — there, `onLoadStart` fires only
 * once the request is already on the wire, so a backstop that cancels the load has
 * already leaked the body. CSP prevents the request instead of racing it.
 *
 * The cost is that a blocked submit is *silent*: CSP enforcement raises no event a
 * JavaScript-free page can report, so unlike a link tap the reader gets no refusal
 * notice. Accepted deliberately — a `<form>` inside a review artifact is content,
 * not a control, and never sending the request is worth more than narrating it.
 *
 * The policy allows exactly what a self-contained review artifact needs: inline
 * styles and `data:` images. Everything else is denied, `default-src 'none'`
 * covering scripts, fonts, frames, connections and media.
 *
 * `frame-ancestors` is deliberately absent: a `<meta>`-delivered policy ignores it
 * (and `report-uri`, and `sandbox`), logging an engine error for a directive that
 * would do nothing. Framing is already denied by `default-src 'none'`.
 */
const restrictedContentPolicy =
  "default-src 'none'; style-src 'unsafe-inline'; img-src data:; base-uri 'none'; form-action 'none'";

const contentPolicyMeta = `<meta http-equiv="Content-Security-Policy" content="${restrictedContentPolicy}">`;

interface StartTag {
  /** Lowercased tag name. */
  name: string;
  /** Index just past the tag's closing `>`, where markup may be inserted. */
  end: number;
  /** Whether any non-whitespace character token preceded this tag. */
  textBefore: boolean;
}

/**
 * The document's start tags, in order, as the HTML tokenizer sees them — plus
 * whether anything other than whitespace preceded each one.
 *
 * A substring scan cannot find the parser's `<head>`, because `<head>` is only
 * markup in one of the tokenizer's contexts. Three other contexts spell it
 * identically and were each shipped as a hole:
 *
 * - inside a comment — `<!-- <head> -->`
 * - inside a quoted attribute value — `<html data-x="<head>">`
 * - as an *ignored* token, when an element the parser puts in `<body>` came first
 *   — `<img src=x><head></head>`, where the parser has already opened `<body>` and
 *   discards the `<head>` tag entirely
 *
 * The first two put the policy where it is never parsed. The third is worse: the
 * meta is parsed, but as a child of `<body>`, and the HTML spec has the engine
 * discard a CSP meta that is not a child of `<head>`. All three load unpoliced —
 * and, since `form-action 'none'` goes with the policy, all three reopen the
 * Android POST escape described above.
 *
 * So the tag's extent is found by walking, skipping quoted attribute values to
 * reach the real `>`. Only the insertion *index* is computed here; the artifact's
 * own bytes are returned verbatim around it.
 */
function* scanStartTags(html: string): Generator<StartTag> {
  let at = 0;
  let textBefore = false;

  while (at < html.length) {
    if (html.startsWith("<!--", at)) {
      // A comment runs to the first `-->`, which is what makes the downlevel-revealed
      // `<!--[if gt IE 8]><!-->` end where it does. Unterminated, it swallows the
      // rest of the document — the safe direction: no `<head>` is found and the
      // wrapper carries the policy.
      const close = html.indexOf("-->", at + 4);
      at = close === -1 ? html.length : close + 3;
      continue;
    }

    // `<!doctype>`, `</close>`, `<?pi>`: not start tags, and none may contain a
    // quoted `>` in any document this renders.
    if (html.startsWith("<!", at) || html.startsWith("</", at) || html.startsWith("<?", at)) {
      const close = html.indexOf(">", at);
      at = close === -1 ? html.length : close + 1;
      continue;
    }

    if (html[at] === "<" && /[a-z]/i.test(html[at + 1] ?? "")) {
      const nameEnd = findTagNameEnd(html, at + 1);
      const name = html.slice(at + 1, nameEnd).toLowerCase();
      const end = findStartTagEnd(html, nameEnd);
      yield { name, end, textBefore };
      at = end;
      continue;
    }

    // Character tokens. Anything but whitespace before `<head>` opens `<body>`,
    // exactly as `<img>` does, so the `<head>` that follows is discarded.
    if (!/\s/.test(html[at] as string)) {
      textBefore = true;
    }
    at += 1;
  }
}

function findTagNameEnd(html: string, from: number): number {
  let at = from;
  while (at < html.length && /[^\s/>]/.test(html[at] as string)) {
    at += 1;
  }
  return at;
}

/** The index just past the `>` that ends this start tag, ignoring quoted `>`. */
function findStartTagEnd(html: string, from: number): number {
  let quote: string | null = null;

  for (let at = from; at < html.length; at += 1) {
    const char = html[at] as string;

    if (quote) {
      if (char === quote) {
        quote = null;
      }
      continue;
    }

    if (char === '"' || char === "'") {
      quote = char;
      continue;
    }

    if (char === ">") {
      return at + 1;
    }
  }

  return html.length;
}

/**
 * Where the policy may be inserted so the engine parses it as the first child of
 * the document's `<head>`, or `null` when no such point exists.
 *
 * `<head>` is the parser's head only when nothing but whitespace, comments, the
 * doctype and `<html>` precedes it. Any other element has already opened `<body>`.
 * When that holds for `<html>` but the document declares no `<head>`, one is
 * synthesised right after it.
 */
function policyInsertionPoint(html: string): { at: number; wrapInHead: boolean } | null {
  let htmlTagEnd: number | null = null;

  for (const tag of scanStartTags(html)) {
    // Non-whitespace text opens `<body>` exactly as `<img>` does. Either way the
    // head is already closed, so the only safe point left is right after `<html>`.
    if (tag.textBefore) {
      break;
    }

    if (tag.name === "head") {
      return { at: tag.end, wrapInHead: false };
    }

    if (tag.name === "html" && htmlTagEnd === null) {
      htmlTagEnd = tag.end;
      continue;
    }

    // Any other element — `<img>`, `<p>`, `<body>` — means the parser is already
    // building `<body>`, so no later `<head>` token survives.
    break;
  }

  return htmlTagEnd === null ? null : { at: htmlTagEnd, wrapInHead: true };
}

export function withRestrictedContentPolicy(html: string): string {
  const insertion = policyInsertionPoint(html);

  if (insertion) {
    const policy = insertion.wrapInHead ? `<head>${contentPolicyMeta}</head>` : contentPolicyMeta;
    return html.slice(0, insertion.at) + policy + html.slice(insertion.at);
  }

  // No reachable `<head>`: a bare fragment, a shell whose `<html>` is commented
  // out, or a document that opens `<body>` before it declares a head. Wrapping is
  // always safe — the policy leads the document, and the artifact's own `<html>`
  // and `<head>` tags become the inert tokens the parser already treats them as.
  return `<!doctype html><html><head>${contentPolicyMeta}</head><body>${html}</body></html>`;
}

export function createSandboxNavigationGate(): SandboxNavigationGate {
  let settled = false;
  let loadStarted = false;

  return {
    allow(url: string): boolean {
      if (settled || !initialDocumentUrls.includes(url)) {
        return false;
      }
      settled = true;
      return true;
    },
    noteLoadStart(): "initial" | "unauthorized" {
      if (loadStarted) {
        return "unauthorized";
      }
      loadStarted = true;
      settled = true;
      return "initial";
    },
  };
}
