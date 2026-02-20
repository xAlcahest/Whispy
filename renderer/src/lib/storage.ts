import {
  STORAGE_KEYS,
  createDefaultModelState,
  createDefaultPostModelState,
  normalizeModelState,
  normalizeSettings,
} from './constants'
import { electronAPI } from './electron-api'
import type { AppSettings, HistoryEntry, ModelState } from '../types/app'
import { SECRET_SETTING_KEYS, stripSecretsFromSettings } from '../../../shared/secrets'

export interface NoteFolder {
  id: string
  name: string
  createdAt: number
  updatedAt: number
}

export interface NoteEntry {
  id: string
  folderId: string | null
  title: string
  rawText: string
  processedText: string
  createdAt: number
  updatedAt: number
}

const parseStorage = <T>(rawValue: string | null, fallback: T) => {
  if (!rawValue) {
    return fallback
  }

  try {
    return JSON.parse(rawValue) as T
  } catch {
    return fallback
  }
}

const isElectronRuntime = () => typeof window !== 'undefined' && typeof window.electronAPI !== 'undefined'

let runtimeSettingsCache: AppSettings | null = null

const persistSettingsLocally = (settings: AppSettings) => {
  if (isElectronRuntime()) {
    const serialized = JSON.stringify(stripSecretsFromSettings(settings))
    if (localStorage.getItem(STORAGE_KEYS.settings) !== serialized) {
      localStorage.setItem(STORAGE_KEYS.settings, serialized)
    }
    return
  }

  const serialized = JSON.stringify(settings)
  if (localStorage.getItem(STORAGE_KEYS.settings) !== serialized) {
    localStorage.setItem(STORAGE_KEYS.settings, serialized)
  }
}

const syncToBackend = (effect: () => Promise<void>) => {
  if (!isElectronRuntime()) {
    return
  }

  void effect().catch(() => {
    // Keep local cache authoritative in fallback/error conditions.
  })
}

const sortHistory = (entries: HistoryEntry[]) => {
  return [...entries].sort((left, right) => right.timestamp - left.timestamp)
}

export const applyHistoryRetentionLimit = (entries: HistoryEntry[], limit: number) => {
  const sortedEntries = sortHistory(entries)
  if (limit < 0) {
    return sortedEntries
  }

  return sortedEntries.slice(0, limit)
}

const sortNoteFolders = (folders: NoteFolder[]) => {
  return [...folders].sort((left, right) => left.name.localeCompare(right.name, undefined, { sensitivity: 'base' }))
}

const sortNotes = (entries: NoteEntry[]) => {
  return [...entries].sort((left, right) => right.updatedAt - left.updatedAt)
}

export const hydrateStorageFromBackend = async () => {
  if (!isElectronRuntime()) {
    return false
  }

  try {
    const snapshot = await electronAPI.getBackendState()
    if (!snapshot) {
      const localSettings = loadSettings()
      const localHistory = loadHistory()
      const localModels = loadModelState()
      const localPostModels = loadPostModelState()
      const onboardingCompleted = isOnboardingCompleted()

      runtimeSettingsCache = localSettings
      persistSettingsLocally(localSettings)

      await Promise.allSettled([
        electronAPI.setBackendSettings(localSettings),
        electronAPI.setBackendHistory(localHistory),
        electronAPI.setBackendModels(localModels),
        electronAPI.setBackendPostModels(localPostModels),
        electronAPI.setBackendOnboardingCompleted(onboardingCompleted),
      ])

      return false
    }

    runtimeSettingsCache = snapshot.settings
    persistSettingsLocally(snapshot.settings)
    localStorage.setItem(STORAGE_KEYS.history, JSON.stringify(snapshot.history))
    localStorage.setItem(STORAGE_KEYS.models, JSON.stringify(snapshot.models))
    localStorage.setItem(STORAGE_KEYS.postModels, JSON.stringify(snapshot.postModels))
    localStorage.setItem(STORAGE_KEYS.onboardingCompleted, String(snapshot.onboardingCompleted))
    return true
  } catch {
    return false
  }
}

export const refreshSettingsFromBackend = async (): Promise<AppSettings> => {
  if (!isElectronRuntime()) {
    return loadSettings()
  }

  try {
    const snapshot = await electronAPI.getBackendState()
    if (snapshot) {
      runtimeSettingsCache = snapshot.settings
      persistSettingsLocally(snapshot.settings)
      return normalizeSettings(snapshot.settings)
    }
  } catch {
    // Ignore backend refresh errors and fallback to local cache.
  }

  return loadSettings()
}

