import {
  Bot,
  BrainCircuit,
  BookOpen,
  Cloud,
  Copy,
  KeyRound,
  Link,
  Lock,
  Languages,
  Minus,
  Moon,
  Plus,
  Save,
  Search,
  Settings,
  SlidersHorizontal,
  Sparkles,
  Sun,
  Trash2,
  UserRound,
  Wrench,
  X,
} from 'lucide-react'
import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type Dispatch,
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
  refreshSettingsFromBackend,
  saveHistory,
  saveModelState,
  savePostModelState,
  saveSettings,
  setOnboardingCompleted,
} from '../lib/storage'
import type { AppSettings, HistoryEntry, ModelState } from '../types/app'
import type {
  AutoPasteBackendSupportPayload,
  DebugLogStatusPayload,
  DisplayServer,
  ModelDownloadProgressPayload,
  SecretStorageStatusPayload,
  WhisperRuntimeDiagnosticsPayload,
  WhisperRuntimeStatusPayload,
} from '../../../shared/ipc'
import {
  CUSTOM_MODEL_FETCH_ERROR,
  deriveModelsEndpointFromBaseUrl,
  extractModelIdsFromPayload,
} from '../../../shared/model-discovery'

type PanelSection = 'conversations' | 'settings'

const formatTimestamp = (value: number) =>
  new Intl.DateTimeFormat('en-US', {
    dateStyle: 'medium',
    timeStyle: 'short',
  }).format(value)

const isMacOS = navigator.userAgent.includes('Mac')
const useCustomWindowChrome = isMacOS

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

const escapeRegExp = (value: string) => value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')

const applyDictionaryRules = (text: string, rules: AppSettings['postProcessingDictionaryRules']) =>
  rules.reduce((currentText, rule) => {
    const sourceTerm = rule.source.trim()
    if (!sourceTerm) {
      return currentText
    }

    return currentText.replace(new RegExp(escapeRegExp(sourceTerm), 'gi'), rule.target)
  }, text)

const createDictionaryRule = (): AppSettings['postProcessingDictionaryRules'][number] => ({
  id: crypto.randomUUID(),
  source: '',
  target: '',
})

const AUTO_PASTE_BACKENDS: Array<{ id: AppSettings['autoPasteBackend']; label: string }> = [
  { id: 'wtype', label: 'wtype' },
  { id: 'xdotools', label: 'xdotools' },
  { id: 'ydotools', label: 'ydotools' },
]

const OPENAI_COMPATIBLE_BASE_URL_BY_PROVIDER: Record<string, string> = {
  openai: 'https://api.openai.com/v1',
  groq: 'https://api.groq.com/openai/v1',
  grok: 'https://api.x.ai/v1',
  meta: 'https://api.llama.com/compat/v1',
}

const isAutoPasteSupportPayload = (value: unknown): value is AutoPasteBackendSupportPayload => {
  if (!value || typeof value !== 'object') {
    return false
  }

  const payload = value as Partial<AutoPasteBackendSupportPayload>
  if (
    !Array.isArray(payload.statuses) ||
    typeof payload.checkedAt !== 'number' ||
    typeof payload.compositorName !== 'string'
  ) {
    return false
  }

  return payload.statuses.every((status) => {
    if (!status || typeof status !== 'object') {
      return false
    }

    const parsed = status as { id?: unknown; available?: unknown; details?: unknown }
    return (
      (parsed.id === 'wtype' || parsed.id === 'xdotools' || parsed.id === 'ydotools') &&
      typeof parsed.available === 'boolean' &&
      typeof parsed.details === 'string'
    )
  })
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
        className="font-mono text-[13px] tracking-wide"
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
  clearConfirmOpen: boolean
  onClearConfirmOpenChange: (open: boolean) => void
  onCopy: (text: string) => void
  onDelete: (id: string) => void
  onClear: () => void
}

