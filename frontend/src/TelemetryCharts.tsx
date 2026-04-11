import type { PlotMouseEvent } from 'plotly.js'
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { collectFiniteYFromTraces, robustYAxisRange } from './chartScales'
import { plotlyInteractionConfig } from './plotlyConfig'
import { Plot } from './plotlyFactory'
import { distanceSeries } from './distanceUtils'
import {
  altitudeChartSeries,
  hasFiniteNumericInColumn,
  mapNumericColumn,
  orientationRadAt,
  telemetryLen,
} from './telemetryAccess'
import type { ComparisonPayload, RunResult, TelemetryPoint } from './types'

const PLOT_PAPER = '#fafbfc'
const PLOT_BG = '#ffffff'
const PLOT_TEXT = '#1c2333'
const PLOT_GRID = '#e2e8f0'

const axisStyle = {
  title: { font: { color: PLOT_TEXT, size: 12 } },
  tickfont: { color: PLOT_TEXT },
  gridcolor: PLOT_GRID,
  zerolinecolor: PLOT_GRID,
  linecolor: PLOT_GRID,
}

const baseLayout = {
  paper_bgcolor: PLOT_PAPER,
  plot_bgcolor: PLOT_BG,
  font: { color: PLOT_TEXT },
  dragmode: 'pan' as const,
  xaxis: axisStyle,
  yaxis: axisStyle,
}

function vlineShape(x: number) {
  return {
    type: 'line' as const,
    xref: 'x' as const,
    yref: 'paper' as const,
    x0: x,
    x1: x,
    y0: 0,
    y1: 1,
    line: { color: '#64748b', width: 1, dash: 'dot' as const },
  }
}

const BRAKE_FILL = ['rgba(220, 38, 38, 0.15)', 'rgba(234, 88, 12, 0.15)'] as const

/** Braking windows (per run) + optional scrub line — same x-axis as distance charts. */
function distanceOverlayShapes(runs: RunResult[], activeDisplayM: number | null): object[] {
  const rects = runs.flatMap((run, ri) =>
    (run.braking_intervals_m ?? []).map((iv) => ({
      type: 'rect' as const,
      xref: 'x' as const,
      yref: 'paper' as const,
      x0: iv.start_m,
      x1: iv.end_m,
      y0: 0,
      y1: 1,
      fillcolor: BRAKE_FILL[ri % BRAKE_FILL.length],
      line: { width: 0 },
      layer: 'below' as const,
    })),
  )
  return activeDisplayM != null ? [...rects, vlineShape(activeDisplayM)] : rects
}

const RAD_TO_DEG = 180 / Math.PI
const AXIS_LINE_COLORS = ['#2563eb', '#15803d', '#7c3aed'] as const

/** Skip redundant setState when Plotly re-fires hover on the same distance (~cm-level). */
const CHART_HOVER_DIST_EPS_M = 0.02

function hasFiniteNumeric(runs: RunResult[], key: keyof TelemetryPoint): boolean {
  return runs.some((r) => hasFiniteNumericInColumn(r.telemetry, key))
}

function hasXyz(
  runs: RunResult[],
  kx: keyof TelemetryPoint,
  ky: keyof TelemetryPoint,
  kz: keyof TelemetryPoint,
): boolean {
  return hasFiniteNumeric(runs, kx) && hasFiniteNumeric(runs, ky) && hasFiniteNumeric(runs, kz)
}

/** True when any optional IMU / gyro / orientation distance charts could render. */
function runsHaveExtraSensorCharts(runs: RunResult[]): boolean {
  return (
    hasXyz(runs, 'acc_x_filt', 'acc_y_filt', 'acc_z_filt') ||
    hasXyz(runs, 'total_acc_x_filt', 'total_acc_y_filt', 'total_acc_z_filt') ||
    hasXyz(runs, 'gyro_x_filt', 'gyro_y_filt', 'gyro_z_filt') ||
    hasXyz(runs, 'gravity_x_filt', 'gravity_y_filt', 'gravity_z_filt') ||
    hasXyz(runs, 'acc_uncal_x_filt', 'acc_uncal_y_filt', 'acc_uncal_z_filt') ||
    hasXyz(runs, 'gyro_uncal_x_filt', 'gyro_uncal_y_filt', 'gyro_uncal_z_filt') ||
    hasFiniteNumeric(runs, 'roll_rad_filt') ||
    hasFiniteNumeric(runs, 'roll_rad') ||
    hasFiniteNumeric(runs, 'pitch_rad_filt') ||
    hasFiniteNumeric(runs, 'pitch_rad') ||
    hasFiniteNumeric(runs, 'yaw_rad_filt') ||
    hasFiniteNumeric(runs, 'yaw_rad')
  )
}

