// Small hand-rolled SVG bar chart — no chart library dependency. Single
// categorical hue per chart (per the dataviz "color follows the entity"
// rule), thin rounded-top bars, a recessive baseline, native title tooltips.
export interface BarDatum {
  label: string
  value: number
  title?: string
}

const BAR_COLOR_CLASS: Record<string, string> = {
  blue: 'fill-blue-500',
  orange: 'fill-orange-500',
  teal: 'fill-teal-500',
  amber: 'fill-amber-500',
  pink: 'fill-pink-500',
  green: 'fill-green-600',
  violet: 'fill-violet-500',
  red: 'fill-red-500',
}

export function BarChart({
  data,
  color = 'blue',
  height = 120,
  valueFormat = (v) => String(v),
  showLabels = true,
}: {
  data: BarDatum[]
  color?: keyof typeof BAR_COLOR_CLASS
  height?: number
  valueFormat?: (v: number) => string
  showLabels?: boolean
}) {
  const max = Math.max(1, ...data.map((d) => d.value))
  const barGapPct = 100 / data.length
  const barWidthPct = barGapPct * 0.62

  return (
    <div>
      <svg
        viewBox={`0 0 100 ${height}`}
        preserveAspectRatio="none"
        className="h-[var(--h)] w-full"
        style={{ '--h': `${height}px` } as React.CSSProperties}
      >
        {/* baseline */}
        <line
          x1={0}
          y1={height - 1}
          x2={100}
          y2={height - 1}
          className="stroke-zinc-950/10 dark:stroke-white/10"
          strokeWidth={0.5}
          vectorEffect="non-scaling-stroke"
        />
        {data.map((d, i) => {
          const barHeight = max > 0 ? (d.value / max) * (height - 8) : 0
          const x = i * barGapPct + (barGapPct - barWidthPct) / 2
          const y = height - 1 - barHeight
          return (
            <rect
              key={d.label + i}
              x={x}
              y={barHeight > 0 ? y : height - 1}
              width={barWidthPct}
              height={barHeight}
              rx={barWidthPct * 0.35}
              className={BAR_COLOR_CLASS[color]}
            >
              <title>{d.title ?? `${d.label}: ${valueFormat(d.value)}`}</title>
            </rect>
          )
        })}
      </svg>
      {showLabels && (
        <div className="mt-1 flex text-[10px] text-zinc-500 dark:text-zinc-400">
          {data.map((d, i) => (
            <div key={d.label + i} className="flex-1 truncate text-center" title={d.label}>
              {d.label}
            </div>
          ))}
        </div>
      )}
    </div>
  )
}

// Horizontal bar list — for ranked/categorical breakdowns (events by type,
// top locations) where the label needs real reading width.
export function HorizontalBarList({
  data,
  color = 'blue',
  valueFormat = (v) => String(v),
}: {
  data: BarDatum[]
  color?: keyof typeof BAR_COLOR_CLASS
  valueFormat?: (v: number) => string
}) {
  const max = Math.max(1, ...data.map((d) => d.value))
  const bg = BAR_COLOR_CLASS[color].replace('fill-', 'bg-')

  return (
    <div className="flex flex-col gap-2">
      {data.map((d, i) => (
        <div key={d.label + i} className="flex items-center gap-3">
          <div className="w-28 shrink-0 truncate text-xs text-zinc-700 dark:text-zinc-300" title={d.label}>
            {d.label}
          </div>
          <div className="h-2.5 flex-1 overflow-hidden rounded-full bg-zinc-950/5 dark:bg-white/10">
            <div
              className={`h-full rounded-full ${bg}`}
              style={{ width: `${Math.max(2, (d.value / max) * 100)}%` }}
              title={d.title ?? `${d.label}: ${valueFormat(d.value)}`}
            />
          </div>
          <div className="w-10 shrink-0 text-right text-xs tabular-nums text-zinc-500 dark:text-zinc-400">
            {valueFormat(d.value)}
          </div>
        </div>
      ))}
    </div>
  )
}
