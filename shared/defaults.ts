import type { AppSettings, ModelDescriptor, ModelState } from './app'

export const DEFAULT_SETTINGS: AppSettings = {
  uiLanguage: 'en',
  hotkey: 'Ctrl+Shift+K',
  activationMode: 'tap',
  autoPaste: true,
  autoPasteBackend: 'ydotools',
  microphoneAccess: true,
  autoHideFloatingIcon: false,
  overlayRuntimeBadgeEnabled: true,
  launchAtLogin: false,
  sounds: true,
  theme: 'dark',
  preferredLanguage: 'English',
  provider: 'whisper',
  modelId: 'small',
  transcriptionRuntime: 'cloud',
  transcriptionCloudProvider: 'openai',
  transcriptionCloudModelId: 'gpt-4o-transcribe',
  transcriptionOpenAIApiKey: '',
  transcriptionGrokApiKey: '',
  transcriptionGroqApiKey: '',
  transcriptionMetaApiKey: '',
  transcriptionCustomBaseUrl: '',
  transcriptionCustomApiKey: '',
  transcriptionCustomModel: 'custom-stt-model',
  transcriptionLocalModelId: 'small',
  whisperCppRuntimeVariant: 'cpu',
  postProcessingRuntime: 'cloud',
  postProcessingCloudProvider: 'openai',
  postProcessingCloudModelId: 'gpt-4.1-mini',
  postProcessingOpenAIApiKey: '',
  postProcessingGrokApiKey: '',
  postProcessingGroqApiKey: '',
  postProcessingMetaApiKey: '',
  postProcessingCustomBaseUrl: '',
  postProcessingCustomApiKey: '',
  postProcessingCustomModel: 'custom-llm-model',
  postProcessingLocalModelId: 'llama-3.1-8b-instruct',
  normalPrompt:
    'Rewrite the transcription clearly, keep the original meaning, and return plain text only.',
  agentName: 'Agent',
  agentPrompt:
    'If the user explicitly says the agent name, execute the requested action format and return concise actionable output.',
  translationModeEnabled: false,
  translationHotkeyMode: 'combo',
  translationCustomHotkey: 'Ctrl+Shift+T',
  translationSourceLanguage: 'Auto-detect',
  translationTargetLanguage: 'English',
  translationPrompt:
    'Translate the transcription from {source_language} to {target_language} while preserving intent and tone.',
  postProcessingDictionaryEnabled: false,
  postProcessingDictionaryRules: [],
  historyRetentionLimit: 100,
  keytarEnabled: true,
  debugModeEnabled: false,
}

export const MODEL_PRESETS: ModelDescriptor[] = [
  { id: 'tiny', label: 'Tiny', size: '75 MB', speed: 'Fast', quality: 'Basic' },
  { id: 'base', label: 'Base', size: '142 MB', speed: 'Fast', quality: 'Good' },
  { id: 'small', label: 'Small', size: '466 MB', speed: 'Balanced', quality: 'Great' },
  { id: 'medium', label: 'Medium', size: '1.5 GB', speed: 'Balanced', quality: 'Great' },
  { id: 'large', label: 'Large', size: '2.9 GB', speed: 'Accurate', quality: 'Best' },
  { id: 'turbo', label: 'Turbo', size: '809 MB', speed: 'Fast', quality: 'Great' },
]

export const POST_LOCAL_MODEL_PRESETS: ModelDescriptor[] = [
  {
    id: 'llama-3.1-8b-instruct',
    label: 'Llama 3.1 8B Instruct',
    size: '4.7 GB',
    speed: 'Balanced',
    quality: 'Great',
  },
  {
    id: 'qwen-2.5-7b-instruct',
    label: 'Qwen 2.5 7B Instruct',
    size: '4.3 GB',
    speed: 'Balanced',
    quality: 'Good',
  },
  {
    id: 'phi-3.5-mini-instruct',
    label: 'Phi 3.5 Mini Instruct',
    size: '2.1 GB',
    speed: 'Fast',
    quality: 'Good',
  },
]

export const createDefaultModelState = (): ModelState[] => {
  return MODEL_PRESETS.map((model) => ({
    ...model,
    downloaded: model.id === 'small',
    downloading: false,
    progress: model.id === 'small' ? 100 : 0,
  }))
}

export const createDefaultPostModelState = (): ModelState[] => {
  return POST_LOCAL_MODEL_PRESETS.map((model, index) => ({
    ...model,
    downloaded: index === 0,
    downloading: false,
    progress: index === 0 ? 100 : 0,
  }))
}

const VALID_AUTO_PASTE_BACKENDS = new Set(['wtype', 'xdotools', 'ydotools'])
const VALID_WHISPER_RUNTIME_VARIANTS = new Set(['cpu', 'cuda'])
const VALID_HISTORY_RETENTION_LIMITS = new Set([50, 100, 250, 500, -1])

export const normalizeSettings = (value: Partial<AppSettings>): AppSettings => {
  const mergedSettings: AppSettings = {
    ...DEFAULT_SETTINGS,
    ...value,
  }

  mergedSettings.autoPaste = true

  if (!VALID_AUTO_PASTE_BACKENDS.has(mergedSettings.autoPasteBackend)) {
    mergedSettings.autoPasteBackend = DEFAULT_SETTINGS.autoPasteBackend
  }

  if (!VALID_WHISPER_RUNTIME_VARIANTS.has(mergedSettings.whisperCppRuntimeVariant)) {
    mergedSettings.whisperCppRuntimeVariant = DEFAULT_SETTINGS.whisperCppRuntimeVariant
  }

  if (!VALID_HISTORY_RETENTION_LIMITS.has(mergedSettings.historyRetentionLimit)) {
    mergedSettings.historyRetentionLimit = DEFAULT_SETTINGS.historyRetentionLimit
  }

  if (typeof mergedSettings.microphoneAccess !== 'boolean') {
    mergedSettings.microphoneAccess = DEFAULT_SETTINGS.microphoneAccess
  }

  if (typeof mergedSettings.debugModeEnabled !== 'boolean') {
    mergedSettings.debugModeEnabled = DEFAULT_SETTINGS.debugModeEnabled
  }

  mergedSettings.keytarEnabled = true

  if (typeof mergedSettings.overlayRuntimeBadgeEnabled !== 'boolean') {
    mergedSettings.overlayRuntimeBadgeEnabled = DEFAULT_SETTINGS.overlayRuntimeBadgeEnabled
  }

  if (!mergedSettings.agentName || mergedSettings.agentName === 'ActionAgent') {
    mergedSettings.agentName = 'Agent'
  }

  return mergedSettings
}

export const normalizeModelState = (models: ModelState[], defaults: ModelState[]): ModelState[] => {
  if (models.length === 0) {
    return defaults
  }

  return models.map((model) => ({
    ...model,
    downloading: false,
    progress: model.downloaded ? 100 : model.progress,
  }))
}
