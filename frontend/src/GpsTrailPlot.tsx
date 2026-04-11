import type { PlotMouseEvent } from 'plotly.js'
import { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react'
import { robustColorScaleRange } from './chartScales'
import { plotlyInteractionConfig } from './plotlyConfig'
import { Plot } from './plotlyFactory'
import { distanceSeries, interpAlongDistance, nearestIndexForDistanceM } from './distanceUtils'
import { gateLineFromMeta, gateLineFromPreview, nearestIndexOnTrail, perpendicularGateLonLat } from './gateGeometry'
import { latAt, lonAt, numAt, telemetryLen, telemetryLonLatArrays } from './telemetryAccess'
import type { AlignmentMeta, ComparisonPayload, GatePreview, RunResult, TrailColorMetric } from './types'

/** Pooled server hints when every run has them (fair color scale across laps). */
function pooledMapColorBoundsFromServer(
  runs: RunResult[],
  metric: TrailColorMetric,
): [number, number] | undefined {
  if (metric !== 'vz' && metric !== 'g') return undefined
  const k = metric === 'vz' ? 'vz' : 'g'
  const bounds = runs.map((r) => r.viz_hints?.map?.[k])
  if (bounds.length !== runs.length || bounds.some((b) => b == null)) return undefined
  const list = bounds as { cmin: number; cmax: number }[]
  const cmin = Math.min(...list.map((b) => b.cmin))
  const cmax = Math.max(...list.map((b) => b.cmax))
  if (!Number.isFinite(cmin) || !Number.isFinite(cmax) || cmax <= cmin) return undefined
  return [cmin, cmax]
}

const PLOT_PAPER = '#fafbfc'
const PLOT_BG = '#ffffff'
const PLOT_TEXT = '#1c2333'
const PLOT_GRID = '#e2e8f0'

type Props = {
  runs: RunResult[]
  activeDisplayM: number | null
  onActiveDisplayM: (m: number | null) => void
  colorMetric: TrailColorMetric
  comparison: ComparisonPayload | null
  alignment: AlignmentMeta | null | undefined
  gatePreview: GatePreview | null | undefined
  gatePickMode: boolean
  gateLatitude: number | null
  gateLongitude: number | null
  onGateLocation: (lat: number, lon: number) => void
}

function metricZ(
  run: RunResult,
  colorMetric: TrailColorMetric,
  comparison: ComparisonPayload | null,
): number[] {
  const tel = run.telemetry
  const n = telemetryLen(tel)
  const z = new Array<number>(n)
  for (let i = 0; i < n; i++) {
    switch (colorMetric) {
      case 'g':
        z[i] = numAt(tel, 'g_total', i)
        break
      case 'variance':
        z[i] = numAt(tel, 'vz_rolling_std', i)
        break
      case 'jerk':
        z[i] = numAt(tel, 'jerk_magnitude_ms3', i)
        break
      case 'delta_t':
        z[i] = interpAlongDistance(comparison, numAt(tel, 'distance_m', i)) ?? 0
        break
      case 'braking':
        z[i] = numAt(tel, 'mtb_braking_intensity', i)
        break
      case 'lean_mtb':
        z[i] = numAt(tel, 'mtb_lean_deg', i)
        break
      case 'vz':
      default:
        z[i] = numAt(tel, 'vz_m_s', i)
        break
    }
  }
  return z
}

function colorbarTitle(metric: TrailColorMetric): string {
  switch (metric) {
    case 'g':
      return 'g'
    case 'variance':
      return 'Vz σ (m/s)'
    case 'jerk':
      return '|Jerk| (m/s³)'
    case 'delta_t':
      return 'Δt (s)'
    case 'braking':
      return 'Braking intensity (m/s²)'
    case 'lean_mtb':
      return 'Lean (°)'
    case 'vz':
    default:
      return 'Vz (m/s)'
  }
}

function mapHintForMetric(metric: TrailColorMetric): string {
  switch (metric) {
    case 'g':
      return 'Colors show total acceleration magnitude (g); scale is fixed ~0.5–4 g so vibration spikes clip at the top instead of flattening the lap.'
    case 'variance':
      return 'Colors show rolling std-dev of vertical velocity (rougher = higher).'
    case 'jerk':
      return 'Colors show jerk magnitude along the trail.'
    case 'delta_t':
      return 'Colors show time delta between laps (B−A) at each distance.'
    case 'braking':
      return 'Colors show braking intensity from longitudinal acceleration.'
    case 'lean_mtb':
      return 'Colors show estimated lean angle from gravity in the bike frame.'
    case 'vz':
    default:
      return 'Colors show barometer vertical velocity (uphill vs downhill); limits use full-rate server hints when present, else ~1st–99th percentile on the trail data (padding + min span).'
  }
}

function escapeHoverText(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
}

/** Offset from pointer; flip when near viewport edges so the tip stays readable. */
function cursorTooltipPosition(clientX: number, clientY: number): { left: number; top: number } {
  const margin = 10
  const offset = 18
  const estW = 260
  const estH = 88
  let left = clientX + offset
  let top = clientY + offset
  if (left + estW > window.innerWidth - margin) left = clientX - estW - offset
  if (top + estH > window.innerHeight - margin) top = clientY - estH - offset
  if (left < margin) left = margin
  if (top < margin) top = margin
  return { left, top }
}

function lonLatLines(lat: unknown, lon: unknown): string {
  const la = typeof lat === 'number' ? lat : Number(lat)
  const lo = typeof lon === 'number' ? lon : Number(lon)
  if (!Number.isFinite(la) || !Number.isFinite(lo)) return ''
  return `<br>lat ${la.toFixed(6)}<br>lon ${lo.toFixed(6)}`
}

/** Rich hover line: ordinal lap name + optional ZIP stem (same on every point of the trace). */
function gpsTrailHoverHtml(run: RunResult, ri: number): string {
  const label = escapeHoverText(run.label ?? `Run ${ri + 1}`)
  const src = run.source_name?.trim()
  if (src) {
    return `<b>${label}</b><br>${escapeHoverText(src)}`
  }
  return `<b>${label}</b>`
}

type GpsBounds = { minLon: number; maxLon: number; minLat: number; maxLat: number }

/** Min/max without spread — `Math.min(...arr)` overflows the call stack for large trails (~100k+ points). */
function parallelLonLatBounds(xs: number[], ys: number[]): GpsBounds {
  let minLon = xs[0]
  let maxLon = xs[0]
  let minLat = ys[0]
  let maxLat = ys[0]
  for (let i = 1; i < xs.length; i++) {
    const x = xs[i]
    const y = ys[i]
    if (x < minLon) minLon = x
    if (x > maxLon) maxLon = x
    if (y < minLat) minLat = y
    if (y > maxLat) maxLat = y
  }
  return { minLon, maxLon, minLat, maxLat }
}

function gatherGpsBounds(
  runs: RunResult[],
  virtualGateLine: { lon: number[]; lat: number[] } | null,
  gateLatitude: number | null,
  gateLongitude: number | null,
  snappedA: { lat: number; lon: number } | null,
  snappedB: { lat: number; lon: number } | null,
): GpsBounds | null {
  const xs: number[] = []
  const ys: number[] = []
  for (const r of runs) {
    const tel = r.telemetry
    const n = telemetryLen(tel)
    for (let i = 0; i < n; i++) {
      const lo = lonAt(tel, i)
      const la = latAt(tel, i)
      if (Number.isFinite(lo) && Number.isFinite(la)) {
        xs.push(lo)
        ys.push(la)
      }
    }
  }
  if (virtualGateLine) {
    const { lon, lat } = virtualGateLine
    for (let i = 0; i < lon.length; i++) {
      if (Number.isFinite(lon[i]) && Number.isFinite(lat[i])) {
        xs.push(lon[i])
        ys.push(lat[i])
      }
    }
  }
  if (
    gateLongitude != null &&
    gateLatitude != null &&
    Number.isFinite(gateLongitude) &&
    Number.isFinite(gateLatitude)
  ) {
    xs.push(gateLongitude)
    ys.push(gateLatitude)
  }
  if (snappedA && Number.isFinite(snappedA.lon) && Number.isFinite(snappedA.lat)) {
    xs.push(snappedA.lon)
    ys.push(snappedA.lat)
  }
  if (snappedB && Number.isFinite(snappedB.lon) && Number.isFinite(snappedB.lat)) {
    xs.push(snappedB.lon)
    ys.push(snappedB.lat)
  }
  if (!xs.length) return null
  return parallelLonLatBounds(xs, ys)
}

/** Padded axis ranges + CSS aspect ratio (width/height) matching geographic extent so scaleanchor doesn’t letterbox. */
function tightGpsView(
  raw: GpsBounds,
): {
  rangeLon: [number, number]
  rangeLat: [number, number]
  geoAspect: number
  lonLatRatio: number
} {
  const MIN_SPAN_DEG = 0.00035
  const PAD_FRAC = 0.12
  const spanLon = Math.max(raw.maxLon - raw.minLon, MIN_SPAN_DEG)
  const spanLat = Math.max(raw.maxLat - raw.minLat, MIN_SPAN_DEG)
  const padLon = Math.max(spanLon * PAD_FRAC, MIN_SPAN_DEG * 0.45)
  const padLat = Math.max(spanLat * PAD_FRAC, MIN_SPAN_DEG * 0.45)
  const rangeLon: [number, number] = [raw.minLon - padLon, raw.maxLon + padLon]
  const rangeLat: [number, number] = [raw.minLat - padLat, raw.maxLat + padLat]
  const midLatRad = ((rangeLat[0] + rangeLat[1]) / 2) * (Math.PI / 180)
  const lonLatRatio = 1 / Math.max(Math.cos(midLatRad), 0.2)
  const effW = (rangeLon[1] - rangeLon[0]) * Math.cos(midLatRad)
  const effH = rangeLat[1] - rangeLat[0]
  let geoAspect = effW / Math.max(effH, 1e-9)
  geoAspect = Math.min(2.85, Math.max(0.35, geoAspect))
  return { rangeLon, rangeLat, geoAspect, lonLatRatio }
}

/** Robust Plotly cmin/cmax: pooled across all laps for consistent legend; outliers clip at ends. */
function trailMapColorBounds(allZ: number[], metric: TrailColorMetric): [number, number] | undefined {
  switch (metric) {
    case 'g':
      return [0.5, 4.0]
    case 'vz':
      // Wider than p2–p98 + tiny minSpan: baro Vz is noisy; a ~6 m/s window saturates most of the lap.
      return (
        robustColorScaleRange(allZ, {
          lowPct: 1,
          highPct: 99,
          padFraction: 0.14,
          minSpan: 8,
          clampLow: -45,
          clampHigh: 45,
        }) ?? [-14, 14]
      )
    case 'variance':
      return robustColorScaleRange(allZ, { lowPct: 2, highPct: 98, minSpan: 0.05, clampLow: 0, clampHigh: 12 })
    case 'jerk':
      return robustColorScaleRange(allZ, { lowPct: 2, highPct: 98, minSpan: 1, clampLow: 0, clampHigh: 150 })
    case 'delta_t':
      return robustColorScaleRange(allZ, {
        symmetricAroundZero: true,
        highPct: 98,
        padFraction: 0.1,
        minSpan: 0.4,
        clampHigh: 90,
      })
    case 'braking':
      return robustColorScaleRange(allZ, { lowPct: 2, highPct: 98, minSpan: 0.4, clampLow: 0, clampHigh: 20 })
    case 'lean_mtb':
      return robustColorScaleRange(allZ, { lowPct: 2, highPct: 98, minSpan: 4, clampLow: 0, clampHigh: 62 })
    default:
      return robustColorScaleRange(allZ, { lowPct: 2, highPct: 98, minSpan: 1 })
  }
}

function colorscaleFor(metric: TrailColorMetric): string | [number, string][] {
  switch (metric) {
    case 'delta_t':
      return 'RdBu'
    case 'variance':
    case 'jerk':
      return 'YlOrRd'
    case 'braking':
      return 'YlOrRd'
    case 'lean_mtb':
      return [
        [0, '#0f172a'],
        [0.35, '#1d4ed8'],
        [0.65, '#6366f1'],
        [1, '#7e22ce'],
      ] as [number, string][]
    case 'g':
      return 'Viridis'
    case 'vz':
    default:
      return 'RdYlBu'
  }
}

export function GpsTrailPlot({
  runs,
  activeDisplayM,
  onActiveDisplayM,
  colorMetric,
  comparison,
  alignment,
  gatePreview,
  gatePickMode,
  gateLatitude,
  gateLongitude,
  onGateLocation,
}: Props) {
  const trailBearingDeg =
    alignment?.trail_bearing_deg_clockwise_from_north_a ?? gatePreview?.trail_bearing_deg_clockwise_from_north_a

  const virtualGateLine = useMemo(() => {
    const fromAlign = gateLineFromMeta(alignment)
    if (fromAlign) return fromAlign
    const fromPreview = gateLineFromPreview(gatePreview)
    if (fromPreview) return fromPreview
    const t0 = runs[0]?.telemetry
    if (gateLatitude != null && gateLongitude != null && t0 != null && telemetryLen(t0) >= 2) {
      const ix = nearestIndexOnTrail(t0, gateLatitude, gateLongitude)
      return perpendicularGateLonLat(t0, ix, 12)
    }
    return null
  }, [alignment, gatePreview, gateLatitude, gateLongitude, runs])

  const snappedA = (() => {
    const alat = alignment?.gate_snapped_latitude_a
    const alon = alignment?.gate_snapped_longitude_a
    if (alat != null && alon != null) return { lat: alat, lon: alon }
    const plat = gatePreview?.gate_snapped_latitude_a
    const plon = gatePreview?.gate_snapped_longitude_a
    if (plat != null && plon != null) return { lat: plat, lon: plon }
    return null
  })()
  const snappedB = (() => {
    const alat = alignment?.gate_snapped_latitude_b
    const alon = alignment?.gate_snapped_longitude_b
    if (alat != null && alon != null) return { lat: alat, lon: alon }
    const plat = gatePreview?.gate_snapped_latitude_b
    const plon = gatePreview?.gate_snapped_longitude_b
    if (plat != null && plon != null) return { lat: plat, lon: plon }
    return null
  })()

  const gpsBoundsRaw = useMemo(
    () =>
      gatherGpsBounds(runs, virtualGateLine, gateLatitude, gateLongitude, snappedA, snappedB),
    [runs, virtualGateLine, gateLatitude, gateLongitude, snappedA, snappedB],
  )
  const gpsView = useMemo(() => (gpsBoundsRaw ? tightGpsView(gpsBoundsRaw) : null), [gpsBoundsRaw])

  const mapColorBounds = useMemo(() => {
    const fromServer = pooledMapColorBoundsFromServer(runs, colorMetric)
    if (fromServer != null) return fromServer
    const allZ: number[] = []
    for (const run of runs) {
      allZ.push(...metricZ(run, colorMetric, comparison))
    }
    return trailMapColorBounds(allZ, colorMetric)
  }, [runs, colorMetric, comparison])

  // Bump only when map *data* changes — not on scrub (activeDisplayM), or Plotly resets zoom on every hover.
  const dataRevision = useMemo(
    () =>
      `${runs.length}-${colorMetric}-${gatePickMode}-${gateLatitude ?? 'n'}-${virtualGateLine ? 'g' : 'n'}-${snappedA ? 'a' : ''}${snappedB ? 'b' : ''}`,
    [runs.length, colorMetric, gatePickMode, gateLatitude, virtualGateLine, snappedA, snappedB],
  )

  const lonLatRatio = gpsView?.lonLatRatio ?? 1.25
  const xaxisRange = gpsView ? gpsView.rangeLon : undefined
  const yaxisRange = gpsView ? gpsView.rangeLat : undefined
  const geoAspect = gpsView?.geoAspect ?? 1.2

  const plotData = useMemo(() => {
    const traces: object[] = []
    runs.forEach((run, ri) => {
      const tel = run.telemetry
      const n = telemetryLen(tel)
      if (n === 0) return
      const { lon, lat } = telemetryLonLatArrays(tel)
      const baseColor = run.color ?? '#94a3b8'
      traces.push({
        x: lon,
        y: lat,
        type: 'scattergl',
        mode: 'lines',
        name: `${run.label ?? `Run ${ri + 1}`} · path`,
        line: { color: baseColor, width: 2.5 },
        opacity: 0.5,
        hoverinfo: 'skip',
        showlegend: false,
      })
      const z = metricZ(run, colorMetric, comparison)
      const hoverHtml = gpsTrailHoverHtml(run, ri)
      traces.push({
        x: lon,
        y: lat,
        type: 'scatter',
        mode: 'markers',
        name: run.label ?? `Run ${ri + 1}`,
        marker: {
          color: z,
          colorscale: colorscaleFor(colorMetric),
          cauto: mapColorBounds == null,
          ...(mapColorBounds != null ? { cmin: mapColorBounds[0], cmax: mapColorBounds[1] } : {}),
          size: 5,
          opacity: 0.88,
          line: { width: 0 },
          showscale: ri === 0,
          colorbar:
            ri === 0
              ? {
                  title: {
                    text: colorbarTitle(colorMetric),
                    font: { color: PLOT_TEXT, size: 11 },
                    side: 'right',
                  },
                  tickfont: { color: PLOT_TEXT, size: 10 },
                  x: 1.02,
                  xanchor: 'left',
                  xpad: 6,
                  len: 0.7,
                  thickness: 14,
                  outlinewidth: 0,
                  bgcolor: 'rgba(255,255,255,0.85)',
                }
              : undefined,
        },
        text: Array.from({ length: n }, () => hoverHtml),
        hovertemplate: '%{text}<br>lat %{y:.6f}<br>lon %{x:.6f}<extra></extra>',
        showlegend: runs.length > 1,
      })
    })

    if (virtualGateLine) {
      const gateHover =
        trailBearingDeg != null
          ? `Virtual gate · trail heading ≈ ${trailBearingDeg.toFixed(0)}° clockwise from north (gate runs E-W if you ride north)<extra></extra>`
          : 'Virtual gate · perpendicular to trail heading at snapped point<extra></extra>'
      traces.push({
        x: virtualGateLine.lon,
        y: virtualGateLine.lat,
        type: 'scatter',
        mode: 'lines',
        name: 'Virtual start gate',
        line: { color: '#16a34a', width: 3 },
        hovertemplate: gateHover,
        showlegend: true,
      })
    }

    if (gateLatitude != null && gateLongitude != null) {
      traces.push({
        x: [gateLongitude],
        y: [gateLatitude],
        type: 'scatter',
        mode: 'markers',
        name: 'Map click (anchor)',
        marker: {
          color: '#e85d04',
          size: 16,
          symbol: 'x',
          line: { color: '#fff', width: 2 },
        },
        hovertemplate: 'Map click (rough anchor)<br>lat %{y:.6f}<br>lon %{x:.6f}<extra></extra>',
        showlegend: true,
      })
    }

    if (snappedA) {
      const c0 = runs[0]?.color ?? '#0072B2'
      const h0 = runs[0] ? `GPS snap — ${gpsTrailHoverHtml(runs[0], 0)}` : 'GPS snap — First run'
      traces.push({
        x: [snappedA.lon],
        y: [snappedA.lat],
        type: 'scatter',
        mode: 'markers',
        name: 'Snapped Run A',
        marker: { color: c0, size: 11, symbol: 'diamond', line: { color: '#fff', width: 1 } },
        text: [h0],
        hovertemplate: '%{text}<br>lat %{y:.6f}<br>lon %{x:.6f}<extra></extra>',
        showlegend: true,
      })
    }
    if (snappedB) {
      const c1 = runs[1]?.color ?? '#D55E00'
      const h1 = runs[1] ? `GPS snap — ${gpsTrailHoverHtml(runs[1], 1)}` : 'GPS snap — Second run'
      traces.push({
        x: [snappedB.lon],
        y: [snappedB.lat],
        type: 'scatter',
        mode: 'markers',
        name: 'Snapped Run B',
        marker: { color: c1, size: 11, symbol: 'square', line: { color: '#fff', width: 1 } },
        text: [h1],
        hovertemplate: '%{text}<br>lat %{y:.6f}<br>lon %{x:.6f}<extra></extra>',
        showlegend: true,
      })
    }

    runs.forEach((run, ri) => {
      const tel = run.telemetry
      if (telemetryLen(tel) === 0 || activeDisplayM == null) return
      const idx = nearestIndexForDistanceM(tel, activeDisplayM)
      traces.push({
        x: [lonAt(tel, idx)],
        y: [latAt(tel, idx)],
        type: 'scatter',
        mode: 'markers',
        name: `Cursor ${run.label ?? ri + 1}`,
        marker: {
          color: run.color ?? '#e85d04',
          size: 14,
          line: { color: '#fff', width: 2 },
          symbol: 'circle',
        },
        text: [`Chart scrub — ${gpsTrailHoverHtml(run, ri)}`],
        hovertemplate: '%{text}<br>lat %{y:.6f}<br>lon %{x:.6f}<extra></extra>',
        showlegend: false,
      })
    })

    return traces
  }, [
    runs,
    colorMetric,
    comparison,
    mapColorBounds,
    virtualGateLine,
    gateLatitude,
    gateLongitude,
    trailBearingDeg,
    snappedA,
    snappedB,
    activeDisplayM,
  ])

  const plotLayout = useMemo(
    () => ({
      margin: { t: 52, r: 88, b: 88, l: 58 },
      uirevision: 'gps-trail',
      title: {
        text: gatePickMode ? 'Click the trail to set the start gate' : 'Trail map',
        font: { color: PLOT_TEXT, size: 16, family: 'IBM Plex Sans, Segoe UI, system-ui, sans-serif' },
        x: 0,
        xanchor: 'left',
      },
      paper_bgcolor: PLOT_PAPER,
      plot_bgcolor: PLOT_BG,
      font: { color: PLOT_TEXT, family: 'IBM Plex Sans, Segoe UI, system-ui, sans-serif' },
      xaxis: {
        title: { text: 'Longitude (°)', standoff: 14, font: { size: 12 } },
        tickfont: { size: 10 },
        gridcolor: PLOT_GRID,
        zerolinecolor: PLOT_GRID,
        scaleanchor: 'y',
        scaleratio: lonLatRatio,
        range: xaxisRange,
        autorange: gpsView ? false : true,
      },
      yaxis: {
        title: { text: 'Latitude (°)', standoff: 12, font: { size: 12 } },
        tickfont: { size: 10 },
        gridcolor: PLOT_GRID,
        zerolinecolor: PLOT_GRID,
        range: yaxisRange,
        autorange: gpsView ? false : true,
      },
      legend: {
        orientation: 'h',
        yanchor: 'top',
        y: -0.2,
        x: 0,
        xanchor: 'left',
        bgcolor: 'rgba(250, 251, 252, 0.94)',
        bordercolor: PLOT_GRID,
        borderwidth: 1,
        font: { size: 11 },
        itemwidth: 22,
      },
      showlegend:
        runs.length > 1 || gateLatitude != null || virtualGateLine != null || snappedA != null || snappedB != null,
      datarevision: dataRevision,
      hovermode: 'closest',
      dragmode: 'pan',
    }),
    [
      gatePickMode,
      lonLatRatio,
      xaxisRange,
      yaxisRange,
      gpsView,
      runs.length,
      gateLatitude,
      virtualGateLine,
      snappedA,
      snappedB,
      dataRevision,
    ],
  )

  const [cursorTipHtml, setCursorTipHtml] = useState<string | null>(null)
  const tooltipElRef = useRef<HTMLDivElement | null>(null)
  const lastPointerRef = useRef({ x: 0, y: 0 })
  const lastMapHoverSyncRef = useRef<{ runIndex: number; pointIndex: number } | null>(null)

  const applyTooltipPosition = (clientX: number, clientY: number) => {
    lastPointerRef.current = { x: clientX, y: clientY }
    const el = tooltipElRef.current
    if (!el) return
    const pos = cursorTooltipPosition(clientX, clientY)
    el.style.left = `${pos.left}px`
    el.style.top = `${pos.top}px`
  }

  useLayoutEffect(() => {
    if (cursorTipHtml == null) return
    applyTooltipPosition(lastPointerRef.current.x, lastPointerRef.current.y)
  }, [cursorTipHtml])

  useEffect(() => {
    if (gatePickMode) {
      setCursorTipHtml(null)
      lastMapHoverSyncRef.current = null
    }
  }, [gatePickMode])

  const plot = (
    <Plot
      data={plotData as never}
      layout={plotLayout as never}
      config={plotlyInteractionConfig}
      style={{ width: '100%', height: '100%', minHeight: 0, cursor: gatePickMode ? 'crosshair' : undefined }}
      onClick={(ev: PlotMouseEvent) => {
        if (!gatePickMode) return
        const p = ev.points?.[0]
        if (p && typeof p.x === 'number' && typeof p.y === 'number') {
          onGateLocation(p.y, p.x)
        }
      }}
      onHover={(ev: PlotMouseEvent) => {
        if (gatePickMode) return
        const p = ev.points?.[0]
        const e = ev.event
        if (!p || !e) return

        lastPointerRef.current = { x: e.clientX, y: e.clientY }

        const cn = p.curveNumber
        const ll = lonLatLines(p.y, p.x)
        const heatCurveIndices = runs.map((_, i) => 1 + i * 2)
        const hi = heatCurveIndices.indexOf(cn)

        let html: string | null = null

        if (hi >= 0 && p.pointIndex != null) {
          html = gpsTrailHoverHtml(runs[hi], hi) + ll
          const prev = lastMapHoverSyncRef.current
          if (prev?.runIndex !== hi || prev.pointIndex !== p.pointIndex) {
            lastMapHoverSyncRef.current = { runIndex: hi, pointIndex: p.pointIndex }
            const run = runs[hi]
            const xs = distanceSeries(run.telemetry)
            const xm = xs[p.pointIndex]
            if (typeof xm === 'number') onActiveDisplayM(xm)
          }
        } else {
          lastMapHoverSyncRef.current = null
          let idx = runs.length * 2
          if (virtualGateLine) {
            if (cn === idx) {
              html =
                (trailBearingDeg != null
                  ? `Virtual gate · trail heading ≈ ${trailBearingDeg.toFixed(0)}° clockwise from north (gate runs E-W if you ride north)`
                  : 'Virtual gate · perpendicular to trail heading at snapped point') + ll
            }
            idx += 1
          }
          if (html == null && gateLatitude != null && gateLongitude != null) {
            if (cn === idx) html = 'Map click (rough anchor)' + ll
            idx += 1
          }
          if (html == null && snappedA) {
            if (cn === idx) {
              html = (runs[0] ? `GPS snap — ${gpsTrailHoverHtml(runs[0], 0)}` : 'GPS snap — First run') + ll
            }
            idx += 1
          }
          if (html == null && snappedB) {
            if (cn === idx) {
              html = (runs[1] ? `GPS snap — ${gpsTrailHoverHtml(runs[1], 1)}` : 'GPS snap — Second run') + ll
            }
            idx += 1
          }
          if (html == null && activeDisplayM != null) {
            for (let ri = 0; ri < runs.length; ri++) {
              if (cn === idx + ri) {
                html = `Chart scrub — ${gpsTrailHoverHtml(runs[ri], ri)}` + ll
                break
              }
            }
          }
        }

        if (html == null) return
        setCursorTipHtml(html)
        queueMicrotask(() => applyTooltipPosition(e.clientX, e.clientY))
      }}
      onUnhover={() => {
        setCursorTipHtml(null)
        lastMapHoverSyncRef.current = null
      }}
    />
  )

  return (
    <div className="gps-map-ui">
      <div
        className="gps-map-aspect-wrap"
        style={{ aspectRatio: String(geoAspect) }}
        onMouseMove={(ev) => {
          if (cursorTipHtml == null) return
          applyTooltipPosition(ev.clientX, ev.clientY)
        }}
        onMouseLeave={() => {
          setCursorTipHtml(null)
          lastMapHoverSyncRef.current = null
        }}
      >
        {plot}
        {cursorTipHtml != null && (
          <div
            ref={tooltipElRef}
            className="gps-cursor-tooltip"
            style={{ left: 0, top: 0 }}
            // eslint-disable-next-line react/no-danger -- escaped lap/ZIP strings from gpsTrailHoverHtml
            dangerouslySetInnerHTML={{ __html: cursorTipHtml }}
          />
        )}
      </div>
      <p className="gps-map-hint">
        {gatePickMode
          ? 'Distance and time for both laps start at your click. Press Cancel to stop.'
          : `${mapHintForMetric(colorMetric)} Hover for lap name and coordinates — charts stay synced when you scrub. Scroll wheel zooms; drag to pan.`}
      </p>
    </div>
  )
}
