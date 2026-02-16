import { app, BrowserWindow, globalShortcut, ipcMain, screen, shell, systemPreferences } from 'electron'
import { spawnSync } from 'node:child_process'
import { existsSync } from 'node:fs'
import { join } from 'node:path'
import type { AppSettings, HistoryEntry, ModelState } from '../shared/app'
import {
  applySecretsToSettings,
  extractSecretSettings,
  stripSecretsFromSettings,
  type SecretStorageMode,
} from '../shared/secrets'
import {
  type AutoPasteExecutionResult,
  type AutoPasteBackendSupportPayload,
  type DebugLogStatusPayload,
  IPCChannels,
  type DisplayServer,
  type HotkeyFallbackUsedPayload,
  type HotkeyRegistrationFailedPayload,
  type LocalModelScope,
  type ModelDownloadProgressPayload,
  type OverlaySizeKey,
  type PromptTestResultPayload,
  type SecretStorageMigrationPayload,
  type SecretStorageStatusPayload,
  type WhisperRuntimeDiagnosticsPayload,
} from '../shared/ipc'
import { detectActiveApp } from './backend/active-app'
import { performAutoPaste } from './backend/auto-paste'
import { DebugLogger } from './backend/debug-logger'
import { DictationPipeline } from './backend/dictation-pipeline'
import { DictationRuntime } from './backend/dictation-runtime'
import { LocalModelStore, type ModelDownloadProgress, type WhisperRuntimeVariant } from './backend/model-files'
import { SecretStore } from './backend/secret-store'
import { BackendStateStore } from './backend/state-store'
import { WhisperServerManager } from './backend/whisper-server'

if (process.platform === 'linux') {
  app.disableHardwareAcceleration()
  app.commandLine.appendSwitch('disable-gpu')
}

interface OverlaySize {
  width: number
  height: number
}

const OVERLAY_MARGIN = 24
const OVERLAY_SIZES: Record<OverlaySizeKey, OverlaySize> = {
  BASE: { width: 96, height: 96 },
  WITH_MENU: { width: 240, height: 280 },
  WITH_TOAST: { width: 400, height: 500 },
  EXPANDED: { width: 420, height: 240 },
}

let overlayWindow: BrowserWindow | null = null
let controlPanelWindow: BrowserWindow | null = null
let backendStateStore: BackendStateStore | null = null
let secretStore: SecretStore | null = null
let debugLogger: DebugLogger | null = null
let dictationPipeline: DictationPipeline | null = null
let dictationRuntime: DictationRuntime | null = null
let localModelStore: LocalModelStore | null = null
let whisperServerManager: WhisperServerManager | null = null
let registeredHotkey: string | null = null
const appStartupStartedAt = Date.now()
const downloadProgressLogMarkers = new Map<string, string>()

const emitControlWindowMaximizeChanged = () => {
  if (!controlPanelWindow || controlPanelWindow.isDestroyed()) {
    return
  }

  controlPanelWindow.webContents.send(IPCChannels.windowMaximizeChanged, controlPanelWindow.isMaximized())
}

const preloadPath = join(__dirname, '../preload/index.mjs')

const getOverlayBounds = (size: OverlaySize) => {
  const display = overlayWindow
    ? screen.getDisplayMatching(overlayWindow.getBounds())
    : screen.getPrimaryDisplay()
  const { workArea } = display
  return {
    x: Math.round(workArea.x + workArea.width - size.width - OVERLAY_MARGIN),
    y: Math.round(workArea.y + workArea.height - size.height - OVERLAY_MARGIN),
    width: size.width,
    height: size.height,
  }
}

const loadRoute = async (window: BrowserWindow, route: 'overlay' | 'control') => {
  if (process.env.ELECTRON_RENDERER_URL) {
    await window.loadURL(`${process.env.ELECTRON_RENDERER_URL}#/${route}`)
    return
  }

  await window.loadFile(join(__dirname, '../renderer/index.html'), {
    hash: `/${route}`,
  })
}

const openExternalInBrowser = (targetURL: string) => {
  try {
    const parsedURL = new URL(targetURL)
    if (!['http:', 'https:'].includes(parsedURL.protocol)) {
      return
    }

    void shell.openExternal(parsedURL.toString())
  } catch {
    return
  }
}

const resolveActionWindow = (sourceWebContents?: Electron.WebContents | null) => {
  if (controlPanelWindow && !controlPanelWindow.isDestroyed()) {
    return controlPanelWindow
  }

  if (sourceWebContents) {
    const senderWindow = BrowserWindow.fromWebContents(sourceWebContents)
    if (senderWindow && !senderWindow.isDestroyed()) {
      return senderWindow
    }
  }

  return BrowserWindow.getFocusedWindow() ?? overlayWindow
}

