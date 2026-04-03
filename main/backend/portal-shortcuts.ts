import dbus from 'dbus-next'
let bus: ReturnType<typeof dbus.sessionBus> | null = null
let activatedCallback: (() => void) | null = null
let shortcutChangedCallback: ((newTrigger: string) => void) | null = null
let registeredMethod: 'kglobalaccel' | 'portal' | null = null

const QT_KEY_MAP: Record<string, number> = {
  F1: 0x01000030, F2: 0x01000031, F3: 0x01000032, F4: 0x01000033,
  F5: 0x01000034, F6: 0x01000035, F7: 0x01000036, F8: 0x01000037,
  F9: 0x01000038, F10: 0x01000039, F11: 0x0100003a, F12: 0x0100003b,
  Home: 0x01000010, End: 0x01000011, PageUp: 0x01000016, PageDown: 0x01000017,
  Insert: 0x01000006, Delete: 0x01000007, Pause: 0x01000008, Print: 0x01000009,
  ScrollLock: 0x01000026, Space: 0x20, Enter: 0x01000004, Return: 0x01000004,
  Tab: 0x01000001, Escape: 0x01000000, Backspace: 0x01000003,
}

const QT_MODIFIER_MAP: Record<string, number> = {
  Ctrl: 0x04000000, Control: 0x04000000,
  Shift: 0x02000000,
  Alt: 0x08000000,
  Meta: 0x10000000, Super: 0x10000000, Win: 0x10000000,
}

const hotkeyToQtKeyCode = (hotkey: string): number | null => {
  const parts = hotkey.split('+').map((p) => p.trim())
  let modifiers = 0
  let key = 0

  for (const part of parts) {
    const mod = QT_MODIFIER_MAP[part]
    if (mod) {
      modifiers |= mod
      continue
    }

    const mapped = QT_KEY_MAP[part]
    if (mapped) {
      key = mapped
    } else if (part.length === 1) {
      key = part.toUpperCase().charCodeAt(0)
    }
  }

  return key > 0 ? modifiers | key : null
}

const isKde = () => {
  const desktop = (process.env.XDG_CURRENT_DESKTOP ?? '').toLowerCase()
  return desktop.includes('kde') || desktop.includes('plasma')
}

export interface PortalShortcutResult {
  registered: boolean
  assignedTrigger: string | null
}

const tryKGlobalAccel = async (
  shortcutId: string,
  hotkey: string,
  onActivated: () => void,
): Promise<PortalShortcutResult> => {
  const qtKey = hotkeyToQtKeyCode(hotkey)
  if (qtKey === null) return { registered: false, assignedTrigger: null }

  bus = dbus.sessionBus()

  const kgaProxy = await bus.getProxyObject('org.kde.kglobalaccel', '/kglobalaccel')
  const kgaIface = kgaProxy.getInterface('org.kde.KGlobalAccel')

  const actionId = ['whispy', shortcutId, 'Whispy', 'Toggle Dictation']
  await (kgaIface as unknown as { doRegister: (id: string[]) => Promise<void> }).doRegister(actionId)

  const setShortcut = kgaIface as unknown as {
    setShortcut: (actionId: string[], keys: number[], flags: number) => Promise<number[]>
  }
  await setShortcut.setShortcut(actionId, [qtKey], 0x2)

  activatedCallback = onActivated

  const componentProxy = await bus.getProxyObject('org.kde.kglobalaccel', '/component/whispy')
  const componentIface = componentProxy.getInterface('org.kde.kglobalaccel.Component')
  componentIface.on('globalShortcutPressed', () => {
    if (activatedCallback) activatedCallback()
  })

  registeredMethod = 'kglobalaccel'
  return { registered: true, assignedTrigger: hotkey }
}

