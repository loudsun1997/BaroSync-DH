import type { ComparisonPayload, RunResult, TelemetryPoint } from './types'
import { isTelemetryRecords, mapNumericColumn, telemetryLen } from './telemetryAccess'

export function distanceSeries(telemetry: RunResult['telemetry']): number[] {
  if (isTelemetryRecords(telemetry)) {
    return telemetry.map((t) => t.distance_m ?? 0)
  }
  const d = telemetry.distance_m
  const n = telemetry.unix_ns.length
  if (!d || d.length !== n) return Array(n).fill(0)
  const out = new Array<number>(n)
  for (let i = 0; i < n; i++) {
    const v = d[i]
    out[i] = typeof v === 'number' && Number.isFinite(v) ? v : 0
  }
  return out
}

export function nearestIndexForDistanceM(telemetry: RunResult['telemetry'], targetM: number): number {
  if (telemetryLen(telemetry) === 0) return 0
  const xs = distanceSeries(telemetry)
  let best = 0
  let bestD = Infinity
  for (let i = 0; i < xs.length; i++) {
    const d = Math.abs(xs[i] - targetM)
    if (d < bestD) {
      bestD = d
      best = i
    }
  }
  return best
}

/** Linear interpolation of delta_t (or any y) vs distance grid. */
export function interpAlongDistance(
  comparison: ComparisonPayload | null,
  displayM: number,
): number | null {
  if (!comparison?.delta_t?.distance_m?.length) return null
  const xd = comparison.delta_t.distance_m
  const yd = comparison.delta_t.delta_t_s
  if (displayM <= xd[0]) return yd[0] ?? null
  const last = xd[xd.length - 1]
  if (displayM >= last) return yd[yd.length - 1] ?? null
  let lo = 0
  let hi = xd.length - 1
  while (hi - lo > 1) {
    const mid = (lo + hi) >> 1
    if (xd[mid] <= displayM) lo = mid
    else hi = mid
  }
  const x0 = xd[lo]
  const x1 = xd[hi]
  const t = x1 > x0 ? (displayM - x0) / (x1 - x0) : 0
  const y0 = yd[lo] ?? 0
  const y1 = yd[hi] ?? 0
  return y0 + t * (y1 - y0)
}

/** Interpolate a per-sample series (e.g. vz) over cumulative distance. */
export function interpTelemetryScalarAlongDistance(
  telemetry: RunResult['telemetry'],
  key: keyof TelemetryPoint,
  distM: number,
): number | null {
  if (telemetryLen(telemetry) < 1) return null
  const xd = distanceSeries(telemetry)
  const yd = mapNumericColumn(telemetry, key)
  return interpXYAlongDistance(xd, yd, distM)
}

export function interpXYAlongDistance(xd: number[], yd: number[], distM: number): number | null {
  if (xd.length < 2 || yd.length !== xd.length) return null
  if (distM <= xd[0]!) return Number.isFinite(yd[0]!) ? yd[0]! : null
  const lastX = xd[xd.length - 1]!
  if (distM >= lastX) {
    const v = yd[yd.length - 1]!
    return Number.isFinite(v) ? v : null
  }
  let lo = 0
  let hi = xd.length - 1
  while (hi - lo > 1) {
    const mid = (lo + hi) >> 1
    if (xd[mid]! <= distM) lo = mid
    else hi = mid
  }
  const x0 = xd[lo]!
  const x1 = xd[hi]!
  const t = x1 > x0 ? (distM - x0) / (x1 - x0) : 0
  const y0 = yd[lo] ?? 0
  const y1 = yd[hi] ?? 0
  if (!Number.isFinite(y0) || !Number.isFinite(y1)) return null
  return y0 + t * (y1 - y0)
}

/**
 * Vertical speed on the canonical 1D grid (median across runs) at distance `distM`.
 * Ignores null entries on the reference grid.
 */
export function interpCanonicalVzMps(
  distance_m: (number | null)[],
  vz_m_s: (number | null)[],
  distM: number,
): number | null {
  const dOut: number[] = []
  const vOut: number[] = []
  for (let i = 0; i < distance_m.length; i++) {
    const d = distance_m[i]
    const v = vz_m_s[i]
    if (d == null || v == null || !Number.isFinite(d) || !Number.isFinite(v)) continue
    dOut.push(d)
    vOut.push(v)
  }
  if (dOut.length < 2) return null
  return interpXYAlongDistance(dOut, vOut, distM)
}
