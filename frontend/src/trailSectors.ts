import { distanceSeries } from './distanceUtils'
import { telemetryLen } from './telemetryAccess'
import type { RunResult } from './types'

export type TrailSector = {
  id: string
  d0: number
  d1: number
  label: string
}

/** ~100m minimum span between cuts; 3…8 sectors. */
export function computeTrailSectorsSimple(run: RunResult | null, maxSectors = 6): TrailSector[] {
  if (run == null) return []
  const n = telemetryLen(run.telemetry)
  if (n < 2) return []
  const dist = distanceSeries(run.telemetry)
  const d0 = dist[0]!
  const d1 = dist[n - 1]!
  const span = d1 - d0
  if (!(span > 1)) return []
  const nSec = Math.max(3, Math.min(maxSectors, Math.max(3, Math.floor(span / 120))))
  const out: TrailSector[] = []
  for (let s = 0; s < nSec; s++) {
    out.push({
      id: `sec-${s}`,
      d0: d0 + (span * s) / nSec,
      d1: d0 + (span * (s + 1)) / nSec,
      label: `Sector ${s + 1}`,
    })
  }
  return out
}
