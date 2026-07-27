import type { ReactNode } from 'react'
import { SignedIn, SignedOut } from '@clerk/clerk-react'
import Landing from '../pages/Landing'

export function RequireAuth({ children }: { children: ReactNode }) {
  return (
    <>
      {/* Landing (not a bare sign-in box) so any URL a signed-out visitor
          lands on — including "/", Google's on-file homepage — explains
          the app and links to the privacy policy, per OAuth verification
          requirements. */}
      <SignedOut>
        <Landing />
      </SignedOut>
      <SignedIn>{children}</SignedIn>
    </>
  )
}
