import { app, BrowserWindow, Menu, Tray, globalShortcut, ipcMain, nativeImage, screen, shell, systemPreferences } from 'electron'
import { spawnSync } from 'node:child_process'
import { accessSync, constants as fsConstants, existsSync, mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { estimateDurationFromTranscript, type AppSettings, type DictationResult, type HistoryEntry, type ModelState } from '../shared/app'
import { normalizeSettings } from '../shared/defaults'
import { CUSTOM_MODEL_FETCH_ERROR } from '../shared/model-discovery'
import {
  applySecretsToSettings,
  extractSecretSettings,
  stripSecretsFromSettings,
  type SecretSettingsMap,
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
  type NotesLogEventPayload,
  type NotesSnapshotPayload,
  type AppUsageStatsPayload,
  type RendererLogEntryPayload,
  type WhisperRuntimeDiagnosticsPayload,
} from '../shared/ipc'
import { detectActiveApp } from './backend/active-app'
import { performAutoPaste, cleanupYdotoolDaemon } from './backend/auto-paste'
import { registerPortalShortcut, cleanupPortalShortcut, isPortalAvailable } from './backend/portal-shortcuts'
import { DebugLogger } from './backend/debug-logger'
import { DictationPipeline } from './backend/dictation-pipeline'
import { DictationRuntime } from './backend/dictation-runtime'
import { LocalModelStore, type ModelDownloadProgress, type WhisperRuntimeVariant } from './backend/model-files'
import { SecretStore } from './backend/secret-store'
import { BackendStateStore } from './backend/state-store'
import { NotesStore } from './backend/notes-store'
import { UsageStatsService } from './backend/usage-stats'
import { WhisperServerManager } from './backend/whisper-server'

const linuxSessionType = process.env.XDG_SESSION_TYPE?.toLowerCase() ?? ''
const linuxWaylandSession = linuxSessionType === 'wayland' || Boolean(process.env.WAYLAND_DISPLAY)
const linuxForceX11 =
  process.platform === 'linux' && linuxWaylandSession && process.env.WHISPY_FORCE_X11?.trim() === '1'
const linuxRunningInDev = Boolean(process.env.ELECTRON_RENDERER_URL)
const linuxDisableSandbox = process.platform === 'linux' && linuxRunningInDev
const linuxForceTmpSharedMemory = process.env.WHISPY_FORCE_TMP_SHM?.trim() === '1'
const linuxDisableTmpSharedMemory = process.env.WHISPY_DISABLE_TMP_SHM?.trim() === '1'

const hasPathAccess = (targetPath: string) => {
  try {
    accessSync(targetPath, fsConstants.R_OK | fsConstants.W_OK | fsConstants.X_OK)
    return true
  } catch {
    return false
  }
}

const linuxDevShmAvailable = process.platform === 'linux' ? hasPathAccess('/dev/shm') : false
const linuxTmpAvailable = process.platform === 'linux' ? hasPathAccess('/tmp') : false
const linuxUseTmpForSharedMemory =
  process.platform === 'linux' &&
  !linuxDisableTmpSharedMemory &&
  (linuxForceTmpSharedMemory || linuxRunningInDev || (!linuxDevShmAvailable && linuxTmpAvailable))

if (process.platform === 'linux') {
  app.disableHardwareAcceleration()
  app.commandLine.appendSwitch('disable-gpu')
  app.commandLine.appendSwitch('disable-gpu-compositing')
  app.commandLine.appendSwitch('in-process-gpu')

  if (linuxUseTmpForSharedMemory) {
    app.commandLine.appendSwitch('disable-dev-shm-usage')
  }

  if (linuxDisableSandbox) {
    app.commandLine.appendSwitch('no-sandbox')
    app.commandLine.appendSwitch('disable-setuid-sandbox')
  }

  if (linuxForceX11) {
    app.commandLine.appendSwitch('ozone-platform-hint', 'x11')
    app.commandLine.appendSwitch('ozone-platform', 'x11')
  } else if (linuxWaylandSession) {
    app.commandLine.appendSwitch('enable-features', 'GlobalShortcutsPortal')
    app.commandLine.appendSwitch('ozone-platform-hint', 'auto')
  }
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
let notesStore: NotesStore | null = null
let usageStatsService: UsageStatsService | null = null
let debugLogger: DebugLogger | null = null
let dictationPipeline: DictationPipeline | null = null
let dictationRuntime: DictationRuntime | null = null
let localModelStore: LocalModelStore | null = null
let whisperServerManager: WhisperServerManager | null = null
let trayInstance: Tray | null = null
let registeredHotkey: string | null = null
let isAppQuitting = false
const appStartupStartedAt = Date.now()
const downloadProgressLogMarkers = new Map<string, string>()
const SECRET_IO_TIMEOUT_MS = 4_500
const MODEL_SCAN_CACHE_TTL_MS = 15 * 60 * 1000
const MODEL_SCAN_CACHE_MAX_ENTRIES = 64
let lastLiteLLMUsageErrorSignature: string | null = null

interface ModelScanCacheEntry {
  key: string
  modelIds: string[]
  cachedAt: number
}

const modelScanCache = new Map<string, ModelScanCacheEntry>()
const modelScanInFlight = new Map<string, Promise<string[]>>()

const createModelScanCacheKey = (baseUrl: string, apiKey: string) => {
  const normalizedBaseUrl = baseUrl.trim().toLowerCase().replace(/\/+$/, '')
  return `${normalizedBaseUrl}|${apiKey.trim()}`
}

const readCachedModelScan = (cacheKey: string) => {
  const cachedEntry = modelScanCache.get(cacheKey)
  if (!cachedEntry) {
    return null
  }

  if (Date.now() - cachedEntry.cachedAt > MODEL_SCAN_CACHE_TTL_MS) {
    modelScanCache.delete(cacheKey)
    return null
  }

  return cachedEntry.modelIds
}

const writeCachedModelScan = (cacheKey: string, modelIds: string[]) => {
  const now = Date.now()
  modelScanCache.set(cacheKey, {
    key: cacheKey,
    modelIds,
    cachedAt: now,
  })

  if (modelScanCache.size <= MODEL_SCAN_CACHE_MAX_ENTRIES) {
    return
  }

  const oldestEntry = Array.from(modelScanCache.values()).sort((left, right) => left.cachedAt - right.cachedAt)[0]
  if (!oldestEntry) {
    return
  }

  modelScanCache.delete(oldestEntry.key)
}

const withTimeout = async <T>(promise: Promise<T>, timeoutMs: number, timeoutMessage: string): Promise<T> => {
  let timeoutHandle: NodeJS.Timeout | null = null

  const timeoutPromise = new Promise<never>((_, reject) => {
    timeoutHandle = setTimeout(() => {
      reject(new Error(timeoutMessage))
    }, timeoutMs)
  })

  try {
    return await Promise.race([promise, timeoutPromise])
  } finally {
    if (timeoutHandle) {
      clearTimeout(timeoutHandle)
    }
  }
}

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
  const rendererURL = process.env.ELECTRON_RENDERER_URL

  if (rendererURL) {
    try {
      await window.loadURL(`${rendererURL}#/${route}`)
      return
    } catch (error) {
      logDebug('error-details', 'Renderer dev URL failed, falling back to static renderer file', {
        route,
        rendererURL,
        message: error instanceof Error ? error.message : String(error),
      }, 'Window')
    }
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

const resolveApplicationIconPath = () => {
  const platformRelativePaths =
    process.platform === 'win32'
      ? [
          ['assets4app', 'Web', 'android-chrome-512x512.png'],
          ['assets4app', 'Web', 'favicon.ico'],
          ['assets4app', 'Web', 'favicon-32x32.png'],
          ['assets4app', 'Web', 'apple-touch-icon.png'],
          ['assets4app', 'Chrome_Extension', 'icon-128.png'],
        ]
      : [
          ['assets4app', 'Web', 'android-chrome-512x512.png'],
          ['assets4app', 'Web', 'favicon-32x32.png'],
          ['assets4app', 'Web', 'apple-touch-icon.png'],
          ['assets4app', 'Chrome_Extension', 'icon-128.png'],
          ['assets4app', 'macOS', 'AppIcon.iconset', 'icon_512x512.png'],
        ]

  const candidatePaths = [app.getAppPath(), process.resourcesPath]
    .flatMap((rootPath) => platformRelativePaths.map((relativePath) => join(rootPath, ...relativePath)))
    .concat(join(process.resourcesPath, 'icon.png'))

  for (const iconPath of candidatePaths) {
    if (existsSync(iconPath)) {
      return iconPath
    }
  }

  return null
}

const resolveApplicationIconImage = () => {
  const trayRelativePaths = [
    ['assets4app', 'Web', 'favicon-32x32.png'],
    ['assets4app', 'Web', 'favicon.ico'],
    ['assets4app', 'Web', 'android-chrome-192x192.png'],
    ['assets4app', 'Chrome_Extension', 'icon-32.png'],
    ['assets4app', 'Chrome_Extension', 'icon-48.png'],
  ]

  const trayCandidates = [app.getAppPath(), process.resourcesPath].flatMap((rootPath) =>
    trayRelativePaths.map((relativePath) => join(rootPath, ...relativePath)),
  )

  for (const iconPath of trayCandidates) {
    if (!existsSync(iconPath)) {
      continue
    }

    const image = nativeImage.createFromPath(iconPath)
    if (!image.isEmpty()) {
      return image
    }
  }

  const fallbackPath = resolveApplicationIconPath()
  if (!fallbackPath) {
    return nativeImage.createEmpty()
  }

  const fallbackImage = nativeImage.createFromPath(fallbackPath)
  return fallbackImage.isEmpty() ? nativeImage.createEmpty() : fallbackImage
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
    if (actionKey === 'app/quit') {
      isAppQuitting = true
      app.quit()
      return true
    }

    const actionWindow = resolveActionWindow(sourceWebContents)
    actionWindow?.hide()
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
  'wtype is available but may not be supported by this Wayland compositor. Try ydotool for broader compatibility.'

const compositorLikelyUnsupportedForWtype = (compositorName: string) => {
  const normalized = compositorName.toLowerCase()
  return WAYLAND_WTYPE_UNSUPPORTED_HINTS.some((token) => normalized.includes(token))
}

const AUTO_PASTE_BINARY_BY_BACKEND = {
  wtype: 'wtype',
  xdotool: 'xdotool',
  ydotool: 'ydotool',
} as const

const AUTO_PASTE_PROBE_ARGS: Record<keyof typeof AUTO_PASTE_BINARY_BY_BACKEND, string[]> = {
  wtype: ['--help'],
  xdotool: ['getmouselocation'],
  ydotool: ['--help'],
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
  const disableWindowSandbox = process.platform === 'linux' && linuxDisableSandbox
  const baseBounds = getOverlayBounds(OVERLAY_SIZES.BASE)
  const appIconPath = resolveApplicationIconPath() ?? undefined
  overlayWindow = new BrowserWindow({
    ...baseBounds,
    icon: appIconPath,
    frame: false,
    transparent: true,
    resizable: false,
    movable: true,
    skipTaskbar: true,
    alwaysOnTop: true,
    hasShadow: false,
    backgroundColor: '#00000000',
    show: false,
    webPreferences: {
      preload: preloadPath,
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: !disableWindowSandbox,
    },
  })

  forceExternalLinksToBrowser(overlayWindow)

  overlayWindow.setAlwaysOnTop(true, 'screen-saver')
  overlayWindow.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true })
  overlayWindow.webContents.on('did-fail-load', (_event, errorCode, errorDescription, validatedURL) => {
    logDebug('error-details', 'Overlay failed to load', {
      errorCode,
      errorDescription,
      validatedURL,
    }, 'Window')
  })
  overlayWindow.webContents.on('render-process-gone', (_event, details) => {
    logDebug('error-details', 'Overlay renderer process exited', details, 'Window')
  })
  overlayWindow.webContents.on('did-finish-load', () => {
    logDebug('system-diagnostics', 'Overlay window loaded', undefined, 'Window')
  })
  overlayWindow.on('closed', () => {
    overlayWindow = null
  })

  try {
    await loadRoute(overlayWindow, 'overlay')
  } catch (error) {
    overlayWindow?.destroy()
    overlayWindow = null
    throw error
  }
}

const createControlPanelWindow = async () => {
  const disableWindowSandbox = process.platform === 'linux' && linuxDisableSandbox
  const useNativeWindowChrome = process.platform === 'win32'
  const appIconPath = resolveApplicationIconPath() ?? undefined

  controlPanelWindow = new BrowserWindow({
    width: 1200,
    height: 800,
    minWidth: 960,
    minHeight: 660,
    minimizable: true,
    maximizable: true,
    closable: true,
    icon: appIconPath,
    frame: useNativeWindowChrome,
    titleBarStyle: process.platform === 'darwin' ? 'hiddenInset' : undefined,
    backgroundColor: '#0f1117',
    show: false,
    webPreferences: {
      preload: preloadPath,
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: !disableWindowSandbox,
    },
  })

  forceExternalLinksToBrowser(controlPanelWindow)

  controlPanelWindow.webContents.on('did-fail-load', (_event, errorCode, errorDescription, validatedURL) => {
    logDebug('error-details', 'Control panel failed to load', {
      errorCode,
      errorDescription,
      validatedURL,
    }, 'Window')
  })
  controlPanelWindow.webContents.on('render-process-gone', (_event, details) => {
    logDebug('error-details', 'Control panel renderer process exited', details, 'Window')
  })

  controlPanelWindow.on('closed', () => {
    controlPanelWindow = null

    if (!whisperServerManager) {
      return
    }

    void whisperServerManager
      .stop()
      .then(() => {
        logDebug('system-diagnostics', 'Whisper server stopped after control panel close', undefined, 'Runtime')
      })
      .catch((error: unknown) => {
        logDebug('error-details', 'Failed to stop whisper server after control panel close', {
          message: error instanceof Error ? error.message : String(error),
        }, 'Runtime')
      })
  })

  controlPanelWindow.on('close', (event) => {
    if (isAppQuitting) {
      return
    }

    event.preventDefault()
    controlPanelWindow?.hide()
  })

  controlPanelWindow.on('maximize', emitControlWindowMaximizeChanged)
  controlPanelWindow.on('unmaximize', emitControlWindowMaximizeChanged)
  controlPanelWindow.webContents.on('did-finish-load', () => {
    emitControlWindowMaximizeChanged()
  })

  try {
    await loadRoute(controlPanelWindow, 'control')
  } catch (error) {
    controlPanelWindow?.destroy()
    controlPanelWindow = null
    throw error
  }
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

const ensureNotesStore = () => {
  if (!notesStore) {
    const userDataPath = app.getPath('userData')
    const notesRootPath = join(userDataPath, 'notes')
    notesStore = new NotesStore(notesRootPath)
  }

  return notesStore
}

const ensureUsageStatsService = () => {
  if (!usageStatsService) {
    const cacheFilePath = join(app.getPath('userData'), 'usage-stats', 'litellm-cache.json')
    usageStatsService = new UsageStatsService(cacheFilePath)
  }

  return usageStatsService
}

const ensureTray = () => {
  if (trayInstance) {
    return trayInstance
  }

  const trayIcon = resolveApplicationIconImage()
  if (trayIcon.isEmpty()) {
    logDebug('error-details', 'Unable to create tray icon: icon image missing', undefined, 'Window')
    return null
  }

  trayInstance = new Tray(trayIcon)
  trayInstance.setToolTip('Whispy')

  const contextMenu = Menu.buildFromTemplate([
    {
      label: 'Open Control Panel',
      click: () => {
        void ensureControlPanelWindow()
      },
    },
    {
      label: 'Show Floating Overlay',
      click: () => {
        void (async () => {
          if (!overlayWindow) {
            await createOverlayWindow()
          }

          overlayWindow?.show()
          overlayWindow?.focus()
        })()
      },
    },
    {
      type: 'separator',
    },
    {
      label: 'Quit Whispy',
      click: () => {
        isAppQuitting = true
        app.quit()
      },
    },
  ])

  trayInstance.setContextMenu(contextMenu)
  trayInstance.on('click', () => {
    void ensureControlPanelWindow()
  })

  return trayInstance
}

const resolveSecretStorageMode = (_settings: AppSettings): SecretStorageMode => 'keyring'

const resolveLinuxAutostartDesktopPath = () => join(app.getPath('home'), '.config', 'autostart', 'whispy-ui.desktop')

const escapeDesktopExec = (value: string) => {
  return value.replace(/[\\\s"']/g, (char) => {
    if (char === ' ') {
      return '\\ '
    }

    return `\\${char}`
  })
}

const configureLinuxAutostart = (enabled: boolean) => {
  const desktopEntryPath = resolveLinuxAutostartDesktopPath()

  if (!enabled) {
    rmSync(desktopEntryPath, { force: true })
    return
  }

  const execParts = app.isPackaged
    ? [process.env.APPIMAGE?.trim() || process.execPath]
    : [process.execPath, app.getAppPath()]
  const execCommand = execParts
    .map((part) => part.trim())
    .filter((part) => part.length > 0)
    .map((part) => escapeDesktopExec(part))
    .join(' ')

  const payload = [
    '[Desktop Entry]',
    'Type=Application',
    'Version=1.0',
    'Name=Whispy',
    'Comment=Whispy dictation overlay',
    `Exec=${execCommand}`,
    'Terminal=false',
    'X-GNOME-Autostart-enabled=true',
    'StartupNotify=false',
    '',
  ].join('\n')

  mkdirSync(dirname(desktopEntryPath), { recursive: true })
  writeFileSync(desktopEntryPath, payload, {
    encoding: 'utf8',
    mode: 0o755,
  })
}

const configureLaunchAtLogin = (settings: AppSettings) => {
  const enabled = Boolean(settings.launchAtLogin)

  if (process.platform === 'darwin' || process.platform === 'win32') {
    app.setLoginItemSettings({
      openAtLogin: enabled,
    })
    return
  }

  if (process.platform === 'linux') {
    configureLinuxAutostart(enabled)
  }
}

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

const resolveBundledWhisperRuntimeRootPath = () => {
  const platformArch = `${process.platform}-${process.arch}`
  const candidates = [
    join(process.resourcesPath, 'bin', 'whispercpp', platformArch),
    join(app.getAppPath(), 'resources', 'bin', 'whispercpp', platformArch),
    join(app.getAppPath(), 'bin', 'whispercpp', platformArch),
    join(process.resourcesPath, 'bin', 'whispercpp'),
    join(app.getAppPath(), 'resources', 'bin', 'whispercpp'),
    join(app.getAppPath(), 'bin', 'whispercpp'),
  ]

  for (const candidatePath of candidates) {
    if (existsSync(candidatePath)) {
      return candidatePath
    }
  }

  return candidates[0]
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
    runtimeDirectory: resolveBundledWhisperRuntimeRootPath(),
    downloadUrls: {
      cpu: null,
      cuda: null,
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

const shouldPrewarmWhisperServerAfterSettingsUpdate = (previousSettings: AppSettings, nextSettings: AppSettings) => {
  if (nextSettings.transcriptionRuntime !== 'local') {
    return false
  }

  if (previousSettings.transcriptionRuntime !== 'local') {
    return true
  }

  return (
    previousSettings.transcriptionLocalModelId !== nextSettings.transcriptionLocalModelId ||
    previousSettings.whisperCppRuntimeVariant !== nextSettings.whisperCppRuntimeVariant
  )
}

const prewarmWhisperServerForSettings = async (
  settings: AppSettings,
  trigger: 'startup' | 'settings-update' | 'model-download',
) => {
  if (settings.transcriptionRuntime !== 'local') {
    return
  }

  const modelPath = ensureLocalModelStore().resolveDownloadedModelPath('transcription', settings.transcriptionLocalModelId)
  if (!modelPath) {
    logDebug('system-diagnostics', 'Whisper server prewarm skipped: local model unavailable', {
      trigger,
      modelId: settings.transcriptionLocalModelId,
      runtimeVariant: settings.whisperCppRuntimeVariant,
    }, 'Runtime')
    return
  }

  try {
    await ensureWhisperServerManager().ensureReady(modelPath, settings.whisperCppRuntimeVariant)
    logDebug('system-diagnostics', 'Whisper server prewarmed', {
      trigger,
      modelId: settings.transcriptionLocalModelId,
      runtimeVariant: settings.whisperCppRuntimeVariant,
    }, 'Runtime')
  } catch (error: unknown) {
    logDebug('error-details', 'Whisper server prewarm failed', {
      trigger,
      modelId: settings.transcriptionLocalModelId,
      runtimeVariant: settings.whisperCppRuntimeVariant,
      message: error instanceof Error ? error.message : String(error),
    }, 'Runtime')
  }
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

const applyNonSecretEnvSettings = (settings: AppSettings) => {
  const envOverrides = ensureSecretStore().getNonSecretSettings()
  if (Object.keys(envOverrides).length === 0) {
    return settings
  }

  return normalizeSettings({
    ...settings,
    ...envOverrides,
  })
}

const loadSecretsSafely = async (mode: SecretStorageMode): Promise<SecretSettingsMap> => {
  try {
    return await withTimeout(
      ensureSecretStore().getSecrets(mode),
      SECRET_IO_TIMEOUT_MS,
      'Secret storage request timed out.',
    )
  } catch (error: unknown) {
    logDebug('error-details', 'Unable to load secrets from storage', {
      mode,
      message: error instanceof Error ? error.message : String(error),
    }, 'Secrets')

    return {}
  }
}

const getBackendSnapshotWithSecrets = async () => {
  const snapshot = ensureBackendStateStore().getSnapshotOrNull()
  if (!snapshot) {
    return null
  }

  const secrets = await loadSecretsSafely(resolveSecretStorageMode(snapshot.settings))

  return {
    ...snapshot,
    settings: applyNonSecretEnvSettings(applySecretsToSettings(snapshot.settings, secrets)),
  }
}

const loadCurrentSettings = async (): Promise<AppSettings> => {
  const snapshot = await getBackendSnapshotWithSecrets()
  if (snapshot) {
    return snapshot.settings
  }

  return applyNonSecretEnvSettings(ensureBackendStateStore().getSnapshot().settings)
}

const appendHistoryEntryFromDictationResult = async (payload: DictationResult) => {
  const stateStore = ensureBackendStateStore()
  const snapshot = stateStore.getSnapshot()
  const settings = await loadCurrentSettings()
  const resolvedLanguage = settings.preferredLanguage === 'Auto-detect' ? payload.language : settings.preferredLanguage

  const nextHistory = [
    {
      id: crypto.randomUUID(),
      timestamp: Date.now(),
      language: resolvedLanguage,
      provider: payload.provider,
      model: payload.model,
      targetApp: payload.targetApp,
      text: payload.text,
      durationSeconds:
        typeof payload.durationSeconds === 'number' && Number.isFinite(payload.durationSeconds)
          ? payload.durationSeconds
          : estimateDurationFromTranscript(payload.text),
      rawText: payload.rawText?.trim() || payload.text,
      enhancedText: payload.enhancedText?.trim() || payload.text,
      postProcessingApplied: Boolean(payload.postProcessingApplied),
      postProcessingProvider: payload.postProcessingProvider?.trim() || undefined,
      postProcessingModel: payload.postProcessingModel?.trim() || undefined,
    },
    ...snapshot.history,
  ]

  const sortedHistory = [...nextHistory].sort((left, right) => right.timestamp - left.timestamp)
  const retentionLimit = settings.historyRetentionLimit
  stateStore.setHistory(retentionLimit < 0 ? sortedHistory : sortedHistory.slice(0, retentionLimit))
}

const ensureDictationPipeline = () => {
  if (!dictationPipeline) {
    dictationPipeline = new DictationPipeline({
      loadSettings: loadCurrentSettings,
      resolveLocalModelPath: (scope, modelId) => ensureLocalModelStore().resolveDownloadedModelPath(scope, modelId),
      resolveWhisperRuntimePath: (variant) => ensureLocalModelStore().resolveDownloadedWhisperRuntimePath(variant),
      transcribeWithWhisperServer: (audioFilePath, modelPath, runtimeVariant, promptHint) =>
        ensureWhisperServerManager().transcribeAudioFile(audioFilePath, modelPath, runtimeVariant, promptHint),
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
        void appendHistoryEntryFromDictationResult(payload).catch((error: unknown) => {
          logDebug('error-details', 'Unable to persist dictation history entry', {
            message: error instanceof Error ? error.message : String(error),
          }, 'History')
        })

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
      processAudioFile: (audioFilePath, mode) => {
        if (mode === 'transcription-only') {
          return ensureDictationPipeline().processAudioFileTranscriptionOnly(audioFilePath)
        }

        return ensureDictationPipeline().processAudioFile(audioFilePath)
      },
    }, join(app.getPath('userData'), 'recordings'))
  }

  return dictationRuntime
}

const DEFAULT_FALLBACK_HOTKEY = process.platform === 'darwin' ? 'Ctrl+Option+Space' : 'Ctrl+Alt+Space'

interface HotkeyRegistrationResult {
  requestedHotkey: string
  effectiveHotkey: string
  accelerator: string | null
}

interface HotkeyRegisterAttemptResult {
  registered: boolean
  errorMessage: string | null
}

const normalizeHotkeyToken = (token: string) => {
  const normalized = token.trim().toLowerCase()

  if (normalized === 'ctrl' || normalized === 'control' || normalized === 'cmdorctrl') {
    return 'CommandOrControl'
  }

  if (normalized === 'cmd' || normalized === 'command') {
    return 'Command'
  }

  if (normalized === 'meta' || normalized === 'super' || normalized === 'win' || normalized === 'windows') {
    return 'Super'
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

  if (normalized === 'pause' || normalized === 'pausebreak' || normalized === 'pause/break' || normalized === 'break') {
    return 'MediaPlayPause'
  }

  if (normalized === 'enter' || normalized === 'return') {
    return 'Enter'
  }

  if (normalized.length === 1) {
    return normalized.toUpperCase()
  }

  if (/^f\d{1,2}$/i.test(normalized)) {
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

const tryRegisterGlobalShortcut = (accelerator: string): HotkeyRegisterAttemptResult => {
  try {
    const registered = globalShortcut.register(accelerator, handleGlobalDictationHotkey)
    return {
      registered,
      errorMessage: null,
    }
  } catch (error: unknown) {
    return {
      registered: false,
      errorMessage: error instanceof Error ? error.message : String(error),
    }
  }
}

const handleGlobalDictationHotkey = () => {
  void (async () => {
    logDebug('system-diagnostics', 'Global dictation hotkey pressed', {
      overlayReady: Boolean(overlayWindow),
    }, 'Hotkey')

    if (!overlayWindow) {
      try {
        await createOverlayWindow()
      } catch (error) {
        logDebug('error-details', 'Unable to create overlay window from hotkey', {
          message: error instanceof Error ? error.message : String(error),
        }, 'Hotkey')
        return
      }
    }

    if (overlayWindow && !overlayWindow.isDestroyed()) {
      overlayWindow.showInactive()
    }

    const response = ensureDictationRuntime().toggleDictation('full')
    if (!response.accepted) {
      logDebug('system-diagnostics', 'Dictation toggle rejected from hotkey', {
        reason: response.reason ?? 'unknown',
      }, 'Hotkey')
    }
  })()
}

const hotkeyToPortalTrigger = (hotkey: string) => {
  return hotkey
    .split('+')
    .map((part) => part.trim())
    .join('+')
}

const handlePortalShortcutChanged = (newTrigger: string) => {

  logDebug('system-diagnostics', 'Portal shortcut changed by user', { newTrigger }, 'Hotkey')

  const stateStore = ensureBackendStateStore()
  const currentSettings = stateStore.getSnapshot().settings
  if (currentSettings.hotkey !== newTrigger) {
    stateStore.setSettings({ ...currentSettings, hotkey: newTrigger })
    ensureSecretStore().setNonSecretSettings({ ...currentSettings, hotkey: newTrigger })
    broadcast(IPCChannels.hotkeyEffectiveChanged, newTrigger)
  }
}

interface PortalRegistrationResult {
  registered: boolean
  effectiveHotkey: string | null
}

const tryRegisterViaPortal = async (hotkey: string): Promise<PortalRegistrationResult> => {
  if (!linuxWaylandSession) return { registered: false, effectiveHotkey: null }

  try {
    const available = await isPortalAvailable()
    if (!available) return { registered: false, effectiveHotkey: null }

    const trigger = hotkeyToPortalTrigger(hotkey)
    const result = await registerPortalShortcut(
      'toggle-dictation',
      'Toggle Dictation',
      trigger,
      handleGlobalDictationHotkey,
      handlePortalShortcutChanged,
    )

    if (result.registered) {

      logDebug('system-diagnostics', 'Global hotkey registered via XDG portal', {
        requestedHotkey: hotkey,
        assignedTrigger: result.assignedTrigger,
      }, 'Hotkey')
    }

    return {
      registered: result.registered,
      effectiveHotkey: result.assignedTrigger,
    }
  } catch (error) {
    logDebug('error-details', 'XDG portal shortcut registration failed', {
      message: error instanceof Error ? error.message : String(error),
    }, 'Hotkey')
    return { registered: false, effectiveHotkey: null }
  }
}

const registerGlobalDictationHotkey = async (requestedHotkey: string): Promise<HotkeyRegistrationResult> => {
  unregisterGlobalHotkey()

  const useWaylandPortal = linuxWaylandSession && !linuxForceX11

  if (useWaylandPortal) {
    const portalResult = await tryRegisterViaPortal(requestedHotkey)
    if (portalResult.registered) {
      return {
        requestedHotkey,
        effectiveHotkey: portalResult.effectiveHotkey ?? requestedHotkey,
        accelerator: portalResult.effectiveHotkey ?? requestedHotkey,
      }
    }
    logDebug('system-diagnostics', 'XDG portal unavailable, falling back to globalShortcut', undefined, 'Hotkey')
  }

  const requestedAccelerator = toElectronAccelerator(requestedHotkey)
  const requestedRegistrationAttempt = requestedAccelerator
    ? tryRegisterGlobalShortcut(requestedAccelerator)
    : { registered: false, errorMessage: null }

  if (requestedAccelerator && requestedRegistrationAttempt.registered) {
    registeredHotkey = requestedAccelerator
    logDebug('system-diagnostics', 'Global hotkey registered', {
      requestedHotkey,
      accelerator: requestedAccelerator,
      method: useWaylandPortal ? 'globalShortcut-fallback' : 'globalShortcut',
    }, 'Hotkey')
    return {
      requestedHotkey,
      effectiveHotkey: requestedHotkey,
      accelerator: requestedAccelerator,
    }
  }

  const fallbackAccelerator = toElectronAccelerator(DEFAULT_FALLBACK_HOTKEY)
  const fallbackRegistrationAttempt = tryRegisterGlobalShortcut(fallbackAccelerator)
  if (fallbackRegistrationAttempt.registered) {
    const fallbackReason = requestedAccelerator
      ? `Unable to register ${requestedHotkey}. Shortcut is already in use or unsupported on this system.${requestedRegistrationAttempt.errorMessage ? ` (${requestedRegistrationAttempt.errorMessage})` : ''}`
      : `Unable to parse ${requestedHotkey}. Invalid hotkey format.`

    registeredHotkey = fallbackAccelerator
    logDebug('system-diagnostics', 'Fallback global hotkey registered', {
      requestedHotkey,
      fallbackHotkey: DEFAULT_FALLBACK_HOTKEY,
      accelerator: fallbackAccelerator,
      reason: fallbackReason,
    }, 'Hotkey')
    const fallbackPayload: HotkeyFallbackUsedPayload = {
      requestedHotkey,
      fallbackHotkey: DEFAULT_FALLBACK_HOTKEY,
      reason: fallbackReason,
      details: `Using fallback hotkey ${DEFAULT_FALLBACK_HOTKEY}.`,
    }
    broadcast(IPCChannels.hotkeyFallbackUsed, fallbackPayload)
    return {
      requestedHotkey,
      effectiveHotkey: DEFAULT_FALLBACK_HOTKEY,
      accelerator: fallbackAccelerator,
    }
  }

  const failedPayload: HotkeyRegistrationFailedPayload = {
    requestedHotkey,
    reason:
      requestedRegistrationAttempt.errorMessage ??
      fallbackRegistrationAttempt.errorMessage ??
      'System shortcut already in use',
  }
  logDebug('error-details', 'Unable to register global hotkey', failedPayload, 'Hotkey')
  broadcast(IPCChannels.hotkeyRegistrationFailed, failedPayload)

  return {
    requestedHotkey,
    effectiveHotkey: requestedHotkey,
    accelerator: null,
  }
}

const registerIPC = () => {
  ipcMain.handle(IPCChannels.getBackendState, async () => {
    reconcileModelAvailabilityWithDisk()
    return getBackendSnapshotWithSecrets()
  })

  ipcMain.handle(IPCChannels.setBackendSettings, async (_event, settings: AppSettings) => {
    const stateStore = ensureBackendStateStore()
    const previousSettings = stateStore.getSnapshot().settings
    let nextSettings = settings

    logDebug('system-diagnostics', 'Persisting backend settings', {
      keytarEnabled: settings.keytarEnabled,
      debugModeEnabled: settings.debugModeEnabled,
      transcriptionRuntime: settings.transcriptionRuntime,
      postProcessingRuntime: settings.postProcessingRuntime,
    })

    stateStore.setSettings(stripSecretsFromSettings(settings))
    configureLaunchAtLogin(settings)
    ensureDebugLogger().setEnabled(settings.debugModeEnabled)

    const hotkeyRegistration = await registerGlobalDictationHotkey(settings.hotkey)
    if (hotkeyRegistration.effectiveHotkey !== settings.hotkey) {
      nextSettings = {
        ...settings,
        hotkey: hotkeyRegistration.effectiveHotkey,
      }
      stateStore.setSettings(stripSecretsFromSettings(nextSettings))
    }

    ensureSecretStore().setNonSecretSettings(nextSettings)

    void withTimeout(
      ensureSecretStore().setSecrets(resolveSecretStorageMode(nextSettings), extractSecretSettings(nextSettings)),
      SECRET_IO_TIMEOUT_MS,
      'Secret settings persistence timed out.',
    ).catch((error: unknown) => {
      logDebug('error-details', 'Unable to persist secrets after settings update', {
        message: error instanceof Error ? error.message : String(error),
      }, 'Secrets')
    })

    broadcast(IPCChannels.floatingIconAutoHideChanged, nextSettings.autoHideFloatingIcon)

    if (nextSettings.transcriptionRuntime !== 'local') {
      await ensureWhisperServerManager().stop()
      return
    }

    if (shouldPrewarmWhisperServerAfterSettingsUpdate(previousSettings, nextSettings)) {
      void prewarmWhisperServerForSettings(nextSettings, 'settings-update')
    }
  })

  ipcMain.handle(IPCChannels.getSecretStorageStatus, async (): Promise<SecretStorageStatusPayload> => {
    const settings = ensureBackendStateStore().getSnapshot().settings
    const mode = resolveSecretStorageMode(settings)

    try {
      return await withTimeout(
        ensureSecretStore().getStorageStatus(mode),
        SECRET_IO_TIMEOUT_MS,
        'Secret storage status request timed out.',
      )
    } catch (error: unknown) {
      logDebug('error-details', 'Unable to load secret storage status', {
        mode,
        message: error instanceof Error ? error.message : String(error),
      }, 'Secrets')

      return {
        mode,
        activeBackend: 'env',
        fallbackActive: true,
        keyringSupported: false,
        envFilePath: ensureSecretStore().ensurePlaintextEnvFile(),
        details: error instanceof Error ? error.message : 'Unable to read secret storage status.',
      }
    }
  })

  ipcMain.handle(IPCChannels.migrateSecretsToKeyring, async (): Promise<SecretStorageMigrationPayload> => {
    let migration: SecretStorageMigrationPayload

    try {
      migration = await withTimeout(
        ensureSecretStore().migratePlaintextEnvToKeyring(),
        SECRET_IO_TIMEOUT_MS,
        'Keyring migration timed out.',
      )
    } catch (error: unknown) {
      logDebug('error-details', 'Secret migration request failed', {
        message: error instanceof Error ? error.message : String(error),
      }, 'Secrets')

      return {
        success: false,
        details: error instanceof Error ? error.message : 'Unexpected keyring migration failure.',
      }
    }

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

  ipcMain.handle(IPCChannels.getNotesSnapshot, (): NotesSnapshotPayload => {
    return ensureNotesStore().getSnapshot()
  })

  ipcMain.handle(IPCChannels.setNotesSnapshot, (_event, snapshot: NotesSnapshotPayload) => {
    ensureNotesStore().setSnapshot(snapshot)
  })

  ipcMain.handle(IPCChannels.getAppUsageStats, async (_event, forceRefresh = false): Promise<AppUsageStatsPayload> => {
    const appStateSnapshot = ensureBackendStateStore().getSnapshot()
    const notesSnapshot = ensureNotesStore().getSnapshot()
    const settings = await loadCurrentSettings()

    const usageStats = await ensureUsageStatsService().getStats(
      settings,
      appStateSnapshot.history,
      notesSnapshot.notes,
      notesSnapshot.folders,
      Boolean(forceRefresh),
    )

    if (usageStats.litellmError) {
      const signature = `${usageStats.litellmSource}|${usageStats.litellmError}`
      if (lastLiteLLMUsageErrorSignature !== signature) {
        lastLiteLLMUsageErrorSignature = signature
        logDebug('api-request', 'LiteLLM usage fetch issue', {
          source: usageStats.litellmSource,
          error: usageStats.litellmError,
        })
      }
    } else {
      lastLiteLLMUsageErrorSignature = null
    }

    return usageStats
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
    const cacheKey = createModelScanCacheKey(baseUrl, apiKey)
    const cachedModelIds = readCachedModelScan(cacheKey)
    if (cachedModelIds) {
      return cachedModelIds
    }

    const existingRequest = modelScanInFlight.get(cacheKey)
    if (existingRequest) {
      return existingRequest
    }

    const scanPromise = (async () => {
    logDebug('api-request', 'Scanning models endpoint', {
      baseUrl,
      hasApiKey: Boolean(apiKey.trim()),
    })

    try {
      const modelIds = await ensureDictationPipeline().scanModels(baseUrl, apiKey)
      writeCachedModelScan(cacheKey, modelIds)
      logDebug('api-request', 'Model endpoint scan completed', {
        baseUrl,
        discoveredModels: modelIds.length,
      })
      return modelIds
    } catch (error: unknown) {
      const message = error instanceof Error ? error.message : 'Unknown model scan error'
      const status =
        typeof error === 'object' && error !== null && 'status' in error && typeof (error as { status?: unknown }).status === 'number'
          ? ((error as { status: number }).status)
          : null
      const expectedEndpointDenial =
        message.includes(CUSTOM_MODEL_FETCH_ERROR) &&
        (status === 401 || status === 403 || status === 404 || status === 405)

      if (expectedEndpointDenial) {
        writeCachedModelScan(cacheKey, [])
        logDebug('api-request', 'Model endpoint scan unavailable for provider endpoint', {
          baseUrl,
          status,
          message,
        })
        return []
      }

      logDebug('error-details', 'Model endpoint scan failed', {
        baseUrl,
        message,
        status,
      })
      throw error
    } finally {
      modelScanInFlight.delete(cacheKey)
    }
    })()

    modelScanInFlight.set(cacheKey, scanPromise)
    return scanPromise
  })

  ipcMain.handle(IPCChannels.runPromptTest, async (_event, input: string): Promise<PromptTestResultPayload> => {
    logDebug('transcript-pipeline', 'Running prompt test', {
      inputLength: input.length,
    })
    return ensureDictationPipeline().runPromptTest(input)
  })

  ipcMain.handle(
    IPCChannels.runNoteEnhancement,
    async (_event, input: string, instructions?: string): Promise<string> => {
    logDebug('transcript-pipeline', 'Running note enhancement', {
      inputLength: input.length,
      customInstructionsLength: instructions?.trim().length ?? 0,
    })
      return ensureDictationPipeline().runNoteEnhancement(input, instructions)
    },
  )

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

    if (scope === 'transcription') {
      const settings = await loadCurrentSettings()
      if (settings.transcriptionRuntime === 'local' && settings.transcriptionLocalModelId === modelId) {
        void prewarmWhisperServerForSettings(settings, 'model-download')
      }
    }
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
    logDebug('system-diagnostics', 'Whisper runtime download rejected (build-managed runtime)', {
      variant,
    }, 'Downloads')

    throw new Error('Whisper runtime downloads are disabled. Runtime binaries are managed by npm build/package.')
  })

  ipcMain.handle(IPCChannels.removeWhisperRuntime, async (_event, variant: WhisperRuntimeVariant) => {
    logDebug('system-diagnostics', 'Whisper runtime removal rejected (build-managed runtime)', {
      variant,
    }, 'Downloads')

    throw new Error('Whisper runtime removal is disabled. Runtime binaries are managed by npm build/package.')
  })

  ipcMain.handle(IPCChannels.getDictationStatus, () => {
    return ensureDictationRuntime().getStatus()
  })

  ipcMain.handle(IPCChannels.toggleDictation, async () => {
    return ensureDictationRuntime().toggleDictation('full')
  })

  ipcMain.handle(IPCChannels.toggleDictationTranscriptionOnly, async () => {
    if (overlayWindow && overlayWindow.isVisible()) {
      overlayWindow.hide()
      logDebug('system-diagnostics', 'Overlay hidden for notes transcription-only mode', undefined, 'Window')
    }

    return ensureDictationRuntime().toggleDictation('transcription-only')
  })

  ipcMain.handle(IPCChannels.cancelDictation, () => {
    return ensureDictationRuntime().cancelDictation()
  })

  ipcMain.handle(
    IPCChannels.performAutoPaste,
    async (
      _event,
      text: string,
      backend: AppSettings['autoPasteBackend'],
      options?: {
        mode?: AppSettings['autoPasteMode']
        shortcut?: AppSettings['autoPasteShortcut']
      },
    ): Promise<AutoPasteExecutionResult> => {
      if (typeof text !== 'string') {
        return { success: false, details: 'Invalid text parameter' }
      }

      const sanitizedText = text.slice(0, 100_000)
      const settings = await loadCurrentSettings()
      const selectedMode = options?.mode === 'instant' ? 'instant' : settings.autoPasteMode
      const selectedShortcut = options?.shortcut === 'ctrl-shift-v' ? 'ctrl-shift-v' : settings.autoPasteShortcut
      const result = performAutoPaste(sanitizedText, backend, {
        mode: selectedMode,
        shortcut: selectedShortcut,
      })
      logDebug('system-diagnostics', 'Auto-paste execution result', {
        backend,
        mode: selectedMode,
        shortcut: selectedShortcut,
        success: result.success,
        elapsedMs: result.elapsedMs,
        textLength: sanitizedText.length,
        details: result.details,
      })
      return result
    },
  )

  ipcMain.handle(IPCChannels.showDictationPanel, async () => {
    if (!overlayWindow) {
      logDebug('system-diagnostics', 'Overlay missing, creating before show request', undefined, 'Window')
      try {
        await createOverlayWindow()
      } catch (error) {
        logDebug('error-details', 'Unable to create overlay window from IPC request', {
          message: error instanceof Error ? error.message : String(error),
        }, 'Window')
        return
      }
    }

    overlayWindow?.show()
    overlayWindow?.focus()
    logDebug('system-diagnostics', 'Overlay window shown from IPC request', undefined, 'Window')
  })

  ipcMain.handle(IPCChannels.hideWindow, (event) => {
    const actionWindow = resolveActionWindow(event.sender)
    actionWindow?.hide()
  })

  ipcMain.handle(IPCChannels.closeWindow, (event) => {
    const actionWindow = resolveActionWindow(event.sender)
    actionWindow?.hide()
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
    const openResult = await shell.openPath(app.getPath('userData'))
    if (openResult) {
      throw new Error(openResult)
    }
  })

  ipcMain.handle(IPCChannels.openSecretEnvFile, async () => {
    const envFilePath = ensureSecretStore().ensurePlaintextEnvFile()
    const openResult = await shell.openPath(envFilePath)
    if (openResult) {
      throw new Error(openResult)
    }
  })

  ipcMain.handle(IPCChannels.logNotesEvent, (_event, payload: NotesLogEventPayload) => {
    logDebug('system-diagnostics', payload.message, payload.details, 'Notes')
  })

  ipcMain.handle(IPCChannels.getDebugLogStatus, (): DebugLogStatusPayload => {
    return ensureDebugLogger().getStatus()
  })

  ipcMain.handle(IPCChannels.getLogLevel, () => {
    return ensureDebugLogger().getLevel()
  })

  ipcMain.handle(IPCChannels.appLog, (_event, entry: RendererLogEntryPayload) => {
    ensureDebugLogger().logEntry(entry)
  })

  ipcMain.handle(IPCChannels.openDebugLogFile, async () => {
    const logFilePath = ensureDebugLogger().ensureCurrentLogFile()
    const openResult = await shell.openPath(logFilePath)
    if (openResult) {
      throw new Error(openResult)
    }
  })

  ipcMain.handle(IPCChannels.openDebugLogsDirectory, async () => {
    const logsDirectoryPath = ensureDebugLogger().getStatus().logsDirectory
    const openResult = await shell.openPath(logsDirectoryPath)
    if (openResult) {
      throw new Error(openResult)
    }
  })

  ipcMain.handle(IPCChannels.getDisplayServer, () => getDisplayServer())
}

app.whenReady().then(async () => {
  if (process.platform === 'win32') {
    app.setAppUserModelId('dev.whispy.app')
  }

  ensureDebugLogger()
  registerGlobalErrorHandlers()
  logDebug('system-diagnostics', 'Whispy startup sequence started', {
    platform: process.platform,
    displayServer: getDisplayServer(),
    compositor: getCompositorName(),
    forcedX11OnLinux: linuxForceX11,
    waylandNativeWithPortal: linuxWaylandSession && !linuxForceX11,
    linuxSandboxDisabled: linuxDisableSandbox,
    linuxUseTmpForSharedMemory,
    linuxForceTmpSharedMemory,
    linuxDisableTmpSharedMemory,
  }, 'Startup')

  ensureBackendStateStore()
  ensureSecretStore()
  ensureNotesStore()
  ensureUsageStatsService()
  ensureLocalModelStore()
  reconcileModelAvailabilityWithDisk()
  ensureDictationPipeline()
  ensureDictationRuntime()
  registerIPC()
  ensureTray()
  await createControlPanelWindow()
  controlPanelWindow?.show()
  controlPanelWindow?.focus()

  try {
    await createOverlayWindow()
  } catch (error) {
    logDebug('error-details', 'Overlay startup creation failed', {
      message: error instanceof Error ? error.message : String(error),
    }, 'Window')
  }

  const currentSettings = await loadCurrentSettings()
  configureLaunchAtLogin(currentSettings)
  ensureDebugLogger().setEnabled(currentSettings.debugModeEnabled)

  await prewarmWhisperServerForSettings(currentSettings, 'startup')

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
  logDebug('system-diagnostics', 'Recorder binaries', startupDiagnostics.recorderBinaries, 'Dependencies')
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

  const startupHotkeyRegistration = await registerGlobalDictationHotkey(currentSettings.hotkey)
  let startupEffectiveSettings = currentSettings
  if (startupHotkeyRegistration.effectiveHotkey !== currentSettings.hotkey) {
    startupEffectiveSettings = {
      ...currentSettings,
      hotkey: startupHotkeyRegistration.effectiveHotkey,
    }

    ensureBackendStateStore().setSettings({
      ...ensureBackendStateStore().getSnapshot().settings,
      hotkey: startupHotkeyRegistration.effectiveHotkey,
    })
    broadcast(IPCChannels.hotkeyEffectiveChanged, startupHotkeyRegistration.effectiveHotkey)
  }

  ensureSecretStore().setNonSecretSettings(startupEffectiveSettings)

  broadcast(IPCChannels.floatingIconAutoHideChanged, startupEffectiveSettings.autoHideFloatingIcon)

  app.on('activate', async () => {
    if (BrowserWindow.getAllWindows().length === 0) {
      await createOverlayWindow()
      await createControlPanelWindow()
    }
  })
})

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin' && isAppQuitting) {
    app.quit()
  }
})

app.on('before-quit', () => {
  isAppQuitting = true
})

app.on('will-quit', () => {
  trayInstance?.destroy()
  trayInstance = null
  void whisperServerManager?.stop()
  cleanupYdotoolDaemon()
  void cleanupPortalShortcut()
  globalShortcut.unregisterAll()
})
