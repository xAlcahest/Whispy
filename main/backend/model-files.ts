import { spawnSync } from 'node:child_process'
import { createWriteStream, existsSync, mkdirSync, readdirSync } from 'node:fs'
import { chmod, rename, rm } from 'node:fs/promises'
import { basename, dirname, join } from 'node:path'
import { Readable } from 'node:stream'
import { pipeline } from 'node:stream/promises'

export type LocalModelScope = 'transcription' | 'post'
export type WhisperRuntimeVariant = 'cpu' | 'cuda'

export interface ModelDownloadProgress {
  scope: LocalModelScope
  modelId: string
  progress: number
  downloadedBytes: number
  totalBytes: number | null
  state: 'downloading' | 'completed' | 'failed' | 'canceled'
  error?: string
}

const TRANSCRIPTION_MODEL_URLS: Record<string, string> = {
  tiny: 'https://huggingface.co/ggerganov/whisper.cpp/resolve/main/ggml-tiny.bin',
  base: 'https://huggingface.co/ggerganov/whisper.cpp/resolve/main/ggml-base.bin',
  small: 'https://huggingface.co/ggerganov/whisper.cpp/resolve/main/ggml-small.bin',
  medium: 'https://huggingface.co/ggerganov/whisper.cpp/resolve/main/ggml-medium.bin',
  large: 'https://huggingface.co/ggerganov/whisper.cpp/resolve/main/ggml-large-v3.bin',
  turbo: 'https://huggingface.co/ggerganov/whisper.cpp/resolve/main/ggml-large-v3-turbo.bin',
}

const WHISPER_RUNTIME_BINARY_URLS: Record<string, Partial<Record<WhisperRuntimeVariant, string>>> = {
  'linux-x64': {
    cpu: 'https://github.com/OpenWhispr/whisper.cpp/releases/download/0.0.6/whisper-server-linux-x64-cpu.zip',
    cuda: 'https://github.com/OpenWhispr/whisper.cpp/releases/download/0.0.6/whisper-server-linux-x64-cuda.zip',
  },
  'win32-x64': {
    cpu: 'https://github.com/OpenWhispr/whisper.cpp/releases/download/0.0.6/whisper-server-win32-x64-cpu.zip',
    cuda: 'https://github.com/OpenWhispr/whisper.cpp/releases/download/0.0.6/whisper-server-win32-x64-cuda.zip',
  },
  'darwin-arm64': {
    cpu: 'https://github.com/OpenWhispr/whisper.cpp/releases/download/0.0.6/whisper-server-darwin-arm64.zip',
  },
  'darwin-x64': {
    cpu: 'https://github.com/OpenWhispr/whisper.cpp/releases/download/0.0.6/whisper-server-darwin-x64.zip',
  },
}

const resolveWhisperRuntimeUrl = (variant: WhisperRuntimeVariant) => {
  const envKey = variant === 'cpu' ? 'WHISPY_WHISPER_RUNTIME_CPU_URL' : 'WHISPY_WHISPER_RUNTIME_CUDA_URL'
  const overrideUrl = process.env[envKey]?.trim()
  if (overrideUrl) {
    return overrideUrl
  }

  const platformKey = `${process.platform}-${process.arch}`
  const targetRuntimeUrls = WHISPER_RUNTIME_BINARY_URLS[platformKey]
  return targetRuntimeUrls?.[variant] ?? null
}

const withRetryQueryParam = (url: string, attempt: number) => {
  if (attempt <= 1) {
    return url
  }

  const retryMarker = `${Date.now()}-${attempt}`

  try {
    const parsedUrl = new URL(url)
    parsedUrl.searchParams.set('whispy_retry', retryMarker)
    return parsedUrl.toString()
  } catch {
    return `${url}${url.includes('?') ? '&' : '?'}whispy_retry=${retryMarker}`
  }
}

const resolveRuntimeBinaryNameFromUrl = (runtimeUrl: string) => {
  const urlTail = (() => {
    try {
      return basename(new URL(runtimeUrl).pathname).toLowerCase()
    } catch {
      return runtimeUrl.toLowerCase()
    }
  })()

  return urlTail.includes('cli') && !urlTail.includes('server') ? getWhisperCliBinaryName() : getWhisperServerBinaryName()
}