const tryXdgPortal = async (
  shortcutId: string,
  description: string,
  preferredTrigger: string,
  onActivated: () => void,
  onShortcutChanged?: (newTrigger: string) => void,
): Promise<PortalShortcutResult> => {
  const PORTAL_DEST = 'org.freedesktop.portal.Desktop'
  const PORTAL_PATH = '/org/freedesktop/portal/desktop'
  const PORTAL_IFACE = 'org.freedesktop.portal.GlobalShortcuts'

  bus = dbus.sessionBus()
  const proxy = await bus.getProxyObject(PORTAL_DEST, PORTAL_PATH)
  const portalIface = proxy.getInterface(PORTAL_IFACE)

  const sessionToken = `whispy_${Date.now()}`

  const createResult = await callPortalMethod(bus, portalIface, 'CreateSession', [
    {
      'handle_token': new dbus.Variant('s', `req_c_${Date.now()}`),
      'session_handle_token': new dbus.Variant('s', sessionToken),
    },
  ])

  const rawHandle = createResult?.session_handle
  const sessionPath = String(unwrapVariant(rawHandle) ?? '')
  if (!sessionPath) return { registered: false, assignedTrigger: null }

  const shortcuts = [[
    shortcutId,
    {
      description: new dbus.Variant('s', description),
      preferred_trigger: new dbus.Variant('s', preferredTrigger),
    },
  ]]

  const bindResult = await callPortalMethod(bus, portalIface, 'BindShortcuts', [
    sessionPath, shortcuts, '',
    { 'handle_token': new dbus.Variant('s', `req_b_${Date.now()}`) },
  ])

  const assignedTrigger = extractTriggerFromShortcuts(bindResult?.shortcuts) ?? preferredTrigger

  activatedCallback = onActivated
  shortcutChangedCallback = onShortcutChanged ?? null
  portalIface.on('Activated', (..._args: unknown[]) => { if (activatedCallback) activatedCallback() })
  portalIface.on('ShortcutsChanged', (...args: unknown[]) => {
    const trigger = extractTriggerFromShortcuts(args[1])
    if (trigger && shortcutChangedCallback) shortcutChangedCallback(trigger)
  })

  registeredMethod = 'portal'
  return { registered: true, assignedTrigger }
}

export const registerPortalShortcut = async (
  shortcutId: string,
  description: string,
  preferredTrigger: string,
  onActivated: () => void,
  onShortcutChanged?: (newTrigger: string) => void,
): Promise<PortalShortcutResult> => {
  try {
    if (registeredMethod === 'kglobalaccel' && bus) {
      const qtKey = hotkeyToQtKeyCode(preferredTrigger)
      if (qtKey !== null) {
        try {
          const kgaProxy = await bus.getProxyObject('org.kde.kglobalaccel', '/kglobalaccel')
          const kgaIface = kgaProxy.getInterface('org.kde.KGlobalAccel')
          const actionId = ['whispy', shortcutId, 'Whispy', 'Toggle Dictation']
          const setShortcut = kgaIface as unknown as {
            setShortcut: (actionId: string[], keys: number[], flags: number) => Promise<number[]>
          }
          await setShortcut.setShortcut(actionId, [qtKey], 0x2)
          activatedCallback = onActivated
          return { registered: true, assignedTrigger: preferredTrigger }
        } catch {
          // fall through to full re-registration
        }
      }
    }

    await cleanupPortalShortcut()

    if (isKde()) {
      try {
        const result = await tryKGlobalAccel(shortcutId, preferredTrigger, onActivated)
        if (result.registered) return result
      } catch (error) {
        console.error('[PortalShortcuts] KGlobalAccel failed, trying XDG portal:', error instanceof Error ? error.message : String(error))
        if (bus) { bus.disconnect(); bus = null }
      }
    }

    return await tryXdgPortal(shortcutId, description, preferredTrigger, onActivated, onShortcutChanged)
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    console.error(`[PortalShortcuts] Registration failed: ${message}`)
    return { registered: false, assignedTrigger: null }
  }
}

