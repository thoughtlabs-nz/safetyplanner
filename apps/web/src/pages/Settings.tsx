import { useEffect, useState } from 'react'
import { useAction, useConvexAuth, useMutation, useQuery } from 'convex/react'
import { api } from '../../../../convex/_generated/api'
import type { Id } from '../../../../convex/_generated/dataModel'
import { Heading, Subheading } from '../components/heading'
import { Text } from '../components/text'
import { Button } from '../components/button'
import { Input } from '../components/input'
import { Field, FieldGroup, Label } from '../components/fieldset'
import { Divider } from '../components/divider'
import { useToast } from '../components/toast'
import { useAsyncClick } from '../hooks/useAsyncClick'

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err)
}

// Full record — camera identity (name/ssid/camUrl, owned by cameras.ts) plus
// Wi-Fi/MQTT connection config (owned by devices.ts's updateDeviceConfig).
// Kept as one form/type so Add and Edit both cover every field in a single
// place — previously split across two mutations AND two separate sections
// of this page, so creating a camera couldn't set MQTT config at all and
// editing one meant hunting down a second "Device config" card below.
interface CameraFormValues {
  name: string
  ssid: string
  camUrl: string
  wifiPassword: string
  mqttHost: string
  mqttPort: number
  mqttUseTLS: boolean
  mqttUsername: string
  mqttPassword: string
  topicPrefix: string
}

// Matches convex/devices.ts's toDeviceConfig() defaults (mqttPort 8883,
// mqttUseTLS true, topicPrefix "ddpai") so an Add form left untouched saves
// the same values a brand-new camera would already have.
const EMPTY_CAMERA_FORM: CameraFormValues = {
  name: '',
  ssid: '',
  camUrl: '',
  wifiPassword: '',
  mqttHost: '',
  mqttPort: 8883,
  mqttUseTLS: true,
  mqttUsername: '',
  mqttPassword: '',
  topicPrefix: 'ddpai',
}

function CameraConfigFields({
  values,
  onChange,
}: {
  values: CameraFormValues
  onChange: (values: CameraFormValues) => void
}) {
  return (
    <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
      <Field>
        <Label>Name</Label>
        <Input
          type="text"
          placeholder="Front car"
          value={values.name}
          onChange={(e) => onChange({ ...values, name: e.target.value })}
          required
        />
      </Field>
      <Field>
        <Label>SSID</Label>
        <Input
          type="text"
          placeholder="DDPAI-XXXXXX"
          value={values.ssid}
          onChange={(e) => onChange({ ...values, ssid: e.target.value })}
          required
        />
      </Field>
      <Field>
        <Label>Camera URL</Label>
        <Input
          type="text"
          placeholder="http://193.168.0.1"
          value={values.camUrl}
          onChange={(e) => onChange({ ...values, camUrl: e.target.value })}
          required
        />
      </Field>
      <Field>
        <Label>Wi-Fi password</Label>
        <Input
          type="password"
          value={values.wifiPassword}
          onChange={(e) => onChange({ ...values, wifiPassword: e.target.value })}
        />
      </Field>
      <Field>
        <Label>Topic prefix</Label>
        <Input value={values.topicPrefix} onChange={(e) => onChange({ ...values, topicPrefix: e.target.value })} />
      </Field>
      <Field>
        <Label>MQTT host</Label>
        <Input value={values.mqttHost} onChange={(e) => onChange({ ...values, mqttHost: e.target.value })} />
      </Field>
      <Field>
        <Label>MQTT port</Label>
        <Input
          type="number"
          value={values.mqttPort}
          onChange={(e) => onChange({ ...values, mqttPort: Number(e.target.value) })}
        />
      </Field>
      <Field>
        <Label>MQTT username</Label>
        <Input value={values.mqttUsername} onChange={(e) => onChange({ ...values, mqttUsername: e.target.value })} />
      </Field>
      <Field>
        <Label>MQTT password</Label>
        <Input
          type="password"
          value={values.mqttPassword}
          onChange={(e) => onChange({ ...values, mqttPassword: e.target.value })}
        />
      </Field>
      <Field>
        <Label className="flex items-center gap-2">
          <input
            type="checkbox"
            checked={values.mqttUseTLS}
            onChange={(e) => onChange({ ...values, mqttUseTLS: e.target.checked })}
          />
          Use TLS
        </Label>
      </Field>
    </div>
  )
}

