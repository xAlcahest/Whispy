import { existsSync, mkdirSync, readFileSync } from 'node:fs'
import { dirname } from 'node:path'
import Database from 'better-sqlite3'
import type { AppSettings, AppStateSnapshot, HistoryEntry, ModelState } from '../../shared/app'
import {
  createDefaultModelState,
  createDefaultPostModelState,
  normalizeModelState,
  normalizeSettings,
} from '../../shared/defaults'

interface AppStateRow {
  settings_json: string
  models_json: string
  post_models_json: string
  onboarding_completed: number
}

interface HistoryRow {
  id: string
  timestamp: number
  language: string
  provider: string
  model: string
  target_app: string
  text: string
  duration_seconds: number | null
  raw_text: string | null
  enhanced_text: string | null
  post_processing_applied: number | null
  post_processing_provider: string | null
  post_processing_model: string | null
}

const sortHistoryDescending = (entries: HistoryEntry[]) => {
  return [...entries].sort((left, right) => right.timestamp - left.timestamp)
}

const parseSerialized = <T>(rawValue: string, fallback: T) => {
  try {
    return JSON.parse(rawValue) as T
  } catch {
    return fallback
  }
}

const createDefaultSnapshot = (): AppStateSnapshot => ({
  settings: normalizeSettings({}),
  history: [],
  models: createDefaultModelState(),
  postModels: createDefaultPostModelState(),
  onboardingCompleted: false,
})

export class BackendStateStore {
  private readonly db: Database.Database

  constructor(
    private readonly stateDbPath: string,
    private readonly legacyStateFilePath: string,
  ) {
    mkdirSync(dirname(this.stateDbPath), { recursive: true })
    this.db = new Database(this.stateDbPath)
    this.db.pragma('journal_mode = WAL')
    this.db.pragma('foreign_keys = ON')
    this.initializeSchema()
    this.migrateLegacyStateFile()
  }

  getSnapshot(): AppStateSnapshot {
    const defaults = createDefaultSnapshot()
    const stateRow = this.db.prepare('SELECT * FROM app_state WHERE id = 1').get() as AppStateRow | undefined
    const historyRows = this.db
      .prepare(
        'SELECT id, timestamp, language, provider, model, target_app, text, duration_seconds, raw_text, enhanced_text, post_processing_applied, post_processing_provider, post_processing_model FROM history ORDER BY timestamp DESC',
      )
      .all() as HistoryRow[]

    const settings = stateRow
      ? normalizeSettings(parseSerialized<Partial<AppSettings>>(stateRow.settings_json, {}))
      : defaults.settings
    const models = stateRow
      ? normalizeModelState(parseSerialized<ModelState[]>(stateRow.models_json, defaults.models), defaults.models)
      : defaults.models
    const postModels = stateRow
      ? normalizeModelState(parseSerialized<ModelState[]>(stateRow.post_models_json, defaults.postModels), defaults.postModels)
      : defaults.postModels
    const onboardingCompleted = stateRow ? Boolean(stateRow.onboarding_completed) : false

    const history = historyRows.map((row) => ({
      id: row.id,
      timestamp: row.timestamp,
      language: row.language,
      provider: row.provider,
      model: row.model,
      targetApp: row.target_app,
      text: row.text,
      durationSeconds:
        typeof row.duration_seconds === 'number' && Number.isFinite(row.duration_seconds)
          ? row.duration_seconds
          : undefined,
      rawText: row.raw_text ?? undefined,
      enhancedText: row.enhanced_text ?? undefined,
      postProcessingApplied:
        row.post_processing_applied === null ? undefined : Boolean(row.post_processing_applied),
      postProcessingProvider: row.post_processing_provider ?? undefined,
      postProcessingModel: row.post_processing_model ?? undefined,
    }))

    return {
      settings,
      history,
      models,
      postModels,
      onboardingCompleted,
    }
  }

  getSnapshotOrNull(): AppStateSnapshot | null {
    if (!this.hasPersistedState()) {
      return null
    }

    return this.getSnapshot()
  }

  setSettings(settings: AppSettings) {
    const currentState = this.readMutableState()
    this.writeStateRow({
      ...currentState,
      settings: normalizeSettings(settings),
    })
  }

  setHistory(entries: HistoryEntry[]) {
    const insertHistory = this.db.prepare(
      `INSERT INTO history (
        id,
        timestamp,
        language,
        provider,
        model,
        target_app,
        text,
        duration_seconds,
        raw_text,
        enhanced_text,
        post_processing_applied,
        post_processing_provider,
        post_processing_model
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    const nextHistory = sortHistoryDescending(entries)

    const transaction = this.db.transaction((historyEntries: HistoryEntry[]) => {
      this.db.prepare('DELETE FROM history').run()

      for (const entry of historyEntries) {
        insertHistory.run(
          entry.id,
          entry.timestamp,
          entry.language,
          entry.provider,
          entry.model,
          entry.targetApp,
          entry.text,
          typeof entry.durationSeconds === 'number' && Number.isFinite(entry.durationSeconds)
            ? entry.durationSeconds
            : null,
          entry.rawText ?? null,
          entry.enhancedText ?? null,
          typeof entry.postProcessingApplied === 'boolean' ? (entry.postProcessingApplied ? 1 : 0) : null,
          entry.postProcessingProvider ?? null,
          entry.postProcessingModel ?? null,
        )
      }
    })

    transaction(nextHistory)
  }

  clearHistory() {
    this.db.prepare('DELETE FROM history').run()
  }

  setModels(models: ModelState[]) {
    const currentState = this.readMutableState()
    this.writeStateRow({
      ...currentState,
      models: normalizeModelState(models, createDefaultModelState()),
    })
  }

  setPostModels(models: ModelState[]) {
    const currentState = this.readMutableState()
    this.writeStateRow({
      ...currentState,
      postModels: normalizeModelState(models, createDefaultPostModelState()),
    })
  }

  setOnboardingCompleted(value: boolean) {
    const currentState = this.readMutableState()
    this.writeStateRow({
      ...currentState,
      onboardingCompleted: value,
    })
  }

  private initializeSchema() {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS app_state (
        id INTEGER PRIMARY KEY CHECK (id = 1),
        settings_json TEXT NOT NULL,
        models_json TEXT NOT NULL,
        post_models_json TEXT NOT NULL,
        onboarding_completed INTEGER NOT NULL DEFAULT 0,
        updated_at INTEGER NOT NULL
      );

      CREATE TABLE IF NOT EXISTS history (
        id TEXT PRIMARY KEY,
        timestamp INTEGER NOT NULL,
        language TEXT NOT NULL,
        provider TEXT NOT NULL,
        model TEXT NOT NULL,
        target_app TEXT NOT NULL,
        text TEXT NOT NULL,
        duration_seconds REAL,
        raw_text TEXT,
        enhanced_text TEXT,
        post_processing_applied INTEGER,
        post_processing_provider TEXT,
        post_processing_model TEXT
      );

      CREATE INDEX IF NOT EXISTS idx_history_timestamp ON history(timestamp DESC);
    `)

    this.ensureHistorySchemaCompatibility()
  }

