import { useEffect, useMemo, useRef, useState, type ReactNode } from 'react'
import { MapContainer, TileLayer, Polyline, CircleMarker, Marker, Popup, useMap } from 'react-leaflet'
import { divIcon } from 'leaflet'
import { useAction, useQuery } from 'convex/react'
import { api } from '../../../../convex/_generated/api'
import { Heading, Subheading } from '../components/heading'
import { Text } from '../components/text'
import { Button } from '../components/button'
import { Divider } from '../components/divider'
import { Table, TableHead, TableBody, TableRow, TableHeader, TableCell } from '../components/table'
import { Select } from '../components/select'
import { Badge } from '../components/badge'
import { Timeline, type TimelineMarker } from '../components/timeline'
import { Dialog, DialogTitle, DialogDescription, DialogBody, DialogActions } from '../components/dialog'
import { useToast } from '../components/toast'
import { EVENT_TYPE_HEX, EVENT_TYPE_DOT_CLASS, EVENT_TYPE_BADGE_COLOR } from '../eventTypeColors'

const POLLER_URL = import.meta.env.VITE_POLLER_URL

function thumbnailUrl(filePath: string): string {
  const filename = filePath.split(/[/\\]/).pop() ?? filePath
  return `${POLLER_URL}/files/thumbnails/${encodeURIComponent(filename)}`
}
import 'leaflet/dist/leaflet.css'

const DEFAULT_CENTER: [number, number] = [-36.8485, 174.7633] // Auckland, NZ

// There's no standard "green flag" emoji (🚩 is red), so start is a small
// inline SVG instead — matches the motorsport green-flag-start /
// checkered-flag-finish convention.
const GREEN_FLAG_SVG =
  '<svg width="16" height="16" viewBox="0 0 16 16" xmlns="http://www.w3.org/2000/svg">' +
  '<line x1="3" y1="1" x2="3" y2="15" stroke="#52525b" stroke-width="1.5"/>' +
  '<path d="M3 2 L13 5 L3 8 Z" fill="#16a34a"/>' +
  '</svg>'

function GreenFlagIcon() {
  return <span dangerouslySetInnerHTML={{ __html: GREEN_FLAG_SVG }} />
}

// Emoji-based markers avoid Leaflet's default icon assets, whose image URLs
// break under most bundlers (a well-known react-leaflet pitfall).
const START_ICON = divIcon({
  html: `<div style="filter:drop-shadow(0 1px 1px rgba(0,0,0,0.6))">${GREEN_FLAG_SVG}</div>`,
  className: '',
  iconSize: [16, 16],
  iconAnchor: [3, 15],
})
const FINISH_ICON = divIcon({
  html: '<div style="font-size:22px;line-height:22px;filter:drop-shadow(0 1px 1px rgba(0,0,0,0.6))">🏁</div>',
  className: '',
  iconSize: [22, 22],
  iconAnchor: [4, 20],
})

function speedColor(speedKmh: number | undefined): string {
  if (speedKmh === undefined) return '#3498db'
  if (speedKmh < 20) return '#2ecc71'
  if (speedKmh < 50) return '#f1c40f'
  if (speedKmh < 80) return '#e67e22'
  return '#e74c3c'
}

interface Fix {
  timestamp: number
  lat: number
  lng: number
  speedKmh?: number
}

interface SpeedLimitWay {
  maxspeedKmh: number | undefined
  points: [number, number][]
}

function pointToSegmentDistanceSq(p: [number, number], a: [number, number], b: [number, number]): number {
  const [px, py] = p
  const [ax, ay] = a
  const [bx, by] = b
  const dx = bx - ax
  const dy = by - ay
  if (dx === 0 && dy === 0) {
    return (px - ax) ** 2 + (py - ay) ** 2
  }
  const t = Math.max(0, Math.min(1, ((px - ax) * dx + (py - ay) * dy) / (dx * dx + dy * dy)))
  const projX = ax + t * dx
  const projY = ay + t * dy
  return (px - projX) ** 2 + (py - projY) ** 2
}

// Grid cell size in degrees (~300m at mid-latitudes) — segments are indexed
// by the cells their endpoints fall in, so a fix only needs to check
// candidates from its own cell + 8 neighbors instead of every OSM segment
// citywide. This turns assignSpeedLimits from O(fixes × segments) into
// roughly O(fixes × segments-per-cell), which is what made large trips slow.
const GRID_CELL_SIZE = 0.003

interface IndexedSegment {
  a: [number, number]
  b: [number, number]
  maxspeedKmh: number
}

function cellKey(lat: number, lng: number): string {
  return `${Math.floor(lat / GRID_CELL_SIZE)},${Math.floor(lng / GRID_CELL_SIZE)}`
}

