import {
  Bell,
  BookOpen,
  ChevronDown,
  ChevronRight,
  Cloud,
  Copy,
  Download,
  HardDrive,
  Link,
  MessageSquare,
  Moon,
  PanelRight,
  Search,
  Settings,
  Sparkles,
  Sun,
  Trash2,
  X,
} from 'lucide-react'
import {
  useEffect,
  useMemo,
  useRef,
  useState,
  type Dispatch,
  type MutableRefObject,
  type SetStateAction,
} from 'react'
import { Button } from '../components/ui/button'
import { Badge } from '../components/ui/badge'
import { Card, CardContent, CardDescription, CardFooter, CardHeader, CardTitle } from '../components/ui/card'
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '../components/ui/dialog'
import { Input } from '../components/ui/input'
import { Switch } from '../components/ui/switch'
import { Tabs, TabsContent, TabsList, TabsTrigger } from '../components/ui/tabs'
import { Textarea } from '../components/ui/textarea'
import { ToastProvider, useToast } from '../components/ui/toast'
import { useI18n } from '../i18n'
import { parseAppNotification } from '../lib/app-notifications'
import { cn } from '../lib/cn'
import { electronAPI } from '../lib/electron-api'
import {
  CLOUD_POST_PROCESSING_CATALOG,
  CLOUD_TRANSCRIPTION_CATALOG,
  LANGUAGES,
  PROVIDERS,
  STORAGE_KEYS,
  UI_LANGUAGES,
} from '../lib/constants'
import {
  clearHistory,
  isOnboardingCompleted,
  loadHistory,
  loadModelState,
  loadPostModelState,
  loadSettings,
  saveHistory,
  saveModelState,
  savePostModelState,
  saveSettings,
  setOnboardingCompleted,
} from '../lib/storage'
import type { AppSettings, HistoryEntry, ModelState } from '../types/app'

type PanelSection = 'conversations' | 'settings'

const sectionItems: Array<{ id: PanelSection; labelKey: string; icon: typeof MessageSquare }> = [
  { id: 'conversations', labelKey: 'menuConversations', icon: MessageSquare },
  { id: 'settings', labelKey: 'menuSettings', icon: Settings },
]

const formatTimestamp = (value: number) =>
  new Intl.DateTimeFormat('en-US', {
    dateStyle: 'medium',
    timeStyle: 'short',
  }).format(value)

const isMacOS = navigator.userAgent.includes('Mac')

const normalizeKey = (key: string) => {
  if (key === ' ') {
    return 'Space'
  }

  if (key.startsWith('Arrow')) {
    return key.replace('Arrow', '')
  }

  if (key.length === 1) {
    return key.toUpperCase()
  }

  return key
}

interface HotkeyInputProps {
  value: string
  onChange: (hotkey: string) => void
}

const HotkeyInput = ({ value, onChange }: HotkeyInputProps) => {
  const [focused, setFocused] = useState(false)

  return (
    <div className="space-y-1.5">
      <Input
        value={value}
        onFocus={() => {
          setFocused(true)
        }}
        onBlur={() => {
          setFocused(false)
        }}
        onKeyDown={(event) => {
          event.preventDefault()
          const modifiers: string[] = []

          if (event.ctrlKey) {
            modifiers.push('Ctrl')
          }
          if (event.shiftKey) {
            modifiers.push('Shift')
          }
          if (event.altKey) {
            modifiers.push('Alt')
          }
          if (event.metaKey) {
            modifiers.push(navigator.userAgent.includes('Mac') ? 'Cmd' : 'Meta')
          }

          const key = normalizeKey(event.key)
          if (['Control', 'Shift', 'Alt', 'Meta'].includes(key)) {
            return
          }

          const combination = [...modifiers, key]
          if (combination.length > 0) {
            onChange(combination.join('+'))
          }
        }}
        readOnly
      />
      <p className="text-xs text-muted-foreground">
        {focused ? 'Press a key combination (for example Ctrl+Shift+K)' : 'Click and press a combination'}
      </p>
    </div>
  )
}

interface HistorySectionProps {
  entries: HistoryEntry[]
  loading: boolean
  onCopy: (text: string) => void
  onDelete: (id: string) => void
  onClear: () => void
}

const HistorySection = ({ entries, loading, onCopy, onDelete, onClear }: HistorySectionProps) => {
  const [query, setQuery] = useState('')
  const [languageFilter, setLanguageFilter] = useState('all')
  const [providerFilter, setProviderFilter] = useState('all')
  const [dateFilter, setDateFilter] = useState<'all' | 'today' | '7d' | '30d'>('all')
  const [expandedEntries, setExpandedEntries] = useState<Record<string, boolean>>({})
  const [confirmOpen, setConfirmOpen] = useState(false)

  const filteredEntries = useMemo(() => {
    const now = Date.now()

    return entries.filter((entry) => {
      if (query.trim() && !entry.text.toLowerCase().includes(query.toLowerCase())) {
        return false
      }

      if (languageFilter !== 'all' && entry.language !== languageFilter) {
        return false
      }

      if (providerFilter !== 'all' && entry.provider !== providerFilter) {
        return false
      }

      if (dateFilter === 'today') {
        const today = new Date()
        const startOfDay = new Date(today.getFullYear(), today.getMonth(), today.getDate()).getTime()
        return entry.timestamp >= startOfDay
      }

      if (dateFilter === '7d') {
        return now - entry.timestamp <= 7 * 24 * 60 * 60 * 1000
      }

      if (dateFilter === '30d') {
        return now - entry.timestamp <= 30 * 24 * 60 * 60 * 1000
      }

      return true
    })
  }, [dateFilter, entries, languageFilter, providerFilter, query])

  if (loading) {
    return (
      <div className="space-y-3">
        {Array.from({ length: 4 }).map((_, index) => (
          <div key={index} className="h-28 animate-pulse rounded-[var(--radius-premium)] bg-surface-2" />
        ))}
      </div>
    )
  }

  return (
    <div className="space-y-4">
      <Card>
        <CardContent className="grid gap-3 pt-5 md:grid-cols-[1fr_auto_auto_auto_auto]">
          <div className="relative">
            <Search className="pointer-events-none absolute left-2.5 top-2.5 h-4 w-4 text-muted-foreground" />
            <Input
              className="pl-8"
              placeholder="Search transcriptions..."
              value={query}
              onChange={(event) => {
                setQuery(event.target.value)
              }}
            />
          </div>

          <select
            className="app-no-drag h-9 rounded-[var(--radius-premium)] border border-border-subtle bg-surface-0 px-2.5 text-sm"
            value={languageFilter}
            onChange={(event) => {
              setLanguageFilter(event.target.value)
            }}
          >
            <option value="all">Language: all</option>
            {LANGUAGES.map((language) => (
              <option key={language} value={language}>
                {language}
              </option>
            ))}
          </select>

          <select
            className="app-no-drag h-9 rounded-[var(--radius-premium)] border border-border-subtle bg-surface-0 px-2.5 text-sm"
            value={providerFilter}
            onChange={(event) => {
              setProviderFilter(event.target.value)
            }}
          >
            <option value="all">Provider: all</option>
            <option value="Whisper">Whisper</option>
            <option value="Parakeet">Parakeet</option>
          </select>

          <select
            className="app-no-drag h-9 rounded-[var(--radius-premium)] border border-border-subtle bg-surface-0 px-2.5 text-sm"
            value={dateFilter}
            onChange={(event) => {
              setDateFilter(event.target.value as 'all' | 'today' | '7d' | '30d')
            }}
          >
            <option value="all">Date: all</option>
            <option value="today">Today</option>
            <option value="7d">Last 7 days</option>
            <option value="30d">Last 30 days</option>
          </select>

          <Button
            variant="destructive"
            onClick={() => {
              setConfirmOpen(true)
            }}
            disabled={entries.length === 0}
          >
            Clear history
          </Button>
        </CardContent>
      </Card>

      {filteredEntries.length === 0 ? (
        <Card className="py-12">
          <CardContent className="flex flex-col items-center justify-center gap-2 text-center">
            <BookOpen className="h-10 w-10 text-muted-foreground" />
            <p className="font-medium">No transcriptions found</p>
            <p className="max-w-md text-sm text-muted-foreground">
              Start dictation from the floating panel. Transcriptions appear here with metadata,
              filters, and quick actions.
            </p>
          </CardContent>
        </Card>
      ) : (
        filteredEntries.map((entry) => {
          const expanded = Boolean(expandedEntries[entry.id])

          return (
            <Card key={entry.id}>
              <CardHeader className="pb-3">
                <div className="flex flex-wrap items-center justify-between gap-2">
                  <div className="space-y-1">
                    <CardTitle className="text-sm">{formatTimestamp(entry.timestamp)}</CardTitle>
                    <CardDescription>
                      {entry.language} | {entry.provider}/{entry.model} | {entry.targetApp}
                    </CardDescription>
                  </div>
                  <div className="flex items-center gap-1.5">
                    <Button
                      variant="outline"
                      size="sm"
                      onClick={() => {
                        onCopy(entry.text)
                      }}
                    >
                      <Copy className="h-3.5 w-3.5" />
                      Copy
                    </Button>
                    <Button
                      variant="ghost"
                      size="sm"
                      onClick={() => {
                        onDelete(entry.id)
                      }}
                    >
                      <Trash2 className="h-3.5 w-3.5" />
                      Delete
                    </Button>
                  </div>
                </div>
              </CardHeader>
              <CardContent>
                <p
                  className={cn(
                    'whitespace-pre-wrap text-sm text-muted-foreground',
                    expanded ? undefined : 'line-clamp-2',
                  )}
                >
                  {entry.text}
                </p>
                <button
                  type="button"
                  onClick={() => {
                    setExpandedEntries((current) => ({
                      ...current,
                      [entry.id]: !expanded,
                    }))
                  }}
                  className="app-no-drag mt-2 text-xs font-medium text-primary hover:text-primary/80"
                >
                  {expanded ? 'Collapse' : 'Expand'}
                </button>
              </CardContent>
            </Card>
          )
        })
      )}

      <Dialog
        open={confirmOpen}
        onOpenChange={(open) => {
          setConfirmOpen(open)
        }}
      >
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Confirm clear history</DialogTitle>
            <DialogDescription>
              This action removes all transcriptions saved locally. It cannot be undone.
            </DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button
              variant="ghost"
              onClick={() => {
                setConfirmOpen(false)
              }}
            >
              Cancel
            </Button>
            <Button
              variant="destructive"
              onClick={() => {
                onClear()
                setConfirmOpen(false)
              }}
            >
              Clear
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  )
}

