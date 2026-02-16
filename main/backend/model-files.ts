import { spawnSync } from 'node:child_process'
import { copyFileSync, createWriteStream, existsSync, mkdirSync, readdirSync } from 'node:fs'
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

const OFFICIAL_WHISPER_RUNTIME_URLS: Record<string, Partial<Record<WhisperRuntimeVariant, string>>> = {
  'win32-x64': {
    cpu: 'https://github.com/ggml-org/whisper.cpp/releases/latest/download/whisper-bin-x64.zip',
    cuda: 'https://github.com/ggml-org/whisper.cpp/releases/latest/download/whisper-cublas-12.4.0-bin-x64.zip',
  },
  'win32-ia32': {
    cpu: 'https://github.com/ggml-org/whisper.cpp/releases/latest/download/whisper-bin-Win32.zip',
  },
}

const WHISPER_CPP_REPOSITORY_URL = 'https://github.com/ggml-org/whisper.cpp.git'
const WHISPER_CPP_VERSION_OVERRIDE_ENV = 'WHISPY_WHISPER_CPP_VERSION'

const resolveWhisperRuntimeUrl = (variant: WhisperRuntimeVariant) => {
  const envKey = variant === 'cpu' ? 'WHISPY_WHISPER_RUNTIME_CPU_URL' : 'WHISPY_WHISPER_RUNTIME_CUDA_URL'
  const overrideUrl = process.env[envKey]?.trim()
  if (overrideUrl) {
    return overrideUrl
  }

  const platformKey = `${process.platform}-${process.arch}`
  const targetRuntimeUrls = OFFICIAL_WHISPER_RUNTIME_URLS[platformKey]
  return targetRuntimeUrls?.[variant] ?? null
}

const getWhisperServerBinaryName = () => (process.platform === 'win32' ? 'whisper-server.exe' : 'whisper-server')
const getWhisperCliBinaryName = () => (process.platform === 'win32' ? 'whisper-cli.exe' : 'whisper-cli')

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

const findFileRecursive = (rootPath: string, targetFileName: string): string | null => {
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

      if (entry.name.toLowerCase() === targetFileName.toLowerCase()) {
        return entryPath
      }
    }
  }

  return null
}

const commandExists = (command: string) => {
  const lookupCommand = process.platform === 'win32' ? 'where' : 'which'
  const lookup = spawnSync(lookupCommand, [command], {
    encoding: 'utf8',
    timeout: 1400,
    windowsHide: true,
  })

  return lookup.status === 0
}

const runCommand = (command: string, args: string[], cwd?: string) => {
  const result = spawnSync(command, args, {
    cwd,
    encoding: 'utf8',
    timeout: 600_000,
    windowsHide: true,
  })

  if (result.status !== 0) {
    const detailsRaw = result.stderr.trim() || result.stdout.trim() || `Failed command: ${command}`
    const details = detailsRaw
      .split(/\r?\n/)
      .map((line) => line.trim())
      .filter((line) => line.length > 0)
      .slice(0, 6)
      .join(' | ')
    throw new Error(details)
  }
}

const getWhisperServerRuntimeFallbackBinaryName = () => (process.platform === 'win32' ? 'server.exe' : 'server')

const collectSharedLibraries = (directoryPath: string) => {
  if (!existsSync(directoryPath)) {
    return []
  }

  return readdirSync(directoryPath)
    .filter((fileName) => /\.(dll|dylib|so(\.\d+)*)$/i.test(fileName))
    .map((fileName) => join(directoryPath, fileName))
}

