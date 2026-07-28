import { useEffect, useMemo, useRef, useState } from 'react'
import { MapContainer, TileLayer, Polyline, Marker, useMap } from 'react-leaflet'
import { divIcon } from 'leaflet'
import { useAction, useQuery } from 'convex/react'
import { api } from '../../../../convex/_generated/api'
import type { Id } from '../../../../convex/_generated/dataModel'
import { Heading, Subheading } from '../components/heading'
import { Text } from '../components/text'
import { Listbox, ListboxOption, ListboxLabel } from '../components/listbox'
import { CameraAvatar } from '../components/cameraAvatar'
import { avatarColorFor } from '../cameraAvatar'
import { Badge } from '../components/badge'
import 'leaflet/dist/leaflet.css'

const DEFAULT_CENTER: [number, number] = [-36.8485, 174.7633] // Auckland, NZ

// Freshness is judged against updatedAt (server receive time) rather than
// the phone's sample timestamp, so a device with a skewed clock can't look
// permanently live or permanently stale.
const LIVE_THRESHOLD_MS = 15_000
const STALE_THRESHOLD_MS = 5 * 60_000

// How often (and how far the vehicle must move) before re-querying Overpass
// for the current road's speed limit — a live 1Hz position feed would
// otherwise hammer the API on every single fix.
const SPEED_LIMIT_REFRESH_MS = 15_000

function haversineMeters(lat1: number, lng1: number, lat2: number, lng2: number): number {
  const R = 6371000
  const dLat = ((lat2 - lat1) * Math.PI) / 180
  const dLng = ((lng2 - lng1) * Math.PI) / 180
  const a =
    Math.sin(dLat / 2) ** 2 +
    Math.cos((lat1 * Math.PI) / 180) * Math.cos((lat2 * Math.PI) / 180) * Math.sin(dLng / 2) ** 2
  return R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a))
}