interface SettingsSectionProps {
  settings: AppSettings
  onChange: (next: Partial<AppSettings>) => void
}

const SettingsSection = ({ settings, onChange }: SettingsSectionProps) => (
  <div className="space-y-4">
    <Card className="scroll-mt-6">
      <CardHeader>
        <CardTitle>General settings</CardTitle>
        <CardDescription>Core behavior, activation, and privacy controls.</CardDescription>
      </CardHeader>
      <CardContent className="space-y-6">
        <section id="settings-node-general.activation" className="scroll-mt-6 space-y-4">
          <div>
            <p className="text-sm font-semibold">Activation</p>
            <p className="text-xs text-muted-foreground">Configure global hotkey and activation mode.</p>
          </div>

          <div className="space-y-2">
            <p className="text-sm font-medium">Hotkey</p>
            <HotkeyInput
              value={settings.hotkey}
              onChange={(hotkey) => {
                onChange({ hotkey })
              }}
            />
          </div>

          <Tabs
            value={settings.activationMode}
            onValueChange={(value) => {
              onChange({ activationMode: value as AppSettings['activationMode'] })
            }}
          >
            <TabsList>
              <TabsTrigger value="tap">Tap to talk</TabsTrigger>
              <TabsTrigger value="hold">Hold to talk</TabsTrigger>
            </TabsList>
            <TabsContent value="tap">
              <p className="rounded-md border border-border-subtle bg-surface-0 p-3 text-sm text-muted-foreground">
                Press {settings.hotkey} to start and press again to stop.
              </p>
            </TabsContent>
            <TabsContent value="hold">
              <p className="rounded-md border border-border-subtle bg-surface-0 p-3 text-sm text-muted-foreground">
                Hold {settings.hotkey} while speaking. Release to send.
              </p>
            </TabsContent>
          </Tabs>
        </section>

        <div className="h-px bg-border-subtle" />

        <section id="settings-node-general.behavior" className="scroll-mt-6 space-y-3">
          <p className="text-sm font-semibold">Behavior</p>

          <div className="rounded-md border border-border-subtle bg-surface-0 px-3 py-2.5">
            <p className="mb-2 text-sm">Interface language</p>
            <select
              className="app-no-drag h-9 w-full rounded-[var(--radius-premium)] border border-border-subtle bg-surface-0 px-2.5 text-sm"
              value={settings.uiLanguage}
              onChange={(event) => {
                onChange({ uiLanguage: event.target.value })
              }}
            >
              {UI_LANGUAGES.map((language) => (
                <option key={language.id} value={language.id}>
                  {language.label}
                </option>
              ))}
            </select>
            <p className="mt-1 text-xs text-muted-foreground">More interface languages can be added later.</p>
          </div>

          {[
            {
              label: 'Auto-paste (mock)',
              key: 'autoPaste',
              value: settings.autoPaste,
            },
            {
              label: 'Auto-hide floating icon',
              key: 'autoHideFloatingIcon',
              value: settings.autoHideFloatingIcon,
            },
            {
              label: 'Launch at login',
              key: 'launchAtLogin',
              value: settings.launchAtLogin,
            },
            {
              label: 'Sounds',
              key: 'sounds',
              value: settings.sounds,
            },
          ].map((item) => (
            <div key={item.key} className="flex items-center justify-between rounded-md border border-border-subtle bg-surface-0 px-3 py-2.5">
              <p className="text-sm">{item.label}</p>
              <Switch
                checked={item.value}
                onCheckedChange={(checked) => {
                  onChange({ [item.key]: checked } as Partial<AppSettings>)
                }}
              />
            </div>
          ))}
        </section>

        <div className="h-px bg-border-subtle" />

        <section id="settings-node-general.privacy" className="scroll-mt-6 space-y-2">
          <p className="text-sm font-semibold">Privacy / Local</p>
          <div className="rounded-[var(--radius-premium)] border border-primary/30 bg-primary/10 p-4 text-sm text-primary">
            Local processing: voice data is never uploaded online in this mock mode.
          </div>
        </section>
      </CardContent>
    </Card>
  </div>
)

interface ModelsSectionProps {
  settings: AppSettings
  models: ModelState[]
  postModels: ModelState[]
  onSettingsChange: (next: Partial<AppSettings>) => void
  onModelsChange: Dispatch<SetStateAction<ModelState[]>>
  onPostModelsChange: Dispatch<SetStateAction<ModelState[]>>
}

const providerIconById: Record<string, typeof Sparkles> = {
  openai: Sparkles,
  grok: Cloud,
  meta: MessageSquare,
  custom: Settings,
}

