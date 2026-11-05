import { renderToStaticMarkup } from 'react-dom/server'
import { expect, test } from 'vitest'

import { CardScroller } from './CardScroller'

test('a row names itself and holds each tile in its own cell', () => {
  const html = renderToStaticMarkup(
    <CardScroller title="Things to try">
      <button>One</button>
      <button>Two</button>
    </CardScroller>,
  )
  expect(html).toContain('aria-label="Things to try"')
  expect(html).toContain('<h2')
  expect(html.match(/snap-start/gu)).toHaveLength(2)
})

test('a row that has not been seen to overflow offers no scroll buttons', () => {
  const html = renderToStaticMarkup(
    <CardScroller title="Things to try">
      <button>One</button>
    </CardScroller>,
  )
  expect(html).not.toContain('Scroll on')
  expect(html).not.toContain('Scroll back')
})
