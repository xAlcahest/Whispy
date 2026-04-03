import { Mic, AudioLines, X } from 'lucide-react'
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { Dropdown } from '../components/ui/dropdown'
import { emitAppNotification } from '../lib/app-notifications'
import { cn } from '../lib/cn'
import { CLOUD_TRANSCRIPTION_CATALOG, MODEL_PRESETS, STORAGE_KEYS } from '../lib/constants'
import { electronAPI } from '../lib/electron-api'
import { appendHistoryEntry, loadSettings, refreshSettingsFromBackend } from '../lib/storage'
import { fakeTranscriptionService } from '../services/fakeTranscriptionService'
import type { AppSettings, DictationStatus } from '../types/app'
import { estimateDurationFromTranscript } from '../../../shared/app'
import type {
  DictationResultPayload,
  OverlaySizeKey,
  WhisperRuntimeDiagnosticsPayload,
  WhisperRuntimeStatusPayload,
} from '../../../shared/ipc'

const resolveTranscriptionProviderLabel = (settings: AppSettings) => {
  if (settings.transcriptionRuntime === 'local') {
    return 'Local (On-device)'
  }

  return (
    CLOUD_TRANSCRIPTION_CATALOG.find((provider) => provider.providerId === settings.transcriptionCloudProvider)
      ?.providerLabel ?? settings.transcriptionCloudProvider
  )
}

const resolveTranscriptionModelLabel = (settings: AppSettings) => {
  if (settings.transcriptionRuntime === 'local') {
    return (
      MODEL_PRESETS.find((model) => model.id === settings.transcriptionLocalModelId)?.label ??
      settings.transcriptionLocalModelId
    )
  }

  if (settings.transcriptionCloudProvider === 'custom') {
    return settings.transcriptionCustomModel.trim() || settings.transcriptionCloudModelId || 'custom-stt-model'
  }

  const selectedProvider = CLOUD_TRANSCRIPTION_CATALOG.find(
    (provider) => provider.providerId === settings.transcriptionCloudProvider,
  )

  const selectedModelId = settings.transcriptionCloudModelId || selectedProvider?.models[0]?.id || ''
  return selectedProvider?.models.find((model) => model.id === selectedModelId)?.label ?? selectedModelId
}

