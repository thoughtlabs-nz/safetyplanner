import { useQuery } from 'convex/react'
import { api } from '../../../../convex/_generated/api'
import { Heading, Subheading } from '../components/heading'
import { Text } from '../components/text'
import { Divider } from '../components/divider'
import { BarChart, HorizontalBarList } from '../components/barchart'

function formatDuration(seconds: number): string {
  const mins = Math.round(seconds / 60)
  if (mins < 60) return `${mins}m`
  const hrs = Math.floor(mins / 60)
  return `${hrs}h ${mins % 60}m`
}

function StatTile({ label, value, sub }: { label: string; value: string; sub?: string }) {
  return (
    <div className="rounded-lg border border-zinc-950/10 p-4 dark:border-white/10">
      <Text className="text-xs uppercase tracking-wide">{label}</Text>
      <div className="mt-1 text-2xl font-semibold text-zinc-950 dark:text-white">{value}</div>
      {sub && <Text className="mt-0.5 text-xs">{sub}</Text>}
    </div>
  )
}

function ReportCard({ title, subtitle, children }: { title: string; subtitle?: string; children: React.ReactNode }) {
  return (
    <div className="rounded-lg border border-zinc-950/10 p-4 dark:border-white/10">
      <Subheading>{title}</Subheading>
      {subtitle && <Text className="mt-0.5">{subtitle}</Text>}
      <Divider className="my-3" />
      {children}
    </div>
  )
}

const HOUR_LABELS = Array.from({ length: 24 }, (_, h) => (h % 3 === 0 ? `${h}` : ''))

