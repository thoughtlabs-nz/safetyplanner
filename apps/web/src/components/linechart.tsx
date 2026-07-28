import { useEffect, useRef, useState } from 'react'

// Hand-rolled SVG time-series chart — no chart library, same house style as
// barchart.tsx. Single series by design: two measures on one plot would mean
// two y-scales, and a dual-axis chart is never the right answer (a second
// measure gets its own chart instead).
//
// Rendered in real pixel coordinates off a measured width rather than a
// stretched viewBox, because this chart carries axis text — a
// preserveAspectRatio="none" viewBox distorts glyphs and tick spacing along
// with the geometry.

export interface TimePoint {
  timestamp: number
  value: number
}

// teal-600. One step for both modes rather than a light/dark pair: it's the
// rare hue step that sits inside the lightness band AND clears 3:1 contrast
// against both the light and dark chart surfaces, so it needed no separate
// dark-mode selection. Teal specifically because this page already spends
// red/amber/green on speeding status and orange on harsh G-force — a battery
// line in any of those would read as a verdict rather than a measurement.
const SERIES_COLOR = '#0d9488'

const MARGIN = { top: 8, right: 10, bottom: 20, left: 40 }
const GRID_LINES = 4

function useMeasuredWidth<T extends HTMLElement>() {
  const ref = useRef<T>(null)
  const [width, setWidth] = useState(0)
  useEffect(() => {
    const element = ref.current
    if (!element) return
    const observer = new ResizeObserver(([entry]) => setWidth(entry.contentRect.width))
    observer.observe(element)
    setWidth(element.getBoundingClientRect().width)
    return () => observer.disconnect()
  }, [])
  return [ref, width] as const
}

