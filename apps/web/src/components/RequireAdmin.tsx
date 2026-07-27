import type { ReactNode } from 'react'
import { Navigate } from 'react-router-dom'
import { useUser } from '@clerk/clerk-react'

export function RequireAdmin({ children }: { children: ReactNode }) {
  const { user, isLoaded } = useUser()
  if (!isLoaded) return null
  if (user?.publicMetadata?.role !== 'admin') {
    return <Navigate to="/" replace />
  }
  return <>{children}</>
}
