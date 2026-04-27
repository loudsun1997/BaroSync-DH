import type { AlignmentMeta } from './types'

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
