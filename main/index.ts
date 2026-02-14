import { app, BrowserWindow, ipcMain, screen, shell } from 'electron'
import { join } from 'node:path'
import {
  IPCChannels,
  type DisplayServer,
  type HotkeyFallbackUsedPayload,
  type HotkeyRegistrationFailedPayload,
  type OverlaySizeKey,
} from '../shared/ipc'

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

const preloadPath = join(__dirname, '../preload/index.mjs')
const isDev = Boolean(process.env.ELECTRON_RENDERER_URL)

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
  } catch {}
}

const forceExternalLinksToBrowser = (window: BrowserWindow) => {
  window.webContents.setWindowOpenHandler(({ url }) => {
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
  controlPanelWindow = new BrowserWindow({
    width: 1200,
    height: 800,
    minWidth: 960,
    minHeight: 660,
    frame: false,
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

const registerIPC = () => {
  ipcMain.handle(IPCChannels.showDictationPanel, async () => {
    if (!overlayWindow) {
      await createOverlayWindow()
    }

    overlayWindow?.show()
    overlayWindow?.focus()
  })

  ipcMain.handle(IPCChannels.hideWindow, (event) => {
    const senderWindow = BrowserWindow.fromWebContents(event.sender)
    senderWindow?.hide()
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

  ipcMain.handle(IPCChannels.openExternal, (_event, targetURL: string) => {
    openExternalInBrowser(targetURL)
  })

  ipcMain.handle(IPCChannels.getDisplayServer, () => getDisplayServer())
}

const emitMockEvents = () => {
  setTimeout(() => {
    broadcast(IPCChannels.floatingIconAutoHideChanged, false)
  }, 1000)

  const fallbackPayload: HotkeyFallbackUsedPayload = {
    fallbackHotkey: process.platform === 'darwin' ? 'Ctrl+Option+Space' : 'Ctrl+Alt+Space',
    details: 'Mock fallback registration applied',
  }

  const failedPayload: HotkeyRegistrationFailedPayload = {
    requestedHotkey: process.platform === 'darwin' ? 'Cmd+Shift+Space' : 'Ctrl+Shift+Space',
    reason: 'System shortcut already in use (mock)',
  }

  if (isDev) {
    setTimeout(() => {
      broadcast(IPCChannels.hotkeyFallbackUsed, fallbackPayload)
    }, 9000)

    setTimeout(() => {
      broadcast(IPCChannels.hotkeyRegistrationFailed, failedPayload)
    }, 15000)
  }
}

app.whenReady().then(async () => {
  registerIPC()
  await createOverlayWindow()
  await createControlPanelWindow()
  controlPanelWindow?.show()
  controlPanelWindow?.focus()
  emitMockEvents()

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
