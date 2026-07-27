import { useEffect, useMemo, useState } from 'react'
import { MapContainer, TileLayer, Polyline, Marker, useMap } from 'react-leaflet'
import { divIcon } from 'leaflet'
import { useQuery } from 'convex/react'
import { api } from '../../../../convex/_generated/api'
import type { Id } from '../../../../convex/_generated/dataModel'
import { Heading } from '../components/heading'
import { Text } from '../components/text'
import { Select } from '../components/select'
import { Badge } from '../components/badge'
import 'leaflet/dist/leaflet.css'

const DEFAULT_CENTER: [number, number] = [-36.8485, 174.7633] // Auckland, NZ

// Freshness is judged against updatedAt (server receive time) rather than
// the phone's sample timestamp, so a device with a skewed clock can't look
// permanently live or permanently stale.
const LIVE_THRESHOLD_MS = 15_000
const STALE_THRESHOLD_MS = 5 * 60_000

function vehicleIcon(headingDeg: number | undefined) {
  const rotation = headingDeg ?? 0
  return divIcon({
    html:
      `<div style="width:34px;height:34px;border-radius:50%;background:#8b5cf6;` +
      `display:flex;align-items:center;justify-content:center;` +
      `box-shadow:0 1px 4px rgba(0,0,0,0.5);transform:rotate(${rotation}deg)">` +
      `<svg width="18" height="18" viewBox="0 0 24 24" fill="white" xmlns="http://www.w3.org/2000/svg">` +
      `<path d="M12 2 L19 21 L12 17 L5 21 Z"/>` +
      `</svg></div>`,
    className: '',
    iconSize: [34, 34],
    iconAnchor: [17, 17],
  })
}

/// Keeps the map glued to the vehicle while follow is on. MapContainer's
/// `center` prop is initial-only in react-leaflet, hence the imperative hook.
function FollowVehicle({ position, follow }: { position: [number, number] | null; follow: boolean }) {
  const map = useMap()
  useEffect(() => {
    if (follow && position) {
      map.setView(position, Math.max(map.getZoom(), 15), { animate: true })
    }
  }, [map, follow, position?.[0], position?.[1]])
  return null
}

function cardinal(degrees: number): string {
  const directions = ['N', 'NE', 'E', 'SE', 'S', 'SW', 'W', 'NW']
  return directions[Math.max(0, Math.min(7, Math.floor(((degrees + 22.5) % 360) / 45)))]
}

function formatAge(ms: number): string {
  if (ms < 1_000) return 'just now'
  if (ms < 60_000) return `${Math.floor(ms / 1000)}s ago`
  if (ms < 3_600_000) return `${Math.floor(ms / 60_000)}m ago`
  return `${Math.floor(ms / 3_600_000)}h ago`
}

function StatTile({ label, value, sub }: { label: string; value: string; sub?: string }) {
  return (
    <div className="rounded-lg border border-zinc-200 bg-white p-4 dark:border-zinc-800 dark:bg-zinc-900">
      <div className="text-xs font-medium text-zinc-500 dark:text-zinc-400">{label}</div>
      <div className="mt-1 text-2xl font-semibold tabular-nums text-zinc-950 dark:text-white">{value}</div>
      {sub && <div className="mt-0.5 text-xs text-zinc-500 dark:text-zinc-400">{sub}</div>}
    </div>
  )
}

