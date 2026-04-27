import type { PlotMouseEvent } from 'plotly.js'
import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from 'react'
import { createPortal } from 'react-dom'
import { collectFiniteYFromTraces, robustYAxisRange } from './chartScales'
import { plotlyDistanceExplorerConfig } from './plotlyConfig'
import { Plot } from './plotlyFactory'
import { buildDeltaTSlopeTraces, buildVzTonedAltitudeTraces } from './paceChartSegments'
import {
  distanceSeries,
  interpAlongDistance,
  interpTelemetryScalarAlongDistance,
} from './distanceUtils'
import { altitudeChartSeries, telemetryLen } from './telemetryAccess'
import { computeTrailSectorsSimple } from './trailSectors'
import type { CanonicalReference, ComparisonPayload, RunResult } from './types'

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

type DistanceShellId = 'delta' | 'alt'

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

type Props = {
  runs: RunResult[]
  activeDisplayM: number | null
  onActiveDisplayM: (m: number | null) => void
  comparison: ComparisonPayload | null
  /** Run B (pace) display name for live captions. */
  runLabelB?: string
  /** Canonical 1D ref for Vz-tinted altitude. */
  canonicalRef: CanonicalReference | null
  paceRunIndex?: number
  /** ~10m window from “pace loss” pin; overrides sector x-range. */
  distanceFocusRange: [number, number] | null
  onClearDistanceFocus: () => void
  normalizeElevation: boolean
  yPercentileLow: number
  yPercentileHigh: number
  baselineRunIndex?: number | null
}

function interpXYAlongDistance(xd: number[], yd: number[], distM: number): number | null {
  if (xd.length < 2 || yd.length !== xd.length) return null
  if (distM <= xd[0]!) return Number.isFinite(yd[0]!) ? yd[0]! : null
  const lastX = xd[xd.length - 1]!
  if (distM >= lastX) {
    const v = yd[yd.length - 1]!
    return Number.isFinite(v) ? v : null
  }
  let lo = 0
  let hi = xd.length - 1
  while (hi - lo > 1) {
    const mid = (lo + hi) >> 1
    if (xd[mid]! <= distM) lo = mid
    else hi = mid
  }
  const x0 = xd[lo]!
  const x1 = xd[hi]!
  const t = x1 > x0 ? (distM - x0) / (x1 - x0) : 0
  const y0 = yd[lo] ?? 0
  const y1 = yd[hi] ?? 0
  if (!Number.isFinite(y0) || !Number.isFinite(y1)) return null
  return y0 + t * (y1 - y0)
}

