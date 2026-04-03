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
    'bg-primary/90 text-white hover:bg-primary active:bg-primary/90 border border-primary/60',
  secondary: 'bg-surface-2/85 text-foreground hover:bg-surface-2 border border-border-subtle',
  ghost: 'bg-transparent text-foreground hover:bg-surface-2/65 border border-transparent',
  outline: 'bg-surface-0/25 text-foreground border border-border-subtle hover:border-border-hover hover:bg-surface-2/65',
  destructive:
    'bg-destructive text-white hover:bg-destructive/90 active:bg-destructive/80 border border-destructive/70',
}

const sizeClasses: Record<ButtonSize, string> = {
  default: 'h-8 px-3.5 text-xs',
  sm: 'h-7 px-2.5 text-[11px]',
  lg: 'h-9 px-4 text-sm',
  icon: 'h-8 w-8',
}

export const Button = ({ className, variant = 'default', size = 'default', ...props }: ButtonProps) => (
  <button
    className={cn(
      'inline-flex select-none items-center justify-center gap-1.5 rounded-[var(--radius-premium)] font-medium transition-colors duration-150 disabled:pointer-events-none disabled:opacity-50 app-no-drag',
      variantClasses[variant],
      sizeClasses[size],
      className,
    )}
    {...props}
  />
)
