import type { AppStateSnapshot, AutoPasteBackend, DictationResult, DictationStatus } from './app'

export type OverlaySizeKey = 'BASE' | 'WITH_MENU' | 'WITH_TOAST' | 'EXPANDED'
export type DisplayServer = 'wayland' | 'x11' | 'unknown'
export type AutoPasteBackendId = 'wtype' | 'xdotools' | 'ydotools'
export type LocalModelScope = 'transcription' | 'post'

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
  fallbackHotkey: string
  details: string
}

export interface NotesLogEventPayload {
  message: string
  details?: unknown
}

export const IPCChannels = {
  getBackendState: 'backend:get-app-state',
  setBackendSettings: 'backend:set-settings',
  setBackendHistory: 'backend:set-history',
  clearBackendHistory: 'backend:clear-history',
  setBackendModels: 'backend:set-models',
  setBackendPostModels: 'backend:set-post-models',
  setBackendOnboardingCompleted: 'backend:set-onboarding-completed',
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
  resizeMainWindow: 'ui:resize-main-window',
  setMainWindowInteractivity: 'ui:set-main-window-interactivity',
  openControlPanel: 'ui:open-control-panel',
  openExternal: 'ui:open-external',
  openAppDataDirectory: 'ui:open-app-data-directory',
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
} as const

export type DictationResultPayload = DictationResult
export type DictationStatusPayload = DictationStatus
export type AutoPasteBackendPayload = AutoPasteBackend
