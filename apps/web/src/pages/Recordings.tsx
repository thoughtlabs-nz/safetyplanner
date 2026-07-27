import { useMemo, useState } from 'react'
import { useMutation, useQuery } from 'convex/react'
import { api } from '../../../../convex/_generated/api'
import type { Doc, Id } from '../../../../convex/_generated/dataModel'
import { Heading } from '../components/heading'
import { Text } from '../components/text'
import { Button } from '../components/button'
import { Badge } from '../components/badge'
import { Input } from '../components/input'
import { Select } from '../components/select'
import { Table, TableHead, TableBody, TableRow, TableHeader, TableCell } from '../components/table'
import { useAsyncClick } from '../hooks/useAsyncClick'

type Kind = 'continuous' | 'timelapse' | 'event'
type StatusFilter = 'all' | 'available' | 'pending'

const POLLER_URL = import.meta.env.VITE_POLLER_URL
const PAGE_SIZE = 25

function basename(filePath: string): string {
  return filePath.split(/[/\\]/).pop() ?? filePath
}

function fileUrl(category: 'videos' | 'gps' | 'thumbnails', filePath: string): string {
  return `${POLLER_URL}/files/${category}/${encodeURIComponent(basename(filePath))}`
}

function formatDuration(seconds: number): string {
  const mins = Math.round(seconds / 60)
  if (mins < 60) return `${mins}m`
  return `${Math.floor(mins / 60)}h ${mins % 60}m`
}

// A recording has no direct link to a journey (see convex/journeys.ts) — this
// matches the same overlap logic as recordings.forCameraTimeRange, just done
// client-side since we already have both lists loaded here.
const MAX_RECORDING_DURATION_SECONDS = 60 * 60

function journeyKey(cameraId: Id<'cameras'> | undefined, startTime: number, endTime: number): string {
  return `${cameraId ?? 'none'}|${startTime}|${endTime}`
}

function matchJourney<J extends { cameraId?: Id<'cameras'>; startTime: number; endTime: number }>(
  recording: Doc<'recordings'>,
  journeys: J[],
): J | undefined {
  const recordingEnd = recording.startTime + (recording.durationSeconds ?? 0) * 1000
  return journeys.find((j) => {
    if (j.cameraId !== recording.cameraId) return false
    if (recording.startTime - j.endTime > MAX_RECORDING_DURATION_SECONDS * 1000) return false
    return recordingEnd >= j.startTime && recording.startTime <= j.endTime
  })
}

