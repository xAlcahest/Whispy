import { TARGET_APPS } from '../lib/constants'
import type { DictationStatus, FakeTranscriptionResult } from '../types/app'

type StatusSubscriber = (status: DictationStatus) => void
type ResultSubscriber = (result: FakeTranscriptionResult) => void

const SAMPLE_TRANSCRIPTIONS = [
  'Open the settings panel and set the small model as default.',
  'Remind me to review the changelog before the next release.',
  'This is a local dictation test with on-device processing.',
  'Add a quick note: prepare the UI demo for Friday retro.',
  'Generate a summary of completed work and send it to the team.',
]

const pickRandom = <T>(values: T[]) => values[Math.floor(Math.random() * values.length)]

class FakeTranscriptionService {
  private status: DictationStatus = 'IDLE'
  private processingTimer: number | null = null
  private statusSubscribers = new Set<StatusSubscriber>()
  private resultSubscribers = new Set<ResultSubscriber>()

  getStatus() {
    return this.status
  }

  subscribeStatus(subscriber: StatusSubscriber) {
    this.statusSubscribers.add(subscriber)
    subscriber(this.status)
    return () => {
      this.statusSubscribers.delete(subscriber)
    }
  }

  subscribeResult(subscriber: ResultSubscriber) {
    this.resultSubscribers.add(subscriber)
    return () => {
      this.resultSubscribers.delete(subscriber)
    }
  }

  toggleListening() {
    if (this.status === 'IDLE') {
      this.updateStatus('RECORDING')
      return { accepted: true as const }
    }

    if (this.status === 'RECORDING') {
      this.updateStatus('PROCESSING')
      const delay = 1200 + Math.floor(Math.random() * 1300)

      this.processingTimer = window.setTimeout(() => {
        this.processingTimer = null
        this.emitResult({
          text: pickRandom(SAMPLE_TRANSCRIPTIONS),
          language: 'English',
          provider: 'Whisper',
          model: 'small',
          targetApp: pickRandom(TARGET_APPS),
        })
        this.updateStatus('IDLE')
      }, delay)

      return { accepted: true as const }
    }

    return {
      accepted: false as const,
      reason: 'processing',
    }
  }

  cancelRecording() {
    if (this.status !== 'RECORDING') {
      return false
    }

    this.updateStatus('IDLE')
    return true
  }

  cancelProcessing() {
    if (this.status !== 'PROCESSING') {
      return false
    }

    if (this.processingTimer !== null) {
      window.clearTimeout(this.processingTimer)
      this.processingTimer = null
    }

    this.updateStatus('IDLE')
    return true
  }

  private updateStatus(nextStatus: DictationStatus) {
    this.status = nextStatus
    this.statusSubscribers.forEach((subscriber) => subscriber(this.status))
  }

  private emitResult(result: FakeTranscriptionResult) {
    this.resultSubscribers.forEach((subscriber) => subscriber(result))
  }
}

export const fakeTranscriptionService = new FakeTranscriptionService()
