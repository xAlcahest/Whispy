import {
  Bot,
  BrainCircuit,
  BookOpen,
  Cloud,
  Copy,
  Link,
  Lock,
  Mic,
  Minus,
  Moon,
  PanelRight,
  Plus,
  Search,
  Settings,
  Shield,
  SlidersHorizontal,
  Sparkles,
  Sun,
  Trash2,
  UserRound,
  Wrench,
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
import openaiLogoSvg from '@lobehub/icons-static-svg/icons/openai.svg?raw'
import grokLogoSvg from '@lobehub/icons-static-svg/icons/grok.svg?raw'
import groqLogoSvg from '@lobehub/icons-static-svg/icons/groq.svg?raw'
import metaColorLogoSvg from '@lobehub/icons-static-svg/icons/meta-color.svg?raw'
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
  AUTO_DETECT_LANGUAGE,
  AUTO_DETECT_SUPPORTED_TRANSCRIPTION_MODELS,
  CLOUD_POST_PROCESSING_CATALOG,
  CLOUD_TRANSCRIPTION_CATALOG,
  LANGUAGES,
  LANGUAGE_FLAG_BY_NAME,
  PROVIDERS,
  STORAGE_KEYS,
  TRANSCRIPTION_LANGUAGE_OPTIONS,
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

const buildTranslationComboHotkey = (baseHotkey: string) => {
  const sanitized = baseHotkey.trim()
  if (!sanitized) {
    return 'Ctrl+Insert'
  }

  const parts = sanitized.split('+').map((part) => part.trim())
  const preferredModifiers = ['Ctrl', 'Alt', 'Shift', isMacOS ? 'Cmd' : 'Meta']
  const modifierToAdd = preferredModifiers.find((modifier) => !parts.includes(modifier)) ?? 'Shift'

  return `${modifierToAdd}+${sanitized}`
}

const languageLabelWithFlag = (language: string) => `${LANGUAGE_FLAG_BY_NAME[language] ?? '🏳️'} ${language}`

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
  autoDetectSupported: boolean
  onChange: (next: Partial<AppSettings>) => void
}

interface TranslationModeSectionProps {
  settings: AppSettings
  onChange: (next: Partial<AppSettings>) => void
}

const TranslationModeSection = ({ settings, onChange }: TranslationModeSectionProps) => {
  const translationComboHotkey = buildTranslationComboHotkey(settings.hotkey)
  const translationHotkey =
    settings.translationHotkeyMode === 'combo' ? translationComboHotkey : settings.translationCustomHotkey

  return (
    <div className="space-y-4">
      <Card id="settings-node-translation" className="scroll-mt-6">
        <CardHeader>
          <CardTitle>Translation mode</CardTitle>
          <CardDescription>
            Dedicated translation controls isolated from the General section.
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-4">
          <div className="flex items-center justify-between gap-3">
            <div>
              <p className="text-sm font-medium">Enable translation mode</p>
              <p className="text-xs text-muted-foreground">
                When enabled, translation route can be triggered with its own hotkey.
              </p>
            </div>
            <Switch
              checked={settings.translationModeEnabled}
              onCheckedChange={(checked) => {
                onChange({ translationModeEnabled: checked })
              }}
            />
          </div>

          <Tabs
            value={settings.translationHotkeyMode}
            onValueChange={(value) => {
              onChange({ translationHotkeyMode: value as AppSettings['translationHotkeyMode'] })
            }}
          >
            <TabsList>
              <TabsTrigger value="combo">Use combo with main hotkey</TabsTrigger>
              <TabsTrigger value="custom">Use custom hotkey</TabsTrigger>
            </TabsList>
            <TabsContent value="combo" className="mt-3">
              <div className="rounded-md border border-border-subtle bg-surface-1 px-3 py-2 text-sm">
                Translation hotkey: <span className="font-semibold">{translationComboHotkey}</span>
              </div>
            </TabsContent>
            <TabsContent value="custom" className="mt-3">
              <HotkeyInput
                value={settings.translationCustomHotkey}
                onChange={(hotkey) => {
                  onChange({ translationCustomHotkey: hotkey })
                }}
              />
            </TabsContent>
          </Tabs>

          <div className="grid gap-3 md:grid-cols-2">
            <div className="space-y-1.5">
              <p className="text-sm font-medium">Source language</p>
              <select
                className="app-no-drag h-9 w-full rounded-[var(--radius-premium)] border border-border-subtle bg-surface-0 px-2.5 text-sm"
                value={settings.translationSourceLanguage}
                onChange={(event) => {
                  onChange({ translationSourceLanguage: event.target.value })
                }}
              >
                {TRANSCRIPTION_LANGUAGE_OPTIONS.map((language) => (
                  <option key={language} value={language}>
                    {languageLabelWithFlag(language)}
                  </option>
                ))}
              </select>
            </div>

            <div className="space-y-1.5">
              <p className="text-sm font-medium">Target language</p>
              <select
                className="app-no-drag h-9 w-full rounded-[var(--radius-premium)] border border-border-subtle bg-surface-0 px-2.5 text-sm"
                value={settings.translationTargetLanguage}
                onChange={(event) => {
                  onChange({ translationTargetLanguage: event.target.value })
                }}
              >
                {LANGUAGES.map((language) => (
                  <option key={language} value={language}>
                    {languageLabelWithFlag(language)}
                  </option>
                ))}
              </select>
            </div>
          </div>

          <div className="rounded-md border border-border-subtle bg-surface-0 px-3 py-2 text-sm text-muted-foreground">
            Active translation hotkey: <span className="font-semibold text-foreground">{translationHotkey}</span>
          </div>
        </CardContent>
      </Card>
    </div>
  )
}

