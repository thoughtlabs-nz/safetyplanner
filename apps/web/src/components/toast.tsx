import { createContext, useCallback, useContext, useRef, useState, type ReactNode } from 'react'
import { AnimatePresence, motion } from 'motion/react'

export type ToastType = 'default' | 'warning' | 'error'

interface Toast {
  id: number
  message: string
  type: ToastType
}

interface ToastContextValue {
  toast: (message: string, type?: ToastType) => void
}

const ToastContext = createContext<ToastContextValue | null>(null)

// Border-left color per type — solid violet (the app's brand accent, used
// for the sidebar's active-nav indicator) for everything by default,
// orange for warnings, red for errors. Thicker than a normal accent border
// so the toast reads clearly as "this is the app talking to you" at a
// glance, regardless of severity.
const BORDER_CLASS: Record<ToastType, string> = {
  default: 'border-l-violet-700 dark:border-l-violet-500',
  warning: 'border-l-orange-500 dark:border-l-orange-400',
  error: 'border-l-red-600 dark:border-l-red-500',
}

const AUTO_DISMISS_MS: Record<ToastType, number> = {
  default: 4000,
  warning: 6000,
  error: 8000,
}

let nextId = 1

export function ToastProvider({ children }: { children: ReactNode }) {
  const [toasts, setToasts] = useState<Toast[]>([])
  const timers = useRef(new Map<number, ReturnType<typeof setTimeout>>())

  const dismiss = useCallback((id: number) => {
    setToasts((prev) => prev.filter((t) => t.id !== id))
    const timer = timers.current.get(id)
    if (timer) {
      clearTimeout(timer)
      timers.current.delete(id)
    }
  }, [])

  const toast = useCallback(
    (message: string, type: ToastType = 'default') => {
      const id = nextId++
      setToasts((prev) => [...prev, { id, message, type }])
      const timer = setTimeout(() => dismiss(id), AUTO_DISMISS_MS[type])
      timers.current.set(id, timer)
    },
    [dismiss],
  )

  return (
    <ToastContext.Provider value={{ toast }}>
      {children}
      <div className="pointer-events-none fixed inset-x-0 bottom-4 z-50 flex flex-col items-center gap-2 px-4 sm:items-end sm:px-6">
        <AnimatePresence>
          {toasts.map((t) => (
            <motion.div
              key={t.id}
              layout
              initial={{ opacity: 0, y: 16, scale: 0.95 }}
              animate={{ opacity: 1, y: 0, scale: 1 }}
              exit={{ opacity: 0, scale: 0.9, transition: { duration: 0.15 } }}
              transition={{ type: 'spring', stiffness: 500, damping: 35 }}
              role={t.type === 'error' ? 'alert' : 'status'}
              className={`pointer-events-auto flex w-full max-w-sm items-start gap-3 rounded-lg border-l-4 border-y border-r border-y-zinc-950/10 border-r-zinc-950/10 bg-white p-3 shadow-lg dark:border-y-white/10 dark:border-r-white/10 dark:bg-zinc-900 ${BORDER_CLASS[t.type]}`}
            >
              <Text className="flex-1 text-sm text-zinc-950 dark:text-white">{t.message}</Text>
              <button
                type="button"
                onClick={() => dismiss(t.id)}
                aria-label="Dismiss"
                className="shrink-0 text-zinc-400 hover:text-zinc-600 dark:text-zinc-500 dark:hover:text-zinc-300"
              >
                &times;
              </button>
            </motion.div>
          ))}
        </AnimatePresence>
      </div>
    </ToastContext.Provider>
  )
}

// Local, dependency-free text node — avoids importing components/text.tsx's
// Link-aware Text just for styling, and keeps this file self-contained.
function Text({ className, children }: { className?: string; children: ReactNode }) {
  return <p className={className}>{children}</p>
}

export function useToast(): ToastContextValue {
  const ctx = useContext(ToastContext)
  if (!ctx) throw new Error('useToast must be used within a ToastProvider')
  return ctx
}