export const cleanupPortalShortcut = async () => {
  if (bus) {
    bus.disconnect()
    bus = null
  }
  activatedCallback = null
  shortcutChangedCallback = null
  registeredMethod = null
}

export const isPortalAvailable = async (): Promise<boolean> => {
  if (isKde()) return true
  try {
    const testBus = dbus.sessionBus()
    const proxy = await testBus.getProxyObject('org.freedesktop.portal.Desktop', '/org/freedesktop/portal/desktop')
    const propsIface = proxy.getInterface('org.freedesktop.DBus.Properties')
    const version = await propsIface.Get('org.freedesktop.portal.GlobalShortcuts', 'version')
    testBus.disconnect()
    return (unwrapVariant(version) as number) >= 1
  } catch {
    return false
  }
}

const unwrapVariant = (value: unknown): unknown => {
  if (value && typeof value === 'object' && 'value' in value) {
    return (value as { value: unknown }).value
  }
  return value
}

const extractTriggerFromShortcuts = (shortcuts: unknown): string | null => {
  if (!Array.isArray(shortcuts)) return null
  for (const entry of shortcuts) {
    if (!Array.isArray(entry) || entry.length < 2) continue
    const props = entry[1]
    if (props && typeof props === 'object') {
      const trigger = (props as Record<string, unknown>)['trigger_description']
        ?? (props as Record<string, unknown>)['preferred_trigger']
      const value = unwrapVariant(trigger)
      if (typeof value === 'string' && value.length > 0) return value
    }
  }
  return null
}

const callPortalMethod = (
  sessionBus: ReturnType<typeof dbus.sessionBus>,
  iface: dbus.ClientInterface,
  method: string,
  args: unknown[],
): Promise<Record<string, unknown>> => {
  return new Promise((resolve, reject) => {
    const timeoutHandle = setTimeout(() => {
      sessionBus.removeListener('message', onSignal)
      reject(new Error(`Portal ${method} timed out`))
    }, 15_000)

    const senderName = ((sessionBus as unknown as { name?: string }).name ?? '').replace(/^:/, '').replace(/\./g, '_')
    const extractToken = (obj: unknown): string | null => {
      if (obj && typeof obj === 'object' && 'handle_token' in (obj as Record<string, unknown>)) {
        return String(unwrapVariant((obj as Record<string, dbus.Variant>)['handle_token']))
      }
      return null
    }
    const handleToken = extractToken(args[0]) ?? extractToken(args[args.length - 1]) ?? `req_${Date.now()}`
    const expectedRequestPath = `/org/freedesktop/portal/desktop/request/${senderName}/${handleToken}`

    const onSignal = (msg: dbus.Message) => {
      if (msg.path === expectedRequestPath && msg.interface === 'org.freedesktop.portal.Request' && msg.member === 'Response' && msg.body) {
        clearTimeout(timeoutHandle)
        sessionBus.removeListener('message', onSignal)
        const [response, results] = msg.body as [number, Record<string, unknown>]
        if (response === 0 || response === 1) {
          resolve(results ?? {})
        } else {
          reject(new Error(`Portal ${method} returned response ${response}`))
        }
      }
    }

    sessionBus.on('message', onSignal)

    ;(async () => {
      try {
        const dbusProxy = await sessionBus.getProxyObject('org.freedesktop.DBus', '/org/freedesktop/DBus')
        const dbusIface = dbusProxy.getInterface('org.freedesktop.DBus')
        const matchRule = `type='signal',interface='org.freedesktop.portal.Request',member='Response',path='${expectedRequestPath}'`
        await (dbusIface as unknown as { AddMatch: (r: string) => Promise<void> }).AddMatch(matchRule)
      } catch { /* continue */ }
    })().then(() => {
      return (iface as unknown as Record<string, (...a: unknown[]) => Promise<string>>)[method](...args)
    }).catch((error) => {
      clearTimeout(timeoutHandle)
      sessionBus.removeListener('message', onSignal)
      reject(error)
    })
  })
}
