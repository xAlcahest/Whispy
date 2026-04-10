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

const MASKED_SECRET_PREFIX = '\u2022\u2022\u2022\u2022'

export const maskSecretValue = (value: string): string => {
  if (!value || !value.trim()) return ''
  const trimmed = value.trim()
  if (trimmed.length <= 4) return MASKED_SECRET_PREFIX
  return MASKED_SECRET_PREFIX + trimmed.slice(-4)
}

export const isSecretMasked = (value: string): boolean => {
  return typeof value === 'string' && value.startsWith(MASKED_SECRET_PREFIX)
}

export const maskSecretsInSettings = (settings: AppSettings): AppSettings => {
  const masked = { ...settings }
  for (const key of SECRET_SETTING_KEYS) {
    masked[key] = maskSecretValue(masked[key])
  }
  return masked
}

export const resolveSecretsForPersistence = (
  incoming: AppSettings,
  existingSecrets: SecretSettingsMap,
): { settings: AppSettings; secrets: SecretSettingsMap } => {
  const resolved = { ...incoming }
  const updatedSecrets: SecretSettingsMap = {}

  for (const key of SECRET_SETTING_KEYS) {
    if (isSecretMasked(resolved[key])) {
      resolved[key] = existingSecrets[key] ?? ''
    }
    updatedSecrets[key] = resolved[key]
  }

  return { settings: resolved, secrets: updatedSecrets }
}

export const resolveApiKeyFromMasked = (
  maskedKey: string,
  settingsWithSecrets: AppSettings,
): string => {
  if (!isSecretMasked(maskedKey)) return maskedKey
  for (const key of SECRET_SETTING_KEYS) {
    const realValue = settingsWithSecrets[key]
    if (realValue && maskSecretValue(realValue) === maskedKey) {
      return realValue
    }
  }
  return ''
}

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
