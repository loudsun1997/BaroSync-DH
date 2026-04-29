import type { PlotMouseEvent } from 'plotly.js'
import type { MouseEvent as ReactMouseEvent } from 'react'
import { useCallback, useEffect, useMemo, useState } from 'react'
import { distanceSeries, interpXYAlongDistance } from './distanceUtils'
import { plotlyDistanceExplorerConfig } from './plotlyConfig'
import { Plot } from './plotlyFactory'
import { altitudeChartSeries, mapNumericColumn, speedKmhSeries, telemetryLen } from './telemetryAccess'
import type {
  RunResult,
  UploadJobStart,
  UploadJobStatus,
  UploadResponse,
} from './types'
import './App.css'

const UPLOAD_POLL_MS = 200
const UPLOAD_MAX_WAIT_MS = 15 * 60 * 1000
const RUN_COLORS = ['#2f76ff', '#47d95a', '#ff7a21', '#8993a3', '#b76cff']

type Trail = {
  id: string
  name: string
  location?: string | null
  run_count: number
  session_count: number
  total_distance_m?: number | null
  elevation_min_m?: number | null
  elevation_max_m?: number | null
  updated_at: number
}

type StoredRunRecord = {
  id: string
  trail_id?: string | null
  run_count: number
  comparison_ready: number
  file_count?: number
  file_bytes?: number
  alignment_method?: string | null
  shared_distance_m?: number | null
  source_names?: string[]
  created_at: number
}

type AppView = 'upload' | 'overview' | 'runs'
type DetailMetric = 'delta' | 'vz' | 'altitude' | 'speed'
type OverviewAltitudeMode = 'absolute' | 'detail' | 'difference'
type AltitudeAgreementSeverity = 'suspicious' | 'low'

async function pollUploadUntilDone(
  jobId: string,
  onTick: (t: { step: string; pct: number }) => void,
): Promise<UploadResponse> {
  const deadline = Date.now() + UPLOAD_MAX_WAIT_MS
  while (Date.now() < deadline) {
    const res = await fetch(`/upload/status/${jobId}`)
    if (res.status === 404) throw new Error('Upload job expired or was not found')
    if (!res.ok) {
      const j = (await res.json().catch(() => ({}))) as { detail?: string }
      throw new Error(typeof j.detail === 'string' ? j.detail : res.statusText)
    }
    const st = (await res.json()) as UploadJobStatus
    onTick({ step: st.step, pct: st.progress })
    if (st.status === 'done') {
      if (!st.result) throw new Error('Server finished without a result payload')
      return st.result
    }
    if (st.status === 'error') throw new Error(st.error ?? 'Processing failed')
    await new Promise((r) => setTimeout(r, UPLOAD_POLL_MS))
  }
  throw new Error('Processing timed out')
}

function runLabel(run: RunResult, index: number) {
  return run.label ?? `Run ${String.fromCharCode(65 + index)}`
}

function runColor(run: RunResult, index: number) {
  return run.color ?? RUN_COLORS[index % RUN_COLORS.length]
}

function fmtSigned(n: number, digits = 2, unit = '') {
  const sign = n > 0 ? '+' : ''
  return `${sign}${n.toFixed(digits)}${unit}`
}

function fmtDuration(totalSeconds: number | null) {
  if (totalSeconds == null || !Number.isFinite(totalSeconds)) return '--:--.--'
  const mins = Math.floor(totalSeconds / 60)
  const secs = totalSeconds - mins * 60
  return `${mins}:${secs.toFixed(2).padStart(5, '0')}`
}

function fmtMeters(m: number | null | undefined) {
  if (m == null || !Number.isFinite(m)) return '--'
  if (m >= 1000) return `${(m / 1000).toFixed(2)} km`
  return `${Math.round(m)} m`
}

function fmtBytes(bytes: number | null | undefined) {
  if (bytes == null || !Number.isFinite(bytes)) return '--'
  if (bytes >= 1024 * 1024) return `${(bytes / (1024 * 1024)).toFixed(1)} MB`
  if (bytes >= 1024) return `${(bytes / 1024).toFixed(1)} KB`
  return `${Math.round(bytes)} B`
}

function fmtDate(epochSeconds: number | null | undefined) {
  if (epochSeconds == null || !Number.isFinite(epochSeconds)) return '--'
  return new Date(epochSeconds * 1000).toLocaleString(undefined, {
    month: 'short',
    day: 'numeric',
    hour: 'numeric',
    minute: '2-digit',
  })
}

function runDurationS(run: RunResult): number | null {
  const t = run.telemetry
  if (telemetryLen(t) < 2) return null
  if (Array.isArray(t)) {
    const first = t[0]?.time_s
    const last = t[t.length - 1]?.time_s
    if (typeof first === 'number' && typeof last === 'number') return last - first
    return ((t[t.length - 1]?.unix_ns ?? 0) - (t[0]?.unix_ns ?? 0)) / 1e9
  }
  const time = t.time_s
  if (time?.length) {
    const first = time[0]
    const last = time[time.length - 1]
    if (typeof first === 'number' && typeof last === 'number') return last - first
  }
  const first = t.unix_ns[0]
  const last = t.unix_ns[t.unix_ns.length - 1]
  return typeof first === 'number' && typeof last === 'number' ? (last - first) / 1e9 : null
}

function verticalSpeedSeries(run: RunResult): number[] {
  const smooth = mapNumericColumn(run.telemetry, 'vz_smooth_m_s')
  const raw = mapNumericColumn(run.telemetry, 'vz_m_s')
  const hasSmooth = smooth.some((v) => Number.isFinite(v) && Math.abs(v) > 1e-5)
  if (!hasSmooth) return raw
  return smooth.map((v, i) => (Number.isFinite(v) && Math.abs(v) > 1e-5 ? v : raw[i] ?? 0))
}

function kmSeries(run: RunResult): number[] {
  return distanceSeries(run.telemetry).map((m) => m / 1000)
}

function timeSeriesS(run: RunResult): number[] {
  const time = mapNumericColumn(run.telemetry, 'time_s')
  const hasTime = time.some((v) => Number.isFinite(v) && v > 0)
  if (hasTime) return time
  const t = run.telemetry
  const unix = Array.isArray(t) ? t.map((row) => row.unix_ns) : t.unix_ns
  const t0 = unix[0] ?? 0
  return unix.map((ns) => (Number.isFinite(ns) ? (ns - t0) / 1e9 : 0))
}

function totalDistanceKm(runs: RunResult[]) {
  let max = 0
  for (const run of runs) {
    const d = kmSeries(run)
    max = Math.max(max, d[d.length - 1] ?? 0)
  }
  return max
}

function defaultSection(totalKm: number): [number, number] {
  if (totalKm >= 1.25) return [1, 1.2]
  const start = Math.max(0, totalKm * 0.35)
  const end = Math.max(start + 0.05, totalKm * 0.55)
  return [start, end]
}

function clampSection(centerKm: number, totalKm: number, widthKm = 0.2): [number, number] {
  if (totalKm <= widthKm) return [0, Math.max(totalKm, 0.05)]
  const half = widthKm / 2
  const start = Math.max(0, Math.min(centerKm - half, totalKm - widthKm))
  return [start, start + widthKm]
}

function avgInRange(x: number[], y: number[], lo: number, hi: number): number | null {
  let sum = 0
  let count = 0
  for (let i = 0; i < x.length; i++) {
    const xi = x[i]
    const yi = y[i]
    if (xi == null || yi == null || xi < lo || xi > hi || !Number.isFinite(yi)) continue
    sum += yi
    count++
  }
  return count > 0 ? sum / count : null
}