function buildSegmentGrid(ways: SpeedLimitWay[]): Map<string, IndexedSegment[]> {
  const grid = new Map<string, IndexedSegment[]>()
  const addTo = (key: string, seg: IndexedSegment) => {
    const existing = grid.get(key)
    if (existing) existing.push(seg)
    else grid.set(key, [seg])
  }

  for (const way of ways) {
    if (way.maxspeedKmh === undefined) continue
    for (let i = 1; i < way.points.length; i++) {
      const a = way.points[i - 1]
      const b = way.points[i]
      const seg: IndexedSegment = { a, b, maxspeedKmh: way.maxspeedKmh }
      // Register the segment under both endpoint cells (and dedupe via a
      // Set of keys) so a lookup from either end's neighborhood finds it.
      const keys = new Set([cellKey(a[0], a[1]), cellKey(b[0], b[1])])
      for (const key of keys) addTo(key, seg)
    }
  }
  return grid
}

function assignSpeedLimits(fixes: Fix[], ways: SpeedLimitWay[]): (number | undefined)[] {
  const grid = buildSegmentGrid(ways)

  return fixes.map((fix) => {
    const p: [number, number] = [fix.lat, fix.lng]
    const cellLat = Math.floor(fix.lat / GRID_CELL_SIZE)
    const cellLng = Math.floor(fix.lng / GRID_CELL_SIZE)

    let bestLimit: number | undefined
    let bestDist = Infinity
    // 3x3 neighborhood is enough since segments are only ~street-block
    // length and registered under both endpoint cells.
    for (let dLat = -1; dLat <= 1; dLat++) {
      for (let dLng = -1; dLng <= 1; dLng++) {
        const candidates = grid.get(`${cellLat + dLat},${cellLng + dLng}`)
        if (!candidates) continue
        for (const seg of candidates) {
          const d = pointToSegmentDistanceSq(p, seg.a, seg.b)
          if (d < bestDist) {
            bestDist = d
            bestLimit = seg.maxspeedKmh
          }
        }
      }
    }
    return bestLimit
  })
}

interface AccelBucket {
  timestamp: number
  maxG: number
}

// Same idea as speedColor, but for accelerometer magnitude — 1g is normal
// (gravity at rest), so bands are offset from that baseline rather than 0.
function gForceColor(g: number | undefined): string {
  if (g === undefined) return '#3498db'
  if (g < 1.2) return '#2ecc71'
  if (g < 1.5) return '#f1c40f'
  if (g < 2) return '#e74c3c'
  return '#c0392b'
}

// Finds the nearest 1-second bucket for a fix's timestamp (buckets and
// fixes are both roughly 1Hz, so this is normally an exact or near match).
function nearestBucketG(timestamp: number, buckets: AccelBucket[]): number | undefined {
  if (buckets.length === 0) return undefined
  let lo = 0;
  let hi = buckets.length - 1
  while (lo < hi) {
    const mid = (lo + hi) >> 1
    if (buckets[mid].timestamp < timestamp) lo = mid + 1
    else hi = mid
  }
  const candidate = buckets[lo]
  if (Math.abs(candidate.timestamp - timestamp) > 2000) return undefined
  return candidate.maxG
}

interface Segment {
  positions: [number, number][]
  color: string
  timestamp: number
  speedKmh: number | undefined
  limitKmh: number | undefined
  exceededBy: number | undefined
}

interface GForceSegment {
  positions: [number, number][]
  color: string
  timestamp: number
  maxG: number | undefined
}

function buildGForceSegments(fixes: Fix[], buckets: AccelBucket[]): GForceSegment[] {
  const segments: GForceSegment[] = []
  for (let i = 1; i < fixes.length; i++) {
    const prev = fixes[i - 1]
    const cur = fixes[i]
    const maxG = nearestBucketG(cur.timestamp, buckets)
    segments.push({
      positions: [
        [prev.lat, prev.lng],
        [cur.lat, cur.lng],
      ],
      color: gForceColor(maxG),
      timestamp: cur.timestamp,
      maxG,
    })
  }
  return segments
}

function segmentColor(
  speedKmh: number | undefined,
  limitKmh: number | undefined,
  tolerancePercent: number,
): string {
  if (speedKmh === undefined) return '#3498db'
  if (limitKmh === undefined) return speedColor(speedKmh)
  const toleranceKmh = limitKmh * (tolerancePercent / 100)
  if (speedKmh > limitKmh + toleranceKmh + 10) return '#c0392b'
  if (speedKmh > limitKmh + toleranceKmh) return '#e74c3c'
  if (speedKmh > limitKmh) return '#f1c40f'
  return '#2ecc71'
}

function buildSpeedSegments(
  fixes: Fix[],
  limits: (number | undefined)[],
  tolerancePercent: number,
): Segment[] {
  const segments: Segment[] = []
  for (let i = 1; i < fixes.length; i++) {
    const prev = fixes[i - 1]
    const cur = fixes[i]
    const speedKmh = cur.speedKmh
    const limitKmh = limits[i] ?? limits[i - 1]
    const toleranceKmh = limitKmh !== undefined ? limitKmh * (tolerancePercent / 100) : undefined
    const exceededBy =
      speedKmh !== undefined && limitKmh !== undefined && toleranceKmh !== undefined && speedKmh > limitKmh + toleranceKmh
        ? speedKmh - limitKmh
        : undefined
    segments.push({
      positions: [
        [prev.lat, prev.lng],
        [cur.lat, cur.lng],
      ],
      color: segmentColor(speedKmh, limitKmh, tolerancePercent),
      timestamp: cur.timestamp,
      speedKmh,
      limitKmh,
      exceededBy,
    })
  }
  return segments
}