export const loadSettings = (): AppSettings => {
  const parsed = parseStorage<Partial<AppSettings>>(localStorage.getItem(STORAGE_KEYS.settings), {})
  const mergedWithRuntimeSecrets = {
    ...parsed,
  }

  if (isElectronRuntime() && runtimeSettingsCache) {
    for (const key of SECRET_SETTING_KEYS) {
      if (runtimeSettingsCache[key]) {
        mergedWithRuntimeSecrets[key] = runtimeSettingsCache[key]
      }
    }
  }

  const settings = normalizeSettings(mergedWithRuntimeSecrets)

  if (isElectronRuntime()) {
    runtimeSettingsCache = settings
  }

  return settings
}

export const saveSettings = (settings: AppSettings) => {
  const normalizedSettings = normalizeSettings(settings)
  const previousComparable = runtimeSettingsCache ? JSON.stringify(stripSecretsFromSettings(runtimeSettingsCache)) : null
  const nextComparable = JSON.stringify(stripSecretsFromSettings(normalizedSettings))

  runtimeSettingsCache = normalizedSettings
  persistSettingsLocally(normalizedSettings)
  if (previousComparable === nextComparable) {
    return
  }

  syncToBackend(() => electronAPI.setBackendSettings(normalizedSettings))
}

export const loadHistory = (): HistoryEntry[] => {
  const entries = parseStorage<HistoryEntry[]>(localStorage.getItem(STORAGE_KEYS.history), [])
  return sortHistory(entries)
}

export const saveHistory = (entries: HistoryEntry[]) => {
  const retentionLimit = loadSettings().historyRetentionLimit
  const nextHistory = applyHistoryRetentionLimit(entries, retentionLimit)
  localStorage.setItem(STORAGE_KEYS.history, JSON.stringify(nextHistory))
  syncToBackend(() => electronAPI.setBackendHistory(nextHistory))
}

export const appendHistoryEntry = (entry: HistoryEntry) => {
  const current = loadHistory()
  const nextHistory = [entry, ...current]
  saveHistory(nextHistory)
}

export const clearHistory = () => {
  localStorage.removeItem(STORAGE_KEYS.history)
  syncToBackend(() => electronAPI.clearBackendHistory())
}

export const loadNoteFolders = (): NoteFolder[] => {
  const folders = parseStorage<NoteFolder[]>(localStorage.getItem(STORAGE_KEYS.noteFolders), [])
  return sortNoteFolders(folders)
}

export const saveNoteFolders = (folders: NoteFolder[]) => {
  localStorage.setItem(STORAGE_KEYS.noteFolders, JSON.stringify(sortNoteFolders(folders)))
}

export const loadNotes = (): NoteEntry[] => {
  const notes = parseStorage<NoteEntry[]>(localStorage.getItem(STORAGE_KEYS.notes), [])
  return sortNotes(notes)
}

export const saveNotes = (notes: NoteEntry[]) => {
  localStorage.setItem(STORAGE_KEYS.notes, JSON.stringify(sortNotes(notes)))
}

export const isOnboardingCompleted = () =>
  localStorage.getItem(STORAGE_KEYS.onboardingCompleted) === 'true'

export const setOnboardingCompleted = (value: boolean) => {
  localStorage.setItem(STORAGE_KEYS.onboardingCompleted, String(value))
  syncToBackend(() => electronAPI.setBackendOnboardingCompleted(value))
}

export const loadModelState = (): ModelState[] => {
  const fallback = createDefaultModelState()

  const parsed = parseStorage<ModelState[]>(localStorage.getItem(STORAGE_KEYS.models), fallback)
  return normalizeModelState(parsed, fallback)
}

export const saveModelState = (models: ModelState[]) => {
  localStorage.setItem(STORAGE_KEYS.models, JSON.stringify(models))
  syncToBackend(() => electronAPI.setBackendModels(models))
}

export const loadPostModelState = (): ModelState[] => {
  const fallback = createDefaultPostModelState()

  const parsed = parseStorage<ModelState[]>(localStorage.getItem(STORAGE_KEYS.postModels), fallback)
  return normalizeModelState(parsed, fallback)
}

export const savePostModelState = (models: ModelState[]) => {
  localStorage.setItem(STORAGE_KEYS.postModels, JSON.stringify(models))
  syncToBackend(() => electronAPI.setBackendPostModels(models))
}