// The vehicle marker: the camera's avatar (photo, or the same colored car
// icon used everywhere else a camera is shown) plus a speed badge floating
// above it — colored green/amber/red against the Overpass-resolved speed
// limit the same way Journeys' speed segments are, when a limit is known.
function vehicleIcon(
  headingDeg: number | undefined,
  avatarUrl: string | undefined | null,
  avatarId: string,
  speedKmh: number | undefined,
  speedLimitKmh: number | undefined,
  tolerancePercent: number,
) {
  const rotation = headingDeg ?? 0
  // A real photo shouldn't spin to track heading — only the default car
  // icon rotates, matching how a car icon reads directionally but a face/
  // logo photo wouldn't.
  const circleStyle = avatarUrl
    ? 'background:#18181b;'
    : `background:${avatarColorFor(avatarId)};transform:rotate(${rotation}deg);`
  const inner = avatarUrl
    ? `<img src="${avatarUrl}" style="width:100%;height:100%;object-fit:cover;border-radius:50%;" />`
    : `<svg width="18" height="18" viewBox="0 0 24 24" fill="none" xmlns="http://www.w3.org/2000/svg">
        <path d="M4 16v-3.2a1 1 0 0 1 .1-.44l1.55-3.32A2 2 0 0 1 7.46 8h9.08a2 2 0 0 1 1.81 1.14l1.55 3.42a1 1 0 0 1 .1.44V16a1 1 0 0 1-1 1h-1a1 1 0 0 1-1-1v-.5H7v.5a1 1 0 0 1-1 1H5a1 1 0 0 1-1-1Z" stroke="white" stroke-width="1.6" stroke-linejoin="round"/>
        <circle cx="7.5" cy="16" r="1.4" fill="white"/><circle cx="16.5" cy="16" r="1.4" fill="white"/>
        <path d="M4.5 12.5h15" stroke="white" stroke-width="1.6"/>
      </svg>`

  let speedColor = '#3b82f6'
  if (speedKmh !== undefined && speedLimitKmh !== undefined) {
    const toleranceKmh = speedLimitKmh * (tolerancePercent / 100)
    speedColor = speedKmh > speedLimitKmh + toleranceKmh ? '#ef4444' : speedKmh > speedLimitKmh ? '#f59e0b' : '#22c55e'
  }
  const speedLabel =
    speedKmh !== undefined
      ? `${Math.round(speedKmh)}${speedLimitKmh !== undefined ? ` / ${Math.round(speedLimitKmh)}` : ''} km/h`
      : '—'

  return divIcon({
    html:
      `<div style="position:relative;width:34px;height:46px;">` +
      `<div style="position:absolute;top:0;left:50%;transform:translateX(-50%);background:${speedColor};color:white;` +
      `font-size:10px;font-weight:600;padding:1px 6px;border-radius:9999px;white-space:nowrap;box-shadow:0 1px 3px rgba(0,0,0,0.4);">` +
      `${speedLabel}</div>` +
      `<div style="position:absolute;bottom:0;left:50%;transform:translateX(-50%);width:34px;height:34px;border-radius:50%;` +
      `display:flex;align-items:center;justify-content:center;box-shadow:0 1px 4px rgba(0,0,0,0.5);overflow:hidden;${circleStyle}">` +
      `${inner}</div></div>`,
    className: '',
    iconSize: [34, 46],
    iconAnchor: [17, 34],
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

// Every OBD field is independently optional (each comes from its own PID on
// its own polling interval, and an unsupported one is simply never present),
// so formatting always has to cope with undefined rather than assuming a
// value arrived with the rest of the group.
function fmt(value: number | undefined, digits: number, unit: string): string {
  return value === undefined ? '—' : `${value.toFixed(digits)} ${unit}`
}

const KPA_TO_PSI = 0.145038

// The four corners, laid out as they sit on the car so an odd one out is
// spotted positionally rather than by reading labels.
function TyrePressures({
  frontLeft,
  frontRight,
  rearLeft,
  rearRight,
}: {
  frontLeft?: number
  frontRight?: number
  rearLeft?: number
  rearRight?: number
}) {
  const corner = (kpa: number | undefined, label: string) => (
    <div className="text-center">
      <div className="text-[10px] uppercase tracking-wide text-zinc-400 dark:text-zinc-500">{label}</div>
      <div className="text-sm font-semibold tabular-nums text-zinc-950 dark:text-white">
        {kpa === undefined ? '—' : Math.round(kpa)}
      </div>
      <div className="text-[10px] tabular-nums text-zinc-500 dark:text-zinc-400">
        {kpa === undefined ? '' : `${(kpa * KPA_TO_PSI).toFixed(1)} psi`}
      </div>
    </div>
  )
  return (
    <div className="col-span-2 rounded-lg border border-zinc-200 bg-white p-4 dark:border-zinc-800 dark:bg-zinc-900">
      <div className="text-xs font-medium text-zinc-500 dark:text-zinc-400">Tyre pressures (kPa)</div>
      <div className="mt-2 grid grid-cols-2 gap-x-4 gap-y-2">
        {corner(frontLeft, 'FL')}
        {corner(frontRight, 'FR')}
        {corner(rearLeft, 'RL')}
        {corner(rearRight, 'RR')}
      </div>
    </div>
  )
}

export default function LiveTracking() {
  const telemetry = useQuery(api.liveTelemetry.listAll)
  const cameras = useQuery(api.cameras.list)
  const settings = useQuery(api.settings.get, {})
  const fetchSpeedLimit = useAction(api.overpass.nearestSpeedLimit)
  const [selectedCameraId, setSelectedCameraId] = useState<Id<'cameras'> | null>(null)
  const [follow, setFollow] = useState(true)
  const [speedLimitKmh, setSpeedLimitKmh] = useState<number | undefined>(undefined)
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
  const camera = cameras?.find((c) => c._id === activeCameraId)
  const cameraName = (id: Id<'cameras'>) => cameras?.find((c) => c._id === id)?.name ?? 'Unknown camera'

  const age = row ? now - row.updatedAt : null

  // How long ago the CAR was read, as opposed to how long ago the phone
  // reported. These diverge: positions keep publishing at 1Hz whether or not
  // the OBD dongle is answering, so row freshness says nothing about OBD
  // freshness. Derived as "how far behind the sample the OBD read was, plus
  // how old that sample is" — both of those timestamps come from the phone's
  // clock so the difference cancels any skew, and only the server-side `age`
  // is compared against the browser's clock, matching how `status` above
  // deliberately avoids trusting the phone's clock at all.
  const obdAge =
    row?.obd?.updatedAt !== undefined && age !== null
      ? Math.max(0, row.timestamp - row.obd.updatedAt) + age
      : null

  const status: 'live' | 'stale' | 'offline' | 'none' =
    age === null ? 'none' : age < LIVE_THRESHOLD_MS ? 'live' : age < STALE_THRESHOLD_MS ? 'stale' : 'offline'

  const position: [number, number] | null = row ? [row.lat, row.lng] : null
  const trailPositions: [number, number][] = useMemo(
    () => (row ? row.trail.map((p) => [p.lat, p.lng] as [number, number]) : []),
    [row],
  )

  // Refetches on a timer (not on every 1Hz position update) and only when
  // the vehicle has actually moved far enough to plausibly be on a
  // different road — keeps Overpass calls to a handful per minute instead
  // of one per fix.
  const lastLookupRef = useRef<{ lat: number; lng: number } | null>(null)
  useEffect(() => {
    if (!position) {
      setSpeedLimitKmh(undefined)
      lastLookupRef.current = null
      return
    }
    const [lat, lng] = position
    const lookup = () => {
      fetchSpeedLimit({ lat, lng })
        .then((limit) => {
          setSpeedLimitKmh(limit ?? undefined)
          lastLookupRef.current = { lat, lng }
        })
        .catch(() => undefined)
    }
    const last = lastLookupRef.current
    if (!last || haversineMeters(last.lat, last.lng, lat, lng) > 50) {
      lookup()
    }
    const interval = setInterval(lookup, SPEED_LIMIT_REFRESH_MS)
    return () => clearInterval(interval)
    // Re-running this effect per fix (every ~1s) would defeat the throttle
    // above — only restart the interval when switching camera/losing the
    // position entirely.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [activeCameraId, position === null])

  const icon = useMemo(
    () =>
      vehicleIcon(
        row?.headingDeg,
        camera?.avatarUrl,
        activeCameraId ?? 'unassigned',
        row?.speedKmh,
        speedLimitKmh,
        settings?.speedTolerancePercent ?? 10,
      ),
    [row?.headingDeg, row?.speedKmh, camera?.avatarUrl, activeCameraId, speedLimitKmh, settings?.speedTolerancePercent],
  )

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
            <Listbox
              value={activeCameraId ?? ''}
              onChange={(id) => setSelectedCameraId(id as Id<'cameras'>)}
              className="max-w-56"
              aria-label="Select camera"
            >
              {telemetry.map((t) => (
                <ListboxOption key={t.cameraId} value={t.cameraId}>
                  <CameraAvatar
                    id={t.cameraId}
                    name={cameraName(t.cameraId)}
                    avatarUrl={cameras?.find((c) => c._id === t.cameraId)?.avatarUrl}
                    size="sm"
                    data-slot="avatar"
                  />
                  <ListboxLabel>{cameraName(t.cameraId)}</ListboxLabel>
                </ListboxOption>
              ))}
            </Listbox>
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
        <div className="mt-4 grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-6">
          <StatTile
            label="Speed"
            value={row.speedKmh !== undefined ? `${Math.round(row.speedKmh)} km/h` : '—'}
          />
          <StatTile
            label="Speed limit"
            value={speedLimitKmh !== undefined ? `${Math.round(speedLimitKmh)} km/h` : '—'}
            sub="via OpenStreetMap"
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

      {/*
        Only rendered when the phone has actually read the car over its BLE
        OBD dongle — most vehicles won't have one, and the values are sticky
        server-side (see convex/liveTelemetry.ts), so this section persists
        with the last known readings after the car link drops rather than
        disappearing mid-drive. `obdAge` is what distinguishes those two
        cases, and is measured against the phone's own reading time rather
        than the row's updatedAt: positions keep flowing at 1Hz long after
        the OBD link has gone quiet.
      */}
      {row?.obd && (
        <div className="mt-6">
          <div className="flex flex-wrap items-center gap-3">
            <Subheading>Vehicle</Subheading>
            {obdAge !== null &&
              (obdAge < LIVE_THRESHOLD_MS ? (
                <Badge color="green">CONNECTED</Badge>
              ) : (
                <Badge color="zinc">LAST SEEN {formatAge(obdAge)}</Badge>
              ))}
            {row.obd.gearPosition && <Badge color="blue">{row.obd.gearPosition}</Badge>}
            {row.obd.ecoMode && <Badge color="lime">ECO</Badge>}
            {row.obd.ePedalMode && <Badge color="purple">e-PEDAL</Badge>}
            {row.obd.powerSwitchOn === false && <Badge color="amber">IGNITION OFF</Badge>}
          </div>

          <div className="mt-3 grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-6">
            <StatTile
              label="Charge"
              value={row.obd.stateOfChargePct !== undefined ? `${row.obd.stateOfChargePct.toFixed(1)}%` : '—'}
              sub={
                row.obd.batteryHealthPct !== undefined
                  ? `${row.obd.batteryHealthPct.toFixed(1)}% health`
                  : undefined
              }
            />
            <StatTile
              label="Range"
              value={row.obd.rangeRemainingKm !== undefined ? `${Math.round(row.obd.rangeRemainingKm)} km` : '—'}
            />
            <StatTile
              label="Motor"
              value={row.obd.motorPowerW !== undefined ? `${(row.obd.motorPowerW / 1000).toFixed(1)} kW` : '—'}
              // Negative traction motor power is the car recovering energy
              // under braking, not a sensor fault — worth naming, since a
              // negative kW figure otherwise reads as a bug.
              sub={
                row.obd.motorPowerW !== undefined && row.obd.motorPowerW < 0
                  ? 'regenerating'
                  : row.obd.rpm !== undefined
                    ? `${Math.round(row.obd.rpm)} rpm`
                    : undefined
              }
            />
            <StatTile
              label="Car speed"
              value={row.obd.speedKmh !== undefined ? `${Math.round(row.obd.speedKmh)} km/h` : '—'}
              sub="vehicle, not GPS"
            />
            <StatTile
              label="HV battery"
              value={fmt(row.obd.batteryVoltage, 1, 'V')}
              sub={
                row.obd.batteryCurrentA !== undefined
                  ? `${row.obd.batteryCurrentA.toFixed(1)} A${
                      row.obd.batteryCapacityAh !== undefined
                        ? ` · ${row.obd.batteryCapacityAh.toFixed(1)} Ah`
                        : ''
                    }`
                  : undefined
              }
            />
            <StatTile
              label="Odometer"
              value={row.obd.odometerKm !== undefined ? `${Math.round(row.obd.odometerKm).toLocaleString()} km` : '—'}
            />

            <TyrePressures
              frontLeft={row.obd.tyrePressureFrontLeftKpa}
              frontRight={row.obd.tyrePressureFrontRightKpa}
              rearLeft={row.obd.tyrePressureRearLeftKpa}
              rearRight={row.obd.tyrePressureRearRightKpa}
            />
            <StatTile label="Outside" value={fmt(row.obd.ambientTempC, 1, '°C')} />
            <StatTile label="12V battery" value={fmt(row.obd.bat12vVoltage, 2, 'V')} />
          </div>
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