function minMaxInRange(x: number[], y: number[], lo: number, hi: number): [number, number] | null {
  let min = Infinity
  let max = -Infinity
  for (let i = 0; i < x.length; i++) {
    const xi = x[i]
    const yi = y[i]
    if (xi == null || yi == null || xi < lo || xi > hi || !Number.isFinite(yi)) continue
    min = Math.min(min, yi)
    max = Math.max(max, yi)
  }
  return Number.isFinite(min) && Number.isFinite(max) ? [min, max] : null
}

function smoothByDistance(distanceKm: number[], y: number[], windowM: number): number[] {
  if (windowM <= 0 || distanceKm.length < 3) return y
  const halfKm = (windowM / 1000) / 2
  return y.map((_, i) => {
    const center = distanceKm[i]
    if (!Number.isFinite(center)) return y[i] ?? 0
    let sum = 0
    let count = 0
    for (let j = 0; j < y.length; j++) {
      const xj = distanceKm[j]
      const yj = y[j]
      if (!Number.isFinite(xj) || !Number.isFinite(yj) || Math.abs(xj - center) > halfKm) continue
      sum += yj
      count++
    }
    return count ? sum / count : y[i] ?? 0
  })
}

function altitudeDetailByDistance(distanceKm: number[], altitudeM: number[], windowM = 50): number[] {
  if (distanceKm.length < 3 || altitudeM.length < 3) return altitudeM.map(() => 0)
  const halfKm = (windowM / 1000) / 2
  const prefix: number[] = [0]
  const counts: number[] = [0]
  for (let i = 0; i < altitudeM.length; i++) {
    const y = altitudeM[i]
    const finite = Number.isFinite(y)
    prefix.push(prefix[prefix.length - 1] + (finite ? y : 0))
    counts.push(counts[counts.length - 1] + (finite ? 1 : 0))
  }

  let left = 0
  let right = 0
  return altitudeM.map((y, i) => {
    const center = distanceKm[i]
    if (!Number.isFinite(center) || !Number.isFinite(y)) return 0
    while (left < distanceKm.length && distanceKm[left] < center - halfKm) left++
    while (right + 1 < distanceKm.length && distanceKm[right + 1] <= center + halfKm) right++
    const count = counts[right + 1] - counts[left]
    const trend = count > 0 ? (prefix[right + 1] - prefix[left]) / count : y
    return y - trend
  })
}

function altitudeDifferenceByDistance(
  selectedDistanceKm: number[],
  selectedAltitudeM: number[],
  baselineDistanceKm: number[],
  baselineAltitudeM: number[],
): number[] {
  return selectedDistanceKm.map((km, i) => {
    const baseAlt = interpXYAlongDistance(baselineDistanceKm, baselineAltitudeM, km)
    const ownAlt = selectedAltitudeM[i]
    return baseAlt != null && Number.isFinite(ownAlt) ? ownAlt - baseAlt : 0
  })
}

function altitudeAgreementBands(
  distanceKm: number[],
  altitudeDifferenceM: number[],
): { x0: number; x1: number; severity: AltitudeAgreementSeverity }[] {
  if (distanceKm.length < 2 || altitudeDifferenceM.length < 2) return []
  const smoothedDiff = smoothByDistance(distanceKm, altitudeDifferenceM, 10)
  const severityAt = (diffM: number): AltitudeAgreementSeverity | null => {
    const abs = Math.abs(diffM)
    if (abs >= 5) return 'low'
    if (abs >= 2) return 'suspicious'
    return null
  }

  const bands: { x0: number; x1: number; severity: AltitudeAgreementSeverity }[] = []
  let activeSeverity: AltitudeAgreementSeverity | null = null
  let startKm = 0

  for (let i = 0; i < distanceKm.length; i++) {
    const km = distanceKm[i]
    if (!Number.isFinite(km)) continue
    const severity = severityAt(smoothedDiff[i] ?? 0)
    if (severity === activeSeverity) continue
    if (activeSeverity != null) {
      const endKm = distanceKm[Math.max(0, i - 1)] ?? km
      if (endKm - startKm >= 0.006) bands.push({ x0: startKm, x1: endKm, severity: activeSeverity })
    }
    activeSeverity = severity
    startKm = km
  }

  if (activeSeverity != null) {
    const endKm = distanceKm[distanceKm.length - 1] ?? startKm
    if (endKm - startKm >= 0.006) bands.push({ x0: startKm, x1: endKm, severity: activeSeverity })
  }
  return bands
}

function robustSymmetricRange(series: number[][], minPad = 0.75): [number, number] | undefined {
  const vals = series
    .flatMap((s) => s)
    .filter((v) => Number.isFinite(v))
    .map((v) => Math.abs(v))
    .sort((a, b) => a - b)
  if (!vals.length) return undefined
  const p98 = vals[Math.min(vals.length - 1, Math.floor(vals.length * 0.98))]
  const bound = Math.max(p98 * 1.2, minPad)
  return [-bound, bound]
}

function axisRangeForMetric(metric: DetailMetric, traces: { y: number[] }[]): [number, number] | undefined {
  if (metric === 'delta') return [-8, 8]
  const vals = traces.flatMap((trace) => trace.y).filter((v) => Number.isFinite(v))
  if (!vals.length) return undefined
  const min = Math.min(...vals)
  const max = Math.max(...vals)
  if (!Number.isFinite(min) || !Number.isFinite(max)) return undefined
  if (min === max) return [min - 1, max + 1]
  const pad = Math.max((max - min) * 0.12, metric === 'altitude' ? 2 : 1)
  return [min - pad, max + pad]
}

function detailMetricLabel(metric: DetailMetric) {
  switch (metric) {
    case 'delta':
      return 'Vertical Speed Delta'
    case 'vz':
      return 'Vertical Speed'
    case 'altitude':
      return 'Altitude'
    case 'speed':
      return 'Speed'
  }
}

function detailMetricAxis(metric: DetailMetric) {
  switch (metric) {
    case 'delta':
      return 'Delta Vz (m/s)'
    case 'vz':
      return 'Vertical speed (m/s)'
    case 'altitude':
      return 'Altitude (m)'
    case 'speed':
      return 'Speed (km/h)'
  }
}

function detailMetricHover(metric: DetailMetric) {
  switch (metric) {
    case 'delta':
      return '%{y:+.2f} m/s'
    case 'vz':
      return '%{y:.2f} m/s'
    case 'altitude':
      return '%{y:.1f} m'
    case 'speed':
      return '%{y:.1f} km/h'
  }
}

function overviewAltitudeAxis(mode: OverviewAltitudeMode) {
  if (mode === 'detail') return 'Altitude detail (m)'
  if (mode === 'difference') return 'Altitude difference (m)'
  return 'Altitude (m)'
}

function overviewAltitudeHover(mode: OverviewAltitudeMode) {
  if (mode === 'detail') return '%{y:+.2f} m vs trend'
  if (mode === 'difference') return '%{y:+.2f} m vs baseline'
  return '%{y:.1f} m'
}

function colorForDelta(delta: number) {
  const t = Math.max(-1, Math.min(1, delta / 8))
  if (t >= 0) {
    const g = Math.round(228 - t * 118)
    return `rgb(${Math.round(236 - t * 204)}, ${g}, 255)`
  }
  const u = Math.abs(t)
  return `rgb(255, ${Math.round(230 - u * 154)}, ${Math.round(228 - u * 166)})`
}

type DashboardProps = {
  runs: RunResult[]
  baselineRunIndex: number
  onBaselineRunIndex: (index: number) => void
}