function CamerasSection() {
  const { toast } = useToast()
  const { isAuthenticated } = useConvexAuth()
  const devices = useQuery(api.devices.listAllDevices, isAuthenticated ? {} : 'skip')
  const createCamera = useMutation(api.cameras.create)
  const updateCamera = useMutation(api.cameras.update)
  const updateConfig = useMutation(api.devices.updateDeviceConfig)
  const removeCamera = useMutation(api.cameras.remove)
  const grantAccess = useMutation(api.devices.grantDeviceAccess)
  const revokeAccess = useMutation(api.devices.revokeDeviceAccess)
  const lookupByEmail = useAction(api.devices.lookupClerkUserByEmail)

  const [addForm, setAddForm] = useState<CameraFormValues>(EMPTY_CAMERA_FORM)
  const [editingId, setEditingId] = useState<Id<'cameras'> | null>(null)
  const [editForm, setEditForm] = useState<CameraFormValues>(EMPTY_CAMERA_FORM)
  const [grantEmail, setGrantEmail] = useState<Record<string, string>>({})

  // Two mutations because cameras.ts owns identity fields and devices.ts
  // owns connection config (see the CameraFormValues comment) — chaining
  // them here is what makes Add/Edit read as "one save" to the admin
  // despite the split underneath.
  async function saveConfig(cameraId: Id<'cameras'>, values: CameraFormValues) {
    await updateConfig({
      cameraId,
      wifiPassword: values.wifiPassword,
      mqttHost: values.mqttHost,
      mqttPort: values.mqttPort,
      mqttUseTLS: values.mqttUseTLS,
      mqttUsername: values.mqttUsername,
      mqttPassword: values.mqttPassword,
      topicPrefix: values.topicPrefix,
    })
  }

  const [handleAdd, adding] = useAsyncClick(async (e: React.FormEvent) => {
    e.preventDefault()
    try {
      const cameraId = await createCamera({ name: addForm.name, ssid: addForm.ssid, camUrl: addForm.camUrl })
      await saveConfig(cameraId, addForm)
      toast(`Camera "${addForm.name}" added`)
      setAddForm(EMPTY_CAMERA_FORM)
    } catch (err) {
      toast(`Couldn't add camera: ${errorMessage(err)}`, 'error')
    }
  })

  function startEdit(id: Id<'cameras'>, values: CameraFormValues) {
    setEditingId(id)
    setEditForm(values)
  }

  const [handleSaveEdit, saving] = useAsyncClick(async (id: Id<'cameras'>) => {
    try {
      await updateCamera({ id, name: editForm.name, ssid: editForm.ssid, camUrl: editForm.camUrl })
      await saveConfig(id, editForm)
      toast(`Camera "${editForm.name}" updated`)
      setEditingId(null)
    } catch (err) {
      toast(`Couldn't update camera: ${errorMessage(err)}`, 'error')
    }
  })

  const [handleRemove, removing] = useAsyncClick(async (id: Id<'cameras'>, name: string) => {
    try {
      await removeCamera({ id })
      toast(`Camera "${name}" removed`)
    } catch (err) {
      toast(`Couldn't remove camera: ${errorMessage(err)}`, 'error')
    }
  })

  const [handleGrant, granting] = useAsyncClick(async (cameraId: Id<'cameras'>) => {
    const email = grantEmail[cameraId]?.trim()
    if (!email) return
    try {
      const found = await lookupByEmail({ email })
      if (!found) {
        toast(`No Clerk user found for ${email}`, 'error')
        return
      }
      await grantAccess({ cameraId, clerkUserId: found.clerkUserId })
      toast(`Granted access to ${email}`)
      setGrantEmail({ ...grantEmail, [cameraId]: '' })
    } catch (err) {
      toast(`Couldn't grant access: ${errorMessage(err)}`, 'error')
    }
  })

  const [handleRevoke, revoking] = useAsyncClick(async (grantId: Id<'userDeviceAccess'>) => {
    try {
      await revokeAccess({ grantId })
      toast('Access revoked')
    } catch (err) {
      toast(`Couldn't revoke access: ${errorMessage(err)}`, 'error')
    }
  })

  const busy = adding || saving || removing || granting || revoking

  return (
    <div className="mt-8">
      <Subheading>Cameras</Subheading>
      <Divider className="my-3" />
      <Text className="mb-4">
        Each dashcam runs its own Wi-Fi network at the same fixed camera URL, so the network
        name (SSID) is what identifies which camera the poller is talking to. Wi-Fi/MQTT
        settings here are what the iOS app fetches on login.
      </Text>

      {devices === undefined ? (
        <Text>Loading...</Text>
      ) : (
        <>
          {devices.length > 0 && (
            <div className="mb-6 space-y-6">
              {devices.map((device) => (
                <div
                  key={device.cameraId}
                  className="rounded-lg border border-zinc-950/10 p-4 dark:border-white/10"
                >
                  {editingId === device.cameraId ? (
                    <>
                      <CameraConfigFields values={editForm} onChange={setEditForm} />
                      <div className="mt-4 flex gap-2">
                        <Button disabled={busy} onClick={() => handleSaveEdit(device.cameraId)}>
                          {saving ? 'Saving…' : 'Save'}
                        </Button>
                        <Button plain disabled={busy} onClick={() => setEditingId(null)}>
                          Cancel
                        </Button>
                      </div>
                    </>
                  ) : (
                    <div className="flex items-start justify-between gap-4">
                      <div>
                        <Text className="font-medium text-zinc-950 dark:text-white">
                          {device.name} <span className="text-zinc-500 dark:text-zinc-400">({device.ssid})</span>
                        </Text>
                        <Text className="text-sm">{device.camUrl}</Text>
                        <Text className="text-sm">
                          {device.mqttHost ? `${device.mqttHost}:${device.mqttPort}` : 'No MQTT broker configured'}
                          {device.mqttHost && !device.mqttUseTLS ? ' (no TLS)' : ''}
                        </Text>
                      </div>
                      <div className="flex shrink-0 gap-2">
                        <Button
                          plain
                          disabled={busy}
                          onClick={() =>
                            startEdit(device.cameraId, {
                              name: device.name,
                              ssid: device.ssid,
                              camUrl: device.camUrl,
                              wifiPassword: device.wifiPassword,
                              mqttHost: device.mqttHost,
                              mqttPort: device.mqttPort,
                              mqttUseTLS: device.mqttUseTLS,
                              mqttUsername: device.mqttUsername,
                              mqttPassword: device.mqttPassword,
                              topicPrefix: device.topicPrefix,
                            })
                          }
                        >
                          Edit
                        </Button>
                        <Button plain disabled={busy} onClick={() => handleRemove(device.cameraId, device.name)}>
                          Delete
                        </Button>
                      </div>
                    </div>
                  )}

                  <Divider className="my-4" />

                  <Text className="mb-2 text-xs uppercase tracking-wide">Access</Text>
                  {device.grantedTo.length === 0 ? (
                    <Text className="mb-3 text-sm">No one has access yet.</Text>
                  ) : (
                    <ul className="mb-3 space-y-1">
                      {device.grantedTo.map((grant) => (
                        <li key={grant.grantId} className="flex items-center justify-between text-sm">
                          <span className="text-zinc-700 dark:text-zinc-300">{grant.clerkUserId}</span>
                          <Button plain disabled={busy} onClick={() => handleRevoke(grant.grantId)}>
                            Revoke
                          </Button>
                        </li>
                      ))}
                    </ul>
                  )}
                  <div className="flex max-w-sm gap-2">
                    <Input
                      type="email"
                      placeholder="user@example.com"
                      value={grantEmail[device.cameraId] ?? ''}
                      onChange={(e) => setGrantEmail({ ...grantEmail, [device.cameraId]: e.target.value })}
                    />
                    <Button outline disabled={busy} onClick={() => handleGrant(device.cameraId)}>
                      {granting ? 'Granting…' : 'Grant'}
                    </Button>
                  </div>
                </div>
              ))}
            </div>
          )}

          <form onSubmit={handleAdd} className="max-w-2xl">
            <Text className="mb-3 font-medium text-zinc-950 dark:text-white">Add a camera</Text>
            <CameraConfigFields values={addForm} onChange={setAddForm} />
            <div className="mt-4">
              <Button type="submit" disabled={busy}>
                {adding ? 'Adding…' : 'Add camera'}
              </Button>
            </div>
          </form>
        </>
      )}
    </div>
  )
}