const ModelsSection = ({
  settings,
  models,
  postModels,
  onSettingsChange,
  onModelsChange,
  onPostModelsChange,
}: ModelsSectionProps) => {
  const { pushToast } = useToast()
  const transcriptionIntervals = useRef<Record<string, number>>({})
  const postIntervals = useRef<Record<string, number>>({})

  useEffect(() => {
    return () => {
      Object.values(transcriptionIntervals.current).forEach((intervalId) => {
        window.clearInterval(intervalId)
      })
      Object.values(postIntervals.current).forEach((intervalId) => {
        window.clearInterval(intervalId)
      })
    }
  }, [])

  const setModelDownloading = (
    modelId: string,
    setModels: Dispatch<SetStateAction<ModelState[]>>,
    timerStore: MutableRefObject<Record<string, number>>,
  ) => {
    setModels((current) =>
      current.map((model) =>
        model.id === modelId
          ? {
              ...model,
              downloading: true,
              progress: 3,
            }
          : model,
      ),
    )

    timerStore.current[modelId] = window.setInterval(() => {
      setModels((current) =>
        current.map((model) => {
          if (model.id !== modelId) {
            return model
          }

          const nextProgress = Math.min(100, model.progress + 8 + Math.floor(Math.random() * 10))
          return {
            ...model,
            progress: nextProgress,
            downloading: nextProgress < 100,
            downloaded: nextProgress === 100,
          }
        }),
      )
    }, 320)
  }

  useEffect(() => {
    models.forEach((model) => {
      if (model.downloading) {
        return
      }

      const currentTimer = transcriptionIntervals.current[model.id]
      if (currentTimer) {
        window.clearInterval(currentTimer)
        delete transcriptionIntervals.current[model.id]
      }
    })
  }, [models])

  useEffect(() => {
    postModels.forEach((model) => {
      if (model.downloading) {
        return
      }

      const currentTimer = postIntervals.current[model.id]
      if (currentTimer) {
        window.clearInterval(currentTimer)
        delete postIntervals.current[model.id]
      }
    })
  }, [postModels])

  const downloadedModels = models.filter((model) => model.downloaded).length
  const downloadedPostModels = postModels.filter((model) => model.downloaded).length

  const selectedTranscriptionProvider =
    CLOUD_TRANSCRIPTION_CATALOG.find((provider) => provider.providerId === settings.transcriptionCloudProvider) ??
    CLOUD_TRANSCRIPTION_CATALOG[0]

  const selectedPostProcessingProvider =
    CLOUD_POST_PROCESSING_CATALOG.find((provider) => provider.providerId === settings.postProcessingCloudProvider) ??
    CLOUD_POST_PROCESSING_CATALOG[0]

  const providerButtonClass = (active: boolean) =>
    cn(
      'app-no-drag flex h-10 w-full items-center gap-2 rounded-md px-3 text-left text-sm transition-colors',
      active
        ? 'bg-primary/15 text-primary ring-1 ring-primary/30'
        : 'text-muted-foreground hover:bg-surface-2 hover:text-foreground',
    )

  const modelItemClass = (active: boolean) =>
    cn(
      'app-no-drag flex w-full items-center justify-between rounded-md border px-3 py-2 text-left text-sm transition-colors',
      active
        ? 'border-primary/40 bg-primary/10 text-primary'
        : 'border-border-subtle bg-surface-0 text-foreground hover:border-border-hover',
    )

  return (
    <div className="space-y-5">
      <Card id="settings-node-models.transcriptions.cloud" className="scroll-mt-6">
        <CardHeader>
          <CardTitle>Transcriptions | Cloud</CardTitle>
          <CardDescription>
            Provider tabs are listed vertically with icons. Model choices are listed one below another.
          </CardDescription>
        </CardHeader>
        <CardContent className="grid gap-4 lg:grid-cols-[240px_1fr]">
          <div className="rounded-[var(--radius-premium)] border border-border-subtle bg-surface-0 p-2">
            {CLOUD_TRANSCRIPTION_CATALOG.map((provider) => {
              const Icon = providerIconById[provider.providerId] ?? Settings
              const active = selectedTranscriptionProvider.providerId === provider.providerId

              return (
                <button
                  key={provider.providerId}
                  type="button"
                  className={providerButtonClass(active)}
                  onClick={() => {
                    onSettingsChange({
                      transcriptionRuntime: 'cloud',
                      transcriptionCloudProvider: provider.providerId,
                      transcriptionCloudModelId:
                        provider.providerId === 'custom'
                          ? settings.transcriptionCustomModel || provider.models[0]?.id || ''
                          : provider.models[0]?.id || '',
                    })
                  }}
                >
                  <Icon className="h-4 w-4" />
                  {provider.providerLabel}
                </button>
              )
            })}
          </div>

          <div className="rounded-[var(--radius-premium)] border border-border-subtle bg-surface-0 p-3">
            <div className="mb-3 flex items-center justify-between gap-2">
              <p className="text-sm font-medium">{selectedTranscriptionProvider.providerLabel}</p>
              <Badge tone="primary">Cloud STT</Badge>
            </div>

            {selectedTranscriptionProvider.providerId === 'custom' ? (
              <div className="space-y-3">
                <div className="space-y-1.5">
                  <p className="text-sm font-medium">Custom STT endpoint</p>
                  <Input
                    value={settings.transcriptionCustomBaseUrl}
                    onChange={(event) => {
                      onSettingsChange({ transcriptionCustomBaseUrl: event.target.value })
                    }}
                    placeholder="https://api.example.com/v1/transcriptions"
                  />
                </div>
                <div className="space-y-1.5">
                  <p className="text-sm font-medium">Custom STT model</p>
                  <Input
                    value={settings.transcriptionCustomModel}
                    onChange={(event) => {
                      onSettingsChange({
                        transcriptionCustomModel: event.target.value,
                        transcriptionCloudModelId: event.target.value,
                      })
                    }}
                    placeholder="custom-stt-model"
                  />
                </div>
                <div className="flex justify-end">
                  <Button
                    size="sm"
                    variant={settings.transcriptionRuntime === 'cloud' ? 'secondary' : 'default'}
                    onClick={() => {
                      onSettingsChange({
                        transcriptionRuntime: 'cloud',
                        transcriptionCloudProvider: 'custom',
                        transcriptionCloudModelId: settings.transcriptionCustomModel,
                      })
                    }}
                  >
                    <Cloud className="h-3.5 w-3.5" /> Use cloud
                  </Button>
                </div>
              </div>
            ) : (
              <div className="space-y-2">
                {selectedTranscriptionProvider.models.map((model) => {
                  const active = settings.transcriptionCloudModelId === model.id

                  return (
                    <button
                      key={model.id}
                      type="button"
                      className={modelItemClass(active)}
                      onClick={() => {
                        onSettingsChange({
                          transcriptionRuntime: 'cloud',
                          transcriptionCloudProvider: selectedTranscriptionProvider.providerId,
                          transcriptionCloudModelId: model.id,
                        })
                      }}
                    >
                      <span>{model.label}</span>
                      {active ? <Badge tone="primary">Active</Badge> : <span className="text-xs text-muted-foreground">Select</span>}
                    </button>
                  )
                })}
              </div>
            )}
          </div>
        </CardContent>
      </Card>

      <Card id="settings-node-models.transcriptions.local" className="scroll-mt-6">
        <CardHeader>
          <CardTitle>Transcriptions | Local</CardTitle>
          <CardDescription>
            {downloadedModels} downloaded models | storage path: ~/Library/Application Support/Whispy/models
          </CardDescription>
        </CardHeader>
        <CardContent className="grid gap-3 lg:grid-cols-2">
          {models.map((model) => (
            <Card key={model.id} className={settings.transcriptionLocalModelId === model.id ? 'border-primary/50' : undefined}>
              <CardHeader className="pb-3">
                <div className="flex items-start justify-between gap-3">
                  <div>
                    <CardTitle>{model.label}</CardTitle>
                    <CardDescription>{model.size}</CardDescription>
                  </div>
                  <div className="flex items-center gap-1.5">
                    <Badge tone={model.speed === 'Fast' ? 'success' : model.speed === 'Balanced' ? 'primary' : 'warning'}>
                      {model.speed}
                    </Badge>
                    <Badge>{model.quality}</Badge>
                  </div>
                </div>
              </CardHeader>
              <CardContent className="space-y-3">
                <div className="h-2 overflow-hidden rounded-full bg-surface-3">
                  <div
                    className="h-full bg-primary transition-[width] duration-300"
                    style={{
                      width: `${model.progress}%`,
                    }}
                  />
                </div>
                <p className="text-xs text-muted-foreground">
                  Status: {model.downloading ? `Downloading ${model.progress}%` : model.downloaded ? 'Downloaded' : 'Not downloaded'}
                </p>
              </CardContent>
              <CardFooter className="justify-between">
                <Button
                  variant="outline"
                  size="sm"
                  onClick={() => {
                    if (model.downloaded) {
                      onModelsChange((current) =>
                        current.map((item) =>
                          item.id === model.id
                            ? {
                                ...item,
                                downloaded: false,
                                downloading: false,
                                progress: 0,
                              }
                            : item,
                        ),
                      )
                      pushToast({
                        title: `${model.label} removed`,
                      })
                      return
                    }

                    if (!model.downloading) {
                      setModelDownloading(model.id, onModelsChange, transcriptionIntervals)
                      pushToast({
                        title: `Download started (${model.label})`,
                      })
                    }
                  }}
                  disabled={model.downloading}
                >
                  {model.downloaded ? (
                    <>
                      <X className="h-3.5 w-3.5" /> Remove
                    </>
                  ) : (
                    <>
                      <Download className="h-3.5 w-3.5" /> Download
                    </>
                  )}
                </Button>

                <Button
                  size="sm"
                  variant={settings.transcriptionLocalModelId === model.id ? 'secondary' : 'default'}
                  disabled={!model.downloaded}
                  onClick={() => {
                    onSettingsChange({
                      transcriptionRuntime: 'local',
                      transcriptionLocalModelId: model.id,
                      modelId: model.id,
                    })
                  }}
                >
                  <HardDrive className="h-3.5 w-3.5" />
                  {settings.transcriptionLocalModelId === model.id ? 'Active' : 'Use local'}
                </Button>
              </CardFooter>
            </Card>
          ))}
        </CardContent>
      </Card>

      <Card id="settings-node-models.post.cloud" className="scroll-mt-6">
        <CardHeader>
          <CardTitle>Post-processing | Cloud</CardTitle>
          <CardDescription>
            Provider tabs are listed vertically with icons. Model choices are listed one below another.
          </CardDescription>
        </CardHeader>
        <CardContent className="grid gap-4 lg:grid-cols-[240px_1fr]">
          <div className="rounded-[var(--radius-premium)] border border-border-subtle bg-surface-0 p-2">
            {CLOUD_POST_PROCESSING_CATALOG.map((provider) => {
              const Icon = providerIconById[provider.providerId] ?? Settings
              const active = selectedPostProcessingProvider.providerId === provider.providerId

              return (
                <button
                  key={provider.providerId}
                  type="button"
                  className={providerButtonClass(active)}
                  onClick={() => {
                    onSettingsChange({
                      postProcessingRuntime: 'cloud',
                      postProcessingCloudProvider: provider.providerId,
                      postProcessingCloudModelId:
                        provider.providerId === 'custom'
                          ? settings.postProcessingCustomModel || provider.models[0]?.id || ''
                          : provider.models[0]?.id || '',
                    })
                  }}
                >
                  <Icon className="h-4 w-4" />
                  {provider.providerLabel}
                </button>
              )
            })}
          </div>

          <div className="rounded-[var(--radius-premium)] border border-border-subtle bg-surface-0 p-3">
            <div className="mb-3 flex items-center justify-between gap-2">
              <p className="text-sm font-medium">{selectedPostProcessingProvider.providerLabel}</p>
              <Badge tone="primary">Cloud LLM</Badge>
            </div>

            {selectedPostProcessingProvider.providerId === 'custom' ? (
              <div className="space-y-3">
                <div className="space-y-1.5">
                  <p className="text-sm font-medium">Custom LLM endpoint</p>
                  <Input
                    value={settings.postProcessingCustomBaseUrl}
                    onChange={(event) => {
                      onSettingsChange({ postProcessingCustomBaseUrl: event.target.value })
                    }}
                    placeholder="https://api.example.com/v1/chat/completions"
                  />
                </div>
                <div className="space-y-1.5">
                  <p className="text-sm font-medium">Custom LLM model</p>
                  <Input
                    value={settings.postProcessingCustomModel}
                    onChange={(event) => {
                      onSettingsChange({
                        postProcessingCustomModel: event.target.value,
                        postProcessingCloudModelId: event.target.value,
                      })
                    }}
                    placeholder="custom-llm-model"
                  />
                </div>
                <div className="flex justify-end">
                  <Button
                    size="sm"
                    variant={settings.postProcessingRuntime === 'cloud' ? 'secondary' : 'default'}
                    onClick={() => {
                      onSettingsChange({
                        postProcessingRuntime: 'cloud',
                        postProcessingCloudProvider: 'custom',
                        postProcessingCloudModelId: settings.postProcessingCustomModel,
                      })
                    }}
                  >
                    <Cloud className="h-3.5 w-3.5" /> Use cloud
                  </Button>
                </div>
              </div>
            ) : (
              <div className="space-y-2">
                {selectedPostProcessingProvider.models.map((model) => {
                  const active = settings.postProcessingCloudModelId === model.id

                  return (
                    <button
                      key={model.id}
                      type="button"
                      className={modelItemClass(active)}
                      onClick={() => {
                        onSettingsChange({
                          postProcessingRuntime: 'cloud',
                          postProcessingCloudProvider: selectedPostProcessingProvider.providerId,
                          postProcessingCloudModelId: model.id,
                        })
                      }}
                    >
                      <span>{model.label}</span>
                      {active ? <Badge tone="primary">Active</Badge> : <span className="text-xs text-muted-foreground">Select</span>}
                    </button>
                  )
                })}
              </div>
            )}
          </div>
        </CardContent>
      </Card>

      <Card id="settings-node-models.post.local" className="scroll-mt-6">
        <CardHeader>
          <CardTitle>Post-processing | Local</CardTitle>
          <CardDescription>{downloadedPostModels} downloaded local LLM models</CardDescription>
        </CardHeader>
        <CardContent className="grid gap-3 lg:grid-cols-2">
          {postModels.map((model) => (
            <Card key={model.id} className={settings.postProcessingLocalModelId === model.id ? 'border-primary/50' : undefined}>
              <CardHeader className="pb-3">
                <div className="flex items-start justify-between gap-3">
                  <div>
                    <CardTitle>{model.label}</CardTitle>
                    <CardDescription>{model.size}</CardDescription>
                  </div>
                  <div className="flex items-center gap-1.5">
                    <Badge tone={model.speed === 'Fast' ? 'success' : model.speed === 'Balanced' ? 'primary' : 'warning'}>
                      {model.speed}
                    </Badge>
                    <Badge>{model.quality}</Badge>
                  </div>
                </div>
              </CardHeader>
              <CardContent className="space-y-3">
                <div className="h-2 overflow-hidden rounded-full bg-surface-3">
                  <div
                    className="h-full bg-primary transition-[width] duration-300"
                    style={{
                      width: `${model.progress}%`,
                    }}
                  />
                </div>
                <p className="text-xs text-muted-foreground">
                  Status: {model.downloading ? `Downloading ${model.progress}%` : model.downloaded ? 'Downloaded' : 'Not downloaded'}
                </p>
              </CardContent>
              <CardFooter className="justify-between">
                <Button
                  variant="outline"
                  size="sm"
                  onClick={() => {
                    if (model.downloaded) {
                      onPostModelsChange((current) =>
                        current.map((item) =>
                          item.id === model.id
                            ? {
                                ...item,
                                downloaded: false,
                                downloading: false,
                                progress: 0,
                              }
                            : item,
                        ),
                      )
                      pushToast({
                        title: `${model.label} removed`,
                      })
                      return
                    }

                    if (!model.downloading) {
                      setModelDownloading(model.id, onPostModelsChange, postIntervals)
                      pushToast({
                        title: `Download started (${model.label})`,
                      })
                    }
                  }}
                  disabled={model.downloading}
                >
                  {model.downloaded ? (
                    <>
                      <X className="h-3.5 w-3.5" /> Remove
                    </>
                  ) : (
                    <>
                      <Download className="h-3.5 w-3.5" /> Download
                    </>
                  )}
                </Button>

                <Button
                  size="sm"
                  variant={settings.postProcessingLocalModelId === model.id ? 'secondary' : 'default'}
                  disabled={!model.downloaded}
                  onClick={() => {
                    onSettingsChange({
                      postProcessingRuntime: 'local',
                      postProcessingLocalModelId: model.id,
                    })
                  }}
                >
                  <HardDrive className="h-3.5 w-3.5" />
                  {settings.postProcessingLocalModelId === model.id ? 'Active' : 'Use local'}
                </Button>
              </CardFooter>
            </Card>
          ))}
        </CardContent>
      </Card>
    </div>
  )
}

