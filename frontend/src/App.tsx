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
  CanonicalReference,
  ComparisonPayload,
  SynthesizeBaselineResponse,
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
  const [canonicalRef, setCanonicalRef] = useState<CanonicalReference | null>(null)
  const [baselineBusy, setBaselineBusy] = useState(false)
  const [baselineErr, setBaselineErr] = useState<string | null>(null)
  const [paceComparison, setPaceComparison] = useState<ComparisonPayload | null>(null)
  const [paceErr, setPaceErr] = useState<string | null>(null)
  const [paceBusy, setPaceBusy] = useState(false)
  const [baselineRunIndex, setBaselineRunIndex] = useState<number | null>(null) // null = Master Trail Signature
  const [heatmapMetric, setHeatmapMetric] = useState<'delta_t' | 'delta_vz'>('delta_t')
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
    () => paceComparison ?? data?.comparison ?? null,
    [paceComparison, data?.comparison],
  )

  const synthesisKey = useMemo(() => {
    const src = data ?? rawUpload
    if (!src?.runs || src.runs.length < 2) return null
    return src.runs
      .map((r, i) => `${i}:${telemetryLen(r.telemetry)}:${r.label ?? ''}:${r.source_name ?? ''}`)
      .join('|')
  }, [data, rawUpload])

  useEffect(() => {
    if (!synthesisKey) return
    const src = data ?? rawUpload
    if (!src?.runs || src.runs.length < 2) return
    const ac = new AbortController()
    setBaselineErr(null)
    setCanonicalRef(null)
    setBaselineBusy(true)
    void (async () => {
      try {
        const res = await fetch('/synthesize-baseline', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          signal: ac.signal,
          body: JSON.stringify({
            telemetry_runs: src.runs.map((r) => r.telemetry),
            distance_step_m: 1,
          }),
        })
        if (ac.signal.aborted) return
        if (!res.ok) {
          const j = (await res.json().catch(() => ({}))) as { detail?: string }
          throw new Error(typeof j.detail === 'string' ? j.detail : res.statusText)
        }
        const json = (await res.json()) as SynthesizeBaselineResponse
        if (ac.signal.aborted) return
        setCanonicalRef(json.canonical_reference)
      } catch (e) {
        if (ac.signal.aborted) return
        if (e instanceof Error && e.name === 'AbortError') return
        setCanonicalRef(null)
        setBaselineErr(e instanceof Error ? e.message : 'Synthesis failed')
      } finally {
        if (!ac.signal.aborted) setBaselineBusy(false)
      }
    })()
    return () => {
      ac.abort()
      setBaselineBusy(false)
    }
  }, [synthesisKey])

  const paceFetchKey = useMemo(() => {
    if (!data?.alignment || data.runs.length === 0) return null
    if (baselineRunIndex === null) {
      if (!canonicalRef?.t_reference_s?.length) return null
      const c = compactCanonicalForPace(canonicalRef)
      if (!c) return null
      return `ref-${c.distance_m.length}-${data.runs.length}-${data.alignment.lag_applied_to_run_b_s ?? 0}`
    } else {
      const run = data.runs[baselineRunIndex]
      if (!run) return null
      return `run-${baselineRunIndex}-${data.runs.length}-${telemetryLen(run.telemetry)}`
    }
  }, [data?.alignment, data?.runs, canonicalRef, baselineRunIndex])

  useEffect(() => {
    if (!paceFetchKey || data?.runs.length === 0) {
      setPaceComparison(null)
      return
    }

    let dist: number[] = []
    let t_ref: number[] = []
    let ref_ele: number[] = []
    let t_sig: number[] | undefined = undefined

    if (baselineRunIndex === null) {
      const c = compactCanonicalForPace(canonicalRef)
      if (!c) {
        setPaceComparison(null)
        return
      }
      dist = c.distance_m
      t_ref = c.t_reference_s
      ref_ele = c.ref_elevation_m
      t_sig = c.t_reference_sigma_s ?? undefined
    } else {
      const run = data!.runs[baselineRunIndex]!
      const tel = run.telemetry
      const len = telemetryLen(tel)
      dist = distanceSeries(tel)
      const ns = isTelemetryRecords(tel) ? tel.map(t => t.unix_ns) : tel.unix_ns
      const t0 = (ns[0] ?? 0) * 1e-9
      t_ref = new Array(len)
      for (let i=0; i<len; i++) {
        const time_s = isTelemetryRecords(tel) ? tel[i].time_s : tel.time_s?.[i]
        if (typeof time_s === 'number') {
           t_ref[i] = time_s
        } else {
           t_ref[i] = (ns[i] ?? 0) * 1e-9 - t0
        }
      }
      ref_ele = isTelemetryRecords(tel) ? tel.map(t => t.altitude_smooth_m ?? t.altitude_m ?? 0) : ((tel.altitude_smooth_m ?? tel.altitude_m) as number[]) ?? new Array(len).fill(0)
    }

    const ac = new AbortController()
    setPaceErr(null)
    setPaceBusy(true)
    void (async () => {
      try {
        const res = await fetch('/pace-vs-reference', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          signal: ac.signal,
          body: JSON.stringify({
            runs_telemetry: data!.runs.map((r) => r.telemetry),
            distance_m: dist,
            t_reference_s: t_ref,
            t_reference_sigma_s: t_sig,
            ref_elevation_m: ref_ele,
          }),
        })
        if (ac.signal.aborted) return
        if (!res.ok) {
          const j = (await res.json().catch(() => ({}))) as { detail?: string }
          throw new Error(typeof j.detail === 'string' ? j.detail : res.statusText)
        }
        const j = (await res.json()) as ComparisonPayload
        if (ac.signal.aborted) return
        setPaceComparison(j)
        setPaceErr(null)
      } catch (e) {
        if (ac.signal.aborted) return
        if (e instanceof Error && e.name === 'AbortError') return
        setPaceComparison(null)
        setPaceErr(e instanceof Error ? e.message : 'Pace analysis failed')
      } finally {
        if (!ac.signal.aborted) setPaceBusy(false)
      }
    })()
    return () => {
      ac.abort()
      setPaceBusy(false)
    }
  }, [paceFetchKey, data?.runs, canonicalRef, baselineRunIndex])

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
    setGatePickMode(false)
    setCanonicalRef(null)
    setBaselineErr(null)
    setPaceComparison(null)
    setPaceErr(null)
    setDistanceFocusRange(null)
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
      setCanonicalRef(null)
      setBaselineErr(null)
      setPaceComparison(null)
      setPaceErr(null)
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
            Section Pace Analyzer: compare your lap to the N-run reference trail (after align + synthesis).
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
          <div style={{ marginLeft: 8, display: 'inline-flex', alignItems: 'center', gap: 6, fontSize: 13 }}>
            Map heat:
            <select
              value={heatmapMetric}
              onChange={(e) => setHeatmapMetric(e.target.value as 'delta_t' | 'delta_vz')}
              className="chart-percentile-input"
            >
              <option value="delta_t">Outcome: Δt vs ref</option>
              <option value="delta_vz">Action: ΔVz vs ref</option>
            </select>
          </div>
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
              canonicalRef={canonicalRef}
              paceRunIndex={Math.max(1, baselineRunIndex === null ? 0 : baselineRunIndex)}
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
              <div className="baseline-selector" style={{ marginBottom: '8px', padding: '8px', background: '#f8fafc', border: '1px solid #e2e8f0', borderRadius: '4px', display: 'flex', alignItems: 'center', gap: '8px' }}>
                <strong style={{ fontSize: '13px', color: '#334155' }}>Comparison Baseline:</strong>
                <select 
                  style={{ padding: '4px 8px', fontSize: '13px', borderRadius: '4px', border: '1px solid #cbd5e1' }}
                  value={baselineRunIndex === null ? 'ref' : baselineRunIndex}
                  onChange={(e) => setBaselineRunIndex(e.target.value === 'ref' ? null : parseInt(e.target.value, 10))}
                >
                  <option value="ref">Master Trail Signature</option>
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
              canonicalRef={canonicalRef}
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

      {runs.length >= 2 && primaryTelemetryLen > 0 && displayComparison && data?.alignment && (
        <section className="section-pace-table-wrap" aria-label="Section pace summary">
          <h2 className="section-pace-table-title">Section deep-dive</h2>
          <SectionPaceTable
            comparison={displayComparison}
            runForSectors={data.runs[0]!}
            runLabelB={data?.runs[1]?.label}
          />
        </section>
      )}

      {runs.length >= 2 && primaryTelemetryLen > 0 && (
        <section className="canonical-baseline-section" aria-label="Canonical reference trail">
          <div className="canonical-baseline-toolbar">
            <h2 className="canonical-baseline-heading">N-run canonical trail (reference surface)</h2>
            {baselineBusy && (
              <p className="canonical-baseline-status" role="status" aria-live="polite">
                Synthesizing…
              </p>
            )}
            {paceBusy && (
              <p className="canonical-baseline-status" role="status" aria-live="polite">
                Building pace vs reference…
              </p>
            )}
          </div>
          {paceErr && <div className="error canonical-baseline-error">{paceErr}</div>}
          {baselineErr && <div className="error canonical-baseline-error">{baselineErr}</div>}
          <CanonicalBaselinePanel reference={canonicalRef} />
        </section>
      )}

    </div>
  )
}
