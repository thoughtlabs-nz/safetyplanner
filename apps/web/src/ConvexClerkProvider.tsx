import { useCallback, useMemo, type ReactNode } from 'react'
import { useAuth as useClerkAuth } from '@clerk/clerk-react'
import { ConvexProviderWithAuth, type ConvexReactClient } from 'convex/react'

// convex/react-clerk's ConvexProviderWithClerk has a shortcut: once Clerk's
// sessionClaims already report aud === "convex" (left over from an earlier
// templated fetch), it calls getToken() *without* re-specifying
// `template: "convex"`, assuming Clerk keeps serving the templated token by
// default. That assumption doesn't always hold and can silently hand back a
// token missing our custom `role` claim (aud still matches, so Convex
// accepts the token, but requireAdmin then fails). Always passing the
// template explicitly sidesteps the shortcut entirely.
function useAuthForConvex() {
  const { isLoaded, isSignedIn, getToken, orgId, orgRole, sessionId } = useClerkAuth()

  const fetchAccessToken = useCallback(
    async ({ forceRefreshToken }: { forceRefreshToken: boolean }) => {
      try {
        return await getToken({ template: 'convex', skipCache: forceRefreshToken })
      } catch {
        return null
      }
    },
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [orgId, orgRole, sessionId],
  )

  return useMemo(
    () => ({ isLoading: !isLoaded, isAuthenticated: isSignedIn ?? false, fetchAccessToken }),
    [isLoaded, isSignedIn, fetchAccessToken],
  )
}

export function ConvexClerkProvider({
  client,
  children,
}: {
  client: ConvexReactClient
  children: ReactNode
}) {
  return (
    <ConvexProviderWithAuth client={client} useAuth={useAuthForConvex}>
      {children}
    </ConvexProviderWithAuth>
  )
}
