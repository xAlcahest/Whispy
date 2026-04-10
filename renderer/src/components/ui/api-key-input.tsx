import { useState, useEffect, useRef } from 'react'
import { Check, X, KeyRound } from 'lucide-react'
import { Input } from './input'
import { useI18n } from '../../i18n'
import { isSecretMasked } from '../../../../shared/secrets'

interface ApiKeyInputProps {
  apiKey: string
  setApiKey: (key: string) => void
  className?: string
  placeholder?: string
  label?: string
}

function maskKey(key: string): string {
  if (isSecretMasked(key)) return key
  if (key.length <= 8) return '\u2022\u2022\u2022\u2022\u2022\u2022\u2022\u2022'
  return key.slice(0, 3) + '...' + key.slice(-4)
}

export function ApiKeyInput({
  apiKey,
  setApiKey,
  className = '',
  placeholder,
  label,
}: ApiKeyInputProps) {
  const { t } = useI18n()
  const resolvedPlaceholder = placeholder ?? t('apiKeyInput.placeholder')
  const [isEditing, setIsEditing] = useState(false)
  const [draft, setDraft] = useState('')
  const inputRef = useRef<HTMLInputElement>(null)
  const containerRef = useRef<HTMLDivElement>(null)
  const hasKey = apiKey.length > 0

  useEffect(() => {
    if (isEditing) {
      requestAnimationFrame(() => {
        inputRef.current?.focus()
        inputRef.current?.select()
      })
    }
  }, [isEditing])

  const enterEdit = () => {
    setDraft(isSecretMasked(apiKey) ? '' : apiKey)
    setIsEditing(true)
  }

  const save = () => {
    const trimmed = draft.trim()
    if (!trimmed && isSecretMasked(apiKey)) {
      setIsEditing(false)
      return
    }
    setApiKey(trimmed)
    setIsEditing(false)
  }

  const cancel = () => {
    setDraft('')
    setIsEditing(false)
  }

  const handleKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === 'Enter') {
      e.preventDefault()
      save()
    }
    if (e.key === 'Escape') {
      e.preventDefault()
      cancel()
    }
  }

  useEffect(() => {
    if (!isEditing) return
    const handleClickOutside = (e: MouseEvent) => {
      if (containerRef.current?.contains(e.target as Node)) return
      cancel()
    }
    document.addEventListener('mousedown', handleClickOutside)
    return () => document.removeEventListener('mousedown', handleClickOutside)
  }, [isEditing])

  return (
    <div className={className}>
      {label && (
        <label className="block text-xs font-medium text-foreground mb-1">{label}</label>
      )}

      <div ref={containerRef} className="relative">
        {isEditing ? (
          <div className="relative">
            <Input
              ref={inputRef}
              type="text"
              placeholder={resolvedPlaceholder}
              value={draft}
              onChange={(e) => setDraft(e.target.value)}
              onKeyDown={handleKeyDown}
              aria-label={label || 'API key'}
              className="h-8 text-sm font-mono pr-16"
              autoComplete="off"
              spellCheck={false}
            />
            <div className="absolute right-1 top-1/2 -translate-y-1/2 flex items-center gap-0.5">
              <button
                type="button"
                onClick={save}
                className="h-6 w-6 flex items-center justify-center rounded text-green-600 hover:bg-green-600/10 active:scale-95 transition-all dark:text-green-400"
                aria-label="Save API key"
              >
                <Check className="w-3.5 h-3.5" />
              </button>
              <button
                type="button"
                onClick={cancel}
                className="h-6 w-6 flex items-center justify-center rounded text-muted-foreground/50 hover:text-muted-foreground hover:bg-surface-2/50 active:scale-95 transition-all"
                aria-label="Cancel editing"
              >
                <X className="w-3.5 h-3.5" />
              </button>
            </div>
          </div>
        ) : (
          <button
            type="button"
            onClick={enterEdit}
            className={`app-no-drag w-full h-8 flex items-center px-3 rounded-[calc(var(--radius-premium)-1px)] text-sm transition-all cursor-pointer group ${
              hasKey
                ? 'border border-border-subtle bg-surface-0 hover:border-border-hover'
                : 'border border-dashed border-border-subtle/60 bg-transparent hover:border-border-hover hover:bg-surface-2/30'
            }`}
            aria-label={hasKey ? 'Edit API key' : 'Add API key'}
          >
            {hasKey ? (
              <span className="flex items-center gap-1.5 text-foreground/70 font-mono text-xs tracking-wide">
                <KeyRound className="w-3 h-3 text-muted-foreground/50 shrink-0" />
                {maskKey(apiKey)}
              </span>
            ) : (
              <span className="text-muted-foreground/40 text-xs">{resolvedPlaceholder}</span>
            )}
            <span className="ml-auto text-muted-foreground/30 text-xs group-hover:text-muted-foreground/60 transition-colors">
              {hasKey ? t('apiKeyInput.editButton') : t('apiKeyInput.addButton')}
            </span>
          </button>
        )}
      </div>
    </div>
  )
}
