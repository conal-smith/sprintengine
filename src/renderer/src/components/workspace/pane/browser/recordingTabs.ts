import { useMemo } from 'react'
import { create } from 'zustand'

// The browser tabs this window is recording, by recording, from the moment main
// asks for one until its last chunk is sent. The pane reads it to keep a
// recorded tab painting while it is out of view (WorkspacePaneBody's
// `hiddenBrowserLayerStyle`): a tab parked outside the window gives the
// recording no frames.

type RecordingTabsStore = {
  /** Recording id to the tab it records and the workspace that tab is in. */
  recordings: Record<string, { tabId: string; workspaceId: string }>
  begin: (recordingId: string, tabId: string, workspaceId: string) => void
  end: (recordingId: string) => void
}

export const useRecordingTabsStore = create<RecordingTabsStore>()((set) => ({
  recordings: {},
  begin: (recordingId, tabId, workspaceId) =>
    set((state) => ({ recordings: { ...state.recordings, [recordingId]: { tabId, workspaceId } } })),
  end: (recordingId) =>
    set((state) => {
      if (!(recordingId in state.recordings)) return state
      const { [recordingId]: _ended, ...recordings } = state.recordings
      return { recordings }
    }),
}))

/** The tabs this window is recording. */
export function useRecordingTabIds(): ReadonlySet<string> {
  const recordings = useRecordingTabsStore((state) => state.recordings)
  return useMemo(() => new Set(Object.values(recordings).map((entry) => entry.tabId)), [recordings])
}

/** The workspaces with a tab this window is recording. */
export function useRecordingWorkspaceIds(): ReadonlySet<string> {
  const recordings = useRecordingTabsStore((state) => state.recordings)
  return useMemo(() => new Set(Object.values(recordings).map((entry) => entry.workspaceId)), [recordings])
}