const getWhisperServerBinaryName = () => (process.platform === 'win32' ? 'whisper-server.exe' : 'whisper-server')
const getWhisperCliBinaryName = () => (process.platform === 'win32' ? 'whisper-cli.exe' : 'whisper-cli')

const matchesWhisperBinaryName = (fileName: string, baseName: 'whisper-server' | 'whisper-cli') => {
  const normalized = fileName.toLowerCase()
  if (process.platform === 'win32') {
    return normalized === `${baseName}.exe` || (normalized.startsWith(`${baseName}-`) && normalized.endsWith('.exe'))
  }

  return normalized === baseName || normalized.startsWith(`${baseName}-`)
}

const findWhisperBinaryRecursive = (rootPath: string, baseName: 'whisper-server' | 'whisper-cli') => {
  return findFileRecursive(rootPath, '', (entryName) => matchesWhisperBinaryName(entryName, baseName))
}

const escapePowerShellLiteral = (value: string) => value.replace(/'/g, "''")

const extractZipArchive = async (archivePath: string, destinationPath: string) => {
  if (process.platform === 'win32') {
    const command = `Expand-Archive -Path '${escapePowerShellLiteral(archivePath)}' -DestinationPath '${escapePowerShellLiteral(destinationPath)}' -Force`
    const extraction = spawnSync(
      'powershell',
      ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-Command', command],
      {
        encoding: 'utf8',
        timeout: 180_000,
        windowsHide: true,
      },
    )

    if (extraction.status !== 0) {
      throw new Error(extraction.stderr.trim() || extraction.stdout.trim() || 'Unable to extract runtime archive.')
    }

    return
  }

  const extraction = spawnSync('unzip', ['-o', archivePath, '-d', destinationPath], {
    encoding: 'utf8',
    timeout: 180_000,
    windowsHide: true,
  })

  if (extraction.status !== 0) {
    const details = extraction.stderr.trim() || extraction.stdout.trim()
    if ((extraction.error as NodeJS.ErrnoException | undefined)?.code === 'ENOENT') {
      throw new Error('Unable to extract runtime archive because unzip is not installed.')
    }

    throw new Error(details || 'Unable to extract runtime archive.')
  }
}

const findFileRecursive = (
  rootPath: string,
  targetFileName: string,
  customMatcher?: (entryName: string) => boolean,
): string | null => {
  if (!existsSync(rootPath)) {
    return null
  }

  const stack = [rootPath]
  while (stack.length > 0) {
    const currentPath = stack.pop()
    if (!currentPath) {
      break
    }

    for (const entry of readdirSync(currentPath, { withFileTypes: true })) {
      const entryPath = join(currentPath, entry.name)
      if (entry.isDirectory()) {
        stack.push(entryPath)
        continue
      }

      if (customMatcher ? customMatcher(entry.name) : entry.name.toLowerCase() === targetFileName.toLowerCase()) {
        return entryPath
      }
    }
  }

  return null
}

const POST_MODEL_URLS: Record<string, string> = {
  'llama-3.1-8b-instruct':
    'https://huggingface.co/QuantFactory/Meta-Llama-3.1-8B-Instruct-GGUF/resolve/main/Meta-Llama-3.1-8B-Instruct.Q4_K_M.gguf',
  'qwen-2.5-7b-instruct':
    'https://huggingface.co/Qwen/Qwen2.5-7B-Instruct-GGUF/resolve/main/qwen2.5-7b-instruct-q4_k_m.gguf',
  'phi-3.5-mini-instruct':
    'https://huggingface.co/microsoft/Phi-3.5-mini-instruct-gguf/resolve/main/Phi-3.5-mini-instruct-Q4_K_M.gguf',
}

const getModelDownloadUrl = (scope: LocalModelScope, modelId: string) => {
  if (scope === 'transcription') {
    return TRANSCRIPTION_MODEL_URLS[modelId] ?? null
  }

  return POST_MODEL_URLS[modelId] ?? null
}

const getModelFileExtension = (scope: LocalModelScope) => {
  return scope === 'transcription' ? 'bin' : 'gguf'
}

export class LocalModelStore {
  private readonly activeDownloads = new Map<string, AbortController>()

  constructor(private readonly rootDirectory: string) {}

  private getDownloadKey(scope: LocalModelScope, modelId: string) {
    return `${scope}:${modelId}`
  }

  getModelPath(scope: LocalModelScope, modelId: string) {
    const extension = getModelFileExtension(scope)
    return join(this.rootDirectory, scope, `${modelId}.${extension}`)
  }

  resolveDownloadedModelPath(scope: LocalModelScope, modelId: string) {
    const modelPath = this.getModelPath(scope, modelId)
    return existsSync(modelPath) ? modelPath : null
  }

  getWhisperRuntimeDirectory(variant: WhisperRuntimeVariant) {
    return join(this.rootDirectory, 'runtime', 'whispercpp', variant)
  }

  resolveDownloadedWhisperServerPath(variant: WhisperRuntimeVariant) {
    return findWhisperBinaryRecursive(this.getWhisperRuntimeDirectory(variant), 'whisper-server')
  }

  resolveDownloadedWhisperRuntimePath(variant: WhisperRuntimeVariant) {
    const runtimeDirectory = this.getWhisperRuntimeDirectory(variant)
    const cliPath = findWhisperBinaryRecursive(runtimeDirectory, 'whisper-cli')
    if (cliPath) {
      return cliPath
    }

    return this.resolveDownloadedWhisperServerPath(variant)
  }

  getWhisperRuntimeDownloadUrl(variant: WhisperRuntimeVariant) {
    return resolveWhisperRuntimeUrl(variant)
  }

  async downloadModel(
    scope: LocalModelScope,
    modelId: string,
    onProgress?: (payload: ModelDownloadProgress) => void,
  ) {
    const modelUrl = getModelDownloadUrl(scope, modelId)
    if (!modelUrl) {
      throw new Error(`No download URL configured for model: ${modelId}`)
    }

    const downloadKey = this.getDownloadKey(scope, modelId)
    if (this.activeDownloads.has(downloadKey)) {
      throw new Error(`Model download already in progress for: ${modelId}`)
    }

    const controller = new AbortController()
    this.activeDownloads.set(downloadKey, controller)

    try {
      const response = await fetch(modelUrl, {
        signal: controller.signal,
      })

      if (!response.ok || !response.body) {
        throw new Error(`Unable to download model (${response.status})`)
      }

      const modelPath = this.getModelPath(scope, modelId)
      const tempPath = `${modelPath}.part`
      mkdirSync(dirname(modelPath), { recursive: true })

      const totalBytesRaw = Number(response.headers.get('content-length') ?? '')
      const totalBytes = Number.isFinite(totalBytesRaw) && totalBytesRaw > 0 ? totalBytesRaw : null

      let downloadedBytes = 0

      onProgress?.({
        scope,
        modelId,
        progress: 0,
        downloadedBytes: 0,
        totalBytes,
        state: 'downloading',
      })

      const source = Readable.fromWeb(
        response.body as unknown as import('node:stream/web').ReadableStream<Uint8Array>,
      )

      source.on('data', (chunk: Buffer | string) => {
        downloadedBytes += typeof chunk === 'string' ? Buffer.byteLength(chunk) : chunk.byteLength

        const progress = totalBytes ? Math.min(99, Math.round((downloadedBytes / totalBytes) * 100)) : 0

        onProgress?.({
          scope,
          modelId,
          progress,
          downloadedBytes,
          totalBytes,
          state: 'downloading',
        })
      })

      const destination = createWriteStream(tempPath)
      await pipeline(source, destination)
      await rename(tempPath, modelPath)

      onProgress?.({
        scope,
        modelId,
        progress: 100,
        downloadedBytes: totalBytes ?? downloadedBytes,
        totalBytes,
        state: 'completed',
      })

      return modelPath
    } catch (error: unknown) {
      const errorMessage = error instanceof Error ? error.message : 'Model download failed'

      if (controller.signal.aborted) {
        onProgress?.({
          scope,
          modelId,
          progress: 0,
          downloadedBytes: 0,
          totalBytes: null,
          state: 'canceled',
        })
      } else {
        onProgress?.({
          scope,
          modelId,
          progress: 0,
          downloadedBytes: 0,
          totalBytes: null,
          state: 'failed',
          error: errorMessage,
        })
      }

      throw error
    } finally {
      this.activeDownloads.delete(downloadKey)

      const modelPath = this.getModelPath(scope, modelId)
      await rm(`${modelPath}.part`, { force: true })
    }
  }

  cancelDownload(scope: LocalModelScope, modelId: string) {
    const downloadKey = this.getDownloadKey(scope, modelId)
    const controller = this.activeDownloads.get(downloadKey)
    if (!controller) {
      return false
    }

    controller.abort()
    return true
  }

  async removeModel(scope: LocalModelScope, modelId: string) {
    const modelPath = this.getModelPath(scope, modelId)
    await rm(modelPath, { force: true })
  }

  async downloadWhisperRuntime(
    variant: WhisperRuntimeVariant,
    onProgress?: (payload: ModelDownloadProgress) => void,
  ) {
    const runtimeUrl = resolveWhisperRuntimeUrl(variant)
    const runtimeModelId = `whisper-runtime-${variant}`
    const downloadKey = this.getDownloadKey('transcription', runtimeModelId)
    if (this.activeDownloads.has(downloadKey)) {
      throw new Error(`Whisper runtime download already in progress for: ${variant}`)
    }

    const runtimeRootDirectory = join(this.rootDirectory, 'runtime', 'whispercpp')
    const runtimeDirectory = this.getWhisperRuntimeDirectory(variant)
    const stagingRuntimeDirectory = `${runtimeDirectory}.staging`
    const downloadsArchive = runtimeUrl ? runtimeUrl.toLowerCase().includes('.zip') : false
    const downloadExtension = downloadsArchive ? 'zip' : 'bin'
    const tempDownloadPath = runtimeUrl ? join(runtimeRootDirectory, `${variant}.${downloadExtension}.part`) : null
    const finalDownloadPath = runtimeUrl ? join(runtimeRootDirectory, `${variant}.${downloadExtension}`) : null
    const maxAttempts = downloadsArchive ? 2 : 1

    const controller = new AbortController()
    this.activeDownloads.set(downloadKey, controller)

    try {
      mkdirSync(runtimeRootDirectory, { recursive: true })

      if (!runtimeUrl) {
        const platformKey = `${process.platform}-${process.arch}`
        throw new Error(
          `No prebuilt Whisper ${variant.toUpperCase()} runtime configured for ${platformKey}. Set WHISPY_WHISPER_RUNTIME_${variant.toUpperCase()}_URL.`,
        )
      }

      if (!tempDownloadPath || !finalDownloadPath) {
        throw new Error('Runtime download paths could not be resolved.')
      }

      for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
        try {
          const attemptRuntimeUrl = withRetryQueryParam(runtimeUrl, attempt)
          const response = await fetch(attemptRuntimeUrl, {
            signal: controller.signal,
          })

          if (!response.ok || !response.body) {
            throw new Error(`Unable to download Whisper runtime (${response.status})`)
          }

          const totalBytesRaw = Number(response.headers.get('content-length') ?? '')
          const totalBytes = Number.isFinite(totalBytesRaw) && totalBytesRaw > 0 ? totalBytesRaw : null

          let downloadedBytes = 0

          onProgress?.({
            scope: 'transcription',
            modelId: runtimeModelId,
            progress: 0,
            downloadedBytes: 0,
            totalBytes,
            state: 'downloading',
          })

          const source = Readable.fromWeb(
            response.body as unknown as import('node:stream/web').ReadableStream<Uint8Array>,
          )

          source.on('data', (chunk: Buffer | string) => {
            downloadedBytes += typeof chunk === 'string' ? Buffer.byteLength(chunk) : chunk.byteLength
            const progress = totalBytes ? Math.min(99, Math.round((downloadedBytes / totalBytes) * 100)) : 0

            onProgress?.({
              scope: 'transcription',
              modelId: runtimeModelId,
              progress,
              downloadedBytes,
              totalBytes,
              state: 'downloading',
            })
          })

          const destination = createWriteStream(tempDownloadPath)
          await pipeline(source, destination)

          if (totalBytes !== null && downloadedBytes !== totalBytes) {
            throw new Error(`Whisper runtime download incomplete (${downloadedBytes}/${totalBytes} bytes).`)
          }

          await rename(tempDownloadPath, finalDownloadPath)
          await rm(stagingRuntimeDirectory, { recursive: true, force: true })
          mkdirSync(stagingRuntimeDirectory, { recursive: true })

          if (downloadsArchive) {
            await extractZipArchive(finalDownloadPath, stagingRuntimeDirectory)
          } else {
            const runtimeBinaryName = resolveRuntimeBinaryNameFromUrl(runtimeUrl)
            await rename(finalDownloadPath, join(stagingRuntimeDirectory, runtimeBinaryName))
          }

          const stagedServerRuntimePath = findWhisperBinaryRecursive(stagingRuntimeDirectory, 'whisper-server')
          const stagedRuntimePath = findWhisperBinaryRecursive(stagingRuntimeDirectory, 'whisper-cli') ?? stagedServerRuntimePath

          if (!stagedServerRuntimePath && !stagedRuntimePath) {
            throw new Error('Downloaded runtime does not contain whisper-server or whisper-cli binaries.')
          }

          if (process.platform !== 'win32') {
            if (stagedServerRuntimePath) {
              await chmod(stagedServerRuntimePath, 0o755)
            }

            if (stagedRuntimePath && stagedRuntimePath !== stagedServerRuntimePath) {
              await chmod(stagedRuntimePath, 0o755)
            }
          }

          await rm(runtimeDirectory, { recursive: true, force: true })
          await rename(stagingRuntimeDirectory, runtimeDirectory)

          const serverRuntimePath = this.resolveDownloadedWhisperServerPath(variant)
          const runtimePath = this.resolveDownloadedWhisperRuntimePath(variant)

          if (!serverRuntimePath && !runtimePath) {
            throw new Error('Downloaded runtime does not contain whisper-server or whisper-cli binaries.')
          }

          onProgress?.({
            scope: 'transcription',
            modelId: runtimeModelId,
            progress: 100,
            downloadedBytes: totalBytes ?? downloadedBytes,
            totalBytes,
            state: 'completed',
          })

          return serverRuntimePath ?? runtimePath
        } catch (attemptError: unknown) {
          await rm(tempDownloadPath, { force: true })
          await rm(finalDownloadPath, { force: true })
          await rm(stagingRuntimeDirectory, { recursive: true, force: true })

          if (controller.signal.aborted || attempt >= maxAttempts) {
            throw attemptError
          }
        }
      }

      throw new Error('Whisper runtime download failed after retry attempts.')
    } catch (error: unknown) {
      const errorMessage = error instanceof Error ? error.message : 'Whisper runtime download failed'

      onProgress?.({
        scope: 'transcription',
        modelId: runtimeModelId,
        progress: 0,
        downloadedBytes: 0,
        totalBytes: null,
        state: controller.signal.aborted ? 'canceled' : 'failed',
        error: controller.signal.aborted ? undefined : errorMessage,
      })

      throw error
    } finally {
      this.activeDownloads.delete(downloadKey)
      if (tempDownloadPath) {
        await rm(tempDownloadPath, { force: true })
      }

      if (finalDownloadPath) {
        await rm(finalDownloadPath, { force: true })
      }

      await rm(stagingRuntimeDirectory, { recursive: true, force: true })
    }
  }

  async removeWhisperRuntime(variant: WhisperRuntimeVariant) {
    await rm(this.getWhisperRuntimeDirectory(variant), { recursive: true, force: true })
  }
}
