import type { CanonicalReference, ComparisonPayload } from './types'

/**
 * Resample the canonical 1D grid to parallel finite arrays for /pace-vs-reference.
 */
export function compactCanonicalForPace(can: CanonicalReference | null): {
  distance_m: number[]
  t_reference_s: number[]
  t_reference_sigma_s: number[] | null
  ref_elevation_m: number[]
} | null {
  if (!can?.t_reference_s?.length || !can.distance_m?.length) return null
  const d = can.distance_m
  const t = can.t_reference_s
  const h = can.elevation_m
  const s = can.t_reference_sigma_s
  const dOut: number[] = []
  const tOut: number[] = []
  const hOut: number[] = []
  const sOut: number[] = []
  for (let i = 0; i < d.length; i++) {
    const di = d[i]
    const ti = t[i]
    const hi = h[i]
    if (
      di == null ||
      ti == null ||
      hi == null ||
      !Number.isFinite(di) ||
      !Number.isFinite(ti) ||
      !Number.isFinite(hi)
    ) {
      continue
    }
    dOut.push(di)
    tOut.push(ti)
    hOut.push(hi)
    if (s && s[i] != null && Number.isFinite(s[i]!)) {
      sOut.push(s[i]!)
    } else {
      sOut.push(0)
    }
  }
  if (dOut.length < 2) return null
  const fullSigma = s && s.length === d.length && sOut.length === dOut.length
  return {
    distance_m: dOut,
    t_reference_s: tOut,
    ref_elevation_m: hOut,
    t_reference_sigma_s: fullSigma ? sOut : null,
  }
}

export function isPaceVsReference(
  c: ComparisonPayload | null,
): c is ComparisonPayload & { pace_vs_reference: true } {
  return c != null && c.pace_vs_reference === true
}