function hoverSyncByTraceCount(traceCount: number, syncDisplayM: (m: number | null) => void) {
  return (ev: PlotMouseEvent) => {
    const p = ev.points?.[0]
    if (p?.x == null) return
    const cn = p.curveNumber
    if (cn >= 0 && cn < traceCount && typeof p.x === 'number') {
      syncDisplayM(p.x)
    }
  }
}

type Props = {
  runs: RunResult[]
  activeDisplayM: number | null
  onActiveDisplayM: (m: number | null) => void
  comparison: ComparisonPayload | null
  normalizeElevation: boolean
  yPercentileLow: number
  yPercentileHigh: number
  /** From backend viz_hints (pooled max across laps); caps symmetric Vz axis before hard ceiling. */
  vzClampHighSuggested?: number
}

export function TelemetryCharts({
  runs,
  activeDisplayM,
  onActiveDisplayM,
  comparison,
  normalizeElevation,
  yPercentileLow,
  yPercentileHigh,
  vzClampHighSuggested,
}: Props) {
  const [showExtraSensorCharts, setShowExtraSensorCharts] = useState(false)
  const hasExtraSensorData = useMemo(() => runsHaveExtraSensorCharts(runs), [runs])

  const lastSyncedDisplayMRef = useRef<number | null>(null)
  useEffect(() => {
    if (activeDisplayM != null && Number.isFinite(activeDisplayM)) {
      lastSyncedDisplayMRef.current = activeDisplayM
    }
  }, [activeDisplayM])

  const syncDisplayMFromHover = useCallback(
    (m: number | null) => {
      if (m == null || !Number.isFinite(m)) return
      const prev = lastSyncedDisplayMRef.current
      if (prev != null && Math.abs(prev - m) < CHART_HOVER_DIST_EPS_M) return
      lastSyncedDisplayMRef.current = m
      onActiveDisplayM(m)
    },
    [onActiveDisplayM],
  )

  const n = runs.length
  const lineTracesPerChart = n

  const altitudeData = runs.flatMap((run, ri) => {
    const tel = run.telemetry
    const x = distanceSeries(tel)
    const raw = altitudeChartSeries(tel)
    const y =
      normalizeElevation && raw.length
        ? raw.map((h) => h - (raw[0] ?? 0))
        : raw
    const color = run.color ?? (ri === 0 ? '#0072B2' : '#D55E00')
    return [
      {
        x,
        y,
        type: 'scatter' as const,
        mode: 'lines' as const,
        name: run.label ?? `Run ${ri + 1}`,
        line: { color, width: 2 },
      },
    ]
  })

  const vzData = runs.flatMap((run, ri) => {
    const tel = run.telemetry
    const x = distanceSeries(tel)
    const y = mapNumericColumn(tel, 'vz_m_s')
    const color = run.color ?? (ri === 0 ? '#0072B2' : '#D55E00')
    return [
      {
        x,
        y,
        type: 'scatter' as const,
        mode: 'lines' as const,
        name: run.label ?? `Run ${ri + 1}`,
        line: { color, width: 2 },
        showlegend: false,
      },
    ]
  })

  const tlen = runs.reduce((s, r) => s + telemetryLen(r.telemetry), 0)
  const brakeSig = runs.map((r) => (r.braking_intervals_m ?? []).length).join(',')
  const vzCap =
    vzClampHighSuggested != null && Number.isFinite(vzClampHighSuggested) && vzClampHighSuggested > 0
      ? Math.min(45, vzClampHighSuggested)
      : 40
  const chartDataRevision = `${n}-${tlen}-${normalizeElevation ? 'rel' : 'abs'}-${brakeSig}-yp${yPercentileLow}-${yPercentileHigh}-vz${vzCap}`
  const distShapes = distanceOverlayShapes(runs, activeDisplayM)

  const altitudeYRange = robustYAxisRange(collectFiniteYFromTraces(altitudeData), {
    lowPct: yPercentileLow,
    highPct: yPercentileHigh,
    padFraction: 0.06,
    minSpan: normalizeElevation ? 4 : 25,
  })
  const vzYRange = robustYAxisRange(collectFiniteYFromTraces(vzData), {
    lowPct: yPercentileLow,
    highPct: yPercentileHigh,
    padFraction: 0.1,
    symmetricAroundZero: true,
    clampHigh: vzCap,
    minSpan: 2,
  })

  const handleAltHover = (ev: PlotMouseEvent) => {
    const p = ev.points?.[0]
    if (p?.x == null) return
    const cn = p.curveNumber
    if (cn >= 0 && cn < lineTracesPerChart && typeof p.x === 'number') {
      syncDisplayMFromHover(p.x)
    }
  }

  const handleVzHover = (ev: PlotMouseEvent) => {
    const p = ev.points?.[0]
    if (p?.x == null) return
    const cn = p.curveNumber
    if (cn >= 0 && cn < lineTracesPerChart && typeof p.x === 'number') {
      syncDisplayMFromHover(p.x)
    }
  }

  return (
    <div className="charts-stack">
      <Plot
        data={altitudeData}
        layout={{
          ...baseLayout,
          uirevision: 'chart-altitude',
          margin: { t: 36, r: 24, b: 40, l: 48 },
          title: {
            text: normalizeElevation
              ? 'Relative altitude vs distance (red/orange = braking along trail)'
              : 'Altitude vs distance (red/orange bands = braking; hover syncs map)',
            font: { color: PLOT_TEXT, size: 14 },
          },
          xaxis: { ...baseLayout.xaxis, title: { text: 'Distance (m)' } },
          yaxis: {
            ...baseLayout.yaxis,
            title: { text: normalizeElevation ? 'Δ altitude (m)' : 'Altitude (m)' },
            ...(altitudeYRange ? { range: altitudeYRange } : {}),
          },
          showlegend: n > 1,
          datarevision: chartDataRevision,
          shapes: distShapes,
        }}
        config={plotlyInteractionConfig}
        style={{ width: '100%', height: 320 }}
        onHover={handleAltHover}
      />

      <Plot
        data={vzData}
        layout={{
          ...baseLayout,
          uirevision: 'chart-vz',
          margin: { t: 28, r: 24, b: 40, l: 48 },
          title: {
            text: 'Vertical velocity vs distance (red/orange bands = braking)',
            font: { color: PLOT_TEXT, size: 14 },
            subtitle: {
              text: `Y-axis symmetric: ~${yPercentileLow}th–${yPercentileHigh}th percentile on Vz (±${vzCap} m/s cap from data when available); spikes may clip`,
              font: { size: 10, color: '#64748b' },
            },
          },
          xaxis: { ...baseLayout.xaxis, title: { text: 'Distance (m)' } },
          yaxis: {
            ...baseLayout.yaxis,
            title: { text: 'Vz (m/s)' },
            ...(vzYRange ? { range: vzYRange } : {}),
          },
          showlegend: false,
          datarevision: chartDataRevision,
          shapes: distShapes,
        }}
        config={plotlyInteractionConfig}
        style={{ width: '100%', height: 240 }}
        onHover={handleVzHover}
      />

      {comparison && (
        <DeltaTPlot
          runs={runs}
          comparison={comparison}
          activeDisplayM={activeDisplayM}
          onActiveDisplayM={syncDisplayMFromHover}
          yPercentileLow={yPercentileLow}
          yPercentileHigh={yPercentileHigh}
          plotDataRevision={chartDataRevision}
        />
      )}

      {hasExtraSensorData && (
        <div className="charts-extra-sensor-toggle">
          <button
            type="button"
            className="charts-extra-sensor-btn"
            aria-expanded={showExtraSensorCharts}
            onClick={() => setShowExtraSensorCharts((v) => !v)}
          >
            {showExtraSensorCharts
              ? 'Hide extra sensor charts'
              : 'Show extra sensor charts (IMU, gyro, orientation, …)'}
          </button>
        </div>
      )}

      {showExtraSensorCharts && hasExtraSensorData && (
        <ExtraSensorCharts
          runs={runs}
          onActiveDisplayM={syncDisplayMFromHover}
          chartDataRevision={chartDataRevision}
          distShapes={distShapes}
          yPercentileLow={yPercentileLow}
          yPercentileHigh={yPercentileHigh}
        />
      )}
    </div>
  )
}