export default function LiveTracking() {
  const telemetry = useQuery(api.liveTelemetry.listAll)
  const cameras = useQuery(api.cameras.list)
  const [selectedCameraId, setSelectedCameraId] = useState<Id<'cameras'> | null>(null)
  const [follow, setFollow] = useState(true)
  // 1s tick so the "last update" age and LIVE/STALE badge move without
  // needing new data to arrive.
  const [now, setNow] = useState(() => Date.now())
  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), 1000)
    return () => clearInterval(timer)
  }, [])

  // Prefer the camera that reported most recently when nothing is selected.
  const activeCameraId = useMemo(() => {
    if (selectedCameraId) return selectedCameraId
    if (!telemetry || telemetry.length === 0) return null
    return [...telemetry].sort((a, b) => b.updatedAt - a.updatedAt)[0].cameraId
  }, [selectedCameraId, telemetry])

  const row = telemetry?.find((t) => t.cameraId === activeCameraId) ?? null
  const cameraName = (id: Id<'cameras'>) => cameras?.find((c) => c._id === id)?.name ?? 'Unknown camera'

  const age = row ? now - row.updatedAt : null
  const status: 'live' | 'stale' | 'offline' | 'none' =
    age === null ? 'none' : age < LIVE_THRESHOLD_MS ? 'live' : age < STALE_THRESHOLD_MS ? 'stale' : 'offline'

  const position: [number, number] | null = row ? [row.lat, row.lng] : null
  const trailPositions: [number, number][] = useMemo(
    () => (row ? row.trail.map((p) => [p.lat, p.lng] as [number, number]) : []),
    [row],
  )
  const icon = useMemo(() => vehicleIcon(row?.headingDeg), [row?.headingDeg])

  return (
    <div>
      <div className="flex flex-wrap items-center justify-between gap-4">
        <div className="flex items-center gap-3">
          <Heading>Live tracking</Heading>
          {status === 'live' && <Badge color="green">LIVE</Badge>}
          {status === 'stale' && <Badge color="amber">STALE</Badge>}
          {status === 'offline' && <Badge color="zinc">OFFLINE</Badge>}
        </div>
        <div className="flex items-center gap-3">
          {telemetry && telemetry.length > 1 && (
            <Select
              value={activeCameraId ?? ''}
              onChange={(e) => setSelectedCameraId(e.target.value as Id<'cameras'>)}
            >
              {telemetry.map((t) => (
                <option key={t.cameraId} value={t.cameraId}>
                  {cameraName(t.cameraId)}
                </option>
              ))}
            </Select>
          )}
          <label className="flex items-center gap-2 text-sm text-zinc-600 dark:text-zinc-300">
            <input
              type="checkbox"
              checked={follow}
              onChange={(e) => setFollow(e.target.checked)}
              className="rounded border-zinc-300 dark:border-zinc-700"
            />
            Follow
          </label>
        </div>
      </div>

      {telemetry !== undefined && telemetry.length === 0 && (
        <Text className="mt-4">
          No live telemetry yet. Open the Safety Planner iOS app, go to the Live tab, and press Start —
          the vehicle will appear here within a couple of seconds.
        </Text>
      )}

      {row && (
        <div className="mt-4 grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-5">
          <StatTile
            label="Speed"
            value={row.speedKmh !== undefined ? `${Math.round(row.speedKmh)} km/h` : '—'}
          />
          <StatTile
            label="Heading"
            value={row.headingDeg !== undefined ? `${cardinal(row.headingDeg)} ${Math.round(row.headingDeg)}°` : '—'}
          />
          <StatTile
            label="G-force"
            value={row.gForce !== undefined ? `${row.gForce.toFixed(2)} g` : '—'}
          />
          <StatTile
            label="Peak G"
            value={row.peakG !== undefined ? `${row.peakG.toFixed(2)} g` : '—'}
            sub="since session start"
          />
          <StatTile
            label="Last update"
            value={age !== null ? formatAge(age) : '—'}
            sub={`${row.lat.toFixed(5)}, ${row.lng.toFixed(5)}`}
          />
        </div>
      )}

      <div className="mt-4 h-[32rem]">
        <MapContainer
          center={position ?? DEFAULT_CENTER}
          zoom={position ? 15 : 12}
          style={{ height: '100%', width: '100%' }}
          className="rounded-lg"
        >
          <TileLayer
            attribution='&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> contributors'
            url="https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png"
          />
          {trailPositions.length > 1 && (
            <Polyline positions={trailPositions} color="#8b5cf6" weight={4} opacity={0.8} />
          )}
          {position && <Marker position={position} icon={icon} />}
          <FollowVehicle position={position} follow={follow} />
        </MapContainer>
      </div>
    </div>
  )
}
