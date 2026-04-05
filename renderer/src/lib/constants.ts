import {
  DEFAULT_SETTINGS,
  MODEL_PRESETS,
  POST_LOCAL_MODEL_PRESETS,
  createDefaultModelState,
  createDefaultPostModelState,
  normalizeModelState,
  normalizeSettings,
} from '../../../shared/defaults'

export {
  DEFAULT_SETTINGS,
  MODEL_PRESETS,
  POST_LOCAL_MODEL_PRESETS,
  createDefaultModelState,
  createDefaultPostModelState,
  normalizeModelState,
  normalizeSettings,
}

export const STORAGE_KEYS = {
  settings: 'whispy.settings',
  history: 'whispy.history',
  onboardingCompleted: 'whispy.onboarding.completed',
  models: 'whispy.models',
  postModels: 'whispy.post-models',
  noteFolders: 'whispy.note-folders',
  notes: 'whispy.notes',
  noteActions: 'whispy.note-actions',
  noteLastAction: 'whispy.note-actions.last-used',
  noteProcessingEvents: 'whispy.notes.processing-events',
  detailedStatsLogs: 'whispy.stats.detailed-logs',
  appNotification: 'whispy.app.notification',
} as const

export const AUTO_DETECT_LANGUAGE = 'Auto-detect'

export const LANGUAGE_LOCALES = ['en-GB', 'it-IT', 'de-DE', 'fr-FR', 'es-ES'] as const

const languageDisplayNames = new Intl.DisplayNames(['en'], { type: 'language' })

const regionToFlagEmoji = (region: string) =>
  region
    .toUpperCase()
    .replace(/./g, (char) => String.fromCodePoint(127397 + char.charCodeAt(0)))

export const LANGUAGE_OPTIONS = LANGUAGE_LOCALES.map((locale) => {
  const localeObject = new Intl.Locale(locale)
  const language = languageDisplayNames.of(localeObject.language) ?? locale
  const region = localeObject.region ?? 'UN'

  return {
    locale,
    value: language,
    label: language,
    flag: regionToFlagEmoji(region),
  }
})

export const LANGUAGES = LANGUAGE_OPTIONS.map((language) => language.value)
export const TRANSCRIPTION_LANGUAGE_OPTIONS = [AUTO_DETECT_LANGUAGE, ...LANGUAGES]

export const LANGUAGE_FLAG_BY_NAME: Record<string, string> = {
  [AUTO_DETECT_LANGUAGE]: '🌐',
  ...Object.fromEntries(LANGUAGE_OPTIONS.map((language) => [language.value, language.flag])),
}

export const UI_LANGUAGES = [
  { id: 'en', label: 'English' },
  { id: 'de', label: 'Deutsch' },
  { id: 'es', label: 'Español' },
  { id: 'fr', label: 'Français' },
  { id: 'it', label: 'Italiano' },
  { id: 'ja', label: '日本語' },
  { id: 'pt', label: 'Português' },
  { id: 'ru', label: 'Русский' },
  { id: 'zh-CN', label: '简体中文' },
  { id: 'zh-TW', label: '繁體中文' },
] as const

export const PROVIDERS = [
  { id: 'whisper', label: 'Whisper (local)' },
  { id: 'parakeet', label: 'Parakeet (NVIDIA)' },
] as const

export const CLOUD_TRANSCRIPTION_CATALOG = [
  {
    providerId: 'openai',
    providerLabel: 'OpenAI',
    models: [
      { id: 'gpt-4o-transcribe', label: 'gpt-4o-transcribe', recommended: true },
      { id: 'gpt-4o-mini-transcribe', label: 'gpt-4o-mini-transcribe', recommended: true },
      { id: 'whisper-1', label: 'whisper-1', recommended: true },
      { id: 'gpt-4o-realtime-preview', label: 'gpt-4o-realtime-preview' },
      { id: 'gpt-4o-mini-realtime-preview', label: 'gpt-4o-mini-realtime-preview' },
    ],
  },
  {
    providerId: 'grok',
    providerLabel: 'Grok (xAI)',
    models: [
      { id: 'grok-voice-beta', label: 'grok-voice-beta', recommended: true },
      { id: 'grok-voice-realtime', label: 'grok-voice-realtime' },
    ],
  },
  {
    providerId: 'groq',
    providerLabel: 'Groq',
    models: [
      { id: 'whisper-large-v3', label: 'whisper-large-v3', recommended: true },
      { id: 'distil-whisper-large-v3-en', label: 'distil-whisper-large-v3-en' },
      { id: 'whisper-large-v3-turbo', label: 'whisper-large-v3-turbo' },
    ],
  },
  {
    providerId: 'custom',
    providerLabel: 'Custom',
    models: [{ id: 'custom-stt-model', label: 'custom-stt-model' }],
  },
] as const

