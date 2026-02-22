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

const runLinuxInstantAutoPaste = (
  text: string,
  backend: AutoPasteBackend,
  shortcut: AutoPasteShortcut,
): AutoPasteExecutionResult => {
  clipboard.writeText(text)

  const attempts: Array<{ backend: string; run: () => ReturnType<typeof runCommand> }> = []

  if (backend === 'xdotools') {
    attempts.push({ backend: 'xdotool', run: () => runXdotoolPasteShortcut(shortcut) })
  } else if (backend === 'wtype') {
    attempts.push({ backend: 'wtype', run: () => runWtypePasteShortcut(shortcut) })
  }

  if (commandExists('xdotool')) {
    attempts.push({ backend: 'xdotool', run: () => runXdotoolPasteShortcut(shortcut) })
  }

  if (commandExists('wtype')) {
    attempts.push({ backend: 'wtype', run: () => runWtypePasteShortcut(shortcut) })
  }

  for (const attempt of attempts) {
    const result = attempt.run()
    if (result.status === 0) {
      return {
        success: true,
        details: `Clipboard pasted via ${attempt.backend} (${shortcut === 'ctrl-shift-v' ? 'Ctrl+Shift+V' : 'Ctrl+V'}).`,
      }
    }
  }

  return {
    success: false,
    details:
      'Clipboard updated, but paste shortcut could not be sent. Install xdotool or wtype, or switch to Streaming typing mode.',
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

    return runLinuxStreamingAutoPaste(text, backend)
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
