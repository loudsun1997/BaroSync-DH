import type { ComparisonPayload } from './types'

/**
 * d(Δt)/ds in s/m along the comparison grid (pace change: positive ⇒ losing time to A, negative ⇒ gaining).
 */
export function comparisonDeltaTPaceSPerM(comparison: ComparisonPayload | null): {
  dist: number[]
  rate: number[]
} {
  if (!comparison?.delta_t?.distance_m?.length) {
    return { dist: [], rate: [] }
  }
  const d = comparison.delta_t.distance_m
  const t = comparison.delta_t.delta_t_s
  const n = d.length
  if (n < 2) return { dist: d, rate: t.map(() => 0) }
  const rate = new Array<number>(n)
  rate[0] = 0
  for (let i = 1; i < n; i++) {
    const ds = d[i]! - d[i - 1]!
    if (ds > 1e-9) {
      rate[i] = (t[i]! - t[i - 1]!) / ds
    } else {
      rate[i] = 0
    }
  }
  return { dist: d, rate }
}

function interpMonotonicPos(xs: number[], ys: number[], xq: number): number {
  const n = xs.length
  if (n === 0) return 0
  if (xq <= xs[0]!) return ys[0]!
  if (xq >= xs[n - 1]!) return ys[n - 1]!
  let lo = 0
  let hi = n - 1
  while (hi - lo > 1) {
    const mid = (lo + hi) >> 1
    if (xs[mid]! <= xq) lo = mid
    else hi = mid
  }
  const x0 = xs[lo]!
  const x1 = xs[hi]!
  const y0 = ys[lo]!
  const y1 = ys[hi]!
  const f = x1 > x0 ? (xq - x0) / (x1 - x0) : 0
  return y0 + f * (y1 - y0)
}

/** One value per `queryDistM` (run B), aligned to comparison distance grid. */
export function deltaTPaceForDistances(
  comparison: ComparisonPayload | null,
  queryDistM: number[],
): number[] {
  if (!comparison || queryDistM.length === 0) return queryDistM.map(() => 0)
  const { dist, rate } = comparisonDeltaTPaceSPerM(comparison)
  if (dist.length === 0) return queryDistM.map(() => 0)
  return queryDistM.map((d) => interpMonotonicPos(dist, rate, d))
}
