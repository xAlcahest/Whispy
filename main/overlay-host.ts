/**
 * Overlay host process - runs under XWayland on Linux Wayland.
 *
 * Spawned by the main process as a child Electron app. This is a thin shell:
 * it creates the overlay BrowserWindow and manages its geometry/visibility.
 *
 * Window-local operations (resize, shape, interactivity, hide/show) are
 * handled here. Everything the renderer needs from the backend is forwarded
 * to the parent via Node IPC using an explicit whitelist of channels.
 */

import { app, BrowserWindow, ipcMain, nativeImage, screen, shell } from 'electron'
import { join } from 'node:path'
import { IPCChannels, type OverlaySizeKey } from '../shared/ipc'

// ── Types ──────────────────────────────────────────────────────────────────

interface OverlaySize { width: number; height: number }

type ParentMessage =
  | { type: 'ipc-response'; requestId: string; result?: unknown; error?: string }
  | { type: 'broadcast'; channel: string; payload: unknown }
  | { type: 'command'; action: string; payload?: unknown }

// ── Constants ──────────────────────────────────────────────────────────────

const OVERLAY_MARGIN = 24
const OVERLAY_SIZES: Record<OverlaySizeKey, OverlaySize> = {
  BASE: { width: 96, height: 96 },
  WITH_MENU: { width: 240, height: 280 },
  WITH_TOAST: { width: 400, height: 500 },
  EXPANDED: { width: 420, height: 240 },
}

/** Channels the overlay renderer actually calls that need the main process. */
const PROXIED_CHANNELS = new Set([
  IPCChannels.getBackendState,
  IPCChannels.getDictationStatus,
  IPCChannels.toggleDictation,
  IPCChannels.cancelDictation,
  IPCChannels.performAutoPaste,
  IPCChannels.openControlPanel,
  IPCChannels.getWhisperRuntimeStatus,
  IPCChannels.getWhisperRuntimeDiagnostics,
  IPCChannels.getAutoPasteBackendSupport,
  IPCChannels.getDisplayServer,
  IPCChannels.appLog,
])

// ── State ──────────────────────────────────────────────────────────────────

let overlayWindow: BrowserWindow | null = null
const pendingRequests = new Map<string, { resolve: (v: unknown) => void; reject: (e: Error) => void }>()
let requestCounter = 0
const preloadPath = join(__dirname, '../preload/index.mjs')

// ── Window geometry helpers ────────────────────────────────────────────────

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

const buildCircleShape = (diameter: number): Electron.Rectangle[] => {
  const r = diameter / 2
  const rects: Electron.Rectangle[] = []
  for (let y = 0; y < diameter; y++) {
    const dy = y - r + 0.5
    const hw = Math.sqrt(Math.max(0, r * r - dy * dy))
    const x0 = Math.floor(r - hw)
    const x1 = Math.ceil(r + hw)
    if (x1 > x0) rects.push({ x: x0, y, width: x1 - x0, height: 1 })
  }
  return rects
}

const setOverlaySize = (sizeKey: OverlaySizeKey) => {
  if (!overlayWindow) return
  const size = OVERLAY_SIZES[sizeKey]
  overlayWindow.setBounds(getOverlayBounds(size), true)
  overlayWindow.setShape(
    sizeKey === 'BASE'
      ? buildCircleShape(size.width)
      : [{ x: 0, y: 0, width: size.width, height: size.height }],
  )
}

// ── Parent IPC ─────────────────────────────────────────────────────────────

const sendToParent = (msg: unknown) => {
  try { process.send?.(msg as object) } catch {}
}

const forwardToParent = (channel: string, args: unknown[]): Promise<unknown> => {
  const requestId = `req-${++requestCounter}`
  return new Promise((resolve, reject) => {
    pendingRequests.set(requestId, { resolve, reject })
    sendToParent({ type: 'ipc-request', requestId, channel, args })
  })
}

// ── IPC Registration ───────────────────────────────────────────────────────

const registerIPC = () => {
  // Window-local handlers
  ipcMain.handle(IPCChannels.resizeMainWindow, (_e, sizeKey: OverlaySizeKey) => setOverlaySize(sizeKey))
  ipcMain.handle(IPCChannels.setMainWindowInteractivity, (_e, capture: boolean) => {
    if (overlayWindow) overlayWindow.setIgnoreMouseEvents(!capture, { forward: !capture })
  })
  ipcMain.handle(IPCChannels.hideWindow, () => overlayWindow?.hide())
  ipcMain.handle(IPCChannels.closeWindow, () => overlayWindow?.hide())
  ipcMain.handle(IPCChannels.minimizeWindow, () => overlayWindow?.hide())
  ipcMain.handle(IPCChannels.toggleMaximizeWindow, () => {})
  ipcMain.handle(IPCChannels.getWindowMaximized, () => false)
  ipcMain.handle(IPCChannels.showDictationPanel, () => overlayWindow?.showInactive())

  // Proxied handlers - forwarded to parent process
  for (const channel of PROXIED_CHANNELS) {
    ipcMain.handle(channel, (_e, ...args: unknown[]) => forwardToParent(channel, args))
  }
}

