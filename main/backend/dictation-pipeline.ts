import { createReadStream, existsSync, readFileSync, rmSync } from 'node:fs'
import { spawnSync } from 'node:child_process'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import OpenAI from 'openai'
import type { AppSettings, DictationResult } from '../../shared/app'
import type { LocalModelScope } from '../../shared/ipc'
import {
  CUSTOM_MODEL_FETCH_ERROR,
  deriveModelsEndpointFromBaseUrl,
  extractModelIdsFromPayload,
} from '../../shared/model-discovery'
import type { DebugLogCategory } from './debug-logger'
import type { WhisperRuntimeVariant } from './model-files'

interface PromptTestResult {
  route: 'normal' | 'agent' | 'translation'
  output: string
}

interface OpenAICompatibleConfig {
  baseURL: string
  apiKey: string
  model: string
  providerLabel: string
}

interface DictationPipelineDependencies {
  loadSettings: () => Promise<AppSettings>
  resolveLocalModelPath: (scope: LocalModelScope, modelId: string) => string | null
  resolveWhisperRuntimePath?: (variant: WhisperRuntimeVariant) => string | null
  transcribeWithWhisperServer?: (
    audioFilePath: string,
    modelPath: string,
    runtimeVariant: WhisperRuntimeVariant,
    promptHint?: string,
  ) => Promise<string>
  detectActiveApp: () => Promise<string>
  log?: (category: DebugLogCategory, message: string, details?: unknown) => void
}

interface PromptRouteResolution {
  route: 'normal' | 'agent' | 'translation'
  prompt: string
  input: string
}

const RETRYABLE_HTTP_STATUSES = new Set([408, 409, 425, 429, 500, 502, 503, 504])
const CLOUD_REQUEST_MAX_ATTEMPTS = 3
const CLOUD_REQUEST_BASE_BACKOFF_MS = 400

const OPENAI_COMPATIBLE_BASE_URLS: Record<string, string> = {
  openai: 'https://api.openai.com/v1',
  groq: 'https://api.groq.com/openai/v1',
  grok: 'https://api.x.ai/v1',
  meta: 'https://api.llama.com/compat/v1',
}

const DEFAULT_TRANSCRIPTION_MODEL_BY_PROVIDER: Record<string, string> = {
  openai: 'gpt-4o-transcribe',
  groq: 'whisper-large-v3',
  grok: 'grok-voice-beta',
  meta: 'seamless-m4t-v2',
}

const resolveTranscriptionCloudModel = (providerId: string, modelId: string) => {
  const fallbackModel = DEFAULT_TRANSCRIPTION_MODEL_BY_PROVIDER[providerId] ?? 'whisper-1'
  const requestedModel = modelId.trim()
  if (!requestedModel) {
    return fallbackModel
  }

  if (providerId === 'openai' && /tts/i.test(requestedModel) && !/transcribe/i.test(requestedModel)) {
    return fallbackModel
  }

  return requestedModel
}

const normalizeOpenAIBaseURL = (baseUrl: string) => {
  let parsedUrl: URL
  try {
    parsedUrl = new URL(baseUrl.trim())
  } catch {
    return null
  }

  const normalizedPath = parsedUrl.pathname
    .replace(/\/+$/, '')
    .replace(/\/v1\/(audio\/transcriptions|transcriptions|chat\/completions|completions|models)$/i, '/v1')
    .replace(/\/models$/i, '')

  parsedUrl.pathname = normalizedPath || '/v1'
  parsedUrl.search = ''
  parsedUrl.hash = ''
  return parsedUrl.toString().replace(/\/+$/, '')
}

const applyDictionaryRules = (text: string, rules: AppSettings['postProcessingDictionaryRules']) => {
  return rules.reduce((currentText, rule) => {
    const source = rule.source.trim()
    if (!source) {
      return currentText
    }

    const escapedSource = source.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
    return currentText.replace(new RegExp(escapedSource, 'gi'), rule.target)
  }, text)
}

const normalizeDictionaryRules = (rules: AppSettings['postProcessingDictionaryRules']) => {
  return rules
    .map((rule) => ({
      source: rule.source.trim(),
      target: rule.target.trim(),
    }))
    .filter((rule) => rule.source.length > 0 && rule.target.length > 0)
}

