import { appendFileSync, existsSync, mkdirSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'

export type DebugLogCategory =
  | 'system-diagnostics'
  | 'audio-processing'
  | 'ffmpeg-operations'
  | 'transcript-pipeline'
  | 'api-request'
  | 'error-details'

const LOG_META_BY_CATEGORY: Record<
  DebugLogCategory,
  {
    level: 'INFO' | 'WARN' | 'ERROR'
    scope: string
  }
> = {
  'system-diagnostics': {
    level: 'INFO',
    scope: 'System',
  },
  'audio-processing': {
    level: 'INFO',
    scope: 'Audio',
  },
  'ffmpeg-operations': {
    level: 'INFO',
    scope: 'FFmpeg',
  },
  'transcript-pipeline': {
    level: 'INFO',
    scope: 'Pipeline',
  },
  'api-request': {
    level: 'INFO',
    scope: 'API',
  },
  'error-details': {
    level: 'ERROR',
    scope: 'Error',
  },
}

const SECRET_KEY_PATTERN = /(api[_-]?key|token|secret|password|authorization|cookie|session|credential)/i
const MAX_STRING_LENGTH = 220
const MAX_ARRAY_ITEMS = 8
const MAX_OBJECT_KEYS = 14
const MAX_OBJECT_DEPTH = 3

export interface DebugLogStatus {
  enabled: boolean
  logsDirectory: string
  currentLogFile: string
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
      return truncateString(value)
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

  constructor(private readonly logsDirectory: string) {
    mkdirSync(this.logsDirectory, { recursive: true })
  }

  setEnabled(nextEnabled: boolean) {
    this.enabled = nextEnabled
    this.log(
      'system-diagnostics',
      `Debug mode ${nextEnabled ? 'enabled' : 'disabled'}`,
      {
        enabled: nextEnabled,
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
    }
  }

  ensureCurrentLogFile() {
    const logFilePath = this.resolveCurrentLogFilePath()
    if (!existsSync(logFilePath)) {
      mkdirSync(dirname(logFilePath), { recursive: true })
      writeFileSync(logFilePath, '')
    }

    return logFilePath
  }

  log(category: DebugLogCategory, message: string, details?: unknown, scopeOverride?: string) {
    const now = formatNow()
    const sanitizedDetails = typeof details === 'undefined' ? undefined : sanitizeDetails(details)
    const detailsString = stringifyForFile(sanitizedDetails)
    const meta = LOG_META_BY_CATEGORY[category]
    const scope = scopeOverride?.trim() || meta.scope
    const levelTag = `[${meta.level}]`
    const scopeTag = `[${scope}]`
    const consolePrefix = `${levelTag} ${scopeTag} ${message}`
    const filePrefix = `[${now.timestamp}] ${levelTag} ${scopeTag} ${message}`
    const fileLine = `${filePrefix}${detailsString ? ` ${detailsString}` : ''}`

    if (meta.level === 'ERROR') {
      if (typeof sanitizedDetails === 'undefined') {
        console.error(consolePrefix)
      } else {
        console.error(consolePrefix, sanitizedDetails)
      }
    } else {
      if (typeof sanitizedDetails === 'undefined') {
        console.log(consolePrefix)
      } else {
        console.log(consolePrefix, sanitizedDetails)
      }
    }

    if (!this.enabled) {
      return
    }

    const logFilePath = this.ensureCurrentLogFile()
    appendFileSync(logFilePath, `${fileLine}\n`, 'utf8')
  }

  private resolveCurrentLogFilePath() {
    const now = formatNow()
    return join(this.logsDirectory, `${now.fileDate}.log`)
  }
}
