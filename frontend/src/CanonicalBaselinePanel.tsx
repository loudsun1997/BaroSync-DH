import { useMemo } from 'react'
import { plotlyDistanceExplorerConfig } from './plotlyConfig'
import { Plot } from './plotlyFactory'
import type { CanonicalReference } from './types'

const PLOT_PAPER = '#fafbfc'
const PLOT_BG = '#ffffff'
const PLOT_TEXT = '#1c2333'
const PLOT_GRID = '#e2e8f0'

/** Drop points where any series is null/non-finite so Plotly traces stay aligned. */
function alignByDistance(
  distance_m: (number | null)[],
  ...series: (number | null)[][]
): { x: number[]; ys: number[][] } {
  const x: number[] = []
  const ys: number[][] = series.map(() => [])
  const n = distance_m.length
  for (let i = 0; i < n; i++) {
    const d = distance_m[i]
    if (d == null || !Number.isFinite(d)) continue
    const row = series.map((s) => s[i])
    if (row.some((v) => v == null || !Number.isFinite(v as number))) continue
    x.push(d)
    row.forEach((v, j) => ys[j]!.push(v as number))
  }
  return { x, ys }
}

type Props = {
  reference: CanonicalReference | null
}

export function CanonicalBaselinePanel({ reference }: Props) {
  const elevBundle = useMemo(() => {
    if (!reference) return null
    return alignByDistance(
      reference.distance_m,
      reference.confidence_band_m.upper_m,
      reference.confidence_band_m.lower_m,
      reference.elevation_m,
    )
  }, [reference])

  const motionBundle = useMemo(() => {
    if (!reference) return null
    return alignByDistance(reference.distance_m, reference.vz_m_s, reference.grade_m_per_m)
  }, [reference])

  const relBundle = useMemo(() => {
    if (!reference) return null
    return alignByDistance(reference.distance_m, reference.reliability_score)
  }, [reference])

  if (!reference) {
    return (
      <div className="canonical-baseline-panel">
        <p className="canonical-baseline-placeholder">
          Build a <strong>canonical reference trail</strong> to see N-run fused elevation, Vz, grade, and a confidence band
          indexed by distance — use the button above after upload.
        </p>
      </div>
    )
  }

  const meta = reference.meta
  const elevTraces =
    elevBundle && elevBundle.x.length > 0
      ? [
          {
            x: elevBundle.x,
            y: elevBundle.ys[0],
            type: 'scatter' as const,
            mode: 'lines' as const,
            line: { width: 0 },
            showlegend: false,
            hoverinfo: 'skip' as const,
          },
          {
            x: elevBundle.x,
            y: elevBundle.ys[1],
            type: 'scatter' as const,
            mode: 'lines' as const,
            fill: 'tonexty' as const,
            fillcolor: 'rgba(99, 102, 241, 0.22)',
            line: { width: 0 },
            name: '~95% band',
            hovertemplate: 'dist %{x:.1f} m<br>lower..upper<extra></extra>',
          },
          {
            x: elevBundle.x,
            y: elevBundle.ys[2],
            type: 'scatter' as const,
            mode: 'lines' as const,
            name: 'Canonical elevation',
            line: { color: '#0f172a', width: 2 },
            hovertemplate: 'dist %{x:.1f} m<br>elev %{y:.2f} m<extra></extra>',
          },
        ]
      : []

  const motionTraces =
    motionBundle && motionBundle.x.length > 0
      ? [
          {
            x: motionBundle.x,
            y: motionBundle.ys[0],
            type: 'scatter' as const,
            mode: 'lines' as const,
            name: 'Vz (m/s)',
            line: { color: '#2563eb', width: 2 },
            yaxis: 'y' as const,
            hovertemplate: 'dist %{x:.1f} m<br>Vz %{y:.3f} m/s<extra></extra>',
          },
          {
            x: motionBundle.x,
            y: motionBundle.ys[1],
            type: 'scatter' as const,
            mode: 'lines' as const,
            name: 'Grade (m/m)',
            line: { color: '#c2410c', width: 2, dash: 'dot' as const },
            yaxis: 'y2' as const,
            hovertemplate: 'dist %{x:.1f} m<br>grade %{y:.4f}<extra></extra>',
          },
        ]
      : []

  const relTraces =
    relBundle && relBundle.x.length > 0
      ? [
          {
            x: relBundle.x,
            y: relBundle.ys[0],
            type: 'scatter' as const,
            mode: 'lines' as const,
            name: 'Reliability',
            line: { color: '#0d7a4f', width: 2 },
            fill: 'tozeroy' as const,
            fillcolor: 'rgba(13, 122, 79, 0.12)',
            hovertemplate: 'dist %{x:.1f} m<br>reliability %{y:.3f}<extra></extra>',
          },
        ]
      : []

  const baseLayout = {
    paper_bgcolor: PLOT_PAPER,
    plot_bgcolor: PLOT_BG,
    font: { color: PLOT_TEXT },
    xaxis: {
      title: { text: 'Distance (m)' },
      gridcolor: PLOT_GRID,
      zerolinecolor: PLOT_GRID,
    },
  }

  return (
    <div className="canonical-baseline-panel">
      <div className="canonical-baseline-meta">
        <h3 className="canonical-baseline-title">Canonical reference trail</h3>
        <dl className="canonical-baseline-dl">
          <div>
            <dt>Runs fused</dt>
            <dd>{meta.run_count}</dd>
          </div>
          <div>
            <dt>Grid step</dt>
            <dd>{meta.distance_step_m} m · {meta.distance_count} points</dd>
          </div>
          <div>
            <dt>Alignment</dt>
            <dd>{meta.alignment}</dd>
          </div>
          <div>
            <dt>Mean shape</dt>
            <dd>{meta.mean_shape}</dd>
          </div>
          <div>
            <dt>Finalizer</dt>
            <dd>
              {meta.finalizer}
              {meta.gpr_kernel ? (
                <span className="canonical-baseline-kernel" title="GPR kernel (when scikit-learn is available)">
                  {' '}
                  · <code>{meta.gpr_kernel}</code>
                </span>
              ) : null}
            </dd>
          </div>
        </dl>
        <p className="canonical-baseline-note">
          Same <code>distance_m</code> abscissa as per-run charts — suitable for <code>interpAlongDistance</code> on Δt
          grids. Band uses σ from GPR / residual spread; higher reliability ⇒ lower expected baseline uncertainty.
        </p>
      </div>

      {elevTraces.length > 0 && (
        <Plot
          data={elevTraces}
          layout={{
            ...baseLayout,
            title: { text: 'Elevation + confidence (±1.96 σ band)', font: { size: 14 } },
            margin: { t: 48, r: 24, b: 48, l: 56 },
            yaxis: { title: { text: 'Elevation (m)' }, gridcolor: PLOT_GRID, zerolinecolor: PLOT_GRID },
            hovermode: 'x unified' as const,
            showlegend: true,
            legend: { orientation: 'h' as const, y: -0.22 },
            height: 300,
          }}
          config={plotlyDistanceExplorerConfig}
          style={{ width: '100%', height: 300 }}
        />
      )}

      {motionTraces.length > 0 && (
        <Plot
          data={motionTraces}
          layout={{
            ...baseLayout,
            title: { text: 'Canonical Vz and terrain grade', font: { size: 14 } },
            margin: { t: 48, r: 68, b: 48, l: 56 },
            yaxis: { title: { text: 'Vz (m/s)' }, gridcolor: PLOT_GRID, zerolinecolor: PLOT_GRID },
            yaxis2: {
              title: { text: 'Grade (m/m)' },
              overlaying: 'y' as const,
              side: 'right' as const,
              showgrid: false,
            },
            hovermode: 'x unified' as const,
            showlegend: true,
            legend: { orientation: 'h' as const, y: -0.22 },
            height: 280,
          }}
          config={plotlyDistanceExplorerConfig}
          style={{ width: '100%', height: 280 }}
        />
      )}

      {relTraces.length > 0 && (
        <Plot
          data={relTraces}
          layout={{
            ...baseLayout,
            title: { text: 'Reliability score (1 / (1 + σ))', font: { size: 14 } },
            margin: { t: 48, r: 24, b: 48, l: 56 },
            yaxis: { title: { text: 'Reliability' }, range: [0, 1.05], gridcolor: PLOT_GRID, zerolinecolor: PLOT_GRID },
            hovermode: 'x unified' as const,
            showlegend: false,
            height: 220,
          }}
          config={plotlyDistanceExplorerConfig}
          style={{ width: '100%', height: 220 }}
        />
      )}
    </div>
  )
}
