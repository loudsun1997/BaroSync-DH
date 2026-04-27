import type { RunResult, TelemetryColumnar, TelemetryPoint } from './types'

export function isTelemetryRecords(t: RunResult['telemetry']): t is TelemetryPoint[] {
  return Array.isArray(t)
}

export function isTelemetryColumnar(t: RunResult['telemetry']): t is TelemetryColumnar {
  return (
    typeof t === 'object' &&
    t !== null &&
    !Array.isArray(t) &&
    Array.isArray((t as TelemetryColumnar).unix_ns)
  )
}

export function telemetryLen(t: RunResult['telemetry']): number {
  if (isTelemetryRecords(t)) return t.length
  return t.unix_ns.length
}

export function lonAt(t: RunResult['telemetry'], i: number): number {
  if (isTelemetryRecords(t)) {
    const v = t[i]?.longitude
    return typeof v === 'number' && Number.isFinite(v) ? v : 0
  }
  const v = t.longitude[i]
  return typeof v === 'number' && Number.isFinite(v) ? v : 0
}

export function latAt(t: RunResult['telemetry'], i: number): number {
  if (isTelemetryRecords(t)) {
    const v = t[i]?.latitude
    return typeof v === 'number' && Number.isFinite(v) ? v : 0
  }
  const v = t.latitude[i]
  return typeof v === 'number' && Number.isFinite(v) ? v : 0
}

export function numAt(t: RunResult['telemetry'], key: keyof TelemetryPoint, i: number, fallback = 0): number {
  if (isTelemetryRecords(t)) {
    const v = t[i]?.[key]
    return typeof v === 'number' && Number.isFinite(v) ? v : fallback
  }
  const col = t[key as string]
  if (!col || !Array.isArray(col)) return fallback
  const v = col[i]
  return typeof v === 'number' && Number.isFinite(v) ? v : fallback
}

export function telemetryLonLatArrays(t: RunResult['telemetry']): { lon: number[]; lat: number[] } {
  const n = telemetryLen(t)
  const lon = new Array<number>(n)
  const lat = new Array<number>(n)
  for (let i = 0; i < n; i++) {
    lon[i] = lonAt(t, i)
    lat[i] = latAt(t, i)
  }
  return { lon, lat }
}

/** Per-sample numeric series (missing → 0) for chart Y arrays. */
export function mapNumericColumn(t: RunResult['telemetry'], key: keyof TelemetryPoint): number[] {
  const n = telemetryLen(t)
  const out = new Array<number>(n)
  for (let i = 0; i < n; i++) {
    out[i] = numAt(t, key, i)
  }
  return out
}

/** Ground speed in km/h when `speed_m_s` is present, else 0. */
export function speedKmhSeries(t: RunResult['telemetry']): number[] {
  return mapNumericColumn(t, 'speed_m_s').map((mps) => (Number.isFinite(mps) && mps > 0 ? mps * 3.6 : 0))
}

/** Altitude for charts: smooth preferred, else raw baro. */
export function altitudeChartSeries(t: RunResult['telemetry']): number[] {
  const n = telemetryLen(t)
  const out = new Array<number>(n)
  if (isTelemetryRecords(t)) {
    for (let i = 0; i < n; i++) {
      const row = t[i]
      const v = row.altitude_smooth_m ?? row.altitude_m ?? 0
      out[i] = typeof v === 'number' && Number.isFinite(v) ? v : 0
    }
    return out
  }
  const sm = t.altitude_smooth_m
  const raw = t.altitude_m
  for (let i = 0; i < n; i++) {
    const a = sm?.[i] ?? raw?.[i]
    out[i] = typeof a === 'number' && Number.isFinite(a) ? a : 0
  }
  return out
}

export function orientationRadAt(
  t: RunResult['telemetry'],
  i: number,
  filtKey: keyof TelemetryPoint,
  rawKey: keyof TelemetryPoint,
): number {
  if (isTelemetryRecords(t)) {
    const row = t[i]
    const rad = (row[filtKey] ?? row[rawKey]) as number | null | undefined
    return typeof rad === 'number' && Number.isFinite(rad) ? rad : NaN
  }
  const fc = t[filtKey as string]
  const rc = t[rawKey as string]
  const fv = fc?.[i]
  const rv = rc?.[i]
  const rad = (typeof fv === 'number' && Number.isFinite(fv) ? fv : rv) as number | null | undefined
  return typeof rad === 'number' && Number.isFinite(rad) ? rad : NaN
}

export function hasFiniteNumericInColumn(t: RunResult['telemetry'], key: keyof TelemetryPoint): boolean {
  if (isTelemetryRecords(t)) {
    return t.some((row) => {
      const v = row[key]
      return typeof v === 'number' && Number.isFinite(v)
    })
  }
  const col = t[key as string]
  if (!col || !Array.isArray(col)) return false
  for (let i = 0; i < col.length; i++) {
    const v = col[i]
    if (typeof v === 'number' && Number.isFinite(v)) return true
  }
  return false
}
