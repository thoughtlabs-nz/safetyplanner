import { useState } from 'react'
import { useQuery } from 'convex/react'
import { api } from '../../../../convex/_generated/api'
import { Heading, Subheading } from '../components/heading'
import { Text } from '../components/text'
import { Button } from '../components/button'
import { Badge } from '../components/badge'
import { Table, TableHead, TableBody, TableRow, TableHeader, TableCell } from '../components/table'
import { Divider } from '../components/divider'
import { Timeline } from '../components/timeline'
import { useToast } from '../components/toast'
import { EVENT_TYPE_BADGE_COLOR, EVENT_TYPE_DOT_CLASS } from '../eventTypeColors'

const POLLER_URL = import.meta.env.VITE_POLLER_URL

function fileUrl(category: 'thumbnails', filePath: string): string {
  const filename = filePath.split(/[/\\]/).pop() ?? filePath
  return `${POLLER_URL}/files/${category}/${encodeURIComponent(filename)}`
}

export default function Dashboard() {
  const cameras = useQuery(api.cameras.list, {})
  const statuses = useQuery(api.cameraStatus.listAll, {})
  const [checking, setChecking] = useState(false)
  const { toast } = useToast()

  async function checkNow() {
    setChecking(true)
    try {
      const res = await fetch(`${POLLER_URL}/poll-now`, { method: 'POST' })
      if (!res.ok) {
        const body = await res.json().catch(() => ({}))
        throw new Error(body.error ?? `HTTP ${res.status}`)
      }
      toast('Poll started')
    } catch (err) {
      toast(
        err instanceof Error ? `Couldn't reach poller: ${err.message}` : "Couldn't reach poller",
        'error',
      )
    } finally {
      // The poll runs asynchronously on the poller; leave the button
      // disabled briefly so repeated clicks don't queue up requests.
      setTimeout(() => setChecking(false), 2000)
    }
  }

  return (
    <div>
      <Heading>Dashboard</Heading>

      <div className="mt-8">
        <Subheading>Camera Connection</Subheading>
        <Divider className="my-3" />
        {cameras === undefined || statuses === undefined ? (
          <Text>Loading...</Text>
        ) : cameras.length === 0 ? (
          <Text>No cameras registered yet. Add one on the Settings page.</Text>
        ) : (
          <div className="flex flex-col gap-2">
            {cameras.map((camera) => {
              const status = statuses.find((s) => s.cameraId === camera._id)
              return (
                <Text key={camera._id}>
                  <span
                    className={`mr-2 inline-block size-2.5 rounded-full ${status?.connected ? 'bg-green-500' : 'bg-red-500'}`}
                  />
                  <strong className="font-medium">{camera.name}</strong> —{' '}
                  {status === undefined
                    ? 'No status reported yet'
                    : status.connected
                      ? 'Connected'
                      : 'Disconnected'}
                  {status && <> — last poll {new Date(status.lastPollAt).toLocaleString()}</>}
                  {status?.lastError && <> — {status.lastError}</>}
                </Text>
              )
            })}
          </div>
        )}
        <div className="mt-4">
          <Button onClick={checkNow} disabled={checking}>
            {checking ? 'Checking…' : 'Check now'}
          </Button>
        </div>
      </div>

      <div className="mt-8">
        <Subheading>Recent Events</Subheading>
        <Divider className="my-3" />
        <EventTimeline />
        <RecentEvents />
      </div>

      <div className="mt-8">
        <Subheading>Activity</Subheading>
        <Divider className="my-3" />
        <ActivityLog />
      </div>
    </div>
  )
}

function EventTimeline() {
  const events = useQuery(api.events.recentWithThumbnails, { limit: 30 })

  if (events === undefined || events.length === 0) return null

  const sorted = events.slice().sort((a, b) => a.timestamp - b.timestamp)
  const minTime = sorted[0].timestamp
  const maxTime = sorted[sorted.length - 1].timestamp

  return (
    <div className="mb-4">
      <Timeline
        startTime={minTime}
        endTime={maxTime}
        markers={sorted.map((e) => ({
          key: e._id,
          timestamp: e.timestamp,
          colorClass: EVENT_TYPE_DOT_CLASS[e.type] ?? EVENT_TYPE_DOT_CLASS.other,
          title: `${e.type} — ${new Date(e.timestamp).toLocaleString()}`,
        }))}
        legend={Object.entries(EVENT_TYPE_DOT_CLASS).map(([type, dotColor]) => (
          <span key={type} className="flex items-center gap-1.5">
            <span className={`size-2 rounded-full ${dotColor}`} /> {type}
          </span>
        ))}
      />
    </div>
  )
}

function RecentEvents() {
  const events = useQuery(api.events.recentWithThumbnails, { limit: 10 })

  if (events === undefined) return <Text>Loading...</Text>
  if (events.length === 0) return <Text>No events recorded yet.</Text>

  return (
    <div className="flex flex-col gap-2">
      {events.map((e) => (
        <div key={e._id} className="flex items-center gap-3 py-1">
          {e.thumbnailUrl || e.thumbnailPath ? (
            <img
              src={e.thumbnailUrl ?? fileUrl('thumbnails', e.thumbnailPath!)}
              alt=""
              width={56}
              height={40}
              className="shrink-0 rounded object-cover"
            />
          ) : (
            <div className="size-10 w-14 shrink-0 rounded bg-zinc-950/10 dark:bg-white/10" />
          )}
          <Badge color={EVENT_TYPE_BADGE_COLOR[e.type] ?? EVENT_TYPE_BADGE_COLOR.other}>{e.type}</Badge>
          <Text>{new Date(e.timestamp).toLocaleString()}</Text>
        </div>
      ))}
    </div>
  )
}

const LEVEL_COLOR: Record<string, string> = {
  info: '',
  warn: 'text-orange-600 dark:text-orange-400',
  error: 'text-red-600 dark:text-red-500',
}

function ActivityLog() {
  const events = useQuery(api.pollEvents.recent, { limit: 10 })

  if (events === undefined) return <Text>Loading...</Text>
  if (events.length === 0) return <Text>No activity yet.</Text>

  return (
    <div>
      <Table dense>
        <TableHead>
          <TableRow>
            <TableHeader>Time</TableHeader>
            <TableHeader>Level</TableHeader>
            <TableHeader>Message</TableHeader>
            <TableHeader>Detail</TableHeader>
          </TableRow>
        </TableHead>
        <TableBody>
          {events.map((e) => (
            <TableRow key={e._id}>
              <TableCell>{new Date(e.timestamp).toLocaleTimeString()}</TableCell>
              <TableCell className={LEVEL_COLOR[e.level]}>{e.level}</TableCell>
              <TableCell>{e.message}</TableCell>
              <TableCell>{e.meta ?? ''}</TableCell>
            </TableRow>
          ))}
        </TableBody>
      </Table>
    </div>
  )
}
