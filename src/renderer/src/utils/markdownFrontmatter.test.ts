import { expect, test } from 'vitest'

import { maskMarkdownFrontmatter } from './markdownFrontmatter'

test('leading frontmatter is blanked without moving a later line', () => {
  const markdown = '---\r\nname: skill\r\n---\r\n# Skill\n- [ ] item\n'
  const masked = maskMarkdownFrontmatter(markdown)
  expect(masked).toBe('   \r\n           \r\n   \r\n# Skill\n- [ ] item\n')
  expect(masked.indexOf('[ ]')).toBe(markdown.indexOf('[ ]'))
})

test('a byte order mark, CR line endings, an empty block and a `...` closing fence all count', () => {
  expect(maskMarkdownFrontmatter('﻿---\na: 1\n---\n# Body')).toBe('    \n    \n   \n# Body')
  expect(maskMarkdownFrontmatter('---\ra: 1\r...\r# Body')).toBe('   \r    \r   \r# Body')
  expect(maskMarkdownFrontmatter('---\n---\n# Body')).toBe('   \n   \n# Body')
})

test('an unclosed block, one not at the top, and a longer rule are left as written', () => {
  expect(maskMarkdownFrontmatter('---\na: 1\n')).toBe('---\na: 1\n')
  expect(maskMarkdownFrontmatter('# A\n---\nb\n---\n')).toBe('# A\n---\nb\n---\n')
  expect(maskMarkdownFrontmatter('---\na: 1\n----\n')).toBe('---\na: 1\n----\n')
})