const runInternalWindowAction = (targetURL: string, sourceWebContents?: Electron.WebContents | null) => {
  let parsedURL: URL
  try {
    parsedURL = new URL(targetURL)
  } catch {
    return false
  }

  if (parsedURL.protocol !== 'whispy-action:') {
    return false
  }

  const actionKey = `${parsedURL.hostname}${parsedURL.pathname}`.replace(/\/+$/, '')

  if (actionKey === 'app/quit' || actionKey === 'window/close') {
    app.exit(0)
    return true
  }

  const actionWindow = resolveActionWindow(sourceWebContents)
  if (!actionWindow) {
    return true
  }

  if (actionKey === 'window/minimize') {
    actionWindow.minimize()
    return true
  }

  if (actionKey === 'window/toggle-maximize') {
    if (actionWindow.isMaximized()) {
      actionWindow.unmaximize()
    } else {
      actionWindow.maximize()
    }

    emitControlWindowMaximizeChanged()
    return true
  }

  if (actionKey === 'autopaste/detect') {
    const payload = detectAutoPasteBackendSupport()

    if (sourceWebContents && !sourceWebContents.isDestroyed()) {
      const serializedPayload = JSON.stringify(payload).replace(/</g, '\\u003c')
      void sourceWebContents.executeJavaScript(
        `window.dispatchEvent(new CustomEvent('whispy-autopaste-support', { detail: ${serializedPayload} }));`,
      )
    }

    return true
  }

  return true
}

const forceExternalLinksToBrowser = (window: BrowserWindow) => {
  window.webContents.setWindowOpenHandler(({ url }) => {
    if (runInternalWindowAction(url, window.webContents)) {
      return { action: 'deny' }
    }

    openExternalInBrowser(url)
    return { action: 'deny' }
  })
}

const getDisplayServer = (): DisplayServer => {
  const sessionType = process.env.XDG_SESSION_TYPE?.toLowerCase()

  if (sessionType === 'wayland' || Boolean(process.env.WAYLAND_DISPLAY)) {
    return 'wayland'
  }

  if (sessionType === 'x11' || Boolean(process.env.DISPLAY)) {
    return 'x11'
  }

  return 'unknown'
}

const getCompositorName = () => {
  const rawCompositorName =
    process.env.XDG_CURRENT_DESKTOP ?? process.env.XDG_SESSION_DESKTOP ?? process.env.DESKTOP_SESSION ?? 'Unknown'

  const normalized = rawCompositorName
    .split(':')
    .map((part) => part.trim())
    .find((part) => part.length > 0)

  return normalized ?? rawCompositorName
}

const WAYLAND_WTYPE_UNSUPPORTED_HINTS = ['gnome', 'kde', 'plasma', 'cinnamon', 'mate', 'unity', 'deepin']

const WAYLAND_WTYPE_COMPATIBILITY_MESSAGE =
  'wtype is available but may not be supported by this Wayland compositor. Try ydotools for broader compatibility.'

const compositorLikelyUnsupportedForWtype = (compositorName: string) => {
  const normalized = compositorName.toLowerCase()
  return WAYLAND_WTYPE_UNSUPPORTED_HINTS.some((token) => normalized.includes(token))
}

const AUTO_PASTE_BINARY_BY_BACKEND = {
  wtype: 'wtype',
  xdotools: 'xdotool',
  ydotools: 'ydotool',
} as const

const AUTO_PASTE_PROBE_ARGS: Record<keyof typeof AUTO_PASTE_BINARY_BY_BACKEND, string[]> = {
  wtype: ['--help'],
  xdotools: ['getmouselocation'],
  ydotools: ['--help'],
}

const resolveCommandPath = (command: string) => {
  const lookupCommand = process.platform === 'win32' ? 'where' : 'which'
  const lookup = spawnSync(lookupCommand, [command], {
    encoding: 'utf8',
    timeout: 1200,
    windowsHide: true,
  })

  if (lookup.status !== 0) {
    return null
  }

  const resolved = lookup.stdout
    .split(/\r?\n/)
    .map((line) => line.trim())
    .find((line) => line.length > 0)

  return resolved ?? null
}

const commandAvailable = (command: string) => {
  return resolveCommandPath(command) !== null
}

const runAutoPasteProbe = (
  backendId: keyof typeof AUTO_PASTE_BINARY_BY_BACKEND,
  displayServer: DisplayServer,
  compositorName: string,
) => {
  const binaryName = AUTO_PASTE_BINARY_BY_BACKEND[backendId]

  if (
    backendId === 'wtype' &&
    displayServer === 'wayland' &&
    compositorLikelyUnsupportedForWtype(compositorName)
  ) {
    return {
      id: backendId,
      available: false,
      details: `${WAYLAND_WTYPE_COMPATIBILITY_MESSAGE} (detected: ${compositorName})`,
    }
  }

  const binaryPath = resolveCommandPath(binaryName)
  if (!binaryPath) {
    return {
      id: backendId,
      available: false,
      details: `${binaryName} not found in PATH`,
    }
  }

  const probe = spawnSync(binaryName, AUTO_PASTE_PROBE_ARGS[backendId], {
    encoding: 'utf8',
    timeout: 1200,
  })

  if (probe.error) {
    const errorCode = (probe.error as NodeJS.ErrnoException).code
    if (backendId === 'wtype' && displayServer === 'wayland') {
      return {
        id: backendId,
        available: false,
        details: `${WAYLAND_WTYPE_COMPATIBILITY_MESSAGE} (detected: ${compositorName})`,
      }
    }

    return {
      id: backendId,
      available: false,
      details: `Detected but probe failed (${errorCode ?? 'unknown error'})`,
    }
  }

  if (probe.status === 0) {
    return {
      id: backendId,
      available: true,
      details: `${binaryName} detected (non-destructive probe OK)`,
    }
  }

  const stderrPreview = probe.stderr.trim().split('\n')[0]

  if (backendId === 'wtype' && displayServer === 'wayland') {
    return {
      id: backendId,
      available: false,
      details: `${WAYLAND_WTYPE_COMPATIBILITY_MESSAGE} (detected: ${compositorName})`,
    }
  }

  return {
    id: backendId,
    available: false,
    details: stderrPreview
      ? `${binaryName} probe failed: ${stderrPreview}`
      : `${binaryName} probe failed (exit code ${probe.status ?? 'n/a'})`,
  }
}

