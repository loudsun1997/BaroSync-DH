import type { AlignmentMeta, MtbStats, RunResult } from './types'

export function effectiveMaxLandingG(s: MtbStats): number {
  const v = s.max_landing_impact_g ?? s.hardest_g_peak ?? 0
  return typeof v === 'number' && Number.isFinite(v) ? v : 0
}

/** Flow Factor = smoothness_score (1 / std(Vz)); higher = more consistent descending. */
export function flowGrade(score: number): { label: string; blurb: string } {
  if (score >= 0.2)
    return {
      label: 'Pro Flow',
      blurb: 'Buttery smooth, consistent speed through the trail.',
    }
  if (score >= 0.15)
    return {
      label: 'Smooth',
      blurb: 'Solid line choice with only minor speed corrections.',
    }
  if (score >= 0.14)
    return {
      label: 'Mixed',
      blurb: 'Some chatter—between smooth and technical.',
    }
  return {
    label: 'Rough / Technical',
    blurb: 'Heavy braking, roots, or fighting the bike—lots of Vz variation.',
  }
}

export const FLOW_FACTOR_TOOLTIP =
  'Flow Factor measures how consistently you descend. Higher scores mean you kept momentum instead of “stabbing” at the terrain (lower chatter in vertical velocity).'

export const SIMPLE_AIRTIME_TOOLTIP =
  'Naive low-G clock: every sample while GPS speed > ~0.5 m/s where raw ‖TotalAcceleration‖/g is below ~0.55 g. No landing/takeoff checks—will include smooth coasting and vibration; compare to validated Airtime above.'

export const AIRTIME_TOOLTIP =
  'Total seconds in the air: 10 Hz Butterworth LPF on raw ‖TotalAcceleration‖/g for flight (< ~0.55 g; 20 Hz min logged on first-run rejects), min ~0.20 s; sustained landing max (30 Hz LPF + 20 ms rolling mean on ‖TotalAcceleration‖/g) > ~1.3 g within 500 ms. Jump if raw takeoff > ~1.15 g in ~200 ms before flight; else drop. GPS speed > ~0.5 m/s. First run: see backend log [airtime diagnostic].'

export const JUMP_DROP_COUNTS_TOOLTIP =
  'Jump: pre-flight raw ‖total acc‖ peaked ≥ ~1.15 g (lip/pop). Drop: rolled off ~1 g → low G with no pop, still landed with a spike. “Baro drops” = drops whose median Vz during flight was < ~−1.5 m/s.'

export const MAX_LEAN_TOOLTIP =
  'The largest lean angle we saw on this lap—from gravity in the leveled bike frame when available, otherwise from orientation roll.'

export const LANDING_IMPACT_TOOLTIP =
  'Landing G-Force: max of a 20 ms rolling mean on ‖TotalAcceleration‖/g after a 30 Hz low-pass (removes high-frequency chatter). No fixed cap—if you truly sustain high g for 20 ms, that value is reported. Validated landing windows when possible, else prominence-filtered peaks. Not the 10 Hz flight signal.'

export function syncQualityFromPeak(peak: number): { label: string; blurb: string } {
  if (peak > 0.6)
    return {
      label: 'Perfect match',
      blurb: 'Barometer traces lined up very strongly—timing is trustworthy.',
    }
  if (peak >= 0.3)
    return {
      label: 'Good match',
      blurb: 'Solid alignment; small line-choice or pacing differences are normal.',
    }
  return {
    label: 'Low confidence',
    blurb: 'Weak correlation—different line, bad gate snap, or GPS/barometer issues?',
  }
}

/** Display label for max landing g; only meaningful when g >= 1. */
export function landingImpactSeverity(g: number): string {
  if (g < 1.0) return 'Soft landing'
  if (g < 1.5) return 'Light hit'
  if (g < 2.5) return 'Firm landing'
  return 'G-out'
}

export function formatLandingImpactG(g: number): string {
  if (g < 1.0) return '—'
  return `${g.toFixed(2)} g`
}

export function buildRiderInsight(runs: RunResult[]): string | null {
  if (runs.length < 2) return null
  const a = runs[0]
  const b = runs[1]
  const sa = a.smoothness_score
  const sb = b.smoothness_score
  const ma = a.mtb_stats
  const mb = b.mtb_stats
  const parts: string[] = []

  if (sa != null && sb != null && sa > 0) {
    const pct = ((sa - sb) / sa) * 100
    if (Math.abs(pct) >= 3) {
      const smoother = pct > 0 ? (a.label ?? 'First run') : b.label ?? 'Second run'
      parts.push(`${smoother} was about ${Math.abs(pct).toFixed(0)}% smoother (Flow Factor)`)
    }
  }

  if (ma && mb) {
    const da = ma.total_airtime_s - mb.total_airtime_s
    if (Math.abs(da) >= 0.15) {
      const more =
        da > 0 ? (a.label ?? 'Run 1') : (b.label ?? 'Run 2')
      parts.push(`${more} had ~${Math.abs(da).toFixed(1)}s more airtime`)
    }
  }

  if (!parts.length) return 'Two laps loaded—set the gate and align baro to compare pacing and line.'
  return parts.join('; ') + '.'
}

export function formatAlignmentDevDetails(m: AlignmentMeta): string {
  const samp = m.lag_samples_run_b
  const n = m.cropped_length_samples
  const corrWin =
    m.baro_correlation_distance_m != null
      ? `Vz corr window: first ${m.baro_correlation_distance_m.toFixed(0)} m on Run A`
      : null
  const corrN = m.baro_correlation_samples_used != null ? `${m.baro_correlation_samples_used} corr samples` : null
  const parts = [
    `Run B lag ${m.lag_applied_to_run_b_s.toFixed(3)} s`,
    samp != null ? `${samp} samples` : null,
    n != null ? `cropped to ${n} samples each` : null,
    corrWin,
    corrN,
    `corr peak ≈ ${m.correlation_peak_normalized.toFixed(3)}`,
    m.trail_bearing_deg_clockwise_from_north_a != null
      ? `Run A heading at gate ≈ ${m.trail_bearing_deg_clockwise_from_north_a.toFixed(0)}° from N`
      : null,
  ].filter(Boolean)
  return parts.join(' · ')
}
