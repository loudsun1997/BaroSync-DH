import { useMemo } from 'react'
import { computeTrailSectorsSimple } from './trailSectors'
import type { ComparisonPayload, RunResult } from './types'

type Props = {
  comparison: ComparisonPayload
  runForSectors: RunResult
  runLabelB?: string
}

function tAt(
  d: number,
  dist: number[],
  t: number[],
): number {
  if (dist.length === 0) return 0
  let j = 0
  for (let i = 0; i < dist.length; i++) {
    if (dist[i]! <= d) j = i
  }
  return t[j] ?? 0
}

type Row = {
  sector: string
  tRef: string
  delta: string
  verdict: string
}

export function SectionPaceTable({ comparison, runForSectors, runLabelB }: Props) {
  const runName = runLabelB?.trim() || 'Run B'
  const refLabel = 'Reference'

  const rows = useMemo((): Row[] => {
    const d = comparison.delta_t.distance_m
    const tr = comparison.delta_t.t_a_s
    const tb = comparison.delta_t.t_b_s
    if (d.length < 2) return []
    const sectors = computeTrailSectorsSimple(runForSectors, 6)
    const out: Row[] = []
    for (const s of sectors) {
      const t0a = tAt(s.d0, d, tr)
      const t1a = tAt(s.d1, d, tr)
      const t0b = tAt(s.d0, d, tb)
      const t1b = tAt(s.d1, d, tb)
      const secRef = t1a - t0a
      const secB = t1b - t0b
      const dSec = secB - secRef
      let verdict: string
      if (dSec < -0.15) verdict = 'Faster (more pace here)'
      else if (dSec > 0.15) verdict = 'Slower (time lost)'
      else verdict = 'Consistent with reference'
      out.push({
        sector: s.label,
        tRef: `${secRef.toFixed(1)}s`,
        delta: dSec >= 0 ? `+${dSec.toFixed(1)}s` : `${dSec.toFixed(1)}s`,
        verdict,
      })
    }
    return out
  }, [comparison.delta_t, runForSectors])

  if (rows.length === 0) {
    return <p className="section-pace-table-empty">Not enough data for sector breakdown.</p>
  }

  return (
    <div className="section-pace-table-scroll">
      <table className="section-pace-table">
        <caption className="section-pace-table-caption">
          Per-sector times vs the canonical reference ({refLabel} pace surface). {runName} column is extra time
          in that window relative to the reference.
        </caption>
        <thead>
          <tr>
            <th scope="col">Sector</th>
            <th scope="col">Reference (section time)</th>
            <th scope="col">
              {runName} Δ vs ref
            </th>
            <th scope="col">Verdict</th>
          </tr>
        </thead>
        <tbody>
          {rows.map((r) => (
            <tr key={r.sector}>
              <td>{r.sector}</td>
              <td>{r.tRef}</td>
              <td>{r.delta}</td>
              <td>{r.verdict}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  )
}
