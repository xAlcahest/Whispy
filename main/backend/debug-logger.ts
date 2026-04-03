import { appendFileSync, mkdirSync } from 'node:fs'
import { dirname, join } from 'node:path'
import type { LogLevelPayload } from '../../shared/ipc'

export type DebugLogLevel = LogLevelPayload

export type DebugLogCategory =
  | 'system-diagnostics'
  | 'audio-processing'
  | 'ffmpeg-operations'
  | 'transcript-pipeline'
  | 'api-request'
  | 'error-details'

export interface DebugLogEntry {
  level: DebugLogLevel
  message: string
  meta?: unknown
  scope?: string
  source?: string
}

const LOG_LEVEL_PRIORITIES: Record<DebugLogLevel, number> = {
  trace: 10,
  debug: 20,
  info: 30,
  warn: 40,
  error: 50,
  fatal: 60,
}

const DEFAULT_LOG_LEVEL: DebugLogLevel = 'info'

const normalizeLogLevel = (value: unknown): DebugLogLevel | null => {
  if (typeof value !== 'string') {
    return null
  }

  const normalized = value.trim().toLowerCase()
  if (normalized in LOG_LEVEL_PRIORITIES) {
    return normalized as DebugLogLevel
  }

  return null
}

const readArgLogLevel = (): string | null => {
  const args = process.argv ?? []
  for (let index = 0; index < args.length; index += 1) {
    const currentArg = args[index]
    if (currentArg === '--log-level' && args[index + 1]) {
      return args[index + 1]
    }

    if (currentArg.startsWith('--log-level=')) {
      return currentArg.split('=', 2)[1] ?? null
    }
  }

  return null
}

const resolveConfiguredLogLevel = (): DebugLogLevel => {
  const argLevel = normalizeLogLevel(readArgLogLevel())
  if (argLevel) {
    return argLevel
  }

  const envLevel = normalizeLogLevel(process.env.WHISPY_LOG_LEVEL ?? process.env.LOG_LEVEL)
  if (envLevel) {
    return envLevel
  }

  return DEFAULT_LOG_LEVEL
}

const resolveEffectiveLogLevel = (configuredLevel: DebugLogLevel, debugModeEnabled: boolean): DebugLogLevel => {
  if (!debugModeEnabled) {
    return configuredLevel
  }

  const debugPriority = LOG_LEVEL_PRIORITIES.debug
  return LOG_LEVEL_PRIORITIES[configuredLevel] <= debugPriority ? configuredLevel : 'debug'
}

const toLogLevelTag = (level: DebugLogLevel) => level.toUpperCase()

const LOG_META_BY_CATEGORY: Record<
  DebugLogCategory,
  {
    level: DebugLogLevel
    scope: string
  }
> = {
  'system-diagnostics': {
    level: 'info',
    scope: 'System',
  },
  'audio-processing': {
    level: 'info',
    scope: 'Audio',
  },
  'ffmpeg-operations': {
    level: 'info',
    scope: 'FFmpeg',
  },
  'transcript-pipeline': {
    level: 'info',
    scope: 'Pipeline',
  },
  'api-request': {
    level: 'info',
    scope: 'API',
  },
  'error-details': {
    level: 'error',
    scope: 'Error',
  },
}

const SECRET_KEY_PATTERN = /(api[_-]?key|token|secret|password|authorization|cookie|session|credential|bearer|auth)/i
const API_KEY_VALUE_PATTERN = /(?:sk-[a-zA-Z0-9]{20,}|gsk_[a-zA-Z0-9]{20,}|xai-[a-zA-Z0-9]{20,})/g
const MAX_STRING_LENGTH = 220
const MAX_ARRAY_ITEMS = 8
const MAX_OBJECT_KEYS = 14
const MAX_OBJECT_DEPTH = 3

export interface DebugLogStatus {
  enabled: boolean
  logsDirectory: string
  currentLogFile: string
  logLevel: DebugLogLevel
}

