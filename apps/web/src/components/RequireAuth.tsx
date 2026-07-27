import type { ReactNode } from 'react'
import { SignedIn, SignedOut, SignIn } from '@clerk/clerk-react'

export function RequireAuth({ children }: { children: ReactNode }) {
  return (
    <>
      <SignedOut>
        <div className="flex min-h-svh items-center justify-center">
          <SignIn routing="hash" />
        </div>
      </SignedOut>
      <SignedIn>{children}</SignedIn>
    </>
  )
}
