import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useState,
  type PropsWithChildren,
} from 'react'
import { STORAGE_KEYS } from '../lib/constants'
import { loadSettings, saveSettings } from '../lib/storage'

export type AppLocale = 'en'

type TranslationValues = Record<string, string | number>

const DEFAULT_LOCALE: AppLocale = 'en'

const translations: Record<AppLocale, Record<string, string>> = {
  en: {
    menuConversations: 'Conversations',
    menuNotes: 'Notes',
    menuSettings: 'Settings',
    settingsGeneralTab: 'General',
    settingsModelsTab: 'Models',
    settingsShortcutsTab: 'Shortcuts',
    settingsInfoTab: 'Info',
    commonActive: 'Active',
    commonSelect: 'Select',
    commonShowAll: 'Show all',
  },
}

const formatMessage = (message: string, values?: TranslationValues) => {
  if (!values) {
    return message
  }

  return Object.entries(values).reduce(
    (formatted, [key, value]) => formatted.replace(new RegExp(`\\{${key}\\}`, 'g'), String(value)),
    message,
  )
}

const readLocaleFromSettings = (): AppLocale => {
  const settings = loadSettings()
  return settings.uiLanguage === 'en' ? 'en' : DEFAULT_LOCALE
}

interface I18nContextValue {
  locale: AppLocale
  t: (key: string, values?: TranslationValues) => string
  setLocale: (locale: AppLocale) => void
}

const I18nContext = createContext<I18nContextValue | null>(null)

export const I18nProvider = ({ children }: PropsWithChildren) => {
  const [locale, setLocaleState] = useState<AppLocale>(readLocaleFromSettings)

  const setLocale = useCallback((nextLocale: AppLocale) => {
    setLocaleState(nextLocale)

    const settings = loadSettings()
    if (settings.uiLanguage !== nextLocale) {
      saveSettings({
        ...settings,
        uiLanguage: nextLocale,
      })
    }
  }, [])

  useEffect(() => {
    const onStorage = (event: StorageEvent) => {
      if (event.key !== STORAGE_KEYS.settings) {
        return
      }

      setLocaleState(readLocaleFromSettings())
    }

    window.addEventListener('storage', onStorage)
    return () => {
      window.removeEventListener('storage', onStorage)
    }
  }, [])

  const t = useCallback(
    (key: string, values?: TranslationValues) => {
      const message = translations[locale][key] ?? translations[DEFAULT_LOCALE][key] ?? key
      return formatMessage(message, values)
    },
    [locale],
  )

  const value = useMemo(
    () => ({
      locale,
      t,
      setLocale,
    }),
    [locale, setLocale, t],
  )

  return <I18nContext.Provider value={value}>{children}</I18nContext.Provider>
}

export const useI18n = () => {
  const context = useContext(I18nContext)
  if (!context) {
    throw new Error('useI18n must be used inside <I18nProvider>')
  }

  return context
}