const buildTranscriptionDictionaryHint = (settings: AppSettings) => {
  if (!settings.postProcessingDictionaryEnabled) {
    return null
  }

  const normalizedRules = normalizeDictionaryRules(settings.postProcessingDictionaryRules)
  if (normalizedRules.length === 0) {
    return null
  }

  const uniqueTerms: string[] = []
  const seenTerms = new Set<string>()

  for (const rule of normalizedRules) {
    for (const candidateTerm of [rule.source, rule.target]) {
      const normalizedTerm = candidateTerm.replace(/\s+/g, ' ').trim()
      const lookupKey = normalizedTerm.toLowerCase()

      if (!lookupKey || seenTerms.has(lookupKey)) {
        continue
      }

      seenTerms.add(lookupKey)
      uniqueTerms.push(normalizedTerm)

      if (uniqueTerms.length >= 80) {
        break
      }
    }

    if (uniqueTerms.length >= 80) {
      break
    }
  }

  if (uniqueTerms.length === 0) {
    return null
  }

  let hint = ''
  for (const term of uniqueTerms) {
    const nextHint = hint ? `${hint}, ${term}` : term
    if (nextHint.length > 1200) {
      break
    }

    hint = nextHint
  }

  return hint.trim().length > 0 ? hint : null
}

const buildPromptWithDictionaryRules = (settings: AppSettings, prompt: string) => {
  if (!settings.postProcessingDictionaryEnabled) {
    return prompt
  }

  const normalizedRules = normalizeDictionaryRules(settings.postProcessingDictionaryRules)
  if (normalizedRules.length === 0) {
    return prompt
  }

  const formattedRules = normalizedRules
    .slice(0, 60)
    .map((rule) => `- "${rule.source}" -> "${rule.target}"`)
    .join('\n')

  return `${prompt}\n\nTerminology rules:\n${formattedRules}\nApply these rules consistently when relevant. Return plain text only.`
}

const getTranscriptionCloudConfig = (settings: AppSettings): OpenAICompatibleConfig => {
  if (settings.transcriptionCloudProvider === 'custom') {
    const normalizedBaseURL = normalizeOpenAIBaseURL(settings.transcriptionCustomBaseUrl)
    if (!normalizedBaseURL || !settings.transcriptionCustomApiKey.trim()) {
      throw new Error('Custom transcription provider is not configured correctly.')
    }

    return {
      baseURL: normalizedBaseURL,
      apiKey: settings.transcriptionCustomApiKey.trim(),
      model: settings.transcriptionCustomModel.trim() || settings.transcriptionCloudModelId,
      providerLabel: 'Custom',
    }
  }

  const baseURL = OPENAI_COMPATIBLE_BASE_URLS[settings.transcriptionCloudProvider]
  const apiKeyByProvider: Record<string, string> = {
    openai: settings.transcriptionOpenAIApiKey,
    groq: settings.transcriptionGroqApiKey,
    grok: settings.transcriptionGrokApiKey,
    meta: settings.transcriptionMetaApiKey,
  }

  const apiKey = apiKeyByProvider[settings.transcriptionCloudProvider]?.trim()

  if (!baseURL || !apiKey) {
    throw new Error(`Missing transcription API configuration for provider: ${settings.transcriptionCloudProvider}`)
  }

  return {
    baseURL,
    apiKey,
    model: resolveTranscriptionCloudModel(settings.transcriptionCloudProvider, settings.transcriptionCloudModelId),
    providerLabel: settings.transcriptionCloudProvider,
  }
}