function formatCount(count: number, approximate: boolean): string {
  return approximate ? `${count.toLocaleString()}+` : count.toLocaleString()
}

const TABLE_LABELS: Record<string, string> = {
  gpsFixes: 'GPS fixes',
  accelSamples: 'Accelerometer samples',
  recordings: 'Recordings',
  gpsFiles: 'GPS files',
  journeys: 'Journeys',
  events: 'Events',
}

function DataVolumeSection() {
  const { toast } = useToast()
  const estimate = useAction(api.dataVolume.estimate)
  const [volumes, setVolumes] = useState<Record<string, { count: number; approximate: boolean }> | null>(
    null,
  )

  const [refresh, loading] = useAsyncClick(async () => {
    try {
      setVolumes(await estimate({}))
    } catch (err) {
      toast(`Couldn't load database size: ${errorMessage(err)}`, 'error')
    }
  })

  useEffect(() => {
    refresh()
  }, [])

  return (
    <div className="mt-8">
      <div className="flex items-center justify-between">
        <Subheading>Database size</Subheading>
        <Button plain onClick={refresh} disabled={loading}>
          {loading ? 'Refreshing…' : 'Refresh'}
        </Button>
      </div>
      <Divider className="my-3" />
      {volumes === null ? (
        <Text>Loading...</Text>
      ) : (
        <div className="grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-6">
          {Object.entries(volumes).map(([table, v]) => (
            <div key={table} className="rounded-lg border border-zinc-950/10 p-3 dark:border-white/10">
              <Text className="text-xs uppercase tracking-wide">{TABLE_LABELS[table] ?? table}</Text>
              <div className="mt-1 text-xl font-semibold text-zinc-950 dark:text-white">
                {formatCount(v.count, v.approximate)}
              </div>
              <Text className="text-xs">rows{v.approximate ? ' (capped estimate)' : ''}</Text>
            </div>
          ))}
        </div>
      )}
    </div>
  )
}

