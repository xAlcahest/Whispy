import { contextBridge, ipcRenderer } from 'electron'
import type { ElectronAPI } from '../shared/electron-api'
import {
  type AutoPasteBackendPayload,
  IPCChannels,
  type AutoPasteExecutionResult,
  type AutoPasteBackendSupportPayload,
  type BackendStateSnapshot,
  type DisplayServer,
  type DictationResultPayload,
  type DictationStatusPayload,
  type DictationToggleResponse,
  type HotkeyFallbackUsedPayload,
  type HotkeyRegistrationFailedPayload,
  type LocalModelScope,
  type ModelDownloadProgressPayload,
  type OverlaySizeKey,
  type PromptTestResultPayload,
  type DebugLogStatusPayload,
  type WhisperRuntimeDiagnosticsPayload,
  type WhisperRuntimeStatusPayload,
  type SecretStorageMigrationPayload,
  type SecretStorageStatusPayload,
  type NotesLogEventPayload,
  type NotesSnapshotPayload,
  type AppUsageStatsPayload,
  type RendererLogEntryPayload,
} from '../shared/ipc'
import type { AppSettings, AutoPasteMode, AutoPasteShortcut, HistoryEntry, ModelState } from '../shared/app'

const listen = <T>(channel: string, callback: (payload: T) => void) => {
  const wrapped = (_event: Electron.IpcRendererEvent, payload: T) => {
    callback(payload)
  }

  ipcRenderer.on(channel, wrapped)
  return () => {
    ipcRenderer.removeListener(channel, wrapped)
  }
}