const detectAutoPasteBackendSupport = (): AutoPasteBackendSupportPayload => {
  const detectedDisplayServer = getDisplayServer()
  const compositorName = getCompositorName()
  const statuses = (Object.keys(AUTO_PASTE_BINARY_BY_BACKEND) as Array<keyof typeof AUTO_PASTE_BINARY_BY_BACKEND>).map(
    (backendId) => runAutoPasteProbe(backendId, detectedDisplayServer, compositorName),
  ) as AutoPasteBackendSupportPayload['statuses']

  return {
    detectedDisplayServer,
    compositorName,
    checkedAt: Date.now(),
    statuses,
  }
}

const createOverlayWindow = async () => {
  const baseBounds = getOverlayBounds(OVERLAY_SIZES.BASE)
  overlayWindow = new BrowserWindow({
    ...baseBounds,
    frame: false,
    transparent: true,
    resizable: false,
    movable: true,
    skipTaskbar: true,
    alwaysOnTop: true,
    hasShadow: false,
    backgroundColor: '#00000000',
    webPreferences: {
      preload: preloadPath,
      contextIsolation: true,
      nodeIntegration: false,
    },
  })

  forceExternalLinksToBrowser(overlayWindow)

  overlayWindow.setAlwaysOnTop(true, 'screen-saver')
  overlayWindow.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true })
  overlayWindow.on('closed', () => {
    overlayWindow = null
  })

  await loadRoute(overlayWindow, 'overlay')
}

const createControlPanelWindow = async () => {
  const useNativeWindowChrome = process.platform === 'win32' || process.platform === 'linux'

  controlPanelWindow = new BrowserWindow({
    width: 1200,
    height: 800,
    minWidth: 960,
    minHeight: 660,
    minimizable: true,
    maximizable: true,
    closable: true,
    frame: useNativeWindowChrome,
    titleBarStyle: process.platform === 'darwin' ? 'hiddenInset' : undefined,
    backgroundColor: '#0f1117',
    show: false,
    webPreferences: {
      preload: preloadPath,
      contextIsolation: true,
      nodeIntegration: false,
    },
  })

  forceExternalLinksToBrowser(controlPanelWindow)

  controlPanelWindow.on('closed', () => {
    controlPanelWindow = null
  })

  controlPanelWindow.on('maximize', emitControlWindowMaximizeChanged)
  controlPanelWindow.on('unmaximize', emitControlWindowMaximizeChanged)
  controlPanelWindow.webContents.on('did-finish-load', () => {
    emitControlWindowMaximizeChanged()
  })

  await loadRoute(controlPanelWindow, 'control')
}

const ensureControlPanelWindow = async () => {
  if (!controlPanelWindow) {
    await createControlPanelWindow()
  }

  controlPanelWindow?.show()
  controlPanelWindow?.focus()
}

const setOverlaySize = (sizeKey: OverlaySizeKey) => {
  if (!overlayWindow) {
    return
  }

  const targetSize = OVERLAY_SIZES[sizeKey]
  const targetBounds = getOverlayBounds(targetSize)
  overlayWindow.setBounds(targetBounds, true)
}

const broadcast = (channel: string, payload: unknown) => {
  overlayWindow?.webContents.send(channel, payload)
  controlPanelWindow?.webContents.send(channel, payload)
}

const broadcastModelDownloadProgress = (payload: ModelDownloadProgress) => {
  const typedPayload: ModelDownloadProgressPayload = payload
  broadcast(IPCChannels.modelDownloadProgress, typedPayload)
}

const ensureBackendStateStore = () => {
  if (!backendStateStore) {
    const userDataPath = app.getPath('userData')
    const stateDbPath = join(userDataPath, 'app-state.sqlite')
    const legacyStateFilePath = join(userDataPath, 'app-state.json')
    backendStateStore = new BackendStateStore(stateDbPath, legacyStateFilePath)
  }

  return backendStateStore
}

const ensureSecretStore = () => {
  if (!secretStore) {
    const userDataPath = app.getPath('userData')
    const encryptedSecretFallbackPath = join(userDataPath, 'secrets.bin')
    const plaintextSecretsEnvPath = join(userDataPath, '.env')
    secretStore = new SecretStore(encryptedSecretFallbackPath, plaintextSecretsEnvPath)
  }

  return secretStore
}

const resolveSecretStorageMode = (settings: AppSettings): SecretStorageMode =>
  settings.keytarEnabled ? 'keyring' : 'env'

const resolveBundledWhisperServerPath = (variant: WhisperRuntimeVariant) => {
  const executableSuffix = process.platform === 'win32' ? '.exe' : ''
  const platformArch = `${process.platform}-${process.arch}`
  const candidateNames = [
    `whisper-server-${platformArch}-${variant}${executableSuffix}`,
    `whisper-server-${platformArch}${executableSuffix}`,
    `whisper-server-${variant}${executableSuffix}`,
    `whisper-server${executableSuffix}`,
  ]

  const candidateDirectories = [
    join(process.resourcesPath, 'bin', 'whispercpp', platformArch, variant),
    join(app.getAppPath(), 'resources', 'bin', 'whispercpp', platformArch, variant),
    join(app.getAppPath(), 'bin', 'whispercpp', platformArch, variant),
    join(process.resourcesPath, 'bin'),
    join(app.getAppPath(), 'resources', 'bin'),
    join(app.getAppPath(), 'bin'),
  ]

  for (const directory of candidateDirectories) {
    for (const fileName of candidateNames) {
      const candidatePath = join(directory, fileName)
      if (existsSync(candidatePath)) {
        return candidatePath
      }
    }
  }

  return null
}

