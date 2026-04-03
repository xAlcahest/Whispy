import {
  STORAGE_KEYS,
  createDefaultModelState,
  createDefaultPostModelState,
  normalizeModelState,
  normalizeSettings,
} from './constants'
import { electronAPI } from './electron-api'
import type { AppSettings, HistoryEntry, ModelState } from '../types/app'
import { SECRET_SETTING_KEYS, extractSecretSettings, stripSecretsFromSettings } from '../../../shared/secrets'
import type { NotesSnapshotPayload } from '../../../shared/ipc'

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
  autoTitleGenerated?: boolean
  createdAt: number
  updatedAt: number
}

export interface NoteAction {
  id: string
  name: string
  description: string
  instructions: string
  isBuiltIn: boolean
  createdAt: number
  updatedAt: number
}

export interface NoteProcessingEvent {
  id: string
  timestamp: number
  noteId: string
  noteTitle: string
  actionId: string | null
  actionName: string
  provider: string
  model: string
  inputWords: number
  inputTokens: number
  outputWords: number
  outputTokens: number
  durationSeconds: number
  postProcessingApplied: boolean
  estimated: boolean
  costUSD: number
}

export interface DictationStatsLogPayload {
  count: number
  enhancedCount: number
  durationSeconds: number
  words: number
  tokens: number
  transcriptionCostUSD: number
  enhancementCostUSD: number
  totalCostUSD: number
}

export interface NotesStatsLogPayload {
  count: number
  enhancedCount: number
  draftCount: number
  estimatedReadDurationSeconds: number
  words: number
  tokens: number
  costUSD: number
}

export interface CombinedStatsLogPayload {
  durationSeconds: number
  words: number
  tokens: number
  costUSD: number
}

export interface DetailedStatsLogEntry {
  id: string
  timestamp: number
  dictations: DictationStatsLogPayload
  notes: NotesStatsLogPayload
  combined: CombinedStatsLogPayload
}

export const DEFAULT_NOTE_ACTION_ID = 'builtin-cleanup-notes'

