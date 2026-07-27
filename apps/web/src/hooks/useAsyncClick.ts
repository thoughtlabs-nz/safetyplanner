import { useCallback, useRef, useState } from 'react'

// Wraps an async click/submit handler so rapid repeat clicks can't fire it
// again while the first call is still in flight — a ref-based guard (not
// just the returned `busy` state) so it's synchronous and can't be beaten
// by clicks landing before React re-renders with the disabled button.
export function useAsyncClick<Args extends unknown[]>(
  fn: (...args: Args) => Promise<void>,
): [(...args: Args) => void, boolean] {
  const [busy, setBusy] = useState(false)
  const busyRef = useRef(false)

  const run = useCallback(
    (...args: Args) => {
      // Always prevent default — even when the guard below skips the actual
      // call — otherwise a deduped duplicate form submission falls through
      // to the browser's native action (a full page reload) instead of
      // being a silent no-op.
      const maybeEvent = args[0] as { preventDefault?: () => void } | undefined
      maybeEvent?.preventDefault?.()

      if (busyRef.current) return
      busyRef.current = true
      setBusy(true)
      fn(...args).finally(() => {
        busyRef.current = false
        setBusy(false)
      })
    },
    [fn],
  )

  return [run, busy]
}
