import { webUtils, type IpcRendererEvent } from 'electron'
import { ipc as ipcRenderer } from '../ipc-router'
import type {
  ContentSearchResult,
  DiagnosticLogEntry,
  DiagnosticLogInput,
  ElectronApi,
  FileSearchResult,
  FileWatchEvent,
  FolderOpenRequest,
  FolderOpenResult,
  FolderOpenTargetAvailability,
  MemoryGraphIndexResult,
  MemoryPreviewResult,
  MemoryRootStatus,
  ProcessMetricsSnapshot,
  ProjectLogo,
  VersionControlProviderProbe,
  WorkspaceFolderCheckResult,
} from '../../shared/electron-api'
import type { AttachedFilePreview } from '../../shared/attached-files'
import type { HostGhStatus } from '../../shared/host-gh'

export const filesystemApi = {
  readdir: (path: string) => ipcRenderer.invoke('fs:readdir', path),
  searchFiles: (
    rootPath: string,
    query: string,
    options?: { limit?: number; purpose?: 'mention'; channel?: string; recentAt?: Record<string, number> },
  ): Promise<FileSearchResult> =>
    ipcRenderer.invoke('fs:search-files', {
      rootPath,
      query,
      limit: options?.limit,
      purpose: options?.purpose,
      channel: options?.channel,
      recentAt: options?.recentAt,
    }),
  searchContent: (rootPath: string, query: string, options?: { limit?: number }): Promise<ContentSearchResult> =>
    ipcRenderer.invoke('fs:search-content', { rootPath, query, limit: options?.limit }),
  cancelContentSearch: (): Promise<void> => ipcRenderer.invoke('fs:cancel-content-search'),
  cancelFileSearch: (channel?: string): Promise<void> => ipcRenderer.invoke('fs:cancel-file-search', channel),
  readfile: (path: string) => ipcRenderer.invoke('fs:readfile', path),
  readImageDataUrl: (path: string) => ipcRenderer.invoke('fs:read-image-data-url', path),
  pathExists: (path: string) => ipcRenderer.invoke('fs:path-exists', path),
  statPath: (path: string) => ipcRenderer.invoke('fs:stat', path),
  getPathForFile: (file: unknown): string => {
    try {
      return webUtils.getPathForFile(file as File)
    } catch {
      return ''
    }
  },
  // The path is read here, off the person's own `File`, and only then told to
  // main: a renderer cannot hand main a path of its choosing to open later.
  attachFile: (file: unknown): string => {
    let path = ''
    try {
      path = webUtils.getPathForFile(file as File)
    } catch {
      return ''
    }
    if (path) void ipcRenderer.invoke('attached-files:register', path).catch(() => undefined)
    return path
  },
  previewAttachedFile: (path: string): Promise<AttachedFilePreview> =>
    ipcRenderer.invoke('attached-files:preview', path),
  openAttachedFile: (path: string): Promise<void> => ipcRenderer.invoke('attached-files:open', path),
  // A desktop window reads a dropped file's own path; only a browser uploads.
  uploadFiles: async (): Promise<string[]> => {
    throw new Error('Uploading is the web client’s; a desktop window reads a dropped file by its path.')
  },
  checkWorkspaceFolder: (path: string): Promise<WorkspaceFolderCheckResult> =>
    ipcRenderer.invoke('fs:check-workspace-folder', path),
  detectProjectLogo: (folderPath: string): Promise<ProjectLogo | null> =>
    ipcRenderer.invoke('fs:detect-project-logo', folderPath),
  memoryResolveRoot: (input: {
    workspaceRoot: string | null
    relativeRoot: string | null
  }): Promise<MemoryRootStatus> => ipcRenderer.invoke('memory:resolve-root', input),
  memoryIndex: (input: {
    workspaceRoot: string | null
    relativeRoot: string | null
  }): Promise<MemoryGraphIndexResult> => ipcRenderer.invoke('memory:index', input),
  memoryReadPreview: (input: {
    workspaceRoot: string | null
    relativeRoot: string | null
    relativePath: string
  }): Promise<MemoryPreviewResult> => ipcRenderer.invoke('memory:read-preview', input),
  logDiagnostic: (input: DiagnosticLogInput): Promise<DiagnosticLogEntry> =>
    ipcRenderer.invoke('diagnostics:log', input),
  openDiagnosticsLogsFolder: (): Promise<{ opened: true; path: string }> =>
    ipcRenderer.invoke('diagnostics:open-logs-folder'),
  diagnosticsGetProcessMetrics: (): Promise<ProcessMetricsSnapshot> =>
    ipcRenderer.invoke('diagnostics:get-process-metrics'),
  diagnosticsOpenWindow: (): Promise<void> => ipcRenderer.invoke('diagnostics:open-window'),
  writefile: (path: string, content: string) => ipcRenderer.invoke('fs:writefile', path, content),
  saveDroppedImage: (input: { mediaType: string; dataBase64: string }): Promise<string> =>
    ipcRenderer.invoke('fs:save-dropped-image', input),
  openImageAttachment: (input: { mediaType: string; dataBase64: string; name?: string }): Promise<void> =>
    ipcRenderer.invoke('fs:open-image-attachment', input),
  createFile: (parentDir: string, name: string) => ipcRenderer.invoke('fs:create-file', parentDir, name),
  createDir: (parentDir: string, name: string) => ipcRenderer.invoke('fs:create-dir', parentDir, name),
  ensureDir: (parentDir: string, name: string) => ipcRenderer.invoke('fs:ensure-dir', parentDir, name),
  renamePath: (sourcePath: string, nextName: string) => ipcRenderer.invoke('fs:rename', sourcePath, nextName),
  movePath: (sourcePath: string, destinationDir: string) => ipcRenderer.invoke('fs:move', sourcePath, destinationDir),
  copyPath: (sourcePath: string, destinationDir: string) => ipcRenderer.invoke('fs:copy', sourcePath, destinationDir),
  copyPathInto: (sourcePath: string, destinationDir: string, options?: { overwrite?: boolean }) =>
    ipcRenderer.invoke('fs:copy-into', sourcePath, destinationDir, options),
  deletePath: (targetPath: string) => ipcRenderer.invoke('fs:delete', targetPath),
  showItemInFolder: (targetPath: string) => ipcRenderer.invoke('fs:show-item-in-folder', targetPath),
  probeVersionControlProviders: (): Promise<VersionControlProviderProbe[]> =>
    ipcRenderer.invoke('version-control:probe-providers'),
  probeHostGh: (hostId: string): Promise<HostGhStatus | null> =>
    ipcRenderer.invoke('version-control:probe-host-gh', hostId),
  openHtmlFileInBrowser: (targetPath: string) => ipcRenderer.invoke('fs:open-html-file-in-browser', targetPath),
  listFolderOpenTargets: (): Promise<FolderOpenTargetAvailability[]> => ipcRenderer.invoke('fs:folder-open-targets'),
  openFolderInTarget: (request: FolderOpenRequest): Promise<FolderOpenResult> =>
    ipcRenderer.invoke('fs:open-folder-in-target', request),
  watchPath: async (path: string, cb: (event: FileWatchEvent) => void, options?: { includeIgnored?: boolean }) => {
    const watchId = await ipcRenderer.invoke('fs:watch-start', path, options)
    if (!watchId) {
      throw new Error(`Cannot watch missing path: ${path}`)
    }
    const ch = `fs:watch-event:${watchId}`
    const handler = (_: IpcRendererEvent, event: FileWatchEvent) => cb(event)
    ipcRenderer.on(ch, handler)
    return async () => {
      ipcRenderer.removeListener(ch, handler)
      await ipcRenderer.invoke('fs:watch-stop', watchId)
    }
  },
  openDir: (options?: { defaultPath?: string }) => ipcRenderer.invoke('fs:dialog:opendir', options),
  ensureDefaultUserSkillsDir: () => ipcRenderer.invoke('skills:ensure-default-user-dir'),
  defaultWorkspaceParentDir: () => ipcRenderer.invoke('app:default-workspace-parent'),
  projectlessChatsRoot: () => ipcRenderer.invoke('chats:projectless-root'),
  createProjectlessChatFolder: (prompt?: string) => ipcRenderer.invoke('chats:projectless-folder:create', prompt),
  showMenubarMenu: (label: string, position?: { x?: number; y?: number }) =>
    ipcRenderer.invoke('app:show-menubar-menu', label, position),
} satisfies Pick<
  ElectronApi,
  | 'readdir'
  | 'searchFiles'
  | 'searchContent'
  | 'cancelContentSearch'
  | 'cancelFileSearch'
  | 'readfile'
  | 'readImageDataUrl'
  | 'pathExists'
  | 'statPath'
  | 'getPathForFile'
  | 'attachFile'
  | 'previewAttachedFile'
  | 'openAttachedFile'
  | 'uploadFiles'
  | 'checkWorkspaceFolder'
  | 'detectProjectLogo'
  | 'memoryResolveRoot'
  | 'memoryIndex'
  | 'memoryReadPreview'
  | 'logDiagnostic'
  | 'openDiagnosticsLogsFolder'
  | 'diagnosticsGetProcessMetrics'
  | 'diagnosticsOpenWindow'
  | 'writefile'
  | 'saveDroppedImage'
  | 'openImageAttachment'
  | 'createFile'
  | 'createDir'
  | 'ensureDir'
  | 'renamePath'
  | 'movePath'
  | 'copyPath'
  | 'copyPathInto'
  | 'deletePath'
  | 'showItemInFolder'
  | 'probeVersionControlProviders'
  | 'probeHostGh'
  | 'openHtmlFileInBrowser'
  | 'listFolderOpenTargets'
  | 'openFolderInTarget'
  | 'watchPath'
  | 'openDir'
  | 'ensureDefaultUserSkillsDir'
  | 'defaultWorkspaceParentDir'
  | 'projectlessChatsRoot'
  | 'createProjectlessChatFolder'
  | 'showMenubarMenu'
>