const OverlayScene = () => {
  const [status, setStatus] = useState<DictationStatus>('IDLE')
  const [hovered, setHovered] = useState(false)
  const [contextMenuAnchor, setContextMenuAnchor] = useState<{ x: number; y: number } | null>(null)
  const [settings, setSettings] = useState<AppSettings>(loadSettings)
  const [autoHideEnabled, setAutoHideEnabled] = useState(() => loadSettings().autoHideFloatingIcon)
  const [runtimeStatus, setRuntimeStatus] = useState<WhisperRuntimeStatusPayload | null>(null)
  const [runtimeDiagnostics, setRuntimeDiagnostics] = useState<WhisperRuntimeDiagnosticsPayload | null>(null)

  const pointerState = useRef<{ x: number; y: number; dragged: boolean } | null>(null)
  const autoHideTimer = useRef<number | null>(null)
  const contextMenuOpen = contextMenuAnchor !== null

  const refreshRuntimeBadge = useCallback(async () => {
    const latestSettings = loadSettings()
    if (latestSettings.transcriptionRuntime !== 'local') {
      setRuntimeStatus(null)
      setRuntimeDiagnostics(null)
      return
    }

    if (typeof window.electronAPI === 'undefined') {
      setRuntimeStatus({
        cpuInstalled: false,
        cudaInstalled: false,
        activeVariant: latestSettings.whisperCppRuntimeVariant,
        runtimeDirectory: '',
        downloadUrls: {
          cpu: null,
          cuda: null,
        },
      })
      setRuntimeDiagnostics({
        checkedAt: Date.now(),
        selectedVariant: latestSettings.whisperCppRuntimeVariant,
        running: false,
        healthy: false,
        pid: null,
        port: null,
        activeVariant: null,
        commandPath: null,
        commandSource: null,
        modelPath: null,
        processRssMB: null,
        nvidiaSmiAvailable: false,
        cudaProcessDetected: false,
        vramUsedMB: null,
        notes: 'Runtime diagnostics unavailable outside Electron runtime.',
      })
      return
    }

    try {
      const [nextRuntimeStatus, nextRuntimeDiagnostics] = await Promise.all([
        electronAPI.getWhisperRuntimeStatus(),
        electronAPI.getWhisperRuntimeDiagnostics(),
      ])
      setRuntimeStatus(nextRuntimeStatus)
      setRuntimeDiagnostics(nextRuntimeDiagnostics)
    } catch {
      setRuntimeStatus(null)
      setRuntimeDiagnostics(null)
    }
  }, [])

  const handleDictationResult = useCallback(async (result: DictationResultPayload) => {
    const nextSettings = loadSettings()
    const resolvedLanguage =
      nextSettings.preferredLanguage === 'Auto-detect' ? result.language : nextSettings.preferredLanguage
    const transcriptionProvider = result.provider || resolveTranscriptionProviderLabel(nextSettings)
    const transcriptionModel = result.model || resolveTranscriptionModelLabel(nextSettings)
    const postProcessingProvider = result.postProcessingProvider?.trim() || undefined
    const postProcessingModel = result.postProcessingModel?.trim() || undefined
    const historyEntry = {
      id: crypto.randomUUID(),
      timestamp: Date.now(),
      language: resolvedLanguage,
      provider: transcriptionProvider,
      model: transcriptionModel,
      targetApp: result.targetApp,
      text: result.text,
      durationSeconds:
        typeof result.durationSeconds === 'number' && Number.isFinite(result.durationSeconds)
          ? result.durationSeconds
          : estimateDurationFromTranscript(result.text),
      rawText: result.rawText?.trim() || result.text,
      enhancedText: result.enhancedText?.trim() || result.text,
      postProcessingApplied: Boolean(result.postProcessingApplied),
      postProcessingProvider,
      postProcessingModel,
    }

    appendHistoryEntry(historyEntry)

    if (nextSettings.autoPaste) {
      if (typeof window.electronAPI !== 'undefined') {
        const autoPasteResult = await electronAPI.performAutoPaste(result.text, nextSettings.autoPasteBackend, {
          mode: nextSettings.autoPasteMode,
          shortcut: nextSettings.autoPasteShortcut,
        })

        if (autoPasteResult.success) {
          emitAppNotification({
            title: 'Text pasted successfully',
            description: autoPasteResult.details,
            variant: 'success',
          })
        } else {
          emitAppNotification({
            title: 'Auto-paste failed',
            description: `${autoPasteResult.details} Transcription saved to history.`,
            variant: 'destructive',
          })
        }
      } else {
        try {
          await navigator.clipboard.writeText(result.text)
          emitAppNotification({
            title: 'Text copied and ready to paste',
            description: 'Ready to paste in the focused input field.',
            variant: 'success',
          })
        } catch {
          emitAppNotification({
            title: 'Clipboard unavailable',
            description: 'Transcription saved to local history.',
            variant: 'destructive',
          })
        }
      }
    } else {
      emitAppNotification({
        title: 'Transcription completed',
        description: result.text,
        variant: 'success',
        duration: 3600,
      })
    }
  }, [])

  useEffect(() => {
    if (typeof window.electronAPI === 'undefined') {
      return fakeTranscriptionService.subscribeStatus((nextStatus) => {
        setStatus(nextStatus)
      })
    }

    let alive = true

    void electronAPI
      .getDictationStatus()
      .then((nextStatus) => {
        if (alive) {
          setStatus(nextStatus)
        }
      })
      .catch(() => {
        if (alive) {
          setStatus('IDLE')
        }
      })

    const offStatus = electronAPI.onDictationStatusChanged((nextStatus) => {
      setStatus(nextStatus)
    })

    return () => {
      alive = false
      offStatus()
    }
  }, [])

  useEffect(() => {
    if (typeof window.electronAPI === 'undefined') {
      return fakeTranscriptionService.subscribeResult((result) => {
        void handleDictationResult(result)
      })
    }

    const offResult = electronAPI.onDictationResult((result) => {
      void handleDictationResult(result)
    })

    return () => {
      offResult()
    }
  }, [handleDictationResult])

  useEffect(() => {
    const offAutoHide = electronAPI.onFloatingIconAutoHideChanged((enabled) => {
      setAutoHideEnabled(enabled)
    })

    const offFailure = electronAPI.onHotkeyRegistrationFailed((payload) => {
      emitAppNotification({
        title: 'Hotkey registration failed',
        description: `${payload.requestedHotkey}: ${payload.reason}`,
        variant: 'destructive',
        duration: 4200,
      })
    })

    const offFallback = electronAPI.onHotkeyFallbackUsed((payload) => {
      emitAppNotification({
        title: 'Fallback hotkey enabled',
        description: `${payload.reason} ${payload.details}`,
        variant: 'destructive',
      })
    })

    const offDictationError = electronAPI.onDictationError((message) => {
      emitAppNotification({
        title: 'Dictation failed',
        description: message,
        variant: 'destructive',
        duration: 4600,
      })
    })

    return () => {
      offAutoHide()
      offFailure()
      offFallback()
      offDictationError()
    }
  }, [])

  useEffect(() => {
    const onStorage = (event: StorageEvent) => {
      if (event.key !== STORAGE_KEYS.settings) {
        return
      }

      void refreshSettingsFromBackend().then((nextSettings) => {
        setSettings(nextSettings)
        setAutoHideEnabled(nextSettings.autoHideFloatingIcon)
        void refreshRuntimeBadge()
      })
    }

    window.addEventListener('storage', onStorage)
    return () => {
      window.removeEventListener('storage', onStorage)
    }
  }, [refreshRuntimeBadge])

  useEffect(() => {
    void refreshSettingsFromBackend().then((nextSettings) => {
      setSettings(nextSettings)
      setAutoHideEnabled(nextSettings.autoHideFloatingIcon)
      void refreshRuntimeBadge()
    })
  }, [refreshRuntimeBadge])

  useEffect(() => {
    if (settings.transcriptionRuntime !== 'local') {
      setRuntimeStatus(null)
      setRuntimeDiagnostics(null)
      return
    }

    void refreshRuntimeBadge()
  }, [refreshRuntimeBadge, settings.transcriptionRuntime, settings.whisperCppRuntimeVariant])

  useEffect(() => {
    if (settings.transcriptionRuntime !== 'local') {
      return
    }

    if ((!settings.overlayRuntimeBadgeEnabled || settings.overlayRuntimeBadgeOnlyOnUse) && status === 'IDLE' && !hovered) {
      return
    }

    const timer = window.setInterval(() => {
      void refreshRuntimeBadge()
    }, 2400)

    return () => {
      window.clearInterval(timer)
    }
  }, [
    hovered,
    refreshRuntimeBadge,
    settings.overlayRuntimeBadgeEnabled,
    settings.overlayRuntimeBadgeOnlyOnUse,
    settings.transcriptionRuntime,
    status,
  ])

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key !== 'Escape') {
        return
      }

      if (contextMenuOpen) {
        setContextMenuAnchor(null)
        return
      }

      electronAPI.hideWindow()
    }

    window.addEventListener('keydown', onKeyDown)
    return () => {
      window.removeEventListener('keydown', onKeyDown)
    }
  }, [contextMenuOpen])

  const overlaySize = useMemo<OverlaySizeKey>(() => {
    if (contextMenuOpen) {
      return 'WITH_MENU'
    }

    return 'BASE'
  }, [contextMenuOpen])

  useEffect(() => {
    electronAPI.resizeMainWindow(overlaySize)
  }, [overlaySize])

  const shouldCapture = status !== 'IDLE' || hovered || contextMenuOpen

  useEffect(() => {
    electronAPI.setMainWindowInteractivity(shouldCapture)
  }, [shouldCapture])

  useEffect(() => {
    if (autoHideTimer.current !== null) {
      window.clearTimeout(autoHideTimer.current)
      autoHideTimer.current = null
    }

    if (!autoHideEnabled || status !== 'IDLE' || contextMenuOpen) {
      return
    }

    autoHideTimer.current = window.setTimeout(() => {
      electronAPI.hideWindow()
    }, 500)
  }, [autoHideEnabled, contextMenuOpen, status])

  const startOrStopDictation = () => {
    if (typeof window.electronAPI === 'undefined') {
      const result = fakeTranscriptionService.toggleListening()

      if (!result.accepted) {
        emitAppNotification({
          title: 'Processing in progress',
          description: 'Wait for completion before trying again.',
        })
      }

      return
    }

    void electronAPI
      .toggleDictation()
      .then((result) => {
        if (!result.accepted) {
          emitAppNotification({
            title: result.reason === 'unavailable' ? 'Dictation unavailable' : 'Processing in progress',
            description:
              result.reason === 'unavailable'
                ? 'Microphone recorder is unavailable. Install recorder dependencies and grant microphone permission.'
                : 'Wait for completion before trying again.',
          })
        }
      })
      .catch(() => {
        emitAppNotification({
          title: 'Dictation unavailable',
          description: 'Unable to start dictation in this runtime.',
          variant: 'destructive',
        })
      })
  }

  const cancelActiveStep = () => {
    if (typeof window.electronAPI !== 'undefined') {
      void electronAPI.cancelDictation().then((canceled) => {
        if (canceled) {
          emitAppNotification({
            title: 'Transcription canceled',
            description: 'Operation stopped manually.',
          })
        }
      })
      return
    }

    const canceled =
      (status === 'RECORDING' && fakeTranscriptionService.cancelRecording()) ||
      (status === 'PROCESSING' && fakeTranscriptionService.cancelProcessing())

    if (canceled) {
      emitAppNotification({
        title: 'Transcription canceled',
        description: 'Operation stopped manually.',
      })
    }
  }

  const contextItems = [
    {
      label:
        status === 'PROCESSING' ? 'Processing in progress' : status === 'RECORDING' ? 'Stop dictation' : 'Start dictation',
      onSelect: startOrStopDictation,
      disabled: status === 'PROCESSING',
    },
    {
      label: 'Open Control Panel',
      onSelect: () => {
        electronAPI.openControlPanel()
      },
    },
    {
      label: 'Hide for now',
      onSelect: () => {
        electronAPI.hideWindow()
      },
    },
  ]

  const showRuntimeBadge =
    settings.transcriptionRuntime === 'local' &&
    settings.overlayRuntimeBadgeEnabled &&
    (!settings.overlayRuntimeBadgeOnlyOnUse || status !== 'IDLE')
  const effectiveRuntimeVariant =
    runtimeDiagnostics?.activeVariant ?? runtimeStatus?.activeVariant ?? settings.whisperCppRuntimeVariant
  const runtimeHealthClass = runtimeDiagnostics?.running
    ? runtimeDiagnostics.healthy
      ? 'bg-emerald-400'
      : 'bg-amber-400'
    : 'bg-slate-400'
  const runtimeRssMB = runtimeDiagnostics?.processRssMB ?? null
  const runtimeRssLabel = runtimeRssMB === null ? 'RAM --' : `RAM ${Math.round(runtimeRssMB)}M`
  const runtimeVramLabel =
    effectiveRuntimeVariant === 'cuda'
      ? runtimeDiagnostics?.cudaProcessDetected
        ? `VRAM ${Math.round(runtimeDiagnostics?.vramUsedMB ?? 0)}M`
        : runtimeDiagnostics?.nvidiaSmiAvailable
          ? 'VRAM --'
          : 'VRAM n/a'
      : 'VRAM cpu'

  return (
    <div className="h-screen w-screen p-2 app-drag">
      <div
        className={cn(
          'relative flex h-full w-full items-center justify-center rounded-full border border-white/20 bg-black/20 backdrop-blur-xl transition-all duration-200',
          hovered ? 'scale-[1.02] border-white/30 shadow-[0_0_30px_-18px_rgba(147,197,253,0.8)]' : 'scale-100',
          status === 'RECORDING' ? 'bg-primary/85 shadow-[0_0_34px_-8px_rgba(37,99,235,0.95)]' : undefined,
          status === 'PROCESSING' ? 'bg-accent/85 shadow-[0_0_34px_-8px_rgba(99,102,241,0.95)]' : undefined,
        )}
        onMouseEnter={() => {
          setHovered(true)
        }}
        onMouseLeave={() => {
          setHovered(false)
        }}
      >
        {status === 'RECORDING' ? (
          <div className="pointer-events-none absolute inset-0 rounded-full ring-2 ring-primary/50 animate-pulse" />
        ) : null}

        <div className="relative z-10 flex flex-col items-center gap-1">
          <button
            type="button"
            className="app-no-drag relative z-10 flex h-10 w-10 items-center justify-center rounded-full border border-white/40 bg-black/35 text-white transition-all hover:scale-105"
            onPointerDown={(event) => {
              pointerState.current = {
                x: event.clientX,
                y: event.clientY,
                dragged: false,
              }
            }}
            onPointerMove={(event) => {
              const pointer = pointerState.current
              if (!pointer || pointer.dragged) {
                return
              }

              const deltaX = Math.abs(event.clientX - pointer.x)
              const deltaY = Math.abs(event.clientY - pointer.y)
              if (Math.hypot(deltaX, deltaY) > 5) {
                pointer.dragged = true
              }
            }}
            onPointerUp={() => {
              window.setTimeout(() => {
                pointerState.current = null
              }, 0)
            }}
            onClick={() => {
              if (pointerState.current?.dragged) {
                return
              }

              startOrStopDictation()
            }}
            onContextMenu={(event) => {
              event.preventDefault()
              setContextMenuAnchor({
                x: event.clientX + 8,
                y: event.clientY + 8,
              })
            }}
          >
            {status === 'PROCESSING' ? (
              <div className="flex items-end gap-0.5">
                <span className="h-2 w-1 animate-[wave_0.8s_ease-in-out_infinite] rounded-sm bg-white/90" />
                <span className="h-3 w-1 animate-[wave_0.8s_ease-in-out_0.12s_infinite] rounded-sm bg-white/90" />
                <span className="h-4 w-1 animate-[wave_0.8s_ease-in-out_0.2s_infinite] rounded-sm bg-white/90" />
                <span className="h-3 w-1 animate-[wave_0.8s_ease-in-out_0.32s_infinite] rounded-sm bg-white/90" />
              </div>
            ) : status === 'RECORDING' ? (
              <Mic className="h-4 w-4" />
            ) : hovered ? (
              <AudioLines className="h-4 w-4" />
            ) : (
              <Mic className="h-4 w-4" />
            )}
          </button>

          {showRuntimeBadge ? (
            <div className="app-no-drag pointer-events-none inline-flex items-center gap-1 rounded-full border border-white/20 bg-black/55 px-1.5 py-0.5 text-[9px] font-medium leading-none text-white/90">
              <span className={cn('inline-flex h-1.5 w-1.5 rounded-full', runtimeHealthClass)} />
              <span>{effectiveRuntimeVariant.toUpperCase()}</span>
              <span className="text-white/65">{runtimeRssLabel}</span>
              <span className="text-white/65">{runtimeVramLabel}</span>
            </div>
          ) : null}
        </div>

        {hovered && (status === 'RECORDING' || status === 'PROCESSING') ? (
          <button
            type="button"
            onClick={cancelActiveStep}
            className="app-no-drag absolute right-3 top-3 inline-flex h-6 w-6 items-center justify-center rounded-full border border-white/40 bg-black/35 text-white transition-colors hover:bg-black/60"
          >
            <X className="h-3.5 w-3.5" />
          </button>
        ) : null}

      </div>

      <Dropdown
        open={contextMenuOpen}
        anchor={contextMenuAnchor}
        onClose={() => {
          setContextMenuAnchor(null)
        }}
        items={contextItems}
      />
    </div>
  )
}

export const OverlayView = () => {
  return <OverlayScene />
}
