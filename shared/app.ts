export type DictationStatus = 'IDLE' | 'RECORDING' | 'PROCESSING'

export type ActivationMode = 'tap' | 'hold'
export type ThemeMode = 'light' | 'dark'
export type Provider = 'whisper' | 'parakeet'
export type RuntimeMode = 'cloud' | 'local'
export type TranslationHotkeyMode = 'combo' | 'custom'
export type AutoPasteBackend = 'wtype' | 'xdotools' | 'ydotools'
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
  microphoneAccess: boolean
  autoHideFloatingIcon: boolean
  overlayRuntimeBadgeEnabled: boolean
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
  historyRetentionLimit: number
  keytarEnabled: boolean
  debugModeEnabled: boolean
}

export interface HistoryEntry {
  id: string
  timestamp: number
  language: string
  provider: string
  model: string
  targetApp: string
  text: string
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

export interface DictationResult {
  text: string
  language: string
  provider: string
  model: string
  targetApp: string
}

export type FakeTranscriptionResult = DictationResult

export interface AppStateSnapshot {
  settings: AppSettings
  history: HistoryEntry[]
  models: ModelState[]
  postModels: ModelState[]
  onboardingCompleted: boolean
}
