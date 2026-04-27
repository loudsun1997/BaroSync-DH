import { distanceSeries } from './distanceUtils'
import { telemetryLen, vzDisplayValueAt } from './telemetryAccess'
import type { RunResult } from './types'

export type VerticalSpeedCompareResult = {
  overlapStartM: number
  overlapEndM: number
  overlapLengthM: number
  gridStepM: number
  tieEpsM_s: number
  /** Negative: both runs must be at or below this Vz (m/s) to count as a “descent” sample. */
  descentCutM_s: number
  /** vz_B - vz_A: positive ⇒ run A more negative Vz (same sign convention as charts: + up, − down). */
  samples: number
  aLowerVzCount: number
  bLowerVzCount: number
  tieCount: number
  meanAbsDiffM_s: number
  /** Subset where both laps are clearly descending — “who dropped faster” is meaningful here. */
  descentSamples: number
  descentALowerVzCount: number
  descentBLowerVzCount: number
  descentTieCount: number
}

function interpMonotonic(xs: number[], ys: (number | null)[], xq: number): number | null {
  const n = xs.length
  if (n === 0) return null
  if (xq <= xs[0]!) {
    const y = ys[0]
    return y != null && Number.isFinite(y) ? y : null
  }
  if (xq >= xs[n - 1]!) {
    const y = ys[n - 1]
    return y != null && Number.isFinite(y) ? y : null
  }
  let lo = 0
  let hi = n - 1
  while (hi - lo > 1) {
    const mid = (lo + hi) >> 1
    if (xs[mid]! <= xq) lo = mid
    else hi = mid
  }
  const x0 = xs[lo]!
  const x1 = xs[hi]!
  const y0 = ys[lo]
  const y1 = ys[hi]
  if (y0 == null || y1 == null || !Number.isFinite(y0) || !Number.isFinite(y1)) return null
  const t = x1 > x0 ? (xq - x0) / (x1 - x0) : 0
  return y0 + t * (y1 - y0)
}

function vzSeriesNullable(t: RunResult['telemetry']): (number | null)[] {
  const n = telemetryLen(t)
  const out: (number | null)[] = new Array(n)
  for (let i = 0; i < n; i++) {
    out[i] = vzDisplayValueAt(t, i)
  }
  return out
}

/**
 * Sample both runs on a distance grid over their overlapping range. At each point compare display Vz.
 * “Lower Vz” = algebraically more negative (more downward if both are negative). On climbs, that is not
 * “descending faster”; see descent* counts where both Vz are below descentCutM_s.
 */
export function compareVerticalSpeedTwoRuns(
  runA: RunResult,
  runB: RunResult,
  opts?: { gridStepM?: number; tieEpsM_s?: number; descentCutM_s?: number },
): VerticalSpeedCompareResult | null {
  const gridStepM = opts?.gridStepM ?? 1
  const tieEpsM_s = opts?.tieEpsM_s ?? 0.08
  const descentCutM_s = opts?.descentCutM_s ?? -0.25

  const dA = distanceSeries(runA.telemetry)
  const dB = distanceSeries(runB.telemetry)
  if (dA.length < 2 || dB.length < 2) return null

  const a0 = dA[0]!
  const a1 = dA[dA.length - 1]!
  const b0 = dB[0]!
  const b1 = dB[dB.length - 1]!
  const start = Math.max(Math.min(a0, a1), Math.min(b0, b1))
  const end = Math.min(Math.max(a0, a1), Math.max(b0, b1))
  if (!(end > start + gridStepM * 0.5)) return null

  const vzA = vzSeriesNullable(runA.telemetry)
  const vzB = vzSeriesNullable(runB.telemetry)
  if (vzA.length !== dA.length || vzB.length !== dB.length) return null

  let aLower = 0
  let bLower = 0
  let ties = 0
  let samples = 0
  let sumAbs = 0

  let descentSamples = 0
  let descentALower = 0
  let descentBLower = 0
  let descentTies = 0

  for (let d = start; d <= end; d += gridStepM) {
    const va = interpMonotonic(dA, vzA, d)
    const vb = interpMonotonic(dB, vzB, d)
    if (va == null || vb == null) continue
    samples += 1
    const diff = vb - va
    sumAbs += Math.abs(va - vb)
    if (Math.abs(va - vb) < tieEpsM_s) ties += 1
    else if (diff > 0) aLower += 1
    else bLower += 1

    if (va <= descentCutM_s && vb <= descentCutM_s) {
      descentSamples += 1
      if (Math.abs(va - vb) < tieEpsM_s) descentTies += 1
      else if (diff > 0) descentALower += 1
      else descentBLower += 1
    }
  }

  if (samples === 0) return null

  return {
    overlapStartM: start,
    overlapEndM: end,
    overlapLengthM: end - start,
    gridStepM,
    tieEpsM_s,
    descentCutM_s,
    samples,
    aLowerVzCount: aLower,
    bLowerVzCount: bLower,
    tieCount: ties,
    meanAbsDiffM_s: sumAbs / samples,
    descentSamples,
    descentALowerVzCount: descentALower,
    descentBLowerVzCount: descentBLower,
    descentTieCount: descentTies,
  }
}

export function canCompareVerticalSpeed(runs: RunResult[]): boolean {
  return runs.length >= 2 && telemetryLen(runs[0]!.telemetry) >= 2 && telemetryLen(runs[1]!.telemetry) >= 2
}

/**
 * Heat on the **comparison** lap’s GPS: each sample uses Vz_compare at that point vs Vz_base interpolated
 * to the same distance. `delta = Vz_base − Vz_compare`. Positive ⇒ compare is **faster down** (more negative Vz)
 * than base → RdBu **orange**; negative ⇒ compare **slower** → **blue**. Invalid → NaN.
 */
export function vzCompareHeatOnCompareRun(
  runBase: RunResult,
  runCompare: RunResult,
): { delta: number[]; va: number[]; vb: number[] } | null {
  const telBase = runBase.telemetry
  const telCmp = runCompare.telemetry
  const n = telemetryLen(telCmp)
  if (n === 0 || telemetryLen(telBase) < 2) return null
  const dBase = distanceSeries(telBase)
  const dCmp = distanceSeries(telCmp)
  const vzBase = vzSeriesNullable(telBase)
  const vzCmp = vzSeriesNullable(telCmp)
  if (vzBase.length !== dBase.length || vzCmp.length !== n || dCmp.length !== n) return null

  const delta = new Array<number>(n)
  const va = new Array<number>(n)
  const vb = new Array<number>(n)
  for (let i = 0; i < n; i++) {
    const vCmp = vzCmp[i]
    const di = dCmp[i]!
    if (!Number.isFinite(di)) {
      delta[i] = NaN
      va[i] = NaN
      vb[i] = NaN
      continue
    }
    const vBase = interpMonotonic(dBase, vzBase, di)
    if (vCmp == null || vBase == null || !Number.isFinite(vCmp) || !Number.isFinite(vBase)) {
      delta[i] = NaN
      va[i] = NaN
      vb[i] = NaN
    } else {
      va[i] = vBase
      vb[i] = vCmp
      delta[i] = vBase - vCmp
    }
  }
  return { delta, va, vb }
}
