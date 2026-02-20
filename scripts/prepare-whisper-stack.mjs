#!/usr/bin/env node

import { spawnSync } from 'node:child_process'
import { join } from 'node:path'

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

    if (arg === '--help' || arg === '-h') {
      process.stdout.write(
        [
          'Whisper runtime preparation wrapper',
          '',
          'Usage:',
          '  node scripts/prepare-whisper-stack.mjs [--current] [--platform=linux] [--arch=x64] [--variants=cpu,cuda] [--force]',
          '',
          'Notes:',
          '  - Prepares Whisper runtime/server prerequisites only (no model download).',
          "  - Whisper model files are managed separately via the app's local model controls.",
          '',
        ].join('\n'),
      )
      process.exit(0)
    }
  }

  if (options.current) {
    options.platform = process.platform
    options.arch = process.arch
  }

  return options
}

const runCommand = (command, args) => {
  const result = spawnSync(command, args, {
    stdio: 'inherit',
    windowsHide: true,
  })

  if (result.status !== 0) {
    throw new Error(`Command failed: ${command} ${args.join(' ')}`)
  }
}

const prepareRuntime = (options) => {
  const runtimeScriptPath = join('scripts', 'prepare-whisper-runtime.mjs')
  const runtimeArgs = [runtimeScriptPath]

  if (options.current) {
    runtimeArgs.push('--current')
  } else {
    runtimeArgs.push(`--platform=${options.platform}`)
    runtimeArgs.push(`--arch=${options.arch}`)
  }

  runtimeArgs.push(`--variants=${options.variants.join(',')}`)

  if (options.force) {
    runtimeArgs.push('--force')
  }

  runCommand('node', runtimeArgs)
}

const main = () => {
  const options = parseArgs()
  const platformArch = `${options.platform}-${options.arch}`

  console.log(`[whisper-prepare] target=${platformArch} variants=${options.variants.join(',')}`)
  console.log('[whisper-prepare] preparing runtime/server prerequisites only')

  prepareRuntime(options)

  console.log('[whisper-prepare] complete')
}

try {
  main()
} catch (error) {
  console.error(`[whisper-prepare] failed: ${error instanceof Error ? error.message : String(error)}`)
  process.exitCode = 1
}
