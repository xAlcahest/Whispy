#!/usr/bin/env node

import { spawnSync } from 'node:child_process'

const platform = process.platform

const checkCommand = (name) => {
  const probe = spawnSync(platform === 'win32' ? 'where' : 'which', [name], {
    encoding: 'utf8',
    timeout: 1500,
    windowsHide: true,
  })

  return probe.status === 0
}

const line = (label, ok, details = '') => {
  const icon = ok ? '[ok]' : '[missing]'
  const suffix = details ? ` - ${details}` : ''
  console.log(`${icon} ${label}${suffix}`)
}

console.log(`Whispy doctor (${platform})`)
console.log('')

let hardFailures = 0

if (platform === 'linux') {
  const hasRecorder = checkCommand('sox') || checkCommand('arecord')
  line('Audio recorder (sox or arecord)', hasRecorder, hasRecorder ? '' : 'install sox or arecord')
  if (!hasRecorder) {
    hardFailures += 1
  }

  const hasAutoPasteBackend = checkCommand('wtype') || checkCommand('xdotool') || checkCommand('ydotool')
  line(
    'Auto-paste backend (wtype/xdotool/ydotool)',
    hasAutoPasteBackend,
    hasAutoPasteBackend ? '' : 'install at least one backend tool',
  )
}

if (platform === 'darwin') {
  line('AppleScript runtime (osascript)', checkCommand('osascript'))
}

if (platform === 'win32') {
  line('PowerShell runtime', checkCommand('powershell'))
}

const localSttConfigured = Boolean(process.env.WHISPY_LOCAL_STT_COMMAND?.trim())
line(
  'WHISPY_LOCAL_STT_COMMAND (optional)',
  localSttConfigured,
  localSttConfigured ? '' : 'set this to enable local STT runtime',
)

const whisperServerConfigured = Boolean(process.env.WHISPY_WHISPER_SERVER_COMMAND?.trim())
line(
  'WHISPY_WHISPER_SERVER_COMMAND (optional)',
  whisperServerConfigured,
  whisperServerConfigured ? '' : 'set this to pin a specific whisper-server binary',
)

if (!localSttConfigured && !whisperServerConfigured) {
  const hasWhisperServer = checkCommand('whisper-server')
  line(
    'whisper-server (preferred local STT)',
    hasWhisperServer,
    hasWhisperServer ? '' : 'download runtime in-app, install whisper-server, or set WHISPY_WHISPER_SERVER_COMMAND',
  )

  const hasWhisperCli = checkCommand('whisper-cli')
  line(
    'whisper-cli (fallback local STT)',
    hasWhisperCli,
    hasWhisperCli ? '' : 'install whisper-cli for fallback local STT',
  )
}

line('nvidia-smi (CUDA visibility check)', checkCommand('nvidia-smi'), 'optional but recommended for CUDA diagnostics')

const localLlmConfigured = Boolean(process.env.WHISPY_LOCAL_LLM_COMMAND?.trim())
line(
  'WHISPY_LOCAL_LLM_COMMAND (optional)',
  localLlmConfigured,
  localLlmConfigured ? '' : 'set this to enable local post-processing runtime',
)

if (!localLlmConfigured) {
  const hasLlamaCli = checkCommand('llama-cli')
  line('llama-cli (fallback local LLM)', hasLlamaCli, hasLlamaCli ? '' : 'install llama-cli or set WHISPY_LOCAL_LLM_COMMAND')
}

console.log('')

if (hardFailures > 0) {
  console.log(`Doctor found ${hardFailures} required issue(s).`)
  process.exit(1)
}

console.log('Doctor finished successfully.')