const formatNow = () => {
  const now = new Date()
  const day = String(now.getDate()).padStart(2, '0')
  const month = String(now.getMonth() + 1).padStart(2, '0')
  const year = String(now.getFullYear())
  const time = now.toTimeString().split(' ')[0]

  return {
    day,
    month,
    year,
    timestamp: `${day}/${month}/${year} ${time}`,
    fileDate: `${year}-${month}-${day}`,
  }
}

const truncateString = (value: string) => {
  if (value.length <= MAX_STRING_LENGTH) {
    return value
  }

  return `${value.slice(0, MAX_STRING_LENGTH)}...`
}

const sanitizeDetails = (details: unknown) => {
  const visited = new WeakSet<object>()

  const sanitize = (value: unknown, keyName: string | null, depth: number): unknown => {
    if (typeof value === 'undefined') {
      return undefined
    }

    if (value === null) {
      return null
    }

    if (typeof value === 'string') {
      return truncateString(value.replace(API_KEY_VALUE_PATTERN, '[REDACTED]'))
    }

    if (typeof value === 'number' || typeof value === 'boolean') {
      return value
    }

    if (typeof value === 'bigint' || typeof value === 'symbol' || typeof value === 'function') {
      return String(value)
    }

    if (value instanceof Error) {
      return {
        name: value.name,
        message: truncateString(value.message),
      }
    }

    if (Array.isArray(value)) {
      if (depth >= MAX_OBJECT_DEPTH) {
        return `[Array(${value.length})]`
      }

      const trimmed = value.slice(0, MAX_ARRAY_ITEMS).map((item) => sanitize(item, keyName, depth + 1))
      if (value.length > MAX_ARRAY_ITEMS) {
        trimmed.push(`... +${value.length - MAX_ARRAY_ITEMS} more`)
      }

      return trimmed
    }

    if (typeof value === 'object') {
      if (depth >= MAX_OBJECT_DEPTH) {
        return '[Object]'
      }

      if (visited.has(value)) {
        return '[Circular]'
      }

      visited.add(value)

      const entries = Object.entries(value as Record<string, unknown>)
      const sanitized: Record<string, unknown> = {}

      let keptKeys = 0
      for (const [key, nestedValue] of entries) {
        if (typeof nestedValue === 'undefined') {
          continue
        }

        if (keptKeys >= MAX_OBJECT_KEYS) {
          break
        }

        if (SECRET_KEY_PATTERN.test(key)) {
          sanitized[key] = '[REDACTED]'
          keptKeys += 1
          continue
        }

        sanitized[key] = sanitize(nestedValue, key, depth + 1)
        keptKeys += 1
      }

      if (entries.length > keptKeys) {
        sanitized._omittedKeys = entries.length - keptKeys
      }

      return sanitized
    }

    return String(value)
  }

  return sanitize(details, null, 0)
}

const stringifyForFile = (details: unknown) => {
  if (typeof details === 'undefined') {
    return ''
  }

  try {
    return JSON.stringify(details)
  } catch {
    return String(details)
  }
}

export class DebugLogger {
  private enabled = false
  private configuredLevel: DebugLogLevel = resolveConfiguredLogLevel()
  private effectiveLevel: DebugLogLevel = resolveEffectiveLogLevel(this.configuredLevel, this.enabled)
  private ensuredLogFileDate: string | null = null

  constructor(private readonly logsDirectory: string) {
    mkdirSync(this.logsDirectory, { recursive: true })
  }

  setEnabled(nextEnabled: boolean) {
    this.refreshLogLevel()
    this.enabled = nextEnabled
    this.effectiveLevel = resolveEffectiveLogLevel(this.configuredLevel, this.enabled)
    this.log(
      'system-diagnostics',
      `Debug mode ${nextEnabled ? 'enabled' : 'disabled'}`,
      {
        enabled: nextEnabled,
        logLevel: this.getLevel(),
        configuredLevel: this.configuredLevel,
        logFile: this.resolveCurrentLogFilePath(),
      },
      'Debug',
    )
  }