export function TelemetryCharts({
  runs,
  activeDisplayM,
  onActiveDisplayM,
  comparison,
  runLabelB,
  canonicalRef,
  paceRunIndex = 1,
  distanceFocusRange: distanceFocusRangeProp,
  onClearDistanceFocus,
  normalizeElevation,
  yPercentileLow,
  yPercentileHigh,
  baselineRunIndex = null,
}: Props) {
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
    const paceRef = Boolean(comparison?.pace_vs_reference)
    const doVz = paceRef

    let baselineGrid: { distance_m: (number | null)[]; vz_m_s: (number | null)[]; elevation_m?: (number | null)[] } | null = null
    if (doVz) {
      if (baselineRunIndex === null && canonicalRef?.distance_m?.length && canonicalRef?.vz_m_s?.length) {
        baselineGrid = { distance_m: canonicalRef.distance_m, vz_m_s: canonicalRef.vz_m_s, elevation_m: canonicalRef.elevation_m }
      } else if (baselineRunIndex !== null && runs[baselineRunIndex]) {
        const brun = runs[baselineRunIndex].telemetry
        const d = distanceSeries(brun)
        const vz = (brun as any).vz_smooth_m_s || (brun as any).vz_m_s
        let vza: number[] = []
        if (Array.isArray(vz)) {
           vza = vz
        } else if (Array.isArray((brun as any)[0]?.vz_m_s)) {
           vza = (brun as any).map((t: any) => t.vz_smooth_m_s ?? t.vz_m_s ?? 0)
        }
        baselineGrid = { distance_m: d, vz_m_s: vza, elevation_m: altitudeChartSeries(brun) }
      }
    }

    const altData: object[] = []
    
    if (baselineGrid && baselineGrid.elevation_m && baselineGrid.distance_m && baselineGrid.distance_m.length) {
      const b_y = normalizeElevation && baselineGrid.elevation_m.length ? baselineGrid.elevation_m.map((h) => typeof h === 'number' && typeof baselineGrid!.elevation_m![0] === 'number' ? h - baselineGrid!.elevation_m![0] : h) : baselineGrid.elevation_m;
      altData.push({
        x: baselineGrid.distance_m,
        y: b_y,
        type: 'scatter' as const,
        mode: 'lines' as const,
        name: 'Master Reference',
        line: { color: 'rgba(156, 163, 175, 0.4)', width: 8 },
        hoverinfo: 'skip' as const,
      })
    }
    for (let ri = 0; ri < n; ri++) {
      const run = runs[ri]!
      const tel = run.telemetry
      const x = distanceSeries(tel)
      const raw = altitudeChartSeries(tel)
      const y =
        normalizeElevation && raw.length ? raw.map((h) => h - (raw[0] ?? 0)) : raw
      const lineColor = run.color ?? AXIS_LINE_COLORS[ri % AXIS_LINE_COLORS.length]
      const runName = run.label ?? `Run ${ri + 1}`

      if (doVz && baselineGrid && baselineGrid.distance_m.length) {
        const getRunVz = (d: number) => {
          const a = interpTelemetryScalarAlongDistance(tel, 'vz_smooth_m_s', d)
          if (a != null && Math.abs(a) > 1e-5) return a
          return interpTelemetryScalarAlongDistance(tel, 'vz_m_s', d)
        }
        altData.push(
          ...buildVzTonedAltitudeTraces(
            x,
            y,
            baselineGrid,
            getRunVz,
            runName,
            lineColor,
          ),
        )
      } else {
        altData.push({
          x,
          y,
          type: 'scatter' as const,
          mode: 'lines' as const,
          name: `${runName} · altitude`,
          legendgroup: `alt-${ri}`,
          line: { color: lineColor, width: 1.5 },
          opacity: 0.95,
          hovertemplate: `<b>${runName}</b><br>dist %{x:.2f} m<br>alt %{y:.2f} m<extra></extra>`,
        })
      }
    }

    const tlen = runs.reduce((s, r) => s + telemetryLen(r.telemetry), 0)
    const brakeSig = runs.map((r) => (r.braking_intervals_m ?? []).length).join(',')
    const chartDataRevision = `${n}-${tlen}-${normalizeElevation ? 'rel' : 'abs'}-${brakeSig}-yp${yPercentileLow}-${yPercentileHigh}-vzt${doVz ? 1 : 0}-alt1-${baselineRunIndex}`
    const altYRange = robustYAxisRange(collectFiniteYFromTraces(altData as { y?: unknown }[]), {
      lowPct: yPercentileLow,
      highPct: yPercentileHigh,
      padFraction: 0.06,
      minSpan: normalizeElevation ? 4 : 25,
    })

    return {
      altData,
      altYRange,
      chartDataRevision,
      n,
      altTraceCount: altData.length,
      traceCountTotal: tlen,
    }
  }, [
    runs,
    normalizeElevation,
    yPercentileLow,
    yPercentileHigh,
    comparison?.pace_vs_reference,
    paceRunIndex,
    canonicalRef,
  ])

  const distShapes = useMemo(
    () => distanceOverlayShapes(runs, activeDisplayM),
    [runs, activeDisplayM],
  )

  const sectorHighlightShapes = useMemo((): object[] => {
    if (activeDisplayM == null || !Number.isFinite(activeDisplayM) || trailSectors.length === 0) return []
    const s = trailSectors.find(
      (x) => activeDisplayM >= x.d0 - 0.5 && activeDisplayM <= x.d1 + 0.5,
    )
    if (!s) return []
    return [
      {
        type: 'rect' as const,
        xref: 'x' as const,
        yref: 'paper' as const,
        x0: s.d0,
        x1: s.d1,
        y0: 0,
        y1: 1,
        fillcolor: 'rgba(13, 122, 79, 0.12)',
        line: { width: 0 },
        layer: 'below' as const,
      },
    ]
  }, [activeDisplayM, trailSectors])

  const showXRangeSlider = chartFigures.traceCountTotal < RANGE_SLIDER_MAX_POINTS

  const effectiveXRange = distanceFocusRangeProp ?? sectorRange
  const altChartTraceCount = chartFigures.altTraceCount

  const [distanceChartFullscreen, setDistanceChartFullscreen] = useState<DistanceShellId | null>(null)

  const altLayout = useMemo(
    () => ({
      ...baseLayout,
      dragmode: 'zoom' as const,
      hovermode: 'x unified' as const,
      uirevision: 'chart-alt',
      margin: { t: 32, r: 24, b: showXRangeSlider ? 56 : 40, l: 52 },
      // Match div height to avoid Plotly leaving blank paper when the parent flexes or grid stretches.
      ...(distanceChartFullscreen === 'alt'
        ? { autosize: true }
        : { autosize: false, height: 200 }),
      title: {
        text: normalizeElevation
          ? 'Altitude — relative to start'
          : Boolean(comparison?.pace_vs_reference) && canonicalRef?.vz_m_s?.length
            ? 'Topographical Overlay (Vz vs ref: blue = faster on descents, red = faster on climbs)'
            : 'Topographical Overlay',
        font: { color: PLOT_TEXT, size: 14 },
      },
      xaxis: xaxisDistanceStyle(showXRangeSlider, effectiveXRange),
      yaxis: {
        ...baseLayout.yaxis,
        title: { text: normalizeElevation ? 'Δ altitude (m)' : 'Altitude (m)' },
        ...(chartFigures.altYRange ? { range: chartFigures.altYRange } : {}),
      },
      showlegend: chartFigures.n > 1,
      datarevision: chartFigures.chartDataRevision,
      shapes: [...distShapes, ...sectorHighlightShapes],
    }),
    [
      chartFigures,
      distShapes,
      sectorHighlightShapes,
      distanceChartFullscreen,
      normalizeElevation,
      showXRangeSlider,
      yPercentileLow,
      yPercentileHigh,
      effectiveXRange,
      comparison?.pace_vs_reference,
      canonicalRef?.vz_m_s,
    ],
  )

  const handleAltHover = useCallback(
    (ev: PlotMouseEvent) => {
      const pts = ev.points
      if (!pts?.length) return
      for (const p of pts) {
        const cn = p.curveNumber
        if (cn >= 0 && cn < altChartTraceCount && p.x != null && typeof p.x === 'number') {
          syncDisplayMFromHover(p.x)
          break
        }
      }
    },
    [altChartTraceCount, syncDisplayMFromHover],
  )

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

  const { altData, chartDataRevision } = chartFigures

  const distanceExplorerHint = showXRangeSlider
    ? 'Wheel = zoom. Drag on plot = box zoom a region. Toolbar = pan, box zoom, home. Double-click = reset. Strip = scroll window along distance. Sectors above zoom the Δt and altitude charts together.'
    : 'Distance strip is off for large uploads. Wheel zoom, toolbar, double-click reset. Sectors zoom both distance charts at once.'

  const distChartsHint = `${distanceExplorerHint} Move along a chart (or the strip) to move map cursors. Leave a plot to clear.`

  const altHeight = distanceChartFullscreen === 'alt' ? '100%' : 200
  const deltaHeight = distanceChartFullscreen === 'delta' ? '100%' : 360

  const paceRef = Boolean(comparison?.pace_vs_reference)

  const hoverCaption = useMemo(() => {
    if (activeDisplayM == null) return null;

    const getVz = (run: RunResult) => {
      const a = interpTelemetryScalarAlongDistance(run.telemetry, 'vz_smooth_m_s', activeDisplayM)
      if (a != null && Math.abs(a) > 1e-5) return a
      return interpTelemetryScalarAlongDistance(run.telemetry, 'vz_m_s', activeDisplayM)
    }

    let gradeStr = '';
    let baselineSpeedStr = '';
    
    if (canonicalRef?.distance_m && canonicalRef?.grade_m_per_m) {
        const grade = interpXYAlongDistance(canonicalRef.distance_m as number[], canonicalRef.grade_m_per_m as number[], activeDisplayM);
        if (grade != null) gradeStr = `Trail Grade: ${(grade * 100).toFixed(1)}%. `;
    }

    let b_vz: number | null = null;
    if (baselineRunIndex === null && canonicalRef?.distance_m && canonicalRef?.vz_m_s) {
        b_vz = interpXYAlongDistance(canonicalRef.distance_m as number[], canonicalRef.vz_m_s as number[], activeDisplayM);
    } else if (baselineRunIndex !== null && runs[baselineRunIndex]) {
        b_vz = getVz(runs[baselineRunIndex]);
    }
    if (b_vz != null) baselineSpeedStr = `Baseline Speed (Vz): ${b_vz.toFixed(2)} m/s.`;

    let speeds = runs.map((r, i) => {
        if (i === baselineRunIndex) return null;
        const vz = getVz(r);
        if (vz != null) {
            return `${r.label ?? `Run ${i+1}`} Speed (Vz): ${vz.toFixed(2)} m/s`;
        }
        return null;
    }).filter(Boolean).join(', ');
    
    return `At ${activeDisplayM.toFixed(0)} m: ${gradeStr}${speeds ? speeds + '. ' : ''}${baselineSpeedStr}`;
  }, [activeDisplayM, canonicalRef, baselineRunIndex, runs]);

  return (
    <div>
      <p className="pace-ghost-caption" role="status" aria-live="polite" style={{ minHeight: '1.5rem', display: 'flex', alignItems: 'center' }}>
        {hoverCaption || 'Hover over charts to inspect spatial grade and vertical velocity'}
      </p>
      {distanceFocusRangeProp && (
        <p className="pace-pin-zoom-hint" role="status">
          X-axis: ~10 m around the map time-loss pin.
          <button type="button" className="pace-pin-zoom-clear" onClick={onClearDistanceFocus}>
            Clear pin zoom
          </button>
        </p>
      )}
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
                onClick={() => {
                  onClearDistanceFocus()
                  setSectorRange([s.d0, s.d1])
                }}
              >
                {s.label} · {s.d0.toFixed(0)}–{s.d1.toFixed(0)} m
              </button>
            )
          })}
          <button
            type="button"
            className="sector-ribbon-clear"
            onClick={() => {
              onClearDistanceFocus()
              setSectorRange(null)
            }}
          >
            Full run
          </button>
        </div>
      )}

      <div className="charts-stack charts-stack--dashboard">

          <DistanceChartShell
            shellId="alt"
            title="Topographical Overlay (Altitude)"
            hint={distChartsHint}
            fullscreen={distanceChartFullscreen}
            setFullscreen={setDistanceChartFullscreen}
          >
            <Plot
              data={altData}
              layout={altLayout}
              config={plotlyDistanceExplorerConfig}
              style={{ width: '100%', height: altHeight }}
              onInitialized={onAltitudePlotInitialized}
              onHover={handleAltHover}
            />
          </DistanceChartShell>
      </div>
    </div>
  )
}




