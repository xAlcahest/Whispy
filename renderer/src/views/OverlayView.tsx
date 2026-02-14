import { Mic, AudioLines, X, Loader2 } from 'lucide-react'
import { useEffect, useMemo, useRef, useState } from 'react'
import { Dropdown } from '../components/ui/dropdown'
import { emitAppNotification } from '../lib/app-notifications'
import { cn } from '../lib/cn'
import { CLOUD_TRANSCRIPTION_CATALOG, MODEL_PRESETS, STORAGE_KEYS } from '../lib/constants'
import { electronAPI } from '../lib/electron-api'
import { appendHistoryEntry, loadSettings } from '../lib/storage'
import { fakeTranscriptionService } from '../services/fakeTranscriptionService'
import type { AppSettings, DictationStatus } from '../types/app'
import type { OverlaySizeKey } from '../../../shared/ipc'

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
  const [status, setStatus] = useState<DictationStatus>(fakeTranscriptionService.getStatus())
  const [hovered, setHovered] = useState(false)
  const [contextMenuAnchor, setContextMenuAnchor] = useState<{ x: number; y: number } | null>(null)
  const [autoHideEnabled, setAutoHideEnabled] = useState(() => loadSettings().autoHideFloatingIcon)

  const pointerState = useRef<{ x: number; y: number; dragged: boolean } | null>(null)
  const autoHideTimer = useRef<number | null>(null)
  const contextMenuOpen = contextMenuAnchor !== null

  useEffect(() => {
    return fakeTranscriptionService.subscribeStatus((nextStatus) => {
      setStatus(nextStatus)
    })
  }, [])

  useEffect(() => {
    return fakeTranscriptionService.subscribeResult(async (result) => {
      const nextSettings = loadSettings()
      const resolvedLanguage =
        nextSettings.preferredLanguage === 'Auto-detect' ? result.language : nextSettings.preferredLanguage
      const historyEntry = {
        id: crypto.randomUUID(),
        timestamp: Date.now(),
        language: resolvedLanguage,
        provider: resolveTranscriptionProviderLabel(nextSettings),
        model: resolveTranscriptionModelLabel(nextSettings),
        targetApp: result.targetApp,
        text: result.text,
      }

      appendHistoryEntry(historyEntry)

      if (nextSettings.autoPaste) {
        try {
          await navigator.clipboard.writeText(result.text)
        } catch {
          emitAppNotification({
            title: 'Clipboard unavailable',
            description: 'Transcription saved to local history (mock).',
            variant: 'destructive',
          })
          return
        }

        emitAppNotification({
          title: 'Text copied and ready to paste (mock)',
          description: result.targetApp,
          variant: 'success',
        })
      } else {
        emitAppNotification({
          title: 'Transcription completed (mock)',
          description: result.text,
          variant: 'success',
          duration: 3600,
        })
      }
    })
  }, [])

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
        title: 'Fallback hotkey enabled (mock)',
        description: payload.details,
      })
    })

    return () => {
      offAutoHide()
      offFailure()
      offFallback()
    }
  }, [])

  useEffect(() => {
    const onStorage = (event: StorageEvent) => {
      if (event.key !== STORAGE_KEYS.settings) {
        return
      }

      const nextSettings = loadSettings()
      setAutoHideEnabled(nextSettings.autoHideFloatingIcon)
    }

    window.addEventListener('storage', onStorage)
    return () => {
      window.removeEventListener('storage', onStorage)
    }
  }, [])

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

    if (status === 'RECORDING' || status === 'PROCESSING') {
      return 'EXPANDED'
    }

    return 'BASE'
  }, [contextMenuOpen, status])

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
    const result = fakeTranscriptionService.toggleListening()

    if (!result.accepted) {
      emitAppNotification({
        title: 'Processing in progress',
        description: 'Wait for completion before trying again.',
      })
      return
    }
  }

  const cancelActiveStep = () => {
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
            <Loader2 className="h-4 w-4 animate-spin" />
          ) : hovered ? (
            <AudioLines className="h-4 w-4" />
          ) : (
            <Mic className="h-4 w-4" />
          )}
        </button>

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