const DEFAULT_NOTE_ACTION: NoteAction = {
  id: DEFAULT_NOTE_ACTION_ID,
  name: 'Clean Up Notes',
  description: 'Fix grammar, structure, and formatting',
  instructions:
    'Clean up grammar, improve structure, and format these notes for readability while preserving all original meaning.',
  isBuiltIn: true,
  createdAt: 0,
  updatedAt: 0,
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
  const serialized = JSON.stringify(stripSecretsFromSettings(settings))
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

const sortNoteActions = (actions: NoteAction[]) => {
  return [...actions].sort((left, right) => {
    if (left.isBuiltIn && !right.isBuiltIn) {
      return -1
    }

    if (!left.isBuiltIn && right.isBuiltIn) {
      return 1
    }

    return left.name.localeCompare(right.name, undefined, { sensitivity: 'base' })
  })
}

const sortNoteProcessingEvents = (events: NoteProcessingEvent[]) => {
  return [...events].sort((left, right) => right.timestamp - left.timestamp)
}

const sortDetailedStatsLogs = (entries: DetailedStatsLogEntry[]) => {
  return [...entries].sort((left, right) => right.timestamp - left.timestamp)
}

const normalizeFiniteNumber = (value: unknown, fallback = 0) =>
  typeof value === 'number' && Number.isFinite(value) ? value : fallback

const normalizeNonNegativeInt = (value: unknown, fallback = 0) => {
  const numeric = normalizeFiniteNumber(value, fallback)
  return Math.max(0, Math.floor(numeric))
}

const normalizeNoteProcessingEvent = (value: Partial<NoteProcessingEvent>): NoteProcessingEvent | null => {
  const id = typeof value.id === 'string' ? value.id.trim() : ''
  const noteId = typeof value.noteId === 'string' ? value.noteId.trim() : ''
  const timestamp = normalizeFiniteNumber(value.timestamp, 0)
  if (!id || !noteId || timestamp <= 0) {
    return null
  }

  return {
    id,
    timestamp,
    noteId,
    noteTitle: typeof value.noteTitle === 'string' ? value.noteTitle.trim() : '',
    actionId: typeof value.actionId === 'string' ? value.actionId.trim() : null,
    actionName: typeof value.actionName === 'string' && value.actionName.trim().length > 0 ? value.actionName.trim() : 'Cleanup',
    provider: typeof value.provider === 'string' && value.provider.trim().length > 0 ? value.provider.trim() : 'unknown-provider',
    model: typeof value.model === 'string' && value.model.trim().length > 0 ? value.model.trim() : 'unknown-model',
    inputWords: normalizeNonNegativeInt(value.inputWords),
    inputTokens: normalizeNonNegativeInt(value.inputTokens),
    outputWords: normalizeNonNegativeInt(value.outputWords),
    outputTokens: normalizeNonNegativeInt(value.outputTokens),
    durationSeconds: Math.max(0, normalizeFiniteNumber(value.durationSeconds)),
    postProcessingApplied: Boolean(value.postProcessingApplied),
    estimated: Boolean(value.estimated),
    costUSD: Math.max(0, normalizeFiniteNumber(value.costUSD)),
  }
}

const normalizeDetailedStatsLogEntry = (value: Partial<DetailedStatsLogEntry>): DetailedStatsLogEntry | null => {
  const id = typeof value.id === 'string' ? value.id.trim() : ''
  const timestamp = normalizeFiniteNumber(value.timestamp, 0)
  if (!id || timestamp <= 0) {
    return null
  }

  const dictations = value.dictations ?? ({} as DictationStatsLogPayload)
  const notes = value.notes ?? ({} as NotesStatsLogPayload)
  const combined = value.combined ?? ({} as CombinedStatsLogPayload)

  return {
    id,
    timestamp,
    dictations: {
      count: normalizeFiniteNumber(dictations.count),
      enhancedCount: normalizeFiniteNumber(dictations.enhancedCount),
      durationSeconds: normalizeFiniteNumber(dictations.durationSeconds),
      words: normalizeFiniteNumber(dictations.words),
      tokens: normalizeFiniteNumber(dictations.tokens),
      transcriptionCostUSD: normalizeFiniteNumber(dictations.transcriptionCostUSD),
      enhancementCostUSD: normalizeFiniteNumber(dictations.enhancementCostUSD),
      totalCostUSD: normalizeFiniteNumber(dictations.totalCostUSD),
    },
    notes: {
      count: normalizeFiniteNumber(notes.count),
      enhancedCount: normalizeFiniteNumber(notes.enhancedCount),
      draftCount: normalizeFiniteNumber(notes.draftCount),
      estimatedReadDurationSeconds: normalizeFiniteNumber(notes.estimatedReadDurationSeconds),
      words: normalizeFiniteNumber(notes.words),
      tokens: normalizeFiniteNumber(notes.tokens),
      costUSD: normalizeFiniteNumber(notes.costUSD),
    },
    combined: {
      durationSeconds: normalizeFiniteNumber(combined.durationSeconds),
      words: normalizeFiniteNumber(combined.words),
      tokens: normalizeFiniteNumber(combined.tokens),
      costUSD: normalizeFiniteNumber(combined.costUSD),
    },
  }
}

const normalizeNoteAction = (action: Partial<NoteAction>): NoteAction | null => {
  const normalizedId = action.id?.trim() ?? ''
  const normalizedName = action.name?.trim() ?? ''
  const normalizedInstructions = action.instructions?.trim() ?? ''

  if (!normalizedId || !normalizedName || !normalizedInstructions) {
    return null
  }

  return {
    id: normalizedId,
    name: normalizedName,
    description: action.description?.trim() ?? '',
    instructions: normalizedInstructions,
    isBuiltIn: Boolean(action.isBuiltIn || normalizedId === DEFAULT_NOTE_ACTION_ID),
    createdAt: Number.isFinite(action.createdAt) ? Number(action.createdAt) : Date.now(),
    updatedAt: Number.isFinite(action.updatedAt) ? Number(action.updatedAt) : Date.now(),
  }
}

const ensureDefaultNoteActions = (actions: NoteAction[]): NoteAction[] => {
  const normalized = actions
    .map((action) => normalizeNoteAction(action))
    .filter((action): action is NoteAction => action !== null)

  const withoutDuplicate = normalized.filter(
    (action, index) => normalized.findIndex((candidate) => candidate.id === action.id) === index,
  )

  const withoutBuiltin = withoutDuplicate.filter((action) => action.id !== DEFAULT_NOTE_ACTION_ID)
  return sortNoteActions([DEFAULT_NOTE_ACTION, ...withoutBuiltin])
}

const normalizeNotesSnapshot = (snapshot: NotesSnapshotPayload): NotesSnapshotPayload => {
  return {
    folders: sortNoteFolders(snapshot.folders),
    notes: sortNotes(snapshot.notes),
    actions: ensureDefaultNoteActions(snapshot.actions),
  }
}

const persistNotesSnapshotLocally = (snapshot: NotesSnapshotPayload) => {
  const normalized = normalizeNotesSnapshot(snapshot)
  localStorage.setItem(STORAGE_KEYS.noteFolders, JSON.stringify(normalized.folders))
  localStorage.setItem(STORAGE_KEYS.notes, JSON.stringify(normalized.notes))
  localStorage.setItem(STORAGE_KEYS.noteActions, JSON.stringify(normalized.actions))
}

const syncNotesSnapshotToBackend = () => {
  if (!isElectronRuntime()) {
    return
  }

  const notesSnapshot: NotesSnapshotPayload = {
    folders: loadNoteFolders(),
    notes: loadNotes(),
    actions: loadNoteActions(),
  }

  syncToBackend(() => electronAPI.setNotesSnapshot(notesSnapshot))
}

export const hydrateStorageFromBackend = async () => {
  if (!isElectronRuntime()) {
    return false
  }

  try {
    const snapshot = await electronAPI.getBackendState()
    const localNotesSnapshot: NotesSnapshotPayload = {
      folders: loadNoteFolders(),
      notes: loadNotes(),
      actions: loadNoteActions(),
    }

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
        electronAPI.setNotesSnapshot(localNotesSnapshot),
      ])

      return false
    }

    runtimeSettingsCache = snapshot.settings
    persistSettingsLocally(snapshot.settings)
    localStorage.setItem(STORAGE_KEYS.history, JSON.stringify(snapshot.history))
    localStorage.setItem(STORAGE_KEYS.models, JSON.stringify(snapshot.models))
    localStorage.setItem(STORAGE_KEYS.postModels, JSON.stringify(snapshot.postModels))
    localStorage.setItem(STORAGE_KEYS.onboardingCompleted, String(snapshot.onboardingCompleted))

    try {
      const backendNotesSnapshot = normalizeNotesSnapshot(await electronAPI.getNotesSnapshot())
      const hasBackendCustomActions = backendNotesSnapshot.actions.some((action) => !action.isBuiltIn)
      const hasBackendNotes =
        backendNotesSnapshot.folders.length > 0 || backendNotesSnapshot.notes.length > 0 || hasBackendCustomActions

      const hasLocalCustomActions = localNotesSnapshot.actions.some((action) => !action.isBuiltIn)
      const hasLocalNotes = localNotesSnapshot.folders.length > 0 || localNotesSnapshot.notes.length > 0 || hasLocalCustomActions

      if (hasBackendNotes) {
        persistNotesSnapshotLocally(backendNotesSnapshot)
      } else if (hasLocalNotes) {
        await electronAPI.setNotesSnapshot(localNotesSnapshot)
      }
    } catch {
      // Ignore notes hydration errors and keep local cache.
    }

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
  const previousNonSecrets = runtimeSettingsCache ? JSON.stringify(stripSecretsFromSettings(runtimeSettingsCache)) : null
  const nextNonSecrets = JSON.stringify(stripSecretsFromSettings(normalizedSettings))

  const previousSecrets = runtimeSettingsCache ? JSON.stringify(extractSecretSettings(runtimeSettingsCache)) : null
  const nextSecrets = JSON.stringify(extractSecretSettings(normalizedSettings))

  runtimeSettingsCache = normalizedSettings
  persistSettingsLocally(normalizedSettings)
  if (previousNonSecrets === nextNonSecrets && previousSecrets === nextSecrets) {
    return
  }

  syncToBackend(() => electronAPI.setBackendSettings(normalizedSettings))
}