function ExtraSensorCharts({
  runs,
  onActiveDisplayM,
  chartDataRevision,
  distShapes,
  yPercentileLow,
  yPercentileHigh,
}: {
  runs: RunResult[]
  onActiveDisplayM: (m: number | null) => void
  chartDataRevision: string
  distShapes: object[]
  yPercentileLow: number
  yPercentileHigh: number
}) {
  if (!runsHaveExtraSensorCharts(runs)) return null

  return (
    <>
      <h3 className="sensor-section-title">
        More sensors vs distance (IMU, gravity, orientation). Y-axes use ~{yPercentileLow}th–{yPercentileHigh}th
        percentile (adjust in the bar above) with soft caps so spikes do not flatten the run; extremes can clip at the top
        or bottom of the frame.
      </h3>
      <XyzDistancePlot
        runs={runs}
        title="Linear acceleration (Accelerometer · filtered)"
        yTitle="m/s²"
        keys={['acc_x_filt', 'acc_y_filt', 'acc_z_filt']}
        yClampHigh={56}
        yMinSpan={3}
        onActiveDisplayM={onActiveDisplayM}
        chartDataRevision={chartDataRevision}
        uirevision="chart-acc-lin"
        distShapes={distShapes}
        yPercentileLow={yPercentileLow}
        yPercentileHigh={yPercentileHigh}
      />
      <XyzDistancePlot
        runs={runs}
        title="Total acceleration (includes gravity · filtered)"
        yTitle="m/s²"
        keys={['total_acc_x_filt', 'total_acc_y_filt', 'total_acc_z_filt']}
        yClampHigh={90}
        yMinSpan={4}
        onActiveDisplayM={onActiveDisplayM}
        chartDataRevision={chartDataRevision}
        uirevision="chart-acc-total"
        distShapes={distShapes}
        yPercentileLow={yPercentileLow}
        yPercentileHigh={yPercentileHigh}
      />
      <XyzDistancePlot
        runs={runs}
        title="Gyroscope (filtered)"
        yTitle="rad/s"
        keys={['gyro_x_filt', 'gyro_y_filt', 'gyro_z_filt']}
        yClampHigh={24}
        yMinSpan={0.4}
        onActiveDisplayM={onActiveDisplayM}
        chartDataRevision={chartDataRevision}
        uirevision="chart-gyro"
        distShapes={distShapes}
        yPercentileLow={yPercentileLow}
        yPercentileHigh={yPercentileHigh}
      />
      <XyzDistancePlot
        runs={runs}
        title="Gravity vector (filtered)"
        yTitle="m/s²"
        keys={['gravity_x_filt', 'gravity_y_filt', 'gravity_z_filt']}
        yClampHigh={18}
        yMinSpan={2}
        onActiveDisplayM={onActiveDisplayM}
        chartDataRevision={chartDataRevision}
        uirevision="chart-gravity"
        distShapes={distShapes}
        yPercentileLow={yPercentileLow}
        yPercentileHigh={yPercentileHigh}
      />
      <XyzDistancePlot
        runs={runs}
        title="Accelerometer uncalibrated (filtered)"
        yTitle="m/s²"
        keys={['acc_uncal_x_filt', 'acc_uncal_y_filt', 'acc_uncal_z_filt']}
        yClampHigh={85}
        yMinSpan={4}
        onActiveDisplayM={onActiveDisplayM}
        chartDataRevision={chartDataRevision}
        uirevision="chart-acc-uncal"
        distShapes={distShapes}
        yPercentileLow={yPercentileLow}
        yPercentileHigh={yPercentileHigh}
      />
      <XyzDistancePlot
        runs={runs}
        title="Gyroscope uncalibrated (filtered)"
        yTitle="rad/s"
        keys={['gyro_uncal_x_filt', 'gyro_uncal_y_filt', 'gyro_uncal_z_filt']}
        yClampHigh={28}
        yMinSpan={0.5}
        onActiveDisplayM={onActiveDisplayM}
        chartDataRevision={chartDataRevision}
        uirevision="chart-gyro-uncal"
        distShapes={distShapes}
        yPercentileLow={yPercentileLow}
        yPercentileHigh={yPercentileHigh}
      />
      <OrientationDegPlot
        runs={runs}
        onActiveDisplayM={onActiveDisplayM}
        chartDataRevision={chartDataRevision}
        distShapes={distShapes}
        yPercentileLow={yPercentileLow}
        yPercentileHigh={yPercentileHigh}
      />
    </>
  )
}