export default function Recordings() {
  const [kind, setKind] = useState<Kind | undefined>(undefined)
  const [status, setStatus] = useState<StatusFilter>('all')
  const [search, setSearch] = useState('')
  const [pageCount, setPageCount] = useState(1)
  const [showGpsFiles, setShowGpsFiles] = useState(false)
  const [expandedGroups, setExpandedGroups] = useState<Set<string>>(new Set())

  const recordings = useQuery(api.recordings.list, { kind, limit: pageCount * PAGE_SIZE + 1 })
  const journeys = useQuery(api.journeys.list, { limit: 5000 })
  const activeDownloads = useQuery(api.downloadProgress.active, {})

  const progressByFilename = new Map((activeDownloads ?? []).map((d) => [d.filename, d]))

  const filtered = useMemo(() => {
    if (!recordings) return undefined
    return recordings.filter((r) => {
      if (search && !r.filename.toLowerCase().includes(search.toLowerCase())) return false
      if (status === 'available' && r.status !== 'downloaded') return false
      if (status === 'pending' && r.status === 'downloaded') return false
      return true
    })
  }, [recordings, search, status])

  const hasMore = (recordings?.length ?? 0) > pageCount * PAGE_SIZE
  const visible = filtered?.slice(0, pageCount * PAGE_SIZE)

  const groups = useMemo(() => {
    if (!visible || !journeys) return undefined

    const byKey = new Map<
      string,
      { journey: (typeof journeys)[number] | undefined; recordings: Doc<'recordings'>[] }
    >()
    for (const r of visible) {
      const journey = matchJourney(r, journeys)
      const key = journey
        ? journeyKey(journey.cameraId, journey.startTime, journey.endTime)
        : 'ungrouped'
      const existing = byKey.get(key)
      if (existing) existing.recordings.push(r)
      else byKey.set(key, { journey, recordings: [r] })
    }

    return [...byKey.values()].sort((a, b) => {
      if (!a.journey) return 1
      if (!b.journey) return -1
      return b.journey.startTime - a.journey.startTime
    })
  }, [visible, journeys])

  function toggleGroup(key: string) {
    setExpandedGroups((prev) => {
      const next = new Set(prev)
      if (next.has(key)) next.delete(key)
      else next.add(key)
      return next
    })
  }

  return (
    <div>
      <Heading>Recordings</Heading>

      <div className="mt-6 flex flex-wrap items-center gap-3">
        <Select
          className="max-w-40"
          value={kind ?? 'all'}
          onChange={(e) => {
            setKind(e.target.value === 'all' ? undefined : (e.target.value as Kind))
            setPageCount(1)
          }}
        >
          <option value="all">All kinds</option>
          <option value="continuous">Continuous</option>
          <option value="timelapse">Timelapse</option>
          <option value="event">Event</option>
        </Select>

        <Select
          className="max-w-40"
          value={status}
          onChange={(e) => {
            setStatus(e.target.value as StatusFilter)
            setPageCount(1)
          }}
        >
          <option value="all">Any status</option>
          <option value="available">Downloaded</option>
          <option value="pending">Not downloaded</option>
        </Select>

        <Input
          type="text"
          className="max-w-64"
          placeholder="Search filename…"
          value={search}
          onChange={(e) => setSearch(e.target.value)}
        />
      </div>

      <div className="mt-6 space-y-3">
        {groups === undefined ? (
          <Text>Loading...</Text>
        ) : groups.length === 0 ? (
          <Text>No recordings match these filters.</Text>
        ) : (
          <>
            {groups.map((g) => {
              const key = g.journey
                ? journeyKey(g.journey.cameraId, g.journey.startTime, g.journey.endTime)
                : 'ungrouped'
              const expanded = expandedGroups.has(key)
              return (
                <div key={key} className="rounded-lg border border-zinc-950/10 dark:border-white/10">
                  <button
                    type="button"
                    onClick={() => toggleGroup(key)}
                    className="flex w-full items-center justify-between gap-3 p-3 text-left"
                  >
                    <div>
                      <Text className="font-medium text-zinc-950 dark:text-white">
                        {g.journey
                          ? new Date(g.journey.startTime).toLocaleString()
                          : 'Not linked to a journey'}
                      </Text>
                      <Text className="text-sm">
                        {g.journey &&
                          `${g.journey.distanceKm.toFixed(2)} km · ${formatDuration(g.journey.durationSeconds)} · `}
                        {g.recordings.length} recording{g.recordings.length === 1 ? '' : 's'}
                      </Text>
                    </div>
                    <span className="text-zinc-500 dark:text-zinc-400">{expanded ? '▾' : '▸'}</span>
                  </button>
                  {expanded && (
                    <div className="border-t border-zinc-950/10 p-3 dark:border-white/10">
                      <Table dense>
                        <TableHead>
                          <TableRow>
                            <TableHeader></TableHeader>
                            <TableHeader>Filename</TableHeader>
                            <TableHeader>Kind</TableHeader>
                            <TableHeader>Start</TableHeader>
                            <TableHeader>Duration</TableHeader>
                            <TableHeader>Status</TableHeader>
                            <TableHeader>GPS</TableHeader>
                          </TableRow>
                        </TableHead>
                        <TableBody>
                          {g.recordings.map((r) => (
                            <RecordingRow
                              key={r._id}
                              recording={r}
                              progress={progressByFilename.get(r.filename)}
                            />
                          ))}
                        </TableBody>
                      </Table>
                    </div>
                  )}
                </div>
              )
            })}
            {hasMore && (
              <div className="mt-3">
                <Button plain onClick={() => setPageCount((c) => c + 1)}>
                  Load more
                </Button>
              </div>
            )}
          </>
        )}
      </div>

      <div className="mt-8">
        <Button plain onClick={() => setShowGpsFiles((v) => !v)}>
          {showGpsFiles ? 'Hide' : 'Show'} raw GPS files
        </Button>
        {showGpsFiles && <GpsFilesCard />}
      </div>
    </div>
  )
}

const STATUS_LABEL: Record<Doc<'recordings'>['status'], string> = {
  listed: 'Not downloaded',
  queued: 'Queued',
  downloading: 'Downloading',
  downloaded: 'Downloaded',
  failed: 'Failed',
}

function RecordingRow({
  recording: r,
  progress,
}: {
  // recordings.list decorates each doc with a resolved Convex-storage URL.
  recording: Doc<'recordings'> & { thumbnailUrl?: string }
  progress: Doc<'downloadProgress'> | undefined
}) {
  const requestDownloadMutation = useMutation(api.recordings.requestDownload)
  const [requestDownload, requesting] = useAsyncClick(async () => {
    await requestDownloadMutation({ id: r._id })
  })

  return (
    <TableRow>
      <TableCell>
        {r.thumbnailUrl || r.thumbnailPath ? (
          <a href={r.thumbnailUrl ?? fileUrl('thumbnails', r.thumbnailPath!)} target="_blank" rel="noreferrer">
            <img src={r.thumbnailUrl ?? fileUrl('thumbnails', r.thumbnailPath!)} alt="" width={48} className="block rounded" />
          </a>
        ) : (
          <div className="h-8 w-12" />
        )}
      </TableCell>
      <TableCell>{r.filename}</TableCell>
      <TableCell>{r.kind}</TableCell>
      <TableCell>{new Date(r.startTime).toLocaleString()}</TableCell>
      <TableCell>{r.durationSeconds ? `${r.durationSeconds}s` : '-'}</TableCell>
      <TableCell>
        <VideoCell
          recording={r}
          progress={progress}
          onRequestDownload={requestDownload}
          requesting={requesting}
        />
      </TableCell>
      <TableCell>
        <GpsLinks recordingId={r._id} />
      </TableCell>
    </TableRow>
  )
}