interface AgentIdentitySectionProps {
  settings: AppSettings
  onChange: (next: Partial<AppSettings>) => void
}

const AgentIdentitySection = ({ settings, onChange }: AgentIdentitySectionProps) => (
  <div className="space-y-4">
    <Card id="settings-node-agent.name" className="scroll-mt-6">
      <CardHeader>
        <CardTitle>Agent name</CardTitle>
        <CardDescription>
          Dedicated section for naming your assistant trigger. This name is used in prompt routing.
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-2">
        <Input
          value={settings.agentName}
          onChange={(event) => {
            onChange({ agentName: event.target.value })
          }}
          placeholder="ActionAgent"
        />
        <p className="text-xs text-muted-foreground">
          Example trigger sentence: "{settings.agentName || 'ActionAgent'}, summarize this in bullets."
        </p>
      </CardContent>
    </Card>
  </div>
)

type PromptView = 'preview' | 'customize' | 'test'

interface PromptsSectionProps {
  settings: AppSettings
  onChange: (next: Partial<AppSettings>) => void
}

const PromptsSection = ({ settings, onChange }: PromptsSectionProps) => {
  const [view, setView] = useState<PromptView>('preview')
  const [testInput, setTestInput] = useState('')
  const [testOutput, setTestOutput] = useState('')

  const runPromptTest = () => {
    const normalizedAgent = settings.agentName.trim().toLowerCase()
    const usesAgentRoute = normalizedAgent.length > 0 && testInput.toLowerCase().includes(normalizedAgent)

    if (usesAgentRoute) {
      setTestOutput(
        `Route: Agent prompt\n\nAgent: ${settings.agentName}\n\nTemplate:\n${settings.agentPrompt}\n\nInput:\n${testInput}`,
      )
      return
    }

    setTestOutput(`Route: Normal prompt\n\nTemplate:\n${settings.normalPrompt}\n\nInput:\n${testInput}`)
  }

  return (
    <div className="space-y-4">
      <Card id="settings-node-prompts" className="scroll-mt-6">
        <CardHeader>
          <CardTitle>Prompts</CardTitle>
          <CardDescription>Standalone prompt workspace with Preview, Customize, and Test.</CardDescription>
        </CardHeader>
        <CardContent>
          <div className="mx-auto max-w-3xl space-y-4">
          <Tabs
            value={view}
            onValueChange={(nextValue) => {
              setView(nextValue as PromptView)
            }}
          >
            <TabsList className="mx-auto h-auto w-fit flex-wrap justify-center gap-1 bg-surface-2/80 p-1">
              <TabsTrigger value="preview" className="min-w-[120px]">
                Preview
              </TabsTrigger>
              <TabsTrigger value="customize" className="min-w-[120px]">
                Customize
              </TabsTrigger>
              <TabsTrigger value="test" className="min-w-[120px]">
                Test
              </TabsTrigger>
            </TabsList>

            <TabsContent value="preview" className="mt-4 space-y-3">
              <div className="rounded-md border border-border-subtle bg-surface-0 p-3">
                <p className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">Normal prompt</p>
                <p className="mt-2 whitespace-pre-wrap text-sm text-foreground">{settings.normalPrompt}</p>
              </div>
              <div className="rounded-md border border-border-subtle bg-surface-0 p-3">
                <p className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">Agent route</p>
                <p className="mt-1 text-xs text-muted-foreground">
                  Triggered when input includes: <span className="font-medium text-foreground">{settings.agentName || 'ActionAgent'}</span>
                </p>
                <p className="mt-2 whitespace-pre-wrap text-sm text-foreground">{settings.agentPrompt}</p>
              </div>
            </TabsContent>

            <TabsContent value="customize" className="mt-4 space-y-4">
              <div className="space-y-1.5">
                <p className="text-sm font-medium">Normal prompt</p>
                <Textarea
                  value={settings.normalPrompt}
                  onChange={(event) => {
                    onChange({ normalPrompt: event.target.value })
                  }}
                  placeholder="Prompt used for regular post-processing."
                />
              </div>
              <div className="space-y-1.5">
                <p className="text-sm font-medium">Agent prompt</p>
                <Textarea
                  value={settings.agentPrompt}
                  onChange={(event) => {
                    onChange({ agentPrompt: event.target.value })
                  }}
                  placeholder="Prompt used when the agent name is detected."
                />
              </div>
            </TabsContent>

            <TabsContent value="test" className="mt-4 space-y-3">
              <div className="space-y-1.5">
                <p className="text-sm font-medium">Test input</p>
                <Textarea
                  value={testInput}
                  onChange={(event) => {
                    setTestInput(event.target.value)
                  }}
                  placeholder={`Try text with or without "${settings.agentName || 'ActionAgent'}".`}
                />
              </div>
              <div className="flex justify-end">
                <Button onClick={runPromptTest}>Run mock test</Button>
              </div>
              <div className="rounded-md border border-border-subtle bg-surface-0 p-3">
                <p className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">Result</p>
                <p className="mt-2 whitespace-pre-wrap text-sm text-foreground">
                  {testOutput || 'No output yet. Run a test to preview routing behavior.'}
                </p>
              </div>
            </TabsContent>
          </Tabs>
          </div>
        </CardContent>
      </Card>
    </div>
  )
}

