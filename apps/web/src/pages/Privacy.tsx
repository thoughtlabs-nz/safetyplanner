import { Link } from '../components/link'

// Standalone, always-public page (see App.tsx — routed outside the
// RequireAuth/Landing gate) — required by Google's OAuth verification: the
// link configured on the consent screen must resolve to real, hosted-on-
// our-own-domain content, reachable without signing in.
//
// NOTE: this is a first draft covering what the codebase actually does
// (dashcam recordings/GPS/accelerometer data, Clerk auth incl. Google
// sign-in, Convex storage, MQTT relay, Overpass speed-limit lookups). It
// has NOT been reviewed by a lawyer — read it over and adjust company
// details/wording before relying on it for verification or publishing it
// as a binding policy.
export default function Privacy() {
  return (
    <div className="mx-auto max-w-2xl px-6 py-16">
      <Link href="/" className="text-sm text-zinc-500 hover:text-zinc-700 dark:text-zinc-400 dark:hover:text-zinc-200">
        ← Safety Planner
      </Link>

      <h1 className="mt-6 text-2xl font-semibold text-zinc-950 dark:text-white">Privacy Policy</h1>
      <p className="mt-1 text-sm text-zinc-500 dark:text-zinc-400">Last updated: {new Date().toLocaleDateString()}</p>

      <div className="mt-8 space-y-6 text-sm leading-6 text-zinc-700 dark:text-zinc-300">
        <p>
          Safety Planner is operated by Thoughtlabs NZ ("we", "us"). This policy explains what
          information the app collects, why, and how it's used when you sign in and connect your
          dashcam(s) to your account.
        </p>

        <section>
          <h2 className="font-medium text-zinc-950 dark:text-white">Information we collect</h2>
          <ul className="mt-2 list-disc space-y-1 pl-5">
            <li>
              <strong>Account information</strong> — your name and email address, provided by
              whichever sign-in method you choose (including Google Sign-In). We don't receive or
              store your Google password.
            </li>
            <li>
              <strong>Dashcam recordings and thumbnails</strong> — video clips and event
              thumbnails downloaded from cameras you've registered to your account.
            </li>
            <li>
              <strong>GPS and trip data</strong> — location, speed, and heading recorded by your
              dashcam(s) (and, if you enable live tracking, by your phone's GPS) while driving.
            </li>
            <li>
              <strong>Accelerometer / g-force data</strong> — motion data recorded by your
              dashcam(s) and, during live tracking, your phone, used to detect harsh driving
              events and impacts.
            </li>
            <li>
              <strong>Camera connection details</strong> — Wi-Fi and MQTT credentials needed to
              connect to and sync data from your registered camera(s).
            </li>
          </ul>
        </section>

        <section>
          <h2 className="font-medium text-zinc-950 dark:text-white">Why we collect it</h2>
          <p className="mt-2">
            This data is used solely to provide the app's core functionality to you: syncing and
            storing your dashcam footage, reconstructing and displaying your journeys on a map,
            and surfacing safety-related reporting (speeding, harsh braking/acceleration, impact
            events) for vehicles and accounts you control. We do not use your data for
            advertising, and we do not sell it.
          </p>
        </section>

        <section>
          <h2 className="font-medium text-zinc-950 dark:text-white">Where it's stored / who processes it</h2>
          <ul className="mt-2 list-disc space-y-1 pl-5">
            <li>
              <strong>Convex</strong> — our application database and file storage provider, hosting
              your account data, trip data, and recording/thumbnail files.
            </li>
            <li>
              <strong>Clerk</strong> — our authentication provider, handling sign-in (including
              Google Sign-In) and issuing the session used to access your account.
            </li>
            <li>
              <strong>MQTT broker</strong> — relays data from the mobile app / poller to our
              backend during sync; it does not retain your data after delivery.
            </li>
            <li>
              <strong>OpenStreetMap Overpass API</strong> — used to look up posted speed limits
              near your trips' GPS coordinates; only anonymous coordinate queries are sent, no
              account or personal information.
            </li>
          </ul>
        </section>

        <section>
          <h2 className="font-medium text-zinc-950 dark:text-white">Data retention and deletion</h2>
          <p className="mt-2">
            GPS and accelerometer data is automatically thinned and eventually deleted on a
            schedule configurable in the app's Settings. You can delete individual journeys
            (and their underlying recordings/GPS data) directly from the app, or contact us to
            request deletion of your account and all associated data.
          </p>
        </section>

        <section>
          <h2 className="font-medium text-zinc-950 dark:text-white">Sharing</h2>
          <p className="mt-2">
            We don't share your data with third parties except the service providers listed
            above, each acting solely to help us operate the app on your behalf. We don't sell or
            rent your data to anyone.
          </p>
        </section>

        <section>
          <h2 className="font-medium text-zinc-950 dark:text-white">Contact</h2>
          <p className="mt-2">
            Questions, or requests to access/delete your data — email{' '}
            <a href="mailto:tim.jackson@thoughtlabs.co.nz" className="underline">
              tim.jackson@thoughtlabs.co.nz
            </a>
            .
          </p>
        </section>
      </div>
    </div>
  )
}
