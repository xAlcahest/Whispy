import { spawn, spawnSync, type ChildProcess } from 'node:child_process'
import { readFileSync } from 'node:fs'
import { request } from 'node:http'
import { createServer } from 'node:net'
import { dirname } from 'node:path'
import type { DebugLogCategory } from './debug-logger'
import type { WhisperRuntimeVariant } from './model-files'

interface WhisperServerDependencies {
  resolveDownloadedServerPath: (variant: WhisperRuntimeVariant) => string | null
  resolveBundledServerPath?: (variant: WhisperRuntimeVariant) => string | null
  log?: (category: DebugLogCategory, message: string, details?: unknown) => void
}

interface WhisperServerCommand {
  command: string
  source: WhisperServerCommandSource
}

export type WhisperServerCommandSource = 'env' | 'downloaded' | 'bundled' | 'path'

export interface WhisperRuntimeDiagnostics {
  checkedAt: number
  selectedVariant: WhisperRuntimeVariant
  running: boolean
  healthy: boolean
  pid: number | null
  port: number | null
  activeVariant: WhisperRuntimeVariant | null
  commandPath: string | null
  commandSource: WhisperServerCommandSource | null
  modelPath: string | null
  processRssMB: number | null
  nvidiaSmiAvailable: boolean
  cudaProcessDetected: boolean
  vramUsedMB: number | null
  notes: string
}

const WHISPER_SERVER_PORT_START = 8178
const WHISPER_SERVER_PORT_END = 8199
const WHISPER_SERVER_STARTUP_TIMEOUT_MS = 30_000
const WHISPER_SERVER_HEALTH_TIMEOUT_MS = 1500
const WHISPER_SERVER_REQUEST_TIMEOUT_MS = 300_000
const MAX_RUNTIME_LINE_LENGTH = 240

const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms))

const trimRuntimeLine = (line: string) => {
  if (line.length <= MAX_RUNTIME_LINE_LENGTH) {
    return line
  }

  return `${line.slice(0, MAX_RUNTIME_LINE_LENGTH)}...`
}

const resolveCommandFromPath = (command: string) => {
  const lookupCommand = process.platform === 'win32' ? 'where' : 'which'
  const lookup = spawnSync(lookupCommand, [command], {
    encoding: 'utf8',
    timeout: 1200,
    windowsHide: true,
  })

  if (lookup.status !== 0) {
    return null
  }

  const firstMatch = lookup.stdout
    .split(/\r?\n/)
    .map((line) => line.trim())
    .find((line) => line.length > 0)

  return firstMatch ?? null
}

const commandExists = (command: string) => {
  return resolveCommandFromPath(command) !== null
}

const queryProcessRssMB = (pid: number) => {
  if (!Number.isFinite(pid) || pid <= 0) {
    return null
  }

  if (process.platform === 'win32') {
    const probe = spawnSync(
      'powershell',
      [
        '-NoProfile',
        '-NonInteractive',
        '-ExecutionPolicy',
        'Bypass',
        '-Command',
        `(Get-Process -Id ${pid} -ErrorAction SilentlyContinue).WorkingSet64`,
      ],
      {
        encoding: 'utf8',
        timeout: 1400,
        windowsHide: true,
      },
    )

    if (probe.status !== 0) {
      return null
    }

    const workingSetBytes = Number(probe.stdout.trim())
    if (!Number.isFinite(workingSetBytes) || workingSetBytes <= 0) {
      return null
    }

    return Math.round((workingSetBytes / (1024 * 1024)) * 10) / 10
  }

  const probe = spawnSync('ps', ['-o', 'rss=', '-p', String(pid)], {
    encoding: 'utf8',
    timeout: 1400,
    windowsHide: true,
  })

  if (probe.status !== 0) {
    return null
  }

  const rssKb = Number(probe.stdout.trim())
  if (!Number.isFinite(rssKb) || rssKb <= 0) {
    return null
  }

  return Math.round((rssKb / 1024) * 10) / 10
}