const ShortcutsSection = ({ hotkey }: { hotkey: string }) => (
  <div className="space-y-3">
    {[
      {
        action: 'Start/Stop dictation',
        shortcut: hotkey,
        description: 'Toggles recording and processing',
      },
      {
        action: 'Close overlay menu',
        shortcut: 'Esc',
        description: 'Closes the menu if it is open',
      },
      {
        action: 'Hide overlay',
        shortcut: 'Esc',
        description: 'Hides the icon when no menu is open',
      },
      {
        action: 'Overlay context menu',
        shortcut: 'Right click',
        description: 'Opens quick options',
      },
      {
        action: 'Cancel recording/processing',
        shortcut: 'Hover + X',
        description: 'Stops the current operation',
      },
    ].map((item) => (
      <Card key={item.action}>
        <CardContent className="flex items-center justify-between gap-4 py-4">
          <div>
            <p className="text-sm font-medium">{item.action}</p>
            <p className="text-xs text-muted-foreground">{item.description}</p>
          </div>
          <Badge tone="primary">{item.shortcut}</Badge>
        </CardContent>
      </Card>
    ))}
  </div>
)

const InfoSection = () => (
  <div className="space-y-4">
    <Card>
      <CardHeader>
        <CardTitle>Whispy Local</CardTitle>
        <CardDescription>Mock UI version: 0.1.0</CardDescription>
      </CardHeader>
      <CardContent className="space-y-3">
        <div className="rounded-md border border-border-subtle bg-surface-0 p-3 text-sm text-muted-foreground">
          Changelog (mock):
          <ul className="mt-2 list-disc space-y-1 pl-5">
            <li>Floating overlay with IDLE/RECORDING/PROCESSING states</li>
            <li>Complete control panel with onboarding</li>
            <li>Models section with simulated download flow</li>
          </ul>
        </div>
      </CardContent>
      <CardFooter>
        <Button
          variant="outline"
          onClick={() => {
            electronAPI.openExternal('https://example.com/support')
          }}
        >
          <Link className="h-3.5 w-3.5" /> Support
        </Button>
      </CardFooter>
    </Card>
  </div>
)

