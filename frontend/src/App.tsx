import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { ChartPercentileControls } from './ChartPercentileControls'
import { CanonicalBaselinePanel } from './CanonicalBaselinePanel'
import { GpsTrailPlot } from './GpsTrailPlot'
import { TelemetryCharts } from './TelemetryCharts'
import { CHART_PERCENTILE_DEFAULTS } from './chartScales'
import { formatAlignmentDevDetails, syncQualityFromPeak } from './riderMetrics'
import { distanceSeries } from './distanceUtils'
import { compactCanonicalForPace } from './paceReference'
import { SectionPaceTable } from './SectionPaceTable'
import { telemetryLen } from './telemetryAccess'
import type {
  UploadJobStart,
  UploadJobStatus,
  UploadResponse,
} from './types'
import './App.css'

const UPLOAD_POLL_MS = 200
const UPLOAD_MAX_WAIT_MS = 15 * 60 * 1000

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

export default function App() {
  const [rawUpload, setRawUpload] = useState<UploadResponse | null>(null)
  const [data, setData] = useState<UploadResponse | null>(null)
  const [activeDisplayM, setActiveDisplayM] = useState<number | null>(null)
  const [busy, setBusy] = useState(false)
  const [uploadProgress, setUploadProgress] = useState<{ step: string; pct: number } | null>(null)
  const [err, setErr] = useState<string | null>(null)
  const [gatePickMode, setGatePickMode] = useState(false)
  const [gateLat, setGateLat] = useState<number | null>(null)
  const [gateLon, setGateLon] = useState<number | null>(null)
  const [normalizeElevation, setNormalizeElevation] = useState(false)
  const [chartYPercentiles, setChartYPercentiles] = useState<{ low: number; high: number }>({
    low: CHART_PERCENTILE_DEFAULTS.low,
    high: CHART_PERCENTILE_DEFAULTS.high,
  })
  const [alignFlash, setAlignFlash] = useState(false)
  const hadAlignmentRef = useRef(false)
  const [baselineRunIndex, setBaselineRunIndex] = useState<number>(0)
  const heatmapMetric = 'delta_vz'
  /** When set, distance charts x-axis = ~10m window (from map “pace loss” pin). */
  const [distanceFocusRange, setDistanceFocusRange] = useState<[number, number] | null>(null)

  const clearDistanceFocus = useCallback(() => setDistanceFocusRange(null), [])

  const runs = data?.runs ?? []

  const maxTrailDistM = useMemo(() => {
    let m = 0
    for (const r of runs) {
      const d = distanceSeries(r.telemetry)
      if (d.length) m = Math.max(m, d[d.length - 1] ?? 0)
    }
    return m
  }, [runs])

  const onPaceLossPin = useCallback(
    (dm: number) => {
      if (!Number.isFinite(dm) || maxTrailDistM <= 0) return
      const half = 5
      const lo = Math.max(0, dm - half)
      const hi = Math.min(maxTrailDistM, dm + half)
      setDistanceFocusRange([lo, Math.max(lo + 0.1, hi)])
      setActiveDisplayM(dm)
    },
    [maxTrailDistM],
  )

  const displayComparison = useMemo(
    () => data?.comparison ?? null,
    [data?.comparison],
  )



  useEffect(() => {
    if (data?.alignment && !hadAlignmentRef.current) {
      hadAlignmentRef.current = true
      setAlignFlash(true)
      const t = window.setTimeout(() => setAlignFlash(false), 1200)
      return () => window.clearTimeout(t)
    }
    if (!data?.alignment) hadAlignmentRef.current = false
  }, [data?.alignment])

  const applyUpload = useCallback((json: UploadResponse) => {
    setRawUpload(json)
    setData(json)
    setActiveDisplayM(null)
    setGateLat(null)
    setGateLon(null)
    setDistanceFocusRange(null)
    if (json?.runs?.length) {
      let maxLen = 0
      let slowest = 0
      json.runs.forEach((r, i) => {
        const t = r.telemetry;
        let diff = 0;
        if ('time_s' in t && Array.isArray(t.time_s)) diff = t.time_s[t.time_s.length - 1] - t.time_s[0];
        else if (Array.isArray(t)) diff = t[t.length - 1].time_s - t[0].time_s;
        if (diff > maxLen) { maxLen = diff; slowest = i; }
      });
      setBaselineRunIndex(slowest)
    }
  }, [])

  const runUpload = useCallback(
    async (buildFormData: () => FormData) => {
      setErr(null)
      setBusy(true)
      setUploadProgress({ step: 'Sending files…', pct: 0 })
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
      } catch (e) {
        setErr(e instanceof Error ? e.message : 'Upload failed')
      } finally {
        setBusy(false)
        setUploadProgress(null)
      }
    },
    [applyUpload],
  )

  const onFiles = useCallback(
    (fileList: FileList | null) => {
      if (!fileList?.length) return
      const zips = Array.from(fileList).filter((f) => f.name.toLowerCase().endsWith('.zip'))
      if (!zips.length) return
      void runUpload(() => {
        const fd = new FormData()
        for (const f of zips) {
          fd.append('files', f)
        }
        return fd
      })
    },
    [runUpload],
  )

  const syncBaro = useCallback(async () => {
    if (!rawUpload?.runs || rawUpload.runs.length < 2 || gateLat == null || gateLon == null) return
    setErr(null)
    setBusy(true)
    try {
      const a = rawUpload.runs[0].telemetry
      const b = rawUpload.runs[1].telemetry
      const res = await fetch('/align-baro', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          gate_latitude: gateLat,
          gate_longitude: gateLon,
          gate_radius_m: 20,
          vz_edge_eps: 0.03,
          correlation_max_distance_m: 100,
          run_a_label: rawUpload.runs[0]?.label,
          run_b_label: rawUpload.runs[1]?.label,
          run_a_source_name: rawUpload.runs[0]?.source_name,
          run_b_source_name: rawUpload.runs[1]?.source_name,
          run_a_telemetry: a,
          run_b_telemetry: b,
        }),
      })
      if (!res.ok) {
        const j = (await res.json().catch(() => ({}))) as { detail?: string }
        throw new Error(typeof j.detail === 'string' ? j.detail : res.statusText)
      }
      const json = (await res.json()) as UploadResponse
      setData(json)
      setActiveDisplayM(null)
      setGatePickMode(false)
      setDistanceFocusRange(null)
    } catch (e) {
      setErr(e instanceof Error ? e.message : 'Baro sync failed')
    } finally {
      setBusy(false)
    }
  }, [rawUpload, gateLat, gateLon])

  const syncQuality = useMemo(() => {
    const peak = data?.alignment?.correlation_peak_normalized
    if (peak == null) return null
    return syncQualityFromPeak(peak)
  }, [data?.alignment?.correlation_peak_normalized])

  const primaryTelemetryLen = runs[0] ? telemetryLen(runs[0].telemetry) : 0
  const canBaroSync = rawUpload != null && rawUpload.runs.length >= 2 && gateLat != null && gateLon != null
  const gateSet = gateLat != null && gateLon != null
  const twoLaps = rawUpload != null && rawUpload.runs.length >= 2

  return (
    <div className="app">
      <header className="top">
        <div>
          <h1>BaroSync DH</h1>
          <p className="sub">
            Compare Topography and Vertical Speed. The slowest run is selected as the baseline by default.
          </p>

          {runs.length > 0 && data?.alignment && syncQuality && (
            <div className="rider-dashboard">
              <div className="rider-sync-block">
                <p className="rider-sync-line">
                  <strong>Baro sync:</strong> {syncQuality.label} — {syncQuality.blurb}
                </p>
                <details className="dev-details">
                  <summary>Technical details (lag, samples, correlation peak, heading)</summary>
                  <p className="dev-details-body">{formatAlignmentDevDetails(data.alignment)}</p>
                </details>
              </div>
            </div>
          )}
        </div>
        <div className="toolbar">
          <label className="upload-btn">
            {busy ? 'Processing…' : 'Upload ZIP(s)'}
            <input
              type="file"
              accept=".zip,application/zip"
              multiple
              disabled={busy}
              onChange={(e) => onFiles(e.target.files)}
            />
          </label>
          {twoLaps && (
            <>
              <button
                type="button"
                className={gatePickMode ? 'upload-btn active-gate' : 'upload-btn'}
                style={{ marginLeft: 8, cursor: 'pointer' }}
                disabled={busy}
                title="Turns on map clicks. Click a point on the trail where both laps should start counting distance and time."
                onClick={() => setGatePickMode((v) => !v)}
              >
                {gatePickMode ? 'Cancel' : 'Set start on map'}
              </button>
              {gateSet && (
                <button
                  type="button"
                  className="upload-btn"
                  style={{ marginLeft: 8, cursor: 'pointer' }}
                  disabled={busy}
                  onClick={() => {
                    setGateLat(null)
                    setGateLon(null)
                  }}
                >
                  Clear start
                </button>
              )}
              <button
                type="button"
                className="upload-btn"
                style={{ marginLeft: 8, cursor: 'pointer' }}
                disabled={busy || !canBaroSync}
                title={
                  canBaroSync
                    ? 'Time-align the second lap to the first using Vz, then compare.'
                    : 'Set a start point on the map first.'
                }
                onClick={() => void syncBaro()}
              >
                Align (baro)
              </button>
            </>
          )}

          <label style={{ marginLeft: 12, display: 'inline-flex', alignItems: 'center', gap: 6, cursor: 'pointer' }}>
            <input
              type="checkbox"
              checked={normalizeElevation}
              onChange={(e) => setNormalizeElevation(e.target.checked)}
            />
            Normalize elevation
          </label>
        </div>
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

      {runs.length > 0 && primaryTelemetryLen > 0 && (
        <div
          className={alignFlash ? 'main-grid main-grid--align-snap' : 'main-grid'}
        >
          <div
            className={
              runs.length >= 2 && !data?.alignment
                ? 'trail-panel trail-panel--pre-align'
                : 'trail-panel'
            }
          >
            <GpsTrailPlot
              runs={runs}
              activeDisplayM={activeDisplayM}
              onActiveDisplayM={setActiveDisplayM}
              comparison={displayComparison}
              heatmapMetric={heatmapMetric}
              canonicalRef={null}
              paceRunIndex={Math.max(1, baselineRunIndex)}
              alignment={data?.alignment}
              gatePreview={data?.runs[0]?.gate_preview}
              gatePickMode={gatePickMode}
              gateLatitude={gateLat}
              gateLongitude={gateLon}
              onGateLocation={(lat, lon) => {
                setGateLat(lat)
                setGateLon(lon)
                setGatePickMode(false)
              }}
              onPaceLossPinClick={onPaceLossPin}
            />
          </div>
            <div className="chart-panel">
              <div className="baseline-selector" style={{ marginBottom: '8px', padding: '8px', background: '#f8fafc', border: '1px solid #e2e8f0', borderRadius: '4px', display: 'flex', alignItems: 'center', flexWrap: 'wrap', gap: '8px' }}>
                <strong style={{ fontSize: '13px', color: '#334155' }}>Comparison Baseline:</strong>
                <select 
                  style={{ padding: '4px 8px', fontSize: '13px', borderRadius: '4px', border: '1px solid #cbd5e1' }}
                  value={baselineRunIndex}
                  onChange={(e) => setBaselineRunIndex(parseInt(e.target.value, 10))}
                >
                  {runs.map((r, i) => (
                    <option key={i} value={i}>{r.label ?? `Run ${i + 1}`}</option>
                  ))}
                </select>
              </div>
            <ChartPercentileControls
              low={chartYPercentiles.low}
              high={chartYPercentiles.high}
              onChange={setChartYPercentiles}
            />
          <TelemetryCharts
              runs={runs}
              activeDisplayM={activeDisplayM}
              onActiveDisplayM={setActiveDisplayM}
              comparison={displayComparison}
              runLabelB={data?.runs[1]?.label}
              canonicalRef={null}
              paceRunIndex={1}
              distanceFocusRange={distanceFocusRange}
              onClearDistanceFocus={clearDistanceFocus}
              normalizeElevation={normalizeElevation}
              yPercentileLow={chartYPercentiles.low}
              yPercentileHigh={chartYPercentiles.high}
            />
          </div>
        </div>
      )}





    </div>
  )
}
