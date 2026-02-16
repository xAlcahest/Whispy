import type { AppSettings } from './app'

export const SECRET_SETTING_KEYS = [
  'transcriptionOpenAIApiKey',
  'transcriptionGrokApiKey',
  'transcriptionGroqApiKey',
  'transcriptionMetaApiKey',
  'transcriptionCustomApiKey',
  'postProcessingOpenAIApiKey',
  'postProcessingGrokApiKey',
  'postProcessingGroqApiKey',
  'postProcessingMetaApiKey',
  'postProcessingCustomApiKey',
] as const

export type SecretSettingKey = (typeof SECRET_SETTING_KEYS)[number]
export type SecretSettingsMap = Partial<Record<SecretSettingKey, string>>
export type SecretStorageMode = 'env' | 'keyring'

export const SECRET_ENV_KEY_BY_SETTING: Record<SecretSettingKey, string> = {
  transcriptionOpenAIApiKey: 'WHISPY_TRANSCRIPTION_OPENAI_API_KEY',
  transcriptionGrokApiKey: 'WHISPY_TRANSCRIPTION_GROK_API_KEY',
  transcriptionGroqApiKey: 'WHISPY_TRANSCRIPTION_GROQ_API_KEY',
  transcriptionMetaApiKey: 'WHISPY_TRANSCRIPTION_META_API_KEY',
  transcriptionCustomApiKey: 'WHISPY_TRANSCRIPTION_CUSTOM_API_KEY',
  postProcessingOpenAIApiKey: 'WHISPY_POST_OPENAI_API_KEY',
  postProcessingGrokApiKey: 'WHISPY_POST_GROK_API_KEY',
  postProcessingGroqApiKey: 'WHISPY_POST_GROQ_API_KEY',
  postProcessingMetaApiKey: 'WHISPY_POST_META_API_KEY',
  postProcessingCustomApiKey: 'WHISPY_POST_CUSTOM_API_KEY',
}

export const extractSecretSettings = (settings: AppSettings): SecretSettingsMap => {
  const secrets: SecretSettingsMap = {}

  for (const key of SECRET_SETTING_KEYS) {
    secrets[key] = settings[key]
  }

  return secrets
}

export const stripSecretsFromSettings = (settings: AppSettings): AppSettings => {
  const nextSettings = {
    ...settings,
  }

  for (const key of SECRET_SETTING_KEYS) {
    nextSettings[key] = ''
  }

  return nextSettings
}

export const applySecretsToSettings = (settings: AppSettings, secrets: SecretSettingsMap): AppSettings => {
  const nextSettings = {
    ...settings,
  }

  for (const key of SECRET_SETTING_KEYS) {
    const secretValue = secrets[key]
    if (typeof secretValue === 'string') {
      nextSettings[key] = secretValue
    }
  }

  return nextSettings
}
