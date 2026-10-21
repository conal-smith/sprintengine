import { sep } from 'node:path'
import { expect, test } from 'vitest'

import { expandHomePath } from './home-path'

test('a ~/ path is the file it names in the home folder', () => {
  expect(expandHomePath('~/Desktop/shot.png', '/Users/dev')).toBe(`/Users/dev${sep}Desktop/shot.png`)
  expect(expandHomePath('~\\Desktop\\shot.png', 'C:\\Users\\dev\\')).toBe(`C:\\Users\\dev${sep}Desktop\\shot.png`)
})

test('the rest of a ~/ path is kept as written, a climb out of the home folder included', () => {
  expect(expandHomePath('~/../dev2/shot.png', '/Users/dev')).toBe(`/Users/dev${sep}../dev2/shot.png`)
})

test('any other path is left as it is', () => {
  for (const path of ['/Users/dev/shot.png', 'shots/shot.png', '~dev/shot.png', '~', 'shots/~/shot.png'])
    expect(expandHomePath(path, '/Users/dev')).toBe(path)
})