  getStatus(): DebugLogStatus {
    return {
      enabled: this.enabled,
      logsDirectory: this.logsDirectory,
      currentLogFile: this.resolveCurrentLogFilePath(),
      logLevel: this.getLevel(),
    }
  }

  getLevel(): DebugLogLevel {
    return this.effectiveLevel
  }

  refreshLogLevel() {
    this.configuredLevel = resolveConfiguredLogLevel()
    this.effectiveLevel = resolveEffectiveLogLevel(this.configuredLevel, this.enabled)
  }

  private shouldLog(level: DebugLogLevel) {
    return LOG_LEVEL_PRIORITIES[level] >= LOG_LEVEL_PRIORITIES[this.effectiveLevel]
  }

  private write(level: DebugLogLevel, message: string, details?: unknown, scope?: string, source?: string) {
    if (!this.shouldLog(level)) {
      return
    }

    const sanitizedMessage = message.replace(API_KEY_VALUE_PATTERN, '[REDACTED]')
    const now = formatNow()
    const sanitizedDetails = typeof details === 'undefined' ? undefined : sanitizeDetails(details)
    const detailsString = stringifyForFile(sanitizedDetails)
    const scopeTag = scope ? `[${scope}]` : ''
    const sourceTag = source ? `[${source}]` : ''
    const levelTag = `[${toLogLevelTag(level)}]`
    const consolePrefix = `${levelTag} ${scopeTag}${sourceTag} ${sanitizedMessage}`.trim()
    const filePrefix = `[${now.timestamp}] ${levelTag} ${scopeTag}${sourceTag} ${sanitizedMessage}`.trim()
    const fileLine = `${filePrefix}${detailsString ? ` ${detailsString}` : ''}`

    if (level === 'error' || level === 'fatal') {
      if (typeof sanitizedDetails === 'undefined') {
        console.error(consolePrefix)
      } else {
        console.error(consolePrefix, sanitizedDetails)
      }
    } else if (level === 'warn') {
      if (typeof sanitizedDetails === 'undefined') {
        console.warn(consolePrefix)
      } else {
        console.warn(consolePrefix, sanitizedDetails)
      }
    } else if (typeof sanitizedDetails === 'undefined') {
      console.log(consolePrefix)
    } else {
      console.log(consolePrefix, sanitizedDetails)
    }

    if (!this.enabled) {
      return
    }

    const logFilePath = this.ensureCurrentLogFile()
    appendFileSync(logFilePath, `${fileLine}\n`, 'utf8')
  }

  ensureCurrentLogFile() {
    const now = formatNow()
    const logFilePath = join(this.logsDirectory, `${now.fileDate}.log`)

    if (this.ensuredLogFileDate !== now.fileDate) {
      mkdirSync(dirname(logFilePath), { recursive: true })
      appendFileSync(logFilePath, '', { flag: 'a' })
      this.ensuredLogFileDate = now.fileDate
    }

    return logFilePath
  }

  log(category: DebugLogCategory, message: string, details?: unknown, scopeOverride?: string) {
    const meta = LOG_META_BY_CATEGORY[category]
    this.write(meta.level, message, details, scopeOverride?.trim() || meta.scope)
  }

  logEntry(entry: DebugLogEntry) {
    const level = normalizeLogLevel(entry?.level) ?? 'info'
    const message = typeof entry?.message === 'string' ? entry.message.slice(0, 2000) : ''
    const scope = typeof entry?.scope === 'string' ? entry.scope.trim().slice(0, 100) : ''
    const source = typeof entry?.source === 'string' ? entry.source.trim().slice(0, 50) : 'renderer'
    const meta = entry?.meta !== undefined && entry?.meta !== null
      ? JSON.stringify(entry.meta).length <= 10_000 ? entry.meta : '[meta truncated]'
      : undefined
    this.write(level, message, meta, scope || undefined, source || undefined)
  }

  private resolveCurrentLogFilePath() {
    const now = formatNow()
    return join(this.logsDirectory, `${now.fileDate}.log`)
  }
}