const copyWhisperRuntimeArtifacts = async (sourceRoot: string, targetDirectory: string) => {
  const primaryServerBinary = findFileRecursive(sourceRoot, getWhisperServerBinaryName())
  const fallbackServerBinary = primaryServerBinary
    ? null
    : findFileRecursive(sourceRoot, getWhisperServerRuntimeFallbackBinaryName())
  const sourceServerBinary = primaryServerBinary ?? fallbackServerBinary

  if (!sourceServerBinary) {
    throw new Error('Whisper source build did not produce a server binary.')
  }

  await rm(targetDirectory, { recursive: true, force: true })
  mkdirSync(targetDirectory, { recursive: true })

  const targetServerBinary = join(targetDirectory, getWhisperServerBinaryName())
  copyFileSync(sourceServerBinary, targetServerBinary)
  if (process.platform !== 'win32') {
    await chmod(targetServerBinary, 0o755)
  }

  const sourceCliBinary = findFileRecursive(sourceRoot, getWhisperCliBinaryName())
  if (sourceCliBinary) {
    const targetCliBinary = join(targetDirectory, getWhisperCliBinaryName())
    copyFileSync(sourceCliBinary, targetCliBinary)
    if (process.platform !== 'win32') {
      await chmod(targetCliBinary, 0o755)
    }
  }

  const sourceDirectory = dirname(sourceServerBinary)
  const sharedLibraries = collectSharedLibraries(sourceDirectory)
  for (const libraryPath of sharedLibraries) {
    copyFileSync(libraryPath, join(targetDirectory, basename(libraryPath)))
  }

  return targetServerBinary
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
    return findFileRecursive(this.getWhisperRuntimeDirectory(variant), getWhisperServerBinaryName())
  }

  resolveDownloadedWhisperRuntimePath(variant: WhisperRuntimeVariant) {
    const runtimeDirectory = this.getWhisperRuntimeDirectory(variant)
    const cliPath = findFileRecursive(runtimeDirectory, getWhisperCliBinaryName())
    if (cliPath) {
      return cliPath
    }

    return this.resolveDownloadedWhisperServerPath(variant)
  }

  getWhisperRuntimeDownloadUrl(variant: WhisperRuntimeVariant) {
    return resolveWhisperRuntimeUrl(variant)
  }

  private async buildWhisperRuntimeFromSource(
    variant: WhisperRuntimeVariant,
    onProgress?: (payload: ModelDownloadProgress) => void,
  ) {
    if (!commandExists('git') || !commandExists('cmake')) {
      throw new Error('Source build requires git and cmake to be installed.')
    }

    if (variant === 'cuda' && process.platform === 'darwin') {
      throw new Error('CUDA runtime build is not available on macOS.')
    }

    const runtimeModelId = `whisper-runtime-${variant}`
    const runtimeDirectory = this.getWhisperRuntimeDirectory(variant)
    const buildRootDirectory = join(this.rootDirectory, 'runtime', 'whispercpp', '_build')
    const sourceRootDirectory = join(this.rootDirectory, 'runtime', 'whispercpp', '_source')
    const sourceDirectory = join(sourceRootDirectory, 'whisper.cpp')
    const buildDirectory = join(buildRootDirectory, `${process.platform}-${process.arch}-${variant}`)

    mkdirSync(sourceRootDirectory, { recursive: true })
    mkdirSync(buildRootDirectory, { recursive: true })

    onProgress?.({
      scope: 'transcription',
      modelId: runtimeModelId,
      progress: 5,
      downloadedBytes: 0,
      totalBytes: null,
      state: 'downloading',
    })

    if (!existsSync(sourceDirectory)) {
      runCommand('git', ['clone', '--depth', '1', WHISPER_CPP_REPOSITORY_URL, sourceDirectory])
    }

    const versionOverride = process.env[WHISPER_CPP_VERSION_OVERRIDE_ENV]?.trim()
    if (versionOverride) {
      runCommand('git', ['fetch', '--tags', '--force'], sourceDirectory)
      runCommand('git', ['checkout', versionOverride], sourceDirectory)
    }

    onProgress?.({
      scope: 'transcription',
      modelId: runtimeModelId,
      progress: 25,
      downloadedBytes: 0,
      totalBytes: null,
      state: 'downloading',
    })

    const configureArgs = [
      '-S',
      sourceDirectory,
      '-B',
      buildDirectory,
      '-DWHISPER_BUILD_SERVER=ON',
      '-DWHISPER_BUILD_EXAMPLES=ON',
      '-DWHISPER_BUILD_TESTS=OFF',
    ]

    if (variant === 'cuda') {
      configureArgs.push('-DGGML_CUDA=ON')
    }

    runCommand('cmake', configureArgs)

    onProgress?.({
      scope: 'transcription',
      modelId: runtimeModelId,
      progress: 55,
      downloadedBytes: 0,
      totalBytes: null,
      state: 'downloading',
    })

    runCommand('cmake', ['--build', buildDirectory, '--config', 'Release', '--parallel'])

    onProgress?.({
      scope: 'transcription',
      modelId: runtimeModelId,
      progress: 90,
      downloadedBytes: 0,
      totalBytes: null,
      state: 'downloading',
    })

    return copyWhisperRuntimeArtifacts(buildDirectory, runtimeDirectory)
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
    const downloadsArchive = runtimeUrl ? runtimeUrl.toLowerCase().includes('.zip') : false
    const downloadExtension = downloadsArchive ? 'zip' : 'bin'
    const tempDownloadPath = runtimeUrl ? join(runtimeRootDirectory, `${variant}.${downloadExtension}.part`) : null
    const finalDownloadPath = runtimeUrl ? join(runtimeRootDirectory, `${variant}.${downloadExtension}`) : null

    const controller = new AbortController()
    this.activeDownloads.set(downloadKey, controller)

    try {
      mkdirSync(runtimeRootDirectory, { recursive: true })

      if (!runtimeUrl) {
        const builtRuntimePath = await this.buildWhisperRuntimeFromSource(variant, onProgress)
        const runtimePath = this.resolveDownloadedWhisperRuntimePath(variant)
        if (!runtimePath) {
          throw new Error('Built runtime does not contain whisper-server or whisper-cli binaries.')
        }

        onProgress?.({
          scope: 'transcription',
          modelId: runtimeModelId,
          progress: 100,
          downloadedBytes: 0,
          totalBytes: null,
          state: 'completed',
        })

        return builtRuntimePath ?? runtimePath
      }

      if (!tempDownloadPath || !finalDownloadPath) {
        throw new Error('Runtime download paths could not be resolved.')
      }

      const response = await fetch(runtimeUrl, {
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

      await rename(tempDownloadPath, finalDownloadPath)
      await rm(runtimeDirectory, { recursive: true, force: true })
      mkdirSync(runtimeDirectory, { recursive: true })

      if (downloadsArchive) {
        await extractZipArchive(finalDownloadPath, runtimeDirectory)
      } else {
        const urlTail = (() => {
          try {
            return basename(new URL(runtimeUrl).pathname).toLowerCase()
          } catch {
            return runtimeUrl.toLowerCase()
          }
        })()

        const runtimeBinaryName =
          urlTail.includes('cli') && !urlTail.includes('server') ? getWhisperCliBinaryName() : getWhisperServerBinaryName()
        await rename(finalDownloadPath, join(runtimeDirectory, runtimeBinaryName))
      }

      const serverRuntimePath = this.resolveDownloadedWhisperServerPath(variant)
      const runtimePath = this.resolveDownloadedWhisperRuntimePath(variant)

      if (!serverRuntimePath && !runtimePath) {
        throw new Error('Downloaded runtime does not contain whisper-server or whisper-cli binaries.')
      }

      if (process.platform !== 'win32') {
        if (serverRuntimePath) {
          await chmod(serverRuntimePath, 0o755)
        }

        if (runtimePath && runtimePath !== serverRuntimePath) {
          await chmod(runtimePath, 0o755)
        }
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
    }
  }

  async removeWhisperRuntime(variant: WhisperRuntimeVariant) {
    await rm(this.getWhisperRuntimeDirectory(variant), { recursive: true, force: true })
  }
}