type SettingsNodeId =
  | 'general.activation'
  | 'general.behavior'
  | 'general.privacy'
  | 'models.transcriptions.cloud'
  | 'models.transcriptions.local'
  | 'models.post.cloud'
  | 'models.post.local'
  | 'prompts'
  | 'agent.name'
  | 'shortcuts'
  | 'info'

interface SettingsWorkspaceProps {
  settings: AppSettings
  models: ModelState[]
  postModels: ModelState[]
  onSettingsChange: (next: Partial<AppSettings>) => void
  onModelsChange: Dispatch<SetStateAction<ModelState[]>>
  onPostModelsChange: Dispatch<SetStateAction<ModelState[]>>
}

const SettingsWorkspace = ({
  settings,
  models,
  postModels,
  onSettingsChange,
  onModelsChange,
  onPostModelsChange,
}: SettingsWorkspaceProps) => {
  const [activeNode, setActiveNode] = useState<SettingsNodeId>('general.activation')
  const [expanded, setExpanded] = useState({
    general: true,
    models: true,
    transcriptions: true,
    postProcessing: true,
  })

  const currentRoot = activeNode.startsWith('general.')
    ? 'general'
    : activeNode.startsWith('models.')
      ? 'models'
      : activeNode === 'prompts'
        ? 'prompts'
        : activeNode.startsWith('agent.')
          ? 'agent'
      : activeNode

  useEffect(() => {
    if (currentRoot !== 'general' && currentRoot !== 'models' && currentRoot !== 'agent') {
      return
    }

    const target = document.getElementById(`settings-node-${activeNode}`)
    target?.scrollIntoView({
      behavior: 'smooth',
      block: 'start',
    })
  }, [activeNode, currentRoot])

  const renderContent = () => {
    if (currentRoot === 'general') {
      return <SettingsSection settings={settings} onChange={onSettingsChange} />
    }

    if (currentRoot === 'models') {
      return (
        <ModelsSection
          settings={settings}
          models={models}
          postModels={postModels}
          onSettingsChange={onSettingsChange}
          onModelsChange={onModelsChange}
          onPostModelsChange={onPostModelsChange}
        />
      )
    }

    if (currentRoot === 'prompts') {
      return <PromptsSection settings={settings} onChange={onSettingsChange} />
    }

    if (currentRoot === 'agent') {
      return <AgentIdentitySection settings={settings} onChange={onSettingsChange} />
    }

    if (currentRoot === 'shortcuts') {
      return <ShortcutsSection hotkey={settings.hotkey} />
    }

    return <InfoSection />
  }

  const leafClass = (nodeId: SettingsNodeId) =>
    cn(
      'app-no-drag flex h-8 w-full items-center rounded-md px-2.5 text-left text-sm transition-colors',
      activeNode === nodeId
        ? 'bg-primary/15 text-primary ring-1 ring-primary/25'
        : 'text-muted-foreground hover:bg-surface-2 hover:text-foreground',
    )

  const branchClass = 'app-no-drag flex h-8 w-full items-center gap-1.5 rounded-md px-2.5 text-left text-sm font-medium text-foreground hover:bg-surface-2'

  return (
    <div className="grid min-h-[620px] gap-4 rounded-[var(--radius-premium)] border border-border-subtle bg-surface-1/70 p-4 lg:grid-cols-[250px_1fr]">
      <aside className="rounded-[var(--radius-premium)] border border-border-subtle bg-surface-0 p-2">
        <nav className="space-y-1">
          <button
            type="button"
            className={branchClass}
            onClick={() => {
              setExpanded((current) => ({
                ...current,
                general: !current.general,
              }))
            }}
          >
            {expanded.general ? <ChevronDown className="h-3.5 w-3.5" /> : <ChevronRight className="h-3.5 w-3.5" />}
            General
          </button>
          {expanded.general ? (
            <div className="ml-4 space-y-1">
              <button type="button" className={leafClass('general.activation')} onClick={() => setActiveNode('general.activation')}>
                Activation
              </button>
              <button type="button" className={leafClass('general.behavior')} onClick={() => setActiveNode('general.behavior')}>
                Behavior
              </button>
              <button type="button" className={leafClass('general.privacy')} onClick={() => setActiveNode('general.privacy')}>
                Privacy / Local
              </button>
            </div>
          ) : null}

          <button
            type="button"
            className={branchClass}
            onClick={() => {
              setExpanded((current) => ({
                ...current,
                models: !current.models,
              }))
            }}
          >
            {expanded.models ? <ChevronDown className="h-3.5 w-3.5" /> : <ChevronRight className="h-3.5 w-3.5" />}
            Models
          </button>
          {expanded.models ? (
            <div className="ml-4 space-y-1">
              <button
                type="button"
                className={branchClass}
                onClick={() => {
                  setExpanded((current) => ({
                    ...current,
                    transcriptions: !current.transcriptions,
                  }))
                }}
              >
                {expanded.transcriptions ? (
                  <ChevronDown className="h-3.5 w-3.5" />
                ) : (
                  <ChevronRight className="h-3.5 w-3.5" />
                )}
                Transcriptions
              </button>
              {expanded.transcriptions ? (
                <div className="ml-4 space-y-1">
                  <button
                    type="button"
                    className={leafClass('models.transcriptions.cloud')}
                    onClick={() => setActiveNode('models.transcriptions.cloud')}
                  >
                    Cloud
                  </button>
                  <button
                    type="button"
                    className={leafClass('models.transcriptions.local')}
                    onClick={() => setActiveNode('models.transcriptions.local')}
                  >
                    Local
                  </button>
                </div>
              ) : null}

              <button
                type="button"
                className={branchClass}
                onClick={() => {
                  setExpanded((current) => ({
                    ...current,
                    postProcessing: !current.postProcessing,
                  }))
                }}
              >
                {expanded.postProcessing ? (
                  <ChevronDown className="h-3.5 w-3.5" />
                ) : (
                  <ChevronRight className="h-3.5 w-3.5" />
                )}
                Post-processing
              </button>
              {expanded.postProcessing ? (
                <div className="ml-4 space-y-1">
                  <button
                    type="button"
                    className={leafClass('models.post.cloud')}
                    onClick={() => setActiveNode('models.post.cloud')}
                  >
                    Cloud
                  </button>
                  <button
                    type="button"
                    className={leafClass('models.post.local')}
                    onClick={() => setActiveNode('models.post.local')}
                  >
                    Local
                  </button>
                </div>
              ) : null}
            </div>
          ) : null}

          <button type="button" className={leafClass('prompts')} onClick={() => setActiveNode('prompts')}>
            Prompts
          </button>

          <button type="button" className={leafClass('agent.name')} onClick={() => setActiveNode('agent.name')}>
            Agent name
          </button>

          <button type="button" className={leafClass('shortcuts')} onClick={() => setActiveNode('shortcuts')}>
            Shortcuts
          </button>
          <button type="button" className={leafClass('info')} onClick={() => setActiveNode('info')}>
            Info
          </button>
        </nav>
      </aside>

      <section className="min-h-0 overflow-y-auto pr-1">{renderContent()}</section>
    </div>
  )
}

