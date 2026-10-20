export type SourceTone =
  "plain" | "comment" | "keyword" | "string" | "number" | "added" | "removed";
export type SourceToken = { text: string; tone: SourceTone };
const languages = new Set([
  "js",
  "javascript",
  "jsx",
  "ts",
  "typescript",
  "tsx",
  "json",
  "py",
  "python",
  "sh",
  "bash",
  "shell",
  "diff",
  "patch",
]);
const keywords = new Set(
  "const let var function return class extends import export from default async await new if else for while switch case break throw try catch finally true false null undefined interface type public private static def lambda None True False in is and or not with as yield pass elif except print do done then fi echo".split(
    " ",
  ),
);

/** Cosmetic, bounded native highlighting; the original source always survives. */
export function highlightSource(content: string, language?: string): SourceToken[] {
  const lang =
    language
      ?.trim()
      .split(/\s+/)[0]
      ?.toLowerCase()
      .replace(/^language-/, "") ?? "";
  const plain = (): SourceToken[] => [{ text: content, tone: "plain" }];
  if (!languages.has(lang) || content.length > 32_768) return plain();
  const tokens: SourceToken[] = [];
  const push = (text: string, tone: SourceTone) => {
    const previous = tokens.at(-1);
    if (previous?.tone === tone) previous.text += text;
    else tokens.push({ text, tone });
  };
  if (lang === "diff" || lang === "patch") {
    for (const line of content.match(/[^\n]*\n|[^\n]+$/g) ?? []) {
      push(
        line,
        line.startsWith("+") && !line.startsWith("+++")
          ? "added"
          : line.startsWith("-") && !line.startsWith("---")
            ? "removed"
            : "plain",
      );
      if (tokens.length > 2048) return plain();
    }
    return tokens;
  }
  const hashComment = ["py", "python", "sh", "bash", "shell"].includes(lang);
  // Sticky matching advances once over each token; unclosed strings/comments
  // consume the remaining source without repeated suffix scans.
  const pattern =
    /\/\*[\s\S]*?(?:\*\/|$)|\/\/[^\n]*|#[^\n]*|"(?:\\[\s\S]|[^"\\])*"?|'(?:\\[\s\S]|[^'\\])*'?|`(?:\\[\s\S]|[^`\\])*`?|\b(?:0[xX][\da-fA-F]+|\d+(?:\.\d+)?(?:[eE][+-]?\d+)?)\b|[A-Za-z_$][\w$]*|\s+|[\s\S]/y;
  while (pattern.lastIndex < content.length) {
    const match = pattern.exec(content);
    if (!match) return plain();
    const text = match[0];
    const comment =
      (text.startsWith("#") && hashComment) ||
      ((text.startsWith("//") || text.startsWith("/*")) && !hashComment && lang !== "json");
    push(
      text,
      comment
        ? "comment"
        : /^["'`]/.test(text)
          ? "string"
          : /^\d/.test(text)
            ? "number"
            : keywords.has(text)
              ? "keyword"
              : "plain",
    );
    if (tokens.length > 2048) return plain();
  }
  return tokens;
}
