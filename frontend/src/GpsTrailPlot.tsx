import type { PlotMouseEvent } from 'plotly.js'
import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react'
import { robustColorScaleRange } from './chartScales'
import { plotlyInteractionConfig } from './plotlyConfig'
import { Plot } from './plotlyFactory'
import { distanceSeries, interpAlongDistance, nearestIndexForDistanceM, interpXYAlongDistance } from './distanceUtils'
import { gateLineFromMeta, gateLineFromPreview, nearestIndexOnTrail, perpendicularGateLonLat } from './gateGeometry'
import { latAt, lonAt, numAt, telemetryLen, telemetryLonLatArrays } from './telemetryAccess'
import type { AlignmentMeta, ComparisonPayload, GatePreview, RunResult } from './types'
import {
  MAX_MAP_VIEW_POINTS,
  mapPointBudgetForViewBox,
  mapRelayoutToViewBox,
  padViewBox,
  pickLonLatTrace,
  type LonLatViewBox,
} from './mapTelemetryDownsample'

const PLOT_PAPER = '#fafbfc'
const PLOT_BG = '#ffffff'
const PLOT_TEXT = '#1c2333'
const PLOT_GRID = '#e2e8f0'

/** Plotly fires many relayout updates during pan/zoom; wait for a pause before rebuilding decimated traces. */
const MAP_RELAYOUT_DEBOUNCE_MS = 480

/** Map scatter points carry original sample index (or [dist_m, index] on baseline line). */
function telemetryIndexFromMapPoint(p: { customdata?: unknown; pointIndex?: number | null }): number {
  const cd = p.customdata
  if (Array.isArray(cd) && typeof cd[1] === 'number' && Number.isFinite(cd[1])) return cd[1]
  if (typeof cd === 'number' && Number.isFinite(cd)) return cd
  return typeof p.pointIndex === 'number' ? p.pointIndex : 0
}

function distanceMFromMapHoverPoint(
  tel: RunResult['telemetry'],
  p: { customdata?: unknown; pointIndex?: number | null },
): number | null {
  const cd = p.customdata
  if (Array.isArray(cd) && typeof cd[0] === 'number' && Number.isFinite(cd[0])) return cd[0]
  const ix = telemetryIndexFromMapPoint(p)
  const xs = distanceSeries(tel)
  const xm = xs[ix]
  return typeof xm === 'number' && Number.isFinite(xm) ? xm : null
}

type Props = {
  runs: RunResult[]
  activeDisplayM: number | null
  onActiveDisplayM: (m: number | null) => void
  comparison: ComparisonPayload | null
  /** When `comparison.pace_vs_reference`, only this run is colored by Δt vs ref; others are neutral. */
  paceRunIndex?: number
  alignment: AlignmentMeta | null | undefined
  gatePreview: GatePreview | null | undefined
  gatePickMode: boolean
  gateLatitude: number | null
  gateLongitude: number | null
  onGateLocation: (lat: number, lon: number) => void
  /** Map pin: zoom charts + this callback (~±5 m) */
  onPaceLossPinClick?: (distanceM: number) => void
  heatmapMetric?: 'delta_t' | 'delta_vz'
  canonicalRef?: CanonicalReference | null
}