const AccountSettingsPanel = ({ settings, onChange }: Pick<SettingsSectionProps, 'settings' | 'onChange'>) => (
  <div className="space-y-4">
    <Card>
      <CardHeader>
        <CardTitle>Account</CardTitle>
        <CardDescription>Local profile and primary activation controls.</CardDescription>
      </CardHeader>
      <CardContent className="space-y-2 text-sm text-muted-foreground">
        <p>Profile type: Local user</p>
        <p>Agent identity: {settings.agentName || 'Agent'}</p>
      </CardContent>
    </Card>

    <Card>
      <CardHeader>
        <CardTitle>Activation</CardTitle>
      </CardHeader>
      <CardContent className="space-y-4">
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
      </CardContent>
    </Card>
  </div>
)

const PreferencesSettingsPanel = ({
  settings,
  autoDetectSupported,
  onChange,
}: SettingsSectionProps) => (
  <Card>
    <CardHeader>
      <CardTitle>Preferences</CardTitle>
      <CardDescription>Language and behavior defaults for daily usage.</CardDescription>
    </CardHeader>
    <CardContent className="space-y-3">
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
      </div>

      <div className="rounded-md border border-border-subtle bg-surface-0 px-3 py-2.5">
        <p className="mb-2 text-sm">Transcription language</p>
        <select
          className="app-no-drag h-9 w-full rounded-[var(--radius-premium)] border border-border-subtle bg-surface-0 px-2.5 text-sm"
          value={settings.preferredLanguage}
          onChange={(event) => {
            onChange({ preferredLanguage: event.target.value })
          }}
        >
          {TRANSCRIPTION_LANGUAGE_OPTIONS.map((language) => (
            <option
              key={language}
              value={language}
              disabled={language === AUTO_DETECT_LANGUAGE && !autoDetectSupported}
            >
              {languageLabelWithFlag(language)}
            </option>
          ))}
        </select>
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
    </CardContent>
  </Card>
)

const PrivacyPanel = () => (
  <Card>
    <CardHeader>
      <CardTitle>Privacy</CardTitle>
      <CardDescription>Local-first privacy guarantees and data boundaries.</CardDescription>
    </CardHeader>
    <CardContent>
      <div className="rounded-[var(--radius-premium)] border border-primary/30 bg-primary/10 p-4 text-sm text-primary">
        Local processing: voice data is never uploaded online in this mock mode.
      </div>
    </CardContent>
  </Card>
)

const PermissionsSection = () => {
  const [microphonePermission, setMicrophonePermission] = useState(true)
  const [pastePermission, setPastePermission] = useState(isMacOS)
  const [automationPermission, setAutomationPermission] = useState(false)

  return (
    <Card>
      <CardHeader>
        <CardTitle>Permissions</CardTitle>
        <CardDescription>Mocked OS access toggles for app-level integrations.</CardDescription>
      </CardHeader>
      <CardContent className="space-y-3">
        <div className="flex items-center justify-between rounded-md border border-border-subtle bg-surface-0 px-3 py-2.5">
          <p className="text-sm">Microphone access</p>
          <Switch checked={microphonePermission} onCheckedChange={setMicrophonePermission} />
        </div>
        <div className="flex items-center justify-between rounded-md border border-border-subtle bg-surface-0 px-3 py-2.5">
          <p className="text-sm">Paste integration</p>
          <Switch checked={pastePermission} onCheckedChange={setPastePermission} />
        </div>
        <div className="flex items-center justify-between rounded-md border border-border-subtle bg-surface-0 px-3 py-2.5">
          <p className="text-sm">Automation access</p>
          <Switch checked={automationPermission} onCheckedChange={setAutomationPermission} />
        </div>
      </CardContent>
    </Card>
  )
}

