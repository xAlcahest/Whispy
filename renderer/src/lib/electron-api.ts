import type { ElectronAPI } from '../../../shared/electron-api'
import type { DisplayServer } from '../../../shared/ipc'

const noopUnsubscribe = () => {}

const fallbackElectronAPI: ElectronAPI = {
  getBackendState: async () => null,
  setBackendSettings: async () => {},
  setBackendHistory: async () => {},
  clearBackendHistory: async () => {},
  setBackendModels: async () => {},
  setBackendPostModels: async () => {},
  setBackendOnboardingCompleted: async () => {},
  getNotesSnapshot: async () => ({
    folders: [],
    notes: [],
    actions: [],
  }),
  setNotesSnapshot: async () => {},
  getAppUsageStats: async () => ({
    generatedAt: Date.now(),
    conversationsCount: 0,
    notesCount: 0,
    foldersCount: 0,
    estimatedTranscriptionTokens: 0,
    estimatedTranscriptionCostUSD: 0,
    estimatedEnhancementTokens: 0,
    estimatedEnhancementCostUSD: 0,
    activeEnhancementModel: '',
    activeEnhancementInputCostPerToken: null,
    activeEnhancementOutputCostPerToken: null,
    modelInputCostPerTokenById: {},
    modelOutputCostPerTokenById: {},
    litellmSource: 'unavailable' as const,
    litellmLastSyncAt: null,
    litellmTranscriptionCostUSD: null,
    litellmLlmCostUSD: null,
    litellmTotalCostUSD: null,
    topModels: [],
  }),
  scanCustomModels: async () => {
    throw new Error('scanCustomModels unavailable outside Electron runtime')
  },
  runPromptTest: async () => {
    throw new Error('runPromptTest unavailable outside Electron runtime')
  },
  runNoteEnhancement: async (input: string) => {
    return input
      .replace(/[ \t]+\n/g, '\n')
      .replace(/\n{3,}/g, '\n\n')
      .replace(/[ \t]{2,}/g, ' ')
      .trim()
  },
  downloadLocalModel: async () => {
    throw new Error('downloadLocalModel unavailable outside Electron runtime')
  },
  cancelLocalModelDownload: async () => false,
  removeLocalModel: async () => {
    throw new Error('removeLocalModel unavailable outside Electron runtime')
  },
  getWhisperRuntimeStatus: async () => ({
    cpuInstalled: false,
    cudaInstalled: false,
    activeVariant: 'cpu' as const,
    runtimeDirectory: '',
    downloadUrls: {
      cpu: null,
      cuda: null,
    },
  }),
  getWhisperRuntimeDiagnostics: async () => ({
    checkedAt: Date.now(),
    selectedVariant: 'cpu' as const,
    running: false,
    healthy: false,
    pid: null,
    port: null,
    activeVariant: null,
    commandPath: null,
    commandSource: null,
    modelPath: null,
    processRssMB: null,
    nvidiaSmiAvailable: false,
    cudaProcessDetected: false,
    vramUsedMB: null,
    notes: 'Runtime diagnostics unavailable outside Electron runtime.',
  }),
  downloadWhisperRuntime: async () => {
    throw new Error('downloadWhisperRuntime unavailable outside Electron runtime')
  },
  removeWhisperRuntime: async () => {
    throw new Error('removeWhisperRuntime unavailable outside Electron runtime')
  },
  getMicrophonePermissionStatus: async () => true,
  requestMicrophonePermission: async () => true,
  getAccessibilityPermissionStatus: async () => true,
  requestAccessibilityPermission: async () => true,
  getDictationStatus: async () => 'IDLE',
  toggleDictation: async () => ({
    accepted: false,
    reason: 'unavailable',
  }),
  toggleDictationTranscriptionOnly: async () => ({
    accepted: false,
    reason: 'unavailable',
  }),
  cancelDictation: async () => false,
  performAutoPaste: async () => ({
    success: false,
    details: 'performAutoPaste unavailable outside Electron runtime',
  }),
  showDictationPanel: async () => {
    if (typeof window === 'undefined') {
      return
    }

    if (window.location.hash !== '#/overlay') {
      window.location.hash = '/overlay'
    }
  },
  hideWindow: async () => {},
  closeWindow: async () => {
    throw new Error('closeWindow unavailable outside Electron runtime')
  },
  minimizeWindow: async () => {
    throw new Error('minimizeWindow unavailable outside Electron runtime')
  },
  toggleMaximizeWindow: async () => {
    throw new Error('toggleMaximizeWindow unavailable outside Electron runtime')
  },
  getWindowMaximized: async () => false,
  getAutoPasteBackendSupport: async () => {
    throw new Error('getAutoPasteBackendSupport unavailable outside Electron runtime')
  },
  getSecretStorageStatus: async () => {
    throw new Error('getSecretStorageStatus unavailable outside Electron runtime')
  },
  migrateSecretsToKeyring: async () => {
    throw new Error('migrateSecretsToKeyring unavailable outside Electron runtime')
  },
  getDebugLogStatus: async () => {
    throw new Error('getDebugLogStatus unavailable outside Electron runtime')
  },
  getLogLevel: async () => 'info',
  log: async (entry) => {
    const scopeTag = entry.scope ? `[${entry.scope}]` : ''
    const sourceTag = entry.source ? `[${entry.source}]` : ''
    const prefix = `[${entry.level.toUpperCase()}]${scopeTag}${sourceTag}`
    if (entry.level === 'error' || entry.level === 'fatal') {
      console.error(`${prefix} ${entry.message}`, entry.meta)
      return
    }

    if (entry.level === 'warn') {
      console.warn(`${prefix} ${entry.message}`, entry.meta)
      return
    }

    console.log(`${prefix} ${entry.message}`, entry.meta)
  },
  openDebugLogFile: async () => {},
  openDebugLogsDirectory: async () => {},
  resizeMainWindow: async () => {},
  setMainWindowInteractivity: async () => {},
  openControlPanel: async () => {},
  openExternal: async (url: string) => {
    if (url.startsWith('http://') || url.startsWith('https://')) {
      window.open(url, '_blank', 'noopener,noreferrer')
      return
    }

    throw new Error('Unsupported external URL scheme in fallback runtime')
  },
  openSecretEnvFile: async () => {
    throw new Error('openSecretEnvFile unavailable outside Electron runtime')
  },
  logNotesEvent: async () => {},
  getDisplayServer: async () =>
    (navigator.userAgent.toLowerCase().includes('wayland') ? 'wayland' : 'unknown') as DisplayServer,
  openAppDataDirectory: async () => {},
  onWindowMaximizeChanged: () => noopUnsubscribe,
  onDictationStatusChanged: () => noopUnsubscribe,
  onDictationResult: () => noopUnsubscribe,
  onDictationError: () => noopUnsubscribe,
  onModelDownloadProgress: () => noopUnsubscribe,
  onFloatingIconAutoHideChanged: () => noopUnsubscribe,
  onHotkeyRegistrationFailed: () => noopUnsubscribe,
  onHotkeyFallbackUsed: () => noopUnsubscribe,
  onHotkeyEffectiveChanged: () => noopUnsubscribe,
}

const getRuntimeElectronAPI = (): ElectronAPI | null => {
  if (typeof window === 'undefined') {
    return null
  }

  if (typeof window.electronAPI === 'undefined') {
    return null
  }

  return window.electronAPI
}

export const electronAPI: ElectronAPI = new Proxy(fallbackElectronAPI, {
  get(target, property: keyof ElectronAPI) {
    const runtimeAPI = getRuntimeElectronAPI() ?? target
    const value = runtimeAPI[property]

    if (typeof value === 'function') {
      return value.bind(runtimeAPI)
    }

    return value
  },
})