export function TimeSeriesChart({
  data,
  height = 170,
  valueFormat = (v) => String(Math.round(v)),
  // Smallest y-span to display. Without a floor, a trip that used 2% of the
  // battery would fill the plot with what is really sensor jitter; with one,
  // a flat line looks flat. Not zero-based on purpose — a line encodes
  // position, not length, so the honest fix for a narrow range is a labelled
  // axis rather than dead space below the data.
  minSpan = 5,
  ariaLabel,
}: {
  data: TimePoint[]
  height?: number
  valueFormat?: (value: number) => string
  minSpan?: number
  ariaLabel?: string
}) {
  const [ref, width] = useMeasuredWidth<HTMLDivElement>()
  const [hoverIndex, setHoverIndex] = useState<number | null>(null)

  const plotWidth = Math.max(0, width - MARGIN.left - MARGIN.right)
  const plotHeight = height - MARGIN.top - MARGIN.bottom

  const values = data.map((d) => d.value)
  const rawMin = Math.min(...values)
  const rawMax = Math.max(...values)
  const mid = (rawMin + rawMax) / 2
  const span = Math.max(rawMax - rawMin, minSpan)
  const yMin = Math.min(rawMin, mid - span / 2)
  const yMax = Math.max(rawMax, mid + span / 2)

  const firstTime = data[0]?.timestamp ?? 0
  const lastTime = data[data.length - 1]?.timestamp ?? 1
  const timeSpan = Math.max(1, lastTime - firstTime)

  const xFor = (timestamp: number) => MARGIN.left + ((timestamp - firstTime) / timeSpan) * plotWidth
  const yFor = (value: number) =>
    MARGIN.top + (1 - (value - yMin) / Math.max(1e-9, yMax - yMin)) * plotHeight

  // Nothing to lay out until the container has been measured; rendering with
  // width 0 would emit a degenerate path that flashes on first paint.
  const ready = width > 0 && data.length > 1

  const linePath = ready
    ? data.map((d, i) => `${i === 0 ? 'M' : 'L'}${xFor(d.timestamp)},${yFor(d.value)}`).join(' ')
    : ''
  const areaPath = ready
    ? `${linePath} L${xFor(lastTime)},${MARGIN.top + plotHeight} L${xFor(firstTime)},${MARGIN.top + plotHeight} Z`
    : ''

  const gridValues = Array.from(
    { length: GRID_LINES + 1 },
    (_, i) => yMin + ((yMax - yMin) * i) / GRID_LINES,
  )

  function handleMove(event: React.MouseEvent<SVGSVGElement>) {
    if (!ready) return
    const rect = event.currentTarget.getBoundingClientRect()
    const x = event.clientX - rect.left - MARGIN.left
    const fraction = Math.max(0, Math.min(1, x / Math.max(1, plotWidth)))
    // Nearest by time, not by index — samples are evenly spaced in intent but
    // not in fact (a poll that returned nothing leaves a gap).
    const target = firstTime + fraction * timeSpan
    let nearest = 0
    for (let i = 1; i < data.length; i++) {
      if (Math.abs(data[i].timestamp - target) < Math.abs(data[nearest].timestamp - target)) {
        nearest = i
      }
    }
    setHoverIndex(nearest)
  }

  const hovered = hoverIndex !== null ? data[hoverIndex] : null
  // Roughly half a "88%" over a "10:42:13 AM" — see the style comment below.
  const TOOLTIP_HALF_WIDTH = 46
  const flipTooltipBelow = hovered !== null && yFor(hovered.value) < MARGIN.top + 40

  return (
    <div ref={ref} className="relative w-full">
      <svg
        width={width}
        height={height}
        role="img"
        aria-label={ariaLabel}
        onMouseMove={handleMove}
        onMouseLeave={() => setHoverIndex(null)}
      >
        {/* Recessive gridlines — hairline, solid, one step off the surface. */}
        {ready &&
          gridValues.map((value) => (
            <g key={value}>
              <line
                x1={MARGIN.left}
                y1={yFor(value)}
                x2={MARGIN.left + plotWidth}
                y2={yFor(value)}
                className="stroke-zinc-950/10 dark:stroke-white/10"
                strokeWidth={1}
              />
              <text
                x={MARGIN.left - 6}
                y={yFor(value) + 3}
                textAnchor="end"
                className="fill-zinc-500 text-[10px] tabular-nums dark:fill-zinc-400"
              >
                {valueFormat(value)}
              </text>
            </g>
          ))}

        {ready && (
          <>
            <path d={areaPath} fill={SERIES_COLOR} fillOpacity={0.14} />
            <path
              d={linePath}
              fill="none"
              stroke={SERIES_COLOR}
              strokeWidth={2}
              strokeLinecap="round"
              strokeLinejoin="round"
            />
          </>
        )}

        {/* Crosshair + marker. The marker gets a surface-colored ring so it
            stays legible where it sits on top of the line and the fill. */}
        {ready && hovered && (
          <g>
            <line
              x1={xFor(hovered.timestamp)}
              y1={MARGIN.top}
              x2={xFor(hovered.timestamp)}
              y2={MARGIN.top + plotHeight}
              className="stroke-zinc-950/25 dark:stroke-white/25"
              strokeWidth={1}
            />
            <circle
              cx={xFor(hovered.timestamp)}
              cy={yFor(hovered.value)}
              r={4}
              fill={SERIES_COLOR}
              strokeWidth={2}
              className="stroke-white dark:stroke-zinc-900"
            />
          </g>
        )}

        {/* Time axis: ends only. Intermediate ticks on a trip of arbitrary
            length collide more often than they inform, and the tooltip
            already gives an exact time for any point. */}
        {ready && (
          <>
            <text
              x={MARGIN.left}
              y={height - 6}
              className="fill-zinc-500 text-[10px] tabular-nums dark:fill-zinc-400"
            >
              {new Date(firstTime).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}
            </text>
            <text
              x={MARGIN.left + plotWidth}
              y={height - 6}
              textAnchor="end"
              className="fill-zinc-500 text-[10px] tabular-nums dark:fill-zinc-400"
            >
              {new Date(lastTime).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}
            </text>
          </>
        )}
      </svg>

      {hovered && (
        <div
          className={`pointer-events-none absolute -translate-x-1/2 rounded-md border border-zinc-950/10 bg-white px-2 py-1 text-xs shadow-sm dark:border-white/10 dark:bg-zinc-900 ${
            // Flip below the point near the top of the plot, where a tooltip
            // anchored above would be translated clean out of the container.
            flipTooltipBelow ? 'translate-y-2' : '-translate-y-full'
          }`}
          // Horizontally clamped so the first and last points don't push a
          // centred tooltip past the container edge. TOOLTIP_HALF_WIDTH is an
          // estimate rather than a measurement — the content is a formatted
          // number over a timestamp, so its width barely varies, and a
          // measure-then-reposition pass would cost a reflow per mousemove.
          style={{
            left: Math.max(
              TOOLTIP_HALF_WIDTH,
              Math.min(Math.max(TOOLTIP_HALF_WIDTH, width - TOOLTIP_HALF_WIDTH), xFor(hovered.timestamp)),
            ),
            top: flipTooltipBelow ? yFor(hovered.value) : yFor(hovered.value) - 8,
          }}
        >
          {/* The swatch carries the series identity; the text stays in ink
              tokens rather than wearing the data color. */}
          <div className="flex items-center gap-1.5 whitespace-nowrap">
            <span
              className="size-2 shrink-0 rounded-full"
              style={{ backgroundColor: SERIES_COLOR }}
            />
            <span className="font-semibold tabular-nums text-zinc-950 dark:text-white">
              {valueFormat(hovered.value)}
            </span>
          </div>
          <div className="whitespace-nowrap text-[10px] tabular-nums text-zinc-500 dark:text-zinc-400">
            {new Date(hovered.timestamp).toLocaleTimeString()}
          </div>
        </div>
      )}
    </div>
  )
}
