import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname } from 'node:path'
import { safeStorage } from 'electron'
import type { SecretSettingKey, SecretSettingsMap, SecretStorageMode } from '../../shared/secrets'
import { SECRET_ENV_KEY_BY_SETTING, SECRET_SETTING_KEYS } from '../../shared/secrets'

interface KeytarModule {
  getPassword(service: string, account: string): Promise<string | null>
  setPassword(service: string, account: string, password: string): Promise<void>
  deletePassword(service: string, account: string): Promise<boolean>
}

export interface SecretStorageStatus {
  mode: SecretStorageMode
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

export class SecretStore {
  private readonly fallbackSecrets = new Map<SecretSettingKey, string>()
  private keytarPromise: Promise<KeytarModule | null> | null = null
  private keytarUnavailableReason =
    'Your desktop environment and/or compositor is not supported for system keyring integration.'

  constructor(
    private readonly fallbackEncryptedSecretsPath: string,
    private readonly plaintextSecretsEnvPath: string,
  ) {
    this.loadEncryptedFallbackSecrets()
  }

  async getSecrets(mode: SecretStorageMode): Promise<SecretSettingsMap> {
    if (mode === 'env') {
      return this.getPlaintextEnvSecrets()
    }

    const keytar = await this.loadKeytar()
    if (!keytar) {
      return this.getFallbackSecretsSnapshot()
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

      return secrets
    } catch {
      return this.getFallbackSecretsSnapshot()
    }
  }

  async setSecrets(mode: SecretStorageMode, secrets: SecretSettingsMap) {
    if (mode === 'env') {
      this.writePlaintextEnvSecrets(secrets)
      return
    }

    const keytar = await this.loadKeytar()
    if (!keytar) {
      this.writeFallbackSecrets(secrets)
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
    } catch {
      this.writeFallbackSecrets(secrets)
    }
  }

  async getStorageStatus(mode: SecretStorageMode): Promise<SecretStorageStatus> {
    const keyringSupported = Boolean(await this.loadKeytar())

    return {
      mode,
      keyringSupported,
      envFilePath: this.plaintextSecretsEnvPath,
      details: keyringSupported
        ? 'System keyring integration is available.'
        : this.keytarUnavailableReason,
    }
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
      writeFileSync(this.plaintextSecretsEnvPath, `${payload}\n`, 'utf8')
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
      writeFileSync(this.fallbackEncryptedSecretsPath, encryptedPayload)
    } catch {
      // Ignore encrypted fallback write errors.
    }
  }
}
