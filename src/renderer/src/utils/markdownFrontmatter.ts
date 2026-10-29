const LEADING_FRONTMATTER = /^﻿?---[ \t]*(?:\r\n|\r|\n)(?:[\s\S]*?(?:\r\n|\r|\n))?(?:---|\.\.\.)[ \t]*(?=\r\n|\r|\n|$)/

/**
 * A file's leading YAML frontmatter blanked out, for a rendered preview. Left
 * in, CommonMark reads the opening `---` as a rule and the block's last line,
 * underlined by the closing `---`, as a heading: a SKILL.md or a memory file
 * opened with its `description:` as the page's largest type. Each masked
 * character becomes a space and every line break stays, so a line number read
 * off the source (the preview's git change bars) still lands on its line.
 */
export function maskMarkdownFrontmatter(markdown: string): string {
  return markdown.replace(LEADING_FRONTMATTER, (block) => block.replace(/[^\r\n]/g, ' '))
}