const queryNvidiaVramForPid = (pid: number) => {
  const result = {
    nvidiaSmiAvailable: false,
    cudaProcessDetected: false,
    vramUsedMB: null as number | null,
  }

  if (!commandExists('nvidia-smi')) {
    return result
  }

  result.nvidiaSmiAvailable = true

  const probe = spawnSync(
    'nvidia-smi',
    ['--query-compute-apps=pid,used_gpu_memory', '--format=csv,noheader,nounits'],
    {
      encoding: 'utf8',
      timeout: 1600,
      windowsHide: true,
    },
  )

  if (probe.status !== 0) {
    return result
  }

  const row = probe.stdout
    .split(/\r?\n/)
    .map((line) => line.trim())
    .find((line) => line.startsWith(`${pid},`))

  if (!row) {
    return result
  }

  const parts = row.split(',').map((part) => part.trim())
  if (parts.length < 2) {
    return result
  }

  const vramUsedMB = Number(parts[1])
  if (!Number.isFinite(vramUsedMB)) {
    return result
  }

  result.cudaProcessDetected = true
  result.vramUsedMB = Math.round(vramUsedMB * 10) / 10
  return result
}

const extractTranscribedText = (payload: unknown) => {
  if (!payload || typeof payload !== 'object') {
    return ''
  }

  const text = (payload as { text?: unknown }).text
  if (typeof text === 'string' && text.trim().length > 0) {
    return text.trim()
  }

  const segments = (payload as { segments?: unknown }).segments
  if (Array.isArray(segments)) {
    const joined = segments
      .map((segment) => {
        if (!segment || typeof segment !== 'object') {
          return ''
        }

        const segmentText = (segment as { text?: unknown }).text
        return typeof segmentText === 'string' ? segmentText.trim() : ''
      })
      .filter((value) => value.length > 0)
      .join(' ')
      .trim()

    if (joined.length > 0) {
      return joined
    }
  }

  return ''
}

export class WhisperServerManager {
  private process: ChildProcess | null = null
  private activePort: number | null = null
  private activeModelPath: string | null = null
  private activeVariant: WhisperRuntimeVariant | null = null
  private activeCommand: string | null = null
  private activeCommandSource: WhisperServerCommandSource | null = null
  private startupPromise: Promise<void> | null = null

  constructor(private readonly deps: WhisperServerDependencies) {}

  async ensureReady(modelPath: string, variant: WhisperRuntimeVariant): Promise<void> {
    await this.ensureStarted(modelPath, variant)
  }

  async transcribeAudioFile(
    audioFilePath: string,
    modelPath: string,
    variant: WhisperRuntimeVariant,
    promptHint?: string,
  ): Promise<string> {
    await this.ensureStarted(modelPath, variant)

    if (!this.activePort) {
      throw new Error('Whisper server is not ready.')
    }

    const audioPayload = readFileSync(audioFilePath)
    const responsePayload = await this.callInference(this.activePort, audioPayload, promptHint)
    const text = extractTranscribedText(responsePayload)

    if (!text) {
      throw new Error('Whisper server returned an empty transcription.')
    }

    return text
  }

  async getDiagnostics(selectedVariant: WhisperRuntimeVariant): Promise<WhisperRuntimeDiagnostics> {
    const pid = this.process?.pid ?? null
    const healthy = this.activePort ? await this.checkHealth(this.activePort) : false
    const processRssMB = pid ? queryProcessRssMB(pid) : null
    const gpuObservation = pid ? queryNvidiaVramForPid(pid) : queryNvidiaVramForPid(-1)
    const resolvedCommand = this.activeCommand ? null : this.resolveServerCommand(selectedVariant)
    const commandPath = this.activeCommand ?? resolvedCommand?.command ?? null
    const commandSource = this.activeCommandSource ?? resolvedCommand?.source ?? null

    let notes = ''
    if (!this.process || !this.activePort) {
      notes = 'Whisper server is not running yet. Start a local transcription to warm the runtime.'
    } else if (selectedVariant === 'cpu') {
      notes = 'CPU runtime selected. GPU/VRAM usage is not expected for this variant.'
    } else if (!gpuObservation.nvidiaSmiAvailable) {
      notes = 'CUDA runtime selected, but nvidia-smi is not available. GPU usage could not be verified.'
    } else if (gpuObservation.cudaProcessDetected) {
      notes = 'CUDA runtime selected and whisper-server is visible in NVIDIA compute apps.'
    } else {
      notes =
        'CUDA runtime selected, but whisper-server did not appear in NVIDIA compute apps. Verify driver/CUDA compatibility.'
    }

    return {
      checkedAt: Date.now(),
      selectedVariant,
      running: Boolean(this.process && this.activePort),
      healthy,
      pid,
      port: this.activePort,
      activeVariant: this.activeVariant,
      commandPath,
      commandSource,
      modelPath: this.activeModelPath,
      processRssMB,
      nvidiaSmiAvailable: gpuObservation.nvidiaSmiAvailable,
      cudaProcessDetected: gpuObservation.cudaProcessDetected,
      vramUsedMB: gpuObservation.vramUsedMB,
      notes,
    }
  }

