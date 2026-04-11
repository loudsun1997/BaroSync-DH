/**
 * Y-axis helpers: focus view on the bulk of the signal so single-sample spikes
 * (e.g. IMU glitches) do not compress the rest of the line.
 */

/** Defaults for robust Y-axis band (nearest-rank percentiles, 0–100). */
export const CHART_PERCENTILE_DEFAULTS = { low: 1, high: 99 } as const

/** Keep a valid (low, high) pair with at least 2 percentile points between them. */
export function clampChartPercentilePair(low: number, high: number): { low: number; high: number } {
  let lo = Math.round(Number.isFinite(low) ? low : CHART_PERCENTILE_DEFAULTS.low)
  let hi = Math.round(Number.isFinite(high) ? high : CHART_PERCENTILE_DEFAULTS.high)
  lo = Math.max(0, Math.min(98, lo))
  hi = Math.max(2, Math.min(100, hi))
  if (hi - lo < 2) {
    hi = Math.min(100, lo + 2)
    if (hi - lo < 2) lo = Math.max(0, hi - 2)
  }
  return { low: lo, high: hi }
}

export type RobustYAxisOptions = {
  /** Lower percentile (0–100), default 1 */
  lowPct?: number
  /** Upper percentile (0–100), default 99 */
  highPct?: number
  /** Expand range by this fraction of the p99–p1 span after percentiles */
  padFraction?: number
  /** Minimum axis span (after padding) */
  minSpan?: number
  /** Hard ceiling on the top of the axis (spikes can render above the frame) */
  clampHigh?: number | null
  /** Hard floor on the bottom of the axis */
  clampLow?: number | null
  /**
   * Symmetric axis [-M, M]: M = max(|P_low|, |P_high|) on signed values (both percentiles apply),
   * then padding and optional clampHigh on M. Good for signed Vz.
   */
  symmetricAroundZero?: boolean
}

function percentileNearestRank(sortedAsc: number[], p: number): number {
  const n = sortedAsc.length
  if (n === 0) return NaN
  if (n === 1) return sortedAsc[0]
  const idx = Math.ceil((p / 100) * n) - 1
  return sortedAsc[Math.max(0, Math.min(n - 1, idx))]
}

/** Flatten Plotly scatter `y` arrays (finite values only). */
export function collectFiniteYFromTraces(traces: { y?: unknown }[]): number[] {
  const out: number[] = []
  for (const t of traces) {
    const y = t.y
    if (!Array.isArray(y)) continue
    for (const v of y) {
      if (typeof v === 'number' && Number.isFinite(v)) out.push(v)
    }
  }
  return out
}

/**
 * Returns [ymin, ymax] for Plotly `yaxis.range`, or undefined to keep autorange.
 */
export function robustYAxisRange(values: number[], options: RobustYAxisOptions = {}): [number, number] | undefined {
  const lowPct = options.lowPct ?? 1
  const highPct = options.highPct ?? 99
  const padFraction = options.padFraction ?? 0.08
  const minSpan = options.minSpan ?? 0

  const xs = values.filter((v) => typeof v === 'number' && Number.isFinite(v))
  if (xs.length < 4) return undefined

  if (options.symmetricAroundZero) {
    const sorted = [...xs].sort((a, b) => a - b)
    let vLo = percentileNearestRank(sorted, lowPct)
    let vHi = percentileNearestRank(sorted, highPct)
    if (!Number.isFinite(vLo) || !Number.isFinite(vHi)) return undefined
    if (vHi <= vLo) {
      const mid = (vHi + vLo) / 2
      const eps = Math.max(1e-6, Math.abs(mid) * 1e-4)
      vLo = mid - eps
      vHi = mid + eps
    }
    let half = Math.max(Math.abs(vLo), Math.abs(vHi))
    if (!Number.isFinite(half) || half <= 0) return undefined
    half *= 1 + padFraction
    if (options.clampHigh != null && half > options.clampHigh) half = options.clampHigh
    if (half <= 0) return undefined
    const span = Math.max(2 * half, minSpan)
    const m = span / 2
    return [-m, m]
  }

  const sorted = [...xs].sort((a, b) => a - b)
  let lo = percentileNearestRank(sorted, lowPct)
  let hi = percentileNearestRank(sorted, highPct)
  if (!Number.isFinite(lo) || !Number.isFinite(hi)) return undefined
  if (hi <= lo) {
    const mid = (hi + lo) / 2
    const eps = Math.max(1e-6, Math.abs(mid) * 1e-4)
    lo = mid - eps
    hi = mid + eps
  }
  const span = hi - lo
  lo -= span * padFraction
  hi += span * padFraction
  if (options.clampHigh != null) hi = Math.min(hi, options.clampHigh)
  if (options.clampLow != null) lo = Math.max(lo, options.clampLow)
  if (hi - lo < minSpan) {
    const mid = (hi + lo) / 2
    lo = mid - minSpan / 2
    hi = mid + minSpan / 2
  }
  return [lo, hi]
}

