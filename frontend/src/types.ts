/** Column-oriented telemetry from the API (one parallel array per field). */
export type TelemetryColumnar = Record<string, (number | boolean | null)[] | undefined> & {
  unix_ns: number[]
  latitude: number[]
  longitude: number[]
}

export type TelemetryPoint = {
  unix_ns: number
  latitude: number
  longitude: number
  altitude_m?: number | null
  altitude_smooth_m?: number | null
  vz_m_s?: number | null
  /** 0.5 Hz LPF + 1.5s SG on vz_m_s; map + elevation heat profile (MTB logic still uses vz_m_s). */
  vz_smooth_m_s?: number | null
  speed_m_s?: number | null
  distance_m?: number | null
  time_s?: number | null
  pressure_mbar?: number | null
  relative_altitude_app_m?: number | null
  sanity_pressure_minus_app_m?: number | null
  gps_wgs84_anchor_offset_m?: number | null
  gps_wgs84_residual_m?: number | null
  mtb_braking_ma_ms2?: number | null
  mtb_braking_intensity?: number | null
  mtb_braking_active?: boolean | null
}

export type BrakingIntervalM = { start_m: number; end_m: number }

/** When total_airtime_s is 0, backend may list low-G segments that failed sandwich gates (debug). */
export type AlmostJumpDebug = {
  start_sample: number
  end_sample: number
  duration_s: number
  fail_reason: 'candidate_too_short' | 'refine_duration' | 'landing_peak'
  needed_min_duration_s?: number
  needed_min_samples?: number
  vz_median_m_s?: number | null
  low_g_threshold_g?: number
  takeoff_max_g?: number | null
  jump_takeoff_threshold_g?: number
  landing_max_g?: number | null
  need_landing_g?: number
  note?: string
}

/** Backend-derived map color limits (full-rate proc); frontend falls back to client percentiles if missing. */
export type MapColorBounds = { cmin: number; cmax: number }

export type VizHints = {
  map: {
    vz?: MapColorBounds
  }
  charts?: {
    /** Suggested half-span for symmetric Vz Y-axis (m/s); pooled across laps with max(). */
    vz_symmetric_half_span_m_s?: number
  }
}

export type MtbStats = {
  max_lean_deg: number
  total_airtime_s: number
  /** Raw ‖TotalAcceleration‖/g < ~0.55 while moving; sum of sample times—no sandwich (see tooltip). */
  simple_airtime_s?: number
  jump_count?: number
  drop_count?: number
  /** Drops where median baro Vz during flight was < about −1.5 m/s (falling). */
  drops_baro_witness?: number
  /** Max landing spike (g) while moving; prefer over legacy hardest_g_peak. */
  max_landing_impact_g?: number
  /** @deprecated use max_landing_impact_g */
  hardest_g_peak?: number
  almost_jumps?: AlmostJumpDebug[]
}

export type RunResult = {
  /** Row records (legacy) or column-oriented object from the pipeline. */
  telemetry: TelemetryPoint[] | TelemetryColumnar
  altitude_vs_distance: { distance_m: number[]; altitude_m: number[] }
  sample_rate_hz: number
  smoothness_score?: number
  run_id?: number
  label?: string
  source_name?: string
  color?: string
  mtb_stats?: MtbStats | null
  braking_intervals_m?: BrakingIntervalM[]
  /** From full-rate pipeline; map + chart defaults when present. */
  viz_hints?: VizHints | null
}

export type DeltaTAlongPath = {
  distance_m: number[]
  delta_t_s: number[]
  t_a_s: number[]
  t_b_s: number[]
  /** Per-meter time spread across runs that built the reference (for pace band), when present. */
  t_reference_sigma_s?: number[] | null
}

export type ComparisonPayload = {
  delta_t: DeltaTAlongPath
  high_delta_distance_m: number[]
  /** vs canonical: largest time-loss samples for map pins. */
  pace_loss_distance_m?: number[]
  pace_vs_reference?: boolean
  lap_a: { distance_m: number[]; altitude_m: number[] }
  lap_b: { distance_m: number[]; altitude_m: number[] }
}

/** Step 1 only: server snap + bearing-based gate (same math as align). */
export type GatePreview = {
  gate_index_a: number
  gate_index_b: number
  gate_snapped_latitude_a: number
  gate_snapped_longitude_a: number
  gate_snapped_latitude_b: number
  gate_snapped_longitude_b: number
  gate_latitude_click: number
  gate_longitude_click: number
  gate_radius_m: number
  trail_bearing_deg_clockwise_from_north_a?: number
  gate_line_longitude?: number[]
  gate_line_latitude?: number[]
}

export type AlignmentMeta = {
  gate_index_a: number
  gate_index_b: number
  baro_correlation_distance_m?: number
  baro_correlation_samples_used?: number
  cropped_length_samples?: number
  lag_samples_run_b?: number
  median_dt_run_b_s?: number
  lag_applied_to_run_b_s: number
  correlation_peak_normalized: number
  gate_latitude: number
  gate_longitude: number
  gate_radius_m: number
  gate_snapped_latitude_a?: number
  gate_snapped_longitude_a?: number
  gate_snapped_latitude_b?: number
  gate_snapped_longitude_b?: number
  /** Clockwise from north: 0° = north, 90° = east. Green gate is perpendicular to this heading. */
  trail_bearing_deg_clockwise_from_north_a?: number
  /** Virtual gate: perpendicular to trail heading at Run A snap, degrees lon/lat */
  gate_line_longitude?: number[]
  gate_line_latitude?: number[]
}

export type UploadResponse = {
  runs: RunResult[]
  comparison: ComparisonPayload | null
  run_count: number
  alignment?: AlignmentMeta | null
}

/** POST /upload returns immediately; poll GET /upload/status/{job_id}. */
export type UploadJobStart = { job_id: string }

export type UploadJobStatus = {
  status: 'pending' | 'running' | 'done' | 'error'
  progress: number
  step: string
  result?: UploadResponse
  error?: string
}

/** POST /synthesize-baseline — N-run canonical 1D reference (distance-indexed). */
export type CanonicalReference = {
  distance_m: (number | null)[]
  /** Median cumulative time vs distance (s from lap start) at each 1D grid point. */
  t_reference_s?: (number | null)[]
  /** Std dev of resampled time across runs (pace uncertainty, seconds). */
  t_reference_sigma_s?: (number | null)[]
  elevation_m: (number | null)[]
  vz_m_s: (number | null)[]
  grade_m_per_m: (number | null)[]
  confidence_band_m: {
    sigma_m: (number | null)[]
    lower_m: (number | null)[]
    upper_m: (number | null)[]
  }
  reliability_score: (number | null)[]
  meta: {
    run_count: number
    distance_step_m: number
    distance_count: number
    sample_rate_hz_by_run: number[]
    alignment: string
    mean_shape: string
    finalizer: string
    gpr_kernel?: string
  }
}

export type SynthesizeBaselineResponse = {
  canonical_reference: CanonicalReference
}