  async stop() {
    if (!this.process) {
      this.activePort = null
      this.activeModelPath = null
      this.activeVariant = null
      this.activeCommand = null
      this.activeCommandSource = null
      return
    }

    const activeProcess = this.process
    this.process = null
    this.activePort = null
    this.activeModelPath = null
    this.activeVariant = null
    this.activeCommand = null
    this.activeCommandSource = null

    await new Promise<void>((resolve) => {
      const timeout = setTimeout(() => {
        try {
          activeProcess.kill('SIGKILL')
        } catch {
          // Ignore forced kill errors.
        }
        resolve()
      }, 5000)

      activeProcess.once('close', () => {
        clearTimeout(timeout)
        resolve()
      })

      try {
        activeProcess.kill('SIGTERM')
      } catch {
        clearTimeout(timeout)
        resolve()
      }
    })
  }

  private async ensureStarted(modelPath: string, variant: WhisperRuntimeVariant) {
    if (
      this.process &&
      this.activePort &&
      this.activeModelPath === modelPath &&
      this.activeVariant === variant &&
      this.activeCommand
    ) {
      const healthy = await this.checkHealth(this.activePort)
      if (healthy) {
        return
      }
    }

    if (this.startupPromise) {
      await this.startupPromise
      return
    }

    this.startupPromise = this.startServer(modelPath, variant)

    try {
      await this.startupPromise
    } finally {
      this.startupPromise = null
    }
  }

  private resolveServerCommand(variant: WhisperRuntimeVariant): WhisperServerCommand | null {
    const envOverride = process.env.WHISPY_WHISPER_SERVER_COMMAND?.trim()
    if (envOverride) {
      return {
        command: envOverride,
        source: 'env',
      }
    }

    const downloadedPath = this.deps.resolveDownloadedServerPath(variant)
    if (downloadedPath) {
      return {
        command: downloadedPath,
        source: 'downloaded',
      }
    }

    const bundledPath = this.deps.resolveBundledServerPath?.(variant)
    if (bundledPath) {
      return {
        command: bundledPath,
        source: 'bundled',
      }
    }

    const commandCandidates = process.platform === 'win32' ? ['whisper-server.exe', 'whisper-server'] : ['whisper-server']

    for (const candidate of commandCandidates) {
      const resolvedCommand = resolveCommandFromPath(candidate)
      if (resolvedCommand) {
        return {
          command: resolvedCommand,
          source: 'path',
        }
      }
    }

    return null
  }

  private async startServer(modelPath: string, variant: WhisperRuntimeVariant) {
    const resolvedCommand = this.resolveServerCommand(variant)
    if (!resolvedCommand) {
      throw new Error(
        'Whisper server runtime unavailable. Rebuild/reinstall package with bundled runtime, install whisper-server, or set WHISPY_WHISPER_SERVER_COMMAND.',
      )
    }

    await this.stop()

    const port = await this.findAvailablePort()
    const args = ['--model', modelPath, '--host', '127.0.0.1', '--port', String(port), '--language', 'auto']
    if (variant === 'cuda') {
      args.push('-ngl', '99')
    }
    const commandDirectory = dirname(resolvedCommand.command)
    const pathSeparator = process.platform === 'win32' ? ';' : ':'
    const processEnv = {
      ...process.env,
      PATH: `${commandDirectory}${pathSeparator}${process.env.PATH ?? ''}`,
    }

    this.deps.log?.('system-diagnostics', 'Starting whisper-server runtime', {
      command: resolvedCommand.command,
      source: resolvedCommand.source,
      modelPath,
      variant,
      port,
    })

    const child = spawn(resolvedCommand.command, args, {
      stdio: ['ignore', 'pipe', 'pipe'],
      windowsHide: true,
      env: processEnv,
      cwd: commandDirectory,
    })

    let stderrTail = ''
    child.stdout?.on('data', (chunk: Buffer | string) => {
      const text = chunk.toString().trim()
      if (text) {
        this.deps.log?.('transcript-pipeline', 'whisper-server stdout', {
          text: trimRuntimeLine(text),
        })
      }
    })

    child.stderr?.on('data', (chunk: Buffer | string) => {
      const text = chunk.toString().trim()
      if (!text) {
        return
      }

      stderrTail = `${stderrTail}\n${text}`.slice(-2000)
      this.deps.log?.('error-details', 'whisper-server stderr', {
        text: trimRuntimeLine(text),
      })
    })

    this.process = child
    this.activePort = port
    this.activeModelPath = modelPath
    this.activeVariant = variant
    this.activeCommand = resolvedCommand.command
    this.activeCommandSource = resolvedCommand.source

    const startedAt = Date.now()

    while (Date.now() - startedAt < WHISPER_SERVER_STARTUP_TIMEOUT_MS) {
      if (!this.process || this.process.exitCode !== null || this.process.killed) {
        await this.stop()
        throw new Error(
          `whisper-server exited during startup${stderrTail.trim() ? `: ${stderrTail.trim()}` : ''}`,
        )
      }

      const healthy = await this.checkHealth(port)
      if (healthy) {
        this.deps.log?.('system-diagnostics', 'whisper-server runtime ready', {
          port,
          startupMs: Date.now() - startedAt,
          modelPath,
          variant,
        })
        return
      }

      await sleep(120)
    }

    await this.stop()
    throw new Error(`whisper-server failed to start within ${WHISPER_SERVER_STARTUP_TIMEOUT_MS}ms.`)
  }

