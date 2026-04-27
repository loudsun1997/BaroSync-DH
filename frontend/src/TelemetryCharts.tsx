import type { PlotMouseEvent } from 'plotly.js'
import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from 'react'
import { createPortal } from 'react-dom'
import { collectFiniteYFromTraces, robustYAxisRange } from './chartScales'
import { plotlyDistanceExplorerConfig, plotlyInteractionConfig } from './plotlyConfig'
import { Plot } from './plotlyFactory'
import { distanceSeries } from './distanceUtils'
import {
  altitudeChartSeries,
  hasFiniteNumericInColumn,
  mapNumericColumn,
  orientationRadAt,
  speedKmhSeries,
  telemetryLen,
  vzDisplaySeries,
} from './telemetryAccess'
import { computeTrailSectorsSimple } from './trailSectors'
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

/** Cap chart→map scrub updates (large uploads + Plotly hover are expensive). */
const ALTITUDE_SCRUB_MIN_INTERVAL_MS = 72
const AXIS_LINE_COLORS = ['#2563eb', '#15803d', '#7c3aed'] as const

function xaxisDistanceStyle(
  showRangeSlider: boolean,
  xRange: [number, number] | null,
): object {
  return {
    ...baseLayout.xaxis,
    title: { text: 'Distance (m)' },
    ...(xRange && Number.isFinite(xRange[0]) && Number.isFinite(xRange[1]) ? { range: xRange } : {}),
    showspikes: true,
    spikemode: 'across',
    spikedash: 'dot',
    spikecolor: '#94a3b8',
    spikethickness: 1,
    ...(showRangeSlider
      ? {
          rangeslider: {
            visible: true,
            thickness: 0.12,
            bgcolor: 'rgba(248, 250, 252, 0.96)',
            bordercolor: PLOT_GRID,
          },
        }
      : {}),
  }
}

/** Skip redundant setState when Plotly re-fires hover on the same distance (~cm-level). */
const CHART_HOVER_DIST_EPS_M = 0.02

/** Plotly-internal axis layout (not in public typings). */
type PlotlyAxisGeom = {
  range: [unknown, unknown]
  _offset?: number
  _length?: number
}

type PlotlyMapDiv = HTMLElement & {
  _fullLayout?: {
    xaxis?: PlotlyAxisGeom
    yaxis?: PlotlyAxisGeom
    yaxis2?: PlotlyAxisGeom
  }
}

/**
 * Map pointer position → distance (m) on the altitude chart: main XY subplot or rangeslider band (same x-axis).
 */
function distanceMFromAltitudePlotMouse(
  gd: PlotlyMapDiv,
  clientX: number,
  clientY: number,
): number | null {
  const rect = gd.getBoundingClientRect()
  const xPix = clientX - rect.left
  const yPix = clientY - rect.top
  const fl = gd._fullLayout
  const xa = fl?.xaxis
  if (!xa) return null

  const tryBand = (xaxis: PlotlyAxisGeom, yaxis: PlotlyAxisGeom | undefined): number | null => {
    if (!yaxis) return null
    const ox = xaxis._offset
    const lx = xaxis._length
    const oy = yaxis._offset
    const ly = yaxis._length
    if (typeof ox !== 'number' || typeof lx !== 'number' || typeof oy !== 'number' || typeof ly !== 'number') {
      return null
    }
    if (xPix < ox || xPix > ox + lx || yPix < oy || yPix > oy + ly) return null
    const r0 = Number(xaxis.range[0])
    const r1 = Number(xaxis.range[1])
    if (!Number.isFinite(r0) || !Number.isFinite(r1)) return null
    const frac = (xPix - ox) / lx
    const xData = r0 + frac * (r1 - r0)
    return Number.isFinite(xData) ? xData : null
  }

  const main = tryBand(xa, fl.yaxis)
  if (main != null) return main
  return tryBand(xa, fl.yaxis2)
}