export const loadHistory = (): HistoryEntry[] => {
  const entries = parseStorage<HistoryEntry[]>(localStorage.getItem(STORAGE_KEYS.history), [])
  return sortHistory(
    entries.map((entry) => ({
      ...entry,
      durationSeconds:
        typeof entry.durationSeconds === 'number' && Number.isFinite(entry.durationSeconds)
          ? entry.durationSeconds
          : undefined,
      rawText: typeof entry.rawText === 'string' ? entry.rawText : undefined,
      enhancedText: typeof entry.enhancedText === 'string' ? entry.enhancedText : undefined,
      postProcessingApplied:
        typeof entry.postProcessingApplied === 'boolean' ? entry.postProcessingApplied : undefined,
      postProcessingProvider:
        typeof entry.postProcessingProvider === 'string' ? entry.postProcessingProvider : undefined,
      postProcessingModel: typeof entry.postProcessingModel === 'string' ? entry.postProcessingModel : undefined,
    })),
  )
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
  syncNotesSnapshotToBackend()
}

export const loadNotes = (): NoteEntry[] => {
  const notes = parseStorage<NoteEntry[]>(localStorage.getItem(STORAGE_KEYS.notes), [])
  return sortNotes(
    notes.map((note) => ({
      ...note,
      autoTitleGenerated: Boolean(note.autoTitleGenerated),
    })),
  )
}

