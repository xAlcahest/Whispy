import type { AppStateSnapshot, AutoPasteBackend, DictationResult, DictationStatus } from './app'

export type OverlaySizeKey = 'BASE' | 'WITH_MENU' | 'WITH_TOAST' | 'EXPANDED'
export type DisplayServer = 'wayland' | 'x11' | 'unknown'
export type AutoPasteBackendId = 'wtype' | 'xdotool' | 'ydotool'
export type LocalModelScope = 'transcription' | 'post'
export type LogLevelPayload = 'trace' | 'debug' | 'info' | 'warn' | 'error' | 'fatal'

export interface DictationToggleResponse {
  accepted: boolean
  reason?: 'processing' | 'unavailable'
}

export interface AutoPasteExecutionResult {
  success: boolean
  details: string
}

export interface PromptTestResultPayload {
  route: 'normal' | 'agent' | 'translation'
  output: string
}

export interface ModelDownloadProgressPayload {
  scope: LocalModelScope
  modelId: string
  progress: number
  downloadedBytes: number
  totalBytes: number | null
  state: 'downloading' | 'completed' | 'failed' | 'canceled'
  error?: string
}

export type BackendStateSnapshot = AppStateSnapshot

export interface AutoPasteBackendSupportStatus {
  id: AutoPasteBackendId
  available: boolean
  details: string
}

export interface AutoPasteBackendSupportPayload {
  detectedDisplayServer: DisplayServer
  compositorName: string
  checkedAt: number
  statuses: AutoPasteBackendSupportStatus[]
}

export interface SecretStorageStatusPayload {
  mode: 'env' | 'keyring'
  activeBackend: 'env' | 'keyring'
  fallbackActive: boolean
  keyringSupported: boolean
  envFilePath: string
  details: string
}

export interface SecretStorageMigrationPayload {
  success: boolean
  details: string
}

export interface DebugLogStatusPayload {
  enabled: boolean
  logsDirectory: string
  currentLogFile: string
  logLevel: LogLevelPayload
}

export interface RendererLogEntryPayload {
  level: LogLevelPayload
  message: string
  meta?: unknown
  scope?: string
  source?: string
}

export interface WhisperRuntimeStatusPayload {
  cpuInstalled: boolean
  cudaInstalled: boolean
  activeVariant: 'cpu' | 'cuda'
  runtimeDirectory: string
  downloadUrls: {
    cpu: string | null
    cuda: string | null
  }
}

export interface WhisperRuntimeDiagnosticsPayload {
  checkedAt: number
  selectedVariant: 'cpu' | 'cuda'
  running: boolean
  healthy: boolean
  pid: number | null
  port: number | null
  activeVariant: 'cpu' | 'cuda' | null
  commandPath: string | null
  commandSource: 'env' | 'downloaded' | 'bundled' | 'path' | null
  modelPath: string | null
  processRssMB: number | null
  nvidiaSmiAvailable: boolean
  cudaProcessDetected: boolean
  vramUsedMB: number | null
  notes: string
}

export interface HotkeyRegistrationFailedPayload {
  requestedHotkey: string
  reason: string
}

export interface HotkeyFallbackUsedPayload {
  requestedHotkey: string
  fallbackHotkey: string
  reason: string
  details: string
}

export interface NotesLogEventPayload {
  message: string
  details?: unknown
}

export interface NoteFolderPayload {
  id: string
  name: string
  createdAt: number
  updatedAt: number
}

export interface NoteEntryPayload {
  id: string
  folderId: string | null
  title: string
  rawText: string
  processedText: string
  autoTitleGenerated?: boolean
  createdAt: number
  updatedAt: number
}

export interface NoteActionPayload {
  id: string
  name: string
  description: string
  instructions: string
  isBuiltIn: boolean
  createdAt: number
  updatedAt: number
}

export interface NotesSnapshotPayload {
  folders: NoteFolderPayload[]
  notes: NoteEntryPayload[]
  actions: NoteActionPayload[]
}

export interface AppUsageModelBreakdownPayload {
  model: string
  scope: 'transcription' | 'llm' | 'unknown'
  calls: number
  tokens: number
  costUSD: number
}

