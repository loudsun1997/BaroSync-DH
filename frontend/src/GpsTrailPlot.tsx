import type { PlotMouseEvent } from 'plotly.js'
import { useEffect, useMemo, useState } from 'react'
import { Plot } from './plotlyFactory'
import { distanceSeries, interpAlongDistance, nearestIndexForDistanceM } from './distanceUtils'
import { gateLineFromMeta, gateLineFromPreview, nearestIndexOnTrail, perpendicularGateLonLat } from './gateGeometry'
import type { AlignmentMeta, ComparisonPayload, GatePreview, RunResult, TrailColorMetric } from './types'

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
  switch (colorMetric) {
    case 'g':
      return tel.map((t) => t.g_total ?? 0)
    case 'variance':
      return tel.map((t) => t.vz_rolling_std ?? 0)
    case 'jerk':
      return tel.map((t) => t.jerk_magnitude_ms3 ?? 0)
    case 'delta_t':
      return tel.map((t) => {
        const d = t.distance_m ?? 0
        return interpAlongDistance(comparison, d) ?? 0
      })
    case 'braking':
      return tel.map((t) => t.mtb_braking_intensity ?? 0)
    case 'lean_mtb':
      return tel.map((t) =>
        typeof t.mtb_lean_deg === 'number' && Number.isFinite(t.mtb_lean_deg) ? t.mtb_lean_deg : 0,
      )
    case 'vz':
    default:
      return tel.map((t) => t.vz_m_s ?? 0)
  }
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
    for (const t of r.telemetry) {
      if (Number.isFinite(t.longitude) && Number.isFinite(t.latitude)) {
        xs.push(t.longitude)
        ys.push(t.latitude)
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
    if (gateLatitude != null && gateLongitude != null && runs[0]?.telemetry?.length >= 2) {
      const ix = nearestIndexOnTrail(runs[0].telemetry, gateLatitude, gateLongitude)
      return perpendicularGateLonLat(runs[0].telemetry, ix, 12)
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

  const traces: object[] = []
  runs.forEach((run, ri) => {
    const tel = run.telemetry
    if (tel.length === 0) return
    const lon = tel.map((t) => t.longitude)
    const lat = tel.map((t) => t.latitude)
    const baseColor = run.color ?? '#94a3b8'
    traces.push({
      x: lon,
      y: lat,
      type: 'scatter',
      mode: 'lines',
      name: `${run.label ?? `Run ${ri + 1}`} path`,
      line: { color: baseColor, width: 2 },
      opacity: 0.35,
      hoverinfo: 'skip',
      showlegend: runs.length > 1,
    })
    const z = metricZ(run, colorMetric, comparison)
    const hoverHtml = gpsTrailHoverHtml(run, ri)
    traces.push({
      x: lon,
      y: lat,
      type: 'scatter',
      mode: 'markers',
      name: `${run.label ?? `Run ${ri + 1}`} (${colorMetric})`,
      marker: {
        color: z,
        colorscale: colorscaleFor(colorMetric),
        size: 7,
        showscale: ri === 0,
        colorbar:
          ri === 0
            ? {
                title: { text: colorbarTitle(colorMetric), font: { color: PLOT_TEXT, size: 11 } },
                tickfont: { color: PLOT_TEXT },
              }
            : undefined,
      },
      text: tel.map(() => hoverHtml),
      hovertemplate: '%{text}<br>lat %{y:.6f}<br>lon %{x:.6f}<extra></extra>',
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
    if (tel.length === 0 || activeDisplayM == null) return
    const idx = nearestIndexForDistanceM(tel, activeDisplayM)
    const p = tel[idx]
    traces.push({
      x: [p.longitude],
      y: [p.latitude],
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

  // Bump only when map *data* changes — not on scrub (activeDisplayM), or Plotly resets zoom on every hover.
  const dataRevision =
    `${runs.length}-${colorMetric}-${gatePickMode}-${gateLatitude ?? 'n'}-${virtualGateLine ? 'g' : 'n'}-${snappedA ? 'a' : ''}${snappedB ? 'b' : ''}`

  const lonLatRatio = gpsView?.lonLatRatio ?? 1.25
  const xaxisRange = gpsView ? gpsView.rangeLon : undefined
  const yaxisRange = gpsView ? gpsView.rangeLat : undefined
  const geoAspect = gpsView?.geoAspect ?? 1.2

  const [cursorTip, setCursorTip] = useState<{ html: string; left: number; top: number } | null>(null)

  useEffect(() => {
    if (gatePickMode) setCursorTip(null)
  }, [gatePickMode])

  const plot = (
    <Plot
      data={traces as never}
      layout={{
        margin: { t: 28, r: 24, b: 44, l: 52 },
        uirevision: 'gps-trail',
        title: {
          text: gatePickMode
            ? 'Click anywhere on the trail — that becomes distance 0 for both laps'
            : 'GPS trail (hover dots: lap name, ZIP name, lat/lon; scrub charts)',
          font: { color: PLOT_TEXT, size: 14 },
        },
        paper_bgcolor: PLOT_PAPER,
        plot_bgcolor: PLOT_BG,
        font: { color: PLOT_TEXT },
        xaxis: {
          title: { text: 'Longitude (°)' },
          gridcolor: PLOT_GRID,
          zerolinecolor: PLOT_GRID,
          scaleanchor: 'y',
          scaleratio: lonLatRatio,
          range: xaxisRange,
          autorange: gpsView ? false : true,
        },
        yaxis: {
          title: { text: 'Latitude (°)' },
          gridcolor: PLOT_GRID,
          zerolinecolor: PLOT_GRID,
          range: yaxisRange,
          autorange: gpsView ? false : true,
        },
        showlegend:
          runs.length > 1 || gateLatitude != null || virtualGateLine != null || snappedA != null || snappedB != null,
        datarevision: dataRevision,
        hovermode: 'closest',
        dragmode: gatePickMode ? 'pan' : 'zoom',
      }}
      config={{ responsive: true, displaylogo: false }}
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

        const cn = p.curveNumber
        const ll = lonLatLines(p.y, p.x)
        const heatCurveIndices = runs.map((_, i) => 1 + i * 2)
        const hi = heatCurveIndices.indexOf(cn)

        let html: string | null = null

        if (hi >= 0 && p.pointIndex != null) {
          html = gpsTrailHoverHtml(runs[hi], hi) + ll
          const run = runs[hi]
          const xs = distanceSeries(run.telemetry)
          const xm = xs[p.pointIndex]
          if (typeof xm === 'number') onActiveDisplayM(xm)
        } else {
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
        const pos = cursorTooltipPosition(e.clientX, e.clientY)
        setCursorTip({ html, ...pos })
      }}
      onUnhover={() => setCursorTip(null)}
    />
  )

  return (
    <div
      className="gps-map-aspect-wrap"
      style={{ aspectRatio: String(geoAspect) }}
      onMouseMove={(ev) => {
        setCursorTip((prev) => {
          if (!prev) return prev
          return { ...prev, ...cursorTooltipPosition(ev.clientX, ev.clientY) }
        })
      }}
      onMouseLeave={() => setCursorTip(null)}
    >
      {plot}
      {cursorTip != null && (
        <div
          className="gps-cursor-tooltip"
          style={{ left: cursorTip.left, top: cursorTip.top }}
          // eslint-disable-next-line react/no-danger -- escaped lap/ZIP strings from gpsTrailHoverHtml
          dangerouslySetInnerHTML={{ __html: cursorTip.html }}
        />
      )}
    </div>
  )
}
