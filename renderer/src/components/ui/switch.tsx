import type { ButtonHTMLAttributes } from 'react'
import { cn } from '../../lib/cn'

interface SwitchProps extends Omit<ButtonHTMLAttributes<HTMLButtonElement>, 'onChange'> {
  checked: boolean
  onCheckedChange: (checked: boolean) => void
}

export const Switch = ({ checked, onCheckedChange, className, ...props }: SwitchProps) => (
  <button
    type="button"
    role="switch"
    aria-checked={checked}
    onClick={() => {
      onCheckedChange(!checked)
    }}
    className={cn(
      'app-no-drag relative inline-flex h-5 w-9 items-center rounded-full border transition-colors duration-200',
      checked
        ? 'border-primary/50 bg-primary/85'
        : 'border-border-subtle bg-surface-3/80',
      className,
    )}
    {...props}
  >
    <span
      className={cn(
        'inline-block h-4 w-4 transform rounded-full bg-surface-0 transition-transform duration-200',
        checked ? 'translate-x-4' : 'translate-x-0.5',
      )}
    />
  </button>
)
