import type { PlotMouseEvent } from 'plotly.js'
import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react'
import { robustColorScaleRange } from './chartScales'
import { plotlyInteractionConfig } from './plotlyConfig'
import { Plot } from './plotlyFactory'
import { distanceSeries, interpAlongDistance, nearestIndexForDistanceM } from './distanceUtils'
import { gateLineFromMeta, gateLineFromPreview, nearestIndexOnTrail, perpendicularGateLonLat } from './gateGeometry'
import {
  latAt,
  lonAt,
  numAt,
  telemetryLen,
  telemetryLonLatArrays,
  vzDisplayValueAt,
} from './telemetryAccess'
import type { AlignmentMeta, ComparisonPayload, GatePreview, RunResult, TrailColorMetric } from './types'
import { VZ_DISPLAY_CMAX, VZ_DISPLAY_CMIN } from './vzDisplayConstants'
import {
  MAX_MAP_VIEW_POINTS,
  mapPointBudgetForViewBox,
  mapRelayoutToViewBox,
  padViewBox,
  pickLonLatTrace,
  type LonLatViewBox,
} from './mapTelemetryDownsample'
import { deltaTPaceForDistances } from './deltaTPaceMap'
import { vzCompareHeatOnCompareRun } from './verticalSpeedCompare'

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

/** Plotly fires many relayout updates during pan/zoom; wait for a pause before rebuilding decimated traces. */
const MAP_RELAYOUT_DEBOUNCE_MS = 480

/** Line-only base lap: full-res GPS melts the browser on huge exports. */
const VZ_COMPARE_BASE_LINE_MAX_POINTS = 12_000

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

function downsampleTrailLine(
  lon: number[],
  lat: number[],
  custom: number[],
  maxPts: number,
): { lon: number[]; lat: number[]; custom: number[]; indices: number[] } {
  const n = lon.length
  if (n <= maxPts) {
    return {
      lon,
      lat,
      custom,
      indices: Array.from({ length: n }, (_, i) => i),
    }
  }
  const step = Math.ceil(n / maxPts)
  const oL: number[] = []
  const oLa: number[] = []
  const oC: number[] = []
  const oIx: number[] = []
  for (let i = 0; i < n; i += step) {
    oL.push(lon[i]!)
    oLa.push(lat[i]!)
    oC.push(custom[i]!)
    oIx.push(i)
  }
  const li = n - 1
  if (oL.length === 0 || oL[oL.length - 1] !== lon[li]) {
    oL.push(lon[li]!)
    oLa.push(lat[li]!)
    oC.push(custom[li]!)
    oIx.push(li)
  }
  return { lon: oL, lat: oLa, custom: oC, indices: oIx }
}

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
  if (colorMetric === 'delta_t_pace') {
    if (!comparison || n === 0) return new Array(n).fill(0)
    const p = deltaTPaceForDistances(comparison, distanceSeries(tel))
    // Negate so RdYlGn gives green for gaining and red for losing (see deltaTPaceMap sign convention).
    return p.map((v) => -v)
  }
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
      case 'vz_lap_compare':
        z[i] = vzDisplayValueAt(tel, i) ?? 0
        break
      case 'braking':
        z[i] = numAt(tel, 'mtb_braking_intensity', i)
        break
      case 'lean_mtb':
        z[i] = numAt(tel, 'mtb_lean_deg', i)
        break
      case 'vz':
      default:
        z[i] = vzDisplayValueAt(tel, i) ?? 0
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
    case 'delta_t_pace':
      return "−d(Δt)/ds (s/m)<br><sub>green · gaining on A &nbsp;|&nbsp; red · losing</sub>"
    case 'vz_lap_compare':
      return 'Vz_base − Vz_compare (m/s)<br><sub>orange · compare faster down &nbsp;|&nbsp; blue · slower</sub>'
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
    case 'delta_t_pace':
      return 'After baro sync: trail shows where lap B is gaining (green) or losing (red) time vs A per meter along the run — not raw GPS overlap.'
    case 'vz_lap_compare':
      return 'Baseline lap (run 1): solid trail, one color. Compare lap (run 2): heat along the GPS path — orange where you were faster down vs baseline, blue where slower. (Other trail-color modes color every lap by that metric.)'
    case 'braking':
      return 'Colors show braking intensity from longitudinal acceleration.'
    case 'lean_mtb':
      return 'Colors show estimated lean angle from gravity in the bike frame.'
    case 'vz':
    default:
      return 'Colors show display Vz (0.5 Hz LPF + 1.5s SG on baro vertical rate). RdBu scale −8…+1 m/s (clips); Bernoulli is not in Vz.'
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