// ── Parent message handler ─────────────────────────────────────────────────

const handleParentMessage = (message: ParentMessage) => {
  if (message.type === 'ipc-response') {
    const pending = pendingRequests.get(message.requestId)
    if (pending) {
      pendingRequests.delete(message.requestId)
      if (message.error) pending.reject(new Error(message.error))
      else pending.resolve(message.result)
    }
    return
  }

  if (message.type === 'broadcast') {
    if (overlayWindow && !overlayWindow.isDestroyed()) {
      try { overlayWindow.webContents.send(message.channel, message.payload) } catch {}
    }
    return
  }

  if (message.type === 'command') {
    switch (message.action) {
      case 'show': overlayWindow?.showInactive(); break
      case 'hide': overlayWindow?.hide(); break
      case 'resize': setOverlaySize(message.payload as OverlaySizeKey); break
      case 'quit': app.quit(); break
    }
  }
}

// ── Window creation ────────────────────────────────────────────────────────

const createOverlayWindow = async () => {
  const baseBounds = getOverlayBounds(OVERLAY_SIZES.BASE)
  const iconArg = process.argv.find((a) => a.startsWith('--app-icon='))?.slice('--app-icon='.length)
  const icon = iconArg ? nativeImage.createFromPath(iconArg) : undefined

  overlayWindow = new BrowserWindow({
    ...baseBounds,
    icon: icon && !icon.isEmpty() ? icon : undefined,
    frame: false,
    transparent: true,
    resizable: false,
    movable: true,
    skipTaskbar: true,
    alwaysOnTop: true,
    hasShadow: false,
    type: 'toolbar',
    show: false,
    webPreferences: {
      preload: preloadPath,
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: !process.argv.includes('--no-sandbox'),
    },
  })

  overlayWindow.setAlwaysOnTop(true, 'screen-saver')
  overlayWindow.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true })
  overlayWindow.setShape(buildCircleShape(baseBounds.width))

  overlayWindow.webContents.on('did-fail-load', () => {
    setTimeout(() => { if (overlayWindow && !overlayWindow.isDestroyed()) overlayWindow.webContents.reload() }, 1500)
  })
  overlayWindow.webContents.on('render-process-gone', () => {
    setTimeout(() => { if (overlayWindow && !overlayWindow.isDestroyed()) overlayWindow.webContents.reload() }, 1500)
  })
  overlayWindow.webContents.setWindowOpenHandler(() => ({ action: 'deny' }))
  overlayWindow.webContents.on('will-navigate', (event, url) => {
    event.preventDefault()
    void shell.openExternal(url)
  })
  overlayWindow.on('closed', () => {
    overlayWindow = null
    sendToParent({ type: 'closed' })
  })

  const rendererURL = process.env.ELECTRON_RENDERER_URL
  if (rendererURL) {
    try {
      await overlayWindow.loadURL(`${rendererURL}#/overlay`)
    } catch {
      await overlayWindow.loadFile(join(__dirname, '../renderer/index.html'), { hash: '/overlay' })
    }
  } else {
    await overlayWindow.loadFile(join(__dirname, '../renderer/index.html'), { hash: '/overlay' })
  }

  sendToParent({ type: 'ready' })
}

// ── App lifecycle ──────────────────────────────────────────────────────────

app.disableHardwareAcceleration()
app.commandLine.appendSwitch('disable-gpu')
app.commandLine.appendSwitch('disable-gpu-compositing')
app.commandLine.appendSwitch('in-process-gpu')
if (process.argv.includes('--disable-dev-shm-usage')) app.commandLine.appendSwitch('disable-dev-shm-usage')
if (process.argv.includes('--no-sandbox')) {
  app.commandLine.appendSwitch('no-sandbox')
  app.commandLine.appendSwitch('disable-setuid-sandbox')
}

process.on('message', (msg) => handleParentMessage(msg as ParentMessage))

app.whenReady().then(async () => {
  registerIPC()
  await createOverlayWindow()
  overlayWindow?.showInactive()
})

app.on('window-all-closed', () => {})
