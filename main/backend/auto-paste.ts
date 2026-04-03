import { spawn, spawnSync, type ChildProcess } from 'node:child_process'
import { clipboard } from 'electron'
import type { AutoPasteBackend, AutoPasteMode, AutoPasteShortcut } from '../../shared/app'

let trackedYdotooldProcess: ChildProcess | null = null

export interface AutoPasteExecutionResult {
  success: boolean
  details: string
}

export interface AutoPasteOptions {
  mode?: AutoPasteMode
  shortcut?: AutoPasteShortcut
}

const runCommand = (command: string, args: string[], envOverrides?: NodeJS.ProcessEnv) => {
  return spawnSync(command, args, {
    encoding: 'utf8',
    timeout: 4000,
    windowsHide: true,
    env: envOverrides ? { ...process.env, ...envOverrides } : process.env,
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

interface LinuxPastePlan {
  attempts: LinuxPasteAttempt[]
  setupError: string | null
}

const STREAM_CLIPBOARD_CHUNK_SIZE = 72
const STREAM_CLIPBOARD_STEP_DELAY_MS = 8
const STREAM_CLIPBOARD_YIELD_INTERVAL = 24
const STREAM_CLIPBOARD_YIELD_DELAY_MS = 16
const STREAM_CLIPBOARD_CHUNK_RETRIES = 2
const CLIPBOARD_WRITE_VERIFY_ATTEMPTS = 3
const CLIPBOARD_WRITE_VERIFY_DELAY_MS = 10
const LINUX_PASTE_SHORTCUT_DELAY_MS = 40
const LINUX_CLIPBOARD_RESTORE_DELAY_MS = 220
const MAC_PASTE_SHORTCUT_DELAY_MS = 100
const WINDOWS_PASTE_SHORTCUT_DELAY_MS = 35
const YDOTOOL_STARTUP_RETRIES = 16
const YDOTOOL_STARTUP_DELAY_MS = 80

const sleepBlocking = (milliseconds: number) => {
  if (milliseconds <= 0) {
    return
  }

  const sleepSignal = new Int32Array(new SharedArrayBuffer(4))
  Atomics.wait(sleepSignal, 0, 0, milliseconds)
}

const normalizeClipboardText = (value: string) => value.replace(/\r\n/g, '\n')

const clipboardMatches = (expectedText: string) => {
  const currentClipboard = clipboard.readText()
  if (currentClipboard === expectedText) {
    return true
  }

  return normalizeClipboardText(currentClipboard) === normalizeClipboardText(expectedText)
}

const writeClipboardReliably = (text: string, maxAttempts = CLIPBOARD_WRITE_VERIFY_ATTEMPTS) => {
  const attempts = Math.max(1, maxAttempts)

  for (let attemptIndex = 0; attemptIndex < attempts; attemptIndex += 1) {
    clipboard.writeText(text)
    sleepBlocking(CLIPBOARD_WRITE_VERIFY_DELAY_MS)

    if (clipboardMatches(text)) {
      return true
    }
  }

  return false
}

const formatManualPasteShortcut = (shortcut: AutoPasteShortcut, platform: NodeJS.Platform) => {
  if (platform === 'darwin') {
    return shortcut === 'ctrl-shift-v' ? 'Cmd+Shift+V' : 'Cmd+V'
  }

  return shortcut === 'ctrl-shift-v' ? 'Ctrl+Shift+V' : 'Ctrl+V'
}

const ALLOWED_YDOTOOL_SOCKET_PREFIXES = ['/run/user/', '/tmp/']

const resolveYdotoolSocketPath = () => {
  const envSocketPath = process.env.YDOTOOL_SOCKET?.trim()
  if (envSocketPath && ALLOWED_YDOTOOL_SOCKET_PREFIXES.some((prefix) => envSocketPath.startsWith(prefix))) {
    return envSocketPath
  }

  const userId = typeof process.getuid === 'function' ? process.getuid() : null
  if (typeof userId === 'number') {
    return `/run/user/${userId}/.ydotool_socket`
  }

  return '/tmp/.ydotool_socket'
}

interface YdotoolReadyResult {
  ready: boolean
  socketPath: string
  error: string | null
}

const ensureYdotoolDaemonReady = (): YdotoolReadyResult => {
  const socketPath = resolveYdotoolSocketPath()
  const ydotoolEnv = {
    YDOTOOL_SOCKET: socketPath,
  }

  const probeReady = () => runCommand('ydotool', ['debug'], ydotoolEnv)

  const initialProbe = probeReady()
  if (initialProbe.status === 0) {
    process.env.YDOTOOL_SOCKET = socketPath
    return {
      ready: true,
      socketPath,
      error: null,
    }
  }

  if (!commandExists('ydotoold')) {
    return {
      ready: false,
      socketPath,
      error: 'ydotoold daemon binary is not installed. Install ydotool package and retry.',
    }
  }

  try {
    const daemonProcess = spawn('ydotoold', ['--socket-path', socketPath, '--socket-perm', '0600'], {
      detached: true,
      stdio: 'ignore',
      windowsHide: true,
      env: {
        ...process.env,
        YDOTOOL_SOCKET: socketPath,
      },
    })

    daemonProcess.unref()
    trackedYdotooldProcess = daemonProcess
  } catch (error: unknown) {
    return {
      ready: false,
      socketPath,
      error: error instanceof Error ? error.message : 'Unable to start ydotoold daemon.',
    }
  }

  for (let retryIndex = 0; retryIndex < YDOTOOL_STARTUP_RETRIES; retryIndex += 1) {
    sleepBlocking(YDOTOOL_STARTUP_DELAY_MS)
    const retryProbe = probeReady()
    if (retryProbe.status === 0) {
      process.env.YDOTOOL_SOCKET = socketPath
      return {
        ready: true,
        socketPath,
        error: null,
      }
    }
  }

  const finalProbe = probeReady()
  const stderrPreview = finalProbe.stderr.trim().split('\n')[0] ?? ''
  const permissionHint = /permission|uinput|denied/i.test(stderrPreview)
    ? ' Permission issue detected: ensure your user can access /dev/uinput or run ydotoold with elevated permissions and user-owned socket.'
    : ''

  return {
    ready: false,
    socketPath,
    error:
      (stderrPreview || `ydotool debug failed (exit ${finalProbe.status ?? 'n/a'})`) +
      permissionHint +
      ' If needed, see Settings > FAQ > ydotool daemon setup.',
  }
}

const chunkTextForStreamingPaste = (text: string) => {
  const tokens = text.split(/(\s+)/)
  const chunks: string[] = []
  let currentChunk = ''

  const flushChunk = () => {
    if (!currentChunk) {
      return
    }

    chunks.push(currentChunk)
    currentChunk = ''
  }

  for (const token of tokens) {
    if (!token) {
      continue
    }

    if (token.length > STREAM_CLIPBOARD_CHUNK_SIZE) {
      flushChunk()
      const characters = Array.from(token)
      for (let index = 0; index < characters.length; index += STREAM_CLIPBOARD_CHUNK_SIZE) {
        chunks.push(characters.slice(index, index + STREAM_CLIPBOARD_CHUNK_SIZE).join(''))
      }
      continue
    }

    if (currentChunk.length + token.length > STREAM_CLIPBOARD_CHUNK_SIZE) {
      flushChunk()
    }

    currentChunk += token
  }

  flushChunk()

  return chunks.length > 0 ? chunks : ['']
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

const resolveLinuxPasteTool = (backend: AutoPasteBackend): LinuxPasteTool => {
  if (backend === 'xdotools') {
    return 'xdotool'
  }

  if (backend === 'wtype') {
    return 'wtype'
  }

  return 'ydotool'
}

const createLinuxPasteShortcutAttempt = (tool: LinuxPasteTool, shortcut: AutoPasteShortcut): LinuxPasteAttempt => {
  if (tool === 'xdotool') {
    return { backend: tool, run: () => runXdotoolPasteShortcut(shortcut) }
  }

  if (tool === 'wtype') {
    return { backend: tool, run: () => runWtypePasteShortcut(shortcut) }
  }

  return { backend: tool, run: () => runYdotoolPasteShortcut(shortcut) }
}

const buildLinuxPasteShortcutAttempts = (
  backend: AutoPasteBackend,
  shortcut: AutoPasteShortcut,
): LinuxPastePlan => {
  const selectedTool = resolveLinuxPasteTool(backend)
  if (!commandExists(selectedTool)) {
    return {
      attempts: [],
      setupError: `Selected backend ${selectedTool} is not installed or not accessible.`,
    }
  }

  if (selectedTool === 'ydotool') {
    const ydotoolReady = ensureYdotoolDaemonReady()
    if (!ydotoolReady.ready) {
      return {
        attempts: [],
        setupError: ydotoolReady.error ?? 'Unable to initialize ydotool daemon.',
      }
    }
  }

  return {
    attempts: [createLinuxPasteShortcutAttempt(selectedTool, shortcut)],
    setupError: null,
  }
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
  const manualPasteShortcut = formatManualPasteShortcut(shortcut, 'linux')
  const previousClipboardText = clipboard.readText()

  if (!writeClipboardReliably(text)) {
    clipboard.writeText(text)
    return {
      success: false,
      details: `Unable to verify clipboard write for streaming mode. Text was copied to clipboard; paste manually with ${manualPasteShortcut}.`,
    }
  }

  const plan = buildLinuxPasteShortcutAttempts(backend, shortcut)
  const attempts = plan.attempts
  if (attempts.length === 0) {
    return {
      success: false,
      details:
        `${plan.setupError ?? 'Streaming paste unavailable for selected backend.'} ` +
        `Text was copied to clipboard; paste manually with ${manualPasteShortcut}.`,
    }
  }

  let selectedAttempt: LinuxPasteAttempt | null = null

  try {
    const chunks = chunkTextForStreamingPaste(text)

    for (let index = 0; index < chunks.length; index += 1) {
      const chunk = chunks[index] ?? ''
      if (!writeClipboardReliably(chunk)) {
        writeClipboardReliably(text)
        return {
          success: false,
          details: `Streaming paste failed while preparing chunk ${index + 1}/${chunks.length}. Full text remains copied; paste manually with ${manualPasteShortcut}.`,
        }
      }

      if (LINUX_PASTE_SHORTCUT_DELAY_MS > 0) {
        sleepBlocking(LINUX_PASTE_SHORTCUT_DELAY_MS)
      }

      let successfulAttempt: LinuxPasteAttempt | null = null
      for (let retryIndex = 0; retryIndex <= STREAM_CLIPBOARD_CHUNK_RETRIES; retryIndex += 1) {
        successfulAttempt = executeLinuxPasteAttempt(attempts, selectedAttempt)
        if (successfulAttempt) {
          break
        }

        sleepBlocking(2)
      }

      if (!successfulAttempt) {
        writeClipboardReliably(text)
        return {
          success: false,
          details:
            `Streaming paste failed while sending chunk ${index + 1}/${chunks.length}. ` +
            `Full text remains copied to clipboard; paste manually with ${manualPasteShortcut}.`,
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

    if (LINUX_CLIPBOARD_RESTORE_DELAY_MS > 0) {
      sleepBlocking(LINUX_CLIPBOARD_RESTORE_DELAY_MS)
    }

    writeClipboardReliably(previousClipboardText, 2)

    return {
      success: true,
      details: `Text streamed via clipboard chunks and ${selectedAttempt?.backend ?? 'paste shortcut'} (${shortcut === 'ctrl-shift-v' ? 'Ctrl+Shift+V' : 'Ctrl+V'}).`,
    }
  } catch (error: unknown) {
    writeClipboardReliably(text)
    const reason = error instanceof Error ? error.message : String(error)
    return {
      success: false,
      details:
        `Streaming paste raised an unexpected error (${reason}). ` +
        `Text was copied to clipboard; paste manually with ${manualPasteShortcut}.`,
    }
  }
}

const runLinuxInstantAutoPaste = (
  text: string,
  backend: AutoPasteBackend,
  shortcut: AutoPasteShortcut,
): AutoPasteExecutionResult => {
  const manualPasteShortcut = formatManualPasteShortcut(shortcut, 'linux')
  const previousClipboardText = clipboard.readText()
  if (!writeClipboardReliably(text)) {
    clipboard.writeText(text)
    return {
      success: false,
      details: `Unable to verify clipboard write. Text was copied to clipboard; paste manually with ${manualPasteShortcut}.`,
    }
  }

  if (LINUX_PASTE_SHORTCUT_DELAY_MS > 0) {
    sleepBlocking(LINUX_PASTE_SHORTCUT_DELAY_MS)
  }

  const plan = buildLinuxPasteShortcutAttempts(backend, shortcut)
  const attempts = plan.attempts
  if (attempts.length === 0) {
    return {
      success: false,
      details:
        `${plan.setupError ?? 'Clipboard updated, but selected backend is unavailable.'} ` +
        `Text remains copied; paste manually with ${manualPasteShortcut}.`,
    }
  }

  const successfulAttempt = executeLinuxPasteAttempt(attempts, null)
  if (successfulAttempt) {
    if (LINUX_CLIPBOARD_RESTORE_DELAY_MS > 0) {
      sleepBlocking(LINUX_CLIPBOARD_RESTORE_DELAY_MS)
    }

    writeClipboardReliably(previousClipboardText, 2)

    return {
      success: true,
      details: `Clipboard pasted via ${successfulAttempt.backend} (${shortcut === 'ctrl-shift-v' ? 'Ctrl+Shift+V' : 'Ctrl+V'}).`,
    }
  }

  return {
    success: false,
    details:
      `Clipboard updated, but paste shortcut could not be sent. Text remains copied; paste manually with ${manualPasteShortcut}.`,
  }
}

const runMacStreamingAutoPaste = (text: string): AutoPasteExecutionResult => {
  const manualPasteShortcut = formatManualPasteShortcut('ctrl-v', 'darwin')
  writeClipboardReliably(text)

  const sanitized = Array.from(text)
    .filter((ch) => {
      const code = ch.charCodeAt(0)
      if (code <= 0x08) return false
      if (code === 0x0B || code === 0x0C) return false
      if (code >= 0x0E && code <= 0x1F) return false
      if (code === 0x7F) return false
      return true
    })
    .join('')
  const escaped = sanitized
    .replace(/\\/g, '\\\\')
    .replace(/"/g, '\\"')
    .replace(/\n/g, '\\n')
    .replace(/\r/g, '\\r')
    .replace(/\t/g, '\\t')
  const script = `tell application "System Events" to keystroke "${escaped}"`
  const result = runCommand('osascript', ['-e', script])

  if (result.status === 0) {
    return { success: true, details: 'Text typed via AppleScript (stream mode).' }
  }

  return {
    success: false,
    details:
      (result.stderr.trim() || 'AppleScript failed to type text.') +
      ` Text was copied to clipboard; paste manually with ${manualPasteShortcut}.`,
  }
}

const runMacInstantAutoPaste = (text: string, shortcut: AutoPasteShortcut): AutoPasteExecutionResult => {
  const manualPasteShortcut = formatManualPasteShortcut(shortcut, 'darwin')

  if (!writeClipboardReliably(text)) {
    clipboard.writeText(text)
    return {
      success: false,
      details: `Unable to verify clipboard write. Text was copied to clipboard; paste manually with ${manualPasteShortcut}.`,
    }
  }

  if (MAC_PASTE_SHORTCUT_DELAY_MS > 0) {
    sleepBlocking(MAC_PASTE_SHORTCUT_DELAY_MS)
  }

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
    details:
      (result.stderr.trim() || 'Unable to send paste shortcut via AppleScript.') +
      ` Text remains copied; paste manually with ${manualPasteShortcut}.`,
  }
}

const runWindowsStreamingAutoPaste = (text: string): AutoPasteExecutionResult => {
  const manualPasteShortcut = formatManualPasteShortcut('ctrl-v', 'win32')
  writeClipboardReliably(text)

  const escaped = text
    .replace(/`/g, '``')
    .replace(/\$/g, '`$')
    .replace(/"/g, '`"')
    .replace(/\(/g, '`(')
    .replace(/\)/g, '`)')
    .replace(/\{/g, '`{')
    .replace(/\}/g, '`}')
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
    details:
      (result.stderr.trim() || 'PowerShell SendKeys failed to type text.') +
      ` Text was copied to clipboard; paste manually with ${manualPasteShortcut}.`,
  }
}

const runWindowsInstantAutoPaste = (text: string, shortcut: AutoPasteShortcut): AutoPasteExecutionResult => {
  const manualPasteShortcut = formatManualPasteShortcut(shortcut, 'win32')

  if (!writeClipboardReliably(text)) {
    clipboard.writeText(text)
    return {
      success: false,
      details: `Unable to verify clipboard write. Text was copied to clipboard; paste manually with ${manualPasteShortcut}.`,
    }
  }

  if (WINDOWS_PASTE_SHORTCUT_DELAY_MS > 0) {
    sleepBlocking(WINDOWS_PASTE_SHORTCUT_DELAY_MS)
  }

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
    details:
      (result.stderr.trim() || 'Unable to send paste shortcut via PowerShell SendKeys.') +
      ` Text remains copied; paste manually with ${manualPasteShortcut}.`,
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

export const cleanupYdotoolDaemon = () => {
  if (!trackedYdotooldProcess) {
    return
  }

  try {
    if (trackedYdotooldProcess.pid != null) {
      process.kill(trackedYdotooldProcess.pid)
    }
  } catch {
    // Process may have already exited
  }

  trackedYdotooldProcess = null
}
