import React from 'react'

import type { ExtensionsDrawerView } from '../extensionsSurfaceTarget'

// Which of the two catalogues the Extensions modal shows, and the way to the
// other one (owner ruling 2026-11-03). The modal is one dialog holding both,
// so the switch sits in its title bar beside the name — but the bar is drawn
// by `CatalogueSurface`, two catalogues down from the surface that owns the
// view. A context, so neither catalogue has to carry a prop it only passes on.
export type CatalogueViewSwitch = {
  view: ExtensionsDrawerView
  onChange: (view: ExtensionsDrawerView) => void
}

export const CatalogueViewSwitchContext = React.createContext<CatalogueViewSwitch | null>(null)
