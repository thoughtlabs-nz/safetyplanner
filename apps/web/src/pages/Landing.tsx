import { SignIn } from '@clerk/clerk-react'
import { Link } from '../components/link'

// Public homepage — shown to signed-out visitors at "/" (see
// RequireAuth.tsx). Required by Google OAuth verification: the app's
// homepage must explain what the app does and who publishes it (matching
// the OAuth consent screen's app name), without requiring sign-in, and link
// to the privacy policy.
export default function Landing() {
  return (
    <div className="min-h-svh bg-white dark:bg-zinc-950">
      <div className="mx-auto max-w-5xl px-6 py-16">
        <div className="flex items-center gap-2">
          <img src="/logo.png" alt="Safety Planner" width={28} height={28} className="rounded" />
          <span className="text-lg font-semibold text-zinc-950 dark:text-white">Safety Planner</span>
        </div>

        <div className="mt-12 grid grid-cols-1 gap-12 lg:grid-cols-2 lg:items-start">
          <div>
            <h1 className="text-3xl font-semibold tracking-tight text-zinc-950 sm:text-4xl dark:text-white">
              Automatic dashcam sync, journey tracking, and driving safety reports.
            </h1>
            <p className="mt-4 text-base text-zinc-600 dark:text-zinc-400">
              Safety Planner connects to your Wi-Fi dashcam(s) to automatically pull down
              recordings, GPS trip data, and accelerometer readings, then turns that into a map of
              everywhere you've driven, a searchable video/event library, and reporting on
              speeding, harsh braking, and impact events — all in one private dashboard for your
              account.
            </p>

            <ul className="mt-6 space-y-2 text-sm text-zinc-600 dark:text-zinc-400">
              <li>• Journeys mapped from your dashcam's GPS data, with speed and event overlays</li>
              <li>• Automatic recording, thumbnail, and GPS file sync from your camera(s)</li>
              <li>• Live vehicle tracking from your phone while driving</li>
              <li>• Fleet-wide reporting: distance, drive time, top speed, harsh-event history</li>
            </ul>

            <p className="mt-6 text-sm text-zinc-500 dark:text-zinc-500">
              Safety Planner is built and operated by Thoughtlabs NZ.{' '}
              <Link href="/privacy" className="underline">
                Privacy Policy
              </Link>
            </p>
          </div>

          <div className="flex justify-center lg:justify-end">
            <div className="w-full max-w-sm">
              <SignIn routing="hash" />
            </div>
          </div>
        </div>
      </div>
    </div>
  )
}