function XyzDistancePlot({
  runs,
  title,
  yTitle,
  keys,
  yClampHigh,
  yMinSpan = 2,
  onActiveDisplayM,
  chartDataRevision,
  uirevision,
  distShapes,
  yPercentileLow,
  yPercentileHigh,
}: {
  runs: RunResult[]
  title: string
  yTitle: string
  keys: [keyof TelemetryPoint, keyof TelemetryPoint, keyof TelemetryPoint]
  /** Soft ceiling on axis top (m/s² or rad/s scale); outliers can clip */
  yClampHigh?: number
  yMinSpan?: number
  onActiveDisplayM: (m: number | null) => void
  chartDataRevision: string
  uirevision: string
  distShapes: object[]
  yPercentileLow: number
  yPercentileHigh: number
}) {
  const [kx, ky, kz] = keys
  if (!hasXyz(runs, kx, ky, kz)) return null
  const axisNames = ['X', 'Y', 'Z']
  const data = runs.flatMap((run, ri) =>
    keys.map((key, ai) => ({
      x: distanceSeries(run.telemetry),
      y: mapNumericColumn(run.telemetry, key),
      type: 'scatter' as const,
      mode: 'lines' as const,
      name: `${run.label ?? `Run ${ri + 1}`} · ${axisNames[ai]}`,
      line: {
        color: AXIS_LINE_COLORS[ai],
        width: 2,
        dash: ri === 0 ? ('solid' as const) : ('dash' as const),
      },
    })),
  )
  const traceCount = data.length
  const yRange = robustYAxisRange(collectFiniteYFromTraces(data), {
    lowPct: yPercentileLow,
    highPct: yPercentileHigh,
    padFraction: 0.08,
    minSpan: yMinSpan,
    clampHigh: yClampHigh ?? null,
  })
  return (
    <Plot
      data={data}
      layout={{
        ...baseLayout,
        uirevision,
        margin: { t: 28, r: 24, b: 40, l: 52 },
        title: { text: title, font: { color: PLOT_TEXT, size: 13 } },
        xaxis: { ...baseLayout.xaxis, title: { text: 'Distance (m)' } },
        yaxis: {
          ...baseLayout.yaxis,
          title: { text: yTitle },
          ...(yRange ? { range: yRange } : {}),
        },
        showlegend: traceCount > 1,
        datarevision: chartDataRevision,
        shapes: distShapes,
      }}
      config={plotlyInteractionConfig}
      style={{ width: '100%', height: 220 }}
      onHover={hoverSyncByTraceCount(traceCount, onActiveDisplayM)}
    />
  )
}