export const saveNotes = (notes: NoteEntry[]) => {
  localStorage.setItem(STORAGE_KEYS.notes, JSON.stringify(sortNotes(notes)))
  syncNotesSnapshotToBackend()
}

export const loadNoteActions = (): NoteAction[] => {
  const actions = parseStorage<Partial<NoteAction>[]>(localStorage.getItem(STORAGE_KEYS.noteActions), [])
  return ensureDefaultNoteActions(actions as NoteAction[])
}

export const saveNoteActions = (actions: NoteAction[]) => {
  localStorage.setItem(STORAGE_KEYS.noteActions, JSON.stringify(ensureDefaultNoteActions(actions)))
  syncNotesSnapshotToBackend()
}

export const loadNoteProcessingEvents = (): NoteProcessingEvent[] => {
  const events = parseStorage<Partial<NoteProcessingEvent>[]>(localStorage.getItem(STORAGE_KEYS.noteProcessingEvents), [])
  const normalized = events
    .map((entry) => normalizeNoteProcessingEvent(entry))
    .filter((entry): entry is NoteProcessingEvent => entry !== null)

  return sortNoteProcessingEvents(normalized)
}

export const saveNoteProcessingEvents = (events: NoteProcessingEvent[]) => {
  const normalized = events
    .map((entry) => normalizeNoteProcessingEvent(entry))
    .filter((entry): entry is NoteProcessingEvent => entry !== null)

  try {
    localStorage.setItem(STORAGE_KEYS.noteProcessingEvents, JSON.stringify(sortNoteProcessingEvents(normalized).slice(0, 5000)))
  } catch {
    localStorage.setItem(STORAGE_KEYS.noteProcessingEvents, JSON.stringify(sortNoteProcessingEvents(normalized).slice(0, 1000)))
  }
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

export const loadDetailedStatsLogs = (): DetailedStatsLogEntry[] => {
  const entries = parseStorage<Partial<DetailedStatsLogEntry>[]>(localStorage.getItem(STORAGE_KEYS.detailedStatsLogs), [])
  const normalized = entries
    .map((entry) => normalizeDetailedStatsLogEntry(entry))
    .filter((entry): entry is DetailedStatsLogEntry => entry !== null)

  return sortDetailedStatsLogs(normalized)
}

export const saveDetailedStatsLogs = (entries: DetailedStatsLogEntry[]) => {
  const normalized = entries
    .map((entry) => normalizeDetailedStatsLogEntry(entry))
    .filter((entry): entry is DetailedStatsLogEntry => entry !== null)

  localStorage.setItem(STORAGE_KEYS.detailedStatsLogs, JSON.stringify(sortDetailedStatsLogs(normalized).slice(0, 500)))
}