/** Per-sample Vz for custom map tooltip (inspect baro vertical velocity at hover index). */
function vzTooltipFragment(tel: RunResult['telemetry'], i: number): string {
  const v = vzDisplayValueAt(tel, i)
  if (v != null) {
    return `<br>Vz ${v.toFixed(2)} m/s`
  }
  return '<br>Vz —'
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
      return [VZ_DISPLAY_CMIN, VZ_DISPLAY_CMAX]
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
    case 'vz_lap_compare':
      return robustColorScaleRange(allZ, {
        symmetricAroundZero: true,
        highPct: 98,
        padFraction: 0.1,
        minSpan: 0.35,
        clampHigh: 8,
      })
    case 'delta_t_pace':
      return robustColorScaleRange(allZ, {
        symmetricAroundZero: true,
        highPct: 98,
        padFraction: 0.12,
        minSpan: 1e-5,
        clampHigh: 0.2,
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
    case 'vz_lap_compare':
      return 'RdBu'
    case 'delta_t_pace':
      return 'RdYlGn'
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
      return 'RdBu'
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

  const vzComparePack = useMemo(() => {
    if (colorMetric !== 'vz_lap_compare' || runs.length < 2) return null
    return vzCompareHeatOnCompareRun(runs[0]!, runs[1]!)
  }, [colorMetric, runs])

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
    if (colorMetric === 'vz_lap_compare' && vzComparePack) {
      const finite = vzComparePack.delta.filter((v) => Number.isFinite(v))
      const b = trailMapColorBounds(finite, 'vz_lap_compare')
      if (b != null) return b
      return [-1, 1] as [number, number]
    }
    const fromServer = pooledMapColorBoundsFromServer(runs, colorMetric)
    if (fromServer != null) return fromServer
    const allZ: number[] = []
    for (const run of runs) {
      allZ.push(...metricZ(run, colorMetric, comparison))
    }
    return trailMapColorBounds(allZ, colorMetric)
  }, [runs, colorMetric, comparison, vzComparePack])

  // Bump only when map *data* changes — not on scrub (activeDisplayM), or Plotly resets zoom on every hover.
  const dataRevision = useMemo(
    () =>
      `${runs.length}-${colorMetric}-${gatePickMode}-${gateLatitude ?? 'n'}-${virtualGateLine ? 'g' : 'n'}-${snappedA ? 'a' : ''}${snappedB ? 'b' : ''}-${vzComparePack ? 'vcmp' : ''}-cmp${
        comparison?.delta_t?.distance_m?.length ?? 0
      }`,
    [runs.length, colorMetric, gatePickMode, gateLatitude, virtualGateLine, snappedA, snappedB, vzComparePack, comparison],
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

    if (colorMetric === 'delta_t_pace' && runs.length >= 2 && comparison) {
      const run0 = runs[0]!
      const run1 = runs[1]!
      const tel0 = run0.telemetry
      const tel1 = run1.telemetry
      const n0 = telemetryLen(tel0)
      const n1 = telemetryLen(tel1)
      if (n0 > 0 && n1 > 0) {
        const { lon: lon0, lat: lat0 } = telemetryLonLatArrays(tel0)
        const { lon: lon1, lat: lat1 } = telemetryLonLatArrays(tel1)
        const dist0 = distanceSeries(tel0)
        const dist1 = distanceSeries(tel1)
        const baseLineColor = run0.color ?? '#2563eb'
        const baseLine = downsampleTrailLine(lon0, lat0, dist0, VZ_COMPARE_BASE_LINE_MAX_POINTS)
        const baseBudget = Math.min(VZ_COMPARE_BASE_LINE_MAX_POINTS, mapPointBudget)
        const basePicked = pickLonLatTrace(baseLine.lon, baseLine.lat, baseBudget, filterBox)
        const baseCustomdata = basePicked.idx.map((bi) => [
          baseLine.custom[bi]!,
          baseLine.indices[bi]!,
        ])
        const label0 = escapeHoverText(run0.label ?? 'Run 1')
        const label1 = escapeHoverText(run1.label ?? 'Run 2')
        const colorDisplay = (() => {
          const p = deltaTPaceForDistances(comparison, dist1)
          return p.map((v) => -v)
        })()
        const dtAt = (i: number) => interpAlongDistance(comparison, dist1[i]!)

        lapMarkerCurveByRun[0] = nextCurve
        nextCurve += 1
        traces.push({
          x: basePicked.lon,
          y: basePicked.lat,
          type: 'scatter',
          mode: 'lines',
          name: `${run0.label ?? 'Run 1'} (baseline)`,
          line: {
            color: baseLineColor,
            width: 5,
          },
          opacity: 0.92,
          customdata: baseCustomdata,
          hovertemplate:
            `<b>${label0}</b> (baseline · solid)<br>dist %{customdata:.1f} m<br>lat %{y:.6f}<br>lon %{x:.6f}<extra></extra>`,
          showlegend: true,
        })

        lapMarkerCurveByRun[1] = nextCurve
        nextCurve += 1
        const cmpPicked = pickLonLatTrace(lon1, lat1, mapPointBudget, filterBox)
        const ci = cmpPicked.idx
        const colorArr = ci.map((i) => (Number.isFinite(colorDisplay[i]!) ? colorDisplay[i]! : 0))
        const opac = ci.map((i) => (Number.isFinite(colorDisplay[i]!) ? 0.9 : 0.22))
        const text1 = ci.map((i) => {
          const negPace = colorDisplay[i]!
          const rawP = -negPace
          const dtm = dist1[i]!
          const dt = dtAt(i)
          let line = `<b>${label1}</b> vs <b>${label0}</b> · Δt pace map`
          if (Number.isFinite(rawP) && Math.abs(rawP) > 1e-8) {
            line += `<br>−d(Δt)/ds ${(negPace * 1e3).toFixed(2)}×10⁻³ s/m &nbsp; (d(Δt)/ds ${(rawP * 1e3).toFixed(2)}×10⁻³)`
          }
          if (dt != null && Number.isFinite(dt)) line += `<br>Δt ${dt.toFixed(2)} s`
          if (Number.isFinite(dtm)) line += ` · dist ${dtm.toFixed(1)} m`
          return line
        })
        traces.push({
          x: cmpPicked.lon,
          y: cmpPicked.lat,
          type: 'scatter',
          mode: 'markers',
          name: `${run1.label ?? 'Run 2'} (compare · pace heat)`,
          marker: {
            color: colorArr,
            colorscale: colorscaleFor('delta_t_pace'),
            cauto: mapColorBounds == null,
            ...(mapColorBounds != null ? { cmin: mapColorBounds[0], cmax: mapColorBounds[1] } : {}),
            size: 5,
            opacity: opac,
            line: { width: 0 },
            showscale: true,
            colorbar: {
              title: {
                text: colorbarTitle('delta_t_pace'),
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
            },
          },
          text: text1,
          customdata: ci,
          hovertemplate: '%{text}<br>lat %{y:.6f}<br>lon %{x:.6f}<extra></extra>',
          showlegend: true,
        })
      }
    } else if (colorMetric === 'vz_lap_compare' && runs.length >= 2) {
      const run0 = runs[0]!
      const run1 = runs[1]!
      const tel0 = run0.telemetry
      const tel1 = run1.telemetry
      const n0 = telemetryLen(tel0)
      const n1 = telemetryLen(tel1)
      if (n0 > 0 && n1 > 0) {
        const { lon: lon0, lat: lat0 } = telemetryLonLatArrays(tel0)
        const { lon: lon1, lat: lat1 } = telemetryLonLatArrays(tel1)
        const dist0 = distanceSeries(tel0)
        const dist1 = distanceSeries(tel1)
        const baseLineColor = run0.color ?? '#2563eb'
        const baseLine = downsampleTrailLine(lon0, lat0, dist0, VZ_COMPARE_BASE_LINE_MAX_POINTS)
        const baseBudget = Math.min(VZ_COMPARE_BASE_LINE_MAX_POINTS, mapPointBudget)
        const basePicked = pickLonLatTrace(baseLine.lon, baseLine.lat, baseBudget, filterBox)
        const baseCustomdata = basePicked.idx.map((bi) => [
          baseLine.custom[bi]!,
          baseLine.indices[bi]!,
        ])
        const label0 = escapeHoverText(run0.label ?? 'Run 1')
        const label1 = escapeHoverText(run1.label ?? 'Run 2')

        lapMarkerCurveByRun[0] = nextCurve
        nextCurve += 1
        traces.push({
          x: basePicked.lon,
          y: basePicked.lat,
          type: 'scatter',
          mode: 'lines',
          name: `${run0.label ?? 'Run 1'} (baseline)`,
          line: {
            color: baseLineColor,
            width: 5,
          },
          opacity: 0.92,
          customdata: baseCustomdata,
          hovertemplate:
            `<b>${label0}</b> (baseline · solid)<br>dist %{customdata:.1f} m<br>lat %{y:.6f}<br>lon %{x:.6f}<extra></extra>`,
          showlegend: true,
        })

        lapMarkerCurveByRun[1] = nextCurve
        nextCurve += 1

        if (vzComparePack) {
          const { delta, va, vb } = vzComparePack
          const cmpPicked = pickLonLatTrace(lon1, lat1, mapPointBudget, filterBox)
          const ci = cmpPicked.idx
          const colorArr = ci.map((i) => (Number.isFinite(delta[i]!) ? delta[i]! : 0))
          const opac = ci.map((i) => (Number.isFinite(delta[i]!) ? 0.88 : 0.22))
          const text1 = ci.map((i) => {
            const dlt = delta[i]!
            const baseV = va[i]!
            const cmpV = vb[i]!
            const dm = dist1[i]!
            let line = `<b>${label1}</b> vs baseline <b>${label0}</b>`
            if (Number.isFinite(dlt) && Number.isFinite(baseV) && Number.isFinite(cmpV)) {
              line += `<br>(Vz_base−Vz_cmp) ${dlt.toFixed(3)} m/s · ${baseV.toFixed(2)} vs ${cmpV.toFixed(2)}`
            } else {
              line += `<br><i>no compare</i>`
            }
            if (Number.isFinite(dm)) line += `<br>dist ${dm.toFixed(1)} m`
            return line
          })

          traces.push({
            x: cmpPicked.lon,
            y: cmpPicked.lat,
            type: 'scatter',
            mode: 'markers',
            name: `${run1.label ?? 'Run 2'} (compare · heat)`,
            marker: {
              color: colorArr,
              colorscale: colorscaleFor('vz_lap_compare'),
              cauto: mapColorBounds == null,
              ...(mapColorBounds != null ? { cmin: mapColorBounds[0], cmax: mapColorBounds[1] } : {}),
              size: 5,
              opacity: opac,
              line: { width: 0 },
              showscale: true,
              colorbar: {
                title: {
                  text: colorbarTitle('vz_lap_compare'),
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
              },
            },
            text: text1,
            customdata: ci,
            hovertemplate: '%{text}<br>lat %{y:.6f}<br>lon %{x:.6f}<extra></extra>',
            showlegend: true,
          })
        } else {
          const cmpColor = run1.color ?? '#ea580c'
          const hover1 = gpsTrailHoverHtml(run1, 1)
          const cmpPicked = pickLonLatTrace(lon1, lat1, mapPointBudget, filterBox)
          traces.push({
            x: cmpPicked.lon,
            y: cmpPicked.lat,
            type: 'scatter',
            mode: 'markers',
            name: `${run1.label ?? 'Run 2'} (compare — no heat)`,
            marker: {
              color: cmpColor,
              size: 5,
              opacity: 0.88,
              line: { width: 0 },
            },
            text: cmpPicked.idx.map(() => hover1),
            customdata: cmpPicked.idx,
            hovertemplate: '%{text}<br>lat %{y:.6f}<br>lon %{x:.6f}<extra></extra>',
            showlegend: true,
          })
        }
      }
    } else {
      runs.forEach((run, ri) => {
        const tel = run.telemetry
        const n = telemetryLen(tel)
        if (n === 0) return
        const { lon, lat } = telemetryLonLatArrays(tel)
        const z = metricZ(run, colorMetric, comparison)
        const picked = pickLonLatTrace(lon, lat, mapPointBudget, filterBox)
        const pi = picked.idx
        const zP = pi.map((i) => z[i]!)
        const hoverHtml = gpsTrailHoverHtml(run, ri)
        const isFirstLapMarker = nextCurve === 0
        lapMarkerCurveByRun[ri] = nextCurve
        nextCurve += 1
        traces.push({
          x: picked.lon,
          y: picked.lat,
          type: 'scatter',
          mode: 'markers',
          name: run.label ?? `Run ${ri + 1}`,
          marker: {
            color: zP,
            colorscale: colorscaleFor(colorMetric),
            cauto: mapColorBounds == null,
            ...(mapColorBounds != null ? { cmin: mapColorBounds[0], cmax: mapColorBounds[1] } : {}),
            size: 5,
            opacity: 0.88,
            line: { width: 0 },
            showscale: isFirstLapMarker,
            colorbar: isFirstLapMarker
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
          text: pi.map(() => hoverHtml),
          customdata: pi,
          hovertemplate: '%{text}<br>lat %{y:.6f}<br>lon %{x:.6f}<extra></extra>',
          showlegend: runs.length > 1,
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
    colorMetric,
    comparison,
    mapColorBounds,
    vzComparePack,
    virtualGateLine,
    gateLatitude,
    gateLongitude,
    trailBearingDeg,
    snappedA,
    snappedB,
    filterBox,
    mapPointBudget,
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
        const hi = lapMarkerCurveByRun.findIndex((c) => c === cn)

        let html: string | null = null

        if (hi >= 0 && p.pointIndex != null) {
          const tel = runs[hi]!.telemetry
          const origIx = telemetryIndexFromMapPoint(p)
          let extra = vzTooltipFragment(tel, origIx)
          if (
            colorMetric === 'vz_lap_compare' &&
            hi === 1 &&
            vzComparePack != null &&
            origIx >= 0 &&
            origIx < vzComparePack.delta.length
          ) {
            const d = vzComparePack.delta[origIx]!
            const a = vzComparePack.va[origIx]!
            const b = vzComparePack.vb[origIx]!
            if (Number.isFinite(d) && Number.isFinite(a) && Number.isFinite(b)) {
              extra += `<br>Vz_base−Vz_cmp ${d.toFixed(2)} m/s (${a.toFixed(2)} vs ${b.toFixed(2)})`
            }
          }
          html = gpsTrailHoverHtml(runs[hi]!, hi) + ll + extra
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
                const tel = runs[ri].telemetry
                const ix = nearestIndexForDistanceM(tel, activeDisplayM)
                html =
                  `Chart scrub — ${gpsTrailHoverHtml(runs[ri], ri)}` + ll + vzTooltipFragment(tel, ix)
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
          : `${mapHintForMetric(colorMetric)} Hover for lap name and coordinates — charts stay synced when you scrub. Scroll wheel zooms; drag to pan. Large uploads: the map draws fewer points when zoomed out and adds detail when you zoom in; double‑click or reset axes to return to the full trail view.`}
      </p>
      {!gatePickMode && runs.length >= 2 && colorMetric !== 'vz_lap_compare' && (
        <p className="gps-map-hint gps-map-hint-secondary">
          For <strong>baseline = solid line</strong> and <strong>compare lap = heatmap</strong> (faster/slower vs
          baseline), set <strong>Trail color</strong> to{' '}
          <strong>Lap compare — run 1 solid line, run 2 heat vs baseline</strong>.
        </p>
      )}
    </div>
  )
}
