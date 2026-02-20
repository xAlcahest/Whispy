import { TARGET_APPS } from '../lib/constants'
import type { DictationStatus, FakeTranscriptionResult } from '../types/app'

type StatusSubscriber = (status: DictationStatus) => void
type ResultSubscriber = (result: FakeTranscriptionResult) => void

const pickRandom = <T>(values: T[]) => values[Math.floor(Math.random() * values.length)]

interface BrowserSpeechRecognitionAlternative {
  transcript: string
}

interface BrowserSpeechRecognitionResult {
  0: BrowserSpeechRecognitionAlternative
  length: number
}

interface BrowserSpeechRecognitionResultEvent {
  resultIndex: number
  results: ArrayLike<BrowserSpeechRecognitionResult>
}

interface BrowserSpeechRecognition {
  lang: string
  continuous: boolean
  interimResults: boolean
  maxAlternatives: number
  onresult: ((event: BrowserSpeechRecognitionResultEvent) => void) | null
  onerror: (() => void) | null
  onend: (() => void) | null
  start: () => void
  stop: () => void
  abort: () => void
}

type BrowserSpeechRecognitionConstructor = new () => BrowserSpeechRecognition

const resolveSpeechRecognitionConstructor = (): BrowserSpeechRecognitionConstructor | null => {
  if (typeof window === 'undefined') {
    return null
  }

  const runtimeWindow = window as Window & {
    SpeechRecognition?: BrowserSpeechRecognitionConstructor
    webkitSpeechRecognition?: BrowserSpeechRecognitionConstructor
  }

  return runtimeWindow.SpeechRecognition ?? runtimeWindow.webkitSpeechRecognition ?? null
}

const extractTranscript = (event: BrowserSpeechRecognitionResultEvent) => {
  const parts: string[] = []

  for (let index = event.resultIndex; index < event.results.length; index += 1) {
    const result = event.results[index]
    if (!result || result.length === 0) {
      continue
    }

    const transcript = result[0]?.transcript?.trim()
    if (transcript) {
      parts.push(transcript)
    }
  }

  return parts.join(' ').trim()
}

class FakeTranscriptionService {
  private status: DictationStatus = 'IDLE'
  private recognition: BrowserSpeechRecognition | null = null
  private processingTimer: number | null = null
  private latestTranscript = ''
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
      const RecognitionCtor = resolveSpeechRecognitionConstructor()
      if (!RecognitionCtor) {
        return {
          accepted: false as const,
          reason: 'unavailable' as const,
        }
      }

      const recognition = new RecognitionCtor()
      recognition.lang = 'en-US'
      recognition.continuous = false
      recognition.interimResults = false
      recognition.maxAlternatives = 1
      this.latestTranscript = ''

      recognition.onresult = (event) => {
        const transcript = extractTranscript(event)
        if (transcript) {
          this.latestTranscript = transcript
        }
      }

      recognition.onerror = () => {
        this.latestTranscript = ''
      }

      recognition.onend = () => {
        const transcript = this.latestTranscript.trim()
        this.recognition = null

        if (this.status === 'RECORDING') {
          this.updateStatus('IDLE')
          return
        }

        if (this.status !== 'PROCESSING') {
          return
        }

        if (!transcript) {
          this.updateStatus('IDLE')
          return
        }

        this.processingTimer = window.setTimeout(() => {
          this.processingTimer = null
          this.emitResult({
            text: transcript,
            language: 'Auto-detect',
            provider: 'Browser Speech Recognition',
            model: 'web-speech',
            targetApp: pickRandom(TARGET_APPS),
          })
          this.updateStatus('IDLE')
        }, 140)
      }

      this.recognition = recognition

      try {
        recognition.start()
      } catch {
        this.recognition = null
        return {
          accepted: false as const,
          reason: 'unavailable' as const,
        }
      }

      this.updateStatus('RECORDING')
      return { accepted: true as const }
    }

    if (this.status === 'RECORDING') {
      this.updateStatus('PROCESSING')

      if (!this.recognition) {
        this.updateStatus('IDLE')
        return {
          accepted: false as const,
          reason: 'unavailable' as const,
        }
      }

      try {
        this.recognition.stop()
      } catch {
        this.recognition = null
        this.updateStatus('IDLE')
        return {
          accepted: false as const,
          reason: 'unavailable' as const,
        }
      }

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

    if (this.recognition) {
      this.recognition.abort()
      this.recognition = null
    }

    this.updateStatus('IDLE')
    return true
  }

  cancelProcessing() {
    if (this.status !== 'PROCESSING') {
      return false
    }

    if (this.recognition) {
      this.recognition.abort()
      this.recognition = null
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
