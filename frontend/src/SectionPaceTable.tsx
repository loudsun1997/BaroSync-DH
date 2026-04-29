import { useMemo, Fragment } from 'react'
import { computeTrailSectorsSimple } from './trailSectors'
import type { ComparisonPayload, RunResult, CanonicalReference } from './types'
import { numAt, telemetryLen } from './telemetryAccess'

type Props = {
  runs: RunResult[]
  comparison: ComparisonPayload
  canonicalRef: CanonicalReference | null
}

function tAt(d: number, dist: number[], t: number[]): number {
  if (dist.length === 0) return 0
  let j = 0
  for (let i = 0; i < dist.length; i++) {
    if (dist[i]! <= d) j = i
  }
  return t[j] ?? 0
}

type RunSectorData = {
  label: string
  deltaT: number
  avgDeltaVz: number | null
}

type Row = {
  sector: string
  tRef: string
  refAvgVz: string | null
  runsData: RunSectorData[]
}

export function SectionPaceTable({ runs, comparison, canonicalRef }: Props) {
  const paceRef = Boolean(comparison.pace_vs_reference)
  const runsDeltaT = comparison.runs_delta_t ?? [comparison.delta_t]

  const rows = useMemo((): Row[] => {
    if (runs.length === 0) return []
    const ref_d = comparison.delta_t.distance_m
    const ref_t = comparison.delta_t.t_reference_s ?? comparison.delta_t.t_a_s
    
    if (ref_d.length < 2) return []
    
    const sectors = computeTrailSectorsSimple(runs[0]!, 6)
    const out: Row[] = []
    
    for (const s of sectors) {
      const t0_ref = tAt(s.d0, ref_d, ref_t)
      const t1_ref = tAt(s.d1, ref_d, ref_t)
      const secRefT = t1_ref - t0_ref

      // compute ref avg vz in this sector
      let refVzSum = 0
      let refVzCount = 0
      if (canonicalRef?.distance_m && canonicalRef?.vz_m_s) {
        for (let i = 0; i < canonicalRef.distance_m.length; i++) {
          const d = canonicalRef.distance_m[i]!
          if (d >= s.d0 && d <= s.d1) {
             const vz = canonicalRef.vz_m_s[i]
             if (vz != null && Number.isFinite(vz)) {
               refVzSum += vz
               refVzCount++
             }
          }
        }
      }
      const refAvgVz = refVzCount > 0 ? refVzSum / refVzCount : null

      const runsData: RunSectorData[] = runs.map((run, ri) => {
        const dtPayload = runsDeltaT[ri] ?? comparison.delta_t
        const run_t = paceRef ? dtPayload.t_run_s : dtPayload.t_b_s
        const run_d = paceRef ? dtPayload.distance_m : dtPayload.distance_m // approx
        
        let secRunT = 0
        if (run_t && run_d) {
          const t0_run = tAt(s.d0, run_d, run_t)
          const t1_run = tAt(s.d1, run_d, run_t)
          secRunT = t1_run - t0_run
        }
        
        // Compute run avg Vz in this sector to find Delta Vz
        let runVzSum = 0
        let runVzCount = 0
        const tel = run.telemetry
        const n = telemetryLen(tel)
        for(let i=0; i<n; i++) {
           const d = numAt(tel, 'distance_m', i)
           if (d != null && d >= s.d0 && d <= s.d1) {
             let vz = numAt(tel, 'vz_smooth_m_s', i)
             if (vz == null || Math.abs(vz) < 1e-5) vz = numAt(tel, 'vz_m_s', i)
             if (vz != null && Number.isFinite(vz)) {
               runVzSum += vz
               runVzCount++
             }
           }
        }
        const runAvgVz = runVzCount > 0 ? runVzSum / runVzCount : null
        
        const deltaVz = (refAvgVz != null && runAvgVz != null) ? refAvgVz - runAvgVz : null

        return {
          label: run.label ?? `Run ${ri + 1}`,
          deltaT: secRunT - secRefT,
          avgDeltaVz: deltaVz
        }
      })

      out.push({
        sector: s.label,
        tRef: `${secRefT.toFixed(1)}s`,
        refAvgVz: refAvgVz != null ? `${refAvgVz.toFixed(2)} m/s` : null,
        runsData,
      })
    }
    return out
  }, [comparison, runs, canonicalRef, paceRef, runsDeltaT])

  if (rows.length === 0) {
    return <p className="section-pace-table-empty">Not enough data for sector breakdown.</p>
  }

  return (
    <div className="section-pace-table-scroll">
      <table className="section-pace-table">
        <caption className="section-pace-table-caption">
          Per-sector times and average ΔVz vs the canonical reference.
        </caption>
        <thead>
          <tr>
            <th scope="col" rowSpan={2}>Sector</th>
            <th scope="col" rowSpan={2}>Ref Time</th>
            {runs.map((r, i) => (
              <th scope="col" colSpan={2} key={i} style={{ borderBottom: '1px solid #e2e8f0', textAlign: 'center' }}>
                {r.label ?? `Run ${i + 1}`} vs Ref
              </th>
            ))}
          </tr>
          <tr>
             {runs.map((_, i) => (
               <Fragment key={`sub-${i}`}>
                 <th scope="col">Δt (s)</th>
                 <th scope="col">ΔVz (m/s)</th>
               </Fragment>
             ))}
          </tr>
        </thead>
        <tbody>
          {rows.map((r) => (
            <tr key={r.sector}>
              <td>{r.sector}</td>
              <td>{r.tRef}</td>
              {r.runsData.map((rd, i) => (
                <Fragment key={i}>
                  <td style={{ color: rd.deltaT > 0.15 ? '#dc2626' : rd.deltaT < -0.15 ? '#16a34a' : 'inherit' }}>
                    {rd.deltaT > 0 ? '+' : ''}{rd.deltaT.toFixed(2)}
                  </td>
                  <td style={{ color: rd.avgDeltaVz && rd.avgDeltaVz > 0.1 ? '#1d4ed8' : rd.avgDeltaVz && rd.avgDeltaVz < -0.1 ? '#dc2626' : 'inherit' }}>
                    {rd.avgDeltaVz != null ? (rd.avgDeltaVz > 0 ? '+' : '') + rd.avgDeltaVz.toFixed(2) : '-'}
                  </td>
                </Fragment>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  )
}
