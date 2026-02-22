import { spawnSync } from 'node:child_process'
import { clipboard } from 'electron'
import type { AutoPasteBackend, AutoPasteMode, AutoPasteShortcut } from '../../shared/app'

export interface AutoPasteExecutionResult {
  success: boolean
  details: string
}

export interface AutoPasteOptions {
  mode?: AutoPasteMode
  shortcut?: AutoPasteShortcut
}

const runCommand = (command: string, args: string[]) => {
  return spawnSync(command, args, {
    encoding: 'utf8',
    timeout: 4000,
    windowsHide: true,
  })
}

const commandExists = (command: string) => {
  const lookupCommand = process.platform === 'win32' ? 'where' : 'which'
  const probe = runCommand(lookupCommand, [command])
  return probe.status === 0
}

const normalizeAutoPasteOptions = (options?: AutoPasteOptions) => {
  return {
    mode: options?.mode === 'instant' ? 'instant' : 'stream',
    shortcut: options?.shortcut === 'ctrl-shift-v' ? 'ctrl-shift-v' : 'ctrl-v',
  } as const
}

type LinuxPasteTool = 'xdotool' | 'wtype' | 'ydotool'

interface LinuxPasteAttempt {
  backend: LinuxPasteTool
  run: () => ReturnType<typeof runCommand>
}

const STREAM_CLIPBOARD_STEP_DELAY_MS = 0
const STREAM_CLIPBOARD_YIELD_INTERVAL = 96
const STREAM_CLIPBOARD_YIELD_DELAY_MS = 1
const STREAM_CLIPBOARD_CHUNK_RETRIES = 2

const sleepBlocking = (milliseconds: number) => {
  if (milliseconds <= 0) {
    return
  }

  const sleepSignal = new Int32Array(new SharedArrayBuffer(4))
  Atomics.wait(sleepSignal, 0, 0, milliseconds)
}

const runLinuxStreamingAutoPaste = (text: string, backend: AutoPasteBackend): AutoPasteExecutionResult => {
  if (backend === 'wtype') {
    const result = runCommand('wtype', [text])
    if (result.status === 0) {
      return { success: true, details: 'Text typed via wtype (stream mode).' }
    }

    return {
      success: false,
      details: result.stderr.trim() || 'wtype failed to type text.',
    }
  }

  if (backend === 'xdotools') {
    const result = runCommand('xdotool', ['type', '--clearmodifiers', '--delay', '1', text])
    if (result.status === 0) {
      return { success: true, details: 'Text typed via xdotool (stream mode).' }
    }

    return {
      success: false,
      details: result.stderr.trim() || 'xdotool failed to type text.',
    }
  }

  const result = runCommand('ydotool', ['type', '--key-delay', '1', text])
  if (result.status === 0) {
    return { success: true, details: 'Text typed via ydotool (stream mode).' }
  }

  return {
    success: false,
    details: result.stderr.trim() || 'ydotool failed to type text.',
  }
}

const runXdotoolPasteShortcut = (shortcut: AutoPasteShortcut) => {
  const keyCombo = shortcut === 'ctrl-shift-v' ? 'ctrl+shift+v' : 'ctrl+v'
  return runCommand('xdotool', ['key', '--clearmodifiers', keyCombo])
}

const runWtypePasteShortcut = (shortcut: AutoPasteShortcut) => {
  const args =
    shortcut === 'ctrl-shift-v'
      ? ['-M', 'ctrl', '-M', 'shift', '-k', 'v', '-m', 'shift', '-m', 'ctrl']
      : ['-M', 'ctrl', '-k', 'v', '-m', 'ctrl']
  return runCommand('wtype', args)
}

const runYdotoolPasteShortcut = (shortcut: AutoPasteShortcut) => {
  const args =
    shortcut === 'ctrl-shift-v'
      ? ['key', '29:1', '42:1', '47:1', '47:0', '42:0', '29:0']
      : ['key', '29:1', '47:1', '47:0', '29:0']

  return runCommand('ydotool', args)
}

