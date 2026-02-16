import { createWriteStream, mkdirSync } from 'node:fs'
import { rm } from 'node:fs/promises'
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
  processAudioFile: (audioFilePath: string) => Promise<DictationResult>
}

const loadRecorderModule = (): NodeRecordModule => {
  return require('node-record-lpcm16') as NodeRecordModule
}

export class DictationRuntime {
  private status: DictationStatus = 'IDLE'
  private recordingSession: NodeRecordSession | null = null
  private recordingWriteStream: NodeJS.WritableStream | null = null
  private recordingFilePath: string | null = null
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

  toggleDictation(): DictationToggleResponse {
    if (this.status === 'IDLE') {
      try {
        this.startRecording()
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
      this.updateStatus('IDLE')
      return true
    }

    if (this.status !== 'PROCESSING') {
      return false
    }

    this.processingRunId += 1
    this.updateStatus('IDLE')
    return true
  }

  private startRecording() {
    const recorder = loadRecorderModule()
    const recordingFilePath = join(this.recordingsDirectory, `dictation-${Date.now()}-${crypto.randomUUID()}.wav`)
    const recordingWriteStream = createWriteStream(recordingFilePath)

    const recordingSession = recorder.record({
      sampleRate: 16_000,
      channels: 1,
      threshold: 0,
      recorder: process.platform === 'linux' ? 'arecord' : 'sox',
      audioType: 'wav',
    })

    recordingSession
      .stream()
      .on('error', () => {
        this.handlers.onError('Microphone recorder failed. Check system recorder dependencies.')
        this.stopActiveRecording()
        this.updateStatus('IDLE')
      })
      .pipe(recordingWriteStream)

    this.recordingSession = recordingSession
    this.recordingWriteStream = recordingWriteStream
    this.recordingFilePath = recordingFilePath
    this.updateStatus('RECORDING')
  }

  private stopRecordingAndProcess() {
    const activeRecordingPath = this.recordingFilePath
    if (!activeRecordingPath) {
      this.updateStatus('IDLE')
      return
    }

    const recordingStopped = this.stopActiveRecording()
    this.updateStatus('PROCESSING')

    const runId = ++this.processingRunId

    void recordingStopped
      .then(() => this.handlers.processAudioFile(activeRecordingPath))
      .then(async (result) => {
        if (runId !== this.processingRunId) {
          await rm(activeRecordingPath, { force: true })
          return
        }

        this.handlers.onResult(result)
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
    const activeWriteStream = this.recordingWriteStream

    if (this.recordingSession) {
      this.recordingSession.stop()
      this.recordingSession = null
    }

    this.recordingWriteStream = null

    this.recordingFilePath = null

    if (!activeWriteStream) {
      return Promise.resolve()
    }

    return new Promise<void>((resolve) => {
      activeWriteStream.once('close', () => {
        resolve()
      })

      activeWriteStream.once('finish', () => {
        resolve()
      })
    })
  }

  private updateStatus(nextStatus: DictationStatus) {
    this.status = nextStatus
    this.handlers.onStatusChanged(nextStatus)
  }
}