const getWhisperRuntimeStatus = (settings: AppSettings) => {
  const modelStore = ensureLocalModelStore()
  const cpuInstalled = Boolean(
    modelStore.resolveDownloadedWhisperRuntimePath('cpu') ?? resolveBundledWhisperServerPath('cpu'),
  )
  const cudaInstalled = Boolean(
    modelStore.resolveDownloadedWhisperRuntimePath('cuda') ?? resolveBundledWhisperServerPath('cuda'),
  )

  return {
    cpuInstalled,
    cudaInstalled,
    activeVariant: settings.whisperCppRuntimeVariant,
    runtimeDirectory: join(app.getPath('userData'), 'models', 'runtime', 'whispercpp'),
    downloadUrls: {
      cpu: modelStore.getWhisperRuntimeDownloadUrl('cpu'),
      cuda: modelStore.getWhisperRuntimeDownloadUrl('cuda'),
    },
  }
}

const ensureLocalModelStore = () => {
  if (!localModelStore) {
    const modelRootPath = join(app.getPath('userData'), 'models')
    localModelStore = new LocalModelStore(modelRootPath)
  }

  return localModelStore
}

const ensureWhisperServerManager = () => {
  if (!whisperServerManager) {
    whisperServerManager = new WhisperServerManager({
      resolveDownloadedServerPath: (variant) => ensureLocalModelStore().resolveDownloadedWhisperServerPath(variant),
      resolveBundledServerPath: resolveBundledWhisperServerPath,
      log: (category, message, details) => {
        ensureDebugLogger().log(category, message, details)
      },
    })
  }

  return whisperServerManager
}

const ensureDebugLogger = () => {
  if (!debugLogger) {
    const logsDirectory = join(app.getPath('userData'), 'logs', 'debug')
    debugLogger = new DebugLogger(logsDirectory)
  }

  return debugLogger
}

const logDebug = (
  category: Parameters<DebugLogger['log']>[0],
  message: string,
  details?: unknown,
  scope?: string,
) => {
  ensureDebugLogger().log(category, message, details, scope)
}

const shouldLogModelDownloadProgress = (payload: ModelDownloadProgress) => {
  const markerKey = `${payload.scope}:${payload.modelId}`

  if (payload.state !== 'downloading') {
    downloadProgressLogMarkers.delete(markerKey)
    return true
  }

  const bucket = Math.floor(payload.progress / 10) * 10
  const marker = `${payload.state}:${bucket}`
  if (downloadProgressLogMarkers.get(markerKey) === marker) {
    return false
  }

  downloadProgressLogMarkers.set(markerKey, marker)
  return true
}

const registerGlobalErrorHandlers = () => {
  process.on('unhandledRejection', (reason) => {
    logDebug('error-details', 'Unhandled promise rejection captured', {
      reason: reason instanceof Error ? reason.message : String(reason),
    })
  })

  process.on('uncaughtException', (error) => {
    logDebug('error-details', 'Uncaught exception captured', {
      message: error.message,
      stack: error.stack,
    })
  })
}

const collectStartupDiagnostics = async (settings: AppSettings) => {
  const recorderCandidates = ['arecord', 'sox', 'rec']
  const availableRecorders = recorderCandidates.filter((candidate) => commandAvailable(candidate))
  const ffmpegConfiguredCommand = process.env.WHISPY_FFMPEG_COMMAND?.trim() ?? ''
  const ffmpegResolvedPath = ffmpegConfiguredCommand || resolveCommandPath('ffmpeg')
  const keyringStatus = await ensureSecretStore().getStorageStatus(resolveSecretStorageMode(settings))
  const autoPasteSupport = detectAutoPasteBackendSupport()
  const whisperRuntimeDiagnostics = await ensureWhisperServerManager().getDiagnostics(settings.whisperCppRuntimeVariant)
  const backendSnapshot = ensureBackendStateStore().getSnapshot()

  const downloadedModels = backendSnapshot.models
    .filter((model) => model.downloaded)
    .map((model) => ({
      name: model.id,
      size: model.size,
    }))

  return {
    platform: process.platform,
    displayServer: getDisplayServer(),
    compositor: getCompositorName(),
    microphonePermission:
      process.platform === 'darwin' ? systemPreferences.getMediaAccessStatus('microphone') : 'granted-or-not-required',
    recorderBinaries: {
      available: availableRecorders,
      missing: recorderCandidates.filter((candidate) => !availableRecorders.includes(candidate)),
    },
    dependencies: {
      whisperServer: {
        available: Boolean(whisperRuntimeDiagnostics.commandPath),
        running: whisperRuntimeDiagnostics.running,
        variant: settings.whisperCppRuntimeVariant,
        path: whisperRuntimeDiagnostics.commandPath ?? 'not found',
        source: whisperRuntimeDiagnostics.commandSource ?? 'n/a',
      },
      ffmpeg: {
        available: Boolean(ffmpegResolvedPath),
        path: ffmpegResolvedPath ?? 'not found',
        configuredCommand: Boolean(ffmpegConfiguredCommand),
      },
      keyring: {
        mode: keyringStatus.mode,
        supported: keyringStatus.keyringSupported,
      },
    },
    models: downloadedModels,
    autoPaste: {
      displayServer: autoPasteSupport.detectedDisplayServer,
      compositor: autoPasteSupport.compositorName,
      statuses: autoPasteSupport.statuses.map((status) => ({
        id: status.id,
        available: status.available,
      })),
    },
    whisperRuntime: {
      pid: whisperRuntimeDiagnostics.pid,
      port: whisperRuntimeDiagnostics.port,
      rssMB: whisperRuntimeDiagnostics.processRssMB,
      vramMB: whisperRuntimeDiagnostics.vramUsedMB,
      cudaVisible: whisperRuntimeDiagnostics.cudaProcessDetected,
    },
  }
}

