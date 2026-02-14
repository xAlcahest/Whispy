import type { ElectronAPI } from '../../../shared/electron-api'
import type { DisplayServer } from '../../../shared/ipc'

const noopUnsubscribe = () => {}

const fallbackElectronAPI: ElectronAPI = {
  showDictationPanel: async () => {},
  hideWindow: async () => {},
  closeWindow: async () => {
    throw new Error('closeWindow unavailable outside Electron runtime')
  },
  minimizeWindow: async () => {
    throw new Error('minimizeWindow unavailable outside Electron runtime')
  },
  toggleMaximizeWindow: async () => {
    throw new Error('toggleMaximizeWindow unavailable outside Electron runtime')
  },
  resizeMainWindow: async () => {},
  setMainWindowInteractivity: async () => {},
  openControlPanel: async () => {},
  openExternal: async (url: string) => {
    if (url.startsWith('http://') || url.startsWith('https://')) {
      window.open(url, '_blank', 'noopener,noreferrer')
      return
    }

    throw new Error('Unsupported external URL scheme in fallback runtime')
  },
  getDisplayServer: async () =>
    (navigator.userAgent.toLowerCase().includes('wayland') ? 'wayland' : 'unknown') as DisplayServer,
  onFloatingIconAutoHideChanged: () => noopUnsubscribe,
  onHotkeyRegistrationFailed: () => noopUnsubscribe,
  onHotkeyFallbackUsed: () => noopUnsubscribe,
}

const getRuntimeElectronAPI = (): ElectronAPI | null => {
  if (typeof window === 'undefined') {
    return null
  }

  if (typeof window.electronAPI === 'undefined') {
    return null
  }

  return window.electronAPI
}

export const electronAPI: ElectronAPI = new Proxy(fallbackElectronAPI, {
  get(target, property: keyof ElectronAPI) {
    const runtimeAPI = getRuntimeElectronAPI() ?? target
    const value = runtimeAPI[property]

    if (typeof value === 'function') {
      return value.bind(runtimeAPI)
    }

    return value
  },
})
