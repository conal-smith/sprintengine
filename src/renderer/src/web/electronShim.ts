// What `electron` is in the web client's build (vite.web.config.ts swaps the
// module for this one). The preload's api modules are shared with the web
// tab; the runtime members any of them imports from Electron are `webUtils`,
// for a dropped file's path, which a browser does not reveal, and `webFrame`,
// for the window's zoom, which a tab has none of its own to report.

export const webUtils = {
  getPathForFile: (): string => '',
}

export const webFrame = {
  getZoomFactor: (): number => 1,
}