export default function Reporting() {
  const overview = useQuery(api.reports.overview, {})
  const perCamera = useQuery(api.reports.perCamera, {})
  const dailyDistance = useQuery(api.reports.dailyDistance, { days: 14 })
  const hourOfDay = useQuery(api.reports.hourOfDayDistribution, {})
  const topLocations = useQuery(api.reports.topLocations, { limit: 6 })

  return (
    <div>
      <Heading>Reporting</Heading>
      <Text className="mt-1">Insights and trends across everything your camera(s) have recorded.</Text>

      {/* Overview */}
      <div className="mt-6">
        <Subheading>Overview</Subheading>
        <Divider className="my-3" />
        {overview === undefined ? (
          <Text>Loading...</Text>
        ) : (
          <div className="grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-6">
            <StatTile label="Total distance" value={`${overview.totalDistanceKm.toFixed(1)} km`} />
            <StatTile label="Total trips" value={String(overview.totalTrips)} />
            <StatTile label="Driving time" value={formatDuration(overview.totalDrivingSeconds)} />
            <StatTile label="Top speed" value={`${overview.maxSpeedKmh.toFixed(0)} km/h`} />
            <StatTile
              label="Peak G-force"
              value={`${overview.peakG.toFixed(2)}g`}
              sub={overview.peakG >= 1.5 ? 'Harsh event recorded' : undefined}
            />
            <StatTile label="Total events" value={String(overview.totalEvents)} />
          </div>
        )}
      </div>

      {/* Vehicles */}
      <div className="mt-8">
        <Subheading>Vehicles</Subheading>
        <Divider className="my-3" />
        {perCamera === undefined ? (
          <Text>Loading...</Text>
        ) : perCamera.length === 0 ? (
          <Text>No cameras registered yet. Add one on the Settings page.</Text>
        ) : (
          <div className="grid grid-cols-1 gap-4 md:grid-cols-2">
            {perCamera.map((c) => (
              <div key={c.cameraId ?? 'unassigned'} className="rounded-lg border border-zinc-950/10 p-4 dark:border-white/10">
                <div className="flex items-center justify-between">
                  <div className="flex items-center gap-2">
                    <span
                      className={`size-2.5 rounded-full ${c.connected ? 'bg-green-500' : 'bg-red-500'}`}
                    />
                    <span className="font-medium text-zinc-950 dark:text-white">{c.name}</span>
                  </div>
                  <Text className="text-xs">
                    {c.lastSeenAt ? `Last seen ${new Date(c.lastSeenAt).toLocaleString()}` : 'Never seen'}
                  </Text>
                </div>
                <div className="mt-4 grid grid-cols-3 gap-3 sm:grid-cols-4">
                  <div>
                    <Text className="text-xs">Trips</Text>
                    <div className="font-semibold text-zinc-950 dark:text-white">{c.tripCount}</div>
                  </div>
                  <div>
                    <Text className="text-xs">Distance</Text>
                    <div className="font-semibold text-zinc-950 dark:text-white">
                      {c.totalDistanceKm.toFixed(1)} km
                    </div>
                  </div>
                  <div>
                    <Text className="text-xs">Drive time</Text>
                    <div className="font-semibold text-zinc-950 dark:text-white">
                      {formatDuration(c.totalDrivingSeconds)}
                    </div>
                  </div>
                  <div>
                    <Text className="text-xs">Max speed</Text>
                    <div className="font-semibold text-zinc-950 dark:text-white">
                      {c.maxSpeedKmh.toFixed(0)} km/h
                    </div>
                  </div>
                  <div>
                    <Text className="text-xs">Avg speed</Text>
                    <div className="font-semibold text-zinc-950 dark:text-white">
                      {c.avgSpeedKmh.toFixed(0)} km/h
                    </div>
                  </div>
                  <div>
                    <Text className="text-xs">Peak G</Text>
                    <div
                      className={`font-semibold ${c.peakG >= 1.5 ? 'text-red-600 dark:text-red-500' : 'text-zinc-950 dark:text-white'}`}
                    >
                      {c.peakG > 0 ? `${c.peakG.toFixed(2)}g` : '—'}
                    </div>
                  </div>
                  <div>
                    <Text className="text-xs">Recordings</Text>
                    <div className="font-semibold text-zinc-950 dark:text-white">{c.recordingCount}</div>
                  </div>
                  <div>
                    <Text className="text-xs">Events</Text>
                    <div className="font-semibold text-zinc-950 dark:text-white">{c.eventCount}</div>
                  </div>
                </div>
              </div>
            ))}
          </div>
        )}
      </div>

      {/* Trends */}
      <div className="mt-8 grid grid-cols-1 gap-4 lg:grid-cols-2">
        <ReportCard title="Distance driven" subtitle="Last 14 days">
          {dailyDistance === undefined ? (
            <Text>Loading...</Text>
          ) : dailyDistance.every((d) => d.distanceKm === 0) ? (
            <Text>No trips in the last 14 days.</Text>
          ) : (
            <BarChart
              color="blue"
              data={dailyDistance.map((d) => ({
                label: new Date(d.day).toLocaleDateString([], { weekday: 'narrow' }),
                value: d.distanceKm,
                title: `${new Date(d.day).toLocaleDateString()}: ${d.distanceKm.toFixed(2)} km, ${d.tripCount} trip${d.tripCount === 1 ? '' : 's'}`,
              }))}
              valueFormat={(v) => `${v.toFixed(1)} km`}
            />
          )}
        </ReportCard>

        <ReportCard title="When you drive" subtitle="Trips by hour of day">
          {hourOfDay === undefined ? (
            <Text>Loading...</Text>
          ) : hourOfDay.every((h) => h.count === 0) ? (
            <Text>No trips recorded yet.</Text>
          ) : (
            <BarChart
              color="orange"
              data={hourOfDay.map((h, i) => ({
                label: HOUR_LABELS[i],
                value: h.count,
                title: `${h.hour}:00–${h.hour}:59 — ${h.count} trip${h.count === 1 ? '' : 's'}`,
              }))}
              valueFormat={(v) => `${v} trip${v === 1 ? '' : 's'}`}
            />
          )}
        </ReportCard>

        <ReportCard title="Events by type">
          {overview === undefined ? (
            <Text>Loading...</Text>
          ) : Object.keys(overview.eventsByType).length === 0 ? (
            <Text>No events recorded yet.</Text>
          ) : (
            <HorizontalBarList
              color="red"
              data={Object.entries(overview.eventsByType)
                .sort((a, b) => b[1] - a[1])
                .map(([type, count]) => ({
                  label: type,
                  value: count,
                  title: `${type}: ${count}`,
                }))}
            />
          )}
        </ReportCard>

        <ReportCard title="Most visited locations" subtitle="From trip start/end points">
          {topLocations === undefined ? (
            <Text>Loading...</Text>
          ) : topLocations.length === 0 ? (
            <Text>No locations resolved yet.</Text>
          ) : (
            <HorizontalBarList
              color="teal"
              data={topLocations.map((l) => ({ label: l.location, value: l.count }))}
            />
          )}
        </ReportCard>
      </div>
    </div>
  )
}