  private async callInference(port: number, wavAudioBuffer: Buffer, promptHint?: string) {
    const boundary = `----WhispyBoundary${Date.now()}`
    const parts: Buffer[] = [
      Buffer.from(
        `--${boundary}\r\n` +
          'Content-Disposition: form-data; name="file"; filename="dictation.wav"\r\n' +
          'Content-Type: audio/wav\r\n\r\n',
      ),
      wavAudioBuffer,
      Buffer.from('\r\n'),
      Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="language"\r\n\r\nauto\r\n`),
    ]

    const normalizedPromptHint = promptHint?.trim()
    if (normalizedPromptHint) {
      parts.push(Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="prompt"\r\n\r\n${normalizedPromptHint}\r\n`))
    }

    parts.push(Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="response_format"\r\n\r\njson\r\n`))
    parts.push(Buffer.from(`--${boundary}--\r\n`))

    const body = Buffer.concat(parts)

    const responseBody = await new Promise<string>((resolve, reject) => {
      const req = request(
        {
          hostname: '127.0.0.1',
          port,
          path: '/inference',
          method: 'POST',
          headers: {
            'Content-Type': `multipart/form-data; boundary=${boundary}`,
            'Content-Length': body.byteLength,
          },
          timeout: WHISPER_SERVER_REQUEST_TIMEOUT_MS,
        },
        (res) => {
          let payload = ''
          res.setEncoding('utf8')
          res.on('data', (chunk) => {
            payload += chunk
          })
          res.on('end', () => {
            if (res.statusCode !== 200) {
              reject(new Error(`whisper-server HTTP ${res.statusCode ?? 'n/a'}: ${payload.slice(0, 400)}`))
              return
            }

            resolve(payload)
          })
        },
      )

      req.on('error', (error) => {
        reject(new Error(`whisper-server request failed: ${error.message}`))
      })

      req.on('timeout', () => {
        req.destroy(new Error('whisper-server request timed out.'))
      })

      req.write(body)
      req.end()
    })

    try {
      return JSON.parse(responseBody) as unknown
    } catch {
      throw new Error(`Failed to parse whisper-server response: ${responseBody.slice(0, 400)}`)
    }
  }

  private async findAvailablePort() {
    for (let port = WHISPER_SERVER_PORT_START; port <= WHISPER_SERVER_PORT_END; port += 1) {
      const available = await new Promise<boolean>((resolve) => {
        const probe = createServer()
        probe.once('error', () => {
          resolve(false)
        })
        probe.once('listening', () => {
          probe.close()
          resolve(true)
        })
        probe.listen(port, '127.0.0.1')
      })

      if (available) {
        return port
      }
    }

    throw new Error(`No available whisper-server port in range ${WHISPER_SERVER_PORT_START}-${WHISPER_SERVER_PORT_END}.`)
  }

  private async checkHealth(port: number) {
    return new Promise<boolean>((resolve) => {
      const req = request(
        {
          hostname: '127.0.0.1',
          port,
          method: 'GET',
          path: '/',
          timeout: WHISPER_SERVER_HEALTH_TIMEOUT_MS,
        },
        (res) => {
          res.resume()
          resolve(true)
        },
      )

      req.on('error', () => {
        resolve(false)
      })

      req.on('timeout', () => {
        req.destroy()
        resolve(false)
      })

      req.end()
    })
  }
}
