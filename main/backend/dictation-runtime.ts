import { createWriteStream, mkdirSync } from 'node:fs'
import { rm } from 'node:fs/promises'
import { spawnSync } from 'node:child_process'
import { join } from 'node:path'
import { createRequire } from 'node:module'
import type { DictationResult, DictationStatus } from '../../shared/app'
import type { DictationToggleResponse } from '../../shared/ipc'

const require = createRequire(import.meta.url)

interface NodeRecordSession {
  stream(): NodeJS.ReadableStream
  stop(): void
}

interface NodeRecordModule {
  record(options: Record<string, unknown>): NodeRecordSession
}

interface DictationRuntimeHandlers {
  onStatusChanged: (status: DictationStatus) => void
  onResult: (result: DictationResult) => void
  onError: (message: string) => void
  processAudioFile: (audioFilePath: string, mode: DictationProcessingMode) => Promise<DictationResult>
}

export type DictationProcessingMode = 'full' | 'transcription-only'

export interface DictationToggleOptions {
  maxRecordingDurationSeconds?: number
  limitReachedMessage?: string
}

const STOP_RECORDING_GRACE_PERIOD_MS = 1_800
const DEFAULT_RECORDING_LIMIT_REACHED_MESSAGE =
  'Maximum recording duration reached for the selected provider. Recording stopped automatically.'

const loadRecorderModule = (): NodeRecordModule => {
  return require('node-record-lpcm16') as NodeRecordModule
}

const commandExists = (command: string) => {
  const lookupCommand = process.platform === 'win32' ? 'where' : 'which'
  const probe = spawnSync(lookupCommand, [command], {
    encoding: 'utf8',
    timeout: 1200,
    windowsHide: true,
  })

  return probe.status === 0
}

const resolveRecorderCommand = () => {
  if (process.platform === 'linux') {
    if (commandExists('arecord')) {
      return 'arecord'
    }

    if (commandExists('rec')) {
      return 'rec'
    }

    if (commandExists('sox')) {
      return 'sox'
    }

    return null
  }

  return 'sox'
}

export class DictationRuntime {
  private status: DictationStatus = 'IDLE'
  private recordingSession: NodeRecordSession | null = null
  private recordingWriteStream: NodeJS.WritableStream | null = null
  private recordingFilePath: string | null = null
  private recordingStartedAtMs: number | null = null
  private recordingLimitTimer: NodeJS.Timeout | null = null
  private recordingMode: DictationProcessingMode = 'full'
  private stoppingRecording = false
  private processingRunId = 0

  constructor(
    private readonly handlers: DictationRuntimeHandlers,
    private readonly recordingsDirectory: string,
  ) {
    mkdirSync(this.recordingsDirectory, { recursive: true })
  }

  getStatus() {
    return this.status
  }

  toggleDictation(mode: DictationProcessingMode = 'full', options?: DictationToggleOptions): DictationToggleResponse {
    if (this.status === 'IDLE') {
      try {
        this.startRecording(mode, options)
      } catch {
        return {
          accepted: false,
          reason: 'unavailable',
        }
      }

      return {
        accepted: true,
      }
    }

    if (this.status === 'RECORDING') {
      this.stopRecordingAndProcess()
      return {
        accepted: true,
      }
    }

    return {
      accepted: false,
      reason: 'processing',
    }
  }

  cancelDictation() {
    if (this.status === 'RECORDING') {
      this.stopActiveRecording()
      this.recordingMode = 'full'
      this.recordingStartedAtMs = null
      this.clearRecordingLimitTimer()
      this.updateStatus('IDLE')
      return true
    }

    if (this.status !== 'PROCESSING') {
      return false
    }

    this.processingRunId += 1
    this.recordingMode = 'full'
    this.updateStatus('IDLE')
    return true
  }