function Slider({
  label,
  value,
  min,
  max,
  step = 1,
  unit,
  onChange,
}: {
  label: string
  value: number
  min: number
  max: number
  step?: number
  unit: string
  onChange: (v: number) => void
}) {
  return (
    <Field>
      <div className="flex items-baseline justify-between">
        <Label>{label}</Label>
        <span className="text-sm text-zinc-500 dark:text-zinc-400">
          {value} {unit}
        </span>
      </div>
      <input
        type="range"
        min={min}
        max={max}
        step={step}
        value={value}
        onChange={(e) => onChange(Number(e.target.value))}
        className="mt-1 w-full accent-zinc-950 dark:accent-white"
      />
    </Field>
  )
}

interface RetentionFormValues {
  gpsDownsampleAfterDays: number
  gpsGranularitySeconds: number
  gpsExpireDays: number
  accelDownsampleAfterDays: number
  accelGranularitySeconds: number
  accelExpireDays: number
  retentionIntervalMinutes: number
}

type RetentionStats = { deletedExpired: number; downsampledBuckets: number; deletedRaw: number }

function formatRetentionStats(label: string, s: RetentionStats): string {
  return `${label}: ${s.deletedExpired} deleted, ${s.downsampledBuckets} downsampled (${s.deletedRaw} points thinned).`
}