function RunDashboard({ runs, baselineRunIndex, onBaselineRunIndex }: DashboardProps) {
  const initialTotalKm = totalDistanceKm(runs)
  const initialSection = defaultSection(initialTotalKm)
  const [selectedRunIndex, setSelectedRunIndex] = useState(0)
  const [sectionKm, setSectionKm] = useState<[number, number]>(initialSection)
  const [activeKm, setActiveKm] = useState<number | null>(initialSection[0] + 0.1)
  const [visibleRuns, setVisibleRuns] = useState<boolean[]>(() => runs.map(() => true))
  const [smoothingM, setSmoothingM] = useState(2)
  const [alignOnDistance, setAlignOnDistance] = useState(true)
  const [detailMetric, setDetailMetric] = useState<DetailMetric>('delta')
  const [overviewAltitudeMode, setOverviewAltitudeMode] = useState<OverviewAltitudeMode>('absolute')

  const totalKm = useMemo(() => totalDistanceKm(runs), [runs])

  const safeBaselineIndex = Math.min(baselineRunIndex, Math.max(0, runs.length - 1))
  const selectableRunIndexes = useMemo(
    () => runs.map((_, index) => index).filter((index) => index !== safeBaselineIndex),
    [runs, safeBaselineIndex],
  )
  const fallbackSelectedRunIndex = selectableRunIndexes[0] ?? safeBaselineIndex
  const safeSelectedRunIndex =
    selectedRunIndex >= 0 && selectedRunIndex < runs.length && selectedRunIndex !== safeBaselineIndex
      ? selectedRunIndex
      : fallbackSelectedRunIndex
  const baselineOptionIndexes = useMemo(
    () => runs.map((_, index) => index).filter((index) => index !== safeSelectedRunIndex),
    [runs, safeSelectedRunIndex],
  )
  const selectedRun = runs[safeSelectedRunIndex]
  const baselineRun = runs[safeBaselineIndex] ?? runs[0]

  useEffect(() => {
    if (selectedRunIndex !== safeSelectedRunIndex) {
      setSelectedRunIndex(safeSelectedRunIndex)
    }
  }, [safeSelectedRunIndex, selectedRunIndex])

  const seriesByRun = useMemo(
    () =>
      runs.map((run) => {
        const distanceKm = kmSeries(run)
        const altitudeM = altitudeChartSeries(run.telemetry)
        return {
          distanceKm,
          timeS: timeSeriesS(run),
          altitudeM,
          altitudeDetailM: altitudeDetailByDistance(distanceKm, altitudeM),
          vzMps: verticalSpeedSeries(run),
          speedKmh: speedKmhSeries(run.telemetry),
          durationS: runDurationS(run),
        }
      }),
    [runs],
  )

  const baselineSeries = seriesByRun[safeBaselineIndex] ?? seriesByRun[0]

  const overviewTraces = useMemo(() => {
    if (!selectedRun || !baselineRun || !baselineSeries) return []
    const selected = seriesByRun[safeSelectedRunIndex]
    if (!selected) return []
    const isDifferenceMode = overviewAltitudeMode === 'difference'
    const baselineY =
      overviewAltitudeMode === 'detail'
        ? baselineSeries.altitudeDetailM
        : baselineSeries.altitudeM
    const selectedY =
      overviewAltitudeMode === 'detail'
        ? selected.altitudeDetailM
        : isDifferenceMode
          ? altitudeDifferenceByDistance(
              selected.distanceKm,
              selected.altitudeM,
              baselineSeries.distanceKm,
              baselineSeries.altitudeM,
            )
          : selected.altitudeM
    const hoverValue = overviewAltitudeHover(overviewAltitudeMode)
    const traces: object[] = [
      {
        x: isDifferenceMode ? selected.distanceKm : baselineSeries.distanceKm,
        y: isDifferenceMode ? selected.distanceKm.map(() => 0) : baselineY,
        type: 'scatter',
        mode: 'lines',
        name: isDifferenceMode ? 'Baseline zero' : `${runLabel(baselineRun, safeBaselineIndex)} baseline`,
        line: {
          color: 'rgba(170, 178, 190, 0.72)',
          width: isDifferenceMode ? 1.5 : 2,
          dash: isDifferenceMode ? 'dash' : 'solid',
          simplify: false,
        },
        connectgaps: true,
        hovertemplate: isDifferenceMode
          ? 'Baseline<br>%{x:.3f} km<br>0.00 m<extra></extra>'
          : `Baseline<br>%{x:.3f} km<br>${hoverValue}<extra></extra>`,
      },
      {
        x: selected.distanceKm,
        y: selectedY,
        type: 'scatter',
        mode: 'lines',
        name: runLabel(selectedRun, safeSelectedRunIndex),
        line: { color: 'rgba(235, 240, 255, 0.82)', width: 2.2, simplify: false },
        connectgaps: true,
        hovertemplate: `${runLabel(selectedRun, safeSelectedRunIndex)}<br>%{x:.3f} km<br>${hoverValue}<extra></extra>`,
      },
    ]
    const step = Math.max(2, Math.floor(selected.distanceKm.length / 90))
    for (let i = 0; i < selected.distanceKm.length - 1; i += step) {
      const end = Math.min(selected.distanceKm.length, i + step + 1)
      const xs = selected.distanceKm.slice(i, end)
      const ys = selectedY.slice(i, end)
      let sum = 0
      let count = 0
      for (const km of xs) {
        const ownVz = interpXYAlongDistance(selected.distanceKm, selected.vzMps, km)
        const baseVz = interpXYAlongDistance(baselineSeries.distanceKm, baselineSeries.vzMps, km)
        if (ownVz == null || baseVz == null) continue
        sum += ownVz - baseVz
        count++
      }
      traces.push({
        x: xs,
        y: ys,
        type: 'scatter',
        mode: 'lines',
        name: ' ',
        showlegend: false,
        line: { color: colorForDelta(count ? sum / count : 0), width: 3.2, simplify: false },
        connectgaps: true,
        hoverinfo: 'skip',
      })
    }
    return traces
  }, [baselineRun, baselineSeries, overviewAltitudeMode, safeBaselineIndex, safeSelectedRunIndex, selectedRun, seriesByRun])

  const overviewYRange = useMemo(() => {
    if (overviewAltitudeMode === 'absolute') return undefined
    const selected = seriesByRun[safeSelectedRunIndex]
    if (!selected || !baselineSeries) return undefined
    if (overviewAltitudeMode === 'difference') {
      const diff = altitudeDifferenceByDistance(
        selected.distanceKm,
        selected.altitudeM,
        baselineSeries.distanceKm,
        baselineSeries.altitudeM,
      )
      return robustSymmetricRange([diff, [0]])
    }
    return robustSymmetricRange([baselineSeries.altitudeDetailM, selected.altitudeDetailM])
  }, [baselineSeries, overviewAltitudeMode, safeSelectedRunIndex, seriesByRun])

  const altitudeAgreementShapes = useMemo(() => {
    const selected = seriesByRun[safeSelectedRunIndex]
    if (!selected || !baselineSeries) return []
    const diff = altitudeDifferenceByDistance(
      selected.distanceKm,
      selected.altitudeM,
      baselineSeries.distanceKm,
      baselineSeries.altitudeM,
    )
    return altitudeAgreementBands(selected.distanceKm, diff).map((band) => ({
      type: 'rect',
      xref: 'x',
      yref: 'paper',
      x0: band.x0,
      x1: band.x1,
      y0: 0,
      y1: 1,
      fillcolor: band.severity === 'low' ? 'rgba(255, 79, 69, 0.16)' : 'rgba(255, 184, 77, 0.1)',
      line: { width: 0 },
      layer: 'below',
    }))
  }, [baselineSeries, safeSelectedRunIndex, seriesByRun])

  const sectionLabels = useMemo(() => {
    const labels = ['Start', 'Upper Chute', 'Big Corner', 'Road Gap', 'Lower Steeps', 'Finish']
    return labels.map((label, i) => ({ label, km: totalKm * (i / Math.max(1, labels.length - 1)) }))
  }, [totalKm])

  const selectedSectionName = useMemo(() => {
    const center = (sectionKm[0] + sectionKm[1]) / 2
    return sectionLabels.reduce((best, item) =>
      Math.abs(item.km - center) < Math.abs(best.km - center) ? item : best
    , sectionLabels[0] ?? { label: 'Selected Section', km: center }).label
  }, [sectionKm, sectionLabels])

  const overviewLayout = useMemo(
    () => ({
      paper_bgcolor: 'rgba(0,0,0,0)',
      plot_bgcolor: 'rgba(0,0,0,0)',
      font: { color: '#f4f7fb', family: 'Inter, system-ui, sans-serif' },
      hoverlabel: {
        bgcolor: 'rgba(8, 14, 23, 0.96)',
        bordercolor: 'rgba(180, 198, 224, 0.45)',
        font: { color: '#f7fbff', size: 12, family: 'Inter, system-ui, sans-serif' },
        align: 'left',
      },
      margin: { t: 44, r: 28, b: 54, l: 78 },
      dragmode: 'pan',
      hovermode: 'x unified',
      showlegend: false,
      xaxis: {
        title: { text: 'Distance (km)', font: { color: '#f4f7fb', size: 13 } },
        range: [0, Math.max(totalKm, 0.1)],
        tickfont: { color: '#f4f7fb' },
        gridcolor: 'rgba(126, 148, 171, 0.17)',
        zerolinecolor: 'rgba(126, 148, 171, 0.18)',
        linecolor: 'rgba(188, 202, 219, 0.35)',
      },
      yaxis: {
        title: { text: overviewAltitudeAxis(overviewAltitudeMode), font: { color: '#f4f7fb', size: 13 } },
        range: overviewYRange,
        fixedrange: true,
        tickfont: { color: '#f4f7fb' },
        gridcolor: 'rgba(126, 148, 171, 0.17)',
        zeroline: overviewAltitudeMode !== 'absolute',
        zerolinecolor: 'rgba(126, 148, 171, 0.18)',
        linecolor: 'rgba(188, 202, 219, 0.35)',
      },
      shapes: [
        ...altitudeAgreementShapes,
        {
          type: 'rect',
          xref: 'x',
          yref: 'paper',
          x0: sectionKm[0],
          x1: sectionKm[1],
          y0: 0,
          y1: 1,
          fillcolor: 'rgba(190, 204, 219, 0.08)',
          line: { color: 'rgba(233, 238, 246, 0.82)', width: 1.2, dash: 'dash' },
          layer: 'below',
        },
        ...sectionLabels.slice(1, -1).map((s) => ({
          type: 'line',
          xref: 'x',
          yref: 'paper',
          x0: s.km,
          x1: s.km,
          y0: 0,
          y1: 1,
          line: { color: 'rgba(150, 165, 183, 0.28)', width: 1, dash: 'dash' },
        })),
      ],
      annotations: sectionLabels.map((s) => ({
        x: s.km,
        y: 1.04,
        xref: 'x',
        yref: 'paper',
        text: s.label,
        showarrow: false,
        font: { size: 12, color: '#ffffff' },
      })),
    }),
    [altitudeAgreementShapes, overviewAltitudeMode, overviewYRange, sectionKm, sectionLabels, totalKm],
  )

  const detailTraceModels = useMemo(() => {
    if (!baselineSeries) return []
    return runs.flatMap((run, index) => {
      if (visibleRuns[index] === false) return []
      const current = seriesByRun[index]
      if (!current) return []
      let y: number[]
      if (detailMetric === 'delta') {
        y = current.distanceKm.map((km, i) => {
          if (index === safeBaselineIndex) return 0
          const baseVz = interpXYAlongDistance(baselineSeries.distanceKm, baselineSeries.vzMps, km)
          return (current.vzMps[i] ?? 0) - (baseVz ?? 0)
        })
      } else if (detailMetric === 'vz') {
        y = current.vzMps
      } else if (detailMetric === 'altitude') {
        y = current.altitudeM
      } else {
        y = current.speedKmh
      }
      y = smoothByDistance(current.distanceKm, y, smoothingM)
      const x = alignOnDistance ? current.distanceKm : current.timeS
      return [{
        x,
        y,
        distanceKm: current.distanceKm,
        name: index === safeBaselineIndex ? 'Slowest' : runLabel(run, index),
        index,
      }]
    })
  }, [alignOnDistance, baselineSeries, detailMetric, runs, safeBaselineIndex, seriesByRun, smoothingM, visibleRuns])

  const detailTraces = useMemo(() => {
    return detailTraceModels.map((trace) => ({
        x: trace.x,
        y: trace.y,
        type: 'scatter',
        mode: 'lines',
        name: trace.name,
        line: {
          color: trace.index === safeBaselineIndex ? '#9aa5b5' : runColor(runs[trace.index], trace.index),
          width: trace.index === safeBaselineIndex ? 1.6 : 2,
          dash: trace.index === safeBaselineIndex ? 'dash' : 'solid',
        },
        customdata: trace.distanceKm,
        hovertemplate: `${trace.name}<br>${alignOnDistance ? '%{x:.2f} km' : '%{x:.1f} s'}<br>${detailMetricHover(detailMetric)}<extra></extra>`,
      }))
  }, [alignOnDistance, detailMetric, detailTraceModels, runs, safeBaselineIndex])

  const detailXRange = useMemo(() => {
    if (alignOnDistance) return sectionKm
    const selectedSeries = seriesByRun[safeSelectedRunIndex]
    if (!selectedSeries) return undefined
    const t0 = interpXYAlongDistance(selectedSeries.distanceKm, selectedSeries.timeS, sectionKm[0])
    const t1 = interpXYAlongDistance(selectedSeries.distanceKm, selectedSeries.timeS, sectionKm[1])
    return t0 != null && t1 != null ? [t0, t1] as [number, number] : undefined
  }, [alignOnDistance, safeSelectedRunIndex, sectionKm, seriesByRun])

  const detailYRange = useMemo(() => axisRangeForMetric(detailMetric, detailTraceModels), [detailMetric, detailTraceModels])

  const activeDetailX = useMemo(() => {
    if (activeKm == null || alignOnDistance) return activeKm
    const selectedSeries = seriesByRun[safeSelectedRunIndex]
    if (!selectedSeries) return null
    return interpXYAlongDistance(selectedSeries.distanceKm, selectedSeries.timeS, activeKm)
  }, [activeKm, alignOnDistance, safeSelectedRunIndex, seriesByRun])

  const detailLayout = useMemo(
    () => ({
      paper_bgcolor: 'rgba(0,0,0,0)',
      plot_bgcolor: 'rgba(0,0,0,0)',
      font: { color: '#f4f7fb', family: 'Inter, system-ui, sans-serif' },
      hoverlabel: {
        bgcolor: 'rgba(8, 14, 23, 0.96)',
        bordercolor: 'rgba(180, 198, 224, 0.45)',
        font: { color: '#f7fbff', size: 12, family: 'Inter, system-ui, sans-serif' },
        align: 'left',
      },
      margin: { t: 14, r: 24, b: 46, l: 60 },
      hovermode: 'x unified',
      dragmode: 'pan',
      showlegend: false,
      xaxis: {
        title: { text: alignOnDistance ? 'Distance (km)' : 'Time (s)', font: { color: '#f4f7fb', size: 13 } },
        range: detailXRange,
        tickfont: { color: '#f4f7fb' },
        gridcolor: 'rgba(126, 148, 171, 0.16)',
        linecolor: 'rgba(188, 202, 219, 0.35)',
      },
      yaxis: {
        title: { text: detailMetricAxis(detailMetric), font: { color: '#f4f7fb', size: 12 } },
        range: detailYRange,
        tickfont: { color: '#f4f7fb' },
        gridcolor: 'rgba(126, 148, 171, 0.16)',
        zeroline: true,
        zerolinecolor: 'rgba(232, 238, 247, 0.5)',
        zerolinewidth: 1,
        linecolor: 'rgba(188, 202, 219, 0.35)',
      },
      shapes:
        activeDetailX == null
          ? []
          : [
              {
                type: 'line',
                xref: 'x',
                yref: 'paper',
                x0: activeDetailX,
                x1: activeDetailX,
                y0: 0,
                y1: 1,
                line: { color: 'rgba(255,255,255,0.82)', width: 1 },
              },
            ],
    }),
    [activeDetailX, alignOnDistance, detailMetric, detailXRange, detailYRange],
  )

  const sectionStats = useMemo(() => {
    if (!baselineSeries) return []
    return runs.map((run, index) => {
      const current = seriesByRun[index]
      const delta =
        current?.distanceKm.map((km, i) => {
          if (index === safeBaselineIndex) return 0
          const baseVz = interpXYAlongDistance(baselineSeries.distanceKm, baselineSeries.vzMps, km)
          return (current.vzMps[i] ?? 0) - (baseVz ?? 0)
        }) ?? []
      const avg = current ? avgInRange(current.distanceKm, delta, sectionKm[0], sectionKm[1]) : null
      const mm = current ? minMaxInRange(current.distanceKm, delta, sectionKm[0], sectionKm[1]) : null
      return { run, index, avg: avg ?? 0, min: mm?.[0] ?? 0, max: mm?.[1] ?? 0 }
    })
  }, [baselineSeries, runs, safeBaselineIndex, sectionKm, seriesByRun])

  const durations = useMemo(() => seriesByRun.map((s) => s.durationS), [seriesByRun])
  const baselineDuration = durations[safeBaselineIndex] ?? null

  const handleOverviewClick = useCallback(
    (ev: PlotMouseEvent) => {
      const rawX = ev.points?.[0]?.x
      const x = typeof rawX === 'number' ? rawX : Number(rawX)
      if (Number.isFinite(x)) {
        setSectionKm(clampSection(x, totalKm))
        setActiveKm(x)
      }
    },
    [totalKm],
  )

  const handleOverviewPanelClick = useCallback(
    (ev: ReactMouseEvent<HTMLDivElement>) => {
      const target = ev.target as HTMLElement | null
      if (target?.closest('.modebar') || target?.closest('.select-block')) return
      const rect = ev.currentTarget.getBoundingClientRect()
      const plotLeft = 78
      const plotRight = 28
      const plotWidth = Math.max(1, rect.width - plotLeft - plotRight)
      const frac = (ev.clientX - rect.left - plotLeft) / plotWidth
      if (frac < -0.04 || frac > 1.04) return
      const km = Math.max(0, Math.min(totalKm, frac * totalKm))
      setSectionKm(clampSection(km, totalKm))
      setActiveKm(km)
    },
    [totalKm],
  )

  const handleDetailHover = useCallback((ev: PlotMouseEvent) => {
    const point = ev.points?.[0]
    const custom = point?.customdata
    const rawX = Array.isArray(custom) ? custom[0] : custom ?? point?.x
    const x = typeof rawX === 'number' ? rawX : Number(rawX)
    if (Number.isFinite(x)) setActiveKm(x)
  }, [])

  return (
    <main className="dashboard-shell">
      <section className="dash-panel overview-panel">
        <div className="panel-head overview-head">
          <div>
            <h2>ALTITUDE vs DISTANCE <span className="info-dot">i</span></h2>
            <p>
              {overviewAltitudeMode === 'detail'
                ? 'Detrended altitude shows local trail shape; line color still shows vertical-speed difference vs baseline.'
                : overviewAltitudeMode === 'difference'
                  ? 'Altitude difference shows where the selected run disagrees with the baseline profile.'
                  : 'Line colored by vertical-speed difference vs baseline, not acceleration or braking.'}
            </p>
            <div className="confidence-legend" aria-label="Altitude agreement">
              <span>Altitude agreement</span>
              <i className="confidence-swatch suspicious" />
              <span>2-5 m</span>
              <i className="confidence-swatch low" />
              <span>&gt;5 m</span>
            </div>
          </div>
          <div className="overview-controls">
            <div className="segmented-control" aria-label="Altitude view">
              <button
                type="button"
                className={overviewAltitudeMode === 'absolute' ? 'is-active' : ''}
                onClick={() => setOverviewAltitudeMode('absolute')}
              >
                Absolute
              </button>
              <button
                type="button"
                className={overviewAltitudeMode === 'detail' ? 'is-active' : ''}
                onClick={() => setOverviewAltitudeMode('detail')}
              >
                Detail
              </button>
              <button
                type="button"
                className={overviewAltitudeMode === 'difference' ? 'is-active' : ''}
                onClick={() => setOverviewAltitudeMode('difference')}
              >
                Difference
              </button>
            </div>
            <label className="select-block">
              <span>Selected Run</span>
              <select
                value={safeSelectedRunIndex}
                disabled={selectableRunIndexes.length === 0}
                onChange={(e) => setSelectedRunIndex(Number(e.target.value))}
              >
                {(selectableRunIndexes.length ? selectableRunIndexes : [safeSelectedRunIndex]).map((i) => {
                  const run = runs[i]
                  return (
                  <option key={run.source_name ?? i} value={i}>
                    {selectableRunIndexes.length ? runLabel(run, i) : 'No comparison run'}
                  </option>
                  )
                })}
              </select>
            </label>
            <span className="vs-label">vs</span>
            <label className="select-block compact-select">
              <span>Baseline</span>
              <select value={safeBaselineIndex} onChange={(e) => onBaselineRunIndex(Number(e.target.value))}>
                {(baselineOptionIndexes.length ? baselineOptionIndexes : [safeBaselineIndex]).map((i) => {
                  const run = runs[i]
                  return (
                  <option key={run.source_name ?? i} value={i}>
                    {i === safeBaselineIndex ? 'Slowest Run (Baseline)' : runLabel(run, i)}
                  </option>
                  )
                })}
              </select>
            </label>
          </div>
          <div className="delta-scale" aria-hidden="true">
            <div className="delta-scale-top">
              <span>Lower Vz<br />than baseline</span>
              <span>Higher Vz<br />than baseline</span>
            </div>
            <div className="delta-scale-bar"><i /></div>
            <div className="delta-scale-values">
              <span>-8 m/s</span>
              <span>0 m/s</span>
              <span>+8 m/s</span>
            </div>
          </div>
        </div>
        <div className="overview-plot-hitarea" onClick={handleOverviewPanelClick}>
          <Plot
            data={overviewTraces}
            layout={overviewLayout}
            config={plotlyDistanceExplorerConfig}
            style={{ width: '100%', height: 330 }}
            onClick={handleOverviewClick}
          />
        </div>
      </section>

      <section className="section-workbench">
        <aside className="dash-panel selected-section-panel">
          <h2>SELECTED SECTION</h2>
          <p className="section-distance">
            {sectionKm[0].toFixed(2)} km - {sectionKm[1].toFixed(2)} km
            <span>({Math.round((sectionKm[1] - sectionKm[0]) * 1000)} m)</span>
          </p>
          <p className="section-name">{selectedSectionName}</p>
          <div className="metric-table">
            <div className="metric-table-head">
              <span>Vertical Speed Delta (vs Slowest)</span>
              <span>Avg Delta Vz</span>
              <span>Max | Min</span>
            </div>
            {sectionStats.map(({ run, index, avg, max, min }) => (
              <div className="metric-row" key={run.source_name ?? index}>
                <span className="run-name">
                  <i style={{ background: index === safeBaselineIndex ? '#8993a3' : runColor(run, index) }} />
                  {index === safeBaselineIndex ? 'Slowest (Baseline)' : runLabel(run, index)}
                </span>
                <span className={avg < -0.15 ? 'negative' : avg > 0.15 ? 'positive' : ''}>
                  {fmtSigned(avg, 2, ' m/s')}
                </span>
                <span>{fmtSigned(max, 1)} / {fmtSigned(min, 1)}</span>
              </div>
            ))}
          </div>
        </aside>

        <div className="dash-panel detail-chart-panel">
          <div className="detail-tabs">
            {(['delta', 'vz', 'altitude', 'speed'] as DetailMetric[]).map((metric) => (
              <button
                key={metric}
                className={detailMetric === metric ? 'is-active' : ''}
                type="button"
                onClick={() => setDetailMetric(metric)}
              >
                {detailMetricLabel(metric)}
              </button>
            ))}
            <div className="detail-tools">
              <label>
                Smoothing
                <select value={smoothingM} onChange={(e) => setSmoothingM(Number(e.target.value))}>
                  <option value={0}>Off</option>
                  <option value={2}>2 m</option>
                  <option value={5}>5 m</option>
                </select>
              </label>
              <label className="check-control">
                <input
                  type="checkbox"
                  checked={alignOnDistance}
                  onChange={(e) => setAlignOnDistance(e.target.checked)}
                />
                Align on Distance
              </label>
              <button type="button" onClick={() => setSectionKm(defaultSection(totalKm))}>Reset Zoom</button>
            </div>
          </div>
          <Plot
            data={detailTraces}
            layout={detailLayout}
            config={plotlyDistanceExplorerConfig}
            style={{ width: '100%', height: 285 }}
            onHover={handleDetailHover}
          />
        </div>
      </section>

      <section className="dash-panel compare-runs">
        <div className="compare-copy">
          <h2>COMPARE RUNS</h2>
          <p>Show or hide runs in the detail chart</p>
        </div>
        <div className="run-cards">
          {runs.map((run, index) => {
            const duration = durations[index]
            const delta = baselineDuration != null && duration != null ? duration - baselineDuration : null
            return (
              <label className="run-card" key={run.source_name ?? index}>
                <input
                  type="checkbox"
                  checked={visibleRuns[index] !== false}
                  onChange={() =>
                    setVisibleRuns((prev) => {
                      const next = prev.length ? [...prev] : runs.map(() => true)
                      next[index] = next[index] === false
                      return next
                    })
                  }
                />
                <span className="run-swatch" style={{ background: index === safeBaselineIndex ? '#8993a3' : runColor(run, index) }} />
                <strong>{index === safeBaselineIndex ? 'Slowest (Baseline)' : runLabel(run, index)}</strong>
                <span>{fmtDuration(duration)}</span>
                {delta != null && index !== safeBaselineIndex && (
                  <span className={delta <= 0 ? 'time-good' : 'time-bad'}>{fmtSigned(delta, 2, 's')}</span>
                )}
              </label>
            )
          })}
        </div>
      </section>
    </main>
  )
}