const buildLinuxPasteShortcutAttempts = (
  backend: AutoPasteBackend,
  shortcut: AutoPasteShortcut,
): LinuxPasteAttempt[] => {
  const attempts: LinuxPasteAttempt[] = []
  const seen = new Set<LinuxPasteTool>()

  const appendAttempt = (tool: LinuxPasteTool) => {
    if (seen.has(tool) || !commandExists(tool)) {
      return
    }

    seen.add(tool)
    if (tool === 'xdotool') {
      attempts.push({ backend: tool, run: () => runXdotoolPasteShortcut(shortcut) })
      return
    }

    if (tool === 'wtype') {
      attempts.push({ backend: tool, run: () => runWtypePasteShortcut(shortcut) })
      return
    }

    attempts.push({ backend: tool, run: () => runYdotoolPasteShortcut(shortcut) })
  }

  if (backend === 'xdotools') {
    appendAttempt('xdotool')
  } else if (backend === 'wtype') {
    appendAttempt('wtype')
  } else {
    appendAttempt('ydotool')
  }

  appendAttempt('xdotool')
  appendAttempt('wtype')
  appendAttempt('ydotool')

  return attempts
}

const executeLinuxPasteAttempt = (
  attempts: LinuxPasteAttempt[],
  preferredAttempt: LinuxPasteAttempt | null,
): LinuxPasteAttempt | null => {
  const triedBackends = new Set<LinuxPasteTool>()

  if (preferredAttempt) {
    const preferredResult = preferredAttempt.run()
    triedBackends.add(preferredAttempt.backend)
    if (preferredResult.status === 0) {
      return preferredAttempt
    }
  }

  for (const attempt of attempts) {
    if (triedBackends.has(attempt.backend)) {
      continue
    }

    const result = attempt.run()
    triedBackends.add(attempt.backend)
    if (result.status === 0) {
      return attempt
    }
  }

  return null
}

const runLinuxStreamingPasteViaClipboard = (
  text: string,
  backend: AutoPasteBackend,
  shortcut: AutoPasteShortcut,
): AutoPasteExecutionResult => {
  const attempts = buildLinuxPasteShortcutAttempts(backend, shortcut)
  if (attempts.length === 0) {
    return {
      success: false,
      details: 'Streaming paste unavailable: install xdotool, wtype, or ydotool.',
    }
  }

  const previousClipboardText = clipboard.readText()
  let selectedAttempt: LinuxPasteAttempt | null = null

  try {
    const chunks = Array.from(text)
    for (let index = 0; index < chunks.length; index += 1) {
      clipboard.writeText(chunks[index] ?? '')

      let successfulAttempt: LinuxPasteAttempt | null = null
      for (let retryIndex = 0; retryIndex <= STREAM_CLIPBOARD_CHUNK_RETRIES; retryIndex += 1) {
        successfulAttempt = executeLinuxPasteAttempt(attempts, selectedAttempt)
        if (successfulAttempt) {
          break
        }

        sleepBlocking(2)
      }

      if (!successfulAttempt) {
        return {
          success: false,
          details:
            'Streaming paste failed while sending chunks. Try Instant mode or ensure xdotool/wtype/ydotool is available.',
        }
      }

      selectedAttempt = successfulAttempt

      if (index < chunks.length - 1) {
        if (STREAM_CLIPBOARD_STEP_DELAY_MS > 0) {
          sleepBlocking(STREAM_CLIPBOARD_STEP_DELAY_MS)
        } else if ((index + 1) % STREAM_CLIPBOARD_YIELD_INTERVAL === 0) {
          sleepBlocking(STREAM_CLIPBOARD_YIELD_DELAY_MS)
        }
      }
    }

    return {
      success: true,
      details: `Text streamed via clipboard chunks and ${selectedAttempt?.backend ?? 'paste shortcut'} (${shortcut === 'ctrl-shift-v' ? 'Ctrl+Shift+V' : 'Ctrl+V'}).`,
    }
  } finally {
    clipboard.writeText(previousClipboardText)
  }
}

const runLinuxInstantAutoPaste = (
  text: string,
  backend: AutoPasteBackend,
  shortcut: AutoPasteShortcut,
): AutoPasteExecutionResult => {
  clipboard.writeText(text)

  const attempts = buildLinuxPasteShortcutAttempts(backend, shortcut)
  const successfulAttempt = executeLinuxPasteAttempt(attempts, null)
  if (successfulAttempt) {
    return {
      success: true,
      details: `Clipboard pasted via ${successfulAttempt.backend} (${shortcut === 'ctrl-shift-v' ? 'Ctrl+Shift+V' : 'Ctrl+V'}).`,
    }
  }

  return {
    success: false,
    details:
      'Clipboard updated, but paste shortcut could not be sent. Install xdotool, wtype, or ydotool, or switch to Streaming mode.',
  }
}

