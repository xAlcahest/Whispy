export type DictationStatus = 'IDLE' | 'RECORDING' | 'PROCESSING'

export type ActivationMode = 'tap' | 'hold'
export type ThemeMode = 'light' | 'dark'
export type Provider = 'whisper' | 'parakeet'
export type RuntimeMode = 'cloud' | 'local'
export type TranslationHotkeyMode = 'combo' | 'custom'
export type AutoPasteBackend = 'wtype' | 'xdotool' | 'ydotool'
export type AutoPasteMode = 'instant' | 'stream'
export type AutoPasteShortcut = 'ctrl-v' | 'ctrl-shift-v' | 'auto'
export type WhisperRuntimeVariant = 'cpu' | 'cuda'

export interface DictionaryRule {
  id: string
  source: string
  target: string
}

export interface AppSettings {
  uiLanguage: string
  hotkey: string
  activationMode: ActivationMode
  autoPaste: boolean
  autoPasteBackend: AutoPasteBackend
  autoPasteMode: AutoPasteMode
  autoPasteShortcut: AutoPasteShortcut
  microphoneAccess: boolean
  autoHideFloatingIcon: boolean
  overlayRuntimeBadgeEnabled: boolean
  overlayRuntimeBadgeOnlyOnUse: boolean
  launchAtLogin: boolean
  sounds: boolean
  theme: ThemeMode
  preferredLanguage: string
  provider: Provider
  modelId: string
  transcriptionRuntime: RuntimeMode
  transcriptionCloudProvider: string
  transcriptionCloudModelId: string
  transcriptionOpenAIApiKey: string
  transcriptionGrokApiKey: string
  transcriptionGroqApiKey: string
  transcriptionMetaApiKey: string
  transcriptionCustomBaseUrl: string
  transcriptionCustomApiKey: string
  transcriptionCustomModel: string
  transcriptionLocalModelId: string
  whisperCppRuntimeVariant: WhisperRuntimeVariant
  postProcessingRuntime: RuntimeMode
  postProcessingEnabled: boolean
  postProcessingCloudProvider: string
  postProcessingCloudModelId: string
  postProcessingOpenAIApiKey: string
  postProcessingGrokApiKey: string
  postProcessingGroqApiKey: string
  postProcessingMetaApiKey: string
  postProcessingCustomBaseUrl: string
  postProcessingCustomApiKey: string
  postProcessingCustomModel: string
  postProcessingLocalModelId: string
  normalPrompt: string
  agentName: string
  agentPrompt: string
  translationModeEnabled: boolean
  translationHotkeyMode: TranslationHotkeyMode
  translationCustomHotkey: string
  translationSourceLanguage: string
  translationTargetLanguage: string
  translationPrompt: string
  postProcessingDictionaryEnabled: boolean
  postProcessingDictionaryRules: DictionaryRule[]
  spendingLimitOpenAIUSD: number
  spendingLimitGroqUSD: number
  spendingLimitGrokUSD: number
  spendingLimitCustomUSD: number
  historyRetentionLimit: number
  keytarEnabled: boolean
  debugModeEnabled: boolean
  detailedStatsLoggingEnabled: boolean
}

export interface HistoryEntry {
  id: string
  timestamp: number
  language: string
  provider: string
  model: string
  targetApp: string
  text: string
  durationSeconds?: number
  rawText?: string
  enhancedText?: string
  postProcessingApplied?: boolean
  postProcessingProvider?: string
  postProcessingModel?: string
}

export interface ModelDescriptor {
  id: string
  label: string
  size: string
  speed: 'Fast' | 'Balanced' | 'Accurate'
  quality: 'Basic' | 'Good' | 'Great' | 'Best'
}

export interface ModelState extends ModelDescriptor {
  downloaded: boolean
  progress: number
  downloading: boolean
}

export interface DictationTimings {
  transcriptionProcessingDurationMs?: number
  postProcessingDurationMs?: number
  pipelineDurationMs?: number
}

export interface DictationResult {
  text: string
  language: string
  provider: string
  model: string
  targetApp: string
  durationSeconds?: number
  rawText?: string
  enhancedText?: string
  postProcessingApplied?: boolean
  postProcessingProvider?: string
  postProcessingModel?: string
  timings?: DictationTimings
}

export type FakeTranscriptionResult = DictationResult

export interface AppStateSnapshot {
  settings: AppSettings
  history: HistoryEntry[]
  models: ModelState[]
  postModels: ModelState[]
  onboardingCompleted: boolean
}

export const ESTIMATED_SPEAKING_WPM = 150
export const ESTIMATED_READING_WPM = 180

export const estimateWordsFromText = (text: string) => {
  const normalized = text.trim()
  if (!normalized) {
    return 0
  }

  return normalized.split(/\s+/).filter(Boolean).length
}

export const estimateTokensFromText = (text: string) => {
  const normalized = text.trim()
  if (!normalized) {
    return 0
  }

  return Math.max(1, Math.ceil(normalized.length / 4))
}

export const estimateDurationFromWords = (words: number, wpm: number) => {
  if (words <= 0) {
    return 0
  }

  return Number(((words / wpm) * 60).toFixed(2))
}

export const estimateDurationFromTranscript = (text: string) => {
  const words = estimateWordsFromText(text)
  if (words <= 0) {
    return undefined
  }

  return estimateDurationFromWords(words, ESTIMATED_SPEAKING_WPM)
}

export const resolvePostProcessingMetadata = (settings: AppSettings) => {
  if (settings.postProcessingRuntime === 'cloud') {
    const modelId =
      settings.postProcessingCloudProvider === 'custom'
        ? settings.postProcessingCustomModel.trim() || settings.postProcessingCloudModelId
        : settings.postProcessingCloudModelId

    return {
      provider: settings.postProcessingCloudProvider,
      model: modelId,
    }
  }

  return {
    provider: 'local',
    model: settings.postProcessingLocalModelId,
  }
}
