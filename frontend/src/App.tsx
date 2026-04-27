import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { ChartPercentileControls } from './ChartPercentileControls'
import { VerticalSpeedCompareSummary } from './VerticalSpeedCompareSummary'
import { CanonicalBaselinePanel } from './CanonicalBaselinePanel'
import { GpsTrailPlot } from './GpsTrailPlot'
import { TelemetryCharts } from './TelemetryCharts'
import { CHART_PERCENTILE_DEFAULTS } from './chartScales'
import {
  AIRTIME_TOOLTIP,
  JUMP_DROP_COUNTS_TOOLTIP,
  SIMPLE_AIRTIME_TOOLTIP,
  buildRiderInsight,
  effectiveMaxLandingG,
  FLOW_FACTOR_TOOLTIP,
  flowGrade,
  formatAlignmentDevDetails,
  formatLandingImpactG,
  landingImpactSeverity,
  LANDING_IMPACT_TOOLTIP,
  MAX_LEAN_TOOLTIP,
  syncQualityFromPeak,
} from './riderMetrics'
import { telemetryLen } from './telemetryAccess'
import type {
  CanonicalReference,
  GatePreview,
  SynthesizeBaselineResponse,
  TrailColorMetric,
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
  const [colorMetric, setColorMetric] = useState<TrailColorMetric>('vz')
  const [gatePickMode, setGatePickMode] = useState(false)
  const [gateLat, setGateLat] = useState<number | null>(null)
  const [gateLon, setGateLon] = useState<number | null>(null)
  const [snapPreview, setSnapPreview] = useState<GatePreview | null>(null)
  const [snapPreviewBusy, setSnapPreviewBusy] = useState(false)
  const [snapPreviewErr, setSnapPreviewErr] = useState<string | null>(null)
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

  const runs = data?.runs ?? []

  useEffect(() => {
    if (data?.alignment && !hadAlignmentRef.current) {
      hadAlignmentRef.current = true
      setAlignFlash(true)
      const t = window.setTimeout(() => setAlignFlash(false), 1200)
      return () => window.clearTimeout(t)
    }
    if (!data?.alignment) hadAlignmentRef.current = false
  }, [data?.alignment])

  const trailRunCountPrev = useRef<number>(-1)
  useEffect(() => {
    const n = runs.length
    const prev = trailRunCountPrev.current
    trailRunCountPrev.current = n

    if (n < 2 && (colorMetric === 'vz_lap_compare' || colorMetric === 'delta_t_pace')) {
      setColorMetric('vz')
      return
    }
    if (prev < 2 && n >= 2 && colorMetric === 'vz') {
      setColorMetric(data?.comparison != null ? 'delta_t_pace' : 'vz_lap_compare')
    }
  }, [runs.length, colorMetric, data?.comparison])

  useEffect(() => {
    if (data?.comparison && runs.length >= 2) {
      setColorMetric((m) => (m === 'vz' || m === 'vz_lap_compare' ? 'delta_t_pace' : m))
    }
  }, [data?.comparison, runs.length])

  useEffect(() => {
    if (!data?.comparison && (colorMetric === 'delta_t' || colorMetric === 'delta_t_pace')) {
      setColorMetric('vz')
    }
  }, [data?.comparison, colorMetric])

  useEffect(() => {
    if (gateLat == null || gateLon == null || !rawUpload?.runs || rawUpload.runs.length < 2) {
      setSnapPreview(null)
      setSnapPreviewErr(null)
      setSnapPreviewBusy(false)
      return
    }
    let cancelled = false
    const ac = new AbortController()
    setSnapPreviewBusy(true)
    setSnapPreviewErr(null)
    ;(async () => {
      try {
        const res = await fetch('/preview-gate', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          signal: ac.signal,
          body: JSON.stringify({
            gate_latitude: gateLat,
            gate_longitude: gateLon,
            gate_radius_m: 20,
            gate_half_width_m: 12,
            run_a_telemetry: rawUpload.runs[0].telemetry,
            run_b_telemetry: rawUpload.runs[1].telemetry,
          }),
        })
        if (cancelled) return
        if (!res.ok) {
          const j = (await res.json().catch(() => ({}))) as { detail?: string }
          setSnapPreview(null)
          setSnapPreviewErr(typeof j.detail === 'string' ? j.detail : 'Could not preview gate snap')
          return
        }
        const j = (await res.json()) as GatePreview
        if (!cancelled) {
          setSnapPreview(j)
          setSnapPreviewErr(null)
        }
      } catch (e) {
        if (!cancelled && e instanceof Error && e.name !== 'AbortError') {
          setSnapPreviewErr(e.message)
          setSnapPreview(null)
        }
      } finally {
        if (!cancelled) setSnapPreviewBusy(false)
      }
    })()
    return () => {
      cancelled = true
      ac.abort()
    }
  }, [gateLat, gateLon, rawUpload])

  const applyUpload = useCallback((json: UploadResponse) => {
    setRawUpload(json)
    setData(json)
    setActiveDisplayM(null)
    setGateLat(null)
    setGateLon(null)
    setGatePickMode(false)
    setCanonicalRef(null)
    setBaselineErr(null)
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

  const onSingleLegacy = useCallback(
    (file: File | null) => {
      if (!file) return
      void runUpload(() => {
        const fd = new FormData()
        fd.append('zip_file', file)
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
    } catch (e) {
      setErr(e instanceof Error ? e.message : 'Baro sync failed')
    } finally {
      setBusy(false)
    }
  }, [rawUpload, gateLat, gateLon])

  const synthesizeBaseline = useCallback(async () => {
    const src = data ?? rawUpload
    if (!src?.runs || src.runs.length < 2) return
    setBaselineErr(null)
    setBaselineBusy(true)
    try {
      const res = await fetch('/synthesize-baseline', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          telemetry_runs: src.runs.map((r) => r.telemetry),
          distance_step_m: 1,
        }),
      })
      if (!res.ok) {
        const j = (await res.json().catch(() => ({}))) as { detail?: string }
        throw new Error(typeof j.detail === 'string' ? j.detail : res.statusText)
      }
      const json = (await res.json()) as SynthesizeBaselineResponse
      setCanonicalRef(json.canonical_reference)
    } catch (e) {
      setBaselineErr(e instanceof Error ? e.message : 'Synthesis failed')
    } finally {
      setBaselineBusy(false)
    }
  }, [data, rawUpload])

  const riderInsight = useMemo(() => buildRiderInsight(runs), [runs])

  const syncQuality = useMemo(() => {
    const peak = data?.alignment?.correlation_peak_normalized
    if (peak == null) return null
    return syncQualityFromPeak(peak)
  }, [data?.alignment?.correlation_peak_normalized])

  const primaryTelemetryLen = runs[0] ? telemetryLen(runs[0].telemetry) : 0
  const vzClampHighSuggested = useMemo(() => {
    const spans = runs
      .map((r) => r.viz_hints?.charts?.vz_symmetric_half_span_m_s)
      .filter((x): x is number => typeof x === 'number' && Number.isFinite(x) && x > 0)
    if (spans.length === 0) return undefined
    return Math.max(...spans)
  }, [runs])
  const canBaroSync = rawUpload != null && rawUpload.runs.length >= 2 && gateLat != null && gateLon != null
  const gateSet = gateLat != null && gateLon != null
  const twoLaps = rawUpload != null && rawUpload.runs.length >= 2
  const snapBearingDeg =
    data?.alignment?.trail_bearing_deg_clockwise_from_north_a ?? snapPreview?.trail_bearing_deg_clockwise_from_north_a

  return (
    <div className="app">
      <header className="top">
        <div>
          <h1>BaroSync DH · Telemetry Lab</h1>
          <p className="sub">
            With <strong>two laps</strong>, pick a start on the map, then align barometer traces. Single-lap uploads explore
            the trail only—no gate or sync.
          </p>

          {runs.length > 0 && (
            <div className="rider-dashboard">
              {runs.some((r) => r.smoothness_score != null) && (
                <div className="rider-cards">
                  {runs.map((r, i) => {
                    const sc = r.smoothness_score
                    if (sc == null) return null
                    const fg = flowGrade(sc)
                    return (
                      <div key={i} className="rider-card">
                        <div className="rider-card-head">
                          <span className="rider-metric-label" title={FLOW_FACTOR_TOOLTIP}>
                            Flow Factor
                          </span>
                          <span className="rider-card-run">{r.label ?? `Run ${i + 1}`}</span>
                        </div>
                        <div className="rider-card-value">
                          {sc.toFixed(2)} · <strong>{fg.label}</strong>
                        </div>
                        <p className="rider-card-blurb">{fg.blurb}</p>
                      </div>
                    )
                  })}
                </div>
              )}

              {runs.some((r) => r.mtb_stats) && (
                <div className="rider-mtb-block">
                  <h3 className="rider-section-title">Trail stats</h3>
                  <ul className="rider-mtb-list">
                    {runs.map((r, i) => {
                      const s = r.mtb_stats
                      if (!s) return null
                      const g = effectiveMaxLandingG(s)
                      const sev = landingImpactSeverity(g)
                      return (
                        <li key={i} className="rider-mtb-item">
                          <strong>{r.label ?? `Run ${i + 1}`}</strong>
                          <span className="rider-mtb-sep">·</span>
                          <span className="rider-metric-label" title={MAX_LEAN_TOOLTIP}>
                            Max lean
                          </span>{' '}
                          {s.max_lean_deg.toFixed(0)}°
                          <span className="rider-mtb-sep">·</span>
                          <span className="rider-metric-label" title={AIRTIME_TOOLTIP}>
                            Airtime
                          </span>{' '}
                          {s.total_airtime_s.toFixed(1)} s
                          <span className="rider-mtb-sep">·</span>
                          <span className="rider-metric-label" title={SIMPLE_AIRTIME_TOOLTIP}>
                            Simple low-G
                          </span>{' '}
                          {(s.simple_airtime_s ?? 0).toFixed(1)} s
                          <span className="rider-mtb-sep">·</span>
                          <span className="rider-metric-label" title={JUMP_DROP_COUNTS_TOOLTIP}>
                            Jumps / drops
                          </span>{' '}
                          {s.jump_count ?? 0} / {s.drop_count ?? 0}
                          {(s.drops_baro_witness ?? 0) > 0 ? (
                            <span title={JUMP_DROP_COUNTS_TOOLTIP}>
                              {' '}
                              ({s.drops_baro_witness} baro)
                            </span>
                          ) : null}
                          <span className="rider-mtb-sep">·</span>
                          <span className="rider-metric-label" title={LANDING_IMPACT_TOOLTIP}>
                            Landing G-Force
                          </span>{' '}
                          {formatLandingImpactG(g)}
                          {g >= 1 ? (
                            <span className="rider-impact-tag">
                              {' '}
                              ({sev})
                            </span>
                          ) : null}
                        </li>
                      )
                    })}
                  </ul>
                </div>
              )}

              {runs.some((r) => r.mtb_stats != null && r.mtb_stats.max_lean_deg < 5) && (
                <p className="rider-calibration-note">
                  <strong>Calibration tip:</strong> We didn’t see much lean (&lt; 5°). Mount the phone firmly and do a short
                  stationary zero at the trailhead so gravity calibration can settle—then export with Gravity and/or
                  Orientation if you want corner lean on the map.
                </p>
              )}

              {twoLaps && riderInsight && <p className="rider-insight">{riderInsight}</p>}

              {data?.alignment && syncQuality && (
                <div className="rider-sync-block">
                  <p className="rider-sync-line">
                    <strong>Baro sync:</strong> {syncQuality.label} — {syncQuality.blurb}
                  </p>
                  <details className="dev-details">
                    <summary>Technical details (lag, samples, correlation peak, heading)</summary>
                    <p className="dev-details-body">{formatAlignmentDevDetails(data.alignment)}</p>
                  </details>
                </div>
              )}
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
          <label className="upload-btn" style={{ marginLeft: 8 }}>
            Single (legacy)
            <input
              type="file"
              accept=".zip,application/zip"
              disabled={busy}
              onChange={(e) => onSingleLegacy(e.target.files?.[0] ?? null)}
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
                {gatePickMode ? 'Cancel' : '1 · Choose start on map'}
              </button>
              <button
                type="button"
                className="upload-btn"
                style={{ marginLeft: 8, cursor: 'pointer' }}
                disabled={busy || !canBaroSync}
                title={
                  canBaroSync
                    ? 'Align Run B to Run A using vertical-velocity cross-correlation, then trim to the overlapping section.'
                    : 'Choose a start point on the map first (button 1).'
                }
                onClick={() => void syncBaro()}
              >
                2 · Align laps (barometer)
              </button>
            </>
          )}
          <label style={{ marginLeft: 8 }}>
            Trail color{' '}
            <select value={colorMetric} onChange={(e) => setColorMetric(e.target.value as TrailColorMetric)}>
              <option value="vz">Vertical velocity (each lap by its own Vz)</option>
              <option value="vz_lap_compare" disabled={runs.length < 2}>
                Lap compare — run 1 solid line, run 2 heat vs baseline
              </option>
              <option value="delta_t" disabled={!data?.comparison}>
                Time delta (B−A)
              </option>
              <option value="delta_t_pace" disabled={!data?.comparison || runs.length < 2}>
                d(Δt)/ds on map (after baro — gain/lose heat)
              </option>
            </select>
          </label>
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

      {twoLaps && (
        <section className="workflow-callout" aria-label="Two-lap comparison steps">
          <h2 className="workflow-title">Compare two laps — what to do</h2>
          <ol className="workflow-steps">
            <li>
              <strong>Step 1 — Spatial anchor (GPS, ~10–20 m).</strong> Press <em>1 · Choose start on map</em> and click a
              place both laps passed. The orange cross is your click; <strong>diamond / square</strong> markers show the
              actual GPS snap on each lap; the <strong>green line</strong> is perpendicular to trail <em>heading</em>{' '}
              (clockwise from north: if you ride north, the gate runs east-west). Check that snap before step 2—if it jumped
              to the wrong switchback, click again.
            </li>
            <li>
              <strong>Step 2 — Baro fingerprint (25 Hz).</strong> Press <em>2 · Align laps (barometer)</em>. The server
              crops both laps to the same length, FFT cross-correlates <strong>Vz</strong> on the first ~100 m after the gate
              to find the best sample offset for Run B, applies that lag to all of Run B’s times, then trims overlap. That’s
              the fine alignment GPS can’t do.{' '}
              <strong>Δt</strong> is then time lost/gained at each meter (Run 2 − Run 1). Flow Factor uses only this gated
              segment.
            </li>
          </ol>
          <p className="workflow-status">
            {gatePickMode && <span className="workflow-status-live">Map is listening — click the trail.</span>}
            {!gatePickMode && !gateSet && <span>Start point: not set yet (use step 1).</span>}
            {!gatePickMode && gateSet && (
              <>
                Map click: ({gateLat!.toFixed(5)}°, {gateLon!.toFixed(5)}°).{' '}
                <button
                  type="button"
                  className="link-button"
                  onClick={() => {
                    setGateLat(null)
                    setGateLon(null)
                    setSnapPreview(null)
                    setSnapPreviewErr(null)
                  }}
                >
                  Clear
                </button>
              </>
            )}
            {gateSet && snapPreviewBusy && (
              <span className="workflow-hint"> Resolving snapped GPS points and gate line…</span>
            )}
            {gateSet && !snapPreviewBusy && snapPreviewErr && (
              <span className="workflow-preview-err"> {snapPreviewErr}</span>
            )}
            {gateSet && !snapPreviewBusy && snapPreview && !gatePickMode && (
              <span className="workflow-snap-ok">
                {' '}
                Snapped: Run A index {snapPreview.gate_index_a}, Run B index {snapPreview.gate_index_b}.
                {snapBearingDeg != null && (
                  <> Trail heading on Run A ≈ {snapBearingDeg.toFixed(0)}° clockwise from north.</>
                )}
              </span>
            )}
            {!gateSet && !gatePickMode && (
              <span className="workflow-hint"> Step 2 stays disabled until a start point is set.</span>
            )}
          </p>
        </section>
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
              colorMetric={colorMetric}
              comparison={data?.comparison ?? null}
              alignment={data?.alignment}
              gatePreview={snapPreview}
              gatePickMode={gatePickMode}
              gateLatitude={gateLat}
              gateLongitude={gateLon}
              onGateLocation={(lat, lon) => {
                setGateLat(lat)
                setGateLon(lon)
                setGatePickMode(false)
              }}
            />
          </div>
          <div className="chart-panel">
            <ChartPercentileControls
              low={chartYPercentiles.low}
              high={chartYPercentiles.high}
              onChange={setChartYPercentiles}
            />
            <VerticalSpeedCompareSummary runs={runs} />
            <TelemetryCharts
              runs={runs}
              activeDisplayM={activeDisplayM}
              onActiveDisplayM={setActiveDisplayM}
              comparison={data?.comparison ?? null}
              normalizeElevation={normalizeElevation}
              yPercentileLow={chartYPercentiles.low}
              yPercentileHigh={chartYPercentiles.high}
              vzClampHighSuggested={vzClampHighSuggested}
            />
          </div>
        </div>
      )}

      {runs.length >= 2 && primaryTelemetryLen > 0 && (
        <section className="canonical-baseline-section" aria-label="Canonical reference trail">
          <div className="canonical-baseline-toolbar">
            <h2 className="canonical-baseline-heading">N-run canonical trail</h2>
            <button
              type="button"
              className="upload-btn"
              disabled={busy || baselineBusy}
              title="Fuses all uploaded runs: baro + IMU, DTW, SRVF mean, GPR (needs backend: fastdtw, scikit-learn)"
              onClick={() => void synthesizeBaseline()}
            >
              {baselineBusy ? 'Synthesizing…' : 'Synthesize canonical reference'}
            </button>
          </div>
          {baselineErr && <div className="error canonical-baseline-error">{baselineErr}</div>}
          <CanonicalBaselinePanel reference={canonicalRef} />
        </section>
      )}

      {!data && !busy && (
        <p className="hint">
          Start the API: <code>cd backend && .venv/bin/uvicorn app.main:app --reload</code> · then{' '}
          <code>cd frontend && npm run dev</code>
        </p>
      )}
    </div>
  )
}