export const CLOUD_POST_PROCESSING_CATALOG = [
  {
    providerId: 'openai',
    providerLabel: 'OpenAI',
    models: [
      { id: 'gpt-5.2', label: 'gpt-5.2', recommended: true },
      { id: 'gpt-5', label: 'gpt-5' },
      { id: 'gpt-5-mini', label: 'gpt-5-mini', recommended: true },
      { id: 'gpt-5-nano', label: 'gpt-5-nano' },
      { id: 'gpt-4.1', label: 'gpt-4.1' },
      { id: 'gpt-4.1-mini', label: 'gpt-4.1-mini', recommended: true },
      { id: 'gpt-4o', label: 'gpt-4o' },
      { id: 'gpt-4o-mini', label: 'gpt-4o-mini', recommended: true },
      { id: 'o4-mini', label: 'o4-mini' },
      { id: 'o3', label: 'o3' },
    ],
  },
  {
    providerId: 'grok',
    providerLabel: 'Grok (xAI)',
    models: [
      { id: 'grok-3-latest', label: 'grok-3-latest', recommended: true },
      { id: 'grok-3-mini', label: 'grok-3-mini', recommended: true },
      { id: 'grok-2-latest', label: 'grok-2-latest' },
      { id: 'grok-2-mini', label: 'grok-2-mini' },
    ],
  },
  {
    providerId: 'groq',
    providerLabel: 'Groq',
    models: [
      { id: 'llama-3.3-70b-versatile', label: 'llama-3.3-70b-versatile', recommended: true },
      { id: 'llama-3.1-8b-instant', label: 'llama-3.1-8b-instant', recommended: true },
      { id: 'mixtral-8x7b-32768', label: 'mixtral-8x7b-32768' },
      { id: 'qwen-qwq-32b', label: 'qwen-qwq-32b' },
    ],
  },
  {
    providerId: 'custom',
    providerLabel: 'Custom',
    models: [{ id: 'custom-llm-model', label: 'custom-llm-model' }],
  },
] as const

export const AUTO_DETECT_SUPPORTED_TRANSCRIPTION_MODELS = new Set<string>([
  ...MODEL_PRESETS.map((model) => model.id),
  ...CLOUD_TRANSCRIPTION_CATALOG.filter((provider) => provider.providerId !== 'custom').flatMap((provider) =>
    provider.models.map((model) => model.id),
  ),
])

const TRANSCRIPTION_INCLUDE_MARKERS = [
  'transcribe',
  'transcription',
  'speech-to-text',
  'speech2text',
  'stt',
  'whisper',
  'realtime',
  'voice',
  'seamless-m4t',
  'wav2vec',
]

const TRANSCRIPTION_EXCLUDE_MARKERS = [
  'tts',
  'text-to-speech',
  'embedding',
  'embed',
  'moderation',
  'dall-e',
  'dalle',
  'image',
]

const POST_PROCESSING_EXCLUDE_MARKERS = [
  'transcribe',
  'transcription',
  'whisper',
  'tts',
  'text-to-speech',
  'speech-to-text',
  'embedding',
  'embed',
  'moderation',
  'dall-e',
  'dalle',
  'image',
]

const POST_PROCESSING_LLM_INCLUDE_MARKERS = [
  'gpt',
  'llama',
  'mistral',
  'mixtral',
  'qwen',
  'claude',
  'gemini',
  'grok',
  'deepseek',
  'command',
  'phi',
  'o1',
  'o3',
  'o4',
  'o5',
]

const normalizeModelId = (modelId: string) => modelId.trim().toLowerCase()

export const isTranscriptionCapableModelId = (modelId: string) => {
  const normalized = normalizeModelId(modelId)
  if (!normalized) {
    return false
  }

  if (TRANSCRIPTION_EXCLUDE_MARKERS.some((marker) => normalized.includes(marker))) {
    return false
  }

  return TRANSCRIPTION_INCLUDE_MARKERS.some((marker) => normalized.includes(marker))
}

export const isPostProcessingLlmModelId = (modelId: string) => {
  const normalized = normalizeModelId(modelId)
  if (!normalized) {
    return false
  }

  if (POST_PROCESSING_EXCLUDE_MARKERS.some((marker) => normalized.includes(marker))) {
    return false
  }

  return POST_PROCESSING_LLM_INCLUDE_MARKERS.some((marker) => normalized.includes(marker))
}

export const TARGET_APPS = ['Google Chrome', 'Visual Studio Code', 'Terminal']