const HistorySection = ({
  entries,
  loading,
  clearConfirmOpen,
  onClearConfirmOpenChange,
  onCopy,
  onDelete,
  onClear,
}: HistorySectionProps) => {
  const [expandedEntries, setExpandedEntries] = useState<Record<string, boolean>>({})

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
      {entries.length === 0 ? (
        <Card className="py-12">
          <CardContent className="flex flex-col items-center justify-center gap-2 text-center">
            <BookOpen className="h-10 w-10 text-muted-foreground" />
            <p className="font-medium">No transcriptions found</p>
            <p className="max-w-md text-sm text-muted-foreground">
              Start dictation from the floating panel. Transcriptions appear here with metadata and
              quick actions.
            </p>
          </CardContent>
        </Card>
      ) : (
        entries.map((entry) => {
          const expanded = Boolean(expandedEntries[entry.id])

          return (
            <Card key={entry.id}>
              <CardHeader className="px-4 py-3 pb-2">
                <div className="flex flex-wrap items-center justify-between gap-2">
                  <div className="space-y-0.5">
                    <CardTitle className="text-xs">{formatTimestamp(entry.timestamp)}</CardTitle>
                    <CardDescription className="text-xs">
                      {entry.language} | {entry.provider}/{entry.model}
                    </CardDescription>
                  </div>
                  <div className="flex items-center gap-1.5">
                    <Button
                      variant="outline"
                      size="sm"
                      className="h-8 px-2.5"
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
                      className="h-8 px-2.5"
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
              <CardContent className="px-4 pt-0 pb-3">
                <p
                  className={cn(
                    'whitespace-pre-wrap text-[13px] leading-5 text-muted-foreground',
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
                  className="app-no-drag mt-1.5 text-xs font-medium text-primary hover:text-primary/80"
                >
                  {expanded ? 'Collapse' : 'Expand'}
                </button>
              </CardContent>
            </Card>
          )
        })
      )}

      <Dialog
        open={clearConfirmOpen}
        onOpenChange={(open) => {
          onClearConfirmOpenChange(open)
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
                onClearConfirmOpenChange(false)
              }}
            >
              Cancel
            </Button>
            <Button
              variant="destructive"
              onClick={() => {
                onClear()
                onClearConfirmOpenChange(false)
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
  displayServer: DisplayServer
  autoPasteSupport: AutoPasteBackendSupportPayload | null
  autoPasteSupportLoading: boolean
  onRefreshAutoPasteSupport: () => void
  onChange: (next: Partial<AppSettings>) => void
}

interface TranslationModeSectionProps {
  settings: AppSettings
  onChange: (next: Partial<AppSettings>) => void
}

const TranslationModeSection = ({ settings, onChange }: TranslationModeSectionProps) => {
  return (
    <div className="space-y-4">
      <Card id="settings-node-translation" className="scroll-mt-6">
        <CardHeader>
          <CardTitle>Translation mode</CardTitle>
          <CardDescription>Configure translation behavior inside the Post-Processing workflow.</CardDescription>
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

          <div className="rounded-md border border-border-subtle bg-surface-1 px-3 py-2 text-sm text-muted-foreground">
            Translation hotkey is configured in Preferences under Activation keys.
          </div>

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

        </CardContent>
      </Card>
    </div>
  )
}

const DictionarySettingsSection = ({ settings, onChange }: Pick<SettingsSectionProps, 'settings' | 'onChange'>) => {
  const { pushToast } = useToast()
  const [previewInput, setPreviewInput] = useState('')
  const [savedRuleSnapshotById, setSavedRuleSnapshotById] = useState<
    Record<string, { source: string; target: string }>
  >(() =>
    Object.fromEntries(
      settings.postProcessingDictionaryRules
        .map((rule) => ({
          id: rule.id,
          source: rule.source.trim(),
          target: rule.target.trim(),
        }))
        .filter((rule) => rule.source.length > 0 && rule.target.length > 0)
        .map((rule) => [rule.id, { source: rule.source, target: rule.target }]),
    ),
  )

  useEffect(() => {
    setSavedRuleSnapshotById((current) => {
      const validRuleIds = new Set(settings.postProcessingDictionaryRules.map((rule) => rule.id))
      const nextEntries = Object.entries(current).filter(([id]) => validRuleIds.has(id))

      if (nextEntries.length === Object.keys(current).length) {
        return current
      }

      return Object.fromEntries(nextEntries)
    })
  }, [settings.postProcessingDictionaryRules])

  const activeRules = useMemo(
    () =>
      settings.postProcessingDictionaryRules.filter(
        (rule) => rule.source.trim().length > 0 && rule.target.trim().length > 0,
      ),
    [settings.postProcessingDictionaryRules],
  )

  const previewOutput = useMemo(() => {
    if (!previewInput.trim()) {
      return ''
    }

    if (!settings.postProcessingDictionaryEnabled || activeRules.length === 0) {
      return previewInput
    }

    return applyDictionaryRules(previewInput, activeRules)
  }, [activeRules, previewInput, settings.postProcessingDictionaryEnabled])

  return (
    <Card id="settings-node-dictionary" className="scroll-mt-6">
      <CardHeader>
        <div className="flex flex-wrap items-center justify-between gap-2">
          <div>
            <CardTitle>Dictionary</CardTitle>
            <CardDescription>
              Replace recurring misrecognized words during post-processing before final output.
            </CardDescription>
          </div>
          <Badge tone="primary">{activeRules.length} active</Badge>
        </div>
      </CardHeader>
      <CardContent className="space-y-4">
        <div className="flex items-center justify-between gap-3 rounded-md border border-border-subtle bg-surface-0 px-3 py-2.5">
          <div>
            <p className="text-sm font-medium">Enable dictionary replacements</p>
            <p className="text-xs text-muted-foreground">
              Applies replacement rules to post-processing text. Mock frontend behavior for now.
            </p>
          </div>
          <Switch
            checked={settings.postProcessingDictionaryEnabled}
            onCheckedChange={(checked) => {
              onChange({ postProcessingDictionaryEnabled: checked })
            }}
          />
        </div>

        <div className="space-y-2">
          <div className="flex items-center justify-between gap-2">
            <p className="text-sm font-medium">Replacement rules</p>
            <Button
              variant="outline"
              size="sm"
              disabled={!settings.postProcessingDictionaryEnabled}
              onClick={() => {
                onChange({
                  postProcessingDictionaryRules: [
                    ...settings.postProcessingDictionaryRules,
                    createDictionaryRule(),
                  ],
                })
              }}
            >
              <Plus className="h-3.5 w-3.5" /> Add rule
            </Button>
          </div>

          {settings.postProcessingDictionaryRules.length === 0 ? (
            <div className="rounded-md border border-dashed border-border-subtle bg-surface-0 px-3 py-4 text-sm text-muted-foreground">
              No dictionary rules yet. Add a rule to map incorrect words to the correct term.
            </div>
          ) : (
            <div className="space-y-2">
              {settings.postProcessingDictionaryRules.map((rule) => {
                const normalizedSource = rule.source.trim()
                const normalizedTarget = rule.target.trim()
                const canSaveRule = normalizedSource.length > 0 && normalizedTarget.length > 0
                const savedSnapshot = savedRuleSnapshotById[rule.id]
                const isRuleSaved =
                  Boolean(savedSnapshot) &&
                  savedSnapshot.source === normalizedSource &&
                  savedSnapshot.target === normalizedTarget
                const dictionaryEnabled = settings.postProcessingDictionaryEnabled
                const showSaveRule = dictionaryEnabled && canSaveRule && !isRuleSaved

                return (
                  <div
                    key={rule.id}
                    className={cn(
                      'grid gap-2 rounded-md border border-border-subtle bg-surface-0 p-2',
                      !dictionaryEnabled ? 'opacity-55' : undefined,
                      showSaveRule ? 'lg:grid-cols-[1fr_1fr_auto_auto]' : 'lg:grid-cols-[1fr_1fr_auto]',
                    )}
                  >
                    <Input
                      value={rule.source}
                      disabled={!dictionaryEnabled}
                      onChange={(event) => {
                        onChange({
                          postProcessingDictionaryRules: settings.postProcessingDictionaryRules.map((currentRule) =>
                            currentRule.id === rule.id
                              ? {
                                  ...currentRule,
                                  source: event.target.value,
                                }
                              : currentRule,
                          ),
                        })
                      }}
                      placeholder="Recognized text (example: Open Eye)"
                    />
                    <Input
                      value={rule.target}
                      disabled={!dictionaryEnabled}
                      onChange={(event) => {
                        onChange({
                          postProcessingDictionaryRules: settings.postProcessingDictionaryRules.map((currentRule) =>
                            currentRule.id === rule.id
                              ? {
                                  ...currentRule,
                                  target: event.target.value,
                                }
                              : currentRule,
                          ),
                        })
                      }}
                      placeholder="Replace with (example: OpenAI)"
                    />
                    {showSaveRule ? (
                      <Button
                        variant="ghost"
                        size="icon"
                        onClick={() => {
                          onChange({
                            postProcessingDictionaryRules: settings.postProcessingDictionaryRules.map((currentRule) =>
                              currentRule.id === rule.id
                                ? {
                                    ...currentRule,
                                    source: normalizedSource,
                                    target: normalizedTarget,
                                  }
                                : currentRule,
                            ),
                          })

                          setSavedRuleSnapshotById((current) => ({
                            ...current,
                            [rule.id]: {
                              source: normalizedSource,
                              target: normalizedTarget,
                            },
                          }))

                          pushToast({
                            title: 'Dictionary rule saved',
                            variant: 'success',
                          })
                        }}
                        aria-label="Save rule"
                      >
                        <Save className="h-4 w-4" />
                      </Button>
                    ) : null}
                    <Button
                      variant="ghost"
                      size="icon"
                      disabled={!dictionaryEnabled}
                      onClick={() => {
                        onChange({
                          postProcessingDictionaryRules: settings.postProcessingDictionaryRules.filter(
                            (currentRule) => currentRule.id !== rule.id,
                          ),
                        })
                      }}
                      aria-label="Remove rule"
                    >
                      <Trash2 className="h-4 w-4" />
                    </Button>
                  </div>
                )
              })}
            </div>
          )}

          {!settings.postProcessingDictionaryEnabled ? (
            <p className="text-xs text-muted-foreground">Dictionary is disabled: rules are visible in read-only mode.</p>
          ) : null}
        </div>

        {settings.postProcessingDictionaryEnabled ? (
          <>
            <div className="space-y-1.5">
              <p className="text-sm font-medium">Preview replacement</p>
              <Textarea
                value={previewInput}
                onChange={(event) => {
                  setPreviewInput(event.target.value)
                }}
                placeholder="Type sample text to preview dictionary replacements."
              />
            </div>

            <div className="rounded-md border border-border-subtle bg-surface-0 p-3">
              <p className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">Preview output</p>
              <p className="mt-2 whitespace-pre-wrap text-sm text-foreground">
                {previewInput.trim()
                  ? previewOutput
                  : 'No preview yet. Insert sample text above to verify replacements.'}
              </p>
            </div>
          </>
        ) : null}
      </CardContent>
    </Card>
  )
}

const AccountSettingsPanel = () => (
  <div className="space-y-4">
    <Card>
      <CardHeader>
        <CardTitle>Account</CardTitle>
        <CardDescription>Workspace identity and access metadata.</CardDescription>
      </CardHeader>
      <CardContent>
        <div className="rounded-[var(--radius-premium)] border border-border-subtle bg-surface-0 px-4 py-5 text-sm text-muted-foreground">
          Account data is fully local in this build. Cloud credentials are stored in your OS keychain
          when available.
        </div>
      </CardContent>
    </Card>
  </div>
)

const PreferencesSettingsPanel = ({
  settings,
  autoDetectSupported,
  displayServer,
  autoPasteSupport,
  autoPasteSupportLoading,
  onRefreshAutoPasteSupport,
  onChange,
}: SettingsSectionProps) => {
  const translationComboHotkey = buildTranslationComboHotkey(settings.hotkey)
  const translationHotkey =
    settings.translationHotkeyMode === 'combo' ? translationComboHotkey : settings.translationCustomHotkey

  return (
    <div className="space-y-4">
    <Card>
      <CardHeader>
        <CardTitle>Preferences</CardTitle>
        <CardDescription>Language and behavior defaults for daily usage.</CardDescription>
      </CardHeader>
      <CardContent className="space-y-3">
        <div className="space-y-3 rounded-md border border-border-subtle bg-surface-0 px-3 py-2.5">
          <div className="flex items-center justify-between gap-2">
            <p className="text-sm font-medium">Activation keys</p>
            <Badge tone="primary">{settings.activationMode === 'tap' ? 'Tap mode' : 'Hold mode'}</Badge>
          </div>

          <div className="space-y-3 rounded-md border border-border-subtle bg-surface-1/70 p-3">
            <div className="flex items-center justify-between gap-2">
              <p className="text-sm font-medium">Primary dictation</p>
              <span className="inline-flex items-center rounded-md border border-border-subtle bg-surface-0 px-2 py-1 text-xs font-semibold text-foreground">
                {settings.hotkey}
              </span>
            </div>

            <HotkeyInput
              value={settings.hotkey}
              onChange={(hotkey) => {
                onChange({ hotkey })
              }}
            />

            <Tabs
              value={settings.activationMode}
              onValueChange={(value) => {
                onChange({ activationMode: value as AppSettings['activationMode'] })
              }}
            >
              <TabsList className="grid w-full grid-cols-2">
                <TabsTrigger value="tap">Tap to talk</TabsTrigger>
                <TabsTrigger value="hold">Hold to talk</TabsTrigger>
              </TabsList>
              <TabsContent value="tap" className="mt-3">
                <p className="rounded-md border border-border-subtle bg-surface-0 p-3 text-sm text-muted-foreground">
                  Press {settings.hotkey} to start and press again to stop.
                </p>
              </TabsContent>
              <TabsContent value="hold" className="mt-3">
                <p className="rounded-md border border-border-subtle bg-surface-0 p-3 text-sm text-muted-foreground">
                  Hold {settings.hotkey} while speaking. Release to send.
                </p>
              </TabsContent>
            </Tabs>
          </div>

          <div className="space-y-3 rounded-md border border-border-subtle bg-surface-1/70 p-3">
            <div className="flex items-center justify-between gap-2">
              <p className="text-sm font-medium">Translation trigger</p>
              <span className="inline-flex items-center rounded-md border border-border-subtle bg-surface-0 px-2 py-1 text-xs font-semibold text-foreground">
                {translationHotkey || 'Not set'}
              </span>
            </div>

            <Tabs
              value={settings.translationHotkeyMode}
              onValueChange={(value) => {
                onChange({ translationHotkeyMode: value as AppSettings['translationHotkeyMode'] })
              }}
            >
              <TabsList className="grid w-full grid-cols-2">
                <TabsTrigger value="combo">Combo</TabsTrigger>
                <TabsTrigger value="custom">Custom</TabsTrigger>
              </TabsList>
              <TabsContent value="combo" className="mt-3">
                <div className="rounded-md border border-border-subtle bg-surface-0 px-3 py-2 text-sm text-muted-foreground">
                  Uses main hotkey combo: <span className="font-semibold text-foreground">{translationComboHotkey}</span>
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
          </div>
        </div>

        <div className="flex items-center justify-between rounded-md border border-border-subtle bg-surface-0 px-3 py-2.5">
          <p className="text-sm">Auto-hide floating icon</p>
          <Switch
            checked={settings.autoHideFloatingIcon}
            onCheckedChange={(checked) => {
              onChange({ autoHideFloatingIcon: checked })
            }}
          />
        </div>

        <div className="space-y-2 rounded-md border border-border-subtle bg-surface-0 px-3 py-2.5">
          <div className="flex items-center justify-between gap-3">
            <div>
              <p className="text-sm">Show runtime monitor on floating icon</p>
              <p className="text-xs text-muted-foreground">Always show CPU/CUDA mode with RAM and VRAM usage in the mic badge.</p>
            </div>
            <Switch
              checked={settings.overlayRuntimeBadgeEnabled}
              onCheckedChange={(checked) => {
                onChange({ overlayRuntimeBadgeEnabled: checked })
              }}
            />
          </div>
        </div>

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

        <div className="space-y-2 rounded-md border border-border-subtle bg-surface-0 px-3 py-2.5">
          <div className="flex items-center justify-between gap-3">
            <p className="text-sm font-medium">Auto-paste</p>
            <select
              className="app-no-drag h-9 w-[180px] rounded-[var(--radius-premium)] border border-border-subtle bg-surface-0 px-2.5 text-sm"
              value={settings.autoPasteBackend}
              onChange={(event) => {
                onChange({ autoPasteBackend: event.target.value as AppSettings['autoPasteBackend'] })
              }}
            >
              {AUTO_PASTE_BACKENDS.map((backend) => (
                <option key={backend.id} value={backend.id}>
                  {backend.label}
                </option>
              ))}
            </select>
          </div>

          <div className="rounded-md border border-border-subtle bg-surface-1/70 p-2.5">
            <div className="mb-2 flex items-center justify-between gap-2">
              <p className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">Backend detection</p>
              <Button
                size="sm"
                variant="ghost"
                className="h-7 px-2"
                onClick={onRefreshAutoPasteSupport}
                disabled={autoPasteSupportLoading}
              >
                {autoPasteSupportLoading ? 'Checking...' : 'Re-check'}
              </Button>
            </div>

            <p className="mb-2 text-[11px] text-muted-foreground">
              Runs a non-destructive probe for all three backends together (no clipboard access).
            </p>

            <div className="space-y-1.5">
              {AUTO_PASTE_BACKENDS.map((backend) => {
                const detectedStatus = autoPasteSupport?.statuses.find((status) => status.id === backend.id)
                const available = Boolean(detectedStatus?.available)
                const isWaylandWtypeError =
                  backend.id === 'wtype' &&
                  (autoPasteSupport?.detectedDisplayServer ?? displayServer) === 'wayland' &&
                  !available

                return (
                  <div
                    key={backend.id}
                    className="flex items-center justify-between rounded-md border border-border-subtle bg-surface-0 px-2.5 py-2"
                  >
                    <div className="min-w-0">
                      <p className="text-sm">{backend.label}</p>
                      <p className="truncate text-[11px] text-muted-foreground">
                        {detectedStatus?.details ?? 'No detection result yet'}
                      </p>
                    </div>
                    <Badge
                      tone={available ? 'success' : 'warning'}
                      className={cn('shrink-0', isWaylandWtypeError ? 'border-destructive/30 bg-destructive/10 text-destructive' : undefined)}
                    >
                      {isWaylandWtypeError ? 'ERROR' : available ? 'Detected' : 'Missing'}
                    </Badge>
                  </div>
                )
              })}
            </div>
          </div>

          {(() => {
            const currentWtypeStatus = autoPasteSupport?.statuses.find((status) => status.id === 'wtype')
            const shouldShowWtypeError =
              settings.autoPasteBackend === 'wtype' &&
              (autoPasteSupport?.detectedDisplayServer ?? displayServer) === 'wayland' &&
              Boolean(currentWtypeStatus) &&
              !currentWtypeStatus?.available

            if (!shouldShowWtypeError) {
              return null
            }

            const compositorName = autoPasteSupport?.compositorName ?? 'current compositor'

            return (
            <div className="rounded-md border border-destructive/40 bg-destructive/10 p-3 text-destructive">
              <p className="text-sm font-semibold">ERROR</p>
              <p className="mt-1 text-xs">Your compositor ({compositorName}) does not support wtype. Use ydotools instead.</p>
            </div>
            )
          })()}
        </div>

      </CardContent>
    </Card>
  </div>
  )
}

const PrivacyPanel = () => (
  <Card>
    <CardHeader>
      <CardTitle>Privacy</CardTitle>
      <CardDescription>Local-first privacy guarantees and data boundaries.</CardDescription>
    </CardHeader>
    <CardContent>
      <div className="rounded-[var(--radius-premium)] border border-primary/30 bg-primary/10 p-4 text-sm text-primary">
        Local processing keeps voice data on-device when a local runtime command is configured.
      </div>
    </CardContent>
  </Card>
)

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
  const [customTranscriptionModelScanLoading, setCustomTranscriptionModelScanLoading] = useState(false)
  const [customPostModelScanLoading, setCustomPostModelScanLoading] = useState(false)
  const [customTranscriptionModelScanError, setCustomTranscriptionModelScanError] = useState<string | null>(null)
  const [customPostModelScanError, setCustomPostModelScanError] = useState<string | null>(null)
  const [customTranscriptionScannedModels, setCustomTranscriptionScannedModels] = useState<string[]>([])
  const [customPostScannedModels, setCustomPostScannedModels] = useState<string[]>([])
  const [transcriptionCloudModelLayout, setTranscriptionCloudModelLayout] = useState<'single' | 'double'>('double')
  const [transcriptionScannedModelsByProvider, setTranscriptionScannedModelsByProvider] = useState<Record<string, string[]>>({})
  const [postScannedModelsByProvider, setPostScannedModelsByProvider] = useState<Record<string, string[]>>({})
  const [transcriptionProviderAutoScanLoading, setTranscriptionProviderAutoScanLoading] = useState(false)
  const [postProviderAutoScanLoading, setPostProviderAutoScanLoading] = useState(false)
  const [transcriptionProviderAutoScanError, setTranscriptionProviderAutoScanError] = useState<string | null>(null)
  const [postProviderAutoScanError, setPostProviderAutoScanError] = useState<string | null>(null)
  const [whisperRuntimeStatus, setWhisperRuntimeStatus] = useState<WhisperRuntimeStatusPayload | null>(null)
  const [whisperRuntimeDiagnostics, setWhisperRuntimeDiagnostics] = useState<WhisperRuntimeDiagnosticsPayload | null>(null)
  const [whisperRuntimeStatusLoading, setWhisperRuntimeStatusLoading] = useState(false)
  const [whisperRuntimeDiagnosticsLoading, setWhisperRuntimeDiagnosticsLoading] = useState(false)
  const [whisperRuntimeActionLoading, setWhisperRuntimeActionLoading] = useState<'cpu' | 'cuda' | null>(null)
  const transcriptionAutoScanRequestKeyRef = useRef('')
  const postAutoScanRequestKeyRef = useRef('')

  const setModelDownloading = async (
    scope: 'transcription' | 'post',
    modelId: string,
    setModels: Dispatch<SetStateAction<ModelState[]>>,
  ) => {
    setModels((current) =>
      current.map((model) =>
        model.id === modelId
          ? {
              ...model,
              downloading: true,
              progress: 0,
            }
          : model,
      ),
    )

    try {
      if (typeof window.electronAPI !== 'undefined') {
        await electronAPI.downloadLocalModel(scope, modelId)
      } else {
        await new Promise<void>((resolve) => {
          window.setTimeout(() => {
            resolve()
          }, 800)
        })
      }

      setModels((current) =>
        current.map((model) => {
          if (model.id !== modelId) {
            return model
          }

          return {
            ...model,
            progress: 100,
            downloading: false,
            downloaded: true,
          }
        }),
      )

      return true
    } catch {
      setModels((current) =>
        current.map((model) =>
          model.id === modelId
            ? {
                ...model,
                downloading: false,
                progress: model.downloaded ? 100 : 0,
              }
            : model,
        ),
      )

      return false
    }
  }

  const cancelModelDownloading = async (
    scope: 'transcription' | 'post',
    modelId: string,
    setModels: Dispatch<SetStateAction<ModelState[]>>,
  ) => {
    if (typeof window.electronAPI !== 'undefined') {
      const canceled = await electronAPI.cancelLocalModelDownload(scope, modelId)

      if (canceled) {
        setModels((current) =>
          current.map((model) =>
            model.id === modelId
              ? {
                  ...model,
                  downloading: false,
                  progress: model.downloaded ? 100 : 0,
                }
              : model,
          ),
        )
      }

      return canceled
    }

    setModels((current) =>
      current.map((model) =>
        model.id === modelId
          ? {
              ...model,
              downloading: false,
              progress: model.downloaded ? 100 : 0,
            }
          : model,
      ),
    )

    return true
  }

  const removeModel = async (
    scope: 'transcription' | 'post',
    modelId: string,
    setModels: Dispatch<SetStateAction<ModelState[]>>,
  ) => {
    try {
      if (typeof window.electronAPI !== 'undefined') {
        await electronAPI.removeLocalModel(scope, modelId)
      }
    } catch {
      return false
    }

    setModels((current) =>
      current.map((item) =>
        item.id === modelId
          ? {
              ...item,
              downloaded: false,
              downloading: false,
              progress: 0,
            }
          : item,
      ),
    )

    return true
  }

  const downloadedModels = models.filter((model) => model.downloaded).length
  const downloadedPostModels = postModels.filter((model) => model.downloaded).length

  const selectedTranscriptionProvider =
    CLOUD_TRANSCRIPTION_CATALOG.find((provider) => provider.providerId === settings.transcriptionCloudProvider) ??
    CLOUD_TRANSCRIPTION_CATALOG[0]

  const selectedPostProcessingProvider =
    CLOUD_POST_PROCESSING_CATALOG.find((provider) => provider.providerId === settings.postProcessingCloudProvider) ??
    CLOUD_POST_PROCESSING_CATALOG[0]

  const transcriptionModelsEndpoint = deriveModelsEndpointFromBaseUrl(settings.transcriptionCustomBaseUrl)
  const postProcessingModelsEndpoint = deriveModelsEndpointFromBaseUrl(settings.postProcessingCustomBaseUrl)

  const displayedTranscriptionCloudModels =
    selectedTranscriptionProvider.providerId === 'custom'
      ? []
      : (transcriptionScannedModelsByProvider[selectedTranscriptionProvider.providerId]?.map((modelId) => ({
          id: modelId,
          label: modelId,
        })) ?? selectedTranscriptionProvider.models)

  const displayedPostCloudModels =
    selectedPostProcessingProvider.providerId === 'custom'
      ? []
      : (postScannedModelsByProvider[selectedPostProcessingProvider.providerId]?.map((modelId) => ({
          id: modelId,
          label: modelId,
        })) ?? selectedPostProcessingProvider.models)

  const transcriptionModelGridClass =
    transcriptionCloudModelLayout === 'single'
      ? 'grid gap-2 grid-cols-1'
      : 'grid gap-2 grid-cols-1 md:grid-cols-2'

  const fetchCustomModels = async (baseUrl: string, apiKey: string) => {
    if (typeof window.electronAPI !== 'undefined') {
      return electronAPI.scanCustomModels(baseUrl, apiKey)
    }

    const modelsEndpoint = deriveModelsEndpointFromBaseUrl(baseUrl)
    if (!modelsEndpoint) {
      throw new Error(CUSTOM_MODEL_FETCH_ERROR)
    }

    const headers = new Headers({
      Accept: 'application/json',
    })

    const token = apiKey.trim()
    if (token) {
      headers.set('Authorization', `Bearer ${token}`)
      headers.set('x-api-key', token)
    }

    const response = await fetch(modelsEndpoint, {
      method: 'GET',
      headers,
    })

    if (!response.ok) {
      throw new Error(`HTTP_${response.status}`)
    }

    const payload = (await response.json()) as unknown
    const modelIds = extractModelIdsFromPayload(payload)
    if (modelIds.length === 0) {
      throw new Error('EMPTY_MODELS')
    }

    return modelIds
  }

  const refreshWhisperRuntimeStatus = useCallback(async () => {
    if (typeof window.electronAPI === 'undefined') {
      setWhisperRuntimeStatus({
        cpuInstalled: false,
        cudaInstalled: false,
        activeVariant: settings.whisperCppRuntimeVariant,
        runtimeDirectory: '',
        downloadUrls: {
          cpu: null,
          cuda: null,
        },
      })
      return
    }

    setWhisperRuntimeStatusLoading(true)
    try {
      const status = await electronAPI.getWhisperRuntimeStatus()
      setWhisperRuntimeStatus(status)
    } finally {
      setWhisperRuntimeStatusLoading(false)
    }
  }, [settings.whisperCppRuntimeVariant])

  const refreshWhisperRuntimeDiagnostics = useCallback(async () => {
    if (typeof window.electronAPI === 'undefined') {
      setWhisperRuntimeDiagnostics({
        checkedAt: Date.now(),
        selectedVariant: settings.whisperCppRuntimeVariant,
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

    setWhisperRuntimeDiagnosticsLoading(true)
    try {
      const diagnostics = await electronAPI.getWhisperRuntimeDiagnostics()
      setWhisperRuntimeDiagnostics(diagnostics)
    } finally {
      setWhisperRuntimeDiagnosticsLoading(false)
    }
  }, [settings.whisperCppRuntimeVariant])

  useEffect(() => {
    void refreshWhisperRuntimeStatus()
    void refreshWhisperRuntimeDiagnostics()
  }, [refreshWhisperRuntimeDiagnostics, refreshWhisperRuntimeStatus])

  useEffect(() => {
    if (scope !== 'transcriptions' || mode !== 'local') {
      return
    }

    const timer = window.setInterval(() => {
      void refreshWhisperRuntimeDiagnostics()
    }, 4500)

    return () => {
      window.clearInterval(timer)
    }
  }, [mode, refreshWhisperRuntimeDiagnostics, scope])

  const autoScanProviderModels = useCallback(
    async (scopeKey: 'transcription' | 'post', providerId: string, apiKey: string) => {
      const baseUrl = OPENAI_COMPATIBLE_BASE_URL_BY_PROVIDER[providerId]
      if (!baseUrl || !apiKey.trim()) {
        return
      }

      if (scopeKey === 'transcription') {
        setTranscriptionProviderAutoScanLoading(true)
        setTranscriptionProviderAutoScanError(null)
      } else {
        setPostProviderAutoScanLoading(true)
        setPostProviderAutoScanError(null)
      }

      try {
        const modelIds = await fetchCustomModels(baseUrl, apiKey)

        if (scopeKey === 'transcription') {
          setTranscriptionScannedModelsByProvider((current) => ({
            ...current,
            [providerId]: modelIds,
          }))

          if (!modelIds.includes(settings.transcriptionCloudModelId) && modelIds[0]) {
            onSettingsChange({
              transcriptionCloudModelId: modelIds[0],
            })
          }
        } else {
          setPostScannedModelsByProvider((current) => ({
            ...current,
            [providerId]: modelIds,
          }))

          if (!modelIds.includes(settings.postProcessingCloudModelId) && modelIds[0]) {
            onSettingsChange({
              postProcessingCloudModelId: modelIds[0],
            })
          }
        }
      } catch (error: unknown) {
        const message = error instanceof Error ? error.message : CUSTOM_MODEL_FETCH_ERROR
        if (scopeKey === 'transcription') {
          setTranscriptionProviderAutoScanError(message)
        } else {
          setPostProviderAutoScanError(message)
        }
      } finally {
        if (scopeKey === 'transcription') {
          setTranscriptionProviderAutoScanLoading(false)
        } else {
          setPostProviderAutoScanLoading(false)
        }
      }
    },
    [
      fetchCustomModels,
      onSettingsChange,
      settings.postProcessingCloudModelId,
      settings.transcriptionCloudModelId,
    ],
  )

  useEffect(() => {
    if (selectedTranscriptionProvider.providerId === 'custom') {
      return
    }

    const apiKey = getTranscriptionApiKey(selectedTranscriptionProvider.providerId)
    const requestKey = `${selectedTranscriptionProvider.providerId}:${apiKey}`
    if (!apiKey.trim() || transcriptionAutoScanRequestKeyRef.current === requestKey) {
      return
    }

    transcriptionAutoScanRequestKeyRef.current = requestKey
    void autoScanProviderModels('transcription', selectedTranscriptionProvider.providerId, apiKey)
  }, [
    autoScanProviderModels,
    getTranscriptionApiKey,
    selectedTranscriptionProvider.providerId,
    settings.transcriptionOpenAIApiKey,
    settings.transcriptionGroqApiKey,
    settings.transcriptionGrokApiKey,
    settings.transcriptionMetaApiKey,
  ])

  useEffect(() => {
    if (selectedPostProcessingProvider.providerId === 'custom') {
      return
    }

    const apiKey = getPostProcessingApiKey(selectedPostProcessingProvider.providerId)
    const requestKey = `${selectedPostProcessingProvider.providerId}:${apiKey}`
    if (!apiKey.trim() || postAutoScanRequestKeyRef.current === requestKey) {
      return
    }

    postAutoScanRequestKeyRef.current = requestKey
    void autoScanProviderModels('post', selectedPostProcessingProvider.providerId, apiKey)
  }, [
    autoScanProviderModels,
    getPostProcessingApiKey,
    selectedPostProcessingProvider.providerId,
    settings.postProcessingOpenAIApiKey,
    settings.postProcessingGroqApiKey,
    settings.postProcessingGrokApiKey,
    settings.postProcessingMetaApiKey,
  ])

  const handleCustomTranscriptionModelScan = async () => {
    if (!transcriptionModelsEndpoint) {
      setCustomTranscriptionModelScanError(CUSTOM_MODEL_FETCH_ERROR)
      setCustomTranscriptionScannedModels([])
      return
    }

    setCustomTranscriptionModelScanLoading(true)
    setCustomTranscriptionModelScanError(null)

    try {
      const modelIds = await fetchCustomModels(settings.transcriptionCustomBaseUrl, settings.transcriptionCustomApiKey)
      setCustomTranscriptionScannedModels(modelIds)

      if (!settings.transcriptionCustomModel.trim() && modelIds[0]) {
        onSettingsChange({
          transcriptionCustomModel: modelIds[0],
          transcriptionCloudModelId: modelIds[0],
        })
      }

      pushToast({
        title: 'Custom STT models fetched',
        description: `${modelIds.length} model${modelIds.length > 1 ? 's' : ''} discovered.`,
        variant: 'success',
      })
    } catch {
      setCustomTranscriptionScannedModels([])
      setCustomTranscriptionModelScanError(
        `${CUSTOM_MODEL_FETCH_ERROR} Endpoint: ${transcriptionModelsEndpoint}`,
      )
    } finally {
      setCustomTranscriptionModelScanLoading(false)
    }
  }

  const handleCustomPostModelScan = async () => {
    if (!postProcessingModelsEndpoint) {
      setCustomPostModelScanError(CUSTOM_MODEL_FETCH_ERROR)
      setCustomPostScannedModels([])
      return
    }

    setCustomPostModelScanLoading(true)
    setCustomPostModelScanError(null)

    try {
      const modelIds = await fetchCustomModels(settings.postProcessingCustomBaseUrl, settings.postProcessingCustomApiKey)
      setCustomPostScannedModels(modelIds)

      if (!settings.postProcessingCustomModel.trim() && modelIds[0]) {
        onSettingsChange({
          postProcessingCustomModel: modelIds[0],
          postProcessingCloudModelId: modelIds[0],
        })
      }

      pushToast({
        title: 'Custom LLM models fetched',
        description: `${modelIds.length} model${modelIds.length > 1 ? 's' : ''} discovered.`,
        variant: 'success',
      })
    } catch {
      setCustomPostScannedModels([])
      setCustomPostModelScanError(
        `${CUSTOM_MODEL_FETCH_ERROR} Endpoint: ${postProcessingModelsEndpoint}`,
      )
    } finally {
      setCustomPostModelScanLoading(false)
    }
  }

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

  function getTranscriptionApiKey(providerId: string) {
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

  function getPostProcessingApiKey(providerId: string) {
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

  const providerApiKeyDocsByProvider: Record<string, string> = {
    openai: 'https://platform.openai.com/api-keys',
    grok: 'https://console.x.ai/team/api-keys',
    groq: 'https://console.groq.com/keys',
    meta: 'https://www.llama.com/docs/api/getting-started/',
  }

  const getProviderApiKeyDocsUrl = (providerId: string) => providerApiKeyDocsByProvider[providerId] ?? null

  const transcriptionApiKeyDocsUrl = getProviderApiKeyDocsUrl(selectedTranscriptionProvider.providerId)
  const postProcessingApiKeyDocsUrl = getProviderApiKeyDocsUrl(selectedPostProcessingProvider.providerId)

  const providerButtonClass = (active: boolean) =>
    cn(
      'app-no-drag inline-flex h-10 w-full items-center justify-center gap-2 rounded-[var(--radius-premium)] px-3 text-sm font-medium transition-colors whitespace-nowrap',
      active
        ? 'border border-primary/35 bg-primary/12 text-foreground'
        : 'border border-border-subtle bg-surface-1/60 text-muted-foreground hover:bg-surface-2/70 hover:text-foreground',
    )

  const modelItemClass = (active: boolean) =>
    cn(
      'app-no-drag flex min-h-11 w-full items-center justify-between gap-2 rounded-md border px-3 py-2 text-left text-sm transition-colors',
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
            Providers stay visible and wrap responsively based on available width.
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-4">
          <div className="rounded-[var(--radius-premium)] border border-border-hover bg-surface-0/90 p-2">
            <div className="grid gap-2 [grid-template-columns:repeat(auto-fit,minmax(150px,1fr))]">
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

          <div className="rounded-[var(--radius-premium)] border border-border-subtle bg-surface-0 p-3">
            <div className="mb-3 flex items-center justify-between gap-2">
              <p className="text-sm font-medium">{selectedTranscriptionProvider.providerLabel}</p>
              <div className="flex items-center gap-2">
                <Badge tone="primary">Cloud STT</Badge>
                <div className="inline-flex overflow-hidden rounded-md border border-border-subtle bg-surface-1">
                  <button
                    type="button"
                    className={cn(
                      'app-no-drag px-2.5 py-1 text-[11px] font-medium transition-colors',
                      transcriptionCloudModelLayout === 'single'
                        ? 'bg-primary/12 text-primary'
                        : 'text-muted-foreground hover:text-foreground',
                    )}
                    onClick={() => {
                      setTranscriptionCloudModelLayout('single')
                    }}
                  >
                    1 per row
                  </button>
                  <button
                    type="button"
                    className={cn(
                      'app-no-drag px-2.5 py-1 text-[11px] font-medium transition-colors',
                      transcriptionCloudModelLayout === 'double'
                        ? 'bg-primary/12 text-primary'
                        : 'text-muted-foreground hover:text-foreground',
                    )}
                    onClick={() => {
                      setTranscriptionCloudModelLayout('double')
                    }}
                  >
                    2 per row
                  </button>
                </div>
              </div>
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

                <div className="space-y-2 rounded-md border border-border-subtle bg-surface-1/70 p-3">
                  <div className="flex flex-wrap items-center justify-between gap-2">
                    <p className="text-sm font-medium">Model endpoint scan</p>
                    <Button
                      size="sm"
                      variant="outline"
                      disabled={customTranscriptionModelScanLoading}
                      onClick={() => {
                        void handleCustomTranscriptionModelScan()
                      }}
                    >
                      <Search className="h-3.5 w-3.5" />
                      {customTranscriptionModelScanLoading ? 'Scanning...' : 'Scan models'}
                    </Button>
                  </div>

                  <p className="text-xs text-muted-foreground">
                    {transcriptionModelsEndpoint
                      ? `Models endpoint: ${transcriptionModelsEndpoint}`
                      : 'Enter a valid custom endpoint URL to enable model scanning.'}
                  </p>

                  {customTranscriptionModelScanError ? (
                    <p className="rounded-md border border-destructive/40 bg-destructive/10 px-2.5 py-2 text-xs text-destructive">
                      {customTranscriptionModelScanError}
                    </p>
                  ) : null}

                  {customTranscriptionScannedModels.length > 0 ? (
                    <div className="grid gap-2 [grid-template-columns:repeat(auto-fit,minmax(210px,1fr))]">
                      {customTranscriptionScannedModels.map((modelId) => {
                        const active = settings.transcriptionCustomModel === modelId

                        return (
                          <button
                            key={modelId}
                            type="button"
                            className={modelItemClass(active)}
                            onClick={() => {
                              onSettingsChange({
                                transcriptionCustomModel: modelId,
                                transcriptionCloudModelId: modelId,
                              })
                            }}
                          >
                            <span className="min-w-0 break-words">{modelId}</span>
                            {active ? (
                              <Badge tone="primary" className="shrink-0">Selected</Badge>
                            ) : (
                              <span className="shrink-0 text-xs text-muted-foreground">Use model</span>
                            )}
                          </button>
                        )
                      })}
                    </div>
                  ) : null}
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
                  {transcriptionApiKeyDocsUrl ? (
                    <p className="text-xs text-muted-foreground">
                      If you want to create and use an API key here, use{' '}
                      <button
                        type="button"
                        className="app-no-drag inline-flex items-center gap-1 text-primary hover:text-primary/80"
                        onClick={() => {
                          electronAPI.openExternal(transcriptionApiKeyDocsUrl)
                        }}
                      >
                        this link
                        <Link className="h-3 w-3" />
                      </button>
                      .
                    </p>
                  ) : null}

                  {transcriptionProviderAutoScanLoading ? (
                    <p className="text-xs text-muted-foreground">Auto-scanning provider endpoint models...</p>
                  ) : null}

                  {transcriptionProviderAutoScanError ? (
                    <p className="rounded-md border border-destructive/40 bg-destructive/10 px-2.5 py-2 text-xs text-destructive">
                      {transcriptionProviderAutoScanError}
                    </p>
                  ) : null}
                </div>

                <div className={transcriptionModelGridClass}>
                  {displayedTranscriptionCloudModels.map((model) => {
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
                        <span className="min-w-0 break-words">{model.label}</span>
                        {active ? (
                          <Badge tone="primary" className="shrink-0">Active</Badge>
                        ) : (
                          <span className="shrink-0 text-xs text-muted-foreground">Select</span>
                        )}
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
            {downloadedModels} downloaded models | stored in app data directory
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-2">
          <div className="space-y-3 rounded-md border border-border-subtle bg-surface-0 p-3">
            <div className="flex items-center justify-between gap-2">
              <p className="text-sm font-medium">Whisper.cpp runtime</p>
              <select
                className="app-no-drag h-8 rounded-[var(--radius-premium)] border border-border-subtle bg-surface-0 px-2 text-xs"
                value={settings.whisperCppRuntimeVariant}
                onChange={(event) => {
                  onSettingsChange({
                    whisperCppRuntimeVariant: event.target.value as AppSettings['whisperCppRuntimeVariant'],
                  })
                }}
              >
                <option value="cpu">CPU runtime</option>
                <option value="cuda">CUDA runtime</option>
              </select>
            </div>

            <p className="text-xs text-muted-foreground">
              Download official whisper.cpp runtime binaries or use a system whisper-server install. Active runtime:{' '}
              {settings.whisperCppRuntimeVariant.toUpperCase()}
            </p>

            {whisperRuntimeStatus ? (
              <div className="space-y-1 text-xs text-muted-foreground">
                <p>Runtime directory: {whisperRuntimeStatus.runtimeDirectory}</p>
                <p>
                  CPU source:{' '}
                  {whisperRuntimeStatus.downloadUrls.cpu ? (
                    <span className="break-all text-foreground/80">{whisperRuntimeStatus.downloadUrls.cpu}</span>
                  ) : (
                    <span className="text-amber-500">No official prebuilt URL for this platform (download will build from source)</span>
                  )}
                </p>
                <p>
                  CUDA source:{' '}
                  {whisperRuntimeStatus.downloadUrls.cuda ? (
                    <span className="break-all text-foreground/80">{whisperRuntimeStatus.downloadUrls.cuda}</span>
                  ) : (
                    <span className="text-amber-500">No official prebuilt URL for this platform (download will build from source)</span>
                  )}
                </p>
              </div>
            ) : null}

            <div className="rounded-md border border-border-subtle bg-surface-1/60 p-2">
              <div className="mb-2 flex items-center justify-between gap-2">
                <p className="text-xs font-medium">Runtime diagnostics</p>
                <Button
                  variant="ghost"
                  size="sm"
                  className="h-7 px-2 text-xs"
                  disabled={whisperRuntimeDiagnosticsLoading}
                  onClick={() => {
                    void refreshWhisperRuntimeDiagnostics()
                  }}
                >
                  {whisperRuntimeDiagnosticsLoading ? 'Checking...' : 'Run check'}
                </Button>
              </div>

              {whisperRuntimeDiagnostics ? (
                <div className="space-y-1 text-[11px] text-muted-foreground">
                  <p>
                    Server: {whisperRuntimeDiagnostics.running ? 'running' : 'stopped'}
                    {whisperRuntimeDiagnostics.running && whisperRuntimeDiagnostics.healthy ? ' (healthy)' : ''}
                    {whisperRuntimeDiagnostics.pid ? ` | PID ${whisperRuntimeDiagnostics.pid}` : ''}
                    {whisperRuntimeDiagnostics.port ? ` | Port ${whisperRuntimeDiagnostics.port}` : ''}
                  </p>
                  <p>
                    Active variant: {whisperRuntimeDiagnostics.activeVariant ?? 'n/a'} | Selected variant:{' '}
                    {whisperRuntimeDiagnostics.selectedVariant}
                  </p>
                  <p>Command: {whisperRuntimeDiagnostics.commandPath ?? 'not resolved'}</p>
                  <p>
                    Source: {whisperRuntimeDiagnostics.commandSource ?? 'n/a'} | RSS:{' '}
                    {whisperRuntimeDiagnostics.processRssMB === null
                      ? 'n/a'
                      : `${whisperRuntimeDiagnostics.processRssMB.toFixed(1)} MB`}
                  </p>
                  <p>
                    CUDA visibility: {whisperRuntimeDiagnostics.nvidiaSmiAvailable ? 'nvidia-smi detected' : 'nvidia-smi missing'}
                    {whisperRuntimeDiagnostics.cudaProcessDetected
                      ? ` | VRAM ${whisperRuntimeDiagnostics.vramUsedMB?.toFixed(1) ?? '0.0'} MB`
                      : ''}
                  </p>
                  <p className="text-foreground/80">{whisperRuntimeDiagnostics.notes}</p>
                </div>
              ) : (
                <p className="text-[11px] text-muted-foreground">Runtime diagnostics unavailable.</p>
              )}
            </div>

            <div className="grid gap-2 sm:grid-cols-2">
              {(['cpu', 'cuda'] as const).map((variant) => {
                const installed = variant === 'cpu' ? whisperRuntimeStatus?.cpuInstalled : whisperRuntimeStatus?.cudaInstalled

                return (
                  <div key={variant} className="rounded-md border border-border-subtle bg-surface-1/60 p-2">
                    <div className="mb-2 flex items-center justify-between gap-2">
                      <p className="text-xs font-medium uppercase tracking-wide">{variant}</p>
                      <Badge tone={installed ? 'success' : 'warning'}>{installed ? 'Installed' : 'Missing'}</Badge>
                    </div>

                    <div className="flex items-center gap-2">
                      <Button
                        variant="outline"
                        size="sm"
                        className="h-8 w-full"
                        disabled={whisperRuntimeActionLoading !== null || whisperRuntimeStatusLoading}
                        onClick={() => {
                          setWhisperRuntimeActionLoading(variant)

                          void electronAPI
                            .downloadWhisperRuntime(variant)
                            .then(() => {
                              pushToast({
                                title: `Whisper ${variant.toUpperCase()} runtime downloaded`,
                                variant: 'success',
                              })
                            })
                            .catch((error: unknown) => {
                              const message =
                                error instanceof Error
                                  ? error.message
                                  : `Unable to download Whisper ${variant.toUpperCase()} runtime.`

                              pushToast({
                                title: `Whisper ${variant.toUpperCase()} runtime download failed`,
                                description: message,
                                variant: 'destructive',
                              })
                            })
                            .finally(() => {
                              setWhisperRuntimeActionLoading(null)
                              void refreshWhisperRuntimeStatus()
                              void refreshWhisperRuntimeDiagnostics()
                            })
                        }}
                      >
                        {whisperRuntimeActionLoading === variant ? 'Downloading...' : 'Download'}
                      </Button>
                      <Button
                        variant="ghost"
                        size="sm"
                        className="h-8 px-3"
                        disabled={whisperRuntimeActionLoading !== null || !installed}
                        onClick={() => {
                          setWhisperRuntimeActionLoading(variant)

                          void electronAPI
                            .removeWhisperRuntime(variant)
                            .then(() => {
                              pushToast({
                                title: `Whisper ${variant.toUpperCase()} runtime removed`,
                              })
                            })
                            .catch((error: unknown) => {
                              const message =
                                error instanceof Error
                                  ? error.message
                                  : `Unable to remove Whisper ${variant.toUpperCase()} runtime.`

                              pushToast({
                                title: `Unable to remove Whisper ${variant.toUpperCase()} runtime`,
                                description: message,
                                variant: 'destructive',
                              })
                            })
                            .finally(() => {
                              setWhisperRuntimeActionLoading(null)
                              void refreshWhisperRuntimeStatus()
                              void refreshWhisperRuntimeDiagnostics()
                            })
                        }}
                      >
                        Remove
                      </Button>
                    </div>
                  </div>
                )
              })}
            </div>
          </div>

          {models.map((model) => (
            <div
              key={model.id}
              className={cn(
                'rounded-md border border-border-subtle bg-surface-0 p-3',
                settings.transcriptionLocalModelId === model.id ? 'border-primary/40 bg-primary/10' : undefined,
              )}
            >
              <div className="flex flex-col gap-3 lg:flex-row lg:items-start lg:justify-between">
                <div className="min-w-0">
                  <p className="text-sm font-medium">{model.label}</p>
                  <div className="mt-1 flex flex-wrap gap-1.5 text-xs text-muted-foreground">
                    <span className="rounded-full border border-border-subtle px-2 py-0.5">{model.size}</span>
                    <span className="rounded-full border border-border-subtle px-2 py-0.5">{model.speed}</span>
                    <span className="rounded-full border border-border-subtle px-2 py-0.5">{model.quality}</span>
                  </div>
                </div>
                <div className="grid w-full grid-cols-1 gap-2 sm:grid-cols-2 lg:w-auto lg:grid-cols-2">
                  <Button
                    variant="outline"
                    size="sm"
                    className="w-full"
                    onClick={() => {
                      if (model.downloading) {
                        void cancelModelDownloading('transcription', model.id, onModelsChange).then((canceled) => {
                          if (canceled) {
                            pushToast({
                              title: `${model.label} download canceled`,
                            })
                          }
                        })
                        return
                      }

                      if (model.downloaded) {
                        void removeModel('transcription', model.id, onModelsChange).then((removed) => {
                          if (removed) {
                            pushToast({
                              title: `${model.label} removed`,
                            })
                            return
                          }

                          pushToast({
                            title: 'Remove failed',
                            description: `Unable to remove ${model.label} from local storage.`,
                            variant: 'destructive',
                          })
                        })
                        return
                      }

                      void setModelDownloading('transcription', model.id, onModelsChange).then((downloaded) => {
                        if (downloaded) {
                          pushToast({
                            title: `${model.label} downloaded`,
                            variant: 'success',
                          })
                          return
                        }

                        pushToast({
                          title: 'Download failed',
                          description: `Unable to download ${model.label}.`,
                          variant: 'destructive',
                        })
                      })
                    }}
                  >
                    {model.downloading ? 'Cancel' : model.downloaded ? 'Remove' : 'Download'}
                  </Button>

                  <Button
                    size="sm"
                    className="w-full"
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
            Providers stay visible and wrap responsively based on available width.
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-4">
          <div className="rounded-[var(--radius-premium)] border border-border-hover bg-surface-0/90 p-2">
            <div className="grid gap-2 [grid-template-columns:repeat(auto-fit,minmax(150px,1fr))]">
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

                <div className="space-y-2 rounded-md border border-border-subtle bg-surface-1/70 p-3">
                  <div className="flex flex-wrap items-center justify-between gap-2">
                    <p className="text-sm font-medium">Model endpoint scan</p>
                    <Button
                      size="sm"
                      variant="outline"
                      disabled={customPostModelScanLoading}
                      onClick={() => {
                        void handleCustomPostModelScan()
                      }}
                    >
                      <Search className="h-3.5 w-3.5" />
                      {customPostModelScanLoading ? 'Scanning...' : 'Scan models'}
                    </Button>
                  </div>

                  <p className="text-xs text-muted-foreground">
                    {postProcessingModelsEndpoint
                      ? `Models endpoint: ${postProcessingModelsEndpoint}`
                      : 'Enter a valid custom endpoint URL to enable model scanning.'}
                  </p>

                  {customPostModelScanError ? (
                    <p className="rounded-md border border-destructive/40 bg-destructive/10 px-2.5 py-2 text-xs text-destructive">
                      {customPostModelScanError}
                    </p>
                  ) : null}

                  {customPostScannedModels.length > 0 ? (
                    <div className="grid gap-2 [grid-template-columns:repeat(auto-fit,minmax(210px,1fr))]">
                      {customPostScannedModels.map((modelId) => {
                        const active = settings.postProcessingCustomModel === modelId

                        return (
                          <button
                            key={modelId}
                            type="button"
                            className={modelItemClass(active)}
                            onClick={() => {
                              onSettingsChange({
                                postProcessingCustomModel: modelId,
                                postProcessingCloudModelId: modelId,
                              })
                            }}
                          >
                            <span className="min-w-0 break-words">{modelId}</span>
                            {active ? (
                              <Badge tone="primary" className="shrink-0">Selected</Badge>
                            ) : (
                              <span className="shrink-0 text-xs text-muted-foreground">Use model</span>
                            )}
                          </button>
                        )
                      })}
                    </div>
                  ) : null}
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
                  {postProcessingApiKeyDocsUrl ? (
                    <p className="text-xs text-muted-foreground">
                      If you want to create and use an API key here, use{' '}
                      <button
                        type="button"
                        className="app-no-drag inline-flex items-center gap-1 text-primary hover:text-primary/80"
                        onClick={() => {
                          electronAPI.openExternal(postProcessingApiKeyDocsUrl)
                        }}
                      >
                        this link
                        <Link className="h-3 w-3" />
                      </button>
                      .
                    </p>
                  ) : null}

                  {postProviderAutoScanLoading ? (
                    <p className="text-xs text-muted-foreground">Auto-scanning provider endpoint models...</p>
                  ) : null}

                  {postProviderAutoScanError ? (
                    <p className="rounded-md border border-destructive/40 bg-destructive/10 px-2.5 py-2 text-xs text-destructive">
                      {postProviderAutoScanError}
                    </p>
                  ) : null}
                </div>

                <div className="grid gap-2 [grid-template-columns:repeat(auto-fit,minmax(210px,1fr))]">
                  {displayedPostCloudModels.map((model) => {
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
                        <span className="min-w-0 break-words">{model.label}</span>
                        {active ? (
                          <Badge tone="primary" className="shrink-0">Active</Badge>
                        ) : (
                          <span className="shrink-0 text-xs text-muted-foreground">Select</span>
                        )}
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
              <div className="flex flex-col gap-3 lg:flex-row lg:items-start lg:justify-between">
                <div className="min-w-0">
                  <p className="text-sm font-medium">{model.label}</p>
                  <div className="mt-1 flex flex-wrap gap-1.5 text-xs text-muted-foreground">
                    <span className="rounded-full border border-border-subtle px-2 py-0.5">{model.size}</span>
                    <span className="rounded-full border border-border-subtle px-2 py-0.5">{model.speed}</span>
                    <span className="rounded-full border border-border-subtle px-2 py-0.5">{model.quality}</span>
                  </div>
                </div>
                <div className="grid w-full grid-cols-1 gap-2 sm:grid-cols-2 lg:w-auto lg:grid-cols-2">
                  <Button
                    variant="outline"
                    size="sm"
                    className="w-full"
                    onClick={() => {
                      if (model.downloading) {
                        void cancelModelDownloading('post', model.id, onPostModelsChange).then((canceled) => {
                          if (canceled) {
                            pushToast({
                              title: `${model.label} download canceled`,
                            })
                          }
                        })
                        return
                      }

                      if (model.downloaded) {
                        void removeModel('post', model.id, onPostModelsChange).then((removed) => {
                          if (removed) {
                            pushToast({
                              title: `${model.label} removed`,
                            })
                            return
                          }

                          pushToast({
                            title: 'Remove failed',
                            description: `Unable to remove ${model.label} from local storage.`,
                            variant: 'destructive',
                          })
                        })
                        return
                      }

                      void setModelDownloading('post', model.id, onPostModelsChange).then((downloaded) => {
                        if (downloaded) {
                          pushToast({
                            title: `${model.label} downloaded`,
                            variant: 'success',
                          })
                          return
                        }

                        pushToast({
                          title: 'Download failed',
                          description: `Unable to download ${model.label}.`,
                          variant: 'destructive',
                        })
                      })
                    }}
                  >
                    {model.downloading ? 'Cancel' : model.downloaded ? 'Remove' : 'Download'}
                  </Button>

                  <Button
                    size="sm"
                    className="w-full"
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
  const [testLoading, setTestLoading] = useState(false)

  const translationComboHotkey = useMemo(
    () => buildTranslationComboHotkey(settings.hotkey),
    [settings.hotkey],
  )

  const translationHotkey =
    settings.translationHotkeyMode === 'combo' ? translationComboHotkey : settings.translationCustomHotkey

  const runPromptTest = async () => {
    if (typeof window.electronAPI !== 'undefined') {
      setTestLoading(true)

      try {
        const result = await electronAPI.runPromptTest(testInput)
        const routeLabelById: Record<typeof result.route, string> = {
          normal: 'Normal prompt',
          agent: 'Agent prompt',
          translation: 'Translation prompt',
        }

        setTestOutput(`Route: ${routeLabelById[result.route]}\n\nOutput:\n${result.output}`)
      } catch (error: unknown) {
        const message = error instanceof Error ? error.message : 'Unable to run prompt test.'
        setTestOutput(`Prompt test failed\n\n${message}`)
      } finally {
        setTestLoading(false)
      }

      return
    }

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
            <div className="overflow-x-auto">
              <TabsList className="mx-auto h-auto w-max flex-nowrap justify-start gap-1 bg-surface-2/80 p-1">
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
            </div>

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
                <Button
                  onClick={() => {
                    void runPromptTest()
                  }}
                  disabled={testLoading}
                >
                  {testLoading ? 'Running...' : 'Run test'}
                </Button>
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

const InfoSection = ({
  settings,
  onChange,
}: {
  settings: AppSettings
  onChange: (next: Partial<AppSettings>) => void
}) => {
  const { pushToast } = useToast()
  const [showBugLogs, setShowBugLogs] = useState(false)
  const [debugLogStatus, setDebugLogStatus] = useState<DebugLogStatusPayload | null>(null)
  const [debugLogStatusLoading, setDebugLogStatusLoading] = useState(false)
  const [showSecretStorage, setShowSecretStorage] = useState(false)
  const [secretStorageStatus, setSecretStorageStatus] = useState<SecretStorageStatusPayload | null>(null)
  const [secretStorageStatusLoading, setSecretStorageStatusLoading] = useState(false)
  const [secretMigrationLoading, setSecretMigrationLoading] = useState(false)

  const activeTranscriptionProviderLabel =
    CLOUD_TRANSCRIPTION_CATALOG.find((provider) => provider.providerId === settings.transcriptionCloudProvider)
      ?.providerLabel ?? settings.transcriptionCloudProvider

  const transcriptionRuntimeLabel =
    settings.transcriptionRuntime === 'cloud'
      ? `Cloud (${activeTranscriptionProviderLabel})`
      : 'Local'

  const refreshDebugLogStatus = useCallback(
    async (showErrorToast: boolean) => {
      setDebugLogStatusLoading(true)

      try {
        const status = await electronAPI.getDebugLogStatus()
        setDebugLogStatus(status)
      } catch {
        setDebugLogStatus(null)
        if (showErrorToast) {
          pushToast({
            title: 'Debug log status unavailable',
            description: 'Unable to read debug log status in this runtime.',
            variant: 'destructive',
          })
        }
      } finally {
        setDebugLogStatusLoading(false)
      }
    },
    [pushToast],
  )

  useEffect(() => {
    if (!showBugLogs) {
      return
    }

    void refreshDebugLogStatus(false)
  }, [refreshDebugLogStatus, showBugLogs])

  const refreshSecretStorageStatus = useCallback(
    async (showErrorToast: boolean) => {
      setSecretStorageStatusLoading(true)

      try {
        const status = await electronAPI.getSecretStorageStatus()
        setSecretStorageStatus(status)
      } catch {
        setSecretStorageStatus(null)
        if (showErrorToast) {
          pushToast({
            title: 'Secret storage status unavailable',
            description: 'Unable to read keyring/env status in this runtime.',
            variant: 'destructive',
          })
        }
      } finally {
        setSecretStorageStatusLoading(false)
      }
    },
    [pushToast],
  )

  useEffect(() => {
    if (!showSecretStorage) {
      return
    }

    void refreshSecretStorageStatus(false)
  }, [refreshSecretStorageStatus, showSecretStorage])

  const handleSecretMigration = useCallback(async () => {
    setSecretMigrationLoading(true)

    try {
      const migration = await electronAPI.migrateSecretsToKeyring()
      if (!migration.success) {
        pushToast({
          title: 'Keyring migration failed',
          description: migration.details,
          variant: 'destructive',
        })
        return
      }

      onChange({ keytarEnabled: true })
      pushToast({
        title: 'Keyring migration complete',
        description: migration.details,
        variant: 'success',
      })
      void refreshSecretStorageStatus(false)
    } catch {
      pushToast({
        title: 'Keyring migration failed',
        description: 'Unexpected error during migration.',
        variant: 'destructive',
      })
    } finally {
      setSecretMigrationLoading(false)
    }
  }, [onChange, pushToast, refreshSecretStorageStatus])

  return (
    <div className="space-y-4">
      <Card>
        <CardHeader>
          <CardTitle>Debug logs</CardTitle>
          <CardDescription>Quick debug controls and log locations.</CardDescription>
        </CardHeader>
        <CardContent className="space-y-3">
          <div className="flex items-center justify-between rounded-md border border-border-subtle bg-surface-0 px-3 py-2.5">
            <p className="text-sm">Debug mode</p>
            <Switch
              checked={settings.debugModeEnabled}
              onCheckedChange={(checked) => {
                onChange({ debugModeEnabled: checked })
                window.setTimeout(() => {
                  void refreshDebugLogStatus(false)
                }, 50)
              }}
            />
          </div>
          <Button
            variant="outline"
            onClick={() => {
              setShowBugLogs((current) => !current)
            }}
          >
            {showBugLogs ? 'Hide log paths' : 'Show log paths'}
          </Button>
          {showBugLogs ? (
            <div className="rounded-md border border-border-subtle bg-surface-0 p-3 text-sm text-muted-foreground">
              <p>Renderer logs: ~/.config/whispy/logs/renderer.log</p>
              <p>Main logs: ~/.config/whispy/logs/main.log</p>
              <p>Crash dumps: ~/.config/whispy/logs/crash/</p>
              {settings.debugModeEnabled ? (
                <>
                  <p className="mt-2">Current debug log file:</p>
                  <p className="text-xs">{debugLogStatus?.currentLogFile ?? 'Loading...'}</p>
                </>
              ) : null}
            </div>
          ) : null}

          {showBugLogs && settings.debugModeEnabled ? (
            <div className="flex flex-wrap items-center gap-2">
              <Button
                variant="outline"
                size="sm"
                disabled={debugLogStatusLoading}
                onClick={() => {
                  void refreshDebugLogStatus(true)
                }}
              >
                {debugLogStatusLoading ? 'Refreshing...' : 'Refresh debug log status'}
              </Button>
              <Button
                variant="outline"
                size="sm"
                onClick={() => {
                  void electronAPI.openDebugLogFile()
                }}
              >
                Open debug logs file
              </Button>
            </div>
          ) : null}

          {showBugLogs ? (
            <button
              type="button"
              className="app-no-drag inline-flex items-center gap-1 text-xs text-muted-foreground hover:text-foreground"
              onClick={() => {
                setShowSecretStorage((current) => !current)
              }}
            >
              <KeyRound className="h-3.5 w-3.5" />
              {showSecretStorage ? 'Hide secret storage' : 'Advanced secret storage'}
            </button>
          ) : null}

          {showSecretStorage ? (
            <div className="space-y-3 rounded-md border border-border-subtle bg-surface-0 p-3">
              <div className="flex flex-wrap items-center justify-between gap-2">
                <p className="text-sm font-medium">Secret storage</p>
                <Badge tone={settings.keytarEnabled ? 'primary' : 'neutral'}>
                  {settings.keytarEnabled ? 'Keyring enabled' : 'Plaintext .env (default)'}
                </Badge>
              </div>

              <p className="text-xs text-muted-foreground">
                Default mode keeps API keys in plaintext `.env` storage. You can migrate to the system keyring at any
                time.
              </p>

              <p className="text-xs text-muted-foreground">
                Env path: {secretStorageStatus?.envFilePath ?? 'Loading...'}
              </p>

              <p className="text-xs text-muted-foreground">
                {secretStorageStatus?.details ?? 'Status unavailable until checked.'}
              </p>

              <div className="flex flex-wrap items-center gap-2">
                <Button
                  variant="outline"
                  size="sm"
                  disabled={secretStorageStatusLoading}
                  onClick={() => {
                    void refreshSecretStorageStatus(true)
                  }}
                >
                  {secretStorageStatusLoading ? 'Checking...' : 'Refresh status'}
                </Button>

                {!settings.keytarEnabled ? (
                  <Button size="sm" disabled={secretMigrationLoading} onClick={() => void handleSecretMigration()}>
                    {secretMigrationLoading ? 'Migrating...' : 'Enable keyring + migrate from .env'}
                  </Button>
                ) : (
                  <Button
                    variant="outline"
                    size="sm"
                    onClick={() => {
                      onChange({ keytarEnabled: false })
                      pushToast({
                        title: 'Plaintext mode enabled',
                        description: 'API keys will be written to plaintext .env storage.',
                      })
                      void refreshSecretStorageStatus(false)
                    }}
                  >
                    Use plaintext .env mode
                  </Button>
                )}
              </div>
            </div>
          ) : null}
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>Runtime status</CardTitle>
        </CardHeader>
        <CardContent className="space-y-1 text-sm text-muted-foreground">
          <p>Transcription runtime: {transcriptionRuntimeLabel}</p>
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
          <CardDescription>App version: 0.1.0</CardDescription>
        </CardHeader>
        <CardContent className="space-y-3">
          <div className="rounded-md border border-border-subtle bg-surface-0 p-3 text-sm text-muted-foreground">
            Changelog:
            <ul className="mt-2 list-disc space-y-1 pl-5">
              <li>Floating overlay with IDLE/RECORDING/PROCESSING states</li>
              <li>Complete control panel with onboarding</li>
              <li>Models section with backend-managed download flow</li>
            </ul>
          </div>
        </CardContent>
        <CardFooter>
          <Button
            variant="outline"
            onClick={() => {
              void electronAPI.openAppDataDirectory()
            }}
          >
            <Link className="h-3.5 w-3.5" /> Open app data folder
          </Button>
        </CardFooter>
      </Card>
    </div>
  )
}

type SettingsNodeId =
  | 'account'
  | 'preferences'
  | 'transcription'
  | 'dictionary'
  | 'ai-models'
  | 'translation'
  | 'prompts'
  | 'agent.name'
  | 'privacy'
  | 'developer'
  | 'shortcuts'

interface SettingsMenuGroup {
  label: string
  items: Array<{ id: SettingsNodeId; label: string; icon: typeof Settings }>
}

const SHOW_ACCOUNT_SECTION = false

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
      { id: 'transcription', label: 'AI Models', icon: BrainCircuit },
      { id: 'dictionary', label: 'Dictionary', icon: BookOpen },
    ],
  },
  {
    label: 'Post-Processing',
    items: [
      { id: 'ai-models', label: 'AI Models', icon: BrainCircuit },
      { id: 'translation', label: 'Translation', icon: Languages },
      { id: 'agent.name', label: 'Agent', icon: Bot },
      { id: 'prompts', label: 'Prompts', icon: Sparkles },
    ],
  },
  {
    label: 'System',
    items: [
      { id: 'privacy', label: 'Privacy', icon: Lock },
      { id: 'developer', label: 'Developer', icon: Wrench },
      { id: 'shortcuts', label: 'Shortcuts', icon: Settings },
    ],
  },
]

interface SettingsWorkspaceProps {
  settings: AppSettings
  models: ModelState[]
  postModels: ModelState[]
  displayServer: DisplayServer
  autoPasteSupport: AutoPasteBackendSupportPayload | null
  autoPasteSupportLoading: boolean
  onRefreshAutoPasteSupport: () => void
  onSettingsChange: (next: Partial<AppSettings>) => void
  onModelsChange: Dispatch<SetStateAction<ModelState[]>>
  onPostModelsChange: Dispatch<SetStateAction<ModelState[]>>
}

const SettingsWorkspace = ({
  settings,
  models,
  postModels,
  displayServer,
  autoPasteSupport,
  autoPasteSupportLoading,
  onRefreshAutoPasteSupport,
  onSettingsChange,
  onModelsChange,
  onPostModelsChange,
}: SettingsWorkspaceProps) => {
  const [activeNode, setActiveNode] = useState<SettingsNodeId>(
    SHOW_ACCOUNT_SECTION ? 'account' : 'preferences',
  )
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
      return <AccountSettingsPanel />
    }

    if (activeNode === 'preferences') {
      return (
        <PreferencesSettingsPanel
          settings={settings}
          autoDetectSupported={autoDetectSupported}
          displayServer={displayServer}
          autoPasteSupport={autoPasteSupport}
          autoPasteSupportLoading={autoPasteSupportLoading}
          onRefreshAutoPasteSupport={onRefreshAutoPasteSupport}
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
            <div className="flex justify-center">
              <TabsList className="bg-surface-2/80">
                <TabsTrigger value="cloud">Cloud</TabsTrigger>
                <TabsTrigger value="local">Local</TabsTrigger>
              </TabsList>
            </div>
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
      return <DictionarySettingsSection settings={settings} onChange={onSettingsChange} />
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
            <div className="flex justify-center">
              <TabsList className="bg-surface-2/80">
                <TabsTrigger value="cloud">Cloud</TabsTrigger>
                <TabsTrigger value="local">Local</TabsTrigger>
              </TabsList>
            </div>
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

    if (activeNode === 'translation') {
      return <TranslationModeSection settings={settings} onChange={onSettingsChange} />
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

    if (activeNode === 'shortcuts') {
      return <ShortcutsSection hotkey={settings.hotkey} />
    }

    return <InfoSection settings={settings} onChange={onSettingsChange} />
  }

  const menuItemClass = (nodeId: SettingsNodeId) =>
    cn(
      'relative app-no-drag flex h-10 w-full items-center gap-3 rounded-[10px] px-2.5 text-left text-sm whitespace-nowrap transition-colors',
      activeNode === nodeId
        ? 'bg-surface-0 text-foreground shadow-[0_0_0_1px_var(--border-active)]'
        : 'text-foreground/80 hover:bg-surface-1 hover:text-foreground',
    )

  return (
    <div className="grid h-full min-h-0 grid-cols-[260px_minmax(0,1fr)] gap-4 rounded-[var(--radius-premium)] border border-border-subtle bg-surface-1/70 p-4">
      <aside className="min-h-0 overflow-y-auto rounded-[var(--radius-premium)] border border-border-subtle bg-surface-2/70 p-3">
        <p className="px-2 text-[11px] font-semibold uppercase tracking-[0.14em] text-muted-foreground">Settings</p>
        <nav className="mt-4 space-y-4">
          {SETTINGS_MENU_GROUPS.map((group) => {
            const visibleItems = group.items.filter((item) => SHOW_ACCOUNT_SECTION || item.id !== 'account')

            if (visibleItems.length === 0) {
              return null
            }

            return (
              <div key={group.label}>
                <p className="px-2 text-[11px] font-semibold uppercase tracking-[0.12em] text-muted-foreground">{group.label}</p>
                <div className="mt-1.5 space-y-1">
                  {visibleItems.map((item) => {
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
            )
          })}
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
    let active = true

    void Promise.all([
      electronAPI.getMicrophonePermissionStatus(),
      isMacOS ? electronAPI.getAccessibilityPermissionStatus() : Promise.resolve(true),
    ])
      .then(([microphoneGranted, accessibilityGranted]) => {
        if (active) {
          setMicPermission(microphoneGranted)
          setPastePermission(accessibilityGranted)
        }
      })
      .catch(() => {
        if (active) {
          setMicPermission(true)
          setPastePermission(true)
        }
      })

    return () => {
      active = false
    }
  }, [])

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
              <p className="text-sm text-muted-foreground">Confirm required permissions.</p>
              <div className="space-y-2">
                <div className="flex items-center justify-between rounded-md border border-border-subtle bg-surface-0 px-3 py-2">
                  <p className="text-sm">Microphone access</p>
                  <Switch
                    checked={micPermission}
                    onCheckedChange={(checked) => {
                      if (!checked) {
                        setMicPermission(false)
                        return
                      }

                      if (typeof window.electronAPI === 'undefined') {
                        setMicPermission(true)
                        return
                      }

                      void electronAPI
                        .requestMicrophonePermission()
                        .then((granted) => {
                          setMicPermission(granted)
                        })
                        .catch(() => {
                          setMicPermission(false)
                        })
                    }}
                  />
                </div>
                {isMacOS ? (
                  <div className="flex items-center justify-between rounded-md border border-border-subtle bg-surface-0 px-3 py-2">
                    <p className="text-sm">Accessibility enabled for auto-paste</p>
                    <Switch
                      checked={pastePermission}
                      onCheckedChange={(checked) => {
                        if (!checked) {
                          setPastePermission(false)
                          return
                        }

                        if (typeof window.electronAPI === 'undefined') {
                          setPastePermission(true)
                          return
                        }

                        void electronAPI
                          .requestAccessibilityPermission()
                          .then((granted) => {
                            setPastePermission(granted)
                          })
                          .catch(() => {
                            setPastePermission(false)
                          })
                      }}
                    />
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
  const [historyClearConfirmOpen, setHistoryClearConfirmOpen] = useState(false)
  const [onboardingDone, setOnboardingDone] = useState(isOnboardingCompleted)
  const [displayServer, setDisplayServer] = useState<DisplayServer>('unknown')
  const [autoPasteSupport, setAutoPasteSupport] = useState<AutoPasteBackendSupportPayload | null>(null)
  const [autoPasteSupportLoading, setAutoPasteSupportLoading] = useState(true)
  const [windowMaximized, setWindowMaximized] = useState(false)

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
    let alive = true

    void electronAPI
      .getDisplayServer()
      .then((server) => {
        if (alive) {
          setDisplayServer(server)
        }
      })
      .catch(() => {
        if (alive) {
          setDisplayServer('unknown')
        }
      })

    return () => {
      alive = false
    }
  }, [])

  const handleModelDownloadProgress = useCallback((payload: ModelDownloadProgressPayload) => {
    const setScopedModels = payload.scope === 'transcription' ? setModels : setPostModels

    setScopedModels((current) =>
      current.map((model) => {
        if (model.id !== payload.modelId) {
          return model
        }

        if (payload.state === 'completed') {
          return {
            ...model,
            downloading: false,
            downloaded: true,
            progress: 100,
          }
        }

        if (payload.state === 'failed' || payload.state === 'canceled') {
          return {
            ...model,
            downloading: false,
            downloaded: false,
            progress: 0,
          }
        }

        return {
          ...model,
          downloading: true,
          progress: payload.progress,
        }
      }),
    )
  }, [])

  useEffect(() => {
    const offModelDownloadProgress = electronAPI.onModelDownloadProgress(handleModelDownloadProgress)

    return () => {
      offModelDownloadProgress()
    }
  }, [handleModelDownloadProgress])

  const requestAutoPasteSupportViaWindowAction = useCallback(async () => {
    return new Promise<AutoPasteBackendSupportPayload>((resolve, reject) => {
      const timeout = window.setTimeout(() => {
        window.removeEventListener('whispy-autopaste-support', onSupportEvent as EventListener)
        reject(new Error('autopaste_support_timeout'))
      }, 2200)

      const onSupportEvent = (event: Event) => {
        const customEvent = event as CustomEvent<unknown>
        if (!isAutoPasteSupportPayload(customEvent.detail)) {
          return
        }

        window.clearTimeout(timeout)
        window.removeEventListener('whispy-autopaste-support', onSupportEvent as EventListener)
        resolve(customEvent.detail)
      }

      window.addEventListener('whispy-autopaste-support', onSupportEvent as EventListener)

      const dispatchDetectionRequest = async () => {
        try {
          await electronAPI.openExternal('whispy-action://autopaste/detect')
          return
        } catch {
          try {
            window.open('whispy-action://autopaste/detect', '_blank', 'noopener,noreferrer')
            return
          } catch {
            window.clearTimeout(timeout)
            window.removeEventListener('whispy-autopaste-support', onSupportEvent as EventListener)
            reject(new Error('autopaste_support_dispatch_failed'))
          }
        }
      }

      void dispatchDetectionRequest()
    })
  }, [])

  const refreshAutoPasteSupport = useCallback(
    async (showErrorToast: boolean) => {
      setAutoPasteSupportLoading(true)

      try {
        const supportPayload = await electronAPI.getAutoPasteBackendSupport()
        setAutoPasteSupport(supportPayload)
      } catch {
        try {
          const supportPayload = await requestAutoPasteSupportViaWindowAction()
          setAutoPasteSupport(supportPayload)
        } catch {
          setAutoPasteSupport(null)

          if (showErrorToast) {
            pushToast({
              title: 'Auto-paste check failed',
              description: 'Unable to detect backend availability in this runtime.',
              variant: 'destructive',
            })
          }
        }
      } finally {
        setAutoPasteSupportLoading(false)
      }
    },
    [pushToast, requestAutoPasteSupportViaWindowAction],
  )

  useEffect(() => {
    void refreshAutoPasteSupport(false)
  }, [refreshAutoPasteSupport])

  useEffect(() => {
    let alive = true

    void electronAPI
      .getWindowMaximized()
      .then((maximized) => {
        if (alive) {
          setWindowMaximized(maximized)
        }
      })
      .catch(() => {
        if (alive) {
          setWindowMaximized(false)
        }
      })

    const offWindowMaximizeChanged = electronAPI.onWindowMaximizeChanged((maximized) => {
      setWindowMaximized(maximized)
    })

    return () => {
      alive = false
      offWindowMaximizeChanged()
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
        void refreshSettingsFromBackend().then((nextSettings) => {
          setSettings(nextSettings)
        })
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
          clearConfirmOpen={historyClearConfirmOpen}
          onClearConfirmOpenChange={setHistoryClearConfirmOpen}
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
            setHistoryClearConfirmOpen(false)
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
          displayServer={displayServer}
          autoPasteSupport={autoPasteSupport}
          autoPasteSupportLoading={autoPasteSupportLoading}
          onRefreshAutoPasteSupport={() => {
            void refreshAutoPasteSupport(true)
          }}
          onSettingsChange={handleSettingsChange}
          onModelsChange={setModels}
          onPostModelsChange={setPostModels}
        />
      )
    }

    return null
  }

  const handleWindowControl = async (controlId: 'close' | 'minimize' | 'zoom') => {
    const tryInvoke = async (callback: () => Promise<void>) => {
      try {
        await callback()
        return true
      } catch {
        return false
      }
    }

    const requestInternalAction = async (actionURL: string) => {
      const dispatchedViaBridge = await tryInvoke(() => electronAPI.openExternal(actionURL))
      if (dispatchedViaBridge) {
        return true
      }

      try {
        window.open(actionURL, '_blank', 'noopener,noreferrer')
        return true
      } catch {
        return false
      }
    }

    try {
      if (controlId === 'close') {
        const requestedQuit = await requestInternalAction('whispy-action://app/quit')
        if (!requestedQuit) {
          const closed = await tryInvoke(() => electronAPI.closeWindow())
          if (!closed) {
            await tryInvoke(() => electronAPI.hideWindow())
            window.close()
          }
        }
        return
      }

      if (controlId === 'minimize') {
        const requestedMinimize = await requestInternalAction('whispy-action://window/minimize')
        if (!requestedMinimize) {
          const minimized = await tryInvoke(() => electronAPI.minimizeWindow())
          if (!minimized) {
            throw new Error('minimize_unavailable')
          }
        }
        return
      }

      const requestedToggle = await requestInternalAction('whispy-action://window/toggle-maximize')
      if (!requestedToggle) {
        const toggled = await tryInvoke(() => electronAPI.toggleMaximizeWindow())
        if (!toggled) {
          throw new Error('maximize_unavailable')
        }
      }
    } catch {
      pushToast({
        title: 'Window control unavailable',
        description: 'Native window actions are not available in this runtime.',
        variant: 'destructive',
      })
    }
  }

  const conversationsCountLabel = historyLoading
    ? '...'
    : historyEntries.length > 999
      ? '999+'
      : String(historyEntries.length)

  return (
    <div
      className={cn(
        'flex h-screen flex-col overflow-hidden bg-[radial-gradient(circle_at_top_right,rgba(99,102,241,0.16),transparent_42%),radial-gradient(circle_at_bottom_left,rgba(37,99,235,0.14),transparent_38%)] text-foreground transition-[border-radius] duration-150',
        useCustomWindowChrome ? 'border border-border-subtle' : 'border-0',
        useCustomWindowChrome && !windowMaximized ? 'rounded-[12px]' : 'rounded-none',
      )}
    >
      <header className={cn('relative flex h-12 shrink-0 items-center border-b border-border-subtle bg-surface-1/90 px-4', useCustomWindowChrome ? 'app-drag' : '')}>
        {useCustomWindowChrome ? (
        <div className="app-no-drag group z-10 flex items-center gap-1.5 pl-1">
            {([
              { id: 'close', color: '#ff5f57', icon: X },
              { id: 'minimize', color: '#febc2e', icon: Minus },
              { id: 'zoom', color: '#28c840', icon: Plus },
            ] as const).map((control) => {
              const Icon = control.icon
              return (
                <button
                  key={control.id}
                  type="button"
                  aria-label={control.id}
                  className="app-no-drag inline-flex h-5 w-5 cursor-pointer items-center justify-center rounded-full transition-transform duration-150 hover:scale-105"
                  onPointerDown={(event) => {
                    if (event.button !== 0) {
                      return
                    }

                    event.preventDefault()
                    event.stopPropagation()
                    void handleWindowControl(control.id)
                  }}
                  onClick={(event) => {
                    event.preventDefault()
                    event.stopPropagation()
                  }}
                >
                  <span
                    className="relative inline-flex h-3 w-3 items-center justify-center rounded-full border border-black/15"
                    style={{ backgroundColor: control.color }}
                  >
                    <Icon className="pointer-events-none absolute inset-0 m-auto h-2.5 w-2.5 text-black/85 opacity-20 drop-shadow-[0_0.5px_0_rgba(255,255,255,0.35)] transition-opacity duration-150 group-hover:opacity-100" />
                  </span>
                </button>
                )
              })}
        </div>
        ) : (
          <div className="z-10 w-8" />
        )}

        <div className="pointer-events-none absolute inset-0 flex items-center justify-center">
          <div className={cn('inline-flex items-center gap-2 text-sm font-semibold text-muted-foreground', useCustomWindowChrome ? 'app-drag' : '')}>
            <Sparkles className="h-4 w-4 text-primary" />
            <span>Whispy</span>
          </div>
        </div>

        <div className="app-no-drag z-10 ml-auto flex items-center gap-2">
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
      </header>

      <main
        className={cn(
          'min-h-0 flex-1 p-6',
          onboardingDone && section === 'settings' ? 'overflow-hidden' : 'overflow-y-auto',
        )}
      >
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
          <div
            className={cn(
              'mx-auto max-w-5xl',
              section === 'settings' ? 'flex h-full min-h-0 flex-col gap-4' : 'space-y-4',
            )}
          >
            <div className="flex items-center gap-2">
              <div className="flex items-center gap-2">
                <h1 className="text-lg font-semibold">{section === 'conversations' ? t('menuConversations') : t('menuSettings')}</h1>
                {section === 'conversations' ? (
                  <span className="inline-flex min-w-6 items-center justify-center rounded-full border border-primary/30 bg-primary/15 px-1.5 text-[11px] font-semibold text-primary">
                    {conversationsCountLabel}
                  </span>
                ) : null}
                {section === 'conversations' ? (
                  <Button
                    variant="ghost"
                    size="sm"
                    onClick={() => {
                      setHistoryClearConfirmOpen(true)
                    }}
                    disabled={historyEntries.length === 0}
                  >
                    <Trash2 className="h-3.5 w-3.5" />
                    Clear history
                  </Button>
                ) : null}
              </div>
            </div>
            {section === 'settings' ? <div className="min-h-0 flex-1">{renderSection()}</div> : renderSection()}
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