const INTERVAL_OPTIONS = [
  { minutes: 60, label: 'Every hour' },
  { minutes: 360, label: 'Every 6 hours' },
  { minutes: 720, label: 'Every 12 hours' },
  { minutes: 1440, label: 'Every day' },
  { minutes: 10080, label: 'Every week' },
]

function RetentionSection() {
  const { toast } = useToast()
  const settings = useQuery(api.settings.get, {})
  const update = useMutation(api.settings.update)
  const runNow = useAction(api.retentionScheduler.runNow)
  const forceGpsNow = useAction(api.retentionScheduler.forceGpsNow)
  const forceAccelNow = useAction(api.retentionScheduler.forceAccelNow)

  const [form, setForm] = useState<RetentionFormValues | null>(null)

  useEffect(() => {
    if (settings === undefined) return
    setForm({
      gpsDownsampleAfterDays: settings.gpsDownsampleAfterDays,
      gpsGranularitySeconds: settings.gpsGranularitySeconds,
      gpsExpireDays: settings.gpsExpireDays,
      accelDownsampleAfterDays: settings.accelDownsampleAfterDays,
      accelGranularitySeconds: settings.accelGranularitySeconds,
      accelExpireDays: settings.accelExpireDays,
      retentionIntervalMinutes: settings.retentionIntervalMinutes,
    })
  }, [settings])

  const [handleSave, saving] = useAsyncClick(async (e: React.FormEvent) => {
    e.preventDefault()
    if (!form) return
    try {
      await update(form)
      toast('Retention settings saved')
    } catch (err) {
      toast(`Couldn't save retention settings: ${errorMessage(err)}`, 'error')
    }
  })

  const [handleRunNow, running] = useAsyncClick(async () => {
    try {
      const result = await runNow({})
      toast(`${formatRetentionStats('GPS', result.gps)} ${formatRetentionStats('Accel', result.accel)}`)
    } catch (err) {
      toast(`Retention run failed: ${errorMessage(err)}`, 'error')
    }
  })

  const [handleForceGpsNow, forcingGps] = useAsyncClick(async () => {
    try {
      const result = await forceGpsNow({})
      toast(formatRetentionStats('GPS', result))
    } catch (err) {
      toast(`Force run GPS failed: ${errorMessage(err)}`, 'error')
    }
  })

  const [handleForceAccelNow, forcingAccel] = useAsyncClick(async () => {
    try {
      const result = await forceAccelNow({})
      toast(formatRetentionStats('Accel', result))
    } catch (err) {
      toast(`Force run Accel failed: ${errorMessage(err)}`, 'error')
    }
  })

  return (
    <div className="mt-8">
      <Subheading>Data retention</Subheading>
      <Divider className="my-3" />
      <Text className="mb-4">
        GPS fixes and accelerometer samples are recorded at high resolution and add up fast. Points
        older than "downsample after" are thinned to one every N seconds; points older than "delete
        after" are removed entirely. Lower granularity keeps more precision but more storage.
      </Text>

      {settings === undefined || form === null ? (
        <Text>Loading...</Text>
      ) : (
        <form onSubmit={handleSave} className="max-w-2xl">
          <div className="grid grid-cols-1 gap-6 sm:grid-cols-2">
            <div className="rounded-lg border border-zinc-950/10 p-4 dark:border-white/10">
              <Text className="mb-3 font-medium text-zinc-950 dark:text-white">GPS fixes</Text>
              <FieldGroup>
                <Slider
                  label="Downsample after"
                  value={form.gpsDownsampleAfterDays}
                  min={1}
                  max={30}
                  unit="days"
                  onChange={(v) => setForm({ ...form, gpsDownsampleAfterDays: v })}
                />
                <Slider
                  label="Granularity"
                  value={form.gpsGranularitySeconds}
                  min={1}
                  max={300}
                  unit="s between points"
                  onChange={(v) => setForm({ ...form, gpsGranularitySeconds: v })}
                />
                <Slider
                  label="Delete after"
                  value={form.gpsExpireDays}
                  min={7}
                  max={365}
                  unit="days"
                  onChange={(v) => setForm({ ...form, gpsExpireDays: v })}
                />
              </FieldGroup>
            </div>

            <div className="rounded-lg border border-zinc-950/10 p-4 dark:border-white/10">
              <Text className="mb-3 font-medium text-zinc-950 dark:text-white">Accelerometer samples</Text>
              <FieldGroup>
                <Slider
                  label="Downsample after"
                  value={form.accelDownsampleAfterDays}
                  min={1}
                  max={30}
                  unit="days"
                  onChange={(v) => setForm({ ...form, accelDownsampleAfterDays: v })}
                />
                <Slider
                  label="Granularity"
                  value={form.accelGranularitySeconds}
                  min={1}
                  max={60}
                  unit="s between points"
                  onChange={(v) => setForm({ ...form, accelGranularitySeconds: v })}
                />
                <Slider
                  label="Delete after"
                  value={form.accelExpireDays}
                  min={7}
                  max={365}
                  unit="days"
                  onChange={(v) => setForm({ ...form, accelExpireDays: v })}
                />
              </FieldGroup>
            </div>
          </div>

          <div className="mt-6 max-w-sm">
            <Field>
              <Label>Run retention</Label>
              <select
                value={form.retentionIntervalMinutes}
                onChange={(e) => setForm({ ...form, retentionIntervalMinutes: Number(e.target.value) })}
                className="mt-1 block w-full rounded-lg border border-zinc-950/10 bg-transparent px-3 py-1.5 text-sm text-zinc-950 dark:border-white/10 dark:text-white"
              >
                {INTERVAL_OPTIONS.map((opt) => (
                  <option key={opt.minutes} value={opt.minutes}>
                    {opt.label}
                  </option>
                ))}
              </select>
            </Field>
          </div>

          <div className="mt-6 flex flex-wrap items-center gap-3">
            <Button type="submit" disabled={saving}>
              {saving ? 'Saving…' : 'Save'}
            </Button>
            <Button outline onClick={handleRunNow} disabled={running}>
              {running ? 'Running…' : 'Run now'}
            </Button>
          </div>

          {settings.lastRetentionRunAt && (
            <Text className="mt-3">Last ran {new Date(settings.lastRetentionRunAt).toLocaleString()}</Text>
          )}

          <Divider className="my-4" />

          <Text className="mb-2 text-xs">
            "Force run" downsamples that data to the granularity above immediately, regardless of the
            "downsample after" age — useful for testing settings without waiting. It still respects
            "delete after" (nothing is deleted early). accelSamples backlogs are often large enough
            that one press only clears part of it — press again until it reports 0 downsampled.
          </Text>
          <div className="flex flex-wrap items-center gap-3">
            <Button
              outline
              onClick={handleForceGpsNow}
              disabled={forcingGps}
              className="text-orange-600 dark:text-orange-400"
            >
              {forcingGps ? 'Running…' : 'Force run GPS'}
            </Button>
            <Button
              outline
              onClick={handleForceAccelNow}
              disabled={forcingAccel}
              className="text-orange-600 dark:text-orange-400"
            >
              {forcingAccel ? 'Running…' : 'Force run Accel'}
            </Button>
          </div>
        </form>
      )}
    </div>
  )
}

