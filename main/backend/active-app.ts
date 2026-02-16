import { activeWindow } from 'get-windows'

export const detectActiveApp = async () => {
  try {
    const windowInfo = await activeWindow({
      accessibilityPermission: false,
      screenRecordingPermission: false,
    })

    if (!windowInfo) {
      return 'Active app (unavailable)'
    }

    const ownerName = windowInfo.owner?.name?.trim()
    const title = windowInfo.title?.trim()

    if (ownerName && title) {
      return `${ownerName} — ${title}`
    }

    if (ownerName) {
      return ownerName
    }

    if (title) {
      return title
    }

    return 'Active app (unavailable)'
  } catch {
    return 'Active app (unavailable)'
  }
}