function OrientationDegPlot({
  runs,
  onActiveDisplayM,
  chartDataRevision,
  distShapes,
  yPercentileLow,
  yPercentileHigh,
}: {
  runs: RunResult[]
  onActiveDisplayM: (m: number | null) => void
  chartDataRevision: string
  distShapes: object[]
  yPercentileLow: number
  yPercentileHigh: number
}) {
  const components: {
    label: string
    filt: keyof TelemetryPoint
    raw: keyof TelemetryPoint
  }[] = [
    { label: 'Roll', filt: 'roll_rad_filt', raw: 'roll_rad' },
    { label: 'Pitch', filt: 'pitch_rad_filt', raw: 'pitch_rad' },
    { label: 'Yaw', filt: 'yaw_rad_filt', raw: 'yaw_rad' },
  ]
  const active = components.filter((c) =>
    runs.some((r) => {
      const tel = r.telemetry
      const n = telemetryLen(tel)
      for (let i = 0; i < n; i++) {
        const rad = orientationRadAt(tel, i, c.filt, c.raw)
        if (Number.isFinite(rad)) return true
      }
      return false
    }),
  )
  if (!active.length) return null

  const oriColorIdx = (label: string) =>
    label === 'Roll' ? 0 : label === 'Pitch' ? 1 : 2
  const data = runs.flatMap((run, ri) =>
    active.map((c) => {
      const tel = run.telemetry
      const x = distanceSeries(tel)
      const n = telemetryLen(tel)
      const y = new Array<number>(n)
      for (let i = 0; i < n; i++) {
        const rad = orientationRadAt(tel, i, c.filt, c.raw)
        y[i] = Number.isFinite(rad) ? rad * RAD_TO_DEG : 0
      }
      return {
        x,
        y,
        type: 'scatter' as const,
        mode: 'lines' as const,
        name: `${run.label ?? `Run ${ri + 1}`} · ${c.label}`,
        line: {
          color: AXIS_LINE_COLORS[oriColorIdx(c.label)],
          width: 2,
          dash: ri === 0 ? ('solid' as const) : ('dash' as const),
        },
      }
    }),
  )
  const traceCount = data.length
  const oriYRange = robustYAxisRange(collectFiniteYFromTraces(data), {
    lowPct: yPercentileLow,
    highPct: yPercentileHigh,
    padFraction: 0.06,
    minSpan: 8,
    clampLow: -180,
    clampHigh: 180,
  })
  return (
    <Plot
      data={data}
      layout={{
        ...baseLayout,
        uirevision: 'chart-orientation',
        margin: { t: 28, r: 24, b: 40, l: 52 },
        title: {
          text: 'Orientation (Orientation.csv · filtered when available, degrees)',
          font: { color: PLOT_TEXT, size: 13 },
        },
        xaxis: { ...baseLayout.xaxis, title: { text: 'Distance (m)' } },
        yaxis: {
          ...baseLayout.yaxis,
          title: { text: 'deg' },
          ...(oriYRange ? { range: oriYRange } : {}),
        },
        showlegend: traceCount > 1,
        datarevision: chartDataRevision,
        shapes: distShapes,
      }}
      config={plotlyInteractionConfig}
      style={{ width: '100%', height: 220 }}
      onHover={hoverSyncByTraceCount(traceCount, onActiveDisplayM)}
    />
  )
}

