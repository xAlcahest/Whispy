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
import enMessages from './locales/en.json'
import deMessages from './locales/de.json'
import esMessages from './locales/es.json'
import frMessages from './locales/fr.json'
import itMessages from './locales/it.json'
import jaMessages from './locales/ja.json'
import ptMessages from './locales/pt.json'
import ruMessages from './locales/ru.json'
import zhCNMessages from './locales/zh-CN.json'
import zhTWMessages from './locales/zh-TW.json'

export type AppLocale =
  | 'en'
  | 'de'
  | 'es'
  | 'fr'
  | 'it'
  | 'ja'
  | 'pt'
  | 'ru'
  | 'zh-CN'
  | 'zh-TW'

export const SUPPORTED_LOCALES: Record<AppLocale, string> = {
  en: 'English',
  de: 'Deutsch',
  es: 'Español',
  fr: 'Français',
  it: 'Italiano',
  ja: '日本語',
  pt: 'Português',
  ru: 'Русский',
  'zh-CN': '简体中文',
  'zh-TW': '繁體中文',
}

type TranslationValues = Record<string, string | number>

const DEFAULT_LOCALE: AppLocale = 'en'

const translations: Record<AppLocale, Record<string, string>> = {
  en: enMessages as Record<string, string>,
  de: deMessages as Record<string, string>,
  es: esMessages as Record<string, string>,
  fr: frMessages as Record<string, string>,
  it: itMessages as Record<string, string>,
  ja: jaMessages as Record<string, string>,
  pt: ptMessages as Record<string, string>,
  ru: ruMessages as Record<string, string>,
  'zh-CN': zhCNMessages as Record<string, string>,
  'zh-TW': zhTWMessages as Record<string, string>,
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

const VALID_LOCALES = new Set<string>(Object.keys(SUPPORTED_LOCALES))

const readLocaleFromSettings = (): AppLocale => {
  const settings = loadSettings()
  const lang = settings.uiLanguage
  return lang && VALID_LOCALES.has(lang) ? (lang as AppLocale) : DEFAULT_LOCALE
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
