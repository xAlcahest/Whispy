import { useEffect, type ReactNode } from 'react'
import { cn } from '../../lib/cn'

export interface DropdownItem {
  label?: string
  onSelect?: () => void
  description?: string
  icon?: ReactNode
  separator?: boolean
  selected?: boolean
  destructive?: boolean
  disabled?: boolean
}

interface DropdownProps {
  open: boolean
  anchor: { x: number; y: number } | null
  onClose: () => void
  items: DropdownItem[]
}

export const Dropdown = ({ open, anchor, onClose, items }: DropdownProps) => {
  useEffect(() => {
    if (!open) {
      return
    }

    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        onClose()
      }
    }

    const onPointerDown = () => {
      onClose()
    }

    window.addEventListener('keydown', onKeyDown)
    window.addEventListener('pointerdown', onPointerDown)
    return () => {
      window.removeEventListener('keydown', onKeyDown)
      window.removeEventListener('pointerdown', onPointerDown)
    }
  }, [onClose, open])

  if (!open || !anchor) {
    return null
  }

  return (
    <div
      className="fixed z-50 w-56 rounded-[var(--radius-premium)] border border-border-subtle bg-surface-1 p-1 app-no-drag"
      style={{
        left: anchor.x,
        top: anchor.y,
      }}
      onPointerDown={(event) => {
        event.stopPropagation()
      }}
    >
      {items.map((item, index) => {
        const itemKey = `${item.label ?? 'separator'}-${index}`

        if (item.separator) {
          return <div key={itemKey} className="my-1 h-px bg-border-subtle" />
        }

        return (
          <button
            key={itemKey}
            type="button"
            disabled={item.disabled}
            onClick={() => {
              item.onSelect?.()
              onClose()
            }}
            className={cn(
              'app-no-drag flex min-h-8 w-full items-start gap-2 rounded-md px-2.5 py-1.5 text-left text-xs transition-colors',
              item.destructive
                ? 'text-destructive hover:bg-destructive/10'
                : item.selected
                  ? 'bg-surface-2 text-foreground'
                  : 'text-foreground hover:bg-surface-2',
              item.disabled ? 'cursor-not-allowed opacity-50' : undefined,
            )}
          >
            {item.icon ? <span className="mt-0.5 shrink-0 text-foreground/55">{item.icon}</span> : null}
            <span className="min-w-0">
              <span className="block truncate">{item.label ?? ''}</span>
              {item.description ? <span className="block truncate text-xs text-muted-foreground">{item.description}</span> : null}
            </span>
          </button>
        )
      })}
    </div>
  )
}