function DeltaTPlot({
  runs,
  comparison,
  activeDisplayM,
  onActiveDisplayM,
  yPercentileLow,
  yPercentileHigh,
  plotDataRevision,
}: {
  runs: RunResult[]
  comparison: ComparisonPayload
  activeDisplayM: number | null
  onActiveDisplayM: (m: number | null) => void
  yPercentileLow: number
  yPercentileHigh: number
  plotDataRevision: string
}) {
  const distShapes = distanceOverlayShapes(runs, activeDisplayM)
  const xd = comparison.delta_t.distance_m
  const yd = comparison.delta_t.delta_t_s
  const hiX = comparison.high_delta_distance_m
  const hiY = hiX.map((d) => {
    let j = 0
    for (let i = 0; i < xd.length; i++) {
      if (xd[i] <= d) j = i
    }
    return yd[j] ?? 0
  })
  const dtDataRevision = `${plotDataRevision}-dt${xd.length}-${hiX.length}`
  const dtTraces = [
    {
      x: xd,
      y: yd,
      type: 'scatter' as const,
      mode: 'lines' as const,
      name: 'Δt (B−A)',
      line: { color: '#ea580c', width: 2 },
    },
    {
      x: hiX,
      y: hiY,
      type: 'scatter' as const,
      mode: 'markers' as const,
      name: 'High pace-change',
      marker: { color: '#ca8a04', size: 8, line: { color: '#fff', width: 1 } },
    },
  ]
  const dtYRange = robustYAxisRange(collectFiniteYFromTraces(dtTraces), {
    lowPct: yPercentileLow,
    highPct: yPercentileHigh,
    padFraction: 0.1,
    minSpan: 0.5,
  })
  return (
    <Plot
      data={dtTraces}
      layout={{
        ...baseLayout,
        uirevision: 'chart-delta-t',
        margin: { t: 28, r: 24, b: 40, l: 48 },
        title: { text: 'Delta-T along trail (s · lap B vs A)', font: { color: PLOT_TEXT, size: 14 } },
        xaxis: { ...baseLayout.xaxis, title: { text: 'Distance (m)' } },
        yaxis: {
          ...baseLayout.yaxis,
          title: { text: 'Δt (s)' },
          ...(dtYRange ? { range: dtYRange } : {}),
        },
        showlegend: true,
        datarevision: dtDataRevision,
        shapes: distShapes,
      }}
      config={plotlyInteractionConfig}
      style={{ width: '100%', height: 260 }}
      onHover={(ev: PlotMouseEvent) => {
        const p = ev.points?.[0]
        if (p?.curveNumber === 0 && typeof p.x === 'number') {
          onActiveDisplayM(p.x)
        }
      }}
    />
  )
}
