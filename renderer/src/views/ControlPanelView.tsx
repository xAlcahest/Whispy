import {
  Bold,
  Bot,
  BrainCircuit,
  BookOpen,
  CheckSquare,
  ChevronDown,
  Cloud,
  Code2,
  Copy,
  Download,
  Eye,
  FileText,
  FolderOpen,
  Heading1,
  Home,
  ImagePlus,
  Italic,
  KeyRound,
  Link,
  Link2,
  List,
  ListOrdered,
  Lock,
  Languages,
  Mic,
  Minus,
  Moon,
  Pencil,
  Plus,
  Quote,
  RotateCcw,
  Power,
  Save,
  Search,
  Settings,
  SlidersHorizontal,
  Sparkles,
  Sun,
  Trash2,
  UserRound,
  Video,
  Wallet,
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
import { Button } from '../components/ui/button'
import { Badge } from '../components/ui/badge'
import { Card, CardContent, CardDescription, CardFooter, CardHeader, CardTitle } from '../components/ui/card'
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '../components/ui/dialog'
import { Dropdown } from '../components/ui/dropdown'
import { Input } from '../components/ui/input'
import { ApiKeyInput } from '../components/ui/api-key-input'
import { Switch } from '../components/ui/switch'
import { Tabs, TabsContent, TabsList, TabsTrigger } from '../components/ui/tabs'
import { Textarea } from '../components/ui/textarea'
import { ToastProvider, useToast } from '../components/ui/toast'
import { useI18n } from '../i18n'
import { parseAppNotification } from '../lib/app-notifications'
import { cn } from '../lib/cn'
import { electronAPI } from '../lib/electron-api'
import { fakeTranscriptionService } from '../services/fakeTranscriptionService'
import MarkdownPreview from '@uiw/react-markdown-preview'
import '@uiw/react-markdown-preview/markdown.css'
import rehypeRaw from 'rehype-raw'
import remarkGfm from 'remark-gfm'
import { marked } from 'marked'
import {
  AUTO_DETECT_LANGUAGE,
  AUTO_DETECT_SUPPORTED_TRANSCRIPTION_MODELS,
  CLOUD_POST_PROCESSING_CATALOG,
  CLOUD_TRANSCRIPTION_CATALOG,
  isPostProcessingLlmModelId,
  isTranscriptionCapableModelId,
  LANGUAGES,
  LANGUAGE_FLAG_BY_NAME,
  PROVIDERS,
  STORAGE_KEYS,
  TRANSCRIPTION_LANGUAGE_OPTIONS,
  UI_LANGUAGES,
} from '../lib/constants'
import {
  applyHistoryRetentionLimit,
  clearHistory,
  isOnboardingCompleted,
  loadHistory,
  loadModelState,
  loadNoteFolders,
  loadNoteProcessingEvents,
  loadNoteActions,
  loadNotes,
  loadPostModelState,
  loadSettings,
  refreshSettingsFromBackend,
  saveHistory,
  saveModelState,
  saveNoteActions,
  saveNoteFolders,
  saveNoteProcessingEvents,
  saveNotes,
  savePostModelState,
  saveSettings,
  setOnboardingCompleted,
  type NoteProcessingEvent,
  type NoteAction,
  type NoteEntry,
  type NoteFolder,
} from '../lib/storage'
import {
  ESTIMATED_READING_WPM,
  ESTIMATED_SPEAKING_WPM,
  estimateDurationFromWords,
  estimateTokensFromText,
  estimateWordsFromText,
  resolvePostProcessingMetadata,
} from '../../../shared/app'
import type { AppSettings, HistoryEntry, ModelState } from '../types/app'
import type {
  AppUsageStatsPayload,
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

type PanelSection = 'conversations' | 'notes' | 'settings'

type DetailedStatsCategory = 'dictations' | 'notes' | 'combined'
type DetailedStatsCallSource = 'dictation' | 'note'

interface DetailedStatsCallRow {
  id: string
  timestamp: number
  source: DetailedStatsCallSource
  title: string
  provider: string
  model: string
  durationSeconds: number
  words: number
  tokens: number
  transcriptionCostUSD: number
  postProcessingCostUSD: number
  totalCostUSD: number
  postProcessingApplied: boolean
  postProcessingProvider: string
  postProcessingModel: string
  actionName?: string
  estimated: boolean
}

const HISTORY_RETENTION_OPTIONS = [
  { value: 50, label: '50 entries' },
  { value: 100, label: '100 entries' },
  { value: 250, label: '250 entries (lazy load)' },
  { value: 500, label: '500 entries (lazy load)' },
  { value: -1, label: 'Unlimited (lazy load)' },
]

const HISTORY_LAZY_LOAD_LIMITS = new Set([250, 500, -1])
const HISTORY_LAZY_BATCH_SIZE = 100
const INFO_SECTION_REQUEST_TIMEOUT_MS = 6_000

async function runWithTimeout<T>(promise: Promise<T>, timeoutMs: number, timeoutLabel: string): Promise<T> {
  let timeoutHandle: number | null = null

  const timeoutPromise = new Promise<never>((_, reject) => {
    timeoutHandle = window.setTimeout(() => {
      reject(new Error(timeoutLabel))
    }, timeoutMs)
  })

  try {
    return await Promise.race([promise, timeoutPromise])
  } finally {
    if (timeoutHandle !== null) {
      window.clearTimeout(timeoutHandle)
    }
  }
}

const formatTimestamp = (value: number) =>
  new Intl.DateTimeFormat('en-US', {
    dateStyle: 'medium',
    timeStyle: 'short',
  }).format(value)

const formatCurrency = (value: number | null) => {
  if (value === null) {
    return 'n/a'
  }

  return new Intl.NumberFormat('en-US', {
    style: 'currency',
    currency: 'USD',
    minimumFractionDigits: 4,
    maximumFractionDigits: 4,
  }).format(value)
}

const formatDurationCompact = (totalSeconds: number) => {
  if (!Number.isFinite(totalSeconds) || totalSeconds <= 0) {
    return '0s'
  }

  const roundedSeconds = Math.max(1, Math.round(totalSeconds))
  const hours = Math.floor(roundedSeconds / 3600)
  const minutes = Math.floor((roundedSeconds % 3600) / 60)
  const seconds = roundedSeconds % 60

  if (hours > 0) {
    return `${hours}h ${minutes}m`
  }

  if (minutes > 0) {
    return `${minutes}m ${seconds}s`
  }

  return `${seconds}s`
}

const formatCount = (value: number) => new Intl.NumberFormat('en-US').format(value)

const toMonthKey = (timestamp: number) => {
  const date = new Date(timestamp)
  const year = date.getFullYear()
  const month = String(date.getMonth() + 1).padStart(2, '0')
  return `${year}-${month}`
}

const formatMonthLabel = (monthKey: string) => {
  const [yearRaw, monthRaw] = monthKey.split('-')
  const year = Number(yearRaw)
  const month = Number(monthRaw)
  if (!Number.isFinite(year) || !Number.isFinite(month) || month < 1 || month > 12) {
    return monthKey
  }

  return new Intl.DateTimeFormat('en-US', {
    month: 'long',
    year: 'numeric',
  }).format(new Date(year, month - 1, 1))
}

const resolveTokenRateFromMap = (
  modelId: string,
  rateByModelId: Record<string, number | null>,
): number | null => {
  const directRate = rateByModelId[modelId]
  if (typeof directRate === 'number' && Number.isFinite(directRate)) {
    return directRate
  }

  const normalizedModelId = modelId.trim().toLowerCase()
  for (const [candidateModelId, rate] of Object.entries(rateByModelId)) {
    if (typeof rate !== 'number' || !Number.isFinite(rate)) {
      continue
    }

    const normalizedCandidate = candidateModelId.toLowerCase()
    if (normalizedCandidate === normalizedModelId) {
      return rate
    }

    if (normalizedCandidate.includes(normalizedModelId) || normalizedModelId.includes(normalizedCandidate)) {
      return rate
    }
  }

  return null
}

const resolveModelTokenRates = (modelId: string, usageStats: AppUsageStatsPayload | null) => {
  if (!usageStats) {
    return {
      input: null,
      output: null,
    }
  }

  const input = resolveTokenRateFromMap(modelId, usageStats.modelInputCostPerTokenById ?? {})
  const output = resolveTokenRateFromMap(modelId, usageStats.modelOutputCostPerTokenById ?? {})

  return {
    input,
    output,
  }
}

const resolveModelTokenRatesWithFallback = (
  scopedModelId: string,
  bareModelId: string,
  usageStats: AppUsageStatsPayload | null,
) => {
  const scopedRates = resolveModelTokenRates(scopedModelId, usageStats)
  if (scopedRates.input !== null || scopedRates.output !== null) {
    return scopedRates
  }

  return resolveModelTokenRates(bareModelId, usageStats)
}

const resolveTranscriptionTokenRateUSD = (modelId: string, usageStats: AppUsageStatsPayload | null) => {
  if (!usageStats) {
    return null
  }

  const directRate = resolveTokenRateFromMap(modelId, usageStats.modelInputCostPerTokenById ?? {})
  if (directRate !== null) {
    return directRate
  }

  if (usageStats.estimatedTranscriptionTokens > 0 && usageStats.estimatedTranscriptionCostUSD > 0) {
    return usageStats.estimatedTranscriptionCostUSD / usageStats.estimatedTranscriptionTokens
  }

  return null
}

const isMacOS = navigator.userAgent.includes('Mac')
const isLinux = navigator.userAgent.includes('Linux')
const useCustomWindowChrome = isMacOS || isLinux

const normalizeKey = (key: string) => {
  if (key === ' ') {
    return 'Space'
  }

  if (key.startsWith('Arrow')) {
    return key.replace('Arrow', '')
  }

  if (key === 'Pause' || key === 'Pause/Break') {
    return 'Pause'
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
  { id: 'xdotool', label: 'xdotool' },
  { id: 'ydotool', label: 'ydotool' },
]

const OPENAI_COMPATIBLE_BASE_URL_BY_PROVIDER: Record<string, string> = {
  openai: 'https://api.openai.com/v1',
  groq: 'https://api.groq.com/openai/v1',
  grok: 'https://api.x.ai/v1',
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
      (parsed.id === 'wtype' || parsed.id === 'xdotool' || parsed.id === 'ydotool') &&
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
  totalEntries: number
  loading: boolean
  usageStats: AppUsageStatsPayload | null
  clearConfirmOpen: boolean
  onClearConfirmOpenChange: (open: boolean) => void
  onCopy: (text: string) => void
  onDelete: (id: string) => void
  onClear: () => void
  onShowMore: () => void
  canShowMore: boolean
}

const HistorySection = ({
  entries,
  totalEntries,
  loading,
  usageStats,
  clearConfirmOpen,
  onClearConfirmOpenChange,
  onCopy,
  onDelete,
  onClear,
  onShowMore,
  canShowMore,
}: HistorySectionProps) => {
  const { pushToast } = useToast()
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
            <p className="font-medium">No dictations found</p>
            <p className="max-w-md text-sm text-muted-foreground">
              Start dictation from the floating panel. Dictations appear here with metadata and
              quick actions.
            </p>
          </CardContent>
        </Card>
      ) : (
        entries.map((entry) => {
          const expanded = Boolean(expandedEntries[entry.id])
          const rawDictationText = entry.rawText?.trim() || entry.text
          const enhancedDictationText = entry.enhancedText?.trim() || entry.text
          const postProcessingApplied = Boolean(entry.postProcessingApplied)
          const hasEnhancedDictation = postProcessingApplied && rawDictationText.length > 0 && enhancedDictationText.length > 0
          const rawWordCount = estimateWordsFromText(rawDictationText)
          const enhancedWordCount = estimateWordsFromText(enhancedDictationText)
          const rawTokenEstimate = estimateTokensFromText(rawDictationText)
          const enhancedTokenEstimate = estimateTokensFromText(enhancedDictationText)
          const recordedDurationSeconds =
            typeof entry.durationSeconds === 'number' && Number.isFinite(entry.durationSeconds) && entry.durationSeconds > 0
              ? entry.durationSeconds
              : null
          const recordedTimeLabel = recordedDurationSeconds !== null ? `${formatDurationCompact(recordedDurationSeconds)} time` : 'N/A time'
          const transcriptionScopedModelId = `${entry.provider}/${entry.model}`
          const tokenRateUSD =
            resolveTranscriptionTokenRateUSD(transcriptionScopedModelId, usageStats) ??
            resolveTranscriptionTokenRateUSD(entry.model, usageStats)
          const transcriptionCostEstimateUSD =
            tokenRateUSD !== null ? Number((Math.max(1, rawTokenEstimate) * tokenRateUSD).toFixed(6)) : null
          const postProcessingProviderId = entry.postProcessingProvider?.trim() || 'unknown-post-provider'
          const postProcessingModelId = entry.postProcessingModel?.trim() || ''
          const postProcessingScopedModelId = `${postProcessingProviderId}/${postProcessingModelId || 'unknown-model'}`
          const postProcessingRates = resolveModelTokenRatesWithFallback(postProcessingScopedModelId, postProcessingModelId, usageStats)
          const postProcessingCostEstimateUSD =
            hasEnhancedDictation && (postProcessingRates.input !== null || postProcessingRates.output !== null)
              ? Number(
                  (
                    rawTokenEstimate * (postProcessingRates.input ?? 0) +
                    enhancedTokenEstimate * (postProcessingRates.output ?? 0)
                  ).toFixed(6),
                )
              : null
          const lengthSummary = hasEnhancedDictation
            ? `${formatCount(rawWordCount)}/${formatCount(enhancedWordCount)} words · ~${formatCount(rawTokenEstimate)}/~${formatCount(enhancedTokenEstimate)} tokens`
            : `${formatCount(rawWordCount)} words · ~${formatCount(rawTokenEstimate)} tokens`
          const costSummary = hasEnhancedDictation
            ? `STT ~${formatCurrency(transcriptionCostEstimateUSD)} · ENH ~${formatCurrency(postProcessingCostEstimateUSD)}`
            : `~${formatCurrency(transcriptionCostEstimateUSD)}`
          const postProcessingLabel = hasEnhancedDictation
            ? ` | post: ${postProcessingProviderId}/${postProcessingModelId || 'unknown-model'}`
            : ''

          return (
            <Card key={entry.id}>
              <CardHeader className="px-4 py-3 pb-2">
                <div className="flex flex-wrap items-center justify-between gap-2">
                  <div className="space-y-0.5">
                    <CardTitle className="text-xs">{formatTimestamp(entry.timestamp)}</CardTitle>
                    <div className="flex flex-wrap items-center gap-1 text-xs text-muted-foreground">
                      <CardDescription className="text-xs">
                        {entry.language} | {entry.provider}/{entry.model} | {recordedTimeLabel} · {lengthSummary} · {costSummary}
                        {postProcessingLabel}
                      </CardDescription>
                      <button
                        type="button"
                        className="app-no-drag inline-flex h-4 w-4 items-center justify-center rounded-full border border-border-subtle text-[10px] text-foreground/60 transition-colors hover:bg-surface-2 hover:text-foreground"
                        title="Estimated dictation cost based on token count and LiteLLM model pricing. Final billed amount may vary by provider tokenization."
                        onClick={() => {
                          pushToast({
                            title: 'Estimated dictation cost',
                            description: hasEnhancedDictation
                              ? `${entry.provider}/${entry.model}: STT ${formatCurrency(transcriptionCostEstimateUSD)} + post-processing ${formatCurrency(postProcessingCostEstimateUSD)}.`
                              : `${entry.provider}/${entry.model}: ~${formatCount(rawTokenEstimate)} tokens, estimated ${formatCurrency(transcriptionCostEstimateUSD)}.`,
                          })
                        }}
                      >
                        i
                      </button>
                    </div>
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

      {canShowMore ? (
        <div className="flex items-center justify-between rounded-[var(--radius-premium)] border border-border-subtle bg-surface-1 px-3 py-2">
          <p className="text-xs text-muted-foreground">
            Showing {entries.length} of {totalEntries} dictations.
          </p>
          <Button
            variant="outline"
            size="sm"
            className="h-8"
            onClick={() => {
              onShowMore()
            }}
          >
            Show more
          </Button>
        </div>
      ) : null}

      <Dialog
        open={clearConfirmOpen}
        onOpenChange={(open) => {
          onClearConfirmOpenChange(open)
        }}
      >
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Confirm clear dictations</DialogTitle>
            <DialogDescription>
              This action removes all dictations saved locally. It cannot be undone.
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

interface NotesSectionProps {
  settings: AppSettings
  usageStats: AppUsageStatsPayload | null
  folders: NoteFolder[]
  notes: NoteEntry[]
  actions: NoteAction[]
  activeFolderId: string | null
  activeNoteId: string | null
  dictationStatus: 'IDLE' | 'RECORDING' | 'PROCESSING'
  transcribingNoteId: string | null
  recordingElapsedSeconds: number
  postProcessingNoteId: string | null
  onSelectFolder: (folderId: string | null) => void
  onCreateFolder: (name: string) => void
  onDeleteFolder: (folderId: string) => void
  onCreateNote: (folderId: string | null) => void
  onSelectNote: (noteId: string) => void
  onUpdateNote: (
    noteId: string,
    patch: Partial<Pick<NoteEntry, 'title' | 'rawText' | 'processedText' | 'folderId' | 'autoTitleGenerated'>>,
  ) => void
  onDeleteNote: (noteId: string) => void
  onTranscribeNote: (noteId: string) => void
  onRunNoteAction: (noteId: string, actionId: string | null) => void
  onCreateNoteAction: (name: string, description: string, instructions: string, actionId?: string | null) => void
  onDeleteNoteAction: (actionId: string) => void
  onForceSaveNote: (noteId: string) => void
  onTrackRawNoteCaret: (noteId: string, caretPosition: number) => void
}

const stripNotePreview = (value: string) =>
  value
    .replace(/#{1,6}\s+/g, '')
    .replace(/[*_~`]+/g, '')
    .replace(/\[([^\]]+)\]\([^)]+\)/g, '$1')
    .replace(/!\[([^\]]*)\]\([^)]+\)/g, '$1')
    .replace(/>\s+/g, '')
    .replace(/\n+/g, ' ')
    .trim()

const formatRelativeNoteTime = (timestamp: number) => {
  const diff = Date.now() - timestamp
  const minutes = Math.floor(diff / 60000)
  const hours = Math.floor(diff / 3600000)
  const days = Math.floor(diff / 86400000)

  if (minutes < 1) {
    return 'now'
  }

  if (minutes < 60) {
    return `${minutes}m`
  }

  if (hours < 24) {
    return `${hours}h`
  }

  if (days < 7) {
    return `${days}d`
  }

  return new Date(timestamp).toLocaleDateString(undefined, {
    month: 'short',
    day: 'numeric',
  })
}

const MAX_NOTES_EXPANDED_COUNT = 20
const COLLAPSED_LIST_COUNT = 5

const generateNoteTitleFromContent = (content: string) => {
  const normalized = content
    .replace(/`{1,3}[^`]*`{1,3}/g, ' ')
    .replace(/[>#*_~-]+/g, ' ')
    .replace(/\[[^\]]+\]\([^)]+\)/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()

  if (!normalized) {
    return 'Untitled'
  }

  const words = normalized.split(' ').slice(0, 8)
  return words.join(' ').trim().replace(/[.,;:!?]+$/, '')
}

const createNoteSlug = (title: string) => {
  const token = title
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')

  return token.length > 0 ? token : 'note'
}

const extractDefaultNoteIndex = (title: string) => {
  const match = title.trim().match(/^note\s+(\d+)$/i)
  if (!match) {
    return null
  }

  const value = Number.parseInt(match[1] ?? '', 10)
  return Number.isFinite(value) && value > 0 ? value : null
}

const getNextFolderNoteIndex = (notes: NoteEntry[], folderId: string | null) => {
  const usedIndices = new Set<number>()

  for (const note of notes) {
    if (note.folderId !== folderId) {
      continue
    }

    const defaultIndex = extractDefaultNoteIndex(note.title)
    if (defaultIndex !== null) {
      usedIndices.add(defaultIndex)
    }
  }

  let nextIndex = 1
  while (usedIndices.has(nextIndex)) {
    nextIndex += 1
  }

  return nextIndex
}

const NotesSection = ({
  settings,
  usageStats,
  folders,
  notes,
  actions,
  activeFolderId,
  activeNoteId,
  dictationStatus,
  transcribingNoteId,
  recordingElapsedSeconds,
  postProcessingNoteId,
  onSelectFolder,
  onCreateFolder,
  onDeleteFolder,
  onCreateNote,
  onSelectNote,
  onUpdateNote,
  onDeleteNote,
  onTranscribeNote,
  onRunNoteAction,
  onCreateNoteAction,
  onDeleteNoteAction,
  onForceSaveNote,
  onTrackRawNoteCaret,
}: NotesSectionProps) => {
  const { pushToast } = useToast()
  const [isCreatingFolder, setIsCreatingFolder] = useState(false)
  const [newFolderName, setNewFolderName] = useState('')
  const [actionsMenuOpen, setActionsMenuOpen] = useState(false)
  const [actionsMenuAnchor, setActionsMenuAnchor] = useState<{ x: number; y: number } | null>(null)
  const [actionManagerOpen, setActionManagerOpen] = useState(false)
  const [editingActionId, setEditingActionId] = useState<string | null>(null)
  const [lastUsedActionId, setLastUsedActionId] = useState<string | null>(null)
  const [customActionName, setCustomActionName] = useState('')
  const [customActionDescription, setCustomActionDescription] = useState('')
  const [customActionInstructions, setCustomActionInstructions] = useState('')
  const [foldersCollapsed, setFoldersCollapsed] = useState(false)
  const [notesCollapsed, setNotesCollapsed] = useState(false)
  const [folderPanelRatio, setFolderPanelRatio] = useState(0.42)
  const [isResizingPanels, setIsResizingPanels] = useState(false)
  const [notesVisibleLimit, setNotesVisibleLimit] = useState(MAX_NOTES_EXPANDED_COUNT)
  const [foldersVisibleLimit, setFoldersVisibleLimit] = useState(20)
  const [bulkModeEnabled, setBulkModeEnabled] = useState(false)
  const [selectedNoteIds, setSelectedNoteIds] = useState<string[]>([])
  const [bulkTargetFolderId, setBulkTargetFolderId] = useState<string>('')
  const [viewMode, setViewMode] = useState<'raw' | 'processed' | 'preview'>('raw')
  const [exportMenuOpen, setExportMenuOpen] = useState(false)
  const [exportMenuAnchor, setExportMenuAnchor] = useState<{ x: number; y: number } | null>(null)
  const [markdownMenuOpen, setMarkdownMenuOpen] = useState(false)
  const [markdownMenuAnchor, setMarkdownMenuAnchor] = useState<{ x: number; y: number } | null>(null)
  const editorTextareaRef = useRef<HTMLTextAreaElement | null>(null)
  const panelResizeStartRef = useRef<{ y: number; ratio: number } | null>(null)

  const filteredNotes = useMemo(() => {
    const recentFirst = [...notes].sort((left, right) => right.updatedAt - left.updatedAt)

    if (!activeFolderId) {
      return recentFirst.filter((entry) => entry.folderId === null)
    }

    return recentFirst.filter((entry) => entry.folderId === activeFolderId)
  }, [activeFolderId, notes])

  const sortedFoldersByRecent = useMemo(
    () => [...folders].sort((left, right) => right.updatedAt - left.updatedAt),
    [folders],
  )

  const displayedFolders = useMemo(() => {
    if (foldersCollapsed) {
      return sortedFoldersByRecent.slice(0, COLLAPSED_LIST_COUNT)
    }

    return sortedFoldersByRecent.slice(0, foldersVisibleLimit)
  }, [foldersCollapsed, foldersVisibleLimit, sortedFoldersByRecent])

  const displayedNotes = useMemo(() => {
    if (notesCollapsed) {
      return filteredNotes.slice(0, COLLAPSED_LIST_COUNT)
    }

    return filteredNotes.slice(0, notesVisibleLimit)
  }, [filteredNotes, notesCollapsed, notesVisibleLimit])

  const canLoadMoreNotes = !notesCollapsed && filteredNotes.length > displayedNotes.length
  const canLoadMoreFolders = !foldersCollapsed && sortedFoldersByRecent.length > displayedFolders.length
  const showFolderNotesSplitter = !foldersCollapsed && !notesCollapsed

  const activeNote = notes.find((entry) => entry.id === activeNoteId) ?? null
  const uncategorizedNotesCount = useMemo(
    () => notes.filter((entry) => entry.folderId === null).length,
    [notes],
  )
  const rawNoteWordCount = activeNote ? estimateWordsFromText(activeNote.rawText) : 0
  const enhancedNoteWordCount = activeNote ? estimateWordsFromText(activeNote.processedText) : 0
  const noteRawTokenEstimate = activeNote ? estimateTokensFromText(activeNote.rawText) : 0
  const noteEnhancedTokenEstimate = activeNote ? estimateTokensFromText(activeNote.processedText) : 0
  const noteHasEnhancedOutput = Boolean(activeNote?.processedText.trim().length)
  const isRecordingActiveNote = dictationStatus === 'RECORDING' && transcribingNoteId === activeNote?.id
  const isTranscribingActiveNote = dictationStatus === 'PROCESSING' && transcribingNoteId === activeNote?.id

  useEffect(() => {
    if (!activeNote) {
      return
    }

    if (viewMode === 'processed' && !activeNote.processedText.trim()) {
      setViewMode('raw')
    }
  }, [activeNote, viewMode])

  useEffect(() => {
    setNotesVisibleLimit(MAX_NOTES_EXPANDED_COUNT)
  }, [activeFolderId])

  useEffect(() => {
    if (!isResizingPanels) {
      return
    }

    const handlePointerMove = (event: PointerEvent) => {
      if (!panelResizeStartRef.current) {
        return
      }

      const delta = event.clientY - panelResizeStartRef.current.y
      const deltaRatio = delta / 420
      const nextRatio = Math.min(0.75, Math.max(0.2, panelResizeStartRef.current.ratio + deltaRatio))
      setFolderPanelRatio(nextRatio)
    }

    const stopResizing = () => {
      panelResizeStartRef.current = null
      setIsResizingPanels(false)
    }

    window.addEventListener('pointermove', handlePointerMove)
    window.addEventListener('pointerup', stopResizing)

    return () => {
      window.removeEventListener('pointermove', handlePointerMove)
      window.removeEventListener('pointerup', stopResizing)
    }
  }, [isResizingPanels])

  useEffect(() => {
    if (!activeNote) {
      return
    }

    const handleSaveShortcut = (event: KeyboardEvent) => {
      const isSaveShortcut = (event.ctrlKey || event.metaKey) && event.key.toLowerCase() === 's'
      if (!isSaveShortcut) {
        return
      }

      event.preventDefault()
      onForceSaveNote(activeNote.id)
    }

    window.addEventListener('keydown', handleSaveShortcut)
    return () => {
      window.removeEventListener('keydown', handleSaveShortcut)
    }
  }, [activeNote, onForceSaveNote])

  useEffect(() => {
    setSelectedNoteIds((current) => current.filter((id) => notes.some((note) => note.id === id)))
  }, [notes])

  const commitFolderCreation = () => {
    const nextName = newFolderName.trim()
    if (!nextName) {
      setIsCreatingFolder(false)
      setNewFolderName('')
      return
    }

    onCreateFolder(nextName)
    setIsCreatingFolder(false)
    setNewFolderName('')
  }

  const activeEditorValue = viewMode === 'processed' ? activeNote?.processedText ?? '' : activeNote?.rawText ?? ''

  const reportActiveRawCaret = useCallback(
    (textarea: HTMLTextAreaElement | null) => {
      if (!textarea || !activeNote || viewMode !== 'raw') {
        return
      }

      const nextCaret = Number.isFinite(textarea.selectionStart) ? textarea.selectionStart : 0
      onTrackRawNoteCaret(activeNote.id, Math.max(0, nextCaret))
    },
    [activeNote, onTrackRawNoteCaret, viewMode],
  )

  const updateActiveEditorValue = useCallback(
    (nextValue: string) => {
      if (!activeNote) {
        return
      }

      if (viewMode === 'processed') {
        onUpdateNote(activeNote.id, {
          processedText: nextValue,
        })
        return
      }

      onUpdateNote(activeNote.id, {
        rawText: nextValue,
      })
    },
    [activeNote, onUpdateNote, viewMode],
  )

  const applyMarkdownWrapper = useCallback(
    (prefix: string, suffix = prefix, placeholder = 'text') => {
      if (!editorTextareaRef.current || !activeNote || viewMode === 'preview') {
        return
      }

      const textarea = editorTextareaRef.current
      const start = textarea.selectionStart
      const end = textarea.selectionEnd
      const source = activeEditorValue
      const selected = source.slice(start, end)
      const content = selected || placeholder
      const replacement = `${prefix}${content}${suffix}`
      const nextValue = `${source.slice(0, start)}${replacement}${source.slice(end)}`

      updateActiveEditorValue(nextValue)

      requestAnimationFrame(() => {
        textarea.focus()
        const cursorStart = start + prefix.length
        const cursorEnd = cursorStart + content.length
        textarea.setSelectionRange(cursorStart, cursorEnd)
      })
    },
    [activeEditorValue, activeNote, updateActiveEditorValue, viewMode],
  )

  const applyMarkdownLinePrefix = useCallback(
    (prefix: string) => {
      if (!editorTextareaRef.current || !activeNote || viewMode === 'preview') {
        return
      }

      const textarea = editorTextareaRef.current
      const start = textarea.selectionStart
      const end = textarea.selectionEnd
      const source = activeEditorValue
      const lineStart = source.lastIndexOf('\n', start - 1) + 1
      const lineEndRaw = source.indexOf('\n', end)
      const lineEnd = lineEndRaw === -1 ? source.length : lineEndRaw
      const block = source.slice(lineStart, lineEnd)
      const prefixed = block
        .split('\n')
        .map((line) => `${prefix}${line}`)
        .join('\n')
      const nextValue = `${source.slice(0, lineStart)}${prefixed}${source.slice(lineEnd)}`

      updateActiveEditorValue(nextValue)
      requestAnimationFrame(() => {
        textarea.focus()
      })
    },
    [activeEditorValue, activeNote, updateActiveEditorValue, viewMode],
  )

  const insertMarkdownSnippet = useCallback(
    (snippetTemplate: string) => {
      if (!editorTextareaRef.current || !activeNote || viewMode === 'preview') {
        return
      }

      const textarea = editorTextareaRef.current
      const start = textarea.selectionStart
      const end = textarea.selectionEnd
      const source = activeEditorValue
      const marker = '{{cursor}}'
      const markerIndex = snippetTemplate.indexOf(marker)
      const snippet = snippetTemplate.replace(marker, '')
      const nextValue = `${source.slice(0, start)}${snippet}${source.slice(end)}`

      updateActiveEditorValue(nextValue)
      requestAnimationFrame(() => {
        textarea.focus()
        const cursorOffset = markerIndex >= 0 ? markerIndex : snippet.length
        const cursorPosition = start + cursorOffset
        textarea.setSelectionRange(cursorPosition, cursorPosition)
      })
    },
    [activeEditorValue, activeNote, updateActiveEditorValue, viewMode],
  )

  const exportActiveNote = useCallback(
    async (format: 'txt' | 'md' | 'html') => {
      if (!activeNote) {
        return
      }

      const baseContent = viewMode === 'processed' ? activeNote.processedText : activeNote.rawText
      const markdownContent = baseContent.trim()
      const plainTextContent = markdownContent.replace(/\[[^\]]+\]\([^)]+\)/g, '$1').replace(/[*_`#>-]/g, '').trim()
      const htmlContent = await marked.parse(markdownContent)

      const payloadByFormat = {
        txt: plainTextContent,
        md: markdownContent,
        html: `<!doctype html><html><head><meta charset="utf-8" /><title>${activeNote.title}</title></head><body>${htmlContent}</body></html>`,
      }

      const mimeByFormat = {
        txt: 'text/plain;charset=utf-8',
        md: 'text/markdown;charset=utf-8',
        html: 'text/html;charset=utf-8',
      }

      const blob = new Blob([payloadByFormat[format]], {
        type: mimeByFormat[format],
      })
      const fileName = `${createNoteSlug(activeNote.title)}.${format}`
      const objectUrl = URL.createObjectURL(blob)
      const anchor = document.createElement('a')
      anchor.href = objectUrl
      anchor.download = fileName
      anchor.click()
      URL.revokeObjectURL(objectUrl)
    },
    [activeNote, viewMode],
  )

  const canRunActions = Boolean(activeNote?.rawText.trim())
  const postProcessingEnabled = settings.postProcessingEnabled
  const activeAction = useMemo(() => actions.find((action) => action.id === lastUsedActionId) ?? actions[0] ?? null, [actions, lastUsedActionId])
  const postProcessingModelForEstimate =
    usageStats?.activeEnhancementModel ||
    (settings.postProcessingRuntime === 'cloud' ? settings.postProcessingCloudModelId : settings.postProcessingLocalModelId)
  const enhancementInputUnitCost = usageStats?.activeEnhancementInputCostPerToken ?? null
  const enhancementOutputUnitCost = usageStats?.activeEnhancementOutputCostPerToken ?? null
  const noteSpentCostUSD =
    activeNote &&
    noteHasEnhancedOutput &&
    noteRawTokenEstimate > 0 &&
    (enhancementInputUnitCost !== null || enhancementOutputUnitCost !== null)
      ? Number(
          (
            noteRawTokenEstimate * (enhancementInputUnitCost ?? 0) +
            noteEnhancedTokenEstimate * (enhancementOutputUnitCost ?? 0)
          ).toFixed(6),
        )
      : noteHasEnhancedOutput
        ? null
        : 0
  const noteComparedWordsLabel = noteHasEnhancedOutput
    ? `${formatCount(rawNoteWordCount)}/${formatCount(enhancedNoteWordCount)} words`
    : `${formatCount(rawNoteWordCount)}/-- words`
  const noteComparedTokensLabel = noteHasEnhancedOutput
    ? `~${formatCount(noteRawTokenEstimate)}/~${formatCount(noteEnhancedTokenEstimate)} tokens`
    : `~${formatCount(noteRawTokenEstimate)}/-- tokens`
  const noteSpentLabel = noteSpentCostUSD === null ? 'n/a now spent' : `~${formatCurrency(noteSpentCostUSD)} now spent`

  useEffect(() => {
    const storedActionId = localStorage.getItem(STORAGE_KEYS.noteLastAction)
    if (storedActionId) {
      setLastUsedActionId(storedActionId)
    }
  }, [])

  useEffect(() => {
    if (!activeAction) {
      return
    }

    if (lastUsedActionId !== activeAction.id) {
      setLastUsedActionId(activeAction.id)
    }
  }, [activeAction, lastUsedActionId])

  useEffect(() => {
    if (!lastUsedActionId) {
      return
    }

    localStorage.setItem(STORAGE_KEYS.noteLastAction, lastUsedActionId)
  }, [lastUsedActionId])

  const handleRunAction = useCallback(
    (action: NoteAction) => {
      if (!activeNote) {
        return
      }

      setLastUsedActionId(action.id)
      onRunNoteAction(activeNote.id, action.id)
    },
    [activeNote, onRunNoteAction],
  )

  const actionMenuItems = useMemo(() => {
    return [
      ...actions.map((action) => ({
        label: action.name,
        description: action.description || undefined,
        icon: <Sparkles className="h-3.5 w-3.5" />,
        selected: activeAction?.id === action.id,
        disabled: !activeNote || !canRunActions || postProcessingNoteId === activeNote.id || !postProcessingEnabled,
        onSelect: () => {
          setLastUsedActionId(action.id)
        },
      })),
      {
        separator: true,
      },
      {
        label: 'Add action...',
        icon: <Plus className="h-3.5 w-3.5" />,
        onSelect: () => {
          resetActionEditor()
          setActionManagerOpen(true)
        },
      },
      {
        label: 'Manage actions',
        icon: <Settings className="h-3.5 w-3.5" />,
        onSelect: () => {
          setActionManagerOpen(true)
        },
      },
    ]
  }, [actions, activeAction?.id, activeNote, canRunActions, postProcessingEnabled, postProcessingNoteId])

  const markdownCommandsDisabled = viewMode === 'preview' || !activeNote

  const markdownToolbarItems = [
    {
      id: 'bold',
      icon: <Bold className="h-3.5 w-3.5" />,
      label: 'Bold',
      onClick: () => applyMarkdownWrapper('**'),
    },
    {
      id: 'italic',
      icon: <Italic className="h-3.5 w-3.5" />,
      label: 'Italic',
      onClick: () => applyMarkdownWrapper('*'),
    },
    {
      id: 'strike',
      icon: <span className="text-[11px] font-semibold">S</span>,
      label: 'Strikethrough',
      onClick: () => applyMarkdownWrapper('~~'),
    },
    {
      id: 'h1',
      icon: <Heading1 className="h-3.5 w-3.5" />,
      label: 'Heading 1',
      onClick: () => applyMarkdownLinePrefix('# '),
    },
    {
      id: 'bullet',
      icon: <List className="h-3.5 w-3.5" />,
      label: 'Bullet list',
      onClick: () => applyMarkdownLinePrefix('- '),
    },
    {
      id: 'ordered',
      icon: <ListOrdered className="h-3.5 w-3.5" />,
      label: 'Numbered list',
      onClick: () => applyMarkdownLinePrefix('1. '),
    },
    {
      id: 'task',
      icon: <CheckSquare className="h-3.5 w-3.5" />,
      label: 'Task list',
      onClick: () => applyMarkdownLinePrefix('- [ ] '),
    },
    {
      id: 'quote',
      icon: <Quote className="h-3.5 w-3.5" />,
      label: 'Quote',
      onClick: () => applyMarkdownLinePrefix('> '),
    },
    {
      id: 'code-inline',
      icon: <Code2 className="h-3.5 w-3.5" />,
      label: 'Inline code',
      onClick: () => applyMarkdownWrapper('`'),
    },
    {
      id: 'code-block',
      icon: <span className="text-[11px] font-semibold">```</span>,
      label: 'Code block',
      onClick: () => insertMarkdownSnippet('```markdown\n{{cursor}}\n```'),
    },
    {
      id: 'link',
      icon: <Link2 className="h-3.5 w-3.5" />,
      label: 'Link',
      onClick: () => applyMarkdownWrapper('[', '](https://example.com)', 'link text'),
    },
    {
      id: 'image',
      icon: <ImagePlus className="h-3.5 w-3.5" />,
      label: 'Image',
      onClick: () => applyMarkdownWrapper('![', '](https://example.com/image.png)', 'alt text'),
    },
    {
      id: 'table',
      icon: <span className="text-[11px] font-semibold">Tbl</span>,
      label: 'Table',
      onClick: () =>
        insertMarkdownSnippet('| Column 1 | Column 2 |\n| --- | --- |\n| {{cursor}} | Value 2 |'),
    },
    {
      id: 'hr',
      icon: <Minus className="h-3.5 w-3.5" />,
      label: 'Horizontal line',
      onClick: () => insertMarkdownSnippet('\n---\n{{cursor}}'),
    },
    {
      id: 'video',
      icon: <Video className="h-3.5 w-3.5" />,
      label: 'Video',
      onClick: () =>
        applyMarkdownWrapper('<video controls src="', '"></video>', 'https://example.com/video.mp4'),
    },
  ]

  const markdownMenuItems = [
    {
      label: 'Heading 2',
      icon: <span className="text-[11px] font-semibold">H2</span>,
      disabled: markdownCommandsDisabled,
      onSelect: () => applyMarkdownLinePrefix('## '),
    },
    {
      label: 'Heading 3',
      icon: <span className="text-[11px] font-semibold">H3</span>,
      disabled: markdownCommandsDisabled,
      onSelect: () => applyMarkdownLinePrefix('### '),
    },
    {
      label: 'Heading 4',
      icon: <span className="text-[11px] font-semibold">H4</span>,
      disabled: markdownCommandsDisabled,
      onSelect: () => applyMarkdownLinePrefix('#### '),
    },
    {
      label: 'Heading 5',
      icon: <span className="text-[11px] font-semibold">H5</span>,
      disabled: markdownCommandsDisabled,
      onSelect: () => applyMarkdownLinePrefix('##### '),
    },
    {
      label: 'Heading 6',
      icon: <span className="text-[11px] font-semibold">H6</span>,
      disabled: markdownCommandsDisabled,
      onSelect: () => applyMarkdownLinePrefix('###### '),
    },
    { separator: true },
    {
      label: 'Checked task',
      icon: <CheckSquare className="h-3.5 w-3.5" />,
      disabled: markdownCommandsDisabled,
      onSelect: () => applyMarkdownLinePrefix('- [x] '),
    },
    {
      label: 'Footnote ref',
      icon: <span className="text-[11px] font-semibold">Fn</span>,
      disabled: markdownCommandsDisabled,
      onSelect: () => insertMarkdownSnippet('[^1]{{cursor}}\n\n[^1]: Footnote text'),
    },
    {
      label: 'Reference link',
      icon: <Link2 className="h-3.5 w-3.5" />,
      disabled: markdownCommandsDisabled,
      onSelect: () =>
        insertMarkdownSnippet('[link text][ref]{{cursor}}\n\n[ref]: https://example.com "title"'),
    },
    {
      label: 'Table aligned',
      icon: <span className="text-[11px] font-semibold">Tbl+</span>,
      disabled: markdownCommandsDisabled,
      onSelect: () =>
        insertMarkdownSnippet('| Left | Center | Right |\n| :--- | :---: | ---: |\n| {{cursor}} | value | value |'),
    },
    {
      label: 'Details block',
      icon: <ChevronDown className="h-3.5 w-3.5" />,
      disabled: markdownCommandsDisabled,
      onSelect: () =>
        insertMarkdownSnippet('<details>\n<summary>More details</summary>\n\n{{cursor}}\n\n</details>'),
    },
    {
      label: 'Underline (HTML)',
      icon: <span className="text-[11px] font-semibold">U</span>,
      disabled: markdownCommandsDisabled,
      onSelect: () => applyMarkdownWrapper('<u>', '</u>'),
    },
    {
      label: 'Superscript (HTML)',
      icon: <span className="text-[11px] font-semibold">X2</span>,
      disabled: markdownCommandsDisabled,
      onSelect: () => applyMarkdownWrapper('<sup>', '</sup>'),
    },
    {
      label: 'Subscript (HTML)',
      icon: <span className="text-[11px] font-semibold">X0</span>,
      disabled: markdownCommandsDisabled,
      onSelect: () => applyMarkdownWrapper('<sub>', '</sub>'),
    },
  ]

  const openMarkdownMenu = (targetButton: HTMLButtonElement) => {
    const buttonRect = targetButton.getBoundingClientRect()
    const estimatedMenuHeight = Math.min(460, markdownMenuItems.length * 36 + 16)
    const menuWidth = 224

    setMarkdownMenuAnchor({
      x: Math.max(12, Math.min(buttonRect.left, window.innerWidth - menuWidth - 12)),
      y: Math.max(12, buttonRect.top - estimatedMenuHeight - 8),
    })
    setMarkdownMenuOpen(true)
  }

  const openActionsMenu = (targetButton: HTMLButtonElement) => {
    const buttonRect = targetButton.getBoundingClientRect()
    const estimatedMenuHeight = Math.min(420, actionMenuItems.length * 36 + 16)
    const menuWidth = 224

    setActionsMenuAnchor({
      x: Math.max(12, Math.min(buttonRect.left, window.innerWidth - menuWidth - 12)),
      y: Math.max(12, buttonRect.top - estimatedMenuHeight - 8),
    })
    setActionsMenuOpen(true)
  }

  const exportMenuItems = [
    {
      label: 'Export as TXT',
      icon: <FileText className="h-3.5 w-3.5" />,
      onSelect: () => {
        void exportActiveNote('txt')
      },
    },
    {
      label: 'Export as Markdown',
      icon: <FileText className="h-3.5 w-3.5" />,
      onSelect: () => {
        void exportActiveNote('md')
      },
    },
    {
      label: 'Export as HTML',
      icon: <Eye className="h-3.5 w-3.5" />,
      onSelect: () => {
        void exportActiveNote('html')
      },
    },
  ]

  const openExportMenu = (targetButton: HTMLButtonElement) => {
    const buttonRect = targetButton.getBoundingClientRect()
    const menuWidth = 196
    const estimatedMenuHeight = 140

    setExportMenuAnchor({
      x: Math.max(12, Math.min(buttonRect.left - menuWidth + buttonRect.width, window.innerWidth - menuWidth - 12)),
      y: Math.max(12, buttonRect.top - estimatedMenuHeight - 8),
    })
    setExportMenuOpen(true)
  }

  const resetActionEditor = () => {
    setEditingActionId(null)
    setCustomActionName('')
    setCustomActionDescription('')
    setCustomActionInstructions('')
  }

  const commitCustomAction = () => {
    const normalizedName = customActionName.trim()
    const normalizedDescription = customActionDescription.trim()
    const normalizedInstructions = customActionInstructions.trim()

    if (!normalizedName || !normalizedInstructions) {
      return
    }

    onCreateNoteAction(normalizedName, normalizedDescription, normalizedInstructions, editingActionId)
    resetActionEditor()
  }

  return (
    <div className="flex h-full min-h-[36rem] overflow-hidden rounded-[14px] border border-border-subtle bg-surface-0">
      <aside className="flex w-64 shrink-0 flex-col border-r border-border-subtle bg-surface-1/90">
        <div className="flex min-h-0 flex-1 flex-col">
          <div className="flex items-center justify-between px-3 py-2">
            <span className="text-[10px] font-medium uppercase tracking-[0.14em] text-foreground/30">Folders</span>
            <div className="flex items-center gap-1">
              <Button
                variant="ghost"
                size="icon"
                className="h-5 w-5 rounded-md text-foreground/50 hover:bg-surface-2 hover:text-foreground"
                onClick={() => {
                  setFoldersCollapsed((current) => !current)
                }}
              >
                {foldersCollapsed ? <Plus className="h-3.5 w-3.5" /> : <Minus className="h-3.5 w-3.5" />}
              </Button>
              <Button
                variant="ghost"
                size="icon"
                className="h-5 w-5 rounded-md text-foreground/50 hover:bg-surface-2 hover:text-foreground"
                onClick={() => {
                  setIsCreatingFolder(true)
                }}
              >
                <Plus className="h-3.5 w-3.5" />
              </Button>
            </div>
          </div>

          <div
            className="min-h-0 px-1.5"
            style={showFolderNotesSplitter ? { height: `${Math.round(folderPanelRatio * 100)}%` } : { height: '50%' }}
          >
            <div className="h-full overflow-y-auto [scrollbar-width:none] [&::-webkit-scrollbar]:hidden">
              <div className="space-y-px pb-2">
                <button
                  type="button"
                  className={cn(
                    'group relative flex h-7 w-full items-center gap-2 rounded-md px-2 text-left transition-colors',
                    activeFolderId === null
                      ? 'bg-primary/15 text-foreground'
                      : 'text-foreground/70 hover:bg-surface-2/70 hover:text-foreground/90',
                  )}
                  onClick={() => {
                    onSelectFolder(null)
                  }}
                >
                  {activeFolderId === null ? <span className="absolute left-0 h-4 w-0.5 rounded-r-full bg-primary" /> : null}
                  <FolderOpen className={cn('h-3.5 w-3.5', activeFolderId === null ? 'text-primary' : 'text-foreground/35')} />
                  <span className={cn('truncate text-xs', activeFolderId === null ? 'font-medium' : undefined)}>
                    Uncategorized
                  </span>
                  <span className="ml-auto text-[11px] tabular-nums text-foreground/35">
                    {uncategorizedNotesCount > 0 ? uncategorizedNotesCount : ''}
                  </span>
                </button>

                {displayedFolders.map((folder) => {
                  const count = notes.filter((entry) => entry.folderId === folder.id).length
                  const isActive = activeFolderId === folder.id

                  return (
                    <div key={folder.id} className="group relative flex items-center gap-1">
                      <button
                        type="button"
                        className={cn(
                          'relative flex h-7 w-full items-center gap-2 rounded-md px-2 text-left transition-colors',
                          isActive
                            ? 'bg-primary/15 text-foreground'
                            : 'text-foreground/70 hover:bg-surface-2/70 hover:text-foreground/90',
                        )}
                        onClick={() => {
                          onSelectFolder(folder.id)
                        }}
                      >
                        {isActive ? <span className="absolute left-0 h-4 w-0.5 rounded-r-full bg-primary" /> : null}
                        <FolderOpen className={cn('h-3.5 w-3.5', isActive ? 'text-primary' : 'text-foreground/35')} />
                        <span className={cn('truncate pr-2 text-xs', isActive ? 'font-medium' : undefined)}>{folder.name}</span>
                        <span className="ml-auto text-[11px] tabular-nums text-foreground/35">{count > 0 ? count : ''}</span>
                      </button>
                      <Button
                        size="icon"
                        variant="ghost"
                        className="absolute right-1 h-5 w-5 opacity-0 transition-opacity group-hover:opacity-100"
                        onClick={() => {
                          onDeleteFolder(folder.id)
                        }}
                      >
                        <Trash2 className="h-3 w-3" />
                      </Button>
                    </div>
                  )
                })}

                {canLoadMoreFolders ? (
                  <Button
                    variant="ghost"
                    size="sm"
                    className="h-7 w-full text-[11px]"
                    onClick={() => {
                      setFoldersVisibleLimit((current) => current + 20)
                    }}
                  >
                    Load more folders
                  </Button>
                ) : null}

                {isCreatingFolder ? (
                  <Input
                    className="h-7 border-border-subtle bg-surface-0 text-xs"
                    autoFocus
                    value={newFolderName}
                    onChange={(event) => {
                      setNewFolderName(event.target.value)
                    }}
                    onKeyDown={(event) => {
                      if (event.key === 'Enter') {
                        commitFolderCreation()
                      }

                      if (event.key === 'Escape') {
                        setIsCreatingFolder(false)
                        setNewFolderName('')
                      }
                    }}
                    onBlur={commitFolderCreation}
                    placeholder="Folder name"
                  />
                ) : null}
              </div>
            </div>
          </div>

          {showFolderNotesSplitter ? (
            <button
              type="button"
              className="mx-2 my-1 h-2 cursor-row-resize rounded-md bg-transparent app-no-drag"
              onPointerDown={(event) => {
                panelResizeStartRef.current = {
                  y: event.clientY,
                  ratio: folderPanelRatio,
                }
                setIsResizingPanels(true)
              }}
            >
              <span className="block h-px w-full bg-border-subtle" />
            </button>
          ) : (
            <div className="mx-3 my-1 h-px bg-border-subtle" />
          )}

          <div className="flex items-center justify-between px-3 py-1">
            <span className="text-[10px] font-medium uppercase tracking-[0.14em] text-foreground/30">Notes</span>
            <div className="flex items-center gap-1">
              <Button
                variant="ghost"
                size="icon"
                className="h-5 w-5 rounded-md text-foreground/50 hover:bg-surface-2 hover:text-foreground"
                onClick={() => {
                  setNotesCollapsed((current) => !current)
                }}
              >
                {notesCollapsed ? <Plus className="h-3.5 w-3.5" /> : <Minus className="h-3.5 w-3.5" />}
              </Button>
              <Button
                variant="ghost"
                size="icon"
                className={cn(
                  'h-5 w-5 rounded-md text-foreground/50 hover:bg-surface-2 hover:text-foreground',
                  bulkModeEnabled ? 'bg-surface-2 text-foreground' : undefined,
                )}
                onClick={() => {
                  setBulkModeEnabled((current) => !current)
                  setSelectedNoteIds([])
                }}
              >
                <CheckSquare className="h-3.5 w-3.5" />
              </Button>
              <Button
                variant="ghost"
                size="icon"
                className="h-5 w-5 rounded-md text-foreground/50 hover:bg-surface-2 hover:text-foreground"
                onClick={() => {
                  onCreateNote(activeFolderId)
                }}
              >
                <Plus className="h-3.5 w-3.5" />
              </Button>
            </div>
          </div>

          <div
            className="min-h-0 px-1.5 pb-2"
            style={showFolderNotesSplitter ? { height: `${Math.round((1 - folderPanelRatio) * 100)}%` } : { height: '50%' }}
          >
            <div className="h-full overflow-y-auto [scrollbar-width:none] [&::-webkit-scrollbar]:hidden">
              {displayedNotes.length === 0 ? (
                <div className="px-3 py-8 text-center">
                  <BookOpen className="mx-auto h-4 w-4 text-foreground/30" />
                  <p className="mt-2 text-xs text-foreground/35">No notes in this section.</p>
                </div>
              ) : (
                displayedNotes.map((entry) => {
                  const preview = stripNotePreview(entry.rawText)
                  const isActive = activeNoteId === entry.id
                  const isSelected = selectedNoteIds.includes(entry.id)

                  return (
                    <button
                      key={entry.id}
                      type="button"
                      className={cn(
                        'group relative w-full px-3 py-1.5 text-left transition-colors',
                        isActive || isSelected ? 'bg-primary/15' : 'hover:bg-surface-2/70',
                      )}
                      onClick={() => {
                        if (bulkModeEnabled) {
                          setSelectedNoteIds((current) =>
                            current.includes(entry.id) ? current.filter((id) => id !== entry.id) : [...current, entry.id],
                          )
                          return
                        }

                        onSelectNote(entry.id)
                      }}
                    >
                      {isActive || isSelected ? (
                        <span className="absolute left-0 top-1/2 h-4 w-0.5 -translate-y-1/2 rounded-r-full bg-primary" />
                      ) : null}
                      <div className="flex items-center gap-2">
                        {bulkModeEnabled ? (
                          <input
                            type="checkbox"
                            checked={isSelected}
                            onChange={(event) => {
                              event.stopPropagation()
                              setSelectedNoteIds((current) =>
                                current.includes(entry.id)
                                  ? current.filter((id) => id !== entry.id)
                                  : [...current, entry.id],
                              )
                            }}
                            className="h-3.5 w-3.5 rounded border-border-subtle"
                          />
                        ) : null}
                        <p className={cn('truncate text-xs', isActive ? 'font-medium text-foreground' : 'text-foreground/80')}>
                          {entry.title || 'Untitled'}
                        </p>
                        <span className="ml-auto text-[11px] tabular-nums text-foreground/35">
                          {formatRelativeNoteTime(entry.updatedAt)}
                        </span>
                      </div>
                      {preview ? <p className="mt-0.5 line-clamp-1 text-[11px] text-foreground/45">{preview}</p> : null}
                    </button>
                  )
                })
              )}

              {canLoadMoreNotes ? (
                <Button
                  variant="ghost"
                  size="sm"
                  className="mt-1 h-7 w-full text-[11px]"
                  onClick={() => {
                    setNotesVisibleLimit((current) => current + MAX_NOTES_EXPANDED_COUNT)
                  }}
                >
                  Load more notes
                </Button>
              ) : null}
            </div>
          </div>

          {bulkModeEnabled ? (
            <div className="space-y-2 border-t border-border-subtle px-3 py-2">
              <p className="text-[11px] text-muted-foreground">Selected: {selectedNoteIds.length}</p>
              <div className="flex items-center gap-1.5">
                <select
                  className="app-no-drag h-7 flex-1 rounded-md border border-border-subtle bg-surface-0 px-2 text-[11px]"
                  value={bulkTargetFolderId}
                  onChange={(event) => {
                    setBulkTargetFolderId(event.target.value)
                  }}
                >
                  <option value="">Move to Uncategorized</option>
                  {folders.map((folder) => (
                    <option key={folder.id} value={folder.id}>
                      {folder.name}
                    </option>
                  ))}
                </select>
                <Button
                  size="sm"
                  variant="outline"
                  className="h-7"
                  disabled={selectedNoteIds.length === 0}
                  onClick={() => {
                    for (const noteId of selectedNoteIds) {
                      onUpdateNote(noteId, {
                        folderId: bulkTargetFolderId || null,
                      })
                    }
                    setSelectedNoteIds([])
                  }}
                >
                  Move
                </Button>
                <Button
                  size="sm"
                  variant="outline"
                  className="h-7"
                  disabled={selectedNoteIds.length === 0 || !activeAction}
                  onClick={() => {
                    for (const noteId of selectedNoteIds) {
                      onRunNoteAction(noteId, activeAction?.id ?? null)
                    }
                  }}
                >
                  Enhance
                </Button>
                <Button
                  size="sm"
                  variant="destructive"
                  className="h-7"
                  disabled={selectedNoteIds.length === 0}
                  onClick={() => {
                    for (const noteId of selectedNoteIds) {
                      onDeleteNote(noteId)
                    }
                    setSelectedNoteIds([])
                  }}
                >
                  Delete
                </Button>
              </div>
            </div>
          ) : null}
        </div>
      </aside>

      <section className="relative flex min-w-0 flex-1 flex-col">
        {!activeNote ? (
          <div className="flex h-full flex-col items-center justify-center px-6 text-center">
            <BookOpen className="h-7 w-7 text-foreground/30" />
            <p className="mt-3 text-sm font-medium text-foreground/70">Pick a note to start editing</p>
            <p className="mt-1 text-xs text-foreground/40">Create one from the left panel if this folder is empty.</p>
          </div>
        ) : (
          <>
            <div className="px-6 pb-2 pt-6">
              <div className="flex min-w-0 items-start justify-between gap-3">
                <Input
                  value={activeNote.title}
                  onChange={(event) => {
                    onUpdateNote(activeNote.id, {
                      title: event.target.value,
                    })
                  }}
                  onKeyDown={(event) => {
                    const isSaveShortcut = (event.ctrlKey || event.metaKey) && event.key.toLowerCase() === 's'
                    if (isSaveShortcut) {
                      event.preventDefault()
                      onForceSaveNote(activeNote.id)
                    }

                    event.stopPropagation()
                  }}
                  placeholder="Untitled Note"
                  className="h-auto min-w-0 flex-1 border-none bg-transparent px-0 text-[30px] font-semibold leading-tight tracking-[-0.02em] text-foreground shadow-none focus-visible:ring-0"
                />
                <div className="shrink-0 flex items-center gap-1">
                  <Button
                    variant="ghost"
                    size="icon"
                    className="h-7 w-7 text-foreground/45 hover:bg-surface-2 hover:text-foreground"
                    title="Regenerate note title"
                    onClick={() => {
                      const sourceText = (activeNote.processedText || activeNote.rawText).trim()
                      const generatedTitle = generateNoteTitleFromContent(sourceText)
                      onUpdateNote(activeNote.id, {
                        title: generatedTitle,
                        autoTitleGenerated: true,
                      })
                    }}
                  >
                    <RotateCcw className="h-3.5 w-3.5" />
                  </Button>
                  <Button
                    variant="ghost"
                    size="icon"
                    className="h-7 w-7 text-foreground/45 hover:bg-surface-2 hover:text-foreground"
                    onClick={() => {
                      onDeleteNote(activeNote.id)
                    }}
                  >
                    <Trash2 className="h-3.5 w-3.5" />
                  </Button>
                  <Button
                    variant="ghost"
                    size="icon"
                    className="h-7 w-7 text-foreground/45 hover:bg-surface-2 hover:text-foreground"
                    onClick={(event) => {
                      if (exportMenuOpen) {
                        setExportMenuOpen(false)
                        return
                      }

                      openExportMenu(event.currentTarget)
                    }}
                    title="Export note"
                  >
                    <Download className="h-3.5 w-3.5" />
                  </Button>
                </div>
              </div>
              <div className="mt-1 flex flex-wrap items-center gap-2 text-xs text-foreground/45">
                <span>Created {formatTimestamp(activeNote.createdAt)}</span>
                <span>&middot;</span>
                <span>{noteComparedWordsLabel}</span>
                <span>&middot;</span>
                <span>{noteComparedTokensLabel}</span>
                <span>&middot;</span>
                <span>{noteSpentLabel}</span>
                <button
                  type="button"
                  className="app-no-drag inline-flex h-4 w-4 items-center justify-center rounded-full border border-border-subtle text-[10px] text-foreground/60 transition-colors hover:bg-surface-2 hover:text-foreground"
                  title="Cost reflects processed Enhanced output only. Raw draft-only notes are not counted as spent usage."
                  onClick={() => {
                    pushToast({
                      title: 'Enhanced spend summary',
                      description: `Raw/Enhanced compare uses this note and model ${postProcessingModelForEstimate}. Displayed value counts only processed enhanced text.`,
                    })
                  }}
                >
                  i
                </button>
              </div>

              <div className="mt-2 flex flex-wrap items-center gap-2">
                <select
                  className="app-no-drag h-7 rounded-md border border-border-subtle bg-surface-1 px-2 text-[11px] text-foreground/80"
                  value={activeNote.folderId ?? ''}
                  onChange={(event) => {
                    const nextFolderId = event.target.value.trim()
                    onUpdateNote(activeNote.id, {
                      folderId: nextFolderId.length > 0 ? nextFolderId : null,
                    })
                  }}
                >
                  <option value="">Uncategorized</option>
                  {folders.map((folder) => (
                    <option key={folder.id} value={folder.id}>
                      {folder.name}
                    </option>
                  ))}
                </select>

                <div className="inline-flex rounded-md border border-border-subtle bg-surface-1 p-0.5">
                  <button
                    type="button"
                    className={cn(
                      'rounded px-2 py-1 text-[11px] transition-colors',
                      viewMode === 'raw' ? 'bg-surface-2 text-foreground' : 'text-foreground/60 hover:text-foreground',
                    )}
                    onClick={() => {
                      setViewMode('raw')
                    }}
                  >
                    Raw
                  </button>
                  <button
                    type="button"
                    className={cn(
                      'rounded px-2 py-1 text-[11px] transition-colors',
                      viewMode === 'processed'
                        ? 'bg-surface-2 text-foreground'
                        : activeNote.processedText.trim()
                          ? 'text-foreground/60 hover:text-foreground'
                          : 'cursor-not-allowed text-foreground/35',
                    )}
                    disabled={!activeNote.processedText.trim()}
                    onClick={() => {
                      setViewMode('processed')
                    }}
                  >
                    Enhanced
                  </button>
                  <button
                    type="button"
                    className={cn(
                      'rounded px-2 py-1 text-[11px] transition-colors',
                      viewMode === 'preview' ? 'bg-surface-2 text-foreground' : 'text-foreground/60 hover:text-foreground',
                    )}
                    onClick={() => {
                      setViewMode('preview')
                    }}
                  >
                    Preview
                  </button>
                </div>
              </div>

              <div className="mt-2 flex flex-wrap items-center gap-1.5 rounded-md border border-border-subtle bg-surface-1 px-2 py-1.5">
                {markdownToolbarItems.map((item) => (
                  <button
                    key={item.id}
                    type="button"
                    className="app-no-drag inline-flex h-7 w-7 items-center justify-center rounded-md text-foreground/65 transition-colors hover:bg-surface-2 hover:text-foreground disabled:cursor-not-allowed disabled:opacity-40"
                    onClick={item.onClick}
                    disabled={markdownCommandsDisabled}
                    title={item.label}
                  >
                    {item.icon}
                  </button>
                ))}

                <button
                  type="button"
                  className="app-no-drag inline-flex h-7 items-center gap-1 rounded-md border border-border-subtle px-2 text-[11px] text-foreground/70 transition-colors hover:bg-surface-2 hover:text-foreground disabled:cursor-not-allowed disabled:opacity-40"
                  disabled={markdownCommandsDisabled}
                  onClick={(event) => {
                    event.preventDefault()
                    event.stopPropagation()

                    if (markdownMenuOpen) {
                      setMarkdownMenuOpen(false)
                      return
                    }

                    openMarkdownMenu(event.currentTarget)
                  }}
                >
                  More
                  <ChevronDown className="h-3 w-3" />
                </button>
              </div>
            </div>

            <div className="flex min-h-0 flex-1 flex-col gap-3 pl-3 pr-0 pt-2">
              <div className="min-h-0 flex-1 overflow-hidden">
                {viewMode === 'preview' ? (
                  <div className="h-full min-h-0 overflow-hidden rounded-xl border border-border-subtle bg-surface-0/70">
                    <div className="h-full overflow-y-auto px-5 py-4 pr-12 [scrollbar-width:thin]">
                      <MarkdownPreview
                        source={activeEditorValue || '*Nothing to preview yet.*'}
                        remarkPlugins={[remarkGfm]}
                        rehypePlugins={[rehypeRaw]}
                        wrapperElement={{
                          'data-color-mode': settings.theme === 'dark' ? 'dark' : 'light',
                        }}
                        style={{
                          backgroundColor: 'transparent',
                          color: 'inherit',
                          boxShadow: 'none',
                          margin: 0,
                          padding: 0,
                          minHeight: '100%',
                          fontSize: '15px',
                          lineHeight: 1.6,
                        }}
                      />
                    </div>
                  </div>
                ) : (
                  <Textarea
                    ref={editorTextareaRef}
                    className="h-full min-h-0 resize-none rounded-xl border border-border-subtle bg-surface-0/70 px-5 py-4 pr-12 text-[15px] leading-6 text-foreground/85 shadow-none focus-visible:border-primary/45 focus-visible:ring-2 focus-visible:ring-primary/15"
                    value={activeEditorValue}
                    onChange={(event) => {
                      updateActiveEditorValue(event.target.value)
                      reportActiveRawCaret(event.currentTarget)
                    }}
                    onClick={(event) => {
                      reportActiveRawCaret(event.currentTarget)
                    }}
                    onSelect={(event) => {
                      reportActiveRawCaret(event.currentTarget)
                    }}
                    onKeyUp={(event) => {
                      reportActiveRawCaret(event.currentTarget)
                    }}
                    onFocus={(event) => {
                      reportActiveRawCaret(event.currentTarget)
                    }}
                    onKeyDown={(event) => {
                      const isSaveShortcut = (event.ctrlKey || event.metaKey) && event.key.toLowerCase() === 's'
                      if (isSaveShortcut) {
                        event.preventDefault()
                        onForceSaveNote(activeNote.id)
                      }

                      event.stopPropagation()
                    }}
                    placeholder={
                      viewMode === 'processed' && !activeNote.processedText.trim()
                        ? 'Run an action to generate an enhanced version.'
                        : 'Start writing in Markdown...'
                    }
                    disabled={viewMode === 'processed' && !activeNote.processedText.trim()}
                  />
                )}
              </div>

              <div className="flex flex-wrap items-center justify-center gap-2 pb-5">
                <Button
                  variant="outline"
                  className="h-11 rounded-xl border-primary/30 bg-primary/10 px-5 text-primary hover:bg-primary/15"
                  onClick={() => {
                    onTranscribeNote(activeNote.id)
                  }}
                  disabled={
                    (transcribingNoteId !== null && transcribingNoteId !== activeNote.id) ||
                    isTranscribingActiveNote
                  }
                >
                  <Mic className="mr-1.5 h-3.5 w-3.5" />
                  {isRecordingActiveNote
                    ? `Stop (${formatDurationCompact(recordingElapsedSeconds)})`
                    : isTranscribingActiveNote
                      ? 'Transcribing...'
                      : 'Transcribe'}
                </Button>

                <div className="relative inline-flex">
                  <button
                    type="button"
                    aria-label="Run selected note action"
                    className="app-no-drag inline-flex h-11 items-center gap-2 rounded-xl border border-border-subtle bg-surface-1 pl-5 pr-12 text-sm text-foreground/80 transition-colors hover:bg-surface-2 disabled:pointer-events-none disabled:opacity-50"
                    onClick={() => {
                      if (!activeAction) {
                        return
                      }

                      handleRunAction(activeAction)
                    }}
                    disabled={!postProcessingEnabled || postProcessingNoteId === activeNote.id || !activeNote.rawText.trim() || !activeAction}
                  >
                    <Sparkles className="h-3.5 w-3.5" />
                    <span className="truncate">
                      {!postProcessingEnabled
                        ? 'Post-processing disabled'
                        : postProcessingNoteId === activeNote.id
                          ? 'Processing...'
                          : activeAction?.name ?? 'Clean Up Notes'}
                    </span>
                  </button>

                  <button
                    type="button"
                    aria-label="Open note actions menu"
                    className="app-no-drag absolute right-0 top-0 inline-flex h-11 w-10 items-center justify-center rounded-r-xl border-l border-border-subtle bg-surface-2/70 text-foreground/70 transition-colors hover:bg-surface-2 disabled:pointer-events-none disabled:opacity-50"
                    onPointerDown={(event) => {
                      event.stopPropagation()
                    }}
                    onClick={(event) => {
                      event.preventDefault()
                      event.stopPropagation()

                      if (actionsMenuOpen) {
                        setActionsMenuOpen(false)
                        return
                      }

                      openActionsMenu(event.currentTarget)
                    }}
                    disabled={!postProcessingEnabled || postProcessingNoteId === activeNote.id || !activeNote.rawText.trim()}
                  >
                    <ChevronDown className="h-3.5 w-3.5 opacity-70" />
                  </button>
                </div>
              </div>
            </div>

            <Dropdown
              open={actionsMenuOpen}
              anchor={actionsMenuAnchor}
              onClose={() => {
                setActionsMenuOpen(false)
              }}
              items={actionMenuItems}
            />

            <Dropdown
              open={exportMenuOpen}
              anchor={exportMenuAnchor}
              onClose={() => {
                setExportMenuOpen(false)
              }}
              items={exportMenuItems}
            />

            <Dropdown
              open={markdownMenuOpen}
              anchor={markdownMenuAnchor}
              onClose={() => {
                setMarkdownMenuOpen(false)
              }}
              items={markdownMenuItems}
            />

              <Dialog
                open={actionManagerOpen}
                onOpenChange={(open) => {
                  setActionManagerOpen(open)
                  if (!open) {
                    resetActionEditor()
                  }
                }}
              >
                <DialogContent>
                  <DialogHeader>
                    <DialogTitle>Manage Actions</DialogTitle>
                    <DialogDescription>
                      Add, edit, or remove custom note actions.
                    </DialogDescription>
                  </DialogHeader>

                  <div className="space-y-3">
                    <div className="space-y-1.5">
                      <p className="text-sm font-medium">Action name</p>
                      <Input
                        value={customActionName}
                        onChange={(event) => {
                          setCustomActionName(event.target.value)
                        }}
                        placeholder="Ex: Meeting summary"
                        autoFocus
                      />
                    </div>

                    <div className="space-y-1.5">
                      <p className="text-sm font-medium">Description</p>
                      <Input
                        value={customActionDescription}
                        onChange={(event) => {
                          setCustomActionDescription(event.target.value)
                        }}
                        placeholder="Ex: Fix grammar and structure"
                      />
                    </div>

                    <div className="space-y-1.5">
                      <p className="text-sm font-medium">Instructions</p>
                      <Textarea
                        value={customActionInstructions}
                        onChange={(event) => {
                          setCustomActionInstructions(event.target.value)
                        }}
                        placeholder="Describe what this action should do..."
                        className="min-h-32"
                      />
                    </div>
                  </div>

                  <DialogFooter>
                    {editingActionId ? (
                      <Button variant="ghost" onClick={resetActionEditor}>
                        Cancel
                      </Button>
                    ) : null}
                    <Button
                      onClick={commitCustomAction}
                      disabled={!customActionName.trim() || !customActionInstructions.trim()}
                    >
                      {editingActionId ? 'Update action' : 'Save action'}
                    </Button>
                  </DialogFooter>

                  <div className="border-t border-border-subtle pt-3">
                    {actions.length === 0 ? (
                      <p className="py-2 text-center text-xs text-muted-foreground">No actions available.</p>
                    ) : (
                      <div className="max-h-52 space-y-1 overflow-y-auto">
                        {actions.map((action) => (
                          <div
                            key={action.id}
                            className="group flex items-center gap-2 rounded-md px-2 py-1.5 hover:bg-surface-2"
                          >
                            <Sparkles className="h-3.5 w-3.5 shrink-0 text-foreground/45" />
                            <div className="min-w-0 flex-1">
                              <div className="flex items-center gap-1.5">
                                <span className="truncate text-xs font-medium">{action.name}</span>
                                {action.isBuiltIn ? (
                                  <span className="rounded bg-surface-2 px-1.5 py-px text-[10px] text-muted-foreground">
                                    Built-in
                                  </span>
                                ) : null}
                              </div>
                              {action.description ? (
                                <p className="truncate text-[11px] text-muted-foreground">{action.description}</p>
                              ) : null}
                            </div>

                            <div className="flex items-center gap-1 opacity-0 transition-opacity group-hover:opacity-100">
                              <Button
                                variant="ghost"
                                size="icon"
                                className="h-6 w-6"
                                onClick={() => {
                                  setEditingActionId(action.id)
                                  setCustomActionName(action.name)
                                  setCustomActionDescription(action.description)
                                  setCustomActionInstructions(action.instructions)
                                }}
                              >
                                <Pencil className="h-3.5 w-3.5" />
                              </Button>
                              {!action.isBuiltIn ? (
                                <Button
                                  variant="ghost"
                                  size="icon"
                                  className="h-6 w-6 text-destructive hover:bg-destructive/10 hover:text-destructive"
                                  onClick={() => {
                                    onDeleteNoteAction(action.id)
                                    if (editingActionId === action.id) {
                                      resetActionEditor()
                                    }
                                  }}
                                >
                                  <Trash2 className="h-3.5 w-3.5" />
                                </Button>
                              ) : null}
                            </div>
                          </div>
                        ))}
                      </div>
                    )}
                  </div>
                </DialogContent>
              </Dialog>
          </>
        )}
      </section>
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

        <div className="flex items-center justify-between rounded-md border border-border-subtle bg-surface-0 px-3 py-2.5">
          <div>
            <p className="text-sm">Enable post-processing</p>
            <p className="text-xs text-muted-foreground">
              Disable to keep raw dictation output without LLM cleanup or enhancement costs.
            </p>
          </div>
          <Switch
            checked={settings.postProcessingEnabled}
            onCheckedChange={(checked) => {
              onChange({ postProcessingEnabled: checked })
            }}
          />
        </div>

        <div className="space-y-2 rounded-md border border-border-subtle bg-surface-0 px-3 py-2.5">
          <div className="flex items-center justify-between gap-3">
            <div>
              <p className="text-sm">Show microphone badge</p>
              <p className="text-xs text-muted-foreground">Show CPU/CUDA mode with RAM and VRAM usage on the floating mic.</p>
            </div>
            <Switch
              checked={settings.overlayRuntimeBadgeEnabled}
              onCheckedChange={(checked) => {
                onChange({ overlayRuntimeBadgeEnabled: checked })
              }}
            />
          </div>

          <div className="flex items-center justify-between gap-3 rounded-md border border-border-subtle bg-surface-1/70 px-2.5 py-2">
            <div>
              <p className="text-xs font-medium">Show only while dictating</p>
              <p className="text-[11px] text-muted-foreground">When enabled, the badge appears only during recording/processing.</p>
            </div>
            <Switch
              checked={settings.overlayRuntimeBadgeOnlyOnUse}
              disabled={!settings.overlayRuntimeBadgeEnabled}
              onCheckedChange={(checked) => {
                onChange({ overlayRuntimeBadgeOnlyOnUse: checked })
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

          <div className="grid gap-2 md:grid-cols-2">
            <div className="rounded-md border border-border-subtle bg-surface-1/70 px-2.5 py-2">
              <p className="mb-1 text-[11px] font-semibold uppercase tracking-wide text-muted-foreground">Paste shortcut</p>
              <select
                className="app-no-drag h-8 w-full rounded-[var(--radius-premium)] border border-border-subtle bg-surface-0 px-2 text-xs"
                value={settings.autoPasteShortcut}
                onChange={(event) => {
                  onChange({ autoPasteShortcut: event.target.value as AppSettings['autoPasteShortcut'] })
                }}
              >
                <option value="ctrl-v">Ctrl+V</option>
                <option value="ctrl-shift-v">Ctrl+Shift+V (terminals)</option>
                <option value="auto">Auto-detect</option>
              </select>
              <p className="mt-1 text-[11px] text-muted-foreground">
                Auto-detect uses Ctrl+Shift+V for terminals and Ctrl+V for everything else.
              </p>
            </div>
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
              <p className="mt-1 text-xs">Your compositor ({compositorName}) does not support wtype. Use ydotool instead.</p>
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

interface SpendingLimitsSectionProps {
  settings: AppSettings
  onChange: (next: Partial<AppSettings>) => void
}

const SpendingLimitsSection = ({ settings, onChange }: SpendingLimitsSectionProps) => {
  const activeCloudProviders = new Set<string>()
  if (settings.transcriptionRuntime === 'cloud') {
    activeCloudProviders.add(settings.transcriptionCloudProvider)
  }
  if (settings.postProcessingRuntime === 'cloud') {
    activeCloudProviders.add(settings.postProcessingCloudProvider)
  }

  const limitRows: Array<{
    providerId: 'openai' | 'groq' | 'grok' | 'custom'
    label: string
    field: 'spendingLimitOpenAIUSD' | 'spendingLimitGroqUSD' | 'spendingLimitGrokUSD' | 'spendingLimitCustomUSD'
  }> = [
    { providerId: 'openai', label: 'OpenAI', field: 'spendingLimitOpenAIUSD' },
    { providerId: 'groq', label: 'Groq', field: 'spendingLimitGroqUSD' },
    { providerId: 'grok', label: 'Grok (xAI)', field: 'spendingLimitGrokUSD' },
    { providerId: 'custom', label: 'Custom endpoint', field: 'spendingLimitCustomUSD' },
  ]

  return (
    <Card id="settings-node-spending-limits" className="scroll-mt-6">
      <CardHeader>
        <CardTitle>Spending limits</CardTitle>
        <CardDescription>Set monthly soft limits per provider. Set 0 to disable a provider limit.</CardDescription>
      </CardHeader>
      <CardContent className="space-y-3">
        {limitRows.map((row) => {
          const isActive = activeCloudProviders.has(row.providerId)
          const currentValue = settings[row.field]

          return (
            <div key={row.providerId} className="rounded-[var(--radius-premium)] border border-border-subtle bg-surface-0 p-3">
              <div className="mb-2 flex items-center justify-between gap-2">
                <p className="text-sm font-medium">{row.label}</p>
                <Badge tone={isActive ? 'success' : 'neutral'}>{isActive ? 'Active' : 'Inactive'}</Badge>
              </div>

              <div className="flex items-center gap-2">
                <span className="text-sm text-muted-foreground">$</span>
                <Input
                  type="number"
                  min={0}
                  step="0.01"
                  value={Number.isFinite(currentValue) ? String(currentValue) : '0'}
                  onChange={(event) => {
                    const parsed = Number.parseFloat(event.target.value)
                    onChange({
                      [row.field]: Number.isFinite(parsed) && parsed >= 0 ? parsed : 0,
                    } as Partial<AppSettings>)
                  }}
                  className="h-9"
                />
              </div>
              <p className="mt-1 text-[11px] text-muted-foreground">
                {isActive
                  ? 'Current runtime uses this provider. You can monitor usage in the sidebar.'
                  : 'Not currently selected in cloud runtime.'}
              </p>
            </div>
          )
        })}
      </CardContent>
    </Card>
  )
}

interface DetailedStatsLoggingSectionProps {
  settings: AppSettings
  dictationRows: DetailedStatsCallRow[]
  noteRows: DetailedStatsCallRow[]
  onChange: (next: Partial<AppSettings>) => void
  onClearLogs: () => void
}

const DetailedStatsLoggingSection = ({
  settings,
  dictationRows,
  noteRows,
  onChange,
  onClearLogs,
}: DetailedStatsLoggingSectionProps) => {
  const [activeStatsTab, setActiveStatsTab] = useState<DetailedStatsCategory>('dictations')
  const [selectedMonth, setSelectedMonth] = useState<string>('all')

  const combinedRows = useMemo(
    () => [...dictationRows, ...noteRows].sort((left, right) => right.timestamp - left.timestamp),
    [dictationRows, noteRows],
  )

  const activeRows =
    activeStatsTab === 'dictations' ? dictationRows : activeStatsTab === 'notes' ? noteRows : combinedRows

  const monthOptions = useMemo(() => {
    const counts = new Map<string, number>()
    for (const row of combinedRows) {
      const monthKey = toMonthKey(row.timestamp)
      counts.set(monthKey, (counts.get(monthKey) ?? 0) + 1)
    }

    return [...counts.entries()]
      .sort((left, right) => right[0].localeCompare(left[0]))
      .map(([monthKey, count]) => ({
        monthKey,
        label: `${formatMonthLabel(monthKey)} (${formatCount(count)})`,
      }))
  }, [combinedRows])

  useEffect(() => {
    if (selectedMonth === 'all') {
      return
    }

    if (!monthOptions.some((option) => option.monthKey === selectedMonth)) {
      setSelectedMonth('all')
    }
  }, [monthOptions, selectedMonth])

  const filteredRows = useMemo(() => {
    if (selectedMonth === 'all') {
      return activeRows
    }

    return activeRows.filter((row) => toMonthKey(row.timestamp) === selectedMonth)
  }, [activeRows, selectedMonth])

  const filteredTotals = useMemo(() => {
    return filteredRows.reduce(
      (accumulator, row) => {
        accumulator.durationSeconds += row.durationSeconds
        accumulator.words += row.words
        accumulator.tokens += row.tokens
        accumulator.transcriptionCostUSD += row.transcriptionCostUSD
        accumulator.postProcessingCostUSD += row.postProcessingCostUSD
        accumulator.totalCostUSD += row.totalCostUSD
        return accumulator
      },
      {
        durationSeconds: 0,
        words: 0,
        tokens: 0,
        transcriptionCostUSD: 0,
        postProcessingCostUSD: 0,
        totalCostUSD: 0,
      },
    )
  }, [filteredRows])

  const exportFilteredRows = () => {
    if (filteredRows.length === 0) {
      return
    }

    const csvHeader = [
      'timestamp',
      'source',
      'title',
      'provider',
      'model',
      'duration_seconds',
      'words',
      'tokens',
      'stt_cost_usd',
      'post_cost_usd',
      'total_cost_usd',
      'post_processing_applied',
      'post_provider',
      'post_model',
      'action_name',
      'estimated',
    ]

    const escapeCsv = (value: string | number | boolean) => {
      const stringified = String(value)
      if (stringified.includes('"') || stringified.includes(',') || stringified.includes('\n')) {
        return `"${stringified.replace(/"/g, '""')}"`
      }
      return stringified
    }

    const csvRows = filteredRows.map((row) => {
      return [
        new Date(row.timestamp).toISOString(),
        row.source,
        row.title,
        row.provider,
        row.model,
        row.durationSeconds.toFixed(2),
        row.words,
        row.tokens,
        row.transcriptionCostUSD.toFixed(6),
        row.postProcessingCostUSD.toFixed(6),
        row.totalCostUSD.toFixed(6),
        row.postProcessingApplied,
        row.postProcessingProvider,
        row.postProcessingModel,
        row.actionName ?? '',
        row.estimated,
      ]
        .map((value) => escapeCsv(value))
        .join(',')
    })

    const csvPayload = [csvHeader.join(','), ...csvRows].join('\n')
    const blob = new Blob([csvPayload], { type: 'text/csv;charset=utf-8' })
    const downloadUrl = URL.createObjectURL(blob)
    const link = document.createElement('a')
    const monthSuffix = selectedMonth === 'all' ? 'all-months' : selectedMonth
    link.href = downloadUrl
    link.download = `whispy-stats-${activeStatsTab}-${monthSuffix}.csv`
    document.body.appendChild(link)
    link.click()
    document.body.removeChild(link)
    URL.revokeObjectURL(downloadUrl)
  }

  return (
    <div className="space-y-3">
      <Card id="settings-node-stats-logs" className="scroll-mt-6">
        <CardHeader>
          <CardTitle>Detailed call stats</CardTitle>
          <CardDescription>
            Per-call logs for Dictations and Notes with month filters, compact rows, and export.
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-2">
          <div className="flex flex-wrap items-center gap-2 rounded-md border border-border-subtle bg-surface-0 px-3 py-2">
            <p className="text-sm">Detailed logs</p>
            <Switch
              checked={settings.detailedStatsLoggingEnabled}
              onCheckedChange={(checked) => {
                onChange({ detailedStatsLoggingEnabled: checked })
              }}
            />

            <Tabs
              value={activeStatsTab}
              onValueChange={(value) => {
                setActiveStatsTab(value as DetailedStatsCategory)
              }}
            >
              <TabsList className="grid h-8 grid-cols-3">
                <TabsTrigger value="dictations" className="text-xs">Dictations</TabsTrigger>
                <TabsTrigger value="notes" className="text-xs">Notes</TabsTrigger>
                <TabsTrigger value="combined" className="text-xs">Combined</TabsTrigger>
              </TabsList>
            </Tabs>

            <select
              className="app-no-drag h-8 rounded-md border border-border-subtle bg-surface-0 px-2 text-xs"
              value={selectedMonth}
              onChange={(event) => {
                setSelectedMonth(event.target.value)
              }}
            >
              <option value="all">All months ({formatCount(activeRows.length)})</option>
              {monthOptions.map((option) => (
                <option key={option.monthKey} value={option.monthKey}>
                  {option.label}
                </option>
              ))}
            </select>

            {filteredRows.length > 0 ? (
              <Button size="sm" variant="outline" onClick={exportFilteredRows}>
                <Download className="h-3.5 w-3.5" /> Export CSV
              </Button>
            ) : null}

            <Button variant="outline" size="sm" onClick={onClearLogs}>
              Clear note logs
            </Button>
          </div>

          <div className="rounded-md border border-border-subtle bg-surface-0 px-3 py-2 text-xs">
            <span className="font-semibold">Rows:</span> {formatCount(filteredRows.length)}{' '}
            <span className="font-semibold">| Duration:</span> {formatDurationCompact(filteredTotals.durationSeconds)}{' '}
            <span className="font-semibold">| Words:</span> {formatCount(filteredTotals.words)}{' '}
            <span className="font-semibold">| Tokens:</span> {formatCount(filteredTotals.tokens)}{' '}
            <span className="font-semibold">| STT:</span> {formatCurrency(filteredTotals.transcriptionCostUSD)}{' '}
            <span className="font-semibold">| Post:</span> {formatCurrency(filteredTotals.postProcessingCostUSD)}{' '}
            <span className="font-semibold">| Total:</span> {formatCurrency(filteredTotals.totalCostUSD)}
          </div>

          <div className="overflow-x-auto rounded-md border border-border-subtle bg-surface-0">
            <table className="w-full min-w-[1200px] text-left text-xs">
              <thead className="border-b border-border-subtle text-muted-foreground">
                <tr>
                  <th className="px-2 py-1.5 font-medium">Time</th>
                  <th className="px-2 py-1.5 font-medium">Type</th>
                  <th className="px-2 py-1.5 font-medium">Title/Action</th>
                  <th className="px-2 py-1.5 font-medium">Provider / Model</th>
                  <th className="px-2 py-1.5 font-medium">Duration</th>
                  <th className="px-2 py-1.5 font-medium">Words</th>
                  <th className="px-2 py-1.5 font-medium">Tokens</th>
                  <th className="px-2 py-1.5 font-medium">STT $</th>
                  <th className="px-2 py-1.5 font-medium">Post $</th>
                  <th className="px-2 py-1.5 font-medium">Total $</th>
                  <th className="px-2 py-1.5 font-medium">Post</th>
                </tr>
              </thead>
              <tbody>
                {filteredRows.length === 0 ? (
                  <tr>
                    <td className="px-2 py-2 text-muted-foreground" colSpan={11}>
                      No rows for this filter.
                    </td>
                  </tr>
                ) : (
                  filteredRows.map((row) => (
                    <tr key={row.id} className="border-b border-border-subtle/80 last:border-b-0">
                      <td className="px-2 py-1.5 text-muted-foreground">{formatTimestamp(row.timestamp)}</td>
                      <td className="px-2 py-1.5">{row.source === 'dictation' ? 'Dictation' : 'Note'}</td>
                      <td className="px-2 py-1.5">
                        <span className="block truncate max-w-[220px]" title={row.title}>
                          {row.title || 'Untitled'}
                        </span>
                        {row.actionName ? (
                          <span className="block text-[10px] text-muted-foreground">{row.actionName}</span>
                        ) : null}
                      </td>
                      <td className="px-2 py-1.5">
                        <span className="block truncate max-w-[260px]" title={`${row.provider}/${row.model}`}>
                          {row.provider}/{row.model}
                        </span>
                        {row.postProcessingApplied ? (
                          <span className="block text-[10px] text-muted-foreground" title={`${row.postProcessingProvider}/${row.postProcessingModel}`}>
                            post: {row.postProcessingProvider}/{row.postProcessingModel}
                          </span>
                        ) : null}
                      </td>
                      <td className="px-2 py-1.5 tabular-nums">{formatDurationCompact(row.durationSeconds)}</td>
                      <td className="px-2 py-1.5 tabular-nums">{formatCount(row.words)}</td>
                      <td className="px-2 py-1.5 tabular-nums">{formatCount(row.tokens)}</td>
                      <td className="px-2 py-1.5 tabular-nums">{formatCurrency(row.transcriptionCostUSD)}</td>
                      <td className="px-2 py-1.5 tabular-nums">{formatCurrency(row.postProcessingCostUSD)}</td>
                      <td className="px-2 py-1.5 tabular-nums font-semibold">{formatCurrency(row.totalCostUSD)}</td>
                      <td className="px-2 py-1.5 text-muted-foreground">
                        {row.postProcessingApplied ? 'yes' : 'no'}
                        {row.estimated ? ' (est)' : ''}
                      </td>
                    </tr>
                  ))
                )}
              </tbody>
            </table>
          </div>
        </CardContent>
      </Card>
    </div>
  )
}

const FaqSection = () => {
  const entries = [
    {
      question: 'How are costs calculated in this app?',
      answer:
        'Whispy uses token counts from your content and model prices from the LiteLLM pricing catalog. Dictation and notes values are estimates, but notes spend counts only processed Enhanced output.',
    },
    {
      question: 'Why can estimates differ from provider billing?',
      answer:
        'Providers can tokenize text differently and some transcription models bill by audio minute. Whispy keeps practical estimates for visibility and marks pricing source status clearly.',
    },
    {
      question: 'What does "N/A time" mean in Dictations?',
      answer:
        'Older history entries may not include recording duration metadata. In that case, entry-level time is shown as N/A, while aggregate time can still use a words-per-minute fallback estimate.',
    },
    {
      question: 'What does Recorded time mean in Dictations stats?',
      answer:
        'It is total captured dictation duration. If a session has no explicit duration, Whispy estimates from transcript length to keep totals readable.',
    },
    {
      question: 'How should I read words and tokens in Dictations?',
      answer:
        'Words are human-readable transcript length. Tokens are model-oriented units used for pricing estimates. The line format is: language | provider/model | time | words | tokens | estimated cost.',
    },
    {
      question: 'How should I read Notes stats?',
      answer:
        'Notes stats are focused on Enhanced output: how many notes are processed, how many enhanced words/tokens were produced, and how many notes are still draft-only.',
    },
    {
      question: 'Why does Notes estimate ignore draft-only notes?',
      answer:
        'To avoid misleading totals, draft notes are not counted as spent usage. Only notes with Enhanced output are included in notes spend and overall spend.',
    },
    {
      question: 'Can I disable post-processing completely?',
      answer:
        'Yes. In Settings > Models > Post-processing toggle, switch it off. Dictations will return raw transcript text, and note enhancement actions are bypassed until you enable it again.',
    },
    {
      question: 'Why do I see N/A in Notes stats when post-processing is disabled?',
      answer:
        'When post-processing is disabled, new enhancement spend is marked as N/A by design. Historical enhanced spend is still shown separately so your budget history remains visible.',
    },
    {
      question: 'What does Overall $ used include?',
      answer:
        'Overall combines dictation estimate plus notes enhanced spend currently tracked in your app state. It is intended for practical monitoring, not invoice-level reconciliation.',
    },
    {
      question: 'What do pricing source colors mean?',
      answer:
        'Green means live pricing data, yellow means cached pricing data, red means pricing source unavailable. If unavailable, values may be partial or fallback-based.',
    },
    {
      question: 'How often is pricing data refreshed?',
      answer:
        'Pricing data is cached and reused for performance, then refreshed on demand (Refresh button) or when cache expires. This prevents noisy network calls and improves responsiveness.',
    },
    {
      question: 'Which paste shortcut should I use?',
      answer:
        'Use Ctrl+V for standard editors. Use Ctrl+Shift+V for terminals and apps that expect plain-text paste. You can switch this in Preferences at any time.',
    },
    {
      question: 'How do I set up ydotool if auto-paste fails?',
      answer:
        'Whispy tries to start ydotoold automatically. If permissions are blocked, run ydotoold with a user-owned socket and set YDOTOOL_SOCKET before launching Whispy. Example: ydotoold --socket-path="$XDG_RUNTIME_DIR/.ydotool_socket" --socket-perm=0600 & then export YDOTOOL_SOCKET="$XDG_RUNTIME_DIR/.ydotool_socket".',
    },
    {
      question: 'When are local models loaded?',
      answer:
        'Local models are loaded only when local runtime is active. Switching back to cloud stops local server processes so RAM/VRAM is released after process shutdown.',
    },
    {
      question: 'Why can model scan fail for some providers?',
      answer:
        'Some providers do not expose a standard models listing endpoint for your key or plan. Whispy handles these gracefully and avoids repeated noisy scan errors where possible.',
    },
    {
      question: 'How do spending limits work?',
      answer:
        'Spending Limits are soft limits per provider for awareness and budget planning. They currently do not hard-block API traffic automatically.',
    },
    {
      question: 'Where is my data stored?',
      answer:
        'Settings and history are stored in app data; notes are stored as markdown files with metadata indexes. Secret values are handled via keyring/.env fallback based on platform support.',
    },
  ]

  return (
    <Card id="settings-node-faq" className="scroll-mt-6">
      <CardHeader>
        <CardTitle>FAQ</CardTitle>
        <CardDescription>
          Practical answers for pricing, dictation metrics, notes behavior, runtime modes, and paste workflows.
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-3">
        {entries.map((entry) => (
          <div key={entry.question} className="rounded-[var(--radius-premium)] border border-border-subtle bg-surface-0 p-3">
            <p className="text-sm font-semibold text-foreground">{entry.question}</p>
            <p className="mt-1 text-sm text-muted-foreground">{entry.answer}</p>
          </div>
        ))}
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

interface CloudModelOption {
  id: string
  label: string
  recommended?: boolean
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
  const { t } = useI18n()
  const [customTranscriptionModelScanLoading, setCustomTranscriptionModelScanLoading] = useState(false)
  const [customPostModelScanLoading, setCustomPostModelScanLoading] = useState(false)
  const [customTranscriptionModelScanError, setCustomTranscriptionModelScanError] = useState<string | null>(null)
  const [customPostModelScanError, setCustomPostModelScanError] = useState<string | null>(null)
  const [customTranscriptionScannedModels, setCustomTranscriptionScannedModels] = useState<string[]>([])
  const [customPostScannedModels, setCustomPostScannedModels] = useState<string[]>([])
  const [transcriptionCloudModelLayout, setTranscriptionCloudModelLayout] = useState<'single' | 'double'>('double')
  const [showAllTranscriptionCloudModels, setShowAllTranscriptionCloudModels] = useState(false)
  const [showAllPostCloudModels, setShowAllPostCloudModels] = useState(false)
  const [transcriptionScannedModelsByProvider, setTranscriptionScannedModelsByProvider] = useState<Record<string, string[]>>({})
  const [postScannedModelsByProvider, setPostScannedModelsByProvider] = useState<Record<string, string[]>>({})
  const [transcriptionProviderAutoScanLoading, setTranscriptionProviderAutoScanLoading] = useState(false)
  const [postProviderAutoScanLoading, setPostProviderAutoScanLoading] = useState(false)
  const [transcriptionProviderAutoScanError, setTranscriptionProviderAutoScanError] = useState<string | null>(null)
  const [postProviderAutoScanError, setPostProviderAutoScanError] = useState<string | null>(null)
  const [whisperRuntimeStatus, setWhisperRuntimeStatus] = useState<WhisperRuntimeStatusPayload | null>(null)
  const [whisperRuntimeDiagnostics, setWhisperRuntimeDiagnostics] = useState<WhisperRuntimeDiagnosticsPayload | null>(null)
  const [whisperRuntimeDiagnosticsLoading, setWhisperRuntimeDiagnosticsLoading] = useState(false)
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

  const recommendedTranscriptionModelIdSet = new Set(
    selectedTranscriptionProvider.models
      .filter((model) => ('recommended' in model ? Boolean(model.recommended) : false))
      .map((model) => model.id.toLowerCase()),
  )

  const recommendedPostModelIdSet = new Set(
    selectedPostProcessingProvider.models
      .filter((model) => ('recommended' in model ? Boolean(model.recommended) : false))
      .map((model) => model.id.toLowerCase()),
  )

  const transcriptionModelsEndpoint = deriveModelsEndpointFromBaseUrl(settings.transcriptionCustomBaseUrl)
  const postProcessingModelsEndpoint = deriveModelsEndpointFromBaseUrl(settings.postProcessingCustomBaseUrl)

  const baseTranscriptionCloudModels: CloudModelOption[] =
    selectedTranscriptionProvider.providerId === 'custom'
      ? []
      : (transcriptionScannedModelsByProvider[selectedTranscriptionProvider.providerId]?.map((modelId) => ({
          id: modelId,
          label: modelId,
          recommended: recommendedTranscriptionModelIdSet.has(modelId.toLowerCase()),
        })) ??
          selectedTranscriptionProvider.models)

  const basePostCloudModels: CloudModelOption[] =
    selectedPostProcessingProvider.providerId === 'custom'
      ? []
      : (postScannedModelsByProvider[selectedPostProcessingProvider.providerId]?.map((modelId) => ({
          id: modelId,
          label: modelId,
          recommended: recommendedPostModelIdSet.has(modelId.toLowerCase()),
        })) ??
          selectedPostProcessingProvider.models)

  const transcriptionCapableCloudModels = baseTranscriptionCloudModels.filter((model) =>
    isTranscriptionCapableModelId(model.id),
  )
  const recommendedTranscriptionCloudModels = transcriptionCapableCloudModels.filter((model) => model.recommended)
  const hiddenRecommendedTranscriptionModelIdSet = new Set(
    recommendedTranscriptionCloudModels.map((model) => model.id.toLowerCase()),
  )
  hiddenRecommendedTranscriptionModelIdSet.add(settings.transcriptionCloudModelId.toLowerCase())

  const displayedTranscriptionCloudModels =
    showAllTranscriptionCloudModels || recommendedTranscriptionCloudModels.length === 0
      ? transcriptionCapableCloudModels
      : transcriptionCapableCloudModels.filter((model) => hiddenRecommendedTranscriptionModelIdSet.has(model.id.toLowerCase()))

  const canShowAllTranscriptionCloudModels =
    !showAllTranscriptionCloudModels &&
    recommendedTranscriptionCloudModels.length > 0 &&
    transcriptionCapableCloudModels.length > displayedTranscriptionCloudModels.length

  const postLlmCloudModels = basePostCloudModels.filter((model) => isPostProcessingLlmModelId(model.id))
  const recommendedPostCloudModels = postLlmCloudModels.filter((model) => model.recommended)
  const hiddenRecommendedPostModelIdSet = new Set(recommendedPostCloudModels.map((model) => model.id.toLowerCase()))
  hiddenRecommendedPostModelIdSet.add(settings.postProcessingCloudModelId.toLowerCase())

  const displayedPostCloudModels =
    showAllPostCloudModels || recommendedPostCloudModels.length === 0
      ? postLlmCloudModels
      : postLlmCloudModels.filter((model) => hiddenRecommendedPostModelIdSet.has(model.id.toLowerCase()))

  const canShowAllPostCloudModels =
    !showAllPostCloudModels &&
    recommendedPostCloudModels.length > 0 &&
    postLlmCloudModels.length > displayedPostCloudModels.length

  const transcriptionModelGridClass =
    transcriptionCloudModelLayout === 'single'
      ? 'grid gap-2 grid-cols-1'
      : 'grid gap-2 grid-cols-1 md:grid-cols-2'

  useEffect(() => {
    setShowAllTranscriptionCloudModels(false)
  }, [selectedTranscriptionProvider.providerId])

  useEffect(() => {
    setShowAllPostCloudModels(false)
  }, [selectedPostProcessingProvider.providerId])

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

    const status = await electronAPI.getWhisperRuntimeStatus()
    setWhisperRuntimeStatus(status)
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
      if (providerId === 'grok') {
        return
      }

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
        const filteredModelIds =
          scopeKey === 'transcription'
            ? modelIds.filter((modelId) => isTranscriptionCapableModelId(modelId))
            : modelIds.filter((modelId) => isPostProcessingLlmModelId(modelId))

        if (filteredModelIds.length === 0) {
          throw new Error(
            scopeKey === 'transcription'
              ? 'No speech/transcription-capable models were found for this provider.'
              : 'No LLM-capable models were found for this provider.',
          )
        }

        if (scopeKey === 'transcription') {
          setTranscriptionScannedModelsByProvider((current) => ({
            ...current,
            [providerId]: filteredModelIds,
          }))

          if (!filteredModelIds.includes(settings.transcriptionCloudModelId) && filteredModelIds[0]) {
            onSettingsChange({
              transcriptionCloudModelId: filteredModelIds[0],
            })
          }
        } else {
          setPostScannedModelsByProvider((current) => ({
            ...current,
            [providerId]: filteredModelIds,
          }))

          if (!filteredModelIds.includes(settings.postProcessingCloudModelId) && filteredModelIds[0]) {
            onSettingsChange({
              postProcessingCloudModelId: filteredModelIds[0],
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
      const filteredModelIds = modelIds.filter((modelId) => isTranscriptionCapableModelId(modelId))

      if (filteredModelIds.length === 0) {
        throw new Error('No speech/transcription-capable models found from this endpoint.')
      }

      setCustomTranscriptionScannedModels(filteredModelIds)

      if (!settings.transcriptionCustomModel.trim() && filteredModelIds[0]) {
        onSettingsChange({
          transcriptionCustomModel: filteredModelIds[0],
          transcriptionCloudModelId: filteredModelIds[0],
        })
      }

      pushToast({
        title: 'Custom STT models fetched',
        description: `${filteredModelIds.length} model${filteredModelIds.length > 1 ? 's' : ''} discovered.`,
        variant: 'success',
      })
    } catch (error: unknown) {
      setCustomTranscriptionScannedModels([])
      const message = error instanceof Error ? error.message : CUSTOM_MODEL_FETCH_ERROR
      setCustomTranscriptionModelScanError(`${message} Endpoint: ${transcriptionModelsEndpoint}`)
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
      const filteredModelIds = modelIds.filter((modelId) => isPostProcessingLlmModelId(modelId))

      if (filteredModelIds.length === 0) {
        throw new Error('No LLM-capable models found from this endpoint.')
      }

      setCustomPostScannedModels(filteredModelIds)

      if (!settings.postProcessingCustomModel.trim() && filteredModelIds[0]) {
        onSettingsChange({
          postProcessingCustomModel: filteredModelIds[0],
          postProcessingCloudModelId: filteredModelIds[0],
        })
      }

      pushToast({
        title: 'Custom LLM models fetched',
        description: `${filteredModelIds.length} model${filteredModelIds.length > 1 ? 's' : ''} discovered.`,
        variant: 'success',
      })
    } catch (error: unknown) {
      setCustomPostScannedModels([])
      const message = error instanceof Error ? error.message : CUSTOM_MODEL_FETCH_ERROR
      setCustomPostModelScanError(`${message} Endpoint: ${postProcessingModelsEndpoint}`)
    } finally {
      setCustomPostModelScanLoading(false)
    }
  }

  type TranscriptionApiKeyField =
    | 'transcriptionOpenAIApiKey'
    | 'transcriptionGrokApiKey'
    | 'transcriptionGroqApiKey'
    | 'transcriptionCustomApiKey'

  type PostProcessingApiKeyField =
    | 'postProcessingOpenAIApiKey'
    | 'postProcessingGrokApiKey'
    | 'postProcessingGroqApiKey'
    | 'postProcessingCustomApiKey'

  const transcriptionApiKeyFieldByProvider: Record<string, TranscriptionApiKeyField> = {
    openai: 'transcriptionOpenAIApiKey',
    grok: 'transcriptionGrokApiKey',
    groq: 'transcriptionGroqApiKey',
    custom: 'transcriptionCustomApiKey',
  }

  const postProcessingApiKeyFieldByProvider: Record<string, PostProcessingApiKeyField> = {
    openai: 'postProcessingOpenAIApiKey',
    grok: 'postProcessingGrokApiKey',
    groq: 'postProcessingGroqApiKey',
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
  }

  const getProviderApiKeyDocsUrl = (providerId: string) => providerApiKeyDocsByProvider[providerId] ?? null

  const transcriptionApiKeyDocsUrl = getProviderApiKeyDocsUrl(selectedTranscriptionProvider.providerId)
  const postProcessingApiKeyDocsUrl = getProviderApiKeyDocsUrl(selectedPostProcessingProvider.providerId)

  const providerButtonClass = (active: boolean) =>
    cn(
      'app-no-drag inline-flex min-h-10 h-auto w-full items-center justify-center gap-2 rounded-[var(--radius-premium)] px-3 py-2 text-center text-sm font-medium leading-tight transition-colors whitespace-normal break-words',
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
      {scope === 'post' ? (
        <Card id="settings-node-models.post.toggle" className="scroll-mt-6">
          <CardHeader>
            <CardTitle>Post-processing toggle</CardTitle>
            <CardDescription>Enable or disable post-processing for dictations and note enhancements.</CardDescription>
          </CardHeader>
          <CardContent>
            <div className="flex items-center justify-between gap-3 rounded-[var(--radius-premium)] border border-border-subtle bg-surface-0 p-3">
              <div>
                <p className="text-sm font-medium">Post-processing</p>
                <p className="text-xs text-muted-foreground">
                  {settings.postProcessingEnabled
                    ? 'Enabled: dictations and note actions can use LLM cleanup and prompts.'
                    : 'Disabled: dictations return raw transcript only and note enhancements are bypassed.'}
                </p>
              </div>
              <Switch
                checked={settings.postProcessingEnabled}
                onCheckedChange={(checked) => {
                  onSettingsChange({ postProcessingEnabled: checked })
                }}
              />
            </div>
          </CardContent>
        </Card>
      ) : null}

      {scope === 'transcriptions' && mode === 'cloud' ? (
        <Card id="settings-node-models.transcriptions.cloud" className="scroll-mt-6">
        <CardHeader>
          <CardTitle>Dictations | Cloud</CardTitle>
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
                    {active && <span className="text-xs font-medium text-primary px-1.5 py-0.5 bg-primary/10 rounded-sm">Active</span>}
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
                  <ApiKeyInput
                    apiKey={getTranscriptionApiKey(selectedTranscriptionProvider.providerId)}
                    setApiKey={(value) => setTranscriptionApiKey(selectedTranscriptionProvider.providerId, value)}
                    placeholder={`Enter ${selectedTranscriptionProvider.providerLabel} API key`}
                    label="API key"
                  />
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
                          <Badge tone="primary" className="shrink-0">{t('commonActive')}</Badge>
                        ) : (
                          <span className="shrink-0 text-xs text-muted-foreground">{t('commonSelect')}</span>
                        )}
                      </button>
                    )
                  })}
                </div>

                {canShowAllTranscriptionCloudModels ? (
                  <div className="flex justify-center">
                    <Button
                      variant="outline"
                      size="sm"
                      onClick={() => {
                        setShowAllTranscriptionCloudModels(true)
                      }}
                    >
                      {t('commonShowAll')}
                    </Button>
                  </div>
                ) : null}
              </div>
            )}
          </div>
        </CardContent>
      </Card>
      ) : null}

      {scope === 'transcriptions' && mode === 'local' ? (
      <Card id="settings-node-models.transcriptions.local" className="scroll-mt-6">
        <CardHeader>
          <CardTitle>Dictations | Local</CardTitle>
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
              Whisper runtime is bundled during npm build/package. Active runtime: {settings.whisperCppRuntimeVariant.toUpperCase()}
            </p>

            {whisperRuntimeStatus ? (
              <div className="space-y-1 text-xs text-muted-foreground">
                <p>Bundled runtime path: {whisperRuntimeStatus.runtimeDirectory}</p>
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

                    <p className="text-[11px] text-muted-foreground">
                      Managed by npm build/package pipeline. To update this runtime, rebuild the app artifacts.
                    </p>
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
                    {active && <span className="text-xs font-medium text-primary px-1.5 py-0.5 bg-primary/10 rounded-sm">Active</span>}
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
                  <ApiKeyInput
                    apiKey={getPostProcessingApiKey(selectedPostProcessingProvider.providerId)}
                    setApiKey={(value) => setPostProcessingApiKey(selectedPostProcessingProvider.providerId, value)}
                    placeholder={`Enter ${selectedPostProcessingProvider.providerLabel} API key`}
                    label="API key"
                  />
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
                          <Badge tone="primary" className="shrink-0">{t('commonActive')}</Badge>
                        ) : (
                          <span className="shrink-0 text-xs text-muted-foreground">{t('commonSelect')}</span>
                        )}
                      </button>
                    )
                  })}
                </div>

                {canShowAllPostCloudModels ? (
                  <div className="flex justify-center">
                    <Button
                      variant="outline"
                      size="sm"
                      onClick={() => {
                        setShowAllPostCloudModels(true)
                      }}
                    >
                      {t('commonShowAll')}
                    </Button>
                  </div>
                ) : null}
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
  const { pushToast } = useToast()
  const [view, setView] = useState<PromptView>('preview')
  const [testInput, setTestInput] = useState('')
  const [testOutput, setTestOutput] = useState('')
  const [testLoading, setTestLoading] = useState(false)
  const [customizeTarget, setCustomizeTarget] = useState<'normal' | 'agent' | 'translation'>('agent')
  const [normalPromptDraft, setNormalPromptDraft] = useState(settings.normalPrompt)
  const [agentPromptDraft, setAgentPromptDraft] = useState(settings.agentPrompt)
  const [translationPromptDraft, setTranslationPromptDraft] = useState(settings.translationPrompt)

  const translationComboHotkey = useMemo(
    () => buildTranslationComboHotkey(settings.hotkey),
    [settings.hotkey],
  )

  const translationHotkey =
    settings.translationHotkeyMode === 'combo' ? translationComboHotkey : settings.translationCustomHotkey

  useEffect(() => {
    setNormalPromptDraft(settings.normalPrompt)
  }, [settings.normalPrompt])

  useEffect(() => {
    setAgentPromptDraft(settings.agentPrompt)
  }, [settings.agentPrompt])

  useEffect(() => {
    setTranslationPromptDraft(settings.translationPrompt)
  }, [settings.translationPrompt])

  const hasUnsavedPromptChanges =
    normalPromptDraft !== settings.normalPrompt ||
    agentPromptDraft !== settings.agentPrompt ||
    translationPromptDraft !== settings.translationPrompt

  const activePromptDraft =
    customizeTarget === 'normal'
      ? normalPromptDraft
      : customizeTarget === 'agent'
        ? agentPromptDraft
        : translationPromptDraft

  const activePromptLabel =
    customizeTarget === 'normal' ? 'Normal prompt' : customizeTarget === 'agent' ? 'Agent prompt' : 'Translation prompt'

  const updateActivePromptDraft = (nextValue: string) => {
    if (customizeTarget === 'normal') {
      setNormalPromptDraft(nextValue)
      return
    }

    if (customizeTarget === 'agent') {
      setAgentPromptDraft(nextValue)
      return
    }

    setTranslationPromptDraft(nextValue)
  }

  const savePromptDrafts = () => {
    onChange({
      normalPrompt: normalPromptDraft,
      agentPrompt: agentPromptDraft,
      translationPrompt: translationPromptDraft,
    })

    pushToast({
      title: 'System prompts saved',
      description: 'Prompt templates have been updated.',
      variant: 'success',
    })
  }

  const resetPromptDrafts = () => {
    setNormalPromptDraft(settings.normalPrompt)
    setAgentPromptDraft(settings.agentPrompt)
    setTranslationPromptDraft(settings.translationPrompt)
  }

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
          <CardDescription>Standalone prompt workspace with View, Customize, and Test.</CardDescription>
        </CardHeader>
        <CardContent>
          <div className="mx-auto w-full max-w-[1100px] space-y-4">
          <Tabs
            value={view}
            onValueChange={(nextValue) => {
              setView(nextValue as PromptView)
            }}
          >
            <div className="rounded-[14px] border border-border-subtle bg-[#050b16]/95">
              <TabsList className="grid h-11 w-full grid-cols-3 rounded-none border-b border-border-subtle bg-transparent p-0">
                <TabsTrigger value="preview" className="h-11 rounded-none border-b-2 border-transparent data-[state=active]:border-primary data-[state=active]:bg-surface-0/40">
                  <Eye className="mr-1.5 h-3.5 w-3.5" />
                  View
                </TabsTrigger>
                <TabsTrigger value="customize" className="h-11 rounded-none border-b-2 border-transparent data-[state=active]:border-primary data-[state=active]:bg-surface-0/40">
                  <Pencil className="mr-1.5 h-3.5 w-3.5" />
                  Customize
                </TabsTrigger>
                <TabsTrigger value="test" className="h-11 rounded-none border-b-2 border-transparent data-[state=active]:border-primary data-[state=active]:bg-surface-0/40">
                  <Search className="mr-1.5 h-3.5 w-3.5" />
                  Test
                </TabsTrigger>
              </TabsList>

              <TabsContent value="preview" className="space-y-3 p-4">
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

              <TabsContent value="customize" className="space-y-4 p-4">
                <div className="inline-flex rounded-md border border-border-subtle bg-surface-1 p-0.5">
                  {[
                    { id: 'normal', label: 'Normal' },
                    { id: 'agent', label: 'Agent' },
                    { id: 'translation', label: 'Translation' },
                  ].map((option) => (
                    <button
                      key={option.id}
                      type="button"
                      className={cn(
                        'rounded px-2.5 py-1 text-[11px] transition-colors',
                        customizeTarget === option.id
                          ? 'bg-surface-2 text-foreground'
                          : 'text-foreground/60 hover:text-foreground',
                      )}
                      onClick={() => {
                        setCustomizeTarget(option.id as 'normal' | 'agent' | 'translation')
                      }}
                    >
                      {option.label}
                    </button>
                  ))}
                </div>

                <p className="rounded-md border border-amber-500/25 bg-amber-500/8 px-3 py-2 text-sm text-amber-200/90">
                  <span className="font-semibold text-amber-300">Caution</span> Editing system prompts affects processing quality.
                  Keep placeholders like <code className="font-mono text-[12px]">{'{agentName}'}</code> where required.
                </p>

                <div className="rounded-xl border border-border-subtle bg-surface-0/90 p-3">
                  <p className="mb-2 text-sm font-medium">{activePromptLabel}</p>
                  <Textarea
                    value={activePromptDraft}
                    onChange={(event) => {
                      updateActivePromptDraft(event.target.value)
                    }}
                    placeholder="Write your system prompt here..."
                    className="min-h-[22rem] rounded-lg border border-border-subtle bg-[#030710] px-3 py-3 font-mono text-[13px] leading-6"
                  />
                  <div className="mt-2 flex flex-wrap items-center justify-between gap-2 text-xs text-muted-foreground">
                    <span>Agent name: <span className="font-medium text-foreground">{settings.agentName || 'Agent'}</span></span>
                    <span>{activePromptDraft.length} characters</span>
                  </div>
                </div>

                <div className="flex items-center justify-end gap-2">
                  <Button
                    variant="outline"
                    onClick={resetPromptDrafts}
                    disabled={!hasUnsavedPromptChanges}
                  >
                    <RotateCcw className="h-3.5 w-3.5" />
                    Reset
                  </Button>
                  <Button onClick={savePromptDrafts} disabled={!hasUnsavedPromptChanges}>
                    <Save className="h-3.5 w-3.5" />
                    Save
                  </Button>
                </div>
              </TabsContent>

              <TabsContent value="test" className="space-y-3 p-4">
                <div className="space-y-1.5">
                  <p className="text-sm font-medium">Test input</p>
                  <Textarea
                    value={testInput}
                    onChange={(event) => {
                      setTestInput(event.target.value)
                    }}
                    placeholder={`Try text with "${settings.agentName || 'Agent'}" or prefix with "translate:".`}
                    className="min-h-28"
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
            </div>
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
  const [debugLogFileOpening, setDebugLogFileOpening] = useState(false)
  const [debugLogDirectoryOpening, setDebugLogDirectoryOpening] = useState(false)
  const [showSecretStorage, setShowSecretStorage] = useState(false)
  const [secretStorageStatus, setSecretStorageStatus] = useState<SecretStorageStatusPayload | null>(null)
  const [secretStorageStatusLoading, setSecretStorageStatusLoading] = useState(false)
  const [secretEnvFileOpening, setSecretEnvFileOpening] = useState(false)
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
        const status = await runWithTimeout(
          electronAPI.getDebugLogStatus(),
          INFO_SECTION_REQUEST_TIMEOUT_MS,
          'Debug log status request timed out.',
        )
        setDebugLogStatus(status)
      } catch (error: unknown) {
        setDebugLogStatus(null)
        if (showErrorToast) {
          pushToast({
            title: 'Debug log status unavailable',
            description: error instanceof Error ? error.message : 'Unable to read debug log status in this runtime.',
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

    void refreshDebugLogStatus(true)
  }, [refreshDebugLogStatus, showBugLogs])

  const refreshSecretStorageStatus = useCallback(
    async (showErrorToast: boolean) => {
      setSecretStorageStatusLoading(true)

      try {
        const status = await runWithTimeout(
          electronAPI.getSecretStorageStatus(),
          INFO_SECTION_REQUEST_TIMEOUT_MS,
          'Secret storage status request timed out.',
        )
        setSecretStorageStatus(status)
      } catch (error: unknown) {
        setSecretStorageStatus(null)
        if (showErrorToast) {
          pushToast({
            title: 'Secret storage status unavailable',
            description: error instanceof Error ? error.message : 'Unable to read keyring/env status in this runtime.',
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

    void refreshSecretStorageStatus(true)
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
              <p>
                Logs directory:{' '}
                {debugLogStatusLoading
                  ? 'Loading...'
                  : debugLogStatus?.logsDirectory ?? 'Unavailable (check debug runtime status)'}
              </p>
              <p>
                Current debug log file:{' '}
                {debugLogStatusLoading
                  ? 'Loading...'
                  : debugLogStatus?.currentLogFile ?? 'Unavailable (check debug runtime status)'}
              </p>
              <p>
                Effective log level:{' '}
                {debugLogStatusLoading
                  ? 'Loading...'
                  : (debugLogStatus?.logLevel ?? 'info').toUpperCase()}
              </p>
              {!settings.debugModeEnabled ? (
                <p className="mt-1 text-xs">Debug mode is disabled, so logs are printed to console only.</p>
              ) : null}
            </div>
          ) : null}

          {showBugLogs ? (
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
                disabled={debugLogDirectoryOpening}
                onClick={() => {
                  setDebugLogDirectoryOpening(true)

                  void runWithTimeout(
                    electronAPI.openDebugLogsDirectory(),
                    INFO_SECTION_REQUEST_TIMEOUT_MS,
                    'Opening debug logs directory timed out.',
                  )
                    .catch((error: unknown) => {
                      pushToast({
                        title: 'Unable to open logs directory',
                        description: error instanceof Error ? error.message : 'Unknown runtime error.',
                        variant: 'destructive',
                      })
                    })
                    .finally(() => {
                      setDebugLogDirectoryOpening(false)
                    })
                }}
              >
                {debugLogDirectoryOpening ? 'Opening...' : 'Open logs folder'}
              </Button>
              <Button
                variant="outline"
                size="sm"
                disabled={debugLogFileOpening}
                onClick={() => {
                  setDebugLogFileOpening(true)

                  void runWithTimeout(
                    electronAPI.openDebugLogFile(),
                    INFO_SECTION_REQUEST_TIMEOUT_MS,
                    'Opening debug log file timed out.',
                  )
                    .catch((error: unknown) => {
                      pushToast({
                        title: 'Unable to open debug log file',
                        description: error instanceof Error ? error.message : 'Unknown runtime error.',
                        variant: 'destructive',
                      })
                    })
                    .finally(() => {
                      setDebugLogFileOpening(false)
                    })
                }}
              >
                {debugLogFileOpening ? 'Opening...' : 'Open debug logs file'}
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
                <Badge tone={secretStorageStatus?.activeBackend === 'env' ? 'warning' : 'primary'}>
                  {secretStorageStatus?.activeBackend === 'env' ? 'Emergency fallback (.env)' : 'Keyring active'}
                </Badge>
              </div>

              <p className="text-xs text-muted-foreground">
                System keyring is the default storage backend. Plaintext `.env` is used only as an emergency fallback
                when keyring access fails.
              </p>

              <p className="text-xs text-muted-foreground">
                Env path:{' '}
                {secretStorageStatusLoading
                  ? 'Loading...'
                  : secretStorageStatus?.envFilePath ?? 'Unavailable (check storage runtime status)'}
              </p>

              <p className="text-xs text-muted-foreground">
                {secretStorageStatus?.details ?? 'Status unavailable until checked.'}
              </p>

              {secretStorageStatus?.fallbackActive ? (
                <p className="text-xs text-amber-500">
                  Keyring fallback is active. API keys are currently served from plaintext `.env` until keyring access
                  is restored.
                </p>
              ) : null}

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

                <Button
                  variant="outline"
                  size="sm"
                  disabled={secretEnvFileOpening}
                  onClick={() => {
                  setSecretEnvFileOpening(true)

                    void runWithTimeout(
                      electronAPI.openSecretEnvFile(),
                      INFO_SECTION_REQUEST_TIMEOUT_MS,
                      'Opening .env file timed out.',
                    )
                      .catch((error: unknown) => {
                        pushToast({
                          title: 'Unable to open .env file',
                          description: error instanceof Error ? error.message : 'Unknown runtime error.',
                          variant: 'destructive',
                        })
                      })
                      .finally(() => {
                        setSecretEnvFileOpening(false)
                      })
                  }}
                >
                  {secretEnvFileOpening ? 'Opening...' : 'Open .env file'}
                </Button>

                {secretStorageStatus?.activeBackend === 'env' && secretStorageStatus.keyringSupported ? (
                  <Button size="sm" disabled={secretMigrationLoading} onClick={() => void handleSecretMigration()}>
                    {secretMigrationLoading ? 'Migrating...' : 'Retry keyring + migrate from .env'}
                  </Button>
                ) : null}
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
          <div className="flex flex-wrap items-center gap-2">
            <Button
              variant="outline"
              onClick={() => {
                void electronAPI.openAppDataDirectory()
              }}
            >
              <Link className="h-3.5 w-3.5" /> Open app data folder
            </Button>
          </div>
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
  | 'spending-limits'
  | 'stats-logs'
  | 'privacy'
  | 'developer'
  | 'shortcuts'
  | 'faq'

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
      { id: 'spending-limits', label: 'Spending Limits', icon: Wallet },
      { id: 'stats-logs', label: 'Stats Logs', icon: FileText },
      { id: 'privacy', label: 'Privacy', icon: Lock },
      { id: 'developer', label: 'Developer', icon: Wrench },
      { id: 'shortcuts', label: 'Shortcuts', icon: Settings },
      { id: 'faq', label: 'FAQ', icon: BookOpen },
    ],
  },
]

interface SettingsWorkspaceProps {
  settings: AppSettings
  models: ModelState[]
  postModels: ModelState[]
  dictationStatsRows: DetailedStatsCallRow[]
  noteStatsRows: DetailedStatsCallRow[]
  displayServer: DisplayServer
  autoPasteSupport: AutoPasteBackendSupportPayload | null
  autoPasteSupportLoading: boolean
  requestedNode: SettingsNodeId | null
  onRefreshAutoPasteSupport: () => void
  onClearDetailedStatsLogs: () => void
  onSettingsChange: (next: Partial<AppSettings>) => void
  onModelsChange: Dispatch<SetStateAction<ModelState[]>>
  onPostModelsChange: Dispatch<SetStateAction<ModelState[]>>
}

const SettingsWorkspace = ({
  settings,
  models,
  postModels,
  dictationStatsRows,
  noteStatsRows,
  displayServer,
  autoPasteSupport,
  autoPasteSupportLoading,
  requestedNode,
  onRefreshAutoPasteSupport,
  onClearDetailedStatsLogs,
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

  useEffect(() => {
    if (!requestedNode) {
      return
    }

    setActiveNode(requestedNode)
  }, [requestedNode])

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

    if (activeNode === 'spending-limits') {
      return <SpendingLimitsSection settings={settings} onChange={onSettingsChange} />
    }

    if (activeNode === 'stats-logs') {
      return (
        <DetailedStatsLoggingSection
          settings={settings}
          dictationRows={dictationStatsRows}
          noteRows={noteStatsRows}
          onChange={onSettingsChange}
          onClearLogs={onClearDetailedStatsLogs}
        />
      )
    }

    if (activeNode === 'privacy') {
      return <PrivacyPanel />
    }

    if (activeNode === 'shortcuts') {
      return <ShortcutsSection hotkey={settings.hotkey} />
    }

    if (activeNode === 'faq') {
      return <FaqSection />
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
                <div className="rounded-md border border-border-subtle bg-surface-0 p-3 text-sm">Local dictations</div>
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
  const [settingsNodeRequest, setSettingsNodeRequest] = useState<SettingsNodeId | null>(null)
  const [settings, setSettings] = useState<AppSettings>(loadSettings)
  const [models, setModels] = useState<ModelState[]>(loadModelState)
  const [postModels, setPostModels] = useState<ModelState[]>(loadPostModelState)
  const [historyEntries, setHistoryEntries] = useState<HistoryEntry[]>([])
  const [historyForEstimates, setHistoryForEstimates] = useState<HistoryEntry[]>(loadHistory)
  const [historyTotalEntries, setHistoryTotalEntries] = useState(0)
  const [noteFolders, setNoteFolders] = useState<NoteFolder[]>(loadNoteFolders)
  const [notes, setNotes] = useState<NoteEntry[]>(loadNotes)
  const [noteActions, setNoteActions] = useState<NoteAction[]>(loadNoteActions)
  const [activeFolderId, setActiveFolderId] = useState<string | null>(null)
  const [activeNoteId, setActiveNoteId] = useState<string | null>(null)
  const [dictationStatus, setDictationStatus] = useState<'IDLE' | 'RECORDING' | 'PROCESSING'>('IDLE')
  const [transcribingNoteId, setTranscribingNoteId] = useState<string | null>(null)
  const [postProcessingNoteId, setPostProcessingNoteId] = useState<string | null>(null)
  const [historyLoading, setHistoryLoading] = useState(true)
  const [historyVisibleCount, setHistoryVisibleCount] = useState(HISTORY_LAZY_BATCH_SIZE)
  const [historyClearConfirmOpen, setHistoryClearConfirmOpen] = useState(false)
  const [onboardingDone, setOnboardingDone] = useState(isOnboardingCompleted)
  const [displayServer, setDisplayServer] = useState<DisplayServer>('unknown')
  const [autoPasteSupport, setAutoPasteSupport] = useState<AutoPasteBackendSupportPayload | null>(null)
  const [autoPasteSupportLoading, setAutoPasteSupportLoading] = useState(true)
  const [windowMaximized, setWindowMaximized] = useState(false)
  const [usageStats, setUsageStats] = useState<AppUsageStatsPayload | null>(null)
  const [usageStatsLoading, setUsageStatsLoading] = useState(false)
  const secretFallbackToastShownRef = useRef(false)
  const rawNoteCaretByIdRef = useRef<Record<string, number>>({})
  const [noteRecordingStartedAt, setNoteRecordingStartedAt] = useState<number | null>(null)
  const [noteRecordingElapsedSeconds, setNoteRecordingElapsedSeconds] = useState(0)
  const [noteProcessingEvents, setNoteProcessingEvents] = useState<NoteProcessingEvent[]>(loadNoteProcessingEvents)
  const noteEventBackfillDoneRef = useRef(false)

  const historyLazyLoadingEnabled = HISTORY_LAZY_LOAD_LIMITS.has(settings.historyRetentionLimit)

  const loadHistoryForSection = useCallback(
    (requestedVisibleCount?: number) => {
      const fullHistory = loadHistory()
      const normalizedVisibleCount = historyLazyLoadingEnabled
        ? Math.min(requestedVisibleCount ?? HISTORY_LAZY_BATCH_SIZE, fullHistory.length)
        : fullHistory.length

      setHistoryTotalEntries(fullHistory.length)
      setHistoryForEstimates(fullHistory)
      setHistoryVisibleCount(normalizedVisibleCount)
      setHistoryEntries(historyLazyLoadingEnabled ? fullHistory.slice(0, normalizedVisibleCount) : fullHistory)
    },
    [historyLazyLoadingEnabled],
  )

  useEffect(() => {
    const timer = window.setTimeout(() => {
      loadHistoryForSection()
      setHistoryLoading(false)
    }, 600)

    return () => {
      window.clearTimeout(timer)
    }
  }, [loadHistoryForSection])

  useEffect(() => {
    const retentionLimit = settings.historyRetentionLimit
    if (retentionLimit >= 0) {
      const fullHistory = loadHistory()
      if (fullHistory.length > retentionLimit) {
        saveHistory(applyHistoryRetentionLimit(fullHistory, retentionLimit))
      }
    }

    loadHistoryForSection()
  }, [loadHistoryForSection, settings.historyRetentionLimit])

  const canShowMoreHistory = historyLazyLoadingEnabled && historyEntries.length < historyTotalEntries

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

  const refreshUsageStats = useCallback(async (forceRefresh: boolean) => {
    setUsageStatsLoading(true)

    try {
      const payload = await electronAPI.getAppUsageStats(forceRefresh)
      setUsageStats(payload)
    } catch {
      setUsageStats(null)
    } finally {
      setUsageStatsLoading(false)
    }
  }, [])

  useEffect(() => {
    void refreshAutoPasteSupport(false)
  }, [refreshAutoPasteSupport])

  useEffect(() => {
    if (!onboardingDone) {
      return
    }

    void refreshUsageStats(false)
  }, [
    onboardingDone,
    historyTotalEntries,
    noteFolders.length,
    notes.length,
    settings.transcriptionCustomBaseUrl,
    settings.transcriptionCustomApiKey,
    settings.transcriptionRuntime,
    settings.transcriptionCloudProvider,
    settings.transcriptionCloudModelId,
    settings.transcriptionLocalModelId,
    settings.postProcessingCustomBaseUrl,
    settings.postProcessingCustomApiKey,
    settings.postProcessingRuntime,
    settings.postProcessingCloudProvider,
    settings.postProcessingCloudModelId,
    settings.postProcessingLocalModelId,
    refreshUsageStats,
  ])

  useEffect(() => {
    let alive = true

    void electronAPI
      .getSecretStorageStatus()
      .then((status) => {
        if (!alive || secretFallbackToastShownRef.current) {
          return
        }

        if (!status.fallbackActive) {
          return
        }

        secretFallbackToastShownRef.current = true
        pushToast({
          title: 'Keyring unavailable',
          description: status.details,
          variant: 'destructive',
        })
      })
      .catch(() => {
        // Ignore toast bootstrap failures.
      })

    return () => {
      alive = false
    }
  }, [pushToast])

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
    if (typeof window.electronAPI === 'undefined') {
      return fakeTranscriptionService.subscribeStatus((status) => {
        setDictationStatus(status)
      })
    }

    let alive = true

    void electronAPI
      .getDictationStatus()
      .then((status) => {
        if (alive) {
          setDictationStatus(status)
        }
      })
      .catch(() => {
        if (alive) {
          setDictationStatus('IDLE')
        }
      })

    const offDictationStatusChanged = electronAPI.onDictationStatusChanged((status) => {
      setDictationStatus(status)
    })

    return () => {
      alive = false
      offDictationStatusChanged()
    }
  }, [])

  useEffect(() => {
    if (dictationStatus === 'RECORDING' && transcribingNoteId !== null && noteRecordingStartedAt === null) {
      setNoteRecordingStartedAt(Date.now())
      return
    }

    if (dictationStatus !== 'RECORDING' && noteRecordingStartedAt !== null) {
      setNoteRecordingStartedAt(null)
    }
  }, [dictationStatus, noteRecordingStartedAt, transcribingNoteId])

  useEffect(() => {
    if (dictationStatus !== 'RECORDING' || transcribingNoteId === null || noteRecordingStartedAt === null) {
      setNoteRecordingElapsedSeconds(0)
      return
    }

    const updateElapsed = () => {
      setNoteRecordingElapsedSeconds(Math.max(0, Math.floor((Date.now() - noteRecordingStartedAt) / 1000)))
    }

    updateElapsed()
    const intervalId = window.setInterval(updateElapsed, 1000)

    return () => {
      window.clearInterval(intervalId)
    }
  }, [dictationStatus, noteRecordingStartedAt, transcribingNoteId])

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
    saveNoteFolders(noteFolders)
  }, [noteFolders])

  useEffect(() => {
    saveNotes(notes)
  }, [notes])

  useEffect(() => {
    saveNoteActions(noteActions)
  }, [noteActions])

  useEffect(() => {
    if (activeFolderId && !noteFolders.some((folder) => folder.id === activeFolderId)) {
      setActiveFolderId(null)
    }
  }, [activeFolderId, noteFolders])

  useEffect(() => {
    const visibleNotes = activeFolderId ? notes.filter((entry) => entry.folderId === activeFolderId) : notes
    if (visibleNotes.length === 0) {
      setActiveNoteId(null)
      return
    }

    if (!activeNoteId || !visibleNotes.some((entry) => entry.id === activeNoteId)) {
      setActiveNoteId(visibleNotes[0]?.id ?? null)
    }
  }, [activeFolderId, activeNoteId, notes])

  useEffect(() => {
    const offAutoHide = electronAPI.onFloatingIconAutoHideChanged((enabled) => {
      setSettings((current) => {
        if (current.autoHideFloatingIcon === enabled) {
          return current
        }

        return {
          ...current,
          autoHideFloatingIcon: enabled,
        }
      })
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
        description: `${payload.reason} ${payload.details}`,
        variant: 'destructive',
      })
    })

    const offHotkeyChanged = electronAPI.onHotkeyEffectiveChanged((newHotkey) => {
      setSettings((current) => ({
        ...current,
        hotkey: newHotkey,
      }))
    })

    return () => {
      offAutoHide()
      offFailure()
      offFallback()
      offHotkeyChanged()
    }
  }, [pushToast])

  useEffect(() => {
    const onStorage = (event: StorageEvent) => {
      if (event.key === STORAGE_KEYS.history) {
        loadHistoryForSection(historyVisibleCount)
      }

      if (event.key === STORAGE_KEYS.settings) {
        void refreshSettingsFromBackend().then((nextSettings) => {
          setSettings(nextSettings)
        })
      }

      if (event.key === STORAGE_KEYS.postModels) {
        setPostModels(loadPostModelState())
      }

      if (event.key === STORAGE_KEYS.noteFolders) {
        setNoteFolders(loadNoteFolders())
      }

      if (event.key === STORAGE_KEYS.notes) {
        setNotes(loadNotes())
      }

      if (event.key === STORAGE_KEYS.noteActions) {
        setNoteActions(loadNoteActions())
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
  }, [historyVisibleCount, loadHistoryForSection, pushToast])

  const handleSettingsChange = (next: Partial<AppSettings>) => {
    setSettings((current) => ({
      ...current,
      ...next,
    }))
  }

  const emitNotesLog = useCallback((message: string, details?: Record<string, unknown>) => {
    void electronAPI.logNotesEvent({ message, details }).catch(() => {})
  }, [])

  const handleCreateFolder = (name: string) => {
    const timestamp = Date.now()
    const nextFolder: NoteFolder = {
      id: crypto.randomUUID(),
      name,
      createdAt: timestamp,
      updatedAt: timestamp,
    }

    setNoteFolders((current) => [nextFolder, ...current])
    setActiveFolderId(nextFolder.id)
    pushToast({
      title: 'Folder created',
      description: `${name} is ready.`,
      variant: 'success',
    })

    emitNotesLog('Folder created', {
      folderId: nextFolder.id,
      folderName: nextFolder.name,
      totalFolders: noteFolders.length + 1,
    })
  }

  const handleDeleteFolder = (folderId: string) => {
    const folder = noteFolders.find((entry) => entry.id === folderId)
    if (!folder) {
      return
    }

    setNoteFolders((current) => current.filter((entry) => entry.id !== folderId))
    setNotes((current) =>
      current.map((entry) =>
        entry.folderId === folderId
          ? {
              ...entry,
              folderId: null,
              updatedAt: Date.now(),
            }
          : entry,
      ),
    )

    if (activeFolderId === folderId) {
      setActiveFolderId(null)
    }

    pushToast({
      title: 'Folder removed',
      description: `${folder.name} was deleted. Notes were moved to Uncategorized.`,
    })

    emitNotesLog('Folder deleted', {
      folderId,
      folderName: folder.name,
      movedNotesToRoot: true,
    })
  }

  const handleCreateNote = (folderId: string | null) => {
    const timestamp = Date.now()
    const folderScopedNoteIndex = getNextFolderNoteIndex(notes, folderId)
    const nextNote: NoteEntry = {
      id: crypto.randomUUID(),
      folderId,
      title: `Note ${folderScopedNoteIndex}`,
      rawText: '',
      processedText: '',
      autoTitleGenerated: false,
      createdAt: timestamp,
      updatedAt: timestamp,
    }

    setNotes((current) => [nextNote, ...current])
    setActiveNoteId(nextNote.id)
    pushToast({
      title: 'Note created',
      variant: 'success',
    })

    emitNotesLog('Note created', {
      noteId: nextNote.id,
      folderId,
      title: nextNote.title,
      totalNotes: notes.length + 1,
    })
  }

  const handleUpdateNote = (
    noteId: string,
    patch: Partial<Pick<NoteEntry, 'title' | 'rawText' | 'processedText' | 'folderId' | 'autoTitleGenerated'>>,
  ) => {
    setNotes((current) =>
      current.map((entry) => {
        if (entry.id !== noteId) {
          return entry
        }

        return {
          ...entry,
          ...patch,
          updatedAt: Date.now(),
        }
      }),
    )
  }

  const handleDeleteNote = (noteId: string) => {
    const removedNote = notes.find((entry) => entry.id === noteId)

    setNotes((current) => current.filter((entry) => entry.id !== noteId))
    if (activeNoteId === noteId) {
      setActiveNoteId(null)
    }
    if (transcribingNoteId === noteId) {
      setTranscribingNoteId(null)
      setNoteRecordingStartedAt(null)
    }
    if (postProcessingNoteId === noteId) {
      setPostProcessingNoteId(null)
    }

    delete rawNoteCaretByIdRef.current[noteId]

    emitNotesLog('Note deleted', {
      noteId,
      title: removedNote?.title ?? null,
    })
  }

  const handleForceSaveNote = (noteId: string) => {
    const targetNote = notes.find((entry) => entry.id === noteId)
    if (!targetNote) {
      return
    }

    saveNoteFolders(noteFolders)
    saveNotes(notes)
    saveNoteActions(noteActions)

    pushToast({
      title: 'Note saved',
      description: `"${targetNote.title || 'Untitled'}" has been saved successfully.`,
      variant: 'success',
    })

    emitNotesLog('Manual note save triggered', {
      noteId,
      title: targetNote.title,
    })
  }

  const handleRequestNoteTranscription = async (noteId: string) => {
    const usingElectronBridge = typeof window.electronAPI !== 'undefined'

    emitNotesLog('Transcribe requested', {
      noteId,
      runtime: usingElectronBridge ? 'electron' : 'browser',
      dictationStatus,
      transcribingNoteId,
    })

    const toggleDictation = usingElectronBridge
      ? () => electronAPI.toggleDictationTranscriptionOnly()
      : async () => fakeTranscriptionService.toggleListening()
    const cancelDictation = usingElectronBridge
      ? () => electronAPI.cancelDictation()
      : async () => {
          if (dictationStatus === 'RECORDING') {
            return fakeTranscriptionService.cancelRecording()
          }

          if (dictationStatus === 'PROCESSING') {
            return fakeTranscriptionService.cancelProcessing()
          }

          return false
        }

    const wasRecordingThisNote = dictationStatus === 'RECORDING' && transcribingNoteId === noteId

    if (dictationStatus === 'PROCESSING') {
      if (transcribingNoteId === noteId) {
        emitNotesLog('Transcribe skipped: already processing same note', {
          noteId,
        })

        pushToast({
          title: 'Transcription in progress',
          description: 'Current note transcription is still being processed.',
        })
        return
      }

      if (transcribingNoteId !== null && transcribingNoteId !== noteId) {
        emitNotesLog('Transcribe rejected: another note processing', {
          noteId,
          activeTranscribingNoteId: transcribingNoteId,
        })

        pushToast({
          title: 'Another note is processing',
          description: 'Wait for it to finish, then retry.',
          variant: 'destructive',
        })
        return
      }

      const canceledStaleProcessing = await cancelDictation().catch(() => false)
      if (!canceledStaleProcessing) {
        emitNotesLog('Transcribe rejected: stale processing could not be canceled', {
          noteId,
        })

        pushToast({
          title: 'Transcription busy',
          description: 'An existing transcription process is still active. Retry in a moment.',
          variant: 'destructive',
        })
        return
      }
    }

    if (dictationStatus === 'RECORDING' && transcribingNoteId === null) {
      const canceledUnknownRecording = await cancelDictation().catch(() => false)
      if (!canceledUnknownRecording) {
        emitNotesLog('Transcribe rejected: unknown active recording', {
          noteId,
        })

        pushToast({
          title: 'Dictation busy',
          description: 'Another recording session is active. Stop it, then retry.',
          variant: 'destructive',
        })
        return
      }
    }

    setTranscribingNoteId(noteId)

    try {
      const response = await toggleDictation()
      if (!response.accepted) {
        if (!(response.reason === 'processing' && wasRecordingThisNote)) {
          setTranscribingNoteId(null)
          setNoteRecordingStartedAt(null)
        }

        emitNotesLog('Transcribe rejected by runtime', {
          noteId,
          reason: response.reason ?? 'unknown',
          runtime: usingElectronBridge ? 'electron' : 'browser',
        })

        const reasonDescription =
          response.reason === 'processing'
            ? 'Another transcription operation is currently running.'
            : response.reason === 'unavailable'
              ? usingElectronBridge
                ? 'Microphone recorder is unavailable in this runtime.'
                : 'Browser speech recognition is unavailable in this browser/runtime.'
              : 'Dictation is currently unavailable.'
        pushToast({
          title: 'Unable to start transcription',
          description: reasonDescription,
          variant: 'destructive',
        })
        return
      }

      if (wasRecordingThisNote) {
        setNoteRecordingStartedAt(null)
      } else {
        setNoteRecordingStartedAt(Date.now())
      }

      pushToast({
        title: wasRecordingThisNote ? 'Recording stopped' : 'Dictation started',
        description: wasRecordingThisNote
          ? 'Processing transcription and appending text to this note...'
          : usingElectronBridge
            ? 'Press Transcribe again to stop and append text to this note.'
            : 'Press Transcribe again to stop and append browser speech text to this note.',
      })

      emitNotesLog(wasRecordingThisNote ? 'Transcribe stop requested' : 'Transcribe started', {
        noteId,
        runtime: usingElectronBridge ? 'electron' : 'browser',
      })
    } catch {
      setTranscribingNoteId(null)
      setNoteRecordingStartedAt(null)

      emitNotesLog('Transcribe failed with runtime exception', {
        noteId,
        runtime: usingElectronBridge ? 'electron' : 'browser',
      })

      pushToast({
        title: 'Unable to start transcription',
        description: usingElectronBridge
          ? 'Dictation control is unavailable in this runtime.'
          : 'Browser speech recognition is unavailable in this browser/runtime.',
        variant: 'destructive',
      })
    }
  }

  const handlePostProcessNote = async (noteId: string, actionId: string | null = null) => {
    if (!settings.postProcessingEnabled) {
      pushToast({
        title: 'Post-processing is disabled',
        description: 'Enable post-processing in Settings > Models > Post-processing toggle.',
      })
      return
    }

    const targetNote = notes.find((entry) => entry.id === noteId)
    if (!targetNote || !targetNote.rawText.trim()) {
      emitNotesLog('Post-process skipped: note has no raw text', {
        noteId,
      })

      pushToast({
        title: 'No transcription text',
        description: 'Add transcription text before running post-processing.',
        variant: 'destructive',
      })
      return
    }

    const selectedAction = actionId ? noteActions.find((action) => action.id === actionId) ?? null : null
    if (actionId && !selectedAction) {
      pushToast({
        title: 'Custom action unavailable',
        description: 'The selected custom action was not found.',
        variant: 'destructive',
      })
      return
    }

    const actionLabel = selectedAction ? `custom action: ${selectedAction.name}` : 'normal cleanup'

    setPostProcessingNoteId(noteId)

    emitNotesLog('Post-process started', {
      noteId,
      action: actionLabel,
      inputLength: targetNote.rawText.trim().length,
    })

    try {
      const output = await electronAPI.runNoteEnhancement(targetNote.rawText, selectedAction?.instructions)
      const shouldGenerateTitle =
        !targetNote.autoTitleGenerated &&
        (/^note\s+\d+$/i.test(targetNote.title.trim()) || targetNote.title.trim().length === 0)

      const generatedTitle = shouldGenerateTitle ? generateNoteTitleFromContent(output || targetNote.rawText) : targetNote.title

      handleUpdateNote(noteId, {
        processedText: output,
        ...(shouldGenerateTitle
          ? {
              title: generatedTitle,
              autoTitleGenerated: true,
            }
          : {}),
      })

      if (settings.detailedStatsLoggingEnabled) {
        const rawMeta = resolvePostProcessingMetadata(settings)
        const providerModel = {
          provider: rawMeta.provider.trim() || 'unknown-post-provider',
          model: rawMeta.model.trim() || 'unknown-model',
        }

        const inputText = targetNote.rawText.trim()
        const outputText = output.trim()
        const inputWords = estimateWordsFromText(inputText)
        const outputWords = estimateWordsFromText(outputText)
        const inputTokens = estimateTokensFromText(inputText)
        const outputTokens = estimateTokensFromText(outputText)
        const scopedModelId = `${providerModel.provider}/${providerModel.model}`
        const modelRates = resolveModelTokenRatesWithFallback(scopedModelId, providerModel.model, usageStats)
        const costUSD = Number((inputTokens * (modelRates.input ?? 0) + outputTokens * (modelRates.output ?? 0)).toFixed(6))

        setNoteProcessingEvents((current) =>
          [
            {
              id: crypto.randomUUID(),
              timestamp: Date.now(),
              noteId,
              noteTitle: shouldGenerateTitle ? generatedTitle : targetNote.title,
              actionId: selectedAction?.id ?? null,
              actionName: selectedAction?.name ?? 'Clean Up Notes',
              provider: providerModel.provider,
              model: providerModel.model,
              inputWords,
              inputTokens,
              outputWords,
              outputTokens,
              durationSeconds: estimateDurationFromWords(outputWords, ESTIMATED_READING_WPM),
              postProcessingApplied: true,
              estimated: false,
              costUSD,
            },
            ...current,
          ].slice(0, 20000),
        )
      }

      emitNotesLog('Post-process completed', {
        noteId,
        action: actionLabel,
        outputLength: output.trim().length,
        unchanged: output.trim() === targetNote.rawText.trim(),
      })

      pushToast({
        title: output.trim() === targetNote.rawText.trim() ? 'Cleanup completed (no major changes)' : 'Post-processing completed',
        description: selectedAction ? `Applied ${selectedAction.name}.` : undefined,
        variant: 'success',
      })
    } catch (error: unknown) {
      const message = error instanceof Error ? error.message : 'Unknown post-processing error.'
      const fallbackOutput = targetNote.rawText
        .replace(/[ \t]+\n/g, '\n')
        .replace(/\n{3,}/g, '\n\n')
        .replace(/[ \t]{2,}/g, ' ')
        .trim()

      handleUpdateNote(noteId, {
        processedText: fallbackOutput,
        ...(!targetNote.autoTitleGenerated && /^note\s+\d+$/i.test(targetNote.title.trim())
          ? {
              title: generateNoteTitleFromContent(fallbackOutput || targetNote.rawText),
              autoTitleGenerated: true,
            }
          : {}),
      })

      if (settings.detailedStatsLoggingEnabled) {
        const outputWords = estimateWordsFromText(fallbackOutput)
        setNoteProcessingEvents((current) =>
          [
            {
              id: crypto.randomUUID(),
              timestamp: Date.now(),
              noteId,
              noteTitle: targetNote.title,
              actionId: selectedAction?.id ?? null,
              actionName: `${selectedAction?.name ?? 'Clean Up Notes'} (fallback)`,
              provider: 'fallback-cleanup',
              model: 'local-normalizer',
              inputWords: estimateWordsFromText(targetNote.rawText),
              inputTokens: estimateTokensFromText(targetNote.rawText),
              outputWords,
              outputTokens: estimateTokensFromText(fallbackOutput),
              durationSeconds: estimateDurationFromWords(outputWords, ESTIMATED_READING_WPM),
              postProcessingApplied: false,
              estimated: true,
              costUSD: 0,
            },
            ...current,
          ].slice(0, 20000),
        )
      }

      emitNotesLog('Post-process failed: fallback cleanup applied', {
        noteId,
        action: actionLabel,
        error: message,
        fallbackLength: fallbackOutput.length,
      })

      pushToast({
        title:
          typeof window.electronAPI === 'undefined'
            ? 'Basic cleanup preview applied'
            : 'Reasoning unavailable, basic cleanup applied',
        description: message,
      })
    } finally {
      setPostProcessingNoteId(null)
    }
  }

  const handleCreateNoteAction = (
    name: string,
    description: string,
    instructions: string,
    actionId: string | null = null,
  ) => {
    const normalizedName = name.trim()
    const normalizedDescription = description.trim()
    const normalizedInstructions = instructions.trim()

    if (!normalizedName || !normalizedInstructions) {
      pushToast({
        title: 'Custom action is incomplete',
        description: 'Provide both action name and instructions.',
        variant: 'destructive',
      })
      return
    }

    const timestamp = Date.now()
    setNoteActions((current) => {
      if (actionId) {
        return current.map((entry) =>
          entry.id === actionId
            ? {
                ...entry,
                name: normalizedName,
                description: normalizedDescription,
                instructions: normalizedInstructions,
                updatedAt: timestamp,
              }
            : entry,
        )
      }

      return [
        ...current,
        {
          id: crypto.randomUUID(),
          name: normalizedName,
          description: normalizedDescription,
          instructions: normalizedInstructions,
          isBuiltIn: false,
          createdAt: timestamp,
          updatedAt: timestamp,
        },
      ]
    })

    emitNotesLog('Custom note action saved', {
      name: normalizedName,
      instructionsLength: normalizedInstructions.length,
    })

    pushToast({
      title: actionId ? 'Action updated' : 'Custom action saved',
      description: `${normalizedName} is ready to use.`,
      variant: 'success',
    })
  }

  const handleDeleteNoteAction = (actionId: string) => {
    setNoteActions((current) => {
      const targetAction = current.find((action) => action.id === actionId)
      if (!targetAction || targetAction.isBuiltIn) {
        return current
      }

      return current.filter((action) => action.id !== actionId)
    })

    emitNotesLog('Custom note action deleted', {
      actionId,
    })

    pushToast({
      title: 'Custom action removed',
    })
  }

  useEffect(() => {
    const handleResult = (payload: { text: string }) => {
      window.setTimeout(() => {
        loadHistoryForSection(historyVisibleCount)
      }, 120)

      setTranscribingNoteId((currentNoteId) => {
        if (!currentNoteId) {
          return currentNoteId
        }

        setNoteRecordingStartedAt(null)

        setNotes((current) =>
          current.map((entry) => {
            if (entry.id !== currentNoteId) {
              return entry
            }

            const sourceRawText = entry.rawText ?? ''
            const insertionPoint = rawNoteCaretByIdRef.current[currentNoteId]
            const hasTrackedInsertionPoint =
              typeof insertionPoint === 'number' &&
              Number.isFinite(insertionPoint) &&
              insertionPoint >= 0 &&
              insertionPoint <= sourceRawText.length

            const nextRawText = hasTrackedInsertionPoint
              ? `${sourceRawText.slice(0, insertionPoint)}${payload.text}${sourceRawText.slice(insertionPoint)}`
              : sourceRawText.trim().length > 0
                ? `${sourceRawText.trimEnd()}\n${payload.text}`
                : payload.text

            if (hasTrackedInsertionPoint) {
              rawNoteCaretByIdRef.current[currentNoteId] = insertionPoint + payload.text.length
            }

            return {
              ...entry,
              rawText: nextRawText,
              updatedAt: Date.now(),
            }
          }),
        )

        pushToast({
          title: 'Transcript added to note',
          variant: 'success',
        })

        emitNotesLog('Transcript appended to note', {
          noteId: currentNoteId,
          textLength: payload.text.length,
        })

        return null
      })
    }

    if (typeof window.electronAPI === 'undefined') {
      return fakeTranscriptionService.subscribeResult((payload) => {
        handleResult(payload)
      })
    }

    const offResult = electronAPI.onDictationResult((payload) => {
      handleResult(payload)
    })

    const offError = electronAPI.onDictationError((message) => {
      setTranscribingNoteId((currentNoteId) => {
        if (!currentNoteId) {
          return currentNoteId
        }

        setNoteRecordingStartedAt(null)

        pushToast({
          title: 'Transcription failed',
          description: message,
          variant: 'destructive',
        })

        emitNotesLog('Transcription failed', {
          noteId: currentNoteId,
          message,
        })

        return null
      })
    })

    return () => {
      offResult()
      offError()
    }
  }, [emitNotesLog, historyVisibleCount, loadHistoryForSection, pushToast])

  const handleTrackRawNoteCaret = useCallback((noteId: string, caretPosition: number) => {
    if (!Number.isFinite(caretPosition) || caretPosition < 0) {
      return
    }

    rawNoteCaretByIdRef.current[noteId] = Math.max(0, Math.floor(caretPosition))
  }, [])

  const renderSection = () => {
    if (section === 'conversations') {
      return (
        <HistorySection
          entries={historyEntries}
          totalEntries={historyTotalEntries}
          loading={historyLoading}
          usageStats={usageStats}
          clearConfirmOpen={historyClearConfirmOpen}
          onClearConfirmOpenChange={setHistoryClearConfirmOpen}
          onShowMore={() => {
            loadHistoryForSection(historyVisibleCount + HISTORY_LAZY_BATCH_SIZE)
          }}
          canShowMore={canShowMoreHistory}
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
            const nextHistory = loadHistory().filter((entry) => entry.id !== id)
            saveHistory(nextHistory)
            loadHistoryForSection(historyVisibleCount)
          }}
          onClear={() => {
            clearHistory()
            setHistoryEntries([])
            setHistoryForEstimates([])
            setHistoryTotalEntries(0)
            setHistoryVisibleCount(0)
            setHistoryClearConfirmOpen(false)
            pushToast({
              title: 'Dictations removed',
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
          dictationStatsRows={dictationStatsRows}
          noteStatsRows={noteStatsRows}
          displayServer={displayServer}
          autoPasteSupport={autoPasteSupport}
          autoPasteSupportLoading={autoPasteSupportLoading}
          requestedNode={settingsNodeRequest}
          onRefreshAutoPasteSupport={() => {
            void refreshAutoPasteSupport(true)
          }}
          onClearDetailedStatsLogs={handleClearDetailedStatsLogs}
          onSettingsChange={handleSettingsChange}
          onModelsChange={setModels}
          onPostModelsChange={setPostModels}
        />
      )
    }

    if (section === 'notes') {
      return (
        <NotesSection
          settings={settings}
          usageStats={usageStats}
          folders={noteFolders}
          notes={notes}
          actions={noteActions}
          activeFolderId={activeFolderId}
          activeNoteId={activeNoteId}
          dictationStatus={dictationStatus}
          transcribingNoteId={transcribingNoteId}
          recordingElapsedSeconds={noteRecordingElapsedSeconds}
          postProcessingNoteId={postProcessingNoteId}
          onSelectFolder={setActiveFolderId}
          onCreateFolder={handleCreateFolder}
          onDeleteFolder={handleDeleteFolder}
          onCreateNote={handleCreateNote}
          onSelectNote={setActiveNoteId}
          onUpdateNote={handleUpdateNote}
          onDeleteNote={handleDeleteNote}
          onTranscribeNote={(noteId) => {
            void handleRequestNoteTranscription(noteId)
          }}
          onRunNoteAction={(noteId, actionId) => {
            void handlePostProcessNote(noteId, actionId)
          }}
          onCreateNoteAction={handleCreateNoteAction}
          onDeleteNoteAction={handleDeleteNoteAction}
          onForceSaveNote={handleForceSaveNote}
          onTrackRawNoteCaret={handleTrackRawNoteCaret}
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
        const requestedClose = await requestInternalAction('whispy-action://window/close')
        if (!requestedClose) {
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

  const handleQuitApplication = async () => {
    const tryInvoke = async (callback: () => Promise<void>) => {
      try {
        await callback()
        return true
      } catch {
        return false
      }
    }

    try {
      const dispatchedViaBridge = await tryInvoke(() => electronAPI.openExternal('whispy-action://app/quit'))
      if (dispatchedViaBridge) {
        return
      }

      try {
        window.open('whispy-action://app/quit', '_blank', 'noopener,noreferrer')
      } catch {
        await tryInvoke(() => electronAPI.closeWindow())
      }
    } catch {
      pushToast({
        title: 'Quit unavailable',
        description: 'Unable to quit from this runtime.',
        variant: 'destructive',
      })
    }
  }

  const conversationsCountLabel = historyLoading
    ? '...'
    : historyTotalEntries > 999
      ? '999+'
      : String(historyTotalEntries)

  const notesCountLabel = notes.length > 999 ? '999+' : String(notes.length)
  const conversationsTotalLabel = historyLoading ? '...' : formatCount(historyTotalEntries)
  const notesTotalLabel = formatCount(notes.length)
  const notesEstimateFromState = useMemo(() => {
    const inputRate = usageStats?.activeEnhancementInputCostPerToken
    const outputRate = usageStats?.activeEnhancementOutputCostPerToken

    if ((inputRate === null || inputRate === undefined) && (outputRate === null || outputRate === undefined)) {
      return 0
    }

    let totalCost = 0
    for (const note of notes) {
      const rawText = note.rawText.trim()
      const processedText = note.processedText.trim()
      if (!rawText || !processedText) {
        continue
      }

      const inputTokens = estimateTokensFromText(rawText)
      const outputTokens = estimateTokensFromText(processedText)
      if (inputTokens <= 0 || outputTokens <= 0) {
        continue
      }

      totalCost += inputTokens * (inputRate ?? 0) + outputTokens * (outputRate ?? 0)
    }

    return Number(totalCost.toFixed(6))
  }, [notes, usageStats?.activeEnhancementInputCostPerToken, usageStats?.activeEnhancementOutputCostPerToken])

  const transcriptionEstimateFromState = useMemo(() => {
    const fallbackRate =
      usageStats && usageStats.estimatedTranscriptionTokens > 0
        ? usageStats.estimatedTranscriptionCostUSD / usageStats.estimatedTranscriptionTokens
        : null

    let totalCost = 0
    for (const entry of historyForEstimates) {
      const tokenEstimate = estimateTokensFromText(entry.rawText?.trim() || entry.text)
      const scopedModelId = `${entry.provider}/${entry.model}`
      const unitRate =
        resolveTranscriptionTokenRateUSD(scopedModelId, usageStats) ??
        resolveTranscriptionTokenRateUSD(entry.model, usageStats) ??
        fallbackRate
      if (unitRate === null) {
        continue
      }

      totalCost += tokenEstimate * unitRate
    }

    const rounded = Number(totalCost.toFixed(6))
    if (rounded > 0) {
      return rounded
    }

    return usageStats?.estimatedTranscriptionCostUSD ?? 0
  }, [
    historyForEstimates,
    usageStats,
    usageStats?.estimatedTranscriptionCostUSD,
    usageStats?.estimatedTranscriptionTokens,
    usageStats?.modelInputCostPerTokenById,
  ])

  const transcriptionEstimate = transcriptionEstimateFromState
  const notesEstimate = notesEstimateFromState
  const dictationAggregate = useMemo(() => {
    let wordsTotal = 0
    let tokensTotal = 0
    let durationSecondsTotal = 0
    let enhancedCount = 0
    let enhancedWordsTotal = 0
    let enhancedTokensTotal = 0
    let postProcessingCostTotal = 0

    for (const entry of historyForEstimates) {
      const rawText = entry.rawText?.trim() || entry.text
      const words = estimateWordsFromText(rawText)
      const tokens = estimateTokensFromText(rawText)
      const explicitDuration =
        typeof entry.durationSeconds === 'number' && Number.isFinite(entry.durationSeconds) && entry.durationSeconds > 0
          ? entry.durationSeconds
          : null
      const postProcessingApplied = Boolean(entry.postProcessingApplied)
      const enhancedText = entry.enhancedText?.trim() || entry.text

      wordsTotal += words
      tokensTotal += tokens
      durationSecondsTotal += explicitDuration ?? estimateDurationFromWords(words, ESTIMATED_SPEAKING_WPM)

      if (postProcessingApplied && rawText && enhancedText) {
        enhancedCount += 1
        const enhancedWords = estimateWordsFromText(enhancedText)
        const enhancedTokens = estimateTokensFromText(enhancedText)
        enhancedWordsTotal += enhancedWords
        enhancedTokensTotal += enhancedTokens

        const postProviderId = entry.postProcessingProvider?.trim() || 'unknown-post-provider'
        const postModelId = entry.postProcessingModel?.trim() || 'unknown-model'
        const postScopedModelId = `${postProviderId}/${postModelId}`
        const postRates = resolveModelTokenRatesWithFallback(postScopedModelId, postModelId, usageStats)
        if (postRates.input !== null || postRates.output !== null) {
          postProcessingCostTotal += tokens * (postRates.input ?? 0) + enhancedTokens * (postRates.output ?? 0)
        }
      }
    }

    return {
      wordsTotal,
      tokensTotal,
      enhancedCount,
      enhancedWordsTotal,
      enhancedTokensTotal,
      postProcessingCostTotal: Number(postProcessingCostTotal.toFixed(6)),
      durationSecondsTotal: Number(durationSecondsTotal.toFixed(2)),
      durationMinutesTotal: Number((durationSecondsTotal / 60).toFixed(2)),
      durationHoursTotal: Number((durationSecondsTotal / 3600).toFixed(2)),
    }
  }, [historyForEstimates, usageStats])

  const dictationEnhancementEstimate = dictationAggregate.postProcessingCostTotal
  const overallUsedCost = Number((transcriptionEstimate + dictationEnhancementEstimate + notesEstimate).toFixed(6))

  const notesAggregate = useMemo(() => {
    let enhancedNotesCount = 0
    let enhancedWordsTotal = 0
    let enhancedTokensTotal = 0
    let draftNotesCount = 0

    for (const note of notes) {
      const enhancedText = note.processedText.trim()
      if (!enhancedText) {
        draftNotesCount += 1
        continue
      }

      enhancedNotesCount += 1
      enhancedWordsTotal += estimateWordsFromText(enhancedText)
      enhancedTokensTotal += estimateTokensFromText(enhancedText)
    }

    return {
      enhancedNotesCount,
      draftNotesCount,
      enhancedWordsTotal,
      enhancedTokensTotal,
    }
  }, [notes])

  const resolveCurrentPostProcessingModelMeta = useCallback(() => {
    const meta = resolvePostProcessingMetadata(settings)
    return {
      provider: meta.provider.trim() || 'unknown-post-provider',
      model: meta.model.trim() || 'unknown-model',
    }
  }, [
    settings.postProcessingCloudModelId,
    settings.postProcessingCloudProvider,
    settings.postProcessingCustomModel,
    settings.postProcessingLocalModelId,
    settings.postProcessingRuntime,
  ])

  const dictationStatsRows = useMemo<DetailedStatsCallRow[]>(() => {
    return historyForEstimates
      .map((entry) => {
        const rawText = entry.rawText?.trim() || entry.text
        const enhancedText = entry.enhancedText?.trim() || entry.text
        const words = estimateWordsFromText(rawText)
        const tokens = estimateTokensFromText(rawText)
        const durationSeconds =
          typeof entry.durationSeconds === 'number' && Number.isFinite(entry.durationSeconds) && entry.durationSeconds > 0
            ? entry.durationSeconds
            : estimateDurationFromWords(words, ESTIMATED_SPEAKING_WPM)

        const scopedModelId = `${entry.provider}/${entry.model}`
        const transcriptionRate =
          resolveTranscriptionTokenRateUSD(scopedModelId, usageStats) ??
          resolveTranscriptionTokenRateUSD(entry.model, usageStats) ??
          0
        const transcriptionCostUSD = Number((tokens * transcriptionRate).toFixed(6))

        const postProcessingApplied = Boolean(entry.postProcessingApplied)
        const postProcessingProvider = entry.postProcessingProvider?.trim() || 'unknown-post-provider'
        const postProcessingModel = entry.postProcessingModel?.trim() || 'unknown-model'
        const enhancedTokens = estimateTokensFromText(enhancedText)
        const postScopedModelId = `${postProcessingProvider}/${postProcessingModel}`
        const postRates = resolveModelTokenRatesWithFallback(postScopedModelId, postProcessingModel, usageStats)
        const postProcessingCostUSD =
          postProcessingApplied && (postRates.input !== null || postRates.output !== null)
            ? Number((tokens * (postRates.input ?? 0) + enhancedTokens * (postRates.output ?? 0)).toFixed(6))
            : 0

        const firstLine = rawText.split('\n')[0]?.trim() || 'Dictation'
        const rowTitle = firstLine.length > 120 ? `${firstLine.slice(0, 117)}...` : firstLine

        return {
          id: `dictation:${entry.id}`,
          timestamp: entry.timestamp,
          source: 'dictation' as const,
          title: rowTitle,
          provider: entry.provider,
          model: entry.model,
          durationSeconds,
          words,
          tokens,
          transcriptionCostUSD,
          postProcessingCostUSD,
          totalCostUSD: Number((transcriptionCostUSD + postProcessingCostUSD).toFixed(6)),
          postProcessingApplied,
          postProcessingProvider,
          postProcessingModel,
          estimated:
            typeof entry.durationSeconds !== 'number' ||
            !Number.isFinite(entry.durationSeconds) ||
            entry.durationSeconds <= 0,
        }
      })
      .sort((left, right) => right.timestamp - left.timestamp)
  }, [historyForEstimates, usageStats])

  const noteStatsRows = useMemo<DetailedStatsCallRow[]>(() => {
    return [...noteProcessingEvents]
      .sort((left, right) => right.timestamp - left.timestamp)
      .map((event) => ({
        id: `note:${event.id}`,
        timestamp: event.timestamp,
        source: 'note' as const,
        title: event.noteTitle,
        provider: event.provider,
        model: event.model,
        durationSeconds: event.durationSeconds,
        words: event.outputWords,
        tokens: event.outputTokens,
        transcriptionCostUSD: 0,
        postProcessingCostUSD: event.costUSD,
        totalCostUSD: event.costUSD,
        postProcessingApplied: event.postProcessingApplied,
        postProcessingProvider: event.provider,
        postProcessingModel: event.model,
        actionName: event.actionName,
        estimated: event.estimated,
      }))
  }, [noteProcessingEvents])

  const handleClearDetailedStatsLogs = useCallback(() => {
    setNoteProcessingEvents([])
  }, [])

  useEffect(() => {
    saveNoteProcessingEvents(noteProcessingEvents)
  }, [noteProcessingEvents])

  useEffect(() => {
    if (!settings.detailedStatsLoggingEnabled) {
      return
    }

    if (noteEventBackfillDoneRef.current) {
      return
    }

    noteEventBackfillDoneRef.current = true

    setNoteProcessingEvents((current) => {
      const existingIds = new Set(current.map((entry) => entry.id))
      const additions: NoteProcessingEvent[] = []
      const meta = resolveCurrentPostProcessingModelMeta()
      const scopedModelId = `${meta.provider}/${meta.model}`
      const modelRates = resolveModelTokenRatesWithFallback(scopedModelId, meta.model, usageStats)

      for (const note of notes) {
        const rawText = note.rawText.trim()
        const processedText = note.processedText.trim()
        if (!rawText || !processedText) {
          continue
        }

        const legacyEventId = `legacy:${note.id}:${note.updatedAt}`
        if (existingIds.has(legacyEventId)) {
          continue
        }

        const inputWords = estimateWordsFromText(rawText)
        const inputTokens = estimateTokensFromText(rawText)
        const outputWords = estimateWordsFromText(processedText)
        const outputTokens = estimateTokensFromText(processedText)
        const durationSeconds = estimateDurationFromWords(outputWords, ESTIMATED_READING_WPM)
        const costUSD = Number(
          (inputTokens * (modelRates.input ?? 0) + outputTokens * (modelRates.output ?? 0)).toFixed(6),
        )

        additions.push({
          id: legacyEventId,
          timestamp: note.updatedAt,
          noteId: note.id,
          noteTitle: note.title,
          actionId: null,
          actionName: 'Backfilled note entry',
          provider: meta.provider,
          model: meta.model,
          inputWords,
          inputTokens,
          outputWords,
          outputTokens,
          durationSeconds,
          postProcessingApplied: true,
          estimated: true,
          costUSD,
        })
      }

      if (additions.length === 0) {
        return current
      }

      return [...additions, ...current].sort((left, right) => right.timestamp - left.timestamp)
    })
  }, [notes, resolveCurrentPostProcessingModelMeta, settings.detailedStatsLoggingEnabled, usageStats])

  const sourceStatusLabel = usageStats?.litellmSource === 'unavailable' ? 'LiteLLM | Unavailable' : 'LiteLLM'
  const sourceStatusClass =
    usageStats?.litellmSource === 'live'
      ? 'text-emerald-400'
      : usageStats?.litellmSource === 'cache'
        ? 'text-amber-300'
        : 'text-red-400'
  const sectionTitle =
    section === 'conversations' ? t('menuConversations') : section === 'notes' ? t('menuNotes') : t('menuSettings')

  const openSection = (nextSection: PanelSection, nextSettingsNode: SettingsNodeId | null = null) => {
    setSection(nextSection)
    setSettingsNodeRequest(nextSettingsNode)
  }

  const sidebarButtonClass = (active: boolean) =>
    cn(
      'app-no-drag flex h-8 w-full items-center gap-2.5 rounded-md border border-transparent px-2.5 text-left text-[13px] leading-none transition-colors',
      active
        ? 'border-primary/40 bg-surface-2 text-foreground'
        : 'text-foreground/70 hover:bg-surface-2/70 hover:text-foreground',
    )

  return (
    <div
      className={cn(
        'flex h-screen flex-col overflow-hidden bg-surface-0 text-foreground transition-[border-radius] duration-150',
        useCustomWindowChrome ? 'border border-border-subtle' : 'border-0',
        useCustomWindowChrome && !windowMaximized ? 'rounded-[12px]' : 'rounded-none',
      )}
    >
      <header className={cn('relative flex h-10 shrink-0 items-center border-b border-border-subtle bg-surface-1 px-3', useCustomWindowChrome ? 'app-drag' : '')}>
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
                    <Icon className="pointer-events-none absolute inset-0 m-auto h-2.5 w-2.5 text-black/85 opacity-55 drop-shadow-[0_0.5px_0_rgba(255,255,255,0.35)] transition-opacity duration-150 group-hover:opacity-100" />
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
        </div>
      </header>

      {!onboardingDone ? (
        <main className="min-h-0 flex-1 overflow-y-auto p-4">
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
        </main>
      ) : (
        <main className="min-h-0 flex-1 overflow-hidden p-3">
          <div className="grid h-full min-h-0 grid-cols-[220px_minmax(0,1fr)] gap-2">
            <aside className="flex min-h-0 flex-col overflow-y-auto rounded-[10px] border border-border-subtle bg-surface-1 p-2.5 pr-2 [scrollbar-width:none] [&::-webkit-scrollbar]:hidden">
              <div className="mb-3 inline-flex items-center gap-2 px-2 text-xs font-semibold uppercase tracking-[0.14em] text-foreground/50">
                <Sparkles className="h-3.5 w-3.5 text-primary" />
                Workspace
              </div>

              <nav className="space-y-1.5">
                <button
                  type="button"
                  className={sidebarButtonClass(section === 'conversations')}
                  onClick={() => {
                    openSection('conversations')
                  }}
                >
                  <Home className="h-4 w-4" />
                  <span>Dictations</span>
                  <span className="ml-auto text-[11px] text-foreground/45">{conversationsCountLabel}</span>
                </button>

                <button
                  type="button"
                  className={sidebarButtonClass(section === 'notes')}
                  onClick={() => {
                    openSection('notes')
                  }}
                >
                  <FileText className="h-4 w-4" />
                  <span>Notes</span>
                  <span className="ml-auto text-[11px] text-foreground/45">{notesCountLabel}</span>
                </button>

              </nav>

              <div className="my-3 h-px bg-border-subtle/80" />

              <div className="space-y-2.5">
                <div className="rounded-md border border-border-subtle bg-surface-0 px-2.5 py-2">
                  <div className="mb-2 flex items-center justify-between gap-2">
                    <p className="text-[10px] font-semibold uppercase tracking-[0.12em] text-foreground/55">Dictations</p>
                    <button
                      type="button"
                      className="app-no-drag text-[10px] text-primary/90 hover:text-primary disabled:cursor-not-allowed disabled:opacity-45"
                      disabled={usageStatsLoading}
                      onClick={() => {
                        void refreshUsageStats(true)
                      }}
                    >
                      {usageStatsLoading ? '...' : 'Refresh'}
                    </button>
                  </div>
                  <div className="space-y-1.5 text-[11px] text-foreground/80">
                    <div className="grid grid-cols-[1fr_auto] items-center gap-2">
                      <span className="text-foreground/55">Count</span>
                      <span className="font-medium tabular-nums whitespace-nowrap">{conversationsTotalLabel}</span>
                    </div>
                    <div className="grid grid-cols-[1fr_auto] items-center gap-2">
                      <span className="text-foreground/55">Recorded</span>
                      <span className="font-medium tabular-nums whitespace-nowrap">{formatDurationCompact(dictationAggregate.durationSecondsTotal)}</span>
                    </div>
                    <div className="grid grid-cols-[1fr_auto] items-center gap-2">
                      <span className="text-foreground/55">Minutes / Hours</span>
                      <span className="font-medium tabular-nums whitespace-nowrap">
                        {dictationAggregate.durationMinutesTotal}m / {dictationAggregate.durationHoursTotal}h
                      </span>
                    </div>
                    <div className="grid grid-cols-[1fr_auto] items-center gap-2">
                      <span className="text-foreground/55">Words</span>
                      <span className="font-medium tabular-nums whitespace-nowrap">{formatCount(dictationAggregate.wordsTotal)}</span>
                    </div>
                    <div className="grid grid-cols-[1fr_auto] items-center gap-2">
                      <span className="text-foreground/55">Tokens</span>
                      <span className="font-medium tabular-nums whitespace-nowrap">~{formatCount(dictationAggregate.tokensTotal)}</span>
                    </div>
                    <div className="grid grid-cols-[1fr_auto] items-center gap-2">
                      <span className="text-foreground/55">Enhanced dictations</span>
                      <span className="font-medium tabular-nums whitespace-nowrap">{formatCount(dictationAggregate.enhancedCount)}</span>
                    </div>
                    <div className="grid grid-cols-[1fr_auto] items-center gap-2">
                      <span className="text-foreground/55">Enhanced words/tokens</span>
                      <span className="font-medium tabular-nums whitespace-nowrap">
                        {formatCount(dictationAggregate.enhancedWordsTotal)} / ~{formatCount(dictationAggregate.enhancedTokensTotal)}
                      </span>
                    </div>
                    <div className="grid grid-cols-[1fr_auto] items-center gap-2">
                      <span className="text-foreground/55">Dictation estimate</span>
                      <span className="font-semibold tabular-nums whitespace-nowrap">{formatCurrency(transcriptionEstimate)}</span>
                    </div>
                    <div className="grid grid-cols-[1fr_auto] items-center gap-2">
                      <span className="text-foreground/55">Post-processing enhance spent</span>
                      <span className="font-semibold tabular-nums whitespace-nowrap">{formatCurrency(dictationEnhancementEstimate)}</span>
                    </div>
                  </div>
                  <p className="mt-2 text-[10px] text-muted-foreground">Duration prefers measured recording time; fallback is words-per-minute estimation.</p>
                </div>

                <div className="rounded-md border border-border-subtle bg-surface-0 px-2.5 py-2">
                  <p className="mb-2 text-[10px] font-semibold uppercase tracking-[0.12em] text-foreground/55">Notes</p>
                  <div className="space-y-1.5 text-[11px] text-foreground/80">
                    <div className="grid grid-cols-[1fr_auto] items-center gap-2">
                      <span className="text-foreground/55">Count</span>
                      <span className="font-medium tabular-nums whitespace-nowrap">{notesTotalLabel}</span>
                    </div>
                    <div className="grid grid-cols-[1fr_auto] items-center gap-2">
                      <span className="text-foreground/55">Post-processing</span>
                      <span
                        className={cn(
                          'font-medium whitespace-nowrap',
                          settings.postProcessingEnabled ? 'text-emerald-300' : 'text-amber-300',
                        )}
                      >
                        {settings.postProcessingEnabled ? 'Enabled' : 'Disabled (N/A new runs)'}
                      </span>
                    </div>
                    <div className="grid grid-cols-[1fr_auto] items-center gap-2">
                      <span className="text-foreground/55">Enhanced notes (post-process)</span>
                      <span className="font-medium tabular-nums whitespace-nowrap">{formatCount(notesAggregate.enhancedNotesCount)}</span>
                    </div>
                    <div className="grid grid-cols-[1fr_auto] items-center gap-2">
                      <span className="text-foreground/55">Enhanced words</span>
                      <span className="font-medium tabular-nums whitespace-nowrap">{formatCount(notesAggregate.enhancedWordsTotal)}</span>
                    </div>
                    <div className="grid grid-cols-[1fr_auto] items-center gap-2">
                      <span className="text-foreground/55">Enhanced tokens</span>
                      <span className="font-medium tabular-nums whitespace-nowrap">~{formatCount(notesAggregate.enhancedTokensTotal)}</span>
                    </div>
                    <div className="grid grid-cols-[1fr_auto] items-center gap-2">
                      <span className="text-foreground/55">Draft-only notes</span>
                      <span className="font-medium tabular-nums whitespace-nowrap">{formatCount(notesAggregate.draftNotesCount)}</span>
                    </div>
                    <div className="grid grid-cols-[1fr_auto] items-center gap-2">
                      <span className="text-foreground/55">Post-processing enhance spent</span>
                      <span className="font-semibold tabular-nums whitespace-nowrap">
                        {settings.postProcessingEnabled ? formatCurrency(notesEstimate) : 'N/A'}
                      </span>
                    </div>
                    {!settings.postProcessingEnabled ? (
                      <div className="grid grid-cols-[1fr_auto] items-center gap-2">
                        <span className="text-foreground/55">Historical enhanced spent</span>
                        <span className="font-semibold tabular-nums whitespace-nowrap">{formatCurrency(notesEstimate)}</span>
                      </div>
                    ) : null}
                  </div>
                  <p className="mt-2 text-[10px] text-muted-foreground">Spend counts only notes with Enhanced output, not drafts.</p>
                </div>

                <div className="rounded-md border border-border-subtle bg-surface-0 px-2.5 py-2">
                  <p className="mb-2 text-[10px] font-semibold uppercase tracking-[0.12em] text-foreground/55">Cost source</p>
                  <div className="space-y-1.5 text-[11px] text-foreground/80">
                    <div className="grid grid-cols-[1fr_auto] items-center gap-2">
                      <span className="text-foreground/55">Source</span>
                      <span className={cn('font-semibold whitespace-nowrap', sourceStatusClass)}>{sourceStatusLabel}</span>
                    </div>
                    <div className="grid grid-cols-[1fr_auto] items-center gap-2">
                      <span className="text-foreground/55">Overall $ used</span>
                      <span className="font-semibold tabular-nums whitespace-nowrap text-foreground">{formatCurrency(overallUsedCost)}</span>
                    </div>
                    {usageStats?.litellmError ? <div className="text-[10px] text-red-300/90">{usageStats.litellmError}</div> : null}
                  </div>
                </div>
              </div>

              <div className="mt-auto space-y-1.5 border-t border-border-subtle/80 pt-3">
                <button
                  type="button"
                  className={sidebarButtonClass(section === 'settings')}
                  onClick={() => {
                    openSection('settings', 'preferences')
                  }}
                >
                  <Settings className="h-4 w-4" />
                  <span>Settings</span>
                </button>

                <button
                  type="button"
                  className={sidebarButtonClass(false)}
                  onClick={() => {
                    void handleQuitApplication()
                  }}
                >
                  <Power className="h-4 w-4" />
                  <span>Quit</span>
                </button>
              </div>
            </aside>

            <section
              className={cn(
                'min-h-0 overflow-hidden rounded-[10px] border border-border-subtle bg-surface-1',
                section === 'notes' ? 'p-2.5' : 'p-4',
              )}
            >
              <div
                className={cn(
                  'flex h-full min-h-0 flex-col',
                  section === 'conversations'
                    ? 'overflow-y-auto pr-1 [scrollbar-width:none] [&::-webkit-scrollbar]:hidden'
                    : undefined,
                )}
              >
                <div className={cn('flex items-center gap-2', section === 'notes' ? 'pl-2' : undefined)}>
                  <div className="flex items-center gap-2">
                    <h1 className="text-base font-semibold">{sectionTitle}</h1>
                    {section === 'conversations' ? (
                      <span className="inline-flex min-w-6 items-center justify-center rounded-full border border-primary/30 bg-primary/15 px-1.5 text-[11px] font-semibold text-primary">
                        {conversationsCountLabel}
                      </span>
                    ) : null}
                    {section === 'notes' ? (
                      <span className="inline-flex min-w-6 items-center justify-center rounded-full border border-primary/30 bg-primary/15 px-1.5 text-[11px] font-semibold text-primary">
                        {notesCountLabel}
                      </span>
                    ) : null}
                    {section === 'conversations' ? (
                      <label className="inline-flex items-center gap-2 rounded-md border border-border-subtle bg-surface-1 px-2 py-1 text-xs text-muted-foreground">
                        <span>Retention</span>
                        <select
                          className="app-no-drag h-7 rounded border border-border-subtle bg-surface-0 px-2 text-xs text-foreground"
                          value={String(settings.historyRetentionLimit)}
                          onChange={(event) => {
                            handleSettingsChange({
                              historyRetentionLimit: Number(event.target.value),
                            })
                          }}
                        >
                          {HISTORY_RETENTION_OPTIONS.map((option) => (
                            <option key={option.value} value={option.value}>
                              {option.label}
                            </option>
                          ))}
                        </select>
                      </label>
                    ) : null}
                    {section === 'conversations' ? (
                      <Button
                        variant="ghost"
                        size="sm"
                        onClick={() => {
                          setHistoryClearConfirmOpen(true)
                        }}
                        disabled={historyTotalEntries === 0}
                      >
                        <Trash2 className="h-3.5 w-3.5" />
                        Clear dictations
                      </Button>
                    ) : null}
                  </div>
                </div>

                <div
                  className={cn(
                    'mt-3 min-h-0',
                    section === 'settings' ? 'flex-1 overflow-hidden' : undefined,
                    section === 'notes' ? 'flex-1 overflow-hidden' : undefined,
                  )}
                >
                  {section === 'settings' ? <div className="h-full min-h-0">{renderSection()}</div> : renderSection()}
                </div>
              </div>
            </section>

          </div>
        </main>
      )}
    </div>
  )
}

export const ControlPanelView = () => (
  <ToastProvider>
    <ControlPanelScene />
  </ToastProvider>
)