function SpeedToleranceSection() {
  const { toast } = useToast()
  const settings = useQuery(api.settings.get, {})
  const update = useMutation(api.settings.update)

  const [tolerance, setTolerance] = useState<number | null>(null)

  useEffect(() => {
    if (settings === undefined) return
    setTolerance(settings.speedTolerancePercent)
  }, [settings])

  const [handleSave, saving] = useAsyncClick(async (e: React.FormEvent) => {
    e.preventDefault()
    if (tolerance === null) return
    try {
      await update({ speedTolerancePercent: tolerance })
      toast('Speed tolerance saved')
    } catch (err) {
      toast(`Couldn't save speed tolerance: ${errorMessage(err)}`, 'error')
    }
  })

  return (
    <div className="mt-8">
      <Subheading>Speed tolerance</Subheading>
      <Divider className="my-3" />
      <Text className="mb-4">
        How far above the posted speed limit a fix can be before the Journeys map flags it as
        over limit — e.g. 10% allows 54 km/h on a 50 km/h road before it's marked speeding.
      </Text>

      {settings === undefined || tolerance === null ? (
        <Text>Loading...</Text>
      ) : (
        <form onSubmit={handleSave} className="max-w-sm">
          <FieldGroup>
            <Slider
              label="Tolerance"
              value={tolerance}
              min={0}
              max={30}
              unit="%"
              onChange={setTolerance}
            />
          </FieldGroup>
          <div className="mt-6">
            <Button type="submit" disabled={saving}>
              {saving ? 'Saving…' : 'Save'}
            </Button>
          </div>
        </form>
      )}
    </div>
  )
}