interface MergedPolyline {
  positions: [number, number][]
  color: string
}

// Rendering one Leaflet Polyline (+ Tooltip) per fix-pair is the main reason
// this page was slow with thousands of GPS fixes — merging consecutive
// same-color segments into single multi-point polylines cuts the layer
// count by 1-2 orders of magnitude with no visible difference.
function mergeSegmentsByColor(
  segments: { positions: [number, number][]; color: string }[],
): MergedPolyline[] {
  const merged: MergedPolyline[] = []
  for (const seg of segments) {
    const last = merged[merged.length - 1]
    if (last && last.color === seg.color) {
      last.positions.push(seg.positions[1])
    } else {
      merged.push({ positions: [...seg.positions], color: seg.color })
    }
  }
  return merged
}

function FitBounds({ positions }: { positions: [number, number][] }) {
  const map = useMap()
  useEffect(() => {
    if (positions.length === 0) return
    map.fitBounds(positions, { padding: [20, 20] })
  }, [map, positions])
  return null
}

function formatDuration(seconds: number): string {
  const mins = Math.round(seconds / 60)
  if (mins < 60) return `${mins}m`
  return `${Math.floor(mins / 60)}h ${mins % 60}m`
}

function dateKey(timestamp: number): string {
  const d = new Date(timestamp)
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`
}

const WEEKDAY_LABELS = ['S', 'M', 'T', 'W', 'T', 'F', 'S']

// Simple month-grid calendar, no external library — days with at least one
// trip get a dot indicator; clicking one filters the Trips table to that
// day (clicking the already-selected day clears the filter).
function TripsCalendar({
  month,
  onMonthChange,
  tripCounts,
  selectedDate,
  onSelectDate,
}: {
  month: Date
  onMonthChange: (month: Date) => void
  tripCounts: Map<string, number>
  selectedDate: string | null
  onSelectDate: (date: string | null) => void
}) {
  const year = month.getFullYear()
  const monthIndex = month.getMonth()
  const firstDayOfWeek = new Date(year, monthIndex, 1).getDay()
  const daysInMonth = new Date(year, monthIndex + 1, 0).getDate()
  const todayKey = dateKey(Date.now())

  const cells: (number | null)[] = [
    ...Array(firstDayOfWeek).fill(null),
    ...Array.from({ length: daysInMonth }, (_, i) => i + 1),
  ]

  return (
    <div className="w-full max-w-72 shrink-0">
      <div className="flex items-center justify-between mb-2">
        <Button plain onClick={() => onMonthChange(new Date(year, monthIndex - 1, 1))}>
          ‹
        </Button>
        <Text className="font-medium text-zinc-950 dark:text-white">
          {month.toLocaleDateString(undefined, { month: 'long', year: 'numeric' })}
        </Text>
        <Button plain onClick={() => onMonthChange(new Date(year, monthIndex + 1, 1))}>
          ›
        </Button>
      </div>
      <div className="grid grid-cols-7 gap-1 text-center text-xs text-zinc-500 dark:text-zinc-400 mb-1">
        {WEEKDAY_LABELS.map((d, i) => (
          <span key={i}>{d}</span>
        ))}
      </div>
      <div className="grid grid-cols-7 gap-1">
        {cells.map((day, i) => {
          if (day === null) return <span key={i} />
          const key = `${year}-${String(monthIndex + 1).padStart(2, '0')}-${String(day).padStart(2, '0')}`
          const count = tripCounts.get(key) ?? 0
          const isSelected = selectedDate === key
          const isToday = key === todayKey
          return (
            <button
              key={i}
              type="button"
              disabled={count === 0}
              onClick={() => onSelectDate(isSelected ? null : key)}
              className={`relative rounded-md py-1.5 text-sm ${
                count === 0
                  ? 'text-zinc-400 dark:text-zinc-600 cursor-default'
                  : 'cursor-pointer text-zinc-950 dark:text-white hover:bg-zinc-950/5 dark:hover:bg-white/10'
              } ${isSelected ? 'bg-violet-200 dark:bg-violet-900/40' : ''} ${
                isToday ? 'ring-1 ring-violet-500' : ''
              }`}
            >
              {day}
              {count > 0 && (
                <span className="absolute bottom-0.5 left-1/2 size-1 -translate-x-1/2 rounded-full bg-violet-600 dark:bg-violet-400" />
              )}
            </button>
          )
        })}
      </div>
    </div>
  )
}

function TripMaxGCell({ startTime, endTime }: { startTime: number; endTime: number }) {
  const fetchMaxG = useAction(api.accelSamples.maxInRange)
  const [maxG, setMaxG] = useState<number | null | undefined>(undefined)

  useEffect(() => {
    let cancelled = false
    setMaxG(undefined)
    fetchMaxG({ startTime, endTime }).then((result) => {
      if (!cancelled) setMaxG(result)
    })
    return () => {
      cancelled = true
    }
  }, [startTime, endTime, fetchMaxG])

  if (maxG === undefined) return <span>...</span>
  if (maxG === null) return <span>-</span>
  return <span className={maxG > 1.5 ? 'font-semibold text-red-600 dark:text-red-500' : ''}>{maxG.toFixed(2)}g</span>
}

interface TripEvent {
  _id: string
  type: string
  timestamp: number
  lat?: number
  lng?: number
  thumbnailPath?: string
  thumbnailUrl?: string
}

// Same layout as the Dashboard's event timeline, but scoped to a single
// trip's time range and with an added row of markers for speed
// infringements (segments where the fix's speed exceeded the OSM limit).
const GFORCE_HARSH_THRESHOLD = 1.5

type MapLayer = 'speed' | 'gforce' | 'events'

function LayerToggleButton({
  active,
  onClick,
  children,
}: {
  active: boolean
  onClick: () => void
  children: ReactNode
}) {
  return active ? (
    <Button className="" onClick={onClick}>
      {children}
    </Button>
  ) : (
    <Button outline className="opacity-50" onClick={onClick}>
      {children}
    </Button>
  )
}

function JourneyTimeline({
  startTime,
  endTime,
  startLocation,
  endLocation,
  events,
  speedingSegments,
  harshGForce,
  activeLayer,
}: {
  startTime: number
  endTime: number
  startLocation?: string
  endLocation?: string
  events: TripEvent[]
  speedingSegments: Segment[]
  harshGForce: GForceSegment[]
  activeLayer: MapLayer
}) {
  const [activeEvent, setActiveEvent] = useState<TripEvent | null>(null)

  const showSpeeding = activeLayer === 'speed'
  const showGForce = activeLayer === 'gforce'
  const showEvents = activeLayer === 'events'

  const markers: TimelineMarker[] = showSpeeding
    ? speedingSegments.map((s, i) => ({
        key: `speeding-${i}`,
        timestamp: s.timestamp,
        colorClass: 'bg-red-600',
        title: `Speeding — ${s.speedKmh?.toFixed(0)} km/h (limit ${s.limitKmh?.toFixed(0)} km/h)`,
      }))
    : showGForce
      ? harshGForce.map((s, i) => ({
          key: `gforce-${i}`,
          timestamp: s.timestamp,
          colorClass: 'bg-orange-500',
          title: `${s.maxG?.toFixed(2)}g`,
        }))
      : events.map((e) => ({
          key: e._id,
          timestamp: e.timestamp,
          colorClass: EVENT_TYPE_DOT_CLASS[e.type] ?? EVENT_TYPE_DOT_CLASS.other,
          title: `${e.type} — ${new Date(e.timestamp).toLocaleString()}`,
          onClick: () => setActiveEvent(activeEvent?._id === e._id ? null : e),
          active: activeEvent?._id === e._id,
        }))

  const legend = showEvents
    ? Object.entries(EVENT_TYPE_DOT_CLASS).map(([type, dotColor]) => (
        <span key={type} className="flex items-center gap-1.5">
          <span className={`size-2 rounded-full ${dotColor}`} /> {type}
        </span>
      ))
    : showSpeeding && speedingSegments.length > 0
      ? (
          <span className="flex items-center gap-1.5">
            <span className="size-2 rounded-full bg-red-600" /> speeding
          </span>
        )
      : showGForce && harshGForce.length > 0
        ? (
            <span className="flex items-center gap-1.5">
              <span className="size-2 rounded-full bg-orange-500" /> harsh G-force (≥{GFORCE_HARSH_THRESHOLD}g)
            </span>
          )
        : null

  return (
    <div>
      <Timeline
        startTime={startTime}
        endTime={endTime}
        markers={markers}
        emptyMessage="No events or speed infringements recorded on this trip."
        legend={legend}
        startFlag={{ icon: <GreenFlagIcon />, label: startLocation ?? 'Start' }}
        endFlag={{ icon: '🏁', label: endLocation ?? 'Finish' }}
      />

      {activeEvent && (
        <div className="mt-3 flex items-start gap-3 rounded-lg border border-zinc-950/10 dark:border-white/10 p-3">
          {activeEvent.thumbnailUrl || activeEvent.thumbnailPath ? (
            <img
              src={activeEvent.thumbnailUrl ?? thumbnailUrl(activeEvent.thumbnailPath!)}
              alt=""
              width={160}
              className="rounded object-cover"
            />
          ) : (
            <div className="flex h-24 w-40 items-center justify-center rounded bg-zinc-950/10 dark:bg-white/10">
              <Text>No image available</Text>
            </div>
          )}
          <div className="flex flex-col gap-1">
            <Badge color={EVENT_TYPE_BADGE_COLOR[activeEvent.type] ?? EVENT_TYPE_BADGE_COLOR.other}>
              {activeEvent.type}
            </Badge>
            <Text>{new Date(activeEvent.timestamp).toLocaleString()}</Text>
            <Button plain onClick={() => setActiveEvent(null)} className="self-start">
              Close
            </Button>
          </div>
        </div>
      )}
    </div>
  )
}

export default function Journeys() {
  const { toast } = useToast()
  const allTrips = useQuery(api.journeys.list, { limit: 5000 })
  const cameras = useQuery(api.cameras.list, {})
  const settings = useQuery(api.settings.get, {})
  const speedTolerancePercent = settings?.speedTolerancePercent ?? 10
  const fetchLimits = useAction(api.overpass.speedLimitWays)
  const fetchAccelBuckets = useAction(api.accelSamples.bucketedForRange)
  const deleteJourneyRange = useAction(api.journeys.deleteRange)
  const [deleteTarget, setDeleteTarget] = useState<NonNullable<typeof allTrips>[number] | null>(null)
  const [deleting, setDeleting] = useState(false)
  const [selectedStart, setSelectedStart] = useState<number | undefined>(undefined)
  const [selectedDate, setSelectedDate] = useState<string | null>(null)
  // '' = all cameras. Value is the camera's Convex id; trips from before
  // multi-camera support have no cameraId and only show under "All".
  const [selectedCameraId, setSelectedCameraId] = useState('')
  const [calendarMonth, setCalendarMonth] = useState(() => new Date())
  const [activeLayer, setActiveLayer] = useState<MapLayer>('speed')
  const [speedLimits, setSpeedLimits] = useState<(number | undefined)[]>([])
  const [limitsLoading, setLimitsLoading] = useState(false)
  const [limitsError, setLimitsError] = useState<string | null>(null)
  const [retryCount, setRetryCount] = useState(0)
  const [accelBuckets, setAccelBuckets] = useState<AccelBucket[]>([])
  const [accelLoading, setAccelLoading] = useState(false)
  const [accelError, setAccelError] = useState<string | null>(null)
  // Caches computed speed limits / accel buckets per trip (by startTime) so
  // switching back to an already-viewed trip is instant instead of
  // re-fetching Overpass/Convex and re-running the matching logic.
  const speedLimitCache = useRef(new Map<number, (number | undefined)[]>())
  const accelBucketCache = useRef(new Map<number, AccelBucket[]>())

  // Camera filter applies before the date filter AND before the calendar's
  // per-day counts, so the calendar reflects only the selected camera too.
  const cameraTrips = useMemo(
    () =>
      selectedCameraId
        ? allTrips?.filter((t) => t.cameraId === selectedCameraId)
        : allTrips,
    [allTrips, selectedCameraId],
  )

  const tripCounts = useMemo(() => {
    const counts = new Map<string, number>()
    for (const t of cameraTrips ?? []) {
      const key = dateKey(t.startTime)
      counts.set(key, (counts.get(key) ?? 0) + 1)
    }
    return counts
  }, [cameraTrips])

  const trips = useMemo(
    () => (selectedDate ? (cameraTrips ?? []).filter((t) => dateKey(t.startTime) === selectedDate) : cameraTrips),
    [cameraTrips, selectedDate],
  )

  const selectedTrip = trips?.find((t) => t.startTime === selectedStart) ?? trips?.[0]

  const fixes = useQuery(
    api.gpsFixes.forTimeRange,
    selectedTrip
      ? { startTime: selectedTrip.startTime, endTime: selectedTrip.endTime }
      : 'skip',
  )

  const tripEvents = useQuery(
    api.events.forTimeRangeWithThumbnails,
    selectedTrip
      ? { startTime: selectedTrip.startTime, endTime: selectedTrip.endTime }
      : 'skip',
  )

  const sortedFixes = useMemo(
    () => (fixes ?? []).slice().sort((a, b) => a.timestamp - b.timestamp),
    [fixes],
  )
  const positions = useMemo(
    () => sortedFixes.map((f) => [f.lat, f.lng] as [number, number]),
    [sortedFixes],
  )
  const segments = useMemo(
    () => buildSpeedSegments(sortedFixes, speedLimits, speedTolerancePercent),
    [sortedFixes, speedLimits, speedTolerancePercent],
  )
  const speedingSegments = useMemo(
    () => segments.filter((s) => s.exceededBy !== undefined),
    [segments],
  )
  const gForceSegments = useMemo(
    () => buildGForceSegments(sortedFixes, accelBuckets),
    [sortedFixes, accelBuckets],
  )
  const harshGForce = useMemo(
    () => gForceSegments.filter((s) => (s.maxG ?? 0) >= GFORCE_HARSH_THRESHOLD),
    [gForceSegments],
  )
  const mergedSpeedPolylines = useMemo(() => mergeSegmentsByColor(segments), [segments])
  const mergedGForcePolylines = useMemo(() => mergeSegmentsByColor(gForceSegments), [gForceSegments])
  const center = positions[0] ?? DEFAULT_CENTER

  useEffect(() => {
    if (sortedFixes.length < 2 || !selectedTrip) {
      setSpeedLimits([])
      return
    }

    const cached = speedLimitCache.current.get(selectedTrip.startTime)
    if (cached) {
      setSpeedLimits(cached)
      setLimitsError(null)
      setLimitsLoading(false)
      return
    }

    let cancelled = false
    setLimitsLoading(true)
    setLimitsError(null)
    const lats = sortedFixes.map((f) => f.lat)
    const lngs = sortedFixes.map((f) => f.lng)
    const south = Math.min(...lats)
    const west = Math.min(...lngs)
    const north = Math.max(...lats)
    const east = Math.max(...lngs)
    const latBuf = Math.max(0.001, (north - south) * 0.05)
    const lngBuf = Math.max(0.001, (east - west) * 0.05)
    fetchLimits({
      south: south - latBuf,
      west: west - lngBuf,
      north: north + latBuf,
      east: east + lngBuf,
    })
      .then((ways) => {
        if (cancelled) return
        const typedWays: SpeedLimitWay[] = ways.map((w) => ({
          maxspeedKmh: w.maxspeedKmh,
          points: w.points as [number, number][],
        }))
        const limits = assignSpeedLimits(sortedFixes, typedWays)
        speedLimitCache.current.set(selectedTrip.startTime, limits)
        setSpeedLimits(limits)
      })
      .catch((err) => {
        if (cancelled) return
        const message = err instanceof Error ? err.message : String(err)
        setLimitsError(message)
        toast(`Speed limit lookup failed: ${message}`, 'error')
      })
      .finally(() => {
        if (!cancelled) setLimitsLoading(false)
      })
    return () => {
      cancelled = true
    }
  }, [sortedFixes, selectedTrip, fetchLimits, retryCount])

  useEffect(() => {
    if (!selectedTrip) {
      setAccelBuckets([])
      return
    }

    const cached = accelBucketCache.current.get(selectedTrip.startTime)
    if (cached) {
      setAccelBuckets(cached)
      setAccelError(null)
      setAccelLoading(false)
      return
    }

    let cancelled = false
    setAccelLoading(true)
    setAccelError(null)
    fetchAccelBuckets({ startTime: selectedTrip.startTime, endTime: selectedTrip.endTime })
      .then((buckets) => {
        if (cancelled) return
        accelBucketCache.current.set(selectedTrip.startTime, buckets)
        setAccelBuckets(buckets)
      })
      .catch((err) => {
        if (cancelled) return
        const message = err instanceof Error ? err.message : String(err)
        setAccelError(message)
        toast(`Accelerometer lookup failed: ${message}`, 'error')
      })
      .finally(() => {
        if (!cancelled) setAccelLoading(false)
      })
    return () => {
      cancelled = true
    }
  }, [selectedTrip, fetchAccelBuckets])

  async function confirmDelete() {
    if (!deleteTarget) return
    setDeleting(true)
    try {
      const { filesToDelete } = await deleteJourneyRange({
        cameraId: deleteTarget.cameraId,
        startTime: deleteTarget.startTime,
        endTime: deleteTarget.endTime,
      })
      await Promise.all(
        filesToDelete.map(({ category, filename }) =>
          fetch(`${POLLER_URL}/files/delete`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ category, filename }),
          }).catch(() => undefined),
        ),
      )
      if (selectedTrip?.startTime === deleteTarget.startTime) setSelectedStart(undefined)
      toast('Journey deleted.')
      setDeleteTarget(null)
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err)
      toast(`Failed to delete journey: ${message}`, 'error')
    } finally {
      setDeleting(false)
    }
  }

  return (
    <div>
      <Heading>Journeys</Heading>

      <div className="mt-6">
        <div className="flex items-center justify-between gap-3">
          <Subheading>Trips</Subheading>
          <div className="flex items-center gap-3">
            {selectedDate && (
              <Button plain onClick={() => setSelectedDate(null)}>
                Clear date filter ({selectedDate})
              </Button>
            )}
            {cameras && cameras.length > 1 && (
              <Select
                value={selectedCameraId}
                onChange={(e) => setSelectedCameraId(e.target.value)}
                className="max-w-48"
                aria-label="Filter by camera"
              >
                <option value="">All cameras</option>
                {cameras.map((camera) => (
                  <option key={camera._id} value={camera._id}>
                    {camera.name}
                  </option>
                ))}
              </Select>
            )}
          </div>
        </div>
        <Divider className="my-3" />
        <div className="flex gap-6 flex-wrap items-start">
          <div className="flex-1 min-w-0">
            {allTrips === undefined ? (
              <Text>Loading...</Text>
            ) : allTrips.length === 0 ? (
              <Text>
                No GPS fixes yet. Check the poller's Activity log — GPS files download
                automatically, but a file may fail to parse if its format doesn't match what's
                expected.
              </Text>
            ) : trips && trips.length === 0 ? (
              <Text>
                {selectedDate
                  ? `No trips on ${selectedDate} for this filter.`
                  : 'No trips for the selected camera.'}
              </Text>
            ) : (
              <Table>
                <TableHead>
                  <TableRow>
                    <TableHeader>Start Time</TableHeader>
                    <TableHeader>Start</TableHeader>
                    <TableHeader>Finish</TableHeader>
                    <TableHeader>Duration</TableHeader>
                    <TableHeader>Distance</TableHeader>
                    <TableHeader>Max speed</TableHeader>
                    <TableHeader>Max G</TableHeader>
                    <TableHeader></TableHeader>
                  </TableRow>
                </TableHead>
                <TableBody>
                  {trips?.map((t, i) => (
                    <TableRow
                      key={i}
                      onClick={() => setSelectedStart(t.startTime)}
                      className={`cursor-pointer ${t.startTime === selectedTrip?.startTime ? 'bg-zinc-950/5 dark:bg-white/5' : ''}`}
                    >
                      <TableCell>{new Date(t.startTime).toLocaleString()}</TableCell>
                      <TableCell>{t.startLocation ?? '—'}</TableCell>
                      <TableCell>{t.endLocation ?? '—'}</TableCell>
                      <TableCell>{formatDuration(t.durationSeconds)}</TableCell>
                      <TableCell>{t.distanceKm.toFixed(2)} km</TableCell>
                      <TableCell>{t.maxSpeedKmh.toFixed(0)} km/h</TableCell>
                      <TableCell>
                        <TripMaxGCell startTime={t.startTime} endTime={t.endTime} />
                      </TableCell>
                      <TableCell>
                        <Button
                          plain
                          onClick={(e) => {
                            e.stopPropagation()
                            setDeleteTarget(t)
                          }}
                        >
                          Delete
                        </Button>
                      </TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            )}
          </div>

          <TripsCalendar
            month={calendarMonth}
            onMonthChange={setCalendarMonth}
            tripCounts={tripCounts}
            selectedDate={selectedDate}
            onSelectDate={(date) => {
              setSelectedDate(date)
              setSelectedStart(undefined)
            }}
          />
        </div>
      </div>

      {selectedTrip && (
        <div className="mt-6">
          <div className="flex items-center flex-wrap gap-3">
            <div className="flex gap-2">
              <LayerToggleButton active={activeLayer === 'speed'} onClick={() => setActiveLayer('speed')}>
                Speed
              </LayerToggleButton>
              <LayerToggleButton active={activeLayer === 'gforce'} onClick={() => setActiveLayer('gforce')}>
                G-Force
              </LayerToggleButton>
              <LayerToggleButton active={activeLayer === 'events'} onClick={() => setActiveLayer('events')}>
                Events
              </LayerToggleButton>
            </div>
            <Text>
              Showing trip starting {new Date(selectedTrip.startTime).toLocaleString()} —{' '}
              {selectedTrip.fixCount} fixes, {selectedTrip.distanceKm.toFixed(2)} km.
            </Text>
          </div>

          <div className="mt-4 rounded-lg border border-zinc-950/10 dark:border-white/10 p-4">
            <Subheading>Timeline</Subheading>
            <Divider className="my-3" />
            {tripEvents === undefined ? (
              <Text>Loading events…</Text>
            ) : (
              <JourneyTimeline
                startTime={selectedTrip.startTime}
                endTime={selectedTrip.endTime}
                startLocation={selectedTrip.startLocation}
                endLocation={selectedTrip.endLocation}
                events={tripEvents}
                speedingSegments={speedingSegments}
                harshGForce={harshGForce}
                activeLayer={activeLayer}
              />
            )}
          </div>

          {activeLayer === 'speed' && (
            <>
              <div className="mt-2 flex flex-wrap gap-4 text-sm text-zinc-950 dark:text-white">
                <span><span className="text-green-500">●</span> Under limit</span>
                <span><span className="text-yellow-400">●</span> Over limit, within {speedTolerancePercent}% tolerance</span>
                <span><span className="text-red-500">●</span> Over limit + tolerance</span>
                <span><span className="text-red-800">●</span> &gt;10 km/h over limit + tolerance</span>
                <span><span className="text-blue-500">●</span> No speed / no limit data</span>
              </div>
              {limitsLoading && (
                <Text className="mt-2">Loading OSM speed limits…</Text>
              )}
              {limitsError && (
                <Text className="mt-2">
                  <Button plain onClick={() => setRetryCount((c) => c + 1)}>
                    Retry
                  </Button>
                </Text>
              )}
              {!limitsLoading && !limitsError && (
                <Text className="mt-2">
                  Matched {speedLimits.filter((l) => l !== undefined).length} of {sortedFixes.length}{' '}
                  fixes to OSM speed limits.
                  {(() => {
                    const speeding = segments.filter((s) => s.exceededBy !== undefined)
                    if (speeding.length === 0) return ' No speeding detected.'
                    const maxOver = Math.max(...speeding.map((s) => s.exceededBy ?? 0))
                    return ` ${speeding.length} segment${speeding.length === 1 ? '' : 's'} over the limit (max ${maxOver.toFixed(0)} km/h over).`
                  })()}
                </Text>
              )}
            </>
          )}
          {activeLayer === 'gforce' && (
            <>
              <div className="mt-2 flex flex-wrap gap-4 text-sm text-zinc-950 dark:text-white">
                <span><span className="text-green-500">●</span> &lt;1.2g (normal)</span>
                <span><span className="text-yellow-400">●</span> 1.2-1.5g</span>
                <span><span className="text-red-500">●</span> 1.5-2g (harsh)</span>
                <span><span className="text-red-800">●</span> &gt;2g (impact)</span>
                <span><span className="text-blue-500">●</span> No accelerometer data</span>
              </div>
              {accelLoading && <Text className="mt-2">Loading accelerometer data…</Text>}
              {!accelLoading && !accelError && (
                <Text className="mt-2">
                  {accelBuckets.length === 0 ? (
                    'No accelerometer data for this trip.'
                  ) : (
                    (() => {
                      const peak = Math.max(...accelBuckets.map((b) => b.maxG))
                      return `Peak G-force: ${peak.toFixed(2)}g. ${
                        harshGForce.length === 0
                          ? 'No harsh events (≥1.5g) detected.'
                          : `${harshGForce.length} segment${harshGForce.length === 1 ? '' : 's'} at or above 1.5g.`
                      }`
                    })()
                  )}
                </Text>
              )}
            </>
          )}
        </div>
      )}

      <div className="mt-6 h-125">
        <MapContainer center={center} zoom={13} style={{ height: '100%', width: '100%' }} className="rounded-lg">
          <TileLayer
            attribution='&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> contributors'
            url="https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png"
          />
          <Polyline positions={positions} color="#3498db" weight={4} />
          {positions.length > 0 && (
            <>
              <Marker position={positions[0]} icon={START_ICON}>
                <Popup>Start{selectedTrip?.startLocation ? `: ${selectedTrip.startLocation}` : ''}</Popup>
              </Marker>
              <Marker position={positions[positions.length - 1]} icon={FINISH_ICON}>
                <Popup>Finish{selectedTrip?.endLocation ? `: ${selectedTrip.endLocation}` : ''}</Popup>
              </Marker>
            </>
          )}
          {activeLayer === 'speed' &&
            mergedSpeedPolylines.map((line, i) => (
              <Polyline key={i} positions={line.positions} color={line.color} weight={4} />
            ))}
          {activeLayer === 'speed' &&
            speedingSegments.map((s, i) => (
              <CircleMarker
                key={`speeding-${i}`}
                center={s.positions[1]}
                radius={5}
                pathOptions={{ color: '#c0392b', fillColor: '#e74c3c', fillOpacity: 0.9 }}
              >
                <Popup>
                  Speeding: {s.speedKmh?.toFixed(0)} km/h (limit {s.limitKmh?.toFixed(0)} km/h)
                  <br />
                  {new Date(s.timestamp).toLocaleTimeString()}
                </Popup>
              </CircleMarker>
            ))}
          {activeLayer === 'gforce' &&
            mergedGForcePolylines.map((line, i) => (
              <Polyline key={i} positions={line.positions} color={line.color} weight={4} />
            ))}
          {activeLayer === 'gforce' &&
            harshGForce.map((s, i) => (
              <CircleMarker
                key={`gforce-${i}`}
                center={s.positions[1]}
                radius={5}
                pathOptions={{ color: '#c0392b', fillColor: '#e67e22', fillOpacity: 0.9 }}
              >
                <Popup>
                  Harsh G-force: {s.maxG?.toFixed(2)}g
                  <br />
                  {new Date(s.timestamp).toLocaleTimeString()}
                </Popup>
              </CircleMarker>
            ))}
          {activeLayer === 'events' &&
            (tripEvents ?? [])
              .filter((e) => e.lat !== undefined && e.lng !== undefined)
              .map((e) => (
              <CircleMarker
                key={e._id}
                center={[e.lat as number, e.lng as number]}
                radius={7}
                pathOptions={{
                  color: EVENT_TYPE_HEX[e.type] ?? EVENT_TYPE_HEX.other,
                  fillColor: EVENT_TYPE_HEX[e.type] ?? EVENT_TYPE_HEX.other,
                  fillOpacity: 0.9,
                }}
              >
                <Popup>
                  {e.type} — {new Date(e.timestamp).toLocaleString()}
                </Popup>
              </CircleMarker>
            ))}
          <FitBounds positions={positions} />
        </MapContainer>
      </div>

      <Dialog open={deleteTarget !== null} onClose={() => !deleting && setDeleteTarget(null)}>
        <DialogTitle>Delete this journey?</DialogTitle>
        <DialogDescription>
          This permanently deletes the GPS track, accelerometer data, events, and any downloaded
          recordings for this trip — the video, thumbnail, and GPS files are removed from disk too,
          and won't be re-downloaded from the camera. This can't be undone.
        </DialogDescription>
        <DialogBody>
          {deleteTarget && (
            <Text>
              {new Date(deleteTarget.startTime).toLocaleString()} — {deleteTarget.distanceKm.toFixed(2)} km,{' '}
              {formatDuration(deleteTarget.durationSeconds)}
            </Text>
          )}
        </DialogBody>
        <DialogActions>
          <Button plain onClick={() => setDeleteTarget(null)} disabled={deleting}>
            Cancel
          </Button>
          <Button color="red" onClick={confirmDelete} disabled={deleting}>
            {deleting ? 'Deleting…' : 'Delete journey'}
          </Button>
        </DialogActions>
      </Dialog>
    </div>
  )
}
