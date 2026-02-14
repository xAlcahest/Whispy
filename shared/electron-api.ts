import type {
  DisplayServer,
  HotkeyFallbackUsedPayload,
  HotkeyRegistrationFailedPayload,
  OverlaySizeKey,
} from './ipc'

export interface ElectronAPI {
  showDictationPanel: () => Promise<void>
  hideWindow: () => Promise<void>
  resizeMainWindow: (sizeKey: OverlaySizeKey) => Promise<void>
  setMainWindowInteractivity: (shouldCapture: boolean) => Promise<void>
  openControlPanel: () => Promise<void>
  openExternal: (url: string) => Promise<void>
  getDisplayServer: () => Promise<DisplayServer>
  onFloatingIconAutoHideChanged: (callback: (enabled: boolean) => void) => () => void
  onHotkeyRegistrationFailed: (
    callback: (payload: HotkeyRegistrationFailedPayload) => void,
  ) => () => void
  onHotkeyFallbackUsed: (callback: (payload: HotkeyFallbackUsedPayload) => void) => () => void
}
