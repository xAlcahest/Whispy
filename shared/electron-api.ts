import type {
  AutoPasteExecutionResult,
  AutoPasteBackendSupportPayload,
  BackendStateSnapshot,
  DisplayServer,
  DictationResultPayload,
  DictationStatusPayload,
  DictationToggleResponse,
  HotkeyFallbackUsedPayload,
  HotkeyRegistrationFailedPayload,
  LocalModelScope,
  ModelDownloadProgressPayload,
  OverlaySizeKey,
  PromptTestResultPayload,
  DebugLogStatusPayload,
  WhisperRuntimeDiagnosticsPayload,
  WhisperRuntimeStatusPayload,
  SecretStorageMigrationPayload,
  SecretStorageStatusPayload,
  NotesLogEventPayload,
  NotesSnapshotPayload,
  AppUsageStatsPayload,
  RendererLogEntryPayload,
} from './ipc'
import type { AppSettings, AutoPasteBackend, AutoPasteMode, AutoPasteShortcut, HistoryEntry, ModelState } from './app'

export interface ElectronAPI {
  getBackendState: () => Promise<BackendStateSnapshot | null>
  setBackendSettings: (settings: AppSettings) => Promise<void>
  setBackendHistory: (entries: HistoryEntry[]) => Promise<void>
  clearBackendHistory: () => Promise<void>
  setBackendModels: (models: ModelState[]) => Promise<void>
  setBackendPostModels: (models: ModelState[]) => Promise<void>
  setBackendOnboardingCompleted: (value: boolean) => Promise<void>
  getNotesSnapshot: () => Promise<NotesSnapshotPayload>
  setNotesSnapshot: (snapshot: NotesSnapshotPayload) => Promise<void>
  getAppUsageStats: (forceRefresh?: boolean) => Promise<AppUsageStatsPayload>
  scanCustomModels: (baseUrl: string, apiKey: string) => Promise<string[]>
  runPromptTest: (input: string, forceRoute?: string) => Promise<PromptTestResultPayload>
  runNoteEnhancement: (input: string, instructions?: string) => Promise<string>
  downloadLocalModel: (scope: LocalModelScope, modelId: string) => Promise<void>
  cancelLocalModelDownload: (scope: LocalModelScope, modelId: string) => Promise<boolean>
  removeLocalModel: (scope: LocalModelScope, modelId: string) => Promise<void>
  getWhisperRuntimeStatus: () => Promise<WhisperRuntimeStatusPayload>
  getWhisperRuntimeDiagnostics: () => Promise<WhisperRuntimeDiagnosticsPayload>
  downloadWhisperRuntime: (variant: 'cpu' | 'cuda') => Promise<void>
  removeWhisperRuntime: (variant: 'cpu' | 'cuda') => Promise<void>
  getMicrophonePermissionStatus: () => Promise<boolean>
  requestMicrophonePermission: () => Promise<boolean>
  getAccessibilityPermissionStatus: () => Promise<boolean>
  requestAccessibilityPermission: () => Promise<boolean>
  getDictationStatus: () => Promise<DictationStatusPayload>
  toggleDictation: () => Promise<DictationToggleResponse>
  toggleDictationTranscriptionOnly: () => Promise<DictationToggleResponse>
  cancelDictation: () => Promise<boolean>
  performAutoPaste: (
    text: string,
    backend: AutoPasteBackend,
    options?: {
      mode?: AutoPasteMode
      shortcut?: AutoPasteShortcut
    },
  ) => Promise<AutoPasteExecutionResult>
  showDictationPanel: () => Promise<void>
  hideWindow: () => Promise<void>
  closeWindow: () => Promise<void>
  minimizeWindow: () => Promise<void>
  toggleMaximizeWindow: () => Promise<void>
  getWindowMaximized: () => Promise<boolean>
  getAutoPasteBackendSupport: () => Promise<AutoPasteBackendSupportPayload>
  getSecretStorageStatus: () => Promise<SecretStorageStatusPayload>
  migrateSecretsToKeyring: () => Promise<SecretStorageMigrationPayload>
  getDebugLogStatus: () => Promise<DebugLogStatusPayload>
  getLogLevel: () => Promise<DebugLogStatusPayload['logLevel']>
  log: (entry: RendererLogEntryPayload) => Promise<void>
  openDebugLogFile: () => Promise<void>
  openDebugLogsDirectory: () => Promise<void>
  resizeMainWindow: (sizeKey: OverlaySizeKey) => Promise<void>
  setMainWindowInteractivity: (shouldCapture: boolean) => Promise<void>
  openControlPanel: () => Promise<void>
  openExternal: (url: string) => Promise<void>
  openAppDataDirectory: () => Promise<void>
  openSecretEnvFile: () => Promise<void>
  logNotesEvent: (payload: NotesLogEventPayload) => Promise<void>
  getDisplayServer: () => Promise<DisplayServer>
  onWindowMaximizeChanged: (callback: (maximized: boolean) => void) => () => void
  onDictationStatusChanged: (callback: (status: DictationStatusPayload) => void) => () => void
  onDictationResult: (callback: (payload: DictationResultPayload) => void) => () => void
  onDictationError: (callback: (message: string) => void) => () => void
  onModelDownloadProgress: (callback: (payload: ModelDownloadProgressPayload) => void) => () => void
  onFloatingIconAutoHideChanged: (callback: (enabled: boolean) => void) => () => void
  onHotkeyRegistrationFailed: (
    callback: (payload: HotkeyRegistrationFailedPayload) => void,
  ) => () => void
  onHotkeyFallbackUsed: (callback: (payload: HotkeyFallbackUsedPayload) => void) => () => void
  onHotkeyEffectiveChanged: (callback: (newHotkey: string) => void) => () => void
  onOverlayHistorySynced: (callback: (entries: HistoryEntry[]) => void) => () => void
}