function VideoCell({
  recording: r,
  progress,
  onRequestDownload,
  requesting,
}: {
  recording: Doc<'recordings'>
  progress: Doc<'downloadProgress'> | undefined
  onRequestDownload: () => void
  requesting: boolean
}) {
  if (r.status === 'downloaded' && r.filePath) {
    return (
      <a href={fileUrl('videos', r.filePath)} target="_blank" rel="noreferrer">
        <Badge color="green">Downloaded</Badge>
      </a>
    )
  }

  if (r.status === 'downloading') {
    const pct = progress?.totalBytes
      ? Math.round((progress.bytesReceived / progress.totalBytes) * 100)
      : undefined
    return (
      <Badge color="blue">
        {pct !== undefined ? `${pct}%` : STATUS_LABEL.downloading}
        {progress?.bytesPerSecond !== undefined &&
          ` · ${(progress.bytesPerSecond / 1_000).toFixed(0)}KB/s`}
      </Badge>
    )
  }

  if (r.status === 'queued') {
    return <Badge color="yellow">{STATUS_LABEL.queued}</Badge>
  }

  if (r.status === 'failed') {
    return (
      <Button color="red" onClick={onRequestDownload} disabled={requesting} title={r.error}>
        Retry
      </Button>
    )
  }

  return (
    <Button outline onClick={onRequestDownload} disabled={requesting}>
      Download
    </Button>
  )
}

function GpsFilesCard() {
  const gpsFiles = useQuery(api.gpsFiles.listAll, { limit: 100 })

  return (
    <div className="mt-3">
      <Text>
        The camera doesn't reliably link GPS files to a specific recording, so these are
        listed independently.
      </Text>
      {gpsFiles === undefined ? (
        <Text>Loading...</Text>
      ) : gpsFiles.length === 0 ? (
        <Text>No GPS files downloaded yet.</Text>
      ) : (
        <div className="mt-3 max-h-70 overflow-y-auto">
          <Table dense>
            <TableHead>
              <TableRow>
                <TableHeader>Filename</TableHeader>
                <TableHeader>Parsed</TableHeader>
                <TableHeader>Linked</TableHeader>
                <TableHeader>Max G</TableHeader>
                <TableHeader>Downloaded</TableHeader>
                <TableHeader>File</TableHeader>
              </TableRow>
            </TableHead>
            <TableBody>
              {gpsFiles.map((g) => (
                <TableRow key={g._id}>
                  <TableCell>{g.filename}</TableCell>
                  <TableCell>{g.parsed ? 'Yes' : 'No'}</TableCell>
                  <TableCell>{g.recordingId ? 'Yes' : '-'}</TableCell>
                  <TableCell>
                    {g.peakG == null ? (
                      '-'
                    ) : (
                      <span className={g.peakG > 1.5 ? 'font-semibold text-red-600 dark:text-red-500' : ''}>
                        {g.peakG.toFixed(2)}g
                      </span>
                    )}
                  </TableCell>
                  <TableCell>{new Date(g.downloadedAt).toLocaleString()}</TableCell>
                  <TableCell>
                    {g.filePath ? (
                      <a
                        href={fileUrl('gps', g.filePath)}
                        target="_blank"
                        rel="noreferrer"
                        className="text-zinc-950 underline decoration-zinc-950/50 hover:decoration-zinc-950 dark:text-white dark:decoration-white/50 dark:hover:decoration-white"
                      >
                        Download
                      </a>
                    ) : (
                      <span className="text-zinc-500 dark:text-zinc-400">Deleted (parsed)</span>
                    )}
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </div>
      )}
    </div>
  )
}

function GpsLinks({ recordingId }: { recordingId: Id<'recordings'> }) {
  const gpsFiles = useQuery(api.gpsFiles.listForRecording, { recordingId })

  if (gpsFiles === undefined) return <span>...</span>
  if (gpsFiles.length === 0) return <span>-</span>

  return (
    <>
      {gpsFiles.map((g, i) => (
        <span key={g._id}>
          {i > 0 && ', '}
          {g.filePath ? (
            <a
              href={fileUrl('gps', g.filePath)}
              target="_blank"
              rel="noreferrer"
              className="text-zinc-950 underline decoration-zinc-950/50 hover:decoration-zinc-950 dark:text-white dark:decoration-white/50 dark:hover:decoration-white"
            >
              {g.parsed ? 'GPS' : 'GPS (raw)'}
            </a>
          ) : (
            <span className="text-zinc-500 dark:text-zinc-400">GPS (parsed)</span>
          )}
        </span>
      ))}
    </>
  )
}
