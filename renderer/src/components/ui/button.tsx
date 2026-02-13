import type { ButtonHTMLAttributes } from 'react'
import { cn } from '../../lib/cn'

type ButtonVariant = 'default' | 'secondary' | 'ghost' | 'outline' | 'destructive'
type ButtonSize = 'default' | 'sm' | 'lg' | 'icon'

interface ButtonProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  variant?: ButtonVariant
  size?: ButtonSize
}

const variantClasses: Record<ButtonVariant, string> = {
  default:
    'bg-primary text-white hover:bg-primary/90 active:bg-primary/80 border border-primary/80 shadow-[0_8px_20px_-12px_var(--color-primary)]',
  secondary: 'bg-surface-2 text-foreground hover:bg-surface-3 border border-border-subtle',
  ghost: 'bg-transparent text-foreground hover:bg-surface-2 border border-transparent',
  outline: 'bg-transparent text-foreground border border-border-subtle hover:border-border-hover hover:bg-surface-2',
  destructive:
    'bg-destructive text-white hover:bg-destructive/90 active:bg-destructive/80 border border-destructive/70',
}

const sizeClasses: Record<ButtonSize, string> = {
  default: 'h-9 px-4 text-sm',
  sm: 'h-8 px-3 text-xs',
  lg: 'h-10 px-5 text-sm',
  icon: 'h-9 w-9',
}

export const Button = ({ className, variant = 'default', size = 'default', ...props }: ButtonProps) => (
  <button
    className={cn(
      'inline-flex select-none items-center justify-center gap-2 rounded-[var(--radius-premium)] font-medium transition-all duration-150 disabled:pointer-events-none disabled:opacity-50 app-no-drag',
      variantClasses[variant],
      sizeClasses[size],
      className,
    )}
    {...props}
  />
)
