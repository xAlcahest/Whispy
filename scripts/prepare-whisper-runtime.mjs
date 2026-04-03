#!/usr/bin/env node

import { spawnSync } from 'node:child_process'
import {
  createWriteStream,
  existsSync,
  mkdirSync,
  readdirSync,
  rmSync,
  statSync,
  copyFileSync,
  chmodSync,
  writeFileSync,
} from 'node:fs'
import { randomBytes } from 'node:crypto'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { Readable } from 'node:stream'
import { pipeline } from 'node:stream/promises'
import { fileURLToPath } from 'node:url'

const OFFICIAL_RUNTIME_ASSETS = {
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

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const CACHE_ROOT = join(tmpdir(), 'whispy-whispercpp-cache')
const BUNDLED_RUNTIME_ROOT = join(REPO_ROOT, 'resources', 'bin', 'whispercpp')
const PREPARE_LOG_ROOT = join(CACHE_ROOT, 'logs')
const PREPARE_OUTPUT_MAX_LINES = 24

const parseArgs = () => {
  const options = {
    platform: process.platform,
    arch: process.arch,
    variants: ['cpu', 'cuda'],
    force: false,
    current: false,
  }

  for (const arg of process.argv.slice(2)) {
    if (arg === '--force') {
      options.force = true
      continue
    }

    if (arg === '--current') {
      options.current = true
      continue
    }

    if (arg.startsWith('--platform=')) {
      options.platform = arg.split('=')[1] || options.platform
      continue
    }

    if (arg.startsWith('--arch=')) {
      options.arch = arg.split('=')[1] || options.arch
      continue
    }

    if (arg.startsWith('--variants=')) {
      const raw = arg.split('=')[1] ?? ''
      const nextVariants = raw
        .split(',')
        .map((value) => value.trim().toLowerCase())
        .filter((value) => value === 'cpu' || value === 'cuda')

      if (nextVariants.length > 0) {
        options.variants = Array.from(new Set(nextVariants))
      }
      continue
    }
  }

  if (options.current) {
    options.platform = process.platform
    options.arch = process.arch
  }

  return options
}

const summarizeOutput = (raw) => {
  const lines = String(raw ?? '')
    .split(/\r?\n/)
    .map((line) => line.trimEnd())
    .filter((line) => line.length > 0)

  if (lines.length <= PREPARE_OUTPUT_MAX_LINES) {
    return lines.join('\n')
  }

  const keepHead = 14
  const keepTail = 8
  const omittedCount = Math.max(0, lines.length - keepHead - keepTail)
  return `${lines.slice(0, keepHead).join('\n')}\n... (${omittedCount} lines omitted)\n${lines.slice(-keepTail).join('\n')}`
}

const writeFailureLog = ({ command, args, options, stdout, stderr, message }) => {
  ensureDirectory(PREPARE_LOG_ROOT)
  const timestamp = new Date().toISOString().replace(/[:.]/g, '-')
  const nonce = randomBytes(4).toString('hex')
  const logPath = join(PREPARE_LOG_ROOT, `prepare-${timestamp}-${nonce}.log`)

  const lines = [
    `message: ${message}`,
    `command: ${command}`,
    `args: ${JSON.stringify(args)}`,
    `cwd: ${options.cwd || process.cwd()}`,
    '',
    '--- stdout ---',
    stdout || '(empty)',
    '',
    '--- stderr ---',
    stderr || '(empty)',
    '',
  ]

  writeFileSync(logPath, lines.join('\n'), 'utf8')
  return logPath
}

const run = (command, args, options = {}) => {
  const result = spawnSync(command, args, {
    encoding: 'utf8',
    stdio: 'pipe',
    windowsHide: true,
    ...options,
  })

  if (result.status !== 0) {
    const stdout = result.stdout?.trim() || ''
    const stderr = result.stderr?.trim() || ''
    const merged = stderr || stdout || `Command failed: ${command}`
    const summary = summarizeOutput(merged) || `Command failed: ${command}`

    const error = new Error(summary)
    error.command = command
    error.args = args
    error.options = options
    error.stdout = stdout
    error.stderr = stderr
    error.logPath = writeFailureLog({
      command,
      args,
      options,
      stdout,
      stderr,
      message: summary,
    })

    throw error
  }

  return result.stdout.trim()
}

const commandExists = (command) => {
  const lookup = spawnSync(process.platform === 'win32' ? 'where' : 'which', [command], {
    encoding: 'utf8',
    timeout: 1400,
    windowsHide: true,
  })

  return lookup.status === 0
}

const ensureDirectory = (directoryPath) => {
  mkdirSync(directoryPath, { recursive: true })
}

const extractZip = (archivePath, destinationPath) => {
  ensureDirectory(destinationPath)

  if (process.platform === 'win32') {
    run('powershell', [
      '-NoProfile',
      '-NonInteractive',
      '-ExecutionPolicy',
      'Bypass',
      '-Command',
      `Expand-Archive -Path '${archivePath.replace(/'/g, "''")}' -DestinationPath '${destinationPath.replace(/'/g, "''")}' -Force`,
    ])
    return
  }

  if (!commandExists('unzip')) {
    throw new Error('unzip is required to extract whisper runtime archives on this platform.')
  }

  run('unzip', ['-o', archivePath, '-d', destinationPath])
}

const findFileRecursive = (rootPath, matcher) => {
  if (!existsSync(rootPath)) {
    return null
  }

  const stack = [rootPath]
  while (stack.length > 0) {
    const current = stack.pop()
    if (!current) {
      break
    }

    for (const entry of readdirSync(current, { withFileTypes: true })) {
      const entryPath = join(current, entry.name)
      if (entry.isDirectory()) {
        stack.push(entryPath)
        continue
      }

      if (matcher(entry.name, entryPath)) {
        return entryPath
      }
    }
  }

  return null
}

const collectCompanionLibraries = (binaryDirectory) => {
  if (!existsSync(binaryDirectory)) {
    return []
  }

  return readdirSync(binaryDirectory)
    .filter((fileName) => /\.(dll|dylib|so(\.\d+)*)$/i.test(fileName))
    .map((fileName) => join(binaryDirectory, fileName))
}

const copyRuntimeArtifacts = ({
  sourceRoot,
  targetDirectory,
  targetBinaryName,
  executableSuffix,
}) => {
  const sourceBinary = findFileRecursive(sourceRoot, (fileName) => {
    const normalized = fileName.toLowerCase()

    if (executableSuffix === '.exe') {
      return normalized === 'whisper-server.exe' || (normalized.startsWith('whisper-server-') && normalized.endsWith('.exe'))
    }

    return normalized === 'whisper-server' || normalized.startsWith('whisper-server-')
  })
  if (!sourceBinary) {
    throw new Error('whisper-server binary was not found in prepared runtime artifacts.')
  }

  ensureDirectory(targetDirectory)
  const targetBinaryPath = join(targetDirectory, targetBinaryName)
  copyFileSync(sourceBinary, targetBinaryPath)

  if (executableSuffix !== '.exe') {
    chmodSync(targetBinaryPath, 0o755)
  }

  const companionLibraries = collectCompanionLibraries(dirname(sourceBinary))
  for (const libraryPath of companionLibraries) {
    copyFileSync(libraryPath, join(targetDirectory, libraryPath.split(/[/\\]/).pop() ?? ''))
  }

  return targetBinaryPath
}

const downloadToFile = async (url, targetPath) => {
  const response = await fetch(url)
  if (!response.ok || !response.body) {
    throw new Error(`Unable to download runtime asset (${response.status}) from ${url}`)
  }

  ensureDirectory(dirname(targetPath))
  const destination = createWriteStream(targetPath)
  const source = Readable.fromWeb(response.body)
  await pipeline(source, destination)
}

const prepareFromOfficialAsset = async ({
  url,
  platform,
  arch,
  variant,
  targetDirectory,
}) => {
  const tempDirectory = join(CACHE_ROOT, 'downloads', `${platform}-${arch}-${variant}`)
  const archivePath = join(tempDirectory, `runtime-${variant}.zip`)
  const extractDirectory = join(tempDirectory, 'extract')

  rmSync(tempDirectory, { recursive: true, force: true })
  ensureDirectory(tempDirectory)

  await downloadToFile(url, archivePath)
  extractZip(archivePath, extractDirectory)

  return copyRuntimeArtifacts({
    sourceRoot: extractDirectory,
    targetDirectory,
    targetBinaryName: `whisper-server-${platform}-${arch}-${variant}${platform === 'win32' ? '.exe' : ''}`,
    executableSuffix: platform === 'win32' ? '.exe' : '',
  })
}

const prepareVariant = async ({ platform, arch, variant, force }) => {
  const platformArch = `${platform}-${arch}`
  const outputDirectory = join(BUNDLED_RUNTIME_ROOT, platformArch, variant)
  const outputBinaryName = `whisper-server-${platform}-${arch}-${variant}${platform === 'win32' ? '.exe' : ''}`
  const outputBinaryPath = join(outputDirectory, outputBinaryName)

  if (existsSync(outputBinaryPath) && !force) {
    const sizeMB = Math.round(statSync(outputBinaryPath).size / 1024 / 1024)
    console.log(`[whisper-runtime] ${platformArch}/${variant}: already prepared (${sizeMB} MB)`)
    return outputBinaryPath
  }

  ensureDirectory(outputDirectory)
  const officialAssetUrl = OFFICIAL_RUNTIME_ASSETS[platformArch]?.[variant] ?? null

  if (officialAssetUrl) {
    console.log(`[whisper-runtime] ${platformArch}/${variant}: downloading official asset`)
    const outputPath = await prepareFromOfficialAsset({
      url: officialAssetUrl,
      platform,
      arch,
      variant,
      targetDirectory: outputDirectory,
    })
    console.log(`[whisper-runtime] ${platformArch}/${variant}: prepared (${outputPath})`)
    return outputPath
  }

  throw new Error(
    `No prebuilt Whisper ${variant.toUpperCase()} runtime for ${platformArch}. Provide WHISPY_WHISPER_RUNTIME_${variant.toUpperCase()}_URL to continue.`,
  )
}

const main = async () => {
  const options = parseArgs()
  const platformArch = `${options.platform}-${options.arch}`
  const requireCudaRuntime = process.env.WHISPY_REQUIRE_CUDA_RUNTIME === '1'

  console.log(`[whisper-runtime] target ${platformArch} variants=${options.variants.join(',')}`)

  for (const variant of options.variants) {
    try {
      await prepareVariant({
        platform: options.platform,
        arch: options.arch,
        variant,
        force: options.force,
      })
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      console.error(`[whisper-runtime] ${platformArch}/${variant}: failed - ${message}`)

      if (error && typeof error === 'object' && 'logPath' in error && error.logPath) {
        console.error(`[whisper-runtime] ${platformArch}/${variant}: full command output -> ${error.logPath}`)
      }

      if (variant === 'cuda' && !requireCudaRuntime) {
        console.warn(
          `[whisper-runtime] ${platformArch}/${variant}: continuing without CUDA binary (set WHISPY_REQUIRE_CUDA_RUNTIME=1 to enforce)`,
        )
        continue
      }

      process.exitCode = 1
    }
  }
}

main().catch((error) => {
  const message = error instanceof Error ? error.message : String(error)
  console.error(`[whisper-runtime] fatal: ${message}`)
  process.exitCode = 1
})