const getPostProcessingCloudConfig = (settings: AppSettings): OpenAICompatibleConfig => {
  if (settings.postProcessingCloudProvider === 'custom') {
    const normalizedBaseURL = normalizeOpenAIBaseURL(settings.postProcessingCustomBaseUrl)
    if (!normalizedBaseURL || !settings.postProcessingCustomApiKey.trim()) {
      throw new Error('Custom post-processing provider is not configured correctly.')
    }

    return {
      baseURL: normalizedBaseURL,
      apiKey: settings.postProcessingCustomApiKey.trim(),
      model: settings.postProcessingCustomModel.trim() || settings.postProcessingCloudModelId,
      providerLabel: 'Custom',
    }
  }

  const baseURL = OPENAI_COMPATIBLE_BASE_URLS[settings.postProcessingCloudProvider]
  const apiKeyByProvider: Record<string, string> = {
    openai: settings.postProcessingOpenAIApiKey,
    groq: settings.postProcessingGroqApiKey,
    grok: settings.postProcessingGrokApiKey,
    meta: settings.postProcessingMetaApiKey,
  }

  const apiKey = apiKeyByProvider[settings.postProcessingCloudProvider]?.trim()

  if (!baseURL || !apiKey) {
    throw new Error(`Missing post-processing API configuration for provider: ${settings.postProcessingCloudProvider}`)
  }

  return {
    baseURL,
    apiKey,
    model: settings.postProcessingCloudModelId,
    providerLabel: settings.postProcessingCloudProvider,
  }
}

const createOpenAIClient = (config: OpenAICompatibleConfig) => {
  return new OpenAI({
    apiKey: config.apiKey,
    baseURL: config.baseURL,
    maxRetries: 0,
    timeout: 60_000,
  })
}

const delay = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms))

const extractStatusCode = (error: unknown) => {
  if (!error || typeof error !== 'object') {
    return null
  }

  const status = (error as { status?: unknown }).status
  if (typeof status === 'number') {
    return status
  }

  const statusCode = (error as { statusCode?: unknown }).statusCode
  if (typeof statusCode === 'number') {
    return statusCode
  }

  return null
}

const isRetryableCloudError = (error: unknown) => {
  const statusCode = extractStatusCode(error)
  if (statusCode !== null && RETRYABLE_HTTP_STATUSES.has(statusCode)) {
    return true
  }

  if (!(error instanceof Error)) {
    return false
  }

  const normalizedMessage = error.message.toLowerCase()
  return [
    'timeout',
    'timed out',
    'network',
    'socket hang up',
    'econnreset',
    'temporarily unavailable',
    'rate limit',
  ].some((token) => normalizedMessage.includes(token))
}

const toErrorMessage = (error: unknown) => {
  if (error instanceof Error) {
    return error.message
  }

  return String(error)
}

const isUnsupportedTranscriptionPromptError = (error: unknown) => {
  const statusCode = extractStatusCode(error)
  if (statusCode !== 400 && statusCode !== 422) {
    return false
  }

  const message = toErrorMessage(error).toLowerCase()
  if (!message.includes('prompt')) {
    return false
  }

  return ['unsupported', 'unknown', 'invalid', 'not allowed', 'additional properties'].some((token) =>
    message.includes(token),
  )
}

const calculateBackoffMs = (attempt: number) => {
  const exponent = Math.max(0, attempt - 1)
  const jitter = Math.floor(Math.random() * 120)
  return CLOUD_REQUEST_BASE_BACKOFF_MS * 2 ** exponent + jitter
}

const executeWithCloudRetry = async <T>(
  operationName: string,
  action: () => Promise<T>,
  log?: DictationPipelineDependencies['log'],
) => {
  let lastError: unknown = null

  for (let attempt = 1; attempt <= CLOUD_REQUEST_MAX_ATTEMPTS; attempt += 1) {
    try {
      if (attempt > 1) {
        log?.('api-request', `Retrying ${operationName}`, {
          attempt,
          maxAttempts: CLOUD_REQUEST_MAX_ATTEMPTS,
        })
      }

      return await action()
    } catch (error: unknown) {
      lastError = error

      const shouldRetry = attempt < CLOUD_REQUEST_MAX_ATTEMPTS && isRetryableCloudError(error)
      if (!shouldRetry) {
        throw error
      }

      const waitMs = calculateBackoffMs(attempt)
      log?.('error-details', `${operationName} failed, scheduling retry`, {
        attempt,
        maxAttempts: CLOUD_REQUEST_MAX_ATTEMPTS,
        waitMs,
        error: toErrorMessage(error),
      })
      await delay(waitMs)
    }
  }

  throw lastError instanceof Error ? lastError : new Error(`${operationName} failed after retries.`)
}