  private ensureHistorySchemaCompatibility() {
    const columns = this.db.prepare('PRAGMA table_info(history)').all() as Array<{ name: string }>
    const existingColumns = new Set(columns.map((column) => column.name))

    const ensureColumn = (name: string, definition: string) => {
      if (existingColumns.has(name)) {
        return
      }

      this.db.prepare(`ALTER TABLE history ADD COLUMN ${name} ${definition}`).run()
      existingColumns.add(name)
    }

    ensureColumn('duration_seconds', 'REAL')
    ensureColumn('raw_text', 'TEXT')
    ensureColumn('enhanced_text', 'TEXT')
    ensureColumn('post_processing_applied', 'INTEGER')
    ensureColumn('post_processing_provider', 'TEXT')
    ensureColumn('post_processing_model', 'TEXT')
  }

  private hasPersistedState() {
    const stateExists = Boolean(this.db.prepare('SELECT 1 FROM app_state WHERE id = 1').get())
    if (stateExists) {
      return true
    }

    const historyRow = this.db.prepare('SELECT 1 FROM history LIMIT 1').get()
    return Boolean(historyRow)
  }

  private readMutableState() {
    const defaults = createDefaultSnapshot()
    const row = this.db.prepare('SELECT * FROM app_state WHERE id = 1').get() as AppStateRow | undefined

    if (!row) {
      return {
        settings: defaults.settings,
        models: defaults.models,
        postModels: defaults.postModels,
        onboardingCompleted: defaults.onboardingCompleted,
      }
    }

    return {
      settings: normalizeSettings(parseSerialized<Partial<AppSettings>>(row.settings_json, {})),
      models: normalizeModelState(parseSerialized<ModelState[]>(row.models_json, defaults.models), defaults.models),
      postModels: normalizeModelState(
        parseSerialized<ModelState[]>(row.post_models_json, defaults.postModels),
        defaults.postModels,
      ),
      onboardingCompleted: Boolean(row.onboarding_completed),
    }
  }

  private writeStateRow(state: Omit<AppStateSnapshot, 'history'>) {
    const upsertState = this.db.prepare(`
      INSERT INTO app_state (
        id,
        settings_json,
        models_json,
        post_models_json,
        onboarding_completed,
        updated_at
      )
      VALUES (1, ?, ?, ?, ?, ?)
      ON CONFLICT(id) DO UPDATE SET
        settings_json = excluded.settings_json,
        models_json = excluded.models_json,
        post_models_json = excluded.post_models_json,
        onboarding_completed = excluded.onboarding_completed,
        updated_at = excluded.updated_at
    `)

    upsertState.run(
      JSON.stringify(state.settings),
      JSON.stringify(state.models),
      JSON.stringify(state.postModels),
      state.onboardingCompleted ? 1 : 0,
      Date.now(),
    )
  }

  private migrateLegacyStateFile() {
    if (this.hasPersistedState() || !existsSync(this.legacyStateFilePath)) {
      return
    }

    try {
      const rawLegacySnapshot = readFileSync(this.legacyStateFilePath, 'utf8')
      const parsed = JSON.parse(rawLegacySnapshot) as Partial<AppStateSnapshot>

      const defaults = createDefaultSnapshot()
      const snapshot: AppStateSnapshot = {
        settings: normalizeSettings((parsed.settings as Partial<AppSettings>) ?? {}),
        history: Array.isArray(parsed.history) ? sortHistoryDescending(parsed.history as HistoryEntry[]) : [],
        models: Array.isArray(parsed.models)
          ? normalizeModelState(parsed.models as ModelState[], defaults.models)
          : defaults.models,
        postModels: Array.isArray(parsed.postModels)
          ? normalizeModelState(parsed.postModels as ModelState[], defaults.postModels)
          : defaults.postModels,
        onboardingCompleted: typeof parsed.onboardingCompleted === 'boolean' ? parsed.onboardingCompleted : false,
      }

      this.writeStateRow({
        settings: snapshot.settings,
        models: snapshot.models,
        postModels: snapshot.postModels,
        onboardingCompleted: snapshot.onboardingCompleted,
      })

      this.setHistory(snapshot.history)
    } catch {
      // Ignore malformed legacy files and continue with clean sqlite state.
    }
  }
}