type UploadWorkspaceProps = {
  busy: boolean
  trails: Trail[]
  selectedTrailId: string
  newTrailName: string
  selectedFiles: File[]
  recentRunRecords: StoredRunRecord[]
  onSelectedTrailId: (id: string) => void
  onNewTrailName: (name: string) => void
  onFiles: (files: FileList | null) => void
  onClearFiles: () => void
  onUpload: () => void
  onLoadRunRecord: (recordId: string) => void
}

function UploadWorkspace({
  busy,
  trails,
  selectedTrailId,
  newTrailName,
  selectedFiles,
  recentRunRecords,
  onSelectedTrailId,
  onNewTrailName,
  onFiles,
  onClearFiles,
  onUpload,
  onLoadRunRecord,
}: UploadWorkspaceProps) {
  const selectedTrail = trails.find((trail) => trail.id === selectedTrailId)

  return (
    <main className="upload-workspace">
      <section className="dash-panel upload-library">
        <div className="upload-section-head">
          <h2>Trail Library</h2>
          <p>Pick where this telemetry should improve the route model.</p>
        </div>
        <div className="trail-list">
          {trails.map((trail) => (
            <button
              key={trail.id}
              type="button"
              className={trail.id === selectedTrailId ? 'trail-item is-selected' : 'trail-item'}
              onClick={() => {
                onSelectedTrailId(trail.id)
                onNewTrailName('')
              }}
            >
              <strong>{trail.name}</strong>
              <span>{trail.location || 'Unlabeled location'}</span>
              <em>{trail.run_count} runs · raw files retained</em>
            </button>
          ))}
        </div>
      </section>

      <section className="dash-panel upload-panel">
        <div className="upload-section-head">
          <h2>Add Run Data</h2>
          <p>Upload one or more Sensor Logger ZIPs. Two-run uploads auto-detect the shared start and finish.</p>
        </div>

        <div className="upload-form-grid">
          <label className="field-stack">
            <span>Trail</span>
            <select
              value={selectedTrailId}
              onChange={(e) => {
                onSelectedTrailId(e.target.value)
                onNewTrailName('')
              }}
            >
              {trails.map((trail) => (
                <option key={trail.id} value={trail.id}>{trail.name}</option>
              ))}
            </select>
          </label>
          <label className="field-stack">
            <span>Or create trail</span>
            <input
              value={newTrailName}
              placeholder="New trail name"
              onChange={(e) => onNewTrailName(e.target.value)}
            />
          </label>
        </div>

        <label className="drop-zone">
          <input
            type="file"
            accept=".zip,application/zip"
            multiple
            disabled={busy}
            onChange={(e) => onFiles(e.target.files)}
          />
          <span>Choose ZIP files</span>
          <strong>{selectedFiles.length ? `${selectedFiles.length} file(s) staged` : 'No files staged'}</strong>
        </label>

        {selectedFiles.length > 0 && (
          <div className="staged-files">
            {selectedFiles.map((file) => (
              <span key={`${file.name}-${file.size}`}>{file.name}</span>
            ))}
          </div>
        )}

        <div className="upload-actions-row">
          <button
            type="button"
            className="cockpit-btn primary-upload"
            disabled={busy || selectedFiles.length === 0 || (!selectedTrail && !newTrailName.trim())}
            onClick={onUpload}
          >
            {busy ? 'Processing...' : 'Process Upload'}
          </button>
          <button type="button" className="cockpit-btn ghost-btn" disabled={busy || selectedFiles.length === 0} onClick={onClearFiles}>
            Clear Files
          </button>
        </div>

        <div className="trail-model-note">
          <strong>Trail model update</strong>
          <span>Every upload adds raw files and processed telemetry to the selected trail, so the route model gets sharper over time.</span>
        </div>
      </section>

      <section className="dash-panel upload-history">
        <div className="upload-section-head">
          <h2>Recent Runs</h2>
          <p>Open previously processed trail data without reprocessing the ZIPs.</p>
        </div>
        <div className="run-record-list">
          {recentRunRecords.length === 0 && <p className="muted-line">No stored runs yet.</p>}
          {recentRunRecords.map((record) => (
            <button key={record.id} type="button" className="run-record-item" onClick={() => onLoadRunRecord(record.id)}>
              <strong>{record.source_names?.join(' + ') || 'Processed trail run'}</strong>
              <span>{fmtDate(record.created_at)} · {record.run_count} runs</span>
              <em>{record.file_count ?? 0} raw files / {fmtBytes(record.file_bytes)} · reprocesses on open</em>
            </button>
          ))}
        </div>
      </section>
    </main>
  )
}