interface OnboardingWizardProps {
  settings: AppSettings
  models: ModelState[]
  onSettingsChange: (next: Partial<AppSettings>) => void
  onComplete: () => void
}

const OnboardingWizard = ({ settings, models, onSettingsChange, onComplete }: OnboardingWizardProps) => {
  const [step, setStep] = useState(0)
  const [micPermission, setMicPermission] = useState(false)
  const [pastePermission, setPastePermission] = useState(false)

  const canProceed =
    step === 0
      ? true
      : step === 1
        ? Boolean(settings.provider && settings.modelId && settings.preferredLanguage)
        : step === 2
          ? micPermission && (isMacOS ? pastePermission : true)
          : Boolean(settings.hotkey)

  return (
    <div className="mx-auto flex h-full max-w-3xl items-center justify-center">
      <Card className="w-full">
        <CardHeader>
          <CardTitle>Onboarding | Step {step + 1}/4</CardTitle>
          <CardDescription>
            <div className="mt-2 h-2 overflow-hidden rounded-full bg-surface-3">
              <div
                className="h-full bg-primary transition-[width] duration-300"
                style={{
                  width: `${((step + 1) / 4) * 100}%`,
                }}
              />
            </div>
          </CardDescription>
        </CardHeader>
        <CardContent>
          {step === 0 ? (
            <div className="space-y-3">
              <p className="text-sm text-muted-foreground">
                Welcome to Whispy Local. This app captures your voice and transforms it into local text,
                ready to copy or paste into target apps.
              </p>
              <div className="grid gap-2 sm:grid-cols-3">
                <div className="rounded-md border border-border-subtle bg-surface-0 p-3 text-sm">Always-ready overlay</div>
                <div className="rounded-md border border-border-subtle bg-surface-0 p-3 text-sm">Full model controls</div>
                <div className="rounded-md border border-border-subtle bg-surface-0 p-3 text-sm">Local conversations</div>
              </div>
            </div>
          ) : null}

          {step === 1 ? (
            <div className="space-y-3">
              <p className="text-sm text-muted-foreground">
                Select provider, model, and preferred language for transcription.
              </p>
              <div className="grid gap-3 md:grid-cols-3">
                <select
                  className="app-no-drag h-9 rounded-[var(--radius-premium)] border border-border-subtle bg-surface-0 px-2.5 text-sm"
                  value={settings.provider}
                  onChange={(event) => {
                    onSettingsChange({ provider: event.target.value as AppSettings['provider'] })
                  }}
                >
                  {PROVIDERS.map((provider) => (
                    <option key={provider.id} value={provider.id}>
                      {provider.label}
                    </option>
                  ))}
                </select>

                <select
                  className="app-no-drag h-9 rounded-[var(--radius-premium)] border border-border-subtle bg-surface-0 px-2.5 text-sm"
                  value={settings.modelId}
                  onChange={(event) => {
                    onSettingsChange({ modelId: event.target.value })
                  }}
                >
                  {models.map((model) => (
                    <option key={model.id} value={model.id}>
                      {model.label}
                    </option>
                  ))}
                </select>

                <select
                  className="app-no-drag h-9 rounded-[var(--radius-premium)] border border-border-subtle bg-surface-0 px-2.5 text-sm"
                  value={settings.preferredLanguage}
                  onChange={(event) => {
                    onSettingsChange({ preferredLanguage: event.target.value })
                  }}
                >
                  {LANGUAGES.map((language) => (
                    <option key={language} value={language}>
                      {language}
                    </option>
                  ))}
                </select>
              </div>
            </div>
          ) : null}

          {step === 2 ? (
            <div className="space-y-3">
              <p className="text-sm text-muted-foreground">Confirm required permissions (mock UI).</p>
              <div className="space-y-2">
                <div className="flex items-center justify-between rounded-md border border-border-subtle bg-surface-0 px-3 py-2">
                  <p className="text-sm">Microphone access</p>
                  <Switch checked={micPermission} onCheckedChange={setMicPermission} />
                </div>
                {isMacOS ? (
                  <div className="flex items-center justify-between rounded-md border border-border-subtle bg-surface-0 px-3 py-2">
                    <p className="text-sm">Paste permission on macOS</p>
                    <Switch checked={pastePermission} onCheckedChange={setPastePermission} />
                  </div>
                ) : null}
              </div>
            </div>
          ) : null}

          {step === 3 ? (
            <div className="space-y-3">
              <p className="text-sm text-muted-foreground">
                Choose activation mode and test the hotkey combination in the field below.
              </p>
              <HotkeyInput
                value={settings.hotkey}
                onChange={(hotkey) => {
                  onSettingsChange({ hotkey })
                }}
              />
              <Tabs
                value={settings.activationMode}
                onValueChange={(value) => {
                  onSettingsChange({ activationMode: value as AppSettings['activationMode'] })
                }}
              >
                <TabsList>
                  <TabsTrigger value="tap">Tap to talk</TabsTrigger>
                  <TabsTrigger value="hold">Hold to talk</TabsTrigger>
                </TabsList>
              </Tabs>
            </div>
          ) : null}
        </CardContent>
        <CardFooter className="justify-between">
          <Button
            variant="ghost"
            onClick={() => {
              setStep((current) => Math.max(0, current - 1))
            }}
            disabled={step === 0}
          >
            Back
          </Button>

          <Button
            onClick={() => {
              if (step === 3) {
                onComplete()
                return
              }

              setStep((current) => Math.min(3, current + 1))
            }}
            disabled={!canProceed}
          >
            {step === 3 ? 'Finish setup' : 'Next'}
          </Button>
        </CardFooter>
      </Card>
    </div>
  )
}