const runMacStreamingAutoPaste = (text: string): AutoPasteExecutionResult => {
  const escaped = text.replace(/\\/g, '\\\\').replace(/"/g, '\\"').replace(/\n/g, '\\n')
  const script = `tell application "System Events" to keystroke "${escaped}"`
  const result = runCommand('osascript', ['-e', script])

  if (result.status === 0) {
    return { success: true, details: 'Text typed via AppleScript (stream mode).' }
  }

  return {
    success: false,
    details: result.stderr.trim() || 'AppleScript failed to type text.',
  }
}

const runMacInstantAutoPaste = (text: string, shortcut: AutoPasteShortcut): AutoPasteExecutionResult => {
  clipboard.writeText(text)
  const modifiers = shortcut === 'ctrl-shift-v' ? '{command down, shift down}' : '{command down}'
  const script = `tell application "System Events" to keystroke "v" using ${modifiers}`
  const result = runCommand('osascript', ['-e', script])

  if (result.status === 0) {
    return {
      success: true,
      details: `Clipboard pasted via ${shortcut === 'ctrl-shift-v' ? 'Cmd+Shift+V' : 'Cmd+V'}.`,
    }
  }

  return {
    success: false,
    details: result.stderr.trim() || 'Unable to send paste shortcut via AppleScript.',
  }
}

const runWindowsStreamingAutoPaste = (text: string): AutoPasteExecutionResult => {
  const escaped = text
    .replace(/`/g, '``')
    .replace(/"/g, '`"')
    .replace(/\r\n/g, '`r`n')
    .replace(/\n/g, '`n')

  const script =
    '$ErrorActionPreference="Stop"; Add-Type -AssemblyName System.Windows.Forms; [System.Windows.Forms.SendKeys]::SendWait("' +
    escaped +
    '")'

  const result = runCommand('powershell', ['-NoProfile', '-NonInteractive', '-Command', script])
  if (result.status === 0) {
    return { success: true, details: 'Text typed via PowerShell SendKeys (stream mode).' }
  }

  return {
    success: false,
    details: result.stderr.trim() || 'PowerShell SendKeys failed to type text.',
  }
}

const runWindowsInstantAutoPaste = (text: string, shortcut: AutoPasteShortcut): AutoPasteExecutionResult => {
  clipboard.writeText(text)
  const keys = shortcut === 'ctrl-shift-v' ? '^+v' : '^v'
  const script =
    '$ErrorActionPreference="Stop"; Add-Type -AssemblyName System.Windows.Forms; [System.Windows.Forms.SendKeys]::SendWait("' +
    keys +
    '")'

  const result = runCommand('powershell', ['-NoProfile', '-NonInteractive', '-Command', script])
  if (result.status === 0) {
    return {
      success: true,
      details: `Clipboard pasted via ${shortcut === 'ctrl-shift-v' ? 'Ctrl+Shift+V' : 'Ctrl+V'}.`,
    }
  }

  return {
    success: false,
    details: result.stderr.trim() || 'Unable to send paste shortcut via PowerShell SendKeys.',
  }
}

export const performAutoPaste = (
  text: string,
  backend: AutoPasteBackend,
  options?: AutoPasteOptions,
): AutoPasteExecutionResult => {
  if (!text.trim()) {
    return {
      success: false,
      details: 'No text to paste.',
    }
  }

  const normalizedOptions = normalizeAutoPasteOptions(options)

  if (process.platform === 'linux') {
    if (normalizedOptions.mode === 'instant') {
      return runLinuxInstantAutoPaste(text, backend, normalizedOptions.shortcut)
    }

    return runLinuxStreamingPasteViaClipboard(text, backend, normalizedOptions.shortcut)
  }

  if (process.platform === 'darwin') {
    if (normalizedOptions.mode === 'instant') {
      return runMacInstantAutoPaste(text, normalizedOptions.shortcut)
    }

    return runMacStreamingAutoPaste(text)
  }

  if (process.platform === 'win32') {
    if (normalizedOptions.mode === 'instant') {
      return runWindowsInstantAutoPaste(text, normalizedOptions.shortcut)
    }

    return runWindowsStreamingAutoPaste(text)
  }

  return {
    success: false,
    details: `Auto-paste not supported on platform: ${process.platform}`,
  }
}
