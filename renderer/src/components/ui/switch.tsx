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
      'app-no-drag relative inline-flex h-6 w-11 items-center rounded-full border transition-colors duration-200',
      checked
        ? 'border-primary/50 bg-primary shadow-[0_0_0_3px_rgba(37,99,235,0.12)]'
        : 'border-border-subtle bg-surface-3',
      className,
    )}
    {...props}
  >
    <span
      className={cn(
        'inline-block h-5 w-5 transform rounded-full bg-white shadow-sm transition-transform duration-200',
        checked ? 'translate-x-5' : 'translate-x-0.5',
      )}
    />
  </button>
)
