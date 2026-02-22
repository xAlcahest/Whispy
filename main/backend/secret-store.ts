import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname } from 'node:path'
import { safeStorage } from 'electron'
import type { AppSettings } from '../../shared/app'
import type { SecretSettingKey, SecretSettingsMap, SecretStorageMode } from '../../shared/secrets'
import { SECRET_ENV_KEY_BY_SETTING, SECRET_SETTING_KEYS } from '../../shared/secrets'

interface KeytarModule {
  getPassword(service: string, account: string): Promise<string | null>
  setPassword(service: string, account: string, password: string): Promise<void>
  deletePassword(service: string, account: string): Promise<boolean>
}

export interface SecretStorageStatus {
  mode: SecretStorageMode
  activeBackend: SecretStorageMode
  fallbackActive: boolean
  keyringSupported: boolean
  envFilePath: string
  details: string
}

export interface SecretMigrationResult {
  success: boolean
  details: string
}

const KEYCHAIN_SERVICE_NAME = 'Whispy'

const accountForKey = (key: SecretSettingKey) => `settings:${key}`

const parseEnvValue = (rawValue: string) => {
  const trimmed = rawValue.trim()
  if (
    (trimmed.startsWith('"') && trimmed.endsWith('"')) ||
    (trimmed.startsWith("'") && trimmed.endsWith("'"))
  ) {
    return trimmed.slice(1, -1)
  }

  return trimmed
}

const serializeEnvValue = (value: string) => {
  if (/^[A-Za-z0-9_./:@-]+$/.test(value)) {
    return value
  }

  return JSON.stringify(value)
}

const NON_SECRET_ENV_KEY_BY_SETTING = {
  hotkey: 'WHISPY_HOTKEY',
  activationMode: 'WHISPY_ACTIVATION_MODE',
  autoHideFloatingIcon: 'WHISPY_AUTO_HIDE_FLOATING_ICON',
  overlayRuntimeBadgeEnabled: 'WHISPY_OVERLAY_RUNTIME_BADGE_ENABLED',
  overlayRuntimeBadgeOnlyOnUse: 'WHISPY_OVERLAY_RUNTIME_BADGE_ONLY_ON_USE',
  launchAtLogin: 'WHISPY_LAUNCH_AT_LOGIN',
  theme: 'WHISPY_THEME',
  autoPasteBackend: 'WHISPY_AUTO_PASTE_BACKEND',
  autoPasteMode: 'WHISPY_AUTO_PASTE_MODE',
  autoPasteShortcut: 'WHISPY_AUTO_PASTE_SHORTCUT',
  whisperCppRuntimeVariant: 'WHISPY_WHISPER_RUNTIME_VARIANT',
  transcriptionRuntime: 'WHISPY_TRANSCRIPTION_RUNTIME',
  postProcessingRuntime: 'WHISPY_POST_RUNTIME',
  translationModeEnabled: 'WHISPY_TRANSLATION_MODE_ENABLED',
  translationHotkeyMode: 'WHISPY_TRANSLATION_HOTKEY_MODE',
  translationCustomHotkey: 'WHISPY_TRANSLATION_CUSTOM_HOTKEY',
  historyRetentionLimit: 'WHISPY_HISTORY_RETENTION_LIMIT',
  debugModeEnabled: 'WHISPY_DEBUG_MODE',
} as const satisfies Partial<Record<keyof AppSettings, string>>

type NonSecretSettingKey = keyof typeof NON_SECRET_ENV_KEY_BY_SETTING

const BOOLEAN_NON_SECRET_SETTING_KEYS = new Set<NonSecretSettingKey>([
  'autoHideFloatingIcon',
  'overlayRuntimeBadgeEnabled',
  'overlayRuntimeBadgeOnlyOnUse',
  'launchAtLogin',
  'translationModeEnabled',
  'debugModeEnabled',
])

const NUMBER_NON_SECRET_SETTING_KEYS = new Set<NonSecretSettingKey>(['historyRetentionLimit'])

const parseBooleanEnvValue = (rawValue: string): boolean | null => {
  const normalized = rawValue.trim().toLowerCase()
  if (['1', 'true', 'yes', 'on'].includes(normalized)) {
    return true
  }

  if (['0', 'false', 'no', 'off'].includes(normalized)) {
    return false
  }

  return null
}

