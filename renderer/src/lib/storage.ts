import { DEFAULT_SETTINGS, MODEL_PRESETS, POST_LOCAL_MODEL_PRESETS, STORAGE_KEYS } from './constants'
import type { AppSettings, HistoryEntry, ModelState } from '../types/app'

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

export const loadSettings = (): AppSettings => {
  const parsed = parseStorage<Partial<AppSettings>>(localStorage.getItem(STORAGE_KEYS.settings), {})
  return {
    ...DEFAULT_SETTINGS,
    ...parsed,
  }
}

export const saveSettings = (settings: AppSettings) => {
  localStorage.setItem(STORAGE_KEYS.settings, JSON.stringify(settings))
}

export const loadHistory = (): HistoryEntry[] => {
  const entries = parseStorage<HistoryEntry[]>(localStorage.getItem(STORAGE_KEYS.history), [])
  return [...entries].sort((left, right) => right.timestamp - left.timestamp)
}

export const saveHistory = (entries: HistoryEntry[]) => {
  localStorage.setItem(STORAGE_KEYS.history, JSON.stringify(entries))
}

export const appendHistoryEntry = (entry: HistoryEntry) => {
  const current = loadHistory()
  const nextHistory = [entry, ...current]
  saveHistory(nextHistory)
}

export const clearHistory = () => {
  localStorage.removeItem(STORAGE_KEYS.history)
}

export const isOnboardingCompleted = () =>
  localStorage.getItem(STORAGE_KEYS.onboardingCompleted) === 'true'

export const setOnboardingCompleted = (value: boolean) => {
  localStorage.setItem(STORAGE_KEYS.onboardingCompleted, String(value))
}

export const loadModelState = (): ModelState[] => {
  const fallback: ModelState[] = MODEL_PRESETS.map((model) => ({
    ...model,
    downloaded: model.id === 'small',
    downloading: false,
    progress: model.id === 'small' ? 100 : 0,
  }))

  const parsed = parseStorage<ModelState[]>(localStorage.getItem(STORAGE_KEYS.models), fallback)
  return parsed.map((model) => ({
    ...model,
    downloading: false,
    progress: model.downloaded ? 100 : model.progress,
  }))
}

export const saveModelState = (models: ModelState[]) => {
  localStorage.setItem(STORAGE_KEYS.models, JSON.stringify(models))
}

export const loadPostModelState = (): ModelState[] => {
  const fallback: ModelState[] = POST_LOCAL_MODEL_PRESETS.map((model, index) => ({
    ...model,
    downloaded: index === 0,
    downloading: false,
    progress: index === 0 ? 100 : 0,
  }))

  const parsed = parseStorage<ModelState[]>(localStorage.getItem(STORAGE_KEYS.postModels), fallback)
  return parsed.map((model) => ({
    ...model,
    downloading: false,
    progress: model.downloaded ? 100 : model.progress,
  }))
}

export const savePostModelState = (models: ModelState[]) => {
  localStorage.setItem(STORAGE_KEYS.postModels, JSON.stringify(models))
}
