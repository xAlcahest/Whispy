import { spawnSync } from 'node:child_process'
import type { AutoPasteBackend } from '../../shared/app'

export interface AutoPasteExecutionResult {
  success: boolean
  details: string
}

const runCommand = (command: string, args: string[]) => {
  return spawnSync(command, args, {
    encoding: 'utf8',
    timeout: 4000,
    windowsHide: true,
  })
}

const runLinuxAutoPaste = (text: string, backend: AutoPasteBackend): AutoPasteExecutionResult => {
  if (backend === 'wtype') {
    const result = runCommand('wtype', [text])
    if (result.status === 0) {
      return { success: true, details: 'Text typed via wtype.' }
    }

    return {
      success: false,
      details: result.stderr.trim() || 'wtype failed to type text.',
    }
  }

  if (backend === 'xdotools') {
    const result = runCommand('xdotool', ['type', '--clearmodifiers', '--delay', '0', text])
    if (result.status === 0) {
      return { success: true, details: 'Text typed via xdotool.' }
    }

    return {
      success: false,
      details: result.stderr.trim() || 'xdotool failed to type text.',
    }
  }

  const result = runCommand('ydotool', ['type', '--key-delay', '0', text])
  if (result.status === 0) {
    return { success: true, details: 'Text typed via ydotool.' }
  }

  return {
    success: false,
    details: result.stderr.trim() || 'ydotool failed to type text.',
  }
}

const runMacAutoPaste = (text: string): AutoPasteExecutionResult => {
  const escaped = text.replace(/\\/g, '\\\\').replace(/"/g, '\\"').replace(/\n/g, '\\n')
  const script = `tell application "System Events" to keystroke "${escaped}"`
  const result = runCommand('osascript', ['-e', script])

  if (result.status === 0) {
    return { success: true, details: 'Text typed via AppleScript.' }
  }

  return {
    success: false,
    details: result.stderr.trim() || 'AppleScript failed to type text.',
  }
}

const runWindowsAutoPaste = (text: string): AutoPasteExecutionResult => {
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
    return { success: true, details: 'Text typed via PowerShell SendKeys.' }
  }

  return {
    success: false,
    details: result.stderr.trim() || 'PowerShell SendKeys failed to type text.',
  }
}

export const performAutoPaste = (text: string, backend: AutoPasteBackend): AutoPasteExecutionResult => {
  if (!text.trim()) {
    return {
      success: false,
      details: 'No text to paste.',
    }
  }

  if (process.platform === 'linux') {
    return runLinuxAutoPaste(text, backend)
  }

  if (process.platform === 'darwin') {
    return runMacAutoPaste(text)
  }

  if (process.platform === 'win32') {
    return runWindowsAutoPaste(text)
  }

  return {
    success: false,
    details: `Auto-paste not supported on platform: ${process.platform}`,
  }
}