export class SecretStore {
  private readonly fallbackSecrets = new Map<SecretSettingKey, string>()
  private keytarPromise: Promise<KeytarModule | null> | null = null
  private keytarUnavailableReason =
    'Your desktop environment and/or compositor is not supported for system keyring integration.'
  private keyringFallbackReason: string | null = null

  constructor(
    private readonly fallbackEncryptedSecretsPath: string,
    private readonly plaintextSecretsEnvPath: string,
  ) {
    this.loadEncryptedFallbackSecrets()
  }

  async getSecrets(mode: SecretStorageMode): Promise<SecretSettingsMap> {
    if (mode === 'env') {
      this.keyringFallbackReason = null
      return this.getPlaintextEnvSecrets()
    }

    const keytar = await this.loadKeytar()
    if (!keytar) {
      this.keyringFallbackReason = `${this.keytarUnavailableReason} Falling back to plaintext .env storage.`
      return this.getPlaintextEnvSecrets()
    }

    try {
      const secretEntries = await Promise.all(
        SECRET_SETTING_KEYS.map(async (key) => {
          const value = await keytar.getPassword(KEYCHAIN_SERVICE_NAME, accountForKey(key))
          return [key, value] as const
        }),
      )

      const secrets: SecretSettingsMap = {}
      for (const [key, value] of secretEntries) {
        if (value) {
          secrets[key] = value
        }
      }

      this.keyringFallbackReason = null

      return secrets
    } catch {
      this.keyringFallbackReason = 'Unable to read API keys from the system keyring. Falling back to plaintext .env storage.'
      return this.getPlaintextEnvSecrets()
    }
  }

  async setSecrets(mode: SecretStorageMode, secrets: SecretSettingsMap) {
    if (mode === 'env') {
      this.writePlaintextEnvSecrets(secrets)
      this.keyringFallbackReason = null
      return
    }

    const keytar = await this.loadKeytar()
    if (!keytar) {
      this.writePlaintextEnvSecrets(secrets)
      this.keyringFallbackReason = `${this.keytarUnavailableReason} Falling back to plaintext .env storage.`
      return
    }

    try {
      await Promise.all(
        SECRET_SETTING_KEYS.map(async (key) => {
          const value = secrets[key]?.trim() ?? ''
          if (!value) {
            await keytar.deletePassword(KEYCHAIN_SERVICE_NAME, accountForKey(key))
            return
          }

          await keytar.setPassword(KEYCHAIN_SERVICE_NAME, accountForKey(key), value)
        }),
      )
      this.clearPlaintextEnvSecrets()
      this.writeFallbackSecrets({})
      this.keyringFallbackReason = null
    } catch {
      this.writePlaintextEnvSecrets(secrets)
      this.keyringFallbackReason =
        'Unable to write API keys into the system keyring. Falling back to plaintext .env storage.'
    }
  }

  async getStorageStatus(mode: SecretStorageMode): Promise<SecretStorageStatus> {
    const keyringSupported = Boolean(await this.loadKeytar())
    const fallbackActive = mode === 'keyring' && (!keyringSupported || this.keyringFallbackReason !== null)

    if (mode === 'env') {
      return {
        mode,
        activeBackend: 'env',
        fallbackActive: false,
        keyringSupported,
        envFilePath: this.plaintextSecretsEnvPath,
        details: 'Plaintext .env mode is active.',
      }
    }

    const activeBackend: SecretStorageMode = fallbackActive ? 'env' : 'keyring'

    return {
      mode,
      activeBackend,
      fallbackActive,
      keyringSupported,
      envFilePath: this.plaintextSecretsEnvPath,
      details: fallbackActive
        ? this.keyringFallbackReason ?? `${this.keytarUnavailableReason} Falling back to plaintext .env storage.`
        : 'System keyring integration is active.',
    }
  }

  getNonSecretSettings(): Partial<AppSettings> {
    const envEntries = this.readPlaintextEnvMap()
    const settings: Partial<Record<NonSecretSettingKey, AppSettings[NonSecretSettingKey]>> = {}

    for (const [settingKey, envKey] of Object.entries(NON_SECRET_ENV_KEY_BY_SETTING) as [NonSecretSettingKey, string][]) {
      const rawValue = envEntries[envKey] ?? process.env[envKey]
      if (typeof rawValue !== 'string' || rawValue.trim().length === 0) {
        continue
      }

      if (BOOLEAN_NON_SECRET_SETTING_KEYS.has(settingKey)) {
        const parsedBoolean = parseBooleanEnvValue(rawValue)
        if (parsedBoolean !== null) {
          settings[settingKey] = parsedBoolean
        }
        continue
      }

      if (NUMBER_NON_SECRET_SETTING_KEYS.has(settingKey)) {
        const parsedNumber = Number.parseInt(rawValue, 10)
        if (Number.isFinite(parsedNumber)) {
          settings[settingKey] = parsedNumber
        }
        continue
      }

      settings[settingKey] = rawValue
    }

    return settings as Partial<AppSettings>
  }