interface ModelsSectionProps {
  scope: 'transcriptions' | 'post'
  mode: 'cloud' | 'local'
  settings: AppSettings
  models: ModelState[]
  postModels: ModelState[]
  onSettingsChange: (next: Partial<AppSettings>) => void
  onModelsChange: Dispatch<SetStateAction<ModelState[]>>
  onPostModelsChange: Dispatch<SetStateAction<ModelState[]>>
}

const renderProviderIcon = (providerId: string) => {
  const logoByProvider: Record<string, { svg: string; className?: string }> = {
    openai: {
      svg: openaiLogoSvg,
      className: 'text-[#10a37f]',
    },
    grok: {
      svg: grokLogoSvg,
      className: 'text-[#7c3aed]',
    },
    groq: {
      svg: groqLogoSvg,
      className: 'text-[#f55036]',
    },
    meta: {
      svg: metaColorLogoSvg,
    },
  }

  const providerLogo = logoByProvider[providerId]
  if (providerLogo) {
    return (
      <span
        className={cn(
          'inline-flex h-5 w-5 items-center justify-center [&>svg]:h-5 [&>svg]:w-5 [&>svg]:shrink-0',
          providerLogo.className,
        )}
        aria-hidden="true"
        dangerouslySetInnerHTML={{ __html: providerLogo.svg }}
      />
    )
  }

  return <Settings className="h-4 w-4 text-primary" aria-hidden="true" />
}

