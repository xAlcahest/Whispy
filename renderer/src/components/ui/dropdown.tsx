import { useEffect } from 'react'
import { cn } from '../../lib/cn'

export interface DropdownItem {
  label: string
  onSelect: () => void
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
      className="fixed z-50 w-56 rounded-[var(--radius-premium)] border border-border-subtle bg-surface-1 p-1.5 shadow-xl app-no-drag"
      style={{
        left: anchor.x,
        top: anchor.y,
      }}
      onPointerDown={(event) => {
        event.stopPropagation()
      }}
    >
      {items.map((item) => (
        <button
          key={item.label}
          type="button"
          disabled={item.disabled}
          onClick={() => {
            item.onSelect()
            onClose()
          }}
          className={cn(
            'app-no-drag flex h-9 w-full items-center rounded-md px-3 text-left text-sm transition-colors',
            item.destructive
              ? 'text-destructive hover:bg-destructive/10'
              : 'text-foreground hover:bg-surface-2',
            item.disabled ? 'cursor-not-allowed opacity-50' : undefined,
          )}
        >
          {item.label}
        </button>
      ))}
    </div>
  )
}
