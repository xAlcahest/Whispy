import type { AppSettings, ModelDescriptor } from '../types/app'

export const STORAGE_KEYS = {
  settings: 'whispy.settings',
  history: 'whispy.history',
  onboardingCompleted: 'whispy.onboarding.completed',
  models: 'whispy.models',
  postModels: 'whispy.post-models',
  appNotification: 'whispy.app.notification',
} as const

export const DEFAULT_SETTINGS: AppSettings = {
  uiLanguage: 'en',
  hotkey: 'Ctrl+Shift+K',
  activationMode: 'tap',
  autoPaste: true,
  autoHideFloatingIcon: false,
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
}

export const LANGUAGES = ['English', 'Italian', 'German', 'French', 'Spanish']
export const AUTO_DETECT_LANGUAGE = 'Auto-detect'
export const TRANSCRIPTION_LANGUAGE_OPTIONS = [AUTO_DETECT_LANGUAGE, ...LANGUAGES]

export const UI_LANGUAGES = [{ id: 'en', label: 'English' }] as const

export const PROVIDERS = [
  { id: 'whisper', label: 'Whisper (local)' },
  { id: 'parakeet', label: 'Parakeet (NVIDIA)' },
] as const

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

export const TARGET_APPS = ['VS Code', 'Notion', 'Slack', 'Cursor', 'Chrome', 'Terminal']
