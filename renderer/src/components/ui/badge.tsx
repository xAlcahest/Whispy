import type { HTMLAttributes } from 'react'
import { cn } from '../../lib/cn'

interface BadgeProps extends HTMLAttributes<HTMLSpanElement> {
  tone?: 'neutral' | 'primary' | 'success' | 'warning'
}

const toneClasses: Record<NonNullable<BadgeProps['tone']>, string> = {
  neutral: 'bg-surface-2 text-muted-foreground border-border-subtle',
  primary: 'bg-primary/14 text-primary border-primary/35',
  success: 'bg-emerald-500/10 text-emerald-500 border-emerald-500/30',
  warning: 'bg-amber-500/10 text-amber-500 border-amber-500/30',
}

export const Badge = ({ tone = 'neutral', className, ...props }: BadgeProps) => (
  <span
    className={cn(
      'inline-flex h-5 items-center rounded-md border px-2 text-[10px] font-medium tracking-normal',
      toneClasses[tone],
      className,
    )}
    {...props}
  />
)