const ControlPanelScene = () => {
  const { pushToast } = useToast()
  const { t } = useI18n()
  const [section, setSection] = useState<PanelSection>('conversations')
  const [settings, setSettings] = useState<AppSettings>(loadSettings)
  const [models, setModels] = useState<ModelState[]>(loadModelState)
  const [postModels, setPostModels] = useState<ModelState[]>(loadPostModelState)
  const [historyEntries, setHistoryEntries] = useState<HistoryEntry[]>([])
  const [historyLoading, setHistoryLoading] = useState(true)
  const [onboardingDone, setOnboardingDone] = useState(isOnboardingCompleted)

  useEffect(() => {
    const timer = window.setTimeout(() => {
      setHistoryEntries(loadHistory())
      setHistoryLoading(false)
    }, 600)

    return () => {
      window.clearTimeout(timer)
    }
  }, [])

  useEffect(() => {
    saveSettings(settings)
    document.documentElement.classList.toggle('dark', settings.theme === 'dark')
  }, [settings])

  useEffect(() => {
    saveModelState(models)
  }, [models])

  useEffect(() => {
    savePostModelState(postModels)
  }, [postModels])

  useEffect(() => {
    const offAutoHide = electronAPI.onFloatingIconAutoHideChanged((enabled) => {
      setSettings((current) => ({
        ...current,
        autoHideFloatingIcon: enabled,
      }))
    })

    const offFailure = electronAPI.onHotkeyRegistrationFailed((payload) => {
      pushToast({
        title: 'Hotkey unavailable',
        description: `${payload.requestedHotkey} | ${payload.reason}`,
        variant: 'destructive',
      })
    })

    const offFallback = electronAPI.onHotkeyFallbackUsed((payload) => {
      setSettings((current) => ({
        ...current,
        hotkey: payload.fallbackHotkey,
      }))

      pushToast({
        title: 'Fallback hotkey applied',
        description: payload.details,
      })
    })

    return () => {
      offAutoHide()
      offFailure()
      offFallback()
    }
  }, [pushToast])

  useEffect(() => {
    const onStorage = (event: StorageEvent) => {
      if (event.key === STORAGE_KEYS.history) {
        setHistoryEntries(loadHistory())
      }

      if (event.key === STORAGE_KEYS.settings) {
        setSettings(loadSettings())
      }

      if (event.key === STORAGE_KEYS.postModels) {
        setPostModels(loadPostModelState())
      }

      if (event.key === STORAGE_KEYS.appNotification) {
        const appNotification = parseAppNotification(event.newValue)
        if (appNotification) {
          pushToast(appNotification)
        }
      }
    }

    window.addEventListener('storage', onStorage)
    return () => {
      window.removeEventListener('storage', onStorage)
    }
  }, [pushToast])

  const handleSettingsChange = (next: Partial<AppSettings>) => {
    setSettings((current) => ({
      ...current,
      ...next,
    }))
  }

  const renderSection = () => {
    if (section === 'conversations') {
      return (
        <HistorySection
          entries={historyEntries}
          loading={historyLoading}
          onCopy={async (text) => {
            try {
              await navigator.clipboard.writeText(text)
              pushToast({
                title: 'Copied to clipboard',
                variant: 'success',
              })
            } catch {
              pushToast({
                title: 'Clipboard unavailable',
                variant: 'destructive',
              })
            }
          }}
          onDelete={(id) => {
            const nextHistory = historyEntries.filter((entry) => entry.id !== id)
            setHistoryEntries(nextHistory)
            saveHistory(nextHistory)
          }}
          onClear={() => {
            clearHistory()
            setHistoryEntries([])
            pushToast({
              title: 'Conversations removed',
            })
          }}
        />
      )
    }

    if (section === 'settings') {
      return (
        <SettingsWorkspace
          settings={settings}
          models={models}
          postModels={postModels}
          onSettingsChange={handleSettingsChange}
          onModelsChange={setModels}
          onPostModelsChange={setPostModels}
        />
      )
    }

    return null
  }

  return (
    <div className="flex h-screen flex-col bg-[radial-gradient(circle_at_top_right,rgba(99,102,241,0.16),transparent_42%),radial-gradient(circle_at_bottom_left,rgba(37,99,235,0.14),transparent_38%)] text-foreground">
      <header className="app-drag flex h-12 shrink-0 items-center justify-between border-b border-border-subtle bg-surface-1/90 px-4">
        <div className="flex items-center gap-2">
          <div className="flex items-center gap-1.5 pl-1">
            <span className="h-3 w-3 rounded-full bg-[#ff5f57]" />
            <span className="h-3 w-3 rounded-full bg-[#febc2e]" />
            <span className="h-3 w-3 rounded-full bg-[#28c840]" />
          </div>
          <div className="ml-3 flex items-center gap-2 text-sm font-medium text-muted-foreground">
            <Sparkles className="h-4 w-4 text-primary" />
            Whispy Local Control Panel
          </div>
        </div>

        <div className="flex items-center gap-2">
          <Button
            variant="ghost"
            size="sm"
            onClick={() => {
              electronAPI.showDictationPanel()
            }}
          >
            <PanelRight className="h-3.5 w-3.5" />
            Show overlay
          </Button>

          <Button
            variant="ghost"
            size="icon"
            onClick={() => {
              handleSettingsChange({
                theme: settings.theme === 'dark' ? 'light' : 'dark',
              })
            }}
          >
            {settings.theme === 'dark' ? <Sun className="h-4 w-4" /> : <Moon className="h-4 w-4" />}
          </Button>
        </div>
      </header>

      <div className="flex min-h-0 flex-1">
        <aside className="w-60 shrink-0 border-r border-border-subtle bg-surface-1/70 p-3">
          <nav className="space-y-1.5">
            <p className="px-2 text-[11px] font-semibold uppercase tracking-[0.08em] text-muted-foreground">Menu</p>
            {sectionItems.map((item) => {
              const Icon = item.icon
              return (
                <button
                  key={item.id}
                  type="button"
                  onClick={() => {
                    setSection(item.id)
                  }}
                  className={cn(
                    'app-no-drag flex h-10 w-full items-center gap-2 rounded-[var(--radius-premium)] px-3 text-sm transition-colors',
                    section === item.id
                      ? 'bg-primary/15 text-primary ring-1 ring-primary/25'
                      : 'text-muted-foreground hover:bg-surface-2 hover:text-foreground',
                  )}
                >
                  <Icon className="h-4 w-4" />
                  {t(item.labelKey)}
                </button>
              )
            })}
          </nav>

          <div className="mt-6 rounded-[var(--radius-premium)] border border-border-subtle bg-surface-0 p-3 text-xs text-muted-foreground">
            <p className="font-medium text-foreground">Local status</p>
            <p className="mt-1">
              Transcription runtime: {settings.transcriptionRuntime === 'cloud' ? 'Cloud' : 'Local'}
            </p>
            <p>
              Active transcription model:{' '}
              {settings.transcriptionRuntime === 'cloud'
                ? settings.transcriptionCloudModelId
                : settings.transcriptionLocalModelId}
            </p>
            <p>Language: {settings.preferredLanguage}</p>
          </div>
        </aside>

        <main className="min-h-0 flex-1 overflow-y-auto p-6">
          {!onboardingDone ? (
            <OnboardingWizard
              settings={settings}
              models={models}
              onSettingsChange={handleSettingsChange}
              onComplete={() => {
                setOnboardingCompleted(true)
                setOnboardingDone(true)
                pushToast({
                  title: 'Onboarding completed',
                  description: 'Your configuration is ready.',
                  variant: 'success',
                })
              }}
            />
          ) : (
            <div className="mx-auto max-w-5xl space-y-4">
              <div className="flex items-center justify-between gap-2">
                <div>
                  <h1 className="text-lg font-semibold">{t(sectionItems.find((item) => item.id === section)?.labelKey ?? '')}</h1>
                  <p className="text-sm text-muted-foreground">
                    Local-first interface ready for real IPC and services.
                  </p>
                </div>

                <div className="flex items-center gap-2 text-xs text-muted-foreground">
                  <Bell className="h-3.5 w-3.5" />
                  Mock runtime active
                </div>
              </div>
              {renderSection()}
            </div>
          )}
        </main>
      </div>
    </div>
  )
}

export const ControlPanelView = () => (
  <ToastProvider>
    <ControlPanelScene />
  </ToastProvider>
)
