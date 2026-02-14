import { contextBridge, ipcRenderer } from 'electron'
import type { ElectronAPI } from '../shared/electron-api'
import {
  IPCChannels,
  type DisplayServer,
  type HotkeyFallbackUsedPayload,
  type HotkeyRegistrationFailedPayload,
  type OverlaySizeKey,
} from '../shared/ipc'

const listen = <T>(channel: string, callback: (payload: T) => void) => {
  const wrapped = (_event: Electron.IpcRendererEvent, payload: T) => {
    callback(payload)
  }

  ipcRenderer.on(channel, wrapped)
  return () => {
    ipcRenderer.removeListener(channel, wrapped)
  }
}

const electronAPI: ElectronAPI = {
  showDictationPanel: () => ipcRenderer.invoke(IPCChannels.showDictationPanel),
  hideWindow: () => ipcRenderer.invoke(IPCChannels.hideWindow),
  closeWindow: () => ipcRenderer.invoke(IPCChannels.closeWindow),
  minimizeWindow: () => ipcRenderer.invoke(IPCChannels.minimizeWindow),
  toggleMaximizeWindow: () => ipcRenderer.invoke(IPCChannels.toggleMaximizeWindow),
  resizeMainWindow: (sizeKey: OverlaySizeKey) => ipcRenderer.invoke(IPCChannels.resizeMainWindow, sizeKey),
  setMainWindowInteractivity: (shouldCapture: boolean) =>
    ipcRenderer.invoke(IPCChannels.setMainWindowInteractivity, shouldCapture),
  openControlPanel: () => ipcRenderer.invoke(IPCChannels.openControlPanel),
  openExternal: (url: string) => ipcRenderer.invoke(IPCChannels.openExternal, url),
  getDisplayServer: () => ipcRenderer.invoke(IPCChannels.getDisplayServer) as Promise<DisplayServer>,
  onFloatingIconAutoHideChanged: (callback) =>
    listen<boolean>(IPCChannels.floatingIconAutoHideChanged, callback),
  onHotkeyRegistrationFailed: (callback) =>
    listen<HotkeyRegistrationFailedPayload>(IPCChannels.hotkeyRegistrationFailed, callback),
  onHotkeyFallbackUsed: (callback) =>
    listen<HotkeyFallbackUsedPayload>(IPCChannels.hotkeyFallbackUsed, callback),
}

contextBridge.exposeInMainWorld('electronAPI', electronAPI)
