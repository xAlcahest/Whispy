export type OverlaySizeKey = 'BASE' | 'WITH_MENU' | 'WITH_TOAST' | 'EXPANDED'
export type DisplayServer = 'wayland' | 'x11' | 'unknown'

export interface HotkeyRegistrationFailedPayload {
  requestedHotkey: string
  reason: string
}

export interface HotkeyFallbackUsedPayload {
  fallbackHotkey: string
  details: string
}

export const IPCChannels = {
  showDictationPanel: 'ui:show-dictation-panel',
  hideWindow: 'ui:hide-window',
  closeWindow: 'ui:close-window',
  minimizeWindow: 'ui:minimize-window',
  toggleMaximizeWindow: 'ui:toggle-maximize-window',
  resizeMainWindow: 'ui:resize-main-window',
  setMainWindowInteractivity: 'ui:set-main-window-interactivity',
  openControlPanel: 'ui:open-control-panel',
  openExternal: 'ui:open-external',
  getDisplayServer: 'ui:get-display-server',
  floatingIconAutoHideChanged: 'ui:event-floating-icon-auto-hide-changed',
  hotkeyRegistrationFailed: 'ui:event-hotkey-registration-failed',
  hotkeyFallbackUsed: 'ui:event-hotkey-fallback-used',
} as const