const electronAPI: ElectronAPI = {
  getBackendState: () => ipcRenderer.invoke(IPCChannels.getBackendState) as Promise<BackendStateSnapshot | null>,
  setBackendSettings: (settings: AppSettings) => ipcRenderer.invoke(IPCChannels.setBackendSettings, settings),
  setBackendHistory: (entries: HistoryEntry[]) => ipcRenderer.invoke(IPCChannels.setBackendHistory, entries),
  clearBackendHistory: () => ipcRenderer.invoke(IPCChannels.clearBackendHistory),
  setBackendModels: (models: ModelState[]) => ipcRenderer.invoke(IPCChannels.setBackendModels, models),
  setBackendPostModels: (models: ModelState[]) => ipcRenderer.invoke(IPCChannels.setBackendPostModels, models),
  setBackendOnboardingCompleted: (value: boolean) =>
    ipcRenderer.invoke(IPCChannels.setBackendOnboardingCompleted, value),
  getNotesSnapshot: () => ipcRenderer.invoke(IPCChannels.getNotesSnapshot) as Promise<NotesSnapshotPayload>,
  setNotesSnapshot: (snapshot) => ipcRenderer.invoke(IPCChannels.setNotesSnapshot, snapshot),
  getAppUsageStats: (forceRefresh = false) =>
    ipcRenderer.invoke(IPCChannels.getAppUsageStats, forceRefresh) as Promise<AppUsageStatsPayload>,
  scanCustomModels: (baseUrl: string, apiKey: string) =>
    ipcRenderer.invoke(IPCChannels.scanCustomModels, baseUrl, apiKey) as Promise<string[]>,
  runPromptTest: (input: string, forceRoute?: string) =>
    ipcRenderer.invoke(IPCChannels.runPromptTest, input, forceRoute) as Promise<PromptTestResultPayload>,
  runNoteEnhancement: (input: string, instructions?: string) =>
    ipcRenderer.invoke(IPCChannels.runNoteEnhancement, input, instructions) as Promise<string>,
  downloadLocalModel: (scope: LocalModelScope, modelId: string) =>
    ipcRenderer.invoke(IPCChannels.downloadLocalModel, scope, modelId),
  cancelLocalModelDownload: (scope: LocalModelScope, modelId: string) =>
    ipcRenderer.invoke(IPCChannels.cancelLocalModelDownload, scope, modelId) as Promise<boolean>,
  removeLocalModel: (scope: LocalModelScope, modelId: string) =>
    ipcRenderer.invoke(IPCChannels.removeLocalModel, scope, modelId),
  getWhisperRuntimeStatus: () =>
    ipcRenderer.invoke(IPCChannels.getWhisperRuntimeStatus) as Promise<WhisperRuntimeStatusPayload>,
  getWhisperRuntimeDiagnostics: () =>
    ipcRenderer.invoke(IPCChannels.getWhisperRuntimeDiagnostics) as Promise<WhisperRuntimeDiagnosticsPayload>,
  downloadWhisperRuntime: (variant: 'cpu' | 'cuda') =>
    ipcRenderer.invoke(IPCChannels.downloadWhisperRuntime, variant),
  removeWhisperRuntime: (variant: 'cpu' | 'cuda') =>
    ipcRenderer.invoke(IPCChannels.removeWhisperRuntime, variant),
  getMicrophonePermissionStatus: () =>
    ipcRenderer.invoke(IPCChannels.getMicrophonePermissionStatus) as Promise<boolean>,
  requestMicrophonePermission: () =>
    ipcRenderer.invoke(IPCChannels.requestMicrophonePermission) as Promise<boolean>,
  getAccessibilityPermissionStatus: () =>
    ipcRenderer.invoke(IPCChannels.getAccessibilityPermissionStatus) as Promise<boolean>,
  requestAccessibilityPermission: () =>
    ipcRenderer.invoke(IPCChannels.requestAccessibilityPermission) as Promise<boolean>,
  getDictationStatus: () => ipcRenderer.invoke(IPCChannels.getDictationStatus) as Promise<DictationStatusPayload>,
  toggleDictation: () => ipcRenderer.invoke(IPCChannels.toggleDictation) as Promise<DictationToggleResponse>,
  toggleDictationTranscriptionOnly: () =>
    ipcRenderer.invoke(IPCChannels.toggleDictationTranscriptionOnly) as Promise<DictationToggleResponse>,
  cancelDictation: () => ipcRenderer.invoke(IPCChannels.cancelDictation) as Promise<boolean>,
  performAutoPaste: (
    text: string,
    backend: AutoPasteBackendPayload,
    options?: {
      mode?: AutoPasteMode
      shortcut?: AutoPasteShortcut
    },
  ) => ipcRenderer.invoke(IPCChannels.performAutoPaste, text, backend, options) as Promise<AutoPasteExecutionResult>,
  showDictationPanel: () => ipcRenderer.invoke(IPCChannels.showDictationPanel),
  hideWindow: () => ipcRenderer.invoke(IPCChannels.hideWindow),
  closeWindow: () => ipcRenderer.invoke(IPCChannels.closeWindow),
  minimizeWindow: () => ipcRenderer.invoke(IPCChannels.minimizeWindow),
  toggleMaximizeWindow: () => ipcRenderer.invoke(IPCChannels.toggleMaximizeWindow),
  getWindowMaximized: () => ipcRenderer.invoke(IPCChannels.getWindowMaximized) as Promise<boolean>,
  getAutoPasteBackendSupport: () =>
    ipcRenderer.invoke(IPCChannels.getAutoPasteBackendSupport) as Promise<AutoPasteBackendSupportPayload>,
  getSecretStorageStatus: () =>
    ipcRenderer.invoke(IPCChannels.getSecretStorageStatus) as Promise<SecretStorageStatusPayload>,
  migrateSecretsToKeyring: () =>
    ipcRenderer.invoke(IPCChannels.migrateSecretsToKeyring) as Promise<SecretStorageMigrationPayload>,
  getDebugLogStatus: () => ipcRenderer.invoke(IPCChannels.getDebugLogStatus) as Promise<DebugLogStatusPayload>,
  getLogLevel: () => ipcRenderer.invoke(IPCChannels.getLogLevel) as Promise<DebugLogStatusPayload['logLevel']>,
  log: (entry: RendererLogEntryPayload) => ipcRenderer.invoke(IPCChannels.appLog, entry),
  openDebugLogFile: () => ipcRenderer.invoke(IPCChannels.openDebugLogFile),
  openDebugLogsDirectory: () => ipcRenderer.invoke(IPCChannels.openDebugLogsDirectory),
  resizeMainWindow: (sizeKey: OverlaySizeKey) => ipcRenderer.invoke(IPCChannels.resizeMainWindow, sizeKey),
  setMainWindowInteractivity: (shouldCapture: boolean) =>
    ipcRenderer.invoke(IPCChannels.setMainWindowInteractivity, shouldCapture),
  openControlPanel: () => ipcRenderer.invoke(IPCChannels.openControlPanel),
  openExternal: (url: string) => ipcRenderer.invoke(IPCChannels.openExternal, url),
  openAppDataDirectory: () => ipcRenderer.invoke(IPCChannels.openAppDataDirectory),
  openSecretEnvFile: () => ipcRenderer.invoke(IPCChannels.openSecretEnvFile),
  logNotesEvent: (payload: NotesLogEventPayload) => ipcRenderer.invoke(IPCChannels.logNotesEvent, payload),
  getDisplayServer: () => ipcRenderer.invoke(IPCChannels.getDisplayServer) as Promise<DisplayServer>,
  onWindowMaximizeChanged: (callback) =>
    listen<boolean>(IPCChannels.windowMaximizeChanged, callback),
  onDictationStatusChanged: (callback) =>
    listen<DictationStatusPayload>(IPCChannels.dictationStatusChanged, callback),
  onDictationResult: (callback) =>
    listen<DictationResultPayload>(IPCChannels.dictationResult, callback),
  onDictationError: (callback) =>
    listen<string>(IPCChannels.dictationError, callback),
  onModelDownloadProgress: (callback) =>
    listen<ModelDownloadProgressPayload>(IPCChannels.modelDownloadProgress, callback),
  onFloatingIconAutoHideChanged: (callback) =>
    listen<boolean>(IPCChannels.floatingIconAutoHideChanged, callback),
  onHotkeyRegistrationFailed: (callback) =>
    listen<HotkeyRegistrationFailedPayload>(IPCChannels.hotkeyRegistrationFailed, callback),
  onHotkeyFallbackUsed: (callback) =>
    listen<HotkeyFallbackUsedPayload>(IPCChannels.hotkeyFallbackUsed, callback),
  onHotkeyEffectiveChanged: (callback) =>
    listen<string>(IPCChannels.hotkeyEffectiveChanged, callback),
  onOverlayHistorySynced: (callback) =>
    listen<import('../shared/app').HistoryEntry[]>(IPCChannels.overlayHistorySynced, callback),
}

contextBridge.exposeInMainWorld('electronAPI', electronAPI)