const reconcileModelAvailabilityWithDisk = () => {
  const stateStore = ensureBackendStateStore()
  const modelStore = ensureLocalModelStore()
  const snapshot = stateStore.getSnapshot()

  const reconciledTranscriptionModels = snapshot.models.map((model) => {
    const downloaded = Boolean(modelStore.resolveDownloadedModelPath('transcription', model.id))
    return {
      ...model,
      downloaded,
      downloading: false,
      progress: downloaded ? 100 : 0,
    }
  })

  const reconciledPostModels = snapshot.postModels.map((model) => {
    const downloaded = Boolean(modelStore.resolveDownloadedModelPath('post', model.id))
    return {
      ...model,
      downloaded,
      downloading: false,
      progress: downloaded ? 100 : 0,
    }
  })

  stateStore.setModels(reconciledTranscriptionModels)
  stateStore.setPostModels(reconciledPostModels)
}

const getBackendSnapshotWithSecrets = async () => {
  const snapshot = ensureBackendStateStore().getSnapshotOrNull()
  if (!snapshot) {
    return null
  }

  const secrets = await ensureSecretStore().getSecrets(resolveSecretStorageMode(snapshot.settings))

  return {
    ...snapshot,
    settings: applySecretsToSettings(snapshot.settings, secrets),
  }
}

const loadCurrentSettings = async (): Promise<AppSettings> => {
  const snapshot = await getBackendSnapshotWithSecrets()
  if (snapshot) {
    return snapshot.settings
  }

  return ensureBackendStateStore().getSnapshot().settings
}

const ensureDictationPipeline = () => {
  if (!dictationPipeline) {
    dictationPipeline = new DictationPipeline({
      loadSettings: loadCurrentSettings,
      resolveLocalModelPath: (scope, modelId) => ensureLocalModelStore().resolveDownloadedModelPath(scope, modelId),
      resolveWhisperRuntimePath: (variant) => ensureLocalModelStore().resolveDownloadedWhisperRuntimePath(variant),
      transcribeWithWhisperServer: (audioFilePath, modelPath, runtimeVariant) =>
        ensureWhisperServerManager().transcribeAudioFile(audioFilePath, modelPath, runtimeVariant),
      detectActiveApp,
      log: (category, message, details) => {
        logDebug(category, message, details)
      },
    })
  }

  return dictationPipeline
}

const ensureDictationRuntime = () => {
  if (!dictationRuntime) {
    dictationRuntime = new DictationRuntime({
      onStatusChanged: (status) => {
        logDebug('audio-processing', 'Dictation runtime status changed', {
          status,
        })
        broadcast(IPCChannels.dictationStatusChanged, status)
      },
      onResult: (payload) => {
        logDebug('transcript-pipeline', 'Dictation pipeline produced result', {
          provider: payload.provider,
          model: payload.model,
          textLength: payload.text.length,
        })
        broadcast(IPCChannels.dictationResult, payload)
      },
      onError: (message) => {
        logDebug('error-details', 'Dictation runtime error', {
          message,
        })
        broadcast(IPCChannels.dictationError, message)
      },
      processAudioFile: (audioFilePath) => ensureDictationPipeline().processAudioFile(audioFilePath),
    }, join(app.getPath('userData'), 'recordings'))
  }

  return dictationRuntime
}

const DEFAULT_FALLBACK_HOTKEY = process.platform === 'darwin' ? 'Ctrl+Option+Space' : 'Ctrl+Alt+Space'

const normalizeHotkeyToken = (token: string) => {
  const normalized = token.trim().toLowerCase()

  if (normalized === 'ctrl' || normalized === 'control' || normalized === 'cmdorctrl') {
    return 'CommandOrControl'
  }

  if (normalized === 'cmd' || normalized === 'command') {
    return 'Command'
  }

  if (normalized === 'alt' || normalized === 'option') {
    return 'Alt'
  }

  if (normalized === 'shift') {
    return 'Shift'
  }

  if (normalized === 'space') {
    return 'Space'
  }

  if (normalized === 'enter' || normalized === 'return') {
    return 'Enter'
  }

  if (normalized.length === 1) {
    return normalized.toUpperCase()
  }

  return token.trim()
}

const toElectronAccelerator = (hotkey: string) => {
  const parts = hotkey
    .split('+')
    .map((part) => normalizeHotkeyToken(part))
    .filter((part) => part.length > 0)

  return parts.join('+')
}

const unregisterGlobalHotkey = () => {
  if (!registeredHotkey) {
    return
  }

  globalShortcut.unregister(registeredHotkey)
  registeredHotkey = null
}

