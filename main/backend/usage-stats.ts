import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname } from 'node:path'
import { estimateTokensFromText, type AppSettings, type HistoryEntry } from '../../shared/app'
import type { AppUsageModelBreakdownPayload, AppUsageStatsPayload, NoteEntryPayload, NoteFolderPayload } from '../../shared/ipc'

const CACHE_TTL_MS = 24 * 60 * 60 * 1000
const LITELLM_PRICING_URL =
  'https://raw.githubusercontent.com/BerriAI/litellm/main/model_prices_and_context_window.json'

const MODEL_LOOKUP_PREFIXES = [
  'openai/',
  'azure/',
  'anthropic/',
  'gemini/',
  'google/',
  'groq/',
  'xai/',
  'vertex_ai/',
  'bedrock/',
  'openrouter/',
  'openrouter/openai/',
  'together_ai/',
  'fireworks_ai/',
  'mistral/',
  'deepseek/',
  'cohere/',
  'replicate/',
  'ai21/',
  'cerebras/',
]

interface LiteLLMModelPricing {
  input_cost_per_token?: number
  output_cost_per_token?: number
  cache_creation_input_token_cost?: number
  cache_read_input_token_cost?: number
  input_cost_per_token_above_200k_tokens?: number
  output_cost_per_token_above_200k_tokens?: number
  cache_creation_input_token_cost_above_200k_tokens?: number
  cache_read_input_token_cost_above_200k_tokens?: number
  input_cost_per_token_above_128k_tokens?: number
  output_cost_per_token_above_128k_tokens?: number
  max_input_tokens?: number
  max_output_tokens?: number
  max_tokens?: number
}

interface LiteLLMPricingCatalogSnapshot {
  capturedAt: number
  sourceUrl: string
  models: Record<string, LiteLLMModelPricing>
}

interface UsageCacheSnapshot {
  capturedAt: number
  pricingCatalog: LiteLLMPricingCatalogSnapshot
}

interface PricingCatalogResult {
  source: AppUsageStatsPayload['litellmSource']
  capturedAt: number | null
  models: Map<string, LiteLLMModelPricing>
  modelsLower: Map<string, LiteLLMModelPricing>
  error?: string
}

interface ModelUsageAccumulator {
  model: string
  scope: AppUsageModelBreakdownPayload['scope']
  calls: number
  inputTokens: number
  outputTokens: number
}

const normalizeNumeric = (value: unknown): number | null => {
  if (typeof value === 'number' && Number.isFinite(value)) {
    return value
  }

  if (typeof value === 'string') {
    const parsed = Number.parseFloat(value)
    return Number.isFinite(parsed) ? parsed : null
  }

  return null
}

const sumBy = <T>(entries: T[], iteratee: (entry: T) => number) => entries.reduce((sum, entry) => sum + iteratee(entry), 0)

const classifyModelScope = (modelId: string): AppUsageModelBreakdownPayload['scope'] => {
  const normalized = modelId.toLowerCase()
  if (
    normalized.includes('transcribe') ||
    normalized.includes('whisper') ||
    normalized.includes('stt') ||
    normalized.includes('speech')
  ) {
    return 'transcription'
  }

  if (
    normalized.includes('gpt') ||
    normalized.includes('llama') ||
    normalized.includes('mixtral') ||
    normalized.includes('qwen') ||
    normalized.includes('grok') ||
    normalized.includes('gemini') ||
    normalized.includes('claude') ||
    normalized.includes('o3') ||
    normalized.includes('o4') ||
    normalized.includes('o1')
  ) {
    return 'llm'
  }

  return 'unknown'
}

const toCompactErrorMessage = (error: unknown) => {
  const message = error instanceof Error ? error.message : String(error)
  return message.replace(/\s+/g, ' ').trim().slice(0, 800)
}

const isLikelyLiteLLMModelPricing = (value: unknown): value is LiteLLMModelPricing => {
  if (typeof value !== 'object' || value === null) {
    return false
  }

  const typed = value as Record<string, unknown>
  return (
    normalizeNumeric(typed.input_cost_per_token) !== null ||
    normalizeNumeric(typed.output_cost_per_token) !== null ||
    normalizeNumeric(typed.input_cost_per_token_above_200k_tokens) !== null ||
    normalizeNumeric(typed.output_cost_per_token_above_200k_tokens) !== null ||
    normalizeNumeric(typed.input_cost_per_token_above_128k_tokens) !== null ||
    normalizeNumeric(typed.output_cost_per_token_above_128k_tokens) !== null
  )
}