type RunsWorkspaceProps = {
  runs: RunResult[]
  trails: Trail[]
  selectedTrailId: string
  selectedTrailRunRecords: StoredRunRecord[]
  baselineRunIndex: number
  onSelectedTrailId: (trailId: string) => void
  onLoadRunRecord: (recordId: string) => void
  onUploadView: () => void
}

function RunsWorkspace({
  runs,
  trails,
  selectedTrailId,
  selectedTrailRunRecords,
  baselineRunIndex,
  onSelectedTrailId,
  onLoadRunRecord,
  onUploadView,
}: RunsWorkspaceProps) {
  const selectedTrail = trails.find((trail) => trail.id === selectedTrailId)
  const pastRuns = selectedTrailRunRecords.flatMap((record) => {
    const names = record.source_names?.length ? record.source_names : ['Processed trail run']
    return names.map((name, index) => ({
      key: `${record.id}-${index}`,
      recordId: record.id,
      name,
      record,
      uploadPart: names.length > 1 ? `${index + 1} of ${names.length}` : null,
    }))
  })

  return (
    <main className="runs-workspace">
      <section className="dash-panel runs-panel">
        <div className="upload-section-head">
          <h2>Trails</h2>
          <p>Choose a trail to see every processed run attached to it.</p>
        </div>
        <div className="trail-summary-list">
          {trails.length === 0 && <p className="muted-line">No trails yet.</p>}
          {trails.map((trail) => (
            <button
              className={trail.id === selectedTrailId ? 'trail-summary-item is-selected' : 'trail-summary-item'}
              type="button"
              key={trail.id}
              onClick={() => onSelectedTrailId(trail.id)}
            >
              <strong>{trail.name}</strong>
              <span>{trail.location || 'Unlabeled location'}</span>
              <em>{trail.run_count} runs · raw files retained</em>
            </button>
          ))}
        </div>
      </section>

      <section className="dash-panel runs-panel trail-run-history">
        <div className="upload-section-head">
          <h2>{selectedTrail ? `${selectedTrail.name} Runs` : 'Past Runs'}</h2>
          <p>{selectedTrail ? 'Open a past run set to inspect it in Overview.' : 'Select a trail to see its past runs.'}</p>
        </div>
        <div className="run-record-list">
          {selectedTrail && pastRuns.length === 0 && (
            <div className="empty-state-inline">
              <strong>No runs stored for this trail yet.</strong>
              <button type="button" className="cockpit-btn primary-upload" onClick={onUploadView}>Add Run Data</button>
            </div>
          )}
          {!selectedTrail && <p className="muted-line">Pick a trail from the left.</p>}
          {pastRuns.map((pastRun) => (
            <button key={pastRun.key} type="button" className="run-record-item" onClick={() => onLoadRunRecord(pastRun.recordId)}>
              <strong>{pastRun.name}</strong>
              <span>
                {fmtDate(pastRun.record.created_at)}
                {pastRun.uploadPart ? ` · upload ${pastRun.uploadPart}` : ''}
              </span>
              <em>{pastRun.record.file_count ?? 0} raw files · reprocesses on open</em>
            </button>
          ))}
        </div>
      </section>

      <section className="dash-panel runs-panel">
        <div className="upload-section-head">
          <h2>Loaded Analysis</h2>
          <p>{runs.length ? 'The run set currently shown in Overview.' : 'No run data loaded yet.'}</p>
        </div>
        {runs.length ? (
          <div className="loaded-run-list">
            {runs.map((run, index) => {
              const duration = runDurationS(run)
              const distanceM = distanceSeries(run.telemetry).at(-1)
              return (
                <article className="loaded-run-item" key={run.source_name ?? index}>
                  <span className="run-swatch" style={{ background: index === baselineRunIndex ? '#8993a3' : runColor(run, index) }} />
                  <div>
                    <strong>{index === baselineRunIndex ? `${runLabel(run, index)} · Baseline` : runLabel(run, index)}</strong>
                    <span>{run.source_name || 'No source name'}</span>
                  </div>
                  <em>{fmtDuration(duration)}</em>
                  <em>{fmtMeters(typeof distanceM === 'number' ? distanceM : null)}</em>
                  <em>{telemetryLen(run.telemetry)} samples</em>
                </article>
              )
            })}
          </div>
        ) : (
          <div className="empty-state-inline">
            <strong>Select a past run or add new run data.</strong>
            <button type="button" className="cockpit-btn primary-upload" onClick={onUploadView}>Go to Upload</button>
          </div>
        )}
      </section>
    </main>
  )
}

