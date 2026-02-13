import {
  createContext,
  useContext,
  type HTMLAttributes,
  type PropsWithChildren,
  type ReactNode,
} from 'react'
import { cn } from '../../lib/cn'

interface TabsContextValue {
  value: string
  onValueChange: (value: string) => void
}

const TabsContext = createContext<TabsContextValue | null>(null)

const useTabsContext = () => {
  const context = useContext(TabsContext)
  if (!context) {
    throw new Error('Tabs components must be used inside <Tabs>')
  }

  return context
}

interface TabsProps extends PropsWithChildren {
  value: string
  onValueChange: (value: string) => void
  className?: string
}

export const Tabs = ({ value, onValueChange, className, children }: TabsProps) => (
  <TabsContext.Provider value={{ value, onValueChange }}>
    <div className={cn('space-y-3', className)}>{children}</div>
  </TabsContext.Provider>
)

export const TabsList = ({ className, ...props }: HTMLAttributes<HTMLDivElement>) => (
  <div
    className={cn(
      'inline-flex h-9 items-center rounded-[var(--radius-premium)] border border-border-subtle bg-surface-2 p-1',
      className,
    )}
    {...props}
  />
)

interface TabsTriggerProps {
  value: string
  className?: string
  children: ReactNode
}

export const TabsTrigger = ({ value, className, children }: TabsTriggerProps) => {
  const context = useTabsContext()
  const active = context.value === value

  return (
    <button
      type="button"
      onClick={() => {
        context.onValueChange(value)
      }}
      className={cn(
        'app-no-drag inline-flex h-7 min-w-[108px] items-center justify-center rounded-[6px] px-3 text-xs font-medium transition-colors',
        active ? 'bg-surface-0 text-foreground shadow-sm' : 'text-muted-foreground hover:text-foreground',
        className,
      )}
    >
      {children}
    </button>
  )
}

interface TabsContentProps extends HTMLAttributes<HTMLDivElement> {
  value: string
}

export const TabsContent = ({ value, className, children, ...props }: TabsContentProps) => {
  const context = useTabsContext()
  if (context.value !== value) {
    return null
  }

  return (
    <div className={cn('outline-none', className)} {...props}>
      {children}
    </div>
  )
}