  setNonSecretSettings(settings: AppSettings) {
    const envEntries = this.readPlaintextEnvMap()

    for (const [settingKey, envKey] of Object.entries(NON_SECRET_ENV_KEY_BY_SETTING) as [NonSecretSettingKey, string][]) {
      const value = settings[settingKey]

      if (typeof value === 'boolean') {
        envEntries[envKey] = value ? '1' : '0'
        continue
      }

      if (typeof value === 'number') {
        envEntries[envKey] = String(value)
        continue
      }

      if (typeof value === 'string' && value.trim().length > 0) {
        envEntries[envKey] = value
        continue
      }

      delete envEntries[envKey]
    }

    this.persistPlaintextEnvMap(envEntries)
  }

  ensurePlaintextEnvFile() {
    const envEntries = this.readPlaintextEnvMap()
    this.persistPlaintextEnvMap(envEntries)
    return this.plaintextSecretsEnvPath
  }

  async migratePlaintextEnvToKeyring(): Promise<SecretMigrationResult> {
    const keytar = await this.loadKeytar()
    if (!keytar) {
      return {
        success: false,
        details: this.keytarUnavailableReason,
      }
    }

    const plaintextSecrets = this.getPlaintextEnvSecrets()
    const hasSecretsToMigrate = SECRET_SETTING_KEYS.some((key) => Boolean(plaintextSecrets[key]?.trim()))

    if (!hasSecretsToMigrate) {
      return {
        success: false,
        details: `No plaintext API keys found in ${this.plaintextSecretsEnvPath}.`,
      }
    }

    try {
      await Promise.all(
        SECRET_SETTING_KEYS.map(async (key) => {
          const value = plaintextSecrets[key]?.trim() ?? ''
          if (!value) {
            return
          }

          await keytar.setPassword(KEYCHAIN_SERVICE_NAME, accountForKey(key), value)
        }),
      )
    } catch {
      return {
        success: false,
        details: 'Unable to write API keys into the system keyring.',
      }
    }

    this.clearPlaintextEnvSecrets()
    this.writeFallbackSecrets({})
    this.keyringFallbackReason = null

    return {
      success: true,
      details: 'API keys migrated from plaintext .env storage to the system keyring.',
    }
  }

  private async loadKeytar(): Promise<KeytarModule | null> {
    if (!this.keytarPromise) {
      this.keytarPromise = import('keytar')
        .then((module) => {
          const maybeDefault = (module as { default?: unknown }).default
          const maybeNestedDefault =
            maybeDefault && typeof maybeDefault === 'object'
              ? (maybeDefault as { default?: unknown }).default
              : undefined

          const candidates = [module, maybeDefault, maybeNestedDefault]
          for (const candidate of candidates) {
            if (
              candidate &&
              typeof (candidate as KeytarModule).getPassword === 'function' &&
              typeof (candidate as KeytarModule).setPassword === 'function' &&
              typeof (candidate as KeytarModule).deletePassword === 'function'
            ) {
              return candidate as KeytarModule
            }
          }

          return null
        })
        .catch(() => null)
    }

    const loadedKeytar = await this.keytarPromise
    if (!loadedKeytar) {
      this.keytarUnavailableReason =
        'Your desktop environment and/or compositor is not supported for system keyring integration.'
    }

    return loadedKeytar
  }

  private getPlaintextEnvSecrets(): SecretSettingsMap {
    const envFileEntries = this.readPlaintextEnvMap()
    const secrets: SecretSettingsMap = {}

    for (const key of SECRET_SETTING_KEYS) {
      const envKey = SECRET_ENV_KEY_BY_SETTING[key]
      const value = envFileEntries[envKey] ?? process.env[envKey]
      if (typeof value === 'string' && value.trim().length > 0) {
        secrets[key] = value
      }
    }

    return secrets
  }

