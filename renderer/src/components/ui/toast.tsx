import { CheckCircle2, AlertTriangle, Info } from 'lucide-react'
import {
  createContext,
  useContext,
  useEffect,
  useMemo,
  useState,
  type PropsWithChildren,
} from 'react'
import { cn } from '../../lib/cn'

export type ToastVariant = 'default' | 'success' | 'destructive'

export interface ToastPayload {
  title: string
  description?: string
  duration?: number
  variant?: ToastVariant
}

interface ToastItem extends ToastPayload {
  id: string
  duration: number
  variant: ToastVariant
}

interface ToastContextValue {
  pushToast: (payload: ToastPayload) => void
}

const ToastContext = createContext<ToastContextValue | null>(null)

export const useToast = () => {
  const context = useContext(ToastContext)
  if (!context) {
    throw new Error('useToast must be used inside <ToastProvider>')
  }

  return context
}

interface ToastProviderProps extends PropsWithChildren {
  placement?: 'top-right' | 'overlay'
  onCountChange?: (count: number) => void
}

const variantIcon = {
  default: Info,
  success: CheckCircle2,
  destructive: AlertTriangle,
}

const variantClasses: Record<ToastVariant, string> = {
  default: 'border-border-subtle/80',
  success: 'border-emerald-500/40',
  destructive: 'border-destructive/50',
}

export const ToastProvider = ({
  children,
  placement = 'top-right',
  onCountChange,
}: ToastProviderProps) => {
  const [toasts, setToasts] = useState<ToastItem[]>([])

  useEffect(() => {
    onCountChange?.(toasts.length)
  }, [onCountChange, toasts.length])

  const pushToast = (payload: ToastPayload) => {
    const id = crypto.randomUUID()
    const duration = payload.duration ?? 2800

    setToasts((current) => [
      ...current,
      {
        id,
        title: payload.title,
        description: payload.description,
        duration,
        variant: payload.variant ?? 'default',
      },
    ])

    window.setTimeout(() => {
      setToasts((current) => current.filter((toast) => toast.id !== id))
    }, duration)
  }

  const contextValue = useMemo(
    () => ({
      pushToast,
    }),
    [],
  )

  return (
    <ToastContext.Provider value={contextValue}>
      {children}
      <div
        className={cn(
          'pointer-events-none fixed z-[90] flex w-full max-w-[360px] flex-col gap-2',
          placement === 'overlay' ? 'bottom-4 right-4' : 'right-6 top-6',
        )}
      >
        {toasts.map((toast) => {
          const Icon = variantIcon[toast.variant]

          return (
            <div
              key={toast.id}
              className={cn(
                'overflow-hidden rounded-[var(--radius-premium)] border bg-black/80 p-3 text-white shadow-[0_10px_38px_-16px_rgba(0,0,0,0.85)] backdrop-blur-xl animate-toast-in',
                variantClasses[toast.variant],
              )}
            >
              <div className="flex items-start gap-2">
                <Icon className="mt-0.5 h-4 w-4 shrink-0 text-white/90" />
                <div className="min-w-0">
                  <p className="text-sm font-medium">{toast.title}</p>
                  {toast.description ? (
                    <p className="mt-0.5 text-xs text-white/70">{toast.description}</p>
                  ) : null}
                </div>
              </div>
              <div className="mt-2 h-1 overflow-hidden rounded-full bg-white/15">
                <div
                  className="h-full bg-white/80"
                  style={{
                    animation: `toast-progress ${toast.duration}ms linear forwards`,
                  }}
                />
              </div>
            </div>
          )
        })}
      </div>
    </ToastContext.Provider>
  )
}