/** Rangeslider redraws the full series; skip above this to keep UI responsive on huge exports. */
const RANGE_SLIDER_MAX_POINTS = 75_000

type DistanceShellId = 'delta' | 'physio' | 'speed' | 'altitude' | 'vz'

function DistanceChartShell({
  shellId,
  title,
  hint,
  fullscreen,
  setFullscreen,
  children,
}: {
  shellId: DistanceShellId
  title: string
  hint: string
  fullscreen: DistanceShellId | null
  setFullscreen: (v: DistanceShellId | null) => void
  children: ReactNode
}) {
  const isFs = fullscreen === shellId
  const header = (
    <div className="telemetry-chart-shell-header">
      <span className="telemetry-chart-shell-label">{title}</span>
      <button
        type="button"
        className="telemetry-chart-shell-btn"
        aria-expanded={isFs}
        aria-label={isFs ? 'Exit full screen' : `Full screen: ${title}`}
        onClick={() => setFullscreen(isFs ? null : shellId)}
      >
        {isFs ? 'Exit full screen' : 'Full screen'}
      </button>
    </div>
  )
  const hintEl = <p className="telemetry-chart-shell-hint">{hint}</p>
  const bodyStyle = isFs
    ? ({ flex: 1, minHeight: 0, display: 'flex', flexDirection: 'column' as const } as const)
    : undefined
  const body = (
    <div className="telemetry-chart-shell-body" style={bodyStyle}>
      {children}
    </div>
  )

  return (
    <>
      {!isFs && (
        <div className="telemetry-chart-shell">
          {header}
          {hintEl}
          {body}
        </div>
      )}
      {isFs &&
        createPortal(
          <div className="telemetry-chart-shell telemetry-chart-shell--fullscreen">
            {header}
            {hintEl}
            {body}
          </div>,
          document.body,
        )}
      {isFs && (
        <div className="telemetry-chart-shell telemetry-chart-shell--fs-placeholder">
          <span className="telemetry-chart-shell-label">{title}</span>
          <span className="telemetry-chart-shell-fs-msg"> — full screen (Esc to close)</span>
        </div>
      )}
    </>
  )
}

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
    (m: number | null, opts?: { force?: boolean }) => {
      if (m == null || !Number.isFinite(m)) return
      const prev = lastSyncedDisplayMRef.current
      if (
        !opts?.force &&
        prev != null &&
        Math.abs(prev - m) < CHART_HOVER_DIST_EPS_M
      ) {
        return
      }
      lastSyncedDisplayMRef.current = m
      onActiveDisplayM(m)
    },
    [onActiveDisplayM],
  )

  const altitudePlotDivRef = useRef<PlotlyMapDiv | null>(null)
  const [altScrubEpoch, setAltScrubEpoch] = useState(0)

  const clearMapScrubFromAltitude = useCallback(() => {
    lastSyncedDisplayMRef.current = null
    onActiveDisplayM(null)
  }, [onActiveDisplayM])

  const onAltitudePlotInitialized = useCallback((_figure: unknown, graphDiv: HTMLElement) => {
    altitudePlotDivRef.current = graphDiv as PlotlyMapDiv
    setAltScrubEpoch((n) => n + 1)
  }, [])

  useEffect(() => {
    const gd = altitudePlotDivRef.current
    if (!gd || runs.length === 0) return

    let rafId = 0
    let lastScrubEmitMs = 0
    const onMove = (ev: MouseEvent) => {
      if (ev.buttons !== 0) return
      if (rafId) return
      rafId = window.requestAnimationFrame(() => {
        rafId = 0
        const now = performance.now()
        if (now - lastScrubEmitMs < ALTITUDE_SCRUB_MIN_INTERVAL_MS) return
        const d = distanceMFromAltitudePlotMouse(gd, ev.clientX, ev.clientY)
        if (d != null) {
          lastScrubEmitMs = now
          syncDisplayMFromHover(d, { force: true })
        }
      })
    }

    const onLeave = () => {
      clearMapScrubFromAltitude()
    }

    gd.addEventListener('mousemove', onMove)
    gd.addEventListener('mouseleave', onLeave)
    return () => {
      gd.removeEventListener('mousemove', onMove)
      gd.removeEventListener('mouseleave', onLeave)
      if (rafId) window.cancelAnimationFrame(rafId)
    }
  }, [altScrubEpoch, runs.length, syncDisplayMFromHover, clearMapScrubFromAltitude])

  const [sectorRange, setSectorRange] = useState<[number, number] | null>(null)
  const trailSectors = useMemo(() => computeTrailSectorsSimple(runs[0] ?? null), [runs])
  useEffect(() => {
    setSectorRange(null)
  }, [runs])

  /**
   * react-plotly compares layout/data by reference; new objects every render force Plotly.react
   * on every parent paint and can race hover → fullLayout._has is not a function / broken unhover.
   */
  const chartFigures = useMemo(() => {
    const n = runs.length

    const physioData = runs.flatMap((run, ri) => {
      const tel = run.telemetry
      const x = distanceSeries(tel)
      const raw = altitudeChartSeries(tel)
      const y =
        normalizeElevation && raw.length ? raw.map((h) => h - (raw[0] ?? 0)) : raw
      const vzForLine = vzDisplaySeries(tel)
      const lineColor = run.color ?? AXIS_LINE_COLORS[ri % AXIS_LINE_COLORS.length]
      const runName = run.label ?? `Run ${ri + 1}`
      return [
        {
          x,
          y,
          type: 'scatter' as const,
          mode: 'lines' as const,
          name: '',
          showlegend: false,
          legendgroup: `phys-${ri}`,
          fill: 'tozeroy' as const,
          fillcolor: 'rgba(148, 163, 184, 0.28)',
          line: { width: 0 },
          hoverinfo: 'skip' as const,
        },
        {
          x,
          y,
          type: 'scatter' as const,
          mode: 'lines' as const,
          name: `${runName} · alt`,
          legendgroup: `phys-${ri}`,
          line: { color: lineColor, width: 1.5 },
          opacity: 0.9,
          hovertemplate: `<b>${runName}</b><br>dist %{x:.2f} m<br>alt %{y:.2f} m<extra></extra>`,
        },
        {
          x,
          y: vzForLine,
          type: 'scatter' as const,
          mode: 'lines' as const,
          name: `${runName} · Vz`,
          yaxis: 'y2' as const,
          legendgroup: `phys-vz-${ri}`,
          line: { color: lineColor, width: 2 },
          showlegend: true,
          hovertemplate: `<b>${runName}</b><br>dist %{x:.2f} m<br>Vz %{y:.3f} m/s<extra></extra>`,
        },
      ]
    })

    const physioAltTraces = physioData.filter((_, i) => i % 3 === 1)
    const physioVzTraces = physioData.filter((_, i) => i % 3 === 2)

    const speedData = runs.flatMap((run, ri) => {
      const tel = run.telemetry
      const x = distanceSeries(tel)
      const y = speedKmhSeries(tel)
      const lineColor = run.color ?? AXIS_LINE_COLORS[ri % AXIS_LINE_COLORS.length]
      const name = run.label ?? `Run ${ri + 1}`
      return [
        {
          x,
          y,
          type: 'scatter' as const,
          mode: 'lines' as const,
          name,
          line: { color: lineColor, width: 2 },
          hovertemplate: `<b>${name}</b><br>dist %{x:.2f} m<br>speed %{y:.2f} km/h<extra></extra>`,
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
    const physioYRange = robustYAxisRange(collectFiniteYFromTraces(physioAltTraces), {
      lowPct: yPercentileLow,
      highPct: yPercentileHigh,
      padFraction: 0.06,
      minSpan: normalizeElevation ? 4 : 25,
    })
    const physioY2Range = robustYAxisRange(collectFiniteYFromTraces(physioVzTraces), {
      lowPct: yPercentileLow,
      highPct: yPercentileHigh,
      padFraction: 0.1,
      symmetricAroundZero: true,
      clampHigh: vzCap,
      minSpan: 2,
    })
    const speedYRange = robustYAxisRange(collectFiniteYFromTraces(speedData), {
      lowPct: yPercentileLow,
      highPct: yPercentileHigh,
      padFraction: 0.08,
      minSpan: 3,
      clampLow: 0,
    })
    const vzSubtitleCap = Number(vzCap.toFixed(2))

    return {
      physioData,
      speedData,
      physioYRange,
      physioY2Range,
      speedYRange,
      chartDataRevision,
      vzSubtitleCap,
      n,
      traceCountTotal: tlen,
    }
  }, [runs, normalizeElevation, yPercentileLow, yPercentileHigh, vzClampHighSuggested])

  const distShapes = useMemo(
    () => distanceOverlayShapes(runs, activeDisplayM),
    [runs, activeDisplayM],
  )

  const showXRangeSlider = chartFigures.traceCountTotal < RANGE_SLIDER_MAX_POINTS

  const physioChartTraceCount = chartFigures.n * 3
  const speedTraceCount = chartFigures.n

  const physioLayout = useMemo(
    () => ({
      ...baseLayout,
      dragmode: 'zoom' as const,
      hovermode: 'x unified' as const,
      uirevision: 'chart-physio',
      margin: { t: 32, r: 58, b: showXRangeSlider ? 56 : 40, l: 52 },
      title: {
        text: normalizeElevation
          ? 'Altitude (gray) + Vz — relative height · braking bands'
          : 'Altitude (gray) + Vz on the right — braking bands · move pointer to sync map (leave to clear)',
        subtitle: {
          text: `Vz: ~${yPercentileLow}th–${yPercentileHigh}th · ±${chartFigures.vzSubtitleCap} m/s cap; unified hover + spikeline along distance`,
          font: { size: 10, color: '#64748b' },
        },
        font: { color: PLOT_TEXT, size: 14 },
      },
      xaxis: xaxisDistanceStyle(showXRangeSlider, sectorRange),
      yaxis: {
        ...baseLayout.yaxis,
        title: { text: normalizeElevation ? 'Δ altitude (m)' : 'Altitude (m)' },
        ...(chartFigures.physioYRange ? { range: chartFigures.physioYRange } : {}),
      },
      yaxis2: {
        ...baseLayout.yaxis,
        title: { text: 'Vz (m/s)' },
        overlaying: 'y' as const,
        side: 'right' as const,
        showgrid: false,
        ...(chartFigures.physioY2Range ? { range: chartFigures.physioY2Range } : {}),
      },
      showlegend: chartFigures.n > 1,
      datarevision: chartFigures.chartDataRevision,
      shapes: distShapes,
    }),
    [chartFigures, distShapes, normalizeElevation, showXRangeSlider, yPercentileLow, yPercentileHigh, sectorRange],
  )

  const speedLayout = useMemo(
    () => ({
      ...baseLayout,
      dragmode: 'zoom' as const,
      hovermode: 'x unified' as const,
      uirevision: 'chart-speed',
      margin: { t: 28, r: 24, b: showXRangeSlider ? 56 : 40, l: 48 },
      title: { text: 'Ground speed', font: { color: PLOT_TEXT, size: 14 } },
      xaxis: xaxisDistanceStyle(showXRangeSlider, sectorRange),
      yaxis: {
        ...baseLayout.yaxis,
        title: { text: 'km/h' },
        ...(chartFigures.speedYRange ? { range: chartFigures.speedYRange } : {}),
      },
      showlegend: chartFigures.n > 1,
      datarevision: chartFigures.chartDataRevision,
      shapes: distShapes,
    }),
    [chartFigures, distShapes, showXRangeSlider, sectorRange],
  )

  const handlePhysioHover = useCallback(
    (ev: PlotMouseEvent) => {
      const pts = ev.points
      if (!pts?.length) return
      for (const p of pts) {
        const cn = p.curveNumber
        if (cn >= 0 && cn < physioChartTraceCount && p.x != null && typeof p.x === 'number') {
          syncDisplayMFromHover(p.x)
          break
        }
      }
    },
    [physioChartTraceCount, syncDisplayMFromHover],
  )

  const handleSpeedHover = useCallback(
    (ev: PlotMouseEvent) => {
      const p = ev.points?.[0]
      if (p?.x == null) return
      const cn = p.curveNumber
      if (cn >= 0 && cn < speedTraceCount && typeof p.x === 'number') {
        syncDisplayMFromHover(p.x)
      }
    },
    [speedTraceCount, syncDisplayMFromHover],
  )

  const [distanceChartFullscreen, setDistanceChartFullscreen] = useState<DistanceShellId | null>(null)

  useEffect(() => {
    if (!distanceChartFullscreen) return
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setDistanceChartFullscreen(null)
    }
    window.addEventListener('keydown', onKey)
    const prevOverflow = document.body.style.overflow
    document.body.style.overflow = 'hidden'
    const resizeT = window.setTimeout(() => window.dispatchEvent(new Event('resize')), 60)
    return () => {
      window.removeEventListener('keydown', onKey)
      document.body.style.overflow = prevOverflow
      window.clearTimeout(resizeT)
    }
  }, [distanceChartFullscreen])

  const { physioData, speedData, chartDataRevision } = chartFigures

  const distanceExplorerHint = showXRangeSlider
    ? 'Wheel = zoom. Drag on plot = box zoom a region. Toolbar = pan, box zoom, home. Double-click = reset. Strip = scroll window along distance. Sectors above zoom all stacked charts in distance.'
    : 'Distance strip is off for large uploads. Wheel zoom, toolbar, double-click reset. Sectors zoom distance on all three charts at once.'

  const physioExplorerHint = `${distanceExplorerHint} Move along the physio or speed plot (or the strip) to move map cursors. Leave a plot to clear.`

  const physioHeight = distanceChartFullscreen === 'physio' ? '100%' : 220
  const speedHeight = distanceChartFullscreen === 'speed' ? '100%' : 180
  const deltaHeight = distanceChartFullscreen === 'delta' ? '100%' : 360

  return (
    <div>
      {trailSectors.length > 0 && (
        <div className="sector-ribbon" role="toolbar" aria-label="Distance sectors">
          <span className="sector-ribbon-label">Sectors (run 1 path)</span>
          {trailSectors.map((s) => {
            const active =
              sectorRange != null &&
              Math.abs(s.d0 - sectorRange[0]) < 0.2 &&
              Math.abs(s.d1 - sectorRange[1]) < 0.2
            return (
              <button
                key={s.id}
                type="button"
                className={active ? 'sector-ribbon-pill is-active' : 'sector-ribbon-pill'}
                onClick={() => setSectorRange([s.d0, s.d1])}
              >
                {s.label} · {s.d0.toFixed(0)}–{s.d1.toFixed(0)} m
              </button>
            )
          })}
          <button
            type="button"
            className="sector-ribbon-clear"
            onClick={() => {
              setSectorRange(null)
            }}
          >
            Full run
          </button>
        </div>
      )}

      <div className="charts-stack charts-stack--dashboard">
        {comparison && (
          <DistanceChartShell
            shellId="delta"
            title="Time delta (Δt) along distance — north star"
            hint={physioExplorerHint}
            fullscreen={distanceChartFullscreen}
            setFullscreen={setDistanceChartFullscreen}
          >
            <DeltaTPlot
              comparison={comparison}
              onActiveDisplayM={syncDisplayMFromHover}
              yPercentileLow={yPercentileLow}
              yPercentileHigh={yPercentileHigh}
              plotDataRevision={chartDataRevision}
              plotHeight={deltaHeight}
              xaxisRange={sectorRange}
              showXRangeSlider={showXRangeSlider}
              distShapes={distShapes}
            />
          </DistanceChartShell>
        )}

        <DistanceChartShell
          shellId="physio"
          title="Altitude + vertical velocity (shared x)"
          hint={physioExplorerHint}
          fullscreen={distanceChartFullscreen}
          setFullscreen={setDistanceChartFullscreen}
        >
          <Plot
            data={physioData}
            layout={physioLayout}
            config={plotlyDistanceExplorerConfig}
            style={{ width: '100%', height: physioHeight }}
            onInitialized={onAltitudePlotInitialized}
            onHover={handlePhysioHover}
          />
        </DistanceChartShell>

        <DistanceChartShell
          shellId="speed"
          title="Speed"
          hint={physioExplorerHint}
          fullscreen={distanceChartFullscreen}
          setFullscreen={setDistanceChartFullscreen}
        >
          <Plot
            data={speedData}
            layout={speedLayout}
            config={plotlyDistanceExplorerConfig}
            style={{ width: '100%', height: speedHeight }}
            onHover={handleSpeedHover}
          />
        </DistanceChartShell>
      </div>

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
  comparison,
  onActiveDisplayM,
  yPercentileLow,
  yPercentileHigh,
  plotDataRevision,
  plotHeight = 260,
  xaxisRange,
  showXRangeSlider,
  distShapes,
}: {
  comparison: ComparisonPayload
  onActiveDisplayM: (m: number | null) => void
  yPercentileLow: number
  yPercentileHigh: number
  plotDataRevision: string
  plotHeight?: number | string
  xaxisRange: [number, number] | null
  showXRangeSlider: boolean
  distShapes: object[]
}) {
  const xd = comparison.delta_t.distance_m
  const yd = comparison.delta_t.delta_t_s
  const yPos = yd.map((v) => (Number.isFinite(v) && v > 0 ? v : 0))
  const yNeg = yd.map((v) => (Number.isFinite(v) && v < 0 ? v : 0))
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
      y: yPos,
      type: 'scatter' as const,
      mode: 'lines' as const,
      name: ' ',
      showlegend: false,
      line: { width: 0 },
      fill: 'tozeroy' as const,
      fillcolor: 'rgba(220, 38, 38, 0.2)',
      hoverinfo: 'skip' as const,
    },
    {
      x: xd,
      y: yNeg,
      type: 'scatter' as const,
      mode: 'lines' as const,
      name: ' ',
      showlegend: false,
      line: { width: 0 },
      fill: 'tozeroy' as const,
      fillcolor: 'rgba(22, 163, 74, 0.2)',
      hoverinfo: 'skip' as const,
    },
    {
      x: xd,
      y: yd,
      type: 'scatter' as const,
      mode: 'lines' as const,
      name: 'Δt (B−A)',
      line: { color: '#9a3412', width: 2 },
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
        dragmode: 'zoom' as const,
        hovermode: 'x unified' as const,
        uirevision: 'chart-delta-t',
        margin: { t: 28, r: 24, b: showXRangeSlider ? 56 : 40, l: 48 },
        title: {
          text: 'Time delta (lap B vs A) — red = losing, green = gaining vs 0 s',
          font: { color: PLOT_TEXT, size: 14 },
        },
        xaxis: xaxisDistanceStyle(showXRangeSlider, xaxisRange),
        yaxis: {
          ...baseLayout.yaxis,
          title: { text: 'Δt (s)' },
          ...(dtYRange ? { range: dtYRange } : {}),
        },
        showlegend: true,
        datarevision: dtDataRevision,
        shapes: distShapes,
      }}
      config={plotlyDistanceExplorerConfig}
      style={{ width: '100%', height: plotHeight }}
      onHover={(ev: PlotMouseEvent) => {
        const p = ev.points?.[0]
        if (p && typeof p.x === 'number') onActiveDisplayM(p.x)
      }}
    />
  )
}