const handleGlobalDictationHotkey = () => {
  overlayWindow?.show()
  overlayWindow?.focus()
  ensureDictationRuntime().toggleDictation()
}

const registerGlobalDictationHotkey = (requestedHotkey: string) => {
  unregisterGlobalHotkey()

  const requestedAccelerator = toElectronAccelerator(requestedHotkey)
  if (requestedAccelerator && globalShortcut.register(requestedAccelerator, handleGlobalDictationHotkey)) {
    registeredHotkey = requestedAccelerator
    return
  }

  const fallbackAccelerator = toElectronAccelerator(DEFAULT_FALLBACK_HOTKEY)
  if (globalShortcut.register(fallbackAccelerator, handleGlobalDictationHotkey)) {
    registeredHotkey = fallbackAccelerator
    const fallbackPayload: HotkeyFallbackUsedPayload = {
      fallbackHotkey: DEFAULT_FALLBACK_HOTKEY,
      details: `Unable to register ${requestedHotkey}. Using fallback hotkey instead.`,
    }
    broadcast(IPCChannels.hotkeyFallbackUsed, fallbackPayload)
    return
  }

  const failedPayload: HotkeyRegistrationFailedPayload = {
    requestedHotkey,
    reason: 'System shortcut already in use',
  }
  broadcast(IPCChannels.hotkeyRegistrationFailed, failedPayload)
}