export default function Settings() {
  const { toast } = useToast()
  const settings = useQuery(api.settings.get, {})
  const update = useMutation(api.settings.update)
  const testConnection = useAction(api.overpass.testConnection)

  const [overpassUrl, setOverpassUrl] = useState('')
  const [overpassApiKey, setOverpassApiKey] = useState('')

  useEffect(() => {
    if (settings === undefined) return
    setOverpassUrl(settings.overpassUrl)
    setOverpassApiKey(settings.overpassApiKey)
  }, [settings])

  const [handleSave, saving] = useAsyncClick(async (e: React.FormEvent) => {
    e.preventDefault()
    try {
      await update({ overpassUrl, overpassApiKey })
      toast('Settings saved')
    } catch (err) {
      toast(`Couldn't save settings: ${errorMessage(err)}`, 'error')
    }
  })

  const [handleTest, testing] = useAsyncClick(async () => {
    try {
      const result = await testConnection({
        url: overpassUrl || undefined,
        apiKey: overpassApiKey || undefined,
      })
      toast(`Connected — ${result.elementCount} elements returned in ${result.elapsedMs}ms.`)
    } catch (err) {
      toast(`Overpass connection failed: ${errorMessage(err)}`, 'error')
    }
  })

  return (
    <div>
      <Heading>Settings</Heading>

      <div className="mt-6">
        <Subheading>OpenStreetMap / Overpass API</Subheading>
        <Divider className="my-3" />
        <Text className="mb-4">
          Used by the Journeys map to look up road speed limits. Leave the URL blank to use
          the public Overpass mirrors only.
        </Text>
        {settings === undefined ? (
          <Text>Loading...</Text>
        ) : (
          <form onSubmit={handleSave} className="max-w-lg">
            <FieldGroup>
              <Field>
                <Label>API URL</Label>
                <Input
                  type="text"
                  placeholder="https://overpass.example.com/api/interpreter"
                  value={overpassUrl}
                  onChange={(e) => setOverpassUrl(e.target.value)}
                />
              </Field>
              <Field>
                <Label>API Key (optional)</Label>
                <Input
                  type="password"
                  placeholder="Sent as a Bearer token, if set"
                  value={overpassApiKey}
                  onChange={(e) => setOverpassApiKey(e.target.value)}
                />
              </Field>
            </FieldGroup>

            <div className="mt-6 flex flex-wrap items-center gap-3">
              <Button type="submit" disabled={saving}>
                {saving ? 'Saving…' : 'Save'}
              </Button>
              <Button outline onClick={handleTest} disabled={testing}>
                {testing ? 'Testing…' : 'Test connection'}
              </Button>
            </div>
          </form>
        )}
      </div>

      <CamerasSection />
      <DataVolumeSection />
      <RetentionSection />
      <SpeedToleranceSection />
    </div>
  )
}
