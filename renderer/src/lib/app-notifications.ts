import type { ToastPayload } from '../components/ui/toast'
import { STORAGE_KEYS } from './constants'

export interface AppNotification extends ToastPayload {
  id: string
  createdAt: number
}

export const emitAppNotification = (payload: ToastPayload) => {
  const notification: AppNotification = {
    id: crypto.randomUUID(),
    createdAt: Date.now(),
    ...payload,
  }

  localStorage.setItem(STORAGE_KEYS.appNotification, JSON.stringify(notification))
}

export const parseAppNotification = (raw: string | null): AppNotification | null => {
  if (!raw) {
    return null
  }

  try {
    return JSON.parse(raw) as AppNotification
  } catch {
    return null
  }
}
