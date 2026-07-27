import type { ReactNode } from 'react'
import { Text } from './text'

export interface TimelineMarker {
  key: string
  timestamp: number
  colorClass: string
  title: string
  onClick?: () => void
  active?: boolean
}

export interface TimelineFlag {
  label: string
  icon: ReactNode
}

const TICK_COUNT = 5
const AXIS_Y = 32
const TICK_LABEL_Y = AXIS_Y + 8
const MARKER_LABEL_Y = AXIS_Y + 22
const FLAG_LABEL_Y = TICK_LABEL_Y + 14
const TIMELINE_HEIGHT = FLAG_LABEL_Y + 16

function pctFor(t: number, startTime: number, endTime: number): number {
  const span = endTime - startTime
  return span > 0 ? Math.max(0, Math.min(100, ((t - startTime) / span) * 100)) : 50
}

function shortTime(t: number): string {
  return new Date(t).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' })
}

// A real timeline axis: a horizontal spine with evenly spaced tick marks and
// time labels, plus lollipop markers whose stem runs the full distance down
// to the axis (not floating dots) with the marker's own time labelled
// underneath.
export function Timeline({
  startTime,
  endTime,
  markers,
  emptyMessage,
  legend,
  startFlag,
  endFlag,
}: {
  startTime: number
  endTime: number
  markers: TimelineMarker[]
  emptyMessage?: string
  legend?: ReactNode
  startFlag?: TimelineFlag
  endFlag?: TimelineFlag
}) {
  const ticks = Array.from({ length: TICK_COUNT }, (_, i) => {
    const t = startTime + ((endTime - startTime) * i) / (TICK_COUNT - 1)
    return { i, t, pct: (i / (TICK_COUNT - 1)) * 100, isFirst: i === 0, isLast: i === TICK_COUNT - 1 }
  })

  return (
    <div>
      {emptyMessage && markers.length === 0 && <Text className="mb-2">{emptyMessage}</Text>}
      <div className="relative" style={{ height: TIMELINE_HEIGHT }}>
        {/* axis spine */}
        <div
          className="absolute inset-x-0 bg-zinc-950/15 dark:bg-white/15"
          style={{ top: AXIS_Y, height: 1 }}
        />

        {/* tick marks + time labels, sitting below the axis */}
        {ticks.map(({ i, t, pct, isFirst, isLast }) => (
          <div key={i} className="absolute" style={{ left: `${pct}%`, top: AXIS_Y }}>
            <div className="w-px -translate-x-1/2 bg-zinc-950/25 dark:bg-white/25" style={{ height: 6 }} />
            <div
              className={`absolute whitespace-nowrap text-[10px] text-zinc-500 dark:text-zinc-400 ${
                isFirst ? 'left-0' : isLast ? 'right-0' : '-translate-x-1/2'
              }`}
              style={{ top: TICK_LABEL_Y - AXIS_Y }}
            >
              {isFirst || isLast
                ? new Date(t).toLocaleString()
                : new Date(t).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}
            </div>
          </div>
        ))}

        {/* start/end flags — rendered like markers, but with an icon instead
            of a colored dot and a location label instead of a time */}
        {startFlag && (
          <div className="absolute -translate-x-1/2" style={{ left: '0%', top: 0 }}>
            <div className="flex flex-col items-center" style={{ height: AXIS_Y }}>
              <div className="text-sm leading-none">{startFlag.icon}</div>
              <div className="w-px flex-1 bg-zinc-950/30 dark:bg-white/30" />
            </div>
            <div
              className="absolute left-0 max-w-32 truncate text-[10px] font-medium text-zinc-700 dark:text-zinc-300"
              style={{ top: FLAG_LABEL_Y }}
              title={startFlag.label}
            >
              {startFlag.label}
            </div>
          </div>
        )}
        {endFlag && (
          <div className="absolute -translate-x-1/2" style={{ left: '100%', top: 0 }}>
            <div className="flex flex-col items-center" style={{ height: AXIS_Y }}>
              <div className="text-sm leading-none">{endFlag.icon}</div>
              <div className="w-px flex-1 bg-zinc-950/30 dark:bg-white/30" />
            </div>
            <div
              className="absolute right-0 max-w-32 truncate text-right text-[10px] font-medium text-zinc-700 dark:text-zinc-300"
              style={{ top: FLAG_LABEL_Y }}
              title={endFlag.label}
            >
              {endFlag.label}
            </div>
          </div>
        )}

        {/* lollipop markers: dot + stem running the full way down to the axis */}
        {markers.map((m) => {
          const pct = pctFor(m.timestamp, startTime, endTime)
          const Tag = m.onClick ? 'button' : 'div'
          return (
            <Tag
              key={m.key}
              type={m.onClick ? 'button' : undefined}
              title={m.title}
              onClick={m.onClick}
              className="absolute -translate-x-1/2"
              style={{ left: `${pct}%`, top: 0 }}
            >
              <div className="flex flex-col items-center" style={{ height: AXIS_Y }}>
                <div
                  className={`size-2.5 shrink-0 rounded-full ${m.colorClass} ${m.onClick ? 'cursor-pointer' : ''} ${
                    m.active ? 'ring-2 ring-offset-1 ring-violet-500' : ''
                  }`}
                />
                <div className={`w-px flex-1 ${m.colorClass} opacity-60`} />
              </div>
              <div
                className="absolute left-1/2 -translate-x-1/2 whitespace-nowrap text-[9px] text-zinc-500 dark:text-zinc-400"
                style={{ top: MARKER_LABEL_Y }}
              >
                {shortTime(m.timestamp)}
              </div>
            </Tag>
          )
        })}
      </div>
      {legend && <div className="mt-2 flex flex-wrap gap-4 text-sm text-zinc-950 dark:text-white">{legend}</div>}
    </div>
  )
}