export type RobustColorScaleOptions = {
  /** Lower percentile (0–100), default 2 */
  lowPct?: number
  /** Upper percentile (0–100), default 98 */
  highPct?: number
  /** Expand range by this fraction of the span after percentiles */
  padFraction?: number
  /** Minimum color-axis span */
  minSpan?: number
  clampLow?: number | null
  clampHigh?: number | null
  /** p98 of |value|, then ±half (good for diverging Δt scales) */
  symmetricAroundZero?: boolean
}

/**
 * [cmin, cmax] for Plotly marker colors: bulk of the signal (default p2–p98) so single spikes
 * do not flatten contrast. Pair with marker.cauto = false.
 */
export function robustColorScaleRange(
  values: number[],
  options: RobustColorScaleOptions = {},
): [number, number] | undefined {
  const lowPct = options.lowPct ?? 2
  const highPct = options.highPct ?? 98
  const padFraction = options.padFraction ?? 0.06
  const minSpan = options.minSpan ?? 0

  const xs = values.filter((v) => typeof v === 'number' && Number.isFinite(v))
  if (xs.length < 4) return undefined

  if (options.symmetricAroundZero) {
    const absSorted = xs.map((a) => Math.abs(a)).sort((a, b) => a - b)
    let half = percentileNearestRank(absSorted, highPct)
    if (!Number.isFinite(half)) return undefined
    half *= 1 + padFraction
    if (options.clampHigh != null && half > options.clampHigh) half = options.clampHigh
    if (half <= 0) return undefined
    const span = Math.max(2 * half, minSpan)
    const m = span / 2
    return [-m, m]
  }

  const sorted = [...xs].sort((a, b) => a - b)
  let lo = percentileNearestRank(sorted, lowPct)
  let hi = percentileNearestRank(sorted, highPct)
  if (!Number.isFinite(lo) || !Number.isFinite(hi)) return undefined
  if (hi <= lo) {
    const mid = (hi + lo) / 2
    const eps = Math.max(1e-6, Math.abs(mid) * 1e-4)
    lo = mid - eps
    hi = mid + eps
  }
  const span = hi - lo
  lo -= span * padFraction
  hi += span * padFraction
  if (options.clampHigh != null) hi = Math.min(hi, options.clampHigh)
  if (options.clampLow != null) lo = Math.max(lo, options.clampLow)
  if (hi <= lo) {
    const mid = (hi + lo) / 2
    const eps = Math.max(1e-6, Math.abs(mid) * 1e-4)
    lo = mid - eps
    hi = mid + eps
  }
  if (hi - lo < minSpan) {
    const mid = (hi + lo) / 2
    lo = mid - minSpan / 2
    hi = mid + minSpan / 2
  }
  if (options.clampHigh != null) hi = Math.min(hi, options.clampHigh)
  if (options.clampLow != null) lo = Math.max(lo, options.clampLow)
  if (hi <= lo) return undefined
  return [lo, hi]
}