function metricZ(run: RunResult, comparison: ComparisonPayload | null, heatmapMetric?: 'delta_t' | 'delta_vz', canonicalRef?: CanonicalReference | null): number[] {
  const tel = run.telemetry
  const n = telemetryLen(tel)
  const z = new Array<number>(n)
  
  if (heatmapMetric === 'delta_vz' && canonicalRef?.distance_m && canonicalRef?.vz_m_s) {
    const xd_ref = canonicalRef.distance_m as number[]
    const vd_ref = canonicalRef.vz_m_s as number[]
    for (let i = 0; i < n; i++) {
      const d = numAt(tel, 'distance_m', i)
      let rvz = numAt(tel, 'vz_smooth_m_s', i)
      if (rvz == null || Math.abs(rvz) < 1e-5) rvz = numAt(tel, 'vz_m_s', i)
      
      let bv = 0
      if (d != null && rvz != null) {
        const interpBv = interpXYAlongDistance(xd_ref, vd_ref, d)
        if (interpBv != null) {
           bv = interpBv - rvz // positive = descending faster
        }
      }
      z[i] = bv
    }
  } else {
    for (let i = 0; i < n; i++) {
      z[i] = interpAlongDistance(comparison, numAt(tel, 'distance_m', i)) ?? 0
    }
  }
  return z
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
function trailMapColorBoundsDeltaT(allZ: number[], heatmapMetric: 'delta_t' | 'delta_vz'): [number, number] | undefined {
  if (heatmapMetric === 'delta_vz') {
     return robustColorScaleRange(allZ, {
       symmetricAroundZero: true,
       highPct: 95,
       padFraction: 0,
       minSpan: 1.0,
       clampHigh: 10,
     })
  }
  return robustColorScaleRange(allZ, {
    symmetricAroundZero: true,
    highPct: 98,
    padFraction: 0.1,
    minSpan: 0.4,
    clampHigh: 90,
  })
}

export function GpsTrailPlot({
  runs,
  activeDisplayM,
  onActiveDisplayM,
  comparison,
  paceRunIndex = 1,
  alignment,
  gatePreview,
  gatePickMode,
  gateLatitude,
  gateLongitude,
  onGateLocation,
  onPaceLossPinClick,
  heatmapMetric = 'delta_t',
  canonicalRef,
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
    const allZ: number[] = []
    if (comparison?.pace_vs_reference && runs[paceRunIndex]) {
      allZ.push(...metricZ(runs[paceRunIndex]!, comparison, heatmapMetric, canonicalRef))
    } else {
      for (const run of runs) {
        allZ.push(...metricZ(run, comparison, heatmapMetric, canonicalRef))
      }
    }
    return trailMapColorBoundsDeltaT(allZ, heatmapMetric)
  }, [runs, comparison, paceRunIndex, heatmapMetric, canonicalRef])

  // Bump only when map *data* changes — not on scrub (activeDisplayM), or Plotly resets zoom on every hover.
  const dataRevision = useMemo(
    () =>
      `${runs.length}-${gatePickMode}-${gateLatitude ?? 'n'}-${virtualGateLine ? 'g' : 'n'}-${snappedA ? 'a' : ''}${snappedB ? 'b' : ''}-cmp${
        comparison?.delta_t?.distance_m?.length ?? 0
      }-hm${heatmapMetric}`,
    [runs.length, gatePickMode, gateLatitude, virtualGateLine, snappedA, snappedB, comparison, heatmapMetric],
  )

  const [mapViewBox, setMapViewBox] = useState<LonLatViewBox | null>(null)
  const mapRelayoutDebounceRef = useRef<ReturnType<typeof setTimeout> | null>(null)

  useEffect(() => {
    setMapViewBox(null)
  }, [dataRevision])

  useEffect(() => {
    return () => {
      if (mapRelayoutDebounceRef.current != null) window.clearTimeout(mapRelayoutDebounceRef.current)
    }
  }, [])

  const scheduleMapViewFromRelayout = useCallback((box: LonLatViewBox) => {
    if (mapRelayoutDebounceRef.current != null) window.clearTimeout(mapRelayoutDebounceRef.current)
    mapRelayoutDebounceRef.current = window.setTimeout(() => {
      mapRelayoutDebounceRef.current = null
      setMapViewBox(box)
    }, MAP_RELAYOUT_DEBOUNCE_MS)
  }, [])

  const onPlotRelayout = useCallback(
    (ev: Readonly<Record<string, unknown>>) => {
      if (ev['xaxis.autorange'] === true || ev['yaxis.autorange'] === true) {
        if (mapRelayoutDebounceRef.current != null) {
          window.clearTimeout(mapRelayoutDebounceRef.current)
          mapRelayoutDebounceRef.current = null
        }
        setMapViewBox(null)
        return
      }
      const box = mapRelayoutToViewBox(ev as Record<string, unknown>)
      if (box != null) scheduleMapViewFromRelayout(box)
    },
    [scheduleMapViewFromRelayout],
  )

  const lonLatRatio = gpsView?.lonLatRatio ?? 1.25
  const xaxisRange = mapViewBox
    ? ([mapViewBox.lonMin, mapViewBox.lonMax] as [number, number])
    : gpsView
      ? gpsView.rangeLon
      : undefined
  const yaxisRange = mapViewBox
    ? ([mapViewBox.latMin, mapViewBox.latMax] as [number, number])
    : gpsView
      ? gpsView.rangeLat
      : undefined
  const geoAspect = gpsView?.geoAspect ?? 1.2

  const filterBox = useMemo(() => {
    const raw: LonLatViewBox | null =
      mapViewBox ??
      (gpsView
        ? {
            lonMin: gpsView.rangeLon[0]!,
            lonMax: gpsView.rangeLon[1]!,
            latMin: gpsView.rangeLat[0]!,
            latMax: gpsView.rangeLat[1]!,
          }
        : null)
    return raw ? padViewBox(raw) : null
  }, [mapViewBox, gpsView])

  const mapPointBudget = filterBox ? mapPointBudgetForViewBox(filterBox) : MAX_MAP_VIEW_POINTS

  /** react-plotly can skip Plotly.react when layout ref is stable; scrub traces must always redraw. */
  const mapPlotRevision =
    activeDisplayM != null && Number.isFinite(activeDisplayM) ? activeDisplayM : -1

  const { mainTraces, lapMarkerCurveByRun } = useMemo(() => {
    const traces: object[] = []
    const lapMarkerCurveByRun = runs.map(() => -1)
    let nextCurve = 0

    const paceRef = Boolean(comparison?.pace_vs_reference)
    const pr = Math.min(Math.max(0, paceRunIndex), Math.max(0, runs.length - 1))
    runs.forEach((run, ri) => {
      const tel = run.telemetry
      const n = telemetryLen(tel)
      if (n === 0) return
      const { lon, lat } = telemetryLonLatArrays(tel)
      const z = metricZ(run, comparison, heatmapMetric, canonicalRef)
      const picked = pickLonLatTrace(lon, lat, mapPointBudget, filterBox)
      const pi = picked.idx
      const neutralPace = paceRef && ri !== pr
      const zP = neutralPace ? pi.map(() => 0) : pi.map((i) => z[i]!)
      const hoverHtml = gpsTrailHoverHtml(run, ri)
      const showThisColorbar = paceRef ? ri === pr : nextCurve === 0
      lapMarkerCurveByRun[ri] = nextCurve
      nextCurve += 1
      traces.push({
        x: picked.lon,
        y: picked.lat,
        type: 'scatter',
        mode: 'markers',
        name: (neutralPace ? '↳ (context) ' : '') + (run.label ?? `Run ${ri + 1}`),
        marker: neutralPace
          ? {
              color: run.color ?? '#94a3b8',
              size: 4,
              opacity: 0.7,
              line: { width: 0 },
            }
          : {
              color: zP,
              colorscale: 'RdBu',
              cauto: mapColorBounds == null,
              ...(mapColorBounds != null ? { cmin: mapColorBounds[0], cmax: mapColorBounds[1] } : {}),
              size: 5,
              opacity: 0.88,
              line: { width: 0 },
              showscale: showThisColorbar,
              colorbar: showThisColorbar
                ? {
                    title: {
                      text: heatmapMetric === 'delta_vz' ? 'ΔVz vs ref (m/s)' : 'Δt vs ref (s)',
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
        text: pi.map(() => hoverHtml),
        customdata: pi,
        hovertemplate: '%{text}<br>lat %{y:.6f}<br>lon %{x:.6f}<extra></extra>',
        showlegend: runs.length > 1,
      })
    })

    const pins = (comparison?.pace_loss_distance_m ?? []).slice(0, 8)
    if (pins.length > 0 && runs[pr]) {
      const telP = runs[pr]!.telemetry
      pins.forEach((dm, k) => {
        if (!Number.isFinite(dm)) return
        const idx = nearestIndexForDistanceM(telP, dm)
        traces.push({
          x: [lonAt(telP, idx)],
          y: [latAt(telP, idx)],
          type: 'scatter',
          mode: 'markers',
          name: 'Pace loss pin',
          customdata: [[dm, 'ploss']],
          marker: { color: '#b91c1c', size: 12, symbol: 'triangle-up', line: { color: '#fff', width: 1 } },
          text: [k === 0 ? 'Largest time losses (click = zoom all charts)' : `Time loss @ ~${dm.toFixed(0)} m`],
          hoverinfo: 'text',
          showlegend: k === 0,
        })
      })
    }

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

    return { mainTraces: traces, lapMarkerCurveByRun }
  }, [
    runs,
    comparison,
    mapColorBounds,
    virtualGateLine,
    gateLatitude,
    gateLongitude,
    trailBearingDeg,
    snappedA,
    snappedB,
    filterBox,
    mapPointBudget,
    paceRunIndex,
    heatmapMetric,
    canonicalRef,
  ])

  const scrubTraces = useMemo(() => {
    const traces: object[] = []
    runs.forEach((run, ri) => {
      const tel = run.telemetry
      if (telemetryLen(tel) === 0 || activeDisplayM == null) return
      const idx = nearestIndexForDistanceM(tel, activeDisplayM)
      traces.push({
        x: [lonAt(tel, idx)],
        y: [latAt(tel, idx)],
        type: 'scatter',
        mode: 'markers',
        name: `Scrub ${run.label ?? ri + 1}`,
        marker: {
          color: run.color ?? '#e85d04',
          size: 20,
          line: { color: '#ffffff', width: 3 },
          symbol: 'circle',
          opacity: 1,
        },
        text: [`Chart scrub — ${gpsTrailHoverHtml(run, ri)}`],
        hovertemplate: '%{text}<br>lat %{y:.6f}<br>lon %{x:.6f}<extra></extra>',
        showlegend: false,
      })
    })
    return traces
  }, [runs, activeDisplayM])

  const plotData = useMemo(() => [...mainTraces, ...scrubTraces], [mainTraces, scrubTraces])

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
      revision={mapPlotRevision}
      config={plotlyInteractionConfig}
      style={{ width: '100%', height: '100%', minHeight: 0, cursor: gatePickMode ? 'crosshair' : undefined }}
      onClick={(ev: PlotMouseEvent) => {
        if (gatePickMode) {
          const p = ev.points?.[0]
          if (p && typeof p.x === 'number' && typeof p.y === 'number') {
            onGateLocation(p.y, p.x)
          }
          return
        }
        const p = ev.points?.[0]
        if (!p) return
        const cd = p.customdata
        if (Array.isArray(cd) && cd[1] === 'ploss' && typeof cd[0] === 'number' && Number.isFinite(cd[0])) {
          const dm0 = cd[0]
          onPaceLossPinClick?.(dm0)
          const pr = Math.min(Math.max(0, paceRunIndex), Math.max(0, runs.length - 1))
          const telP = runs[pr]?.telemetry
          if (telP && telemetryLen(telP) > 0) {
            const idx = nearestIndexForDistanceM(telP, dm0)
            const lo = lonAt(telP, idx)
            const la = latAt(telP, idx)
            const span = 0.00022
            setMapViewBox(
              padViewBox({ lonMin: lo - span, lonMax: lo + span, latMin: la - span, latMax: la + span }),
            )
          }
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
        const hi = lapMarkerCurveByRun.findIndex((c) => c === cn)

        let html: string | null = null

        if (hi >= 0 && p.pointIndex != null) {
          const tel = runs[hi]!.telemetry
          const origIx = telemetryIndexFromMapPoint(p)
          html = gpsTrailHoverHtml(runs[hi]!, hi) + ll
          const prev = lastMapHoverSyncRef.current
          if (prev?.runIndex !== hi || prev.pointIndex !== origIx) {
            lastMapHoverSyncRef.current = { runIndex: hi, pointIndex: origIx }
            const xm = distanceMFromMapHoverPoint(tel, p)
            if (xm != null) onActiveDisplayM(xm)
          }
        } else {
          lastMapHoverSyncRef.current = null
          let idx = lapMarkerCurveByRun.reduce((m, c) => (c >= 0 ? m + 1 : m), 0)
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
      onRelayout={onPlotRelayout as never}
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
          : comparison?.pace_vs_reference
            ? 'Heatmap: pace gap vs the N-run reference (red = slower than ref, blue = faster). Grey trail = other lap (context). Red pins = largest time-loss — click a pin to zoom the distance charts to ~10 m there and focus the map. Hover for coordinates; charts & map scrub together.'
            : 'Colors: time delta between laps (B−A) at each distance (after baro align). Hover for lap name and coordinates — charts stay synced when you scrub. Scroll wheel zooms; drag to pan. Large uploads: the map draws fewer points when zoomed out and adds detail when you zoom in; double‑click or reset axes to return to the full trail view.'}
      </p>
    </div>
  )
}
