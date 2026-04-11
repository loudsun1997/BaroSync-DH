import type { ComparisonPayload, TelemetryPoint } from './types'

export function distanceSeries(telemetry: TelemetryPoint[]): number[] {
  return telemetry.map((t) => t.distance_m ?? 0)
}

export function nearestIndexForDistanceM(telemetry: TelemetryPoint[], targetM: number): number {
  if (telemetry.length === 0) return 0
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