  private writePlaintextEnvSecrets(secrets: SecretSettingsMap) {
    const envEntries = this.readPlaintextEnvMap()

    for (const key of SECRET_SETTING_KEYS) {
      const envKey = SECRET_ENV_KEY_BY_SETTING[key]
      const value = secrets[key]?.trim() ?? ''
      if (!value) {
        delete envEntries[envKey]
        continue
      }

      envEntries[envKey] = value
    }

    this.persistPlaintextEnvMap(envEntries)
  }

  private clearPlaintextEnvSecrets() {
    const envEntries = this.readPlaintextEnvMap()

    for (const key of SECRET_SETTING_KEYS) {
      const envKey = SECRET_ENV_KEY_BY_SETTING[key]
      delete envEntries[envKey]
    }

    this.persistPlaintextEnvMap(envEntries)
  }

  private readPlaintextEnvMap(): Record<string, string> {
    if (!existsSync(this.plaintextSecretsEnvPath)) {
      return {}
    }

    try {
      const rawPayload = readFileSync(this.plaintextSecretsEnvPath, 'utf8')
      const map: Record<string, string> = {}

      for (const line of rawPayload.split('\n')) {
        const trimmed = line.trim()
        if (!trimmed || trimmed.startsWith('#')) {
          continue
        }

        const separatorIndex = trimmed.indexOf('=')
        if (separatorIndex <= 0) {
          continue
        }

        const key = trimmed.slice(0, separatorIndex).trim()
        const value = parseEnvValue(trimmed.slice(separatorIndex + 1))
        if (key.length > 0) {
          map[key] = value
        }
      }

      return map
    } catch {
      return {}
    }
  }

  private persistPlaintextEnvMap(envEntries: Record<string, string>) {
    try {
      mkdirSync(dirname(this.plaintextSecretsEnvPath), { recursive: true })
      const lines = Object.entries(envEntries)
        .sort(([left], [right]) => left.localeCompare(right))
        .map(([key, value]) => `${key}=${serializeEnvValue(value)}`)

      const payload = ['# Whispy plaintext secrets (generated)', ...lines].join('\n')
      writeFileSync(this.plaintextSecretsEnvPath, `${payload}\n`, {
        encoding: 'utf8',
        mode: 0o600,
      })
      chmodSync(this.plaintextSecretsEnvPath, 0o600)
    } catch {
      // Ignore plaintext env write errors.
    }
  }

  private getFallbackSecretsSnapshot(): SecretSettingsMap {
    const secrets: SecretSettingsMap = {}

    for (const key of SECRET_SETTING_KEYS) {
      const value = this.fallbackSecrets.get(key)
      if (value) {
        secrets[key] = value
      }
    }

    return secrets
  }

  private writeFallbackSecrets(secrets: SecretSettingsMap) {
    for (const key of SECRET_SETTING_KEYS) {
      const value = secrets[key]
      if (value) {
        this.fallbackSecrets.set(key, value)
      } else {
        this.fallbackSecrets.delete(key)
      }
    }

    this.persistEncryptedFallbackSecrets()
  }

  private loadEncryptedFallbackSecrets() {
    if (!safeStorage.isEncryptionAvailable()) {
      return
    }

    try {
      const encryptedPayload = readFileSync(this.fallbackEncryptedSecretsPath)
      const decryptedPayload = safeStorage.decryptString(encryptedPayload)
      const parsed = JSON.parse(decryptedPayload) as SecretSettingsMap

      for (const key of SECRET_SETTING_KEYS) {
        const value = parsed[key]
        if (value) {
          this.fallbackSecrets.set(key, value)
        }
      }
    } catch {
      // Ignore missing/invalid encrypted fallback secrets.
    }
  }

  private persistEncryptedFallbackSecrets() {
    if (!safeStorage.isEncryptionAvailable()) {
      return
    }

    const payload: SecretSettingsMap = {}
    for (const key of SECRET_SETTING_KEYS) {
      const value = this.fallbackSecrets.get(key)
      if (value) {
        payload[key] = value
      }
    }

    try {
      mkdirSync(dirname(this.fallbackEncryptedSecretsPath), { recursive: true })
      const encryptedPayload = safeStorage.encryptString(JSON.stringify(payload))
      writeFileSync(this.fallbackEncryptedSecretsPath, encryptedPayload, {
        mode: 0o600,
      })
      chmodSync(this.fallbackEncryptedSecretsPath, 0o600)
    } catch {
      // Ignore encrypted fallback write errors.
    }
  }
}