const registerIPC = () => {
  ipcMain.handle(IPCChannels.getBackendState, async () => {
    reconcileModelAvailabilityWithDisk()
    return getBackendSnapshotWithSecrets()
  })

  ipcMain.handle(IPCChannels.setBackendSettings, async (_event, settings: AppSettings) => {
    logDebug('system-diagnostics', 'Persisting backend settings', {
      keytarEnabled: settings.keytarEnabled,
      debugModeEnabled: settings.debugModeEnabled,
      transcriptionRuntime: settings.transcriptionRuntime,
      postProcessingRuntime: settings.postProcessingRuntime,
    })

    await ensureSecretStore().setSecrets(resolveSecretStorageMode(settings), extractSecretSettings(settings))
    ensureBackendStateStore().setSettings(stripSecretsFromSettings(settings))
    ensureDebugLogger().setEnabled(settings.debugModeEnabled)
    registerGlobalDictationHotkey(settings.hotkey)
    broadcast(IPCChannels.floatingIconAutoHideChanged, settings.autoHideFloatingIcon)

    if (settings.transcriptionRuntime !== 'local') {
      await ensureWhisperServerManager().stop()
    }
  })

  ipcMain.handle(IPCChannels.getSecretStorageStatus, async (): Promise<SecretStorageStatusPayload> => {
    const settings = ensureBackendStateStore().getSnapshot().settings
    const mode = resolveSecretStorageMode(settings)
    return ensureSecretStore().getStorageStatus(mode)
  })

  ipcMain.handle(IPCChannels.migrateSecretsToKeyring, async (): Promise<SecretStorageMigrationPayload> => {
    const migration = await ensureSecretStore().migratePlaintextEnvToKeyring()
    if (!migration.success) {
      return migration
    }

    const stateStore = ensureBackendStateStore()
    const currentSnapshot = stateStore.getSnapshot()
    stateStore.setSettings({
      ...currentSnapshot.settings,
      keytarEnabled: true,
    })

    return migration
  })

  ipcMain.handle(IPCChannels.setBackendHistory, (_event, entries: HistoryEntry[]) => {
    ensureBackendStateStore().setHistory(entries)
  })

  ipcMain.handle(IPCChannels.clearBackendHistory, () => {
    ensureBackendStateStore().clearHistory()
  })

  ipcMain.handle(IPCChannels.setBackendModels, (_event, models: ModelState[]) => {
    ensureBackendStateStore().setModels(models)
  })

  ipcMain.handle(IPCChannels.setBackendPostModels, (_event, models: ModelState[]) => {
    ensureBackendStateStore().setPostModels(models)
  })

  ipcMain.handle(IPCChannels.setBackendOnboardingCompleted, (_event, value: boolean) => {
    ensureBackendStateStore().setOnboardingCompleted(value)
  })

  ipcMain.handle(IPCChannels.getMicrophonePermissionStatus, () => {
    if (process.platform !== 'darwin') {
      return true
    }

    return systemPreferences.getMediaAccessStatus('microphone') === 'granted'
  })

  ipcMain.handle(IPCChannels.requestMicrophonePermission, async () => {
    if (process.platform !== 'darwin') {
      return true
    }

    if (systemPreferences.getMediaAccessStatus('microphone') === 'granted') {
      return true
    }

    return systemPreferences.askForMediaAccess('microphone')
  })

  ipcMain.handle(IPCChannels.getAccessibilityPermissionStatus, () => {
    if (process.platform !== 'darwin') {
      return true
    }

    return systemPreferences.isTrustedAccessibilityClient(false)
  })

  ipcMain.handle(IPCChannels.requestAccessibilityPermission, () => {
    if (process.platform !== 'darwin') {
      return true
    }

    return systemPreferences.isTrustedAccessibilityClient(true)
  })

  ipcMain.handle(IPCChannels.scanCustomModels, async (_event, baseUrl: string, apiKey: string) => {
    logDebug('api-request', 'Scanning models endpoint', {
      baseUrl,
      hasApiKey: Boolean(apiKey.trim()),
    })

    try {
      const modelIds = await ensureDictationPipeline().scanModels(baseUrl, apiKey)
      logDebug('api-request', 'Model endpoint scan completed', {
        baseUrl,
        discoveredModels: modelIds.length,
      })
      return modelIds
    } catch (error: unknown) {
      const message = error instanceof Error ? error.message : 'Unknown model scan error'
      logDebug('error-details', 'Model endpoint scan failed', {
        baseUrl,
        message,
      })
      throw error
    }
  })

  ipcMain.handle(IPCChannels.runPromptTest, async (_event, input: string): Promise<PromptTestResultPayload> => {
    logDebug('transcript-pipeline', 'Running prompt test', {
      inputLength: input.length,
    })
    return ensureDictationPipeline().runPromptTest(input)
  })

  ipcMain.handle(IPCChannels.downloadLocalModel, async (_event, scope: LocalModelScope, modelId: string) => {
    logDebug('system-diagnostics', 'Local model download started', {
      scope,
      modelId,
    }, 'Downloads')

    await ensureLocalModelStore().downloadModel(scope, modelId, (payload) => {
      broadcastModelDownloadProgress(payload)
      if (shouldLogModelDownloadProgress(payload)) {
        logDebug(
          'system-diagnostics',
          'Local model download progress',
          {
            scope: payload.scope,
            modelId: payload.modelId,
            state: payload.state,
            progress: payload.progress,
          },
          'Downloads',
        )
      }
    })

    reconcileModelAvailabilityWithDisk()
    logDebug('system-diagnostics', 'Local model download completed', {
      scope,
      modelId,
    }, 'Downloads')
  })

  ipcMain.handle(IPCChannels.cancelLocalModelDownload, (_event, scope: LocalModelScope, modelId: string) => {
    logDebug('system-diagnostics', 'Cancel local model download requested', {
      scope,
      modelId,
    }, 'Downloads')
    return ensureLocalModelStore().cancelDownload(scope, modelId)
  })

  ipcMain.handle(IPCChannels.removeLocalModel, async (_event, scope: LocalModelScope, modelId: string) => {
    logDebug('system-diagnostics', 'Removing local model', {
      scope,
      modelId,
    }, 'Downloads')
    await ensureLocalModelStore().removeModel(scope, modelId)
    reconcileModelAvailabilityWithDisk()
  })

  ipcMain.handle(IPCChannels.getWhisperRuntimeStatus, async () => {
    const settings = await loadCurrentSettings()
    return getWhisperRuntimeStatus(settings)
  })

  ipcMain.handle(IPCChannels.getWhisperRuntimeDiagnostics, async (): Promise<WhisperRuntimeDiagnosticsPayload> => {
    const settings = await loadCurrentSettings()
    return ensureWhisperServerManager().getDiagnostics(settings.whisperCppRuntimeVariant)
  })

  ipcMain.handle(IPCChannels.downloadWhisperRuntime, async (_event, variant: WhisperRuntimeVariant) => {
    logDebug('system-diagnostics', 'Whisper runtime download started', {
      variant,
    }, 'Downloads')

    await ensureLocalModelStore().downloadWhisperRuntime(variant, (payload) => {
      broadcastModelDownloadProgress(payload)
      if (shouldLogModelDownloadProgress(payload)) {
        logDebug(
          'system-diagnostics',
          'Whisper runtime download progress',
          {
            variant,
            state: payload.state,
            progress: payload.progress,
          },
          'Downloads',
        )
      }
    })

    logDebug('system-diagnostics', 'Whisper runtime download completed', {
      variant,
    }, 'Downloads')
  })

  ipcMain.handle(IPCChannels.removeWhisperRuntime, async (_event, variant: WhisperRuntimeVariant) => {
    logDebug('system-diagnostics', 'Removing Whisper runtime', {
      variant,
    }, 'Downloads')
    await ensureWhisperServerManager().stop()
    await ensureLocalModelStore().removeWhisperRuntime(variant)
  })

  ipcMain.handle(IPCChannels.getDictationStatus, () => {
    return ensureDictationRuntime().getStatus()
  })

  ipcMain.handle(IPCChannels.toggleDictation, () => {
    return ensureDictationRuntime().toggleDictation()
  })

  ipcMain.handle(IPCChannels.cancelDictation, () => {
    return ensureDictationRuntime().cancelDictation()
  })

  ipcMain.handle(
    IPCChannels.performAutoPaste,
    (_event, text: string, backend: AppSettings['autoPasteBackend']): AutoPasteExecutionResult => {
      const result = performAutoPaste(text, backend)
      logDebug('system-diagnostics', 'Auto-paste execution result', {
        backend,
        success: result.success,
        details: result.details,
      })
      return result
    },
  )

  ipcMain.handle(IPCChannels.showDictationPanel, async () => {
    if (!overlayWindow) {
      await createOverlayWindow()
    }

    overlayWindow?.show()
    overlayWindow?.focus()
  })

  ipcMain.handle(IPCChannels.hideWindow, (event) => {
    const actionWindow = resolveActionWindow(event.sender)
    actionWindow?.hide()
  })

  ipcMain.handle(IPCChannels.closeWindow, () => {
    app.exit(0)
  })

  ipcMain.handle(IPCChannels.minimizeWindow, (event) => {
    const actionWindow = resolveActionWindow(event.sender)
    actionWindow?.minimize()
  })

  ipcMain.handle(IPCChannels.toggleMaximizeWindow, (event) => {
    const actionWindow = resolveActionWindow(event.sender)
    if (!actionWindow) {
      return
    }

    if (actionWindow.isMaximized()) {
      actionWindow.unmaximize()
      emitControlWindowMaximizeChanged()
      return
    }

    actionWindow.maximize()
    emitControlWindowMaximizeChanged()
  })

  ipcMain.handle(IPCChannels.getWindowMaximized, (event) => {
    const actionWindow = resolveActionWindow(event.sender)
    return Boolean(actionWindow?.isMaximized())
  })

  ipcMain.handle(IPCChannels.getAutoPasteBackendSupport, () => {
    return detectAutoPasteBackendSupport()
  })

  ipcMain.handle(IPCChannels.resizeMainWindow, (_event, sizeKey: OverlaySizeKey) => {
    setOverlaySize(sizeKey)
  })

  ipcMain.handle(IPCChannels.setMainWindowInteractivity, (_event, shouldCapture: boolean) => {
    if (!overlayWindow) {
      return
    }

    overlayWindow.setIgnoreMouseEvents(!shouldCapture, { forward: !shouldCapture })
  })

  ipcMain.handle(IPCChannels.openControlPanel, async () => {
    await ensureControlPanelWindow()
  })

  ipcMain.handle(IPCChannels.openExternal, (event, targetURL: string) => {
    if (runInternalWindowAction(targetURL, event.sender)) {
      return
    }

    openExternalInBrowser(targetURL)
  })

  ipcMain.handle(IPCChannels.openAppDataDirectory, async () => {
    await shell.openPath(app.getPath('userData'))
  })

  ipcMain.handle(IPCChannels.getDebugLogStatus, (): DebugLogStatusPayload => {
    return ensureDebugLogger().getStatus()
  })

  ipcMain.handle(IPCChannels.openDebugLogFile, async () => {
    const logFilePath = ensureDebugLogger().ensureCurrentLogFile()
    await shell.openPath(logFilePath)
  })

  ipcMain.handle(IPCChannels.getDisplayServer, () => getDisplayServer())
}

