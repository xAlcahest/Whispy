export type DictationStatus = 'IDLE' | 'RECORDING' | 'PROCESSING'

export type ActivationMode = 'tap' | 'hold'
export type ThemeMode = 'light' | 'dark'
export type Provider = 'whisper' | 'parakeet'
export type RuntimeMode = 'cloud' | 'local'

export interface AppSettings {
  uiLanguage: string
  hotkey: string
  activationMode: ActivationMode
  autoPaste: boolean
  autoHideFloatingIcon: boolean
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

export interface FakeTranscriptionResult {
  text: string
  language: string
  provider: string
  model: string
  targetApp: string
}
