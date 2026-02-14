import type { ElectronAPI } from '../../../shared/electron-api'
import type { DisplayServer } from '../../../shared/ipc'

const noopUnsubscribe = () => {}

const fallbackElectronAPI: ElectronAPI = {
  showDictationPanel: async () => {},
  hideWindow: async () => {},
  resizeMainWindow: async () => {},
  setMainWindowInteractivity: async () => {},
  openControlPanel: async () => {},
  openExternal: async (url: string) => {
    if (url.startsWith('http://') || url.startsWith('https://')) {
      window.open(url, '_blank', 'noopener,noreferrer')
    }
  },
  getDisplayServer: async () =>
    (navigator.userAgent.toLowerCase().includes('wayland') ? 'wayland' : 'unknown') as DisplayServer,
  onFloatingIconAutoHideChanged: () => noopUnsubscribe,
  onHotkeyRegistrationFailed: () => noopUnsubscribe,
  onHotkeyFallbackUsed: () => noopUnsubscribe,
}

export const electronAPI: ElectronAPI =
  typeof window !== 'undefined' && typeof window.electronAPI !== 'undefined'
    ? window.electronAPI
    : fallbackElectronAPI