const ModelsSection = ({
  scope,
  mode,
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

  type TranscriptionApiKeyField =
    | 'transcriptionOpenAIApiKey'
    | 'transcriptionGrokApiKey'
    | 'transcriptionGroqApiKey'
    | 'transcriptionMetaApiKey'
    | 'transcriptionCustomApiKey'

  type PostProcessingApiKeyField =
    | 'postProcessingOpenAIApiKey'
    | 'postProcessingGrokApiKey'
    | 'postProcessingGroqApiKey'
    | 'postProcessingMetaApiKey'
    | 'postProcessingCustomApiKey'

  const transcriptionApiKeyFieldByProvider: Record<string, TranscriptionApiKeyField> = {
    openai: 'transcriptionOpenAIApiKey',
    grok: 'transcriptionGrokApiKey',
    groq: 'transcriptionGroqApiKey',
    meta: 'transcriptionMetaApiKey',
    custom: 'transcriptionCustomApiKey',
  }

  const postProcessingApiKeyFieldByProvider: Record<string, PostProcessingApiKeyField> = {
    openai: 'postProcessingOpenAIApiKey',
    grok: 'postProcessingGrokApiKey',
    groq: 'postProcessingGroqApiKey',
    meta: 'postProcessingMetaApiKey',
    custom: 'postProcessingCustomApiKey',
  }

  const getTranscriptionApiKey = (providerId: string) => {
    const key = transcriptionApiKeyFieldByProvider[providerId]
    if (!key) {
      return ''
    }

    return settings[key]
  }

  const setTranscriptionApiKey = (providerId: string, value: string) => {
    const key = transcriptionApiKeyFieldByProvider[providerId]
    if (!key) {
      return
    }

    onSettingsChange({
      [key]: value,
    } as Partial<AppSettings>)
  }

  const getPostProcessingApiKey = (providerId: string) => {
    const key = postProcessingApiKeyFieldByProvider[providerId]
    if (!key) {
      return ''
    }

    return settings[key]
  }

  const setPostProcessingApiKey = (providerId: string, value: string) => {
    const key = postProcessingApiKeyFieldByProvider[providerId]
    if (!key) {
      return
    }

    onSettingsChange({
      [key]: value,
    } as Partial<AppSettings>)
  }

  const providerButtonClass = (active: boolean) =>
    cn(
      'app-no-drag inline-flex h-10 items-center gap-2 px-4 text-sm font-medium transition-colors whitespace-nowrap',
      active
        ? 'bg-primary/12 text-foreground'
        : 'text-muted-foreground hover:bg-surface-2/70 hover:text-foreground',
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
      {scope === 'transcriptions' && mode === 'cloud' ? (
        <Card id="settings-node-models.transcriptions.cloud" className="scroll-mt-6">
        <CardHeader>
          <CardTitle>Transcriptions | Cloud</CardTitle>
          <CardDescription>
            Centered provider tabs with visible separators. Model choices remain listed one below another.
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-4">
          <div className="flex justify-center">
            <div className="max-w-full overflow-x-auto rounded-[var(--radius-premium)] border border-border-hover bg-surface-0/90 p-1">
              <div className="inline-flex min-w-max items-stretch divide-x divide-border-hover rounded-[calc(var(--radius-premium)-2px)] border border-border-subtle bg-surface-1/70">
                {CLOUD_TRANSCRIPTION_CATALOG.map((provider) => {
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
                      {renderProviderIcon(provider.providerId)}
                      {provider.providerLabel}
                    </button>
                  )
                })}
              </div>
            </div>
          </div>

          <div className="rounded-[var(--radius-premium)] border border-border-subtle bg-surface-0 p-3">
            <div className="mb-3 flex items-center justify-between gap-2">
              <p className="text-sm font-medium">{selectedTranscriptionProvider.providerLabel}</p>
              <Badge tone="primary">Cloud STT</Badge>
            </div>

            {selectedTranscriptionProvider.providerId === 'custom' ? (
              <div className="space-y-3">
                <div className="grid gap-3 md:grid-cols-2">
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
                    <p className="text-sm font-medium">Custom STT API key</p>
                    <Input
                      type="password"
                      value={settings.transcriptionCustomApiKey}
                      onChange={(event) => {
                        onSettingsChange({ transcriptionCustomApiKey: event.target.value })
                      }}
                      placeholder="Enter API key"
                    />
                  </div>
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
              <div className="space-y-3">
                <div className="max-w-md space-y-1.5">
                  <div className="space-y-1.5">
                    <p className="text-sm font-medium">API key</p>
                    <Input
                      type="password"
                      value={getTranscriptionApiKey(selectedTranscriptionProvider.providerId)}
                      onChange={(event) => {
                        setTranscriptionApiKey(selectedTranscriptionProvider.providerId, event.target.value)
                      }}
                      placeholder={`Enter ${selectedTranscriptionProvider.providerLabel} API key`}
                    />
                  </div>
                </div>

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
              </div>
            )}
          </div>
        </CardContent>
      </Card>
      ) : null}

      {scope === 'transcriptions' && mode === 'local' ? (
      <Card id="settings-node-models.transcriptions.local" className="scroll-mt-6">
        <CardHeader>
          <CardTitle>Transcriptions | Local</CardTitle>
          <CardDescription>
            {downloadedModels} downloaded models | storage path: ~/Library/Application Support/Whispy/models
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-2">
          {models.map((model) => (
            <div
              key={model.id}
              className={cn(
                'rounded-md border border-border-subtle bg-surface-0 p-3',
                settings.transcriptionLocalModelId === model.id ? 'border-primary/40 bg-primary/10' : undefined,
              )}
            >
              <div className="flex items-center justify-between gap-3">
                <div>
                  <p className="text-sm font-medium">{model.label}</p>
                  <p className="text-xs text-muted-foreground">
                    {model.size} | {model.speed} | {model.quality}
                  </p>
                </div>
                <div className="flex items-center gap-2">
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
                    {model.downloaded ? 'Remove' : 'Download'}
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
                    {settings.transcriptionLocalModelId === model.id ? 'Active' : 'Use local'}
                  </Button>
                </div>
              </div>
              <div className="mt-2 h-1.5 overflow-hidden rounded-full bg-surface-3">
                <div
                  className="h-full bg-primary transition-[width] duration-300"
                  style={{
                    width: `${model.progress}%`,
                  }}
                />
              </div>
              <p className="mt-1 text-xs text-muted-foreground">
                {model.downloading ? `Downloading ${model.progress}%` : model.downloaded ? 'Downloaded' : 'Not downloaded'}
              </p>
            </div>
          ))}
        </CardContent>
      </Card>
      ) : null}

      {scope === 'post' && mode === 'cloud' ? (
      <Card id="settings-node-models.post.cloud" className="scroll-mt-6">
        <CardHeader>
          <CardTitle>Post-processing | Cloud</CardTitle>
          <CardDescription>
            Centered provider tabs with visible separators. Model choices remain listed one below another.
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-4">
          <div className="flex justify-center">
            <div className="max-w-full overflow-x-auto rounded-[var(--radius-premium)] border border-border-hover bg-surface-0/90 p-1">
              <div className="inline-flex min-w-max items-stretch divide-x divide-border-hover rounded-[calc(var(--radius-premium)-2px)] border border-border-subtle bg-surface-1/70">
                {CLOUD_POST_PROCESSING_CATALOG.map((provider) => {
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
                      {renderProviderIcon(provider.providerId)}
                      {provider.providerLabel}
                    </button>
                  )
                })}
              </div>
            </div>
          </div>

          <div className="rounded-[var(--radius-premium)] border border-border-subtle bg-surface-0 p-3">
            <div className="mb-3 flex items-center justify-between gap-2">
              <p className="text-sm font-medium">{selectedPostProcessingProvider.providerLabel}</p>
              <Badge tone="primary">Cloud LLM</Badge>
            </div>

            {selectedPostProcessingProvider.providerId === 'custom' ? (
              <div className="space-y-3">
                <div className="grid gap-3 md:grid-cols-2">
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
                    <p className="text-sm font-medium">Custom LLM API key</p>
                    <Input
                      type="password"
                      value={settings.postProcessingCustomApiKey}
                      onChange={(event) => {
                        onSettingsChange({ postProcessingCustomApiKey: event.target.value })
                      }}
                      placeholder="Enter API key"
                    />
                  </div>
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
              <div className="space-y-3">
                <div className="max-w-md space-y-1.5">
                  <div className="space-y-1.5">
                    <p className="text-sm font-medium">API key</p>
                    <Input
                      type="password"
                      value={getPostProcessingApiKey(selectedPostProcessingProvider.providerId)}
                      onChange={(event) => {
                        setPostProcessingApiKey(selectedPostProcessingProvider.providerId, event.target.value)
                      }}
                      placeholder={`Enter ${selectedPostProcessingProvider.providerLabel} API key`}
                    />
                  </div>
                </div>

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
              </div>
            )}
          </div>
        </CardContent>
      </Card>
      ) : null}

      {scope === 'post' && mode === 'local' ? (
      <Card id="settings-node-models.post.local" className="scroll-mt-6">
        <CardHeader>
          <CardTitle>Post-processing | Local</CardTitle>
          <CardDescription>{downloadedPostModels} downloaded local LLM models</CardDescription>
        </CardHeader>
        <CardContent className="space-y-2">
          {postModels.map((model) => (
            <div
              key={model.id}
              className={cn(
                'rounded-md border border-border-subtle bg-surface-0 p-3',
                settings.postProcessingLocalModelId === model.id ? 'border-primary/40 bg-primary/10' : undefined,
              )}
            >
              <div className="flex items-center justify-between gap-3">
                <div>
                  <p className="text-sm font-medium">{model.label}</p>
                  <p className="text-xs text-muted-foreground">
                    {model.size} | {model.speed} | {model.quality}
                  </p>
                </div>
                <div className="flex items-center gap-2">
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
                    {model.downloaded ? 'Remove' : 'Download'}
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
                    {settings.postProcessingLocalModelId === model.id ? 'Active' : 'Use local'}
                  </Button>
                </div>
              </div>
              <div className="mt-2 h-1.5 overflow-hidden rounded-full bg-surface-3">
                <div
                  className="h-full bg-primary transition-[width] duration-300"
                  style={{
                    width: `${model.progress}%`,
                  }}
                />
              </div>
              <p className="mt-1 text-xs text-muted-foreground">
                {model.downloading ? `Downloading ${model.progress}%` : model.downloaded ? 'Downloaded' : 'Not downloaded'}
              </p>
            </div>
          ))}
        </CardContent>
      </Card>
      ) : null}
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
            placeholder="Agent"
          />
          <p className="text-xs text-muted-foreground">
            Example trigger sentence: "{settings.agentName || 'Agent'}, summarize this in bullets."
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

  const translationComboHotkey = useMemo(
    () => buildTranslationComboHotkey(settings.hotkey),
    [settings.hotkey],
  )

  const translationHotkey =
    settings.translationHotkeyMode === 'combo' ? translationComboHotkey : settings.translationCustomHotkey

  const runPromptTest = () => {
    const normalizedAgent = settings.agentName.trim().toLowerCase()
    const usesAgentRoute = normalizedAgent.length > 0 && testInput.toLowerCase().includes(normalizedAgent)

    const usesTranslationRoute =
      settings.translationModeEnabled && testInput.trim().toLowerCase().startsWith('translate:')

    if (usesTranslationRoute) {
      setTestOutput(
        `Route: Translation prompt\n\nSource: ${settings.translationSourceLanguage}\nTarget: ${settings.translationTargetLanguage}\nHotkey: ${translationHotkey}\n\nTemplate:\n${settings.translationPrompt}\n\nInput:\n${testInput.replace(/^translate:\s*/i, '')}`,
      )
      return
    }

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
                  Triggered when input includes: <span className="font-medium text-foreground">{settings.agentName || 'Agent'}</span>
                </p>
                <p className="mt-2 whitespace-pre-wrap text-sm text-foreground">{settings.agentPrompt}</p>
              </div>

              <div className="rounded-md border border-border-subtle bg-surface-0 p-3">
                <p className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">Translation mode</p>
                <p className="mt-1 text-xs text-muted-foreground">
                  {settings.translationModeEnabled
                    ? `Enabled | hotkey: ${translationHotkey}`
                    : 'Disabled'}
                </p>
                <p className="mt-1 text-xs text-muted-foreground">
                  {languageLabelWithFlag(settings.translationSourceLanguage)} {' -> '}
                  {languageLabelWithFlag(settings.translationTargetLanguage)}
                </p>
                <p className="mt-2 whitespace-pre-wrap text-sm text-foreground">{settings.translationPrompt}</p>
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

              <div className="space-y-1.5">
                <p className="text-sm font-medium">Translation prompt</p>
                <Textarea
                  value={settings.translationPrompt}
                  onChange={(event) => {
                    onChange({ translationPrompt: event.target.value })
                  }}
                  placeholder="Prompt used when translation mode is active."
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
                  placeholder={`Try text with "${settings.agentName || 'Agent'}" or prefix with "translate:".`}
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

const InfoSection = ({ settings }: { settings: AppSettings }) => (
  <div className="space-y-4">
    <Card>
      <CardHeader>
        <CardTitle>Runtime status</CardTitle>
      </CardHeader>
      <CardContent className="space-y-1 text-sm text-muted-foreground">
        <p>
          Transcription runtime: {settings.transcriptionRuntime === 'cloud' ? 'Cloud' : 'Local'}
        </p>
        <p>
          Active transcription model:{' '}
          {settings.transcriptionRuntime === 'cloud'
            ? settings.transcriptionCloudModelId
            : settings.transcriptionLocalModelId}
        </p>
        <p>Language: {settings.preferredLanguage}</p>
      </CardContent>
    </Card>

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
  | 'account'
  | 'preferences'
  | 'transcription'
  | 'dictionary'
  | 'ai-models'
  | 'prompts'
  | 'agent.name'
  | 'privacy'
  | 'permissions'
  | 'developer'
  | 'shortcuts'

interface SettingsMenuGroup {
  label: string
  items: Array<{ id: SettingsNodeId; label: string; icon: typeof Settings }>
}

const SETTINGS_MENU_GROUPS: SettingsMenuGroup[] = [
  {
    label: 'Profile',
    items: [{ id: 'account', label: 'Account', icon: UserRound }],
  },
  {
    label: 'App',
    items: [{ id: 'preferences', label: 'Preferences', icon: SlidersHorizontal }],
  },
  {
    label: 'Speech',
    items: [
      { id: 'transcription', label: 'Transcription', icon: Mic },
      { id: 'dictionary', label: 'Dictionary', icon: BookOpen },
    ],
  },
  {
    label: 'Intelligence',
    items: [
      { id: 'ai-models', label: 'AI Models', icon: BrainCircuit },
      { id: 'agent.name', label: 'Agent', icon: Bot },
      { id: 'prompts', label: 'Prompts', icon: Sparkles },
    ],
  },
  {
    label: 'System',
    items: [
      { id: 'privacy', label: 'Privacy', icon: Lock },
      { id: 'permissions', label: 'Permissions', icon: Shield },
      { id: 'developer', label: 'Developer', icon: Wrench },
      { id: 'shortcuts', label: 'Shortcuts', icon: Settings },
    ],
  },
]

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
  const [activeNode, setActiveNode] = useState<SettingsNodeId>('account')
  const [transcriptionMode, setTranscriptionMode] = useState<'cloud' | 'local'>(
    settings.transcriptionRuntime === 'local' ? 'local' : 'cloud',
  )
  const [postProcessingMode, setPostProcessingMode] = useState<'cloud' | 'local'>(
    settings.postProcessingRuntime === 'local' ? 'local' : 'cloud',
  )

  const activeTranscriptionModelId =
    settings.transcriptionRuntime === 'cloud'
      ? settings.transcriptionCloudModelId
      : settings.transcriptionLocalModelId

  const autoDetectSupported = AUTO_DETECT_SUPPORTED_TRANSCRIPTION_MODELS.has(activeTranscriptionModelId)

  useEffect(() => {
    if (autoDetectSupported || settings.preferredLanguage !== AUTO_DETECT_LANGUAGE) {
      return
    }

    onSettingsChange({ preferredLanguage: 'English' })
  }, [autoDetectSupported, onSettingsChange, settings.preferredLanguage])

  useEffect(() => {
    setTranscriptionMode(settings.transcriptionRuntime === 'local' ? 'local' : 'cloud')
  }, [settings.transcriptionRuntime])

  useEffect(() => {
    setPostProcessingMode(settings.postProcessingRuntime === 'local' ? 'local' : 'cloud')
  }, [settings.postProcessingRuntime])

  const renderContent = () => {
    if (activeNode === 'account') {
      return <AccountSettingsPanel settings={settings} onChange={onSettingsChange} />
    }

    if (activeNode === 'preferences') {
      return (
        <PreferencesSettingsPanel
          settings={settings}
          autoDetectSupported={autoDetectSupported}
          onChange={onSettingsChange}
        />
      )
    }

    if (activeNode === 'transcription') {
      return (
        <div className="space-y-4">
          <Tabs
            value={transcriptionMode}
            onValueChange={(value) => {
              setTranscriptionMode(value as 'cloud' | 'local')
            }}
          >
            <TabsList className="bg-surface-2/80">
              <TabsTrigger value="cloud">Cloud</TabsTrigger>
              <TabsTrigger value="local">Local</TabsTrigger>
            </TabsList>
          </Tabs>
          <ModelsSection
            scope="transcriptions"
            mode={transcriptionMode}
            settings={settings}
            models={models}
            postModels={postModels}
            onSettingsChange={onSettingsChange}
            onModelsChange={onModelsChange}
            onPostModelsChange={onPostModelsChange}
          />
        </div>
      )
    }

    if (activeNode === 'dictionary') {
      return <TranslationModeSection settings={settings} onChange={onSettingsChange} />
    }

    if (activeNode === 'ai-models') {
      return (
        <div className="space-y-4">
          <Tabs
            value={postProcessingMode}
            onValueChange={(value) => {
              setPostProcessingMode(value as 'cloud' | 'local')
            }}
          >
            <TabsList className="bg-surface-2/80">
              <TabsTrigger value="cloud">Cloud</TabsTrigger>
              <TabsTrigger value="local">Local</TabsTrigger>
            </TabsList>
          </Tabs>
          <ModelsSection
            scope="post"
            mode={postProcessingMode}
            settings={settings}
            models={models}
            postModels={postModels}
            onSettingsChange={onSettingsChange}
            onModelsChange={onModelsChange}
            onPostModelsChange={onPostModelsChange}
          />
        </div>
      )
    }

    if (activeNode === 'prompts') {
      return <PromptsSection settings={settings} onChange={onSettingsChange} />
    }

    if (activeNode === 'agent.name') {
      return <AgentIdentitySection settings={settings} onChange={onSettingsChange} />
    }

    if (activeNode === 'privacy') {
      return <PrivacyPanel />
    }

    if (activeNode === 'permissions') {
      return <PermissionsSection />
    }

    if (activeNode === 'shortcuts') {
      return <ShortcutsSection hotkey={settings.hotkey} />
    }

    return <InfoSection settings={settings} />
  }

  const menuItemClass = (nodeId: SettingsNodeId) =>
    cn(
      'relative app-no-drag flex h-10 w-full items-center gap-3 rounded-[10px] px-2.5 text-left text-sm transition-colors',
      activeNode === nodeId
        ? 'bg-surface-1 text-foreground shadow-[0_0_0_1px_var(--border-hover)]'
        : 'text-muted-foreground hover:bg-surface-2/60 hover:text-foreground',
    )

  return (
    <div className="grid min-h-[620px] gap-4 rounded-[var(--radius-premium)] border border-border-subtle bg-surface-1/70 p-4 lg:grid-cols-[260px_1fr]">
      <aside className="rounded-[var(--radius-premium)] border border-border-subtle bg-[#070a12] p-3">
        <p className="px-2 text-[11px] font-semibold uppercase tracking-[0.14em] text-[#6f7891]">Settings</p>
        <nav className="mt-4 space-y-4">
          {SETTINGS_MENU_GROUPS.map((group) => (
            <div key={group.label}>
              <p className="px-2 text-[11px] font-semibold uppercase tracking-[0.12em] text-[#4f586d]">{group.label}</p>
              <div className="mt-1.5 space-y-1">
                {group.items.map((item) => {
                  const Icon = item.icon
                  const active = activeNode === item.id

                  return (
                    <button
                      key={item.id}
                      type="button"
                      className={menuItemClass(item.id)}
                      onClick={() => {
                        setActiveNode(item.id)
                      }}
                    >
                      {active ? <span className="absolute left-0 top-2 bottom-2 w-0.5 rounded-full bg-primary" /> : null}
                      <span
                        className={cn(
                          'ml-2 inline-flex h-6 w-6 items-center justify-center rounded-full border',
                          active
                            ? 'border-primary/40 bg-primary/15 text-primary'
                            : 'border-border-subtle text-muted-foreground',
                        )}
                      >
                        <Icon className="h-3.5 w-3.5" />
                      </span>
                      <span>{item.label}</span>
                    </button>
                  )
                })}
              </div>
            </div>
          ))}
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
  const onboardingAutoDetectSupported = AUTO_DETECT_SUPPORTED_TRANSCRIPTION_MODELS.has(settings.modelId)

  useEffect(() => {
    if (onboardingAutoDetectSupported || settings.preferredLanguage !== AUTO_DETECT_LANGUAGE) {
      return
    }

    onSettingsChange({ preferredLanguage: 'English' })
  }, [onSettingsChange, onboardingAutoDetectSupported, settings.preferredLanguage])

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
                  {TRANSCRIPTION_LANGUAGE_OPTIONS.map((language) => (
                    <option
                      key={language}
                      value={language}
                      disabled={language === AUTO_DETECT_LANGUAGE && !onboardingAutoDetectSupported}
                    >
                      {language}
                    </option>
                  ))}
                </select>
                <p className="text-xs text-muted-foreground md:col-span-3">
                  {onboardingAutoDetectSupported
                    ? 'Auto-detect is available for this model.'
                    : 'Auto-detect is not available for this model.'}
                </p>
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

  const conversationsCountLabel = historyLoading
    ? '...'
    : historyEntries.length > 999
      ? '999+'
      : String(historyEntries.length)

  return (
    <div className="flex h-screen flex-col bg-[radial-gradient(circle_at_top_right,rgba(99,102,241,0.16),transparent_42%),radial-gradient(circle_at_bottom_left,rgba(37,99,235,0.14),transparent_38%)] text-foreground">
      <header className="app-drag flex h-12 shrink-0 items-center justify-between border-b border-border-subtle bg-surface-1/90 px-4">
        <div className="flex items-center gap-2">
          <div className="group app-no-drag flex items-center gap-1.5 pl-1">
            {[
              { id: 'close', color: '#ff5f57', icon: X },
              { id: 'minimize', color: '#febc2e', icon: Minus },
              { id: 'zoom', color: '#28c840', icon: Plus },
            ].map((control) => {
              const Icon = control.icon
              return (
                <button
                  key={control.id}
                  type="button"
                  aria-label={control.id}
                  className="relative h-3 w-3 rounded-full border border-black/10 transition-transform duration-150 hover:scale-105"
                  style={{ backgroundColor: control.color }}
                >
                  <Icon className="pointer-events-none absolute inset-0 m-auto h-2 w-2 text-black/60 opacity-0 transition-opacity duration-150 group-hover:opacity-95" />
                </button>
              )
            })}
          </div>
          <div className="ml-3 flex items-center gap-2 text-sm font-medium text-muted-foreground">
            <Sparkles className="h-4 w-4 text-primary" />
            <span>Whispy Local Control Panel</span>
            <button
              type="button"
              className={cn(
                'app-no-drag inline-flex h-7 w-7 items-center justify-center rounded-md transition-colors',
                section === 'settings'
                  ? 'bg-primary/15 text-primary ring-1 ring-primary/25'
                  : 'text-muted-foreground hover:bg-surface-2 hover:text-foreground',
              )}
              onClick={() => {
                setSection((current) => (current === 'settings' ? 'conversations' : 'settings'))
              }}
            >
              <Settings className="h-4 w-4" />
            </button>
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
              <div className="flex items-center gap-2">
                <h1 className="text-lg font-semibold">{section === 'conversations' ? t('menuConversations') : t('menuSettings')}</h1>
                {section === 'conversations' ? (
                  <span className="inline-flex min-w-6 items-center justify-center rounded-full border border-primary/30 bg-primary/15 px-1.5 text-[11px] font-semibold text-primary">
                    {conversationsCountLabel}
                  </span>
                ) : null}
              </div>
              <p className="text-sm text-muted-foreground">Local-first interface ready for real IPC and services.</p>
            </div>
            {renderSection()}
          </div>
        )}
      </main>
    </div>
  )
}

export const ControlPanelView = () => (
  <ToastProvider>
    <ControlPanelScene />
  </ToastProvider>
)
