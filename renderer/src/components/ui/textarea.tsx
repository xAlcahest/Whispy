import { forwardRef, type TextareaHTMLAttributes } from 'react'
import { cn } from '../../lib/cn'

export const Textarea = forwardRef<HTMLTextAreaElement, TextareaHTMLAttributes<HTMLTextAreaElement>>(
  ({ className, ...props }, ref) => (
    <textarea
      ref={ref}
      className={cn(
        'app-no-drag min-h-[88px] w-full rounded-[calc(var(--radius-premium)-1px)] border border-border-subtle bg-surface-0 px-2.5 py-2 text-sm text-foreground outline-none transition-colors placeholder:text-muted-foreground focus:border-border-active focus:ring-1 focus:ring-primary/20',
        className,
      )}
      {...props}
    />
  ),
)

Textarea.displayName = 'Textarea'