export interface AppUsageStatsPayload {
  generatedAt: number
  conversationsCount: number
  notesCount: number
  foldersCount: number
  estimatedTranscriptionTokens: number
  estimatedTranscriptionCostUSD: number
  estimatedEnhancementTokens: number
  estimatedEnhancementCostUSD: number
  activeEnhancementModel: string
  activeEnhancementInputCostPerToken: number | null
  activeEnhancementOutputCostPerToken: number | null
  modelInputCostPerTokenById: Record<string, number | null>
  modelOutputCostPerTokenById: Record<string, number | null>
  litellmSource: 'cache' | 'live' | 'unavailable'
  litellmLastSyncAt: number | null
  litellmTranscriptionCostUSD: number | null
  litellmLlmCostUSD: number | null
  litellmTotalCostUSD: number | null
  litellmError?: string
  topModels: AppUsageModelBreakdownPayload[]
}

export const IPCChannels = {
  getBackendState: 'backend:get-app-state',
  setBackendSettings: 'backend:set-settings',
  setBackendHistory: 'backend:set-history',
  clearBackendHistory: 'backend:clear-history',
  setBackendModels: 'backend:set-models',
  setBackendPostModels: 'backend:set-post-models',
  setBackendOnboardingCompleted: 'backend:set-onboarding-completed',
  getNotesSnapshot: 'backend:get-notes-snapshot',
  setNotesSnapshot: 'backend:set-notes-snapshot',
  getAppUsageStats: 'backend:get-app-usage-stats',
  scanCustomModels: 'backend:scan-custom-models',
  runPromptTest: 'backend:run-prompt-test',
  runNoteEnhancement: 'backend:run-note-enhancement',
  downloadLocalModel: 'backend:download-local-model',
  cancelLocalModelDownload: 'backend:cancel-local-model-download',
  removeLocalModel: 'backend:remove-local-model',
  getWhisperRuntimeStatus: 'backend:get-whisper-runtime-status',
  getWhisperRuntimeDiagnostics: 'backend:get-whisper-runtime-diagnostics',
  downloadWhisperRuntime: 'backend:download-whisper-runtime',
  removeWhisperRuntime: 'backend:remove-whisper-runtime',
  getMicrophonePermissionStatus: 'system:get-microphone-permission-status',
  requestMicrophonePermission: 'system:request-microphone-permission',
  getAccessibilityPermissionStatus: 'system:get-accessibility-permission-status',
  requestAccessibilityPermission: 'system:request-accessibility-permission',
  getDictationStatus: 'dictation:get-status',
  toggleDictation: 'dictation:toggle',
  toggleDictationTranscriptionOnly: 'dictation:toggle-transcription-only',
  cancelDictation: 'dictation:cancel',
  performAutoPaste: 'ui:perform-autopaste',
  showDictationPanel: 'ui:show-dictation-panel',
  hideWindow: 'ui:hide-window',
  closeWindow: 'ui:close-window',
  minimizeWindow: 'ui:minimize-window',
  toggleMaximizeWindow: 'ui:toggle-maximize-window',
  getWindowMaximized: 'ui:get-window-maximized',
  getAutoPasteBackendSupport: 'ui:get-autopaste-backend-support',
  getSecretStorageStatus: 'ui:get-secret-storage-status',
  migrateSecretsToKeyring: 'ui:migrate-secrets-to-keyring',
  getDebugLogStatus: 'ui:get-debug-log-status',
  openDebugLogFile: 'ui:open-debug-log-file',
  openDebugLogsDirectory: 'ui:open-debug-logs-directory',
  getLogLevel: 'ui:get-log-level',
  appLog: 'ui:app-log',
  resizeMainWindow: 'ui:resize-main-window',
  setMainWindowInteractivity: 'ui:set-main-window-interactivity',
  openControlPanel: 'ui:open-control-panel',
  openExternal: 'ui:open-external',
  openAppDataDirectory: 'ui:open-app-data-directory',
  openSecretEnvFile: 'ui:open-secret-env-file',
  logNotesEvent: 'ui:log-notes-event',
  getDisplayServer: 'ui:get-display-server',
  windowMaximizeChanged: 'ui:event-window-maximize-changed',
  dictationStatusChanged: 'dictation:event-status-changed',
  dictationResult: 'dictation:event-result',
  dictationError: 'dictation:event-error',
  modelDownloadProgress: 'backend:event-model-download-progress',
  floatingIconAutoHideChanged: 'ui:event-floating-icon-auto-hide-changed',
  hotkeyRegistrationFailed: 'ui:event-hotkey-registration-failed',
  hotkeyFallbackUsed: 'ui:event-hotkey-fallback-used',
  hotkeyEffectiveChanged: 'ui:event-hotkey-effective-changed',
} as const

export type DictationResultPayload = DictationResult
export type DictationStatusPayload = DictationStatus
export type AutoPasteBackendPayload = AutoPasteBackend
