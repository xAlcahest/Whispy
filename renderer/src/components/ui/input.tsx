import { forwardRef, type InputHTMLAttributes } from 'react'
import { cn } from '../../lib/cn'

export const Input = forwardRef<HTMLInputElement, InputHTMLAttributes<HTMLInputElement>>(
  ({ className, ...props }, ref) => (
    <input
      ref={ref}
      className={cn(
        'app-no-drag h-8 w-full rounded-[calc(var(--radius-premium)-1px)] border border-border-subtle bg-surface-0 px-2.5 text-xs text-foreground outline-none transition-colors placeholder:text-muted-foreground focus:border-border-active focus:ring-1 focus:ring-primary/20',
        className,
      )}
      {...props}
    />
  ),
)

Input.displayName = 'Input'