  private startRecording(mode: DictationProcessingMode, options?: DictationToggleOptions) {
    const recorder = loadRecorderModule()
    const recorderCommand = resolveRecorderCommand()
    const requestedAudioInputDevice = process.env.WHISPY_AUDIO_INPUT_DEVICE?.trim()
    if (!recorderCommand) {
      throw new Error('No supported microphone recorder found (arecord, rec, sox).')
    }

    const recordingFilePath = join(this.recordingsDirectory, `dictation-${Date.now()}-${crypto.randomUUID()}.wav`)
    const recordingWriteStream = createWriteStream(recordingFilePath)

    const recordOptions: Record<string, unknown> = {
      sampleRate: 16_000,
      channels: 1,
      threshold: 0,
      recorder: recorderCommand,
      audioType: 'wav',
    }

    if (requestedAudioInputDevice) {
      recordOptions.device = requestedAudioInputDevice
    }

    const recordingSession = recorder.record(recordOptions)

    recordingSession
      .stream()
      .on('error', (error: unknown) => {
        if (this.stoppingRecording || this.status !== 'RECORDING') {
          return
        }

        const failureDetail = error instanceof Error ? error.message : String(error ?? '')
        this.handlers.onError(
          `Microphone recorder failed (${recorderCommand})${failureDetail ? `: ${failureDetail}` : ''}. Check system recorder dependencies or set WHISPY_AUDIO_INPUT_DEVICE.`,
        )
        void this.stopActiveRecording().then(() => {
          this.updateStatus('IDLE')
        })
      })
      .pipe(recordingWriteStream)

    this.recordingSession = recordingSession
    this.recordingWriteStream = recordingWriteStream
    this.recordingFilePath = recordingFilePath
    this.recordingStartedAtMs = Date.now()
    this.recordingMode = mode

    this.clearRecordingLimitTimer()
    const requestedLimit = options?.maxRecordingDurationSeconds
    if (typeof requestedLimit === 'number' && Number.isFinite(requestedLimit) && requestedLimit > 0) {
      const timeoutMs = Math.max(1_000, Math.floor(requestedLimit * 1_000))
      const limitMessage = options?.limitReachedMessage?.trim() || DEFAULT_RECORDING_LIMIT_REACHED_MESSAGE

      this.recordingLimitTimer = setTimeout(() => {
        if (this.status !== 'RECORDING') {
          return
        }

        this.handlers.onError(limitMessage)
        this.stopRecordingAndProcess()
      }, timeoutMs)
    }

    this.updateStatus('RECORDING')
  }

  private stopRecordingAndProcess() {
    this.clearRecordingLimitTimer()
    const activeRecordingPath = this.recordingFilePath
    const measuredDurationSeconds =
      this.recordingStartedAtMs !== null
        ? Number(Math.max(0.1, (Date.now() - this.recordingStartedAtMs) / 1000).toFixed(2))
        : null
    const activeMode = this.recordingMode
    this.recordingMode = 'full'
    this.recordingStartedAtMs = null
    if (!activeRecordingPath) {
      this.updateStatus('IDLE')
      return
    }

    const recordingStopped = this.stopActiveRecording()
    this.updateStatus('PROCESSING')

    const runId = ++this.processingRunId

    void recordingStopped
      .then(() => this.handlers.processAudioFile(activeRecordingPath, activeMode))
      .then(async (result) => {
        if (runId !== this.processingRunId) {
          await rm(activeRecordingPath, { force: true })
          return
        }

        this.handlers.onResult({
          ...result,
          durationSeconds: measuredDurationSeconds ?? result.durationSeconds,
        })
        this.updateStatus('IDLE')
        await rm(activeRecordingPath, { force: true })
      })
      .catch(async (error: unknown) => {
        const message = error instanceof Error ? error.message : 'Unknown dictation pipeline error.'

        if (runId === this.processingRunId) {
          this.handlers.onError(message)
          this.updateStatus('IDLE')
        }

        await rm(activeRecordingPath, { force: true })
      })
  }

  private stopActiveRecording() {
    this.clearRecordingLimitTimer()
    const activeWriteStream = this.recordingWriteStream
    this.stoppingRecording = true

    if (this.recordingSession) {
      try {
        this.recordingSession.stop()
      } catch { /* stop may throw if already stopped */ }
      this.recordingSession = null
    }

    this.recordingWriteStream = null

    this.recordingFilePath = null
    this.recordingStartedAtMs = null

    if (!activeWriteStream) {
      this.stoppingRecording = false
      return Promise.resolve()
    }

    return new Promise<void>((resolve) => {
      let settled = false
      const finalize = () => {
        if (settled) {
          return
        }

        settled = true
        clearTimeout(forceStopTimer)
        activeWriteStream.removeListener('close', handleStreamDone)
        activeWriteStream.removeListener('finish', handleStreamDone)
        activeWriteStream.removeListener('error', handleStreamDone)
        this.stoppingRecording = false
        resolve()
      }

      const handleStreamDone = () => {
        finalize()
      }

      const forceStopTimer = setTimeout(() => {
        try {
          const maybeDestroy = (activeWriteStream as NodeJS.WritableStream & { destroy?: () => void }).destroy
          if (typeof maybeDestroy === 'function') {
            maybeDestroy.call(activeWriteStream)
          }
        } catch {
          // Ignore forced stream close errors.
        }

        finalize()
      }, STOP_RECORDING_GRACE_PERIOD_MS)

      activeWriteStream.on('close', handleStreamDone)
      activeWriteStream.on('finish', handleStreamDone)
      activeWriteStream.on('error', handleStreamDone)
    })
  }

  private clearRecordingLimitTimer() {
    if (!this.recordingLimitTimer) {
      return
    }

    clearTimeout(this.recordingLimitTimer)
    this.recordingLimitTimer = null
  }

  private updateStatus(nextStatus: DictationStatus) {
    this.status = nextStatus
    this.handlers.onStatusChanged(nextStatus)
  }
}
