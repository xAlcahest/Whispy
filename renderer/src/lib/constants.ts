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

export const UI_LANGUAGES = [{ id: 'en', label: 'English' }] as const

export const PROVIDERS = [
  { id: 'whisper', label: 'Whisper (local)' },
  { id: 'parakeet', label: 'Parakeet (NVIDIA)' },
] as const

export const CLOUD_TRANSCRIPTION_CATALOG = [
  {
    providerId: 'openai',
    providerLabel: 'OpenAI',
    models: [
      { id: 'gpt-4o-transcribe', label: 'gpt-4o-transcribe' },
      { id: 'whisper-1', label: 'whisper-1' },
    ],
  },
  {
    providerId: 'grok',
    providerLabel: 'Grok (xAI)',
    models: [
      { id: 'grok-voice-beta', label: 'grok-voice-beta' },
      { id: 'grok-voice-realtime', label: 'grok-voice-realtime' },
    ],
  },
  {
    providerId: 'groq',
    providerLabel: 'Groq',
    models: [
      { id: 'whisper-large-v3', label: 'whisper-large-v3' },
      { id: 'distil-whisper-large-v3-en', label: 'distil-whisper-large-v3-en' },
    ],
  },
  {
    providerId: 'meta',
    providerLabel: 'Meta',
    models: [
      { id: 'seamless-m4t-v2', label: 'seamless-m4t-v2' },
      { id: 'wav2vec2-large', label: 'wav2vec2-large' },
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
      { id: 'gpt-4.1-mini', label: 'gpt-4.1-mini' },
      { id: 'gpt-4o-mini', label: 'gpt-4o-mini' },
    ],
  },
  {
    providerId: 'grok',
    providerLabel: 'Grok (xAI)',
    models: [
      { id: 'grok-2-latest', label: 'grok-2-latest' },
      { id: 'grok-2-mini', label: 'grok-2-mini' },
    ],
  },
  {
    providerId: 'groq',
    providerLabel: 'Groq',
    models: [
      { id: 'llama-3.3-70b-versatile', label: 'llama-3.3-70b-versatile' },
      { id: 'mixtral-8x7b-32768', label: 'mixtral-8x7b-32768' },
    ],
  },
  {
    providerId: 'meta',
    providerLabel: 'Meta',
    models: [
      { id: 'llama-3.1-405b-instruct', label: 'llama-3.1-405b-instruct' },
      { id: 'llama-3.1-70b-instruct', label: 'llama-3.1-70b-instruct' },
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

export const TARGET_APPS = ['Google Chrome', 'Visual Studio Code', 'Terminal']