type OverviewEmptyProps = {
  recentRunRecords: StoredRunRecord[]
  onUploadView: () => void
  onLoadRunRecord: (recordId: string) => void
}

function OverviewEmpty({ recentRunRecords, onUploadView, onLoadRunRecord }: OverviewEmptyProps) {
  return (
    <main className="empty-overview">
      <section className="dash-panel empty-overview-panel">
        <h2>No Run Loaded</h2>
        <p>Overview is where the analysis dashboard appears after an upload or after you open a past trail run.</p>
        <div className="upload-actions-row">
          <button type="button" className="cockpit-btn primary-upload" onClick={onUploadView}>Go to Upload</button>
          {recentRunRecords[0] && (
            <button type="button" className="cockpit-btn ghost-btn" onClick={() => onLoadRunRecord(recentRunRecords[0]!.id)}>
              Open Latest Run
            </button>
          )}
        </div>
      </section>
    </main>
  )
}

export default function App() {
  const [data, setData] = useState<UploadResponse | null>(null)
  const [busy, setBusy] = useState(false)
  const [uploadProgress, setUploadProgress] = useState<{ step: string; pct: number } | null>(null)
  const [err, setErr] = useState<string | null>(null)
  const [baselineRunIndex, setBaselineRunIndex] = useState(0)
  const [trails, setTrails] = useState<Trail[]>([])
  const [selectedTrailId, setSelectedTrailId] = useState('')
  const [newTrailName, setNewTrailName] = useState('')
  const [selectedFiles, setSelectedFiles] = useState<File[]>([])
  const [recentRunRecords, setRecentRunRecords] = useState<StoredRunRecord[]>([])
  const [selectedTrailRunRecords, setSelectedTrailRunRecords] = useState<StoredRunRecord[]>([])
  const [activeView, setActiveView] = useState<AppView>('upload')

  const runs = data?.runs ?? []

  const refreshTrails = useCallback(async () => {
    const res = await fetch('/trails')
    if (!res.ok) throw new Error('Could not load trails')
    const json = (await res.json()) as { trails: Trail[] }
    setTrails(json.trails)
    setSelectedTrailId((current) => current || json.trails[0]?.id || '')
  }, [])

  const refreshRunRecords = useCallback(async () => {
    const res = await fetch('/runs?limit=10')
    if (!res.ok) throw new Error('Could not load stored runs')
    const json = (await res.json()) as { runs: StoredRunRecord[] }
    setRecentRunRecords(json.runs)
  }, [])

  const refreshTrailRunRecords = useCallback(async (trailId: string) => {
    if (!trailId) {
      setSelectedTrailRunRecords([])
      return
    }
    const res = await fetch(`/trails/${trailId}/runs?limit=200`)
    if (!res.ok) throw new Error('Could not load trail runs')
    const json = (await res.json()) as { runs: StoredRunRecord[] }
    setSelectedTrailRunRecords(json.runs)
  }, [])

  useEffect(() => {
    void Promise.all([refreshTrails(), refreshRunRecords()]).catch((e) => {
      setErr(e instanceof Error ? e.message : 'Could not load stored data')
    })
  }, [refreshRunRecords, refreshTrails])

  useEffect(() => {
    void refreshTrailRunRecords(selectedTrailId).catch((e) => {
      setErr(e instanceof Error ? e.message : 'Could not load trail runs')
    })
  }, [refreshTrailRunRecords, selectedTrailId])

  const applyUpload = useCallback((json: UploadResponse) => {
    setData(json)
    setActiveView('overview')
    if (json?.runs?.length) {
      let slowest = 0
      let slowestDuration = -Infinity
      json.runs.forEach((run, index) => {
        const duration = runDurationS(run)
        if (duration != null && duration > slowestDuration) {
          slowestDuration = duration
          slowest = index
        }
      })
      setBaselineRunIndex(slowest)
    }
  }, [])

  const runUpload = useCallback(
    async (buildFormData: () => FormData) => {
      setErr(null)
      setBusy(true)
      setUploadProgress({ step: 'Sending files...', pct: 0 })
      try {
        const fd = buildFormData()
        const res = await fetch('/upload', { method: 'POST', body: fd })
        if (!res.ok) {
          const j = (await res.json().catch(() => ({}))) as { detail?: string | { msg?: string }[] }
          const d = j.detail
          const msg =
            typeof d === 'string' ? d : Array.isArray(d) ? d.map((x) => x.msg ?? JSON.stringify(x)).join('; ') : res.statusText
          throw new Error(msg)
        }
        const start = (await res.json()) as UploadJobStart
        if (!start.job_id) throw new Error('Server did not return a job id')
        const json = await pollUploadUntilDone(start.job_id, (t) => setUploadProgress(t))
        applyUpload(json)
        setSelectedFiles([])
        setNewTrailName('')
        await Promise.all([refreshTrails(), refreshRunRecords(), refreshTrailRunRecords(selectedTrailId)])
      } catch (e) {
        setErr(e instanceof Error ? e.message : 'Upload failed')
      } finally {
        setBusy(false)
        setUploadProgress(null)
      }
    },
    [applyUpload, refreshRunRecords, refreshTrailRunRecords, refreshTrails, selectedTrailId],
  )

  const onFiles = useCallback(
    (fileList: FileList | null) => {
      if (!fileList?.length) return
      const zips = Array.from(fileList).filter((f) => f.name.toLowerCase().endsWith('.zip'))
      if (!zips.length) return
      setSelectedFiles(zips)
    },
    [],
  )

  const uploadSelectedFiles = useCallback(() => {
    if (!selectedFiles.length) return
    void runUpload(() => {
      const fd = new FormData()
      if (newTrailName.trim()) {
        fd.append('create_trail_name', newTrailName.trim())
      } else if (selectedTrailId) {
        fd.append('trail_id', selectedTrailId)
      }
      for (const f of selectedFiles) fd.append('files', f)
      return fd
    })
  }, [newTrailName, runUpload, selectedFiles, selectedTrailId])

  const loadStoredRunRecord = useCallback(
    async (recordId: string) => {
      setErr(null)
      setBusy(true)
      try {
        const res = await fetch(`/runs/${recordId}`)
        if (!res.ok) throw new Error('Could not load stored run')
        applyUpload((await res.json()) as UploadResponse)
      } catch (e) {
        setErr(e instanceof Error ? e.message : 'Could not load stored run')
      } finally {
        setBusy(false)
      }
    },
    [applyUpload],
  )

  const selectedTrail = trails.find((trail) => trail.id === selectedTrailId)

  return (
    <div className="app">
      <header className="topbar">
        <div className="brand-lockup">
          <div className="brand-mark" aria-hidden="true"><span /></div>
          <div>
            <h1>BAROSYNC <span>DH</span></h1>
            <p>MTB PERFORMANCE LAB</p>
          </div>
        </div>
        <button className="route-picker" type="button" onClick={() => setActiveView('runs')}>
          <span className="route-icon">^</span>
          {selectedTrail?.name ?? 'Select Trail'}
          <span className="route-caret">v</span>
        </button>
        <nav className="view-tabs" aria-label="Views">
          <button className={activeView === 'upload' ? 'active' : ''} type="button" onClick={() => setActiveView('upload')}>
            Upload
          </button>
          <button className={activeView === 'overview' ? 'active' : ''} type="button" onClick={() => setActiveView('overview')}>
            Overview
          </button>
          <button className={activeView === 'runs' ? 'active' : ''} type="button" onClick={() => setActiveView('runs')}>
            Runs
          </button>
        </nav>
      </header>

      {err && <div className="error">{err}</div>}

      {uploadProgress && (
        <div
          className="upload-progress"
          role="progressbar"
          aria-valuemin={0}
          aria-valuemax={100}
          aria-valuenow={uploadProgress.pct}
          aria-valuetext={uploadProgress.step}
          aria-live="polite"
        >
          <div className="upload-progress-head">
            <span className="upload-progress-step">{uploadProgress.step}</span>
            <span className="upload-progress-pct">{uploadProgress.pct}%</span>
          </div>
          <div className="upload-progress-track">
            <div className="upload-progress-fill" style={{ width: `${uploadProgress.pct}%` }} />
          </div>
        </div>
      )}

      {activeView === 'upload' && (
        <UploadWorkspace
          busy={busy}
          trails={trails}
          selectedTrailId={selectedTrailId}
          newTrailName={newTrailName}
          selectedFiles={selectedFiles}
          recentRunRecords={recentRunRecords}
          onSelectedTrailId={setSelectedTrailId}
          onNewTrailName={setNewTrailName}
          onFiles={onFiles}
          onClearFiles={() => setSelectedFiles([])}
          onUpload={uploadSelectedFiles}
          onLoadRunRecord={loadStoredRunRecord}
        />
      )}

      {activeView === 'overview' && runs.length > 0 && (
        <RunDashboard
          key={runs.map((run, index) => `${run.source_name ?? run.label ?? index}:${telemetryLen(run.telemetry)}`).join('|')}
          runs={runs}
          baselineRunIndex={baselineRunIndex}
          onBaselineRunIndex={setBaselineRunIndex}
        />
      )}

      {activeView === 'overview' && runs.length === 0 && (
        <OverviewEmpty
          recentRunRecords={recentRunRecords}
          onUploadView={() => setActiveView('upload')}
          onLoadRunRecord={loadStoredRunRecord}
        />
      )}

      {activeView === 'runs' && (
        <RunsWorkspace
          runs={runs}
          trails={trails}
          selectedTrailId={selectedTrailId}
          selectedTrailRunRecords={selectedTrailRunRecords}
          baselineRunIndex={baselineRunIndex}
          onSelectedTrailId={setSelectedTrailId}
          onLoadRunRecord={loadStoredRunRecord}
          onUploadView={() => setActiveView('upload')}
        />
      )}
    </div>
  )
}