const normalizePricingRecord = (value: Record<string, unknown>): LiteLLMModelPricing => ({
  input_cost_per_token: normalizeNumeric(value.input_cost_per_token) ?? undefined,
  output_cost_per_token: normalizeNumeric(value.output_cost_per_token) ?? undefined,
  cache_creation_input_token_cost: normalizeNumeric(value.cache_creation_input_token_cost) ?? undefined,
  cache_read_input_token_cost: normalizeNumeric(value.cache_read_input_token_cost) ?? undefined,
  input_cost_per_token_above_200k_tokens: normalizeNumeric(value.input_cost_per_token_above_200k_tokens) ?? undefined,
  output_cost_per_token_above_200k_tokens: normalizeNumeric(value.output_cost_per_token_above_200k_tokens) ?? undefined,
  cache_creation_input_token_cost_above_200k_tokens:
    normalizeNumeric(value.cache_creation_input_token_cost_above_200k_tokens) ?? undefined,
  cache_read_input_token_cost_above_200k_tokens:
    normalizeNumeric(value.cache_read_input_token_cost_above_200k_tokens) ?? undefined,
  input_cost_per_token_above_128k_tokens: normalizeNumeric(value.input_cost_per_token_above_128k_tokens) ?? undefined,
  output_cost_per_token_above_128k_tokens: normalizeNumeric(value.output_cost_per_token_above_128k_tokens) ?? undefined,
  max_input_tokens: normalizeNumeric(value.max_input_tokens) ?? undefined,
  max_output_tokens: normalizeNumeric(value.max_output_tokens) ?? undefined,
  max_tokens: normalizeNumeric(value.max_tokens) ?? undefined,
})

const createPricingMaps = (models: Record<string, LiteLLMModelPricing>) => {
  const directMap = new Map<string, LiteLLMModelPricing>()
  const lowerMap = new Map<string, LiteLLMModelPricing>()

  for (const [key, value] of Object.entries(models)) {
    const normalizedKey = key.trim()
    if (!normalizedKey) {
      continue
    }

    directMap.set(normalizedKey, value)
    lowerMap.set(normalizedKey.toLowerCase(), value)
  }

  return {
    directMap,
    lowerMap,
  }
}