app.whenReady().then(async () => {
  ensureDebugLogger()
  registerGlobalErrorHandlers()
  logDebug('system-diagnostics', 'Whispy startup sequence started', {
    platform: process.platform,
    displayServer: getDisplayServer(),
    compositor: getCompositorName(),
  }, 'Startup')

  ensureBackendStateStore()
  ensureSecretStore()
  ensureLocalModelStore()
  reconcileModelAvailabilityWithDisk()
  ensureDictationPipeline()
  ensureDictationRuntime()
  registerIPC()
  await createOverlayWindow()
  await createControlPanelWindow()
  controlPanelWindow?.show()
  controlPanelWindow?.focus()

  const currentSettings = await loadCurrentSettings()
  ensureDebugLogger().setEnabled(currentSettings.debugModeEnabled)
  logDebug('system-diagnostics', 'Loaded persisted settings at startup', {
    debugModeEnabled: currentSettings.debugModeEnabled,
    keytarEnabled: currentSettings.keytarEnabled,
    transcriptionRuntime: currentSettings.transcriptionRuntime,
    postProcessingRuntime: currentSettings.postProcessingRuntime,
  }, 'Startup')

  const startupDiagnostics = await collectStartupDiagnostics(currentSettings)
  const startupTotalTimeMs = Date.now() - appStartupStartedAt

  logDebug('system-diagnostics', 'Whispy initialization complete', {
    totalTimeMs: startupTotalTimeMs,
    serverRunning: startupDiagnostics.dependencies.whisperServer.running,
  }, 'Startup')

  logDebug('system-diagnostics', 'Dependency check', startupDiagnostics.dependencies, 'Dependencies')
  logDebug(
    'system-diagnostics',
    `whisper-server: ${startupDiagnostics.dependencies.whisperServer.path}`,
    {
      variant: startupDiagnostics.dependencies.whisperServer.variant,
      source: startupDiagnostics.dependencies.whisperServer.source,
      available: startupDiagnostics.dependencies.whisperServer.available,
    },
    'Dependencies',
  )
  logDebug(
    'ffmpeg-operations',
    `FFmpeg: ${startupDiagnostics.dependencies.ffmpeg.path}`,
    {
      available: startupDiagnostics.dependencies.ffmpeg.available,
      configuredCommand: startupDiagnostics.dependencies.ffmpeg.configuredCommand,
    },
    'Dependencies',
  )

  if (startupDiagnostics.models.length > 0) {
    logDebug(
      'system-diagnostics',
      `Models: ${startupDiagnostics.models.map((model) => `${model.name} (${model.size})`).join(', ')}`,
      undefined,
      'Dependencies',
    )
  }

  logDebug('system-diagnostics', 'Auto-paste backend check', startupDiagnostics.autoPaste, 'Dependencies')
  logDebug('system-diagnostics', 'Runtime snapshot', startupDiagnostics.whisperRuntime, 'Runtime')

  registerGlobalDictationHotkey(currentSettings.hotkey)
  broadcast(IPCChannels.floatingIconAutoHideChanged, currentSettings.autoHideFloatingIcon)

  app.on('activate', async () => {
    if (BrowserWindow.getAllWindows().length === 0) {
      await createOverlayWindow()
      await createControlPanelWindow()
    }
  })
})

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') {
    app.quit()
  }
})

app.on('will-quit', () => {
  void whisperServerManager?.stop()
  globalShortcut.unregisterAll()
})
