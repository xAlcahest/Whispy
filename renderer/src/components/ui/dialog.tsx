import { X } from 'lucide-react'
import {
  createContext,
  useContext,
  type HTMLAttributes,
  type PropsWithChildren,
  type ReactNode,
} from 'react'
import { cn } from '../../lib/cn'

interface DialogContextValue {
  open: boolean
  onOpenChange: (open: boolean) => void
}

const DialogContext = createContext<DialogContextValue | null>(null)

const useDialogContext = () => {
  const context = useContext(DialogContext)
  if (!context) {
    throw new Error('Dialog components must be used inside <Dialog>')
  }

  return context
}

interface DialogProps {
  open: boolean
  onOpenChange: (open: boolean) => void
  children: ReactNode
}

export const Dialog = ({ open, onOpenChange, children }: DialogProps) => {
  if (!open) {
    return null
  }

  return (
    <DialogContext.Provider value={{ open, onOpenChange }}>
      <div
        className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4"
        onMouseDown={(event) => {
          if (event.target === event.currentTarget) {
            onOpenChange(false)
          }
        }}
      >
        {children}
      </div>
    </DialogContext.Provider>
  )
}

export const DialogContent = ({ className, children, ...props }: PropsWithChildren<HTMLAttributes<HTMLDivElement>>) => {
  const context = useDialogContext()

  return (
    <div
      className={cn(
        'relative w-full max-w-md rounded-[var(--radius-premium)] border border-border-subtle bg-surface-1 p-4 text-foreground',
        className,
      )}
      {...props}
    >
      <button
        type="button"
        onClick={() => {
          context.onOpenChange(false)
        }}
        className="app-no-drag absolute right-3 top-3 inline-flex h-7 w-7 items-center justify-center rounded-md text-muted-foreground hover:bg-surface-2 hover:text-foreground"
      >
        <X className="h-4 w-4" />
      </button>
      {children}
    </div>
  )
}

export const DialogHeader = ({ className, ...props }: HTMLAttributes<HTMLDivElement>) => (
  <div className={cn('space-y-1 pr-8', className)} {...props} />
)

export const DialogTitle = ({ className, ...props }: HTMLAttributes<HTMLHeadingElement>) => (
  <h4 className={cn('text-sm font-semibold', className)} {...props} />
)

export const DialogDescription = ({ className, ...props }: HTMLAttributes<HTMLParagraphElement>) => (
  <p className={cn('text-xs text-muted-foreground', className)} {...props} />
)

export const DialogFooter = ({ className, ...props }: HTMLAttributes<HTMLDivElement>) => (
  <div className={cn('mt-4 flex justify-end gap-2', className)} {...props} />
)
