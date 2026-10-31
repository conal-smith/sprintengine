import { renderToStaticMarkup } from 'react-dom/server'
import { expect, test } from 'vitest'

import { ProjectMonogram } from '../components/workspace/ProjectMonogram'
import { resolveProjectIconView } from './useProjectIcon'

const FILE = { kind: 'file', path: '/Users/dev/art/mark.svg' } as const
const MONOGRAM = { kind: 'monogram', text: 'MA', hue: 255 } as const

test('a chosen icon wins over the detected logo, and detection is the fallback', () => {
  expect(resolveProjectIconView(MONOGRAM, null, 'data:detected')).toEqual({ kind: 'monogram', text: 'MA', hue: 255 })
  expect(resolveProjectIconView(FILE, 'data:chosen', 'data:detected')).toEqual({ kind: 'image', src: 'data:chosen' })
  // A chosen file that cannot be read (gone, or refused by the guards) falls back to detection.
  expect(resolveProjectIconView(FILE, null, 'data:detected')).toEqual({ kind: 'image', src: 'data:detected' })
  expect(resolveProjectIconView(undefined, null, 'data:detected')).toEqual({ kind: 'image', src: 'data:detected' })
  expect(resolveProjectIconView(undefined, null, null)).toBeNull()
})

test('the generated monogram is deterministic and wears the project hue', () => {
  const once = renderToStaticMarkup(<ProjectMonogram text="MA" hue={255} className="icon-xs" />)
  const again = renderToStaticMarkup(<ProjectMonogram text="MA" hue={255} className="icon-xs" />)
  expect(once).toBe(again)
  expect(once).toContain('>MA</text>')
  expect(once).toContain('--project-hue:255')
  expect(once).toContain('project-mark')
  expect(renderToStaticMarkup(<ProjectMonogram text="MA" hue={25} />)).not.toBe(once)
})