const createModelLookupCandidates = (modelId: string) => {
  const trimmed = modelId.trim()
  const candidates = new Set<string>()

  if (!trimmed) {
    return candidates
  }

  candidates.add(trimmed)

  const withoutModelsPrefix = trimmed.replace(/^models\//i, '')
  candidates.add(withoutModelsPrefix)

  const slashSuffix = withoutModelsPrefix.split('/').at(-1)
  if (slashSuffix) {
    candidates.add(slashSuffix)
  }

  const colonSuffix = withoutModelsPrefix.split(':').at(-1)
  if (colonSuffix) {
    candidates.add(colonSuffix)
  }

  const baseToken = slashSuffix ?? colonSuffix ?? withoutModelsPrefix
  for (const prefix of MODEL_LOOKUP_PREFIXES) {
    candidates.add(`${prefix}${baseToken}`)
  }

  return candidates
}

const extractModelIdFromScopedLabel = (value: string) => {
  const trimmed = value.trim()
  if (!trimmed) {
    return trimmed
  }

  const slashToken = trimmed.split('/').at(-1)?.trim()
  return slashToken && slashToken.length > 0 ? slashToken : trimmed
}

const resolvePricingForModel = (
  modelId: string,
  pricingMap: Map<string, LiteLLMModelPricing>,
  pricingLowerMap: Map<string, LiteLLMModelPricing>,
) => {
  const candidates = createModelLookupCandidates(modelId)

  for (const candidate of candidates) {
    const directMatch = pricingMap.get(candidate)
    if (directMatch) {
      return directMatch
    }

    const lowerMatch = pricingLowerMap.get(candidate.toLowerCase())
    if (lowerMatch) {
      return lowerMatch
    }
  }

  const loweredCandidates = Array.from(candidates).map((candidate) => candidate.toLowerCase())
  for (const [key, pricing] of pricingLowerMap) {
    for (const candidate of loweredCandidates) {
      if (candidate.length < 3) {
        continue
      }

      if (key.includes(candidate) || candidate.includes(key)) {
        return pricing
      }
    }
  }

  return null
}

const AUDIO_MODEL_FALLBACK_PRICING: Record<string, LiteLLMModelPricing> = {
  'whisper-large-v3-turbo': { input_cost_per_token: 0.000004, output_cost_per_token: 0 },
  'whisper-large-v3': { input_cost_per_token: 0.000004, output_cost_per_token: 0 },
  'whisper-1': { input_cost_per_token: 0.000006, output_cost_per_token: 0 },
  'distil-whisper-large-v3-en': { input_cost_per_token: 0.000002, output_cost_per_token: 0 },
}

const resolvePricingWithFallback = (
  modelId: string,
  pricingMap: Map<string, LiteLLMModelPricing>,
  pricingLowerMap: Map<string, LiteLLMModelPricing>,
): LiteLLMModelPricing | null => {
  const litellmResult = resolvePricingForModel(modelId, pricingMap, pricingLowerMap)
  if (litellmResult) return litellmResult

  const baseId = modelId.split('/').at(-1)?.toLowerCase() ?? modelId.toLowerCase()
  return AUDIO_MODEL_FALLBACK_PRICING[baseId] ?? null
}

const calculateTieredTokenCost = (
  tokenCount: number,
  basePrice: number | undefined,
  above200kPrice: number | undefined,
  above128kPrice: number | undefined,
) => {
  if (tokenCount <= 0) {
    return 0
  }

  if (above200kPrice !== undefined) {
    const threshold = 200_000
    const tokensBelow = Math.min(tokenCount, threshold)
    const tokensAbove = Math.max(0, tokenCount - threshold)
    return tokensAbove * above200kPrice + tokensBelow * (basePrice ?? 0)
  }

  if (above128kPrice !== undefined) {
    const threshold = 128_000
    const tokensBelow = Math.min(tokenCount, threshold)
    const tokensAbove = Math.max(0, tokenCount - threshold)
    return tokensAbove * above128kPrice + tokensBelow * (basePrice ?? 0)
  }

  return tokenCount * (basePrice ?? 0)
}

const calculateCostFromPricing = (
  pricing: LiteLLMModelPricing,
  inputTokens: number,
  outputTokens: number,
) => {
  const inputCost = calculateTieredTokenCost(
    inputTokens,
    pricing.input_cost_per_token,
    pricing.input_cost_per_token_above_200k_tokens,
    pricing.input_cost_per_token_above_128k_tokens,
  )

  const outputCost = calculateTieredTokenCost(
    outputTokens,
    pricing.output_cost_per_token,
    pricing.output_cost_per_token_above_200k_tokens,
    pricing.output_cost_per_token_above_128k_tokens,
  )

  return inputCost + outputCost
}

export class UsageStatsService {
  constructor(private readonly cacheFilePath: string) {}

  async getStats(
    settings: AppSettings,
    history: HistoryEntry[],
    notes: NoteEntryPayload[],
    folders: NoteFolderPayload[],
    forceRefresh = false,
  ): Promise<AppUsageStatsPayload> {
    const modelUsage = this.buildModelUsage(settings, history, notes)
    const pricingCatalog = await this.loadPricingCatalog(forceRefresh)
    const activeEnhancementModel =
      (settings.postProcessingRuntime === 'cloud' ? settings.postProcessingCloudModelId : settings.postProcessingLocalModelId).trim() ||
      'unknown-model'
    const activeEnhancementPricing = resolvePricingWithFallback(
      activeEnhancementModel,
      pricingCatalog.models,
      pricingCatalog.modelsLower,
    )

    let transcriptionCost = 0
    let enhancementCost = 0
    let unresolvedModels = 0
    const modelInputCostPerTokenById: Record<string, number | null> = {}
    const modelOutputCostPerTokenById: Record<string, number | null> = {}

    const topModels = Array.from(modelUsage.values())
      .map<AppUsageModelBreakdownPayload>((usage) => {
        const scopedModelId = usage.model
        const baseModelId = extractModelIdFromScopedLabel(scopedModelId)
        const pricing =
          resolvePricingWithFallback(baseModelId, pricingCatalog.models, pricingCatalog.modelsLower) ??
          resolvePricingWithFallback(scopedModelId, pricingCatalog.models, pricingCatalog.modelsLower)
        const costUSD = pricing ? calculateCostFromPricing(pricing, usage.inputTokens, usage.outputTokens) : 0

        modelInputCostPerTokenById[scopedModelId] = pricing?.input_cost_per_token ?? null
        modelOutputCostPerTokenById[scopedModelId] = pricing?.output_cost_per_token ?? null
        modelInputCostPerTokenById[baseModelId] = pricing?.input_cost_per_token ?? null
        modelOutputCostPerTokenById[baseModelId] = pricing?.output_cost_per_token ?? null

        if (!pricing) {
          unresolvedModels += 1
        }

        if (usage.scope === 'transcription') {
          transcriptionCost += costUSD
        } else if (usage.scope === 'llm') {
          enhancementCost += costUSD
        }

        return {
          model: usage.model,
          scope: usage.scope,
          calls: usage.calls,
          tokens: usage.inputTokens + usage.outputTokens,
          costUSD: Number(costUSD.toFixed(6)),
        }
      })
      .sort((left, right) => right.costUSD - left.costUSD || right.tokens - left.tokens)
      .slice(0, 8)

    const llmUsageEntries = Array.from(modelUsage.values()).filter((entry) => entry.scope === 'llm')
    const enhancementInputTokens = sumBy(llmUsageEntries, (entry) => entry.inputTokens)
    const enhancementOutputTokens = sumBy(llmUsageEntries, (entry) => entry.outputTokens)
    const transcriptionTokens = sumBy(history, (entry) => estimateTokensFromText(entry.rawText?.trim() || entry.text))

    const pricingUnavailable = pricingCatalog.source === 'unavailable'
    const litellmError =
      pricingCatalog.error ??
      (pricingUnavailable ? 'Unable to load LiteLLM pricing dataset.' : unresolvedModels > 0 ? `${unresolvedModels} model(s) missing in LiteLLM pricing catalog.` : undefined)

    return {
      generatedAt: Date.now(),
      conversationsCount: history.length,
      notesCount: notes.length,
      foldersCount: folders.length,
      estimatedTranscriptionTokens: transcriptionTokens,
      estimatedTranscriptionCostUSD: Number((pricingUnavailable ? 0 : transcriptionCost).toFixed(6)),
      estimatedEnhancementTokens: enhancementInputTokens + enhancementOutputTokens,
      estimatedEnhancementCostUSD: Number((pricingUnavailable ? 0 : enhancementCost).toFixed(6)),
      activeEnhancementModel,
      activeEnhancementInputCostPerToken: activeEnhancementPricing?.input_cost_per_token ?? null,
      activeEnhancementOutputCostPerToken: activeEnhancementPricing?.output_cost_per_token ?? null,
      modelInputCostPerTokenById,
      modelOutputCostPerTokenById,
      litellmSource: pricingCatalog.source,
      litellmLastSyncAt: pricingCatalog.capturedAt,
      litellmTranscriptionCostUSD: pricingUnavailable ? null : Number(transcriptionCost.toFixed(6)),
      litellmLlmCostUSD: pricingUnavailable ? null : Number(enhancementCost.toFixed(6)),
      litellmTotalCostUSD: pricingUnavailable ? null : Number((transcriptionCost + enhancementCost).toFixed(6)),
      litellmError,
      topModels,
    }
  }

  private buildModelUsage(settings: AppSettings, history: HistoryEntry[], notes: NoteEntryPayload[]) {
    const usageMap = new Map<string, ModelUsageAccumulator>()

    for (const entry of history) {
      const transcriptionProvider = entry.provider.trim() || 'unknown-provider'
      const transcriptionModel = entry.model.trim() || 'unknown-model'
      const transcriptionScopedModel = `${transcriptionProvider}/${transcriptionModel}`
      const dictationRawText = entry.rawText?.trim() || entry.text
      this.accumulateModelUsage(usageMap, transcriptionScopedModel, 'transcription', estimateTokensFromText(dictationRawText), 0)

      const postProcessingApplied = Boolean(entry.postProcessingApplied)
      const dictationEnhancedText = entry.enhancedText?.trim() || entry.text
      const dictationInputTokens = estimateTokensFromText(dictationRawText)
      const dictationOutputTokens = estimateTokensFromText(dictationEnhancedText)

      if (postProcessingApplied && dictationInputTokens > 0 && dictationOutputTokens > 0) {
        const postProcessingProvider = entry.postProcessingProvider?.trim() || 'unknown-post-provider'
        const postProcessingModelId = entry.postProcessingModel?.trim() || 'unknown-model'
        const postProcessingScopedModel = `${postProcessingProvider}/${postProcessingModelId}`

        this.accumulateModelUsage(
          usageMap,
          postProcessingScopedModel,
          'llm',
          dictationInputTokens,
          dictationOutputTokens,
        )
      }
    }

    const enhancementModelId =
      (settings.postProcessingRuntime === 'cloud' ? settings.postProcessingCloudModelId : settings.postProcessingLocalModelId).trim() ||
      'unknown-model'

    for (const note of notes) {
      if (!note.rawText.trim() || !note.processedText.trim()) {
        continue
      }

      const inputTokens = estimateTokensFromText(note.rawText)
      const outputTokens = estimateTokensFromText(note.processedText)

      if (inputTokens <= 0 || outputTokens <= 0) {
        continue
      }

      this.accumulateModelUsage(
        usageMap,
        enhancementModelId,
        classifyModelScope(enhancementModelId) === 'transcription' ? 'transcription' : 'llm',
        inputTokens,
        outputTokens,
      )
    }

    return usageMap
  }

  private accumulateModelUsage(
    usageMap: Map<string, ModelUsageAccumulator>,
    modelId: string,
    scope: AppUsageModelBreakdownPayload['scope'],
    inputTokens: number,
    outputTokens: number,
  ) {
    const current = usageMap.get(modelId) ?? {
      model: modelId,
      scope,
      calls: 0,
      inputTokens: 0,
      outputTokens: 0,
    }

    current.calls += 1
    current.inputTokens += Math.max(0, inputTokens)
    current.outputTokens += Math.max(0, outputTokens)

    if (current.scope === 'unknown' && scope !== 'unknown') {
      current.scope = scope
    }

    usageMap.set(modelId, current)
  }

  private async loadPricingCatalog(forceRefresh: boolean): Promise<PricingCatalogResult> {
    const cachedSnapshot = this.readCache()
    const now = Date.now()

    const hasFreshCache = Boolean(cachedSnapshot && now - cachedSnapshot.capturedAt < CACHE_TTL_MS)
    if (!forceRefresh && hasFreshCache && cachedSnapshot) {
      const maps = createPricingMaps(cachedSnapshot.pricingCatalog.models)
      return {
        source: 'cache',
        capturedAt: cachedSnapshot.pricingCatalog.capturedAt,
        models: maps.directMap,
        modelsLower: maps.lowerMap,
      }
    }

    try {
      const response = await fetch(LITELLM_PRICING_URL)
      if (!response.ok) {
        const responseBody = (await response.text().catch(() => '')).replace(/\s+/g, ' ').trim().slice(0, 200)
        throw new Error(
          `LiteLLM pricing fetch failed: HTTP ${response.status}${response.statusText ? ` ${response.statusText}` : ''}${responseBody ? `; body=${responseBody}` : ''}`,
        )
      }

      const parsedPayload = (await response.json()) as unknown
      if (typeof parsedPayload !== 'object' || parsedPayload === null || Array.isArray(parsedPayload)) {
        throw new Error('LiteLLM pricing payload is not a valid object map.')
      }

      const modelRecords: Record<string, LiteLLMModelPricing> = {}
      for (const [modelName, value] of Object.entries(parsedPayload as Record<string, unknown>)) {
        if (!isLikelyLiteLLMModelPricing(value)) {
          continue
        }

        modelRecords[modelName] = normalizePricingRecord(value as Record<string, unknown>)
      }

      if (Object.keys(modelRecords).length === 0) {
        throw new Error('LiteLLM pricing payload did not contain valid model pricing records.')
      }

      const snapshot: UsageCacheSnapshot = {
        capturedAt: now,
        pricingCatalog: {
          capturedAt: now,
          sourceUrl: LITELLM_PRICING_URL,
          models: modelRecords,
        },
      }

      this.writeCache(snapshot)

      const maps = createPricingMaps(modelRecords)
      return {
        source: 'live',
        capturedAt: now,
        models: maps.directMap,
        modelsLower: maps.lowerMap,
      }
    } catch (error: unknown) {
      if (cachedSnapshot) {
        const maps = createPricingMaps(cachedSnapshot.pricingCatalog.models)
        return {
          source: 'cache',
          capturedAt: cachedSnapshot.pricingCatalog.capturedAt,
          models: maps.directMap,
          modelsLower: maps.lowerMap,
          error: `Pricing refresh failed, using cache: ${toCompactErrorMessage(error)}`,
        }
      }

      return {
        source: 'unavailable',
        capturedAt: null,
        models: new Map(),
        modelsLower: new Map(),
        error: toCompactErrorMessage(error),
      }
    }
  }

  private readCache(): UsageCacheSnapshot | null {
    if (!existsSync(this.cacheFilePath)) {
      return null
    }

    try {
      const parsed = JSON.parse(readFileSync(this.cacheFilePath, 'utf8')) as UsageCacheSnapshot
      if (typeof parsed?.capturedAt !== 'number' || typeof parsed?.pricingCatalog?.capturedAt !== 'number') {
        return null
      }

      if (typeof parsed.pricingCatalog.sourceUrl !== 'string' || typeof parsed.pricingCatalog.models !== 'object') {
        return null
      }

      return parsed
    } catch {
      return null
    }
  }

  private writeCache(snapshot: UsageCacheSnapshot) {
    mkdirSync(dirname(this.cacheFilePath), { recursive: true })
    writeFileSync(this.cacheFilePath, `${JSON.stringify(snapshot, null, 2)}\n`, 'utf8')
  }
}