const commandExists = (command: string) => {
  const lookupCommand = process.platform === 'win32' ? 'where' : 'which'
  const probe = spawnSync(lookupCommand, [command], {
    encoding: 'utf8',
    timeout: 1500,
    windowsHide: true,
  })

  return probe.status === 0
}

const runProcess = (command: string, args: string[], input?: string) => {
  const result = spawnSync(command, args, {
    encoding: 'utf8',
    input,
    maxBuffer: 10 * 1024 * 1024,
    windowsHide: true,
  })

  if (result.status !== 0) {
    const stderr = result.stderr.trim()
    throw new Error(stderr || `Local command failed: ${command}`)
  }

  return result.stdout.trim()
}

const shellEscape = (value: string) => {
  if (process.platform === 'win32') {
    return `"${value.replace(/"/g, '""')}"`
  }

  return `'${value.replace(/'/g, `'\\''`)}'`
}

const renderCommandTemplate = (template: string, replacements: Record<string, string>) => {
  return template.replace(/\{([a-z_]+)\}/gi, (match, key) => {
    const replacement = replacements[key]
    if (typeof replacement !== 'string') {
      return match
    }

    return shellEscape(replacement)
  })
}

const runShellCommand = (command: string, input?: string) => {
  const result = spawnSync(command, {
    encoding: 'utf8',
    shell: true,
    input,
    maxBuffer: 10 * 1024 * 1024,
    windowsHide: true,
  })

  if (result.status !== 0) {
    const stderr = result.stderr.trim()
    throw new Error(stderr || `Local command failed: ${command}`)
  }

  return result.stdout.trim()
}

const runWhisperCli = (audioFilePath: string, modelPath: string) => {
  const outputBasePath = join(tmpdir(), `whispy-whisper-${Date.now()}-${crypto.randomUUID()}`)
  runProcess('whisper-cli', ['-m', modelPath, '-f', audioFilePath, '-otxt', '-of', outputBasePath, '-nt'])

  const transcriptPath = `${outputBasePath}.txt`
  try {
    if (!existsSync(transcriptPath)) {
      throw new Error('whisper-cli did not produce transcription output file.')
    }

    const text = readFileSync(transcriptPath, 'utf8').trim()
    if (!text) {
      throw new Error('whisper-cli returned empty transcription text.')
    }

    return text
  } finally {
    rmSync(transcriptPath, { force: true })
  }
}

const runWhisperRuntimeBinary = (
  binaryPath: string,
  audioFilePath: string,
  modelPath: string,
  runtimeVariant: WhisperRuntimeVariant,
) => {
  const outputBasePath = join(tmpdir(), `whispy-whisper-runtime-${Date.now()}-${crypto.randomUUID()}`)
  const args = ['-m', modelPath, '-f', audioFilePath, '-otxt', '-of', outputBasePath, '-nt']

  if (runtimeVariant === 'cuda') {
    args.push('-ngl', '99')
  }

  runProcess(binaryPath, args)

  const transcriptPath = `${outputBasePath}.txt`
  try {
    if (!existsSync(transcriptPath)) {
      throw new Error('Whisper runtime did not produce transcription output file.')
    }

    const text = readFileSync(transcriptPath, 'utf8').trim()
    if (!text) {
      throw new Error('Whisper runtime returned empty transcription text.')
    }

    return text
  } finally {
    rmSync(transcriptPath, { force: true })
  }
}

const isWhisperCliBinaryPath = (binaryPath: string) => {
  return /whisper-cli(\.exe)?$/i.test(binaryPath)
}

const runLlamaCli = (modelPath: string, prompt: string, input: string) => {
  const compiledPrompt = `${prompt}\n\nInput:\n${input}\n\nOutput:\n`
  const rawOutput = runProcess('llama-cli', [
    '-m',
    modelPath,
    '-p',
    compiledPrompt,
    '-n',
    '512',
    '--temp',
    '0.2',
    '--no-display-prompt',
  ])

  const normalizedOutput = rawOutput.startsWith(compiledPrompt)
    ? rawOutput.slice(compiledPrompt.length).trim()
    : rawOutput

  if (!normalizedOutput) {
    throw new Error('llama-cli produced empty post-processing output.')
  }

  return normalizedOutput
}

const resolvePromptRoute = (settings: AppSettings, input: string): PromptRouteResolution => {
  const normalizedInput = input.trim()
  const normalizedAgent = settings.agentName.trim().toLowerCase()

  const usesTranslationRoute = settings.translationModeEnabled && normalizedInput.toLowerCase().startsWith('translate:')
  if (usesTranslationRoute) {
    return {
      route: 'translation',
      input: normalizedInput.replace(/^translate:\s*/i, ''),
      prompt: settings.translationPrompt
        .replace(/\{source_language\}/g, settings.translationSourceLanguage)
        .replace(/\{target_language\}/g, settings.translationTargetLanguage),
    }
  }

  const usesAgentRoute = normalizedAgent.length > 0 && normalizedInput.toLowerCase().includes(normalizedAgent)
  if (usesAgentRoute) {
    return {
      route: 'agent',
      input: normalizedInput,
      prompt: settings.agentPrompt,
    }
  }

  return {
    route: 'normal',
    input: normalizedInput,
    prompt: settings.normalPrompt,
  }
}

export class DictationPipeline {
  constructor(private readonly deps: DictationPipelineDependencies) {}

  async processAudioFile(audioFilePath: string): Promise<DictationResult> {
    const settings = await this.deps.loadSettings()

    const transcription = await this.transcribe(settings, audioFilePath)
    const route = resolvePromptRoute(settings, transcription.text)
    const processedText = await this.runPostProcessing(settings, route.input, route.prompt)
    const targetApp = await this.deps.detectActiveApp()

    return {
      text: processedText,
      language: settings.preferredLanguage === 'Auto-detect' ? transcription.language : settings.preferredLanguage,
      provider: transcription.provider,
      model: transcription.model,
      targetApp,
    }
  }

  async processAudioFileTranscriptionOnly(audioFilePath: string): Promise<DictationResult> {
    const settings = await this.deps.loadSettings()
    const transcription = await this.transcribe(settings, audioFilePath)
    const targetApp = await this.deps.detectActiveApp()

    return {
      text: transcription.text,
      language: settings.preferredLanguage === 'Auto-detect' ? transcription.language : settings.preferredLanguage,
      provider: transcription.provider,
      model: transcription.model,
      targetApp,
    }
  }

  async runPromptTest(input: string): Promise<PromptTestResult> {
    const settings = await this.deps.loadSettings()
    const route = resolvePromptRoute(settings, input)
    const output = await this.runPostProcessing(settings, route.input, route.prompt)

    return {
      route: route.route,
      output,
    }
  }

  async runNoteEnhancement(input: string): Promise<string> {
    const settings = await this.deps.loadSettings()
    const normalizedInput = input.trim()

    if (!normalizedInput) {
      return ''
    }

    const noteCleanupPrompt = `${settings.normalPrompt}\n\nWhen cleaning notes, fix punctuation/capitalization, remove filler artifacts, keep the same language, and return plain text only.`
    return this.runPostProcessing(settings, normalizedInput, noteCleanupPrompt)
  }

  async scanModels(baseUrl: string, apiKey: string) {
    this.deps.log?.('api-request', 'Scanning cloud models endpoint', {
      baseUrl,
      hasApiKey: Boolean(apiKey.trim()),
    })

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

    const response = await executeWithCloudRetry(
      'cloud models endpoint scan',
      async () => {
        const result = await fetch(modelsEndpoint, {
          method: 'GET',
          headers,
          signal: AbortSignal.timeout(15_000),
        })

        if (!result.ok) {
          const error = new Error(`${CUSTOM_MODEL_FETCH_ERROR} Endpoint: ${modelsEndpoint}`) as Error & {
            status?: number
          }
          error.status = result.status
          throw error
        }

        return result
      },
      this.deps.log,
    )

    const payload = (await response.json()) as unknown
    const modelIds = extractModelIdsFromPayload(payload)

    if (modelIds.length === 0) {
      throw new Error(`${CUSTOM_MODEL_FETCH_ERROR} Endpoint: ${modelsEndpoint}`)
    }

    this.deps.log?.('api-request', 'Cloud models endpoint scan finished', {
      modelsEndpoint,
      models: modelIds.length,
    })

    return modelIds
  }

  private async transcribe(settings: AppSettings, audioFilePath: string) {
    const transcriptionDictionaryHint = buildTranscriptionDictionaryHint(settings)

    if (transcriptionDictionaryHint) {
      this.deps.log?.('transcript-pipeline', 'Using dictionary hint for transcription', {
        hintLength: transcriptionDictionaryHint.length,
      })
    }

    if (settings.transcriptionRuntime === 'local') {
      this.deps.log?.('audio-processing', 'Running local transcription', {
        modelId: settings.transcriptionLocalModelId,
        runtimeVariant: settings.whisperCppRuntimeVariant,
      })

      const modelPath = this.deps.resolveLocalModelPath('transcription', settings.transcriptionLocalModelId)
      if (!modelPath) {
        throw new Error(`Local transcription model not found: ${settings.transcriptionLocalModelId}. Download it first.`)
      }

      const configuredCommand = process.env.WHISPY_LOCAL_STT_COMMAND?.trim()
      const downloadedRuntimePath = this.deps.resolveWhisperRuntimePath?.(settings.whisperCppRuntimeVariant)
      let text = ''

      if (configuredCommand) {
        text = runShellCommand(
          renderCommandTemplate(configuredCommand, {
            audio_file: audioFilePath,
            model_path: modelPath,
            model_id: settings.transcriptionLocalModelId,
          }),
        )
      } else if (this.deps.transcribeWithWhisperServer) {
        try {
          text = await this.deps.transcribeWithWhisperServer(
            audioFilePath,
            modelPath,
            settings.whisperCppRuntimeVariant,
            transcriptionDictionaryHint ?? undefined,
          )
        } catch (error: unknown) {
          this.deps.log?.('error-details', 'Whisper server unavailable, attempting CLI fallback', {
            error: toErrorMessage(error),
            runtimeVariant: settings.whisperCppRuntimeVariant,
          })

          if (downloadedRuntimePath && isWhisperCliBinaryPath(downloadedRuntimePath)) {
            text = runWhisperRuntimeBinary(
              downloadedRuntimePath,
              audioFilePath,
              modelPath,
              settings.whisperCppRuntimeVariant,
            )
          } else if (commandExists('whisper-cli')) {
            text = runWhisperCli(audioFilePath, modelPath)
          } else {
            throw error
          }
        }
      } else if (downloadedRuntimePath && isWhisperCliBinaryPath(downloadedRuntimePath)) {
        text = runWhisperRuntimeBinary(
          downloadedRuntimePath,
          audioFilePath,
          modelPath,
          settings.whisperCppRuntimeVariant,
        )
      } else if (commandExists('whisper-cli')) {
        text = runWhisperCli(audioFilePath, modelPath)
      } else {
        throw new Error(
          'Local STT runtime unavailable. Download Whisper runtime, install whisper-server/whisper-cli, or set WHISPY_LOCAL_STT_COMMAND.',
        )
      }

      if (!text.trim()) {
        throw new Error('Local STT returned empty transcription.')
      }

      return {
        text,
        language: 'Auto-detect',
        provider: 'Local (On-device)',
        model: settings.transcriptionLocalModelId,
      }
    }

    const transcriptionConfig = getTranscriptionCloudConfig(settings)
    const transcriptionClient = createOpenAIClient(transcriptionConfig)

    if (settings.transcriptionCloudModelId.trim() !== transcriptionConfig.model) {
      this.deps.log?.('api-request', 'Adjusted cloud transcription model to compatible value', {
        provider: settings.transcriptionCloudProvider,
        requestedModel: settings.transcriptionCloudModelId,
        usedModel: transcriptionConfig.model,
      })
    }

    this.deps.log?.('api-request', 'Running cloud transcription request', {
      provider: transcriptionConfig.providerLabel,
      model: transcriptionConfig.model,
      dictionaryHintEnabled: Boolean(transcriptionDictionaryHint),
    })

    const runCloudTranscriptionRequest = (includePromptHint: boolean) => {
      return executeWithCloudRetry(
        'cloud transcription request',
        () =>
          transcriptionClient.audio.transcriptions.create({
            file: createReadStream(audioFilePath),
            model: transcriptionConfig.model,
            ...(includePromptHint && transcriptionDictionaryHint ? { prompt: transcriptionDictionaryHint } : {}),
          }),
        this.deps.log,
      )
    }

    let transcription
    const requestedPromptHint = Boolean(transcriptionDictionaryHint)
    try {
      transcription = await runCloudTranscriptionRequest(requestedPromptHint)
    } catch (error: unknown) {
      if (requestedPromptHint && isUnsupportedTranscriptionPromptError(error)) {
        this.deps.log?.('error-details', 'Cloud transcription rejected dictionary prompt hint, retrying without hint', {
          provider: transcriptionConfig.providerLabel,
          model: transcriptionConfig.model,
          error: toErrorMessage(error),
        })
        transcription = await runCloudTranscriptionRequest(false)
      } else {
        const statusCode = extractStatusCode(error)
        const message = toErrorMessage(error)

        if (statusCode === 404 && /\/audio\/transcriptions/i.test(message)) {
          throw new Error(
            `Transcription endpoint rejected by provider (${transcriptionConfig.providerLabel}). Verify API key/provider pairing and select a speech-to-text model.`,
          )
        }

        throw error
      }
    }

    const text = (transcription.text ?? '').trim()
    if (!text) {
      throw new Error('Received empty transcription result from provider.')
    }

    return {
      text,
      language: 'Auto-detect',
      provider: transcriptionConfig.providerLabel,
      model: transcriptionConfig.model,
    }
  }

  private async runPostProcessing(settings: AppSettings, input: string, prompt: string) {
    let outputText = input
    const compiledPrompt = buildPromptWithDictionaryRules(settings, prompt)

    if (compiledPrompt !== prompt) {
      this.deps.log?.('transcript-pipeline', 'Appended dictionary rules to post-processing prompt', {
        rules: normalizeDictionaryRules(settings.postProcessingDictionaryRules).length,
      })
    }

    if (settings.postProcessingRuntime === 'cloud') {
      const postConfig = getPostProcessingCloudConfig(settings)
      const postClient = createOpenAIClient(postConfig)

      this.deps.log?.('api-request', 'Running cloud post-processing request', {
        provider: postConfig.providerLabel,
        model: postConfig.model,
      })

      const completion = await executeWithCloudRetry(
        'cloud post-processing request',
        () =>
          postClient.chat.completions.create({
            model: postConfig.model,
            messages: [
              {
                role: 'system',
                content: compiledPrompt,
              },
              {
                role: 'user',
                content: input,
              },
            ],
          }),
        this.deps.log,
      )

      outputText = completion.choices[0]?.message?.content?.trim() || input
    } else {
      this.deps.log?.('transcript-pipeline', 'Running local post-processing', {
        modelId: settings.postProcessingLocalModelId,
      })

      const modelPath = this.deps.resolveLocalModelPath('post', settings.postProcessingLocalModelId)
      if (!modelPath) {
        throw new Error(`Local post-processing model not found: ${settings.postProcessingLocalModelId}. Download it first.`)
      }

      const configuredCommand = process.env.WHISPY_LOCAL_LLM_COMMAND?.trim()
      outputText = configuredCommand
        ? runShellCommand(
            renderCommandTemplate(configuredCommand, {
              model_path: modelPath,
              model_id: settings.postProcessingLocalModelId,
              prompt: compiledPrompt,
              input,
            }),
            JSON.stringify({ prompt: compiledPrompt, input }),
          )
        : commandExists('llama-cli')
          ? runLlamaCli(modelPath, compiledPrompt, input)
          : (() => {
              throw new Error(
                'Local post-processing runtime unavailable. Install llama-cli or set WHISPY_LOCAL_LLM_COMMAND.',
              )
            })()
    }

    if (settings.postProcessingDictionaryEnabled) {
      outputText = applyDictionaryRules(outputText, settings.postProcessingDictionaryRules)
    }

    return outputText
  }
}

export type { PromptTestResult }
